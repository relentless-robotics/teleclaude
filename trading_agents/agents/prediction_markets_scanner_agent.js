/**
 * Prediction Markets Scanner Agent
 *
 * JS wrapper around prediction_markets/ Python scripts that runs on a schedule
 * via the Trading Agent Scheduler.
 *
 * Runs two pipelines:
 *   1. auto_scanner.py — price recording + scalper signals (every scan)
 *   2. edge_detector.py — composite edge detection with LLM (every 3rd scan)
 *
 * Schedule:
 *   - Every 30 minutes during market hours (9:30 AM - 4:00 PM ET)
 *   - Every 2 hours off-hours (for political/global markets that trade 24/7)
 *
 * Sends Discord alerts to #prediction-markets when:
 *   - New scalping signals found
 *   - High-confidence edges detected (score 80+)
 *
 * Tracks signal history to avoid duplicate alerts.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

const PM_DIR = path.join(__dirname, '..', 'prediction_markets');
const SCANNER_SCRIPT = path.join(PM_DIR, 'auto_scanner.py');
const EDGE_DETECTOR_SCRIPT = path.join(PM_DIR, 'edge_detector.py');
const TRADER_SCRIPT = path.join(PM_DIR, 'polymarket_trader.py');
const STATE_FILE = path.join(__dirname, '..', 'data', 'pred_markets_scanner_state.json');
const DAILY_SUMMARY_DIR = path.join(PM_DIR, 'data', 'daily_summaries');
const EDGE_RESULTS_FILE = path.join(PM_DIR, 'data', 'edge_detector_results.json');
const PAPER_POSITIONS_FILE = path.join(PM_DIR, 'data', 'polymarket_paper_positions.json');
const PAPER_TRADES_LOG = path.join(PM_DIR, 'data', 'polymarket_paper_trades.jsonl');

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.warn('[PredScanner] Failed to load state:', e.message);
  }
  return {
    lastScan: null,
    lastMarketHoursScan: null,
    lastOffHoursScan: null,
    lastEdgeScan: null,
    scanCount: 0,
    todaySignals: 0,
    todayEdges: 0,
    alertedSignals: {},  // slug -> { lastAlerted, type, count }
    alertedEdges: {},    // slug -> { lastAlerted, score, count }
    scanHistory: [],
    errors: [],
  };
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  // Keep history manageable
  if (state.scanHistory.length > 200) state.scanHistory = state.scanHistory.slice(-200);
  if (state.errors.length > 50) state.errors = state.errors.slice(-50);
  // Prune stale alerted signals (older than 24h)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [slug, info] of Object.entries(state.alertedSignals)) {
    if (new Date(info.lastAlerted).getTime() < cutoff) {
      delete state.alertedSignals[slug];
    }
  }
  for (const [slug, info] of Object.entries(state.alertedEdges || {})) {
    if (new Date(info.lastAlerted).getTime() < cutoff) {
      delete state.alertedEdges[slug];
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// PYTHON BRIDGE
// ============================================================================

/**
 * Run a Python script and capture output.
 */
function runPythonScript(script, args = [], timeoutMs = 180000) {
  return new Promise((resolve) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    execFile(python, [script, ...args], {
      cwd: PM_DIR,
      timeout: timeoutMs,
      env: { ...process.env, PYTHONPATH: PM_DIR },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: error ? error.code || 1 : 0,
      });
    });
  });
}

/**
 * Read today's JSONL scan summary to extract signal details.
 */
function readTodaySummary() {
  const today = new Date().toISOString().split('T')[0];
  const summaryFile = path.join(DAILY_SUMMARY_DIR, `scan_${today}.jsonl`);
  if (!fs.existsSync(summaryFile)) return [];

  const entries = [];
  try {
    const lines = fs.readFileSync(summaryFile, 'utf8').trim().split('\n');
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch (e) { /* skip malformed lines */ }
    }
  } catch (e) {
    console.warn('[PredScanner] Failed to read daily summary:', e.message);
  }
  return entries;
}

/**
 * Read the scalper state file for detailed opportunity data.
 */
function readScalperState() {
  const stateFile = path.join(PM_DIR, 'data', 'scalper_state.json');
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) {}
  return null;
}

/**
 * Read the latest scan results from the scalper's output directory.
 */
function readLatestOpportunities() {
  const scanFile = path.join(PM_DIR, 'data', 'latest_scan.json');
  try {
    if (fs.existsSync(scanFile)) {
      return JSON.parse(fs.readFileSync(scanFile, 'utf8'));
    }
  } catch (e) {}
  return null;
}

/**
 * Read edge detector results.
 */
function readEdgeResults() {
  try {
    if (fs.existsSync(EDGE_RESULTS_FILE)) {
      return JSON.parse(fs.readFileSync(EDGE_RESULTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

// ============================================================================
// AGENT
// ============================================================================

class PredictionMarketsScannerAgent {
  constructor() {
    this.name = 'Prediction Markets Scanner';
    this.emoji = '🔍';
    this.lastRun = null;
  }

  /**
   * Main run method — called by the scheduler.
   * Runs auto_scanner.py, then edge_detector.py every 3rd scan.
   * Sends Discord alerts for new signals and high-confidence edges.
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
    });
    console.log(`[${new Date().toISOString()}] ${this.emoji} Prediction Markets Scanner starting... (${timeET} ET)`);

    const state = loadState();

    // --- STEP 1: Run scalper scan (every time) ---
    const scanArgs = ['--scalper-only', '--limit', '500'];
    const result = await runPythonScript(SCANNER_SCRIPT, scanArgs);

    const scanEntry = {
      time: new Date().toISOString(),
      timeET,
      exitCode: result.exitCode,
      stdout: result.stdout,
      newSignals: 0,
      newEdges: 0,
      errors: [],
    };

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.slice(0, 200) || result.stdout.slice(0, 200) || 'Unknown error';
      scanEntry.errors.push(errorMsg);
      state.errors.push({ time: new Date().toISOString(), error: errorMsg });
      console.error(`[PredScanner] auto_scanner.py failed (exit ${result.exitCode}):`, errorMsg);

      // Report errors to Discord (but don't spam — max once per hour)
      const lastErrorAlert = state._lastErrorAlert ? new Date(state._lastErrorAlert).getTime() : 0;
      if (Date.now() - lastErrorAlert > 60 * 60 * 1000) {
        state._lastErrorAlert = new Date().toISOString();
        await discord.predictionMarkets(
          `${this.emoji} **Scanner Error** (${timeET} ET)\n` +
          `Exit code: ${result.exitCode}\n` +
          `\`\`\`${errorMsg}\`\`\``
        );
      }
    } else {
      console.log(`[PredScanner] Scanner output: ${result.stdout}`);

      // Parse the latest scan results for signal details
      const latestScan = readLatestOpportunities();
      const scalperState = readScalperState();

      // Extract new signals from scalper
      const opportunities = scalperState?.opportunities || latestScan?.opportunities || [];
      const newSignals = this._filterNewSignals(opportunities, state);
      scanEntry.newSignals = newSignals.length;

      // Send Discord alert for new scalper signals
      if (newSignals.length > 0) {
        await this._sendSignalAlert(newSignals, result.stdout, timeET, state);
      }

      // Update state with alerted signals
      for (const sig of newSignals) {
        const key = sig.slug || sig.question || 'unknown';
        state.alertedSignals[key] = {
          lastAlerted: new Date().toISOString(),
          type: sig.type || sig.signal || 'unknown',
          price: sig.price,
          count: (state.alertedSignals[key]?.count || 0) + 1,
        };
      }
    }

    // --- STEP 2: Run edge detector (every 3rd scan) ---
    state.scanCount = (state.scanCount || 0) + 1;

    if (state.scanCount % 3 === 0) {
      console.log(`[PredScanner] Running edge detector (scan #${state.scanCount})...`);
      const edgeResult = await runPythonScript(
        EDGE_DETECTOR_SCRIPT,
        ['--scan', '--min-score', '70', '--limit', '200'],
        300000, // 5 min timeout for LLM calls
      );

      if (edgeResult.exitCode === 0) {
        state.lastEdgeScan = new Date().toISOString();

        // Read edge results
        const edges = readEdgeResults();
        if (edges && edges.opportunities) {
          const highConfEdges = edges.opportunities.filter(e => e.composite_score >= 80);
          const newEdges = this._filterNewEdges(highConfEdges, state);
          scanEntry.newEdges = newEdges.length;

          if (newEdges.length > 0) {
            await this._sendEdgeAlert(newEdges, timeET, state);
          }

          // Track alerted edges
          for (const edge of newEdges) {
            const key = edge.slug || 'unknown';
            if (!state.alertedEdges) state.alertedEdges = {};
            state.alertedEdges[key] = {
              lastAlerted: new Date().toISOString(),
              score: edge.composite_score,
              direction: edge.direction,
              count: ((state.alertedEdges[key] || {}).count || 0) + 1,
            };
          }

          state.todayEdges = (state.todayEdges || 0) + newEdges.length;
        }
      } else {
        const edgeErr = edgeResult.stderr.slice(0, 150) || edgeResult.stdout.slice(0, 150);
        console.error(`[PredScanner] edge_detector.py failed:`, edgeErr);
      }
    }

    // --- STEP 3: Paper trading cycle (every scan) ---
    try {
      const paperResult = await this._runPaperTradingCycle(state, timeET);
      scanEntry.paperTrades = paperResult.tradesPlaced || 0;
      scanEntry.paperSummary = paperResult.summary || null;
    } catch (e) {
      console.warn('[PredScanner] Paper trading cycle error:', e.message);
    }

    // --- STEP 4: Periodic summary (every 6th scan ~ 3 hours) ---
    if (state.scanCount % 6 === 0) {
      await this._sendPeriodicSummary(state, timeET);
    }

    // Update state
    state.lastScan = new Date().toISOString();
    state.todaySignals = (state.todaySignals || 0) + scanEntry.newSignals;
    state.scanHistory.push(scanEntry);
    saveState(state);

    // Update shared brain
    this._updateBrain(state, scanEntry);

    this.lastRun = new Date();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ${this.emoji} Prediction Markets Scanner completed in ${elapsed}s (${scanEntry.newSignals} signals, ${scanEntry.newEdges} edges)`);

    return scanEntry;
  }

  /**
   * Filter out signals that were already alerted recently.
   */
  _filterNewSignals(opportunities, state) {
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const newSignals = [];

    for (const opp of opportunities) {
      const key = opp.slug || opp.question || 'unknown';
      const prev = state.alertedSignals[key];

      if (!prev) {
        newSignals.push(opp);
      } else {
        const prevTime = new Date(prev.lastAlerted).getTime();
        const typeChanged = prev.type !== (opp.type || opp.signal || 'unknown');

        if (prevTime < fourHoursAgo || typeChanged) {
          newSignals.push(opp);
        }
      }
    }

    return newSignals;
  }

  /**
   * Filter out edges that were already alerted recently.
   * Higher threshold: only re-alert if score increased by 10+ or 6 hours passed.
   */
  _filterNewEdges(edges, state) {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const alertedEdges = state.alertedEdges || {};
    const newEdges = [];

    for (const edge of edges) {
      const key = edge.slug || 'unknown';
      const prev = alertedEdges[key];

      if (!prev) {
        newEdges.push(edge);
      } else {
        const prevTime = new Date(prev.lastAlerted).getTime();
        const scoreIncreased = edge.composite_score >= (prev.score || 0) + 10;

        if (prevTime < sixHoursAgo || scoreIncreased) {
          newEdges.push(edge);
        }
      }
    }

    return newEdges;
  }

  /**
   * Send Discord alert for new scalping signals.
   */
  async _sendSignalAlert(signals, scanSummary, timeET, state) {
    const mrSignals = signals.filter(s => s.type === 'mean_reversion');
    const momSignals = signals.filter(s => s.type === 'momentum');
    const spreadSignals = signals.filter(s => s.type === 'spread');

    let msg = `${this.emoji} **NEW SCALPING SIGNALS** (${timeET} ET)\n\n`;

    if (mrSignals.length > 0) {
      msg += `**Mean Reversion (${mrSignals.length}):**\n`;
      for (const sig of mrSignals.slice(0, 5)) {
        const direction = sig.signal === 'MEAN_REVERT_LONG' ? 'BUY' : 'SELL';
        const deviation = sig.deviation_pct ? `${(sig.deviation_pct * 100).toFixed(1)}%` : '?';
        msg += `  ${direction === 'BUY' ? '🟢' : '🔴'} **${sig.question || sig.slug}**\n`;
        msg += `    Price: ${sig.price?.toFixed(3) || '?'} | Deviation: ${deviation} | Vol: $${((sig.volume || 0) / 1000).toFixed(0)}K\n`;
      }
      msg += '\n';
    }

    if (momSignals.length > 0) {
      msg += `**Momentum (${momSignals.length}):**\n`;
      for (const sig of momSignals.slice(0, 5)) {
        const direction = sig.signal === 'MOMENTUM_UP' ? 'LONG' : 'SHORT';
        const trend = sig.trend_strength ? `strength=${sig.trend_strength.toFixed(2)}` : '';
        msg += `  ${direction === 'LONG' ? '📈' : '📉'} **${sig.question || sig.slug}**\n`;
        msg += `    Price: ${sig.price?.toFixed(3) || '?'} | ${trend} | Vol: $${((sig.volume || 0) / 1000).toFixed(0)}K\n`;
      }
      msg += '\n';
    }

    if (spreadSignals.length > 0) {
      msg += `**Wide Spreads (${spreadSignals.length}):**\n`;
      for (const sig of spreadSignals.slice(0, 3)) {
        msg += `  💰 **${sig.question || sig.slug}** — Spread: ${(sig.spread * 100).toFixed(1)}%\n`;
      }
      msg += '\n';
    }

    msg += `Scanner: ${scanSummary}\n`;
    msg += `Signals today: ${(state.todaySignals || 0) + signals.length}`;

    try {
      await discord.predictionMarkets(msg);
    } catch (e) {
      console.warn('[PredScanner] Discord send error:', e.message);
    }
  }

  /**
   * Send Discord alert for high-confidence edge detector results (score 80+).
   */
  async _sendEdgeAlert(edges, timeET, state) {
    let msg = `🎯 **HIGH-CONFIDENCE EDGES** (${timeET} ET)\n\n`;

    for (const edge of edges.slice(0, 5)) {
      const score = edge.composite_score;
      const emoji = score >= 90 ? '🔴' : '🟠';
      const signals = (edge.active_signals || []).join(', ');
      const edgeEst = edge.edge_estimate || 0;

      msg += `${emoji} **${(edge.question || edge.slug || '?').slice(0, 60)}**\n`;
      msg += `  Score: **${score}/100** | ${edge.direction} @ ${edge.yes_price?.toFixed(3) || '?'}\n`;
      msg += `  Edge: ${(edgeEst * 100).toFixed(1)} cents | Signals: ${signals}\n`;

      // Add LLM reasoning if available
      const llm = edge.strategies?.llm_mispricing;
      if (llm && llm.reasoning) {
        msg += `  _${llm.reasoning.slice(0, 80)}_\n`;
      }
      msg += '\n';
    }

    msg += `Total edges today: ${(state.todayEdges || 0) + edges.length}`;

    try {
      await discord.predictionMarkets(msg);
    } catch (e) {
      console.warn('[PredScanner] Discord edge alert error:', e.message);
    }
  }

  /**
   * Send periodic summary (every ~3 hours).
   */
  async _sendPeriodicSummary(state, timeET) {
    const todaySummaries = readTodaySummary();
    const successfulScans = todaySummaries.filter(e => e.scalper?.status === 'OK');
    const totalOpps = todaySummaries.reduce((sum, e) => sum + (e.scalper?.opportunities || 0), 0);
    const totalMR = todaySummaries.reduce((sum, e) => sum + (e.scalper?.mean_reversion || 0), 0);
    const totalMom = todaySummaries.reduce((sum, e) => sum + (e.scalper?.momentum || 0), 0);

    let msg = `${this.emoji} **SCANNER SUMMARY** (${timeET} ET)\n\n`;
    msg += `Scans today: ${todaySummaries.length} (${successfulScans.length} successful)\n`;
    msg += `Scalper signals: MR=${totalMR} | Momentum=${totalMom} | Opps=${totalOpps}\n`;
    msg += `Edge detector edges: ${state.todayEdges || 0} (score 80+)\n`;
    msg += `Unique markets alerted: ${Object.keys(state.alertedSignals).length}\n`;
    msg += `Agent scan count: ${state.scanCount}`;

    // Show paper trader status if available (check both state files)
    for (const paperFile of [PAPER_POSITIONS_FILE, path.join(PM_DIR, 'data', 'paper_trades.json')]) {
      if (fs.existsSync(paperFile)) {
        try {
          const paper = JSON.parse(fs.readFileSync(paperFile, 'utf8'));
          if (paper.bankroll !== undefined) {
            // paper_trades.json format (from paper_trader.py)
            const bankroll = paper.bankroll || 0;
            const openPos = Object.values(paper.positions || {}).filter(p => p.status === 'open').length;
            const totalPnl = paper.stats?.total_pnl || 0;
            const winRate = paper.stats?.wins / Math.max(1, (paper.stats?.wins || 0) + (paper.stats?.losses || 0));
            msg += `\n\n**Paper Trader (PaperTrader):** $${bankroll.toFixed(0)} | ${openPos} open | P&L: $${totalPnl.toFixed(2)} | WR: ${(winRate * 100).toFixed(0)}%`;
          } else {
            // polymarket_paper_positions.json format (from polymarket_trader.py)
            const positions = Object.values(paper);
            const openPos = positions.filter(p => p.status === 'open');
            const closedPos = positions.filter(p => p.status === 'closed');
            const totalPnl = closedPos.reduce((sum, p) => sum + (p.pnl || 0), 0);
            const totalExposure = openPos.reduce((sum, p) => sum + (p.cost || 0), 0);
            const wins = closedPos.filter(p => (p.pnl || 0) > 0).length;
            const losses = closedPos.filter(p => (p.pnl || 0) <= 0).length;
            const winRate = wins / Math.max(1, wins + losses);
            msg += `\n\n**Paper Trader (AutoTrader):** ${openPos.length} open ($${totalExposure.toFixed(0)}) | P&L: $${totalPnl.toFixed(2)} | WR: ${(winRate * 100).toFixed(0)}% (${wins}W/${losses}L)`;
          }
          break; // Only show one
        } catch (e) {}
      }
    }

    if (state.errors.length > 0) {
      const recentErrors = state.errors.slice(-3);
      msg += `\n\nRecent errors (${state.errors.length} total):\n`;
      for (const err of recentErrors) {
        msg += `  - ${err.error.slice(0, 80)}\n`;
      }
    }

    try {
      await discord.predictionMarkets(msg);
    } catch (e) {
      console.warn('[PredScanner] Discord summary send error:', e.message);
    }
  }

  /**
   * Run one paper trading cycle via polymarket_trader.py --paper --auto --single-cycle.
   * Scans for signals, places paper trades, checks stop-losses.
   */
  async _runPaperTradingCycle(state, timeET) {
    console.log('[PredScanner] Running paper trading cycle...');

    const result = await runPythonScript(
      TRADER_SCRIPT,
      ['--paper', '--auto', '--single-cycle', '--max-exposure', '500', '--min-edge', '0.02'],
      180000, // 3 min timeout
    );

    if (result.exitCode !== 0) {
      const errMsg = result.stderr.slice(0, 200) || result.stdout.slice(0, 200);
      console.warn('[PredScanner] Paper trading cycle failed:', errMsg);
      return { tradesPlaced: 0, error: errMsg };
    }

    // Parse JSON output from single-cycle mode
    let tradeResult = {};
    try {
      // The output contains log lines + JSON at the end. Extract the JSON.
      const lines = result.stdout.split('\n');
      // Find the first line that starts with '{'
      let jsonStr = '';
      let inJson = false;
      for (const line of lines) {
        if (line.trim().startsWith('{')) inJson = true;
        if (inJson) jsonStr += line + '\n';
      }
      if (jsonStr) {
        tradeResult = JSON.parse(jsonStr);
      }
    } catch (e) {
      console.warn('[PredScanner] Could not parse paper trade result:', e.message);
    }

    const tradesPlaced = tradeResult.trades_placed || 0;
    const summary = {
      openPositions: tradeResult.open_positions || 0,
      totalExposure: tradeResult.total_exposure || 0,
      totalPnl: tradeResult.total_pnl || 0,
      winRate: tradeResult.win_rate || 0,
      wins: tradeResult.wins || 0,
      losses: tradeResult.losses || 0,
    };

    // Send Discord alert if new trades were placed
    if (tradesPlaced > 0) {
      let msg = `**PAPER TRADE** (${timeET} ET)\n`;
      const trades = tradeResult.trades || [];
      for (const t of trades.slice(0, 5)) {
        msg += `  ${t.direction} **${(t.slug || '').slice(0, 50)}** @ ${t.price?.toFixed(3) || '?'} x $${t.size || 0}\n`;
        msg += `    Signal: ${t.signal_type || '?'}\n`;
      }
      msg += `\nPortfolio: $${summary.totalExposure.toFixed(0)} exposure | ${summary.openPositions} open | P&L: $${summary.totalPnl.toFixed(2)} | WR: ${(summary.winRate * 100).toFixed(0)}%`;

      try {
        await discord.predictionMarkets(msg);
      } catch (e) {
        console.warn('[PredScanner] Discord paper trade alert error:', e.message);
      }
    }

    console.log(
      `[PredScanner] Paper trading: ${tradesPlaced} new trades, ` +
      `${summary.openPositions} open, P&L: $${summary.totalPnl.toFixed(2)}`
    );

    return { tradesPlaced, summary };
  }

  /**
   * Read paper trading portfolio state.
   */
  _readPaperPortfolio() {
    try {
      if (fs.existsSync(PAPER_POSITIONS_FILE)) {
        return JSON.parse(fs.readFileSync(PAPER_POSITIONS_FILE, 'utf8'));
      }
    } catch (e) {}
    return null;
  }

  /**
   * Update shared brain with scanner state.
   */
  _updateBrain(state, scanEntry) {
    const paperPortfolio = this._readPaperPortfolio();
    brain.ctx.predictionMarketsScanner = {
      lastScan: state.lastScan,
      lastEdgeScan: state.lastEdgeScan,
      scanCount: state.scanCount,
      todaySignals: state.todaySignals,
      todayEdges: state.todayEdges || 0,
      lastNewSignals: scanEntry.newSignals,
      lastNewEdges: scanEntry.newEdges || 0,
      lastPaperTrades: scanEntry.paperTrades || 0,
      activeAlerts: Object.keys(state.alertedSignals).length,
      hasErrors: scanEntry.errors.length > 0,
      paperTrading: paperPortfolio ? {
        openPositions: Object.keys(paperPortfolio).filter(k => paperPortfolio[k]?.status === 'open').length,
        totalPnl: Object.values(paperPortfolio).reduce((sum, p) => sum + (p.pnl || 0), 0),
      } : null,
      updatedAt: new Date().toISOString(),
    };
    brain.logAgent('pred-markets-scanner', `Scan #${state.scanCount}: ${scanEntry.newSignals} signals, ${scanEntry.newEdges || 0} edges, ${scanEntry.paperTrades || 0} paper trades`);
  }

  /**
   * Get status for scheduler display.
   */
  getStatus() {
    const state = loadState();
    return {
      lastScan: state.lastScan,
      lastEdgeScan: state.lastEdgeScan,
      scanCount: state.scanCount || 0,
      todaySignals: state.todaySignals || 0,
      todayEdges: state.todayEdges || 0,
      activeAlerts: Object.keys(state.alertedSignals || {}).length,
      recentErrors: state.errors?.length || 0,
    };
  }
}

module.exports = PredictionMarketsScannerAgent;
