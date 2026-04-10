-- city_id nullable: rekordy CEIDG bez adresu działalności też idą do bazy,
-- żeby COUNT(*) FROM leads zgadzał się z offsetem CEIDG (bez driftu
-- z filtrowania). Do publicznej listy filtrujemy WHERE city_id IS NOT NULL.
--
-- SQLite nie wspiera ALTER COLUMN DROP NOT NULL, więc robimy table-rewrite
-- przez nową tabelę. Baza jest mała (~400 rekordów), koszt pomijalny.

CREATE TABLE leads_new (
  nip            TEXT PRIMARY KEY,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  city_id        INTEGER REFERENCES cities(id),
  company_name   TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  claimed        INTEGER NOT NULL DEFAULT 0,
  github_repo    TEXT,
  fetched_at     INTEGER NOT NULL,
  opted_out_at   INTEGER,
  opted_out_ip   TEXT,
  opted_out_ua   TEXT
);

INSERT INTO leads_new SELECT * FROM leads;
DROP TABLE leads;
ALTER TABLE leads_new RENAME TO leads;

CREATE INDEX idx_leads_city_id ON leads(city_id);
CREATE INDEX idx_leads_claimed ON leads(claimed);
CREATE UNIQUE INDEX idx_leads_optout_ip
  ON leads(opted_out_ip)
  WHERE opted_out_ip IS NOT NULL;
