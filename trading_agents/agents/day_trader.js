/**
 * Day Trader Agent - LLM-Powered Reasoning
 *
 * A reasoning agent that runs every 15-30 minutes during market hours.
 * Uses ALL available data + LLM reasoning to make trading decisions.
 *
 * Data Sources:
 * - Shared brain (overnight, pre-market, sentiment, technicals, catalysts)
 * - StockTwits sentiment & trending
 * - Earnings calendar
 * - Yahoo Finance quotes & technicals
 * - Alpaca options chain & market data
 * - VIX / macro context
 *
 * Decision Engine: LLM (Groq FREE → Haiku → OpenAI → Kimi)
 * The LLM receives ALL data and reasons about what trades to make.
 * No hardcoded scoring - pure reasoning.
 *
 * Trading Style:
 * - Options (calls, puts), equities, ETFs (SPY/QQQ)
 * - Short timeframe focus but CAN hold if thesis supports it
 * - Thesis-driven with technical timing
 * - Risk managed: max loss per trade, max daily loss
 * - No forced EOD flatten - holds overnight when conviction is high
 *
 * Account: Separate Alpaca paper account ($100K, Level 3 options)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

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

// ============================================================================
// RISK PARAMETERS (enforced AFTER LLM decides, as guardrails)
// ============================================================================

const RISK = {
  maxPositionPct: 0.05,       // Max 5% of account per position
  maxDailyLossPct: 0.03,      // Stop trading if down 3% on the day
  maxOpenPositions: 5,         // Max concurrent positions (options + equities)
  maxTradesPerDay: 15,         // Don't overtrade
  cooldownMinutes: 5,          // Min time between trades on same symbol
};

// ============================================================================
// YAHOO FINANCE DATA
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

async function fetchMultiQuotes(symbols) {
  const quotes = {};
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    const results = await Promise.all(batch.map(fetchQuote));
    batch.forEach((s, idx) => { if (results[idx]) quotes[s] = results[idx]; });
    if (i + 5 < symbols.length) await new Promise(r => setTimeout(r, 800));
  }
  return quotes;
}

function fetchVIX() {
  return fetchQuote('^VIX');
}

// ============================================================================
// STOCKTWITS SENTIMENT
// ============================================================================

function fetchStockTwitsSentiment(symbol) {
  return new Promise((resolve) => {
    const url = `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const messages = json.messages || [];
          let bulls = 0, bears = 0;
          messages.forEach(m => {
            if (m.entities?.sentiment?.basic === 'Bullish') bulls++;
            if (m.entities?.sentiment?.basic === 'Bearish') bears++;
          });
          resolve({
            symbol,
            bulls,
            bears,
            total: messages.length,
            ratio: bulls + bears > 0 ? (bulls / (bulls + bears) * 100).toFixed(1) : 50,
            volume: messages.length,
          });
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchStockTwitsTrending() {
  return new Promise((resolve) => {
    const url = 'https://api.stocktwits.com/api/2/trending/symbols.json';
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve((json.symbols || []).map(s => ({
            symbol: s.symbol,
            title: s.title,
            watchlistCount: s.watchlist_count,
          })));
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// ============================================================================
// DAY TRADER AGENT
// ============================================================================

class DayTraderAgent {
  constructor() {
    this.name = 'Day Trader';
    this.emoji = '⚡';
    this.lastRun = null;
    this.tradeLog = [];
  }

  /**
   * Main run function - called every 15-30 min during market hours
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`[${new Date().toISOString()}] ${this.emoji} Day Trader starting... (${timeET} ET)`);

    const report = {
      timestamp: new Date().toISOString(),
      timeET,
      account: null,
      positions: [],
      llmResponse: null,
      trades: [],
      reasoning: [],
      errors: [],
    };

    try {
      // 0. Check if we should be trading
      const shouldTrade = await this.checkTradingConditions();
      if (!shouldTrade.ok) {
        report.reasoning.push({ thought: shouldTrade.reason, decision: 'SKIP' });
        await this.sendReport(report);
        this.lastRun = new Date();
        return report;
      }

      // 1. Get account state
      report.account = await this.getAccountState();

      // 2. Check existing positions
      report.positions = await this.checkPositions();

      // 3. Gather ALL intelligence
      const intel = await this.gatherIntelligence();

      // 4. LLM REASONING - Send ALL data to LLM for decisions
      const llmDecisions = await this.getLLMDecisions(report, intel);
      report.llmResponse = llmDecisions;

      if (llmDecisions) {
        // Log the market assessment
        report.reasoning.push({
          thought: llmDecisions.marketAssessment || 'No assessment',
          decision: 'ANALYSIS',
        });

        if (llmDecisions.portfolioThoughts) {
          report.reasoning.push({
            thought: llmDecisions.portfolioThoughts,
            decision: 'PORTFOLIO',
          });
        }

        // 5. Execute LLM decisions (with risk guardrails)
        const decisions = llmDecisions.decisions || [];
        for (const decision of decisions) {
          try {
            // Apply risk guardrails before execution
            const guardrailCheck = this.applyGuardrails(decision, report);
            if (!guardrailCheck.ok) {
              report.reasoning.push({
                thought: `Guardrail blocked: ${guardrailCheck.reason}`,
                decision: `BLOCKED ${decision.action} ${decision.symbol}`,
              });
              continue;
            }

            const result = await this.executeDecision(decision, report.account);
            report.trades.push(result);
            report.reasoning.push({
              thought: decision.reasoning,
              decision: `${decision.action} ${decision.symbol} (${decision.conviction})`,
            });
          } catch (e) {
            report.errors.push(`Execute ${decision.symbol}: ${e.message}`);
          }
        }

        // Store LLM's data requests for next scan
        if (llmDecisions.needMoreData && llmDecisions.needMoreData.length > 0) {
          brain.addReasoning(
            `LLM wants more data: ${llmDecisions.needMoreData.join(', ')}`,
            'DATA_REQUEST'
          );
        }
      }

      // 6. EOD review (3:30+ PM) - LLM decides what to hold
      if (timeET >= '15:30') {
        await this.eodReview(report);
      }

    } catch (error) {
      report.errors.push(error.message);
      console.error('[DayTrader] Error:', error);
    }

    // Write to shared brain
    this.updateSharedBrain(report);

    // Send report to Discord
    await this.sendReport(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Day Trader completed in ${Date.now() - startTime}ms`);

    return report;
  }

  // ============================================================================
  // Trading Conditions Check
  // ============================================================================

  async checkTradingConditions() {
    if (!daytradeClient) return { ok: false, reason: 'Alpaca client not available' };

    if (!reasoning) return { ok: false, reason: 'LLM reasoning engine not available - no API keys configured' };

    // Check if any LLM provider is available
    const provider = reasoning.findAvailableProvider();
    if (!provider) {
      return { ok: false, reason: 'No LLM provider available. Set GROQ_API_KEY (free), ANTHROPIC_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY' };
    }

    try {
      const clock = await daytradeClient.getClient().getClock();
      if (!clock.is_open) return { ok: false, reason: 'Market closed' };
    } catch (e) {
      // Can't check clock, try anyway
    }

    // Check daily loss limit
    try {
      const pnl = await daytradeClient.getTodayPnL();
      if (pnl.pnlPct <= -RISK.maxDailyLossPct * 100) {
        return { ok: false, reason: `Daily loss limit hit: ${pnl.pnlPct.toFixed(2)}%. Stopping for today.` };
      }
    } catch (e) { /* continue */ }

    // Check trade count
    const ctx = brain.ctx;
    if (ctx.dayTrader.tradesCount >= RISK.maxTradesPerDay) {
      return { ok: false, reason: `Max trades (${RISK.maxTradesPerDay}) reached for today.` };
    }

    return { ok: true, provider };
  }

  // ============================================================================
  // Account & Positions
  // ============================================================================

  async getAccountState() {
    try {
      return await daytradeClient.getAccount();
    } catch (e) {
      return null;
    }
  }

  async checkPositions() {
    try {
      const positions = await daytradeClient.getPositions();
      return (positions || []).map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        side: p.side,
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPL: parseFloat(p.unrealized_pl),
        unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
        assetClass: p.asset_class,
      }));
    } catch (e) {
      return [];
    }
  }

  // ============================================================================
  // Intelligence Gathering
  // ============================================================================

  async gatherIntelligence() {
    const intel = {
      brainBriefing: brain.getDayTraderBriefing(),
      vix: null,
      trending: [],
      topQuotes: {},
      sentimentChecks: {},
    };

    // Get VIX
    intel.vix = await fetchVIX();

    // Get StockTwits trending
    intel.trending = await fetchStockTwitsTrending();

    // Build candidate list from all sources
    const candidates = this.buildCandidateList(intel);

    // Fetch quotes for top candidates
    if (candidates.length > 0) {
      intel.topQuotes = await fetchMultiQuotes(candidates.slice(0, 20));
    }

    // Get sentiment for top movers
    const topMovers = Object.entries(intel.topQuotes)
      .filter(([, q]) => Math.abs(q.changePct) >= 3)
      .sort((a, b) => Math.abs(b[1].changePct) - Math.abs(a[1].changePct))
      .slice(0, 5);

    for (const [symbol] of topMovers) {
      intel.sentimentChecks[symbol] = await fetchStockTwitsSentiment(symbol);
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    }

    return intel;
  }

  buildCandidateList(intel) {
    const candidates = new Set();
    const briefing = intel.brainBriefing;

    (briefing.gappers || []).forEach(g => candidates.add(g.symbol));
    (briefing.movers || []).forEach(m => candidates.add(m.symbol));
    (briefing.dayWatchlist || []).forEach(w => candidates.add(w.symbol));
    (intel.trending || []).slice(0, 10).forEach(t => candidates.add(t.symbol));
    (briefing.trending || []).forEach(t => candidates.add(t.symbol));
    (briefing.technicals?.breakouts || []).forEach(b => candidates.add(b.symbol));
    (briefing.technicals?.volumeSpikes || []).forEach(v => candidates.add(v.symbol));
    (briefing.optionsFlow || []).forEach(o => candidates.add(o.symbol));
    (briefing.earningsToday || []).forEach(e => candidates.add(e.symbol));

    // Liquid names always worth watching
    const alwaysWatch = ['SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'AMD', 'META', 'AMZN', 'MSFT', 'GOOGL', 'GLD', 'SLV', 'USO', 'TLT'];
    alwaysWatch.forEach(s => candidates.add(s));

    return [...candidates];
  }

  // ============================================================================
  // LLM REASONING - The Brain
  // ============================================================================

  /**
   * Package all data and send to LLM for trading decisions
   */
  async getLLMDecisions(report, intel) {
    if (!reasoning) {
      console.error('[DayTrader] LLM reasoning not available');
      return null;
    }

    const briefing = intel.brainBriefing;

    // Build the complete data package for the LLM
    const dataPackage = {
      // Account state
      account: report.account ? {
        equity: report.account.equity,
        cash: report.account.cash,
        buyingPower: report.account.buyingPower,
        dayTradesRemaining: report.account.dayTradesRemaining,
      } : null,

      // Current positions
      positions: report.positions,

      // Today's P&L
      todayPnL: report.account?.dailyPL || briefing.todayPnL || 0,
      tradesCount: briefing.todayTrades || 0,

      // Risk sentiment from overnight
      riskSentiment: briefing.riskSentiment,

      // VIX
      vix: intel.vix ? {
        price: intel.vix.price,
        changePct: intel.vix.changePct,
      } : null,

      // Market indices
      indices: briefing.indices || {},

      // Futures
      futures: briefing.futures || {},

      // Pre-market gappers
      gappers: briefing.gappers || [],

      // Social sentiment
      trending: intel.trending,
      sentimentChecks: intel.sentimentChecks,

      // Earnings & events
      earningsToday: briefing.earningsToday || [],
      economicEvents: briefing.economicEvents || [],

      // Technical signals
      technicals: briefing.technicals || {},

      // Options flow
      optionsFlow: briefing.optionsFlow || [],

      // All quotes (price action)
      topQuotes: intel.topQuotes,

      // Day watchlist
      dayWatchlist: briefing.dayWatchlist || [],

      // Previous reasoning (so LLM can maintain thesis continuity)
      previousReasoning: briefing.previousReasoning || [],
    };

    try {
      const result = await reasoning.reasonAboutTrades(dataPackage);

      // Log which provider was used
      console.log(`[DayTrader] LLM reasoning via ${result._meta?.provider} (${result._meta?.model})`);

      brain.addReasoning(
        `LLM (${result._meta?.provider}): ${result.marketAssessment || 'No assessment'}`,
        result.decisions?.length > 0 ? `${result.decisions.length} trade(s)` : 'NO_TRADE'
      );

      return result;
    } catch (e) {
      console.error('[DayTrader] LLM reasoning failed:', e.message);
      report.errors.push(`LLM reasoning: ${e.message}`);
      return null;
    }
  }

  // ============================================================================
  // Risk Guardrails (applied AFTER LLM decides, as safety checks)
  // ============================================================================

  applyGuardrails(decision, report) {
    // Max positions check
    if (decision.action === 'BUY' && report.positions.length >= RISK.maxOpenPositions) {
      return { ok: false, reason: `Max positions (${RISK.maxOpenPositions}) reached` };
    }

    // Max position size check
    if (decision.action === 'BUY' && report.account) {
      const qty = decision.qty || 1;
      const price = decision.strike || report.account.equity * 0.01; // rough estimate
      const posValue = qty * price * (decision.vehicle === 'OPTION' ? 100 : 1);
      if (posValue > report.account.equity * RISK.maxPositionPct * 1.5) {
        return { ok: false, reason: `Position too large: $${posValue.toFixed(0)} exceeds ${(RISK.maxPositionPct * 100)}% limit` };
      }
    }

    // Don't trade if daily loss limit approaching
    if (decision.action === 'BUY') {
      const dailyPL = report.account?.dailyPL || 0;
      const equity = report.account?.equity || 100000;
      if (dailyPL / equity <= -RISK.maxDailyLossPct * 0.8) {
        return { ok: false, reason: 'Approaching daily loss limit, no new trades' };
      }
    }

    // Cooldown check (don't trade same symbol twice in 5 min)
    const recentTrades = brain.ctx.dayTrader.trades || [];
    const recentSame = recentTrades.filter(t =>
      t.symbol === decision.symbol &&
      Date.now() - new Date(t.time).getTime() < RISK.cooldownMinutes * 60000
    );
    if (recentSame.length > 0 && decision.action === 'BUY') {
      return { ok: false, reason: `Cooldown: traded ${decision.symbol} ${RISK.cooldownMinutes} min ago` };
    }

    return { ok: true };
  }

  // ============================================================================
  // Trade Execution (executes LLM decisions)
  // ============================================================================

  async executeDecision(decision, account) {
    const action = decision.action?.toUpperCase();

    // CLOSE / SELL existing position
    if (action === 'CLOSE' || action === 'SELL') {
      try {
        const result = await daytradeClient.closePosition(decision.symbol);
        brain.addDayTrade({
          symbol: decision.symbol,
          action: 'CLOSE',
          reason: decision.reasoning,
        });
        return { ...decision, status: 'closed', result };
      } catch (e) {
        return { ...decision, status: 'error', error: e.message };
      }
    }

    // BUY / OPEN new position
    if (action === 'BUY') {
      const vehicle = decision.vehicle?.toUpperCase() || 'EQUITY';
      const underlying = decision.symbol;

      // --- EQUITY TRADE ---
      if (vehicle === 'EQUITY') {
        try {
          const acc = await daytradeClient.getAccount();
          const equity = acc.equity;
          const posValue = equity * RISK.maxPositionPct;
          const price = decision.strike || (await fetchQuote(underlying))?.price || 100;
          const shares = decision.qty || Math.floor(posValue / price);
          if (shares < 1) return { ...decision, status: 'skipped', reason: 'Position too small' };

          const side = (decision.direction === 'SHORT' || decision.direction === 'PUT') ? 'sell' : 'buy';
          const order = await daytradeClient.getClient().request('/v2/orders', 'POST', {
            symbol: underlying,
            qty: shares.toString(),
            side,
            type: 'market',
            time_in_force: 'day',
          });

          brain.addDayTrade({
            symbol: underlying,
            action: 'OPEN',
            vehicle: 'EQUITY',
            direction: decision.direction,
            qty: shares,
            reason: decision.reasoning,
            conviction: decision.conviction,
            target: decision.target,
            stop: decision.stop,
            orderId: order?.id,
          });

          return {
            ...decision,
            status: 'executed',
            vehicle: 'EQUITY',
            qty: shares,
            orderId: order?.id,
          };
        } catch (e) {
          return { ...decision, status: 'error', error: e.message };
        }
      }

      // --- OPTION TRADE ---
      if (vehicle === 'OPTION') {
        const type = (decision.direction === 'CALL' || decision.direction === 'LONG') ? 'call' : 'put';

        // Try to find the specific contract the LLM requested
        let contract = null;

        if (decision.strike && decision.expiry) {
          // LLM specified strike and expiry - try to find it
          try {
            contract = await daytradeClient.findContract(
              underlying,
              decision.expiry,
              decision.strike,
              type
            );
          } catch (e) {
            console.warn(`[DayTrader] Couldn't find exact contract: ${e.message}`);
          }
        }

        // Fallback: get weekly options and find nearest
        if (!contract) {
          try {
            const contracts = await daytradeClient.getWeeklyOptions(underlying, type);
            if (!contracts || contracts.length === 0) {
              // No options available, fall back to equity
              return this.executeDecision({
                ...decision,
                vehicle: 'EQUITY',
                direction: type === 'call' ? 'LONG' : 'SHORT',
              }, account);
            }

            const price = (await fetchQuote(underlying))?.price || decision.strike || 100;

            // Find ATM or slightly OTM
            let bestDist = Infinity;
            for (const c of contracts) {
              const strike = parseFloat(c.strike_price);
              const dist = type === 'call' ? strike - price : price - strike;
              if (dist >= 0 && dist < bestDist && dist / price <= 0.03) {
                bestDist = dist;
                contract = c;
              }
            }

            // Fallback: nearest strike
            if (!contract && contracts.length > 0) {
              contract = contracts.reduce((best, c) => {
                const d = Math.abs(parseFloat(c.strike_price) - price);
                return d < Math.abs(parseFloat(best.strike_price) - price) ? c : best;
              }, contracts[0]);
            }
          } catch (e) {
            return { ...decision, status: 'error', error: `Options lookup: ${e.message}` };
          }
        }

        if (!contract) {
          return { ...decision, status: 'skipped', reason: 'No suitable contract found' };
        }

        // Position sizing
        const qty = decision.qty || await daytradeClient.calculatePositionSize(
          RISK.maxPositionPct,
          parseFloat(contract.close_price || contract.open_price || '5')
        );

        try {
          const order = await daytradeClient.buyOption(contract.symbol, Math.max(1, qty));
          brain.addDayTrade({
            symbol: contract.symbol,
            underlying,
            action: 'OPEN',
            vehicle: 'OPTION',
            direction: decision.direction,
            strike: contract.strike_price,
            expiry: contract.expiration_date,
            qty,
            reason: decision.reasoning,
            conviction: decision.conviction,
            target: decision.target,
            stop: decision.stop,
            timeframe: decision.timeframe,
            orderId: order?.id,
          });

          return {
            ...decision,
            status: 'executed',
            vehicle: 'OPTION',
            contract: contract.symbol,
            strike: contract.strike_price,
            expiry: contract.expiration_date,
            qty,
            orderId: order?.id,
          };
        } catch (e) {
          return { ...decision, status: 'error', error: e.message };
        }
      }

      return { ...decision, status: 'skipped', reason: `Unknown vehicle: ${vehicle}` };
    }

    // HOLD - just log it
    if (action === 'HOLD') {
      brain.addReasoning(
        `HOLD ${decision.symbol}: ${decision.reasoning}`,
        'HOLD'
      );
      return { ...decision, status: 'held' };
    }

    return { ...decision, status: 'unknown_action' };
  }

  // ============================================================================
  // EOD Review - LLM decides what to hold vs close
  // ============================================================================

  async eodReview(report) {
    if (report.positions.length === 0) return;

    // For EOD, we can use the LLM or simple rules
    // Simple rules for safety: close 0DTE options and big losers
    const holds = [];
    const closes = [];

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
      // Everything else: hold (LLM already decided thesis during the day)
      holds.push(pos);
    }

    for (const pos of closes) {
      try {
        await daytradeClient.closePosition(pos.symbol);
        brain.addDayTrade({ symbol: pos.symbol, action: 'EOD_CLOSE', reason: 'EOD review - no thesis to hold' });
      } catch (e) {
        report.errors.push(`EOD close ${pos.symbol}: ${e.message}`);
      }
    }

    const msg = [];
    if (closes.length > 0) msg.push(`Closed ${closes.length}: ${closes.map(p => p.symbol).join(', ')}`);
    if (holds.length > 0) msg.push(`Holding ${holds.length}: ${holds.map(p => p.symbol).join(', ')}`);

    report.reasoning.push({
      thought: `EOD review: ${msg.join('. ')}`,
      decision: closes.length > 0 ? 'PARTIAL_CLOSE' : 'HOLD_ALL',
    });

    if (closes.length > 0 || holds.length > 0) {
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

  updateSharedBrain(report) {
    brain.writeDayTraderState({
      positions: report.positions,
      account: report.account,
      pnlToday: report.account?.dailyPL || 0,
      tradesCount: brain.ctx.dayTrader.tradesCount,
    });

    brain.logAgent('day-trader', `Scan complete: ${report.positions.length} positions, ${report.trades.length} new trades`);
  }

  // ============================================================================
  // Discord Report
  // ============================================================================

  async sendReport(report) {
    const timeET = report.timeET || new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
    let msg = `${this.emoji} **DAY TRADER** - ${timeET} ET\n`;

    // LLM provider info
    if (report.llmResponse?._meta) {
      msg += `_via ${report.llmResponse._meta.provider}_\n`;
    }
    msg += '\n';

    // Account
    if (report.account) {
      const pnlEmoji = (report.account.dailyPL || 0) >= 0 ? '🟢' : '🔴';
      msg += `**Account:** $${report.account.equity?.toLocaleString()} | Day P&L: ${pnlEmoji} $${(report.account.dailyPL || 0).toFixed(2)}\n\n`;
    }

    // Market Assessment (from LLM)
    if (report.llmResponse?.marketAssessment) {
      msg += `**Market Read:** ${report.llmResponse.marketAssessment}\n\n`;
    }

    // Trades executed
    if (report.trades.length > 0) {
      msg += '**Trades:**\n';
      for (const trade of report.trades) {
        if (trade.status === 'executed') {
          if (trade.vehicle === 'EQUITY') {
            const dir = trade.direction === 'SHORT' ? '📉 SHORT' : '📈 LONG';
            msg += `${dir} **${trade.symbol}** x${trade.qty} | ${trade.conviction || ''}\n`;
          } else {
            const dir = trade.direction === 'CALL' ? '📈 CALL' : '📉 PUT';
            msg += `${dir} **${trade.symbol}** ${trade.strike} ${trade.expiry} x${trade.qty} | ${trade.conviction || ''}\n`;
          }
          msg += `  _${trade.reasoning}_\n`;
        } else if (trade.status === 'closed') {
          msg += `❌ CLOSED **${trade.symbol}**: _${trade.reasoning}_\n`;
        } else if (trade.status === 'held') {
          msg += `✊ HOLD **${trade.symbol}**: _${trade.reasoning}_\n`;
        } else if (trade.status === 'error') {
          msg += `⚠️ ERROR ${trade.symbol}: ${trade.error}\n`;
        }
      }
      msg += '\n';
    }

    // Current positions
    if (report.positions.length > 0) {
      msg += '**Positions:**\n';
      for (const pos of report.positions) {
        const emoji = pos.unrealizedPLPct >= 0 ? '🟢' : '🔴';
        msg += `${emoji} ${pos.symbol}: ${pos.qty}x @ $${pos.avgEntry.toFixed(2)} → $${pos.currentPrice.toFixed(2)} (${pos.unrealizedPLPct >= 0 ? '+' : ''}${pos.unrealizedPLPct.toFixed(1)}%)\n`;
      }
      msg += '\n';
    }

    // Portfolio thoughts from LLM
    if (report.llmResponse?.portfolioThoughts) {
      msg += `**Portfolio:** ${report.llmResponse.portfolioThoughts}\n\n`;
    }

    // Key reasoning
    if (report.reasoning.length > 0) {
      const keyReasoning = report.reasoning.filter(r => r.decision !== 'ANALYSIS');
      if (keyReasoning.length > 0) {
        msg += '**Reasoning:**\n';
        for (const r of keyReasoning.slice(-4)) {
          msg += `• ${r.decision}: _${r.thought}_\n`;
        }
        msg += '\n';
      }
    }

    // Errors
    if (report.errors.length > 0) {
      msg += '**Errors:** ' + report.errors.join(', ') + '\n';
    }

    // Quiet scan
    if (report.trades.length === 0 && report.positions.length === 0 && !report.llmResponse) {
      msg += '_No LLM reasoning available. Check API key configuration._\n';
    } else if (report.trades.length === 0 && (!report.llmResponse?.decisions || report.llmResponse.decisions.length === 0)) {
      msg += '_LLM found no actionable setups. Watching..._\n';
    }

    await discord.tradeExecution(msg);

    // Send trade alerts to alerts channel
    for (const trade of report.trades) {
      if (trade.status === 'executed') {
        const vehicle = trade.vehicle === 'OPTION'
          ? `${trade.direction} ${trade.strike} ${trade.expiry}`
          : `${trade.direction || 'LONG'}`;
        await discord.alert(
          `${this.emoji} **DAY TRADE** ${vehicle} **${trade.symbol}** x${trade.qty} [${trade.conviction}]\n_${trade.reasoning}_`
        );
      }
    }
  }
}

module.exports = DayTraderAgent;
