// Blog generator worker.
// Two phases:
//   A) Topic detection — group GSC queries into clusters with shared intent,
//      pick high-impression clusters that don't have a dedicated page yet.
//   B) Topic execution — for each queued topic, generate a full blog via Sonnet,
//      persist, mark topic as `generated`.
//
// Runs daily after analyze. Budget cap stops it cleanly.

import { aggregateQueries, getPageContent, startRun, finishRun, failRun } from "../db/repo.js";
import { upsertBlogTopic, nextQueuedTopics, markTopicStatus, insertBlog, getBlogBySlug, findRelatedBlogs } from "../db/blog-repo.js";
import { genBlogPost } from "../generate/blog-post.js";
import { genBlogPostBlocks, type BlogBlocksDraft } from "../generate/blocks-generator.js";

// Toggle: when SEO_BOT_BLOG_BLOCKS_FORMAT=on, new blogs are generated as
// structured BlogBlock[] (renderable via React component dispatcher on the
// frontend). Falls back to legacy body_md/body_html generator on any block
// generator failure — so a flaky LLM can't take down the daily pipeline.
const BLOCKS_FORMAT_ENABLED = process.env.SEO_BOT_BLOG_BLOCKS_FORMAT === "on";
// Toggle: when SEO_BOT_BLOG_APPROVAL=on, generated blogs land as `pending_approval`
// (not auto-published) and surface for operator ✅/❌ instead of going live blind —
// the content-brain blog approval gate, mirroring the email-campaign approval flow.
const BLOG_APPROVAL_ENABLED = process.env.SEO_BOT_BLOG_APPROVAL === "on";
import { budgetExceeded } from "../llm/openrouter.js";
import { gscSites } from "../config.js";
import { logger } from "../logger.js";
import { sendMessage, esc } from "../notify/telegram.js";

const CSBOARD_BRAND_RE = /csboard|cs ?board|cstrade|csboardtrade/i;

function offsetDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

interface QueryRow {
  query: string;
  page: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

function localeOf(query: string): "en" | "ru" {
  // Cyrillic anywhere → Russian
  return /[А-Яа-яЁё]/.test(query) ? "ru" : "en";
}

/** Reject GSC operator-search queries (site:, inurl:, intitle:, etc.) — these
 * are owner-side audits (us / Google / SEO tools running ownership checks),
 * NOT user search intent. Generating blogs from them produces nonsense like
 * "How site:.trade trc20 search helps find...". */
function isOperatorQuery(q: string): boolean {
  return /\b(site|inurl|intitle|intext|filetype|cache|related|allintitle|allinurl):/i.test(q);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Crude clustering: normalize tokens, group queries with ≥50% token overlap.
function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^\w\sа-яё-]/giu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !["the", "and", "for", "css", "что", "как", "или"].includes(t));
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size;
  return uni === 0 ? 0 : inter / uni;
}

// RU queries tend to have fewer tokens (no articles) — looser similarity threshold
// catches more variants of the same intent. Booster: 0.34 → 0.28 for RU.
function similarityThreshold(locale: "en" | "ru"): number {
  return locale === "ru" ? 0.28 : 0.5;
}

interface Cluster {
  primary: string;
  members: QueryRow[];
  totalImpressions: number;
  avgPosition: number;
  locale: "en" | "ru";
}

/**
 * Group queries into intent clusters. We DO NOT cluster across locales.
 * The query with the highest impressions becomes the cluster anchor.
 */
function buildClusters(rows: QueryRow[]): Cluster[] {
  // Filter brand + tiny queries + Google search-operator junk
  const filtered = rows.filter(
    (r) => !CSBOARD_BRAND_RE.test(r.query) && !isOperatorQuery(r.query) && r.impressions >= 5
  );
  // Sort by impressions desc — biggest queries seed clusters
  filtered.sort((a, b) => b.impressions - a.impressions);

  const used = new Set<number>();
  const clusters: Cluster[] = [];
  for (let i = 0; i < filtered.length; i++) {
    if (used.has(i)) continue;
    const seed = filtered[i];
    const seedLoc = localeOf(seed.query);
    const seedTokens = tokens(seed.query);
    const members: QueryRow[] = [seed];
    used.add(i);

    const threshold = similarityThreshold(seedLoc);
    for (let j = i + 1; j < filtered.length; j++) {
      if (used.has(j)) continue;
      const other = filtered[j];
      if (localeOf(other.query) !== seedLoc) continue;
      if (jaccard(seedTokens, tokens(other.query)) >= threshold) {
        members.push(other);
        used.add(j);
      }
    }

    const totalImpressions = members.reduce((a, m) => a + m.impressions, 0);
    const avgPosition = members.reduce((a, m) => a + m.position * m.impressions, 0) / Math.max(totalImpressions, 1);
    clusters.push({
      primary: seed.query,
      members,
      totalImpressions,
      avgPosition,
      locale: seedLoc,
    });
  }
  return clusters;
}

// Per-locale floors. RU corpus is smaller, so accept smaller clusters.
// Booster (2026-05-04): lowered RU minima further — RU side under-generates vs EN.
const MIN_CLUSTER_IMPS_BY_LOCALE: Record<"en" | "ru", number> = { en: 25, ru: 8 };
const MIN_AVG_POSITION = 11; // pos >= 11 means we're not yet ranking a dedicated page
// Per-run topic generation cap. RU gets its own slot count so EN can't starve it.
const MAX_TOPICS_PER_RUN_BY_LOCALE: Record<"en" | "ru", number> = { en: 5, ru: 5 };

interface Stats {
  topics_detected: number;
  topics_skipped: number;
  blogs_generated: number;
  blogs_failed: number;
  total_cost_usd: number;
  budget_stopped: boolean;
}

export async function runBlogGenerator() {
  const id = startRun("blog-generator");
  const stats: Stats = { topics_detected: 0, topics_skipped: 0, blogs_generated: 0, blogs_failed: 0, total_cost_usd: 0, budget_stopped: false };
  try {
    // ---------- Phase A: detect topics ----------
    for (const site of gscSites()) {
      const rows = aggregateQueries(site, offsetDate(28), offsetDate(1));
      const clusters = buildClusters(rows as QueryRow[]);
      for (const c of clusters) {
        if (c.totalImpressions < MIN_CLUSTER_IMPS_BY_LOCALE[c.locale]) continue;
        if (c.avgPosition < MIN_AVG_POSITION) continue;
        // Skip if we already have a CMS page for this exact query as primary
        // (heuristic: check `seo_cms.content` for any path whose intro mentions the query)
        // Cheaper: just rely on `blog_topics` UNIQUE constraint to prevent duplicates.
        const r = upsertBlogTopic({
          primary_query: c.primary,
          locale: c.locale,
          cluster_queries: c.members.map((m) => m.query),
          total_impressions: c.totalImpressions,
          avg_position: c.avgPosition,
        });
        if (r.created) stats.topics_detected++;
        else stats.topics_skipped++;
      }
    }

    // ---------- Phase B: generate up to N queued topics ----------
    // Re-queue any 'skipped' topics older than 6h so we get to retry once.
    const reset = await import("../db/connection.js");
    reset.getDb()
      .prepare("UPDATE blog_topics SET status='queued' WHERE status='skipped' AND detected_at < datetime('now','-6 hours')")
      .run();

    // Pull RU and EN topics separately so EN can't dominate the run cap.
    const allQueued = nextQueuedTopics(50);
    const ruQueue = allQueued.filter((t) => t.locale === "ru").slice(0, MAX_TOPICS_PER_RUN_BY_LOCALE.ru);
    const enQueue = allQueued.filter((t) => t.locale === "en").slice(0, MAX_TOPICS_PER_RUN_BY_LOCALE.en);
    // Interleave so a budget cap doesn't starve one locale.
    const queue: typeof allQueued = [];
    const max = Math.max(ruQueue.length, enQueue.length);
    for (let i = 0; i < max; i++) {
      if (ruQueue[i]) queue.push(ruQueue[i]);
      if (enQueue[i]) queue.push(enQueue[i]);
    }
    for (const topic of queue) {
      const b = budgetExceeded();
      if (!b.ok) {
        stats.budget_stopped = true;
        logger.warn({ reason: b.reason }, "blog-generator: budget cap hit");
        break;
      }
      try {
        markTopicStatus(topic.id, "generating");
        const cluster_queries = topic.cluster_queries ? (JSON.parse(topic.cluster_queries) as string[]) : [];
        const topicInput = {
          primary_query: topic.primary_query,
          locale: topic.locale as "en" | "ru",
          cluster_queries,
          avg_position: topic.avg_position,
          total_impressions: topic.total_impressions,
        };
        // Prefer structured-block generator when env flag is set. Any failure
        // (LLM hiccup, validation error, missing required block) falls back
        // to the legacy generator on the next attempt — we don't retry the
        // block generator inline to keep the run budget predictable.
        let draft: BlogBlocksDraft | Awaited<ReturnType<typeof genBlogPost>>;
        if (BLOCKS_FORMAT_ENABLED) {
          try {
            draft = await genBlogPostBlocks(topicInput, {
              csboardApiUrl: process.env.CSBOARD_INTERNAL_API_URL || "http://localhost:3001",
            });
          } catch (e) {
            logger.warn({ topic: topic.primary_query, err: (e as Error).message }, "blog-blocks gen failed — falling back to legacy");
            draft = await genBlogPost(topicInput);
          }
        } else {
          draft = await genBlogPost(topicInput);
        }
        // Avoid slug collisions: if a blog with this slug+locale exists, prefix the slug with date.
        let slug = draft.slug;
        if (getBlogBySlug(topic.locale, slug)) {
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          slug = `${slug}-${stamp}`;
        }

        // Internal linking — append a "Related reads" section pointing to 3 of
        // our other CMS blogs that share keyword tokens. Helps Google build
        // a cluster around the topic.
        const related = findRelatedBlogs(topic.locale, topic.primary_query, slug, 3);
        let body_md = draft.body_md;
        let body_html = draft.body_html;
        if (related.length) {
          const sectionTitle = topic.locale === "ru" ? "Похожие материалы" : "Related reads";
          const linkBase = topic.locale === "ru" ? "https://csboard.trade" : "https://csboard.com";
          const mdLines = [
            "",
            `## ${sectionTitle}`,
            "",
            ...related.map((r) => `- [${r.title}](${linkBase}/${topic.locale}/blog/${r.slug})`),
          ];
          const htmlSection = [
            `<h2>${sectionTitle}</h2>`,
            `<ul>`,
            ...related.map((r) => `<li><a href="${linkBase}/${topic.locale}/blog/${r.slug}">${escHtml(r.title)}</a></li>`),
            `</ul>`,
          ].join("\n");
          body_md = `${draft.body_md}\n${mdLines.join("\n")}\n`;
          body_html = `${draft.body_html}\n${htmlSection}`;
        }

        const blogId = insertBlog({
          ...draft,
          body_md,
          body_html,
          slug,
          locale: topic.locale,
          primary_query: topic.primary_query,
          secondary_queries: cluster_queries,
          // Never leave cover_image NULL: use the blocks-format hero image when present,
          // else the site default OG asset (https://csboard.com/og-image.png is the live
          // 1200x630 card; csboard.trade/og-* 302s to a 404). This populates per-post OG.
          cover_image:
            (("body_blocks" in draft &&
              ((draft as BlogBlocksDraft).body_blocks as any[] | undefined)?.find((b) => b?.type === "hero")?.image) ||
              "https://csboard.com/og-image.png") as string,
          // body_blocks is set only when the blocks generator produced it.
          // Legacy genBlogPost() drafts have no body_blocks → column stays NULL,
          // FE falls back to body_html rendering as before.
          body_blocks: "body_blocks" in draft ? (draft as BlogBlocksDraft).body_blocks : undefined,
        }, BLOG_APPROVAL_ENABLED ? "pending_approval" : "published");
        markTopicStatus(topic.id, "generated", blogId);
        stats.blogs_generated++;
        stats.total_cost_usd += draft.cost_usd;
        logger.info(
          { id: blogId, slug, locale: topic.locale, words: draft.word_count, cost: draft.cost_usd.toFixed(4) },
          "blog generated"
        );
        await sendMessage(
          BLOG_APPROVAL_ENABLED
            ? `📝 Blog PENDING APPROVAL · #${blogId}\n<b>${esc(draft.title)}</b>\n<code>${esc(topic.locale)}</code>/<code>${esc(slug)}</code>\n${draft.word_count} words · $${draft.cost_usd.toFixed(4)} · ${esc(draft.source_model)}\n✅ approve: <code>POST /v1/blog/${blogId}/approve</code> · ❌ <code>/reject</code>`
            : `📝 New blog post auto-published\n<b>${esc(draft.title)}</b>\n<code>${esc(topic.locale)}</code>/<code>${esc(slug)}</code>\n${draft.word_count} words · $${draft.cost_usd.toFixed(4)} · model ${esc(draft.source_model)}`
        );
      } catch (e) {
        stats.blogs_failed++;
        markTopicStatus(topic.id, "skipped");
        logger.warn({ topic: topic.primary_query, err: (e as Error).message }, "blog generation failed");
      }
    }

    finishRun(id, stats);
    return stats;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}
