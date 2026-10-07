// Zarządzanie powiadomieniami push zalogowanego użytkownika (wywołania z panelu):
//  { action: 'subscribe', subscription } — zapisuje urządzenie (PushSubscription.toJSON()) i wysyła powiadomienie testowe,
//  { action: 'unsubscribe', endpoint }   — usuwa urządzenie,
//  { action: 'test' }                     — powiadomienie testowe na wszystkie urządzenia użytkownika.
import { admin, CORS, json, userFrom } from '../_shared/db.ts';
import { pushToUser } from '../_shared/push.ts';

const TEST = { title: 'Cenomierz', body: 'Powiadomienia działają — dam znać o obniżkach, zniknięciach i nowych ogłoszeniach.', tag: 'test' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  const db = admin();
  const user = await userFrom(req, db);
  if (!user) return json({ error: 'Zaloguj się' }, 401);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));

  if (body.action === 'subscribe') {
    const s = body.subscription;
    const ok = typeof s?.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
      && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
    if (!ok) return json({ error: 'Nieprawidłowa subskrypcja' }, 400);
    const { error } = await db.from('push_subscriptions').upsert({
      endpoint: s.endpoint, user_id: user.id, p256dh: s.keys.p256dh, auth: s.keys.auth,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 200),
    });
    if (error) return json({ error: error.message }, 500);
    return json({ sent: await pushToUser(db, user.id, TEST, { ignoreQuiet: true }) });
  }
  if (body.action === 'unsubscribe') {
    await db.from('push_subscriptions').delete().eq('endpoint', String(body.endpoint ?? '')).eq('user_id', user.id);
    return json({ ok: true });
  }
  if (body.action === 'test') return json({ sent: await pushToUser(db, user.id, TEST, { ignoreQuiet: true }) });
  return json({ error: 'Nieznana akcja' }, 400);
});
