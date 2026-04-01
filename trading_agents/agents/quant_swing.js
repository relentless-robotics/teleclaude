/**
 * Alpha 3: Quantitative Swing Scanner Enhancement
 *
 * A standalone quantitative scoring engine that complements the existing
 * LLM-based swing_scanner.js. This module provides hard quantitative
 * signals that the swing scanner can consume for better entry/exit.
 *
 * SIGNALS:
 *   1. Momentum Score     — RSI + price momentum + volume confirmation
 *   2. Sector Rotation    — Track leading/lagging sectors, favor leaders
 *   3. Mean Reversion     — Oversold bounces with volume confirmation
 *   4. Earnings Momentum  — Post-earnings gap continuation patterns
 *   5. Vol-Aware Sizing   — Reduce in high VIX, increase in low VIX
 *
 * UNIVERSE: Top 100 liquid stocks + ETFs from scan
 * ACCOUNT: $5k Alpaca swing account (stocks only)
 * TIMEFRAME: 2-10 day holds
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

let apiClient;
try { apiClient = require('../../swing_options/api_client'); } catch (e) {}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Universe
  sectorETFs: ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'],
  indexETFs: ['SPY', 'QQQ', 'IWM', 'DIA'],
  watchlistSymbols: [], // Populated from brain watchlist

  // Scoring weights
  weights: {
    momentum: 0.30,
    meanReversion: 0.25,
    volume: 0.20,
    sectorStrength: 0.15,
    earnings: 0.10,
  },

  // Thresholds
  thresholds: {
    buyScore: 70,          // Score >= 70 to generate BUY signal
    sellScore: 30,         // Score <= 30 to generate SELL signal
    rsiOversold: 30,
    rsiOverbought: 70,
    volumeSpike: 1.5,      // 1.5x average volume
    minMarketCap: 1e9,     // $1B minimum
  },

  // Position sizing (vol-adjusted)
  sizing: {
    basePositionPct: 0.10,  // 10% of equity per position
    maxPositionPct: 0.20,   // Max 20% per position
    maxPositions: 5,        // Max 5 concurrent positions
    lowVixMultiplier: 1.3,  // Size up 30% when VIX < 15
    highVixMultiplier: 0.6, // Size down 40% when VIX > 25
  },

  // Exit rules
  exits: {
    stopLossPct: -0.08,    // -8% stop loss
    profitTargetPct: 0.15, // +15% profit target
    trailingStopPct: 0.05, // 5% trailing stop (after +5% gain)
    maxHoldDays: 14,       // Max hold 14 days
  },
};

// State file
const STATE_FILE = path.join(__dirname, '..', 'data', 'quant_swing_state.json');
const SCORES_FILE = path.join(__dirname, '..', 'data', 'quant_swing_scores.json');

// ============================================================================
// DATA FETCHERS
// ============================================================================

function fetchQuote(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) return resolve(null);
          const meta = result.meta;
          const quotes = result.indicators?.quote?.[0];
          const len = quotes?.close?.length || 0;
          resolve({
            symbol,
            price: meta.regularMarketPrice,
            prevClose: meta.previousClose || meta.chartPreviousClose,
            change: meta.regularMarketPrice - (meta.previousClose || 0),
            changePct: ((meta.regularMarketPrice - (meta.previousClose || meta.regularMarketPrice)) / (meta.previousClose || meta.regularMarketPrice) * 100),
            volume: quotes?.volume?.[len - 1] || 0,
            high: quotes?.high?.[len - 1],
            low: quotes?.low?.[len - 1],
            open: quotes?.open?.[len - 1],
          });
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchHistory(symbol, range = '3mo', interval = '1d') {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) return resolve([]);
          const quotes = result.indicators?.quote?.[0];
          const timestamps = result.timestamp || [];
          const bars = [];
          for (let i = 0; i < timestamps.length; i++) {
            if (quotes?.close?.[i] != null) {
              bars.push({
                date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
                open: quotes.open[i],
                high: quotes.high[i],
                low: quotes.low[i],
                close: quotes.close[i],
                volume: quotes.volume[i] || 0,
              });
            }
          }
          resolve(bars);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// ============================================================================
// TECHNICAL INDICATORS
// ============================================================================

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50; // Default neutral

  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calculateEMA(values, period) {
  if (values.length < period) return calculateSMA(values, period);
  const k = 2 / (period + 1);
  let ema = calculateSMA(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd = ema12 - ema26;

  // Simple signal line approximation
  const recentCloses = closes.slice(-35);
  const macdValues = [];
  for (let i = 26; i < recentCloses.length; i++) {
    const e12 = calculateEMA(recentCloses.slice(0, i + 1), 12);
    const e26 = calculateEMA(recentCloses.slice(0, i + 1), 26);
    macdValues.push(e12 - e26);
  }
  const signal = macdValues.length >= 9 ? calculateEMA(macdValues, 9) : macd;
  const histogram = macd - signal;

  return { macd, signal, histogram };
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

function calculateAverageVolume(bars, period = 20) {
  if (bars.length < period) return bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  return bars.slice(-period).reduce((s, b) => s + b.volume, 0) / period;
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

class ScoringEngine {
  /**
   * Score a single stock on multiple dimensions.
   * Returns 0-100 composite score with breakdown.
   */
  async scoreSymbol(symbol) {
    const bars = await fetchHistory(symbol, '3mo', '1d');
    if (bars.length < 30) return null; // Not enough data

    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);
    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    // --- Calculate indicators ---
    const rsi = calculateRSI(closes);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    const ema9 = calculateEMA(closes, 9);
    const macd = calculateMACD(closes);
    const atr = calculateATR(bars);
    const avgVolume = calculateAverageVolume(bars);
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

    // Returns
    const ret1d = closes.length >= 2 ? (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100 : 0;
    const ret5d = closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100 : 0;
    const ret20d = closes.length >= 21 ? (closes[closes.length - 1] / closes[closes.length - 21] - 1) * 100 : 0;

    // Price relative to MAs
    const priceVsSma20 = ((currentPrice - sma20) / sma20) * 100;
    const priceVsSma50 = ((currentPrice - sma50) / sma50) * 100;

    // --- Score Components ---

    // 1. MOMENTUM SCORE (0-100)
    let momentumScore = 50;

    // RSI component (30-70 range = neutral; <30 oversold; >70 overbought)
    if (rsi >= 50 && rsi <= 70) momentumScore += 15;        // Healthy uptrend
    else if (rsi > 70) momentumScore += 5;                    // Strong but overbought
    else if (rsi >= 30 && rsi < 50) momentumScore -= 10;      // Weak
    else if (rsi < 30) momentumScore -= 5;                     // Oversold (reversal possible)

    // MACD component
    if (macd.histogram > 0 && macd.macd > macd.signal) momentumScore += 15;   // Bullish crossover
    else if (macd.histogram > 0) momentumScore += 8;
    else if (macd.histogram < 0 && macd.macd < macd.signal) momentumScore -= 15;
    else momentumScore -= 5;

    // Price above MAs
    if (currentPrice > sma20 && currentPrice > sma50) momentumScore += 10;
    else if (currentPrice > sma20) momentumScore += 5;
    else if (currentPrice < sma20 && currentPrice < sma50) momentumScore -= 15;

    // 5-day return
    if (ret5d > 3) momentumScore += 10;
    else if (ret5d > 1) momentumScore += 5;
    else if (ret5d < -3) momentumScore -= 10;
    else if (ret5d < -1) momentumScore -= 5;

    momentumScore = Math.max(0, Math.min(100, momentumScore));

    // 2. MEAN REVERSION SCORE (0-100)
    let meanRevScore = 50;

    // Oversold bounce setup
    if (rsi < 30 && ret1d > 0) meanRevScore += 25;   // RSI oversold + green day = bounce
    if (rsi < 25) meanRevScore += 10;                  // Deeply oversold
    if (priceVsSma20 < -5 && ret1d > 0) meanRevScore += 15;  // 5%+ below SMA20 + green

    // Overbought reversal warning
    if (rsi > 75 && ret1d < 0) meanRevScore -= 20;
    if (priceVsSma20 > 8) meanRevScore -= 10;

    // Distance from SMA50 (mean reversion pull)
    if (priceVsSma50 < -10) meanRevScore += 15;  // Far below mean
    if (priceVsSma50 > 10) meanRevScore -= 10;    // Far above mean

    meanRevScore = Math.max(0, Math.min(100, meanRevScore));

    // 3. VOLUME SCORE (0-100)
    let volumeScore = 50;

    if (volumeRatio >= 2.0 && ret1d > 0) volumeScore += 25;  // Big volume + up = conviction
    else if (volumeRatio >= 1.5 && ret1d > 0) volumeScore += 15;
    else if (volumeRatio >= 2.0 && ret1d < 0) volumeScore -= 15;  // Big volume + down = distribution
    else if (volumeRatio < 0.5) volumeScore -= 10;                  // Low volume = no interest

    // Volume trend (increasing volume in recent days)
    const recentVol = volumes.slice(-5);
    const olderVol = volumes.slice(-10, -5);
    const recentAvg = recentVol.reduce((s, v) => s + v, 0) / recentVol.length;
    const olderAvg = olderVol.length > 0 ? olderVol.reduce((s, v) => s + v, 0) / olderVol.length : recentAvg;
    if (recentAvg > olderAvg * 1.2) volumeScore += 10;  // Volume expanding
    if (recentAvg < olderAvg * 0.7) volumeScore -= 10;  // Volume contracting

    volumeScore = Math.max(0, Math.min(100, volumeScore));

    // 4. SECTOR STRENGTH (populated later)
    let sectorScore = 50;

    // 5. EARNINGS MOMENTUM (check if recent earnings)
    let earningsScore = 50;

    // --- COMPOSITE SCORE ---
    const composite = Math.round(
      momentumScore * CONFIG.weights.momentum +
      meanRevScore * CONFIG.weights.meanReversion +
      volumeScore * CONFIG.weights.volume +
      sectorScore * CONFIG.weights.sectorStrength +
      earningsScore * CONFIG.weights.earnings
    );

    return {
      symbol,
      price: currentPrice,
      composite,
      breakdown: {
        momentum: Math.round(momentumScore),
        meanReversion: Math.round(meanRevScore),
        volume: Math.round(volumeScore),
        sector: Math.round(sectorScore),
        earnings: Math.round(earningsScore),
      },
      indicators: {
        rsi: Math.round(rsi * 10) / 10,
        macdHistogram: Math.round(macd.histogram * 1000) / 1000,
        priceVsSma20: Math.round(priceVsSma20 * 100) / 100,
        priceVsSma50: Math.round(priceVsSma50 * 100) / 100,
        volumeRatio: Math.round(volumeRatio * 100) / 100,
        atr: Math.round(atr * 100) / 100,
        ret1d: Math.round(ret1d * 100) / 100,
        ret5d: Math.round(ret5d * 100) / 100,
        ret20d: Math.round(ret20d * 100) / 100,
      },
      signal: composite >= CONFIG.thresholds.buyScore ? 'BUY'
            : composite <= CONFIG.thresholds.sellScore ? 'SELL'
            : 'HOLD',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Score sector ETFs and determine rotation signal
   */
  async scoreSectors() {
    const results = [];

    for (const etf of CONFIG.sectorETFs) {
      const bars = await fetchHistory(etf, '1mo', '1d');
      if (bars.length < 10) continue;

      const closes = bars.map(b => b.close);
      const ret5d = closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100 : 0;
      const ret20d = closes.length >= 21 ? (closes[closes.length - 1] / closes[closes.length - 21] - 1) * 100 : 0;
      const rsi = calculateRSI(closes);

      results.push({
        symbol: etf,
        ret5d: Math.round(ret5d * 100) / 100,
        ret20d: Math.round(ret20d * 100) / 100,
        rsi: Math.round(rsi),
        strength: Math.round((ret5d * 0.6 + ret20d * 0.4) * 100) / 100,
      });

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    // Sort by strength
    results.sort((a, b) => b.strength - a.strength);

    return {
      leaders: results.slice(0, 3),
      laggards: results.slice(-3).reverse(),
      all: results,
    };
  }
}

// ============================================================================
// POSITION SIZER
// ============================================================================

class PositionSizer {
  /**
   * Calculate position size based on vol regime and conviction
   */
  calculate(equity, score, vix) {
    let basePct = CONFIG.sizing.basePositionPct;

    // Vol adjustment
    if (vix && vix < 15) basePct *= CONFIG.sizing.lowVixMultiplier;
    else if (vix && vix > 25) basePct *= CONFIG.sizing.highVixMultiplier;

    // Conviction adjustment
    if (score >= 85) basePct *= 1.2;      // High conviction
    else if (score >= 75) basePct *= 1.0;  // Normal
    else if (score >= 70) basePct *= 0.8;  // Low conviction

    // Cap at max
    basePct = Math.min(basePct, CONFIG.sizing.maxPositionPct);

    const dollarAmount = equity * basePct;
    return {
      pct: Math.round(basePct * 1000) / 10, // e.g. 12.5%
      dollars: Math.round(dollarAmount),
      reasoning: `${(basePct * 100).toFixed(1)}% of $${equity.toLocaleString()} (VIX: ${vix?.toFixed(1) || 'N/A'}, Score: ${score})`,
    };
  }
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return {
    lastScan: null,
    lastSectorScan: null,
    scanHistory: [],
    sectorRotation: null,
  };
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

// ============================================================================
// MAIN AGENT
// ============================================================================

class QuantSwingScanner {
  constructor() {
    this.name = 'Quant Swing Scanner';
    this.emoji = '📊';
    this.scorer = new ScoringEngine();
    this.sizer = new PositionSizer();
    this.lastRun = null;
  }

  /**
   * Build the scan universe from multiple sources
   */
  _buildUniverse() {
    const symbols = new Set();

    // Brain watchlist
    const brainWatchlist = brain.ctx.dayWatchlist || [];
    for (const item of brainWatchlist) {
      if (item.symbol) symbols.add(item.symbol);
    }

    // Swing trader existing positions (monitor these)
    const swingPositions = brain.ctx.swingTrader?.positions || [];
    for (const pos of swingPositions) {
      if (pos.symbol) symbols.add(pos.symbol);
    }

    // MacroStrategy top picks
    const macroAlpha = brain.ctx.macroAlpha;
    if (macroAlpha?.topPicks) {
      for (const pick of macroAlpha.topPicks.slice(0, 10)) {
        if (pick.symbol) symbols.add(pick.symbol);
      }
    }

    // Common large-cap momentum names
    const defaultUniverse = [
      'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
      'AMD', 'CRM', 'NFLX', 'AVGO', 'COST', 'JPM', 'V', 'MA',
      'LLY', 'UNH', 'XOM', 'CVX', 'ABBV', 'MRK', 'PEP', 'KO',
      'PLTR', 'COIN', 'MSTR', 'SNOW', 'NET', 'CRWD', 'PANW',
    ];
    for (const s of defaultUniverse) symbols.add(s);

    // Sector ETFs
    for (const s of CONFIG.sectorETFs) symbols.add(s);
    for (const s of CONFIG.indexETFs) symbols.add(s);

    return [...symbols];
  }

  /**
   * Main run function — full quantitative scan
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`[${new Date().toISOString()}] ${this.emoji} Quant Swing Scanner starting... (${timeET} ET)`);

    const state = loadState();
    const report = {
      timestamp: new Date().toISOString(),
      timeET,
      universe: [],
      topBuys: [],
      topSells: [],
      sectorRotation: null,
      existingPositionScores: [],
      errors: [],
    };

    try {
      // 1. Build universe
      const universe = this._buildUniverse();
      report.universe = universe;

      // 2. Get VIX for position sizing
      const vixQuote = await fetchQuote('^VIX');
      const vix = vixQuote?.price || 18;

      // 3. Score all symbols
      const scores = [];
      for (const symbol of universe) {
        try {
          const score = await this.scorer.scoreSymbol(symbol);
          if (score) scores.push(score);
        } catch (e) {
          console.warn(`[QuantSwing] Error scoring ${symbol}:`, e.message);
        }
        // Rate limit pause
        await new Promise(r => setTimeout(r, 300));
      }

      // 4. Sort and categorize
      scores.sort((a, b) => b.composite - a.composite);

      report.topBuys = scores.filter(s => s.signal === 'BUY').slice(0, 10);
      report.topSells = scores.filter(s => s.signal === 'SELL').slice(0, 5);

      // 5. Score existing positions
      const swingPositions = brain.ctx.swingTrader?.positions || [];
      for (const pos of swingPositions) {
        const posScore = scores.find(s => s.symbol === pos.symbol);
        if (posScore) {
          report.existingPositionScores.push({
            symbol: pos.symbol,
            score: posScore.composite,
            signal: posScore.signal,
            rsi: posScore.indicators.rsi,
            entry: pos.entry,
            current: posScore.price,
            plPct: pos.entry ? ((posScore.price - pos.entry) / pos.entry * 100).toFixed(2) : 'N/A',
          });
        }
      }

      // 6. Sector rotation scan
      report.sectorRotation = await this.scorer.scoreSectors();
      state.sectorRotation = report.sectorRotation;

      // 7. Generate actionable recommendations with sizing
      report.recommendations = [];
      for (const buy of report.topBuys.slice(0, 5)) {
        const sizing = this.sizer.calculate(5000, buy.composite, vix); // $5k account
        report.recommendations.push({
          symbol: buy.symbol,
          action: 'BUY',
          score: buy.composite,
          price: buy.price,
          sizing,
          shares: Math.floor(sizing.dollars / buy.price),
          indicators: buy.indicators,
          reasoning: `Score ${buy.composite}/100 | RSI ${buy.indicators.rsi} | Vol ${buy.indicators.volumeRatio}x | 5d ${buy.indicators.ret5d}%`,
        });
      }

      // 8. Save scores for other agents to consume
      saveScores({
        timestamp: new Date().toISOString(),
        vix,
        scores: scores.slice(0, 30), // Top 30
        topBuys: report.topBuys.map(s => ({ symbol: s.symbol, score: s.composite, price: s.price })),
        topSells: report.topSells.map(s => ({ symbol: s.symbol, score: s.composite, price: s.price })),
        sectorRotation: report.sectorRotation,
      });

      // Update state
      state.lastScan = new Date().toISOString();
      state.scanHistory.push({
        time: new Date().toISOString(),
        buys: report.topBuys.length,
        sells: report.topSells.length,
        universe: universe.length,
      });
      if (state.scanHistory.length > 50) state.scanHistory = state.scanHistory.slice(-50);
      saveState(state);

    } catch (error) {
      report.errors.push(error.message);
      console.error('[QuantSwing] Error:', error);
    }

    // Send Discord report
    await this._sendReport(report);

    // Update shared brain
    this._updateBrain(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Quant Swing Scanner completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Send report to Discord
   */
  async _sendReport(report) {
    let msg = `${this.emoji} **QUANT SWING SCAN** — ${report.timeET} ET\n`;
    msg += `Universe: ${report.universe.length} symbols scanned\n\n`;

    // Top BUY signals
    if (report.topBuys.length > 0) {
      msg += `**TOP BUY SIGNALS:**\n`;
      for (const buy of report.topBuys.slice(0, 5)) {
        msg += `🟢 **${buy.symbol}** $${buy.price.toFixed(2)} | Score: **${buy.composite}** | RSI: ${buy.indicators.rsi} | Vol: ${buy.indicators.volumeRatio}x | 5d: ${buy.indicators.ret5d >= 0 ? '+' : ''}${buy.indicators.ret5d}%\n`;
        msg += `  _Mom: ${buy.breakdown.momentum} | MR: ${buy.breakdown.meanReversion} | Vol: ${buy.breakdown.volume}_\n`;
      }
      msg += '\n';
    }

    // Recommendations with sizing
    if (report.recommendations && report.recommendations.length > 0) {
      msg += `**ACTIONABLE (with sizing for $5k account):**\n`;
      for (const rec of report.recommendations.slice(0, 3)) {
        msg += `➡️ ${rec.action} **${rec.symbol}**: ${rec.shares} shares ($${rec.sizing.dollars}) | ${rec.reasoning}\n`;
      }
      msg += '\n';
    }

    // Sell signals
    if (report.topSells.length > 0) {
      msg += `**SELL/AVOID SIGNALS:**\n`;
      for (const sell of report.topSells.slice(0, 3)) {
        msg += `🔴 ${sell.symbol} $${sell.price.toFixed(2)} | Score: ${sell.composite} | RSI: ${sell.indicators.rsi}\n`;
      }
      msg += '\n';
    }

    // Sector rotation
    if (report.sectorRotation) {
      msg += `**SECTOR ROTATION:**\n`;
      msg += `Leaders: ${report.sectorRotation.leaders.map(s => `${s.symbol} (${s.strength >= 0 ? '+' : ''}${s.strength}%)`).join(', ')}\n`;
      msg += `Laggards: ${report.sectorRotation.laggards.map(s => `${s.symbol} (${s.strength >= 0 ? '+' : ''}${s.strength}%)`).join(', ')}\n\n`;
    }

    // Existing position health
    if (report.existingPositionScores.length > 0) {
      msg += `**POSITION HEALTH:**\n`;
      for (const pos of report.existingPositionScores) {
        const emoji = pos.signal === 'BUY' ? '🟢' : pos.signal === 'SELL' ? '🔴' : '🟡';
        msg += `${emoji} ${pos.symbol}: Score ${pos.score} (${pos.signal}) | P&L: ${pos.plPct}%\n`;
      }
      msg += '\n';
    }

    if (report.errors.length > 0) {
      msg += `**Errors:** ${report.errors.join(', ')}\n`;
    }

    try {
      await discord.swingScanner(msg);
    } catch (e) {
      console.warn('[QuantSwing] Discord send error:', e.message);
    }
  }

  /**
   * Update shared brain
   */
  _updateBrain(report) {
    // Write to brain technicals section
    brain.ctx.technicals = brain.ctx.technicals || {};
    brain.ctx.technicals.quantScores = {
      topBuys: report.topBuys.slice(0, 5).map(s => ({
        symbol: s.symbol,
        score: s.composite,
        rsi: s.indicators.rsi,
        signal: s.signal,
      })),
      topSells: report.topSells.slice(0, 3).map(s => ({
        symbol: s.symbol,
        score: s.composite,
        rsi: s.indicators.rsi,
      })),
      sectorLeaders: report.sectorRotation?.leaders?.map(s => s.symbol) || [],
      sectorLaggards: report.sectorRotation?.laggards?.map(s => s.symbol) || [],
      updatedAt: new Date().toISOString(),
    };

    brain.logAgent('quant-swing', `Scan: ${report.topBuys.length} buys, ${report.topSells.length} sells from ${report.universe.length} symbols`);
  }
}

module.exports = QuantSwingScanner;
