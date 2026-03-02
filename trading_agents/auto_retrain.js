/**
 * Auto-Retrain Module
 *
 * Handles automated model retraining for IASM pipeline.
 * Triggers retraining when:
 * - Models are stale (>7 days since last training)
 * - Performance has degraded (rolling metrics below threshold)
 * - Scheduled retraining (Sunday nights at 8 PM ET)
 *
 * Logs all retraining events to Discord and event log.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const discord = require('./discord_channels');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Retraining schedule (Sunday nights)
  scheduledTime: {
    dayOfWeek: 0,      // 0 = Sunday
    hour: 20,          // 8 PM ET
    minute: 0,
  },

  // Staleness threshold
  maxModelAgeDays: 7,

  // Performance thresholds (trigger retrain if below)
  performanceThresholds: {
    minIC: 0.03,        // Information Coefficient
    minHitRate: 0.50,   // 50% win rate
    minSampleSize: 20,  // Need at least 20 trades to evaluate
  },

  // Python environment
  wslDistro: 'Ubuntu-22.04',
  macroDir: '/mnt/c/Users/YOUR_USERNAME/Documents/Github/MacroStrategy',
  condaPath: 'export PATH=/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
};

// File paths
const RETRAIN_STATE_FILE = path.join(__dirname, 'data', 'retrain_state.json');
const RETRAIN_LOG_FILE = path.join(__dirname, 'data', 'retrain_history.jsonl');
const TREE_SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'tree_signals_latest.json'
);

// ============================================================================
// State Management
// ============================================================================

class RetrainState {
  constructor() {
    this.state = this.load();
  }

  load() {
    if (fs.existsSync(RETRAIN_STATE_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(RETRAIN_STATE_FILE, 'utf8'));
      } catch (e) {
        console.error('[AutoRetrain] Failed to load state:', e.message);
      }
    }
    return {
      lastRetrainTime: null,
      lastRetrainSuccess: null,
      lastScheduledRun: null,
      retrainingInProgress: false,
      consecutiveFailures: 0,
    };
  }

  save() {
    try {
      fs.writeFileSync(RETRAIN_STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[AutoRetrain] Failed to save state:', e.message);
    }
  }

  markRetrainStart() {
    this.state.retrainingInProgress = true;
    this.save();
  }

  markRetrainComplete(success, reason = null) {
    this.state.lastRetrainTime = new Date().toISOString();
    this.state.lastRetrainSuccess = success;
    this.state.retrainingInProgress = false;

    if (success) {
      this.state.consecutiveFailures = 0;
    } else {
      this.state.consecutiveFailures += 1;
    }

    this.save();

    // Log to history
    this.logRetrainEvent({
      timestamp: new Date().toISOString(),
      success,
      reason,
      consecutiveFailures: this.state.consecutiveFailures,
    });
  }

  logRetrainEvent(event) {
    try {
      const logLine = JSON.stringify(event) + '\n';
      fs.appendFileSync(RETRAIN_LOG_FILE, logLine);
    } catch (e) {
      console.error('[AutoRetrain] Failed to log event:', e.message);
    }
  }

  isRetraining() {
    return this.state.retrainingInProgress;
  }
}

const retrainState = new RetrainState();

// ============================================================================
// Model Staleness Check
// ============================================================================

/**
 * Check if models need retraining based on age
 */
function checkModelStaleness() {
  if (!fs.existsSync(TREE_SIGNAL_FILE)) {
    return { stale: true, reason: 'Signal file missing', ageDays: null };
  }

  try {
    const data = JSON.parse(fs.readFileSync(TREE_SIGNAL_FILE, 'utf8'));
    const signalTime = new Date(data.timestamp);
    const now = new Date();
    const ageDays = (now - signalTime) / (1000 * 60 * 60 * 24);

    if (ageDays > CONFIG.maxModelAgeDays) {
      return { stale: true, reason: 'Models older than 7 days', ageDays: Math.round(ageDays) };
    }

    return { stale: false, ageDays: Math.round(ageDays * 10) / 10 };
  } catch (e) {
    return { stale: true, reason: 'Failed to parse signal file', ageDays: null };
  }
}

// ============================================================================
// Performance Check
// ============================================================================

/**
 * Check if model performance has degraded
 * Reads recent execution history to compute rolling metrics
 */
function checkPerformanceDegradation() {
  const EXECUTIONS_LOG_FILE = path.join(__dirname, 'data', 'intraday_executions.jsonl');

  if (!fs.existsSync(EXECUTIONS_LOG_FILE)) {
    return { degraded: false, reason: 'No execution history' };
  }

  try {
    const lines = fs.readFileSync(EXECUTIONS_LOG_FILE, 'utf8').trim().split('\n');
    const executions = lines.slice(-100).map(line => JSON.parse(line));
    const closedTrades = executions.filter(e => e.event === 'exit' || e.event === 'stop_hit');

    if (closedTrades.length < CONFIG.performanceThresholds.minSampleSize) {
      return { degraded: false, reason: 'Insufficient sample size', sampleSize: closedTrades.length };
    }

    // Compute hit rate
    const recentTrades = closedTrades.slice(-CONFIG.performanceThresholds.minSampleSize);
    const winners = recentTrades.filter(t => (t.pnl || 0) > 0).length;
    const hitRate = winners / recentTrades.length;

    if (hitRate < CONFIG.performanceThresholds.minHitRate) {
      return {
        degraded: true,
        reason: 'Hit rate below threshold',
        hitRate: Math.round(hitRate * 1000) / 10,
        threshold: CONFIG.performanceThresholds.minHitRate * 100,
        sampleSize: recentTrades.length,
      };
    }

    return {
      degraded: false,
      hitRate: Math.round(hitRate * 1000) / 10,
      sampleSize: recentTrades.length,
    };
  } catch (e) {
    console.error('[AutoRetrain] Failed to check performance:', e.message);
    return { degraded: false, reason: 'Error reading execution history' };
  }
}

// ============================================================================
// Retraining Execution
// ============================================================================

/**
 * Trigger Python retraining via WSL2
 */
async function executeRetrain(reason) {
  if (retrainState.isRetraining()) {
    console.log('[AutoRetrain] Retraining already in progress');
    return { success: false, reason: 'Retraining already in progress' };
  }

  console.log(`[AutoRetrain] Starting retraining: ${reason}`);
  await discord.iasmSignals(
    `🔄 **MODEL RETRAINING STARTED**\n\n` +
    `Reason: ${reason}\n` +
    `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET\n\n` +
    `This may take 10-20 minutes. Trading will continue with existing models.`
  );

  retrainState.markRetrainStart();

  try {
    // Build retrain command
    const alpacaEnvs = [
      `ALPACA_API_KEY=${process.env.ALPACA_API_KEY || process.env.DAYTRADE_ALPACA_API_KEY || ''}`,
      `ALPACA_SECRET_KEY=${process.env.ALPACA_SECRET_KEY || process.env.DAYTRADE_ALPACA_SECRET_KEY || ''}`,
    ].join(' ');

    const command = `wsl -d ${CONFIG.wslDistro} --user root -- bash -c "${CONFIG.condaPath} && ${alpacaEnvs} cd ${CONFIG.macroDir} && python -m intraday_model.training_queue retrain"`;

    console.log('[AutoRetrain] Executing:', command);

    // Run with 30-minute timeout
    execSync(command, {
      timeout: 30 * 60 * 1000,  // 30 minutes
      stdio: 'pipe',
    });

    console.log('[AutoRetrain] Retraining completed successfully');

    retrainState.markRetrainComplete(true, reason);

    await discord.iasmSignals(
      `✅ **MODEL RETRAINING COMPLETE**\n\n` +
      `Reason: ${reason}\n` +
      `Duration: ~${Math.round((new Date() - new Date(retrainState.state.lastRetrainTime)) / 60000)} minutes\n\n` +
      `New models are now being used for predictions.`
    );

    return { success: true, reason };

  } catch (error) {
    console.error('[AutoRetrain] Retraining failed:', error.message);

    retrainState.markRetrainComplete(false, `Error: ${error.message}`);

    await discord.error(
      `❌ **MODEL RETRAINING FAILED**\n\n` +
      `Reason: ${reason}\n` +
      `Error: ${error.message}\n\n` +
      `Consecutive failures: ${retrainState.state.consecutiveFailures}\n\n` +
      `Trading continues with existing models. Manual intervention may be required.`
    );

    return { success: false, error: error.message };
  }
}

// ============================================================================
// Scheduled Retrain Check
// ============================================================================

/**
 * Check if scheduled retrain should run (Sunday 8 PM ET)
 */
function shouldRunScheduledRetrain() {
  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  const dayOfWeek = etTime.getDay();
  const hour = etTime.getHours();
  const minute = etTime.getMinutes();

  // Check if it's Sunday 8 PM ET (within 5-minute window)
  if (
    dayOfWeek === CONFIG.scheduledTime.dayOfWeek &&
    hour === CONFIG.scheduledTime.hour &&
    minute >= CONFIG.scheduledTime.minute &&
    minute < CONFIG.scheduledTime.minute + 5
  ) {
    // Check if we already ran this week
    const today = etTime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const lastRun = retrainState.state.lastScheduledRun;

    if (lastRun !== today) {
      retrainState.state.lastScheduledRun = today;
      retrainState.save();
      return true;
    }
  }

  return false;
}

// ============================================================================
// Main Check Function
// ============================================================================

/**
 * Check if retraining is needed and trigger if so
 */
async function checkAndRetrain() {
  // Skip if already retraining
  if (retrainState.isRetraining()) {
    console.log('[AutoRetrain] Retraining already in progress, skipping check');
    return { triggered: false, reason: 'Retraining in progress' };
  }

  // Check 1: Scheduled retrain (Sunday 8 PM)
  if (shouldRunScheduledRetrain()) {
    console.log('[AutoRetrain] Scheduled retrain triggered');
    return await executeRetrain('Scheduled weekly retrain (Sunday 8 PM ET)');
  }

  // Check 2: Model staleness
  const stalenessCheck = checkModelStaleness();
  if (stalenessCheck.stale) {
    console.log('[AutoRetrain] Staleness check triggered:', stalenessCheck.reason);
    return await executeRetrain(`Model staleness: ${stalenessCheck.reason}`);
  }

  // Check 3: Performance degradation
  const perfCheck = checkPerformanceDegradation();
  if (perfCheck.degraded) {
    console.log('[AutoRetrain] Performance degradation triggered:', perfCheck.reason);
    return await executeRetrain(`Performance degradation: ${perfCheck.reason} (${perfCheck.hitRate}% hit rate)`);
  }

  // No retraining needed
  return {
    triggered: false,
    stalenessCheck,
    perfCheck,
  };
}

// ============================================================================
// Status Report
// ============================================================================

/**
 * Get retrain status
 */
function getStatus() {
  const stalenessCheck = checkModelStaleness();
  const perfCheck = checkPerformanceDegradation();

  return {
    timestamp: new Date().toISOString(),
    state: retrainState.state,
    staleness: stalenessCheck,
    performance: perfCheck,
    nextScheduledRetrain: getNextScheduledRetrain(),
  };
}

/**
 * Calculate next scheduled retrain time
 */
function getNextScheduledRetrain() {
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // Find next Sunday 8 PM
  let daysUntilSunday = (7 - etNow.getDay()) % 7;
  if (daysUntilSunday === 0) {
    // It's Sunday - check if we've passed 8 PM
    if (etNow.getHours() >= CONFIG.scheduledTime.hour) {
      daysUntilSunday = 7; // Next week
    }
  }

  const nextRetrain = new Date(etNow);
  nextRetrain.setDate(etNow.getDate() + daysUntilSunday);
  nextRetrain.setHours(CONFIG.scheduledTime.hour, CONFIG.scheduledTime.minute, 0, 0);

  return nextRetrain.toISOString();
}

// ============================================================================
// Export
// ============================================================================

module.exports = {
  checkAndRetrain,
  executeRetrain,
  getStatus,
  checkModelStaleness,
  checkPerformanceDegradation,
  CONFIG,
};

// ============================================================================
// Standalone Execution
// ============================================================================

if (require.main === module) {
  const command = process.argv[2] || 'check';

  (async () => {
    switch (command) {
      case 'check':
        console.log('Checking if retraining is needed...\n');
        const result = await checkAndRetrain();
        console.log('\nResult:');
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
        break;

      case 'force':
        console.log('Forcing retrain...\n');
        const forceResult = await executeRetrain('Manual force retrain');
        console.log('\nResult:');
        console.log(JSON.stringify(forceResult, null, 2));
        process.exit(0);
        break;

      case 'status':
        console.log(JSON.stringify(getStatus(), null, 2));
        process.exit(0);
        break;

      default:
        console.log(`
Auto-Retrain Module

Commands:
  check  - Check if retraining is needed and trigger if so
  force  - Force immediate retrain (manual override)
  status - Show current retrain status

Scheduled: Sunday 8 PM ET (weekly)
Triggers: Model age >7 days, hit rate <50%
        `);
        process.exit(0);
    }
  })();
}
