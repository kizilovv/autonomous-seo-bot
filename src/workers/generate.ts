// Generate proposals for `pending` opportunities that don't have one yet.
// Tier-1 free models first, fall back to paid; cache hits don't count toward spend.
// Stops early if the daily budget cap is hit.

import { pendingOpportunitiesNeedingProposal, setProposal, rejectOpportunity, getPageContent, type OpportunityRow } from "../db/repo.js";
import { startRun, finishRun, failRun } from "../db/repo.js";
import { genSnippet, genIntroExtra, genFaqItem, genRegressionFix } from "../generate/generators.js";
import { budgetExceeded } from "../llm/openrouter.js";
import { logger } from "../logger.js";
import { runGate, runGateForFaqItem } from "../quality/gate.js";
import { getDb } from "../db/connection.js";

interface GenerateStats {
  generated: number;
  cached: number;
  failed: number;
  total_cost_usd: number;
  budget_stopped: boolean;
}

// Per-run cap on how many proposals to generate. Set higher than apply's
// MAX_AUTO_CHANGES_PER_DAY so the apply worker never blocks on missing proposals.
const PER_RUN_LIMIT = 400;

/** Two queries share intent if their non-stopword token bags overlap >= 60%. */
function sameIntent(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const tokenize = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^\w\sа-яё]/giu, " ").split(/\s+/)
        .filter((t) => t.length >= 3)
    );
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (!sa.size || !sb.size) return false;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size;
  return uni > 0 && inter / uni >= 0.6;
}

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
    case "competitor_gap":
      throw new Error(`${opp.kind} is not auto-generatable`);
  }
}

export async function runGenerate(): Promise<GenerateStats> {
  const id = startRun("generate");
  const stats: GenerateStats = { generated: 0, cached: 0, failed: 0, total_cost_usd: 0, budget_stopped: false };
  try {
    const queue = pendingOpportunitiesNeedingProposal(PER_RUN_LIMIT);

    // Per-page+query dedup pass: collapse opportunities targeting the same
    // (page, intent) so the same blurb isn't generated 3-5 times for variant
    // queries like "scar 20 zinc" / "скар 20 цинк" / "цинк скар".
    const seen = new Set<string>();
    const filteredQueue: typeof queue = [];
    for (const opp of queue) {
      // Bucket by (locale, path, field, query-token-bag).
      const tokens = (opp.query ?? "")
        .toLowerCase()
        .replace(/[^\w\sа-яё]/giu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3)
        .sort()
        .join("+");
      const key = `${opp.locale}:${opp.path}:${opp.field}:${tokens}`;
      if (seen.has(key)) {
        rejectOpportunity(opp.id, "dedup: same page+field+intent already queued");
        continue;
      }
      seen.add(key);

      // Skip if THIS exact field+query was already applied in last 7 days
      // (true repeat). Different queries targeting the same field are OK —
      // each one needs its own rewrite. Previous logic blocked all variants.
      // Match by token-bag so "ump-45 фрагмент" and "ump 45 фрагмент" count
      // as the same intent.
      const recent = getDb()
        .prepare(
          `SELECT query FROM opportunities WHERE status='applied' AND locale=? AND path=? AND field=? AND applied_at >= datetime('now','-7 days') AND query IS NOT NULL`
        )
        .all(opp.locale, opp.path, opp.field) as Array<{ query: string }>;
      if (recent.some((row) => sameIntent(row.query, opp.query))) {
        rejectOpportunity(opp.id, "cooldown: same field+query intent applied <7d ago");
        continue;
      }
      filteredQueue.push(opp);
    }

    for (const opp of filteredQueue) {
      const b = budgetExceeded();
      if (!b.ok) {
        stats.budget_stopped = true;
        logger.warn({ reason: b.reason }, "stopping generate — budget cap reached");
        break;
      }
      try {
        const result = await generateOne(opp);
        const value = result.value;

        // Pull current CMS value for similarity check.
        const pc = getPageContent(opp.locale, opp.path);
        const currentRaw = pc.fields[opp.field as string];
        const currentStr =
          typeof currentRaw === "string"
            ? currentRaw
            : currentRaw == null
              ? null
              : JSON.stringify(currentRaw);

        // Quality gate.
        if (opp.field === "faq") {
          const gate = runGateForFaqItem(value as { q: string; a: string }, opp.query, opp.locale as "en" | "ru");
          if (!gate.ok) {
            stats.failed++;
            rejectOpportunity(opp.id, `quality-gate: ${gate.reason}`);
            continue;
          }
        } else {
          const gate = runGate({
            text: typeof value === "string" ? value : JSON.stringify(value),
            query: opp.query,
            field: opp.field as string,
            current: currentStr,
            locale: opp.locale as "en" | "ru",
          });
          if (!gate.ok) {
            stats.failed++;
            rejectOpportunity(opp.id, `quality-gate: ${gate.reason}`);
            continue;
          }
        }

        // Proposed_value is JSON-encoded so we can store either string or {q,a}
        const encoded = JSON.stringify(value);
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
