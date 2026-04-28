import "dotenv/config";
import { z } from "zod";
import path from "node:path";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SERVICE_NAME: z.string().default("autonomous-seo-bot"),
  DB_PATH: z.string().default(path.resolve(process.cwd(), "data/seo.db")),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(9100),
  HTTP_HOST: z.string().default("127.0.0.1"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),

  // Site context
  SITE_URLS: z.string().default(""),       // "en=https://example.com,ru=https://example.ru"
  PRIMARY_SITE_URL: z.string().default("https://example.com"),

  // Brand voice
  BRAND_BLURB: z.string().default(""),
  BRAND_TERMS_REGEX: z.string().default(""),

  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GA4_PROPERTY_ID: z.string().optional(),
  GSC_SITES: z.string().default(""),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_DAILY_BUDGET_USD: z.coerce.number().default(1.0),
  OPENROUTER_MONTHLY_BUDGET_USD: z.coerce.number().default(30.0),
  OPENROUTER_REFERER: z.string().default("https://example.com"),
  OPENROUTER_APP_TITLE: z.string().default("autonomous-seo-bot"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_THREAD_ID: z.string().optional(),

  AUTO_APPLY_LOW_RISK: z.coerce.boolean().default(true),
  MAX_AUTO_CHANGES_PER_DAY: z.coerce.number().int().default(20),
  COOLDOWN_AFTER_REGRESSION_HOURS: z.coerce.number().int().default(24),
});

export const config = Schema.parse(process.env);
export type Config = z.infer<typeof Schema>;

export const gscSites = (): string[] =>
  config.GSC_SITES.split(",").map((s) => s.trim()).filter(Boolean);

export const allowedOrigins = (): string[] =>
  config.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

/** Parse SITE_URLS env var into a {locale: url} map. */
export function siteUrlMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of config.SITE_URLS.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const locale = pair.slice(0, eq).trim();
    const url = pair.slice(eq + 1).trim();
    if (locale && url) out[locale] = url;
  }
  return out;
}

/** Compiled brand-name regex, or null if not configured. */
export function brandTermsRegex(): RegExp | null {
  if (!config.BRAND_TERMS_REGEX.trim()) return null;
  try {
    return new RegExp(config.BRAND_TERMS_REGEX, "i");
  } catch {
    return null;
  }
}
