// Google Search Console — direct REST calls.
// Avoids version drift between googleapis discovery + google-auth-library.
import { GoogleAuth } from "google-auth-library";
import { config, gscSites } from "../config.js";
import { logger } from "../logger.js";
import { insertGscRows, type GscRow } from "../db/repo.js";

const SC_BASE = "https://searchconsole.googleapis.com";

let auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (auth) return auth;
  auth = new GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  return auth;
}

async function bearer(): Promise<string> {
  const c = await getAuth().getClient();
  const t = await c.getAccessToken();
  if (!t.token) throw new Error("could not obtain GSC bearer token");
  return t.token;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await bearer();
  const url = `${SC_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GSC ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface SiteEntry { siteUrl?: string }
interface SitesListResponse { siteEntry?: SiteEntry[] }

export async function listAccessibleSites(): Promise<string[]> {
  const r = await api<SitesListResponse>("/webmasters/v3/sites");
  return (r.siteEntry || []).map((s) => s.siteUrl as string).filter(Boolean);
}

export interface PullArgs {
  sinceDate: string;
  untilDate: string;
}

interface SaRow {
  keys?: string[];
  impressions?: number;
  clicks?: number;
  ctr?: number;
  position?: number;
}
interface SaResponse { rows?: SaRow[] }

export async function pullSiteQueries(site: string, args: PullArgs): Promise<number> {
  const path = `/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  let total = 0;
  // We pull the query+page dimension only; that's the most useful for the classifier.
  const body = {
    startDate: args.sinceDate,
    endDate: args.untilDate,
    dimensions: ["query", "page"],
    rowLimit: 5000,
    dataState: "final",
  };
  const r = await api<SaResponse>(path, { method: "POST", body: JSON.stringify(body) });
  const mapped: GscRow[] = (r.rows || []).map((row) => {
    const keys = row.keys || [];
    return {
      site,
      snapshot_date: args.untilDate,
      query: keys[0] ?? null,
      page: keys[1] ?? null,
      impressions: row.impressions ?? 0,
      clicks: row.clicks ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
      country: null,
      device: null,
    };
  });
  total += insertGscRows(mapped);
  return total;
}

export async function pullAll(args: PullArgs): Promise<{ site: string; rows: number }[]> {
  const accessible = new Set(await listAccessibleSites());
  const results: { site: string; rows: number }[] = [];
  for (const site of gscSites()) {
    if (!accessible.has(site)) {
      logger.warn({ site }, "service account has no access to GSC site, skipping");
      continue;
    }
    const rows = await pullSiteQueries(site, args);
    results.push({ site, rows });
    logger.info({ site, rows }, "gsc pull complete");
  }
  return results;
}

interface InspectionResult {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      lastCrawlTime?: string;
    };
  };
}

export async function inspectUrl(siteUrl: string, inspectionUrl: string) {
  const body = { siteUrl, inspectionUrl, languageCode: "en-US" };
  const r = await api<InspectionResult>("/v1/urlInspection/index:inspect", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.inspectionResult;
}

/**
 * Submit a sitemap URL to GSC. Triggers Google to recrawl entries listed there.
 * Idempotent — safe to call daily for the same sitemap URL.
 */
export async function submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
  const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`;
  // PUT — empty body, idempotent.
  const token = await bearer();
  const res = await fetch(`${SC_BASE}${path}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${token}`, "Content-Length": "0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sitemap submit ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** Push a "url updated" notification for fast recrawl. Works only for JobPosting and BroadcastEvent
 * schema markup — for general SEO, prefer indexnow + sitemap.submit. */
export async function indexingApiPing(url: string, type: "URL_UPDATED" | "URL_DELETED" = "URL_UPDATED"): Promise<void> {
  const token = await bearer();
  const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, type }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`indexing api ${res.status}: ${body.slice(0, 200)}`);
  }
}
