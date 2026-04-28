-- 003 — full-blog generation system.
-- Bot picks high-impression page-3+ query clusters with no dedicated page,
-- writes a 1200-1800 word post, stores it here.
-- Frontend reads via GET /v1/blog/post?locale=&slug=

CREATE TABLE IF NOT EXISTS generated_blogs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL,
  locale        TEXT NOT NULL,
  title         TEXT NOT NULL,
  meta_title    TEXT,
  meta_description TEXT,
  excerpt       TEXT,
  body_html     TEXT NOT NULL,                        -- final rendered HTML
  body_md       TEXT,                                 -- LLM markdown source for diff/regen
  primary_query TEXT NOT NULL,                        -- the GSC query this targets
  secondary_queries TEXT,                             -- JSON array of related queries
  category      TEXT,
  tags          TEXT,                                 -- JSON array of strings
  cover_image   TEXT,                                 -- optional
  word_count    INTEGER,
  faq           TEXT,                                 -- JSON array of {q,a}, embedded in page
  status        TEXT NOT NULL DEFAULT 'draft',        -- draft | published | retired
  published_at  TEXT,
  generated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_model  TEXT,
  cost_usd      REAL,
  UNIQUE (locale, slug)
);
CREATE INDEX IF NOT EXISTS idx_blogs_locale_status ON generated_blogs (locale, status);
CREATE INDEX IF NOT EXISTS idx_blogs_published ON generated_blogs (published_at) WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blogs_query ON generated_blogs (primary_query);

-- Blog-topic queue: clusters detected from GSC waiting to be turned into a post.
CREATE TABLE IF NOT EXISTS blog_topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  primary_query TEXT NOT NULL,
  locale        TEXT NOT NULL,
  cluster_queries TEXT,                              -- JSON array of related queries
  total_impressions INTEGER NOT NULL,
  avg_position  REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',      -- queued | generating | generated | skipped
  blog_id       INTEGER,                              -- FK to generated_blogs.id once written
  detected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (locale, primary_query)
);
CREATE INDEX IF NOT EXISTS idx_topics_status ON blog_topics (status, total_impressions DESC);
