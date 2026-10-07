// Podgląd udostępnionego porównania (bez logowania): { id } → udostępnione ogłoszenia z historią cen,
// próbkami rynku i danymi WLTP. Nie zwraca nic o właścicielu poza datami dodania ogłoszeń i ręcznym WLTP.
import { admin, CORS, json } from '../_shared/db.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  if (typeof body.id !== 'string' || !/^[0-9a-f]{16}$/.test(body.id)) return json({ error: 'Nieprawidłowy link' }, 400);
  const db = admin();

  const { data: share } = await db.from('shares').select('user_id, ad_keys, created_at, expires_at').eq('id', body.id).maybeSingle();
  if (!share || Date.parse(share.expires_at) < Date.now()) return json({ error: 'Link wygasł albo został usunięty' }, 404);

  const [w, meta] = await Promise.all([
    db.from('watches').select('ad_key, added_at, wltp_manual, ads(*, price_points(t, price))')
      .eq('user_id', share.user_id).in('ad_key', share.ad_keys),
    db.from('app_meta').select('value').eq('key', 'vca').maybeSingle(),
  ]);
  if (w.error) return json({ error: w.error.message }, 500);
  // deno-lint-ignore no-explicit-any
  const urls = [...new Set((w.data ?? []).map((x: any) => x.ads?.market_url).filter(Boolean))];
  const { data: samples } = urls.length
    ? await db.from('market_samples').select('url, fetched_at, total, hits').in('url', urls)
    : { data: [] };
  return json({
    createdAt: share.created_at, expiresAt: share.expires_at, order: share.ad_keys,
    watches: w.data ?? [], samples: samples ?? [], vca: meta.data?.value ?? null,
  });
});
