/**
 * Alpha 1: ES Futures Microstructure Strategy
 *
 * Deploys the confirmed Lvl3Quant research into a paper trading system.
 * Uses hybrid limit execution with vol-gated entries.
 *
 * RESEARCH BASIS:
 *   - Direction IC = 0.13 (t=4.43, p=0.0001) on 35 days
 *   - On high-vol days (16/35): IC = 0.184, 100% positive days
 *   - Hybrid limit execution: +$10.47/trade, 61% win rate
 *   - Best features: depth_ratio_l1, ask/bid_L1_conc, ofi_5, vol_regime
 *
 * STRATEGY:
 *   1. Vol gate: Only trade when intraday vol > threshold (filters dead days)
 *   2. Direction signal: LightGBM model predicts 3s forward return
 *   3. Entry: Limit order at best bid/ask (earns half-spread)
 *   4. Exit: Limit exit (target) OR stop-loss OR timeout market exit
 *   5. Hold: 5-10 seconds typical
 *
 * INFRASTRUCTURE NEEDED:
 *   - AMP Futures or similar broker with API access
 *   - Real-time ES order book data feed
 *   - Python model server for predictions
 *   - Low-latency execution (< 100ms to CME)
 *
 * This module provides the architecture and paper trading simulation.
 * It can be connected to a live broker API when ready.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

// ============================================================================
// STRATEGY PARAMETERS (from Lvl3Quant research)
// ============================================================================

const PARAMS = {
  // Instrument
  instrument: 'ES',
  tickSize: 0.25,
  tickValue: 12.50,       // $12.50 per tick per contract
  pointValue: 50.00,       // $50.00 per point per contract

  // Costs
  commissionRT: 3.00,      // $3.00 round-trip (AMP + Rithmic + CME)
  slippage: 0.0,            // With limit orders, slippage = 0

  // Vol gate
  volGate: {
    enabled: true,
    metric: 'intraday_range_bps', // Intraday range in basis points
    threshold: 60,                 // Only trade when range > 60bps (= "active" day)
    lookbackBars: 50,              // Look at recent 50 bars to judge activity
  },

  // Signal
  signal: {
    model: 'LightGBM',
    target: 'ret_3s',           // 3-second forward return
    entryThreshold: 0.90,       // Only trade top/bottom 10% of predictions
    minConfidence: 0.55,        // Model must be > 55% confident
    features: [
      'ask_L1_conc', 'depth_ratio_l1', 'bid_L1_conc',
      'ask_L1_orders', 'vol_regime', 'ofi_5', 'ofi_20',
      'total_bid_vol', 'pressure_imbalance', 'cancel_asym_20',
    ],
  },

  // Execution
  execution: {
    orderType: 'LIMIT',          // Limit orders only
    entryOffset: 0,              // Place at best bid/ask (0 tick offset)
    holdMinSec: 3,               // Minimum hold 3 seconds
    holdMaxSec: 10,              // Maximum hold 10 seconds
    stopLossTicks: 3.0,          // 3 tick stop loss ($37.50)
    profitTargetTicks: 1.0,      // 1 tick profit target ($12.50)
    timeoutAction: 'MARKET_EXIT', // Market exit on timeout
    maxPositionContracts: 1,     // Start with 1 contract
  },

  // Risk management
  risk: {
    maxDailyLossDollars: 500,    // Stop trading after $500 daily loss
    maxDailyLossTicks: 40,       // = $500 / $12.50
    maxConsecutiveLosses: 5,     // Pause after 5 consecutive losses
    maxDailyTrades: 200,         // Max 200 trades per day
    cooldownAfterLossSec: 30,    // 30 second cooldown after a loss
    flatByTime: '15:45',         // Flatten all positions by 3:45 PM ET
  },

  // Paper trading simulation
  simulation: {
    fillModel: 'QUEUE_REALISTIC', // Options: INSTANT, MID_TOUCH, QUEUE_REALISTIC
    queuePosition: 5,             // Assume 5th in queue
    fillProbability3s: 0.065,     // 6.5% chance of fill in 3 seconds (from research)
    latencyMs: 100,               // 100ms simulated latency
  },
};

// State file
const STATE_FILE = path.join(__dirname, '..', 'data', 'es_micro_state.json');
const TRADES_FILE = path.join(__dirname, '..', 'data', 'es_micro_trades.jsonl');

// ============================================================================
// ES FUTURES DATA (real-time proxy via Yahoo Finance /MES=F or /ES=F)
// ============================================================================

function fetchESQuote() {
  return new Promise((resolve) => {
    // Try micro E-mini first, then full ES
    const symbols = ['ES=F', 'MES=F'];
    let resolved = false;

    for (const sym of symbols) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (resolved) return;
          try {
            const json = JSON.parse(data);
            const result = json.chart?.result?.[0];
            if (!result) return;

            const meta = result.meta;
            const quotes = result.indicators?.quote?.[0];
            const timestamps = result.timestamp || [];
            const len = timestamps.length;

            // Calculate intraday range in basis points
            const highs = (quotes?.high || []).filter(h => h != null);
            const lows = (quotes?.low || []).filter(l => l != null);
            const intradayHigh = highs.length > 0 ? Math.max(...highs) : meta.regularMarketPrice;
            const intradayLow = lows.length > 0 ? Math.min(...lows) : meta.regularMarketPrice;
            const rangeBps = ((intradayHigh - intradayLow) / meta.regularMarketPrice) * 10000;

            // Recent volatility (last 50 1-min bars)
            const recentCloses = (quotes?.close || []).filter(c => c != null).slice(-50);
            let sumSqRet = 0;
            for (let i = 1; i < recentCloses.length; i++) {
              const ret = (recentCloses[i] - recentCloses[i - 1]) / recentCloses[i - 1];
              sumSqRet += ret * ret;
            }
            const recentVol = recentCloses.length > 1
              ? Math.sqrt(sumSqRet / (recentCloses.length - 1)) * 10000  // in bps
              : 0;

            resolved = true;
            resolve({
              symbol: sym,
              price: meta.regularMarketPrice,
              prevClose: meta.previousClose || meta.chartPreviousClose,
              change: meta.regularMarketPrice - (meta.previousClose || meta.regularMarketPrice),
              changePct: ((meta.regularMarketPrice - (meta.previousClose || meta.regularMarketPrice)) / (meta.previousClose || meta.regularMarketPrice) * 100),
              intradayHigh,
              intradayLow,
              rangeBps: Math.round(rangeBps * 10) / 10,
              recentVolBps: Math.round(recentVol * 10) / 10,
              barsAvailable: len,
              lastBarTime: timestamps.length > 0 ? new Date(timestamps[len - 1] * 1000).toISOString() : null,
            });
          } catch (e) { /* try next symbol */ }
        });
      }).on('error', () => { /* try next */ });
    }

    // Timeout
    setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 10000);
  });
}

// ============================================================================
// PAPER TRADING ENGINE
// ============================================================================

class PaperTradingEngine {
  constructor() {
    this.positions = [];       // Current open positions
    this.pendingOrders = [];   // Pending limit orders
    this.todayTrades = [];     // Today's completed trades
    this.todayPnL = 0;
    this.consecutiveLosses = 0;
    this.lastTradeTime = 0;
    this.tradingPaused = false;
    this.pauseReason = null;
  }

  /**
   * Simulate a trade signal and execution
   */
  async processSignal(esData, signalDirection, signalStrength) {
    if (!esData) return { status: 'NO_DATA' };

    // Risk checks
    const riskCheck = this._checkRiskLimits();
    if (riskCheck.blocked) return { status: 'RISK_BLOCKED', reason: riskCheck.reason };

    // Vol gate
    if (PARAMS.volGate.enabled) {
      if (esData.rangeBps < PARAMS.volGate.threshold) {
        return { status: 'VOL_GATE', reason: `Range ${esData.rangeBps}bps < threshold ${PARAMS.volGate.threshold}bps` };
      }
    }

    // Already in position
    if (this.positions.length > 0) {
      return { status: 'IN_POSITION', reason: 'Already holding a position' };
    }

    // Signal threshold
    if (Math.abs(signalStrength) < PARAMS.signal.entryThreshold) {
      return { status: 'BELOW_THRESHOLD', reason: `Signal ${signalStrength.toFixed(3)} < threshold ${PARAMS.signal.entryThreshold}` };
    }

    // Cooldown after loss
    if (Date.now() - this.lastTradeTime < PARAMS.risk.cooldownAfterLossSec * 1000 && this.consecutiveLosses > 0) {
      return { status: 'COOLDOWN', reason: `Cooling down after ${this.consecutiveLosses} losses` };
    }

    // Simulate entry
    const direction = signalDirection; // 'LONG' or 'SHORT'
    const entryPrice = esData.price;   // In real system, this would be best bid/ask

    // Simulate fill (based on fill model)
    const filled = this._simulateFill(esData);
    if (!filled) {
      return { status: 'NO_FILL', reason: 'Limit order not filled (queue position too far back)' };
    }

    // Create position
    const position = {
      direction,
      entryPrice,
      entryTime: Date.now(),
      contracts: PARAMS.execution.maxPositionContracts,
      stopLoss: direction === 'LONG'
        ? entryPrice - PARAMS.execution.stopLossTicks * PARAMS.tickSize
        : entryPrice + PARAMS.execution.stopLossTicks * PARAMS.tickSize,
      profitTarget: direction === 'LONG'
        ? entryPrice + PARAMS.execution.profitTargetTicks * PARAMS.tickSize
        : entryPrice - PARAMS.execution.profitTargetTicks * PARAMS.tickSize,
      signalStrength,
    };

    this.positions.push(position);

    return {
      status: 'ENTERED',
      position,
      message: `${direction} ${PARAMS.instrument} @ ${entryPrice.toFixed(2)} | SL: ${position.stopLoss.toFixed(2)} | TP: ${position.profitTarget.toFixed(2)}`,
    };
  }

  /**
   * Check and close positions (called every tick/bar)
   */
  checkExits(currentPrice) {
    const exits = [];

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      const holdTimeMs = Date.now() - pos.entryTime;
      const holdTimeSec = holdTimeMs / 1000;

      let exitReason = null;
      let exitPrice = currentPrice;

      // Stop loss
      if (pos.direction === 'LONG' && currentPrice <= pos.stopLoss) {
        exitReason = 'STOP_LOSS';
        exitPrice = pos.stopLoss;
      } else if (pos.direction === 'SHORT' && currentPrice >= pos.stopLoss) {
        exitReason = 'STOP_LOSS';
        exitPrice = pos.stopLoss;
      }

      // Profit target
      if (!exitReason) {
        if (pos.direction === 'LONG' && currentPrice >= pos.profitTarget) {
          exitReason = 'PROFIT_TARGET';
          exitPrice = pos.profitTarget;
        } else if (pos.direction === 'SHORT' && currentPrice <= pos.profitTarget) {
          exitReason = 'PROFIT_TARGET';
          exitPrice = pos.profitTarget;
        }
      }

      // Timeout
      if (!exitReason && holdTimeSec >= PARAMS.execution.holdMaxSec) {
        exitReason = 'TIMEOUT';
        exitPrice = currentPrice;
      }

      if (exitReason) {
        // Calculate P&L
        const priceDiff = pos.direction === 'LONG'
          ? exitPrice - pos.entryPrice
          : pos.entryPrice - exitPrice;
        const ticks = priceDiff / PARAMS.tickSize;
        const grossPnL = ticks * PARAMS.tickValue * pos.contracts;
        const netPnL = grossPnL - PARAMS.commissionRT;

        const trade = {
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice,
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime: new Date().toISOString(),
          holdTimeSec: Math.round(holdTimeSec * 10) / 10,
          ticks: Math.round(ticks * 100) / 100,
          grossPnL: Math.round(grossPnL * 100) / 100,
          netPnL: Math.round(netPnL * 100) / 100,
          exitReason,
          contracts: pos.contracts,
          signalStrength: pos.signalStrength,
        };

        this.todayTrades.push(trade);
        this.todayPnL += netPnL;
        this.lastTradeTime = Date.now();

        if (netPnL < 0) {
          this.consecutiveLosses++;
        } else {
          this.consecutiveLosses = 0;
        }

        this.positions.splice(i, 1);
        exits.push(trade);

        // Append to trades log
        this._logTrade(trade);
      }
    }

    return exits;
  }

  /**
   * Simulate fill probability
   */
  _simulateFill(esData) {
    if (PARAMS.simulation.fillModel === 'INSTANT') return true;

    // Queue-realistic: use empirical fill probability
    const fillProb = PARAMS.simulation.fillProbability3s;
    return Math.random() < fillProb;
  }

  /**
   * Check risk limits
   */
  _checkRiskLimits() {
    if (this.todayPnL <= -PARAMS.risk.maxDailyLossDollars) {
      return { blocked: true, reason: `Daily loss limit: $${Math.abs(this.todayPnL).toFixed(2)} >= $${PARAMS.risk.maxDailyLossDollars}` };
    }
    if (this.todayTrades.length >= PARAMS.risk.maxDailyTrades) {
      return { blocked: true, reason: `Max daily trades: ${this.todayTrades.length} >= ${PARAMS.risk.maxDailyTrades}` };
    }
    if (this.consecutiveLosses >= PARAMS.risk.maxConsecutiveLosses) {
      return { blocked: true, reason: `Consecutive losses: ${this.consecutiveLosses} >= ${PARAMS.risk.maxConsecutiveLosses}` };
    }

    // Time check - flatten by 3:45 PM ET
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    if (timeET >= PARAMS.risk.flatByTime) {
      return { blocked: true, reason: `Past flatten time: ${timeET} >= ${PARAMS.risk.flatByTime}` };
    }

    return { blocked: false };
  }

  /**
   * Log trade to JSONL file
   */
  _logTrade(trade) {
    try {
      fs.appendFileSync(TRADES_FILE, JSON.stringify(trade) + '\n');
    } catch (e) {}
  }

  /**
   * Get daily summary stats
   */
  getDailySummary() {
    const wins = this.todayTrades.filter(t => t.netPnL > 0);
    const losses = this.todayTrades.filter(t => t.netPnL <= 0);

    return {
      totalTrades: this.todayTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.todayTrades.length > 0 ? (wins.length / this.todayTrades.length * 100).toFixed(1) : '0.0',
      grossPnL: this.todayTrades.reduce((s, t) => s + t.grossPnL, 0).toFixed(2),
      netPnL: this.todayPnL.toFixed(2),
      commission: (this.todayTrades.length * PARAMS.commissionRT).toFixed(2),
      avgWin: wins.length > 0 ? (wins.reduce((s, t) => s + t.netPnL, 0) / wins.length).toFixed(2) : '0.00',
      avgLoss: losses.length > 0 ? (losses.reduce((s, t) => s + t.netPnL, 0) / losses.length).toFixed(2) : '0.00',
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.netPnL)).toFixed(2) : '0.00',
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.netPnL)).toFixed(2) : '0.00',
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  /**
   * Reset for new trading day
   */
  resetDay() {
    this.positions = [];
    this.pendingOrders = [];
    this.todayTrades = [];
    this.todayPnL = 0;
    this.consecutiveLosses = 0;
    this.tradingPaused = false;
    this.pauseReason = null;
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
    lastRun: null,
    lastTradeDate: null,
    totalTradesAllTime: 0,
    totalPnLAllTime: 0,
    dailyResults: [],
    brokerStatus: 'NOT_CONNECTED',
    modelStatus: 'NOT_LOADED',
  };
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  if (state.dailyResults.length > 90) state.dailyResults = state.dailyResults.slice(-90);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// MAIN AGENT
// ============================================================================

class ESMicrostructureTrader {
  constructor() {
    this.name = 'ES Microstructure';
    this.emoji = '⚡';
    this.engine = new PaperTradingEngine();
    this.lastRun = null;
  }

  /**
   * Main run — monitor ES, check vol gate, simulate signals
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`[${new Date().toISOString()}] ${this.emoji} ES Microstructure starting... (${timeET} ET)`);

    const state = loadState();
    const report = {
      timestamp: new Date().toISOString(),
      timeET,
      esData: null,
      volGateStatus: null,
      signal: null,
      execution: null,
      exits: [],
      dailySummary: null,
      errors: [],
    };

    try {
      // Check if new day
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (state.lastTradeDate !== today) {
        // Save yesterday's results
        if (state.lastTradeDate && this.engine.todayTrades.length > 0) {
          state.dailyResults.push({
            date: state.lastTradeDate,
            ...this.engine.getDailySummary(),
          });
          state.totalTradesAllTime += this.engine.todayTrades.length;
          state.totalPnLAllTime += this.engine.todayPnL;
        }
        this.engine.resetDay();
        state.lastTradeDate = today;
      }

      // 1. Fetch ES data
      report.esData = await fetchESQuote();
      if (!report.esData) {
        report.errors.push('Could not fetch ES data');
        return report;
      }

      // 2. Vol gate check
      const volActive = report.esData.rangeBps >= PARAMS.volGate.threshold;
      report.volGateStatus = {
        active: volActive,
        rangeBps: report.esData.rangeBps,
        threshold: PARAMS.volGate.threshold,
        recentVolBps: report.esData.recentVolBps,
      };

      // 3. Generate simulated signal
      // In production, this would come from the LightGBM model server
      // For now, generate a random signal weighted by momentum
      const direction = report.esData.changePct > 0.1 ? 'LONG' : report.esData.changePct < -0.1 ? 'SHORT' : null;
      const signalStrength = direction ? 0.9 + Math.random() * 0.1 : 0.5; // Simulated

      if (direction) {
        report.signal = { direction, strength: signalStrength };

        // 4. Process through paper trading engine
        report.execution = await this.engine.processSignal(report.esData, direction, signalStrength);
      }

      // 5. Check exits on existing positions
      if (report.esData.price) {
        report.exits = this.engine.checkExits(report.esData.price);
      }

      // 6. Get daily summary
      report.dailySummary = this.engine.getDailySummary();

      // Save state
      saveState(state);

    } catch (error) {
      report.errors.push(error.message);
      console.error('[ESMicro] Error:', error);
    }

    // Send Discord report
    await this._sendReport(report);

    // Update brain
    this._updateBrain(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} ES Microstructure completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Get the strategy specification (for broker setup planning)
   */
  getSpec() {
    return {
      strategy: 'ES Microstructure Hybrid Limit',
      instrument: 'ES (S&P 500 E-mini Futures)',
      exchange: 'CME GLOBEX',
      timeframe: '100ms - 1s bars',
      holdPeriod: '3-10 seconds',
      targetTradesPerDay: '50-200',
      capitalRequired: '$15,000 (1 contract margin + buffer)',
      expectedDailyPnL: '+$200-500 (on active days)',
      expectedSharpe: '2-5 (annualized)',
      broker: {
        recommended: 'AMP Futures',
        alternative: ['Interactive Brokers', 'TradeStation'],
        api: 'Rithmic R|API (recommended) or CQG',
        commissionRT: '$3.00 (AMP clearing + exchange)',
      },
      dataFeed: {
        required: 'CME MDP 3.0 Level 3 (MBO)',
        provider: 'Databento (historical) + Rithmic (real-time)',
        costPerMonth: '$200-500',
      },
      infrastructure: {
        colocation: 'Not required (home internet OK for 3-10s holds)',
        latency: '< 100ms acceptable',
        compute: 'LightGBM inference < 1ms on CPU',
      },
      researchBasis: {
        ic: 0.135,
        tStat: 4.43,
        daysValidated: 35,
        winRateOnActiveDays: '100%',
        averageICActiveDays: 0.184,
      },
      nextSteps: [
        '1. Open AMP Futures demo account (free)',
        '2. Install Rithmic platform and get API access',
        '3. Build Python model server (serve LightGBM predictions via REST)',
        '4. Build Node.js execution bridge (Rithmic API → model → orders)',
        '5. Paper trade for 2-4 weeks with 1 contract',
        '6. Validate fill rates vs simulation assumptions',
        '7. Go live with 1 contract, scale based on results',
      ],
    };
  }

  /**
   * Send Discord report
   */
  async _sendReport(report) {
    let msg = `${this.emoji} **ES MICROSTRUCTURE** — ${report.timeET} ET\n\n`;

    // ES data
    if (report.esData) {
      const d = report.esData;
      msg += `**${d.symbol}:** $${d.price?.toFixed(2)} (${d.changePct >= 0 ? '+' : ''}${d.changePct?.toFixed(2)}%)\n`;
      msg += `Range: ${d.rangeBps}bps | Recent Vol: ${d.recentVolBps}bps\n`;
    }

    // Vol gate
    if (report.volGateStatus) {
      const gateEmoji = report.volGateStatus.active ? '🟢' : '🔴';
      msg += `Vol Gate: ${gateEmoji} ${report.volGateStatus.active ? 'ACTIVE' : 'BLOCKED'} (${report.volGateStatus.rangeBps}bps / ${report.volGateStatus.threshold}bps threshold)\n\n`;
    }

    // Signal & execution
    if (report.signal) {
      msg += `Signal: ${report.signal.direction} (strength: ${report.signal.strength.toFixed(3)})\n`;
    }
    if (report.execution) {
      msg += `Execution: ${report.execution.status}${report.execution.reason ? ' — ' + report.execution.reason : ''}\n`;
      if (report.execution.message) msg += `${report.execution.message}\n`;
    }

    // Exits
    if (report.exits.length > 0) {
      msg += `\n**Exits:**\n`;
      for (const exit of report.exits) {
        const emoji = exit.netPnL >= 0 ? '💰' : '🛑';
        msg += `${emoji} ${exit.direction} ${exit.exitReason}: ${exit.ticks >= 0 ? '+' : ''}${exit.ticks}t ($${exit.netPnL >= 0 ? '+' : ''}${exit.netPnL}) | Hold: ${exit.holdTimeSec}s\n`;
      }
    }

    // Daily summary
    if (report.dailySummary && report.dailySummary.totalTrades > 0) {
      const s = report.dailySummary;
      msg += `\n**Daily Summary:**\n`;
      msg += `Trades: ${s.totalTrades} | Wins: ${s.wins} (${s.winRate}%) | Net P&L: $${s.netPnL}\n`;
      msg += `Avg Win: $${s.avgWin} | Avg Loss: $${s.avgLoss} | Commission: $${s.commission}\n`;
    } else {
      msg += `\n_Paper trading engine ready. Awaiting model server connection._\n`;
      msg += `_Status: SIMULATION MODE (random signals for testing)_\n`;
    }

    if (report.errors.length > 0) {
      msg += `\n**Errors:** ${report.errors.join(', ')}\n`;
    }

    try {
      await discord.tradeExecution(msg);
    } catch (e) {
      console.warn('[ESMicro] Discord error:', e.message);
    }
  }

  /**
   * Update brain
   */
  _updateBrain(report) {
    brain.logAgent('es-micro', `ES: $${report.esData?.price?.toFixed(2) || 'N/A'} | Vol Gate: ${report.volGateStatus?.active ? 'ACTIVE' : 'BLOCKED'} | Trades: ${report.dailySummary?.totalTrades || 0}`);
  }
}

module.exports = ESMicrostructureTrader;
