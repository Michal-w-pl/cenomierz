// Minimalny service worker — pozwala zainstalować Cenomierza jako aplikację.
// Niczego nie zapisuje w pamięci podręcznej: zawsze ładowana jest aktualna wersja z sieci.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
