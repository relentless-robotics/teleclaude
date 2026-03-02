/**
 * Swing Trading Options Engine
 *
 * The main orchestrator that combines:
 * - Catalyst detection
 * - Options analysis
 * - MacroStrategy GA scores
 * - Trade recommendations
 *
 * Designed to run daily scans and provide actionable trade ideas.
 */

const { fmp, fred, aggregator, social } = require('./api_client');
const { CatalystScanner, CATALYST_TYPES } = require('./catalyst_scanner');
const { OptionsAnalyzer, STRATEGIES } = require('./options_analyzer');
const config = require('./config');
const fs = require('fs');
const path = require('path');

/**
 * Main Swing Trading Engine
 */
class SwingEngine {
    constructor() {
        this.catalystScanner = new CatalystScanner();
        this.optionsAnalyzer = new OptionsAnalyzer();
        this.tradeIdeas = [];
        this.marketContext = null;
        this.lastRun = null;
    }

    /**
     * Load MacroStrategy alpha scores if available
     */
    async loadMacroStrategyScores() {
        try {
            const predictionsDir = path.join(config.macroStrategy.projectPath, 'predictions');
            if (!fs.existsSync(predictionsDir)) return {};

            // Find latest predictions file
            const files = fs.readdirSync(predictionsDir)
                .filter(f => f.startsWith('fresh_predictions') && f.endsWith('.json'))
                .sort()
                .reverse();

            if (files.length === 0) return {};

            const latestFile = path.join(predictionsDir, files[0]);
            const predictions = JSON.parse(fs.readFileSync(latestFile, 'utf8'));

            // Convert to symbol -> score map
            const scores = {};
            if (predictions.predictions) {
                for (const [symbol, data] of Object.entries(predictions.predictions)) {
                    scores[symbol] = data.alpha_score || data.score || 0;
                }
            }

            console.log(`Loaded ${Object.keys(scores).length} MacroStrategy scores`);
            return scores;
        } catch (e) {
            console.log('MacroStrategy scores not available:', e.message);
            return {};
        }
    }

    /**
     * Get current market context (VIX, trend, sector performance)
     */
    async getMarketContext() {
        console.log('Fetching market context...');

        const [marketOverview, vixData, yieldCurve] = await Promise.all([
            aggregator.getMarketOverview(),
            fred.vix(),
            fred.yieldCurveSpread()
        ]);

        const vix = parseFloat(vixData?.observations?.slice(-1)[0]?.value) || 20;
        const yieldSpread = parseFloat(yieldCurve?.observations?.slice(-1)[0]?.value) || 0;

        // Determine market regime
        let regime = 'neutral';
        if (vix > 25) regime = 'high_volatility';
        else if (vix < 15) regime = 'low_volatility';

        let yieldSignal = 'normal';
        if (yieldSpread < 0) yieldSignal = 'inverted'; // Recession warning
        else if (yieldSpread > 1) yieldSignal = 'steep'; // Growth expected

        this.marketContext = {
            vix,
            vixLevel: vix > 25 ? 'high' : vix < 15 ? 'low' : 'normal',
            regime,
            yieldCurve: {
                spread: yieldSpread,
                signal: yieldSignal
            },
            topGainers: marketOverview.gainers.slice(0, 5).map(g => ({
                symbol: g.symbol,
                change: g.changesPercentage
            })),
            topLosers: marketOverview.losers.slice(0, 5).map(l => ({
                symbol: l.symbol,
                change: l.changesPercentage
            })),
            sectorPerformance: marketOverview.sectorPerformance,
            timestamp: new Date().toISOString()
        };

        return this.marketContext;
    }

    /**
     * Score a potential trade opportunity
     */
    scoreOpportunity(catalyst, optionsAnalysis, macroScore = 0) {
        let score = 0;
        const factors = [];

        // Catalyst strength (0-30 points)
        const catalystWeight = {
            earnings: 25,
            fda_decision: 30,
            insider_buying: 20,
            analyst_upgrade: 15,
            social_buzz: 15, // Increased from 10
            unusual_options: 15
        };
        score += catalystWeight[catalyst.type] || 10;
        factors.push(`Catalyst (${catalyst.type}): +${catalystWeight[catalyst.type] || 10}`);

        // Priority bonus
        if (catalyst.priority === 'high') {
            score += 10;
            factors.push('High priority: +10');
        } else if (catalyst.priority === 'critical') {
            score += 20;
            factors.push('Critical priority: +20');
        }

        // IV status (0-15 points) - give baseline when unknown
        if (optionsAnalysis?.ivStatus === 'low') {
            score += 15; // Good for buying
            factors.push('Low IV (good for buying): +15');
        } else if (optionsAnalysis?.ivStatus === 'high') {
            score += 5; // Can sell premium
            factors.push('High IV (can sell premium): +5');
        } else if (optionsAnalysis?.ivStatus === 'neutral') {
            score += 10;
            factors.push('Neutral IV: +10');
        } else {
            // Unknown IV - give moderate score
            score += 8;
            factors.push('IV unknown (assume moderate): +8');
        }

        // MacroStrategy alpha score (0-25 points)
        if (macroScore > 5) {
            score += 25;
            factors.push(`Strong alpha score (${macroScore.toFixed(1)}): +25`);
        } else if (macroScore > 2) {
            score += 15;
            factors.push(`Good alpha score (${macroScore.toFixed(1)}): +15`);
        } else if (macroScore > 0) {
            score += 5;
            factors.push(`Weak alpha score (${macroScore.toFixed(1)}): +5`);
        }

        // Volume/liquidity bonus
        if (catalyst.volumeRatio && catalyst.volumeRatio > 2) {
            score += 10;
            factors.push('High volume: +10');
        }

        // Social buzz bonus (for Reddit mentions)
        if (catalyst.mentions && catalyst.mentions > 100) {
            score += 10;
            factors.push(`High mentions (${catalyst.mentions}): +10`);
        } else if (catalyst.mentions && catalyst.mentions > 50) {
            score += 5;
            factors.push(`Moderate mentions (${catalyst.mentions}): +5`);
        }

        // Timing bonus (earnings within 7 days)
        if (catalyst.daysUntil && catalyst.daysUntil <= 7 && catalyst.daysUntil >= 2) {
            score += 10;
            factors.push('Good timing (2-7 days): +10');
        }

        return {
            totalScore: score,
            factors,
            grade: score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D'
        };
    }

    /**
     * Generate trade idea from catalyst
     */
    async generateTradeIdea(catalyst, macroScores) {
        const symbol = catalyst.symbol;

        // Try to get options analysis (may fail due to API limitations)
        let optionsAnalysis = null;
        try {
            const result = await this.optionsAnalyzer.analyzeChain(symbol);
            if (!result.error) {
                optionsAnalysis = result;
            }
        } catch (e) {
            // Options data unavailable - continue without it
        }

        // Get macro score
        const macroScore = macroScores[symbol] || 0;

        // Score the opportunity (works without options data)
        const scoring = this.scoreOpportunity(catalyst, optionsAnalysis?.analysis, macroScore);

        // Lower threshold when options data unavailable
        const minScore = optionsAnalysis ? 35 : 25;
        if (scoring.totalScore < minScore) {
            return null;
        }

        // Determine outlook based on catalyst and macro score
        let outlook = 'neutral';
        if (catalyst.type === 'insider_buying' || macroScore > 2) {
            outlook = 'bullish';
        } else if (macroScore < -2) {
            outlook = 'bearish';
        } else if (catalyst.type === 'social_buzz' && catalyst.volumeRatio > 2) {
            outlook = 'bullish'; // High social + volume = bullish momentum
        }

        // Get strategy recommendation (works without options data)
        const ivStatus = optionsAnalysis?.analysis?.ivStatus || 'neutral';
        const strategyRecs = this.optionsAnalyzer.recommendStrategy(outlook, catalyst, ivStatus);

        // Estimate expected move based on catalyst type (when no options data)
        let expectedMove = optionsAnalysis?.analysis?.expectedMove;
        if (!expectedMove && catalyst.meta?.typicalMove) {
            const price = catalyst.price || 100;
            const movePercent = catalyst.meta.typicalMove * 100;
            expectedMove = {
                percent: movePercent,
                dollars: price * catalyst.meta.typicalMove,
                upperBound: price * (1 + catalyst.meta.typicalMove),
                lowerBound: price * (1 - catalyst.meta.typicalMove)
            };
        }

        return {
            symbol,
            catalyst,
            optionsAnalysis: optionsAnalysis?.analysis || { ivStatus: 'unknown', note: 'Options data unavailable' },
            macroScore,
            outlook,
            scoring,
            recommendedStrategies: strategyRecs.slice(0, 2),
            expectedMove,
            marketContext: {
                vix: this.marketContext?.vix,
                regime: this.marketContext?.regime
            },
            generatedAt: new Date().toISOString()
        };
    }

    /**
     * Run the full daily scan
     */
    async runDailyScan() {
        console.log('\n' + '='.repeat(60));
        console.log('SWING OPTIONS DAILY SCAN');
        console.log('='.repeat(60) + '\n');

        const startTime = Date.now();
        this.tradeIdeas = [];

        // Step 1: Get market context
        await this.getMarketContext();
        console.log(`Market Context: VIX=${this.marketContext.vix}, Regime=${this.marketContext.regime}\n`);

        // Step 2: Load MacroStrategy scores
        const macroScores = await this.loadMacroStrategyScores();

        // Step 3: Run catalyst scan
        console.log('Scanning for catalysts...');
        const catalystResults = await this.catalystScanner.runFullScan();

        // Step 4: Generate trade ideas from top catalysts
        console.log('\nGenerating trade ideas...');
        const allCatalysts = [
            ...catalystResults.earnings.slice(0, 10),
            ...catalystResults.insiders.slice(0, 5),
            ...catalystResults.social.slice(0, 10)
        ];

        for (const catalyst of allCatalysts) {
            try {
                const idea = await this.generateTradeIdea(catalyst, macroScores);
                if (idea) {
                    this.tradeIdeas.push(idea);
                }
            } catch (e) {
                console.log(`Error generating idea for ${catalyst.symbol}:`, e.message);
            }
        }

        // Sort by score
        this.tradeIdeas.sort((a, b) => b.scoring.totalScore - a.scoring.totalScore);

        // Save results
        const outputFile = path.join(config.storage.dataDir, 'daily_scan.json');
        fs.writeFileSync(outputFile, JSON.stringify({
            marketContext: this.marketContext,
            catalysts: catalystResults,
            tradeIdeas: this.tradeIdeas,
            timestamp: new Date().toISOString()
        }, null, 2));

        this.lastRun = new Date().toISOString();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`\nScan complete in ${elapsed}s`);
        console.log(`Found ${this.tradeIdeas.length} trade ideas\n`);

        return {
            marketContext: this.marketContext,
            tradeIdeas: this.tradeIdeas,
            catalysts: catalystResults
        };
    }

    /**
     * Get top trade ideas
     */
    getTopIdeas(limit = 5) {
        return this.tradeIdeas.slice(0, limit);
    }

    /**
     * Format results for Discord
     */
    formatForDiscord() {
        if (this.tradeIdeas.length === 0) {
            return '**No trade ideas found today.** Market may be quiet or no clear catalysts.';
        }

        let msg = '**🎯 SWING OPTIONS - DAILY SCAN RESULTS**\n\n';

        // Market context
        msg += '**📊 Market Context:**\n';
        msg += `• VIX: ${this.marketContext.vix?.toFixed(1)} (${this.marketContext.vixLevel})\n`;
        msg += `• Regime: ${this.marketContext.regime}\n`;
        msg += `• Yield Curve: ${this.marketContext.yieldCurve?.signal}\n\n`;

        // Top trade ideas
        msg += '**🔥 TOP TRADE IDEAS:**\n\n';

        for (const idea of this.tradeIdeas.slice(0, 5)) {
            const grade = idea.scoring.grade;
            const gradeEmoji = grade === 'A' ? '🅰️' : grade === 'B' ? '🅱️' : '©️';

            msg += `${gradeEmoji} **${idea.symbol}** - Score: ${idea.scoring.totalScore}/100\n`;
            msg += `   Catalyst: ${idea.catalyst.type}`;
            if (idea.catalyst.daysUntil) msg += ` (${idea.catalyst.daysUntil} days)`;
            msg += '\n';
            msg += `   Outlook: ${idea.outlook} | IV: ${idea.optionsAnalysis?.ivStatus || 'N/A'}\n`;

            if (idea.recommendedStrategies?.[0]) {
                msg += `   Strategy: **${idea.recommendedStrategies[0].strategy.name}**\n`;
            }

            if (idea.expectedMove) {
                msg += `   Expected Move: ±${idea.expectedMove.percent?.toFixed(1)}%\n`;
            }

            if (idea.macroScore > 0) {
                msg += `   Alpha Score: ${idea.macroScore.toFixed(2)}\n`;
            }

            msg += '\n';
        }

        msg += `_Scanned at ${this.lastRun}_`;
        return msg;
    }

    /**
     * Get detailed analysis for a specific symbol
     */
    async analyzeSymbol(symbol) {
        console.log(`\nAnalyzing ${symbol}...`);

        // Get all data
        const [stockData, optionsAnalysis, quote] = await Promise.all([
            aggregator.getStockData(symbol),
            this.optionsAnalyzer.analyzeChain(symbol),
            fmp.quote(symbol)
        ]);

        // Get news sentiment if Finnhub is configured
        let sentiment = null;
        if (config.apis.finnhub.key) {
            const { finnhub } = require('./api_client');
            sentiment = await finnhub.newsSentiment(symbol);
        }

        // Check for catalysts
        const catalysts = [];

        // Upcoming earnings
        const today = new Date().toISOString().split('T')[0];
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const earnings = await fmp.earningsCalendar(today, future);
        const symbolEarnings = earnings?.find(e => e.symbol === symbol);
        if (symbolEarnings) {
            catalysts.push({
                type: 'earnings',
                date: symbolEarnings.date,
                epsEstimate: symbolEarnings.epsEstimated
            });
        }

        return {
            symbol,
            price: quote?.price,
            change: quote?.changesPercentage,
            volume: quote?.volume,
            avgVolume: quote?.avgVolume,
            marketCap: stockData.profile?.mktCap,
            sector: stockData.profile?.sector,
            industry: stockData.profile?.industry,
            optionsAnalysis: optionsAnalysis?.analysis,
            recentNews: stockData.news?.slice(0, 3),
            recentInsiders: stockData.insiders?.slice(0, 3),
            sentiment,
            catalysts,
            timestamp: new Date().toISOString()
        };
    }
}

// Export
module.exports = { SwingEngine };

// CLI
if (require.main === module) {
    (async () => {
        const engine = new SwingEngine();

        const args = process.argv.slice(2);
        const command = args[0];

        switch (command) {
            case 'scan':
                await engine.runDailyScan();
                console.log(engine.formatForDiscord());
                break;

            case 'analyze':
                const symbol = args[1];
                if (!symbol) {
                    console.log('Usage: node swing_engine.js analyze <SYMBOL>');
                    break;
                }
                const analysis = await engine.analyzeSymbol(symbol.toUpperCase());
                console.log(JSON.stringify(analysis, null, 2));
                break;

            case 'market':
                const context = await engine.getMarketContext();
                console.log(JSON.stringify(context, null, 2));
                break;

            default:
                console.log('Swing Trading Options Engine');
                console.log('Usage:');
                console.log('  node swing_engine.js scan          - Run daily scan');
                console.log('  node swing_engine.js analyze <SYM> - Analyze specific symbol');
                console.log('  node swing_engine.js market        - Get market context');
        }
    })();
}
