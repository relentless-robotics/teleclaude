/**
 * Cursor CLI Fallback Manager
 *
 * Routes tasks to Cursor CLI when:
 * - Claude rate limits are hit
 * - Simple tasks that don't need full Claude
 * - User explicitly requests Cursor mode
 * - Budget is critical
 *
 * Cursor uses "auto" model which is FREE with Cursor Pro.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { cursorAgent, cursorAsk, cursorPlan, isCursorAvailable } = require('./cursor_cli');

// Configuration
const RESULTS_DIR = path.join(__dirname, '..', 'cursor_results');
const STATUS_FILE = path.join(RESULTS_DIR, 'current_status.json');
const FALLBACK_LOG = path.join(__dirname, '..', 'logs', 'cursor_fallback.log');

// Task routing configuration
const TASK_ROUTING = {
  // Tasks that should ALWAYS go to Cursor (simple, saves tokens)
  cursorPreferred: [
    'file search',
    'find file',
    'glob',
    'read file',
    'list files',
    'search code',
    'grep',
    'explain code',
    'what does',
    'code review',
    'refactor',
    'format code',
    'lint',
    'simple edit',
    'add comment',
    'rename variable'
  ],

  // Tasks that MUST stay with Claude (need MCP or complex reasoning)
  claudeRequired: [
    'send message',
    'discord',
    'telegram',
    'remember',
    'memory',
    'browser',
    'playwright',
    'login',
    'authenticate',
    'webhook',
    'api call',
    'complex reasoning',
    'multi-system'
  ]
};

// Fallback state
let fallbackState = {
  enabled: false,
  reason: null,
  activeTasks: [],
  completedTasks: [],
  rateLimitUntil: null
};

/**
 * Ensure directories exist
 */
function ensureDirs() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const logsDir = path.dirname(FALLBACK_LOG);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

/**
 * Log fallback activity
 */
function log(message) {
  ensureDirs();
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(FALLBACK_LOG, entry);
  console.log(`[CursorFallback] ${message}`);
}

/**
 * Check if Cursor is available and ready
 */
function checkCursorReady() {
  if (!isCursorAvailable()) {
    return { ready: false, error: 'Cursor CLI not installed or not in PATH' };
  }
  return { ready: true };
}

/**
 * Determine if a task should be routed to Cursor
 */
function shouldUseCursor(task, options = {}) {
  const taskLower = task.toLowerCase();

  // Force Cursor mode
  if (options.forceCursor) {
    return { useCursor: true, reason: 'Forced by user' };
  }

  // Rate limit active
  if (fallbackState.rateLimitUntil && Date.now() < fallbackState.rateLimitUntil) {
    // Check if task requires Claude
    const requiresClaude = TASK_ROUTING.claudeRequired.some(kw => taskLower.includes(kw));
    if (requiresClaude) {
      return { useCursor: false, reason: 'Task requires Claude MCP access', blocked: true };
    }
    return { useCursor: true, reason: 'Rate limit active' };
  }

  // Budget critical
  if (options.budgetCritical) {
    const requiresClaude = TASK_ROUTING.claudeRequired.some(kw => taskLower.includes(kw));
    if (!requiresClaude) {
      return { useCursor: true, reason: 'Budget critical, using free Cursor' };
    }
  }

  // Check if task is Cursor-preferred
  const cursorPreferred = TASK_ROUTING.cursorPreferred.some(kw => taskLower.includes(kw));
  if (cursorPreferred) {
    return { useCursor: true, reason: 'Task type prefers Cursor' };
  }

  // Check if task requires Claude
  const requiresClaude = TASK_ROUTING.claudeRequired.some(kw => taskLower.includes(kw));
  if (requiresClaude) {
    return { useCursor: false, reason: 'Task requires Claude' };
  }

  // Default to Claude for unknown tasks
  return { useCursor: false, reason: 'Default to Claude' };
}

/**
 * Activate rate limit fallback mode
 */
function activateRateLimitFallback(resetTime = null) {
  const resetMs = resetTime ? new Date(resetTime).getTime() : Date.now() + 3600000; // Default 1 hour
  fallbackState.rateLimitUntil = resetMs;
  fallbackState.enabled = true;
  fallbackState.reason = 'Rate limit';

  log(`Rate limit fallback activated until ${new Date(resetMs).toISOString()}`);
  saveState();

  return {
    activated: true,
    until: new Date(resetMs).toISOString(),
    message: `Cursor fallback mode activated. Rate limit resets at ${new Date(resetMs).toLocaleTimeString()}`
  };
}

/**
 * Deactivate fallback mode
 */
function deactivateFallback() {
  fallbackState.enabled = false;
  fallbackState.reason = null;
  fallbackState.rateLimitUntil = null;

  log('Fallback mode deactivated');
  saveState();

  return { deactivated: true };
}

/**
 * Run a task through Cursor
 */
async function runWithCursor(task, options = {}) {
  const {
    mode = 'agent',
    workingDir = process.cwd(),
    timeout = 300000, // 5 minutes
    taskId = `task_${Date.now()}`
  } = options;

  ensureDirs();

  const taskInfo = {
    id: taskId,
    task,
    mode,
    startTime: new Date().toISOString(),
    status: 'running'
  };

  fallbackState.activeTasks.push(taskInfo);
  saveState();

  log(`Starting Cursor task: ${taskId} - ${task.slice(0, 50)}...`);

  try {
    let result;

    switch (mode) {
      case 'ask':
        result = await cursorAsk(task, workingDir);
        break;
      case 'plan':
        result = await cursorPlan(task, workingDir);
        break;
      case 'agent':
      default:
        result = await cursorAgent(task, workingDir);
    }

    // Save result to file
    const resultFile = path.join(RESULTS_DIR, `${taskId}.json`);
    const resultData = {
      id: taskId,
      task,
      mode,
      startTime: taskInfo.startTime,
      endTime: new Date().toISOString(),
      status: 'completed',
      result
    };

    fs.writeFileSync(resultFile, JSON.stringify(resultData, null, 2));

    // Update state
    fallbackState.activeTasks = fallbackState.activeTasks.filter(t => t.id !== taskId);
    fallbackState.completedTasks.push({
      id: taskId,
      completedAt: resultData.endTime,
      success: true
    });
    saveState();

    log(`Cursor task completed: ${taskId}`);

    return {
      success: true,
      taskId,
      result,
      resultFile
    };

  } catch (error) {
    // Update state
    fallbackState.activeTasks = fallbackState.activeTasks.filter(t => t.id !== taskId);
    fallbackState.completedTasks.push({
      id: taskId,
      completedAt: new Date().toISOString(),
      success: false,
      error: error.message
    });
    saveState();

    log(`Cursor task failed: ${taskId} - ${error.message}`);

    return {
      success: false,
      taskId,
      error: error.message
    };
  }
}

/**
 * Run a task, automatically choosing Cursor or Claude
 */
async function smartRoute(task, options = {}) {
  const decision = shouldUseCursor(task, options);

  if (decision.blocked) {
    return {
      routed: false,
      blocked: true,
      reason: decision.reason,
      message: 'Task requires Claude but rate limit is active. Please wait or solve manually.'
    };
  }

  if (decision.useCursor) {
    log(`Smart routing to Cursor: ${decision.reason}`);
    const result = await runWithCursor(task, options);
    return {
      routed: true,
      target: 'cursor',
      reason: decision.reason,
      ...result
    };
  }

  // Return info for Claude to handle
  return {
    routed: false,
    target: 'claude',
    reason: decision.reason
  };
}

/**
 * Get pending results (for main bridge to pick up)
 */
function getPendingResults() {
  ensureDirs();

  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json') && f !== 'current_status.json');
  const results = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf-8'));
      if (data.status === 'completed' && !data.reported) {
        results.push(data);
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return results;
}

/**
 * Mark a result as reported
 */
function markResultReported(taskId) {
  const resultFile = path.join(RESULTS_DIR, `${taskId}.json`);
  if (fs.existsSync(resultFile)) {
    const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    data.reported = true;
    data.reportedAt = new Date().toISOString();
    fs.writeFileSync(resultFile, JSON.stringify(data, null, 2));
  }
}

/**
 * Save current state
 */
function saveState() {
  ensureDirs();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(fallbackState, null, 2));
}

/**
 * Load state from file
 */
function loadState() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      fallbackState = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));

      // Check if rate limit has expired
      if (fallbackState.rateLimitUntil && Date.now() > fallbackState.rateLimitUntil) {
        deactivateFallback();
      }
    }
  } catch (e) {
    // Start fresh
  }
}

/**
 * Get current fallback status
 */
function getStatus() {
  loadState();

  const cursorReady = checkCursorReady();

  return {
    cursorAvailable: cursorReady.ready,
    cursorError: cursorReady.error,
    fallbackEnabled: fallbackState.enabled,
    fallbackReason: fallbackState.reason,
    rateLimitUntil: fallbackState.rateLimitUntil
      ? new Date(fallbackState.rateLimitUntil).toISOString()
      : null,
    activeTasks: fallbackState.activeTasks.length,
    completedTasks: fallbackState.completedTasks.length,
    pendingResults: getPendingResults().length
  };
}

/**
 * Clean up old results
 */
function cleanupResults(olderThanDays = 7) {
  ensureDirs();

  const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
  let cleaned = 0;

  for (const file of files) {
    const filepath = path.join(RESULTS_DIR, file);
    const stats = fs.statSync(filepath);
    if (stats.mtimeMs < cutoff) {
      fs.unlinkSync(filepath);
      cleaned++;
    }
  }

  return { cleaned };
}

/**
 * Format result for Discord message
 */
function formatResultForDiscord(result) {
  if (!result.success) {
    return `**Cursor Task Failed**\nTask: ${result.task?.slice(0, 100)}...\nError: ${result.error}`;
  }

  const output = result.result || '';
  const truncated = output.length > 1500 ? output.slice(0, 1500) + '...(truncated)' : output;

  return `**Cursor Task Completed**\nTask: ${result.task?.slice(0, 100)}...\n\n\`\`\`\n${truncated}\n\`\`\``;
}

// Initialize on load
loadState();

module.exports = {
  // Core functions
  shouldUseCursor,
  runWithCursor,
  smartRoute,

  // Rate limit handling
  activateRateLimitFallback,
  deactivateFallback,

  // Results management
  getPendingResults,
  markResultReported,
  formatResultForDiscord,

  // Status and maintenance
  getStatus,
  checkCursorReady,
  cleanupResults,

  // State
  getState: () => fallbackState,

  // Task routing config (for customization)
  TASK_ROUTING
};
