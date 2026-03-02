/**
 * Research Dispatcher Agent
 *
 * Autonomous deep research agent that:
 * 1. Runs all research modules in parallel (earnings, insider, unusual activity, macro, social)
 * 2. Cross-references findings to score opportunities
 * 3. Writes top picks to shared brain watchlist
 * 4. Posts actionable DD summary to Discord
 * 5. Optionally uses Groq LLM to synthesize research into DD reports
 *
 * Runs: Pre-market (7:30 AM) + Mid-day refresh (12:00 PM) + After-hours scan (5:00 PM)
 */

const path = require('path');
const brain = require('../shared_brain');
const discord = require('../discord_channels');
const dataLayer = require('../research/data_layer');

// Research modules (Phase 1: discovery)
const earningsDeep = require('../research/earnings_deep');
const insiderTrades = require('../research/insider_trades');
const unusualActivity = require('../research/unusual_activity');
const macroEvents = require('../research/macro_events');
const socialSentiment = require('../research/social_sentiment');

// Research modules (Phase 2: deep analysis on top picks)
const technicalAnalysis = require('../research/technical_analysis');
const earningsRevisions = require('../research/earnings_revisions');
const optionsFlow = require('../research/options_flow');
const sectorRelative = require('../research/sector_relative');
const pickTracker = require('../research/pick_tracker');
const watchlistManager = require('../research/watchlist_manager');

// Try to load LLM for synthesis
let llmReason = null;
try {
  llmReason = require('../../utils/llm_reasoning');
} catch (e) { /* LLM optional */ }

/**
 * Fetch quote + key stats for a symbol via unified data layer
 * Uses Alpaca (primary) with Yahoo fallback, with caching + dedup
 */
async function fetchQuote(symbol) {
  return dataLayer.getSnapshot(symbol);
}

class ResearchDispatcher {
  constructor() {
    this.name = 'Research Dispatcher';
    this.emoji = '🔬';
    this.lastRun = null;
    this.lastResults = null;
  }

  /**
   * Main run - execute all research modules, score, and report
   */
  async run(mode = 'full') {
    const startTime = Date.now();
    console.log(`[${this.emoji}] ${this.name} starting ${mode} scan...`);

    const errors = [];

    // Phase 1: Run all research modules in parallel
    const [earnings, insider, unusual, macro, social] = await Promise.allSettled([
      this._safeRun('Earnings', earningsDeep.run()),
      this._safeRun('Insider', insiderTrades.run()),
      this._safeRun('Unusual Activity', unusualActivity.run()),
      this._safeRun('Macro', macroEvents.run()),
      this._safeRun('Social', socialSentiment.run()),
    ]);

    const data = {
      earnings: earnings.status === 'fulfilled' ? earnings.value : null,
      insider: insider.status === 'fulfilled' ? insider.value : null,
      unusual: unusual.status === 'fulfilled' ? unusual.value : null,
      macro: macro.status === 'fulfilled' ? macro.value : null,
      social: social.status === 'fulfilled' ? social.value : null,
    };

    // Track which modules succeeded
    const moduleStatus = {
      earnings: !!data.earnings,
      insider: !!data.insider,
      unusual: !!data.unusual,
      macro: !!data.macro,
      social: !!data.social,
    };

    // Phase 2: Extract and score all symbol opportunities
    const opportunities = this._scoreOpportunities(data);

    // Phase 3: Write to shared brain
    this._writeToBrain(data, opportunities);

    // Phase 4: Deep analysis on top picks (TA, options, earnings revisions, sector strength)
    const topSymbols = opportunities.slice(0, 8).map(o => o.symbol);
    let deepData = {};
    if (topSymbols.length > 0) {
      console.log(`  🔍 Deep analyzing ${topSymbols.length} symbols: ${topSymbols.join(', ')}`);
      const [ta, revisions, options, sectorStr] = await Promise.allSettled([
        this._safeRun('Technical Analysis', technicalAnalysis.run(topSymbols)),
        this._safeRun('Earnings Revisions', earningsRevisions.run(topSymbols.slice(0, 5))), // Finnhub rate limit
        this._safeRun('Options Flow', optionsFlow.run(topSymbols)),
        this._safeRun('Sector Relative', sectorRelative.run(topSymbols)),
      ]);

      deepData = {
        ta: ta.status === 'fulfilled' ? ta.value : {},
        revisions: revisions.status === 'fulfilled' ? revisions.value : {},
        options: options.status === 'fulfilled' ? options.value : {},
        sectorStrength: sectorStr.status === 'fulfilled' ? sectorStr.value : {},
      };

      // Attach deep data to each opportunity
      for (const opp of opportunities) {
        opp.ta = deepData.ta?.[opp.symbol] || null;
        opp.revisions = deepData.revisions?.[opp.symbol] || null;
        opp.options = deepData.options?.[opp.symbol] || null;
        opp.sectorStrength = deepData.sectorStrength?.[opp.symbol] || null;
        opp.quote = opp.ta ? { price: opp.ta.price, high52: opp.ta.high52, low52: opp.ta.low52 } : null;
      }
    }

    // Phase 5: Enrich top picks with price data (for any not covered by TA)
    const needsPrice = opportunities.filter(o => !o.quote).slice(0, 8);
    if (needsPrice.length > 0) {
      const enriched = await this._enrichTopPicks(needsPrice);
      for (const e of enriched) {
        const opp = opportunities.find(o => o.symbol === e.symbol);
        if (opp && !opp.quote) opp.quote = e.quote;
      }
    }

    // Phase 6: Generate deep DD via LLM with ALL data
    let deepDD = null;
    if (llmReason && opportunities.length > 0 && mode === 'full') {
      deepDD = await this._generateDeepDD(data, opportunities.slice(0, 5));
    }

    // Phase 7: Record picks for performance tracking
    try {
      const recorded = pickTracker.recordPicks(opportunities.filter(o => o.quote));
      console.log(`  📊 Recorded ${recorded} picks for tracking`);
    } catch (e) { console.error('[Research] Pick tracking error:', e.message); }

    // Phase 8: Update performance on old picks
    try {
      const perfUpdate = await pickTracker.updatePerformance();
      if (perfUpdate.updated > 0) console.log(`  📊 Updated ${perfUpdate.updated} pick performances`);
    } catch (e) { /* Fine if no old picks yet */ }

    // Phase 8.5: Auto-update watchlist from high-scoring opportunities
    try {
      const added = await watchlistManager.autoAddFromResearch(opportunities);
      if (added.length > 0) console.log(`  📋 Auto-added to watchlist: ${added.join(', ')}`);

      // Enrich watchlist with latest data
      await watchlistManager.enrichWatchlist();

      // Remove stale entries
      const staleCheck = watchlistManager.removeStale();
      if (staleCheck.removed > 0) console.log(`  📋 Removed ${staleCheck.removed} stale watchlist entries`);
    } catch (e) { console.error('[Research] Watchlist update error:', e.message); }

    // Phase 9: Post to Discord
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await this._postToDiscord(data, opportunities, moduleStatus, deepDD, elapsed, deepData);

    this.lastRun = new Date();
    this.lastResults = { opportunities: opportunities.length, modules: moduleStatus };

    const cacheStats = dataLayer.getCacheStats();
    console.log(`[${this.emoji}] ${this.name} completed in ${elapsed}s - ${opportunities.length} opportunities found (cache: ${cacheStats.entries} entries, source: ${cacheStats.hasAlpacaCreds ? 'Alpaca+Yahoo' : 'Yahoo only'})`);
    return { opportunities, moduleStatus, elapsed };
  }

  /**
   * Safe wrapper for running a research module
   */
  async _safeRun(name, promise) {
    try {
      const result = await Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
      ]);
      console.log(`  ✅ ${name} module completed`);
      return result;
    } catch (e) {
      console.error(`  ❌ ${name} module failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Score and rank opportunities from all data sources
   * Multi-signal confluence = higher score
   */
  _scoreOpportunities(data) {
    const symbolScores = {};

    const addSignal = (symbol, source, signal, weight = 1) => {
      if (!symbol || symbol.length > 5 || symbol.length < 1) return;
      if (!symbolScores[symbol]) {
        symbolScores[symbol] = { symbol, signals: [], score: 0, sources: new Set() };
      }
      symbolScores[symbol].signals.push({ source, signal });
      symbolScores[symbol].score += weight;
      symbolScores[symbol].sources.add(source);
    };

    // --- Earnings signals ---
    if (data.earnings?.upcoming?.earnings) {
      for (const e of data.earnings.upcoming.earnings) {
        addSignal(e.symbol, 'Earnings', `Reports ${e.date} ${e.hour || ''}`, 1);
      }
    }
    if (data.earnings?.surprises?.surprises) {
      for (const s of data.earnings.surprises.surprises) {
        if (s.beat) {
          addSignal(s.symbol, 'Earnings Beat', `Beat by ${s.surprisePct}`, 2);
        }
      }
    }

    // --- Insider buying signals (strong) ---
    if (data.insider?.openInsider?.trades) {
      for (const t of data.insider.openInsider.trades) {
        if (t.ticker) {
          addSignal(t.ticker, 'Insider Buy', `${t.owner} bought ${t.value}`, 3);
        }
      }
    }

    // --- Unusual volume/activity ---
    if (data.unusual?.movers?.gainers) {
      for (const g of data.unusual.movers.gainers) {
        addSignal(g.ticker, 'Top Gainer', `+${g.changePct}`, 1.5);
      }
    }
    if (data.unusual?.unusualVol?.unusualVolume) {
      for (const s of data.unusual.unusualVol.unusualVolume) {
        addSignal(s, 'Unusual Volume', '2x+ avg volume', 2);
      }
    }
    if (data.unusual?.optionsVol?.highOptionsVol) {
      for (const s of data.unusual.optionsVol.highOptionsVol) {
        addSignal(s, 'Options Volume', 'High options activity', 2);
      }
    }
    if (data.unusual?.breakouts?.breakouts) {
      for (const s of data.unusual.breakouts.breakouts) {
        addSignal(s, 'Breakout', '52-week high + volume', 2.5);
      }
    }
    if (data.unusual?.squeeze?.squeezeCandidates) {
      for (const s of data.unusual.squeeze.squeezeCandidates) {
        addSignal(s, 'Short Squeeze', 'High SI + rising', 2);
      }
    }

    // --- Social momentum ---
    if (data.social?.heatMap?.heatMap) {
      for (const item of data.social.heatMap.heatMap) {
        const weight = item.platforms.length > 1 ? 2 : 1;
        addSignal(item.symbol, 'Social Trending', `${item.platforms.join('+')}`, weight);
      }
    }
    if (data.social?.reddit?.trending) {
      for (const t of data.social.reddit.trending.slice(0, 10)) {
        if (t.sources?.length > 1) {
          addSignal(t.symbol, 'Reddit Multi-Sub', `${t.mentions} mentions across ${t.sources.join(',')}`, 1.5);
        }
      }
    }

    // Convert to sorted array, filter meaningful scores
    const ranked = Object.values(symbolScores)
      .map(s => ({
        ...s,
        sources: [...s.sources],
        sourceCount: s.sources.size,
      }))
      .filter(s => s.score >= 2) // At least 2 points to make the list
      .sort((a, b) => {
        // Primary: more sources = better (confluence)
        if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
        // Secondary: higher score
        return b.score - a.score;
      })
      .slice(0, 25);

    return ranked;
  }

  /**
   * Write research findings to the shared brain
   */
  _writeToBrain(data, opportunities) {
    try {
      // Write top opportunities to day watchlist
      for (const opp of opportunities.slice(0, 15)) {
        brain.addToWatchlist({
          symbol: opp.symbol,
          reason: opp.signals.map(s => `${s.source}: ${s.signal}`).join(' | '),
          source: 'research_dispatcher',
          conviction: Math.min(5, Math.round(opp.score)),
          sourceCount: opp.sourceCount,
          addedAt: new Date().toISOString(),
        });
      }

      // Write macro context
      if (data.macro?.sectors) {
        brain.writeMarket({
          sectorLeaders: data.macro.sectors.leaders?.map(s => `${s.symbol} (${s.sector}) ${s.weekChange}`) || [],
          sectorLaggards: data.macro.sectors.laggards?.map(s => `${s.symbol} (${s.sector}) ${s.weekChange}`) || [],
          regime: data.macro.sectors.regime || brain.ctx.market.regime,
        });
      }

      // Write catalysts
      if (data.earnings?.upcoming?.earnings) {
        brain.writeCatalysts({
          earningsThisWeek: data.earnings.upcoming.earnings.slice(0, 20).map(e => ({
            symbol: e.symbol,
            date: e.date,
            time: e.hour,
            epsEstimate: e.epsEstimate,
          })),
        });
      }

      // Write sentiment
      if (data.social?.heatMap) {
        brain.writeSentiment({
          socialMomentum: data.social.heatMap.heatMap.map(h => ({
            symbol: h.symbol,
            score: h.score,
            source: h.platforms.join('+'),
          })),
        });
      }

      // Write technicals from unusual activity
      if (data.unusual) {
        brain.writeTechnicals({
          breakouts: (data.unusual.breakouts?.breakouts || []).map(s => ({ symbol: s, level: '52w high', direction: 'up' })),
          volumeSpikes: (data.unusual.unusualVol?.unusualVolume || []).map(s => ({ symbol: s, volumeRatio: '2x+' })),
        });
      }

      // Write options flow
      if (data.unusual?.optionsVol) {
        brain.writeOptionsFlow({
          unusualActivity: (data.unusual.optionsVol.highOptionsVol || []).map(s => ({
            symbol: s,
            type: 'high_options_volume',
          })),
        });
      }

      brain.logAgent('research_dispatcher', 'Deep research scan completed', `${opportunities.length} opportunities scored`);

      // FIX 1: Write enriched research picks to persistent file for swing scanner
      brain.writeResearchPicks(opportunities.slice(0, 15));
    } catch (e) {
      console.error('[Research] Brain write error:', e.message);
    }
  }

  /**
   * Fetch price data for top picks via data layer (batch snapshot = 1 API call)
   */
  async _enrichTopPicks(topOpps) {
    const symbols = topOpps.map(o => o.symbol);
    const snapshots = await dataLayer.getSnapshots(symbols);
    return topOpps
      .map(opp => ({ ...opp, quote: snapshots[opp.symbol] || null }))
      .filter(e => e.quote !== null);
  }

  /**
   * Generate deep DD with LONG and SHORT thesis for each top pick
   * Uses Groq LLM with full research context
   */
  async _generateDeepDD(data, enrichedPicks) {
    try {
      if (enrichedPicks.length === 0) return null;

      // Build rich context for each pick with ALL available data
      const pickDetails = enrichedPicks.slice(0, 5).map((pick, i) => {
        const q = pick.quote || {};
        const ta = pick.ta || {};
        const opts = pick.options || {};
        const rev = pick.revisions || {};
        const sector = pick.sectorStrength || {};
        const signals = pick.signals.map(s => `- ${s.source}: ${s.signal}`).join('\n');

        // Find any earnings data for this symbol
        const earningsInfo = data.earnings?.upcoming?.earnings?.find(e => e.symbol === pick.symbol);
        const earningsSurprise = data.earnings?.surprises?.surprises?.find(s => s.symbol === pick.symbol);
        const insiderBuy = data.insider?.openInsider?.trades?.find(t => t.ticker === pick.symbol);

        let context = `${i + 1}. **${pick.symbol}** (Confluence Score: ${pick.score.toFixed(1)}, ${pick.sourceCount} independent sources)

PRICE & TECHNICALS:
- Price: $${ta.price || q.price || 'N/A'}
- Trend: ${ta.trend || 'N/A'}
- RSI(14): ${ta.rsi || 'N/A'}${ta.rsi < 30 ? ' [OVERSOLD]' : ta.rsi > 70 ? ' [OVERBOUGHT]' : ''}
- MACD: ${ta.macd ? `${ta.macd.macd} (signal: ${ta.macd.signal}, ${ta.macd.trend})${ta.macd.crossover !== 'NONE' ? ' [' + ta.macd.crossover + ' CROSSOVER]' : ''}` : 'N/A'}
- SMA20: ${ta.sma?.sma20 || 'N/A'} (${ta.sma?.priceVsSMA20 || 'N/A'}) | SMA50: ${ta.sma?.sma50 || 'N/A'} (${ta.sma?.priceVsSMA50 || 'N/A'})
- 52w High: $${ta.high52 || q.high52 || 'N/A'} | 52w Low: $${ta.low52 || q.low52 || 'N/A'}
- Volume: ${ta.volume?.volumeRatio || 'N/A'}x avg (${ta.volume?.volumeTrend || 'N/A'})
- Support: ${ta.supportResistance?.support?.slice(0, 2).map(s => '$' + s.price).join(', ') || 'N/A'}
- Resistance: ${ta.supportResistance?.resistance?.slice(0, 2).map(r => '$' + r.price).join(', ') || 'N/A'}
- TA Signals: ${ta.signals?.join(', ') || 'none'}`;

        // Sector relative strength
        if (sector.strength) {
          context += `\n\nSECTOR RELATIVE:
- Sector: ${sector.sector} (${sector.sectorETF})
- Stock Week: ${sector.stockWeekChange}% | Sector Week: ${sector.sectorWeekChange}%
- Relative Strength: ${sector.relativeWeekStrength > 0 ? '+' : ''}${sector.relativeWeekStrength}% (${sector.strength})`;
        }

        // Options flow
        if (opts.putCallRatio !== undefined) {
          context += `\n\nOPTIONS FLOW (exp: ${opts.expiration}):
- Put/Call Ratio: ${opts.putCallRatio}${opts.putCallRatio < 0.7 ? ' [BULLISH]' : opts.putCallRatio > 1.2 ? ' [BEARISH]' : ''}
- Call Vol: ${opts.totalCallVol} | Put Vol: ${opts.totalPutVol}
- IV Skew: ${opts.ivSkew !== null ? opts.ivSkew + '%' : 'N/A'}${opts.ivSkew > 15 ? ' [FEAR/HEDGING]' : opts.ivSkew < -10 ? ' [SPECULATIVE]' : ''}
- Max Pain: $${opts.maxPain || 'N/A'} (stock at $${opts.stockPrice})
- Expected Move: $${opts.expectedMove} (${opts.expectedMovePct || 'N/A'})`;
          if (opts.unusualCalls?.length > 0) {
            context += `\n- Unusual Calls: ${opts.unusualCalls.slice(0, 3).map(c => `$${c.strike} (${c.volume}v/${c.oi}oi)`).join(', ')}`;
          }
          if (opts.unusualPuts?.length > 0) {
            context += `\n- Unusual Puts: ${opts.unusualPuts.slice(0, 3).map(p => `$${p.strike} (${p.volume}v/${p.oi}oi)`).join(', ')}`;
          }
          if (opts.signals?.length > 0) {
            context += `\n- Options Signals: ${opts.signals.join(', ')}`;
          }
        }

        // Earnings revisions
        if (rev.overallRevision) {
          context += `\n\nEARNINGS REVISIONS: ${rev.overallRevision}`;
          if (rev.recommendationTrend) {
            context += `\n- Analyst Consensus: ${rev.recommendationTrend.consensus} (${rev.recommendationTrend.current?.buyPct}% buy)`;
            context += `\n- Revision Direction: ${rev.recommendationTrend.revisionDirection}`;
            if (rev.recommendationTrend.previous) {
              context += ` (was ${rev.recommendationTrend.previous.buyPct}% buy)`;
            }
          }
          if (rev.surpriseHistory) {
            context += `\n- Beat Rate: ${rev.surpriseHistory.beatRate} (last ${rev.surpriseHistory.history?.length || 0} quarters)`;
            context += `\n- Avg Surprise: ${rev.surpriseHistory.avgSurprise}`;
            if (rev.surpriseHistory.beatsInRow) {
              context += `\n- Streak: ${rev.surpriseHistory.beatsInRow.count} consecutive ${rev.surpriseHistory.beatsInRow.type}`;
            }
          }
          if (rev.signals?.length > 0) {
            context += `\n- Revision Signals: ${rev.signals.join(', ')}`;
          }
        }

        // Upcoming earnings
        if (earningsInfo) {
          context += `\nUPCOMING EARNINGS: Reports ${earningsInfo.date} ${earningsInfo.hour || ''}, EPS est: ${earningsInfo.epsEstimate || 'N/A'}`;
        }
        if (earningsSurprise) {
          context += `\nLAST QUARTER: ${earningsSurprise.beat ? 'BEAT' : 'MISSED'} by ${earningsSurprise.surprisePct}`;
        }

        // Insider buying
        if (insiderBuy) {
          context += `\nINSIDER BUY: ${insiderBuy.owner} bought ${insiderBuy.value} at $${insiderBuy.price}`;
        }

        context += `\n\nRESEARCH SIGNALS:\n${signals}`;

        return context;
      }).join('\n\n---\n\n');

      // Build macro context
      const macroCtx = [];
      if (data.macro?.sectors?.regime) macroCtx.push(`Sector Regime: ${data.macro.sectors.regime}`);
      if (data.macro?.sectors?.leaders?.length > 0) {
        macroCtx.push(`Leading Sectors: ${data.macro.sectors.leaders.slice(0, 3).map(s => `${s.sector} (${s.weekChange})`).join(', ')}`);
      }
      if (data.macro?.sectors?.laggards?.length > 0) {
        macroCtx.push(`Lagging Sectors: ${data.macro.sectors.laggards.slice(0, 3).map(s => `${s.sector} (${s.weekChange})`).join(', ')}`);
      }
      if (data.macro?.breadth?.breadthSignal) {
        macroCtx.push(`Breadth: ${data.macro.breadth.breadthSignal} (RSP-SPY: ${data.macro.breadth.breadthDivergence || 'N/A'}%)`);
      }
      if (data.macro?.macro?.VIX) macroCtx.push(`VIX: ${data.macro.macro.VIX.value}`);
      if (data.macro?.macro?.Yield_Curve) macroCtx.push(`Yield Curve (10Y-2Y): ${data.macro.macro.Yield_Curve.value}`);

      // Get signal weights from pick tracker (learn from past performance)
      let signalWeightNote = '';
      try {
        const weights = pickTracker.getSignalWeights();
        const notableWeights = Object.entries(weights).filter(([_, w]) => w !== 1.0);
        if (notableWeights.length > 0) {
          signalWeightNote = `\nHISTORICAL SIGNAL PERFORMANCE (from our pick tracker):
${notableWeights.map(([sig, w]) => `- ${sig}: ${w > 1 ? 'historically predictive' : 'historically weak'} (${w.toFixed(1)}x weight)`).join('\n')}
Use this to calibrate your conviction — weight signals that have historically worked for us more heavily.`;
        }
      } catch (e) { /* No history yet */ }

      const prompt = `You are a senior equity research analyst writing actionable trade ideas. You have access to comprehensive data: technicals (RSI, MACD, SMA, S/R levels), options flow (put/call ratio, unusual activity, IV skew, max pain), earnings revisions (analyst upgrades/downgrades, beat rate, surprise history), and sector-relative strength.

You MUST present BOTH sides of every trade — never be blindly bullish or bearish. The bear case must be genuine.

MACRO ENVIRONMENT:
${macroCtx.join('\n') || 'N/A'}
${signalWeightNote}

TOP RESEARCH PICKS (ranked by multi-source signal confluence):

${pickDetails}

---

For EACH symbol above, write a structured DD with EXACTLY this format:

**[SYMBOL] — [one-line verdict: e.g. "Bullish setup with defined risk" or "Avoid until earnings clarity"]**

BULL CASE (Long Thesis):
• [2-3 bullet points citing SPECIFIC data: RSI levels, support zones, analyst upgrades, insider buys, options flow]
• [Include price targets based on resistance levels and expected moves]

BEAR CASE (Short Thesis / What Could Go Wrong):
• [2-3 bullet points with REAL risks: MACD bearish, sector underperformance, put skew, revision downgrades]
• [Include downside support levels and what invalidates the thesis]

VERDICT: [LONG / SHORT / WAIT / AVOID]
CONVICTION: [1-5] (use technicals + options flow + revisions to calibrate)
KEY TRIGGER: [The ONE thing to watch — a specific price level, earnings date, or options expiry]
VEHICLE: [Shares / Calls / Puts / Spread — based on IV environment and expected move]

---

RULES:
- Use the ACTUAL technical, options, and revision data provided — cite specific numbers
- Reference RSI, MACD signals, support/resistance, put/call ratio, IV skew in your thesis
- The bear case must cite specific technical or fundamental weaknesses — not generic "could go down"
- If options show HIGH put skew or bearish flow, that's a real warning even if price looks bullish
- If sector relative strength is UNDERPERFORMER, that's bearish context even in a bullish stock
- If analyst revisions are DOWNGRADING, flag it prominently
- If there's no clear edge, say WAIT or AVOID — don't force a trade
- Keep each symbol to ~200 words`;

      const messages = [
        { role: 'system', content: 'You are a senior equity research analyst. You always present both bull and bear cases with evidence. You never recommend blindly — if the data doesn\'t support a clear trade, you say so.' },
        { role: 'user', content: prompt },
      ];

      const response = await llmReason.callLLMWithFallback(messages, {
        maxTokens: 4000,
        temperature: 0.3,
      });

      const content = typeof response === 'string' ? response : (response?.content || '');
      console.log(`  ✅ Deep DD generated (${content.length} chars)`);
      return content;
    } catch (e) {
      console.error('[Research] Deep DD generation failed:', e.message);
      return null;
    }
  }

  /**
   * Format and post findings to Discord (overview + deep DD + pick tracker)
   */
  async _postToDiscord(data, opportunities, moduleStatus, deepDD, elapsed, deepData = {}) {
    const moduleStatusLine = Object.entries(moduleStatus)
      .map(([name, ok]) => `${ok ? '✅' : '❌'} ${name}`)
      .join(' | ');

    // === MESSAGE 1: Overview + Market Context ===
    let msg1 = `${this.emoji} **DEEP RESEARCH SCAN** (${elapsed}s)\n`;
    msg1 += `Modules: ${moduleStatusLine}\n\n`;

    // Top opportunities scoreboard with TA data
    if (opportunities.length > 0) {
      msg1 += `**🎯 TOP OPPORTUNITIES** (${opportunities.length} found)\n`;
      msg1 += '```\n';
      msg1 += 'Sym    Price     RSI   Trend       P/C   Sector   Score\n';
      msg1 += '─────  ────────  ────  ──────────  ────  ───────  ─────\n';
      for (const opp of opportunities.slice(0, 10)) {
        const price = opp.ta?.price ? `$${opp.ta.price.toFixed(2)}`.padEnd(9) : opp.quote?.price ? `$${opp.quote.price.toFixed(2)}`.padEnd(9) : 'N/A      ';
        const rsi = opp.ta?.rsi ? String(opp.ta.rsi).padEnd(5) : 'N/A  ';
        const trend = (opp.ta?.trend || 'N/A').substring(0, 10).padEnd(12);
        const pc = opp.options?.putCallRatio ? String(opp.options.putCallRatio).padEnd(5) : 'N/A  ';
        const sect = (opp.sectorStrength?.strength || 'N/A').substring(0, 7).padEnd(8);
        msg1 += `${opp.symbol.padEnd(6)} ${price} ${rsi} ${trend} ${pc} ${sect} ${opp.score.toFixed(1)}\n`;
      }
      msg1 += '```\n';
    } else {
      msg1 += '**No strong multi-signal opportunities found.**\n\n';
    }

    // Sector rotation
    if (data.macro?.sectors) {
      msg1 += `**📊 MACRO** ${data.macro.sectors.regime}`;
      msg1 += ` | Risk-On: ${data.macro.sectors.riskOnAvg} | Risk-Off: ${data.macro.sectors.riskOffAvg}\n`;
      if (data.macro.sectors.leaders?.length > 0) {
        msg1 += `Leaders: ${data.macro.sectors.leaders.slice(0, 3).map(s => `${s.sector} ${s.weekChange}`).join(', ')}\n`;
      }
    }

    // Market breadth
    if (data.macro?.breadth?.breadthSignal) {
      msg1 += `Breadth: ${data.macro.breadth.breadthSignal}`;
      if (data.macro.breadth.breadthDivergence) msg1 += ` (RSP-SPY: ${data.macro.breadth.breadthDivergence}%)`;
      msg1 += '\n';
    }

    // Quick hits: insider buys, breakouts, squeeze, social
    const quickHits = [];
    if (data.insider?.openInsider?.trades?.length > 0) {
      quickHits.push(`💰 **Insider Buys:** ${data.insider.openInsider.trades.slice(0, 4).map(t => `${t.ticker} (${t.value})`).join(', ')}`);
    }
    if (data.unusual?.breakouts?.breakouts?.length > 0) {
      quickHits.push(`🚀 **Breakouts:** ${data.unusual.breakouts.breakouts.slice(0, 6).join(', ')}`);
    }
    if (data.unusual?.squeeze?.squeezeCandidates?.length > 0) {
      quickHits.push(`⚡ **Squeeze:** ${data.unusual.squeeze.squeezeCandidates.slice(0, 5).join(', ')}`);
    }
    if (data.social?.heatMap?.heatMap?.length > 0) {
      const multiPlat = data.social.heatMap.heatMap.filter(h => h.platforms.length > 1);
      if (multiPlat.length > 0) {
        quickHits.push(`🔥 **Social Heat:** ${multiPlat.slice(0, 5).map(h => h.symbol).join(', ')}`);
      }
    }
    if (data.earnings?.upcoming?.count > 0) {
      quickHits.push(`📅 **Earnings:** ${data.earnings.upcoming.count} reports next 7 days`);
    }
    if (quickHits.length > 0) {
      msg1 += '\n' + quickHits.join('\n') + '\n';
    }

    msg1 += `\n_Watchlist updated with ${Math.min(opportunities.length, 15)} candidates_`;

    // Post overview
    try {
      await discord.send('swingScanner', msg1);
    } catch (e) {
      console.error('[Research] Discord overview post failed:', e.message);
    }

    // === MESSAGE 2: Deep DD with Bull/Bear Thesis ===
    if (deepDD && deepDD.length > 50) {
      const ddMsg = `📋 **DEEP DD — BULL/BEAR THESIS**\n\n${deepDD}`;
      try {
        await discord.send('swingScanner', ddMsg);
      } catch (e) {
        console.error('[Research] Discord DD post failed:', e.message);
      }
    }

    // === MESSAGE 3: Pick Tracker Performance (if we have history) ===
    try {
      const trackerReport = pickTracker.formatReportForDiscord();
      if (trackerReport && !trackerReport.includes('No completed picks yet')) {
        await discord.send('swingScanner', trackerReport);
      }
    } catch (e) { /* No tracker data yet, that's fine */ }
  }
}

module.exports = ResearchDispatcher;

// CLI: node trading_agents/agents/research_dispatcher.js [mode]
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  const mode = process.argv[2] || 'full';
  const dispatcher = new ResearchDispatcher();
  dispatcher.run(mode).then(result => {
    console.log(`\nDone. ${result.opportunities.length} opportunities, ${result.elapsed}s`);
    process.exit(0);
  }).catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
