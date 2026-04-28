// Full blog-post generator. Targets: 1200-1800 words, structured Markdown body,
// dedicated meta tags + FAQ. Outputs a JSON envelope so we can persist + render.
//
// Topic selection happens upstream (workers/blog-generator.ts); this just turns
// one topic → one blog draft.

import { callLlm } from "../llm/openrouter.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

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

const FORBIDDEN_PHRASES_NOTE = `
NEVER use any of these AI-cliché phrases or anything close: "in today's market", "ever-evolving", "delve into", "dive deep", "unleash", "elevate your game", "discover the world of", "welcome to the world of", "in the realm of", "world of ...", "look no further", "look further".
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

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
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
  const brandBlurb = config.BRAND_BLURB.trim() || "(no brand blurb configured — keep output strictly factual and tied to the search query)";

  const sys = `${brandBlurb}

You are writing a single SEO blog post.
${FORBIDDEN_PHRASES_NOTE}

Output STRICT JSON (no markdown wrapper, no surrounding code fences) matching this exact shape:
{
  "title": string,                    // post H1, 50-70 chars, naturally includes the primary query
  "meta_title": string,               // <title> tag, 50-60 chars
  "meta_description": string,         // <meta description>, 140-160 chars, includes primary query
  "excerpt": string,                  // 1-2 sentence preview (140-220 chars)
  "category": string,                 // a short topical category label
  "tags": string[],                   // 4-7 lowercase tags
  "body_md": string,                  // 1200-1800 word body in Markdown (## headings, ### subheadings, lists)
  "faq": [{"q": string, "a": string}, ...]  // 4-5 FAQ items, each q 50-100 chars, a 200-340 chars
}

Body rules:
- Open with 80-150 word intro that names the primary query in the first sentence.
- 4-6 ## sections, each 200-400 words. Use ### subheadings inside long sections.
- Include 2-3 specific data points (real numbers, named entities, comparisons) tied to the search intent.
- Mention the brand only where it adds value to the reader (max 1-3 mentions across the whole post).
- End with a "## Conclusion" section (80-150 words) that gives the reader a clear next step.
- Output language: ${lang}. ALL fields in ${lang}.

You may use Markdown emphasis (*foo*, **bar**, \`code\`) but no HTML tags directly.`;

  const user = `Primary search query: "${topic.primary_query}"
Related queries this post should also rank for (use them naturally, do NOT keyword-stuff):
${topic.cluster_queries.slice(0, 12).map((q, i) => `  ${i + 1}. ${q}`).join("\n")}

Current SERP context: average position ${topic.avg_position.toFixed(1)} across these queries, ${topic.total_impressions} impressions in last 28 days.

Write the post now. Output ONLY the JSON envelope, nothing else.`;

  const llm = await callLlm({
    tier: 3,
    systemPrompt: sys,
    userPrompt: user,
    maxTokens: 4000,
    temperature: 0.65,
    reason: `blog ${topic.locale} "${topic.primary_query}"`,
  });

  let raw = llm.text.trim();
  raw = raw.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`blog: no JSON envelope in output (got ${raw.slice(0, 120)}…)`);
  raw = raw.slice(start, end + 1);

  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch (e) {
    logger.error({ err: (e as Error).message, sample: raw.slice(0, 300) }, "blog: JSON parse failed");
    throw e;
  }

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
    meta_description: env.meta_description.length <= 160 ? env.meta_description : env.meta_description.slice(0, 159) + "…",
    excerpt: env.excerpt,
    body_md: env.body_md,
    body_html,
    category: env.category || "General",
    tags: Array.isArray(env.tags) ? env.tags.slice(0, 8) : [],
    faq: env.faq,
    word_count: wc,
    source_model: llm.model,
    cost_usd: llm.cost_usd,
  };
}
