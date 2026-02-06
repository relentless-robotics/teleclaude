/**
 * Shared Brain - Central intelligence hub for all trading agents
 *
 * Every agent reads from and writes to this shared context.
 * Resets at the start of each trading day.
 * Persists to daily_context.json so agents can pick up where others left off.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONTEXT_FILE = path.join(DATA_DIR, 'daily_context.json');
const HISTORY_DIR = path.join(DATA_DIR, 'daily_history');

// Ensure dirs exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getTimeET() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

/**
 * Default empty context for a new trading day
 */
function createFreshContext() {
  return {
    date: getTodayET(),
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),

    // Pre-market intel (written by overnight + pre-market agents)
    overnight: {
      futures: {},         // { 'S&P 500': { price, change, direction } }
      globalMarkets: {},   // { Asia: [...], Europe: [...] }
      crypto: {},          // { Bitcoin: { price, change } }
      significantMoves: [],
      riskSentiment: null, // 'RISK_ON', 'RISK_OFF', 'NEUTRAL'
      updatedAt: null,
    },

    preMarket: {
      futures: {},
      gappers: [],         // [{ symbol, change, volume, direction }]
      movers: [],          // [{ symbol, price, change, reason }]
      watchlistAlerts: [],  // [{ symbol, type, message }]
      newsHighlights: [],
      updatedAt: null,
    },

    // Market context (updated throughout the day)
    market: {
      indices: {},         // { SPY: { price, change }, QQQ: ... }
      vix: null,
      regime: null,        // 'BULL', 'BEAR', 'CHOPPY', 'TRENDING'
      sectorLeaders: [],
      sectorLaggards: [],
      updatedAt: null,
    },

    // Sentiment data (from StockTwits, Reddit, social)
    sentiment: {
      overall: null,       // 'BULLISH', 'BEARISH', 'NEUTRAL'
      trending: [],        // [{ symbol, sentiment, volume }]
      socialMomentum: [],  // [{ symbol, score, source }]
      updatedAt: null,
    },

    // Catalysts & earnings
    catalysts: {
      earningsToday: [],   // [{ symbol, time, estimate, whisper }]
      earningsThisWeek: [],
      economicEvents: [],  // [{ name, time, impact, forecast, actual }]
      newsBreaking: [],    // [{ headline, symbols, sentiment, time }]
      updatedAt: null,
    },

    // Technical signals (from scans)
    technicals: {
      oversold: [],        // [{ symbol, rsi, price }]
      overbought: [],
      breakouts: [],       // [{ symbol, level, direction }]
      volumeSpikes: [],    // [{ symbol, volumeRatio, price }]
      updatedAt: null,
    },

    // Options flow intel
    optionsFlow: {
      unusualActivity: [], // [{ symbol, type, strike, expiry, volume, oi }]
      putCallRatio: null,
      ivRank: {},          // { symbol: rank }
      updatedAt: null,
    },

    // Active watchlist for the day (combined from all sources)
    dayWatchlist: [],      // [{ symbol, reason, source, entryZone, target, stop, conviction }]

    // Swing trader state
    swingTrader: {
      positions: [],       // [{ symbol, qty, entry, current, pl, thesis }]
      pendingOrders: [],
      signals: [],         // [{ symbol, type, message }]
      account: null,       // { equity, cash, bp }
      updatedAt: null,
    },

    // Day trader state
    dayTrader: {
      positions: [],       // [{ symbol, type, strike, expiry, qty, entry, current, pl }]
      trades: [],          // [{ symbol, action, price, time, reason }]
      pnlToday: 0,
      tradesCount: 0,
      account: null,       // { equity, cash, bp }
      reasoning: [],       // [{ time, thought, decision }] - agent's reasoning log
      updatedAt: null,
    },

    // Agent activity log
    agentLog: [],          // [{ agent, time, action, summary }]
  };
}

/**
 * Load today's context or create fresh
 */
function loadContext() {
  if (fs.existsSync(CONTEXT_FILE)) {
    try {
      const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
      // Check if it's today's context
      if (ctx.date === getTodayET()) {
        return ctx;
      }
      // Archive yesterday's context
      archiveContext(ctx);
    } catch (e) {
      console.error('[SharedBrain] Failed to load context:', e.message);
    }
  }
  // Fresh day
  const fresh = createFreshContext();
  saveContext(fresh);
  return fresh;
}

/**
 * Save context to file
 */
function saveContext(ctx) {
  ctx.lastUpdated = new Date().toISOString();
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

/**
 * Archive a day's context for historical reference
 */
function archiveContext(ctx) {
  const archiveFile = path.join(HISTORY_DIR, `${ctx.date}.json`);
  try {
    fs.writeFileSync(archiveFile, JSON.stringify(ctx, null, 2));
    console.log(`[SharedBrain] Archived context for ${ctx.date}`);
  } catch (e) {
    console.error('[SharedBrain] Archive failed:', e.message);
  }
}

// ============================================================================
// Public API - Read/Write sections of the shared brain
// ============================================================================

class SharedBrain {
  constructor() {
    this._ctx = null;
  }

  /** Get current context (lazy load) */
  get ctx() {
    if (!this._ctx || this._ctx.date !== getTodayET()) {
      this._ctx = loadContext();
    }
    return this._ctx;
  }

  /** Force reload from disk */
  reload() {
    this._ctx = loadContext();
    return this._ctx;
  }

  /** Save current state */
  save() {
    if (this._ctx) saveContext(this._ctx);
  }

  // --- Overnight ---
  writeOvernight(data) {
    Object.assign(this.ctx.overnight, data, { updatedAt: new Date().toISOString() });
    this.logAgent('overnight', 'Updated overnight data');
    this.save();
  }

  // --- Pre-Market ---
  writePreMarket(data) {
    Object.assign(this.ctx.preMarket, data, { updatedAt: new Date().toISOString() });
    this.logAgent('pre-market', 'Updated pre-market data');
    this.save();
  }

  // --- Market Context ---
  writeMarket(data) {
    Object.assign(this.ctx.market, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  // --- Sentiment ---
  writeSentiment(data) {
    Object.assign(this.ctx.sentiment, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  // --- Catalysts ---
  writeCatalysts(data) {
    Object.assign(this.ctx.catalysts, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  // --- Technicals ---
  writeTechnicals(data) {
    Object.assign(this.ctx.technicals, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  // --- Options Flow ---
  writeOptionsFlow(data) {
    Object.assign(this.ctx.optionsFlow, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  // --- Day Watchlist ---
  addToWatchlist(item) {
    // Avoid duplicates
    const existing = this.ctx.dayWatchlist.findIndex(w => w.symbol === item.symbol);
    if (existing >= 0) {
      this.ctx.dayWatchlist[existing] = { ...this.ctx.dayWatchlist[existing], ...item };
    } else {
      this.ctx.dayWatchlist.push(item);
    }
    this.save();
  }

  // --- Swing Trader ---
  writeSwingState(data) {
    Object.assign(this.ctx.swingTrader, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  // --- Day Trader ---
  writeDayTraderState(data) {
    Object.assign(this.ctx.dayTrader, data, { updatedAt: new Date().toISOString() });
    this.save();
  }

  addDayTrade(trade) {
    this.ctx.dayTrader.trades.push({ ...trade, time: new Date().toISOString() });
    this.ctx.dayTrader.tradesCount = this.ctx.dayTrader.trades.length;
    this.save();
  }

  addReasoning(thought, decision) {
    this.ctx.dayTrader.reasoning.push({
      time: getTimeET(),
      thought,
      decision,
    });
    this.save();
  }

  // --- Agent Log ---
  logAgent(agent, action, summary = '') {
    this.ctx.agentLog.push({
      agent,
      time: getTimeET(),
      timestamp: new Date().toISOString(),
      action,
      summary,
    });
    // Keep last 100 entries
    if (this.ctx.agentLog.length > 100) {
      this.ctx.agentLog = this.ctx.agentLog.slice(-100);
    }
  }

  // --- Read helpers ---

  /** Get full snapshot for an agent to consume */
  getFullSnapshot() {
    return { ...this.ctx };
  }

  /** Get compact briefing for day trader reasoning */
  getDayTraderBriefing() {
    const c = this.ctx;
    return {
      date: c.date,
      riskSentiment: c.overnight.riskSentiment,
      futures: c.preMarket.futures || c.overnight.futures,
      gappers: c.preMarket.gappers,
      movers: c.preMarket.movers,
      marketRegime: c.market.regime,
      vix: c.market.vix,
      indices: c.market.indices,
      sentiment: c.sentiment.overall,
      trending: c.sentiment.trending?.slice(0, 10),
      earningsToday: c.catalysts.earningsToday,
      economicEvents: c.catalysts.economicEvents,
      breakingNews: c.catalysts.newsBreaking?.slice(0, 5),
      technicals: {
        oversold: c.technicals.oversold?.slice(0, 10),
        breakouts: c.technicals.breakouts?.slice(0, 10),
        volumeSpikes: c.technicals.volumeSpikes?.slice(0, 10),
      },
      optionsFlow: c.optionsFlow.unusualActivity?.slice(0, 10),
      putCallRatio: c.optionsFlow.putCallRatio,
      dayWatchlist: c.dayWatchlist,
      currentPositions: c.dayTrader.positions,
      todayPnL: c.dayTrader.pnlToday,
      todayTrades: c.dayTrader.tradesCount,
      previousReasoning: c.dayTrader.reasoning?.slice(-5),
    };
  }

  /** Get compact briefing for swing trader */
  getSwingBriefing() {
    const c = this.ctx;
    return {
      date: c.date,
      riskSentiment: c.overnight.riskSentiment,
      futures: c.preMarket.futures || c.overnight.futures,
      movers: c.preMarket.movers,
      marketRegime: c.market.regime,
      vix: c.market.vix,
      sentiment: c.sentiment.overall,
      earningsThisWeek: c.catalysts.earningsThisWeek,
      currentPositions: c.swingTrader.positions,
      signals: c.swingTrader.signals,
    };
  }

  /** Get daily summary for after-hours recap */
  getDailySummary() {
    const c = this.ctx;
    return {
      date: c.date,
      market: c.market,
      swingTrader: c.swingTrader,
      dayTrader: {
        pnl: c.dayTrader.pnlToday,
        trades: c.dayTrader.tradesCount,
        positions: c.dayTrader.positions,
        reasoning: c.dayTrader.reasoning,
      },
      agentLog: c.agentLog,
    };
  }

  /** Check if context has been updated today by a specific section */
  hasData(section) {
    return this.ctx[section]?.updatedAt != null;
  }
}

module.exports = new SharedBrain();
