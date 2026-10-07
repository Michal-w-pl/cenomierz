// Wysyłka powiadomień push (Web Push, VAPID) do urządzeń użytkowników.
// Sekrety: VAPID_KEYS_B64 (klucze JWK zakodowane base64), VAPID_SUBJECT (mailto: kontakt dla usług push).
import * as webpush from 'jsr:@negrel/webpush@0.5.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

let server: Promise<webpush.ApplicationServer> | null = null;
function appServer() {
  server ??= (async () => {
    const jwks = JSON.parse(atob(Deno.env.get('VAPID_KEYS_B64') ?? ''));
    const vapidKeys = await webpush.importVapidKeys(jwks, { extractable: false });
    return webpush.ApplicationServer.new({ contactInformation: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com', vapidKeys });
  })();
  return server;
}

/** Cisza nocna 22:00–7:00 czasu polskiego — wtedy zmiany trafią tylko do porannego maila. */
export function quietHours(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Warsaw' }).format(now));
  return h >= 22 || h < 7;
}

/** Wysyła powiadomienie na wszystkie urządzenia użytkownika; usuwa wygasłe subskrypcje. Zwraca liczbę wysłanych. */
export async function pushToUser(db: SupabaseClient, userId: string, payload: PushPayload, { ignoreQuiet = false } = {}) {
  if (!ignoreQuiet && quietHours()) return 0;
  if (!Deno.env.get('VAPID_KEYS_B64')) return 0;
  const { data: subs } = await db.from('push_subscriptions').select('endpoint, p256dh, auth').eq('user_id', userId);
  if (!subs?.length) return 0;
  const as = await appServer();
  let sent = 0;
  for (const s of subs) {
    try {
      await as.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
        .pushTextMessage(JSON.stringify(payload), { ttl: 6 * 3600, urgency: webpush.Urgency.Normal, topic: payload.tag });
      sent++;
      await db.from('push_subscriptions').update({ last_used: new Date().toISOString() }).eq('endpoint', s.endpoint);
    } catch (e) {
      const status = (e as webpush.PushMessageError)?.response?.status;
      if (status === 404 || status === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      else console.error('push', status ?? e);
    }
  }
  return sent;
}

export const money = (n: number | null | undefined, cur = 'PLN') =>
  n == null ? '—' : `${Math.round(n).toLocaleString('pl-PL').replace(/\s/g, ' ')} ${cur === 'PLN' ? 'zł' : cur}`;

const SITE = 'https://michal-w-pl.github.io/cenomierz/';

/**
 * Push po odświeżeniu ogłoszenia: obniżka ceny (obserwującym bez progu albo gdy cena spadła do progu)
 * lub zniknięcie ogłoszenia z Otomoto (wszystkim obserwującym).
 */
export async function notifyAdChange(
  db: SupabaseClient, key: string, url: string,
  // deno-lint-ignore no-explicit-any
  r: Record<string, any>,
) {
  if (!r.ok || quietHours()) return;
  const drop = r.changed && r.oldPrice != null && r.newPrice != null && r.newPrice < r.oldPrice;
  if (!drop && !r.newlyRemoved) return;
  const { data: watchers } = await db.from('watches').select('user_id, target_price').eq('ad_key', key);
  for (const w of watchers ?? []) {
    if (r.newlyRemoved) {
      await pushToUser(db, w.user_id, { title: 'Ogłoszenie zniknęło z Otomoto', body: `${r.title ?? 'Obserwowane ogłoszenie'} — prawdopodobnie sprzedane.`, url: SITE, tag: `gone-${key}` });
      continue;
    }
    if (w.target_price != null && r.newPrice > Number(w.target_price)) continue;
    const pct = ((r.newPrice - r.oldPrice) / r.oldPrice * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 });
    await pushToUser(db, w.user_id, {
      title: w.target_price != null ? `Cena spadła do Twojego progu` : `Taniej o ${money(r.oldPrice - r.newPrice, r.currency)}`,
      body: `${r.title ?? 'Ogłoszenie'}: ${money(r.oldPrice, r.currency)} → ${money(r.newPrice, r.currency)} (${pct}%)`,
      url, tag: `drop-${key}`,
    });
  }
}
