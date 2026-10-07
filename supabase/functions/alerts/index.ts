// Powiadomienia e-mail o obniżkach cen (pg_cron raz dziennie).
// Każdy użytkownik dostaje jeden zbiorczy mail z obserwowanymi ogłoszeniami, które potaniały od poprzedniego
// powiadomienia. Wywołanie jest bezpieczne do powtarzania: zgłoszone obniżki nie są wysyłane drugi raz.
// Wysyłka przez API Brevo (sekrety: BREVO_API_KEY, ALERT_FROM = zweryfikowany adres nadawcy w Brevo).
import { admin, json } from '../_shared/db.ts';

const SITE = 'https://michal-w-pl.github.io/cenomierz/';

type Drop = {
  user_id: string; email: string; ad_key: string; title: string | null; url: string; image: string | null;
  currency: string; old_price: number; new_price: number; changed_at: string;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  const db = admin();
  const until = new Date().toISOString();

  const { data, error } = await db.rpc('pending_drop_alerts', { until });
  if (error) return json({ error: error.message }, 500);
  const byUser = new Map<string, Drop[]>();
  for (const d of (data ?? []) as Drop[]) byUser.set(d.user_id, [...(byUser.get(d.user_id) ?? []), d]);

  // { dryRun: true } — podgląd bez wysyłki i bez oznaczania jako wysłane (tylko z kluczem service role)
  const isAdmin = req.headers.get('Authorization') === `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
  if (body.dryRun && !isAdmin) return json({ error: 'Brak uprawnień' }, 403);
  if (body.dryRun) return json({ users: byUser.size, drops: [...byUser.values()].map((ds) => ds.map((d) => `${d.title}: ${d.old_price} → ${d.new_price}`)) });

  const apiKey = Deno.env.get('BREVO_API_KEY'), from = Deno.env.get('ALERT_FROM');
  if (!apiKey || !from) return json({ error: 'Brak sekretów BREVO_API_KEY / ALERT_FROM' }, 500);
  const failed: string[] = [];
  for (const [userId, drops] of byUser) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Cenomierz', email: from },
        to: [{ email: drops[0].email }],
        subject: subject(drops),
        htmlContent: html(drops),
        textContent: text(drops),
      }),
    });
    if (!res.ok) {
      console.error('Brevo', res.status, await res.text());
      failed.push(userId);
    }
  }
  const { error: e2 } = await db.rpc('alerts_mark', { until, skip: failed });
  if (e2) return json({ error: e2.message }, 500);
  return json({ users: byUser.size, sent: byUser.size - failed.length, failed: failed.length });
});

const fmt = (n: number) => Math.round(n).toLocaleString('pl-PL').replace(/ /g, ' ');
const money = (n: number, cur: string) => `${fmt(n)} ${cur === 'PLN' ? 'zł' : cur}`;
const pct = (d: Drop) => ((d.new_price - d.old_price) / d.old_price * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

function subject(ds: Drop[]) {
  const d = ds[0];
  if (ds.length === 1) return `${d.title ?? 'Ogłoszenie'} — taniej o ${money(d.old_price - d.new_price, d.currency)}`;
  return `${ds.length} ${plural(ds.length, 'ogłoszenie potaniało', 'ogłoszenia potaniały', 'ogłoszeń potaniało')} — m.in. ${d.title ?? ''}`;
}

function text(ds: Drop[]) {
  return ['Obserwowane ogłoszenia, które potaniały:', '',
    ...ds.map((d) => `• ${d.title ?? d.ad_key}: ${money(d.old_price, d.currency)} → ${money(d.new_price, d.currency)} (${pct(d)}%)\n  ${d.url}`),
    '', `Panel: ${SITE}`, 'Powiadomienia wyłączysz w panelu: menu konta → Powiadomienia e-mail.'].join('\n');
}

function html(ds: Drop[]) {
  const rows = ds.map((d) => `
    <tr>
      <td style="padding:12px 0;border-top:1px solid #e7e5e4;width:96px;vertical-align:top">
        ${d.image ? `<a href="${esc(d.url)}"><img src="${esc(d.image)}" width="84" height="63" alt="" style="display:block;border-radius:8px;object-fit:cover"></a>` : ''}
      </td>
      <td style="padding:12px 0;border-top:1px solid #e7e5e4;vertical-align:top">
        <a href="${esc(d.url)}" style="color:#1c1917;font-weight:600;text-decoration:none">${esc(d.title ?? d.ad_key)}</a><br>
        <span style="color:#78716c;text-decoration:line-through">${money(d.old_price, d.currency)}</span>
        &nbsp;→&nbsp;<b style="color:#15803d">${money(d.new_price, d.currency)}</b>
        <span style="color:#15803d">&nbsp;▼ ${money(d.old_price - d.new_price, d.currency)} (${pct(d)}%)</span>
      </td>
    </tr>`).join('');
  return `<!doctype html><html lang="pl"><body style="margin:0;background:#f5f5f4;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;padding:22px 24px">
      <tr><td colspan="2" style="font-size:20px;font-weight:700;padding-bottom:4px">Cenomierz</td></tr>
      <tr><td colspan="2" style="color:#57534e;padding-bottom:12px">${ds.length === 1 ? 'Obserwowane ogłoszenie potaniało:' : `${ds.length} ${plural(ds.length, 'obserwowane ogłoszenie potaniało', 'obserwowane ogłoszenia potaniały', 'obserwowanych ogłoszeń potaniało')}:`}</td></tr>
      ${rows}
      <tr><td colspan="2" style="padding-top:18px;border-top:1px solid #e7e5e4">
        <a href="${SITE}" style="display:inline-block;background:#1c1917;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:10px">Otwórz panel</a>
      </td></tr>
      <tr><td colspan="2" style="padding-top:16px;font-size:12px;color:#a8a29e">Powiadomienia wyłączysz w panelu: menu konta → Powiadomienia e-mail.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}
