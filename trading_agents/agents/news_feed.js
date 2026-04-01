/**
 * Intraday News Feed
 *
 * Fetches headlines from multiple free sources every 5 minutes.
 * Filters for relevant symbols (positions + watchlist).
 * Stores in shared brain for all agents to access.
 *
 * Sources:
 * - Finviz News (free, per-symbol)
 * - Yahoo Finance RSS (free, general market)
 */

const https = require('https');
const brain = require('../shared_brain');

// Track seen headlines to avoid duplicates
const seenHeadlines = new Set();
let lastFetchTime = 0;

/**
 * Fetch news headlines from Finviz for a specific symbol
 */
function fetchFinvizNews(symbol) {
  return new Promise((resolve) => {
    const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const headlines = [];
          // Parse news table rows from Finviz HTML
          const newsMatches = data.matchAll(/<a[^>]*class="tab-link-news"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi);
          for (const match of newsMatches) {
            const headline = match[2].trim();
            if (headline && !seenHeadlines.has(headline)) {
              seenHeadlines.add(headline);
              headlines.push({
                headline,
                url: match[1],
                symbol,
                source: 'finviz',
                time: new Date().toISOString(),
              });
            }
          }
          resolve(headlines.slice(0, 5)); // Max 5 per symbol
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * Fetch general market news from Yahoo Finance RSS
 */
function fetchYahooRSS() {
  return new Promise((resolve) => {
    const url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,^IXIC,^DJI&region=US&lang=en-US';
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const headlines = [];
          const items = data.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/gi);
          for (const match of items) {
            const headline = match[1].trim();
            if (headline && !seenHeadlines.has(headline)) {
              seenHeadlines.add(headline);
              headlines.push({
                headline,
                url: match[2],
                symbol: null,
                source: 'yahoo',
                time: new Date().toISOString(),
              });
            }
          }
          resolve(headlines.slice(0, 10));
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * Detect which symbols a headline is about
 */
function tagHeadlineSymbols(headline, watchedSymbols) {
  const mentioned = [];
  const upper = headline.toUpperCase();
  for (const sym of watchedSymbols) {
    // Match exact word boundaries to avoid false positives
    const regex = new RegExp(`\\b${sym}\\b`, 'i');
    if (regex.test(headline)) {
      mentioned.push(sym);
    }
  }
  // Also check company names
  const nameMap = {
    'APPLE': 'AAPL', 'NVIDIA': 'NVDA', 'TESLA': 'TSLA', 'AMAZON': 'AMZN',
    'GOOGLE': 'GOOGL', 'ALPHABET': 'GOOGL', 'META': 'META', 'MICROSOFT': 'MSFT',
    'ADVANCED MICRO': 'AMD', 'COINBASE': 'COIN', 'PALANTIR': 'PLTR',
    'SUPER MICRO': 'SMCI', 'SNAP INC': 'SNAP', 'SHOPIFY': 'SHOP',
  };
  for (const [name, sym] of Object.entries(nameMap)) {
    if (upper.includes(name) && !mentioned.includes(sym)) {
      mentioned.push(sym);
    }
  }
  return mentioned;
}

/**
 * Simple sentiment classification of a headline
 */
function classifyHeadline(headline) {
  const lower = headline.toLowerCase();
  const bullish = ['upgrade', 'beat', 'surge', 'rally', 'breakout', 'record high',
    'analyst raise', 'outperform', 'buy rating', 'strong demand', 'growth',
    'positive', 'bullish', 'soar', 'jump', 'spike up'];
  const bearish = ['downgrade', 'miss', 'plunge', 'sell-off', 'crash', 'warning',
    'analyst cut', 'underperform', 'sell rating', 'weak demand', 'decline',
    'negative', 'bearish', 'tumble', 'drop', 'layoff', 'lawsuit', 'investigation'];

  let score = 0;
  for (const word of bullish) { if (lower.includes(word)) score += 1; }
  for (const word of bearish) { if (lower.includes(word)) score -= 1; }

  if (score > 0) return 'BULLISH';
  if (score < 0) return 'BEARISH';
  return 'NEUTRAL';
}

class NewsFeed {
  constructor() {
    this.name = 'News Feed';
    this.emoji = '📰';
    this.lastRun = null;
  }

  /**
   * Fetch all news and update shared brain
   */
  async run() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${this.emoji} News Feed fetching...`);

    const allNews = [];

    // Get symbols to watch: positions + watchlist + liquid names
    const watchedSymbols = this.getWatchedSymbols();

    // 1. General market news (Yahoo RSS)
    const yahooNews = await fetchYahooRSS();
    for (const item of yahooNews) {
      item.symbols = tagHeadlineSymbols(item.headline, watchedSymbols);
      item.sentiment = classifyHeadline(item.headline);
      allNews.push(item);
    }

    // 2. Symbol-specific news (Finviz) - top 10 most important symbols
    const prioritySymbols = this.getPrioritySymbols(watchedSymbols);
    for (const symbol of prioritySymbols.slice(0, 10)) {
      const news = await fetchFinvizNews(symbol);
      for (const item of news) {
        item.symbols = [symbol, ...tagHeadlineSymbols(item.headline, watchedSymbols)];
        item.symbols = [...new Set(item.symbols)]; // Dedupe
        item.sentiment = classifyHeadline(item.headline);
        allNews.push(item);
      }
      await new Promise(r => setTimeout(r, 500)); // Rate limit Finviz
    }

    // Store in shared brain
    if (allNews.length > 0) {
      const existing = brain.ctx.catalysts.newsBreaking || [];
      // Merge with existing, keep latest 50
      const combined = [...allNews, ...existing].slice(0, 50);
      brain.writeCatalysts({ newsBreaking: combined });
      brain.logAgent('news-feed', `Fetched ${allNews.length} new headlines`);
    }

    this.lastRun = new Date();
    console.log(`[${new Date().toISOString()}] ${this.emoji} News Feed completed: ${allNews.length} headlines in ${Date.now() - startTime}ms`);

    return allNews;
  }

  /**
   * Get all symbols we care about
   */
  getWatchedSymbols() {
    const symbols = new Set();

    // Day trader positions
    const dtPositions = brain.ctx.dayTrader.positions || [];
    dtPositions.forEach(p => symbols.add(p.symbol));

    // Swing positions
    const swPositions = brain.ctx.swingTrader.positions || [];
    swPositions.forEach(p => symbols.add(p.symbol));

    // Day watchlist
    (brain.ctx.dayWatchlist || []).forEach(w => symbols.add(w.symbol));

    // Always watch liquid names
    ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMD', 'META', 'AMZN', 'MSFT', 'GOOGL'].forEach(s => symbols.add(s));

    return [...symbols];
  }

  /**
   * Prioritize symbols for individual news fetches
   * (positions first, then watchlist, then liquid names)
   */
  getPrioritySymbols(all) {
    const positions = new Set();
    (brain.ctx.dayTrader.positions || []).forEach(p => positions.add(p.symbol));
    (brain.ctx.swingTrader.positions || []).forEach(p => positions.add(p.symbol));

    // Positions first, then the rest
    const positionSymbols = all.filter(s => positions.has(s));
    const others = all.filter(s => !positions.has(s));
    return [...positionSymbols, ...others];
  }

  /**
   * Get news for a specific symbol (from brain cache)
   */
  getNewsForSymbol(symbol) {
    const news = brain.ctx.catalysts.newsBreaking || [];
    return news.filter(n => (n.symbols || []).includes(symbol) || n.symbol === symbol);
  }

  /**
   * Get all breaking news with sentiment
   */
  getBreakingNews() {
    return (brain.ctx.catalysts.newsBreaking || []).slice(0, 20);
  }

  /**
   * Reset daily state
   */
  resetDaily() {
    seenHeadlines.clear();
  }
}

module.exports = NewsFeed;
