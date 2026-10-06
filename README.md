# Cenomierz — śledzenie cen z Otomoto

**Wersja online:** https://michal-w-pl.github.io/cenomierz/ — każdy zakłada własne konto i ma własną listę
obserwowanych ogłoszeń. Ceny są sprawdzane automatycznie raz dziennie.

## Wersja online — jak działa

| Element | Gdzie | Co robi |
|---|---|---|
| Strona | `docs/index.html` → GitHub Pages | panel, porównywarka, logowanie |
| Baza i konta | Supabase (`supabase/migrations`) | ogłoszenia i historia cen (wspólne), obserwacje (per użytkownik, chronione RLS) |
| `add-listings` | funkcja Supabase | dodaje ogłoszenia zalogowanego użytkownika, pobiera dane z Otomoto |
| `refresh` | funkcja Supabase + pg_cron co 10 min | odświeża porcję ogłoszeń sprawdzanych > 20 h temu; raz na 30 dni pobiera oficjalne WLTP (VCA) |

Wdrożenie zmian: `npx supabase db push`, `npx supabase functions deploy --use-api`, a strona — push do `main`.

## Wersja lokalna (pierwotna)

Lokalne narzędzie, które zapamiętuje ceny obserwowanych ogłoszeń z otomoto.pl i pokazuje ich zmiany na wykresach.
Wymaga tylko Node.js 20+ (bez `npm install`).

## Start

```
npm start            # panel na http://localhost:3000
```

W panelu:
- wklej link do ogłoszenia → **Dodaj**,
- albo zaimportuj wszystkie **Obserwowane** z konta: na dole strony jest zakładka-bookmarklet. Przeciągnij ją na pasek zakładek, otwórz w Otomoto stronę Obserwowane (zalogowany) i kliknij zakładkę.

Gdy panel jest uruchomiony, sam sprawdza ceny co 6 h (`CHECK_EVERY_H=12 npm start`, żeby to zmienić). Jest też przycisk **Sprawdź ceny teraz**.

## Wiersz poleceń

```
node cli.js add <link> [link...]    # dodaj
node cli.js add --file linki.txt    # dodaj linki z pliku
node cli.js list                    # lista z różnicą ceny od dodania
node cli.js check                   # sprawdź ceny
node cli.js remove <klucz>          # klucz z `list`
```

## Automatycznie, bez włączonego panelu

```
powershell -ExecutionPolicy Bypass -File zaplanuj.ps1
```

Rejestruje zadanie w Harmonogramie zadań Windows (8:00 i 20:00; jeśli komputer był wtedy wyłączony, sprawdzenie odpali się po włączeniu). Log zapisuje się w `data\check.log`.

## Jak to działa

- Cena, tytuł i zdjęcie są czytane z danych `__NEXT_DATA__` na stronie ogłoszenia.
- Dane trzymane są w `data/listings.json`. Do historii trafia nowy punkt tylko wtedy, gdy cena się zmieni.
- Ogłoszenia, które zniknęły (404), dostają status „usunięte”. Po 7 dniach przestają być odpytywane.
- Między zapytaniami jest 1,5 s przerwy, żeby nie obciążać serwisu.
- Oficjalny zasięg WLTP elektryków pochodzi z bazy brytyjskiej agencji homologacyjnej VCA
  (`data/wltp-vca.json`, odświeżane co 30 dni lub `node cli.js wltp`). Ogłoszenia są dopasowywane do wersji
  po marce, modelu, baterii, mocy i napędzie. Marek spoza bazy (np. BYD, GAC, Denza) dotyczy wartość z ogłoszenia.
