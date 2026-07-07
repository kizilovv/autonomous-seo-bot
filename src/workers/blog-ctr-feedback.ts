// Blog snippet guard + weekly SEO progress digest.
//
// Three passes, weekly (Mon 19:00 UTC):
//
// 1. GUARD — judge blog_meta_history rows changed 14-28 days ago (Google has
//    recrawled by then) against current page-level GSC metrics. Mirrors the
//    content-table ctr-feedback thresholds:
//      improved          : ctr >= baseline*1.10 OR position improved by 2+
//      rolled_back       : ctr <= baseline*0.80 AND baseline_ctr > 0.5%
//                          → restore old_value (only if the live value is
//                            still ours — never clobber a later manual edit)
//      insufficient_data : <10 impressions in the current window
//      flat              : everything else
//
// 2. DETECTOR — published generated_blogs pages ranking well (pos <= 12) with
//    real impressions but near-zero CTR and no pending guard row → these are
//    the next snippet-sweep candidates. Reported, not auto-rewritten (the
//    2026-05-05 death-spiral guard taught us not to let the bot free-run on
//    blogs).
//
// 3. ANCHORS — site totals for the last 7 snapshot days vs the frozen
//    2026-07-07 warpath baseline, so CTR progress lands in Telegram weekly
//    instead of relying on someone remembering to re-pull GSC.
//
// Metrics come from gsc_snapshots (top-5000 query+page rows/day). Absolute
// numbers undercount the long tail, but the methodology is identical week
// over week, so the *trend* is trustworthy.

import { getDb } from "../db/connection.js";
import { startRun, finishRun, failRun } from "../db/repo.js";
import { logger } from "../logger.js";
import { sendMessage, esc, bullets } from "../notify/telegram.js";

const SITE = "sc-domain:csboard.com"; // ru pages live under /ru/ on the same domain

// Frozen 28d baseline captured 2026-07-07, the day the warpath shipped
// (mass meta fix + cannibal 301s + /sell rails). All trend deltas in the
// weekly digest compare against this.
const ANCHOR = {
  capturedAt: "2026-07-07",
  clicksPerDay: 4493 / 28,
  position: 9.7,
  nonBrandCtr: 0.0189,
};

const BRAND_LIKE =
  "(query LIKE '%csboard%' OR query LIKE '%csbord%' OR query LIKE '%cs board%' OR query LIKE '%cs2board%' OR query LIKE '%f1ffy%')";

interface GuardRow {
  id: number;
  blog_id: number;
  locale: string;
  slug: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  baseline_ctr: number | null;
  baseline_impressions: number | null;
  baseline_position: number | null;
}

interface PageAgg {
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

/** Aggregate page-level metrics for a blog slug over the last N snapshot days. */
function pageAgg(slug: string, days: number): PageAgg | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT SUM(impressions) impressions, SUM(clicks) clicks,
              SUM(position * impressions) / NULLIF(SUM(impressions), 0) position
       FROM gsc_snapshots
       WHERE site = ? AND page LIKE ('%/blog/' || ?)
         AND snapshot_date >= (
           SELECT MIN(d) FROM (
             SELECT DISTINCT snapshot_date d FROM gsc_snapshots
             WHERE site = ? ORDER BY d DESC LIMIT ?
           )
         )`
    )
    .get(SITE, slug, SITE, days) as { impressions: number | null; clicks: number | null; position: number | null };
  if (!row || !row.impressions) return null;
  return {
    impressions: row.impressions,
    clicks: row.clicks ?? 0,
    ctr: (row.clicks ?? 0) / row.impressions,
    position: row.position ?? 0,
  };
}

export interface BlogCtrStats {
  guardChecked: number;
  improved: number;
  flat: number;
  rolledBack: number;
  insufficient: number;
  detectorCandidates: number;
}

export async function runBlogCtrFeedback(): Promise<BlogCtrStats> {
  const runId = startRun("blog-ctr-feedback");
  const db = getDb();
  const stats: BlogCtrStats = {
    guardChecked: 0,
    improved: 0,
    flat: 0,
    rolledBack: 0,
    insufficient: 0,
    detectorCandidates: 0,
  };
  const lines: string[] = [];

  try {
    // ── 1. GUARD ─────────────────────────────────────────────────────────
    const pending = db
      .prepare(
        `SELECT id, blog_id, locale, slug, field, old_value, new_value,
                baseline_ctr, baseline_impressions, baseline_position
         FROM blog_meta_history
         WHERE feedback_checked_at IS NULL
           AND changed_at <= datetime('now', '-14 days')
           AND changed_at >= datetime('now', '-28 days')`
      )
      .all() as GuardRow[];

    const judge = db.prepare(
      `UPDATE blog_meta_history
       SET feedback_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), outcome = ?
       WHERE id = ?`
    );

    for (const r of pending) {
      stats.guardChecked++;
      const cur = pageAgg(r.slug, 7);
      if (!cur || cur.impressions < 10) {
        stats.insufficient++;
        judge.run("insufficient_data", r.id);
        continue;
      }
      const base = r.baseline_ctr ?? 0;
      const posImproved =
        r.baseline_position != null && cur.position <= r.baseline_position - 2;
      if (cur.ctr >= base * 1.1 || posImproved) {
        stats.improved++;
        judge.run("improved", r.id);
      } else if (base > 0.005 && cur.ctr <= base * 0.8) {
        // Regression — restore the pre-change value, but only when the live
        // value is still the one we wrote (a later manual edit wins).
        const live = db
          .prepare(`SELECT ${r.field} v FROM generated_blogs WHERE id = ?`)
          .get(r.blog_id) as { v: string | null } | undefined;
        if (live && live.v === r.new_value && r.old_value != null) {
          db.prepare(`UPDATE generated_blogs SET ${r.field} = ? WHERE id = ?`).run(
            r.old_value,
            r.blog_id
          );
          stats.rolledBack++;
          judge.run("rolled_back", r.id);
          lines.push(
            `↩️ rolled back ${r.locale}/${r.slug} ${r.field} (ctr ${(base * 100).toFixed(2)}%→${(cur.ctr * 100).toFixed(2)}%)`
          );
        } else {
          stats.flat++;
          judge.run("flat", r.id); // superseded by a manual edit — hands off
        }
      } else {
        stats.flat++;
        judge.run("flat", r.id);
      }
    }

    // ── 2. DETECTOR — next sweep candidates ─────────────────────────────
    const candidates = db
      .prepare(
        `SELECT gb.locale, gb.slug,
                SUM(gs.impressions) impr, SUM(gs.clicks) clicks,
                SUM(gs.position * gs.impressions) / NULLIF(SUM(gs.impressions), 0) pos
         FROM generated_blogs gb
         JOIN gsc_snapshots gs
           ON gs.site = ? AND gs.page LIKE ('%/blog/' || gb.slug)
          AND gs.snapshot_date >= (
            SELECT MIN(d) FROM (
              SELECT DISTINCT snapshot_date d FROM gsc_snapshots
              WHERE site = ? ORDER BY d DESC LIMIT 7
            )
          )
         WHERE gb.status = 'published'
           AND NOT EXISTS (
             SELECT 1 FROM blog_meta_history h
             WHERE h.blog_id = gb.id AND h.feedback_checked_at IS NULL
           )
         GROUP BY gb.locale, gb.slug
         HAVING impr >= 100 AND pos <= 12 AND (clicks * 1.0 / impr) < 0.01
         ORDER BY impr DESC
         LIMIT 10`
      )
      .all(SITE, SITE) as { locale: string; slug: string; impr: number; clicks: number; pos: number }[];
    stats.detectorCandidates = candidates.length;

    // ── 3. ANCHORS — weekly progress vs the frozen warpath baseline ─────
    const totals = db
      .prepare(
        `SELECT COUNT(DISTINCT snapshot_date) days,
                SUM(clicks) clicks, SUM(impressions) impr,
                SUM(position * impressions) / NULLIF(SUM(impressions), 0) pos
         FROM gsc_snapshots
         WHERE site = ? AND snapshot_date >= (
           SELECT MIN(d) FROM (
             SELECT DISTINCT snapshot_date d FROM gsc_snapshots
             WHERE site = ? ORDER BY d DESC LIMIT 7
           )
         )`
      )
      .get(SITE, SITE) as { days: number; clicks: number; impr: number; pos: number };

    const nonBrand = db
      .prepare(
        `SELECT SUM(clicks) clicks, SUM(impressions) impr
         FROM gsc_snapshots
         WHERE site = ? AND NOT ${BRAND_LIKE}
           AND snapshot_date >= (
             SELECT MIN(d) FROM (
               SELECT DISTINCT snapshot_date d FROM gsc_snapshots
               WHERE site = ? ORDER BY d DESC LIMIT 7
             )
           )`
      )
      .get(SITE, SITE) as { clicks: number | null; impr: number | null };

    const cpd = totals.days ? totals.clicks / totals.days : 0;
    const cpdDelta = ((cpd - ANCHOR.clicksPerDay) / ANCHOR.clicksPerDay) * 100;
    const nbCtr = nonBrand.impr ? (nonBrand.clicks ?? 0) / nonBrand.impr : 0;
    const nbDelta = ((nbCtr - ANCHOR.nonBrandCtr) / ANCHOR.nonBrandCtr) * 100;
    const posDelta = totals.pos - ANCHOR.position;

    const msg = [
      `📈 <b>SEO weekly vs warpath-baseline (${ANCHOR.capturedAt})</b>`,
      `клики/день: <b>${cpd.toFixed(0)}</b> (${cpdDelta >= 0 ? "+" : ""}${cpdDelta.toFixed(0)}%)`,
      `позиция: <b>${(totals.pos ?? 0).toFixed(1)}</b> (${posDelta <= 0 ? "" : "+"}${posDelta.toFixed(1)}; минус=лучше)`,
      `non-brand CTR: <b>${(nbCtr * 100).toFixed(2)}%</b> (${nbDelta >= 0 ? "+" : ""}${nbDelta.toFixed(0)}% к базе 1.89%)`,
      ``,
      `🛡 guard: ${stats.guardChecked} checked / ${stats.improved} improved / ${stats.flat} flat / ${stats.rolledBack} rolled back / ${stats.insufficient} no-data`,
      ...(lines.length ? [bullets(lines.map(esc))] : []),
      ...(candidates.length
        ? [
            ``,
            `🎯 <b>next sweep candidates</b> (pos≤12, CTR&lt;1%, impr≥100/7d):`,
            bullets(
              candidates.map(
                (c) =>
                  `${esc(c.locale)}/${esc(c.slug.slice(0, 60))} — impr ${c.impr}, pos ${c.pos.toFixed(1)}, clicks ${c.clicks}`
              )
            ),
          ]
        : []),
    ].join("\n");

    await sendMessage(msg);
    finishRun(runId, stats);
    logger.info({ stats }, "blog-ctr-feedback done");
    return stats;
  } catch (e) {
    failRun(runId, (e as Error).message);
    throw e;
  }
}
