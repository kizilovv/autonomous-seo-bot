// Structured blocks generator — produces validated BlogBlock[] in one LLM
// call. Replaces the body_md/body_html flow when SEO_BOT_BLOG_BLOCKS_FORMAT=on.
//
// Flow:
//   1. Compose a strict prompt with the BlogBlock JSON schema + 1 worked example
//   2. LLM call (Sonnet tier) with jsonMode → returns block array
//   3. Zod validate via blocks-schema → throw on structural fail
//   4. Post-process: enforce hero is first; resolve placeholder image keys to
//      real cs2c.app URLs; rewrite item_grid URLs to canonical /en/items/...
//   5. hasRequiredBlocks gate → throw if missing faq/cta or too few blocks
//   6. Render fallback body_html from blocks for non-block consumers
//      (RSS, sitemap excerpts, legacy clients that ignore body_blocks)
//
// Caller (blog-generator worker) wraps this in try/catch and falls back to
// the legacy genBlogPost() when an env flag flips it off — so a bad block
// generator can't take down the whole pipeline.

import { callLlm } from "../llm/openrouter.js";
import { logger } from "../logger.js";
import type { BlogTopicInput, BlogDraft } from "./blog-post.js";
import { validateBlocks, hasRequiredBlocks, type BlogBlocks } from "./blocks-schema.js";
import { resolveImage } from "./image-resolver.js";

const BRAND_FACTS = `
CSBoard (csboard.com / csboard.trade) — P2P CS2 skin marketplace.
Hard facts only:
  - Instant USDT payouts (TRC20 / BEP20 / Solana / TON)
  - P2P trades direct between players (no bot middlemen on P2P trades)
  - ~36,000 skins indexed, prices anchored to Buff163
  - Zero trading fees, zero commission on P2P
  - Trades execute via Steam's official trade system
  - Tier filter URL: /<locale>/items/<slug>?tier=Tier-2
DO NOT invent features. Mention CSBoard 1-3 times across the whole post.
`.trim();

const FORBIDDEN = `
NEVER use: "in today's market", "ever-evolving", "delve into", "dive deep",
"unleash", "elevate your game", "discover the world of", "welcome to the world of",
"in the realm of", "look no further". NEVER greet the reader. NEVER output
"Disclaimer:" sections. NEVER use affiliate language. NEVER use emojis.
`.trim();

const SCHEMA_DOC = `
You MUST output a JSON array. Each element is one block. Allowed block types
and their fields (every field marked "required" must be present):

1. hero  REQUIRED FIRST BLOCK
   { "type": "hero", "title": string (required, 30-120 chars, the H1),
     "eyebrow": string (optional, 10-60 chars, e.g. "2026 Edition · Trading Guide"),
     "image": string (OMIT — image will be resolved by the bot) }

2. tldr  (recommended, place right after hero)
   { "type": "tldr", "items": string[] (3-5 strings, each 30-180 chars,
     punchy bullet-points the reader can scan in 5 seconds) }

3. text  (use sparingly, only when no specialized block fits)
   { "type": "text", "html": string (1-3 paragraphs with <p>...</p>, optional
     <h2> / <h3> / <strong> / <a href="..."> / <ul> / <li> / <em>) }

4. top_list  (perfect for "Top N best X", listicle SEO bait)
   { "type": "top_list", "title": string (required, e.g. "Top 7 Most Valuable
     Case Hardened Patterns"),
     "items": [ { "rank": int (1-10), "name": string (required),
                  "stat": string (optional, e.g. "$1.5M sale" or "diff 0"),
                  "note": string (optional, 1-2 sentence why it matters),
                  "image_key": string (optional, slug for image resolver
                                       e.g. "karambit-case-hardened"),
                  "url": string (optional, internal link starting with /) },
                ... 5-7 items ] }

5. callout  (callout boxes — use to break up reading)
   { "type": "callout",
     "style": "pro_tip" | "warning" | "info" | "did_you_know",
     "title": string (optional, ~30 chars),
     "text": string (required, 60-400 chars, single short paragraph) }

6. table  (comparison tables — fees, specs, tier differences)
   { "type": "table", "title": string (optional),
     "cols": string[] (2-5 column headers),
     "rows": string[][] (each inner array == one row, cells may include
                         inline <strong> tags) }

7. item_grid  (showcase CSBoard inventory with thumbnails — only use when
                you can name 4-8 real CS2 items that are likely on csboard)
   { "type": "item_grid", "title": string (optional),
     "items": [ { "name": string (e.g. "Karambit"),
                  "stat": string (optional, e.g. "Tier 2"),
                  "image_key": string (optional, slug for resolver),
                  "url": string (required, internal csboard URL) },
                ... 4-8 items ] }

8. faq  REQUIRED — always include exactly one faq block near the bottom
   { "type": "faq",
     "items": [ { "q": string (50-160 chars), "a": string (180-700 chars) },
                ... 5-10 Q&A items ] }

9. cta  REQUIRED — always include exactly one cta block as the LAST block
   { "type": "cta",
     "title": string (8-100 chars, strong action verb),
     "subtitle": string (optional, 60-180 chars),
     "buttonText": string (2-30 chars, e.g. "Browse Tier 2 Karambit →"),
     "buttonUrl": string (required, internal link),
     "accent": "green" | "blue" | "red" (optional, default "blue") }

URL RULES:
- ALL URLs must start with "/" (internal). Never use external links in url fields
  (external mentions go in text/callout html with <a href> instead).
- Locale-aware: for English posts use /en/..., for Russian use /ru/...
- For Tier filtering: /en/items/<slug>?tier=Tier-2

IMAGE RULES:
- DO NOT make up image URLs. Use "image_key" with a normalized item slug like
  "karambit-case-hardened" or "m9-bayonet-case-hardened". The bot resolves to
  the canonical cs2c.app URL after validation. Unknown slugs render without
  an image (acceptable fallback).

OUTPUT SHAPE:
- Top-level: a JSON OBJECT with exactly ONE key, "blocks", whose value is a
  JSON array of 7-12 blocks (5 minimum). Example skeleton:
    { "blocks": [ {"type":"hero", ...}, {"type":"tldr", ...}, ... ] }
- Order INSIDE the array: hero (first) → tldr → 4-8 content blocks → faq → cta (last).
- No markdown fences. No prose around the object. JUST the JSON object.
`.trim();

const EXAMPLE = JSON.stringify({ blocks:
  [
    { type: "hero", title: "CS2 Karambit Tier 2 Blue Gem Patterns: 2026 Pricing Guide",
      eyebrow: "2026 Update · Pattern Guide" },
    { type: "tldr", items: [
      "Tier 2 = next ~150 patterns after the elite Tier 1, with 75-90% blue coverage",
      "Karambit Tier 2 Case Hardened trades for $3,000-$15,000 in Field-Tested float range",
      "CSBoard lists live Tier 2 inventory at /en/items/karambit-case-hardened-field-tested?tier=Tier-2",
      "Tier 2 carries similar appreciation as Tier 1 (15-30% per year) with much higher liquidity",
    ]},
    { type: "callout", style: "pro_tip",
      text: "Since the CS2 2024 update you can read the pattern index natively in Steam's inspect screen — no third-party float-checker needed before buying." },
    { type: "top_list", title: "Top 5 Tier 2 Karambit Patterns Worth Hunting",
      items: [
        { rank: 1, name: "Pattern #555", stat: "$8,500", note: "Strong even-blue coverage, no yellow lane on the front face.",
          image_key: "karambit-case-hardened", url: "/en/items/karambit-case-hardened-field-tested?tier=Tier-2" },
      ]},
    { type: "faq", items: [
      { q: "What makes a Karambit Tier 2 Case Hardened pattern valuable?", a: "Pattern indexes in the Tier 2 band (roughly the top 5-15% of the 1,000 possible patterns) show 75-90% blue coverage on the most-visible faces, which the collector community ranks via CSBlueGem.com. Tier 2 trades for 3-10x less than Tier 1 but with much higher liquidity — most patterns sell within days." },
    ]},
    { type: "cta", title: "Browse Live Tier 2 Karambit Inventory",
      subtitle: "Zero trading fees · Instant USDT payout · No KYC. Live listings on CSBoard.",
      buttonText: "View Tier 2 Karambit →", buttonUrl: "/en/items/karambit-case-hardened-field-tested?tier=Tier-2", accent: "blue" },
  ]
}, null, 2);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Best-effort renderer: blocks → equivalent body_html. Used for non-block
 *  consumers (RSS feeds, sitemap excerpts, fallback when FE hasn't shipped
 *  block renderer yet). Output is simpler than the React renderer — the
 *  React components are the canonical visual. */
export function renderBlocksToHtml(blocks: BlogBlocks): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "hero":
        out.push(`<h1>${escapeHtml(b.title)}</h1>`);
        if (b.eyebrow) out.push(`<p><em>${escapeHtml(b.eyebrow)}</em></p>`);
        break;
      case "tldr":
        out.push(`<h2>Key takeaways</h2><ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`);
        break;
      case "text":
        out.push(b.html); // already HTML
        break;
      case "top_list":
        out.push(`<h2>${escapeHtml(b.title)}</h2><ol>${b.items
          .map((it) => `<li><strong>${escapeHtml(it.name)}</strong>${it.stat ? ` — ${escapeHtml(it.stat)}` : ""}${it.note ? ` — ${escapeHtml(it.note)}` : ""}${it.url ? ` <a href="${it.url}">→ view</a>` : ""}</li>`)
          .join("")}</ol>`);
        break;
      case "callout":
        out.push(`<blockquote>${b.title ? `<strong>${escapeHtml(b.title)}:</strong> ` : ""}${escapeHtml(b.text)}</blockquote>`);
        break;
      case "table":
        out.push(`${b.title ? `<h2>${escapeHtml(b.title)}</h2>` : ""}<table><thead><tr>${b.cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        break;
      case "item_grid":
        out.push(`${b.title ? `<h2>${escapeHtml(b.title)}</h2>` : ""}<ul>${b.items.map((it) => `<li><a href="${it.url}">${escapeHtml(it.name)}${it.stat ? ` (${escapeHtml(it.stat)})` : ""}</a></li>`).join("")}</ul>`);
        break;
      case "faq":
        out.push(`<h2>Frequently Asked Questions</h2>${b.items.map((it) => `<h3>${escapeHtml(it.q)}</h3><p>${escapeHtml(it.a)}</p>`).join("")}`);
        break;
      case "cta":
        out.push(`<p><strong>${escapeHtml(b.title)}</strong>${b.subtitle ? ` — ${escapeHtml(b.subtitle)}` : ""} <a href="${b.buttonUrl}">${escapeHtml(b.buttonText)}</a></p>`);
        break;
    }
  }
  return out.join("\n");
}

/** Walk the blocks, resolve any image_key into a real cs2c.app URL.
 *  Mutates the input blocks in place for convenience. Unknown keys produce
 *  no image (renderer handles the empty case gracefully). */
async function resolveImagesInBlocks(blocks: BlogBlocks, apiUrl?: string): Promise<void> {
  for (const b of blocks) {
    if (b.type === "top_list") {
      for (const it of b.items) {
        const key = (it as { image_key?: string }).image_key;
        if (key && !it.image) {
          const url = await resolveImage(key, { fallbackKey: "_generic-knife", apiUrl });
          if (url) it.image = url;
        }
        delete (it as { image_key?: string }).image_key;
      }
    } else if (b.type === "item_grid") {
      for (const it of b.items) {
        const key = (it as { image_key?: string }).image_key;
        if (key && !it.image) {
          const url = await resolveImage(key, { fallbackKey: "_generic-knife", apiUrl });
          if (url) it.image = url;
        }
        delete (it as { image_key?: string }).image_key;
      }
    } else if (b.type === "hero" && !b.image) {
      // Hero image — use a generic knife shot if none provided.
      const url = await resolveImage("_generic-knife");
      if (url) b.image = url;
    }
  }
}

/** Cut at the last word boundary before maxLen — never mid-word, never "…". */
function cutAtWord(s: string, maxLen: number): string {
  const t = s.trim();
  if (t.length <= maxLen) return t;
  let cut = t.slice(0, maxLen);
  cut = cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(maxLen * 0.6)));
  return cut.replace(/[\s:,\-–—|&?]+$/, "");
}

/** SERP-safe meta title: full title when short, word-boundary cut when long,
 *  " · CSBoard" brand suffix only when the total stays within ~65 chars. */
function buildMetaTitle(title: string): string {
  const t = title.trim();
  if (t.length <= 50) return `${t} · CSBoard`;
  if (t.length <= 65) return t;
  return cutAtWord(t, 62);
}

function countWords(blocks: BlogBlocks): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "text") n += b.html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
    else if (b.type === "tldr") n += b.items.join(" ").split(/\s+/).length;
    else if (b.type === "callout") n += b.text.split(/\s+/).length;
    else if (b.type === "top_list") n += b.items.reduce((s, it) => s + (it.note ? it.note.split(/\s+/).length : 0) + it.name.split(/\s+/).length, 0);
    else if (b.type === "faq") n += b.items.reduce((s, it) => s + it.q.split(/\s+/).length + it.a.split(/\s+/).length, 0);
  }
  return n;
}

export interface BlogBlocksDraft extends BlogDraft {
  body_blocks: BlogBlocks;
}

export async function genBlogPostBlocks(topic: BlogTopicInput, opts?: { csboardApiUrl?: string }): Promise<BlogBlocksDraft> {
  const isRu = topic.locale === "ru";
  const lang = isRu ? "Russian (Cyrillic)" : "English";

  const sys = `${BRAND_FACTS}

You are writing a single SEO blog post for CSBoard in structured-block format.
${FORBIDDEN}

${SCHEMA_DOC}

Output language: ${lang}. ALL human-facing strings (title, eyebrow, tldr items,
top_list names/notes, callout text, table cells, faq questions/answers, cta
text) MUST be in ${lang}.

Writing rules:
- Lead-in tldr: 4-5 scan-friendly bullets with NUMBERS where possible (prices,
  percentages, ranks).
- top_list: use real CS2 item names ("Karambit Pattern #387", "AK-47 #661", etc).
- callout text: 1-2 short sentences, never a paragraph essay.
- table: use to compare 2-3 options on 3-5 criteria (fees, payout, KYC, etc).
- item_grid: only use when you can name 4-8 ACTUAL csboard items with valid
  /en/items/... or /ru/items/... slugs.
- faq: 5-8 questions, real concerns a buyer/seller asks. Answer with numbers
  and concrete CSBoard URLs where the answer involves "where".
- cta button URL should be a concrete csboard page (/en/items/..., /en/trades,
  /en/sell), not the homepage.

Here is a working example (English, knife topic) — match this structure,
not the topic:

${EXAMPLE}

Output ONLY the JSON array. No prose, no fences, no surrounding object.`;

  const user = `Primary search query: "${topic.primary_query}"
Related queries this post should also rank for (use them naturally):
${topic.cluster_queries.slice(0, 12).map((q, i) => `  ${i + 1}. ${q}`).join("\n")}

Current SERP context: average position ${topic.avg_position.toFixed(1)}, ${topic.total_impressions} impressions last 28d.

Write the blocks now.`;

  const llm = await callLlm({
    // Tier 3 = long-form-quality chain: deepseek-v4-pro first (cheap, capable
    // of structured arrays); Sonnet 4.5 as the fallback for the JSON output.
    // Block generation needs strong schema adherence — cheap tier 1 models
    // (deepseek-flash) routinely emit a single object instead of the
    // expected array, even with explicit prompting.
    tier: 3,
    systemPrompt: sys,
    userPrompt: user,
    maxTokens: 8000,
    temperature: 0.5,
    jsonMode: true,
    reason: `blog-blocks ${topic.locale} "${topic.primary_query}"`,
  });

  // Strip fences just in case.
  const raw = llm.text.trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logger.error({ err: (e as Error).message, sample: raw.slice(0, 300) }, "blog-blocks: JSON parse failed");
    throw new Error(`blog-blocks JSON parse failed: ${(e as Error).message}`);
  }

  // Coerce common shape variations into the expected top-level array:
  //   [{...}, {...}]                    ← canonical, already an array
  //   { "blocks": [{...}, ...] }        ← wrapped under .blocks
  //   { "body_blocks": [{...}, ...] }   ← wrapped under .body_blocks
  //   { "type": "hero", ... }           ← single-block object (deepseek-flash bug)
  if (!Array.isArray(parsed) && parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.blocks)) {
      parsed = obj.blocks;
    } else if (Array.isArray(obj.body_blocks)) {
      parsed = obj.body_blocks;
    } else if (typeof obj.type === "string") {
      // Single-block return — wrap into array. Will fail Zod min(4) gate, but
      // that produces a useful error message instead of "expected array".
      parsed = [obj];
      logger.warn("blog-blocks: LLM returned a single block, wrapping in array (will fail min-block gate)");
    }
  }

  const validation = validateBlocks(parsed);
  if (!validation.ok) {
    logger.error({ errors: validation.errors, sample: raw.slice(0, 300) }, "blog-blocks: schema validation failed");
    throw new Error(`blog-blocks schema validation failed: ${validation.errors}`);
  }
  const blocks: BlogBlocks = validation.blocks;

  const required = hasRequiredBlocks(blocks);
  if (!required.ok) throw new Error(`blog-blocks gate: ${required.reason}`);

  // Enforce hero first
  if (blocks[0].type !== "hero") {
    logger.warn({ first: blocks[0].type }, "blog-blocks: first block is not hero — prepending synthetic hero");
    blocks.unshift({ type: "hero", title: topic.primary_query, eyebrow: isRu ? "2026 · Гид" : "2026 · Guide" });
  }

  // Resolve images
  await resolveImagesInBlocks(blocks, opts?.csboardApiUrl);

  // Build title / meta from hero + tldr / faq
  const heroBlock = blocks[0].type === "hero" ? blocks[0] : null;
  const title = heroBlock?.title || topic.primary_query;
  const tldrBlock = blocks.find((b) => b.type === "tldr") as { items: string[] } | undefined;
  const excerpt = tldrBlock?.items?.slice(0, 2).join(" ").slice(0, 220) || title;
  // Meta title: never hard-cut mid-word with "…" (206 live posts shipped
  // truncated titles like "…to CS2's Most … · CSBoard" — SERP poison).
  // Word-boundary cut, no ellipsis; brand suffix only when it fits.
  const meta_title = buildMetaTitle(title);
  const meta_description = excerpt.length <= 160 ? excerpt : cutAtWord(excerpt, 157);

  // Faq array for legacy `faq` column persistence
  const faqBlock = blocks.find((b) => b.type === "faq") as { items: { q: string; a: string }[] } | undefined;
  const faq = faqBlock?.items ?? [];

  // Render body_html fallback
  const body_html = renderBlocksToHtml(blocks);
  const body_md = ""; // unused for block-format posts
  const wc = countWords(blocks);

  // Tags from primary + cluster (LLM doesn't emit them in block format)
  const tagsRaw = [topic.primary_query, ...topic.cluster_queries.slice(0, 6)]
    .map((q) => q.toLowerCase().split(/\s+/).filter((t) => t.length >= 3))
    .flat();
  const tags = Array.from(new Set(tagsRaw)).slice(0, 8);

  // Slug from title
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

  return {
    slug,
    title,
    meta_title,
    meta_description,
    excerpt,
    body_md,
    body_html,
    body_blocks: blocks,
    category: "Trading Guide",
    tags,
    faq,
    word_count: wc,
    source_model: llm.model,
    cost_usd: llm.cost_usd,
  };
}
