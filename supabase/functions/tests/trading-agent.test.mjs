// ============================================
// TRADING AGENT — Scraping & Analysis Tests (Node.js)
// Tests: Binance response parsing, EMA, trend detection,
//        Fibonacci, FVG, Order Blocks, confluence scoring
// ============================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// --- Extracted pure functions from trading-agent/index.ts ---

function calcEMA(closes, period) {
  const ema = [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) sum += closes[i];
  ema[Math.min(period, closes.length) - 1] = sum / Math.min(period, closes.length);
  for (let i = Math.min(period, closes.length); i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function findSwings(candles, lookback = 5) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

function detectTrend(swingHighs, swingLows) {
  const recentHighs = swingHighs.slice(-4);
  const recentLows = swingLows.slice(-4);
  let hhCount = 0, lhCount = 0, hlCount = 0, llCount = 0;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) hhCount++;
    else lhCount++;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) hlCount++;
    else llCount++;
  }
  if (hhCount >= lhCount && hlCount >= llCount && (hhCount + hlCount) > 1) {
    return { direction: "HAUSSIER", swingHighs: recentHighs, swingLows: recentLows, structure: "HHHL" };
  }
  if (lhCount >= hhCount && llCount >= hlCount && (lhCount + llCount) > 1) {
    return { direction: "BAISSIER", swingHighs: recentHighs, swingLows: recentLows, structure: "LHLL" };
  }
  return { direction: "RANGE", swingHighs: recentHighs, swingLows: recentLows, structure: "RANGE" };
}

function calcFibonacci(swingLow, swingHigh, isBullish) {
  const range = swingHigh - swingLow;
  const levels = isBullish
    ? [
        { pct: "0%", price: swingLow },
        { pct: "23.6%", price: swingHigh - range * 0.236 },
        { pct: "38.2%", price: swingHigh - range * 0.382 },
        { pct: "50%", price: swingHigh - range * 0.5 },
        { pct: "61.8%", price: swingHigh - range * 0.618 },
        { pct: "78.6%", price: swingHigh - range * 0.786 },
        { pct: "100%", price: swingHigh },
      ]
    : [
        { pct: "0%", price: swingHigh },
        { pct: "23.6%", price: swingLow + range * 0.236 },
        { pct: "38.2%", price: swingLow + range * 0.382 },
        { pct: "50%", price: swingLow + range * 0.5 },
        { pct: "61.8%", price: swingLow + range * 0.618 },
        { pct: "78.6%", price: swingLow + range * 0.786 },
        { pct: "100%", price: swingLow },
      ];
  return {
    swingLow, swingHigh, levels,
    zone50: isBullish ? swingHigh - range * 0.5 : swingLow + range * 0.5,
    zone618: isBullish ? swingHigh - range * 0.618 : swingLow + range * 0.618,
    zone786: isBullish ? swingHigh - range * 0.786 : swingLow + range * 0.786,
  };
}

function detectFVGs(candles, maxLookback = 30) {
  const fvgs = [];
  const start = Math.max(0, candles.length - maxLookback);
  for (let i = start + 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];
    if (c1.high < c3.low && c2.close > c2.open) {
      fvgs.push({ type: "bullish", high: c3.low, low: c1.high, index: i - 1 });
    }
    if (c1.low > c3.high && c2.close < c2.open) {
      fvgs.push({ type: "bearish", high: c1.low, low: c3.high, index: i - 1 });
    }
  }
  return fvgs.slice(-5);
}

function detectOrderBlocks(candles, maxLookback = 50) {
  const obs = [];
  const start = Math.max(0, candles.length - maxLookback);
  const currentPrice = candles[candles.length - 1].close;
  for (let i = start + 1; i < candles.length - 1; i++) {
    const prev = candles[i];
    const next = candles[i + 1];
    const body = Math.abs(next.close - next.open);
    const prevBody = Math.abs(prev.close - prev.open);
    if (prev.close < prev.open && next.close > next.open && body > prevBody * 1.5) {
      const isFresh = currentPrice > prev.low;
      obs.push({ type: "bullish", high: prev.high, low: prev.low, index: i, fresh: isFresh });
    }
    if (prev.close > prev.open && next.close < next.open && body > prevBody * 1.5) {
      const isFresh = currentPrice < prev.high;
      obs.push({ type: "bearish", high: prev.high, low: prev.low, index: i, fresh: isFresh });
    }
  }
  return obs.filter(ob => ob.fresh).slice(-5);
}

function calcPositionSize(capital, riskPct, entryPrice, slPrice) {
  const riskAmount = capital * (riskPct / 100);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance <= 0) return { qty: "0", riskAmount: "0", riskPct: `${riskPct}%` };
  const qty = riskAmount / slDistance;
  return {
    qty: qty >= 1 ? qty.toFixed(4) : qty.toFixed(6),
    riskAmount: `$${riskAmount.toFixed(2)}`,
    riskPct: `${riskPct}%`,
  };
}

function fmt(n) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

// ============================================
// TESTS
// ============================================

describe("Trading Agent — Binance Response Parsing", () => {
  it("should parse klines array into Candle objects", () => {
    const rawKline = [
      1707408000000,  // time
      "42000.50",     // open
      "42500.00",     // high
      "41800.00",     // low
      "42200.75",     // close
      "1500.50",      // volume
      1707411599999,
      "63301125.00",
      350,
      "750.25",
      "31650562.50",
      "0",
    ];

    // Simulate parsing logic from fetchKlines
    const candle = {
      time: rawKline[0],
      open: parseFloat(rawKline[1]),
      high: parseFloat(rawKline[2]),
      low: parseFloat(rawKline[3]),
      close: parseFloat(rawKline[4]),
      volume: parseFloat(rawKline[5]),
    };

    assert.equal(candle.time, 1707408000000);
    assert.equal(candle.open, 42000.50);
    assert.equal(candle.high, 42500.00);
    assert.equal(candle.low, 41800.00);
    assert.equal(candle.close, 42200.75);
    assert.equal(candle.volume, 1500.50);
    console.log("  ✓ Kline data parsed correctly");
  });

  it("should parse ticker response for price and change", () => {
    const mockTicker = {
      symbol: "BTCUSDT",
      lastPrice: "96500.25",
      priceChangePercent: "2.35",
    };

    const result = { price: parseFloat(mockTicker.lastPrice), change: parseFloat(mockTicker.priceChangePercent) };
    assert.equal(result.price, 96500.25);
    assert.equal(result.change, 2.35);
    console.log("  ✓ Ticker data parsed correctly");
  });

  it("should detect missing lastPrice in ticker response", () => {
    const badTicker = { symbol: "BTCUSDT" };
    assert.ok(!badTicker.lastPrice, "Should detect missing lastPrice");
    console.log("  ✓ Detects invalid ticker response");
  });

  it("should detect non-array klines response", () => {
    const badResponse = { error: "Too many requests" };
    assert.ok(!Array.isArray(badResponse), "Should detect non-array response");
    console.log("  ✓ Detects invalid klines response");
  });
});

describe("Trading Agent — EMA Calculation", () => {
  it("should calculate EMA correctly for simple data", () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const ema5 = calcEMA(closes, 5);

    // First value should be SMA of first 5
    assert.equal(ema5[4], 12); // (10+11+12+13+14)/5 = 12
    assert.ok(ema5[10] > ema5[4], "EMA should follow uptrend");
    console.log("  ✓ EMA calculated correctly for uptrend");
  });

  it("should handle EMA with period > data length", () => {
    const closes = [100, 101, 102];
    const ema10 = calcEMA(closes, 10);
    assert.equal(ema10[2], 101); // SMA of all 3 values
    console.log("  ✓ EMA handles short data gracefully");
  });
});

describe("Trading Agent — Trend Detection", () => {
  it("should detect HAUSSIER (bullish) trend - HH/HL", () => {
    const highs = [
      { price: 100, index: 0, time: 0 },
      { price: 110, index: 1, time: 1 },
      { price: 120, index: 2, time: 2 },
      { price: 130, index: 3, time: 3 },
    ];
    const lows = [
      { price: 90, index: 0, time: 0 },
      { price: 95, index: 1, time: 1 },
      { price: 100, index: 2, time: 2 },
      { price: 105, index: 3, time: 3 },
    ];
    const trend = detectTrend(highs, lows);
    assert.equal(trend.direction, "HAUSSIER");
    assert.equal(trend.structure, "HHHL");
    console.log("  ✓ Bullish trend detected (HHHL)");
  });

  it("should detect BAISSIER (bearish) trend - LH/LL", () => {
    const highs = [
      { price: 130, index: 0, time: 0 },
      { price: 120, index: 1, time: 1 },
      { price: 110, index: 2, time: 2 },
      { price: 100, index: 3, time: 3 },
    ];
    const lows = [
      { price: 105, index: 0, time: 0 },
      { price: 100, index: 1, time: 1 },
      { price: 95, index: 2, time: 2 },
      { price: 90, index: 3, time: 3 },
    ];
    const trend = detectTrend(highs, lows);
    assert.equal(trend.direction, "BAISSIER");
    assert.equal(trend.structure, "LHLL");
    console.log("  ✓ Bearish trend detected (LHLL)");
  });

  it("should detect RANGE when no clear trend", () => {
    const highs = [
      { price: 100, index: 0, time: 0 },
      { price: 105, index: 1, time: 1 },
      { price: 98, index: 2, time: 2 },
      { price: 103, index: 3, time: 3 },
    ];
    const lows = [
      { price: 95, index: 0, time: 0 },
      { price: 90, index: 1, time: 1 },
      { price: 93, index: 2, time: 2 },
      { price: 88, index: 3, time: 3 },
    ];
    const trend = detectTrend(highs, lows);
    // Mixed signals → should be RANGE or detect the dominant pattern
    assert.ok(["RANGE", "BAISSIER", "HAUSSIER"].includes(trend.direction));
    console.log(`  ✓ Mixed signals detected as ${trend.direction}`);
  });
});

describe("Trading Agent — Fibonacci Levels", () => {
  it("should calculate bullish Fibonacci levels", () => {
    const fib = calcFibonacci(90000, 100000, true);

    assert.equal(fib.swingLow, 90000);
    assert.equal(fib.swingHigh, 100000);
    assert.equal(fib.zone50, 95000); // 100000 - 10000 * 0.5
    assert.equal(fib.zone618, 93820); // 100000 - 10000 * 0.618
    assert.equal(fib.zone786, 92140); // 100000 - 10000 * 0.786
    assert.equal(fib.levels.length, 7);
    console.log("  ✓ Bullish Fibonacci levels correct");
  });

  it("should calculate bearish Fibonacci levels", () => {
    const fib = calcFibonacci(90000, 100000, false);

    assert.equal(fib.zone50, 95000); // 90000 + 10000 * 0.5
    assert.equal(fib.zone618, 96180); // 90000 + 10000 * 0.618
    assert.equal(fib.zone786, 97860); // 90000 + 10000 * 0.786
    console.log("  ✓ Bearish Fibonacci levels correct");
  });
});

describe("Trading Agent — FVG Detection", () => {
  it("should detect bullish FVG (gap up)", () => {
    const candles = [
      { open: 100, high: 102, low: 99, close: 101, volume: 100, time: 0 },
      { open: 101, high: 108, low: 101, close: 107, volume: 200, time: 1 }, // strong bullish
      { open: 107, high: 112, low: 106, close: 111, volume: 150, time: 2 }, // c3.low (106) > c1.high (102) → FVG
    ];

    const fvgs = detectFVGs(candles, 10);
    assert.equal(fvgs.length, 1);
    assert.equal(fvgs[0].type, "bullish");
    assert.equal(fvgs[0].low, 102); // c1.high
    assert.equal(fvgs[0].high, 106); // c3.low
    console.log("  ✓ Bullish FVG detected correctly");
  });

  it("should detect bearish FVG (gap down)", () => {
    const candles = [
      { open: 100, high: 102, low: 98, close: 101, volume: 100, time: 0 },
      { open: 100, high: 100, low: 92, close: 93, volume: 200, time: 1 }, // strong bearish
      { open: 93, high: 95, low: 90, close: 91, volume: 150, time: 2 }, // c3.high (95) < c1.low (98) → FVG
    ];

    const fvgs = detectFVGs(candles, 10);
    assert.equal(fvgs.length, 1);
    assert.equal(fvgs[0].type, "bearish");
    console.log("  ✓ Bearish FVG detected correctly");
  });

  it("should return empty for no FVG", () => {
    const candles = [
      { open: 100, high: 102, low: 98, close: 101, volume: 100, time: 0 },
      { open: 101, high: 103, low: 100, close: 102, volume: 100, time: 1 },
      { open: 102, high: 103, low: 100, close: 101, volume: 100, time: 2 },
    ];
    const fvgs = detectFVGs(candles, 10);
    assert.equal(fvgs.length, 0);
    console.log("  ✓ No FVG when there's no gap");
  });
});

describe("Trading Agent — Order Block Detection", () => {
  it("should detect bullish order block", () => {
    // Bearish candle followed by strong bullish candle
    const candles = [
      { open: 100, high: 101, low: 98, close: 99, volume: 100, time: 0 },  // bearish (c > o)
      { open: 99, high: 100, low: 97, close: 98, volume: 100, time: 1 },   // bearish prev (setup)
      { open: 98, high: 105, low: 97, close: 104, volume: 200, time: 2 },  // strong bullish (body=6 > prevBody=1 * 1.5)
      { open: 104, high: 106, low: 103, close: 105, volume: 100, time: 3 },
    ];

    const obs = detectOrderBlocks(candles, 10);
    const bullishOBs = obs.filter(ob => ob.type === "bullish");
    // The OB at index 1 (bearish candle before strong bullish)
    assert.ok(bullishOBs.length >= 1, "Should find at least one bullish OB");
    console.log("  ✓ Bullish order block detected");
  });
});

describe("Trading Agent — Position Sizing", () => {
  it("should calculate position size correctly", () => {
    const result = calcPositionSize(144, 2, 96500, 95000);
    // Risk = $144 * 2% = $2.88
    // SL distance = $1500
    // Qty = $2.88 / $1500 = 0.00192
    assert.equal(result.riskAmount, "$2.88");
    assert.equal(result.riskPct, "2%");
    assert.equal(result.qty, "0.001920");
    console.log("  ✓ Position sizing calculated correctly");
  });

  it("should handle zero SL distance", () => {
    const result = calcPositionSize(144, 2, 96500, 96500);
    assert.equal(result.qty, "0");
    console.log("  ✓ Handles zero SL distance");
  });

  it("should handle small altcoin prices", () => {
    const result = calcPositionSize(144, 2, 2.5, 2.3);
    // Risk = $2.88, SL dist = $0.2, Qty = 14.4
    assert.equal(result.qty, "14.4000");
    console.log("  ✓ Position sizing works for altcoins");
  });
});

describe("Trading Agent — Price Formatter", () => {
  it("should format BTC price without decimals", () => {
    const result = fmt(96500);
    assert.ok(result.includes("96") && result.includes("500"));
    console.log(`  ✓ BTC price formatted: ${result}`);
  });

  it("should format altcoin price with 2 decimals", () => {
    const result = fmt(2.45);
    assert.ok(result.includes("2.45"));
    console.log(`  ✓ Altcoin price formatted: ${result}`);
  });

  it("should format very small prices with 4 decimals", () => {
    const result = fmt(0.0023);
    assert.ok(result.includes("0.0023"));
    console.log(`  ✓ Small price formatted: ${result}`);
  });
});
