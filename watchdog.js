#!/usr/bin/env node
/**
 * TeleClaude Watchdog
 *
 * External process monitor that ensures the bridge stays alive.
 * Handles: crashes, freezes (heartbeat timeout), rapid crash loops.
 *
 * Usage: node watchdog.js
 * npm script: npm run watchdog
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const BRIDGE_SCRIPT = path.join(__dirname, 'index.js');
const HEARTBEAT_FILE = path.join(__dirname, '.heartbeat');
const WATCHDOG_LOG = path.join(__dirname, 'logs', 'watchdog.log');
const STATE_FILE = path.join(__dirname, '.watchdog-state.json');

const HEARTBEAT_TIMEOUT_MS = 120_000;    // 2 min no heartbeat from bridge = bridge process dead
const UNRESPONSIVE_TIMEOUT_MS = 900_000; // 15 min user waiting with no response = Claude frozen (was 5min, caused false positives)
const MIN_RESTART_DELAY_MS = 3_000;      // Minimum delay between restarts
const MAX_RESTART_DELAY_MS = 60_000;     // Max backoff delay
const CRASH_LOOP_WINDOW_MS = 300_000;    // 5 min window for crash loop detection
const CRASH_LOOP_THRESHOLD = 3;          // 3 crashes in window = pause
const CRASH_LOOP_COOLDOWN_MS = 120_000;  // 2 min cooldown after crash loop
const HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // Check heartbeat every 30s

// State
let child = null;
let restartCount = 0;
let crashTimestamps = [];
let currentDelay = MIN_RESTART_DELAY_MS;
let heartbeatCheckInterval = null;
let isShuttingDown = false;
let lastStartTime = null;

// Ensure logs directory exists
const logsDir = path.dirname(WATCHDOG_LOG);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(WATCHDOG_LOG, line + '\n');
  } catch (e) { /* ignore */ }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      restartCount,
      lastStartTime,
      crashTimestamps: crashTimestamps.slice(-10),
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      restartCount = state.restartCount || 0;
      crashTimestamps = (state.crashTimestamps || []).map(t => new Date(t).getTime());
    }
  } catch (e) { /* ignore */ }
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: Date.now(), claudeAlive: true }));
  } catch (e) { /* ignore */ }
}

/**
 * Read heartbeat state from bridge.
 * Returns { ts, claudeAlive, claudePid, pendingUserMsg, ... } or null.
 */
function getHeartbeatState() {
  try {
    if (fs.existsSync(HEARTBEAT_FILE)) {
      const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim();
      // Handle legacy format (plain timestamp)
      if (raw.match(/^\d+$/)) return { ts: parseInt(raw, 10), legacy: true };
      return JSON.parse(raw);
    }
  } catch (e) { /* ignore */ }
  return null;
}

function isInCrashLoop() {
  const now = Date.now();
  // Clean old timestamps
  crashTimestamps = crashTimestamps.filter(t => now - t < CRASH_LOOP_WINDOW_MS);
  return crashTimestamps.length >= CRASH_LOOP_THRESHOLD;
}

function startBridge() {
  if (isShuttingDown) return;
  if (child) {
    log('Bridge already running, skipping start');
    return;
  }

  // Check crash loop
  if (isInCrashLoop()) {
    log(`CRASH LOOP DETECTED (${crashTimestamps.length} crashes in ${CRASH_LOOP_WINDOW_MS / 1000}s). Cooling down for ${CRASH_LOOP_COOLDOWN_MS / 1000}s...`);
    setTimeout(() => {
      crashTimestamps = []; // Reset after cooldown
      currentDelay = MIN_RESTART_DELAY_MS;
      startBridge();
    }, CRASH_LOOP_COOLDOWN_MS);
    return;
  }

  restartCount++;
  lastStartTime = Date.now();
  writeHeartbeat(); // Initial heartbeat so we don't immediately timeout

  const isRestart = restartCount > 1;
  log(`${isRestart ? 'RESTARTING' : 'Starting'} bridge (attempt #${restartCount})...`);

  // Set env var so the bridge knows it's under watchdog supervision
  const env = {
    ...process.env,
    TELECLAUDE_WATCHDOG: '1',
    TELECLAUDE_HEARTBEAT_FILE: HEARTBEAT_FILE,
    TELECLAUDE_RESTART_COUNT: String(restartCount),
    TELECLAUDE_IS_RESTART: isRestart ? '1' : '0'
  };

  child = spawn('node', [BRIDGE_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: __dirname,
    windowsHide: true,
  });

  log(`Bridge PID: ${child.pid}`);
  saveState();

  // Pipe stdout/stderr
  child.stdout.on('data', (data) => {
    const lines = data.toString().trim();
    if (lines) {
      // Print to console (watchdog terminal)
      process.stdout.write(data);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().trim();
    if (lines) {
      process.stderr.write(data);
      log(`STDERR: ${lines.slice(0, 500)}`);
    }
  });

  child.on('exit', (code, signal) => {
    const uptime = lastStartTime ? Math.round((Date.now() - lastStartTime) / 1000) : 0;
    log(`Bridge exited: code=${code}, signal=${signal}, uptime=${uptime}s`);
    child = null;

    if (isShuttingDown) {
      log('Shutdown requested, not restarting.');
      process.exit(0);
      return;
    }

    // Track crash for loop detection
    crashTimestamps.push(Date.now());
    saveState();

    // Exponential backoff: 3s -> 6s -> 12s -> 24s -> 48s -> 60s (cap)
    currentDelay = Math.min(currentDelay * 2, MAX_RESTART_DELAY_MS);
    // If uptime was >60s, reset backoff (it wasn't an instant crash)
    if (uptime > 60) {
      currentDelay = MIN_RESTART_DELAY_MS;
    }

    log(`Auto-restarting bridge in ${currentDelay / 1000}s (backoff)...`);
    setTimeout(startBridge, currentDelay);
  });

  child.on('error', (err) => {
    log(`Bridge spawn error: ${err.message}`);
    child = null;
    crashTimestamps.push(Date.now());
    setTimeout(startBridge, currentDelay);
  });

  // Start heartbeat monitoring
  startHeartbeatMonitor();
}

function startHeartbeatMonitor() {
  if (heartbeatCheckInterval) {
    clearInterval(heartbeatCheckInterval);
  }

  heartbeatCheckInterval = setInterval(() => {
    if (!child || isShuttingDown) return;

    const state = getHeartbeatState();
    const now = Date.now();

    if (!state) return; // No heartbeat file yet, bridge is starting up

    const heartbeatAge = now - (state.ts || 0);

    // REASON 1: Bridge process itself is dead (heartbeat file stopped updating)
    // This catches a frozen Node event loop or crashed bridge.
    if (heartbeatAge > HEARTBEAT_TIMEOUT_MS) {
      log(`BRIDGE DEAD: Heartbeat stale for ${Math.round(heartbeatAge / 1000)}s. Bridge process is frozen/crashed.`);
      forceRestartBridge('bridge_dead');
      return;
    }

    // REASON 2: Claude child process is dead (bridge is alive but Claude isn't)
    if (state.claudeAlive === false && !state.legacy) {
      log('CLAUDE DEAD: Bridge reports Claude process is not running.');
      // Don't force-kill bridge — it should handle this internally.
      // Only log; the bridge's own exit handler should restart Claude.
      return;
    }

    // REASON 3: User sent a message and Claude hasn't responded for a long time.
    // This is the real "frozen Claude" case — bridge is alive, Claude exists, but isn't responding.
    if (state.pendingUserMsg && !state.legacy) {
      const waitTime = now - (state.lastUserMsg || 0);
      if (waitTime > UNRESPONSIVE_TIMEOUT_MS) {
        log(`CLAUDE UNRESPONSIVE: User waiting ${Math.round(waitTime / 1000)}s with no response. Restarting.`);
        forceRestartBridge('claude_unresponsive');
        return;
      }
    }

    // Otherwise: everything is fine. Bridge is alive, Claude is alive,
    // and either no user is waiting or Claude is still working on a response.
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

function forceRestartBridge(reason) {
  if (isShuttingDown) return;
  log(`Force restarting bridge (reason: ${reason})...`);

  if (child) {
    try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (child) {
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        child = null;
      }
    }, 5000);
  } else {
    // No child running, just start
    crashTimestamps.push(Date.now());
    currentDelay = Math.min(currentDelay * 2, MAX_RESTART_DELAY_MS);
    log(`Scheduling restart in ${currentDelay / 1000}s...`);
    setTimeout(startBridge, currentDelay);
  }
}

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`${signal} received. Shutting down watchdog...`);

  if (heartbeatCheckInterval) {
    clearInterval(heartbeatCheckInterval);
  }

  if (child) {
    log('Sending SIGTERM to bridge...');
    child.kill('SIGTERM');

    // Force kill after 10s
    setTimeout(() => {
      if (child) {
        log('Bridge did not exit gracefully, force killing...');
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }
      process.exit(0);
    }, 10_000);
  } else {
    process.exit(0);
  }
}

// Shutdown handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log(`Watchdog uncaught exception: ${e.message}\n${e.stack}`);
});
process.on('unhandledRejection', (e) => {
  log(`Watchdog unhandled rejection: ${e}`);
});

// Windows-specific: handle Ctrl+C
if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('SIGINT', () => shutdown('SIGINT'));
}

// ── Emergency Discord Alert (works even when bridge is dead) ────────────────
// Uses raw Discord API with bot token — independent of the bridge process
function sendEmergencyAlert(message) {
  try {
    // Load .env for DISCORD_TOKEN and ALLOWED_USERS
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    const env = {};
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) env[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
    }
    const token = env.DISCORD_TOKEN;
    const userId = (env.ALLOWED_USERS || '').split(',')[0]?.trim();
    if (!token || !userId) return;

    const https = require('https');

    // Open DM channel with user
    const dmReq = https.request({
      hostname: 'discord.com',
      path: '/api/v10/users/@me/channels',
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    }, (dmRes) => {
      let data = '';
      dmRes.on('data', (c) => data += c);
      dmRes.on('end', () => {
        try {
          const channel = JSON.parse(data);
          if (!channel.id) return;

          // Send the alert message
          const msgBody = JSON.stringify({ content: message });
          const msgReq = https.request({
            hostname: 'discord.com',
            path: `/api/v10/channels/${channel.id}/messages`,
            method: 'POST',
            headers: {
              'Authorization': `Bot ${token}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(msgBody),
            },
          }, () => {});
          msgReq.on('error', () => {});
          msgReq.write(msgBody);
          msgReq.end();
        } catch (e) { /* ignore */ }
      });
    });
    dmReq.on('error', () => {});
    const dmBody = JSON.stringify({ recipient_id: userId });
    dmReq.write(dmBody);
    dmReq.end();
  } catch (e) {
    log(`Emergency alert failed: ${e.message}`);
  }
}

// Alert on crash loops
let crashAlertSent = false;
const originalIsInCrashLoop = isInCrashLoop;
isInCrashLoop = function() {
  const result = originalIsInCrashLoop();
  if (result && !crashAlertSent) {
    crashAlertSent = true;
    sendEmergencyAlert(
      '**WATCHDOG ALERT: Crash loop detected**\n' +
      `The bridge has crashed ${CRASH_LOOP_THRESHOLD}+ times in ${CRASH_LOOP_WINDOW_MS / 1000}s.\n` +
      `Cooling down for ${CRASH_LOOP_COOLDOWN_MS / 1000}s before retrying.\n\n` +
      'SSH in to investigate: `ssh Footb@100.109.245.73`'
    );
    // Reset alert after cooldown
    setTimeout(() => { crashAlertSent = false; }, CRASH_LOOP_COOLDOWN_MS);
  }
  return result;
};

// Main
log('=== TeleClaude Watchdog Starting ===');
log(`Bridge script: ${BRIDGE_SCRIPT}`);
log(`Heartbeat timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s`);
log(`Crash loop threshold: ${CRASH_LOOP_THRESHOLD} in ${CRASH_LOOP_WINDOW_MS / 1000}s`);
loadState();
if (restartCount > 0) {
  log(`Resuming from previous state (${restartCount} total starts)`);
}
startBridge();
