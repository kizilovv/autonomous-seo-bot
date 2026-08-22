/**
 * Hand-tuned metas for the commercial head pages, written with a `human:`
 * source so the bot's pin guard refuses to overwrite them.
 *
 * Every value here answers a measured defect (GSC 2026-07-23..08-19):
 *
 *  - ru /cs2-trading-sites ranks 7.2-7.5 for the RU head marketplace terms
 *    (1,872 impressions) and earned 0.43% CTR while /ru/cs2-trading earned
 *    3.95% at position 7.3. The title is fixed in i18n; the description was
 *    still the bot's.
 *  - ru /cs2-marketplace now carries a buy-intent title from i18n, but its
 *    bot description still opened with "Продавайте" — the snippet contradicted
 *    its own headline.
 *  - en /cs2-trading-sites has bot-owned title AND description rows, so the
 *    i18n edit shipped on 2026-08-22 never reached the SERP.
 *  - en /blog/best-cs2-trade-bot is the clearest single case of the CSGO
 *    wording gap: every CS2-worded query on that page converts normally
 *    ("cs2 trade bot" 2.5%, "cs trade bot" 2.0%), and every CSGO-worded one
 *    earns zero — "csgo trade bot" 1,731 impressions 1 click, "csgo skin trade
 *    bot" 1,039 impressions 0 clicks, and so on for ~9,000 impressions. The
 *    page said CS2 everywhere and mentioned CSGO once in the body. Site-wide
 *    the same split reads 29,961 impressions / 0.32% for CSGO wording against
 *    79,403 / 2.89% for CS2 wording (part of that gap is position — CSGO
 *    queries average 21.3 vs 11.5 — but the trade-bot cluster is a controlled
 *    case: same page, same SERP, only the wording differs).
 *
 * CS:GO and CS2 are the same game after a rename, so naming both is accurate,
 * not stuffing.
 *
 * Usage (from /srv/csboard-seo):
 *   node dist/scripts/pin-commercial-meta.js           # dry run
 *   node dist/scripts/pin-commercial-meta.js --apply   # writes + pins
 */
import { upsertContent, getPageContent, isPinnedField } from "../src/db/repo.js";
import { getDb } from "../src/db/connection.js";

const APPLY = process.argv.includes("--apply");
const SOURCE = "human:commercial-intent-2026-08-22";
const REASON =
  "hand-tuned for query-intent and CS:GO/CS2 wording match; see scripts/pin-commercial-meta.ts for the GSC evidence";

const CMS_ROWS: Array<{ locale: "en" | "ru"; path: string; field: string; value: string }> = [
  {
    locale: "ru",
    path: "/cs2-trading-sites",
    field: "description",
    value:
      "Сравнили торговые площадки КС 2 по комиссиям, выплатам и скорости. Обмен и продажа скинов CS2 напрямую с игроками — вывод на карту, СБП или крипту.",
  },
  {
    locale: "ru",
    path: "/cs2-marketplace",
    field: "description",
    value:
      "Купить скины КС 2 мгновенно: 5 000 000+ предметов, оплата картой, СБП или криптой. Продажа за USDT и P2P-обмен без 15% комиссии Steam.",
  },
  {
    locale: "en",
    path: "/cs2-trading-sites",
    field: "title",
    value: "Best CS2 & CS:GO Trading Sites 2026 — 5 Platforms Compared",
  },
  {
    locale: "en",
    path: "/cs2-trading-sites",
    field: "description",
    value:
      "Compare CS2 and CS:GO trading sites on fees, payout speed and item count — CSBoard, CSFloat, Skinport, DMarket and Buff163 side by side. Zero-fee P2P.",
  },
  {
    locale: "en",
    path: "/blog/best-cs2-trade-bot-in-2025-fast-safe-and-low-fee-alternatives",
    field: "description",
    value:
      "Looking for a CS:GO or CS2 trade bot? Trade skins directly with real players on CSBoard — no bot queues, no bot fees, instant USDT payouts.",
  },
];

/** meta_title and H1 live in generated_blogs, not in the CMS content table. */
const BLOG_ROWS: Array<{ slug: string; locale: string; meta_title: string; title: string }> = [
  {
    slug: "best-cs2-trade-bot-in-2025-fast-safe-and-low-fee-alternatives",
    locale: "en",
    meta_title: "Best CS:GO & CS2 Trade Bot in 2026 · CSBoard",
    title: "Best CS:GO & CS2 Trade Bot in 2026: Fast, Safe, and Low-Fee Alternatives",
  },
];

function main() {
  for (const r of CMS_ROWS) {
    const before = getPageContent(r.locale, r.path).fields[r.field];
    const beforeStr = before == null ? "<none>" : String(before);
    console.log(`\n${APPLY ? "WRITE" : "would write"} ${r.locale}${r.path}/${r.field}  (${r.value.length} chars)`);
    console.log(`  -  ${beforeStr.slice(0, 165)}`);
    console.log(`  +  ${r.value}`);
    if (APPLY) {
      upsertContent({ locale: r.locale, path: r.path, field: r.field, value: r.value, source: SOURCE, reason: REASON });
      console.log(`  pinned=${isPinnedField(r.locale, r.path, r.field)}`);
    }
  }

  const db = getDb();
  const sel = db.prepare("SELECT id, title, meta_title FROM generated_blogs WHERE locale = ? AND slug = ?");
  const upd = db.prepare("UPDATE generated_blogs SET meta_title = ?, title = ? WHERE id = ?");
  for (const b of BLOG_ROWS) {
    const row = sel.get(b.locale, b.slug) as { id: number; title: string; meta_title: string } | undefined;
    if (!row) {
      console.log(`\n!! blog not found in generated_blogs: ${b.locale}/${b.slug} (may live in postgres blog_posts)`);
      continue;
    }
    console.log(`\n${APPLY ? "WRITE" : "would write"} generated_blogs ${b.locale}/${b.slug}`);
    console.log(`  T- ${row.meta_title}\n  T+ ${b.meta_title}`);
    console.log(`  H- ${row.title}\n  H+ ${b.title}`);
    if (APPLY) upd.run(b.meta_title, b.title, row.id);
  }

  console.log(`\n=== ${APPLY ? "APPLIED" : "DRY RUN"} — cms_rows=${CMS_ROWS.length} blog_rows=${BLOG_ROWS.length}`);
  if (!APPLY) console.log("re-run with --apply to write");
}

main();
