/**
 * AI Model Router
 *
 * Smart routing between Claude (Opus/Sonnet/Haiku) and Kimi K2.5 based on:
 * - Task type and complexity
 * - Cost optimization
 * - Model strengths/weaknesses
 * - Rate limits and availability
 *
 * Usage:
 *   const { route, routeTask } = require('./utils/model_router');
 *   const result = await route('Generate a React component for...', { preferCost: true });
 */

const kimiClient = require('./kimi_client');
const fs = require('fs');
const path = require('path');

// Model capabilities and costs
const MODEL_SPECS = {
  'opus': {
    cost: { input: 15.0, output: 75.0 },  // per million tokens
    strengths: ['complex reasoning', 'architecture', 'security', 'critical decisions'],
    contextWindow: 200000,
    speed: 'slow',
    quality: 'highest'
  },
  'sonnet': {
    cost: { input: 3.0, output: 15.0 },
    strengths: ['browser automation', 'code analysis', 'moderate tasks', 'balanced'],
    contextWindow: 200000,
    speed: 'medium',
    quality: 'high'
  },
  'haiku': {
    cost: { input: 0.25, output: 1.25 },
    strengths: ['file search', 'simple tasks', 'fast responses', 'basic operations'],
    contextWindow: 200000,
    speed: 'fast',
    quality: 'good'
  },
  'kimi': {
    cost: { input: 0.60, output: 2.50 },
    strengths: ['coding', 'visual coding', 'frontend', 'agent swarms', 'long context', 'tool calling'],
    contextWindow: 256000,
    speed: 'medium',
    quality: 'high',
    weaknesses: ['pure reasoning', 'math']
  },
};

// Task patterns that map to specific models
const TASK_PATTERNS = {
  // Kimi K2.5 excels at these
  kimi: [
    /generate.*(?:react|vue|angular|component|UI|interface|frontend)/i,
    /create.*(?:website|webpage|landing page|dashboard)/i,
    /build.*(?:app|application|form|widget)/i,
    /code.*(?:from|based on).*(?:design|mockup|screenshot|image)/i,
    /visual.*(?:coding|programming)/i,
    /convert.*(?:design|figma|sketch).*(?:code|html)/i,
    /(?:html|css|javascript|typescript|jsx|tsx).*code/i,
    /refactor.*(?:component|module|class)/i,
    /agent.*(?:swarm|multi|parallel|coordinate)/i,
    /tool calling|function calling|API integration/i
  ],

  // Claude Opus - complex reasoning
  opus: [
    /(?:architecture|design pattern|system design)/i,
    /security.*(?:analysis|audit|review)/i,
    /complex.*(?:reasoning|logic|algorithm)/i,
    /critical.*decision/i,
    /evaluate.*trade-?offs/i,
    /(?:cryptography|encryption|authentication)/i
  ],

  // Claude Sonnet - balanced tasks
  sonnet: [
    /browser.*automation/i,
    /playwright|puppeteer|selenium/i,
    /navigate.*website/i,
    /log.*in|login|authentication/i,
    /scrape|extract.*data/i,
    /code.*(?:analysis|review|explanation)/i,
    /multi-step.*(?:task|operation)/i
  ],

  // Claude Haiku - simple/fast tasks
  haiku: [
    /(?:search|find|locate).*file/i,
    /list.*files/i,
    /read.*file/i,
    /simple.*(?:search|query|lookup)/i,
    /quick.*(?:check|status|info)/i,
    /glob|grep|basic/i
  ],

};

/**
 * Analyze task and determine best model
 *
 * @param {string} taskDescription - Description of the task
 * @param {Object} options - Routing preferences
 * @returns {Object} Recommended model and reasoning
 */
function analyzeTask(taskDescription, options = {}) {
  const preferences = {
    preferCost: options.preferCost || false,        // Prioritize cheapest option
    preferQuality: options.preferQuality || false,  // Prioritize best quality
    preferSpeed: options.preferSpeed || false,      // Prioritize fastest
    allowKimi: options.allowKimi !== false,         // Allow Kimi routing
    forceModel: options.forceModel || null          // Force specific model
  };

  // If model is forced, use it
  if (preferences.forceModel) {
    return {
      model: preferences.forceModel,
      confidence: 1.0,
      reason: 'Forced by user preference',
      alternatives: []
    };
  }

  const task = taskDescription.toLowerCase();
  const matches = {};

  // Check patterns for each model
  for (const [model, patterns] of Object.entries(TASK_PATTERNS)) {
    matches[model] = patterns.filter(pattern => pattern.test(task)).length;
  }

  // Calculate scores
  const scores = {};
  for (const [model, matchCount] of Object.entries(matches)) {
    if (model === 'kimi' && !preferences.allowKimi) continue;
    if (model === 'kimi' && !kimiClient.isAvailable()) continue;
    let score = matchCount * 10;  // Base score from pattern matches

    // Apply preference modifiers
    const spec = MODEL_SPECS[model];

    if (preferences.preferCost) {
      // Lower cost = higher score
      const avgCost = (spec.cost.input + spec.cost.output) / 2;
      score += (100 - avgCost) / 10;
    }

    if (preferences.preferSpeed) {
      const speedBonus = { fastest: 30, fast: 20, medium: 10, slow: 0 };
      score += speedBonus[spec.speed] || 0;
    }

    if (preferences.preferQuality) {
      const qualityBonus = { highest: 30, high: 20, good: 10 };
      score += qualityBonus[spec.quality] || 0;
    }

    scores[model] = score;
  }

  // Find best model
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    // Fallback to Sonnet (balanced)
    return {
      model: 'sonnet',
      confidence: 0.3,
      reason: 'No strong pattern match - defaulting to balanced Sonnet',
      alternatives: ['opus', 'haiku']
    };
  }

  const [bestModel, bestScore] = sorted[0];
  const alternatives = sorted.slice(1, 3).map(([m]) => m);

  const confidence = Math.min(bestScore / 50, 1.0);

  return {
    model: bestModel,
    confidence,
    reason: generateReason(bestModel, taskDescription, matches[bestModel]),
    alternatives,
    scores
  };
}

/**
 * Generate explanation for model choice
 */
function generateReason(model, task, matchCount) {
  const spec = MODEL_SPECS[model];
  const reasons = [];

  if (matchCount > 0) {
    reasons.push(`${matchCount} pattern match(es) for ${model}'s strengths`);
  }

  reasons.push(`Strengths: ${spec.strengths.slice(0, 3).join(', ')}`);

  if (model === 'kimi') {
    reasons.push('Kimi K2.5 is the strongest open-source coding model');
  }

  return reasons.join('. ');
}

/**
 * Route a task to the best model and execute
 *
 * @param {string} taskDescription - What to do
 * @param {Object} options - Routing and execution options
 * @returns {Promise<Object>} Result from selected model
 */
async function route(taskDescription, options = {}) {
  const analysis = analyzeTask(taskDescription, options);

  console.log(`[Model Router] Selected: ${analysis.model} (confidence: ${(analysis.confidence * 100).toFixed(1)}%)`);
  console.log(`[Model Router] Reason: ${analysis.reason}`);

  if (analysis.alternatives.length > 0) {
    console.log(`[Model Router] Alternatives: ${analysis.alternatives.join(', ')}`);
  }

  // Execute based on selected model
  if (analysis.model === 'kimi') {
    return await executeWithKimi(taskDescription, options);
  } else {
    return await executeWithClaude(taskDescription, analysis.model, options);
  }
}

/**
 * Execute task with Kimi K2.5
 */
async function executeWithKimi(task, options = {}) {
  try {
    const result = await kimiClient.chat(task, {
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools: options.tools
    });

    return {
      model: 'kimi',
      content: result.content,
      usage: result.usage,
      cost: result.cost,
      success: true
    };
  } catch (error) {
    console.error('[Model Router] Kimi execution failed:', error.message);

    // Fallback to Claude Sonnet
    if (options.allowFallback !== false) {
      console.log('[Model Router] Falling back to Claude Sonnet...');
      return await executeWithClaude(task, 'sonnet', options);
    }

    throw error;
  }
}

/**
 * Execute task with Claude (Opus/Sonnet/Haiku)
 *
 * Note: This is a placeholder - actual execution depends on your Claude integration
 */
async function executeWithClaude(task, model, options = {}) {
  // This would integrate with your existing Claude Task/Agent system
  // For now, return a structure indicating which model should be used

  return {
    model: `claude-${model}`,
    content: null,  // Would be filled by actual Claude execution
    recommendation: `Use ${model} model for this task`,
    taskDescription: task,
    success: false,
    needsExecution: true  // Signal that this needs to be executed by Claude
  };
}

/**
 * Get cost estimate for a task with different models
 *
 * @param {string} taskDescription - Task to estimate
 * @param {number} estimatedInputTokens - Estimated input size
 * @param {number} estimatedOutputTokens - Estimated output size
 * @returns {Object} Cost comparison
 */
function estimateCosts(taskDescription, estimatedInputTokens = 5000, estimatedOutputTokens = 2000) {
  const costs = {};

  for (const [model, spec] of Object.entries(MODEL_SPECS)) {
    if (model === 'kimi' && !kimiClient.isAvailable()) continue;

    const inputCost = (estimatedInputTokens / 1000000) * spec.cost.input;
    const outputCost = (estimatedOutputTokens / 1000000) * spec.cost.output;
    const total = inputCost + outputCost;

    costs[model] = {
      input: inputCost.toFixed(6),
      output: outputCost.toFixed(6),
      total: total.toFixed(6),
      totalDollars: `$${total.toFixed(4)}`
    };
  }

  // Sort by cost
  const sorted = Object.entries(costs)
    .sort((a, b) => parseFloat(a[1].total) - parseFloat(b[1].total))
    .map(([model, cost]) => ({ model, ...cost }));

  return {
    breakdown: costs,
    cheapestToMostExpensive: sorted,
    recommendation: analyzeTask(taskDescription, { preferCost: true }).model
  };
}

/**
 * Suggest best model for a task without executing
 *
 * @param {string} taskDescription - Task to analyze
 * @param {Object} options - Routing preferences
 * @returns {Object} Recommendation
 */
function suggest(taskDescription, options = {}) {
  const analysis = analyzeTask(taskDescription, options);
  const spec = MODEL_SPECS[analysis.model];

  return {
    recommended: analysis.model,
    confidence: analysis.confidence,
    reason: analysis.reason,
    alternatives: analysis.alternatives,
    specs: spec,
    costEstimate: estimateCosts(taskDescription).breakdown[analysis.model]
  };
}

/**
 * Batch routing - analyze multiple tasks and recommend models
 */
function batchSuggest(tasks, options = {}) {
  return tasks.map(task => ({
    task,
    suggestion: suggest(task, options)
  }));
}

/**
 * Get model specifications
 */
function getModelSpecs(model = null) {
  if (model) {
    return MODEL_SPECS[model] || null;
  }
  return MODEL_SPECS;
}

/**
 * Check if Kimi is available
 */
function isKimiAvailable() {
  return kimiClient.isAvailable();
}

module.exports = {
  // Core routing
  analyzeTask,
  route,
  suggest,

  // Batch operations
  batchSuggest,

  // Cost estimation
  estimateCosts,

  // Utilities
  getModelSpecs,
  isKimiAvailable,

  // Direct execution (advanced)
  executeWithKimi,
  executeWithClaude,

  // Constants
  MODEL_SPECS,
  TASK_PATTERNS
};
