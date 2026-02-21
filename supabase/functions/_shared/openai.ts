// ============================================
// OREN AGENT SYSTEM — Shared OpenAI Utilities
// All agents MUST use this instead of local copies
// Uses robustFetch for timeout + retry protection
// ============================================

import { robustFetch } from "./robust-fetch.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface CallOpenAIOptions {
  /** Model to use (default: gpt-4o-mini) */
  model?: string;
  /** Temperature 0-1 (default: 0.7) */
  temperature?: number;
  /** Timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** Number of retries (default: 1) */
  retries?: number;
}

/**
 * Call OpenAI chat completions with timeout and retry.
 * Returns empty string on any failure (never throws).
 */
export async function callOpenAI(
  systemPrompt: string,
  userContent: string,
  maxTokens = 500,
  options?: CallOpenAIOptions,
): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return "";

  try {
    const response = await robustFetch(OPENAI_URL, {
      timeoutMs: options?.timeoutMs ?? 15000,
      retries: options?.retries ?? 1,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options?.model ?? "gpt-4o-mini",
          temperature: options?.temperature ?? 0.7,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      },
    });

    if (!response.ok) return "";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.error("OpenAI error:", e);
    return "";
  }
}
