# FilmCraft na Barley

Webowa wersja FilmCraft (`apps/filmcraft-web`) za logowaniem **passkeys**, z projektami i mediami
trzymanymi we **wspólnym folderze na serwerze**. Jeden kontener: serwer Node 24 (`server/`)
serwuje build WASM i stronę-gospodarza, która uruchamia FilmCraft w trybie host
(`data-host="page"`, zob. `packaging/web/README.md`).

```
przeglądarka ──HTTPS──> Traefik (Deplo) ──> node :3000
  /login /setup /invite     logowanie / pierwsze konto / zaproszenie (passkeys, WebAuthn)
  /                         pliki na serwerze (upload, foldery, zmiana nazwy, kosz)
  /edit?project=…           edytor FilmCraft na pliku z serwera
  /fc/*                     build FilmCraft (wasm, glue) — tylko po zalogowaniu
  /api/files/*              lista, odczyt z Range, zapis strumieniowy z If-Match, …
/data (wolumen)             filmcraft.db (SQLite), files/ (wspólne pliki), trash/
```

## Jak to działa w edytorze

- Przy otwarciu edytora wszystkie media z serwera są **montowane** w wirtualnym folderze
  `/files/` FilmCraft (`filmcraft.mountUrl`, łatka w `apps/filmcraft-web/src/fs.rs`): nic nie jest
  pobierane w całości, FilmCraft czyta kawałki po 1 MiB żądaniami HTTP `Range`. Media Browser w
  FilmCraft pokazuje więc cały folder serwera — importujesz z niego jak z dysku.
- Projekt `.fcproj` przychodzi do FilmCraft zdarzeniem `filmcraft:open`. Ścieżki mediów w projekcie
  to `/files/<ścieżka na serwerze>`, więc po ponownym otwarciu wszystko się odnajduje.
- Każdy zapis (`⌘S`, Zapisz jako, eksport wideo/audio, napisy, AAF/EDL…) przychodzi jako
  `filmcraft:save` i trafia na serwer: projekt na swoje miejsce, eksporty do `exports/` obok
  projektu.
- Media przeciągnięte z dysku (albo „Prześlij media”) są najpierw wysyłane do folderu projektu,
  potem importowane z serwera — projekt nigdy nie wskazuje na pliki z czyjegoś komputera.
- Kilka osób, wspólne pliki: otwarty projekt dostaje miękką blokadę („edytuje: Ola”), a zapis jest
  warunkowy (`If-Match`). Jeśli ktoś inny zapisał w międzyczasie, Twoja wersja zapisze się jako
  kopia — nikt nikomu nie nadpisze pracy.
- Usuwanie przenosi do `/data/trash`, nie kasuje.

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Przykład | |
|---|---|---|
| `ORIGIN` | `https://filmcraft.rys.network` | adres, pod którym ludzie otwierają aplikację (bez `/` na końcu) |
| `RP_ID` | `filmcraft.rys.network` | domena passkeys; domyślnie host z `ORIGIN`. **Zmiana = ponowna rejestracja passkeys** |
| `SETUP_TOKEN` | długi losowy ciąg (sekret) | potrzebny tylko do utworzenia pierwszego admina |
| `DATA_DIR` | `/data` | baza i pliki (wolumen) |
| `SESSION_DAYS` | `30` | ważność sesji (przesuwana przy używaniu) |
| `INVITE_HOURS` | `24` | ważność linku z zaproszeniem |

Passkeys wymagają HTTPS (wyjątek: `http://localhost`).

## Pierwsze uruchomienie

1. Otwórz `https://filmcraft.rys.network/setup#<SETUP_TOKEN>` (token we fragmencie `#` nie trafia
   do logów), podaj imię, zarejestruj passkey — to konto administratora.
2. **Konto → Utwórz link z zaproszeniem** i wyślij link osobie, która ma mieć dostęp. Link jest
   jednorazowy. Zaproszona osoba podaje imię i rejestruje swój passkey.
3. Na każdym kolejnym urządzeniu: zaloguj się tam, gdzie passkey już jest (np. telefonem przez kod
   QR), i dodaj nowy w **Konto → Dodaj passkey**.

Admin może odebrać dostęp (usuwa passkeys i sesje tej osoby). Pliki zostają.

## Lokalnie

```sh
cargo xtask web                                   # build FilmCraft → target/web/dist
cd deploy/barley/server && npm install
SETUP_TOKEN=dev DATA_DIR=/tmp/fc-data npm start   # http://localhost:3000/setup#dev
npm test                                          # testy serwera z programowym passkeyem
```

albo cały obraz: `SETUP_TOKEN=dev docker compose -f deploy/barley/compose.yaml up --build`.

## Aktualizacja FilmCraft z upstreamu

```sh
git fetch upstream
git rebase upstream/main        # na gałęzi barley
git push --force-with-lease origin barley
```

Zmiany poza `deploy/barley/` są małe: `apps/filmcraft-web/src/{fs,api,import,mountpath}.rs`
(montowanie plików po URL) i ich test. Po rebase sprawdź `cargo test -p filmcraft-web` i
`cargo check -p filmcraft-web --target wasm32-unknown-unknown`.

## Ograniczenia

- Wersja webowa FilmCraft działa w jednym wątku (ograniczenie upstreamu): render previews, proxy i
  Project Manager są niedostępne w przeglądarce.
- Eksport powstaje w pamięci przeglądarki i dopiero potem jest wysyłany na serwer — bardzo długie
  eksporty w wysokiej jakości potrzebują dużo RAM po stronie przeglądarki.
- FilmCraft czyta projekt w całości (limit 256 MiB na plik `.fcproj`).
