/**
 * executor.js — Task Execution Engine
 *
 * Handles actually running tasks on the PC (local child_process) or the
 * Jupiter server (SSH + tmux). Returns job handles for monitoring.
 *
 * PC execution:
 *   - Uses child_process.spawn with shell: true
 *   - Redirects stdout/stderr to a log file
 *   - Tracks PID for monitoring
 *   - Log file: C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/results/dispatch_<taskId>.log
 *
 * Server execution:
 *   - SSH via ssh2 (reuses server_compute/connection.js patterns)
 *   - Launches in tmux session so it survives SSH disconnect
 *   - Session name: disp_<taskId>
 *   - Log file: ~/lvl3quant/logs/disp_<taskId>.log
 *
 * Job handle format:
 *   {
 *     type: 'pc' | 'server',
 *     id: taskId,
 *     pid: <number> | null,           // PC: process PID
 *     sessionName: <string> | null,   // Server: tmux session name
 *     logFile: <string>,              // Path to log (local for PC, remote for server)
 *     startedAt: <ISO string>,
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Log directory for PC tasks
const PC_LOG_DIR = 'C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/results';

// Remote log directory on server
const SERVER_LOG_DIR = '~/lvl3quant/logs';

// Completion marker written to log when job finishes
const DONE_MARKER = '[JOB_DONE:exit=';

// ===========================================================================
// Main entry points
// ===========================================================================

/**
 * Execute a task on the specified machine.
 *
 * @param {object} task     - Task object from dispatcher
 * @param {'pc'|'server'} machine
 * @returns {Promise<object>} jobHandle
 */
async function execute(task, machine) {
  if (!task.command) {
    throw new Error(`Task "${task.name}" has no command defined`);
  }

  const cmd = task.command[machine];
  if (!cmd) {
    throw new Error(`Task "${task.name}" has no command for machine: ${machine}`);
  }

  const workingDir = (task.workingDir || {})[machine] || (machine === 'pc'
    ? 'C:/Users/Footb/Documents/Github/Lvl3Quant'
    : '/home/jupiter/lvl3quant'
  );

  if (machine === 'pc') {
    return executeOnPC(task, cmd, workingDir);
  } else {
    return executeOnServer(task, cmd, workingDir);
  }
}

/**
 * Check the status of a running task.
 *
 * @param {object} task - Task object with jobHandle attached
 * @returns {Promise<{status: 'running'|'completed'|'failed', exitCode, progress, lastLines}>}
 */
async function checkStatus(task) {
  if (!task.jobHandle) {
    return { status: 'failed', error: 'No job handle' };
  }

  if (task.machine === 'pc') {
    return checkPCStatus(task.jobHandle);
  } else {
    return checkServerStatus(task.jobHandle);
  }
}

// ===========================================================================
// PC Execution
// ===========================================================================

/**
 * Execute a command on the local PC using child_process.spawn.
 *
 * @param {object} task
 * @param {string} cmd
 * @param {string} workingDir
 * @returns {Promise<object>} jobHandle
 */
async function executeOnPC(task, cmd, workingDir) {
  // Ensure log directory exists
  fs.mkdirSync(PC_LOG_DIR, { recursive: true });

  const logFile = path.join(PC_LOG_DIR, `dispatch_${task.id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // Write header
  const header = [
    `=== PC Task: ${task.name} ===`,
    `Task ID:  ${task.id}`,
    `Command:  ${cmd}`,
    `Dir:      ${workingDir}`,
    `Started:  ${new Date().toISOString()}`,
    `===`,
    '',
  ].join('\n');
  logStream.write(header);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      cwd:   workingDir,
      shell: true,
      env:   {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      detached: false,
      stdio:    ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', d => logStream.write(d));
    child.stderr.on('data', d => logStream.write(d));

    child.on('error', err => {
      logStream.write(`\n[SPAWN ERROR: ${err.message}]\n`);
      logStream.end();
      reject(err);
    });

    child.on('close', code => {
      const marker = `\n${DONE_MARKER}${code}:time=${new Date().toISOString()}]\n`;
      logStream.write(marker);
      logStream.end();
    });

    // Give the process a moment to ensure it actually started
    setTimeout(() => {
      if (child.pid) {
        const handle = {
          type:        'pc',
          id:          task.id,
          pid:         child.pid,
          sessionName: null,
          logFile,
          startedAt:   new Date().toISOString(),
        };

        // Store PID file for recovery across session resets
        const pidFile = path.join(PC_LOG_DIR, `dispatch_${task.id}.pid`);
        fs.writeFileSync(pidFile, String(child.pid), 'utf8');

        resolve(handle);
      } else {
        reject(new Error('Process failed to start (no PID)'));
      }
    }, 500);
  });
}

/**
 * Check if a PC task is still running.
 *
 * @param {object} jobHandle
 * @returns {Promise<{status, exitCode, progress, lastLines}>}
 */
async function checkPCStatus(jobHandle) {
  const { pid, logFile } = jobHandle;

  // Check if PID is still alive
  let pidAlive = false;
  if (pid) {
    try {
      process.kill(pid, 0); // Signal 0: check if process exists
      pidAlive = true;
    } catch (e) {
      pidAlive = false; // ESRCH = no such process
    }
  }

  // Read log tail for completion marker and progress
  const logData = readLogTail(logFile, 40);

  const parsed = parseLogStatus(logData);

  if (pidAlive && !parsed.isDone) {
    return {
      status:    'running',
      progress:  parsed.progress,
      lastLines: parsed.lastLines,
    };
  }

  if (parsed.isDone) {
    return {
      status:    parsed.exitCode === 0 ? 'completed' : 'failed',
      exitCode:  parsed.exitCode,
      progress:  parsed.progress,
      lastLines: parsed.lastLines,
    };
  }

  // PID gone but no completion marker — likely crashed
  return {
    status:    'failed',
    exitCode:  null,
    error:     'Process ended without completion marker',
    lastLines: parsed.lastLines,
  };
}

// ===========================================================================
// Server Execution (SSH + tmux)
// ===========================================================================

/**
 * Execute a command on the Jupiter server via SSH in a tmux session.
 *
 * @param {object} task
 * @param {string} cmd
 * @param {string} workingDir
 * @returns {Promise<object>} jobHandle
 */
async function executeOnServer(task, cmd, workingDir) {
  const { getConn, execOn } = require('../server_compute/connection');

  const conn = await getConn('jupiter');

  const sessionName = `disp_${task.id}`;
  const logFile     = `${SERVER_LOG_DIR}/disp_${task.id}.log`;

  // Ensure log directory exists on server
  await execOn(conn, `mkdir -p ${SERVER_LOG_DIR}`);

  // Build full command: activate venv, cd to workdir, run, tee to log
  const innerCmd = [
    `source ~/lvl3quant/venv/bin/activate 2>/dev/null || true`,
    `export PYTHONUNBUFFERED=1`,
    `export PYTHONPATH=~/lvl3quant:$PYTHONPATH`,
    `cd "${workingDir}"`,
    cmd,
  ].join(' && ');

  const fullCmd = `{ ${innerCmd} ; echo "${DONE_MARKER}$?:time=$(date -u +%Y-%m-%dT%H:%M:%SZ)]" ; } 2>&1 | tee "${logFile}"`;

  // Escape single quotes for tmux
  const escapedCmd = fullCmd.replace(/'/g, "'\\''");
  const tmuxCmd = `tmux new-session -d -s "${sessionName}" bash -c '${escapedCmd}'`;

  const result = await execOn(conn, tmuxCmd);
  if (result.code !== 0 && result.stderr && !result.stderr.includes('already exists')) {
    throw new Error(`Failed to launch tmux session: ${result.stderr}`);
  }

  // Small delay for process to start, then get tmux pane PID
  await new Promise(r => setTimeout(r, 800));
  const pidResult = await execOn(conn,
    `tmux list-panes -t "${sessionName}" -F "#{pane_pid}" 2>/dev/null | head -1 || echo ""`
  );
  const tmuxPid = pidResult.stdout.trim() || null;

  const handle = {
    type:        'server',
    id:          task.id,
    pid:         tmuxPid ? parseInt(tmuxPid) : null,
    sessionName,
    logFile,
    serverName:  'jupiter',
    startedAt:   new Date().toISOString(),
  };

  return handle;
}

/**
 * Check if a server task is still running.
 *
 * @param {object} jobHandle
 * @returns {Promise<{status, exitCode, progress, lastLines}>}
 */
async function checkServerStatus(jobHandle) {
  const { getConn, execOn } = require('../server_compute/connection');

  const { sessionName, logFile } = jobHandle;
  const serverName = jobHandle.serverName || 'jupiter';

  try {
    const conn = await getConn(serverName);

    // Check tmux session existence
    const tmuxCheck = await execOn(conn,
      `tmux has-session -t "${sessionName}" 2>/dev/null && echo "ALIVE" || echo "GONE"`
    );
    const sessionAlive = tmuxCheck.stdout.trim() === 'ALIVE';

    // Read log tail
    const tailResult = await execOn(conn, `tail -n 40 "${logFile}" 2>/dev/null || echo ""`);
    const logData = tailResult.stdout;

    const parsed = parseLogStatus(logData);

    if (sessionAlive && !parsed.isDone) {
      return {
        status:    'running',
        progress:  parsed.progress,
        lastLines: parsed.lastLines,
      };
    }

    if (parsed.isDone) {
      return {
        status:    parsed.exitCode === 0 ? 'completed' : 'failed',
        exitCode:  parsed.exitCode,
        progress:  parsed.progress,
        lastLines: parsed.lastLines,
      };
    }

    // Session gone, no marker
    return {
      status:    'failed',
      exitCode:  null,
      error:     'tmux session ended without completion marker',
      lastLines: parsed.lastLines,
    };

  } catch (err) {
    return {
      status: 'failed',
      error:  `SSH check failed: ${err.message}`,
    };
  }
}

// ===========================================================================
// Log Parsing
// ===========================================================================

/**
 * Read the last N lines of a local log file.
 * @param {string} logFile - Absolute local path
 * @param {number} lines
 * @returns {string}
 */
function readLogTail(logFile, lines = 40) {
  try {
    if (!fs.existsSync(logFile)) return '';
    const content = fs.readFileSync(logFile, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (e) {
    return '';
  }
}

/**
 * Parse a log tail for completion status and progress.
 *
 * Recognises:
 *   [JOB_DONE:exit=0:time=...]          — completion marker
 *   [30/100], [50%], epoch 30/100      — progress
 *   [ch1_l1_imbalance] IC=0.0312       — multi_alpha channel IC output
 *   [30] train's binary_logloss: ...   — LightGBM iteration
 *
 * @param {string} logText
 * @returns {{ isDone, exitCode, progress, lastLines }}
 */
function parseLogStatus(logText) {
  const allLines = logText.split('\n');
  const lines = allLines.filter(l => l.trim());

  let isDone   = false;
  let exitCode = null;
  let progress = null;

  // Check for completion marker (scan from end)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes(DONE_MARKER)) {
      isDone = true;
      const m = line.match(/exit=(\d+)/);
      exitCode = m ? parseInt(m[1]) : null;
      break;
    }
  }

  // Progress patterns (scan from end, take first match)
  const progressPatterns = [
    // [30/100] or (30/100)
    { re: /[\[(](\d+)\s*\/\s*(\d+)[\])]/, type: 'fraction' },
    // epoch/step/iter N/M
    { re: /(?:epoch|step|batch|iter(?:ation)?)\s*[:\s]+(\d+)\s*[\/of]+\s*(\d+)/i, type: 'fraction' },
    // tqdm: 30%|
    { re: /(\d+)%\|/, type: 'pct' },
    // 30% complete/done/finished
    { re: /(\d+(?:\.\d+)?)\s*%\s*(?:complete|done|finished)?/i, type: 'pct' },
    // Progress: 30/100
    { re: /(?:progress|completed)[:\s]+(\d+)\s*(?:of|\/)\s*(\d+)/i, type: 'fraction' },
    // LightGBM: [100] train's ...
    { re: /^\[(\d+)\]\s+(?:train|valid|cv)\s*'s/i, type: 'lgbm' },
    // multi_alpha channel output: [ch1_l1_imbalance] IC=0.03 (50/100 channels)
    { re: /\((\d+)\s*\/\s*(\d+)\s*channel/i, type: 'fraction' },
  ];

  for (let i = lines.length - 1; i >= 0 && !progress; i--) {
    const line = lines[i];
    for (const { re, type } of progressPatterns) {
      const m = line.match(re);
      if (m) {
        if (type === 'fraction') {
          const cur = parseInt(m[1]);
          const tot = parseInt(m[2]);
          progress = `${cur}/${tot} (${tot > 0 ? ((cur / tot) * 100).toFixed(0) : '?'}%)`;
        } else if (type === 'pct') {
          progress = `${parseFloat(m[1]).toFixed(0)}%`;
        } else if (type === 'lgbm') {
          progress = `LightGBM iter ${m[1]}`;
        }
        break;
      }
    }
  }

  return {
    isDone,
    exitCode,
    progress,
    lastLines: lines.slice(-5),
  };
}

// ===========================================================================
// Killing Tasks
// ===========================================================================

/**
 * Kill a running task.
 *
 * @param {object} task  - Task object with jobHandle
 * @returns {Promise<{killed: boolean, message: string}>}
 */
async function killTask(task) {
  if (!task.jobHandle) {
    return { killed: false, message: 'No job handle' };
  }

  if (task.machine === 'pc') {
    return killPCTask(task.jobHandle);
  } else {
    return killServerTask(task.jobHandle);
  }
}

async function killPCTask(jobHandle) {
  const { pid } = jobHandle;
  if (!pid) return { killed: false, message: 'No PID' };

  try {
    process.kill(pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
    // Force kill if still running
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    return { killed: true, message: `Sent SIGTERM/SIGKILL to PID ${pid}` };
  } catch (err) {
    return { killed: false, message: `Could not kill PID ${pid}: ${err.message}` };
  }
}

async function killServerTask(jobHandle) {
  const { getConn, execOn } = require('../server_compute/connection');
  const { sessionName } = jobHandle;

  try {
    const conn = await getConn(jobHandle.serverName || 'jupiter');
    await execOn(conn, `tmux kill-session -t "${sessionName}" 2>/dev/null; echo done`);
    return { killed: true, message: `Killed tmux session ${sessionName}` };
  } catch (err) {
    return { killed: false, message: `SSH kill failed: ${err.message}` };
  }
}

// ===========================================================================
// Log Reading
// ===========================================================================

/**
 * Get recent log lines for a task.
 *
 * @param {object} task
 * @param {number} lines
 * @returns {Promise<string>}
 */
async function getLog(task, lines = 50) {
  if (!task.jobHandle) return '(no job handle)';

  if (task.machine === 'pc') {
    return readLogTail(task.jobHandle.logFile, lines);
  }

  // Server: SSH tail
  try {
    const { getConn, execOn } = require('../server_compute/connection');
    const conn = await getConn(task.jobHandle.serverName || 'jupiter');
    const result = await execOn(conn,
      `tail -n ${lines} "${task.jobHandle.logFile}" 2>/dev/null || echo "(log not found)"`
    );
    return result.stdout;
  } catch (err) {
    return `(SSH error: ${err.message})`;
  }
}

// ===========================================================================
// Exports
// ===========================================================================

module.exports = {
  execute,
  checkStatus,
  killTask,
  getLog,

  // Lower-level (for testing/direct use)
  executeOnPC,
  executeOnServer,
  checkPCStatus,
  checkServerStatus,
  parseLogStatus,
  readLogTail,

  // Constants
  PC_LOG_DIR,
  SERVER_LOG_DIR,
};
