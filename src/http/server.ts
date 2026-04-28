import Fastify from "fastify";
import { config, allowedOrigins } from "../config.js";
import { logger } from "../logger.js";
import { getPageContent, getSitemapExtras, listPages } from "../db/repo.js";
import { getBlogBySlug, listPublishedBlogs, listAllPublishedSlugs } from "../db/blog-repo.js";

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
    return {
      ...post,
      secondary_queries: post.secondary_queries ? JSON.parse(post.secondary_queries) : [],
      tags: post.tags ? JSON.parse(post.tags) : [],
      faq: post.faq ? JSON.parse(post.faq) : [],
    };
  });

  app.get("/v1/blog/sitemap", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=600");
    return { items: listAllPublishedSlugs() };
  });

  return app;
}

export async function startHttpServer() {
  const app = await buildHttpServer();
  await app.listen({ port: config.HTTP_PORT, host: config.HTTP_HOST });
  logger.info({ port: config.HTTP_PORT, host: config.HTTP_HOST }, "http api listening");
  return app;
}
