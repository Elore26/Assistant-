// ============================================
// OREN AGENT SYSTEM — Shared Telegram Utilities
// All agents MUST use this instead of local copies
// Uses robustFetch for timeout + retry protection
// Supports HTML parse mode, inline keyboards, fallback
// ============================================

import { robustFetch } from "./robust-fetch.ts";

export interface SendTGOptions {
  /** Parse mode: "HTML" | "Markdown" (default: "HTML") */
  parseMode?: "HTML" | "Markdown";
  /** Inline keyboard buttons */
  buttons?: any[][];
  /** Disable web page preview (default: true) */
  disablePreview?: boolean;
}

/**
 * Send a Telegram message with optional inline keyboard.
 * Falls back to plain text if HTML/Markdown fails.
 * Returns true on success, false on failure (never throws).
 */
export async function sendTG(text: string, options?: SendTGOptions): Promise<boolean> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";
  if (!botToken) return false;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const parseMode = options?.parseMode ?? "HTML";
  const disablePreview = options?.disablePreview ?? true;

  try {
    const payload: any = {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disablePreview,
    };
    if (options?.buttons && options.buttons.length > 0) {
      payload.reply_markup = { inline_keyboard: options.buttons };
    }

    const r = await robustFetch(url, {
      timeoutMs: 10000,
      retries: 2,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    });

    if (r.ok) return true;

    // Fallback: strip HTML/Markdown and send plain text without buttons
    const plainText = text.replace(/<[^>]*>/g, "");
    const fallback = await robustFetch(url, {
      timeoutMs: 10000,
      retries: 1,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: plainText }),
      },
    });
    return fallback.ok;
  } catch (e) {
    console.error("Telegram error:", e);
    return false;
  }
}

/** Escape HTML special characters for Telegram */
export function escHTML(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
