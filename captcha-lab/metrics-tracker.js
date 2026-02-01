/**
 * CAPTCHA Solver Metrics Tracker
 *
 * Tracks accuracy metrics across iterations to measure improvement.
 */

const fs = require('fs');
const path = require('path');

const METRICS_FILE = path.join(__dirname, 'test_results', 'metrics_history.json');
const RESULTS_DIR = path.join(__dirname, 'test_results');

// Ensure directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Load metrics history
 */
function loadMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8'));
    }
  } catch (e) {}
  return {
    iterations: [],
    bestAccuracy: 0,
    totalTests: 0,
    improvements: []
  };
}

/**
 * Save metrics
 */
function saveMetrics(data) {
  fs.writeFileSync(METRICS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record a test iteration
 */
function recordIteration(results, notes = '') {
  const metrics = loadMetrics();

  const iteration = {
    id: metrics.iterations.length + 1,
    timestamp: new Date().toISOString(),
    totalSamples: results.length,
    correct: results.filter(r => r.correct).length,
    accuracy: results.filter(r => r.correct).length / results.length,
    byType: {},
    avgSimilarity: 0,
    avgTime: 0,
    notes
  };

  // Calculate by type
  const types = [...new Set(results.map(r => r.sample?.type || 'unknown'))];
  for (const type of types) {
    const typeResults = results.filter(r => (r.sample?.type || 'unknown') === type);
    const correct = typeResults.filter(r => r.correct).length;
    iteration.byType[type] = {
      total: typeResults.length,
      correct,
      accuracy: correct / typeResults.length
    };
  }

  // Calculate averages
  const withSimilarity = results.filter(r => r.similarity !== undefined);
  if (withSimilarity.length > 0) {
    iteration.avgSimilarity = withSimilarity.reduce((sum, r) => sum + r.similarity, 0) / withSimilarity.length;
  }

  const withTime = results.filter(r => r.elapsed);
  if (withTime.length > 0) {
    iteration.avgTime = withTime.reduce((sum, r) => sum + r.elapsed, 0) / withTime.length;
  }

  // Track improvement
  if (metrics.iterations.length > 0) {
    const lastIteration = metrics.iterations[metrics.iterations.length - 1];
    const improvement = iteration.accuracy - lastIteration.accuracy;
    iteration.improvement = improvement;

    if (improvement > 0) {
      metrics.improvements.push({
        fromIteration: lastIteration.id,
        toIteration: iteration.id,
        improvement,
        notes
      });
    }
  }

  // Update best
  if (iteration.accuracy > metrics.bestAccuracy) {
    metrics.bestAccuracy = iteration.accuracy;
    iteration.isBest = true;
  }

  metrics.iterations.push(iteration);
  metrics.totalTests += results.length;

  saveMetrics(metrics);

  return iteration;
}

/**
 * Get metrics summary
 */
function getSummary() {
  const metrics = loadMetrics();

  if (metrics.iterations.length === 0) {
    return { message: 'No iterations recorded yet' };
  }

  const latest = metrics.iterations[metrics.iterations.length - 1];
  const first = metrics.iterations[0];

  return {
    totalIterations: metrics.iterations.length,
    totalTests: metrics.totalTests,
    currentAccuracy: latest.accuracy,
    bestAccuracy: metrics.bestAccuracy,
    improvementFromStart: latest.accuracy - first.accuracy,
    latestIteration: latest,
    history: metrics.iterations.map(i => ({
      id: i.id,
      accuracy: i.accuracy,
      improvement: i.improvement || 0
    }))
  };
}

/**
 * Print metrics report
 */
function printReport() {
  const metrics = loadMetrics();

  console.log('\n' + '='.repeat(70));
  console.log('CAPTCHA SOLVER METRICS HISTORY');
  console.log('='.repeat(70));

  if (metrics.iterations.length === 0) {
    console.log('\nNo iterations recorded yet.');
    return;
  }

  console.log(`\nTotal iterations: ${metrics.iterations.length}`);
  console.log(`Total tests run: ${metrics.totalTests}`);
  console.log(`Best accuracy: ${(metrics.bestAccuracy * 100).toFixed(1)}%`);

  // Accuracy trend
  console.log('\n--- Accuracy Trend ---\n');

  const barWidth = 40;
  for (const iter of metrics.iterations) {
    const filled = Math.round(iter.accuracy * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const arrow = iter.improvement > 0 ? '↑' : iter.improvement < 0 ? '↓' : '→';
    const change = iter.improvement ? ` (${iter.improvement > 0 ? '+' : ''}${(iter.improvement * 100).toFixed(1)}%)` : '';

    console.log(`#${String(iter.id).padStart(2)} [${bar}] ${(iter.accuracy * 100).toFixed(1)}% ${arrow}${change}`);
  }

  // By type comparison
  const types = new Set();
  for (const iter of metrics.iterations) {
    Object.keys(iter.byType).forEach(t => types.add(t));
  }

  if (types.size > 0) {
    console.log('\n--- Accuracy by Type (Latest) ---\n');
    const latest = metrics.iterations[metrics.iterations.length - 1];
    for (const type of types) {
      if (latest.byType[type]) {
        const acc = latest.byType[type].accuracy;
        console.log(`  ${type}: ${(acc * 100).toFixed(1)}%`);
      }
    }
  }

  // Improvements
  if (metrics.improvements.length > 0) {
    console.log('\n--- Notable Improvements ---\n');
    for (const imp of metrics.improvements.slice(-5)) {
      console.log(`  Iteration ${imp.fromIteration} → ${imp.toIteration}: +${(imp.improvement * 100).toFixed(1)}%`);
      if (imp.notes) console.log(`    Notes: ${imp.notes}`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

/**
 * Generate ASCII chart of accuracy over iterations
 */
function generateChart() {
  const metrics = loadMetrics();

  if (metrics.iterations.length < 2) {
    return 'Need at least 2 iterations for chart';
  }

  const height = 10;
  const width = Math.min(metrics.iterations.length, 50);
  const chart = [];

  // Initialize chart
  for (let i = 0; i < height; i++) {
    chart.push(new Array(width).fill(' '));
  }

  // Plot points
  for (let x = 0; x < width; x++) {
    const iter = metrics.iterations[x];
    const y = Math.floor(iter.accuracy * (height - 1));
    chart[height - 1 - y][x] = '●';

    // Fill below
    for (let i = height - 1; i > height - 1 - y; i--) {
      if (chart[i][x] === ' ') chart[i][x] = '│';
    }
  }

  // Add axes
  let output = '100%┤' + chart[0].join('') + '\n';
  for (let i = 1; i < height - 1; i++) {
    output += '    │' + chart[i].join('') + '\n';
  }
  output += '  0%┼' + '─'.repeat(width) + '\n';
  output += '     ' + '1'.padEnd(Math.floor(width / 2)) + 'Iteration'.padEnd(width - Math.floor(width / 2)) + metrics.iterations.length;

  return output;
}

module.exports = {
  loadMetrics,
  saveMetrics,
  recordIteration,
  getSummary,
  printReport,
  generateChart
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === 'chart') {
    console.log(generateChart());
  } else {
    printReport();
  }
}
