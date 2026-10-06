// GA4 Data API client. We pull just enough to corroborate GSC clicks
// with on-site engagement (sessions, engagement rate per landing page).
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { replaceGa4Window, type Ga4Row } from "../db/repo.js";

let client: BetaAnalyticsDataClient | null = null;

function getClient(): BetaAnalyticsDataClient {
  if (client) return client;
  client = new BetaAnalyticsDataClient({ keyFilename: config.GOOGLE_APPLICATION_CREDENTIALS });
  return client;
}

export async function pullLandingPages(args: { sinceDate: string; untilDate: string }, reportClient?: Pick<BetaAnalyticsDataClient, "runReport">): Promise<number> {
  if (!config.GA4_PROPERTY_ID) {
    logger.warn("GA4_PROPERTY_ID not set, skipping ga4 pull");
    return 0;
  }
  const ga = reportClient ?? getClient();
  const property = `properties/${config.GA4_PROPERTY_ID}`;
  const rows: Ga4Row[] = [];
  const pageSize = 5000;
  for (let offset = 0; ; offset += pageSize) {
    const [resp] = await ga.runReport({
      property,
      dateRanges: [{ startDate: args.sinceDate, endDate: args.untilDate }],
      dimensions: [
        { name: "landingPagePlusQueryString" },
        { name: "hostName" },
        { name: "sessionDefaultChannelGroup" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "engagementRate" },
      ],
      limit: pageSize,
      offset,
      orderBys: ["landingPagePlusQueryString", "hostName", "sessionDefaultChannelGroup"].map(dimensionName => ({ dimension: { dimensionName } })),
    });
    const batch: Ga4Row[] = (resp.rows || []).map((r) => {
      const dim = r.dimensionValues || [];
      const met = r.metricValues || [];
      return {
        property_id: config.GA4_PROPERTY_ID!,
        snapshot_date: args.untilDate,
        landing_page: dim[0]?.value ?? null,
        host: dim[1]?.value ?? null,
        channel: dim[2]?.value ?? null,
        sessions: parseInt(met[0]?.value ?? "0", 10) || 0,
        engaged: parseInt(met[1]?.value ?? "0", 10) || 0,
        engagement_rate: parseFloat(met[2]?.value ?? "0") || 0,
      };
    });
    rows.push(...batch);
    const expected = resp.rowCount == null ? null : Number(resp.rowCount);
    if (expected !== null && offset + batch.length >= expected) break;
    if (batch.length < pageSize) {
      if (expected !== null && offset + batch.length < expected) throw new Error("GA4 returned an incomplete page; keeping previous snapshot");
      break;
    }
    if (offset >= 995000) throw new Error("GA4 pull exceeds one million rows; refusing partial snapshot");
  }
  return replaceGa4Window(config.GA4_PROPERTY_ID, args.sinceDate, args.untilDate, rows);
}
