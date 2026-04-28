// Thin data-access layer used by both HTTP API (read-only) and MCP server (write).
import { getDb, tx } from "./connection.js";
import type { Database } from "better-sqlite3";

// ---------- Types ----------

export interface ContentRow {
  id: number;
  locale: string;
  path: string;
  field: string;
  value: string; // JSON-encoded
  source: string;
  reason: string | null;
  variant_id: string;
  weight: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface PageContent {
  locale: string;
  path: string;
  fields: Record<string, unknown>; // decoded values keyed by field
  updated_at: string | null;
}

export interface UpsertContentInput {
  locale: string;
  path: string;
  field: string;
  value: unknown; // will be JSON.stringified
  source: string; // 'bot' | 'manual:<who>' | 'mcp:<tool>' | 'seed'
  reason?: string;
  variant_id?: string | null;
  weight?: number;
}

export interface SitemapExtra {
  locale: string;
  path: string;
  priority: number | null;
  changefreq: string | null;
  lastmod: string | null;
}

// ---------- Read operations ----------

export function getPageContent(locale: string, path: string): PageContent {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT field, value, updated_at FROM content WHERE locale = ? AND path = ? AND active = 1 AND variant_id = ''"
    )
    .all(locale, path) as Array<{ field: string; value: string; updated_at: string }>;

  const fields: Record<string, unknown> = {};
  let latest: string | null = null;
  for (const r of rows) {
    try {
      fields[r.field] = JSON.parse(r.value);
    } catch {
      fields[r.field] = r.value;
    }
    if (!latest || r.updated_at > latest) latest = r.updated_at;
  }
  return { locale, path, fields, updated_at: latest };
}

export function listPages(): Array<{ locale: string; path: string; fields_count: number }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT locale, path, COUNT(*) AS fields_count
       FROM content
       WHERE active = 1
       GROUP BY locale, path
       ORDER BY locale, path`
    )
    .all() as Array<{ locale: string; path: string; fields_count: number }>;
}

export function getSitemapExtras(locale: string): SitemapExtra[] {
  const db = getDb();
  return db
    .prepare("SELECT locale, path, priority, changefreq, lastmod FROM sitemap_extras WHERE locale = ?")
    .all(locale) as SitemapExtra[];
}

export function getContentHistory(
  locale: string,
  path: string,
  limit = 50
): Array<{
  id: number;
  field: string;
  value: string;
  source: string;
  reason: string | null;
  changed_at: string;
  change_op: string;
}> {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, field, value, source, reason, changed_at, change_op
       FROM content_history
       WHERE locale = ? AND path = ?
       ORDER BY changed_at DESC
       LIMIT ?`
    )
    .all(locale, path, limit) as any[];
}

// ---------- Write operations (used by MCP only) ----------

export function upsertContent(input: UpsertContentInput): { id: number; created: boolean } {
  return tx((db: Database) => {
    const value = JSON.stringify(input.value);
    const variantKey = input.variant_id ?? "";

    const existing = db
      .prepare(
        "SELECT id FROM content WHERE locale = ? AND path = ? AND field = ? AND variant_id = ?"
      )
      .get(input.locale, input.path, input.field, variantKey) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE content
         SET value = ?, source = ?, reason = ?, weight = ?, active = 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(value, input.source, input.reason ?? null, input.weight ?? 100, existing.id);
      return { id: existing.id, created: false };
    }

    const result = db
      .prepare(
        `INSERT INTO content (locale, path, field, value, source, reason, variant_id, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.locale,
        input.path,
        input.field,
        value,
        input.source,
        input.reason ?? null,
        input.variant_id ?? "",
        input.weight ?? 100
      );
    return { id: Number(result.lastInsertRowid), created: true };
  });
}

export function deleteContent(id: number): { deleted: boolean } {
  const db = getDb();
  // Soft delete via active flag — keeps history reachable via id.
  const result = db.prepare("UPDATE content SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
  return { deleted: result.changes > 0 };
}

export function rollbackContent(historyId: number): { restored: boolean; content_id: number | null } {
  return tx((db: Database) => {
    const hist = db
      .prepare(
        "SELECT content_id, locale, path, field, value, source, variant_id FROM content_history WHERE id = ?"
      )
      .get(historyId) as any;
    if (!hist) return { restored: false, content_id: null };

    db.prepare(
      `UPDATE content SET value = ?, source = ?, reason = ?, active = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    ).run(hist.value, "rollback:" + hist.source, `rollback to history #${historyId}`, hist.content_id);

    return { restored: true, content_id: hist.content_id };
  });
}

export function upsertSitemapExtra(input: SitemapExtra): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sitemap_extras (locale, path, priority, changefreq, lastmod, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(locale, path) DO UPDATE SET
       priority = excluded.priority,
       changefreq = excluded.changefreq,
       lastmod = excluded.lastmod,
       updated_at = excluded.updated_at`
  ).run(input.locale, input.path, input.priority, input.changefreq, input.lastmod);
}

// ---------- Phase 1: snapshots ----------

export interface GscRow {
  site: string;
  snapshot_date: string;
  query: string | null;
  page: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  country: string | null;
  device: string | null;
}

export function insertGscRows(rows: GscRow[]): number {
  if (!rows.length) return 0;
  return tx((db: Database) => {
    const stmt = db.prepare(
      `INSERT INTO gsc_snapshots (site, snapshot_date, query, page, impressions, clicks, ctr, position, country, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let n = 0;
    for (const r of rows) {
      stmt.run(r.site, r.snapshot_date, r.query, r.page, r.impressions, r.clicks, r.ctr, r.position, r.country, r.device);
      n++;
    }
    return n;
  });
}

export interface Ga4Row {
  property_id: string;
  snapshot_date: string;
  host: string | null;
  channel: string | null;
  landing_page: string | null;
  sessions: number;
  engaged: number;
  engagement_rate: number;
}

export function insertGa4Rows(rows: Ga4Row[]): number {
  if (!rows.length) return 0;
  return tx((db: Database) => {
    const stmt = db.prepare(
      `INSERT INTO ga4_snapshots (property_id, snapshot_date, host, channel, landing_page, sessions, engaged, engagement_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let n = 0;
    for (const r of rows) {
      stmt.run(r.property_id, r.snapshot_date, r.host, r.channel, r.landing_page, r.sessions, r.engaged, r.engagement_rate);
      n++;
    }
    return n;
  });
}

export function latestSnapshotDate(table: "gsc_snapshots" | "ga4_snapshots"): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT MAX(snapshot_date) AS d FROM ${table}`).get() as { d: string | null };
  return row.d ?? null;
}

export function purgeOldSnapshots(keepDays = 90): { gsc: number; ga4: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);
  const g = db.prepare("DELETE FROM gsc_snapshots WHERE snapshot_date < ?").run(cutoff);
  const a = db.prepare("DELETE FROM ga4_snapshots WHERE snapshot_date < ?").run(cutoff);
  return { gsc: g.changes, ga4: a.changes };
}

// ---------- Phase 1: runs (cron job log) ----------

export function startRun(worker: string): number {
  const db = getDb();
  return Number(db.prepare("INSERT INTO runs (worker, status) VALUES (?, 'running')").run(worker).lastInsertRowid);
}

export function finishRun(id: number, stats: unknown): void {
  const db = getDb();
  db.prepare(
    `UPDATE runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), status = 'success', stats = ? WHERE id = ?`
  ).run(JSON.stringify(stats), id);
}

export function failRun(id: number, error: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), status = 'failed', error = ? WHERE id = ?`
  ).run(error, id);
}

// ---------- Phase 2: opportunities ----------

export type OpportunityKind =
  | "snippet_rewrite"
  | "rank_push"
  | "content_enrich"
  | "ctr_regression"
  | "lost_ranking"
  | "schema_gap";

export interface OpportunityRow {
  id?: number;
  kind: OpportunityKind;
  locale: string;
  path: string;
  field: string | null;
  query: string | null;
  current_value: string | null;
  proposed_value: string | null;
  metrics: unknown; // will be JSON.stringified
  risk: "low" | "medium" | "high";
  notes?: string | null;
}

export function insertOpportunity(opp: OpportunityRow): number {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO opportunities (kind, locale, path, field, query, current_value, proposed_value, metrics, risk, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opp.kind,
      opp.locale,
      opp.path,
      opp.field,
      opp.query,
      opp.current_value,
      opp.proposed_value,
      JSON.stringify(opp.metrics ?? null),
      opp.risk,
      opp.notes ?? null
    );
  return Number(r.lastInsertRowid);
}

export function pendingOpportunitiesNeedingProposal(limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM opportunities WHERE status = 'pending' AND proposed_value IS NULL ORDER BY detected_at DESC LIMIT ?`
    )
    .all(limit) as Array<OpportunityRow & { id: number; status: string; detected_at: string }>;
}

export function pendingOpportunitiesReady(limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM opportunities WHERE status = 'pending' AND proposed_value IS NOT NULL ORDER BY detected_at DESC LIMIT ?`
    )
    .all(limit) as Array<OpportunityRow & { id: number; status: string; detected_at: string }>;
}

export function setProposal(id: number, proposed_value: string, riskOverride?: "low" | "medium" | "high"): void {
  const db = getDb();
  if (riskOverride) {
    db.prepare("UPDATE opportunities SET proposed_value = ?, risk = ? WHERE id = ?").run(proposed_value, riskOverride, id);
  } else {
    db.prepare("UPDATE opportunities SET proposed_value = ? WHERE id = ?").run(proposed_value, id);
  }
}

export function applyOpportunity(id: number, contentId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE opportunities SET status = 'applied', applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), applied_content_id = ? WHERE id = ?`
  ).run(contentId, id);
}

export function rejectOpportunity(id: number, reason: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE opportunities SET status = 'rejected', notes = COALESCE(notes,'') || ' | rejected: ' || ? WHERE id = ?`
  ).run(reason, id);
}

export function expireOldOpportunities(days = 7): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db
    .prepare("UPDATE opportunities SET status = 'expired' WHERE status = 'pending' AND detected_at < ?")
    .run(cutoff).changes;
}

// ---------- Phase 2: LLM cache + spend ----------

export function getLlmCache(cache_key: string): { response: string } | null {
  const db = getDb();
  return (db.prepare("SELECT response FROM llm_cache WHERE cache_key = ?").get(cache_key) as { response: string } | undefined) ?? null;
}

export function putLlmCache(args: { cache_key: string; model: string; prompt: string; response: string; tokens_in?: number; tokens_out?: number; cost_usd?: number }): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO llm_cache (cache_key, model, prompt, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(args.cache_key, args.model, args.prompt, args.response, args.tokens_in ?? null, args.tokens_out ?? null, args.cost_usd ?? null);
}

export function recordSpend(date: string, usd: number): { daily: number; monthly: number } {
  return tx((db: Database) => {
    const month = date.slice(0, 7);
    db.prepare(
      `INSERT INTO llm_spend (spend_date, total_usd, call_count) VALUES (?, ?, 1)
       ON CONFLICT(spend_date) DO UPDATE SET total_usd = total_usd + excluded.total_usd, call_count = call_count + 1`
    ).run(date, usd);
    db.prepare(
      `INSERT INTO llm_spend_monthly (spend_month, total_usd, call_count) VALUES (?, ?, 1)
       ON CONFLICT(spend_month) DO UPDATE SET total_usd = total_usd + excluded.total_usd, call_count = call_count + 1`
    ).run(month, usd);
    const daily = (db.prepare("SELECT total_usd AS u FROM llm_spend WHERE spend_date = ?").get(date) as { u: number }).u;
    const monthly = (db.prepare("SELECT total_usd AS u FROM llm_spend_monthly WHERE spend_month = ?").get(month) as { u: number }).u;
    return { daily, monthly };
  });
}

export function getSpend(date?: string): { daily: number; monthly: number } {
  const db = getDb();
  const d = date ?? new Date().toISOString().slice(0, 10);
  const m = d.slice(0, 7);
  const dailyRow = db.prepare("SELECT total_usd AS u FROM llm_spend WHERE spend_date = ?").get(d) as { u: number } | undefined;
  const monthRow = db.prepare("SELECT total_usd AS u FROM llm_spend_monthly WHERE spend_month = ?").get(m) as { u: number } | undefined;
  return { daily: dailyRow?.u ?? 0, monthly: monthRow?.u ?? 0 };
}

// ---------- Read helpers used by classifier + reports ----------

export interface QueryAggregate {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  page: string | null;
}

/** Aggregated query stats for one site over a window. */
export function aggregateQueries(site: string, sinceDate: string, untilDate: string): QueryAggregate[] {
  const db = getDb();
  // Sum impressions/clicks; weighted-average position by impressions.
  return db
    .prepare(
      `SELECT
         query,
         page,
         SUM(impressions) AS impressions,
         SUM(clicks) AS clicks,
         CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL)/SUM(impressions) ELSE 0 END AS ctr,
         CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions)/SUM(impressions) ELSE 0 END AS position
       FROM gsc_snapshots
       WHERE site = ? AND snapshot_date BETWEEN ? AND ? AND query IS NOT NULL
       GROUP BY query, page
       HAVING impressions >= 5
       ORDER BY impressions DESC`
    )
    .all(site, sinceDate, untilDate) as QueryAggregate[];
}

export function listOpportunitiesByStatus(status: "pending" | "applied" | "rejected" | "expired", limit = 100) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM opportunities WHERE status = ? ORDER BY detected_at DESC LIMIT ?")
    .all(status, limit) as any[];
}

export function metaGet(key: string): string | null {
  const db = getDb();
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function metaSet(key: string, value: string): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
