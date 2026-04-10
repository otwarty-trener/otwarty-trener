# OTWARTY-TRENER (workspace organizacji)

Lokalny workspace dla GitHub org [`otwarty-trener`](https://github.com/otwarty-trener).
**Każdy podfolder = jedno repo.** Workspace nie ma własnego gita.

## Repozytoria

| Folder | Hosting | Live |
|---|---|---|
| `landing/` | Cloudflare Workers (Hono) | https://otwarty-trener-landing.gotoreadyai.workers.dev |
| `ceidg-sync/` | Cloudflare Workers (cron) | https://ceidg-sync.gotoreadyai.workers.dev |

## Architektura

```
┌─────────────────────────────────────────────────────────┐
│  CEIDG (rejestr publiczny)                              │
└──────────────┬──────────────────────────────────────────┘
               │ cron sync
               ▼
┌──────────────────────────┐     ┌────────────────────────┐
│  ceidg-sync (CF Worker)  │────▶│  D1: ceidg-leads       │
│  hourly cron, upsert     │     │  leads, cities, pkd    │
└──────────────────────────┘     └───────────┬────────────┘
                                             │ read
                                             ▼
┌──────────────────────────────────────────────────────────┐
│  landing (CF Worker, Hono)                                        │
│  @press2ai/theme-specialist-glossy@0.4.0 templates (pure functions)│
│  specialist.css inline, SSR, katalog + wizytówki                  │
└──────────────────────┬───────────────────────────────────┘
                       │ claimed → 302
                       ▼
┌──────────────────────────────────────────────────────────┐
│  profile-{slug} (GitHub Pages, Astro)                             │
│  @press2ai/theme-specialist-glossy@0.4.0 Astro components         │
│  Ten sam CSS, ten sam design — zero rozjazdu                       │
└──────────────────────────────────────────────────────────┘
```

**Design system:** `@press2ai/theme-specialist-glossy` — classless CSS + pure template functions. Jeden pakiet, dwa frameworki (Hono + Astro), identyczny output HTML.

## Topic discovery

Każde repo profilu MUSI mieć GitHub topic **`otwarty-trener-profile`**:

```bash
gh api -X PUT repos/otwarty-trener/profile-X/topics -f names[]=otwarty-trener-profile
```
