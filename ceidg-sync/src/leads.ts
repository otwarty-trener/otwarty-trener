// Synchronizacja CEIDG → D1.
//
// Stan syncu żyje w D1 (nie w KV): pozycja w paginacji wyliczana z
// `SELECT COUNT(*) FROM leads WHERE pkd=?`. Numer strony = floor(count/limit)+1.
//
// Dlaczego tak: CEIDG /firmy ma stabilny domyślny porządek (zweryfikowane
// empirycznie — dwa wywołania z tym samym ?pkd&page&limit zwracają te same
// NIP-y w tej samej kolejności). Limit strony jest twardy = 25. Upsert jest
// idempotentny po NIP, więc ewentualny drift (nowa firma wstawiona w środku
// zestawu przez CEIDG) co najwyżej powoduje jeden duplikat — nic nie ginie.
//
// Każdy tick przechodzi przez wszystkie PKD po kolei. Dla każdego PKD:
//   1) count = SELECT COUNT(*) WHERE pkd=?
//   2) page = floor(count / PAGE_LIMIT) + 1
//   3) fetch strony, upsert
//   4) jeśli batch < PAGE_LIMIT → ten PKD jest "wyseedowany do końca w tym tyku",
//      przechodzimy do następnego PKD
//   5) jeśli batch == PAGE_LIMIT → jeszcze jest więcej, ale budżet calls_per_tick
//      może już być wyczerpany — wtedy dokończymy w następnym tyku
//
// Gdy wszystkie PKD są wyseedowane (CEIDG zwraca pustą stronę od offsetu =
// count w D1), tick jest no-opem (3 calls × ~500ms) — czeka aż w CEIDG
// pojawią się nowe rekordy i cykl się podejmie.
//
// UWAGA: ten mechanizm zakłada że domyślny porządek CEIDG dopisuje nowe firmy
// na KOŃCU listy (czyli pod offsetem count). Jeśli CEIDG wstawia nowe firmy
// w środku (np. sortowanie alfabetyczne po nazwie), część nowych rekordów
// zostanie pominięta do czasu ręcznego resetu (DELETE FROM leads). Do czasu
// zweryfikowania tego empirycznie — to jest znane ograniczenie.

import { CeidgFirma, listByPkd } from "./ceidg";

const DEFAULT_PKD_CODES = ["96.04.Z", "85.51.Z", "93.13.Z"];

/**
 * Lista PKD do syncu — czytana z env var `PKD_CODES` (CSV) jeśli jest,
 * w przeciwnym wypadku domyślna lista trenerska. Wartość z env pozwala
 * zmieniać zestaw bez rebuilda (tylko `wrangler deploy --var ...`).
 */
function getPkdCodes(env?: { PKD_CODES?: string }): string[] {
  const raw = env?.PKD_CODES?.trim();
  if (!raw) return DEFAULT_PKD_CODES;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// CEIDG v3: limit=25 to twardy sufit. Wyżej → HTTP 400 NIEPOPRAWNY_ROZMIAR_STRONY.
const PAGE_LIMIT = 25;

// CEIDG v3 rate limit: 50 req / 3 min, 1000 req / 60 min.
// 15 calls/tick przy cronie godzinnym = 15 req/h (1.5% limitu godzinowego).
const MAX_CALLS_PER_CHUNK = 15;
const THROTTLE_MS = 200;

export interface SyncStats {
  pkdStats: Array<{
    pkd: string;
    startOffset: number;
    pagesFetched: number;
    fetched: number;
    upserted: number;
    exhausted: boolean;
  }>;
  totalFetched: number;
  totalUpserted: number;
  errors: number;
  callsUsed: number;
}

/**
 * Jeden tick syncu: przechodzi po PKD, wylicza offset per PKD z D1,
 * pobiera strony aż do wyczerpania budżetu MAX_CALLS_PER_CHUNK.
 */
export async function syncChunk(
  db: D1Database,
  cache: KVNamespace,
  token: string,
  env?: { PKD_CODES?: string },
): Promise<SyncStats> {
  const pkdCodes = getPkdCodes(env);
  const stats: SyncStats = {
    pkdStats: [],
    totalFetched: 0,
    totalUpserted: 0,
    errors: 0,
    callsUsed: 0,
  };
  const now = Math.floor(Date.now() / 1000);

  // Cache in-memory dla miast — przed pierwszą stroną ładujemy całą tabelę
  // cities (max kilka tysięcy wierszy, ~100 KB). Eliminuje 2-3 D1 query per
  // firma na getOrCreateCityId. Nowe miasta dopisywane są do Mapy przy INSERT.
  const cityCache = new Map<string, number>();
  {
    const { results } = await db
      .prepare("SELECT id, name FROM cities")
      .all<{ id: number; name: string }>();
    for (const row of results) cityCache.set(row.name, row.id);
  }

  for (const pkd of pkdCodes) {
    if (stats.callsUsed >= MAX_CALLS_PER_CHUNK) break;

    const countRow = await db
      .prepare("SELECT COUNT(DISTINCT nip) AS n FROM lead_pkd WHERE pkd = ?")
      .bind(pkd)
      .first<{ n: number }>();
    const startOffset = countRow?.n ?? 0;
    let page = Math.floor(startOffset / PAGE_LIMIT) + 1;

    const pkdStat = {
      pkd,
      startOffset,
      pagesFetched: 0,
      fetched: 0,
      upserted: 0,
      exhausted: false,
    };

    while (stats.callsUsed < MAX_CALLS_PER_CHUNK) {
      let batch: CeidgFirma[];
      let hasMore = false;
      try {
        const result = await listByPkd(pkd, page, PAGE_LIMIT, token, cache, {
          bypassCache: true,
        });
        batch = result.firmy;
        hasMore = result.hasMore;
        stats.callsUsed++;
        pkdStat.pagesFetched++;
      } catch (err) {
        logEvent("error", "ceidg_list_failed", { pkd, page, err: String(err) });
        stats.errors++;
        break;
      }

      pkdStat.fetched += batch.length;

      // Walidacja: wymagamy tylko NIP + imię + nazwisko. Miasto może być puste
      // — wtedy idziemy z city_id = NULL. Odrzucanie rekordów bez miasta
      // powodowało drift offsetu (CEIDG page N ≠ COUNT(*) / PAGE_LIMIT).
      const valid = batch.filter((f) => f.nip && f.imie && f.nazwisko);

      // Krok 1: upewnij się że wszystkie nowe miasta z tej strony są w bazie.
      // Firmy bez miasta pomijamy w tym kroku (dostaną city_id = NULL).
      const missingCities = new Set<string>();
      for (const f of valid) {
        const name = f.miasto.trim();
        if (name && !cityCache.has(name)) missingCities.add(name);
      }
      if (missingCities.size > 0) {
        try {
          await db.batch(
            [...missingCities].map((name) =>
              db
                .prepare("INSERT OR IGNORE INTO cities (name) VALUES (?)")
                .bind(name),
            ),
          );
          const placeholders = [...missingCities].map(() => "?").join(",");
          const { results } = await db
            .prepare(`SELECT id, name FROM cities WHERE name IN (${placeholders})`)
            .bind(...missingCities)
            .all<{ id: number; name: string }>();
          for (const row of results) cityCache.set(row.name, row.id);
        } catch (err) {
          logEvent("error", "cities_batch_failed", { err: String(err) });
          stats.errors++;
        }
      }

      // Krok 2: batch upsert leads + lead_pkd.
      const stmts: D1PreparedStatement[] = [];
      const leadUpsert = db.prepare(
        `INSERT INTO leads (nip, first_name, last_name, city_id, company_name, slug, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(nip) DO UPDATE SET
           first_name   = excluded.first_name,
           last_name    = excluded.last_name,
           city_id      = excluded.city_id,
           company_name = excluded.company_name,
           fetched_at   = excluded.fetched_at`,
      );
      const pkdInsert = db.prepare(
        `INSERT OR IGNORE INTO lead_pkd (nip, pkd) VALUES (?, ?)`,
      );
      for (const firma of valid) {
        const miastoTrimmed = firma.miasto.trim();
        const cityId = miastoTrimmed ? cityCache.get(miastoTrimmed) ?? null : null;
        const slug = slugify(firma.imie, firma.nazwisko, firma.nip);
        stmts.push(
          leadUpsert.bind(
            firma.nip,
            firma.imie,
            firma.nazwisko,
            cityId,
            firma.nazwa,
            slug,
            now,
          ),
        );
        stmts.push(pkdInsert.bind(firma.nip, pkd));
      }
      if (stmts.length > 0) {
        try {
          await db.batch(stmts);
          pkdStat.upserted += valid.length;
        } catch (err) {
          logEvent("error", "leads_batch_failed", { err: String(err) });
          stats.errors++;
        }
      }

      // Koniec tego PKD — wykrywamy przez `links.next` z odpowiedzi CEIDG
      // (deterministyczne) albo jako fallback przez niepełną stronę.
      if (!hasMore || batch.length < PAGE_LIMIT) {
        pkdStat.exhausted = true;
        break;
      }

      page++;
      if (stats.callsUsed < MAX_CALLS_PER_CHUNK) {
        await sleep(THROTTLE_MS);
      }
    }

    stats.pkdStats.push(pkdStat);
    stats.totalFetched += pkdStat.fetched;
    stats.totalUpserted += pkdStat.upserted;
  }

  return stats;
}

/**
 * Pełny przebieg — używany przez ręczny `POST /admin/sync?full=1`.
 * Pętla chunków aż żaden PKD nie przywiezie nowych rekordów (wszystkie
 * exhausted) albo aż limit maxChunks.
 */
export async function syncFull(
  db: D1Database,
  cache: KVNamespace,
  token: string,
  env?: { PKD_CODES?: string },
  maxChunks = 20,
): Promise<{ chunks: SyncStats[]; totalUpserted: number; totalFetched: number; completed: boolean }> {
  const pkdCodes = getPkdCodes(env);
  const chunks: SyncStats[] = [];
  let totalUpserted = 0;
  let totalFetched = 0;
  let completed = false;

  for (let i = 0; i < maxChunks; i++) {
    const stats = await syncChunk(db, cache, token, env);
    chunks.push(stats);
    totalUpserted += stats.totalUpserted;
    totalFetched += stats.totalFetched;
    if (stats.errors > 0) break;
    // Wszystkie PKD wyczerpane w ostatnim tyku → nie ma co więcej pobierać.
    if (stats.pkdStats.length === pkdCodes.length && stats.pkdStats.every((p) => p.exhausted)) {
      completed = true;
      break;
    }
    await sleep(3000);
  }

  return { chunks, totalUpserted, totalFetched, completed };
}

/**
 * Strukturalny log event. Pisany jako JSON żeby `wrangler tail` oraz
 * ewentualny Logpush dały się sparsować. `level` = "info" | "warn" | "error".
 */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, event, ts: Date.now(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Slug = imie-nazwisko-nip. NIP gwarantuje unikalność (w odróżnieniu od
 * imie-nazwisko-miasto, gdzie dwóch "Jan Kowalski" z Warszawy kolidowało).
 * NIP jest publiczny w CEIDG, więc trzymanie go w URL-u jest OK.
 */
export function slugify(first: string, last: string, nip: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/ł/g, "l")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return [norm(first), norm(last), nip]
    .filter(Boolean)
    .join("-")
    .replace(/--+/g, "-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
