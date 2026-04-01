#!/usr/bin/env node
/**
 * smart_monitor.js — GPU and training health monitoring with MLflow logging.
 *
 * Improvements over simple GPU util snapshots:
 *   1. 5-minute rolling GPU utilisation window (avoids false alarms during data loading)
 *   2. Training log file growth check (last 30 min) — confirms training is progressing
 *   3. Power draw analysis (low util + high power = loading data, NOT dead)
 *   4. Alert only on CONFIRMED issues (multiple signals must agree)
 *   5. Logs all monitoring data to MLflow "Infrastructure" experiment
 *
 * Alert conditions (ALL must be true to fire):
 *   - GPU util avg < GPU_IDLE_THRESHOLD% over 5-minute window
 *   - Power draw < POWER_DEAD_WATTS W (not just loading)
 *   - Training log has NOT grown in the last LOG_STALE_MINUTES minutes
 *   - No alert sent for this node in last ALERT_COOLDOWN_MS milliseconds
 *
 * Usage:
 *   pm2 start compute/smart_monitor.ecosystem.js
 *   node compute/smart_monitor.js                    # one-shot check
 *   node compute/smart_monitor.js --status           # print rolling window state
 *   node compute/smart_monitor.js --reset-window     # clear all rolling data
 *
 * MLflow: logs to experiment "Infrastructure" every poll cycle.
 */

'use strict';

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { execSync, spawn } = require('child_process');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_DIR   = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'smart_monitor_state.json');
const LOG_FILE   = path.join(__dirname, 'smart_monitor.log');

const QCC_BASE   = `http://localhost:${process.env.QCC_PORT || 3456}`;

// Poll every 5 minutes (300s). Rolling window = 5 samples = 25 minutes of data.
const POLL_INTERVAL_MS    = parseInt(process.env.SM_POLL_MS      || '300000', 10);  // 5 min
const ROLLING_WINDOW_SIZE = parseInt(process.env.SM_WINDOW_SIZE  || '5',      10);  // 5 samples

// Alert thresholds
const GPU_IDLE_THRESHOLD  = parseFloat(process.env.SM_GPU_IDLE     || '5');    // % util
const POWER_DEAD_WATTS    = parseFloat(process.env.SM_POWER_DEAD   || '50');   // Watts (loading data uses >100W even at 0% util)
const LOG_STALE_MINUTES   = parseFloat(process.env.SM_LOG_STALE    || '30');   // minutes without log growth
const ALERT_COOLDOWN_MS   = parseInt(process.env.SM_ALERT_COOLDOWN || '1800000', 10); // 30 min between alerts per node

// MLflow logging
const MLFLOW_URI        = process.env.MLFLOW_TRACKING_URI || 'http://localhost:5000';
const LOG_TO_MLFLOW_PY  = path.join(__dirname, 'log_to_mlflow.py');

// Nodes to monitor (GPU nodes only — CPU nodes have no GPU to check)
const GPU_NODES = ['neptune', 'uranus', 'razer'];

// Training log paths per node — used to verify training is progressing.
// These are the stdout log files of the training processes.
const TRAINING_LOG_PATHS = {
  neptune: [
    'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\alpha_discovery\\training.log',
    'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\logs\\training.log',
    'C:\\Users\\Footb\\.pm2\\logs\\cnn-training-out.log',
  ],
  uranus: [
    'C:\\Users\\nick\\Lvl3Quant\\alpha_discovery\\training.log',
    'C:\\Users\\nick\\Lvl3Quant\\logs\\training.log',
  ],
  razer: [
    'C:\\Users\\claude\\Lvl3Quant\\logs\\training.log',
    'C:\\Users\\claude\\Lvl3Quant\\alpha_discovery\\training.log',
  ],
};

// ============================================================================
// LOGGING
// ============================================================================

function log(level, msg, data = null) {
  const ts    = new Date().toISOString();
  let entry   = `[${ts}] [${level}] ${msg}`;
  if (data !== null) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch {}
  }
  entry += '\n';

  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch {}
  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(entry);
  } else {
    process.stdout.write(entry);
  }
}

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return {
    started_at:       new Date().toISOString(),
    poll_count:       0,
    last_alert:       {},   // node -> ISO timestamp
    rolling_gpu:      {},   // node -> [{util, power, ts}]
    last_log_sizes:   {},   // node -> {path, size, ts}
    last_mlflow_run:  null, // ISO timestamp of last MLflow log
    alerts_fired:     0,
    total_checks:     0,
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log('ERROR', `Failed to save state: ${e.message}`);
  }
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpGet(urlPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, QCC_BASE);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

function httpPost(urlPath, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlPath, QCC_BASE);
    const data = JSON.stringify(payload);
    const opts = {
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(data);
    req.end();
  });
}

// ============================================================================
// GPU DATA COLLECTION
// ============================================================================

/**
 * Fetch the latest GPU snapshot for all nodes from QCC health API.
 *
 * Returns a map: nodeName -> { util: number|null, power_w: number|null, temp_c: number|null }
 */
async function fetchGpuSnapshots() {
  const snapshots = {};
  try {
    const health = await httpGet('/api/health', 10000);
    const nodes  = health.nodes || [];
    for (const node of nodes) {
      snapshots[node.name] = {
        util:    node.last_gpu_util   ?? null,
        power_w: node.last_power_draw ?? null,
        temp_c:  node.last_gpu_temp   ?? null,
        mem_pct: node.last_gpu_mem    ?? null,
        ts:      new Date().toISOString(),
      };
    }
  } catch (e) {
    log('WARN', `QCC health fetch failed: ${e.message}`);
  }
  return snapshots;
}

// ============================================================================
// ROLLING WINDOW MANAGEMENT
// ============================================================================

/**
 * Append a new GPU sample to the rolling window for a node.
 * Trims to ROLLING_WINDOW_SIZE entries.
 */
function appendRolling(state, nodeName, sample) {
  if (!state.rolling_gpu[nodeName]) {
    state.rolling_gpu[nodeName] = [];
  }
  state.rolling_gpu[nodeName].push(sample);
  // Keep only the last N samples
  if (state.rolling_gpu[nodeName].length > ROLLING_WINDOW_SIZE) {
    state.rolling_gpu[nodeName] = state.rolling_gpu[nodeName].slice(-ROLLING_WINDOW_SIZE);
  }
}

/**
 * Compute rolling averages from the window.
 * Returns { avg_util, avg_power, sample_count, window_minutes }
 */
function rollingStats(state, nodeName) {
  const window = state.rolling_gpu[nodeName] || [];
  if (window.length === 0) {
    return { avg_util: null, avg_power: null, sample_count: 0, window_minutes: 0 };
  }

  const utils  = window.map(s => s.util).filter(u => u !== null && u !== undefined);
  const powers = window.map(s => s.power_w).filter(p => p !== null && p !== undefined);

  const avg_util  = utils.length  > 0 ? utils.reduce((a, b)  => a + b,  0) / utils.length  : null;
  const avg_power = powers.length > 0 ? powers.reduce((a, b) => a + b,  0) / powers.length : null;

  // Window duration in minutes
  const oldest = window[0].ts ? new Date(window[0].ts) : null;
  const newest = window[window.length - 1].ts ? new Date(window[window.length - 1].ts) : null;
  const window_minutes = (oldest && newest)
    ? (newest - oldest) / 60000
    : (window.length * POLL_INTERVAL_MS / 60000);

  return {
    avg_util,
    avg_power,
    sample_count:   window.length,
    window_minutes: Math.round(window_minutes * 10) / 10,
  };
}

// ============================================================================
// TRAINING LOG GROWTH CHECK
// ============================================================================

/**
 * Check if any of the training log files for a node has grown in the last
 * LOG_STALE_MINUTES minutes.
 *
 * Returns { growing: bool, log_path: string|null, bytes_added: number }
 */
function checkLogGrowth(state, nodeName) {
  const logPaths = TRAINING_LOG_PATHS[nodeName] || [];
  const now      = Date.now();
  const staleMs  = LOG_STALE_MINUTES * 60 * 1000;

  for (const logPath of logPaths) {
    try {
      if (!fs.existsSync(logPath)) continue;

      const stat      = fs.statSync(logPath);
      const currentSz = stat.size;
      const mtime     = stat.mtimeMs;

      // Was it modified recently?
      const modifiedAgoMs = now - mtime;
      if (modifiedAgoMs < staleMs) {
        // File was modified recently — training is active
        const prev = state.last_log_sizes[`${nodeName}:${logPath}`];
        const bytesAdded = prev ? currentSz - prev.size : 0;
        state.last_log_sizes[`${nodeName}:${logPath}`] = { size: currentSz, ts: new Date().toISOString() };
        return {
          growing:     true,
          log_path:    logPath,
          bytes_added: Math.max(0, bytesAdded),
          modified_ago_min: Math.round(modifiedAgoMs / 60000 * 10) / 10,
        };
      }

      // Track size for delta calculation
      state.last_log_sizes[`${nodeName}:${logPath}`] = { size: currentSz, ts: new Date().toISOString() };
    } catch {}
  }

  return { growing: false, log_path: null, bytes_added: 0, modified_ago_min: null };
}

// ============================================================================
// ISSUE DETECTION
// ============================================================================

/**
 * Determine if a node has a CONFIRMED dead GPU (not a transient loading gap).
 *
 * Rules:
 *   DEAD     = avg_util < threshold AND avg_power < dead_watts AND log not growing
 *   LOADING  = avg_util < threshold AND avg_power >= dead_watts
 *   HEALTHY  = avg_util >= threshold
 *   UNKNOWN  = not enough samples yet (< 3)
 */
function classifyNode(rollingStats, logGrowth) {
  const { avg_util, avg_power, sample_count } = rollingStats;

  if (sample_count < 3) {
    return { status: 'UNKNOWN', reason: `Only ${sample_count} sample(s) — need 3+ for confident assessment` };
  }

  if (avg_util === null) {
    return { status: 'UNKNOWN', reason: 'No GPU util data from QCC' };
  }

  // GPU is active
  if (avg_util >= GPU_IDLE_THRESHOLD) {
    return {
      status: 'HEALTHY',
      reason: `GPU util avg ${avg_util.toFixed(1)}% over ${rollingStats.window_minutes} min`,
    };
  }

  // Low GPU util — check power draw
  if (avg_power !== null && avg_power >= POWER_DEAD_WATTS) {
    return {
      status: 'LOADING',
      reason: `GPU util low (${avg_util.toFixed(1)}%) but power draw ${avg_power.toFixed(0)}W — loading data`,
    };
  }

  // Low util, low power — check log growth
  if (logGrowth.growing) {
    return {
      status: 'LOADING',
      reason: `GPU idle but log growing (${logGrowth.bytes_added} bytes in last check) — script overhead phase`,
    };
  }

  // All signals point to dead
  const powerDesc = avg_power !== null ? `power ${avg_power.toFixed(0)}W` : 'power unknown';
  return {
    status: 'DEAD',
    reason: `GPU util avg ${avg_util.toFixed(1)}%, ${powerDesc}, log not growing — likely crashed or idle`,
  };
}

// ============================================================================
// ALERTING
// ============================================================================

async function sendAlert(type, title, message) {
  // QCC alerts endpoint
  try {
    await httpPost('/api/alerts', {
      severity: type === 'DEAD' ? 'critical' : 'warning',
      source:   'smart_monitor',
      message:  `${title}: ${message}`,
    });
  } catch {}

  // Webhook notifier (Discord)
  try {
    const notifier = require(path.join(BASE_DIR, 'utils', 'webhook_notifier'));
    if (type === 'DEAD') {
      await notifier.notifications.error(title, message);
    } else {
      await notifier.notifications.warning(title, message);
    }
  } catch {}
}

// ============================================================================
// MLFLOW LOGGING
// ============================================================================

/**
 * Log a full monitoring cycle snapshot to MLflow "Infrastructure" experiment.
 * Fire-and-forget subprocess.
 */
function logToMlflow(nodeMetrics) {
  if (!fs.existsSync(LOG_TO_MLFLOW_PY)) {
    log('WARN', 'log_to_mlflow.py not found — skipping MLflow logging');
    return;
  }

  const metrics = {};
  const params  = {
    poll_type:    'smart_monitor',
    window_size:  ROLLING_WINDOW_SIZE,
    gpu_threshold: GPU_IDLE_THRESHOLD,
  };

  for (const [nodeName, data] of Object.entries(nodeMetrics)) {
    const pfx = `${nodeName}`;
    if (data.avg_util     !== null && data.avg_util     !== undefined) metrics[`${pfx}_gpu_util_avg`]   = data.avg_util;
    if (data.avg_power    !== null && data.avg_power    !== undefined) metrics[`${pfx}_power_draw_avg`] = data.avg_power;
    if (data.sample_count !== undefined)                               metrics[`${pfx}_sample_count`]   = data.sample_count;
    if (data.window_minutes !== undefined)                             metrics[`${pfx}_window_min`]      = data.window_minutes;
    if (data.log_bytes_added !== undefined && data.log_bytes_added !== null) {
      metrics[`${pfx}_log_bytes_added`] = data.log_bytes_added;
    }
    // Encode status as numeric (HEALTHY=1, LOADING=0.5, DEAD=0, UNKNOWN=-1)
    const statusMap = { HEALTHY: 1, LOADING: 0.5, DEAD: 0, UNKNOWN: -1 };
    if (data.status) metrics[`${pfx}_status`] = statusMap[data.status] ?? -1;
  }

  const runName = `smart_monitor_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const proc = spawn(pythonExe, [
      LOG_TO_MLFLOW_PY,
      '--experiment', 'Infrastructure',
      '--run-name',   runName,
      '--params',     JSON.stringify(params),
      '--metrics',    JSON.stringify(metrics),
      '--tags',       JSON.stringify({ source: 'smart_monitor', type: 'periodic' }),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    proc.unref();
  } catch (e) {
    log('WARN', `MLflow log spawn failed: ${e.message}`);
  }
}

// ============================================================================
// MAIN POLL
// ============================================================================

let _state = loadState();

async function poll() {
  _state.poll_count  = (_state.poll_count || 0) + 1;
  _state.total_checks++;
  const now = Date.now();

  log('INFO', `=== Smart Monitor Poll #${_state.poll_count} ===`);

  // 1. Fetch current GPU snapshots
  const snapshots = await fetchGpuSnapshots();

  // 2. Update rolling windows and classify each node
  const nodeMetrics = {};

  for (const nodeName of GPU_NODES) {
    const snap = snapshots[nodeName] || {};

    // Append to rolling window (even nulls, so we know we tried)
    appendRolling(_state, nodeName, {
      util:    snap.util    ?? null,
      power_w: snap.power_w ?? null,
      temp_c:  snap.temp_c  ?? null,
      ts:      new Date().toISOString(),
    });

    const rolling  = rollingStats(_state, nodeName);
    const logCheck = checkLogGrowth(_state, nodeName);
    const classify = classifyNode(rolling, logCheck);

    nodeMetrics[nodeName] = {
      ...rolling,
      log_growing:      logCheck.growing,
      log_bytes_added:  logCheck.bytes_added,
      log_path:         logCheck.log_path,
      log_modified_ago: logCheck.modified_ago_min,
      status:           classify.status,
      reason:           classify.reason,
      latest_util:      snap.util    ?? null,
      latest_power:     snap.power_w ?? null,
      latest_temp:      snap.temp_c  ?? null,
    };

    const icon = { HEALTHY: '✓', LOADING: '~', DEAD: '!', UNKNOWN: '?' }[classify.status] || '?';
    log('INFO', `  [${icon}] ${nodeName.padEnd(8)} ${classify.status.padEnd(8)} | ${classify.reason}`);

    // 3. Fire alert if DEAD and not in cooldown
    if (classify.status === 'DEAD') {
      const lastAlertTs  = _state.last_alert[nodeName];
      const lastAlertAge = lastAlertTs ? now - new Date(lastAlertTs).getTime() : Infinity;

      if (lastAlertAge >= ALERT_COOLDOWN_MS) {
        _state.last_alert[nodeName] = new Date().toISOString();
        _state.alerts_fired++;

        const alertMsg =
          `**${nodeName.toUpperCase()}** GPU appears dead.\n` +
          `${classify.reason}\n` +
          `Rolling window: ${rolling.sample_count} samples over ${rolling.window_minutes} min\n` +
          `Avg util: ${rolling.avg_util?.toFixed(1) ?? 'N/A'}%  ` +
          `Avg power: ${rolling.avg_power?.toFixed(0) ?? 'N/A'}W\n` +
          `Log growing: ${logCheck.growing ? 'YES' : 'NO'}  ` +
          `Log path: ${logCheck.log_path || 'none found'}\n\n` +
          `Check QCC: http://localhost:3456/status`;

        log('WARN', `[ALERT] ${nodeName}: ${classify.reason}`);
        await sendAlert('DEAD', `GPU Dead: ${nodeName}`, alertMsg).catch(e =>
          log('WARN', `Alert failed: ${e.message}`)
        );
      } else {
        const cooldownRemainMin = Math.round((ALERT_COOLDOWN_MS - lastAlertAge) / 60000);
        log('INFO', `  [${nodeName}] In alert cooldown (${cooldownRemainMin} min remaining)`);
      }
    }
  }

  // 4. Log to MLflow (every poll)
  logToMlflow(nodeMetrics);

  saveState(_state);
  return nodeMetrics;
}

// ============================================================================
// STATUS REPORT
// ============================================================================

function printStatus() {
  const state = loadState();
  console.log('\n=== Smart Monitor State ===');
  console.log(`Started:      ${state.started_at}`);
  console.log(`Poll count:   ${state.poll_count}`);
  console.log(`Total checks: ${state.total_checks}`);
  console.log(`Alerts fired: ${state.alerts_fired}`);
  console.log('\n=== Rolling Windows ===');

  for (const nodeName of GPU_NODES) {
    const window = state.rolling_gpu[nodeName] || [];
    const rolling = rollingStats(state, nodeName);
    const logCheck = checkLogGrowth(state, nodeName);
    const classify = classifyNode(rolling, logCheck);

    console.log(`\n${nodeName.toUpperCase()}:`);
    console.log(`  Status:       ${classify.status}`);
    console.log(`  Reason:       ${classify.reason}`);
    console.log(`  Samples:      ${rolling.sample_count} / ${ROLLING_WINDOW_SIZE}`);
    console.log(`  Window:       ${rolling.window_minutes} min`);
    console.log(`  Avg GPU util: ${rolling.avg_util?.toFixed(1) ?? 'N/A'}%`);
    console.log(`  Avg power:    ${rolling.avg_power?.toFixed(0) ?? 'N/A'}W`);
    console.log(`  Log growing:  ${logCheck.growing}`);
    console.log(`  Log path:     ${logCheck.log_path || 'none found'}`);
    console.log(`  Last alert:   ${state.last_alert[nodeName] || 'never'}`);

    if (window.length > 0) {
      console.log('  Recent samples:');
      for (const s of window.slice(-3)) {
        const util  = s.util  !== null ? `${s.util}%`  : 'N/A';
        const power = s.power_w !== null ? `${s.power_w}W` : 'N/A';
        console.log(`    [${s.ts}] util=${util} power=${power}`);
      }
    }
  }
}

// ============================================================================
// ENTRYPOINT
// ============================================================================

const argv = process.argv.slice(2);

if (argv.includes('--status')) {
  printStatus();
  process.exit(0);
}

if (argv.includes('--reset-window')) {
  const state = loadState();
  state.rolling_gpu    = {};
  state.last_log_sizes = {};
  state.last_alert     = {};
  saveState(state);
  console.log('Rolling windows and alert history reset.');
  process.exit(0);
}

// Single-shot check (no --daemon flag)
if (!argv.includes('--daemon')) {
  log('INFO', 'smart_monitor.js: single-shot check');
  poll().then(metrics => {
    // Print summary
    console.log('\n=== Smart Monitor Summary ===');
    for (const [node, data] of Object.entries(metrics)) {
      const icon = { HEALTHY: '✓', LOADING: '~', DEAD: '✗', UNKNOWN: '?' }[data.status] || '?';
      console.log(`  [${icon}] ${node.padEnd(8)} ${data.status.padEnd(8)} | avg util: ${data.avg_util?.toFixed(1) ?? 'N/A'}% | ${data.reason}`);
    }
    process.exit(0);
  }).catch(e => {
    log('ERROR', `Poll failed: ${e.message}`);
    process.exit(1);
  });
} else {
  // Daemon mode (--daemon flag or started via PM2)
  log('INFO', '===========================================');
  log('INFO', 'Smart Monitor starting in daemon mode');
  log('INFO', `QCC base:            ${QCC_BASE}`);
  log('INFO', `Poll interval:       ${POLL_INTERVAL_MS / 1000}s`);
  log('INFO', `Rolling window:      ${ROLLING_WINDOW_SIZE} samples`);
  log('INFO', `GPU idle threshold:  ${GPU_IDLE_THRESHOLD}%`);
  log('INFO', `Power dead threshold: ${POWER_DEAD_WATTS}W`);
  log('INFO', `Log stale after:     ${LOG_STALE_MINUTES} min`);
  log('INFO', `Alert cooldown:      ${ALERT_COOLDOWN_MS / 60000} min`);
  log('INFO', '===========================================');

  // First poll immediately, then interval
  poll().catch(e => log('ERROR', `Initial poll error: ${e.message}`));
  setInterval(() => {
    poll().catch(e => log('ERROR', `Poll error: ${e.message}`));
  }, POLL_INTERVAL_MS);

  process.on('SIGINT',  () => { saveState(_state); process.exit(0); });
  process.on('SIGTERM', () => { saveState(_state); process.exit(0); });

  process.on('uncaughtException', (e) => {
    log('ERROR', `Uncaught exception: ${e.message}`, { stack: e.stack?.slice(0, 500) });
  });
  process.on('unhandledRejection', (reason) => {
    log('ERROR', `Unhandled rejection: ${String(reason).slice(0, 300)}`);
  });
}
