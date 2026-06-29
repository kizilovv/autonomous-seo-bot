-- csboard-seo-bot — initial schema
-- All SEO content lives here. Frontend reads via HTTP API. Bot/agents write via MCP.
-- Note: PRAGMAs are set on the connection (src/db/connection.ts), not here —
-- some PRAGMAs (synchronous, journal_mode) can't run inside a transaction.

-- ---------------------------------------------------------------------------
-- content: the live SEO state served to the frontend
-- (locale, path, field) is unique. value is JSONB-ish (TEXT containing JSON).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  locale      TEXT NOT NULL,                 -- 'en' | 'ru'
  path        TEXT NOT NULL,                 -- '/sell' | '/trades' | '/items/ak-47-redline'
  field       TEXT NOT NULL,                 -- 'title' | 'description' | 'h1' | 'intro' | 'faq' | 'keywords'
  value       TEXT NOT NULL,                 -- JSON string (string or array)
  source      TEXT NOT NULL DEFAULT 'seed',  -- 'seed' | 'manual' | 'bot' | 'agent:<name>'
  reason      TEXT,                          -- why this change (LLM tier-1, GSC striking-distance, etc.)
  variant_id  TEXT NOT NULL DEFAULT '',     -- '' = canonical, otherwise variant key (A/B)
  weight      INTEGER DEFAULT 100,           -- 0-100 distribution weight when variants exist
  active      INTEGER NOT NULL DEFAULT 1,    -- soft delete
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (locale, path, field, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_content_locale_path ON content (locale, path) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_content_path ON content (path) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_content_updated ON content (updated_at);

-- ---------------------------------------------------------------------------
-- content_history: full audit log. Append-only.
-- Every UPDATE / DELETE in `content` writes the OLD row here via trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id  INTEGER NOT NULL,
  locale      TEXT NOT NULL,
  path        TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL,
  reason      TEXT,
  variant_id  TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  changed_by  TEXT,                          -- 'mcp:tool_name' | 'system:seed' | 'http:admin'
  change_op   TEXT NOT NULL                  -- 'update' | 'delete'
);
CREATE INDEX IF NOT EXISTS idx_history_content ON content_history (content_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_path ON content_history (locale, path, changed_at DESC);

CREATE TRIGGER IF NOT EXISTS content_history_on_update
AFTER UPDATE ON content
WHEN OLD.value <> NEW.value OR OLD.active <> NEW.active
BEGIN
  INSERT INTO content_history
    (content_id, locale, path, field, value, source, reason, variant_id, active, change_op)
  VALUES
    (OLD.id, OLD.locale, OLD.path, OLD.field, OLD.value, OLD.source, OLD.reason, OLD.variant_id, OLD.active, 'update');
END;

CREATE TRIGGER IF NOT EXISTS content_history_on_delete
AFTER DELETE ON content
BEGIN
  INSERT INTO content_history
    (content_id, locale, path, field, value, source, reason, variant_id, active, change_op)
  VALUES
    (OLD.id, OLD.locale, OLD.path, OLD.field, OLD.value, OLD.source, OLD.reason, OLD.variant_id, OLD.active, 'delete');
END;

-- ---------------------------------------------------------------------------
-- sitemap_extras: SEO-bot-managed priority/changefreq/lastmod overrides
-- The Next.js sitemap.ts can fetch these and merge with auto-generated routes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sitemap_extras (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  locale      TEXT NOT NULL,
  path        TEXT NOT NULL,
  priority    REAL,                          -- 0.0 - 1.0
  changefreq  TEXT,                          -- 'daily' | 'weekly' | etc.
  lastmod     TEXT,                          -- ISO8601
  reason      TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (locale, path)
);

-- ---------------------------------------------------------------------------
-- gsc_snapshots: daily GSC pulls (Phase 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gsc_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site          TEXT NOT NULL,                -- 'sc-domain:csboard.com'
  snapshot_date TEXT NOT NULL,                -- YYYY-MM-DD
  query         TEXT NOT NULL,
  page          TEXT,
  impressions   INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  ctr           REAL NOT NULL DEFAULT 0,
  position      REAL NOT NULL DEFAULT 0,
  country       TEXT,
  device        TEXT,
  fetched_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_gsc_site_date ON gsc_snapshots (site, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_gsc_query ON gsc_snapshots (query, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_gsc_page ON gsc_snapshots (page, snapshot_date) WHERE page IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ga4_snapshots: GA4 daily pulls (Phase 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ga4_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  host          TEXT,
  channel       TEXT,
  landing_page  TEXT,
  sessions      INTEGER NOT NULL DEFAULT 0,
  engaged       INTEGER NOT NULL DEFAULT 0,
  engagement_rate REAL DEFAULT 0,
  fetched_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ga4_date ON ga4_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ga4_landing ON ga4_snapshots (landing_page, snapshot_date) WHERE landing_page IS NOT NULL;

-- ---------------------------------------------------------------------------
-- opportunities: classified action items detected by the analyzer (Phase 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind          TEXT NOT NULL,                -- 'snippet_rewrite' | 'rank_push' | 'content_enrich' | 'ctr_regression' | 'lost_ranking' | 'schema_gap'
  locale        TEXT NOT NULL,
  path          TEXT NOT NULL,
  field         TEXT,                         -- which content.field this targets
  query         TEXT,                         -- driving GSC query (if applicable)
  current_value TEXT,                         -- snapshot of current SEO state
  proposed_value TEXT,                        -- LLM-generated proposal
  metrics       TEXT,                         -- JSON: { impressions, clicks, ctr, position, expected_ctr }
  risk          TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high'
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'applied' | 'rejected' | 'expired'
  applied_at    TEXT,
  applied_content_id INTEGER,                 -- FK to content.id once applied
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_opp_path ON opportunities (locale, path, status);

-- ---------------------------------------------------------------------------
-- llm_cache: OpenRouter response cache to avoid duplicate spend (Phase 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key   TEXT PRIMARY KEY,                -- sha256 of (model + prompt)
  model       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  response    TEXT NOT NULL,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_cache_created ON llm_cache (created_at);

-- ---------------------------------------------------------------------------
-- llm_spend: daily OpenRouter spend tracking (Phase 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_spend (
  spend_date  TEXT PRIMARY KEY,                -- YYYY-MM-DD
  total_usd   REAL NOT NULL DEFAULT 0,
  call_count  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- runs: cron job execution log (Phase 1+)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worker      TEXT NOT NULL,                   -- 'gsc-pull' | 'ga4-pull' | 'analyze' | 'generate' | 'verify'
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed'
  error       TEXT,
  stats       TEXT                             -- JSON: rows fetched, items classified, etc.
);
CREATE INDEX IF NOT EXISTS idx_runs_worker ON runs (worker, started_at DESC);

-- ---------------------------------------------------------------------------
-- meta: schema version
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
