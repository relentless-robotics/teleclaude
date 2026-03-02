/**
 * Macro Catalyst Scanner - Expanded Universe
 *
 * Extends catalyst detection beyond earnings to include:
 * - FOMC/Fed decisions and speeches
 * - Economic data releases (CPI, Jobs, GDP, etc.)
 * - Government policy and committee votes
 * - Legal/regulatory events (FDA, antitrust)
 * - Company events (investor days, product launches)
 * - Geopolitical events
 *
 * Uses free data sources where possible.
 */

const { fred, alphaVantage, social, yahoo } = require('./api_client');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// CATALYST TYPE DEFINITIONS
// ============================================

const MACRO_CATALYST_TYPES = {
    // Fed/Monetary Policy
    fomc_meeting: {
        description: 'FOMC rate decision meeting',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.15,
        affectedSectors: ['all', 'financials', 'real_estate', 'utilities'],
        strategies: ['straddle', 'vix_calls', 'sector_rotation']
    },
    fed_speech: {
        description: 'Federal Reserve official speech',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.05,
        affectedSectors: ['all'],
        strategies: ['watch_reaction']
    },
    fed_minutes: {
        description: 'FOMC meeting minutes release',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.08,
        affectedSectors: ['all'],
        strategies: ['watch_reaction']
    },

    // Economic Data
    cpi_release: {
        description: 'Consumer Price Index (inflation)',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.12,
        affectedSectors: ['all', 'consumer_discretionary', 'consumer_staples'],
        strategies: ['straddle', 'sector_play']
    },
    jobs_report: {
        description: 'Non-Farm Payrolls / Employment',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.10,
        affectedSectors: ['all', 'consumer_discretionary'],
        strategies: ['straddle', 'sector_play']
    },
    gdp_release: {
        description: 'GDP growth data',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.08,
        affectedSectors: ['all'],
        strategies: ['index_play']
    },
    pce_release: {
        description: 'PCE Price Index (Fed preferred inflation)',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.10,
        affectedSectors: ['all'],
        strategies: ['rate_sensitive_play']
    },
    retail_sales: {
        description: 'Retail Sales data',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.05,
        affectedSectors: ['consumer_discretionary', 'retail'],
        strategies: ['sector_play']
    },
    ism_manufacturing: {
        description: 'ISM Manufacturing PMI',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.05,
        affectedSectors: ['industrials', 'materials'],
        strategies: ['sector_play']
    },
    housing_data: {
        description: 'Housing starts/permits/sales',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.03,
        affectedSectors: ['real_estate', 'homebuilders', 'materials'],
        strategies: ['sector_play']
    },
    consumer_confidence: {
        description: 'Consumer Confidence Index',
        typicalMarketImpact: 'low',
        typicalVIXIncrease: 0.02,
        affectedSectors: ['consumer_discretionary'],
        strategies: ['sector_play']
    },

    // Government/Policy
    congress_vote: {
        description: 'Major congressional vote/bill',
        typicalMarketImpact: 'varies',
        typicalVIXIncrease: 0.05,
        affectedSectors: ['depends_on_bill'],
        strategies: ['sector_play', 'news_trade']
    },
    treasury_auction: {
        description: 'Treasury bond auction',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.03,
        affectedSectors: ['financials', 'utilities'],
        strategies: ['rate_play']
    },
    debt_ceiling: {
        description: 'Debt ceiling vote/deadline',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.20,
        affectedSectors: ['all'],
        strategies: ['vix_play', 'hedging']
    },

    // Regulatory
    fda_decision: {
        description: 'FDA drug approval decision',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.50, // For specific stock
        affectedSectors: ['healthcare', 'biotech'],
        strategies: ['straddle', 'binary_play']
    },
    sec_ruling: {
        description: 'SEC regulatory decision',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.05,
        affectedSectors: ['financials', 'crypto'],
        strategies: ['sector_play']
    },
    antitrust_ruling: {
        description: 'Antitrust/DOJ decision',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.15,
        affectedSectors: ['tech', 'healthcare'],
        strategies: ['stock_specific']
    },
    trade_decision: {
        description: 'Trade policy/tariff decision',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.12,
        affectedSectors: ['industrials', 'tech', 'consumer'],
        strategies: ['sector_rotation']
    },

    // Company Events
    investor_day: {
        description: 'Company investor day/analyst day',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.10,
        affectedSectors: ['stock_specific'],
        strategies: ['long_call', 'straddle']
    },
    product_launch: {
        description: 'Major product launch/announcement',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.08,
        affectedSectors: ['stock_specific'],
        strategies: ['long_call', 'long_put']
    },
    conference: {
        description: 'Industry conference presentation',
        typicalMarketImpact: 'low',
        typicalVIXIncrease: 0.05,
        affectedSectors: ['sector_specific'],
        strategies: ['watch_for_news']
    },

    // Geopolitical
    election: {
        description: 'Major election (US or global)',
        typicalMarketImpact: 'high',
        typicalVIXIncrease: 0.25,
        affectedSectors: ['all'],
        strategies: ['vix_play', 'hedging', 'sector_rotation']
    },
    geopolitical_event: {
        description: 'Geopolitical tension/resolution',
        typicalMarketImpact: 'varies',
        typicalVIXIncrease: 0.15,
        affectedSectors: ['energy', 'defense', 'all'],
        strategies: ['vix_play', 'sector_play']
    },
    central_bank_global: {
        description: 'Major global central bank decision (ECB, BOJ, BOE)',
        typicalMarketImpact: 'medium',
        typicalVIXIncrease: 0.08,
        affectedSectors: ['forex_sensitive', 'multinationals'],
        strategies: ['fx_play', 'multinational_stocks']
    }
};

// ============================================
// FOMC SCHEDULE (Updated regularly)
// ============================================

// 2026 FOMC Meeting Schedule (8 scheduled meetings per year)
const FOMC_SCHEDULE_2026 = [
    { date: '2026-01-28', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-01-29', type: 'decision', description: 'FOMC Rate Decision' },
    { date: '2026-03-17', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-03-18', type: 'decision', description: 'FOMC Rate Decision + SEP' },
    { date: '2026-05-05', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-05-06', type: 'decision', description: 'FOMC Rate Decision' },
    { date: '2026-06-16', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-06-17', type: 'decision', description: 'FOMC Rate Decision + SEP' },
    { date: '2026-07-28', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-07-29', type: 'decision', description: 'FOMC Rate Decision' },
    { date: '2026-09-15', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-09-16', type: 'decision', description: 'FOMC Rate Decision + SEP' },
    { date: '2026-11-03', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-11-04', type: 'decision', description: 'FOMC Rate Decision' },
    { date: '2026-12-15', type: 'meeting', description: 'FOMC Meeting (Day 1)' },
    { date: '2026-12-16', type: 'decision', description: 'FOMC Rate Decision + SEP' },
];

// FOMC Minutes release schedule (3 weeks after each meeting)
const FOMC_MINUTES_SCHEDULE_2026 = [
    { date: '2026-02-19', description: 'FOMC Minutes (Jan meeting)' },
    { date: '2026-04-08', description: 'FOMC Minutes (Mar meeting)' },
    { date: '2026-05-27', description: 'FOMC Minutes (May meeting)' },
    { date: '2026-07-08', description: 'FOMC Minutes (Jun meeting)' },
    { date: '2026-08-19', description: 'FOMC Minutes (Jul meeting)' },
    { date: '2026-10-07', description: 'FOMC Minutes (Sep meeting)' },
    { date: '2026-11-25', description: 'FOMC Minutes (Nov meeting)' },
];

// ============================================
// ECONOMIC DATA SCHEDULE
// ============================================

// Key economic indicators and their typical release schedule
const ECONOMIC_INDICATORS = {
    CPI: {
        name: 'Consumer Price Index',
        frequency: 'monthly',
        releaseDay: 'second_tuesday', // Typically released ~10th-15th
        time: '08:30 ET',
        source: 'BLS',
        impact: 'high'
    },
    NFP: {
        name: 'Non-Farm Payrolls',
        frequency: 'monthly',
        releaseDay: 'first_friday',
        time: '08:30 ET',
        source: 'BLS',
        impact: 'high'
    },
    GDP: {
        name: 'Gross Domestic Product',
        frequency: 'quarterly',
        releaseDay: 'last_week_month', // Advance, Second, Third estimates
        time: '08:30 ET',
        source: 'BEA',
        impact: 'high'
    },
    PCE: {
        name: 'Personal Consumption Expenditures',
        frequency: 'monthly',
        releaseDay: 'last_friday',
        time: '08:30 ET',
        source: 'BEA',
        impact: 'high'
    },
    RETAIL_SALES: {
        name: 'Retail Sales',
        frequency: 'monthly',
        releaseDay: 'mid_month',
        time: '08:30 ET',
        source: 'Census',
        impact: 'medium'
    },
    ISM_MFG: {
        name: 'ISM Manufacturing PMI',
        frequency: 'monthly',
        releaseDay: 'first_business_day',
        time: '10:00 ET',
        source: 'ISM',
        impact: 'medium'
    },
    ISM_SVC: {
        name: 'ISM Services PMI',
        frequency: 'monthly',
        releaseDay: 'third_business_day',
        time: '10:00 ET',
        source: 'ISM',
        impact: 'medium'
    },
    HOUSING_STARTS: {
        name: 'Housing Starts',
        frequency: 'monthly',
        releaseDay: 'mid_month',
        time: '08:30 ET',
        source: 'Census',
        impact: 'medium'
    },
    CONSUMER_CONFIDENCE: {
        name: 'Consumer Confidence',
        frequency: 'monthly',
        releaseDay: 'last_tuesday',
        time: '10:00 ET',
        source: 'Conference Board',
        impact: 'low'
    },
    INITIAL_CLAIMS: {
        name: 'Initial Jobless Claims',
        frequency: 'weekly',
        releaseDay: 'thursday',
        time: '08:30 ET',
        source: 'DOL',
        impact: 'low'
    }
};

// ============================================
// MACRO CATALYST SCANNER CLASS
// ============================================

class MacroCatalystScanner {
    constructor() {
        this.catalysts = [];
        this.lastScan = null;
        this.cacheDir = path.join(__dirname, 'data', 'macro_catalysts');

        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Get upcoming FOMC events
     */
    async scanFOMCEvents(daysAhead = 30) {
        const today = new Date();
        const cutoff = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

        const catalysts = [];

        // Check FOMC meetings/decisions
        for (const event of FOMC_SCHEDULE_2026) {
            const eventDate = new Date(event.date);
            if (eventDate >= today && eventDate <= cutoff) {
                const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
                catalysts.push({
                    type: event.type === 'decision' ? 'fomc_meeting' : 'fed_speech',
                    subtype: event.type,
                    date: event.date,
                    description: event.description,
                    daysUntil,
                    impact: 'high',
                    time: '14:00 ET',
                    priority: daysUntil <= 7 ? 'critical' : daysUntil <= 14 ? 'high' : 'medium',
                    meta: MACRO_CATALYST_TYPES.fomc_meeting,
                    tradingImplications: this._getFOMCTradingImplications(daysUntil)
                });
            }
        }

        // Check FOMC minutes
        for (const event of FOMC_MINUTES_SCHEDULE_2026) {
            const eventDate = new Date(event.date);
            if (eventDate >= today && eventDate <= cutoff) {
                const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
                catalysts.push({
                    type: 'fed_minutes',
                    date: event.date,
                    description: event.description,
                    daysUntil,
                    impact: 'medium',
                    time: '14:00 ET',
                    priority: daysUntil <= 3 ? 'high' : 'medium',
                    meta: MACRO_CATALYST_TYPES.fed_minutes
                });
            }
        }

        return catalysts.sort((a, b) => a.daysUntil - b.daysUntil);
    }

    /**
     * Get trading implications for FOMC
     */
    _getFOMCTradingImplications(daysUntil) {
        if (daysUntil <= 3) {
            return {
                action: 'Position for volatility',
                strategies: ['VIX calls', 'SPY straddles', 'Rate-sensitive sector plays'],
                caution: 'High gamma risk, wide bid-ask spreads expected'
            };
        } else if (daysUntil <= 7) {
            return {
                action: 'Build positions',
                strategies: ['Accumulate straddles', 'Sector rotation into defensives'],
                caution: 'IV will increase into event'
            };
        } else {
            return {
                action: 'Monitor and plan',
                strategies: ['Identify rate-sensitive plays', 'Watch Fed speakers'],
                caution: 'Too early to position, watch for pre-meeting Fed commentary'
            };
        }
    }

    /**
     * Scan for upcoming economic data releases
     * Uses a combination of calculated dates and fetched calendars
     */
    async scanEconomicData(daysAhead = 14) {
        const catalysts = [];
        const today = new Date();

        // Calculate next release dates for key indicators
        const upcomingReleases = this._calculateUpcomingReleases(daysAhead);

        for (const release of upcomingReleases) {
            const eventDate = new Date(release.date);
            const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));

            if (daysUntil >= 0 && daysUntil <= daysAhead) {
                catalysts.push({
                    type: this._mapIndicatorToType(release.indicator),
                    indicator: release.indicator,
                    name: ECONOMIC_INDICATORS[release.indicator]?.name || release.indicator,
                    date: release.date,
                    time: ECONOMIC_INDICATORS[release.indicator]?.time || '08:30 ET',
                    daysUntil,
                    impact: ECONOMIC_INDICATORS[release.indicator]?.impact || 'medium',
                    priority: this._getEconPriority(release.indicator, daysUntil),
                    affectedSectors: this._getAffectedSectors(release.indicator),
                    tradingImplications: this._getEconTradingImplications(release.indicator, daysUntil)
                });
            }
        }

        return catalysts.sort((a, b) => a.daysUntil - b.daysUntil);
    }

    /**
     * Calculate upcoming release dates based on typical schedules
     */
    _calculateUpcomingReleases(daysAhead) {
        const releases = [];
        const today = new Date();
        const cutoff = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

        // Jobs report - First Friday
        const nextFirstFriday = this._getNextFirstFriday();
        if (nextFirstFriday <= cutoff) {
            releases.push({ indicator: 'NFP', date: nextFirstFriday.toISOString().split('T')[0] });
        }

        // CPI - Around 10th-15th of month
        const nextCPI = this._getNextCPIDate();
        if (nextCPI <= cutoff) {
            releases.push({ indicator: 'CPI', date: nextCPI.toISOString().split('T')[0] });
        }

        // ISM Manufacturing - First business day
        const nextISM = this._getNextFirstBusinessDay();
        if (nextISM <= cutoff) {
            releases.push({ indicator: 'ISM_MFG', date: nextISM.toISOString().split('T')[0] });
        }

        // Weekly claims - Every Thursday
        const nextThursday = this._getNextThursday();
        if (nextThursday <= cutoff) {
            releases.push({ indicator: 'INITIAL_CLAIMS', date: nextThursday.toISOString().split('T')[0] });
        }

        // PCE - Last Friday of month
        const nextPCE = this._getNextLastFriday();
        if (nextPCE <= cutoff) {
            releases.push({ indicator: 'PCE', date: nextPCE.toISOString().split('T')[0] });
        }

        // Consumer Confidence - Last Tuesday
        const nextConfidence = this._getNextLastTuesday();
        if (nextConfidence <= cutoff) {
            releases.push({ indicator: 'CONSUMER_CONFIDENCE', date: nextConfidence.toISOString().split('T')[0] });
        }

        return releases;
    }

    // Date calculation helpers
    _getNextFirstFriday() {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();

        // Find first Friday of current month
        let firstFriday = new Date(year, month, 1);
        while (firstFriday.getDay() !== 5) {
            firstFriday.setDate(firstFriday.getDate() + 1);
        }

        // If past, get next month's
        if (firstFriday < now) {
            firstFriday = new Date(year, month + 1, 1);
            while (firstFriday.getDay() !== 5) {
                firstFriday.setDate(firstFriday.getDate() + 1);
            }
        }

        return firstFriday;
    }

    _getNextCPIDate() {
        const now = new Date();
        // CPI typically released around 12th-13th
        let cpiDate = new Date(now.getFullYear(), now.getMonth(), 12);
        if (cpiDate < now) {
            cpiDate = new Date(now.getFullYear(), now.getMonth() + 1, 12);
        }
        // Adjust to weekday
        while (cpiDate.getDay() === 0 || cpiDate.getDay() === 6) {
            cpiDate.setDate(cpiDate.getDate() + 1);
        }
        return cpiDate;
    }

    _getNextFirstBusinessDay() {
        const now = new Date();
        let firstBiz = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        while (firstBiz.getDay() === 0 || firstBiz.getDay() === 6) {
            firstBiz.setDate(firstBiz.getDate() + 1);
        }
        if (firstBiz < now) {
            firstBiz = new Date(now.getFullYear(), now.getMonth() + 2, 1);
            while (firstBiz.getDay() === 0 || firstBiz.getDay() === 6) {
                firstBiz.setDate(firstBiz.getDate() + 1);
            }
        }
        return firstBiz;
    }

    _getNextThursday() {
        const now = new Date();
        const daysUntilThursday = (4 - now.getDay() + 7) % 7 || 7;
        return new Date(now.getTime() + daysUntilThursday * 24 * 60 * 60 * 1000);
    }

    _getNextLastFriday() {
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        while (lastDay.getDay() !== 5) {
            lastDay.setDate(lastDay.getDate() - 1);
        }
        if (lastDay < now) {
            const nextLastDay = new Date(now.getFullYear(), now.getMonth() + 2, 0);
            while (nextLastDay.getDay() !== 5) {
                nextLastDay.setDate(nextLastDay.getDate() - 1);
            }
            return nextLastDay;
        }
        return lastDay;
    }

    _getNextLastTuesday() {
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        while (lastDay.getDay() !== 2) {
            lastDay.setDate(lastDay.getDate() - 1);
        }
        if (lastDay < now) {
            const nextLastDay = new Date(now.getFullYear(), now.getMonth() + 2, 0);
            while (nextLastDay.getDay() !== 2) {
                nextLastDay.setDate(nextLastDay.getDate() - 1);
            }
            return nextLastDay;
        }
        return lastDay;
    }

    _mapIndicatorToType(indicator) {
        const mapping = {
            'CPI': 'cpi_release',
            'NFP': 'jobs_report',
            'GDP': 'gdp_release',
            'PCE': 'pce_release',
            'RETAIL_SALES': 'retail_sales',
            'ISM_MFG': 'ism_manufacturing',
            'ISM_SVC': 'ism_manufacturing',
            'HOUSING_STARTS': 'housing_data',
            'CONSUMER_CONFIDENCE': 'consumer_confidence',
            'INITIAL_CLAIMS': 'jobs_report'
        };
        return mapping[indicator] || 'economic_data';
    }

    _getEconPriority(indicator, daysUntil) {
        const highImpact = ['CPI', 'NFP', 'GDP', 'PCE'];
        if (highImpact.includes(indicator)) {
            return daysUntil <= 2 ? 'critical' : daysUntil <= 5 ? 'high' : 'medium';
        }
        return daysUntil <= 2 ? 'high' : 'medium';
    }

    _getAffectedSectors(indicator) {
        const sectorMap = {
            'CPI': ['SPY', 'QQQ', 'TLT', 'XLF', 'XLU'],
            'NFP': ['SPY', 'QQQ', 'XLY', 'XRT'],
            'GDP': ['SPY', 'QQQ', 'DIA'],
            'PCE': ['SPY', 'TLT', 'XLF'],
            'RETAIL_SALES': ['XRT', 'XLY', 'AMZN', 'WMT'],
            'ISM_MFG': ['XLI', 'XLB', 'CAT', 'DE'],
            'HOUSING_STARTS': ['XHB', 'ITB', 'HD', 'LOW'],
            'CONSUMER_CONFIDENCE': ['XLY', 'XRT'],
            'INITIAL_CLAIMS': ['SPY']
        };
        return sectorMap[indicator] || ['SPY'];
    }

    _getEconTradingImplications(indicator, daysUntil) {
        const highImpact = ['CPI', 'NFP', 'GDP', 'PCE'];

        if (highImpact.includes(indicator) && daysUntil <= 2) {
            return {
                action: 'Position for binary move',
                strategies: ['SPY/QQQ straddles', 'Sector ETF plays', 'VIX calls'],
                watchFor: `${indicator} vs expectations - surprise = big move`,
                expectedMove: indicator === 'CPI' || indicator === 'NFP' ? '1-2% SPY' : '0.5-1% SPY'
            };
        }

        return {
            action: 'Monitor consensus',
            strategies: ['Wait for data', 'Prepare positions'],
            watchFor: 'Consensus estimates and whisper numbers'
        };
    }

    /**
     * Scan for FDA/regulatory catalysts
     * Uses news/filings to identify upcoming decisions
     */
    async scanRegulatoryEvents() {
        const catalysts = [];

        // Known FDA PDUFA dates could be tracked here
        // For now, we'll scan news for mentions

        try {
            const news = await alphaVantage.news(null, 'fda,regulatory,approval', 50);

            if (news?.feed) {
                for (const item of news.feed.slice(0, 20)) {
                    // Extract tickers from news
                    const tickers = item.ticker_sentiment?.map(t => t.ticker) || [];

                    if (item.title.toLowerCase().includes('fda') ||
                        item.title.toLowerCase().includes('approval') ||
                        item.title.toLowerCase().includes('pdufa')) {

                        catalysts.push({
                            type: 'fda_decision',
                            title: item.title,
                            summary: item.summary?.substring(0, 200),
                            tickers,
                            date: item.time_published?.split('T')[0],
                            source: item.source,
                            url: item.url,
                            impact: 'high',
                            priority: 'high',
                            meta: MACRO_CATALYST_TYPES.fda_decision
                        });
                    }
                }
            }
        } catch (e) {
            console.log('FDA scan error:', e.message);
        }

        return catalysts;
    }

    /**
     * Scan for geopolitical events via news
     */
    async scanGeopoliticalEvents() {
        const catalysts = [];
        const keywords = ['tariff', 'trade war', 'sanction', 'china', 'russia', 'war', 'conflict', 'election'];

        try {
            const news = await alphaVantage.news(null, 'economy_macro,finance', 50);

            if (news?.feed) {
                for (const item of news.feed) {
                    const titleLower = item.title.toLowerCase();

                    for (const keyword of keywords) {
                        if (titleLower.includes(keyword)) {
                            catalysts.push({
                                type: 'geopolitical_event',
                                keyword,
                                title: item.title,
                                summary: item.summary?.substring(0, 200),
                                date: item.time_published?.split('T')[0],
                                source: item.source,
                                sentiment: item.overall_sentiment_label,
                                impact: 'varies',
                                priority: 'medium'
                            });
                            break; // Only add once per article
                        }
                    }
                }
            }
        } catch (e) {
            console.log('Geopolitical scan error:', e.message);
        }

        return catalysts.slice(0, 10);
    }

    /**
     * Get current Fed rate expectations from FRED
     */
    async getFedRateContext() {
        try {
            const [fedFunds, treasury2y, treasury10y, yieldCurve] = await Promise.all([
                fred.fedFundsRate(),
                fred.treasury2y(),
                fred.treasury10y(),
                fred.yieldCurveSpread()
            ]);

            const latestFedFunds = parseFloat(fedFunds?.observations?.slice(-1)[0]?.value) || null;
            const latest2y = parseFloat(treasury2y?.observations?.slice(-1)[0]?.value) || null;
            const latest10y = parseFloat(treasury10y?.observations?.slice(-1)[0]?.value) || null;
            const latestSpread = parseFloat(yieldCurve?.observations?.slice(-1)[0]?.value) || null;

            // 2Y Treasury is a good proxy for rate expectations
            const impliedRatePath = latest2y > latestFedFunds + 0.25 ? 'hikes_expected' :
                                    latest2y < latestFedFunds - 0.25 ? 'cuts_expected' : 'neutral';

            return {
                currentFedFunds: latestFedFunds,
                treasury2y: latest2y,
                treasury10y: latest10y,
                yieldSpread: latestSpread,
                curveStatus: latestSpread < 0 ? 'inverted' : latestSpread < 0.5 ? 'flat' : 'normal',
                impliedRatePath,
                interpretation: this._interpretRateEnvironment(latestFedFunds, latest2y, latestSpread)
            };
        } catch (e) {
            return { error: e.message };
        }
    }

    _interpretRateEnvironment(fedFunds, treasury2y, spread) {
        const interpretations = [];

        if (spread < 0) {
            interpretations.push('Yield curve inverted - recession risk elevated');
        } else if (spread < 0.5) {
            interpretations.push('Yield curve flat - late cycle dynamics');
        }

        if (treasury2y < fedFunds) {
            interpretations.push('Market pricing in rate cuts');
        } else if (treasury2y > fedFunds + 0.5) {
            interpretations.push('Market pricing in rate hikes');
        }

        return interpretations.join('. ') || 'Neutral rate environment';
    }

    /**
     * Run full macro catalyst scan
     */
    async runFullScan(options = {}) {
        console.log('Starting macro catalyst scan...');
        const startTime = Date.now();

        const daysAhead = options.daysAhead || 14;

        const results = {
            fomc: [],
            economic: [],
            regulatory: [],
            geopolitical: [],
            rateContext: null,
            timestamp: new Date().toISOString()
        };

        // Run scans in parallel
        const [fomc, economic, regulatory, geopolitical, rateContext] = await Promise.all([
            this.scanFOMCEvents(daysAhead),
            this.scanEconomicData(daysAhead),
            this.scanRegulatoryEvents(),
            this.scanGeopoliticalEvents(),
            this.getFedRateContext()
        ]);

        results.fomc = fomc;
        results.economic = economic;
        results.regulatory = regulatory;
        results.geopolitical = geopolitical;
        results.rateContext = rateContext;

        // Combine all catalysts
        this.catalysts = [
            ...fomc,
            ...economic,
            ...regulatory.slice(0, 5),
            ...geopolitical.slice(0, 5)
        ];

        // Sort by priority and date
        this.catalysts.sort((a, b) => {
            const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            const pDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
            if (pDiff !== 0) return pDiff;
            return (a.daysUntil || 999) - (b.daysUntil || 999);
        });

        this.lastScan = new Date().toISOString();

        // Save results
        const outputFile = path.join(this.cacheDir, 'latest_macro_catalysts.json');
        fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Macro scan complete in ${elapsed}s. Found ${this.catalysts.length} catalysts.`);

        return results;
    }

    /**
     * Format for Discord
     */
    formatForDiscord(results = null) {
        const data = results || { fomc: [], economic: [], regulatory: [], geopolitical: [], rateContext: null };

        let msg = '**🏛️ MACRO CATALYST REPORT**\n\n';

        // Rate context
        if (data.rateContext && !data.rateContext.error) {
            msg += '**📊 Rate Environment:**\n';
            msg += `• Fed Funds: ${data.rateContext.currentFedFunds?.toFixed(2)}%\n`;
            msg += `• 2Y Treasury: ${data.rateContext.treasury2y?.toFixed(2)}%\n`;
            msg += `• 10Y-2Y Spread: ${data.rateContext.yieldSpread?.toFixed(2)}% (${data.rateContext.curveStatus})\n`;
            msg += `• Outlook: ${data.rateContext.impliedRatePath.replace('_', ' ')}\n\n`;
        }

        // FOMC
        if (data.fomc?.length > 0) {
            msg += '**🏦 Fed Events:**\n';
            for (const e of data.fomc.slice(0, 5)) {
                const emoji = e.priority === 'critical' ? '🚨' : e.priority === 'high' ? '⚠️' : '📅';
                msg += `${emoji} **${e.date}** (${e.daysUntil}d) - ${e.description}\n`;
            }
            msg += '\n';
        }

        // Economic data
        if (data.economic?.length > 0) {
            msg += '**📈 Economic Data:**\n';
            for (const e of data.economic.slice(0, 5)) {
                const emoji = e.impact === 'high' ? '🔴' : e.impact === 'medium' ? '🟡' : '🟢';
                msg += `${emoji} **${e.date}** - ${e.name} (${e.daysUntil}d)\n`;
            }
            msg += '\n';
        }

        // Regulatory
        if (data.regulatory?.length > 0) {
            msg += '**⚖️ Regulatory/FDA:**\n';
            for (const e of data.regulatory.slice(0, 3)) {
                msg += `• ${e.title.substring(0, 60)}...\n`;
            }
            msg += '\n';
        }

        // Geopolitical
        if (data.geopolitical?.length > 0) {
            msg += '**🌍 Geopolitical:**\n';
            for (const e of data.geopolitical.slice(0, 3)) {
                msg += `• [${e.keyword}] ${e.title.substring(0, 50)}...\n`;
            }
            msg += '\n';
        }

        msg += `_Scanned at ${this.lastScan || new Date().toISOString()}_`;

        return msg;
    }

    /**
     * Get critical events only (next 7 days, high impact)
     */
    getCriticalEvents() {
        return this.catalysts.filter(c =>
            (c.priority === 'critical' || c.priority === 'high') &&
            (c.daysUntil || 999) <= 7
        );
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    MacroCatalystScanner,
    MACRO_CATALYST_TYPES,
    FOMC_SCHEDULE_2026,
    ECONOMIC_INDICATORS
};

// CLI
if (require.main === module) {
    (async () => {
        const scanner = new MacroCatalystScanner();
        const results = await scanner.runFullScan();

        console.log('\n' + '='.repeat(50));
        console.log(scanner.formatForDiscord(results));
    })();
}
