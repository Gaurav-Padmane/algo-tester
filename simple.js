/**
 * ============================================================================
 *  DELTA EXCHANGE AUTO-TRADER  —  strategy.js
 *  Senior Quantitative Trend-Following Bot with Advanced Risk Management
 *  Indicators : EMA 20 | EMA 50 | EMA 200 | ATR 14 | ADX 14 | VWAP | Vol Filter
 *  Risk Rules : 1% Risk/Trade | Max 3% Daily Loss | Max 3 Consecutive Losses
 * ============================================================================
 */

import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

// FIX-P1-2: Global axios timeout — prevents tick lock from hanging API calls indefinitely
axios.defaults.timeout = 8000;

// ────────────────────────────────────────────────────────────────────────────
//  CONFIGURABLE STATE & SETTINGS
// ────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
    API_KEY: process.env.API_KEY || "",
    API_SECRET: process.env.API_SECRET || "",
    BASE_URL: process.env.BASE_URL || "https://cdn-ind.testnet.deltaex.org",
    SYMBOL: process.env.SYMBOL || "BTCUSD",
    PRODUCT_ID: parseInt(process.env.PRODUCT_ID || "27", 10), // Will verify via products spec

    // Capital & Sizing
    ACCOUNT_SIZE: parseFloat(process.env.ACCOUNT_SIZE || "99.00"), // USD
    RISK_PCT: parseFloat(process.env.RISK_PCT || "0.01"),          // 1% Risk per trade
    MAX_DAILY_LOSS_PCT: parseFloat(process.env.MAX_DAILY_LOSS_PCT || "0.03"), // 3% Max Daily Loss
    MAX_CONSEC_LOSSES: 3,
    MAX_CONTRACTS: parseInt(process.env.MAX_CONTRACTS || "100", 10), // Max contracts position cap (Requirement 7)
    FORCE_CLOSE_ALL: process.env.FORCE_CLOSE_ALL === "true", // Emergency stop-trading kill switch (Requirement 6)

    // Volatility Filtering
    MIN_ATR_PCT: 0.001,   // 0.1% volatility requirement (Task 3)
    ROUNDTRIP_FEE_RATE: 0.0016, // Includes maker/taker slippage, bid-ask spreads, and fee buffers (Task 2)

    // Resolution: Preferred 15m or 1h (defaults to 15m)
    RESOLUTION: process.env.RESOLUTION || "15m",
    CANDLE_INTERVAL_MS: 900000, // Calculated dynamically

    // Execution Mode
    PAPER_TRADING: process.env.PAPER_TRADING !== "false" // Default to true for demo protection
};

// Map resolution to seconds
export const RESOLUTION_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "1d": 86400
};

// Dynamic mapping computation
const updateIntervalFromResolution = () => {
    const sec = RESOLUTION_SECONDS[CONFIG.RESOLUTION] || 900;
    CONFIG.CANDLE_INTERVAL_MS = sec * 1000;
};
updateIntervalFromResolution();

// Dynamic specifications (retrieved on start)
export const MARKET_SPECS = {
    contractSize: 0.001, // default specification fallback
    productId: 27
};

// ────────────────────────────────────────────────────────────────────────────
//  SYSTEM STATE
// ────────────────────────────────────────────────────────────────────────────
export const state = {
    isProcessing: false,   // Processing lock preventing overlapping ticks (Requirement 1)
    position: null,        // { side, entryPrice, stopLoss, tp1, tp2, size, initialSize, tp1Done, tp2Done, tp1Size, tp2Size, tp3Size, highestPrice, lowestPrice, atr, openedAt, stopLossOrderId, tp1OrderId, tp2OrderId }
    dailyPnL: 0,
    consecutiveLosses: 0,
    dailyTradingStopped: false,
    paperBalance: CONFIG.ACCOUNT_SIZE,
    lastMarketRegime: "NEUTRAL",
    runCount: 0,
    cooldownRemaining: 0,
    priceHistory: [],
    tradeHistory: [],       // Closed trade journals
    indicators: {
        price: 0,
        ema20: 0,
        ema50: 0,
        ema200: 0,
        atr: 0,
        adx: 0,
        vwap: 0,
        volume: 0,
        volumeSma: 0,
        isVolumeSpike: false,
        isAtrValid: false
    }
};

const STATE_FILE = path.join(process.cwd(), "state.json");

export function saveState() {
    try {
        const dataToSave = {
            position: state.position,
            dailyPnL: state.dailyPnL,
            consecutiveLosses: state.consecutiveLosses,
            dailyTradingStopped: state.dailyTradingStopped,
            paperBalance: state.paperBalance,
            tradeHistory: state.tradeHistory,
            winRate: getWinRate()
        };
        // FIX-P1-3: Atomic write — write to .tmp then rename to prevent corruption on process kill mid-write
        const tmpFile = STATE_FILE + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(dataToSave, null, 2), "utf-8");
        fs.renameSync(tmpFile, STATE_FILE);
    } catch (e) {
        log.error("Failed to save state to state.json:", e.message);
    }
}

export function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const content = fs.readFileSync(STATE_FILE, "utf-8");
            const parsed = JSON.parse(content);
            if (parsed) {
                if (parsed.position !== undefined) state.position = parsed.position;
                if (parsed.dailyPnL !== undefined) state.dailyPnL = parseFloat(parsed.dailyPnL) || 0;
                if (parsed.consecutiveLosses !== undefined) state.consecutiveLosses = parseInt(parsed.consecutiveLosses, 10) || 0;
                if (parsed.dailyTradingStopped !== undefined) state.dailyTradingStopped = !!parsed.dailyTradingStopped;
                if (parsed.paperBalance !== undefined) state.paperBalance = parseFloat(parsed.paperBalance) || CONFIG.ACCOUNT_SIZE;
                if (parsed.tradeHistory !== undefined && Array.isArray(parsed.tradeHistory)) state.tradeHistory = parsed.tradeHistory;
                log.info(`[PERSISTENCE] Successfully restored state from state.json: Daily PnL: $${state.dailyPnL.toFixed(4)} | Position Active: ${!!state.position} | Win Rate: ${getWinRate().toFixed(1)}%`);
            }
        } else {
            log.info("[PERSISTENCE] No state.json found. Running with clean state.");
        }
    } catch (e) {
        log.error("Failed to load state from state.json:", e.message);
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  ADVANCED PERFORMANCE ANALYTICS & DAILY RISK TRIGGERS (Tasks 10 & 14)
// ────────────────────────────────────────────────────────────────────────────
export function getPerformanceAnalytics() {
    const history = state.tradeHistory;
    if (!history || history.length === 0) {
        return {
            winRate: 0,
            avgWin: 0,
            avgLoss: 0,
            expectancy: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            sharpeLike: 0,
            monthlySummary: {}
        };
    }

    const wins = history.filter(t => t.pnl > 0);
    const losses = history.filter(t => t.pnl <= 0);

    const totalWinsVal = wins.reduce((acc, t) => acc + t.pnl, 0);
    const totalLossesVal = Math.abs(losses.reduce((acc, t) => acc + t.pnl, 0));

    const avgWin = wins.length > 0 ? totalWinsVal / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLossesVal / losses.length : 0;

    const winRate = wins.length / history.length;
    const lossRate = 1 - winRate;

    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const profitFactor = totalLossesVal > 0 ? totalWinsVal / totalLossesVal : totalWinsVal > 0 ? 999 : 0;

    let sharpeLike = 0;
    const pnls = history.map(t => t.pnl);
    const mean = pnls.reduce((sum, v) => sum + v, 0) / history.length;
    if (history.length > 1) {
        const variance = pnls.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (history.length - 1);
        const stdDev = Math.sqrt(variance);
        sharpeLike = stdDev > 0 ? mean / stdDev : 0;
    }

    let peak = CONFIG.ACCOUNT_SIZE;
    let maxDrawdown = 0;
    let currentEquity = CONFIG.ACCOUNT_SIZE;
    for (const t of history) {
        currentEquity += t.pnl;
        if (currentEquity > peak) {
            peak = currentEquity;
        }
        const dd = (peak - currentEquity) / peak;
        if (dd > maxDrawdown) {
            maxDrawdown = dd;
        }
    }

    const monthlySummary = {};
    for (const t of history) {
        const date = new Date(t.timestamp);
        const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
        if (!monthlySummary[monthKey]) {
            monthlySummary[monthKey] = 0;
        }
        monthlySummary[monthKey] += t.pnl;
    }

    return {
        winRate: winRate * 100,
        avgWin,
        avgLoss,
        expectancy,
        profitFactor,
        maxDrawdown: maxDrawdown * 100,
        sharpeLike,
        monthlySummary
    };
}

export function checkDailyRiskLimits() {
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);
    const tradesToday = state.tradeHistory.filter(t => t.timestamp >= todayStart);

    // Limit 1: Max trades per day = 8 (upgraded for higher timeframe edge setups)
    if (tradesToday.length >= 8) {
        log.risk(`Daily Risk Block: Maximum trades per day limit (8) reached.`);
        return true;
    }

    // Limit 2: Max losses per day = 3
    const lossesToday = tradesToday.filter(t => t.pnl < 0).length;
    if (lossesToday >= 3) {
        log.risk(`Daily Risk Block: Maximum losses per day limit (3) reached.`);
        return true;
    }

    // Limit 3: Pause trading after 2 losses within last 3 trades
    const last3Trades = tradesToday.slice(-3);
    const lossesInLast3 = last3Trades.filter(t => t.pnl < 0).length;
    if (lossesInLast3 >= 2) {
        log.risk(`Daily Risk Block: Consecutive losses threshold activated (2 losses in last 3 trades).`);
        return true;
    }

    return false;
}

// ────────────────────────────────────────────────────────────────────────────
//  LOGGING UTILITY (WITH IN-MEMORY STATUS BOARD)
// ────────────────────────────────────────────────────────────────────────────
export const logBuffer = [];
const ts = () => new Date().toISOString();

export const log = {
    info: (...msg) => addLog("INFO", "💡", ...msg),
    entry: (...msg) => addLog("ENTRY", "★", ...msg),
    exit: (...msg) => addLog("EXIT", "⚠", ...msg),
    risk: (...msg) => addLog("RISK", "🛑", ...msg),
    pnl: (...msg) => addLog("PNL", "💵", ...msg),
    error: (...msg) => addLog("ERROR", "❌", ...msg)
};

function addLog(level, icon, ...msg) {
    const msgStr = msg.map(m => typeof m === "object" ? JSON.stringify(m) : m).join(" ");
    const formatted = `[${level}] ${ts()} | ${icon} ${msgStr}`;
    console.log(formatted);
    logBuffer.push({
        id: Math.random().toString(36).substring(2, 9),
        timestamp: Date.now(),
        level,
        icon,
        text: formatted
    });
    if (logBuffer.length > 200) {
        logBuffer.shift();
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  AUTHENTICATION & API UTILITIES
// ────────────────────────────────────────────────────────────────────────────
export function generateSignature(method, path, body = "") {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = method + timestamp + path + body;
    const signature = crypto
        .createHmac("sha256", CONFIG.API_SECRET)
        .update(message)
        .digest("hex");
    return { signature, timestamp };
}

export async function deltaRequest(method, path, bodyObj = null) {
    const body = bodyObj ? JSON.stringify(bodyObj) : "";
    const { signature, timestamp } = generateSignature(method.toUpperCase(), path, body);

    const headers = {
        "api-key": CONFIG.API_KEY,
        "signature": signature,
        "timestamp": timestamp,
        "Content-Type": "application/json",
        "User-Agent": "nodejs-strategy"
    };

    const url = CONFIG.BASE_URL + path;
    const cfg = { headers };

    const verb = method.toUpperCase();
    if (verb === "GET") {
        const res = await axios.get(url, cfg);
        return res.data;
    } else if (verb === "DELETE") {
        const res = await axios.delete(url, { headers, data: bodyObj });
        return res.data;
    } else {
        const res = await axios.post(url, bodyObj, cfg);
        return res.data;
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  TECHNICAL INDICATORS
// ────────────────────────────────────────────────────────────────────────────

export function calculateEMA(prices, period) {
    if (prices.length < period) return Array(prices.length).fill(null);
    const k = 2 / (period + 1);
    const emaArr = Array(prices.length).fill(null);

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
    }
    let ema = sum / period;
    emaArr[period - 1] = ema;

    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
        emaArr[i] = ema;
    }
    return emaArr;
}

export function calculateATR(candles, period = 14) {
    const len = candles.length;
    const atrArr = Array(len).fill(null);
    if (len < period) return atrArr;

    const tr = Array(len);
    tr[0] = candles[0].high - candles[0].low;
    for (let i = 1; i < len; i++) {
        const h = candles[i].high;
        const l = candles[i].low;
        const prevC = candles[i - 1].close;
        tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    }

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += tr[i];
    }
    let atr = sum / period;
    atrArr[period - 1] = atr;

    for (let i = period; i < len; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        atrArr[i] = atr;
    }
    return atrArr;
}

export function calculateADX(candles, period = 14) {
    const len = candles.length;
    const adxArr = Array(len).fill(null);
    if (len < period * 2) return adxArr;

    const tr = Array(len);
    const plusDM = Array(len);
    const minusDM = Array(len);

    tr[0] = candles[0].high - candles[0].low;
    plusDM[0] = 0;
    minusDM[0] = 0;

    for (let i = 1; i < len; i++) {
        const h = candles[i].high;
        const l = candles[i].low;
        const prevH = candles[i - 1].high;
        const prevL = candles[i - 1].low;
        const prevC = candles[i - 1].close;

        tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));

        const upMove = h - prevH;
        const downMove = prevL - l;

        plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
        minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    }

    const smoothTR = Array(len).fill(0);
    const smoothPlusDM = Array(len).fill(0);
    const smoothMinusDM = Array(len).fill(0);

    let sumTR = 0, sumPlusDM = 0, sumMinusDM = 0;
    for (let i = 0; i < period; i++) {
        sumTR += tr[i];
        sumPlusDM += plusDM[i];
        sumMinusDM += minusDM[i];
    }

    smoothTR[period - 1] = sumTR;
    smoothPlusDM[period - 1] = sumPlusDM;
    smoothMinusDM[period - 1] = sumMinusDM;

    for (let i = period; i < len; i++) {
        smoothTR[i] = smoothTR[i - 1] - (smoothTR[i - 1] / period) + tr[i];
        smoothPlusDM[i] = smoothPlusDM[i - 1] - (smoothPlusDM[i - 1] / period) + plusDM[i];
        smoothMinusDM[i] = smoothMinusDM[i - 1] - (smoothMinusDM[i - 1] / period) + minusDM[i];
    }

    const dx = Array(len).fill(null);
    for (let i = period - 1; i < len; i++) {
        const trVal = smoothTR[i];
        if (trVal === 0) {
            dx[i] = 0;
            continue;
        }
        const plusDI = 100 * (smoothPlusDM[i] / trVal);
        const minusDI = 100 * (smoothMinusDM[i] / trVal);
        const sumDI = plusDI + minusDI;
        dx[i] = sumDI === 0 ? 0 : 100 * (Math.abs(plusDI - minusDI) / sumDI);
    }

    let sumDX = 0;
    let validDXCount = 0;
    let firstADXIdx = -1;

    for (let i = 0; i < len; i++) {
        if (dx[i] !== null) {
            sumDX += dx[i];
            validDXCount++;
            if (validDXCount === period) {
                firstADXIdx = i;
                break;
            }
        }
    }

    if (firstADXIdx === -1) return adxArr;

    let adx = sumDX / period;
    adxArr[firstADXIdx] = adx;

    for (let i = firstADXIdx + 1; i < len; i++) {
        if (dx[i] !== null) {
            adx = (adx * (period - 1) + dx[i]) / period;
            adxArr[i] = adx;
        }
    }

    return adxArr;
}

export function calculateVWAP(candles) {
    const len = candles.length;
    const vwapArr = Array(len).fill(null);
    if (len === 0) return vwapArr;

    let cumulativeTypicalPriceVolume = 0;
    let cumulativeVolume = 0;
    let prevDateStr = "";

    for (let i = 0; i < len; i++) {
        const c = candles[i];
        const typicalPrice = (c.high + c.low + c.close) / 3;
        const volume = c.volume;

        const date = new Date(c.time > 1000000000000 ? c.time : c.time * 1000);
        const dateStr = date.getUTCFullYear() + "-" + date.getUTCMonth() + "-" + date.getUTCDate();

        if (dateStr !== prevDateStr) {
            cumulativeTypicalPriceVolume = 0;
            cumulativeVolume = 0;
            prevDateStr = dateStr;
        }

        cumulativeTypicalPriceVolume += typicalPrice * volume;
        cumulativeVolume += volume;

        vwapArr[i] = cumulativeVolume === 0 ? typicalPrice : cumulativeTypicalPriceVolume / cumulativeVolume;
    }

    return vwapArr;
}

export function calculateVolumeSMA(candles, period = 20) {
    const len = candles.length;
    const smaArr = Array(len).fill(null);
    if (len < period) return smaArr;

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += candles[i].volume;
    }
    smaArr[period - 1] = sum / period;

    for (let i = period; i < len; i++) {
        sum = sum - candles[i - period].volume + candles[i].volume;
        smaArr[i] = sum / period;
    }
    return smaArr;
}

// ────────────────────────────────────────────────────────────────────────────
//  MARKET DATA FETCH & EXCHANGE SPEC VERIFICATION
// ────────────────────────────────────────────────────────────────────────────
export async function getMarketData(limit = 150, resolution = CONFIG.RESOLUTION) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const sec = RESOLUTION_SECONDS[resolution] || 900;
        const start = now - (limit * sec);
        const path = `/v2/history/candles?resolution=${resolution}&symbol=${CONFIG.SYMBOL}&start=${start}&end=${now}`;
        const res = await deltaRequest("GET", path);

        if (res && res.result && Array.isArray(res.result) && res.result.length > 0) {
            return res.result.map(c => ({
                time: parseInt(c.time, 10),
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                volume: parseFloat(c.volume)
            }));
        }
    } catch (_) { /* Fallback below */ }

    // Ticker Fallback
    try {
        const path = `/v2/tickers?symbol=${CONFIG.SYMBOL}`;
        const res = await deltaRequest("GET", path);
        const tick = res?.result?.[0] || res?.result;
        if (tick) {
            const price = parseFloat(tick.mark_price || tick.last_price || tick.close);
            if (!isNaN(price)) {
                log.info(`Fetched ticker fallback price: $${price}`);
                return [{
                    time: Math.floor(Date.now() / 1000),
                    open: price, high: price, low: price, close: price, volume: 0
                }];
            }
        }
    } catch (e) {
        log.error("getMarketData completely failed:", e.message);
    }

    return null;
}

export async function getExactEntryPriceFromFills(side, liveSize) {
    try {
        log.info(`[RECOVERY] Querying recent fills from exchange for ${side.toUpperCase()} of size ${liveSize} for accurate entry...`);
        const path = `/v2/fills?symbol=${CONFIG.SYMBOL}&limit=20`;
        const res = await deltaRequest("GET", path);
        if (res && res.result && Array.isArray(res.result) && res.result.length > 0) {
            const matchingFills = res.result.filter(f => f.side === side);
            if (matchingFills.length > 0) {
                let totalContracts = 0;
                let weightedPriceSum = 0;
                for (const fill of matchingFills) {
                    const fillQty = Math.abs(parseInt(fill.size || fill.qty || fill.qty_filled || 0, 10));
                    const fillPrice = parseFloat(fill.price || fill.avg_price || fill.fill_price || 0);
                    if (fillQty > 0 && fillPrice > 0) {
                        weightedPriceSum += fillPrice * fillQty;
                        totalContracts += fillQty;
                        if (totalContracts >= liveSize) {
                            break;
                        }
                    }
                }
                if (totalContracts > 0) {
                    const exactPrice = weightedPriceSum / totalContracts;
                    log.info(`[RECOVERY] Successfully reconstructed exact weighted average entry price from fills: $${exactPrice.toFixed(2)} based on ${totalContracts} contracts.`);
                    return exactPrice;
                }
            }
        }
    } catch (e) {
        log.error("Failed to fetch accurate entry price from `/v2/fills` history endpoint:", e.message);
    }
    return null;
}

export async function getOpenOrders() {
    if (CONFIG.PAPER_TRADING) return [];
    try {
        const path = `/v2/orders?symbol=${CONFIG.SYMBOL}&states=open`;
        const res = await deltaRequest("GET", path);
        if (res && res.result && Array.isArray(res.result)) {
            return res.result;
        }
    } catch (e) {
        log.error("Failed to query open orders from exchange:", e.message);
    }
    return [];
}

export async function reconcileExchangeState(currentPrice) {
    if (CONFIG.PAPER_TRADING) {
        return;
    }
    try {
        const path = "/v2/positions/margined";
        const res = await deltaRequest("GET", path);
        if (!res || !res.result || !Array.isArray(res.result)) {
            log.error("[RECONCILIATION] Could not fetch positions from exchange during periodic check.");
            return;
        }

        const match = res.result.find(p => p.symbol === CONFIG.SYMBOL && Math.abs(parseFloat(p.size)) > 0);
        const openOrders = await getOpenOrders();

        if (!match) {
            // Case A: Exchange has no active position for this symbol
            if (state.position) {
                log.risk("[RECONCILIATION] Discrepancy detected: Local position is active, but Exchange has no open position. Syncing closed status locally.");

                let exitPrice = currentPrice;
                const fillsPrice = await getExactEntryPriceFromFills(state.position.side === "buy" ? "sell" : "buy", state.position.size);
                if (fillsPrice) {
                    exitPrice = fillsPrice;
                }

                const rawPnl = state.position.side === "buy"
                    ? state.position.size * MARKET_SPECS.contractSize * (exitPrice - state.position.entryPrice)
                    : state.position.size * MARKET_SPECS.contractSize * (state.position.entryPrice - exitPrice);

                state.dailyPnL += rawPnl;
                state.consecutiveLosses = rawPnl > 0 ? 0 : state.consecutiveLosses + 1;

                state.tradeHistory.push({
                    id: Math.random().toString(36).substring(2, 9),
                    side: state.position.side,
                    entryPrice: state.position.entryPrice,
                    exitPrice,
                    size: state.position.size,
                    pnl: rawPnl,
                    result: rawPnl > 0 ? "win" : "loss",
                    timestamp: Date.now(),
                    tag: "Ex-Reconciliation Close"
                });

                log.exit(`[RECONCILIATION] Synchronized closed position locally. Exit Price: $${exitPrice.toFixed(2)} | PnL: $${rawPnl.toFixed(4)}`);
                state.position = null;
                state.cooldownRemaining = 5;
            }
        } else {
            // Case B: Exchange has an active marginal position
            const liveSize = Math.abs(parseInt(match.size, 10));
            const side = parseInt(match.size, 10) > 0 ? "buy" : "sell";

            if (!state.position) {
                log.risk(`[RECONCILIATION] Active position detected on Delta Exchange but missing/orphaned locally. Triggering robust state recovery...`);
                await recoverLivePositionOnStart();
            } else {
                if (state.position.side !== side) {
                    log.risk(`[RECONCILIATION] Position side mismatch between local (${state.position.side}) and exchange (${side})! Clearing local state & recovering...`);
                    state.position = null;
                    await recoverLivePositionOnStart();
                    return;
                }

                if (state.position.size !== liveSize) {
                    log.info(`[RECONCILIATION] Position quantity mismatch. Local Size: ${state.position.size} | Exchange Size: ${liveSize}. Aligning states...`);

                    const originalSize = state.position.initialSize;
                    const tp1ExpectedRemaining = originalSize - state.position.tp1Size;
                    const tp2ExpectedRemaining = originalSize - state.position.tp1Size - state.position.tp2Size;

                    const exitSide = side === "buy" ? "sell" : "buy";

                    // Sync TP1 limit order hit on exchange
                    if (!state.position.tp1Done && liveSize <= tp1ExpectedRemaining) {
                        log.pnl(`[RECONCILIATION] TP1 Limit Order was filled on-exchange at $${state.position.tp1.toFixed(2)}!`);
                        state.position.tp1Done = true;

                        let tp1Price = state.position.tp1;
                        const fillsPrice = await getExactEntryPriceFromFills(exitSide, state.position.tp1Size);
                        if (fillsPrice) {
                            tp1Price = fillsPrice;
                        }

                        const partialPnl = side === "buy"
                            ? state.position.tp1Size * MARKET_SPECS.contractSize * (tp1Price - state.position.entryPrice)
                            : state.position.tp1Size * MARKET_SPECS.contractSize * (state.position.entryPrice - tp1Price);

                        state.dailyPnL += partialPnl;
                        state.tradeHistory.push({
                            id: Math.random().toString(36).substring(2, 9),
                            side,
                            entryPrice: state.position.entryPrice,
                            exitPrice: tp1Price,
                            size: state.position.tp1Size,
                            pnl: partialPnl,
                            result: "win",
                            timestamp: Date.now(),
                            tag: "Reconciliation TP1 Exit"
                        });
                    }

                    // Sync TP2 limit order hit on-exchange
                    if (!state.position.tp2Done && liveSize <= tp2ExpectedRemaining) {
                        log.pnl(`[RECONCILIATION] TP2 Limit Order was filled on-exchange at $${state.position.tp2.toFixed(2)}!`);
                        state.position.tp2Done = true;

                        let tp2Price = state.position.tp2;
                        const fillsPrice = await getExactEntryPriceFromFills(exitSide, state.position.tp2Size);
                        if (fillsPrice) {
                            tp2Price = fillsPrice;
                        }

                        const partialPnl = side === "buy"
                            ? state.position.tp2Size * MARKET_SPECS.contractSize * (tp2Price - state.position.entryPrice)
                            : state.position.tp2Size * MARKET_SPECS.contractSize * (state.position.entryPrice - tp2Price);

                        state.dailyPnL += partialPnl;
                        state.tradeHistory.push({
                            id: Math.random().toString(36).substring(2, 9),
                            side,
                            entryPrice: state.position.entryPrice,
                            exitPrice: tp2Price,
                            size: state.position.tp2Size,
                            pnl: partialPnl,
                            result: "win",
                            timestamp: Date.now(),
                            tag: "Reconciliation TP2 Exit"
                        });
                    }

                    // Update size tracker to match actual live size
                    state.position.size = liveSize;

                    // Re-align on-exchange Stop Loss size
                    if (state.position.stopLossOrderId) {
                        log.info(`[RECONCILIATION] Adjusting Stop Loss size on-exchange to remaining size: ${liveSize}`);
                        await cancelOrder(state.position.stopLossOrderId);
                        const slOrder = await placeOrder(exitSide, liveSize, "stop_market_order", null, "SL Sync after TP Reconciliation", state.position.stopLoss);
                        if (slOrder) {
                            state.position.stopLossOrderId = slOrder.id;
                        }
                    }
                }

                // Check Stop Loss order exists on broker, re-submit if missing to preserve risk rules
                const stopSide = side === "buy" ? "sell" : "buy";
                if (state.position.stopLossOrderId) {
                    const slExists = openOrders.some(o => o.id === state.position.stopLossOrderId);
                    if (!slExists) {
                        log.risk("[RECONCILIATION] WARNING: Active Stop Loss Order is missing from exchange book. Re-establishing safety stop order...");
                        const slOrder = await placeOrder(stopSide, liveSize, "stop_market_order", null, "Reestablished Safety SL", state.position.stopLoss);
                        if (slOrder) {
                            state.position.stopLossOrderId = slOrder.id;
                        }
                    }
                }
            }
        }
    } catch (e) {
        log.error("[RECONCILIATION] Error during execution:", e.message);
    }
    saveState();
}

export async function fetchAndVerifyMarketSpecs() {
    try {
        log.info(`Querying products specification from Delta Exchange for: ${CONFIG.SYMBOL}`);
        const path = "/v2/products";
        const res = await deltaRequest("GET", path);
        if (res && res.result && Array.isArray(res.result)) {
            const prod = res.result.find(p => p.symbol === CONFIG.SYMBOL);
            if (prod) {
                MARKET_SPECS.contractSize = parseFloat(prod.contract_unit || prod.contract_value || prod.contract_size || "0.001");
                MARKET_SPECS.productId = parseInt(prod.id, 10);
                CONFIG.PRODUCT_ID = MARKET_SPECS.productId;
                log.info(`[SPECS VERIFIED] Contract Size for ${CONFIG.SYMBOL}: ${MARKET_SPECS.contractSize} | Product ID: ${MARKET_SPECS.productId}`);
                return true;
            }
        }
    } catch (e) {
        log.error("Verification of specifications failed. Hardcoded fallback (0.001 BTC) in action.", e.message);
    }
    return false;
}

export async function getAccountBalance() {
    if (CONFIG.PAPER_TRADING) {
        return state.paperBalance;
    }
    try {
        const path = "/v2/wallet/balances";
        const res = await deltaRequest("GET", path);
        if (res && res.result && Array.isArray(res.result)) {
            const assets = ["USDT", "USDC", "BTC", "DETO"];
            for (const sym of assets) {
                const balObj = res.result.find(b => b.asset_symbol === sym || b.asset_code === sym);
                if (balObj) {
                    const balanceVal = parseFloat(balObj.balance || balObj.available_balance || "0");
                    if (!isNaN(balanceVal) && balanceVal > 0) {
                        return balanceVal;
                    }
                }
            }
        }
    } catch (e) {
        log.error("Failed to fetch real wallet balance:", e.message);
    }
    // FIX-P1-5: Return 0 on live balance failure — never assume capital exists on a live account
    log.risk("[BALANCE] Could not retrieve live balance. Returning 0 to prevent phantom sizing.");
    return 0;
}

// ────────────────────────────────────────────────────────────────────────────
//  POSITION SIZING & COOLDOWNS
// ────────────────────────────────────────────────────────────────────────────
export function calculatePositionSize(balance, currentPrice, atrValue) {
    const riskAmountUSD = balance * CONFIG.RISK_PCT;
    const slDistanceUSD = 1.5 * atrValue;
    const contractUnit = MARKET_SPECS.contractSize;

    let calculatedContracts = Math.floor(riskAmountUSD / (contractUnit * slDistanceUSD));

    // Limit maximum leverage to 3x of Account Size
    const maxLeverage = 3;
    const maxNotionalUSD = balance * maxLeverage;
    const maxAllowedContracts = Math.floor(maxNotionalUSD / (currentPrice * contractUnit));

    let size = Math.min(calculatedContracts, maxAllowedContracts);

    // Enforce max position cap (Requirement 7)
    size = Math.min(size, CONFIG.MAX_CONTRACTS || 100);

    // Enforce strict risk limits for small account constraints
    if (size < 1) {
        const singleContractRisk = contractUnit * slDistanceUSD;
        if (singleContractRisk <= balance * 0.02) {
            size = 1;
        } else {
            size = 0; // Prevent trading if risk of 1 contract crosses 2% threshold to prevent blowups
        }
    }

    // Double check final size against max contracts cap
    if (size > 0) {
        size = Math.min(size, CONFIG.MAX_CONTRACTS || 100);
    }

    return size;
}

export function getWinRate() {
    if (state.tradeHistory.length === 0) return 0;
    const wins = state.tradeHistory.filter(t => t.pnl > 0).length;
    return (wins / state.tradeHistory.length) * 100;
}

// ────────────────────────────────────────────────────────────────────────────
//  ORDER EXECUTION
// ────────────────────────────────────────────────────────────────────────────
export async function placeOrder(side, size, type = "market_order", price = null, label = "", triggerPrice = null, reduceOnly = null) {
    if (CONFIG.PAPER_TRADING) {
        const fakeId = `PAPER-${type.toUpperCase().substring(0,6)}-${Date.now()}`;
        return {
            id: fakeId,
            state: "filled",
            avg_fill_price: price || state.priceHistory.at(-1)?.close || 0
        };
    }

    try {
        const path = "/v2/orders";
        
        // VERIFIED SCHEMA (Requirements 4 & 5):
        // Delta Exchange API accepts POST /v2/orders of the following format:
        // - product_symbol: (string) e.g., "BTCUSD"
        // - size: (integer) Contract Quantity
        // - side: (string) "buy" or "sell"
        // - order_type: (string) "market_order", "limit_order", "stop_market_order" (or "stop_limit_order")
        // - limit_price: (string) required for limit_order
        // - stop_price: (string) trigger price for stop_market_order (Requirement 4 verification)
        // - reduce_only: (boolean) limit / stop order scaling safety (Requirement 5 verification)
        const bodyObj = {
            product_symbol: CONFIG.SYMBOL,
            size: parseInt(size, 10),
            side,
            order_type: type
        };

        if (type === "limit_order" && price) {
            bodyObj.limit_price = String(price);
        }

        // Handle stop orders (Stop loss triggers on exchange side)
        // Verified: "stop_market_order" expects trigger price in "stop_price" parameter (string of float)
        if (type === "stop_market_order" && triggerPrice) {
            bodyObj.stop_price = String(triggerPrice);
            bodyObj.reduce_only = true;
        }

        if (type === "limit_order") {
            bodyObj.reduce_only = true;
        }

        // Apply explicit reduce_only override if set (Requirement 5 verification)
        if (reduceOnly !== null) {
            bodyObj.reduce_only = !!reduceOnly;
        }

        log.info(`[API PLACING ORDER] Sending request: ${side} ${size} @ ${price || 'market'} (Type: ${type}, Trigger stop_price: ${triggerPrice || 'none'}, reduce_only: ${bodyObj.reduce_only || false})`);
        const res = await deltaRequest("POST", path, bodyObj);
        if (res && res.result) {
            return res.result;
        }
        log.error("Order rejected by exchange:", JSON.stringify(res));
        return null;
    } catch (e) {
        log.error("placeOrder call failed:", e.response?.data || e.message);
        return null;
    }
}

export async function cancelOrder(orderId) {
    if (CONFIG.PAPER_TRADING) {
        return true;
    }
    try {
        const path = "/v2/orders";
        // FIX-P1-1: Delta Exchange DELETE /v2/orders requires product_id (integer), not product_symbol
        const bodyObj = {
            id: parseInt(orderId, 10),
            product_id: MARKET_SPECS.productId
        };
        const res = await deltaRequest("DELETE", path, bodyObj);
        if (res && res.result) {
            log.info(`[API CANCEL] Cancelled order ${orderId} successfully.`);
            return true;
        }
    } catch (e) {
        log.error(`[API CANCEL] Failed to cancel order ${orderId}:`, e.response?.data || e.message);
    }
    return false;
}

// ────────────────────────────────────────────────────────────────────────────
//  TRADE TRANSITIONS (OPEN/CLOSE/UPDATES)
// ────────────────────────────────────────────────────────────────────────────
export async function openPosition(side, size, price, stopLoss, takeProfit, atr, reason) {
    const order = await placeOrder(side, size, "market_order", null, reason);
    if (!order) return;

    const fillPrice = parseFloat(order.avg_fill_price || price);

    const tp1Size = Math.floor(size * 0.40);
    const tp2Size = Math.floor(size * 0.40);
    const tp3Size = size - tp1Size - tp2Size;

    state.position = {
        side,
        entryPrice: fillPrice,
        stopLoss: side === "buy" ? fillPrice - (1.5 * atr) : fillPrice + (1.5 * atr),
        tp1: side === "buy" ? fillPrice + (2.0 * atr) : fillPrice - (2.0 * atr),
        tp2: side === "buy" ? fillPrice + (4.0 * atr) : fillPrice - (4.0 * atr),
        size,
        initialSize: size,
        tp1Done: false,
        tp2Done: false,
        tp1Size,
        tp2Size,
        tp3Size,
        highestPrice: fillPrice,
        lowestPrice: fillPrice,
        atr,
        orderId: order.id,
        openedAt: Date.now(),
        stopLossOrderId: null,
        tp1OrderId: null,
        tp2OrderId: null
    };

    log.entry(`POSITION OPENED: ${side.toUpperCase()} ${size} contracts @ $${fillPrice.toFixed(2)} | SL: $${state.position.stopLoss.toFixed(2)} | TP1: $${state.position.tp1.toFixed(2)} | TP2: $${state.position.tp2.toFixed(2)}`);

    // Place Exchange-Side robust Stop Loss & Take Profit protection
    if (!CONFIG.PAPER_TRADING) {
        const stopSide = side === "buy" ? "sell" : "buy";
        
        // FIX-P1-6: Retry SL placement up to 3 times with 500ms backoff.
        // If all attempts fail, immediately close the position — an unprotected position is unacceptable.
        log.info(`Placing exchange-side Stop Loss market order at $${state.position.stopLoss.toFixed(2)}`);
        let slOrder = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            slOrder = await placeOrder(stopSide, size, "stop_market_order", null, "Position Stop Loss Trigger", state.position.stopLoss);
            if (slOrder) break;
            log.risk(`[SL PLACEMENT] Attempt ${attempt}/3 failed. ${attempt < 3 ? "Retrying in 500ms..." : "All attempts exhausted."}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500));
        }

        if (slOrder) {
            state.position.stopLossOrderId = slOrder.id;
            log.info(`Stop Loss registered with Exchange Order ID: ${slOrder.id}`);
        } else {
            log.risk("[SL PLACEMENT] CRITICAL: Failed to place Stop Loss after 3 attempts. Closing position immediately to protect capital.");
            await closePosition(fillPrice, "SL placement failure — emergency close");
            return;
        }

        // Place Take Profit limit orders SIT-ON-BOOKS for rebate edge and instant fill execution
        if (tp1Size >= 1) {
            log.info(`Placing TP1 limit order at $${state.position.tp1.toFixed(2)} for ${tp1Size} contracts`);
            const tp1Order = await placeOrder(stopSide, tp1Size, "limit_order", state.position.tp1, "TP1 Limit");
            if (tp1Order) {
                state.position.tp1OrderId = tp1Order.id;
            }
        }
        if (tp2Size >= 1) {
            log.info(`Placing TP2 limit order at $${state.position.tp2.toFixed(2)} for ${tp2Size} contracts`);
            const tp2Order = await placeOrder(stopSide, tp2Size, "limit_order", state.position.tp2, "TP2 Limit");
            if (tp2Order) {
                state.position.tp2OrderId = tp2Order.id;
            }
        }
    }
    saveState();
}

export async function closePosition(currentPrice, reason) {
    if (!state.position) return;
    const { side, entryPrice, size, stopLossOrderId, tp1OrderId, tp2OrderId } = state.position;
    const closeSide = side === "buy" ? "sell" : "buy";

    // Cancel outstanding exchange protect orders first
    if (!CONFIG.PAPER_TRADING) {
        if (stopLossOrderId) {
            await cancelOrder(stopLossOrderId);
        }
        if (tp1OrderId) {
            await cancelOrder(tp1OrderId);
        }
        if (tp2OrderId) {
            await cancelOrder(tp2OrderId);
        }
    }

    const order = await placeOrder(closeSide, size, "market_order", null, reason);
    if (!order) {
        log.error("Critical Failure: Close position order failed. Retry next tick.");
        return;
    }

    const fillPrice = parseFloat(order.avg_fill_price || currentPrice);
    const rawPnl = side === "buy"
        ? size * MARKET_SPECS.contractSize * (fillPrice - entryPrice)
        : size * MARKET_SPECS.contractSize * (entryPrice - fillPrice);

    state.dailyPnL += rawPnl;
    if (CONFIG.PAPER_TRADING) {
        state.paperBalance += rawPnl;
    }

    const isWin = rawPnl > 0;
    if (isWin) {
        state.consecutiveLosses = 0;
    } else {
        state.consecutiveLosses++;
    }

    const tradeRecord = {
        id: Math.random().toString(36).substring(2, 9),
        side,
        entryPrice,
        exitPrice: fillPrice,
        size,
        pnl: rawPnl,
        result: isWin ? "win" : "loss",
        timestamp: Date.now()
    };
    state.tradeHistory.push(tradeRecord);

    log.exit(`POSITION CLOSED: ${closeSide.toUpperCase()} ${size} contracts @ $${fillPrice.toFixed(2)} | Reason: ${reason}`);
    log.pnl(`PnL: $${rawPnl.toFixed(4)} USD | Result: ${isWin ? "✅ WIN" : "❌ LOSS"}`);

    if (state.consecutiveLosses >= CONFIG.MAX_CONSEC_LOSSES) {
        state.dailyTradingStopped = true;
        log.risk(`Halted trading: reached ${CONFIG.MAX_CONSEC_LOSSES} consecutive losses.`);
    }

    const activeBalance = CONFIG.PAPER_TRADING ? state.paperBalance : CONFIG.ACCOUNT_SIZE;
    const maxDailyLossAllowed = activeBalance * CONFIG.MAX_DAILY_LOSS_PCT;
    if (state.dailyPnL <= -maxDailyLossAllowed) {
        state.dailyTradingStopped = true;
        log.risk(`Halted trading: Daily loss of $${state.dailyPnL.toFixed(2)} exceeded limit of $${maxDailyLossAllowed.toFixed(2)}.`);
    }

    // Verify custom daily risk constraints for 5 trades/day, 3 losses/day, 2 losses within 3 trades of trigger
    if (checkDailyRiskLimits()) {
        state.dailyTradingStopped = true;
    }

    state.cooldownRemaining = 5;
    log.info("Cooldown initialized: 5 candles remaining until next execution.");

    const winRate = getWinRate();
    log.info(`--- METRICS JOURNAL --- Balance: $${(CONFIG.PAPER_TRADING ? state.paperBalance : activeBalance + state.dailyPnL).toFixed(2)} | Win Rate: ${winRate.toFixed(1)}% | Consecutive Losses: ${state.consecutiveLosses} | Daily PnL: $${state.dailyPnL.toFixed(4)}`);

    state.position = null;
    saveState();
}

export async function syncAndTrackStopLossUpdate(newSl) {
    if (!state.position) return;
    state.position.stopLoss = newSl;
    log.info(`Stop Loss Trailed/Shifted to → $${newSl.toFixed(2)}`);

    if (!CONFIG.PAPER_TRADING && state.position.stopLossOrderId) {
        log.info(`Syncing Stop Loss update exchange-side...`);
        // Cancel old SL and replace
        await cancelOrder(state.position.stopLossOrderId);
        const stopSide = state.position.side === "buy" ? "sell" : "buy";
        const slOrder = await placeOrder(stopSide, state.position.size, "stop_market_order", null, "Updated Trailing SL", newSl);
        if (slOrder) {
            state.position.stopLossOrderId = slOrder.id;
            log.info(`Exchange-side Stop Loss synchronized with new Order ID: ${slOrder.id}`);
        }
    }
    saveState();
}

// ────────────────────────────────────────────────────────────────────────────
//  MAIN STRATEGY ENGINE TICK
// ────────────────────────────────────────────────────────────────────────────
export async function tick() {
    // FIX-P1 (Kill Switch): Check emergency kill switch BEFORE the isProcessing lock.
    // A hanging tick must not prevent emergency close from executing.
    if (CONFIG.FORCE_CLOSE_ALL || process.env.FORCE_CLOSE_ALL === "true") {
        log.risk("🚨 EMERGENCY KILL SWITCH (FORCE_CLOSE_ALL=true) ACTIVATED!");
        state.dailyTradingStopped = true;
        if (state.position) {
            log.risk("🚨 Active position detected during emergency. Executing immediate emergency market close...");
            const fallbackPrice = state.indicators?.price || (state.priceHistory && state.priceHistory.length > 0 ? state.priceHistory.at(-1)?.close : 0) || 0;
            await closePosition(fallbackPrice, "EMERGENCY KILL SWITCH ACTIVATED");
        }
        return;
    }

    if (state.isProcessing) {
        log.info("[TICK BLOCK] A tick is already in progress. Skipping overlapping execution.");
        return;
    }
    state.isProcessing = true;
    try {
        state.runCount++;
        log.info(`─── TICK #${state.runCount} ──── Cooldown Left: ${state.cooldownRemaining} candles ───`);

        if (state.cooldownRemaining > 0) {
            state.cooldownRemaining--;
        }

        // 1. Fetch & Warm up Candle Data for both 15m and 1h resolutions (Task 4 Multi-Timeframe)
        const candles = await getMarketData(210, CONFIG.RESOLUTION);
        const candles1h = await getMarketData(60, "1h");
        if (!candles || candles.length < 205 || !candles1h || candles1h.length < 50) {
            log.error("Insufficient market candles available for indicator calculations (15m or 1h MTF). Skipping execution.");
            return;
        }

        state.priceHistory = candles;
        const currentPrice = candles[candles.length - 1].close;
        const currentVolume = candles[candles.length - 1].volume;

        // Periodic Reconciliation of Position and Order structures with live Exchange State (Every Cycle)
        await reconcileExchangeState(currentPrice);

        // 2. Perform Quantitative Calculations (15m Chart Indicators)
        const closes = candles.map(c => c.close);
        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const ema200 = calculateEMA(closes, 200);
        const atr14 = calculateATR(candles, 14);
        const adx14 = calculateADX(candles, 14);
        const vwap = calculateVWAP(candles);
        const volumeSMA20 = calculateVolumeSMA(candles, 20);
        const volumeSMA50 = calculateVolumeSMA(candles, 50);

        const len = candles.length;
        const lastEma20 = ema20[len - 1];
        const lastEma50 = ema50[len - 1];
        const lastEma200 = ema200[len - 1];
        const lastAtr = atr14[len - 1];
        const lastAdx = adx14[len - 1];
        const lastVwap = vwap[len - 1];
        const lastVolSMA20 = volumeSMA20[len - 1];
        const lastVolSMA50 = volumeSMA50[len - 1];

        if (
            lastEma20 === null || lastEma50 === null || lastEma200 === null ||
            lastAtr === null || lastAdx === null || lastVwap === null || 
            lastVolSMA20 === null || lastVolSMA50 === null ||
            isNaN(lastEma20) || isNaN(lastEma50) || isNaN(lastEma200) ||
            isNaN(lastAtr) || isNaN(lastAdx) || isNaN(lastVwap)
        ) {
            log.info("Indicators still building warmup values. Awaiting next cycle.");
            return;
        }

        // Adaptive Volume Spike (Task 5: max(1.5 x SMA20, 1.2 x SMA50))
        const adaptiveVolThreshold = Math.max(1.5 * lastVolSMA20, 1.2 * lastVolSMA50);
        const isVolumeSpike = currentVolume > adaptiveVolThreshold;

        const minAtrThreshold = currentPrice * CONFIG.MIN_ATR_PCT;
        const isAtrValid = lastAtr > minAtrThreshold;

        // FIX-P1-7: EMA200 slope computed over 10 candles (was 3) to reduce noise-driven regime flips.
        // 4-candle window on a slow-moving 200-EMA produced sub-cent slope values, causing BULL/NEUTRAL
        // oscillation within the same trend. 10-candle window ≈ 2.5h on 15m — still responsive to
        // genuine trend changes while filtering micro-jitter.
        const prevEma200 = ema200[len - 11];
        if (prevEma200 === null || isNaN(prevEma200)) {
            log.info("EMA200 slope reference not yet ready (insufficient candle history). Awaiting next cycle.");
            return;
        }
        const ema200Slope = lastEma200 - prevEma200;

        // ADX rising for last 3 candles (Task 6)
        const isAdxRising = lastAdx > adx14[len - 2] && adx14[len - 2] > adx14[len - 3] && adx14[len - 3] > adx14[len - 4];

        // Calculate 1h Confirmation (Task 4)
        const closes1h = candles1h.map(c => c.close);
        const ema20_1h = calculateEMA(closes1h, 20);
        const ema50_1h = calculateEMA(closes1h, 50);
        const lastEma20_1h = ema20_1h[candles1h.length - 1];
        const lastEma50_1h = ema50_1h[candles1h.length - 1];
        const lastPrice1h = closes1h[candles1h.length - 1];

        const is1hBullish = lastEma20_1h > lastEma50_1h && lastPrice1h > lastEma50_1h;
        const is1hBearish = lastEma20_1h < lastEma50_1h && lastPrice1h < lastEma50_1h;

        // Combine 15m and 1h for multi-timeframe bull/bear regime
        let marketRegime = "NEUTRAL";
        if (lastEma20 > lastEma50 && lastEma50 > lastEma200 && ema200Slope > 0 && is1hBullish) {
            marketRegime = "BULL";
        } else if (lastEma20 < lastEma50 && lastEma50 < lastEma200 && ema200Slope < 0 && is1hBearish) {
            marketRegime = "BEAR";
        }
        state.lastMarketRegime = marketRegime;

        state.indicators = {
            price: currentPrice,
            ema20: lastEma20,
            ema50: lastEma50,
            ema200: lastEma200,
            atr: lastAtr,
            adx: lastAdx,
            vwap: lastVwap,
            volume: currentVolume,
            volumeSma: lastVolSMA20,
            isVolumeSpike,
            isAtrValid,
            ema200Slope,
            isAdxRising,
            is1hBullish,
            is1hBearish
        };

        log.info(`REGIME: ${marketRegime} | Price: $${currentPrice.toFixed(2)} | VWAP: $${lastVwap.toFixed(2)} | ADX: ${lastAdx.toFixed(1)} (Rising: ${isAdxRising ? "YES" : "NO"}) | Slope200: ${ema200Slope.toFixed(4)} | Vol Spike: ${isVolumeSpike ? "YES" : "NO"}`);

        // Track state of existing position
        if (state.position) {
            const { side, entryPrice, stopLoss, tp1, tp2, size, atr, tp1Done, tp2Done, tp1Size, tp2Size, tp3Size, stopLossOrderId } = state.position;

            state.position.highestPrice = Math.max(state.position.highestPrice || entryPrice, currentPrice);
            state.position.lowestPrice = Math.min(state.position.lowestPrice || entryPrice, currentPrice);

            const priceDifference = side === "buy" ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
            const profitATR = priceDifference / atr;

            log.info(`Active Trade: ${side.toUpperCase()} ${size} contracts | Progress: ${profitATR.toFixed(2)} ATR | SL: $${stopLoss.toFixed(2)} | TP1: $${tp1.toFixed(2)} | TP2: $${tp2.toFixed(2)}`);

            let currentSl = stopLoss;

            // Break-even (At 1 ATR profit, pull SL to entry)
            if (profitATR >= 1.0) {
                currentSl = side === "buy" ? Math.max(currentSl, entryPrice) : Math.min(currentSl, entryPrice);
            }

            // Profit Locking (At 2 ATR profit, lock in 1 ATR)
            if (profitATR >= 2.0) {
                currentSl = side === "buy" ? Math.max(currentSl, entryPrice + (1.0 * atr)) : Math.min(currentSl, entryPrice - (1.0 * atr));
            }

            // Adaptive Trailing Stop based on profit milestones (Task 9)
            let trailMultiplier = 1.5;
            if (profitATR >= 5.0) {
                trailMultiplier = 0.75;
            } else if (profitATR >= 3.0) {
                trailMultiplier = 1.0;
            } else {
                trailMultiplier = 1.5;
            }

            if (side === "buy") {
                const trailingSl = state.position.highestPrice - (trailMultiplier * atr);
                currentSl = Math.max(currentSl, trailingSl);
            } else {
                const trailingSl = state.position.lowestPrice + (trailMultiplier * atr);
                currentSl = Math.min(currentSl, trailingSl);
            }

            if (Math.abs(currentSl - stopLoss) > 0.05) {
                await syncAndTrackStopLossUpdate(currentSl);
            }

            // ────────────────────────────────────────────────────────────────────
            //  TIERED SPLIT EXITS (Task 8 & 12: 40% TP1, 40% TP2, 20% Runner)
            // ────────────────────────────────────────────────────────────────────
            // Retrieve open orders to check if limit TP is active on book
            const openOrders = CONFIG.PAPER_TRADING ? [] : await getOpenOrders();

            // Tier 1: TP1 @ 2 ATR (40% position close)
            if (profitATR >= 2.0 && !tp1Done && tp1Size >= 1) {
                const exitSide = side === "buy" ? "sell" : "buy";
                if (CONFIG.PAPER_TRADING) {
                    log.info(`[TP1 TRIGGER] (Paper) Locking 40% target profit at $${tp1.toFixed(2)} (${tp1Size} contracts)...`);
                    const order = await placeOrder(exitSide, tp1Size, "market_order", null, "TP1 Exit at 2 ATR");
                    if (order) {
                        const fillPrice = parseFloat(order.avg_fill_price || currentPrice);
                        const partialPnl = side === "buy"
                            ? tp1Size * MARKET_SPECS.contractSize * (fillPrice - entryPrice)
                            : tp1Size * MARKET_SPECS.contractSize * (entryPrice - fillPrice);

                        state.dailyPnL += partialPnl;
                        state.paperBalance += partialPnl;

                        state.tradeHistory.push({
                            id: Math.random().toString(36).substring(2, 9),
                            side,
                            entryPrice,
                            exitPrice: fillPrice,
                            size: tp1Size,
                            pnl: partialPnl,
                            result: "win",
                            timestamp: Date.now(),
                            tag: "TP1 Partial Exit"
                        });

                        state.position.size -= tp1Size;
                        state.position.tp1Done = true;
                        log.info(`[TP1 COMPLETE] Scaled out ${tp1Size} contracts @ $${fillPrice.toFixed(2)}.`);
                    }
                } else {
                    // Live trading limit checker - uses passive reconciliation. Rescue if Limit order GONE.
                    const tp1Exists = openOrders && openOrders.some(o => o.id === state.position.tp1OrderId);
                    if (!tp1Exists) {
                        log.risk(`[TP1 TRIGGER] (Live Rescue) Passed 2 ATR TP1 but on-exchange Limit order was missing. Triggering rescue market fill...`);
                        const order = await placeOrder(exitSide, tp1Size, "market_order", null, "TP1 Rescue Exit");
                        if (order) {
                            const fillPrice = parseFloat(order.avg_fill_price || currentPrice);
                            const partialPnl = side === "buy"
                                ? tp1Size * MARKET_SPECS.contractSize * (fillPrice - entryPrice)
                                : tp1Size * MARKET_SPECS.contractSize * (entryPrice - fillPrice);

                            state.dailyPnL += partialPnl;
                            state.tradeHistory.push({
                                id: Math.random().toString(36).substring(2, 9),
                                side,
                                entryPrice,
                                exitPrice: fillPrice,
                                size: tp1Size,
                                pnl: partialPnl,
                                result: "win",
                                timestamp: Date.now(),
                                tag: "TP1 Partial Exit (Rescue)"
                            });

                            state.position.size -= tp1Size;
                            state.position.tp1Done = true;

                            if (state.position.stopLossOrderId) {
                                await cancelOrder(state.position.stopLossOrderId);
                                const slOrder = await placeOrder(exitSide, state.position.size, "stop_market_order", null, "SL Sync after TP1 Rescue", state.position.stopLoss);
                                if (slOrder) {
                                    state.position.stopLossOrderId = slOrder.id;
                                }
                            }
                        }
                    }
                }
            }

            // Tier 2: TP2 @ 4 ATR (40% position close)
            if (profitATR >= 4.0 && !tp2Done && tp2Size >= 1) {
                const exitSide = side === "buy" ? "sell" : "buy";
                if (CONFIG.PAPER_TRADING) {
                    log.info(`[TP2 TRIGGER] (Paper) Locking 40% target profit at $${tp2.toFixed(2)} (${tp2Size} contracts)...`);
                    const order = await placeOrder(exitSide, tp2Size, "market_order", null, "TP2 Exit at 4 ATR");
                    if (order) {
                        const fillPrice = parseFloat(order.avg_fill_price || currentPrice);
                        const partialPnl = side === "buy"
                            ? tp2Size * MARKET_SPECS.contractSize * (fillPrice - entryPrice)
                            : tp2Size * MARKET_SPECS.contractSize * (entryPrice - fillPrice);

                        state.dailyPnL += partialPnl;
                        state.paperBalance += partialPnl;

                        state.tradeHistory.push({
                            id: Math.random().toString(36).substring(2, 9),
                            side,
                            entryPrice,
                            exitPrice: fillPrice,
                            size: tp2Size,
                            pnl: partialPnl,
                            result: "win",
                            timestamp: Date.now(),
                            tag: "TP2 Partial Exit"
                        });

                        state.position.size -= tp2Size;
                        state.position.tp2Done = true;
                        log.info(`[TP2 COMPLETE] Scaled out ${tp2Size} contracts @ $${fillPrice.toFixed(2)}.`);
                    }
                } else {
                    // Live trading limit checker - rescue if Limit order GONE.
                    const tp2Exists = openOrders && openOrders.some(o => o.id === state.position.tp2OrderId);
                    if (!tp2Exists) {
                        log.risk(`[TP2 TRIGGER] (Live Rescue) Passed 4 ATR TP2 but on-exchange Limit order was missing. Triggering rescue market fill...`);
                        const order = await placeOrder(exitSide, tp2Size, "market_order", null, "TP2 Rescue Exit");
                        if (order) {
                            const fillPrice = parseFloat(order.avg_fill_price || currentPrice);
                            const partialPnl = side === "buy"
                                ? tp2Size * MARKET_SPECS.contractSize * (fillPrice - entryPrice)
                                : tp2Size * MARKET_SPECS.contractSize * (entryPrice - fillPrice);

                            state.dailyPnL += partialPnl;
                            state.tradeHistory.push({
                                id: Math.random().toString(36).substring(2, 9),
                                side,
                                entryPrice,
                                exitPrice: fillPrice,
                                size: tp2Size,
                                pnl: partialPnl,
                                result: "win",
                                timestamp: Date.now(),
                                tag: "TP2 Partial Exit (Rescue)"
                            });

                            state.position.size -= tp2Size;
                            state.position.tp2Done = true;

                            if (state.position.stopLossOrderId) {
                                await cancelOrder(state.position.stopLossOrderId);
                                const slOrder = await placeOrder(exitSide, state.position.size, "stop_market_order", null, "SL Sync after TP2 Rescue", state.position.stopLoss);
                                if (slOrder) {
                                    state.position.stopLossOrderId = slOrder.id;
                                }
                            }
                        }
                    }
                }
            }

            // Check Exit Targets (Emergency AWS local triggers or trailing SL triggers)
            let triggerExit = false;
            let exitReason = "";

            if (side === "buy") {
                if (currentPrice <= state.position.stopLoss) {
                    triggerExit = true;
                    exitReason = "Stop Loss Hit";
                }
            } else {
                if (currentPrice >= state.position.stopLoss) {
                    triggerExit = true;
                    exitReason = "Stop Loss Hit";
                }
            }

            if (triggerExit) {
                await closePosition(currentPrice, exitReason);
            }

            return; // Skip new entry checks while in position
        }

        // ────────────────────────────────────────────────────────────────────────
        //  NEW ENTRIES
        // ────────────────────────────────────────────────────────────────────────
        if (state.dailyTradingStopped) {
            log.risk("Daily trading limits activated. Execution halted.");
            return;
        }

        if (state.cooldownRemaining > 0) {
            return; // Still cooling down after closing trade
        }

        const currentBalance = await getAccountBalance();

        // FIX-P1-5 (guard): If balance fetch returned 0 on a live account, skip entry entirely
        if (!CONFIG.PAPER_TRADING && currentBalance <= 0) {
            log.risk("[BALANCE GUARD] Live balance is 0 or unavailable. Skipping entry to prevent phantom sizing.");
            return;
        }

        const tradeSize = calculatePositionSize(currentBalance, currentPrice, lastAtr);

        if (tradeSize <= 0) {
            log.info(`[RISK FILTER] Safe Trade size is 0 (Due to discretization or ATR size inflation on small balance). Entry skipped.`);
            return;
        }

        // Fee Filter Sizing Checks (Expected Profit must exceed 6x Fees, Requirement 2)
        // Expected dynamic profit = average weighted TP target exit of 3.4 ATR units
        const expectedProfit = tradeSize * MARKET_SPECS.contractSize * 3.4 * lastAtr;
        const estimatedFees = tradeSize * MARKET_SPECS.contractSize * currentPrice * CONFIG.ROUNDTRIP_FEE_RATE;

        // FIX-P1-4: Pre-trade daily loss check — verify this trade's worst-case loss won't breach
        // the daily loss limit before opening. The post-close check catches it retroactively but
        // a single oversized loss can blow past the limit in one candle without this guard.
        const potentialLoss = tradeSize * MARKET_SPECS.contractSize * 1.5 * lastAtr;
        const effectiveBalance = CONFIG.PAPER_TRADING ? state.paperBalance : currentBalance;
        const maxDailyLossAllowed = effectiveBalance * CONFIG.MAX_DAILY_LOSS_PCT;
        if (state.dailyPnL - potentialLoss < -maxDailyLossAllowed) {
            log.risk(`[PRE-TRADE RISK] Potential loss of $${potentialLoss.toFixed(4)} would breach daily loss limit ($${maxDailyLossAllowed.toFixed(4)}). Skipping entry.`);
            return;
        }

        // Formulate Reason for Entry Passed/Failed (Requirement 8)
        let passed = false;
        let failReason = [];

        if (marketRegime === "NEUTRAL") {
            failReason.push("Market Regime is Neutral (Trend indicators require BULL or BEAR regime)");
        } else {
            if (lastAdx <= 25.0) failReason.push(`ADX is too low (${lastAdx.toFixed(1)} <= 25.0)`);
            if (!isAdxRising) failReason.push("ADX direction is not rising (last 3 candles down/flat)");
            if (!isVolumeSpike) failReason.push(`No Volume Spike: Volume ${currentVolume.toFixed(0)} <= Dynamic Threshold ${adaptiveVolThreshold.toFixed(0)}`);
            if (!isAtrValid) failReason.push(`ATR is invalid / too low (${lastAtr.toFixed(4)} <= ${minAtrThreshold.toFixed(4)})`);
            
            if (marketRegime === "BULL") {
                if (currentPrice <= lastVwap) {
                    failReason.push(`Price ($${currentPrice.toFixed(2)}) is <= VWAP ($${lastVwap.toFixed(2)}) for Long`);
                } else if (expectedProfit < 6.0 * estimatedFees) {
                    failReason.push(`Fee Filter Blocked: Expected Profit ($${expectedProfit.toFixed(3)}) < 6x Fees ($${(6.0 * estimatedFees).toFixed(3)})`);
                } else {
                    passed = true;
                }
            } else if (marketRegime === "BEAR") {
                if (currentPrice >= lastVwap) {
                    failReason.push(`Price ($${currentPrice.toFixed(2)}) is >= VWAP ($${lastVwap.toFixed(2)}) for Short`);
                } else if (expectedProfit < 6.0 * estimatedFees) {
                    failReason.push(`Fee Filter Blocked: Expected Profit ($${expectedProfit.toFixed(3)}) < 6x Fees ($${(6.0 * estimatedFees).toFixed(3)})`);
                } else {
                    passed = true;
                }
            }
        }

        const reasonStr = passed 
            ? `Passed: ${marketRegime} Entry conditions met.` 
            : `Failed: ${failReason.join(". ")}`;

        log.info(`[DECISION JOURNAL] Sizing & Filter Checks:
        - Current Trade Size: ${tradeSize} Contracts
        - Expected Profit: $${expectedProfit.toFixed(4)} USD
        - Expected Fees: $${estimatedFees.toFixed(4)} USD
        - ATR: ${lastAtr.toFixed(4)} (Min Threshold: ${minAtrThreshold.toFixed(4)})
        - Entry Result: ${reasonStr}`);

        if (passed) {
            if (marketRegime === "BULL") {
                await openPosition("buy", tradeSize, currentPrice, currentPrice - (1.5 * lastAtr), currentPrice + (3.4 * lastAtr), lastAtr, "BULL TREND ENTER");
            } else if (marketRegime === "BEAR") {
                await openPosition("sell", tradeSize, currentPrice, currentPrice + (1.5 * lastAtr), currentPrice - (3.4 * lastAtr), lastAtr, "BEAR TREND ENTER");
            }
        }
    } catch (err) {
        log.error("Unhandled tick cycle execution crash:", err.message);
    } finally {
        state.isProcessing = false;
        saveState(); // Ensure state persistence is consistently preserved
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  DAILY LIFECYCLE
// ────────────────────────────────────────────────────────────────────────────
export function scheduleDailyReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const msUntilMidnight = midnight - now;

    setTimeout(() => {
        log.info("=== Standard daily cycle reset — resetting loss & trade bounds ===");
        state.dailyPnL = 0;
        state.consecutiveLosses = 0;
        state.dailyTradingStopped = false;
        scheduleDailyReset();
    }, msUntilMidnight);
}

export function printBanner() {
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║     DELTA AUTO-QUANT TRADER — SENIOR VOLATILITY ENGINE     ║");
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log(`║ Symbol: ${CONFIG.SYMBOL.padEnd(51)}║`);
    console.log(`║ Core Balance: $${String(CONFIG.ACCOUNT_SIZE).padEnd(46)}║`);
    console.log(`║ Resolution: ${CONFIG.RESOLUTION.padEnd(47)}║`);
    console.log(`║ Trade Risk Margin: ${(CONFIG.RISK_PCT * 100).toFixed(1).padEnd(41)}%║`);
    console.log(`║ Daily Limit Drawdown: ${(CONFIG.MAX_DAILY_LOSS_PCT * 100).toFixed(1).padEnd(38)}%║`);
    console.log(`║ Mode Setup: ${String(CONFIG.PAPER_TRADING ? "PAPER" : "LIVE-TESTNET").padEnd(48)}║`);
    console.log("╚════════════════════════════════════════════════════════════╝");
}

export async function recoverLivePositionOnStart() {
    if (CONFIG.PAPER_TRADING) {
        log.info("Paper trading mode active. Skipping live exchange position recovery checks.");
        return;
    }
    try {
        log.info("Checking Delta Exchange for open positions to recover...");
        // Match Delta margined open positions endpoint pattern
        const path = "/v2/positions/margined";
        const res = await deltaRequest("GET", path);
        if (res && res.result && Array.isArray(res.result)) {
            const match = res.result.find(p => p.symbol === CONFIG.SYMBOL && Math.abs(parseFloat(p.size)) > 0);
            if (match) {
                const liveSize = Math.abs(parseInt(match.size, 10));
                const side = parseInt(match.size, 10) > 0 ? "buy" : "sell";
                
                // Get accurate entry price from fills history (fully resilient fallback chain)
                let entryPrice = await getExactEntryPriceFromFills(side, liveSize);
                if (!entryPrice) {
                    entryPrice = parseFloat(match.entry_price || match.avg_entry_price || match.liquidation_price || 0);
                }
                
                const currentPrice = parseFloat(match.mark_price || match.last_price || entryPrice || 0);
                if (entryPrice <= 0) {
                    entryPrice = currentPrice;
                }

                log.risk(`[AWS RECOVERY] Detected live, orphaned open position: ${side.toUpperCase()} ${liveSize} contracts @ $${entryPrice.toFixed(2)}.`);

                // Warm up candles to extract proper ATR context
                const candles = await getMarketData(50, CONFIG.RESOLUTION);
                const atr = (candles && candles.length >= 15) ? calculateATR(candles, 14).at(-1) : currentPrice * 0.01;

                const slDistance = 1.5 * atr;
                const stopLoss = side === "buy" ? entryPrice - slDistance : entryPrice + slDistance;
                const tp1 = side === "buy" ? entryPrice + 2.0 * atr : entryPrice - 2.0 * atr;
                const tp2 = side === "buy" ? entryPrice + 4.0 * atr : entryPrice - 4.0 * atr;

                const tp1Size = Math.floor(liveSize * 0.40);
                const tp2Size = Math.floor(liveSize * 0.40);
                const tp3Size = liveSize - tp1Size - tp2Size;

                state.position = {
                    side,
                    entryPrice,
                    stopLoss,
                    tp1,
                    tp2,
                    size: liveSize,
                    initialSize: liveSize,
                    tp1Done: false,
                    tp2Done: false,
                    tp1Size,
                    tp2Size,
                    tp3Size,
                    highestPrice: Math.max(entryPrice, currentPrice),
                    lowestPrice: Math.min(entryPrice, currentPrice),
                    atr,
                    openedAt: Date.now(),
                    stopLossOrderId: null,
                    tp1OrderId: null,
                    tp2OrderId: null
                };

                // Link live on-exchange open orders to state tracker
                const openOrders = await getOpenOrders();
                if (openOrders && openOrders.length > 0) {
                    const stopSide = side === "buy" ? "sell" : "buy";
                    const slOrder = openOrders.find(o => o.order_type === "stop_market_order" && o.side === stopSide);
                    if (slOrder) {
                        state.position.stopLossOrderId = slOrder.id;
                        log.info(`[AWS RECOVERY] Linked active Exchange Stop Loss Order ID: ${slOrder.id}`);
                    }
                    const tp1Order = openOrders.find(o => o.order_type === "limit_order" && o.side === stopSide && Math.abs(parseFloat(o.limit_price) - tp1) < 5.0);
                    if (tp1Order) {
                        state.position.tp1OrderId = tp1Order.id;
                        log.info(`[AWS RECOVERY] Linked active Exchange TP1 Order ID: ${tp1Order.id}`);
                    }
                    const tp2Order = openOrders.find(o => o.order_type === "limit_order" && o.side === stopSide && Math.abs(parseFloat(o.limit_price) - tp2) < 5.0 && o.id !== state.position.tp1OrderId);
                    if (tp2Order) {
                        state.position.tp2OrderId = tp2Order.id;
                        log.info(`[AWS RECOVERY] Linked active Exchange TP2 Order ID: ${tp2Order.id}`);
                    }
                }

                log.info(`[AWS RECOVERY] State reconstructed successfully. SL: $${stopLoss.toFixed(2)} | TP1: $${tp1.toFixed(2)} | TP2: $${tp2.toFixed(2)}`);
            } else {
                log.info("No active open live positions found on Delta Exchange. Clean start.");
            }
        }
    } catch (e) {
        log.error("Failed to execute Live Position recovery on start:", e.message);
    }
}

let tickerIntervalId = null;

export async function startBot() {
    printBanner();
    loadState(); // Restore state from state.json (Requirement 3)
    scheduleDailyReset();
    await fetchAndVerifyMarketSpecs();
    
    // Execute live recovery from server crashes (Task 13)
    await recoverLivePositionOnStart();

    await tick();
    tickerIntervalId = setInterval(tick, CONFIG.CANDLE_INTERVAL_MS);
    log.info(`Bot strategy loop successfully started on interval: ${CONFIG.CANDLE_INTERVAL_MS / 1000}s`);
}

export function stopBot() {
    if (tickerIntervalId) {
        clearInterval(tickerIntervalId);
        tickerIntervalId = null;
        log.info("Bot strategy loop successfully stopped.");
    }
}

// Run bot directly if script is called via Node
const isDirectRun = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("strategy.js");
if (isDirectRun) {
    startBot().catch(err => {
        log.error("Unhandled engine error in loop cycle. Crashing process.", err);
        process.exit(1);
    });
}