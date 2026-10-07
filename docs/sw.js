// Service worker — pozwala zainstalować Cenomierza jako aplikację i odbiera powiadomienia push.
// Niczego nie zapisuje w pamięci podręcznej: zawsze ładowana jest aktualna wersja z sieci.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Powiadomienie z serwera: { title, body, url, tag }
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Cenomierz', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag,
    data: { url: d.url || './' },
  }));
});

// Kliknięcie: ogłoszenie Otomoto otwiera się w nowym oknie, panel — w istniejącym oknie aplikacji, jeśli jest.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    if (url.startsWith(self.registration.scope)) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const w = wins.find((c) => c.url.startsWith(self.registration.scope));
      if (w) { await w.focus(); return w.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
