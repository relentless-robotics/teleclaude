/**
 * Prediction Markets Trading Agent
 *
 * Autonomous agent that trades SPX bracket contracts on Kalshi
 * using our volatility prediction model (IC=0.644 at 30min).
 *
 * Strategy: Price SPX daily brackets using vol model, trade mispricings.
 * Uses LLM reasoning for market context and position management.
 *
 * Runs during market hours (9:30 AM - 4:00 PM ET).
 */

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const reasoning = require('../../utils/llm_reasoning');

const DATA_DIR = path.join(__dirname, '..', 'prediction_markets', 'data');
const STATE_FILE = path.join(DATA_DIR, 'agent_state.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default config
const CONFIG = {
  mode: 'demo',           // 'demo' or 'live'
  scanIntervalMs: 300000, // 5 minutes
  maxPositions: 10,
  maxExposure: 5000,      // dollars
  minEdge: 0.02,          // 2 cents min edge
  minNetEdge: 0.005,      // 0.5 cents after fees
  contractsPerTrade: 50,  // default position size
  maxContractsPerBracket: 200,
};

/**
 * Get current SPX price from a market data source
 */
async function getCurrentSPX() {
  try {
    // Try Yahoo Finance via Python
    const result = execSync(
      'python -c "import yfinance; print(yfinance.Ticker(\'^GSPC\').fast_info.last_price)"',
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();
    return parseFloat(result);
  } catch (e) {
    // Fallback: hardcoded recent value (will be updated)
    console.warn('[PredMarkets] Could not fetch live SPX, using estimate');
    return 5900;
  }
}

/**
 * Run the Python bracket scanner and return opportunities
 */
async function scanBrackets(spx, vol, hoursToClose) {
  const scanScript = path.join(__dirname, '..', 'prediction_markets', 'scan_brackets.py');
  return new Promise((resolve, reject) => {
    exec(`python "${scanScript}" ${spx} ${vol} ${hoursToClose} ${CONFIG.minNetEdge}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Bracket scan failed: ${err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}, stdout: ${stdout.substring(0, 200)}`));
      }
    });
  });
}

/**
 * Use LLM to analyze opportunities and make trading decisions
 */
async function analyzeWithLLM(opportunities, spx, marketContext) {
  const messages = [
    {
      role: 'system',
      content: `You are a prediction markets trading analyst specializing in SPX bracket contracts on Kalshi.

Your job: Given a list of bracket contract opportunities with computed fair values and edges, decide which to trade.

RULES:
- Only trade contracts with net edge > 0.5 cents after fees
- Prefer contracts closer to ATM (higher liquidity)
- Consider time of day: more edge needed later in the day (less time for convergence)
- Max 10 positions at once
- Size inversely with risk: larger edge = more contracts
- If edge > 5 cents, this is unusual — verify it's not a data error

Respond in JSON:
{
  "trades": [{"ticker": "...", "action": "BUY_YES"|"BUY_NO", "contracts": N, "reasoning": "..."}],
  "skip_reason": "why no trades" (if no trades),
  "market_view": "brief market assessment"
}`
    },
    {
      role: 'user',
      content: `SPX: ${spx}
Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

Opportunities (sorted by edge):
${JSON.stringify(opportunities.slice(0, 10), null, 2)}

Market context: ${JSON.stringify(marketContext || {})}`
    }
  ];

  try {
    const result = await reasoning.callLLMWithFallback(messages, {
      temperature: 0.2,
      maxTokens: 1024,
    });

    // Parse JSON from response
    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      const match = result.content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return { trades: [], skip_reason: 'LLM response not JSON', market_view: result.content.substring(0, 200) };
    }

    return {
      ...parsed,
      _llm_provider: result.provider,
      _llm_model: result.model,
    };
  } catch (e) {
    console.error('[PredMarkets] LLM analysis failed:', e.message);
    return { trades: [], skip_reason: `LLM error: ${e.message}`, market_view: 'unknown' };
  }
}

/**
 * Load agent state from disk
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {
    positions: [],
    tradeLog: [],
    dailyPnL: [],
    lastScan: null,
    totalTrades: 0,
    totalPnL: 0,
  };
}

/**
 * Save agent state to disk
 */
function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Main scan cycle
 */
async function runScanCycle() {
  const state = loadState();
  console.log(`[PredMarkets] Starting scan cycle at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);

  // Check market hours
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etMinute = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  const etMins = etHour * 60 + etMinute;

  if (etMins < 570 || etMins > 960) {  // Before 9:30 or after 4:00
    console.log('[PredMarkets] Market closed. Skipping scan.');
    return { status: 'market_closed' };
  }

  const hoursToClose = (960 - etMins) / 60;

  // Get current SPX
  const spx = await getCurrentSPX();
  console.log(`[PredMarkets] SPX: ${spx}, Hours to close: ${hoursToClose.toFixed(1)}`);

  // Use estimated vol (placeholder - in production, connect to vol model)
  const estimatedVol = 0.18;

  // Scan for opportunities
  let opportunities;
  try {
    opportunities = await scanBrackets(spx, estimatedVol, hoursToClose);
    console.log(`[PredMarkets] Found ${opportunities.length} opportunities`);
  } catch (e) {
    console.error('[PredMarkets] Scan failed:', e.message);
    return { status: 'scan_error', error: e.message };
  }

  if (opportunities.length === 0) {
    state.lastScan = new Date().toISOString();
    saveState(state);
    return { status: 'no_opportunities', spx, vol: estimatedVol };
  }

  // LLM analysis
  const analysis = await analyzeWithLLM(opportunities, spx, {
    hoursToClose,
    estimatedVol,
    currentPositions: state.positions.length,
  });

  console.log(`[PredMarkets] LLM says: ${analysis.market_view || 'no view'}`);
  console.log(`[PredMarkets] Trades: ${analysis.trades?.length || 0}`);

  // Log the scan
  state.lastScan = new Date().toISOString();
  state.lastAnalysis = {
    spx,
    vol: estimatedVol,
    hoursToClose,
    opportunities: opportunities.length,
    trades: analysis.trades?.length || 0,
    llmProvider: analysis._llm_provider,
    marketView: analysis.market_view,
    timestamp: new Date().toISOString(),
  };

  // In demo mode, log paper trades
  if (analysis.trades && analysis.trades.length > 0) {
    for (const trade of analysis.trades) {
      state.tradeLog.push({
        ...trade,
        spx,
        timestamp: new Date().toISOString(),
        mode: CONFIG.mode,
      });
      state.totalTrades++;
    }
    console.log(`[PredMarkets] ${analysis.trades.length} paper trades logged`);
  }

  saveState(state);
  return {
    status: 'scanned',
    spx,
    opportunities: opportunities.length,
    trades: analysis.trades?.length || 0,
    marketView: analysis.market_view,
  };
}

/**
 * Start the prediction markets agent loop
 */
async function start() {
  console.log('[PredMarkets] Agent starting...');
  console.log(`[PredMarkets] Mode: ${CONFIG.mode}`);
  console.log(`[PredMarkets] Scan interval: ${CONFIG.scanIntervalMs / 1000}s`);

  // Initial scan
  const result = await runScanCycle();
  console.log('[PredMarkets] Initial scan result:', JSON.stringify(result));

  // Set up recurring scans
  setInterval(async () => {
    try {
      await runScanCycle();
    } catch (e) {
      console.error('[PredMarkets] Scan cycle error:', e.message);
    }
  }, CONFIG.scanIntervalMs);
}

module.exports = {
  start,
  runScanCycle,
  scanBrackets,
  analyzeWithLLM,
  getCurrentSPX,
  loadState,
  saveState,
  CONFIG,
};

// Run if called directly
if (require.main === module) {
  start().catch(console.error);
}
