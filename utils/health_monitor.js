'use strict';
/**
 * health_monitor.js — Self-monitoring for autonomous Claude sessions.
 *
 * Checks usage limits and context health, triggers graceful shutdown
 * before hitting walls. Designed to be require()-able from any agent
 * or the main bridge.
 *
 * Usage:
 *   const health = require('./utils/health_monitor');
 *   const report = health.getHealthReport();
 *   if (health.shouldThrottle()) { /* slow down * / }
 *   const stop = health.startMonitoring(msg => sendToDiscord(msg));
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Thresholds (exported, tunable) ────────────────────────────────────────────

const THRESHOLDS = {
  HOURLY_OUTPUT_WARN: 0.60,       // 60% of hourly limit -> slow down
  HOURLY_OUTPUT_ALERT: 0.80,      // 80% -> alert user
  HOURLY_OUTPUT_CRITICAL: 0.90,   // 90% -> save state and wind down
  MAX_CONTEXT_COMPRESSIONS: 2,    // After 2 compressions -> save and restart
  CHECK_INTERVAL_MS: 10 * 60 * 1000, // Check every 10 minutes
};

// ── Paths ─────────────────────────────────────────────────────────────────────

const SCRAPER_SCRIPT = path.join(__dirname, 'claude_usage_scraper.js');
const USAGE_JSON = path.join(__dirname, '..', 'dashboard-app', 'data', 'claude_usage.json');

// ── Internal state ────────────────────────────────────────────────────────────

let _lastCheck = null;          // { timestamp, usageData, status }
let _lastAlertLevel = null;     // 'warn' | 'alert' | 'critical' — to avoid spamming
let _lastAlertTime = 0;         // epoch ms of last discord alert
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // Don't re-send same severity within 15 min

// ── Usage data retrieval ──────────────────────────────────────────────────────

/**
 * Run the scraper to refresh usage data, then read the output JSON.
 * If the scraper fails, falls back to reading the existing (possibly stale) file.
 * Returns the parsed usage object or null.
 */
function refreshUsageData() {
  // Try running the scraper as a subprocess (it writes to USAGE_JSON)
  try {
    execFileSync(process.execPath, [SCRAPER_SCRIPT], {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch (e) {
    // Scraper failed — fall through to read stale file
  }

  return readUsageFile();
}

/**
 * Read the cached usage JSON without re-running the scraper.
 * Returns parsed object or null.
 */
function readUsageFile() {
  try {
    if (fs.existsSync(USAGE_JSON)) {
      return JSON.parse(fs.readFileSync(USAGE_JSON, 'utf-8'));
    }
  } catch (e) {
    // Corrupt or missing — return null
  }
  return null;
}

// ── Core health check functions ───────────────────────────────────────────────

/**
 * Check usage health by running the scraper and comparing output tokens to limits.
 *
 * @returns {{ status: 'ok'|'warn'|'alert'|'critical'|'error', hourlyPct: number, dailyPct: number, message: string }}
 */
function checkUsageHealth() {
  const data = refreshUsageData();

  if (!data || !data.hourly || !data.limits) {
    _lastCheck = { timestamp: Date.now(), usageData: null, status: 'error' };
    return {
      status: 'error',
      hourlyPct: 0,
      dailyPct: 0,
      message: 'Could not read usage data — scraper may have failed.',
    };
  }

  const hourlyOutput = data.hourly.output || 0;
  const hourlyLimit = (data.limits.hourly && data.limits.hourly.outputLimit) || 1;
  const dailyOutput = (data.daily && data.daily.output) || 0;
  const dailyLimit = (data.limits.daily && data.limits.daily.outputLimit) || 1;

  const hourlyPct = hourlyOutput / hourlyLimit;
  const dailyPct = dailyOutput / dailyLimit;

  let status = 'ok';
  let message = `Usage nominal: ${Math.round(hourlyPct * 100)}% hourly, ${Math.round(dailyPct * 100)}% daily.`;

  if (hourlyPct >= THRESHOLDS.HOURLY_OUTPUT_CRITICAL) {
    status = 'critical';
    message = `CRITICAL: ${Math.round(hourlyPct * 100)}% of hourly output limit used. Save state and wind down immediately.`;
  } else if (hourlyPct >= THRESHOLDS.HOURLY_OUTPUT_ALERT) {
    status = 'alert';
    message = `ALERT: ${Math.round(hourlyPct * 100)}% of hourly output limit used. Limit new work, prepare to save state.`;
  } else if (hourlyPct >= THRESHOLDS.HOURLY_OUTPUT_WARN) {
    status = 'warn';
    message = `WARNING: ${Math.round(hourlyPct * 100)}% of hourly output limit used. Consider slowing down.`;
  }

  _lastCheck = { timestamp: Date.now(), usageData: data, status };

  return { status, hourlyPct, dailyPct, message };
}

/**
 * Check context health based on compression count.
 *
 * @param {number} compressionCount - Number of context compressions so far this session.
 * @returns {{ status: 'ok'|'warn'|'critical', compressionCount: number, maxCompressions: number, message: string }}
 */
function checkContextHealth(compressionCount) {
  const max = THRESHOLDS.MAX_CONTEXT_COMPRESSIONS;

  if (compressionCount >= max) {
    return {
      status: 'critical',
      compressionCount,
      maxCompressions: max,
      message: `Context compressed ${compressionCount}x (limit: ${max}). Save all state and restart session.`,
    };
  }

  if (compressionCount >= max - 1) {
    return {
      status: 'warn',
      compressionCount,
      maxCompressions: max,
      message: `Context compressed ${compressionCount}x — one more and session should restart. Flush state soon.`,
    };
  }

  return {
    status: 'ok',
    compressionCount,
    maxCompressions: max,
    message: `Context health OK (${compressionCount}/${max} compressions).`,
  };
}

/**
 * Combined health report: usage + context + recommendations.
 *
 * @param {number} [compressionCount=0] - Number of context compressions so far.
 * @returns {object} Full health report.
 */
function getHealthReport(compressionCount = 0) {
  const usage = checkUsageHealth();
  const context = checkContextHealth(compressionCount);

  // Overall status = worst of the two
  const statusRank = { ok: 0, warn: 1, alert: 2, critical: 3, error: 3 };
  const overallRank = Math.max(statusRank[usage.status] || 0, statusRank[context.status] || 0);
  const overall = ['ok', 'warn', 'alert', 'critical'][overallRank];

  const recommendations = [];

  if (usage.status === 'critical') {
    recommendations.push('Save all pending state via session_logger.flush() NOW.');
    recommendations.push('Stop spawning new agents or heavy operations.');
  } else if (usage.status === 'alert') {
    recommendations.push('Avoid spawning new background agents.');
    recommendations.push('Prepare to flush session state.');
  } else if (usage.status === 'warn') {
    recommendations.push('Reduce output verbosity. Prefer short responses.');
  }

  if (context.status === 'critical') {
    recommendations.push('Session has compressed too many times — restart after saving state.');
  } else if (context.status === 'warn') {
    recommendations.push('Flush memory state soon — next compression triggers restart recommendation.');
  }

  return {
    overall,
    usage,
    context,
    recommendations,
    lastCheck: _lastCheck ? _lastCheck.timestamp : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Quick boolean: should agents throttle before spawning new work?
 * Returns true if usage is at WARN level or above, or if context is critical.
 *
 * Uses cached data if available and < 5 minutes old to avoid running
 * the scraper on every call.
 */
function shouldThrottle() {
  // Use cached check if fresh enough (< 5 min)
  const CACHE_TTL = 5 * 60 * 1000;
  if (_lastCheck && (Date.now() - _lastCheck.timestamp) < CACHE_TTL) {
    return _lastCheck.status !== 'ok' && _lastCheck.status !== 'error';
  }

  const usage = checkUsageHealth();
  return usage.status !== 'ok' && usage.status !== 'error';
}

// ── Discord formatting ────────────────────────────────────────────────────────

/**
 * Format a health report into a Discord-ready message string.
 *
 * @param {object} report - Report from getHealthReport().
 * @returns {string}
 */
function formatDiscordAlert(report) {
  const icon = { ok: '[OK]', warn: '[WARN]', alert: '[ALERT]', critical: '[CRITICAL]' };
  const statusIcon = icon[report.overall] || '[???]';

  const lines = [
    `**Session Health ${statusIcon}**`,
    '',
    `**Usage:** ${report.usage.message}`,
    `  Hourly: ${Math.round(report.usage.hourlyPct * 100)}% | Daily: ${Math.round(report.usage.dailyPct * 100)}%`,
    `**Context:** ${report.context.message}`,
  ];

  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('**Recommendations:**');
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
  }

  if (report.usage.status === 'critical' || report.context.status === 'critical') {
    lines.push('');
    lines.push('**ACTION REQUIRED: Save state and wind down.**');
  }

  return lines.join('\n');
}

// ── Continuous monitoring ─────────────────────────────────────────────────────

/**
 * Start periodic health monitoring. Sends Discord alerts when thresholds
 * are crossed, respecting cooldowns to avoid spam.
 *
 * @param {function} discordSendFn - Async function that sends a string message to Discord.
 * @param {number} [compressionCount=0] - Initial compression count (caller should update via returned ref).
 * @returns {{ stop: function, getCompressionRef: function, setCompressionCount: function }}
 */
function startMonitoring(discordSendFn, compressionCount = 0) {
  let _compressions = compressionCount;
  let _stopped = false;

  async function tick() {
    if (_stopped) return;

    try {
      const report = getHealthReport(_compressions);

      // Decide whether to send an alert
      const shouldAlert = report.overall !== 'ok'
        && (report.overall !== _lastAlertLevel || (Date.now() - _lastAlertTime) > ALERT_COOLDOWN_MS);

      // Always alert on critical (even within cooldown if escalated)
      const isEscalation = report.overall === 'critical' && _lastAlertLevel !== 'critical';

      if (shouldAlert || isEscalation) {
        const msg = formatDiscordAlert(report);
        try {
          await discordSendFn(msg);
        } catch (e) {
          // Discord send failed — don't crash the monitor
          console.error('[health_monitor] Discord send failed:', e.message);
        }
        _lastAlertLevel = report.overall;
        _lastAlertTime = Date.now();
      }

      // If back to OK and we previously alerted, send an all-clear (once)
      if (report.overall === 'ok' && _lastAlertLevel && _lastAlertLevel !== 'ok') {
        try {
          await discordSendFn('**Session Health [OK]** — Usage back to normal levels.');
        } catch (e) {
          // Ignore
        }
        _lastAlertLevel = 'ok';
        _lastAlertTime = Date.now();
      }

      // On critical: attempt to flush session state
      if (report.overall === 'critical') {
        try {
          const logger = require('./session_logger');
          logger.logMilestone('Health monitor triggered critical state', [
            `Usage: ${report.usage.message}`,
            `Context: ${report.context.message}`,
          ]);
        } catch (e) {
          // Session logger unavailable — nothing we can do
        }
      }
    } catch (e) {
      console.error('[health_monitor] Tick error:', e.message);
    }
  }

  // Run first check immediately
  tick();

  const intervalId = setInterval(tick, THRESHOLDS.CHECK_INTERVAL_MS);

  return {
    stop() {
      _stopped = true;
      clearInterval(intervalId);
    },
    setCompressionCount(n) {
      _compressions = n;
    },
    getCompressionCount() {
      return _compressions;
    },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  THRESHOLDS,
  checkUsageHealth,
  checkContextHealth,
  getHealthReport,
  shouldThrottle,
  formatDiscordAlert,
  startMonitoring,
  get lastCheck() {
    return _lastCheck ? { ..._lastCheck } : null;
  },
};
