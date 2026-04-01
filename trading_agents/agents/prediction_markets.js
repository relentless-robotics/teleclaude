/**
 * Prediction Markets Trading Agent
 *
 * Scans both Kalshi (SPX bracket contracts) and Polymarket (macro/financial events).
 *
 * Kalshi strategy: Price SPX daily brackets using vol model, trade mispricings.
 * Polymarket strategy: Use LLM to estimate fair value of financial/macro events,
 *                      trade markets where price deviates from fair value.
 *
 * Runs during market hours for Kalshi. Polymarket runs any time (24/7 markets).
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
  scanIntervalMs: 900000, // 15 minutes (was 5min, reduced to save tokens)
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
      { encoding: 'utf-8', timeout: 15000, windowsHide: true }
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
  // Polymarket
  getPolymarketFinancialMarkets,
  estimatePolymarketFairValues,
  scanPolymarket,
};

// ---------------------------------------------------------------------------
// POLYMARKET INTEGRATION
// ---------------------------------------------------------------------------

/**
 * Fetch financial markets from Polymarket (no auth needed)
 */
async function getPolymarketFinancialMarkets(limit = 150) {
  const scanScript = path.join(__dirname, '..', 'prediction_markets', 'scan_polymarket.py');
  return new Promise((resolve, reject) => {
    exec(`python "${scanScript}" markets ${limit}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Polymarket fetch failed: ${err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}`));
      }
    });
  });
}

/**
 * Use LLM to estimate fair values for Polymarket financial markets.
 * Returns {market_slug: fair_value} dict.
 */
async function estimatePolymarketFairValues(markets) {
  if (!markets || markets.length === 0) return {};

  // Filter to uncertain markets (price 15-85%) for LLM analysis
  const uncertain = markets.filter(m =>
    m.yes_price !== null && m.yes_price >= 0.10 && m.yes_price <= 0.90
  ).slice(0, 15);

  if (uncertain.length === 0) return {};

  const messages = [
    {
      role: 'system',
      content: `You are a prediction markets analyst estimating true probabilities for financial/macro events.

For each market, estimate the TRUE probability (0-1) based on:
- Current market consensus and expert forecasts
- Recent news and data releases
- Base rates for similar events

Be calibrated: stay close to market price unless you have strong reason to deviate.
Respond with JSON only: {"market_slug": probability, ...}`,
    },
    {
      role: 'user',
      content: `Today: ${new Date().toISOString().slice(0, 10)}

Financial prediction markets to evaluate:
${uncertain.map(m =>
  `- Slug: "${m.slug}"\n  Q: "${m.question}"\n  End: ${m.end_date}\n  Price: ${m.yes_price?.toFixed(3)}\n  Vol: $${(m.volume/1e6).toFixed(1)}M`
).join('\n\n')}

Provide fair value estimates as JSON {slug: probability}.`,
    },
  ];

  try {
    const result = await reasoning.callLLMWithFallback(messages, {
      temperature: 0.3,
      maxTokens: 512,
    });

    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      const match = result.content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return {};
    }

    const validated = {};
    for (const [slug, val] of Object.entries(parsed)) {
      const fv = parseFloat(val);
      if (!isNaN(fv) && fv >= 0 && fv <= 1) {
        validated[slug] = fv;
      }
    }
    return validated;
  } catch (e) {
    console.error('[PredMarkets] Polymarket LLM valuation failed:', e.message);
    return {};
  }
}

/**
 * Scan Polymarket with LLM fair values and return opportunities
 */
async function scanPolymarket(minNetEdge = 0.025) {
  const scanScript = path.join(__dirname, '..', 'prediction_markets', 'scan_polymarket.py');

  let markets;
  try {
    markets = await getPolymarketFinancialMarkets(150);
    console.log(`[PredMarkets] Polymarket: ${markets.length} financial markets`);
  } catch (e) {
    console.error('[PredMarkets] Polymarket fetch failed:', e.message);
    return [];
  }

  const fairValues = await estimatePolymarketFairValues(markets);
  console.log(`[PredMarkets] Polymarket: LLM priced ${Object.keys(fairValues).length} markets`);

  const fairValuesJson = JSON.stringify(fairValues);
  return new Promise((resolve) => {
    const child = exec(
      `python "${scanScript}" scan ${minNetEdge} 200`,
      { encoding: 'utf-8', timeout: 30000 },
      (err, stdout) => {
        if (err) {
          console.error('[PredMarkets] Polymarket scan error:', err.message);
          resolve([]);
          return;
        }
        try {
          const opps = JSON.parse(stdout.trim());
          // Apply LLM fair values
          for (const o of opps) {
            if (fairValues[o.market_slug]) {
              o.fair_value = fairValues[o.market_slug];
              // Recalculate edge
              const fv = o.fair_value;
              const mp = o.market_price;
              const yesEdge = fv - mp;
              const noEdge = (1 - fv) - (1 - mp);
              if (yesEdge > noEdge && yesEdge > 0) {
                o.action = 'BUY_YES';
                o.net_edge = yesEdge - 0.02 * mp * (1 - mp);
              } else if (noEdge > 0) {
                o.action = 'BUY_NO';
                o.net_edge = noEdge - 0.02 * (1 - mp) * mp;
              }
            }
          }
          resolve(opps.filter(o => (o.net_edge || 0) >= minNetEdge)
            .sort((a, b) => (b.net_edge || 0) - (a.net_edge || 0)));
        } catch {
          resolve([]);
        }
      }
    );
  });
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'polymarket') {
    scanPolymarket(0.02).then(opps => {
      console.log(`\nPolymarket opportunities (${opps.length}):`);
      for (const o of opps) {
        console.log(`\n  ${o.question.slice(0, 70)}`);
        console.log(`  End: ${o.end_date} | $${(o.volume/1e6).toFixed(1)}M | Price: ${(o.market_price||0).toFixed(3)} → FV: ${(o.fair_value||0).toFixed(3)} | Net: ${(o.net_edge||0).toFixed(3)} ${o.action}`);
      }
    }).catch(console.error);
  } else {
    start().catch(console.error);
  }
}
