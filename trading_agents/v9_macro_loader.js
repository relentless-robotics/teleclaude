/**
 * V9 MacroStrategy Alpha Loader
 *
 * Reads macro_alpha_scores.json (exported by MacroStrategy/export_predictions_json.py)
 * and writes the alpha scores into the shared brain for use by trading agents.
 *
 * Can be run standalone (node v9_macro_loader.js) or imported as a module.
 *
 * Scheduling: Run this after each V9 model prediction export, or at least once
 * before market open. Scores are valid for ~30 days (staleDays field in JSON).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ALPHA_FILE = path.join(DATA_DIR, 'macro_alpha_scores.json');
const STALE_DAYS_DEFAULT = 30;

/**
 * Load macro alpha scores from JSON file.
 * Returns null if file missing or stale.
 *
 * @param {object} options
 * @param {number} options.staleDays - Override staleness threshold (default: from file or 30)
 * @param {boolean} options.allowStale - If true, return data even if stale (with warning flag)
 * @returns {object|null} Alpha data or null
 */
function loadMacroAlpha(options = {}) {
  if (!fs.existsSync(ALPHA_FILE)) {
    console.warn('[V9Loader] macro_alpha_scores.json not found. Run MacroStrategy/export_predictions_json.py first.');
    return null;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(ALPHA_FILE, 'utf8'));
  } catch (e) {
    console.error('[V9Loader] Failed to parse macro_alpha_scores.json:', e.message);
    return null;
  }

  // Check staleness
  const staleDays = options.staleDays || data.staleDays || STALE_DAYS_DEFAULT;
  const generatedAt = new Date(data.generatedAt);
  const now = new Date();
  const ageDays = (now - generatedAt) / (1000 * 60 * 60 * 24);

  if (ageDays > staleDays && !options.allowStale) {
    console.warn(`[V9Loader] Predictions are ${ageDays.toFixed(1)} days old (stale threshold: ${staleDays}d). Skipping.`);
    return null;
  }

  data._freshness = {
    ageDays: Math.round(ageDays * 10) / 10,
    isStale: ageDays > staleDays,
    staleDays,
    generatedAt: data.generatedAt,
    predictionDate: data.predictionDate,
  };

  return data;
}

/**
 * Get alpha score for a specific symbol.
 *
 * @param {object} alphaData - Data from loadMacroAlpha()
 * @param {string} symbol - Ticker symbol (e.g., 'AAPL')
 * @returns {object|null} { alpha, rank, percentile, quintile, sectorGroup } or null
 */
function getSymbolAlpha(alphaData, symbol) {
  if (!alphaData || !alphaData.scores) return null;
  return alphaData.scores[symbol] || null;
}

/**
 * Get alpha scores for multiple symbols.
 *
 * @param {object} alphaData - Data from loadMacroAlpha()
 * @param {string[]} symbols - Array of ticker symbols
 * @returns {object} { symbol: { alpha, rank, ... } | null }
 */
function getMultipleAlpha(alphaData, symbols) {
  const result = {};
  for (const sym of symbols) {
    result[sym] = getSymbolAlpha(alphaData, sym);
  }
  return result;
}

/**
 * Format alpha data for LLM consumption.
 * Returns a concise string suitable for embedding in an LLM prompt.
 *
 * @param {object} alphaData - Data from loadMacroAlpha()
 * @param {string[]} symbols - Optional: only include these symbols
 * @returns {string} Formatted alpha summary for LLM
 */
function formatForLLM(alphaData, symbols = null) {
  if (!alphaData || !alphaData.scores) {
    return 'MacroStrategy V9 alpha scores: NOT AVAILABLE (no predictions loaded)';
  }

  const freshness = alphaData._freshness || {};
  const isStale = freshness.isStale;
  const age = freshness.ageDays || '?';

  let lines = [];
  lines.push(`MACROSTRATEGY V9 ALPHA SCORES (prediction date: ${alphaData.predictionDate}, age: ${age}d${isStale ? ' **STALE**' : ''}):`);
  lines.push(`What this means: V9 is a walk-forward ML model predicting 10-day forward returns (blended with 5d/21d/63d horizons). Positive alpha = expected outperformance. Top quintile (Q1) = strong long bias. Bottom quintile (Q5) = avoid.`);
  lines.push('');

  // If specific symbols requested, show those
  if (symbols && symbols.length > 0) {
    lines.push('Scores for your symbols:');
    for (const sym of symbols) {
      const s = alphaData.scores[sym];
      if (s) {
        lines.push(`  ${sym}: alpha=${s.alpha > 0 ? '+' : ''}${s.alpha.toFixed(4)} | rank ${s.rank}/${s.totalRanked} (Q${s.quintile}) | ${s.sectorGroup}`);
      } else {
        lines.push(`  ${sym}: not in V9 universe`);
      }
    }
    lines.push('');
  }

  // Always show top 10 and bottom 5
  lines.push('TOP 10 ALPHA (strongest longs):');
  for (const pick of (alphaData.topPicks || []).slice(0, 10)) {
    lines.push(`  #${pick.rank} ${pick.symbol}: alpha=${pick.alpha > 0 ? '+' : ''}${pick.alpha.toFixed(4)} (${pick.sectorGroup})`);
  }

  lines.push('');
  lines.push('BOTTOM 5 ALPHA (avoid/short candidates):');
  for (const pick of (alphaData.bottomPicks || []).slice(0, 5)) {
    lines.push(`  #${pick.rank} ${pick.symbol}: alpha=${pick.alpha > 0 ? '+' : ''}${pick.alpha.toFixed(4)} (${pick.sectorGroup})`);
  }

  // Model confidence summary
  if (alphaData.metadata?.modelConfidence) {
    lines.push('');
    lines.push('Model confidence (avg cross-validated IC):');
    const mc = alphaData.metadata.modelConfidence;
    const reliable = Object.entries(mc).filter(([, v]) => v.reliable).map(([k, v]) => `${k}(IC=${v.avgIC})`);
    const weak = Object.entries(mc).filter(([, v]) => !v.reliable).map(([k, v]) => `${k}(IC=${v.avgIC})`);
    if (reliable.length > 0) lines.push(`  Reliable: ${reliable.join(', ')}`);
    if (weak.length > 0) lines.push(`  Weak: ${weak.join(', ')}`);
  }

  // Best combo performance
  if (alphaData.metadata?.bestCombo) {
    const bc = alphaData.metadata.bestCombo;
    lines.push('');
    lines.push(`Best backtest combo: ${bc.model}+${bc.execution} -> ${bc.return} return, ${bc.sharpe} Sharpe, ${bc.maxDD} max DD (vs SPY ${bc.vsSPY})`);
    lines.push('CAUTION: Backtest performance includes execution configs tuned on the same holdout period. Real performance will be lower.');
  }

  // Model performance context (from model_info if available)
  if (alphaData.model_info) {
    const mi = alphaData.model_info;
    lines.push('');
    lines.push('--- MODEL PERFORMANCE CONTEXT ---');
    lines.push(`Version: ${mi.version} | OOS Period: ${mi.oos_period} | Best Combo: ${mi.best_combo}`);

    if (mi.execution_metrics) {
      const em = mi.execution_metrics;
      lines.push(`OOS Backtest: ${em.oos_return} return, ${em.sharpe} Sharpe, ${em.max_drawdown} max DD (vs SPY ${em.vs_spy})`);
      lines.push(`Monthly: ${em.avg_monthly_return}% avg return, ${em.monthly_win_rate}% win rate, ${em.positive_months}W/${em.negative_months}L`);
    }

    if (mi.raw_model_metrics) {
      const reliable = Object.entries(mi.raw_model_metrics)
        .filter(([, v]) => v.reliable)
        .map(([k, v]) => `${k}(IC=${v.cv_ic_avg.toFixed(4)})`);
      if (reliable.length > 0) {
        lines.push(`Reliable models (IC>0.01): ${reliable.join(', ')}`);
      }
    }

    if (mi.feature_selection) {
      lines.push(`Features: ${mi.feature_selection.selected}/${mi.feature_selection.total_candidates} selected`);
    }

    lines.push('AUDIT: All known leakage vectors fixed. Execution configs frozen with hash integrity check.');
  }

  // Limitations
  lines.push('');
  lines.push('IMPORTANT: V9 alpha is a TILT, not a binary signal. Use it to weight your conviction on existing setups. Monthly horizon = best for swing trades.');

  return lines.join('\n');
}

/**
 * Write macro alpha scores into the shared brain.
 *
 * @param {object} brain - SharedBrain instance
 * @param {object} alphaData - Data from loadMacroAlpha()
 */
function writeToSharedBrain(brain, alphaData) {
  if (!brain || !alphaData) return;

  brain.writeMacroAlpha({
    version: alphaData.version,
    predictionDate: alphaData.predictionDate,
    generatedAt: alphaData.generatedAt,
    freshness: alphaData._freshness,
    topPicks: alphaData.topPicks,
    bottomPicks: alphaData.bottomPicks,
    metadata: {
      featureCount: alphaData.metadata?.featureCount,
      universeSize: alphaData.metadata?.universeSize,
      bestCombo: alphaData.metadata?.bestCombo,
    },
    // Full model performance context for LLM agents
    modelInfo: alphaData.model_info || null,
    // Include full scores so agents can look up any symbol
    scores: alphaData.scores,
  });

  console.log(`[V9Loader] Wrote ${Object.keys(alphaData.scores).length} alpha scores to shared brain`);
}

/**
 * Full load-and-write pipeline. Call this at startup or on schedule.
 *
 * @param {object} brain - SharedBrain instance (optional, will require() if not provided)
 * @returns {object|null} The loaded alpha data, or null if unavailable
 */
function loadAndWrite(brain = null) {
  const alphaData = loadMacroAlpha();
  if (!alphaData) return null;

  if (!brain) {
    try {
      brain = require('./shared_brain');
    } catch (e) {
      console.warn('[V9Loader] Could not load shared_brain:', e.message);
      return alphaData; // Return data even without brain
    }
  }

  writeToSharedBrain(brain, alphaData);
  return alphaData;
}

// ============================================================================
// Standalone execution
// ============================================================================
if (require.main === module) {
  console.log('='.repeat(70));
  console.log('V9 MacroStrategy Alpha Loader - Standalone Mode');
  console.log('='.repeat(70));

  const alphaData = loadMacroAlpha({ allowStale: true });
  if (!alphaData) {
    console.error('\nNo alpha data available. Run export_predictions_json.py in MacroStrategy first.');
    process.exit(1);
  }

  const f = alphaData._freshness;
  console.log(`\nPrediction date: ${f.predictionDate}`);
  console.log(`Generated: ${f.generatedAt}`);
  console.log(`Age: ${f.ageDays} days ${f.isStale ? '(STALE!)' : '(fresh)'}`);
  console.log(`Universe: ${Object.keys(alphaData.scores).length} symbols`);

  console.log('\nTop 10 picks:');
  for (const pick of alphaData.topPicks) {
    console.log(`  #${pick.rank} ${pick.symbol.padEnd(6)} alpha=${pick.alpha > 0 ? '+' : ''}${pick.alpha.toFixed(4)}  (${pick.sectorGroup})`);
  }

  console.log('\nBottom 5:');
  for (const pick of alphaData.bottomPicks.slice(0, 5)) {
    console.log(`  #${pick.rank} ${pick.symbol.padEnd(6)} alpha=${pick.alpha > 0 ? '+' : ''}${pick.alpha.toFixed(4)}  (${pick.sectorGroup})`);
  }

  // Write to shared brain
  try {
    const brain = require('./shared_brain');
    writeToSharedBrain(brain, alphaData);
    console.log('\nSuccessfully wrote to shared brain.');
  } catch (e) {
    console.warn('\nCould not write to shared brain:', e.message);
  }

  console.log('\nLLM-formatted output:');
  console.log('-'.repeat(70));
  console.log(formatForLLM(alphaData));
  console.log('='.repeat(70));
}

module.exports = {
  loadMacroAlpha,
  getSymbolAlpha,
  getMultipleAlpha,
  formatForLLM,
  writeToSharedBrain,
  loadAndWrite,
  ALPHA_FILE,
};
