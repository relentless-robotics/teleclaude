/**
 * Options Analyzer
 *
 * Analyzes options chains and recommends strategies based on:
 * - IV percentile
 * - Expected move
 * - Risk/reward
 * - Greeks
 * - Catalyst timing
 */

const { fmp, aggregator } = require('./api_client');
const config = require('./config');

/**
 * Options strategy definitions
 */
const STRATEGIES = {
    long_call: {
        name: 'Long Call',
        outlook: 'bullish',
        ivPreference: 'low', // Buy when IV is low
        maxRisk: 'premium',
        maxReward: 'unlimited',
        breakeven: 'strike + premium',
        bestFor: ['strong bullish conviction', 'limited risk', 'leverage']
    },
    long_put: {
        name: 'Long Put',
        outlook: 'bearish',
        ivPreference: 'low',
        maxRisk: 'premium',
        maxReward: 'strike - premium (if stock goes to 0)',
        breakeven: 'strike - premium',
        bestFor: ['strong bearish conviction', 'hedging', 'leverage']
    },
    call_spread: {
        name: 'Bull Call Spread',
        outlook: 'moderately bullish',
        ivPreference: 'neutral',
        maxRisk: 'net debit',
        maxReward: 'spread width - net debit',
        breakeven: 'long strike + net debit',
        bestFor: ['moderate upside', 'defined risk', 'lower cost than long call']
    },
    put_spread: {
        name: 'Bear Put Spread',
        outlook: 'moderately bearish',
        ivPreference: 'neutral',
        maxRisk: 'net debit',
        maxReward: 'spread width - net debit',
        breakeven: 'long strike - net debit',
        bestFor: ['moderate downside', 'defined risk', 'lower cost than long put']
    },
    straddle: {
        name: 'Long Straddle',
        outlook: 'neutral (expecting big move)',
        ivPreference: 'low',
        maxRisk: 'total premium',
        maxReward: 'unlimited',
        breakeven: 'strike ± total premium',
        bestFor: ['earnings plays', 'binary events', 'expecting volatility']
    },
    strangle: {
        name: 'Long Strangle',
        outlook: 'neutral (expecting big move)',
        ivPreference: 'low',
        maxRisk: 'total premium',
        maxReward: 'unlimited',
        breakeven: 'call strike + premium OR put strike - premium',
        bestFor: ['cheaper than straddle', 'expecting large move', 'binary events']
    },
    iron_condor: {
        name: 'Iron Condor',
        outlook: 'neutral (expecting range-bound)',
        ivPreference: 'high', // Sell when IV is high
        maxRisk: 'spread width - net credit',
        maxReward: 'net credit',
        breakeven: 'short strikes ± net credit',
        bestFor: ['high IV environment', 'expecting low volatility', 'income']
    },
    covered_call: {
        name: 'Covered Call',
        outlook: 'neutral to slightly bullish',
        ivPreference: 'high',
        maxRisk: 'stock price - premium',
        maxReward: 'strike - stock price + premium',
        breakeven: 'stock price - premium',
        bestFor: ['income generation', 'willing to sell at strike', 'holding stock']
    }
};

/**
 * Options Analyzer Class
 */
class OptionsAnalyzer {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Calculate IV percentile based on historical IV
     */
    calculateIVPercentile(currentIV, historicalIVs) {
        if (!historicalIVs || historicalIVs.length === 0) return 50;

        const sorted = [...historicalIVs].sort((a, b) => a - b);
        const rank = sorted.filter(iv => iv < currentIV).length;
        return Math.round((rank / sorted.length) * 100);
    }

    /**
     * Calculate expected move based on IV and DTE
     */
    calculateExpectedMove(price, iv, dte) {
        // Expected move = Price × IV × √(DTE/365)
        const expectedMove = price * iv * Math.sqrt(dte / 365);
        const expectedMovePercent = (expectedMove / price) * 100;

        return {
            dollars: expectedMove,
            percent: expectedMovePercent,
            upperBound: price + expectedMove,
            lowerBound: price - expectedMove
        };
    }

    /**
     * Calculate simple Greeks (approximations)
     */
    calculateGreeks(option, stockPrice, riskFreeRate = 0.05, daysToExpiry) {
        const S = stockPrice;
        const K = option.strike;
        const T = daysToExpiry / 365;
        const r = riskFreeRate;
        const sigma = option.impliedVolatility || 0.3;

        // Simplified Black-Scholes Greeks
        const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
        const d2 = d1 - sigma * Math.sqrt(T);

        // Standard normal CDF approximation
        const N = (x) => {
            const a1 = 0.254829592;
            const a2 = -0.284496736;
            const a3 = 1.421413741;
            const a4 = -1.453152027;
            const a5 = 1.061405429;
            const p = 0.3275911;
            const sign = x < 0 ? -1 : 1;
            x = Math.abs(x) / Math.sqrt(2);
            const t = 1.0 / (1.0 + p * x);
            const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
            return 0.5 * (1.0 + sign * y);
        };

        const isCall = option.type === 'call';

        return {
            delta: isCall ? N(d1) : N(d1) - 1,
            gamma: Math.exp(-d1 * d1 / 2) / (S * sigma * Math.sqrt(2 * Math.PI * T)),
            theta: -(S * sigma * Math.exp(-d1 * d1 / 2)) / (2 * Math.sqrt(2 * Math.PI * T)) / 365,
            vega: S * Math.sqrt(T) * Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) / 100
        };
    }

    /**
     * Analyze options chain for a symbol
     */
    async analyzeChain(symbol) {
        const optionsData = await aggregator.getOptionsData(symbol);
        if (!optionsData.chain || optionsData.chain.length === 0) {
            return { error: 'No options chain available' };
        }

        const stockPrice = optionsData.currentPrice;
        const chain = optionsData.chain;

        // Group by expiration
        const expirations = {};
        for (const opt of chain) {
            const exp = opt.expirationDate;
            if (!expirations[exp]) {
                expirations[exp] = { calls: [], puts: [] };
            }
            if (opt.type === 'call') {
                expirations[exp].calls.push(opt);
            } else {
                expirations[exp].puts.push(opt);
            }
        }

        // Calculate average IV by expiration
        const ivByExpiration = {};
        for (const [exp, options] of Object.entries(expirations)) {
            const allOptions = [...options.calls, ...options.puts];
            const atmOptions = allOptions.filter(o =>
                Math.abs(o.strike - stockPrice) / stockPrice < 0.05
            );
            if (atmOptions.length > 0) {
                ivByExpiration[exp] = {
                    avgIV: atmOptions.reduce((sum, o) => sum + (o.impliedVolatility || 0), 0) / atmOptions.length,
                    dte: Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24))
                };
            }
        }

        return {
            symbol,
            stockPrice,
            historicalVolatility: optionsData.historicalVolatility,
            expirations: Object.keys(expirations).sort(),
            ivByExpiration,
            chainSize: chain.length,
            analysis: this.generateAnalysis(stockPrice, optionsData.historicalVolatility, ivByExpiration)
        };
    }

    /**
     * Generate analysis and recommendations
     */
    generateAnalysis(stockPrice, hv, ivByExpiration) {
        const analysis = {
            ivStatus: 'neutral',
            recommendations: []
        };

        // Find nearest expiration with data
        const exps = Object.entries(ivByExpiration)
            .filter(([_, data]) => data.dte >= config.options.defaultDTE.min)
            .sort((a, b) => a[1].dte - b[1].dte);

        if (exps.length === 0) {
            analysis.recommendations.push('No suitable expirations found');
            return analysis;
        }

        const [nearestExp, nearestData] = exps[0];
        const currentIV = nearestData.avgIV;

        // Compare IV to HV
        const ivHvRatio = currentIV / hv;

        if (ivHvRatio > 1.3) {
            analysis.ivStatus = 'high';
            analysis.recommendations.push('IV is elevated - consider selling premium (iron condor, credit spreads)');
        } else if (ivHvRatio < 0.8) {
            analysis.ivStatus = 'low';
            analysis.recommendations.push('IV is low - good for buying options (long calls/puts, straddles)');
        } else {
            analysis.ivStatus = 'neutral';
            analysis.recommendations.push('IV is fair - spreads offer balanced risk/reward');
        }

        // Calculate expected move
        const expectedMove = this.calculateExpectedMove(stockPrice, currentIV, nearestData.dte);
        analysis.expectedMove = expectedMove;
        analysis.recommendations.push(
            `Expected ${nearestData.dte}-day move: ±$${expectedMove.dollars.toFixed(2)} (±${expectedMove.percent.toFixed(1)}%)`
        );

        return analysis;
    }

    /**
     * Recommend strategy based on outlook and catalyst
     */
    recommendStrategy(outlook, catalyst, ivStatus) {
        const recommendations = [];

        if (catalyst?.type === 'earnings') {
            // Earnings plays
            if (ivStatus === 'low') {
                recommendations.push({
                    strategy: STRATEGIES.straddle,
                    reason: 'IV is low before earnings - straddle can profit from IV expansion and move'
                });
                recommendations.push({
                    strategy: STRATEGIES.strangle,
                    reason: 'Lower cost alternative to straddle for earnings volatility play'
                });
            } else {
                recommendations.push({
                    strategy: STRATEGIES.iron_condor,
                    reason: 'IV is already elevated - sell premium expecting IV crush post-earnings'
                });
            }
        } else {
            // Directional plays
            if (outlook === 'bullish') {
                if (ivStatus === 'high') {
                    recommendations.push({
                        strategy: STRATEGIES.call_spread,
                        reason: 'IV is high - spread reduces vega exposure while maintaining bullish bias'
                    });
                } else {
                    recommendations.push({
                        strategy: STRATEGIES.long_call,
                        reason: 'IV is fair/low - long call offers unlimited upside with limited risk'
                    });
                }
            } else if (outlook === 'bearish') {
                if (ivStatus === 'high') {
                    recommendations.push({
                        strategy: STRATEGIES.put_spread,
                        reason: 'IV is high - spread reduces vega exposure while maintaining bearish bias'
                    });
                } else {
                    recommendations.push({
                        strategy: STRATEGIES.long_put,
                        reason: 'IV is fair/low - long put for bearish conviction'
                    });
                }
            } else {
                // Neutral
                if (ivStatus === 'high') {
                    recommendations.push({
                        strategy: STRATEGIES.iron_condor,
                        reason: 'High IV + neutral outlook = sell premium with defined risk'
                    });
                } else {
                    recommendations.push({
                        strategy: STRATEGIES.straddle,
                        reason: 'Low IV + neutral outlook expecting move = buy volatility'
                    });
                }
            }
        }

        return recommendations;
    }

    /**
     * Find optimal strikes for a strategy
     */
    findOptimalStrikes(chain, stockPrice, strategy, dte) {
        // Filter by DTE
        const targetDate = new Date(Date.now() + dte * 24 * 60 * 60 * 1000);
        const relevantOptions = chain.filter(o => {
            const optDate = new Date(o.expirationDate);
            const optDte = Math.ceil((optDate - new Date()) / (1000 * 60 * 60 * 24));
            return optDte >= config.options.defaultDTE.min && optDte <= config.options.defaultDTE.max;
        });

        if (relevantOptions.length === 0) return null;

        // Find ATM and OTM strikes
        const calls = relevantOptions.filter(o => o.type === 'call').sort((a, b) => a.strike - b.strike);
        const puts = relevantOptions.filter(o => o.type === 'put').sort((a, b) => a.strike - b.strike);

        const atmCallIdx = calls.findIndex(c => c.strike >= stockPrice);
        const atmPutIdx = puts.findIndex(p => p.strike >= stockPrice) - 1;

        switch (strategy) {
            case 'long_call':
                // Slightly OTM call (1-2 strikes above ATM)
                return calls[Math.min(atmCallIdx + 1, calls.length - 1)];

            case 'long_put':
                // Slightly OTM put (1-2 strikes below ATM)
                return puts[Math.max(atmPutIdx - 1, 0)];

            case 'straddle':
                // ATM call and put
                return {
                    call: calls[atmCallIdx],
                    put: puts[atmPutIdx >= 0 ? atmPutIdx : 0]
                };

            case 'strangle':
                // OTM call and put
                return {
                    call: calls[Math.min(atmCallIdx + 2, calls.length - 1)],
                    put: puts[Math.max(atmPutIdx - 2, 0)]
                };

            default:
                return null;
        }
    }

    /**
     * Calculate position size based on risk
     */
    calculatePositionSize(accountSize, maxRiskPercent, optionPrice, contracts = 1) {
        const maxRiskDollars = accountSize * maxRiskPercent;
        const riskPerContract = optionPrice * 100; // Options are 100 shares
        const maxContracts = Math.floor(maxRiskDollars / riskPerContract);

        return {
            maxContracts,
            totalRisk: maxContracts * riskPerContract,
            riskPercent: (maxContracts * riskPerContract / accountSize) * 100
        };
    }

    /**
     * Generate trade recommendation
     */
    async generateTradeRecommendation(symbol, catalyst, outlook = 'neutral', accountSize = 10000) {
        const chainAnalysis = await this.analyzeChain(symbol);
        if (chainAnalysis.error) return chainAnalysis;

        const strategyRecs = this.recommendStrategy(
            outlook,
            catalyst,
            chainAnalysis.analysis.ivStatus
        );

        if (strategyRecs.length === 0) {
            return { error: 'No suitable strategies found' };
        }

        const primaryStrategy = strategyRecs[0];
        const strategyKey = Object.keys(STRATEGIES).find(
            k => STRATEGIES[k].name === primaryStrategy.strategy.name
        );

        // Get options chain
        const optionsData = await aggregator.getOptionsData(symbol);
        const optimalStrikes = this.findOptimalStrikes(
            optionsData.chain,
            optionsData.currentPrice,
            strategyKey,
            30 // Default 30 DTE
        );

        return {
            symbol,
            stockPrice: chainAnalysis.stockPrice,
            catalyst,
            outlook,
            ivStatus: chainAnalysis.analysis.ivStatus,
            expectedMove: chainAnalysis.analysis.expectedMove,
            recommendedStrategy: primaryStrategy,
            optimalStrikes,
            alternatives: strategyRecs.slice(1),
            positioning: this.calculatePositionSize(
                accountSize,
                config.options.maxRiskPerTrade,
                optimalStrikes?.ask || optimalStrikes?.call?.ask || 1
            ),
            timestamp: new Date().toISOString()
        };
    }
}

// Export
module.exports = {
    OptionsAnalyzer,
    STRATEGIES
};

// CLI
if (require.main === module) {
    (async () => {
        const analyzer = new OptionsAnalyzer();

        console.log('Analyzing AAPL options chain...\n');
        const analysis = await analyzer.analyzeChain('AAPL');
        console.log(JSON.stringify(analysis, null, 2));

        console.log('\n\nGenerating trade recommendation...\n');
        const rec = await analyzer.generateTradeRecommendation('AAPL', { type: 'earnings' }, 'bullish');
        console.log(JSON.stringify(rec, null, 2));
    })();
}
