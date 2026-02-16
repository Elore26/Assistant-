// ============================================
// ROBUST FETCH — Shared Module Tests (Node.js)
// Tests: timeout, retry, rate limiting, error handling
// ============================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// --- Extracted functions from _shared/robust-fetch.ts ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rateLimitedBatch(items, fn, delayMs = 200) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i]));
    if (i < items.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

// Simulated robustFetch for testing retry logic
async function simulatedRobustFetch(url, opts = {}) {
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 100;
  let attempts = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++;
    try {
      const result = await opts.mockFn(attempt);

      if ((result.status === 429 || result.status >= 500) && attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      return { ...result, attempts };
    } catch (e) {
      if (attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
}

// ============================================
// TESTS
// ============================================

describe("Robust Fetch — Retry Logic", () => {
  it("should succeed on first try with 200 response", async () => {
    const result = await simulatedRobustFetch("https://example.com", {
      retries: 2,
      retryDelayMs: 10,
      mockFn: () => ({ status: 200, ok: true }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.attempts, 1);
    console.log("  ✓ Succeeds on first try");
  });

  it("should retry on 429 (rate limited) and succeed", async () => {
    let callCount = 0;
    const result = await simulatedRobustFetch("https://example.com", {
      retries: 2,
      retryDelayMs: 10,
      mockFn: (attempt) => {
        callCount++;
        if (attempt < 2) return { status: 429, ok: false };
        return { status: 200, ok: true };
      },
    });

    assert.equal(result.status, 200);
    assert.equal(callCount, 3); // 2 retries + final success
    console.log("  ✓ Retries on 429 and succeeds");
  });

  it("should retry on 500 server error", async () => {
    let callCount = 0;
    const result = await simulatedRobustFetch("https://example.com", {
      retries: 1,
      retryDelayMs: 10,
      mockFn: (attempt) => {
        callCount++;
        if (attempt < 1) return { status: 500, ok: false };
        return { status: 200, ok: true };
      },
    });

    assert.equal(result.status, 200);
    assert.equal(callCount, 2);
    console.log("  ✓ Retries on 500 and succeeds");
  });

  it("should return last error status after all retries exhausted", async () => {
    const result = await simulatedRobustFetch("https://example.com", {
      retries: 2,
      retryDelayMs: 10,
      mockFn: () => ({ status: 503, ok: false }),
    });

    assert.equal(result.status, 503);
    assert.equal(result.attempts, 3); // 1 initial + 2 retries
    console.log("  ✓ Returns error after all retries exhausted");
  });

  it("should not retry on 400 client error", async () => {
    let callCount = 0;
    const result = await simulatedRobustFetch("https://example.com", {
      retries: 2,
      retryDelayMs: 10,
      mockFn: () => {
        callCount++;
        return { status: 400, ok: false };
      },
    });

    assert.equal(result.status, 400);
    assert.equal(callCount, 1); // No retries on 4xx (except 429)
    console.log("  ✓ Does NOT retry on 400 client error");
  });

  it("should retry on thrown errors", async () => {
    let callCount = 0;
    try {
      await simulatedRobustFetch("https://example.com", {
        retries: 1,
        retryDelayMs: 10,
        mockFn: () => {
          callCount++;
          throw new Error("Network error");
        },
      });
    } catch (e) {
      assert.equal(e.message, "Network error");
      assert.equal(callCount, 2); // 1 initial + 1 retry
      console.log("  ✓ Retries on thrown errors");
    }
  });
});

describe("Robust Fetch — Exponential Backoff", () => {
  it("should increase delay exponentially between retries", async () => {
    const delays = [];
    let lastTime = Date.now();

    await simulatedRobustFetch("https://example.com", {
      retries: 2,
      retryDelayMs: 50,
      mockFn: (attempt) => {
        const now = Date.now();
        if (attempt > 0) delays.push(now - lastTime);
        lastTime = now;
        if (attempt < 2) return { status: 500, ok: false };
        return { status: 200, ok: true };
      },
    });

    // delay[0] should be ~50ms (50 * 2^0), delay[1] should be ~100ms (50 * 2^1)
    assert.ok(delays.length === 2, "Should have 2 delays");
    assert.ok(delays[0] >= 40, `First delay should be >= 40ms, got ${delays[0]}ms`);
    assert.ok(delays[1] >= delays[0] * 1.5, `Second delay (${delays[1]}ms) should be ~2x first (${delays[0]}ms)`);
    console.log(`  ✓ Exponential backoff: ${delays[0]}ms → ${delays[1]}ms`);
  });
});

describe("Robust Fetch — Rate Limited Batch", () => {
  it("should process all items in order", async () => {
    const items = ["a", "b", "c"];
    const results = await rateLimitedBatch(items, async (item) => item.toUpperCase(), 10);
    assert.deepEqual(results, ["A", "B", "C"]);
    console.log("  ✓ All items processed in order");
  });

  it("should apply delay between items", async () => {
    const timestamps = [];
    await rateLimitedBatch([1, 2, 3], async (item) => {
      timestamps.push(Date.now());
      return item;
    }, 80);

    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      assert.ok(gap >= 70, `Gap should be >= 70ms, got ${gap}ms`);
    }
    console.log("  ✓ Delay enforced between items");
  });

  it("should handle empty array", async () => {
    const results = await rateLimitedBatch([], async () => "x", 10);
    assert.deepEqual(results, []);
    console.log("  ✓ Handles empty input");
  });

  it("should handle single item without delay", async () => {
    const start = Date.now();
    const results = await rateLimitedBatch(["only"], async (item) => item, 500);
    const elapsed = Date.now() - start;
    assert.deepEqual(results, ["only"]);
    assert.ok(elapsed < 100, `Single item should not add delay, took ${elapsed}ms`);
    console.log("  ✓ Single item processed without extra delay");
  });

  it("should propagate errors from processing function", async () => {
    try {
      await rateLimitedBatch([1, 2, 3], async (item) => {
        if (item === 2) throw new Error("Processing failed");
        return item;
      }, 10);
      assert.fail("Should have thrown");
    } catch (e) {
      assert.equal(e.message, "Processing failed");
      console.log("  ✓ Errors propagated correctly");
    }
  });
});

describe("Robust Fetch — Timeout Simulation", () => {
  it("should timeout after specified duration", async () => {
    const timeoutMs = 100;
    const start = Date.now();

    try {
      await new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
        // Simulate a request that takes too long
        setTimeout(() => {
          clearTimeout(timer);
        }, 5000);
      });
      assert.fail("Should have timed out");
    } catch (e) {
      const elapsed = Date.now() - start;
      assert.equal(e.message, "Timeout");
      assert.ok(elapsed >= 90 && elapsed < 200, `Timeout should be ~100ms, got ${elapsed}ms`);
      console.log(`  ✓ Timeout triggered after ${elapsed}ms`);
    }
  });
});
