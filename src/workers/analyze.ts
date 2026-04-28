// Detect opportunities from the latest snapshots.
// Uses last 28 days vs the 28 days prior for regression detection.

import { classifyAllSites } from "../analyze/classifier.js";
import { startRun, finishRun, failRun, expireOldOpportunities } from "../db/repo.js";
import { logger } from "../logger.js";

function offsetDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

export async function runAnalyze() {
  const id = startRun("analyze");
  try {
    expireOldOpportunities(7);
    const result = await classifyAllSites({
      currSince: offsetDate(28),
      currUntil: offsetDate(1),
      prevSince: offsetDate(56),
      prevUntil: offsetDate(29),
    });
    finishRun(id, result);
    logger.info(result, "analyze complete");
    return result;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
