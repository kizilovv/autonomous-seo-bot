// Detect opportunities from the latest snapshots.
// Uses last 28 days vs the 28 days prior for regression detection.

import { classifyAllSites } from "../analyze/classifier.js";
import { startRun, finishRun, failRun, expireOldOpportunities, latestGscSnapshotDate } from "../db/repo.js";
import { logger } from "../logger.js";

function offsetDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

/**
 * Anchor on the newest day we hold, not on today — GSC finalises 1-3 days late,
 * so a today-anchored window is short by however far behind the data is, and
 * the prev-window comparison inherits that skew.
 */
function anchor(): string {
  return latestGscSnapshotDate() ?? offsetDate(1);
}

function back(from: string, days: number): string {
  return new Date(Date.parse(from + "T00:00:00Z") - days * 86400_000).toISOString().slice(0, 10);
}

export async function runAnalyze() {
  const id = startRun("analyze");
  try {
    expireOldOpportunities(7);
    const a = anchor();
    const result = await classifyAllSites({
      currSince: back(a, 27),
      currUntil: a,
      prevSince: back(a, 55),
      prevUntil: back(a, 28),
    });
    finishRun(id, result);
    logger.info(result, "analyze complete");
    return result;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
