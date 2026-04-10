// fb-sync :: Dopasowywanie wyników Google do leadów w D1.
// Matching po imieniu, nazwisku i opcjonalnie mieście.

export interface MatchCandidate {
  nip: string;
  firstName: string;
  lastName: string;
  city: string;
  score: number;
}

/**
 * Szuka leadów pasujących do tytułu/snippetu z Google.
 * Zwraca kandydatów posortowanych po score (wyższy = lepszy match).
 */
export async function findMatchingLeads(
  db: D1Database,
  title: string,
  snippet: string,
): Promise<MatchCandidate[]> {
  if (!title) return [];

  const searchText = `${title} ${snippet}`.toLowerCase();

  const { results } = await db.prepare(
    `SELECT l.nip, l.first_name, l.last_name, c.name AS city
     FROM leads l
     LEFT JOIN cities c ON c.id = l.city_id
     WHERE l.opted_out_at IS NULL
     LIMIT 1000`,
  ).all<{
    nip: string;
    first_name: string;
    last_name: string;
    city: string | null;
  }>();

  return results
    .map((lead) => {
      const lastName = lead.last_name.toLowerCase();
      const firstName = lead.first_name.toLowerCase();
      const city = (lead.city ?? "").toLowerCase();

      let score = 0;

      // Nazwisko w tekście — najważniejszy sygnał
      if (searchText.includes(lastName)) score += 40;
      else return null;

      // Imię w tekście
      if (searchText.includes(firstName)) score += 30;

      // Miasto w tekście
      if (city && searchText.includes(city)) score += 20;

      // Słowa kluczowe trenera
      if (/trener|trainer|fitness|personal/i.test(searchText)) score += 10;

      return {
        nip: lead.nip,
        firstName: lead.first_name,
        lastName: lead.last_name,
        city: lead.city ?? "unknown",
        score,
      };
    })
    .filter((m): m is MatchCandidate => m !== null && m.score >= 70)
    .sort((a, b) => b.score - a.score);
}
