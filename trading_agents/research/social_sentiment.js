/**
 * Deep Social Sentiment Scanner
 * Sources: StockTwits API (free), Reddit/ApeWisdom (free), Finviz news via data_layer HTTP pool
 */

const dataLayer = require('./data_layer');
const fetchJSON = dataLayer.fetchJSON;
const fetchHTML = dataLayer.fetchHTML;

/**
 * StockTwits trending tickers with sentiment breakdown
 */
async function getStockTwitsTrending() {
  const data = await fetchJSON('https://api.stocktwits.com/api/2/trending/symbols.json');
  if (!data?.symbols) return { trending: [], count: 0 };

  const trending = data.symbols.slice(0, 20).map(s => ({
    symbol: s.symbol,
    title: s.title,
    watchlistCount: s.watchlist_count,
  }));

  // Get sentiment for top tickers
  const withSentiment = await Promise.all(
    trending.slice(0, 10).map(async (t) => {
      const stream = await fetchJSON(`https://api.stocktwits.com/api/2/streams/symbol/${t.symbol}.json`);
      if (!stream?.messages) return { ...t, sentiment: 'N/A', bullish: 0, bearish: 0 };

      let bullish = 0, bearish = 0;
      for (const msg of stream.messages.slice(0, 30)) {
        if (msg.entities?.sentiment?.basic === 'Bullish') bullish++;
        if (msg.entities?.sentiment?.basic === 'Bearish') bearish++;
      }
      const total = bullish + bearish;
      return {
        ...t,
        sentiment: total > 0 ? (bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'MIXED') : 'N/A',
        bullishPct: total > 0 ? Math.round(bullish / total * 100) : 0,
        bearishPct: total > 0 ? Math.round(bearish / total * 100) : 0,
        messageCount: stream.messages.length,
      };
    })
  );

  return { trending: withSentiment, count: withSentiment.length };
}

/**
 * Reddit/WallStreetBets trending via ApeWisdom
 */
async function getRedditTrending() {
  const pages = ['wallstreetbets', 'stocks', 'options'];
  const allTickers = {};

  const fetches = pages.map(async (sub) => {
    const data = await fetchJSON(`https://apewisdom.io/api/v1.0/filter/${sub}`);
    if (!data?.results) return;

    for (const item of data.results.slice(0, 15)) {
      const sym = item.ticker;
      if (!allTickers[sym]) {
        allTickers[sym] = {
          symbol: sym,
          name: item.name,
          mentions: 0,
          rank: 999,
          upvotes: 0,
          sources: [],
        };
      }
      allTickers[sym].mentions += item.mentions || 0;
      allTickers[sym].upvotes += item.upvotes || 0;
      allTickers[sym].sources.push(sub);
      allTickers[sym].rank = Math.min(allTickers[sym].rank, item.rank || 999);
      if (item.mentions_24h_ago !== undefined) {
        allTickers[sym].mentionChange = item.mentions - (item.mentions_24h_ago || 0);
      }
    }
  });

  await Promise.all(fetches);

  const sorted = Object.values(allTickers)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 20);

  return {
    source: 'Reddit (WSB + stocks + options)',
    trending: sorted,
    count: sorted.length,
  };
}

/**
 * Get sentiment for a specific symbol from StockTwits
 */
async function getSymbolSentiment(symbol) {
  const data = await fetchJSON(`https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`);
  if (!data?.messages) return null;

  let bullish = 0, bearish = 0;
  const recentMessages = [];

  for (const msg of data.messages.slice(0, 30)) {
    if (msg.entities?.sentiment?.basic === 'Bullish') bullish++;
    if (msg.entities?.sentiment?.basic === 'Bearish') bearish++;
    if (recentMessages.length < 5) {
      recentMessages.push({
        body: msg.body?.substring(0, 150),
        sentiment: msg.entities?.sentiment?.basic || 'N/A',
        time: msg.created_at,
        likes: msg.likes?.total || 0,
      });
    }
  }

  const total = bullish + bearish;
  return {
    symbol,
    bullish,
    bearish,
    total,
    sentiment: total > 0 ? (bullish > bearish ? 'BULLISH' : 'BEARISH') : 'NEUTRAL',
    bullishPct: total > 0 ? Math.round(bullish / total * 100) : 0,
    topMessages: recentMessages,
  };
}

/**
 * Finviz news headlines scanner - find symbols with breaking news
 */
async function getFinvizNews() {
  const url = 'https://finviz.com/news.ashx';
  const html = await fetchHTML(url);

  const headlines = [];
  // Parse news table for ticker mentions
  const linkRegex = /<a[^>]*class="tab-link-news"[^>]*>(.*?)<\/a>/g;
  let match;
  while ((match = linkRegex.exec(html)) !== null && headlines.length < 30) {
    const headline = match[1].replace(/<[^>]*>/g, '').trim();
    if (headline.length > 10) {
      // Extract tickers mentioned in headline
      const tickers = headline.match(/\b[A-Z]{2,5}\b/g)?.filter(t =>
        !['THE', 'FOR', 'AND', 'BUT', 'NOT', 'ARE', 'WAS', 'HAS', 'NEW', 'CEO', 'IPO', 'ETF', 'SEC', 'FDA', 'GDP', 'CPI', 'FED', 'NYSE', 'USA'].includes(t)
      ) || [];
      headlines.push({ headline, possibleTickers: tickers });
    }
  }

  return { source: 'Finviz', headlines, count: headlines.length };
}

/**
 * Cross-source sentiment aggregation
 * Finds symbols trending on MULTIPLE platforms (stronger signal)
 */
async function getCrossPlatformHeatMap() {
  const [stocktwits, reddit] = await Promise.all([
    getStockTwitsTrending(),
    getRedditTrending(),
  ]);

  const symbolMap = {};

  // Add StockTwits data
  for (const item of stocktwits.trending) {
    symbolMap[item.symbol] = {
      symbol: item.symbol,
      platforms: ['StockTwits'],
      stocktwitsSentiment: item.sentiment,
      stocktwitsBullish: item.bullishPct,
      redditMentions: 0,
      score: 1,
    };
  }

  // Add Reddit data
  for (const item of reddit.trending) {
    if (symbolMap[item.symbol]) {
      symbolMap[item.symbol].platforms.push('Reddit');
      symbolMap[item.symbol].redditMentions = item.mentions;
      symbolMap[item.symbol].redditSources = item.sources;
      symbolMap[item.symbol].score += 2; // Multi-platform = stronger signal
    } else {
      symbolMap[item.symbol] = {
        symbol: item.symbol,
        platforms: ['Reddit'],
        stocktwitsSentiment: null,
        redditMentions: item.mentions,
        redditSources: item.sources,
        score: 1,
      };
    }
  }

  // Boost score for multi-source Reddit mentions
  for (const sym of Object.values(symbolMap)) {
    if (sym.redditSources?.length > 1) sym.score += sym.redditSources.length;
    if (sym.stocktwitsBullish > 70) sym.score += 1;
  }

  const sorted = Object.values(symbolMap)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  return { heatMap: sorted, count: sorted.length };
}

async function run() {
  const [stocktwits, reddit, news, heatMap] = await Promise.all([
    getStockTwitsTrending(),
    getRedditTrending(),
    getFinvizNews(),
    getCrossPlatformHeatMap(),
  ]);
  return { stocktwits, reddit, news, heatMap };
}

module.exports = {
  run,
  getStockTwitsTrending,
  getRedditTrending,
  getSymbolSentiment,
  getFinvizNews,
  getCrossPlatformHeatMap,
};
