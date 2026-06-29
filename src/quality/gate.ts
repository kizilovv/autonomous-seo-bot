// Quality gate — runs on every LLM proposal BEFORE it gets persisted.
// Rejects AI-slop, off-topic outputs, and barely-changed rewrites.

const FORBIDDEN_PHRASES_EN = [
  "in today's market",
  "in todays market",
  "delve into",
  "dive deep",
  "discover the world",
  "welcome to the world",
  "in the realm of",
  "elevate your game",
  "look no further",
  "look further",
  "ever-evolving",
  "ever evolving",
  "world of cs2 trading",
  "in the dynamic world",
  "the world of",
  "embark on a journey",
  "unleash the power",
  "unlock the secret",
  "it's important to note",
  "it is important to note",
  "as we navigate",
  "in the fast-paced",
  "rest assured",
];

const FORBIDDEN_PHRASES_RU = [
  "в современном мире",
  "это не просто",
  "в наше время",
  "в эпоху цифровых",
  "в динамичном мире",
  "в стремительно меняющемся",
  "погрузитесь в",
  "откройте для себя",
  "не упустите шанс",
  "стоит отметить, что",
  "следует отметить",
  "важно понимать, что",
  "не забывайте, что",
  "благодаря нашей платформе",
  "наша платформа предлагает",
  "стоит подчеркнуть",
];

export interface GateInput {
  text: string;          // proposal value (already JSON.stringify'd or raw string for snippets)
  query: string | null;  // GSC query the proposal targets
  field: string;         // 'title' | 'description' | 'intro_extra' | 'faq'
  current: string | null; // current value in CMS (if any) for similarity check
  locale: "en" | "ru";
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

const PHRASE_MAP: Record<"en" | "ru", string[]> = {
  en: FORBIDDEN_PHRASES_EN.map((s) => s.toLowerCase()),
  ru: FORBIDDEN_PHRASES_RU.map((s) => s.toLowerCase()),
};

/**
 * Rough char-level similarity 0..1. Cheap, no dep.
 * Used only to detect "barely changed" rewrites.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  // Normalised Levenshtein distance via DP. Small strings only — pages caps below 1k chars.
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const dist = dp[n];
  return 1 - dist / max;
}

/**
 * Returns the first forbidden phrase found in `text` (case-insensitive),
 * or null if none. Phrase list is locale-specific.
 */
export function findForbiddenPhrase(text: string, locale: "en" | "ru"): string | null {
  const lc = text.toLowerCase();
  for (const p of PHRASE_MAP[locale]) {
    if (lc.includes(p)) return p;
  }
  return null;
}

/**
 * Whether the target query (or substantial parts of it) appears in the text.
 * For multi-word queries we accept if 2/3 of meaningful tokens are present.
 */
export function queryPresent(text: string, query: string): boolean {
  if (!query) return true;
  const lc = text.toLowerCase();
  if (lc.includes(query.toLowerCase())) return true;
  // Token fallback: 2/3 of tokens (>=3 chars, non-stopword) present
  const stop = new Set(["the", "a", "for", "and", "to", "in", "on", "of", "ru", "en", "cs2", "и", "в", "на", "для", "из"]);
  const tokens = query
    .toLowerCase()
    .split(/[^\w\sа-яё]+/giu)
    .join(" ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stop.has(t));
  if (!tokens.length) return true;
  const hits = tokens.filter((t) => lc.includes(t)).length;
  return hits / tokens.length >= 0.66;
}

const FIELD_MAX_CHARS: Record<string, number> = {
  title: 70,            // hard SERP cap is ~60 visible, allow a tiny buffer
  description: 170,     // ~160 visible
  h1: 90,
  intro: 600,
  intro_extra: 900,     // ~150 words
  keywords: 800,
  // FAQ checked separately — array of {q,a}
};

/**
 * Run all gates. Returns {ok:false, reason} on the first failure.
 */
export function runGate(input: GateInput): GateResult {
  const { text, query, field, current, locale } = input;

  if (!text || !text.trim()) return { ok: false, reason: "empty proposal" };

  // 1) Length cap
  const cap = FIELD_MAX_CHARS[field];
  if (cap && text.length > cap) {
    return { ok: false, reason: `${field} too long: ${text.length} > ${cap} chars` };
  }

  // 2) Forbidden AI-slop phrases
  const bad = findForbiddenPhrase(text, locale);
  if (bad) return { ok: false, reason: `forbidden phrase: "${bad}"` };

  // 3) Query coverage (skip for title — it's a brand-only line sometimes)
  if (query && field !== "title") {
    if (!queryPresent(text, query)) {
      return { ok: false, reason: `target query "${query}" not present in text` };
    }
  }

  // 4) Brand-bleed check — proposal mentions csboard variants too aggressively
  // (more than 2 mentions in <300 chars = spam-y self-promo)
  const brandHits = (text.match(/csboard|cs ?board|csboardtrade/gi) ?? []).length;
  if (text.length < 300 && brandHits > 2) {
    return { ok: false, reason: `over-branded (${brandHits} mentions in ${text.length} chars)` };
  }

  // 5) Similarity to current — skip apply if barely a refresh
  if (current && current.length > 30) {
    const sim = similarity(text, current);
    if (sim > 0.7) {
      return { ok: false, reason: `barely changed (similarity ${sim.toFixed(2)} > 0.70)` };
    }
  }

  return { ok: true };
}

/**
 * FAQ-specific gate (different shape — array of {q,a}).
 */
export function runGateForFaqItem(item: { q: string; a: string }, query: string | null, locale: "en" | "ru"): GateResult {
  if (!item.q || item.q.length < 12) return { ok: false, reason: "FAQ q too short" };
  if (item.q.length > 150) return { ok: false, reason: `FAQ q too long: ${item.q.length} chars` };
  if (!item.a || item.a.length < 60) return { ok: false, reason: "FAQ a too short" };
  if (item.a.length > 340) return { ok: false, reason: `FAQ a too long: ${item.a.length} chars` };
  const bad = findForbiddenPhrase(item.q + " " + item.a, locale);
  if (bad) return { ok: false, reason: `FAQ forbidden phrase: "${bad}"` };
  if (query && !queryPresent(item.q + " " + item.a, query)) {
    return { ok: false, reason: `FAQ doesn't address query "${query}"` };
  }
  return { ok: true };
}
