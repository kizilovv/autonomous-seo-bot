// Auto-applier — writes approved opportunities to the SEO content table.
// All low-risk kinds auto-apply now (snippet_rewrite, ctr_regression, rank_push, content_enrich).
// content_enrich does an APPEND to the existing FAQ array, not a replace.
// blocked + non-auto opportunities stay in the `opportunities` table; the
// daily-report worker summarises them in the single daily Telegram digest.

import { upsertContent, getPageContent, applyOpportunity, rejectOpportunity, pendingOpportunitiesReady, type OpportunityRow } from "../db/repo.js";
import { decide } from "./risk-gate.js";
import { logger } from "../logger.js";
import { getDb } from "../db/connection.js";

interface ApplyStats {
  auto_applied: number;
  sent_for_review: number;
  blocked: number;
  errors: number;
  details: string[];
}

function autoCountToday(): number {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM opportunities WHERE status='applied' AND substr(applied_at,1,10) = ?")
    .get(today) as { n: number };
  return r.n;
}

async function applyAuto(opp: OpportunityRow & { id: number }): Promise<{ ok: boolean; contentId?: number; err?: string }> {
  if (!opp.field || !opp.proposed_value) return { ok: false, err: "missing field/value" };
  let value: unknown;
  try { value = JSON.parse(opp.proposed_value); } catch { value = opp.proposed_value; }

  // FAQ items are APPENDED to the existing array, not replaced.
  if (opp.field === "faq") {
    const pc = getPageContent(opp.locale, opp.path);
    const existing = Array.isArray(pc.fields.faq) ? (pc.fields.faq as unknown[]) : [];
    const item = value as { q?: string; a?: string };
    if (!item || typeof item.q !== "string" || typeof item.a !== "string") {
      return { ok: false, err: "faq proposal not {q,a}" };
    }
    // De-dup: don't append if same Q already exists.
    if (existing.some((x: any) => typeof x?.q === "string" && x.q.trim().toLowerCase() === item.q!.trim().toLowerCase())) {
      return { ok: false, err: "faq item duplicate" };
    }
    const next = [...existing, item];
    const result = upsertContent({
      locale: opp.locale,
      path: opp.path,
      field: "faq",
      value: next,
      source: "bot:auto",
      reason: `content_enrich append: ${opp.query ?? ""} | ${opp.notes ?? ""}`.slice(0, 240),
    });
    applyOpportunity(opp.id, result.id);
    return { ok: true, contentId: result.id };
  }

  // intro_extra, title, description — simple upsert of value.
  const finalValue = typeof value === "string" ? value : JSON.stringify(value);
  const result = upsertContent({
    locale: opp.locale,
    path: opp.path,
    field: opp.field,
    value: finalValue,
    source: "bot:auto",
    reason: `${opp.kind}: ${opp.query ?? ""} | ${opp.notes ?? ""}`.slice(0, 240),
  });
  applyOpportunity(opp.id, result.id);
  return { ok: true, contentId: result.id };
}

export async function runApply(limit = 30): Promise<ApplyStats> {
  const stats: ApplyStats = { auto_applied: 0, sent_for_review: 0, blocked: 0, errors: 0, details: [] };
  const pending = pendingOpportunitiesReady(limit);

  for (const opp of pending) {
    try {
      const todayAuto = autoCountToday();
      const gate = decide(opp, todayAuto);
      if (gate.decision === "auto") {
        const r = await applyAuto(opp);
        if (r.ok) {
          stats.auto_applied++;
          stats.details.push(`✓ #${opp.id} ${opp.locale}${opp.path}/${opp.field} (auto)`);
        } else {
          stats.errors++;
          stats.details.push(`✗ #${opp.id} ${r.err}`);
          rejectOpportunity(opp.id, r.err ?? "auto-apply failed");
        }
      } else if (gate.decision === "review") {
        // No spam — opportunity stays in 'pending' status, daily-report summarises it.
        stats.sent_for_review++;
        stats.details.push(`👁 #${opp.id} ${opp.kind} → daily-report (${gate.reason})`);
      } else {
        stats.blocked++;
        rejectOpportunity(opp.id, `blocked by gate: ${gate.reason}`);
        stats.details.push(`⛔ #${opp.id} ${gate.reason}`);
      }
    } catch (e) {
      stats.errors++;
      logger.error({ id: opp.id, err: (e as Error).message }, "apply error");
      stats.details.push(`✗ #${opp.id} ${(e as Error).message}`);
    }
  }

  return stats;
}
