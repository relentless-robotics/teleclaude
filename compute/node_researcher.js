#!/usr/bin/env node
/**
 * Node Researcher — Persistent PM2-managed research process per compute node.
 *
 * Runs 24/7 independent of Claude sessions. One instance per node via PM2.
 * Polls node health, monitors running jobs, detects crashes/completions,
 * and auto-launches the next research experiment from the priority queue.
 *
 * Usage:
 *   node compute/node_researcher.js --node neptune
 *   pm2 start compute/researcher.ecosystem.js
 *
 * CRITICAL RULES:
 *   - NEVER connect to Rithmic. Only manage training/research processes.
 *   - Neptune training BELOW_NORMAL priority. Paper engine must be running.
 *   - Razer: NO deep learning. Math strategies, LGBM, GPU backtesting only.
 *   - Neptune RAM must stay < 85%.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

const args = process.argv.slice(2);
let NODE_NAME = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--node' && args[i + 1]) {
    NODE_NAME = args[i + 1].toLowerCase();
    break;
  }
}

if (!NODE_NAME) {
  console.error('Usage: node compute/node_researcher.js --node <neptune|uranus|razer|jupiter|saturn>');
  process.exit(1);
}

const VALID_NODES = ['neptune', 'uranus', 'razer', 'jupiter', 'saturn'];
if (!VALID_NODES.includes(NODE_NAME)) {
  console.error(`Invalid node: ${NODE_NAME}. Must be one of: ${VALID_NODES.join(', ')}`);
  process.exit(1);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_DIR = path.join(__dirname, '..');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const COMPUTE_DIR = path.join(BASE_DIR, 'compute');
const LOG_FILE = path.join(LOGS_DIR, `researcher-${NODE_NAME}.log`);
const STATE_FILE = path.join(COMPUTE_DIR, `researcher-${NODE_NAME}-state.json`);
const PRIORITIES_FILE = path.join(COMPUTE_DIR, 'research_priorities.json');
const QUEUE_FILE = path.join(COMPUTE_DIR, 'job_queues.json');
const SERVERS_FILE = path.join(BASE_DIR, 'config', 'remote_servers.json');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const CHANNELS_FILE = path.join(BASE_DIR, 'trading_agents', 'data', 'discord_channels.json');

const QCC_BASE = `http://localhost:${process.env.QCC_PORT || 3456}`;
const POLL_INTERVAL_MS = 60000;        // 60 seconds
const CRASH_CONFIRM_MS = 180000;       // 3 minutes GPU idle = crash
const LOG_CHECK_INTERVAL_MS = 90000;   // Check training logs every 90s
const SSH_TIMEOUT_MS = 30000;          // SSH command timeout

// Neptune-specific paths
const PAPER_STATE_PATH = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\live_trading\\logs\\paper\\live_state.json';
const NEPTUNE_LVL3_ROOT = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant';

// Node metadata
const NODE_CONFIG = {
  neptune: {
    local: true, os: 'windows', gpu: 'RTX 3090',
    workdir: NEPTUNE_LVL3_ROOT,
    python: 'python',
    constraints: ['paper_engine_must_run', 'below_normal_priority', 'ram_under_85'],
  },
  uranus: {
    local: false, os: 'windows', gpu: 'RTX 5090',
    host: '100.100.83.37', user: 'nick',
    workdir: 'C:\\Users\\nick\\Lvl3Quant',
    python: 'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
    constraints: [],
  },
  razer: {
    local: false, os: 'windows', gpu: 'RTX 3070',
    host: '100.102.215.75', user: 'claude',
    workdir: 'C:\\Users\\claude\\Documents\\Lvl3Quant',
    python: 'C:\\Python311\\python.exe',
    constraints: ['no_deep_learning'],
  },
  jupiter: {
    local: false, os: 'linux', gpu: null,
    host: '192.168.0.108', user: 'jupiter',
    workdir: '/home/jupiter/Lvl3Quant',
    python: 'python3',
    constraints: [],
  },
  saturn: {
    local: false, os: 'linux', gpu: null,
    host: '10.0.0.2', user: 'saturn',
    hop_through: 'jupiter',
    workdir: '/home/saturn/Lvl3Quant',
    python: 'python3',
    constraints: [],
  },
};

const COMPLETION_MARKERS = [
  'Training complete', 'All folds finished', 'all folds complete',
  'TRAINING FINISHED', 'WalkForward complete', 'walk_forward complete',
  'Experiment complete', '=== DONE ===', 'Sweep complete',
  'Analysis complete', 'All configs tested', 'Feature importance complete',
];

const THIS_NODE = NODE_CONFIG[NODE_NAME];

// ============================================================================
// LOGGING
// ============================================================================

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(LOGS_DIR);
ensureDir(COMPUTE_DIR);

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  let entry = `[${ts}] [${NODE_NAME}] [${level}] ${msg}`;
  if (data) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch { entry += ' | [unserializable]'; }
  }
  entry += '\n';

  // Rotate log if > 5MB
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      const rotated = LOG_FILE + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch { /* file may not exist */ }

  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch { /* best effort */ }

  if (level === 'ERROR') {
    process.stderr.write(entry);
  } else {
    process.stdout.write(entry);
  }
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    log('WARN', `Failed to load state: ${e.message}`);
  }
  return {
    current_job: null,          // { id, command, description, started_at, pid?, log_file? }
    last_completed_job: null,
    crash_watch: null,          // { first_idle_at, confirmed }
    consecutive_failures: 0,
    total_jobs_launched: 0,
    total_jobs_completed: 0,
    total_crashes_recovered: 0,
    last_poll_at: null,
    last_gpu_status: null,
    last_error: null,
    started_at: new Date().toISOString(),
  };
}

function saveState(state) {
  try {
    state.last_poll_at = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log('ERROR', `Failed to save state: ${e.message}`);
  }
}

// ============================================================================
// HTTP HELPERS (QCC communication)
// ============================================================================

function httpGet(urlPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, QCC_BASE);
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

function httpPost(urlPath, payload, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, QCC_BASE);
    const data = JSON.stringify(payload);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout,
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(data);
    req.end();
  });
}

// ============================================================================
// DISCORD NOTIFICATIONS
// ============================================================================

let _discordBotToken = null;
let _systemStatusChannelId = null;
let _alertsChannelId = null;

function loadDiscordConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _discordBotToken = config.discordToken || null;
  } catch { /* no config */ }
  try {
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    _systemStatusChannelId = channels.channels?.systemStatus || null;
    _alertsChannelId = channels.channels?.alerts || null;
  } catch { /* no channels file */ }
}
loadDiscordConfig();

function postToDiscord(channelId, embeds) {
  if (!_discordBotToken || !channelId) return Promise.resolve();

  const payload = JSON.stringify({ embeds });
  return new Promise((resolve) => {
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${_discordBotToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ ok: res.statusCode < 300, code: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false }); });
    req.write(payload);
    req.end();
  });
}

async function alertDiscord(severity, title, message, fields = []) {
  const colorMap = { critical: 0xef4444, warning: 0xfbbf24, info: 0x3b82f6, success: 0x4ade80 };
  const emojiMap = { critical: '\u274C', warning: '\u26A0\uFE0F', info: '\u2139\uFE0F', success: '\u2705' };

  const embed = {
    title: `${emojiMap[severity] || ''} [${NODE_NAME}] ${title}`,
    description: message.slice(0, 2000),
    color: colorMap[severity] || 0x3b82f6,
    fields: fields.map(f => ({ name: f.name, value: String(f.value).slice(0, 1024), inline: f.inline !== false })),
    timestamp: new Date().toISOString(),
    footer: { text: `researcher-${NODE_NAME}` },
  };

  const channel = (severity === 'critical') ? (_alertsChannelId || _systemStatusChannelId) : _systemStatusChannelId;
  if (channel) {
    await postToDiscord(channel, [embed]);
  }

  // Also log to QCC alerts
  try {
    await httpPost('/api/alerts', {
      severity: severity === 'success' ? 'info' : severity,
      source: `researcher-${NODE_NAME}`,
      message: `${title}: ${message.slice(0, 500)}`,
      node: NODE_NAME,
    });
  } catch { /* best effort */ }

  log(severity === 'critical' ? 'ERROR' : severity === 'success' ? 'INFO' : severity.toUpperCase(), `Discord: ${title} - ${message.slice(0, 200)}`);
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

/**
 * Execute a command on this node. Neptune = local, others = QCC SSH.
 * Returns { stdout, stderr, exitCode }.
 */
async function execCmd(command, timeout = SSH_TIMEOUT_MS) {
  if (THIS_NODE.local) {
    return execLocal(command, timeout);
  }
  return execViaQCC(command, timeout);
}

function execLocal(command, timeout = SSH_TIMEOUT_MS) {
  try {
    const stdout = execSync(command, {
      timeout,
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || e.message,
      exitCode: e.status || 1,
    };
  }
}

async function execViaQCC(command, timeout = SSH_TIMEOUT_MS) {
  try {
    return await httpPost('/api/ssh-exec', { node: NODE_NAME, command, timeout }, timeout + 5000);
  } catch (e) {
    // QCC might be down, try paramiko fallback
    return execViaParamiko(command, timeout);
  }
}

function execViaParamiko(command, timeout = SSH_TIMEOUT_MS) {
  const sshExecPy = path.join(BASE_DIR, 'utils', 'ssh_exec.py');
  if (!fs.existsSync(sshExecPy)) {
    return { stdout: '', stderr: 'ssh_exec.py not found', exitCode: -1 };
  }

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const escapedCmd = command.replace(/"/g, '\\"');
  const fullCmd = `${pythonCmd} "${sshExecPy}" --server ${NODE_NAME} --timeout ${Math.floor(timeout / 1000)} "${escapedCmd}"`;

  try {
    let stdout = execSync(fullCmd, {
      timeout: timeout + 10000,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    // Strip [nodename] prefix
    const prefix = `[${NODE_NAME}]`;
    if (stdout.startsWith(prefix)) {
      stdout = stdout.slice(prefix.length).replace(/^\r?\n/, '');
    }
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    let stdout = e.stdout || '';
    const prefix = `[${NODE_NAME}]`;
    if (stdout.startsWith(prefix)) {
      stdout = stdout.slice(prefix.length).replace(/^\r?\n/, '');
    }
    return { stdout, stderr: e.stderr || e.message, exitCode: e.status || 1 };
  }
}

/**
 * Launch a long-running command (training/research) in the background on the node.
 * Returns { success, pid?, error? }.
 */
async function launchBackground(command, cwd) {
  const isWindows = THIS_NODE.os === 'windows';

  let fullCmd;
  if (THIS_NODE.local) {
    // Neptune: use START /BELOWNORMAL for priority constraint
    if (THIS_NODE.constraints.includes('below_normal_priority')) {
      fullCmd = cwd
        ? `cd /d "${cwd}" && start /BELOWNORMAL /B ${command}`
        : `start /BELOWNORMAL /B ${command}`;
    } else {
      fullCmd = cwd ? `cd /d "${cwd}" && start /B ${command}` : `start /B ${command}`;
    }
  } else if (isWindows) {
    // Remote Windows: use start /B through SSH
    fullCmd = cwd
      ? `cd /d "${cwd}" && start /B ${command}`
      : `start /B ${command}`;
  } else {
    // Linux: use nohup + background
    fullCmd = cwd
      ? `cd "${cwd}" && nohup ${command} > /tmp/researcher_${NODE_NAME}_job.log 2>&1 &`
      : `nohup ${command} > /tmp/researcher_${NODE_NAME}_job.log 2>&1 &`;
  }

  log('INFO', `Launching: ${fullCmd.slice(0, 200)}`);
  const result = await execCmd(fullCmd, 60000);

  if (result.exitCode !== 0 && !result.stdout) {
    return { success: false, error: result.stderr || 'Launch failed' };
  }

  return { success: true };
}

// ============================================================================
// RESEARCH PRIORITIES
// ============================================================================

function loadPriorities() {
  try {
    if (fs.existsSync(PRIORITIES_FILE)) {
      const all = JSON.parse(fs.readFileSync(PRIORITIES_FILE, 'utf8'));
      return all[NODE_NAME] || [];
    }
  } catch (e) {
    log('WARN', `Failed to load priorities: ${e.message}`);
  }
  return [];
}

/**
 * Remove the top priority item (it's been launched).
 */
function consumeTopPriority() {
  try {
    const all = JSON.parse(fs.readFileSync(PRIORITIES_FILE, 'utf8'));
    const queue = all[NODE_NAME] || [];
    if (queue.length > 0) {
      queue.shift();
      all[NODE_NAME] = queue;
      fs.writeFileSync(PRIORITIES_FILE, JSON.stringify(all, null, 2), 'utf8');
    }
  } catch (e) {
    log('WARN', `Failed to consume priority: ${e.message}`);
  }
}

/**
 * Also check the legacy job_queues.json for backward compatibility with auto_dispatch.
 */
function loadLegacyQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const queues = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
      return queues[NODE_NAME] || [];
    }
  } catch { /* ignore */ }
  return [];
}

function dequeueLegacy() {
  try {
    const queues = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (queues[NODE_NAME] && queues[NODE_NAME].length > 0) {
      const job = queues[NODE_NAME].shift();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queues, null, 2), 'utf8');
      return job;
    }
  } catch { /* ignore */ }
  return null;
}

// ============================================================================
// NODE-SPECIFIC CHECKS
// ============================================================================

/**
 * Neptune: verify paper trading engine is running.
 */
async function checkPaperEngine() {
  if (NODE_NAME !== 'neptune') return true;

  // Check paper state file
  try {
    if (fs.existsSync(PAPER_STATE_PATH)) {
      const state = JSON.parse(fs.readFileSync(PAPER_STATE_PATH, 'utf8'));
      if (state && state.active !== false) {
        return true;
      }
    }
  } catch { /* check PID instead */ }

  // Check for running paper engine process
  const result = await execCmd('tasklist /FI "WINDOWTITLE eq paper_engine*" /FO CSV 2>nul || echo "no paper"', 10000);
  if (result.stdout && !result.stdout.includes('no paper') && !result.stdout.includes('No tasks')) {
    return true;
  }

  // Also check by process name pattern
  const result2 = await execCmd('wmic process where "CommandLine like \'%paper%engine%\'" get ProcessId 2>nul || echo "none"', 10000);
  if (result2.stdout && !result2.stdout.includes('none') && result2.stdout.trim().split('\n').length > 1) {
    return true;
  }

  log('WARN', 'Paper engine NOT detected on Neptune');
  return false;
}

/**
 * Neptune: check RAM usage is under 85%.
 */
async function checkNeptuneRam() {
  if (NODE_NAME !== 'neptune') return true;

  try {
    const result = await execCmd(
      'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Format:Value',
      10000
    );
    const lines = result.stdout.replace(/\r/g, '').split('\n').filter(Boolean);
    let free = 0, total = 0;
    for (const line of lines) {
      if (line.startsWith('FreePhysicalMemory=')) free = parseInt(line.split('=')[1]) || 0;
      if (line.startsWith('TotalVisibleMemorySize=')) total = parseInt(line.split('=')[1]) || 0;
    }
    if (total > 0) {
      const usedPct = ((total - free) / total * 100).toFixed(1);
      if (parseFloat(usedPct) > 85) {
        log('WARN', `Neptune RAM at ${usedPct}% — above 85% threshold`);
        return false;
      }
    }
  } catch (e) {
    log('WARN', `RAM check failed: ${e.message}`);
  }
  return true;
}

/**
 * Razer: validate a command is NOT deep learning.
 */
function isDeepLearning(command) {
  const dlPatterns = [
    /torch/i, /tensorflow/i, /keras/i, /\bcnn\b/i, /\brnn\b/i, /\blstm\b/i,
    /\btransformer\b/i, /deep_learning/i, /neural/i, /\bGPU.*train/i,
    /wider_cnn/i, /book_spatial/i, /hybrid_v3/i,
  ];
  return dlPatterns.some(p => p.test(command));
}

// ============================================================================
// GPU MONITORING
// ============================================================================

async function getGPUStatus() {
  if (!THIS_NODE.gpu) return null;

  const cmd = 'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits';
  const result = await execCmd(cmd, 15000);

  if (result.exitCode !== 0) return null;

  const line = result.stdout.trim().split('\n')[0];
  if (!line) return null;
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 4) return null;

  return {
    gpu_util: parseFloat(parts[0]) || 0,
    mem_used_mb: parseInt(parts[1]) || 0,
    mem_total_mb: parseInt(parts[2]) || 0,
    temp_c: parseInt(parts[3]) || 0,
    power_w: parts.length >= 5 ? (parseFloat(parts[4]) || null) : null,
    power_limit_w: parts.length >= 6 ? (parseFloat(parts[5]) || null) : null,
  };
}

/**
 * Check if any Python training/research process is actually running on the node.
 */
async function getRunningProcesses() {
  const isWindows = THIS_NODE.os === 'windows';
  let cmd;
  if (isWindows) {
    cmd = 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV 2>nul & tasklist /FI "IMAGENAME eq python3.exe" /FO CSV 2>nul';
  } else {
    cmd = 'ps aux | grep -E "python|python3" | grep -v grep';
  }

  const result = await execCmd(cmd, 15000);
  if (result.exitCode !== 0 && !result.stdout) return [];

  const lines = result.stdout.trim().split('\n').filter(l => l.trim() && !l.includes('No tasks'));

  // Parse to get basic info
  const processes = [];
  for (const line of lines) {
    if (isWindows) {
      // CSV format: "python.exe","1234","Console","1","123,456 K"
      const match = line.match(/"([^"]+)","(\d+)"/);
      if (match) {
        processes.push({ name: match[1], pid: parseInt(match[2]) });
      }
    } else {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        processes.push({ name: parts[10] || 'python', pid: parseInt(parts[1]) });
      }
    }
  }
  return processes;
}

// ============================================================================
// JOB MONITORING
// ============================================================================

/**
 * Get last N lines from a log file on the node.
 */
async function tailLog(logPath, lines = 100) {
  const isWindows = THIS_NODE.os === 'windows';
  let cmd;
  if (isWindows) {
    // PowerShell one-liner for tail
    cmd = `powershell -Command "Get-Content '${logPath}' -Tail ${lines} -ErrorAction SilentlyContinue"`;
  } else {
    cmd = `tail -n ${lines} "${logPath}" 2>/dev/null`;
  }

  const result = await execCmd(cmd, 15000);
  return result.stdout || '';
}

/**
 * Find the most recent training log file on the node.
 */
async function findLatestLog(pattern) {
  if (!pattern) return null;

  const workdir = THIS_NODE.workdir;
  const isWindows = THIS_NODE.os === 'windows';

  let cmd;
  if (isWindows) {
    // Search common log locations
    cmd = `dir /b /o-d "${workdir}\\logs\\${pattern}" 2>nul & dir /b /o-d "${workdir}\\${pattern}" 2>nul`;
  } else {
    cmd = `find "${workdir}" -maxdepth 3 -name "${pattern}" -type f -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2`;
  }

  const result = await execCmd(cmd, 15000);
  const firstLine = result.stdout.trim().split('\n')[0];
  if (!firstLine) return null;

  if (isWindows) {
    // dir /b just gives filename — need to figure out full path
    const logDirs = [`${workdir}\\logs`, workdir];
    for (const dir of logDirs) {
      const fullPath = `${dir}\\${firstLine}`;
      const check = await execCmd(`if exist "${fullPath}" echo EXISTS`, 5000);
      if (check.stdout.includes('EXISTS')) return fullPath;
    }
    return null;
  }

  return firstLine || null;
}

/**
 * Check if a training log contains completion markers.
 */
function hasCompletionMarker(logContent) {
  for (const marker of COMPLETION_MARKERS) {
    if (logContent.includes(marker)) return marker;
  }
  return null;
}

/**
 * Extract metrics from log content using regex.
 */
function extractMetrics(logContent, metricsRegex) {
  if (!metricsRegex) return {};

  const metrics = {};
  try {
    const re = new RegExp(metricsRegex, 'gi');
    let match;
    while ((match = re.exec(logContent)) !== null) {
      const key = match[0].split(/[=:]/)[0].trim();
      metrics[key] = parseFloat(match[1]);
    }
  } catch { /* invalid regex */ }

  // Also try common patterns
  const commonPatterns = [
    { name: 'IC', re: /IC[=:]\s*([0-9.-]+)/gi },
    { name: 'Sortino', re: /Sortino[=:]\s*([0-9.-]+)/gi },
    { name: 'Sharpe', re: /Sharpe[=:]\s*([0-9.-]+)/gi },
    { name: 'Loss', re: /(?:val_)?loss[=:]\s*([0-9.-]+)/gi },
    { name: 'Fold', re: /[Ff]old\s+(\d+)/gi },
  ];

  for (const { name, re } of commonPatterns) {
    let lastMatch;
    let m;
    while ((m = re.exec(logContent)) !== null) {
      lastMatch = m;
    }
    if (lastMatch) {
      metrics[name] = parseFloat(lastMatch[1]);
    }
  }

  return metrics;
}

// ============================================================================
// CRASH RECOVERY
// ============================================================================

async function killZombies() {
  log('INFO', 'Killing zombie processes...');
  const isWindows = THIS_NODE.os === 'windows';

  if (isWindows) {
    await execCmd('taskkill /F /IM python.exe 2>nul || echo "No python"', 15000);
    await execCmd('taskkill /F /IM python3.exe 2>nul || echo "No python3"', 15000);
  } else {
    await execCmd('pkill -9 -f python || true', 15000);
  }

  // Wait for GPU to release CUDA memory
  await new Promise(r => setTimeout(r, 5000));

  // Verify GPU is freed
  if (THIS_NODE.gpu) {
    const gpu = await getGPUStatus();
    if (gpu) {
      log('INFO', `Post-cleanup GPU: ${gpu.gpu_util}% util, ${gpu.mem_used_mb}MB VRAM`);
    }
  }
}

// ============================================================================
// MAIN DECISION ENGINE
// ============================================================================

/**
 * Decide what to do next: monitor, launch, recover, or idle.
 */
async function decisionLoop(state) {
  // Step 0: Node-specific pre-checks
  if (NODE_NAME === 'neptune') {
    const paperOk = await checkPaperEngine();
    if (!paperOk) {
      log('WARN', 'Paper engine not running on Neptune. Will NOT launch training until paper engine is confirmed running.');
      await alertDiscord('warning', 'Paper Engine Down',
        'Paper trading engine is NOT running on Neptune. Training launch blocked. Please start paper engine first.');
      return;
    }

    const ramOk = await checkNeptuneRam();
    if (!ramOk) {
      log('WARN', 'Neptune RAM > 85%. Skipping job launch.');
      await alertDiscord('warning', 'Neptune RAM High',
        'RAM usage above 85% threshold. Not launching new jobs.');
      return;
    }
  }

  // Step 1: Check connectivity
  const reachable = await checkConnectivity();
  if (!reachable) {
    log('WARN', `Cannot reach ${NODE_NAME}. Will retry next poll.`);
    state.last_error = `Unreachable at ${new Date().toISOString()}`;
    return;
  }
  state.last_error = null;

  // Step 2: Get GPU status (if applicable)
  let gpuStatus = null;
  if (THIS_NODE.gpu) {
    gpuStatus = await getGPUStatus();
    state.last_gpu_status = gpuStatus;
  }

  // Step 3: Check running processes
  const processes = await getRunningProcesses();
  const hasPythonRunning = processes.length > 0;

  // Step 4: If we think a job is running, monitor it
  if (state.current_job) {
    await monitorCurrentJob(state, gpuStatus, hasPythonRunning);
    return;
  }

  // Step 5: If GPU is active or python is running (job we didn't launch), track it
  if (THIS_NODE.gpu && gpuStatus && gpuStatus.gpu_util > 10) {
    log('INFO', `GPU active (${gpuStatus.gpu_util}%) but no tracked job. External process running.`);
    return; // Don't launch anything, something is already using the GPU
  }

  if (hasPythonRunning) {
    log('DEBUG', `Python processes running but no tracked job. Count: ${processes.length}`);
    // Don't interfere with externally managed processes
    return;
  }

  // Step 6: Node is idle — launch next job
  await launchNextJob(state);
}

async function checkConnectivity() {
  if (THIS_NODE.local) return true;

  try {
    const result = await execCmd('echo __alive__', 10000);
    return result.exitCode === 0 && result.stdout.includes('__alive__');
  } catch {
    return false;
  }
}

/**
 * Monitor a job we believe is running.
 */
async function monitorCurrentJob(state, gpuStatus, hasPythonRunning) {
  const job = state.current_job;
  const elapsed = Date.now() - new Date(job.started_at).getTime();
  const elapsedMin = Math.round(elapsed / 60000);

  // Check if python process is still alive
  if (!hasPythonRunning) {
    // No python running — job may have finished or crashed
    log('INFO', `No python process found. Job "${job.description}" may have ended (ran ${elapsedMin}min).`);

    // Check log for completion
    let completed = false;
    let metrics = {};
    const priorities = loadPriorities();
    const jobPriority = priorities.find(p => p.description === job.description) || job;
    const logPattern = jobPriority.log_pattern || null;

    if (logPattern) {
      const logPath = await findLatestLog(logPattern);
      if (logPath) {
        const logTail = await tailLog(logPath, 200);
        const marker = hasCompletionMarker(logTail);
        if (marker) {
          completed = true;
          metrics = extractMetrics(logTail, jobPriority.metrics_regex);
          log('INFO', `Job completed! Marker: "${marker}"`, metrics);
        }
      }
    }

    if (completed) {
      await handleJobCompletion(state, metrics);
    } else {
      // No completion marker — crashed
      await handleJobCrash(state, 'Python process disappeared without completion marker');
    }
    return;
  }

  // Python is running. Check GPU if applicable.
  if (THIS_NODE.gpu && gpuStatus) {
    if (gpuStatus.gpu_util <= 2) {
      // GPU idle with python running — possible crash/hang
      if (!state.crash_watch) {
        state.crash_watch = { first_idle_at: new Date().toISOString(), confirmed: false };
        log('INFO', `GPU idle (${gpuStatus.gpu_util}%) with python running. Watching for crash... (${elapsedMin}min elapsed)`);
      } else {
        const idleElapsed = Date.now() - new Date(state.crash_watch.first_idle_at).getTime();
        if (idleElapsed > CRASH_CONFIRM_MS && !state.crash_watch.confirmed) {
          state.crash_watch.confirmed = true;
          log('WARN', `CRASH CONFIRMED: GPU idle for ${Math.round(idleElapsed / 1000)}s with job running ${elapsedMin}min`);
          await handleJobCrash(state, `GPU idle for ${Math.round(idleElapsed / 1000)}s — likely hung/crashed`);
          return;
        }
      }
    } else {
      // GPU active — clear crash watch
      if (state.crash_watch) {
        log('INFO', `GPU active again (${gpuStatus.gpu_util}%). Clearing crash watch.`);
        state.crash_watch = null;
      }
    }

    // Log periodic status
    if (elapsedMin > 0 && elapsedMin % 30 === 0) {
      log('INFO', `Job "${job.description}" running ${elapsedMin}min. GPU: ${gpuStatus.gpu_util}%, ${gpuStatus.mem_used_mb}MB VRAM, ${gpuStatus.temp_c}C`);
    }
  }
}

async function handleJobCompletion(state, metrics) {
  const job = state.current_job;
  const elapsed = Date.now() - new Date(job.started_at).getTime();
  const elapsedStr = formatDuration(elapsed);

  state.current_job = null;
  state.crash_watch = null;
  state.consecutive_failures = 0;
  state.total_jobs_completed++;
  state.last_completed_job = {
    ...job,
    completed_at: new Date().toISOString(),
    duration: elapsedStr,
    metrics,
  };

  const metricsStr = Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(', ') || 'No metrics extracted';

  await alertDiscord('success', 'Job Complete',
    `**${job.description}**\nDuration: ${elapsedStr}\nMetrics: ${metricsStr}\n\nWill launch next job on next poll.`,
    [
      { name: 'Duration', value: elapsedStr, inline: true },
      { name: 'Node', value: NODE_NAME, inline: true },
    ]
  );

  log('INFO', `Job "${job.description}" completed in ${elapsedStr}`, metrics);
}

async function handleJobCrash(state, reason) {
  const job = state.current_job;
  const elapsed = Date.now() - new Date(job.started_at).getTime();
  const elapsedStr = formatDuration(elapsed);

  state.current_job = null;
  state.crash_watch = null;
  state.consecutive_failures++;
  state.total_crashes_recovered++;

  log('ERROR', `Job "${job.description}" CRASHED after ${elapsedStr}: ${reason}`);

  // Collect last log output if possible
  let logTail = '';
  const priorities = loadPriorities();
  const jobPriority = priorities.find(p => p.description === job.description) || {};
  if (jobPriority.log_pattern) {
    const logPath = await findLatestLog(jobPriority.log_pattern);
    if (logPath) {
      logTail = await tailLog(logPath, 50);
    }
  }

  // Kill zombies and clean up CUDA
  await killZombies();

  // Decide whether to retry
  const maxRetries = 3;
  if (state.consecutive_failures >= maxRetries) {
    await alertDiscord('critical', 'Job Crashed - Giving Up',
      `**${job.description}** failed ${state.consecutive_failures} times consecutively.\n` +
      `Reason: ${reason}\n` +
      `Last log:\n\`\`\`\n${logTail.slice(-500)}\n\`\`\`\n` +
      `**Manual intervention required.** Will try next job in queue instead.`,
      [{ name: 'Failures', value: String(state.consecutive_failures), inline: true }]
    );
    state.consecutive_failures = 0; // Reset for next job
    return;
  }

  // Will auto-retry on next poll (current_job is now null, so launchNextJob will re-launch)
  await alertDiscord('warning', 'Job Crashed - Will Retry',
    `**${job.description}** crashed after ${elapsedStr}.\n` +
    `Reason: ${reason}\n` +
    `Attempt ${state.consecutive_failures}/${maxRetries}. Retrying on next poll.\n` +
    `Last log:\n\`\`\`\n${logTail.slice(-300)}\n\`\`\``,
    [{ name: 'Retry', value: `${state.consecutive_failures}/${maxRetries}`, inline: true }]
  );
}

/**
 * Find and launch the next job from priorities or legacy queue.
 */
async function launchNextJob(state) {
  // Check legacy queue first (backward compat with auto_dispatch enqueue)
  const legacyJob = dequeueLegacy();
  if (legacyJob) {
    return await launchJob(state, legacyJob.command, legacyJob.description, legacyJob.cwd || THIS_NODE.workdir);
  }

  // Check research priorities
  const priorities = loadPriorities();
  if (priorities.length === 0) {
    log('DEBUG', `No jobs queued for ${NODE_NAME}. Node idle.`);
    return;
  }

  // Sort by priority (lower number = higher priority)
  priorities.sort((a, b) => (a.priority || 5) - (b.priority || 5));
  const next = priorities[0];

  // Razer constraint: no deep learning
  if (NODE_NAME === 'razer' && isDeepLearning(next.command)) {
    log('ERROR', `BLOCKED: "${next.description}" is deep learning. Razer NEVER runs DL.`);
    await alertDiscord('critical', 'DL Blocked on Razer',
      `Job "${next.description}" was blocked because it appears to be deep learning.\n` +
      `Razer only runs math strategies, LGBM, gradient boosting, and GPU backtesting.\n` +
      `Command: \`${next.command}\``);
    consumeTopPriority(); // Remove the bad job
    return;
  }

  const cwd = next.cwd || THIS_NODE.workdir;
  await launchJob(state, next.command, next.description, cwd);
  consumeTopPriority();
}

async function launchJob(state, command, description, cwd) {
  log('INFO', `Launching job: "${description}"`);
  log('INFO', `  Command: ${command}`);
  log('INFO', `  CWD: ${cwd}`);

  const result = await launchBackground(command, cwd);

  if (!result.success) {
    log('ERROR', `Failed to launch: ${result.error}`);
    state.consecutive_failures++;

    await alertDiscord('critical', 'Launch Failed',
      `Could not start **${description}** on ${NODE_NAME}.\n` +
      `Error: ${result.error}\n` +
      `Command: \`${command}\``);
    return;
  }

  state.current_job = {
    command,
    description,
    cwd,
    started_at: new Date().toISOString(),
  };
  state.crash_watch = null;
  state.total_jobs_launched++;

  await alertDiscord('info', 'Job Launched',
    `**${description}**\nCommand: \`${command.slice(0, 150)}\``,
    [
      { name: 'Node', value: NODE_NAME, inline: true },
      { name: 'Total Launched', value: String(state.total_jobs_launched), inline: true },
    ]
  );

  // Register with QCC
  try {
    await httpPost('/api/training/register', {
      node: NODE_NAME,
      description,
      model_type: 'researcher_dispatch',
    });
  } catch { /* QCC may be down */ }
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ============================================================================
// CLI MODE (--status, --enqueue)
// ============================================================================

if (args.includes('--status')) {
  const state = loadState();
  const priorities = loadPriorities();
  const legacy = loadLegacyQueue();

  console.log(`\n=== Researcher Status: ${NODE_NAME} ===`);
  console.log(`Started: ${state.started_at || 'Never'}`);
  console.log(`Last poll: ${state.last_poll_at || 'Never'}`);
  console.log(`Current job: ${state.current_job ? state.current_job.description : 'IDLE'}`);
  if (state.current_job) {
    const elapsed = Date.now() - new Date(state.current_job.started_at).getTime();
    console.log(`  Running for: ${formatDuration(elapsed)}`);
  }
  console.log(`Last completed: ${state.last_completed_job ? state.last_completed_job.description : 'None'}`);
  console.log(`Stats: ${state.total_jobs_launched} launched, ${state.total_jobs_completed} completed, ${state.total_crashes_recovered} crashes recovered`);
  console.log(`Consecutive failures: ${state.consecutive_failures}`);
  console.log(`GPU: ${state.last_gpu_status ? `${state.last_gpu_status.gpu_util}% util, ${state.last_gpu_status.mem_used_mb}MB VRAM` : 'N/A'}`);
  console.log(`\nResearch queue (${priorities.length} items):`);
  priorities.forEach((p, i) => console.log(`  ${i + 1}. [P${p.priority}] ${p.description}`));
  if (legacy.length > 0) {
    console.log(`\nLegacy queue (${legacy.length} items):`);
    legacy.forEach((j, i) => console.log(`  ${i + 1}. ${j.description}`));
  }
  console.log(`Last error: ${state.last_error || 'None'}\n`);
  process.exit(0);
}

if (args.includes('--enqueue')) {
  const cmdIdx = args.indexOf('--command');
  const descIdx = args.indexOf('--desc');
  const prioIdx = args.indexOf('--priority');
  const cwdIdx = args.indexOf('--cwd');

  if (cmdIdx === -1 || !args[cmdIdx + 1]) {
    console.error('Usage: --enqueue --command "..." --desc "..." [--priority N] [--cwd "..."]');
    process.exit(1);
  }

  const newJob = {
    command: args[cmdIdx + 1],
    description: descIdx !== -1 ? args[descIdx + 1] : 'Manual enqueue',
    priority: prioIdx !== -1 ? parseInt(args[prioIdx + 1]) : 5,
    cwd: cwdIdx !== -1 ? args[cwdIdx + 1] : null,
  };

  try {
    const all = JSON.parse(fs.readFileSync(PRIORITIES_FILE, 'utf8'));
    if (!all[NODE_NAME]) all[NODE_NAME] = [];
    all[NODE_NAME].push(newJob);
    all[NODE_NAME].sort((a, b) => (a.priority || 5) - (b.priority || 5));
    fs.writeFileSync(PRIORITIES_FILE, JSON.stringify(all, null, 2), 'utf8');
    console.log(`Enqueued on ${NODE_NAME}: "${newJob.description}" (priority ${newJob.priority})`);
  } catch (e) {
    console.error(`Failed to enqueue: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ============================================================================
// MAIN LOOP
// ============================================================================

let state = loadState();
let pollCount = 0;
let isShuttingDown = false;

async function poll() {
  if (isShuttingDown) return;
  pollCount++;

  const logEvery = 10; // Log status every 10th poll (~10 min)

  try {
    if (pollCount % logEvery === 1) {
      log('INFO', `Poll #${pollCount}: ${state.current_job ? `Running "${state.current_job.description}"` : 'IDLE'}. ` +
        `Stats: ${state.total_jobs_launched}L/${state.total_jobs_completed}C/${state.total_crashes_recovered}R`);
    }

    await decisionLoop(state);
    saveState(state);

  } catch (e) {
    log('ERROR', `Poll error: ${e.message}`, { stack: e.stack?.split('\n').slice(0, 3) });

    // If too many consecutive poll errors, alert
    if (pollCount > 5) {
      state.last_error = e.message;
      saveState(state);
    }
  }
}

// Graceful shutdown
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('INFO', `Shutting down (${signal}). Saving state...`);
  saveState(state);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}`, { stack: err.stack?.split('\n').slice(0, 5) });
  saveState(state);
  // Don't exit — PM2 will restart us. Log and continue.
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});

// Start
log('INFO', `=== Researcher starting for node: ${NODE_NAME} ===`);
log('INFO', `Config: ${JSON.stringify({ gpu: THIS_NODE.gpu, os: THIS_NODE.os, local: THIS_NODE.local, constraints: THIS_NODE.constraints })}`);

// Initial startup alert
alertDiscord('info', 'Researcher Started',
  `Node researcher for **${NODE_NAME}** is online.\n` +
  `GPU: ${THIS_NODE.gpu || 'None'}\n` +
  `Constraints: ${THIS_NODE.constraints.length > 0 ? THIS_NODE.constraints.join(', ') : 'None'}`
).catch(() => {});

// Run first poll immediately, then set interval
poll().then(() => {
  setInterval(poll, POLL_INTERVAL_MS);
});
