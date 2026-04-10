// fb-sync :: Dopasowywanie profili FB do leadów w D1.
// Matching po nazwisku + mieście. Publiczne dane, zero prywatnych.

export interface MatchCandidate {
  nip: string;
  firstName: string;
  lastName: string;
  city: string;
}

/**
 * Szuka leadów w D1 pasujących do danych z profilu FB.
 * Matching: OG title zawiera nazwisko leada + miasto się zgadza.
 */
export async function findMatchingLeads(
  db: D1Database,
  ogTitle: string | null,
  ogDescription: string | null,
  city: string | null,
): Promise<MatchCandidate[]> {
  if (!ogTitle) return [];

  const titleLower = ogTitle.toLowerCase();
  const descLower = (ogDescription ?? "").toLowerCase();
  const searchText = `${titleLower} ${descLower}`;

  // Szukaj leadów w mieście (jeśli znane) lub we wszystkich
  const query = city
    ? `SELECT l.nip, l.first_name, l.last_name, c.name AS city
       FROM leads l
       LEFT JOIN cities c ON c.id = l.city_id
       WHERE c.name = ?1 AND l.opted_out_at IS NULL
       LIMIT 500`
    : `SELECT l.nip, l.first_name, l.last_name, c.name AS city
       FROM leads l
       LEFT JOIN cities c ON c.id = l.city_id
       WHERE l.opted_out_at IS NULL
       LIMIT 500`;

  const stmt = city ? db.prepare(query).bind(city) : db.prepare(query);
  const { results } = await stmt.all<{
    nip: string;
    first_name: string;
    last_name: string;
    city: string | null;
  }>();

  return results
    .filter((lead) => {
      const lastName = lead.last_name.toLowerCase();
      const firstName = lead.first_name.toLowerCase();
      // Nazwisko musi być w tytule/opisie FB
      return searchText.includes(lastName) && searchText.includes(firstName);
    })
    .map((lead) => ({
      nip: lead.nip,
      firstName: lead.first_name,
      lastName: lead.last_name,
      city: lead.city ?? "unknown",
    }));
}

/**
 * Próbuje wyciągnąć miasto z danych FB (opis, kategoria).
 */
export function extractCityFromFb(ogDescription: string | null, html?: string): string | null {
  if (!ogDescription) return null;

  // Typowe formaty: "Trener personalny w Warszawie", "Warszawa, Poland"
  const cityMatch = ogDescription.match(/(?:w |in |📍)\s*([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+)/);
  if (cityMatch) return cityMatch[1];

  // Format "Miasto, Polska" / "Miasto, Poland"
  const cityMatch2 = ogDescription.match(/([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+),\s*(?:Polska|Poland)/);
  if (cityMatch2) return cityMatch2[1];

  return null;
}
