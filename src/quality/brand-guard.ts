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
export function isPoisonedQuery(query: string | null | undefined): string | null {
  if (!query) return null;
  const competitor = findCompetitorMention(query);
  if (competitor) return `competitor brand in query: "${competitor}"`;
  const domain = findForeignDomain(query);
  if (domain) return `foreign domain in query: "${domain}"`;
  // API-endpoint-shaped lookups ("/v1/user/balance", "api.<something>") are
  // developer traffic hunting someone else's docs, not buyers.
  if (/\/v\d\b|\bapi\.[a-z0-9-]+\b/i.test(query)) return "API endpoint lookup, not buyer intent";
  return null;
}

/**
 * True when generated copy must be rejected before it reaches the CMS.
 */
export function findBrandViolation(text: string): string | null {
  const competitor = findCompetitorMention(text);
  if (competitor) return `competitor mention: "${competitor}"`;
  const domain = findForeignDomain(text);
  if (domain) return `foreign domain: "${domain}"`;
  return null;
}
