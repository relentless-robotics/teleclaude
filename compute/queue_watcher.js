#!/usr/bin/env node
/**
 * Queue Watcher — PM2-managed auto-dispatch for all 5 compute nodes.
 *
 * Every 60 seconds:
 *   1. For each node: if no job is currently running AND queue has items -> pop and launch
 *   2. Alert Discord if any node queue depth < 5 (so researchers can top up)
 *   3. Log all transitions: queued -> running -> done/failed
 *
 * Execution strategy (PRIMARY -> FALLBACK):
 *   ALL nodes: NodeAPI HTTP POST /exec (node_api_server.py on port 8765)
 *   Fallback:  Neptune local execSync / remote ssh_exec.py (if NodeAPI unreachable)
 *
 * The NodeAPI server must be running on each node (see compute/node_api.ecosystem.js).
 * Set NODE_API_KEY env var to the shared secret.
 *
 * The watcher does NOT kill running jobs -- it only observes status from the
 * queue file. Completion/failure must be signalled externally via:
 *   node compute/queue_watcher.js --complete --node <n> --id <jobId> --result "IC=0.17"
 *   node compute/queue_watcher.js --fail     --node <n> --id <jobId> --error "OOM"
 *
 * Usage:
 *   pm2 start compute/queue_watcher.ecosystem.js
 *   node compute/queue_watcher.js --status
 *   node compute/queue_watcher.js --ping          (check NodeAPI reachability)
 *   node compute/queue_watcher.js --add --node jupiter --name hold_time_test \
 *       --desc "Hold time opt z>2.0" --cmd "python3 scripts/foo.py" --priority 2
 */

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { execSync, spawn } = require('child_process');

const queue = require('./job_queue');

// NodeAPI client (HTTP-based remote execution)
const { NodeAPI, NODE_CONFIGS, pingAll } = require('./node_api_client');

// ============================================================================
// MLFLOW LOGGING HELPERS
// ============================================================================

const LOG_TO_MLFLOW_PY = path.join(__dirname, 'log_to_mlflow.py');

function inferExperiment(job) {
  const tagAliases = {
    fill_sim:  'Fill_Sim_Sweeps',
    fillsim:   'Fill_Sim_Sweeps',
    cnn:       'CNN_Training',
    training:  'CNN_Training',
    wf:        'CNN_Training',
    signal:    'Signal_Research',
    lgbm:      'Signal_Research',
    gbm:       'Signal_Research',
    math:      'Signal_Research',
    execution: 'Execution_Research',
    sweep:     'Fill_Sim_Sweeps',
    optuna:    'Fill_Sim_Sweeps',
    infra:     'Infrastructure',
    monitor:   'Infrastructure',
  };
  const tags = (job.tags || []).map(t => t.toLowerCase());
  const name = (job.name || '').toLowerCase();
  for (const [alias, exp] of Object.entries(tagAliases)) {
    if (tags.some(t => t.includes(alias)) || name.includes(alias)) return exp;
  }
  return 'Infrastructure';
}

function parseResultSummary(summary) {
  if (!summary || typeof summary !== 'string') return {};
  const metrics = {};
  const re = /(\w+)\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(summary)) !== null) {
    const v = parseFloat(m[2]);
    if (!isNaN(v)) metrics[m[1].toLowerCase()] = v;
  }
  return metrics;
}

function logJobToMlflow(job, status, artifactPath = null) {
  if (!fs.existsSync(LOG_TO_MLFLOW_PY)) {
    log('WARN', `MLflow logger not found at ${LOG_TO_MLFLOW_PY}`);
    return;
  }
  const experiment = inferExperiment(job);
  const runName    = `${job.name}_${job.id}`;
  const params = {
    node:            job.node     || 'unknown',
    job_id:          job.id       || '',
    priority:        job.priority || 5,
    tags:            (job.tags || []).join(','),
    command_preview: (job.command || '').slice(0, 200),
  };
  const metrics = parseResultSummary(job.result_summary);
  if (job.started_at && job.completed_at) {
    const durationMs = new Date(job.completed_at) - new Date(job.started_at);
    if (!isNaN(durationMs)) metrics['duration_minutes'] = durationMs / 60000;
  }
  const tags = { status, node: job.node || 'unknown', job_id: job.id || '', experiment };
  const args = [
    LOG_TO_MLFLOW_PY,
    '--experiment', experiment,
    '--run-name',   runName,
    '--params',     JSON.stringify(params),
    '--metrics',    JSON.stringify(metrics),
    '--tags',       JSON.stringify(tags),
  ];
  if (artifactPath && fs.existsSync(artifactPath)) {
    const isFillSim = /fill_sim|fillsim|results?\.json/i.test(path.basename(artifactPath));
    args.push(isFillSim ? '--fill-sim-result' : '--artifact', artifactPath);
  }
  try {
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonExe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    proc.unref();
    log('INFO', `[MLFLOW] Logging job ${job.id} (${status}) to "${experiment}"`);
  } catch (e) {
    log('WARN', `[MLFLOW] Failed to spawn logger: ${e.message}`);
  }
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_DIR       = path.join(__dirname, '..');
const LOG_FILE       = path.join(__dirname, 'queue_watcher.log');
const STATE_FILE     = path.join(__dirname, 'queue_watcher_state.json');

const QCC_BASE       = `http://localhost:${process.env.QCC_PORT || 3456}`;
const POLL_INTERVAL  = parseInt(process.env.QW_POLL_MS   || '60000', 10);
const LOW_QUEUE_WARN = parseInt(process.env.QW_LOW_DEPTH || '5',     10);
const LAUNCH_TIMEOUT = parseInt(process.env.QW_LAUNCH_MS || '60000', 10);

// Node metadata -- OS and fallback execution details
const NODE_META = {
  neptune: { os: 'windows', local: true,  python: 'python',  lvl3: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant' },
  uranus:  { os: 'windows', local: false, python: 'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe', lvl3: 'C:\\Users\\nick\\Lvl3Quant' },
  razer:   { os: 'windows', local: false, python: 'C:\\Python311\\python.exe', lvl3: 'C:\\Users\\claude\\Lvl3Quant' },
  jupiter: { os: 'linux',   local: false, python: 'python3', lvl3: '/home/jupiter/Lvl3Quant' },
  saturn:  { os: 'linux',   local: false, python: 'python3', lvl3: '/home/saturn/Lvl3Quant' },
};

// GPU nodes -- require GPU idle check before dispatch
const GPU_NODES = new Set(['neptune', 'uranus', 'razer']);

// ── Path conversion for cross-OS dispatch ───────────────────────────────
// Maps between Windows and Linux Lvl3Quant paths.

const PATH_MAP = [
  // Windows path prefix → Linux path prefix (per node)
  { win: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant', linux: '/home/jupiter/Lvl3Quant',  nodes: ['jupiter', 'saturn'] },
  { win: 'C:/Users/Footb/Documents/Github/Lvl3Quant',      linux: '/home/jupiter/Lvl3Quant',  nodes: ['jupiter', 'saturn'] },
  { win: 'C:\\Users\\nick\\Lvl3Quant',                      linux: '/home/nick/Lvl3Quant',     nodes: [] },
  { win: 'C:\\Users\\claude\\Lvl3Quant',                    linux: '/home/claude/Lvl3Quant',   nodes: [] },
];

/**
 * Convert paths in a command string to match the target node's OS.
 * Handles both `cwd` and inline path references in the command.
 *
 * @param {string} str   — Command string or cwd path
 * @param {string} targetNode — Target node name
 * @returns {string} — Converted string
 */
function convertPathForNode(str, targetNode) {
  if (!str) return str;
  const targetMeta = NODE_META[targetNode];
  if (!targetMeta) return str;

  const isTargetWindows = targetMeta.os === 'windows';

  // Detect if the string contains the "wrong" OS paths and convert
  if (isTargetWindows) {
    // Target is Windows: convert any Linux paths to Windows
    for (const mapping of PATH_MAP) {
      if (str.includes(mapping.linux)) {
        // Use the target node's own lvl3 path
        str = str.split(mapping.linux).join(targetMeta.lvl3);
      }
    }
    // Convert remaining forward-slash paths to backslash (heuristic)
    // Only for absolute paths starting with /home/
    str = str.replace(/\/home\/\w+\/Lvl3Quant/g, targetMeta.lvl3);
  } else {
    // Target is Linux: convert any Windows paths to Linux
    for (const mapping of PATH_MAP) {
      // Handle both \ and / separators in Windows paths
      const winNorm = mapping.win.replace(/\\\\/g, '/');
      const strNorm = str.replace(/\\\\/g, '/');
      if (strNorm.includes(winNorm) || str.includes(mapping.win)) {
        str = str.split(mapping.win).join(mapping.linux);
        str = str.replace(new RegExp(winNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), mapping.linux);
      }
    }
    // Also convert backslash separators to forward slash in remaining paths
    str = str.replace(/C:\\Users\\\w+\\Lvl3Quant/gi, targetMeta.lvl3);
    str = str.replace(/C:\/Users\/\w+\/Lvl3Quant/gi, targetMeta.lvl3);
    // Convert python → python3 for Linux
    if (str.startsWith('python ') && targetMeta.python === 'python3') {
      str = 'python3 ' + str.slice(7);
    }
  }

  return str;
}

// Low-priority Windows nodes (for SSH fallback launch only)
const BELOW_NORMAL_NODES = new Set(['neptune']);

// NodeAPI client instances (lazily created, one per node)
const _nodeClients = {};

function getNodeClient(nodeName) {
  if (!_nodeClients[nodeName]) {
    const cfg = NODE_CONFIGS[nodeName];
    if (!cfg) throw new Error(`No NodeAPI config for node: ${nodeName}`);
    _nodeClients[nodeName] = new NodeAPI(cfg.host, cfg.port, process.env.NODE_API_KEY);
  }
  return _nodeClients[nodeName];
}

// ============================================================================
// LOGGING
// ============================================================================

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  let entry = `[${ts}] [${level}] ${msg}`;
  if (data !== null && data !== undefined) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch { entry += ' | [unserializable]'; }
  }
  entry += '\n';
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 20 * 1024 * 1024) {
      const bak = LOG_FILE + '.' + new Date().toISOString().slice(0, 10) + '.bak';
      try { fs.renameSync(LOG_FILE, bak); } catch {}
    }
  } catch {}
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
    started_at:        new Date().toISOString(),
    total_dispatches:  0,
    total_completions: 0,
    total_failures:    0,
    last_low_alert:    {},
    running:           {},
    poll_count:        0,
    node_api_last_ok:  {},
    node_api_fails:    {},
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
// HTTP HELPERS (QCC daemon)
// ============================================================================

function httpPost(urlPath, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlPath, QCC_BASE);
    const data = JSON.stringify(payload);
    const opts = {
      method:   'POST',
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname + (url.search || ''),
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP timeout (${timeoutMs}ms)`)); });
    req.write(data);
    req.end();
  });
}

function httpGet(urlPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, QCC_BASE);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

// ============================================================================
// DISCORD ALERTS
// ============================================================================

let _notifier = null;
function getNotifier() {
  if (!_notifier) {
    try {
      _notifier = require(path.join(BASE_DIR, 'utils', 'webhook_notifier'));
    } catch {
      _notifier = {
        notifications: {
          info:    () => Promise.resolve(),
          warning: () => Promise.resolve(),
          error:   () => Promise.resolve(),
          success: () => Promise.resolve(),
        }
      };
    }
  }
  return _notifier;
}

async function alertDiscord(type, title, message) {
  try {
    const n = getNotifier();
    const method = { info: 'info', warning: 'warning', error: 'error', success: 'success' }[type] || 'info';
    await n.notifications[method](title, message);
  } catch (e) {
    log('WARN', `Discord alert failed: ${e.message}`);
  }
  try {
    const severity = (type === 'error') ? 'critical' : (type === 'warning' ? 'warning' : 'info');
    await httpPost('/api/alerts', { severity, source: 'queue_watcher', message: `${title}: ${message}` });
  } catch {}
}

// ============================================================================
// COMMAND EXECUTION -- NodeAPI PRIMARY, SSH FALLBACK
// ============================================================================

/**
 * Launch a job via NodeAPI HTTP (primary path).
 * Uses background=true so the node runs the command detached and returns PID immediately.
 */
async function launchViaNodeAPI(nodeName, command, cwd) {
  const client = getNodeClient(nodeName);
  try {
    const result = await client.exec(command, {
      background: true,
      cwd:        cwd || NODE_META[nodeName]?.lvl3 || null,
      timeout:    Math.floor(LAUNCH_TIMEOUT / 1000),
    });
    return {
      success: true,
      pid:     result.pid || null,
      stdout:  `PID ${result.pid || '?'} started at ${result.started_at || 'unknown'}`,
      stderr:  '',
      via:     'node_api',
    };
  } catch (err) {
    return { success: false, pid: null, stdout: '', stderr: err.message, via: 'node_api' };
  }
}

/**
 * SSH fallback for when NodeAPI is unreachable.
 * Neptune: local execSync.  Others: ssh_exec.py.
 */
async function launchViaSSHFallback(nodeName, command, cwd) {
  const meta = NODE_META[nodeName];
  let fullCmd = command;
  if (cwd) {
    fullCmd = meta.os === 'windows'
      ? `cd /d "${cwd}" && ${command}`
      : `cd "${cwd}" && ${command}`;
  }

  if (meta.local) {
    try {
      // Use spawn with windowsHide:true + detached so no console window appears.
      // 'start /B cmd /c' would spawn a visible child cmd window even if the outer
      // execSync has windowsHide:true, because the visibility flag only applies to
      // the top-level process.
      const spawnOpts = {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      };
      const child = spawn(fullCmd, [], spawnOpts);
      child.unref();
      return { success: true, stdout: 'local launch ok', stderr: '', via: 'local_exec' };
    } catch (e) {
      return { success: false, stdout: '', stderr: e.message, via: 'local_exec' };
    }
  }

  const sshExecPy = path.join(BASE_DIR, 'utils', 'ssh_exec.py');
  const remoteCmd = meta.os === 'linux'
    ? `nohup bash -c ${JSON.stringify(fullCmd)} > /tmp/queue_watcher_last.log 2>&1 &`
    : `start /B cmd /c "${fullCmd.replace(/"/g, '\\"')}"`;

  try {
    const out = execSync(
      `python3 "${sshExecPy}" --server ${nodeName} --timeout ${Math.floor(LAUNCH_TIMEOUT / 1000)} ${JSON.stringify(remoteCmd)}`,
      { timeout: LAUNCH_TIMEOUT + 5000, maxBuffer: 1024 * 1024, windowsHide: true }
    ).toString();
    return { success: true, stdout: out, stderr: '', via: 'ssh_fallback' };
  } catch (e) {
    return { success: false, stdout: '', stderr: e.stderr ? e.stderr.toString() : e.message, via: 'ssh_fallback' };
  }
}

/**
 * Primary entry point for launching a job on a node.
 *
 * 1. Try NodeAPI HTTP (fast, reliable when server is running).
 * 2. On failure: log warning, increment failure counter.
 * 3. After 3 consecutive NodeAPI failures: alert Discord.
 * 4. Fall back to SSH.
 */
async function launchOnRemoteNode(nodeName, command, cwd, state) {
  const apiResult = await launchViaNodeAPI(nodeName, command, cwd);

  if (apiResult.success) {
    state.node_api_fails   = state.node_api_fails   || {};
    state.node_api_last_ok = state.node_api_last_ok || {};
    state.node_api_fails[nodeName]   = 0;
    state.node_api_last_ok[nodeName] = new Date().toISOString();
    log('INFO', `[NodeAPI] ${nodeName}: launched OK via HTTP (PID ${apiResult.pid})`);
    return apiResult;
  }

  state.node_api_fails = state.node_api_fails || {};
  state.node_api_fails[nodeName] = (state.node_api_fails[nodeName] || 0) + 1;
  const failCount = state.node_api_fails[nodeName];

  log('WARN', `[NodeAPI] ${nodeName}: HTTP failed (attempt ${failCount}): ${apiResult.stderr.slice(0, 200)}`);

  if (failCount === 3) {
    await alertDiscord('warning',
      `Node API Unreachable: ${nodeName}`,
      `node_api_server.py on ${nodeName} has failed ${failCount} times.\n` +
      `Last error: ${apiResult.stderr.slice(0, 300)}\n` +
      `Falling back to SSH. Check: pm2 logs node-api-${nodeName}`
    );
  }

  log('INFO', `[SSH-Fallback] ${nodeName}: attempting SSH launch`);
  const sshResult = await launchViaSSHFallback(nodeName, command, cwd);

  if (!sshResult.success) {
    log('ERROR', `[SSH-Fallback] ${nodeName}: also failed: ${sshResult.stderr.slice(0, 200)}`);
  } else {
    log('INFO', `[SSH-Fallback] ${nodeName}: launch succeeded via ${sshResult.via}`);
  }
  return sshResult;
}

/**
 * Check if a node has an actively running job.
 * For GPU nodes: also queries actual GPU utilization to detect stale "running" entries.
 * Priority: NodeAPI /gpu > QCC health API > trust queue file.
 */
async function isNodeBusy(nodeName) {
  const nodeQueue  = queue.getQueue(nodeName);
  const runningJob = nodeQueue.find(j => j.status === 'running');
  if (!runningJob) return false;

  if (GPU_NODES.has(nodeName)) {
    // Try NodeAPI /gpu first (most accurate for remote nodes)
    try {
      const client  = getNodeClient(nodeName);
      const gpuData = await client.gpu();
      const gpus    = gpuData.gpus || [];
      if (gpus.length > 0) {
        const maxUtil = Math.max(...gpus.map(g => g.util_pct || 0));
        if (maxUtil <= 2) {
          const elapsedMin = (Date.now() - new Date(runningJob.started_at || 0).getTime()) / 60000;
          if (elapsedMin > 5) {
            log('WARN', `${nodeName}: job ${runningJob.id} stuck as 'running' but GPU util=${maxUtil}% for ${elapsedMin.toFixed(1)}min. Treating as not busy.`);
            return false;
          }
        }
        return true;
      }
    } catch (e) {
      log('DEBUG', `${nodeName}: NodeAPI /gpu unavailable (${e.message}), trying QCC`);
    }

    // Fallback to QCC health API
    try {
      const health   = await httpGet('/api/health', 8000);
      const nodeData = (health.nodes || []).find(n => n.name === nodeName);
      if (nodeData) {
        const gpuUtil = nodeData.last_gpu_util;
        if (gpuUtil !== null && gpuUtil !== undefined && gpuUtil <= 2) {
          const elapsedMin = (Date.now() - new Date(runningJob.started_at || 0).getTime()) / 60000;
          if (elapsedMin > 5) {
            log('WARN', `${nodeName}: QCC GPU=${gpuUtil}% for ${elapsedMin.toFixed(1)}min. Treating as not busy.`);
            return false;
          }
        }
      }
    } catch {}
    // Both unavailable -- trust the queue file
  }

  return true;
}

// ============================================================================
// NODE API HEALTH CHECK (startup + periodic)
// ============================================================================

async function checkNodeAPIHealth() {
  const results = {};
  await Promise.all(queue.NODES.map(async (nodeName) => {
    try {
      const client = getNodeClient(nodeName);
      const health = await client.health();
      results[nodeName] = {
        ok:        true,
        hostname:  health.hostname || '?',
        uptime_s:  health.uptime_s,
        gpu_count: (health.gpu || []).length,
      };
    } catch (e) {
      results[nodeName] = { ok: false, error: e.message };
    }
  }));

  const up   = Object.entries(results).filter(([, r]) => r.ok).map(([n]) => n);
  const down = Object.entries(results).filter(([, r]) => !r.ok).map(([n]) => n);
  log('INFO', `NodeAPI health: UP=[${up.join(',')}] DOWN=[${down.join(',')}]`);
  if (down.length > 0) {
    log('WARN', `NodeAPI unreachable on: ${down.join(', ')} -- SSH fallback will be used`);
    for (const n of down) log('WARN', `  ${n}: ${results[n].error}`);
  }
  return results;
}

// ============================================================================
// CORE DISPATCH LOGIC
// ============================================================================

async function processNode(nodeName, state) {
  const depth = queue.queueDepth(nodeName);

  if (depth < LOW_QUEUE_WARN) {
    const lastAlert = state.last_low_alert[nodeName];
    const cooloffMs = 4 * 60 * 60 * 1000;
    if (!lastAlert || Date.now() - new Date(lastAlert).getTime() > cooloffMs) {
      log('WARN', `${nodeName}: queue depth ${depth} < ${LOW_QUEUE_WARN} -- needs replenishment`);
      await alertDiscord('warning',
        `Queue Low: ${nodeName}`,
        `Only ${depth} jobs queued on ${nodeName} (threshold: ${LOW_QUEUE_WARN}). Consider adding more experiments.`
      );
      state.last_low_alert[nodeName] = new Date().toISOString();
    }
  }

  if (depth === 0) {
    log('DEBUG', `${nodeName}: no queued jobs`);
    return;
  }

  const busy = await isNodeBusy(nodeName);
  if (busy) {
    const runningJob = queue.getQueue(nodeName).find(j => j.status === 'running');
    log('DEBUG', `${nodeName}: busy (running: ${runningJob?.name || 'unknown'})`);
    return;
  }

  const job = queue.popNext(nodeName);
  if (!job) return;

  log('INFO', `[DISPATCH] ${nodeName}: launching job ${job.id} - "${job.name}"`, {
    priority: job.priority,
    command:  job.command.slice(0, 120),
    tags:     job.tags,
  });

  // Convert paths if the job was queued from a different OS
  const convertedCommand = convertPathForNode(job.command, nodeName);
  const convertedCwd     = convertPathForNode(job.cwd, nodeName);
  if (convertedCommand !== job.command || convertedCwd !== job.cwd) {
    log('INFO', `[PATH-CONVERT] ${nodeName}: cmd="${convertedCommand.slice(0, 120)}" cwd="${convertedCwd}"`);
  }

  const result = await launchOnRemoteNode(nodeName, convertedCommand, convertedCwd, state);

  if (result.success) {
    state.total_dispatches++;
    state.running[nodeName] = {
      jobId:     job.id,
      startedAt: new Date().toISOString(),
      via:       result.via,
      pid:       result.pid || null,
    };

    await alertDiscord('info',
      `Job Launched: ${nodeName}`,
      `**${job.name}** (P${job.priority}) via ${result.via}\n` +
      `${job.description}\n` +
      `PID: ${result.pid || 'unknown'} | Queue depth after: ${queue.queueDepth(nodeName)}\n` +
      `Tags: ${job.tags.join(', ') || 'none'}`
    );
    log('INFO', `[DISPATCH] ${nodeName}: job ${job.id} launched successfully via ${result.via}`);
  } else {
    queue.failJob(nodeName, job.id, result.stderr.slice(0, 300));
    state.total_failures++;

    log('ERROR', `[DISPATCH] ${nodeName}: job ${job.id} FAILED (tried NodeAPI + SSH fallback)`, {
      stderr: result.stderr.slice(0, 300),
      via:    result.via,
    });

    await alertDiscord('error',
      `Launch Failed: ${nodeName}`,
      `**${job.name}** failed to start on ${nodeName} (tried NodeAPI + SSH fallback).\n` +
      `Error: ${result.stderr.slice(0, 400)}\n` +
      `Job marked as failed. Next queued job will attempt on next poll.\n` +
      `Check: pm2 logs node-api-${nodeName}`
    );
  }
}

// ============================================================================
// MAIN POLL LOOP
// ============================================================================

let _state = loadState();
let _consecutiveErrors = 0;
let _pollsSinceHealthCheck = 0;
const MAX_ERRORS = 10;
const HEALTH_CHECK_INTERVAL = 10; // check NodeAPI health every N polls

async function poll() {
  _state.poll_count = (_state.poll_count || 0) + 1;
  _pollsSinceHealthCheck++;

  if (_state.poll_count % 5 === 0) {
    const summary    = queue.allQueues();
    const summaryStr = Object.entries(summary)
      .map(([n, s]) => `${n}:${s.depth}q/${s.running_job ? '1r' : '0r'}`)
      .join(' ');
    log('INFO', `Poll #${_state.poll_count}: ${summaryStr}`);
  }

  // Periodic NodeAPI health check (every 10 polls = ~10 min with 60s interval)
  if (_pollsSinceHealthCheck >= HEALTH_CHECK_INTERVAL) {
    _pollsSinceHealthCheck = 0;
    checkNodeAPIHealth().catch(e => log('WARN', `Health check error: ${e.message}`));
  }

  try {
    await Promise.all(queue.NODES.map(n => processNode(n, _state).catch(e => {
      log('ERROR', `processNode(${n}) threw: ${e.message}`);
    })));
    _consecutiveErrors = 0;
    saveState(_state);
  } catch (e) {
    _consecutiveErrors++;
    log('ERROR', `Poll #${_state.poll_count} error: ${e.message}`);
    if (_consecutiveErrors >= MAX_ERRORS) {
      log('ERROR', `${MAX_ERRORS} consecutive poll errors.`);
      await alertDiscord('error', 'Queue Watcher: Repeated Errors',
        `${MAX_ERRORS} consecutive poll failures. Last error: ${e.message}`).catch(() => {});
      _consecutiveErrors = 0;
    }
  }
}

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  log('INFO', '===========================================');
  log('INFO', 'Queue Watcher starting');
  log('INFO', `QCC base: ${QCC_BASE}`);
  log('INFO', `Poll interval: ${POLL_INTERVAL}ms`);
  log('INFO', `Low-queue threshold: ${LOW_QUEUE_WARN}`);
  log('INFO', `Nodes: ${queue.NODES.join(', ')}`);
  log('INFO', `Node API key: ${process.env.NODE_API_KEY ? 'SET' : 'NOT SET (open access)'}`);
  log('INFO', '===========================================');

  const summary = queue.allQueues();
  for (const [node, s] of Object.entries(summary)) {
    log('INFO', `  ${node}: ${s.depth} queued, ${s.running_job ? `running: ${s.running_job.name}` : 'idle'}`);
  }

  log('INFO', 'Checking NodeAPI server health on all nodes...');
  const healthResults = await checkNodeAPIHealth().catch(e => {
    log('WARN', `Startup health check failed: ${e.message}`);
    return {};
  });

  const upNodes   = Object.entries(healthResults).filter(([, r]) => r.ok).map(([n]) => n);
  const downNodes = Object.entries(healthResults).filter(([, r]) => !r.ok).map(([n]) => n);

  await alertDiscord('info',
    'Queue Watcher Started',
    `Monitoring ${queue.NODES.join(', ')} every ${POLL_INTERVAL / 1000}s.\n` +
    `Queues: ${Object.entries(queue.allQueues()).map(([n, s]) => `${n}:${s.depth}`).join(', ')}\n` +
    `NodeAPI: UP=[${upNodes.join(',')}]${downNodes.length ? ` DOWN=[${downNodes.join(',')}] (SSH fallback active)` : ''}`
  );

  await poll();
  setInterval(poll, POLL_INTERVAL);
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

function shutdown(sig) {
  log('INFO', `Received ${sig}, saving state and exiting...`);
  saveState(_state);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log('ERROR', `Uncaught exception: ${e.message}`, { stack: e.stack?.slice(0, 500) });
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${String(reason).slice(0, 300)}`);
});

// ============================================================================
// CLI INTERFACE
// ============================================================================

const argv = process.argv.slice(2);

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

// --status: print all queues and exit
if (argv.includes('--status')) {
  const s  = queue.allQueues();
  const st = loadState();
  console.log('\n=== Queue Watcher Status ===');
  console.log(`Started: ${st.started_at}`);
  console.log(`Dispatches: ${st.total_dispatches}  Completions: ${st.total_completions}  Failures: ${st.total_failures}`);
  console.log('\nNodeAPI last ok:', JSON.stringify(st.node_api_last_ok || {}, null, 2));
  console.log('NodeAPI fail counts:', JSON.stringify(st.node_api_fails || {}, null, 2));
  console.log('\n=== Queues ===');
  for (const [node, info] of Object.entries(s)) {
    console.log(`\n${node.toUpperCase()}:`);
    console.log(`  Queued: ${info.depth}`);
    console.log(`  Running: ${info.running_job ? `${info.running_job.name} (since ${info.running_job.started_at})` : 'none'}`);
    console.log(`  Next: ${info.next_in_queue ? `[P${info.next_in_queue.priority}] ${info.next_in_queue.name}` : 'none'}`);
    console.log(`  Last done: ${info.last_completed ? `${info.last_completed.name} -> ${info.last_completed.result_summary || info.last_completed.status}` : 'none'}`);
    for (const j of queue.getQueue(node).filter(j => j.status === 'queued')) {
      console.log(`    [P${j.priority}] ${j.id}  ${j.name}  -- ${j.description.slice(0, 80)}`);
    }
  }
  process.exit(0);
}

// --ping: check NodeAPI reachability and exit
else if (argv.includes('--ping')) {
  (async () => {
    console.log('Pinging NodeAPI servers on all nodes...\n');
    const results = await pingAll(process.env.NODE_API_KEY, 5000);
    for (const [node, ok] of Object.entries(results)) {
      const status = ok ? 'UP  (reachable)' : 'DOWN (unreachable -- SSH fallback will be used)';
      console.log(`  ${node.padEnd(10)} ${status}`);
    }
    const downCount = Object.values(results).filter(v => !v).length;
    if (downCount > 0) {
      console.log(`\n${downCount} node(s) unreachable.`);
      console.log('To deploy: pm2 start compute/node_api.ecosystem.js --only node-api-<name>');
    } else {
      console.log('\nAll NodeAPI servers reachable.');
    }
    process.exit(downCount > 0 ? 1 : 0);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

// --add: enqueue a single job and exit
else if (argv.includes('--add')) {
  const node     = getArg('--node');
  const name     = getArg('--name');
  const desc     = getArg('--desc');
  const cmd      = getArg('--cmd');
  const priority = getArg('--priority');
  const cwd      = getArg('--cwd');
  const tags     = getArg('--tags');

  if (!node || !cmd) {
    console.error('Usage: node queue_watcher.js --add --node <node> --cmd "<command>" [--name <n>] [--desc <d>] [--priority 5] [--cwd <path>] [--tags "fill_sim,lgbm"]');
    process.exit(1);
  }
  const job = queue.addJob(node, {
    name:        name     || cmd.split(' ')[0],
    description: desc     || cmd,
    command:     cmd,
    priority:    priority ? parseInt(priority, 10) : 5,
    cwd:         cwd      || null,
    tags:        tags     ? tags.split(',').map(t => t.trim()) : [],
  });
  console.log(`Enqueued on ${node}:\n${JSON.stringify(job, null, 2)}`);
  process.exit(0);
}

// --complete: mark a job done
else if (argv.includes('--complete')) {
  const node     = getArg('--node');
  const id       = getArg('--id');
  const result   = getArg('--result');
  const artifact = getArg('--artifact');
  if (!node || !id) {
    console.error('Usage: node queue_watcher.js --complete --node <node> --id <jobId> [--result "IC=0.17"] [--artifact /path/result.json]');
    process.exit(1);
  }
  const job = queue.completeJob(node, id, result);
  if (!job) { console.error(`Job ${id} not found on ${node}`); process.exit(1); }
  console.log(`Marked done: ${JSON.stringify(job, null, 2)}`);
  logJobToMlflow(job, 'FINISHED', artifact || null);
  process.exit(0);
}

// --fail: mark a job failed
else if (argv.includes('--fail')) {
  const node  = getArg('--node');
  const id    = getArg('--id');
  const error = getArg('--error');
  if (!node || !id) {
    console.error('Usage: node queue_watcher.js --fail --node <node> --id <jobId> [--error "OOM"]');
    process.exit(1);
  }
  const job = queue.failJob(node, id, error);
  if (!job) { console.error(`Job ${id} not found on ${node}`); process.exit(1); }
  console.log(`Marked failed: ${JSON.stringify(job, null, 2)}`);
  logJobToMlflow(job, 'FAILED', null);
  process.exit(0);
}

// --retry: re-queue a failed job
else if (argv.includes('--retry')) {
  const node = getArg('--node');
  const id   = getArg('--id');
  if (!node || !id) {
    console.error('Usage: node queue_watcher.js --retry --node <node> --id <jobId>');
    process.exit(1);
  }
  const job = queue.retryJob(node, id);
  if (!job) { console.error(`Job ${id} not found on ${node}`); process.exit(1); }
  console.log(`Re-queued: ${JSON.stringify(job, null, 2)}`);
  process.exit(0);
}

// --drain: clear queued jobs from a node
else if (argv.includes('--drain')) {
  const node = getArg('--node');
  if (!node) {
    console.error('Usage: node queue_watcher.js --drain --node <node>');
    process.exit(1);
  }
  const count = queue.drainQueue(node);
  console.log(`Drained ${count} queued jobs from ${node}.`);
  process.exit(0);
}

// Normal daemon mode
else {
  main().catch(e => {
    log('ERROR', `Fatal startup error: ${e.message}`, { stack: e.stack });
    process.exit(1);
  });
}
