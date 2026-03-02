/**
 * Day Trader Agent - VETO-ONLY MONITOR & RISK GUARDIAN
 *
 * ARCHITECTURE CHANGE (Feb 2026):
 * The IASM meta-learner now generates all trade signals and routes them
 * to intraday_executor.js for direct execution. This agent's role is:
 *
 *   1. VETO GATE: Receive signals, check for concrete reasons to block
 *   2. MONITOR: Track all open positions, report P&L, alert on anomalies
 *   3. LOG: Record every trade decision for the journal
 *   4. REPORT: Send summaries to Discord at key times
 *
 * This agent does NOT generate its own trade ideas.
 * This agent does NOT scan for opportunities.
 * This agent does NOT make entry/exit decisions.
 *
 * The swing_scanner.js is UNAFFECTED - it retains full LLM execution control.
 *
 * Decision Engine: LLM (Groq FREE -> Haiku -> OpenAI -> Kimi)
 * The LLM evaluates veto checks and monitors positions - it does NOT trade.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

// Event Logger
let eventLogger;
try {
  eventLogger = require('../event_logger');
} catch (e) {
  console.warn('[DayTrader] Event logger not available:', e.message);
}

// LLM Reasoning Engine
let reasoning;
try {
  reasoning = require('../../utils/llm_reasoning');
} catch (e) {
  console.warn('[DayTrader] LLM reasoning not available:', e.message);
}

// Day trade Alpaca client
let daytradeClient;
try {
  daytradeClient = require('../../swing_options/daytrade_client');
} catch (e) {
  console.warn('[DayTrader] Alpaca client not available:', e.message);
}

// News Feed (on-demand before LLM calls)
let newsFeed;
try {
  const NewsFeed = require('./news_feed');
  newsFeed = new NewsFeed();
} catch (e) {}

// Trade Journal (performance logging)
let journal;
try {
  journal = require('../trade_journal');
} catch (e) {
  console.warn('[DayTrader] Trade journal not available:', e.message);
}

// Swing Options Toolkit - enriched data sources
let apiClient;
try {
  apiClient = require('../../swing_options/api_client');
} catch (e) {
  console.warn('[DayTrader] Swing options toolkit not available:', e.message);
}

// ============================================================================
// EXECUTION LOG - Persistent file for tracking all decisions
// ============================================================================

const EXECUTION_LOG_FILE = path.join(__dirname, '..', 'data', 'execution_log.json');
const VETO_STATS_FILE = path.join(__dirname, '..', 'data', 'veto_stats.json');

function loadExecutionLog() {
  try {
    if (fs.existsSync(EXECUTION_LOG_FILE)) return JSON.parse(fs.readFileSync(EXECUTION_LOG_FILE, 'utf8'));
  } catch (e) {}
  return { entries: [], lastUpdated: null };
}

function saveExecutionLog(data) {
  data.lastUpdated = new Date().toISOString();
  // Keep last 500 entries
  if (data.entries.length > 500) data.entries = data.entries.slice(-500);
  fs.writeFileSync(EXECUTION_LOG_FILE, JSON.stringify(data, null, 2));
}

function loadVetoStats() {
  try {
    if (fs.existsSync(VETO_STATS_FILE)) return JSON.parse(fs.readFileSync(VETO_STATS_FILE, 'utf8'));
  } catch (e) {}
  return {
    totalSignals: 0,
    totalVetoes: 0,
    totalPasses: 0,
    vetoReasons: {},      // { reason: count }
    vetoOutcomes: [],     // [{ symbol, vetoReason, wouldHavePL, timestamp }]
    passOutcomes: [],     // [{ symbol, actualPL, timestamp }]
    dailyStats: {},       // { 'YYYY-MM-DD': { signals, vetoes, passes, vetoAccuracy } }
    lastUpdated: null,
  };
}

function saveVetoStats(data) {
  data.lastUpdated = new Date().toISOString();
  // Keep last 30 days of daily stats
  const dates = Object.keys(data.dailyStats).sort();
  if (dates.length > 30) {
    for (const d of dates.slice(0, dates.length - 30)) {
      delete data.dailyStats[d];
    }
  }
  // Keep last 200 outcomes
  if (data.vetoOutcomes.length > 200) data.vetoOutcomes = data.vetoOutcomes.slice(-200);
  if (data.passOutcomes.length > 200) data.passOutcomes = data.passOutcomes.slice(-200);
  fs.writeFileSync(VETO_STATS_FILE, JSON.stringify(data, null, 2));
}

// ============================================================================
// YAHOO FINANCE DATA (kept for monitoring context)
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
          if (result) {
            const meta = result.meta;
            const quotes = result.indicators?.quote?.[0];
            const len = quotes?.close?.length || 0;
            resolve({
              symbol,
              price: meta.regularMarketPrice,
              prevClose: meta.previousClose || meta.chartPreviousClose,
              change: meta.regularMarketPrice - (meta.previousClose || 0),
              changePct: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100),
              volume: quotes?.volume?.[len - 1],
              high: quotes?.high?.[len - 1],
              low: quotes?.low?.[len - 1],
              fiftyTwoHigh: meta.fiftyTwoWeekHigh,
              fiftyTwoLow: meta.fiftyTwoWeekLow,
              open: quotes?.open?.[len - 1],
            });
          } else resolve(null);
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchVIX() {
  return fetchQuote('^VIX');
}

// ============================================================================
// VALID VETO REASONS (concrete, not subjective)
// ============================================================================

const VALID_VETO_REASONS = {
  EARNINGS_IMMINENT: 'Earnings report within 1 hour - binary event risk',
  TRADING_HALT: 'Symbol is halted or about to halt',
  EXTREME_NEWS: 'Extreme breaking news that invalidates the signal premise',
  CIRCUIT_BREAKER: 'Market-wide circuit breaker triggered or imminent',
  OVEREXPOSED: 'Already max exposed to this symbol or correlated sector',
  DAILY_LOSS_LIMIT: 'Daily loss limit reached or nearly reached',
  STALE_SIGNAL: 'Signal data is stale (>15 minutes old)',
  HALTED_SYMBOL: 'Symbol trading is halted',
  LIQUIDITY_CRISIS: 'Extreme illiquidity detected - wide spreads, no volume',
};

// ============================================================================
// DAY TRADER AGENT - VETO MONITOR
// ============================================================================

class DayTraderAgent {
  constructor() {
    this.name = 'Day Trader';
    this.emoji = '🛡️';  // Shield emoji - guardian role
    this.lastRun = null;

    // Daily tracking
    this.lastTradeDate = null;
    this.todaySignals = 0;
    this.todayVetoes = 0;
    this.todayPasses = 0;

    // Position monitoring state
    this.lastPositionSnapshot = {};  // { symbol: { price, timestamp } }
    this.alertCooldowns = {};        // { symbol: lastAlertTimestamp }
  }

  // ============================================================================
  // VETO CHECK - The primary new function
  // ============================================================================

  /**
   * Evaluate a trade signal from IASM/intraday_executor.
   * Returns PASS (let it trade) or VETO (block it) with reason.
   *
   * @param {object} signal - Trade signal from IASM
   *   { symbol, direction, confidence, magnitude, timeframe, expected_return_pct,
   *     consensus, features, context }
   * @returns {object} { decision: 'PASS'|'VETO', reason: string, timestamp: Date,
   *                     vetoCategory: string|null, signalId: string }
   */
  async vetoCheck(signal) {
    const timestamp = new Date();
    const signalId = `${signal.symbol}_${signal.direction}_${timestamp.getTime()}`;
    const today = new Date().toDateString();

    // Reset daily counters
    if (this.lastTradeDate !== today) {
      this.todaySignals = 0;
      this.todayVetoes = 0;
      this.todayPasses = 0;
      this.lastTradeDate = today;
    }

    this.todaySignals++;

    console.log(`[DayTrader VETO] Checking signal: ${signal.symbol} ${signal.direction} | Conf: ${(signal.confidence * 100).toFixed(0)}% | Consensus: ${signal.consensus || 'N/A'}`);

    // ---- HARD VETO CHECKS (no LLM needed) ----

    // 1. Daily loss limit
    try {
      const pnl = await daytradeClient.getTodayPnL();
      if (pnl.pnlPct <= -3) {
        return this._vetoResult(signalId, signal, 'DAILY_LOSS_LIMIT',
          `Daily loss at ${pnl.pnlPct.toFixed(2)}% - exceeds -3% limit`, timestamp);
      }
    } catch (e) { /* continue */ }

    // 2. Overexposure check
    try {
      const positions = await daytradeClient.getPositions();
      const positionCount = (positions || []).length;

      // Max 5 concurrent positions
      if (positionCount >= 5 && signal.direction !== 'close') {
        return this._vetoResult(signalId, signal, 'OVEREXPOSED',
          `Already have ${positionCount} open positions (max 5)`, timestamp);
      }

      // Check same-symbol exposure
      const sameSymbol = (positions || []).find(p => {
        const posUnderlying = p.symbol.length > 10
          ? p.symbol.substring(0, p.symbol.indexOf('2'))
          : p.symbol;
        return posUnderlying === signal.symbol;
      });
      if (sameSymbol && (signal.direction === 'long' || signal.direction === 'short')) {
        return this._vetoResult(signalId, signal, 'OVEREXPOSED',
          `Already have position in ${signal.symbol}: ${parseFloat(sameSymbol.qty)}x @ $${parseFloat(sameSymbol.avg_entry_price).toFixed(2)}`, timestamp);
      }
    } catch (e) { /* continue */ }

    // 3. Stale signal check
    if (signal.timestamp) {
      const signalAge = (Date.now() - new Date(signal.timestamp).getTime()) / 60000;
      if (signalAge > 15) {
        return this._vetoResult(signalId, signal, 'STALE_SIGNAL',
          `Signal is ${signalAge.toFixed(0)} minutes old (max 15)`, timestamp);
      }
    }

    // 4. Market closed check
    try {
      const clock = await daytradeClient.getClient().getClock();
      if (!clock.is_open) {
        return this._vetoResult(signalId, signal, 'CIRCUIT_BREAKER',
          'Market is closed', timestamp);
      }
    } catch (e) { /* continue */ }

    // ---- LLM VETO CHECK (for nuanced conditions) ----
    if (reasoning) {
      try {
        const llmVeto = await this._llmVetoCheck(signal);
        if (llmVeto.veto) {
          return this._vetoResult(signalId, signal, llmVeto.category || 'LLM_VETO',
            llmVeto.reason, timestamp);
        }
      } catch (e) {
        console.warn('[DayTrader VETO] LLM check failed, defaulting to PASS:', e.message);
        // LLM failure = PASS (don't block trades because LLM is down)
      }
    }

    // ---- DEFAULT: PASS ----
    this.todayPasses++;
    const result = {
      decision: 'PASS',
      reason: 'No concrete reason to block this signal',
      timestamp,
      vetoCategory: null,
      signalId,
    };

    // Log the pass
    this._logDecision(signalId, signal, result);

    console.log(`[DayTrader VETO] PASS: ${signal.symbol} ${signal.direction}`);
    return result;
  }

  /**
   * Internal: build a VETO result and log it
   */
  _vetoResult(signalId, signal, category, reason, timestamp) {
    this.todayVetoes++;
    const result = {
      decision: 'VETO',
      reason,
      timestamp,
      vetoCategory: category,
      signalId,
    };

    // Log the veto
    this._logDecision(signalId, signal, result);

    // Update veto stats
    const stats = loadVetoStats();
    stats.totalSignals++;
    stats.totalVetoes++;
    stats.vetoReasons[category] = (stats.vetoReasons[category] || 0) + 1;
    stats.vetoOutcomes.push({
      symbol: signal.symbol,
      direction: signal.direction,
      vetoReason: reason,
      vetoCategory: category,
      confidence: signal.confidence,
      wouldHavePL: null, // Filled later by outcome tracker
      timestamp: timestamp.toISOString(),
    });
    const todayKey = timestamp.toISOString().split('T')[0];
    if (!stats.dailyStats[todayKey]) {
      stats.dailyStats[todayKey] = { signals: 0, vetoes: 0, passes: 0, vetoAccuracy: null };
    }
    stats.dailyStats[todayKey].signals++;
    stats.dailyStats[todayKey].vetoes++;
    saveVetoStats(stats);

    console.log(`[DayTrader VETO] VETO: ${signal.symbol} ${signal.direction} | ${category}: ${reason}`);

    // Discord alert for vetoes
    discord.tradeExecution(
      `🛡️ **VETO** ${signal.symbol} ${signal.direction.toUpperCase()} | Conf: ${(signal.confidence * 100).toFixed(0)}%\n` +
      `Reason: ${reason}\n` +
      `Category: ${category}`
    ).catch(e => console.warn('[DayTrader] Discord veto alert error:', e.message));

    return result;
  }

  /**
   * LLM-based veto check for nuanced conditions
   * (earnings timing, breaking news, halt detection)
   */
  async _llmVetoCheck(signal) {
    // Gather context for LLM
    const ctx = brain.ctx;
    const earningsToday = ctx.catalysts?.earningsToday || [];
    const breakingNews = ctx.catalysts?.newsBreaking || [];
    const vix = ctx.market?.vix;
    const regime = ctx.market?.regime;

    // Check if we even need the LLM (quick checks first)
    const earningsMatch = earningsToday.find(e =>
      e.symbol === signal.symbol || e.symbol === signal.symbol?.split(/\d/)[0]
    );

    // If no earnings and no breaking news for this symbol, skip LLM call
    const relevantNews = breakingNews.filter(n =>
      n.symbols?.includes(signal.symbol) ||
      n.headline?.toLowerCase().includes(signal.symbol?.toLowerCase())
    );

    if (!earningsMatch && relevantNews.length === 0 && vix < 30) {
      // No concerning context - fast PASS without LLM
      return { veto: false };
    }

    // Build focused LLM prompt
    const prompt = `You are an INTRADAY TRADE MONITOR and RISK GUARDIAN.

Your role is NOT to generate trades. The IASM meta-learner model generates all trade signals.

Your ONLY job right now: Check if there's a CONCRETE reason to VETO this signal.

VALID VETO REASONS (you MUST cite one of these):
- EARNINGS_IMMINENT: Earnings within 1 hour
- TRADING_HALT: Symbol halted or about to halt
- EXTREME_NEWS: Breaking news that invalidates the signal's premise
- CIRCUIT_BREAKER: Market-wide circuit breaker triggered or imminent
- OVEREXPOSED: Already overexposed to this symbol/sector
- LIQUIDITY_CRISIS: Extreme illiquidity (wide spreads, no volume)

INVALID VETO REASONS (do NOT use these):
- "I don't like the chart" - subjective opinion, NOT valid
- "Feels risky" - vague, NOT valid
- "RSI is overbought" - the model already accounts for this
- "I would do it differently" - you are not the trader
- Any technical analysis disagreement - the model has a 64.5% hit rate, don't fight it

DEFAULT DECISION: PASS (let the model trade)

SIGNAL TO EVALUATE:
Symbol: ${signal.symbol}
Direction: ${signal.direction}
Confidence: ${(signal.confidence * 100).toFixed(0)}%
Expected Return: ${signal.expected_return_pct ? signal.expected_return_pct.toFixed(2) + '%' : 'N/A'}
Consensus: ${signal.consensus || 'N/A'}
Timeframe: ${signal.timeframe || signal.horizon || 'intraday'}

CONTEXT:
Earnings Today: ${earningsMatch ? JSON.stringify(earningsMatch) : 'None for this symbol'}
Breaking News: ${relevantNews.length > 0 ? relevantNews.map(n => n.headline).join('; ') : 'None for this symbol'}
VIX: ${vix || 'N/A'}
Market Regime: ${regime || 'N/A'}
Time ET: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}

Respond in EXACTLY this JSON format:
{
  "decision": "PASS" or "VETO",
  "reason": "Concrete reason (if VETO) or 'No blocking conditions found' (if PASS)",
  "category": "EARNINGS_IMMINENT" or "TRADING_HALT" or "EXTREME_NEWS" or "CIRCUIT_BREAKER" or "OVEREXPOSED" or "LIQUIDITY_CRISIS" or null
}`;

    try {
      const provider = reasoning.findAvailableProvider();
      if (!provider) return { veto: false };

      const response = await reasoning.callLLM(prompt, { maxTokens: 200 });
      const parsed = JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());

      if (parsed.decision === 'VETO' && parsed.category) {
        // Validate the category is in our allowed list
        if (VALID_VETO_REASONS[parsed.category]) {
          return { veto: true, reason: parsed.reason, category: parsed.category };
        }
        // Invalid category = LLM is being subjective, override to PASS
        console.warn(`[DayTrader VETO] LLM used invalid veto category: ${parsed.category} - overriding to PASS`);
        return { veto: false };
      }
      return { veto: false };
    } catch (e) {
      console.warn('[DayTrader VETO] LLM parse error:', e.message);
      return { veto: false }; // Default to PASS on error
    }
  }

  // ============================================================================
  // POSITION MONITORING
  // ============================================================================

  /**
   * Monitor all open positions, calculate P&L, alert on unusual movement.
   * Called every run cycle (10 min) and also available on-demand.
   *
   * @returns {object} { positions, totalUnrealizedPL, alerts }
   */
  async monitorPositions() {
    const result = {
      positions: [],
      totalUnrealizedPL: 0,
      totalUnrealizedPLPct: 0,
      alerts: [],
      timestamp: new Date().toISOString(),
    };

    if (!daytradeClient) return result;

    try {
      const positions = await daytradeClient.getPositions();
      const account = await daytradeClient.getAccount();
      const equity = parseFloat(account.portfolio_value);

      for (const p of (positions || [])) {
        const pos = {
          symbol: p.symbol,
          qty: parseFloat(p.qty),
          side: p.side,
          avgEntry: parseFloat(p.avg_entry_price),
          currentPrice: parseFloat(p.current_price),
          marketValue: parseFloat(p.market_value),
          unrealizedPL: parseFloat(p.unrealized_pl),
          unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
          assetClass: p.asset_class,
        };

        result.positions.push(pos);
        result.totalUnrealizedPL += pos.unrealizedPL;

        // ---- ALERT CONDITIONS ----

        // 1. Position hitting stop loss territory (>5% loss)
        if (pos.unrealizedPLPct <= -5) {
          result.alerts.push({
            type: 'STOP_WARNING',
            symbol: pos.symbol,
            message: `${pos.symbol} down ${pos.unrealizedPLPct.toFixed(1)}% ($${pos.unrealizedPL.toFixed(2)})`,
            severity: pos.unrealizedPLPct <= -10 ? 'CRITICAL' : 'WARNING',
          });
        }

        // 2. Target reached (>3% gain)
        if (pos.unrealizedPLPct >= 3) {
          result.alerts.push({
            type: 'TARGET_NEAR',
            symbol: pos.symbol,
            message: `${pos.symbol} up ${pos.unrealizedPLPct.toFixed(1)}% ($${pos.unrealizedPL.toFixed(2)}) - consider taking profit`,
            severity: 'INFO',
          });
        }

        // 3. Unusual movement (>2% in 5 minutes)
        const lastSnapshot = this.lastPositionSnapshot[pos.symbol];
        if (lastSnapshot) {
          const timeDiff = (Date.now() - lastSnapshot.timestamp) / 60000; // minutes
          if (timeDiff <= 10 && timeDiff > 0) {
            const priceDiff = ((pos.currentPrice - lastSnapshot.price) / lastSnapshot.price) * 100;
            if (Math.abs(priceDiff) >= 2) {
              result.alerts.push({
                type: 'UNUSUAL_MOVEMENT',
                symbol: pos.symbol,
                message: `${pos.symbol} moved ${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(1)}% in ${timeDiff.toFixed(0)} min`,
                severity: Math.abs(priceDiff) >= 5 ? 'CRITICAL' : 'WARNING',
              });
            }
          }
        }

        // Update snapshot
        this.lastPositionSnapshot[pos.symbol] = {
          price: pos.currentPrice,
          timestamp: Date.now(),
        };
      }

      // Calculate total P&L %
      if (equity > 0) {
        result.totalUnrealizedPLPct = (result.totalUnrealizedPL / equity) * 100;
      }

      // Send alerts to Discord (with cooldown to prevent spam)
      for (const alert of result.alerts) {
        const cooldownKey = `${alert.type}_${alert.symbol}`;
        const lastAlert = this.alertCooldowns[cooldownKey] || 0;
        const cooldownMs = alert.severity === 'CRITICAL' ? 5 * 60000 : 15 * 60000; // 5 min for critical, 15 min otherwise

        if (Date.now() - lastAlert > cooldownMs) {
          this.alertCooldowns[cooldownKey] = Date.now();
          const emoji = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'WARNING' ? '⚠️' : 'ℹ️';
          await discord.alert(`${emoji} **${alert.type}** | ${alert.message}`);
        }
      }

    } catch (e) {
      console.error('[DayTrader Monitor] Position check error:', e.message);
    }

    return result;
  }

  // ============================================================================
  // EXECUTION LOGGING
  // ============================================================================

  /**
   * Log every trade decision (pass, veto, execution result)
   *
   * @param {object} signal - The original IASM signal
   * @param {object} decision - The veto check result
   * @param {object} result - The execution result (from intraday_executor)
   */
  logExecution(signal, decision, result = null) {
    const log = loadExecutionLog();

    const entry = {
      timestamp: new Date().toISOString(),
      signalId: decision.signalId,
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      consensus: signal.consensus,
      expected_return_pct: signal.expected_return_pct,
      vetoDecision: decision.decision,
      vetoReason: decision.reason,
      vetoCategory: decision.vetoCategory,
      executionResult: result ? {
        status: result.status,
        orderId: result.orderId,
        filledPrice: result.filledPrice,
        filledQty: result.filledQty,
        error: result.error,
      } : null,
    };

    log.entries.push(entry);
    saveExecutionLog(log);

    // Also log to event logger
    if (eventLogger) {
      eventLogger.logTradingEvent({
        agent: 'day_trader_veto',
        type: decision.decision === 'VETO' ? 'SIGNAL_VETOED' : 'SIGNAL_PASSED',
        symbol: signal.symbol,
        side: signal.direction,
        reason: decision.reason,
        conviction: (signal.confidence * 100).toFixed(0) + '%',
        data: {
          consensus: signal.consensus,
          vetoCategory: decision.vetoCategory,
          executionStatus: result?.status || 'pending',
        },
        result: decision.decision === 'VETO' ? 'vetoed' : 'passed',
      });
    }

    // Log to brain
    brain.addReasoning(
      `${decision.decision} ${signal.symbol} ${signal.direction} (${(signal.confidence * 100).toFixed(0)}%): ${decision.reason}`,
      decision.decision
    );

    // Send entry notification to Discord if passed and executed
    if (decision.decision === 'PASS' && result && result.status === 'filled') {
      discord.tradeExecution(
        `⚡ **IASM ${signal.direction.toUpperCase()} ${signal.symbol}** @ $${result.filledPrice || '?'} | ` +
        `Conf: ${(signal.confidence * 100).toFixed(0)}% | Consensus: ${signal.consensus || 'N/A'}`
      ).catch(e => console.warn('[DayTrader] Discord entry alert error:', e.message));
    }

    return entry;
  }

  /**
   * Log a trade exit (for P&L tracking)
   *
   * @param {object} exitData - { symbol, entryPrice, exitPrice, pl, plPct, holdTimeMin, reason }
   */
  logExit(exitData) {
    // Update pass outcomes for veto accuracy tracking
    const stats = loadVetoStats();
    stats.passOutcomes.push({
      symbol: exitData.symbol,
      actualPL: exitData.pl,
      actualPLPct: exitData.plPct,
      holdTimeMin: exitData.holdTimeMin,
      timestamp: new Date().toISOString(),
    });

    const todayKey = new Date().toISOString().split('T')[0];
    if (!stats.dailyStats[todayKey]) {
      stats.dailyStats[todayKey] = { signals: 0, vetoes: 0, passes: 0, vetoAccuracy: null };
    }
    saveVetoStats(stats);

    // Discord exit notification
    const plEmoji = exitData.plPct >= 0 ? '🟢' : '🔴';
    discord.tradeExecution(
      `${plEmoji} **CLOSED ${exitData.symbol}** ${exitData.plPct >= 0 ? '+' : ''}${exitData.plPct.toFixed(1)}% ($${exitData.pl.toFixed(2)}) | ` +
      `Hold: ${exitData.holdTimeMin}min | ${exitData.reason || ''}`
    ).catch(e => console.warn('[DayTrader] Discord exit alert error:', e.message));

    // Event logger
    if (eventLogger) {
      eventLogger.logTradingEvent({
        agent: 'day_trader_veto',
        type: 'POSITION_CLOSED',
        symbol: exitData.symbol,
        price: exitData.exitPrice,
        reason: exitData.reason,
        data: {
          entryPrice: exitData.entryPrice,
          exitPrice: exitData.exitPrice,
          pl: exitData.pl,
          plPct: exitData.plPct,
          holdTimeMin: exitData.holdTimeMin,
        },
        result: exitData.plPct >= 0 ? 'win' : 'loss',
      });
    }
  }

  /**
   * Internal: log veto/pass decision to execution log
   */
  _logDecision(signalId, signal, result) {
    const log = loadExecutionLog();
    log.entries.push({
      timestamp: new Date().toISOString(),
      signalId,
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      consensus: signal.consensus,
      decision: result.decision,
      reason: result.reason,
      category: result.vetoCategory,
    });
    saveExecutionLog(log);
  }

  // ============================================================================
  // VETO STATS & ACCURACY
  // ============================================================================

  /**
   * Get veto statistics and accuracy metrics
   *
   * @returns {object} Veto stats with accuracy breakdown
   */
  getVetoStats() {
    const stats = loadVetoStats();
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyStats[today] || { signals: 0, vetoes: 0, passes: 0 };

    // Calculate veto accuracy: what % of vetoed trades would have lost money?
    const vetoedWithOutcomes = stats.vetoOutcomes.filter(v => v.wouldHavePL !== null);
    const correctVetoes = vetoedWithOutcomes.filter(v => v.wouldHavePL < 0);
    const vetoAccuracy = vetoedWithOutcomes.length > 0
      ? (correctVetoes.length / vetoedWithOutcomes.length * 100).toFixed(1) + '%'
      : 'N/A (no outcomes tracked yet)';

    // Calculate pass accuracy: what % of passed trades made money?
    const passesWithOutcomes = stats.passOutcomes.filter(p => p.actualPL !== null && p.actualPL !== undefined);
    const profitablePasses = passesWithOutcomes.filter(p => p.actualPL > 0);
    const passAccuracy = passesWithOutcomes.length > 0
      ? (profitablePasses.length / passesWithOutcomes.length * 100).toFixed(1) + '%'
      : 'N/A';

    // Average P&L of passed trades
    const avgPassPL = passesWithOutcomes.length > 0
      ? (passesWithOutcomes.reduce((sum, p) => sum + (p.actualPLPct || 0), 0) / passesWithOutcomes.length).toFixed(2) + '%'
      : 'N/A';

    return {
      allTime: {
        totalSignals: stats.totalSignals,
        totalVetoes: stats.totalVetoes,
        totalPasses: stats.totalPasses,
        vetoRate: stats.totalSignals > 0 ? (stats.totalVetoes / stats.totalSignals * 100).toFixed(1) + '%' : '0%',
        vetoAccuracy,
        passAccuracy,
        avgPassPL,
      },
      today: {
        signals: this.todaySignals || todayStats.signals,
        vetoes: this.todayVetoes || todayStats.vetoes,
        passes: this.todayPasses || todayStats.passes,
      },
      topVetoReasons: Object.entries(stats.vetoReasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
      recentVetoes: stats.vetoOutcomes.slice(-5),
      recentPasses: stats.passOutcomes.slice(-5),
    };
  }

  // ============================================================================
  // DAILY REPORT
  // ============================================================================

  /**
   * Generate daily summary report (called at 4:15 PM or on demand)
   *
   * @returns {object} Report data
   */
  async getDailyReport() {
    const report = {
      timestamp: new Date().toISOString(),
      timeET: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }),
      account: null,
      positions: [],
      vetoStats: this.getVetoStats(),
      executionSummary: null,
      errors: [],
    };

    // Get account state
    if (daytradeClient) {
      try {
        const acc = await daytradeClient.getAccount();
        report.account = {
          equity: parseFloat(acc.portfolio_value),
          cash: parseFloat(acc.cash),
          buyingPower: parseFloat(acc.buying_power),
          lastEquity: parseFloat(acc.last_equity),
          dailyPL: parseFloat(acc.portfolio_value) - parseFloat(acc.last_equity),
          dailyPLPct: ((parseFloat(acc.portfolio_value) - parseFloat(acc.last_equity)) / parseFloat(acc.last_equity) * 100),
        };
      } catch (e) {
        report.errors.push(`Account: ${e.message}`);
      }

      try {
        const positions = await daytradeClient.getPositions();
        report.positions = (positions || []).map(p => ({
          symbol: p.symbol,
          qty: parseFloat(p.qty),
          side: p.side,
          avgEntry: parseFloat(p.avg_entry_price),
          currentPrice: parseFloat(p.current_price),
          unrealizedPL: parseFloat(p.unrealized_pl),
          unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
        }));
      } catch (e) {
        report.errors.push(`Positions: ${e.message}`);
      }
    }

    // Execution summary from today's log
    const log = loadExecutionLog();
    const today = new Date().toISOString().split('T')[0];
    const todayEntries = log.entries.filter(e => e.timestamp.startsWith(today));

    report.executionSummary = {
      totalDecisions: todayEntries.length,
      vetoes: todayEntries.filter(e => e.decision === 'VETO' || e.vetoDecision === 'VETO').length,
      passes: todayEntries.filter(e => e.decision === 'PASS' || e.vetoDecision === 'PASS').length,
      symbols: [...new Set(todayEntries.map(e => e.symbol))],
    };

    return report;
  }

  // ============================================================================
  // MAIN RUN FUNCTION (monitoring loop - called every 10 min)
  // ============================================================================

  /**
   * Main run function - called every 10 min during market hours.
   * Now focused on monitoring and reporting, NOT trading.
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`[${new Date().toISOString()}] ${this.emoji} Day Trader Monitor starting... (${timeET} ET)`);

    const report = {
      timestamp: new Date().toISOString(),
      timeET,
      account: null,
      positions: [],
      monitoring: null,
      reasoning: [],
      errors: [],
    };

    try {
      // 0. Check market is open
      if (daytradeClient) {
        try {
          const clock = await daytradeClient.getClient().getClock();
          if (!clock.is_open) {
            // At 4:15 PM, send daily summary
            if (timeET >= '16:10' && timeET <= '16:20') {
              await this._sendDailySummary();
            }
            report.reasoning.push({ thought: 'Market closed', decision: 'SKIP' });
            this.lastRun = new Date();
            return report;
          }
        } catch (e) { /* continue */ }
      }

      // 1. Get account state
      report.account = await this._getAccountState();

      // 2. Monitor positions
      report.monitoring = await this.monitorPositions();
      report.positions = report.monitoring.positions;

      // 3. Enforce safety limits on positions
      if (report.positions.length > 0) {
        const forcedExits = await this._enforceSafetyLimits(report.positions);
        if (forcedExits.length > 0) {
          report.reasoning.push({
            thought: `Safety limits forced ${forcedExits.length} exits: ${forcedExits.map(e => e.symbol).join(', ')}`,
            decision: 'SAFETY_EXIT',
          });
          // Refresh positions after forced exits
          report.monitoring = await this.monitorPositions();
          report.positions = report.monitoring.positions;
        }
      }

      // 4. Fetch fresh news (useful for veto context on next signal)
      if (newsFeed) {
        try { await newsFeed.run(); } catch (e) { console.warn('[DayTrader] News fetch:', e.message); }
      }

      // 5. Update market context in shared brain (for veto decisions)
      await this._updateMarketContext();

      // 6. EOD review (3:30+ PM) - close 0DTE options, big losers
      if (timeET >= '15:30') {
        await this._eodReview(report);
      }

      // 7. Daily summary at 4:15 PM
      if (timeET >= '16:10' && timeET <= '16:20') {
        await this._sendDailySummary();
      }

      // 8. Reconcile trade journal with Alpaca
      if (journal && daytradeClient) {
        try {
          const reconcile = await journal.reconcileWithAlpaca(daytradeClient.getClient(), 'day');
          if (reconcile.added > 0) {
            console.log(`[DayTrader] Journal reconciliation: ${reconcile.added} trades added/fixed`);
          }
        } catch (e) {
          console.warn('[DayTrader] Journal reconciliation error:', e.message);
        }
      }

      // 9. Event log reconciliation
      if (eventLogger && daytradeClient) {
        try {
          await eventLogger.logReconciliation(daytradeClient.getClient(), 'day');
        } catch (e) {
          console.warn('[DayTrader] Event log reconciliation error:', e.message);
        }
      }

    } catch (error) {
      report.errors.push(error.message);
      console.error('[DayTrader Monitor] Error:', error);
    }

    // Write to shared brain
    this._updateSharedBrain(report);

    // Send monitoring report to Discord
    await this._sendMonitoringReport(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Day Trader Monitor completed in ${Date.now() - startTime}ms`);

    return report;
  }

  // ============================================================================
  // Account & Position Helpers (kept from original)
  // ============================================================================

  async _getAccountState() {
    if (!daytradeClient) return null;
    try {
      const acc = await daytradeClient.getAccount();
      return {
        equity: parseFloat(acc.portfolio_value),
        cash: parseFloat(acc.cash),
        buyingPower: parseFloat(acc.buying_power),
        lastEquity: parseFloat(acc.last_equity),
        dailyPL: parseFloat(acc.portfolio_value) - parseFloat(acc.last_equity),
        dayTradesRemaining: 3 - parseInt(acc.daytrade_count || 0),
        status: acc.status,
      };
    } catch (e) {
      console.error('[DayTrader] Failed to get account from Alpaca:', e.message);
      return null;
    }
  }

  /**
   * Safety limits - catastrophic loss, stale positions (kept from original)
   */
  async _enforceSafetyLimits(positions) {
    const forcedExits = [];

    for (const pos of positions) {
      // SAFETY LIMIT 1: Catastrophic loss (10%+ on underlying)
      if (pos.unrealizedPLPct <= -10) {
        forcedExits.push({
          symbol: pos.symbol,
          reason: `CATASTROPHIC LOSS: Down ${pos.unrealizedPLPct.toFixed(1)}% - emergency exit`,
        });
        continue;
      }
    }

    // Execute forced exits
    for (const exit of forcedExits) {
      try {
        console.warn(`[DayTrader] SAFETY LIMIT: Force closing ${exit.symbol} - ${exit.reason}`);
        await daytradeClient.closePosition(exit.symbol);
        brain.addDayTrade({
          symbol: exit.symbol,
          action: 'SAFETY_CLOSE',
          reason: exit.reason,
        });

        await discord.alert(`🚨 **SAFETY LIMIT TRIGGERED**\n\n${exit.symbol}: ${exit.reason}`);

        if (journal) {
          try {
            await journal.closeTrade({
              symbol: exit.symbol,
              account: 'day',
              exitPrice: null,
              reasoning: exit.reason,
            });
          } catch (e) { console.warn('[DayTrader] Journal safety close error:', e.message); }
        }
      } catch (e) {
        console.error(`[DayTrader] Failed to force close ${exit.symbol}:`, e.message);
      }
    }

    return forcedExits;
  }

  // ============================================================================
  // Market Context Update (slimmed down - only what's needed for veto context)
  // ============================================================================

  async _updateMarketContext() {
    try {
      // Get VIX for regime context
      const vix = await fetchVIX();
      if (vix) {
        const spyQuote = await fetchQuote('SPY');
        const spyChange = spyQuote?.changePct || 0;
        const vixPrice = vix.price;
        let regime = 'UNKNOWN';
        if (vixPrice > 25) regime = spyChange < -0.5 ? 'BEAR' : 'CHOPPY';
        else if (vixPrice < 15) regime = spyChange > 0.3 ? 'BULL' : 'TRENDING';
        else regime = Math.abs(spyChange) < 0.3 ? 'CHOPPY' : (spyChange > 0 ? 'BULL' : 'BEAR');

        brain.writeMarket({
          indices: spyQuote ? { SPY: spyQuote } : {},
          vix: vixPrice,
          regime,
        });
      }
    } catch (e) {
      console.warn('[DayTrader] Market context update error:', e.message);
    }
  }

  // ============================================================================
  // EOD Review (kept from original - safety only)
  // ============================================================================

  async _eodReview(report) {
    if (report.positions.length === 0) return;

    const closes = [];
    const holds = [];

    for (const pos of report.positions) {
      // Close big losers with no recovery thesis
      if (pos.unrealizedPLPct <= -20) {
        closes.push(pos);
        continue;
      }
      // Close 0DTE options (expire worthless overnight)
      const today = new Date().toISOString().split('T')[0];
      if (pos.symbol.length > 10 && pos.symbol.includes(today.replace(/-/g, '').slice(2))) {
        closes.push(pos);
        continue;
      }
      holds.push(pos);
    }

    for (const pos of closes) {
      try {
        await daytradeClient.closePosition(pos.symbol);
        brain.addDayTrade({ symbol: pos.symbol, action: 'EOD_CLOSE', reason: 'EOD review - no thesis to hold' });

        if (journal) {
          try {
            await journal.closeTrade({
              symbol: pos.symbol,
              account: 'day',
              exitPrice: pos.currentPrice,
              reasoning: 'EOD review - no thesis to hold overnight',
            });
          } catch (je) { console.warn('[DayTrader] Journal EOD close error:', je.message); }
        }
      } catch (e) {
        report.errors.push(`EOD close ${pos.symbol}: ${e.message}`);
      }
    }

    if (closes.length > 0 || holds.length > 0) {
      const msg = [];
      if (closes.length > 0) msg.push(`Closing: ${closes.map(p => `${p.symbol} (${p.unrealizedPLPct.toFixed(1)}%)`).join(', ')}`);
      if (holds.length > 0) msg.push(`Holding overnight: ${holds.map(p => `${p.symbol} (${p.unrealizedPLPct.toFixed(1)}%)`).join(', ')}`);

      report.reasoning.push({
        thought: `EOD review: ${msg.join('. ')}`,
        decision: closes.length > 0 ? 'PARTIAL_CLOSE' : 'HOLD_ALL',
      });

      await discord.tradeExecution(
        `${this.emoji} **EOD REVIEW** (3:30 PM)\n` +
        (closes.length > 0 ? `Closing: ${closes.map(p => `${p.symbol} (${p.unrealizedPLPct.toFixed(1)}%)`).join(', ')}\n` : '') +
        (holds.length > 0 ? `Holding overnight: ${holds.map(p => `${p.symbol} (${p.unrealizedPLPct.toFixed(1)}%)`).join(', ')}` : '')
      );
    }
  }

  // ============================================================================
  // Shared Brain Update
  // ============================================================================

  _updateSharedBrain(report) {
    brain.writeDayTraderState({
      positions: report.positions,
      account: report.account,
      pnlToday: report.account?.dailyPL || 0,
      tradesCount: brain.ctx.dayTrader.tradesCount,
    });

    brain.logAgent('day-trader', `Monitor scan: ${report.positions.length} positions, ${report.monitoring?.alerts?.length || 0} alerts`);
  }

  // ============================================================================
  // Discord Reports
  // ============================================================================

  /**
   * Send monitoring report to Discord (every 10 min cycle)
   */
  async _sendMonitoringReport(report) {
    const timeET = report.timeET || new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
    let msg = `${this.emoji} **DAY MONITOR** - ${timeET} ET\n\n`;

    // Account
    if (report.account) {
      const pnlEmoji = (report.account.dailyPL || 0) >= 0 ? '🟢' : '🔴';
      msg += `**Account:** $${report.account.equity?.toLocaleString()} | Day P&L: ${pnlEmoji} $${(report.account.dailyPL || 0).toFixed(2)}\n`;
    }

    // Veto stats for today
    msg += `**Veto Gate:** ${this.todaySignals} signals | ${this.todayPasses} passed | ${this.todayVetoes} vetoed\n`;
    msg += '\n';

    // Current positions
    if (report.positions.length > 0) {
      msg += '**Positions:**\n';
      for (const pos of report.positions) {
        const emoji = pos.unrealizedPLPct >= 0 ? '🟢' : '🔴';
        msg += `${emoji} ${pos.symbol}: ${pos.qty}x @ $${pos.avgEntry.toFixed(2)} -> $${pos.currentPrice.toFixed(2)} (${pos.unrealizedPLPct >= 0 ? '+' : ''}${pos.unrealizedPLPct.toFixed(1)}%)\n`;
      }
      msg += '\n';
    }

    // Alerts
    if (report.monitoring?.alerts?.length > 0) {
      msg += '**Alerts:**\n';
      for (const alert of report.monitoring.alerts) {
        const emoji = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'WARNING' ? '⚠️' : 'ℹ️';
        msg += `${emoji} ${alert.message}\n`;
      }
      msg += '\n';
    }

    // Reasoning
    if (report.reasoning.length > 0) {
      msg += '**Status:**\n';
      for (const r of report.reasoning.slice(-3)) {
        msg += `- ${r.decision}: _${r.thought}_\n`;
      }
      msg += '\n';
    }

    // Errors
    if (report.errors.length > 0) {
      msg += '**Errors:** ' + report.errors.join(', ') + '\n';
    }

    // Quiet scan
    if (report.positions.length === 0 && this.todaySignals === 0) {
      msg += '_No positions. Watching for IASM signals..._\n';
    }

    await discord.tradeExecution(msg);
  }

  /**
   * Send daily P&L summary (at 4:15 PM)
   */
  async _sendDailySummary() {
    const dailyReport = await this.getDailyReport();
    const vetoStats = dailyReport.vetoStats;

    let msg = `${this.emoji} **DAILY SUMMARY** - ${dailyReport.timeET} ET\n\n`;

    // Account P&L
    if (dailyReport.account) {
      const pnlEmoji = dailyReport.account.dailyPL >= 0 ? '🟢' : '🔴';
      msg += `**Day P&L:** ${pnlEmoji} $${dailyReport.account.dailyPL.toFixed(2)} (${dailyReport.account.dailyPLPct >= 0 ? '+' : ''}${dailyReport.account.dailyPLPct.toFixed(2)}%)\n`;
      msg += `**Equity:** $${dailyReport.account.equity.toLocaleString()}\n\n`;
    }

    // Veto gate stats
    msg += `**Veto Gate Performance:**\n`;
    msg += `Signals: ${vetoStats.today.signals} | Passed: ${vetoStats.today.passes} | Vetoed: ${vetoStats.today.vetoes}\n`;
    if (vetoStats.allTime.vetoAccuracy !== 'N/A (no outcomes tracked yet)') {
      msg += `Veto Accuracy: ${vetoStats.allTime.vetoAccuracy} | Pass Win Rate: ${vetoStats.allTime.passAccuracy}\n`;
    }
    msg += '\n';

    // Execution summary
    if (dailyReport.executionSummary) {
      const es = dailyReport.executionSummary;
      msg += `**Execution Summary:**\n`;
      msg += `Decisions: ${es.totalDecisions} | Symbols: ${es.symbols.join(', ') || 'None'}\n\n`;
    }

    // Open positions
    if (dailyReport.positions.length > 0) {
      msg += `**Open Positions (${dailyReport.positions.length}):**\n`;
      for (const pos of dailyReport.positions) {
        const emoji = pos.unrealizedPLPct >= 0 ? '🟢' : '🔴';
        msg += `${emoji} ${pos.symbol}: ${pos.unrealizedPLPct >= 0 ? '+' : ''}${pos.unrealizedPLPct.toFixed(1)}% ($${pos.unrealizedPL.toFixed(2)})\n`;
      }
      msg += '\n';
    }

    // Top veto reasons
    if (vetoStats.topVetoReasons.length > 0) {
      msg += `**Top Veto Reasons:**\n`;
      for (const r of vetoStats.topVetoReasons.slice(0, 3)) {
        msg += `- ${r.reason}: ${r.count}x\n`;
      }
    }

    // Errors
    if (dailyReport.errors.length > 0) {
      msg += '\n**Errors:** ' + dailyReport.errors.join(', ') + '\n';
    }

    await discord.pnl(msg);
  }

  // ============================================================================
  // Utility: Update veto outcome (called when a vetoed signal's outcome is known)
  // ============================================================================

  /**
   * Track what would have happened to a vetoed signal.
   * Called by intraday_executor or position_monitor when price moves.
   *
   * @param {string} symbol - The symbol that was vetoed
   * @param {number} wouldHavePL - What P&L would have been if not vetoed
   * @param {string} vetoTimestamp - When the veto happened
   */
  updateVetoOutcome(symbol, wouldHavePL, vetoTimestamp) {
    const stats = loadVetoStats();
    const match = stats.vetoOutcomes.find(v =>
      v.symbol === symbol &&
      v.timestamp === vetoTimestamp &&
      v.wouldHavePL === null
    );
    if (match) {
      match.wouldHavePL = wouldHavePL;
      saveVetoStats(stats);
    }
  }
}

module.exports = DayTraderAgent;
