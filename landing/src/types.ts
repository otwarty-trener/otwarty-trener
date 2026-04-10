export type Lead = {
  nip: string;
  first_name: string;
  last_name: string;
  city: string | null;
  company_name: string;
  pkd: string | null;
  slug: string;
  claimed: number;
  github_repo: string | null;
  fetched_at: number;
  opted_out_at: number | null;
};

export type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
};
