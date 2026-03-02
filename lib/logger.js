/**
 * Comprehensive Logging System for Claude Telegram Bridge
 *
 * Provides structured logging with timestamps for debugging:
 * - Main bridge activity (requests, responses, agent spawning)
 * - Background agent activity (tool calls, errors, completion)
 * - System events (process start/stop, errors, crashes)
 *
 * Log files are stored in /logs directory with date-based naming.
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Get current timestamp in ISO format
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Get today's date for log file naming
 */
function getDateString() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Get log file path for a specific category
 */
function getLogPath(category) {
  const dateStr = getDateString();
  return path.join(LOGS_DIR, `${category}-${dateStr}.log`);
}

/**
 * Write a log entry to a file
 */
function writeLog(category, level, message, data = null) {
  const timestamp = getTimestamp();
  const logPath = getLogPath(category);

  let entry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  if (data) {
    try {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      entry += `\n  DATA: ${dataStr}`;
    } catch (e) {
      entry += `\n  DATA: [Unable to serialize: ${e.message}]`;
    }
  }

  entry += '\n';

  // Append to log file
  fs.appendFileSync(logPath, entry, 'utf8');

  // Also log to console for real-time monitoring
  console.log(`[${category}] ${entry.trim()}`);
}

/**
 * Logger class for a specific component
 */
class Logger {
  constructor(category) {
    this.category = category;
  }

  info(message, data = null) {
    writeLog(this.category, 'INFO', message, data);
  }

  warn(message, data = null) {
    writeLog(this.category, 'WARN', message, data);
  }

  error(message, data = null) {
    writeLog(this.category, 'ERROR', message, data);
  }

  debug(message, data = null) {
    writeLog(this.category, 'DEBUG', message, data);
  }
}

// Pre-configured loggers for different components
const loggers = {
  // Main bridge process - tracks user messages, Claude interaction
  bridge: new Logger('bridge'),

  // Claude PTY process - tracks what Claude is doing
  claude: new Logger('claude'),

  // MCP server - tracks tool calls (send_to_telegram)
  mcp: new Logger('mcp'),

  // Agent activity - tracks background agent spawning and completion
  agent: new Logger('agent'),

  // System events - process lifecycle, crashes, recovery
  system: new Logger('system'),
};

/**
 * Log a user message received from Telegram
 */
function logUserMessage(userId, chatId, message) {
  loggers.bridge.info(`USER_MESSAGE received`, {
    userId,
    chatId,
    message: message.slice(0, 500) + (message.length > 500 ? '...' : ''),
    messageLength: message.length,
  });
}

/**
 * Log a message sent to Claude PTY
 */
function logClaudeInput(message) {
  loggers.claude.info(`INPUT sent to Claude`, {
    message: message.slice(0, 500) + (message.length > 500 ? '...' : ''),
    messageLength: message.length,
  });
}

/**
 * Log Claude PTY output
 */
function logClaudeOutput(output) {
  // Only log non-trivial output
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (clean.length > 0) {
    loggers.claude.debug(`OUTPUT from Claude PTY`, {
      output: clean.slice(0, 1000) + (clean.length > 1000 ? '...' : ''),
      outputLength: clean.length,
    });
  }
}

/**
 * Log Claude process lifecycle events
 */
function logClaudeStart() {
  loggers.system.info('Claude process STARTED');
}

function logClaudeExit(exitCode, signal) {
  loggers.system.warn('Claude process EXITED', { exitCode, signal });
}

/**
 * Log MCP tool calls
 */
function logMcpToolCall(toolName, args) {
  loggers.mcp.info(`TOOL_CALL: ${toolName}`, {
    arguments: args,
  });
}

function logMcpToolResult(toolName, success, result = null) {
  const level = success ? 'info' : 'error';
  loggers.mcp[level](`TOOL_RESULT: ${toolName}`, {
    success,
    result: result?.slice?.(0, 500) || result,
  });
}

/**
 * Log background agent activity
 */
function logAgentSpawned(taskDescription) {
  loggers.agent.info('AGENT_SPAWNED', {
    taskDescription: taskDescription.slice(0, 500),
  });
}

function logAgentProgress(status, details = null) {
  loggers.agent.info(`AGENT_PROGRESS: ${status}`, details);
}

function logAgentCompleted(result, duration = null) {
  loggers.agent.info('AGENT_COMPLETED', {
    resultPreview: result?.slice?.(0, 500) || String(result).slice(0, 500),
    durationMs: duration,
  });
}

function logAgentError(error) {
  loggers.agent.error('AGENT_ERROR', {
    error: error.message || error,
    stack: error.stack,
  });
}

/**
 * Log Telegram message sending
 */
function logTelegramSend(chatId, message) {
  loggers.bridge.info('TELEGRAM_SEND', {
    chatId,
    messagePreview: message.slice(0, 200),
    messageLength: message.length,
  });
}

function logTelegramSendError(chatId, error) {
  loggers.bridge.error('TELEGRAM_SEND_ERROR', {
    chatId,
    error: error.message || error,
  });
}

/**
 * Log system commands (kill, restart, etc)
 */
function logSystemCommand(command, details = null) {
  loggers.system.info(`COMMAND: ${command}`, details);
}

/**
 * Log unhandled errors
 */
function logUnhandledError(context, error) {
  loggers.system.error(`UNHANDLED_ERROR in ${context}`, {
    error: error.message || error,
    stack: error.stack,
  });
}

/**
 * Get recent log entries for debugging
 */
function getRecentLogs(category, lines = 50) {
  const logPath = getLogPath(category);
  try {
    if (!fs.existsSync(logPath)) {
      return `No logs found for ${category} today`;
    }
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.trim().split('\n');
    const recentLines = allLines.slice(-lines);
    return recentLines.join('\n');
  } catch (e) {
    return `Error reading logs: ${e.message}`;
  }
}

/**
 * Get all log files info
 */
function getLogFilesInfo() {
  try {
    const files = fs.readdirSync(LOGS_DIR);
    return files.map(f => {
      const stat = fs.statSync(path.join(LOGS_DIR, f));
      return {
        name: f,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });
  } catch (e) {
    return [];
  }
}

module.exports = {
  loggers,
  logUserMessage,
  logClaudeInput,
  logClaudeOutput,
  logClaudeStart,
  logClaudeExit,
  logMcpToolCall,
  logMcpToolResult,
  logAgentSpawned,
  logAgentProgress,
  logAgentCompleted,
  logAgentError,
  logTelegramSend,
  logTelegramSendError,
  logSystemCommand,
  logUnhandledError,
  getRecentLogs,
  getLogFilesInfo,
  LOGS_DIR,
};
