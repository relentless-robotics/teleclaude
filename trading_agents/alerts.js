/**
 * IASM Trading Alert & Monitoring System
 *
 * Monitors the trading pipeline and sends Discord alerts for critical events:
 * - Regime transitions
 * - Drawdown alerts
 * - Model degradation
 * - Signal quality issues
 * - System health problems
 * - Position alerts
 *
 * Integrates with:
 * - tree_signals_latest.json (regime data, signal count)
 * - intraday_executor_state.json (positions, P&L)
 * - data/intraday_executions.jsonl (trade history)
 * - Discord via discord_channels module
 */

const fs = require('fs');
const path = require('path');
const discord = require('./discord_channels');

// ============================================================================
// File Paths
// ============================================================================

const TREE_SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'tree_signals_latest.json'
);

const EXECUTOR_STATE_FILE = path.join(__dirname, 'data', 'intraday_executor_state.json');
const EXECUTIONS_LOG_FILE = path.join(__dirname, 'data', 'intraday_executions.jsonl');
const ALERT_STATE_FILE = path.join(__dirname, 'data', 'alert_state.json');

// ============================================================================
// Alert Thresholds
// ============================================================================

const THRESHOLDS = {
  // Drawdown alerts (% of account)
  drawdown: {
    warning: -0.5,    // -0.5% daily P&L
    critical: -0.75,  // -0.75% daily P&L
    extreme: -1.0,    // -1.0% daily P&L
  },

  // Model performance (rolling metrics)
  model: {
    minIC: 0.03,        // Minimum acceptable IC
    minHitRate: 0.50,   // Minimum hit rate (50%)
  },

  // Signal quality
  signals: {
    minCount: 1,        // Warn if signal count drops to 0
    minConfidence: 0.55, // Minimum avg confidence
    staleMinutes: 10,   // Alert if signals >10 min old
  },

  // Position limits
  positions: {
    maxConcurrent: 5,   // Max concurrent positions
    maxHoldHours: 4,    // Max hold time before forced exit
  },
};

// ============================================================================
// Alert State (tracks what's already been alerted)
// ============================================================================

class AlertState {
  constructor() {
    this.state = this.load();
  }

  load() {
    if (fs.existsSync(ALERT_STATE_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8'));
      } catch (e) {
        console.error('[Alerts] Failed to load state:', e.message);
      }
    }
    return {
      lastRegime: null,
      lastDrawdownLevel: null,
      drawdownAlertsToday: [],
      modelAlerts: [],
      signalAlerts: [],
      lastCheckTime: null,
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    };
  }

  save() {
    try {
      fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[Alerts] Failed to save state:', e.message);
    }
  }

  // Reset state at start of new trading day
  resetIfNewDay() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (this.state.date !== today) {
      console.log(`[Alerts] New trading day: ${today} (was ${this.state.date})`);
      this.state.date = today;
      this.state.drawdownAlertsToday = [];
      this.state.lastDrawdownLevel = null;
      this.save();
    }
  }

  hasAlerted(type, key) {
    const alerts = this.state[`${type}Alerts`] || [];
    return alerts.includes(key);
  }

  markAlerted(type, key) {
    const alerts = this.state[`${type}Alerts`] || [];
    if (!alerts.includes(key)) {
      alerts.push(key);
      this.state[`${type}Alerts`] = alerts;
      this.save();
    }
  }

  clearAlert(type, key) {
    const alerts = this.state[`${type}Alerts`] || [];
    this.state[`${type}Alerts`] = alerts.filter(k => k !== key);
    this.save();
  }
}

const alertState = new AlertState();

// ============================================================================
// Data Loaders
// ============================================================================

function loadSignalFile() {
  if (!fs.existsSync(TREE_SIGNAL_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(TREE_SIGNAL_FILE, 'utf8'));

    // Normalize object-keyed signals to array format
    if (data.signals && !Array.isArray(data.signals)) {
      const signalArray = [];
      for (const [symbol, sigData] of Object.entries(data.signals)) {
        signalArray.push({
          symbol,
          direction: sigData.direction,
          confidence: sigData.confidence,
          consensus: sigData.consensus,
          horizons: sigData.horizons,
        });
      }
      data.signals = signalArray;
    }

    return data;
  } catch (e) {
    console.error('[Alerts] Failed to load signal file:', e.message);
    return null;
  }
}

function loadExecutorState() {
  if (!fs.existsSync(EXECUTOR_STATE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(EXECUTOR_STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[Alerts] Failed to load executor state:', e.message);
    return null;
  }
}

function loadRecentExecutions(count = 100) {
  if (!fs.existsSync(EXECUTIONS_LOG_FILE)) {
    return [];
  }
  try {
    const lines = fs.readFileSync(EXECUTIONS_LOG_FILE, 'utf8').trim().split('\n');
    return lines.slice(-count).map(line => JSON.parse(line));
  } catch (e) {
    console.error('[Alerts] Failed to load executions:', e.message);
    return [];
  }
}

// ============================================================================
// Alert Checkers
// ============================================================================

/**
 * Check for regime transitions
 */
async function checkRegimeTransition() {
  const signalData = loadSignalFile();
  if (!signalData || !signalData.meta_info) return;

  const currentRegime = signalData.meta_info.regime || 'UNKNOWN';
  const lastRegime = alertState.state.lastRegime;

  if (lastRegime && currentRegime !== lastRegime) {
    const regimeEmoji = {
      'LOW_VOL_TREND': '🟢',
      'HIGH_VOL_TREND': '🟡',
      'LOW_VOL_CHOPPY': '🟠',
      'HIGH_VOL_CHOPPY': '🔴',
      'SPIKE': '⚫',
      'UNKNOWN': '⚪',
    };

    await discord.alert(
      `🔄 **REGIME TRANSITION**\n\n` +
      `Previous: ${regimeEmoji[lastRegime] || '⚪'} ${lastRegime}\n` +
      `Current: ${regimeEmoji[currentRegime] || '⚪'} ${currentRegime}\n\n` +
      `Position sizing and confidence thresholds have been adjusted.`
    );
  }

  alertState.state.lastRegime = currentRegime;
  alertState.save();
}

/**
 * Check for drawdown alerts
 */
async function checkDrawdown() {
  const state = loadExecutorState();
  if (!state) return;

  const pnlPct = state.dailyPnLPct || 0;

  // Determine alert level
  let level = null;
  if (pnlPct <= THRESHOLDS.drawdown.extreme) {
    level = 'extreme';
  } else if (pnlPct <= THRESHOLDS.drawdown.critical) {
    level = 'critical';
  } else if (pnlPct <= THRESHOLDS.drawdown.warning) {
    level = 'warning';
  }

  // Alert if:
  // 1. We crossed into a new level
  // 2. We haven't alerted this level today
  if (level && level !== alertState.state.lastDrawdownLevel) {
    const alertKey = `drawdown_${level}_${alertState.state.date}`;

    if (!alertState.hasAlerted('drawdown', alertKey)) {
      const emoji = level === 'extreme' ? '🚨' : level === 'critical' ? '⚠️' : '⚠️';
      const levelText = level.toUpperCase();

      await discord.alert(
        `${emoji} **DRAWDOWN ALERT - ${levelText}**\n\n` +
        `Daily P&L: ${pnlPct.toFixed(2)}%\n` +
        `Dollar P&L: $${state.dailyPnL?.toFixed(2) || '0.00'}\n` +
        `Trades: ${state.tradesExecuted || 0}\n\n` +
        (level === 'extreme'
          ? '⛔ **EXTREME DRAWDOWN - Consider halting trading**'
          : level === 'critical'
          ? '🛑 **CRITICAL - Reduce position sizes**'
          : '⚠️ **WARNING - Monitor closely**')
      );

      alertState.markAlerted('drawdown', alertKey);
      alertState.state.lastDrawdownLevel = level;
      alertState.save();
    }
  }

  // Clear drawdown level if we've recovered
  if (!level && alertState.state.lastDrawdownLevel) {
    alertState.state.lastDrawdownLevel = null;
    alertState.save();
  }
}

/**
 * Check for model degradation
 * (Requires execution history to compute rolling metrics)
 */
async function checkModelDegradation() {
  const executions = loadRecentExecutions(50);
  if (executions.length < 10) return; // Need minimum sample

  // Compute rolling hit rate
  const closedTrades = executions.filter(e => e.event === 'exit' || e.event === 'stop_hit');
  if (closedTrades.length < 10) return;

  const recentTrades = closedTrades.slice(-20);
  const winners = recentTrades.filter(t => (t.pnl || 0) > 0).length;
  const hitRate = winners / recentTrades.length;

  // Alert if hit rate below threshold
  if (hitRate < THRESHOLDS.model.minHitRate) {
    const alertKey = `hit_rate_low_${alertState.state.date}`;

    if (!alertState.hasAlerted('model', alertKey)) {
      await discord.alert(
        `📉 **MODEL DEGRADATION ALERT**\n\n` +
        `Rolling hit rate: ${(hitRate * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.model.minHitRate * 100).toFixed(0)}%)\n` +
        `Sample: ${recentTrades.length} trades\n` +
        `Winners: ${winners} | Losers: ${recentTrades.length - winners}\n\n` +
        `Consider retraining models or reducing position sizes.`
      );

      alertState.markAlerted('model', alertKey);
    }
  } else {
    // Clear alert if hit rate recovers
    const alertKey = `hit_rate_low_${alertState.state.date}`;
    if (alertState.hasAlerted('model', alertKey)) {
      alertState.clearAlert('model', alertKey);
    }
  }
}

/**
 * Check for signal quality issues
 */
async function checkSignalQuality() {
  const signalData = loadSignalFile();
  if (!signalData) {
    // Signal file missing entirely - major issue
    const alertKey = 'signal_file_missing';
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `❌ **SIGNAL FILE MISSING**\n\n` +
        `File: tree_signals_latest.json\n` +
        `Expected location: MacroStrategy/intraday_model/signals/\n\n` +
        `IASM pipeline may not be running. Check Python processes.`
      );
      alertState.markAlerted('signal', alertKey);
    }
    return;
  } else {
    // Clear missing file alert if it reappears
    alertState.clearAlert('signal', 'signal_file_missing');
  }

  // Check signal staleness
  const signalTime = new Date(signalData.timestamp);
  const now = new Date();
  const ageMinutes = (now - signalTime) / (1000 * 60);

  if (ageMinutes > THRESHOLDS.signals.staleMinutes) {
    const alertKey = `signals_stale`;
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `⏰ **STALE SIGNALS**\n\n` +
        `Signal age: ${ageMinutes.toFixed(1)} minutes (threshold: ${THRESHOLDS.signals.staleMinutes}m)\n` +
        `Last update: ${signalData.timestamp}\n\n` +
        `IASM may have stopped updating. Check pipeline status.`
      );
      alertState.markAlerted('signal', alertKey);
    }
  } else {
    alertState.clearAlert('signal', 'signals_stale');
  }

  // Check signal count
  const signalCount = (signalData.signals || []).length;
  if (signalCount === 0) {
    const alertKey = `no_signals_${alertState.state.date}`;
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `⚠️ **NO SIGNALS GENERATED**\n\n` +
        `Signal count: 0\n` +
        `Timestamp: ${signalData.timestamp}\n\n` +
        `Model may be filtering all symbols. Check data quality and model thresholds.`
      );
      alertState.markAlerted('signal', alertKey);
    }
  }

  // Check confidence distribution
  if (signalCount > 0) {
    const confidences = signalData.signals.map(s => s.confidence || 0);
    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

    if (avgConfidence < THRESHOLDS.signals.minConfidence) {
      const alertKey = `low_confidence_${alertState.state.date}`;
      if (!alertState.hasAlerted('signal', alertKey)) {
        await discord.alert(
          `📊 **LOW SIGNAL CONFIDENCE**\n\n` +
          `Average confidence: ${(avgConfidence * 100).toFixed(1)}%\n` +
          `Threshold: ${(THRESHOLDS.signals.minConfidence * 100).toFixed(0)}%\n` +
          `Signal count: ${signalCount}\n\n` +
          `Model uncertainty is high. Trades may be filtered.`
        );
        alertState.markAlerted('signal', alertKey);
      }
    }
  }
}

/**
 * Check system health
 */
async function checkSystemHealth() {
  const state = loadExecutorState();
  if (!state) {
    const alertKey = 'executor_state_missing';
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `❌ **EXECUTOR STATE MISSING**\n\n` +
        `File: intraday_executor_state.json\n\n` +
        `Executor may not be running.`
      );
      alertState.markAlerted('signal', alertKey);
    }
    return;
  } else {
    alertState.clearAlert('signal', 'executor_state_missing');
  }

  // Check for trading halt
  if (state.tradingHalted) {
    const alertKey = `trading_halted`;
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `🛑 **TRADING HALTED**\n\n` +
        `Reason: ${state.haltReason || 'Unknown'}\n\n` +
        `No new positions will be opened until halt is cleared.`
      );
      alertState.markAlerted('signal', alertKey);
    }
  } else {
    alertState.clearAlert('signal', 'trading_halted');
  }

  // Check for excessive vetoes
  if (state.tradesVetoed > 0 && state.signalsProcessed > 0) {
    const vetoRate = state.tradesVetoed / state.signalsProcessed;
    if (vetoRate > 0.8) {
      const alertKey = `high_veto_rate_${alertState.state.date}`;
      if (!alertState.hasAlerted('signal', alertKey)) {
        await discord.alert(
          `🚫 **HIGH VETO RATE**\n\n` +
          `Veto rate: ${(vetoRate * 100).toFixed(1)}%\n` +
          `Signals processed: ${state.signalsProcessed}\n` +
          `Trades vetoed: ${state.tradesVetoed}\n\n` +
          `Most signals are being rejected. Check filters and thresholds.`
        );
        alertState.markAlerted('signal', alertKey);
      }
    }
  }

  // Check for errors in state
  if (state.errors && state.errors.length > 0) {
    const recentErrors = state.errors.slice(-5);
    const alertKey = `executor_errors_${alertState.state.date}`;

    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `❌ **EXECUTOR ERRORS**\n\n` +
        `Recent errors (${recentErrors.length}):\n` +
        recentErrors.map(e => `• ${e}`).join('\n') +
        `\n\nCheck logs for details.`
      );
      alertState.markAlerted('signal', alertKey);
    }
  }
}

/**
 * Check position alerts
 */
async function checkPositions() {
  const state = loadExecutorState();
  if (!state || !state.positions) return;

  const positions = state.positions;

  // Max concurrent positions
  if (positions.length > THRESHOLDS.positions.maxConcurrent) {
    const alertKey = `max_positions_${alertState.state.date}`;
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert(
        `⚠️ **MAX POSITIONS REACHED**\n\n` +
        `Current: ${positions.length}\n` +
        `Max: ${THRESHOLDS.positions.maxConcurrent}\n\n` +
        `Symbols: ${positions.map(p => p.symbol).join(', ')}\n\n` +
        `No new positions will be opened until some close.`
      );
      alertState.markAlerted('signal', alertKey);
    }
  }

  // Check for positions approaching max hold time
  const now = new Date();
  for (const pos of positions) {
    const entryTime = new Date(pos.entryTime);
    const holdHours = (now - entryTime) / (1000 * 60 * 60);

    if (holdHours > THRESHOLDS.positions.maxHoldHours * 0.9) {
      const alertKey = `max_hold_${pos.symbol}`;
      if (!alertState.hasAlerted('signal', alertKey)) {
        await discord.tradeExecution(
          `⏰ **MAX HOLD WARNING**\n\n` +
          `Symbol: ${pos.symbol}\n` +
          `Hold time: ${holdHours.toFixed(1)}h (max: ${THRESHOLDS.positions.maxHoldHours}h)\n` +
          `P&L: ${((pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%\n\n` +
          `Position will be force-closed soon.`
        );
        alertState.markAlerted('signal', alertKey);
      }
    }
  }
}

// ============================================================================
// Main Alert Check Function
// ============================================================================

/**
 * Run all alert checks (one-time)
 */
async function checkAlerts() {
  try {
    // Reset state if new day
    alertState.resetIfNewDay();

    // Run all checks
    await checkRegimeTransition();
    await checkDrawdown();
    await checkModelDegradation();
    await checkSignalQuality();
    await checkSystemHealth();
    await checkPositions();

    alertState.state.lastCheckTime = new Date().toISOString();
    alertState.save();

  } catch (error) {
    console.error('[Alerts] Check failed:', error.message);
  }
}

// ============================================================================
// Monitoring Loop
// ============================================================================

let monitoringInterval = null;

/**
 * Start continuous monitoring (60-second interval)
 */
function startMonitoring() {
  if (monitoringInterval) {
    console.log('[Alerts] Monitoring already running');
    return;
  }

  console.log('[Alerts] Starting monitoring loop (60s interval)');

  // Run initial check
  checkAlerts();

  // Start interval
  monitoringInterval = setInterval(() => {
    checkAlerts();
  }, 60 * 1000); // 60 seconds

  return monitoringInterval;
}

/**
 * Stop monitoring
 */
function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('[Alerts] Monitoring stopped');
  }
}

// ============================================================================
// Status Report
// ============================================================================

/**
 * Get current system status
 */
function getStatus() {
  const signalData = loadSignalFile();
  const state = loadExecutorState();
  const executions = loadRecentExecutions(20);

  const status = {
    timestamp: new Date().toISOString(),
    signalFile: null,
    executor: null,
    recentTrades: null,
    health: 'OK',
    alerts: alertState.state,
  };

  // Signal file status
  if (signalData) {
    const signalTime = new Date(signalData.timestamp);
    const ageMinutes = (new Date() - signalTime) / (1000 * 60);

    status.signalFile = {
      exists: true,
      timestamp: signalData.timestamp,
      ageMinutes: Math.round(ageMinutes * 10) / 10,
      isStale: ageMinutes > THRESHOLDS.signals.staleMinutes,
      signalCount: (signalData.signals || []).length,
      regime: signalData.meta_info?.regime || 'UNKNOWN',
    };

    if (status.signalFile.isStale) status.health = 'WARNING';
  } else {
    status.signalFile = { exists: false };
    status.health = 'ERROR';
  }

  // Executor status
  if (state) {
    status.executor = {
      exists: true,
      positions: state.positions?.length || 0,
      dailyPnL: state.dailyPnL || 0,
      dailyPnLPct: state.dailyPnLPct || 0,
      tradesExecuted: state.tradesExecuted || 0,
      tradesVetoed: state.tradesVetoed || 0,
      tradingHalted: state.tradingHalted || false,
      haltReason: state.haltReason || null,
    };

    if (state.tradingHalted) status.health = 'HALTED';
    if (state.dailyPnLPct <= THRESHOLDS.drawdown.critical) status.health = 'CRITICAL';
  } else {
    status.executor = { exists: false };
    status.health = 'ERROR';
  }

  // Recent trade stats
  const closedTrades = executions.filter(e => e.event === 'exit' || e.event === 'stop_hit');
  if (closedTrades.length > 0) {
    const winners = closedTrades.filter(t => (t.pnl || 0) > 0).length;
    status.recentTrades = {
      count: closedTrades.length,
      winners,
      losers: closedTrades.length - winners,
      hitRate: winners / closedTrades.length,
    };
  }

  return status;
}

// ============================================================================
// Export
// ============================================================================

module.exports = {
  checkAlerts,
  startMonitoring,
  stopMonitoring,
  getStatus,
  THRESHOLDS,
};

// ============================================================================
// Standalone Execution
// ============================================================================

if (require.main === module) {
  const command = process.argv[2] || 'check';

  (async () => {
    switch (command) {
      case 'check':
        console.log('Running alert checks...');
        await checkAlerts();
        console.log('\nStatus:');
        console.log(JSON.stringify(getStatus(), null, 2));
        process.exit(0);
        break;

      case 'monitor':
        console.log('Starting monitoring loop...');
        startMonitoring();
        console.log('Press Ctrl+C to stop');
        break;

      case 'status':
        console.log(JSON.stringify(getStatus(), null, 2));
        process.exit(0);
        break;

      default:
        console.log(`
IASM Alert System

Commands:
  check   - Run all alert checks once
  monitor - Start continuous monitoring (60s interval)
  status  - Show current system status
        `);
        process.exit(0);
    }
  })();
}
