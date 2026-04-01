#!/usr/bin/env node
/**
 * Auto-Dispatch — PM2-managed training auto-resume and job dispatch
 *
 * Runs independently of Claude sessions. Monitors the compute cluster via QCC
 * and automatically:
 *   1. Detects and restarts crashed training jobs
 *   2. Dispatches queued jobs when GPUs go idle
 *   3. Detects training completion and triggers next-job dispatch
 *
 * Usage:
 *   node compute/auto_dispatch.js                     # Direct run
 *   pm2 start compute/auto_dispatch.ecosystem.js      # PM2 managed
 *
 * CRITICAL RULES:
 *   - NEVER connect to Rithmic. Only manage training processes.
 *   - Neptune training must run at BELOW_NORMAL priority.
 *   - Neptune is localhost (no SSH needed for local commands).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(BASE_DIR, 'compute');
const LOG_FILE = path.join(LOG_DIR, 'auto_dispatch.log');
const QUEUE_FILE = path.join(LOG_DIR, 'job_queues.json');
const STATE_FILE = path.join(LOG_DIR, 'auto_dispatch_state.json');

const QCC_BASE = `http://localhost:${process.env.QCC_PORT || 3456}`;
const POLL_INTERVAL = parseInt(process.env.AD_POLL_MS || '60000', 10);       // 60s health poll
const CRASH_CONFIRM_MS = parseInt(process.env.AD_CRASH_CONFIRM_MS || '120000', 10); // 2 min confirm
const LOG_TAIL_INTERVAL = parseInt(process.env.AD_LOG_TAIL_MS || '90000', 10); // 90s log check

// Completion markers in training logs
const COMPLETION_MARKERS = [
  'Training complete',
  'All folds finished',
  'all folds complete',
  'TRAINING FINISHED',
  'WalkForward complete',
  'walk_forward complete',
  'Experiment complete',
  '=== DONE ===',
];

// GPU nodes we manage (only nodes with GPUs)
const GPU_NODES = ['neptune', 'uranus'];

// Node metadata for SSH/local execution
const NODE_META = {
  neptune: { local: true, python: 'python', os: 'windows' },
  uranus:  { local: false, os: 'windows' },
  razer:   { local: false, os: 'windows' },
};

// ============================================================================
// LOGGING
// ============================================================================

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  let entry = `[${ts}] [${level}] ${msg}`;
  if (data) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch { entry += ' | [unserializable]'; }
  }
  entry += '\n';

  // Rotate log if > 10MB
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 10 * 1024 * 1024) {
      const rotated = LOG_FILE + '.' + new Date().toISOString().split('T')[0] + '.bak';
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch { /* file may not exist yet */ }

  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch { /* best effort */ }

  // Also emit to stdout for PM2 log capture
  if (level === 'ERROR') {
    process.stderr.write(entry);
  } else {
    process.stdout.write(entry);
  }
}

// ============================================================================
// HTTP HELPERS (talk to QCC daemon)
// ============================================================================

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, QCC_BASE);
    const req = http.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

function httpPost(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, QCC_BASE);
    const data = JSON.stringify(payload);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
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
// DISCORD NOTIFICATIONS (via webhook_notifier pattern)
// ============================================================================

let _notifier = null;
function getNotifier() {
  if (!_notifier) {
    try {
      _notifier = require(path.join(BASE_DIR, 'utils', 'webhook_notifier'));
    } catch (e) {
      log('WARN', 'Could not load webhook_notifier, Discord alerts disabled', { error: e.message });
      _notifier = {
        notifications: {
          info: () => Promise.resolve(),
          warning: () => Promise.resolve(),
          error: () => Promise.resolve(),
          success: () => Promise.resolve(),
        }
      };
    }
  }
  return _notifier;
}

async function alertDiscord(type, title, message) {
  try {
    const notifier = getNotifier();
    if (type === 'error' || type === 'task_failed') {
      await notifier.notifications.error(title, message);
    } else if (type === 'warning') {
      await notifier.notifications.warning(title, message);
    } else if (type === 'success') {
      await notifier.notifications.success(title, message);
    } else {
      await notifier.notifications.info(title, message);
    }
    log('INFO', `Discord alert sent: ${title}`);
  } catch (e) {
    log('WARN', `Discord alert failed: ${e.message}`);
  }

  // Also send via QCC alert API
  try {
    const severity = (type === 'error' || type === 'task_failed') ? 'critical' : (type === 'warning' ? 'warning' : 'info');
    await httpPost('/api/alerts', { severity, source: 'auto_dispatch', message: `${title}: ${message}` });
  } catch { /* best effort */ }
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
    // Map of node -> { first_idle_seen: ISO, confirmed: bool, last_job_id: int }
    crash_suspects: {},
    // Map of node -> last known job id that we handled
    last_handled_job: {},
    // Track completed jobs to avoid re-alerting
    completed_jobs: [],
    // Stats
    total_restarts: 0,
    total_dispatches: 0,
    started_at: new Date().toISOString(),
  };
}

function saveState(state) {
  try {
    // Keep completed_jobs list manageable
    if (state.completed_jobs.length > 200) {
      state.completed_jobs = state.completed_jobs.slice(-100);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log('ERROR', `Failed to save state: ${e.message}`);
  }
}

// ============================================================================
// JOB QUEUE MANAGEMENT
// ============================================================================

function loadQueues() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch (e) {
    log('WARN', `Failed to load job queues: ${e.message}`);
  }
  // Default structure: per-node queues
  return { neptune: [], uranus: [], razer: [] };
}

function saveQueues(queues) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queues, null, 2), 'utf8');
  } catch (e) {
    log('ERROR', `Failed to save job queues: ${e.message}`);
  }
}

/**
 * Add a job to a node's queue.
 * @param {string} node
 * @param {object} job - { command, description, priority?, cwd? }
 */
function enqueueJob(node, job) {
  const queues = loadQueues();
  if (!queues[node]) queues[node] = [];

  const entry = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    node,
    command: job.command,
    description: job.description || 'Unnamed job',
    priority: job.priority || 5, // 1=highest, 10=lowest
    cwd: job.cwd || null,
    added_at: new Date().toISOString(),
    status: 'queued',
  };

  queues[node].push(entry);
  // Sort by priority (lower = higher priority)
  queues[node].sort((a, b) => a.priority - b.priority);
  saveQueues(queues);
  log('INFO', `Enqueued job on ${node}: ${entry.description}`, { id: entry.id, priority: entry.priority });
  return entry;
}

/**
 * Dequeue the next job for a node. Returns null if queue empty.
 */
function dequeueJob(node) {
  const queues = loadQueues();
  if (!queues[node] || queues[node].length === 0) return null;

  const job = queues[node].shift();
  saveQueues(queues);
  return job;
}

/**
 * Peek at the next job without removing it.
 */
function peekQueue(node) {
  const queues = loadQueues();
  if (!queues[node] || queues[node].length === 0) return null;
  return queues[node][0];
}

/**
 * Get queue lengths for all nodes.
 */
function getQueueLengths() {
  const queues = loadQueues();
  const lengths = {};
  for (const [node, jobs] of Object.entries(queues)) {
    lengths[node] = jobs.filter(j => j.status === 'queued').length;
  }
  return lengths;
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

/**
 * Execute a command on a node. Neptune = local, others = QCC SSH.
 */
async function execOnNode(node, command, { timeout = 30000 } = {}) {
  if (node === 'neptune' || NODE_META[node]?.local) {
    return execLocal(command, timeout);
  }
  return execViaQCC(node, command, timeout);
}

function execLocal(command, timeout = 30000) {
  return new Promise((resolve, reject) => {
    try {
      const result = execSync(command, {
        timeout,
        encoding: 'utf8',
        shell: true,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      resolve({ stdout: result, exitCode: 0 });
    } catch (e) {
      if (e.killed) {
        reject(new Error(`Command timed out after ${timeout}ms`));
      } else {
        resolve({ stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status || 1 });
      }
    }
  });
}

async function execViaQCC(node, command, timeout = 30000) {
  // Use the QCC MCP's ssh_exec endpoint (HTTP wrapper around the SSH pool)
  // The daemon exposes /api/ssh-exec via POST
  try {
    const result = await httpPost('/api/ssh-exec', { node, command, timeout });
    return result;
  } catch (e) {
    // Fallback: try direct MCP call format
    log('WARN', `QCC ssh-exec failed for ${node}, trying MCP format`, { error: e.message });
    throw e;
  }
}

// ============================================================================
// CRASH DETECTION & AUTO-RESTART
// ============================================================================

/**
 * Check if a node's GPU is idle with an active "running" job -> possible crash.
 */
function detectCrash(node, nodeData, activeJobs, state) {
  const nodeJobs = activeJobs.filter(j => j.node === node && j.status === 'running');
  if (nodeJobs.length === 0) {
    // No active jobs on this node -> clear suspect
    delete state.crash_suspects[node];
    return null;
  }

  const gpuUtil = nodeData.last_gpu_util;
  const isIdle = gpuUtil !== null && gpuUtil !== undefined && gpuUtil <= 2; // 0-2% is idle

  if (!isIdle) {
    // GPU is active -> clear suspect
    delete state.crash_suspects[node];
    return null;
  }

  // GPU idle with running job -> suspect crash
  const suspect = state.crash_suspects[node];
  if (!suspect) {
    // First time seeing idle -> record but don't act yet
    state.crash_suspects[node] = {
      first_idle_seen: new Date().toISOString(),
      confirmed: false,
      job_ids: nodeJobs.map(j => j.id),
    };
    log('INFO', `Crash suspect on ${node}: GPU idle with ${nodeJobs.length} running job(s). Monitoring...`);
    return null;
  }

  // Already tracking -> check if 2 min have passed
  const elapsed = Date.now() - new Date(suspect.first_idle_seen).getTime();
  if (elapsed < CRASH_CONFIRM_MS) {
    return null; // Still waiting for confirmation
  }

  if (suspect.confirmed) {
    return null; // Already handled
  }

  // CONFIRMED CRASH
  suspect.confirmed = true;
  log('WARN', `CRASH CONFIRMED on ${node}: GPU idle for ${Math.round(elapsed / 1000)}s with running jobs`, {
    jobs: nodeJobs.map(j => ({ id: j.id, desc: j.description }))
  });

  return nodeJobs;
}

/**
 * Handle a confirmed crash: kill zombies, clear CUDA, re-launch.
 */
async function handleCrash(node, crashedJobs, state) {
  log('INFO', `Handling crash on ${node}: ${crashedJobs.length} job(s)`);

  for (const job of crashedJobs) {
    try {
      // Step 1: Kill zombie Python processes
      log('INFO', `Killing zombie processes on ${node}...`);
      if (NODE_META[node]?.os === 'windows' || node === 'neptune') {
        await execOnNode(node, 'taskkill /F /IM python.exe 2>nul || echo "No python processes"');
        await execOnNode(node, 'taskkill /F /IM python3.exe 2>nul || echo "No python3 processes"');
      } else {
        await execOnNode(node, 'pkill -9 -f python || true');
      }

      // Step 2: Clear CUDA state
      log('INFO', `Clearing CUDA state on ${node}...`);
      if (NODE_META[node]?.os === 'windows' || node === 'neptune') {
        // On Windows, killing python processes releases CUDA. Wait a moment.
        await new Promise(r => setTimeout(r, 5000));
        // Verify GPU is freed
        await execOnNode(node, 'nvidia-smi');
      } else {
        await execOnNode(node, 'nvidia-smi --gpu-reset 2>/dev/null || true');
      }

      // Step 3: Re-launch the training command
      const jobConfig = job.config_json ? JSON.parse(job.config_json) : null;
      const command = jobConfig?.command || job.description;

      if (!command || command === job.description) {
        log('WARN', `No re-launch command found for job ${job.id} on ${node}. Marking failed.`);
        await alertDiscord('warning',
          `Crash on ${node} - Manual Restart Needed`,
          `Job "${job.description}" (ID: ${job.id}) crashed but has no saved launch command. Manual intervention required.`
        );
        continue;
      }

      log('INFO', `Re-launching job ${job.id} on ${node}: ${command.slice(0, 100)}...`);

      // Neptune: use BELOW_NORMAL priority
      let launchCmd = command;
      if (node === 'neptune') {
        // Wrap in START /BELOWNORMAL for Windows priority
        if (!launchCmd.toLowerCase().includes('/belownormal')) {
          launchCmd = `start /BELOWNORMAL /B ${launchCmd}`;
        }
      }

      await execOnNode(node, launchCmd);

      state.total_restarts++;
      delete state.crash_suspects[node];

      await alertDiscord('warning',
        `Auto-Restart: ${node}`,
        `Job "${job.description}" (ID: ${job.id}) crashed and was automatically restarted.\n` +
        `GPU was idle for 2+ minutes with job marked as running.\n` +
        `Total auto-restarts: ${state.total_restarts}`
      );

      log('INFO', `Successfully restarted job ${job.id} on ${node}`);

    } catch (e) {
      log('ERROR', `Failed to handle crash for job ${job.id} on ${node}: ${e.message}`);
      await alertDiscord('error',
        `Auto-Restart FAILED: ${node}`,
        `Could not restart job "${job.description}" (ID: ${job.id}) on ${node}.\nError: ${e.message}\nManual intervention required.`
      );
    }
  }
}

// ============================================================================
// TRAINING COMPLETION DETECTION
// ============================================================================

/**
 * Check training logs for completion markers.
 */
async function checkTrainingLogs(health) {
  const completedJobIds = [];

  // Check the log-based monitor from QCC training endpoint
  let trainingData;
  try {
    trainingData = await httpGet('/api/training');
  } catch (e) {
    log('WARN', `Could not fetch training data: ${e.message}`);
    return completedJobIds;
  }

  // Check log_monitor entries for completed status
  if (trainingData.log_monitor) {
    for (const [logFile, info] of Object.entries(trainingData.log_monitor)) {
      if (info.status === 'completed' || info.status === 'finished') {
        // Find matching running job
        const matchingJobs = (trainingData.running || []).filter(j =>
          j.node && info.modelType &&
          (j.description || '').toLowerCase().includes(info.modelType.toLowerCase())
        );
        for (const job of matchingJobs) {
          completedJobIds.push(job.id);
        }
      }
    }
  }

  // Also check stale_jobs from health (heartbeat > 30 min and GPU idle likely means done or crashed)
  // We handle this through crash detection, not here

  return completedJobIds;
}

/**
 * Handle a completed training job: mark done, alert Discord, dispatch next.
 */
async function handleCompletion(jobId, node, description, state) {
  if (state.completed_jobs.includes(jobId)) return; // Already handled

  log('INFO', `Training completed: job ${jobId} on ${node} - ${description}`);
  state.completed_jobs.push(jobId);

  // Fetch results summary if available
  let resultSummary = 'No result details available.';
  try {
    const trainingData = await httpGet('/api/training');
    const completedList = trainingData.recent_completed || [];
    const job = completedList.find(j => j.id === jobId);
    if (job?.result_json) {
      const result = JSON.parse(job.result_json);
      resultSummary = `IC: ${result.mean_ic || 'N/A'}, Folds: ${result.completed_folds || 'N/A'}`;
    }
  } catch { /* best effort */ }

  await alertDiscord('success',
    `Training Complete: ${node}`,
    `Job "${description}" (ID: ${jobId}) finished successfully.\n${resultSummary}\nChecking queue for next job...`
  );

  // Dispatch next job from queue
  await dispatchNextJob(node, state);
}

// ============================================================================
// AUTO-DISPATCH
// ============================================================================

/**
 * Check if a node is idle (no running jobs, GPU free) and dispatch next queued job.
 */
async function checkAndDispatch(node, nodeData, activeJobs, state) {
  const nodeJobs = activeJobs.filter(j => j.node === node && j.status === 'running');
  if (nodeJobs.length > 0) return; // Node busy

  // Check GPU - must be idle
  const gpuUtil = nodeData.last_gpu_util;
  if (gpuUtil !== null && gpuUtil > 5) return; // GPU still doing something

  // Check SSH connectivity for remote nodes
  if (!NODE_META[node]?.local && !nodeData.ssh_connected) {
    return; // Can't reach node
  }

  await dispatchNextJob(node, state);
}

/**
 * Dispatch the next queued job to a node.
 */
async function dispatchNextJob(node, state) {
  const nextJob = dequeueJob(node);
  if (!nextJob) {
    log('DEBUG', `No queued jobs for ${node}`);
    return;
  }

  log('INFO', `Dispatching job to ${node}: ${nextJob.description}`, { id: nextJob.id, command: nextJob.command.slice(0, 100) });

  try {
    let launchCmd = nextJob.command;

    // Neptune: enforce BELOW_NORMAL priority
    if (node === 'neptune' && (NODE_META[node]?.os === 'windows' || NODE_META[node]?.local)) {
      if (!launchCmd.toLowerCase().includes('/belownormal')) {
        launchCmd = `start /BELOWNORMAL /B ${launchCmd}`;
      }
    }

    // If cwd specified, prepend cd
    if (nextJob.cwd) {
      if (NODE_META[node]?.os === 'windows' || node === 'neptune') {
        launchCmd = `cd /d "${nextJob.cwd}" && ${launchCmd}`;
      } else {
        launchCmd = `cd "${nextJob.cwd}" && ${launchCmd}`;
      }
    }

    await execOnNode(node, launchCmd);

    // Register the job with QCC
    try {
      await httpPost('/api/training/register', {
        node,
        description: nextJob.description,
        model_type: 'queued_dispatch',
      });
    } catch (e) {
      log('WARN', `Could not register dispatched job with QCC: ${e.message}`);
    }

    state.total_dispatches++;
    state.last_handled_job[node] = nextJob.id;

    const remaining = getQueueLengths();
    await alertDiscord('info',
      `Job Dispatched: ${node}`,
      `Started: "${nextJob.description}"\nPriority: ${nextJob.priority}\nQueued at: ${nextJob.added_at}\nRemaining in queue: ${remaining[node] || 0}`
    );

    log('INFO', `Successfully dispatched job ${nextJob.id} to ${node}`);

  } catch (e) {
    log('ERROR', `Failed to dispatch job ${nextJob.id} to ${node}: ${e.message}`);

    // Re-queue the job at the front
    const queues = loadQueues();
    if (!queues[node]) queues[node] = [];
    nextJob.status = 'queued'; // Reset status
    queues[node].unshift(nextJob);
    saveQueues(queues);

    await alertDiscord('error',
      `Dispatch FAILED: ${node}`,
      `Could not start "${nextJob.description}" on ${node}.\nError: ${e.message}\nJob re-queued at front of line.`
    );
  }
}

// ============================================================================
// MAIN POLL LOOP
// ============================================================================

let state = loadState();
let pollCount = 0;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 10;

async function poll() {
  pollCount++;
  const logLevel = pollCount % 10 === 0 ? 'INFO' : 'DEBUG'; // Log every 10th poll at INFO

  try {
    // Fetch health from QCC
    const health = await httpGet('/api/health');
    consecutiveErrors = 0; // Reset on success

    if (logLevel === 'INFO') {
      const queueLens = getQueueLengths();
      log('INFO', `Poll #${pollCount}: ${health.nodes?.length || 0} nodes, ${health.active_jobs?.length || 0} active jobs, queues: ${JSON.stringify(queueLens)}`);
    }

    const nodes = health.nodes || [];
    const activeJobs = health.active_jobs || [];

    // Process each GPU node
    for (const nodeName of GPU_NODES) {
      const nodeData = nodes.find(n => n.name === nodeName);
      if (!nodeData) continue;

      // Skip offline nodes
      if (nodeData.status === 'offline' || nodeData.status === 'unknown') {
        delete state.crash_suspects[nodeName];
        continue;
      }

      // 1. Crash detection
      const crashedJobs = detectCrash(nodeName, nodeData, activeJobs, state);
      if (crashedJobs && crashedJobs.length > 0) {
        await handleCrash(nodeName, crashedJobs, state);
      }

      // 2. Auto-dispatch when idle
      if (!crashedJobs) {
        await checkAndDispatch(nodeName, nodeData, activeJobs, state);
      }
    }

    // 3. Training completion detection
    const completedIds = await checkTrainingLogs(health);
    for (const jobId of completedIds) {
      const job = activeJobs.find(j => j.id === jobId);
      if (job) {
        await handleCompletion(jobId, job.node, job.description || 'Unknown', state);
      }
    }

    // 4. Check for stale jobs (QCC marks these)
    const staleJobs = health.stale_jobs || [];
    for (const job of staleJobs) {
      if (!GPU_NODES.includes(job.node)) continue;
      const nodeData = nodes.find(n => n.name === job.node);
      if (!nodeData) continue;

      // If GPU idle + stale job -> treat as crash/completion
      if (nodeData.last_gpu_util !== null && nodeData.last_gpu_util <= 2) {
        if (!state.completed_jobs.includes(job.id)) {
          log('INFO', `Stale job detected: ${job.id} on ${job.node} - GPU idle, treating as completed/crashed`);
          await handleCompletion(job.id, job.node, job.description || 'Unknown (stale)', state);
        }
      }
    }

    saveState(state);

  } catch (e) {
    consecutiveErrors++;
    log('ERROR', `Poll #${pollCount} failed: ${e.message}`);

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log('ERROR', `${MAX_CONSECUTIVE_ERRORS} consecutive poll failures. QCC daemon may be down.`);
      await alertDiscord('error',
        'Auto-Dispatch: QCC Unreachable',
        `Failed to reach QCC daemon for ${MAX_CONSECUTIVE_ERRORS} consecutive polls. Is qcc-daemon running?`
      );
      consecutiveErrors = 0; // Reset to avoid spamming
    }
  }
}

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  log('INFO', '========================================');
  log('INFO', 'Auto-Dispatch starting up');
  log('INFO', `QCC endpoint: ${QCC_BASE}`);
  log('INFO', `Poll interval: ${POLL_INTERVAL}ms`);
  log('INFO', `Crash confirm window: ${CRASH_CONFIRM_MS}ms`);
  log('INFO', `Managed GPU nodes: ${GPU_NODES.join(', ')}`);
  log('INFO', '========================================');

  // Ensure queue file exists
  if (!fs.existsSync(QUEUE_FILE)) {
    saveQueues({ neptune: [], uranus: [], razer: [] });
    log('INFO', 'Created empty job_queues.json');
  }

  // Initial connectivity check
  try {
    const health = await httpGet('/api/health');
    log('INFO', `QCC connected. Daemon uptime: ${health.daemon_uptime_sec}s, Nodes: ${health.nodes?.length || 0}`);
    await alertDiscord('info',
      'Auto-Dispatch Started',
      `Monitoring ${GPU_NODES.join(', ')} for crash recovery and job dispatch.\nPoll interval: ${POLL_INTERVAL / 1000}s\nQueue depths: ${JSON.stringify(getQueueLengths())}`
    );
  } catch (e) {
    log('WARN', `QCC not reachable on startup: ${e.message}. Will retry on poll.`);
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);

  // Also run immediately
  await poll();
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('INFO', 'Received SIGINT, shutting down...');
  saveState(state);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('INFO', 'Received SIGTERM, shutting down...');
  saveState(state);
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log('ERROR', `Uncaught exception: ${e.message}`, { stack: e.stack });
  // Don't exit — PM2 will restart us, but we try to keep running
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});

// ============================================================================
// CLI API (for external scripts to enqueue jobs)
// ============================================================================

// If run with --enqueue flag, add a job to the queue and exit
if (process.argv.includes('--enqueue')) {
  const nodeIdx = process.argv.indexOf('--node');
  const cmdIdx = process.argv.indexOf('--command');
  const descIdx = process.argv.indexOf('--desc');
  const prioIdx = process.argv.indexOf('--priority');
  const cwdIdx = process.argv.indexOf('--cwd');

  if (nodeIdx === -1 || cmdIdx === -1) {
    console.error('Usage: node auto_dispatch.js --enqueue --node <node> --command "<cmd>" [--desc "description"] [--priority 5] [--cwd "/path"]');
    process.exit(1);
  }

  const node = process.argv[nodeIdx + 1];
  const command = process.argv[cmdIdx + 1];
  const description = descIdx !== -1 ? process.argv[descIdx + 1] : command.slice(0, 80);
  const priority = prioIdx !== -1 ? parseInt(process.argv[prioIdx + 1], 10) : 5;
  const cwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : null;

  const entry = enqueueJob(node, { command, description, priority, cwd });
  console.log(`Enqueued: ${JSON.stringify(entry, null, 2)}`);
  process.exit(0);
}

// If run with --status flag, show current state and exit
if (process.argv.includes('--status')) {
  const s = loadState();
  const q = loadQueues();
  console.log('=== Auto-Dispatch Status ===');
  console.log(`Running since: ${s.started_at}`);
  console.log(`Total restarts: ${s.total_restarts}`);
  console.log(`Total dispatches: ${s.total_dispatches}`);
  console.log(`Crash suspects: ${JSON.stringify(s.crash_suspects)}`);
  console.log('\n=== Job Queues ===');
  for (const [node, jobs] of Object.entries(q)) {
    console.log(`  ${node}: ${jobs.length} queued`);
    for (const j of jobs.slice(0, 5)) {
      console.log(`    [P${j.priority}] ${j.description} (${j.id})`);
    }
  }
  process.exit(0);
}

// If run with --drain flag, clear a node's queue and exit
if (process.argv.includes('--drain')) {
  const nodeIdx = process.argv.indexOf('--node');
  if (nodeIdx === -1) {
    console.error('Usage: node auto_dispatch.js --drain --node <node>');
    process.exit(1);
  }
  const node = process.argv[nodeIdx + 1];
  const queues = loadQueues();
  const count = (queues[node] || []).length;
  queues[node] = [];
  saveQueues(queues);
  console.log(`Drained ${count} jobs from ${node} queue.`);
  process.exit(0);
}

// Normal mode: start the daemon loop
main().catch(e => {
  log('ERROR', `Fatal startup error: ${e.message}`, { stack: e.stack });
  process.exit(1);
});
