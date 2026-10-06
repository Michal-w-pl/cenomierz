// Oficjalne WLTP aut elektrycznych z bazy brytyjskiej agencji homologacyjnej VCA
// (carfueldata.vehicle-certification-agency.gov.uk, © Crown copyright). Procedura WLTP jest ta sama co w UE.

const BASE = 'https://carfueldata.vehicle-certification-agency.gov.uk';

export type VcaRow = { mfr: string; model: string; descr: string; ps: number | null; range: number; city: number | null; whkm: number | null };

/** Strona pobierania wymaga ciasteczka sesji ASP.NET — przekierowania śledzimy ręcznie, zbierając ciasteczka. */
async function downloadZip(): Promise<Uint8Array> {
  let cookie = '';
  const get = async (url: string, referer = BASE + '/') => {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Cookie: cookie, Referer: referer }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      for (const c of res.headers.getSetCookie()) {
        const kv = c.split(';')[0], name = kv.split('=')[0];
        cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(name + '=')), kv].join('; ');
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { await res.body?.cancel(); referer = url; url = new URL(loc, url).href; continue; }
      return res;
    }
    throw new Error('VCA: zbyt wiele przekierowań');
  };
  await (await get(BASE + '/')).body?.cancel();
  await (await get(BASE + '/downloads/default.aspx')).body?.cancel();
  const page = await (await get(BASE + '/downloads/download.aspx?rg=latest', BASE + '/downloads/default.aspx')).text();
  const link = page.match(/href="(create_latest_data_csv\.asp\?id=\d+)"/)?.[1];
  if (!link) throw new Error('VCA: nie znaleziono linku do pliku CSV');
  const res = await get(`${BASE}/downloads/${link}`, BASE + '/downloads/download.aspx?rg=latest');
  if (!res.ok) throw new Error(`VCA: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function unzipFirst(buf: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('VCA: plik nie jest archiwum ZIP');
  const cd = dv.getUint32(eocd + 16, true);
  const method = dv.getUint16(cd + 10, true), size = dv.getUint32(cd + 20, true), local = dv.getUint32(cd + 42, true);
  const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

export async function downloadVca(): Promise<VcaRow[]> {
  const csv = new TextDecoder('latin1').decode(await unzipFirst(await downloadZip()));
  const [head, ...rows] = parseCsv(csv);
  const col = (n: string) => { const i = head.indexOf(n); if (i < 0) throw new Error(`VCA: brak kolumny „${n}”`); return i; };
  const C = { mfr: col('Manufacturer'), model: col('Model'), desc: col('Description'), fuel: col('Fuel Type'), ps: col('Engine Power (PS)'), range: col('Maximum range (Km)'), city: col('Electric Range City Km'), whkm: col('wh/km') };
  const num = (v: string) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
  return rows
    .filter((r) => r[C.fuel] === 'Electricity' && num(r[C.range]))
    .map((r) => ({ mfr: r[C.mfr].trim(), model: r[C.model].trim(), descr: r[C.desc].trim(), ps: num(r[C.ps]), range: num(r[C.range])!, city: num(r[C.city]), whkm: num(r[C.whkm]) }));
}

// --- dopasowanie wersji ---------------------------------------------------------

const MAKE_ALIAS: Record<string, string[]> = { opel: ['vauxhall', 'opel'], 'mercedes-benz': ['mercedes'], changan: ['deepal', 'changan'] };
const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const words = (s: unknown) => String(s ?? '').toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

function modelMatches(vcaModel: string, listingModel: string) {
  const target = norm(listingModel), alt = target.replace(/^e(?=\d)/, '');
  const toks = vcaModel.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let k = 1; k <= Math.min(3, toks.length); k++) {
    const n = norm(toks.slice(0, k).join(''));
    if (n === target || n === alt) return true;
  }
  return false;
}
const kwhOf = (s: unknown) => {
  const m = String(s ?? '').match(/(\d{2,3}(?:[.,]\d)?)\s*-?\s*kwh/i) ?? String(s ?? '').match(/\b(\d{2,3})B\b/);
  return m ? Number(m[1].replace(',', '.')) : null;
};
const isAwd = (s: string) => /\b(awd|4wd|4x4|4motion|4matic|xdrive|dual motor|twin motor|quattro|all.?wheel)\b/i.test(s);

// deno-lint-ignore no-explicit-any
export function matchOfficial(specs: any, table: VcaRow[]) {
  if (!specs?.make || !specs?.model) return null;
  const aliases = MAKE_ALIAS[String(specs.make).toLowerCase()] ?? [norm(specs.make)];
  const cands = table.filter((r) => aliases.some((a) => norm(r.mfr).startsWith(norm(a))) && modelMatches(r.model, specs.model));
  if (!cands.length) return null;
  const batt = specs.battery ?? (specs.ev?.batteryWh ? specs.ev.batteryWh / 1000 : null) ?? kwhOf(specs.version);
  const awd = /4x4|wszystkie|awd/i.test(specs.drive ?? '') || isAwd(specs.version ?? '');
  const vWords = words(specs.version).filter((w) => w.length > 2 && !/kwh$/.test(w));
  const scored = cands.map((r) => {
    let score = 0, signals = 0;
    const rb = kwhOf(r.descr);
    if (batt && rb) { score += Math.abs(rb - batt) * 3; signals++; }
    if (specs.power && r.ps) { score += Math.abs(r.ps - specs.power) / 8; signals++; }
    if (awd !== isAwd(r.descr)) score += 15;
    const dWords = words(r.descr);
    score -= vWords.filter((w) => dWords.includes(w)).length * 4;
    return { r, score, signals };
  }).sort((a, b) => a.score - b.score);
  const best = scored[0];
  const same = scored.filter((s) => s.r.descr === best.r.descr && s.r.model === best.r.model).map((s) => s.r);
  const ranges = same.map((r) => r.range);
  return {
    range: Math.max(...ranges), rangeMin: Math.min(...ranges),
    city: Math.max(...same.map((r) => r.city ?? 0)) || null,
    whkm: (() => { const v = Math.min(...same.map((r) => r.whkm ?? Infinity)); return Number.isFinite(v) ? v : null; })(),
    battery: kwhOf(best.r.descr),
    variant: `${best.r.model} · ${best.r.descr}`,
    exact: best.signals >= 1 && best.score < 12,
  };
}
