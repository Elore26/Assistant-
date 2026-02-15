// ============================================
// OREN AGENT SYSTEM - Robust Fetch Utility
// Shared module for reliable HTTP requests
// Timeout + Retry + Rate limiting
// ============================================

export interface FetchOptions {
  /** Timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Number of retries on failure (default: 2) */
  retries?: number;
  /** Delay between retries in ms, doubles each retry (default: 1000) */
  retryDelayMs?: number;
  /** Request init options (method, headers, body, etc.) */
  init?: RequestInit;
}

/**
 * Fetch with timeout using AbortSignal.
 */
function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Sleep helper for retry delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Robust fetch with timeout, retries, and exponential backoff.
 *
 * Usage:
 * ```ts
 * const resp = await robustFetch("https://api.example.com/data", {
 *   timeoutMs: 8000,
 *   retries: 2,
 *   init: { headers: { "Authorization": "Bearer xxx" } },
 * });
 * ```
 */
export async function robustFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const init = opts.init ?? {};

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);

      // Retry on 429 (rate limited) or 5xx server errors
      if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
        const retryAfter = resp.headers.get("Retry-After");
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : retryDelayMs * Math.pow(2, attempt);
        console.warn(`[robustFetch] ${resp.status} on ${url}, retry ${attempt + 1}/${retries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      return resp;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        console.warn(`[robustFetch] Error on ${url}: ${lastError.message}, retry ${attempt + 1}/${retries} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error(`robustFetch failed for ${url}`);
}

/**
 * Robust JSON fetch — fetches URL and parses response as JSON.
 * Returns null on failure instead of throwing.
 */
export async function robustFetchJSON<T = any>(url: string, opts: FetchOptions = {}): Promise<T | null> {
  try {
    const resp = await robustFetch(url, opts);
    if (!resp.ok) {
      console.error(`[robustFetchJSON] HTTP ${resp.status} for ${url}`);
      return null;
    }
    return await resp.json() as T;
  } catch (e) {
    console.error(`[robustFetchJSON] Failed for ${url}:`, e);
    return null;
  }
}

/**
 * Rate-limited batch execution.
 * Runs async tasks with a delay between each to avoid API rate limits.
 */
export async function rateLimitedBatch<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  delayMs: number = 200,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i]));
    if (i < items.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}
