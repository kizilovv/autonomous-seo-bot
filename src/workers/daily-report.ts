// Daily Telegram digest — ONE message, full picture: GSC totals (7d vs prior 7d),
// applied today (with diffs), pending stuck items, spend.
import { gscSites, config } from "../config.js";
import { aggregateQueries, listOpportunitiesByStatus, getSpend } from "../db/repo.js";
import { sendMessage, esc } from "../notify/telegram.js";
import { startRun, finishRun, failRun } from "../db/repo.js";
import { getDb } from "../db/connection.js";

function offsetDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

interface SiteRollup {
  site: string;
  imps: number;
  clicks: number;
  ctr: number;
  position: number;
  delta_clicks: number;
  delta_imps: number;
}

function rollup(site: string, since: string, until: string) {
  const rows = aggregateQueries(site, since, until);
  let imps = 0;
  let clicks = 0;
  let posSum = 0;
  let posWeight = 0;
  for (const r of rows) {
    imps += r.impressions;
    clicks += r.clicks;
    posSum += r.position * r.impressions;
    posWeight += r.impressions;
  }
  return { imps, clicks, ctr: imps ? clicks / imps : 0, position: posWeight ? posSum / posWeight : 0 };
}

export async function runDailyReport() {
  const id = startRun("daily-report");
  try {
    const lines: string[] = [];
    lines.push(`<b>📊 ${config.SERVICE_NAME} daily report</b>`);
    lines.push(`<i>${esc(new Date().toUTCString())}</i>\n`);

    // ---- per-site rollup ----
    lines.push(`<b>GSC last 7d vs prior 7d</b>`);
    const rollups: SiteRollup[] = [];
    for (const site of gscSites()) {
      const curr = rollup(site, offsetDate(7), offsetDate(1));
      const prev = rollup(site, offsetDate(14), offsetDate(8));
      const dc = prev.clicks ? ((curr.clicks - prev.clicks) / prev.clicks) * 100 : 0;
      const di = prev.imps ? ((curr.imps - prev.imps) / prev.imps) * 100 : 0;
      rollups.push({
        site,
        imps: curr.imps,
        clicks: curr.clicks,
        ctr: curr.ctr,
        position: curr.position,
        delta_clicks: dc,
        delta_imps: di,
      });
      const sign = (n: number) => (n > 0 ? `+${n.toFixed(0)}%` : `${n.toFixed(0)}%`);
      lines.push(
        `  <code>${esc(site.replace("sc-domain:", ""))}</code>: <b>${curr.clicks}</b> clicks (${sign(dc)}) · ${curr.imps} imps (${sign(di)}) · CTR ${(curr.ctr * 100).toFixed(2)}% · pos ${curr.position.toFixed(1)}`
      );
    }
    lines.push("");

    // ---- applied in last 24h ----
    const db = getDb();
    const cutoff24h = new Date(Date.now() - 24 * 3600_000).toISOString();
    const appliedToday = db
      .prepare(
        `SELECT id, kind, locale, path, field, query, proposed_value
         FROM opportunities
         WHERE status='applied' AND applied_at >= ?
         ORDER BY applied_at DESC`
      )
      .all(cutoff24h) as any[];
    if (appliedToday.length) {
      const byKind = appliedToday.reduce<Record<string, number>>((acc, o) => {
        acc[o.kind] = (acc[o.kind] || 0) + 1;
        return acc;
      }, {});
      lines.push(`<b>✅ Auto-applied last 24h</b>: ${appliedToday.length} (${Object.entries(byKind).map(([k,v])=>`${k} ${v}`).join(", ")})`);
      for (const o of appliedToday.slice(0, 5)) {
        let preview = "";
        try {
          const v = JSON.parse(o.proposed_value);
          if (typeof v === "string") preview = v;
          else if (v && typeof v === "object" && typeof v.q === "string") preview = `Q: ${v.q} — A: ${v.a}`;
          else preview = JSON.stringify(v);
        } catch { preview = String(o.proposed_value ?? ""); }
        lines.push(`  · <code>${esc(o.locale)}${esc(o.path)}</code>/<code>${esc(o.field ?? "?")}</code>`);
        if (o.query) lines.push(`    query: <code>${esc(o.query)}</code>`);
        lines.push(`    → ${esc(preview).slice(0, 280)}`);
      }
      if (appliedToday.length > 5) lines.push(`  <i>… and ${appliedToday.length - 5} more</i>`);
      lines.push("");
    }

    // ---- pending review ----
    const pending = listOpportunitiesByStatus("pending", 50);
    if (pending.length) {
      const byKind = pending.reduce<Record<string, number>>((acc, o) => {
        acc[o.kind] = (acc[o.kind] || 0) + 1;
        return acc;
      }, {});
      lines.push(`<b>👁 Pending review</b>: ${pending.length} (${Object.entries(byKind).map(([k,v])=>`${k} ${v}`).join(", ")})`);
      const top = pending
        .map((o: any) => ({ ...o, m: JSON.parse(o.metrics ?? "{}") }))
        .sort((a, b) => (b.m.impressions ?? 0) - (a.m.impressions ?? 0))
        .slice(0, 3);
      for (const o of top) {
        lines.push(
          `  · <code>${esc(o.locale)}${esc(o.path)}</code> — "${esc(o.query ?? "")}" pos ${(o.m.position ?? 0).toFixed(1)}, ${o.m.impressions ?? 0} imps`
        );
      }
      lines.push(`<i>To review pending opportunities, query the local SQLite DB.</i>`);
      lines.push("");
    }

    // ---- spend ----
    const spend = getSpend();
    lines.push(`<b>💰 LLM spend</b>: today $${spend.daily.toFixed(3)} / cap $${config.OPENROUTER_DAILY_BUDGET_USD.toFixed(2)} · MTD $${spend.monthly.toFixed(3)} / cap $${config.OPENROUTER_MONTHLY_BUDGET_USD.toFixed(2)}`);

    const summary = lines.join("\n");
    await sendMessage(summary);
    finishRun(id, { rollups, pending: pending.length, applied_24h: appliedToday.length, spend });
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
