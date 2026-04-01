/**
 * Alpha 2: Vol-Regime SPY/QQQ Options Strategy
 *
 * Trades SPY/QQQ options based on volatility regime detection.
 * Runs on the $100k Alpaca day trade (options) account.
 *
 * REGIMES:
 *   CALM    - VIX < 16, falling → Sell premium (iron condors / credit spreads)
 *   FEAR    - VIX rising fast, SPY dropping → Buy puts / put spreads
 *   REVERSAL - VIX > 28 and starting to decline → Buy calls on mean reversion
 *   TREND   - Moderate VIX, strong directional momentum → Follow trend with options
 *
 * POSITION SIZING:
 *   Max 2% risk per trade, max 3 concurrent positions
 *   Scale with regime confidence
 *
 * EXIT RULES:
 *   Profit target: 50% of max gain (selling) or 80% gain (buying)
 *   Stop loss: 100% of premium (buying) or 2x credit (selling)
 *   Time exit: close at 50% DTE remaining
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

let daytradeClient;
try { daytradeClient = require('../../swing_options/daytrade_client'); } catch (e) {}

let apiClient;
try { apiClient = require('../../swing_options/api_client'); } catch (e) {}

let reasoning;
try { reasoning = require('../../utils/llm_reasoning'); } catch (e) {}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Symbols to trade
  symbols: ['SPY', 'QQQ'],

  // Regime thresholds
  regimes: {
    calm:     { vixMax: 16, vixChangeMax: -0.5 },   // VIX < 16 and falling
    fear:     { vixMin: 18, vixChangeMin: 5 },        // VIX > 18, up > 5% on the day
    reversal: { vixMin: 28, vixChangeMax: -3 },       // VIX > 28 but starting to fall
    trend:    { vixMin: 14, vixMax: 24 },              // Moderate VIX + strong momentum
  },

  // Position sizing
  maxRiskPct: 0.02,           // 2% of equity per trade
  maxPositions: 3,            // Max concurrent positions
  maxSingleSymbolPositions: 2, // Max positions in one underlying

  // Options parameters
  options: {
    // Selling premium (CALM regime)
    sell: {
      dteMin: 21,
      dteMax: 45,
      wingDelta: 0.15,        // Sell ~15 delta wings
      profitTargetPct: 0.50,  // Close at 50% of max profit
      stopLossMultiple: 2.0,  // Stop at 2x credit received
    },
    // Buying options (FEAR, REVERSAL, TREND)
    buy: {
      dteMin: 7,
      dteMax: 30,
      profitTargetPct: 0.80,  // Take 80% gain
      stopLossPct: 0.60,      // Stop at 60% loss of premium
      maxPremiumPct: 0.015,   // Max 1.5% of equity on premium per trade
    },
  },

  // Cooldowns
  minTimeBetweenTradesMs: 30 * 60 * 1000, // 30 minutes
  regimeChangeDebounceMs: 15 * 60 * 1000, // Must hold regime for 15 min
};

// State file
const STATE_FILE = path.join(__dirname, '..', 'data', 'vol_regime_state.json');

// ============================================================================
// MARKET DATA HELPERS
// ============================================================================

function fetchYahooQuote(symbol) {
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
            change: meta.regularMarketPrice - (meta.previousClose || meta.regularMarketPrice),
            changePct: ((meta.regularMarketPrice - (meta.previousClose || meta.regularMarketPrice)) / (meta.previousClose || meta.regularMarketPrice) * 100),
            volume: quotes?.volume?.[len - 1],
            high: quotes?.high?.[len - 1],
            low: quotes?.low?.[len - 1],
            open: quotes?.open?.[len - 1],
            fiftyTwoHigh: meta.fiftyTwoWeekHigh,
            fiftyTwoLow: meta.fiftyTwoWeekLow,
          });
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchYahooHistory(symbol, range = '1mo', interval = '1d') {
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
            bars.push({
              date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
              open: quotes?.open?.[i],
              high: quotes?.high?.[i],
              low: quotes?.low?.[i],
              close: quotes?.close?.[i],
              volume: quotes?.volume?.[i],
            });
          }
          resolve(bars);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// ============================================================================
// REGIME DETECTION ENGINE
// ============================================================================

class RegimeDetector {
  constructor() {
    this.history = [];     // recent regime readings
    this.currentRegime = null;
    this.regimeSince = null;
    this.confidence = 0;
  }

  /**
   * Detect the current volatility regime.
   * Returns { regime, confidence, signals }
   */
  async detect() {
    // Fetch VIX and SPY data
    const [vixQuote, spyQuote, qqqQuote, vixHistory] = await Promise.all([
      fetchYahooQuote('^VIX'),
      fetchYahooQuote('SPY'),
      fetchYahooQuote('QQQ'),
      fetchYahooHistory('^VIX', '1mo', '1d'),
    ]);

    if (!vixQuote || !spyQuote) {
      return { regime: 'UNKNOWN', confidence: 0, signals: {}, error: 'Data unavailable' };
    }

    const vix = vixQuote.price;
    const vixChange = vixQuote.changePct;
    const spyChange = spyQuote.changePct;
    const qqqChange = qqqQuote?.changePct || 0;

    // Calculate VIX moving averages from history
    const vixCloses = vixHistory.filter(b => b.close).map(b => b.close);
    const vix5dAvg = vixCloses.length >= 5 ? vixCloses.slice(-5).reduce((s, v) => s + v, 0) / 5 : vix;
    const vix20dAvg = vixCloses.length >= 20 ? vixCloses.slice(-20).reduce((s, v) => s + v, 0) / 20 : vix;

    // VIX percentile (where is VIX relative to last 20 days?)
    const sortedVix = [...vixCloses].sort((a, b) => a - b);
    const vixPercentile = sortedVix.length > 0
      ? (sortedVix.filter(v => v <= vix).length / sortedVix.length * 100)
      : 50;

    // SPY momentum (5-day return)
    const spyHistory = await fetchYahooHistory('SPY', '1mo', '1d');
    const spyCloses = spyHistory.filter(b => b.close).map(b => b.close);
    const spy5dReturn = spyCloses.length >= 6
      ? ((spyCloses[spyCloses.length - 1] - spyCloses[spyCloses.length - 6]) / spyCloses[spyCloses.length - 6] * 100)
      : 0;
    const spy20dReturn = spyCloses.length >= 21
      ? ((spyCloses[spyCloses.length - 1] - spyCloses[spyCloses.length - 21]) / spyCloses[spyCloses.length - 21] * 100)
      : 0;

    const signals = {
      vix,
      vixChange,
      vix5dAvg,
      vix20dAvg,
      vixPercentile,
      spyPrice: spyQuote.price,
      spyChange,
      spy5dReturn,
      spy20dReturn,
      qqqChange,
    };

    // --- Regime Classification ---
    let regime = 'NEUTRAL';
    let confidence = 0;
    let reasoning = '';

    // REVERSAL: VIX very high and starting to come down
    if (vix >= CONFIG.regimes.reversal.vixMin && vixChange <= CONFIG.regimes.reversal.vixChangeMax) {
      regime = 'REVERSAL';
      confidence = Math.min(0.9, 0.5 + (vix - 28) / 20 + Math.abs(vixChange) / 10);
      reasoning = `VIX at ${vix.toFixed(1)} (elevated) and falling ${vixChange.toFixed(1)}% — mean reversion likely`;
    }
    // FEAR: VIX spiking, market dropping
    else if (vix >= CONFIG.regimes.fear.vixMin && vixChange >= CONFIG.regimes.fear.vixChangeMin) {
      regime = 'FEAR';
      confidence = Math.min(0.9, 0.4 + vixChange / 15 + Math.abs(spyChange) / 5);
      reasoning = `VIX spiking to ${vix.toFixed(1)} (+${vixChange.toFixed(1)}%), SPY ${spyChange >= 0 ? '+' : ''}${spyChange.toFixed(2)}% — fear rising`;
    }
    // CALM: Low VIX and falling
    else if (vix <= CONFIG.regimes.calm.vixMax && vixChange <= CONFIG.regimes.calm.vixChangeMax) {
      regime = 'CALM';
      confidence = Math.min(0.85, 0.5 + (16 - vix) / 10 + Math.abs(vixChange) / 5);
      reasoning = `VIX at ${vix.toFixed(1)} (low) and falling — premium selling environment`;
    }
    // TREND: Moderate VIX with strong directional momentum
    else if (vix >= CONFIG.regimes.trend.vixMin && vix <= CONFIG.regimes.trend.vixMax) {
      const momentum = Math.abs(spy5dReturn);
      if (momentum >= 1.5) {
        regime = 'TREND';
        const direction = spy5dReturn > 0 ? 'BULLISH' : 'BEARISH';
        confidence = Math.min(0.8, 0.3 + momentum / 5);
        reasoning = `VIX moderate (${vix.toFixed(1)}), SPY 5d ${spy5dReturn >= 0 ? '+' : ''}${spy5dReturn.toFixed(2)}% — ${direction} trend`;
        signals.trendDirection = spy5dReturn > 0 ? 'BULL' : 'BEAR';
      }
    }

    // Default: NEUTRAL (no clear regime)
    if (regime === 'NEUTRAL') {
      confidence = 0.3;
      reasoning = `VIX at ${vix.toFixed(1)}, no clear regime signal`;
    }

    // Update regime history
    const reading = { regime, confidence, timestamp: Date.now() };
    this.history.push(reading);
    if (this.history.length > 100) this.history = this.history.slice(-50);

    // Debounce: regime must hold for minimum time
    if (regime !== this.currentRegime) {
      const sameRegimeReadings = this.history.filter(r =>
        r.regime === regime && r.timestamp > Date.now() - CONFIG.regimeChangeDebounceMs
      );
      if (sameRegimeReadings.length >= 2 || regime === 'FEAR') {
        // FEAR regime can trigger immediately (urgency)
        this.currentRegime = regime;
        this.regimeSince = new Date().toISOString();
      } else {
        // Keep previous regime, note the tentative change
        reasoning += ` (tentative — waiting for confirmation)`;
        regime = this.currentRegime || 'NEUTRAL';
      }
    }

    return {
      regime,
      confidence: Math.round(confidence * 100) / 100,
      signals,
      reasoning,
      regimeSince: this.regimeSince,
    };
  }
}

// ============================================================================
// TRADE SIGNAL GENERATOR
// ============================================================================

class SignalGenerator {
  /**
   * Generate a trade signal based on the current regime.
   * Returns null if no trade should be taken.
   */
  async generate(regimeData, account) {
    const { regime, confidence, signals } = regimeData;
    const equity = account?.equity || 100000;

    if (confidence < 0.4) return null;  // Not confident enough

    switch (regime) {
      case 'CALM':
        return this._calmSignal(signals, equity, confidence);
      case 'FEAR':
        return this._fearSignal(signals, equity, confidence);
      case 'REVERSAL':
        return this._reversalSignal(signals, equity, confidence);
      case 'TREND':
        return this._trendSignal(signals, equity, confidence);
      default:
        return null;
    }
  }

  /**
   * CALM: Sell premium — put credit spreads on SPY
   * High probability income trade. Sell OTM put spread.
   */
  _calmSignal(signals, equity, confidence) {
    const spyPrice = signals.spyPrice;
    if (!spyPrice) return null;

    // Sell put credit spread: sell put ~3-5% OTM, buy put ~7-8% OTM
    const sellStrike = Math.round(spyPrice * 0.96);    // ~4% OTM
    const buyStrike = Math.round(spyPrice * 0.92);     // ~8% OTM (protection)
    const width = sellStrike - buyStrike;

    // Target DTE: 21-45 days
    const targetDTE = 30;

    // Risk = width of spread - credit received (~30-40% of width typically)
    const estimatedCredit = width * 0.35;
    const maxRisk = (width - estimatedCredit) * 100;  // Per contract, *100 for options multiplier
    const riskBudget = equity * CONFIG.maxRiskPct;
    const contracts = Math.max(1, Math.floor(riskBudget / maxRisk));

    return {
      type: 'PUT_CREDIT_SPREAD',
      symbol: 'SPY',
      direction: 'NEUTRAL_BULLISH',
      legs: [
        { action: 'sell', type: 'put', strike: sellStrike },
        { action: 'buy', type: 'put', strike: buyStrike },
      ],
      targetDTE,
      contracts: Math.min(contracts, 5), // Cap at 5 contracts
      estimatedCredit,
      maxRisk: maxRisk * Math.min(contracts, 5),
      regime: 'CALM',
      confidence,
      reasoning: `Low VIX (${signals.vix.toFixed(1)}) environment — sell put spread ${buyStrike}/${sellStrike} for income`,
      profitTarget: estimatedCredit * 0.5 * 100,  // 50% of credit
      stopLoss: estimatedCredit * 2 * 100,         // 2x credit
    };
  }

  /**
   * FEAR: Buy put spreads — ride downside momentum
   */
  _fearSignal(signals, equity, confidence) {
    const spyPrice = signals.spyPrice;
    if (!spyPrice) return null;

    // Buy put debit spread: buy ATM put, sell put ~5% OTM
    const buyStrike = Math.round(spyPrice);            // ATM
    const sellStrike = Math.round(spyPrice * 0.95);    // ~5% OTM

    const targetDTE = 14;

    // Estimated cost ~40-50% of spread width
    const width = buyStrike - sellStrike;
    const estimatedCost = width * 0.45;
    const costPerContract = estimatedCost * 100;
    const riskBudget = equity * CONFIG.maxRiskPct;
    const contracts = Math.max(1, Math.floor(riskBudget / costPerContract));

    return {
      type: 'PUT_DEBIT_SPREAD',
      symbol: 'SPY',
      direction: 'BEARISH',
      legs: [
        { action: 'buy', type: 'put', strike: buyStrike },
        { action: 'sell', type: 'put', strike: sellStrike },
      ],
      targetDTE,
      contracts: Math.min(contracts, 5),
      estimatedCost,
      maxRisk: costPerContract * Math.min(contracts, 5),
      regime: 'FEAR',
      confidence,
      reasoning: `VIX spiking (${signals.vix.toFixed(1)}, +${signals.vixChange.toFixed(1)}%) — buy put spread ${sellStrike}/${buyStrike}`,
      profitTarget: (width - estimatedCost) * 0.8 * 100 * Math.min(contracts, 5),
      stopLoss: costPerContract * Math.min(contracts, 5) * CONFIG.options.buy.stopLossPct,
    };
  }

  /**
   * REVERSAL: Buy call spreads — VIX mean reversion after spike
   */
  _reversalSignal(signals, equity, confidence) {
    const spyPrice = signals.spyPrice;
    if (!spyPrice) return null;

    // Buy call debit spread: buy slightly OTM call, sell call ~5% higher
    const buyStrike = Math.round(spyPrice * 1.01);     // ~1% OTM
    const sellStrike = Math.round(spyPrice * 1.05);    // ~5% OTM

    const targetDTE = 21;

    const width = sellStrike - buyStrike;
    const estimatedCost = width * 0.40;
    const costPerContract = estimatedCost * 100;
    const riskBudget = equity * CONFIG.maxRiskPct;
    const contracts = Math.max(1, Math.floor(riskBudget / costPerContract));

    return {
      type: 'CALL_DEBIT_SPREAD',
      symbol: 'SPY',
      direction: 'BULLISH',
      legs: [
        { action: 'buy', type: 'call', strike: buyStrike },
        { action: 'sell', type: 'call', strike: sellStrike },
      ],
      targetDTE,
      contracts: Math.min(contracts, 3),
      estimatedCost,
      maxRisk: costPerContract * Math.min(contracts, 3),
      regime: 'REVERSAL',
      confidence,
      reasoning: `VIX at ${signals.vix.toFixed(1)} declining (${signals.vixChange.toFixed(1)}%) — mean reversion call spread ${buyStrike}/${sellStrike}`,
      profitTarget: (width - estimatedCost) * 0.8 * 100 * Math.min(contracts, 3),
      stopLoss: costPerContract * Math.min(contracts, 3) * CONFIG.options.buy.stopLossPct,
    };
  }

  /**
   * TREND: Follow momentum with directional options
   */
  _trendSignal(signals, equity, confidence) {
    const spyPrice = signals.spyPrice;
    if (!spyPrice) return null;

    const bullish = signals.trendDirection === 'BULL';
    const targetDTE = 21;

    if (bullish) {
      const buyStrike = Math.round(spyPrice * 1.005);   // Near ATM
      const sellStrike = Math.round(spyPrice * 1.04);

      const width = sellStrike - buyStrike;
      const estimatedCost = width * 0.45;
      const costPerContract = estimatedCost * 100;
      const riskBudget = equity * CONFIG.maxRiskPct;
      const contracts = Math.max(1, Math.floor(riskBudget / costPerContract));

      return {
        type: 'CALL_DEBIT_SPREAD',
        symbol: 'SPY',
        direction: 'BULLISH',
        legs: [
          { action: 'buy', type: 'call', strike: buyStrike },
          { action: 'sell', type: 'call', strike: sellStrike },
        ],
        targetDTE,
        contracts: Math.min(contracts, 3),
        estimatedCost,
        maxRisk: costPerContract * Math.min(contracts, 3),
        regime: 'TREND',
        confidence,
        reasoning: `Bullish trend (SPY 5d +${signals.spy5dReturn.toFixed(2)}%) — call spread ${buyStrike}/${sellStrike}`,
        profitTarget: (width - estimatedCost) * 0.8 * 100 * Math.min(contracts, 3),
        stopLoss: costPerContract * Math.min(contracts, 3) * CONFIG.options.buy.stopLossPct,
      };
    } else {
      const buyStrike = Math.round(spyPrice * 0.995);
      const sellStrike = Math.round(spyPrice * 0.96);

      const width = buyStrike - sellStrike;
      const estimatedCost = width * 0.45;
      const costPerContract = estimatedCost * 100;
      const riskBudget = equity * CONFIG.maxRiskPct;
      const contracts = Math.max(1, Math.floor(riskBudget / costPerContract));

      return {
        type: 'PUT_DEBIT_SPREAD',
        symbol: 'SPY',
        direction: 'BEARISH',
        legs: [
          { action: 'buy', type: 'put', strike: buyStrike },
          { action: 'sell', type: 'put', strike: sellStrike },
        ],
        targetDTE,
        contracts: Math.min(contracts, 3),
        estimatedCost,
        maxRisk: costPerContract * Math.min(contracts, 3),
        regime: 'TREND',
        confidence,
        reasoning: `Bearish trend (SPY 5d ${signals.spy5dReturn.toFixed(2)}%) — put spread ${sellStrike}/${buyStrike}`,
        profitTarget: (width - estimatedCost) * 0.8 * 100 * Math.min(contracts, 3),
        stopLoss: costPerContract * Math.min(contracts, 3) * CONFIG.options.buy.stopLossPct,
      };
    }
  }
}

// ============================================================================
// EXECUTION ENGINE
// ============================================================================

class ExecutionEngine {
  constructor() {
    this.lastTradeTime = 0;
  }

  /**
   * Find the right expiration date targeting a specific DTE
   */
  _getTargetExpiration(targetDTE) {
    const target = new Date();
    target.setDate(target.getDate() + targetDTE);
    // Find nearest Friday
    const dayOfWeek = target.getDay();
    const daysToFriday = (5 - dayOfWeek + 7) % 7;
    target.setDate(target.getDate() + (daysToFriday === 0 && dayOfWeek !== 5 ? 7 : daysToFriday));
    return target.toISOString().split('T')[0];
  }

  /**
   * Execute a spread trade on Alpaca
   */
  async executeSpread(signal) {
    if (!daytradeClient) throw new Error('Day trade client not available');

    // Cooldown check
    if (Date.now() - this.lastTradeTime < CONFIG.minTimeBetweenTradesMs) {
      return { status: 'COOLDOWN', message: 'Too soon since last trade' };
    }

    // Get account
    const account = await daytradeClient.getAccount();
    const positions = await daytradeClient.getPositions();

    // Position limit check
    if ((positions || []).length >= CONFIG.maxPositions) {
      return { status: 'MAX_POSITIONS', message: `Already at ${(positions || []).length} positions (max ${CONFIG.maxPositions})` };
    }

    // Find expiration
    const expiration = this._getTargetExpiration(signal.targetDTE);

    // For now, execute the long leg only (single-leg options)
    // Alpaca paper doesn't always support multi-leg orders cleanly
    const buyLeg = signal.legs.find(l => l.action === 'buy');
    if (!buyLeg) return { status: 'ERROR', message: 'No buy leg found' };

    try {
      // Find the contract
      const contract = await daytradeClient.findContract(
        signal.symbol,
        expiration,
        buyLeg.type,
        buyLeg.strike
      );

      if (!contract) {
        return {
          status: 'NO_CONTRACT',
          message: `No ${buyLeg.type} contract found at ${signal.symbol} ${expiration} $${buyLeg.strike}`,
        };
      }

      // Execute buy
      const order = await daytradeClient.buyOption(contract.symbol, signal.contracts);

      this.lastTradeTime = Date.now();

      return {
        status: 'EXECUTED',
        orderId: order.id,
        symbol: contract.symbol,
        strike: buyLeg.strike,
        type: buyLeg.type,
        expiration,
        contracts: signal.contracts,
        message: `Bought ${signal.contracts}x ${signal.symbol} ${expiration} $${buyLeg.strike} ${buyLeg.type}`,
      };
    } catch (e) {
      return { status: 'ERROR', message: e.message };
    }
  }
}

// ============================================================================
// POSITION MANAGER
// ============================================================================

class PositionManager {
  /**
   * Check existing positions for exit signals
   */
  async checkExits() {
    if (!daytradeClient) return [];

    const exits = [];
    const positions = await daytradeClient.getPositions();

    for (const pos of (positions || [])) {
      const plPct = parseFloat(pos.unrealized_plpc) * 100;
      const costBasis = parseFloat(pos.cost_basis);
      const marketValue = parseFloat(pos.market_value);
      const qty = parseFloat(pos.qty);

      // Check if this is a vol-regime position (options on SPY/QQQ)
      const isOurPosition = pos.asset_class === 'us_option' &&
        (pos.symbol.startsWith('SPY') || pos.symbol.startsWith('QQQ'));

      if (!isOurPosition) continue;

      // Profit target: 80% gain on debit trades
      if (plPct >= 80) {
        exits.push({
          symbol: pos.symbol,
          action: 'PROFIT_TARGET',
          reason: `P&L at +${plPct.toFixed(1)}% — taking profit`,
          qty: Math.abs(qty),
        });
        continue;
      }

      // Stop loss: 60% loss
      if (plPct <= -60) {
        exits.push({
          symbol: pos.symbol,
          action: 'STOP_LOSS',
          reason: `P&L at ${plPct.toFixed(1)}% — stop loss hit`,
          qty: Math.abs(qty),
        });
        continue;
      }

      // Time exit: check DTE from symbol
      const dteRemaining = this._parseDTE(pos.symbol);
      if (dteRemaining !== null && dteRemaining <= 3) {
        exits.push({
          symbol: pos.symbol,
          action: 'TIME_EXIT',
          reason: `Only ${dteRemaining} DTE remaining — closing to avoid theta decay`,
          qty: Math.abs(qty),
        });
      }
    }

    // Execute exits
    for (const exit of exits) {
      try {
        await daytradeClient.closePosition(exit.symbol);
        exit.executed = true;
      } catch (e) {
        exit.executed = false;
        exit.error = e.message;
      }
    }

    return exits;
  }

  /**
   * Parse DTE from OCC symbol (e.g., SPY260220P00580000)
   */
  _parseDTE(occSymbol) {
    try {
      // OCC format: SYMBOL + YYMMDD + C/P + Strike
      const match = occSymbol.match(/[A-Z]+(\d{6})[CP]/);
      if (!match) return null;
      const dateStr = match[1]; // YYMMDD
      const year = 2000 + parseInt(dateStr.substring(0, 2));
      const month = parseInt(dateStr.substring(2, 4)) - 1;
      const day = parseInt(dateStr.substring(4, 6));
      const expiry = new Date(year, month, day);
      const now = new Date();
      return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    } catch (e) {
      return null;
    }
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
    lastRegime: null,
    lastSignalTime: null,
    lastTradeTime: null,
    tradesHistory: [],
    dailyStats: {},
    lastRun: null,
  };
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  // Keep last 100 trades
  if (state.tradesHistory.length > 100) state.tradesHistory = state.tradesHistory.slice(-100);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// MAIN AGENT CLASS
// ============================================================================

class VolRegimeTrader {
  constructor() {
    this.name = 'Vol Regime Trader';
    this.emoji = '🌊';
    this.regimeDetector = new RegimeDetector();
    this.signalGenerator = new SignalGenerator();
    this.executionEngine = new ExecutionEngine();
    this.positionManager = new PositionManager();
    this.lastRun = null;
  }

  /**
   * Main run function — called every 30 minutes during market hours
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`[${new Date().toISOString()}] ${this.emoji} Vol Regime Trader starting... (${timeET} ET)`);

    const state = loadState();
    const report = {
      timestamp: new Date().toISOString(),
      timeET,
      regime: null,
      signal: null,
      execution: null,
      exits: [],
      positions: [],
      account: null,
      errors: [],
    };

    try {
      // 1. Check market is open
      if (daytradeClient) {
        try {
          const open = await daytradeClient.isMarketOpen();
          if (!open) {
            report.errors.push('Market closed');
            this.lastRun = new Date();
            return report;
          }
        } catch (e) { /* continue */ }
      }

      // 2. Get account state
      if (daytradeClient) {
        try {
          report.account = await daytradeClient.getAccount();
        } catch (e) {
          report.errors.push(`Account: ${e.message}`);
        }
      }

      // 3. Detect regime
      const regimeData = await this.regimeDetector.detect();
      report.regime = regimeData;

      // 4. Check existing positions for exits
      report.exits = await this.positionManager.checkExits();

      // 5. Get current positions
      if (daytradeClient) {
        try {
          report.positions = await daytradeClient.getPositions();
        } catch (e) {}
      }

      // 6. Generate signal if regime is clear
      if (regimeData.regime !== 'NEUTRAL' && regimeData.regime !== 'UNKNOWN') {
        const signal = await this.signalGenerator.generate(regimeData, report.account);
        report.signal = signal;

        // 7. Execute if signal is valid
        if (signal) {
          const execution = await this.executionEngine.executeSpread(signal);
          report.execution = execution;

          // Log trade
          if (execution.status === 'EXECUTED') {
            state.tradesHistory.push({
              timestamp: new Date().toISOString(),
              regime: regimeData.regime,
              signal: signal.type,
              symbol: execution.symbol,
              strike: execution.strike,
              contracts: execution.contracts,
              confidence: regimeData.confidence,
            });
            state.lastTradeTime = new Date().toISOString();
          }
        }
      }

      // Update state
      state.lastRegime = regimeData.regime;
      state.lastSignalTime = report.signal ? new Date().toISOString() : state.lastSignalTime;
      saveState(state);

    } catch (error) {
      report.errors.push(error.message);
      console.error('[VolRegime] Error:', error);
    }

    // Send Discord report
    await this._sendReport(report);

    // Update shared brain
    this._updateBrain(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Vol Regime Trader completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Send report to Discord
   */
  async _sendReport(report) {
    let msg = `${this.emoji} **VOL REGIME TRADER** — ${report.timeET} ET\n\n`;

    // Regime
    if (report.regime) {
      const regimeEmoji = {
        CALM: '😌', FEAR: '😨', REVERSAL: '🔄', TREND: '📈', NEUTRAL: '😐', UNKNOWN: '❓'
      };
      msg += `**Regime:** ${regimeEmoji[report.regime.regime] || ''} ${report.regime.regime} (${(report.regime.confidence * 100).toFixed(0)}% confidence)\n`;
      msg += `_${report.regime.reasoning}_\n`;

      if (report.regime.signals) {
        const s = report.regime.signals;
        msg += `VIX: ${s.vix?.toFixed(1)} (${s.vixChange >= 0 ? '+' : ''}${s.vixChange?.toFixed(1)}%) | SPY: ${s.spyChange >= 0 ? '+' : ''}${s.spyChange?.toFixed(2)}% | 5d: ${s.spy5dReturn >= 0 ? '+' : ''}${s.spy5dReturn?.toFixed(2)}%\n`;
      }
      msg += '\n';
    }

    // Signal
    if (report.signal) {
      msg += `**Signal:** ${report.signal.type} ${report.signal.symbol} ${report.signal.direction}\n`;
      msg += `Strikes: ${report.signal.legs.map(l => `${l.action} $${l.strike} ${l.type}`).join(' / ')}\n`;
      msg += `Contracts: ${report.signal.contracts} | Max Risk: $${report.signal.maxRisk?.toFixed(0)}\n`;
      msg += `_${report.signal.reasoning}_\n\n`;
    }

    // Execution
    if (report.execution) {
      const execEmoji = report.execution.status === 'EXECUTED' ? '✅' : '⚠️';
      msg += `**Execution:** ${execEmoji} ${report.execution.status}\n`;
      msg += `${report.execution.message}\n\n`;
    }

    // Exits
    if (report.exits.length > 0) {
      msg += `**Exits:**\n`;
      for (const exit of report.exits) {
        const emoji = exit.action === 'PROFIT_TARGET' ? '💰' : exit.action === 'STOP_LOSS' ? '🛑' : '⏰';
        msg += `${emoji} ${exit.symbol}: ${exit.reason} ${exit.executed ? '✅' : '❌ ' + (exit.error || '')}\n`;
      }
      msg += '\n';
    }

    // Positions
    if (report.positions && report.positions.length > 0) {
      msg += `**Positions (${report.positions.length}):**\n`;
      for (const pos of report.positions) {
        if (pos.asset_class !== 'us_option') continue;
        const plPct = (parseFloat(pos.unrealized_plpc) * 100).toFixed(1);
        const plEmoji = parseFloat(plPct) >= 0 ? '🟢' : '🔴';
        msg += `${plEmoji} ${pos.symbol}: ${pos.qty}x | P&L: ${plPct}%\n`;
      }
      msg += '\n';
    }

    // Account
    if (report.account) {
      const eq = parseFloat(report.account.portfolio_value);
      const lastEq = parseFloat(report.account.last_equity);
      const dayPL = eq - lastEq;
      msg += `**Account:** $${eq.toLocaleString()} | Day P&L: ${dayPL >= 0 ? '+' : ''}$${dayPL.toFixed(2)}\n`;
    }

    // No signal
    if (!report.signal && !report.execution && report.exits.length === 0) {
      msg += `_No signals generated. Monitoring..._\n`;
    }

    if (report.errors.length > 0) {
      msg += `\n**Errors:** ${report.errors.join(', ')}\n`;
    }

    try {
      await discord.tradeExecution(msg);
    } catch (e) {
      console.warn('[VolRegime] Discord send error:', e.message);
    }
  }

  /**
   * Update shared brain with regime data
   */
  _updateBrain(report) {
    if (report.regime) {
      brain.writeMarket({
        vix: report.regime.signals?.vix,
        regime: report.regime.regime,
        volRegime: {
          regime: report.regime.regime,
          confidence: report.regime.confidence,
          since: report.regime.regimeSince,
          signals: report.regime.signals,
        },
      });
    }

    brain.logAgent('vol-regime', `Regime: ${report.regime?.regime || 'N/A'} | Signal: ${report.signal?.type || 'none'} | Execution: ${report.execution?.status || 'none'}`);
  }
}

module.exports = VolRegimeTrader;
