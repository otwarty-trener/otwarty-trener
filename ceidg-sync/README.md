# ceidg-sync

Cloudflare Worker + D1: synchronizuje dane z CEIDG do bazy leadów i obsługuje
flow claim / opt-out dla profili trenerów.

## Architektura w pigułce

- **D1** (`ceidg-leads`) — 3 tabele:
  - `leads` — jeden rekord per NIP, `city_id` nullable (niektóre firmy nie ujawniają adresu)
  - `cities` — znormalizowane miasta (`id`, `name UNIQUE`)
  - `lead_pkd` — relacja many-to-many firma↔PKD (PK composite `(nip, pkd)`)
  - Migracje: `0001_init.sql`, `0002_normalize.sql`, `0003_nullable_city.sql`
- **KV** (`CACHE`) — cache `fetchByNip` (TTL 1h), lock dla `/admin/sync` (TTL 120s). Sync listowy **pomija cache** (`bypassCache`) — przy cronie hourly cache i tak ma 0% hit rate, a KV free ma twardy limit 1000 writes/dobę.
- **Cron** — co godzinę (`0 * * * *`). Każdy tick pobiera 15 stron × 25 firm = ~375 rekordów, upsert do D1. Offset paginacji wyliczany z `SELECT COUNT(DISTINCT nip) FROM lead_pkd WHERE pkd=?` (stan żyje w D1, nie w KV).
- **Filtr PKD** — z env `PKD_CODES` (CSV) w `wrangler.toml`, fallback na zestaw trenerski w `src/leads.ts`.
- **Logi** — strukturalne JSON (`logEvent`), czytelne przez `wrangler tail` / Logpush.
- **HTTP**:
  - `GET  /health` — ping
  - `POST /admin/sync` — jeden chunk syncu (gated `X-Admin-Secret`, KV lock przeciw double-run)
  - `POST /admin/sync?full=1` — pełny przebieg (pętla chunków, ryzyko 30s CPU timeout na free)
  - `GET  /admin/leads?city=&limit=` — lista z JOIN-em `cities` i `GROUP_CONCAT(pkd)`
  - `POST /claim` — **wyłączone (503)**, czeka na KYC (decyzja 2026-04-09)
  - `POST /opt-out` — stub 501 (1 IP = 1 opt-out, partial unique index już w schemie)

## Setup (deploy na Cloudflare od razu, bez lokalnej bazy)

Wymagania: konto Cloudflare (free tier wystarczy), token CEIDG, GitHub PAT
ze scope `repo` (PAT może być pusty na start — `/health` go nie używa).

```bash
cd ceidg-sync

# 1. instalacja
npm install

# 2. login do Cloudflare (otworzy przeglądarkę)
npx wrangler login

# 3. stwórz D1 — output zawiera linijkę z database_id (UUID)
npm run db:create
#    → SKOPIUJ database_id i WKLEJ do wrangler.toml: [[d1_databases]] database_id

# 4. stwórz KV namespace — output zawiera linijkę z id
npm run kv:create
#    → SKOPIUJ id i WKLEJ do wrangler.toml: [[kv_namespaces]] id

# 5. wjedź migracjami na zdalną D1 (stosuje 0001_init, 0002_normalize, 0003_nullable_city)
npm run db:migrate:remote

# 6. wgraj sekrety (interaktywnie wkleisz wartości)
npx wrangler secret put CEIDG_TOKEN
npx wrangler secret put GITHUB_TOKEN
# ADMIN_SECRET wygeneruj losowo i zapamiętaj — bez tego /admin/sync jest 401:
openssl rand -base64 32 | npx wrangler secret put ADMIN_SECRET

# 7. (opcjonalnie) podmień zestaw PKD w wrangler.toml [vars] PKD_CODES
#    Domyślnie: "96.04.Z,85.51.Z,93.13.Z" (trener fitness/sport/rekreacja).
#    Zmiana wymaga tylko redeploya, nie rebuilda kodu.

# 8. deploy
npm run deploy
#    → dostajesz URL typu https://ceidg-sync.<subdomain>.workers.dev

# 8. test
curl https://ceidg-sync.<subdomain>.workers.dev/health
```

### Lokalny dev (opcjonalnie)

```bash
cp .dev.vars.example .dev.vars   # wklej tokeny do .dev.vars (gitignored)
npm run db:migrate:local         # lokalna kopia D1 w .wrangler/
npm run dev                      # http://localhost:8787
```

### Ręczne odpalenie syncu CEIDG → D1

Najprostsza ścieżka — endpoint `POST /admin/sync` chroniony headerem
`X-Admin-Secret`. Zwraca JSON ze statystykami uruchomienia (`fetched`,
`matched`, `upserted`, `errors`, `pages`, `durationMs`).

```bash
# Produkcja
curl -X POST https://ceidg-sync.gotoreadyai.workers.dev/admin/sync \
  -H "X-Admin-Secret: $(grep ^ADMIN_SECRET .dev.vars | cut -d= -f2-)"

# Lokalnie (npm run dev)
curl -X POST http://localhost:8787/admin/sync \
  -H "X-Admin-Secret: $(grep ^ADMIN_SECRET .dev.vars | cut -d= -f2-)"
```

Alternatywne ścieżki (jeśli kiedyś `/admin/sync` zniknie albo trzeba
przetestować właśnie crona):

```bash
# Lokalnie — emulacja crona
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+3+*+*+1"

# Produkcja — wymuszenie z dashboardu CF
# https://dash.cloudflare.com → Workers → ceidg-sync → Triggers → "Trigger"

# Live logi (przyda się przy każdym z powyższych)
npx wrangler tail
```

## Zasady projektowe

- **Email, telefon, REGON nie lądują w D1** (na razie). Live call do CEIDG przy każdej weryfikacji (cache 1h w KV ogranicza ruch). Masowe ściąganie emaili wymagałoby: (a) podstawy prawnej z art. 6 ust. 1 lit. f RODO, (b) obowiązku informacyjnego z art. 14 RODO przed/w ciągu miesiąca od pozyskania, (c) sprawnego `/opt-out`. Bez tego — nie ruszamy.
- **`claim` wymaga proof-of-identity.** Obecny 503. Publiczne pola CEIDG (imię+nazwisko+NIP+nazwa firmy+REGON) nie weryfikują tożsamości; każda osoba z listą CEIDG mogłaby sclaimować dowolnego trenera. Do czasu wdrożenia realnego KYC — endpoint nieaktywny. (Zob. komentarz przy handlerze w `src/index.ts`.)
- **`opted_out_at` + `opted_out_ip` + `opted_out_ua`** — audit RODO bez osobnej tabeli logów. Partial unique index egzekwuje 1 IP = 1 opt-out.
- **`claimed=1` ⟹ repo na GitHubie istnieje.** GitHub jest źródłem prawdy dla zaakceptowanych profili; D1 jest źródłem prawdy dla nie-zaakceptowanych leadów.
- **429 z CEIDG** → Worker zwraca 503 z nagłówkiem `Retry-After` (przepuszczamy sygnał ratelimit dalej zamiast go ukrywać).
- **Slug = `imie-nazwisko-nip`** — NIP gwarantuje unikalność, jest publiczny w CEIDG. URL-e typu `/trener/jan-kowalski-1234567890` są brzydkie ale deterministyczne i kolizyjnie bezpieczne.
- **Sync jest stateless na Worker side.** Stan (offset per PKD) żyje wyłącznie w D1, kursor wylicza się z `COUNT`. Reset bazy = reset syncu bez dotykania KV.

## Limity (CEIDG v3)

- **50 requestów / 3 min** — przekroczenie: 180s cooldown
- **1000 requestów / 60 min**
- `limit` na `/firmy` — twardy sufit = **25** (wyżej → HTTP 400)
- Format PKD — **bez kropek** (`9604Z`, nie `96.04.Z`); `listByPkd` strippuje kropki automatycznie
- `/firmy` (list) zwraca tylko: `id, nazwa, adresDzialalnosci, wlasciciel, dataRozpoczecia, status, link`. Email/telefon/www — tylko w `/firma/{id}` (detail)

Nasze użycie przy cronie hourly: 15 calls/h = 1.5% limitu godzinowego, ~360/dobę. Seed 82k firm w jednym PKD ≈ 5–6 dni.

## Znane ograniczenia

- **`lead_pkd` ma tylko jedno PKD per firma** — to po którym została zlistowana pierwszy raz, choć CEIDG zwraca tablicę wszystkich kodów dla firmy. Pełna lista wymaga dodatkowego calla `/firma/{id}`. Do wdrożenia wraz z backfillerem detalu (gdy będzie potrzeba email/telefon na claim flow).
- **Catch-up nowych firm** — jeśli CEIDG wstawia nowe rejestracje w środku domyślnego porządku (a nie na końcu), niektóre nowe rekordy zostaną pominięte aż do manualnego resetu. Nie zweryfikowane empirycznie. Niski priorytet dopóki seed historii jest w toku.
- **Firmy bez `adresDzialalnosci`** — trafiają do `leads` z `city_id = NULL`. Publiczna lista filtruje `WHERE city_id IS NOT NULL`. Nie podstawiamy `adresKorespondencyjny` jako fallback (to zwykle adres domowy, łamałoby intencję przedsiębiorcy).

## TODO (kolejny krok)

- [ ] Logika `POST /claim` — czeka na realne KYC (np. mObywatel, Veriff, Profil Zaufany)
- [ ] Logika `POST /opt-out` (insert opt-out, 409 przy duplikacie IP)
- [ ] Klient GitHub — tworzenie repo z templatki `otwarty-trener/profile-template`
- [ ] Tabela `lead_contact` + backfiller `/firma/{id}` (email, telefon, www) — **tylko po przygotowaniu noty informacyjnej RODO art. 14**
- [ ] Testy jednostkowe/integracyjne (Vitest + miniflare)
