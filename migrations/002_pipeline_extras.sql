-- 002 — small tweaks for Phase 1-4 workers.

-- Telegram callbacks (Phase 3) — track which opportunities the user approved/rejected via inline buttons.
ALTER TABLE opportunities ADD COLUMN telegram_message_id INTEGER;
ALTER TABLE opportunities ADD COLUMN reviewer TEXT;
ALTER TABLE opportunities ADD COLUMN reviewed_at TEXT;

-- llm_spend monthly rollup (separate from daily) for budget caps.
CREATE TABLE IF NOT EXISTS llm_spend_monthly (
  spend_month TEXT PRIMARY KEY,                  -- YYYY-MM
  total_usd   REAL NOT NULL DEFAULT 0,
  call_count  INTEGER NOT NULL DEFAULT 0
);

-- Indexed lookups frequently used by the classifier.
CREATE INDEX IF NOT EXISTS idx_gsc_query_position ON gsc_snapshots (snapshot_date, position) WHERE query IS NOT NULL;
