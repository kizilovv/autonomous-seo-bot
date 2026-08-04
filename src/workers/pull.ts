// Daily GSC + GA4 pull worker.
//
// GSC rows are per-day since 2026-08-05 (dimensions date+query+page) and upsert
// on (site, date, query, page), so this only has to fetch what can still change:
// the last few days, which GSC keeps revising as data finalises. History
// accumulates day by day instead of being re-derived from a window aggregate.
//
// After migration 008 (or on a fresh DB) there is no history at all, so the
// first run backfills BACKFILL_DAYS in week-sized chunks — one 90-day request
// would blow past the row cap and silently drop the tail.

import { pullAll as pullGsc } from "../google/gsc.js";
import { pullLandingPages } from "../google/ga4.js";
import { startRun, finishRun, failRun, purgeOldSnapshots, latestGscSnapshotDate } from "../db/repo.js";
import { logger } from "../logger.js";

const BACKFILL_DAYS = 90;    // well inside the 120-day retention below
const CORRECTION_DAYS = 4;   // GSC keeps revising the last ~3 days
const CHUNK_DAYS = 7;

function offsetDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400_000).toISOString().slice(0, 10);
}

/** Inclusive [since, until] split into <= CHUNK_DAYS windows, oldest first. */
function chunkWindow(since: string, until: string): Array<{ sinceDate: string; untilDate: string }> {
  const out: Array<{ sinceDate: string; untilDate: string }> = [];
  let cursor = since;
  while (cursor <= until) {
    const end = addDays(cursor, CHUNK_DAYS - 1);
    out.push({ sinceDate: cursor, untilDate: end < until ? end : until });
    cursor = addDays(cursor, CHUNK_DAYS);
  }
  return out;
}

export async function runPull(): Promise<{ gsc: { site: string; rows: number }[]; ga4: number; purged: { gsc: number; ga4: number }; backfilled: boolean }> {
  const id = startRun("pull");
  const until = offsetDate(1); // GSC final data is 1-3 days lagged
  const latest = latestGscSnapshotDate();
  // No history → backfill. Otherwise re-fetch from just before our newest day
  // so finalised revisions overwrite the provisional numbers.
  const backfilled = !latest;
  const since = latest
    ? [addDays(latest, -CORRECTION_DAYS), offsetDate(BACKFILL_DAYS)].sort().pop()!
    : offsetDate(BACKFILL_DAYS);

  try {
    const totals = new Map<string, number>();
    for (const win of chunkWindow(since, until)) {
      const part = await pullGsc(win);
      for (const p of part) totals.set(p.site, (totals.get(p.site) ?? 0) + p.rows);
    }
    const gsc = [...totals].map(([site, rows]) => ({ site, rows }));

    // GA4 stays a single window — it is landing-page level, far fewer rows.
    const ga4 = await pullLandingPages({ sinceDate: offsetDate(28), untilDate: until });
    const purged = purgeOldSnapshots(120);
    finishRun(id, { gsc, ga4_rows: ga4, purged, backfilled, since, until });
    logger.info({ gsc, ga4, purged, backfilled, since, until }, "pull complete");
    return { gsc, ga4, purged, backfilled };
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
