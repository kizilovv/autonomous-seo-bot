// CTR feedback: exact page/query, seven complete days before apply vs days 7–13
// after apply. Wait at least sixteen days for recrawl and GSC data finalisation.
// Historical baseline columns remain untouched for audit but are not comparable
// inputs. A rollback also requires sufficient volume and unchanged bot-owned content.

import { getDb } from "../db/connection.js";
import { startRun, finishRun, failRun } from "../db/repo.js";
import { upsertContent, isPinnedField } from "../db/repo.js";
import { logger } from "../logger.js";

export interface CandidateRow {
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
  proposed_value: string;
}

interface CurrentMetrics {
  ctr: number;
  position: number;
  impressions: number;
}

// RU pages live on csboard.com (the .trade property is a 301 shell holding
// ~8% of the rows). Reading feedback from sc-domain:csboard.trade meant every
// RU snippet change was judged against a dead property and scored
// "insufficient data" forever — no RU rewrite has ever been graded.
const SITE_BY_LOCALE: Record<string, string> = {
  en: "sc-domain:csboard.com",
  ru: "sc-domain:csboard.com",
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
              baseline_ctr, baseline_position, baseline_impressions, proposed_value
       FROM opportunities
       WHERE status='applied'
         AND feedback_checked_at IS NULL
         AND query IS NOT NULL
         AND baseline_ctr IS NOT NULL
         AND applied_at <= datetime('now','-16 days')
         AND applied_at >= datetime('now','-45 days')
       ORDER BY applied_at ASC
       LIMIT 200`
    )
    .all() as CandidateRow[];
}

/** Equal seven-day windows for the exact page and query; skip a seven-day
 * recrawl interval. Never compare a query's traffic on unrelated pages. */
export function comparableMetrics(opp: CandidateRow, site: string): { before: CurrentMetrics; after: CurrentMetrics } | null {
  const db = getDb();
  const day = opp.applied_at.slice(0, 10);
  const offset = (n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const page = `https://csboard.com/${opp.locale}${opp.path === "/" ? "" : opp.path}`;
  const read = (start: string, end: string): CurrentMetrics | null => {
    const coverage = db.prepare("SELECT COUNT(DISTINCT snapshot_date) n FROM gsc_snapshots WHERE site = ? AND snapshot_date BETWEEN ? AND ?").get(site, start, end) as { n: number };
    if (coverage.n !== 7) return null;
    const r = db.prepare(`SELECT CAST(SUM(clicks) AS REAL)/SUM(impressions) ctr,
      SUM(position * impressions)/SUM(impressions) position, SUM(impressions) impressions
      FROM gsc_snapshots WHERE site = ? AND query = ? AND page = ? AND snapshot_date BETWEEN ? AND ?`)
      .get(site, opp.query, page, start, end) as CurrentMetrics;
    return r?.impressions ? r : null;
  };
  const before = read(offset(-7), offset(-1));
  const after = read(offset(7), offset(13));
  return before && after ? { before, after } : null;
}

export function rollbackTo(opp: CandidateRow): { ok: boolean; history_id?: number; reason?: string } {
  const db = getDb();
  if (!opp.field || isPinnedField(opp.locale, opp.path, opp.field)) return { ok: false, reason: "field pinned or missing" };
  const current = db.prepare("SELECT value, source FROM content WHERE id = ?").get(opp.applied_content_id) as { value: string; source: string } | undefined;
  const newer = db.prepare("SELECT id FROM opportunities WHERE applied_content_id = ? AND status = 'applied' AND id != ? AND applied_at >= ? LIMIT 1").get(opp.applied_content_id, opp.id, opp.applied_at);
  if (!current || current.source !== "bot:auto" || current.value !== opp.proposed_value || newer) return { ok: false, reason: "content changed since this opportunity" };
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

      const comparison = comparableMetrics(opp, site);
      const cur = comparison?.after;
      if (!cur || !comparison || cur.impressions < 100 || comparison.before.impressions < 100) {
        db.prepare(
          "UPDATE opportunities SET feedback_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), feedback_outcome = 'insufficient_data' WHERE id = ?"
        ).run(opp.id);
        stats.insufficient_data++;
        continue;
      }

      const baselineCtr = comparison.before.ctr;
      const deltaCtrAbs = cur.ctr - baselineCtr;
      // Define "rolled back" only if drop is real (not noise) and we had non-zero baseline.
      const dropRatio = baselineCtr > 0 ? cur.ctr / baselineCtr : (cur.ctr === 0 ? 1 : 999);
      const positionDelta = comparison.before.position - cur.position; // positive = improved (lower pos number)

      // A rewrite counts as an improvement only when CTR moved by a margin worth
      // acting on: +10% relative AND at least +0.2pp absolute.
      //
      // The absolute floor is the whole point. The old test was
      // `cur.ctr >= baselineCtr * 1.10`, and a page whose baseline window earned
      // zero clicks has baselineCtr = 0 — so the right-hand side is 0 and the
      // comparison is true for ANY current CTR, zero included. Every such field
      // was labelled "improved" while nothing had changed: across 950 rows
      // marked improved the MEDIAN delta was 0.000pp, with only the top decile
      // above +7.8pp. The label carried no signal, which is why nothing
      // downstream could use it to decide when to stop rewriting a field.
      const MIN_ABS_CTR_GAIN = 0.002; // 0.2 percentage points
      let outcome: "improved" | "flat" | "rolled_back" | "rollback_skipped";
      if ((cur.ctr >= baselineCtr * 1.10 && deltaCtrAbs >= MIN_ABS_CTR_GAIN) || positionDelta >= 2) {
        outcome = "improved";
      } else if (dropRatio <= 0.80 && baselineCtr > 0.005 && baselineCtr * comparison.before.impressions >= 20 && cur.impressions >= comparison.before.impressions * 0.5 && cur.impressions <= comparison.before.impressions * 2) {
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
          outcome = "rollback_skipped";
          stats.errors++;
          extra = ` (rollback skipped: ${r.reason})`;
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
