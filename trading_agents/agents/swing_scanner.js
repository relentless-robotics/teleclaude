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

// Event Logger
let eventLogger;
try {
  eventLogger = require('../event_logger');
} catch (e) {
  console.warn('[SwingScanner] Event logger not available:', e.message);
}

// Import Alpaca client
let alpacaClient;
try {
  alpacaClient = require('../../swing_options/alpaca_client');
} catch (e) {
  console.warn('Alpaca client not available:', e.message);
}

// LLM Reasoning Engine (Groq Kimi K2 - FREE)
let reasoning;
try {
  reasoning = require('../../utils/llm_reasoning');
} catch (e) {
  console.warn('[SwingScanner] LLM reasoning not available:', e.message);
}

// Trade Journal (performance logging)
let journal;
try {
  journal = require('../trade_journal');
} catch (e) {
  console.warn('[SwingScanner] Trade journal not available:', e.message);
}

// Swing Options Toolkit - enriched data sources
let apiClient, catalystScanner;
try {
  apiClient = require('../../swing_options/api_client');
  const { CatalystScanner } = require('../../swing_options/catalyst_scanner');
  catalystScanner = new CatalystScanner();
} catch (e) {
  console.warn('[SwingScanner] Swing options toolkit not available:', e.message);
}

// V9 MacroStrategy Alpha Loader (HIGH relevance for swing trades - monthly horizon)
let v9MacroLoader;
try {
  v9MacroLoader = require('../v9_macro_loader');
} catch (e) {
  console.warn('[SwingScanner] V9 macro loader not available:', e.message);
}

function buildSwingPrompt(accountData) {
  const equity = accountData?.equity || 5000;
  const maxPosition = Math.round(equity * 0.20);
  const defaultSize = Math.round(equity * 0.05);

  return `You are an expert CATALYST-DRIVEN SWING TRADER. You manage a small account (~$${equity.toLocaleString()} equity). You trade stocks (no options on this account).

YOUR EDGE: You trade CATALYSTS with PATIENCE.
- Holding period: days to WEEKS (not intraday - that's the day trader's job)
- You wait for the right setup, then let the catalyst play out
- You are NOT a day trader. Do NOT recommend entries/exits based on intraday price action alone.

FUNDAMENTAL THESIS REQUIREMENT (MANDATORY):
For EVERY trade decision, you MUST explain WHY the stock is at its current price level:
- What catalyst moved it here? (earnings, sector rotation, M&A, FDA, analyst action, macro event)
- Is the current price justified or an overreaction to the catalyst?
- What is your THESIS for the trade? Not just "oversold" but a clear narrative.

Your thesis must include:
1. THE CATALYST: What event/news drove the stock to this price
2. THE MISPRICING: Why you think the market got it wrong (or right)
3. THE EDGE: What specific information or analysis gives you conviction

Example: "Stock dropped 15% after earnings miss, but guidance raised 10% for next year. Market focused on backward-looking data, ignoring forward strength. Playing recovery bounce as institutional buying returns."

CATALYST TYPES YOU TRADE:
- Earnings plays (pre/post, with directional evidence)
- Sector rotation / thematic momentum (AI, defense, energy, etc.)
- Technical breakouts from multi-day consolidation
- Post-selloff recovery in fundamentally strong names
- Macro catalysts (rate decisions, economic data releases)
- M&A / corporate events
- Short squeeze setups (high short interest + catalyst)

POSITION MANAGEMENT:
- Max position: $${maxPosition.toLocaleString()} (20% of equity)
- Default size: $${defaultSize.toLocaleString()} (5% of equity)
- Max 5 concurrent positions
- Scale INTO winners (add on confirmation, not at entry)
- Cut thesis breaks immediately (not price - THESIS)
- Trim 50% at 2x gain, let remainder ride
- Stop loss: -10% from entry OR thesis invalidation (whichever comes first)

ENTRY RULES:
- MUST have identified catalyst with expected timeframe
- MUST have defined entry zone (not just "buy now")
- News/sentiment must confirm or at least not contradict thesis
- Prefer entries at support or after pullback, not at highs
- Quality >> quantity. No trade is better than a forced trade.

EXIT RULES:
- Target hit → trim or close
- Catalyst played out (even if target not hit) → close
- Thesis broken by news/data → close immediately
- Slow bleed with no catalyst resolution → reassess at -7%

OPPORTUNITY MINDSET:
- There are unlimited opportunities across all sectors. If nothing in tech, look at energy, financials, healthcare, commodities.
- The catalyst scanner, earnings calendar, social buzz, and sector rotation data give you a HUGE pool of candidates.
- Don't just wait for watchlist entries to trigger. PROACTIVELY find the best catalyst-driven setups in the data provided.
- Rotate freely - if a thesis breaks on one position, the capital should go to the NEXT best opportunity, not sit idle.
- Something is always setting up. Your job is to find the best risk/reward catalyst play available right now.

RESPOND IN JSON ONLY:
{
  "marketView": "1-2 sentence macro/sector assessment relevant to swing timeframe",
  "entryDecisions": [
    {
      "symbol": "TICKER",
      "action": "ENTER" | "SKIP",
      "catalyst": "What catalyst drives this trade",
      "catalystDate": "When catalyst expected (date or range)",
      "timeframe": "days | 1-2 weeks | 2-4 weeks",
      "reasoning": "why this is a swing trade, not a day trade",
      "conviction": "HIGH" | "MEDIUM" | "LOW",
      "suggestedEntry": "$X or zone",
      "suggestedStop": "$X (-Y%)",
      "suggestedTarget": "$X (+Y%)",
      "suggestedSize": "$${defaultSize.toLocaleString()} to $${maxPosition.toLocaleString()}"
    }
  ],
  "positionDecisions": [
    {
      "symbol": "TICKER",
      "action": "HOLD" | "TRIM" | "ADD" | "EXIT",
      "catalystStatus": "Pending | Playing out | Completed | Invalidated",
      "reasoning": "why - reference the original catalyst"
    }
  ],
  "riskAssessment": "overall portfolio risk: concentration, correlation, catalyst timing overlap"
}`;
}

class SwingScannerAgent {
  constructor() {
    this.name = 'Swing Scanner';
    this.emoji = '📊';
    this.lastRun = null;
    this.dataDir = config.paths.dataDir;
  }

  /**
   * Format V9 MacroStrategy PREDICTIONS (new loader) for the swing trader LLM prompt.
   * @param {object} report - Current scan report (for position/opportunity symbols)
   * @returns {string} Formatted V9 predictions section
   */
  formatV9PredictionsForSwing(report) {
    try {
      const v9Loader = require('../v9_loader');
      const predData = v9Loader.loadV9Predictions({ allowStale: true, returnStale: true });

      // Support both old (predData.predictions) and new dual-prediction format (xgb_predictions + ensemble_predictions)
      const hasDualFormat = predData && predData.xgb_predictions && predData.ensemble_predictions;
      const hasLegacyFormat = predData && predData.predictions;

      if (!predData || (!hasDualFormat && !hasLegacyFormat)) {
        return '---- V9 MACROSTRATEGY PREDICTIONS ----\nNot available (run: python generate_v9_predictions_simple.py in MacroStrategy via WSL)\n';
      }

      // Collect relevant symbols
      const relevantSymbols = [];
      (report.opportunities || []).forEach(o => relevantSymbols.push(o.symbol));
      (report.positions || []).forEach(p => relevantSymbols.push(p.symbol));

      const formatted = v9Loader.formatForLLM(predData, relevantSymbols);
      if (!formatted) {
        return '---- V9 MACROSTRATEGY PREDICTIONS ----\nNot available.\n';
      }

      let lines = [];
      lines.push('---- V9 MACROSTRATEGY PREDICTIONS (WALK-FORWARD ML ENSEMBLE) ----');

      if (hasDualFormat) {
        // New dual-prediction format
        lines.push(`Model: ${formatted.model_version} | Method: ${formatted.method || 'Dual XGB+Ensemble'}`);
        lines.push(`Backtest: ${formatted.backtest_metrics?.return || 'N/A'} return, ${formatted.backtest_metrics?.sharpe || 'N/A'} Sharpe`);
        lines.push(`Freshness: ${formatted.freshness?.ageDays || '?'}d old ${formatted.freshness?.isStale ? '(STALE!)' : '(current)'}`);
        lines.push(`Next rebalance: ${formatted.next_rebalance || 'N/A'}`);
        lines.push('');

        // Show relevant symbol predictions from ensemble
        const relevantSet = new Set(relevantSymbols);
        if (relevantSet.size > 0 && formatted.ensemble?.relevant?.length > 0) {
          lines.push('PREDICTIONS FOR YOUR OPPORTUNITIES/POSITIONS (Ensemble):');
          for (const p of formatted.ensemble.relevant) {
            const bias = p.quintile <= 2 ? 'LONG BIAS' : (p.quintile >= 4 ? 'AVOID/SHORT' : 'NEUTRAL');
            lines.push(`  ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal}) rank #${p.rank} - ${bias}`);
          }
          lines.push('');
        }

        lines.push('HIGHEST CONVICTION (XGB + Ensemble BOTH agree - STRONG_BUY):');
        lines.push(`  ${(formatted.agreement?.both_strong_buy || []).slice(0, 15).join(', ') || 'None'}`);
        lines.push('');

        lines.push('TOP 15 LONG CANDIDATES (XGB model):');
        for (const sym of (formatted.xgb?.top_longs || []).slice(0, 15)) {
          const pred = predData.xgb_predictions.predictions.find(p => p.symbol === sym);
          if (pred) lines.push(`  #${pred.rank} ${pred.symbol}: Q${pred.quintile} score=${pred.score.toFixed(4)} (${pred.signal})`);
        }
        lines.push('');

        lines.push('AVOID (Q5 - both models agree):');
        lines.push(`  ${(formatted.agreement?.both_avoid || []).slice(0, 10).join(', ') || 'None'}`);
        lines.push('');
        lines.push(formatted.note || 'V9 DUAL PREDICTIONS: Q1/STRONG_BUY = LONG BIAS, Q5/STRONG_SELL = AVOID. Rebalances weekly.');
      } else {
        // Legacy single-prediction format
        lines.push(`Model: ${formatted.model_version} (${formatted.execution_config})`);
        lines.push(`Backtest: ${formatted.model_metrics?.backtest_return || 'N/A'} return, ${formatted.model_metrics?.backtest_sharpe || 'N/A'} Sharpe`);
        lines.push(`Freshness: ${formatted.freshness?.ageDays || '?'}d old ${formatted.freshness?.isStale ? '(STALE!)' : '(current)'}`);
        lines.push(`Universe: ${formatted.universe_size} symbols | Next rebalance: ${formatted.portfolio_action?.rebalance_due || 'N/A'}`);
        lines.push('');

        if (formatted.relevantPredictions && formatted.relevantPredictions.length > 0) {
          lines.push('PREDICTIONS FOR YOUR OPPORTUNITIES/POSITIONS:');
          for (const p of formatted.relevantPredictions) {
            const bias = p.quintile <= 2 ? 'LONG BIAS' : (p.quintile >= 4 ? 'AVOID/SHORT' : 'NEUTRAL');
            lines.push(`  ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal}) rank #${p.rank}/${formatted.universe_size} - ${bias}`);
          }
          lines.push('');
        }

        lines.push('TOP 15 LONG CANDIDATES (Q1-Q2 with momentum filter):');
        for (const p of (formatted.topLongs || []).slice(0, 15)) {
          lines.push(`  #${p.rank} ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal})`);
        }
        lines.push('');

        lines.push('BOTTOM 10 (Q5 - AVOID for longs):');
        for (const p of (formatted.bottomPicks || []).slice(0, 10)) {
          lines.push(`  #${p.rank} ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal})`);
        }
        lines.push('');
        lines.push(formatted.note || '');
      }

      return lines.join('\n');
    } catch (e) {
      console.warn('[SwingScanner] V9 predictions format error:', e.message);
      return '---- V9 MACROSTRATEGY PREDICTIONS ----\nError loading predictions.\n';
    }
  }

  /**
   * Format V9 MacroStrategy alpha scores (LEGACY) for the swing trader LLM prompt.
   * Swing trading aligns closely with V9's monthly prediction horizon,
   * so alpha scores are given HIGH weight here.
   *
   * @param {object} report - Current scan report (for position symbols)
   * @returns {string} Formatted alpha section for LLM prompt
   */
  formatMacroAlphaForSwing(report) {
    // Try brain first, then load directly
    let macroAlpha = brain.ctx.macroAlpha;
    if (!macroAlpha?.updatedAt && v9MacroLoader) {
      try {
        v9MacroLoader.loadAndWrite(brain);
        macroAlpha = brain.ctx.macroAlpha;
      } catch (e) {
        // Silent - not critical
      }
    }

    if (!macroAlpha || !macroAlpha.scores || Object.keys(macroAlpha.scores).length === 0) {
      return 'MACROSTRATEGY V9 ALPHA: Not available (no predictions loaded).';
    }

    const freshness = macroAlpha.freshness || {};
    const isStale = freshness.isStale;
    const age = freshness.ageDays || '?';

    let lines = [];
    lines.push(`MACROSTRATEGY V9 ALPHA SCORES (HIGH RELEVANCE for swing trades):`);
    lines.push(`Prediction date: ${macroAlpha.predictionDate} | Age: ${age}d${isStale ? ' **STALE - USE WITH CAUTION**' : ''}`);
    lines.push(`V9 is a walk-forward ML ensemble predicting multi-horizon forward returns (10d primary, blended 5d/21d/63d). Monthly horizon = directly aligned with swing trade timeframe.`);
    lines.push('');

    // Show alpha for opportunity symbols
    const oppSymbols = (report.opportunities || []).map(o => o.symbol);
    if (oppSymbols.length > 0) {
      lines.push('Alpha for your opportunities:');
      for (const sym of oppSymbols) {
        const s = macroAlpha.scores[sym];
        if (s) {
          const bias = s.quintile <= 2 ? 'LONG BIAS' : (s.quintile >= 4 ? 'AVOID/SHORT' : 'NEUTRAL');
          lines.push(`  ${sym}: alpha=${s.alpha > 0 ? '+' : ''}${s.alpha.toFixed(4)} | Q${s.quintile} (${bias}) | rank ${s.rank}/${s.totalRanked} | ${s.sectorGroup}`);
        } else {
          lines.push(`  ${sym}: not in V9 universe`);
        }
      }
      lines.push('');
    }

    // Show alpha for current positions
    const posSymbols = (report.positions || []).map(p => p.symbol);
    if (posSymbols.length > 0) {
      lines.push('Alpha for current positions:');
      for (const sym of posSymbols) {
        const s = macroAlpha.scores[sym];
        if (s) {
          const hold = s.quintile <= 2 ? 'SUPPORTS HOLD' : (s.quintile >= 4 ? 'SUGGESTS EXIT' : 'NEUTRAL');
          lines.push(`  ${sym}: alpha=${s.alpha > 0 ? '+' : ''}${s.alpha.toFixed(4)} | Q${s.quintile} (${hold}) | ${s.sectorGroup}`);
        }
      }
      lines.push('');
    }

    // Top picks
    lines.push('TOP 10 ALPHA (strongest long candidates for swing):');
    for (const pick of (macroAlpha.topPicks || []).slice(0, 10)) {
      lines.push(`  #${pick.rank} ${pick.symbol}: alpha=${pick.alpha > 0 ? '+' : ''}${pick.alpha.toFixed(4)} (${pick.sectorGroup})`);
    }
    lines.push('');
    lines.push('BOTTOM 5 ALPHA (avoid for longs):');
    for (const pick of (macroAlpha.bottomPicks || []).slice(0, 5)) {
      lines.push(`  #${pick.rank} ${pick.symbol}: alpha=${pick.alpha > 0 ? '+' : ''}${pick.alpha.toFixed(4)} (${pick.sectorGroup})`);
    }

    // Full model performance context (from model_info if available)
    if (macroAlpha.modelInfo) {
      const mi = macroAlpha.modelInfo;
      lines.push('');
      lines.push('--- V9 MODEL PERFORMANCE (OOS Backtest) ---');
      lines.push(`Best Combo: ${mi.best_combo} | OOS Period: ${mi.oos_period}`);

      if (mi.execution_metrics) {
        const em = mi.execution_metrics;
        lines.push(`Return: ${em.oos_return} (vs SPY ${em.vs_spy}) | Sharpe: ${em.sharpe} | Max DD: ${em.max_drawdown}`);
        lines.push(`Monthly: ${em.avg_monthly_return}% avg return, ${em.monthly_win_rate}% win rate (${em.positive_months}W/${em.negative_months}L)`);
      }

      if (mi.raw_model_metrics) {
        const reliable = Object.entries(mi.raw_model_metrics)
          .filter(([, v]) => v.reliable)
          .sort((a, b) => b[1].cv_ic_avg - a[1].cv_ic_avg)
          .map(([k, v]) => `${k}(IC=${v.cv_ic_avg.toFixed(4)})`);
        if (reliable.length > 0) {
          lines.push(`Reliable Models: ${reliable.join(', ')}`);
        }
      }

      lines.push(`Features: ${mi.feature_selection?.selected || '?'}/${mi.feature_selection?.total_candidates || '?'} selected via RF importance`);
      lines.push('Audit: All leakage vectors fixed. Config frozen with SHA256 hash integrity check.');
      lines.push('CAUTION: Backtest Sharpe includes execution configs tuned on same holdout. Real performance will be lower.');
    } else if (macroAlpha.metadata?.bestCombo) {
      // Fallback to old-style metadata if model_info not available
      const bc = macroAlpha.metadata.bestCombo;
      lines.push('');
      lines.push(`Model performance (backtest): ${bc.model}+${bc.execution} = ${bc.return} return, ${bc.sharpe} Sharpe (treat with caution - execution was tuned on same holdout).`);
    }

    lines.push('');
    lines.push('HOW TO USE V9 ALPHA FOR SWING TRADES:');
    lines.push('- Q1 (top 20%): Strongest predicted forward returns. PREFER these for new long entries. In backtest, top quintile stocks delivered ~71.73% annualized vs SPY 14.29%.');
    lines.push('- Q2 (60-80th pct): Above-average expected returns. Good secondary candidates.');
    lines.push('- Q3 (40-60th pct): Neutral. No strong alpha signal - rely on other factors.');
    lines.push('- Q4-Q5 (bottom 40%): Weakest predicted returns. AVOID for longs, consider for shorts.');
    lines.push('- V9 alpha is your STRONGEST quantitative signal for swing timeframe (5-30 day holds). Weight it heavily alongside catalyst timing and technical setup.');

    return lines.join('\n');
  }

  /**
   * Verify order was filled (with timeout) - Feb 9 improvement
   * @param {string} orderId - Alpaca order ID
   * @param {number} maxWaitMs - Max wait time (default 30s)
   * @returns {object} { filled: bool, avgPrice, filledQty, status, reason }
   */
  async verifyOrderFilled(orderId, maxWaitMs = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const order = await alpacaClient.getOrder(orderId);
        if (order.status === 'filled') {
          return {
            filled: true,
            avgPrice: parseFloat(order.filled_avg_price),
            filledQty: parseFloat(order.filled_qty),
            filledAt: order.filled_at,
            status: 'filled',
          };
        }
        if (['canceled', 'expired', 'rejected', 'replaced'].includes(order.status)) {
          return {
            filled: false,
            status: order.status,
            reason: order.cancel_reason || order.status,
          };
        }
        // Still pending - wait and retry
        await new Promise(r => setTimeout(r, 2000)); // Check every 2s
      } catch (e) {
        console.warn(`[SwingScanner] Order check error: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    return { filled: false, status: 'timeout' };
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
      // 1. Get account status (REAL data from Alpaca - Feb 9 improvement)
      if (alpacaClient) {
        report.account = await this.getAccountStatus();
        report.positions = await this.getPositions();
        console.log(`[SwingScanner] Verified ${report.positions.length} positions from Alpaca API`);
      }

      // 2. Scan watchlist for opportunities
      report.opportunities = await this.scanWatchlist();

      // 3. Check existing positions for signals
      report.signals = await this.checkPositionSignals(report.positions);

      // 4. LLM Reasoning - validate opportunities with context + news
      report.llmDecisions = await this.getLLMValidation(report);

      // 5. Execute trades based on LLM-validated opportunities
      report.executions = await this.executeTrades(report.opportunities, report.account, report.llmDecisions);

      // 6. Execute LLM position decisions (TRIM/EXIT/ADD) - the missing link
      const positionExecs = await this.executePositionDecisions(report.positions, report.account, report.llmDecisions);
      report.executions = [...report.executions, ...positionExecs];

    } catch (error) {
      report.errors.push(error.message);
      console.error('Swing Scanner error:', error);
    }

    // FIX 3: Write comprehensive findings to shared brain
    brain.writeSwingState({
      positions: report.positions,
      signals: report.signals,
      account: report.account,
    });

    // Write opportunities to brain for other agents to see
    if (report.opportunities.length > 0) {
      brain.writeTechnicals({
        swingOpportunities: report.opportunities.slice(0, 10).map(o => ({
          symbol: o.symbol,
          price: o.price,
          signal: o.signal,
          thesis: o.thesis,
        })),
      });
    }

    // Log scan activity
    brain.logAgent('swing-scanner', 'Scan completed', `${report.opportunities.length} opps, ${report.executions.length} executions`);

    // Send report to Discord
    await this.sendReport(report);

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} Swing Scanner completed in ${Date.now() - startTime}ms`);

    return report;
  }

  /**
   * Get REAL account status from Alpaca API (Feb 9 improvement)
   * NEVER use cached data - always fresh pull before LLM reasoning
   */
  async getAccountStatus() {
    try {
      const account = await alpacaClient.getAccount();
      return {
        equity: parseFloat(account.portfolio_value),
        cash: parseFloat(account.cash),
        buyingPower: parseFloat(account.buying_power),
        lastEquity: parseFloat(account.last_equity),
        dailyPL: parseFloat(account.portfolio_value) - parseFloat(account.last_equity),
      };
    } catch (e) {
      console.error('[SwingScanner] Failed to get account from Alpaca:', e.message);
      return null;
    }
  }

  /**
   * Get REAL positions from Alpaca API (Feb 9 improvement)
   * NEVER use cached data - always fresh pull before LLM reasoning
   */
  async getPositions() {
    try {
      const positions = await alpacaClient.getPositions();
      const verified = positions.map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPL: parseFloat(p.unrealized_pl),
        unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
        side: p.side,
      }));
      console.log(`[SwingScanner] Alpaca positions: ${verified.map(p => `${p.symbol} ${p.qty}x @ $${p.avgEntry.toFixed(2)} (${p.unrealizedPLPct >= 0 ? '+' : ''}${p.unrealizedPLPct.toFixed(1)}%)`).join(', ') || 'None'}`);
      return verified;
    } catch (e) {
      console.error('[SwingScanner] Failed to get positions from Alpaca:', e.message);
      return [];
    }
  }

  /**
   * Scan watchlist for entry opportunities
   * FIX 1: Now includes research dispatcher picks from brain
   */
  async scanWatchlist() {
    const opportunities = [];

    // Load watchlist from file
    const watchlistPath = config.paths.watchlistFile;
    let watchlist = { dickCapital: [], independent: [] };

    if (fs.existsSync(watchlistPath)) {
      watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    }

    const allPicks = [...(watchlist.dickCapital || []), ...(watchlist.independent || [])];

    // FIX 1: Merge research dispatcher picks from brain AND persistent file
    const brainWatchlist = brain.ctx.dayWatchlist || [];
    const researchPicks = brain.readResearchPicks(); // Read from file with full DD
    console.log(`[SwingScanner] Merging ${brainWatchlist.length} brain picks + ${researchPicks.length} research picks`);

    // First merge from persistent research file (has full DD data)
    for (const researchPick of researchPicks) {
      if (!allPicks.find(p => p.symbol === researchPick.symbol)) {
        allPicks.push({
          symbol: researchPick.symbol,
          thesis: researchPick.signals?.map(s => `${s.source}: ${s.signal}`).join(' | ') || 'Research pick',
          conviction: ['LOW', 'MEDIUM', 'HIGH'][Math.min(2, Math.floor(researchPick.conviction - 1))] || 'MEDIUM',
          entryTarget: researchPick.quote?.price || null,
          ptLow: null, // Let LLM decide
          ptHigh: null,
          source: 'research_dispatcher',
          sourceCount: researchPick.sourceCount || 1,
          researchScore: researchPick.score,
          researchData: researchPick, // Full DD: TA, options, revisions, sector
        });
      }
    }

    // Then merge from brain watchlist (may have newer items)
    for (const researchPick of brainWatchlist) {
      if (!allPicks.find(p => p.symbol === researchPick.symbol)) {
        allPicks.push({
          symbol: researchPick.symbol,
          thesis: researchPick.reason,
          conviction: researchPick.conviction || 'MEDIUM',
          entryTarget: null,
          ptLow: null,
          ptHigh: null,
          source: researchPick.source || 'research_dispatcher',
          sourceCount: researchPick.sourceCount || 1,
          researchData: researchPick,
        });
      }
    }

    for (const pick of allPicks) {
      const quote = await this.fetchQuote(pick.symbol);
      if (!quote) continue;

      const price = quote.price;
      const entryTarget = pick.entryTarget || price; // Use current price if no target set
      const distanceFromEntry = (price - entryTarget) / entryTarget;
      const upside = pick.ptLow ? (pick.ptLow - price) / price : 0.15; // Default 15% upside if not set

      // Entry criteria - relaxed for research picks
      const isResearchPick = pick.source === 'research_dispatcher';
      const entryThreshold = isResearchPick ? 1.10 : 1.05; // 10% for research, 5% for watchlist

      if (price <= entryTarget * entryThreshold) {
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
          source: pick.source || 'watchlist',
          sourceCount: pick.sourceCount,
          researchData: pick.researchData, // Pass research DD to LLM
        });
      }
    }

    // Sort by signal strength, source count (confluence), and distance from entry
    opportunities.sort((a, b) => {
      if (a.signal !== b.signal) return a.signal === 'STRONG_BUY' ? -1 : 1;
      // Prioritize multi-source research picks
      if (a.sourceCount !== b.sourceCount) return (b.sourceCount || 0) - (a.sourceCount || 0);
      return a.distanceFromEntry - b.distanceFromEntry;
    });

    return opportunities;
  }

  /**
   * Check positions for exit signals AND EXECUTE exits
   * FIX 2: Now AUTOMATICALLY executes exits based on criteria
   */
  async checkPositionSignals(positions) {
    const signals = [];
    const executions = [];

    // Load watchlist for targets
    const watchlistPath = config.paths.watchlistFile;
    let watchlist = { dickCapital: [], independent: [], positions: [] };
    if (fs.existsSync(watchlistPath)) {
      watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    }

    const allPicks = [...(watchlist.dickCapital || []), ...(watchlist.independent || [])];

    // Track peak prices for trailing stop calculation
    if (!this.peakPrices) this.peakPrices = {};

    for (const position of positions) {
      const symbol = position.symbol;
      const currentPrice = position.currentPrice;
      const avgEntry = position.avgEntry;
      const plPct = position.unrealizedPLPct;

      // Update peak price
      if (!this.peakPrices[symbol] || currentPrice > this.peakPrices[symbol]) {
        this.peakPrices[symbol] = currentPrice;
      }
      const peak = this.peakPrices[symbol];

      // Find targets from watchlist
      const watchPos = (watchlist.positions || []).find(p => p.symbol === symbol);
      const pick = allPicks.find(p => p.symbol === symbol);

      // FIX 2: AUTOMATED EXIT LOGIC - EXECUTES REAL TRADES

      // 1. Stop Loss: -10% from entry OR watchlist stop
      const stopLoss = watchPos?.stopLoss || (avgEntry * 0.90);
      if (currentPrice <= stopLoss) {
        signals.push({
          symbol,
          type: 'STOP_LOSS',
          message: `Stop loss triggered at $${stopLoss.toFixed(2)}`,
          action: 'EXIT_EXECUTED',
          gain: plPct,
        });

        // EXECUTE: Close entire position
        try {
          const result = await alpacaClient.closePosition(symbol);
          executions.push({
            symbol,
            action: 'STOP_LOSS_EXIT',
            qty: position.qty,
            price: currentPrice,
            reason: `Stop loss at $${stopLoss.toFixed(2)} (${plPct.toFixed(1)}% loss)`,
            orderId: result?.id,
          });
          console.log(`[SwingScanner] ❌ STOP LOSS: Closed ${symbol} at $${currentPrice.toFixed(2)}`);

          // Log stop triggered
          if (eventLogger) {
            eventLogger.logTradingEvent({
              agent: 'swing_scanner',
              type: 'STOP_TRIGGERED',
              symbol,
              side: 'sell',
              qty: position.qty,
              price: currentPrice,
              stop_price: stopLoss,
              order_id: result?.id,
              alpaca_order_id: result?.id,
              reason: `Stop loss triggered`,
              pnl: position.unrealizedPL,
              result: 'success',
            });
          }

          // Log to journal
          if (journal) {
            journal.closeTrade({
              symbol,
              account: 'swing',
              exitPrice: currentPrice,
              reasoning: `Stop loss triggered: ${plPct.toFixed(1)}% loss`,
            });
          }

          // Post to Discord
          await discord.tradeExecution(
            `🔴 **STOP LOSS EXIT** [SWING]\n` +
            `**${symbol}**: Closed ${position.qty} @ $${currentPrice.toFixed(2)}\n` +
            `Entry: $${avgEntry.toFixed(2)} → Exit: $${currentPrice.toFixed(2)} (${plPct.toFixed(1)}%)\n` +
            `Loss: $${position.unrealizedPL.toFixed(2)}`
          );
        } catch (e) {
          console.error(`[SwingScanner] Failed to execute stop loss on ${symbol}:`, e.message);
        }
        continue; // Position closed, skip other checks
      }

      // 2. Profit Target: +20% from entry OR watchlist target
      const profitTarget = watchPos?.target || pick?.ptLow;
      if (profitTarget && currentPrice >= profitTarget && plPct >= 20) {
        signals.push({
          symbol,
          type: 'PROFIT_TARGET',
          message: `Profit target $${profitTarget.toFixed(2)} reached`,
          action: 'TRIM_EXECUTED',
          gain: plPct,
        });

        // EXECUTE: Trim 50% of position
        const trimQty = Math.max(1, Math.floor(position.qty / 2));
        try {
          const result = await alpacaClient.closePosition(symbol, trimQty);
          executions.push({
            symbol,
            action: 'PROFIT_TRIM',
            qty: trimQty,
            price: currentPrice,
            reason: `Profit target at $${profitTarget.toFixed(2)} (+${plPct.toFixed(1)}%)`,
            orderId: result?.id,
          });
          console.log(`[SwingScanner] 💰 PROFIT TRIM: Sold ${trimQty} of ${symbol} at $${currentPrice.toFixed(2)}`);

          // Log exit signal
          if (eventLogger) {
            eventLogger.logTradingEvent({
              agent: 'swing_scanner',
              type: 'EXIT_SIGNAL',
              symbol,
              side: 'sell',
              qty: trimQty,
              price: currentPrice,
              order_id: result?.id,
              alpaca_order_id: result?.id,
              reason: `Profit target reached: +${plPct.toFixed(1)}%`,
              pnl: ((currentPrice - avgEntry) * trimQty),
              result: 'success',
            });
          }

          // Log to journal
          if (journal) {
            journal.closeTrade({
              symbol,
              account: 'swing',
              exitPrice: currentPrice,
              exitQty: trimQty,
              reasoning: `Profit target: Trimmed 50% at +${plPct.toFixed(1)}%`,
            });
          }

          // Post to Discord
          await discord.tradeExecution(
            `🟢 **PROFIT TARGET - TRIMMED 50%** [SWING]\n` +
            `**${symbol}**: Sold ${trimQty} @ $${currentPrice.toFixed(2)}\n` +
            `Entry: $${avgEntry.toFixed(2)} → Exit: $${currentPrice.toFixed(2)} (+${plPct.toFixed(1)}%)\n` +
            `Profit: $${((currentPrice - avgEntry) * trimQty).toFixed(2)}\n` +
            `Remaining: ${position.qty - trimQty} shares`
          );
        } catch (e) {
          console.error(`[SwingScanner] Failed to trim ${symbol}:`, e.message);
        }
      }

      // 3. Trailing Stop: 5% drop from peak (only if profitable)
      if (plPct > 0 && peak > avgEntry * 1.05) {
        const trailingStop = peak * 0.95;
        if (currentPrice <= trailingStop) {
          signals.push({
            symbol,
            type: 'TRAILING_STOP',
            message: `Trailing stop: 5% drop from peak $${peak.toFixed(2)}`,
            action: 'EXIT_EXECUTED',
            gain: plPct,
          });

          // EXECUTE: Close entire position
          try {
            const result = await alpacaClient.closePosition(symbol);
            executions.push({
              symbol,
              action: 'TRAILING_STOP_EXIT',
              qty: position.qty,
              price: currentPrice,
              reason: `Trailing stop: dropped 5% from peak $${peak.toFixed(2)}`,
              orderId: result?.id,
            });
            console.log(`[SwingScanner] 📉 TRAILING STOP: Closed ${symbol} at $${currentPrice.toFixed(2)}`);

            // Log trailing stop triggered
            if (eventLogger) {
              eventLogger.logTradingEvent({
                agent: 'swing_scanner',
                type: 'STOP_TRIGGERED',
                symbol,
                side: 'sell',
                qty: position.qty,
                price: currentPrice,
                stop_price: trailingStop,
                order_id: result?.id,
                alpaca_order_id: result?.id,
                reason: `Trailing stop: dropped 5% from peak $${peak.toFixed(2)}`,
                pnl: position.unrealizedPL,
                result: 'success',
              });
            }

            // Log to journal
            if (journal) {
              journal.closeTrade({
                symbol,
                account: 'swing',
                exitPrice: currentPrice,
                reasoning: `Trailing stop: dropped 5% from peak $${peak.toFixed(2)}`,
              });
            }

            // Post to Discord
            await discord.tradeExecution(
              `🟡 **TRAILING STOP EXIT** [SWING]\n` +
              `**${symbol}**: Closed ${position.qty} @ $${currentPrice.toFixed(2)}\n` +
              `Entry: $${avgEntry.toFixed(2)} → Peak: $${peak.toFixed(2)} → Exit: $${currentPrice.toFixed(2)}\n` +
              `Final P&L: ${plPct.toFixed(1)}% ($${position.unrealizedPL.toFixed(2)})`
            );
          } catch (e) {
            console.error(`[SwingScanner] Failed to execute trailing stop on ${symbol}:`, e.message);
          }
          continue;
        }
      }

      // 4. Time-based review: >14 days with <3% gain
      if (watchPos?.heldSince) {
        const heldDays = (Date.now() - new Date(watchPos.heldSince).getTime()) / (1000 * 60 * 60 * 24);
        if (heldDays > 14 && plPct < 3) {
          signals.push({
            symbol,
            type: 'STALE_POSITION',
            message: `Held ${Math.floor(heldDays)} days with only ${plPct.toFixed(1)}% gain`,
            action: 'REVIEW_FOR_EXIT',
            gain: plPct,
          });
          // Don't auto-exit on time alone - needs LLM review
        }
      }

      // Advisory signals (no auto-exit)
      if (plPct >= 20) {
        signals.push({
          symbol,
          type: 'BIG_GAIN',
          message: `+${plPct.toFixed(1)}% gain`,
          action: 'CONSIDER_PARTIAL_EXIT',
          gain: plPct,
        });
      }

      if (plPct <= -7) {
        signals.push({
          symbol,
          type: 'LOSS_WARNING',
          message: `${plPct.toFixed(1)}% loss - approaching stop`,
          action: 'REVIEW_POSITION',
          gain: plPct,
        });
      }
    }

    // Clean up peak prices for closed positions
    const activeSymbols = new Set(positions.map(p => p.symbol));
    for (const symbol of Object.keys(this.peakPrices)) {
      if (!activeSymbols.has(symbol)) {
        delete this.peakPrices[symbol];
      }
    }

    // Store executions in report
    this.lastExecutions = executions;

    return signals;
  }

  /**
   * LLM Reasoning - Validate opportunities and position decisions with context
   * FIX 3: Now reads overnight analysis and research picks from brain
   */
  async getLLMValidation(report) {
    if (!reasoning) return null;

    const provider = reasoning.findAvailableProvider();
    if (!provider) return null;

    // FIX 3: Read full brain context including overnight analysis and research
    const briefing = brain.getSwingBriefing();
    const overnightAnalysis = brain.ctx.overnight;
    const researchWatchlist = brain.ctx.dayWatchlist || [];
    const news = (brain.ctx.catalysts.newsBreaking || []).slice(0, 10);

    // Fetch enriched data for swing context
    let catalystData = null;
    let marketOverview = null;
    let earningsCalendar = [];
    let shortData = {};

    if (apiClient) {
      try {
        const [catResults, mktOverview, earnings] = await Promise.all([
          catalystScanner ? catalystScanner.runFullScan().catch(() => null) : null,
          apiClient.aggregator.getMarketOverview().catch(() => null),
          apiClient.finnhub.earningsCalendar(
            new Date().toISOString().split('T')[0],
            new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
          ).catch(() => null),
        ]);
        catalystData = catResults;
        marketOverview = mktOverview;
        if (earnings?.earningsCalendar) {
          earningsCalendar = earnings.earningsCalendar.slice(0, 20);
        }

        // Get short interest for opportunity symbols
        const oppSymbols = report.opportunities.map(o => o.symbol).slice(0, 5);
        for (const sym of oppSymbols) {
          try {
            const sd = await apiClient.social.finvizShortData(sym);
            if (sd) shortData[sym] = sd;
          } catch (e) { /* skip */ }
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        console.warn('[SwingScanner] Enriched data error:', e.message);
      }
    }

    const userMsg = `CURRENT TIME: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

ACCOUNT: $${report.account?.equity?.toFixed(0) || '?'} equity, $${report.account?.cash?.toFixed(0) || '?'} cash

CURRENT VERIFIED POSITIONS (from Alpaca API):
${(report.positions || []).length > 0 ? (report.positions || []).map(p =>
  `- ${p.symbol}: ${p.qty}x @ $${p.avgEntry?.toFixed(2) || '?'} avg cost, current $${p.currentPrice?.toFixed(2) || '?'}, P&L ${p.unrealizedPL >= 0 ? '+' : ''}$${p.unrealizedPL?.toFixed(2) || '?'} (${p.unrealizedPLPct >= 0 ? '+' : ''}${p.unrealizedPLPct?.toFixed(1) || '?'}%)`
).join('\n') : '[No open positions]'}

CRITICAL: These positions are REAL current holdings from Alpaca. Do NOT recommend entries that conflict with existing positions without acknowledging them.

OVERNIGHT ANALYSIS (from overnight agent):
- Risk Sentiment: ${overnightAnalysis.riskSentiment || 'Unknown'}
- Significant Moves: ${(overnightAnalysis.significantMoves || []).slice(0, 5).map(m => `${m.symbol} ${m.direction}`).join(', ') || 'None'}
- Futures: ${JSON.stringify(overnightAnalysis.futures || {})}

RESEARCH DISPATCHER PICKS (multi-signal opportunities):
${researchWatchlist.length > 0 ? researchWatchlist.slice(0, 10).map(r =>
  `- ${r.symbol}: ${r.reason} [Conviction: ${r.conviction || '?'}, Sources: ${r.sourceCount || 1}]`
).join('\n') : 'No research picks today'}

ENTRY OPPORTUNITIES (from rule-based scan + research merge):
${JSON.stringify(report.opportunities.map(o => ({
  symbol: o.symbol, price: o.price, entry: o.entryTarget, upside: o.upside?.toFixed(1) + '%',
  thesis: o.thesis, signal: o.signal, conviction: o.conviction, source: o.source, sourceCount: o.sourceCount
})), null, 2)}

POSITION SIGNALS (automated exits already executed):
${JSON.stringify(report.signals, null, 2)}

MARKET CONTEXT:
- Sentiment: ${briefing.riskSentiment || 'Unknown'}
- VIX: ${briefing.vix || 'N/A'}${marketOverview ? ` (FRED: ${marketOverview.vix || 'N/A'})` : ''}
- Regime: ${briefing.marketRegime || 'Unknown'}
${marketOverview ? `- Yield Curve: ${marketOverview.yieldCurve?.spread?.toFixed(2) || 'N/A'}% (${marketOverview.yieldCurve?.signal || '?'})
- Top Gainers: ${(marketOverview.gainers || []).slice(0, 3).map(g => `${g.symbol} +${g.changesPercentage?.toFixed(1)}%`).join(', ') || 'N/A'}
- Top Losers: ${(marketOverview.losers || []).slice(0, 3).map(l => `${l.symbol} ${l.changesPercentage?.toFixed(1)}%`).join(', ') || 'N/A'}` : ''}

RECENT NEWS:
${news.map(n => `[${n.sentiment || '?'}] ${n.headline} ${n.symbols?.length ? '(' + n.symbols.join(', ') + ')' : ''}`).join('\n') || 'None available'}

EARNINGS CALENDAR (next 14 days - key for swing catalyst timing):
${earningsCalendar.length > 0 ? earningsCalendar.map(e => `- ${e.symbol}: ${e.date} ${e.hour || ''} | EPS Est: ${e.epsEstimate || 'N/A'}`).join('\n') : 'No earnings data available.'}

CATALYST SCAN RESULTS:
${catalystData ? `
- Upcoming Earnings: ${(catalystData.earnings || []).slice(0, 5).map(e => `${e.symbol} (${e.date}, ${e.daysUntil}d)`).join(', ') || 'None'}
- Social Buzz: ${(catalystData.social || []).slice(0, 5).map(s => `${s.symbol} (${s.mentions} mentions, ${s.change?.toFixed(1)}%)`).join(', ') || 'None'}
- Insider Buying: ${(catalystData.insiders || []).slice(0, 3).map(i => `${i.symbol} ($${(i.totalValue/1e6).toFixed(1)}M)`).join(', ') || 'None'}
- Analyst Upgrades: ${(catalystData.analysts || []).slice(0, 3).map(a => `${a.symbol} (Buy:${a.buyRatings} Hold:${a.holdRatings})`).join(', ') || 'None'}
` : 'Catalyst scanner not available.'}

SHORT INTEREST & TECHNICALS:
${Object.keys(shortData).length > 0 ? Object.entries(shortData).map(([sym, d]) =>
  `- ${sym}: Short=${d.shortFloat ? d.shortFloat + '%' : 'N/A'} | RSI=${d.rsi || 'N/A'} | Target=$${d.targetPrice || 'N/A'} | Analyst=${d.analystRec || 'N/A'} (1=StrongBuy,5=StrongSell)`
).join('\n') : 'No short interest data.'}

${this.formatMacroAlphaForSwing(report)}

${this.formatV9PredictionsForSwing(report)}

Validate the opportunities and decide on positions. Use catalyst timing to determine entry.

CRITICAL: V9 MacroStrategy predictions are your PRIMARY quantitative signal for swing trades. They directly predict multi-week forward returns aligned with your holding period. Q1 stocks should be strongly preferred for entries; Q4-Q5 stocks should be avoided for longs unless you have overwhelming contrary evidence. When V9 conflicts with other signals, explain why you are overriding it.

Respond JSON only.`;

    try {
      const systemPrompt = buildSwingPrompt(report.account);
      const result = await reasoning.callLLM(provider, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ], { temperature: 0.3, maxTokens: 1024 });

      let parsed;
      try {
        parsed = JSON.parse(result.content);
      } catch (e) {
        const m = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (m) parsed = JSON.parse(m[1]);
        else {
          const braceMatch = result.content.match(/\{[\s\S]*\}/);
          if (braceMatch) parsed = JSON.parse(braceMatch[0]);
        }
      }

      console.log(`[SwingScanner] LLM validation via ${result.provider}`);
      brain.logAgent('swing-scanner', `LLM: ${parsed?.marketView || 'No view'}`);

      // Log LLM decisions
      if (eventLogger && parsed) {
        eventLogger.logTradingEvent({
          agent: 'swing_scanner',
          type: 'LLM_REASONING',
          reason: parsed.marketView || 'No market view',
          conviction: (parsed.entryDecisions || []).filter(d => d.action === 'ENTER').length > 0 ? 'HIGH' : 'LOW',
          data: {
            provider: result.provider,
            model: result.model,
            entryDecisions: (parsed.entryDecisions || []).length,
            positionDecisions: (parsed.positionDecisions || []).length,
            riskAssessment: parsed.riskAssessment,
          },
          result: 'success',
        });

        // Log each entry decision
        for (const decision of parsed.entryDecisions || []) {
          if (decision.action === 'ENTER') {
            eventLogger.logTradingEvent({
              agent: 'swing_scanner',
              type: 'DECISION',
              symbol: decision.symbol,
              side: 'buy',
              reason: decision.reasoning,
              conviction: decision.conviction,
              data: {
                catalyst: decision.catalyst,
                catalystDate: decision.catalystDate,
                timeframe: decision.timeframe,
                suggestedEntry: decision.suggestedEntry,
                suggestedTarget: decision.suggestedTarget,
                suggestedStop: decision.suggestedStop,
              },
              result: 'pending',
            });
          }
        }
      }

      return { ...parsed, _meta: { provider: result.provider, model: result.model } };
    } catch (e) {
      console.error('[SwingScanner] LLM validation failed:', e.message);
      return null;
    }
  }

  /**
   * Execute trades based on opportunities (now LLM-validated)
   */
  async executeTrades(opportunities, account, llmDecisions = null) {
    const executions = [];

    if (!alpacaClient || !account) {
      return executions;
    }

    // If LLM validated, use its decisions; otherwise fall back to rule-based
    let toExecute = [];
    if (llmDecisions?.entryDecisions) {
      const llmApproved = new Set(
        llmDecisions.entryDecisions
          .filter(d => d.action === 'ENTER' && d.conviction !== 'LOW')
          .map(d => d.symbol)
      );
      toExecute = opportunities.filter(o => llmApproved.has(o.symbol)).slice(0, 2);
      // Update conviction from LLM
      toExecute.forEach(t => {
        const llmD = llmDecisions.entryDecisions.find(d => d.symbol === t.symbol);
        if (llmD) {
          t.conviction = llmD.conviction;
          t.llmReasoning = llmD.reasoning;
        }
      });
    } else {
      // Fallback: only execute strong buy signals
      toExecute = opportunities.filter(o => o.signal === 'STRONG_BUY').slice(0, 2);
    }

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
          // Log order placed
          if (eventLogger) {
            eventLogger.logTradingEvent({
              agent: 'swing_scanner',
              type: 'ORDER_PLACED',
              symbol: trade.symbol,
              side: 'buy',
              qty: shares,
              price: trade.price,
              order_id: order.id,
              alpaca_order_id: order.id,
              reason: trade.llmReasoning || trade.thesis,
              conviction: trade.conviction,
              data: {
                vehicle: 'EQUITY',
                direction: 'LONG',
                upside: trade.upside,
                source: trade.source,
              },
              result: 'pending',
            });
          }

          // Verify the order filled (Feb 9 improvement)
          console.log(`[SwingScanner] Verifying order ${order.id} for ${trade.symbol}...`);
          const verified = await this.verifyOrderFilled(order.id);

          const execution = {
            symbol: trade.symbol,
            shares,
            price: trade.price,
            value: shares * trade.price,
            orderId: order.id,
            thesis: trade.thesis,
            upside: trade.upside,
            confirmed: verified.filled,
            filledQty: verified.filledQty,
            filledAvgPrice: verified.avgPrice,
            orderStatus: verified.status,
          };

          executions.push(execution);

          if (verified.filled) {
            console.log(`[SwingScanner] ✅ ${trade.symbol} filled: ${verified.filledQty}x @ $${verified.avgPrice}`);

            // Log order filled
            if (eventLogger) {
              eventLogger.logTradingEvent({
                agent: 'swing_scanner',
                type: 'ORDER_FILLED',
                symbol: trade.symbol,
                side: 'buy',
                qty: verified.filledQty,
                price: verified.avgPrice,
                order_id: order.id,
                alpaca_order_id: order.id,
                reason: `Order filled`,
                result: 'success',
              });
            }
          } else {
            console.warn(`[SwingScanner] ❌ ${trade.symbol} order ${verified.status}: ${verified.reason || 'unknown'}`);

            // Log order failed
            if (eventLogger) {
              eventLogger.logTradingEvent({
                agent: 'swing_scanner',
                type: 'ORDER_FAILED',
                symbol: trade.symbol,
                order_id: order.id,
                alpaca_order_id: order.id,
                reason: verified.reason || 'unknown',
                error: verified.reason,
                result: verified.status,
              });
            }
          }

          // Log to trade journal
          if (journal) {
            try {
              const llmD = llmDecisions?.entryDecisions?.find(d => d.symbol === trade.symbol);
              journal.openTrade({
                symbol: trade.symbol,
                account: 'swing',
                vehicle: 'EQUITY',
                direction: 'LONG',
                qty: shares,
                entryPrice: trade.price,
                totalCost: shares * trade.price,
                reasoning: trade.llmReasoning || trade.thesis,
                catalyst: llmD?.catalyst || trade.catalyst || null,
                timeframe: llmD?.timeframe || trade.timeframe || null,
                conviction: trade.conviction || 'MEDIUM',
                target: llmD?.suggestedTarget || null,
                stop: llmD?.suggestedStop || null,
              });
            } catch (e) { console.warn('[SwingScanner] Journal open error:', e.message); }
          }

          // Send trade alert
          await discord.tradeExecution(
            `🟢 **BUY EXECUTED** [SWING]\n` +
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
   * Execute LLM position decisions (TRIM/EXIT/ADD) on existing positions
   */
  async executePositionDecisions(positions, account, llmDecisions) {
    const executions = [];
    if (!alpacaClient || !llmDecisions?.positionDecisions) return executions;

    for (const decision of llmDecisions.positionDecisions) {
      if (decision.action === 'HOLD') continue; // Nothing to do

      const position = positions.find(p => p.symbol === decision.symbol);
      if (!position) {
        console.warn(`[SwingScanner] LLM wants to ${decision.action} ${decision.symbol} but no position found`);
        continue;
      }

      try {
        if (decision.action === 'EXIT') {
          // Full exit
          const result = await alpacaClient.closePosition(decision.symbol);
          if (result?.id) {
            const verified = await this.verifyOrderFilled(result.id);
            executions.push({
              symbol: decision.symbol,
              action: 'LLM_EXIT',
              qty: position.qty,
              price: position.currentPrice,
              reason: decision.reasoning,
              orderId: result.id,
              confirmed: verified.filled,
            });
            console.log(`[SwingScanner] 🔴 LLM EXIT: Closed ${decision.symbol} (${decision.reasoning})`);

            if (eventLogger) {
              eventLogger.logTradingEvent({
                agent: 'swing_scanner', type: 'ORDER_FILLED', symbol: decision.symbol,
                side: 'sell', qty: position.qty, price: verified.avgPrice || position.currentPrice,
                order_id: result.id, reason: `LLM EXIT: ${decision.reasoning}`,
                pnl: position.unrealizedPL, result: verified.filled ? 'success' : verified.status,
              });
            }
            if (journal) {
              journal.closeTrade({ symbol: decision.symbol, account: 'swing',
                exitPrice: verified.avgPrice || position.currentPrice,
                reasoning: `LLM EXIT: ${decision.reasoning}`,
              });
            }
            await discord.tradeExecution(
              `🔴 **LLM EXIT** [SWING]\n` +
              `**${decision.symbol}**: Closed ${position.qty} @ $${position.currentPrice.toFixed(2)}\n` +
              `Entry: $${position.avgEntry.toFixed(2)} → Exit: $${position.currentPrice.toFixed(2)} (${position.unrealizedPLPct >= 0 ? '+' : ''}${position.unrealizedPLPct.toFixed(1)}%)\n` +
              `P&L: $${position.unrealizedPL.toFixed(2)}\n` +
              `Reason: ${decision.reasoning}`
            );
          }

        } else if (decision.action === 'TRIM') {
          // Trim 50% of position
          const trimQty = Math.max(1, Math.floor(position.qty / 2));
          const result = await alpacaClient.closePosition(decision.symbol, trimQty);
          if (result?.id) {
            const verified = await this.verifyOrderFilled(result.id);
            executions.push({
              symbol: decision.symbol,
              action: 'LLM_TRIM',
              qty: trimQty,
              price: position.currentPrice,
              reason: decision.reasoning,
              orderId: result.id,
              confirmed: verified.filled,
            });
            console.log(`[SwingScanner] 🟡 LLM TRIM: Sold ${trimQty} of ${decision.symbol} (${decision.reasoning})`);

            if (eventLogger) {
              eventLogger.logTradingEvent({
                agent: 'swing_scanner', type: 'ORDER_FILLED', symbol: decision.symbol,
                side: 'sell', qty: trimQty, price: verified.avgPrice || position.currentPrice,
                order_id: result.id, reason: `LLM TRIM: ${decision.reasoning}`,
                pnl: (position.currentPrice - position.avgEntry) * trimQty, result: verified.filled ? 'success' : verified.status,
              });
            }
            if (journal) {
              journal.closeTrade({ symbol: decision.symbol, account: 'swing',
                exitPrice: verified.avgPrice || position.currentPrice, exitQty: trimQty,
                reasoning: `LLM TRIM: ${decision.reasoning}`,
              });
            }
            await discord.tradeExecution(
              `🟡 **LLM TRIM 50%** [SWING]\n` +
              `**${decision.symbol}**: Sold ${trimQty} @ $${position.currentPrice.toFixed(2)}\n` +
              `Entry: $${position.avgEntry.toFixed(2)} (${position.unrealizedPLPct >= 0 ? '+' : ''}${position.unrealizedPLPct.toFixed(1)}%)\n` +
              `Remaining: ${position.qty - trimQty} shares\n` +
              `Reason: ${decision.reasoning}`
            );
          }

        } else if (decision.action === 'ADD') {
          // Add to position - respect 20% max position size
          const maxPositionValue = account.equity * 0.20;
          const currentValue = position.marketValue;
          const room = maxPositionValue - currentValue;
          if (room <= 0) {
            console.log(`[SwingScanner] ADD ${decision.symbol} skipped - already at max (${((currentValue / account.equity) * 100).toFixed(1)}%)`);
            continue;
          }
          const addValue = Math.min(room, account.equity * 0.05); // Add 5% at a time
          const addShares = Math.floor(addValue / position.currentPrice);
          if (addShares < 1) continue;

          const order = await alpacaClient.buyStock(decision.symbol, addShares);
          if (order?.id) {
            const verified = await this.verifyOrderFilled(order.id);
            executions.push({
              symbol: decision.symbol,
              action: 'LLM_ADD',
              qty: addShares,
              price: position.currentPrice,
              reason: decision.reasoning,
              orderId: order.id,
              confirmed: verified.filled,
            });
            console.log(`[SwingScanner] 🟢 LLM ADD: Bought ${addShares} more ${decision.symbol} (${decision.reasoning})`);

            if (eventLogger) {
              eventLogger.logTradingEvent({
                agent: 'swing_scanner', type: 'ORDER_FILLED', symbol: decision.symbol,
                side: 'buy', qty: addShares, price: verified.avgPrice || position.currentPrice,
                order_id: order.id, reason: `LLM ADD: ${decision.reasoning}`, result: verified.filled ? 'success' : verified.status,
              });
            }
            await discord.tradeExecution(
              `🟢 **LLM ADD** [SWING]\n` +
              `**${decision.symbol}**: Bought ${addShares} more @ $${position.currentPrice.toFixed(2)}\n` +
              `Total position: ${position.qty + addShares} shares\n` +
              `Reason: ${decision.reasoning}`
            );
          }
        }
      } catch (e) {
        console.error(`[SwingScanner] Failed to execute ${decision.action} on ${decision.symbol}:`, e.message);
        await discord.error(`**Swing ${decision.action} failed on ${decision.symbol}:** ${e.message}`);
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
    let message = `${this.emoji} **SWING SCAN** - ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET\n`;
    if (report.llmDecisions?._meta) {
      message += `_via ${report.llmDecisions._meta.provider}_\n`;
    }
    message += '\n';

    // LLM Market View
    if (report.llmDecisions?.marketView) {
      message += `**Market View:** ${report.llmDecisions.marketView}\n\n`;
    }

    // Account status
    if (report.account) {
      message += `**Account:** $${report.account.equity.toFixed(2)} equity | $${report.account.cash.toFixed(2)} cash\n\n`;
    }

    // Executions (most important)
    if (report.executions.length > 0) {
      message += '**✅ TRADES EXECUTED:**\n';
      for (const exec of report.executions) {
        const fillStatus = exec.confirmed
          ? `✅ **FILLED** ${exec.filledQty}x @ $${exec.filledAvgPrice?.toFixed(2)}`
          : `⏳ ${exec.orderStatus || 'pending'}`;
        message += `• ${exec.symbol}: ${exec.shares} shares @ $${exec.price.toFixed(2)} (${exec.upside.toFixed(1)}% upside) | ${fillStatus}\n`;
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

    // LLM entry decisions with catalyst info
    if (report.llmDecisions?.entryDecisions?.length > 0) {
      const entries = report.llmDecisions.entryDecisions.filter(d => d.action === 'ENTER');
      if (entries.length > 0) {
        message += '**LLM Entry Picks:**\n';
        for (const d of entries) {
          message += `🎯 **${d.symbol}** [${d.conviction}] - ${d.catalyst || 'N/A'}\n`;
          if (d.catalystDate) message += `  Catalyst date: ${d.catalystDate}\n`;
          if (d.timeframe) message += `  Timeframe: ${d.timeframe}\n`;
          if (d.suggestedEntry) message += `  Entry: ${d.suggestedEntry} | Stop: ${d.suggestedStop || '?'} | Target: ${d.suggestedTarget || '?'}\n`;
          message += `  _${d.reasoning}_\n`;
        }
        message += '\n';
      }
    }

    // LLM position decisions
    if (report.llmDecisions?.positionDecisions?.length > 0) {
      message += '**Position Decisions:**\n';
      for (const d of report.llmDecisions.positionDecisions) {
        const emoji = d.action === 'EXIT' ? '🔴' : d.action === 'TRIM' ? '🟡' : d.action === 'ADD' ? '🟢' : '✊';
        const catalystTag = d.catalystStatus ? ` [${d.catalystStatus}]` : '';
        message += `${emoji} ${d.action} **${d.symbol}**${catalystTag}: _${d.reasoning}_\n`;
      }
      message += '\n';
    }

    // LLM risk assessment
    if (report.llmDecisions?.riskAssessment) {
      message += `**Risk:** _${report.llmDecisions.riskAssessment}_\n\n`;
    }

    // Quiet scan
    if (report.executions.length === 0 && report.opportunities.length === 0 && report.signals.length === 0 && !report.llmDecisions) {
      message += '_No actionable signals this scan._\n';
    }

    await discord.swingScanner(message);
  }
}

module.exports = SwingScannerAgent;
