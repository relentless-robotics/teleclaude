/**
 * Trade Journal - Complete Trade Logging & Performance Tracking
 *
 * Tracks:
 * - Every trade from open to close with full details
 * - Peak gain/loss during each position's lifetime (high watermark)
 * - Daily P&L summaries
 * - Cumulative performance over time
 * - Labeled: SWING vs DAY
 *
 * Posts trade summaries to Discord #pnl channel on close.
 *
 * Usage:
 *   const journal = require('./trade_journal');
 *   journal.openTrade({ symbol, account, ... });
 *   journal.updatePeak(symbol, account, currentPrice);
 *   journal.closeTrade({ symbol, account, exitPrice, ... });
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const JOURNAL_FILE = path.join(DATA_DIR, 'trade_journal.json');
const PERFORMANCE_FILE = path.join(DATA_DIR, 'performance_log.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Discord channel posting
let discord;
try { discord = require('./discord_channels'); } catch (e) {}

// ============================================================================
// JOURNAL STORAGE
// ============================================================================

function loadJournal() {
  try {
    if (fs.existsSync(JOURNAL_FILE)) return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
  } catch (e) {}
  return { openTrades: {}, closedTrades: [], lastUpdated: null };
}

function saveJournal(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2));
}

function loadPerformance() {
  try {
    if (fs.existsSync(PERFORMANCE_FILE)) return JSON.parse(fs.readFileSync(PERFORMANCE_FILE, 'utf8'));
  } catch (e) {}
  return { dailyPnL: {}, cumulativePnL: 0, totalTrades: 0, wins: 0, losses: 0, lastUpdated: null };
}

function savePerformance(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(data, null, 2));
}

function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getTimeET() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true });
}

// Unique key for a position: account_symbol (e.g., "day_AMD" or "swing_SMCI")
function tradeKey(account, symbol) {
  return `${account}_${symbol}`;
}

// ============================================================================
// OPEN TRADE
// ============================================================================

/**
 * Record a new trade being opened
 * @param {object} params
 * @param {string} params.symbol - Ticker (e.g., "AMD" or option symbol)
 * @param {string} params.account - "day" or "swing"
 * @param {string} params.vehicle - "EQUITY" or "OPTION"
 * @param {string} params.direction - "LONG", "SHORT", "CALL", "PUT"
 * @param {number} params.qty - Number of shares or contracts
 * @param {number} params.entryPrice - Average entry price per share/contract
 * @param {number} params.totalCost - Total dollar cost
 * @param {string} params.reasoning - Why the trade was taken
 * @param {string} params.catalyst - Catalyst (for swing trades)
 * @param {string} params.timeframe - Expected holding period
 * @param {number} [params.strike] - Option strike price
 * @param {string} [params.expiry] - Option expiry date
 * @param {string} [params.conviction] - HIGH/MEDIUM/LOW
 * @param {string} [params.target] - Target price/pct
 * @param {string} [params.stop] - Stop loss price/pct
 * @param {number} [params.alpacaFillPrice] - FIX 7: Actual fill price from Alpaca (for validation)
 */
function openTrade(params) {
  const journal = loadJournal();
  const key = tradeKey(params.account, params.symbol);

  // FIX 7: Validate entry price against Alpaca fill price (if provided)
  let finalEntryPrice = params.entryPrice;
  if (params.alpacaFillPrice && Math.abs(params.alpacaFillPrice - params.entryPrice) / params.entryPrice > 0.05) {
    console.warn(`[TradeJournal] FIX 7 - Price mismatch! Recorded: $${params.entryPrice}, Alpaca fill: $${params.alpacaFillPrice}. Using Alpaca price.`);
    finalEntryPrice = params.alpacaFillPrice;
  }

  journal.openTrades[key] = {
    symbol: params.symbol,
    account: params.account,
    vehicle: params.vehicle || 'EQUITY',
    direction: params.direction || 'LONG',
    qty: params.qty,
    entryPrice: finalEntryPrice,
    totalCost: params.totalCost || params.qty * finalEntryPrice * (params.vehicle === 'OPTION' ? 100 : 1),
    reasoning: params.reasoning,
    catalyst: params.catalyst || null,
    timeframe: params.timeframe || null,
    conviction: params.conviction || 'MEDIUM',
    target: params.target || null,
    stop: params.stop || null,
    strike: params.strike || null,
    expiry: params.expiry || null,
    openedAt: new Date().toISOString(),
    openedDate: getTodayET(),
    openedTime: getTimeET(),

    // Peak tracking
    peakPrice: params.entryPrice,
    peakPct: 0,
    peakDate: getTodayET(),
    troughPrice: params.entryPrice,
    troughPct: 0,
    troughDate: getTodayET(),

    // Running state
    lastPrice: params.entryPrice,
    lastUpdated: new Date().toISOString(),
  };

  saveJournal(journal);
  console.log(`[TradeJournal] Opened: ${params.account.toUpperCase()} ${params.symbol} ${params.direction} x${params.qty} @ $${params.entryPrice}`);
  return journal.openTrades[key];
}

// ============================================================================
// UPDATE PEAK / TROUGH
// ============================================================================

/**
 * Update the peak and trough prices for an open position.
 * Call this every time you check position prices (e.g., from position monitor every 60s).
 *
 * @param {string} symbol
 * @param {string} account - "day" or "swing"
 * @param {number} currentPrice
 */
function updatePeak(symbol, account, currentPrice) {
  const journal = loadJournal();
  const key = tradeKey(account, symbol);
  const trade = journal.openTrades[key];

  if (!trade) return null;

  const entryPrice = trade.entryPrice;
  const currentPct = ((currentPrice - entryPrice) / entryPrice) * 100;

  // Update peak (best price during trade)
  // CALL and PUT options are BOUGHT - higher price = better (for both)
  // Only SHORT equity means lower price = better
  const isShort = trade.direction === 'SHORT';

  if (!isShort) {
    // LONG / CALL / PUT - all are bought, higher = better
    if (currentPrice > trade.peakPrice) {
      trade.peakPrice = currentPrice;
      trade.peakPct = currentPct;
      trade.peakDate = getTodayET();
    }
    if (currentPrice < trade.troughPrice) {
      trade.troughPrice = currentPrice;
      trade.troughPct = currentPct;
      trade.troughDate = getTodayET();
    }
  } else {
    // SHORT equity only - lower price = better
    if (currentPrice < trade.peakPrice) {
      trade.peakPrice = currentPrice;
      trade.peakPct = -currentPct;
      trade.peakDate = getTodayET();
    }
    if (currentPrice > trade.troughPrice) {
      trade.troughPrice = currentPrice;
      trade.troughPct = -currentPct;
      trade.troughDate = getTodayET();
    }
  }

  trade.lastPrice = currentPrice;
  trade.lastUpdated = new Date().toISOString();

  saveJournal(journal);
  return trade;
}

/**
 * Batch update peaks for all open positions given a map of symbol -> price
 */
function updateAllPeaks(priceMap, account) {
  const journal = loadJournal();
  let updated = 0;

  for (const [key, trade] of Object.entries(journal.openTrades)) {
    if (account && trade.account !== account) continue;
    const price = priceMap[trade.symbol];
    if (price != null) {
      const entryPrice = trade.entryPrice;
      const currentPct = ((price - entryPrice) / entryPrice) * 100;

      if (trade.direction === 'LONG' || trade.direction === 'CALL') {
        if (price > trade.peakPrice) {
          trade.peakPrice = price;
          trade.peakPct = currentPct;
          trade.peakDate = getTodayET();
        }
        if (price < trade.troughPrice) {
          trade.troughPrice = price;
          trade.troughPct = currentPct;
          trade.troughDate = getTodayET();
        }
      } else {
        if (price < trade.peakPrice) {
          trade.peakPrice = price;
          trade.peakPct = -currentPct;
          trade.peakDate = getTodayET();
        }
        if (price > trade.troughPrice) {
          trade.troughPrice = price;
          trade.troughPct = -currentPct;
          trade.troughDate = getTodayET();
        }
      }

      trade.lastPrice = price;
      trade.lastUpdated = new Date().toISOString();
      updated++;
    }
  }

  if (updated > 0) saveJournal(journal);
  return updated;
}

// ============================================================================
// CLOSE TRADE
// ============================================================================

/**
 * Record a trade being closed and post summary to Discord #pnl
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.account - "day" or "swing"
 * @param {number} params.exitPrice - Exit price per share/contract
 * @param {number} [params.exitQty] - Partial close qty (null = full close)
 * @param {string} params.reasoning - Why we closed
 */
async function closeTrade(params) {
  const journal = loadJournal();
  const key = tradeKey(params.account, params.symbol);
  const trade = journal.openTrades[key];

  if (!trade) {
    // No open trade record - create a minimal closed record
    console.warn(`[TradeJournal] No open trade found for ${key}, creating minimal record`);
    const minimalClose = {
      symbol: params.symbol,
      account: params.account,
      exitPrice: params.exitPrice,
      exitReasoning: params.reasoning,
      closedAt: new Date().toISOString(),
      note: 'No open trade record found - trade was opened before journal system',
    };
    journal.closedTrades.push(minimalClose);
    saveJournal(journal);
    return minimalClose;
  }

  const exitPrice = params.exitPrice;
  const entryPrice = trade.entryPrice;
  const multiplier = trade.vehicle === 'OPTION' ? 100 : 1;
  const isPartial = params.exitQty && params.exitQty < trade.qty;
  const closeQty = params.exitQty || trade.qty;

  // Calculate P&L
  // CALL and PUT options are BOUGHT (long premium) - profit when they go UP
  // Only SHORT equity means inverted P&L
  const isShort = trade.direction === 'SHORT';
  const plPerUnit = isShort
    ? entryPrice - exitPrice
    : exitPrice - entryPrice;
  const totalPL = plPerUnit * closeQty * multiplier;
  const plPct = (plPerUnit / entryPrice) * 100;

  // Calculate holding period
  const openDate = new Date(trade.openedAt);
  const closeDate = new Date();
  const holdingMs = closeDate - openDate;
  const holdingDays = holdingMs / (1000 * 60 * 60 * 24);
  const holdingStr = holdingDays < 1
    ? `${Math.round(holdingMs / 60000)} min`
    : holdingDays < 2
    ? `${Math.round(holdingMs / 3600000)} hours`
    : `${Math.round(holdingDays)} days`;

  // Build closed trade record
  const closedTrade = {
    // Identity
    symbol: trade.symbol,
    account: trade.account,
    vehicle: trade.vehicle,
    direction: trade.direction,
    strike: trade.strike,
    expiry: trade.expiry,

    // Entry
    qty: closeQty,
    entryPrice: entryPrice,
    totalCost: entryPrice * closeQty * multiplier,
    entryDate: trade.openedDate,
    entryTime: trade.openedTime,
    entryReasoning: trade.reasoning,
    catalyst: trade.catalyst,
    conviction: trade.conviction,

    // Exit
    exitPrice: exitPrice,
    totalProceeds: exitPrice * closeQty * multiplier,
    exitDate: getTodayET(),
    exitTime: getTimeET(),
    exitReasoning: params.reasoning,

    // P&L
    profitLoss: totalPL,
    profitLossPct: plPct,
    outcome: totalPL >= 0 ? 'WIN' : 'LOSS',

    // Peak tracking (the important part!)
    peakPrice: trade.peakPrice,
    peakPct: trade.peakPct,
    peakDate: trade.peakDate,
    troughPrice: trade.troughPrice,
    troughPct: trade.troughPct,
    troughDate: trade.troughDate,

    // Missed gains = peak % - actual exit %
    missedGainPct: trade.peakPct - plPct,

    // Holding period
    holdingPeriod: holdingStr,
    holdingDays: Math.round(holdingDays * 10) / 10,

    // Timestamps
    openedAt: trade.openedAt,
    closedAt: new Date().toISOString(),
  };

  // Add to closed trades
  journal.closedTrades.push(closedTrade);

  // Remove from open trades (or reduce qty for partial)
  if (isPartial) {
    trade.qty -= closeQty;
  } else {
    delete journal.openTrades[key];
  }

  saveJournal(journal);

  // Update performance log
  updatePerformanceLog(closedTrade);

  // Post to Discord #pnl
  await postTradeClose(closedTrade);

  console.log(`[TradeJournal] Closed: ${closedTrade.account.toUpperCase()} ${closedTrade.symbol} ${closedTrade.outcome} ${closedTrade.profitLossPct >= 0 ? '+' : ''}${closedTrade.profitLossPct.toFixed(2)}% ($${closedTrade.profitLoss.toFixed(2)})`);
  return closedTrade;
}

// ============================================================================
// PERFORMANCE LOG
// ============================================================================

function updatePerformanceLog(closedTrade) {
  const perf = loadPerformance();
  const today = getTodayET();

  // Update daily P&L
  if (!perf.dailyPnL[today]) {
    perf.dailyPnL[today] = {
      date: today,
      trades: 0,
      wins: 0,
      losses: 0,
      grossPL: 0,
      dayTrades: 0,
      swingTrades: 0,
    };
  }

  const day = perf.dailyPnL[today];
  day.trades++;
  day.grossPL += closedTrade.profitLoss;
  if (closedTrade.outcome === 'WIN') {
    day.wins++;
    perf.wins++;
  } else {
    day.losses++;
    perf.losses++;
  }
  if (closedTrade.account === 'day') day.dayTrades++;
  if (closedTrade.account === 'swing') day.swingTrades++;

  // Update cumulative
  perf.cumulativePnL += closedTrade.profitLoss;
  perf.totalTrades++;

  savePerformance(perf);
}

// ============================================================================
// DISCORD #PNL POSTING
// ============================================================================

async function postTradeClose(trade) {
  if (!discord) return;

  const acctLabel = trade.account === 'day' ? '⚡ DAY' : '📊 SWING';
  const outcomeEmoji = trade.outcome === 'WIN' ? '🟢' : '🔴';
  const plSign = trade.profitLoss >= 0 ? '+' : '';
  const pctSign = trade.profitLossPct >= 0 ? '+' : '';

  let msg = `${outcomeEmoji} **TRADE CLOSED** [${acctLabel}]\n\n`;

  // Symbol and direction
  if (trade.vehicle === 'OPTION') {
    msg += `**${trade.symbol}** ${trade.direction} $${trade.strike} ${trade.expiry} x${trade.qty} contracts\n`;
  } else {
    msg += `**${trade.symbol}** ${trade.direction} x${trade.qty} shares\n`;
  }
  msg += '\n';

  // Entry/Exit with P&L
  msg += `**Entry:** $${trade.entryPrice.toFixed(2)} on ${trade.entryDate} ${trade.entryTime}\n`;
  msg += `**Exit:** $${trade.exitPrice.toFixed(2)} on ${trade.exitDate} ${trade.exitTime}\n`;
  msg += `**P&L:** ${plSign}$${trade.profitLoss.toFixed(2)} (${pctSign}${trade.profitLossPct.toFixed(2)}%)\n`;
  msg += `**Held:** ${trade.holdingPeriod}\n\n`;

  // Peak performance during trade
  const peakSign = trade.peakPct >= 0 ? '+' : '';
  const troughSign = trade.troughPct >= 0 ? '+' : '';
  msg += `**Peak:** $${trade.peakPrice.toFixed(2)} (${peakSign}${trade.peakPct.toFixed(2)}%) on ${trade.peakDate}\n`;
  msg += `**Trough:** $${trade.troughPrice.toFixed(2)} (${troughSign}${trade.troughPct.toFixed(2)}%) on ${trade.troughDate}\n`;

  // Missed gains (if we exited below peak)
  if (trade.missedGainPct > 0.5) {
    msg += `⚠️ **Missed:** ${trade.missedGainPct.toFixed(2)}% left on the table (peak was ${peakSign}${trade.peakPct.toFixed(2)}%, exited at ${pctSign}${trade.profitLossPct.toFixed(2)}%)\n`;
  }
  msg += '\n';

  // Reasoning
  msg += `**Entry reason:** _${trade.entryReasoning || 'N/A'}_\n`;
  msg += `**Exit reason:** _${trade.exitReasoning || 'N/A'}_\n`;
  if (trade.catalyst) msg += `**Catalyst:** ${trade.catalyst}\n`;

  await discord.pnl(msg);
}

// ============================================================================
// DAILY SUMMARY
// ============================================================================

async function postDailySummary() {
  if (!discord) return;

  const perf = loadPerformance();
  const journal = loadJournal();
  const today = getTodayET();
  const dayStats = perf.dailyPnL[today];

  let msg = `📈 **DAILY P&L SUMMARY** - ${today}\n\n`;

  if (dayStats && dayStats.trades > 0) {
    const plEmoji = dayStats.grossPL >= 0 ? '🟢' : '🔴';
    const plSign = dayStats.grossPL >= 0 ? '+' : '';
    msg += `**Today:** ${plEmoji} ${plSign}$${dayStats.grossPL.toFixed(2)}\n`;
    msg += `Trades: ${dayStats.trades} (${dayStats.wins}W / ${dayStats.losses}L)\n`;
    msg += `Win Rate: ${dayStats.trades > 0 ? (dayStats.wins / dayStats.trades * 100).toFixed(0) : 0}%\n`;
    if (dayStats.dayTrades > 0) msg += `Day trades: ${dayStats.dayTrades}\n`;
    if (dayStats.swingTrades > 0) msg += `Swing trades: ${dayStats.swingTrades}\n`;
    msg += '\n';
  } else {
    msg += '_No trades closed today._\n\n';
  }

  // Cumulative stats
  const cumSign = perf.cumulativePnL >= 0 ? '+' : '';
  msg += `**All Time:** ${cumSign}$${perf.cumulativePnL.toFixed(2)}\n`;
  msg += `Total Trades: ${perf.totalTrades} (${perf.wins}W / ${perf.losses}L)\n`;
  if (perf.totalTrades > 0) {
    msg += `Win Rate: ${(perf.wins / perf.totalTrades * 100).toFixed(0)}%\n`;
  }
  msg += '\n';

  // Open positions summary
  const openTrades = Object.values(journal.openTrades);
  if (openTrades.length > 0) {
    msg += `**Open Positions (${openTrades.length}):**\n`;
    for (const t of openTrades) {
      const currentPct = t.lastPrice ? ((t.lastPrice - t.entryPrice) / t.entryPrice * 100) : 0;
      const emoji = currentPct >= 0 ? '🟢' : '🔴';
      const acct = t.account === 'day' ? '⚡' : '📊';
      const pctStr = `${currentPct >= 0 ? '+' : ''}${currentPct.toFixed(1)}%`;
      const peakStr = `peak: ${t.peakPct >= 0 ? '+' : ''}${t.peakPct.toFixed(1)}%`;
      msg += `${acct}${emoji} **${t.symbol}** ${t.direction} x${t.qty} @ $${t.entryPrice.toFixed(2)} → $${(t.lastPrice || t.entryPrice).toFixed(2)} (${pctStr}, ${peakStr})\n`;
    }
    msg += '\n';
  }

  // Recent 7-day trend
  const dates = Object.keys(perf.dailyPnL).sort().reverse().slice(0, 7);
  if (dates.length > 1) {
    msg += '**Last 7 days:**\n';
    for (const date of dates) {
      const d = perf.dailyPnL[date];
      const em = d.grossPL >= 0 ? '🟢' : '🔴';
      const s = d.grossPL >= 0 ? '+' : '';
      msg += `${em} ${date}: ${s}$${d.grossPL.toFixed(2)} (${d.trades} trades)\n`;
    }
  }

  await discord.pnl(msg);
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Get all open trades
 */
function getOpenTrades(account = null) {
  const journal = loadJournal();
  const trades = Object.values(journal.openTrades);
  if (account) return trades.filter(t => t.account === account);
  return trades;
}

/**
 * Get closed trades (optionally filtered)
 */
function getClosedTrades(opts = {}) {
  const journal = loadJournal();
  let trades = journal.closedTrades;
  if (opts.account) trades = trades.filter(t => t.account === opts.account);
  if (opts.since) trades = trades.filter(t => t.closedAt >= opts.since);
  if (opts.symbol) trades = trades.filter(t => t.symbol === opts.symbol);
  if (opts.limit) trades = trades.slice(-opts.limit);
  return trades;
}

/**
 * Get performance stats
 */
function getPerformanceStats() {
  const perf = loadPerformance();
  const journal = loadJournal();

  const closed = journal.closedTrades;
  const wins = closed.filter(t => t.outcome === 'WIN');
  const losses = closed.filter(t => t.outcome === 'LOSS');

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) + '%' : 'N/A',
    totalPL: perf.cumulativePnL,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.profitLoss, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.profitLoss, 0) / losses.length : 0,
    avgWinPct: wins.length > 0 ? (wins.reduce((s, t) => s + t.profitLossPct, 0) / wins.length).toFixed(2) + '%' : 'N/A',
    avgLossPct: losses.length > 0 ? (losses.reduce((s, t) => s + t.profitLossPct, 0) / losses.length).toFixed(2) + '%' : 'N/A',
    avgHoldingDays: closed.length > 0 ? (closed.reduce((s, t) => s + (t.holdingDays || 0), 0) / closed.length).toFixed(1) : 'N/A',
    avgMissedGainPct: closed.length > 0 ? (closed.reduce((s, t) => s + (t.missedGainPct || 0), 0) / closed.length).toFixed(2) + '%' : 'N/A',
    dailyPnL: perf.dailyPnL,
    openPositions: Object.values(journal.openTrades).length,
  };
}

/**
 * Check if a trade is already tracked as open
 */
function isTradeOpen(symbol, account) {
  const journal = loadJournal();
  return !!journal.openTrades[tradeKey(account, symbol)];
}

/**
 * Reconcile with Alpaca orders - find trades that were missed
 * Called at end of day_trader cycles to catch any missed recordings
 * @param {object} alpacaClient - Alpaca client instance
 * @param {string} account - "day" or "swing"
 */
async function reconcileWithAlpaca(alpacaClient, account) {
  if (!alpacaClient) return { added: 0, errors: [] };

  const journal = loadJournal();
  const today = new Date().toISOString().split('T')[0];

  try {
    // Get all filled orders from today
    const orders = await alpacaClient.getOrders({
      status: 'closed',
      after: `${today}T00:00:00Z`,
      limit: 100,
    });

    let added = 0;
    const errors = [];

    for (const order of orders || []) {
      if (!order.filled_at) continue;

      const symbol = order.symbol;
      const side = order.side; // buy or sell
      const key = tradeKey(account, symbol);

      // BUY orders (opening positions)
      if (side === 'buy') {
        if (!journal.openTrades[key]) {
          // Missing open trade - was never recorded
          const alreadyClosed = journal.closedTrades.find(
            t => t.symbol === symbol && t.account === account && t.closedAt >= order.filled_at
          );

          if (!alreadyClosed) {
            // Add the missing open trade
            console.warn(`[TradeJournal] Reconciliation: Adding missed OPEN ${symbol}`);
            openTrade({
              symbol,
              account,
              vehicle: symbol.length > 10 ? 'OPTION' : 'EQUITY',
              direction: 'LONG', // Assume long for missed trades
              qty: parseFloat(order.filled_qty),
              entryPrice: parseFloat(order.filled_avg_price),
              reasoning: 'Reconciled from Alpaca - missed original recording',
            });
            added++;
          }
        }
      }

      // SELL orders (closing positions)
      if (side === 'sell') {
        const alreadyClosed = journal.closedTrades.find(
          t => t.symbol === symbol && t.account === account && t.closedAt >= order.filled_at
        );

        if (!alreadyClosed && journal.openTrades[key]) {
          // Position is still open in journal but was sold
          console.warn(`[TradeJournal] Reconciliation: Closing missed SELL ${symbol}`);
          await closeTrade({
            symbol,
            account,
            exitPrice: parseFloat(order.filled_avg_price),
            reasoning: 'Reconciled from Alpaca - missed original close',
          });
          added++;
        }
      }
    }

    console.log(`[TradeJournal] Reconciliation complete: ${added} trades added/fixed`);
    return { added, errors };
  } catch (e) {
    console.error('[TradeJournal] Reconciliation error:', e.message);
    return { added: 0, errors: [e.message] };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  openTrade,
  updatePeak,
  updateAllPeaks,
  closeTrade,
  postDailySummary,
  getOpenTrades,
  getClosedTrades,
  getPerformanceStats,
  isTradeOpen,
  reconcileWithAlpaca,
};

// CLI
if (require.main === module) {
  const cmd = process.argv[2] || 'stats';

  (async () => {
    switch (cmd) {
      case 'stats':
        console.log(JSON.stringify(getPerformanceStats(), null, 2));
        break;
      case 'open':
        console.log(JSON.stringify(getOpenTrades(), null, 2));
        break;
      case 'closed':
        console.log(JSON.stringify(getClosedTrades({ limit: 20 }), null, 2));
        break;
      case 'summary':
        await postDailySummary();
        console.log('Daily summary posted to #pnl');
        break;
      default:
        console.log('Usage: node trade_journal.js [stats|open|closed|summary]');
    }
    process.exit(0);
  })();
}
