// ceidg-sync :: Worker entrypoint.
// Stuby endpointów — logika claim/opt-out dochodzi w kolejnym kroku.

import { CeidgRateLimited, CeidgError } from "./ceidg";
import { syncChunk, syncFull, logEvent } from "./leads";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  CEIDG_TOKEN: string;
  GITHUB_TOKEN: string;
  ADMIN_SECRET: string;
  /** Opcjonalne — CSV kodów PKD. Domyślnie zestaw trenerski w leads.ts. */
  PKD_CODES?: string;
}

// Lock key dla /admin/sync — zapobiega równoległym runom przy double-kliknięciu.
const SYNC_LOCK_KEY = "sync:lock";
const SYNC_LOCK_TTL_SEC = 120;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    try {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /health":
          return json({ ok: true });

        case "POST /admin/sync": {
          if (req.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
            return json({ error: "unauthorized" }, 401);
          }
          // Lock przez KV z TTL — zapobiega double-runom. KV eventual consistency
          // znaczy że lock nie jest 100% szczelny, ale dla ręcznego /admin/sync
          // wystarcza (bo blast radius to co najwyżej 2× zużycie CEIDG quota).
          const lock = await env.CACHE.get(SYNC_LOCK_KEY);
          if (lock !== null) {
            return json(
              { error: "sync_in_progress", message: "Poprzedni run jeszcze trwa." },
              429,
            );
          }
          await env.CACHE.put(SYNC_LOCK_KEY, String(Date.now()), {
            expirationTtl: SYNC_LOCK_TTL_SEC,
          });

          // ?full=1 → pełny przebieg (pętla chunków aż kursor się owinie).
          // bez flagi → jeden chunk (taki sam jak cron). Full może trwać
          // >30s, więc na free-planie ryzykuje timeout; użyć z paid planem
          // albo wołać wielokrotnie bez ?full=1.
          const full = url.searchParams.get("full") === "1";
          const start = Date.now();
          try {
            if (full) {
              const result = await syncFull(env.DB, env.CACHE, env.CEIDG_TOKEN, env);
              logEvent("info", "admin_sync_full_done", {
                durationMs: Date.now() - start,
                completed: result.completed,
                totalUpserted: result.totalUpserted,
              });
              return json({ ...result, durationMs: Date.now() - start });
            }
            const stats = await syncChunk(env.DB, env.CACHE, env.CEIDG_TOKEN, env);
            logEvent("info", "admin_sync_chunk_done", {
              durationMs: Date.now() - start,
              totalUpserted: stats.totalUpserted,
              errors: stats.errors,
            });
            return json({ ...stats, durationMs: Date.now() - start });
          } finally {
            await env.CACHE.delete(SYNC_LOCK_KEY);
          }
        }

        case "GET /admin/leads": {
          if (req.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
            return json({ error: "unauthorized" }, 401);
          }
          const city = url.searchParams.get("city");
          const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
          // JOIN cities żeby zwrócić nazwę miasta. PKD-y agregujemy per firma
          // przez GROUP_CONCAT z lead_pkd (SQLite zwraca "9604Z,8551Z,...").
          // LEFT JOIN cities — rekordy bez adresu w CEIDG mają city_id = NULL.
          const baseSelect = `
            SELECT l.nip, l.first_name, l.last_name, c.name AS city, l.company_name,
                   GROUP_CONCAT(lp.pkd) AS pkd, l.slug, l.claimed, l.github_repo, l.opted_out_at
            FROM leads l
            LEFT JOIN cities c ON c.id = l.city_id
            LEFT JOIN lead_pkd lp ON lp.nip = l.nip
          `;
          const stmt = city
            ? env.DB
                .prepare(
                  baseSelect +
                    " WHERE c.name = ?1 GROUP BY l.nip ORDER BY l.last_name LIMIT ?2",
                )
                .bind(city, limit)
            : env.DB
                .prepare(
                  baseSelect +
                    " GROUP BY l.nip ORDER BY c.name, l.last_name LIMIT ?1",
                )
                .bind(limit);
          const { results } = await stmt.all();
          return json({ count: results.length, leads: results });
        }


        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (err instanceof CeidgRateLimited) {
        return json(
          { error: "ceidg rate limited", retry_after: err.retryAfterSec },
          503,
          { "Retry-After": String(err.retryAfterSec) },
        );
      }
      if (err instanceof CeidgError) {
        return json({ error: "ceidg upstream", status: err.status }, 502);
      }
      console.error("unhandled", err);
      return json({ error: "internal" }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const start = Date.now();
    try {
      const stats = await syncChunk(env.DB, env.CACHE, env.CEIDG_TOKEN, env);
      logEvent("info", "cron_sync_done", {
        durationMs: Date.now() - start,
        totalUpserted: stats.totalUpserted,
        totalFetched: stats.totalFetched,
        errors: stats.errors,
        callsUsed: stats.callsUsed,
      });
    } catch (err) {
      logEvent("error", "cron_sync_failed", { err: String(err) });
    }
  },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
