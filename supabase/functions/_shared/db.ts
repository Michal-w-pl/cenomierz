import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { fetchListing } from './otomoto.ts';
import { matchOfficial, type VcaRow } from './wltp.ts';

export const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Użytkownik z nagłówka Authorization (token sesji z supabase-js) albo null. */
export async function userFrom(req: Request, db: SupabaseClient) {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data.user ?? null;
}

export async function vcaTable(db: SupabaseClient): Promise<VcaRow[]> {
  const { data, error } = await db.from('vca_rows').select('mfr, model, descr, ps, range, city, whkm').limit(10000);
  if (error) throw error;
  return (data ?? []) as VcaRow[];
}

// deno-lint-ignore no-explicit-any
type Ad = Record<string, any>;
const isEv = (specs: Ad | null) => specs?.fuel === 'Elektryczny' || !!specs?.ev;

/**
 * Pobiera ogłoszenie z Otomoto i zapisuje wynik. Nowy punkt historii tylko przy zmianie ceny.
 * `existing` = bieżący wiersz z tabeli ads (albo null dla nowego ogłoszenia — wtedy błąd/usunięte nie tworzy wpisu).
 */
export async function refreshAd(db: SupabaseClient, key: string, url: string, existing: Ad | null, vca: VcaRow[]) {
  const r = await fetchListing(url);
  const now = new Date().toISOString();
  if (!r.ok) {
    if (existing) await db.from('ads').update({ last_checked: now, last_error: r.error }).eq('key', key);
    return { ok: false as const, error: r.error };
  }
  if (r.status === 'REMOVED') {
    if (!existing) return { ok: false as const, error: 'Ogłoszenie nie istnieje lub zostało usunięte' };
    await db.from('ads').update({ status: 'REMOVED', removed_at: existing.removed_at ?? now, last_checked: now, last_error: null }).eq('key', key);
    return { ok: true as const, removed: true };
  }
  const specs = r.specs?.make ? r.specs : existing?.specs ?? r.specs;
  const row = {
    key, url,
    title: r.title ?? existing?.title, image: r.image ?? existing?.image,
    features: r.features.length ? r.features : existing?.features ?? [],
    location: r.location ?? existing?.location, currency: r.currency,
    specs, official: isEv(specs) ? matchOfficial(specs, vca) : null,
    status: r.status, removed_at: null, last_checked: now, last_error: null,
  };
  const { error } = await db.from('ads').upsert(row);
  if (error) return { ok: false as const, error: error.message };
  let changed = false;
  if (r.price != null) {
    const { data: last } = await db.from('price_points').select('price').eq('ad_key', key).order('t', { ascending: false }).limit(1).maybeSingle();
    if (!last || Number(last.price) !== r.price) {
      await db.from('price_points').insert({ ad_key: key, t: now, price: r.price });
      changed = !!last;
    }
  }
  return { ok: true as const, changed, title: row.title as string };
}
