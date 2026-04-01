/**
 * runner.js — Remote Job Runner for Lvl3Quant
 *
 * Launches Python jobs on the Jupiter server inside tmux sessions so they
 * survive SSH disconnection. Each job gets a unique ID, log file, and
 * metadata record for tracking.
 *
 * All jobs run in: ~/lvl3quant/logs/job_<id>.log
 * Job metadata:    ~/lvl3quant/logs/job_<id>.meta
 *
 * Usage:
 *   const runner = require('./server_compute/runner');
 *   const job = await runner.launchJob({ script: '~/lvl3quant/alpha_discovery/scan.py', args: ['--horizon', 'ret_10s'] });
 *   const status = await runner.checkJob(job.jobId);
 *   const log = await runner.getJobLog(job.jobId, 50);
 *   await runner.killJob(job.jobId);
 */

'use strict';

const { getConnection, loadConfig } = require('../utils/ssh_manager');
const { execRemote } = require('./sync');
const crypto = require('crypto');

const DEFAULT_SERVER = 'jupiter';
const REMOTE_BASE = '~/lvl3quant';
const LOGS_BASE = `${REMOTE_BASE}/logs`;
const VENV_ACTIVATE = `source ${REMOTE_BASE}/venv/bin/activate`;

// =============================================================================
// Job ID Generation
// =============================================================================

/**
 * Generate a short unique job ID.
 * Format: <timestamp_base36>_<4hex>
 * Example: lzk4p_a3f2
 */
function generateJobId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString('hex');
  return `${ts}_${rand}`;
}

// =============================================================================
// tmux Helpers
// =============================================================================

/**
 * Check if a tmux session exists on the remote server.
 */
async function tmuxSessionExists(conn, sessionName) {
  const result = await execRemote(conn, `tmux has-session -t "${sessionName}" 2>/dev/null && echo YES || echo NO`);
  return result.stdout.trim() === 'YES';
}

/**
 * Kill a tmux session by name.
 */
async function tmuxKillSession(conn, sessionName) {
  return execRemote(conn, `tmux kill-session -t "${sessionName}" 2>/dev/null; echo done`);
}

/**
 * List all tmux sessions (returns array of {name, windows, created}).
 */
async function tmuxListSessions(conn) {
  const result = await execRemote(conn,
    `tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_created}" 2>/dev/null || echo "NO_SESSIONS"`
  );

  if (!result.stdout || result.stdout.includes('NO_SESSIONS')) return [];

  return result.stdout.trim().split('\n')
    .filter(line => line.trim())
    .map(line => {
      const [name, windows, created] = line.split('|');
      return { name, windows: parseInt(windows), created: new Date(parseInt(created) * 1000).toISOString() };
    });
}

// =============================================================================
// Job Metadata
// =============================================================================

/**
 * Write job metadata to a JSON file on the remote server.
 */
async function writeJobMeta(conn, jobId, meta) {
  const metaPath = `${LOGS_BASE}/job_${jobId}.meta`;
  const json = JSON.stringify(meta, null, 2).replace(/"/g, '\\"').replace(/\n/g, '\\n');
  // Use Python to write the JSON (more reliable than bash escaping)
  const cmd = `python3 -c "import json; open('${metaPath}', 'w').write(json.dumps(${JSON.stringify(meta)}, indent=2))"`;
  await execRemote(conn, cmd);
  return metaPath;
}

/**
 * Read job metadata from the remote server.
 */
async function readJobMeta(conn, jobId) {
  const metaPath = `${LOGS_BASE}/job_${jobId}.meta`;
  const result = await execRemote(conn, `cat "${metaPath}" 2>/dev/null || echo "NOT_FOUND"`);
  if (result.stdout === 'NOT_FOUND' || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return null;
  }
}

/**
 * List all job metadata files on the server.
 */
async function listJobMetas(conn) {
  const result = await execRemote(conn,
    `ls ${LOGS_BASE}/job_*.meta 2>/dev/null | xargs -I{} cat {} | python3 -c "import sys,json; data=[]; [data.append(json.loads(l)) for block in ''.join(sys.stdin).split('}{') for l in ([block] if block.startswith('{') else ['{'+block]) if l.strip()] ; print(json.dumps(data))" 2>/dev/null || echo "[]"`
  );

  // Better approach: list files and cat each one
  const filesResult = await execRemote(conn, `ls ${LOGS_BASE}/job_*.meta 2>/dev/null || echo ""`);
  if (!filesResult.stdout.trim()) return [];

  const metaFiles = filesResult.stdout.trim().split('\n').filter(f => f.trim());
  const metas = [];

  for (const f of metaFiles) {
    const catResult = await execRemote(conn, `cat "${f}" 2>/dev/null`);
    if (catResult.stdout.trim()) {
      try {
        metas.push(JSON.parse(catResult.stdout));
      } catch (e) {
        // Skip malformed meta files
      }
    }
  }

  return metas;
}

// =============================================================================
// Core Job Management
// =============================================================================

/**
 * Launch a Python job on the remote server in a tmux session.
 *
 * @param {object} config
 * @param {string} config.script - Path to Python script (remote path, or ~/relative)
 * @param {string[]} [config.args] - CLI arguments to pass to script
 * @param {string} [config.workingDir] - Working directory on server (default: ~/lvl3quant)
 * @param {object} [config.env] - Extra environment variables
 * @param {string} [config.serverName] - Server to use (default: jupiter-desktop)
 * @param {string} [config.jobId] - Custom job ID (auto-generated if not provided)
 * @param {string} [config.name] - Human-readable name for the job
 *
 * @returns {Promise<{jobId, sessionName, logFile, metaFile, pid, server}>}
 */
async function launchJob(config) {
  const {
    script,
    args = [],
    workingDir = REMOTE_BASE,
    env = {},
    serverName = DEFAULT_SERVER,
    jobId = generateJobId(),
    name = `job_${jobId}`,
  } = config;

  if (!script) throw new Error('script is required');

  const conn = await getConnection(serverName);

  // Ensure logs directory exists
  await execRemote(conn, `mkdir -p ${LOGS_BASE}`);

  const sessionName = `lvl3_${jobId}`;
  const logFile = `${LOGS_BASE}/job_${jobId}.log`;

  // Build env export commands
  const envExports = Object.entries({
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: `${REMOTE_BASE}:$PYTHONPATH`,
    LVL3QUANT_HOME: REMOTE_BASE,
    ...env,
  }).map(([k, v]) => `export ${k}="${v}"`).join(' && ');

  // Build the full command string for tmux
  const argsStr = args.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
  const innerCmd = [
    VENV_ACTIVATE,
    envExports,
    `cd "${workingDir}"`,
    `python3 "${script}" ${argsStr}`,
  ].join(' && ');

  // Wrap so exit code and finish time are logged
  const fullCmd = `{ ${innerCmd} ; echo "[JOB_DONE:exit=$?:time=$(date -u +%Y-%m-%dT%H:%M:%SZ)]" ; } 2>&1 | tee "${logFile}"`;

  // Launch in tmux
  const tmuxCmd = `tmux new-session -d -s "${sessionName}" bash -c '${fullCmd.replace(/'/g, "'\\''")}'`;
  const launchResult = await execRemote(conn, tmuxCmd);

  if (launchResult.code !== 0 && launchResult.stderr) {
    throw new Error(`Failed to launch tmux session: ${launchResult.stderr}`);
  }

  // Get the PID of the bash process inside tmux
  await new Promise(r => setTimeout(r, 500)); // Small delay for process to start
  const pidResult = await execRemote(conn,
    `tmux list-panes -t "${sessionName}" -F "#{pane_pid}" 2>/dev/null | head -1`
  );
  const tmuxPid = pidResult.stdout.trim() || 'unknown';

  // Write metadata
  const meta = {
    jobId,
    name,
    script,
    args,
    workingDir,
    env,
    sessionName,
    logFile,
    server: serverName,
    pid: tmuxPid,
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  await writeJobMeta(conn, jobId, meta);

  return {
    jobId,
    sessionName,
    logFile,
    metaFile: `${LOGS_BASE}/job_${jobId}.meta`,
    pid: tmuxPid,
    server: serverName,
    name,
    startedAt: meta.startedAt,
  };
}

/**
 * Check if a job is still running.
 * Also detects if job completed successfully or with error.
 *
 * @param {string} jobId
 * @param {string} serverName
 * @returns {Promise<{jobId, running, status, exitCode, lastLine, elapsedSec}>}
 */
async function checkJob(jobId, serverName = DEFAULT_SERVER) {
  const conn = await getConnection(serverName);
  const sessionName = `lvl3_${jobId}`;
  const logFile = `${LOGS_BASE}/job_${jobId}.log`;

  const sessionExists = await tmuxSessionExists(conn, sessionName);

  // Read last line of log to get status
  const tailResult = await execRemote(conn, `tail -1 "${logFile}" 2>/dev/null || echo ""`);
  const lastLine = tailResult.stdout.trim();

  // Parse completion marker
  let exitCode = null;
  let completedAt = null;
  if (lastLine.includes('[JOB_DONE:')) {
    const exitMatch = lastLine.match(/exit=(\d+)/);
    const timeMatch = lastLine.match(/time=([^]]+?)\]/);
    exitCode = exitMatch ? parseInt(exitMatch[1]) : null;
    completedAt = timeMatch ? timeMatch[1] : null;
  }

  // Get elapsed time from meta
  const meta = await readJobMeta(conn, jobId);
  let elapsedSec = null;
  if (meta && meta.startedAt) {
    elapsedSec = Math.floor((Date.now() - new Date(meta.startedAt).getTime()) / 1000);
  }

  // Determine status
  let status;
  if (sessionExists) {
    status = 'running';
  } else if (exitCode === 0) {
    status = 'completed';
  } else if (exitCode !== null) {
    status = 'failed';
  } else if (lastLine.includes('[JOB_DONE:')) {
    status = 'completed'; // Assume completed if marker present
  } else {
    status = 'stopped'; // Session gone but no completion marker
  }

  return {
    jobId,
    running: sessionExists,
    status,
    exitCode,
    completedAt,
    elapsedSec,
    elapsedHuman: elapsedSec ? formatElapsed(elapsedSec) : 'unknown',
    lastLine: lastLine.includes('[JOB_DONE:') ? '(job complete)' : lastLine,
    sessionName,
    server: serverName,
    meta,
  };
}

/**
 * Get the last N lines of a job's log file.
 *
 * @param {string} jobId
 * @param {number} lines - Number of lines to fetch (default: 50)
 * @param {string} serverName
 * @returns {Promise<{jobId, lines: string[], raw: string}>}
 */
async function getJobLog(jobId, lines = 50, serverName = DEFAULT_SERVER) {
  const conn = await getConnection(serverName);
  const logFile = `${LOGS_BASE}/job_${jobId}.log`;

  const result = await execRemote(conn, `tail -n ${lines} "${logFile}" 2>/dev/null || echo "Log not found: ${logFile}"`);

  return {
    jobId,
    logFile,
    raw: result.stdout,
    lines: result.stdout.split('\n').filter(l => l.trim()),
    server: serverName,
  };
}

/**
 * Kill a running job (kill its tmux session).
 *
 * @param {string} jobId
 * @param {string} serverName
 * @returns {Promise<{jobId, killed: boolean, message: string}>}
 */
async function killJob(jobId, serverName = DEFAULT_SERVER) {
  const conn = await getConnection(serverName);
  const sessionName = `lvl3_${jobId}`;

  const exists = await tmuxSessionExists(conn, sessionName);
  if (!exists) {
    return { jobId, killed: false, message: `Session ${sessionName} not found (job may have already finished)` };
  }

  await tmuxKillSession(conn, sessionName);

  // Update meta status
  const meta = await readJobMeta(conn, jobId);
  if (meta) {
    meta.status = 'killed';
    meta.killedAt = new Date().toISOString();
    await writeJobMeta(conn, jobId, meta);
  }

  return { jobId, killed: true, message: `Killed tmux session ${sessionName}` };
}

/**
 * List all active tmux sessions on the server (Lvl3Quant jobs only).
 *
 * @param {string} serverName
 * @returns {Promise<Array<{jobId, sessionName, created, meta}>>}
 */
async function listJobs(serverName = DEFAULT_SERVER) {
  const conn = await getConnection(serverName);
  const sessions = await tmuxListSessions(conn);

  // Filter to lvl3quant sessions only
  const lvl3Sessions = sessions.filter(s => s.name.startsWith('lvl3_'));

  const jobs = [];
  for (const session of lvl3Sessions) {
    const jobId = session.name.replace('lvl3_', '');
    const meta = await readJobMeta(conn, jobId);
    jobs.push({
      jobId,
      sessionName: session.name,
      created: session.created,
      running: true,
      meta,
    });
  }

  return jobs;
}

/**
 * Get job progress by parsing log file for progress indicators.
 * Looks for patterns like [30/100], [30%], epoch 30/100, etc.
 *
 * @param {string} jobId
 * @param {string} serverName
 * @returns {Promise<{found: boolean, current, total, pct, recentLines}>}
 */
async function getJobProgress(jobId, serverName = DEFAULT_SERVER) {
  const conn = await getConnection(serverName);
  const logFile = `${LOGS_BASE}/job_${jobId}.log`;

  // Get last 20 lines for progress parsing
  const result = await execRemote(conn, `tail -n 20 "${logFile}" 2>/dev/null || echo ""`);
  const logText = result.stdout;
  const lines = logText.split('\n').filter(l => l.trim());

  // Parse progress patterns (search from bottom)
  const patterns = [
    // [30/100] style
    /\[(\d+)\/(\d+)\]/,
    // epoch 30/100 or step 30/100
    /(?:epoch|step|batch|iter(?:ation)?)\s+(\d+)\s*[\/of]\s*(\d+)/i,
    // 30% or 30.5%
    /(\d+(?:\.\d+)?)\s*%/,
    // Progress: 30/100
    /[Pp]rogress[:\s]+(\d+)\s*\/\s*(\d+)/,
  ];

  let found = false;
  let current = null;
  let total = null;
  let pct = null;

  // Search lines from most recent backwards
  for (const line of [...lines].reverse()) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        if (match[2]) {
          // Has current/total
          current = parseInt(match[1]);
          total = parseInt(match[2]);
          pct = ((current / total) * 100).toFixed(1);
        } else {
          // Just percentage
          pct = parseFloat(match[1]).toFixed(1);
        }
        found = true;
        break;
      }
    }
    if (found) break;
  }

  return {
    jobId,
    found,
    current,
    total,
    pct: pct ? parseFloat(pct) : null,
    recentLines: lines.slice(-5),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  launchJob,
  checkJob,
  getJobLog,
  killJob,
  listJobs,
  getJobProgress,
  generateJobId,

  // Low-level helpers
  tmuxSessionExists,
  tmuxListSessions,
  tmuxKillSession,
  readJobMeta,
  writeJobMeta,
  listJobMetas,

  // Constants
  REMOTE_BASE,
  LOGS_BASE,
};
