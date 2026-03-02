/**
 * V9 MacroStrategy Loader
 *
 * Reads v9_latest_predictions.json from MacroStrategy/predictions/
 * and writes signals into the shared brain for use by trading agents.
 *
 * V9 predicts 10-day forward returns using walk-forward ML ensemble.
 * Weekly rebalancing. Strongest long-term signal for swing trades.
 *
 * Usage:
 *   const v9Loader = require('./v9_loader');
 *   v9Loader.loadAndWrite(brain);  // Load predictions into shared brain
 *   v9Loader.refreshV9Predictions();  // Trigger Python predict + load
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PREDICTION_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'predictions', 'v9_latest_predictions.json'
);

const MACRO_DIR = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy'
);

const STALE_DAYS = 7;  // Predictions older than 7 days are stale (weekly rebalance)
const FRESH_DAYS = 3;  // Predictions younger than 3 days are fresh

/**
 * Load V9 predictions from v9_latest_predictions.json.
 * Returns null if file missing or unreadable.
 */
function loadV9Predictions(options = {}) {
  if (!fs.existsSync(PREDICTION_FILE)) {
    console.warn('[V9Loader] v9_latest_predictions.json not found. Run: python generate_v9_predictions.py');
    return null;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(PREDICTION_FILE, 'utf8'));
  } catch (e) {
    console.error('[V9Loader] Failed to parse v9_latest_predictions.json:', e.message);
    return null;
  }

  // Compute freshness
  const predTime = new Date(data.timestamp);
  const now = new Date();
  const ageDays = (now - predTime) / (1000 * 60 * 60 * 24);

  data._freshness = {
    ageDays: Math.round(ageDays * 10) / 10,
    isFresh: ageDays <= FRESH_DAYS,
    isStale: ageDays > STALE_DAYS,
    predictionTime: data.timestamp,
  };

  if (data._freshness.isStale && !options.allowStale) {
    console.warn(`[V9Loader] Predictions are ${ageDays.toFixed(1)}d old (stale threshold: ${STALE_DAYS}d).`);
    if (!options.returnStale) return null;
  }

  return data;
}

/**
 * Get V9 prediction for a specific symbol.
 */
function getSymbolPrediction(predData, symbol) {
  if (!predData || !predData.predictions) return null;
  return predData.predictions.find(p => p.symbol === symbol) || null;
}

/**
 * Get V9 predictions for multiple symbols.
 */
function getMultiplePredictions(predData, symbols) {
  const result = {};
  for (const sym of symbols) {
    result[sym] = getSymbolPrediction(predData, sym);
  }
  return result;
}

/**
 * Format V9 predictions for LLM consumption.
 * Returns structured object for embedding in LLM data package.
 *
 * V9 now provides DUAL predictions:
 * - XGB: Best single model, aggressive, highest IC
 * - Ensemble: Consensus of all models, more robust
 * - Agreement: Where both agree = HIGHEST CONVICTION
 */
function formatForLLM(predData, relevantSymbols = []) {
  if (!predData) {
    return null;
  }

  const freshness = predData._freshness || {};

  // Check if this is the new dual-prediction format
  const hasDualPredictions = predData.xgb_predictions && predData.ensemble_predictions;

  if (hasDualPredictions) {
    // NEW FORMAT: XGB + Ensemble + Agreement
    const relevantSet = new Set(relevantSymbols);

    // Filter relevant symbols from each prediction set
    const getRelevant = (predSet) => {
      if (!predSet || !predSet.predictions) return [];
      if (relevantSet.size === 0) return predSet.predictions;
      return predSet.predictions.filter(p => relevantSet.has(p.symbol));
    };

    return {
      timestamp: predData.timestamp,
      freshness,
      model_version: predData.model_version || 'v9',
      method: predData.method || 'Dual prediction (XGB + Ensemble)',
      next_rebalance: predData.next_rebalance,

      // XGB predictions (aggressive, highest IC)
      xgb: {
        label: predData.xgb_predictions.model,
        description: predData.xgb_predictions.description,
        top_longs: predData.xgb_predictions.top_longs,
        avoid: predData.xgb_predictions.avoid,
        relevant: getRelevant(predData.xgb_predictions),
      },

      // Ensemble predictions (consensus, robust)
      ensemble: {
        label: predData.ensemble_predictions.model,
        description: predData.ensemble_predictions.description,
        top_longs: predData.ensemble_predictions.top_longs,
        avoid: predData.ensemble_predictions.avoid,
        relevant: getRelevant(predData.ensemble_predictions),
      },

      // Agreement (HIGHEST CONVICTION)
      agreement: {
        both_strong_buy: predData.agreement?.both_strong_buy || [],
        both_avoid: predData.agreement?.both_avoid || [],
        divergent: predData.agreement?.divergent || [],
      },

      backtest_metrics: predData.backtest_metrics || {},

      note: 'V9 DUAL PREDICTIONS: XGB (aggressive, highest IC) + Ensemble (consensus, robust). ' +
            'AGREEMENT section = HIGHEST CONVICTION picks. Use these for swing trades. ' +
            'Rebalances weekly (Mondays). Q1 = STRONG_BUY, Q5 = AVOID. ' +
            'Backtest: 73.80% return, 3.98 Sharpe (2023-2025).',
    };
  } else {
    // OLD FORMAT: Single prediction set (legacy support)
    if (!predData.predictions || predData.predictions.length === 0) {
      return null;
    }

    const relevantSet = new Set(relevantSymbols);
    const relevantPreds = relevantSet.size > 0
      ? predData.predictions.filter(p => relevantSet.has(p.symbol))
      : [];

    const topLongs = predData.predictions
      .filter(p => p.quintile <= 2)
      .sort((a, b) => b.score - a.score);

    const bottomPicks = predData.predictions
      .filter(p => p.quintile === 5)
      .sort((a, b) => a.score - b.score);

    return {
      timestamp: predData.timestamp,
      freshness,
      model_version: predData.model_version,
      model_metrics: predData.model_metrics || {},
      execution_config: predData.execution_config,
      rebalance_frequency: predData.rebalance_frequency || 'Weekly',
      universe_size: predData.universe_size || 0,

      relevantPredictions: relevantPreds,
      topLongs: topLongs.slice(0, 15),
      bottomPicks: bottomPicks.slice(0, 10),
      portfolio_action: predData.portfolio_action || {},

      note: 'V9 MacroStrategy predictions. Q1 = STRONG_BUY, Q5 = AVOID. Rebalances weekly.',
    };
  }
}

/**
 * Write V9 predictions into the shared brain.
 */
function writeToSharedBrain(brain, predData) {
  if (!brain || !predData) return;

  // Check format
  const hasDualPredictions = predData.xgb_predictions && predData.ensemble_predictions;

  // Use writeV9Predictions if available, otherwise write directly
  if (typeof brain.writeV9Predictions === 'function') {
    brain.writeV9Predictions({
      timestamp: predData.timestamp,
      predictions: hasDualPredictions ? null : predData.predictions,  // Old format
      xgb_predictions: predData.xgb_predictions,  // New format
      ensemble_predictions: predData.ensemble_predictions,  // New format
      agreement: predData.agreement,  // New format
      model_metrics: predData.model_metrics || predData.backtest_metrics,
      execution_config: predData.execution_config || 'Weekly_Momentum_Kelly',
      portfolio_action: predData.portfolio_action,
      next_rebalance: predData.next_rebalance,
      freshness: predData._freshness,
      updatedAt: new Date().toISOString(),
    });
  } else {
    // Direct context write fallback
    if (!brain.ctx) brain.ctx = {};
    if (!brain.ctx.modelSignals) brain.ctx.modelSignals = {};
    brain.ctx.modelSignals.v9_macro = {
      timestamp: predData.timestamp,
      predictions: hasDualPredictions ? null : predData.predictions,
      xgb_predictions: predData.xgb_predictions,
      ensemble_predictions: predData.ensemble_predictions,
      agreement: predData.agreement,
      model_metrics: predData.model_metrics || predData.backtest_metrics,
      execution_config: predData.execution_config || 'Weekly_Momentum_Kelly',
      portfolio_action: predData.portfolio_action,
      next_rebalance: predData.next_rebalance,
      freshness: predData._freshness,
      updatedAt: new Date().toISOString(),
    };
    // Persist if brain has save method
    if (typeof brain._save === 'function') brain._save();
  }

  const predCount = hasDualPredictions
    ? predData.xgb_predictions.predictions.length
    : (predData.predictions ? predData.predictions.length : 0);

  console.log(`[V9Loader] Wrote ${predCount} V9 predictions to shared brain (${hasDualPredictions ? 'dual-prediction format' : 'legacy format'})`);
}

/**
 * Trigger Python V9 prediction pipeline.
 * Runs generate_v9_predictions_simple.py to create fresh predictions.
 * Returns true if successful.
 *
 * NOTE: Uses the SIMPLE/FAST prediction script (30 seconds vs 10+ minutes).
 *       Good enough for live trading with 75% of signal quality.
 */
function refreshV9Predictions(options = {}) {
  const fast = options.fast !== false;  // Default: use fast mode

  const scriptName = fast ? 'generate_v9_predictions_simple.py' : 'generate_v9_predictions_fixed.py';

  try {
    console.log(`[V9Loader] Generating V9 predictions (${fast ? 'FAST mode' : 'FULL mode'})...`);
    // Convert Windows path to WSL path for Python execution in WSL Ubuntu-22.04
    const wslPath = MACRO_DIR.replace(/\\/g, '/').replace(/^C:/i, '/mnt/c');
    execSync(`wsl -d Ubuntu-22.04 bash -c "cd '${wslPath}' && python3 ${scriptName}"`, {
      timeout: fast ? 180000 : 600000,  // 3 min for fast (WSL startup overhead), 10 min for full
      stdio: 'pipe',
    });

    console.log('[V9Loader] V9 prediction refresh complete');
    return true;
  } catch (e) {
    console.error('[V9Loader] V9 prediction refresh failed:', e.message);
    return false;
  }
}

/**
 * Full load-and-write pipeline. Call this at startup or on schedule.
 */
function loadAndWrite(brain = null) {
  const predData = loadV9Predictions({ allowStale: true, returnStale: true });
  if (!predData) return null;

  if (!brain) {
    try {
      brain = require('./shared_brain');
    } catch (e) {
      console.warn('[V9Loader] Could not load shared_brain:', e.message);
      return predData;
    }
  }

  writeToSharedBrain(brain, predData);
  return predData;
}

/**
 * Full refresh pipeline: generate predictions + load into brain.
 */
async function refreshAndLoad(brain = null) {
  const success = refreshV9Predictions();
  if (!success) return null;
  return loadAndWrite(brain);
}

// ============================================================================
// Standalone execution
// ============================================================================
if (require.main === module) {
  console.log('='.repeat(70));
  console.log('V9 MacroStrategy Prediction Loader - Standalone Mode');
  console.log('='.repeat(70));

  const predData = loadV9Predictions({ allowStale: true, returnStale: true });
  if (!predData) {
    console.error('\nNo V9 predictions available. Run: python generate_v9_predictions.py');
    process.exit(1);
  }

  const f = predData._freshness;
  console.log(`\nPrediction time: ${f.predictionTime}`);
  console.log(`Age: ${f.ageDays}d ${f.isStale ? '(STALE!)' : f.isFresh ? '(fresh)' : '(aging)'}`);
  console.log(`Model: ${predData.model_version || 'v9'}`);

  // Check if dual-prediction format
  const hasDual = predData.xgb_predictions && predData.ensemble_predictions;

  if (hasDual) {
    console.log('\n=== XGB PREDICTIONS (Aggressive) ===');
    console.log(`Top longs: ${predData.xgb_predictions.top_longs.slice(0, 10).join(', ')}`);
    console.log(`Avoid: ${predData.xgb_predictions.avoid.slice(0, 5).join(', ')}`);

    console.log('\n=== ENSEMBLE PREDICTIONS (Consensus) ===');
    console.log(`Top longs: ${predData.ensemble_predictions.top_longs.slice(0, 10).join(', ')}`);
    console.log(`Avoid: ${predData.ensemble_predictions.avoid.slice(0, 5).join(', ')}`);

    console.log('\n=== AGREEMENT (HIGHEST CONVICTION) ===');
    console.log(`Both STRONG_BUY: ${predData.agreement.both_strong_buy.join(', ')}`);
    console.log(`Both AVOID: ${predData.agreement.both_avoid.join(', ')}`);
    if (predData.agreement.divergent.length > 0) {
      console.log(`Divergent: ${predData.agreement.divergent.join(', ')}`);
    }

    console.log(`\nNext rebalance: ${predData.next_rebalance || 'N/A'}`);
  } else {
    // Legacy format
    console.log(`Universe: ${predData.universe_size || predData.predictions?.length || 0} symbols`);
    console.log(`Config: ${predData.execution_config || 'N/A'}`);

    if (predData.predictions && predData.predictions.length > 0) {
      console.log('\nTOP 10 LONG PICKS (Q1):');
      const top10 = predData.predictions.filter(p => p.quintile === 1).slice(0, 10);
      for (const p of top10) {
        console.log(`  #${p.rank.toString().padStart(3)} ${p.symbol.padEnd(6)} score=${p.score.toFixed(4)} Q${p.quintile} ${p.signal}`);
      }

      console.log('\nBOTTOM 5 (Q5 - avoid):');
      const bottom5 = predData.predictions.filter(p => p.quintile === 5).slice(0, 5);
      for (const p of bottom5) {
        console.log(`  #${p.rank.toString().padStart(3)} ${p.symbol.padEnd(6)} score=${p.score.toFixed(4)} Q${p.quintile} ${p.signal}`);
      }
    }

    console.log(`\nNext rebalance: ${predData.portfolio_action?.rebalance_due || 'N/A'}`);
  }

  // Write to shared brain
  try {
    const brain = require('./shared_brain');
    writeToSharedBrain(brain, predData);
    console.log('\nSuccessfully wrote to shared brain.');
  } catch (e) {
    console.warn('\nCould not write to shared brain:', e.message);
  }

  console.log('='.repeat(70));
}

module.exports = {
  loadV9Predictions,
  getSymbolPrediction,
  getMultiplePredictions,
  formatForLLM,
  writeToSharedBrain,
  refreshV9Predictions,
  loadAndWrite,
  refreshAndLoad,
  PREDICTION_FILE,
};
