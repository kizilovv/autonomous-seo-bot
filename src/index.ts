import { runMigrations } from "./db/migrate.js";
import { startHttpServer } from "./http/server.js";
import { logger } from "./logger.js";
import { closeDb } from "./db/connection.js";
import { registerCrons } from "./cron.js";
import { sendMessage } from "./notify/telegram.js";

async function main() {
  logger.info("csboard-seo-bot starting");

  // 1) Schema is current
  runMigrations();

  // 2) Read-only HTTP API
  const app = await startHttpServer();

  // 3) Cron pipeline
  registerCrons();

  // 4) Optional boot ping (silent)
  await sendMessage("🟢 csboard-seo-bot online", { silent: true });

  // 5) Graceful shutdown
  const shutdown = async (sig: string) => {
    logger.info({ sig }, "shutting down");
    try { await app.close(); } catch (e) { logger.error({ err: (e as Error).message }, "http close failed"); }
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, "fatal");
  process.exit(1);
});
