// Classifier — turns GSC snapshots into actionable opportunities.
//
// Five kinds it detects (Phase 2):
//   - snippet_rewrite : page in top 10 but CTR < 50% of expected — rewrite title/description
//   - rank_push       : pos 4-10 with decent impressions — H1/intro/internal-link push to top-3
//   - content_enrich  : pos 11-20 — page-2 lift; needs section enrichment
//   - ctr_regression  : same position vs prior window but clicks dropped >30% — snippet broke
//   - lost_ranking    : was top 10, now > 30 — alarm only, no auto-action
//
// We DO NOT generate proposals here; that's the generator step.
// Each detected row becomes a row in `opportunities` with proposed_value=null.

import { aggregateQueries, insertOpportunity, type OpportunityKind, getPageContent } from "../db/repo.js";
import { gscSites } from "../config.js";
import { logger } from "../logger.js";

// Approximate CTR by SERP position (Google study averages, smoothed).
const EXPECTED_CTR: Record<number, number> = {
  1: 0.27, 2: 0.16, 3: 0.10, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.015,
};

const CSBOARD_BRAND_RE = /csboard|cs ?board|cstrade|csboardtrade/i;

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

// Per-kind minimum impressions to surface an opportunity. Bumped from a flat
// 5 (2026-04) → field-aware floors (2026-05-06) — we kept generating proposals
// for trash long-tail (5 imp/mo) which produced AI-slop content with zero
// payback. Snippet rewrites are still cheap so the bar there stays low; body
// content (intro_extra/faq) requires real demand to justify modifying the page.
const MIN_IMPS_BY_KIND: Record<string, number> = {
  snippet_rewrite: 15,
  ctr_regression: 15,
  rank_push: 30,
  content_enrich: 30,
  lost_ranking: 5,
  schema_gap: 5,
};
const MIN_IMPRESSIONS_FOR_DETECTION = 15; // generic floor; per-kind in classify()

/**
 * Only these path prefixes render CMS `intro_extra` / `faq` body fields via
 * <SeoContent>. Writing intro_extra to other paths is a no-op — the value
 * lives in the DB but never gets rendered, so the SEO push doesn't land.
 * Sources: cs2-tradeboard-frontend audit 2026-05-13 — only layouts that
 * import `@/components/seo/SeoContent` are eligible.
 *
 * Snippet rewrites (title/description) work everywhere — they're consumed by
 * `lib/seo.ts` `generateMetadata` which is wired into every layout.
 */
const BODY_CMS_PATHS = [
  "/",          // home (home)/layout.tsx
  "/sell",
  "/trades",
  "/comparison",
  "/trends",
  "/cs2-trading-sites",
  "/premium",
  "/create-offer",
  "/cs2-trading",
  "/cs2-marketplace",
  "/cs2-skins-prices",
] as const;

function bodyCmsRenders(path: string): boolean {
  if (BODY_CMS_PATHS.includes(path as typeof BODY_CMS_PATHS[number])) return true;
  // /items/[name], /blog/[slug], /weapons/[weapon], /profile/[steamId] all
  // render their own content and ignore CMS intro_extra/faq fields.
  return false;
}

export async function classifyAllSites(args: {
  // Window for the "current" snapshot (e.g. last 28 days).
  currSince: string;
  currUntil: string;
  // Optional prior window for regression detection (e.g. previous 28 days).
  prevSince?: string;
  prevUntil?: string;
}): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    detected: 0,
    byKind: { snippet_rewrite: 0, rank_push: 0, content_enrich: 0, ctr_regression: 0, lost_ranking: 0, schema_gap: 0, competitor_gap: 0 },
  };

  for (const site of gscSites()) {
    logger.info({ site }, "classifier: site start");
    const curr = aggregateQueries(site, args.currSince, args.currUntil);
    // Build a query→aggregate map for prev window if provided
    const prev = args.prevSince && args.prevUntil ? aggregateQueries(site, args.prevSince, args.prevUntil) : [];
    const prevByQuery = new Map<string, (typeof prev)[number]>();
    for (const r of prev) prevByQuery.set(r.query, r);

    for (const r of curr) {
      if ((r.impressions || 0) < MIN_IMPRESSIONS_FOR_DETECTION) continue;
      // Brand queries are usually navigational — skip
      if (CSBOARD_BRAND_RE.test(r.query)) continue;
      if (!r.page) continue;
      // Skip non-canonical hosts (www., http://) — they are duplicates that
      // GSC reports separately. We only want canonical pages.
      if (/^https?:\/\/www\./i.test(r.page) || /^http:\/\//i.test(r.page)) continue;

      const lp = urlToLocalePath(r.page);
      if (!lp) continue;

      const pos = r.position;

      // ---------- snippet_rewrite (top-10 underperforming CTR) ----------
      if (pos >= 1 && pos <= 10) {
        const expected = expectedCtrFor(pos);
        if (r.impressions >= MIN_IMPS_BY_KIND.snippet_rewrite && r.ctr < expected * 0.8) {
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

        // ---------- rank_push (pos 4-10 striking distance) ----------
        // Skip paths where intro_extra/faq aren't rendered — wasted work.
        if (pos >= 4 && pos <= 10 && r.impressions >= MIN_IMPS_BY_KIND.rank_push && bodyCmsRenders(lp.path)) {
          // Only push if the query is NOT already in the page's H1/intro
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

      // ---------- content_enrich (page-2 lift) ----------
      // Same guard — faq writes are ignored on /items, /blog, /weapons paths.
      if (pos > 10 && pos <= 20 && r.impressions >= MIN_IMPS_BY_KIND.content_enrich && bodyCmsRenders(lp.path)) {
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

      // ---------- ctr_regression (same position, fewer clicks) ----------
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

      // ---------- lost_ranking (was top-10, now >30) ----------
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
