/**
 * IASM Intraday Trading Pipeline Orchestrator
 *
 * Ties together the full IASM intraday trading pipeline:
 *   1. Trigger Python meta-learner to generate fresh signals
 *   2. Read & normalize signals JSON
 *   3. Feed to intraday_executor (filtering, veto gate, execution)
 *   4. Day trader veto gate monitors (via executor's LLM veto)
 *   5. Position monitoring
 *   6. Logging & Discord reporting
 *
 * Pipeline flow:
 *   [Python meta_learner export] -> meta_signals_latest.json
 *       -> [intraday_executor.readSignals()] -> normalize -> filter
 *           -> [risk checks] -> [LLM veto gate] -> [Alpaca execution]
 *               -> [position monitor] -> [Discord notifications]
 *
 * Schedule: Every 60 seconds during market hours (9:45 AM - 3:45 PM ET)
 * Mode: PAPER TRADING (Alpaca paper endpoint)
 *
 * Usage:
 *   const pipeline = require('./intraday_pipeline');
 *   await pipeline.start();     // Start the pipeline loop
 *   pipeline.stop();            // Stop gracefully
 *   pipeline.getStatus();       // Get current pipeline status
 *   await pipeline.runOnce();   // Run one cycle manually
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MACROSTRATEGY_DIR = 'C:\\Users\\YOUR_USERNAME\\Documents\\Github\\MacroStrategy';
const SIGNAL_FILE = path.join(
  MACROSTRATEGY_DIR, 'intraday_model', 'signals', 'tree_signals_latest.json'
);

// ---------------------------------------------------------------------------
// Dependencies (graceful loading)
// ---------------------------------------------------------------------------

let executor;
try {
  executor = require('./intraday_executor');
} catch (e) {
  console.error('[IntradayPipeline] Failed to load intraday_executor:', e.message);
}

let discord;
try {
  discord = require('./discord_channels');
} catch (e) {
  console.warn('[IntradayPipeline] Discord not available:', e.message);
}

let brain;
try {
  brain = require('./shared_brain');
} catch (e) {
  console.warn('[IntradayPipeline] Shared brain not available:', e.message);
}

let iasmLoader;
try {
  iasmLoader = require('./iasm_loader');
} catch (e) {
  console.warn('[IntradayPipeline] IASM loader not available:', e.message);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PIPELINE_CONFIG = {
  // Timing
  loopIntervalMs: 60000,          // Run every 60 seconds
  signalRefreshIntervalMs: 300000, // Refresh signals from Python every 5 minutes
  startTimeET: '09:45',           // Start 15 min after market open
  endTimeET: '15:45',             // Stop 15 min before market close

  // Python execution
  pythonTimeout: 60000,            // 60s timeout for meta-learner export
  useWSL: false,                   // Try native Windows Python first

  // Signal generation (using V2 tree models directly)
  exportCommand: 'python -m intraday_model.generate_tree_signals export',
  predictCommand: 'python -m intraday_model.generate_tree_signals export',

  // WSL2 settings (fallback)
  wslDistro: 'Ubuntu-22.04',
  wslMacroDir: '/mnt/c/Users/YOUR_USERNAME/Documents/Github/MacroStrategy',
  condaPath: 'export PATH=/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pipelineState = {
  isRunning: false,
  loopHandle: null,
  lastCycleTime: null,
  lastSignalRefreshTime: null,
  lastSignalAge: null,
  cycleCount: 0,
  signalRefreshCount: 0,
  signalRefreshErrors: 0,
  executorCycleCount: 0,
  errors: [],
  startedAt: null,
};

// ---------------------------------------------------------------------------
// Time Utilities
// ---------------------------------------------------------------------------

function getETTime() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getETHourMinute() {
  const et = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(et);
  return { hour: etDate.getHours(), minute: etDate.getMinutes() };
}

function isWithinPipelineHours() {
  const { hour, minute } = getETHourMinute();
  const etDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const dayOfWeek = new Date(etDate).getDay();

  // Weekend check
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const currentMinutes = hour * 60 + minute;
  const [startH, startM] = PIPELINE_CONFIG.startTimeET.split(':').map(Number);
  const [endH, endM] = PIPELINE_CONFIG.endTimeET.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ---------------------------------------------------------------------------
// Signal Generation (Python meta-learner)
// ---------------------------------------------------------------------------

/**
 * Trigger the Python tree signal generator to generate fresh signals.
 * Tries native Windows Python first, falls back to WSL2.
 * Returns true if successful.
 */
function refreshSignals() {
  const startTime = Date.now();

  // Strategy 1: Native Windows Python
  try {
    log('INFO', 'Generating tree model signals (native Python)...');
    execSync(PIPELINE_CONFIG.exportCommand, {
      cwd: MACROSTRATEGY_DIR,
      timeout: PIPELINE_CONFIG.pythonTimeout,
      stdio: 'pipe',
      env: {
        ...process.env,
        PYTHONPATH: MACROSTRATEGY_DIR,
      },
    });
    const elapsed = Date.now() - startTime;
    log('INFO', `Signal generation complete (${elapsed}ms)`);
    pipelineState.signalRefreshCount++;
    pipelineState.lastSignalRefreshTime = new Date().toISOString();
    return true;
  } catch (e) {
    log('WARN', `Native Python failed: ${e.message}`);
  }

  // Strategy 2: WSL2 (if native fails)
  try {
    log('INFO', 'Generating tree model signals (WSL2 fallback)...');
    const { wslDistro, wslMacroDir, condaPath } = PIPELINE_CONFIG;
    const alpacaEnvs = [
      `ALPACA_API_KEY=${process.env.ALPACA_API_KEY || process.env.DAYTRADE_ALPACA_API_KEY || ''}`,
      `ALPACA_SECRET_KEY=${process.env.ALPACA_SECRET_KEY || process.env.DAYTRADE_ALPACA_SECRET_KEY || ''}`,
    ].join(' ');

    execSync(
      `wsl -d ${wslDistro} --user root -- bash -c "${condaPath} && ${alpacaEnvs} cd ${wslMacroDir} && python -m intraday_model.generate_tree_signals export"`,
      { timeout: PIPELINE_CONFIG.pythonTimeout, stdio: 'pipe' }
    );

    const elapsed = Date.now() - startTime;
    log('INFO', `Signal generation complete via WSL2 (${elapsed}ms)`);
    pipelineState.signalRefreshCount++;
    pipelineState.lastSignalRefreshTime = new Date().toISOString();
    return true;
  } catch (e) {
    pipelineState.signalRefreshErrors++;
    log('ERROR', `Signal generation failed (both methods): ${e.message}`);
    pipelineState.errors.push({
      time: new Date().toISOString(),
      type: 'SIGNAL_REFRESH',
      error: e.message,
    });
    return false;
  }
}

/**
 * Check if signals need refreshing (older than refresh interval).
 */
function shouldRefreshSignals() {
  if (!fs.existsSync(SIGNAL_FILE)) return true;

  try {
    const data = JSON.parse(fs.readFileSync(SIGNAL_FILE, 'utf8'));
    const signalTime = new Date(data.timestamp);
    const ageMs = Date.now() - signalTime.getTime();
    pipelineState.lastSignalAge = Math.round(ageMs / 60000);
    return ageMs > PIPELINE_CONFIG.signalRefreshIntervalMs;
  } catch (e) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Core Pipeline Cycle
// ---------------------------------------------------------------------------

/**
 * Run one complete pipeline cycle:
 *   1. Refresh signals if stale
 *   2. Load signals into shared brain
 *   3. Run executor loop (filter -> risk -> veto -> execute -> monitor)
 */
async function runOnce() {
  const cycleStart = Date.now();
  const timeET = getETTime();
  pipelineState.cycleCount++;
  pipelineState.lastCycleTime = new Date().toISOString();

  log('INFO', `=== Pipeline Cycle #${pipelineState.cycleCount} (${timeET} ET) ===`);

  try {
    // Step 1: Refresh signals if needed
    if (shouldRefreshSignals()) {
      log('INFO', 'Signals stale - refreshing from meta-learner...');
      const refreshed = refreshSignals();
      if (!refreshed) {
        log('WARN', 'Signal refresh failed - will use existing signals if available');
      }
    } else {
      log('INFO', `Signals fresh (${pipelineState.lastSignalAge}m old)`);
    }

    // Step 2: Load signals into shared brain (for other agents' context)
    if (iasmLoader && brain) {
      try {
        iasmLoader.loadAndWrite(brain);
      } catch (e) {
        log('WARN', `Failed to write signals to brain: ${e.message}`);
      }
    }

    // Step 3: Run executor loop (this handles everything: read, filter, veto, execute, monitor)
    if (executor) {
      try {
        await executor.executionLoop();
        pipelineState.executorCycleCount++;
      } catch (e) {
        log('ERROR', `Executor loop error: ${e.message}`);
        pipelineState.errors.push({
          time: new Date().toISOString(),
          type: 'EXECUTOR',
          error: e.message,
        });
      }
    } else {
      log('ERROR', 'Executor not available - cannot process signals');
    }

  } catch (e) {
    log('ERROR', `Pipeline cycle error: ${e.message}`);
    pipelineState.errors.push({
      time: new Date().toISOString(),
      type: 'PIPELINE',
      error: e.message,
    });
  }

  const elapsed = Date.now() - cycleStart;
  log('INFO', `=== Cycle #${pipelineState.cycleCount} complete (${elapsed}ms) ===`);
}

// ---------------------------------------------------------------------------
// Pipeline Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the intraday pipeline loop.
 * Runs every 60s during pipeline hours (9:45 AM - 3:45 PM ET).
 */
async function start() {
  if (pipelineState.isRunning) {
    log('WARN', 'Pipeline already running');
    return;
  }

  pipelineState.isRunning = true;
  pipelineState.startedAt = new Date().toISOString();
  pipelineState.cycleCount = 0;
  pipelineState.errors = [];

  log('INFO', 'IASM Intraday Pipeline starting...');
  log('INFO', `Schedule: Every ${PIPELINE_CONFIG.loopIntervalMs / 1000}s during ${PIPELINE_CONFIG.startTimeET}-${PIPELINE_CONFIG.endTimeET} ET`);
  log('INFO', `Signal refresh: Every ${PIPELINE_CONFIG.signalRefreshIntervalMs / 60000} minutes`);
  log('INFO', `Paper trading: ${executor?.RISK_CONFIG ? 'YES' : 'UNKNOWN'}`);

  // Initialize executor state
  if (executor && typeof executor.loadState === 'function') {
    executor.loadState();
  }

  // Send startup notification
  await notifyDiscord([
    '**IASM Intraday Pipeline Started**',
    `Schedule: ${PIPELINE_CONFIG.startTimeET}-${PIPELINE_CONFIG.endTimeET} ET (every 60s)`,
    `Signal refresh: Every ${PIPELINE_CONFIG.signalRefreshIntervalMs / 60000}m`,
    `Mode: PAPER TRADING`,
    `Signal source: tree_signals_latest.json (V2 Tree models only - XGB+LightGBM)`,
  ].join('\n'));

  // Run immediately if within hours
  if (isWithinPipelineHours()) {
    await runOnce();
  }

  // Start loop
  pipelineState.loopHandle = setInterval(async () => {
    if (!pipelineState.isRunning) return;

    if (isWithinPipelineHours()) {
      try {
        await runOnce();
      } catch (e) {
        log('ERROR', `Unhandled pipeline error: ${e.message}`);
      }
    } else {
      // Outside pipeline hours
      const timeET = getETTime();
      const { hour, minute } = getETHourMinute();

      // Send daily summary at 4:00 PM
      if (hour === 16 && minute < 2 && executor) {
        try {
          await executor.sendDailySummary();
        } catch (e) {
          log('WARN', `Daily summary error: ${e.message}`);
        }
      }
    }
  }, PIPELINE_CONFIG.loopIntervalMs);

  // Graceful shutdown handlers
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('INFO', 'Pipeline started successfully');
}

/**
 * Stop the intraday pipeline.
 */
async function stop() {
  if (!pipelineState.isRunning) return;

  pipelineState.isRunning = false;

  if (pipelineState.loopHandle) {
    clearInterval(pipelineState.loopHandle);
    pipelineState.loopHandle = null;
  }

  // Save executor state
  if (executor && typeof executor.saveState === 'function') {
    executor.saveState();
  }

  log('INFO', 'IASM Intraday Pipeline stopped');

  await notifyDiscord([
    '**IASM Intraday Pipeline Stopped**',
    `Cycles run: ${pipelineState.cycleCount}`,
    `Signals refreshed: ${pipelineState.signalRefreshCount}`,
    `Errors: ${pipelineState.errors.length}`,
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Status & Monitoring
// ---------------------------------------------------------------------------

/**
 * Get current pipeline status.
 */
function getStatus() {
  const executorStatus = executor ? executor.getStatus() : null;

  return {
    pipeline: {
      isRunning: pipelineState.isRunning,
      startedAt: pipelineState.startedAt,
      cycleCount: pipelineState.cycleCount,
      lastCycleTime: pipelineState.lastCycleTime,
      isWithinHours: isWithinPipelineHours(),
      currentTimeET: getETTime(),
      schedule: `${PIPELINE_CONFIG.startTimeET}-${PIPELINE_CONFIG.endTimeET} ET`,
    },
    signals: {
      lastRefresh: pipelineState.lastSignalRefreshTime,
      refreshCount: pipelineState.signalRefreshCount,
      refreshErrors: pipelineState.signalRefreshErrors,
      lastSignalAge: pipelineState.lastSignalAge ? `${pipelineState.lastSignalAge}m` : 'unknown',
      signalFile: SIGNAL_FILE,
      signalFileExists: fs.existsSync(SIGNAL_FILE),
    },
    executor: executorStatus ? {
      positions: executorStatus.positions?.length || 0,
      dailyPnL: executorStatus.dailyPnL,
      tradesExecuted: executorStatus.tradesExecuted,
      tradesVetoed: executorStatus.tradesVetoed,
      signalsProcessed: executorStatus.signalsProcessed,
      tradingHalted: executorStatus.tradingHalted,
      paperMode: executorStatus.paperMode,
    } : null,
    errors: pipelineState.errors.slice(-10),
  };
}

// ---------------------------------------------------------------------------
// Logging & Discord
// ---------------------------------------------------------------------------

function log(level, message) {
  const timestamp = new Date().toISOString();
  const timeET = getETTime();
  console.log(`[IntradayPipeline][${level}] ${message}`);
}

async function notifyDiscord(message) {
  try {
    if (discord && typeof discord.iasmSignals === 'function') {
      await discord.iasmSignals(message);
    } else if (discord && typeof discord.send === 'function') {
      await discord.send('iasmSignals', message);
    } else if (discord && typeof discord.systemStatus === 'function') {
      await discord.systemStatus(message);
    }
  } catch (e) {
    log('WARN', `Discord notification failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Standalone execution
// ---------------------------------------------------------------------------

if (require.main === module) {
  console.log('='.repeat(70));
  console.log('IASM Intraday Trading Pipeline');
  console.log('Mode: PAPER TRADING');
  console.log('='.repeat(70));

  const command = process.argv[2] || 'start';

  (async () => {
    switch (command) {
      case 'start':
        await start();
        console.log('Press Ctrl+C to stop');
        break;

      case 'once':
        await runOnce();
        process.exit(0);
        break;

      case 'refresh':
        const success = refreshSignals();
        console.log(success ? 'Signal refresh successful' : 'Signal refresh failed');
        process.exit(success ? 0 : 1);
        break;

      case 'status':
        console.log(JSON.stringify(getStatus(), null, 2));
        process.exit(0);
        break;

      default:
        console.log(`
IASM Intraday Trading Pipeline

Commands:
  start    - Start the pipeline (default)
  once     - Run one pipeline cycle
  refresh  - Refresh signals from meta-learner
  status   - Show pipeline status
        `);
        process.exit(0);
    }
  })().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  runOnce,
  refreshSignals,
  getStatus,
  isWithinPipelineHours,
  PIPELINE_CONFIG,
};
