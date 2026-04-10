# otwarty-trener-landing

Hono + Cloudflare Workers. Katalog i wizytówki trenerów z D1, stylowane przez `@press2ai/theme-specialist-glossy@0.4.0` (framework-agnostic templates).

**Live:** https://otwarty-trener-landing.gotoreadyai.workers.dev

## Stack

- **Hono** — routing + SSR
- **@press2ai/theme-specialist-glossy/templates** — `layout()`, `profileCard()`, `profileArticle()`
- **specialist.css** — inline w `<style>` (classless, ~11KB)
- **D1** `ceidg-leads` — shared z `ceidg-sync`
- **KV** `CACHE` — zarezerwowany (cache, rate-limit)

## Routes

| Route | What |
|---|---|
| `GET /` | Katalog (24/stronę, paginacja) |
| `GET /:slug` | Wizytówka. Jeśli `claimed` → 302 do GitHub Pages |
| `GET /catalog.json` | JSON API |
| `GET /llms.txt` | Katalog dla LLM |
| `GET /sitemap.xml` | Sitemap |
| `GET /opt-out` | Formularz sprzeciwu |
| `POST /opt-out` | Oznaczenie `opted_out_at` w D1 |
| `GET /health` | Health check |

## Dev / Deploy

```bash
npm install
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy
```

Bindings w `wrangler.toml` wskazują na tę samą D1 co `ceidg-sync`. Landing tylko czyta leads (+ update przy opt-out).
