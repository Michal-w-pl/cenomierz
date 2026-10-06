#!/usr/bin/env node
// Lokalny panel: http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addListing, addMany, checkAll, isChecking, load, removeListings, restoreListings, setWltp } from './src/store.js';
import { matchOfficial, updateVca, vcaInfo, vcaStale } from './src/wltp.js';

// Dołącza oficjalne WLTP (VCA) do elektryków. Liczone przy każdym odczycie — tabela jest w pamięci.
const withOfficial = (e) => (e.specs?.fuel === 'Elektryczny' || e.specs?.ev ? { ...e, official: matchOfficial(e.specs) } : e);
let vcaUpdating = false;
const refreshVca = () => {
  if (vcaUpdating) return;
  vcaUpdating = true;
  log('Pobieram oficjalne dane WLTP (VCA)…');
  updateVca().then((n) => log(`WLTP: zapisano ${n} wersji aut elektrycznych`))
    .catch((e) => log(`WLTP: nie udało się pobrać danych — ${e.message}`))
    .finally(() => { vcaUpdating = false; });
};

const PORT = Number(process.env.PORT) || 3000;
const CHECK_EVERY_H = Number(process.env.CHECK_EVERY_H) || 6; // automatyczne sprawdzanie, gdy serwer działa
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html');

let importing = 0;
const log = (m) => console.log(new Date().toLocaleTimeString('pl-PL'), m);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// Wymóg Content-Type: application/json blokuje „ciche” POST-y z obcych stron (CSRF) — taki nagłówek
// wymusza zapytanie CORS preflight, na które serwer nie odpowiada zgodą.
const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (!req.headers['content-type']?.startsWith('application/json')) return reject(new Error('Wymagany Content-Type: application/json'));
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/listings') {
      return json(res, 200, { listings: Object.values(load().listings).map(withOfficial), checking: isChecking(), importing, vca: { ...vcaInfo(), updating: vcaUpdating } });
    }

    if (req.method === 'POST' && url.pathname === '/api/listings') {
      const { url: link } = await readBody(req);
      const { entry, existed } = await addListing(link);
      return json(res, existed ? 200 : 201, { entry, existed });
    }

    const del = url.pathname.match(/^\/api\/listings\/([A-Za-z0-9]+)$/);
    if (req.method === 'DELETE' && del) {
      const removed = removeListings([del[1]]);
      return json(res, removed.length ? 200 : 404, { removed });
    }

    if (req.method === 'PATCH' && del) {
      const { wltpRange } = await readBody(req);
      const entry = setWltp(del[1], wltpRange);
      return json(res, entry ? 200 : 404, { entry });
    }

    // Usuwanie wielu naraz; odpowiedź zawiera usunięte wpisy, żeby panel mógł je przywrócić („Cofnij”).
    if (req.method === 'POST' && url.pathname === '/api/listings/delete') {
      const { keys } = await readBody(req);
      if (!Array.isArray(keys)) throw new Error('Brak listy kluczy');
      return json(res, 200, { removed: removeListings(keys) });
    }

    if (req.method === 'POST' && url.pathname === '/api/listings/restore') {
      const { entries } = await readBody(req);
      if (!Array.isArray(entries)) throw new Error('Brak wpisów do przywrócenia');
      return json(res, 200, { restored: restoreListings(entries) });
    }

    if (req.method === 'POST' && url.pathname === '/api/wltp/update') {
      await readBody(req);
      refreshVca();
      return json(res, 202, { updating: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/check') {
      checkAll(log).catch((e) => log(`Błąd sprawdzania: ${e.message}`));
      return json(res, 202, { checking: true });
    }

    // Import z bookmarkletu uruchomionego na stronie "Obserwowane" w Otomoto.
    // Bookmarklet otwiera ten adres z listą linków w parametrach ?u=...&u=...
    if (req.method === 'GET' && url.pathname === '/import') {
      const links = url.searchParams.getAll('u');
      if (links.length) {
        importing++;
        log(`Import ${links.length} linków z Otomoto…`);
        addMany(links, log)
          .then((r) => log(`Import: dodano ${r.added.length}, pominięto ${r.skipped.length}, błędy ${r.failed.length}`))
          .finally(() => importing--);
      }
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    json(res, 404, { error: 'Nie znaleziono' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Panel: http://localhost:${PORT}  (auto-sprawdzanie co ${CHECK_EVERY_H} h)`);
  setInterval(() => checkAll(log).catch((e) => log(e.message)), CHECK_EVERY_H * 3600_000);
  if (vcaStale()) refreshVca(); // dane VCA odświeżane co 30 dni
  setInterval(() => vcaStale() && refreshVca(), 24 * 3600_000);
});
