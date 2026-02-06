/**
 * After Hours Analyst Agent
 *
 * Runs once at 4:30 PM ET after market close
 *
 * Tasks:
 * - Daily performance review
 * - Deep analysis of positions
 * - Earnings review
 * - Next day preparation
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const discord = require('../discord_channels');

// Import Alpaca client
let alpacaClient;
try {
  alpacaClient = require('../../swing_options/alpaca_client');
} catch (e) {
  console.warn('Alpaca client not available:', e.message);
}

class AfterHoursAgent {
  constructor() {
    this.name = 'After Hours Analyst';
    this.emoji = '🔬';
    this.lastRun = null;
    this.dataDir = config.paths.dataDir;
  }

  /**
   * Main run function
   */
  async run() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${this.emoji} After Hours Analyst starting...`);

    const report = {
      timestamp: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0],
      dailySummary: null,
      positionAnalysis: [],
      marketRecap: null,
      sectorPerformance: [],
      earningsTonight: [],
      tomorrowSetup: null,
      errors: [],
    };

    try {
      // 1. Daily performance summary
      report.dailySummary = await this.getDailySummary();

      // 2. Deep position analysis
      report.positionAnalysis = await this.analyzePositions();

      // 3. Market recap
      report.marketRecap = await this.getMarketRecap();

      // 4. Sector performance
      report.sectorPerformance = await this.getSectorPerformance();

      // 5. Tonight's earnings
      report.earningsTonight = await this.getEarningsTonight();

      // 6. Tomorrow setup
      report.tomorrowSetup = await this.prepareTomorrowSetup(report);

    } catch (error) {
      report.errors.push(error.message);
      console.error('After Hours Analyst error:', error);
    }

    // Send comprehensive report to Discord
    await this.sendReport(report);

    // Save daily report
    await this.saveDailyReport(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} After Hours Analyst completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Get daily performance summary
   */
  async getDailySummary() {
    if (!alpacaClient) return null;

    try {
      const account = await alpacaClient.getAccount();
      const positions = await alpacaClient.getPositions();

      const equity = parseFloat(account.portfolio_value);
      const lastEquity = parseFloat(account.last_equity);
      const dailyPL = equity - lastEquity;
      const dailyPLPct = (dailyPL / lastEquity) * 100;

      // Calculate position-level P&L
      let winners = 0;
      let losers = 0;
      let biggestWinner = null;
      let biggestLoser = null;

      for (const pos of positions) {
        const plPct = parseFloat(pos.unrealized_plpc) * 100;
        if (plPct >= 0) {
          winners++;
          if (!biggestWinner || plPct > biggestWinner.pct) {
            biggestWinner = { symbol: pos.symbol, pct: plPct };
          }
        } else {
          losers++;
          if (!biggestLoser || plPct < biggestLoser.pct) {
            biggestLoser = { symbol: pos.symbol, pct: plPct };
          }
        }
      }

      return {
        equity,
        dailyPL,
        dailyPLPct,
        positionCount: positions.length,
        winners,
        losers,
        biggestWinner,
        biggestLoser,
        cash: parseFloat(account.cash),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Deep analysis of each position
   */
  async analyzePositions() {
    if (!alpacaClient) return [];

    try {
      const positions = await alpacaClient.getPositions();
      const analysis = [];

      // Load watchlist for thesis/targets
      const watchlistPath = config.paths.watchlistFile;
      let watchlist = { dickCapital: [], independent: [] };
      if (fs.existsSync(watchlistPath)) {
        watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
      }
      const allPicks = [...(watchlist.dickCapital || []), ...(watchlist.independent || [])];

      for (const pos of positions) {
        const symbol = pos.symbol;
        const pick = allPicks.find(p => p.symbol === symbol);
        const quote = await this.fetchQuote(symbol);

        const posAnalysis = {
          symbol,
          qty: parseFloat(pos.qty),
          avgEntry: parseFloat(pos.avg_entry_price),
          currentPrice: parseFloat(pos.current_price),
          unrealizedPL: parseFloat(pos.unrealized_pl),
          unrealizedPLPct: parseFloat(pos.unrealized_plpc) * 100,
          marketValue: parseFloat(pos.market_value),
          thesis: pick?.thesis || 'N/A',
          ptLow: pick?.ptLow,
          ptHigh: pick?.ptHigh,
          daysHeld: null, // Would calculate from trade history
          recommendation: '',
        };

        // Generate recommendation
        if (pick) {
          const distanceToTarget = ((pick.ptLow - posAnalysis.currentPrice) / posAnalysis.currentPrice) * 100;

          if (posAnalysis.currentPrice >= pick.ptLow) {
            posAnalysis.recommendation = '🎯 TARGET HIT - Consider taking profits';
          } else if (posAnalysis.unrealizedPLPct >= 20) {
            posAnalysis.recommendation = '💰 Strong gain - Consider partial exit';
          } else if (posAnalysis.unrealizedPLPct <= -15) {
            posAnalysis.recommendation = '⚠️ Review thesis - Significant drawdown';
          } else if (distanceToTarget < 10) {
            posAnalysis.recommendation = '👀 Approaching target - Watch closely';
          } else {
            posAnalysis.recommendation = '✅ Hold - Thesis intact';
          }

          posAnalysis.distanceToTarget = distanceToTarget;
        }

        analysis.push(posAnalysis);
      }

      return analysis;
    } catch (e) {
      return [];
    }
  }

  /**
   * Get market recap
   */
  async getMarketRecap() {
    const indices = {
      'SPY': 'S&P 500',
      'QQQ': 'NASDAQ',
      'IWM': 'Russell 2000',
      'DIA': 'Dow Jones',
    };

    const recap = {};

    for (const [symbol, name] of Object.entries(indices)) {
      const quote = await this.fetchQuote(symbol);
      if (quote) {
        recap[name] = {
          price: quote.price,
          change: quote.changePercent,
          direction: quote.changePercent >= 0 ? 'up' : 'down',
        };
      }
    }

    // Determine market sentiment
    const avgChange = Object.values(recap).reduce((sum, r) => sum + r.change, 0) / Object.keys(recap).length;
    recap.sentiment = avgChange > 0.5 ? 'BULLISH' : avgChange < -0.5 ? 'BEARISH' : 'NEUTRAL';

    return recap;
  }

  /**
   * Get sector performance
   */
  async getSectorPerformance() {
    const sectorETFs = {
      'XLK': 'Technology',
      'XLF': 'Financials',
      'XLE': 'Energy',
      'XLV': 'Healthcare',
      'XLI': 'Industrials',
      'XLC': 'Communications',
      'XLY': 'Consumer Discretionary',
      'XLP': 'Consumer Staples',
      'XLU': 'Utilities',
      'XLB': 'Materials',
      'XLRE': 'Real Estate',
    };

    const sectors = [];

    for (const [symbol, name] of Object.entries(sectorETFs)) {
      const quote = await this.fetchQuote(symbol);
      if (quote) {
        sectors.push({
          name,
          symbol,
          change: quote.changePercent,
        });
      }
    }

    // Sort by performance
    sectors.sort((a, b) => b.change - a.change);

    return sectors;
  }

  /**
   * Get tonight's earnings (placeholder - would integrate with earnings API)
   */
  async getEarningsTonight() {
    // This would integrate with an earnings calendar API
    return [];
  }

  /**
   * Prepare tomorrow's setup
   */
  async prepareTomorrowSetup(report) {
    const setup = {
      marketBias: report.marketRecap?.sentiment || 'NEUTRAL',
      focusSymbols: [],
      keyLevels: [],
      watchFor: [],
    };

    // Add positions approaching targets
    for (const pos of report.positionAnalysis) {
      if (pos.distanceToTarget && pos.distanceToTarget < 15) {
        setup.focusSymbols.push({
          symbol: pos.symbol,
          reason: `${pos.distanceToTarget.toFixed(1)}% from target`,
        });
      }
    }

    // Add strong/weak sectors to watch
    if (report.sectorPerformance.length > 0) {
      setup.watchFor.push(`Strong: ${report.sectorPerformance[0].name}`);
      setup.watchFor.push(`Weak: ${report.sectorPerformance[report.sectorPerformance.length - 1].name}`);
    }

    return setup;
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
   * Save daily report to file
   */
  async saveDailyReport(report) {
    const reportsDir = path.join(this.dataDir, 'daily_reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const filename = `${report.date}_after_hours.json`;
    fs.writeFileSync(path.join(reportsDir, filename), JSON.stringify(report, null, 2));
  }

  /**
   * Send comprehensive report to Discord
   */
  async sendReport(report) {
    // Part 1: Daily Summary
    let summary = `${this.emoji} **AFTER HOURS ANALYSIS** - ${report.date}\n\n`;

    if (report.dailySummary) {
      const ds = report.dailySummary;
      const emoji = ds.dailyPL >= 0 ? '🟢' : '🔴';
      summary += `**📊 DAILY PERFORMANCE:**\n`;
      summary += `${emoji} P&L: ${ds.dailyPL >= 0 ? '+' : ''}$${ds.dailyPL.toFixed(2)} (${ds.dailyPLPct >= 0 ? '+' : ''}${ds.dailyPLPct.toFixed(2)}%)\n`;
      summary += `Portfolio: $${ds.equity.toFixed(2)} | Cash: $${ds.cash.toFixed(2)}\n`;
      summary += `Positions: ${ds.positionCount} (${ds.winners}W / ${ds.losers}L)\n`;
      if (ds.biggestWinner) summary += `Best: ${ds.biggestWinner.symbol} +${ds.biggestWinner.pct.toFixed(1)}%\n`;
      if (ds.biggestLoser) summary += `Worst: ${ds.biggestLoser.symbol} ${ds.biggestLoser.pct.toFixed(1)}%\n`;
      summary += '\n';
    }

    await discord.afterHours(summary);

    // Part 2: Market Recap
    if (report.marketRecap) {
      let market = `**📈 MARKET RECAP:**\n`;
      for (const [name, data] of Object.entries(report.marketRecap)) {
        if (name === 'sentiment') continue;
        const emoji = data.direction === 'up' ? '🟢' : '🔴';
        market += `${emoji} ${name}: ${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%\n`;
      }
      market += `Overall: ${report.marketRecap.sentiment}\n\n`;

      // Sectors
      if (report.sectorPerformance.length > 0) {
        market += `**Sector Leaders:**\n`;
        for (const sector of report.sectorPerformance.slice(0, 3)) {
          market += `🟢 ${sector.name}: +${sector.change.toFixed(2)}%\n`;
        }
        market += `**Sector Laggards:**\n`;
        for (const sector of report.sectorPerformance.slice(-3).reverse()) {
          market += `🔴 ${sector.name}: ${sector.change.toFixed(2)}%\n`;
        }
      }

      await discord.afterHours(market);
    }

    // Part 3: Position Analysis
    if (report.positionAnalysis.length > 0) {
      let positions = `**🔍 POSITION ANALYSIS:**\n\n`;
      for (const pos of report.positionAnalysis) {
        const emoji = pos.unrealizedPLPct >= 0 ? '🟢' : '🔴';
        positions += `**${pos.symbol}** ${emoji} ${pos.unrealizedPLPct >= 0 ? '+' : ''}${pos.unrealizedPLPct.toFixed(1)}%\n`;
        positions += `Entry: $${pos.avgEntry.toFixed(2)} → Now: $${pos.currentPrice.toFixed(2)}\n`;
        if (pos.ptLow) positions += `Target: $${pos.ptLow} (${pos.distanceToTarget?.toFixed(1)}% away)\n`;
        positions += `${pos.recommendation}\n\n`;
      }

      await discord.afterHours(positions);
    }

    // Part 4: Tomorrow Setup
    if (report.tomorrowSetup) {
      let tomorrow = `**📋 TOMORROW SETUP:**\n`;
      tomorrow += `Market Bias: ${report.tomorrowSetup.marketBias}\n`;

      if (report.tomorrowSetup.focusSymbols.length > 0) {
        tomorrow += `\n**Focus:**\n`;
        for (const focus of report.tomorrowSetup.focusSymbols) {
          tomorrow += `• ${focus.symbol}: ${focus.reason}\n`;
        }
      }

      if (report.tomorrowSetup.watchFor.length > 0) {
        tomorrow += `\n**Watch:**\n`;
        for (const watch of report.tomorrowSetup.watchFor) {
          tomorrow += `• ${watch}\n`;
        }
      }

      await discord.afterHours(tomorrow);
    }

    // Send P&L update to dedicated channel
    if (report.dailySummary) {
      await discord.pnl(
        `**Daily P&L - ${report.date}**\n` +
        `${report.dailySummary.dailyPL >= 0 ? '🟢' : '🔴'} ${report.dailySummary.dailyPL >= 0 ? '+' : ''}$${report.dailySummary.dailyPL.toFixed(2)} (${report.dailySummary.dailyPLPct.toFixed(2)}%)\n` +
        `Portfolio: $${report.dailySummary.equity.toFixed(2)}`
      );
    }
  }
}

module.exports = AfterHoursAgent;
