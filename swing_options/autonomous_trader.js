/**
 * Autonomous Trading Agent
 *
 * Runs every hour on the hour to:
 * 1. Scan market conditions
 * 2. Research opportunities using all available tools
 * 3. Evaluate against our thesis (Dick Capital + independent research)
 * 4. Make autonomous trading decisions
 * 5. Execute via Alpaca
 * 6. Report to Discord
 *
 * This agent has FULL AUTONOMY to enter/exit positions based on data.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  dataDir: path.join(__dirname, 'data'),
  watchlistFile: path.join(__dirname, 'data', 'watchlist.json'),
  decisionsLog: path.join(__dirname, 'data', 'trading_decisions.json'),

  // Position sizing rules
  maxPositionSize: 0.10,      // Max 10% per position
  minPositionSize: 0.02,      // Min 2% per position
  maxPortfolioRisk: 0.30,     // Max 30% in active trades

  // Entry criteria
  minUpside: 0.15,            // Minimum 15% upside to entry target
  maxAboveEntry: 0.05,        // Max 5% above entry price to consider

  // Conviction levels
  HIGH_CONVICTION: 0.05,      // 5% position
  MEDIUM_CONVICTION: 0.03,    // 3% position
  LOW_CONVICTION: 0.02,       // 2% position
};

// Ensure directories exist
if (!fs.existsSync(CONFIG.dataDir)) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
}

// ============================================================================
// ALPACA API - Using existing client
// ============================================================================

const alpacaClient = require('./alpaca_client');

async function getAccount() {
  return await alpacaClient.getAccount();
}

async function getPositions() {
  return await alpacaClient.getPositions();
}

async function placeOrder(symbol, qty, side, type = 'market') {
  if (side === 'buy') {
    return await alpacaClient.buyStock(symbol, qty);
  } else {
    return await alpacaClient.sellStock(symbol, qty);
  }
}

async function getAsset(symbol) {
  const client = alpacaClient.getClient();
  return await client.client.getAsset(symbol);
}

// ============================================================================
// MARKET DATA
// ============================================================================

async function fetchQuote(symbol) {
  try {
    return new Promise((resolve, reject) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;

      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const result = json.chart?.result?.[0];
            if (result) {
              const meta = result.meta;
              resolve({
                symbol,
                price: meta.regularMarketPrice,
                previousClose: meta.previousClose,
                changePercent: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100),
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
    });
  } catch (error) {
    return null;
  }
}

async function getMarketStatus() {
  const spy = await fetchQuote('SPY');
  const vix = await fetchQuote('^VIX');

  return {
    spy: spy?.price,
    spyChange: spy?.changePercent,
    vix: vix?.price,
    sentiment: spy?.changePercent > 1 ? 'BULLISH' : spy?.changePercent < -1 ? 'BEARISH' : 'NEUTRAL',
  };
}

// ============================================================================
// WATCHLIST & THESIS
// ============================================================================

function loadWatchlist() {
  if (fs.existsSync(CONFIG.watchlistFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.watchlistFile, 'utf8'));
  }

  // Default watchlist with our research
  return {
    dickCapital: [
      { symbol: 'ANF', entryTarget: 97, thesis: 'Retail turnaround, 62% P/E discount', ptLow: 123, ptHigh: 128, conviction: 'HIGH' },
      { symbol: 'FOA', entryTarget: 22, thesis: 'Reverse mortgage leader, Blue Owl partnership', ptLow: 42, ptHigh: 76, conviction: 'MEDIUM', flags: ['insider_selling'] },
    ],
    independent: [
      { symbol: 'CRDO', entryTarget: 28, thesis: 'AI networking, down 54% from highs', ptLow: 50, ptHigh: 70, conviction: 'HIGH' },
      { symbol: 'MU', entryTarget: 85, thesis: 'HBM leader, 12x fwd P/E', ptLow: 110, ptHigh: 130, conviction: 'MEDIUM' },
      { symbol: 'CCJ', entryTarget: 50, thesis: 'Uranium leader, nuclear for AI', ptLow: 65, ptHigh: 80, conviction: 'MEDIUM' },
      { symbol: 'BE', entryTarget: 25, thesis: 'AI power bottleneck solver', ptLow: 40, ptHigh: 50, conviction: 'MEDIUM' },
      { symbol: 'TGB', entryTarget: 7, thesis: 'Copper producer, 44% of NPV', ptLow: 12, ptHigh: 15, conviction: 'MEDIUM' },
    ],
    avoid: [
      { symbol: 'NBIS', reason: 'Execution risk too high' },
      { symbol: 'ATXRF', reason: 'OTC not tradable on Alpaca' },
      { symbol: 'TORXF', reason: 'OTC not tradable on Alpaca' },
      { symbol: 'MTMCF', reason: 'Already ran 1370%, too late' },
    ],
    positions: [],
  };
}

function saveWatchlist(watchlist) {
  fs.writeFileSync(CONFIG.watchlistFile, JSON.stringify(watchlist, null, 2));
}

// ============================================================================
// DECISION ENGINE
// ============================================================================

function evaluateOpportunity(pick, quote, account, positions) {
  const decision = {
    symbol: pick.symbol,
    action: 'HOLD',
    reason: '',
    confidence: 0,
    shares: 0,
    price: quote.price,
  };

  const price = quote.price;
  const entryTarget = pick.entryTarget;
  const upside = (pick.ptLow - price) / price;
  const distanceFromEntry = (price - entryTarget) / entryTarget;

  // Check if already have position
  const existingPosition = positions.find(p => p.symbol === pick.symbol);
  if (existingPosition) {
    decision.action = 'HOLD';
    decision.reason = 'Already have position';
    return decision;
  }

  // Check if tradable on Alpaca
  if (pick.symbol.includes('F') && pick.symbol.length > 4) {
    decision.action = 'SKIP';
    decision.reason = 'OTC stock not tradable';
    return decision;
  }

  // Check for red flags
  if (pick.flags?.includes('insider_selling')) {
    decision.confidence -= 20;
  }

  // ENTRY LOGIC

  // At or below entry target = strong buy signal
  if (price <= entryTarget) {
    decision.action = 'BUY';
    decision.confidence = 80;
    decision.reason = `Price $${price.toFixed(2)} is ${Math.abs(distanceFromEntry * 100).toFixed(1)}% BELOW entry target $${entryTarget}`;
  }
  // Within 5% of entry = consider buying
  else if (distanceFromEntry <= CONFIG.maxAboveEntry) {
    decision.action = 'BUY';
    decision.confidence = 60;
    decision.reason = `Price $${price.toFixed(2)} is ${(distanceFromEntry * 100).toFixed(1)}% above entry target $${entryTarget} - still in zone`;
  }
  // Too far above entry
  else {
    decision.action = 'WATCH';
    decision.reason = `Price $${price.toFixed(2)} is ${(distanceFromEntry * 100).toFixed(1)}% above entry target $${entryTarget} - wait for pullback`;
    return decision;
  }

  // Check upside potential
  if (upside < CONFIG.minUpside) {
    decision.action = 'SKIP';
    decision.reason = `Upside of ${(upside * 100).toFixed(1)}% is below minimum ${CONFIG.minUpside * 100}%`;
    return decision;
  }

  // Adjust confidence based on conviction level
  if (pick.conviction === 'HIGH') decision.confidence += 15;
  if (pick.conviction === 'LOW') decision.confidence -= 15;

  // Calculate position size
  const portfolioValue = parseFloat(account.portfolio_value);
  let positionPct = CONFIG.MEDIUM_CONVICTION;

  if (pick.conviction === 'HIGH' && decision.confidence >= 70) {
    positionPct = CONFIG.HIGH_CONVICTION;
  } else if (pick.conviction === 'LOW' || decision.confidence < 50) {
    positionPct = CONFIG.LOW_CONVICTION;
  }

  const positionValue = portfolioValue * positionPct;
  decision.shares = Math.floor(positionValue / price);
  decision.positionSize = positionPct;
  decision.positionValue = decision.shares * price;
  decision.upside = upside;
  decision.ptLow = pick.ptLow;
  decision.ptHigh = pick.ptHigh;
  decision.thesis = pick.thesis;

  // Final check - need at least 1 share
  if (decision.shares < 1) {
    decision.action = 'SKIP';
    decision.reason = 'Position size too small';
  }

  return decision;
}

// ============================================================================
// MAIN AUTONOMOUS SCAN
// ============================================================================

async function runAutonomousScan(sendToDiscord = console.log) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🤖 Starting autonomous trading scan...`);

  const results = {
    timestamp,
    marketStatus: null,
    opportunities: [],
    decisions: [],
    executions: [],
    errors: [],
  };

  try {
    // 1. Get account status
    const account = await getAccount();
    const positions = await getPositions();

    results.account = {
      equity: parseFloat(account.portfolio_value),
      cash: parseFloat(account.cash),
      buyingPower: parseFloat(account.buying_power),
      positionCount: positions.length,
    };

    console.log(`Account: $${results.account.equity.toFixed(2)} equity, $${results.account.cash.toFixed(2)} cash`);

    // 2. Get market status
    results.marketStatus = await getMarketStatus();
    console.log(`Market: SPY ${results.marketStatus.spyChange?.toFixed(2)}%, Sentiment: ${results.marketStatus.sentiment}`);

    // 3. Load watchlist
    const watchlist = loadWatchlist();
    const allPicks = [...watchlist.dickCapital, ...watchlist.independent];

    // 4. Evaluate each opportunity
    for (const pick of allPicks) {
      // Skip if in avoid list
      if (watchlist.avoid.some(a => a.symbol === pick.symbol)) {
        continue;
      }

      const quote = await fetchQuote(pick.symbol);
      if (!quote) {
        results.errors.push(`Failed to fetch quote for ${pick.symbol}`);
        continue;
      }

      const decision = evaluateOpportunity(pick, quote, account, positions);
      results.decisions.push(decision);

      if (decision.action === 'BUY' && decision.confidence >= 50) {
        results.opportunities.push(decision);
      }
    }

    // 5. Execute trades (top opportunities by confidence)
    const toExecute = results.opportunities
      .filter(o => o.action === 'BUY' && o.shares >= 1)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2); // Max 2 new positions per scan

    for (const trade of toExecute) {
      try {
        // Check if asset is tradable
        const asset = await getAsset(trade.symbol);
        if (!asset.tradable) {
          results.errors.push(`${trade.symbol} is not tradable on Alpaca`);
          continue;
        }

        console.log(`Executing: BUY ${trade.shares} ${trade.symbol} @ ~$${trade.price.toFixed(2)}`);

        const order = await placeOrder(trade.symbol, trade.shares, 'buy');

        if (order.id) {
          results.executions.push({
            symbol: trade.symbol,
            shares: trade.shares,
            price: trade.price,
            orderId: order.id,
            status: order.status,
            reason: trade.reason,
            thesis: trade.thesis,
            upside: trade.upside,
            ptLow: trade.ptLow,
          });
        } else {
          results.errors.push(`Order failed for ${trade.symbol}: ${JSON.stringify(order)}`);
        }
      } catch (err) {
        results.errors.push(`Execution error for ${trade.symbol}: ${err.message}`);
      }
    }

    // 6. Log decisions
    logDecisions(results);

    // 7. Send Discord report
    const report = formatReport(results);
    await sendToDiscord(report);

  } catch (error) {
    console.error('Scan error:', error);
    results.errors.push(error.message);
    await sendToDiscord(`⚠️ Trading scan error: ${error.message}`);
  }

  return results;
}

function logDecisions(results) {
  let history = [];
  if (fs.existsSync(CONFIG.decisionsLog)) {
    try {
      history = JSON.parse(fs.readFileSync(CONFIG.decisionsLog, 'utf8'));
    } catch (e) {
      history = [];
    }
  }

  history.push({
    timestamp: results.timestamp,
    opportunities: results.opportunities.length,
    executions: results.executions.length,
    decisions: results.decisions.map(d => ({
      symbol: d.symbol,
      action: d.action,
      confidence: d.confidence,
      price: d.price,
    })),
  });

  // Keep last 168 (1 week)
  if (history.length > 168) history = history.slice(-168);

  fs.writeFileSync(CONFIG.decisionsLog, JSON.stringify(history, null, 2));
}

function formatReport(results) {
  let report = `**🤖 AUTONOMOUS TRADING SCAN - ${new Date(results.timestamp).toLocaleString()}**\n\n`;

  // Market
  if (results.marketStatus) {
    const emoji = results.marketStatus.sentiment === 'BULLISH' ? '🟢' :
                  results.marketStatus.sentiment === 'BEARISH' ? '🔴' : '⚪';
    report += `**Market:** ${emoji} SPY ${results.marketStatus.spyChange?.toFixed(2)}% | Sentiment: ${results.marketStatus.sentiment}\n\n`;
  }

  // Account
  if (results.account) {
    report += `**Account:** $${results.account.equity.toFixed(2)} equity | $${results.account.cash.toFixed(2)} cash | ${results.account.positionCount} positions\n\n`;
  }

  // Executions (most important)
  if (results.executions.length > 0) {
    report += `**✅ TRADES EXECUTED:**\n`;
    results.executions.forEach(exec => {
      report += `• **${exec.symbol}**: Bought ${exec.shares} shares @ $${exec.price.toFixed(2)}\n`;
      report += `  Thesis: ${exec.thesis}\n`;
      report += `  Upside: ${(exec.upside * 100).toFixed(1)}% to PT $${exec.ptLow}\n`;
    });
    report += '\n';
  }

  // Opportunities not executed
  const notExecuted = results.opportunities.filter(
    o => !results.executions.some(e => e.symbol === o.symbol)
  );
  if (notExecuted.length > 0) {
    report += `**👀 OPPORTUNITIES IDENTIFIED:**\n`;
    notExecuted.forEach(opp => {
      report += `• ${opp.symbol}: $${opp.price.toFixed(2)} - ${opp.reason}\n`;
    });
    report += '\n';
  }

  // Errors
  if (results.errors.length > 0) {
    report += `**⚠️ Issues:**\n`;
    results.errors.forEach(err => {
      report += `• ${err}\n`;
    });
  }

  // If nothing notable
  if (results.executions.length === 0 && results.opportunities.length === 0) {
    report += `_No actionable opportunities this scan. Watchlist stable._\n`;
  }

  return report;
}

// ============================================================================
// SCHEDULER
// ============================================================================

class AutonomousTrader {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.sendToDiscord = console.log;
  }

  setSendFunction(fn) {
    this.sendToDiscord = fn;
  }

  async start() {
    if (this.isRunning) {
      console.log('Autonomous trader already running');
      return;
    }

    this.isRunning = true;
    console.log('🤖 Starting Autonomous Trading Agent...');

    // Notify
    await this.sendToDiscord(
      '🤖 **Autonomous Trading Agent Started**\n\n' +
      'Running hourly scans to:\n' +
      '• Evaluate watchlist opportunities\n' +
      '• Make trading decisions based on thesis\n' +
      '• Execute trades autonomously\n' +
      '• Report all actions to Discord\n\n' +
      '_First scan running now..._'
    );

    // Run immediately
    await this.scan();

    // Calculate ms until next hour
    const now = new Date();
    const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000;

    // Schedule to run on the hour
    setTimeout(() => {
      this.scan();
      this.intervalId = setInterval(() => this.scan(), 60 * 60 * 1000);
    }, msUntilNextHour);

    console.log(`Next scan at the top of the hour (in ${Math.round(msUntilNextHour / 60000)} minutes)`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('Autonomous trader stopped');
  }

  async scan() {
    try {
      await runAutonomousScan(this.sendToDiscord);
    } catch (error) {
      console.error('Scan error:', error);
      await this.sendToDiscord(`⚠️ Autonomous scan error: ${error.message}`);
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      watchlist: loadWatchlist(),
    };
  }
}

const trader = new AutonomousTrader();

// ============================================================================
// EXPORTS & CLI
// ============================================================================

module.exports = {
  trader,
  runAutonomousScan,
  loadWatchlist,
  saveWatchlist,
  evaluateOpportunity,
  CONFIG,
};

if (require.main === module) {
  const command = process.argv[2] || 'scan';

  switch (command) {
    case 'scan':
      runAutonomousScan().then(() => process.exit(0));
      break;
    case 'start':
      trader.start();
      break;
    case 'watchlist':
      console.log(JSON.stringify(loadWatchlist(), null, 2));
      break;
    default:
      console.log('Commands: scan, start, watchlist');
  }
}
