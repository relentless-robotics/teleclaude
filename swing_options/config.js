/**
 * Swing Options Trading Toolkit - Configuration
 */

const path = require('path');

module.exports = {
    // API Keys
    apis: {
        fmp: {
            key: 'GJsH5DDiI7Fv0qtc1NaoQhj8awq0XwM8',
            baseUrl: 'https://financialmodelingprep.com/api/v3',
            rateLimit: 300 // calls per minute (Pro tier)
        },
        fred: {
            key: '09ec97a79c3e93445b817f2614956697',
            baseUrl: 'https://api.stlouisfed.org/fred',
            rateLimit: 120
        },
        alphaVantage: {
            key: process.env.ALPHA_VANTAGE_KEY || 'demo', // Get free key at alphavantage.co
            baseUrl: 'https://www.alphavantage.co/query',
            rateLimit: 5 // 5 calls/min on free tier, 75/min on premium
        },
        finnhub: {
            key: process.env.FINNHUB_KEY || '', // Get free key at finnhub.io
            baseUrl: 'https://finnhub.io/api/v1',
            rateLimit: 60 // 60 calls/min on free tier
        },
        secEdgar: {
            baseUrl: 'https://data.sec.gov',
            rateLimit: 10 // Be nice to SEC servers
        }
    },

    // Catalyst Detection Settings
    catalysts: {
        // Earnings
        earningsLookaheadDays: 14, // Scan for earnings within next 14 days
        earningsSurpriseThreshold: 0.05, // 5% beat/miss is notable

        // News
        newsLookaheadHours: 72,
        sentimentThreshold: {
            bullish: 0.6,
            bearish: -0.6
        },

        // SEC Filings
        filingsToMonitor: ['8-K', '4', '13F-HR', 'SC 13D', 'SC 13G'],
        insiderTransactionMinValue: 100000, // $100k minimum

        // Social/Reddit
        redditMinMentions: 50, // Minimum mentions to flag
        socialSentimentWindow: 24 // hours
    },

    // Options Analysis Settings
    options: {
        // IV Thresholds
        ivPercentile: {
            low: 25,    // Good for buying options
            high: 75    // Good for selling options
        },

        // Minimum liquidity
        minOpenInterest: 100,
        minVolume: 50,
        maxBidAskSpread: 0.10, // 10% max spread

        // Strategy preferences
        preferredStrategies: [
            'long_call',
            'long_put',
            'call_spread',
            'put_spread',
            'straddle',
            'strangle'
        ],

        // Risk parameters
        maxRiskPerTrade: 0.02, // 2% of portfolio
        minRewardRisk: 2.0,    // 2:1 reward/risk
        defaultDTE: {
            min: 14,
            max: 45
        }
    },

    // Stock Screening Criteria
    screening: {
        minMarketCap: 1e9,      // $1B minimum
        maxMarketCap: 500e9,    // $500B max (avoid mega caps)
        minAvgVolume: 500000,   // 500k shares/day
        minOptionVolume: 1000,  // Options volume
        sectors: null,          // null = all sectors
        excludeSectors: ['Utilities'] // Low volatility
    },

    // MacroStrategy Integration
    macroStrategy: {
        projectPath: 'C:\\Users\\Footb\\Documents\\Github\\MacroStrategy',
        useAlphaScores: true,
        minAlphaScore: 1.0 // Minimum alpha score to consider
    },

    // Output/Storage
    storage: {
        dataDir: path.join(__dirname, 'data'),
        cacheDir: path.join(__dirname, 'cache'),
        logsDir: path.join(__dirname, 'logs'),
        alertsFile: path.join(__dirname, 'data', 'alerts.json'),
        watchlistFile: path.join(__dirname, 'data', 'watchlist.json')
    },

    // Alert Settings
    alerts: {
        discord: true,
        minPriority: 'medium' // low, medium, high, critical
    }
};
