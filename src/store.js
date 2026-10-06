// Prosty magazyn w pliku JSON: data/listings.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchListing, normalizeUrl } from './scraper.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'listings.json');
const DELAY_MS = 1500; // odstęp między zapytaniami, żeby nie obciążać serwisu

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { listings: {} };
    throw e;
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** Nanosi wynik pobrania na wpis. Historia zapisuje punkt tylko przy zmianie ceny. */
function apply(entry, r, now) {
  entry.lastChecked = now;
  if (!r.ok) {
    entry.lastError = r.error;
    return { changed: false };
  }
  delete entry.lastError;
  const prevStatus = entry.status;
  entry.status = r.status;
  if (r.status === 'REMOVED') {
    if (prevStatus !== 'REMOVED') entry.removedAt = now;
    return { changed: false, statusChanged: prevStatus !== 'REMOVED' };
  }
  Object.assign(entry, {
    title: r.title ?? entry.title,
    image: r.image ?? entry.image,
    features: r.features?.length ? r.features : entry.features,
    location: r.location ?? entry.location,
    specs: r.specs?.make ? r.specs : entry.specs,
    currency: r.currency,
  });
  const last = entry.history.at(-1);
  if (r.price != null && (!last || last.price !== r.price)) {
    entry.history.push({ t: now, price: r.price });
    return { changed: !!last, from: last?.price, to: r.price, statusChanged: prevStatus !== r.status };
  }
  return { changed: false, statusChanged: prevStatus !== r.status };
}

export async function addListing(input) {
  const n = normalizeUrl(input);
  if (!n) throw new Error(`To nie wygląda na link do ogłoszenia Otomoto: ${input}`);
  const db = load();
  if (db.listings[n.key]) return { entry: db.listings[n.key], existed: true };

  const r = await fetchListing(n.url);
  if (!r.ok) throw new Error(`Nie udało się pobrać ogłoszenia: ${r.error}`);
  if (r.status === 'REMOVED') throw new Error('Ogłoszenie nie istnieje lub zostało usunięte');
  const now = new Date().toISOString();
  const entry = { key: n.key, url: n.url, addedAt: now, history: [] };
  apply(entry, r, now);
  db.listings[n.key] = entry;
  save(db);
  return { entry, existed: false };
}

/** Dodaje wiele linków (np. z importu obserwowanych), pomijając duplikaty i błędne. */
export async function addMany(inputs, log = () => {}) {
  const result = { added: [], skipped: [], failed: [] };
  const seen = new Set();
  for (const input of inputs) {
    const n = normalizeUrl(input);
    if (!n || seen.has(n.key)) continue;
    seen.add(n.key);
    if (load().listings[n.key]) {
      result.skipped.push(n.url);
      continue;
    }
    try {
      const { entry } = await addListing(n.url);
      result.added.push(entry);
      log(`+ ${entry.title} — ${entry.history.at(-1)?.price ?? '?'} ${entry.currency ?? ''}`);
    } catch (e) {
      result.failed.push({ url: n.url, error: e.message });
      log(`! ${n.url}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
  return result;
}

/** Usuwa ogłoszenia; zwraca usunięte wpisy (żeby dało się je przywrócić). */
export function removeListings(keys) {
  const db = load();
  const removed = keys.map((k) => db.listings[k]).filter(Boolean);
  for (const e of removed) delete db.listings[e.key];
  if (removed.length) save(db);
  return removed;
}

export const removeListing = (key) => removeListings([key]).length > 0;

/** Ręcznie wpisany oficjalny zasięg WLTP (km); null usuwa. Sprawdzanie cen tego pola nie nadpisuje. */
export function setWltp(key, value) {
  const db = load();
  const e = db.listings[key];
  if (!e) return null;
  if (value == null || value === '') delete e.wltpManual;
  else {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 30 || n > 1500) throw new Error('Zasięg WLTP musi być liczbą km z zakresu 30–1500');
    e.wltpManual = n;
  }
  save(db);
  return e;
}

/** Przywraca wpisy zwrócone wcześniej przez removeListings (przycisk „Cofnij”). */
export function restoreListings(entries) {
  const db = load();
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e.key !== 'string' || !/^[A-Za-z0-9]+$/.test(e.key) || !Array.isArray(e.history)) continue;
    const n2 = normalizeUrl(e.url);
    if (!n2 || n2.key !== e.key || db.listings[e.key]) continue;
    db.listings[e.key] = e;
    n++;
  }
  if (n) save(db);
  return n;
}

let checking = null;

/** Sprawdza wszystkie ogłoszenia. Równoległe wywołania dzielą jeden przebieg. */
export function checkAll(log = () => {}) {
  checking ??= (async () => {
    const changes = [];
    const keys = Object.keys(load().listings);
    for (const [i, key] of keys.entries()) {
      // Wczytujemy świeżo za każdym razem, żeby nie nadpisać zmian zrobionych w międzyczasie (np. usunięcia).
      const db = load();
      const entry = db.listings[key];
      if (!entry) continue;
      if (entry.status === 'REMOVED' && entry.removedAt &&
          Date.now() - Date.parse(entry.removedAt) > 7 * 864e5) continue; // nie odpytuj w nieskończoność usuniętych

      const r = await fetchListing(entry.url);
      const fresh = load();
      if (!fresh.listings[key]) continue;
      const c = apply(fresh.listings[key], r, new Date().toISOString());
      save(fresh);

      const e = fresh.listings[key];
      if (!r.ok) log(`[${i + 1}/${keys.length}] ! ${e.title ?? e.url}: ${r.error}`);
      else if (c.changed) {
        const diff = c.to - c.from;
        log(`[${i + 1}/${keys.length}] ${diff < 0 ? '▼' : '▲'} ${e.title}: ${c.from} → ${c.to} ${e.currency}`);
        changes.push({ key, title: e.title, from: c.from, to: c.to, url: e.url });
      } else if (c.statusChanged) log(`[${i + 1}/${keys.length}] • ${e.title}: status ${e.status}`);
      else log(`[${i + 1}/${keys.length}]   ${e.title}: bez zmian`);

      if (i < keys.length - 1) await sleep(DELAY_MS);
    }
    return changes;
  })().finally(() => { checking = null; });
  return checking;
}

export const isChecking = () => checking !== null;
