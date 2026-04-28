// OpenRouter client with tier routing, response cache, and budget cap.
//
// Tier 1 = cheap / fast models (DeepSeek, Haiku, GPT-4o-mini). Used for snippet
//          rewrites, FAQ items, intro paragraphs.
// Tier 2 = mid-range (Sonnet 4 / 4.5). Used for body content (rank-push paragraphs).
// Tier 3 = premium long-form (Sonnet 4.5 first). Used for full blog generation.
//
// Each tier is a fallback chain; the first model that responds wins. Costs are
// estimated from token counts and recorded in `llm_spend` / `llm_spend_monthly`.
import OpenAI from "openai";
import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getLlmCache, putLlmCache, recordSpend, getSpend } from "../db/repo.js";

const client = new OpenAI({
  apiKey: config.OPENROUTER_API_KEY ?? "",
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": config.OPENROUTER_REFERER,
    "X-Title": config.OPENROUTER_APP_TITLE,
  },
});

export type Tier = 1 | 2 | 3;

// Per-tier model preference list. First model that responds successfully wins.
// As of 2026 on OpenRouter:
//   - meta-llama/llama-3.3-70b-instruct:free → strict 8 rpm rate limit (avoid for batch jobs)
//   - deepseek/deepseek-chat → reliable, ~$0.27/M in, $1.10/M out
//   - anthropic/claude-haiku-4.5 → reliable, mid-cost
//   - anthropic/claude-sonnet-4(.5) → premium, ~$3-15/M
const TIER_MODELS: Record<Tier, string[]> = {
  1: [
    "deepseek/deepseek-chat",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-4o-mini",
  ],
  2: [
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-sonnet-4",
    "deepseek/deepseek-chat",
  ],
  3: [
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-sonnet-4",
    "deepseek/deepseek-chat",
  ],
};

// USD per 1M tokens — conservative ceilings per OpenRouter pricing 2026.
const MODEL_COST_PER_M_TOKENS: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-chat": { in: 0.27, out: 1.1 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "anthropic/claude-haiku-4.5": { in: 1.0, out: 5.0 },
  "anthropic/claude-sonnet-4": { in: 3.0, out: 15.0 },
  "anthropic/claude-sonnet-4.5": { in: 3.0, out: 15.0 },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const c = MODEL_COST_PER_M_TOKENS[model];
  if (!c) return 0;
  return (tokensIn * c.in + tokensOut * c.out) / 1_000_000;
}

function cacheKey(model: string, prompt: string): string {
  return crypto.createHash("sha256").update(`${model}${prompt}`).digest("hex");
}

export interface LlmCallArgs {
  tier: Tier;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Skip cache (e.g. caller explicitly wants a fresh attempt). */
  noCache?: boolean;
  /** Reason — logged for accounting. */
  reason?: string;
}

export interface LlmResult {
  model: string;
  text: string;
  cached: boolean;
  cost_usd: number;
  tokens_in?: number;
  tokens_out?: number;
}

/** Returns true if today's or this-month's spend exceeds the configured cap. */
export function budgetExceeded(): { ok: boolean; reason?: string; daily: number; monthly: number } {
  const s = getSpend();
  if (s.daily >= config.OPENROUTER_DAILY_BUDGET_USD) {
    return { ok: false, reason: `daily $${s.daily.toFixed(3)} >= cap $${config.OPENROUTER_DAILY_BUDGET_USD}`, ...s };
  }
  if (s.monthly >= config.OPENROUTER_MONTHLY_BUDGET_USD) {
    return { ok: false, reason: `monthly $${s.monthly.toFixed(3)} >= cap $${config.OPENROUTER_MONTHLY_BUDGET_USD}`, ...s };
  }
  return { ok: true, ...s };
}

export async function callLlm(args: LlmCallArgs): Promise<LlmResult> {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not set");
  }
  const budget = budgetExceeded();
  if (!budget.ok) {
    throw new Error(`budget cap reached: ${budget.reason}`);
  }

  const fullPrompt = `${args.systemPrompt}\n\n---\n\n${args.userPrompt}`;
  const candidates = TIER_MODELS[args.tier];
  if (!candidates?.length) throw new Error(`no models configured for tier ${args.tier}`);

  if (!args.noCache) {
    for (const m of candidates) {
      const k = cacheKey(m, fullPrompt);
      const hit = getLlmCache(k);
      if (hit) {
        return { model: m, text: hit.response, cached: true, cost_usd: 0 };
      }
    }
  }

  let lastError: Error | null = null;
  for (const model of candidates) {
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          temperature: args.temperature ?? 0.6,
          max_tokens: args.maxTokens ?? 400,
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: args.userPrompt },
          ],
        },
        { timeout: 30_000 }
      );
      const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error("empty completion");

      const tokensIn = completion.usage?.prompt_tokens ?? 0;
      const tokensOut = completion.usage?.completion_tokens ?? 0;
      const cost = estimateCost(model, tokensIn, tokensOut);
      const today = new Date().toISOString().slice(0, 10);
      if (cost > 0) recordSpend(today, cost);

      putLlmCache({
        cache_key: cacheKey(model, fullPrompt),
        model,
        prompt: fullPrompt,
        response: text,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: cost,
      });

      logger.info({ model, tier: args.tier, tokensIn, tokensOut, cost: cost.toFixed(5), reason: args.reason }, "llm call ok");
      return { model, text, cached: false, cost_usd: cost, tokens_in: tokensIn, tokens_out: tokensOut };
    } catch (e) {
      lastError = e as Error;
      logger.warn({ model, err: (e as Error).message }, "llm call failed, trying next model");
    }
  }
  throw lastError ?? new Error("all tier models failed");
}
