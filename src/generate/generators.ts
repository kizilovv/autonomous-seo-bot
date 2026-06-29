// Proposal generators. One function per opportunity kind. All call OpenRouter with
// tight prompts and return strings ready to write into `content.value` (after JSON encode).
//
// Constraints baked into prompts (anti "обоссанные лендинги"):
//   - Match brand voice: terse, gamer-leaning, no marketing fluff
//   - Mention real CSBoard facts (instant USDT, P2P, 36k+ skins, zero fees) only where true
//   - Must answer query intent specifically — no generic platitudes
//   - Cyrillic for ru locale, English for en

import { callLlm, type LlmResult } from "../llm/openrouter.js";
import type { OpportunityRow } from "../db/repo.js";

const BRAND_FACTS = `
CSBoard (csboard.com / csboard.trade) is a P2P marketplace for CS2 (Counter-Strike 2) skin trading.
Hard facts you can reference:
- Instant USDT payouts via TRC20, BEP20, Solana, TON
- P2P trading directly with real players (no bots in the middle)
- ~36,000 skins listed, prices powered by Buff163
- Zero trading fees / zero commission
- Trades happen through Steam's official trading system (safe)
DO NOT invent features. DO NOT use generic SEO-spam phrases ("welcome to the world of...", "in today's market...").
`;

function truncate(s: string, max: number): string {
  s = s.trim().replace(/\s+/g, " ");
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function unquote(s: string): string {
  // Remove common LLM artifacts: surrounding quotes, leading "Title:", code fences.
  return s
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/^(title|description|h1|intro|answer)\s*[:\-]\s*/i, "")
    .replace(/^[\"'«]+|[\"'»]+$/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// snippet_rewrite — title/description for a known-ranking page.
// ---------------------------------------------------------------------------

export async function genSnippet(opp: OpportunityRow): Promise<{ field: string; value: string; llm: LlmResult }> {
  const isRu = opp.locale === "ru";
  const target = opp.field === "title" ? "title" : "description";
  const sys = `${BRAND_FACTS}
Task: rewrite the meta ${target} for a CSBoard page so users actually click.
Hard rules:
- ${target === "title" ? "50-60 characters total" : "140-160 characters total"}
- Naturally include the search query the page already ranks for
- ${isRu ? "Output in Russian (Cyrillic), match Russian search intent." : "Output in English."}
- One line. NO quotes, NO labels, just the ${target} text itself.
- End title with " — CSBoard" if length permits.
- Speak directly: "Sell skins for USDT in seconds" not "Welcome to our marketplace".`;

  const user = `Search query the page ranks for: ${opp.query}
Page path: ${opp.path}
Locale: ${opp.locale}
Current SERP performance: position ${(opp.metrics as any)?.position?.toFixed?.(1) ?? "?"}, CTR ${((opp.metrics as any)?.ctr * 100)?.toFixed?.(2) ?? "?"}%
Why we're rewriting: ${opp.notes}`;

  const llm = await callLlm({
    tier: 1,
    systemPrompt: sys,
    userPrompt: user,
    maxTokens: target === "title" ? 60 : 120,
    temperature: 0.5,
    reason: `snippet_rewrite ${opp.locale} ${opp.path} (${opp.query})`,
  });
  const value = truncate(unquote(llm.text), target === "title" ? 60 : 160);
  return { field: target, value, llm };
}

// ---------------------------------------------------------------------------
// rank_push — append intro_extra paragraph that mentions the query naturally.
// ---------------------------------------------------------------------------

export async function genIntroExtra(opp: OpportunityRow): Promise<{ field: string; value: string; llm: LlmResult }> {
  const isRu = opp.locale === "ru";
  const sys = `${BRAND_FACTS}
Task: write ONE tight paragraph (90-140 words, ≤900 chars) that genuinely answers the search query.
Goals:
- The query phrase MUST appear in the first sentence, in natural sentence flow.
- Include 2-4 specific facts: prices, float values, market behavior, real CS2 mechanics, comparisons.
- Tie at least one paragraph to a CSBoard hard fact (instant USDT, P2P, zero fees, ~36k skins).
- ${isRu ? "Russian, professional but conversational. Use real CS2 slang where natural (BS/MW/FT/FN/StatTrak™/scoped trade)." : "English, professional but conversational. Use real CS2 slang where natural (BS/MW/FT/FN, StatTrak™)."}
- Specific concrete details > generic statements. NO SEO clichés ("in today's market", "discover the world of", "elevate your game").
- Plain text only. No markdown headings, no bullet lists, no quotes around the output, no labels.`;

  const user = `Page path: ${opp.path}
Search query to address: ${opp.query}
Existing intro on the page (do NOT repeat it):
${opp.current_value ?? "(none)"}
Why we're writing this: ${opp.notes}`;

  const llm = await callLlm({
    tier: 2,
    systemPrompt: sys,
    userPrompt: user,
    // Cap output at ~150 words / 900 chars (was 800 tokens). The previous wide
    // ceiling was producing 400-word walls of text appended to every item page.
    maxTokens: 280,
    temperature: 0.6,
    reason: `rank_push ${opp.locale} ${opp.path} (${opp.query})`,
  });
  const value = unquote(llm.text);
  return { field: "intro_extra", value, llm };
}

// ---------------------------------------------------------------------------
// content_enrich — generate ONE FAQ {q,a} addressing the query.
// We append it; we don't replace the whole FAQ block.
// ---------------------------------------------------------------------------

export interface FaqDelta {
  q: string;
  a: string;
}

export async function genFaqItem(opp: OpportunityRow): Promise<{ field: string; value: FaqDelta; llm: LlmResult }> {
  const isRu = opp.locale === "ru";
  const sys = `${BRAND_FACTS}
Task: write ONE FAQ Q&A pair that helps users searching for "${opp.query}" reach the right answer on CSBoard.
Format strictly as JSON: {"q":"...", "a":"..."}.
Constraints:
- q: a real question a user would ask (50-100 chars). Use the query phrase naturally if it reads well.
- a: 2-4 sentences (180-340 chars). Concrete, useful. Reference CSBoard features if applicable.
- ${isRu ? "Russian." : "English."}
- No greetings, no "Sure!", no markdown.`;

  const user = `Search query: ${opp.query}
Page: ${opp.path} (locale ${opp.locale})
Why: ${opp.notes}
Current SERP position: ${(opp.metrics as any)?.position?.toFixed?.(1) ?? "?"}`;

  const llm = await callLlm({
    tier: 1,
    systemPrompt: sys,
    userPrompt: user,
    maxTokens: 400,
    temperature: 0.6,
    reason: `content_enrich ${opp.locale} ${opp.path} (${opp.query})`,
  });
  const cleaned = unquote(llm.text);
  let parsed: FaqDelta;
  try {
    // Extract first {...} blob in case the LLM wrapped it.
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : cleaned) as FaqDelta;
  } catch {
    throw new Error(`FAQ proposal not valid JSON: ${cleaned.slice(0, 200)}`);
  }
  if (!parsed.q || !parsed.a || parsed.q.length < 10 || parsed.a.length < 50) {
    throw new Error(`FAQ proposal failed quality bar: ${JSON.stringify(parsed)}`);
  }
  return { field: "faq", value: parsed, llm };
}

// ---------------------------------------------------------------------------
// ctr_regression — same as snippet_rewrite but framed as "fix the broken snippet".
// ---------------------------------------------------------------------------

export async function genRegressionFix(opp: OpportunityRow) {
  return genSnippet(opp); // shape is identical for now
}
