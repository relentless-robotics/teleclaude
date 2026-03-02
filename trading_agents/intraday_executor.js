/**
 * IASM Intraday Execution Engine
 *
 * Reads IASM meta-learner signals, filters by confidence/consensus,
 * runs an LLM veto gate, then auto-executes via Alpaca API.
 *
 * Risk-managed: position sizing, daily loss limit, cooldowns,
 * bracket orders, trailing stops, auto-close on horizon expiry.
 *
 * Default: PAPER TRADING (Alpaca paper endpoint).
 *
 * Usage:
 *   const executor = require('./intraday_executor');
 *   await executor.executionLoop();           // Main loop (every 60s)
 *   await executor.processSignal(signal);     // Process a single signal
 *   executor.getPositions();                  // Current open positions
 *   executor.getDailyPnL();                   // Today's P&L
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Dependencies (graceful loading)
// ---------------------------------------------------------------------------

let daytradeClient;
try {
  daytradeClient = require('../swing_options/daytrade_client');
} catch (e) {
  console.warn('[IntradayExecutor] Alpaca client not available:', e.message);
}

let reasoning;
try {
  reasoning = require('../utils/llm_reasoning');
} catch (e) {
  console.warn('[IntradayExecutor] LLM reasoning not available:', e.message);
}

let discord;
try {
  discord = require('./discord_channels');
} catch (e) {
  console.warn('[IntradayExecutor] Discord channels not available:', e.message);
}

let brain;
try {
  brain = require('./shared_brain');
} catch (e) {
  console.warn('[IntradayExecutor] Shared brain not available:', e.message);
}

let iasmLoader;
try {
  iasmLoader = require('./iasm_loader');
} catch (e) {
  console.warn('[IntradayExecutor] IASM loader not available:', e.message);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const USE_PAPER = true; // Default to paper trading

// Signal file priority: tree > meta > legacy (trees won the model comparison)
const TREE_SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'tree_signals_latest.json'
);

const META_SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'meta_signals_latest.json'
);

const SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'latest_signals.json'
);

const EXECUTION_LOG_FILE = path.join(__dirname, 'data', 'intraday_executions.jsonl');
const STATE_FILE = path.join(__dirname, 'data', 'intraday_executor_state.json');

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Risk Configuration (all adjustable)
// ---------------------------------------------------------------------------

const RISK_CONFIG = {
  // Position sizing (backtesting winner: 5% per trade, 20 max concurrent)
  maxPositionPct: 0.05,          // 5% of portfolio per trade
  maxConcurrentPositions: 20,    // Max open positions at once
  maxPerSymbolPct: 0.10,         // 10% max exposure per symbol
  maxDailyLossPct: 0.01,         // 1% daily loss -> stop trading

  // Signal filters
  minConfidence: 0.65,           // Minimum model confidence
  minConsensusHorizons: 3,       // At least 3/4 horizons must agree
  maxSignalAgeMinutes: 5,        // Reject signals older than 5 min

  // Time restrictions (Eastern Time)
  noTradeFirstMinutes: 15,       // No trading first 15 min (9:30-9:45 ET)
  noTradeLastMinutes: 15,        // No trading last 15 min (3:45-4:00 ET)
  marketOpenHour: 9,
  marketOpenMinute: 30,
  marketCloseHour: 16,
  marketCloseMinute: 0,

  // Cooldowns
  symbolCooldownMinutes: 30,     // 30 min between trades on same symbol

  // Entry execution (backtesting winner: LIMIT_AGGRESSIVE)
  spreadMaxBps: 10,              // Max 10 bps spread (reject if wider)
  spreadLiquidThresholdBps: 3,   // < 3 bps = very liquid (allow market order)
  limitOffsetTicks: 1,           // Limit orders at mid + 1 tick
  limitTimeoutSec: 10,           // Cancel limit order if no fill in 10s

  // Exit execution (backtesting winner: TIME_DECAY + 120min max hold)
  initialStopPct: 0.005,         // 0.5% initial stop
  maxHoldMinutes: 120,           // Auto-close after 120 min
  timeDecayStops: {
    // Tighten stops as hold time increases
    '0-30': 0.005,               // 0-30 min: 0.5% stop
    '30-60': 0.003,              // 30-60 min: 0.3% stop
    '60-90': 0.002,              // 60-90 min: 0.2% stop
    '90-120': 0.0015,            // 90-120 min: 0.15% stop
  },
  trailToBreakevenPct: 0.005,    // Trail stop to breakeven after 0.5% profit

  // LLM veto gate
  vetoTimeoutMs: 30000,          // 30s timeout for LLM veto

  // Execution
  maxRetries: 1,                 // Retry once on API error
  loopIntervalMs: 60000,         // Run every 60 seconds
  monitorIntervalSec: 30,        // Check and update stops every 30 seconds
};

// ---------------------------------------------------------------------------
// Regime Configuration
// ---------------------------------------------------------------------------

const REGIME_CONFIG = {
  // Regime-specific position size multipliers
  positionMultipliers: {
    'LOW_VOL_TREND': 1.2,      // Best regime - slightly larger
    'LOW_VOL_CHOPPY': 0.7,     // Reduce - model weaker
    'HIGH_VOL_TREND': 1.0,     // Normal
    'HIGH_VOL_CHOPPY': 0.5,    // Significant reduction
    'SPIKE': 0.0,              // No trading
    'UNKNOWN': 0.8,            // Conservative if unknown
  },
  // Minimum confidence override per regime
  minConfidenceOverride: {
    'LOW_VOL_TREND': 0.60,     // Can trade lower confidence
    'LOW_VOL_CHOPPY': 0.70,    // Need higher confidence
    'HIGH_VOL_TREND': 0.65,    // Standard
    'HIGH_VOL_CHOPPY': 0.75,   // Much higher bar
    'SPIKE': 1.0,              // Effectively blocks all
    'UNKNOWN': 0.65,
  },
  // Hard veto regimes (no trading regardless)
  vetoRegimes: ['SPIKE'],
};

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------

const state = {
  positions: [],          // { symbol, side, qty, entryPrice, entryTime, orderId, stopLoss, takeProfit, holdUntil, signalData }
  dailyPnL: 0,
  dailyPnLPct: 0,
  tradesExecuted: 0,
  tradesVetoed: 0,
  signalsProcessed: 0,
  signalsFiltered: 0,
  tradingHalted: false,   // True when daily loss limit hit
  haltReason: null,
  symbolCooldowns: {},    // { symbol: lastTradeTimestamp }
  lastLoopTime: null,
  date: null,
  errors: [],
};

/**
 * Load persisted state from disk (survives restarts).
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const today = getTodayET();
      if (saved.date === today) {
        // Same day - restore state
        Object.assign(state, saved);
        log('INFO', `Restored state: ${state.positions.length} positions, $${state.dailyPnL.toFixed(2)} P&L`);
      } else {
        // New day - reset
        resetDailyState();
        log('INFO', 'New trading day - state reset');
      }
    }
  } catch (e) {
    log('ERROR', `Failed to load state: ${e.message}`);
  }
}

/**
 * Save state to disk.
 */
function saveState() {
  try {
    state.date = getTodayET();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log('ERROR', `Failed to save state: ${e.message}`);
  }
}

/**
 * Reset state for a new trading day.
 */
function resetDailyState() {
  state.positions = [];
  state.dailyPnL = 0;
  state.dailyPnLPct = 0;
  state.tradesExecuted = 0;
  state.tradesVetoed = 0;
  state.signalsProcessed = 0;
  state.signalsFiltered = 0;
  state.tradingHalted = false;
  state.haltReason = null;
  state.symbolCooldowns = {};
  state.errors = [];
  state.date = getTodayET();
  saveState();
}

// ---------------------------------------------------------------------------
// Time Utilities
// ---------------------------------------------------------------------------

function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getTimeET() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function getETDate() {
  // Return a Date-like object in ET
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etStr);
}

function getETMinutesSinceOpen() {
  const et = getETDate();
  const h = et.getHours();
  const m = et.getMinutes();
  const openMinutes = RISK_CONFIG.marketOpenHour * 60 + RISK_CONFIG.marketOpenMinute;
  const currentMinutes = h * 60 + m;
  return currentMinutes - openMinutes;
}

/**
 * Check if we are within market trading hours (ET),
 * respecting the no-trade buffer at open and close.
 */
function isMarketHours() {
  const et = getETDate();
  const h = et.getHours();
  const m = et.getMinutes();
  const day = et.getDay(); // 0=Sun, 6=Sat

  // Weekend check
  if (day === 0 || day === 6) return false;

  const currentMinutes = h * 60 + m;
  const openMinutes = RISK_CONFIG.marketOpenHour * 60 + RISK_CONFIG.marketOpenMinute;
  const closeMinutes = RISK_CONFIG.marketCloseHour * 60 + RISK_CONFIG.marketCloseMinute;

  // Within market hours (no buffer applied here - buffer checked separately)
  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

/**
 * Check if we are in the no-trade buffer zone.
 */
function isInNoTradeZone() {
  const minutesSinceOpen = getETMinutesSinceOpen();
  const minutesUntilClose = (RISK_CONFIG.marketCloseHour * 60 + RISK_CONFIG.marketCloseMinute) -
    (getETDate().getHours() * 60 + getETDate().getMinutes());

  if (minutesSinceOpen < RISK_CONFIG.noTradeFirstMinutes) {
    return { blocked: true, reason: `First ${RISK_CONFIG.noTradeFirstMinutes} min of market (currently ${minutesSinceOpen}m after open)` };
  }
  if (minutesUntilClose <= RISK_CONFIG.noTradeLastMinutes) {
    return { blocked: true, reason: `Last ${RISK_CONFIG.noTradeLastMinutes} min of market (${minutesUntilClose}m until close)` };
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Structured log to console and optionally to execution log file.
 */
function log(level, message, data = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    timeET: getTimeET(),
    level,
    message,
    ...(data ? { data } : {}),
  };
  const prefix = `[IntradayExecutor][${level}]`;
  console.log(`${prefix} ${message}`);
  if (data && level === 'ERROR') {
    console.error(data);
  }
}

/**
 * Append an entry to the JSONL execution log (append-only).
 */
function logExecution(entry) {
  try {
    const line = JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
      timeET: getTimeET(),
    });
    fs.appendFileSync(EXECUTION_LOG_FILE, line + '\n');
  } catch (e) {
    log('ERROR', `Failed to write execution log: ${e.message}`);
  }
}

/**
 * Send a message to the Discord IASM signals channel.
 */
async function notifyDiscord(message) {
  try {
    if (discord && typeof discord.send === 'function') {
      await discord.send('iasmSignals', message);
    } else if (discord && typeof discord.sendToChannel === 'function') {
      await discord.sendToChannel('iasmSignals', message);
    }
  } catch (e) {
    log('ERROR', `Discord notification failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Signal Reading & Filtering
// ---------------------------------------------------------------------------

/**
 * Read the latest IASM signals from the meta-learner output.
 * Falls back to latest_signals.json if meta not available.
 *
 * Normalizes the meta-learner's object-keyed format into the
 * array format expected by filterSignals() and processSignal().
 *
 * Meta-learner format:  { signals: { "AAPL": { direction, confidence, ... }, ... } }
 * Executor expects:     { signals: [ { symbol: "AAPL", direction, confidence, ... }, ... ] }
 */
function readSignals() {
  // Priority: tree signals (best model) > meta-learner > legacy
  let signalFile = null;
  let source = null;

  if (fs.existsSync(TREE_SIGNAL_FILE)) {
    signalFile = TREE_SIGNAL_FILE;
    source = 'tree_v2';
  } else if (fs.existsSync(META_SIGNAL_FILE)) {
    signalFile = META_SIGNAL_FILE;
    source = 'meta';
  } else if (fs.existsSync(SIGNAL_FILE)) {
    signalFile = SIGNAL_FILE;
    source = 'legacy';
  }

  if (!fs.existsSync(signalFile)) {
    log('WARN', 'No signal file found');
    return null;
  }

  try {
    const raw = fs.readFileSync(signalFile, 'utf8');
    const data = JSON.parse(raw);

    // Extract regime data from signals
    const regime = data.regime || null;
    if (regime) {
      log('INFO', `Current regime: ${regime.regime} (conf=${regime.confidence}, vix=${regime.vix_level})`);

      // Hard veto check
      if (REGIME_CONFIG.vetoRegimes.includes(regime.regime)) {
        log('WARN', `REGIME VETO: ${regime.regime} - no trading allowed`);
        return { signals: [], regime, vetoed: true, vetoReason: `Regime: ${regime.regime}` };
      }
    }

    // Normalize meta-learner object-keyed signals to array format
    if (data.signals && !Array.isArray(data.signals)) {
      const signalArray = [];
      for (const [symbol, sigData] of Object.entries(data.signals)) {
        // Compute expected_return_pct from the primary horizon (1h) prediction
        const primaryHorizon = sigData.horizons?.['1h'] || sigData.horizons?.['4h'] || {};
        const expectedReturnPct = (primaryHorizon.pred || 0) * 100; // Convert decimal to %

        // Build multi_horizon with direction per horizon for consensus counting
        const multiHorizon = {};
        if (sigData.horizons) {
          for (const [h, hData] of Object.entries(sigData.horizons)) {
            multiHorizon[h] = {
              direction: hData.pred > 0 ? 'LONG' : 'SHORT',
              confidence: hData.conf || 0,
              expected_return_pct: (hData.pred || 0) * 100,
              lstm_pred: hData.lstm_pred,
              tree_pred: hData.tree_pred,
            };
          }
        }

        signalArray.push({
          symbol,
          direction: sigData.direction,
          confidence: sigData.confidence,
          consensus: sigData.consensus,
          expected_return_pct: expectedReturnPct,
          model_agreement: sigData.model_agreement,
          meta_weights: sigData.meta_weights,
          multi_horizon: multiHorizon,
          horizons: sigData.horizons,  // Keep raw horizons too
          context: source === 'tree_v2'
            ? `V2 Tree models (XGB+LightGBM, 70 features)`
            : `Meta-learner ensemble (LSTM w=${sigData.meta_weights?.lstm?.toFixed(3) || '?'}, Trees w=${sigData.meta_weights?.trees?.toFixed(3) || '?'})`,
        });
      }
      data.signals = signalArray;
      log('INFO', `Normalized ${signalArray.length} signals from ${source} source`);
    }

    return data;
  } catch (e) {
    log('ERROR', `Failed to read signal file: ${e.message}`);
    return null;
  }
}

/**
 * Validate signal freshness - reject signals older than threshold.
 */
function isSignalFresh(signalData) {
  if (!signalData || !signalData.timestamp) return false;
  const signalTime = new Date(signalData.timestamp);
  const ageMinutes = (Date.now() - signalTime.getTime()) / (1000 * 60);
  return ageMinutes <= RISK_CONFIG.maxSignalAgeMinutes;
}

/**
 * Count how many horizons agree on a direction.
 * Handles both formats:
 *   - multi_horizon: { "1h": { direction: "LONG", ... } }  (normalized format)
 *   - horizons: { "1h": { pred: 0.001, ... } }             (raw meta-learner format)
 * Returns { agreeing: number, total: number, direction: string }
 */
function countConsensusHorizons(signal) {
  // Use pre-built multi_horizon if available (has direction per horizon)
  const horizonSource = signal.multi_horizon || signal.horizons;

  if (!horizonSource) {
    // No multi-horizon data; use the consensus field if available
    if (signal.consensus) {
      const isAll = signal.consensus.startsWith('ALL_');
      const isMostly = signal.consensus.startsWith('MOSTLY_');
      if (isAll) return { agreeing: 4, total: 4, direction: signal.direction };
      if (isMostly) return { agreeing: 3, total: 4, direction: signal.direction };
      return { agreeing: 2, total: 4, direction: signal.direction }; // MIXED
    }
    return { agreeing: 1, total: 1, direction: signal.direction };
  }

  const horizons = Object.values(horizonSource);
  const total = horizons.length;
  if (total === 0) return { agreeing: 0, total: 0, direction: signal.direction };

  // Count by direction - handle both formats
  const longCount = horizons.filter(h => {
    if (h.direction) return h.direction === 'LONG';
    if (h.pred !== undefined) return h.pred > 0;
    return false;
  }).length;

  const shortCount = horizons.filter(h => {
    if (h.direction) return h.direction === 'SHORT';
    if (h.pred !== undefined) return h.pred < 0;
    return false;
  }).length;

  if (longCount >= shortCount) {
    return { agreeing: longCount, total, direction: 'LONG' };
  } else {
    return { agreeing: shortCount, total, direction: 'SHORT' };
  }
}

/**
 * Filter signals by confidence threshold and consensus.
 */
function filterSignals(signalData) {
  if (!signalData || !signalData.signals) {
    return [];
  }

  // Ensure signals is an array (readSignals should have normalized, but be safe)
  if (!Array.isArray(signalData.signals)) {
    log('WARN', 'filterSignals received non-array signals - normalizing');
    const arr = [];
    for (const [symbol, sig] of Object.entries(signalData.signals)) {
      arr.push({ symbol, ...sig });
    }
    signalData.signals = arr;
  }

  if (signalData.signals.length === 0) {
    return [];
  }

  const passed = [];
  const totalBefore = signalData.signals.length;

  // Regime-aware confidence adjustment
  const currentRegime = signalData?.regime?.regime || 'UNKNOWN';
  const regimeMinConf = REGIME_CONFIG.minConfidenceOverride[currentRegime] || RISK_CONFIG.minConfidence;
  const effectiveMinConf = Math.max(RISK_CONFIG.minConfidence, regimeMinConf);

  let gateFiltered = 0;

  for (const sig of signalData.signals) {
    // === Alpha Gate Filter (Component 6) ===
    // If gate_decision is present (signal engine v4), use it as primary filter.
    // This replaces confidence/consensus checks when available, since the alpha gate
    // already incorporates confidence, consensus, regime, and all component signals.
    if (sig.gate_decision) {
      if (sig.gate_decision === 'NO_GO') {
        state.signalsFiltered++;
        gateFiltered++;
        continue;
      }
      // REDUCE_SIZE and GO both pass through (size handled in calculatePositionSize)
    }

    // === Legacy Confidence Filter (backward compatible) ===
    // Still applied even with gate, as a safety net
    if (sig.confidence < effectiveMinConf) {
      state.signalsFiltered++;
      continue;
    }

    // Consensus filter
    const consensus = countConsensusHorizons(sig);
    if (consensus.agreeing < RISK_CONFIG.minConsensusHorizons) {
      state.signalsFiltered++;
      continue;
    }

    // Use confidence_override from alpha gate if available (calibrated probability)
    const effectiveConfidence = sig.confidence_override || sig.confidence;

    // Use consensus direction (majority of horizons) rather than single-horizon direction
    passed.push({
      ...sig,
      confidence: effectiveConfidence,
      _originalConfidence: sig.confidence,
      _consensusDirection: consensus.direction,
      _consensusCount: consensus.agreeing,
      _consensusTotal: consensus.total,
      _gateDecision: sig.gate_decision || null,
      _sizeMultiplier: sig.size_multiplier || 1.0,
      _survivalData: sig.survival || null,
    });
  }

  const gateInfo = gateFiltered > 0 ? `, gate_NO_GO=${gateFiltered}` : '';
  log('INFO', `Filtered signals: ${passed.length}/${totalBefore} passed (conf >= ${effectiveMinConf.toFixed(2)}, consensus >= ${RISK_CONFIG.minConsensusHorizons}${gateInfo})`);
  return passed;
}

// ---------------------------------------------------------------------------
// Risk Management
// ---------------------------------------------------------------------------

/**
 * Get current account info from Alpaca.
 */
async function getAccount() {
  if (!daytradeClient) return null;
  try {
    const client = daytradeClient.getClient();
    return await client.getAccountSummary();
  } catch (e) {
    log('ERROR', `Failed to get account: ${e.message}`);
    return null;
  }
}

/**
 * Check all risk limits before placing a trade.
 * Returns { allowed: bool, reason: string }
 */
async function checkRiskLimits(signal, account) {
  // 1. Daily loss limit
  if (state.tradingHalted) {
    return { allowed: false, reason: `Trading halted: ${state.haltReason}` };
  }

  if (account) {
    const dailyLossLimit = account.equity * RISK_CONFIG.maxDailyLossPct;
    if (state.dailyPnL <= -dailyLossLimit) {
      state.tradingHalted = true;
      state.haltReason = `Daily loss limit hit: $${state.dailyPnL.toFixed(2)} (limit: -$${dailyLossLimit.toFixed(2)})`;
      saveState();
      return { allowed: false, reason: state.haltReason };
    }
  }

  // 2. Max concurrent positions
  if (state.positions.length >= RISK_CONFIG.maxConcurrentPositions) {
    return { allowed: false, reason: `Max positions reached: ${state.positions.length}/${RISK_CONFIG.maxConcurrentPositions}` };
  }

  // 3. Symbol cooldown
  const cooldownEnd = state.symbolCooldowns[signal.symbol];
  if (cooldownEnd && Date.now() < cooldownEnd) {
    const remainingMin = Math.ceil((cooldownEnd - Date.now()) / 60000);
    return { allowed: false, reason: `Symbol ${signal.symbol} on cooldown (${remainingMin}m remaining)` };
  }

  // 4. Already have position in this symbol
  const existingPos = state.positions.find(p => p.symbol === signal.symbol);
  if (existingPos) {
    return { allowed: false, reason: `Already holding ${signal.symbol}` };
  }

  // 5. Per-symbol exposure check (including if we have related positions)
  if (account) {
    const symbolExposure = state.positions
      .filter(p => p.symbol === signal.symbol)
      .reduce((sum, p) => sum + (p.qty * p.entryPrice), 0);
    const maxExposure = account.equity * RISK_CONFIG.maxPerSymbolPct;
    if (symbolExposure >= maxExposure) {
      return { allowed: false, reason: `Max exposure for ${signal.symbol}: $${symbolExposure.toFixed(0)} >= $${maxExposure.toFixed(0)}` };
    }
  }

  // 6. No-trade time zone
  const noTradeCheck = isInNoTradeZone();
  if (noTradeCheck.blocked) {
    return { allowed: false, reason: noTradeCheck.reason };
  }

  return { allowed: true, reason: 'All risk checks passed' };
}

/**
 * Calculate position size based on account equity and risk config.
 *
 * When alpha gate size_multiplier is available (signal engine v4), it is applied
 * ON TOP of the regime multiplier. The alpha gate has already factored in regime,
 * component signals, and model confidence, so the size_multiplier represents a
 * holistic view of how much conviction to apply.
 *
 * @param {number} price - Current price
 * @param {number} equity - Account equity
 * @param {object} signalData - Full signal data (with regime)
 * @param {object} signal - Individual signal (with _sizeMultiplier from alpha gate)
 */
function calculatePositionSize(price, equity, signalData = null, signal = null) {
  // Apply regime-based position sizing (legacy, always active)
  const currentRegime = signalData?.regime?.regime || 'UNKNOWN';
  const regimeMult = REGIME_CONFIG.positionMultipliers[currentRegime] || 1.0;

  // Alpha gate size multiplier (Component 6, 0.0 to 1.5)
  // If gate says REDUCE_SIZE, size_multiplier will be ~0.5
  // If gate says GO with high conviction, size_multiplier can be up to 1.5
  const gateSizeMult = signal?._sizeMultiplier || signal?.size_multiplier || 1.0;

  // Combine: regime * gate multiplier
  // Cap the combined multiplier to prevent oversizing
  const combinedMult = Math.min(regimeMult * gateSizeMult, 1.5);

  const adjustedPositionPct = RISK_CONFIG.maxPositionPct * combinedMult;

  const maxDollarAmount = equity * adjustedPositionPct;
  const qty = Math.floor(maxDollarAmount / price);

  if (gateSizeMult !== 1.0) {
    log('INFO', `Position sizing: regime=${regimeMult.toFixed(2)}x, gate=${gateSizeMult.toFixed(2)}x, combined=${combinedMult.toFixed(2)}x -> ${qty} shares @ $${price.toFixed(2)}`);
  }

  return Math.max(1, qty); // At least 1 share
}


// ---------------------------------------------------------------------------
// LLM Veto Gate
// ---------------------------------------------------------------------------

/**
 * Send signal to LLM for a PASS/VETO decision.
 * The LLM CANNOT add trades - only veto.
 * If no response in 30s -> auto-execute (PASS).
 */
async function llmVetoGate(signal, account, positions) {
  if (!reasoning || !reasoning.callLLMWithFallback) {
    log('WARN', 'LLM not available - auto-PASS');
    return { decision: 'PASS', reason: 'LLM unavailable - auto-pass', latencyMs: 0 };
  }

  const startTime = Date.now();

  const prompt = buildVetoPrompt(signal, account, positions);

  try {
    // Race: LLM response vs timeout
    const llmPromise = reasoning.callLLMWithFallback([
      { role: 'system', content: VETO_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.1,
      maxTokens: 500,
      timeout: RISK_CONFIG.vetoTimeoutMs,
    });

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ content: 'TIMEOUT', provider: 'timeout' }), RISK_CONFIG.vetoTimeoutMs)
    );

    const result = await Promise.race([llmPromise, timeoutPromise]);
    const latencyMs = Date.now() - startTime;

    if (result.provider === 'timeout' || result.content === 'TIMEOUT') {
      log('INFO', `LLM veto timed out after ${latencyMs}ms - auto-PASS`);
      return { decision: 'PASS', reason: 'LLM timeout - auto-pass', latencyMs };
    }

    // Parse the LLM response
    const responseText = (result.content || '').trim().toUpperCase();

    if (responseText.startsWith('VETO')) {
      const reason = result.content.replace(/^VETO[:\s]*/i, '').trim() || 'No reason given';
      log('INFO', `LLM VETOED ${signal.symbol}: ${reason} (${latencyMs}ms via ${result.provider})`);
      return { decision: 'VETO', reason, latencyMs, provider: result.provider };
    }

    log('INFO', `LLM PASSED ${signal.symbol} (${latencyMs}ms via ${result.provider})`);
    return { decision: 'PASS', reason: result.content.trim(), latencyMs, provider: result.provider };

  } catch (e) {
    const latencyMs = Date.now() - startTime;
    log('WARN', `LLM veto error: ${e.message} - auto-PASS`);
    return { decision: 'PASS', reason: `LLM error: ${e.message} - auto-pass`, latencyMs };
  }
}

const VETO_SYSTEM_PROMPT = `You are a risk-management veto gate for an automated intraday trading system.

You will be shown a signal from the IASM (Intraday Alpha Signal Model) along with current portfolio state.

Your ONLY job is to decide: PASS or VETO.

Respond with EXACTLY one of:
- PASS (the signal is reasonable, proceed with execution)
- VETO: [reason] (the signal should be blocked, with a brief reason)

Reasons to VETO:
- Signal conflicts with strong macro headwinds (e.g., market crash, VIX spike)
- Signal is on a stock with a known binary event imminent (earnings today, FDA decision)
- Portfolio is already heavily exposed to the same sector
- The expected move is too small relative to bid-ask spread costs
- News or context suggests the signal is based on stale or misleading data

Reasons to PASS:
- Signal has strong consensus across horizons
- Confidence is high
- No conflicting macro environment
- Risk parameters are reasonable

Be BIASED TOWARD PASS. Only veto if there is a CLEAR reason. The model has been backtested and validated.
Do NOT second-guess the model on direction - only veto for risk or context reasons.`;

function buildVetoPrompt(signal, account, positions) {
  const parts = [];

  parts.push('=== SIGNAL FOR VETO CHECK ===');
  parts.push(`Symbol: ${signal.symbol}`);
  parts.push(`Direction: ${signal._consensusDirection || signal.direction}`);
  parts.push(`Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
  parts.push(`Expected Return: ${signal.expected_return_pct != null ? ((signal.expected_return_pct > 0 ? '+' : '') + signal.expected_return_pct.toFixed(2) + '%') : 'N/A'}`);
  parts.push(`Consensus: ${signal.consensus || 'N/A'} (${signal._consensusCount || '?'}/${signal._consensusTotal || '?'} horizons)`);
  parts.push(`Context: ${signal.context || 'N/A'}`);

  if (signal.multi_horizon || signal.horizons) {
    const horizonData = signal.multi_horizon || signal.horizons;
    parts.push('\nMulti-Horizon Breakdown:');
    for (const [horizon, data] of Object.entries(horizonData)) {
      const dir = data.direction || (data.pred > 0 ? 'LONG' : 'SHORT');
      const conf = data.confidence || data.conf || 0;
      const expRet = data.expected_return_pct != null ? data.expected_return_pct : (data.pred != null ? data.pred * 100 : 0);
      parts.push(`  ${horizon}: ${dir} conf=${(conf * 100).toFixed(1)}% exp=${expRet > 0 ? '+' : ''}${expRet.toFixed(2)}%`);
    }
  }

  if (signal.features) {
    parts.push(`\nBullish features: ${(signal.features.top_bullish || []).join(', ')}`);
    parts.push(`Bearish features: ${(signal.features.top_bearish || []).join(', ')}`);
  }

  parts.push('\n=== PORTFOLIO STATE ===');
  if (account) {
    parts.push(`Equity: $${account.equity?.toLocaleString()}`);
    parts.push(`Daily P&L: $${state.dailyPnL.toFixed(2)} (${state.dailyPnLPct.toFixed(2)}%)`);
    parts.push(`Trades today: ${state.tradesExecuted}`);
  }

  parts.push(`Open positions: ${positions.length}`);
  for (const pos of positions) {
    parts.push(`  ${pos.symbol}: ${pos.side} ${pos.qty} @ $${pos.entryPrice.toFixed(2)}`);
  }

  // Market context from shared brain
  if (brain) {
    try {
      const ctx = brain.ctx;
      if (ctx.market?.vix) {
        parts.push(`\nVIX: ${ctx.market.vix}`);
      }
      if (ctx.market?.regime) {
        parts.push(`Market regime: ${ctx.market.regime}`);
      }
      if (ctx.iasmSignals?.market_context) {
        const mc = ctx.iasmSignals.market_context;
        parts.push(`SPY: ${mc.spy_direction || 'unknown'} momentum=${mc.spy_momentum || 'unknown'}`);
        parts.push(`VIX level: ${mc.vix_level || 'unknown'}, Regime: ${mc.regime || 'unknown'}`);
      }
    } catch (e) {
      // Brain not available, continue without
    }
  }

  // Regime context for LLM veto (from signal file)
  const signalData = readSignals();
  if (signalData?.regime) {
    const r = signalData.regime;
    parts.push('');
    parts.push('=== MARKET REGIME ===');
    parts.push(`Current Regime: ${r.regime}`);
    parts.push(`VIX Level: ${r.vix_level} (z-score: ${r.vix_zscore}, ${r.vix_percentile}th percentile)`);
    parts.push(`Trend: ${r.trend_direction} (strength: ${r.trend_strength})`);
    parts.push(`Regime Stability: ${r.stability}% (${r.transition_prob}% chance of change)`);
    parts.push(`Bars in regime: ${r.bars_in_regime}`);
    parts.push(`Position size multiplier: ${REGIME_CONFIG.positionMultipliers[r.regime] || 1.0}x`);
    parts.push('');
    if (r.regime === 'HIGH_VOL_CHOPPY') {
      parts.push('WARNING: High volatility + choppy conditions. Model historically underperforms here. Higher veto bar.');
    }
    if (r.regime === 'LOW_VOL_TREND') {
      parts.push('NOTE: Best regime for our model. Standard veto threshold.');
    }
  }

  parts.push('\n=== DECISION ===');
  parts.push('Respond PASS or VETO: [reason]');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Spread Protection
// ---------------------------------------------------------------------------

/**
 * Check bid-ask spread for a symbol.
 * Returns { valid: bool, spreadBps: number, spreadPct: number, bid, ask, mid, strategy: string }
 */
async function checkSpread(symbol) {
  if (!daytradeClient) {
    return { valid: false, reason: 'Alpaca client unavailable' };
  }

  try {
    const client = daytradeClient.getClient();
    const quote = await client.getLatestQuote(symbol);
    const ask = parseFloat(quote?.quote?.ap || 0);
    const bid = parseFloat(quote?.quote?.bp || 0);

    if (!ask || !bid || ask <= 0 || bid <= 0) {
      return { valid: false, reason: 'Invalid bid/ask quote', bid, ask };
    }

    const mid = (ask + bid) / 2;
    const spreadDollar = ask - bid;
    const spreadPct = (spreadDollar / mid) * 100;
    const spreadBps = spreadPct * 100; // 1% = 100 bps

    // Determine execution strategy
    let strategy = null;
    let valid = false;
    let reason = null;

    if (spreadBps > RISK_CONFIG.spreadMaxBps) {
      // Too wide - reject
      valid = false;
      strategy = 'REJECT';
      reason = `Spread ${spreadBps.toFixed(1)} bps > max ${RISK_CONFIG.spreadMaxBps} bps`;
    } else if (spreadBps < RISK_CONFIG.spreadLiquidThresholdBps) {
      // Very liquid - market order OK
      valid = true;
      strategy = 'MARKET';
    } else {
      // Mid-range - use limit order
      valid = true;
      strategy = 'LIMIT_AGGRESSIVE';
    }

    return {
      valid,
      reason,
      bid,
      ask,
      mid,
      spreadDollar,
      spreadPct,
      spreadBps,
      strategy,
    };
  } catch (e) {
    log('ERROR', `Failed to check spread for ${symbol}: ${e.message}`);
    return { valid: false, reason: `Spread check error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Order Execution
// ---------------------------------------------------------------------------

/**
 * Execute a trade via Alpaca API.
 * Uses TIME_DECAY exit strategy + LIMIT_AGGRESSIVE entry.
 */
async function executeOrder(signal, qty, spreadInfo, account) {
  if (!daytradeClient) {
    log('ERROR', 'Alpaca client not available - cannot execute');
    return null;
  }

  const client = daytradeClient.getClient();
  const side = (signal._consensusDirection || signal.direction) === 'LONG' ? 'buy' : 'sell';

  // Entry price depends on strategy
  let entryPrice;
  let orderType;
  let limitPrice = null;

  if (spreadInfo.strategy === 'MARKET') {
    // Very liquid - use market order
    orderType = 'market';
    entryPrice = side === 'buy' ? spreadInfo.ask : spreadInfo.bid;
  } else {
    // LIMIT_AGGRESSIVE - mid + 1 tick
    orderType = 'limit';
    const tickSize = 0.01; // Standard tick
    limitPrice = side === 'buy'
      ? +(spreadInfo.mid + tickSize).toFixed(2)
      : +(spreadInfo.mid - tickSize).toFixed(2);
    entryPrice = limitPrice; // Estimated entry
  }

  // Calculate initial stop (0.5%, no target - TIME_DECAY mode)
  const stopPct = RISK_CONFIG.initialStopPct;
  let stopPrice;
  if (side === 'buy') {
    stopPrice = +(entryPrice * (1 - stopPct)).toFixed(2);
  } else {
    stopPrice = +(entryPrice * (1 + stopPct)).toFixed(2);
  }

  const holdUntil = new Date(Date.now() + RISK_CONFIG.maxHoldMinutes * 60000).toISOString();

  log('INFO', `Executing ${side.toUpperCase()} ${qty} ${signal.symbol} @ ${orderType === 'limit' ? `limit $${limitPrice}` : `market ~$${entryPrice.toFixed(2)}`} | Initial stop: $${stopPrice} | Spread: ${spreadInfo.spreadBps.toFixed(1)} bps`);

  let order = null;
  let stopOrderId = null;
  let retries = 0;

  while (retries <= RISK_CONFIG.maxRetries) {
    try {
      // Place entry order (market or limit)
      const orderPayload = {
        symbol: signal.symbol,
        qty: qty.toString(),
        side: side,
        type: orderType,
        time_in_force: 'day',
      };

      if (orderType === 'limit') {
        orderPayload.limit_price = limitPrice.toString();
      }

      order = await client.request('/v2/orders', 'POST', orderPayload);

      // Wait for fill (if limit order)
      if (orderType === 'limit') {
        const fillStartTime = Date.now();
        let filled = false;

        while ((Date.now() - fillStartTime) < RISK_CONFIG.limitTimeoutSec * 1000) {
          await sleep(1000);
          const orderStatus = await client.getOrder(order.id);
          if (orderStatus.status === 'filled') {
            filled = true;
            entryPrice = parseFloat(orderStatus.filled_avg_price);
            // Recalculate stop based on actual fill price
            if (side === 'buy') {
              stopPrice = +(entryPrice * (1 - stopPct)).toFixed(2);
            } else {
              stopPrice = +(entryPrice * (1 + stopPct)).toFixed(2);
            }
            break;
          } else if (orderStatus.status === 'canceled' || orderStatus.status === 'rejected') {
            log('WARN', `Limit order ${orderStatus.status} for ${signal.symbol}`);
            return null;
          }
        }

        if (!filled) {
          // Timeout - cancel order
          log('WARN', `Limit order timeout for ${signal.symbol} after ${RISK_CONFIG.limitTimeoutSec}s - canceling`);
          try {
            await client.cancelOrder(order.id);
          } catch (_) {}
          return null;
        }
      } else {
        // Market order - wait for fill confirmation
        await sleep(2000);
        try {
          const orderStatus = await client.getOrder(order.id);
          if (orderStatus.status === 'filled' && orderStatus.filled_avg_price) {
            entryPrice = parseFloat(orderStatus.filled_avg_price);
            // Recalculate stop based on actual fill
            if (side === 'buy') {
              stopPrice = +(entryPrice * (1 - stopPct)).toFixed(2);
            } else {
              stopPrice = +(entryPrice * (1 + stopPct)).toFixed(2);
            }
          }
        } catch (_) {}
      }

      // Place stop-loss order (separate, not bracket - we need to update it for TIME_DECAY)
      const stopSide = side === 'buy' ? 'sell' : 'buy';
      const stopOrder = await client.request('/v2/orders', 'POST', {
        symbol: signal.symbol,
        qty: qty.toString(),
        side: stopSide,
        type: 'stop',
        time_in_force: 'day',
        stop_price: stopPrice.toString(),
      });
      stopOrderId = stopOrder.id;

      break; // Success
    } catch (e) {
      retries++;
      if (retries > RISK_CONFIG.maxRetries) {
        log('ERROR', `Order failed after ${retries} attempts: ${e.message}`);
        logExecution({
          type: 'ORDER_FAILED',
          symbol: signal.symbol,
          side,
          qty,
          price: entryPrice,
          error: e.message,
          signal: summarizeSignal(signal),
        });
        return null;
      }
      log('WARN', `Order attempt ${retries} failed: ${e.message}, retrying...`);
      await sleep(1000);
    }
  }

  if (!order) return null;

  // Track position
  const position = {
    symbol: signal.symbol,
    side,
    qty,
    entryPrice,
    entryTime: new Date().toISOString(),
    orderId: order.id,
    stopOrderId,           // Track stop order separately
    stopLoss: stopPrice,
    holdUntil,
    trailActivated: false,
    lastStopUpdate: Date.now(),
    signalData: summarizeSignal(signal),
  };

  state.positions.push(position);
  state.tradesExecuted++;
  state.symbolCooldowns[signal.symbol] = Date.now() + (RISK_CONFIG.symbolCooldownMinutes * 60000);
  saveState();

  // Log execution
  logExecution({
    type: 'ENTRY',
    symbol: signal.symbol,
    side,
    qty,
    price: entryPrice,
    stopLoss: stopPrice,
    holdUntil,
    confidence: signal.confidence,
    consensus: signal.consensus,
    orderId: order.id,
    stopOrderId,
    entryStrategy: spreadInfo.strategy,
    spreadBps: spreadInfo.spreadBps,
    signal: summarizeSignal(signal),
  });

  return { order, position };
}

/**
 * Close a position.
 */
async function closePosition(position, reason, currentPrice = null) {
  if (!daytradeClient) return null;

  const client = daytradeClient.getClient();

  try {
    // Cancel any pending orders for this symbol first
    try {
      const orders = await client.getOrders({ status: 'open' });
      const relatedOrders = (Array.isArray(orders) ? orders : []).filter(o =>
        o.symbol === position.symbol && (o.type === 'stop' || o.type === 'limit')
      );
      for (const ord of relatedOrders) {
        try { await client.cancelOrder(ord.id); } catch (_) {}
      }
    } catch (_) {}

    // Close position
    const closeSide = position.side === 'buy' ? 'sell' : 'buy';
    const closeOrder = await client.request('/v2/orders', 'POST', {
      symbol: position.symbol,
      qty: position.qty.toString(),
      side: closeSide,
      type: 'market',
      time_in_force: 'day',
    });

    // Calculate P&L
    const entryValue = position.entryPrice * position.qty;
    const exitValue = (currentPrice || position.entryPrice) * position.qty;
    let pnl;
    if (position.side === 'buy') {
      pnl = exitValue - entryValue;
    } else {
      pnl = entryValue - exitValue;
    }

    state.dailyPnL += pnl;

    // Remove from positions
    state.positions = state.positions.filter(p => p.orderId !== position.orderId);
    saveState();

    // Log
    logExecution({
      type: 'EXIT',
      symbol: position.symbol,
      side: closeSide,
      qty: position.qty,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      pnl: +pnl.toFixed(2),
      reason,
      holdTimeMinutes: Math.round((Date.now() - new Date(position.entryTime).getTime()) / 60000),
      orderId: closeOrder.id,
    });

    log('INFO', `Closed ${position.symbol}: P&L $${pnl.toFixed(2)} (${reason})`);

    return { order: closeOrder, pnl };
  } catch (e) {
    log('ERROR', `Failed to close ${position.symbol}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Position Monitoring
// ---------------------------------------------------------------------------

/**
 * Get the appropriate stop percentage based on hold time (TIME_DECAY strategy).
 */
function getTimeDecayStopPct(holdTimeMinutes) {
  if (holdTimeMinutes < 30) {
    return RISK_CONFIG.timeDecayStops['0-30'];
  } else if (holdTimeMinutes < 60) {
    return RISK_CONFIG.timeDecayStops['30-60'];
  } else if (holdTimeMinutes < 90) {
    return RISK_CONFIG.timeDecayStops['60-90'];
  } else {
    return RISK_CONFIG.timeDecayStops['90-120'];
  }
}

/**
 * Update stop order on Alpaca via PATCH.
 */
async function updateStopOrder(client, stopOrderId, newStopPrice) {
  try {
    await client.request(`/v2/orders/${stopOrderId}`, 'PATCH', {
      stop_price: newStopPrice.toFixed(2),
    });
    return true;
  } catch (e) {
    log('WARN', `Failed to PATCH stop order ${stopOrderId}: ${e.message}`);
    // Fallback: cancel and place new
    try {
      await client.cancelOrder(stopOrderId);
      // Return false to signal caller needs to place new order
      return false;
    } catch (e2) {
      log('ERROR', `Failed to cancel stop order ${stopOrderId}: ${e2.message}`);
      return false;
    }
  }
}

/**
 * Monitor all open positions: TIME_DECAY stops, trailing stops, auto-close, P&L updates.
 */
async function monitorPositions() {
  if (state.positions.length === 0) return;

  const client = daytradeClient ? daytradeClient.getClient() : null;
  if (!client) return;

  const closedPositions = [];

  for (const pos of [...state.positions]) {
    try {
      // Get current price
      let currentPrice = null;
      try {
        const quote = await client.getLatestQuote(pos.symbol);
        currentPrice = parseFloat(quote?.quote?.ap || quote?.quote?.bp || 0);
        if (!currentPrice || currentPrice === 0) {
          // Fallback: try to get from Alpaca position
          const alpacaPos = await client.getPosition(pos.symbol).catch(() => null);
          if (alpacaPos) {
            currentPrice = parseFloat(alpacaPos.current_price);
          }
        }
      } catch (e) {
        log('WARN', `Could not get quote for ${pos.symbol}: ${e.message}`);
        continue;
      }

      if (!currentPrice || currentPrice === 0) continue;

      // Calculate unrealized P&L
      let unrealizedPnl;
      if (pos.side === 'buy') {
        unrealizedPnl = (currentPrice - pos.entryPrice) * pos.qty;
      } else {
        unrealizedPnl = (pos.entryPrice - currentPrice) * pos.qty;
      }

      const unrealizedPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 *
        (pos.side === 'buy' ? 1 : -1);

      // Calculate hold time
      const holdTimeMinutes = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;

      // 1. Check max hold time (120 min) - auto-close
      if (holdTimeMinutes >= RISK_CONFIG.maxHoldMinutes) {
        log('INFO', `${pos.symbol}: Max hold time (${RISK_CONFIG.maxHoldMinutes}m) reached - auto-closing`);
        const result = await closePosition(pos, 'MAX_HOLD_TIME', currentPrice);
        if (result) {
          closedPositions.push({ ...pos, exitPrice: currentPrice, pnl: result.pnl, reason: 'MAX_HOLD_TIME' });
        }
        continue;
      }

      // 1b. Survival Model Adaptive Exit (Component 5)
      // If survival data is available from signal engine, use it for intelligent exits.
      // Rules:
      //   - P(hit_stop) > 0.7 AND P(hit_target) < 0.3 => EXIT_NOW (unfavorable odds)
      //   - P(hit_target) > P(hit_stop) * 2 => HOLD (favorable odds, keep position)
      //   - P(hit_stop) > 0.5 AND losing => TIGHTEN_STOP (reduce risk)
      const survivalData = pos.signalData?._survivalData || pos.signalData?.survival;
      if (survivalData && survivalData.p_hit_stop !== undefined) {
        const pStop = survivalData.p_hit_stop;
        const pTarget = survivalData.p_hit_target;

        // EXIT_NOW: overwhelmingly likely to hit stop, unlikely to hit target
        if (pStop > 0.7 && pTarget < 0.3) {
          log('INFO', `${pos.symbol}: SURVIVAL EXIT_NOW - P(stop)=${pStop.toFixed(2)} > 0.70, P(target)=${pTarget.toFixed(2)} < 0.30 | P&L: $${unrealizedPnl.toFixed(2)}`);
          const result = await closePosition(pos, 'SURVIVAL_EXIT_NOW', currentPrice);
          if (result) {
            closedPositions.push({ ...pos, exitPrice: currentPrice, pnl: result.pnl, reason: 'SURVIVAL_EXIT_NOW' });
          }
          continue;
        }

        // TIGHTEN_STOP: moderate stop risk while losing money
        if (pStop > 0.5 && unrealizedPnl < 0) {
          // Tighten stop by 30% more than TIME_DECAY would suggest
          const tighterStopPct = getTimeDecayStopPct(holdTimeMinutes) * 0.7;
          let survivalStopPrice;
          if (pos.side === 'buy') {
            survivalStopPrice = +(currentPrice * (1 - tighterStopPct)).toFixed(2);
          } else {
            survivalStopPrice = +(currentPrice * (1 + tighterStopPct)).toFixed(2);
          }

          const shouldTighten = pos.side === 'buy'
            ? survivalStopPrice > pos.stopLoss
            : survivalStopPrice < pos.stopLoss;

          if (shouldTighten && (Date.now() - pos.lastStopUpdate) > 30000) {
            const updated = await updateStopOrder(client, pos.stopOrderId, survivalStopPrice);
            if (updated) {
              const oldStop = pos.stopLoss;
              pos.stopLoss = survivalStopPrice;
              pos.lastStopUpdate = Date.now();
              log('INFO', `${pos.symbol}: SURVIVAL tightened stop $${oldStop.toFixed(2)} -> $${survivalStopPrice.toFixed(2)} (P(stop)=${pStop.toFixed(2)}, losing $${Math.abs(unrealizedPnl).toFixed(2)})`);
              saveState();
            }
          }
        }

        // HOLD: strong favorable odds - log but do not intervene
        if (pTarget > pStop * 2) {
          log('DEBUG', `${pos.symbol}: SURVIVAL HOLD - P(target)=${pTarget.toFixed(2)} > 2*P(stop)=${pStop.toFixed(2)} | Favorable risk/reward`);
        }
      }

      // 2. TIME_DECAY stop management - tighten stop as hold time increases
      const currentStopPct = getTimeDecayStopPct(holdTimeMinutes);
      let newStopPrice;
      if (pos.side === 'buy') {
        newStopPrice = +(currentPrice * (1 - currentStopPct)).toFixed(2);
      } else {
        newStopPrice = +(currentPrice * (1 + currentStopPct)).toFixed(2);
      }

      // Only update if new stop is tighter (for longs: higher, for shorts: lower)
      const shouldUpdateStop = pos.side === 'buy'
        ? newStopPrice > pos.stopLoss
        : newStopPrice < pos.stopLoss;

      if (shouldUpdateStop && (Date.now() - pos.lastStopUpdate) > 30000) {
        // Update stop (max once per 30 seconds)
        const updated = await updateStopOrder(client, pos.stopOrderId, newStopPrice);
        if (updated) {
          const oldStop = pos.stopLoss;
          pos.stopLoss = newStopPrice;
          pos.lastStopUpdate = Date.now();
          log('INFO', `${pos.symbol}: TIME_DECAY stop tightened $${oldStop.toFixed(2)} -> $${newStopPrice.toFixed(2)} (${holdTimeMinutes.toFixed(0)}m hold, ${(currentStopPct * 100).toFixed(2)}% stop)`);
        } else {
          // PATCH failed, need to place new stop order
          try {
            const stopSide = pos.side === 'buy' ? 'sell' : 'buy';
            const newStopOrder = await client.request('/v2/orders', 'POST', {
              symbol: pos.symbol,
              qty: pos.qty.toString(),
              side: stopSide,
              type: 'stop',
              time_in_force: 'day',
              stop_price: newStopPrice.toFixed(2),
            });
            pos.stopOrderId = newStopOrder.id;
            pos.stopLoss = newStopPrice;
            pos.lastStopUpdate = Date.now();
            log('INFO', `${pos.symbol}: Replaced stop order - new stop $${newStopPrice.toFixed(2)}`);
          } catch (e) {
            log('ERROR', `Failed to place new stop order for ${pos.symbol}: ${e.message}`);
          }
        }
        saveState();
      }

      // 3. Check trailing stop to breakeven activation (after 0.5% profit)
      if (!pos.trailActivated && unrealizedPct >= RISK_CONFIG.trailToBreakevenPct * 100) {
        // Move stop to breakeven (only if better than current stop)
        const breakEvenStop = pos.entryPrice;
        const shouldTrail = pos.side === 'buy'
          ? breakEvenStop > pos.stopLoss
          : breakEvenStop < pos.stopLoss;

        if (shouldTrail) {
          const updated = await updateStopOrder(client, pos.stopOrderId, breakEvenStop);
          if (updated) {
            pos.stopLoss = breakEvenStop;
            pos.trailActivated = true;
            pos.lastStopUpdate = Date.now();
            log('INFO', `${pos.symbol}: Trailing stop to breakeven $${breakEvenStop.toFixed(2)} (${unrealizedPct.toFixed(1)}% profit)`);
            saveState();
          } else {
            // Replace stop order
            try {
              const stopSide = pos.side === 'buy' ? 'sell' : 'buy';
              const newStopOrder = await client.request('/v2/orders', 'POST', {
                symbol: pos.symbol,
                qty: pos.qty.toString(),
                side: stopSide,
                type: 'stop',
                time_in_force: 'day',
                stop_price: breakEvenStop.toFixed(2),
              });
              pos.stopOrderId = newStopOrder.id;
              pos.stopLoss = breakEvenStop;
              pos.trailActivated = true;
              pos.lastStopUpdate = Date.now();
              log('INFO', `${pos.symbol}: Replaced stop - trailed to breakeven $${breakEvenStop.toFixed(2)}`);
              saveState();
            } catch (e) {
              log('ERROR', `Failed to trail stop for ${pos.symbol}: ${e.message}`);
            }
          }
        }
      }

      // 4. Check if Alpaca already closed the position (stop hit)
      try {
        const alpacaPos = await client.getPosition(pos.symbol).catch(() => null);
        if (!alpacaPos) {
          // Position no longer exists on Alpaca - was stopped out
          const reason = 'STOP_HIT';
          state.dailyPnL += unrealizedPnl;
          state.positions = state.positions.filter(p => p.orderId !== pos.orderId);
          saveState();

          logExecution({
            type: 'EXIT',
            symbol: pos.symbol,
            side: pos.side === 'buy' ? 'sell' : 'buy',
            qty: pos.qty,
            entryPrice: pos.entryPrice,
            exitPrice: currentPrice,
            pnl: +unrealizedPnl.toFixed(2),
            reason,
            holdTimeMinutes: Math.round(holdTimeMinutes),
          });

          closedPositions.push({ ...pos, exitPrice: currentPrice, pnl: unrealizedPnl, reason });
          log('INFO', `${pos.symbol}: Position closed by Alpaca (${reason}) P&L: $${unrealizedPnl.toFixed(2)}`);
        }
      } catch (_) {}

    } catch (e) {
      log('ERROR', `Error monitoring ${pos.symbol}: ${e.message}`);
    }
  }

  // Notify Discord about closed positions
  if (closedPositions.length > 0) {
    const lines = closedPositions.map(p => {
      const emoji = p.pnl >= 0 ? '+' : '';
      return `${p.symbol}: ${p.reason} | P&L: ${emoji}$${p.pnl.toFixed(2)}`;
    });
    await notifyDiscord(`**Position Updates**\n${lines.join('\n')}`);
  }

  // Update daily P&L percentage
  const account = await getAccount();
  if (account && account.equity > 0) {
    state.dailyPnLPct = (state.dailyPnL / account.equity) * 100;
  }

  saveState();
}

// ---------------------------------------------------------------------------
// Core: Process a Single Signal
// ---------------------------------------------------------------------------

/**
 * Process a single IASM signal through the full pipeline:
 * 1. Risk check
 * 2. Get current price
 * 3. Calculate position size
 * 4. LLM veto gate
 * 5. Execute order
 */
async function processSignal(signal) {
  state.signalsProcessed++;
  const symbol = signal.symbol;
  const direction = signal._consensusDirection || signal.direction;

  log('INFO', `Processing signal: ${symbol} ${direction} conf=${(signal.confidence * 100).toFixed(1)}% consensus=${signal.consensus}`);

  // 1. Get account state
  const account = await getAccount();
  if (!account) {
    log('ERROR', 'Cannot get account state - skipping signal');
    return { executed: false, reason: 'Account unavailable' };
  }

  // 2. Risk limits
  const riskCheck = await checkRiskLimits(signal, account);
  if (!riskCheck.allowed) {
    log('INFO', `Signal ${symbol} blocked by risk: ${riskCheck.reason}`);
    logExecution({ type: 'RISK_BLOCKED', symbol, direction, reason: riskCheck.reason, signal: summarizeSignal(signal) });
    return { executed: false, reason: riskCheck.reason };
  }

  // 3. Check spread and get execution strategy
  const spreadInfo = await checkSpread(symbol);
  if (!spreadInfo.valid) {
    log('INFO', `Signal ${symbol} blocked: ${spreadInfo.reason}`);
    logExecution({ type: 'SPREAD_BLOCKED', symbol, direction, reason: spreadInfo.reason, spreadBps: spreadInfo.spreadBps });
    return { executed: false, reason: spreadInfo.reason };
  }

  const currentPrice = spreadInfo.mid;
  log('INFO', `${symbol}: Spread ${spreadInfo.spreadBps.toFixed(1)} bps | Strategy: ${spreadInfo.strategy} | Bid: $${spreadInfo.bid.toFixed(2)} Ask: $${spreadInfo.ask.toFixed(2)} Mid: $${spreadInfo.mid.toFixed(2)}`);

  // 4. Calculate position size (regime-aware + alpha gate size multiplier)
  const signalData = readSignals();
  const qty = calculatePositionSize(currentPrice, account.equity, signalData, signal);
  const estimatedCost = qty * currentPrice;
  log('INFO', `${symbol}: qty=${qty} @ $${currentPrice.toFixed(2)} = $${estimatedCost.toFixed(0)} (${((estimatedCost / account.equity) * 100).toFixed(1)}% of equity)`);

  // 5. LLM veto gate
  const veto = await llmVetoGate(signal, account, state.positions);
  logExecution({
    type: 'VETO_CHECK',
    symbol,
    direction,
    decision: veto.decision,
    reason: veto.reason,
    latencyMs: veto.latencyMs,
    provider: veto.provider,
  });

  if (veto.decision === 'VETO') {
    state.tradesVetoed++;
    saveState();
    log('INFO', `Signal ${symbol} VETOED: ${veto.reason}`);
    await notifyDiscord(`**VETO** ${symbol} ${direction} | ${veto.reason}`);
    return { executed: false, reason: `LLM vetoed: ${veto.reason}`, veto };
  }

  // 6. Execute the order
  const result = await executeOrder(signal, qty, spreadInfo, account);
  if (!result) {
    return { executed: false, reason: 'Order execution failed' };
  }

  // 7. Notify Discord
  await notifyDiscord([
    `**ENTRY** ${direction === 'LONG' ? 'BUY' : 'SELL'} ${qty} ${symbol} @ $${result.position.entryPrice.toFixed(2)}`,
    `Confidence: ${(signal.confidence * 100).toFixed(1)}% | Consensus: ${signal.consensus}`,
    `Entry: ${spreadInfo.strategy} (spread: ${spreadInfo.spreadBps.toFixed(1)} bps)`,
    `Initial stop: $${result.position.stopLoss} (${(RISK_CONFIG.initialStopPct * 100).toFixed(2)}%)`,
    `Exit strategy: TIME_DECAY (tightens every 30min)`,
    `Max hold: ${RISK_CONFIG.maxHoldMinutes}m`,
    `Risk/size: $${estimatedCost.toFixed(0)} (${((estimatedCost / account.equity) * 100).toFixed(1)}%)`,
  ].join('\n'));

  return { executed: true, order: result.order, position: result.position };
}

// ---------------------------------------------------------------------------
// Main Execution Loop
// ---------------------------------------------------------------------------

/**
 * Main loop: runs every 60 seconds during market hours.
 * 1. Read latest signals
 * 2. Filter by confidence/consensus
 * 3. Check risk limits
 * 4. Send to LLM veto gate
 * 5. Execute approved trades
 * 6. Monitor existing positions
 * 7. Log everything
 */
async function executionLoop() {
  log('INFO', '=== Execution Loop Starting ===');
  state.lastLoopTime = new Date().toISOString();

  // Reset state if new day
  const today = getTodayET();
  if (state.date !== today) {
    resetDailyState();
    await notifyDiscord(`**IASM Executor** New trading day: ${today}`);
  }

  // Check market hours
  if (!isMarketHours()) {
    log('INFO', 'Market closed - skipping loop');

    // If market just closed, send daily summary
    const et = getETDate();
    if (et.getHours() === 16 && et.getMinutes() < 5 && state.tradesExecuted > 0) {
      await sendDailySummary();
    }

    return;
  }

  // Check trading halt
  if (state.tradingHalted) {
    log('WARN', `Trading halted: ${state.haltReason}`);
    // Still monitor positions even when halted
    await monitorPositions();
    return;
  }

  try {
    // 1. Monitor existing positions first (most important)
    await monitorPositions();

    // 2. Read latest signals
    const signalData = readSignals();
    if (!signalData) {
      log('WARN', 'No signal data available');
      return;
    }

    // 3. Check signal freshness
    if (!isSignalFresh(signalData)) {
      const signalTime = new Date(signalData.timestamp);
      const ageMinutes = ((Date.now() - signalTime.getTime()) / 60000).toFixed(1);
      log('INFO', `Signals are ${ageMinutes}m old (max ${RISK_CONFIG.maxSignalAgeMinutes}m) - skipping new entries`);
      return;
    }

    // 4. Filter signals
    const filteredSignals = filterSignals(signalData);
    if (filteredSignals.length === 0) {
      log('INFO', 'No signals passed filters');
      return;
    }

    // 5. Sort by confidence (highest first)
    filteredSignals.sort((a, b) => b.confidence - a.confidence);

    // 6. Process each signal (up to max concurrent)
    const slotsAvailable = RISK_CONFIG.maxConcurrentPositions - state.positions.length;
    const signalsToProcess = filteredSignals.slice(0, slotsAvailable);

    log('INFO', `Processing ${signalsToProcess.length} signals (${slotsAvailable} slots available)`);

    for (const signal of signalsToProcess) {
      try {
        const result = await processSignal(signal);
        log('INFO', `${signal.symbol}: ${result.executed ? 'EXECUTED' : 'SKIPPED'} - ${result.reason || 'success'}`);
      } catch (e) {
        log('ERROR', `Failed to process ${signal.symbol}: ${e.message}`);
        state.errors.push({ time: new Date().toISOString(), symbol: signal.symbol, error: e.message });
      }
    }

  } catch (e) {
    log('ERROR', `Execution loop error: ${e.message}`);
    state.errors.push({ time: new Date().toISOString(), error: e.message });
  }

  saveState();
  log('INFO', `=== Loop Complete | Positions: ${state.positions.length} | Daily P&L: $${state.dailyPnL.toFixed(2)} ===`);
}

/**
 * Start the continuous execution loop (runs until stopped).
 */
async function startLoop() {
  loadState();

  log('INFO', 'IASM Intraday Executor starting...');
  log('INFO', `Paper trading: ${USE_PAPER}`);
  log('INFO', `Confidence threshold: ${RISK_CONFIG.minConfidence}`);
  log('INFO', `Consensus threshold: ${RISK_CONFIG.minConsensusHorizons}/4`);
  log('INFO', `Max positions: ${RISK_CONFIG.maxConcurrentPositions}`);
  log('INFO', `Daily loss limit: ${(RISK_CONFIG.maxDailyLossPct * 100).toFixed(1)}%`);

  await notifyDiscord([
    '**IASM Intraday Executor Started**',
    `Mode: ${USE_PAPER ? 'PAPER' : 'LIVE'}`,
    `Confidence: >= ${(RISK_CONFIG.minConfidence * 100).toFixed(0)}%`,
    `Consensus: >= ${RISK_CONFIG.minConsensusHorizons}/4 horizons`,
    `Max positions: ${RISK_CONFIG.maxConcurrentPositions}`,
    `Position size: ${(RISK_CONFIG.maxPositionPct * 100).toFixed(0)}% of portfolio`,
    `Daily loss limit: ${(RISK_CONFIG.maxDailyLossPct * 100).toFixed(1)}%`,
    `Loop interval: ${RISK_CONFIG.loopIntervalMs / 1000}s`,
  ].join('\n'));

  // Run immediately, then on interval
  await executionLoop();

  const intervalId = setInterval(async () => {
    try {
      await executionLoop();
    } catch (e) {
      log('ERROR', `Unhandled loop error: ${e.message}`);
    }
  }, RISK_CONFIG.loopIntervalMs);

  // Cleanup on process exit
  process.on('SIGINT', async () => {
    clearInterval(intervalId);
    log('INFO', 'Shutting down...');
    saveState();
    await sendDailySummary();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    clearInterval(intervalId);
    saveState();
    process.exit(0);
  });

  return intervalId;
}

// ---------------------------------------------------------------------------
// Daily Summary
// ---------------------------------------------------------------------------

/**
 * Send end-of-day summary to Discord.
 */
async function sendDailySummary() {
  const account = await getAccount();
  const equityStr = account ? `$${account.equity.toLocaleString()}` : 'N/A';

  const summary = [
    `**IASM Daily Summary - ${getTodayET()}**`,
    ``,
    `Portfolio: ${equityStr}`,
    `Daily P&L: ${state.dailyPnL >= 0 ? '+' : ''}$${state.dailyPnL.toFixed(2)} (${state.dailyPnLPct >= 0 ? '+' : ''}${state.dailyPnLPct.toFixed(2)}%)`,
    ``,
    `Signals processed: ${state.signalsProcessed}`,
    `Signals filtered: ${state.signalsFiltered}`,
    `Trades executed: ${state.tradesExecuted}`,
    `Trades vetoed: ${state.tradesVetoed}`,
    `Open positions: ${state.positions.length}`,
    ``,
    state.tradingHalted ? `HALTED: ${state.haltReason}` : 'Status: Active',
    state.errors.length > 0 ? `Errors: ${state.errors.length}` : '',
  ].filter(Boolean).join('\n');

  await notifyDiscord(summary);

  logExecution({
    type: 'DAILY_SUMMARY',
    date: getTodayET(),
    dailyPnL: state.dailyPnL,
    dailyPnLPct: state.dailyPnLPct,
    tradesExecuted: state.tradesExecuted,
    tradesVetoed: state.tradesVetoed,
    signalsProcessed: state.signalsProcessed,
    signalsFiltered: state.signalsFiltered,
    errors: state.errors.length,
    tradingHalted: state.tradingHalted,
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function summarizeSignal(signal) {
  return {
    symbol: signal.symbol,
    direction: signal._consensusDirection || signal.direction,
    confidence: signal.confidence,
    expected_return_pct: signal.expected_return_pct,
    consensus: signal.consensus,
    consensusCount: signal._consensusCount,
    consensusTotal: signal._consensusTotal,
    // Signal Engine v4 fields (Component 6 + survival)
    _gateDecision: signal._gateDecision || signal.gate_decision || null,
    _sizeMultiplier: signal._sizeMultiplier || signal.size_multiplier || 1.0,
    _survivalData: signal._survivalData || signal.survival || null,
    gate_prob: signal.gate_prob || null,
    threshold_prob: signal.threshold_prob || null,
    vol_expansion: signal.vol_expansion || null,
    trend_persistence: signal.trend_persistence || null,
    optimal_horizon: signal.optimal_horizon || null,
    reasoning: signal.reasoning || null,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get recent execution log entries.
 */
function getExecutionLog(limit = 50) {
  try {
    if (!fs.existsSync(EXECUTION_LOG_FILE)) return [];
    const lines = fs.readFileSync(EXECUTION_LOG_FILE, 'utf8').trim().split('\n');
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Get current positions.
 */
function getPositions() {
  return [...state.positions];
}

/**
 * Get today's P&L.
 */
function getDailyPnL() {
  return {
    pnl: state.dailyPnL,
    pnlPct: state.dailyPnLPct,
    tradesExecuted: state.tradesExecuted,
    tradesVetoed: state.tradesVetoed,
    tradingHalted: state.tradingHalted,
    openPositions: state.positions.length,
  };
}

/**
 * Get full executor status.
 */
function getStatus() {
  return {
    ...state,
    isMarketHours: isMarketHours(),
    noTradeZone: isInNoTradeZone(),
    uptime: state.lastLoopTime ? `Last loop: ${state.lastLoopTime}` : 'Not started',
    riskConfig: RISK_CONFIG,
    paperMode: USE_PAPER,
  };
}

/**
 * Get current regime from latest signals.
 */
function getCurrentRegime() {
  try {
    const signalFile = fs.existsSync(TREE_SIGNAL_FILE) ? TREE_SIGNAL_FILE :
                       fs.existsSync(META_SIGNAL_FILE) ? META_SIGNAL_FILE : SIGNAL_FILE;
    if (!fs.existsSync(signalFile)) return null;
    const data = JSON.parse(fs.readFileSync(signalFile, 'utf8'));
    return data.regime || null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Standalone Execution
// ---------------------------------------------------------------------------

if (require.main === module) {
  console.log('='.repeat(70));
  console.log('IASM Intraday Execution Engine');
  console.log(`Mode: ${USE_PAPER ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  console.log('='.repeat(70));

  startLoop().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  executionLoop,
  processSignal,
  getPositions,
  getDailyPnL,
  getExecutionLog,
  isMarketHours,
  getStatus,
  startLoop,
  monitorPositions,
  sendDailySummary,
  getCurrentRegime,
  RISK_CONFIG,
  REGIME_CONFIG,
  // Internal (for testing)
  readSignals,
  filterSignals,
  isSignalFresh,
  countConsensusHorizons,
  checkRiskLimits,
  calculatePositionSize,
  llmVetoGate,
  executeOrder,
  closePosition,
  loadState,
  saveState,
  resetDailyState,
  checkSpread,
  getTimeDecayStopPct,
  updateStopOrder,
};
