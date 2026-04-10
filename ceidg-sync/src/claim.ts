// POST /claim — flow przejęcia profilu przez trenera.
//
// Trener podaje 5 pól (nip, first_name, last_name, company_name, regon).
// Worker:
//  1. szuka leada w D1 (musi istnieć, niezclaimowany, nie opted-out)
//  2. dzwoni live do CEIDG po danej NIP
//  3. porównuje wszystkie 5 pól 1:1 po normalizacji
//  4. tworzy repo z templatki, podmienia profile.json + package.json,
//     ustawia topic, włącza Pages
//  5. UPDATE leads SET claimed=1, github_repo=?

import { fetchByNip } from "./ceidg";
import {
  createRepoFromTemplate,
  putFile,
  setTopic,
  enablePages,
  GitHubError,
} from "./github";

export interface ClaimInput {
  nip: string;
  first_name: string;
  last_name: string;
  company_name: string;
  regon: string;
}

export interface ClaimResult {
  ok: true;
  slug: string;
  repo_url: string;
  profile_url: string;
}

export type ClaimError =
  | { ok: false; status: 400; error: "invalid_input"; missing?: string[] }
  | { ok: false; status: 404; error: "lead_not_found" }
  | { ok: false; status: 409; error: "already_claimed" }
  | { ok: false; status: 502; error: "ceidg_no_data" }
  | { ok: false; status: 403; error: "data_mismatch"; fields: string[] }
  | { ok: false; status: 500; error: "github_failed"; detail: string };

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  CEIDG_TOKEN: string;
  GITHUB_TOKEN: string;
}

export async function handleClaim(
  input: Partial<ClaimInput>,
  env: Env,
): Promise<ClaimResult | ClaimError> {
  // 1. walidacja inputu
  const missing = (["nip", "first_name", "last_name", "company_name", "regon"] as const).filter(
    (k) => !input[k] || typeof input[k] !== "string" || (input[k] as string).trim() === "",
  );
  if (missing.length > 0) {
    return { ok: false, status: 400, error: "invalid_input", missing };
  }
  const nip = (input.nip as string).trim();

  // 2. lookup w D1
  const lead = await env.DB
    .prepare(
      "SELECT nip, slug, claimed, opted_out_at FROM leads WHERE nip = ?1",
    )
    .bind(nip)
    .first<{ nip: string; slug: string; claimed: number; opted_out_at: number | null }>();

  if (!lead) return { ok: false, status: 404, error: "lead_not_found" };
  if (lead.claimed === 1) return { ok: false, status: 409, error: "already_claimed" };
  if (lead.opted_out_at !== null) return { ok: false, status: 404, error: "lead_not_found" };

  // 3. live CEIDG check
  const firma = await fetchByNip(nip, env.CEIDG_TOKEN, env.CACHE);
  if (!firma) return { ok: false, status: 502, error: "ceidg_no_data" };

  // 4. match 5 pól po normalizacji
  const mismatched: string[] = [];
  if (norm(input.first_name as string) !== norm(firma.imie)) mismatched.push("first_name");
  if (norm(input.last_name as string) !== norm(firma.nazwisko)) mismatched.push("last_name");
  if (norm(input.company_name as string) !== norm(firma.nazwa)) mismatched.push("company_name");
  if (normRegon(input.regon as string) !== normRegon(firma.regon ?? "")) mismatched.push("regon");
  if (mismatched.length > 0) {
    return { ok: false, status: 403, error: "data_mismatch", fields: mismatched };
  }

  // 5. utwórz repo z templatki + podmień zawartość
  const slug = lead.slug;
  let repoUrl: string;
  try {
    const repo = await createRepoFromTemplate(slug, env.GITHUB_TOKEN);
    repoUrl = repo.htmlUrl;

    const profileJson = buildProfileJson({
      firstName: firma.imie,
      lastName: firma.nazwisko,
      city: firma.miasto,
      companyName: firma.nazwa,
      nip: firma.nip,
      regon: firma.regon ?? "",
      pkd: "", // listing nie zwraca PKD; uzupełnimy później
    });

    await putFile(slug, "profile.json", profileJson, "claim: fill profile data", env.GITHUB_TOKEN);
    await putFile(
      slug,
      "package.json",
      buildPackageJson(slug),
      "claim: set package name",
      env.GITHUB_TOKEN,
    );
    await setTopic(slug, env.GITHUB_TOKEN);
    await enablePages(slug, env.GITHUB_TOKEN);
  } catch (err) {
    const detail = err instanceof GitHubError ? err.message : String(err);
    console.error("github failed", detail);
    return { ok: false, status: 500, error: "github_failed", detail };
  }

  // 6. flip claimed w D1
  await env.DB
    .prepare("UPDATE leads SET claimed = 1, github_repo = ?2 WHERE nip = ?1")
    .bind(nip, `profile-${slug}`)
    .run();

  return {
    ok: true,
    slug,
    repo_url: repoUrl,
    profile_url: `https://otwarty-trener.github.io/profile-${slug}/`,
  };
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

// CEIDG REGON może być 9 lub 14 cyfr; porównujemy pierwsze 9.
function normRegon(s: string): string {
  return s.replace(/\D/g, "").slice(0, 9);
}

interface ProfileData {
  firstName: string;
  lastName: string;
  city: string;
  companyName: string;
  nip: string;
  regon: string;
  pkd: string;
}

function buildProfileJson(d: ProfileData): string {
  // Pola opcjonalne (email, website, phone, tagline, bio) opuszczamy całkowicie
  // jeśli są puste — theme @press2ai/theme-specialist-glossy waliduje je przez Zod
  // i pusty string fail-uje (`invalid_format` dla email/url). Trener uzupełni je sam.
  const profile = {
    firstName: d.firstName,
    lastName: d.lastName,
    jobTitle: "Trener personalny",
    city: d.city,
    country: "PL",
    specialties: [],
    languages: ["polski"],
    business: {
      name: d.companyName,
      taxId: d.nip,
      registryId: d.regon,
      classification: d.pkd ? [d.pkd] : [],
    },
    source: "ceidg",
    verified: true,
  };
  return JSON.stringify(profile, null, 2) + "\n";
}

function buildPackageJson(slug: string): string {
  return (
    JSON.stringify(
      {
        name: `profile-${slug}`,
        type: "module",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "astro dev",
          build: "astro build",
          preview: "astro preview",
        },
        dependencies: {
          "@astrojs/sitemap": "^3.7.2",
          "@press2ai/theme-specialist-glossy": "^0.4.0",
          astro: "^5.0.0",
        },
      },
      null,
      2,
    ) + "\n"
  );
}
