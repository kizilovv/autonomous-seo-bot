// Blog generator worker.
// Two phases:
//   A) Topic detection — group GSC queries into clusters with shared intent,
//      pick high-impression clusters that don't have a dedicated page yet.
//   B) Topic execution — for each queued topic, generate a full blog via tier-3 LLM,
//      persist, mark topic as `generated`.
//
// Runs daily after analyze. Budget cap stops it cleanly.

import { aggregateQueries, startRun, finishRun, failRun } from "../db/repo.js";
import { upsertBlogTopic, nextQueuedTopics, markTopicStatus, insertBlog, getBlogBySlug } from "../db/blog-repo.js";
import { genBlogPost } from "../generate/blog-post.js";
import { budgetExceeded } from "../llm/openrouter.js";
import { gscSites, brandTermsRegex } from "../config.js";
import { logger } from "../logger.js";
import { sendMessage, esc } from "../notify/telegram.js";

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
  return /[А-Яа-яЁё]/.test(query) ? "ru" : "en";
}

function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^\w\sа-яё-]/giu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !["the", "and", "for", "что", "как", "или"].includes(t));
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size;
  return uni === 0 ? 0 : inter / uni;
}

interface Cluster {
  primary: string;
  members: QueryRow[];
  totalImpressions: number;
  avgPosition: number;
  locale: "en" | "ru";
}

function buildClusters(rows: QueryRow[]): Cluster[] {
  const brandRe = brandTermsRegex();
  const filtered = rows.filter((r) => {
    if (brandRe && brandRe.test(r.query)) return false;
    return r.impressions >= 5;
  });
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

    for (let j = i + 1; j < filtered.length; j++) {
      if (used.has(j)) continue;
      const other = filtered[j];
      if (localeOf(other.query) !== seedLoc) continue;
      if (jaccard(seedTokens, tokens(other.query)) >= 0.5) {
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

const MIN_CLUSTER_IMPS = 30;
const MAX_TOPICS_PER_RUN = 3;

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
      // Target clusters where avg_pos > 15 (no top-10 page yet) AND total >= MIN_CLUSTER_IMPS
      for (const c of clusters) {
        if (c.totalImpressions < MIN_CLUSTER_IMPS) continue;
        if (c.avgPosition < 15) continue;
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
    const queue = nextQueuedTopics(MAX_TOPICS_PER_RUN);
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
        const draft = await genBlogPost({
          primary_query: topic.primary_query,
          locale: topic.locale as "en" | "ru",
          cluster_queries,
          avg_position: topic.avg_position,
          total_impressions: topic.total_impressions,
        });
        let slug = draft.slug;
        if (getBlogBySlug(topic.locale, slug)) {
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          slug = `${slug}-${stamp}`;
        }
        const blogId = insertBlog({
          ...draft,
          slug,
          locale: topic.locale,
          primary_query: topic.primary_query,
          secondary_queries: cluster_queries,
          cover_image: null,
        });
        markTopicStatus(topic.id, "generated", blogId);
        stats.blogs_generated++;
        stats.total_cost_usd += draft.cost_usd;
        logger.info(
          { id: blogId, slug, locale: topic.locale, words: draft.word_count, cost: draft.cost_usd.toFixed(4) },
          "blog generated"
        );
        await sendMessage(
          `📝 New blog post auto-published\n<b>${esc(draft.title)}</b>\n<code>${esc(topic.locale)}</code>/<code>${esc(slug)}</code>\n${draft.word_count} words · $${draft.cost_usd.toFixed(4)} · model ${esc(draft.source_model)}`
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
