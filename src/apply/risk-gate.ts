// Risk gate — decides whether an opportunity can be auto-applied.
//
// Auto-apply (low-risk only):
//   - snippet_rewrite + ctr_regression : title/description rewrites for top-10 underperformers.
//     These are pure metadata; site behavior unchanged. Easy to roll back.
//
// Manual review (medium):
//   - rank_push (intro_extra) : changes visible body text on a page. Send to Telegram.
//   - content_enrich (FAQ append) : adds visible FAQ items + JSON-LD schema. Send to Telegram.
//
// Never auto:
//   - lost_ranking : something deeper is wrong, agent can't fix it
//   - schema_gap : rare, manual decisions

import type { OpportunityRow } from "../db/repo.js";
import { config } from "../config.js";

export type RiskDecision = "auto" | "review" | "block";

export interface GateResult {
  decision: RiskDecision;
  reason: string;
}

const HARD_DAILY_AUTO_CAP_FACTOR = 1.0; // multiplied with config.MAX_AUTO_CHANGES_PER_DAY

export function decide(opp: OpportunityRow, autoCountToday: number): GateResult {
  if (!config.AUTO_APPLY_LOW_RISK) {
    return { decision: "review", reason: "AUTO_APPLY_LOW_RISK=false (observation mode)" };
  }
  if (autoCountToday >= Math.floor(config.MAX_AUTO_CHANGES_PER_DAY * HARD_DAILY_AUTO_CAP_FACTOR)) {
    return { decision: "review", reason: `daily auto-cap ${config.MAX_AUTO_CHANGES_PER_DAY} reached` };
  }
  switch (opp.kind) {
    case "snippet_rewrite":
    case "ctr_regression":
      if (opp.proposed_value && opp.field && (opp.field === "title" || opp.field === "description")) {
        return { decision: "auto", reason: "metadata rewrite (title/description)" };
      }
      return { decision: "review", reason: "snippet generator returned non-meta proposal" };

    case "rank_push":
      // intro_extra is APPENDED below the existing intro (it doesn't replace it).
      // Quality gates in the generator already enforce length + brand-fact alignment.
      if (opp.proposed_value && opp.field === "intro_extra") {
        return { decision: "auto", reason: "rank-push paragraph (append-only)" };
      }
      return { decision: "review", reason: "rank_push generator returned non-intro proposal" };

    case "content_enrich":
      // FAQ append — applier reads existing FAQ, pushes new {q,a}, writes back.
      if (opp.proposed_value && opp.field === "faq") {
        return { decision: "auto", reason: "FAQ item append" };
      }
      return { decision: "review", reason: "content_enrich generator returned non-faq proposal" };

    case "lost_ranking":
      return { decision: "block", reason: "ranking loss requires manual investigation" };

    case "schema_gap":
      return { decision: "review", reason: "schema changes need manual approval" };

    default:
      return { decision: "review", reason: "unknown opportunity kind" };
  }
}
