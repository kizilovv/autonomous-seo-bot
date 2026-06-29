// OpenRouter client with tier routing, cache, and budget cap.
// Tier 1 = free / very cheap models (Haiku, DeepSeek, Llama 3.3, Gemini Flash).
// Tier 2 = paid Sonnet for harder rewrites.
import OpenAI from "openai";
import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getLlmCache, putLlmCache, recordSpend, getSpend } from "../db/repo.js";

const client = new OpenAI({
  apiKey: config.OPENROUTER_API_KEY ?? "",
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://csboard.com",
    "X-Title": "csboard-seo-bot",
  },
});

export type Tier = 1 | 2 | 3;

// Per-tier model preference list. First model that responds successfully wins.
// As of 2026-04-28 on OpenRouter:
//   - anthropic/claude-3.5-sonnet, gemini-2.0-flash-exp:free → 404 (no endpoint)
//   - meta-llama/llama-3.3-70b-instruct:free → strict 8 rpm rate limit
//   - deepseek/deepseek-chat → reliable, ~$0.27/M in, $1.10/M out
//   - anthropic/claude-sonnet-4 / claude-sonnet-4.5 → premium, ~$3-5/M
const TIER_MODELS: Record<Tier, string[]> = {
  1: [
    // Cheapest first. v4-flash ≈ 3x cheaper than v3 chat with same quality for snippets.
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-chat-v3.1",
    "deepseek/deepseek-chat",
  ],
  2: [
    // Mid-quality longer rewrites. v4-pro is the new sweet spot — better than v3,
    // ~3.5x cheaper than Sonnet 4.5 for similar output quality.
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "anthropic/claude-sonnet-4.5",
  ],
  3: [
    // Long-form blog posts (1200-1800 words). v4-pro first — Sonnet 4.5 only as
    // fallback. Cuts blog cost from ~$0.05 to ~$0.005 per post (~10x savings).
    "deepseek/deepseek-v4-pro",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-sonnet-4",
  ],
};

// USD per 1M tokens — OpenRouter pricing 2026-05-04.
const MODEL_COST_PER_M_TOKENS: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-v4-flash": { in: 0.14, out: 0.28 },
  "deepseek/deepseek-v4-pro": { in: 0.435, out: 0.87 },
  "deepseek/deepseek-chat-v3.1": { in: 0.15, out: 0.75 },
  "deepseek/deepseek-chat": { in: 0.32, out: 0.89 },
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
  return crypto.createHash("sha256").update(`${model}${prompt}`).digest("hex");
}

export interface LlmCallArgs {
  tier: Tier;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Skip cache (e.g. user explicitly wants a fresh attempt). */
  noCache?: boolean;
  /** Reason — logged for accounting. */
  reason?: string;
  /** Force JSON output mode where supported (Sonnet/GPT). */
  jsonMode?: boolean;
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

  // Try cache against any tier-1 model in the prefer order.
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
      const baseParams = {
        model,
        temperature: args.temperature ?? 0.6,
        max_tokens: args.maxTokens ?? 400,
        messages: [
          { role: "system" as const, content: args.systemPrompt },
          { role: "user" as const, content: args.userPrompt },
        ],
      };
      const params = args.jsonMode
        // OpenRouter passes response_format through to providers that support it.
        ? { ...baseParams, response_format: { type: "json_object" as const } }
        : baseParams;
      const completion = await client.chat.completions.create(params, { timeout: 60_000 });
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
