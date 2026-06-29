// One-off deep GA4 analysis — answers Artem's audit questions:
//   1. What events/conversions exist (discover the registration event)
//   2. Blog landing pages: sessions → did they convert / engage?
//   3. Engagement time + bounce by page type (blog vs /sell vs /trades vs /items)
//   4. Organic-search funnel: landing page → key events
//   5. New users vs returning, retention signal
//
// Run on the server:  node scripts/ga4-deep-analysis.mjs
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const PROPERTY = "properties/" + (process.env.GA4_PROPERTY_ID || "337655668");
const KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/srv/csboard-seo/.secrets/google-service-account.json";
const ga = new BetaAnalyticsDataClient({ keyFilename: KEYFILE });

const today = new Date();
const end = new Date(today.getTime() - 86400_000).toISOString().slice(0, 10);
const start = new Date(today.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
const range = [{ startDate: start, endDate: end }];

function rowsOf(resp) {
  return (resp.rows || []).map((r) => ({
    dims: (r.dimensionValues || []).map((d) => d.value),
    mets: (r.metricValues || []).map((m) => m.value),
  }));
}

async function run() {
  console.log(`=== GA4 deep analysis | ${start} → ${end} | property ${PROPERTY} ===\n`);

  // ----- 1. What key events / conversions exist -----
  console.log("--- 1. KEY EVENTS (all event names by count) ---");
  try {
    const [ev] = await ga.runReport({
      property: PROPERTY,
      dateRanges: range,
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 40,
    });
    for (const r of rowsOf(ev)) {
      console.log(`  ${r.dims[0].padEnd(32)} count=${String(r.mets[0]).padStart(8)} users=${String(r.mets[1]).padStart(7)}`);
    }
  } catch (e) { console.log("  ERROR:", e.message); }

  // ----- 2. Engagement by page-type (manual bucketing of landingPage) -----
  console.log("\n--- 2. ENGAGEMENT by landing page (organic search only, top 25) ---");
  try {
    const [lp] = await ga.runReport({
      property: PROPERTY,
      dateRanges: range,
      dimensions: [{ name: "landingPagePlusQueryString" }, { name: "hostName" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "averageSessionDuration" },
        { name: "bounceRate" },
        { name: "keyEvents" },
      ],
      dimensionFilter: {
        filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } },
      },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 25,
    });
    console.log("  page".padEnd(52), "sess".padStart(6), "eng%".padStart(6), "avg_s".padStart(7), "bounce".padStart(7), "keyEv".padStart(6));
    for (const r of rowsOf(lp)) {
      const page = (r.dims[1] + r.dims[0]).slice(0, 50);
      const sess = +r.mets[0], eng = +r.mets[1], dur = +r.mets[2], bounce = +r.mets[3], ke = +r.mets[4];
      console.log(`  ${page.padEnd(50)} ${String(sess).padStart(6)} ${(eng/sess*100||0).toFixed(0).padStart(5)}% ${dur.toFixed(0).padStart(6)}s ${(bounce*100).toFixed(0).padStart(6)}% ${String(ke).padStart(6)}`);
    }
  } catch (e) { console.log("  ERROR:", e.message); }

  // ----- 3. Blog pages specifically: sessions → key events -----
  console.log("\n--- 3. BLOG PAGES — do readers convert? (landingPage contains /blog/) ---");
  try {
    const [blog] = await ga.runReport({
      property: PROPERTY,
      dateRanges: range,
      dimensions: [{ name: "landingPagePlusQueryString" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "averageSessionDuration" },
        { name: "keyEvents" },
        { name: "totalUsers" },
        { name: "newUsers" },
      ],
      dimensionFilter: {
        filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "CONTAINS", value: "/blog/" } },
      },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 30,
    });
    let totSess = 0, totEng = 0, totKe = 0;
    console.log("  blog page".padEnd(54), "sess".padStart(6), "eng".padStart(5), "avg_s".padStart(7), "keyEv".padStart(6));
    for (const r of rowsOf(blog)) {
      const page = r.dims[0].slice(0, 52);
      const sess = +r.mets[0], eng = +r.mets[1], dur = +r.mets[2], ke = +r.mets[3];
      totSess += sess; totEng += eng; totKe += ke;
      console.log(`  ${page.padEnd(52)} ${String(sess).padStart(6)} ${String(eng).padStart(5)} ${dur.toFixed(0).padStart(6)}s ${String(ke).padStart(6)}`);
    }
    console.log(`  ${"".padEnd(52)} ${"-----".padStart(6)}`);
    console.log(`  TOTAL blog: ${totSess} sessions, ${totEng} engaged (${(totEng/totSess*100||0).toFixed(0)}%), ${totKe} key events`);
    console.log(`  → key-event rate on blog traffic: ${(totKe/totSess*100||0).toFixed(2)}%`);
  } catch (e) { console.log("  ERROR:", e.message); }

  // ----- 4. Compare: blog vs core pages key-event rate -----
  console.log("\n--- 4. KEY-EVENT RATE by page bucket (all traffic) ---");
  const buckets = [
    { name: "blog", contains: "/blog/" },
    { name: "/sell", contains: "/sell" },
    { name: "/trades", contains: "/trades" },
    { name: "/items", contains: "/items/" },
    { name: "homepage", exact: true },
  ];
  for (const b of buckets) {
    try {
      const filter = b.exact
        ? { orGroup: { expressions: [
            { filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "EXACT", value: "/en" } } },
            { filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "EXACT", value: "/ru" } } },
          ] } }
        : { filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "CONTAINS", value: b.contains } } };
      const [r] = await ga.runReport({
        property: PROPERTY,
        dateRanges: range,
        metrics: [
          { name: "sessions" },
          { name: "engagedSessions" },
          { name: "averageSessionDuration" },
          { name: "keyEvents" },
          { name: "newUsers" },
        ],
        dimensionFilter: filter,
      });
      const m = rowsOf(r)[0]?.mets || ["0","0","0","0","0"];
      const sess = +m[0], eng = +m[1], dur = +m[2], ke = +m[3], nu = +m[4];
      console.log(`  ${b.name.padEnd(12)} sessions=${String(sess).padStart(6)}  engaged=${(eng/sess*100||0).toFixed(0)}%  avg=${dur.toFixed(0)}s  keyEvents=${ke}  keyEvRate=${(ke/sess*100||0).toFixed(2)}%  newUsers=${nu}`);
    } catch (e) { console.log(`  ${b.name}: ERROR ${e.message}`); }
  }

  // ----- 5. New vs returning + overall retention signal -----
  console.log("\n--- 5. NEW vs RETURNING users (organic search) ---");
  try {
    const [nr] = await ga.runReport({
      property: PROPERTY,
      dateRanges: range,
      dimensions: [{ name: "newVsReturning" }],
      metrics: [{ name: "sessions" }, { name: "averageSessionDuration" }, { name: "keyEvents" }],
    });
    for (const r of rowsOf(nr)) {
      console.log(`  ${(r.dims[0]||"(unknown)").padEnd(12)} sessions=${r.mets[0]}  avg=${(+r.mets[1]).toFixed(0)}s  keyEvents=${r.mets[2]}`);
    }
  } catch (e) { console.log("  ERROR:", e.message); }

  // ----- 6. Channel-level conversion comparison -----
  console.log("\n--- 6. CHANNEL → key events ---");
  try {
    const [ch] = await ga.runReport({
      property: PROPERTY,
      dateRanges: range,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }, { name: "averageSessionDuration" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 12,
    });
    for (const r of rowsOf(ch)) {
      const sess = +r.mets[0], eng = +r.mets[1], ke = +r.mets[2], dur = +r.mets[3];
      console.log(`  ${(r.dims[0]||"?").padEnd(20)} sessions=${String(sess).padStart(7)}  eng=${(eng/sess*100||0).toFixed(0)}%  keyEv=${String(ke).padStart(5)}  keyEvRate=${(ke/sess*100||0).toFixed(2)}%  avg=${dur.toFixed(0)}s`);
    }
  } catch (e) { console.log("  ERROR:", e.message); }

  console.log("\n=== done ===");
}

run().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
