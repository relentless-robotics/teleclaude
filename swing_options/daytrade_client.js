/**
 * Day Trade Alpaca Client - OPTIONS ONLY
 *
 * Separate Alpaca paper account dedicated to intraday options trading.
 * Uses DAYTRADE_ALPACA_API_KEY / DAYTRADE_ALPACA_API_SECRET from vault.
 *
 * This account trades options only. No stock positions.
 */

const fs = require('fs');
const path = require('path');

// Load credentials from vault
function loadDayTradeCredentials() {
  // Try vault first
  try {
    const vl = require('../security/vault_loader');
    if (!vl.isInitialized()) vl.initVaultFromSecure();
    const keyId = vl.getSecret('DAYTRADE_ALPACA_API_KEY');
    const secretKey = vl.getSecret('DAYTRADE_ALPACA_API_SECRET');
    if (keyId && secretKey) {
      return { keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' };
    }
  } catch (e) {
    // Fall through
  }

  // Env vars fallback
  if (process.env.DAYTRADE_ALPACA_KEY && process.env.DAYTRADE_ALPACA_SECRET) {
    return {
      keyId: process.env.DAYTRADE_ALPACA_KEY,
      secretKey: process.env.DAYTRADE_ALPACA_SECRET,
      baseUrl: 'https://paper-api.alpaca.markets',
    };
  }

  throw new Error('Day trade Alpaca credentials not found in vault or env.');
}

class DayTradeClient {
  constructor() {
    const config = loadDayTradeCredentials();
    this.keyId = config.keyId;
    this.secretKey = config.secretKey;
    this.baseUrl = config.baseUrl;
    this.dataUrl = 'https://data.alpaca.markets';
  }

  // ============================================================================
  // HTTP helpers
  // ============================================================================

  async request(endpoint, method = 'GET', body = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json',
      },
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Alpaca ${method} ${endpoint}: ${response.status} - ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async dataRequest(endpoint) {
    const url = `${this.dataUrl}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
      },
    });
    if (!response.ok) throw new Error(`Alpaca Data ${response.status}`);
    return response.json();
  }

  // ============================================================================
  // Account
  // ============================================================================

  async getAccount() {
    return this.request('/v2/account');
  }

  async getAccountSummary() {
    const acc = await this.getAccount();
    return {
      equity: parseFloat(acc.portfolio_value),
      cash: parseFloat(acc.cash),
      buyingPower: parseFloat(acc.buying_power),
      lastEquity: parseFloat(acc.last_equity),
      dailyPL: parseFloat(acc.portfolio_value) - parseFloat(acc.last_equity),
      optionsLevel: acc.options_trading_level || acc.options_approved_level,
      daytradeCount: acc.daytrade_count,
      status: acc.status,
    };
  }

  // ============================================================================
  // Positions
  // ============================================================================

  async getPositions() {
    return this.request('/v2/positions');
  }

  async getPosition(symbolOrId) {
    try {
      return this.request(`/v2/positions/${encodeURIComponent(symbolOrId)}`);
    } catch (e) {
      return null;
    }
  }

  async closePosition(symbolOrId, qty = null) {
    const query = qty ? `?qty=${qty}` : '';
    return this.request(`/v2/positions/${encodeURIComponent(symbolOrId)}${query}`, 'DELETE');
  }

  async closeAllPositions() {
    return this.request('/v2/positions?cancel_orders=true', 'DELETE');
  }

  // ============================================================================
  // Options Contracts Discovery
  // ============================================================================

  /** Get available options contracts for a symbol */
  async getOptionsContracts(params) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/v2/options/contracts${query ? '?' + query : ''}`);
  }

  /**
   * Find specific option contract
   * @param {string} underlying - e.g. 'AAPL'
   * @param {string} expiration - e.g. '2026-02-07'
   * @param {string} type - 'call' or 'put'
   * @param {number} strike - strike price
   */
  async findContract(underlying, expiration, type, strike) {
    const contracts = await this.getOptionsContracts({
      underlying_symbols: underlying,
      expiration_date: expiration,
      type: type,
      strike_price_gte: strike,
      strike_price_lte: strike,
      status: 'active',
      limit: 5,
    });
    return contracts?.option_contracts?.[0] || null;
  }

  /**
   * Get options chain for a symbol (all strikes for an expiration)
   */
  async getOptionsChain(underlying, expiration, type = null) {
    const params = {
      underlying_symbols: underlying,
      expiration_date: expiration,
      status: 'active',
      limit: 100,
    };
    if (type) params.type = type;
    const result = await this.getOptionsContracts(params);
    return result?.option_contracts || [];
  }

  /**
   * Get nearest weekly expiration contracts
   */
  async getWeeklyOptions(underlying, type = 'call') {
    // Get next 7 days of expirations
    const today = new Date();
    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);

    const params = {
      underlying_symbols: underlying,
      expiration_date_gte: today.toISOString().split('T')[0],
      expiration_date_lte: nextWeek.toISOString().split('T')[0],
      type: type,
      status: 'active',
      limit: 100,
    };
    const result = await this.getOptionsContracts(params);
    return result?.option_contracts || [];
  }

  // ============================================================================
  // Options Trading
  // ============================================================================

  /**
   * Buy an option contract
   * @param {string} symbol - OCC symbol (e.g. 'AAPL260207C00230000') or contract ID
   * @param {number} qty - number of contracts
   * @param {object} options - { limitPrice, timeInForce }
   */
  async buyOption(symbol, qty, options = {}) {
    const order = {
      symbol: symbol,
      qty: qty.toString(),
      side: 'buy',
      type: options.limitPrice ? 'limit' : 'market',
      time_in_force: options.timeInForce || 'day',
    };
    if (options.limitPrice) order.limit_price = options.limitPrice.toString();
    return this.request('/v2/orders', 'POST', order);
  }

  /**
   * Sell (close) an option position
   */
  async sellOption(symbol, qty, options = {}) {
    const order = {
      symbol: symbol,
      qty: qty.toString(),
      side: 'sell',
      type: options.limitPrice ? 'limit' : 'market',
      time_in_force: options.timeInForce || 'day',
    };
    if (options.limitPrice) order.limit_price = options.limitPrice.toString();
    return this.request('/v2/orders', 'POST', order);
  }

  /**
   * Buy to open a call
   */
  async buyCall(underlying, expiration, strike, qty = 1, options = {}) {
    const contract = await this.findContract(underlying, expiration, 'call', strike);
    if (!contract) throw new Error(`No call contract found: ${underlying} ${expiration} $${strike}`);
    return this.buyOption(contract.symbol, qty, options);
  }

  /**
   * Buy to open a put
   */
  async buyPut(underlying, expiration, strike, qty = 1, options = {}) {
    const contract = await this.findContract(underlying, expiration, 'put', strike);
    if (!contract) throw new Error(`No put contract found: ${underlying} ${expiration} $${strike}`);
    return this.buyOption(contract.symbol, qty, options);
  }

  // ============================================================================
  // Orders
  // ============================================================================

  async getOrders(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/v2/orders${query ? '?' + query : ''}`);
  }

  async getOrder(orderId) {
    return this.request(`/v2/orders/${orderId}`);
  }

  async cancelOrder(orderId) {
    return this.request(`/v2/orders/${orderId}`, 'DELETE');
  }

  async cancelAllOrders() {
    return this.request('/v2/orders', 'DELETE');
  }

  // ============================================================================
  // Market Data
  // ============================================================================

  async getLatestQuote(symbol) {
    return this.dataRequest(`/v2/stocks/${symbol}/quotes/latest`);
  }

  async getLatestOptionQuote(symbol) {
    return this.dataRequest(`/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(symbol)}`);
  }

  async getOptionsBars(symbol, timeframe = '1Day') {
    return this.dataRequest(`/v1beta1/options/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}`);
  }

  async getStockBars(symbol, timeframe = '1Day', params = {}) {
    const query = new URLSearchParams({ timeframe, ...params }).toString();
    return this.dataRequest(`/v2/stocks/${symbol}/bars?${query}`);
  }

  async getStockSnapshot(symbol) {
    return this.dataRequest(`/v2/stocks/${symbol}/snapshot`);
  }

  // ============================================================================
  // Market Clock
  // ============================================================================

  async getClock() {
    return this.request('/v2/clock');
  }

  async isMarketOpen() {
    const clock = await this.getClock();
    return clock.is_open;
  }

  // ============================================================================
  // Day Trade Specific Helpers
  // ============================================================================

  /**
   * Close ALL positions - called at EOD
   */
  async flattenAll() {
    const positions = await this.getPositions();
    const results = [];

    for (const pos of positions) {
      try {
        const result = await this.closePosition(pos.symbol);
        results.push({ symbol: pos.symbol, status: 'closed', result });
      } catch (e) {
        results.push({ symbol: pos.symbol, status: 'error', error: e.message });
      }
    }

    return results;
  }

  /**
   * Get today's P&L
   */
  async getTodayPnL() {
    const acc = await this.getAccount();
    const equity = parseFloat(acc.portfolio_value);
    const lastEquity = parseFloat(acc.last_equity);
    return {
      pnl: equity - lastEquity,
      pnlPct: ((equity - lastEquity) / lastEquity * 100),
      equity,
      lastEquity,
    };
  }

  /**
   * Get today's closed trades (filled orders)
   */
  async getTodayTrades() {
    const today = new Date().toISOString().split('T')[0];
    const orders = await this.getOrders({
      status: 'closed',
      after: `${today}T00:00:00Z`,
      limit: 100,
    });
    return Array.isArray(orders) ? orders.filter(o => o.filled_at) : [];
  }

  /**
   * Position sizing helper
   * @param {number} riskPct - percent of account to risk (e.g. 0.02 = 2%)
   * @param {number} contractPrice - price per contract (premium)
   * @returns {number} number of contracts to buy
   */
  async calculatePositionSize(riskPct, contractPrice) {
    const acc = await this.getAccountSummary();
    const riskAmount = acc.equity * riskPct;
    // Each contract = 100 shares, cost = contractPrice * 100
    const costPerContract = contractPrice * 100;
    return Math.max(1, Math.floor(riskAmount / costPerContract));
  }
}

// Singleton
let _instance = null;
function getClient() {
  if (!_instance) _instance = new DayTradeClient();
  return _instance;
}

module.exports = {
  DayTradeClient,
  getClient,
  // Convenience exports
  getAccount: () => getClient().getAccountSummary(),
  getPositions: () => getClient().getPositions(),
  buyCall: (u, e, s, q, o) => getClient().buyCall(u, e, s, q, o),
  buyPut: (u, e, s, q, o) => getClient().buyPut(u, e, s, q, o),
  buyOption: (s, q, o) => getClient().buyOption(s, q, o),
  sellOption: (s, q, o) => getClient().sellOption(s, q, o),
  closePosition: (s, q) => getClient().closePosition(s, q),
  closeAll: () => getClient().flattenAll(),
  getOptionsChain: (u, e, t) => getClient().getOptionsChain(u, e, t),
  getWeeklyOptions: (u, t) => getClient().getWeeklyOptions(u, t),
  getTodayPnL: () => getClient().getTodayPnL(),
  getTodayTrades: () => getClient().getTodayTrades(),
  calculatePositionSize: (r, p) => getClient().calculatePositionSize(r, p),
  isMarketOpen: () => getClient().isMarketOpen(),
};
