// Image URL resolver — turns an item slug or weapon name into a verified
// cs2c.app image URL. Two strategies:
//   1. Static lookup table (synced from production probes 2026-05-18) —
//      hot path, zero network.
//   2. Live fetch — calls csboard backend /api/items/:slug for unknowns,
//      caches in memory for the rest of the process lifetime.
//
// Why: LLM-generated blocks routinely guess `image` URLs incorrectly. The
// blog renderer then shows broken-image icons (real bug observed in
// Session 5 with AK-47 + M9 Bayonet). This module is the centralized
// resolution gate — generator calls it, renderer trusts the resolved URL.

import { logger } from "../logger.js";

const CDN_BASE = "https://cdn.cs2c.app/images/econ/default_generated";

// Verified-on-2026-05-18 lookup. Each entry maps a normalized item-slug
// fragment (or weapon+finish pair) to the canonical filename. When more
// items need coverage, extend this table — don't change the fetch flow.
//
// Naming convention quirks worth knowing:
//   - AK-47 Case Hardened = `weapon_ak47_aq_oiled` (no `rif_` prefix)
//   - M9 Bayonet = `weapon_knife_m9_bayonet` (full word, not `m9_bay`)
//   - Skeleton Knife = `weapon_knife_skeleton`
//   - Huntsman Knife = `weapon_knife_tactical` (internal name)
//   - Talon Knife = `weapon_knife_widowmaker`
//   - Five-SeveN = `weapon_fiveseven` (no `pist_` prefix)
//   - Heat Treated images on cs2c.app — UNKNOWN, table returns null
//
// For Case Hardened the finish suffix is always `aq_oiled_medium_png.png`.
const STATIC_MAP: Record<string, string> = {
  // Karambit
  "karambit-case-hardened": `${CDN_BASE}/weapon_knife_karambit_aq_oiled_medium_png.png`,
  "karambit-vanilla":       `${CDN_BASE}/weapon_knife_karambit_aq_oiled_medium_png.png`,
  // M9 Bayonet
  "m9-bayonet-case-hardened": `${CDN_BASE}/weapon_knife_m9_bayonet_aq_oiled_medium_png.png`,
  // Butterfly
  "butterfly-knife-case-hardened": `${CDN_BASE}/weapon_knife_butterfly_aq_oiled_medium_png.png`,
  // Talon (internal name: widowmaker)
  "talon-knife-case-hardened": `${CDN_BASE}/weapon_knife_widowmaker_aq_oiled_medium_png.png`,
  // Skeleton
  "skeleton-knife-case-hardened": `${CDN_BASE}/weapon_knife_skeleton_aq_oiled_medium_png.png`,
  // Huntsman (internal: tactical)
  "huntsman-knife-case-hardened": `${CDN_BASE}/weapon_knife_tactical_aq_oiled_medium_png.png`,
  // Flip
  "flip-knife-case-hardened": `${CDN_BASE}/weapon_knife_flip_aq_oiled_medium_png.png`,
  // AK-47
  "ak-47-case-hardened":     `${CDN_BASE}/weapon_ak47_aq_oiled_medium_png.png`,
  "ak47-case-hardened":      `${CDN_BASE}/weapon_ak47_aq_oiled_medium_png.png`,
  // Pistols
  "five-seven-case-hardened":  `${CDN_BASE}/weapon_fiveseven_aq_oiled_medium_png.png`,
  "p250-case-hardened":        `${CDN_BASE}/weapon_p250_aq_oiled_medium_png.png`,
  // Commonly-referenced fillers — for blocks that name a generic skin (no CH/HT)
  // we fall back to a clean knife render so the visual stays on-theme.
  "_generic-knife":            `${CDN_BASE}/weapon_knife_karambit_aq_oiled_medium_png.png`,
  "_generic-weapon":           `${CDN_BASE}/weapon_ak47_aq_oiled_medium_png.png`,
};

const liveCache = new Map<string, string | null>();

/** Normalize a slug/name into a static-map key. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    // Drop the wear suffix so /items/karambit-case-hardened-field-tested
    // collapses to "karambit-case-hardened".
    .replace(/-(factory-new|minimal-wear|field-tested|well-worn|battle-scarred)$/, "")
    // Drop trailing -<tier> filters too.
    .replace(/-(tier-1|tier-2|tier-3)$/, "");
}

/** Static-table lookup. Returns null when unknown. */
function staticLookup(slug: string): string | null {
  return STATIC_MAP[normalize(slug)] ?? null;
}

/** Live fetch from the csboard backend, with an in-memory cache. */
async function liveFetch(slug: string, csboardApiUrl: string): Promise<string | null> {
  const cached = liveCache.get(slug);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`${csboardApiUrl.replace(/\/$/, "")}/api/items/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      liveCache.set(slug, null);
      return null;
    }
    const j = (await res.json()) as { item?: { image?: string } };
    const img = j?.item?.image ?? null;
    liveCache.set(slug, img);
    return img;
  } catch (e) {
    logger.debug({ slug, err: (e as Error).message }, "image-resolver: live fetch failed");
    liveCache.set(slug, null);
    return null;
  }
}

/** Best-effort image URL for a given slug or name.
 *  Order: static map → live backend → null. */
export async function resolveImage(slug: string, opts?: { fallbackKey?: string; apiUrl?: string }): Promise<string | null> {
  const direct = staticLookup(slug);
  if (direct) return direct;
  if (opts?.apiUrl) {
    const live = await liveFetch(slug, opts.apiUrl);
    if (live) return live;
  }
  if (opts?.fallbackKey) {
    const fb = staticLookup(opts.fallbackKey);
    if (fb) return fb;
  }
  return null;
}

/** Synchronous-only variant for callers that can't await (rare). */
export function resolveImageSync(slug: string, fallbackKey?: string): string | null {
  return staticLookup(slug) ?? (fallbackKey ? staticLookup(fallbackKey) : null);
}
