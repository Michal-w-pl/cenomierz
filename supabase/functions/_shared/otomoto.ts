// Pobieranie danych pojedynczego ogłoszenia z Otomoto (dane z <script id="__NEXT_DATA__">).

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'pl-PL,pl;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
};

const LISTING_RE = /^https:\/\/(www\.)?otomoto\.pl\/[a-z-]+\/oferta\/[^?#]*-ID([A-Za-z0-9]+)\.html/;

export function normalizeUrl(input: unknown): { url: string; key: string } | null {
  let s = String(input ?? '').trim();
  if (s.startsWith('/')) s = 'https://www.otomoto.pl' + s;
  if (s.startsWith('otomoto.pl') || s.startsWith('www.otomoto.pl')) s = 'https://' + s;
  const m = s.match(LISTING_RE);
  if (!m) return null;
  return { url: m[0].replace('://otomoto.pl', '://www.otomoto.pl'), key: m[2] };
}

export type Listing =
  | { ok: true; status: 'REMOVED' }
  | { ok: true; status: string; price: number | null; currency: string; title: string; image: string | null;
      features: string[]; location: string | null; specs: Record<string, unknown> }
  | { ok: false; error: string };

// deno-lint-ignore no-explicit-any
type Any = any;

export async function fetchListing(url: string): Promise<Listing> {
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    return { ok: false, error: `Błąd sieci: ${(e as Error).message}` };
  }
  if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return { ok: true, status: 'REMOVED' }; }
  if (!res.ok) { await res.body?.cancel(); return { ok: false, error: `HTTP ${res.status}` }; }

  const html = await res.text();
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  if (start < 0) return { ok: false, error: 'Brak __NEXT_DATA__ na stronie (zmiana struktury lub blokada)' };
  const open = html.indexOf('>', start) + 1;
  const end = html.indexOf('</script>', open);
  let ad: Any;
  try {
    ad = JSON.parse(html.slice(open, end))?.props?.pageProps?.advert;
  } catch {
    return { ok: false, error: 'Nie udało się odczytać danych ogłoszenia' };
  }
  if (!ad) return { ok: true, status: 'REMOVED' };

  const param = (k: string) => ad.parametersDict?.[k]?.values?.[0];
  const label = (k: string) => param(k)?.label ?? null;
  const num = (k: string) => { const n = Number(param(k)?.value); return Number.isFinite(n) ? n : null; };
  const specs: Record<string, unknown> = {
    make: label('make'), model: label('model'), version: label('version_label') ?? label('version'),
    year: num('year'), mileage: num('mileage'), power: num('engine_power'), engineCapacity: num('engine_capacity'),
    fuel: label('fuel_type'), gearbox: label('gearbox'), drive: label('transmission'), body: label('body_type'),
    color: label('color'), damaged: label('damaged'), imported: param('is_imported_car') ? label('is_imported_car') : null,
    rangeDeclared: num('autonomy'), battery: num('battery_capacity'), consumption: num('avg_consumption'),
  };
  const est = ad.electricVehicleBatteryEstimation;
  if (est) {
    const sc = (season: string, speed: string) =>
      est.autonomyScenarios?.find((s: Any) => s.season === season && s.speed === speed)?.estimatedRangeKm ?? null;
    specs.ev = {
      batteryWh: est.batteryCapacityWh ?? null,
      summerCity: sc('SUMMER', 'CITY'), summerHighway: sc('SUMMER', 'HIGHWAY'),
      winterCity: sc('WINTER', 'CITY'), winterHighway: sc('WINTER', 'HIGHWAY'),
      acMinutes: est.chargingTime?.regularScenario?.durationMinutes ?? null,
      acKw: est.chargingTime?.regularScenario?.powerKw ?? null,
      dcMinutes: est.chargingTime?.fastScenario?.durationMinutes ?? null,
      dcKw: est.chargingTime?.fastScenario?.powerKw ?? null,
      healthPct: est.health?.averagePct ?? null,
    };
  }
  const price = Number(ad.price?.value);
  return {
    ok: true,
    status: ad.status || 'UNKNOWN',
    price: Number.isFinite(price) ? price : null,
    currency: ad.price?.currency || 'PLN',
    title: ad.title,
    image: ad.images?.photos?.[0]?.url || null,
    features: Array.isArray(ad.mainFeatures) ? ad.mainFeatures : [],
    location: [ad.seller?.location?.city, ad.seller?.location?.region].filter(Boolean).join(', ') || null,
    specs,
  };
}

// ---------- wyniki wyszukiwania ----------

/** Link do wyników wyszukiwania Otomoto (nie do pojedynczego ogłoszenia) bez numeru strony, albo null. */
export function normalizeSearchUrl(input: unknown): string | null {
  let u: URL;
  try { u = new URL(String(input ?? '').trim()); } catch { return null; }
  if (!/^(www\.)?otomoto\.pl$/.test(u.hostname) || u.pathname.includes('/oferta/') || u.pathname === '/') return null;
  u.protocol = 'https:'; u.hostname = 'www.otomoto.pl'; u.hash = '';
  u.searchParams.delete('page');
  return u.toString();
}

export type SearchHit = {
  key: string; url: string; title: string | null; subtitle: string | null; image: string | null;
  price: number | null; currency: string; location: string | null; params: Record<string, unknown>; createdAt: string | null;
};
export type SearchPage = { ok: true; total: number; hits: SearchHit[] } | { ok: false; error: string };

/** Jedna strona wyników (32 ogłoszenia), najnowsze najpierw. */
export async function fetchSearchPage(searchUrl: string, page = 1): Promise<SearchPage> {
  const u = new URL(searchUrl);
  u.searchParams.set('search[order]', 'created_at_first:desc');
  if (page > 1) u.searchParams.set('page', String(page));
  let res: Response;
  try {
    res = await fetch(u, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    return { ok: false, error: `Błąd sieci: ${(e as Error).message}` };
  }
  if (!res.ok) { await res.body?.cancel(); return { ok: false, error: `HTTP ${res.status}` }; }
  const html = await res.text();
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  if (start < 0) return { ok: false, error: 'Brak __NEXT_DATA__ na stronie (zmiana struktury lub blokada)' };
  const open = html.indexOf('>', start) + 1;
  let search: Any;
  try {
    const state = JSON.parse(html.slice(open, html.indexOf('</script>', open)))?.props?.pageProps?.urqlState ?? {};
    for (const v of Object.values(state) as Any[]) {
      const d = JSON.parse(v?.data ?? '{}');
      if (d.advertSearch) { search = d.advertSearch; break; }
    }
  } catch {
    return { ok: false, error: 'Nie udało się odczytać wyników wyszukiwania' };
  }
  if (!search) return { ok: false, error: 'To nie wygląda na stronę wyników wyszukiwania Otomoto' };

  const hits: SearchHit[] = [];
  for (const { node: n } of (search.edges ?? []) as Any[]) {
    const m = String(n?.url ?? '').match(/-ID([A-Za-z0-9]+)\.html/);
    if (!m) continue;
    const p = Object.fromEntries((n.parameters ?? []).map((x: Any) => [x.key, x]));
    const num = (k: string) => { const v = Number(p[k]?.value); return Number.isFinite(v) ? v : null; };
    const price = Number(n.price?.amount?.units);
    hits.push({
      key: m[1], url: n.url, title: n.title ?? null, subtitle: n.shortDescription ?? null,
      image: n.thumbnail?.x2 ?? n.thumbnail?.x1 ?? null,
      price: Number.isFinite(price) ? price : null, currency: n.price?.amount?.currencyCode ?? 'PLN',
      location: [n.location?.city?.name, n.location?.region?.name].filter(Boolean).join(', ') || null,
      params: { year: num('year'), mileage: num('mileage'), power: num('engine_power'), fuel: p.fuel_type?.displayValue ?? null },
      createdAt: n.createdAt ?? null,
    });
  }
  return { ok: true, total: Number(search.totalCount) || hits.length, hits };
}
