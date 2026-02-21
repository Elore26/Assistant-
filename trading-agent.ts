// ============================================
// OREN AGENT SYSTEM - Trading Agent V2
// Multi-Timeframe Analysis: 1D → 4H → 30min
// Strategy: Trend Following + Confluence
// Active: Dimanche soir (1D) + Lundi-Mercredi (4H/30min)
// API: Binance Public (no key needed)
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleCalendar, GCAL_COLORS } from "../_shared/google-calendar.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";

// =============================================
// OPENAI INTEGRATION
// =============================================
async function callOpenAI(systemPrompt: string, userContent: string, maxTokens = 600): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return "";
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0.5, max_tokens: maxTokens,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) { console.error("OpenAI error:", e); return ""; }
}

// =============================================
// TYPES
// =============================================
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SwingPoint {
  index: number;
  price: number;
  time: number;
}

interface FVG {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  index: number;
}

interface OrderBlock {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  index: number;
  fresh: boolean;
  quality?: number; // 0-5 star rating
  qualityDetails?: string[];
}

interface FibLevels {
  swingLow: number;
  swingHigh: number;
  levels: { pct: string; price: number }[];
  zone50: number;
  zone618: number;
  zone786: number;
}

interface TrendResult {
  direction: "HAUSSIER" | "BAISSIER" | "RANGE";
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  structure: string; // "HHHL" | "LHLL" | "RANGE"
}

interface ConfluenceResult {
  score: number;
  total: number;
  elements: string[];
  probability: string;
}

interface Confirmation30min {
  confirmed: boolean;
  type: "BREAKOUT" | "RETEST" | "REJECT" | "NONE";
  details: string;
  volumeStrong: boolean;
}

interface WeeklyPlanEntry {
  symbol: string;
  condition: string;
  action: string;
  zone: number;
  type: "BUY_ZONE" | "SELL_ZONE" | "ALERT";
}

interface AnalysisResult {
  symbol: string;
  price: number;
  change24h: number;
  trend1D: TrendResult;
  ema200_1D: number;
  priceVsEma: "AU-DESSUS" | "EN-DESSOUS";
  fib1D: FibLevels | null;
  trend4H: TrendResult;
  ema200_4H: number;
  aligned: boolean;
  fvg4H: FVG[];
  ob4H: OrderBlock[];
  supports: number[];
  resistances: number[];
  context: "RANGE" | "EXPANSION" | "RETRACEMENT" | "RETOURNEMENT";
  confluence: ConfluenceResult;
  signal: SignalResult | null;
  holdReason?: string; // Why signal was rejected (e.g. "R:R < 1:1")
  confirmation30min?: Confirmation30min;
  positionSize?: { qty: string; riskAmount: string; riskPct: string };
  weeklyPlans?: WeeklyPlanEntry[];
}

interface SignalResult {
  type: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  rr: string;
  strategy: string;
  confidence: number;
  tpSource?: string; // Where the TP target comes from
}

// =============================================
// BINANCE API
// =============================================
async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines error: ${res.status}`);
  const data = await res.json();
  return data.map((k: any[]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchPrice(symbol: string): Promise<{ price: number; change: number }> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ticker error: ${res.status}`);
  const data = await res.json();
  return { price: parseFloat(data.lastPrice), change: parseFloat(data.priceChangePercent) };
}

// =============================================
// TECHNICAL ANALYSIS FUNCTIONS
// =============================================

// --- EMA ---
function calcEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  // SMA for first value
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) sum += closes[i];
  ema[Math.min(period, closes.length) - 1] = sum / Math.min(period, closes.length);
  // EMA
  for (let i = Math.min(period, closes.length); i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// --- Swing Highs/Lows ---
function findSwings(candles: Candle[], lookback: number = 5): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];

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

// --- Trend Detection ---
function detectTrend(swingHighs: SwingPoint[], swingLows: SwingPoint[]): TrendResult {
  const recentHighs = swingHighs.slice(-4);
  const recentLows = swingLows.slice(-4);

  let hhCount = 0;
  let lhCount = 0;
  let hlCount = 0;
  let llCount = 0;

  // Check highs: Higher Highs or Lower Highs
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) hhCount++;
    else lhCount++;
  }

  // Check lows: Higher Lows or Lower Lows
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) hlCount++;
    else llCount++;
  }

  // HHHL = Bullish (Higher Highs, Higher Lows)
  if (hhCount >= lhCount && hlCount >= llCount && (hhCount + hlCount) > 1) {
    return { direction: "HAUSSIER", swingHighs: recentHighs, swingLows: recentLows, structure: "HHHL" };
  }
  // LHLL = Bearish (Lower Highs, Lower Lows)
  if (lhCount >= hhCount && llCount >= hlCount && (lhCount + llCount) > 1) {
    return { direction: "BAISSIER", swingHighs: recentHighs, swingLows: recentLows, structure: "LHLL" };
  }

  return { direction: "RANGE", swingHighs: recentHighs, swingLows: recentLows, structure: "RANGE" };
}

// --- Fibonacci Retracement ---
function calcFibonacci(swingLow: number, swingHigh: number, isBullish: boolean): FibLevels {
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
    swingLow,
    swingHigh,
    levels,
    zone50: isBullish ? swingHigh - range * 0.5 : swingLow + range * 0.5,
    zone618: isBullish ? swingHigh - range * 0.618 : swingLow + range * 0.618,
    zone786: isBullish ? swingHigh - range * 0.786 : swingLow + range * 0.786,
  };
}

// --- Fair Value Gap (FVG) Detection ---
function detectFVGs(candles: Candle[], maxLookback: number = 30): FVG[] {
  const fvgs: FVG[] = [];
  const start = Math.max(0, candles.length - maxLookback);

  for (let i = start + 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // Bullish FVG: candle1.high < candle3.low (gap up)
    if (c1.high < c3.low && c2.close > c2.open) {
      fvgs.push({ type: "bullish", high: c3.low, low: c1.high, index: i - 1 });
    }
    // Bearish FVG: candle1.low > candle3.high (gap down)
    if (c1.low > c3.high && c2.close < c2.open) {
      fvgs.push({ type: "bearish", high: c1.low, low: c3.high, index: i - 1 });
    }
  }

  return fvgs.slice(-5); // Last 5 FVGs
}

// --- Order Block Detection ---
function detectOrderBlocks(candles: Candle[], maxLookback: number = 50): OrderBlock[] {
  const obs: OrderBlock[] = [];
  const start = Math.max(0, candles.length - maxLookback);
  const currentPrice = candles[candles.length - 1].close;

  for (let i = start + 1; i < candles.length - 1; i++) {
    const prev = candles[i];
    const next = candles[i + 1];
    const body = Math.abs(next.close - next.open);
    const prevBody = Math.abs(prev.close - prev.open);

    // Bullish OB: bearish candle followed by strong bullish candle
    if (prev.close < prev.open && next.close > next.open && body > prevBody * 1.5) {
      const isFresh = currentPrice > prev.low; // Price hasn't returned below
      obs.push({ type: "bullish", high: prev.high, low: prev.low, index: i, fresh: isFresh });
    }

    // Bearish OB: bullish candle followed by strong bearish candle
    if (prev.close > prev.open && next.close < next.open && body > prevBody * 1.5) {
      const isFresh = currentPrice < prev.high;
      obs.push({ type: "bearish", high: prev.high, low: prev.low, index: i, fresh: isFresh });
    }
  }

  // Return only fresh OBs, most recent first
  return obs.filter(ob => ob.fresh).slice(-5);
}

// --- Support & Resistance ---
function findSupportResistance(candles: Candle[], tolerance: number = 0.005): { supports: number[]; resistances: number[] } {
  const price = candles[candles.length - 1].close;
  const levels: { price: number; touches: number }[] = [];

  // Cluster swing points
  const { highs, lows } = findSwings(candles, 3);
  const allPoints = [...highs.map(h => h.price), ...lows.map(l => l.price)];

  for (const p of allPoints) {
    const existing = levels.find(l => Math.abs(l.price - p) / p < tolerance);
    if (existing) {
      existing.touches++;
      existing.price = (existing.price + p) / 2; // Average
    } else {
      levels.push({ price: p, touches: 1 });
    }
  }

  // Filter: minimum 2 touches
  const strong = levels.filter(l => l.touches >= 2).sort((a, b) => a.price - b.price);

  const supports = strong.filter(l => l.price < price).map(l => l.price).slice(-3);
  const resistances = strong.filter(l => l.price > price).map(l => l.price).slice(0, 3);

  return { supports, resistances };
}

// --- Market Context ---
function detectContext(candles: Candle[], trend: TrendResult): "RANGE" | "EXPANSION" | "RETRACEMENT" | "RETOURNEMENT" {
  const recent = candles.slice(-10);
  const avgVolume = candles.slice(-50, -10).reduce((s, c) => s + c.volume, 0) / 40;
  const recentVolume = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const recentRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
  const olderRange = candles.slice(-30, -10).reduce((s, c) => s + (c.high - c.low), 0) / 20;

  // Check for expansion: big candles + high volume
  if (recentVolume > avgVolume * 1.5 && recentRange > olderRange * 1.5) {
    return "EXPANSION";
  }

  // Check for retracement: price pulling back against trend
  if (trend.direction !== "RANGE") {
    const lastCandles = candles.slice(-5);
    const trendUp = trend.direction === "HAUSSIER";
    const pullback = trendUp
      ? lastCandles.every((c, i) => i === 0 || c.close <= lastCandles[i - 1].close)
      : lastCandles.every((c, i) => i === 0 || c.close >= lastCandles[i - 1].close);
    if (pullback) return "RETRACEMENT";
  }

  // Check for reversal: new structure breaking old
  if (trend.swingHighs.length >= 3 && trend.swingLows.length >= 3) {
    const sh = trend.swingHighs;
    const sl = trend.swingLows;
    const lastSH = sh[sh.length - 1];
    const prevSH = sh[sh.length - 2];
    const lastSL = sl[sl.length - 1];
    const prevSL = sl[sl.length - 2];

    // Was bullish but last high is lower AND last low is lower
    if (lastSH.price < prevSH.price && lastSL.price < prevSL.price && trend.direction === "HAUSSIER") {
      return "RETOURNEMENT";
    }
    // Was bearish but last high is higher AND last low is higher
    if (lastSH.price > prevSH.price && lastSL.price > prevSL.price && trend.direction === "BAISSIER") {
      return "RETOURNEMENT";
    }
  }

  return "RANGE";
}

// --- 30min Confirmation (Execution Timeframe) ---
function analyze30min(candles30m: Candle[], trend4H: TrendResult, supports: number[], resistances: number[], bias1D?: string): Confirmation30min {
  if (candles30m.length < 20) return { confirmed: false, type: "NONE", details: "Pas assez de donnees 30min", volumeStrong: false };

  const recent = candles30m.slice(-15);
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const price = last.close;

  // Use 1D bias as primary direction reference (not just 4H)
  const bias = bias1D || trend4H.direction;
  const isBiasLong = bias === "HAUSSIER";

  // Volume check: compare last 3 candles avg vs previous 10
  const recentVol = recent.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const olderVol = recent.slice(0, 10).reduce((s, c) => s + c.volume, 0) / 10;
  const volumeStrong = recentVol > olderVol * 1.3;

  // Detect local 30min range (last 10 candles high/low)
  const localHigh = Math.max(...recent.slice(-10).map(c => c.high));
  const localLow = Math.min(...recent.slice(-10).map(c => c.low));
  const rangeSize = localHigh - localLow;
  const tolerance = rangeSize * 0.15;

  // Detect what's actually happening on 30min (direction-agnostic)
  const breakUpward = last.close > localHigh - tolerance && last.close > last.open && volumeStrong;
  const breakDownward = last.close < localLow + tolerance && last.close < last.open && volumeStrong;

  // 1. BREAKOUT WITH the bias → confirmed entry
  if (isBiasLong && breakUpward) {
    return { confirmed: true, type: "BREAKOUT", details: `Cassure haussiere $${fmt(localHigh)} AVEC le bias LONG ✓ vol OK`, volumeStrong };
  }
  if (!isBiasLong && breakDownward) {
    return { confirmed: true, type: "BREAKOUT", details: `Cassure baissiere $${fmt(localLow)} AVEC le bias SHORT ✓ vol OK`, volumeStrong };
  }

  // 1b. BREAKOUT AGAINST the bias → warning, NOT confirmed
  if (isBiasLong && breakDownward) {
    return { confirmed: false, type: "BREAKOUT", details: `⚠️ Cassure baissiere $${fmt(localLow)} CONTRE le bias LONG — attendre retour`, volumeStrong };
  }
  if (!isBiasLong && breakUpward) {
    return { confirmed: false, type: "BREAKOUT", details: `⚠️ Cassure haussiere $${fmt(localHigh)} CONTRE le bias SHORT — attendre retour`, volumeStrong };
  }

  // 2. BREAK-RETEST: price broke level, came back, rejected
  const nearestSupport = supports.find(s => Math.abs(price - s) / price < 0.01);
  const nearestResistance = resistances.find(r => Math.abs(price - r) / price < 0.01);

  if (isBiasLong && nearestSupport) {
    const wicked = prev.low < nearestSupport * 1.002 && last.close > nearestSupport * 1.003;
    if (wicked && last.close > last.open) {
      return { confirmed: true, type: "RETEST", details: `Break-Retest support $${fmt(nearestSupport)} + rejet haussier ✓`, volumeStrong };
    }
  }
  if (!isBiasLong && nearestResistance) {
    const wicked = prev.high > nearestResistance * 0.998 && last.close < nearestResistance * 0.997;
    if (wicked && last.close < last.open) {
      return { confirmed: true, type: "RETEST", details: `Break-Retest resistance $${fmt(nearestResistance)} + rejet baissier ✓`, volumeStrong };
    }
  }

  // 3. REJECT: strong rejection candle (long wick, small body)
  const bodySize = Math.abs(last.close - last.open);
  const totalSize = last.high - last.low;
  if (totalSize > 0 && bodySize / totalSize < 0.3) {
    if (isBiasLong && (last.close > last.open) && (last.low < prev.low)) {
      return { confirmed: true, type: "REJECT", details: `Rejet haussier 30min (longue meche basse) ✓`, volumeStrong };
    }
    if (!isBiasLong && (last.close < last.open) && (last.high > prev.high)) {
      return { confirmed: true, type: "REJECT", details: `Rejet baissier 30min (longue meche haute) ✓`, volumeStrong };
    }
    // Reject AGAINST the bias
    if (isBiasLong && (last.close < last.open) && (last.high > prev.high)) {
      return { confirmed: false, type: "REJECT", details: `⚠️ Pression vendeuse 30min CONTRE le bias LONG`, volumeStrong };
    }
    if (!isBiasLong && (last.close > last.open) && (last.low < prev.low)) {
      return { confirmed: false, type: "REJECT", details: `⚠️ Pression acheteuse 30min CONTRE le bias SHORT`, volumeStrong };
    }
  }

  return { confirmed: false, type: "NONE", details: "Pas de confirmation 30min — ATTENDRE", volumeStrong };
}

// --- OB 5-Star Quality Filter ---
function scoreOBQuality(
  ob: OrderBlock,
  trend: TrendResult,
  fvgs: FVG[],
  fib: FibLevels | null,
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[],
  price: number
): { score: number; details: string[] } {
  const details: string[] = [];
  let score = 0;

  // 1. Has nearby FVG (imbalance)?
  const hasNearbyFVG = fvgs.some(f => {
    if (ob.type === "bullish" && f.type === "bullish") {
      return Math.abs(f.low - ob.high) / price < 0.01 || (f.low >= ob.low && f.high <= ob.high * 1.02);
    }
    if (ob.type === "bearish" && f.type === "bearish") {
      return Math.abs(f.high - ob.low) / price < 0.01 || (f.high <= ob.high && f.low >= ob.low * 0.98);
    }
    return false;
  });
  if (hasNearbyFVG) { score++; details.push("FVG associe"); }
  else { details.push("Sans FVG"); }

  // 2. Aligned with trend?
  const trendAligned = (ob.type === "bullish" && trend.direction === "HAUSSIER") ||
                       (ob.type === "bearish" && trend.direction === "BAISSIER");
  if (trendAligned) { score++; details.push("Avec tendance"); }
  else { details.push("Contre tendance"); }

  // 3. Fresh (never mitigated)?
  if (ob.fresh) { score++; details.push("Frais"); }
  else { details.push("Deja mitigue"); }

  // 4. Position vs Fibonacci 50% (discount for longs, premium for shorts)?
  if (fib) {
    const obMid = (ob.high + ob.low) / 2;
    if (ob.type === "bullish" && obMid < fib.zone50) { score++; details.push("Zone DISCOUNT"); }
    else if (ob.type === "bearish" && obMid > fib.zone50) { score++; details.push("Zone PREMIUM"); }
    else { details.push("Mauvaise zone Fib"); }
  }

  // 5. Away from liquidity (equal highs/lows)?
  const equalHighs = swingHighs.filter((sh, i) =>
    i > 0 && Math.abs(sh.price - swingHighs[i - 1].price) / price < 0.003
  );
  const equalLows = swingLows.filter((sl, i) =>
    i > 0 && Math.abs(sl.price - swingLows[i - 1].price) / price < 0.003
  );
  const nearEqualHigh = equalHighs.some(eh => Math.abs(eh.price - ob.high) / price < 0.01);
  const nearEqualLow = equalLows.some(el => Math.abs(el.price - ob.low) / price < 0.01);
  if (!nearEqualHigh && !nearEqualLow) { score++; details.push("Loin liquidite"); }
  else { details.push("Pres liquidite"); }

  return { score, details };
}

// --- Position Sizing Calculator ---
function calcPositionSize(
  capital: number,
  riskPct: number,
  entryPrice: number,
  slPrice: number
): { qty: string; riskAmount: string; riskPct: string } {
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

// --- Break-Retest Detection on 30min ---
function detectBreakRetest(candles30m: Candle[], supports: number[], resistances: number[], isBullish: boolean): {
  detected: boolean;
  level: number;
  entry: number;
  sl: number;
  tp: number;
  rr: string;
} | null {
  if (candles30m.length < 20) return null;

  const recent = candles30m.slice(-20);
  const price = recent[recent.length - 1].close;
  const levels = isBullish ? supports : resistances;

  for (const level of levels) {
    // Check if price broke this level in the last 10 candles then came back
    const brokeAbove = recent.slice(-15, -5).some(c => c.close > level * 1.002);
    const brokeBelow = recent.slice(-15, -5).some(c => c.close < level * 0.998);
    const retested = recent.slice(-5).some(c => Math.abs(c.low - level) / price < 0.005 || Math.abs(c.high - level) / price < 0.005);

    if (isBullish && brokeAbove && retested) {
      const last = recent[recent.length - 1];
      if (last.close > level && last.close > last.open) {
        // Confirmed break-retest long
        const entry = last.close;
        const sl = level * 0.997; // SL just below retested level
        const tp = resistances.length > 0 ? resistances[0] : entry * 1.03;
        const risk = entry - sl;
        const reward = tp - entry;
        const rr = risk > 0 ? (reward / risk).toFixed(1) : "0";
        if (risk > 0 && reward / risk >= 1) {
          return { detected: true, level, entry, sl, tp, rr: `1:${rr}` };
        }
      }
    }

    if (!isBullish && brokeBelow && retested) {
      const last = recent[recent.length - 1];
      if (last.close < level && last.close < last.open) {
        const entry = last.close;
        const sl = level * 1.003;
        const tp = supports.length > 0 ? supports[supports.length - 1] : entry * 0.97;
        const risk = sl - entry;
        const reward = entry - tp;
        const rr = risk > 0 ? (reward / risk).toFixed(1) : "0";
        if (risk > 0 && reward / risk >= 1) {
          return { detected: true, level, entry, sl, tp, rr: `1:${rr}` };
        }
      }
    }
  }

  return null;
}

// --- Weekly Plan Generator ---
function generateWeeklyPlans(
  a: { symbol: string; price: number; trend1D: TrendResult; fib1D: FibLevels | null; ob4H: OrderBlock[]; supports: number[]; resistances: number[]; priceVsEma: string }
): WeeklyPlanEntry[] {
  const plans: WeeklyPlanEntry[] = [];
  const isBullish = a.trend1D.direction === "HAUSSIER";

  // Plan 1: Fibonacci retracement zone
  if (a.fib1D && isBullish) {
    plans.push({
      symbol: a.symbol, zone: a.fib1D.zone618, type: "BUY_ZONE",
      condition: `Si prix retrace a $${fmt(a.fib1D.zone618)} (Fib 61.8%)`,
      action: "Chercher confluence + achat",
    });
  } else if (a.fib1D && !isBullish) {
    plans.push({
      symbol: a.symbol, zone: a.fib1D.zone618, type: "SELL_ZONE",
      condition: `Si prix remonte a $${fmt(a.fib1D.zone618)} (Fib 61.8%)`,
      action: "Chercher confluence + vente",
    });
  }

  // Plan 2: Best OB zone
  const bestOB = a.ob4H.filter(ob =>
    (isBullish && ob.type === "bullish") || (!isBullish && ob.type === "bearish")
  ).sort((x, y) => (y.quality || 0) - (x.quality || 0))[0];
  if (bestOB) {
    plans.push({
      symbol: a.symbol, zone: (bestOB.high + bestOB.low) / 2, type: isBullish ? "BUY_ZONE" : "SELL_ZONE",
      condition: `Si prix atteint OB ${bestOB.type} $${fmt(bestOB.low)}-$${fmt(bestOB.high)} (${bestOB.quality || "?"}★)`,
      action: `${isBullish ? "Achat" : "Vente"} au rejet de l'OB`,
    });
  }

  // Plan 3: Key support/resistance break alert
  if (isBullish && a.supports.length > 0) {
    const keySup = a.supports[a.supports.length - 1];
    plans.push({
      symbol: a.symbol, zone: keySup, type: "ALERT",
      condition: `Si prix casse $${fmt(keySup)} (support cle)`,
      action: "ALERTE retournement — fermer positions",
    });
  } else if (!isBullish && a.resistances.length > 0) {
    const keyRes = a.resistances[0];
    plans.push({
      symbol: a.symbol, zone: keyRes, type: "ALERT",
      condition: `Si prix depasse $${fmt(keyRes)} (resistance cle)`,
      action: "ALERTE retournement — reconsiderer biais",
    });
  }

  return plans;
}

// --- Confluence Scoring ---
function scoreConfluence(
  price: number,
  trend1D: TrendResult,
  trend4H: TrendResult,
  ema200Above: boolean,
  fib: FibLevels | null,
  fvgs: FVG[],
  obs: OrderBlock[],
  supports: number[],
  resistances: number[]
): ConfluenceResult {
  const elements: string[] = [];
  const isBullish = trend1D.direction === "HAUSSIER";
  const tolerance = price * 0.02; // 2% zone

  // 1. Trend alignment 1D + 4H
  if (trend1D.direction === trend4H.direction && trend1D.direction !== "RANGE") {
    elements.push(`Tendance alignee 1D/4H: ${trend1D.direction}`);
  }

  // 2. EMA 200 filter
  if ((isBullish && ema200Above) || (!isBullish && !ema200Above)) {
    elements.push(`EMA 200 confirme le biais`);
  }

  // 3. Fibonacci zone
  if (fib) {
    if (isBullish && price >= fib.zone618 - tolerance && price <= fib.zone50 + tolerance) {
      elements.push(`Prix en Zone d'Or Fibo (50-61.8%)`);
    } else if (!isBullish && price <= fib.zone618 + tolerance && price >= fib.zone50 - tolerance) {
      elements.push(`Prix en Zone d'Or Fibo (50-61.8%)`);
    }
  }

  // 4. Support/Resistance nearby
  const nearSupport = supports.find(s => Math.abs(price - s) / price < 0.015);
  const nearResistance = resistances.find(r => Math.abs(price - r) / price < 0.015);
  if (nearSupport && isBullish) elements.push(`Support proche: $${fmt(nearSupport)}`);
  if (nearResistance && !isBullish) elements.push(`Resistance proche: $${fmt(nearResistance)}`);

  // 5. Order Block nearby
  const nearOB = obs.find(ob => {
    if (isBullish && ob.type === "bullish") return price >= ob.low - tolerance && price <= ob.high + tolerance;
    if (!isBullish && ob.type === "bearish") return price >= ob.low - tolerance && price <= ob.high + tolerance;
    return false;
  });
  if (nearOB) elements.push(`Order Block ${nearOB.type}: $${fmt(nearOB.low)}-$${fmt(nearOB.high)}`);

  // 6. FVG nearby
  const nearFVG = fvgs.find(f => {
    if (isBullish && f.type === "bullish") return price >= f.low - tolerance && price <= f.high + tolerance;
    if (!isBullish && f.type === "bearish") return price >= f.low - tolerance && price <= f.high + tolerance;
    return false;
  });
  if (nearFVG) elements.push(`FVG ${nearFVG.type}: $${fmt(nearFVG.low)}-$${fmt(nearFVG.high)}`);

  // 7. Premium/Discount zone (Fib 0.5)
  if (fib) {
    if (isBullish && price < fib.zone50) {
      elements.push(`Zone DISCOUNT (sous 0.5 Fibo)`);
    } else if (!isBullish && price > fib.zone50) {
      elements.push(`Zone PREMIUM (au-dessus 0.5 Fibo)`);
    }
  }

  const score = elements.length;
  const total = 7;
  let probability = "~30%";
  if (score >= 4) probability = "~85%+";
  else if (score >= 3) probability = "~70%";
  else if (score >= 2) probability = "~50%";

  return { score, total, elements, probability };
}

// --- Signal Generation ---
function generateSignal(
  price: number,
  trend1D: TrendResult,
  trend4H: TrendResult,
  fib: FibLevels | null,
  context: string,
  confluence: ConfluenceResult,
  supports: number[],
  resistances: number[],
  ob4H?: OrderBlock[],
  priceVsEma?: string
): SignalResult | null {
  // Need minimum 3 confluence elements to signal
  if (confluence.score < 3) return null;

  // 1D must have a clear direction
  if (trend1D.direction === "RANGE") return null;

  const isBullish = trend1D.direction === "HAUSSIER";

  // --- ALIGNMENT RULES (relaxed per PDF methodology) ---
  // Strict: 1D and 4H aligned → full confidence signal
  // Relaxed: 4H is RANGE + high confluence (>=4) + 1D has direction → signal with reduced confidence
  // Relaxed: 4H opposite but context is RETRACEMENT/RETOURNEMENT + confluence >= 4 → cautious signal
  let confidenceBonus = 0;
  let strategy = context === "RETRACEMENT" ? "Fibonacci Retracement" : "Breakout";

  if (trend1D.direction === trend4H.direction) {
    // Perfect alignment
    confidenceBonus = 10;
    strategy = context === "RETRACEMENT" ? "Fibonacci Retracement" : context === "EXPANSION" ? "Expansion" : "Breakout";
  } else if (trend4H.direction === "RANGE") {
    // 4H is ranging while 1D trends — OK if high confluence
    // PDF says: in RANGE, trade bounces on S/R
    if (confluence.score < 4) return null; // Need higher confluence when 4H not aligned
    confidenceBonus = 0;
    strategy = "Range Bounce (1D bias)";
  } else {
    // 4H opposes 1D — only trade if RETOURNEMENT context + very high confluence
    if (confluence.score < 5) return null;
    if (context !== "RETOURNEMENT" && context !== "RETRACEMENT") return null;
    confidenceBonus = -10;
    strategy = context === "RETOURNEMENT" ? "Retournement" : "Retracement profond";
  }

  // Check for nearby quality OB (5★ or 4★) near current price
  let hasQualityOBNearby = false;
  if (ob4H) {
    hasQualityOBNearby = ob4H.some(ob => {
      if ((ob.quality || 0) < 4) return false;
      const obMid = (ob.high + ob.low) / 2;
      const dist = Math.abs(price - obMid) / price;
      if (isBullish && ob.type === "bullish" && dist < 0.02) return true;
      if (!isBullish && ob.type === "bearish" && dist < 0.02) return true;
      return false;
    });
  }
  // Boost confidence if on a quality OB
  if (hasQualityOBNearby) confidenceBonus += 5;

  // EMA alignment bonus
  const emaAligned = (isBullish && priceVsEma === "AU-DESSUS") || (!isBullish && priceVsEma === "EN-DESSOUS");
  if (emaAligned) confidenceBonus += 5;

  if (isBullish) {
    // BUY signal
    const entry = price;
    // SL: below last swing low or Fib 78.6%
    const slFromSwing = trend4H.swingLows.length > 0 ? trend4H.swingLows[trend4H.swingLows.length - 1].price * 0.998 : 0;
    const slFromFib = fib ? fib.zone786 * 0.998 : 0;
    const sl = Math.max(slFromSwing, slFromFib) || entry * 0.97;
    const risk = entry - sl;

    // TP: progressive search — try multiple targets until R:R >= 1:1
    // Tagged candidates: [price, source label]
    const tpCandidates: Array<[number, string]> = [];
    // All resistances above entry
    for (const r of resistances) {
      if (r > entry) tpCandidates.push([r, "Resistance"]);
    }
    // All 4H swing highs above entry
    for (const sh of trend4H.swingHighs) {
      if (sh.price > entry) tpCandidates.push([sh.price, "Swing High 4H"]);
    }
    // 1D swing highs (farther targets)
    if (trend1D && trend1D.swingHighs) {
      for (const sh of trend1D.swingHighs) {
        if (sh.price > entry) tpCandidates.push([sh.price, "Swing High 1D"]);
      }
    }
    // OB bear zones above price (potential rejection = TP)
    if (ob4H) {
      for (const ob of ob4H) {
        if (ob.type === "bearish" && ob.low > entry) {
          tpCandidates.push([ob.low, "OB Bear zone"]);
        }
      }
    }
    // Fib extensions as fallback
    if (fib) {
      const fibRange = Math.abs(fib.zone0 - fib.zone100);
      const fib1618 = fib.zone0 + fibRange * 1.618;
      if (fib1618 > entry) tpCandidates.push([fib1618, "Fib 1.618"]);
    }
    // Percentage fallbacks
    tpCandidates.push([entry * 1.03, "+3%"]);
    tpCandidates.push([entry * 1.05, "+5%"]);

    // Sort ascending by price and pick the first one that gives R:R >= 1:1
    tpCandidates.sort((a, b) => a[0] - b[0]);
    let tp = entry * 1.05; // ultimate fallback
    let tpSource = "+5% fallback";
    for (const [candidate, source] of tpCandidates) {
      if (candidate <= entry) continue;
      const reward = candidate - entry;
      if (risk > 0 && reward / risk >= 1) {
        tp = candidate;
        tpSource = source;
        break;
      }
    }

    const reward = tp - entry;
    const rr = risk > 0 ? (reward / risk).toFixed(1) : "N/A";

    // After trying ALL candidates, if still no R:R >= 1:1, reject
    if (risk > 0 && reward / risk < 1) return null;

    return {
      type: "BUY",
      entry, sl, tp,
      rr: `1:${rr}`,
      strategy,
      confidence: Math.min(95, Math.max(30, 45 + confluence.score * 8 + confidenceBonus)),
      tpSource,
    };
  } else {
    // SELL signal
    const entry = price;
    const slFromSwing = trend4H.swingHighs.length > 0 ? trend4H.swingHighs[trend4H.swingHighs.length - 1].price * 1.002 : 0;
    const slFromFib = fib ? fib.zone786 * 1.002 : 0;
    const sl = slFromSwing > 0 && slFromFib > 0 ? Math.min(slFromSwing, slFromFib) : (slFromSwing || slFromFib || entry * 1.03);
    const risk = sl - entry;

    // TP: progressive search — try multiple targets until R:R >= 1:1
    const tpCandidates: Array<[number, string]> = [];
    // All supports below entry
    for (const s of supports) {
      if (s < entry) tpCandidates.push([s, "Support"]);
    }
    // All 4H swing lows below entry
    for (const slo of trend4H.swingLows) {
      if (slo.price < entry) tpCandidates.push([slo.price, "Swing Low 4H"]);
    }
    // 1D swing lows (farther targets)
    if (trend1D && trend1D.swingLows) {
      for (const slo of trend1D.swingLows) {
        if (slo.price < entry) tpCandidates.push([slo.price, "Swing Low 1D"]);
      }
    }
    // OB bull zones below price (potential bounce = TP)
    if (ob4H) {
      for (const ob of ob4H) {
        if (ob.type === "bullish" && ob.high < entry) {
          tpCandidates.push([ob.high, "OB Bull zone"]);
        }
      }
    }
    // Fib extensions as fallback
    if (fib) {
      const fibRange = Math.abs(fib.zone0 - fib.zone100);
      const fib1618 = fib.zone100 - fibRange * 0.618;
      if (fib1618 < entry && fib1618 > 0) tpCandidates.push([fib1618, "Fib 0.618"]);
    }
    // Percentage fallbacks
    tpCandidates.push([entry * 0.97, "-3%"]);
    tpCandidates.push([entry * 0.95, "-5%"]);

    // Sort descending by price and pick the first one that gives R:R >= 1:1
    tpCandidates.sort((a, b) => b[0] - a[0]);
    let tp = entry * 0.95; // ultimate fallback
    let tpSource = "-5% fallback";
    for (const [candidate, source] of tpCandidates) {
      if (candidate >= entry) continue;
      const reward = entry - candidate;
      if (risk > 0 && reward / risk >= 1) {
        tp = candidate;
        tpSource = source;
        break;
      }
    }

    const reward = entry - tp;
    const rr = risk > 0 ? (reward / risk).toFixed(1) : "N/A";

    if (risk > 0 && reward / risk < 1) return null;

    return {
      type: "SELL",
      entry, sl, tp,
      rr: `1:${rr}`,
      strategy,
      confidence: Math.min(95, Math.max(30, 45 + confluence.score * 8 + confidenceBonus)),
      tpSource,
    };
  }
}

// =============================================
// FULL ANALYSIS
// =============================================
// Trading capital config
const TRADING_CAPITAL = parseFloat(Deno.env.get("TRADING_CAPITAL") || "144");
const RISK_PCT = parseFloat(Deno.env.get("TRADING_RISK_PCT") || "2");

async function analyzeAsset(symbol: string): Promise<AnalysisResult> {
  // Fetch data — now includes 30min
  const [klines1D, klines4H, klines30m, ticker] = await Promise.all([
    fetchKlines(symbol, "1d", 200),
    fetchKlines(symbol, "4h", 200),
    fetchKlines(symbol, "30m", 100),
    fetchPrice(symbol),
  ]);

  const price = ticker.price;
  const change24h = ticker.change;

  // --- 1D Analysis ---
  const closes1D = klines1D.map(c => c.close);
  const ema200_1D_arr = calcEMA(closes1D, 200);
  const ema200_1D = ema200_1D_arr[ema200_1D_arr.length - 1] || 0;
  const priceVsEma: "AU-DESSUS" | "EN-DESSOUS" = price > ema200_1D ? "AU-DESSUS" : "EN-DESSOUS";

  const swings1D = findSwings(klines1D, 5);
  const trend1D = detectTrend(swings1D.highs, swings1D.lows);

  // Fibonacci from last significant swing
  let fib1D: FibLevels | null = null;
  if (trend1D.swingLows.length > 0 && trend1D.swingHighs.length > 0) {
    const lastLow = trend1D.swingLows[trend1D.swingLows.length - 1].price;
    const lastHigh = trend1D.swingHighs[trend1D.swingHighs.length - 1].price;
    if (lastHigh > lastLow) {
      fib1D = calcFibonacci(lastLow, lastHigh, trend1D.direction === "HAUSSIER");
    }
  }

  // --- 4H Analysis ---
  const closes4H = klines4H.map(c => c.close);
  const ema200_4H_arr = calcEMA(closes4H, 200);
  const ema200_4H = ema200_4H_arr[ema200_4H_arr.length - 1] || 0;

  const swings4H = findSwings(klines4H, 3);
  const trend4H = detectTrend(swings4H.highs, swings4H.lows);

  const aligned = trend1D.direction === trend4H.direction && trend1D.direction !== "RANGE";

  // Zones 4H
  const fvg4H = detectFVGs(klines4H, 30);
  const ob4H = detectOrderBlocks(klines4H, 50);
  const { supports, resistances } = findSupportResistance(klines4H);

  // Context
  const context = detectContext(klines4H, trend4H);

  // Confluence
  const confluence = scoreConfluence(
    price, trend1D, trend4H, price > ema200_1D,
    fib1D, fvg4H, ob4H, supports, resistances
  );

  // --- OB 5-Star Quality Scoring ---
  for (const ob of ob4H) {
    const { score: obScore, details: obDetails } = scoreOBQuality(
      ob, trend1D, fvg4H, fib1D,
      swings4H.highs, swings4H.lows, price
    );
    ob.quality = obScore;
    ob.qualityDetails = obDetails;
  }

  // Signal
  let signal = generateSignal(price, trend1D, trend4H, fib1D, context, confluence, supports, resistances, ob4H, priceVsEma);

  // Detect if signal was likely rejected due to R:R (good confluence but no signal)
  let holdReason: string | undefined;
  if (!signal && confluence.score >= 3) {
    // Signal would have been generated but R:R or alignment blocked it
    const aligned4H = trend1D.direction === trend4H.direction;
    const rangeOK = trend4H.direction === "RANGE" && confluence.score >= 4;
    const retournementOK = trend1D.direction !== trend4H.direction && (context === "RETOURNEMENT" || context === "RETRACEMENT") && confluence.score >= 5;
    if (aligned4H || rangeOK || retournementOK) {
      holdReason = "R:R < 1:1 — TP trop proche du SL";
    }
  }

  // --- 30min Confirmation (pass 1D bias for WITH/AGAINST detection) ---
  const confirmation30min = analyze30min(klines30m, trend4H, supports, resistances, trend1D.direction);

  // --- Break-Retest detection on 30min ---
  if (!signal && confluence.score >= 2 && aligned) {
    const breakRetest = detectBreakRetest(klines30m, supports, resistances, trend1D.direction === "HAUSSIER");
    if (breakRetest) {
      signal = {
        type: trend1D.direction === "HAUSSIER" ? "BUY" : "SELL",
        entry: breakRetest.entry,
        sl: breakRetest.sl,
        tp: breakRetest.tp,
        rr: breakRetest.rr,
        strategy: "Break-Retest",
        confidence: Math.min(90, 45 + confluence.score * 10),
      };
    }
  }

  // --- Position Sizing ---
  let positionSize: { qty: string; riskAmount: string; riskPct: string } | undefined;
  if (signal) {
    positionSize = calcPositionSize(TRADING_CAPITAL, RISK_PCT, signal.entry, signal.sl);
  }

  // --- Weekly Plans ---
  const weeklyPlans = generateWeeklyPlans({
    symbol: symbol.replace("USDT", ""), price, trend1D, fib1D,
    ob4H, supports, resistances, priceVsEma,
  });

  return {
    symbol: symbol.replace("USDT", ""),
    price, change24h,
    trend1D, ema200_1D, priceVsEma, fib1D,
    trend4H, ema200_4H, aligned,
    fvg4H, ob4H,
    supports, resistances,
    context, confluence, signal, holdReason,
    confirmation30min, positionSize, weeklyPlans,
  };
}

// =============================================
// MESSAGE FORMATTING
// =============================================
const LINE = "━━━━━━━━━━━━━━━━━━━━";

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatWeeklyAnalysis(a: AnalysisResult): string {
  const trendSymbol = a.trend1D.direction === "HAUSSIER" ? "▲" : a.trend1D.direction === "BAISSIER" ? "▼" : "↔";
  const emaStatus = a.priceVsEma === "AU-DESSUS" ? "au-dessus" : "en-dessous";
  const alignStatus = a.aligned ? "✓ Aligne" : "Non aligne";

  let msg = `<b>${a.symbol}</b>  $${fmt(a.price)}  ${a.change24h >= 0 ? "+" : ""}${a.change24h.toFixed(1)}%\n`;
  msg += `${LINE}\n`;
  msg += `1D  ${a.trend1D.structure} ${trendSymbol}  |  EMA 200 ${emaStatus}\n`;

  if (a.trend1D.swingHighs.length > 0 && a.trend1D.swingLows.length > 0) {
    const sh = a.trend1D.swingHighs[a.trend1D.swingHighs.length - 1].price;
    const sl = a.trend1D.swingLows[a.trend1D.swingLows.length - 1].price;
    msg += `SH $${fmt(sh)}  ·  SL $${fmt(sl)}\n`;
  }

  if (a.fib1D) {
    msg += `Fibonacci  50% $${fmt(a.fib1D.zone50)}  ·  61.8% $${fmt(a.fib1D.zone618)}  ·  78.6% $${fmt(a.fib1D.zone786)}\n`;
  }

  msg += `4H  ${a.trend4H.structure} ${alignStatus}  |  Contexte ${a.context}\n`;

  return msg;
}

function formatTradingAnalysis(a: AnalysisResult): string {
  const alignCheck = a.aligned ? "✓" : "";
  const emaStatus = a.priceVsEma === "AU-DESSUS" ? "au-dessus" : "en-dessous";

  // --- BIAS DIRECTION: LONG or SHORT ---
  let biasDirection = "NEUTRE";
  let biasIcon = "↔";
  let biasReason = "";
  if (a.trend1D.direction === "HAUSSIER" && a.priceVsEma === "AU-DESSUS") {
    biasDirection = "LONG"; biasIcon = "🟢"; biasReason = "1D HHHL + EMA au-dessus";
  } else if (a.trend1D.direction === "BAISSIER" && a.priceVsEma === "EN-DESSOUS") {
    biasDirection = "SHORT"; biasIcon = "🔴"; biasReason = "1D LHLL + EMA en-dessous";
  } else if (a.trend1D.direction === "HAUSSIER" && a.priceVsEma === "EN-DESSOUS") {
    biasDirection = "LONG (prudent)"; biasIcon = "🟡";
    biasReason = a.context === "RETOURNEMENT" ? "Retournement possible" : "1D HHHL mais EMA en-dessous";
  } else if (a.trend1D.direction === "BAISSIER" && a.priceVsEma === "AU-DESSUS") {
    biasDirection = "SHORT (prudent)"; biasIcon = "🟡";
    biasReason = a.context === "RETOURNEMENT" ? "Retournement possible" : "1D LHLL mais EMA au-dessus";
  } else {
    biasReason = "Range — attendre cassure";
  }

  let msg = `<b>${a.symbol}</b>  $${fmt(a.price)}\n`;
  msg += `${LINE}\n`;

  // Bias line
  msg += `${biasIcon} <b>BIAS: ${biasDirection}</b>\n`;
  msg += `${biasReason}\n\n`;

  msg += `1D ${a.trend1D.structure}  ·  4H ${a.trend4H.structure} ${alignCheck}\n`;
  msg += `EMA ${emaStatus}  ·  ${a.context}\n`;

  // Order Blocks with quality stars + 5 criteria details
  const bestOBs = a.ob4H.filter(ob => (ob.quality || 0) >= 3).slice(-2);
  const displayOBs = bestOBs.length > 0 ? bestOBs : (a.ob4H.length > 0 ? [a.ob4H[a.ob4H.length - 1]] : []);
  for (const ob of displayOBs) {
    const stars = "★".repeat(ob.quality || 0) + "☆".repeat(5 - (ob.quality || 0));
    msg += `OB ${ob.type === "bullish" ? "Bull" : "Bear"} $${fmt(ob.low)}-$${fmt(ob.high)} ${stars}\n`;
    // Show 5-star criteria details (each detail already indicates pass/fail)
    if (ob.qualityDetails && ob.qualityDetails.length > 0) {
      const passLabels = ["FVG associe", "Avec tendance", "Frais", "Zone DISCOUNT", "Zone PREMIUM", "Loin liquidite"];
      const checks = ob.qualityDetails.map(d => {
        const passed = passLabels.some(p => d === p);
        return `${passed ? "✓" : "✗"}${d}`;
      });
      msg += `  <i>${checks.join(" · ")}</i>\n`;
    }
  }

  if (a.supports.length > 0) msg += `Support $${fmt(a.supports[a.supports.length - 1])}`;
  if (a.resistances.length > 0) msg += `  ·  Resistance $${fmt(a.resistances[0])}`;
  if (a.supports.length > 0 || a.resistances.length > 0) msg += `\n`;

  // Confluence score
  msg += `Confluence  <b>${a.confluence.score}/7</b> → ${a.confluence.probability}\n`;
  a.confluence.elements.slice(0, 5).forEach(e => {
    msg += `  ✓ ${e}\n`;
  });

  // 30min Confirmation
  if (a.confirmation30min) {
    const c = a.confirmation30min;
    if (c.confirmed) {
      msg += `\n30min  ✅ ${c.details}\n`;
    } else if (c.type === "BREAKOUT" || c.type === "REJECT") {
      // Breakout or rejection AGAINST the bias
      msg += `\n30min  ${c.details}\n`;
    } else {
      msg += `\n30min  ⏳ ${c.details}\n`;
    }
  }

  // Signal with LONG/SHORT direction
  if (a.signal) {
    const isLong = a.signal.type === "BUY";
    const signalLabel = isLong ? "🟢 LONG" : "🔴 SHORT";
    msg += `\n<b>${signalLabel}  $${fmt(a.signal.entry)}</b>\n`;
    msg += `  SL $${fmt(a.signal.sl)}  ·  TP $${fmt(a.signal.tp)}${a.signal.tpSource ? ` (${a.signal.tpSource})` : ""}\n`;
    msg += `  R:R ${a.signal.rr}  ·  ${a.signal.strategy}  ·  ${a.signal.confidence}%\n`;
    // 30min warning if not confirmed
    if (a.confirmation30min && !a.confirmation30min.confirmed) {
      msg += `  ⚠️ ATTENDRE confirmation 30min\n`;
    }

    // Position Sizing
    if (a.positionSize) {
      msg += `  📐 Taille: ${a.positionSize.qty} ${a.symbol} · Risque: ${a.positionSize.riskAmount} (${a.positionSize.riskPct})\n`;
    }
  } else {
    // No signal — show why and what to watch
    msg += `\n⏸ <b>HOLD — Pas de signal</b>\n`;
    if (a.holdReason) {
      msg += `  ↳ ${a.holdReason}\n`;
    }
    if (!a.aligned) {
      msg += `  ↳ 1D/4H non alignes (1D ${a.trend1D.structure} vs 4H ${a.trend4H.structure})\n`;
    }
    if (a.confluence.score < 3) {
      msg += `  ↳ Confluence insuffisante (${a.confluence.score}/7, min 3)\n`;
    }
    if (a.confirmation30min && !a.confirmation30min.confirmed) {
      msg += `  ↳ Pas de confirmation 30min\n`;
    }
    msg += `  Patience = discipline\n`;
  }

  return msg;
}

// =============================================
// TELEGRAM
// =============================================
async function sendTG(text: string): Promise<boolean> {
  if (!BOT_TOKEN) return false;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const plain = text.replace(/<[^>]+>/g, "");
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: plain }),
    });
  }
  return res.ok;
}

// =============================================
// MAIN
// =============================================
serve(async (req: Request) => {
  // Parse optional body params for testing & config
  let forceMode: string | null = null; // "weekly" | "trading" | null
  let customPairs: string[] | null = null;
  try {
    const b = await req.json();
    if (b.force_mode) forceMode = b.force_mode; // "weekly" or "trading"
    if (Array.isArray(b.pairs)) customPairs = b.pairs; // e.g. ["BTCUSDT", "XRPUSDT"]
  } catch (_) {}

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const day = now.getDay();
  const hour = now.getHours();

  console.log(`[Trading Agent V2] Day=${day} Hour=${hour} force=${forceMode}`);

  // SCHEDULE:
  // Analyses: Dimanche soir → Vendredi (cloture CME) = every day except Saturday
  // Signaux BUY/SELL: uniquement Lundi-Mercredi
  // Jeudi/Vendredi: analyse sans signaux (observation)
  let isSundayEvening = day === 0 && hour >= 18;
  let isAnalysisDay = day >= 1 && day <= 5; // Lundi-Vendredi
  let isTradingDay = day >= 1 && day <= 3;  // Lundi-Mercredi (signaux actifs)

  // force_mode overrides day check for testing
  if (forceMode === "weekly") { isSundayEvening = true; isAnalysisDay = false; }
  if (forceMode === "trading") { isSundayEvening = false; isAnalysisDay = true; isTradingDay = true; }
  if (forceMode === "analysis") { isSundayEvening = false; isAnalysisDay = true; isTradingDay = false; }

  // Saturday = OFF
  if (!isSundayEvening && !isAnalysisDay) {
    return new Response(JSON.stringify({
      success: true,
      message: `Off day (${["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"][day]}). Analyses Dim soir → Ven.`,
    }), { headers: { "Content-Type": "application/json" } });
  }

  try {
    // Load pairs: custom > DB config > default
    let PAIRS = customPairs || null;
    if (!PAIRS) {
      try {
        const supabaseCfg = createClient(SUPABASE_URL, SUPABASE_KEY);
        // Try trading_signals with symbol="CONFIG"
        const { data: cfgData } = await supabaseCfg.from("trading_signals")
          .select("notes").eq("symbol", "CONFIG").order("created_at", { ascending: false }).limit(1);
        if (cfgData && cfgData.length > 0) {
          const cfg = JSON.parse(cfgData[0].notes || "{}");
          if (Array.isArray(cfg.pairs) && cfg.pairs.length > 0) PAIRS = cfg.pairs;
        }
        // Fallback: check tasks table for TRADING_CONFIG
        if (!PAIRS) {
          const { data: taskData } = await supabaseCfg.from("tasks")
            .select("title").like("title", "TRADING_CONFIG:%")
            .order("created_at", { ascending: false }).limit(1);
          if (taskData && taskData.length > 0) {
            const pairsJson = taskData[0].title.replace("TRADING_CONFIG:", "");
            const parsed = JSON.parse(pairsJson);
            if (Array.isArray(parsed) && parsed.length > 0) PAIRS = parsed;
          }
        }
      } catch (e) { console.error("Config load error:", e); }
    }
    if (!PAIRS) PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    console.log(`[Trading Agent V2] Pairs: ${PAIRS.join(", ")}`);
    const analyses: AnalysisResult[] = [];

    for (const pair of PAIRS) {
      try {
        const analysis = await analyzeAsset(pair);
        analyses.push(analysis);
      } catch (e) {
        console.error(`Error analyzing ${pair}:`, e);
      }
    }

    if (analyses.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "No analyses completed" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }

    // Build and send message
    let fullMsg = "";

    if (isSundayEvening) {
      // WEEKLY 1D ANALYSIS
      fullMsg = `ANALYSE HEBDO\n`;
      fullMsg += `Biais Lundi → Mercredi\n`;
      fullMsg += `${LINE}\n\n`;
      for (const a of analyses) {
        fullMsg += formatWeeklyAnalysis(a) + "\n";
      }
      fullMsg += `\nRESUME\n`;
      const biases = analyses.map(a => {
        const bias = a.trend1D.direction === "HAUSSIER" && a.priceVsEma === "AU-DESSUS"
          ? `${a.symbol} ▲ Haussier`
          : a.trend1D.direction === "BAISSIER" && a.priceVsEma === "EN-DESSOUS"
            ? `${a.symbol} ▼ Baissier`
            : a.trend1D.direction === "RANGE"
              ? `${a.symbol} ↔ Range`
              : `${a.symbol} ⚠`;
        return bias;
      });
      fullMsg += biases.join("  ·  ") + "\n";
      fullMsg += `Chercher setups alignes avec le biais 1D`;

      // --- WEEKLY PLAN ---
      const allPlans = analyses.flatMap(a => a.weeklyPlans || []);
      if (allPlans.length > 0) {
        fullMsg += `\n\n📋 <b>PLAN SEMAINE</b>\n`;
        fullMsg += `ATTENDRE → PAS D'ACTION DIMANCHE\n`;
        for (const p of allPlans) {
          const icon = p.type === "BUY_ZONE" ? "🟢" : p.type === "SELL_ZONE" ? "🔴" : "⚠️";
          fullMsg += `${icon} ${p.symbol}: ${p.condition}\n   → ${p.action}\n`;
        }
      }

      // Save plans to DB
      try {
        const supabasePlan = createClient(SUPABASE_URL, SUPABASE_KEY);
        const todayStr = new Date().toISOString().split("T")[0];
        await supabasePlan.from("trading_signals").insert({
          symbol: "PLAN",
          signal_type: "HOLD",
          confidence: 0,
          notes: JSON.stringify({ type: "weekly_plan", plans: allPlans }),
          created_at: new Date().toISOString(),
        });
      } catch (e) { console.error("Save weekly plan error:", e); }

    } else {
      // ANALYSIS DAY - 4H ANALYSIS
      const dayNames = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
      const dayLabel = forceMode ? "TEST" : dayNames[day];
      const isObservation = !isTradingDay; // Jeudi/Vendredi = observation only

      // Strip signals on non-trading days (Jeudi/Vendredi)
      if (isObservation) {
        for (const a of analyses) { a.signal = null; }
      }

      if (isObservation) {
        fullMsg = `OBSERVATION — ${dayLabel} ${hour}h\n`;
        fullMsg += `Pas de prise de position\n`;
        fullMsg += `${LINE}\n\n`;
      } else {
        fullMsg = `ANALYSE — ${dayLabel} ${hour}h\n`;
        fullMsg += `${LINE}\n\n`;
      }

      for (const a of analyses) {
        fullMsg += formatTradingAnalysis(a) + "\n";
      }

      // --- Check Weekly Plan Alerts ---
      try {
        const supabasePlan = createClient(SUPABASE_URL, SUPABASE_KEY);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: savedPlans } = await supabasePlan.from("trading_signals")
          .select("notes").eq("symbol", "PLAN").gte("created_at", weekAgo)
          .order("created_at", { ascending: false }).limit(1);

        if (savedPlans && savedPlans.length > 0) {
          const planData = JSON.parse(savedPlans[0].notes || "{}");
          const plans: WeeklyPlanEntry[] = planData.plans || [];
          const triggered: string[] = [];

          for (const plan of plans) {
            const matchingAnalysis = analyses.find(a => a.symbol === plan.symbol);
            if (!matchingAnalysis) continue;
            const dist = Math.abs(matchingAnalysis.price - plan.zone) / plan.zone;
            if (dist < 0.02) { // Within 2% of plan zone
              triggered.push(`🔔 ${plan.symbol} pres de $${fmt(plan.zone)} — ${plan.action}`);
            }
          }

          if (triggered.length > 0) {
            fullMsg += `\n📋 <b>PLAN ALERTS</b>\n`;
            triggered.forEach(t => { fullMsg += `${t}\n`; });
          }
        }
      } catch (e) { console.error("Plan check error:", e); }

      // --- AI Market Narrative ---
      try {
        const analysisContext = analyses.map(a => {
          const trendBias = a.trend1D.direction === "HAUSSIER" ? "Haussier" : a.trend1D.direction === "BAISSIER" ? "Baissier" : "Range";
          const emaPos = a.priceVsEma === "AU-DESSUS" ? "au-dessus" : "en-dessous";
          const alignText = a.aligned ? "alignees" : "non-alignees";
          const confText = `${a.confluence.score}/7 (${a.confluence.probability})`;
          const signal = a.signal ? `${a.signal.type} @ $${fmt(a.signal.entry)} SL:$${fmt(a.signal.sl)} TP:$${fmt(a.signal.tp)} RR:${a.signal.rr}` : "HOLD";

          // Include REAL price data and key levels
          const obBullish = a.ob4H.filter(o => o.type === "bullish").map(o => `$${fmt(o.low)}-$${fmt(o.high)}`).join(", ") || "aucun";
          const obBearish = a.ob4H.filter(o => o.type === "bearish").map(o => `$${fmt(o.low)}-$${fmt(o.high)}`).join(", ") || "aucun";
          const fvgBull = a.fvg4H.filter(f => f.type === "bullish").map(f => `$${fmt(f.low)}-$${fmt(f.high)}`).join(", ") || "aucun";
          const fvgBear = a.fvg4H.filter(f => f.type === "bearish").map(f => `$${fmt(f.low)}-$${fmt(f.high)}`).join(", ") || "aucun";
          const supports = a.supports.slice(0, 3).map(s => `$${fmt(s)}`).join(", ") || "N/A";
          const resistances = a.resistances.slice(0, 3).map(r => `$${fmt(r)}`).join(", ") || "N/A";
          const fibInfo = a.fib1D ? `Fib 0.5=$${fmt(a.fib1D.zone50)}, 0.618=$${fmt(a.fib1D.zone618)}, 0.786=$${fmt(a.fib1D.zone786)}` : "N/A";

          return `${a.symbol}: PRIX ACTUEL $${fmt(a.price)} (${a.change24h > 0 ? "+" : ""}${a.change24h.toFixed(1)}% 24h), EMA200 1D $${fmt(a.ema200_1D)} (${emaPos}), EMA200 4H $${fmt(a.ema200_4H)}, Tendance 1D ${trendBias}, 4H ${alignText}, Context ${a.context}, Confluence ${confText}, Signal ${signal}, OB Bullish [${obBullish}], OB Bearish [${obBearish}], FVG Bullish [${fvgBull}], FVG Bearish [${fvgBear}], Supports [${supports}], Resistances [${resistances}], ${fibInfo}`;
        }).join("\n\n");

        const narrative = await callOpenAI(
          `Tu es un analyste crypto expert ICT/SMC. Voici les données RÉELLES du marché avec les VRAIS prix.

RÈGLES CRITIQUES:
- Utilise UNIQUEMENT les prix et niveaux fournis dans les données ci-dessous
- NE JAMAIS inventer de prix ou de niveaux — cite les chiffres exacts des données
- Les supports/résistances/OB/FVG sont des zones RÉELLES calculées par l'algo

Génère un narratif de marché en français (max 8 lignes):
🌍 Structure globale du marché (risk-on/risk-off) basée sur les tendances réelles
🔑 Niveaux clés à surveiller AUJOURD'HUI — cite les vrais prix, OB et FVG des données
⚠️ Risques concrets à considérer
📈 Recommandation claire: OBSERVER, ACHETER, VENDRE, ou ATTENDRE + justification

Style: direct, chiffres précis, pas de généralités. Emojis autorisés.`,
          analysisContext
        );
        if (narrative) {
          fullMsg += `\n\n🧠 <b>AI MARKET INSIGHT</b>\n${narrative}`;
        }
      } catch (e) { console.error("AI trading error:", e); }

      // Count active signals (only on trading days)
      if (isTradingDay) {
        const activeSignals = analyses.filter(a => a.signal);
        if (activeSignals.length > 0) {
          fullMsg += `\n${activeSignals.length} signal(s) actif(s)`;
        } else {
          fullMsg += `\nPas de signal — Patience = discipline`;
        }
      }
    }

    // --- P&L Stats + Win Rate (from historical signals) ---
    try {
      const supabaseCheck = createClient(SUPABASE_URL, SUPABASE_KEY);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentSignals } = await supabaseCheck.from("trading_signals")
        .select("signal_type, confidence, notes, created_at")
        .gte("created_at", weekAgo).neq("signal_type", "HOLD");

      if (recentSignals && recentSignals.length > 0) {
        const totalSignals = recentSignals.length;
        const highConf = recentSignals.filter((s: any) => (s.confidence || 0) >= 50).length;
        const buySignals = recentSignals.filter((s: any) => s.signal_type === "BUY").length;
        const sellSignals = recentSignals.filter((s: any) => s.signal_type === "SELL").length;

        fullMsg += `\n\n📊 <b>STATS 7J</b>`;
        fullMsg += `\nSignaux: ${totalSignals} (${buySignals} BUY · ${sellSignals} SELL)`;
        fullMsg += `\nHaute confiance (≥5/7): ${highConf}/${totalSignals} (${Math.round((highConf / totalSignals) * 100)}%)`;
      }

      // Auto-update trading goal
      const { data: tradingGoal } = await supabaseCheck.from("goals").select("id")
        .eq("domain", "trading").eq("status", "active").limit(1);
      if (tradingGoal && tradingGoal.length > 0) {
        // For now, track total signals generated as progress indicator
        const { count } = await supabaseCheck.from("trading_signals")
          .select("id", { count: "exact", head: true }).neq("signal_type", "HOLD");
        if (count !== null) {
          // Goal is capital growth $144→$500, so we track as best we can
          // User will manually update actual portfolio value
        }
      }
    } catch (e) { console.error("Stats error:", e); }

    await sendTG(fullMsg);

    // =============================================
    // GOOGLE CALENDAR SYNC — Trading Signals + Weekly Plans
    // =============================================
    try {
      const gcal = getGoogleCalendar();
      if (gcal.isConfigured()) {
        // Sync active signals as calendar events (4h blocks)
        for (const a of analyses) {
          if (a.signal) {
            await gcal.createTradingAlert(
              a.symbol,
              a.signal.type === "BUY" ? "LONG" : "SHORT",
              a.signal.entry,
              a.signal.sl,
              a.signal.tp,
              a.signal.rr,
              a.signal.confidence,
              a.signal.tpSource
            );
          }
        }

        // On Sunday (weekly analysis) → sync weekly plans as all-week reminders
        if (isSundayEvening) {
          const allPlans = analyses.flatMap(a => a.weeklyPlans || []);
          const now = new Date();
          // Create events for Mon-Wed (trading days)
          for (let d = 1; d <= 3; d++) {
            const planDate = new Date(now);
            planDate.setDate(now.getDate() + d);
            const dateStr = planDate.toISOString().split("T")[0];

            for (const plan of allPlans) {
              const icon = plan.type === "BUY_ZONE" ? "🟢" : plan.type === "SELL_ZONE" ? "🔴" : "⚠️";
              await gcal.createTaskEvent(
                `[OREN] ${icon} ${plan.symbol}: ${plan.action}`,
                dateStr,
                "08:00",
                30, // 30min reminder block
                `Condition: ${plan.condition}\nAction: ${plan.action}\nZone: $${plan.zone}`,
                GCAL_COLORS.TRADING
              );
            }
          }
        }
        console.log("📅 Trading signals synced to Google Calendar");
      }
    } catch (e) { console.error("GCal trading sync error:", e); }

    // Save to DB (with deduplication — skip symbols already analyzed today)
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const todayDate = new Date().toISOString().split("T")[0];
    const { data: existingSignals } = await supabase.from("trading_signals")
      .select("symbol").gte("created_at", todayDate + "T00:00:00")
      .not("symbol", "in", "(PLAN,CONFIG)");
    const alreadySaved = new Set((existingSignals || []).map((s: any) => s.symbol));

    for (const a of analyses) {
      if (alreadySaved.has(a.symbol)) {
        console.log(`[Trading] ${a.symbol} already saved today, skipping`);
        continue;
      }
      await supabase.from("trading_signals").insert({
        symbol: a.symbol,
        signal_type: a.signal?.type || "HOLD",
        confidence: a.signal?.confidence || a.confluence.score * 10,
        notes: JSON.stringify({
          trend1D: a.trend1D.structure,
          trend4H: a.trend4H.structure,
          context: a.context,
          confluence: a.confluence.score,
          ema200: a.priceVsEma,
          signal: a.signal,
        }),
        created_at: new Date().toISOString(),
      });
    }

    return new Response(JSON.stringify({
      success: true,
      type: isSundayEvening ? "weekly_analysis" : "trading_analysis",
      analyses: analyses.map(a => ({
        symbol: a.symbol,
        price: a.price,
        trend1D: a.trend1D.structure,
        trend4H: a.trend4H.structure,
        context: a.context,
        confluence: a.confluence.score,
        signal: a.signal?.type || "HOLD",
      })),
    }), { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Fatal error:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
