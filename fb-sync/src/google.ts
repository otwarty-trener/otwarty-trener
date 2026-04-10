// fb-sync :: Serper.dev search client.
// Wyszukuje profile społecznościowe trenerów przez Google (via Serper).

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  source: string;
}

/**
 * Odpytuje Serper.dev i zwraca listę URLi z tytułami.
 */
export async function searchGoogle(
  query: string,
  apiKey: string,
): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      gl: "pl",
      hl: "pl",
      num: 10,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Serper error ${res.status}: ${err}`);
  }

  const data = await res.json<{
    organic?: Array<{
      link: string;
      title: string;
      snippet: string;
    }>;
  }>();

  if (!data.organic) return [];

  return data.organic.map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet ?? "",
    source: detectSource(item.link),
  }));
}

function detectSource(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.includes("facebook.com") || host.includes("fb.com")) return "facebook";
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    if (host.includes("tiktok.com")) return "tiktok";
    if (host.includes("pinterest.com") || host.includes("pin.it")) return "pinterest";
    if (host.includes("google.com") && rawUrl.includes("/maps")) return "google_maps";
    return "website";
  } catch {
    return "website";
  }
}
