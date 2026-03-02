/**
 * IASM Independent Performance Tracker
 *
 * Tracks each IASM signal independently to measure model accuracy,
 * separate from day trader P&L. Records signal → outcome mapping.
 *
 * Metrics tracked:
 * - Win rate by confidence bucket
 * - Average return by direction
 * - Information Coefficient (IC)
 * - Signal-to-trade attribution
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SIGNALS_LOG = path.join(DATA_DIR, 'iasm_signals_log.jsonl');
const METRICS_FILE = path.join(DATA_DIR, 'iasm_performance_metrics.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Record a new IASM signal for tracking.
 * Call this every time IASM generates a signal.
 */
function recordSignal(signal, currentPrice) {
  const record = {
    signal_id: `iasm_${signal.symbol}_${Date.now()}`,
    timestamp: signal.timestamp || new Date().toISOString(),
    symbol: signal.symbol,
    direction: signal.direction,
    confidence: signal.confidence,
    expected_return_pct: signal.expected_return_pct,
    timeframe: signal.timeframe || '4h',
    entry_price: currentPrice,
    expires_at: getExpiryTime(signal.timestamp || new Date().toISOString(), 4),
    // Filled when resolved
    actual_return_pct: null,
    actual_direction: null,
    outcome: null,  // WIN, LOSS, NEUTRAL
    resolved_at: null,
    resolution_price: null,
    // Attribution
    day_trader_used: false,
    trade_id: null,
  };

  appendToLog(record);
  return record;
}

/**
 * Record multiple signals from a signal batch.
 */
function recordSignalBatch(signalData, priceMap = {}) {
  if (!signalData || !signalData.signals) return [];

  const records = [];
  for (const sig of signalData.signals) {
    const price = priceMap[sig.symbol] || null;
    if (price) {
      records.push(recordSignal(sig, price));
    }
  }
  return records;
}

/**
 * Mark that the day trader acted on an IASM signal.
 */
function markSignalUsed(symbol, tradeId) {
  const records = readLog();
  let updated = false;

  // Find the most recent unresolved signal for this symbol
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].symbol === symbol && !records[i].resolved_at) {
      records[i].day_trader_used = true;
      records[i].trade_id = tradeId;
      updated = true;
      break;
    }
  }

  if (updated) {
    writeLog(records);
  }
  return updated;
}

/**
 * Resolve expired signals by checking actual prices.
 * Call this periodically (e.g., every 10 minutes).
 */
function resolveExpiredSignals(priceMap = {}) {
  const records = readLog();
  const now = new Date();
  let resolved = 0;

  for (const record of records) {
    if (record.resolved_at) continue;  // Already resolved

    const expiresAt = new Date(record.expires_at);
    if (now < expiresAt) continue;  // Not yet expired

    const currentPrice = priceMap[record.symbol];
    if (!currentPrice || !record.entry_price) continue;

    // Calculate actual return
    const actualReturn = (currentPrice - record.entry_price) / record.entry_price;
    record.actual_return_pct = actualReturn * 100;
    record.resolution_price = currentPrice;
    record.resolved_at = now.toISOString();

    // Determine outcome
    if (record.direction === 'LONG') {
      record.actual_direction = actualReturn > 0 ? 'LONG' : 'SHORT';
      record.outcome = actualReturn > 0.001 ? 'WIN' : (actualReturn < -0.001 ? 'LOSS' : 'NEUTRAL');
    } else {
      record.actual_direction = actualReturn < 0 ? 'SHORT' : 'LONG';
      record.outcome = actualReturn < -0.001 ? 'WIN' : (actualReturn > 0.001 ? 'LOSS' : 'NEUTRAL');
    }

    resolved++;
  }

  if (resolved > 0) {
    writeLog(records);
    console.log(`[IASMPerf] Resolved ${resolved} expired signals`);
  }

  return resolved;
}

/**
 * Calculate performance metrics for a given period.
 */
function calculateMetrics(periodDays = 7) {
  const records = readLog();
  const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const resolved = records.filter(r =>
    r.resolved_at && new Date(r.timestamp) >= cutoff
  );

  if (resolved.length === 0) {
    return { totalSignals: 0, resolved: 0, message: 'No resolved signals in period' };
  }

  // Overall metrics
  const wins = resolved.filter(r => r.outcome === 'WIN').length;
  const losses = resolved.filter(r => r.outcome === 'LOSS').length;
  const neutrals = resolved.filter(r => r.outcome === 'NEUTRAL').length;
  const winRate = wins / (wins + losses) || 0;

  // Average return
  const avgReturn = resolved.reduce((sum, r) => sum + (r.actual_return_pct || 0), 0) / resolved.length;

  // By confidence bucket
  const buckets = {
    high: { min: 0.7, max: 1.0, signals: [], wins: 0, losses: 0 },
    medium: { min: 0.6, max: 0.7, signals: [], wins: 0, losses: 0 },
    low: { min: 0.5, max: 0.6, signals: [], wins: 0, losses: 0 },
  };

  for (const r of resolved) {
    for (const [name, bucket] of Object.entries(buckets)) {
      if (r.confidence >= bucket.min && r.confidence < bucket.max) {
        bucket.signals.push(r);
        if (r.outcome === 'WIN') bucket.wins++;
        if (r.outcome === 'LOSS') bucket.losses++;
      }
    }
  }

  const byConfidence = {};
  for (const [name, bucket] of Object.entries(buckets)) {
    const total = bucket.wins + bucket.losses;
    byConfidence[name] = {
      count: bucket.signals.length,
      winRate: total > 0 ? bucket.wins / total : null,
      avgReturn: bucket.signals.length > 0
        ? bucket.signals.reduce((s, r) => s + (r.actual_return_pct || 0), 0) / bucket.signals.length
        : null,
    };
  }

  // By direction
  const longs = resolved.filter(r => r.direction === 'LONG');
  const shorts = resolved.filter(r => r.direction === 'SHORT');

  const byDirection = {
    LONG: {
      count: longs.length,
      winRate: longs.length > 0 ? longs.filter(r => r.outcome === 'WIN').length / longs.filter(r => r.outcome !== 'NEUTRAL').length : null,
      avgReturn: longs.length > 0 ? longs.reduce((s, r) => s + (r.actual_return_pct || 0), 0) / longs.length : null,
    },
    SHORT: {
      count: shorts.length,
      winRate: shorts.length > 0 ? shorts.filter(r => r.outcome === 'WIN').length / shorts.filter(r => r.outcome !== 'NEUTRAL').length : null,
      avgReturn: shorts.length > 0 ? shorts.reduce((s, r) => s + (r.actual_return_pct || 0), 0) / shorts.length : null,
    },
  };

  // IC (correlation between predicted and actual return)
  const predicted = resolved.map(r => r.expected_return_pct);
  const actual = resolved.map(r => r.actual_return_pct || 0);
  const ic = pearsonCorrelation(predicted, actual);

  // Attribution: IASM-influenced vs not
  const usedByTrader = resolved.filter(r => r.day_trader_used);
  const notUsed = resolved.filter(r => !r.day_trader_used);

  const attribution = {
    usedByTrader: usedByTrader.length,
    notUsed: notUsed.length,
    usedWinRate: usedByTrader.length > 0
      ? usedByTrader.filter(r => r.outcome === 'WIN').length / usedByTrader.filter(r => r.outcome !== 'NEUTRAL').length
      : null,
    notUsedWinRate: notUsed.length > 0
      ? notUsed.filter(r => r.outcome === 'WIN').length / notUsed.filter(r => r.outcome !== 'NEUTRAL').length
      : null,
  };

  const metrics = {
    period: `${periodDays}d`,
    totalSignals: records.length,
    resolved: resolved.length,
    pending: records.filter(r => !r.resolved_at).length,
    winRate,
    wins,
    losses,
    neutrals,
    avgReturn,
    ic,
    byConfidence,
    byDirection,
    attribution,
    generatedAt: new Date().toISOString(),
  };

  // Save metrics
  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));

  return metrics;
}

/**
 * Generate Discord-formatted performance report.
 */
function generateReport(periodDays = 7) {
  const metrics = calculateMetrics(periodDays);

  if (metrics.resolved === 0) {
    return `📊 **IASM Performance** (${periodDays}d)\nNo resolved signals yet. Model needs to run during market hours to generate trackable signals.`;
  }

  const lines = [];
  lines.push(`📊 **IASM Performance Report** (${periodDays}d)`);
  lines.push(`Signals: ${metrics.resolved} resolved, ${metrics.pending} pending`);
  lines.push(`Win Rate: ${(metrics.winRate * 100).toFixed(1)}% (${metrics.wins}W/${metrics.losses}L/${metrics.neutrals}N)`);
  lines.push(`Avg Return: ${metrics.avgReturn > 0 ? '+' : ''}${metrics.avgReturn.toFixed(2)}%`);
  lines.push(`IC: ${metrics.ic !== null ? metrics.ic.toFixed(3) : 'N/A'}`);
  lines.push('');

  // By confidence
  lines.push('**By Confidence:**');
  for (const [bucket, data] of Object.entries(metrics.byConfidence)) {
    if (data.count > 0) {
      lines.push(`  ${bucket} (${data.count}): WR=${data.winRate !== null ? (data.winRate * 100).toFixed(0) + '%' : 'N/A'}, Avg=${data.avgReturn !== null ? data.avgReturn.toFixed(2) + '%' : 'N/A'}`);
    }
  }

  // By direction
  lines.push('');
  lines.push('**By Direction:**');
  for (const [dir, data] of Object.entries(metrics.byDirection)) {
    if (data.count > 0) {
      lines.push(`  ${dir} (${data.count}): WR=${data.winRate !== null ? (data.winRate * 100).toFixed(0) + '%' : 'N/A'}, Avg=${data.avgReturn !== null ? data.avgReturn.toFixed(2) + '%' : 'N/A'}`);
    }
  }

  // Attribution
  if (metrics.attribution.usedByTrader > 0) {
    lines.push('');
    lines.push('**Day Trader Attribution:**');
    lines.push(`  IASM-influenced trades: ${metrics.attribution.usedByTrader} (WR=${metrics.attribution.usedWinRate !== null ? (metrics.attribution.usedWinRate * 100).toFixed(0) + '%' : 'N/A'})`);
    lines.push(`  Non-IASM trades: ${metrics.attribution.notUsed} (WR=${metrics.attribution.notUsedWinRate !== null ? (metrics.attribution.notUsedWinRate * 100).toFixed(0) + '%' : 'N/A'})`);
  }

  return lines.join('\n');
}

/**
 * Get active (unresolved) signals.
 */
function getActiveSignals() {
  return readLog().filter(r => !r.resolved_at);
}

// ============================================================================
// Helpers
// ============================================================================

function getExpiryTime(timestamp, hours) {
  const dt = new Date(timestamp);
  dt.setHours(dt.getHours() + hours);
  return dt.toISOString();
}

function pearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

function readLog() {
  if (!fs.existsSync(SIGNALS_LOG)) return [];
  try {
    const content = fs.readFileSync(SIGNALS_LOG, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  } catch (e) {
    console.error('[IASMPerf] Failed to read log:', e.message);
    return [];
  }
}

function writeLog(records) {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(SIGNALS_LOG, content);
}

function appendToLog(record) {
  fs.appendFileSync(SIGNALS_LOG, JSON.stringify(record) + '\n');
}

// ============================================================================
// Standalone
// ============================================================================
if (require.main === module) {
  console.log('='.repeat(70));
  console.log('IASM Performance Tracker');
  console.log('='.repeat(70));

  const metrics = calculateMetrics(30);
  console.log(JSON.stringify(metrics, null, 2));
  console.log('\n' + generateReport(30));
}

module.exports = {
  recordSignal,
  recordSignalBatch,
  markSignalUsed,
  resolveExpiredSignals,
  calculateMetrics,
  generateReport,
  getActiveSignals,
};
