/**
 * Overnight Watcher Agent
 *
 * Runs 8:00 PM - 7:00 AM ET every hour
 *
 * Tasks:
 * - Monitor futures
 * - Scan global markets (Asia, Europe)
 * - Check breaking news
 * - Alert on significant overnight moves
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const discord = require('../discord_channels');
const brain = require('../shared_brain');

class OvernightAgent {
  constructor() {
    this.name = 'Overnight Watcher';
    this.emoji = '🌙';
    this.lastRun = null;
    this.dataDir = config.paths.dataDir;
    this.lastFuturesState = null;
  }

  /**
   * Main run function
   */
  async run() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Overnight Watcher starting...`);

    const report = {
      timestamp: new Date().toISOString(),
      futures: null,
      globalMarkets: null,
      cryptoMarkets: null,
      significantMoves: [],
      alerts: [],
      errors: [],
    };

    try {
      // 1. Check US futures
      report.futures = await this.checkFutures();

      // 2. Check global markets
      report.globalMarkets = await this.checkGlobalMarkets();

      // 3. Check crypto (often leads risk sentiment)
      report.cryptoMarkets = await this.checkCrypto();

      // 4. Detect significant moves
      report.significantMoves = this.detectSignificantMoves(report);

      // 5. Compare to last state and generate alerts
      report.alerts = this.generateAlerts(report);

    } catch (error) {
      report.errors.push(error.message);
      console.error('Overnight Watcher error:', error);
    }

    // Write to shared brain
    const riskSentiment = report.significantMoves.length > 0
      ? (report.significantMoves.filter(m => m.change < 0).length > report.significantMoves.length / 2 ? 'RISK_OFF' : 'RISK_ON')
      : 'NEUTRAL';
    brain.writeOvernight({
      futures: report.futures || {},
      globalMarkets: report.globalMarkets || {},
      crypto: report.cryptoMarkets || {},
      significantMoves: report.significantMoves,
      riskSentiment,
    });

    // Always send report so channel stays updated
    await this.sendReport(report);

    // Save state for comparison
    this.lastFuturesState = report.futures;

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Overnight Watcher completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Check US futures
   */
  async checkFutures() {
    const futures = {};

    const symbols = {
      'ES=F': { name: 'S&P 500', threshold: 0.5 },
      'NQ=F': { name: 'NASDAQ', threshold: 0.7 },
      'YM=F': { name: 'Dow Jones', threshold: 0.5 },
      'RTY=F': { name: 'Russell 2000', threshold: 0.7 },
      'CL=F': { name: 'Crude Oil', threshold: 2.0 },
      'GC=F': { name: 'Gold', threshold: 1.0 },
      'ZB=F': { name: '30Y Bonds', threshold: 0.5 },
    };

    for (const [symbol, info] of Object.entries(symbols)) {
      const quote = await this.fetchQuote(symbol);
      if (quote) {
        futures[info.name] = {
          price: quote.price,
          change: quote.changePercent,
          threshold: info.threshold,
          significant: Math.abs(quote.changePercent) >= info.threshold,
        };
      }
    }

    return futures;
  }

  /**
   * Check global markets
   */
  async checkGlobalMarkets() {
    const markets = {};

    const indices = {
      // Asia
      '^N225': { name: 'Nikkei (Japan)', region: 'Asia' },
      '^HSI': { name: 'Hang Seng (HK)', region: 'Asia' },
      '000001.SS': { name: 'Shanghai (China)', region: 'Asia' },

      // Europe
      '^FTSE': { name: 'FTSE 100 (UK)', region: 'Europe' },
      '^GDAXI': { name: 'DAX (Germany)', region: 'Europe' },
      '^FCHI': { name: 'CAC 40 (France)', region: 'Europe' },
    };

    for (const [symbol, info] of Object.entries(indices)) {
      const quote = await this.fetchQuote(symbol);
      if (quote) {
        if (!markets[info.region]) markets[info.region] = [];
        markets[info.region].push({
          name: info.name,
          price: quote.price,
          change: quote.changePercent,
        });
      }
    }

    return markets;
  }

  /**
   * Check crypto markets
   */
  async checkCrypto() {
    const crypto = {};

    const symbols = {
      'BTC-USD': 'Bitcoin',
      'ETH-USD': 'Ethereum',
    };

    for (const [symbol, name] of Object.entries(symbols)) {
      const quote = await this.fetchQuote(symbol);
      if (quote) {
        crypto[name] = {
          price: quote.price,
          change: quote.changePercent,
        };
      }
    }

    return crypto;
  }

  /**
   * Detect significant moves
   */
  detectSignificantMoves(report) {
    const moves = [];

    // Check futures
    if (report.futures) {
      for (const [name, data] of Object.entries(report.futures)) {
        if (data.significant) {
          moves.push({
            market: name,
            change: data.change,
            type: 'FUTURES',
            severity: Math.abs(data.change) >= data.threshold * 2 ? 'HIGH' : 'MEDIUM',
          });
        }
      }
    }

    // Check global markets for big moves (>1.5%)
    if (report.globalMarkets) {
      for (const [region, markets] of Object.entries(report.globalMarkets)) {
        for (const market of markets) {
          if (Math.abs(market.change) >= 1.5) {
            moves.push({
              market: market.name,
              change: market.change,
              type: region.toUpperCase(),
              severity: Math.abs(market.change) >= 3 ? 'HIGH' : 'MEDIUM',
            });
          }
        }
      }
    }

    // Check crypto for big moves (>5%)
    if (report.cryptoMarkets) {
      for (const [name, data] of Object.entries(report.cryptoMarkets)) {
        if (Math.abs(data.change) >= 5) {
          moves.push({
            market: name,
            change: data.change,
            type: 'CRYPTO',
            severity: Math.abs(data.change) >= 10 ? 'HIGH' : 'MEDIUM',
          });
        }
      }
    }

    return moves;
  }

  /**
   * Generate alerts based on state changes
   */
  generateAlerts(report) {
    const alerts = [];

    // Check for sudden futures moves since last check
    if (this.lastFuturesState && report.futures) {
      for (const [name, current] of Object.entries(report.futures)) {
        const previous = this.lastFuturesState[name];
        if (previous) {
          const changeSinceLastCheck = current.change - previous.change;
          if (Math.abs(changeSinceLastCheck) >= 0.5) {
            alerts.push({
              type: 'FUTURES_MOVE',
              market: name,
              message: `${name} moved ${changeSinceLastCheck >= 0 ? '+' : ''}${changeSinceLastCheck.toFixed(2)}% in the last hour`,
              severity: Math.abs(changeSinceLastCheck) >= 1 ? 'HIGH' : 'MEDIUM',
            });
          }
        }
      }
    }

    return alerts;
  }

  /**
   * Fetch quote
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
              const prevClose = meta.previousClose || meta.chartPreviousClose;
              resolve({
                symbol,
                price: meta.regularMarketPrice,
                changePercent: prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose * 100) : 0,
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
    let message = `${this.emoji} **OVERNIGHT UPDATE** - ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET\n\n`;

    // Alerts first (most important)
    if (report.alerts.length > 0) {
      message += '**🚨 ALERTS:**\n';
      for (const alert of report.alerts) {
        const emoji = alert.severity === 'HIGH' ? '🔴' : '🟡';
        message += `${emoji} ${alert.message}\n`;
      }
      message += '\n';
    }

    // Significant moves
    if (report.significantMoves.length > 0) {
      message += '**📊 SIGNIFICANT MOVES:**\n';
      for (const move of report.significantMoves) {
        const emoji = move.change >= 0 ? '🟢' : '🔴';
        message += `${emoji} ${move.market}: ${move.change >= 0 ? '+' : ''}${move.change.toFixed(2)}%\n`;
      }
      message += '\n';
    }

    // Futures summary
    if (report.futures) {
      message += '**Futures:**\n';
      for (const [name, data] of Object.entries(report.futures)) {
        if (['S&P 500', 'NASDAQ', 'Dow Jones'].includes(name)) {
          const emoji = data.change >= 0 ? '🟢' : '🔴';
          message += `${emoji} ${name}: ${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%\n`;
        }
      }
      message += '\n';
    }

    // Crypto
    if (report.cryptoMarkets) {
      message += '**Crypto:**\n';
      for (const [name, data] of Object.entries(report.cryptoMarkets)) {
        const emoji = data.change >= 0 ? '🟢' : '🔴';
        message += `${emoji} ${name}: $${data.price.toLocaleString()} (${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%)\n`;
      }
    }

    // Quiet state
    if (report.significantMoves.length === 0 && report.alerts.length === 0) {
      message += '\n_Markets quiet. No significant moves._\n';
    }

    await discord.overnight(message);

    // Send high severity alerts to main alerts channel too
    for (const alert of report.alerts.filter(a => a.severity === 'HIGH')) {
      await discord.alert(`🚨 **OVERNIGHT ALERT**\n${alert.message}`);
    }
  }
}

module.exports = OvernightAgent;
