/**
 * Catalyst Scanner
 *
 * Monitors for events that could trigger significant stock moves:
 * - Earnings announcements
 * - FDA decisions
 * - SEC filings (8-K, insider trades)
 * - Analyst upgrades/downgrades
 * - Social media buzz
 * - Unusual options activity
 */

const { fmp, fred, sec, finnhub, social, aggregator } = require('./api_client');
const config = require('./config');
const fs = require('fs');
const path = require('path');

/**
 * Catalyst types and their typical impact
 */
const CATALYST_TYPES = {
    earnings: {
        description: 'Quarterly earnings announcement',
        typicalIVIncrease: 0.3, // 30% IV increase before earnings
        typicalMove: 0.05, // 5% average move
        timing: 'before', // Trade before the event
        strategies: ['straddle', 'strangle', 'iron_condor']
    },
    fda_decision: {
        description: 'FDA drug approval/rejection',
        typicalIVIncrease: 0.5,
        typicalMove: 0.20, // 20% for biotech
        timing: 'before',
        strategies: ['straddle', 'strangle']
    },
    insider_buying: {
        description: 'Significant insider purchases',
        typicalIVIncrease: 0.1,
        typicalMove: 0.03,
        timing: 'after', // Trade after the signal
        strategies: ['long_call', 'call_spread']
    },
    analyst_upgrade: {
        description: 'Analyst upgrade with price target increase',
        typicalIVIncrease: 0.05,
        typicalMove: 0.03,
        timing: 'after',
        strategies: ['long_call', 'call_spread']
    },
    social_buzz: {
        description: 'High social media mentions/sentiment',
        typicalIVIncrease: 0.2,
        typicalMove: 0.10,
        timing: 'early', // Get in early
        strategies: ['long_call', 'long_put', 'straddle']
    },
    sec_8k: {
        description: 'Material event SEC filing',
        typicalIVIncrease: 0.15,
        typicalMove: 0.05,
        timing: 'after',
        strategies: ['long_call', 'long_put']
    },
    unusual_options: {
        description: 'Unusual options activity detected',
        typicalIVIncrease: 0.1,
        typicalMove: 0.05,
        timing: 'follow', // Follow the smart money
        strategies: ['match_flow'] // Match the unusual activity
    }
};

/**
 * Main Catalyst Scanner Class
 */
class CatalystScanner {
    constructor() {
        this.catalysts = [];
        this.watchlist = this.loadWatchlist();
        this.lastScan = null;
    }

    /**
     * Load watchlist from file
     */
    loadWatchlist() {
        try {
            if (fs.existsSync(config.storage.watchlistFile)) {
                return JSON.parse(fs.readFileSync(config.storage.watchlistFile, 'utf8'));
            }
        } catch (e) {
            console.error('Error loading watchlist:', e.message);
        }
        return { symbols: [], updated: null };
    }

    /**
     * Save watchlist to file
     */
    saveWatchlist() {
        this.watchlist.updated = new Date().toISOString();
        fs.writeFileSync(config.storage.watchlistFile, JSON.stringify(this.watchlist, null, 2));
    }

    /**
     * Add symbol to watchlist
     */
    addToWatchlist(symbol, reason = '') {
        if (!this.watchlist.symbols.find(s => s.symbol === symbol)) {
            this.watchlist.symbols.push({
                symbol,
                reason,
                addedAt: new Date().toISOString()
            });
            this.saveWatchlist();
        }
    }

    /**
     * Scan for upcoming earnings
     * Optimized for free API limits - uses Yahoo Finance for quick filtering
     */
    async scanEarnings() {
        const today = new Date().toISOString().split('T')[0];
        const future = new Date(Date.now() + config.catalysts.earningsLookaheadDays * 24 * 60 * 60 * 1000)
            .toISOString().split('T')[0];

        const earnings = await fmp.earningsCalendar(today, future);
        if (!earnings || !Array.isArray(earnings)) return [];

        // Filter to well-known symbols first (skip OTC, foreign, etc.)
        const knownSymbols = earnings.filter(e => {
            const sym = e.symbol || '';
            // Skip if > 5 chars (likely foreign), contains numbers (warrants), or starts with certain patterns
            if (sym.length > 5) return false;
            if (/[0-9]/.test(sym)) return false;
            if (sym.includes('.')) return false;
            return true;
        }).slice(0, 50); // Process max 50 to respect API limits

        const catalysts = [];

        // Use Yahoo Finance for quick market cap check (free, no limit)
        for (const e of knownSymbols) {
            try {
                // Use aggregator to get basic stock data from Yahoo (fast, free)
                const quote = await fmp.quote(e.symbol);
                if (!quote) continue;

                // Skip small caps and mega caps
                const marketCap = quote.marketCap || 0;
                if (marketCap < config.screening.minMarketCap) continue;
                if (marketCap > config.screening.maxMarketCap) continue;

                // Calculate days until earnings
                const daysUntil = Math.ceil((new Date(e.date) - new Date()) / (1000 * 60 * 60 * 24));

                catalysts.push({
                    type: 'earnings',
                    symbol: e.symbol,
                    company: e.symbol, // Use symbol as name (avoid extra API call)
                    date: e.date,
                    time: e.time || 'unknown',
                    daysUntil,
                    epsEstimate: e.epsEstimated,
                    revenueEstimate: e.revenueEstimated,
                    marketCap: marketCap,
                    sector: null, // Skip to save API calls
                    industry: null,
                    priority: daysUntil <= 7 ? 'high' : 'medium',
                    meta: CATALYST_TYPES.earnings
                });
            } catch (err) {
                // Skip on error, continue with next
                continue;
            }
        }

        return catalysts.sort((a, b) => a.daysUntil - b.daysUntil);
    }

    /**
     * Scan for insider trading activity
     */
    async scanInsiderActivity() {
        const insiders = await fmp.insiderTradingLatest(100);
        if (!insiders || !Array.isArray(insiders)) return [];

        const catalysts = [];
        const symbolBuys = {};

        // Aggregate buys by symbol
        for (const trade of insiders) {
            if (trade.transactionType !== 'P-Purchase') continue; // Only buys
            if (trade.securitiesTransacted * trade.price < config.catalysts.insiderTransactionMinValue) continue;

            const symbol = trade.symbol;
            if (!symbolBuys[symbol]) {
                symbolBuys[symbol] = {
                    totalValue: 0,
                    trades: []
                };
            }
            symbolBuys[symbol].totalValue += trade.securitiesTransacted * trade.price;
            symbolBuys[symbol].trades.push(trade);
        }

        // Convert to catalysts
        for (const [symbol, data] of Object.entries(symbolBuys)) {
            if (data.totalValue < config.catalysts.insiderTransactionMinValue) continue;

            catalysts.push({
                type: 'insider_buying',
                symbol,
                totalValue: data.totalValue,
                tradeCount: data.trades.length,
                trades: data.trades.slice(0, 3).map(t => ({
                    name: t.reportingName,
                    title: t.typeOfOwner,
                    shares: t.securitiesTransacted,
                    price: t.price,
                    date: t.transactionDate
                })),
                priority: data.totalValue > 1000000 ? 'high' : 'medium',
                meta: CATALYST_TYPES.insider_buying
            });
        }

        return catalysts.sort((a, b) => b.totalValue - a.totalValue);
    }

    /**
     * Scan for social media buzz (Reddit + StockTwits combined)
     */
    async scanSocialBuzz() {
        const trending = await social.getTrendingTickers();

        const catalysts = [];

        // Process combined trending (Reddit + StockTwits)
        const tickersToProcess = trending.combined?.length > 0
            ? trending.combined.slice(0, 20)
            : trending.reddit?.slice(0, 20) || [];

        for (const t of tickersToProcess) {
            const mentions = t.redditMentions || t.mentions || 0;
            const watchlist = t.stocktwitsWatchlist || 0;

            // Skip if below minimum activity
            if (mentions < config.catalysts.redditMinMentions && watchlist < 50000) continue;

            // Get stock data
            let quote = null;
            try {
                quote = await fmp.quote(t.ticker);
            } catch (err) {
                continue;
            }

            if (!quote) continue;

            // Calculate combined social score
            const socialScore = (mentions / 100) + (watchlist / 100000);

            catalysts.push({
                type: 'social_buzz',
                symbol: t.ticker,
                mentions: mentions,
                stocktwitsWatchlist: watchlist,
                sources: t.sources || ['reddit'],
                rank: t.redditRank || t.rank,
                price: quote.price,
                change: quote.changesPercentage,
                volume: quote.volume,
                avgVolume: quote.avgVolume,
                volumeRatio: quote.volume / (quote.avgVolume || quote.volume),
                socialScore,
                priority: (mentions > 200 || watchlist > 100000) ? 'high' : 'medium',
                meta: CATALYST_TYPES.social_buzz
            });
        }

        // Sort by social score
        catalysts.sort((a, b) => b.socialScore - a.socialScore);

        return catalysts;
    }

    /**
     * Scan for analyst upgrades/downgrades
     */
    async scanAnalystActions(symbols) {
        const catalysts = [];

        for (const symbol of symbols) {
            try {
                const recs = await finnhub.recommendations(symbol);
                if (!recs || recs.length < 2) continue;

                const latest = recs[0];
                const previous = recs[1];

                // Check for upgrade
                const currentScore = latest.buy * 3 + latest.hold * 2 + latest.sell * 1;
                const previousScore = previous.buy * 3 + previous.hold * 2 + previous.sell * 1;

                if (currentScore > previousScore * 1.1) { // 10% improvement
                    catalysts.push({
                        type: 'analyst_upgrade',
                        symbol,
                        period: latest.period,
                        buyRatings: latest.buy,
                        holdRatings: latest.hold,
                        sellRatings: latest.sell,
                        strongBuyRatings: latest.strongBuy,
                        scoreChange: ((currentScore / previousScore) - 1) * 100,
                        priority: 'medium',
                        meta: CATALYST_TYPES.analyst_upgrade
                    });
                }
            } catch (e) {
                // Skip on error
            }
        }

        return catalysts;
    }

    /**
     * Scan for unusual options activity
     */
    async scanUnusualOptions(symbols) {
        const catalysts = [];

        for (const symbol of symbols) {
            try {
                const quote = await fmp.quote(symbol);
                if (!quote) continue;

                // Check if options volume is unusually high
                // (This is a simplified version - real UOA detection is more complex)
                const optionVolume = quote.sharesOutstanding * 0.001; // Placeholder
                const avgOptionVolume = optionVolume * 0.8;

                if (optionVolume > avgOptionVolume * 2) {
                    catalysts.push({
                        type: 'unusual_options',
                        symbol,
                        optionVolume,
                        avgOptionVolume,
                        ratio: optionVolume / avgOptionVolume,
                        price: quote.price,
                        priority: 'medium',
                        meta: CATALYST_TYPES.unusual_options
                    });
                }
            } catch (e) {
                // Skip on error
            }
        }

        return catalysts;
    }

    /**
     * Run full catalyst scan
     */
    async runFullScan(options = {}) {
        console.log('Starting full catalyst scan...');
        const startTime = Date.now();

        const results = {
            earnings: [],
            insiders: [],
            social: [],
            analysts: [],
            unusualOptions: [],
            timestamp: new Date().toISOString()
        };

        // Run scans in parallel where possible
        const [earnings, insiders, social] = await Promise.all([
            this.scanEarnings(),
            this.scanInsiderActivity(),
            this.scanSocialBuzz()
        ]);

        results.earnings = earnings;
        results.insiders = insiders;
        results.social = social;

        // Get symbols from social buzz for additional scans
        const socialSymbols = social.map(s => s.symbol).slice(0, 20);

        if (socialSymbols.length > 0 && config.apis.finnhub.key) {
            results.analysts = await this.scanAnalystActions(socialSymbols);
        }

        // Combine all catalysts
        this.catalysts = [
            ...results.earnings,
            ...results.insiders,
            ...results.social,
            ...results.analysts,
            ...results.unusualOptions
        ];

        // Sort by priority
        this.catalysts.sort((a, b) => {
            const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            return priorityOrder[a.priority] - priorityOrder[b.priority];
        });

        this.lastScan = new Date().toISOString();

        // Save results
        const outputFile = path.join(config.storage.dataDir, 'latest_catalysts.json');
        fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Scan complete in ${elapsed}s. Found ${this.catalysts.length} catalysts.`);

        return results;
    }

    /**
     * Get top opportunities
     */
    getTopOpportunities(limit = 10) {
        return this.catalysts.slice(0, limit);
    }

    /**
     * Filter catalysts by type
     */
    filterByType(type) {
        return this.catalysts.filter(c => c.type === type);
    }

    /**
     * Format catalysts for Discord
     */
    formatForDiscord(catalysts = null) {
        const items = catalysts || this.catalysts.slice(0, 15);
        if (items.length === 0) return 'No catalysts found.';

        let msg = '**🎯 CATALYST SCANNER RESULTS**\n\n';

        // Group by type
        const byType = {};
        for (const c of items) {
            if (!byType[c.type]) byType[c.type] = [];
            byType[c.type].push(c);
        }

        // Format each type
        if (byType.earnings?.length > 0) {
            msg += '**📅 Upcoming Earnings:**\n';
            for (const e of byType.earnings.slice(0, 5)) {
                msg += `• **${e.symbol}** - ${e.date} (${e.daysUntil}d) | EPS Est: $${e.epsEstimate || 'N/A'}\n`;
            }
            msg += '\n';
        }

        if (byType.insider_buying?.length > 0) {
            msg += '**💰 Insider Buying:**\n';
            for (const i of byType.insider_buying.slice(0, 5)) {
                msg += `• **${i.symbol}** - $${(i.totalValue / 1e6).toFixed(2)}M bought (${i.tradeCount} trades)\n`;
            }
            msg += '\n';
        }

        if (byType.social_buzz?.length > 0) {
            msg += '**🗣️ Social Buzz (Reddit):**\n';
            for (const s of byType.social_buzz.slice(0, 5)) {
                const volEmoji = s.volumeRatio > 2 ? '🔥' : '';
                msg += `• **${s.symbol}** - ${s.mentions} mentions | ${s.change?.toFixed(1)}% ${volEmoji}\n`;
            }
            msg += '\n';
        }

        msg += `\n_Scanned at ${this.lastScan}_`;
        return msg;
    }
}

// Export
module.exports = {
    CatalystScanner,
    CATALYST_TYPES
};

// CLI
if (require.main === module) {
    (async () => {
        const scanner = new CatalystScanner();
        const results = await scanner.runFullScan();

        console.log('\n=== TOP CATALYSTS ===\n');
        console.log(scanner.formatForDiscord());
    })();
}
