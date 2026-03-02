/**
 * Pre-Market Agent
 *
 * Runs 7:00 AM - 9:30 AM ET every 15 minutes
 *
 * Tasks:
 * - Scan pre-market movers
 * - Check overnight news
 * - Analyze futures
 * - Prepare watchlist for the day
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const discord = require('../discord_channels');
const brain = require('../shared_brain');

class PreMarketAgent {
  constructor() {
    this.name = 'Pre-Market Agent';
    this.emoji = '🌅';
    this.lastRun = null;
    this.dataDir = config.paths.dataDir;
  }

  /**
   * Main run function
   */
  async run() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Pre-Market Agent starting...`);

    const report = {
      timestamp: new Date().toISOString(),
      futures: null,
      preMarketMovers: [],
      newsHighlights: [],
      watchlistUpdates: [],
      errors: [],
    };

    try {
      // 1. Check futures
      report.futures = await this.checkFutures();

      // 2. Scan pre-market movers
      report.preMarketMovers = await this.scanPreMarketMovers();

      // 3. Check overnight news for watchlist
      report.newsHighlights = await this.checkNews();

      // 4. Update watchlist based on findings
      report.watchlistUpdates = await this.updateWatchlist(report);

    } catch (error) {
      report.errors.push(error.message);
      console.error('Pre-market agent error:', error);
    }

    // Write to shared brain
    brain.writePreMarket({
      futures: report.futures || {},
      gappers: report.preMarketMovers.filter(m => Math.abs(m.change) >= 3).map(m => ({
        symbol: m.symbol, change: m.change, direction: m.direction,
      })),
      movers: report.preMarketMovers.map(m => ({
        symbol: m.symbol, price: m.price, change: m.change,
      })),
      watchlistAlerts: report.watchlistUpdates,
    });

    // Add significant movers to day watchlist
    for (const mover of report.preMarketMovers.filter(m => Math.abs(m.change) >= 5)) {
      brain.addToWatchlist({
        symbol: mover.symbol,
        reason: `Pre-market ${mover.direction} ${mover.change.toFixed(1)}%`,
        source: 'pre-market',
        conviction: Math.abs(mover.change) >= 10 ? 'HIGH' : 'MEDIUM',
      });
    }

    // Send report to Discord
    await this.sendReport(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Pre-Market Agent completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Check futures (ES, NQ, YM)
   */
  async checkFutures() {
    const futures = {};

    // Using Yahoo Finance for futures data
    const symbols = {
      'ES=F': 'S&P 500',
      'NQ=F': 'NASDAQ',
      'YM=F': 'Dow Jones',
      'RTY=F': 'Russell 2000',
    };

    for (const [symbol, name] of Object.entries(symbols)) {
      const quote = await this.fetchQuote(symbol);
      if (quote) {
        futures[name] = {
          price: quote.price,
          change: quote.changePercent,
          direction: quote.changePercent >= 0 ? 'up' : 'down',
        };
      }
    }

    return futures;
  }

  /**
   * Scan for pre-market movers
   */
  async scanPreMarketMovers() {
    const movers = [];

    // Scan our watchlist symbols
    const watchlistPath = config.paths.watchlistFile;
    let watchlist = { dickCapital: [], independent: [] };

    if (fs.existsSync(watchlistPath)) {
      watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    }

    const allSymbols = [
      ...watchlist.dickCapital.map(p => p.symbol),
      ...watchlist.independent.map(p => p.symbol),
      ...(watchlist.positions || []).map(p => p.symbol),
    ];

    for (const symbol of allSymbols) {
      const quote = await this.fetchQuote(symbol);
      if (quote && Math.abs(quote.changePercent) >= 2) {
        movers.push({
          symbol,
          price: quote.price,
          change: quote.changePercent,
          volume: quote.volume,
          direction: quote.changePercent >= 0 ? 'UP' : 'DOWN',
        });
      }
    }

    // Sort by absolute change
    movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return movers.slice(0, 10);
  }

  /**
   * Check news for watchlist stocks
   */
  async checkNews() {
    // This would integrate with news API
    // For now, return placeholder
    return [
      { type: 'placeholder', message: 'News integration pending' },
    ];
  }

  /**
   * Update watchlist based on pre-market findings
   */
  async updateWatchlist(report) {
    const updates = [];

    // Check if any watchlist stocks are gapping
    for (const mover of report.preMarketMovers) {
      if (Math.abs(mover.change) >= 5) {
        updates.push({
          symbol: mover.symbol,
          action: mover.change > 0 ? 'GAP_UP' : 'GAP_DOWN',
          change: mover.change,
          note: `Pre-market ${mover.change > 0 ? 'gap up' : 'gap down'} of ${mover.change.toFixed(1)}%`,
        });
      }
    }

    return updates;
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
                previousClose: meta.previousClose || meta.chartPreviousClose,
                changePercent: ((meta.regularMarketPrice - (meta.previousClose || meta.chartPreviousClose)) / (meta.previousClose || meta.chartPreviousClose) * 100),
                volume: meta.regularMarketVolume,
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
    let message = `${this.emoji} **PRE-MARKET REPORT** - ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET\n\n`;

    // Futures
    if (report.futures && Object.keys(report.futures).length > 0) {
      message += '**Futures:**\n';
      for (const [name, data] of Object.entries(report.futures)) {
        const emoji = data.direction === 'up' ? '🟢' : '🔴';
        message += `${emoji} ${name}: ${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%\n`;
      }
      message += '\n';
    }

    // Pre-market movers
    if (report.preMarketMovers.length > 0) {
      message += '**Pre-Market Movers (Watchlist):**\n';
      for (const mover of report.preMarketMovers.slice(0, 5)) {
        const emoji = mover.direction === 'UP' ? '🟢' : '🔴';
        message += `${emoji} ${mover.symbol}: ${mover.change >= 0 ? '+' : ''}${mover.change.toFixed(1)}% @ $${mover.price.toFixed(2)}\n`;
      }
      message += '\n';
    }

    // Watchlist updates
    if (report.watchlistUpdates.length > 0) {
      message += '**⚠️ Watchlist Alerts:**\n';
      for (const update of report.watchlistUpdates) {
        message += `• ${update.symbol}: ${update.note}\n`;
      }
      message += '\n';
    }

    // No significant activity
    if (report.preMarketMovers.length === 0 && report.watchlistUpdates.length === 0) {
      message += '_No significant pre-market activity on watchlist._\n';
    }

    await discord.preMarket(message);
  }
}

module.exports = PreMarketAgent;
