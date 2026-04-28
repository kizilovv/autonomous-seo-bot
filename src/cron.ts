// Central cron registration. node-cron, UTC.
//
// Daily pipeline:
//   06:00 UTC — pull GSC + GA4
//   06:30 UTC — analyze (classify into opportunities)
//   07:00 UTC — generate proposals via OpenRouter
//   07:30 UTC — apply (auto for low-risk; review otherwise)
//   08:00 UTC — blog generator
//   08:30 UTC — daily Telegram digest
//   18:00 UTC — verify yesterday's applied changes
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

export function registerCrons(): void {
  cron.schedule("0 6 * * *", safe("pull", runPull), TZ);
  cron.schedule("30 6 * * *", safe("analyze", runAnalyze), TZ);
  cron.schedule("0 7 * * *", safe("generate", runGenerate), TZ);
  cron.schedule("30 7 * * *", safe("apply", runApply), TZ);
  cron.schedule("0 8 * * *", safe("blog-generator", runBlogGenerator), TZ);
  cron.schedule("30 8 * * *", safe("daily-report", runDailyReport), TZ);
  cron.schedule("0 18 * * *", safe("verify", runVerify), TZ);

  logger.info("cron jobs registered (UTC): pull@06, analyze@06:30, generate@07, apply@07:30, blogs@08, report@08:30, verify@18");
}
