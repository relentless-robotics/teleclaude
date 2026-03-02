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

    // MacroStrategy V9 alpha scores (written by v9_macro_loader.js)
    macroAlpha: {
      version: null,         // 'V9'
      predictionDate: null,  // Date the predictions are for
      generatedAt: null,     // When the export was created
      freshness: null,       // { ageDays, isStale, staleDays }
      topPicks: [],          // [{ symbol, alpha, rank, sectorGroup }]
      bottomPicks: [],       // [{ symbol, alpha, rank, sectorGroup }]
      metadata: null,        // { featureCount, universeSize, bestCombo }
      modelInfo: null,       // Full model performance context (from model_info in JSON export)
      scores: {},            // { symbol: { alpha, rank, percentile, quintile, sectorGroup } }
      updatedAt: null,
    },

    // IASM Intraday Alpha Signals (written by iasm_loader.js)
    iasmSignals: {
      timestamp: null,       // When signals were generated
      signals: [],           // [{ symbol, direction, magnitude, confidence, timeframe, expected_return_pct, features, context }]
      model_metrics: {},     // { recent_ic, recent_hit_rate, retrain_date }
      market_context: {},    // { spy_direction, spy_momentum, vix_level, regime }
      freshness: null,       // { ageMinutes, isFresh, isStale }
      updatedAt: null,
    },

    // Failed setups tracker (prevents repeating mistakes)
    failedSetups: [],      // [{ symbol, setupType, reason, timestamp, count }]

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

  // --- MacroStrategy V9 Alpha ---
  writeMacroAlpha(data) {
    // Ensure macroAlpha section exists (for contexts persisted before V9 integration)
    if (!this.ctx.macroAlpha) {
      this.ctx.macroAlpha = {
        version: null, predictionDate: null, generatedAt: null, freshness: null,
        topPicks: [], bottomPicks: [], metadata: null, modelInfo: null,
        scores: {}, updatedAt: null,
      };
    }
    Object.assign(this.ctx.macroAlpha, data, { updatedAt: new Date().toISOString() });
    this.logAgent('v9-macro', `Updated V9 alpha scores (${Object.keys(data.scores || {}).length} symbols)`);
    this.save();
  }

  /**
   * Get macro alpha for specific symbols.
   * @param {string|string[]} symbols - Single symbol or array of symbols
   * @returns {object} { symbol: { alpha, rank, percentile, quintile, sectorGroup } | null }
   */
  getMacroAlpha(symbols) {
    const scores = (this.ctx.macroAlpha && this.ctx.macroAlpha.scores) || {};
    if (typeof symbols === 'string') {
      return scores[symbols] || null;
    }
    const result = {};
    for (const sym of symbols) {
      result[sym] = scores[sym] || null;
    }
    return result;
  }

  /**
   * Check if macro alpha data is available and fresh.
   * @returns {object} { available: bool, isStale: bool, ageDays: number, predictionDate: string }
   */
  getMacroAlphaStatus() {
    const ma = this.ctx.macroAlpha;
    if (!ma || !ma.updatedAt) {
      return { available: false, isStale: true, ageDays: null, predictionDate: null };
    }
    const freshness = ma.freshness || {};
    return {
      available: true,
      isStale: freshness.isStale || false,
      ageDays: freshness.ageDays || null,
      predictionDate: ma.predictionDate || null,
    };
  }

  /**
   * Get full model performance context for LLM prompts.
   * Returns model_info object with raw metrics, execution metrics,
   * audit notes, and interpretation guide for enriched LLM reasoning.
   *
   * @returns {object|null} model_info object or null if unavailable
   */
  getMacroAlphaModelInfo() {
    const ma = this.ctx.macroAlpha;
    if (!ma || !ma.modelInfo) return null;
    return ma.modelInfo;
  }

  /**
   * Format model_info into a concise string block for LLM prompt injection.
   * This provides the LLM with full context on model performance and limitations.
   *
   * @returns {string} Formatted model info block for LLM prompts
   */
  formatModelInfoForLLM() {
    const mi = this.getMacroAlphaModelInfo();
    if (!mi) return '';

    const lines = [];
    lines.push('--- MACROSTRATEGY V9 MODEL PERFORMANCE ---');
    lines.push(`Model: ${mi.version} | OOS Period: ${mi.oos_period}`);
    lines.push(`Best Combo: ${mi.best_combo}`);

    if (mi.execution_metrics) {
      const em = mi.execution_metrics;
      lines.push(`Backtest: ${em.oos_return} return, ${em.sharpe} Sharpe, ${em.max_drawdown} max DD`);
      lines.push(`vs SPY: ${em.vs_spy} outperformance`);
      lines.push(`Monthly: ${em.avg_monthly_return}% avg, ${em.monthly_win_rate}% win rate (${em.positive_months}W/${em.negative_months}L)`);
    }

    if (mi.spy_benchmark) {
      lines.push(`SPY Benchmark: ${mi.spy_benchmark.return} return, ${mi.spy_benchmark.sharpe} Sharpe, ${mi.spy_benchmark.max_drawdown} DD`);
    }

    if (mi.raw_model_metrics) {
      const modelSummary = Object.entries(mi.raw_model_metrics)
        .sort((a, b) => b[1].cv_ic_avg - a[1].cv_ic_avg)
        .map(([k, v]) => `${k}: IC=${v.cv_ic_avg.toFixed(4)}${v.reliable ? '' : ' (weak)'}`)
        .join(', ');
      lines.push(`Model ICs: ${modelSummary}`);
    }

    if (mi.feature_selection) {
      lines.push(`Features: ${mi.feature_selection.selected}/${mi.feature_selection.total_candidates} selected`);
    }

    if (mi.audit_notes && mi.audit_notes.length > 0) {
      lines.push(`Audit: ${mi.audit_notes.length} checks passed. Key: execution config frozen, all leakage vectors fixed.`);
    }

    if (mi.interpretation_guide) {
      lines.push(`Guide: ${mi.interpretation_guide}`);
    }

    return lines.join('\n');
  }

  // --- IASM Intraday Signals ---
  writeIASMSignals(data) {
    if (!this.ctx.iasmSignals) {
      this.ctx.iasmSignals = {
        timestamp: null, signals: [], model_metrics: {}, market_context: {},
        freshness: null, updatedAt: null,
      };
    }
    Object.assign(this.ctx.iasmSignals, data, { updatedAt: new Date().toISOString() });
    this.logAgent('iasm', `Updated IASM signals (${(data.signals || []).length} signals)`);
    this.save();
  }

  getIASMSignals(symbols) {
    const signals = (this.ctx.iasmSignals && this.ctx.iasmSignals.signals) || [];
    if (!symbols) return signals;
    const symSet = new Set(Array.isArray(symbols) ? symbols : [symbols]);
    return signals.filter(s => symSet.has(s.symbol));
  }

  getIASMStatus() {
    const iasm = this.ctx.iasmSignals;
    if (!iasm || !iasm.updatedAt) {
      return { available: false, isStale: true, ageMinutes: null, signalCount: 0 };
    }
    const freshness = iasm.freshness || {};
    return {
      available: true,
      isStale: freshness.isStale || false,
      isFresh: freshness.isFresh || false,
      ageMinutes: freshness.ageMinutes || null,
      signalCount: (iasm.signals || []).length,
    };
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

  /**
   * FIX 1: Write research picks to persistent file for swing scanner
   * @param {Array} picks - Array of research opportunities with full DD
   */
  writeResearchPicks(picks) {
    const researchFile = path.join(DATA_DIR, 'research_picks.json');
    try {
      const data = {
        timestamp: new Date().toISOString(),
        date: getTodayET(),
        picks: picks.map(p => ({
          symbol: p.symbol,
          score: p.score,
          sourceCount: p.sourceCount,
          sources: p.sources,
          signals: p.signals,
          conviction: Math.min(5, Math.round(p.score)),
          ta: p.ta,
          options: p.options,
          revisions: p.revisions,
          sectorStrength: p.sectorStrength,
          quote: p.quote,
        })),
      };
      fs.writeFileSync(researchFile, JSON.stringify(data, null, 2));
      console.log(`[SharedBrain] Wrote ${picks.length} research picks to file`);
    } catch (e) {
      console.error('[SharedBrain] Failed to write research picks:', e.message);
    }
  }

  /**
   * Read research picks from file (for swing scanner to consume)
   */
  readResearchPicks() {
    const researchFile = path.join(DATA_DIR, 'research_picks.json');
    if (!fs.existsSync(researchFile)) return [];

    try {
      const data = JSON.parse(fs.readFileSync(researchFile, 'utf8'));
      // Check if still today's picks
      if (data.date === getTodayET()) {
        return data.picks || [];
      }
    } catch (e) {
      console.error('[SharedBrain] Failed to read research picks:', e.message);
    }
    return [];
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

  /**
   * Record a failed setup to prevent repeating the same mistake
   * @param {string} symbol - Stock symbol
   * @param {string} setupType - Type of setup (e.g., "puts", "calls", "long", "short")
   * @param {string} reason - Why it failed
   */
  recordFailedSetup(symbol, setupType, reason) {
    if (!this.ctx.failedSetups) this.ctx.failedSetups = [];

    // Check if this symbol+setupType combo already exists today
    const existing = this.ctx.failedSetups.find(f =>
      f.symbol === symbol && f.setupType === setupType
    );

    if (existing) {
      // Increment count and update reason
      existing.count++;
      existing.lastReason = reason;
      existing.timestamp = new Date().toISOString();
    } else {
      // New failed setup
      this.ctx.failedSetups.push({
        symbol,
        setupType,
        reason,
        timestamp: new Date().toISOString(),
        count: 1,
      });
    }

    this.save();
  }

  /**
   * Get failed setups for a symbol (or all if no symbol specified)
   * @param {string} symbol - Optional symbol filter
   * @returns {Array} Failed setups
   */
  getFailedSetups(symbol = null) {
    if (!this.ctx.failedSetups) return [];

    if (symbol) {
      return this.ctx.failedSetups.filter(f => f.symbol === symbol);
    }

    return this.ctx.failedSetups;
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
      // V9 MacroStrategy alpha scores (monthly horizon tilt for day trader context)
      macroAlpha: c.macroAlpha?.updatedAt ? {
        predictionDate: c.macroAlpha.predictionDate,
        freshness: c.macroAlpha.freshness,
        topPicks: (c.macroAlpha.topPicks || []).slice(0, 5),
        bottomPicks: (c.macroAlpha.bottomPicks || []).slice(0, 3),
      } : null,
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
      // V9 MacroStrategy alpha scores (monthly horizon - HIGH relevance for swing trades)
      macroAlpha: c.macroAlpha?.updatedAt ? {
        predictionDate: c.macroAlpha.predictionDate,
        freshness: c.macroAlpha.freshness,
        topPicks: c.macroAlpha.topPicks || [],       // Full top 10 for swing
        bottomPicks: c.macroAlpha.bottomPicks || [],  // Full bottom 10 for swing
        metadata: c.macroAlpha.metadata,
      } : null,
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
      macroAlphaStatus: this.getMacroAlphaStatus(),
      agentLog: c.agentLog,
    };
  }

  /** Check if context has been updated today by a specific section */
  hasData(section) {
    return this.ctx[section]?.updatedAt != null;
  }

  /**
   * Load recent daily history for green/red day context.
   * Returns last N days of archived data (daily P&L, trades, market regime).
   */
  getRecentDailyHistory(days = 7) {
    const history = [];
    const today = getTodayET();

    try {
      const files = fs.readdirSync(HISTORY_DIR)
        .filter(f => f.endsWith('.json') && f < `${today}.json`)
        .sort()
        .reverse()
        .slice(0, days);

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
          history.push({
            date: data.date,
            dayPnL: data.dayTrader?.pnlToday || 0,
            dayTrades: data.dayTrader?.tradesCount || 0,
            swingPnL: data.swingTrader?.account?.equity ? 'tracked' : 'N/A',
            marketRegime: data.market?.regime || 'unknown',
            riskSentiment: data.overnight?.riskSentiment || 'unknown',
            vix: data.market?.vix || null,
            greenDay: (data.dayTrader?.pnlToday || 0) >= 0,
          });
        } catch (e) { /* skip corrupt files */ }
      }
    } catch (e) { /* history dir may not exist yet */ }

    return history;
  }

  /**
   * Get performance context from the trade journal's performance_log.json
   */
  getPerformanceContext() {
    try {
      const perfFile = path.join(DATA_DIR, 'performance_log.json');
      if (!fs.existsSync(perfFile)) return null;
      const perf = JSON.parse(fs.readFileSync(perfFile, 'utf8'));

      const dailyEntries = Object.values(perf.dailyPnL || {}).sort((a, b) => b.date?.localeCompare(a.date));
      const recentDays = dailyEntries.slice(0, 7);

      return {
        cumulativePnL: perf.cumulativePnL || 0,
        totalTrades: perf.totalTrades || 0,
        wins: perf.wins || 0,
        losses: perf.losses || 0,
        winRate: perf.totalTrades > 0 ? ((perf.wins / perf.totalTrades) * 100).toFixed(1) + '%' : 'N/A',
        recentDays,
        currentStreak: this._calculateStreak(recentDays),
      };
    } catch (e) { return null; }
  }

  _calculateStreak(recentDays) {
    if (!recentDays || recentDays.length === 0) return { type: 'none', count: 0 };
    const first = recentDays[0];
    const type = first.grossPL >= 0 ? 'green' : 'red';
    let count = 0;
    for (const day of recentDays) {
      if ((type === 'green' && day.grossPL >= 0) || (type === 'red' && day.grossPL < 0)) {
        count++;
      } else break;
    }
    return { type, count };
  }
}

module.exports = new SharedBrain();
