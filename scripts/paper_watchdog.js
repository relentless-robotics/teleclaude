#!/usr/bin/env node
/**
 * Paper Engine Watchdog
 *
 * Monitors the Rithmic paper trading engine and auto-restarts on crash/disconnect.
 *
 * Monitors:
 *   1. Python process liveness (run_paper in process list)
 *   2. QCC /api/health — hb_rtt_ms > 5000 or null for >2 min triggers restart
 *   3. ForcedLogout (template 77) in paper engine logs — 30s wait before restart
 *   4. Crash loop guard — >5 restarts in 30 min triggers backoff + user alert
 *
 * CRITICAL: Checks for existing Rithmic connections (netstat 160.79.104) before
 * launching. Only 1 Rithmic connection per account is allowed.
 *
 * Usage:
 *   node scripts/paper_watchdog.js
 *   node scripts/paper_watchdog.js --dry-run   (no restarts, only logging)
 */

'use strict';

const { execSync, exec } = require('child_process');
const fs   = require('fs');
const http = require('http');
const path = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────
const TELECLAUDE_DIR  = path.join(__dirname, '..');
const LVL3_DIR        = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant';
const LOG_DIR         = path.join(LVL3_DIR, 'live_trading', 'logs');
const PAPER_LOG       = path.join(LOG_DIR, 'paper.log');
const PAPER_ERR_LOG   = path.join(LOG_DIR, 'paper_err.log');
const WATCHDOG_LOG    = path.join(TELECLAUDE_DIR, 'logs', 'paper_watchdog.log');
const STATE_FILE      = path.join(TELECLAUDE_DIR, '.paper_watchdog_state.json');

// ── Config ─────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');

const QCC_URL               = 'http://localhost:3456/api/health';
const QCC_POLL_INTERVAL_MS  = 30_000;   // Check QCC every 30 s
const LOG_TAIL_INTERVAL_MS  = 10_000;   // Tail logs every 10 s
const PROC_CHECK_INTERVAL_MS = 20_000;  // Process liveness every 20 s

const QCC_RTT_THRESHOLD_MS  = 5_000;   // hb_rtt_ms above this = unhealthy
const QCC_NULL_TIMEOUT_MS   = 120_000; // null hb_rtt for >2 min = trigger restart
const FORCED_LOGOUT_WAIT_MS = 30_000;  // Wait 30 s after ForcedLogout before restart
const KILL_GRACE_MS         = 5_000;   // Wait 5 s after kill before relaunch

const CRASH_LOOP_WINDOW_MS   = 1_800_000; // 30-minute window
const CRASH_LOOP_THRESHOLD   = 5;         // >5 restarts in window = backoff
const CRASH_LOOP_BACKOFF_MS  = 600_000;   // 10-minute backoff
const RITHMIC_IP_FRAGMENT    = '160.79.104';

// ── State ──────────────────────────────────────────────────────────────────
let restartTimestamps   = [];   // epoch ms of each restart
let qccNullSince        = null; // Date.now() when hb_rtt first went null/missing
let forcedLogoutPending = false;
let forcedLogoutTimer   = null;
let inBackoff           = false;
let backoffAlertSent    = false;
let lastLogSize         = 0;    // Track log file offset to avoid re-scanning old lines
let isShuttingDown      = false;

// Interval handles
let qccInterval  = null;
let logInterval  = null;
let procInterval = null;

// ── Logging ────────────────────────────────────────────────────────────────
const logsDir = path.dirname(WATCHDOG_LOG);
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(WATCHDOG_LOG, line + '\n'); } catch (_) {}
}

// ── State persistence ──────────────────────────────────────────────────────
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      restartTimestamps: restartTimestamps.slice(-20),
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (_) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      restartTimestamps = (s.restartTimestamps || []).map(t => new Date(t).getTime
        ? new Date(t).getTime() : t);
    }
  } catch (_) {}
}

// ── Discord alerts ─────────────────────────────────────────────────────────
const { notify } = require(path.join(TELECLAUDE_DIR, 'utils', 'webhook_notifier'));

async function alert(type, title, description, fields = []) {
  log(`[ALERT:${type.toUpperCase()}] ${title} — ${description}`);
  try {
    await notify(type, title, description, fields);
  } catch (e) {
    log(`Discord alert failed: ${e.message}`);
  }
}

// ── Process detection ──────────────────────────────────────────────────────
/**
 * Returns the PID(s) of any python process running run_paper, or empty array.
 * Uses WMIC on Windows.
 */
function findPaperProcesses() {
  try {
    // WMIC returns a table; filter by CommandLine containing run_paper
    const out = execSync(
      'wmic process where "Name=\'python.exe\' or Name=\'python3.exe\'" get ProcessId,CommandLine /format:csv 2>NUL',
      { timeout: 10_000, windowsHide: true }
    ).toString();

    const pids = [];
    for (const line of out.split('\n')) {
      if (line.toLowerCase().includes('run_paper')) {
        const parts = line.split(',');
        // CSV columns: Node, CommandLine, ProcessId
        const pid = parseInt(parts[parts.length - 1]?.trim(), 10);
        if (!isNaN(pid)) pids.push(pid);
      }
    }
    return pids;
  } catch (e) {
    log(`findPaperProcesses error: ${e.message}`);
    return [];
  }
}

function isPaperRunning() {
  return findPaperProcesses().length > 0;
}

// ── Rithmic connection check ───────────────────────────────────────────────
/**
 * Returns true if any TCP connection to Rithmic IP range exists.
 * CRITICAL: Only 1 connection allowed per account.
 */
function hasRithmicConnection() {
  try {
    const out = execSync('netstat -n 2>NUL', { timeout: 10_000, windowsHide: true }).toString();
    return out.includes(RITHMIC_IP_FRAGMENT);
  } catch (e) {
    log(`netstat check error: ${e.message}`);
    return false; // Assume no connection on error (safer to proceed)
  }
}

// ── Kill stale paper processes ─────────────────────────────────────────────
function killPaperProcesses() {
  const pids = findPaperProcesses();
  if (pids.length === 0) {
    log('No paper processes found to kill.');
    return;
  }
  for (const pid of pids) {
    try {
      log(`Killing stale paper process PID ${pid}...`);
      execSync(`taskkill /PID ${pid} /F 2>NUL`, { timeout: 5_000, windowsHide: true });
      log(`Killed PID ${pid}`);
    } catch (e) {
      log(`Failed to kill PID ${pid}: ${e.message}`);
    }
  }
}

// ── Launch paper engine ────────────────────────────────────────────────────
function launchPaperEngine() {
  if (DRY_RUN) {
    log('[DRY-RUN] Would launch paper engine — skipping actual launch.');
    return;
  }

  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
  }

  // PowerShell command: hidden window, redirect stdout+stderr to log files
  const psCmd = [
    'Start-Process', 'python',
    `-ArgumentList '-m live_trading.run_paper --paper'`,
    `-WorkingDirectory '${LVL3_DIR}'`,
    `-RedirectStandardOutput '${PAPER_LOG}'`,
    `-RedirectStandardError '${PAPER_ERR_LOG}'`,
    '-WindowStyle Hidden'
  ].join(' ');

  const fullCmd = `powershell -NonInteractive -Command "${psCmd}"`;

  log(`Launching: ${fullCmd}`);
  try {
    execSync(fullCmd, { timeout: 15_000, windowsHide: true });
    log('Paper engine launch command issued.');
    // Reset log offset so we start tailing from where the new process writes
    lastLogSize = fs.existsSync(PAPER_LOG) ? fs.statSync(PAPER_LOG).size : 0;
  } catch (e) {
    log(`Launch failed: ${e.message}`);
    alert('error', 'Paper Watchdog: Launch Failed',
      `Failed to start paper engine: ${e.message}`);
  }
}

// ── Crash loop guard ───────────────────────────────────────────────────────
function isCrashLoop() {
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter(t => now - t < CRASH_LOOP_WINDOW_MS);
  return restartTimestamps.length >= CRASH_LOOP_THRESHOLD;
}

// ── Core restart logic ─────────────────────────────────────────────────────
async function triggerRestart(reason) {
  if (isShuttingDown) return;
  if (inBackoff) {
    log(`Restart requested (${reason}) but in backoff — skipping.`);
    return;
  }

  // Crash loop check
  if (isCrashLoop()) {
    if (!backoffAlertSent) {
      backoffAlertSent = true;
      await alert('error',
        'Paper Watchdog: Crash Loop',
        `Paper engine has restarted ${restartTimestamps.length} times in 30 min. ` +
        `Backing off for ${CRASH_LOOP_BACKOFF_MS / 60000} min. Manual inspection required.`,
        [
          { name: 'Last Reason', value: reason },
          { name: 'Restart Count', value: String(restartTimestamps.length) }
        ]
      );
    }
    inBackoff = true;
    log(`CRASH LOOP: Entering backoff for ${CRASH_LOOP_BACKOFF_MS / 1000}s`);
    setTimeout(() => {
      inBackoff = false;
      backoffAlertSent = false;
      restartTimestamps = [];
      log('Backoff complete — watchdog resuming normal monitoring.');
    }, CRASH_LOOP_BACKOFF_MS);
    return;
  }

  log(`=== RESTART TRIGGERED: ${reason} ===`);

  // 1. Kill stale processes
  killPaperProcesses();

  // 2. Wait for process + Rithmic connection to drop
  log(`Waiting ${KILL_GRACE_MS / 1000}s for process and Rithmic connection to close...`);
  await sleep(KILL_GRACE_MS);

  // 3. Verify Rithmic connection is gone
  if (hasRithmicConnection()) {
    log('WARNING: Rithmic connection still active after grace period. Waiting another 10s...');
    await sleep(10_000);
    if (hasRithmicConnection()) {
      await alert('warning',
        'Paper Watchdog: Rithmic Still Connected',
        'Rithmic connection persists after kill. Skipping relaunch to avoid duplicate session. ' +
        'Check for zombie processes manually.',
        [{ name: 'Reason', value: reason }]
      );
      log('Skipping relaunch — Rithmic still connected. Will retry on next cycle.');
      return;
    }
  }

  // 4. Record restart and launch
  restartTimestamps.push(Date.now());
  saveState();

  await alert('warning',
    'Paper Watchdog: Restarting Engine',
    `Paper engine restarting. Reason: **${reason}**`,
    [
      { name: 'Restart #', value: String(restartTimestamps.length) },
      { name: 'Window', value: '30 min' },
      { name: 'Threshold', value: String(CRASH_LOOP_THRESHOLD) }
    ]
  );

  launchPaperEngine();

  // 5. Verify it came up after 15s
  await sleep(15_000);
  if (isPaperRunning()) {
    log('Paper engine confirmed running after restart.');
    await alert('success',
      'Paper Watchdog: Engine Restarted',
      `Paper engine successfully restarted. Reason was: ${reason}`,
      [{ name: 'Restart #', value: String(restartTimestamps.length) }]
    );
    // Reset QCC null timer on successful restart
    qccNullSince = null;
    forcedLogoutPending = false;
    clearTimeout(forcedLogoutTimer);
    forcedLogoutTimer = null;
  } else {
    log('WARNING: Paper engine did NOT come up after 15s.');
    await alert('error',
      'Paper Watchdog: Engine Did Not Start',
      `Paper engine failed to start after restart attempt. Reason was: ${reason}. ` +
      `Manual intervention may be required.`
    );
  }
}

// ── QCC Health Check ───────────────────────────────────────────────────────
function fetchQccHealth() {
  return new Promise((resolve) => {
    const req = http.get(QCC_URL, { timeout: 5_000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function checkQcc() {
  if (isShuttingDown || inBackoff) return;

  const health = await fetchQccHealth();

  if (!health) {
    log('QCC unreachable — skipping QCC check this cycle.');
    return;
  }

  const paperState = health.paper_engine || health.paperEngine || {};
  const rtt = paperState.hb_rtt_ms ?? paperState.hbRttMs ?? null;

  // Case 1: hb_rtt_ms is null or missing (paper engine not reporting)
  if (rtt === null || rtt === undefined) {
    if (!qccNullSince) {
      qccNullSince = Date.now();
      log(`QCC: paper_engine hb_rtt_ms is null — starting ${QCC_NULL_TIMEOUT_MS / 1000}s timer.`);
    } else {
      const elapsed = Date.now() - qccNullSince;
      log(`QCC: hb_rtt_ms still null — elapsed ${Math.round(elapsed / 1000)}s / ${QCC_NULL_TIMEOUT_MS / 1000}s threshold.`);
      if (elapsed >= QCC_NULL_TIMEOUT_MS) {
        qccNullSince = null;
        // Double-check process is also dead before restarting
        if (!isPaperRunning()) {
          await triggerRestart('QCC: hb_rtt_ms null >2min + process dead');
        } else {
          log('QCC hb_rtt null but process is alive — may be calibrating. Resetting timer.');
          qccNullSince = Date.now(); // Give it another pass
        }
      }
    }
    return;
  }

  // hb_rtt is reporting — reset null timer
  if (qccNullSince) {
    log(`QCC: hb_rtt_ms recovered (${rtt}ms) — clearing null timer.`);
    qccNullSince = null;
  }

  // Case 2: RTT is above threshold
  if (rtt > QCC_RTT_THRESHOLD_MS) {
    log(`QCC: hb_rtt_ms=${rtt}ms exceeds threshold of ${QCC_RTT_THRESHOLD_MS}ms.`);
    // Only trigger if process is also confirmed dead/stuck
    if (!isPaperRunning()) {
      await triggerRestart(`QCC: hb_rtt_ms=${rtt}ms (>${QCC_RTT_THRESHOLD_MS}ms) + process dead`);
    } else {
      log('Process is alive despite high RTT — possible Rithmic slowdown. Monitoring.');
    }
  } else {
    log(`QCC OK: hb_rtt_ms=${rtt}ms`);
  }
}

// ── Log tail for ForcedLogout ──────────────────────────────────────────────
function checkLogs() {
  if (isShuttingDown || inBackoff) return;

  const logFile = fs.existsSync(PAPER_LOG) ? PAPER_LOG
    : fs.existsSync(PAPER_ERR_LOG) ? PAPER_ERR_LOG
    : null;

  if (!logFile) return;

  try {
    const stat = fs.statSync(logFile);
    const currentSize = stat.size;

    if (currentSize <= lastLogSize) return; // No new content

    // Read only new bytes since last check
    const fd = fs.openSync(logFile, 'r');
    const newBytes = currentSize - lastLogSize;
    const buf = Buffer.alloc(Math.min(newBytes, 65536)); // Cap at 64KB per cycle
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, lastLogSize);
    fs.closeSync(fd);
    lastLogSize = currentSize;

    const newContent = buf.slice(0, bytesRead).toString('utf8');

    // Detect ForcedLogout (Rithmic template 77)
    if (
      newContent.includes('ForcedLogout') ||
      newContent.includes('template_id: 77') ||
      newContent.includes('template_id=77') ||
      newContent.toLowerCase().includes('forced logout') ||
      newContent.includes('forcedlogout')
    ) {
      if (!forcedLogoutPending) {
        forcedLogoutPending = true;
        log('ForcedLogout (template 77) detected in paper log. Scheduling restart in 30s...');

        alert('warning',
          'Paper Watchdog: ForcedLogout Detected',
          'Rithmic sent ForcedLogout (template 77). Restarting engine in 30 seconds...',
          [{ name: 'Action', value: 'Auto-restart pending' }]
        );

        forcedLogoutTimer = setTimeout(async () => {
          forcedLogoutPending = false;
          forcedLogoutTimer = null;
          await triggerRestart('ForcedLogout (template 77) in paper.log');
        }, FORCED_LOGOUT_WAIT_MS);
      } else {
        log('ForcedLogout already pending restart — ignoring duplicate detection.');
      }
    }

    // Also detect clean crash indicators in log
    if (
      newContent.includes('Traceback (most recent call last)') ||
      newContent.includes('SystemExit') ||
      newContent.includes('KeyboardInterrupt') ||
      (newContent.includes('ERROR') && newContent.includes('live_trading'))
    ) {
      log('Exception/error detected in paper log (may be crash).');
      // Don't trigger immediately — let process check handle the actual restart
    }

  } catch (e) {
    log(`Log check error: ${e.message}`);
  }
}

// ── Process liveness check ─────────────────────────────────────────────────
async function checkProcess() {
  if (isShuttingDown || inBackoff) return;

  const alive = isPaperRunning();
  if (alive) {
    log('Process check: paper engine alive.');
    return;
  }

  log('Process check: paper engine NOT running.');

  // Cancel any pending ForcedLogout timer (process already dead)
  if (forcedLogoutPending) {
    clearTimeout(forcedLogoutTimer);
    forcedLogoutTimer = null;
    forcedLogoutPending = false;
  }

  await triggerRestart('Process not found in process list');
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Startup check ──────────────────────────────────────────────────────────
async function initialCheck() {
  log('=== Paper Engine Watchdog Starting ===');
  log(`LVL3 dir:      ${LVL3_DIR}`);
  log(`Paper log:     ${PAPER_LOG}`);
  log(`QCC endpoint:  ${QCC_URL}`);
  log(`Crash loop:    ${CRASH_LOOP_THRESHOLD} restarts / ${CRASH_LOOP_WINDOW_MS / 60000} min`);
  log(`Dry run:       ${DRY_RUN}`);

  loadState();

  const alive = isPaperRunning();
  const rithmic = hasRithmicConnection();

  log(`Initial state: paper_running=${alive}, rithmic_connected=${rithmic}`);

  if (alive) {
    log('Paper engine is already running — watchdog entering monitoring mode.');
    // Set lastLogSize to current file size so we only tail new content
    if (fs.existsSync(PAPER_LOG)) {
      lastLogSize = fs.statSync(PAPER_LOG).size;
      log(`Starting log tail at offset ${lastLogSize} bytes.`);
    }
    await alert('info',
      'Paper Watchdog: Started (Engine Running)',
      'Watchdog is now monitoring the paper engine. Engine was already running.',
      [{ name: 'Rithmic Connected', value: String(rithmic) }]
    );
  } else {
    log('Paper engine is NOT running on watchdog start. Waiting for first monitoring cycle.');
    // Don't auto-start on watchdog boot — wait for the first process check cycle
    // so the operator has a chance to start it manually if desired.
    await alert('warning',
      'Paper Watchdog: Started (Engine Down)',
      'Watchdog started but paper engine is not running. ' +
      'Engine will be started on first monitoring cycle in 20s.',
      [{ name: 'Rithmic Connected', value: String(rithmic) }]
    );
  }
}

// ── Shutdown ───────────────────────────────────────────────────────────────
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`${signal} received — watchdog shutting down (paper engine NOT killed).`);
  clearInterval(qccInterval);
  clearInterval(logInterval);
  clearInterval(procInterval);
  clearTimeout(forcedLogoutTimer);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  e => log(`Uncaught exception: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', e => log(`Unhandled rejection: ${e}`));

if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('SIGINT', () => shutdown('SIGINT'));
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  await initialCheck();

  // Stagger intervals to avoid all checks firing simultaneously
  qccInterval  = setInterval(checkQcc,    QCC_POLL_INTERVAL_MS);
  logInterval  = setInterval(checkLogs,   LOG_TAIL_INTERVAL_MS);
  procInterval = setInterval(checkProcess, PROC_CHECK_INTERVAL_MS);

  // Run first log check immediately to set offset
  checkLogs();

  log('Monitoring started.');
})();
