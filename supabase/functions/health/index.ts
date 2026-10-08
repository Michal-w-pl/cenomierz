// Kontrola działania (pg_cron co godzinę): sprawdza health_check() i powiadamia administratora
// (sekret HEALTH_EMAIL) mailem przez Brevo i push na telefon — tylko gdy pojawi się nowy problem,
// raz na dobę, dopóki problem trwa, i jednorazowo po naprawie. Powtórne wywołania nic nie wysyłają.
import { admin, json } from '../_shared/db.ts';
import { pushToUser } from '../_shared/push.ts';

const SITE = 'https://michal-w-pl.github.io/cenomierz/';
const REMIND_MS = 24 * 3600 * 1000;

type Problem = { code: string; title: string; detail: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  const db = admin();

  const { data, error } = await db.rpc('health_check');
  if (error) return json({ error: error.message }, 500);
  const problems = (data ?? []) as Problem[];
  const codes = problems.map((p) => p.code).sort();

  // { dryRun: true } — tylko podgląd problemów (z kluczem service role)
  const isAdmin = req.headers.get('Authorization') === `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
  if (body.dryRun) return isAdmin ? json({ problems }) : json({ error: 'Brak uprawnień' }, 403);

  const { data: st, error: e1 } = await db.from('health_state').select('codes, notified_at').eq('id', 1).single();
  if (e1) return json({ error: e1.message }, 500);
  const prev: string[] = st.codes ?? [];
  const appeared = codes.filter((c) => !prev.includes(c));
  const recovered = prev.length > 0 && codes.length === 0;
  const remind = codes.length > 0 && (!st.notified_at || Date.now() - Date.parse(st.notified_at) > REMIND_MS);
  const notify = appeared.length > 0 || recovered || remind;

  let sent = { mail: false, push: 0 };
  if (notify) sent = await send(db, problems, recovered);
  const { error: e2 } = await db.from('health_state').update({
    codes,
    notified_at: notify && !recovered ? new Date().toISOString() : codes.length ? st.notified_at : null,
  }).eq('id', 1);
  if (e2) return json({ error: e2.message }, 500);
  return json({ problems: codes, notified: notify, ...sent });
});

// deno-lint-ignore no-explicit-any
async function send(db: any, problems: Problem[], recovered: boolean) {
  const to = Deno.env.get('HEALTH_EMAIL');
  if (!to) return { mail: false, push: 0 };
  const subject = recovered
    ? 'Cenomierz: wszystko znów działa'
    : `Cenomierz: problem — ${problems.map((p) => p.title).join('; ')}`.slice(0, 180);
  const lines = recovered
    ? ['Wcześniej zgłoszone problemy ustąpiły — odświeżanie i zadania działają poprawnie.']
    : problems.map((p) => `• ${p.title}${p.detail ? `\n  ${p.detail}` : ''}`);

  let mail = false;
  const apiKey = Deno.env.get('BREVO_API_KEY'), from = Deno.env.get('ALERT_FROM');
  if (apiKey && from) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Cenomierz', email: from },
        to: [{ email: to }],
        subject,
        textContent: [...lines, '', `Panel: ${SITE}`, 'Szczegóły: Supabase → Edge Functions → Logs, Integrations → Cron.'].join('\n'),
      }),
    });
    mail = res.ok;
    if (!res.ok) console.error('Brevo', res.status, await res.text());
  }

  let push = 0;
  const { data: userId } = await db.rpc('user_id_by_email', { addr: to });
  if (userId) {
    push = await pushToUser(db, userId, {
      title: recovered ? 'Cenomierz działa' : 'Cenomierz: problem',
      body: recovered ? 'Wcześniejsze problemy ustąpiły.' : problems.map((p) => p.title).join('\n'),
      url: SITE, tag: 'health',
    });
  }
  return { mail, push };
}
