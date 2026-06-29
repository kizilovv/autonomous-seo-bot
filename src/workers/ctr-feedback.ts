// CTR feedback loop — measures whether bot rewrites actually helped.
//
// For each opportunity that:
//   - status = 'applied'
//   - applied 7-21 days ago (Google has had time to recrawl + rerank)
//   - feedback_checked_at IS NULL
//   - has baseline_ctr / baseline_position / targeted query
//
// Compare:
//   baseline (snapshot at apply moment)  vs  current (latest snapshot for the
//   same query+page)
//
// Outcome buckets:
//   improved          : new_ctr >= baseline_ctr * 1.10  (or position improved by 2+)
//   flat              : within ±10% of baseline
//   rolled_back       : new_ctr <= baseline_ctr * 0.80 AND impressions stayed comparable
//                       → revert content to the prior history value
//   insufficient_data : current snapshot has <10 impressions for the query
//
// On rollback: find the most-recent history row for (locale, path, field)
// PRIOR to applied_content_id, and re-upsert that value.

import { getDb } from "../db/connection.js";
import { startRun, finishRun, failRun } from "../db/repo.js";
import { upsertContent } from "../db/repo.js";
import { logger } from "../logger.js";

interface CandidateRow {
  id: number;
  locale: string;
  path: string;
  field: string | null;
  query: string | null;
  applied_at: string;
  applied_content_id: number;
  baseline_ctr: number | null;
  baseline_position: number | null;
  baseline_impressions: number | null;
}

interface CurrentMetrics {
  ctr: number;
  position: number;
  impressions: number;
}

const SITE_BY_LOCALE: Record<string, string> = {
  en: "sc-domain:csboard.com",
  ru: "sc-domain:csboard.trade",
};

interface Stats {
  checked: number;
  improved: number;
  flat: number;
  rolled_back: number;
  insufficient_data: number;
  errors: number;
  details: string[];
}

function fetchCandidates(): CandidateRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, locale, path, field, query, applied_at, applied_content_id,
              baseline_ctr, baseline_position, baseline_impressions
       FROM opportunities
       WHERE status='applied'
         AND feedback_checked_at IS NULL
         AND query IS NOT NULL
         AND baseline_ctr IS NOT NULL
         AND applied_at <= datetime('now','-7 days')
         AND applied_at >= datetime('now','-21 days')
       ORDER BY applied_at ASC
       LIMIT 200`
    )
    .all() as CandidateRow[];
}

function currentMetricsFor(site: string, query: string): CurrentMetrics | null {
  const db = getDb();
  // Use most-recent snapshot (today's pull). Sum across pages because GSC may
  // have multiple page rows for the same query.
  const r = db
    .prepare(
      `SELECT
         CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL)/SUM(impressions) ELSE 0 END AS ctr,
         CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)/SUM(impressions) ELSE 0 END AS position,
         SUM(impressions) AS impressions
       FROM gsc_snapshots
       WHERE site = ? AND query = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM gsc_snapshots)`
    )
    .get(site, query) as { ctr: number; position: number; impressions: number };
  if (!r || !r.impressions) return null;
  return r;
}

function rollbackTo(opp: CandidateRow): { ok: boolean; history_id?: number; reason?: string } {
  const db = getDb();
  // Find the history entry that immediately preceded the applied content row.
  // content_history_on_update fires AFTER UPDATE, storing the OLD value.
  // So the most recent history row for this content_id contains the value
  // we want to roll back TO.
  const prior = db
    .prepare(
      `SELECT id, value FROM content_history
       WHERE content_id = ? AND change_op = 'update'
       ORDER BY changed_at DESC LIMIT 1`
    )
    .get(opp.applied_content_id) as { id: number; value: string } | undefined;
  if (!prior) {
    return { ok: false, reason: "no prior history to roll back to" };
  }
  let value: unknown;
  try { value = JSON.parse(prior.value); } catch { value = prior.value; }
  const finalValue = typeof value === "string" ? value : JSON.stringify(value);
  upsertContent({
    locale: opp.locale,
    path: opp.path,
    field: opp.field as string,
    value: finalValue,
    source: "bot:rollback",
    reason: `CTR feedback rollback for opp #${opp.id} → history #${prior.id}`,
  });
  return { ok: true, history_id: prior.id };
}

export async function runCtrFeedback(): Promise<Stats> {
  const id = startRun("ctr-feedback");
  const stats: Stats = {
    checked: 0, improved: 0, flat: 0, rolled_back: 0, insufficient_data: 0, errors: 0, details: [],
  };
  try {
    const cands = fetchCandidates();
    const db = getDb();
    for (const opp of cands) {
      stats.checked++;
      const site = SITE_BY_LOCALE[opp.locale];
      if (!site || !opp.query) continue;

      const cur = currentMetricsFor(site, opp.query);
      if (!cur || cur.impressions < 10) {
        db.prepare(
          "UPDATE opportunities SET feedback_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), feedback_outcome = 'insufficient_data' WHERE id = ?"
        ).run(opp.id);
        stats.insufficient_data++;
        continue;
      }

      const baselineCtr = opp.baseline_ctr ?? 0;
      const deltaCtrAbs = cur.ctr - baselineCtr;
      // Define "rolled back" only if drop is real (not noise) and we had non-zero baseline.
      const dropRatio = baselineCtr > 0 ? cur.ctr / baselineCtr : (cur.ctr === 0 ? 1 : 999);
      const positionDelta = (opp.baseline_position ?? 99) - cur.position; // positive = improved (lower pos number)

      let outcome: "improved" | "flat" | "rolled_back";
      if (cur.ctr >= baselineCtr * 1.10 || positionDelta >= 2) {
        outcome = "improved";
      } else if (dropRatio <= 0.80 && baselineCtr > 0.005) {
        outcome = "rolled_back";
      } else {
        outcome = "flat";
      }

      let extra = "";
      if (outcome === "rolled_back") {
        const r = rollbackTo(opp);
        if (r.ok) {
          db.prepare(
            "UPDATE opportunities SET rolled_back_to_history_id = ? WHERE id = ?"
          ).run(r.history_id, opp.id);
          extra = ` → reverted to history #${r.history_id}`;
          stats.rolled_back++;
        } else {
          stats.errors++;
          extra = ` (rollback failed: ${r.reason})`;
        }
      } else if (outcome === "improved") {
        stats.improved++;
      } else {
        stats.flat++;
      }

      db.prepare(
        "UPDATE opportunities SET feedback_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), feedback_outcome = ?, feedback_delta_ctr = ? WHERE id = ?"
      ).run(outcome, deltaCtrAbs, opp.id);

      stats.details.push(
        `#${opp.id} ${opp.locale}${opp.path}/${opp.field} q="${(opp.query ?? "").slice(0, 30)}" base_ctr=${(baselineCtr * 100).toFixed(2)}% → ${(cur.ctr * 100).toFixed(2)}% [${outcome}]${extra}`
      );
    }
    finishRun(id, stats);
    logger.info(stats, "ctr-feedback complete");
    return stats;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
