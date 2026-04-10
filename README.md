# OTWARTY-TRENER

Otwarta baza trenerów personalnych w Polsce. Dane z CEIDG, bezpłatny dostęp.

**GitHub org:** [`otwarty-trener`](https://github.com/otwarty-trener) · **Live:** https://otwarty-trener-landing.gotoreadyai.workers.dev

## Repozytoria

| Folder | Opis | Hosting |
|---|---|---|
| `landing/` | Katalog trenerów (Hono SSR) | Cloudflare Workers |
| `ceidg-sync/` | Import danych z CEIDG (cron) | Cloudflare Workers |
| `fb-sync/` | Matching profili Facebook | Cloudflare Workers |

## Architektura

```
┌─────────────────────────────────────┐
│  CEIDG (rejestr publiczny)          │
└──────────────┬──────────────────────┘
               │ cron sync
               ▼
┌──────────────────────────┐     ┌────────────────────────┐
│  ceidg-sync (CF Worker)  │────▶│  D1: ceidg-leads       │
│  hourly cron, upsert     │     │  leads, cities, pkd    │
└──────────────────────────┘     └───────────┬────────────┘
                                             │ read
               ┌─────────────────────────────┤
               ▼                             ▼
┌──────────────────────┐     ┌──────────────────────────────┐
│  fb-sync (CF Worker) │     │  landing (CF Worker, Hono)   │
│  Facebook matching   │     │  composeCss + templates      │
└──────────────────────┘     │  SSR, katalog + wizytówki    │
                             └──────────┬───────────────────┘
                                        │ claimed → 302
                                        ▼
                             ┌──────────────────────────────┐
                             │  profile-{slug} (GH Pages)   │
                             │  Astro + theme components    │
                             └──────────────────────────────┘
```

## Design system

`@press2ai/theme-specialist-glossy@0.11.1` — classless CSS + pure template functions.

- **Hono:** `composeCss('hero', 'statBar', ...)` — składa CSS z użytych komponentów
- **Astro:** `import glossy.css` — pełny bundle
- **Bloki:** `catalogHero`, `catalogGrid`, `statBar`, `steps`, `profileCard`, `profileArticle`, `pagination`
- **Zero klas CSS** — selektory strukturalne (`section:has`, `[itemscope]`, `[aria-label]`)

## Endpointy

| Path | Opis |
|---|---|
| `/` | Katalog z wyszukiwarką |
| `/:slug` | Wizytówka trenera |
| `/zasady` | Zasady i prywatność |
| `/opt-out` | Usunięcie wpisu |
| `/catalog.json` | API (JSON) |
| `/llms.txt` | Pointer dla LLM crawlerów |
| `/sitemap.xml` | Sitemap |
