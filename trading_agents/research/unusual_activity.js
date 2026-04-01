/**
 * Unusual Volume & Options Activity Scanner
 * Sources: Finviz, Alpha Vantage via data_layer HTTP pool
 */

const dataLayer = require('./data_layer');
const fetchJSON = dataLayer.fetchJSON;
const fetchHTML = dataLayer.fetchHTML;

/**
 * Get top gainers, losers, and most active from Alpha Vantage
 */
async function getMarketMovers() {
  const apiKey = process.env.ALPHA_VANTAGE_KEY || 'demo';

  // Warn if using demo key
  if (apiKey === 'demo') {
    console.warn('⚠️ WARNING: Alpha Vantage using demo API key - data may be unreliable');
  }

  const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${apiKey}`;
  const data = await fetchJSON(url);
  if (!data) return { gainers: [], losers: [], mostActive: [] };

  return {
    gainers: (data.top_gainers || []).slice(0, 10).map(s => ({
      ticker: s.ticker,
      price: s.price,
      changePct: s.change_percentage,
      volume: s.change_amount,
    })),
    losers: (data.top_losers || []).slice(0, 10).map(s => ({
      ticker: s.ticker,
      price: s.price,
      changePct: s.change_percentage,
      volume: s.change_amount,
    })),
    mostActive: (data.most_actively_traded || []).slice(0, 10).map(s => ({
      ticker: s.ticker,
      price: s.price,
      changePct: s.change_percentage,
      volume: s.volume,
    })),
  };
}

/**
 * Scan Finviz for unusual volume (volume > 2x average)
 */
async function getUnusualVolume() {
  const url = 'https://finviz.com/screener.ashx?v=111&f=sh_relvol_o2&ft=4&o=-volume&r=1';
  const html = await fetchHTML(url);

  const stocks = [];
  // Parse Finviz screener table
  const rowRegex = /class="screener-link-primary"[^>]*>([A-Z]+)<\/a>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null && stocks.length < 15) {
    stocks.push(match[1]);
  }

  return { source: 'Finviz', unusualVolume: stocks, count: stocks.length };
}

/**
 * Get stocks with high options volume from Finviz
 */
async function getHighOptionsVolume() {
  const url = 'https://finviz.com/screener.ashx?v=111&f=sh_opt_option&ft=4&o=-optionvolume&r=1';
  const html = await fetchHTML(url);

  const stocks = [];
  const rowRegex = /class="screener-link-primary"[^>]*>([A-Z]+)<\/a>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null && stocks.length < 15) {
    stocks.push(match[1]);
  }

  return { source: 'Finviz', highOptionsVol: stocks, count: stocks.length };
}

/**
 * Get stocks making new 52-week highs with volume confirmation
 */
async function getBreakouts() {
  const url = 'https://finviz.com/screener.ashx?v=111&f=sh_relvol_o1.5,ta_highlow52w_nh&ft=4&o=-volume';
  const html = await fetchHTML(url);

  const stocks = [];
  const rowRegex = /class="screener-link-primary"[^>]*>([A-Z]+)<\/a>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null && stocks.length < 15) {
    stocks.push(match[1]);
  }

  return { source: 'Finviz', breakouts: stocks, count: stocks.length };
}

/**
 * Short squeeze candidates: high short interest + price rising
 */
async function getShortSqueezeCandidates() {
  const url = 'https://finviz.com/screener.ashx?v=111&f=sh_short_o15,ta_perf_1wup&ft=4&o=-shortinterest';
  const html = await fetchHTML(url);

  const stocks = [];
  const rowRegex = /class="screener-link-primary"[^>]*>([A-Z]+)<\/a>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null && stocks.length < 15) {
    stocks.push(match[1]);
  }

  return { source: 'Finviz', squeezeCandidates: stocks, count: stocks.length };
}

async function run() {
  const [movers, unusualVol, optionsVol, breakouts, squeeze] = await Promise.all([
    getMarketMovers(),
    getUnusualVolume(),
    getHighOptionsVolume(),
    getBreakouts(),
    getShortSqueezeCandidates(),
  ]);
  return { movers, unusualVol, optionsVol, breakouts, squeeze };
}

module.exports = { run, getMarketMovers, getUnusualVolume, getHighOptionsVolume, getBreakouts, getShortSqueezeCandidates };
