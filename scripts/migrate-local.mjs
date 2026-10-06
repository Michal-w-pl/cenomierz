// Przenosi dane z wersji lokalnej (data/listings.json) na konto w wersji online.
// Użycie:  SUPABASE_SERVICE_ROLE_KEY=… node scripts/migrate-local.mjs <email-konta>
// Wymaga: npm i @supabase/supabase-js (jednorazowo) i istniejącego konta (założonego na stronie).
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { matchOfficial } from '../src/wltp.js';

const SB_URL = 'https://kkduvothshtywldnuspe.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.argv[2]?.toLowerCase();
if (!KEY || !email) { console.error('Użycie: SUPABASE_SERVICE_ROLE_KEY=… node scripts/migrate-local.mjs <email>'); process.exit(1); }

const db = createClient(SB_URL, KEY, { auth: { persistSession: false } });
let user = null;
for (let page = 1; !user; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw error;
  user = data.users.find((u) => u.email?.toLowerCase() === email);
  if (data.users.length < 200) break;
}
if (!user) { console.error(`Nie ma konta ${email} — załóż je najpierw na stronie.`); process.exit(1); }

const listings = Object.values(JSON.parse(fs.readFileSync(new URL('../data/listings.json', import.meta.url), 'utf8')).listings);
const isEv = (s) => s?.fuel === 'Elektryczny' || !!s?.ev;

const ads = listings.map((e) => ({
  key: e.key, url: e.url, title: e.title, image: e.image, features: e.features ?? [], location: e.location ?? null,
  currency: e.currency ?? 'PLN', specs: e.specs ?? null, official: isEv(e.specs) ? matchOfficial(e.specs) : null,
  status: e.status ?? null, removed_at: e.removedAt ?? null, last_checked: e.lastChecked ?? null, last_error: e.lastError ?? null,
}));
const prices = listings.flatMap((e) => e.history.map((p) => ({ ad_key: e.key, t: p.t, price: p.price })));
const watches = listings.map((e) => ({ user_id: user.id, ad_key: e.key, added_at: e.addedAt, wltp_manual: e.wltpManual ?? null }));

const up = async (table, rows, onConflict) => {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 200), { onConflict, ignoreDuplicates: table !== 'ads' });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
};
await up('ads', ads, 'key');
await up('price_points', prices, 'ad_key,t');
await up('watches', watches, 'user_id,ad_key');
console.log(`Przeniesiono na konto ${email}: ${ads.length} ogłoszeń, ${prices.length} punktów historii cen.`);
