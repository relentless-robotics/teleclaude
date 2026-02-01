/**
 * Token/Cost Tracker for Claude API Usage
 *
 * Tracks token usage, estimates costs, and provides preemptive warnings.
 * Pricing based on Anthropic's published rates (as of Jan 2026).
 */

const fs = require('fs');
const path = require('path');

// Pricing per 1M tokens (USD)
const PRICING = {
  'claude-opus-4-5-20251101': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4.00 },
  // Aliases
  'opus': { input: 15.00, output: 75.00 },
  'sonnet': { input: 3.00, output: 15.00 },
  'haiku': { input: 0.80, output: 4.00 }
};

// Daily budget defaults (can be configured)
const DEFAULT_DAILY_BUDGET = 10.00; // $10/day default
const USAGE_FILE = path.join(__dirname, '..', 'logs', 'token_usage.json');
const LOGS_DIR = path.join(__dirname, '..', 'logs');

/**
 * Ensure logs directory exists
 */
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Load usage data from file
 */
function loadUsage() {
  ensureLogsDir();
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading usage data:', e.message);
  }
  return {
    daily: {},
    sessions: [],
    config: {
      dailyBudget: DEFAULT_DAILY_BUDGET,
      warningThreshold: 0.80, // Warn at 80%
      criticalThreshold: 0.95 // Critical at 95%
    }
  };
}

/**
 * Save usage data to file
 */
function saveUsage(data) {
  ensureLogsDir();
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get today's date key
 */
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Calculate cost for tokens
 */
function calculateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model] || PRICING['sonnet']; // Default to sonnet pricing
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}

/**
 * Estimate tokens from text (rough approximation: ~4 chars per token)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Record token usage
 */
function recordUsage(model, inputTokens, outputTokens, taskDescription = '') {
  const data = loadUsage();
  const today = getTodayKey();

  if (!data.daily[today]) {
    data.daily[today] = {
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      requests: 0,
      byModel: {}
    };
  }

  const cost = calculateCost(model, inputTokens, outputTokens);

  // Update daily totals
  data.daily[today].inputTokens += inputTokens;
  data.daily[today].outputTokens += outputTokens;
  data.daily[today].totalCost += cost.totalCost;
  data.daily[today].requests += 1;

  // Track by model
  if (!data.daily[today].byModel[model]) {
    data.daily[today].byModel[model] = { inputTokens: 0, outputTokens: 0, cost: 0, requests: 0 };
  }
  data.daily[today].byModel[model].inputTokens += inputTokens;
  data.daily[today].byModel[model].outputTokens += outputTokens;
  data.daily[today].byModel[model].cost += cost.totalCost;
  data.daily[today].byModel[model].requests += 1;

  // Add to session log
  data.sessions.push({
    timestamp: new Date().toISOString(),
    model,
    inputTokens,
    outputTokens,
    cost: cost.totalCost,
    task: taskDescription
  });

  // Keep only last 1000 session entries
  if (data.sessions.length > 1000) {
    data.sessions = data.sessions.slice(-1000);
  }

  saveUsage(data);
  return cost;
}

/**
 * Get current usage status
 */
function getUsageStatus() {
  const data = loadUsage();
  const today = getTodayKey();
  const todayData = data.daily[today] || { inputTokens: 0, outputTokens: 0, totalCost: 0, requests: 0, byModel: {} };

  const budget = data.config.dailyBudget;
  const spent = todayData.totalCost;
  const remaining = budget - spent;
  const percentUsed = (spent / budget) * 100;

  let status = 'OK';
  if (percentUsed >= data.config.criticalThreshold * 100) {
    status = 'CRITICAL';
  } else if (percentUsed >= data.config.warningThreshold * 100) {
    status = 'WARNING';
  }

  return {
    date: today,
    budget,
    spent: parseFloat(spent.toFixed(4)),
    remaining: parseFloat(remaining.toFixed(4)),
    percentUsed: parseFloat(percentUsed.toFixed(1)),
    status,
    requests: todayData.requests,
    inputTokens: todayData.inputTokens,
    outputTokens: todayData.outputTokens,
    byModel: todayData.byModel
  };
}

/**
 * Estimate cost for a planned task
 */
function estimateTaskCost(model, estimatedInputTokens, estimatedOutputTokens) {
  const cost = calculateCost(model, estimatedInputTokens, estimatedOutputTokens);
  const status = getUsageStatus();

  const afterTaskPercent = ((status.spent + cost.totalCost) / status.budget) * 100;

  let recommendation = 'PROCEED';
  let warning = null;

  if (afterTaskPercent >= 100) {
    recommendation = 'BLOCK';
    warning = `This task would exceed daily budget (${afterTaskPercent.toFixed(1)}% after task)`;
  } else if (afterTaskPercent >= status.budget * 0.95) {
    recommendation = 'CAUTION';
    warning = `This task would put you at ${afterTaskPercent.toFixed(1)}% of daily budget`;
  } else if (afterTaskPercent >= status.budget * 0.80) {
    recommendation = 'WARN';
    warning = `After this task: ${afterTaskPercent.toFixed(1)}% of budget used`;
  }

  return {
    estimatedCost: parseFloat(cost.totalCost.toFixed(4)),
    currentSpent: status.spent,
    afterTask: parseFloat((status.spent + cost.totalCost).toFixed(4)),
    afterTaskPercent: parseFloat(afterTaskPercent.toFixed(1)),
    recommendation,
    warning
  };
}

/**
 * Get formatted usage report
 */
function getUsageReport() {
  const status = getUsageStatus();

  const bar = generateProgressBar(status.percentUsed);

  let report = `
DAILY USAGE REPORT (${status.date})
${'='.repeat(40)}
Budget:    $${status.budget.toFixed(2)}
Spent:     $${status.spent.toFixed(4)}
Remaining: $${status.remaining.toFixed(4)}

${bar} ${status.percentUsed.toFixed(1)}%

Status: ${status.status}
Requests: ${status.requests}
Tokens: ${status.inputTokens.toLocaleString()} in / ${status.outputTokens.toLocaleString()} out

BY MODEL:
`;

  for (const [model, data] of Object.entries(status.byModel)) {
    report += `  ${model}: $${data.cost.toFixed(4)} (${data.requests} reqs)\n`;
  }

  return report.trim();
}

/**
 * Generate ASCII progress bar
 */
function generateProgressBar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const filledChar = percent >= 95 ? '█' : percent >= 80 ? '▓' : '█';
  return `[${filledChar.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * Set daily budget
 */
function setDailyBudget(amount) {
  const data = loadUsage();
  data.config.dailyBudget = amount;
  saveUsage(data);
  return { success: true, newBudget: amount };
}

/**
 * Get usage history for past N days
 */
function getHistory(days = 7) {
  const data = loadUsage();
  const history = [];

  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().split('T')[0];

    if (data.daily[key]) {
      history.push({
        date: key,
        ...data.daily[key]
      });
    }
  }

  return history;
}

/**
 * Check if we should warn before a task
 */
function preflightCheck(model = 'sonnet', estimatedInputTokens = 10000, estimatedOutputTokens = 5000) {
  const estimate = estimateTaskCost(model, estimatedInputTokens, estimatedOutputTokens);
  const status = getUsageStatus();

  return {
    currentStatus: status,
    taskEstimate: estimate,
    shouldWarn: estimate.recommendation !== 'PROCEED',
    message: estimate.warning || `Budget OK: ${status.percentUsed.toFixed(1)}% used, $${status.remaining.toFixed(2)} remaining`
  };
}

module.exports = {
  recordUsage,
  getUsageStatus,
  estimateTaskCost,
  getUsageReport,
  setDailyBudget,
  getHistory,
  preflightCheck,
  estimateTokens,
  calculateCost,
  PRICING
};
