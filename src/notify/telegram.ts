// Minimal Telegram client. Reuses the vps-monitor bot — sends to Artem's DM.
// HTML parse mode, retry-safe (network blips) but never throws upstream.
import { config } from "../config.js";
import { logger } from "../logger.js";

const BASE = "https://api.telegram.org";

export interface SendOptions {
  threadId?: string | number;
  silent?: boolean;
  disableLinkPreview?: boolean;
  replyMarkup?: unknown;
}

export async function sendMessage(text: string, opts: SendOptions = {}): Promise<{ message_id?: number } | null> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logger.warn("telegram disabled (missing token or chat_id)");
    return null;
  }
  const url = `${BASE}/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: config.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: opts.disableLinkPreview ?? true,
    disable_notification: opts.silent ?? false,
  };
  const threadId = opts.threadId ?? config.TELEGRAM_THREAD_ID;
  if (threadId) body.message_thread_id = Number(threadId);
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
      if (j.ok) return { message_id: j.result?.message_id };
      // 4xx → no retry (bad input)
      if (res.status >= 400 && res.status < 500) {
        logger.warn({ status: res.status, desc: j.description }, "telegram 4xx — not retrying");
        return null;
      }
    } catch (e) {
      logger.warn({ attempt, err: (e as Error).message }, "telegram retrying");
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  logger.error("telegram failed after 3 attempts");
  return null;
}

/** Escape user-supplied text for inclusion in HTML mode. */
export function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a section of bullets. */
export function bullets(items: string[]): string {
  return items.map((s) => `• ${s}`).join("\n");
}
