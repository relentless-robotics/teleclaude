/**
 * IASM (Intraday Alpha Signal Model) Loader
 *
 * Reads latest_signals.json from MacroStrategy/intraday_model/signals/
 * and writes signals into the shared brain for use by day trader.
 *
 * IASM predicts 4-hour forward returns using 5-minute bar data.
 * Updated every 10 minutes during market hours via scheduler.
 *
 * Usage:
 *   const iasmLoader = require('./iasm_loader');
 *   iasmLoader.loadAndWrite(brain);  // Load signals into shared brain
 *   iasmLoader.refreshSignals();     // Trigger Python predict + load
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TREE_SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'tree_signals_latest.json'
);

const META_SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'meta_signals_latest.json'
);

const SIGNAL_FILE = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy',
  'intraday_model', 'signals', 'latest_signals.json'
);

const MACRO_DIR = path.join(
  'C:', 'Users', 'YOUR_USERNAME', 'Documents', 'Github', 'MacroStrategy'
);

const STALE_MINUTES = 30;  // Signals older than 30 min are stale
const FRESH_MINUTES = 15;  // Signals younger than 15 min are fresh

/**
 * Load IASM signals from tree_signals_latest.json (preferred) or fallbacks.
 * Returns null if file missing or unreadable.
 *
 * Priority:
 *   1. tree_signals_latest.json (V2 tree models only - best performance)
 *   2. meta_signals_latest.json (LSTM+Tree ensemble - fallback)
 *   3. latest_signals.json (legacy)
 *
 * Normalizes object-keyed signals to array format for downstream consumers.
 */
function loadIASMSignals(options = {}) {
  // Prefer tree-only signals (best performance per model comparison)
  let signalFile = null;
  let source = null;

  if (fs.existsSync(TREE_SIGNAL_FILE)) {
    signalFile = TREE_SIGNAL_FILE;
    source = 'tree_v2';
  } else if (fs.existsSync(META_SIGNAL_FILE)) {
    signalFile = META_SIGNAL_FILE;
    source = 'meta_learner';
  } else if (fs.existsSync(SIGNAL_FILE)) {
    signalFile = SIGNAL_FILE;
    source = 'legacy';
  } else {
    console.warn('[IASMLoader] No signal file found. Run: python -m intraday_model.generate_tree_signals');
    return null;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(signalFile, 'utf8'));
  } catch (e) {
    console.error(`[IASMLoader] Failed to parse ${path.basename(signalFile)}:`, e.message);
    return null;
  }

  // Normalize meta-learner object-keyed signals to array format
  if (data.signals && !Array.isArray(data.signals)) {
    const signalArray = [];
    for (const [symbol, sigData] of Object.entries(data.signals)) {
      const primaryHorizon = sigData.horizons?.['1h'] || sigData.horizons?.['4h'] || {};
      signalArray.push({
        symbol,
        direction: sigData.direction,
        confidence: sigData.confidence,
        consensus: sigData.consensus,
        expected_return_pct: (primaryHorizon.pred || 0) * 100,
        model_agreement: sigData.model_agreement,
        meta_weights: sigData.meta_weights || null,
        horizons: sigData.horizons,
        horizon: '1h',
        timeframe: 'intraday',
        context: source === 'tree_v2' ? 'V2 Tree models (XGB+LightGBM)' : 'Meta-learner ensemble',
      });
    }
    data.signals = signalArray;
    console.log(`[IASMLoader] Normalized ${signalArray.length} ${source} signals to array format`);
  }

  // Compute freshness
  const signalTime = new Date(data.timestamp);
  const now = new Date();
  const ageMinutes = (now - signalTime) / (1000 * 60);

  data._freshness = {
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    isFresh: ageMinutes <= FRESH_MINUTES,
    isStale: ageMinutes > STALE_MINUTES,
    signalTime: data.timestamp,
  };

  if (data._freshness.isStale && !options.allowStale) {
    console.warn(`[IASMLoader] Signals are ${ageMinutes.toFixed(0)}m old (stale threshold: ${STALE_MINUTES}m).`);
    if (!options.returnStale) return null;
  }

  return data;
}

/**
 * Get IASM signal for a specific symbol.
 */
function getSymbolSignal(signalData, symbol) {
  if (!signalData || !signalData.signals) return null;
  return signalData.signals.find(s => s.symbol === symbol) || null;
}

/**
 * Get IASM signals for multiple symbols.
 */
function getMultipleSignals(signalData, symbols) {
  const result = {};
  for (const sym of symbols) {
    result[sym] = getSymbolSignal(signalData, sym);
  }
  return result;
}

/**
 * Format IASM signals for LLM consumption.
 * Returns structured object for embedding in LLM data package.
 */
function formatForLLM(signalData, relevantSymbols = []) {
  if (!signalData || !signalData.signals || signalData.signals.length === 0) {
    return null;
  }

  const freshness = signalData._freshness || {};

  // Filter signals relevant to the day trader's current universe
  const relevantSet = new Set(relevantSymbols);
  const relevantSignals = relevantSet.size > 0
    ? signalData.signals.filter(s => relevantSet.has(s.symbol))
    : [];

  // Top LONG signals (sorted by confidence)
  const allLongs = signalData.signals
    .filter(s => s.direction === 'LONG')
    .sort((a, b) => b.confidence - a.confidence);

  // Top SHORT signals
  const allShorts = signalData.signals
    .filter(s => s.direction === 'SHORT')
    .sort((a, b) => b.confidence - a.confidence);

  return {
    timestamp: signalData.timestamp,
    freshness,
    model_metrics: signalData.model_metrics || {},
    market_context: signalData.market_context || {},

    // Available prediction horizons
    horizonsAvailable: signalData.horizons_available || [],

    // Signals for symbols the day trader is considering
    relevantSignals: relevantSignals.map(s => ({
      symbol: s.symbol,
      direction: s.direction,
      confidence: s.confidence,
      expected_return_pct: s.expected_return_pct,
      timeframe: s.timeframe,
      features: s.features,
      context: s.context,
      consensus: s.consensus || null,
      multi_horizon: s.multi_horizon || null,
    })),

    // Top 5 LONG signals for opportunity scanning (consensus signals first)
    topLongs: allLongs
      .sort((a, b) => {
        // ALL_LONG consensus > MIXED, then by confidence
        const aScore = (a.consensus === 'ALL_LONG' ? 1 : 0) * 100 + b.confidence;
        const bScore = (b.consensus === 'ALL_LONG' ? 1 : 0) * 100 + a.confidence;
        return bScore - aScore;
      })
      .slice(0, 5).map(s => ({
        symbol: s.symbol,
        confidence: s.confidence,
        expected_return_pct: s.expected_return_pct,
        context: s.context,
        consensus: s.consensus || null,
      })),

    // Top 3 SHORT signals for fade candidates (consensus signals first)
    topShorts: allShorts
      .sort((a, b) => {
        const aScore = (a.consensus === 'ALL_SHORT' ? 1 : 0) * 100 + b.confidence;
        const bScore = (b.consensus === 'ALL_SHORT' ? 1 : 0) * 100 + a.confidence;
        return bScore - aScore;
      })
      .slice(0, 3).map(s => ({
        symbol: s.symbol,
        confidence: s.confidence,
        expected_return_pct: s.expected_return_pct,
        context: s.context,
        consensus: s.consensus || null,
      })),

    note: 'IASM is a MULTI-HORIZON intraday model (15m/30m/1h/4h predictions from 5-min bars). ' +
          'consensus=ALL_LONG means ALL horizons agree bullish - STRONGEST signal. ' +
          'consensus=ALL_SHORT means ALL horizons agree bearish - STRONGEST fade. ' +
          'consensus=MIXED means horizons disagree - LOWER conviction. ' +
          'V9 Q1 + IASM ALL_LONG = highest conviction long. V9 Q5 + IASM ALL_SHORT = highest conviction fade.',
  };
}

/**
 * Write IASM signals into the shared brain.
 */
function writeToSharedBrain(brain, signalData) {
  if (!brain || !signalData) return;

  // Use writeIASMSignals if available, otherwise write directly
  if (typeof brain.writeIASMSignals === 'function') {
    brain.writeIASMSignals({
      timestamp: signalData.timestamp,
      signals: signalData.signals,
      model_metrics: signalData.model_metrics,
      market_context: signalData.market_context,
      freshness: signalData._freshness,
      updatedAt: new Date().toISOString(),
    });
  } else {
    // Direct context write fallback
    if (!brain.ctx) brain.ctx = {};
    if (!brain.ctx.modelSignals) brain.ctx.modelSignals = {};
    brain.ctx.modelSignals.iasm = {
      timestamp: signalData.timestamp,
      signals: signalData.signals,
      model_metrics: signalData.model_metrics,
      market_context: signalData.market_context,
      freshness: signalData._freshness,
      updatedAt: new Date().toISOString(),
    };
    // Persist if brain has save method
    if (typeof brain._save === 'function') brain._save();
  }

  console.log(`[IASMLoader] Wrote ${signalData.signals.length} IASM signals to shared brain`);
}

/**
 * Trigger Python IASM predict pipeline.
 * Generates fresh tree model predictions (V2 features).
 * Returns true if successful.
 */
function refreshSignals(options = {}) {
  const updateData = options.updateData !== false;  // Default: update data too

  // IASM requires conda environment in WSL2 (xgboost, lightgbm, etc.)
  const WSL_DISTRO = 'Ubuntu-22.04';
  const WSL_MACRO_DIR = '/mnt/c/Users/YOUR_USERNAME/Documents/Github/MacroStrategy';
  const CONDA_PATH = 'export PATH=/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const ALPACA_ENVS = [
    `ALPACA_API_KEY=${process.env.ALPACA_API_KEY || process.env.DAYTRADE_ALPACA_API_KEY || ''}`,
    `ALPACA_SECRET_KEY=${process.env.ALPACA_SECRET_KEY || process.env.DAYTRADE_ALPACA_SECRET_KEY || ''}`,
  ].join(' ');

  try {
    if (updateData) {
      console.log('[IASMLoader] Updating data from Alpaca via WSL2...');
      execSync(`wsl -d ${WSL_DISTRO} --user root -- bash -c "${CONDA_PATH} && ${ALPACA_ENVS} cd ${WSL_MACRO_DIR} && python -m intraday_model.run update-data"`, {
        timeout: 180000,  // 3 min timeout for data update
        stdio: 'pipe',
      });
    }

    console.log('[IASMLoader] Generating tree model signals via WSL2...');
    execSync(`wsl -d ${WSL_DISTRO} --user root -- bash -c "${CONDA_PATH} && cd ${WSL_MACRO_DIR} && python -m intraday_model.generate_tree_signals export"`, {
      timeout: 180000,  // 3 min timeout for prediction
      stdio: 'pipe',
    });

    console.log('[IASMLoader] Signal refresh complete');
    return true;
  } catch (e) {
    console.error('[IASMLoader] Signal refresh failed:', e.message);
    // Fallback: try native Windows Python
    try {
      console.log('[IASMLoader] Trying native Windows Python fallback...');
      execSync(`cd /d "${MACRO_DIR}" && python -m intraday_model.generate_tree_signals export`, {
        timeout: 120000,
        stdio: 'pipe',
      });
      console.log('[IASMLoader] Windows Python fallback succeeded');
      return true;
    } catch (e2) {
      console.error('[IASMLoader] Windows Python fallback also failed:', e2.message);
      return false;
    }
  }
}

/**
 * Full load-and-write pipeline. Call this at startup or on schedule.
 */
function loadAndWrite(brain = null) {
  const signalData = loadIASMSignals({ allowStale: true, returnStale: true });
  if (!signalData) return null;

  if (!brain) {
    try {
      brain = require('./shared_brain');
    } catch (e) {
      console.warn('[IASMLoader] Could not load shared_brain:', e.message);
      return signalData;
    }
  }

  writeToSharedBrain(brain, signalData);
  return signalData;
}

/**
 * Full refresh pipeline: update data + predict + load into brain.
 */
async function refreshAndLoad(brain = null) {
  const success = refreshSignals();
  if (!success) return null;
  return loadAndWrite(brain);
}

// ============================================================================
// Standalone execution
// ============================================================================
if (require.main === module) {
  console.log('='.repeat(70));
  console.log('IASM Intraday Signal Loader - Standalone Mode');
  console.log('='.repeat(70));

  const signalData = loadIASMSignals({ allowStale: true, returnStale: true });
  if (!signalData) {
    console.error('\nNo IASM signals available. Run: python -m intraday_model.generate_tree_signals');
    process.exit(1);
  }

  const f = signalData._freshness;
  console.log(`\nSignal time: ${f.signalTime}`);
  console.log(`Age: ${f.ageMinutes}m ${f.isStale ? '(STALE!)' : f.isFresh ? '(fresh)' : '(aging)'}`);
  console.log(`Signals: ${signalData.signals.length}`);

  console.log('\nSignals:');
  for (const sig of signalData.signals) {
    const emoji = sig.direction === 'LONG' ? '+' : '-';
    console.log(`  ${emoji} ${sig.symbol.padEnd(6)} ${sig.direction.padEnd(5)} conf=${(sig.confidence * 100).toFixed(0)}% exp=${sig.expected_return_pct > 0 ? '+' : ''}${sig.expected_return_pct.toFixed(1)}%`);
  }

  const mc = signalData.market_context || {};
  console.log(`\nMarket: SPY ${mc.spy_direction}, VIX ${mc.vix_level}, ${mc.regime}`);

  // Write to shared brain
  try {
    const brain = require('./shared_brain');
    writeToSharedBrain(brain, signalData);
    console.log('\nSuccessfully wrote to shared brain.');
  } catch (e) {
    console.warn('\nCould not write to shared brain:', e.message);
  }

  console.log('='.repeat(70));
}

module.exports = {
  loadIASMSignals,
  getSymbolSignal,
  getMultipleSignals,
  formatForLLM,
  writeToSharedBrain,
  refreshSignals,
  loadAndWrite,
  refreshAndLoad,
  SIGNAL_FILE,
};
