-- Normalizacja: city → relacja cities, pkd → relacja lead_pkd.
-- Baza była pusta w momencie migracji (DELETE FROM leads), więc drop+recreate
-- jest bezpieczny.

DROP INDEX IF EXISTS idx_leads_city;
DROP INDEX IF EXISTS idx_leads_claimed;
DROP INDEX IF EXISTS idx_leads_optout_ip;
DROP TABLE IF EXISTS leads;

CREATE TABLE cities (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE leads (
  nip            TEXT PRIMARY KEY,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  city_id        INTEGER NOT NULL REFERENCES cities(id),
  company_name   TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  claimed        INTEGER NOT NULL DEFAULT 0,
  github_repo    TEXT,
  fetched_at     INTEGER NOT NULL,
  opted_out_at   INTEGER,
  opted_out_ip   TEXT,
  opted_out_ua   TEXT
);

CREATE TABLE lead_pkd (
  nip TEXT NOT NULL REFERENCES leads(nip) ON DELETE CASCADE,
  pkd TEXT NOT NULL,
  PRIMARY KEY (nip, pkd)
);

CREATE INDEX idx_leads_city_id ON leads(city_id);
CREATE INDEX idx_leads_claimed ON leads(claimed);
CREATE INDEX idx_lead_pkd_pkd  ON lead_pkd(pkd);

-- 1 IP = 1 opt-out (partial unique index, tylko dla opted-out rekordów)
CREATE UNIQUE INDEX idx_leads_optout_ip
  ON leads(opted_out_ip)
  WHERE opted_out_ip IS NOT NULL;
