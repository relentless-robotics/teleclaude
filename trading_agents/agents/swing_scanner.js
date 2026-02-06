/**
 * Swing Scanner Agent
 *
 * Runs 9:30 AM - 4:00 PM ET every 30 minutes
 *
 * Tasks:
 * - Scan watchlist for entry signals
 * - Monitor existing positions
 * - Evaluate exit conditions
 * - Execute trades when criteria met
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const discord = require('../discord_channels');
const brain = require('../shared_brain');

// Import Alpaca client
let alpacaClient;
try {
  alpacaClient = require('../../swing_options/alpaca_client');
} catch (e) {
  console.warn('Alpaca client not available:', e.message);
}

class SwingScannerAgent {
  constructor() {
    this.name = 'Swing Scanner';
    this.emoji = '📊';
    this.lastRun = null;
    this.dataDir = config.paths.dataDir;
  }

  /**
   * Main run function
   */
  async run() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Swing Scanner starting...`);

    const report = {
      timestamp: new Date().toISOString(),
      account: null,
      positions: [],
      opportunities: [],
      signals: [],
      executions: [],
      errors: [],
    };

    try {
      // 1. Get account status
      if (alpacaClient) {
        report.account = await this.getAccountStatus();
        report.positions = await this.getPositions();
      }

      // 2. Scan watchlist for opportunities
      report.opportunities = await this.scanWatchlist();

      // 3. Check existing positions for signals
      report.signals = await this.checkPositionSignals(report.positions);

      // 4. Execute trades if criteria met
      report.executions = await this.executeTrades(report.opportunities, report.account);

    } catch (error) {
      report.errors.push(error.message);
      console.error('Swing Scanner error:', error);
    }

    // Write to shared brain
    brain.writeSwingState({
      positions: report.positions,
      signals: report.signals,
      account: report.account,
    });

    // Send report to Discord
    await this.sendReport(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Swing Scanner completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Get account status from Alpaca
   */
  async getAccountStatus() {
    try {
      const account = await alpacaClient.getAccount();
      return {
        equity: parseFloat(account.portfolio_value),
        cash: parseFloat(account.cash),
        buyingPower: parseFloat(account.buying_power),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get current positions
   */
  async getPositions() {
    try {
      const positions = await alpacaClient.getPositions();
      return positions.map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPL: parseFloat(p.unrealized_pl),
        unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Scan watchlist for entry opportunities
   */
  async scanWatchlist() {
    const opportunities = [];

    // Load watchlist
    const watchlistPath = config.paths.watchlistFile;
    let watchlist = { dickCapital: [], independent: [] };

    if (fs.existsSync(watchlistPath)) {
      watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    }

    const allPicks = [...(watchlist.dickCapital || []), ...(watchlist.independent || [])];

    for (const pick of allPicks) {
      const quote = await this.fetchQuote(pick.symbol);
      if (!quote) continue;

      const price = quote.price;
      const entryTarget = pick.entryTarget;
      const distanceFromEntry = (price - entryTarget) / entryTarget;
      const upside = (pick.ptLow - price) / price;

      // Entry criteria
      if (price <= entryTarget * 1.05) { // Within 5% of entry
        opportunities.push({
          symbol: pick.symbol,
          price,
          entryTarget,
          distanceFromEntry: distanceFromEntry * 100,
          upside: upside * 100,
          ptLow: pick.ptLow,
          ptHigh: pick.ptHigh,
          thesis: pick.thesis,
          conviction: pick.conviction || 'MEDIUM',
          signal: price <= entryTarget ? 'STRONG_BUY' : 'BUY',
        });
      }
    }

    // Sort by signal strength and distance from entry
    opportunities.sort((a, b) => {
      if (a.signal !== b.signal) return a.signal === 'STRONG_BUY' ? -1 : 1;
      return a.distanceFromEntry - b.distanceFromEntry;
    });

    return opportunities;
  }

  /**
   * Check positions for exit signals
   */
  async checkPositionSignals(positions) {
    const signals = [];

    // Load watchlist for targets
    const watchlistPath = config.paths.watchlistFile;
    let watchlist = { dickCapital: [], independent: [], positions: [] };
    if (fs.existsSync(watchlistPath)) {
      watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    }

    const allPicks = [...(watchlist.dickCapital || []), ...(watchlist.independent || [])];

    // Also check positions from watchlist for stop loss / target
    for (const pos of positions) {
      const watchPos = (watchlist.positions || []).find(p => p.symbol === pos.symbol);
      if (watchPos) {
        if (watchPos.target && pos.currentPrice >= watchPos.target) {
          signals.push({
            symbol: pos.symbol,
            type: 'TARGET_HIT',
            message: `Target $${watchPos.target} reached! Current: $${pos.currentPrice.toFixed(2)}`,
            action: 'CONSIDER_EXIT',
            gain: pos.unrealizedPLPct,
          });
        }
        if (watchPos.stopLoss && pos.currentPrice <= watchPos.stopLoss) {
          signals.push({
            symbol: pos.symbol,
            type: 'STOP_LOSS',
            message: `Stop loss $${watchPos.stopLoss} hit! Current: $${pos.currentPrice.toFixed(2)}`,
            action: 'EXIT_POSITION',
            gain: pos.unrealizedPLPct,
          });
        }
      }
    }

    for (const position of positions) {
      const pick = allPicks.find(p => p.symbol === position.symbol);

      // Check for target hit
      if (pick && position.currentPrice >= pick.ptLow) {
        signals.push({
          symbol: position.symbol,
          type: 'TARGET_HIT',
          message: `Target $${pick.ptLow} reached! Current: $${position.currentPrice.toFixed(2)}`,
          action: 'CONSIDER_EXIT',
          gain: position.unrealizedPLPct,
        });
      }

      // Check for big gain (>20%)
      if (position.unrealizedPLPct >= 20) {
        signals.push({
          symbol: position.symbol,
          type: 'BIG_GAIN',
          message: `+${position.unrealizedPLPct.toFixed(1)}% gain - consider taking profits`,
          action: 'CONSIDER_PARTIAL_EXIT',
          gain: position.unrealizedPLPct,
        });
      }

      // Check for significant loss (>15%)
      if (position.unrealizedPLPct <= -15) {
        signals.push({
          symbol: position.symbol,
          type: 'STOP_WARNING',
          message: `${position.unrealizedPLPct.toFixed(1)}% loss - review thesis`,
          action: 'REVIEW_POSITION',
          gain: position.unrealizedPLPct,
        });
      }
    }

    return signals;
  }

  /**
   * Execute trades based on opportunities
   */
  async executeTrades(opportunities, account) {
    const executions = [];

    if (!alpacaClient || !account) {
      return executions;
    }

    // Only execute strong buy signals
    const strongBuys = opportunities.filter(o => o.signal === 'STRONG_BUY');

    // Max 2 new positions per scan
    const toExecute = strongBuys.slice(0, 2);

    for (const trade of toExecute) {
      try {
        // Calculate position size
        const positionPct = trade.conviction === 'HIGH' ? 0.05 : 0.03;
        const positionValue = account.equity * positionPct;
        const shares = Math.floor(positionValue / trade.price);

        if (shares < 1) continue;

        // Check if we already have this position
        const existing = await alpacaClient.getPosition(trade.symbol);
        if (existing) continue;

        // Execute
        const order = await alpacaClient.buyStock(trade.symbol, shares);

        if (order && order.id) {
          executions.push({
            symbol: trade.symbol,
            shares,
            price: trade.price,
            value: shares * trade.price,
            orderId: order.id,
            thesis: trade.thesis,
            upside: trade.upside,
          });

          // Send trade alert
          await discord.tradeExecution(
            `🟢 **BUY EXECUTED**\n` +
            `**${trade.symbol}**: ${shares} shares @ $${trade.price.toFixed(2)}\n` +
            `Position: $${(shares * trade.price).toFixed(2)}\n` +
            `Thesis: ${trade.thesis}\n` +
            `Upside: ${trade.upside.toFixed(1)}%`
          );
        }
      } catch (error) {
        console.error(`Failed to execute ${trade.symbol}:`, error.message);
      }
    }

    return executions;
  }

  /**
   * Fetch quote from Yahoo Finance
   */
  async fetchQuote(symbol) {
    return new Promise((resolve) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;

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

  /**
   * Send report to Discord
   */
  async sendReport(report) {
    let message = `${this.emoji} **SWING SCAN** - ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET\n\n`;

    // Account status
    if (report.account) {
      message += `**Account:** $${report.account.equity.toFixed(2)} equity | $${report.account.cash.toFixed(2)} cash\n\n`;
    }

    // Executions (most important)
    if (report.executions.length > 0) {
      message += '**✅ TRADES EXECUTED:**\n';
      for (const exec of report.executions) {
        message += `• ${exec.symbol}: ${exec.shares} shares @ $${exec.price.toFixed(2)} (${exec.upside.toFixed(1)}% upside)\n`;
      }
      message += '\n';
    }

    // Entry opportunities
    if (report.opportunities.length > 0) {
      message += '**🎯 ENTRY OPPORTUNITIES:**\n';
      for (const opp of report.opportunities.slice(0, 5)) {
        const emoji = opp.signal === 'STRONG_BUY' ? '🟢' : '🟡';
        message += `${emoji} ${opp.symbol}: $${opp.price.toFixed(2)} (${opp.distanceFromEntry >= 0 ? '+' : ''}${opp.distanceFromEntry.toFixed(1)}% from entry) → ${opp.upside.toFixed(1)}% upside\n`;
      }
      message += '\n';
    }

    // Position signals
    if (report.signals.length > 0) {
      message += '**⚠️ POSITION SIGNALS:**\n';
      for (const signal of report.signals) {
        const emoji = signal.type === 'TARGET_HIT' ? '🎉' : signal.type === 'BIG_GAIN' ? '💰' : '⚠️';
        message += `${emoji} ${signal.symbol}: ${signal.message}\n`;
      }
      message += '\n';
    }

    // Positions summary
    if (report.positions.length > 0) {
      message += '**Current Positions:**\n';
      for (const pos of report.positions) {
        const emoji = pos.unrealizedPLPct >= 0 ? '🟢' : '🔴';
        message += `${emoji} ${pos.symbol}: ${pos.qty} @ $${pos.avgEntry.toFixed(2)} → $${pos.currentPrice.toFixed(2)} (${pos.unrealizedPLPct >= 0 ? '+' : ''}${pos.unrealizedPLPct.toFixed(1)}%)\n`;
      }
      message += '\n';
    }

    // Quiet scan
    if (report.executions.length === 0 && report.opportunities.length === 0 && report.signals.length === 0) {
      message += '_No actionable signals this scan._\n';
    }

    await discord.swingScanner(message);
  }
}

module.exports = SwingScannerAgent;
