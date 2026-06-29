// IndexNow — real-time URL change notification.
// Bing, Yandex, Yep, Naver, Seznam, DuckDuckGo all consume this single endpoint.
// Google does NOT support IndexNow — for Google we hit it with sitemap submission instead.
//
// Setup:
//   1) Generate one-time key (32-byte hex)
//   2) Host key at https://csboard.com/<key>.txt (file content = the key itself)
//   3) After applying SEO changes, POST changed URLs to api.indexnow.org
//
// Spec: https://www.indexnow.org/documentation

import { config } from "../config.js";
import { logger } from "../logger.js";

const KEY = config.INDEXNOW_KEY;
const ENDPOINT = "https://api.indexnow.org/indexnow";

interface PingArgs {
  host: string;          // 'csboard.com' (no protocol)
  urlList: string[];     // full https URLs
}

export async function indexNowPing(args: PingArgs): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!KEY) {
    logger.debug("indexnow: INDEXNOW_KEY not set, skipping");
    return { ok: false, error: "no key" };
  }
  if (!args.urlList.length) return { ok: true };

  // Spec: max 10000 URLs per request, dedupe
  const urls = [...new Set(args.urlList)].slice(0, 10000);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        host: args.host,
        key: KEY,
        keyLocation: `https://${args.host}/${KEY}.txt`,
        urlList: urls,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // 200 OK → success. 202 Accepted → success (queued for processing).
    // 422 → invalid URLs (some). 4xx → bad key / file mismatch.
    if (res.ok || res.status === 202) {
      logger.info({ host: args.host, count: urls.length, status: res.status }, "indexnow ping ok");
      return { ok: true, status: res.status };
    }
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: body.slice(0, 200) }, "indexnow ping failed");
    return { ok: false, status: res.status, error: body.slice(0, 200) };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "indexnow ping error");
    return { ok: false, error: (e as Error).message };
  }
}

/** Group URLs by host and ping each host separately (IndexNow spec requires one host per request). */
export async function indexNowPingMulti(urls: string[]): Promise<{ pings: number; ok: number }> {
  const byHost = new Map<string, string[]>();
  for (const u of urls) {
    try {
      const url = new URL(u);
      const list = byHost.get(url.host) ?? [];
      list.push(u);
      byHost.set(url.host, list);
    } catch { /* skip invalid */ }
  }
  let ok = 0;
  for (const [host, urlList] of byHost) {
    const r = await indexNowPing({ host, urlList });
    if (r.ok) ok++;
  }
  return { pings: byHost.size, ok };
}
