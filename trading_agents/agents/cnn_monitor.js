/**
 * CNN Walkforward Monitor
 *
 * Monitors the BookSpatialCNN walkforward training progress.
 * Parses log files, extracts IC values, detects completion,
 * and sends Discord progress reports.
 *
 * Schedule: Every 30 minutes when GPU is active
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const discord = require('../discord_channels');

let completionHandler;
try { completionHandler = require('./cnn_completion_handler'); } catch (e) {}

const LVL3QUANT_DIR = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant';
const RESULTS_DIR = path.join(LVL3QUANT_DIR, 'alpha_discovery', 'deep_models', 'results');
const STATE_FILE = path.join(__dirname, '..', 'data', 'cnn_monitor_state.json');

// ============================================================================
// STATE
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return {
    lastCheck: null,
    lastReportedFold: 0,
    lastReportedEpoch: 0,
    completedFolds: 0,
    totalFolds: 94,
    foldICs: [],
    logFile: null,
    isComplete: false,
    gpuUtilization: null,
  };
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// LOG PARSER
// ============================================================================

/**
 * Find the most recent walkforward log file
 */
function findLatestLog() {
  try {
    const files = fs.readdirSync(RESULTS_DIR)
      .filter(f => f.startsWith('walkforward_book_') && f.endsWith('.log') && !f.includes('resume'))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(RESULTS_DIR, files[0]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Parse a walkforward log file for fold results
 */
function parseLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return null;

  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n');

  const result = {
    logFile: path.basename(logFile),
    totalFolds: 94,
    windowMode: 'unknown',
    nDays: 0,
    checkpointResume: 0,
    folds: [],
    currentFold: null,
    currentEpoch: null,
    isComplete: false,
    summary: null,
  };

  // Parse header
  for (const line of lines.slice(0, 25)) {
    const nDaysMatch = line.match(/n_days:\s+(\d+)/);
    if (nDaysMatch) result.nDays = parseInt(nDaysMatch[1]);

    const windowMatch = line.match(/window_mode:\s+(\w+)/);
    if (windowMatch) result.windowMode = windowMatch[1];

    const totalMatch = line.match(/Total folds:\s+(\d+)/);
    if (totalMatch) result.totalFolds = parseInt(totalMatch[1]);

    const resumeMatch = line.match(/CHECKPOINT RESUME: Skipping (\d+) completed folds/);
    if (resumeMatch) result.checkpointResume = parseInt(resumeMatch[1]);
  }

  // Parse fold results
  let currentFoldNum = null;
  let currentFoldEpochs = [];

  for (const line of lines) {
    // Fold header
    const foldMatch = line.match(/--- Fold (\d+)\/(\d+) \| Train: ([\d-]+)\.\.([\d-]+) \((\d+)d\) \| Test: ([\d-]+)/);
    if (foldMatch) {
      // Save previous fold if exists
      if (currentFoldNum !== null && currentFoldEpochs.length > 0) {
        const bestEpoch = currentFoldEpochs.reduce((best, e) => e.ic > best.ic ? e : best);
        result.folds.push({
          fold: currentFoldNum,
          trainDays: parseInt(foldMatch[5]),
          testDate: foldMatch[6],
          bestIC: bestEpoch.ic,
          bestEpoch: bestEpoch.epoch,
          epochs: currentFoldEpochs,
          overfit: currentFoldEpochs.some(e => e.overfit),
        });
      }
      currentFoldNum = parseInt(foldMatch[1]);
      result.totalFolds = parseInt(foldMatch[2]);
      currentFoldEpochs = [];
      result.currentFold = currentFoldNum;
    }

    // Epoch result
    const epochMatch = line.match(/Epoch (\d+)\/(\d+): train_loss=([\d.]+)\s+val_loss=([\d.]+)\s+IC=([+-]?[\d.]+)(?:\s+\([\d.]+s\))?(?:\s+\*\*OVERFIT\*\*)?/);
    if (epochMatch) {
      const epoch = {
        epoch: parseInt(epochMatch[1]),
        totalEpochs: parseInt(epochMatch[2]),
        trainLoss: parseFloat(epochMatch[3]),
        valLoss: parseFloat(epochMatch[4]),
        ic: parseFloat(epochMatch[5]),
        overfit: line.includes('**OVERFIT**'),
      };
      currentFoldEpochs.push(epoch);
      result.currentEpoch = epoch.epoch;
    }

    // Summary line
    const summaryMatch = line.match(/WALKFORWARD COMPLETE|Walk-forward complete|FINAL RESULTS/i);
    if (summaryMatch) {
      result.isComplete = true;
    }

    // Mean IC summary
    const meanMatch = line.match(/Mean IC[:\s]+([-+]?[\d.]+)/);
    if (meanMatch && result.isComplete) {
      result.summary = { meanIC: parseFloat(meanMatch[1]) };
    }
  }

  // Handle last fold in progress
  if (currentFoldNum !== null && currentFoldEpochs.length > 0) {
    const bestEpoch = currentFoldEpochs.reduce((best, e) => e.ic > best.ic ? e : best);
    result.folds.push({
      fold: currentFoldNum,
      bestIC: bestEpoch.ic,
      bestEpoch: bestEpoch.epoch,
      epochs: currentFoldEpochs,
      overfit: currentFoldEpochs.some(e => e.overfit),
    });
  }

  return result;
}

/**
 * Parse checkpoint file for pre-resume IC data
 */
function parseCheckpoint() {
  try {
    const files = fs.readdirSync(RESULTS_DIR)
      .filter(f => f.startsWith('checkpoint_book_') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, files[0]), 'utf8'));
    return {
      completedFolds: data.completed_folds || 0,
      meanIC: data.mean_ic || 0,
      allPositive: data.all_positive || false,
      foldICs: data.fold_ics || [],
    };
  } catch (e) {
    return null;
  }
}

/**
 * Get GPU utilization
 */
function getGPUStatus() {
  try {
    const output = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const parts = output.split(',').map(s => s.trim());
    return {
      utilization: parseInt(parts[0]),
      memoryUsed: parseInt(parts[1]),
      memoryTotal: parseInt(parts[2]),
      temperature: parseInt(parts[3]),
    };
  } catch (e) {
    return null;
  }
}

// ============================================================================
// AGENT
// ============================================================================

class CNNMonitor {
  constructor() {
    this.name = 'CNN Monitor';
    this.emoji = '🧠';
    this.lastRun = null;
  }

  /**
   * Main monitoring run
   */
  async run() {
    const state = loadState();

    // If training is already complete AND we've already reported, skip entirely.
    // This prevents any edge-case re-sends (duplicate folds, stale logs, etc.)
    if (state.isComplete && state.completionReported) {
      state.lastCheck = new Date().toISOString();
      saveState(state);
      return { status: 'complete_already_reported', fold: `${state.completedFolds}/${state.totalFolds}` };
    }

    const gpu = getGPUStatus();
    state.gpuUtilization = gpu?.utilization || null;

    // Check if GPU is active (training running)
    if (!gpu || gpu.utilization < 20) {
      // GPU idle — check if training completed
      if (state.completedFolds > 0 && !state.isComplete) {
        // Training might have stopped
        console.log('[CNNMonitor] GPU idle but training was in progress — checking log...');
      } else {
        state.lastCheck = new Date().toISOString();
        saveState(state);
        return { status: 'gpu_idle', gpu };
      }
    }

    // Find and parse latest log
    const logFile = findLatestLog();
    if (!logFile) {
      state.lastCheck = new Date().toISOString();
      saveState(state);
      return { status: 'no_log' };
    }

    const logData = parseLog(logFile);
    if (!logData) {
      state.lastCheck = new Date().toISOString();
      saveState(state);
      return { status: 'parse_error' };
    }

    // Get checkpoint data for pre-resume folds
    const checkpoint = parseCheckpoint();

    // Calculate total progress
    const checkpointFolds = checkpoint?.completedFolds || logData.checkpointResume || 0;
    const logFolds = logData.folds.filter(f => f.epochs.length === (f.epochs[0]?.totalEpochs || 3)).length;
    const totalCompletedFolds = checkpointFolds + logFolds;
    const currentFold = logData.currentFold || totalCompletedFolds + 1;

    // Combine all ICs
    const allICs = [
      ...(checkpoint?.foldICs || []),
      ...logData.folds.map(f => f.bestIC),
    ];
    const meanIC = allICs.length > 0
      ? allICs.reduce((s, v) => s + v, 0) / allICs.length
      : 0;
    const positiveCount = allICs.filter(ic => ic > 0).length;
    const pctPositive = allICs.length > 0 ? (positiveCount / allICs.length * 100).toFixed(1) : '0';

    // Check if new folds completed since last report
    const newFoldsCompleted = totalCompletedFolds > state.lastReportedFold;
    const significantProgress = totalCompletedFolds - state.lastReportedFold >= 2;
    const trainingComplete = logData.isComplete || totalCompletedFolds >= logData.totalFolds;

    // Update state
    state.logFile = path.basename(logFile);
    state.completedFolds = totalCompletedFolds;
    state.totalFolds = logData.totalFolds;
    state.foldICs = allICs;
    state.isComplete = trainingComplete;
    state.lastCheck = new Date().toISOString();

    // ETA calculation
    let etaHours = null;
    if (logData.folds.length >= 2) {
      // Estimate time per fold from log timestamps
      const foldsRemaining = logData.totalFolds - totalCompletedFolds;
      // Each fold = 3 epochs * ~34 min = ~102 min
      const minPerFold = logData.windowMode === 'expanding' ? 120 : 40; // expanding takes longer
      etaHours = (foldsRemaining * minPerFold / 60).toFixed(1);
    }

    // Send report on significant progress or completion
    if (trainingComplete) {
      // Only send completion report ONCE — skip if already reported complete
      if (!state.completionReported) {
        if (completionHandler) {
          try {
            await completionHandler.analyzeCompletion();
          } catch (e) {
            console.warn('[CNNMonitor] Completion handler error, falling back:', e.message);
            await this._sendCompletionReport(logData, checkpoint, allICs, meanIC, positiveCount, gpu);
          }
        } else {
          await this._sendCompletionReport(logData, checkpoint, allICs, meanIC, positiveCount, gpu);
        }
        state.completionReported = true;
      }
      state.lastReportedFold = totalCompletedFolds;
    } else if (significantProgress || (newFoldsCompleted && state.lastReportedFold === 0)) {
      await this._sendProgressReport(logData, checkpoint, totalCompletedFolds, currentFold, allICs, meanIC, positiveCount, pctPositive, gpu, etaHours);
      state.lastReportedFold = totalCompletedFolds;
    }

    saveState(state);

    this.lastRun = new Date();
    return {
      status: trainingComplete ? 'complete' : 'training',
      fold: `${currentFold}/${logData.totalFolds}`,
      meanIC: meanIC.toFixed(4),
      positive: `${positiveCount}/${allICs.length}`,
      gpu,
      etaHours,
    };
  }

  /**
   * Send progress report to Discord
   */
  async _sendProgressReport(logData, checkpoint, totalCompleted, currentFold, allICs, meanIC, positiveCount, pctPositive, gpu, etaHours) {
    // Get recent ICs for trend
    const recentICs = allICs.slice(-5);
    const recentTrend = recentICs.map(ic => ic >= 0.15 ? '🟢' : ic >= 0.10 ? '🟡' : ic >= 0.05 ? '🟠' : '🔴').join('');

    let msg = `${this.emoji} **CNN WALKFORWARD PROGRESS**\n\n`;
    msg += `**Fold:** ${currentFold}/${logData.totalFolds} (${(currentFold / logData.totalFolds * 100).toFixed(0)}%)\n`;
    msg += `**Mean IC:** +${meanIC.toFixed(4)} | Positive: ${positiveCount}/${allICs.length} (${pctPositive}%)\n`;
    msg += `**Window:** ${logData.windowMode} ${logData.nDays}d\n`;
    msg += `**Recent trend:** ${recentTrend}\n`;

    if (gpu) {
      msg += `**GPU:** ${gpu.utilization}% | ${gpu.memoryUsed}/${gpu.memoryTotal} MiB | ${gpu.temperature}°C\n`;
    }

    if (etaHours) {
      msg += `**ETA:** ~${etaHours} hours\n`;
    }

    // Latest fold detail
    if (logData.folds.length > 0) {
      const latest = logData.folds[logData.folds.length - 1];
      msg += `\n**Latest fold ${latest.fold}:** IC=+${latest.bestIC.toFixed(4)} (epoch ${latest.bestEpoch})`;
      if (latest.overfit) msg += ' ⚠️ OVERFIT';
      msg += '\n';
    }

    try {
      await discord.systemStatus(msg);
    } catch (e) {
      console.warn('[CNNMonitor] Discord error:', e.message);
    }
  }

  /**
   * Send completion report to Discord
   */
  async _sendCompletionReport(logData, checkpoint, allICs, meanIC, positiveCount, gpu) {
    const pctPositive = (positiveCount / allICs.length * 100).toFixed(1);

    // Regime analysis
    const regimeAnalysis = this._analyzeRegimes(logData, checkpoint);

    let msg = `${this.emoji} **CNN WALKFORWARD COMPLETE** 🎉\n\n`;
    msg += `**FINAL RESULTS:**\n`;
    msg += `• Mean IC: **+${meanIC.toFixed(4)}**\n`;
    msg += `• Positive folds: **${positiveCount}/${allICs.length} (${pctPositive}%)**\n`;
    msg += `• Window: ${logData.windowMode} ${logData.nDays}d\n`;
    msg += `• Total folds: ${logData.totalFolds}\n\n`;

    // IC distribution
    const ics = allICs.sort((a, b) => a - b);
    const min = ics[0];
    const max = ics[ics.length - 1];
    const median = ics[Math.floor(ics.length / 2)];
    const p25 = ics[Math.floor(ics.length * 0.25)];
    const p75 = ics[Math.floor(ics.length * 0.75)];

    msg += `**IC Distribution:**\n`;
    msg += `• Min: ${min.toFixed(4)} | P25: ${p25.toFixed(4)} | Median: ${median.toFixed(4)}\n`;
    msg += `• P75: ${p75.toFixed(4)} | Max: ${max.toFixed(4)}\n\n`;

    // Regime breakdown
    if (regimeAnalysis) {
      msg += `**REGIME ANALYSIS:**\n`;
      for (const [regime, stats] of Object.entries(regimeAnalysis)) {
        msg += `• ${regime}: Mean IC=${stats.meanIC.toFixed(4)}, ${stats.positive}/${stats.total} positive\n`;
      }
      msg += '\n';
    }

    msg += `**NEXT STEPS:**\n`;
    msg += `1. Check if IC is tradeable after costs (need IC > ~0.2 for ES)\n`;
    msg += `2. Run signal persistence analysis (hold duration)\n`;
    msg += `3. Consider ensemble with ET model\n`;

    try {
      await discord.systemStatus(msg);
      // Also DM the user
      await discord.send('systemStatus', `🎉 **CNN Walkforward DONE!** Mean IC=+${meanIC.toFixed(4)}, ${positiveCount}/${allICs.length} positive folds. Check #system-status for full report.`);
    } catch (e) {
      console.warn('[CNNMonitor] Discord error:', e.message);
    }
  }

  /**
   * Analyze IC by regime (early vs late period)
   */
  _analyzeRegimes(logData, checkpoint) {
    // Combine all fold data
    const allFolds = [];

    // Checkpoint folds (pre-resume, typically Jul-Oct dates)
    if (checkpoint?.foldICs) {
      for (let i = 0; i < checkpoint.foldICs.length; i++) {
        allFolds.push({ index: i, ic: checkpoint.foldICs[i], source: 'checkpoint' });
      }
    }

    // Log folds (with test dates)
    for (const fold of logData.folds) {
      allFolds.push({
        index: fold.fold,
        ic: fold.bestIC,
        testDate: fold.testDate || null,
        overfit: fold.overfit,
        source: 'log',
      });
    }

    if (allFolds.length < 10) return null;

    // Split into early (first 60%) and late (last 40%) — proxy for regime
    const splitIdx = Math.floor(allFolds.length * 0.6);
    const early = allFolds.slice(0, splitIdx);
    const late = allFolds.slice(splitIdx);

    const stats = (folds) => {
      const ics = folds.map(f => f.ic);
      return {
        meanIC: ics.reduce((s, v) => s + v, 0) / ics.length,
        positive: ics.filter(v => v > 0).length,
        total: ics.length,
      };
    };

    return {
      'Early period (Jul-Sep)': stats(early),
      'Late period (Oct-Nov)': stats(late),
    };
  }

  getStatus() {
    const state = loadState();
    return {
      lastCheck: state.lastCheck,
      fold: `${state.completedFolds}/${state.totalFolds}`,
      isComplete: state.isComplete,
      gpu: state.gpuUtilization,
    };
  }
}

module.exports = CNNMonitor;
