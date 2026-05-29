/**
 * ============================================================
 *  DELTA EXCHANGE DEMO AUTO-TRADER  —  strategy.js
 *  Three strategies: Bull | Bear | Neutral
 *  Capital: 99 USD | Risk: 2% per trade | Max daily loss: 5%
 * ============================================================
 */

"use strict";

const axios  = require("axios");
const crypto = require("crypto");
require("dotenv").config();

// ─────────────────────────────────────────────
//  CONFIG  (edit here or via .env)
// ─────────────────────────────────────────────
const CONFIG = {
  API_KEY       : process.env.API_KEY        || "",
  API_SECRET    : process.env.API_SECRET     || "",
  BASE_URL      : process.env.BASE_URL       || "https://cdn-ind.testnet.deltaex.org",
  SYMBOL        : process.env.SYMBOL         || "BTCUSD",
  PRODUCT_ID    : parseInt(process.env.PRODUCT_ID || "27", 10), // BTCUSD perp on testnet

  // ── Capital management ──────────────────────
  ACCOUNT_SIZE  : parseFloat(process.env.ACCOUNT_SIZE  || "99"),   // USD
  RISK_PCT      : parseFloat(process.env.RISK_PCT       || "0.02"), // 2 %
  MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS || "0.05"), // 5 %

  // ── Market condition thresholds ─────────────
  NEUTRAL_BAND  : parseFloat(process.env.NEUTRAL_BAND  || "0.005"), // 0.5 % diff EMA50/EMA200

  // ── RSI params ──────────────────────────────
  RSI_PERIOD    : 14,
  RSI_OVERBOUGHT: 70,
  RSI_OVERSOLD  : 30,

  // ── Candle interval (seconds) ───────────────
  CANDLE_INTERVAL_MS: parseInt(process.env.CANDLE_INTERVAL_MS || "60000", 10), // 1 min

  // ── PAPER TRADING flag ──────────────────────
  //    true  → simulate only, no real API orders
  //    false → place REAL orders on Delta testnet
  PAPER_TRADING : process.env.PAPER_TRADING !== "false", // default TRUE
};

// ─────────────────────────────────────────────
//  RUNTIME STATE
// ─────────────────────────────────────────────
const state = {
  position        : null,   // { side, entryPrice, size, orderId }
  dailyPnL        : 0,
  dailyTradingStopped: false,
  paperBalance    : CONFIG.ACCOUNT_SIZE,
  lastMarketType  : null,
  lastStrategy    : null,
  priceHistory    : [],     // array of close prices
  runCount        : 0,
};

// ─────────────────────────────────────────────
//  LOGGING HELPERS
// ─────────────────────────────────────────────
const ts = () => new Date().toISOString();

const log = {
  info  : (...m) => console.log (`[INFO]  ${ts()}`, ...m),
  entry : (...m) => console.log (`[ENTRY] ${ts()}`, ...m),
  exit  : (...m) => console.log (`[EXIT]  ${ts()}`, ...m),
  risk  : (...m) => console.warn(`[RISK]  ${ts()}`, ...m),
  pnl   : (...m) => console.log (`[P&L]   ${ts()}`, ...m),
  error : (...m) => console.error(`[ERROR] ${ts()}`, ...m),
};

// ─────────────────────────────────────────────
//  SIGNATURE  (matches your working sample)
// ─────────────────────────────────────────────
function generateSignature(method, path, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = method + timestamp + path + body;
  const signature = crypto
    .createHmac("sha256", CONFIG.API_SECRET)
    .update(message)
    .digest("hex");
  return { signature, timestamp };
}

// ─────────────────────────────────────────────
//  DELTA API WRAPPER
// ─────────────────────────────────────────────
async function deltaRequest(method, path, bodyObj = null) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const { signature, timestamp } = generateSignature(method.toUpperCase(), path, body);

  const headers = {
    "api-key"     : CONFIG.API_KEY,
    "signature"   : signature,
    "timestamp"   : timestamp,
    "Content-Type": "application/json",
    "User-Agent"  : "nodejs-strategy",
  };

  const url = CONFIG.BASE_URL + path;
  const cfg = { headers };

  if (method === "GET") {
    const res = await axios.get(url, cfg);
    return res.data;
  } else {
    const res = await axios.post(url, bodyObj, cfg);
    return res.data;
  }
}

// ─────────────────────────────────────────────
//  GET MARKET DATA  (OHLCV candles)
// ─────────────────────────────────────────────
/**
 * Returns array of close prices (newest last).
 * Uses Delta's /v2/history/candles endpoint.
 * Falls back to ticker mid-price if candles unavailable.
 */
async function getMarketData(limit = 210) {
  try {
    const now       = Math.floor(Date.now() / 1000);
    const start     = now - limit * 60;        // limit × 1-min candles
    const path      = `/v2/history/candles?resolution=1m&symbol=${CONFIG.SYMBOL}&start=${start}&end=${now}`;
    const res       = await deltaRequest("GET", path);

    if (res && res.result && Array.isArray(res.result) && res.result.length > 0) {
      // result is [{time, open, high, low, close, volume}, ...]
      const closes = res.result.map(c => parseFloat(c.close));
      return closes;
    }
  } catch (_) { /* fall through */ }

  // ── Fallback: ticker ──────────────────────
  try {
    const path = `/v2/tickers?symbol=${CONFIG.SYMBOL}`;
    const res  = await deltaRequest("GET", path);
    const tick = res?.result?.[0] || res?.result;
    if (tick) {
      const price = parseFloat(tick.mark_price || tick.last_price || tick.close);
      if (!isNaN(price)) {
        // Pad history with current price if we have previous history
        if (state.priceHistory.length >= 10) {
          return [...state.priceHistory.slice(-limit + 1), price];
        }
        return Array(limit).fill(price);
      }
    }
  } catch (e) {
    log.error("getMarketData failed:", e.message);
  }

  return null;
}

// ─────────────────────────────────────────────
//  INDICATORS
// ─────────────────────────────────────────────

/**
 * calculateEMA – standard exponential moving average.
 * @param {number[]} prices  – close prices, oldest→newest
 * @param {number}   period
 * @returns {number[]}       – EMA values same length as prices
 */
function calculateEMA(prices, period) {
  if (prices.length < period) return [];
  const k      = 2 / (period + 1);
  const result = [];
  let   ema    = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...Array(period - 1).fill(null));
  result.push(ema);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

/**
 * calculateRSI – Wilder's RSI.
 * @param {number[]} prices
 * @param {number}   period  default 14
 * @returns {number[]}       RSI values (null for warm-up)
 */
function calculateRSI(prices, period = CONFIG.RSI_PERIOD) {
  if (prices.length < period + 1) return [];
  const result = Array(period).fill(null);

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;

  const rsi0 = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  result.push(rsi0);

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    result.push(rsi);
  }
  return result;
}

// ─────────────────────────────────────────────
//  MARKET CONDITION DETECTOR
// ─────────────────────────────────────────────
/**
 * detectMarketCondition
 * @param {number[]} prices
 * @returns {"bull"|"bear"|"neutral"}
 */
function detectMarketCondition(prices) {
  const ema50  = calculateEMA(prices, 50);
  const ema200 = calculateEMA(prices, 200);

  const last50  = ema50.filter(v => v !== null).pop();
  const last200 = ema200.filter(v => v !== null).pop();

  if (!last50 || !last200) {
    log.info("Not enough data for EMA50/200 — defaulting to neutral");
    return "neutral";
  }

  const diff    = (last50 - last200) / last200; // relative difference
  const neutral = CONFIG.NEUTRAL_BAND;

  if (Math.abs(diff) < neutral) return "neutral";
  return diff > 0 ? "bull" : "bear";
}

// ─────────────────────────────────────────────
//  RISK MANAGER
// ─────────────────────────────────────────────
/**
 * riskManager
 * Returns { allowed: bool, size: number } where size = contracts.
 * For BTCUSD perp 1 contract = 1 USD notional on Delta.
 */
function riskManager(entryPrice) {
  if (state.dailyTradingStopped) {
    log.risk("Daily loss limit hit — trading stopped for today.");
    return { allowed: false, size: 0 };
  }

  const maxDailyLoss = CONFIG.ACCOUNT_SIZE * CONFIG.MAX_DAILY_LOSS;
  if (state.dailyPnL <= -maxDailyLoss) {
    log.risk(`Daily PnL (${state.dailyPnL.toFixed(2)} USD) exceeded max daily loss (${maxDailyLoss.toFixed(2)} USD). Stopping.`);
    state.dailyTradingStopped = true;
    return { allowed: false, size: 0 };
  }

  if (state.position) {
    log.risk("Position already open — no new entry.");
    return { allowed: false, size: 0 };
  }

  const riskAmount = CONFIG.ACCOUNT_SIZE * CONFIG.RISK_PCT;   // 2% = 1.98 USD
  // For inverse perps (BTCUSD): size in contracts ≈ (riskAmt * price) / price = riskAmt
  // We'll use riskAmount as contract count (minimum 1)
  const size = Math.max(1, Math.floor(riskAmount));

  log.risk(`Risk check OK. Risk amount: $${riskAmount.toFixed(2)} → size: ${size} contracts`);
  return { allowed: true, size };
}

// ─────────────────────────────────────────────
//  ORDER PLACEMENT
// ─────────────────────────────────────────────
/**
 * placeOrder – places or simulates a market order.
 * @param {"buy"|"sell"} side
 * @param {number}       size  contracts
 * @param {string}       label for logging
 * @returns {object|null} order response
 */
async function placeOrder(side, size, label = "") {
  if (CONFIG.PAPER_TRADING) {
    const fakeId = `PAPER-${Date.now()}`;
    log.info(`[PAPER] ${label} ${side.toUpperCase()} ${size} contracts of ${CONFIG.SYMBOL}`);
    return { id: fakeId, state: "open", avg_fill_price: state.priceHistory.at(-1) || 0 };
  }

  try {
    const path    = "/v2/orders";
    const bodyObj = {
      product_symbol: CONFIG.SYMBOL,
      size,
      side,
      order_type: "market_order",
    };
    const res = await deltaRequest("POST", path, bodyObj);
    if (res?.result) {
      log.info(`Order placed: ${side} ${size} @ ${res.result.avg_fill_price || "market"} [ID: ${res.result.id}]`);
      return res.result;
    }
    log.error("Unexpected order response:", JSON.stringify(res));
    return null;
  } catch (e) {
    log.error("placeOrder failed:", e.response?.data || e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
//  ENTRY / EXIT HELPERS
// ─────────────────────────────────────────────
async function openPosition(side, size, price, reason) {
  const order = await placeOrder(side, size, reason);
  if (!order) return;
  state.position = { side, entryPrice: price, size, orderId: order.id };
  log.entry(`${side.toUpperCase()} ${size} contracts @ ~$${price.toFixed(2)} | Reason: ${reason}`);
}

async function closePosition(currentPrice, reason) {
  if (!state.position) return;
  const { side, entryPrice, size } = state.position;
  const closeSide = side === "buy" ? "sell" : "buy";

  const order = await placeOrder(closeSide, size, reason);
  if (!order) return;

  // PnL for inverse perp: PnL ≈ size × (1/entryPrice - 1/exitPrice)  [in BTC]
  // Simplified USD PnL for display (approximate):
  const rawPnl = side === "buy"
    ? size * (currentPrice - entryPrice) / entryPrice
    : size * (entryPrice - currentPrice) / entryPrice;

  state.dailyPnL += rawPnl;
  if (CONFIG.PAPER_TRADING) state.paperBalance += rawPnl;

  log.exit(`CLOSE ${closeSide.toUpperCase()} ${size} @ ~$${currentPrice.toFixed(2)} | Reason: ${reason}`);
  log.pnl(`Trade PnL: $${rawPnl.toFixed(4)} USD | Daily PnL: $${state.dailyPnL.toFixed(4)} USD | Balance: ~$${(CONFIG.PAPER_TRADING ? state.paperBalance : CONFIG.ACCOUNT_SIZE + state.dailyPnL).toFixed(2)}`);

  state.position = null;
}

// ─────────────────────────────────────────────
//  STRATEGY 1 — BULL MARKET  (EMA 9 / 21)
// ─────────────────────────────────────────────
async function bullStrategy(prices) {
  const ema9  = calculateEMA(prices, 9);
  const ema21 = calculateEMA(prices, 21);

  const len  = Math.min(ema9.length, ema21.length);
  if (len < 2) return;

  const prev9  = ema9[len - 2],  curr9  = ema9[len - 1];
  const prev21 = ema21[len - 2], curr21 = ema21[len - 1];
  const price  = prices.at(-1);

  if (!prev9 || !prev21 || !curr9 || !curr21) return;

  // Golden cross → BUY
  if (prev9 <= prev21 && curr9 > curr21) {
    if (!state.position) {
      const { allowed, size } = riskManager(price);
      if (allowed) await openPosition("buy", size, price, "Bull EMA9 cross above EMA21");
    }
  }

  // Death cross → EXIT long
  if (prev9 >= prev21 && curr9 < curr21) {
    if (state.position?.side === "buy") {
      await closePosition(price, "Bull EXIT: EMA9 cross below EMA21");
    }
  }
}

// ─────────────────────────────────────────────
//  STRATEGY 2 — BEAR MARKET  (EMA 9 / 21)
// ─────────────────────────────────────────────
async function bearStrategy(prices) {
  const ema9  = calculateEMA(prices, 9);
  const ema21 = calculateEMA(prices, 21);

  const len = Math.min(ema9.length, ema21.length);
  if (len < 2) return;

  const prev9  = ema9[len - 2],  curr9  = ema9[len - 1];
  const prev21 = ema21[len - 2], curr21 = ema21[len - 1];
  const price  = prices.at(-1);

  if (!prev9 || !prev21 || !curr9 || !curr21) return;

  // Death cross → SHORT (sell)
  if (prev9 >= prev21 && curr9 < curr21) {
    if (!state.position) {
      const { allowed, size } = riskManager(price);
      if (allowed) await openPosition("sell", size, price, "Bear EMA9 cross below EMA21");
    }
  }

  // Golden cross → EXIT short
  if (prev9 <= prev21 && curr9 > curr21) {
    if (state.position?.side === "sell") {
      await closePosition(price, "Bear EXIT: EMA9 cross above EMA21");
    }
  }
}

// ─────────────────────────────────────────────
//  STRATEGY 3 — NEUTRAL MARKET  (RSI)
// ─────────────────────────────────────────────
async function neutralStrategy(prices) {
  const rsiArr = calculateRSI(prices);
  if (rsiArr.length < 2) return;

  const prevRSI = rsiArr[rsiArr.length - 2];
  const currRSI = rsiArr[rsiArr.length - 1];
  const price   = prices.at(-1);

  if (prevRSI === null || currRSI === null) return;

  log.info(`RSI: ${currRSI.toFixed(2)}`);

  // RSI crosses below 30 → oversold → BUY
  if (prevRSI >= CONFIG.RSI_OVERSOLD && currRSI < CONFIG.RSI_OVERSOLD) {
    if (!state.position) {
      const { allowed, size } = riskManager(price);
      if (allowed) await openPosition("buy", size, price, "Neutral RSI oversold (<30)");
    }
  }

  // RSI crosses above 70 → overbought → SELL/SHORT
  if (prevRSI <= CONFIG.RSI_OVERBOUGHT && currRSI > CONFIG.RSI_OVERBOUGHT) {
    if (!state.position) {
      const { allowed, size } = riskManager(price);
      if (allowed) await openPosition("sell", size, price, "Neutral RSI overbought (>70)");
    }
  }

  // Exit long when RSI normalises above 50
  if (state.position?.side === "buy" && currRSI > 50) {
    await closePosition(price, "Neutral EXIT: RSI normalised above 50");
  }

  // Exit short when RSI normalises below 50
  if (state.position?.side === "sell" && currRSI < 50) {
    await closePosition(price, "Neutral EXIT: RSI normalised below 50");
  }
}

// ─────────────────────────────────────────────
//  MAIN LOOP TICK
// ─────────────────────────────────────────────
async function tick() {
  state.runCount++;
  log.info(`─── Tick #${state.runCount} ───────────────────────────────────`);

  if (state.dailyTradingStopped) {
    log.risk("Trading halted for today. Will resume tomorrow.");
    return;
  }

  // 1. Fetch prices
  const prices = await getMarketData(210);
  if (!prices || prices.length < 30) {
    log.error("Insufficient price data. Skipping tick.");
    return;
  }

  // Append to rolling history
  state.priceHistory = prices;

  const currentPrice = prices.at(-1);
  log.info(`Current price: $${currentPrice.toFixed(2)}`);

  // 2. Detect market condition
  const marketType = detectMarketCondition(prices);
  if (marketType !== state.lastMarketType) {
    log.info(`Market condition changed: ${state.lastMarketType || "?"} → ${marketType.toUpperCase()}`);
    state.lastMarketType = marketType;

    // If market type switches while we have an open position, close it
    if (state.position) {
      await closePosition(currentPrice, `Market regime change to ${marketType}`);
    }
  }

  log.info(`Market type: ${marketType.toUpperCase()} | Active strategy: ${marketType.toUpperCase()}_STRATEGY | Position: ${state.position ? `${state.position.side.toUpperCase()} ${state.position.size} @ $${state.position.entryPrice.toFixed(2)}` : "NONE"}`);

  // Show running PnL if in position
  if (state.position) {
    const { side, entryPrice, size } = state.position;
    const runningPnl = side === "buy"
      ? size * (currentPrice - entryPrice) / entryPrice
      : size * (entryPrice - currentPrice) / entryPrice;
    log.pnl(`Running PnL: $${runningPnl.toFixed(4)} | Entry: $${entryPrice.toFixed(2)} | Now: $${currentPrice.toFixed(2)}`);
  }

  // 3. Execute the ONE active strategy
  switch (marketType) {
    case "bull":    await bullStrategy(prices);    break;
    case "bear":    await bearStrategy(prices);    break;
    case "neutral": await neutralStrategy(prices); break;
  }
}

// ─────────────────────────────────────────────
//  DAILY RESET  (midnight check)
// ─────────────────────────────────────────────
function scheduleDailyReset() {
  const now      = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - now;

  setTimeout(() => {
    log.info("=== Daily reset: clearing PnL counters ===");
    state.dailyPnL           = 0;
    state.dailyTradingStopped = false;
    scheduleDailyReset();
  }, msUntilMidnight);
}

// ─────────────────────────────────────────────
//  STARTUP BANNER
// ─────────────────────────────────────────────
function printBanner() {
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║   DELTA EXCHANGE AUTO-TRADER  —  strategy.js       ║");
  console.log("╠════════════════════════════════════════════════════╣");
  console.log(`║  Symbol       : ${CONFIG.SYMBOL.padEnd(34)}║`);
  console.log(`║  Account size : $${String(CONFIG.ACCOUNT_SIZE).padEnd(33)}║`);
  console.log(`║  Risk / trade : ${(CONFIG.RISK_PCT * 100).toFixed(1).padEnd(33)}%║`);
  console.log(`║  Max daily loss: ${(CONFIG.MAX_DAILY_LOSS * 100).toFixed(1).padEnd(32)}%║`);
  console.log(`║  Candle interval: ${String(CONFIG.CANDLE_INTERVAL_MS / 1000).padEnd(31)}s║`);
  console.log(`║  PAPER TRADING: ${String(CONFIG.PAPER_TRADING).toUpperCase().padEnd(33)}║`);
  console.log("╚════════════════════════════════════════════════════╝");
  if (CONFIG.PAPER_TRADING) {
    console.log("⚠️  PAPER TRADING MODE — no real orders will be placed");
  } else {
    console.log("🔴 LIVE TRADING MODE — real orders WILL be placed on Delta testnet");
  }
  console.log("");
}

// ─────────────────────────────────────────────
//  MAIN ENTRY POINT
// ─────────────────────────────────────────────
async function main() {
  printBanner();
  scheduleDailyReset();

  // Run first tick immediately, then on interval
  await tick();
  setInterval(tick, CONFIG.CANDLE_INTERVAL_MS);
}

main().catch(e => {
  log.error("Fatal error in main():", e.message);
  process.exit(1);
});
