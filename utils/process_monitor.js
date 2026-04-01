/**
 * Process Monitor
 *
 * Monitors long-running processes (training jobs, etc.) and sends
 * Discord alerts when they complete, crash, or hit errors.
 *
 * Usage:
 *   node utils/process_monitor.js watch <logFile> [--interval 60]
 *   node utils/process_monitor.js check <logFile>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let discord;
try {
  discord = require('../trading_agents/discord_channels');
  discord.loadWebhooksFromFile();
} catch (e) {
  console.warn('[Monitor] Discord not available:', e.message);
}

/**
 * Check if a WSL process is still running by searching for it
 */
function isWSLProcessRunning(searchTerm = 'model_shootout') {
  try {
    const result = execSync(
      `wsl -d Ubuntu-22.04 -- bash -c "pgrep -f '${searchTerm}' 2>/dev/null"`,
      { timeout: 10000, encoding: 'utf8' }
    ).trim();
    return result.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Get tail of a log file (works for both Windows and WSL paths)
 */
function getLogTail(logFile, lines = 30) {
  try {
    // Try WSL path first
    const wslPath = logFile.startsWith('/mnt/') ? logFile :
      '/mnt/c' + logFile.replace(/\\/g, '/').replace(/^C:/i, '');
    const result = execSync(
      `wsl -d Ubuntu-22.04 -- bash -c "tail -${lines} '${wslPath}' 2>/dev/null"`,
      { timeout: 10000, encoding: 'utf8' }
    ).trim();
    return result;
  } catch (e) {
    // Fall back to Windows fs
    try {
      const winPath = logFile.replace(/\//g, '\\');
      if (fs.existsSync(winPath)) {
        const content = fs.readFileSync(winPath, 'utf8');
        const allLines = content.split('\n');
        return allLines.slice(-lines).join('\n');
      }
    } catch (e2) { /* ignore */ }
    return null;
  }
}

/**
 * Get log line count
 */
function getLogLineCount(logFile) {
  try {
    const wslPath = logFile.startsWith('/mnt/') ? logFile :
      '/mnt/c' + logFile.replace(/\\/g, '/').replace(/^C:/i, '');
    const result = execSync(
      `wsl -d Ubuntu-22.04 -- bash -c "wc -l < '${wslPath}' 2>/dev/null"`,
      { timeout: 10000, encoding: 'utf8' }
    ).trim();
    return parseInt(result) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Check for errors in log tail
 */
function detectErrors(logTail) {
  if (!logTail) return null;
  const errorPatterns = [
    /Traceback \(most recent call last\)/i,
    /Error: .+/i,
    /Exception: .+/i,
    /FAILED/i,
    /Killed/i,
    /MemoryError/i,
    /OOM/i,
    /CUDA out of memory/i,
  ];
  for (const pattern of errorPatterns) {
    const match = logTail.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * Parse V9 training progress from log
 */
function parseV9Progress(logTail) {
  const progress = {
    stage: 'unknown',
    fold: null,
    model: null,
    ic: null,
    samples: null,
  };

  if (!logTail) return progress;

  // Check for completion
  if (logTail.includes('FINAL RESULTS') || logTail.includes('Results saved')) {
    progress.stage = 'COMPLETED';
    return progress;
  }

  // Walk-forward prediction
  if (logTail.includes('Predicting for') || logTail.includes('rebalance dates')) {
    progress.stage = 'walk-forward prediction';
  }

  // Model fitting
  const fittingMatch = logTail.match(/Fitting (\w+) on (\d+) samples/);
  if (fittingMatch) {
    progress.model = fittingMatch[1];
    progress.samples = fittingMatch[2];
    progress.stage = `fitting ${fittingMatch[1]}`;
  }

  // Fold
  const foldMatch = logTail.match(/Fold (\d+)/);
  if (foldMatch) progress.fold = foldMatch[1];

  // IC
  const icMatch = logTail.match(/(?:Training |Fold \d+ )IC: ([\d.]+)/g);
  if (icMatch) {
    const lastIC = icMatch[icMatch.length - 1].match(/([\d.]+)$/);
    if (lastIC) progress.ic = lastIC[1];
  }

  // Feature engineering
  if (logTail.includes('feature tensor')) {
    progress.stage = 'feature engineering';
  }

  return progress;
}

/**
 * Single check of a monitored process
 */
async function checkProcess(logFile, processSearch = 'model_shootout') {
  const running = isWSLProcessRunning(processSearch);
  const tail = getLogTail(logFile);
  const lineCount = getLogLineCount(logFile);
  const error = detectErrors(tail);
  const progress = parseV9Progress(tail);

  return {
    running,
    lineCount,
    error,
    progress,
    tail: tail ? tail.split('\n').slice(-10).join('\n') : null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Watch a process and send Discord alerts on state changes
 */
async function watchProcess(logFile, options = {}) {
  const {
    processSearch = 'model_shootout',
    intervalMs = 120000, // Check every 2 minutes
    label = 'V9 Training',
  } = options;

  let lastLineCount = 0;
  let lastRunning = true;
  let staleCount = 0;
  let completed = false;

  console.log(`[Monitor] Watching ${label} (log: ${logFile})`);
  console.log(`[Monitor] Check interval: ${intervalMs / 1000}s`);

  const check = async () => {
    if (completed) return;

    const status = await checkProcess(logFile, processSearch);

    // Process just died
    if (lastRunning && !status.running) {
      if (status.progress.stage === 'COMPLETED') {
        completed = true;
        const msg = `**${label}: COMPLETED** ✅\n\nLog: ${status.lineCount} lines\nLast output:\n\`\`\`\n${status.tail}\n\`\`\``;
        console.log(`[Monitor] ${label} COMPLETED!`);
        if (discord) await discord.systemStatus(msg);
      } else if (status.error) {
        const msg = `**${label}: CRASHED** ❌\n\nError: ${status.error}\nLog: ${status.lineCount} lines\nLast output:\n\`\`\`\n${status.tail}\n\`\`\``;
        console.log(`[Monitor] ${label} CRASHED: ${status.error}`);
        if (discord) await discord.systemStatus(msg);
      } else {
        const msg = `**${label}: Process ended** ⚠️\n\nNo error detected but process stopped.\nLog: ${status.lineCount} lines\nLast output:\n\`\`\`\n${status.tail}\n\`\`\``;
        console.log(`[Monitor] ${label} ended unexpectedly`);
        if (discord) await discord.systemStatus(msg);
      }
      lastRunning = false;
      return;
    }

    // Check for stale log (no new lines in multiple checks)
    if (status.running && status.lineCount === lastLineCount) {
      staleCount++;
      if (staleCount >= 5) { // 10 minutes with no progress
        const msg = `**${label}: Possibly stuck** ⚠️\n\nNo log output for ${staleCount * (intervalMs / 60000)} minutes.\nStage: ${status.progress.stage}\nLog: ${status.lineCount} lines`;
        console.log(`[Monitor] ${label} possibly stuck`);
        if (discord) await discord.systemStatus(msg);
        staleCount = 0; // Reset to avoid spam
      }
    } else {
      staleCount = 0;
    }

    // Progress update every 10 checks (~20 min)
    if (status.running && status.lineCount !== lastLineCount && status.lineCount % 50 < 5) {
      console.log(`[Monitor] ${label}: ${status.progress.stage} | Lines: ${status.lineCount} | IC: ${status.progress.ic || 'N/A'}`);
    }

    lastLineCount = status.lineCount;
    lastRunning = status.running;
  };

  // Initial check
  await check();

  // Periodic checks
  const interval = setInterval(check, intervalMs);

  return {
    stop: () => clearInterval(interval),
    check,
  };
}

// Export
module.exports = {
  isWSLProcessRunning,
  getLogTail,
  getLogLineCount,
  detectErrors,
  parseV9Progress,
  checkProcess,
  watchProcess,
};

// CLI
if (require.main === module) {
  const command = process.argv[2];
  const logFile = process.argv[3];

  if (command === 'check' && logFile) {
    checkProcess(logFile).then(status => {
      console.log(JSON.stringify(status, null, 2));
    });
  } else if (command === 'watch' && logFile) {
    const interval = parseInt(process.argv[4]) || 120;
    watchProcess(logFile, { intervalMs: interval * 1000 }).then(() => {
      console.log('Watching... Press Ctrl+C to stop');
    });
  } else {
    console.log('Usage:');
    console.log('  node process_monitor.js check <logFile>');
    console.log('  node process_monitor.js watch <logFile> [intervalSeconds]');
  }
}
