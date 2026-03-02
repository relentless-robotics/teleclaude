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

// Import Alpaca clients (BOTH accounts)
let alpacaClient;
try {
  alpacaClient = require('../../swing_options/alpaca_client');
} catch (e) {
  console.warn('Alpaca swing client not available:', e.message);
}

let daytradeClient;
try {
  daytradeClient = require('../../swing_options/daytrade_client');
} catch (e) {
  console.warn('Alpaca daytrade client not available:', e.message);
}

// Trade Journal (daily summary)
let journal;
try {
  journal = require('../trade_journal');
} catch (e) {
  console.warn('[AfterHours] Trade journal not available:', e.message);
}

// Shared brain for daily context
const brain = require('../shared_brain');

// LLM for lesson extraction
let reasoning;
try {
  reasoning = require('../../utils/llm_reasoning');
} catch (e) {}

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
      dayTradeSummary: null,
      positionAnalysis: [],
      marketRecap: null,
      sectorPerformance: [],
      earningsTonight: [],
      tomorrowSetup: null,
      dailyLessons: null,
      errors: [],
    };

    try {
      // 1. Swing account performance summary
      report.dailySummary = await this.getDailySummary();

      // 2. Day trade account performance summary
      report.dayTradeSummary = await this.getDayTradeSummary();

      // 3. Deep position analysis (swing positions)
      report.positionAnalysis = await this.analyzePositions();

      // 4. Market recap
      report.marketRecap = await this.getMarketRecap();

      // 5. Sector performance
      report.sectorPerformance = await this.getSectorPerformance();

      // 6. Tonight's earnings
      report.earningsTonight = await this.getEarningsTonight();

      // 7. LLM-powered daily lesson extraction
      report.dailyLessons = await this.extractDailyLessons(report);

      // 8. Tomorrow setup (uses all data including lessons)
      report.tomorrowSetup = await this.prepareTomorrowSetup(report);

    } catch (error) {
      report.errors.push(error.message);
      console.error('After Hours Analyst error:', error);
    }

    // Send comprehensive report to Discord
    await this.sendReport(report);

    // Post daily P&L summary from trade journal
    if (journal) {
      try {
        await journal.postDailySummary();
      } catch (e) { console.warn('[AfterHours] Journal daily summary error:', e.message); }
    }

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
   * Get day trade account performance summary
   */
  async getDayTradeSummary() {
    if (!daytradeClient) return null;

    try {
      const account = await daytradeClient.getAccount();
      const positions = await daytradeClient.getPositions();

      const equity = account.equity;
      const lastEquity = account.lastEquity || equity;
      const dailyPL = account.dailyPL || (equity - lastEquity);
      const dailyPLPct = lastEquity > 0 ? (dailyPL / lastEquity) * 100 : 0;

      // Get today's trades from shared brain
      const brainCtx = brain.ctx;
      const todayTrades = brainCtx.dayTrader?.trades || [];
      const todayReasoning = brainCtx.dayTrader?.reasoning || [];

      // Count wins/losses from trade lessons
      const lessonsFile = path.join(this.dataDir, 'trade_lessons.json');
      let todayLessons = [];
      try {
        if (fs.existsSync(lessonsFile)) {
          const data = JSON.parse(fs.readFileSync(lessonsFile, 'utf8'));
          const today = new Date().toISOString().split('T')[0];
          todayLessons = (data.lessons || []).filter(l => l.time?.startsWith(today));
        }
      } catch (e) {}

      const wins = todayLessons.filter(l => l.outcome === 'WIN');
      const losses = todayLessons.filter(l => l.outcome === 'LOSS');

      // Position details
      let posWinners = 0, posLosers = 0;
      let biggestWinner = null, biggestLoser = null;
      for (const pos of (positions || [])) {
        const plPct = parseFloat(pos.unrealized_plpc || 0) * 100;
        if (plPct >= 0) {
          posWinners++;
          if (!biggestWinner || plPct > biggestWinner.pct) {
            biggestWinner = { symbol: pos.symbol, pct: plPct };
          }
        } else {
          posLosers++;
          if (!biggestLoser || plPct < biggestLoser.pct) {
            biggestLoser = { symbol: pos.symbol, pct: plPct };
          }
        }
      }

      return {
        equity,
        dailyPL,
        dailyPLPct,
        cash: account.cash,
        buyingPower: account.buyingPower,
        positionCount: (positions || []).length,
        posWinners,
        posLosers,
        biggestWinner,
        biggestLoser,
        todayTradesCount: todayTrades.length,
        closedTradesCount: todayLessons.length,
        winsToday: wins.length,
        lossesToday: losses.length,
        winRate: wins.length + losses.length > 0
          ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(0) + '%'
          : 'N/A',
        reasoningCount: todayReasoning.length,
        todayLessons,
      };
    } catch (e) {
      console.warn('[AfterHours] Day trade summary error:', e.message);
      return null;
    }
  }

  /**
   * LLM-powered lesson extraction from the day's trading activity
   */
  async extractDailyLessons(report) {
    if (!reasoning) return null;

    try {
      const brainSummary = brain.getDailySummary();
      const perfContext = brain.getPerformanceContext();
      const recentHistory = brain.getRecentDailyHistory(5);

      // Build a comprehensive day summary for the LLM
      const dayData = {
        date: report.date,
        swingAccount: report.dailySummary ? {
          equity: report.dailySummary.equity,
          dailyPL: report.dailySummary.dailyPL,
          positions: report.dailySummary.positionCount,
        } : null,
        dayTradeAccount: report.dayTradeSummary ? {
          equity: report.dayTradeSummary.equity,
          dailyPL: report.dayTradeSummary.dailyPL,
          tradesExecuted: report.dayTradeSummary.todayTradesCount,
          tradesClosed: report.dayTradeSummary.closedTradesCount,
          wins: report.dayTradeSummary.winsToday,
          losses: report.dayTradeSummary.lossesToday,
          winRate: report.dayTradeSummary.winRate,
          lessons: (report.dayTradeSummary.todayLessons || []).map(l => ({
            symbol: l.symbol,
            outcome: l.outcome,
            plPct: l.plPct,
            reason: l.reason,
            rule: l.rule?.actionableRule,
          })),
        } : null,
        marketRegime: report.marketRecap?.sentiment || brainSummary.market?.regime,
        agentReasoningLog: Array.isArray(brainSummary.dayTrader?.reasoning) ? brainSummary.dayTrader.reasoning.slice(-10) : [],
        trades: Array.isArray(brainSummary.dayTrader?.trades) ? brainSummary.dayTrader.trades.map(t => ({
          symbol: t.symbol,
          underlying: t.underlying,
          action: t.action,
          direction: t.direction,
          reason: t.reason,
          conviction: t.conviction,
          time: t.time,
        })) : [],
        tradesCount: typeof brainSummary.dayTrader?.trades === 'number' ? brainSummary.dayTrader.trades : 0,
        recentDays: recentHistory,
        cumulativeStats: perfContext,
      };

      const prompt = `You are a trading coach reviewing today's performance. Analyze the data below and extract key lessons.

TODAY'S TRADING DATA:
${JSON.stringify(dayData, null, 2)}

Respond in JSON ONLY (no markdown):
{
  "overallGrade": "A" | "B" | "C" | "D" | "F",
  "gradingReason": "Brief explanation of grade",
  "keyLessons": [
    "Lesson 1 - specific and actionable",
    "Lesson 2 - specific and actionable"
  ],
  "patterns": {
    "goodPatterns": ["What worked well today"],
    "badPatterns": ["What to avoid tomorrow"]
  },
  "tomorrowRules": [
    "Rule 1 for tomorrow based on today's learning",
    "Rule 2 for tomorrow"
  ],
  "riskAssessment": "How well was risk managed today?",
  "emotionalCheck": "Any signs of revenge trading, FOMO, or discipline breakdown?"
}`;

      const result = await reasoning.callLLMWithFallback([
        { role: 'system', content: 'You are an expert trading coach. Give honest, specific feedback based on data. Be constructive but direct about mistakes.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.3, maxTokens: 1024 });

      // Parse response
      let parsed;
      try {
        parsed = JSON.parse(result.content);
      } catch (e) {
        const match = result.content.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }

      if (parsed) {
        console.log(`[AfterHours] LLM lesson extraction complete (Grade: ${parsed.overallGrade})`);
      }

      return parsed || null;
    } catch (e) {
      console.warn('[AfterHours] LLM lesson extraction failed:', e.message);
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
      if (quote && !isNaN(quote.changePercent)) {
        recap[name] = {
          price: quote.price,
          change: quote.changePercent || 0,
          direction: (quote.changePercent || 0) >= 0 ? 'up' : 'down',
        };
      }
    }

    // Determine market sentiment
    const recapValues = Object.values(recap).filter(r => !isNaN(r.change));
    const avgChange = recapValues.length > 0 ? recapValues.reduce((sum, r) => sum + r.change, 0) / recapValues.length : 0;
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
      if (quote && !isNaN(quote.changePercent)) {
        sectors.push({
          name,
          symbol,
          change: quote.changePercent || 0,
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
      tomorrowRules: [],
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

    // Add rules from LLM lesson extraction
    if (report.dailyLessons?.tomorrowRules) {
      setup.tomorrowRules = report.dailyLessons.tomorrowRules;
    }

    // Add bad patterns to avoid
    if (report.dailyLessons?.patterns?.badPatterns) {
      for (const pattern of report.dailyLessons.patterns.badPatterns) {
        setup.watchFor.push(`AVOID: ${pattern}`);
      }
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
    // Part 1: Daily Summary (Both Accounts)
    let summary = `${this.emoji} **AFTER HOURS ANALYSIS** - ${report.date}\n\n`;

    // Swing Account
    if (report.dailySummary) {
      const ds = report.dailySummary;
      const emoji = ds.dailyPL >= 0 ? '🟢' : '🔴';
      summary += `**📊 SWING ACCOUNT:**\n`;
      summary += `${emoji} P&L: ${ds.dailyPL >= 0 ? '+' : ''}$${ds.dailyPL.toFixed(2)} (${ds.dailyPLPct >= 0 ? '+' : ''}${ds.dailyPLPct.toFixed(2)}%)\n`;
      summary += `Portfolio: $${ds.equity.toFixed(2)} | Cash: $${ds.cash.toFixed(2)}\n`;
      summary += `Positions: ${ds.positionCount} (${ds.winners}W / ${ds.losers}L)\n`;
      if (ds.biggestWinner) summary += `Best: ${ds.biggestWinner.symbol} +${ds.biggestWinner.pct.toFixed(1)}%\n`;
      if (ds.biggestLoser) summary += `Worst: ${ds.biggestLoser.symbol} ${ds.biggestLoser.pct.toFixed(1)}%\n`;
      summary += '\n';
    }

    // Day Trade Account
    if (report.dayTradeSummary) {
      const dt = report.dayTradeSummary;
      const emoji = (dt.dailyPL || 0) >= 0 ? '🟢' : '🔴';
      summary += `**⚡ DAY TRADE ACCOUNT:**\n`;
      summary += `${emoji} P&L: ${(dt.dailyPL || 0) >= 0 ? '+' : ''}$${(dt.dailyPL || 0).toFixed(2)} (${(dt.dailyPLPct || 0).toFixed(2)}%)\n`;
      summary += `Portfolio: $${(dt.equity || 0).toLocaleString()} | Cash: $${(dt.cash || 0).toLocaleString()}\n`;
      summary += `Trades: ${dt.todayTradesCount || 0} executed | ${dt.closedTradesCount || 0} closed\n`;
      summary += `Win Rate: ${dt.winRate || 'N/A'} (${dt.winsToday || 0}W / ${dt.lossesToday || 0}L)\n`;
      summary += `LLM Reasoning Cycles: ${dt.reasoningCount || 0}\n`;
      if (dt.biggestWinner) summary += `Best: ${dt.biggestWinner.symbol} +${dt.biggestWinner.pct.toFixed(1)}%\n`;
      if (dt.biggestLoser) summary += `Worst: ${dt.biggestLoser.symbol} ${dt.biggestLoser.pct.toFixed(1)}%\n`;
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

    // Part 3: Position Analysis (swing)
    if (report.positionAnalysis.length > 0) {
      let positions = `**🔍 SWING POSITION ANALYSIS:**\n\n`;
      for (const pos of report.positionAnalysis) {
        const emoji = pos.unrealizedPLPct >= 0 ? '🟢' : '🔴';
        positions += `**${pos.symbol}** ${emoji} ${pos.unrealizedPLPct >= 0 ? '+' : ''}${pos.unrealizedPLPct.toFixed(1)}%\n`;
        positions += `Entry: $${pos.avgEntry.toFixed(2)} → Now: $${pos.currentPrice.toFixed(2)}\n`;
        if (pos.ptLow) positions += `Target: $${pos.ptLow} (${pos.distanceToTarget?.toFixed(1)}% away)\n`;
        positions += `${pos.recommendation}\n\n`;
      }

      await discord.afterHours(positions);
    }

    // Part 4: Daily Lessons (LLM Analysis)
    if (report.dailyLessons) {
      const dl = report.dailyLessons;
      let lessons = `**🎓 DAILY LESSONS (Grade: ${dl.overallGrade || '?'}):**\n`;
      lessons += `_${dl.gradingReason || 'No grading reason'}_\n\n`;

      if (dl.keyLessons?.length > 0) {
        lessons += `**Key Takeaways:**\n`;
        for (const lesson of dl.keyLessons) {
          lessons += `• ${lesson}\n`;
        }
        lessons += '\n';
      }

      if (dl.patterns?.goodPatterns?.length > 0) {
        lessons += `**What Worked:**\n`;
        for (const p of dl.patterns.goodPatterns) lessons += `✅ ${p}\n`;
        lessons += '\n';
      }

      if (dl.patterns?.badPatterns?.length > 0) {
        lessons += `**What to Avoid:**\n`;
        for (const p of dl.patterns.badPatterns) lessons += `❌ ${p}\n`;
        lessons += '\n';
      }

      if (dl.emotionalCheck) {
        lessons += `**Emotional Check:** ${dl.emotionalCheck}\n\n`;
      }

      if (dl.riskAssessment) {
        lessons += `**Risk Management:** ${dl.riskAssessment}\n`;
      }

      await discord.afterHours(lessons);
    }

    // Part 5: Tomorrow Setup
    if (report.tomorrowSetup) {
      let tomorrow = `**📋 TOMORROW SETUP:**\n`;
      tomorrow += `Market Bias: ${report.tomorrowSetup.marketBias}\n`;

      if (report.tomorrowSetup.focusSymbols.length > 0) {
        tomorrow += `\n**Focus:**\n`;
        for (const focus of report.tomorrowSetup.focusSymbols) {
          tomorrow += `• ${focus.symbol}: ${focus.reason}\n`;
        }
      }

      if (report.tomorrowSetup.tomorrowRules?.length > 0) {
        tomorrow += `\n**Rules for Tomorrow:**\n`;
        for (const rule of report.tomorrowSetup.tomorrowRules) {
          tomorrow += `📌 ${rule}\n`;
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

    // Send combined P&L update to dedicated channel
    let pnlMsg = `**Daily P&L - ${report.date}**\n`;
    if (report.dailySummary) {
      pnlMsg += `📊 Swing: ${report.dailySummary.dailyPL >= 0 ? '🟢' : '🔴'} ${report.dailySummary.dailyPL >= 0 ? '+' : ''}$${report.dailySummary.dailyPL.toFixed(2)} (${report.dailySummary.dailyPLPct.toFixed(2)}%) | $${report.dailySummary.equity.toFixed(2)}\n`;
    }
    if (report.dayTradeSummary) {
      const dtPL = report.dayTradeSummary.dailyPL || 0;
      pnlMsg += `⚡ Day: ${dtPL >= 0 ? '🟢' : '🔴'} ${dtPL >= 0 ? '+' : ''}$${dtPL.toFixed(2)} (${(report.dayTradeSummary.dailyPLPct || 0).toFixed(2)}%) | $${(report.dayTradeSummary.equity || 0).toLocaleString()}\n`;
      pnlMsg += `Trades: ${report.dayTradeSummary.closedTradesCount || 0} closed | ${report.dayTradeSummary.winRate || 'N/A'} win rate\n`;
    }
    if (report.dailyLessons?.overallGrade) {
      pnlMsg += `Grade: ${report.dailyLessons.overallGrade}`;
    }
    await discord.pnl(pnlMsg);
  }
}

module.exports = AfterHoursAgent;
