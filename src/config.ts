import "dotenv/config";
import { z } from "zod";
import path from "node:path";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DB_PATH: z.string().default(path.resolve(process.cwd(), "data/seo.db")),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(9100),
  HTTP_HOST: z.string().default("127.0.0.1"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),

  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GA4_PROPERTY_ID: z.string().optional(),
  GSC_SITES: z.string().default("sc-domain:csboard.com,sc-domain:csboard.trade"),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_DAILY_BUDGET_USD: z.coerce.number().default(1.0),
  OPENROUTER_MONTHLY_BUDGET_USD: z.coerce.number().default(30.0),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_THREAD_ID: z.string().optional(),

  AUTO_APPLY_LOW_RISK: z.coerce.boolean().default(true),
  MAX_AUTO_CHANGES_PER_DAY: z.coerce.number().int().default(20),
  COOLDOWN_AFTER_REGRESSION_HOURS: z.coerce.number().int().default(24),

  // IndexNow — Bing/Yandex real-time URL change ping. Generate a 32-byte hex
  // key, host its .txt file in csboard frontend's public/, set the key here.
  INDEXNOW_KEY: z.string().optional(),

  // DataForSEO competitor-gap worker (Phase 5, 2026-05-18).
  // Credentials in `~/.dataforseo/credentials` on Koara; injected via .env.
  DATAFORSEO_USERNAME: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  // Per-call hard cap — refuse to spend more than this in one POST.
  DATAFORSEO_PER_CALL_CAP_USD: z.coerce.number().default(0.20),
  // Soft daily/monthly caps — worker stops gracefully if next call would exceed.
  DATAFORSEO_DAILY_BUDGET_USD: z.coerce.number().default(0.50),
  DATAFORSEO_MONTHLY_BUDGET_USD: z.coerce.number().default(15.0),
  // Rotation: list of competitor domains for the daily pull (one per weekday slot).
  DATAFORSEO_COMPETITORS: z.string().default("cs.money,skinport.com,dmarket.com,buff.market"),
  // Where csboard.com itself is tracked (gap = competitor minus csboard kw set).
  DATAFORSEO_OWN_DOMAIN: z.string().default("csboard.com"),
});

export const config = Schema.parse(process.env);
export type Config = z.infer<typeof Schema>;

export const gscSites = (): string[] =>
  config.GSC_SITES.split(",").map((s) => s.trim()).filter(Boolean);

export const allowedOrigins = (): string[] =>
  config.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
