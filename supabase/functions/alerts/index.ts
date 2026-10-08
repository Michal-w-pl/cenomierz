// Powiadomienia e-mail (pg_cron raz dziennie): obniżki cen obserwowanych ogłoszeń i nowe ogłoszenia
// z zapisanych wyszukiwań. Każdy użytkownik dostaje jeden zbiorczy mail ze zmianami od poprzedniego powiadomienia.
// Wywołanie jest bezpieczne do powtarzania: zgłoszone zmiany nie są wysyłane drugi raz.
// Wysyłka przez API Brevo (sekrety: BREVO_API_KEY, ALERT_FROM = zweryfikowany adres nadawcy w Brevo).
import { admin, json } from '../_shared/db.ts';
import { dealLabel } from '../_shared/deal.ts';

const SITE = 'https://michal-w-pl.github.io/cenomierz/';
const MAX_HITS_PER_SEARCH = 12;

type Drop = {
  user_id: string; email: string; ad_key: string; title: string | null; url: string; image: string | null;
  currency: string; old_price: number; new_price: number; changed_at: string; target_price: number | null;
};
type Removed = {
  user_id: string; email: string; ad_key: string; title: string | null; url: string; image: string | null;
  currency: string; last_price: number | null; removed_at: string; added_at: string;
};
type Hit = {
  user_id: string; email: string; search_name: string; search_url: string; ad_key: string; title: string | null;
  url: string; image: string | null; price: number | null; currency: string | null; location: string | null;
  params: { year?: number | null; mileage?: number | null; power?: number | null; fuel?: string | null };
  deal_pct: number | null; deal_n: number | null;
};
type Digest = { email: string; drops: Drop[]; hits: Hit[]; removed: Removed[] };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Metoda niedozwolona' }, 405);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  const db = admin();
  const until = new Date().toISOString();

  const [d, h, r] = await Promise.all([
    db.rpc('pending_drop_alerts', { until }),
    db.rpc('pending_search_alerts', { until }),
    db.rpc('pending_removed_alerts', { until }),
  ]);
  if (d.error || h.error || r.error) return json({ error: (d.error ?? h.error ?? r.error)!.message }, 500);
  const byUser = new Map<string, Digest>();
  const digest = (id: string, email: string) => {
    if (!byUser.has(id)) byUser.set(id, { email, drops: [], hits: [], removed: [] });
    return byUser.get(id)!;
  };
  for (const x of (d.data ?? []) as Drop[]) digest(x.user_id, x.email).drops.push(x);
  for (const x of (h.data ?? []) as Hit[]) digest(x.user_id, x.email).hits.push(x);
  for (const x of (r.data ?? []) as Removed[]) digest(x.user_id, x.email).removed.push(x);

  // { dryRun: true } — podgląd bez wysyłki i bez oznaczania jako wysłane (tylko z kluczem service role)
  const isAdmin = req.headers.get('Authorization') === `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
  if (body.dryRun && !isAdmin) return json({ error: 'Brak uprawnień' }, 403);
  if (body.dryRun) return json({ users: byUser.size, digests: [...byUser.values()].map((g) => ({ subject: subject(g), drops: g.drops.length, hits: g.hits.length, removed: g.removed.length })) });

  const apiKey = Deno.env.get('BREVO_API_KEY'), from = Deno.env.get('ALERT_FROM');
  if (!apiKey || !from) return json({ error: 'Brak sekretów BREVO_API_KEY / ALERT_FROM' }, 500);
  const failed: string[] = [];
  for (const [userId, g] of byUser) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Cenomierz', email: from },
        to: [{ email: g.email }],
        subject: subject(g),
        htmlContent: html(g),
        textContent: text(g),
      }),
    });
    if (!res.ok) {
      console.error('Brevo', res.status, await res.text());
      failed.push(userId);
    }
  }
  const { error: e2 } = await db.rpc('alerts_mark', { until, skip: failed });
  if (e2) return json({ error: e2.message }, 500);
  return json({ users: byUser.size, sent: byUser.size - failed.length, failed: failed.length });
});

const fmt = (n: number) => Math.round(n).toLocaleString('pl-PL').replace(/\s/g, ' ');
const money = (n: number | null, cur: string | null) => n == null ? '—' : `${fmt(n)} ${!cur || cur === 'PLN' ? 'zł' : cur}`;
const dateS = (t: string) => new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', timeZone: 'Europe/Warsaw' });
const pct = (d: Drop) => ((d.new_price - d.old_price) / d.old_price * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
const hitMeta = (x: Hit) => [x.params?.year, x.params?.mileage != null ? `${fmt(x.params.mileage)} km` : null,
  x.params?.power ? `${x.params.power} KM` : null, x.location].filter(Boolean).join(' · ');

// „12% poniżej rynku” względem podobnych ofert z wyszukiwania (zielone = taniej)
const dealHtml = (x: Hit) => {
  const l = dealLabel(x.deal_pct);
  return l ? `&nbsp;<span style="color:${x.deal_pct! < 0 ? '#15803d' : '#b45309'};font-size:13px" title="vs ${x.deal_n} podobnych ofert">${l}</span>` : '';
};

/** Wyszukiwania z ich nowymi ogłoszeniami, w kolejności z zapytania. */
function bySearch(hits: Hit[]) {
  const m = new Map<string, { name: string; url: string; hits: Hit[] }>();
  for (const x of hits) {
    const k = x.search_url + '\n' + x.search_name;
    if (!m.has(k)) m.set(k, { name: x.search_name, url: x.search_url, hits: [] });
    m.get(k)!.hits.push(x);
  }
  return [...m.values()];
}

function subject(g: Digest) {
  const parts: string[] = [];
  if (g.drops.length === 1 && !g.hits.length && !g.removed.length) {
    const d = g.drops[0];
    return d.target_price != null
      ? `${d.title ?? 'Ogłoszenie'} — cena spadła do Twojego progu: ${money(d.new_price, d.currency)}`
      : `${d.title ?? 'Ogłoszenie'} — taniej o ${money(d.old_price - d.new_price, d.currency)}`;
  }
  if (g.removed.length === 1 && !g.drops.length && !g.hits.length) return `${g.removed[0].title ?? 'Ogłoszenie'} — zniknęło z Otomoto`;
  if (g.drops.length) parts.push(`${g.drops.length} ${plural(g.drops.length, 'obniżka', 'obniżki', 'obniżek')} cen`);
  if (g.hits.length) {
    const s = bySearch(g.hits);
    parts.push(`${g.hits.length} ${plural(g.hits.length, 'nowe ogłoszenie', 'nowe ogłoszenia', 'nowych ogłoszeń')}${s.length === 1 ? ` — ${s[0].name}` : ''}`);
  }
  if (g.removed.length) parts.push(`${g.removed.length} ${plural(g.removed.length, 'ogłoszenie zniknęło', 'ogłoszenia zniknęły', 'ogłoszeń zniknęło')}`);
  return `Cenomierz: ${parts.join(', ')}`;
}

function text(g: Digest) {
  const lines: string[] = [];
  if (g.drops.length) {
    lines.push('Obserwowane ogłoszenia, które potaniały:', '');
    for (const d of g.drops) lines.push(`• ${d.title ?? d.ad_key}: ${money(d.old_price, d.currency)} → ${money(d.new_price, d.currency)} (${pct(d)}%)${d.target_price != null ? ` — osiągnięty próg ${money(d.target_price, d.currency)}` : ''}\n  ${d.url}`);
    lines.push('');
  }
  if (g.removed.length) {
    lines.push('Zniknęły z Otomoto (prawdopodobnie sprzedane):', '');
    for (const x of g.removed) lines.push(`• ${x.title ?? x.ad_key}: ostatnia cena ${money(x.last_price, x.currency)}, obserwowane od ${dateS(x.added_at)}`);
    lines.push('');
  }
  for (const s of bySearch(g.hits)) {
    lines.push(`Nowe ogłoszenia — ${s.name}:`, '');
    for (const x of s.hits.slice(0, MAX_HITS_PER_SEARCH)) lines.push(`• ${x.title ?? x.ad_key}: ${money(x.price, x.currency)}${dealLabel(x.deal_pct) ? ` — ${dealLabel(x.deal_pct)}` : ''} (${hitMeta(x)})\n  ${x.url}`);
    if (s.hits.length > MAX_HITS_PER_SEARCH) lines.push(`…i ${s.hits.length - MAX_HITS_PER_SEARCH} więcej: ${s.url}`);
    lines.push('');
  }
  lines.push(`Panel: ${SITE}`, 'Powiadomienia wyłączysz w panelu: menu konta → Powiadomienia e-mail.');
  return lines.join('\n');
}

const thumb = (url: string, img: string | null) => img
  ? `<a href="${esc(url)}"><img src="${esc(img)}" width="84" height="63" alt="" style="display:block;border-radius:8px;object-fit:cover"></a>` : '';
const row = (img: string, content: string) => `
    <tr>
      <td style="padding:12px 0;border-top:1px solid #e7e5e4;width:96px;vertical-align:top">${img}</td>
      <td style="padding:12px 0;border-top:1px solid #e7e5e4;vertical-align:top">${content}</td>
    </tr>`;
const heading = (t: string) => `<tr><td colspan="2" style="padding:18px 0 8px;font-weight:700;font-size:15px">${t}</td></tr>`;

function html(g: Digest) {
  let body = '';
  if (g.drops.length) {
    body += heading(g.drops.length === 1 ? 'Obserwowane ogłoszenie potaniało' : `${g.drops.length} ${plural(g.drops.length, 'obserwowane ogłoszenie potaniało', 'obserwowane ogłoszenia potaniały', 'obserwowanych ogłoszeń potaniało')}`);
    body += g.drops.map((d) => row(thumb(d.url, d.image), `
        <a href="${esc(d.url)}" style="color:#1c1917;font-weight:600;text-decoration:none">${esc(d.title ?? d.ad_key)}</a><br>
        <span style="color:#78716c;text-decoration:line-through">${money(d.old_price, d.currency)}</span>
        &nbsp;→&nbsp;<b style="color:#15803d">${money(d.new_price, d.currency)}</b>
        <span style="color:#15803d">&nbsp;▼ ${money(d.old_price - d.new_price, d.currency)} (${pct(d)}%)</span>
        ${d.target_price != null ? `<br><span style="font-size:13px;color:#57534e">Osiągnięty Twój próg: ${money(d.target_price, d.currency)}</span>` : ''}`)).join('');
  }
  if (g.removed.length) {
    body += heading('Zniknęły z Otomoto <span style="font-weight:400;color:#78716c">(prawdopodobnie sprzedane)</span>');
    body += g.removed.map((x) => row(thumb(x.url, x.image), `
        <span style="color:#1c1917;font-weight:600">${esc(x.title ?? x.ad_key)}</span><br>
        <span style="color:#57534e;font-size:13px">Ostatnia cena ${money(x.last_price, x.currency)} · obserwowane od ${dateS(x.added_at)}</span>`)).join('');
  }
  for (const s of bySearch(g.hits)) {
    body += heading(`Nowe ogłoszenia — <a href="${esc(s.url)}" style="color:#1c1917">${esc(s.name)}</a>`);
    body += s.hits.slice(0, MAX_HITS_PER_SEARCH).map((x) => row(thumb(x.url, x.image), `
        <a href="${esc(x.url)}" style="color:#1c1917;font-weight:600;text-decoration:none">${esc(x.title ?? x.ad_key)}</a><br>
        <b>${money(x.price, x.currency)}</b>${dealHtml(x)}<br>
        <span style="color:#78716c;font-size:13px">${esc(hitMeta(x))}</span>`)).join('');
    if (s.hits.length > MAX_HITS_PER_SEARCH) {
      body += `<tr><td colspan="2" style="padding:8px 0;border-top:1px solid #e7e5e4"><a href="${esc(s.url)}" style="color:#1c1917">…i ${s.hits.length - MAX_HITS_PER_SEARCH} więcej na Otomoto</a></td></tr>`;
    }
  }
  return `<!doctype html><html lang="pl"><body style="margin:0;background:#f5f5f4;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;padding:22px 24px">
      <tr><td colspan="2" style="font-size:20px;font-weight:700">Cenomierz</td></tr>
      ${body}
      <tr><td colspan="2" style="padding-top:18px;border-top:1px solid #e7e5e4">
        <a href="${SITE}" style="display:inline-block;background:#1c1917;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:10px">Otwórz panel</a>
      </td></tr>
      <tr><td colspan="2" style="padding-top:16px;font-size:12px;color:#a8a29e">Powiadomienia wyłączysz w panelu: menu konta → Powiadomienia e-mail.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}
