/**
 * Sector-Relative Strength Module
 * Maps each symbol to its sector ETF and calculates relative performance.
 * A stock up 2% in a sector down 3% is very different from one up 2% in a sector up 5%.
 *
 * Sources: Alpaca (primary) via data_layer, Yahoo Finance (fallback)
 */

const dataLayer = require('./data_layer');

// Sector ETF mapping by GICS sector
const SECTOR_ETFS = {
  'Technology': 'XLK',
  'Healthcare': 'XLV',
  'Financials': 'XLF',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  'Industrials': 'XLI',
  'Energy': 'XLE',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Basic Materials': 'XLB',
  'Communication Services': 'XLC',
};

// Common stock -> sector mapping (for stocks where Yahoo doesn't return sector)
const KNOWN_SECTORS = {
  AAPL: 'Technology', MSFT: 'Technology', GOOGL: 'Technology', GOOG: 'Technology',
  META: 'Technology', NVDA: 'Technology', AMD: 'Technology', INTC: 'Technology',
  AMZN: 'Consumer Cyclical', TSLA: 'Consumer Cyclical',
  JPM: 'Financials', BAC: 'Financials', GS: 'Financials', MS: 'Financials',
  JNJ: 'Healthcare', UNH: 'Healthcare', PFE: 'Healthcare', ABBV: 'Healthcare',
  XOM: 'Energy', CVX: 'Energy', OXY: 'Energy', COP: 'Energy',
  DIS: 'Communication Services', NFLX: 'Communication Services', RDDT: 'Communication Services',
  SNAP: 'Communication Services', PINS: 'Communication Services',
  WMT: 'Consumer Defensive', PG: 'Consumer Defensive', KO: 'Consumer Defensive',
  BA: 'Industrials', CAT: 'Industrials', GE: 'Industrials',
  NEE: 'Utilities', DUK: 'Utilities', SO: 'Utilities',
  SMCI: 'Technology', PLTR: 'Technology', CRWD: 'Technology',
  SPY: null, QQQ: null, IWM: null, DIA: null, // Index ETFs - no sector
};

/**
 * Get sector for a symbol from Yahoo Finance profile
 */
async function getSector(symbol) {
  // Check known mapping first
  if (KNOWN_SECTORS[symbol] !== undefined) return KNOWN_SECTORS[symbol];

  // Try Yahoo Finance profile (no Alpaca equivalent for sector data)
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=assetProfile`;
  const data = await dataLayer.fetchJSON(url);
  const sector = data?.quoteSummary?.result?.[0]?.assetProfile?.sector;

  if (sector) {
    KNOWN_SECTORS[symbol] = sector; // Cache it
    return sector;
  }

  return null;
}

/**
 * Get price change for a symbol over a given range (via data layer)
 */
async function getPriceChange(symbol, range = '5d') {
  return dataLayer.getPriceChange(symbol, range);
}

/**
 * Calculate relative strength for a symbol vs its sector ETF
 */
async function getRelativeStrength(symbol) {
  const sector = await getSector(symbol);
  if (!sector) return { symbol, sector: null, relative: null, note: 'Sector not found' };

  const sectorETF = SECTOR_ETFS[sector];
  if (!sectorETF) return { symbol, sector, relative: null, note: 'No sector ETF mapped' };

  // Fetch both in parallel
  const [stockData, etfData] = await Promise.all([
    getPriceChange(symbol, '1mo'),
    getPriceChange(sectorETF, '1mo'),
  ]);

  if (!stockData || !etfData) return { symbol, sector, sectorETF, relative: null };

  const relDay = stockData.dayChange - etfData.dayChange;
  const relWeek = stockData.weekChange - etfData.weekChange;

  let strength = 'INLINE';
  if (relWeek > 5) strength = 'STRONG_OUTPERFORMER';
  else if (relWeek > 2) strength = 'OUTPERFORMER';
  else if (relWeek < -5) strength = 'STRONG_UNDERPERFORMER';
  else if (relWeek < -2) strength = 'UNDERPERFORMER';

  return {
    symbol,
    sector,
    sectorETF,
    stockPrice: stockData.price,
    stockDayChange: parseFloat(stockData.dayChange.toFixed(2)),
    stockWeekChange: parseFloat(stockData.weekChange.toFixed(2)),
    sectorDayChange: parseFloat(etfData.dayChange.toFixed(2)),
    sectorWeekChange: parseFloat(etfData.weekChange.toFixed(2)),
    relativeDayStrength: parseFloat(relDay.toFixed(2)),
    relativeWeekStrength: parseFloat(relWeek.toFixed(2)),
    strength,
    interpretation: strength.includes('OUTPERFORMER') ?
      `${symbol} outperforming ${sector} sector by ${relWeek.toFixed(1)}% this week — showing leadership` :
      strength.includes('UNDERPERFORMER') ?
      `${symbol} underperforming ${sector} sector by ${Math.abs(relWeek).toFixed(1)}% this week — relative weakness` :
      `${symbol} performing in line with ${sector} sector`,
  };
}

/**
 * Batch analyze relative strength for multiple symbols
 */
async function analyzeMultiple(symbols) {
  const results = {};

  // Prefetch all sector ETF data (one call each, cached)
  const etfCache = {};
  const uniqueSectors = [...new Set(
    symbols.map(s => KNOWN_SECTORS[s]).filter(Boolean).map(s => SECTOR_ETFS[s]).filter(Boolean)
  )];

  await Promise.all(uniqueSectors.map(async (etf) => {
    etfCache[etf] = await getPriceChange(etf, '1mo');
  }));

  // Now analyze each symbol
  for (const symbol of symbols) {
    try {
      const sector = await getSector(symbol);
      if (!sector) { results[symbol] = { symbol, sector: null }; continue; }

      const sectorETF = SECTOR_ETFS[sector];
      if (!sectorETF) { results[symbol] = { symbol, sector }; continue; }

      const stockData = await getPriceChange(symbol, '1mo');
      const etfData = etfCache[sectorETF] || await getPriceChange(sectorETF, '1mo');

      if (!stockData || !etfData) { results[symbol] = { symbol, sector, sectorETF }; continue; }

      const relDay = stockData.dayChange - etfData.dayChange;
      const relWeek = stockData.weekChange - etfData.weekChange;

      let strength = 'INLINE';
      if (relWeek > 5) strength = 'STRONG_OUTPERFORMER';
      else if (relWeek > 2) strength = 'OUTPERFORMER';
      else if (relWeek < -5) strength = 'STRONG_UNDERPERFORMER';
      else if (relWeek < -2) strength = 'UNDERPERFORMER';

      results[symbol] = {
        symbol,
        sector,
        sectorETF,
        stockDayChange: parseFloat(stockData.dayChange.toFixed(2)),
        stockWeekChange: parseFloat(stockData.weekChange.toFixed(2)),
        sectorDayChange: parseFloat(etfData.dayChange.toFixed(2)),
        sectorWeekChange: parseFloat(etfData.weekChange.toFixed(2)),
        relativeDayStrength: parseFloat(relDay.toFixed(2)),
        relativeWeekStrength: parseFloat(relWeek.toFixed(2)),
        strength,
      };
    } catch (e) {
      console.error(`[SectorRelative] ${symbol}:`, e.message);
    }
  }

  return results;
}

async function run(symbols = []) {
  if (symbols.length === 0) return {};
  return analyzeMultiple(symbols);
}

module.exports = { run, getRelativeStrength, analyzeMultiple, getSector };
