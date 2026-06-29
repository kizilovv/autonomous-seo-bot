// Auto-applier — writes approved opportunities to the SEO content table.
// All low-risk kinds auto-apply now (snippet_rewrite, ctr_regression, rank_push, content_enrich).
// content_enrich does an APPEND to the existing FAQ array, not a replace.
// blocked + non-auto opportunities stay in the `opportunities` table; the
// daily-report worker summarises them in the single daily Telegram digest.

import { upsertContent, getPageContent, applyOpportunity, rejectOpportunity, pendingOpportunitiesReady, type OpportunityRow } from "../db/repo.js";
import { decide } from "./risk-gate.js";
import { logger } from "../logger.js";
import { getDb } from "../db/connection.js";
import { indexNowPingMulti } from "../integrations/indexnow.js";
import { similarity } from "../quality/gate.js";

const SITE_URL_FOR_LOCALE: Record<string, string> = {
  en: "https://csboard.com",
  ru: "https://csboard.trade",
};

function fullUrlFor(locale: string, path: string): string | null {
  const base = SITE_URL_FOR_LOCALE[locale];
  if (!base) return null;
  // Root path '/' just becomes '/{locale}'.
  return `${base}/${locale}${path === "/" ? "" : path}`;
}

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

  // Skip applying if the new value barely differs from what's there (would be churn).
  const pc = getPageContent(opp.locale, opp.path);
  const currentRaw = pc.fields[opp.field];
  const currentStr = typeof currentRaw === "string" ? currentRaw : currentRaw == null ? null : JSON.stringify(currentRaw);
  if (currentStr && currentStr.length > 30) {
    const sim = similarity(finalValue, currentStr);
    if (sim > 0.7) {
      return { ok: false, err: `similar to current (sim ${sim.toFixed(2)})` };
    }
  }

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

export async function runApply(_perBatch = 30): Promise<ApplyStats> {
  // We loop until the queue is empty OR daily cap blocks further auto-applies.
  // Each pendingOpportunitiesReady call returns up to PER_BATCH; we keep going.
  const PER_BATCH = 50;
  const stats: ApplyStats = { auto_applied: 0, sent_for_review: 0, blocked: 0, errors: 0, details: [] };

  // Track URLs that actually got auto-applied this run, ping IndexNow at the end.
  const changedUrls = new Set<string>();

  for (let round = 0; round < 20; round++) {
    const pending = pendingOpportunitiesReady(PER_BATCH);
    if (!pending.length) break;
    const beforeAuto = stats.auto_applied;

    for (const opp of pending) {
      try {
        const todayAuto = autoCountToday();
        const gate = decide(opp, todayAuto);
        if (gate.decision === "auto") {
          const r = await applyAuto(opp);
          if (r.ok) {
            stats.auto_applied++;
            stats.details.push(`✓ #${opp.id} ${opp.locale}${opp.path}/${opp.field} (auto)`);
            const url = fullUrlFor(opp.locale, opp.path);
            if (url) changedUrls.add(url);
          } else {
            stats.errors++;
            stats.details.push(`✗ #${opp.id} ${r.err}`);
            rejectOpportunity(opp.id, r.err ?? "auto-apply failed");
          }
        } else if (gate.decision === "review") {
          // Opportunity stays 'pending'; daily-report summarises it.
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

    // If this round auto-applied nothing (cap hit, all-review, all-error), stop.
    if (stats.auto_applied === beforeAuto) break;
  }

  // Ping IndexNow (Bing/Yandex/Yep/etc) for every URL we modified — real-time
  // recrawl. Google is handled by sitemap.submit in the verify worker.
  if (changedUrls.size) {
    try {
      const ping = await indexNowPingMulti([...changedUrls]);
      stats.details.push(`📣 indexnow: pinged ${ping.pings} hosts (${ping.ok} ok), ${changedUrls.size} URLs`);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "indexnow ping wrapper failed");
    }
  }

  return stats;
}
