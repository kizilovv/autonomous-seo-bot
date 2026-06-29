import Fastify from "fastify";
import { config, allowedOrigins } from "../config.js";
import { logger } from "../logger.js";
import { getPageContent, getSitemapExtras, listPages, topQueries } from "../db/repo.js";
import { getBlogBySlug, listPublishedBlogs, listAllPublishedSlugs, listPendingBlogs, approveBlog, rejectBlog } from "../db/blog-repo.js";

export async function buildHttpServer() {
  const app = Fastify({
    logger: false, // we own logging via pino
    trustProxy: true,
    bodyLimit: 1024 * 64, // 64 KB; we don't accept large bodies anyway
  });

  // --- CORS-ish lite for read endpoints (only GET; allow specific origins) ---
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins().includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
  });
  app.options("*", async (_req, reply) => {
    reply.header("Access-Control-Allow-Methods", "GET");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Accept");
    return reply.code(204).send();
  });

  // --- Health ---
  app.get("/healthz", async () => {
    return { ok: true, ts: new Date().toISOString() };
  });

  // --- Get content for one (locale, path) ---
  app.get<{ Querystring: { locale?: string; path?: string } }>("/v1/content", async (req, reply) => {
    const { locale, path } = req.query;
    if (!locale || !path) {
      reply.code(400);
      return { error: "locale and path are required" };
    }
    const data = getPageContent(locale, path);
    // Always return 200 — empty fields is a valid signal "fall back to bundled i18n"
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
    return data;
  });

  // --- Sitemap extras ---
  app.get<{ Querystring: { locale?: string } }>("/v1/sitemap-extras", async (req, reply) => {
    const locale = req.query.locale ?? "en";
    reply.header("Cache-Control", "public, max-age=300");
    return { items: getSitemapExtras(locale) };
  });

  // --- List pages (for admin/visibility) ---
  app.get("/v1/pages", async () => {
    return { pages: listPages() };
  });

  // --- Blog posts (Phase 5) ---
  app.get<{ Querystring: { locale?: string; limit?: string } }>("/v1/blog", async (req, reply) => {
    const locale = req.query.locale ?? "en";
    const limit = Math.min(500, parseInt(req.query.limit ?? "200", 10) || 200);
    reply.header("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    return { posts: listPublishedBlogs(locale, limit) };
  });

  app.get<{ Querystring: { locale?: string; slug?: string } }>("/v1/blog/post", async (req, reply) => {
    const { locale, slug } = req.query;
    if (!locale || !slug) {
      reply.code(400);
      return { error: "locale and slug are required" };
    }
    const post = getBlogBySlug(locale, slug);
    if (!post) {
      reply.code(404);
      return { error: "not found" };
    }
    reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    // Decode JSON-stored arrays so the frontend doesn't have to.
    // body_blocks (migration 006) is decoded here too; FE renders structured
    // blocks via BlogBlockRenderer when this field is non-null.
    const decodeJson = (raw: unknown) => {
      if (!raw || typeof raw !== "string") return raw ?? null;
      try { return JSON.parse(raw); } catch { return null; }
    };
    return {
      ...post,
      secondary_queries: decodeJson(post.secondary_queries) ?? [],
      tags: decodeJson(post.tags) ?? [],
      faq: decodeJson(post.faq) ?? [],
      body_blocks: decodeJson((post as { body_blocks?: unknown }).body_blocks),
    };
  });

  app.get("/v1/blog/sitemap", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=600");
    return { items: listAllPublishedSlugs() };
  });

  // --- Cross-engine signal bus: top search-demand queries (read by the email
  // marketing agent to ride real CS2 search demand in its subject lines). ---
  app.get<{ Querystring: { days?: string; limit?: string } }>("/v1/gsc/top-queries", async (req, reply) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days ?? "7", 10) || 7));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "15", 10) || 15));
    const until = new Date();
    const since = new Date(until.getTime() - days * 86400_000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    reply.header("Cache-Control", "public, max-age=3600");
    return { since: ymd(since), until: ymd(until), queries: topQueries(ymd(since), ymd(until), limit) };
  });

  // --- Blog approval gate (content-brain). Loopback-only API (127.0.0.1), so
  // these writes are reachable only from Koara-local processes / SSH tunnel. ---
  app.get("/v1/blog/pending", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { pending: listPendingBlogs() };
  });

  app.post<{ Params: { id: string } }>("/v1/blog/:id/approve", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { reply.code(400); return { error: "bad id" }; }
    const changed = approveBlog(id);
    if (!changed) { reply.code(404); return { error: "no pending blog with that id" }; }
    return { id, status: "published" };
  });

  app.post<{ Params: { id: string } }>("/v1/blog/:id/reject", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { reply.code(400); return { error: "bad id" }; }
    const changed = rejectBlog(id);
    if (!changed) { reply.code(404); return { error: "no pending blog with that id" }; }
    return { id, status: "retired" };
  });

  return app;
}

export async function startHttpServer() {
  const app = await buildHttpServer();
  await app.listen({ port: config.HTTP_PORT, host: config.HTTP_HOST });
  logger.info({ port: config.HTTP_PORT, host: config.HTTP_HOST }, "http api listening");
  return app;
}
