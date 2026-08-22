/**
 * One-off repair for blog metas that shipped truncated.
 *
 * Two generator bugs (both fixed in src/generate/blocks-generator.ts on
 * 2026-08-22) left live pages with broken snippets:
 *
 *   - meta_title cut at a word boundary but not at a *phrase* boundary, so it
 *     ended on a dangling function word: "…Complete Guide to CS2's Most".
 *   - meta_description joined two TL;DR bullets with a bare space, welding two
 *     statements into one run-on, then hard-cropped it mid-clause.
 *
 * Measured before the fix: 268 of 509 published posts had a broken title, 436
 * a broken description. The 126 of them with live GSC traffic held 36,731
 * impressions and earned 104 clicks — 0.28% CTR at an average position where
 * ~2% is normal.
 *
 * The repair is deterministic: it re-derives both fields from data already in
 * the row (`title` and `body_blocks`' tldr items) using the same functions the
 * generator now uses. No LLM, no cost, and re-running it is a no-op.
 *
 * Usage (from /srv/csboard-seo):
 *   node dist/scripts/repair-blog-meta.js            # dry run, prints a diff
 *   node dist/scripts/repair-blog-meta.js --apply    # writes
 *
 * ALWAYS back up first — the 2026-07-08 sweep set the precedent:
 *   cp data/seo.db data/seo.db.bak-$(date +%Y%m%d-%H%M%S)-blogmeta
 */
import { getDb } from "../src/db/connection.js";
import { buildMetaTitle, buildMetaDescription } from "../src/generate/blocks-generator.js";
import type { BlogBlocks } from "../src/generate/blocks-schema.js";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: number;
  slug: string;
  locale: string;
  title: string;
  meta_title: string | null;
  meta_description: string | null;
  body_blocks: string | null;
}

/** TL;DR bullets are the description's source of truth; fall back to nothing. */
function tldrItems(body_blocks: string | null): string[] {
  if (!body_blocks) return [];
  try {
    const blocks = JSON.parse(body_blocks) as BlogBlocks;
    const tldr = blocks.find((b) => b.type === "tldr") as { items?: string[] } | undefined;
    return Array.isArray(tldr?.items) ? tldr!.items!.map(String) : [];
  } catch {
    return [];
  }
}

function main() {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, slug, locale, title, meta_title, meta_description, body_blocks FROM generated_blogs WHERE status = 'published'"
    )
    .all() as Row[];

  const update = db.prepare("UPDATE generated_blogs SET meta_title = ?, meta_description = ? WHERE id = ?");
  let titleFixed = 0;
  let descFixed = 0;
  let untouched = 0;
  const skippedNoSource: string[] = [];

  const run = db.transaction((list: Row[]) => {
    for (const r of list) {
      const nextTitle = buildMetaTitle(r.title);
      const items = tldrItems(r.body_blocks);
      // Without tldr items there is nothing to rebuild a description FROM.
      // Leave it alone rather than invent one — a stale description beats a
      // fabricated one, and the generator fix covers everything published from
      // here on.
      const nextDesc = items.length ? buildMetaDescription(items, r.title) : r.meta_description;

      const tChanged = nextTitle !== r.meta_title;
      const dChanged = !!nextDesc && nextDesc !== r.meta_description;
      if (!items.length && !r.meta_description) skippedNoSource.push(`${r.locale}/${r.slug}`);

      if (!tChanged && !dChanged) {
        untouched++;
        continue;
      }
      if (tChanged) titleFixed++;
      if (dChanged) descFixed++;

      if (!APPLY) {
        console.log(`\n${r.locale}/${r.slug}`);
        if (tChanged) {
          console.log(`  T- ${r.meta_title}`);
          console.log(`  T+ ${nextTitle}`);
        }
        if (dChanged) {
          console.log(`  D- ${r.meta_description}`);
          console.log(`  D+ ${nextDesc}`);
        }
      } else {
        update.run(nextTitle, nextDesc ?? r.meta_description, r.id);
      }
    }
  });

  run(rows);

  console.log(
    `\n=== ${APPLY ? "APPLIED" : "DRY RUN"} — published=${rows.length} title_fixed=${titleFixed} desc_fixed=${descFixed} untouched=${untouched} no_tldr_source=${skippedNoSource.length}`
  );
  if (!APPLY) console.log("re-run with --apply to write (back up data/seo.db first)");
}

main();
