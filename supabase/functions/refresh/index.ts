// Odświeżanie cen.
//  • Wywołanie z harmonogramu (pg_cron co 10 min, bez logowania): porcja ogłoszeń sprawdzanych dawniej niż 20 h,
//    a raz na 30 dni — pobranie oficjalnych danych WLTP z VCA. Wywołanie jest bezpieczne do powtarzania:
//    gdy nie ma nic do zrobienia, kończy się od razu.
//  • Wywołanie z panelu ({ mine: true } + token): ogłoszenia użytkownika sprawdzane dawniej niż 1 h, porcjami.
import { admin, CORS, json, refreshAd, sleep, userFrom, vcaTable } from '../_shared/db.ts';
import { downloadVca, matchOfficial } from '../_shared/wltp.ts';
import { notifyAdChange } from '../_shared/push.ts';

const BATCH = 25;
const BUDGET_MS = 110_000;
const VCA_MAX_AGE_MS = 30 * 864e5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  const started = Date.now();
  const db = admin();
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));

  if (body.mine) {
    const user = await userFrom(req, db);
    if (!user) return json({ error: 'Zaloguj się' }, 401);
    const { data, error } = await db.from('watches').select('ads(*)').eq('user_id', user.id);
    if (error) return json({ error: error.message }, 500);
    const hourAgo = Date.now() - 3600_000;
    const due = (data ?? []).map((w) => w.ads as unknown as Record<string, any>)
      .filter((a) => a && (!a.last_checked || Date.parse(a.last_checked) < hourAgo))
      .filter((a) => !(a.status === 'REMOVED' && a.removed_at && Date.now() - Date.parse(a.removed_at) > 7 * 864e5))
      .sort((a, b) => String(a.last_checked ?? '').localeCompare(String(b.last_checked ?? '')));
    const r = await run(db, due.slice(0, BATCH), started);
    return json({ ...r, remaining: Math.max(0, due.length - r.processed) });
  }

  // --- harmonogram: najpierw dane WLTP, jeśli przeterminowane
  const { data: meta } = await db.from('app_meta').select('value').eq('key', 'vca').maybeSingle();
  if (!meta || Date.now() - Date.parse(meta.value.fetchedAt) > VCA_MAX_AGE_MS) {
    try {
      const rows = await downloadVca();
      await db.from('vca_rows').delete().gte('id', 0);
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('vca_rows').insert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      await db.from('app_meta').upsert({ key: 'vca', value: { fetchedAt: new Date().toISOString(), rows: rows.length, source: 'VCA (UK) — Euro 6 latest' } });
      // przeliczenie dopasowań dla elektryków
      const { data: evs } = await db.from('ads').select('key, specs').not('specs', 'is', null);
      for (const a of evs ?? []) {
        if (a.specs?.fuel !== 'Elektryczny' && !a.specs?.ev) continue;
        await db.from('ads').update({ official: matchOfficial(a.specs, rows) }).eq('key', a.key);
      }
      return json({ vca: rows.length });
    } catch (e) {
      console.error('VCA', e);
      // nie blokujemy odświeżania cen; spróbujemy przy kolejnym wywołaniu
    }
  }

  const { data: due, error } = await db.rpc('ads_due', { max_rows: BATCH });
  if (error) return json({ error: error.message }, 500);
  return json(await run(db, due ?? [], started));
});

// deno-lint-ignore no-explicit-any
async function run(db: ReturnType<typeof admin>, ads: Record<string, any>[], started: number) {
  let processed = 0, changed = 0, failed = 0;
  if (!ads.length) return { processed, changed, failed };
  const vca = await vcaTable(db);
  for (const a of ads) {
    if (Date.now() - started > BUDGET_MS) break;
    if (processed) await sleep(800);
    const r = await refreshAd(db, a.key, a.url, a, vca);
    await notifyAdChange(db, a.key, a.url, r);   // push: obniżka / zniknięcie
    processed++;
    if (!r.ok) failed++;
    else if ('changed' in r && r.changed) changed++;
  }
  return { processed, changed, failed };
}
