// DataForSEO competitor-gap worker.
//
// Runs daily 09:00 UTC. Each run:
//   1. Pulls top 200 ranked_keywords for csboard.com (cached as our own set)
//   2. Pulls top 500 ranked_keywords for ONE competitor (rotation by weekday)
//   3. Computes the gap: keywords competitor ranks for but csboard doesn't
//   4. Filters gap by relevance regex + min volume + max difficulty
//   5. Optional: bulk search_intent on top 30 new gap keywords (commercial/transactional priority)
//   6. Upserts into competitor_gap_keywords table (dedupe, cooldown)
//   7. Emits `competitor_gap` opportunities for newly-eligible kw (skips items
//      already emitted within 60-day cooldown)
//
// Cost per run (typical):
//   - csboard ranked_keywords (200 items) ≈ $0.03
//   - competitor ranked_keywords (500 items) ≈ $0.06
//   - search_intent (top 30 kw) ≈ $0.003
//   Total ≈ $0.09/day — well under the $0.50 daily cap.
//
// Budget-capped exit: if today's spend already exceeds the cap, the client
// throws BudgetCappedError before the HTTP call. The worker catches it,
// finishes its run row with status='budget_capped', and the daily report
// surfaces it as a warning. Caller sees a structured result, not a stack trace.

import { rankedKeywords, searchIntent, BudgetCappedError, type RankedKeywordItem } from "../dataforseo/client.js";
import { getDb } from "../db/connection.js";
import { startRun, finishRun, failRun, insertOpportunity } from "../db/repo.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const REL = /(\b(cs|cs2|csgo|cs-go|counter[\s-]?strike)\b.*\b(skin|skins|knife|knives|glove|gloves|case|sticker|stickers|float|pattern|wear|inventory|market|marketplace|trade|trader|trading|buy|sell|sale|price|prices|cheap|cheapest|sticker|capsule)|^(knife|knives|glove|gloves|karambit|bayonet|butterfly|m9|stiletto|talon|skeleton|huntsman|ursus|nomad|paracord|navaja|gut|shadow|daggers|kukri|classic\sknife|driver\sgloves|hand\swraps|hydra\sgloves|moto\sgloves|specialist\sgloves|sport\sgloves|broken\sfang\sgloves)|^(awp|ak[\s-]?47|m4a1|m4a4|glock|usp|deagle|desert\seagle|sg\s553|aug|famas|p90|mac[\s-]?10|ump|mp5|mp7|mp9|p250|tec[\s-]?9|cz75|p2000|five[\s-]?seven|r8|revolver|nova|xm1014|m249|negev|ssg|scout)|(skinport|csmoney|cs\.money|dmarket|buff163|buff\.market|skin[\s-]?monkey|skin[\s-]?baron|loot[\s-]?bear|wax[\s-]?peer|tradeit|swap\.gg|cs\.deals)|^(steam\sinventory|steam\smarket|steam\strading|steam\stop[\s-]?up|topup\ssteam|trade[\s-]?up|float\schecker|inspect\slink|skin\stracker))/i;

const BLACK = /\b(deadlock|valorant|fortnite|roblox|spinx|donk|s1mple|niko|zywoo|ibuypower|panthera|refund\sgames|game[\s-]?refund|pc\s|laptop|monitor|keyboard|mouse|gaming\schair|pubg|apex\slegends|warzone|league|dota|ow2|overwatch|nfl|nba|nhl|mlb|recipe|movie|netflix)/i;

// Gap-emission thresholds. Conservative defaults — only opportunities worth
// human review get past these gates.
const MIN_VOLUME = 300;        // minimum monthly search volume to consider
const MAX_DIFFICULTY = 40;     // skip keywords requiring authority csboard doesn't yet have
const COOLDOWN_DAYS = 60;      // don't re-emit the same kw within this window
const MAX_NEW_OPPS_PER_RUN = 40; // cap so a fresh competitor doesn't flood the review queue
const INTENT_BATCH_SIZE = 30;  // bulk search_intent payload size (~$0.003)

interface PullResult {
  competitor: string;
  status: "ok" | "budget_capped" | "skipped" | "failed";
  csboard_kw_count: number;
  competitor_kw_count: number;
  raw_gap_count: number;
  relevant_gap_count: number;
  new_opportunities: number;
  cost_usd: number;
  notes?: string;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function competitorForToday(): string {
  const list = config.DATAFORSEO_COMPETITORS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("DATAFORSEO_COMPETITORS is empty");
  // Day-of-year rotation — deterministic. Same UTC date = same competitor across reruns.
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = (now.getTime() - start) / 86_400_000;
  const idx = Math.floor(diff) % list.length;
  return list[idx];
}

function recordRunStart(target: string, endpoint: string): number {
  const r = getDb().prepare(
    `INSERT INTO dataforseo_runs (target, endpoint, status) VALUES (?, ?, 'running')`
  ).run(target, endpoint);
  return Number(r.lastInsertRowid);
}

function recordRunFinish(id: number, status: PullResult["status"], cost: number, returned: number, emitted: number, err?: string) {
  getDb().prepare(
    `UPDATE dataforseo_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       status = ?, cost_usd = ?, kw_returned = ?, gap_emitted = ?, error = ?
       WHERE id = ?`
  ).run(status, cost, returned, emitted, err ?? null, id);
}

function isCsboardRelevant(kw: string): boolean {
  const k = kw.toLowerCase();
  if (!k) return false;
  if (BLACK.test(k)) return false;
  return REL.test(k);
}

function upsertGapKeyword(args: {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  difficulty: number | null;
  best_competitor: string;
  best_position: number | null;
  url: string | null;
}): { id: number; emitted: boolean } {
  const db = getDb();
  const competitors = JSON.stringify([{ domain: args.best_competitor, position: args.best_position, url: args.url }]);
  const row = db.prepare(
    `SELECT id, emitted FROM competitor_gap_keywords WHERE keyword = ? AND location_code = 2840 AND language_code = 'en'`
  ).get(args.keyword) as { id: number; emitted: number } | undefined;
  if (row) {
    db.prepare(
      `UPDATE competitor_gap_keywords
       SET search_volume = COALESCE(?, search_volume),
           cpc = COALESCE(?, cpc),
           difficulty = COALESCE(?, difficulty),
           best_competitor = ?,
           best_position = ?,
           competitors = ?,
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(args.search_volume, args.cpc, args.difficulty, args.best_competitor, args.best_position, competitors, row.id);
    return { id: row.id, emitted: row.emitted === 1 };
  }
  const r = db.prepare(
    `INSERT INTO competitor_gap_keywords
       (keyword, location_code, language_code, search_volume, cpc, difficulty, best_competitor, best_position, competitors)
       VALUES (?, 2840, 'en', ?, ?, ?, ?, ?, ?)`
  ).run(args.keyword, args.search_volume, args.cpc, args.difficulty, args.best_competitor, args.best_position, competitors);
  return { id: Number(r.lastInsertRowid), emitted: false };
}

function alreadyEmittedRecently(keyword: string): boolean {
  const db = getDb();
  const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000).toISOString();
  const row = db.prepare(
    `SELECT 1 FROM opportunities WHERE kind = 'competitor_gap' AND query = ? AND detected_at >= ? LIMIT 1`
  ).get(keyword, cutoff);
  return !!row;
}

export async function runDataForSeoPull(opts?: { competitor?: string; refreshOwn?: boolean }): Promise<PullResult> {
  const competitor = opts?.competitor || competitorForToday();
  const runId = startRun("dataforseo_pull");
  const dfsRunId = recordRunStart(competitor, "ranked_keywords");

  const result: PullResult = {
    competitor,
    status: "ok",
    csboard_kw_count: 0,
    competitor_kw_count: 0,
    raw_gap_count: 0,
    relevant_gap_count: 0,
    new_opportunities: 0,
    cost_usd: 0,
  };

  try {
    // 1) Own domain — pulled every run so the diff is always against fresh data.
    //    Cheap (~$0.03). Skip via opts.refreshOwn=false only in tests.
    let ownItems: RankedKeywordItem[] = [];
    if (opts?.refreshOwn !== false) {
      const own = await rankedKeywords({ target: config.DATAFORSEO_OWN_DOMAIN, limit: 200, minVolume: 50 });
      ownItems = own.items;
      result.cost_usd += own.cost;
      result.csboard_kw_count = ownItems.length;
    }
    const ownSet = new Set(ownItems.map((i) => i.keyword.toLowerCase()));

    // 2) Competitor — top 500 by volume, vol>=100.
    const comp = await rankedKeywords({ target: competitor, limit: 500, minVolume: 100 });
    result.cost_usd += comp.cost;
    result.competitor_kw_count = comp.items.length;

    // 3) Compute gap
    const rawGap = comp.items.filter((it) => !ownSet.has(it.keyword.toLowerCase()));
    result.raw_gap_count = rawGap.length;

    // 4) Filter by relevance + thresholds
    const relevant = rawGap.filter((it) =>
      isCsboardRelevant(it.keyword) &&
      (it.search_volume ?? 0) >= MIN_VOLUME &&
      (it.difficulty ?? 100) <= MAX_DIFFICULTY
    );
    result.relevant_gap_count = relevant.length;

    // 5) Upsert into cache + identify which need opportunities
    const newCandidates: Array<{ kw: string; row: RankedKeywordItem; cacheId: number }> = [];
    for (const it of relevant) {
      const cached = upsertGapKeyword({
        keyword: it.keyword,
        search_volume: it.search_volume,
        cpc: it.cpc,
        difficulty: it.difficulty,
        best_competitor: competitor,
        best_position: it.position,
        url: it.url,
      });
      if (!cached.emitted && !alreadyEmittedRecently(it.keyword)) {
        newCandidates.push({ kw: it.keyword, row: it, cacheId: cached.id });
      }
    }

    // 6) Bulk search_intent on top N — informs reviewer + filters out pure
    //    informational long-tail (we want commercial / transactional).
    const intentTargets = newCandidates.slice(0, MAX_NEW_OPPS_PER_RUN).slice(0, INTENT_BATCH_SIZE);
    let intents: Record<string, string> = {};
    if (intentTargets.length) {
      try {
        const r = await searchIntent(intentTargets.map((c) => c.kw));
        intents = r.intents;
        result.cost_usd += r.cost;
      } catch (e) {
        if (e instanceof BudgetCappedError) {
          logger.warn({ msg: e.message }, "intent batch skipped: budget cap");
        } else {
          logger.warn({ err: (e as Error).message }, "intent batch failed — proceeding without");
        }
      }
    }

    // 7) Emit opportunities (capped per run)
    const db = getDb();
    let emitted = 0;
    for (const cand of newCandidates) {
      if (emitted >= MAX_NEW_OPPS_PER_RUN) break;
      const intent = intents[cand.kw] || null;
      const placeholderSlug = slugify(cand.kw);
      const oppId = insertOpportunity({
        kind: "competitor_gap",
        locale: "en",
        path: `/__competitor_gap/${placeholderSlug}`,
        field: null,
        query: cand.kw,
        current_value: null,
        proposed_value: null,
        metrics: {
          search_volume: cand.row.search_volume,
          cpc: cand.row.cpc,
          difficulty: cand.row.difficulty,
          competitor_position: cand.row.position,
          competitor: competitor,
          competitor_url: cand.row.url,
          intent,
        },
        risk: "medium",
        notes: `[${competitor} pos ${cand.row.position}] vol=${cand.row.search_volume} diff=${cand.row.difficulty}${intent ? ` intent=${intent}` : ""} — choose target page (existing /items/${placeholderSlug}, new hub, or listicle) then enrich content`,
      });
      db.prepare(`UPDATE competitor_gap_keywords SET emitted = 1 WHERE id = ?`).run(cand.cacheId);
      logger.info({ oppId, kw: cand.kw, vol: cand.row.search_volume, diff: cand.row.difficulty, intent }, "competitor_gap emitted");
      emitted++;
    }
    result.new_opportunities = emitted;

    recordRunFinish(dfsRunId, "ok", result.cost_usd, result.competitor_kw_count, emitted);
    finishRun(runId, result);
    logger.info(result, "dataforseo_pull complete");
    return result;
  } catch (e) {
    if (e instanceof BudgetCappedError) {
      result.status = "budget_capped";
      result.notes = e.message;
      recordRunFinish(dfsRunId, "budget_capped", result.cost_usd, 0, 0, e.message);
      finishRun(runId, result);
      logger.warn({ msg: e.message }, "dataforseo_pull: budget capped");
      return result;
    }
    const msg = (e as Error).message;
    recordRunFinish(dfsRunId, "failed", result.cost_usd, 0, 0, msg);
    failRun(runId, msg);
    throw e;
  }
}
