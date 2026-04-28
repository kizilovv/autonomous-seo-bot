import { runMigrations } from "./db/migrate.js";
import { startHttpServer } from "./http/server.js";
import { logger } from "./logger.js";
import { closeDb } from "./db/connection.js";
import { registerCrons } from "./cron.js";
import { sendMessage } from "./notify/telegram.js";
import { config } from "./config.js";

async function main() {
  logger.info({ service: config.SERVICE_NAME }, "starting");

  runMigrations();

  const app = await startHttpServer();

  registerCrons();

  await sendMessage(`🟢 ${config.SERVICE_NAME} online`, { silent: true });

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
