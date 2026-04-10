import { Hono } from "hono";
import { layout, profileCard, profileArticle, esc } from "@press2ai/theme-specialist-glossy/templates";
import { catalogHero, catalogGrid, statBar, categoryNav, steps, pagination } from "@press2ai/theme-specialist-glossy/catalog";
import type { Profile } from "@press2ai/theme-specialist-glossy";
import type { Bindings, Lead } from "./types";
import { composeCss } from "@press2ai/theme-specialist-glossy/styles";

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => c.json({ error: err.message, stack: err.stack }, 500));

/** KV cache helper. Użycie: const data = await cached(kv, "key", 86400, () => heavyQuery()); */
async function cached<T>(kv: KVNamespace, key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = await kv.get(key);
  if (hit) return JSON.parse(hit) as T;
  const data = await fn();
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
  return data;
}

const cssText = composeCss('hero', 'statBar', 'categoryNav', 'steps', 'catalogGrid', 'profileCard', 'profileArticle', 'pagination', 'forms');
const CSS_TAG = `<style>${cssText}</style>`;
const SITE_DESC = "Otwarta baza trenerów personalnych i instruktorów w Polsce. Dane z CEIDG, bezpłatny dostęp, zweryfikowane wpisy.";

interface PageOpts { title: string; description?: string; jsonLd?: object }

function page(opts: PageOpts, body: string): string {
  return layout(
    {
      title: opts.title,
      description: opts.description ?? SITE_DESC,
      jsonLd: opts.jsonLd,
      siteName: "Otwarty Trener",
      homeHref: "/",
      headExtra: CSS_TAG,
      footerContent: `<nav>
<section>
<strong>Dane z oficjalnego rejestru</strong>
<p>Wpisy z Centralnej Ewidencji i Informacji o Działalności Gospodarczej (CEIDG). Każdy trener może przejąć swój profil.</p>
</section>
<section>
<strong>Dla trenerów</strong>
<a href="/opt-out">Usuń wpis</a>
<a href="/zasady">Zasady i prywatność</a>
</section>
<section>
<strong>Dla deweloperów</strong>
<a href="/catalog.json">API (JSON)</a>
<a href="/llms.txt">llms.txt</a>
<a href="/sitemap.xml">Sitemap</a>
</section>
</nav>
<p>Otwarty Trener &middot; Dane publiczne z CEIDG &middot; v0.7.4</p>`,
    },
    body,
  );
}

function leadToProfile(l: Lead): Profile {
  return {
    firstName: l.first_name,
    lastName: l.last_name,
    jobTitle: l.pkd ?? "Trener",
    city: l.city ?? undefined,
    specialties: [],
    languages: [],
    social: {},
    business: { name: l.company_name, taxId: l.nip, classification: l.pkd ? [l.pkd] : [] },
  };
}

function personJsonLd(l: Lead, url: string): object {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: `${l.first_name} ${l.last_name}`,
    jobTitle: l.pkd ?? "Trener personalny",
    ...(l.city && { address: { "@type": "PostalAddress", addressLocality: l.city, addressCountry: "PL" } }),
    worksFor: { "@type": "Organization", name: l.company_name, taxID: l.nip },
    url,
  };
}

const LEADS_QUERY = `
  SELECT l.nip, l.first_name, l.last_name, c.name as city,
         l.company_name, l.slug, l.claimed, l.github_repo, l.fetched_at,
         l.opted_out_at, p.pkd
  FROM leads l
  LEFT JOIN cities c ON l.city_id = c.id
  LEFT JOIN lead_pkd p ON l.nip = p.nip
  WHERE l.opted_out_at IS NULL`;

const SEARCH_FILTER = `AND (l.first_name || ' ' || l.last_name LIKE ?1 ESCAPE '\\' OR c.name LIKE ?1 ESCAPE '\\' OR l.company_name LIKE ?1 ESCAPE '\\')`;

function escapeLike(q: string): string {
  return `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

async function listLeads(db: D1Database, limit = 24, offset = 0, q?: string): Promise<{ leads: Lead[]; total: number }> {
  const filter = q ? SEARCH_FILTER : "";
  const like = q ? escapeLike(q) : null;

  const countSql = q
    ? `SELECT COUNT(*) as cnt FROM leads l LEFT JOIN cities c ON l.city_id = c.id WHERE l.opted_out_at IS NULL ${filter}`
    : "SELECT COUNT(*) as cnt FROM leads WHERE opted_out_at IS NULL";
  const countStmt = q ? db.prepare(countSql).bind(like) : db.prepare(countSql);
  const total = (await countStmt.first<{ cnt: number }>())?.cnt ?? 0;

  const selectSql = LEADS_QUERY + ` ${filter} ORDER BY c.name, l.last_name LIMIT ? OFFSET ?`;
  const selectStmt = q
    ? db.prepare(selectSql).bind(like, limit, offset)
    : db.prepare(selectSql).bind(limit, offset);
  const { results } = await selectStmt.all<Lead>();

  return { leads: results ?? [], total };
}

async function getLead(db: D1Database, slug: string): Promise<Lead | null> {
  return (await db.prepare(LEADS_QUERY + " AND l.slug = ?").bind(slug).first<Lead>()) ?? null;
}

async function cityStats(db: D1Database, limit = 8): Promise<{ total: number; top: { name: string; count: number }[] }> {
  const [countRow, { results }] = await Promise.all([
    db.prepare("SELECT COUNT(DISTINCT city_id) as cnt FROM leads WHERE opted_out_at IS NULL AND city_id IS NOT NULL").first<{ cnt: number }>(),
    db.prepare(
      `SELECT c.name, COUNT(*) as count FROM leads l
       JOIN cities c ON l.city_id = c.id WHERE l.opted_out_at IS NULL
       GROUP BY c.name ORDER BY count DESC LIMIT ?`
    ).bind(limit).all<{ name: string; count: number }>(),
  ]);
  return { total: countRow?.cnt ?? 0, top: results ?? [] };
}

app.get("/health", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM leads").all();
  return c.json({ ok: true, db: results });
});

app.get("/", async (c) => {
  const PAGE_SIZE = 12;
  const pg = Math.max(1, parseInt(c.req.query("p") ?? "1", 10) || 1);
  const q = (c.req.query("q") ?? "").trim();
  const host = new URL(c.req.url).origin;

  const [{ leads, total }, cities] = await Promise.all([
    listLeads(c.env.DB, PAGE_SIZE, (pg - 1) * PAGE_SIZE, q || undefined),
    cityStats(c.env.DB),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const cards = leads.map((l) => profileCard(leadToProfile(l), `/${esc(l.slug)}`)).join("\n");
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const showIntro = pg === 1 && !q;

  const description = q
    ? `Wyniki wyszukiwania "${q}" — ${total} trenerów w bazie Otwarty Trener.`
    : SITE_DESC;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Otwarty Trener",
    url: host,
    description: SITE_DESC,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${host}/?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };

  const hero = catalogHero({
    badge: "Dane z publicznego rejestru CEIDG",
    title: "Znajdź trenera w Twojej okolicy",
    subtitle: "Otwarty katalog trenerów w Polsce. Dane z publicznego rejestru, bezpłatnie i bez rejestracji.",
    searchAction: "/",
    searchPlaceholder: "Szukaj po nazwisku, mieście lub firmie...",
    searchValue: q,
  });

  const stats = statBar(
    [
      { value: total.toLocaleString("pl"), label: "trenerów", icon: "people" },
      { value: String(cities.total), label: "miast", icon: "city" },
      { value: "100%", label: "bezpłatnie", icon: "free" },
    ],
    `W bazie znajduje się ${total.toLocaleString("pl")} trenerów z ${cities.total} miast w Polsce. Dostęp jest w pełni bezpłatny.`,
  );

  const cityPills = categoryNav(
    cities.top.map((ci) => ({ href: `/?q=${encodeURIComponent(ci.name)}`, label: `${ci.name} (${ci.count})` })),
    "Popularne miasta",
  );

  const howItWorks = showIntro ? steps("Jak to działa", [
    { title: "Szukaj", description: "Wpisz miasto, nazwisko lub specjalizację" },
    { title: "Przeglądaj", description: "Sprawdź profile z danymi z CEIDG" },
    { title: "Kontaktuj", description: "Skontaktuj się bezpośrednio z trenerem" },
  ]) : "";


  return c.html(page(
    { title: q ? `${q} — szukaj trenera | Otwarty Trener` : "Otwarty Trener — znajdź trenera w swojej okolicy", description, jsonLd },
    `${hero}${showIntro ? stats : ""}
    ${showIntro ? howItWorks : ""}
    ${catalogGrid({
      title: q ? `Wyniki dla „${esc(q)}" (${total})` : "Trenerzy",
      filters: cityPills,
      cards,
    })}
    ${pagination({ current: pg, total: totalPages, extraParams: qParam })}`
  ));
});

app.get("/catalog.json", async (c) => {
  const data = await cached(c.env.CACHE, "page:catalog.json", 86400, async () => {
    const { leads } = await listLeads(c.env.DB, 10000, 0);
    return {
      version: 1, source: "ceidg", count: leads.length,
      items: leads.map((l) => ({
        slug: l.slug, firstName: l.first_name, lastName: l.last_name,
        city: l.city, companyName: l.company_name, claimed: !!l.claimed, url: "/" + l.slug,
      })),
    };
  });
  return c.json(data);
});

app.get("/llms.txt", async (c) => {
  const text = await cached(c.env.CACHE, "page:llms.txt", 86400, async () => {
    const { leads } = await listLeads(c.env.DB, 10000, 0);
    return ["# Otwarty Trener", "Otwarta baza trenerów personalnych w Polsce (dane z CEIDG).", "",
     "## Trenerzy",
     ...leads.map((l) => `- ${l.first_name} ${l.last_name} (${l.city}) — /${l.slug}`)
    ].join("\n");
  });
  return c.text(text);
});

app.get("/sitemap.xml", async (c) => {
  const host = new URL(c.req.url).origin;
  const xml = await cached(c.env.CACHE, `page:sitemap:${host}`, 86400, async () => {
    const { leads } = await listLeads(c.env.DB, 10000);
    const urls = [host + "/", ...leads.map((l) => host + "/" + l.slug)];
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") + "\n</urlset>";
  });
  return c.body(xml, 200, { "content-type": "application/xml" });
});

app.get("/zasady", (c) =>
  c.html(page(
    { title: "Zasady i prywatność — Otwarty Trener", description: "Zasady korzystania, polityka prywatności i regulamin serwisu Otwarty Trener." },
    `<h1>Zasady i prywatność</h1>
    <p><small>Aktualizacja: 10 kwietnia 2026</small></p>

    <h2>Co to jest</h2>
    <p>Otwarty katalog trenerów personalnych w Polsce. Dane z publicznego rejestru CEIDG. Bezpłatny dostęp.</p>

    <h2>Skąd dane</h2>
    <p>Z <a href="https://dane.biznes.gov.pl" rel="noopener">CEIDG</a> — publiczny rejestr firm. Pobieramy: imię, nazwisko, nazwa firmy, miasto, NIP, kody PKD. Nie pobieramy: e-mail, telefon, adres zamieszkania, REGON.</p>
    <p>Szukamy też publicznych fanpage'y i stron firmowych. Tylko to co widzi każdy w internecie.</p>

    <h2>Otwarte dane</h2>
    <p>Katalog jest otwarty. Dane dostępne przez <a href="/catalog.json">API</a>, <a href="/llms.txt">llms.txt</a>, <a href="/sitemap.xml">sitemap</a>. Mogą z nich korzystać aplikacje, platformy i agenci AI. Jeśli masz konto — możesz pobrać swoje dane w dowolnym momencie. Zero locka.</p>

    <h2>Podstawa prawna</h2>
    <p>Uzasadniony interes (art. 6.1.f RODO) — łączymy trenerów z klientami. Przy rejestracji — umowa (art. 6.1.b RODO).</p>

    <h2>Twoje prawa</h2>
    <ul>
      <li>Usunięcie — <a href="/opt-out">/opt-out</a>, natychmiast, bez pytań</li>
      <li>Dostęp — napisz, wyślemy co mamy</li>
      <li>Poprawka — napisz lub edytuj po rejestracji</li>
      <li>Sprzeciw, przenoszenie, ograniczenie — napisz</li>
    </ul>

    <h2>Czego nie robimy</h2>
    <p>Nie sprzedajemy danych. Nie profilujemy. Nie śledzimy. Nie wysyłamy spamu. Brak Google Analytics, brak pikseli, brak cookies marketingowych.</p>

    <h2>Infrastruktura</h2>
    <p>Cloudflare Workers + D1. Dane w UE. To jedyny podmiot przetwarzający.</p>

    <h2>Regulamin</h2>
    <ol>
      <li>Katalog jest bezpłatny i otwarty</li>
      <li>Dane pochodzą z publicznego rejestru CEIDG</li>
      <li>Każdy trener może usunąć swój wpis przez <a href="/opt-out">/opt-out</a></li>
      <li>Każdy trener może przejąć swój profil i edytować go</li>
      <li>Zabrania się kopiowania danych w celu budowania zamkniętych baz</li>
      <li>Korzystanie z API jest dozwolone z podaniem źródła</li>
    </ol>

    <h2>Kontakt</h2>
    <p>E-mail: [do uzupełnienia]</p>

    <p><small>Krótko, bo szanujemy Twój czas.</small></p>`
  ))
);

app.get("/opt-out", (c) =>
  c.html(page(
    { title: "Sprzeciw — Otwarty Trener", description: "Usuń swoją wizytówkę z katalogu Otwarty Trener. Podaj NIP aby złożyć sprzeciw." },
    `<h1>Usunięcie wpisu</h1>
    <p>Podaj NIP, aby usunąć swoją wizytówkę z katalogu.</p>
    <form method="post" action="/opt-out">
      <label>NIP<input type="text" name="nip" required pattern="[0-9]{10}"></label>
      <button type="submit">Usuń wpis</button>
    </form>`
  ))
);

app.post("/opt-out", async (c) => {
  const form = await c.req.formData();
  const nip = String(form.get("nip") ?? "").replace(/\D/g, "");
  if (nip.length !== 10) return c.text("Nieprawidłowy NIP", 400);

  const ip = c.req.header("cf-connecting-ip") ?? "0.0.0.0";
  const rlKey = `rl:optout:${ip}`;
  const rlVal = parseInt(await c.env.CACHE.get(rlKey) ?? "0", 10);
  if (rlVal >= 5) return c.text("Zbyt wiele prób. Spróbuj ponownie za godzinę.", 429);
  await c.env.CACHE.put(rlKey, String(rlVal + 1), { expirationTtl: 3600 });

  const res = await c.env.DB.prepare(
    "UPDATE leads SET opted_out_at = ?, opted_out_ip = ?, opted_out_ua = ? WHERE nip = ? AND opted_out_at IS NULL"
  ).bind(Math.floor(Date.now() / 1000), ip, c.req.header("user-agent") ?? "", nip).run();

  if (!res.meta.changes) return c.text("Nie znaleziono wpisu", 404);
  return c.html(page(
    { title: "Usunięto — Otwarty Trener" },
    `<h1>Wpis usunięty</h1><p>Twoja wizytówka została trwale wykluczona z katalogu.</p><a href="/">Wróć</a>`
  ));
});

app.get("/:slug", async (c) => {
  const lead = await getLead(c.env.DB, c.req.param("slug"));
  if (!lead) return c.notFound();
  if (lead.claimed && lead.github_repo)
    return c.redirect("https://otwarty-trener.github.io/" + lead.github_repo + "/");

  const host = new URL(c.req.url).origin;
  const fullName = `${lead.first_name} ${lead.last_name}`;
  const city = lead.city ?? "";
  const description = `${fullName} — ${lead.pkd ?? "trener personalny"}${city ? ` w ${city}` : ""}. Dane z CEIDG, profil w katalogu Otwarty Trener.`;

  return c.html(page(
    { title: `${fullName} — ${city} | Otwarty Trener`, description, jsonLd: personJsonLd(lead, `${host}/${lead.slug}`) },
    profileArticle(leadToProfile(lead))
  ));
});

export default app;
