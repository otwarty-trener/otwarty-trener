-- ceidg-sync :: initial schema
-- Surowe leady z CEIDG. Trener "claimuje" rekord -> tworzymy repo na GitHubie
-- i flipujemy claimed=1. Opt-out = opted_out_at IS NOT NULL.

CREATE TABLE leads (
  nip            TEXT PRIMARY KEY,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  city           TEXT NOT NULL,
  company_name   TEXT NOT NULL,
  pkd            TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  claimed        INTEGER NOT NULL DEFAULT 0,
  github_repo    TEXT,
  fetched_at     INTEGER NOT NULL,
  opted_out_at   INTEGER,
  opted_out_ip   TEXT,
  opted_out_ua   TEXT
);

CREATE INDEX idx_leads_city    ON leads(city);
CREATE INDEX idx_leads_claimed ON leads(claimed);

-- 1 IP = 1 opt-out (partial unique index, tylko dla opted-out rekordów)
CREATE UNIQUE INDEX idx_leads_optout_ip
  ON leads(opted_out_ip)
  WHERE opted_out_ip IS NOT NULL;
