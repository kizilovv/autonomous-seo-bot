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
}

export function insertBlog(args: InsertBlogArgs): number {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO generated_blogs
       (slug, locale, title, meta_title, meta_description, excerpt, body_html, body_md, primary_query, secondary_queries, category, tags, cover_image, word_count, faq, status, published_at, source_model, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`
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
      args.source_model,
      args.cost_usd
    );
  return Number(r.lastInsertRowid);
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
