# NEXT-STEPS — roadmap

> Stan na 2026-04-10 (sesja 5). Landing na Hono działa z theme-specialist-glossy@0.4.0. Design system jest framework-agnostic.

## Co jest gotowe

- **ceidg-sync** — Worker + D1 + KV, cron sync z CEIDG, ~4500 leadów
- **landing** — Hono SSR z `@press2ai/theme-specialist-glossy/templates`, specialist.css inline, live na CF Workers
- **theme-specialist-glossy 0.4.0** — pure template functions (layout, hero, profileCard, profileArticle) + thin Astro wrappers, jeden CSS
- **opt-out** — formularz + D1 update, partial unique index

## Roadmap

### Faza 1 — claim flow (NASTĘPNA)

| Zadanie | Opis |
|---|---|
| `POST /claim` | Trener przejmuje wpis. Ścieżka 1: magic link na email z CEIDG. Ścieżka 2: weryfikacja 5 pól (NIP + imię + nazwisko + firma + REGON) |
| GitHub integration | Po claim: stworzenie repo `profile-{slug}` z template, commit `profile.json`, dodanie topica, włączenie Pages |
| `profile-template` repo | Stworzyć od zera w org `otwarty-trener` — baza do `gh api /generate` |
| Rate limit | 3 próby/IP/godzinę/NIP (KV) |

### Faza 2 — production hardening

| Zadanie | Opis |
|---|---|
| KV cache | Cache listy leadów i catalog.json na 5 min (KV CACHE już zbindowany, nieużywany) |
| Własna domena | `otwartytrener.pl` → CF Workers (custom domain w wrangler.toml) |
| Skalowanie sync | Paginacja resumowalna (last_page per PKD w D1) — teraz ~4500, docelowo 10-15k |
| RODO | Polityka prywatności na landingu, footer z linkiem opt-out |
| Wrangler v4 | Update z v3 (deprecation warnings) |

### Faza 3 — growth

| Zadanie | Opis |
|---|---|
| Wyszukiwarka | Filtr po mieście, PKD, nazwisku |
| SEO | Meta descriptions per profil, Open Graph images |
| AI endpoints | MCP-style actions w ai-profile manifest (v0.5.0 theme-specialist-glossy) |
| Nowe warianty | `theme-specialist-stripe` (korporacyjny), `theme-specialist-brutalist` (surowy) — wymienne shelle, ten sam HTML contract |
| `npm create press2ai` | Scaffold nowego profilu jednym poleceniem |

## Ostrzeżenia operacyjne

- **CEIDG token JWT zawiera PESEL w payloadzie** — nigdy nie loguj/commituj. Bezpieczne: `.dev.vars` + `wrangler secret put`
- **CEIDG v3:** PKD bez kropek (`9604Z`), limit max 25, single fetch po NIP = `/firmy?nip=` (nie `/firma?nip=`)
- **Po npm publish** poczekaj ~30s zanim `npm install` nowej wersji (registry propagation)
- **Przy bumpie theme-specialist-glossy** aktualizuj 3 miejsca: `package.json`, `layout.ts` (`THEME_VERSION`), `ai.ts` (`version`)
- **Nie używaj `rm -rf` w łańcuchach `&&`** — poprzednia instancja zniszczyła folder roboczy

## Mapowanie CEIDG → Profile

| CEIDG | D1 leads | profile.json |
|---|---|---|
| `wlasciciel.imie` | `first_name` | `firstName` |
| `wlasciciel.nazwisko` | `last_name` | `lastName` |
| `wlasciciel.nip` | `nip` (PK) | `business.taxId` |
| `nazwa` | `company_name` | `business.name` |
| `adresDzialalnosci.miasto` | `city` | `city` |

## Konta

- **Cloudflare:** `gotoreadyai`
- **GitHub org:** `otwarty-trener`
- **npm:** `dadmor`, org `@press2ai`
