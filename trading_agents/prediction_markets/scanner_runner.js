/**
 * Prediction Market Scanner Runner
 *
 * Node.js wrapper to run the Python strategy engine and parse results.
 * Called by the trading scheduler for automated daily/intraday scans.
 *
 * Usage:
 *   const { runScan, runQuickScan } = require('./prediction_markets/scanner_runner');
 *   const result = await runScan();        // Full 8-strategy scan
 *   const quick = await runQuickScan();    // Fast scan (no LLM)
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/**
 * Run the full strategy engine scan (all 8 strategies).
 * @param {Object} opts
 * @param {number} opts.spx - Current SPX price (default 5900)
 * @param {number} opts.vol - Predicted annualized vol (default 0.18)
 * @param {number} opts.hours - Hours to market close (default 4.0)
 * @param {boolean} opts.withLLM - Include LLM fair value scan (default false)
 * @returns {Promise<{report: string, result: object}>}
 */
function runScan({ spx = 5900, vol = 0.18, hours = 4.0, withLLM = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(SCRIPT_DIR, 'strategy_engine.py'),
      '--scan-all',
      '--spx', String(spx),
      '--vol', String(vol),
      '--hours', String(hours),
    ];
    if (withLLM) args.push('--with-llm');

    execFile(PYTHON, args, {
      cwd: SCRIPT_DIR,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`Scan failed: ${err.message}\n${stderr}`));
      }

      // Try to load the JSON result file
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const resultFile = path.join(DATA_DIR, `strategy_scan_${today}.json`);
      let result = null;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch (e) {
        // Fall back to stdout parsing
      }

      resolve({
        report: stdout.trim(),
        result,
        stderr: stderr.trim(),
      });
    });
  });
}

/**
 * Quick scan — just longshot bias + FOMC (fastest strategies).
 */
function runQuickScan() {
  return runScan({ withLLM: false });
}

/**
 * Collect a market data snapshot for historical analysis.
 */
function collectSnapshot() {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [
      path.join(SCRIPT_DIR, 'strategy_engine.py'),
      '--collect',
    ], {
      cwd: SCRIPT_DIR,
      timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

/**
 * Get upcoming economic events.
 */
function getUpcomingEvents(daysAhead = 14) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [
      '-c',
      `import sys; sys.path.insert(0, '${SCRIPT_DIR.replace(/\\/g, '/')}'); ` +
      `from data_collector import MarketDataCollector; ` +
      `import json; c = MarketDataCollector(); ` +
      `events = c.get_upcoming_events(${daysAhead}); ` +
      `print(json.dumps(events, default=str))`,
    ], {
      cwd: SCRIPT_DIR,
      timeout: 10000,
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

/**
 * Format a scan result for Discord posting.
 */
function formatForDiscord(scanResult) {
  if (!scanResult || !scanResult.result) {
    return scanResult?.report || 'No scan results available.';
  }

  const r = scanResult.result;
  const summary = r.summary || {};
  const strategies = r.strategies || {};

  let msg = `**PREDICTION MARKET SCAN** (${new Date().toLocaleString()})\n`;
  msg += `Total: ${r.total_opportunities} opportunities\n\n`;

  // Strategy breakdown
  for (const [name, data] of Object.entries(strategies)) {
    const label = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (data.error) {
      msg += `  ${label}: ERROR\n`;
    } else if (data.count > 0) {
      msg += `  ${label}: **${data.count}** (edge: $${(data.total_edge || 0).toFixed(4)})\n`;
    }
  }

  msg += `\n**Verdict:** ${summary.verdict || 'N/A'}`;

  // Top opportunities
  const topOpps = r.top_opportunities || [];
  if (topOpps.length > 0) {
    msg += '\n\n**Top Picks:**\n';
    for (let i = 0; i < Math.min(3, topOpps.length); i++) {
      const o = topOpps[i];
      const q = o.question || o.ticker || o.group || '?';
      msg += `${i + 1}. ${q.slice(0, 60)} | Edge: ${(o.net_edge_after_fees || 0).toFixed(4)} | ${o.action}\n`;
    }
  }

  return msg;
}

module.exports = {
  runScan,
  runQuickScan,
  collectSnapshot,
  getUpcomingEvents,
  formatForDiscord,
};
