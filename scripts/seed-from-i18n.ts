// Seed `content` table from cs2-tradeboard-frontend's messages/{en,ru}.json.
// Idempotent: re-running with the same values is a no-op (upsert keeps updated_at if no diff —
// here we always set source='seed' but the trigger only logs history when value changes).
//
// Run from project root:
//   tsx scripts/seed-from-i18n.ts /path/to/cs2-tradeboard-frontend
// or with default path resolution:
//   tsx scripts/seed-from-i18n.ts

import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.js";
import { upsertContent } from "../src/db/repo.js";
import { closeDb } from "../src/db/connection.js";
import { logger } from "../src/logger.js";

interface I18nMessages {
  seo?: Record<string, { title?: string; description?: string; keywords?: string[] }>;
  seoContent?: Record<
    string,
    { title?: string; intro?: string; faq?: Array<{ q: string; a: string }> }
  >;
}

// Maps i18n keys → frontend route paths.
// Both `seo.<key>` (meta tags) and `seoContent.<key>` (visible body content) map to the same path.
const KEY_TO_PATH: Record<string, string> = {
  home: "/",
  browse: "/items",
  trades: "/trades",
  sell: "/sell",
  createOffer: "/create-offer",
  blog: "/blog",
  premium: "/premium",
  cs2Trading: "/cs2-trading",
  cs2Marketplace: "/cs2-marketplace",
  cs2SkinsPrices: "/cs2-skins-prices",
  cs2TradingSites: "/cs2-trading-sites",
  comparison: "/comparison",
  trendsPage: "/trends",
  steamAutoPost: "/steam-auto-post",
  // add more as the frontend gets new routes
};

function resolveFrontendPath(): string {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  // Try sibling worktree
  const candidates = [
    path.resolve(process.cwd(), "../cs2-tradeboard-frontend-dev"),
    path.resolve(process.cwd(), "../cs2-tradeboard-frontend"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "messages/en.json"))) return c;
  }
  throw new Error("Could not find cs2-tradeboard-frontend(-dev)/messages/en.json");
}

function seedLocale(frontendDir: string, locale: string): { upserts: number; skipped: number } {
  const file = path.join(frontendDir, "messages", `${locale}.json`);
  if (!fs.existsSync(file)) {
    logger.warn({ file }, "messages file missing, skipping locale");
    return { upserts: 0, skipped: 0 };
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as I18nMessages;
  let upserts = 0;
  let skipped = 0;

  // ---- Meta (title / description / keywords) ----
  const seoSection = data.seo ?? {};
  for (const [key, payload] of Object.entries(seoSection)) {
    const route = KEY_TO_PATH[key];
    if (!route) {
      skipped++;
      continue;
    }
    if (typeof payload?.title === "string" && payload.title.trim()) {
      upsertContent({
        locale,
        path: route,
        field: "title",
        value: payload.title,
        source: "seed",
        reason: `seed from messages/${locale}.json :: seo.${key}.title`,
      });
      upserts++;
    }
    if (typeof payload?.description === "string" && payload.description.trim()) {
      upsertContent({
        locale,
        path: route,
        field: "description",
        value: payload.description,
        source: "seed",
        reason: `seed from messages/${locale}.json :: seo.${key}.description`,
      });
      upserts++;
    }
    if (Array.isArray(payload?.keywords) && payload.keywords.length) {
      upsertContent({
        locale,
        path: route,
        field: "keywords",
        value: payload.keywords,
        source: "seed",
        reason: `seed from messages/${locale}.json :: seo.${key}.keywords`,
      });
      upserts++;
    }
  }

  // ---- Body content (intro + FAQ) ----
  const sc = data.seoContent ?? {};
  for (const [key, payload] of Object.entries(sc)) {
    const route = KEY_TO_PATH[key];
    if (!route) {
      skipped++;
      continue;
    }
    if (typeof payload?.title === "string" && payload.title.trim()) {
      upsertContent({
        locale,
        path: route,
        field: "h1",
        value: payload.title,
        source: "seed",
        reason: `seed from messages/${locale}.json :: seoContent.${key}.title`,
      });
      upserts++;
    }
    if (typeof payload?.intro === "string" && payload.intro.trim()) {
      upsertContent({
        locale,
        path: route,
        field: "intro",
        value: payload.intro,
        source: "seed",
        reason: `seed from messages/${locale}.json :: seoContent.${key}.intro`,
      });
      upserts++;
    }
    if (Array.isArray(payload?.faq) && payload.faq.length) {
      upsertContent({
        locale,
        path: route,
        field: "faq",
        value: payload.faq,
        source: "seed",
        reason: `seed from messages/${locale}.json :: seoContent.${key}.faq`,
      });
      upserts++;
    }
  }

  return { upserts, skipped };
}

function main() {
  const frontendDir = resolveFrontendPath();
  logger.info({ frontendDir }, "seeding from frontend i18n");

  runMigrations();

  let total = 0;
  let totalSkipped = 0;
  for (const locale of ["en", "ru"]) {
    const { upserts, skipped } = seedLocale(frontendDir, locale);
    total += upserts;
    totalSkipped += skipped;
    logger.info({ locale, upserts, skipped }, "locale seeded");
  }

  logger.info({ total_upserts: total, total_skipped: totalSkipped }, "seed complete");
  closeDb();
}

main();
