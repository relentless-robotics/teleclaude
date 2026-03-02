#!/usr/bin/env node
/**
 * Swing Options Trading Toolkit
 *
 * Main CLI interface for the swing trading options system.
 *
 * Commands:
 *   scan     - Run full daily catalyst scan
 *   analyze  - Deep dive on a specific symbol
 *   market   - Get current market context
 *   watch    - Add/remove/list watchlist symbols
 *   setup    - Setup wizard for API keys
 */

// CRITICAL: Initialize vault BEFORE any other requires that need credentials
const { init } = require('../security/vault');
try {
    init('@2V$ND4*XM');
} catch (error) {
    // Vault already initialized or error - continue
}

const { SwingEngine } = require('./swing_engine');
const { CatalystScanner } = require('./catalyst_scanner');
const { OptionsAnalyzer } = require('./options_analyzer');
const { fmp, fred, social, aggregator } = require('./api_client');
const alpaca = require('./alpaca_client');
const config = require('./config');
const fs = require('fs');
const path = require('path');

// ASCII Banner
const BANNER = `
╔═══════════════════════════════════════════════════════════╗
║     SWING OPTIONS TRADING TOOLKIT v1.0                    ║
║     Catalyst-Driven Options Scanner                       ║
╚═══════════════════════════════════════════════════════════╝
`;

/**
 * Main CLI Handler
 */
class SwingOptionsCLI {
    constructor() {
        this.engine = new SwingEngine();
        this.catalystScanner = new CatalystScanner();
        this.optionsAnalyzer = new OptionsAnalyzer();
    }

    /**
     * Run daily scan
     */
    async scan(options = {}) {
        console.log(BANNER);
        const results = await this.engine.runDailyScan();

        if (options.json) {
            console.log(JSON.stringify(results, null, 2));
        } else {
            console.log(this.engine.formatForDiscord());
        }

        return results;
    }

    /**
     * Analyze specific symbol
     */
    async analyze(symbol, options = {}) {
        console.log(`\n📊 Analyzing ${symbol.toUpperCase()}...\n`);

        const analysis = await this.engine.analyzeSymbol(symbol.toUpperCase());

        if (options.json) {
            console.log(JSON.stringify(analysis, null, 2));
            return analysis;
        }

        // Pretty print
        console.log(`${'═'.repeat(50)}`);
        console.log(`  ${analysis.symbol} - $${analysis.price?.toFixed(2)} (${analysis.change?.toFixed(2)}%)`);
        console.log(`${'═'.repeat(50)}\n`);

        console.log(`Sector: ${analysis.sector || 'N/A'}`);
        console.log(`Industry: ${analysis.industry || 'N/A'}`);
        console.log(`Market Cap: $${(analysis.marketCap / 1e9)?.toFixed(2)}B`);
        console.log(`Volume: ${analysis.volume?.toLocaleString()} (Avg: ${analysis.avgVolume?.toLocaleString()})`);

        if (analysis.optionsAnalysis) {
            console.log(`\n--- Options Analysis ---`);
            console.log(`IV Status: ${analysis.optionsAnalysis.ivStatus}`);
            if (analysis.optionsAnalysis.expectedMove) {
                console.log(`Expected Move: ±$${analysis.optionsAnalysis.expectedMove.dollars?.toFixed(2)} (±${analysis.optionsAnalysis.expectedMove.percent?.toFixed(1)}%)`);
            }
            if (analysis.optionsAnalysis.recommendations) {
                console.log(`Recommendations:`);
                for (const rec of analysis.optionsAnalysis.recommendations) {
                    console.log(`  • ${rec}`);
                }
            }
        }

        if (analysis.catalysts?.length > 0) {
            console.log(`\n--- Upcoming Catalysts ---`);
            for (const cat of analysis.catalysts) {
                console.log(`  • ${cat.type}: ${cat.date || 'TBD'}`);
            }
        }

        if (analysis.recentNews?.length > 0) {
            console.log(`\n--- Recent News ---`);
            for (const news of analysis.recentNews) {
                console.log(`  • ${news.title?.substring(0, 60)}...`);
            }
        }

        return analysis;
    }

    /**
     * Get market context
     */
    async market(options = {}) {
        console.log('\n📈 Fetching market context...\n');

        const context = await this.engine.getMarketContext();

        if (options.json) {
            console.log(JSON.stringify(context, null, 2));
            return context;
        }

        console.log(`${'═'.repeat(50)}`);
        console.log(`  MARKET OVERVIEW`);
        console.log(`${'═'.repeat(50)}\n`);

        console.log(`VIX: ${context.vix?.toFixed(2)} (${context.vixLevel})`);
        console.log(`Regime: ${context.regime}`);
        console.log(`Yield Curve: ${context.yieldCurve?.spread?.toFixed(2)}% (${context.yieldCurve?.signal})`);

        console.log(`\n--- Top Gainers ---`);
        for (const g of context.topGainers) {
            console.log(`  ${g.symbol}: +${g.change?.toFixed(2)}%`);
        }

        console.log(`\n--- Top Losers ---`);
        for (const l of context.topLosers) {
            console.log(`  ${l.symbol}: ${l.change?.toFixed(2)}%`);
        }

        console.log(`\n--- Sector Performance ---`);
        for (const s of context.sectorPerformance?.slice(0, 5) || []) {
            console.log(`  ${s.sector}: ${s.changesPercentage?.toFixed(2)}%`);
        }

        return context;
    }

    /**
     * Manage watchlist
     */
    async watchlist(action, symbol = null) {
        const watchlistFile = config.storage.watchlistFile;

        let watchlist = { symbols: [], updated: null };
        if (fs.existsSync(watchlistFile)) {
            watchlist = JSON.parse(fs.readFileSync(watchlistFile, 'utf8'));
        }

        switch (action) {
            case 'add':
                if (!symbol) {
                    console.log('Usage: swing-options watch add <SYMBOL>');
                    return;
                }
                if (!watchlist.symbols.find(s => s.symbol === symbol.toUpperCase())) {
                    watchlist.symbols.push({
                        symbol: symbol.toUpperCase(),
                        addedAt: new Date().toISOString()
                    });
                    watchlist.updated = new Date().toISOString();
                    fs.writeFileSync(watchlistFile, JSON.stringify(watchlist, null, 2));
                    console.log(`Added ${symbol.toUpperCase()} to watchlist`);
                } else {
                    console.log(`${symbol.toUpperCase()} already in watchlist`);
                }
                break;

            case 'remove':
                if (!symbol) {
                    console.log('Usage: swing-options watch remove <SYMBOL>');
                    return;
                }
                watchlist.symbols = watchlist.symbols.filter(
                    s => s.symbol !== symbol.toUpperCase()
                );
                watchlist.updated = new Date().toISOString();
                fs.writeFileSync(watchlistFile, JSON.stringify(watchlist, null, 2));
                console.log(`Removed ${symbol.toUpperCase()} from watchlist`);
                break;

            case 'list':
            default:
                console.log('\n📋 Watchlist:\n');
                if (watchlist.symbols.length === 0) {
                    console.log('  (empty)');
                } else {
                    for (const s of watchlist.symbols) {
                        console.log(`  • ${s.symbol} (added ${s.addedAt?.split('T')[0]})`);
                    }
                }
                break;
        }

        return watchlist;
    }

    /**
     * Quick earnings scan
     */
    async earnings(days = 7) {
        console.log(`\n📅 Earnings in the next ${days} days...\n`);

        const today = new Date().toISOString().split('T')[0];
        const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const earnings = await fmp.earningsCalendar(today, future);

        if (!earnings || earnings.length === 0) {
            console.log('No earnings found.');
            return [];
        }

        // Sort by date
        earnings.sort((a, b) => new Date(a.date) - new Date(b.date));

        // Group by date
        const byDate = {};
        for (const e of earnings) {
            if (!byDate[e.date]) byDate[e.date] = [];
            byDate[e.date].push(e);
        }

        for (const [date, items] of Object.entries(byDate)) {
            console.log(`\n${date}:`);
            for (const e of items.slice(0, 10)) {
                const time = e.time === 'bmo' ? '🌅 BMO' : e.time === 'amc' ? '🌙 AMC' : '❓';
                console.log(`  ${time} ${e.symbol} - EPS Est: $${e.epsEstimated || 'N/A'}`);
            }
            if (items.length > 10) {
                console.log(`  ... and ${items.length - 10} more`);
            }
        }

        return earnings;
    }

    /**
     * Social sentiment scan - Multiple sources
     */
    async sentiment() {
        console.log('\n🗣️ Social Sentiment Scanner...\n');

        const trending = await social.getTrendingTickers();

        // Reddit section
        console.log('📱 REDDIT (via ApeWisdom):');
        console.log(`${'─'.repeat(50)}`);
        if (trending.reddit?.length > 0) {
            for (const t of trending.reddit.slice(0, 10)) {
                const bar = '█'.repeat(Math.min(Math.floor(t.mentions / 30), 15));
                console.log(`  ${t.ticker.padEnd(6)} ${String(t.mentions).padStart(4)} mentions ${bar}`);
            }
        } else {
            console.log('  No Reddit data available');
        }

        // StockTwits section
        console.log('\n💬 STOCKTWITS (Trending):');
        console.log(`${'─'.repeat(50)}`);
        if (trending.stocktwits?.length > 0) {
            for (const t of trending.stocktwits.slice(0, 10)) {
                const watchK = Math.floor(t.watchlistCount / 1000);
                console.log(`  ${t.ticker.padEnd(6)} ${String(watchK).padStart(4)}K watchers`);
            }
        } else {
            console.log('  No StockTwits data available');
        }

        // Combined top picks
        console.log('\n🔥 COMBINED TOP PICKS:');
        console.log(`${'─'.repeat(50)}`);
        if (trending.combined?.length > 0) {
            for (const t of trending.combined.slice(0, 10)) {
                const sources = t.sources?.join('+') || 'unknown';
                const reddit = t.redditMentions ? `R:${t.redditMentions}` : '';
                const st = t.stocktwitsWatchlist ? `ST:${Math.floor(t.stocktwitsWatchlist/1000)}K` : '';
                console.log(`  ${t.ticker.padEnd(6)} ${reddit.padEnd(8)} ${st.padEnd(10)} [${sources}]`);
            }
        }

        return trending;
    }

    /**
     * Contrarian / Bearish scan - find the OTHER side of the trade
     */
    async contrarian() {
        console.log('\n🔄 CONTRARIAN SCAN - Finding the Other Side...\n');

        // 1. High Short Interest
        console.log('📉 HIGH SHORT INTEREST STOCKS:');
        console.log(`${'─'.repeat(50)}`);
        const highShort = await social.scanHighShortInterest();
        if (highShort.length > 0) {
            for (const item of highShort.slice(0, 10)) {
                const rsiIndicator = item.rsi > 70 ? '🔴OB' : item.rsi < 30 ? '🟢OS' : '';
                console.log(`  ${item.ticker.padEnd(6)} Short: ${item.shortFloat?.toFixed(1) || 'N/A'}% | RSI: ${item.rsi?.toFixed(0) || 'N/A'} ${rsiIndicator} | MC: ${item.marketCap || 'N/A'}`);
            }
        } else {
            console.log('  Could not fetch short interest data');
        }

        // 2. Bearish Sentiment
        console.log('\n😰 BEARISH SENTIMENT (StockTwits):');
        console.log(`${'─'.repeat(50)}`);
        const bearish = await social.getBearishSentiment();
        if (bearish.length > 0) {
            for (const b of bearish.slice(0, 10)) {
                console.log(`  ${b.ticker.padEnd(6)} 🐻 ${b.bearish} bearish vs 🐂 ${b.bullish} bullish (${b.messages} msgs)`);
            }
        } else {
            console.log('  No strongly bearish sentiment found in trending');
        }

        // 3. Small/Mid Cap opportunities (non mega-cap)
        console.log('\n🎯 SMALL/MID CAP BUZZ (Excluding Mag 7):');
        console.log(`${'─'.repeat(50)}`);
        const smallMid = await social.getSmallMidCapBuzz();
        if (smallMid.length > 0) {
            for (const s of smallMid.slice(0, 10)) {
                const reddit = s.redditMentions ? `R:${s.redditMentions}` : '';
                const st = s.stocktwitsWatchlist ? `ST:${Math.floor(s.stocktwitsWatchlist/1000)}K` : '';
                const short = s.shortFloat ? `Short:${s.shortFloat}%` : '';
                console.log(`  ${s.ticker.padEnd(6)} ${reddit.padEnd(8)} ${st.padEnd(10)} ${short} MC:${s.marketCap || 'N/A'}`);
            }
        } else {
            console.log('  Scanning...');
        }

        console.log('\n💡 INTERPRETATION:');
        console.log('  - High short + rising price = potential squeeze');
        console.log('  - High short + bearish sentiment = validate short thesis');
        console.log('  - Small/mid cap buzz = potential momentum before institutions');

        return { highShort, bearish, smallMid };
    }

    /**
     * Get detailed sentiment for a specific symbol
     */
    async symbolSentiment(symbol) {
        console.log(`\n🔍 Sentiment Analysis for ${symbol.toUpperCase()}...\n`);

        const sentiment = await social.getSymbolSentiment(symbol.toUpperCase());

        console.log(`${'═'.repeat(50)}`);
        console.log(`  ${symbol.toUpperCase()} - SENTIMENT ANALYSIS`);
        console.log(`${'═'.repeat(50)}\n`);

        if (sentiment.stocktwits) {
            console.log('💬 StockTwits:');
            console.log(`   Sentiment: ${sentiment.stocktwits.sentimentLabel?.toUpperCase()}`);
            console.log(`   Messages: ${sentiment.stocktwits.messageVolume}`);
            console.log(`   Bullish: ${sentiment.stocktwits.bullishCount} | Bearish: ${sentiment.stocktwits.bearishCount}`);
            console.log(`   Watchlist: ${sentiment.stocktwits.watchlistCount?.toLocaleString()}`);
        }

        if (sentiment.finviz) {
            console.log('\n📰 Finviz News:');
            console.log(`   Headlines analyzed: ${sentiment.finviz.headlines?.length}`);
            console.log(`   Bullish signals: ${sentiment.finviz.bullishScore} | Bearish: ${sentiment.finviz.bearishScore}`);
            if (sentiment.finviz.headlines?.length > 0) {
                console.log('   Recent headlines:');
                for (const h of sentiment.finviz.headlines.slice(0, 3)) {
                    console.log(`     • ${h.substring(0, 60)}${h.length > 60 ? '...' : ''}`);
                }
            }
        }

        console.log(`\n📊 AGGREGATE: ${sentiment.sentimentLabel?.toUpperCase()}`);
        console.log(`   Score: ${sentiment.aggregateSentiment?.toFixed(2)} (-1 bearish to +1 bullish)`);

        return sentiment;
    }

    /**
     * Show Alpaca paper trading account
     */
    async account() {
        console.log('\n💼 Alpaca Paper Trading Account\n');
        const summary = await alpaca.getAccountSummary();

        console.log(`${'═'.repeat(50)}`);
        console.log(`  ACCOUNT STATUS: ${summary.account.status}`);
        console.log(`${'═'.repeat(50)}\n`);

        console.log(`Equity:       $${summary.account.equity.toLocaleString()}`);
        console.log(`Cash:         $${summary.account.cash.toLocaleString()}`);
        console.log(`Buying Power: $${summary.account.buyingPower.toLocaleString()}`);
        console.log(`Day Trades:   ${summary.account.dayTradeCount}/3`);

        if (summary.positions.length > 0) {
            console.log(`\n--- Positions (${summary.positions.length}) ---`);
            for (const p of summary.positions) {
                const plEmoji = p.unrealizedPL >= 0 ? '🟢' : '🔴';
                console.log(`  ${p.symbol}: ${p.qty} @ $${p.avgEntry.toFixed(2)} → $${p.currentPrice.toFixed(2)} ${plEmoji} ${p.unrealizedPLPercent.toFixed(1)}% ($${p.unrealizedPL.toFixed(2)})`);
            }
        } else {
            console.log('\n--- Positions: None ---');
        }

        if (summary.openOrders.length > 0) {
            console.log(`\n--- Open Orders (${summary.openOrders.length}) ---`);
            for (const o of summary.openOrders) {
                console.log(`  ${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ ${o.limitPrice || 'MKT'} (${o.status})`);
            }
        }

        console.log('\n📝 Mode: PAPER TRADING');
        return summary;
    }

    /**
     * Buy stock
     */
    async buy(symbol, qty, options = {}) {
        console.log(`\n🛒 Buying ${qty} shares of ${symbol.toUpperCase()}...\n`);

        // Check market status
        const clock = await alpaca.getClock();
        if (!clock.is_open) {
            console.log(`⚠️ Market is CLOSED. Order will be queued for next open.`);
            console.log(`   Next open: ${clock.next_open}`);
        }

        try {
            const order = await alpaca.buyStock(symbol, qty, options);
            console.log(`✅ Order placed!`);
            console.log(`   Order ID: ${order.id}`);
            console.log(`   Symbol: ${order.symbol}`);
            console.log(`   Qty: ${order.qty}`);
            console.log(`   Type: ${order.type}`);
            console.log(`   Status: ${order.status}`);
            return order;
        } catch (e) {
            console.log(`❌ Order failed: ${e.message}`);
            throw e;
        }
    }

    /**
     * Sell stock
     */
    async sell(symbol, qty, options = {}) {
        console.log(`\n💰 Selling ${qty} shares of ${symbol.toUpperCase()}...\n`);

        try {
            const order = await alpaca.sellStock(symbol, qty, options);
            console.log(`✅ Order placed!`);
            console.log(`   Order ID: ${order.id}`);
            console.log(`   Symbol: ${order.symbol}`);
            console.log(`   Qty: ${order.qty}`);
            console.log(`   Status: ${order.status}`);
            return order;
        } catch (e) {
            console.log(`❌ Order failed: ${e.message}`);
            throw e;
        }
    }

    /**
     * Show positions
     */
    async positions() {
        console.log('\n📊 Current Positions\n');
        const positions = await alpaca.getPositions();

        if (positions.length === 0) {
            console.log('No open positions.');
            return [];
        }

        let totalPL = 0;
        for (const p of positions) {
            const pl = parseFloat(p.unrealized_pl);
            const plPct = parseFloat(p.unrealized_plpc) * 100;
            const emoji = pl >= 0 ? '🟢' : '🔴';
            totalPL += pl;

            console.log(`${p.symbol}:`);
            console.log(`  Qty: ${p.qty} shares`);
            console.log(`  Entry: $${parseFloat(p.avg_entry_price).toFixed(2)}`);
            console.log(`  Current: $${parseFloat(p.current_price).toFixed(2)}`);
            console.log(`  P/L: ${emoji} $${pl.toFixed(2)} (${plPct.toFixed(1)}%)`);
            console.log(`  Value: $${parseFloat(p.market_value).toFixed(2)}`);
            console.log('');
        }

        console.log(`${'─'.repeat(30)}`);
        console.log(`Total Unrealized P/L: ${totalPL >= 0 ? '🟢' : '🔴'} $${totalPL.toFixed(2)}`);

        return positions;
    }

    /**
     * Show orders
     */
    async orders(status = 'all') {
        console.log(`\n📋 Orders (${status})\n`);
        const orders = await alpaca.getOrders(status);

        if (orders.length === 0) {
            console.log('No orders found.');
            return [];
        }

        for (const o of orders) {
            const statusEmoji = o.status === 'filled' ? '✅' :
                               o.status === 'canceled' ? '❌' :
                               o.status === 'pending_new' ? '⏳' : '📝';

            console.log(`${statusEmoji} ${o.side.toUpperCase()} ${o.qty} ${o.symbol}`);
            console.log(`   Type: ${o.type} | Status: ${o.status}`);
            if (o.limit_price) console.log(`   Limit: $${o.limit_price}`);
            if (o.filled_avg_price) console.log(`   Filled: $${o.filled_avg_price}`);
            console.log(`   Created: ${o.created_at}`);
            console.log('');
        }

        return orders;
    }

    /**
     * Cancel all orders
     */
    async cancelAll() {
        console.log('\n🚫 Canceling all open orders...\n');
        const result = await alpaca.cancelAllOrders();
        console.log('✅ All orders canceled.');
        return result;
    }

    /**
     * Close all positions
     */
    async closeAll() {
        console.log('\n🚫 Closing all positions...\n');
        const result = await alpaca.closeAllPositions();
        console.log('✅ All positions closed.');
        return result;
    }

    /**
     * Show help
     */
    help() {
        console.log(BANNER);
        console.log('Commands:');
        console.log('  scan              Run full daily catalyst scan');
        console.log('  analyze <SYM>     Deep analysis of a specific symbol');
        console.log('  market            Get current market context (VIX, sectors)');
        console.log('  earnings [days]   Show upcoming earnings (default: 7 days)');
        console.log('  sentiment         Social media sentiment scan (Reddit + StockTwits)');
        console.log('  sentsym <SYM>     Deep sentiment for specific symbol');
        console.log('  contrarian        Bearish/short interest/small-cap scan');
        console.log('  watch list        Show watchlist');
        console.log('  watch add <SYM>   Add symbol to watchlist');
        console.log('  watch remove <SYM> Remove symbol from watchlist');
        console.log('');
        console.log('Trading (Alpaca Paper):');
        console.log('  account           Show paper trading account');
        console.log('  buy <SYM> <QTY>   Buy shares');
        console.log('  sell <SYM> <QTY>  Sell shares');
        console.log('  positions         Show current positions');
        console.log('  orders [status]   Show orders (open/closed/all)');
        console.log('  cancelall         Cancel all open orders');
        console.log('  closeall          Close all positions');
        console.log('');
        console.log('  help              Show this help message');
        console.log('\nSentiment Sources:');
        console.log('  • Reddit (via ApeWisdom) - WSB, stocks, investing mentions');
        console.log('  • StockTwits - Real-time social sentiment');
        console.log('  • Finviz - News, short interest, fundamentals');
        console.log('\nOptions:');
        console.log('  --json            Output in JSON format');
        console.log('\nExamples:');
        console.log('  node index.js scan');
        console.log('  node index.js analyze AAPL');
        console.log('  node index.js buy SMCI 10');
        console.log('  node index.js account');
    }
}

// Main execution
async function main() {
    const cli = new SwingOptionsCLI();
    const args = process.argv.slice(2);

    const command = args[0];
    const options = {
        json: args.includes('--json')
    };

    try {
        switch (command) {
            case 'scan':
                await cli.scan(options);
                break;

            case 'analyze':
                const symbol = args[1];
                if (!symbol) {
                    console.log('Usage: node index.js analyze <SYMBOL>');
                    process.exit(1);
                }
                await cli.analyze(symbol, options);
                break;

            case 'market':
                await cli.market(options);
                break;

            case 'earnings':
                const days = parseInt(args[1]) || 7;
                await cli.earnings(days);
                break;

            case 'sentiment':
                await cli.sentiment();
                break;

            case 'sentsym':
                const sentSymbol = args[1];
                if (!sentSymbol) {
                    console.log('Usage: node index.js sentsym <SYMBOL>');
                    process.exit(1);
                }
                await cli.symbolSentiment(sentSymbol);
                break;

            case 'contrarian':
            case 'bearish':
            case 'shorts':
                await cli.contrarian();
                break;

            case 'watch':
                const action = args[1] || 'list';
                const watchSymbol = args[2];
                await cli.watchlist(action, watchSymbol);
                break;

            // Trading commands
            case 'account':
            case 'acc':
                await cli.account();
                break;

            case 'buy':
                const buySymbol = args[1];
                const buyQty = parseInt(args[2]);
                if (!buySymbol || !buyQty) {
                    console.log('Usage: node index.js buy <SYMBOL> <QTY>');
                    process.exit(1);
                }
                await cli.buy(buySymbol, buyQty);
                break;

            case 'sell':
                const sellSymbol = args[1];
                const sellQty = parseInt(args[2]);
                if (!sellSymbol || !sellQty) {
                    console.log('Usage: node index.js sell <SYMBOL> <QTY>');
                    process.exit(1);
                }
                await cli.sell(sellSymbol, sellQty);
                break;

            case 'positions':
            case 'pos':
                await cli.positions();
                break;

            case 'orders':
                const orderStatus = args[1] || 'all';
                await cli.orders(orderStatus);
                break;

            case 'cancelall':
                await cli.cancelAll();
                break;

            case 'closeall':
                await cli.closeAll();
                break;

            case 'help':
            case '--help':
            case '-h':
            default:
                cli.help();
        }
    } catch (error) {
        console.error('Error:', error.message);
        if (process.env.DEBUG) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Export for programmatic use
module.exports = { SwingOptionsCLI };

// Run if called directly
if (require.main === module) {
    main();
}
