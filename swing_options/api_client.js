/**
 * Unified API Client for Swing Options Trading
 *
 * Uses FREE APIs:
 * - Alpha Vantage (500 calls/day free) - Quotes, fundamentals, news
 * - FRED (unlimited free) - Macro indicators, VIX
 * - SEC EDGAR (unlimited free) - Filings, insider trades
 * - Yahoo Finance (unofficial) - Real-time quotes, options chains
 * - Reddit/Social - Sentiment scraping
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Simple cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Ensure directories exist
[config.storage.dataDir, config.storage.cacheDir, config.storage.logsDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/**
 * Generic HTTP request helper
 */
function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? https : http;

        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            port: urlObj.port || (isHttps ? 443 : 80),
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                ...options.headers
            }
        };

        const req = lib.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

/**
 * Cached request
 */
async function cachedRequest(key, url, ttl = CACHE_TTL) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttl) {
        return cached.data;
    }

    try {
        const data = await request(url);
        cache.set(key, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        console.error(`Request failed for ${key}:`, e.message);
        return null;
    }
}

// ============================================
// Alpha Vantage API (Free: 25 calls/day, Premium: 500/day)
// ============================================

const alphaVantage = {
    baseUrl: 'https://www.alphavantage.co/query',
    key: config.apis.alphaVantage.key || 'demo',

    async _get(params) {
        const queryParams = new URLSearchParams({ ...params, apikey: this.key });
        const url = `${this.baseUrl}?${queryParams}`;
        return cachedRequest(`av:${JSON.stringify(params)}`, url);
    },

    // Global quote
    async quote(symbol) {
        const data = await this._get({
            function: 'GLOBAL_QUOTE',
            symbol
        });
        if (data?.['Global Quote']) {
            const q = data['Global Quote'];
            return {
                symbol: q['01. symbol'],
                price: parseFloat(q['05. price']),
                change: parseFloat(q['09. change']),
                changePercent: parseFloat(q['10. change percent']?.replace('%', '')),
                volume: parseInt(q['06. volume']),
                previousClose: parseFloat(q['08. previous close']),
                open: parseFloat(q['02. open']),
                high: parseFloat(q['03. high']),
                low: parseFloat(q['04. low'])
            };
        }
        return null;
    },

    // Company overview
    async overview(symbol) {
        return this._get({
            function: 'OVERVIEW',
            symbol
        });
    },

    // Time series daily
    async dailyPrices(symbol, outputsize = 'compact') {
        return this._get({
            function: 'TIME_SERIES_DAILY',
            symbol,
            outputsize
        });
    },

    // News and sentiment
    async news(tickers = null, topics = null, limit = 50) {
        const params = {
            function: 'NEWS_SENTIMENT',
            limit
        };
        if (tickers) params.tickers = tickers;
        if (topics) params.topics = topics;
        return this._get(params);
    },

    // Top gainers/losers
    async topGainersLosers() {
        return this._get({
            function: 'TOP_GAINERS_LOSERS'
        });
    },

    // Earnings calendar
    async earningsCalendar(symbol = null, horizon = '3month') {
        const params = {
            function: 'EARNINGS_CALENDAR',
            horizon
        };
        if (symbol) params.symbol = symbol;

        // This returns CSV, need to parse
        const queryParams = new URLSearchParams({ ...params, apikey: this.key });
        const url = `${this.baseUrl}?${queryParams}`;

        try {
            const response = await request(url);
            if (typeof response === 'string' && response.includes(',')) {
                // Parse CSV
                const lines = response.trim().split('\n');
                const headers = lines[0].split(',');
                return lines.slice(1).map(line => {
                    const values = line.split(',');
                    const obj = {};
                    headers.forEach((h, i) => obj[h] = values[i]);
                    return obj;
                });
            }
            return response;
        } catch (e) {
            return [];
        }
    }
};

// ============================================
// Yahoo Finance (Unofficial - no API key needed)
// ============================================

const yahoo = {
    // Store crumb and cookies for authenticated requests
    crumb: null,
    cookies: null,
    authLoaded: false,

    // Load auth state from saved browser session
    loadAuthState() {
        if (this.authLoaded) return true;

        try {
            const authFile = path.join(__dirname, '..', 'browser_state', 'yahoo_auth.json');
            if (fs.existsSync(authFile)) {
                const authData = JSON.parse(fs.readFileSync(authFile, 'utf8'));

                // Check if auth is expired (older than 30 days)
                const authDate = new Date(authData.timestamp);
                const daysSinceAuth = (Date.now() - authDate.getTime()) / (1000 * 60 * 60 * 24);

                if (daysSinceAuth < 30) {
                    this.crumb = authData.crumb;

                    // Only include essential Yahoo cookies to avoid header overflow
                    // Filter for Yahoo-specific cookies only
                    const essentialCookies = authData.cookies.filter(c => {
                        const name = c.name.toLowerCase();
                        return (
                            c.domain.includes('yahoo.com') &&
                            (name.includes('b') || // Session cookies often start with 'b'
                             name.includes('a3') || // Yahoo auth cookie
                             name.includes('guc') || // Yahoo user cookie
                             name.includes('as') || // Yahoo session
                             name.includes('gpp') || // Yahoo privacy
                             name === 'thamba') // Yahoo auth token
                        );
                    });

                    // Convert cookies array to cookie string
                    this.cookies = essentialCookies
                        .map(c => `${c.name}=${c.value}`)
                        .join('; ');

                    this.authLoaded = true;
                    console.log(`✅ Loaded Yahoo auth (${Math.floor(daysSinceAuth)} days old, ${essentialCookies.length} cookies)`);
                    return true;
                } else {
                    console.log('⚠️ Yahoo auth expired (>30 days old). Run: node setup_yahoo_auth.js');
                }
            } else {
                console.log('⚠️ Yahoo auth not found. Run: node setup_yahoo_auth.js');
            }
        } catch (e) {
            console.log('⚠️ Could not load Yahoo auth:', e.message);
        }

        this.authLoaded = false;
        return false;
    },

    async getCrumb() {
        // Try to load saved auth first
        if (!this.authLoaded) {
            this.loadAuthState();
        }

        if (this.crumb) return this.crumb;

        // Fallback to old method if saved auth not available
        try {
            // First get cookies from main page
            const mainUrl = 'https://finance.yahoo.com/quote/AAPL';
            const response = await new Promise((resolve, reject) => {
                https.get(mainUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html'
                    }
                }, (res) => {
                    let data = '';
                    this.cookies = res.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });

            // Extract crumb from page
            const crumbMatch = response.match(/"crumb":"([^"]+)"/);
            if (crumbMatch) {
                this.crumb = crumbMatch[1].replace(/\\u002F/g, '/');
                return this.crumb;
            }
        } catch (e) {
            console.log('Could not get Yahoo crumb:', e.message);
        }
        return null;
    },

    async quote(symbol) {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
        const data = await cachedRequest(`yahoo:quote:${symbol}`, url, 60000);

        if (data?.chart?.result?.[0]) {
            const result = data.chart.result[0];
            const meta = result.meta;
            const quote = result.indicators?.quote?.[0];
            const lastIdx = (quote?.close?.length || 1) - 1;

            return {
                symbol: meta.symbol,
                price: meta.regularMarketPrice,
                previousClose: meta.previousClose,
                change: meta.regularMarketPrice - meta.previousClose,
                changePercent: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100,
                volume: quote?.volume?.[lastIdx] || meta.regularMarketVolume,
                marketCap: meta.marketCap,
                exchange: meta.exchangeName
            };
        }
        return null;
    },

    async optionsChain(symbol) {
        // Yahoo now requires crumb - try to get it
        const crumb = await this.getCrumb();

        let url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;
        if (crumb) {
            url += `?crumb=${encodeURIComponent(crumb)}`;
        }

        try {
            const data = await new Promise((resolve, reject) => {
                https.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json',
                        'Cookie': this.cookies || ''
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve(null);
                        }
                    });
                }).on('error', reject);
            });

            if (data?.optionChain?.result?.[0]) {
                const result = data.optionChain.result[0];
                return {
                    symbol,
                    expirationDates: result.expirationDates?.map(ts => new Date(ts * 1000).toISOString().split('T')[0]),
                    strikes: result.strikes,
                    quote: result.quote,
                    calls: result.options?.[0]?.calls || [],
                    puts: result.options?.[0]?.puts || []
                };
            }
        } catch (e) {
            console.log(`Options chain error for ${symbol}:`, e.message);
        }
        return null;
    },

    async optionsChainByExpiry(symbol, expiry) {
        const crumb = await this.getCrumb();
        let url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}?date=${expiry}`;
        if (crumb) {
            url += `&crumb=${encodeURIComponent(crumb)}`;
        }

        try {
            const data = await new Promise((resolve, reject) => {
                https.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json',
                        'Cookie': this.cookies || ''
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve(null);
                        }
                    });
                }).on('error', reject);
            });

            if (data?.optionChain?.result?.[0]) {
                const result = data.optionChain.result[0];
                return {
                    symbol,
                    expiry: new Date(expiry * 1000).toISOString().split('T')[0],
                    calls: result.options?.[0]?.calls || [],
                    puts: result.options?.[0]?.puts || []
                };
            }
        } catch (e) {
            console.log(`Options chain error for ${symbol}:`, e.message);
        }
        return null;
    },

    async historicalPrices(symbol, period1, period2, interval = '1d') {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
        return cachedRequest(`yahoo:history:${symbol}:${period1}:${period2}`, url);
    }
};

// ============================================
// FRED API (Economic Data - Unlimited Free)
// ============================================

const fred = {
    baseUrl: 'https://api.stlouisfed.org/fred',
    key: config.apis.fred.key,

    async _get(endpoint) {
        const separator = endpoint.includes('?') ? '&' : '?';
        const url = `${this.baseUrl}/${endpoint}${separator}api_key=${this.key}&file_type=json`;
        return cachedRequest(`fred:${endpoint}`, url);
    },

    async series(seriesId, observationStart = null) {
        let endpoint = `series/observations?series_id=${seriesId}`;
        if (observationStart) {
            endpoint += `&observation_start=${observationStart}`;
        }
        return this._get(endpoint);
    },

    async vix() {
        return this.series('VIXCLS');
    },

    async fedFundsRate() {
        return this.series('FEDFUNDS');
    },

    async treasury10y() {
        return this.series('DGS10');
    },

    async treasury2y() {
        return this.series('DGS2');
    },

    async yieldCurveSpread() {
        return this.series('T10Y2Y');
    }
};

// ============================================
// SEC EDGAR API (Free, unlimited)
// ============================================

const sec = {
    baseUrl: 'https://data.sec.gov',

    async _get(endpoint) {
        const url = `${this.baseUrl}${endpoint}`;
        return cachedRequest(`sec:${endpoint}`, url, 60000);
    },

    async getCompanyTickers() {
        const url = 'https://www.sec.gov/files/company_tickers.json';
        return cachedRequest('sec:company_tickers', url, 3600000);
    },

    async tickerToCik(ticker) {
        const tickers = await this.getCompanyTickers();
        if (!tickers) return null;

        for (const val of Object.values(tickers)) {
            if (val.ticker === ticker.toUpperCase()) {
                return String(val.cik_str).padStart(10, '0');
            }
        }
        return null;
    },

    async filings(cik) {
        const paddedCik = String(cik).padStart(10, '0');
        return this._get(`/submissions/CIK${paddedCik}.json`);
    }
};

// ============================================
// Finnhub API (Free: 60 calls/min)
// ============================================

const finnhub = {
    baseUrl: 'https://finnhub.io/api/v1',
    key: config.apis.finnhub.key,

    async _get(endpoint) {
        if (!this.key) {
            return null;
        }
        const separator = endpoint.includes('?') ? '&' : '?';
        const url = `${this.baseUrl}/${endpoint}${separator}token=${this.key}`;
        return cachedRequest(`finnhub:${endpoint}`, url);
    },

    async news(symbol, from, to) {
        return this._get(`company-news?symbol=${symbol}&from=${from}&to=${to}`);
    },

    async newsSentiment(symbol) {
        return this._get(`news-sentiment?symbol=${symbol}`);
    },

    async earningsCalendar(from, to) {
        return this._get(`calendar/earnings?from=${from}&to=${to}`);
    },

    async recommendations(symbol) {
        return this._get(`stock/recommendation?symbol=${symbol}`);
    },

    async priceTarget(symbol) {
        return this._get(`stock/price-target?symbol=${symbol}`);
    },

    async insiderTransactions(symbol) {
        return this._get(`stock/insider-transactions?symbol=${symbol}`);
    }
};

// ============================================
// Social Sentiment (Multiple Sources)
// ============================================

const social = {
    // Reddit via ApeWisdom
    async apeWisdomTrending() {
        try {
            const url = 'https://apewisdom.io/api/v1.0/filter/all-stocks/page/1';
            return cachedRequest('apewisdom:trending', url, 300000);
        } catch (e) {
            return { results: [] };
        }
    },

    // StockTwits - Real-time social sentiment
    async stockTwitsSentiment(symbol) {
        try {
            const url = `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`;
            const data = await cachedRequest(`stocktwits:${symbol}`, url, 300000);

            if (data?.symbol) {
                const messages = data.messages || [];
                let bullish = 0, bearish = 0, total = messages.length;

                for (const msg of messages) {
                    if (msg.entities?.sentiment?.basic === 'Bullish') bullish++;
                    if (msg.entities?.sentiment?.basic === 'Bearish') bearish++;
                }

                return {
                    symbol: data.symbol.symbol,
                    title: data.symbol.title,
                    watchlistCount: data.symbol.watchlist_count,
                    messageVolume: total,
                    bullishCount: bullish,
                    bearishCount: bearish,
                    sentiment: total > 0 ? (bullish - bearish) / total : 0, // -1 to 1 scale
                    sentimentLabel: bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral'
                };
            }
            return null;
        } catch (e) {
            return null;
        }
    },

    // StockTwits trending
    async stockTwitsTrending() {
        try {
            const url = 'https://api.stocktwits.com/api/2/trending/symbols.json';
            const data = await cachedRequest('stocktwits:trending', url, 300000);

            if (data?.symbols) {
                return data.symbols.map(s => ({
                    ticker: s.symbol,
                    title: s.title,
                    watchlistCount: s.watchlist_count || 0
                }));
            }
            return [];
        } catch (e) {
            return [];
        }
    },

    // Finviz news and sentiment (scraping)
    async finvizNews(symbol) {
        try {
            const url = `https://finviz.com/quote.ashx?t=${symbol}`;
            const html = await new Promise((resolve, reject) => {
                https.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });

            // Extract news headlines from HTML
            const newsMatches = html.match(/class="tab-link-news"[^>]*>([^<]+)</g) || [];
            const headlines = newsMatches.slice(0, 10).map(m => {
                const match = m.match(/>([^<]+)</);
                return match ? match[1] : '';
            }).filter(h => h);

            // Simple sentiment from headlines
            const bullishWords = ['surge', 'jump', 'soar', 'rally', 'gain', 'rise', 'up', 'beat', 'strong', 'buy', 'upgrade'];
            const bearishWords = ['fall', 'drop', 'plunge', 'sink', 'decline', 'down', 'miss', 'weak', 'sell', 'downgrade', 'cut'];

            let bullScore = 0, bearScore = 0;
            for (const h of headlines) {
                const lower = h.toLowerCase();
                for (const w of bullishWords) if (lower.includes(w)) bullScore++;
                for (const w of bearishWords) if (lower.includes(w)) bearScore++;
            }

            return {
                symbol,
                headlines,
                bullishScore: bullScore,
                bearishScore: bearScore,
                sentiment: headlines.length > 0 ? (bullScore - bearScore) / headlines.length : 0
            };
        } catch (e) {
            return null;
        }
    },

    // Get all trending from multiple sources
    async getTrendingTickers() {
        const results = {
            reddit: [],
            stocktwits: [],
            combined: [],
            timestamp: new Date().toISOString()
        };

        try {
            // Fetch from multiple sources in parallel
            const [apeWisdom, stockTwitsTrending] = await Promise.all([
                this.apeWisdomTrending(),
                this.stockTwitsTrending()
            ]);

            // Reddit data
            if (apeWisdom?.results) {
                results.reddit = apeWisdom.results.slice(0, 20).map(r => ({
                    ticker: r.ticker,
                    mentions: r.mentions,
                    rank: r.rank,
                    upvotes: r.upvotes,
                    source: 'reddit'
                }));
            }

            // StockTwits data
            if (stockTwitsTrending?.length > 0) {
                results.stocktwits = stockTwitsTrending.slice(0, 20).map((s, i) => ({
                    ticker: s.ticker,
                    watchlistCount: s.watchlistCount,
                    rank: i + 1,
                    source: 'stocktwits'
                }));
            }

            // Combine and dedupe (prefer Reddit data for mentions, add StockTwits unique ones)
            const seenTickers = new Set();
            results.combined = [];

            // Add Reddit tickers first
            for (const r of results.reddit) {
                seenTickers.add(r.ticker);
                results.combined.push({
                    ticker: r.ticker,
                    redditMentions: r.mentions,
                    redditRank: r.rank,
                    stocktwitsWatchlist: results.stocktwits.find(s => s.ticker === r.ticker)?.watchlistCount || 0,
                    sources: ['reddit']
                });
            }

            // Add StockTwits-only tickers
            for (const s of results.stocktwits) {
                if (!seenTickers.has(s.ticker)) {
                    seenTickers.add(s.ticker);
                    results.combined.push({
                        ticker: s.ticker,
                        redditMentions: 0,
                        stocktwitsWatchlist: s.watchlistCount,
                        stocktwitsRank: s.rank,
                        sources: ['stocktwits']
                    });
                } else {
                    // Update existing with StockTwits data
                    const existing = results.combined.find(c => c.ticker === s.ticker);
                    if (existing) {
                        existing.stocktwitsWatchlist = s.watchlistCount;
                        existing.stocktwitsRank = s.rank;
                        existing.sources.push('stocktwits');
                    }
                }
            }

            // Sort combined by total activity (reddit mentions + stocktwits watchlist/100)
            results.combined.sort((a, b) => {
                const scoreA = (a.redditMentions || 0) + (a.stocktwitsWatchlist || 0) / 100;
                const scoreB = (b.redditMentions || 0) + (b.stocktwitsWatchlist || 0) / 100;
                return scoreB - scoreA;
            });

        } catch (e) {
            console.error('Error fetching trending:', e.message);
        }

        return results;
    },

    // Get detailed sentiment for a specific symbol
    async getSymbolSentiment(symbol) {
        const [stocktwits, finviz] = await Promise.all([
            this.stockTwitsSentiment(symbol),
            this.finvizNews(symbol)
        ]);

        // Aggregate sentiment
        let totalSentiment = 0;
        let sources = 0;

        if (stocktwits?.sentiment) {
            totalSentiment += stocktwits.sentiment;
            sources++;
        }
        if (finviz?.sentiment) {
            totalSentiment += finviz.sentiment;
            sources++;
        }

        return {
            symbol,
            stocktwits,
            finviz,
            aggregateSentiment: sources > 0 ? totalSentiment / sources : 0,
            sentimentLabel: totalSentiment > 0.1 ? 'bullish' : totalSentiment < -0.1 ? 'bearish' : 'neutral'
        };
    },

    // Get short interest and bearish indicators from Finviz
    async finvizShortData(symbol) {
        try {
            const url = `https://finviz.com/quote.ashx?t=${symbol}`;
            const html = await new Promise((resolve, reject) => {
                https.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });

            // Extract key metrics - Finviz uses <b> tags for values (use /s for multiline)
            const shortFloat = html.match(/Short Float.*?<b>([^<]+)<\/b>/s)?.[1] || null;
            const shortRatio = html.match(/Short Ratio.*?<b>([^<]+)<\/b>/s)?.[1] || null;
            const targetPrice = html.match(/Target Price.*?<b>([^<]+)<\/b>/s)?.[1] || null;
            const rsi = html.match(/RSI \(14\).*?<b>([0-9.]+)<\/b>/s)?.[1] || null;
            const analystRec = html.match(/>Recom<.*?<b>([^<]+)<\/b>/s)?.[1] || null;
            const marketCap = html.match(/Market Cap.*?<b>([^<]+)<\/b>/s)?.[1] || null;
            const price = html.match(/Price<.*?<b>([0-9.]+)<\/b>/s)?.[1] || null;

            return {
                symbol,
                shortFloat: shortFloat ? parseFloat(shortFloat.replace('%', '')) : null,
                shortRatio: shortRatio ? parseFloat(shortRatio) : null,
                targetPrice: targetPrice ? parseFloat(targetPrice.replace('$', '')) : null,
                rsi: rsi ? parseFloat(rsi) : null,
                analystRec: analystRec ? parseFloat(analystRec) : null, // 1=Strong Buy, 5=Strong Sell
                marketCap: marketCap,
                price: price ? parseFloat(price) : null
            };
        } catch (e) {
            return null;
        }
    },

    // Scan for high short interest stocks (potential squeeze or bearish plays)
    async scanHighShortInterest() {
        // Known high short interest tickers to check (updated periodically)
        // These are stocks historically known for high short interest
        const knownHighShort = [
            'GME', 'AMC', 'CVNA', 'BYND', 'UPST', 'BBBY', 'SPCE', 'LCID',
            'RIVN', 'PLTR', 'SOFI', 'HOOD', 'AFRM', 'NKLA', 'GOEV',
            'CLOV', 'WISH', 'SKLZ', 'RIDE', 'VLDR', 'QS', 'LAZR',
            'FSR', 'FFIE', 'MULN', 'APRN', 'BGFV', 'KOSS', 'EXPR'
        ];

        const results = [];

        for (const ticker of knownHighShort.slice(0, 15)) {
            try {
                const data = await this.finvizShortData(ticker);
                if (data && data.shortFloat && data.shortFloat > 10) {
                    results.push({
                        ticker,
                        ...data
                    });
                }
            } catch (e) {
                continue;
            }
        }

        // Sort by short float descending
        results.sort((a, b) => (b.shortFloat || 0) - (a.shortFloat || 0));

        return results;
    },

    // Get BEARISH trending - stocks with negative sentiment
    async getBearishSentiment() {
        const results = [];

        // Get StockTwits trending and filter for bearish
        const trending = await this.stockTwitsTrending();

        for (const t of trending.slice(0, 15)) {
            try {
                const sentiment = await this.stockTwitsSentiment(t.ticker);
                if (sentiment && sentiment.bearishCount > sentiment.bullishCount) {
                    results.push({
                        ticker: t.ticker,
                        sentiment: 'BEARISH',
                        bullish: sentiment.bullishCount,
                        bearish: sentiment.bearishCount,
                        ratio: sentiment.bearishCount / (sentiment.bullishCount || 1),
                        messages: sentiment.messageVolume
                    });
                }
            } catch (e) {
                continue;
            }
        }

        return results.sort((a, b) => b.ratio - a.ratio);
    },

    // Filter for small/mid cap opportunities (exclude mega caps)
    async getSmallMidCapBuzz() {
        const trending = await this.getTrendingTickers();
        const filtered = [];

        // Mega caps to exclude
        const megaCaps = ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK.A', 'BRK.B', 'JPM', 'V', 'UNH', 'XOM', 'JNJ', 'WMT', 'MA', 'PG', 'HD', 'CVX', 'SPY', 'QQQ', 'IWM', 'DIA'];

        for (const t of trending.combined || []) {
            if (megaCaps.includes(t.ticker)) continue;

            // Get market cap to filter
            try {
                const shortData = await this.finvizShortData(t.ticker);
                if (shortData?.marketCap) {
                    // Parse market cap (e.g., "5.2B", "800M")
                    const mcStr = shortData.marketCap;
                    let mcValue = parseFloat(mcStr);
                    if (mcStr.includes('B')) mcValue *= 1e9;
                    else if (mcStr.includes('M')) mcValue *= 1e6;

                    // Small cap < 2B, Mid cap < 10B
                    if (mcValue < 10e9) {
                        filtered.push({
                            ...t,
                            marketCap: shortData.marketCap,
                            shortFloat: shortData.shortFloat,
                            rsi: shortData.rsi
                        });
                    }
                }
            } catch (e) {
                continue;
            }
        }

        return filtered;
    }
};

// ============================================
// Unified Data Aggregator
// ============================================

const aggregator = {
    async getStockData(symbol) {
        const [quote, overview, news] = await Promise.all([
            yahoo.quote(symbol),
            alphaVantage.overview(symbol).catch(() => null),
            alphaVantage.news(symbol, null, 10).catch(() => ({ feed: [] }))
        ]);

        return {
            symbol,
            quote,
            profile: overview ? {
                companyName: overview.Name,
                sector: overview.Sector,
                industry: overview.Industry,
                mktCap: parseFloat(overview.MarketCapitalization),
                description: overview.Description,
                exchange: overview.Exchange
            } : null,
            news: news?.feed?.slice(0, 5) || [],
            fetchedAt: new Date().toISOString()
        };
    },

    async getOptionsData(symbol) {
        const chain = await yahoo.optionsChain(symbol);
        const quote = await yahoo.quote(symbol);

        if (!chain) {
            return { symbol, error: 'No options data available' };
        }

        // Calculate historical volatility from price history
        const now = Math.floor(Date.now() / 1000);
        const yearAgo = now - (365 * 24 * 60 * 60);
        const history = await yahoo.historicalPrices(symbol, yearAgo, now);

        let hvAnnual = 0.3; // Default 30%
        if (history?.chart?.result?.[0]?.indicators?.quote?.[0]?.close) {
            const closes = history.chart.result[0].indicators.quote[0].close.filter(c => c);
            const returns = [];
            for (let i = 1; i < closes.length; i++) {
                if (closes[i] && closes[i - 1]) {
                    returns.push(Math.log(closes[i] / closes[i - 1]));
                }
            }
            if (returns.length > 20) {
                const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
                hvAnnual = Math.sqrt(variance) * Math.sqrt(252);
            }
        }

        // Combine calls and puts into a single chain array with type annotation
        const combinedChain = [
            ...(chain.calls || []).map(c => ({ ...c, type: 'call', expirationDate: chain.expirationDates?.[0] })),
            ...(chain.puts || []).map(p => ({ ...p, type: 'put', expirationDate: chain.expirationDates?.[0] }))
        ];

        return {
            symbol,
            currentPrice: quote?.price,
            expirations: chain.expirationDates,
            calls: chain.calls,
            puts: chain.puts,
            chain: combinedChain, // Combined chain for options_analyzer
            historicalVolatility: hvAnnual,
            fetchedAt: new Date().toISOString()
        };
    },

    async scanCatalysts(symbols = null) {
        const catalysts = [];
        const today = new Date().toISOString().split('T')[0];

        // Get earnings calendar
        const earnings = await alphaVantage.earningsCalendar();
        if (Array.isArray(earnings)) {
            for (const e of earnings.slice(0, 50)) {
                if (symbols && !symbols.includes(e.symbol)) continue;
                if (!e.reportDate) continue;

                const daysUntil = Math.ceil((new Date(e.reportDate) - new Date()) / (1000 * 60 * 60 * 24));
                if (daysUntil < 0 || daysUntil > 14) continue;

                catalysts.push({
                    type: 'earnings',
                    symbol: e.symbol,
                    date: e.reportDate,
                    daysUntil,
                    epsEstimate: parseFloat(e.estimate) || null,
                    priority: daysUntil <= 7 ? 'high' : 'medium'
                });
            }
        }

        // Get trending Reddit tickers
        const trending = await social.getTrendingTickers();
        for (const t of trending.reddit.slice(0, 10)) {
            catalysts.push({
                type: 'social_buzz',
                symbol: t.ticker,
                mentions: t.mentions,
                rank: t.rank,
                priority: t.mentions > 200 ? 'high' : 'medium'
            });
        }

        return catalysts;
    },

    async getMarketOverview() {
        // Get VIX from FRED
        const [vixData, yieldCurve, topMovers] = await Promise.all([
            fred.vix(),
            fred.yieldCurveSpread(),
            alphaVantage.topGainersLosers().catch(() => null)
        ]);

        const vix = parseFloat(vixData?.observations?.slice(-1)[0]?.value) || 20;
        const yieldSpread = parseFloat(yieldCurve?.observations?.slice(-1)[0]?.value) || 0;

        let regime = 'neutral';
        if (vix > 25) regime = 'high_volatility';
        else if (vix < 15) regime = 'low_volatility';

        let yieldSignal = 'normal';
        if (yieldSpread < 0) yieldSignal = 'inverted';
        else if (yieldSpread > 1) yieldSignal = 'steep';

        // Parse top movers
        let gainers = [];
        let losers = [];
        let mostActive = [];

        if (topMovers?.top_gainers) {
            gainers = topMovers.top_gainers.slice(0, 10).map(g => ({
                symbol: g.ticker,
                price: parseFloat(g.price),
                change: parseFloat(g.change_amount),
                changesPercentage: parseFloat(g.change_percentage?.replace('%', ''))
            }));
        }

        if (topMovers?.top_losers) {
            losers = topMovers.top_losers.slice(0, 10).map(l => ({
                symbol: l.ticker,
                price: parseFloat(l.price),
                change: parseFloat(l.change_amount),
                changesPercentage: parseFloat(l.change_percentage?.replace('%', ''))
            }));
        }

        if (topMovers?.most_actively_traded) {
            mostActive = topMovers.most_actively_traded.slice(0, 10).map(a => ({
                symbol: a.ticker,
                price: parseFloat(a.price),
                volume: parseInt(a.volume)
            }));
        }

        return {
            vix,
            vixLevel: vix > 25 ? 'high' : vix < 15 ? 'low' : 'normal',
            regime,
            yieldCurve: {
                spread: yieldSpread,
                signal: yieldSignal
            },
            gainers,
            losers,
            mostActive,
            timestamp: new Date().toISOString()
        };
    }
};

// ============================================
// Utility Functions
// ============================================

function getToday() {
    return new Date().toISOString().split('T')[0];
}

function getDateDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
}

// ============================================
// FMP-Compatible Wrapper (using free APIs)
// ============================================

const fmp = {
    // Quote using Yahoo Finance
    async quote(symbol) {
        const q = await yahoo.quote(symbol);
        if (!q) return null;
        return {
            symbol: q.symbol,
            price: q.price,
            changesPercentage: q.changePercent,
            change: q.change,
            volume: q.volume,
            avgVolume: q.volume, // Yahoo doesn't give avg separately in this endpoint
            marketCap: q.marketCap
        };
    },

    // Profile using Alpha Vantage overview
    async profile(symbol) {
        const overview = await alphaVantage.overview(symbol);
        if (!overview || overview.Symbol === undefined) return null;
        return {
            symbol: overview.Symbol,
            companyName: overview.Name,
            sector: overview.Sector,
            industry: overview.Industry,
            mktCap: parseFloat(overview.MarketCapitalization) || 0,
            description: overview.Description,
            exchange: overview.Exchange,
            volAvg: parseFloat(overview.AvgVolume) || 0
        };
    },

    // Earnings calendar using Alpha Vantage
    async earningsCalendar(from, to) {
        const earnings = await alphaVantage.earningsCalendar();
        if (!Array.isArray(earnings)) return [];

        const fromDate = new Date(from);
        const toDate = new Date(to);

        return earnings
            .filter(e => {
                const reportDate = new Date(e.reportDate);
                return reportDate >= fromDate && reportDate <= toDate;
            })
            .map(e => ({
                symbol: e.symbol,
                date: e.reportDate,
                time: e.fiscalDateEnding?.includes('Q') ? 'amc' : 'bmo', // Best guess
                epsEstimated: parseFloat(e.estimate) || null,
                revenueEstimated: null
            }));
    },

    // Insider trading latest
    async insiderTradingLatest(limit = 100) {
        // Use Finnhub if available, otherwise return empty
        if (!finnhub.key) return [];

        // Finnhub doesn't have a "latest all insiders" endpoint
        // We'd need to query per symbol. Return empty for now.
        return [];
    },

    // Stock screener (simplified)
    async stockScreener(params = {}) {
        // Get trending tickers as a screener alternative
        const trending = await social.getTrendingTickers();
        return trending.reddit.map(t => ({
            symbol: t.ticker,
            companyName: t.ticker,
            marketCap: 0,
            volume: t.mentions
        }));
    }
};

// ============================================
// Exports
// ============================================

module.exports = {
    alphaVantage,
    yahoo,
    fred,
    sec,
    finnhub,
    social,
    aggregator,
    fmp, // FMP-compatible wrapper using free APIs
    utils: {
        getToday,
        getDateDaysAgo,
        cache
    }
};

// CLI test
if (require.main === module) {
    (async () => {
        console.log('Testing API Client (Free APIs)...\n');

        // Test Yahoo quote
        console.log('1. Testing Yahoo Finance quote...');
        const quote = await yahoo.quote('AAPL');
        console.log(`   AAPL: $${quote?.price} (${quote?.changePercent?.toFixed(2)}%)\n`);

        // Test FRED VIX
        console.log('2. Testing FRED VIX...');
        const vix = await fred.vix();
        const latestVix = vix?.observations?.slice(-1)[0];
        console.log(`   VIX: ${latestVix?.value} (${latestVix?.date})\n`);

        // Test Reddit trending
        console.log('3. Testing Reddit trending...');
        const trending = await social.getTrendingTickers();
        console.log(`   Top tickers: ${trending.reddit.slice(0, 5).map(t => t.ticker).join(', ')}\n`);

        // Test Yahoo options
        console.log('4. Testing Yahoo options chain...');
        const options = await yahoo.optionsChain('AAPL');
        console.log(`   AAPL expirations: ${options?.expirationDates?.slice(0, 3).join(', ')}...\n`);

        // Test Alpha Vantage
        console.log('5. Testing Alpha Vantage earnings...');
        const earnings = await alphaVantage.earningsCalendar();
        console.log(`   Found ${Array.isArray(earnings) ? earnings.length : 0} upcoming earnings\n`);

        console.log('All tests complete!');
    })();
}
