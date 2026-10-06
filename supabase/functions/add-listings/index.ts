// Dodaje ogłoszenia do obserwowanych zalogowanego użytkownika (pojedynczy link albo import listy).
// Nowe ogłoszenie jest od razu pobierane z Otomoto; już znane — tylko, gdy dane mają ponad 6 h.
import { admin, CORS, json, refreshAd, sleep, userFrom, vcaTable } from '../_shared/db.ts';
import { normalizeUrl } from '../_shared/otomoto.ts';

const MAX_PER_CALL = 20;      // panel dzieli większy import na porcje
const FRESH_MS = 6 * 3600_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  const db = admin();
  const user = await userFrom(req, db);
  if (!user) return json({ error: 'Zaloguj się, aby dodawać ogłoszenia' }, 401);

  let urls: unknown[];
  try { ({ urls } = await req.json()); } catch { return json({ error: 'Nieprawidłowe dane' }, 400); }
  if (!Array.isArray(urls) || !urls.length) return json({ error: 'Brak linków' }, 400);
  if (urls.length > MAX_PER_CALL) return json({ error: `Maksymalnie ${MAX_PER_CALL} linków naraz` }, 400);

  const result = { added: [] as { key: string; title: string }[], skipped: [] as string[], failed: [] as { url: string; error: string }[] };
  let vca: Awaited<ReturnType<typeof vcaTable>> | null = null;
  const seen = new Set<string>();
  let fetched = 0;

  for (const input of urls) {
    const n = normalizeUrl(input);
    if (!n) { result.failed.push({ url: String(input), error: 'To nie jest link do ogłoszenia Otomoto' }); continue; }
    if (seen.has(n.key)) continue;
    seen.add(n.key);

    const { data: watched } = await db.from('watches').select('ad_key').eq('user_id', user.id).eq('ad_key', n.key).maybeSingle();
    if (watched) { result.skipped.push(n.url); continue; }

    const { data: existing } = await db.from('ads').select('*').eq('key', n.key).maybeSingle();
    let title = existing?.title as string | undefined;
    if (!existing || !existing.last_checked || Date.now() - Date.parse(existing.last_checked) > FRESH_MS) {
      if (fetched++) await sleep(700);
      vca ??= await vcaTable(db);
      const r = await refreshAd(db, n.key, n.url, existing, vca);
      if (!r.ok && !existing) { result.failed.push({ url: n.url, error: r.error }); continue; }
      if (r.ok && 'title' in r) title = r.title;
    }
    const { error } = await db.from('watches').insert({ user_id: user.id, ad_key: n.key });
    if (error) result.failed.push({ url: n.url, error: error.message });
    else result.added.push({ key: n.key, title: title ?? n.url });
  }
  return json(result);
});
