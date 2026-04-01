/**
 * ray_watchdog.js — Automated Ray cluster health monitor and auto-healer.
 *
 * Monitors on staggered intervals (all in same PM2 process):
 *   - Ray connectivity:    every 60s   — reconnect dropped nodes
 *   - GPU utilization:     every 120s  — detect idle GPUs, auto-launch queued jobs
 *   - Training staleness:  every 5min  — detect stalled training, restart from checkpoint
 *   - Queue depth:         every 5min  — alert when queue < 3 jobs
 *
 * Node reconnect strategies:
 *   Neptune  — local spawnSync with env vars (Windows)
 *   Razer    — Flask API (LAN: 192.168.0.103, Tailscale: 100.102.215.75:8765)
 *   Uranus   — SSH with inline PowerShell env vars (Tailscale)
 *   Saturn   — SSH via Jupiter hop (LAN) or Jupiter Flask API exec
 *   Jupiter  — HEAD node. Alert only; never attempt restart.
 *
 * Discord alerts: sent to #system-status / #alerts on all significant events.
 *
 * PM2 start:
 *   pm2 start compute/ecosystem.config.js --only ray-watchdog
 */

'use strict';

const { spawnSync, execSync, execFile } = require('child_process');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// Job queue module — for queue depth checks and auto-launch
const jobQueue = require('./job_queue');

// NodeAPI client — for remote GPU/process checks
const { NodeAPI, getNode } = require('./node_api_client');

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT              = path.join(__dirname, '..');
const CONFIG_FILE       = path.join(ROOT, 'config.json');
const CHANNELS_FILE     = path.join(ROOT, 'trading_agents', 'data', 'discord_channels.json');
const HISTORY_FILE      = path.join(__dirname, 'ray_watchdog_history.json');

const RAY_DASHBOARD_URL = 'http://192.168.0.108:8265/nodes?view=summary';
const RAY_HEAD_LAN      = '192.168.0.108';
const RAY_HEAD_PORT     = 6379;
const RAY_HEAD_TAILSCALE = '100.71.253.30';  // Jupiter Tailscale IP (for Uranus)

const API_KEY           = process.env.NODE_API_KEY || 'qcc_node_api_2026';
const CHECK_INTERVAL_MS = 60_000;       // 60 seconds — Ray connectivity
const RETRY_COOLDOWN_MS = 5 * 60_000;  // 5 minutes before retrying a failed node

// ── Additional monitoring intervals ──────────────────────────────────────────
const GPU_CHECK_INTERVAL_MS      = 120_000;  // 120s — GPU utilization
const TRAINING_CHECK_INTERVAL_MS = 300_000;  // 5min — Training staleness
const QUEUE_CHECK_INTERVAL_MS    = 300_000;  // 5min — Queue depth

// ── Thresholds ───────────────────────────────────────────────────────────────
const GPU_IDLE_THRESHOLD_MIN  = 10;   // 0% util for this many minutes = idle
const TRAINING_STALE_MIN      = 30;   // No new log output for this long = stalled
const QUEUE_LOW_THRESHOLD     = 3;    // Alert when queue drops below this
const ALERT_COOLDOWN_MS       = 1800_000; // 30 min between same alert type per node

// ── GPU node metadata ────────────────────────────────────────────────────────
const GPU_NODES = ['neptune', 'uranus', 'razer'];
const ALL_QUEUE_NODES = ['neptune', 'uranus', 'razer', 'jupiter', 'saturn'];

// ── Training log paths per node (checked for freshness) ──────────────────────
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

// ── Extended state for new monitors ──────────────────────────────────────────
// This gets merged into the existing history file
const EXTENDED_STATE_FILE = path.join(__dirname, 'ray_watchdog_extended_state.json');

function loadExtendedState() {
  try {
    if (fs.existsSync(EXTENDED_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(EXTENDED_STATE_FILE, 'utf8'));
    }
  } catch (e) { warn(`Could not load extended state: ${e.message}`); }
  return {
    gpu_idle_since:         {},  // node -> ISO timestamp when first seen 0%
    last_training_log_size: {},  // "node:path" -> { size, ts }
    last_alert_ts:          {},  // "alertType:node" -> ISO timestamp
    gpu_checks:    0,
    training_checks: 0,
    queue_checks:  0,
    auto_launches: 0,
    auto_restarts: 0,
  };
}

function saveExtendedState(state) {
  state.updated_at = new Date().toISOString();
  try { fs.writeFileSync(EXTENDED_STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { warn(`Could not save extended state: ${e.message}`); }
}

let _extState = loadExtendedState();

// Expected nodes: name → array of IP addresses that identify this node in Ray
// Ray reports node IPs; we match on any of these.
const EXPECTED_NODES = {
  jupiter: { ips: ['192.168.0.108', '100.71.253.30'], role: 'head',   desc: 'Jupiter HEAD (192.168.0.108)' },
  neptune: { ips: ['192.168.0.101', '192.168.0.109', '127.0.0.1', '::1', 'localhost', '100.109.245.73'], role: 'worker', desc: 'Neptune GPU RTX3090' },
  saturn:  { ips: ['10.0.0.2', '100.101.101.9'],      role: 'worker', desc: 'Saturn CPU' },
  uranus:  { ips: ['100.100.83.37'],                   role: 'worker', desc: 'Uranus GPU RTX5090' },
  razer:   { ips: ['192.168.0.103', '100.102.215.75'], role: 'worker', desc: 'Razer GPU RTX3070' },
};

// ── Logging ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  console.log(`[ray_watchdog ${ts()}] ${msg}`);
}

function warn(msg) {
  console.warn(`[ray_watchdog ${ts()}] WARN: ${msg}`);
}

function err(msg) {
  console.error(`[ray_watchdog ${ts()}] ERROR: ${msg}`);
}

// ── History (persist reconnect attempts to survive restarts) ──────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    warn(`Could not load history: ${e.message}`);
  }
  return {};
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    warn(`Could not save history: ${e.message}`);
  }
}

// ── Discord Alerting ──────────────────────────────────────────────────────────

function loadDiscordConfig() {
  try {
    const cfg      = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    return {
      token:           cfg.discordToken || '',
      systemStatusId:  channels.channels?.systemStatus || '',
      alertsId:        channels.channels?.alerts || '',
    };
  } catch (e) {
    warn(`Discord config load failed: ${e.message}`);
    return { token: '', systemStatusId: '', alertsId: '' };
  }
}

async function sendDiscord(message, channelId) {
  const { token } = loadDiscordConfig();
  if (!token || !channelId) return;

  const body = JSON.stringify({ content: message.slice(0, 2000) });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bot ${token}`,
        'User-Agent':     'RayWatchdog/1.0',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          warn(`Discord HTTP ${res.statusCode}: ${data.slice(0, 100)}`);
          resolve(false);
        }
      });
    });
    req.on('error', e => { warn(`Discord send error: ${e.message}`); resolve(false); });
    req.write(body);
    req.end();
    setTimeout(() => { req.destroy(); resolve(false); }, 10_000);
  });
}

async function alert(message, isUrgent = false) {
  log(`ALERT: ${message}`);
  const disc = loadDiscordConfig();
  const channelId = isUrgent ? (disc.alertsId || disc.systemStatusId) : disc.systemStatusId;
  if (channelId) {
    await sendDiscord(`🔴 **Ray Watchdog**: ${message}`, channelId);
  }
}

async function notify(message) {
  log(`NOTIFY: ${message}`);
  const disc = loadDiscordConfig();
  if (disc.systemStatusId) {
    await sendDiscord(`✅ **Ray Watchdog**: ${message}`, disc.systemStatusId);
  }
}

// ── Ray Dashboard Query ───────────────────────────────────────────────────────

/**
 * Query the Ray dashboard API and return alive nodes with their IPs.
 * Filters out dead/disconnected nodes.
 * @returns {Promise<Array<{hostname: string, ip: string, state: string, resources: object}>>}
 */
async function queryRayNodes() {
  return new Promise((resolve) => {
    const req = http.get(RAY_DASHBOARD_URL, { timeout: 15_000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const summary = parsed?.data?.summary || [];
          // Only count ALIVE nodes (state === 'ALIVE')
          const alive = summary
            .filter(n => n.raylet?.state === 'ALIVE')
            .map(n => ({
              hostname:  n.hostname || '',
              ip:        n.ip || '',
              state:     n.raylet?.state || 'UNKNOWN',
              resources: n.raylet?.resourcesTotal || {},
              nodeId:    n.raylet?.nodeId || '',
            }));
          resolve(alive);
        } catch (e) {
          warn(`Failed to parse Ray API response: ${e.message}`);
          resolve(null);  // null = dashboard unreachable
        }
      });
    });
    req.on('error', e => {
      warn(`Ray dashboard unreachable: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      warn('Ray dashboard request timed out');
      resolve(null);
    });
  });
}

/**
 * Identify which expected nodes are present in the alive list.
 * Returns { present: Set<name>, missing: Set<name> }
 */
function classifyNodes(aliveNodes) {
  const present = new Set();
  const missing = new Set(Object.keys(EXPECTED_NODES));

  for (const alive of aliveNodes) {
    for (const [name, cfg] of Object.entries(EXPECTED_NODES)) {
      if (cfg.ips.includes(alive.ip)) {
        present.add(name);
        missing.delete(name);
        break;
      }
    }
  }

  return { present, missing };
}

// ── Flask API helpers ─────────────────────────────────────────────────────────

/**
 * POST a command to the Flask node API.
 * @param {string} host
 * @param {number} port
 * @param {string} command
 * @param {number} timeoutSec
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}|null>}
 */
async function flaskExec(host, port, command, timeoutSec = 90) {
  const body = JSON.stringify({ command, timeout: timeoutSec, background: false });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: host,
      port,
      path: '/exec',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key':      API_KEY,
      },
      timeout: (timeoutSec + 15) * 1000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve({ stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exit_code ?? r.exitCode ?? -1 });
        } catch {
          resolve({ stdout: data, stderr: '', exitCode: -1 });
        }
      });
    });
    req.on('error', e => { warn(`Flask exec error ${host}:${port} - ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); warn(`Flask exec timeout ${host}:${port}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Check if Flask API is reachable.
 */
async function flaskHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: host, port, path: '/health', timeout: 8_000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode < 400));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── SSH helpers ───────────────────────────────────────────────────────────────

/**
 * Run SSH command in the background (fire-and-forget via spawn).
 * Returns a promise that resolves with stdout/stderr once done.
 */
function sshExec(target, command, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-o', 'BatchMode=yes',
      target,
      command,
    ];
    let stdout = '';
    let stderr = '';
    const proc = execFile('ssh', args, { timeout: timeoutMs, windowsHide: true }, (error, out, errOut) => {
      stdout = out || '';
      stderr = errOut || '';
      if (error && !error.killed) {
        warn(`SSH to ${target} error: ${error.message?.slice(0, 200)}`);
      }
      resolve({ stdout, stderr, exitCode: error ? (error.code || 1) : 0 });
    });
    // Hide any windows that might pop up
    if (proc.stdio) proc.stdio.forEach(s => s?.unref?.());
    proc.unref();
  });
}

// ── Node reconnect strategies ─────────────────────────────────────────────────

/**
 * Reconnect Neptune (this PC, Windows, LAN).
 * Env vars already permanent via setx; just run ray start.
 */
async function reconnectNeptune() {
  log('Reconnecting Neptune (local Windows)...');
  const env = {
    ...process.env,
    RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER: '1',
    RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL: 'minor',
  };

  // CRITICAL: Stop existing Ray workers first to prevent process accumulation
  // Without this, each reconnect spawns new workers without killing old ones,
  // eventually consuming all RAM and freezing the PC.
  log('Stopping existing Ray workers on Neptune before reconnect...');

  // IMPORTANT: Must use Windows Store Python ray.exe (2.54.1) — NOT Programs/Python311/Scripts/ray.exe
  // which is ray 2.49.0 and will fail version mismatch against the cluster head (2.54.1).
  // The Windows Store Python path has the matching version.
  const RAY_EXE = 'C:/Users/Footb/AppData/Local/Packages/PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0/LocalCache/local-packages/Python311/Scripts/ray.exe';

  if (!require('fs').existsSync(RAY_EXE)) {
    log(`ray.exe not found at ${RAY_EXE} — cannot reconnect Neptune`);
    return { success: false, output: 'ray.exe not found' };
  }

  spawnSync(RAY_EXE, ['stop', '--force'], { encoding: 'utf8', timeout: 30_000, env, windowsHide: true });

  const result = spawnSync(
    RAY_EXE,
    ['start', `--address=${RAY_HEAD_LAN}:${RAY_HEAD_PORT}`, '--num-gpus=1'],
    { encoding: 'utf8', timeout: 90_000, env, windowsHide: true }
  );

  const combined = (result.stdout || '') + (result.stderr || '');
  if (combined.includes('Ray runtime started') || combined.includes('already running')) {
    log('Neptune reconnected successfully');
    return { success: true, output: combined.slice(-300) };
  }
  log(`Neptune reconnect result: ${combined.slice(-300)}`);
  return { success: false, output: combined.slice(-300) || 'no output from ray start' };
}

/**
 * Reconnect Razer via Flask API.
 * Strategy:
 *   1. Try Tailscale API (100.102.215.75:8765) — more reliable
 *   2. Try LAN API (192.168.0.103:8765) as fallback
 *   3. Create bat file if missing, then run ray start with env vars inline
 */
async function reconnectRazer() {
  log('Reconnecting Razer (Flask API)...');

  // Try Tailscale first, then LAN
  const endpoints = [
    { host: '100.102.215.75', port: 8765 },
    { host: '192.168.0.103',  port: 8765 },
  ];

  let apiHost = null;
  let apiPort = null;

  for (const ep of endpoints) {
    log(`  Checking Razer API at ${ep.host}:${ep.port}...`);
    const reachable = await flaskHealth(ep.host, ep.port);
    if (reachable) {
      apiHost = ep.host;
      apiPort = ep.port;
      log(`  Razer API reachable at ${ep.host}:${ep.port}`);
      break;
    }
  }

  if (!apiHost) {
    return { success: false, output: 'Razer Flask API unreachable on both Tailscale and LAN' };
  }

  // Step 1: Ensure the bat file exists (forward slashes to avoid Flask path mangling)
  // We write a simple bat file that sets env vars and starts ray
  const batContent = [
    '@echo off',
    'set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1',
    'set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor',
    `ray start --address=${RAY_HEAD_LAN}:${RAY_HEAD_PORT} --num-cpus=8 --num-gpus=1`,
  ].join('\r\n');

  // Use echo with forward-slash friendly path via cmd
  // Flask API exec uses Windows cmd.exe, forward slashes work in most contexts
  const batPath = 'C:/Users/claude/ray_worker_start.bat';
  const writeCmd = `cmd /c echo @echo off > C:\\Users\\claude\\ray_worker_start.bat && echo set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 >> C:\\Users\\claude\\ray_worker_start.bat && echo set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor >> C:\\Users\\claude\\ray_worker_start.bat && echo ray start --address=${RAY_HEAD_LAN}:${RAY_HEAD_PORT} --num-cpus=8 --num-gpus=1 >> C:\\Users\\claude\\ray_worker_start.bat`;

  log('  Creating/updating Razer bat file...');
  await flaskExec(apiHost, apiPort, writeCmd, 15);

  // Step 2: Try scheduled task first (cleanest approach, inherits correct user env)
  log('  Attempting schtasks RayWorkerAutoStart...');
  const schtaskResult = await flaskExec(apiHost, apiPort, 'schtasks /run /tn RayWorkerAutoStart 2>&1', 15);

  if (schtaskResult && !schtaskResult.stdout.includes('ERROR') && !schtaskResult.stdout.includes('not found')) {
    log(`  Razer schtask triggered: ${schtaskResult.stdout.slice(0, 100)}`);
    // Wait a bit for the task to start ray
    await sleep(5000);
    return { success: true, output: `schtask triggered: ${schtaskResult.stdout.slice(0, 200)}` };
  }

  // Step 3: Run ray start directly via Flask API with inline env vars
  // IMPORTANT: use cmd /c set ... && set ... && ray start (chain with &&)
  // Avoid backslashes in the command string going through Flask
  log('  Running ray start directly via Flask API...');
  const rayCmd = `cmd /c "set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 && set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor && ray start --address=${RAY_HEAD_LAN}:${RAY_HEAD_PORT} --num-cpus=8 --num-gpus=1"`;
  const result = await flaskExec(apiHost, apiPort, rayCmd, 90);

  if (!result) {
    return { success: false, output: 'Flask exec timed out or failed' };
  }

  const combined = (result.stdout || '') + (result.stderr || '');
  if (combined.includes('Ray runtime started') || combined.includes('already running')) {
    log('Razer reconnected successfully');
    return { success: true, output: combined.slice(-300) };
  }

  log(`Razer ray start output: ${combined.slice(-300)}`);
  return { success: false, output: combined.slice(-300) };
}

/**
 * Reconnect Uranus via SSH with inline PowerShell env vars.
 * Uses Tailscale (100.100.83.37).
 * Jupiter Tailscale IP: 100.71.253.30
 */
async function reconnectUranus() {
  log('Reconnecting Uranus (SSH + cmd env var)...');

  // IMPORTANT: Use 'ray' command directly via cmd /c to set env var inline.
  // PowerShell escaping through SSH is unreliable — $env: gets mangled.
  // cmd /c "set VAR=val && ray start ..." is much more reliable over SSH.
  // Use the Tailscale Jupiter IP since Uranus connects via Tailscale.
  //
  // Step 1: Stop any existing Ray workers
  const stopResult = await sshExec('nick@100.100.83.37', 'ray stop --force', 30_000);
  log(`Uranus ray stop: ${((stopResult.stdout || '') + (stopResult.stderr || '')).slice(-100)}`);

  // Brief pause
  await new Promise(r => setTimeout(r, 3000));

  // Step 2: Start Ray worker with env var set via cmd /c
  const startCmd = `cmd /c "set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 && set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor && ray start --address=${RAY_HEAD_TAILSCALE}:${RAY_HEAD_PORT} --num-cpus=16 --num-gpus=1"`;
  const result = await sshExec('nick@100.100.83.37', startCmd, 120_000);
  const combined = (result.stdout || '') + (result.stderr || '');

  if (combined.includes('Ray runtime started') || combined.includes('already running')) {
    log('Uranus reconnected successfully');
    return { success: true, output: combined.slice(-300) };
  }

  log(`Uranus SSH result: ${combined.slice(-300)}`);
  return {
    success: false,
    output: combined.slice(-300) || `SSH exit code: ${result.exitCode}`,
  };
}

/**
 * Reconnect Saturn via SSH hop through Jupiter.
 * Tries Jupiter → Saturn SSH hop first, then Jupiter Flask API fallback.
 */
async function reconnectSaturn() {
  log('Reconnecting Saturn (SSH via Jupiter hop)...');

  // Method 1: SSH ProxyJump through Jupiter
  const saturnRay  = '/home/saturn/miniconda3/envs/ray311/bin/ray';
  const saturnCmd  = `RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor ${saturnRay} start --address=${RAY_HEAD_LAN}:${RAY_HEAD_PORT} --node-name=saturn-worker`;

  // First check if we can reach Jupiter via SSH
  const jupiterTest = await sshExec(`jupiter@${RAY_HEAD_LAN}`, 'echo ok', 15_000);
  if (jupiterTest.stdout.trim() === 'ok' || jupiterTest.exitCode === 0) {
    log('  Jupiter SSH reachable, attempting Saturn hop...');
    const hopResult = await sshExec(
      `jupiter@${RAY_HEAD_LAN}`,
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 saturn@10.0.0.2 "${saturnCmd}" 2>&1`,
      120_000
    );
    const combined = (hopResult.stdout || '') + (hopResult.stderr || '');
    if (combined.includes('Ray runtime started') || combined.includes('already running')) {
      log('Saturn reconnected via Jupiter hop');
      return { success: true, output: combined.slice(-300) };
    }
    log(`Saturn hop result: ${combined.slice(-300)}`);
  } else {
    log('  Jupiter SSH not directly reachable, trying Flask API...');
  }

  // Method 2: Jupiter Flask API → exec Saturn SSH
  log('  Trying Jupiter Flask API to connect Saturn...');
  const apiReachable = await flaskHealth(RAY_HEAD_LAN, 8765);
  if (apiReachable) {
    const jupiterApiCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 saturn@10.0.0.2 "RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor ${saturnRay} start --address=${RAY_HEAD_LAN}:${RAY_HEAD_PORT}" 2>&1`;
    const result = await flaskExec(RAY_HEAD_LAN, 8765, jupiterApiCmd, 120);
    if (!result) return { success: false, output: 'Jupiter Flask API timed out' };

    const combined = (result.stdout || '') + (result.stderr || '');
    if (combined.includes('Ray runtime started') || combined.includes('already running')) {
      log('Saturn reconnected via Jupiter Flask API');
      return { success: true, output: combined.slice(-300) };
    }
    return { success: false, output: combined.slice(-300) };
  }

  return { success: false, output: 'Both SSH hop and Flask API failed for Saturn' };
}

// ══════════════════════════════════════════════════════════════════════════════
// GPU UTILIZATION MONITORING (every 120s)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if an alert of the given type for a node is in cooldown.
 */
function alertInCooldown(alertKey) {
  const lastTs = _extState.last_alert_ts[alertKey];
  if (!lastTs) return false;
  return (Date.now() - new Date(lastTs).getTime()) < ALERT_COOLDOWN_MS;
}

function recordAlert(alertKey) {
  _extState.last_alert_ts[alertKey] = new Date().toISOString();
}

/**
 * Get GPU utilization for a node.
 * Neptune: local nvidia-smi. Others: NodeAPI /gpu endpoint.
 * Returns util% (0-100) or null on failure.
 */
async function getGpuUtil(nodeName) {
  if (nodeName === 'neptune') {
    try {
      const out = execSync(
        'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }
      ).trim();
      return parseInt(out, 10);
    } catch (e) {
      warn(`Neptune nvidia-smi failed: ${e.message}`);
      return null;
    }
  }

  // Remote node: use NodeAPI /gpu
  try {
    const client = getNode(nodeName, API_KEY);
    const gpuData = await client.gpu();
    if (gpuData?.gpus?.[0]) {
      return gpuData.gpus[0].utilization ?? gpuData.gpus[0].util ?? null;
    }
  } catch (e) {
    warn(`${nodeName} GPU API failed: ${e.message}`);
  }
  return null;
}

/**
 * Auto-launch the next queued job on a node.
 */
async function autoLaunchJob(nodeName) {
  try {
    const nextJob = jobQueue.popNext(nodeName);
    if (!nextJob) {
      log(`No queued job to launch on ${nodeName}`);
      return false;
    }

    log(`Auto-launching job ${nextJob.id} (${nextJob.name}) on ${nodeName}`);
    const client = getNode(nodeName, API_KEY);
    const result = await client.exec(nextJob.command, {
      background: true,
      timeout: 30,
      cwd: nextJob.cwd || undefined,
    });

    if (result?.pid) {
      jobQueue.markJobRunning(nodeName, nextJob.id);
      _extState.auto_launches++;
      log(`Job ${nextJob.id} launched on ${nodeName}, PID=${result.pid}`);
      await notify(`Auto-launched job **${nextJob.name}** on ${nodeName} (PID ${result.pid})`);
      return true;
    } else {
      log(`Job launch returned no PID for ${nextJob.id} on ${nodeName}`);
      jobQueue.failJob(nodeName, nextJob.id, 'No PID returned from auto-launch');
      return false;
    }
  } catch (e) {
    err(`Auto-launch failed on ${nodeName}: ${e.message}`);
    return false;
  }
}

/**
 * GPU utilization check cycle.
 * Tracks how long each GPU node has been at 0%.
 * After GPU_IDLE_THRESHOLD_MIN minutes at 0%, alerts and tries to launch next job.
 */
async function gpuUtilizationCycle() {
  _extState.gpu_checks++;
  log('--- GPU utilization check ---');

  for (const nodeName of GPU_NODES) {
    const util = await getGpuUtil(nodeName);
    if (util === null) {
      log(`  ${nodeName}: GPU data unavailable`);
      continue;
    }

    log(`  ${nodeName}: GPU ${util}%`);

    if (util === 0) {
      // Track idle start time
      if (!_extState.gpu_idle_since[nodeName]) {
        _extState.gpu_idle_since[nodeName] = new Date().toISOString();
        log(`  ${nodeName}: GPU just went idle, starting timer`);
      } else {
        const idleSince = new Date(_extState.gpu_idle_since[nodeName]);
        const idleMin = (Date.now() - idleSince.getTime()) / 60_000;

        if (idleMin >= GPU_IDLE_THRESHOLD_MIN) {
          // GPU has been at 0% long enough — check for queued jobs
          const depth = jobQueue.queueDepth(nodeName);
          const alertKey = `gpu_idle:${nodeName}`;

          if (depth > 0) {
            warn(`${nodeName}: GPU idle ${idleMin.toFixed(0)}min with ${depth} queued jobs — auto-launching`);
            if (!alertInCooldown(alertKey)) {
              recordAlert(alertKey);
              await alert(`${EXPECTED_NODES[nodeName]?.desc || nodeName} GPU idle for ${idleMin.toFixed(0)}min with ${depth} queued jobs. Auto-launching next job.`, false);
            }
            const launched = await autoLaunchJob(nodeName);
            if (launched) {
              // Reset idle timer — give the new job time to spin up
              delete _extState.gpu_idle_since[nodeName];
            }
          } else {
            if (!alertInCooldown(alertKey)) {
              recordAlert(alertKey);
              await alert(`${EXPECTED_NODES[nodeName]?.desc || nodeName} GPU idle for ${idleMin.toFixed(0)}min — **NO QUEUED JOBS**. Populate queue!`, false);
            }
          }
        }
      }
    } else {
      // GPU active — reset idle timer
      if (_extState.gpu_idle_since[nodeName]) {
        log(`  ${nodeName}: GPU active again (was idle since ${_extState.gpu_idle_since[nodeName]})`);
        delete _extState.gpu_idle_since[nodeName];
      }
    }
  }

  saveExtendedState(_extState);
}

// ══════════════════════════════════════════════════════════════════════════════
// TRAINING STALENESS DETECTION (every 5 min)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a training process is alive on a node.
 * Neptune: local tasklist. Others: NodeAPI /processes.
 */
async function isTrainingAlive(nodeName) {
  try {
    if (nodeName === 'neptune') {
      const out = execSync(
        'tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH',
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }
      );
      return out.includes('python.exe');
    } else {
      const client = getNode(nodeName, API_KEY);
      const procs = await client.processes();
      if (procs?.processes) {
        return procs.processes.some(p => {
          const cmd = (p.command || p.cmdline || '').toLowerCase();
          return cmd.includes('train') || cmd.includes('fold') || cmd.includes('experiment') || cmd.includes('lgbm');
        });
      }
    }
  } catch (e) {
    warn(`Process check failed for ${nodeName}: ${e.message}`);
  }
  return false;
}

/**
 * Training staleness check cycle.
 * For each GPU node, checks training log freshness.
 * If stale > TRAINING_STALE_MIN AND process is dead, alerts and tries to launch next job.
 */
async function trainingStaleCycle() {
  _extState.training_checks++;
  log('--- Training staleness check ---');

  for (const [nodeName, logPaths] of Object.entries(TRAINING_LOG_PATHS)) {
    let mostRecentModMin = Infinity;
    let activePath = null;
    let anyGrowing = false;

    for (const logPath of logPaths) {
      try {
        let stat = null;

        if (nodeName === 'neptune') {
          if (!fs.existsSync(logPath)) continue;
          stat = fs.statSync(logPath);
        } else {
          // Remote: check via NodeAPI exec
          try {
            const client = getNode(nodeName, API_KEY);
            const r = await client.exec(
              `powershell -Command "(Get-Item '${logPath}').LastWriteTime.ToString('o'), (Get-Item '${logPath}').Length"`,
              { timeout: 10 }
            );
            if (r?.stdout) {
              const parts = r.stdout.trim().split(/[\r\n,]+/);
              if (parts.length >= 2) {
                const mtime = new Date(parts[0].trim());
                const size = parseInt(parts[1].trim(), 10);
                stat = { mtimeMs: mtime.getTime(), size };
              }
            }
          } catch { continue; }
        }

        if (!stat) continue;

        const modAgoMin = (Date.now() - stat.mtimeMs) / 60_000;
        if (modAgoMin < mostRecentModMin) {
          mostRecentModMin = modAgoMin;
          activePath = logPath;
        }

        // Check size growth vs last check
        const key = `${nodeName}:${logPath}`;
        const prev = _extState.last_training_log_size[key];
        _extState.last_training_log_size[key] = { size: stat.size, ts: new Date().toISOString() };

        if (prev && stat.size > prev.size) anyGrowing = true;
        if (modAgoMin < TRAINING_STALE_MIN) anyGrowing = true;
      } catch {}
    }

    if (mostRecentModMin === Infinity) {
      log(`  ${nodeName}: No training logs found`);
      continue;
    }

    if (anyGrowing) {
      log(`  ${nodeName}: Training active (log modified ${mostRecentModMin.toFixed(1)}min ago)`);
      continue;
    }

    if (mostRecentModMin >= TRAINING_STALE_MIN) {
      warn(`${nodeName}: Training log stale for ${mostRecentModMin.toFixed(0)}min (threshold: ${TRAINING_STALE_MIN}min)`);

      // PID check — is the process still alive?
      const alive = await isTrainingAlive(nodeName);
      const alertKey = `training_stale:${nodeName}`;

      if (!alive) {
        err(`${nodeName}: Training process DEAD and log stale`);
        _extState.auto_restarts++;

        if (!alertInCooldown(alertKey)) {
          recordAlert(alertKey);
          const depth = jobQueue.queueDepth(nodeName);
          await alert(
            `${EXPECTED_NODES[nodeName]?.desc || nodeName} training **STALLED**!\n` +
            `Log: \`${activePath}\` — last modified ${mostRecentModMin.toFixed(0)}min ago\n` +
            `Process: **DEAD**\n` +
            `Queue: ${depth} jobs remaining\n` +
            `Action: ${depth > 0 ? 'Auto-launching next queued job.' : 'No queued jobs — populate queue!'}`,
            true
          );
        }

        // Try to launch the next queued job
        const depth = jobQueue.queueDepth(nodeName);
        if (depth > 0) {
          const launched = await autoLaunchJob(nodeName);
          if (launched) delete _extState.gpu_idle_since[nodeName];
        }
      } else {
        log(`  ${nodeName}: Log stale but process alive (may be loading data or between folds)`);
      }
    }
  }

  saveExtendedState(_extState);
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE DEPTH MONITORING (every 5 min)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check all node queue depths. Alert on any below QUEUE_LOW_THRESHOLD.
 */
async function queueDepthCycle() {
  _extState.queue_checks++;
  log('--- Queue depth check ---');

  for (const nodeName of ALL_QUEUE_NODES) {
    try {
      const depth = jobQueue.queueDepth(nodeName);
      log(`  ${nodeName}: ${depth} queued jobs`);

      if (depth < QUEUE_LOW_THRESHOLD) {
        const alertKey = `queue_low:${nodeName}`;
        if (!alertInCooldown(alertKey)) {
          recordAlert(alertKey);
          warn(`${nodeName} queue running low: ${depth} jobs remaining`);
          // Send to #system-status
          const disc = loadDiscordConfig();
          if (disc.systemStatusId) {
            await sendDiscord(
              `⚠️ **Ray Watchdog**: Node **${nodeName}** queue running low — **${depth} jobs remaining** (threshold: ${QUEUE_LOW_THRESHOLD})`,
              disc.systemStatusId
            );
          }
        }
      }
    } catch (e) {
      err(`Queue depth check failed for ${nodeName}: ${e.message}`);
    }
  }

  saveExtendedState(_extState);
}

// ── Main watchdog loop ────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Check if a node is in cooldown after a failed reconnect attempt.
 */
function isInCooldown(history, nodeName) {
  const entry = history[nodeName];
  if (!entry) return false;
  if (entry.lastSuccess) return false; // successful reconnect clears cooldown
  const elapsed = Date.now() - (entry.lastAttempt || 0);
  return elapsed < RETRY_COOLDOWN_MS;
}

/**
 * Main check + reconnect cycle.
 */
async function runCycle(history) {
  // 1. Query Ray dashboard
  const aliveNodes = await queryRayNodes();

  if (aliveNodes === null) {
    // Dashboard unreachable — Jupiter may be down
    err('Ray dashboard unreachable (http://192.168.0.108:8265). Jupiter may be down.');
    await alert('Ray dashboard unreachable — Jupiter (head node) may be down! Manual intervention required.', true);
    return history;
  }

  // 2. Identify missing nodes
  const { present, missing } = classifyNodes(aliveNodes);

  log(`Alive nodes (${aliveNodes.length}): ${aliveNodes.map(n => `${n.hostname}(${n.ip})`).join(', ')}`);
  log(`Cluster status: present=[${[...present].join(', ')}] missing=[${[...missing].join(', ')}]`);

  // 3. Alert for Jupiter down (head node — can't auto-fix)
  if (missing.has('jupiter')) {
    // Only alert once per outage to avoid spam
    const jEntry = history.jupiter || {};
    if (!jEntry.alertedDown) {
      await alert('Jupiter HEAD node is missing from cluster! Cannot auto-reconnect head nodes. Check 192.168.0.108 manually.', true);
      history.jupiter = { ...jEntry, alertedDown: true, downSince: Date.now() };
      saveHistory(history);
    }
    return history;
  } else if (history.jupiter?.alertedDown) {
    // Jupiter came back
    await notify(`Jupiter HEAD node is back online!`);
    history.jupiter = {};
    saveHistory(history);
  }

  // 4. Process missing worker nodes
  const reconnectors = {
    neptune: reconnectNeptune,
    razer:   reconnectRazer,
    uranus:  reconnectUranus,
    saturn:  reconnectSaturn,
  };

  for (const nodeName of missing) {
    if (nodeName === 'jupiter') continue; // handled above

    const cfg   = EXPECTED_NODES[nodeName];
    const entry = history[nodeName] || {};

    // Check if node was previously known to be present (first drop detection)
    if (!entry.alertedDown) {
      await alert(`${cfg.desc} has dropped from the Ray cluster! Attempting reconnect...`, true);
      history[nodeName] = { ...entry, alertedDown: true, downSince: Date.now(), attempts: 0 };
      saveHistory(history);
    }

    // Check cooldown after failed attempt
    if (isInCooldown(history, nodeName)) {
      const waitSec = Math.round((RETRY_COOLDOWN_MS - (Date.now() - (history[nodeName].lastAttempt || 0))) / 1000);
      log(`${nodeName} in cooldown — ${waitSec}s remaining before retry`);
      continue;
    }

    // Attempt reconnect
    const reconnector = reconnectors[nodeName];
    if (!reconnector) {
      warn(`No reconnector defined for ${nodeName}`);
      continue;
    }

    log(`Attempting to reconnect ${nodeName}...`);
    history[nodeName] = {
      ...history[nodeName],
      lastAttempt: Date.now(),
      attempts: (history[nodeName]?.attempts || 0) + 1,
    };
    saveHistory(history);

    let result;
    try {
      result = await reconnector();
    } catch (e) {
      result = { success: false, output: e.message };
      err(`Reconnect ${nodeName} threw: ${e.message}`);
    }

    if (result.success) {
      log(`${nodeName} reconnect succeeded`);
      await notify(`${cfg.desc} successfully reconnected to Ray cluster (attempt #${history[nodeName].attempts})`);
      history[nodeName] = {
        ...history[nodeName],
        lastSuccess: Date.now(),
        alertedDown: false,  // reset for next drop event
      };
    } else {
      warn(`${nodeName} reconnect failed: ${result.output}`);
      await alert(`Failed to reconnect ${cfg.desc} (attempt #${history[nodeName].attempts}). Will retry in 5min. Output: ${result.output?.slice(0, 200)}`, false);
      history[nodeName] = {
        ...history[nodeName],
        lastFailure: Date.now(),
        lastOutput:  result.output?.slice(0, 500),
        lastSuccess: null,   // clear success so cooldown applies
      };
    }
    saveHistory(history);
  }

  // 5. Clear alertedDown flag for nodes that came back
  for (const nodeName of present) {
    const entry = history[nodeName] || {};
    if (entry.alertedDown) {
      const cfg = EXPECTED_NODES[nodeName];
      await notify(`${cfg.desc} is back in the cluster!`);
      history[nodeName] = {
        ...entry,
        alertedDown: false,
        lastRecovered: Date.now(),
      };
      saveHistory(history);
    }
  }

  return history;
}

async function main() {
  log('═══════════════════════════════════════════════════════════════');
  log('Ray Watchdog starting — full cluster health monitor');
  log(`  Ray connectivity:    every ${CHECK_INTERVAL_MS / 1000}s`);
  log(`  GPU utilization:     every ${GPU_CHECK_INTERVAL_MS / 1000}s`);
  log(`  Training staleness:  every ${TRAINING_CHECK_INTERVAL_MS / 1000}s`);
  log(`  Queue depth:         every ${QUEUE_CHECK_INTERVAL_MS / 1000}s`);
  log(`  GPU idle threshold:  ${GPU_IDLE_THRESHOLD_MIN} min at 0%`);
  log(`  Training stale:      ${TRAINING_STALE_MIN} min no log output`);
  log(`  Queue low threshold: ${QUEUE_LOW_THRESHOLD} jobs`);
  log(`  Alert cooldown:      ${ALERT_COOLDOWN_MS / 60_000} min`);
  log(`Dashboard: ${RAY_DASHBOARD_URL}`);
  log(`Expected nodes: ${Object.keys(EXPECTED_NODES).join(', ')}`);
  log('═══════════════════════════════════════════════════════════════');

  const disc = loadDiscordConfig();
  if (!disc.token) {
    warn('No Discord bot token in config.json — Discord alerts disabled');
  }

  // Send startup notification
  if (disc.systemStatusId) {
    await sendDiscord(
      '🔵 **Ray Watchdog** started — full cluster monitor\n' +
      '• Ray connectivity: 60s\n' +
      '• GPU idle detection: 120s (alert after 10min at 0%)\n' +
      '• Training staleness: 5min (alert after 30min no output)\n' +
      '• Queue depth: 5min (alert when <3 jobs)',
      disc.systemStatusId
    );
  }

  let history = loadHistory();

  // ── Staggered interval timers ────────────────────────────────────────────

  // Track last-run timestamps for each monitor
  let lastGpuCheck      = 0;
  let lastTrainingCheck = 0;
  let lastQueueCheck    = 0;

  // Main loop: Ray connectivity runs every tick (60s).
  // Other monitors run when their interval has elapsed.
  while (true) {
    const now = Date.now();

    // 1. Ray connectivity (every 60s — the main loop interval)
    try {
      history = await runCycle(history);
    } catch (e) {
      err(`Ray cycle error: ${e.message}\n${e.stack}`);
    }

    // 2. GPU utilization (every 120s)
    if (now - lastGpuCheck >= GPU_CHECK_INTERVAL_MS) {
      lastGpuCheck = now;
      try {
        await gpuUtilizationCycle();
      } catch (e) {
        err(`GPU cycle error: ${e.message}`);
      }
    }

    // 3. Training staleness (every 5 min)
    if (now - lastTrainingCheck >= TRAINING_CHECK_INTERVAL_MS) {
      lastTrainingCheck = now;
      try {
        await trainingStaleCycle();
      } catch (e) {
        err(`Training cycle error: ${e.message}`);
      }
    }

    // 4. Queue depth (every 5 min)
    if (now - lastQueueCheck >= QUEUE_CHECK_INTERVAL_MS) {
      lastQueueCheck = now;
      try {
        await queueDepthCycle();
      } catch (e) {
        err(`Queue cycle error: ${e.message}`);
      }
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

main().catch(e => {
  console.error(`[ray_watchdog] Fatal crash: ${e.message}\n${e.stack}`);
  process.exit(1);
});
