/**
 * Hourly Financial Agent
 *
 * Runs every hour to:
 * 1. Scan for new opportunities
 * 2. Monitor existing positions for entry/exit signals
 * 3. Track catalysts (earnings, news, events)
 * 4. Check if new data changes our thesis
 * 5. Report findings to Discord
 *
 * Designed to run as a persistent background task
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  scanIntervalMs: 60 * 60 * 1000, // 1 hour
  watchlistFile: path.join(__dirname, 'data', 'watchlist.json'),
  positionsFile: path.join(__dirname, 'data', 'positions.json'),
  scansLogFile: path.join(__dirname, 'data', 'scan_history.json'),
  alertsFile: path.join(__dirname, 'data', 'alerts.json'),
  dataDir: path.join(__dirname, 'data'),
};

// Ensure data directory exists
if (!fs.existsSync(CONFIG.dataDir)) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
}

// ============================================================================
// WATCHLIST MANAGEMENT
// ============================================================================

const DEFAULT_WATCHLIST = {
  // Dick Capital picks we're monitoring
  dickCapital: [
    { symbol: 'ANF', entryTarget: 97, thesis: 'Retail turnaround, 62% P/E discount', ptLow: 123, ptHigh: 128 },
    { symbol: 'FOA', entryTarget: 22, thesis: 'Reverse mortgage leader, Blue Owl partnership', ptLow: 42, ptHigh: 76 },
    { symbol: 'ATXRF', entryTarget: 3.00, thesis: 'Copper explorer, wait for pullback', ptLow: 4.50, ptHigh: 6.00 },
    { symbol: 'TORXF', entryTarget: 60, thesis: 'Gold producer, Mexico king', ptLow: 80, ptHigh: 100 },
    { symbol: 'NBIS', entryTarget: 70, thesis: 'AI infra, high risk', ptLow: 120, ptHigh: 150 },
  ],
  // My independent research picks
  independent: [
    { symbol: 'CRDO', entryTarget: 28, thesis: 'AI networking, down 54% from highs', ptLow: 50, ptHigh: 70 },
    { symbol: 'TGB', entryTarget: 7, thesis: 'Copper producer, 44% of NPV', ptLow: 12, ptHigh: 15 },
    { symbol: 'CCJ', entryTarget: 50, thesis: 'Uranium leader, nuclear for AI', ptLow: 65, ptHigh: 80 },
    { symbol: 'MU', entryTarget: 85, thesis: 'HBM leader, 12x fwd P/E', ptLow: 110, ptHigh: 130 },
    { symbol: 'BE', entryTarget: 25, thesis: 'AI power bottleneck solver', ptLow: 40, ptHigh: 50 },
  ],
  // Current positions to monitor
  positions: [],
  // Custom alerts
  alerts: [],
};

function loadWatchlist() {
  if (fs.existsSync(CONFIG.watchlistFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.watchlistFile, 'utf8'));
  }
  // Initialize with defaults
  fs.writeFileSync(CONFIG.watchlistFile, JSON.stringify(DEFAULT_WATCHLIST, null, 2));
  return DEFAULT_WATCHLIST;
}

function saveWatchlist(watchlist) {
  fs.writeFileSync(CONFIG.watchlistFile, JSON.stringify(watchlist, null, 2));
}

// ============================================================================
// MARKET DATA FETCHING (Using free APIs)
// ============================================================================

async function fetchQuote(symbol) {
  try {
    // Try Yahoo Finance via web search as backup
    const https = require('https');

    return new Promise((resolve, reject) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;

      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const result = json.chart?.result?.[0];
            if (result) {
              const meta = result.meta;
              const quotes = result.indicators?.quote?.[0];
              const lastIdx = quotes?.close?.length - 1;

              resolve({
                symbol: symbol,
                price: meta.regularMarketPrice || quotes?.close?.[lastIdx],
                previousClose: meta.previousClose || meta.chartPreviousClose,
                change: meta.regularMarketPrice - (meta.previousClose || 0),
                changePercent: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100).toFixed(2),
                volume: quotes?.volume?.[lastIdx],
                high: quotes?.high?.[lastIdx],
                low: quotes?.low?.[lastIdx],
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
                timestamp: new Date().toISOString()
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
    console.error(`Error fetching quote for ${symbol}:`, error.message);
    return null;
  }
}

async function fetchMultipleQuotes(symbols) {
  const quotes = {};
  const batchSize = 5;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(s => fetchQuote(s)));

    batch.forEach((symbol, idx) => {
      if (results[idx]) {
        quotes[symbol] = results[idx];
      }
    });

    // Rate limit
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return quotes;
}

// ============================================================================
// SIGNAL DETECTION
// ============================================================================

function detectSignals(watchlist, quotes) {
  const signals = {
    entryOpportunities: [],
    exitSignals: [],
    alertsTriggered: [],
    priceAlerts: [],
    momentumShifts: [],
  };

  // Check Dick Capital picks
  [...watchlist.dickCapital, ...watchlist.independent].forEach(pick => {
    const quote = quotes[pick.symbol];
    if (!quote) return;

    const price = quote.price;
    const change = parseFloat(quote.changePercent);

    // Entry opportunity: price at or below target
    if (price <= pick.entryTarget) {
      signals.entryOpportunities.push({
        symbol: pick.symbol,
        price,
        target: pick.entryTarget,
        discount: ((pick.entryTarget - price) / pick.entryTarget * 100).toFixed(1),
        thesis: pick.thesis,
        ptLow: pick.ptLow,
        ptHigh: pick.ptHigh,
        upside: ((pick.ptLow - price) / price * 100).toFixed(1),
      });
    }

    // Near entry (within 5%)
    else if (price <= pick.entryTarget * 1.05) {
      signals.priceAlerts.push({
        symbol: pick.symbol,
        price,
        target: pick.entryTarget,
        distance: ((price - pick.entryTarget) / pick.entryTarget * 100).toFixed(1),
        thesis: pick.thesis,
      });
    }

    // Big move detection (>5% in a day)
    if (Math.abs(change) >= 5) {
      signals.momentumShifts.push({
        symbol: pick.symbol,
        price,
        change: change,
        direction: change > 0 ? 'UP' : 'DOWN',
        thesis: pick.thesis,
      });
    }
  });

  // Check positions for exit signals
  watchlist.positions.forEach(position => {
    const quote = quotes[position.symbol];
    if (!quote) return;

    const price = quote.price;
    const gainLoss = ((price - position.entry) / position.entry * 100).toFixed(2);

    // Target hit
    if (price >= position.targetPrice) {
      signals.exitSignals.push({
        symbol: position.symbol,
        signal: 'TARGET_HIT',
        price,
        entry: position.entry,
        target: position.targetPrice,
        gain: gainLoss,
      });
    }

    // Stop loss hit
    if (position.stopLoss && price <= position.stopLoss) {
      signals.exitSignals.push({
        symbol: position.symbol,
        signal: 'STOP_LOSS',
        price,
        entry: position.entry,
        stopLoss: position.stopLoss,
        loss: gainLoss,
      });
    }
  });

  return signals;
}

// ============================================================================
// CATALYST TRACKING
// ============================================================================

// Earnings calendar (would be populated from API in production)
const EARNINGS_CALENDAR = {
  'TORXF': { date: '2026-02-18', estimate: null },
  'ANF': { date: '2026-03-05', estimate: 3.45 },
  // Add more as needed
};

function checkUpcomingCatalysts(watchlist) {
  const catalysts = [];
  const now = new Date();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  const allSymbols = [
    ...watchlist.dickCapital.map(p => p.symbol),
    ...watchlist.independent.map(p => p.symbol),
    ...watchlist.positions.map(p => p.symbol),
  ];

  allSymbols.forEach(symbol => {
    const earnings = EARNINGS_CALENDAR[symbol];
    if (earnings) {
      const earningsDate = new Date(earnings.date);
      const daysUntil = Math.ceil((earningsDate - now) / (24 * 60 * 60 * 1000));

      if (daysUntil > 0 && daysUntil <= 14) {
        catalysts.push({
          symbol,
          type: 'EARNINGS',
          date: earnings.date,
          daysUntil,
          estimate: earnings.estimate,
        });
      }
    }
  });

  return catalysts;
}

// ============================================================================
// MARKET OVERVIEW
// ============================================================================

async function getMarketOverview() {
  const indices = ['SPY', 'QQQ', 'IWM', 'DIA'];
  const quotes = await fetchMultipleQuotes(indices);

  return {
    spy: quotes['SPY'],
    qqq: quotes['QQQ'],
    iwm: quotes['IWM'],
    dia: quotes['DIA'],
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// DISCORD CHANNEL POSTING (Direct REST API)
// ============================================================================

const discord = require('../trading_agents/discord_channels');

function formatDiscordReport(scanResult) {
  const { signals, catalysts, marketOverview, timestamp } = scanResult;

  let report = `**📊 HOURLY SCAN** - ${new Date(timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET\n\n`;

  // Market Overview (compact)
  if (marketOverview.spy) {
    const spyDir = parseFloat(marketOverview.spy.changePercent) >= 0 ? '🟢' : '🔴';
    const qqqDir = parseFloat(marketOverview.qqq?.changePercent) >= 0 ? '🟢' : '🔴';
    report += `${spyDir} SPY $${marketOverview.spy.price?.toFixed(2)} (${marketOverview.spy.changePercent}%) | ${qqqDir} QQQ $${marketOverview.qqq?.price?.toFixed(2)} (${marketOverview.qqq?.changePercent}%)\n\n`;
  }

  // Entry Opportunities (PRIORITY)
  if (signals.entryOpportunities.length > 0) {
    report += `**🎯 ENTRY OPPORTUNITIES:**\n`;
    signals.entryOpportunities.forEach(opp => {
      report += `• **${opp.symbol}** $${opp.price} (${opp.discount}% below $${opp.target}) → ${opp.upside}% upside to $${opp.ptLow}\n`;
    });
    report += '\n';
  }

  // Near Entry Alerts
  if (signals.priceAlerts.length > 0) {
    report += `**👀 APPROACHING ENTRY:**\n`;
    signals.priceAlerts.forEach(alert => {
      report += `• ${alert.symbol}: $${alert.price} (${alert.distance}% from target $${alert.target})\n`;
    });
    report += '\n';
  }

  // Big Moves
  if (signals.momentumShifts.length > 0) {
    report += `**📈 BIG MOVES:**\n`;
    signals.momentumShifts.forEach(move => {
      const emoji = move.direction === 'UP' ? '🟢' : '🔴';
      report += `${emoji} **${move.symbol}** ${move.change > 0 ? '+' : ''}${move.change}%\n`;
    });
    report += '\n';
  }

  // Exit Signals
  if (signals.exitSignals.length > 0) {
    report += `**🚨 EXIT SIGNALS:**\n`;
    signals.exitSignals.forEach(exit => {
      if (exit.signal === 'TARGET_HIT') {
        report += `• 🎉 **${exit.symbol}** HIT TARGET! $${exit.price} (+${exit.gain}%)\n`;
      } else {
        report += `• ⚠️ **${exit.symbol}** STOP LOSS! $${exit.price} (${exit.loss}%)\n`;
      }
    });
    report += '\n';
  }

  // Upcoming Catalysts
  if (catalysts.length > 0) {
    report += `**📅 CATALYSTS:**\n`;
    catalysts.forEach(cat => {
      report += `• ${cat.symbol}: ${cat.type} in ${cat.daysUntil}d (${cat.date})\n`;
    });
    report += '\n';
  }

  // If nothing notable
  if (signals.entryOpportunities.length === 0 &&
      signals.exitSignals.length === 0 &&
      signals.momentumShifts.length === 0) {
    report += `_Watchlist stable. No actionable signals._\n`;
  }

  return report;
}

// ============================================================================
// MAIN SCAN FUNCTION
// ============================================================================

async function runHourlyScan(sendToDiscord = null) {
  console.log(`[${new Date().toISOString()}] Starting hourly financial scan...`);

  const watchlist = loadWatchlist();

  // Get all symbols to scan
  const allSymbols = [
    ...watchlist.dickCapital.map(p => p.symbol),
    ...watchlist.independent.map(p => p.symbol),
    ...watchlist.positions.map(p => p.symbol),
  ];
  const uniqueSymbols = [...new Set(allSymbols)];

  console.log(`Scanning ${uniqueSymbols.length} symbols...`);

  // Fetch quotes
  const quotes = await fetchMultipleQuotes(uniqueSymbols);
  console.log(`Fetched ${Object.keys(quotes).length} quotes`);

  // Get market overview
  const marketOverview = await getMarketOverview();

  // Detect signals
  const signals = detectSignals(watchlist, quotes);

  // Check catalysts
  const catalysts = checkUpcomingCatalysts(watchlist);

  // Build result
  const scanResult = {
    timestamp: new Date().toISOString(),
    signals,
    catalysts,
    marketOverview,
    quotes,
  };

  // Log scan
  logScan(scanResult);

  // Format Discord report
  const report = formatDiscordReport(scanResult);
  console.log('\n' + report);

  // Always post to swing-scanner channel via REST API
  try {
    await discord.swingScanner(report);
    console.log('Report posted to #swing-scanner');
  } catch (err) {
    console.error('Failed to post to Discord channel:', err.message);
  }

  // Also send via callback if provided (legacy support)
  if (sendToDiscord) {
    try {
      await sendToDiscord(report);
    } catch (err) {
      console.error('Failed to send via callback:', err.message);
    }
  }

  return scanResult;
}

function logScan(scanResult) {
  let history = [];
  if (fs.existsSync(CONFIG.scansLogFile)) {
    try {
      history = JSON.parse(fs.readFileSync(CONFIG.scansLogFile, 'utf8'));
    } catch (e) {
      history = [];
    }
  }

  // Keep last 168 scans (1 week of hourly)
  history.push({
    timestamp: scanResult.timestamp,
    entryOpportunities: scanResult.signals.entryOpportunities.length,
    exitSignals: scanResult.signals.exitSignals.length,
    bigMoves: scanResult.signals.momentumShifts.length,
  });

  if (history.length > 168) {
    history = history.slice(-168);
  }

  fs.writeFileSync(CONFIG.scansLogFile, JSON.stringify(history, null, 2));
}

// ============================================================================
// SCHEDULER
// ============================================================================

class FinancialAgentScheduler {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.lastScan = null;
    this.sendToDiscord = null;
  }

  setSendFunction(fn) {
    this.sendToDiscord = fn;
  }

  async start() {
    if (this.isRunning) {
      console.log('Financial agent already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting Hourly Financial Agent...');
    console.log(`Scan interval: ${CONFIG.scanIntervalMs / 1000 / 60} minutes`);

    // Run immediately
    await this.scan();

    // Schedule hourly
    this.intervalId = setInterval(() => this.scan(), CONFIG.scanIntervalMs);

    console.log('Financial agent started. Next scan in 1 hour.');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('Financial agent stopped.');
  }

  async scan() {
    try {
      this.lastScan = await runHourlyScan(this.sendToDiscord);
    } catch (error) {
      console.error('Scan error:', error);
      if (this.sendToDiscord) {
        await this.sendToDiscord(`⚠️ Financial scan error: ${error.message}`);
      }
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastScan: this.lastScan?.timestamp,
      nextScan: this.isRunning
        ? new Date(Date.now() + CONFIG.scanIntervalMs).toISOString()
        : null,
    };
  }
}

// Singleton instance
const scheduler = new FinancialAgentScheduler();

// ============================================================================
// WATCHLIST MANAGEMENT API
// ============================================================================

function addToWatchlist(category, item) {
  const watchlist = loadWatchlist();
  if (watchlist[category]) {
    watchlist[category].push(item);
    saveWatchlist(watchlist);
    return true;
  }
  return false;
}

function removeFromWatchlist(category, symbol) {
  const watchlist = loadWatchlist();
  if (watchlist[category]) {
    watchlist[category] = watchlist[category].filter(i => i.symbol !== symbol);
    saveWatchlist(watchlist);
    return true;
  }
  return false;
}

function addPosition(position) {
  const watchlist = loadWatchlist();
  watchlist.positions.push({
    ...position,
    addedAt: new Date().toISOString(),
  });
  saveWatchlist(watchlist);
}

function removePosition(symbol) {
  const watchlist = loadWatchlist();
  watchlist.positions = watchlist.positions.filter(p => p.symbol !== symbol);
  saveWatchlist(watchlist);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  scheduler,
  runHourlyScan,
  loadWatchlist,
  saveWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  addPosition,
  removePosition,
  fetchQuote,
  fetchMultipleQuotes,
  detectSignals,
  formatDiscordReport,
  CONFIG,
};

// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'scan';

  switch (command) {
    case 'scan':
      // Single scan
      runHourlyScan().then(() => process.exit(0));
      break;

    case 'start':
      // Start scheduler (keeps running)
      scheduler.start();
      break;

    case 'watchlist':
      // Show watchlist
      const wl = loadWatchlist();
      console.log(JSON.stringify(wl, null, 2));
      break;

    case 'add':
      // Add to watchlist: node hourly_financial_agent.js add independent SYMBOL 25 "thesis" 40 50
      if (args.length >= 6) {
        const [, category, symbol, entryTarget, thesis, ptLow, ptHigh] = args;
        addToWatchlist(category, {
          symbol,
          entryTarget: parseFloat(entryTarget),
          thesis,
          ptLow: parseFloat(ptLow),
          ptHigh: parseFloat(ptHigh || ptLow),
        });
        console.log(`Added ${symbol} to ${category} watchlist`);
      } else {
        console.log('Usage: node hourly_financial_agent.js add <category> <symbol> <entryTarget> <thesis> <ptLow> [ptHigh]');
      }
      break;

    default:
      console.log('Commands: scan, start, watchlist, add');
  }
}
