/**
 * CNN Walkforward Completion Handler
 *
 * Runs when BookSpatialCNN 100d walkforward finishes all 94 folds.
 * Performs full analysis: regime breakdown, persistence, tradeability,
 * then posts a comprehensive report to Discord #system-status and
 * writes results to the shared brain.
 *
 * Usage:
 *   node trading_agents/agents/cnn_completion_handler.js
 *
 * Exports:
 *   analyzeCompletion() — called by cnn_monitor.js on detection of completion
 */

'use strict';

const fs = require('fs');
const path = require('path');
const discord = require('../discord_channels');
const SharedBrain = require('../shared_brain');

// ============================================================================
// CONSTANTS
// ============================================================================

const LVL3QUANT_DIR = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant';
const RESULTS_DIR = path.join(LVL3QUANT_DIR, 'alpha_discovery', 'deep_models', 'results');
const TOTAL_FOLDS = 94;

/**
 * Known baselines for comparison table.
 * Cost threshold: ~0.05 IC required to net positive after ES transaction costs.
 * ES round-trip: 1.24 ticks cost vs 0.29 tick edge for LightGBM (4x overshoot).
 */
const BASELINES = [
  { name: 'EventTransformer',  meanIC: 0.094, status: 'UNTRADEABLE', note: 'Signal real, costs kill' },
  { name: 'LightGBM',          meanIC: 0.076, status: 'UNTRADEABLE', note: 'IC=0.019 OOS (5-min)' },
  { name: 'Cost threshold',    meanIC: 0.050, status: 'MINIMUM',     note: 'ES RT = 0.24 ticks commission' },
];

// Month boundaries for regime classification (test_date YYYY-MM-DD)
const MONTH_RANGES = {
  July:     { start: '2025-07-01', end: '2025-07-31' },
  August:   { start: '2025-08-01', end: '2025-08-31' },
  September:{ start: '2025-09-01', end: '2025-09-30' },
  October:  { start: '2025-10-01', end: '2025-10-31' },
  November: { start: '2025-11-01', end: '2025-11-30' },
};

// ============================================================================
// CHECKPOINT PARSING
// ============================================================================

/**
 * Find and return the parsed contents of the newest checkpoint_book_*.json.
 * Returns null if none found or parse fails.
 *
 * @returns {{ completedFolds, foldICs, foldDetails, meanIC, allPositive } | null}
 */
function loadLatestCheckpoint() {
  try {
    const files = fs.readdirSync(RESULTS_DIR)
      .filter(f => f.startsWith('checkpoint_book_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) {
      console.warn('[CNNHandler] No checkpoint files found in:', RESULTS_DIR);
      return null;
    }

    const latest = files[0];
    const fullPath = path.join(RESULTS_DIR, latest);
    console.log(`[CNNHandler] Loading checkpoint: ${latest}`);

    const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

    return {
      filename: latest,
      completedFolds: raw.completed_folds || 0,
      foldICs:        raw.fold_ics        || [],
      foldDetails:    raw.fold_details    || [],   // [{ fold, test_date, train_days, ic, best_val_loss, n_test }]
      meanIC:         raw.mean_ic         || 0,
      allPositive:    raw.all_positive    || false,
    };
  } catch (err) {
    console.error('[CNNHandler] Checkpoint load failed:', err.message);
    return null;
  }
}

// ============================================================================
// STATISTICS HELPERS
// ============================================================================

/**
 * Basic descriptive stats for an array of numbers.
 * Returns { mean, min, max, std, median, p25, p75, positive, pctPositive, count }.
 */
function describeICs(ics) {
  if (!ics || ics.length === 0) {
    return { mean: 0, min: 0, max: 0, std: 0, median: 0, p25: 0, p75: 0, positive: 0, pctPositive: 0, count: 0 };
  }

  const sorted = [...ics].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = ics.reduce((s, v) => s + v, 0) / n;
  const variance = ics.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const median = sorted[Math.floor(n / 2)];
  const p25 = sorted[Math.floor(n * 0.25)];
  const p75 = sorted[Math.floor(n * 0.75)];
  const positive = ics.filter(v => v > 0).length;
  const pctPositive = (positive / n * 100);

  return { mean, min: sorted[0], max: sorted[n - 1], std, median, p25, p75, positive, pctPositive, count: n };
}

// ============================================================================
// REGIME ANALYSIS
// ============================================================================

/**
 * Split folds by test_date month and compute per-month stats.
 *
 * fold_details items: { fold, test_date, train_days, ic, best_val_loss, n_test }
 * foldICs items are a parallel array if fold_details is sparse.
 *
 * Returns { July: stats, August: stats, ... } where stats = describeICs output.
 */
function analyzeRegimes(foldDetails, foldICs) {
  // Build a unified array: { testDate, ic }
  const folds = [];

  if (foldDetails && foldDetails.length > 0) {
    for (const d of foldDetails) {
      folds.push({
        fold:     d.fold,
        testDate: d.test_date || null,
        ic:       typeof d.ic === 'number' ? d.ic : null,
      });
    }
  } else {
    // Fallback: only IC values, no dates — assign dates by fold index
    // Folds 1-94, test dates span 2025-07-22 to 2025-11-28 (~128 calendar days / 94 folds)
    for (let i = 0; i < foldICs.length; i++) {
      const daysOffset = Math.round((i / (foldICs.length - 1)) * 128);
      const baseDate = new Date('2025-07-22');
      baseDate.setDate(baseDate.getDate() + daysOffset);
      folds.push({
        fold:     i + 1,
        testDate: baseDate.toISOString().slice(0, 10),
        ic:       foldICs[i],
      });
    }
  }

  // Group by month
  const monthBuckets = {};
  for (const [monthName, range] of Object.entries(MONTH_RANGES)) {
    monthBuckets[monthName] = [];
  }

  for (const fold of folds) {
    if (fold.ic === null || fold.testDate === null) continue;
    for (const [monthName, range] of Object.entries(MONTH_RANGES)) {
      if (fold.testDate >= range.start && fold.testDate <= range.end) {
        monthBuckets[monthName].push(fold.ic);
        break;
      }
    }
  }

  // Compute stats for each month, skipping empty buckets
  const result = {};
  for (const [monthName, ics] of Object.entries(monthBuckets)) {
    if (ics.length > 0) {
      result[monthName] = describeICs(ics);
    }
  }

  return result;
}

// ============================================================================
// PERSISTENCE ANALYSIS
// ============================================================================

/**
 * Analyze IC persistence across consecutive folds.
 * Returns:
 *   rollingMeans    — array of { foldEnd, mean } for rolling 5-fold windows
 *   autocorr        — lag-1 autocorrelation of IC series
 *   maxDrawdown     — { startFold, endFold, depth } worst consecutive IC decline
 *   longestPositiveRun — count
 *   longestNegativeRun — count
 */
function analyzePersistence(foldICs) {
  const n = foldICs.length;
  if (n < 5) {
    return { rollingMeans: [], autocorr: 0, maxDrawdown: null, longestPositiveRun: 0, longestNegativeRun: 0 };
  }

  // Rolling 5-fold mean
  const rollingMeans = [];
  for (let i = 4; i < n; i++) {
    const window = foldICs.slice(i - 4, i + 1);
    const mean = window.reduce((s, v) => s + v, 0) / 5;
    rollingMeans.push({ foldEnd: i + 1, mean: parseFloat(mean.toFixed(4)) });
  }

  // Lag-1 autocorrelation: corr(ICs[0..n-2], ICs[1..n-1])
  const x = foldICs.slice(0, n - 1);
  const y = foldICs.slice(1);
  const meanX = x.reduce((s, v) => s + v, 0) / x.length;
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < x.length; i++) {
    cov  += (x[i] - meanX) * (y[i] - meanY);
    varX += (x[i] - meanX) ** 2;
    varY += (y[i] - meanY) ** 2;
  }
  const autocorr = (varX > 0 && varY > 0) ? cov / Math.sqrt(varX * varY) : 0;

  // Max drawdown: worst cumulative consecutive decline in IC
  let maxDrawdown = null;
  let drawStart = 0;
  let drawPeak = foldICs[0];

  for (let i = 1; i < n; i++) {
    if (foldICs[i] > drawPeak) {
      drawPeak  = foldICs[i];
      drawStart = i;
    }
    const depth = foldICs[i] - drawPeak;
    if (!maxDrawdown || depth < maxDrawdown.depth) {
      maxDrawdown = { startFold: drawStart + 1, endFold: i + 1, depth: parseFloat(depth.toFixed(4)) };
    }
  }

  // Longest runs
  let longestPositiveRun = 0, longestNegativeRun = 0;
  let currentPos = 0, currentNeg = 0;
  for (const ic of foldICs) {
    if (ic > 0) {
      currentPos++;
      currentNeg = 0;
      longestPositiveRun = Math.max(longestPositiveRun, currentPos);
    } else {
      currentNeg++;
      currentPos = 0;
      longestNegativeRun = Math.max(longestNegativeRun, currentNeg);
    }
  }

  return {
    rollingMeans,
    autocorr:            parseFloat(autocorr.toFixed(4)),
    maxDrawdown,
    longestPositiveRun,
    longestNegativeRun,
  };
}

// ============================================================================
// TRADEABILITY ASSESSMENT
// ============================================================================

/**
 * Classify CNN results against known cost thresholds and baselines.
 *
 * Tiers:
 *   STRONG      — mean IC > 0.10, all_positive true, Oct-Nov mean IC > 0.05
 *   MODERATE    — mean IC > 0.08, >90% folds positive
 *   WEAK        — mean IC > 0.05
 *   UNTRADEABLE — otherwise
 *
 * @returns {{ tier, label, beatsCostThreshold, beatsET, beatsLightGBM, recommendation }}
 */
function assessTradeability(overallStats, regimeByMonth, allPositive) {
  const { mean, pctPositive } = overallStats;

  const octNovICs = [
    ...(regimeByMonth.October  ? Array(regimeByMonth.October.count).fill(regimeByMonth.October.mean)  : []),
    ...(regimeByMonth.November ? Array(regimeByMonth.November.count).fill(regimeByMonth.November.mean) : []),
  ];
  const octNovMean = octNovICs.length > 0
    ? (regimeByMonth.October?.mean  || 0) * (regimeByMonth.October?.count  || 0) / octNovICs.length +
      (regimeByMonth.November?.mean || 0) * (regimeByMonth.November?.count || 0) / octNovICs.length
    : 0;

  let tier, label, recommendation;

  if (mean > 0.10 && allPositive && octNovMean > 0.05) {
    tier  = 'STRONG';
    label = 'POTENTIALLY TRADEABLE';
    recommendation =
      'Run OOS signal persistence test (hold duration analysis). ' +
      'Estimate real RT cost vs IC edge — need IC > 0.20 for ES after spread+commission. ' +
      'Consider ensemble with ET model for higher conviction.';
  } else if (mean > 0.08 && pctPositive > 90) {
    tier  = 'MODERATE';
    label = 'MARGINAL — NEEDS PERSISTENCE';
    recommendation =
      'Signal exists but marginal vs ES costs. Test prediction autocorrelation: ' +
      'if preds hold for >10 bars, edge may compound. SPY venue may help (0.22 bps vs 0.56 bps).';
  } else if (mean > 0.05) {
    tier  = 'WEAK';
    label = 'WEAK — LIKELY UNTRADEABLE';
    recommendation =
      'IC above cost floor but below ET baseline. Combine with volume/regime gating. ' +
      'Standalone trading not recommended.';
  } else {
    tier  = 'UNTRADEABLE';
    label = 'UNTRADEABLE';
    recommendation =
      'Mean IC below ES cost threshold. Glosten-Milgrom applies: spread already prices the signal. ' +
      'CNN joins ET/LightGBM as confirmed DEAD for direct ES trading.';
  }

  return {
    tier,
    label,
    beatsCostThreshold: mean > 0.050,
    beatsET:            mean > 0.094,
    beatsLightGBM:      mean > 0.076,
    octNovMean:         parseFloat(octNovMean.toFixed(4)),
    recommendation,
  };
}

// ============================================================================
// DISCORD REPORT BUILDER
// ============================================================================

/**
 * Build the full markdown Discord report string.
 * Discord has a 2000-char limit per message, so we split into sections.
 *
 * @returns {string[]} Array of message chunks, each <= 1900 chars.
 */
function buildReport(checkpoint, overall, regimes, persistence, tradeability) {
  const { filename, completedFolds, meanIC, allPositive } = checkpoint;
  const { mean, min, max, std, median, p25, p75, positive, pctPositive, count } = overall;

  // --- Header ---
  const lines1 = [
    `**CNN WALKFORWARD COMPLETE — BookSpatialCNN 100d**`,
    ``,
    `**Overall Results (${count} folds)**`,
    `Mean IC:    **${mean.toFixed(4)}**`,
    `All positive: **${allPositive ? 'YES' : 'NO'}**  (${positive}/${count} = ${pctPositive.toFixed(1)}%)`,
    `IC range:   ${min.toFixed(4)} to ${max.toFixed(4)}`,
    `Std dev:    ${std.toFixed(4)}`,
    `Median:     ${median.toFixed(4)}  |  P25: ${p25.toFixed(4)}  |  P75: ${p75.toFixed(4)}`,
    `Source:     ${filename}`,
  ];

  // --- Monthly regime breakdown ---
  const lines2 = [
    ``,
    `**Monthly Regime Breakdown**`,
  ];
  const monthOrder = ['July', 'August', 'September', 'October', 'November'];
  for (const month of monthOrder) {
    const s = regimes[month];
    if (!s) continue;
    const flag = (month === 'October' || month === 'November') ? ' <- REGIME TEST' : '';
    lines2.push(
      `${month.padEnd(10)} | n=${String(s.count).padStart(2)} | ` +
      `mean=${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(4)} | ` +
      `min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} | ` +
      `${s.positive}/${s.count} pos${flag}`
    );
  }

  // --- Persistence ---
  const lines3 = [
    ``,
    `**Persistence Analysis**`,
    `Lag-1 autocorr:      ${persistence.autocorr.toFixed(4)} ${persistence.autocorr > 0.2 ? '(PERSISTENT)' : persistence.autocorr > 0 ? '(WEAK)' : '(NO PERSISTENCE)'}`,
    `Longest pos run:     ${persistence.longestPositiveRun} folds`,
    `Longest neg run:     ${persistence.longestNegativeRun} folds`,
  ];
  if (persistence.maxDrawdown) {
    const dd = persistence.maxDrawdown;
    lines3.push(`Max IC drawdown:     ${dd.depth.toFixed(4)} (folds ${dd.startFold}–${dd.endFold})`);
  }
  if (persistence.rollingMeans.length > 0) {
    const rollLast5 = persistence.rollingMeans.slice(-5);
    const rollStr = rollLast5.map(r => `f${r.foldEnd}:${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}`).join(' ');
    lines3.push(`Rolling 5-fold mean (tail): ${rollStr}`);
  }

  // --- Comparison table ---
  const lines4 = [
    ``,
    `**Comparison vs Baselines**`,
    `${'Model'.padEnd(20)} ${'Mean IC'.padEnd(10)} Status`,
    `${'─'.repeat(44)}`,
  ];
  lines4.push(
    `${'BookSpatialCNN'.padEnd(20)} ${(mean >= 0 ? '+' : '') + mean.toFixed(4).padEnd(10)} **${tradeability.tier}**`
  );
  for (const b of BASELINES) {
    const marker = b.status === 'MINIMUM' ? '^ cost floor' : b.note;
    lines4.push(
      `${b.name.padEnd(20)} ${(b.meanIC >= 0 ? '+' : '') + b.meanIC.toFixed(4).padEnd(10)} ${b.status} — ${marker}`
    );
  }

  // --- Verdict ---
  const lines5 = [
    ``,
    `**VERDICT: ${tradeability.label}**`,
    `Beats cost threshold: ${tradeability.beatsCostThreshold ? 'YES' : 'NO'}`,
    `Beats EventTransformer: ${tradeability.beatsET ? 'YES (new best)' : 'NO'}`,
    `Beats LightGBM: ${tradeability.beatsLightGBM ? 'YES' : 'NO'}`,
    `Oct-Nov mean IC: ${tradeability.octNovMean >= 0 ? '+' : ''}${tradeability.octNovMean.toFixed(4)} (need >0.05)`,
    ``,
    `**Next Steps:**`,
    tradeability.recommendation,
  ];

  // Combine into chunks <= 1900 chars
  const allSections = [lines1, lines2, lines3, lines4, lines5];
  const chunks = [];
  let current = '';

  for (const section of allSections) {
    const block = section.join('\n');
    if ((current + '\n' + block).length > 1900) {
      if (current.trim()) chunks.push(current.trim());
      current = block;
    } else {
      current = current ? current + '\n' + block : block;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ============================================================================
// SHARED BRAIN UPDATE
// ============================================================================

/**
 * Write CNN completion results to the shared brain under ctx.cnnResults.
 * Creates the key if it doesn't exist yet (backward-compatible).
 */
function updateSharedBrain(overall, regimes, persistence, tradeability, checkpoint) {
  try {
    const brain = new SharedBrain();
    const ctx = brain.ctx;

    ctx.cnnResults = {
      completedAt:         new Date().toISOString(),
      checkpointFile:      checkpoint.filename,
      totalFolds:          checkpoint.completedFolds,
      meanIC:              parseFloat(overall.mean.toFixed(4)),
      allPositive:         checkpoint.allPositive,
      pctPositive:         parseFloat(overall.pctPositive.toFixed(1)),
      icMin:               parseFloat(overall.min.toFixed(4)),
      icMax:               parseFloat(overall.max.toFixed(4)),
      icStd:               parseFloat(overall.std.toFixed(4)),
      regimes,
      persistence: {
        autocorr:            persistence.autocorr,
        longestPositiveRun:  persistence.longestPositiveRun,
        longestNegativeRun:  persistence.longestNegativeRun,
        maxDrawdown:         persistence.maxDrawdown,
      },
      tradeability: {
        tier:               tradeability.tier,
        label:              tradeability.label,
        beatsCostThreshold: tradeability.beatsCostThreshold,
        beatsET:            tradeability.beatsET,
        beatsLightGBM:      tradeability.beatsLightGBM,
        octNovMean:         tradeability.octNovMean,
      },
      updatedAt: new Date().toISOString(),
    };

    brain.logAgent('cnn-completion', `CNN walkforward done — meanIC=${overall.mean.toFixed(4)}, tier=${tradeability.tier}`);
    brain.save();
    console.log('[CNNHandler] Shared brain updated with CNN results.');
  } catch (err) {
    console.warn('[CNNHandler] Shared brain update failed:', err.message);
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Perform full completion analysis and post to Discord.
 * Exported for use by cnn_monitor.js; also callable standalone.
 *
 * @returns {object} Summary of findings { tier, meanIC, allPositive, octNovMean }
 */
async function analyzeCompletion() {
  console.log('[CNNHandler] Starting completion analysis...');

  // 1. Load checkpoint
  const checkpoint = loadLatestCheckpoint();
  if (!checkpoint) {
    const errMsg = 'CNN completion handler: no checkpoint file found — cannot analyze.';
    console.error('[CNNHandler]', errMsg);
    try { await discord.systemStatus(`**CNN COMPLETION ERROR**\n${errMsg}`); } catch (_) {}
    return null;
  }

  if (checkpoint.foldICs.length === 0) {
    const errMsg = `CNN checkpoint found (${checkpoint.filename}) but fold_ics is empty.`;
    console.error('[CNNHandler]', errMsg);
    try { await discord.systemStatus(`**CNN COMPLETION ERROR**\n${errMsg}`); } catch (_) {}
    return null;
  }

  console.log(`[CNNHandler] Loaded ${checkpoint.completedFolds} folds from ${checkpoint.filename}`);

  // 2. Overall stats
  const overall = describeICs(checkpoint.foldICs);
  console.log(`[CNNHandler] Overall: mean=${overall.mean.toFixed(4)}, pos=${overall.positive}/${overall.count} (${overall.pctPositive.toFixed(1)}%)`);

  // 3. Regime analysis (by month)
  const regimes = analyzeRegimes(checkpoint.foldDetails, checkpoint.foldICs);
  for (const [month, s] of Object.entries(regimes)) {
    console.log(`[CNNHandler] ${month}: n=${s.count}, mean=${s.mean.toFixed(4)}, pos=${s.positive}/${s.count}`);
  }

  // 4. Persistence analysis
  const persistence = analyzePersistence(checkpoint.foldICs);
  console.log(`[CNNHandler] Autocorr=${persistence.autocorr}, longestPosRun=${persistence.longestPositiveRun}`);

  // 5. Tradeability assessment
  const tradeability = assessTradeability(overall, regimes, checkpoint.allPositive);
  console.log(`[CNNHandler] Tradeability tier: ${tradeability.tier} — ${tradeability.label}`);

  // 6. Update shared brain
  updateSharedBrain(overall, regimes, persistence, tradeability, checkpoint);

  // 7. Build and send Discord report
  const chunks = buildReport(checkpoint, overall, regimes, persistence, tradeability);
  console.log(`[CNNHandler] Sending ${chunks.length} Discord message chunks to #system-status...`);

  for (let i = 0; i < chunks.length; i++) {
    try {
      await discord.systemStatus(chunks[i]);
      // Small delay between chunks to preserve ordering
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.warn(`[CNNHandler] Discord chunk ${i + 1} failed:`, err.message);
    }
  }

  console.log('[CNNHandler] Analysis complete.');

  return {
    tier:         tradeability.tier,
    meanIC:       parseFloat(overall.mean.toFixed(4)),
    allPositive:  checkpoint.allPositive,
    pctPositive:  parseFloat(overall.pctPositive.toFixed(1)),
    octNovMean:   tradeability.octNovMean,
    checkpointFile: checkpoint.filename,
  };
}

// ============================================================================
// STANDALONE EXECUTION
// ============================================================================

if (require.main === module) {
  analyzeCompletion()
    .then(result => {
      if (result) {
        console.log('\n[CNNHandler] Done:', JSON.stringify(result, null, 2));
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch(err => {
      console.error('[CNNHandler] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { analyzeCompletion };
