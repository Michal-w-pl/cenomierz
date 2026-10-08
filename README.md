# Cenomierz — śledzenie cen z Otomoto

**https://michal-w-pl.github.io/cenomierz/** — każdy zakłada własne konto i ma własną listę obserwowanych
ogłoszeń i wyszukiwań. Ceny są sprawdzane automatycznie raz dziennie, a zmiany przychodzą mailem.

## Co potrafi

- historia cen obserwowanych ogłoszeń (wykresy, porównywarka, zasięg WLTP elektryków z bazy VCA),
- porównanie ceny z rynkiem — podobne oferty z Otomoto (marka, model, paliwo, rocznik ±1, zbliżona moc),
- śledzenie wyszukiwań — nowe ogłoszenia dla zapisanego linku do wyników Otomoto,
- poranny mail z obniżkami cen i nowymi ogłoszeniami, resetowanie hasła.

## Jak działa

| Element | Gdzie | Co robi |
|---|---|---|
| Strona | `docs/index.html` → GitHub Pages | panel, porównywarka, wyszukiwania, logowanie |
| Baza i konta | Supabase (`supabase/migrations`) | ogłoszenia i historia cen (wspólne), obserwacje i wyszukiwania (per użytkownik, chronione RLS) |
| `add-listings` | funkcja Supabase | dodaje ogłoszenia zalogowanego użytkownika, pobiera dane z Otomoto |
| `refresh` | funkcja + pg_cron co 10 min | odświeża ogłoszenia sprawdzane > 20 h temu; raz na 30 dni pobiera oficjalne WLTP (VCA) |
| `searches` | funkcja + pg_cron co 10 min | sprawdza zapisane wyszukiwania starsze niż 4 h, zapisuje nowe ogłoszenia |
| `market` | funkcja + pg_cron co godzinę | co 3 dni pobiera próbkę podobnych ofert do porównania z rynkiem |
| `alerts` | funkcja + pg_cron 6:00 UTC | zbiorczy mail (Brevo) z obniżkami cen i nowymi ogłoszeniami |
| `health` | funkcja + pg_cron co godzinę | kontrola działania (`health_check()`): mail i push do `HEALTH_EMAIL` przy problemie, raz na dobę gdy trwa, i po naprawie |

Dane z Otomoto są czytane z `__NEXT_DATA__` na stronach ogłoszeń i wyników wyszukiwania (`supabase/functions/_shared/otomoto.ts`).

## Wdrożenie

```
npx supabase db push                          # migracje
npx supabase functions deploy <nazwa> --use-api
npx supabase config push                      # ustawienia logowania (SMTP Brevo z .env.local)
git push                                      # strona (GitHub Pages z main:/docs)
```

Sekrety (w `.env.local`, poza repozytorium): `SUPABASE_DB_PASSWORD`, `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`,
`BREVO_API_KEY`, `ALERT_FROM`. Funkcje korzystają z sekretów Supabase `BREVO_API_KEY`, `ALERT_FROM` i `HEALTH_EMAIL` (adres administratora).

Pierwotna wersja lokalna (Node.js, `data/listings.json`) została wycofana — jest w historii gita przed commitem
„Wycofanie wersji lokalnej”.
