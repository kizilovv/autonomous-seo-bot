// Proposal generators. One function per opportunity kind. All call OpenRouter with
// tight prompts and return strings ready to write into `content.value` (after JSON encode).
//
// Constraints baked into prompts:
//   - Match brand voice from config.BRAND_BLURB — no marketing fluff
//   - Mention only facts that are present in the brand blurb (anti-hallucination)
//   - Must answer query intent specifically — no generic platitudes

import { callLlm, type LlmResult } from "../llm/openrouter.js";
import type { OpportunityRow } from "../db/repo.js";
import { config } from "../config.js";

function brandBlurb(): string {
  return config.BRAND_BLURB.trim() || "(no brand blurb configured — keep output strictly factual and tied to the search query)";
}

const FORBIDDEN_PHRASES_NOTE = `
NEVER use any of these AI-cliché phrases or anything close: "in today's market", "ever-evolving", "delve into", "dive deep", "unleash", "elevate your game", "discover the world of", "welcome to the world of", "in the realm of", "look no further".
NEVER greet the reader.
NEVER include affiliate-style language.
DO NOT invent features. Only reference facts already stated in the brand blurb above.
`.trim();

function truncate(s: string, max: number): string {
  s = s.trim().replace(/\s+/g, " ");
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function unquote(s: string): string {
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
  const sys = `${brandBlurb()}

${FORBIDDEN_PHRASES_NOTE}

Task: rewrite the meta ${target} for a page so users actually click.
Hard rules:
- ${target === "title" ? "50-60 characters total" : "140-160 characters total"}
- Naturally include the search query the page already ranks for.
- ${isRu ? "Output in Russian (Cyrillic), match Russian search intent." : "Output in English."}
- One line. NO quotes, NO labels, just the ${target} text itself.
- Speak directly. State outcomes the user gets, not vague positioning.`;

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
  const sys = `${brandBlurb()}

${FORBIDDEN_PHRASES_NOTE}

Task: write 2-3 paragraphs (200-400 words total) that genuinely answer the search query.
Goals:
- The query phrase MUST appear in the first sentence, in natural sentence flow.
- Include 2-4 specific concrete facts (numbers, named entities, comparisons).
- Tie at least one paragraph to a fact stated in the brand blurb (only if it provides genuine value).
- ${isRu ? "Russian, professional but conversational." : "English, professional but conversational."}
- Specific concrete details > generic statements.
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
    maxTokens: 800,
    temperature: 0.65,
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
  const sys = `${brandBlurb()}

${FORBIDDEN_PHRASES_NOTE}

Task: write ONE FAQ Q&A pair that helps users searching for "${opp.query}" reach the right answer.
Format strictly as JSON: {"q":"...", "a":"..."}.
Constraints:
- q: a real question a user would ask (50-100 chars). Use the query phrase naturally if it reads well.
- a: 2-4 sentences (180-340 chars). Concrete, useful. Reference brand-blurb features only if they actually help.
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
  return genSnippet(opp);
}
