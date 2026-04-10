// Klient GitHub API dla operacji potrzebnych w claim flow:
// 1. utwórz repo z templatki (`profile-template`)
// 2. podmień placeholdery w profile.json + nazwę w package.json
// 3. ustaw topic `otwarty-trener-profile` (żeby landing złapał)
// 4. włącz GitHub Pages z build_type=workflow
// 5. (auto) commit profile.json triggeruje workflow → deploy

const ORG = "otwarty-trener";
const TEMPLATE_REPO = "profile-template";
const TOPIC = "otwarty-trener-profile";
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(`GitHub ${status}: ${message}`);
  }
}

interface GhRequestOpts {
  method?: string;
  body?: unknown;
  accept?: string;
}

async function gh(token: string, path: string, opts: GhRequestOpts = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `token ${token}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "ceidg-sync/0.1",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

async function ghOk(token: string, path: string, opts: GhRequestOpts = {}): Promise<any> {
  const res = await gh(token, path, opts);
  if (!res.ok) {
    const body = await res.text();
    throw new GitHubError(path, res.status, body.slice(0, 500));
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function createRepoFromTemplate(slug: string, token: string): Promise<{
  fullName: string;
  htmlUrl: string;
}> {
  const data = await ghOk(token, `/repos/${ORG}/${TEMPLATE_REPO}/generate`, {
    method: "POST",
    accept: "application/vnd.github.baptiste-preview+json",
    body: {
      owner: ORG,
      name: `profile-${slug}`,
      description: `Profil trenera w sieci Otwarty Trener`,
      private: false,
      include_all_branches: false,
    },
  });
  return { fullName: data.full_name, htmlUrl: data.html_url };
}

// Po `generate` template files materializują się asynchronicznie. Pollujemy GET /contents
// aż dostaniemy 200 (zwykle <2s). Zwraca SHA pliku, potrzebne do PUT.
async function getFileSha(slug: string, path: string, token: string): Promise<string> {
  const url = `/repos/${ORG}/profile-${slug}/contents/${encodeURIComponent(path)}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await gh(token, url);
    if (res.status === 200) {
      const data = (await res.json()) as { sha: string };
      return data.sha;
    }
    if (res.status !== 404) {
      const body = await res.text();
      throw new GitHubError(`get ${path}`, res.status, body.slice(0, 500));
    }
    await sleep(800);
  }
  throw new GitHubError(`get ${path} timeout`, 404);
}

export async function putFile(
  slug: string,
  path: string,
  content: string,
  message: string,
  token: string,
): Promise<void> {
  const sha = await getFileSha(slug, path, token);
  const url = `/repos/${ORG}/profile-${slug}/contents/${encodeURIComponent(path)}`;
  await ghOk(token, url, {
    method: "PUT",
    body: {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
    },
  });
}

export async function setTopic(slug: string, token: string): Promise<void> {
  await ghOk(token, `/repos/${ORG}/profile-${slug}/topics`, {
    method: "PUT",
    accept: "application/vnd.github.mercy-preview+json",
    body: { names: [TOPIC] },
  });
}

export async function enablePages(slug: string, token: string): Promise<void> {
  const res = await gh(token, `/repos/${ORG}/profile-${slug}/pages`, {
    method: "POST",
    body: { build_type: "workflow" },
  });
  // 201 = created, 409 = already enabled (idempotent — ok)
  if (res.status !== 201 && res.status !== 409) {
    const body = await res.text();
    throw new GitHubError("enablePages", res.status, body.slice(0, 500));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
