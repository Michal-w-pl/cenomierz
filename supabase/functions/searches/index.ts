// Sprawdzanie zapisanych wyszukiwań Otomoto.
//  • Wywołanie z harmonogramu (pg_cron co 10 min, bez logowania): porcja wyszukiwań sprawdzanych dawniej niż 4 h.
//    Bezpieczne do powtarzania — gdy nie ma nic do zrobienia, kończy się od razu.
//  • Wywołanie z panelu ({ id } + token): od razu sprawdza jedno wyszukiwanie użytkownika (np. zaraz po dodaniu).
// Pierwsze sprawdzenie zapamiętuje obecne wyniki jako „bazowe”; kolejne zapisują tylko ogłoszenia, których nie było.
import { admin, CORS, json, sleep, userFrom } from '../_shared/db.ts';
import { fetchSearchPage, type SearchHit } from '../_shared/otomoto.ts';

const DUE_AFTER_MS = 4 * 3600_000;
const MANUAL_MIN_GAP_MS = 60_000;
const BATCH = 10;
const BUDGET_MS = 100_000;
const PAGE_SIZE = 32;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  const started = Date.now();
  const db = admin();
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));

  if (body.id) {
    const user = await userFrom(req, db);
    if (!user) return json({ error: 'Zaloguj się' }, 401);
    const { data: s, error } = await db.from('searches').select('*').eq('id', body.id).eq('user_id', user.id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!s) return json({ error: 'Nie znaleziono wyszukiwania' }, 404);
    if (s.last_checked && Date.now() - Date.parse(s.last_checked) < MANUAL_MIN_GAP_MS) {
      return json({ fresh: 0, total: s.total_count, skipped: true });
    }
    const r = await check(db, s);
    return r.ok ? json({ fresh: r.fresh, total: r.total, baseline: r.baseline }) : json({ error: r.error }, 502);
  }

  const { data: due, error } = await db.from('searches').select('*')
    .or(`last_checked.is.null,last_checked.lt.${new Date(Date.now() - DUE_AFTER_MS).toISOString()}`)
    .order('last_checked', { ascending: true, nullsFirst: true }).limit(BATCH);
  if (error) return json({ error: error.message }, 500);
  let processed = 0, fresh = 0, failed = 0;
  for (const s of due ?? []) {
    if (Date.now() - started > BUDGET_MS) break;
    if (processed) await sleep(1000);
    const r = await check(db, s);
    processed++;
    if (r.ok) fresh += r.fresh; else failed++;
  }
  return json({ processed, fresh, failed });
});

// deno-lint-ignore no-explicit-any
async function check(db: ReturnType<typeof admin>, s: Record<string, any>) {
  const baseline = !s.last_checked;
  const maxPages = baseline ? 5 : 3;  // przy pierwszym sprawdzeniu zapamiętujemy do 160 ogłoszeń
  const found = new Map<string, SearchHit>();
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(800);
    const r = await fetchSearchPage(s.url, page);
    if (!r.ok) {
      if (page === 1) {
        await db.from('searches').update({ last_checked: new Date().toISOString(), last_error: r.error }).eq('id', s.id);
        return { ok: false as const, error: r.error };
      }
      break;
    }
    total = r.total;
    const keys = r.hits.map((h) => h.key).filter((k) => !found.has(k));
    const { data: known } = keys.length
      ? await db.from('search_hits').select('ad_key').eq('search_id', s.id).in('ad_key', keys)
      : { data: [] };
    const knownSet = new Set((known ?? []).map((k) => k.ad_key));
    const fresh = r.hits.filter((h) => !knownSet.has(h.key));
    for (const h of fresh) found.set(h.key, h);
    // wyniki są od najnowszych: jeśli na stronie trafiliśmy na znane ogłoszenie, dalej są już tylko znane
    if (!baseline && fresh.length < r.hits.length) break;
    if (r.hits.length < PAGE_SIZE - 4 || page * PAGE_SIZE >= total) break;
  }
  const now = new Date().toISOString();
  const rows = [...found.values()].map((h) => ({
    search_id: s.id, ad_key: h.key, url: h.url, title: h.title, subtitle: h.subtitle, image: h.image,
    price: h.price, currency: h.currency, location: h.location, params: h.params, ad_created_at: h.createdAt,
    first_seen: now, baseline,
  }));
  if (rows.length) {
    const { error } = await db.from('search_hits').upsert(rows, { onConflict: 'search_id,ad_key', ignoreDuplicates: true });
    if (error) return { ok: false as const, error: error.message };
  }
  await db.from('searches').update({ last_checked: now, last_error: null, total_count: total }).eq('id', s.id);
  return { ok: true as const, fresh: baseline ? 0 : rows.length, total, baseline };
}
