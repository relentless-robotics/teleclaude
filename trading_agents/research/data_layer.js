/**
 * Unified Data Layer — Alpaca Primary, Yahoo Fallback
 *
 * Single source of truth for all market data across research modules.
 * Features:
 * - Alpaca as primary data provider (authenticated, reliable)
 * - Yahoo Finance as fallback (free, no key)
 * - In-memory cache with configurable TTL per data type
 * - Request deduplication (concurrent requests for same data share one fetch)
 * - HTTP connection pooling via keep-alive agent
 *
 * Usage:
 *   const data = require('./data_layer');
 *   const quote = await data.getQuote('AAPL');
 *   const bars = await data.getHistoricalBars('AAPL', '6mo');
 *   const snapshot = await data.getSnapshot('AAPL');
 *   const multi = await data.getSnapshots(['AAPL', 'MSFT', 'GOOGL']);
 */

const https = require('https');

// HTTP connection pool — reused across ALL requests
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  maxFreeSockets: 5,
  timeout: 30000,
});

// ============================================================================
// Cache
// ============================================================================

class DataCache {
  constructor() {
    this._store = new Map();
    // Cleanup every 5 min
    this._cleanupInterval = setInterval(() => this._cleanup(), 300000);
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this._store.set(key, { value, expires: Date.now() + ttlMs });
  }

  has(key) {
    return this.get(key) !== null;
  }

  invalidate(pattern) {
    for (const key of this._store.keys()) {
      if (key.includes(pattern)) this._store.delete(key);
    }
  }

  clear() {
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expires) this._store.delete(key);
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    this._store.clear();
  }
}

// TTL values by data type
const TTL = {
  QUOTE: 60 * 1000,           // 1 min — quotes change fast
  SNAPSHOT: 60 * 1000,         // 1 min
  BARS_DAILY: 5 * 60 * 1000,  // 5 min — daily bars don't change intraday
  BARS_INTRADAY: 60 * 1000,   // 1 min
  OPTIONS_CHAIN: 2 * 60 * 1000, // 2 min — options data
  SECTOR: 5 * 60 * 1000,      // 5 min — sector data
};

const cache = new DataCache();

// ============================================================================
// Request Deduplication
// ============================================================================

const inflight = new Map();

async function deduped(key, fetchFn) {
  // Return cached value if available
  const cached = cache.get(key);
  if (cached !== null) return cached;

  // If there's already an inflight request for this key, wait for it
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  // Start new request
  const promise = fetchFn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ============================================================================
// Alpaca Credentials
// ============================================================================

let _alpacaCreds = null;

function getAlpacaCredentials() {
  if (_alpacaCreds) return _alpacaCreds;

  // Try vault_loader first (used by scheduler/agents)
  try {
    const vl = require('../../security/vault_loader');
    if (!vl.isInitialized()) vl.initVaultFromSecure();
    const keyId = vl.getSecret('ALPACA_API_KEY');
    const secretKey = vl.getSecret('ALPACA_API_SECRET');
    if (keyId && secretKey) {
      _alpacaCreds = { keyId, secretKey };
      console.log('[DataLayer] Alpaca credentials loaded from vault');
      return _alpacaCreds;
    }
  } catch (e) { /* try vault internal */ }

  // Try vault internal
  try {
    const { getInternal } = require('../../security/vault');
    const keyId = getInternal('ALPACA_API_KEY');
    const secretKey = getInternal('ALPACA_API_SECRET');
    if (keyId && secretKey) {
      _alpacaCreds = { keyId, secretKey };
      return _alpacaCreds;
    }
  } catch (e) { /* try env */ }

  // Try environment
  if (process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY) {
    _alpacaCreds = {
      keyId: process.env.APCA_API_KEY_ID,
      secretKey: process.env.APCA_API_SECRET_KEY,
    };
    return _alpacaCreds;
  }

  return null;
}

// ============================================================================
// HTTP Helpers
// ============================================================================

function alpacaFetch(endpoint) {
  const creds = getAlpacaCredentials();
  if (!creds) return Promise.resolve(null);

  const url = `https://data.alpaca.markets${endpoint}`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      agent: httpsAgent,
      headers: {
        'APCA-API-KEY-ID': creds.keyId,
        'APCA-API-SECRET-KEY': creds.secretKey,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

function yahooFetch(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      agent: httpsAgent,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

function yahooFetchHTML(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      agent: httpsAgent,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(10000, () => { req.destroy(); resolve(''); });
  });
}

function genericFetch(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      agent: httpsAgent,
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(''); });
  });
}

// ============================================================================
// Core Data Methods
// ============================================================================

/**
 * Get latest quote for a symbol
 * Returns: { symbol, price, bid, ask, prevClose, dayChange, dayChangePct }
 */
async function getQuote(symbol) {
  const key = `quote:${symbol}`;
  return deduped(key, async () => {
    // Try Alpaca first
    const alpaca = await alpacaFetch(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`);
    if (alpaca?.quote) {
      const q = alpaca.quote;
      const result = {
        symbol,
        price: (q.ap + q.bp) / 2, // midpoint
        bid: q.bp,
        ask: q.ap,
        bidSize: q.bs,
        askSize: q.as,
        source: 'alpaca',
      };
      cache.set(key, result, TTL.QUOTE);
      return result;
    }

    // Fallback: Yahoo Finance
    const yahoo = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`
    );
    const meta = yahoo?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      const result = {
        symbol,
        price: meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose,
        dayChange: meta.chartPreviousClose ?
          parseFloat(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2)) : null,
        source: 'yahoo',
      };
      cache.set(key, result, TTL.QUOTE);
      return result;
    }

    return null;
  });
}

/**
 * Get snapshot for a symbol (quote + daily bar + previous daily bar)
 * This is the most efficient single call — one request gets everything
 * Returns: { symbol, price, dayChange, monthChange, high52, low52, avgVolume, latestVolume, volRatio }
 */
async function getSnapshot(symbol) {
  const key = `snapshot:${symbol}`;
  return deduped(key, async () => {
    // Try Alpaca snapshot (one call = quote + daily bar + prev bar + minute bar)
    const alpaca = await alpacaFetch(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`);
    if (alpaca?.latestTrade || alpaca?.dailyBar) {
      const trade = alpaca.latestTrade || {};
      const daily = alpaca.dailyBar || {};
      const prevDaily = alpaca.prevDailyBar || {};
      const minute = alpaca.minuteBar || {};

      const price = trade.p || daily.c || 0;
      const prevClose = prevDaily.c || 0;

      const result = {
        symbol,
        price,
        prevClose,
        dayChange: prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : null,
        dayHigh: daily.h,
        dayLow: daily.l,
        dayOpen: daily.o,
        dayVolume: daily.v,
        prevDayVolume: prevDaily.v,
        latestVolume: daily.v,
        source: 'alpaca',
      };
      cache.set(key, result, TTL.SNAPSHOT);
      return result;
    }

    // Fallback: Yahoo Finance 1mo chart (gives us more context)
    const yahoo = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`
    );
    const yResult = yahoo?.chart?.result?.[0];
    if (yResult?.meta?.regularMarketPrice) {
      const closes = yResult.indicators?.quote?.[0]?.close?.filter(p => p !== null) || [];
      const volumes = yResult.indicators?.quote?.[0]?.volume?.filter(v => v !== null) || [];
      const price = yResult.meta.regularMarketPrice;
      const prevClose = yResult.meta.chartPreviousClose;
      const monthAgo = closes[0];
      const avgVol = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : null;
      const latestVol = volumes[volumes.length - 1];

      const result = {
        symbol,
        price,
        prevClose,
        dayChange: prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : null,
        monthChange: monthAgo ? parseFloat(((price - monthAgo) / monthAgo * 100).toFixed(2)) : null,
        high52: yResult.meta.fiftyTwoWeekHigh,
        low52: yResult.meta.fiftyTwoWeekLow,
        distFrom52High: yResult.meta.fiftyTwoWeekHigh ? parseFloat(((price - yResult.meta.fiftyTwoWeekHigh) / yResult.meta.fiftyTwoWeekHigh * 100).toFixed(1)) : null,
        distFrom52Low: yResult.meta.fiftyTwoWeekLow ? parseFloat(((price - yResult.meta.fiftyTwoWeekLow) / yResult.meta.fiftyTwoWeekLow * 100).toFixed(1)) : null,
        avgVolume: avgVol,
        latestVolume: latestVol,
        volRatio: avgVol && latestVol ? parseFloat((latestVol / avgVol).toFixed(1)) : null,
        source: 'yahoo',
      };
      cache.set(key, result, TTL.SNAPSHOT);
      return result;
    }

    return null;
  });
}

/**
 * Get snapshots for multiple symbols in ONE Alpaca call
 * This is the biggest efficiency win — replaces N individual fetches
 */
async function getSnapshots(symbols) {
  if (symbols.length === 0) return {};

  const results = {};
  const uncached = [];

  // Check cache first
  for (const sym of symbols) {
    const cached = cache.get(`snapshot:${sym}`);
    if (cached) {
      results[sym] = cached;
    } else {
      uncached.push(sym);
    }
  }

  if (uncached.length === 0) return results;

  // Try Alpaca multi-snapshot (one call for all symbols!)
  const creds = getAlpacaCredentials();
  if (creds && uncached.length > 0) {
    const symbolsParam = uncached.join(',');
    const alpaca = await alpacaFetch(`/v2/stocks/snapshots?symbols=${encodeURIComponent(symbolsParam)}`);

    if (alpaca && typeof alpaca === 'object') {
      for (const [sym, snap] of Object.entries(alpaca)) {
        const trade = snap.latestTrade || {};
        const daily = snap.dailyBar || {};
        const prevDaily = snap.prevDailyBar || {};
        const price = trade.p || daily.c || 0;
        const prevClose = prevDaily.c || 0;

        const result = {
          symbol: sym,
          price,
          prevClose,
          dayChange: prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : null,
          dayHigh: daily.h,
          dayLow: daily.l,
          dayOpen: daily.o,
          dayVolume: daily.v,
          source: 'alpaca',
        };
        results[sym] = result;
        cache.set(`snapshot:${sym}`, result, TTL.SNAPSHOT);
      }
    }
  }

  // Fallback: Yahoo for any symbols Alpaca missed
  const stillMissing = uncached.filter(s => !results[s]);
  if (stillMissing.length > 0) {
    const yahooResults = await Promise.all(
      stillMissing.map(sym => getSnapshot(sym))
    );
    for (let i = 0; i < stillMissing.length; i++) {
      if (yahooResults[i]) results[stillMissing[i]] = yahooResults[i];
    }
  }

  return results;
}

/**
 * Get historical daily bars for technical analysis
 * Returns: { symbol, meta: { price, prevClose, high52, low52 }, bars: [{ date, open, high, low, close, volume }] }
 */
async function getHistoricalBars(symbol, range = '6mo') {
  const key = `bars:${symbol}:${range}`;
  return deduped(key, async () => {
    // Map range to Alpaca params
    const rangeMap = {
      '1mo': { start: _daysAgo(30), timeframe: '1Day' },
      '3mo': { start: _daysAgo(90), timeframe: '1Day' },
      '6mo': { start: _daysAgo(180), timeframe: '1Day' },
      '1y': { start: _daysAgo(365), timeframe: '1Day' },
      '5d': { start: _daysAgo(7), timeframe: '1Day' },
    };

    const alpacaParams = rangeMap[range] || rangeMap['6mo'];

    // Try Alpaca bars
    const alpaca = await alpacaFetch(
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${alpacaParams.timeframe}&start=${alpacaParams.start}&limit=1000&adjustment=split`
    );

    if (alpaca?.bars && alpaca.bars.length > 0) {
      const bars = alpaca.bars.map(b => ({
        date: b.t.split('T')[0],
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        vwap: b.vw,
      }));

      const closes = bars.map(b => b.close);
      const price = closes[closes.length - 1];

      // Get 52-week high/low from snapshot if we need it
      let high52 = null, low52 = null;
      if (range === '6mo' || range === '1y') {
        const snapshot = await getSnapshot(symbol);
        high52 = snapshot?.high52;
        low52 = snapshot?.low52;
      }

      const result = {
        symbol,
        meta: {
          price,
          prevClose: closes.length >= 2 ? closes[closes.length - 2] : null,
          high52,
          low52,
        },
        bars,
        source: 'alpaca',
      };
      cache.set(key, result, TTL.BARS_DAILY);
      return result;
    }

    // Fallback: Yahoo Finance
    const yahoo = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`
    );
    const yResult = yahoo?.chart?.result?.[0];
    if (!yResult) return null;

    const timestamps = yResult.timestamp || [];
    const quote = yResult.indicators?.quote?.[0] || {};
    const bars = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (quote.close?.[i] !== null && quote.high?.[i] !== null && quote.low?.[i] !== null) {
        bars.push({
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          open: quote.open?.[i],
          high: quote.high[i],
          low: quote.low[i],
          close: quote.close[i],
          volume: quote.volume?.[i] || 0,
        });
      }
    }

    if (bars.length === 0) return null;

    const result = {
      symbol,
      meta: {
        price: yResult.meta?.regularMarketPrice,
        prevClose: yResult.meta?.chartPreviousClose,
        high52: yResult.meta?.fiftyTwoWeekHigh,
        low52: yResult.meta?.fiftyTwoWeekLow,
      },
      bars,
      source: 'yahoo',
    };
    cache.set(key, result, TTL.BARS_DAILY);
    return result;
  });
}

/**
 * Get price change over a range (used by sector_relative)
 * Returns: { symbol, price, dayChange, weekChange }
 */
async function getPriceChange(symbol, range = '5d') {
  const key = `pricechange:${symbol}:${range}`;
  return deduped(key, async () => {
    // Use historical bars
    const hist = await getHistoricalBars(symbol, range === '1mo' ? '1mo' : '5d');
    if (!hist || hist.bars.length === 0) return null;

    const closes = hist.bars.map(b => b.close).filter(c => c !== null);
    const price = closes[closes.length - 1];
    const startPrice = closes[0];
    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : startPrice;

    const result = {
      symbol,
      price,
      dayChange: prevClose ? ((price - prevClose) / prevClose * 100) : 0,
      weekChange: startPrice ? ((price - startPrice) / startPrice * 100) : 0,
      source: hist.source,
    };
    cache.set(key, result, TTL.QUOTE);
    return result;
  });
}

/**
 * Get options chain (Yahoo Finance — Alpaca options data may need paid tier)
 * Returns: { symbol, stockPrice, calls, puts, expirationDate, expirations }
 */
async function getOptionsChain(symbol) {
  const key = `options:${symbol}`;
  return deduped(key, async () => {
    const yahoo = await yahooFetch(
      `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`
    );

    if (!yahoo?.optionChain?.result?.[0]) return null;

    const yResult = yahoo.optionChain.result[0];
    const quote = yResult.quote || {};
    const options = yResult.options?.[0] || {};

    const mapOption = (o) => ({
      strike: o.strike,
      expiry: new Date((options.expirationDate || 0) * 1000).toISOString().split('T')[0],
      lastPrice: o.lastPrice,
      bid: o.bid,
      ask: o.ask,
      volume: o.volume || 0,
      openInterest: o.openInterest || 0,
      impliedVol: o.impliedVolatility,
      inTheMoney: o.inTheMoney,
      volumeToOI: o.openInterest > 0 ? parseFloat((o.volume / o.openInterest).toFixed(2)) : 0,
    });

    const result = {
      symbol,
      stockPrice: quote.regularMarketPrice,
      calls: (options.calls || []).map(mapOption),
      puts: (options.puts || []).map(mapOption),
      expirationDate: new Date((options.expirationDate || 0) * 1000).toISOString().split('T')[0],
      expirations: (yResult.expirationDates || []).slice(0, 6).map(
        ts => new Date(ts * 1000).toISOString().split('T')[0]
      ),
      source: 'yahoo',
    };
    cache.set(key, result, TTL.OPTIONS_CHAIN);
    return result;
  });
}

// ============================================================================
// Utility
// ============================================================================

function _daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

/**
 * Get cache stats (for monitoring)
 */
function getCacheStats() {
  return {
    entries: cache.size,
    inflightRequests: inflight.size,
    hasAlpacaCreds: !!getAlpacaCredentials(),
  };
}

/**
 * Clear all cached data
 */
function clearCache() {
  cache.clear();
}

module.exports = {
  // Core data methods
  getQuote,
  getSnapshot,
  getSnapshots,
  getHistoricalBars,
  getPriceChange,
  getOptionsChain,

  // Low-level HTTP (for modules that need custom endpoints like Finnhub, FRED)
  fetchJSON: genericFetch,
  fetchHTML: yahooFetchHTML,
  alpacaFetch,

  // Cache management
  getCacheStats,
  clearCache,
  cache,

  // TTL constants (for custom caching)
  TTL,
};
