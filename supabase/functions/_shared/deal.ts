// Ocena ceny nowego ogłoszenia z wyszukiwania względem podobnych ofert z tego samego wyszukiwania.
// Zasady jak w panelu (porównanie z rynkiem): moc ±15% (gdy za mało → ±30%), odrzucenie cen spoza ½–2× mediany,
// co najmniej 5 ofert; przy ≥ 8 ofertach z przebiegiem — cena oczekiwana z regresji cena~przebieg.
// Dodatkowo: ta sama marka i model (dwa pierwsze słowa tytułu) i rocznik ±1, bo wyszukiwanie może być szerokie.

export type DealHit = {
  ad_key: string; title: string | null; price: number | null; currency: string | null;
  params: { year?: number | null; mileage?: number | null; power?: number | null } | null;
};
export type Deal = { pct: number; n: number };

const MIN_CMP = 5;
const modelKey = (t: string | null) => (t ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function dealFor(h: DealHit, all: DealHit[]): Deal | null {
  const price = h.price, key = modelKey(h.title), y = h.params?.year;
  if (!price || !key) return null;
  let pool = all.filter((x) => x.ad_key !== h.ad_key && x.price && x.price > 0 && x.currency === h.currency &&
    modelKey(x.title) === key && (y == null || x.params?.year == null || Math.abs(x.params.year - y) <= 1));
  const pw = h.params?.power;
  if (pw && pool.some((x) => x.params?.power)) {
    const near = (tol: number) => pool.filter((x) => x.params?.power && Math.abs(x.params.power - pw) / pw <= tol);
    pool = near(0.15).length >= MIN_CMP ? near(0.15) : near(0.3);
  }
  if (pool.length) {
    const mid = median(pool.map((x) => x.price!));
    pool = pool.filter((x) => x.price! >= mid / 2 && x.price! <= mid * 2);
  }
  if (pool.length < MIN_CMP) return null;

  let ref = median(pool.map((x) => x.price!));
  const m = h.params?.mileage, pm = pool.filter((x) => x.params?.mileage != null);
  if (m != null && pm.length >= 8) {
    const xs = pm.map((x) => x.params!.mileage!), ys = pm.map((x) => x.price!);
    const mx = avg(xs), my = avg(ys);
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const b = sxx ? sxy / sxx : 0, a0 = my - b * mx;
    if (b < 0 && m >= Math.min(...xs) && m <= Math.max(...xs) && a0 + b * m > 0) ref = a0 + b * m;
  }
  return { pct: Math.round((price - ref) / ref * 1000) / 10, n: pool.length };
}

/** Opis dla maila i powiadomienia, np. „12% poniżej rynku”; pusty, gdy różnica < 3%. */
export function dealLabel(pct: number | null | undefined) {
  if (pct == null || Math.abs(pct) < 3) return '';
  return `${Math.abs(Math.round(pct))}% ${pct < 0 ? 'poniżej' : 'powyżej'} rynku`;
}
