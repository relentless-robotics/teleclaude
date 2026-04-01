/**
 * Research Pick Tracker — Self-Learning Feedback Loop
 *
 * Tracks every research pick's performance over 1/3/5/7 days.
 * Calculates which signal types are most predictive.
 * Adjusts signal weights based on historical accuracy.
 *
 * Storage: trading_agents/data/research_picks.json
 */

const fs = require('fs');
const path = require('path');
const dataLayer = require('./data_layer');

const PICKS_FILE = path.join(__dirname, '..', 'data', 'research_picks.json');

/**
 * Load picks database
 */
function loadPicks() {
  try {
    if (fs.existsSync(PICKS_FILE)) {
      return JSON.parse(fs.readFileSync(PICKS_FILE, 'utf8'));
    }
  } catch (e) { /* fresh start */ }
  return {
    picks: [],
    signalStats: {},  // { signalType: { total, wins1d, wins3d, wins5d, wins7d, avgReturn1d, ... } }
    lastUpdated: null,
  };
}

/**
 * Save picks database
 */
function savePicks(db) {
  db.lastUpdated = new Date().toISOString();
  const dir = path.dirname(PICKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PICKS_FILE, JSON.stringify(db, null, 2));
}

/**
 * Record new research picks from a dispatcher run
 */
function recordPicks(opportunities) {
  const db = loadPicks();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  for (const opp of opportunities) {
    // Don't duplicate picks from same day
    const existing = db.picks.find(p =>
      p.symbol === opp.symbol && p.date === today
    );
    if (existing) continue;

    db.picks.push({
      symbol: opp.symbol,
      date: today,
      timestamp: now,
      priceAtPick: opp.quote?.price || null,
      score: opp.score,
      sourceCount: opp.sourceCount,
      signals: opp.signals.map(s => s.source),
      signalDetails: opp.signals,
      // Performance will be filled in by updatePerformance()
      performance: {
        day1: null,
        day3: null,
        day5: null,
        day7: null,
      },
      status: 'tracking', // tracking | completed
    });
  }

  savePicks(db);
  return db.picks.filter(p => p.date === today).length;
}

/**
 * Get current price for a symbol via unified data layer (Alpaca primary, Yahoo fallback)
 */
async function getCurrentPrice(symbol) {
  try {
    const quote = await dataLayer.getQuote(symbol);
    const price = quote?.price || null;

    // Validate price is reasonable (not null, not 0, not extreme)
    if (price && price > 0 && price < 1e6) {
      return price;
    }

    console.warn(`⚠️ Invalid price for ${symbol}: ${price}`);
    return null;
  } catch (e) {
    console.warn(`⚠️ Error fetching price for ${symbol}:`, e.message);
    return null;
  }
}

/**
 * Update performance for all tracking picks
 * Should be called daily (by after-hours agent or scheduler)
 */
async function updatePerformance() {
  const db = loadPicks();
  const now = new Date();
  const updated = { checked: 0, updated: 0, completed: 0 };

  // Get all symbols that need price checks
  const trackingPicks = db.picks.filter(p => p.status === 'tracking' && p.priceAtPick);
  const symbolsNeeded = [...new Set(trackingPicks.map(p => p.symbol))];

  // Fetch current prices
  const prices = {};
  const batches = [];
  for (let i = 0; i < symbolsNeeded.length; i += 5) {
    batches.push(symbolsNeeded.slice(i, i + 5));
  }
  for (const batch of batches) {
    const results = await Promise.all(batch.map(s => getCurrentPrice(s)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) prices[batch[j]] = results[j];
    }
    if (batches.indexOf(batch) < batches.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Update each pick
  for (const pick of trackingPicks) {
    const currentPrice = prices[pick.symbol];
    if (!currentPrice) continue;

    const pickDate = new Date(pick.date + 'T16:00:00Z'); // Assume picked at close
    const daysSince = Math.floor((now - pickDate) / (86400000));
    const returnPct = ((currentPrice - pick.priceAtPick) / pick.priceAtPick * 100);

    // Sanity check: flag impossible returns
    if (Math.abs(returnPct) > 50 && daysSince < 7) {
      console.warn(`⚠️ PICK TRACKER: Suspicious return for ${pick.symbol}: ${returnPct.toFixed(2)}% in ${daysSince} days (entry: $${pick.priceAtPick}, current: $${currentPrice}). Possible bad price data.`);
      // Skip updating this pick until price data is verified
      continue;
    }

    // Additional validation: reject extreme single-day moves (likely bad data)
    if (daysSince === 1 && Math.abs(returnPct) > 30) {
      console.warn(`⚠️ PICK TRACKER: Rejecting extreme 1-day return for ${pick.symbol}: ${returnPct.toFixed(2)}%. Likely bad price data. Skipping.`);
      continue;
    }

    updated.checked++;

    if (daysSince >= 1 && pick.performance.day1 === null) {
      pick.performance.day1 = parseFloat(returnPct.toFixed(2));
      updated.updated++;
    }
    if (daysSince >= 3 && pick.performance.day3 === null) {
      pick.performance.day3 = parseFloat(returnPct.toFixed(2));
      updated.updated++;
    }
    if (daysSince >= 5 && pick.performance.day5 === null) {
      pick.performance.day5 = parseFloat(returnPct.toFixed(2));
      updated.updated++;
    }
    if (daysSince >= 7 && pick.performance.day7 === null) {
      pick.performance.day7 = parseFloat(returnPct.toFixed(2));
      updated.updated++;
      pick.status = 'completed';
      updated.completed++;
    }
  }

  // Recalculate signal stats
  _recalcSignalStats(db);

  savePicks(db);
  return updated;
}

/**
 * Recalculate signal performance statistics
 */
function _recalcSignalStats(db) {
  const stats = {};
  const completedPicks = db.picks.filter(p => p.performance.day1 !== null);

  for (const pick of completedPicks) {
    for (const signal of pick.signals) {
      if (!stats[signal]) {
        stats[signal] = {
          total: 0,
          wins1d: 0, wins3d: 0, wins5d: 0, wins7d: 0,
          totalReturn1d: 0, totalReturn3d: 0, totalReturn5d: 0, totalReturn7d: 0,
        };
      }
      const s = stats[signal];
      s.total++;

      if (pick.performance.day1 !== null) {
        s.totalReturn1d += pick.performance.day1;
        if (pick.performance.day1 > 0) s.wins1d++;
      }
      if (pick.performance.day3 !== null) {
        s.totalReturn3d += pick.performance.day3;
        if (pick.performance.day3 > 0) s.wins3d++;
      }
      if (pick.performance.day5 !== null) {
        s.totalReturn5d += pick.performance.day5;
        if (pick.performance.day5 > 0) s.wins5d++;
      }
      if (pick.performance.day7 !== null) {
        s.totalReturn7d += pick.performance.day7;
        if (pick.performance.day7 > 0) s.wins7d++;
      }
    }
  }

  // Calculate averages and win rates
  for (const [signal, s] of Object.entries(stats)) {
    const t = s.total || 1;
    stats[signal] = {
      ...s,
      winRate1d: Math.round(s.wins1d / t * 100),
      winRate3d: Math.round(s.wins3d / t * 100),
      winRate7d: Math.round(s.wins7d / t * 100),
      avgReturn1d: parseFloat((s.totalReturn1d / t).toFixed(2)),
      avgReturn3d: parseFloat((s.totalReturn3d / t).toFixed(2)),
      avgReturn7d: parseFloat((s.totalReturn7d / t).toFixed(2)),
      // Composite score: weighted avg of win rates
      predictiveScore: parseFloat((
        (s.wins1d / t * 0.2 + s.wins3d / t * 0.3 + s.wins7d / t * 0.5) * 100
      ).toFixed(1)),
    };
  }

  db.signalStats = stats;
}

/**
 * Get signal weights based on historical performance
 * Returns multipliers for each signal type
 */
function getSignalWeights() {
  const db = loadPicks();
  const weights = {};

  for (const [signal, stats] of Object.entries(db.signalStats)) {
    if (stats.total < 3) {
      weights[signal] = 1.0; // Not enough data, use default
    } else {
      // Scale weight by predictive score (50 = neutral, >50 = better, <50 = worse)
      weights[signal] = parseFloat(Math.max(0.3, Math.min(3.0, stats.predictiveScore / 50)).toFixed(2));
    }
  }

  return weights;
}

/**
 * Get performance report for Discord
 */
function getPerformanceReport() {
  const db = loadPicks();
  const recentPicks = db.picks.filter(p => p.performance.day1 !== null).slice(-20);

  if (recentPicks.length === 0) {
    return { picks: [], signalStats: {}, summary: 'No completed picks yet. Tracking will begin after first full trading day.' };
  }

  // Overall stats
  const withDay1 = recentPicks.filter(p => p.performance.day1 !== null);
  const withDay7 = recentPicks.filter(p => p.performance.day7 !== null);

  const summary = {
    totalTracked: db.picks.length,
    completed: db.picks.filter(p => p.status === 'completed').length,
    tracking: db.picks.filter(p => p.status === 'tracking').length,
    overallWinRate1d: withDay1.length > 0 ?
      Math.round(withDay1.filter(p => p.performance.day1 > 0).length / withDay1.length * 100) + '%' : 'N/A',
    overallWinRate7d: withDay7.length > 0 ?
      Math.round(withDay7.filter(p => p.performance.day7 > 0).length / withDay7.length * 100) + '%' : 'N/A',
    avgReturn1d: withDay1.length > 0 ?
      (withDay1.reduce((s, p) => s + p.performance.day1, 0) / withDay1.length).toFixed(2) + '%' : 'N/A',
    avgReturn7d: withDay7.length > 0 ?
      (withDay7.reduce((s, p) => s + p.performance.day7, 0) / withDay7.length).toFixed(2) + '%' : 'N/A',
  };

  // Best and worst performing signals
  const signalRanking = Object.entries(db.signalStats)
    .filter(([_, s]) => s.total >= 3)
    .sort((a, b) => b[1].predictiveScore - a[1].predictiveScore);

  return {
    picks: recentPicks.slice(-10),
    signalStats: db.signalStats,
    signalRanking,
    summary,
  };
}

/**
 * Format performance report for Discord
 */
function formatReportForDiscord() {
  const report = getPerformanceReport();

  if (report.picks.length === 0) {
    return `📈 **RESEARCH PICK TRACKER**\n${report.summary}`;
  }

  let msg = `📈 **RESEARCH PICK TRACKER**\n`;
  msg += `Tracked: ${report.summary.totalTracked} | Completed: ${report.summary.completed} | Active: ${report.summary.tracking}\n`;
  msg += `Win Rate (1d): ${report.summary.overallWinRate1d} | (7d): ${report.summary.overallWinRate7d}\n`;
  msg += `Avg Return (1d): ${report.summary.avgReturn1d} | (7d): ${report.summary.avgReturn7d}\n\n`;

  // Signal ranking
  if (report.signalRanking.length > 0) {
    msg += '**Signal Predictiveness:**\n```\n';
    msg += 'Signal               Score  WR-1d  WR-7d  Avg-7d  N\n';
    msg += '───────────────────  ─────  ─────  ─────  ──────  ──\n';
    for (const [signal, stats] of report.signalRanking.slice(0, 10)) {
      msg += `${signal.padEnd(20)} ${String(stats.predictiveScore).padEnd(6)} ${String(stats.winRate1d + '%').padEnd(6)} ${String(stats.winRate7d + '%').padEnd(6)} ${String(stats.avgReturn7d + '%').padEnd(7)} ${stats.total}\n`;
    }
    msg += '```\n';
  }

  // Recent picks
  msg += '**Recent Picks:**\n```\n';
  msg += 'Date        Sym    Entry    1d%    3d%    7d%\n';
  msg += '──────────  ─────  ───────  ─────  ─────  ─────\n';
  for (const pick of report.picks.slice(-8)) {
    const d1 = pick.performance.day1 !== null ? `${pick.performance.day1 > 0 ? '+' : ''}${pick.performance.day1}%` : '...';
    const d3 = pick.performance.day3 !== null ? `${pick.performance.day3 > 0 ? '+' : ''}${pick.performance.day3}%` : '...';
    const d7 = pick.performance.day7 !== null ? `${pick.performance.day7 > 0 ? '+' : ''}${pick.performance.day7}%` : '...';
    msg += `${pick.date}  ${pick.symbol.padEnd(6)} $${(pick.priceAtPick || 0).toFixed(0).padEnd(6)} ${d1.padEnd(6)} ${d3.padEnd(6)} ${d7}\n`;
  }
  msg += '```\n';

  return msg;
}

/**
 * Cleanup corrupted data - remove picks with impossible returns
 * Returns count of removed picks
 */
function cleanupCorruptedData() {
  const db = loadPicks();
  const originalCount = db.picks.length;

  // Remove picks with impossible returns (>50% in <7 days or >30% in 1 day)
  db.picks = db.picks.filter(pick => {
    const daysSince = Math.floor((new Date() - new Date(pick.date + 'T16:00:00Z')) / 86400000);

    // Check day1 return
    if (pick.performance.day1 !== null) {
      if (Math.abs(pick.performance.day1) > 30) {
        console.log(`Removing corrupted pick: ${pick.symbol} ${pick.date} (day1: ${pick.performance.day1}%)`);
        return false;
      }
    }

    // Check all returns for extreme values
    const returns = [pick.performance.day1, pick.performance.day3, pick.performance.day5, pick.performance.day7];
    for (let i = 0; i < returns.length; i++) {
      const ret = returns[i];
      const days = [1, 3, 5, 7][i];
      if (ret !== null && Math.abs(ret) > 50 && days < 7) {
        console.log(`Removing corrupted pick: ${pick.symbol} ${pick.date} (day${days}: ${ret}%)`);
        return false;
      }
    }

    return true;
  });

  const removed = originalCount - db.picks.length;

  if (removed > 0) {
    // Recalculate stats after cleanup
    _recalcSignalStats(db);
    savePicks(db);
    console.log(`✅ Cleaned up ${removed} corrupted picks. ${db.picks.length} picks remaining.`);
  } else {
    console.log('✅ No corrupted picks found.');
  }

  return { originalCount, removed, remaining: db.picks.length };
}

async function run() {
  return updatePerformance();
}

module.exports = {
  run,
  recordPicks,
  updatePerformance,
  getSignalWeights,
  getPerformanceReport,
  formatReportForDiscord,
  loadPicks,
  cleanupCorruptedData,
};
