// Full blog-post generator. Targets: 1200-1800 words, structured Markdown body,
// dedicated meta tags + FAQ. Outputs a JSON envelope so we can persist + render.
//
// Topic selection happens upstream; this just turns one topic → one blog.

import { callLlm } from "../llm/openrouter.js";
import { logger } from "../logger.js";

export interface BlogTopicInput {
  primary_query: string;
  locale: "en" | "ru";
  cluster_queries: string[];
  avg_position: number;
  total_impressions: number;
}

export interface BlogDraft {
  slug: string;
  title: string;
  meta_title: string;
  meta_description: string;
  excerpt: string;
  body_md: string;
  body_html: string;
  category: string;
  tags: string[];
  faq: Array<{ q: string; a: string }>;
  word_count: number;
  source_model: string;
  cost_usd: number;
}

const BRAND = `
CSBoard (csboard.com / csboard.trade) — P2P CS2 skin marketplace. Hard facts:
• Instant USDT payouts (TRC20 / BEP20 / Solana / TON)
• P2P trades direct between players (no bot middlemen)
• ~36,000 skins indexed, prices anchored to Buff163
• Zero trading fees, zero commission
• Trades execute via Steam's official trade system
DO NOT invent features. Only mention CSBoard where it provides genuine value to the reader (1-3 mentions across the whole post; never spam).

NEUTRALITY RULE (applies when the primary query contains "comparison", "vs", "alternative", "best sites", "best platforms", or names 2+ competitors): treat the post as an independent, vendor-neutral comparison. Mention CSBoard AT MOST ONCE, and only in the closing/CTA — never in headings, never in the intro, never as the "winner". List competitors first and give each a fair, factual treatment. Do not claim CSBoard is "the best" / "#1" / superior; state verifiable facts only and let the reader decide.
`.trim();

const FORBIDDEN_PHRASES_NOTE = `
NEVER use any of these AI-cliché phrases or anything close: "in today's market", "ever-evolving", "delve into", "dive deep", "unleash", "elevate your game", "discover the world of", "welcome to the world of", "in the realm of", "world of CS2 trading", "look no further", "look further".
NEVER greet the reader.
NEVER output "Disclaimer:" sections.
NEVER include affiliate-style language.
`.trim();

const SLUG_RE = /[^a-z0-9-]/g;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ёе]/g, "e").replace(/й/g, "i").replace(/ы/g, "y").replace(/ь/g, "").replace(/ъ/g, "")
    .replace(/[а-я]/g, (c) => {
      const map: Record<string, string> = {
        а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i",
        к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
        у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", э: "e",
        ю: "yu", я: "ya",
      };
      return map[c] ?? "";
    })
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(SLUG_RE, "")
    .slice(0, 80);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Brace-balance a truncated JSON envelope. Best-effort, used only on parse failure. */
function repairTruncatedJson(s: string): string {
  let str = s;
  // Trim everything after the last `}` if the doc looks balanced enough.
  const lastClose = str.lastIndexOf("}");
  if (lastClose > 0) str = str.slice(0, lastClose + 1);
  // Count braces and brackets.
  let braces = 0, brackets = 0, inString = false, escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
  }
  if (inString) str += '"';
  while (brackets > 0) { str += "]"; brackets--; }
  while (braces > 0) { str += "}"; braces--; }
  return str;
}

// Lightweight markdown → HTML for the bot's own output.
// We control the prompt format, so we don't need a full MD parser.
function mdToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inUl = false;

  function closeList() {
    if (inUl) { out.push("</ul>"); inUl = false; }
  }
  function escapeHtml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s: string): string {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function cells(row: string): string[] {
    let s = row.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }
  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  const isTableSep = (s: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s) && s.includes("-");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { closeList(); continue; }
    // GFM table: header row + separator row + N data rows.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = cells(line);
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
      i += 2; // skip header + separator
      while (i < lines.length && isTableRow(lines[i].trimEnd()) && lines[i].trim()) {
        const row = cells(lines[i].trimEnd());
        out.push("<tr>" + row.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
        i++;
      }
      i--; // for-loop will ++; step back to the last consumed line
      out.push("</tbody></table>");
      continue;
    }
    let m;
    if ((m = line.match(/^## (.+)$/))) { closeList(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if ((m = line.match(/^### (.+)$/))) { closeList(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = line.match(/^# (.+)$/))) { closeList(); out.push(`<h1>${inline(m[1])}</h1>`); continue; }
    if ((m = line.match(/^[-*] (.+)$/))) {
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

interface Envelope {
  title: string;
  meta_title: string;
  meta_description: string;
  excerpt: string;
  category: string;
  tags: string[];
  body_md: string;
  faq: Array<{ q: string; a: string }>;
}

export async function genBlogPost(topic: BlogTopicInput): Promise<BlogDraft> {
  const isRu = topic.locale === "ru";
  const lang = isRu ? "Russian (Cyrillic)" : "English";

  const sys = `${BRAND}

You are writing a single SEO blog post for CSBoard.
${FORBIDDEN_PHRASES_NOTE}

Output STRICT JSON (no markdown wrapper, no surrounding code fences) matching this exact shape:
{
  "title": string,                    // post H1, 50-70 chars, naturally includes the primary query
  "meta_title": string,               // <title> tag, 50-60 chars, ends with " — CSBoard"
  "meta_description": string,         // <meta description>, MAX 155 chars (Google truncates ~155). Start with an active verb or "2026" (e.g. "Compare the top 5..." / "2026 guide:..."). Include the primary query. NO filler ("learn about", "this article covers", "in this guide we").
  "excerpt": string,                  // 1-2 sentence preview (140-220 chars)
  "category": string,                 // one of: "Trading Guide" | "Market Analysis" | "Knife Guide" | "Skin Guide" | "Investment"
  "tags": string[],                   // 4-7 lowercase tags
  "body_md": string,                  // 1200-1800 word body in Markdown (## headings, ### subheadings, lists)
  "faq": [{"q": string, "a": string}, ...]  // 4-5 FAQ items, each q 50-100 chars, a 200-340 chars
}

Body rules:
- Open with 80-150 word intro that names the primary query in the first sentence.
- 4-6 ## sections, each 200-400 words. Use ### subheadings inside long sections.
- Include 2-3 specific data points (real prices, real float values, named skins like "AK-47 | Redline" / "M9 Bayonet | Tiger Tooth").
- Mention CSBoard 1-3 times across the whole post, only where it adds value (and obey the NEUTRALITY RULE above for comparison posts).
- Compare to known competitors when relevant (Buff163, CSFloat, Skinport, DMarket, Tradeit) — accurate, factual.
- COMPARISON TABLE: if the primary query contains "comparison", "vs", "best sites", "best platforms", or names 2+ platforms, you MUST include at least one Markdown table comparing the platforms side by side. Use GitHub-flavored Markdown table syntax (header row, a |---|---| separator row, then data rows). Suggested columns: | Platform | Trading fee | Payout method | Payout speed | Best for |. Populate every cell with a factual value; omitting the table is a generation failure.
- End with a "## Conclusion" section (80-150 words) that gives the reader a clear next step — for comparison posts keep it neutral ("compare the platforms above against your priorities"), do not hard-sell one platform.
- Output language: ${lang}. ALL fields in ${lang}.

You may use <em> implicitly via Markdown (*foo*, **bar**, \`code\`) but no HTML tags directly.`;

  const user = `Primary search query: "${topic.primary_query}"
Related queries this post should also rank for (use them naturally, do NOT keyword-stuff):
${topic.cluster_queries.slice(0, 12).map((q, i) => `  ${i + 1}. ${q}`).join("\n")}

Current SERP context: average position ${topic.avg_position.toFixed(1)} across these queries, ${topic.total_impressions} impressions in last 28 days.

Write the post now. Output ONLY the JSON envelope, nothing else.`;

  const llm = await callLlm({
    tier: 2,
    systemPrompt: sys,
    userPrompt: user,
    maxTokens: 6000,
    temperature: 0.55,
    jsonMode: true, // forces strict JSON output where the provider supports it
    reason: `blog ${topic.locale} "${topic.primary_query}"`,
  });

  // Strip code fences the model sometimes adds despite instructions.
  let raw = llm.text.trim();
  raw = raw.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find first { ... last }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`blog: no JSON envelope in output (got ${raw.slice(0, 120)}…)`);
  raw = raw.slice(start, end + 1);

  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch (e) {
    // Last-ditch repair: strip trailing junk that often follows a truncated JSON,
    // close any unclosed strings/objects with a balancing pass.
    const repaired = repairTruncatedJson(raw);
    try {
      env = JSON.parse(repaired) as Envelope;
      logger.warn({ msg: "blog: JSON repaired" });
    } catch {
      logger.error({ err: (e as Error).message, sample: raw.slice(0, 300) }, "blog: JSON parse failed");
      throw e;
    }
  }

  // Sanity gates
  const wc = countWords(env.body_md);
  if (wc < 800) throw new Error(`blog too short: ${wc} words`);
  if (!env.title || !env.meta_title || !env.meta_description) throw new Error("blog: required envelope fields missing");
  if (!Array.isArray(env.faq) || env.faq.length < 3) throw new Error(`blog: faq too short (${env.faq?.length ?? 0})`);

  const slug = slugify(env.title);
  const body_html = mdToHtml(env.body_md);

  return {
    slug,
    title: env.title,
    meta_title: env.meta_title.length <= 60 ? env.meta_title : env.meta_title.slice(0, 59) + "…",
    meta_description: env.meta_description.length <= 155 ? env.meta_description : env.meta_description.slice(0, 154) + "…",
    excerpt: env.excerpt,
    body_md: env.body_md,
    body_html,
    category: env.category || "Trading Guide",
    tags: Array.isArray(env.tags) ? env.tags.slice(0, 8) : [],
    faq: env.faq,
    word_count: wc,
    source_model: llm.model,
    cost_usd: llm.cost_usd,
  };
}
