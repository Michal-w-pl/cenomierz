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
