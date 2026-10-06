// Pobieranie danych pojedynczego ogłoszenia z Otomoto.
// Strona ogłoszenia to aplikacja Next.js — wszystkie dane są w <script id="__NEXT_DATA__">.

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'pl-PL,pl;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
};

const LISTING_RE = /^https:\/\/(www\.)?otomoto\.pl\/[a-z-]+\/oferta\/[^?#]*-ID([A-Za-z0-9]+)\.html/;

/** Normalizuje adres ogłoszenia; zwraca { url, key } albo null, jeśli to nie jest ogłoszenie Otomoto. */
export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (s.startsWith('/')) s = 'https://www.otomoto.pl' + s;
  if (s.startsWith('otomoto.pl') || s.startsWith('www.otomoto.pl')) s = 'https://' + s;
  const m = s.match(LISTING_RE);
  if (!m) return null;
  return { url: m[0].replace('://otomoto.pl', '://www.otomoto.pl'), key: m[2] };
}

/**
 * Zwraca:
 *  { ok: true, status, price, currency, title, image, features, adId }
 *  { ok: true, status: 'REMOVED' }  — ogłoszenie usunięte (404/410)
 *  { ok: false, error }              — błąd sieci / zmiana struktury strony
 */
export async function fetchListing(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { ok: false, error: `Błąd sieci: ${e.message}` };
  }
  if (res.status === 404 || res.status === 410) return { ok: true, status: 'REMOVED' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, error: 'Brak __NEXT_DATA__ na stronie (zmiana struktury lub blokada)' };

  let ad;
  try {
    ad = JSON.parse(m[1])?.props?.pageProps?.advert;
  } catch {
    return { ok: false, error: 'Nie udało się sparsować __NEXT_DATA__' };
  }
  // Przekierowanie z nieaktywnego ogłoszenia na listę wyników — brak obiektu advert.
  if (!ad) return { ok: true, status: 'REMOVED' };

  const price = Number(ad.price?.value);
  const param = (k) => ad.parametersDict?.[k]?.values?.[0];
  const label = (k) => param(k)?.label ?? null;
  const num = (k) => { const n = Number(param(k)?.value); return Number.isFinite(n) ? n : null; };
  const specs = {
    make: label('make'),
    model: label('model'),
    version: label('version_label') ?? label('version'),
    year: num('year'),
    mileage: num('mileage'),
    power: num('engine_power'),
    engineCapacity: num('engine_capacity'),
    fuel: label('fuel_type'),
    gearbox: label('gearbox'),
    drive: label('transmission'),
    body: label('body_type'),
    color: label('color'),
    damaged: label('damaged'),
    imported: param('is_imported_car') ? label('is_imported_car') : null,
    // Elektryki — wartości wpisywane przez sprzedającego (zasięg deklarowany jako WLTP)
    rangeDeclared: num('autonomy'),
    battery: num('battery_capacity'),
    consumption: num('avg_consumption'),
  };
  // Szacunki Otomoto (niezależne od sprzedającego): zasięg w 4 scenariuszach, czas ładowania, kondycja baterii
  const est = ad.electricVehicleBatteryEstimation;
  if (est) {
    const sc = (season, speed) => est.autonomyScenarios?.find((s) => s.season === season && s.speed === speed)?.estimatedRangeKm ?? null;
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
    adId: String(ad.id),
  };
}
