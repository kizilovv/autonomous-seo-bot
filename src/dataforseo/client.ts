// DataForSEO REST client.
//
// Why REST and not the official SDK? Two reasons:
//  1. The Labs subset we use is small (ranked_keywords, search_intent,
//     domain_rank_overview) — a 70-line fetch wrapper is simpler than a 200kB SDK.
//  2. We need pre-flight budget guards. Wrapping fetch lets us reject calls
//     before they spend.
//
// Cost model (May 2026 DataForSEO Labs pricing):
//   ranked_keywords        $0.01 base + $0.0001 per returned item
//   search_intent          $0.0001 per keyword
//   domain_rank_overview   $0.01 per call
//
// Budget guard: any call that would push today's spend past
// DATAFORSEO_DAILY_BUDGET_USD (default $0.50) throws BudgetCappedError.
// The worker catches it and finishes its run with status='budget_capped' so
// the daily report can surface it.

import { getDb } from "../db/connection.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

const API_BASE = "https://api.dataforseo.com/v3";

export class BudgetCappedError extends Error {
  constructor(msg: string) { super(msg); this.name = "BudgetCappedError"; }
}

interface DfsTaskBase {
  status_code: number;
  status_message: string;
  cost: number;
  result?: any;
}

interface DfsEnvelope {
  status_code: number;
  status_message: string;
  cost: number;
  tasks?: DfsTaskBase[];
}

/** Returns today's spend in USD (sum of all DFS calls today). */
function todaySpendUsd(): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = getDb().prepare("SELECT total_usd FROM dataforseo_spend WHERE spend_date = ?").get(today) as { total_usd: number } | undefined;
  return row?.total_usd ?? 0;
}

function monthSpendUsd(): number {
  const m = new Date().toISOString().slice(0, 7);
  const row = getDb().prepare("SELECT total_usd FROM dataforseo_spend_monthly WHERE spend_month = ?").get(m) as { total_usd: number } | undefined;
  return row?.total_usd ?? 0;
}

function recordSpend(cost: number): void {
  if (cost <= 0) return;
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  db.prepare(
    `INSERT INTO dataforseo_spend (spend_date, total_usd, call_count) VALUES (?, ?, 1)
     ON CONFLICT(spend_date) DO UPDATE SET total_usd = total_usd + excluded.total_usd, call_count = call_count + 1`
  ).run(today, cost);
  db.prepare(
    `INSERT INTO dataforseo_spend_monthly (spend_month, total_usd, call_count) VALUES (?, ?, 1)
     ON CONFLICT(spend_month) DO UPDATE SET total_usd = total_usd + excluded.total_usd, call_count = call_count + 1`
  ).run(month, cost);
}

function preflightBudget(estimatedMaxCost: number): void {
  const dailyCap = config.DATAFORSEO_DAILY_BUDGET_USD;
  const monthlyCap = config.DATAFORSEO_MONTHLY_BUDGET_USD;
  const dayNow = todaySpendUsd();
  const monthNow = monthSpendUsd();
  if (estimatedMaxCost > config.DATAFORSEO_PER_CALL_CAP_USD) {
    throw new BudgetCappedError(`per-call cap ${config.DATAFORSEO_PER_CALL_CAP_USD.toFixed(4)} exceeded by estimate ${estimatedMaxCost.toFixed(4)}`);
  }
  if (dayNow + estimatedMaxCost > dailyCap) {
    throw new BudgetCappedError(`daily cap ${dailyCap.toFixed(2)} would be exceeded (today=${dayNow.toFixed(4)}, +est=${estimatedMaxCost.toFixed(4)})`);
  }
  if (monthNow + estimatedMaxCost > monthlyCap) {
    throw new BudgetCappedError(`monthly cap ${monthlyCap.toFixed(2)} would be exceeded (mtd=${monthNow.toFixed(4)}, +est=${estimatedMaxCost.toFixed(4)})`);
  }
}

async function postRaw(endpoint: string, body: unknown, estimatedMaxCost: number): Promise<DfsEnvelope> {
  if (!config.DATAFORSEO_USERNAME || !config.DATAFORSEO_PASSWORD) {
    throw new Error("DataForSEO credentials missing — set DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD");
  }
  preflightBudget(estimatedMaxCost);
  const auth = Buffer.from(`${config.DATAFORSEO_USERNAME}:${config.DATAFORSEO_PASSWORD}`).toString("base64");
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`DataForSEO HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as DfsEnvelope;
  recordSpend(json.cost || 0);
  if (json.status_code !== 20000) {
    throw new Error(`DataForSEO error ${json.status_code}: ${json.status_message}`);
  }
  return json;
}

// ---------- ranked_keywords ----------

export interface RankedKeywordItem {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  difficulty: number | null;
  position: number | null;
  url: string | null;
}

export async function rankedKeywords(args: {
  target: string;
  locationCode?: number;
  languageCode?: string;
  limit?: number;
  minVolume?: number;
}): Promise<{ items: RankedKeywordItem[]; cost: number }> {
  const limit = args.limit ?? 200;
  // Estimated max: $0.01 base + $0.0001 per item
  const estimate = 0.01 + 0.0001 * limit;
  const body = [{
    target: args.target,
    location_code: args.locationCode ?? 2840,
    language_code: args.languageCode ?? "en",
    limit,
    order_by: ["keyword_data.keyword_info.search_volume,desc"],
    filters: [["keyword_data.keyword_info.search_volume", ">=", args.minVolume ?? 100]],
  }];
  const env = await postRaw("/dataforseo_labs/google/ranked_keywords/live", body, estimate);
  const items = (env.tasks?.[0]?.result?.[0]?.items ?? []).map((it: any) => ({
    keyword: it.keyword_data?.keyword as string,
    search_volume: it.keyword_data?.keyword_info?.search_volume ?? null,
    cpc: it.keyword_data?.keyword_info?.cpc ?? null,
    difficulty: it.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
    position: it.ranked_serp_element?.serp_item?.rank_absolute ?? null,
    url: it.ranked_serp_element?.serp_item?.relative_url ?? null,
  })).filter((x: RankedKeywordItem) => x.keyword);
  return { items, cost: env.cost || 0 };
}

// ---------- search_intent ----------

export async function searchIntent(keywords: string[]): Promise<{ intents: Record<string, string>; cost: number }> {
  if (!keywords.length) return { intents: {}, cost: 0 };
  // ~$0.0001 per kw — cap at 100 per call to keep cost predictable
  const estimate = 0.0001 * keywords.length + 0.001;
  const body = [{ keywords, location_code: 2840, language_code: "en" }];
  const env = await postRaw("/dataforseo_labs/google/search_intent/live", body, estimate);
  const items = env.tasks?.[0]?.result?.[0]?.items ?? [];
  const intents: Record<string, string> = {};
  for (const it of items) {
    if (it.keyword && it.keyword_intent?.label) intents[it.keyword] = it.keyword_intent.label;
  }
  return { intents, cost: env.cost || 0 };
}

// ---------- domain_rank_overview ----------

export async function domainRankOverview(target: string, locationCode = 2840, languageCode = "en"): Promise<{ totalKw: number; etv: number; cost: number }> {
  const body = [{ target, location_code: locationCode, language_code: languageCode }];
  const env = await postRaw("/dataforseo_labs/google/domain_rank_overview/live", body, 0.02);
  const m = env.tasks?.[0]?.result?.[0]?.items?.[0]?.metrics?.organic ?? {};
  return { totalKw: m.count ?? 0, etv: m.etv ?? 0, cost: env.cost || 0 };
}

// ---------- spend introspection (for daily report) ----------

export function getDataForSeoSpend(): { daily: number; monthly: number; calls_today: number; calls_month: number } {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const d = getDb().prepare("SELECT total_usd, call_count FROM dataforseo_spend WHERE spend_date = ?").get(today) as { total_usd: number; call_count: number } | undefined;
  const m = getDb().prepare("SELECT total_usd, call_count FROM dataforseo_spend_monthly WHERE spend_month = ?").get(month) as { total_usd: number; call_count: number } | undefined;
  return { daily: d?.total_usd ?? 0, monthly: m?.total_usd ?? 0, calls_today: d?.call_count ?? 0, calls_month: m?.call_count ?? 0 };
}

logger.debug("dataforseo client loaded");
