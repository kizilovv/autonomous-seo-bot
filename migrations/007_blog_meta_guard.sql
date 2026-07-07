-- 007: revert-guard history for generated_blogs meta edits.
--
-- generated_blogs has no history table (unlike `content` with its trigger),
-- so meta sweeps were fire-and-forget. This table records every meta change
-- (old + new + GSC baseline at change time) so the blog-ctr-feedback worker
-- can measure the effect after Google recrawls and auto-revert regressions.

CREATE TABLE IF NOT EXISTS blog_meta_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id              INTEGER NOT NULL,           -- generated_blogs.id
  locale               TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  field                TEXT NOT NULL,              -- 'meta_title' | 'meta_description' | 'title'
  old_value            TEXT,
  new_value            TEXT,
  source               TEXT NOT NULL,              -- 'sweep:<date>' | 'worker:blog-ctr-feedback'
  baseline_ctr         REAL,                       -- page-level CTR before the change (28d agg)
  baseline_position    REAL,
  baseline_impressions INTEGER,
  changed_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  feedback_checked_at  TEXT,                       -- NULL = guard hasn't judged yet
  outcome              TEXT                        -- improved | flat | rolled_back | insufficient_data
);

CREATE INDEX IF NOT EXISTS idx_bmh_pending
  ON blog_meta_history (changed_at)
  WHERE feedback_checked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bmh_blog
  ON blog_meta_history (blog_id, field);
