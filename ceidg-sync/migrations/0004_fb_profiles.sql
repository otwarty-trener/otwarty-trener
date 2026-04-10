-- Zewnętrzne URLe powiązane z leadami.
-- Uniwersalna relacja: FB fanpage, Instagram, Pinterest, www, Google Maps, etc.

CREATE TABLE external_urls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nip         TEXT REFERENCES leads(nip) ON DELETE CASCADE,
  url         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,    -- 'facebook' | 'instagram' | 'pinterest' | 'google_maps' | 'website' | 'youtube' | 'tiktok'
  page_type   TEXT NOT NULL DEFAULT 'unknown',  -- 'fanpage' | 'profile' | 'business' | 'unknown'
  og_title    TEXT,
  og_description TEXT,
  og_image    TEXT,
  category    TEXT,
  has_phone   INTEGER NOT NULL DEFAULT 0,
  has_email   INTEGER NOT NULL DEFAULT 0,
  has_website INTEGER NOT NULL DEFAULT 0,
  score       INTEGER NOT NULL DEFAULT 0,
  matched_at  INTEGER,
  fetched_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'fetched' | 'matched' | 'rejected'
);

CREATE INDEX idx_ext_urls_nip    ON external_urls(nip);
CREATE INDEX idx_ext_urls_source ON external_urls(source);
CREATE INDEX idx_ext_urls_status ON external_urls(status);
CREATE INDEX idx_ext_urls_score  ON external_urls(score DESC);
