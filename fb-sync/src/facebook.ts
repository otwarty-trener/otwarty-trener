// fb-sync :: Pobieranie i klasyfikacja publicznych stron FB.
// Fetch na publiczny URL → parsowanie OG meta + sygnałów z HTML.

export interface FbPageData {
  url: string;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  category: string | null;
  pageType: "fanpage" | "profile" | "unknown";
  hasPhone: boolean;
  hasEmail: boolean;
  hasWebsite: boolean;
  lastPostHint: string | null;
  score: number;
}

const TRAINER_KEYWORDS = [
  "trener", "trainer", "fitness", "personalny", "treningowy",
  "silownia", "siłownia", "coaching", "sport", "dietetyk",
  "crossfit", "gym", "workout", "trening", "ćwiczenia",
];

const FANPAGE_SIGNALS = [
  "pages", "/page/", "pageID", "fan_count",
  "business.facebook.com", "fb-page",
];

/**
 * Pobiera publiczną stronę FB i wyciąga metadane OG + sygnały.
 * Nie używa Graph API — zwykły fetch na publiczny URL.
 */
export async function fetchFbPage(fbUrl: string): Promise<FbPageData> {
  // Normalizuj URL — usuń tracking params, wymuś wersję mobilną (lżejszy HTML)
  const cleanUrl = normalizeFbUrl(fbUrl);

  const res = await fetch(cleanUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OtwartyTrener/0.1; +https://otwarty-trener.pl)",
      "Accept": "text/html",
      "Accept-Language": "pl-PL,pl;q=0.9",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    return emptyResult(fbUrl, "unknown");
  }

  const html = await res.text();
  return parseFbPage(fbUrl, html);
}

/** Parsuje HTML strony FB i wyciąga sygnały. */
export function parseFbPage(fbUrl: string, html: string): FbPageData {
  const ogTitle = extractMeta(html, "og:title");
  const ogDescription = extractMeta(html, "og:description");
  const ogImage = extractMeta(html, "og:image");
  const ogType = extractMeta(html, "og:type");

  // Kategoria — FB czasem daje ją w meta lub w widocznym HTML
  const category = extractCategory(html);

  // Typ strony
  const pageType = detectPageType(fbUrl, html, ogType);

  // Sygnały kontaktowe
  const hasPhone = /tel:|phone|telefon|\+48|\d{3}[\s-]?\d{3}[\s-]?\d{3}/i.test(html);
  const hasEmail = /mailto:|@[\w.-]+\.\w{2,}/i.test(html);
  const hasWebsite = /external_url|website|strona|www\./i.test(html);

  // Hint o ostatnim poście — szukamy dat w formacie FB
  const lastPostHint = extractLastPostHint(html);

  // Scoring
  const score = calculateScore({
    pageType, ogTitle, ogDescription, category,
    hasPhone, hasEmail, hasWebsite, lastPostHint,
  });

  return {
    url: fbUrl,
    ogTitle,
    ogDescription,
    ogImage,
    category,
    pageType,
    hasPhone,
    hasEmail,
    hasWebsite,
    lastPostHint,
    score,
  };
}

/** Scoring 0-100: jak bardzo wygląda na aktywny fanpage trenera. */
function calculateScore(data: {
  pageType: string;
  ogTitle: string | null;
  ogDescription: string | null;
  category: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  hasWebsite: boolean;
  lastPostHint: string | null;
}): number {
  let score = 0;

  // Typ strony
  if (data.pageType === "fanpage") score += 30;
  else if (data.pageType === "profile") score += 10;

  // Kategoria pasuje do trenera
  if (data.category && TRAINER_KEYWORDS.some(k => data.category!.toLowerCase().includes(k))) {
    score += 20;
  }

  // Tytuł/opis zawiera słowa kluczowe
  const text = `${data.ogTitle ?? ""} ${data.ogDescription ?? ""}`.toLowerCase();
  const keywordHits = TRAINER_KEYWORDS.filter(k => text.includes(k)).length;
  score += Math.min(keywordHits * 5, 20);

  // Dane kontaktowe
  if (data.hasPhone) score += 10;
  if (data.hasEmail) score += 5;
  if (data.hasWebsite) score += 10;

  // Aktywność
  if (data.lastPostHint) score += 5;

  return Math.min(score, 100);
}

function detectPageType(url: string, html: string, ogType: string | null): "fanpage" | "profile" | "unknown" {
  if (ogType === "profile") return "profile";
  if (FANPAGE_SIGNALS.some(s => url.includes(s) || html.includes(s))) return "fanpage";
  // Szukaj sygnałów fanpage w HTML
  if (/Page·|Strona·|likes this|osób lubi to|polub/i.test(html)) return "fanpage";
  return "unknown";
}

function extractMeta(html: string, property: string): string | null {
  // Szukaj <meta property="og:title" content="...">
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const match = html.match(re);
  if (match) return decodeEntities(match[1]);

  // Odwrócona kolejność atrybutów
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
    "i",
  );
  const match2 = html.match(re2);
  return match2 ? decodeEntities(match2[1]) : null;
}

function extractCategory(html: string): string | null {
  // FB często ma kategorię w formacie: <span>Trener personalny</span> blisko meta
  // lub w structured data
  const catMatch = html.match(/"category_name":"([^"]+)"/);
  if (catMatch) return catMatch[1];

  const catMatch2 = html.match(/"category":"([^"]+)"/);
  if (catMatch2) return catMatch2[1];

  return null;
}

function extractLastPostHint(html: string): string | null {
  // Szukamy dat w formacie "X godz.", "X dni", lub daty
  const dateMatch = html.match(/(\d{1,2}\s+(?:sty|lut|mar|kwi|maj|cze|lip|sie|wrz|paź|lis|gru)[a-ząćęłńóśźż]*\s+\d{4})/i);
  return dateMatch ? dateMatch[1] : null;
}

function normalizeFbUrl(url: string): string {
  try {
    const u = new URL(url);
    // Usuń tracking params
    u.searchParams.delete("ref");
    u.searchParams.delete("fref");
    u.searchParams.delete("__tn__");
    u.searchParams.delete("__cft__");
    return u.toString();
  } catch {
    return url;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function emptyResult(url: string, pageType: "fanpage" | "profile" | "unknown"): FbPageData {
  return {
    url, ogTitle: null, ogDescription: null, ogImage: null,
    category: null, pageType, hasPhone: false, hasEmail: false,
    hasWebsite: false, lastPostHint: null, score: 0,
  };
}
