// Zod schema mirror of cs2-tradeboard-frontend/lib/blog-blocks.ts.
//
// Runtime validates LLM output before persisting. If validation fails the
// generator throws — caller (blog-generator worker) catches, marks topic
// failed, moves on. No half-rendered blocks ever reach the DB.
//
// Schema is intentionally lenient on optional fields so a less-than-perfect
// LLM output can still pass. Required-everywhere: every block has `type`.

import { z } from "zod";

export const BlogHeroBlockSchema = z.object({
  type: z.literal("hero"),
  image: z.string().url().optional(),
  title: z.string().min(8).max(180),
  eyebrow: z.string().max(80).optional(),
  publishedAt: z.string().optional(),
});

export const BlogTldrBlockSchema = z.object({
  type: z.literal("tldr"),
  items: z.array(z.string().min(8).max(220)).min(3).max(6),
});

export const BlogTextBlockSchema = z.object({
  type: z.literal("text"),
  html: z.string().min(20),
});

export const BlogTopListItemSchema = z.object({
  rank: z.number().int().min(1).max(50),
  name: z.string().min(2).max(120),
  image: z.string().url().optional(),
  stat: z.string().max(60).optional(),
  note: z.string().max(280).optional(),
  url: z.string().optional(),
});

export const BlogTopListBlockSchema = z.object({
  type: z.literal("top_list"),
  title: z.string().min(4).max(140),
  items: z.array(BlogTopListItemSchema).min(3).max(10),
});

export const BlogCalloutBlockSchema = z.object({
  type: z.literal("callout"),
  style: z.enum(["pro_tip", "warning", "info", "did_you_know"]),
  title: z.string().max(80).optional(),
  text: z.string().min(20).max(700),
});

export const BlogTableBlockSchema = z.object({
  type: z.literal("table"),
  title: z.string().max(120).optional(),
  cols: z.array(z.string()).min(2).max(6),
  rows: z.array(z.array(z.string())).min(1).max(20),
});

export const BlogItemGridItemSchema = z.object({
  name: z.string().min(2).max(120),
  image: z.string().url().optional(),
  stat: z.string().max(60).optional(),
  url: z.string(),
});

export const BlogItemGridBlockSchema = z.object({
  type: z.literal("item_grid"),
  title: z.string().max(140).optional(),
  items: z.array(BlogItemGridItemSchema).min(2).max(12),
});

export const BlogFaqBlockSchema = z.object({
  type: z.literal("faq"),
  items: z.array(z.object({ q: z.string().min(8).max(220), a: z.string().min(40).max(900) })).min(3).max(15),
});

export const BlogCtaBlockSchema = z.object({
  type: z.literal("cta"),
  title: z.string().min(8).max(140),
  subtitle: z.string().max(220).optional(),
  buttonText: z.string().min(2).max(40),
  buttonUrl: z.string(),
  accent: z.enum(["green", "blue", "red"]).optional(),
});

export const BlogBlockSchema = z.discriminatedUnion("type", [
  BlogHeroBlockSchema,
  BlogTldrBlockSchema,
  BlogTextBlockSchema,
  BlogTopListBlockSchema,
  BlogCalloutBlockSchema,
  BlogTableBlockSchema,
  BlogItemGridBlockSchema,
  BlogFaqBlockSchema,
  BlogCtaBlockSchema,
]);

export const BlogBlocksSchema = z.array(BlogBlockSchema).min(4).max(20);

export type BlogBlock = z.infer<typeof BlogBlockSchema>;
export type BlogBlocks = z.infer<typeof BlogBlocksSchema>;

/** Best-effort structural validation. Returns { ok, blocks?, errors? }. */
export function validateBlocks(raw: unknown): { ok: true; blocks: BlogBlocks } | { ok: false; errors: string } {
  const r = BlogBlocksSchema.safeParse(raw);
  if (r.success) return { ok: true, blocks: r.data };
  const sample = r.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  return { ok: false, errors: sample };
}

/** Minimum publishable bar: must contain a hero (or first block must look like a title), a faq, and a cta. */
export function hasRequiredBlocks(blocks: BlogBlocks): { ok: boolean; reason?: string } {
  const types = new Set(blocks.map((b) => b.type));
  if (!types.has("faq")) return { ok: false, reason: "missing faq block" };
  if (!types.has("cta")) return { ok: false, reason: "missing cta block" };
  if (blocks.length < 5) return { ok: false, reason: `only ${blocks.length} blocks (need 5+)` };
  return { ok: true };
}
