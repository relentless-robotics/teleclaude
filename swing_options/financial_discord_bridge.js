/**
 * Financial Agent Discord Bridge
 *
 * Connects the hourly financial agent to Discord notifications.
 * This version runs WITH the main Claude bridge and can send Discord messages directly.
 *
 * Usage: Called from the main bridge, not standalone.
 */

const path = require('path');
const fs = require('fs');

// Import the financial agent
const {
  scheduler,
  runHourlyScan,
  loadWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  addPosition,
  removePosition,
  formatDiscordReport,
} = require('./hourly_financial_agent.js');

class FinancialDiscordBridge {
  constructor() {
    this.sendToDiscord = null;
    this.isInitialized = false;
    this.scanInterval = null;
    this.lastScanTime = null;
  }

  /**
   * Initialize with Discord send function
   */
  init(sendToDiscordFn) {
    this.sendToDiscord = sendToDiscordFn;
    this.isInitialized = true;
    console.log('[FinancialBridge] Initialized with Discord connection');
  }

  /**
   * Start hourly scanning
   */
  async start() {
    if (!this.isInitialized) {
      console.error('[FinancialBridge] Not initialized! Call init() first.');
      return false;
    }

    console.log('[FinancialBridge] Starting hourly financial scans...');

    // Set the send function in scheduler
    scheduler.setSendFunction(this.sendToDiscord);

    // Notify Discord
    await this.sendToDiscord(
      '📊 **Hourly Financial Agent Started**\n\n' +
      'Scanning watchlist every hour for:\n' +
      '• Entry opportunities (price at/below targets)\n' +
      '• Exit signals (targets hit, stop losses)\n' +
      '• Big moves (>5% daily moves)\n' +
      '• Upcoming catalysts (earnings, events)\n\n' +
      '_First scan running now..._'
    );

    // Start the scheduler
    await scheduler.start();

    return true;
  }

  /**
   * Stop scanning
   */
  stop() {
    scheduler.stop();
    if (this.sendToDiscord) {
      this.sendToDiscord('🛑 Hourly Financial Agent stopped');
    }
  }

  /**
   * Force an immediate scan
   */
  async scanNow() {
    if (!this.isInitialized) {
      console.error('[FinancialBridge] Not initialized!');
      return null;
    }

    return await runHourlyScan(this.sendToDiscord);
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      ...scheduler.getStatus(),
      watchlist: this.getWatchlistSummary(),
    };
  }

  /**
   * Get watchlist summary
   */
  getWatchlistSummary() {
    const wl = loadWatchlist();
    return {
      dickCapitalPicks: wl.dickCapital?.length || 0,
      independentPicks: wl.independent?.length || 0,
      activePositions: wl.positions?.length || 0,
      total: (wl.dickCapital?.length || 0) + (wl.independent?.length || 0),
    };
  }

  /**
   * Add a stock to watchlist
   */
  addWatch(category, symbol, entryTarget, thesis, ptLow, ptHigh) {
    return addToWatchlist(category, {
      symbol: symbol.toUpperCase(),
      entryTarget: parseFloat(entryTarget),
      thesis,
      ptLow: parseFloat(ptLow),
      ptHigh: parseFloat(ptHigh || ptLow),
    });
  }

  /**
   * Remove from watchlist
   */
  removeWatch(category, symbol) {
    return removeFromWatchlist(category, symbol.toUpperCase());
  }

  /**
   * Add a position to monitor
   */
  addActivePosition(symbol, entry, targetPrice, stopLoss = null) {
    addPosition({
      symbol: symbol.toUpperCase(),
      entry: parseFloat(entry),
      targetPrice: parseFloat(targetPrice),
      stopLoss: stopLoss ? parseFloat(stopLoss) : null,
    });
  }

  /**
   * Remove a position
   */
  closePosition(symbol) {
    removePosition(symbol.toUpperCase());
  }

  /**
   * Get full watchlist
   */
  getWatchlist() {
    return loadWatchlist();
  }

  /**
   * Format watchlist for Discord
   */
  formatWatchlistForDiscord() {
    const wl = loadWatchlist();
    let msg = '**📋 CURRENT WATCHLIST**\n\n';

    msg += '**Dick Capital Picks:**\n';
    wl.dickCapital?.forEach(p => {
      msg += `• ${p.symbol}: Entry $${p.entryTarget} → PT $${p.ptLow}-${p.ptHigh}\n`;
    });

    msg += '\n**Independent Research:**\n';
    wl.independent?.forEach(p => {
      msg += `• ${p.symbol}: Entry $${p.entryTarget} → PT $${p.ptLow}-${p.ptHigh}\n`;
    });

    if (wl.positions?.length > 0) {
      msg += '\n**Active Positions:**\n';
      wl.positions.forEach(p => {
        msg += `• ${p.symbol}: Entry $${p.entry} → Target $${p.targetPrice}`;
        if (p.stopLoss) msg += ` | Stop $${p.stopLoss}`;
        msg += '\n';
      });
    }

    return msg;
  }
}

// Singleton
const financialBridge = new FinancialDiscordBridge();

module.exports = {
  financialBridge,
  FinancialDiscordBridge,
};
