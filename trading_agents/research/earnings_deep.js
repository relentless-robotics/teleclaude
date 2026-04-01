/**
 * Deep Earnings Research Module
 * Sources: Finnhub (free key), Alpha Vantage via data_layer HTTP pool
 */

const dataLayer = require('./data_layer');
const fetchJSON = dataLayer.fetchJSON;

/**
 * Get upcoming earnings for next N days with estimates
 */
async function getUpcomingEarnings(days = 7) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];

  const data = await fetchJSON(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${finnhubKey}`);
  if (!data?.earningsCalendar) return { earnings: [], count: 0 };

  // Group by date and enrich
  const earnings = data.earningsCalendar
    .filter(e => e.symbol && e.symbol.length <= 5)
    .map(e => ({
      symbol: e.symbol,
      date: e.date,
      hour: e.hour === 'bmo' ? 'Before Open' : e.hour === 'amc' ? 'After Close' : e.hour,
      epsEstimate: e.epsEstimate,
      epsActual: e.epsActual,
      revenueEstimate: e.revenueEstimate,
      revenueActual: e.revenueActual,
      quarter: e.quarter,
      year: e.year,
    }))
    .slice(0, 50);

  return { earnings, count: earnings.length };
}

/**
 * Get earnings surprises (recent beats/misses) from Finnhub
 */
async function getRecentEarningsSurprises() {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];

  const data = await fetchJSON(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${finnhubKey}`);
  if (!data?.earningsCalendar) return { surprises: [], count: 0 };

  const surprises = data.earningsCalendar
    .filter(e => e.epsActual !== null && e.epsEstimate !== null)
    .map(e => {
      const surprise = e.epsEstimate !== 0 ? ((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate) * 100) : 0;
      return {
        symbol: e.symbol,
        date: e.date,
        epsEstimate: e.epsEstimate,
        epsActual: e.epsActual,
        surprisePct: surprise.toFixed(1) + '%',
        beat: e.epsActual > e.epsEstimate,
      };
    })
    .sort((a, b) => Math.abs(parseFloat(b.surprisePct)) - Math.abs(parseFloat(a.surprisePct)))
    .slice(0, 20);

  return { surprises, count: surprises.length };
}

/**
 * Get analyst recommendations for a symbol
 */
async function getAnalystRecommendations(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const data = await fetchJSON(`https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${finnhubKey}`);
  if (!data || !Array.isArray(data)) return null;

  const latest = data[0];
  if (!latest) return null;

  return {
    symbol,
    period: latest.period,
    strongBuy: latest.strongBuy,
    buy: latest.buy,
    hold: latest.hold,
    sell: latest.sell,
    strongSell: latest.strongSell,
    consensus: latest.strongBuy + latest.buy > latest.sell + latest.strongSell ? 'BUY' :
               latest.sell + latest.strongSell > latest.strongBuy + latest.buy ? 'SELL' : 'HOLD',
  };
}

/**
 * Get price targets for a symbol
 */
async function getPriceTarget(symbol) {
  const finnhubKey = process.env.FINNHUB_API_KEY || 'ctdlu4hr01qhb0b1gmv0ctdlu4hr01qhb0b1gmvg';
  const data = await fetchJSON(`https://finnhub.io/api/v1/stock/price-target?symbol=${symbol}&token=${finnhubKey}`);
  if (!data) return null;

  return {
    symbol,
    high: data.targetHigh,
    low: data.targetLow,
    mean: data.targetMean,
    median: data.targetMedian,
    numAnalysts: data.lastUpdated ? 'recent' : 'unknown',
  };
}

async function run() {
  const [upcoming, surprises] = await Promise.all([
    getUpcomingEarnings(7),
    getRecentEarningsSurprises(),
  ]);
  return { upcoming, surprises };
}

module.exports = { run, getUpcomingEarnings, getRecentEarningsSurprises, getAnalystRecommendations, getPriceTarget };
