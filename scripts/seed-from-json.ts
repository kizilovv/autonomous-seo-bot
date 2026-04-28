// Seed `content` table from a JSON file describing each (locale, path) and its
// fields (title, description, keywords, h1, intro, faq).
//
// Run from project root:
//   tsx scripts/seed-from-json.ts ./seed.example.json
//
// Expected JSON shape:
// {
//   "en": {
//     "/": { "title": "...", "description": "...", "h1": "...", "intro": "...",
//            "keywords": ["...", "..."], "faq": [{"q":"...","a":"..."}] },
//     "/pricing": { ... }
//   },
//   "ru": { ... }
// }

import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.js";
import { upsertContent } from "../src/db/repo.js";
import { closeDb } from "../src/db/connection.js";
import { logger } from "../src/logger.js";

interface PageFields {
  title?: string;
  description?: string;
  h1?: string;
  intro?: string;
  keywords?: string[];
  faq?: Array<{ q: string; a: string }>;
}

type SeedFile = Record<string, Record<string, PageFields>>;

function seedLocale(locale: string, byPath: Record<string, PageFields>, sourceFile: string): { upserts: number } {
  let upserts = 0;
  for (const [route, payload] of Object.entries(byPath)) {
    const tag = `seed from ${path.basename(sourceFile)} :: ${locale}.${route}`;
    if (typeof payload?.title === "string" && payload.title.trim()) {
      upsertContent({ locale, path: route, field: "title", value: payload.title, source: "seed", reason: tag });
      upserts++;
    }
    if (typeof payload?.description === "string" && payload.description.trim()) {
      upsertContent({ locale, path: route, field: "description", value: payload.description, source: "seed", reason: tag });
      upserts++;
    }
    if (typeof payload?.h1 === "string" && payload.h1.trim()) {
      upsertContent({ locale, path: route, field: "h1", value: payload.h1, source: "seed", reason: tag });
      upserts++;
    }
    if (typeof payload?.intro === "string" && payload.intro.trim()) {
      upsertContent({ locale, path: route, field: "intro", value: payload.intro, source: "seed", reason: tag });
      upserts++;
    }
    if (Array.isArray(payload?.keywords) && payload.keywords.length) {
      upsertContent({ locale, path: route, field: "keywords", value: payload.keywords, source: "seed", reason: tag });
      upserts++;
    }
    if (Array.isArray(payload?.faq) && payload.faq.length) {
      upsertContent({ locale, path: route, field: "faq", value: payload.faq, source: "seed", reason: tag });
      upserts++;
    }
  }
  return { upserts };
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx scripts/seed-from-json.ts <path-to-seed.json>");
    process.exit(2);
  }
  const file = path.resolve(arg);
  if (!fs.existsSync(file)) {
    console.error(`file not found: ${file}`);
    process.exit(2);
  }

  runMigrations();
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as SeedFile;

  let total = 0;
  for (const [locale, byPath] of Object.entries(data)) {
    const { upserts } = seedLocale(locale, byPath, file);
    total += upserts;
    logger.info({ locale, upserts }, "locale seeded");
  }

  logger.info({ total_upserts: total }, "seed complete");
  closeDb();
}

main();
