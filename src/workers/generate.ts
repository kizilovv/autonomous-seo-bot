// Generate proposals for `pending` opportunities that don't have one yet.
// Tier-1 free models first, fall back to paid; cache hits don't count toward spend.
// Stops early if the daily budget cap is hit.

import { pendingOpportunitiesNeedingProposal, setProposal, rejectOpportunity, type OpportunityRow } from "../db/repo.js";
import { startRun, finishRun, failRun } from "../db/repo.js";
import { genSnippet, genIntroExtra, genFaqItem, genRegressionFix } from "../generate/generators.js";
import { budgetExceeded } from "../llm/openrouter.js";
import { logger } from "../logger.js";

interface GenerateStats {
  generated: number;
  cached: number;
  failed: number;
  total_cost_usd: number;
  budget_stopped: boolean;
}

const PER_RUN_LIMIT = 200;

async function generateOne(opp: OpportunityRow & { id: number }) {
  switch (opp.kind) {
    case "snippet_rewrite":
      return genSnippet(opp);
    case "ctr_regression":
      return genRegressionFix(opp);
    case "rank_push":
      return genIntroExtra(opp);
    case "content_enrich":
      return genFaqItem(opp);
    case "lost_ranking":
    case "schema_gap":
      throw new Error(`${opp.kind} is not auto-generatable`);
  }
}

export async function runGenerate(): Promise<GenerateStats> {
  const id = startRun("generate");
  const stats: GenerateStats = { generated: 0, cached: 0, failed: 0, total_cost_usd: 0, budget_stopped: false };
  try {
    const queue = pendingOpportunitiesNeedingProposal(PER_RUN_LIMIT);
    for (const opp of queue) {
      const b = budgetExceeded();
      if (!b.ok) {
        stats.budget_stopped = true;
        logger.warn({ reason: b.reason }, "stopping generate — budget cap reached");
        break;
      }
      try {
        const result = await generateOne(opp);
        // Proposed_value is JSON-encoded so we can store either string or {q,a}
        const encoded = JSON.stringify(result.value);
        setProposal(opp.id, encoded);
        if (result.llm.cached) stats.cached++;
        stats.generated++;
        stats.total_cost_usd += result.llm.cost_usd;
      } catch (e) {
        stats.failed++;
        logger.warn({ id: opp.id, kind: opp.kind, err: (e as Error).message }, "generator failed");
        // soft-reject so we don't keep retrying forever
        rejectOpportunity(opp.id, `generator: ${(e as Error).message}`.slice(0, 200));
      }
    }
    finishRun(id, stats);
    return stats;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
