// Oficjalne dane WLTP dla aut elektrycznych z brytyjskiej agencji homologacyjnej VCA
// (Vehicle Certification Agency, carfueldata.vehicle-certification-agency.gov.uk, © Crown copyright).
// Procedura WLTP jest ta sama co w UE, więc wartości dla tej samej wersji są zgodne z homologacją europejską.
// Bazy nie mają marki, które nie sprzedają w UK albo nie zgłaszają danych (np. BYD, GAC, Denza).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'wltp-vca.json');
const BASE = 'https://carfueldata.vehicle-certification-agency.gov.uk';
const MAX_AGE_DAYS = 30;

// --- pobieranie -----------------------------------------------------------------

/** Strona pobierania wymaga ciasteczka sesji ASP.NET, dlatego najpierw odwiedzamy stronę główną. */
async function downloadZip() {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
  let cookie = '';
  // Przekierowania śledzimy ręcznie, żeby po drodze zbierać ciasteczka.
  const get = async (url, referer) => {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, { headers: { ...headers, Cookie: cookie, Referer: referer ?? BASE + '/' }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';'), name = kv.split('=')[0];
        cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(name + '=')), kv].join('; ');
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { referer = url; url = new URL(loc, url).href; continue; }
      return res;
    }
    throw new Error('VCA: zbyt wiele przekierowań');
  };
  await get(BASE + '/');
  await get(BASE + '/downloads/default.aspx');
  const page = await (await get(BASE + '/downloads/download.aspx?rg=latest', BASE + '/downloads/default.aspx')).text();
  const link = page.match(/href="(create_latest_data_csv\.asp\?id=\d+)"/)?.[1];
  if (!link) throw new Error('VCA: nie znaleziono linku do pliku CSV (zmiana strony?)');
  const res = await get(`${BASE}/downloads/${link}`, BASE + '/downloads/download.aspx?rg=latest');
  if (!res.ok) throw new Error(`VCA: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimalne rozpakowanie pierwszego pliku z archiwum ZIP (katalog centralny + deflate). */
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('VCA: plik nie jest archiwum ZIP');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('VCA: uszkodzone archiwum ZIP');
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

export async function updateVca() {
  const csv = unzipFirst(await downloadZip()).toString('latin1');
  const [head, ...rows] = parseCsv(csv);
  const col = (name) => head.indexOf(name);
  const need = ['Manufacturer', 'Model', 'Description', 'Fuel Type', 'Engine Power (PS)', 'Maximum range (Km)', 'Electric Range City Km', 'wh/km'];
  for (const n of need) if (col(n) < 0) throw new Error(`VCA: brak kolumny „${n}” (zmiana formatu pliku?)`);
  const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
  const bev = rows
    .filter((r) => r[col('Fuel Type')] === 'Electricity' && num(r[col('Maximum range (Km)')]))
    .map((r) => ({
      mfr: r[col('Manufacturer')].trim(),
      model: r[col('Model')].trim(),
      desc: r[col('Description')].trim(),
      ps: num(r[col('Engine Power (PS)')]),
      range: num(r[col('Maximum range (Km)')]),
      city: num(r[col('Electric Range City Km')]),
      whkm: num(r[col('wh/km')]),
    }));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ source: 'VCA (UK) — Euro 6 latest', fetchedAt: new Date().toISOString(), rows: bev }));
  cache = null;
  return bev.length;
}

// --- dopasowanie ----------------------------------------------------------------

let cache = null;
function table() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = { rows: [] }; }
  return cache;
}

export const vcaInfo = () => { const t = table(); return { rows: t.rows.length, fetchedAt: t.fetchedAt ?? null }; };
export const vcaStale = () => { const t = vcaInfo().fetchedAt; return !t || Date.now() - Date.parse(t) > MAX_AGE_DAYS * 864e5; };

const MAKE_ALIAS = { opel: ['vauxhall', 'opel'], 'mercedes-benz': ['mercedes'], mini: ['mini'], ds: ['ds'], changan: ['deepal', 'changan'] };
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

function modelMatches(vcaModel, listingModel) {
  const target = norm(listingModel);
  const alt = target.replace(/^e(?=\d)/, ''); // Peugeot „e-3008” = „3008”
  const toks = String(vcaModel).split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let k = 1; k <= Math.min(3, toks.length); k++) {
    const n = norm(toks.slice(0, k).join(''));
    if (n === target || n === alt) return true;
  }
  return false;
}

const kwhOf = (s) => {
  const m = String(s).match(/(\d{2,3}(?:[.,]\d)?)\s*-?\s*kwh/i) ?? String(s).match(/\b(\d{2,3})B\b/); // „81.4kWh”, Nissan „87B”
  return m ? Number(m[1].replace(',', '.')) : null;
};
const isAwd = (s) => /\b(awd|4wd|4x4|4motion|4matic|xdrive|dual motor|twin motor|quattro|all.?wheel)\b/i.test(s);

/**
 * Szuka wersji z bazy VCA pasującej do parametrów ogłoszenia.
 * Zwraca { range, rangeMin, city, whkm, variant, exact } albo null.
 * range = najwyższa wartość WLTP tej wersji (wg producenta), rangeMin = najniższa (cięższe wyposażenie / większe felgi).
 */
export function matchOfficial(specs) {
  if (!specs?.make || !specs?.model) return null;
  const mk = norm(specs.make);
  const aliases = MAKE_ALIAS[specs.make.toLowerCase()] ?? [mk];
  const cands = table().rows.filter((r) => aliases.some((a) => norm(r.mfr).startsWith(norm(a))) && modelMatches(r.model, specs.model));
  if (!cands.length) return null;

  const batt = specs.battery ?? (specs.ev?.batteryWh ? specs.ev.batteryWh / 1000 : null) ?? kwhOf(specs.version);
  const awd = /4x4|wszystkie|awd/i.test(specs.drive ?? '') || isAwd(specs.version ?? '');
  const vWords = words(specs.version).filter((w) => w.length > 2 && !/kwh$/.test(w));
  const scored = cands.map((r) => {
    let score = 0, signals = 0;
    const rb = kwhOf(r.desc);
    if (batt && rb) { score += Math.abs(rb - batt) * 3; signals++; }
    if (specs.power && r.ps) { score += Math.abs(r.ps - specs.power) / 8; signals++; }
    if (awd !== isAwd(r.desc)) score += 15;
    const dWords = words(r.desc);
    score -= vWords.filter((w) => dWords.includes(w)).length * 4;
    return { r, score, signals };
  }).sort((a, b) => a.score - b.score);

  const best = scored[0];
  const same = scored.filter((s) => s.r.desc === best.r.desc && s.r.model === best.r.model).map((s) => s.r);
  const ranges = same.map((r) => r.range);
  return {
    range: Math.max(...ranges),
    rangeMin: Math.min(...ranges),
    city: Math.max(...same.map((r) => r.city ?? 0)) || null,
    whkm: (() => { const v = Math.min(...same.map((r) => r.whkm ?? Infinity)); return Number.isFinite(v) ? v : null; })(),
    battery: kwhOf(best.r.desc),
    variant: `${best.r.model} · ${best.r.desc}`,
    exact: best.signals >= 1 && best.score < 12,
  };
}
