// fb-sync :: Worker entrypoint.
// Zbiera publiczne profile FB trenerów, klasyfikuje i dopasowuje do leadów w D1.

import { fetchFbPage, type FbPageData } from "./facebook";
import { findMatchingLeads, extractCityFromFb } from "./match";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ADMIN_SECRET: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /health":
          return json({ ok: true });

        // POST /admin/add-urls — dodaj URLe do kolejki
        // Body: { urls: ["https://facebook.com/...", "https://instagram.com/...", ...] }
        case "POST /admin/add-urls": {
          const body = await req.json<{ urls: string[] }>();
          if (!Array.isArray(body.urls) || body.urls.length === 0) {
            return json({ error: "urls array required" }, 400);
          }
          if (body.urls.length > 100) {
            return json({ error: "max 100 urls per request" }, 400);
          }

          let added = 0;
          let skipped = 0;
          for (const rawUrl of body.urls) {
            const source = detectSource(rawUrl);
            if (!source) {
              skipped++;
              continue;
            }
            try {
              await env.DB.prepare(
                `INSERT OR IGNORE INTO external_urls (url, source, fetched_at, status)
                 VALUES (?1, ?2, ?3, 'pending')`,
              ).bind(rawUrl, source, Date.now()).run();
              added++;
            } catch {
              skipped++;
            }
          }
          return json({ added, skipped, total: body.urls.length });
        }

        // POST /admin/fetch-pending — pobierz dane z FB dla pending profili
        // ?limit=10 (domyślnie 10, max 50)
        case "POST /admin/fetch-pending": {
          const limit = Math.min(
            parseInt(url.searchParams.get("limit") ?? "10", 10),
            50,
          );

          const { results: pending } = await env.DB.prepare(
            `SELECT id, url, source FROM external_urls
             WHERE status = 'pending'
             ORDER BY id ASC LIMIT ?1`,
          ).bind(limit).all<{ id: number; url: string; source: string }>();

          if (pending.length === 0) {
            return json({ message: "no pending profiles", processed: 0 });
          }

          const results: Array<{ id: number; url: string; source: string; score: number }> = [];

          for (const row of pending) {
            const data = await fetchFbPage(row.url);

            await env.DB.prepare(
              `UPDATE external_urls SET
                 og_title = ?1, og_description = ?2, og_image = ?3,
                 category = ?4, page_type = ?5,
                 has_phone = ?6, has_email = ?7, has_website = ?8,
                 score = ?9, fetched_at = ?10, status = 'fetched'
               WHERE id = ?11`,
            ).bind(
              data.ogTitle, data.ogDescription, data.ogImage,
              data.category, data.pageType,
              data.hasPhone ? 1 : 0, data.hasEmail ? 1 : 0, data.hasWebsite ? 1 : 0,
              data.score, Date.now(), row.id,
            ).run();

            results.push({ id: row.id, url: row.url, source: row.source, score: data.score });
          }

          return json({ processed: results.length, results });
        }

        // POST /admin/match — dopasuj pobrane profile do leadów
        case "POST /admin/match": {
          const { results: fetched } = await env.DB.prepare(
            `SELECT id, url, source, og_title, og_description
             FROM external_urls
             WHERE status = 'fetched' AND nip IS NULL
             ORDER BY score DESC LIMIT 50`,
          ).all<{
            id: number;
            url: string;
            source: string;
            og_title: string | null;
            og_description: string | null;
          }>();

          if (fetched.length === 0) {
            return json({ message: "no unmatched profiles", matched: 0 });
          }

          let matched = 0;
          let unmatched = 0;
          const matchResults: Array<{
            url: string;
            source: string;
            matchedNip: string | null;
            matchedName: string | null;
          }> = [];

          for (const row of fetched) {
            const city = extractCityFromFb(row.og_description);
            const leads = await findMatchingLeads(
              env.DB, row.og_title, row.og_description, city,
            );

            if (leads.length === 1) {
              await env.DB.prepare(
                `UPDATE external_urls SET nip = ?1, matched_at = ?2, status = 'matched'
                 WHERE id = ?3`,
              ).bind(leads[0].nip, Date.now(), row.id).run();
              matched++;
              matchResults.push({
                url: row.url,
                source: row.source,
                matchedNip: leads[0].nip,
                matchedName: `${leads[0].firstName} ${leads[0].lastName}`,
              });
            } else {
              unmatched++;
              matchResults.push({
                url: row.url,
                source: row.source,
                matchedNip: null,
                matchedName: leads.length > 1
                  ? `ambiguous (${leads.length} candidates)`
                  : null,
              });
            }
          }

          return json({ matched, unmatched, results: matchResults });
        }

        // GET /admin/profiles — lista zewnętrznych URLi z filtrami
        // ?status=fetched&source=facebook&min_score=30&limit=50
        case "GET /admin/profiles": {
          const status = url.searchParams.get("status");
          const source = url.searchParams.get("source");
          const minScore = parseInt(url.searchParams.get("min_score") ?? "0", 10);
          const limit = Math.min(
            parseInt(url.searchParams.get("limit") ?? "50", 10),
            200,
          );

          let query = `
            SELECT eu.*, l.first_name, l.last_name, c.name AS city
            FROM external_urls eu
            LEFT JOIN leads l ON l.nip = eu.nip
            LEFT JOIN cities c ON c.id = l.city_id
            WHERE eu.score >= ?1
          `;
          const bindings: unknown[] = [minScore];

          if (status) {
            query += ` AND eu.status = ?${bindings.length + 1}`;
            bindings.push(status);
          }
          if (source) {
            query += ` AND eu.source = ?${bindings.length + 1}`;
            bindings.push(source);
          }

          query += ` ORDER BY eu.score DESC LIMIT ?${bindings.length + 1}`;
          bindings.push(limit);

          const stmt = env.DB.prepare(query);
          const { results } = await stmt.bind(...bindings).all();
          return json({ count: results.length, profiles: results });
        }

        // POST /admin/generate-queries — generuj zapytania Google do wyszukiwania
        // ?city=Warszawa&source=facebook (domyślnie facebook)
        case "POST /admin/generate-queries": {
          const city = url.searchParams.get("city");
          const source = url.searchParams.get("source") ?? "facebook";
          const limit = Math.min(
            parseInt(url.searchParams.get("limit") ?? "50", 10),
            200,
          );

          const siteMap: Record<string, string> = {
            facebook: "site:facebook.com",
            instagram: "site:instagram.com",
            youtube: "site:youtube.com",
            tiktok: "site:tiktok.com",
            pinterest: "site:pinterest.com",
          };
          const siteFilter = siteMap[source] ?? `site:${source}`;

          const query = city
            ? `SELECT l.first_name, l.last_name, c.name AS city
               FROM leads l
               LEFT JOIN cities c ON c.id = l.city_id
               LEFT JOIN external_urls eu ON eu.nip = l.nip AND eu.source = ?3
               WHERE c.name = ?1 AND eu.id IS NULL AND l.opted_out_at IS NULL
               LIMIT ?2`
            : `SELECT l.first_name, l.last_name, c.name AS city
               FROM leads l
               LEFT JOIN cities c ON c.id = l.city_id
               LEFT JOIN external_urls eu ON eu.nip = l.nip AND eu.source = ?2
               WHERE eu.id IS NULL AND l.opted_out_at IS NULL
               LIMIT ?1`;

          const stmt = city
            ? env.DB.prepare(query).bind(city, limit, source)
            : env.DB.prepare(query).bind(limit, source);

          const { results } = await stmt.all<{
            first_name: string;
            last_name: string;
            city: string | null;
          }>();

          const queries = results.map((r) => ({
            query: `${siteFilter} "${r.first_name} ${r.last_name}" "trener" "${r.city ?? ""}"`,
            name: `${r.first_name} ${r.last_name}`,
            city: r.city,
          }));

          return json({ count: queries.length, queries });
        }

        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      console.error("unhandled", err);
      return json({ error: "internal", message: String(err) }, 500);
    }
  },
};

/** Rozpoznaje źródło po URL. Zwraca null jeśli nie obsługiwany. */
function detectSource(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.includes("facebook.com") || host.includes("fb.com")) return "facebook";
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    if (host.includes("tiktok.com")) return "tiktok";
    if (host.includes("pinterest.com") || host.includes("pin.it")) return "pinterest";
    if (host.includes("google.com") && rawUrl.includes("/maps")) return "google_maps";
    // Dowolna strona www
    return "website";
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
