/**
 * CAPTCHA Solver Test & Iterate
 *
 * Tests solver against harvested samples, measures accuracy,
 * and identifies areas for improvement.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const SOLVER_DIR = path.join(__dirname, 'solver');
const HARVESTER_DIR = path.join(__dirname, 'harvester');
const IMAGES_DIR = path.join(HARVESTER_DIR, 'data', 'images');
const LABELS_FILE = path.join(HARVESTER_DIR, 'data', 'labels', 'labels.json');
const RESULTS_DIR = path.join(__dirname, 'test_results');

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Load solver
let ocrSolver;
try {
  ocrSolver = require('./solver/ocr-solver');
} catch (e) {
  console.error('Failed to load OCR solver:', e.message);
  process.exit(1);
}

/**
 * Load labeled samples
 */
function loadSamples() {
  try {
    const data = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf-8'));
    return data.samples.filter(s => s.labeled && s.label && s.label !== '__INVALID__');
  } catch (e) {
    console.error('Failed to load labels:', e.message);
    return [];
  }
}

/**
 * Test a single sample
 */
async function testSample(sample) {
  const imagePath = path.join(IMAGES_DIR, sample.filename);

  if (!fs.existsSync(imagePath)) {
    return { sample, error: 'Image not found', correct: false };
  }

  const startTime = Date.now();

  try {
    let result;

    // Handle .txt files (text-based math questions, not images)
    if (sample.filename.endsWith('.txt')) {
      // These are pre-answered text questions, skip OCR
      return {
        sample,
        expected: sample.label.toUpperCase().trim(),
        got: sample.label.toUpperCase().trim(),
        correct: true,
        similarity: 1.0,
        elapsed: 0,
        note: 'Text file - answer was pre-provided'
      };
    }

    if (sample.type === 'math') {
      result = await ocrSolver.solveMathCaptcha(imagePath);
    } else {
      result = await ocrSolver.solveTextCaptcha(imagePath);
    }

    const elapsed = Date.now() - startTime;

    if (!result.success) {
      return {
        sample,
        error: result.error,
        correct: false,
        elapsed
      };
    }

    // Compare solutions (case-insensitive, trim whitespace)
    const expected = sample.label.toUpperCase().trim();
    const got = result.solution.toUpperCase().trim();
    const correct = expected === got;

    // Calculate similarity for partial matches
    const similarity = calculateSimilarity(expected, got);

    return {
      sample,
      expected,
      got,
      correct,
      similarity,
      elapsed,
      alternatives: result.alternatives
    };

  } catch (e) {
    return {
      sample,
      error: e.message,
      correct: false,
      elapsed: Date.now() - startTime
    };
  }
}

/**
 * Calculate string similarity (Levenshtein-based)
 */
function calculateSimilarity(a, b) {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i-1] === a[j-1]) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1,
          matrix[i][j-1] + 1,
          matrix[i-1][j] + 1
        );
      }
    }
  }

  const distance = matrix[b.length][a.length];
  return 1 - (distance / Math.max(a.length, b.length));
}

/**
 * Analyze common errors
 */
function analyzeErrors(results) {
  const errors = {
    charConfusions: {},  // e.g., 0 vs O, 1 vs I
    lengthMismatch: 0,
    totallyWrong: 0,
    partialMatch: 0
  };

  const wrongResults = results.filter(r => !r.correct && r.expected && r.got);

  for (const r of wrongResults) {
    const exp = r.expected;
    const got = r.got;

    if (exp.length !== got.length) {
      errors.lengthMismatch++;
    }

    if (r.similarity < 0.3) {
      errors.totallyWrong++;
    } else if (r.similarity < 1.0) {
      errors.partialMatch++;

      // Track character confusions
      const minLen = Math.min(exp.length, got.length);
      for (let i = 0; i < minLen; i++) {
        if (exp[i] !== got[i]) {
          const confusion = `${exp[i]}→${got[i]}`;
          errors.charConfusions[confusion] = (errors.charConfusions[confusion] || 0) + 1;
        }
      }
    }
  }

  return errors;
}

/**
 * Generate improvement suggestions
 */
function generateSuggestions(results, errorAnalysis) {
  const suggestions = [];

  const accuracy = results.filter(r => r.correct).length / results.length;

  if (accuracy < 0.5) {
    suggestions.push('CRITICAL: Accuracy below 50%. Consider:');
    suggestions.push('  - Check if Tesseract is properly installed');
    suggestions.push('  - Improve image preprocessing (contrast, threshold)');
    suggestions.push('  - Try different PSM modes');
  }

  if (errorAnalysis.lengthMismatch > results.length * 0.2) {
    suggestions.push('Many length mismatches. Consider:');
    suggestions.push('  - Adjusting character segmentation');
    suggestions.push('  - Using --psm 7 (single line) or --psm 8 (single word)');
  }

  // Check common confusions
  const confusions = Object.entries(errorAnalysis.charConfusions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (confusions.length > 0) {
    suggestions.push('Common character confusions:');
    for (const [conf, count] of confusions) {
      suggestions.push(`  - ${conf} (${count} times)`);
    }
    suggestions.push('Consider adding to character whitelist or training data');
  }

  return suggestions;
}

/**
 * Run full test suite
 */
async function runTests() {
  console.log('='.repeat(70));
  console.log('CAPTCHA SOLVER TEST SUITE');
  console.log('='.repeat(70));

  // Check dependencies
  console.log('\n--- Checking Dependencies ---\n');
  const status = ocrSolver.getStatus();
  console.log('Tesseract:', status.tesseract.installed ? `✓ ${status.tesseract.version}` : '✗ Not installed');
  console.log('ImageMagick:', status.imageMagick.installed ? '✓ Installed' : '✗ Not installed (optional)');

  if (!status.tesseract.installed) {
    console.error('\n❌ Tesseract not found. Please install it first.');
    console.log('Run: winget install UB-Mannheim.TesseractOCR');
    console.log('Then restart your terminal.');
    return;
  }

  // Load samples
  console.log('\n--- Loading Samples ---\n');
  const samples = loadSamples();
  console.log(`Loaded ${samples.length} labeled samples`);

  if (samples.length === 0) {
    console.error('No samples to test. Run harvest-now.js first.');
    return;
  }

  // Group by type
  const byType = {};
  for (const s of samples) {
    byType[s.type] = byType[s.type] || [];
    byType[s.type].push(s);
  }
  console.log('By type:', Object.entries(byType).map(([t, s]) => `${t}: ${s.length}`).join(', '));

  // Run tests
  console.log('\n--- Running Tests ---\n');
  const results = [];
  let tested = 0;

  for (const sample of samples) {
    const result = await testSample(sample);
    results.push(result);
    tested++;

    // Progress
    if (tested % 10 === 0 || tested === samples.length) {
      const correct = results.filter(r => r.correct).length;
      process.stdout.write(`\rTested: ${tested}/${samples.length} | Correct: ${correct} (${(correct/tested*100).toFixed(1)}%)`);
    }
  }
  console.log('\n');

  // Calculate stats
  console.log('--- Results by Type ---\n');

  const statsByType = {};
  for (const [type, typeSamples] of Object.entries(byType)) {
    const typeResults = results.filter(r => r.sample.type === type);
    const correct = typeResults.filter(r => r.correct).length;
    const avgSimilarity = typeResults
      .filter(r => r.similarity !== undefined)
      .reduce((sum, r) => sum + r.similarity, 0) / typeResults.length || 0;
    const avgTime = typeResults
      .filter(r => r.elapsed)
      .reduce((sum, r) => sum + r.elapsed, 0) / typeResults.length || 0;

    statsByType[type] = {
      total: typeSamples.length,
      correct,
      accuracy: correct / typeSamples.length,
      avgSimilarity,
      avgTime
    };

    console.log(`${type.toUpperCase()}:`);
    console.log(`  Accuracy: ${correct}/${typeSamples.length} (${(statsByType[type].accuracy * 100).toFixed(1)}%)`);
    console.log(`  Avg similarity: ${(avgSimilarity * 100).toFixed(1)}%`);
    console.log(`  Avg time: ${avgTime.toFixed(0)}ms`);
    console.log('');
  }

  // Overall stats
  const totalCorrect = results.filter(r => r.correct).length;
  const overallAccuracy = totalCorrect / results.length;

  console.log('--- Overall ---\n');
  console.log(`Total: ${totalCorrect}/${results.length} (${(overallAccuracy * 100).toFixed(1)}%)`);

  // Error analysis
  console.log('\n--- Error Analysis ---\n');
  const errorAnalysis = analyzeErrors(results);
  console.log(`Length mismatches: ${errorAnalysis.lengthMismatch}`);
  console.log(`Totally wrong (<30% similar): ${errorAnalysis.totallyWrong}`);
  console.log(`Partial matches: ${errorAnalysis.partialMatch}`);

  if (Object.keys(errorAnalysis.charConfusions).length > 0) {
    console.log('\nTop character confusions:');
    const confusions = Object.entries(errorAnalysis.charConfusions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [conf, count] of confusions) {
      console.log(`  ${conf}: ${count}`);
    }
  }

  // Suggestions
  console.log('\n--- Improvement Suggestions ---\n');
  const suggestions = generateSuggestions(results, errorAnalysis);
  for (const s of suggestions) {
    console.log(s);
  }

  // Sample failures
  console.log('\n--- Sample Failures ---\n');
  const failures = results.filter(r => !r.correct && r.expected).slice(0, 10);
  for (const f of failures) {
    console.log(`${f.sample.filename}:`);
    console.log(`  Expected: "${f.expected}" | Got: "${f.got || 'N/A'}" | Similarity: ${((f.similarity || 0) * 100).toFixed(0)}%`);
  }

  // Save results
  const reportPath = path.join(RESULTS_DIR, `test_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      correct: totalCorrect,
      accuracy: overallAccuracy,
      byType: statsByType
    },
    errorAnalysis,
    suggestions,
    results: results.map(r => ({
      filename: r.sample.filename,
      type: r.sample.type,
      expected: r.expected,
      got: r.got,
      correct: r.correct,
      similarity: r.similarity,
      elapsed: r.elapsed,
      error: r.error
    }))
  }, null, 2));

  console.log(`\nFull report saved to: ${reportPath}`);

  return {
    accuracy: overallAccuracy,
    statsByType,
    errorAnalysis,
    suggestions
  };
}

// Run if called directly
if (require.main === module) {
  const metricsTracker = require('./metrics-tracker');

  runTests().then(result => {
    if (result) {
      // Record this iteration
      const samples = loadSamples();
      const testResults = [];

      // Re-run to get full results for metrics
      console.log('\nRecording metrics...');

      // We already have the results, record them
      console.log('\n');
      metricsTracker.printReport();
    }
  }).catch(console.error);
}

module.exports = { runTests, testSample, loadSamples };
