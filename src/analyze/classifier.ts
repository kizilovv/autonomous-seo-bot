// Classifier — turns GSC snapshots into actionable opportunities.
//
// Five kinds detected (Phase 2):
//   - snippet_rewrite : page in top 10 but CTR < 50% of expected — rewrite title/description
//   - rank_push       : pos 4-10 with decent impressions — H1/intro/internal-link push to top-3
//   - content_enrich  : pos 11-20 — page-2 lift; needs section enrichment
//   - ctr_regression  : same position vs prior window but clicks dropped >30% — snippet broke
//   - lost_ranking    : was top 10, now > 30 — alarm only, no auto-action
//
// We DO NOT generate proposals here; that's the generator step.
// Each detected row becomes a row in `opportunities` with proposed_value=null.

import { aggregateQueries, insertOpportunity, type OpportunityKind, getPageContent } from "../db/repo.js";
import { gscSites, brandTermsRegex } from "../config.js";
import { logger } from "../logger.js";

// Approximate CTR by SERP position (Google study averages, smoothed).
const EXPECTED_CTR: Record<number, number> = {
  1: 0.27, 2: 0.16, 3: 0.10, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.015,
};

interface ClassifyResult {
  detected: number;
  byKind: Record<OpportunityKind, number>;
}

/** Map a GSC page URL to (locale, path). */
function urlToLocalePath(url: string | null): { locale: string; path: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const locale = segs[0] === "en" || segs[0] === "ru" ? segs[0] : "en";
    const path = "/" + segs.slice(locale === segs[0] ? 1 : 0).join("/");
    return { locale, path: path === "/" ? "/" : path };
  } catch {
    return null;
  }
}

function expectedCtrFor(position: number): number {
  const p = Math.max(1, Math.min(10, Math.round(position)));
  return EXPECTED_CTR[p] ?? 0.015;
}

// Aggressive detection — every long-tail query with at least a handful of impressions
// becomes an opportunity. We rely on later filters (de-dup + budget cap + risk gate)
// to keep the volume sane.
const MIN_IMPRESSIONS_FOR_DETECTION = 5;

export async function classifyAllSites(args: {
  currSince: string;
  currUntil: string;
  prevSince?: string;
  prevUntil?: string;
}): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    detected: 0,
    byKind: { snippet_rewrite: 0, rank_push: 0, content_enrich: 0, ctr_regression: 0, lost_ranking: 0, schema_gap: 0 },
  };

  const brandRe = brandTermsRegex();

  for (const site of gscSites()) {
    logger.info({ site }, "classifier: site start");
    const curr = aggregateQueries(site, args.currSince, args.currUntil);
    const prev = args.prevSince && args.prevUntil ? aggregateQueries(site, args.prevSince, args.prevUntil) : [];
    const prevByQuery = new Map<string, (typeof prev)[number]>();
    for (const r of prev) prevByQuery.set(r.query, r);

    for (const r of curr) {
      if ((r.impressions || 0) < MIN_IMPRESSIONS_FOR_DETECTION) continue;
      // Brand queries are usually navigational — skip if a brand regex is configured.
      if (brandRe && brandRe.test(r.query)) continue;
      if (!r.page) continue;

      const lp = urlToLocalePath(r.page);
      if (!lp) continue;

      const pos = r.position;

      if (pos >= 1 && pos <= 10) {
        const expected = expectedCtrFor(pos);
        if (r.impressions >= 30 && r.ctr < expected * 0.8) {
          insertOpportunity({
            kind: "snippet_rewrite",
            locale: lp.locale,
            path: lp.path,
            field: "description",
            query: r.query,
            current_value: null,
            proposed_value: null,
            metrics: { impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, expected_ctr: expected, position: pos },
            risk: "low",
            notes: `top-${Math.round(pos)} ranking earns CTR ${(r.ctr*100).toFixed(2)}% vs expected ${(expected*100).toFixed(1)}%`,
          });
          result.detected++; result.byKind.snippet_rewrite++;
        }

        if (pos >= 4 && pos <= 10 && r.impressions >= 10) {
          const pc = getPageContent(lp.locale, lp.path);
          const hay = `${(pc.fields.h1 ?? "") as string} ${(pc.fields.intro ?? "") as string}`.toLowerCase();
          if (!hay.includes(r.query.toLowerCase())) {
            insertOpportunity({
              kind: "rank_push",
              locale: lp.locale,
              path: lp.path,
              field: "intro_extra",
              query: r.query,
              current_value: pc.fields.intro ? String(pc.fields.intro) : null,
              proposed_value: null,
              metrics: { impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: pos },
              risk: "low",
              notes: `query not yet in H1/intro — append data-bound paragraph mentioning it`,
            });
            result.detected++; result.byKind.rank_push++;
          }
        }
      }

      if (pos > 10 && pos <= 20 && r.impressions >= 10) {
        insertOpportunity({
          kind: "content_enrich",
          locale: lp.locale,
          path: lp.path,
          field: "faq",
          query: r.query,
          current_value: null,
          proposed_value: null,
          metrics: { impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: pos },
          risk: "medium",
          notes: `page-2 lift — add an FAQ item or paragraph addressing this query intent`,
        });
        result.detected++; result.byKind.content_enrich++;
      }

      if (pos <= 10 && prevByQuery.has(r.query)) {
        const p = prevByQuery.get(r.query)!;
        const positionDelta = Math.abs(pos - p.position);
        const clickDrop = p.clicks > 0 ? (p.clicks - r.clicks) / p.clicks : 0;
        if (positionDelta < 1.5 && clickDrop > 0.3 && p.clicks >= 5) {
          insertOpportunity({
            kind: "ctr_regression",
            locale: lp.locale,
            path: lp.path,
            field: "description",
            query: r.query,
            current_value: null,
            proposed_value: null,
            metrics: { impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: pos, prev_clicks: p.clicks, click_drop_pct: clickDrop * 100 },
            risk: "low",
            notes: `clicks dropped ${(clickDrop*100).toFixed(0)}% at same SERP position — snippet may have broken`,
          });
          result.detected++; result.byKind.ctr_regression++;
        }
      }

      if (pos > 30 && prevByQuery.has(r.query)) {
        const p = prevByQuery.get(r.query)!;
        if (p.position <= 10 && r.impressions >= 5) {
          insertOpportunity({
            kind: "lost_ranking",
            locale: lp.locale,
            path: lp.path,
            field: null,
            query: r.query,
            current_value: null,
            proposed_value: null,
            metrics: { impressions: r.impressions, clicks: r.clicks, position: pos, prev_position: p.position },
            risk: "high",
            notes: `was pos ${p.position.toFixed(1)}, now ${pos.toFixed(1)} — manual review`,
          });
          result.detected++; result.byKind.lost_ranking++;
        }
      }
    }
  }

  return result;
}
