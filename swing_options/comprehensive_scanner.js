/**
 * Comprehensive Catalyst Scanner
 *
 * Unified scanner that combines ALL catalyst sources:
 * 1. Macro Events (FOMC, economic data, geopolitical)
 * 2. Earnings Catalysts
 * 3. Social Momentum (Reddit, StockTwits)
 * 4. Technical Setups (RSI, volume, breakouts)
 * 5. Insider Activity
 * 6. FDA/Regulatory Events
 *
 * Uses smart universe filtering (ETF holdings + options liquidity)
 */

const { CatalystScanner, CATALYST_TYPES } = require('./catalyst_scanner');
const { MacroCatalystScanner, MACRO_CATALYST_TYPES } = require('./macro_catalyst_scanner');
const { UniverseScanner, ETF_HOLDINGS, LIQUID_OPTIONS_UNIVERSE } = require('./universe_scanner');
const fs = require('fs');
const path = require('path');

class ComprehensiveScanner {
    constructor() {
        this.catalystScanner = new CatalystScanner();
        this.macroScanner = new MacroCatalystScanner();
        this.universeScanner = new UniverseScanner();
        this.allCatalysts = [];
        this.lastScan = null;
        this.cacheDir = path.join(__dirname, 'data', 'comprehensive');

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Run comprehensive scan across all catalyst types
     */
    async runFullScan(options = {}) {
        console.log('Starting comprehensive catalyst scan...');
        const startTime = Date.now();

        const {
            daysAhead = 14,
            includeMacro = true,
            includeEarnings = true,
            includeSocial = true,
            includeInsiders = true,
            includeTechnical = true
        } = options;

        const results = {
            macro: null,
            earnings: [],
            social: [],
            insiders: [],
            technical: null,
            universe: null,
            criticalEvents: [],
            topOpportunities: [],
            timestamp: new Date().toISOString()
        };

        // Build universe first
        console.log('Building universe...');
        results.universe = await this.universeScanner.buildFullUniverse({
            includeSocial: true,
            includeTechnical: includeTechnical,
            optionsOnly: false
        });

        // Run all scans in parallel
        const scanPromises = [];

        if (includeMacro) {
            scanPromises.push(
                this.macroScanner.runFullScan({ daysAhead })
                    .then(r => { results.macro = r; })
            );
        }

        if (includeEarnings || includeSocial || includeInsiders) {
            scanPromises.push(
                this.catalystScanner.runFullScan()
                    .then(r => {
                        results.earnings = r.earnings || [];
                        results.social = r.social || [];
                        results.insiders = r.insiders || [];
                    })
            );
        }

        await Promise.all(scanPromises);

        // Get technical setups from universe scan
        results.technical = results.universe?.technicalSetups || null;

        // Combine and rank all catalysts
        this.allCatalysts = this._combineAndRankCatalysts(results);

        // Get critical events (next 3 days, high impact)
        results.criticalEvents = this._getCriticalEvents();

        // Get top opportunities
        results.topOpportunities = this._getTopOpportunities(10);

        this.lastScan = new Date().toISOString();
        results.timestamp = this.lastScan;

        // Save results
        fs.writeFileSync(
            path.join(this.cacheDir, 'latest_scan.json'),
            JSON.stringify(results, null, 2)
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Comprehensive scan complete in ${elapsed}s. Found ${this.allCatalysts.length} total catalysts.`);

        return results;
    }

    /**
     * Combine all catalysts and rank by priority
     */
    _combineAndRankCatalysts(results) {
        const all = [];

        // Add macro events
        if (results.macro) {
            for (const event of results.macro.fomc || []) {
                all.push({ ...event, source: 'macro', category: 'fomc' });
            }
            for (const event of results.macro.economic || []) {
                all.push({ ...event, source: 'macro', category: 'economic' });
            }
            for (const event of results.macro.regulatory || []) {
                all.push({ ...event, source: 'macro', category: 'regulatory' });
            }
            for (const event of results.macro.geopolitical || []) {
                all.push({ ...event, source: 'macro', category: 'geopolitical' });
            }
        }

        // Add earnings
        for (const event of results.earnings || []) {
            all.push({ ...event, source: 'earnings', category: 'earnings' });
        }

        // Add social
        for (const event of results.social || []) {
            all.push({ ...event, source: 'social', category: 'social' });
        }

        // Add insiders
        for (const event of results.insiders || []) {
            all.push({ ...event, source: 'insiders', category: 'insiders' });
        }

        // Add technical setups as catalysts
        if (results.technical) {
            for (const setup of results.technical.oversold || []) {
                all.push({
                    type: 'technical_oversold',
                    symbol: setup.symbol,
                    rsi: setup.rsi,
                    price: setup.price,
                    priority: 'medium',
                    source: 'technical',
                    category: 'technical'
                });
            }
            for (const setup of results.technical.overbought || []) {
                all.push({
                    type: 'technical_overbought',
                    symbol: setup.symbol,
                    rsi: setup.rsi,
                    price: setup.price,
                    priority: 'medium',
                    source: 'technical',
                    category: 'technical'
                });
            }
        }

        // Sort by priority and days until
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

        all.sort((a, b) => {
            const pDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
            if (pDiff !== 0) return pDiff;
            return (a.daysUntil || 999) - (b.daysUntil || 999);
        });

        return all;
    }

    /**
     * Get critical events (next 3 days, high impact)
     */
    _getCriticalEvents() {
        return this.allCatalysts.filter(c => {
            const isHighPriority = c.priority === 'critical' || c.priority === 'high';
            const isSoon = (c.daysUntil || 999) <= 3;
            return isHighPriority && isSoon;
        });
    }

    /**
     * Get top trading opportunities
     */
    _getTopOpportunities(limit = 10) {
        // Prioritize: earnings with direction, FOMC proximity, high social + technical
        const opportunities = [];

        // 1. Earnings in next 7 days with liquid options
        const earnings = this.allCatalysts.filter(c =>
            c.category === 'earnings' &&
            c.daysUntil <= 7 &&
            LIQUID_OPTIONS_UNIVERSE.includes(c.symbol)
        );

        // 2. Macro events
        const macro = this.allCatalysts.filter(c =>
            c.category === 'fomc' || c.category === 'economic'
        ).slice(0, 3);

        // 3. Social + momentum
        const social = this.allCatalysts.filter(c =>
            c.category === 'social' &&
            LIQUID_OPTIONS_UNIVERSE.includes(c.symbol)
        ).slice(0, 3);

        // 4. Technical setups
        const technical = this.allCatalysts.filter(c =>
            c.category === 'technical'
        ).slice(0, 3);

        return [
            ...macro,
            ...earnings.slice(0, 4),
            ...social,
            ...technical
        ].slice(0, limit);
    }

    /**
     * Get sector-specific opportunities based on macro context
     */
    getSectorPlays() {
        const plays = [];

        // Get rate context from macro scan
        const rateContext = this.macroScanner?.catalysts?.find(c => c.type === 'fomc_meeting');

        if (rateContext && rateContext.daysUntil <= 7) {
            plays.push({
                sector: 'Financials',
                etf: 'XLF',
                rationale: 'Rate decision approaching - financials sensitive',
                stocks: ETF_HOLDINGS.XLF.topHoldings.slice(0, 5)
            });
            plays.push({
                sector: 'Utilities',
                etf: 'XLU',
                rationale: 'Rate-sensitive defensive sector',
                stocks: ETF_HOLDINGS.XLU.topHoldings.slice(0, 5)
            });
        }

        // Check for energy plays
        const energyMention = this.allCatalysts.find(c =>
            c.category === 'geopolitical' &&
            (c.keyword === 'oil' || c.keyword === 'energy' || c.keyword === 'russia')
        );

        if (energyMention) {
            plays.push({
                sector: 'Energy',
                etf: 'XLE',
                rationale: 'Geopolitical energy news',
                stocks: ETF_HOLDINGS.XLE.topHoldings.slice(0, 5)
            });
        }

        return plays;
    }

    /**
     * Format comprehensive report for Discord
     */
    formatForDiscord(results) {
        let msg = '**🎯 COMPREHENSIVE CATALYST REPORT**\n';
        msg += `_${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}_\n\n`;

        // Critical Events
        if (results.criticalEvents?.length > 0) {
            msg += '**🚨 CRITICAL EVENTS (Next 3 Days):**\n';
            for (const e of results.criticalEvents.slice(0, 5)) {
                const emoji = e.category === 'fomc' ? '🏦' :
                             e.category === 'economic' ? '📊' :
                             e.category === 'earnings' ? '📅' : '⚡';
                const daysStr = e.daysUntil !== undefined ? `(${e.daysUntil}d)` : '';
                msg += `${emoji} **${e.date || e.symbol}** ${daysStr} - ${e.description || e.name || e.type}\n`;
            }
            msg += '\n';
        }

        // Rate Context
        if (results.macro?.rateContext && !results.macro.rateContext.error) {
            const rc = results.macro.rateContext;
            msg += `**📈 Rate Environment:** Fed ${rc.currentFedFunds?.toFixed(2)}% | Curve: ${rc.curveStatus} | ${rc.impliedRatePath.replace('_', ' ')}\n\n`;
        }

        // Top Opportunities
        if (results.topOpportunities?.length > 0) {
            msg += '**🎯 TOP OPPORTUNITIES:**\n';

            // Group by category
            const byCategory = {};
            for (const opp of results.topOpportunities) {
                if (!byCategory[opp.category]) byCategory[opp.category] = [];
                byCategory[opp.category].push(opp);
            }

            for (const [cat, opps] of Object.entries(byCategory)) {
                const emoji = cat === 'fomc' ? '🏦' :
                             cat === 'economic' ? '📊' :
                             cat === 'earnings' ? '📅' :
                             cat === 'social' ? '🗣️' :
                             cat === 'technical' ? '📉' : '📌';

                msg += `\n${emoji} **${cat.toUpperCase()}:**\n`;
                for (const o of opps.slice(0, 3)) {
                    const detail = o.symbol ? `**${o.symbol}**` : `**${o.date}**`;
                    const sub = o.daysUntil !== undefined ? ` (${o.daysUntil}d)` :
                               o.mentions ? ` (${o.mentions} mentions)` :
                               o.rsi ? ` (RSI: ${o.rsi?.toFixed(1)})` : '';
                    msg += `• ${detail}${sub} - ${o.description || o.name || o.type}\n`;
                }
            }
            msg += '\n';
        }

        // Universe Stats
        if (results.universe) {
            msg += `**📊 Universe:** ${results.universe.count} stocks monitored\n`;
        }

        msg += `\n_Scan complete. ${this.allCatalysts.length} total catalysts tracked._`;

        return msg;
    }

    /**
     * Quick scan for current actionable items
     */
    async quickScan() {
        console.log('Running quick scan...');

        const results = await this.runFullScan({
            daysAhead: 7,
            includeMacro: true,
            includeEarnings: true,
            includeSocial: true,
            includeInsiders: false,
            includeTechnical: false
        });

        return {
            critical: results.criticalEvents,
            opportunities: results.topOpportunities,
            summary: this.formatForDiscord(results)
        };
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    ComprehensiveScanner,
    CATALYST_TYPES,
    MACRO_CATALYST_TYPES
};

// CLI
if (require.main === module) {
    (async () => {
        const scanner = new ComprehensiveScanner();
        const results = await scanner.runFullScan();

        console.log('\n' + '='.repeat(60));
        console.log(scanner.formatForDiscord(results));
    })();
}
