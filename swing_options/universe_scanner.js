/**
 * Universe Scanner - Comprehensive Stock Discovery
 *
 * Combines multiple sources to build a smart trading universe:
 * 1. Social Momentum - Reddit, StockTwits trending
 * 2. ETF Holdings - Major ETF constituents (SPY, QQQ, sector ETFs)
 * 3. Technical Screeners - RSI extremes, volume spikes, breakouts
 * 4. Options Universe - Stocks with liquid options
 * 5. Catalyst-Driven - Earnings, FOMC-sensitive, sector plays
 *
 * Goal: ~500-1000 quality stocks without API abuse
 */

const { yahoo, social, alphaVantage, aggregator } = require('./api_client');
const fs = require('fs');
const path = require('path');

// ============================================
// ETF HOLDINGS - Quality Stock Universe
// ============================================

// Major ETFs and their top holdings (updated periodically)
// This gives us ~500 liquid, institutional-quality stocks

const ETF_HOLDINGS = {
    // Broad Market
    SPY: {
        name: 'S&P 500',
        sector: 'broad',
        topHoldings: [
            'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'GOOG', 'META', 'BRK.B', 'TSLA', 'UNH',
            'XOM', 'JNJ', 'JPM', 'V', 'PG', 'MA', 'HD', 'CVX', 'MRK', 'ABBV',
            'LLY', 'PEP', 'COST', 'KO', 'AVGO', 'WMT', 'MCD', 'CSCO', 'TMO', 'ACN',
            'ABT', 'DHR', 'VZ', 'ADBE', 'CRM', 'NKE', 'CMCSA', 'PFE', 'NEE', 'TXN',
            'PM', 'INTC', 'ORCL', 'WFC', 'DIS', 'BMY', 'QCOM', 'AMD', 'UPS', 'RTX'
        ]
    },
    QQQ: {
        name: 'Nasdaq 100',
        sector: 'tech',
        topHoldings: [
            'AAPL', 'MSFT', 'AMZN', 'NVDA', 'META', 'AVGO', 'GOOGL', 'GOOG', 'TSLA', 'COST',
            'ADBE', 'AMD', 'NFLX', 'PEP', 'CSCO', 'INTC', 'CMCSA', 'TMUS', 'TXN', 'AMGN',
            'INTU', 'QCOM', 'HON', 'AMAT', 'ISRG', 'BKNG', 'SBUX', 'ADP', 'VRTX', 'MDLZ',
            'GILD', 'REGN', 'ADI', 'LRCX', 'PANW', 'MU', 'SNPS', 'CDNS', 'KLAC', 'MELI',
            'PYPL', 'MNST', 'MAR', 'ORLY', 'CTAS', 'FTNT', 'ABNB', 'MRVL', 'DXCM', 'WDAY'
        ]
    },

    // Sector ETFs
    XLF: {
        name: 'Financial Select',
        sector: 'financials',
        topHoldings: [
            'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'SPGI', 'AXP',
            'BLK', 'C', 'SCHW', 'CB', 'PGR', 'MMC', 'ICE', 'CME', 'AON', 'USB',
            'MET', 'AIG', 'TRV', 'PNC', 'AFL', 'ALL', 'PRU', 'MCO', 'MSCI', 'FIS'
        ]
    },
    XLE: {
        name: 'Energy Select',
        sector: 'energy',
        topHoldings: [
            'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PXD', 'PSX', 'VLO', 'OXY',
            'WMB', 'HES', 'KMI', 'HAL', 'DVN', 'FANG', 'BKR', 'TRGP', 'OKE', 'CTRA'
        ]
    },
    XLK: {
        name: 'Technology Select',
        sector: 'technology',
        topHoldings: [
            'AAPL', 'MSFT', 'NVDA', 'AVGO', 'CRM', 'ADBE', 'AMD', 'CSCO', 'ACN', 'ORCL',
            'TXN', 'INTC', 'QCOM', 'IBM', 'INTU', 'AMAT', 'NOW', 'ADI', 'LRCX', 'MU'
        ]
    },
    XLV: {
        name: 'Healthcare Select',
        sector: 'healthcare',
        topHoldings: [
            'UNH', 'JNJ', 'LLY', 'MRK', 'ABBV', 'PFE', 'TMO', 'ABT', 'DHR', 'AMGN',
            'BMY', 'CVS', 'MDT', 'ISRG', 'VRTX', 'GILD', 'REGN', 'CI', 'ELV', 'SYK'
        ]
    },
    XLY: {
        name: 'Consumer Discretionary',
        sector: 'consumer_discretionary',
        topHoldings: [
            'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
            'ORLY', 'MAR', 'GM', 'F', 'AZO', 'ROST', 'DHI', 'YUM', 'HLT', 'LULU'
        ]
    },
    XLP: {
        name: 'Consumer Staples',
        sector: 'consumer_staples',
        topHoldings: [
            'PG', 'COST', 'KO', 'PEP', 'WMT', 'PM', 'MO', 'MDLZ', 'CL', 'TGT',
            'GIS', 'KMB', 'SYY', 'STZ', 'KHC', 'HSY', 'K', 'ADM', 'KR', 'MKC'
        ]
    },
    XLI: {
        name: 'Industrial Select',
        sector: 'industrials',
        topHoldings: [
            'RTX', 'HON', 'UNP', 'UPS', 'CAT', 'DE', 'BA', 'LMT', 'GE', 'ADP',
            'MMM', 'NOC', 'CSX', 'ITW', 'FDX', 'NSC', 'WM', 'EMR', 'JCI', 'PH'
        ]
    },
    XLU: {
        name: 'Utilities Select',
        sector: 'utilities',
        topHoldings: [
            'NEE', 'DUK', 'SO', 'D', 'AEP', 'SRE', 'XEL', 'EXC', 'WEC', 'ED',
            'PEG', 'AWK', 'DTE', 'ES', 'EIX', 'FE', 'PPL', 'CMS', 'AEE', 'ATO'
        ]
    },
    XLRE: {
        name: 'Real Estate Select',
        sector: 'real_estate',
        topHoldings: [
            'PLD', 'AMT', 'EQIX', 'CCI', 'PSA', 'SPG', 'O', 'WELL', 'DLR', 'SBAC',
            'VICI', 'AVB', 'EQR', 'WY', 'VTR', 'ARE', 'IRM', 'CBRE', 'ESS', 'MAA'
        ]
    },
    XLB: {
        name: 'Materials Select',
        sector: 'materials',
        topHoldings: [
            'LIN', 'APD', 'SHW', 'FCX', 'ECL', 'NEM', 'DD', 'NUE', 'DOW', 'PPG',
            'CTVA', 'VMC', 'MLM', 'ALB', 'FMC', 'CF', 'MOS', 'IFF', 'CE', 'AVY'
        ]
    },

    // Thematic ETFs
    ARKK: {
        name: 'ARK Innovation',
        sector: 'innovation',
        topHoldings: [
            'TSLA', 'ROKU', 'COIN', 'SQ', 'PATH', 'ZM', 'HOOD', 'CRSP', 'DKNG', 'U',
            'TWLO', 'EXAS', 'NTLA', 'TDOC', 'DNA', 'BEAM', 'PLTR', 'RBLX', 'SHOP', 'TXG'
        ]
    },
    IWM: {
        name: 'Russell 2000',
        sector: 'small_cap',
        topHoldings: [
            // Top small caps - these change frequently
            'SMCI', 'MARA', 'RIOT', 'CVNA', 'PLUG', 'UPST', 'AFRM', 'SOFI', 'RIVN', 'LCID',
            'AMC', 'GME', 'BBBY', 'SPCE', 'PLTR', 'HOOD', 'COIN', 'PATH', 'SNOW', 'DKNG'
        ]
    },

    // High-Volume Meme/Momentum Universe
    MEME: {
        name: 'High Volatility Momentum',
        sector: 'momentum',
        topHoldings: [
            // Known high-volume momentum stocks
            'GME', 'AMC', 'BBBY', 'CVNA', 'UPST', 'RIVN', 'LCID', 'PLTR', 'SOFI', 'HOOD',
            'COIN', 'MARA', 'RIOT', 'AFRM', 'SNAP', 'RBLX', 'DKNG', 'SPCE', 'WISH', 'CLOV',
            'NKLA', 'GOEV', 'FFIE', 'MULN', 'BBIG', 'ATER', 'APRN', 'BKKT', 'DWAC', 'PHUN'
        ]
    }
};

// ============================================
// OPTIONS UNIVERSE - Stocks with Liquid Options
// ============================================

// Stocks known to have highly liquid options (tight spreads, volume)
const LIQUID_OPTIONS_UNIVERSE = [
    // Mega caps with massive options volume
    'SPY', 'QQQ', 'AAPL', 'MSFT', 'AMZN', 'NVDA', 'TSLA', 'META', 'GOOGL', 'AMD',
    'NFLX', 'DIS', 'BA', 'JPM', 'BAC', 'C', 'GS', 'XOM', 'CVX', 'WMT',

    // High-volume options stocks
    'COIN', 'HOOD', 'PLTR', 'SOFI', 'RIVN', 'LCID', 'NIO', 'F', 'GM', 'SNAP',
    'UBER', 'LYFT', 'SQ', 'PYPL', 'SHOP', 'ROKU', 'ZM', 'DKNG', 'PENN', 'WYNN',

    // Biotech with options activity
    'MRNA', 'BNTX', 'PFE', 'JNJ', 'ABBV', 'BMY', 'LLY', 'MRK', 'GILD', 'REGN',

    // Tech with liquid options
    'CRM', 'ORCL', 'ADBE', 'INTC', 'MU', 'AMAT', 'LRCX', 'QCOM', 'AVGO', 'TXN',

    // Retail/Consumer
    'TGT', 'COST', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD', 'CMG', 'LULU', 'GPS',

    // Energy
    'OXY', 'SLB', 'HAL', 'DVN', 'FANG', 'MRO', 'APA', 'COP', 'EOG', 'PXD',

    // Index/Sector ETFs
    'IWM', 'DIA', 'XLF', 'XLE', 'XLK', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU',
    'GLD', 'SLV', 'USO', 'TLT', 'HYG', 'VIX', 'UVXY', 'SQQQ', 'TQQQ', 'ARKK'
];

// ============================================
// UNIVERSE SCANNER CLASS
// ============================================

class UniverseScanner {
    constructor() {
        this.universe = new Set();
        this.stockData = new Map();
        this.cacheDir = path.join(__dirname, 'data', 'universe');
        this.lastScan = null;

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Build base universe from ETF holdings
     */
    buildETFUniverse() {
        const symbols = new Set();

        for (const [etf, data] of Object.entries(ETF_HOLDINGS)) {
            for (const symbol of data.topHoldings) {
                symbols.add(symbol);
            }
        }

        return Array.from(symbols);
    }

    /**
     * Add social momentum stocks
     */
    async addSocialMomentum() {
        const symbols = new Set();

        try {
            const trending = await social.getTrendingTickers();

            // Reddit trending
            if (trending.reddit?.length > 0) {
                for (const t of trending.reddit.slice(0, 30)) {
                    symbols.add(t.ticker);
                }
            }

            // StockTwits trending
            if (trending.stocktwits?.length > 0) {
                for (const t of trending.stocktwits.slice(0, 20)) {
                    symbols.add(t.ticker);
                }
            }
        } catch (e) {
            console.log('Social momentum scan error:', e.message);
        }

        return Array.from(symbols);
    }

    /**
     * Scan for technical setups (RSI extremes, volume spikes)
     */
    async scanTechnicalSetups(symbols) {
        const setups = {
            oversold: [],      // RSI < 30
            overbought: [],    // RSI > 70
            volumeSpike: [],   // Volume > 2x average
            breakout: [],      // Near 52-week high
            breakdown: []      // Near 52-week low
        };

        // Process in batches to avoid rate limits
        const batchSize = 10;
        const batches = [];

        for (let i = 0; i < symbols.length; i += batchSize) {
            batches.push(symbols.slice(i, i + batchSize));
        }

        for (const batch of batches.slice(0, 10)) { // Limit to first 100 stocks
            const promises = batch.map(async (symbol) => {
                try {
                    const shortData = await social.finvizShortData(symbol);

                    if (shortData) {
                        // RSI check
                        if (shortData.rsi && shortData.rsi < 30) {
                            setups.oversold.push({
                                symbol,
                                rsi: shortData.rsi,
                                price: shortData.price,
                                targetPrice: shortData.targetPrice,
                                shortFloat: shortData.shortFloat
                            });
                        } else if (shortData.rsi && shortData.rsi > 70) {
                            setups.overbought.push({
                                symbol,
                                rsi: shortData.rsi,
                                price: shortData.price
                            });
                        }
                    }
                } catch (e) {
                    // Skip on error
                }
            });

            await Promise.all(promises);

            // Small delay between batches
            await new Promise(r => setTimeout(r, 500));
        }

        return setups;
    }

    /**
     * Get sector-specific plays based on macro catalyst
     */
    getSectorPlays(catalyst) {
        const sectorPlays = {
            fomc: ['XLF', 'XLU', 'XLRE', 'TLT', 'JPM', 'BAC', 'WFC', 'GS'],
            cpi: ['XLP', 'XLY', 'TLT', 'COST', 'WMT', 'TGT', 'HD', 'LOW'],
            jobs: ['XLY', 'XRT', 'HD', 'LOW', 'TGT', 'AMZN', 'WMT'],
            energy: ['XLE', 'XOM', 'CVX', 'OXY', 'SLB', 'HAL', 'COP', 'DVN'],
            tech_earnings: ['XLK', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMD', 'GOOGL'],
            bank_earnings: ['XLF', 'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C'],
            retail_earnings: ['XRT', 'XLY', 'WMT', 'TGT', 'COST', 'HD', 'LOW'],
            biotech: ['XLV', 'XBI', 'IBB', 'MRNA', 'PFE', 'JNJ', 'LLY', 'REGN']
        };

        return sectorPlays[catalyst] || sectorPlays.tech_earnings;
    }

    /**
     * Filter universe for options liquidity
     */
    filterForOptionsLiquidity(symbols) {
        const liquidOptionsSet = new Set(LIQUID_OPTIONS_UNIVERSE);
        return symbols.filter(s => liquidOptionsSet.has(s));
    }

    /**
     * Build complete trading universe
     */
    async buildFullUniverse(options = {}) {
        console.log('Building trading universe...');
        const startTime = Date.now();

        const {
            includeSocial = true,
            includeTechnical = true,
            optionsOnly = false
        } = options;

        // Start with ETF holdings
        let universe = this.buildETFUniverse();
        console.log(`ETF Universe: ${universe.length} stocks`);

        // Add social momentum
        if (includeSocial) {
            const socialStocks = await this.addSocialMomentum();
            universe = [...new Set([...universe, ...socialStocks])];
            console.log(`After Social: ${universe.length} stocks`);
        }

        // Add liquid options universe
        universe = [...new Set([...universe, ...LIQUID_OPTIONS_UNIVERSE])];
        console.log(`After Options Universe: ${universe.length} stocks`);

        // Filter for options liquidity if requested
        if (optionsOnly) {
            universe = this.filterForOptionsLiquidity(universe);
            console.log(`Options-Only Filter: ${universe.length} stocks`);
        }

        // Remove any invalid symbols
        universe = universe.filter(s => {
            // Valid US stock symbol
            if (!s || s.length > 5) return false;
            if (s.includes('.') && !s.endsWith('.B')) return false; // Allow BRK.B
            if (/[0-9]/.test(s) && !['3M'].includes(s)) return false; // No warrants
            return true;
        });

        this.universe = new Set(universe);

        // Technical scan (optional, slower)
        let technicalSetups = null;
        if (includeTechnical) {
            console.log('Running technical scan...');
            technicalSetups = await this.scanTechnicalSetups(universe.slice(0, 100));
        }

        this.lastScan = new Date().toISOString();

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Universe built in ${elapsed}s: ${universe.length} total stocks`);

        const result = {
            universe: Array.from(this.universe),
            count: this.universe.size,
            technicalSetups,
            sources: {
                etf: this.buildETFUniverse().length,
                social: includeSocial ? 'included' : 'excluded',
                options: LIQUID_OPTIONS_UNIVERSE.length
            },
            timestamp: this.lastScan
        };

        // Save to cache
        fs.writeFileSync(
            path.join(this.cacheDir, 'universe.json'),
            JSON.stringify(result, null, 2)
        );

        return result;
    }

    /**
     * Get filtered universe by sector
     */
    getUniverseBySector(sector) {
        const sectorETF = Object.entries(ETF_HOLDINGS).find(([_, data]) => data.sector === sector);
        if (sectorETF) {
            return sectorETF[1].topHoldings;
        }
        return [];
    }

    /**
     * Get high-momentum subset
     */
    getMomentumUniverse() {
        return ETF_HOLDINGS.MEME.topHoldings;
    }

    /**
     * Get rate-sensitive stocks (for FOMC plays)
     */
    getRateSensitiveUniverse() {
        return [
            // Financials (benefit from higher rates)
            ...ETF_HOLDINGS.XLF.topHoldings.slice(0, 15),
            // Utilities (hurt by higher rates)
            ...ETF_HOLDINGS.XLU.topHoldings.slice(0, 10),
            // Real Estate (hurt by higher rates)
            ...ETF_HOLDINGS.XLRE.topHoldings.slice(0, 10),
            // Rate ETFs
            'TLT', 'IEF', 'SHY', 'BND', 'HYG', 'LQD'
        ];
    }

    /**
     * Get earnings-heavy universe (stocks reporting soon)
     */
    async getEarningsUniverse(daysAhead = 14) {
        try {
            const earnings = await alphaVantage.earningsCalendar();
            if (!Array.isArray(earnings)) return [];

            const today = new Date();
            const cutoff = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

            return earnings
                .filter(e => {
                    const reportDate = new Date(e.reportDate);
                    return reportDate >= today && reportDate <= cutoff;
                })
                .map(e => e.symbol)
                .filter(s => this.universe.has(s) || LIQUID_OPTIONS_UNIVERSE.includes(s))
                .slice(0, 50);
        } catch (e) {
            return [];
        }
    }

    /**
     * Format universe summary for Discord
     */
    formatForDiscord(result) {
        let msg = '**📊 TRADING UNIVERSE REPORT**\n\n';

        msg += `**Total Universe:** ${result.count} stocks\n`;
        msg += `**Sources:** ETF Holdings (${result.sources.etf}), Social (${result.sources.social}), Options (${result.sources.options})\n\n`;

        if (result.technicalSetups) {
            const setups = result.technicalSetups;

            if (setups.oversold?.length > 0) {
                msg += '**📉 Oversold (RSI < 30):**\n';
                for (const s of setups.oversold.slice(0, 5)) {
                    msg += `• **${s.symbol}** - RSI: ${s.rsi?.toFixed(1)} | $${s.price?.toFixed(2)}\n`;
                }
                msg += '\n';
            }

            if (setups.overbought?.length > 0) {
                msg += '**📈 Overbought (RSI > 70):**\n';
                for (const s of setups.overbought.slice(0, 5)) {
                    msg += `• **${s.symbol}** - RSI: ${s.rsi?.toFixed(1)} | $${s.price?.toFixed(2)}\n`;
                }
                msg += '\n';
            }
        }

        msg += `_Scanned at ${result.timestamp}_`;

        return msg;
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    UniverseScanner,
    ETF_HOLDINGS,
    LIQUID_OPTIONS_UNIVERSE
};

// CLI
if (require.main === module) {
    (async () => {
        const scanner = new UniverseScanner();
        const result = await scanner.buildFullUniverse({
            includeSocial: true,
            includeTechnical: true,
            optionsOnly: false
        });

        console.log('\n' + '='.repeat(50));
        console.log(scanner.formatForDiscord(result));
    })();
}
