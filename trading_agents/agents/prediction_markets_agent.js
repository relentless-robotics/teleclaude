/**
 * Prediction Markets Agent — Scheduled Scanner
 *
 * Wraps the Python prediction_markets daily_scanner.py for use in the
 * Trading Agent Scheduler. Runs at configurable intervals to scan for
 * edge in prediction markets (Kalshi, Polymarket).
 *
 * Strategies:
 *   1. FOMC divergence (CME vs Kalshi)
 *   2. SPX vol brackets (vol model IC=0.644)
 *   3. Combinatorial arb (Polymarket)
 *   4. Event-driven macro
 *   5. Cross-platform arb
 *
 * Schedule: Daily at 8:00 AM ET (pre-market), 12:00 PM ET (midday)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const brain = require('../shared_brain');
const discord = require('../discord_channels');

const PM_DIR = path.join(__dirname, '..', 'prediction_markets');
const DATA_DIR = path.join(PM_DIR, 'data');
const STATE_FILE = path.join(__dirname, '..', 'data', 'prediction_markets_state.json');

// ============================================================================
// STATE
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return {
    lastScan: null,
    lastFOMCScan: null,
    lastVolSignal: null,
    scanHistory: [],
    activeOpportunities: [],
    fomcDivergence: null,
  };
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  if (state.scanHistory.length > 100) state.scanHistory = state.scanHistory.slice(-100);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// PYTHON BRIDGE
// ============================================================================

/**
 * Run a Python script and capture output.
 * Returns { stdout, stderr, exitCode }
 */
function runPython(scriptPath, args = [], timeoutMs = 60000) {
  return new Promise((resolve) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    execFile(python, [scriptPath, ...args], {
      cwd: PM_DIR,
      timeout: timeoutMs,
      env: { ...process.env, PYTHONPATH: PM_DIR },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code || 1 : 0,
      });
    });
  });
}

/**
 * Read the latest scan results JSON
 */
function readLatestScan() {
  const today = new Date().toISOString().split('T')[0];
  const scanFile = path.join(DATA_DIR, `daily_scan_${today}.json`);
  try {
    if (fs.existsSync(scanFile)) {
      return JSON.parse(fs.readFileSync(scanFile, 'utf8'));
    }
  } catch (e) {}

  // Fallback: read strategy_scan file
  const stratFile = path.join(DATA_DIR, `strategy_scan_${today.replace(/-/g, '')}.json`);
  try {
    if (fs.existsSync(stratFile)) {
      return JSON.parse(fs.readFileSync(stratFile, 'utf8'));
    }
  } catch (e) {}
  return null;
}

/**
 * Read FOMC divergence history
 */
function readFOMCDivergence() {
  const fomcFile = path.join(DATA_DIR, 'fomc_divergence_history.json');
  try {
    if (fs.existsSync(fomcFile)) {
      return JSON.parse(fs.readFileSync(fomcFile, 'utf8'));
    }
  } catch (e) {}
  return null;
}

/**
 * Read market maker state
 */
function readMMState() {
  const mmFile = path.join(PM_DIR, 'data', 'mm_state.json');
  try {
    if (fs.existsSync(mmFile)) {
      return JSON.parse(fs.readFileSync(mmFile, 'utf8'));
    }
  } catch (e) {}
  return null;
}

/**
 * Read vol signal
 */
function readVolSignal() {
  const sigFile = path.join(DATA_DIR, 'vol_signal.json');
  try {
    if (fs.existsSync(sigFile)) {
      return JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    }
  } catch (e) {}
  return null;
}

// ============================================================================
// AGENT
// ============================================================================

class PredictionMarketsAgent {
  constructor() {
    this.name = 'Prediction Markets';
    this.emoji = '🎲';
    this.lastRun = null;
  }

  /**
   * Main run — scan all prediction market strategies
   */
  async run() {
    const startTime = Date.now();
    const timeET = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
    });
    console.log(`[${new Date().toISOString()}] ${this.emoji} Prediction Markets Agent starting... (${timeET} ET)`);

    const state = loadState();
    const report = {
      timestamp: new Date().toISOString(),
      timeET,
      scanResults: null,
      fomcStatus: null,
      volSignal: null,
      opportunities: [],
      errors: [],
    };

    // 1. Run execution scheduler (scan + paper trade cycle)
    try {
      const schedulerPath = path.join(PM_DIR, 'execution_scheduler.py');
      const scannerPath = path.join(PM_DIR, 'daily_scanner.py');

      if (fs.existsSync(schedulerPath)) {
        console.log('  Running execution_scheduler.py --once --mode paper...');
        const result = await runPython(schedulerPath, ['--once', '--mode', 'paper'], 180000);
        if (result.exitCode === 0) {
          report.scanResults = readLatestScan();
          report.mmState = readMMState();
          console.log('  Execution scheduler cycle completed');
        } else {
          console.warn('  Execution scheduler error:', result.stderr.slice(0, 200));
          // Fallback to daily scanner
          if (fs.existsSync(scannerPath)) {
            console.log('  Falling back to daily_scanner.py...');
            const fallback = await runPython(scannerPath, ['--quiet'], 120000);
            if (fallback.exitCode === 0) report.scanResults = readLatestScan();
          }
          report.errors.push(`Scheduler: ${result.stderr.slice(0, 100)}`);
        }
      } else if (fs.existsSync(scannerPath)) {
        console.log('  Running daily_scanner.py...');
        const result = await runPython(scannerPath, ['--quiet'], 120000);
        if (result.exitCode === 0) {
          report.scanResults = readLatestScan();
          console.log('  Daily scanner completed');
        } else {
          report.errors.push(`Scanner: ${result.stderr.slice(0, 100)}`);
        }
      }
    } catch (e) {
      report.errors.push(`Scanner error: ${e.message}`);
    }

    // 2. Check FOMC divergence
    try {
      const fomcPath = path.join(PM_DIR, 'fomc_tracker.py');
      if (fs.existsSync(fomcPath)) {
        const result = await runPython(fomcPath, ['--check'], 30000);
        report.fomcStatus = readFOMCDivergence();
        if (report.fomcStatus) {
          state.fomcDivergence = report.fomcStatus;
          state.lastFOMCScan = new Date().toISOString();
        }
      }
    } catch (e) {
      report.errors.push(`FOMC check: ${e.message}`);
    }

    // 3. Check vol signal freshness
    try {
      report.volSignal = readVolSignal();
      if (report.volSignal) {
        state.lastVolSignal = report.volSignal.timestamp;
        // Check staleness
        const signalAge = (Date.now() - new Date(report.volSignal.timestamp).getTime()) / 1000 / 60;
        report.volSignalAge = Math.round(signalAge);
        report.volSignalStale = signalAge > 120; // >2 hours
      }
    } catch (e) {
      report.errors.push(`Vol signal: ${e.message}`);
    }

    // 4. Extract top opportunities from nested scan structure
    if (report.scanResults) {
      const allOpps = [];

      // Brackets: scanResults.brackets.result.opportunities
      const brackets = report.scanResults?.brackets?.result?.opportunities;
      if (Array.isArray(brackets)) {
        for (const b of brackets) {
          allOpps.push({
            type: 'spx_bracket',
            description: b.bracket_id || b.ticker || 'SPX bracket',
            edge: b.net_edge_after_fees || b.edge || 0,
            strategy: 'spx_vol_brackets',
            action: b.action || 'UNKNOWN',
            fair_value: b.fair_price,
            market_price: b.market_price,
          });
        }
      }

      // Engine: scanResults.engine.result.top_opportunities
      const engineOpps = report.scanResults?.engine?.result?.top_opportunities;
      if (Array.isArray(engineOpps)) {
        for (const e of engineOpps) {
          allOpps.push({
            type: e.platform || 'engine',
            description: e.market || e.ticker || 'Unknown',
            edge: e.weighted_edge || e.edge || 0,
            strategy: e.strategy || 'unknown',
            action: e.action || 'BUY',
          });
        }
      }

      // Polymarket: scanResults.polymarket.result.opportunities
      const polyOpps = report.scanResults?.polymarket?.result?.opportunities;
      if (Array.isArray(polyOpps)) {
        for (const p of polyOpps) {
          allOpps.push({
            type: 'polymarket',
            description: p.question || p.market_slug || 'Polymarket',
            edge: p.net_edge || p.edge || 0,
            strategy: 'polymarket_edge',
            action: p.action || 'BUY',
            fair_value: p.fair_value,
            market_price: p.market_price,
          });
        }
      }

      // Polymarket mispricings (combinatorial arb)
      const polyMispricings = report.scanResults?.polymarket?.result?.mispricings;
      if (Array.isArray(polyMispricings)) {
        for (const m of polyMispricings) {
          allOpps.push({
            type: 'polymarket_arb',
            description: `${m.group} (${m.direction})`,
            edge: m.net_edge_per_contract || m.edge_per_contract || 0,
            strategy: 'combinatorial_arb',
            action: m.direction === 'overpriced' ? 'SELL' : 'BUY',
          });
        }
      }

      // Sort by edge descending
      allOpps.sort((a, b) => (b.edge || 0) - (a.edge || 0));
      report.opportunities = allOpps.slice(0, 15);
      state.activeOpportunities = report.opportunities;
    }

    // 5. Update state
    state.lastScan = new Date().toISOString();
    state.scanHistory.push({
      time: new Date().toISOString(),
      opportunities: report.opportunities.length,
      errors: report.errors.length,
    });
    saveState(state);

    // 6. Send Discord report
    await this._sendReport(report);

    // 7. Update shared brain
    this._updateBrain(report);

    this.lastRun = new Date();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ${this.emoji} Prediction Markets completed in ${elapsed}s`);

    return report;
  }

  /**
   * Send report to Discord
   */
  async _sendReport(report) {
    let msg = `${this.emoji} **PREDICTION MARKETS SCAN** — ${report.timeET} ET\n\n`;

    // FOMC status
    if (report.fomcStatus) {
      const fomc = report.fomcStatus;
      const latest = Array.isArray(fomc) ? fomc[fomc.length - 1] : fomc;
      if (latest) {
        const signal = latest.signal || 'UNKNOWN';
        const gap = latest.max_divergence != null ? (latest.max_divergence * 100).toFixed(1) : '?';
        const nextMeeting = latest.meeting || 'Unknown';
        const daysTo = latest.days_to_meeting || '?';
        msg += `**FOMC:** ${signal} (${gap}% gap) | Next: ${nextMeeting} (${daysTo}d)\n`;
      }
    }

    // Vol signal
    if (report.volSignal) {
      const v = report.volSignal;
      const staleTag = report.volSignalStale ? ' ⚠️ STALE' : '';
      msg += `**Vol Model:** ${v.raw_prediction_pct?.toFixed(1) || '?'}% annualized (z=${v.z_score?.toFixed(2) || '?'}) | Age: ${report.volSignalAge}m${staleTag}\n`;
      if (v.trailing_rvol_pct) {
        msg += `  Trailing RVol: ${v.trailing_rvol_pct.toFixed(1)}% | IC: ${v.model_ic || '?'}\n`;
      }
    }

    // MM state
    if (report.mmState) {
      const mm = report.mmState;
      const nPos = Object.keys(mm.positions || {}).length;
      msg += `**Market Maker:** ${mm.is_stopped ? 'STOPPED' : 'Active'} | `;
      msg += `Positions: ${nPos} | Exposure: $${(mm.total_exposure || 0).toFixed(0)} | `;
      msg += `Daily P&L: $${(mm.daily_pnl || 0).toFixed(2)} | Total: $${(mm.total_pnl || 0).toFixed(2)}\n`;
    }

    msg += '\n';

    // Top opportunities
    if (report.opportunities.length > 0) {
      msg += `**TOP OPPORTUNITIES (${report.opportunities.length}):**\n`;
      for (const opp of report.opportunities.slice(0, 5)) {
        const edge = opp.edge || opp.expected_value || 0;
        const strategy = opp.strategy || opp.type || 'unknown';
        const desc = opp.description || opp.market || opp.symbol || '?';
        msg += `• **${desc}** (${strategy}) — Edge: ${typeof edge === 'number' ? edge.toFixed(2) : edge}\n`;
      }
      msg += '\n';
    } else {
      msg += 'No actionable opportunities found.\n\n';
    }

    // Errors
    if (report.errors.length > 0) {
      msg += `**Errors:** ${report.errors.join(' | ')}\n`;
    }

    try {
      // Use alerts channel for prediction markets
      await discord.send('alerts', msg);
    } catch (e) {
      console.warn('[PredMarkets] Discord send error:', e.message);
    }
  }

  /**
   * Update shared brain with prediction markets data
   */
  _updateBrain(report) {
    brain.ctx.predictionMarkets = {
      lastScan: report.timestamp,
      opportunities: report.opportunities.length,
      topOpportunity: report.opportunities[0] || null,
      fomcSignal: report.fomcStatus ? 'active' : 'unavailable',
      volSignalAge: report.volSignalAge || null,
      volSignalStale: report.volSignalStale || false,
      updatedAt: new Date().toISOString(),
    };

    brain.logAgent('pred-markets', `Scan: ${report.opportunities.length} opportunities`);
  }

  /**
   * Get status for scheduler
   */
  getStatus() {
    const state = loadState();
    return {
      lastScan: state.lastScan,
      lastFOMCScan: state.lastFOMCScan,
      activeOpportunities: state.activeOpportunities?.length || 0,
      fomcDivergence: state.fomcDivergence ? 'tracked' : 'unavailable',
    };
  }
}

module.exports = PredictionMarketsAgent;
