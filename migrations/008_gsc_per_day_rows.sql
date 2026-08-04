-- GSC snapshots become one row per (date, query, page) instead of one row per
-- (pull, query, page) holding a 28-day window total. See src/google/gsc.ts for
-- why the old shape inflated every impression count ~28x.
--
-- Two things are needed for the new shape to be safe:
--   1. the historical rows must go — they are window aggregates stamped on a
--      single date, so mixing them with per-day rows double-counts silently.
--      They are pure derived data; the next pull backfills 90 days from GSC.
--   2. the nightly pull re-fetches a rolling correction window, so the same
--      (site, date, query, page) arrives repeatedly and must upsert, not append.
--      COALESCE(page,'') because SQLite treats NULLs as distinct in UNIQUE.

DELETE FROM gsc_snapshots;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_unique_row
  ON gsc_snapshots (site, snapshot_date, query, COALESCE(page, ''));
