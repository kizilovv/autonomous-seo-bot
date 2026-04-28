// Phase 4 — verify recently applied changes.
//
// Cheap & data-bound checks (no Lighthouse — too heavy):
//   1) Hit the live page and check it returns 2xx/3xx.
//   2) Verify the new value is rendered in the HTML (substring contains).
//   3) (Optional, sparing) Use GSC URL Inspection API to confirm the page is still indexed.
//      Self-rate-limited to a few inspects per run.

import { getDb } from "../db/connection.js";
import { logger } from "../logger.js";
import { sendMessage, esc } from "../notify/telegram.js";
import { gscSites, siteUrlMap, config } from "../config.js";
import { inspectUrl } from "../google/gsc.js";

interface VerifyStats {
  checked: number;
  rendered: number;
  not_rendered: number;
  inspected: number;
  errors: number;
  details: string[];
}

interface AppliedRow {
  id: number;
  locale: string;
  path: string;
  field: string;
  proposed_value: string;
  applied_at: string;
}

function appliedSince(hoursAgo: number, limit = 50): AppliedRow[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  return db
    .prepare(
      `SELECT id, locale, path, field, proposed_value, applied_at
       FROM opportunities
       WHERE status='applied' AND applied_at >= ?
       ORDER BY applied_at DESC
       LIMIT ?`
    )
    .all(cutoff, limit) as AppliedRow[];
}

async function pageContains(url: string, needle: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": `${config.SERVICE_NAME}/0.1` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status >= 400) return { ok: false, status: res.status };
    const html = await res.text();
    const found = html.toLowerCase().includes(needle.toLowerCase());
    return { ok: found, status: res.status };
  } catch (e) {
    logger.warn({ url, err: (e as Error).message }, "verify fetch failed");
    return { ok: false, status: 0 };
  }
}

export async function runVerify(): Promise<VerifyStats> {
  const stats: VerifyStats = { checked: 0, rendered: 0, not_rendered: 0, inspected: 0, errors: 0, details: [] };
  const recent = appliedSince(24);
  const sites = gscSites();
  const localeUrls = siteUrlMap();
  let inspectsLeft = 5;

  for (const row of recent) {
    stats.checked++;
    const baseUrl = localeUrls[row.locale] ?? config.PRIMARY_SITE_URL;
    if (!baseUrl) {
      stats.errors++;
      continue;
    }
    // Build a URL preserving the locale segment if the site uses /<locale>/ prefix.
    // If your site doesn't use locale prefixes, drop "/{locale}" below.
    const url = `${baseUrl.replace(/\/$/, "")}/${row.locale}${row.path === "/" ? "" : row.path}`;

    let needle = row.proposed_value;
    try {
      const parsed = JSON.parse(row.proposed_value);
      if (typeof parsed === "string") needle = parsed;
      else if (parsed && typeof parsed === "object" && typeof parsed.q === "string") needle = parsed.q;
    } catch {}

    if (!needle || needle.length < 12) {
      stats.errors++;
      stats.details.push(`✗ #${row.id} no needle to verify`);
      continue;
    }

    const r = await pageContains(url, needle.slice(0, 80));
    if (r.ok) {
      stats.rendered++;
      stats.details.push(`✓ #${row.id} ${url} renders new ${row.field}`);
    } else {
      stats.not_rendered++;
      stats.details.push(`⚠ #${row.id} ${url} (status ${r.status}) — needle NOT in HTML`);
    }

    if (inspectsLeft > 0 && (row.field === "title" || row.field === "description")) {
      const site = sites.find((s) => s.replace(/^sc-domain:/, "") === new URL(baseUrl).hostname);
      if (site) {
        try {
          const ins = await inspectUrl(site, url);
          inspectsLeft--;
          stats.inspected++;
          const verdict = ins?.indexStatusResult?.verdict ?? "?";
          const lastCrawl = ins?.indexStatusResult?.lastCrawlTime ?? "?";
          stats.details.push(`🔎 #${row.id} GSC verdict=${verdict} lastCrawl=${lastCrawl}`);
        } catch (e) {
          logger.warn({ id: row.id, err: (e as Error).message }, "gsc inspect failed");
        }
      }
    }
  }

  if (stats.checked > 0) {
    const summary = [
      `🔬 <b>SEO verify (last 24h)</b>`,
      `<b>Checked:</b> ${stats.checked} · <b>OK:</b> ${stats.rendered} · <b>missing:</b> ${stats.not_rendered}`,
      stats.inspected ? `<b>GSC inspects:</b> ${stats.inspected}` : "",
      "",
      stats.details.slice(0, 10).map((d) => esc(d)).join("\n"),
      stats.details.length > 10 ? `<i>… and ${stats.details.length - 10} more</i>` : "",
    ].filter(Boolean).join("\n");
    await sendMessage(summary);
  }
  return stats;
}
