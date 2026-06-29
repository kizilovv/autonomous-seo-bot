// Data layer for the blog-generator (Phase 5).
// Kept separate from repo.ts so it's clear this is the long-form content path.

import { getDb, tx } from "./connection.js";
import type { Database } from "better-sqlite3";

export interface BlogTopic {
  id: number;
  primary_query: string;
  locale: string;
  cluster_queries: string | null;
  total_impressions: number;
  avg_position: number;
  status: "queued" | "generating" | "generated" | "skipped";
  blog_id: number | null;
  detected_at: string;
}

export interface GeneratedBlog {
  id: number;
  slug: string;
  locale: string;
  title: string;
  meta_title: string | null;
  meta_description: string | null;
  excerpt: string | null;
  body_html: string;
  body_md: string | null;
  primary_query: string;
  secondary_queries: string | null;
  category: string | null;
  tags: string | null;
  cover_image: string | null;
  word_count: number | null;
  faq: string | null;
  status: "draft" | "published" | "retired";
  published_at: string | null;
  generated_at: string;
  source_model: string | null;
  cost_usd: number | null;
}

export function upsertBlogTopic(args: {
  primary_query: string;
  locale: string;
  cluster_queries: string[];
  total_impressions: number;
  avg_position: number;
}): { id: number; created: boolean } {
  return tx((db: Database) => {
    const existing = db
      .prepare("SELECT id, status FROM blog_topics WHERE locale = ? AND primary_query = ?")
      .get(args.locale, args.primary_query) as { id: number; status: string } | undefined;
    if (existing) {
      // Don't change status if already in flight
      db.prepare(
        "UPDATE blog_topics SET total_impressions = ?, avg_position = ?, cluster_queries = ? WHERE id = ?"
      ).run(args.total_impressions, args.avg_position, JSON.stringify(args.cluster_queries), existing.id);
      return { id: existing.id, created: false };
    }
    const r = db
      .prepare(
        `INSERT INTO blog_topics (primary_query, locale, cluster_queries, total_impressions, avg_position) VALUES (?, ?, ?, ?, ?)`
      )
      .run(args.primary_query, args.locale, JSON.stringify(args.cluster_queries), args.total_impressions, args.avg_position);
    return { id: Number(r.lastInsertRowid), created: true };
  });
}

export function nextQueuedTopics(limit: number): BlogTopic[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM blog_topics WHERE status = 'queued' ORDER BY total_impressions DESC, avg_position ASC LIMIT ?"
    )
    .all(limit) as BlogTopic[];
}

export function markTopicStatus(id: number, status: BlogTopic["status"], blog_id?: number) {
  const db = getDb();
  if (blog_id) {
    db.prepare("UPDATE blog_topics SET status = ?, blog_id = ? WHERE id = ?").run(status, blog_id, id);
  } else {
    db.prepare("UPDATE blog_topics SET status = ? WHERE id = ?").run(status, id);
  }
}

export interface InsertBlogArgs {
  slug: string;
  locale: string;
  title: string;
  meta_title: string | null;
  meta_description: string | null;
  excerpt: string | null;
  body_html: string;
  body_md: string;
  primary_query: string;
  secondary_queries: string[];
  category: string | null;
  tags: string[];
  cover_image: string | null;
  word_count: number;
  faq: Array<{ q: string; a: string }>;
  source_model: string;
  cost_usd: number;
  // Structured-block payload (migration 006, 2026-05-18). When present, the
  // FE renders typed React components instead of body_html. body_html is
  // still written as a fallback for RSS / non-block consumers.
  body_blocks?: unknown;
}

export function insertBlog(args: InsertBlogArgs, status: "published" | "pending_approval" = "published"): number {
  const db = getDb();
  // pending_approval blogs stay unpublished (published_at NULL) until an operator
  // approves; getBlogBySlug/listPublishedBlogs filter status='published', so they
  // never serve on the site before approval.
  const publishedAt = status === "published" ? new Date().toISOString() : null;
  const r = db
    .prepare(
      `INSERT INTO generated_blogs
       (slug, locale, title, meta_title, meta_description, excerpt, body_html, body_md, primary_query, secondary_queries, category, tags, cover_image, word_count, faq, status, published_at, source_model, cost_usd, body_blocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.slug,
      args.locale,
      args.title,
      args.meta_title,
      args.meta_description,
      args.excerpt,
      args.body_html,
      args.body_md,
      args.primary_query,
      JSON.stringify(args.secondary_queries),
      args.category,
      JSON.stringify(args.tags),
      args.cover_image,
      args.word_count,
      JSON.stringify(args.faq),
      status,
      publishedAt,
      args.source_model,
      args.cost_usd,
      args.body_blocks ? JSON.stringify(args.body_blocks) : null
    );
  return Number(r.lastInsertRowid);
}

/** Blogs awaiting operator approval (the content-brain blog approval gate). */
export function listPendingBlogs(limit = 50): Array<{ id: number; slug: string; locale: string; title: string; excerpt: string | null; word_count: number; primary_query: string | null; generated_at: string | null }> {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, slug, locale, title, excerpt, word_count, primary_query, generated_at FROM generated_blogs WHERE status = 'pending_approval' ORDER BY generated_at DESC LIMIT ?"
    )
    .all(limit) as any[];
}

/** Approve a pending blog → publish it now. Returns affected row count. */
export function approveBlog(id: number): number {
  const db = getDb();
  const r = db
    .prepare(
      "UPDATE generated_blogs SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending_approval'"
    )
    .run(id);
  return r.changes;
}

/** Reject a pending blog → retire it (never served). Returns affected row count. */
export function rejectBlog(id: number): number {
  const db = getDb();
  const r = db
    .prepare("UPDATE generated_blogs SET status = 'retired' WHERE id = ? AND status = 'pending_approval'")
    .run(id);
  return r.changes;
}

export function getBlogBySlug(locale: string, slug: string): GeneratedBlog | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM generated_blogs WHERE locale = ? AND slug = ? AND status = 'published'").get(locale, slug) as GeneratedBlog | undefined) ?? null;
}

export function listPublishedBlogs(locale: string, limit = 200): Array<{ slug: string; title: string; excerpt: string | null; published_at: string | null; tags: string | null }> {
  const db = getDb();
  return db
    .prepare(
      "SELECT slug, title, excerpt, published_at, tags FROM generated_blogs WHERE locale = ? AND status = 'published' ORDER BY published_at DESC LIMIT ?"
    )
    .all(locale, limit) as any[];
}

export function listAllPublishedSlugs(): Array<{ locale: string; slug: string; published_at: string | null }> {
  const db = getDb();
  return db
    .prepare("SELECT locale, slug, published_at FROM generated_blogs WHERE status = 'published'")
    .all() as any[];
}

/**
 * Find related published blogs for a given query/topic — used to insert a
 * "Related" section at the end of newly-generated posts (internal linking
 * that helps Google understand content clusters).
 *
 * Strategy: tokenize the query, score each existing blog by token overlap
 * with primary_query + tags, return top N. Same locale only.
 */
export function findRelatedBlogs(
  locale: string,
  query: string,
  excludeSlug: string | null,
  limit = 3
): Array<{ slug: string; title: string }> {
  const db = getDb();
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\sа-яё]/giu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return [];

  const blogs = db
    .prepare(
      "SELECT slug, title, primary_query, secondary_queries, tags FROM generated_blogs WHERE locale = ? AND status = 'published' AND slug != COALESCE(?, '')"
    )
    .all(locale, excludeSlug) as Array<{
      slug: string;
      title: string;
      primary_query: string;
      secondary_queries: string | null;
      tags: string | null;
    }>;

  // Score by token overlap.
  const scored = blogs.map((b) => {
    const corpus = [
      b.title,
      b.primary_query,
      b.secondary_queries ? (() => { try { return (JSON.parse(b.secondary_queries!) as string[]).join(" "); } catch { return ""; } })() : "",
      b.tags ? (() => { try { return (JSON.parse(b.tags!) as string[]).join(" "); } catch { return ""; } })() : "",
    ].join(" ").toLowerCase();
    const score = tokens.reduce((s, t) => s + (corpus.includes(t) ? 1 : 0), 0);
    return { ...b, score };
  });

  return scored
    .filter((b) => b.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ slug, title }) => ({ slug, title }));
}
