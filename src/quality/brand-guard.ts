// Brand guard — keeps competitor names, competitor URLs and stray domains out
// of anything the bot writes into the public CMS.
//
// Why this exists (incident 2026-08-05):
//   GSC reported csboard.com ranking ~#3 for `"api.lis-skins.com/v1" balance`
//   with 0 clicks (devs googling a competitor's API docs land on our blog).
//   The classifier read that as a CTR opportunity and rewrote the HOME
//   description; the quality gate's "target query must appear in the text"
//   rule then *forced* the competitor's API URL into the copy. Result: every
//   Telegram/social preview of csboard.com read "Check your api.lis-skins.com/v1
//   balance, then sell CS2 skins…" for three weeks — free brand exposure for a
//   competitor, on our highest-value snippet.
//
// Two independent layers, because either alone leaves the hole open:
//   1. classifier — never open an opportunity whose driving query names a
//      competitor. Kills it before an LLM call is ever made.
//   2. quality gate — reject any proposal whose text names a competitor, even
//      if the driving query was clean (the generator can still hallucinate one).
//
// Buff163 is deliberately NOT blocked: it is our published pricing source and
// is already named across bundled i18n copy. That's a product decision, not
// bot drift — if it ever changes, move it into COMPETITOR_TERMS.

/**
 * Competitor brands / domains that must never appear in bot-written public copy.
 * Written to match the way each actually shows up in search queries (with or
 * without the TLD, hyphenated or not).
 */
const COMPETITOR_TERMS = [
  "lis-skins", "lisskins", "lis skins",
  "skinport",
  "cs.money", "csmoney", "cs money",
  "dmarket",
  "csfloat", "cs float",
  "waxpeer", "wax peer",
  "tradeit.gg", "tradeit",
  "skinbaron", "skin baron",
  "bitskins",
  "shadowpay",
  "skinsmonkey", "skins monkey",
  "swap.gg",
  "cs.deals", "csdeals",
  "market.csgo",
  "skin.place", "skinplace",
  "lootbear", "loot bear",
  "gamerpay",
  "haloskins", "halo skins",
  "white.market", "whitemarket",
  "skinout",
  "skincashier",
  "skinsback",
  "c4skin", "c4 skin",
  "assetpay",
  "skindeck",
  "steamanalyst",
] as const;

/**
 * Bare domains are never acceptable in a meta description or body copy, even
 * for brands we don't otherwise block — a snippet that reads like a URL bar
 * looks broken in the SERP and in link previews. Our own hosts (and the
 * deliberate `csbord` typo-target) are the only exceptions.
 */
const DOMAIN_RE = /\b(?!csboard\.|csbord\.|cs2board\.)[a-z0-9][a-z0-9-]{1,}\.(?:com|net|org|ru|gg|io|co|market|trade|place|deals|shop|store|xyz|app)\b/i;

const COMPETITOR_RE = new RegExp(
  "(?:" + COMPETITOR_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")",
  "i",
);

/**
 * Brand names we DO write. Everything else that looks like a brand is treated
 * as foreign — see findForeignBrandToken.
 */
const OUR_BRANDS = new Set([
  "csboard", "csboard.com", "csboard.trade", "csboard's",
  "cs2", "csgo", "cs:go", "counter-strike",
  "stattrak", "stattrak™", "steam",
  "usdt", "usdc", "trc20", "bep20", "erc20",
  "buff163",
  // payment rails we actually pay out on and must be able to name — PayPal is
  // a real withdrawal rail via PayBridge (see backend routes/balance.ts), and
  // /sell has advertised it since 2026-07 on purpose.
  "antilopay", "fungies", "nowpayments", "paybridge", "paypal", "paypal's",
]);

/**
 * Tokens shaped like a brand name: camelCase ("PlayBattleSquare") or an acronym
 * glued to a word ("CSfade", "DMarket", "CSFloat"). Ordinary prose never looks
 * like this — a sentence-initial "Selling" or a skin name like "Calligrafaux"
 * has a single leading capital and is left alone, and weapon codes ("AK-47",
 * "M4A1-S", "XM1014") carry no lowercase after their capitals.
 *
 * Hyphen-Capitalised words are deliberately NOT a trigger: that shape belongs
 * to CS2 vocabulary ("Field-Tested", "Battle-Scarred", "Counter-Strike",
 * "Five-SeveN") far more often than to a brand, and the hyphenated rivals that
 * do exist ("Lis-Skins") are already covered by COMPETITOR_TERMS.
 *
 * This is the generic form of the competitor list below. The list only knows
 * the rivals we thought of; on 2026-08-05 the bot answered the GSC query
 * "selling cs2 skins internationally playbattlesquare" by putting
 * PlayBattleSquare — a site nobody had listed — into the /sell description.
 */
const BRANDISH = /[a-z][A-Z]|[A-Z]{2,}[a-z]/;
const TOKEN_RE = /[A-Za-z][A-Za-z0-9.™:]*(?:-[A-Za-z0-9]+)*/g;

/** "SMGs", "AWPs", "NFTs" — a pluralised acronym, not an acronym glued to a word. */
const PLURAL_ACRONYM = /^[A-Z0-9]{2,}s$/;

export function findForeignBrandToken(text: string): string | null {
  for (const m of text.match(TOKEN_RE) ?? []) {
    if (!BRANDISH.test(m)) continue;
    if (PLURAL_ACRONYM.test(m)) continue;
    if (OUR_BRANDS.has(m.toLowerCase().replace(/[.,;:!?]+$/, ""))) continue;
    return m;
  }
  return null;
}

/**
 * First competitor term found in `text`, or null. Case-insensitive.
 */
export function findCompetitorMention(text: string): string | null {
  const m = COMPETITOR_RE.exec(text);
  return m ? m[0] : null;
}

/**
 * First foreign domain found in `text`, or null. Our own hosts don't count.
 */
export function findForeignDomain(text: string): string | null {
  const m = DOMAIN_RE.exec(text);
  return m ? m[0] : null;
}

/**
 * True when a GSC query must never drive generated content: it names a
 * competitor, or it is a raw URL/endpoint lookup. Such queries bring traffic
 * that will never convert, and targeting them puts someone else's brand in
 * our snippet.
 */
export function isPoisonedQuery(query: string | null | undefined, path?: string | null): string | null {
  if (!query) return null;
  // A comparison page is allowed to chase "<competitor> alternative" demand —
  // that is its whole reason to exist. Everywhere else a competitor-branded
  // query can only be answered by naming them, on a page that shouldn't.
  if (!allowsCompetitorMentions(path)) {
    const competitor = findCompetitorMention(query);
    if (competitor) return `competitor brand in query: "${competitor}"`;
  }
  // Search queries arrive lowercased, so the brandish shape can't be read off
  // them — but a query that glues a third-party site name onto a CS2 phrase
  // ("selling cs2 skins internationally playbattlesquare") is navigational to
  // someone else either way. Catching it needs the token list; the shape rule
  // in findForeignBrandToken is what stops the unlisted ones reaching the CMS.
  const domain = findForeignDomain(query);
  if (domain) return `foreign domain in query: "${domain}"`;
  // API-endpoint-shaped lookups ("/v1/user/balance", "api.<something>") are
  // developer traffic hunting someone else's docs, not buyers — no page of
  // ours should be rewritten to court them.
  if (/\/v\d\b|\bapi\.[a-z0-9-]+\b/i.test(query)) return "API endpoint lookup, not buyer intent";
  return null;
}

/**
 * Pages whose whole purpose is a side-by-side with named marketplaces. Naming
 * a competitor there is the content, not a leak — the existing copy on both
 * already does it. Everywhere else (home above all) it is a defect.
 */
const COMPARISON_PATHS = new Set(["/comparison", "/cs2-trading-sites"]);

export function allowsCompetitorMentions(path: string | null | undefined): boolean {
  if (!path) return false;
  // Blog posts are editorial: blog-post.ts explicitly instructs factual,
  // vendor-neutral comparison and names competitors by design.
  if (path.startsWith("/blog")) return true;
  return COMPARISON_PATHS.has(path);
}

/**
 * True when generated copy must be rejected before it reaches the CMS.
 * `path` opts comparison pages out of the competitor-name check only — a bare
 * foreign domain still never belongs in a snippet.
 */
export function findBrandViolation(text: string, path?: string | null): string | null {
  if (!allowsCompetitorMentions(path)) {
    const competitor = findCompetitorMention(text);
    if (competitor) return `competitor mention: "${competitor}"`;
    // Item pages are exempt from the SHAPE rule (not from the competitor list):
    // their copy is built from the item's own name, and CS2 itself is full of
    // camelCase — "Five-SeveN", and every team sticker from "iBUYPOWER" to
    // "FaZe". The explicit competitor list still guards them.
    if (!path || !path.startsWith("/items")) {
      const foreign = findForeignBrandToken(text);
      if (foreign) return `foreign brand name: "${foreign}"`;
    }
  }
  const domain = findForeignDomain(text);
  if (domain) return `foreign domain: "${domain}"`;
  return null;
}

/** Explicit attribution marker for neutral editorial comparisons only. */
export function mentionsCompetitor(text: string): boolean { return COMPETITOR_RE.test(text); }
