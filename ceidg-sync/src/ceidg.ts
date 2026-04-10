// Klient CEIDG API v3 (https://dane.biznes.gov.pl).
// Cache odpowiedzi w KV (TTL 1h) — każde drugie zapytanie o ten sam NIP w ciągu
// godziny idzie z KV, nie z CEIDG. Obsługa 429 (Retry-After) i błędów sieci.

export interface CeidgFirma {
  nip: string;
  regon: string | null;
  imie: string;
  nazwisko: string;
  nazwa: string;
  miasto: string;
}

export class CeidgRateLimited extends Error {
  constructor(public retryAfterSec: number) {
    super(`CEIDG rate limited, retry after ${retryAfterSec}s`);
  }
}

export class CeidgError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const BASE = "https://dane.biznes.gov.pl/api/ceidg/v3";
const CACHE_TTL_SEC = 3600;

export async function fetchByNip(
  nip: string,
  token: string,
  cache: KVNamespace,
): Promise<CeidgFirma | null> {
  const cacheKey = `ceidg:nip:${nip}`;
  const cached = await cache.get(cacheKey, "json");
  if (cached !== null) return cached as CeidgFirma | null;

  const res = await fetch(`${BASE}/firmy?nip=${encodeURIComponent(nip)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    throw new CeidgRateLimited(retryAfter);
  }
  if (res.status === 404 || res.status === 204) {
    await cache.put(cacheKey, "null", { expirationTtl: CACHE_TTL_SEC });
    return null;
  }
  if (!res.ok) {
    throw new CeidgError(`CEIDG ${res.status}`, res.status);
  }

  const data = (await res.json()) as { firmy?: unknown[] };
  const firma = mapFirma(data.firmy?.[0]);
  await cache.put(cacheKey, JSON.stringify(firma), { expirationTtl: CACHE_TTL_SEC });
  return firma;
}

export interface ListByPkdResult {
  firmy: CeidgFirma[];
  /** Łączna liczba rekordów spełniających kryteria zapytania (pole `count` z response). */
  totalCount: number;
  /** Czy istnieją kolejne strony (na podstawie `links.next`). */
  hasMore: boolean;
}

// Lista firm po PKD z paginacją.
// UWAGA dot. formatu PKD: CEIDG v3 wymaga formatu BEZ kropek — `9604Z`, nie `96.04.Z`.
// Wariant z kropkami przechodzi (HTTP 200) ale jest po cichu ignorowany i zwraca
// niefiltrowane rekordy. Funkcja sama strippuje kropki, więc caller może podawać
// dowolny format.
export async function listByPkd(
  pkd: string,
  page: number,
  limit: number,
  token: string,
  cache: KVNamespace,
  opts: { bypassCache?: boolean } = {},
): Promise<ListByPkdResult> {
  const pkdNormalized = pkd.replace(/\./g, "");
  const cacheKey = `ceidg:list:${pkdNormalized}:${page}:${limit}`;
  // bypassCache używane przez scheduled sync — tam cache ma ~0% hit rate (kursor
  // idzie stroną naprzód, okno TTL 15 min i tak nie pokrywa się z cadence cronu),
  // a KV free ma twardy limit 1000 writes/dobę. Zapisy do cache podczas syncu
  // zjadały cały budżet KV po ~16h. Cache zostaje dla /admin/sync i fetchByNip.
  if (!opts.bypassCache) {
    const cached = await cache.get(cacheKey, "json");
    if (cached !== null) return cached as ListByPkdResult;
  }

  const url =
    `${BASE}/firmy?pkd=${encodeURIComponent(pkdNormalized)}` +
    `&page=${page}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    throw new CeidgRateLimited(retryAfter);
  }
  if (res.status === 204) {
    const empty: ListByPkdResult = { firmy: [], totalCount: 0, hasMore: false };
    if (!opts.bypassCache) {
      await cache.put(cacheKey, JSON.stringify(empty), { expirationTtl: 900 });
    }
    return empty;
  }
  if (!res.ok) {
    throw new CeidgError(`CEIDG list ${res.status}`, res.status);
  }

  const data = (await res.json()) as {
    firmy?: unknown[];
    count?: number;
    links?: { next?: string };
  };
  const firmy = (data.firmy ?? [])
    .map(mapFirma)
    .filter((f): f is CeidgFirma => f !== null);
  const result: ListByPkdResult = {
    firmy,
    totalCount: data.count ?? 0,
    hasMore: Boolean(data.links?.next),
  };

  if (!opts.bypassCache) {
    // krótszy TTL dla list (15 min) — listy zmieniają się szybciej niż pojedyncze rekordy
    await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 900 });
  }
  return result;
}

// Mapowanie zweryfikowane na realnym payloadzie CEIDG v3 /firmy?pkd=9604Z.
// Lista zwraca: { id, nazwa, adresDzialalnosci{...}, wlasciciel{imie,nazwisko,nip,regon},
// dataRozpoczecia, status, link }. PKD i email NIE występują w odpowiedzi listy —
// dla pełnych danych trzeba wołać /firma/{id}.
function mapFirma(raw: unknown): CeidgFirma | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const w = r.wlasciciel ?? {};
  const a = r.adresDzialalnosci ?? {};
  const nip: string = w.nip ?? "";
  if (!nip) return null;
  return {
    nip,
    regon: w.regon || null,
    imie: w.imie ?? "",
    nazwisko: w.nazwisko ?? "",
    nazwa: r.nazwa ?? "",
    miasto: a.miasto ?? "",
  };
}
