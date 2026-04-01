#!/usr/bin/env node
/**
 * QCC Research Orchestrator — Autonomous experiment dispatcher & monitor
 *
 * Runs as part of the QCC ecosystem (separate PM2 process sharing SQLite DB).
 * Manages a research_queue of experiments, dispatches them to compute nodes
 * via the existing job_queue, monitors progress, harvests results, and
 * auto-populates new experiments based on research priorities.
 *
 * Architecture:
 *   - research_queue table: high-level experiments with metadata
 *   - Maps experiments → job_queue entries for dispatch by QCC daemon
 *   - Monitors running experiments for staleness, completion, failure
 *   - Harvests results and sends Discord summaries
 *   - Auto-queues follow-up experiments when predecessors complete
 *
 * Usage:
 *   node qcc/orchestrator.js                     # Direct run
 *   pm2 start qcc/ecosystem.config.js            # PM2 managed (added to apps)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Paths
const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const DB_PATH = path.join(DATA_DIR, 'qcc.db');
const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts');

// Config
const ORCH_PORT = parseInt(process.env.ORCH_PORT || '3457', 10);
const QCC_PORT = parseInt(process.env.QCC_PORT || '3456', 10);
const POLL_INTERVAL = parseInt(process.env.ORCH_POLL_MS || '60000', 10);        // 60s node status
const DISPATCH_INTERVAL = parseInt(process.env.ORCH_DISPATCH_MS || '30000', 10); // 30s dispatch check
const MONITOR_INTERVAL = parseInt(process.env.ORCH_MONITOR_MS || '300000', 10);  // 5min job monitor
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min log staleness = stuck

// Ensure dirs
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Logging
const LOG_FILE = path.join(LOGS_DIR, `orchestrator-${new Date().toISOString().split('T')[0]}.log`);

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [ORCH] [${level}] ${message}`;
  if (data) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch (e) { entry += ' | [unserializable]'; }
  }
  entry += '\n';
  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (e) {}
  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(entry);
  } else {
    process.stdout.write(entry);
  }
}

// ========================
// DATABASE
// ========================

const { QCCDatabase } = require('../lib/qcc-database');
const webhookNotifier = require('../utils/webhook_notifier');
const discordNotify = require('../utils/discord_notify');
const scriptFactory = require('./script_factory');

let db = null;

function initDatabase() {
  db = new QCCDatabase(DB_PATH);
  log('INFO', `Database opened at ${DB_PATH}`);

  // Initialize script factory with DB access
  try {
    scriptFactory.init(db);
    log('INFO', 'Script factory initialized');
  } catch (e) {
    log('WARN', `Script factory init failed: ${e.message} — will retry later`);
  }

  // Create research_queue table
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS research_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      script_path TEXT NOT NULL,
      node TEXT NOT NULL,
      priority INTEGER DEFAULT 5,
      status TEXT DEFAULT 'queued' CHECK(status IN ('queued','dispatched','running','completed','failed','cancelled')),
      config_json TEXT,
      result_json TEXT,
      log_path TEXT,
      job_id INTEGER,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      depends_on INTEGER,
      tags TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Create indexes
  db.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rq_status ON research_queue(status);
    CREATE INDEX IF NOT EXISTS idx_rq_node ON research_queue(node);
    CREATE INDEX IF NOT EXISTS idx_rq_priority ON research_queue(priority);
  `);

  log('INFO', 'research_queue table ready');
}

// ========================
// RESEARCH QUEUE OPERATIONS
// ========================

function addExperiment(data) {
  const stmt = db.db.prepare(`
    INSERT INTO research_queue (name, description, script_path, node, priority, config_json, depends_on, tags, max_retries)
    VALUES (@name, @description, @script_path, @node, @priority, @config_json, @depends_on, @tags, @max_retries)
  `);
  const result = stmt.run({
    name: data.name,
    description: data.description || null,
    script_path: data.script_path,
    node: data.node,
    priority: data.priority || 5,
    config_json: data.config_json ? (typeof data.config_json === 'string' ? data.config_json : JSON.stringify(data.config_json)) : null,
    depends_on: data.depends_on || null,
    tags: data.tags ? (Array.isArray(data.tags) ? data.tags.join(',') : data.tags) : null,
    max_retries: data.max_retries !== undefined ? data.max_retries : 2,
  });
  log('INFO', `Experiment added: ${data.name} (id=${result.lastInsertRowid})`, { node: data.node, priority: data.priority });
  return { id: Number(result.lastInsertRowid) };
}

function listExperiments(status = null, node = null, limit = 100) {
  let sql = 'SELECT * FROM research_queue WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (node) { sql += ' AND node = ?'; params.push(node); }
  sql += ' ORDER BY CASE WHEN status = \'running\' THEN 0 WHEN status = \'dispatched\' THEN 1 WHEN status = \'queued\' THEN 2 ELSE 3 END, priority ASC, created_at ASC LIMIT ?';
  params.push(limit);
  return db.db.prepare(sql).all(...params);
}

function getExperiment(id) {
  return db.db.prepare('SELECT * FROM research_queue WHERE id = ?').get(id) || null;
}

function updateExperiment(id, updates) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(updates)) {
    if (['status', 'job_id', 'log_path', 'result_json', 'started_at', 'completed_at', 'retry_count'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.db.prepare(`UPDATE research_queue SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

function getQueueSummary() {
  const rows = db.db.prepare(`
    SELECT status, COUNT(*) as count FROM research_queue GROUP BY status
  `).all();
  const summary = { queued: 0, dispatched: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
  for (const row of rows) {
    summary[row.status] = row.count;
    summary.total += row.count;
  }
  return summary;
}

function getNextExperiment(node) {
  // Find highest priority queued experiment for this node
  // Respect dependencies (depends_on must be completed)
  return db.db.prepare(`
    SELECT rq.* FROM research_queue rq
    LEFT JOIN research_queue dep ON rq.depends_on = dep.id
    WHERE rq.status = 'queued'
      AND rq.node = ?
      AND (rq.depends_on IS NULL OR dep.status = 'completed')
    ORDER BY rq.priority ASC, rq.created_at ASC
    LIMIT 1
  `).get(node) || null;
}

// ========================
// NODE STATUS
// ========================

// Cache of node statuses from QCC daemon
let nodeCache = {};

async function pollNodeStatus() {
  try {
    const nodes = db.getNodes();
    for (const node of nodes) {
      nodeCache[node.name] = {
        name: node.name,
        status: node.status,
        gpu: node.gpu,
        gpu_util: node.last_gpu_util,
        gpu_mem_mb: node.last_gpu_mem_mb,
        os: node.os,
        lvl3_root: node.lvl3_root,
        updated: new Date().toISOString(),
      };
    }
    log('DEBUG', `Node status refreshed: ${nodes.map(n => `${n.name}=${n.status}`).join(', ')}`);
  } catch (e) {
    log('ERROR', `Node polling failed: ${e.message}`);
  }
}

function isNodeReady(nodeName) {
  const node = nodeCache[nodeName];
  if (!node) {
    log('DEBUG', `isNodeReady(${nodeName}): SKIP — not in node cache`);
    return false;
  }

  // Accept 'online', 'idle', 'unknown' — only reject 'offline'
  if (node.status === 'offline') {
    log('DEBUG', `isNodeReady(${nodeName}): SKIP — status=offline`);
    return false;
  }

  // Check if GPU is busy (for GPU nodes)
  // gpu_util=0 means idle, which is fine. Only block if >80% and not null.
  const hasGPU = node.gpu && node.gpu !== 'none';
  if (hasGPU && node.gpu_util !== null && node.gpu_util !== undefined && node.gpu_util > 80) {
    log('DEBUG', `isNodeReady(${nodeName}): SKIP — GPU util ${node.gpu_util}% > 80%`);
    return false;
  }

  // Check resource reservations in QCC
  if (hasGPU) {
    if (!db.isResourceAvailable(nodeName, 'gpu')) {
      log('DEBUG', `isNodeReady(${nodeName}): SKIP — GPU resource reserved`);
      return false;
    }
  }
  if (!db.isResourceAvailable(nodeName, 'cpu_slot', 3)) {
    log('DEBUG', `isNodeReady(${nodeName}): SKIP — all CPU slots occupied`);
    return false;
  }

  return true;
}

// ========================
// DISPATCH ENGINE
// ========================

async function runDispatchCycle() {
  const nodes = db.getNodes();
  const summary = getQueueSummary();

  log('INFO', `Dispatch cycle: ${nodes.length} nodes, queue=${JSON.stringify(summary)}`);

  for (const node of nodes) {
    // Skip offline nodes (fast path before cache check)
    if (node.status === 'offline') {
      log('DEBUG', `Dispatch: skip ${node.name} — DB status=offline`);
      continue;
    }

    // Check if node can accept work (checks cache + resource reservations)
    if (!isNodeReady(node.name)) {
      // isNodeReady already logged the reason at DEBUG level
      continue;
    }

    // Find next experiment for this node
    const experiment = getNextExperiment(node.name);
    if (!experiment) {
      log('DEBUG', `Dispatch: skip ${node.name} — no queued experiments`);
      continue;
    }

    log('INFO', `Dispatch: ${node.name} is ready, dispatching experiment #${experiment.id} (${experiment.name})`);

    try {
      await dispatchExperiment(experiment, node);
    } catch (e) {
      log('ERROR', `Failed to dispatch experiment ${experiment.id} (${experiment.name}) to ${node.name}: ${e.message}`, { stack: e.stack });
      // Only mark as failed if it was not already handled (e.g. script-not-found returns early)
      const current = getExperiment(experiment.id);
      if (current && current.status === 'queued') {
        updateExperiment(experiment.id, { status: 'failed', result_json: JSON.stringify({ error: e.message }) });
      }
    }
  }
}

async function dispatchExperiment(experiment, node) {
  log('INFO', `Dispatching experiment ${experiment.id} (${experiment.name}) to ${node.name}`);

  const isWindows = node.os === 'windows';
  const config = experiment.config_json ? JSON.parse(experiment.config_json) : {};

  // ----------------------------------------------------------------
  // PRE-FLIGHT: resolve script path FIRST (fixes "used before init" bug)
  // ----------------------------------------------------------------
  const scriptPath = resolveScriptPath(experiment.script_path, node);

  // Check script existence — first on local Lvl3Quant, then on the resolved path
  const LVL3_LOCAL = 'C:/Users/Footb/Documents/Github/Lvl3Quant';
  const localScriptCandidates = [
    // Relative path under local Lvl3Quant
    path.join(LVL3_LOCAL, experiment.script_path),
    // Scripts dir in teleclaude
    path.join(SCRIPTS_DIR, experiment.script_path),
    // Absolute path as-is
    experiment.script_path,
  ];

  let localScriptExists = false;
  let localScriptPath = null;
  for (const candidate of localScriptCandidates) {
    if (fs.existsSync(candidate)) {
      localScriptExists = true;
      localScriptPath = candidate;
      break;
    }
  }

  // For Neptune (local node), the script must exist locally
  if (node.name === 'neptune' || node.host === 'localhost') {
    if (!localScriptExists) {
      log('WARN', `[PRE-FLIGHT] Script not found locally for experiment #${experiment.id}: ${experiment.script_path}. Skipping (will retry when script is available).`);
      return; // Don't mark as failed — just defer this dispatch cycle
    }
    log('DEBUG', `[PRE-FLIGHT] Script found locally at: ${localScriptPath}`);
  } else {
    // For remote nodes: if script exists locally, SFTP it over before dispatching
    if (localScriptExists && localScriptPath) {
      log('INFO', `[PRE-FLIGHT] Script exists locally, will SFTP to ${node.name}: ${localScriptPath}`);
      try {
        await sftpScriptToNode(localScriptPath, experiment.script_path, node);
      } catch (e) {
        log('WARN', `[PRE-FLIGHT] SFTP transfer failed for experiment #${experiment.id}: ${e.message}. Dispatching anyway — may fail if script is already present.`);
      }
    } else {
      log('DEBUG', `[PRE-FLIGHT] Script not found locally for ${experiment.script_path} — assuming it already exists on ${node.name}`);
    }
  }

  // ----------------------------------------------------------------
  // Build the command
  // ----------------------------------------------------------------
  const pythonCmd = isWindows ? 'python' : 'python3';
  const logFile = isWindows
    ? `C:\\temp\\orch_exp_${experiment.id}.log`
    : `/tmp/orch_exp_${experiment.id}.log`;

  // Build args from config
  let args = '';
  if (config.args) {
    args = ' ' + config.args;
  } else if (config.params) {
    // Convert key-value params to CLI args
    for (const [k, v] of Object.entries(config.params)) {
      args += ` --${k} ${v}`;
    }
  }

  // Set PYTHONUNBUFFERED + PYTHONIOENCODING=utf-8 (prevents cp1252 crashes on Razer/Windows)
  const envPrefix = isWindows
    ? 'set PYTHONUNBUFFERED=1 && set PYTHONIOENCODING=utf-8 && '
    : 'PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 ';

  const workingDir = config.working_dir || node.lvl3_root;
  const fullCommand = `${envPrefix}${pythonCmd} ${scriptPath}${args}`;

  // Create a job_queue entry via QCC daemon's existing infrastructure
  const jobData = {
    job_type: config.job_type || 'sweep',
    job_name: `[ORCH] ${experiment.name}`,
    node_name: node.name,
    requires_gpu: !!(node.gpu && node.gpu !== 'none' && config.requires_gpu !== false),
    command: fullCommand,
    working_dir: workingDir,
    config_json: experiment.config_json,
    priority: experiment.priority,
    created_by: 'orchestrator',
  };

  const jobResult = db.enqueueJob(jobData);
  const jobId = Number(jobResult.id);

  // Update experiment status
  updateExperiment(experiment.id, {
    status: 'dispatched',
    job_id: jobId,
    log_path: logFile,
    started_at: new Date().toISOString(),
  });

  log('INFO', `Experiment ${experiment.id} dispatched as job ${jobId} on ${node.name}`);

  // Send Discord notification
  sendAlert('info', `Experiment Dispatched: ${experiment.name}`,
    `Experiment #${experiment.id} queued as job #${jobId} on ${node.name}.`,
    [
      { name: 'Script', value: experiment.script_path, inline: true },
      { name: 'Priority', value: String(experiment.priority), inline: true },
      { name: 'Node', value: node.name, inline: true },
    ]
  );

  // POST-DISPATCH VERIFICATION: check after 30s that a process is actually running
  setTimeout(async () => {
    try {
      const verifyCmd = node.os === 'windows'
        ? 'powershell -Command "(Get-Process python* -ErrorAction SilentlyContinue).Count"'
        : 'pgrep -c python || echo 0';

      const { execSync } = require('child_process');
      const sshCmd = node.name === 'neptune' || node.host === 'localhost'
        ? verifyCmd
        : null; // remote verification handled below

      if (node.name !== 'neptune' && node.host !== 'localhost') {
        // Remote verification via inline Python paramiko
        const pyScript = `
import warnings; warnings.filterwarnings('ignore')
import paramiko, sys
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    ssh.connect('${node.host || node.tailscale_ip}', port=22, username='${node.ssh_user || 'root'}', password='Pb26116467', timeout=10)
    stdin, stdout, stderr = ssh.exec_command('${verifyCmd.replace(/'/g, "\\'")}')
    count = stdout.read().decode().strip()
    ssh.close()
    print(count)
except: print('0')
`;
        const result = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
          { timeout: 20000, encoding: 'utf8', windowsHide: true }).trim();
        const procCount = parseInt(result) || 0;

        if (procCount === 0) {
          log('WARN', `POST-DISPATCH VERIFY FAILED: Experiment ${experiment.id} on ${node.name} — no Python processes after 30s. Job likely crashed on launch.`);
          updateExperiment(experiment.id, { status: 'failed', result_json: JSON.stringify({ error: 'No process found 30s after dispatch — launch failure' }) });
          sendAlert('warning', `Launch Failure: ${experiment.name}`,
            `Experiment #${experiment.id} dispatched to ${node.name} but no Python process found after 30s. The script likely crashed on launch.`,
            [{ name: 'Node', value: node.name, inline: true }, { name: 'Job', value: String(jobId), inline: true }]
          );
        } else {
          log('INFO', `POST-DISPATCH VERIFY OK: Experiment ${experiment.id} on ${node.name} — ${procCount} Python process(es) running.`);
          updateExperiment(experiment.id, { status: 'running' });
        }
      }
    } catch (e) {
      log('DEBUG', `Post-dispatch verify error for experiment ${experiment.id}: ${e.message}`);
    }
  }, 30000); // 30 second delay
}

/**
 * SFTP a local script to a remote node via paramiko (Python subprocess).
 * Uses the node's SSH credentials from the database.
 *
 * Fix (ROOT CAUSE 1): paramiko emits a TripleDES deprecation warning to stderr,
 * which previously caused the subprocess to exit with code 1 even when the
 * transfer succeeded. We now:
 *   1. Suppress all Python warnings in the inline script via warnings.filterwarnings.
 *   2. After the put(), verify the remote file exists via sftp.stat() and exit
 *      with code 0 only if both the put and the stat succeed — so we don't rely
 *      solely on the exit code that stderr noise could corrupt.
 */
async function sftpScriptToNode(localPath, relativeScriptPath, node) {
  return new Promise((resolve, reject) => {
    // Build remote destination path
    const isWindows = node.os === 'windows';
    const remotePath = isWindows
      ? `${node.lvl3_root}\\${relativeScriptPath.replace(/\//g, '\\')}`.replace(/\\\\/g, '\\')
      : `${node.lvl3_root}/${relativeScriptPath}`;

    // Python paramiko SFTP script — runs inline to avoid needing a helper file on disk.
    // warnings.filterwarnings('ignore') suppresses the TripleDES deprecation warning
    // that paramiko emits to stderr, which previously caused exit code 1 on success.
    const pythonScript = `
import warnings
warnings.filterwarnings('ignore')
import sys, paramiko, os
host = sys.argv[1]
port = int(sys.argv[2])
user = sys.argv[3]
password = sys.argv[4] if sys.argv[4] != '__NONE__' else None
key_path = sys.argv[5] if sys.argv[5] != '__NONE__' else None
local_path = sys.argv[6]
remote_path = sys.argv[7]

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
if key_path:
    ssh.connect(host, port=port, username=user, key_filename=key_path, timeout=30)
else:
    ssh.connect(host, port=port, username=user, password=password, timeout=30)

# Ensure remote directory exists
remote_dir = os.path.dirname(remote_path)
if remote_dir:
    ssh.exec_command(f'mkdir -p "{remote_dir}"' if '/' in remote_dir else f'md "{remote_dir}"')
    import time; time.sleep(1)

sftp = ssh.open_sftp()
sftp.put(local_path, remote_path)

# Verify file actually exists on remote after transfer (don't trust exit code alone)
try:
    stat = sftp.stat(remote_path)
    verified_size = stat.st_size
except Exception as verify_err:
    sftp.close()
    ssh.close()
    print(f"VERIFY_FAILED: {verify_err}", file=sys.stderr)
    sys.exit(2)

sftp.close()
ssh.close()
print(f"OK: {local_path} -> {host}:{remote_path} ({verified_size} bytes)")
`.trim();

    const host = node.tailscale_ip || node.host;
    const port = String(node.port || 22);
    const sshUser = node.ssh_user || 'claude';
    const password = node.ssh_password || '__NONE__';
    const keyPath = node.ssh_key_path || '__NONE__';

    log('DEBUG', `SFTP: ${localPath} -> ${node.name} (${host}:${port}) at ${remotePath}`);

    const { spawn } = require('child_process');
    const proc = spawn('python', ['-c', pythonScript, host, port, sshUser, password, keyPath, localPath, remotePath], {
      timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', (code) => {
      // Filter stderr: ignore lines that are pure deprecation warnings (not real errors)
      const stderrFiltered = stderr.split('\n')
        .filter(line => !/DeprecationWarning|CryptographyDeprecation|TripleDES|Blowfish|blowfish|will be removed/i.test(line))
        .join('\n').trim();

      if (stdout.startsWith('OK:')) {
        // Transfer succeeded and remote file verified
        log('INFO', `SFTP transfer OK: ${stdout.trim()}`);
        resolve();
      } else if (code === 0) {
        // Exit 0 but no OK prefix — treat as success with warning
        log('WARN', `SFTP exited 0 but output unexpected. stdout=${stdout.slice(0, 200)} stderr=${stderrFiltered.slice(0, 200)}`);
        resolve();
      } else {
        const errMsg = stderrFiltered || stderr.slice(0, 300);
        log('ERROR', `SFTP transfer FAILED (exit ${code}): ${errMsg}`);
        reject(new Error(`SFTP exited ${code}: ${errMsg}`));
      }
    });
    proc.on('error', (e) => reject(new Error(`SFTP spawn error: ${e.message}`)));
  });
}

function resolveScriptPath(scriptPath, node) {
  // If absolute path, use as-is
  if (path.isAbsolute(scriptPath) || scriptPath.startsWith('/') || /^[A-Z]:\\/.test(scriptPath)) {
    return scriptPath;
  }

  // Relative path: resolve against node's Lvl3Quant root or scripts dir
  const isWindows = node.os === 'windows';

  // Check if it's a script in our local scripts/ dir that needs to be on the node
  const localScript = path.join(SCRIPTS_DIR, scriptPath);
  if (fs.existsSync(localScript)) {
    // Script exists locally — assume it's either already synced or use local path convention
    if (isWindows) {
      return `${node.lvl3_root}\\scripts\\${scriptPath}`;
    } else {
      return `${node.lvl3_root}/scripts/${scriptPath}`;
    }
  }

  // Default: assume it's relative to the node's lvl3_root
  if (isWindows) {
    return `${node.lvl3_root}\\${scriptPath.replace(/\//g, '\\\\')}`;
  }
  return `${node.lvl3_root}/${scriptPath}`;
}

// ========================
// MONITORING ENGINE
// ========================

async function runMonitorCycle() {
  // Check all dispatched/running experiments
  const active = db.db.prepare(
    "SELECT * FROM research_queue WHERE status IN ('dispatched', 'running')"
  ).all();

  for (const experiment of active) {
    try {
      await monitorExperiment(experiment);
    } catch (e) {
      log('WARN', `Monitor check failed for experiment ${experiment.id}: ${e.message}`);
    }
  }
}

async function monitorExperiment(experiment) {
  if (!experiment.job_id) {
    log('WARN', `Experiment ${experiment.id} has no job_id, marking failed`);
    updateExperiment(experiment.id, { status: 'failed', result_json: JSON.stringify({ error: 'No job_id assigned' }) });
    return;
  }

  // Check the underlying job status
  const job = db.getJobStatus(experiment.job_id);
  if (!job) {
    log('WARN', `Job ${experiment.job_id} not found for experiment ${experiment.id}`);
    return;
  }

  // Fix (ROOT CAUSE 3): Quick-failure detection.
  // When a job fails immediately (e.g. script doesn't exist on node), the QCC daemon
  // marks the job as 'failed' in the DB right away. But the monitor cycle runs every
  // 5 minutes, so the experiment stays in 'dispatched' and the node appears busy for
  // up to 5 minutes even though nothing is running.
  // We now check if a 'dispatched' experiment's job already died within 60 seconds of
  // dispatch. If so, treat it as a launch failure and mark failed immediately so the
  // dispatcher can retry on the next 30-second dispatch cycle.
  if (experiment.status === 'dispatched' && job.status === 'failed') {
    const dispatchedAt = experiment.started_at ? new Date(experiment.started_at).getTime() : null;
    const jobFailedAt = job.completed_at ? new Date(job.completed_at).getTime() : null;
    const elapsedMs = dispatchedAt && jobFailedAt ? (jobFailedAt - dispatchedAt) : null;

    if (elapsedMs !== null && elapsedMs < 60000) {
      log('WARN', `Experiment ${experiment.id} (${experiment.name}): QUICK FAILURE detected — job ${job.id} died ${Math.round(elapsedMs / 1000)}s after dispatch (likely launch failure: script missing on node or bad command). Error: ${(job.error_tail || 'none').slice(0, 200)}`);
    } else {
      log('INFO', `Experiment ${experiment.id} (${experiment.name}): dispatched job ${job.id} already failed. Handling failure now.`);
    }
    await handleFailure(experiment, job);
    return;
  }

  // Sync status from job to experiment
  if (job.status === 'running' && experiment.status === 'dispatched') {
    updateExperiment(experiment.id, { status: 'running' });
    log('INFO', `Experiment ${experiment.id} now running (job ${job.id}, PID ${job.pid})`);
  }

  if (job.status === 'completed') {
    await harvestResults(experiment, job);
    return;
  }

  if (job.status === 'failed') {
    await handleFailure(experiment, job);
    return;
  }

  if (job.status === 'cancelled') {
    updateExperiment(experiment.id, { status: 'cancelled', completed_at: new Date().toISOString() });
    return;
  }

  // DEEP HEALTH MONITORING — not just staleness, full system awareness
  if (job.status === 'running' && job.started_at) {
    const startedAt = new Date(job.started_at).getTime();
    const now = Date.now();
    const elapsed = now - startedAt;
    const elapsedMin = Math.round(elapsed / 60000);
    const node = nodeCache[experiment.node] || {};

    // 1. Log staleness check (existing)
    if (elapsed > 5 * 60 * 1000) {
      const updatedAt = job.updated_at ? new Date(job.updated_at).getTime() : startedAt;
      const timeSinceUpdate = now - updatedAt;

      if (timeSinceUpdate > STALE_THRESHOLD_MS) {
        log('WARN', `Experiment ${experiment.id} (${experiment.name}) appears stuck — no log update for ${Math.round(timeSinceUpdate / 60000)}min`);
        sendAlert('warning', `Experiment May Be Stuck: ${experiment.name}`,
          `Experiment #${experiment.id} on ${experiment.node} has not produced output for ${Math.round(timeSinceUpdate / 60000)} minutes.`,
          [
            { name: 'Job ID', value: String(experiment.job_id), inline: true },
            { name: 'Elapsed', value: `${elapsedMin}min`, inline: true },
          ]
        );
      }
    }

    // 2. GPU power draw anomaly (GPU reporting 100% util but low power = data starved)
    const hasGPU = node.gpu && node.gpu !== 'none';
    if (hasGPU && node.gpu_util >= 90 && elapsed > 10 * 60 * 1000) {
      // We need power draw from QCC — check if the node's GPU is underutilized
      // Power draw isn't in the DB yet, but we can detect low VRAM as a proxy
      // If GPU util=100% but VRAM < 2GB after 10 min, the model likely isn't training
      if (node.gpu_mem_mb && node.gpu_mem_mb < 2000) {
        log('WARN', `Experiment ${experiment.id} on ${experiment.node}: GPU at ${node.gpu_util}% but only ${node.gpu_mem_mb}MB VRAM — may not be training`);
        sendAlert('warning', `Low VRAM Despite High GPU Util: ${experiment.name}`,
          `GPU at ${node.gpu_util}% but only ${node.gpu_mem_mb}MB VRAM used. Training may have crashed while GPU stays busy from other processes.`,
          [
            { name: 'Node', value: experiment.node, inline: true },
            { name: 'VRAM', value: `${node.gpu_mem_mb}MB`, inline: true },
            { name: 'Elapsed', value: `${elapsedMin}min`, inline: true },
          ]
        );
      }
    }

    // 3. Zero-output detection (log file < 1KB after 30+ min)
    if (elapsed > 30 * 60 * 1000 && job.output_tail) {
      if (job.output_tail.length < 100) {
        log('CRITICAL', `Experiment ${experiment.id} has near-zero output after ${elapsedMin}min`);
        sendAlert('critical', `Zero Output: ${experiment.name}`,
          `Experiment running ${elapsedMin}min but log has almost no content. Output capture likely broken.`,
          [
            { name: 'Node', value: experiment.node, inline: true },
            { name: 'Log length', value: `${job.output_tail.length} chars`, inline: true },
          ]
        );
      }
    }

    // 4. Training progress parsing — extract IC/loss from output to track convergence
    if (job.output_tail) {
      const icMatches = job.output_tail.match(/IC[=:]\s*[+\-]?([\d.]+)/g);
      const lossMatches = job.output_tail.match(/loss[=:]\s*([\d.]+)/g);
      if (icMatches && icMatches.length > 0) {
        const lastIC = icMatches[icMatches.length - 1];
        log('DEBUG', `Experiment ${experiment.id} latest: ${lastIC}`);
      }
      // Detect overfitting: val_loss >> train_loss
      const valLossMatch = job.output_tail.match(/val_loss[=:]\s*([\d.]+)/g);
      const trainLossMatch = job.output_tail.match(/train_loss[=:]\s*([\d.]+)/g);
      if (valLossMatch && trainLossMatch) {
        const lastValLoss = parseFloat(valLossMatch[valLossMatch.length - 1].split(/[=:]\s*/)[1]);
        const lastTrainLoss = parseFloat(trainLossMatch[trainLossMatch.length - 1].split(/[=:]\s*/)[1]);
        if (lastValLoss > lastTrainLoss * 1.5 && elapsed > 10 * 60 * 1000) {
          log('WARN', `Experiment ${experiment.id}: OVERFIT detected — val_loss=${lastValLoss.toFixed(4)} >> train_loss=${lastTrainLoss.toFixed(4)}`);
        }
      }
    }
  }
}

async function harvestResults(experiment, job) {
  log('INFO', `Harvesting results for experiment ${experiment.id} (${experiment.name})`);

  let resultJson = job.result_json;

  // Try to parse result from output tail
  if (!resultJson && job.output_tail) {
    const parsed = parseExperimentOutput(job.output_tail);
    if (parsed) {
      resultJson = JSON.stringify(parsed);
    }
  }

  updateExperiment(experiment.id, {
    status: 'completed',
    result_json: resultJson,
    completed_at: new Date().toISOString(),
  });

  // Persist parsed results to the appropriate structured tables
  let parsedResult = null;
  if (resultJson) {
    try { parsedResult = JSON.parse(resultJson); } catch (e) { /* ignore */ }
  }

  if (parsedResult) {
    const config = experiment.config_json ? (typeof experiment.config_json === 'string' ? JSON.parse(experiment.config_json) : experiment.config_json) : {};
    const jobType = config.job_type || '';

    // Fillsim jobs → fillsim_results + strategy_results
    if (jobType === 'fillsim' || experiment.tags?.includes('fillsim')) {
      persistFillsimResults(experiment, parsedResult);
    }

    // Sweep/backtest jobs → strategy_results
    if (['sweep', 'other'].includes(jobType) || experiment.tags?.includes('sweep')) {
      persistStrategyResults(experiment, parsedResult, jobType);
    }

    // Training jobs → experiment_metrics (summary metric for the final epoch)
    if (jobType === 'training' || experiment.tags?.includes('training')) {
      persistTrainingMetrics(experiment, parsedResult);
    }

    // Compare against existing best and log the decision
    compareAndLogResults(experiment, parsedResult, config);
  }

  // Build summary for Discord
  let resultSummary = 'No parsed results';
  if (parsedResult) {
    const parts = [];
    if (parsedResult.ic !== undefined) parts.push(`IC: ${parsedResult.ic}`);
    if (parsedResult.sharpe !== undefined) parts.push(`Sharpe: ${parsedResult.sharpe}`);
    if (parsedResult.pnl !== undefined) parts.push(`PnL: ${parsedResult.pnl}`);
    if (parsedResult.trades !== undefined) parts.push(`Trades: ${parsedResult.trades}`);
    if (parsedResult.win_rate !== undefined) parts.push(`WinRate: ${parsedResult.win_rate}`);
    if (parsedResult.fill_rate !== undefined) parts.push(`FillRate: ${parsedResult.fill_rate}`);
    if (parts.length > 0) resultSummary = parts.join(' | ');
  }

  const duration = job.duration_sec
    ? (job.duration_sec > 3600 ? `${(job.duration_sec / 3600).toFixed(1)}h` : `${Math.round(job.duration_sec / 60)}m`)
    : 'unknown';

  sendAlert('success', `Experiment Complete: ${experiment.name}`,
    `Experiment #${experiment.id} on ${experiment.node} finished successfully.`,
    [
      { name: 'Duration', value: duration, inline: true },
      { name: 'Results', value: resultSummary, inline: false },
      { name: 'Output', value: (job.output_tail || 'N/A').slice(-200), inline: false },
    ]
  );

  // Check for follow-up experiments triggered by this completion
  checkFollowUps(experiment);
}

// Persist fill simulation results to fillsim_results table.
// parsedResult may contain either a single run or an array of per-date runs.
function persistFillsimResults(experiment, parsedResult) {
  try {
    const runs = Array.isArray(parsedResult.runs) ? parsedResult.runs
      : Array.isArray(parsedResult) ? parsedResult
      : [parsedResult];

    let persisted = 0;
    for (const run of runs) {
      if (!run.config_name && !run.mbo_date) continue; // skip incomplete records
      db.insertFillsimResult({
        experiment_id: experiment.id,
        config_name: run.config_name || experiment.name,
        mbo_date: run.mbo_date || run.date || new Date().toISOString().slice(0, 10),
        signal_source: run.signal_source || run.model || null,
        total_pnl: run.total_pnl ?? run.pnl ?? null,
        total_trades: run.total_trades ?? run.trades ?? null,
        total_filled: run.total_filled ?? run.filled ?? null,
        fill_rate: run.fill_rate ?? null,
        avg_queue_position: run.avg_queue_position ?? null,
        avg_fill_latency_ms: run.avg_fill_latency_ms ?? null,
        tp_count: run.tp_count ?? null,
        sl_count: run.sl_count ?? null,
        timeout_count: run.timeout_count ?? null,
        tp_ticks: run.tp_ticks ?? null,
        sl_ticks: run.sl_ticks ?? null,
        hold_ms: run.hold_ms ?? null,
        signal_threshold: run.signal_threshold ?? null,
        trailing_ticks: run.trailing_ticks ?? null,
        time_decay_config: run.time_decay_config ?? null,
      });
      persisted++;
    }
    log('INFO', `Persisted ${persisted} fillsim run(s) for experiment ${experiment.id}`);
  } catch (e) {
    log('WARN', `Failed to persist fillsim results for experiment ${experiment.id}: ${e.message}`);
  }
}

// Persist strategy-level aggregated results to strategy_results table.
function persistStrategyResults(experiment, parsedResult, jobType) {
  try {
    const results = Array.isArray(parsedResult.strategies) ? parsedResult.strategies
      : Array.isArray(parsedResult.results) ? parsedResult.results
      : [parsedResult];

    let persisted = 0;
    for (const r of results) {
      // Must have at least a sharpe or pnl to be worth recording
      if (r.sharpe === undefined && r.total_pnl === undefined && r.pnl === undefined) continue;
      const isFromFillsim = jobType === 'fillsim' || (r.data_source === 'fillsim');
      db.insertStrategyResult({
        experiment_id: experiment.id,
        strategy_name: r.strategy_name || r.config_name || experiment.name,
        config_json: r.config || r.config_json || r.params || null,
        node: experiment.node,
        data_days: r.data_days ?? r.days ?? null,
        data_source: r.data_source || (isFromFillsim ? 'fillsim' : 'backtest'),
        total_trades: r.total_trades ?? r.trades ?? null,
        win_rate: r.win_rate ?? null,
        total_pnl: r.total_pnl ?? r.pnl ?? null,
        avg_win: r.avg_win ?? null,
        avg_loss: r.avg_loss ?? null,
        sharpe: r.sharpe ?? null,
        sortino: r.sortino ?? null,
        profit_factor: r.profit_factor ?? null,
        max_drawdown_pct: r.max_drawdown_pct ?? r.max_drawdown ?? null,
        validated_fillsim: isFromFillsim,
        monte_carlo_passed: r.monte_carlo_passed ?? false,
      });
      persisted++;
    }
    log('INFO', `Persisted ${persisted} strategy result(s) for experiment ${experiment.id}`);
  } catch (e) {
    log('WARN', `Failed to persist strategy results for experiment ${experiment.id}: ${e.message}`);
  }
}

// Persist a training-complete summary metric row to experiment_metrics.
function persistTrainingMetrics(experiment, parsedResult) {
  try {
    // If folds array is present, record each fold's final epoch
    const folds = Array.isArray(parsedResult.folds) ? parsedResult.folds : [];
    if (folds.length > 0) {
      for (const fold of folds) {
        db.insertMetric({
          experiment_id: experiment.id,
          epoch: fold.epoch ?? null,
          fold: fold.fold ?? fold.fold_idx ?? null,
          train_loss: fold.train_loss ?? null,
          val_loss: fold.val_loss ?? null,
          ic: fold.ic ?? null,
          dir_accuracy: fold.dir_accuracy ?? null,
          sortino: fold.sortino ?? null,
          vram_gb: fold.vram_gb ?? null,
          epoch_time_sec: fold.epoch_time_sec ?? null,
        });
      }
      log('INFO', `Persisted ${folds.length} fold metric(s) for experiment ${experiment.id}`);
    } else {
      // Single summary row
      if (parsedResult.ic !== undefined || parsedResult.train_loss !== undefined) {
        db.insertMetric({
          experiment_id: experiment.id,
          epoch: parsedResult.epoch ?? null,
          fold: parsedResult.fold ?? null,
          train_loss: parsedResult.train_loss ?? null,
          val_loss: parsedResult.val_loss ?? null,
          ic: parsedResult.ic ?? null,
          dir_accuracy: parsedResult.dir_accuracy ?? null,
          sortino: parsedResult.sortino ?? null,
        });
        log('INFO', `Persisted summary training metric for experiment ${experiment.id}`);
      }
    }
  } catch (e) {
    log('WARN', `Failed to persist training metrics for experiment ${experiment.id}: ${e.message}`);
  }
}

// Compare completed experiment results against existing best and log the decision.
function compareAndLogResults(experiment, parsedResult, config) {
  try {
    const newSharpe = parsedResult.sharpe ?? null;
    const newIC = parsedResult.ic ?? null;
    const jobType = config.job_type || '';

    // Look up current best for this strategy/experiment type
    const bestExisting = db.getBestStrategies(1, null);
    const currentBest = bestExisting.length > 0 ? bestExisting[0] : null;

    let decision = null;
    let rationale = null;
    let evidence = null;
    let category = null;

    if (jobType === 'training' || experiment.tags?.includes('training')) {
      category = 'model';
      if (newIC !== null) {
        const prevBestIC = db.db.prepare(
          "SELECT MAX(ic) as best_ic FROM experiment_metrics WHERE experiment_id != ?"
        ).get(experiment.id)?.best_ic ?? null;

        if (prevBestIC !== null && newIC > prevBestIC) {
          decision = `New best IC from experiment #${experiment.id} (${experiment.name}): ${newIC.toFixed(4)} vs previous best ${prevBestIC.toFixed(4)}`;
          rationale = `IC improved by ${((newIC - prevBestIC) / Math.abs(prevBestIC) * 100).toFixed(1)}%. Experiment ran on ${experiment.node}.`;
          evidence = { experiment_id: experiment.id, new_ic: newIC, prev_best_ic: prevBestIC, node: experiment.node };
        } else if (prevBestIC !== null) {
          decision = `Experiment #${experiment.id} (${experiment.name}) did not improve IC: ${newIC.toFixed(4)} vs best ${prevBestIC.toFixed(4)}`;
          rationale = `Result is ${(prevBestIC - newIC).toFixed(4)} IC below current best. No action needed.`;
          evidence = { experiment_id: experiment.id, new_ic: newIC, prev_best_ic: prevBestIC };
        } else {
          decision = `First training result recorded for experiment #${experiment.id}: IC=${newIC.toFixed(4)}`;
          rationale = 'No prior results to compare against.';
          evidence = { experiment_id: experiment.id, ic: newIC };
        }
      }
    } else if (['sweep', 'fillsim', 'other'].includes(jobType)) {
      category = jobType === 'fillsim' ? 'execution' : 'strategy';
      if (newSharpe !== null && currentBest) {
        if (newSharpe > (currentBest.sharpe ?? -Infinity)) {
          decision = `Experiment #${experiment.id} (${experiment.name}) produced new best Sharpe: ${newSharpe.toFixed(3)} vs ${(currentBest.sharpe ?? 0).toFixed(3)}`;
          rationale = `Strategy "${experiment.name}" on ${experiment.node} outperforms current leader "${currentBest.strategy_name}". Consider promoting to paper.`;
          evidence = { experiment_id: experiment.id, new_sharpe: newSharpe, prev_best: currentBest };
        } else {
          decision = `Experiment #${experiment.id} (${experiment.name}) Sharpe ${newSharpe.toFixed(3)} does not beat current best ${(currentBest.sharpe ?? 0).toFixed(3)}`;
          rationale = 'Result is below current best strategy. No promotion warranted.';
          evidence = { experiment_id: experiment.id, new_sharpe: newSharpe, current_best: currentBest.strategy_name, current_best_sharpe: currentBest.sharpe };
        }
      } else if (newSharpe !== null) {
        decision = `First strategy result for experiment #${experiment.id}: Sharpe=${newSharpe.toFixed(3)}`;
        rationale = 'Establishing baseline. No prior results to compare against.';
        evidence = { experiment_id: experiment.id, sharpe: newSharpe };
      }
    }

    if (decision) {
      db.logDecision(decision, rationale, evidence, category);
      log('INFO', `Decision logged: ${decision}`);
    }
  } catch (e) {
    log('WARN', `compareAndLogResults failed for experiment ${experiment.id}: ${e.message}`);
  }
}

async function handleFailure(experiment, job) {
  const retryCount = experiment.retry_count || 0;
  const maxRetries = experiment.max_retries || 2;

  if (retryCount < maxRetries) {
    // Retry
    log('INFO', `Retrying experiment ${experiment.id} (${experiment.name}), attempt ${retryCount + 1}/${maxRetries}`);
    updateExperiment(experiment.id, {
      status: 'queued',
      job_id: null,
      retry_count: retryCount + 1,
    });

    sendAlert('warning', `Experiment Retrying: ${experiment.name}`,
      `Experiment #${experiment.id} failed on ${experiment.node}, retrying (${retryCount + 1}/${maxRetries}).`,
      [{ name: 'Error', value: (job.error_tail || 'Unknown').slice(0, 200), inline: false }]
    );
  } else {
    // Give up
    updateExperiment(experiment.id, {
      status: 'failed',
      result_json: JSON.stringify({ error: job.error_tail || 'Unknown error', exit_code: job.exit_code }),
      completed_at: new Date().toISOString(),
    });

    sendAlert('error', `Experiment Failed: ${experiment.name}`,
      `Experiment #${experiment.id} on ${experiment.node} failed after ${maxRetries} retries.`,
      [{ name: 'Error', value: (job.error_tail || 'Unknown').slice(0, 200), inline: false }]
    );
  }
}

/**
 * Auto-retry experiments that are stuck in 'failed' state but whose scripts now exist locally.
 * Called at startup and periodically.
 *
 * Fix (ROOT CAUSE 2): Previously only queried experiments where retry_count < max_retries,
 * so 19 experiments exhausted retries and got permanently stuck even after scripts became
 * available. Now we also reset retry_count for experiments whose scripts now exist locally,
 * regardless of whether max_retries was exceeded — because script-missing failures should not
 * permanently consume retry budget.
 */
function autoRetryFailedExperiments() {
  const LVL3_LOCAL = 'C:/Users/Footb/Documents/Github/Lvl3Quant';

  // Fetch ALL failed experiments (not just those with remaining retries)
  const allFailed = db.db.prepare(
    "SELECT * FROM research_queue WHERE status = 'failed'"
  ).all();

  if (allFailed.length === 0) return;

  log('INFO', `Auto-retry: checking ${allFailed.length} failed experiment(s)...`);

  let retried = 0;
  let resetRetryCount = 0;
  let stillMissing = 0;

  for (const exp of allFailed) {
    // Check if the script now exists locally
    const candidates = [
      path.join(LVL3_LOCAL, exp.script_path),
      path.join(SCRIPTS_DIR, exp.script_path),
      exp.script_path,
    ];
    let foundAt = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { foundAt = c; break; }
    }

    if (foundAt) {
      const retryCount = exp.retry_count || 0;
      const maxRetries = exp.max_retries || 2;

      if (retryCount >= maxRetries) {
        // Script now exists but retry budget was exhausted — this was a script-missing failure,
        // not a real training failure. Reset retry_count so it gets a fresh chance.
        log('INFO', `Auto-retry: experiment #${exp.id} (${exp.name}) — retry_count (${retryCount}) >= max_retries (${maxRetries}) but script now exists at ${foundAt}. Resetting retry_count and re-queuing.`);
        updateExperiment(exp.id, { status: 'queued', job_id: null, retry_count: 0 });
        resetRetryCount++;
        retried++;
      } else {
        // Normal retry path: still has budget
        log('INFO', `Auto-retry: experiment #${exp.id} (${exp.name}) — script exists at ${foundAt}, re-queuing (retries used: ${retryCount}/${maxRetries})`);
        updateExperiment(exp.id, { status: 'queued', job_id: null });
        retried++;
      }
    } else {
      log('DEBUG', `Auto-retry: experiment #${exp.id} (${exp.name}) — script still missing (${exp.script_path}), skipping`);
      stillMissing++;
    }
  }

  if (retried > 0) {
    log('INFO', `Auto-retry: re-queued ${retried}/${allFailed.length} failed experiments (${resetRetryCount} had retry_count reset, ${stillMissing} still missing scripts)`);
  } else {
    log('DEBUG', `Auto-retry: no experiments re-queued (${stillMissing} still missing scripts)`);
  }
}

function checkFollowUps(completedExperiment) {
  // Find experiments that depend on this one
  const dependents = db.db.prepare(
    "SELECT * FROM research_queue WHERE depends_on = ? AND status = 'queued'"
  ).all(completedExperiment.id);

  if (dependents.length > 0) {
    log('INFO', `${dependents.length} follow-up experiment(s) unblocked by completion of #${completedExperiment.id}`);
  }

  // Auto-suggest follow-up experiments via script factory
  try {
    const result = completedExperiment.result_json ? JSON.parse(completedExperiment.result_json) : null;
    if (result && scriptFactory.suggestFollowUp) {
      const suggestions = scriptFactory.suggestFollowUp(completedExperiment, result);
      if (suggestions && suggestions.length > 0) {
        for (const s of suggestions) {
          log('INFO', `Auto-suggesting follow-up: ${s.name} on ${s.node} (priority ${s.priority})`);
          // Queue it — the dispatch cycle will pick it up
          try {
            scriptFactory.createAndQueueExperiment(s.template, s.params, s.node, s.priority, { tags: s.tags });
          } catch (e) {
            log('WARN', `Failed to auto-queue follow-up ${s.name}: ${e.message}`);
          }
        }
        db.logDecision(
          `Auto-queued ${suggestions.length} follow-up(s) after ${completedExperiment.name}`,
          `Based on results: ${JSON.stringify(result).slice(0, 200)}`,
          JSON.stringify(suggestions.map(s => s.name)),
          'orchestrator'
        );
      }
    }
  } catch (e) {
    log('DEBUG', `Follow-up suggestion skipped: ${e.message}`);
  }
}

// ========================
// DECISION AUDIT
// ========================

// Periodically log orchestrator dispatch decisions: which job was dispatched to which node
// and why that node/priority was chosen. Provides an immutable audit trail.
function runDecisionAudit() {
  try {
    // Find all experiments dispatched in the last hour that don't yet have a dispatch decision logged
    const recentlyDispatched = db.db.prepare(`
      SELECT rq.*, jq.started_at as job_started, jq.node_name as job_node
      FROM research_queue rq
      LEFT JOIN job_queue jq ON rq.job_id = jq.id
      WHERE rq.status IN ('dispatched', 'running')
        AND rq.started_at >= datetime('now', '-1 hour')
    `).all();

    for (const exp of recentlyDispatched) {
      // Check if we already logged a dispatch decision for this experiment
      const existing = db.db.prepare(
        "SELECT id FROM research_decisions WHERE decision LIKE ? LIMIT 1"
      ).get(`%experiment #${exp.id}%dispatched%`);
      if (existing) continue;

      const node = db.getNode(exp.node);
      const config = exp.config_json ? JSON.parse(exp.config_json) : {};
      const jobType = config.job_type || 'unknown';
      const hasGPU = node?.gpu && node.gpu !== 'none';

      // Build rationale from current node state
      const nodeStatus = nodeCache[exp.node] || {};
      const rationale = [
        `Node ${exp.node} selected: status=${nodeStatus.status || node?.status || 'unknown'}`,
        hasGPU ? `GPU=${node.gpu}, util=${nodeStatus.gpu_util ?? 'N/A'}%, VRAM=${nodeStatus.gpu_mem_mb ?? 'N/A'}MB` : 'CPU-only node',
        `Priority=${exp.priority} (lower=higher priority), type=${jobType}`,
        exp.depends_on ? `Dependency #${exp.depends_on} completed` : 'No dependencies',
      ].join('; ');

      db.logDecision(
        `Experiment #${exp.id} (${exp.name}) dispatched to ${exp.node} as job #${exp.job_id}`,
        rationale,
        {
          experiment_id: exp.id,
          node: exp.node,
          priority: exp.priority,
          job_type: jobType,
          requires_gpu: !!(hasGPU && config.requires_gpu !== false),
          node_gpu_util: nodeStatus.gpu_util ?? null,
          node_gpu_mem_mb: nodeStatus.gpu_mem_mb ?? null,
        },
        jobType === 'training' ? 'model' : (jobType === 'fillsim' ? 'execution' : 'strategy')
      );
    }

    // Also log outcomes for experiments that completed recently but have pending decisions without outcomes
    const recentlyCompleted = db.db.prepare(`
      SELECT * FROM research_queue
      WHERE status = 'completed'
        AND completed_at >= datetime('now', '-2 hours')
        AND result_json IS NOT NULL
    `).all();

    for (const exp of recentlyCompleted) {
      // Find decisions for this experiment that lack outcomes
      const pendingDecisions = db.db.prepare(
        "SELECT id FROM research_decisions WHERE decision LIKE ? AND outcome IS NULL LIMIT 5"
      ).all(`%experiment #${exp.id}%`);

      for (const dec of pendingDecisions) {
        db.updateDecisionOutcome(dec.id, `Experiment completed at ${exp.completed_at}`);
      }
    }

    log('DEBUG', `Decision audit complete: checked ${recentlyDispatched.length} dispatched, ${recentlyCompleted.length} completed`);
  } catch (e) {
    log('WARN', `Decision audit failed: ${e.message}`);
  }
}

function parseExperimentOutput(output) {
  if (!output) return null;
  const result = {};

  // Try to find a JSON result line (many scripts print RESULT: {...})
  const jsonMatch = output.match(/RESULT:\s*(\{[^}]+\})/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) { /* fall through to regex parsing */ }
  }

  // Parse common metrics
  const icMatch = output.match(/(?:ic|IC)[=:\s]+(-?[\d.]+)/);
  if (icMatch) result.ic = parseFloat(icMatch[1]);

  const sharpeMatch = output.match(/(?:sharpe|Sharpe)[=:\s]+(-?[\d.]+)/);
  if (sharpeMatch) result.sharpe = parseFloat(sharpeMatch[1]);

  const pnlMatch = output.match(/(?:pnl|PnL|total_pnl)[=:\s]+(-?[\d.]+)/);
  if (pnlMatch) result.pnl = parseFloat(pnlMatch[1]);

  const tradesMatch = output.match(/(?:trades|Trades)[=:\s]+(\d+)/);
  if (tradesMatch) result.trades = parseInt(tradesMatch[1]);

  const winRateMatch = output.match(/(?:win_rate|WinRate|win rate)[=:\s]+([\d.]+)/);
  if (winRateMatch) result.win_rate = parseFloat(winRateMatch[1]);

  const foldMatch = output.match(/(?:fold|Fold)[=:\s]+(\d+)/);
  if (foldMatch) result.fold = parseInt(foldMatch[1]);

  return Object.keys(result).length > 0 ? result : null;
}

// ========================
// DISCORD ALERTS
// ========================

async function sendAlert(type, title, description, fields = []) {
  // Try direct Discord API first (more reliable than webhooks)
  try {
    const colors = { success: 0x00ff00, warning: 0xffaa00, error: 0xff0000, info: 0x0099ff };
    await discordNotify.sendEmbed({
      title: title,
      description: description,
      fields: fields.map(f => ({ name: f.name, value: String(f.value).slice(0, 1024), inline: f.inline || false })),
      color: colors[type] || 0x0099ff,
    }, 'systemStatus');
    log('INFO', `Discord alert sent (direct API): ${title}`);
    return;
  } catch (e) {
    log('WARN', `Discord direct API failed: ${e.message}, trying webhook fallback`);
  }
  // Fallback to webhook notifier
  try {
    await webhookNotifier.notify(type, title, description, fields);
    log('INFO', `Discord alert sent (webhook): ${title}`);
  } catch (e) {
    log('WARN', `Discord alert failed (both methods): ${e.message}`);
  }
}

// ========================
// AUTO-POPULATE EXPERIMENTS
// ========================

function seedDefaultExperiments() {
  // Only seed if research_queue is empty
  const count = db.db.prepare('SELECT COUNT(*) as cnt FROM research_queue').get().cnt;
  if (count > 0) {
    log('INFO', `Research queue already has ${count} experiments, skipping seed`);
    return;
  }

  log('INFO', 'Seeding default experiments...');

  const experiments = [
    // Fill sim sweeps on Jupiter (CPU-intensive, no GPU)
    {
      name: 'Fill Sim: Wider CNN 10s',
      description: 'Fill simulation sweep for wider CNN 10-second model predictions',
      script_path: 'scripts/wider_cnn_fill_sim.py',
      node: 'jupiter',
      priority: 3,
      config_json: { job_type: 'fillsim', requires_gpu: false, params: { model: 'wider_cnn_10s' } },
      tags: ['fillsim', 'wider_cnn'],
    },
    {
      name: 'Expanding Window Card Sweep',
      description: 'Card parameter sweep using expanding window predictions',
      script_path: 'scripts/expanding_window_card_sweep.py',
      node: 'jupiter',
      priority: 4,
      config_json: { job_type: 'sweep', requires_gpu: false },
      tags: ['sweep', 'card_optimization'],
    },

    // Model training on Uranus (5090 GPU)
    {
      name: 'Deep CNN Experiment',
      description: 'Deeper CNN architecture exploration on 5090',
      script_path: 'scripts/deep_cnn_experiment.py',
      node: 'uranus',
      priority: 2,
      config_json: { job_type: 'training', requires_gpu: true },
      tags: ['training', 'deep_cnn', 'architecture'],
    },
    {
      name: 'Wider CNN Card Sweep (Uranus)',
      description: 'Card optimization sweep for wider CNN on Uranus',
      script_path: 'scripts/wider_cnn_card_sweep_uranus.py',
      node: 'uranus',
      priority: 4,
      config_json: { job_type: 'sweep', requires_gpu: true },
      tags: ['sweep', 'wider_cnn'],
    },

    // Feature ablation on Razer (3070 GPU, light work)
    {
      name: 'Feature Ablation Study',
      description: 'Feature importance ablation study on 3070',
      script_path: 'scripts/feature_ablation_razer.py',
      node: 'razer',
      priority: 3,
      config_json: { job_type: 'training', requires_gpu: true },
      tags: ['ablation', 'feature_research'],
    },

    // Card optimization sweeps on Neptune (local 3090)
    {
      name: 'TP Optimization Sweep',
      description: 'Take-profit tick optimization across all cards',
      script_path: 'scripts/tp_optimization_sweep.py',
      node: 'neptune',
      priority: 4,
      config_json: { job_type: 'sweep', requires_gpu: false },
      tags: ['sweep', 'tp_optimization'],
    },
    {
      name: 'Conviction Exit Validation',
      description: 'Validate conviction-based exit strategy across OOT period',
      script_path: 'scripts/conviction_exit_validation.py',
      node: 'neptune',
      priority: 5,
      config_json: { job_type: 'sweep', requires_gpu: false },
      tags: ['sweep', 'conviction_exit'],
    },

    // Analysis scripts on Jupiter (CPU)
    {
      name: 'Adverse Selection Analysis',
      description: 'Analyze adverse selection patterns in fill data',
      script_path: 'scripts/adverse_selection_analysis.py',
      node: 'jupiter',
      priority: 5,
      config_json: { job_type: 'other', requires_gpu: false },
      tags: ['analysis', 'fills'],
    },
    {
      name: 'Prediction Quality Analysis',
      description: 'Deep analysis of prediction quality across time periods',
      script_path: 'scripts/prediction_quality_analysis.py',
      node: 'jupiter',
      priority: 5,
      config_json: { job_type: 'other', requires_gpu: false },
      tags: ['analysis', 'prediction_quality'],
    },
    {
      name: 'Execution Cost Modeling',
      description: 'Model execution costs and slippage patterns',
      script_path: 'scripts/execution_cost_modeling.py',
      node: 'jupiter',
      priority: 6,
      config_json: { job_type: 'other', requires_gpu: false },
      tags: ['analysis', 'execution'],
    },

    // Short hold sweep on Neptune
    {
      name: 'Short Hold Sweep',
      description: 'Sweep optimal hold durations for short-term signals',
      script_path: 'scripts/short_hold_sweep.py',
      node: 'neptune',
      priority: 5,
      config_json: { job_type: 'sweep', requires_gpu: false },
      tags: ['sweep', 'hold_optimization'],
    },
  ];

  let seeded = 0;
  for (const exp of experiments) {
    try {
      addExperiment(exp);
      seeded++;
    } catch (e) {
      log('WARN', `Failed to seed experiment '${exp.name}': ${e.message}`);
    }
  }

  log('INFO', `Seeded ${seeded} default experiments`);
  sendAlert('info', 'Research Queue Initialized',
    `Orchestrator seeded ${seeded} experiments across ${new Set(experiments.map(e => e.node)).size} nodes.`);
}

// ========================
// HTTP API SERVER
// ========================

let httpServer = null;

function startAPIServer() {
  httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${ORCH_PORT}`);
    const pathname = url.pathname;

    try {
      // GET /api/research/queue — list experiments
      if (pathname === '/api/research/queue' && req.method === 'GET') {
        const status = url.searchParams.get('status') || null;
        const node = url.searchParams.get('node') || null;
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        return sendJSON(res, listExperiments(status, node, limit));
      }

      // GET /api/research/queue/summary — queue summary counts
      if (pathname === '/api/research/queue/summary' && req.method === 'GET') {
        return sendJSON(res, getQueueSummary());
      }

      // GET /api/research/queue/:id — single experiment
      const idMatch = pathname.match(/^\/api\/research\/queue\/(\d+)$/);
      if (idMatch && req.method === 'GET') {
        const exp = getExperiment(parseInt(idMatch[1], 10));
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        return sendJSON(res, exp);
      }

      // POST /api/research/queue — add experiment
      if (pathname === '/api/research/queue' && req.method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.name || !data.script_path || !data.node) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name, script_path, and node are required' }));
          return;
        }
        const result = addExperiment(data);
        return sendJSON(res, { status: 'queued', experiment_id: result.id });
      }

      // POST /api/research/queue/:id/cancel — cancel experiment
      const cancelMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const id = parseInt(cancelMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        if (!['queued', 'dispatched'].includes(exp.status)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Cannot cancel experiment in '${exp.status}' status` }));
          return;
        }
        updateExperiment(id, { status: 'cancelled', completed_at: new Date().toISOString() });
        // If it was dispatched, also cancel the underlying job
        if (exp.job_id) {
          try { db.cancelJob(exp.job_id); } catch (e) { /* job may already be done */ }
        }
        return sendJSON(res, { status: 'cancelled', experiment_id: id });
      }

      // POST /api/research/queue/:id/retry — retry failed experiment
      const retryMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/retry$/);
      if (retryMatch && req.method === 'POST') {
        const id = parseInt(retryMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        if (exp.status !== 'failed') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Can only retry failed experiments, current status: ${exp.status}` }));
          return;
        }
        updateExperiment(id, { status: 'queued', job_id: null, retry_count: 0 });
        return sendJSON(res, { status: 'requeued', experiment_id: id });
      }

      // POST /api/research/queue/:id/dispatch — manually dispatch
      const dispatchMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/dispatch$/);
      if (dispatchMatch && req.method === 'POST') {
        const id = parseInt(dispatchMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        if (exp.status !== 'queued') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Can only dispatch queued experiments, current status: ${exp.status}` }));
          return;
        }
        const node = db.getNode(exp.node);
        if (!node) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Node '${exp.node}' not found` }));
          return;
        }
        await dispatchExperiment(exp, node);
        return sendJSON(res, { status: 'dispatched', experiment_id: id });
      }

      // POST /api/research/queue/:id/claim — agent claims an experiment (queued → running)
      // Used by research_agent.py running natively on compute nodes.
      // Body: { node, pid, log_path }
      const claimMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/claim$/);
      if (claimMatch && req.method === 'POST') {
        const id = parseInt(claimMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        if (exp.status !== 'queued') {
          res.writeHead(409);
          res.end(JSON.stringify({ error: `Cannot claim experiment in '${exp.status}' status — already taken` }));
          return;
        }
        const body = await readBody(req);
        let data = {};
        try { data = JSON.parse(body); } catch (e) {}
        const updates = {
          status: 'running',
          started_at: new Date().toISOString(),
        };
        if (data.log_path) updates.log_path = data.log_path;
        updateExperiment(id, updates);
        log('INFO', `Agent claim: experiment #${id} (${exp.name}) claimed by node ${data.node || exp.node}, pid ${data.pid || '?'}`);
        return sendJSON(res, { status: 'claimed', experiment_id: id, name: exp.name, config_json: exp.config_json, script_path: exp.script_path });
      }

      // POST /api/research/queue/:id/heartbeat — agent signals it is still alive
      // Body: { node, pid }
      const heartbeatMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/heartbeat$/);
      if (heartbeatMatch && req.method === 'POST') {
        const id = parseInt(heartbeatMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        // Touch updated_at so the stale-monitor knows it is alive
        try {
          db.db.prepare("UPDATE research_queue SET updated_at = ? WHERE id = ?")
               .run(new Date().toISOString(), id);
        } catch (e) { /* updated_at column may not exist on older DBs — ignore */ }
        return sendJSON(res, { ok: true, experiment_id: id, status: exp.status });
      }

      // POST /api/research/queue/:id/complete — agent reports success
      // Body: { result_json, follow_up }
      const completeMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        const id = parseInt(completeMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        const body = await readBody(req);
        let data = {};
        try { data = JSON.parse(body); } catch (e) {}
        updateExperiment(id, {
          status: 'completed',
          result_json: data.result_json || null,
          completed_at: new Date().toISOString(),
        });
        log('INFO', `Agent complete: experiment #${id} (${exp.name}) marked completed`);
        // Queue follow-up if provided
        if (data.follow_up && data.follow_up.name && data.follow_up.script_path && data.follow_up.node) {
          const fu = data.follow_up;
          const fuResult = addExperiment({
            name: fu.name,
            description: fu.description || `Follow-up from #${id}`,
            script_path: fu.script_path,
            node: fu.node,
            priority: fu.priority || exp.priority,
            config_json: fu.config_json || null,
            depends_on: id,
          });
          log('INFO', `Agent follow-up: queued experiment #${fuResult.id} (${fu.name})`);
        }
        return sendJSON(res, { status: 'completed', experiment_id: id });
      }

      // POST /api/research/queue/:id/fail — agent reports failure
      // Body: { error, stderr_tail }
      const failMatch = pathname.match(/^\/api\/research\/queue\/(\d+)\/fail$/);
      if (failMatch && req.method === 'POST') {
        const id = parseInt(failMatch[1], 10);
        const exp = getExperiment(id);
        if (!exp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Experiment not found' }));
          return;
        }
        const body = await readBody(req);
        let data = {};
        try { data = JSON.parse(body); } catch (e) {}
        const errObj = { error: data.error || 'Agent reported failure', stderr_tail: data.stderr_tail || '' };
        const retryCount = (exp.retry_count || 0) + 1;
        const maxRetries = exp.max_retries || 2;
        if (retryCount <= maxRetries) {
          updateExperiment(id, { status: 'queued', job_id: null, retry_count: retryCount });
          log('WARN', `Agent fail: experiment #${id} (${exp.name}) — retry ${retryCount}/${maxRetries}. Error: ${errObj.error}`);
          return sendJSON(res, { status: 'requeued', retry_count: retryCount, experiment_id: id });
        } else {
          updateExperiment(id, {
            status: 'failed',
            result_json: JSON.stringify(errObj),
            completed_at: new Date().toISOString(),
            retry_count: retryCount,
          });
          log('ERROR', `Agent fail: experiment #${id} (${exp.name}) — permanently failed after ${retryCount} attempts. Error: ${errObj.error}`);
          return sendJSON(res, { status: 'failed', experiment_id: id });
        }
      }

      // GET /api/research/nodes — node readiness status
      if (pathname === '/api/research/nodes' && req.method === 'GET') {
        const nodes = db.getNodes();
        const result = nodes.map(n => ({
          name: n.name,
          status: n.status,
          gpu: n.gpu,
          gpu_util: n.last_gpu_util,
          ready: isNodeReady(n.name),
          queued_experiments: db.db.prepare(
            "SELECT COUNT(*) as cnt FROM research_queue WHERE node = ? AND status = 'queued'"
          ).get(n.name).cnt,
          running_experiments: db.db.prepare(
            "SELECT COUNT(*) as cnt FROM research_queue WHERE node = ? AND status IN ('dispatched','running')"
          ).get(n.name).cnt,
        }));
        return sendJSON(res, result);
      }

      // GET /api/research/status — orchestrator health
      if (pathname === '/api/research/status' && req.method === 'GET') {
        return sendJSON(res, {
          uptime_sec: Math.floor(process.uptime()),
          pid: process.pid,
          memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          poll_interval_ms: POLL_INTERVAL,
          dispatch_interval_ms: DISPATCH_INTERVAL,
          monitor_interval_ms: MONITOR_INTERVAL,
          queue: getQueueSummary(),
          node_cache_age: Object.fromEntries(
            Object.entries(nodeCache).map(([k, v]) => [k, v.updated])
          ),
        });
      }

      // ========================
      // STRATEGY RESULTS API
      // ========================

      // GET /api/research/strategies — list strategy results with optional filters
      if (pathname === '/api/research/strategies' && req.method === 'GET') {
        const filters = {
          strategy_name: url.searchParams.get('strategy_name') || undefined,
          data_source: url.searchParams.get('data_source') || undefined,
          experiment_id: url.searchParams.get('experiment_id') ? parseInt(url.searchParams.get('experiment_id'), 10) : undefined,
          min_sharpe: url.searchParams.get('min_sharpe') ? parseFloat(url.searchParams.get('min_sharpe')) : undefined,
          validated_fillsim: url.searchParams.has('validated_fillsim') ? (url.searchParams.get('validated_fillsim') === 'true') : undefined,
          limit: parseInt(url.searchParams.get('limit') || '100', 10),
        };
        // Remove undefined keys
        for (const k of Object.keys(filters)) { if (filters[k] === undefined) delete filters[k]; }
        return sendJSON(res, db.getStrategyResults(filters));
      }

      // GET /api/research/strategies/best — top N strategies by Sharpe
      if (pathname === '/api/research/strategies/best' && req.method === 'GET') {
        const topN = parseInt(url.searchParams.get('top') || '10', 10);
        const dataSource = url.searchParams.get('data_source') || null;
        return sendJSON(res, db.getBestStrategies(topN, dataSource));
      }

      // POST /api/research/strategies — manually insert a strategy result
      if (pathname === '/api/research/strategies' && req.method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.strategy_name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'strategy_name is required' }));
          return;
        }
        const result = db.insertStrategyResult(data);
        return sendJSON(res, { status: 'inserted', id: result.id });
      }

      // ========================
      // FILL SIM RESULTS API
      // ========================

      // GET /api/research/fillsim — query fillsim results
      if (pathname === '/api/research/fillsim' && req.method === 'GET') {
        const configName = url.searchParams.get('config_name');
        const limit = parseInt(url.searchParams.get('limit') || '200', 10);
        if (!configName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'config_name query param required' }));
          return;
        }
        return sendJSON(res, db.getFillsimResults(configName, limit));
      }

      // GET /api/research/fillsim/summary — aggregate summary for a config
      if (pathname === '/api/research/fillsim/summary' && req.method === 'GET') {
        const configName = url.searchParams.get('config_name');
        if (!configName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'config_name query param required' }));
          return;
        }
        return sendJSON(res, db.getFillsimSummary(configName));
      }

      // POST /api/research/fillsim — manually insert fillsim result
      if (pathname === '/api/research/fillsim' && req.method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.config_name || !data.mbo_date) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'config_name and mbo_date are required' }));
          return;
        }
        const result = db.insertFillsimResult(data);
        return sendJSON(res, { status: 'inserted', id: result.id });
      }

      // ========================
      // EXPERIMENT METRICS API
      // ========================

      // GET /api/research/metrics/:experiment_id — get metrics for an experiment
      const metricsMatch = pathname.match(/^\/api\/research\/metrics\/(\d+)$/);
      if (metricsMatch && req.method === 'GET') {
        const experimentId = parseInt(metricsMatch[1], 10);
        const fold = url.searchParams.has('fold') ? parseInt(url.searchParams.get('fold'), 10) : null;
        return sendJSON(res, db.getExperimentMetrics(experimentId, fold));
      }

      // POST /api/research/metrics — insert a metric data point
      if (pathname === '/api/research/metrics' && req.method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.experiment_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'experiment_id is required' }));
          return;
        }
        const result = db.insertMetric(data);
        return sendJSON(res, { status: 'inserted', id: result.id });
      }

      // ========================
      // DECISIONS API
      // ========================

      // GET /api/research/decisions — list decisions with optional category filter
      if (pathname === '/api/research/decisions' && req.method === 'GET') {
        const category = url.searchParams.get('category') || null;
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        return sendJSON(res, db.listDecisions(category, limit));
      }

      // POST /api/research/decisions — manually log a decision
      if (pathname === '/api/research/decisions' && req.method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.decision) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'decision text is required' }));
          return;
        }
        const result = db.logDecision(data.decision, data.rationale, data.evidence, data.category);
        return sendJSON(res, { status: 'logged', id: result.id });
      }

      // PUT /api/research/decisions/:id/outcome — update decision outcome
      const decisionOutcomeMatch = pathname.match(/^\/api\/research\/decisions\/(\d+)\/outcome$/);
      if (decisionOutcomeMatch && req.method === 'PUT') {
        const id = parseInt(decisionOutcomeMatch[1], 10);
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.outcome) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'outcome text is required' }));
          return;
        }
        db.updateDecisionOutcome(id, data.outcome);
        return sendJSON(res, { status: 'updated', id });
      }

      // ========================
      // RESEARCHERS API
      // ========================

      // GET /api/research/researchers — list all researchers with task counts
      if (pathname === '/api/research/researchers' && req.method === 'GET') {
        const researchers = db.listResearchers();
        const result = researchers.map(r => {
          const tasks = db.getResearcherTasks(r.id);
          const taskCounts = { queued: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, total: tasks.length };
          for (const t of tasks) {
            if (taskCounts[t.status] !== undefined) taskCounts[t.status]++;
          }
          return { ...r, task_counts: taskCounts };
        });
        return sendJSON(res, result);
      }

      // GET /api/research/researchers/:id — full researcher detail with tasks and findings
      const researcherDetailMatch = pathname.match(/^\/api\/research\/researchers\/([a-z]+)$/);
      if (researcherDetailMatch && req.method === 'GET') {
        const researcherId = researcherDetailMatch[1];
        const researcher = db.getResearcher(researcherId);
        if (!researcher) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Researcher '${researcherId}' not found` }));
          return;
        }
        const tasks = db.getResearcherTasks(researcherId);
        const findings = db.getResearcherFindings(researcherId, 100);
        let context = null;
        if (researcher.context_json) {
          try { context = JSON.parse(researcher.context_json); } catch (e) { context = researcher.context_json; }
        }
        return sendJSON(res, { ...researcher, context, tasks, findings });
      }

      // POST /api/research/researchers/:id/tasks — add task to a researcher
      const researcherTaskMatch = pathname.match(/^\/api\/research\/researchers\/([a-z]+)\/tasks$/);
      if (researcherTaskMatch && req.method === 'POST') {
        const researcherId = researcherTaskMatch[1];
        const researcher = db.getResearcher(researcherId);
        if (!researcher) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Researcher '${researcherId}' not found` }));
          return;
        }
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.task) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'task is required' }));
          return;
        }
        const result = db.addResearcherTask(researcherId, data.task, data.description || null, data.priority || 5);
        return sendJSON(res, { status: 'added', researcher_id: researcherId, task_id: result.id });
      }

      // POST /api/research/researchers/:id/findings — add finding to a researcher
      const researcherFindingMatch = pathname.match(/^\/api\/research\/researchers\/([a-z]+)\/findings$/);
      if (researcherFindingMatch && req.method === 'POST') {
        const researcherId = researcherFindingMatch[1];
        const researcher = db.getResearcher(researcherId);
        if (!researcher) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Researcher '${researcherId}' not found` }));
          return;
        }
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data.finding) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'finding is required' }));
          return;
        }
        const result = db.addResearcherFinding(
          researcherId, data.finding, data.evidence || null, data.impact || null, data.experiment_id || null
        );
        return sendJSON(res, { status: 'added', researcher_id: researcherId, finding_id: result.id });
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', available_routes: [
        'GET  /api/research/queue',
        'GET  /api/research/queue/summary',
        'GET  /api/research/queue/:id',
        'POST /api/research/queue',
        'POST /api/research/queue/:id/cancel',
        'POST /api/research/queue/:id/retry',
        'POST /api/research/queue/:id/dispatch',
        'POST /api/research/queue/:id/claim',
        'POST /api/research/queue/:id/heartbeat',
        'POST /api/research/queue/:id/complete',
        'POST /api/research/queue/:id/fail',
        'GET  /api/research/nodes',
        'GET  /api/research/status',
        'GET  /api/research/strategies',
        'GET  /api/research/strategies/best',
        'POST /api/research/strategies',
        'GET  /api/research/fillsim?config_name=...',
        'GET  /api/research/fillsim/summary?config_name=...',
        'POST /api/research/fillsim',
        'GET  /api/research/metrics/:experiment_id',
        'POST /api/research/metrics',
        'GET  /api/research/decisions',
        'POST /api/research/decisions',
        'PUT  /api/research/decisions/:id/outcome',
        'GET  /api/research/researchers',
        'GET  /api/research/researchers/:id',
        'POST /api/research/researchers/:id/tasks',
        'POST /api/research/researchers/:id/findings',
      ] }));

    } catch (e) {
      log('ERROR', `HTTP error: ${e.message}`, { path: pathname });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  httpServer.listen(ORCH_PORT, '0.0.0.0', () => {
    log('INFO', `Orchestrator API listening on port ${ORCH_PORT}`);
  });

  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log('ERROR', `Port ${ORCH_PORT} in use — orchestrator API disabled`);
    } else {
      log('ERROR', `HTTP server error: ${e.message}`);
    }
  });
}

function sendJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ========================
// MAIN LOOPS
// ========================

const intervals = [];

function startMonitoringLoops() {
  // 1. Node status polling (every 60s)
  const pollInterval = setInterval(async () => {
    try { await pollNodeStatus(); } catch (e) { log('ERROR', `Node poll error: ${e.message}`); }
  }, POLL_INTERVAL);
  intervals.push(pollInterval);

  // 2. Dispatch cycle (every 30s)
  const dispatchInterval = setInterval(async () => {
    try { await runDispatchCycle(); } catch (e) { log('ERROR', `Dispatch cycle error: ${e.message}`); }
  }, DISPATCH_INTERVAL);
  intervals.push(dispatchInterval);

  // 3. Monitor cycle (every 5 min)
  const monitorInterval = setInterval(async () => {
    try { await runMonitorCycle(); } catch (e) { log('ERROR', `Monitor cycle error: ${e.message}`); }
  }, MONITOR_INTERVAL);
  intervals.push(monitorInterval);

  // 4. Decision audit cycle (every 10 min) — log dispatch decisions and update outcomes
  const AUDIT_INTERVAL = parseInt(process.env.ORCH_AUDIT_MS || '600000', 10);
  const auditInterval = setInterval(() => {
    try { runDecisionAudit(); } catch (e) { log('ERROR', `Decision audit error: ${e.message}`); }
  }, AUDIT_INTERVAL);
  intervals.push(auditInterval);

  // 5. Auto-retry failed experiments (every 5 min)
  const RETRY_INTERVAL = parseInt(process.env.ORCH_RETRY_MS || '300000', 10);
  const retryInterval = setInterval(() => {
    try { autoRetryFailedExperiments(); } catch (e) { log('ERROR', `Auto-retry error: ${e.message}`); }
  }, RETRY_INTERVAL);
  intervals.push(retryInterval);

  // Initial run after 10s warmup
  setTimeout(async () => {
    log('INFO', 'Running initial orchestrator cycles...');
    try { await pollNodeStatus(); } catch (e) { log('ERROR', `Initial poll: ${e.message}`); }
    // Auto-retry failed experiments BEFORE first dispatch cycle so they're eligible
    try { autoRetryFailedExperiments(); } catch (e) { log('ERROR', `Initial auto-retry: ${e.message}`); }
    try { await runDispatchCycle(); } catch (e) { log('ERROR', `Initial dispatch: ${e.message}`); }
    try { await runMonitorCycle(); } catch (e) { log('ERROR', `Initial monitor: ${e.message}`); }
    try { runDecisionAudit(); } catch (e) { log('ERROR', `Initial audit: ${e.message}`); }
  }, 10000);

  log('INFO', 'Monitoring loops started', {
    poll_ms: POLL_INTERVAL,
    dispatch_ms: DISPATCH_INTERVAL,
    monitor_ms: MONITOR_INTERVAL,
    audit_ms: AUDIT_INTERVAL,
  });
}

// ========================
// PROXY: Forward queue routes to QCC daemon
// ========================

// Also register our research_queue endpoints on the QCC daemon's port
// by making the orchestrator available as a module that the daemon can import
function getOrchestratorAPI() {
  return {
    addExperiment,
    listExperiments,
    getExperiment,
    updateExperiment,
    getQueueSummary,
    getNextExperiment,
    isNodeReady,
    runDecisionAudit,
    persistFillsimResults,
    persistStrategyResults,
    persistTrainingMetrics,
  };
}

// ========================
// STARTUP
// ========================

function main() {
  log('INFO', '=== Research Orchestrator Starting ===');

  // Initialize database (shares SQLite with QCC daemon via WAL mode)
  initDatabase();

  // Seed default experiments if queue is empty
  seedDefaultExperiments();

  // ----------------------------------------------------------------
  // Startup summary: queue state and node states
  // ----------------------------------------------------------------
  const summary = getQueueSummary();
  const nodes = db.getNodes();

  log('INFO', '--- Startup: Queue Summary ---');
  log('INFO', `  Total: ${summary.total} | Queued: ${summary.queued} | Dispatched: ${summary.dispatched} | Running: ${summary.running} | Completed: ${summary.completed} | Failed: ${summary.failed} | Cancelled: ${summary.cancelled}`);

  log('INFO', '--- Startup: Node States ---');
  for (const n of nodes) {
    log('INFO', `  ${n.name}: status=${n.status}, gpu=${n.gpu || 'none'}, gpu_util=${n.last_gpu_util ?? 'N/A'}%, host=${n.host}`);
  }

  // Show failed experiments at startup
  const failedExps = db.db.prepare("SELECT id, name, node, retry_count, max_retries FROM research_queue WHERE status = 'failed'").all();
  if (failedExps.length > 0) {
    log('WARN', `--- Startup: ${failedExps.length} FAILED experiments (will auto-retry if scripts exist) ---`);
    for (const e of failedExps) {
      log('WARN', `  #${e.id} [${e.node}] ${e.name} (retries: ${e.retry_count}/${e.max_retries})`);
    }
  }

  // Show queued experiments by node
  const queuedExps = db.db.prepare("SELECT id, name, node, priority FROM research_queue WHERE status = 'queued' ORDER BY node, priority").all();
  if (queuedExps.length > 0) {
    log('INFO', `--- Startup: ${queuedExps.length} QUEUED experiments ---`);
    for (const e of queuedExps) {
      log('INFO', `  #${e.id} [${e.node}] pri=${e.priority} ${e.name}`);
    }
  }

  // Start API server
  startAPIServer();

  // Start monitoring loops
  startMonitoringLoops();

  // Send startup notification
  sendAlert('info', 'Research Orchestrator Online',
    `Orchestrator on port ${ORCH_PORT}. Queue: ${summary.queued} queued, ${summary.running} running, ${summary.failed} failed, ${summary.completed} completed. Nodes: ${nodes.map(n => `${n.name}=${n.status}`).join(', ')}`
  );

  log('INFO', '=== Research Orchestrator Ready ===');
}

// ========================
// GRACEFUL SHUTDOWN
// ========================

function shutdown(signal) {
  log('INFO', `Shutting down (${signal})...`);

  // Stop intervals
  for (const interval of intervals) {
    clearInterval(interval);
  }

  // Close HTTP server
  if (httpServer) {
    httpServer.close(() => log('INFO', 'HTTP server closed'));
  }

  // Close database
  if (db) {
    try { db.close(); } catch (e) { /* ignore */ }
  }

  log('INFO', 'Orchestrator shut down cleanly');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log('ERROR', `Uncaught exception: ${e.message}`, { stack: e.stack });
  // Don't crash — let PM2 decide
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});

// Export for use as a module (QCC daemon can require this)
module.exports = { getOrchestratorAPI, addExperiment, listExperiments, getQueueSummary };

// Run if executed directly
if (require.main === module) {
  main();
}
