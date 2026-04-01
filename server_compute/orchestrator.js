/**
 * orchestrator.js — Main Orchestration Module for Lvl3Quant Remote Compute
 *
 * High-level API that ties together deploy, sync, job running, and monitoring.
 * This is the primary interface for the trading agents and CLI to use.
 *
 * Usage:
 *   const orchestrator = require('./server_compute/orchestrator');
 *
 *   // One-time setup
 *   await orchestrator.deploy();
 *
 *   // Sync and launch
 *   await orchestrator.syncCode();
 *   const job = await orchestrator.launchScan({ horizon: 'ret_10s', targetType: 'mfe_net', nDays: 70 });
 *
 *   // Monitor
 *   const status = await orchestrator.getStatus();
 *   const progress = await orchestrator.getJobProgress(job.id);
 *
 *   // Results
 *   await orchestrator.pullResults(job.id);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getConnection, loadConfig, closeAllConnections } = require('../utils/ssh_manager');
const { execRemote, ensureRemoteDir, syncCodebase, syncFeatureCache, syncResults, getSyncStatus } = require('./sync');
const { launchJob, checkJob, getJobLog, killJob, listJobs, getJobProgress: runnerGetProgress, generateJobId } = require('./runner');
const { getServerStatus, getHeartbeat, getDashboard, formatDashboard, getActiveJobs } = require('./monitor');

const DEFAULT_SERVER = 'jupiter';
const REMOTE_BASE = '~/lvl3quant';

// =============================================================================
// Connection Health Check
// =============================================================================

/**
 * Test connection to the server. Returns { connected, server, latencyMs } or error.
 */
async function testConnection(serverName = DEFAULT_SERVER) {
  const start = Date.now();
  try {
    const conn = await getConnection(serverName);
    const result = await execRemote(conn, 'echo ok && hostname && uptime -p');
    const latencyMs = Date.now() - start;

    if (result.stdout.includes('ok')) {
      const lines = result.stdout.split('\n');
      return {
        connected: true,
        server: serverName,
        hostname: lines[1]?.trim() || 'unknown',
        uptime: lines[2]?.trim() || 'unknown',
        latencyMs,
      };
    }
    return { connected: false, server: serverName, error: 'Unexpected response', latencyMs };
  } catch (err) {
    return {
      connected: false,
      server: serverName,
      error: err.message,
      hint: err.message.includes('ECONNREFUSED') || err.message.includes('connect')
        ? 'SSH is blocked or server is down. Reset password on server console first.'
        : null,
    };
  }
}

// =============================================================================
// Deploy
// =============================================================================

/**
 * Run the deploy.sh bootstrap script on the server.
 * Uploads the script first, then executes it.
 *
 * @param {object} opts - { serverName, minimal, force, onOutput }
 * @returns {Promise<{success, output, exitCode}>}
 */
async function deploy(opts = {}) {
  const { serverName = DEFAULT_SERVER, minimal = false, force = false, onOutput } = opts;

  console.log(`[orchestrator] Deploying to ${serverName}...`);

  const conn = await getConnection(serverName);
  const localScript = path.join(__dirname, 'deploy.sh');

  if (!fs.existsSync(localScript)) {
    return { success: false, error: `deploy.sh not found at ${localScript}` };
  }

  // Upload deploy script
  const remoteScript = '/tmp/lvl3quant_deploy.sh';
  console.log('[orchestrator] Uploading deploy.sh...');

  await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const readStream = fs.createReadStream(localScript);
      const writeStream = sftp.createWriteStream(remoteScript);
      writeStream.on('close', resolve);
      writeStream.on('error', reject);
      readStream.pipe(writeStream);
    });
  });

  // Make executable
  await execRemote(conn, `chmod +x ${remoteScript}`);

  // Build args
  const args = [];
  if (minimal) args.push('--minimal');
  if (force) args.push('--force');

  console.log('[orchestrator] Running deploy.sh on server (this may take 10-15 minutes)...');

  // Execute with streaming output
  return new Promise((resolve, reject) => {
    const cmd = `bash ${remoteScript} ${args.join(' ')} 2>&1`;

    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);

      let output = '';
      stream.on('data', data => {
        const str = data.toString();
        output += str;
        if (onOutput) onOutput(str);
        else process.stdout.write(str);
      });
      stream.stderr.on('data', data => {
        const str = data.toString();
        output += str;
        if (onOutput) onOutput(str);
      });
      stream.on('close', code => {
        resolve({
          success: code === 0,
          exitCode: code,
          output,
          server: serverName,
        });
      });
    });
  });
}

// =============================================================================
// Sync Operations
// =============================================================================

/**
 * Sync the alpha_discovery codebase to the server.
 */
async function syncCode(opts = {}) {
  const { serverName = DEFAULT_SERVER, onProgress, force = false } = opts;
  console.log(`[orchestrator] Syncing codebase to ${serverName}...`);

  const result = await syncCodebase({ serverName, onProgress, forceOverwrite: force });
  if (result.success) {
    console.log(`[orchestrator] Code sync done: ${result.files} files, ${result.skipped} skipped, ${result.errors.length} errors`);
  } else {
    console.error(`[orchestrator] Code sync failed: ${result.error}`);
  }
  return result;
}

/**
 * Sync feature cache NPZ files to the server.
 */
async function syncData(opts = {}) {
  const { serverName = DEFAULT_SERVER, onProgress, batchSize = 5, force = false } = opts;
  console.log(`[orchestrator] Syncing feature cache to ${serverName}...`);

  const result = await syncFeatureCache({ serverName, onProgress, batchSize, forceOverwrite: force });
  if (result.success) {
    console.log(`[orchestrator] Data sync done: ${result.files} uploaded, ${result.skipped} skipped, ${result.bytesGB}GB transferred`);
  }
  return result;
}

// =============================================================================
// Job Launching
// =============================================================================

/**
 * Launch a Lvl3Quant scan job on the server.
 *
 * @param {object} scanConfig
 * @param {string} scanConfig.horizon        - Target horizon: 'ret_10s', 'ret_30s', 'ret_1m', etc.
 * @param {string} [scanConfig.targetType]   - Target type: 'mfe_net', 'ret', etc.
 * @param {number} [scanConfig.nDays]        - Number of days of data to use
 * @param {boolean} [scanConfig.noExecution] - If true, skip live execution (dry run)
 * @param {string} [scanConfig.script]       - Custom script path (default: alpha_discovery/scan.py)
 * @param {string[]} [scanConfig.extraArgs]  - Additional CLI args
 * @param {string} [scanConfig.serverName]
 * @param {string} [scanConfig.jobName]
 *
 * @returns {Promise<{id, jobId, sessionName, logFile, startedAt, scanConfig}>}
 */
async function launchScan(scanConfig) {
  const {
    horizon = 'ret_10s',
    targetType = 'mfe_net',
    nDays = 70,
    noExecution = true,
    script = `${REMOTE_BASE}/alpha_discovery/scan.py`,
    extraArgs = [],
    serverName = DEFAULT_SERVER,
    jobName,
  } = scanConfig;

  const args = [
    '--horizon', horizon,
    '--target-type', targetType,
    '--n-days', String(nDays),
  ];

  if (noExecution) args.push('--no-execution');
  args.push(...extraArgs);

  const name = jobName || `scan_${horizon}_${targetType}_${nDays}d`;

  console.log(`[orchestrator] Launching scan: ${name} on ${serverName}`);
  console.log(`[orchestrator] Script: ${script}`);
  console.log(`[orchestrator] Args: ${args.join(' ')}`);

  const job = await launchJob({
    script,
    args,
    workingDir: REMOTE_BASE,
    serverName,
    name,
    env: {
      LVL3QUANT_DATA_DIR: `${REMOTE_BASE}/data`,
      LVL3QUANT_RESULTS_DIR: `${REMOTE_BASE}/results`,
    },
  });

  return {
    id: job.jobId,
    ...job,
    scanConfig,
  };
}

/**
 * Launch a custom Python script on the server.
 *
 * @param {object} config
 * @param {string} config.script - Path to Python script (remote)
 * @param {string[]} [config.args]
 * @param {object} [config.env]
 * @param {string} [config.workingDir]
 * @param {string} [config.serverName]
 * @param {string} [config.name]
 */
async function launchScript(config) {
  const {
    script,
    args = [],
    env = {},
    workingDir = REMOTE_BASE,
    serverName = DEFAULT_SERVER,
    name,
  } = config;

  console.log(`[orchestrator] Launching script: ${script}`);

  const job = await launchJob({ script, args, env, workingDir, serverName, name });
  return { id: job.jobId, ...job };
}

// =============================================================================
// Monitoring
// =============================================================================

/**
 * Get full server status including health metrics and active jobs.
 *
 * @param {string} serverName
 * @returns {Promise<object>} - Complete dashboard data
 */
async function getStatus(serverName = DEFAULT_SERVER) {
  const dashboard = await getDashboard(serverName);
  return dashboard;
}

/**
 * Get progress for a specific job.
 *
 * @param {string} jobId
 * @param {string} serverName
 * @returns {Promise<object>}
 */
async function getJobProgressStatus(jobId, serverName = DEFAULT_SERVER) {
  const [jobStatus, progress] = await Promise.all([
    checkJob(jobId, serverName),
    runnerGetProgress(jobId, serverName),
  ]);

  return {
    jobId,
    running: jobStatus.running,
    status: jobStatus.status,
    exitCode: jobStatus.exitCode,
    elapsed: jobStatus.elapsedHuman,
    progress: progress.pct ? `${progress.pct}%` : (progress.current ? `step ${progress.current}` : 'unknown'),
    progressDetail: progress,
    recentLog: progress.recentLines?.slice(-3) || [],
    server: serverName,
  };
}

/**
 * Wait for a job to complete, polling at intervals.
 *
 * @param {string} jobId
 * @param {object} opts - { serverName, pollIntervalMs, timeoutMs, onPoll }
 * @returns {Promise<{jobId, status, exitCode, elapsed}>}
 */
async function waitForJob(jobId, opts = {}) {
  const {
    serverName = DEFAULT_SERVER,
    pollIntervalMs = 30000,
    timeoutMs = 24 * 3600 * 1000, // 24 hours
    onPoll,
  } = opts;

  const startTime = Date.now();

  while (true) {
    const status = await checkJob(jobId, serverName);

    if (onPoll) await onPoll(status);

    if (!status.running && status.status !== 'running') {
      return status;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      return {
        jobId,
        status: 'timeout',
        error: `Job did not complete within ${timeoutMs / 1000}s`,
        lastStatus: status,
      };
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}

// =============================================================================
// Results
// =============================================================================

/**
 * Pull results for a job back to the local machine.
 *
 * @param {string} jobId
 * @param {string} [localDest] - Local path to save results
 * @param {object} [opts]
 * @returns {Promise<object>} - Sync result
 */
async function pullResults(jobId, localDest = null, opts = {}) {
  const { serverName = DEFAULT_SERVER } = opts;

  console.log(`[orchestrator] Pulling results for job ${jobId}...`);

  const result = await syncResults(jobId, localDest, { serverName });
  if (result.success) {
    console.log(`[orchestrator] Results pulled: ${result.files || 0} files to ${localDest || 'default'}`);
  } else {
    console.error(`[orchestrator] Results pull failed: ${result.error}`);
  }
  return result;
}

/**
 * Pull all results from the server.
 */
async function pullAllResults(localDest = null, opts = {}) {
  return syncResults(null, localDest, opts);
}

// =============================================================================
// Job Management
// =============================================================================

/**
 * List all running jobs on the server.
 */
async function listActiveJobs(serverName = DEFAULT_SERVER) {
  return listJobs(serverName);
}

/**
 * Get the log for a job.
 */
async function getLog(jobId, lines = 50, serverName = DEFAULT_SERVER) {
  return getJobLog(jobId, lines, serverName);
}

/**
 * Kill a running job.
 */
async function kill(jobId, serverName = DEFAULT_SERVER) {
  return killJob(jobId, serverName);
}

// =============================================================================
// Full Workflow Shortcuts
// =============================================================================

/**
 * Full workflow: sync code + data, launch scan, return job info.
 * Does NOT wait for completion — returns job handle immediately.
 *
 * @param {object} scanConfig - Same as launchScan
 * @param {object} opts - { syncCode: true, syncData: false, serverName }
 */
async function runScan(scanConfig, opts = {}) {
  const {
    syncCode: doSyncCode = true,
    syncData: doSyncData = false,
    serverName = DEFAULT_SERVER,
  } = opts;

  // 1. Test connection first
  const connTest = await testConnection(serverName);
  if (!connTest.connected) {
    return {
      success: false,
      error: `Cannot connect to ${serverName}: ${connTest.error}`,
      hint: connTest.hint,
    };
  }

  console.log(`[orchestrator] Connection OK (${connTest.latencyMs}ms latency)`);

  // 2. Sync code if requested
  if (doSyncCode) {
    const codeSync = await syncCode({ serverName });
    if (!codeSync.success) {
      return { success: false, error: `Code sync failed: ${codeSync.error}`, step: 'syncCode' };
    }
  }

  // 3. Sync data if requested (this can be slow!)
  if (doSyncData) {
    const dataSync = await syncData({ serverName });
    if (!dataSync.success) {
      console.warn(`[orchestrator] Data sync had issues: ${dataSync.error || 'check errors array'}`);
    }
  }

  // 4. Launch the scan
  const job = await launchScan({ ...scanConfig, serverName });

  return {
    success: true,
    job,
    id: job.id,
    server: serverName,
    message: `Scan ${job.name} launched as job ${job.id}. Log: ${job.logFile}`,
  };
}

/**
 * Get a summary string for Discord/logging.
 */
async function getStatusSummary(serverName = DEFAULT_SERVER) {
  const dashboard = await getDashboard(serverName);
  return formatDashboard(dashboard);
}

// =============================================================================
// Cleanup
// =============================================================================

/**
 * Close all SSH connections cleanly.
 */
function disconnect() {
  closeAllConnections();
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Connection
  testConnection,

  // Setup
  deploy,

  // Sync
  syncCode,
  syncData,
  getSyncStatus,

  // Jobs
  launchScan,
  launchScript,
  listActiveJobs,
  getLog,
  kill,
  waitForJob,

  // Monitoring
  getStatus,
  getJobProgressStatus,
  getStatusSummary,

  // Results
  pullResults,
  pullAllResults,

  // High-level workflows
  runScan,

  // Cleanup
  disconnect,
};
