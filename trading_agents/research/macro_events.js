/**
 * Macro / Economic Events Research Module
 * Sources: FRED (free key), sector ETF analysis via data_layer
 */

const dataLayer = require('./data_layer');
const fetchJSON = dataLayer.fetchJSON;

/**
 * Get key macro indicators from FRED (Federal Reserve)
 * VIX, 10Y yield, DXY proxy, unemployment claims
 */
async function getMacroIndicators() {
  const fredKey = process.env.FRED_API_KEY || 'demo';

  // Warn if using demo key
  if (fredKey === 'demo') {
    console.warn('⚠️ WARNING: FRED using demo API key - data may be unreliable');
  }

  const series = {
    'VIXCLS': 'VIX',
    'DGS10': '10Y_Yield',
    'DTWEXBGS': 'Dollar_Index',
    'ICSA': 'Weekly_Claims',
    'T10Y2Y': 'Yield_Curve',
  };

  const results = {};
  const fetches = Object.entries(series).map(async ([id, name]) => {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=5`;
    const data = await fetchJSON(url);
    if (data?.observations?.length > 0) {
      const latest = data.observations.find(o => o.value !== '.');
      const prev = data.observations.find((o, i) => i > 0 && o.value !== '.');
      if (latest) {
        results[name] = {
          value: parseFloat(latest.value),
          date: latest.date,
          prevValue: prev ? parseFloat(prev.value) : null,
          change: prev ? (parseFloat(latest.value) - parseFloat(prev.value)).toFixed(3) : null,
        };
      }
    }
  });

  await Promise.all(fetches);
  return results;
}

/**
 * Sector rotation analysis via ETF performance
 * Compares sector ETFs to identify money flow
 */
async function getSectorRotation() {
  const sectorETFs = {
    XLK: 'Technology', XLF: 'Financials', XLE: 'Energy',
    XLV: 'Healthcare', XLI: 'Industrials', XLY: 'Consumer Disc',
    XLP: 'Consumer Staples', XLU: 'Utilities', XLB: 'Materials',
    XLRE: 'Real Estate', XLC: 'Communications',
    SMH: 'Semiconductors', XBI: 'Biotech', IWM: 'Small Caps',
    GLD: 'Gold', TLT: 'Bonds 20Y',
  };

  const results = [];
  const fetches = Object.entries(sectorETFs).map(async ([symbol, sector]) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (result?.meta?.regularMarketPrice) {
      const prices = result.indicators?.quote?.[0]?.close || [];
      const validPrices = prices.filter(p => p !== null);
      const currentPrice = result.meta.regularMarketPrice;
      const prevClose = result.meta.chartPreviousClose || validPrices[validPrices.length - 2];
      const weekAgo = validPrices[0];

      results.push({
        symbol,
        sector,
        price: currentPrice,
        dayChange: prevClose ? ((currentPrice - prevClose) / prevClose * 100).toFixed(2) + '%' : 'N/A',
        weekChange: weekAgo ? ((currentPrice - weekAgo) / weekAgo * 100).toFixed(2) + '%' : 'N/A',
        dayChangePct: prevClose ? (currentPrice - prevClose) / prevClose * 100 : 0,
        weekChangePct: weekAgo ? (currentPrice - weekAgo) / weekAgo * 100 : 0,
      });
    }
  });

  await Promise.all(fetches);

  // Sort by week change to identify rotation
  results.sort((a, b) => b.weekChangePct - a.weekChangePct);

  const leaders = results.slice(0, 5);
  const laggards = results.slice(-5).reverse();

  // Detect risk-on vs risk-off
  const riskOnSectors = ['XLK', 'XLY', 'SMH', 'IWM', 'XBI'];
  const riskOffSectors = ['XLU', 'XLP', 'GLD', 'TLT'];
  const riskOnAvg = results.filter(r => riskOnSectors.includes(r.symbol)).reduce((s, r) => s + r.weekChangePct, 0) / riskOnSectors.length;
  const riskOffAvg = results.filter(r => riskOffSectors.includes(r.symbol)).reduce((s, r) => s + r.weekChangePct, 0) / riskOffSectors.length;

  return {
    sectors: results,
    leaders,
    laggards,
    regime: riskOnAvg > riskOffAvg + 1 ? 'RISK_ON' : riskOffAvg > riskOnAvg + 1 ? 'RISK_OFF' : 'NEUTRAL',
    riskOnAvg: riskOnAvg.toFixed(2) + '%',
    riskOffAvg: riskOffAvg.toFixed(2) + '%',
  };
}

/**
 * Get market breadth indicators
 * Advance/decline, new highs/lows from Yahoo
 */
async function getMarketBreadth() {
  // Use market breadth ETFs as proxies
  const breadthSymbols = {
    'RSP': 'Equal Weight S&P 500',  // RSP vs SPY = breadth
    'SPY': 'S&P 500',
    'IWM': 'Russell 2000',
    'DIA': 'Dow 30',
    'QQQ': 'Nasdaq 100',
  };

  const prices = {};
  const fetches = Object.entries(breadthSymbols).map(async ([symbol, name]) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (result?.meta?.regularMarketPrice) {
      const closes = result.indicators?.quote?.[0]?.close?.filter(p => p !== null) || [];
      prices[symbol] = {
        name,
        current: result.meta.regularMarketPrice,
        prevClose: result.meta.chartPreviousClose,
        monthAgo: closes[0],
        dayChange: result.meta.chartPreviousClose ?
          ((result.meta.regularMarketPrice - result.meta.chartPreviousClose) / result.meta.chartPreviousClose * 100).toFixed(2) : 0,
        monthChange: closes[0] ?
          ((result.meta.regularMarketPrice - closes[0]) / closes[0] * 100).toFixed(2) : 0,
      };
    }
  });

  await Promise.all(fetches);

  // Breadth divergence: RSP vs SPY
  const breadthDivergence = (prices.RSP && prices.SPY) ?
    (parseFloat(prices.RSP.monthChange) - parseFloat(prices.SPY.monthChange)).toFixed(2) : null;

  return {
    indices: prices,
    breadthDivergence,
    breadthSignal: breadthDivergence > 1 ? 'BROADENING' :
                   breadthDivergence < -1 ? 'NARROWING' : 'NEUTRAL',
    smallCapStrength: (prices.IWM && prices.SPY) ?
      (parseFloat(prices.IWM.monthChange) - parseFloat(prices.SPY.monthChange)).toFixed(2) : null,
  };
}

async function run() {
  const [macro, sectors, breadth] = await Promise.all([
    getMacroIndicators(),
    getSectorRotation(),
    getMarketBreadth(),
  ]);
  return { macro, sectors, breadth };
}

module.exports = { run, getMacroIndicators, getSectorRotation, getMarketBreadth };
