// Daily GSC + GA4 pull worker. Stores aggregated rows under today's date.
// Idempotent if run twice the same day — we DON'T dedupe yet, but stats reports
// from the same day will see consistent totals because we group by snapshot_date in queries.

import { pullAll as pullGsc } from "../google/gsc.js";
import { pullLandingPages } from "../google/ga4.js";
import { startRun, finishRun, failRun, purgeOldSnapshots } from "../db/repo.js";
import { logger } from "../logger.js";

function offsetDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

export async function runPull(): Promise<{ gsc: { site: string; rows: number }[]; ga4: number; purged: { gsc: number; ga4: number } }> {
  const id = startRun("pull");
  const since = offsetDate(28);
  const until = offsetDate(1); // GSC final data is usually 1-3 days lagged
  try {
    const gsc = await pullGsc({ sinceDate: since, untilDate: until });
    const ga4 = await pullLandingPages({ sinceDate: since, untilDate: until });
    const purged = purgeOldSnapshots(120);
    finishRun(id, { gsc, ga4_rows: ga4, purged });
    logger.info({ gsc, ga4, purged }, "pull complete");
    return { gsc, ga4, purged };
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
