-- 005 — DataForSEO integration: gap-discovery worker
--
-- Adds:
--   1. dataforseo_spend / dataforseo_spend_monthly  — budget tracking mirror of llm_spend
--   2. dataforseo_runs                              — per-worker-run audit (target, cost, found kw count)
--   3. competitor_gap_keywords                      — raw discovered gap keywords cache (dedupe via UNIQUE)
--
-- No schema change to `opportunities` is required — we use the new kind
-- `competitor_gap` directly via TypeScript OpportunityKind union. Path field
-- carries the placeholder `/__competitor_gap/{slug}` because real target
-- selection happens at review time (a single gap kw may map to a new landing
-- page, an existing item slug, or a listicle hub).

CREATE TABLE IF NOT EXISTS dataforseo_spend (
  spend_date TEXT PRIMARY KEY,                       -- YYYY-MM-DD
  total_usd  REAL NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dataforseo_spend_monthly (
  spend_month TEXT PRIMARY KEY,                      -- YYYY-MM
  total_usd   REAL NOT NULL DEFAULT 0,
  call_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dataforseo_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT,
  target        TEXT,                                 -- e.g. "cs.money" or "csboard.com"
  endpoint      TEXT,                                 -- e.g. "ranked_keywords"
  cost_usd      REAL DEFAULT 0,
  kw_returned   INTEGER DEFAULT 0,                    -- raw rows from API
  gap_emitted   INTEGER DEFAULT 0,                    -- opportunities actually inserted (post dedupe + filter)
  status        TEXT NOT NULL DEFAULT 'running',      -- running | ok | failed | budget_capped
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_dfs_runs_started ON dataforseo_runs (started_at);

-- Persisted gap keyword cache. Lets us avoid re-emitting opportunities for
-- the same kw within a 60-day cooldown, and gives the reviewer a history
-- (when first seen, last seen, which competitors rank for it).
CREATE TABLE IF NOT EXISTS competitor_gap_keywords (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword         TEXT NOT NULL,
  location_code   INTEGER NOT NULL DEFAULT 2840,
  language_code   TEXT NOT NULL DEFAULT 'en',
  search_volume   INTEGER,
  cpc             REAL,
  difficulty      INTEGER,
  intent          TEXT,                               -- informational | commercial | transactional | navigational
  best_competitor TEXT,                               -- domain with highest position among competitors
  best_position   INTEGER,                            -- their absolute rank
  competitors     TEXT,                               -- JSON array: [{domain, position, url}]
  first_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  emitted         INTEGER NOT NULL DEFAULT 0,         -- 1 = opportunity already created
  UNIQUE (keyword, location_code, language_code)
);

CREATE INDEX IF NOT EXISTS idx_gap_volume ON competitor_gap_keywords (search_volume DESC);
CREATE INDEX IF NOT EXISTS idx_gap_last_seen ON competitor_gap_keywords (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_gap_not_emitted ON competitor_gap_keywords (emitted, search_volume DESC) WHERE emitted = 0;
