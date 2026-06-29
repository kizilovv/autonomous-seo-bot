// Central cron registration. node-cron, UTC.
//
// Daily pipeline:
//   06:00 UTC — pull GSC + GA4
//   06:30 UTC — analyze (classify into opportunities)
//   07:00 UTC — generate proposals via OpenRouter
//   07:30 UTC — apply (auto for low-risk; review otherwise)
//   18:00 UTC — verify yesterday's applied changes
//   08:00 UTC — daily Telegram digest
//
// Each step is idempotent enough that re-running by hand is safe.

import cron from "node-cron";
import { runPull } from "./workers/pull.js";
import { runAnalyze } from "./workers/analyze.js";
import { runGenerate } from "./workers/generate.js";
import { runApply } from "./workers/apply.js";
import { runVerify } from "./workers/verify.js";
import { runDailyReport } from "./workers/daily-report.js";
import { runBlogGenerator } from "./workers/blog-generator.js";
import { runDataForSeoPull } from "./workers/dataforseo_pull.js";
import { logger } from "./logger.js";
import { sendMessage, esc } from "./notify/telegram.js";

function safe(label: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      logger.info({ label }, "cron tick start");
      const r = await fn();
      logger.info({ label, result: r }, "cron tick ok");
    } catch (e) {
      logger.error({ label, err: (e as Error).message }, "cron tick failed");
      try {
        await sendMessage(`⚠️ <b>${esc(label)}</b> failed: <code>${esc((e as Error).message).slice(0, 400)}</code>`);
      } catch { /* swallow */ }
    }
  };
}

const TZ = { timezone: "UTC" } as const;

// Kill-switch for daily new blog post auto-generation.
// Default OFF after 2026-05-05 audit:
//   - existing bot-generated blogs accumulated 5,000+ GSC impressions but only 9 clicks
//   - csboard.trade clicks fell -62% in 4 weeks (281 → 107) while impressions +57%
//   - hypothesis: low-CTR thin-content blogs cannibalize brand pages
// Snippet/title rewrites for EXISTING pages stay on (those help).
// Re-enable by setting `SEO_BOT_BLOG_GENERATOR=on` in pm2 env after CTR-feedback
// loop is added (see csboard/seo-bot-blog-disabled.md).
const BLOG_GENERATOR_ENABLED = process.env.SEO_BOT_BLOG_GENERATOR === "on";
const DFS_PULL_ENABLED = !!(process.env.DATAFORSEO_USERNAME && process.env.DATAFORSEO_PASSWORD);

export function registerCrons(): void {
  cron.schedule("0 6 * * *", safe("pull", runPull), TZ);
  cron.schedule("30 6 * * *", safe("analyze", runAnalyze), TZ);
  cron.schedule("0 7 * * *", safe("generate", runGenerate), TZ);
  cron.schedule("30 7 * * *", safe("apply", runApply), TZ);
  if (BLOG_GENERATOR_ENABLED) {
    cron.schedule("0 8 * * *", safe("blog-generator", runBlogGenerator), TZ);
  } else {
    logger.warn("blog-generator cron DISABLED (death-spiral guard, 2026-05-05). Set SEO_BOT_BLOG_GENERATOR=on to re-enable.");
  }
  cron.schedule("30 8 * * *", safe("daily-report", runDailyReport), TZ);
  // DataForSEO competitor-gap discovery — runs AFTER daily-report so today's
  // report stays clean; tomorrow's will pick up the new gap section.
  if (DFS_PULL_ENABLED) {
    cron.schedule("0 9 * * *", safe("dataforseo_pull", async () => runDataForSeoPull()), TZ);
  } else {
    logger.warn("dataforseo_pull cron DISABLED (creds missing). Set DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD to enable.");
  }
  cron.schedule("0 18 * * *", safe("verify", runVerify), TZ);
  // CTR feedback runs after verify — checks 7-21 day old applies vs latest GSC,
  // auto-rolls back changes that hurt CTR by >20%.
  cron.schedule("30 18 * * *", safe("ctr-feedback", async () => {
    const m = await import("./workers/ctr-feedback.js");
    return m.runCtrFeedback();
  }), TZ);

  logger.info(
    { blog_generator: BLOG_GENERATOR_ENABLED ? "on" : "off", dataforseo_pull: DFS_PULL_ENABLED ? "on" : "off" },
    "cron jobs registered (UTC): pull@06, analyze@06:30, generate@07, apply@07:30, report@08:30, dfs-pull@09, verify@18",
  );
}
