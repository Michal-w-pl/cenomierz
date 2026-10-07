// Próbki rynku do porównania cen (pg_cron co godzinę, bez logowania).
// Dla obserwowanych ogłoszeń pobiera z Otomoto do 64 najnowszych podobnych ofert (ta sama marka, model i paliwo,
// rocznik ±1) — jedna próbka na adres wyszukiwania, odświeżana co 3 dni. Ogłoszenia zapisane przed dodaniem
// tej funkcji (bez identyfikatorów marki/modelu w specs) są najpierw ponownie pobierane.
// Wywołanie jest bezpieczne do powtarzania: gdy wszystko jest aktualne, kończy się od razu.
import { admin, json, refreshAd, sleep, vcaTable } from '../_shared/db.ts';
import { fetchSearchPage, marketUrl } from '../_shared/otomoto.ts';

const MAX_AGE_MS = 3 * 864e5;
const PAGES = 2;
const BACKFILL_PER_RUN = 15;
const BUDGET_MS = 100_000;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  const started = Date.now();
  const db = admin();

  const { data: watched, error } = await db.from('watches').select('ads(key, url, specs, market_url, status)');
  if (error) return json({ error: error.message }, 500);
  // deno-lint-ignore no-explicit-any
  const ads = new Map<string, Record<string, any>>();
  for (const w of watched ?? []) {
    // deno-lint-ignore no-explicit-any
    const a = w.ads as any;
    if (a && a.status !== 'REMOVED') ads.set(a.key, a);
  }

  // 1. uzupełnienie identyfikatorów marki/modelu w starszych ogłoszeniach
  let backfilled = 0;
  const vca = await vcaTable(db);
  for (const a of ads.values()) {
    if (a.specs?.slugs || !a.specs?.make || backfilled >= BACKFILL_PER_RUN || Date.now() - started > BUDGET_MS / 2) continue;
    if (backfilled++) await sleep(800);
    const { data: existing } = await db.from('ads').select('*').eq('key', a.key).maybeSingle();
    await refreshAd(db, a.key, a.url, existing, vca);
    const { data: fresh } = await db.from('ads').select('market_url').eq('key', a.key).maybeSingle();
    a.market_url = fresh?.market_url ?? null;
  }
  // ogłoszenia, które mają identyfikatory, ale jeszcze nie mają zapisanego adresu próbki
  for (const a of ads.values()) {
    const u = marketUrl(a.specs);
    if (u && u !== a.market_url) { await db.from('ads').update({ market_url: u }).eq('key', a.key); a.market_url = u; }
  }

  // 2. próbki starsze niż 3 dni (albo brakujące)
  const urls = [...new Set([...ads.values()].map((a) => a.market_url).filter(Boolean))] as string[];
  const { data: samples } = urls.length ? await db.from('market_samples').select('url, fetched_at').in('url', urls) : { data: [] };
  const age = new Map((samples ?? []).map((s) => [s.url, Date.parse(s.fetched_at)]));
  const due = urls.filter((u) => !age.has(u) || Date.now() - age.get(u)! > MAX_AGE_MS)
    .sort((a, b) => (age.get(a) ?? 0) - (age.get(b) ?? 0));

  let fetched = 0, failed = 0;
  for (const url of due) {
    if (Date.now() - started > BUDGET_MS) break;
    // deno-lint-ignore no-explicit-any
    const hits: any[] = [];
    let total = 0, ok = true;
    for (let page = 1; page <= PAGES; page++) {
      await sleep(800);
      const r = await fetchSearchPage(url, page);
      if (!r.ok) { ok = page > 1; break; }
      total = r.total;
      for (const h of r.hits) {
        if (h.price == null || hits.some((x) => x.k === h.key)) continue;
        hits.push({ k: h.key, u: h.url, t: h.title, p: h.price, c: h.currency, y: h.params.year, m: h.params.mileage, pw: h.params.power });
      }
      if (page * 32 >= total) break;
    }
    if (!ok) { failed++; continue; }
    const { error: e2 } = await db.from('market_samples').upsert({ url, fetched_at: new Date().toISOString(), total, hits });
    if (e2) failed++; else fetched++;
  }
  return json({ ads: ads.size, backfilled, samples: urls.length, fetched, failed, remaining: due.length - fetched - failed });
});
