// fb-sync :: Worker entrypoint.
// Wyszukuje profile trenerów przez Google CSE, matchuje do leadów, admin zatwierdza.

import { searchGoogle } from "./google";
import { findMatchingLeads } from "./match";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ADMIN_SECRET: string;
  SERPER_API_KEY: string;
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

        // POST /admin/search — wyszukaj profile w Google i zapisz wyniki
        // ?city=Warszawa&source=facebook&limit=10
        case "POST /admin/search": {
          const city = url.searchParams.get("city");
          const source = url.searchParams.get("source") ?? "facebook";
          const limit = Math.min(
            parseInt(url.searchParams.get("limit") ?? "10", 10),
            50,
          );

          // Pobierz leady bez profili dla danego źródła
          const leadsQuery = city
            ? `SELECT l.nip, l.first_name, l.last_name, c.name AS city
               FROM leads l
               LEFT JOIN cities c ON c.id = l.city_id
               LEFT JOIN external_urls eu ON eu.nip = l.nip AND eu.source = ?3
               WHERE c.name = ?1 AND eu.id IS NULL AND l.opted_out_at IS NULL
               LIMIT ?2`
            : `SELECT l.nip, l.first_name, l.last_name, c.name AS city
               FROM leads l
               LEFT JOIN cities c ON c.id = l.city_id
               LEFT JOIN external_urls eu ON eu.nip = l.nip AND eu.source = ?2
               WHERE eu.id IS NULL AND l.opted_out_at IS NULL
               LIMIT ?1`;

          const stmt = city
            ? env.DB.prepare(leadsQuery).bind(city, limit, source)
            : env.DB.prepare(leadsQuery).bind(limit, source);

          const { results: leads } = await stmt.all<{
            nip: string;
            first_name: string;
            last_name: string;
            city: string | null;
          }>();

          if (leads.length === 0) {
            return json({ message: "no leads without profiles", searched: 0 });
          }

          const siteMap: Record<string, string> = {
            facebook: "site:facebook.com",
            instagram: "site:instagram.com",
            youtube: "site:youtube.com",
            tiktok: "site:tiktok.com",
            pinterest: "site:pinterest.com",
          };
          const siteFilter = siteMap[source] ?? "";

          let totalFound = 0;
          let totalMatched = 0;
          const searchResults: Array<{
            lead: string;
            query: string;
            found: number;
            matched: number;
          }> = [];

          for (const lead of leads) {
            const query = `${siteFilter} "${lead.first_name} ${lead.last_name}" "trener" "${lead.city ?? ""}"`;

            const results = await searchGoogle(query, env.SERPER_API_KEY);
            let matched = 0;

            for (const result of results) {
              // Sprawdź czy URL już jest w bazie
              const existing = await env.DB.prepare(
                `SELECT id FROM external_urls WHERE url = ?1`,
              ).bind(result.url).first();

              if (existing) continue;

              // Auto-match: sprawdź czy tytuł/snippet pasuje do tego leada
              const candidates = await findMatchingLeads(env.DB, result.title, result.snippet);
              const directMatch = candidates.find((c) => c.nip === lead.nip);

              await env.DB.prepare(
                `INSERT INTO external_urls (url, source, og_title, og_description, nip, score, fetched_at, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
              ).bind(
                result.url,
                result.source,
                result.title,
                result.snippet,
                directMatch ? lead.nip : null,
                directMatch?.score ?? 0,
                Date.now(),
                directMatch ? "suggested" : "unmatched",
              ).run();

              matched++;
            }

            totalFound += results.length;
            totalMatched += matched;
            searchResults.push({
              lead: `${lead.first_name} ${lead.last_name}`,
              query,
              found: results.length,
              matched,
            });
          }

          return json({
            searched: leads.length,
            totalFound,
            totalNew: totalMatched,
            results: searchResults,
          });
        }

        // GET /admin/pending — lista profili do zatwierdzenia
        // ?status=suggested&limit=50
        case "GET /admin/pending": {
          const status = url.searchParams.get("status") ?? "suggested";
          const limit = Math.min(
            parseInt(url.searchParams.get("limit") ?? "50", 10),
            200,
          );

          const { results } = await env.DB.prepare(
            `SELECT eu.id, eu.url, eu.source, eu.og_title, eu.og_description,
                    eu.score, eu.status, eu.nip,
                    l.first_name, l.last_name, c.name AS city
             FROM external_urls eu
             LEFT JOIN leads l ON l.nip = eu.nip
             LEFT JOIN cities c ON c.id = l.city_id
             WHERE eu.status = ?1
             ORDER BY eu.score DESC
             LIMIT ?2`,
          ).bind(status, limit).all();

          return json({ count: results.length, profiles: results });
        }

        // POST /admin/approve/:id — zatwierdź profil
        case url.pathname.startsWith("/admin/approve/") ? `POST ${url.pathname}` : "": {
          const id = parseInt(url.pathname.split("/").pop()!, 10);
          if (isNaN(id)) return json({ error: "invalid id" }, 400);

          await env.DB.prepare(
            `UPDATE external_urls SET status = 'approved', matched_at = ?1 WHERE id = ?2`,
          ).bind(Date.now(), id).run();

          return json({ ok: true, id, status: "approved" });
        }

        // POST /admin/reject/:id — odrzuć profil
        case url.pathname.startsWith("/admin/reject/") ? `POST ${url.pathname}` : "": {
          const id = parseInt(url.pathname.split("/").pop()!, 10);
          if (isNaN(id)) return json({ error: "invalid id" }, 400);

          await env.DB.prepare(
            `UPDATE external_urls SET status = 'rejected' WHERE id = ?1`,
          ).bind(id).run();

          return json({ ok: true, id, status: "rejected" });
        }

        // POST /admin/assign/:id — ręcznie przypisz profil do NIP-a
        // Body: { nip: "1234567890" }
        case url.pathname.startsWith("/admin/assign/") ? `POST ${url.pathname}` : "": {
          const id = parseInt(url.pathname.split("/").pop()!, 10);
          if (isNaN(id)) return json({ error: "invalid id" }, 400);

          const body = await req.json<{ nip: string }>();
          if (!body.nip) return json({ error: "nip required" }, 400);

          await env.DB.prepare(
            `UPDATE external_urls SET nip = ?1, status = 'approved', matched_at = ?2 WHERE id = ?3`,
          ).bind(body.nip, Date.now(), id).run();

          return json({ ok: true, id, nip: body.nip, status: "approved" });
        }

        // GET /admin/stats — statystyki
        case "GET /admin/stats": {
          const { results } = await env.DB.prepare(
            `SELECT status, COUNT(*) as count FROM external_urls GROUP BY status`,
          ).all<{ status: string; count: number }>();

          const bySource = await env.DB.prepare(
            `SELECT source, COUNT(*) as count FROM external_urls GROUP BY source`,
          ).all<{ source: string; count: number }>();

          return json({ byStatus: results, bySource: bySource.results });
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
