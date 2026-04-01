/**
 * Earnings Estimate Revision Tracker
 * Tracks whether analyst estimates are being revised UP or DOWN.
 * Estimate revisions are one of the strongest predictive signals in quant finance.
 *
 * Sources: Finnhub (free key) via data_layer HTTP pool
 */

const dataLayer = require('./data_layer');
const fetchJSON = dataLayer.fetchJSON;

/**
 * Get EPS estimate trends from Finnhub
 * Shows how estimates have changed over time (quarterly)
 */
async function getEstimateTrends(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const url = `https://finnhub.io/api/v1/stock/eps-estimate?symbol=${symbol}&token=${finnhubKey}`;
  const data = await fetchJSON(url);

  if (!data?.data || data.data.length === 0) return null;

  // Get upcoming quarters
  const now = new Date();
  const upcoming = data.data
    .filter(d => new Date(d.period) >= now)
    .sort((a, b) => new Date(a.period) - new Date(b.period))
    .slice(0, 2);

  // Get recent past quarters for comparison
  const recent = data.data
    .filter(d => new Date(d.period) < now)
    .sort((a, b) => new Date(b.period) - new Date(a.period))
    .slice(0, 2);

  return {
    symbol,
    upcoming: upcoming.map(d => ({
      period: d.period,
      epsAvg: d.epsAvg,
      epsHigh: d.epsHigh,
      epsLow: d.epsLow,
      numberAnalysts: d.numberAnalysts,
    })),
    recent: recent.map(d => ({
      period: d.period,
      epsAvg: d.epsAvg,
      epsActual: d.epsActual,
      surprise: d.epsActual && d.epsAvg ? ((d.epsActual - d.epsAvg) / Math.abs(d.epsAvg) * 100).toFixed(1) + '%' : null,
    })),
  };
}

/**
 * Get revenue estimate trends from Finnhub
 */
async function getRevenueEstimates(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const url = `https://finnhub.io/api/v1/stock/revenue-estimate?symbol=${symbol}&token=${finnhubKey}`;
  const data = await fetchJSON(url);

  if (!data?.data || data.data.length === 0) return null;

  const now = new Date();
  const upcoming = data.data
    .filter(d => new Date(d.period) >= now)
    .sort((a, b) => new Date(a.period) - new Date(b.period))
    .slice(0, 2);

  return upcoming.map(d => ({
    period: d.period,
    revenueAvg: d.revenueAvg,
    revenueHigh: d.revenueHigh,
    revenueLow: d.revenueLow,
    numberAnalysts: d.numberAnalysts,
  }));
}

/**
 * Get recommendation trends (upgrade/downgrade history)
 */
async function getRecommendationTrend(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${finnhubKey}`;
  const data = await fetchJSON(url);

  if (!data || !Array.isArray(data) || data.length < 2) return null;

  // Compare current month to previous months
  const current = data[0];
  const prev1 = data[1];
  const prev3 = data.length >= 4 ? data[3] : null;

  const totalCurrent = (current.strongBuy || 0) + (current.buy || 0) + (current.hold || 0) + (current.sell || 0) + (current.strongSell || 0);
  const totalPrev = (prev1.strongBuy || 0) + (prev1.buy || 0) + (prev1.hold || 0) + (prev1.sell || 0) + (prev1.strongSell || 0);

  const buyPctCurrent = totalCurrent > 0 ? ((current.strongBuy + current.buy) / totalCurrent * 100) : 0;
  const buyPctPrev = totalPrev > 0 ? ((prev1.strongBuy + prev1.buy) / totalPrev * 100) : 0;

  let revisionDirection = 'STABLE';
  if (buyPctCurrent > buyPctPrev + 5) revisionDirection = 'UPGRADING';
  else if (buyPctCurrent < buyPctPrev - 5) revisionDirection = 'DOWNGRADING';

  return {
    symbol,
    current: {
      period: current.period,
      strongBuy: current.strongBuy,
      buy: current.buy,
      hold: current.hold,
      sell: current.sell,
      strongSell: current.strongSell,
      buyPct: Math.round(buyPctCurrent),
    },
    previous: {
      period: prev1.period,
      buyPct: Math.round(buyPctPrev),
    },
    threeMonthsAgo: prev3 ? {
      period: prev3.period,
      buyPct: Math.round(((prev3.strongBuy + prev3.buy) / ((prev3.strongBuy || 0) + (prev3.buy || 0) + (prev3.hold || 0) + (prev3.sell || 0) + (prev3.strongSell || 0) || 1)) * 100),
    } : null,
    revisionDirection,
    consensus: buyPctCurrent > 60 ? 'BUY' : buyPctCurrent < 40 ? 'SELL' : 'HOLD',
  };
}

/**
 * Get earnings surprise history (does this stock typically beat?)
 */
async function getEarningsSurpriseHistory(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${finnhubKey}`;
  const data = await fetchJSON(url);

  if (!data || !Array.isArray(data) || data.length === 0) return null;

  const history = data.slice(0, 8).map(q => ({
    period: q.period,
    actual: q.actual,
    estimate: q.estimate,
    surprise: q.surprise,
    surprisePct: q.surprisePercent,
    beat: q.actual > q.estimate,
  }));

  const beats = history.filter(h => h.beat).length;
  const total = history.filter(h => h.actual !== null && h.estimate !== null).length;

  return {
    symbol,
    history,
    beatRate: total > 0 ? Math.round(beats / total * 100) + '%' : 'N/A',
    beatsInRow: _countStreak(history.map(h => h.beat)),
    avgSurprise: total > 0 ?
      (history.filter(h => h.surprisePct !== null).reduce((s, h) => s + (h.surprisePct || 0), 0) / total).toFixed(1) + '%' : 'N/A',
  };
}

function _countStreak(boolArray) {
  if (boolArray.length === 0) return 0;
  let count = 0;
  const first = boolArray[0];
  for (const val of boolArray) {
    if (val === first) count++;
    else break;
  }
  return { type: first ? 'beats' : 'misses', count };
}

/**
 * Full earnings revision analysis for a symbol
 */
async function analyzeSymbol(symbol) {
  const [estimates, revenue, recTrend, surpriseHistory] = await Promise.all([
    getEstimateTrends(symbol),
    getRevenueEstimates(symbol),
    getRecommendationTrend(symbol),
    getEarningsSurpriseHistory(symbol),
  ]);

  // Determine overall revision direction
  let overallRevision = 'NEUTRAL';
  const signals = [];

  if (recTrend?.revisionDirection === 'UPGRADING') {
    signals.push('Analysts upgrading');
    overallRevision = 'POSITIVE';
  } else if (recTrend?.revisionDirection === 'DOWNGRADING') {
    signals.push('Analysts downgrading');
    overallRevision = 'NEGATIVE';
  }

  if (surpriseHistory?.beatsInRow?.type === 'beats' && surpriseHistory.beatsInRow.count >= 3) {
    signals.push(`${surpriseHistory.beatsInRow.count}Q beat streak`);
    if (overallRevision === 'NEUTRAL') overallRevision = 'POSITIVE';
  }

  return {
    symbol,
    estimates,
    revenue,
    recommendationTrend: recTrend,
    surpriseHistory,
    overallRevision,
    signals,
  };
}

/**
 * Batch analyze multiple symbols
 */
async function analyzeMultiple(symbols) {
  const results = {};

  // Finnhub free tier: 60 calls/min. Each symbol = 4 calls. Max ~15 symbols/min.
  for (let i = 0; i < symbols.length; i++) {
    try {
      results[symbols[i]] = await analyzeSymbol(symbols[i]);
    } catch (e) {
      console.error(`[EarningsRevisions] ${symbols[i]} failed:`, e.message);
    }
    // Rate limit: small pause between symbols (4 API calls each)
    if (i < symbols.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return results;
}

async function run(symbols = []) {
  if (symbols.length === 0) return {};
  return analyzeMultiple(symbols);
}

module.exports = {
  run,
  analyzeSymbol,
  analyzeMultiple,
  getEstimateTrends,
  getRevenueEstimates,
  getRecommendationTrend,
  getEarningsSurpriseHistory,
};
