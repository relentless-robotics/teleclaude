/**
 * Substack Reader & Analyzer
 *
 * Features:
 * - Login to Substack (browser automation)
 * - Fetch posts from specific publications
 * - Extract trading signals (tickers, sentiment, thesis)
 * - Archive posts locally
 * - Track picks vs outcomes
 */

const fs = require('fs');
const path = require('path');

// Storage paths
const DATA_DIR = path.join(__dirname, '..', 'data', 'substack');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const PICKS_FILE = path.join(DATA_DIR, 'picks.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure directories exist
[DATA_DIR, ARCHIVE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Common stock ticker pattern
const TICKER_PATTERN = /\$([A-Z]{1,5})\b|\b([A-Z]{2,5})\s+(?:stock|shares|calls|puts|options)/g;

/**
 * Extract tickers from text
 */
function extractTickers(text) {
  const tickers = new Set();
  let match;

  // Pattern 1: $TICKER format
  const dollarPattern = /\$([A-Z]{1,5})\b/g;
  while ((match = dollarPattern.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  // Pattern 2: Known major tickers mentioned
  const knownTickers = [
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA',
    'AMD', 'INTC', 'SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'UVXY', 'SQQQ',
    'TQQQ', 'ARKK', 'XLF', 'XLE', 'XLK', 'XLV', 'XLY', 'XLP', 'XLI',
    'NFLX', 'CRM', 'ADBE', 'PYPL', 'SQ', 'COIN', 'MARA', 'RIOT',
    'GME', 'AMC', 'BBBY', 'BB', 'NOK', 'PLTR', 'SOFI', 'LCID', 'RIVN',
    'NIO', 'BABA', 'JD', 'PDD', 'BA', 'DIS', 'NKLA', 'SPCE', 'WISH'
  ];

  for (const ticker of knownTickers) {
    if (text.toUpperCase().includes(ticker)) {
      tickers.add(ticker);
    }
  }

  return Array.from(tickers);
}

/**
 * Extract sentiment from text
 */
function extractSentiment(text) {
  const bullishWords = ['bullish', 'long', 'buy', 'calls', 'upside', 'breakout', 'moon', 'rip', 'pump', 'squeeze'];
  const bearishWords = ['bearish', 'short', 'sell', 'puts', 'downside', 'breakdown', 'dump', 'crash', 'fade'];

  const lower = text.toLowerCase();
  let bullScore = 0;
  let bearScore = 0;

  bullishWords.forEach(word => {
    const matches = (lower.match(new RegExp(word, 'g')) || []).length;
    bullScore += matches;
  });

  bearishWords.forEach(word => {
    const matches = (lower.match(new RegExp(word, 'g')) || []).length;
    bearScore += matches;
  });

  if (bullScore > bearScore * 1.5) return 'BULLISH';
  if (bearScore > bullScore * 1.5) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Parse a Substack post and extract trading info
 */
function parsePost(post) {
  const { title, content, date, url } = post;
  const fullText = `${title} ${content}`;

  return {
    title,
    date,
    url,
    tickers: extractTickers(fullText),
    sentiment: extractSentiment(fullText),
    wordCount: content.split(/\s+/).length,
    hasOptions: /calls|puts|strike|expir/i.test(content),
    hasMacro: /fed|fomc|cpi|nfp|gdp|inflation|rates/i.test(content),
    summary: content.slice(0, 500) + '...'
  };
}

/**
 * Archive a post locally
 */
function archivePost(post, publication) {
  const pubDir = path.join(ARCHIVE_DIR, publication.replace(/[^a-zA-Z0-9]/g, '_'));
  if (!fs.existsSync(pubDir)) {
    fs.mkdirSync(pubDir, { recursive: true });
  }

  const dateStr = new Date(post.date).toISOString().split('T')[0];
  const slug = post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const filename = `${dateStr}_${slug}.json`;

  fs.writeFileSync(
    path.join(pubDir, filename),
    JSON.stringify(post, null, 2)
  );

  return filename;
}

/**
 * Save a trading pick for tracking
 */
function savePick(pick) {
  let picks = [];
  if (fs.existsSync(PICKS_FILE)) {
    picks = JSON.parse(fs.readFileSync(PICKS_FILE, 'utf8'));
  }

  picks.push({
    ...pick,
    savedAt: new Date().toISOString(),
    outcome: null // To be updated later
  });

  fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2));
  return picks.length;
}

/**
 * Get all archived posts for a publication
 */
function getArchivedPosts(publication) {
  const pubDir = path.join(ARCHIVE_DIR, publication.replace(/[^a-zA-Z0-9]/g, '_'));
  if (!fs.existsSync(pubDir)) return [];

  const files = fs.readdirSync(pubDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const content = fs.readFileSync(path.join(pubDir, f), 'utf8');
    return JSON.parse(content);
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * Get all tracked picks
 */
function getPicks() {
  if (!fs.existsSync(PICKS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PICKS_FILE, 'utf8'));
}

/**
 * Update pick outcome
 */
function updatePickOutcome(pickIndex, outcome) {
  const picks = getPicks();
  if (picks[pickIndex]) {
    picks[pickIndex].outcome = outcome;
    picks[pickIndex].updatedAt = new Date().toISOString();
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2));
  }
  return picks[pickIndex];
}

/**
 * Save Substack configuration
 */
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Load Substack configuration
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/**
 * Format posts for Discord display
 */
function formatPostsForDiscord(posts, limit = 5) {
  if (!posts.length) return 'No posts found.';

  let msg = `**📰 Latest ${Math.min(posts.length, limit)} Posts:**\n\n`;

  posts.slice(0, limit).forEach((post, i) => {
    const tickers = post.tickers?.length ? post.tickers.join(', ') : 'None';
    const sentiment = post.sentiment || 'N/A';
    const date = post.date ? new Date(post.date).toLocaleDateString() : 'Unknown';

    msg += `**${i + 1}. ${post.title}**\n`;
    msg += `📅 ${date} | 🎯 ${tickers} | ${sentiment === 'BULLISH' ? '🟢' : sentiment === 'BEARISH' ? '🔴' : '⚪'} ${sentiment}\n`;
    if (post.hasOptions) msg += `📊 Options mentioned\n`;
    if (post.hasMacro) msg += `🏦 Macro analysis\n`;
    msg += `\n`;
  });

  return msg;
}

/**
 * Analyze author's track record
 */
function analyzeTrackRecord() {
  const picks = getPicks();
  if (!picks.length) return { total: 0, wins: 0, winRate: 0 };

  const completed = picks.filter(p => p.outcome !== null);
  const wins = completed.filter(p => p.outcome === 'WIN').length;

  return {
    total: picks.length,
    completed: completed.length,
    wins,
    losses: completed.length - wins,
    winRate: completed.length ? (wins / completed.length * 100).toFixed(1) : 0,
    pending: picks.length - completed.length
  };
}

module.exports = {
  extractTickers,
  extractSentiment,
  parsePost,
  archivePost,
  savePick,
  getArchivedPosts,
  getPicks,
  updatePickOutcome,
  saveConfig,
  loadConfig,
  formatPostsForDiscord,
  analyzeTrackRecord,
  DATA_DIR,
  ARCHIVE_DIR
};
