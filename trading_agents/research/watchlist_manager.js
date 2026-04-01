/**
 * Watchlist Manager
 *
 * Manages dynamic watchlist that auto-updates from research dispatcher findings.
 * Integrates with swing_scanner to provide enriched watchlist with DD and catalysts.
 */

const fs = require('fs');
const path = require('path');
const dataLayer = require('./data_layer');

const WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'watchlist.json');
const RESEARCH_WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'research_watchlist.json');

// Thresholds
const AUTO_ADD_SCORE_THRESHOLD = 5; // Score > 5 auto-adds to watchlist
const STALE_DAYS = 30; // Remove after 30 days with no entry

/**
 * Load existing watchlist (manual + research-generated)
 */
function loadWatchlist() {
  try {
    if (fs.existsSync(RESEARCH_WATCHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(RESEARCH_WATCHLIST_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not load research watchlist:', e.message);
  }

  // Initialize new watchlist
  return {
    symbols: [],
    lastUpdated: null,
  };
}

/**
 * Save watchlist
 */
function saveWatchlist(watchlist) {
  watchlist.lastUpdated = new Date().toISOString();
  const dir = path.dirname(RESEARCH_WATCHLIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RESEARCH_WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
}

/**
 * Add symbol to watchlist (auto or manual)
 */
async function addSymbol(symbol, opportunity) {
  const watchlist = loadWatchlist();

  // Check if already exists
  const existing = watchlist.symbols.find(s => s.symbol === symbol);
  if (existing) {
    // Update existing entry
    existing.score = opportunity.score;
    existing.sourceCount = opportunity.sourceCount;
    existing.signals = opportunity.signals.map(s => s.source);
    existing.lastUpdated = new Date().toISOString();
    console.log(`  ✓ Updated watchlist entry: ${symbol} (score: ${opportunity.score})`);
  } else {
    // Add new entry
    const quote = await dataLayer.getQuote(symbol);
    const entry = {
      symbol,
      addedDate: new Date().toISOString().split('T')[0],
      source: 'research_dispatcher',
      score: opportunity.score,
      sourceCount: opportunity.sourceCount,
      signals: opportunity.signals.map(s => s.source),
      dd: {
        catalyst: opportunity.signals[0]?.source || 'Multiple signals',
        thesis: _generateThesis(opportunity),
        entry_zone: quote?.price ? `${(quote.price * 0.98).toFixed(2)} - ${(quote.price * 1.02).toFixed(2)}` : 'TBD',
        target: null, // To be filled by deeper analysis
        stop: null,
      },
      currentPrice: quote?.price || null,
      lastUpdated: new Date().toISOString(),
    };

    watchlist.symbols.push(entry);
    console.log(`  ✓ Added to watchlist: ${symbol} (score: ${opportunity.score}, signals: ${entry.signals.join(', ')})`);
  }

  saveWatchlist(watchlist);
  return watchlist;
}

/**
 * Generate simple thesis from opportunity signals
 */
function _generateThesis(opportunity) {
  const signals = opportunity.signals.map(s => s.source);
  const catalysts = [];

  if (signals.includes('Earnings Soon')) catalysts.push('Upcoming earnings');
  if (signals.includes('Top Gainer')) catalysts.push('Strong momentum');
  if (signals.includes('Social Trending')) catalysts.push('Social buzz');
  if (signals.includes('Insider Buying')) catalysts.push('Insider confidence');
  if (signals.includes('Unusual Volume')) catalysts.push('Volume breakout');

  return catalysts.length > 0 ? catalysts.join(' + ') : 'Multi-signal convergence';
}

/**
 * Remove stale entries (on watchlist > 30 days with no entry)
 */
function removeStale() {
  const watchlist = loadWatchlist();
  const now = new Date();
  const originalCount = watchlist.symbols.length;

  watchlist.symbols = watchlist.symbols.filter(entry => {
    const addedDate = new Date(entry.addedDate);
    const daysSinceAdded = Math.floor((now - addedDate) / 86400000);

    if (daysSinceAdded > STALE_DAYS) {
      console.log(`  Removing stale entry: ${entry.symbol} (${daysSinceAdded} days old)`);
      return false;
    }
    return true;
  });

  const removed = originalCount - watchlist.symbols.length;

  if (removed > 0) {
    saveWatchlist(watchlist);
    console.log(`✅ Removed ${removed} stale watchlist entries.`);
  }

  return { removed, remaining: watchlist.symbols.length };
}

/**
 * Auto-add opportunities from research dispatcher
 * Returns count of added symbols
 */
async function autoAddFromResearch(opportunities) {
  const added = [];

  for (const opp of opportunities) {
    if (opp.score >= AUTO_ADD_SCORE_THRESHOLD) {
      await addSymbol(opp.symbol, opp);
      added.push(opp.symbol);
    }
  }

  return added;
}

/**
 * Enrich watchlist with latest data (price, volume, catalyst updates)
 */
async function enrichWatchlist() {
  const watchlist = loadWatchlist();
  let updated = 0;

  for (const entry of watchlist.symbols) {
    try {
      const quote = await dataLayer.getQuote(entry.symbol);
      if (quote?.price) {
        entry.currentPrice = quote.price;
        entry.volume = quote.volume;
        entry.change = quote.change;
        entry.changePct = quote.changePct;
        updated++;
      }

      // Update entry zone based on current price
      if (quote?.price && !entry.dd.entry_zone.includes(quote.price.toFixed(2))) {
        entry.dd.entry_zone = `${(quote.price * 0.98).toFixed(2)} - ${(quote.price * 1.02).toFixed(2)}`;
      }

      entry.lastUpdated = new Date().toISOString();
    } catch (e) {
      console.warn(`Could not enrich ${entry.symbol}:`, e.message);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  if (updated > 0) {
    saveWatchlist(watchlist);
    console.log(`✅ Enriched ${updated} watchlist entries with latest data.`);
  }

  return { updated, total: watchlist.symbols.length };
}

/**
 * Get watchlist for swing scanner (sorted by score)
 */
function getWatchlistForScanner() {
  const watchlist = loadWatchlist();
  return watchlist.symbols.sort((a, b) => b.score - a.score);
}

/**
 * Format watchlist for Discord
 */
function formatWatchlistForDiscord() {
  const watchlist = loadWatchlist();

  if (watchlist.symbols.length === 0) {
    return '📋 **RESEARCH WATCHLIST**\nNo symbols on watchlist yet.';
  }

  let msg = `📋 **RESEARCH WATCHLIST** (${watchlist.symbols.length} symbols)\n\n`;

  const sorted = watchlist.symbols.sort((a, b) => b.score - a.score);

  msg += '```\n';
  msg += 'Symbol  Score  Price     Entry Zone       Catalyst\n';
  msg += '──────  ─────  ────────  ───────────────  ────────────────────\n';

  for (const entry of sorted.slice(0, 15)) {
    const price = entry.currentPrice ? `$${entry.currentPrice.toFixed(2)}` : 'N/A';
    const entryZone = entry.dd.entry_zone || 'TBD';
    const catalyst = entry.dd.catalyst.substring(0, 20);

    msg += `${entry.symbol.padEnd(8)} ${String(entry.score).padEnd(6)} ${price.padEnd(9)} ${entryZone.padEnd(16)} ${catalyst}\n`;
  }

  msg += '```\n';

  return msg;
}

/**
 * Merge with manual watchlist from swing_options (legacy support)
 */
function mergeWithManualWatchlist() {
  try {
    const manualWatchlist = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
    const researchWatchlist = loadWatchlist();

    // Extract symbols from manual watchlist
    const manualSymbols = [
      ...(manualWatchlist.dickCapital || []).map(e => e.symbol),
      ...(manualWatchlist.independent || []).map(e => e.symbol),
    ];

    // Add manual symbols to research watchlist if not already present
    for (const symbol of manualSymbols) {
      const existing = researchWatchlist.symbols.find(s => s.symbol === symbol);
      if (!existing) {
        const manualEntry = [
          ...(manualWatchlist.dickCapital || []),
          ...(manualWatchlist.independent || []),
        ].find(e => e.symbol === symbol);

        if (manualEntry) {
          researchWatchlist.symbols.push({
            symbol,
            addedDate: new Date().toISOString().split('T')[0],
            source: 'manual',
            score: manualEntry.conviction === 'HIGH' ? 8 : 5,
            sourceCount: 1,
            signals: ['Manual'],
            dd: {
              catalyst: manualEntry.thesis || 'Manual entry',
              thesis: manualEntry.thesis || '',
              entry_zone: String(manualEntry.entryTarget || 'TBD'),
              target: manualEntry.ptLow || null,
              stop: null,
            },
            currentPrice: null,
            lastUpdated: new Date().toISOString(),
          });
        }
      }
    }

    saveWatchlist(researchWatchlist);
    console.log(`✅ Merged manual watchlist: ${researchWatchlist.symbols.length} total symbols.`);

    return researchWatchlist;
  } catch (e) {
    console.warn('Could not merge manual watchlist:', e.message);
    return loadWatchlist();
  }
}

module.exports = {
  loadWatchlist,
  saveWatchlist,
  addSymbol,
  removeStale,
  autoAddFromResearch,
  enrichWatchlist,
  getWatchlistForScanner,
  formatWatchlistForDiscord,
  mergeWithManualWatchlist,
  AUTO_ADD_SCORE_THRESHOLD,
};
