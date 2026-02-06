/**
 * Alpaca Trading Client
 *
 * Full integration with Alpaca API for:
 * - Paper trading stocks and options
 * - Account management
 * - Order placement and management
 * - Position tracking
 * - Market data
 *
 * Uses official @alpacahq/alpaca-trade-api SDK
 */

const fs = require('fs');
const path = require('path');

// Try to load SDK, provide fallback REST implementation
let Alpaca;
try {
    Alpaca = require('@alpacahq/alpaca-trade-api');
} catch (e) {
    Alpaca = null;
}

// Load credentials from API_KEYS.md or environment
function loadCredentials() {
    // Check environment first
    if (process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY) {
        return {
            keyId: process.env.APCA_API_KEY_ID,
            secretKey: process.env.APCA_API_SECRET_KEY,
            paper: process.env.APCA_API_BASE_URL?.includes('paper') ?? true
        };
    }

    // Load from vault (paper trading)
    const { getInternal } = require('../security/vault');
    try {
        const keyId = getInternal('ALPACA_API_KEY');
        const secretKey = getInternal('ALPACA_API_SECRET');

        if (keyId && secretKey) {
            return {
                keyId,
                secretKey,
                paper: true,
                baseUrl: 'https://paper-api.alpaca.markets'
            };
        }
    } catch (error) {
        console.error('Failed to load Alpaca credentials from vault:', error.message);
    }

    // Fallback (should not reach here if vault is initialized)
    throw new Error('Alpaca credentials not found. Initialize vault with master key.');
}

/**
 * REST-based fallback client (no SDK dependency)
 */
class AlpacaRestClient {
    constructor(config) {
        this.keyId = config.keyId;
        this.secretKey = config.secretKey;
        this.baseUrl = config.baseUrl || 'https://paper-api.alpaca.markets';
        this.dataUrl = 'https://data.alpaca.markets';
    }

    async request(endpoint, method = 'GET', body = null) {
        const url = `${this.baseUrl}${endpoint}`;
        const options = {
            method,
            headers: {
                'APCA-API-KEY-ID': this.keyId,
                'APCA-API-SECRET-KEY': this.secretKey,
                'Content-Type': 'application/json'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`Alpaca API error: ${response.status} - ${text}`);
        }

        return text ? JSON.parse(text) : null;
    }

    async dataRequest(endpoint) {
        const url = `${this.dataUrl}${endpoint}`;
        const response = await fetch(url, {
            headers: {
                'APCA-API-KEY-ID': this.keyId,
                'APCA-API-SECRET-KEY': this.secretKey
            }
        });

        if (!response.ok) {
            throw new Error(`Alpaca Data API error: ${response.status}`);
        }

        return response.json();
    }

    // Account
    async getAccount() {
        return this.request('/v2/account');
    }

    // Positions
    async getPositions() {
        return this.request('/v2/positions');
    }

    async getPosition(symbol) {
        return this.request(`/v2/positions/${symbol}`);
    }

    async closePosition(symbol, params = {}) {
        const query = params.qty ? `?qty=${params.qty}` : '';
        return this.request(`/v2/positions/${symbol}${query}`, 'DELETE');
    }

    async closeAllPositions() {
        return this.request('/v2/positions', 'DELETE');
    }

    // Orders
    async getOrders(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/v2/orders${query ? '?' + query : ''}`);
    }

    async getOrder(orderId) {
        return this.request(`/v2/orders/${orderId}`);
    }

    async createOrder(params) {
        return this.request('/v2/orders', 'POST', params);
    }

    async cancelOrder(orderId) {
        return this.request(`/v2/orders/${orderId}`, 'DELETE');
    }

    async cancelAllOrders() {
        return this.request('/v2/orders', 'DELETE');
    }

    // Assets
    async getAsset(symbol) {
        return this.request(`/v2/assets/${symbol}`);
    }

    async getAssets(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/v2/assets${query ? '?' + query : ''}`);
    }

    // Options
    async getOptionsContracts(params) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/v2/options/contracts${query ? '?' + query : ''}`);
    }

    async getOptionsContract(contractId) {
        return this.request(`/v2/options/contracts/${contractId}`);
    }

    // Market Data
    async getLatestQuote(symbol) {
        return this.dataRequest(`/v2/stocks/${symbol}/quotes/latest`);
    }

    async getLatestTrade(symbol) {
        return this.dataRequest(`/v2/stocks/${symbol}/trades/latest`);
    }

    async getBars(symbol, timeframe = '1Day', params = {}) {
        const query = new URLSearchParams({ timeframe, ...params }).toString();
        return this.dataRequest(`/v2/stocks/${symbol}/bars?${query}`);
    }

    // Clock & Calendar
    async getClock() {
        return this.request('/v2/clock');
    }

    async getCalendar(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/v2/calendar${query ? '?' + query : ''}`);
    }
}

/**
 * Main Alpaca Trading Client
 */
class AlpacaClient {
    constructor() {
        const config = loadCredentials();

        if (Alpaca) {
            this.client = new Alpaca({
                keyId: config.keyId,
                secretKey: config.secretKey,
                paper: config.paper,
                baseUrl: config.baseUrl
            });
            this.useSDK = true;
        } else {
            this.client = new AlpacaRestClient(config);
            this.useSDK = false;
        }

        this.isPaper = config.paper;
    }

    /**
     * Get account information
     */
    async getAccount() {
        if (this.useSDK) {
            return this.client.getAccount();
        }
        return this.client.getAccount();
    }

    /**
     * Get buying power
     */
    async getBuyingPower() {
        const account = await this.getAccount();
        return {
            buyingPower: parseFloat(account.buying_power),
            cash: parseFloat(account.cash),
            portfolioValue: parseFloat(account.portfolio_value),
            equity: parseFloat(account.equity),
            lastEquity: parseFloat(account.last_equity),
            dayTradeCount: account.daytrade_count,
            patternDayTrader: account.pattern_day_trader
        };
    }

    /**
     * Get all positions
     */
    async getPositions() {
        if (this.useSDK) {
            return this.client.getPositions();
        }
        return this.client.getPositions();
    }

    /**
     * Get position for specific symbol
     */
    async getPosition(symbol) {
        try {
            if (this.useSDK) {
                return this.client.getPosition(symbol);
            }
            return this.client.getPosition(symbol);
        } catch (e) {
            return null; // No position
        }
    }

    /**
     * Place a market order for stocks
     */
    async buyStock(symbol, qty, options = {}) {
        const order = {
            symbol: symbol.toUpperCase(),
            qty: qty,
            side: 'buy',
            type: 'market',
            time_in_force: options.timeInForce || 'day',
            ...options
        };

        if (this.useSDK) {
            return this.client.createOrder(order);
        }
        return this.client.createOrder(order);
    }

    /**
     * Sell stock
     */
    async sellStock(symbol, qty, options = {}) {
        const order = {
            symbol: symbol.toUpperCase(),
            qty: qty,
            side: 'sell',
            type: 'market',
            time_in_force: options.timeInForce || 'day',
            ...options
        };

        if (this.useSDK) {
            return this.client.createOrder(order);
        }
        return this.client.createOrder(order);
    }

    /**
     * Place a limit order
     */
    async limitOrder(symbol, qty, side, limitPrice, options = {}) {
        const order = {
            symbol: symbol.toUpperCase(),
            qty: qty,
            side: side,
            type: 'limit',
            limit_price: limitPrice,
            time_in_force: options.timeInForce || 'day',
            ...options
        };

        if (this.useSDK) {
            return this.client.createOrder(order);
        }
        return this.client.createOrder(order);
    }

    /**
     * Place a stop loss order
     */
    async stopOrder(symbol, qty, side, stopPrice, options = {}) {
        const order = {
            symbol: symbol.toUpperCase(),
            qty: qty,
            side: side,
            type: 'stop',
            stop_price: stopPrice,
            time_in_force: options.timeInForce || 'day',
            ...options
        };

        if (this.useSDK) {
            return this.client.createOrder(order);
        }
        return this.client.createOrder(order);
    }

    /**
     * Buy options contract
     */
    async buyOption(contractSymbol, qty, options = {}) {
        const order = {
            symbol: contractSymbol, // e.g., "SMCI260221C00033000"
            qty: qty,
            side: 'buy',
            type: options.type || 'limit',
            time_in_force: options.timeInForce || 'day',
            limit_price: options.limitPrice,
            ...options
        };

        if (this.useSDK) {
            return this.client.createOrder(order);
        }
        return this.client.createOrder(order);
    }

    /**
     * Sell options contract
     */
    async sellOption(contractSymbol, qty, options = {}) {
        const order = {
            symbol: contractSymbol,
            qty: qty,
            side: 'sell',
            type: options.type || 'limit',
            time_in_force: options.timeInForce || 'day',
            limit_price: options.limitPrice,
            ...options
        };

        if (this.useSDK) {
            return this.client.createOrder(order);
        }
        return this.client.createOrder(order);
    }

    /**
     * Get available options contracts for a symbol
     */
    async getOptionsChain(symbol, params = {}) {
        const queryParams = {
            underlying_symbols: symbol.toUpperCase(),
            ...params
        };

        if (this.useSDK) {
            // SDK may have different method
            return this.client.getOptionsContracts ?
                this.client.getOptionsContracts(queryParams) :
                this.client.request(`/v2/options/contracts`, 'GET', null, queryParams);
        }
        return this.client.getOptionsContracts(queryParams);
    }

    /**
     * Get all open orders
     */
    async getOrders(status = 'open') {
        if (this.useSDK) {
            return this.client.getOrders({ status });
        }
        return this.client.getOrders({ status });
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId) {
        if (this.useSDK) {
            return this.client.cancelOrder(orderId);
        }
        return this.client.cancelOrder(orderId);
    }

    /**
     * Cancel all open orders
     */
    async cancelAllOrders() {
        if (this.useSDK) {
            return this.client.cancelAllOrders();
        }
        return this.client.cancelAllOrders();
    }

    /**
     * Close a position
     */
    async closePosition(symbol, qty = null) {
        if (this.useSDK) {
            return this.client.closePosition(symbol, qty ? { qty } : {});
        }
        return this.client.closePosition(symbol, qty ? { qty } : {});
    }

    /**
     * Close all positions
     */
    async closeAllPositions() {
        if (this.useSDK) {
            return this.client.closeAllPositions();
        }
        return this.client.closeAllPositions();
    }

    /**
     * Get latest quote for a symbol
     */
    async getQuote(symbol) {
        if (this.useSDK) {
            return this.client.getLatestQuote(symbol);
        }
        return this.client.getLatestQuote(symbol);
    }

    /**
     * Check if market is open
     */
    async isMarketOpen() {
        const clock = this.useSDK ?
            await this.client.getClock() :
            await this.client.getClock();
        return clock.is_open;
    }

    /**
     * Get market clock
     */
    async getClock() {
        if (this.useSDK) {
            return this.client.getClock();
        }
        return this.client.getClock();
    }

    /**
     * Format account summary for display
     */
    async getAccountSummary() {
        const account = await this.getAccount();
        const positions = await this.getPositions();
        const orders = await this.getOrders('open');

        return {
            account: {
                equity: parseFloat(account.equity),
                cash: parseFloat(account.cash),
                buyingPower: parseFloat(account.buying_power),
                portfolioValue: parseFloat(account.portfolio_value),
                dayTradeCount: account.daytrade_count,
                status: account.status
            },
            positions: positions.map(p => ({
                symbol: p.symbol,
                qty: parseFloat(p.qty),
                avgEntry: parseFloat(p.avg_entry_price),
                currentPrice: parseFloat(p.current_price),
                marketValue: parseFloat(p.market_value),
                unrealizedPL: parseFloat(p.unrealized_pl),
                unrealizedPLPercent: parseFloat(p.unrealized_plpc) * 100
            })),
            openOrders: orders.map(o => ({
                id: o.id,
                symbol: o.symbol,
                side: o.side,
                type: o.type,
                qty: o.qty,
                filledQty: o.filled_qty,
                limitPrice: o.limit_price,
                status: o.status
            })),
            isPaper: this.isPaper
        };
    }

    /**
     * Format for Discord message
     */
    async formatForDiscord() {
        const summary = await this.getAccountSummary();

        let msg = `**${this.isPaper ? '📝 PAPER' : '💵 LIVE'} TRADING ACCOUNT**\n\n`;

        msg += `**Account:**\n`;
        msg += `• Equity: $${summary.account.equity.toLocaleString()}\n`;
        msg += `• Cash: $${summary.account.cash.toLocaleString()}\n`;
        msg += `• Buying Power: $${summary.account.buyingPower.toLocaleString()}\n\n`;

        if (summary.positions.length > 0) {
            msg += `**Positions (${summary.positions.length}):**\n`;
            for (const p of summary.positions) {
                const plEmoji = p.unrealizedPL >= 0 ? '🟢' : '🔴';
                msg += `• ${p.symbol}: ${p.qty} @ $${p.avgEntry.toFixed(2)} → $${p.currentPrice.toFixed(2)} ${plEmoji} ${p.unrealizedPLPercent.toFixed(1)}%\n`;
            }
            msg += '\n';
        } else {
            msg += `**Positions:** None\n\n`;
        }

        if (summary.openOrders.length > 0) {
            msg += `**Open Orders (${summary.openOrders.length}):**\n`;
            for (const o of summary.openOrders) {
                msg += `• ${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ ${o.limitPrice || 'MKT'} (${o.status})\n`;
            }
        }

        return msg;
    }
}

// Singleton instance
let alpacaClient = null;

function getClient() {
    if (!alpacaClient) {
        alpacaClient = new AlpacaClient();
    }
    return alpacaClient;
}

// Export
module.exports = {
    AlpacaClient,
    getClient,

    // Convenience functions
    getAccount: () => getClient().getAccount(),
    getBuyingPower: () => getClient().getBuyingPower(),
    getPositions: () => getClient().getPositions(),
    getPosition: (symbol) => getClient().getPosition(symbol),
    buyStock: (symbol, qty, opts) => getClient().buyStock(symbol, qty, opts),
    sellStock: (symbol, qty, opts) => getClient().sellStock(symbol, qty, opts),
    limitOrder: (symbol, qty, side, price, opts) => getClient().limitOrder(symbol, qty, side, price, opts),
    stopOrder: (symbol, qty, side, price, opts) => getClient().stopOrder(symbol, qty, side, price, opts),
    buyOption: (contract, qty, opts) => getClient().buyOption(contract, qty, opts),
    sellOption: (contract, qty, opts) => getClient().sellOption(contract, qty, opts),
    getOptionsChain: (symbol, params) => getClient().getOptionsChain(symbol, params),
    getOrders: (status) => getClient().getOrders(status),
    cancelOrder: (id) => getClient().cancelOrder(id),
    cancelAllOrders: () => getClient().cancelAllOrders(),
    closePosition: (symbol, qty) => getClient().closePosition(symbol, qty),
    closeAllPositions: () => getClient().closeAllPositions(),
    getQuote: (symbol) => getClient().getQuote(symbol),
    isMarketOpen: () => getClient().isMarketOpen(),
    getClock: () => getClient().getClock(),
    getAccountSummary: () => getClient().getAccountSummary(),
    formatForDiscord: () => getClient().formatForDiscord()
};

// CLI
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const command = args[0];
        const client = getClient();

        console.log(`Alpaca Client (${client.isPaper ? 'PAPER' : 'LIVE'} trading)`);
        console.log(`Using ${client.useSDK ? 'Official SDK' : 'REST API'}\n`);

        switch (command) {
            case 'account':
                console.log(JSON.stringify(await client.getAccountSummary(), null, 2));
                break;

            case 'positions':
                console.log(JSON.stringify(await client.getPositions(), null, 2));
                break;

            case 'orders':
                console.log(JSON.stringify(await client.getOrders('all'), null, 2));
                break;

            case 'buy':
                if (args.length < 3) {
                    console.log('Usage: buy <symbol> <qty>');
                    break;
                }
                const buyResult = await client.buyStock(args[1], parseInt(args[2]));
                console.log('Order placed:', buyResult);
                break;

            case 'sell':
                if (args.length < 3) {
                    console.log('Usage: sell <symbol> <qty>');
                    break;
                }
                const sellResult = await client.sellStock(args[1], parseInt(args[2]));
                console.log('Order placed:', sellResult);
                break;

            case 'quote':
                if (args.length < 2) {
                    console.log('Usage: quote <symbol>');
                    break;
                }
                console.log(JSON.stringify(await client.getQuote(args[1]), null, 2));
                break;

            case 'clock':
                const clock = await client.getClock();
                console.log('Market open:', clock.is_open);
                console.log('Next open:', clock.next_open);
                console.log('Next close:', clock.next_close);
                break;

            case 'discord':
                console.log(await client.formatForDiscord());
                break;

            default:
                console.log('Alpaca Trading Client');
                console.log('Commands:');
                console.log('  account   - Show account summary');
                console.log('  positions - Show current positions');
                console.log('  orders    - Show all orders');
                console.log('  buy <sym> <qty> - Buy stock');
                console.log('  sell <sym> <qty> - Sell stock');
                console.log('  quote <sym> - Get quote');
                console.log('  clock     - Market hours');
                console.log('  discord   - Format for Discord');
        }
    })();
}
