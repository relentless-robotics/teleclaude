/**
 * Trading Scheduler
 *
 * Integrates with the main teleclaude bridge to run autonomous trading scans
 * every hour on the hour. This runs WITHIN the main process to have access
 * to the secure vault and Discord send function.
 *
 * Usage (from main bridge):
 *   const { startTradingScheduler } = require('./swing_options/trading_scheduler');
 *   startTradingScheduler(sendToDiscord);
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Import Alpaca client (uses vault for credentials)
let alpacaClient;
try {
  alpacaClient = require('./alpaca_client');
} catch (e) {
  console.error('Failed to load Alpaca client:', e.message);
}

const CONFIG = {
  dataDir: path.join(__dirname, 'data'),
  watchlistFile: path.join(__dirname, 'data', 'watchlist.json'),
  decisionsLog: path.join(__dirname, 'data', 'trading_decisions.json'),
  scanIntervalMs: 60 * 60 * 1000, // 1 hour
};

// Ensure data dir exists
if (!fs.existsSync(CONFIG.dataDir)) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
}

// ============================================================================
// WATCHLIST
// ============================================================================

const DEFAULT_WATCHLIST = {
  dickCapital: [
    { symbol: 'ANF', entryTarget: 97, thesis: 'Retail turnaround, 62% P/E discount', ptLow: 123, ptHigh: 128, conviction: 'HIGH' },
    { symbol: 'FOA', entryTarget: 22, thesis: 'Reverse mortgage, Blue Owl partnership', ptLow: 42, ptHigh: 76, conviction: 'MEDIUM', flags: ['insider_selling'] },
  ],
  independent: [
    { symbol: 'CRDO', entryTarget: 28, thesis: 'AI networking, down 54%', ptLow: 50, ptHigh: 70, conviction: 'HIGH' },
    { symbol: 'MU', entryTarget: 85, thesis: 'HBM leader, 12x fwd P/E', ptLow: 110, ptHigh: 130, conviction: 'MEDIUM' },
    { symbol: 'CCJ', entryTarget: 50, thesis: 'Uranium leader', ptLow: 65, ptHigh: 80, conviction: 'MEDIUM' },
    { symbol: 'BE', entryTarget: 25, thesis: 'AI power bottleneck', ptLow: 40, ptHigh: 50, conviction: 'MEDIUM' },
  ],
  positions: [],
};

function loadWatchlist() {
  if (fs.existsSync(CONFIG.watchlistFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.watchlistFile, 'utf8'));
  }
  fs.writeFileSync(CONFIG.watchlistFile, JSON.stringify(DEFAULT_WATCHLIST, null, 2));
  return DEFAULT_WATCHLIST;
}

// ============================================================================
// MARKET DATA (Yahoo Finance - no auth needed)
// ============================================================================

async function fetchQuote(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;

    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
}

// ============================================================================
// TRADING LOGIC
// ============================================================================

function evaluateOpportunity(pick, quote, positions) {
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

  // Already have position?
  if (positions.find(p => p.symbol === pick.symbol)) {
    decision.action = 'HOLD';
    decision.reason = 'Already have position';
    return decision;
  }

  // Red flags
  if (pick.flags?.includes('insider_selling')) {
    decision.confidence -= 20;
  }

  // Entry logic
  if (price <= entryTarget) {
    decision.action = 'BUY';
    decision.confidence = 80;
    decision.reason = `$${price.toFixed(2)} is ${Math.abs(distanceFromEntry * 100).toFixed(1)}% BELOW entry $${entryTarget}`;
  } else if (distanceFromEntry <= 0.05) {
    decision.action = 'BUY';
    decision.confidence = 60;
    decision.reason = `$${price.toFixed(2)} is ${(distanceFromEntry * 100).toFixed(1)}% above entry - still in zone`;
  } else {
    decision.action = 'WATCH';
    decision.reason = `$${price.toFixed(2)} is ${(distanceFromEntry * 100).toFixed(1)}% above entry - wait`;
    return decision;
  }

  // Check upside
  if (upside < 0.15) {
    decision.action = 'SKIP';
    decision.reason = `Upside ${(upside * 100).toFixed(1)}% below minimum 15%`;
    return decision;
  }

  // Conviction adjustment
  if (pick.conviction === 'HIGH') decision.confidence += 15;
  if (pick.conviction === 'LOW') decision.confidence -= 15;

  decision.upside = upside;
  decision.ptLow = pick.ptLow;
  decision.thesis = pick.thesis;

  return decision;
}

// ============================================================================
// MAIN SCAN
// ============================================================================

async function runTradingScan(sendToDiscord) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] 🤖 Running autonomous trading scan...`);

  const results = {
    timestamp,
    opportunities: [],
    executions: [],
    errors: [],
  };

  try {
    // Get account & positions
    let account, positions;
    try {
      account = await alpacaClient.getAccount();
      positions = await alpacaClient.getPositions();
    } catch (e) {
      results.errors.push(`Alpaca error: ${e.message}`);
      await sendToDiscord(`⚠️ Trading scan error: ${e.message}`);
      return results;
    }

    results.account = {
      equity: parseFloat(account.portfolio_value),
      cash: parseFloat(account.cash),
    };

    // Load watchlist
    const watchlist = loadWatchlist();
    const allPicks = [...watchlist.dickCapital, ...watchlist.independent];

    // Evaluate each
    for (const pick of allPicks) {
      const quote = await fetchQuote(pick.symbol);
      if (!quote) continue;

      const decision = evaluateOpportunity(pick, quote, positions);

      if (decision.action === 'BUY' && decision.confidence >= 50) {
        results.opportunities.push(decision);
      }
    }

    // Execute top opportunities
    const toExecute = results.opportunities
      .filter(o => o.action === 'BUY')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2);

    for (const trade of toExecute) {
      try {
        // Calculate position size (3-5% of portfolio)
        const positionPct = trade.confidence >= 70 ? 0.05 : 0.03;
        const positionValue = results.account.equity * positionPct;
        const shares = Math.floor(positionValue / trade.price);

        if (shares < 1) continue;

        console.log(`Executing: BUY ${shares} ${trade.symbol} @ ~$${trade.price.toFixed(2)}`);

        const order = await alpacaClient.buyStock(trade.symbol, shares);

        if (order.id) {
          results.executions.push({
            symbol: trade.symbol,
            shares,
            price: trade.price,
            orderId: order.id,
            reason: trade.reason,
            thesis: trade.thesis,
            upside: trade.upside,
          });
        }
      } catch (err) {
        results.errors.push(`${trade.symbol}: ${err.message}`);
      }
    }

    // Log
    logDecisions(results);

    // Report to Discord
    await sendReport(sendToDiscord, results);

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
    try { history = JSON.parse(fs.readFileSync(CONFIG.decisionsLog, 'utf8')); } catch (e) {}
  }
  history.push({
    timestamp: results.timestamp,
    opportunities: results.opportunities.length,
    executions: results.executions.length,
  });
  if (history.length > 168) history = history.slice(-168);
  fs.writeFileSync(CONFIG.decisionsLog, JSON.stringify(history, null, 2));
}

async function sendReport(sendToDiscord, results) {
  let report = `**🤖 HOURLY TRADING SCAN - ${new Date(results.timestamp).toLocaleString()}**\n\n`;

  if (results.account) {
    report += `**Account:** $${results.account.equity.toFixed(2)} equity | $${results.account.cash.toFixed(2)} cash\n\n`;
  }

  if (results.executions.length > 0) {
    report += `**✅ TRADES EXECUTED:**\n`;
    results.executions.forEach(exec => {
      report += `• **${exec.symbol}**: Bought ${exec.shares} @ $${exec.price.toFixed(2)}\n`;
      report += `  Thesis: ${exec.thesis}\n`;
      report += `  Upside: ${(exec.upside * 100).toFixed(1)}%\n`;
    });
    report += '\n';
  }

  const notExecuted = results.opportunities.filter(
    o => !results.executions.some(e => e.symbol === o.symbol)
  );
  if (notExecuted.length > 0) {
    report += `**👀 OPPORTUNITIES:**\n`;
    notExecuted.forEach(opp => {
      report += `• ${opp.symbol}: $${opp.price.toFixed(2)} - ${opp.reason}\n`;
    });
    report += '\n';
  }

  if (results.errors.length > 0) {
    report += `**⚠️ Issues:** ${results.errors.join(', ')}\n`;
  }

  if (results.executions.length === 0 && results.opportunities.length === 0) {
    report += `_No actionable opportunities. Watchlist stable._\n`;
  }

  await sendToDiscord(report);
}

// ============================================================================
// SCHEDULER
// ============================================================================

let schedulerInterval = null;
let sendToDiscordFn = null;

function startTradingScheduler(sendToDiscord) {
  if (schedulerInterval) {
    console.log('Trading scheduler already running');
    return;
  }

  sendToDiscordFn = sendToDiscord;
  console.log('🤖 Starting trading scheduler...');

  // Run immediately
  runTradingScan(sendToDiscord);

  // Calculate ms until next hour
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000;

  // Schedule for top of hour
  setTimeout(() => {
    runTradingScan(sendToDiscordFn);
    schedulerInterval = setInterval(() => runTradingScan(sendToDiscordFn), CONFIG.scanIntervalMs);
  }, msUntilNextHour);

  console.log(`Next scan in ${Math.round(msUntilNextHour / 60000)} minutes (top of hour)`);

  sendToDiscord(
    '🤖 **Autonomous Trading Agent Started**\n\n' +
    'Running hourly scans on the hour to:\n' +
    '• Evaluate watchlist vs current prices\n' +
    '• Execute trades when entry criteria met\n' +
    '• Report all actions to Discord\n\n' +
    `_Next scheduled scan: ${new Date(Date.now() + msUntilNextHour).toLocaleTimeString()}_`
  );
}

function stopTradingScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('Trading scheduler stopped');
  }
}

function runManualScan() {
  if (sendToDiscordFn) {
    return runTradingScan(sendToDiscordFn);
  }
  console.log('No Discord function set. Use startTradingScheduler first.');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  startTradingScheduler,
  stopTradingScheduler,
  runManualScan,
  runTradingScan,
  loadWatchlist,
  evaluateOpportunity,
};
