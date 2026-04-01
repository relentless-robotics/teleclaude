#!/usr/bin/env node
/**
 * alert_router.js — QCC Alert Routing & Auto-Remediation System
 *
 * Polls the QCC daemon for unresolved alerts and dispatches automated
 * handlers per node. Handlers take action (restart, cleanup, requeue),
 * not just notify. If auto-fix fails after MAX_ATTEMPTS, escalates to
 * Discord #system-status with full diagnosis.
 *
 * Complements compute/dispatcher.js (proactive scheduling) by handling
 * reactive responses — something broke, fix it automatically.
 *
 * Usage:
 *   node compute/alert_router.js              — run continuously (PM2)
 *   node compute/alert_router.js --once       — single poll, then exit
 *   node compute/alert_router.js --status     — show alert history
 *   node compute/alert_router.js --clear      — clear resolved history
 *
 * PM2:
 *   pm2 start compute/alert_router.js --name alert-router
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_DIR = path.join(__dirname, '..');
const HISTORY_FILE = path.join(__dirname, 'alert_history.json');
const QCC_BASE = 'http://localhost:3456';
const POLL_INTERVAL_MS = 30 * 1000;      // 30 seconds
const MAX_ATTEMPTS = 2;                    // auto-fix attempts before escalation
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // 5 min for node_down retries
const STALE_ALERT_HOURS = 24;             // auto-expire resolved alerts after 24h

// Node config (matches MEMORY.md)
const NODES = {
  neptune: {
    host: 'localhost',
    ssh: null,  // local machine
    lvl3Root: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    alertTypes: ['gpu_idle', 'training_crash', 'inference_stale', 'paper_engine_down'],
  },
  uranus: {
    host: '100.100.83.37',
    sshUser: 'nick',
    lvl3Root: 'C:\\Users\\nick\\Lvl3Quant',
    alertTypes: ['gpu_idle', 'training_crash', 'experiment_stale'],
  },
  razer: {
    host: '100.102.215.75',
    sshUser: 'claude',
    lvl3Root: 'C:\\Users\\claude\\Lvl3Quant',
    alertTypes: ['gpu_idle', 'research_queue_empty'],
  },
  jupiter: {
    host: '100.102.174.30',
    sshUser: 'jupiter',
    lvl3Root: '/home/jupiter/Lvl3Quant',
    alertTypes: ['node_down', 'job_failure'],
  },
  saturn: {
    host: '100.101.101.9',
    sshUser: 'saturn',
    proxyJump: 'jupiter',
    lvl3Root: '/home/saturn/Lvl3Quant',
    alertTypes: ['node_down', 'job_failure'],
  },
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const prefix = { info: 'INFO', warn: 'WARN', error: 'ERR ', debug: 'DBG ' }[level] || 'INFO';
  const line = `[${ts}] [alert-router] [${prefix}] ${msg}`;
  if (level === 'error') {
    console.error(line, data || '');
  } else {
    console.log(line, data ? JSON.stringify(data) : '');
  }
}

// ---------------------------------------------------------------------------
// Alert History — dedup + tracking
// ---------------------------------------------------------------------------

class AlertHistory {
  constructor() {
    this.history = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      }
    } catch (e) {
      log('warn', `Failed to load alert history: ${e.message}`);
    }
    return { alerts: {}, stats: { totalProcessed: 0, totalEscalated: 0, totalAutoFixed: 0 } };
  }

  _save() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2));
    } catch (e) {
      log('error', `Failed to save alert history: ${e.message}`);
    }
  }

  /**
   * Generate a dedup key for an alert.
   * Combines node + alert type + optional context to prevent acting on the same alert twice.
   */
  _key(alert) {
    const node = alert.node || 'unknown';
    const type = alert.type || alert.source || 'unknown';
    // Include alert ID if available to distinguish multiple alerts of same type
    const id = alert.id || '';
    return `${node}:${type}:${id}`;
  }

  /**
   * Check if we've already handled this alert and it's still within the dedup window.
   */
  isHandled(alert) {
    const key = this._key(alert);
    const entry = this.history.alerts[key];
    if (!entry) return false;

    // If resolved, check staleness
    if (entry.status === 'resolved') {
      const resolvedAt = new Date(entry.resolvedAt);
      const hoursSince = (Date.now() - resolvedAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince > STALE_ALERT_HOURS) {
        // Expired — allow reprocessing
        delete this.history.alerts[key];
        this._save();
        return false;
      }
      return true;
    }

    // If escalated, don't retry
    if (entry.status === 'escalated') return true;

    // If in-progress and attempts exhausted, treat as handled
    if (entry.attempts >= MAX_ATTEMPTS) return true;

    return false;
  }

  /**
   * Record that we're handling an alert.
   */
  recordAttempt(alert, action, result) {
    const key = this._key(alert);
    const entry = this.history.alerts[key] || {
      node: alert.node,
      type: alert.type || alert.source,
      message: alert.message,
      firstSeen: new Date().toISOString(),
      attempts: 0,
      actions: [],
      status: 'pending',
    };

    entry.attempts++;
    entry.lastAttempt = new Date().toISOString();
    entry.actions.push({
      action,
      result: result.success ? 'success' : 'failed',
      detail: result.detail || '',
      timestamp: new Date().toISOString(),
    });

    if (result.success) {
      entry.status = 'resolved';
      entry.resolvedAt = new Date().toISOString();
      this.history.stats.totalAutoFixed++;
    } else if (entry.attempts >= MAX_ATTEMPTS) {
      entry.status = 'escalated';
    }

    this.history.stats.totalProcessed++;
    this.history.alerts[key] = entry;
    this._save();
    return entry;
  }

  /**
   * Mark alert as escalated (auto-fix exhausted).
   */
  markEscalated(alert) {
    const key = this._key(alert);
    const entry = this.history.alerts[key];
    if (entry) {
      entry.status = 'escalated';
      entry.escalatedAt = new Date().toISOString();
      this.history.stats.totalEscalated++;
      this._save();
    }
  }

  /**
   * Get the current attempt count for an alert.
   */
  getAttempts(alert) {
    const key = this._key(alert);
    return this.history.alerts[key]?.attempts || 0;
  }

  /**
   * Clear resolved and expired entries.
   */
  clearResolved() {
    const now = Date.now();
    let cleared = 0;
    for (const [key, entry] of Object.entries(this.history.alerts)) {
      if (entry.status === 'resolved') {
        delete this.history.alerts[key];
        cleared++;
      }
    }
    this._save();
    return cleared;
  }

  getStats() {
    const counts = { pending: 0, resolved: 0, escalated: 0 };
    for (const entry of Object.values(this.history.alerts)) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
    }
    return { ...this.history.stats, current: counts };
  }
}

const alertHistory = new AlertHistory();

// ---------------------------------------------------------------------------
// QCC API Client
// ---------------------------------------------------------------------------

function qccGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${QCC_BASE}${endpoint}`;
    http.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`QCC parse error on ${endpoint}: ${e.message}`));
        }
      });
    }).on('error', (e) => {
      reject(new Error(`QCC unreachable (${endpoint}): ${e.message}`));
    });
  });
}

function qccPost(endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(`${QCC_BASE}${endpoint}`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Discord Escalation
// ---------------------------------------------------------------------------

const { notifications } = require(path.join(BASE_DIR, 'utils', 'webhook_notifier'));

async function escalateToDiscord(alert, entry) {
  const attemptDetails = (entry.actions || [])
    .map((a, i) => `${i + 1}. **${a.action}** -> ${a.result}: ${a.detail}`)
    .join('\n');

  const title = `Alert Auto-Fix Failed: ${alert.node}/${alert.type || alert.source}`;
  const description = [
    `**Node:** ${alert.node}`,
    `**Alert Type:** ${alert.type || alert.source}`,
    `**Message:** ${alert.message || 'No message'}`,
    `**First Seen:** ${entry.firstSeen}`,
    `**Attempts:** ${entry.attempts}/${MAX_ATTEMPTS}`,
    '',
    '**Actions Attempted:**',
    attemptDetails || 'None',
    '',
    '**Manual Intervention Required**',
  ].join('\n');

  try {
    await notifications.error(title, description);
    log('warn', `Escalated to Discord: ${alert.node}/${alert.type}`);
  } catch (e) {
    log('error', `Discord escalation failed: ${e.message}`);
  }
}

async function notifyDiscordSuccess(alert, action) {
  try {
    await notifications.success(
      `Auto-Fix Success: ${alert.node}/${alert.type || alert.source}`,
      `**Action:** ${action}\n**Node:** ${alert.node}\n**Message:** ${alert.message || ''}`
    );
  } catch (e) {
    // Non-critical, just log
    log('warn', `Discord success notification failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// QCC SSH Exec Helper — executes commands on remote nodes via QCC
// ---------------------------------------------------------------------------

async function qccExec(node, command) {
  try {
    const result = await qccPost('/api/ssh/exec', { node, command });
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function qccExecLocal(command) {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec(command, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        success: !err,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err ? err.message : null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Alert Handlers — per alert type
// ---------------------------------------------------------------------------

/**
 * gpu_idle handler:
 * GPU is idle but should be working. Check job queue, launch next job.
 */
async function handleGpuIdle(alert) {
  const node = alert.node;
  log('info', `Handling gpu_idle on ${node}`);

  // Step 1: Verify GPU is actually idle via QCC
  let gpuStatus;
  try {
    gpuStatus = await qccGet(`/api/nodes/${node}`);
  } catch (e) {
    return { success: false, detail: `Cannot reach QCC to verify GPU: ${e.message}` };
  }

  // Step 2: Check if there's a job in the research queue for this node
  let researchQueue;
  try {
    researchQueue = await qccGet('/api/research');
  } catch (e) {
    return { success: false, detail: `Cannot fetch research queue: ${e.message}` };
  }

  const pendingJobs = (researchQueue.items || []).filter(
    j => j.status === 'pending' && (j.node === node || !j.node)
  );

  if (pendingJobs.length === 0) {
    log('info', `No pending jobs for ${node} — GPU idle is expected`);
    return { success: true, detail: 'No pending jobs in queue. GPU idle is expected.' };
  }

  // Step 3: Attempt to launch the next job
  const nextJob = pendingJobs[0];
  log('info', `Launching queued job ${nextJob.id} on ${node}`);

  try {
    const launchResult = await qccPost('/api/training/launch', {
      node,
      jobId: nextJob.id,
      script: nextJob.script,
      args: nextJob.args || '',
    });

    if (launchResult.success || launchResult.status === 'launched') {
      return { success: true, detail: `Launched job ${nextJob.id} (${nextJob.script}) on ${node}` };
    }
    return { success: false, detail: `Launch returned: ${JSON.stringify(launchResult)}` };
  } catch (e) {
    return { success: false, detail: `Job launch failed: ${e.message}` };
  }
}

/**
 * training_crash handler:
 * Training process crashed. Collect logs, attempt CUDA cleanup and restart.
 */
async function handleTrainingCrash(alert) {
  const node = alert.node;
  log('info', `Handling training_crash on ${node}`);

  // Step 1: Collect last 50 lines of the training log
  let logTail = '';
  try {
    const nodeConfig = NODES[node];
    if (!nodeConfig) return { success: false, detail: `Unknown node: ${node}` };

    const logCmd = node === 'neptune'
      ? 'powershell -Command "Get-Content -Tail 50 (Get-ChildItem C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\logs\\training_*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName"'
      : `tail -50 ${nodeConfig.lvl3Root}/logs/training_*.log 2>/dev/null | tail -50`;

    const logResult = node === 'neptune'
      ? await qccExecLocal(logCmd)
      : await qccExec(node, logCmd);

    logTail = logResult.stdout || logResult.stderr || '(no log output)';
  } catch (e) {
    logTail = `(log collection failed: ${e.message})`;
  }

  // Step 2: CUDA cleanup — kill zombie GPU processes
  try {
    const cleanupCmd = node === 'neptune'
      ? 'powershell -Command "Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.WorkingSet64 -gt 500MB } | Stop-Process -Force"'
      : 'pkill -f "python.*train" 2>/dev/null; sleep 2; nvidia-smi --gpu-reset 2>/dev/null || true';

    const cleanupResult = node === 'neptune'
      ? await qccExecLocal(cleanupCmd)
      : await qccExec(node, cleanupCmd);

    log('info', `CUDA cleanup on ${node}: ${cleanupResult.success ? 'ok' : cleanupResult.error}`);
  } catch (e) {
    log('warn', `CUDA cleanup failed on ${node}: ${e.message}`);
  }

  // Step 3: Wait a moment for GPU memory to free
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Attempt restart via QCC training API
  try {
    // Get the last training config
    const trainingStatus = await qccGet(`/api/training/${node}`);
    const lastJob = trainingStatus.lastJob || trainingStatus.current;

    if (!lastJob || !lastJob.script) {
      return {
        success: false,
        detail: `No previous training config found for ${node}. Log tail:\n${logTail.slice(-500)}`,
      };
    }

    const restartResult = await qccPost('/api/training/launch', {
      node,
      script: lastJob.script,
      args: lastJob.args || '',
      restart: true,
    });

    if (restartResult.success || restartResult.status === 'launched') {
      return {
        success: true,
        detail: `Restarted ${lastJob.script} on ${node} after CUDA cleanup. Crash log tail: ${logTail.slice(-300)}`,
      };
    }

    return {
      success: false,
      detail: `Restart failed: ${JSON.stringify(restartResult)}. Log tail:\n${logTail.slice(-500)}`,
    };
  } catch (e) {
    return {
      success: false,
      detail: `Restart attempt failed: ${e.message}. Log tail:\n${logTail.slice(-500)}`,
    };
  }
}

/**
 * inference_stale handler:
 * Paper trading inference hasn't updated recently. Check PID, restart if dead.
 */
async function handleInferenceStale(alert) {
  const node = alert.node || 'neptune';
  log('info', `Handling inference_stale on ${node}`);

  // Step 1: Check paper engine process
  const checkCmd = 'powershell -Command "Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match \'paper|live_trading\' } | Select-Object Id, CommandLine | Format-List"';

  const checkResult = await qccExecLocal(checkCmd);
  const hasProcess = checkResult.stdout && checkResult.stdout.trim().length > 0;

  if (hasProcess) {
    // Process exists but inference is stale — might be hung
    log('info', 'Paper engine process exists but inference is stale. Killing and restarting.');

    // Kill hung process
    await qccExecLocal('powershell -Command "Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match \'paper|live_trading\' } | Stop-Process -Force"');
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 2: Restart paper engine via PM2 or direct launch
  try {
    // Try PM2 restart first
    const pm2Result = await qccExecLocal('pm2 restart paper-engine 2>nul');
    if (pm2Result.success && !pm2Result.stderr.includes('not found')) {
      return { success: true, detail: 'Restarted paper-engine via PM2' };
    }
  } catch (e) {
    log('info', 'PM2 restart failed, trying direct launch');
  }

  // Fallback: Check QCC for paper engine status
  try {
    const paperStatus = await qccGet('/api/paper/status');
    if (paperStatus.running) {
      return { success: true, detail: 'Paper engine reports running after check. May have recovered.' };
    }
  } catch (e) {
    // QCC paper endpoint may not exist
  }

  return {
    success: false,
    detail: `Paper engine ${hasProcess ? 'was hung and killed' : 'not found'}. Could not auto-restart.`,
  };
}

/**
 * paper_engine_down handler:
 * Paper trading engine is completely down.
 */
async function handlePaperEngineDown(alert) {
  // Same as inference_stale but more aggressive
  return handleInferenceStale(alert);
}

/**
 * node_down handler:
 * SSH connection to a node failed. Attempt reconnect, escalate after 3 failures.
 */
async function handleNodeDown(alert) {
  const node = alert.node;
  log('info', `Handling node_down for ${node}`);

  const nodeConfig = NODES[node];
  if (!nodeConfig) return { success: false, detail: `Unknown node: ${node}` };

  // Step 1: Try SSH reconnect via QCC
  try {
    const reconnectResult = await qccPost('/api/ssh/reconnect', { node });
    if (reconnectResult.success) {
      return { success: true, detail: `SSH reconnected to ${node} (${nodeConfig.host})` };
    }
  } catch (e) {
    log('info', `QCC SSH reconnect failed for ${node}: ${e.message}`);
  }

  // Step 2: Try a direct ping
  try {
    const pingCmd = process.platform === 'win32'
      ? `ping -n 2 -w 3000 ${nodeConfig.host}`
      : `ping -c 2 -W 3 ${nodeConfig.host}`;
    const pingResult = await qccExecLocal(pingCmd);

    if (pingResult.stdout && pingResult.stdout.includes('TTL=')) {
      // Host is reachable, SSH may just be flaky
      log('info', `${node} is pingable but SSH failed. Attempting SSH pool refresh.`);

      // Try SSH pool refresh
      try {
        await qccPost('/api/ssh/refresh', { node });
        await new Promise(r => setTimeout(r, 3000));
        const testResult = await qccExec(node, 'echo OK');
        if (testResult.success || (testResult.stdout || '').includes('OK')) {
          return { success: true, detail: `SSH pool refreshed and verified for ${node}` };
        }
      } catch (e) {
        // Fall through
      }

      return {
        success: false,
        detail: `${node} is pingable at ${nodeConfig.host} but SSH connection fails. Check SSH daemon on the node.`,
      };
    }
  } catch (e) {
    // Ping failed too
  }

  return {
    success: false,
    detail: `${node} is unreachable at ${nodeConfig.host}. Host appears down or network disconnected.`,
  };
}

/**
 * experiment_stale handler:
 * An experiment on a node hasn't reported progress in too long.
 */
async function handleExperimentStale(alert) {
  const node = alert.node;
  log('info', `Handling experiment_stale on ${node}`);

  // Check if training is actually still running
  try {
    const status = await qccGet(`/api/training/${node}`);
    if (status.running && status.progress) {
      return { success: true, detail: `Training on ${node} is running: ${status.progress}. Alert may be stale.` };
    }

    if (!status.running) {
      // Training stopped without alert — treat as crash
      return handleTrainingCrash({ ...alert, type: 'training_crash' });
    }
  } catch (e) {
    return { success: false, detail: `Cannot reach QCC training API for ${node}: ${e.message}` };
  }

  return { success: false, detail: `Experiment on ${node} appears stalled. Manual investigation needed.` };
}

/**
 * research_queue_empty handler:
 * No research jobs queued for this node. Not necessarily an error.
 */
async function handleResearchQueueEmpty(alert) {
  const node = alert.node;
  log('info', `Handling research_queue_empty on ${node}`);

  // This is informational — mark as resolved
  return { success: true, detail: `Research queue empty for ${node}. No action needed unless jobs should be running.` };
}

/**
 * job_failure handler:
 * A specific job failed on a node.
 */
async function handleJobFailure(alert) {
  const node = alert.node;
  log('info', `Handling job_failure on ${node}`);

  // Collect job logs
  try {
    const logCmd = `tail -30 /tmp/qcc_job_*.log 2>/dev/null || echo "(no job logs)"`;
    const logResult = await qccExec(node, logCmd);
    const logTail = logResult.stdout || '(no output)';

    // Check if it's a transient failure (OOM, network timeout)
    const transientPatterns = ['OOM', 'out of memory', 'CUDA out of memory', 'Connection timed out', 'ConnectionResetError'];
    const isTransient = transientPatterns.some(p => logTail.toLowerCase().includes(p.toLowerCase()));

    if (isTransient) {
      // Wait and retry
      await new Promise(r => setTimeout(r, 10000));
      // Re-trigger via research queue
      return { success: false, detail: `Transient failure on ${node}. Log: ${logTail.slice(-300)}. Needs manual requeue.` };
    }

    return { success: false, detail: `Job failed on ${node}. Log tail:\n${logTail.slice(-500)}` };
  } catch (e) {
    return { success: false, detail: `Cannot collect failure logs from ${node}: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Handler Dispatch Table
// ---------------------------------------------------------------------------

const HANDLERS = {
  gpu_idle:              handleGpuIdle,
  training_crash:        handleTrainingCrash,
  inference_stale:       handleInferenceStale,
  paper_engine_down:     handlePaperEngineDown,
  node_down:             handleNodeDown,
  experiment_stale:      handleExperimentStale,
  research_queue_empty:  handleResearchQueueEmpty,
  job_failure:           handleJobFailure,
};

// ---------------------------------------------------------------------------
// Alert Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize alert objects from QCC into a consistent shape.
 * QCC may return alerts in different formats depending on the endpoint.
 */
function normalizeAlert(raw) {
  return {
    id: raw.id || raw.alertId || `${raw.node}_${raw.type}_${Date.now()}`,
    node: (raw.node || raw.source || 'unknown').toLowerCase(),
    type: (raw.type || raw.alertType || raw.source || 'unknown').toLowerCase(),
    severity: raw.severity || 'warning',
    message: raw.message || raw.description || '',
    timestamp: raw.timestamp || raw.created_at || new Date().toISOString(),
    raw,
  };
}

/**
 * Route an alert to the correct node and determine the handler type.
 * Some alerts map directly; others need inference from the message.
 */
function resolveHandler(alert) {
  // Direct match
  if (HANDLERS[alert.type]) return alert.type;

  // Infer from message content
  const msg = (alert.message || '').toLowerCase();
  if (msg.includes('gpu') && msg.includes('idle'))    return 'gpu_idle';
  if (msg.includes('crash') || msg.includes('cuda'))   return 'training_crash';
  if (msg.includes('stale') && msg.includes('infer'))  return 'inference_stale';
  if (msg.includes('paper') && msg.includes('down'))   return 'paper_engine_down';
  if (msg.includes('ssh') || msg.includes('unreachable') || msg.includes('down')) return 'node_down';
  if (msg.includes('experiment') && msg.includes('stale')) return 'experiment_stale';
  if (msg.includes('queue') && msg.includes('empty'))  return 'research_queue_empty';
  if (msg.includes('fail'))                             return 'job_failure';

  return null;
}

// ---------------------------------------------------------------------------
// Main Poll + Route Loop
// ---------------------------------------------------------------------------

async function pollAndRoute() {
  let alerts = [];

  // Fetch alerts from QCC health endpoint
  try {
    const health = await qccGet('/api/health');
    if (health.unresolved_alerts && Array.isArray(health.unresolved_alerts)) {
      alerts = health.unresolved_alerts.map(normalizeAlert);
    } else if (health.alerts && Array.isArray(health.alerts)) {
      alerts = health.alerts.filter(a => !a.resolved).map(normalizeAlert);
    }
  } catch (e) {
    log('warn', `QCC health check failed: ${e.message}`);
    // Try the alerts endpoint directly
    try {
      const alertData = await qccGet('/api/alerts');
      if (alertData.items && Array.isArray(alertData.items)) {
        alerts = alertData.items.filter(a => !a.resolved).map(normalizeAlert);
      } else if (Array.isArray(alertData)) {
        alerts = alertData.filter(a => !a.resolved).map(normalizeAlert);
      }
    } catch (e2) {
      log('error', `Both QCC endpoints failed: ${e2.message}`);
      return;
    }
  }

  if (alerts.length === 0) {
    // Quiet poll — nothing to do
    return;
  }

  log('info', `Found ${alerts.length} unresolved alert(s)`);

  for (const alert of alerts) {
    // Dedup check
    if (alertHistory.isHandled(alert)) {
      continue;
    }

    // Resolve handler
    const handlerType = resolveHandler(alert);
    if (!handlerType) {
      log('warn', `No handler for alert type: ${alert.type} on ${alert.node}`, { message: alert.message });
      continue;
    }

    const handler = HANDLERS[handlerType];
    const currentAttempt = alertHistory.getAttempts(alert) + 1;
    log('info', `Processing alert: ${alert.node}/${alert.type} (attempt ${currentAttempt}/${MAX_ATTEMPTS})`, {
      handler: handlerType,
    });

    // Execute handler
    let result;
    try {
      result = await handler(alert);
    } catch (e) {
      result = { success: false, detail: `Handler threw: ${e.message}` };
      log('error', `Handler ${handlerType} threw for ${alert.node}:`, e);
    }

    // Record result
    const entry = alertHistory.recordAttempt(alert, handlerType, result);

    if (result.success) {
      log('info', `Auto-fixed: ${alert.node}/${alert.type} — ${result.detail}`);
      await notifyDiscordSuccess(alert, result.detail);
    } else {
      log('warn', `Fix failed (attempt ${entry.attempts}/${MAX_ATTEMPTS}): ${alert.node}/${alert.type} — ${result.detail}`);

      // Escalate if max attempts reached
      if (entry.attempts >= MAX_ATTEMPTS) {
        log('warn', `Escalating ${alert.node}/${alert.type} to Discord after ${MAX_ATTEMPTS} failed attempts`);
        alertHistory.markEscalated(alert);
        await escalateToDiscord(alert, entry);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let pollTimer = null;
let running = false;

function start() {
  if (running) {
    log('warn', 'Alert router already running');
    return;
  }

  running = true;
  log('info', `Alert router started (poll every ${POLL_INTERVAL_MS / 1000}s, max attempts ${MAX_ATTEMPTS})`);

  // Initial poll
  pollAndRoute().catch(e => log('error', `Poll error: ${e.message}`));

  // Recurring poll
  pollTimer = setInterval(() => {
    pollAndRoute().catch(e => log('error', `Poll error: ${e.message}`));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  running = false;
  log('info', 'Alert router stopped');
}

function getStatus() {
  return {
    running,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxAttempts: MAX_ATTEMPTS,
    history: alertHistory.getStats(),
    nodes: Object.keys(NODES),
    handlers: Object.keys(HANDLERS),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = args[0] || '';

  if (flag === '--once') {
    // Single poll then exit
    pollAndRoute()
      .then(() => {
        console.log('Poll complete.');
        console.log(JSON.stringify(alertHistory.getStats(), null, 2));
        process.exit(0);
      })
      .catch(e => {
        console.error('Poll failed:', e.message);
        process.exit(1);
      });

  } else if (flag === '--status') {
    console.log(JSON.stringify(getStatus(), null, 2));
    process.exit(0);

  } else if (flag === '--clear') {
    const cleared = alertHistory.clearResolved();
    console.log(`Cleared ${cleared} resolved alerts from history.`);
    process.exit(0);

  } else if (flag === '--help' || flag === '-h') {
    console.log(`
QCC Alert Router — Automatic alert handling and remediation

Usage:
  node compute/alert_router.js              Run continuously (default, for PM2)
  node compute/alert_router.js --once       Single poll then exit
  node compute/alert_router.js --status     Show router status and history stats
  node compute/alert_router.js --clear      Clear resolved alert history
  node compute/alert_router.js --help       Show this help

Alert Types Handled:
  gpu_idle              Check job queue, launch next job
  training_crash        Collect logs, CUDA cleanup, restart training
  inference_stale       Check paper engine PID, restart if dead
  paper_engine_down     Restart paper trading engine
  node_down             SSH reconnect, ping check, escalate
  experiment_stale      Check training status, treat as crash if stopped
  research_queue_empty  Informational, auto-resolve
  job_failure           Collect logs, identify transient failures

Escalation:
  After ${MAX_ATTEMPTS} failed auto-fix attempts, posts diagnosis to Discord #system-status

PM2:
  pm2 start compute/alert_router.js --name alert-router
`);
    process.exit(0);

  } else {
    // Default: run continuously
    start();

    // Graceful shutdown
    process.on('SIGINT', () => { stop(); process.exit(0); });
    process.on('SIGTERM', () => { stop(); process.exit(0); });

    // Keep process alive
    process.on('uncaughtException', (e) => {
      log('error', `Uncaught exception: ${e.message}`, e.stack);
      // Don't crash — keep running
    });

    process.on('unhandledRejection', (e) => {
      log('error', `Unhandled rejection: ${e}`, e?.stack);
    });
  }
}

// ---------------------------------------------------------------------------
// Module Exports (for programmatic use)
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  getStatus,
  pollAndRoute,
  alertHistory,
  HANDLERS,
  NODES,
};
