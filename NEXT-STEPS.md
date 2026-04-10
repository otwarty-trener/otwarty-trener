# NEXT-STEPS — roadmap

> Stan na 2026-04-10. Landing na Hono z theme-specialist-glossy@0.11.9. Komponentowy CSS, blokowa architektura.

## Co jest gotowe

- **ceidg-sync** — Worker + D1 + KV, cron sync z CEIDG, ~6300 leadow, 1569 miast
- **landing** — Hono SSR z `composeCss()`, bloki (catalogHero, catalogGrid, statBar, steps), wyszukiwarka, paginacja
- **theme-specialist-glossy 0.11.9** — komponentowy CSS (12 modulow), `composeCss()` do skladania, classless, zero klas. Selektory scoped (profileCard do gridu, forms do form context). Profile article w Swiss design. Layout: main=container centered, komponenty nie overriduja main.
- **opt-out** — formularz + D1 update
- **KV cache** — catalog.json, llms.txt, sitemap.xml cachowane w KV (86400s TTL)
- **/zasady** — polityka prywatnosci, regulamin, RODO
- **fb-sync** — scaffold workera do matchowania profili Facebook

## Roadmap

### Faza 1 — claim flow (NASTEPNA)

| Zadanie | Opis |
|---|---|
| `POST /claim` | Trener przejmuje wpis. Sciezka 1: magic link na email. Sciezka 2: weryfikacja 5 pol (NIP + imie + nazwisko + firma + REGON) |
| GitHub integration | Po claim: repo `profile-{slug}` z template, commit `profile.json`, topic, Pages |
| Rate limit | 3 proby/IP/godzine/NIP (KV) |

### Faza 2 — production hardening

| Zadanie | Opis |
|---|---|
| Wlasna domena | `otwartytrener.pl` → CF Workers |
| Skalowanie sync | Paginacja resumowalna (last_page per PKD w D1) |
| Wrangler v4 | Update z v3 (deprecation warnings) |
| fb-sync deploy | Dokonczyc matching, deploy jako cron worker |

### Faza 3 — growth

| Zadanie | Opis |
|---|---|
| SEO | Meta descriptions per profil, Open Graph images |
| AI endpoints | MCP-style actions w ai-profile manifest |
| Nowe warianty theme | `theme-specialist-corporate`, `theme-specialist-brutalist` — wymienne shelle, ten sam HTML contract |
| `npm create press2ai` | Scaffold nowego profilu jednym poleceniem |

## Ostrzezenia operacyjne

- **CEIDG token JWT zawiera PESEL w payloadzie** — nigdy nie loguj/commituj. Bezpieczne: `.dev.vars` + `wrangler secret put`
- **CEIDG v3:** PKD bez kropek (`9604Z`), limit max 25, single fetch po NIP = `/firmy?nip=` (nie `/firma?nip=`)
- **Po npm publish** poczekaj ~30s zanim `npm install` nowej wersji (registry propagation). Jesli ETARGET: `npm cache clean --force` lub `--registry https://registry.npmjs.org`
- **Przy bumpie theme** aktualizuj 3 miejsca: `package.json`, `layout.ts` (`THEME_VERSION`), `ai.ts` (`version`)

## Konta

- **Cloudflare:** `gotoreadyai`
- **GitHub org:** `otwarty-trener`
- **npm:** `dadmor`, org `@press2ai`
