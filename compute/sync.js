/**
 * sync.js — Results Sync for Compute Dispatcher
 *
 * After a server task completes, automatically pulls results back to the PC.
 * Uses SFTP over 192.168.137.2 (direct Ethernet link — fast).
 *
 * Also provides push: optionally sync results FROM PC TO server for backup.
 *
 * Result paths convention:
 *   Server: ~/lvl3quant/alpha_discovery/results/<taskId>/
 *           ~/lvl3quant/logs/disp_<taskId>.log
 *   Local:  C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/results/<taskId>/
 *
 * Usage:
 *   const { syncTaskResults, syncTaskLog, syncAll } = require('./compute/sync');
 *   await syncTaskResults(task);  // Pull results + log for a specific task
 *   await syncAll();              // Pull all results from server
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Local results root
const LOCAL_RESULTS_ROOT = 'C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/results';
const SERVER_RESULTS_ROOT = '~/lvl3quant/alpha_discovery/results';
const SERVER_LOGS_DIR     = '~/lvl3quant/logs';

// ===========================================================================
// SFTP Helpers (reuse from server_compute/sync.js patterns)
// ===========================================================================

function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(new Error(`SFTP error: ${err.message}`));
      resolve(sftp);
    });
  });
}

function getRemoteFileSize(sftp, remotePath) {
  return new Promise(resolve => {
    sftp.stat(remotePath, (err, stat) => resolve(err ? -1 : stat.size));
  });
}

function listRemoteDir(sftp, remotePath) {
  return new Promise((resolve) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return resolve([]);
      resolve(list.map(e => ({
        name:  e.filename,
        size:  e.attrs.size,
        isDir: (e.attrs.mode & 0o170000) === 0o040000,
        mtime: e.attrs.mtime,
      })));
    });
  });
}

/**
 * Download a single file from server to local. Skips if same size.
 */
async function downloadFile(sftp, remotePath, localPath, forceOverwrite = false) {
  const remoteSize = await getRemoteFileSize(sftp, remotePath);
  if (remoteSize === -1) {
    return { skipped: false, error: `Not found: ${remotePath}` };
  }

  if (!forceOverwrite && fs.existsSync(localPath)) {
    if (fs.statSync(localPath).size === remoteSize) {
      return { skipped: true, bytes: 0 };
    }
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(localPath);
    const readStream  = sftp.createReadStream(remotePath);

    let bytes = 0;
    readStream.on('data', chunk => { bytes += chunk.length; });
    writeStream.on('close', () => resolve({ skipped: false, bytes }));
    writeStream.on('error', reject);
    readStream.on('error', reject);
    readStream.pipe(writeStream);
  });
}

/**
 * Recursively download a remote directory to local.
 */
async function downloadDirectory(sftp, conn, remoteDirExpanded, localDir, forceOverwrite = false) {
  const stats = { files: 0, skipped: 0, bytes: 0, errors: [] };

  fs.mkdirSync(localDir, { recursive: true });
  const entries = await listRemoteDir(sftp, remoteDirExpanded);

  for (const entry of entries) {
    const remotePath = `${remoteDirExpanded}/${entry.name}`;
    const localPath  = path.join(localDir, entry.name);

    if (entry.isDir) {
      const sub = await downloadDirectory(sftp, conn, remotePath, localPath, forceOverwrite);
      stats.files   += sub.files;
      stats.skipped += sub.skipped;
      stats.bytes   += sub.bytes;
      stats.errors   = stats.errors.concat(sub.errors);
    } else {
      try {
        const r = await downloadFile(sftp, remotePath, localPath, forceOverwrite);
        if (r.skipped) { stats.skipped++; }
        else if (r.error) { stats.errors.push({ file: entry.name, error: r.error }); }
        else { stats.files++; stats.bytes += r.bytes; }
      } catch (err) {
        stats.errors.push({ file: entry.name, error: err.message });
      }
    }
  }

  return stats;
}

/**
 * Expand ~ to actual home directory path on server.
 */
async function expandRemotePath(conn, remotePath) {
  const { execOn } = require('../server_compute/connection');
  const { stdout: home } = await execOn(conn, 'echo $HOME');
  return remotePath.replace(/^~/, home.trim());
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Sync results and log for a specific completed task back to the PC.
 *
 * @param {object} task  - Task object from dispatcher (with jobHandle)
 * @param {object} opts
 * @param {boolean} opts.forceOverwrite  - Re-download even if sizes match (default false)
 * @param {function} opts.onProgress     - Progress callback
 * @returns {Promise<{success, taskId, files, skipped, bytes, logSynced, errors}>}
 */
async function syncTaskResults(task, opts = {}) {
  const { forceOverwrite = false } = opts;

  if (!task.jobHandle || task.machine !== 'server') {
    return {
      success: false,
      error:   'syncTaskResults: task did not run on server or has no job handle',
    };
  }

  const { getConn } = require('../server_compute/connection');
  const serverName = task.jobHandle.serverName || 'jupiter';

  try {
    const conn = await getConn(serverName);
    const sftp = await getSftp(conn);

    const stats = { files: 0, skipped: 0, bytes: 0, errors: [], logSynced: false };

    // 1. Sync log file
    const remoteLog = task.jobHandle.logFile;
    if (remoteLog) {
      const expandedLog = await expandRemotePath(conn, remoteLog);
      const localLog = path.join(LOCAL_RESULTS_ROOT, `disp_${task.id}.log`);
      fs.mkdirSync(path.dirname(localLog), { recursive: true });

      try {
        const r = await downloadFile(sftp, expandedLog, localLog, true); // Always refresh log
        if (!r.error) {
          stats.logSynced = true;
          if (!r.skipped) stats.bytes += r.bytes;
        }
      } catch (err) {
        stats.errors.push({ file: 'log', error: err.message });
      }
    }

    // 2. Sync results directory for this task
    const remoteResultsDir = `${SERVER_RESULTS_ROOT}/${task.id}`;
    const expandedResults  = await expandRemotePath(conn, remoteResultsDir);
    const localResultsDir  = path.join(LOCAL_RESULTS_ROOT, task.id);

    // Check if results dir exists on server
    const entries = await listRemoteDir(sftp, expandedResults);
    if (entries.length > 0) {
      const sub = await downloadDirectory(sftp, conn, expandedResults, localResultsDir, forceOverwrite);
      stats.files   += sub.files;
      stats.skipped += sub.skipped;
      stats.bytes   += sub.bytes;
      stats.errors   = stats.errors.concat(sub.errors);
    } else {
      // No dedicated results dir — check for JSON output files in common locations
      const alternativePaths = [
        `~/lvl3quant/alpha_discovery/results/${task.id}`,
        `~/lvl3quant/results/${task.id}`,
      ];
      for (const altPath of alternativePaths) {
        const expanded = await expandRemotePath(conn, altPath);
        const altEntries = await listRemoteDir(sftp, expanded);
        if (altEntries.length > 0) {
          const altLocal = path.join(LOCAL_RESULTS_ROOT, task.id);
          const sub = await downloadDirectory(sftp, conn, expanded, altLocal, forceOverwrite);
          stats.files   += sub.files;
          stats.skipped += sub.skipped;
          stats.bytes   += sub.bytes;
          stats.errors   = stats.errors.concat(sub.errors);
          break;
        }
      }
    }

    return {
      success:    true,
      taskId:     task.id,
      serverName,
      localDir:   path.join(LOCAL_RESULTS_ROOT, task.id),
      bytesKB:    (stats.bytes / 1024).toFixed(1),
      ...stats,
    };

  } catch (err) {
    return {
      success: false,
      taskId:  task.id,
      error:   err.message,
    };
  }
}

/**
 * Just sync the log file for a task (useful during monitoring).
 *
 * @param {object} task
 * @returns {Promise<{success, localLogPath, bytes}>}
 */
async function syncTaskLog(task) {
  if (!task.jobHandle || task.machine !== 'server') {
    return { success: false, error: 'Not a server task' };
  }

  const { getConn } = require('../server_compute/connection');

  try {
    const conn = await getConn(task.jobHandle.serverName || 'jupiter');
    const sftp = await getSftp(conn);

    const remoteLog  = task.jobHandle.logFile;
    const expanded   = await expandRemotePath(conn, remoteLog);
    const localLog   = path.join(LOCAL_RESULTS_ROOT, `disp_${task.id}.log`);

    fs.mkdirSync(path.dirname(localLog), { recursive: true });

    const r = await downloadFile(sftp, expanded, localLog, true);

    return { success: true, localLogPath: localLog, bytes: r.bytes || 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Download a file or directory from server to local.
 * General-purpose sync for arbitrary paths.
 *
 * @param {string} remotePath  - Remote path (may start with ~)
 * @param {string} localPath   - Local destination path
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function syncFromServer(remotePath, localPath, opts = {}) {
  const { serverName = 'jupiter', forceOverwrite = false } = opts;
  const { getConn } = require('../server_compute/connection');

  try {
    const conn = await getConn(serverName);
    const sftp = await getSftp(conn);
    const expanded = await expandRemotePath(conn, remotePath);

    // Is it a file or directory?
    const entries = await listRemoteDir(sftp, expanded);
    if (entries.length > 0) {
      // Directory
      const stats = await downloadDirectory(sftp, conn, expanded, localPath, forceOverwrite);
      return { success: true, direction: 'down', remotePath, localPath, ...stats };
    } else {
      // File
      const r = await downloadFile(sftp, expanded, localPath, forceOverwrite);
      return { success: !r.error, direction: 'down', remotePath, localPath, bytes: r.bytes || 0, error: r.error };
    }
  } catch (err) {
    return { success: false, remotePath, localPath, error: err.message };
  }
}

/**
 * Upload a file from local to server.
 * General-purpose push.
 *
 * @param {string} localPath
 * @param {string} remotePath  - Remote path (may start with ~)
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function syncToServer(localPath, remotePath, opts = {}) {
  const { serverName = 'jupiter' } = opts;

  // Delegate to server_compute/sync.js which already handles this well
  const serverSync = require('../server_compute/sync');
  return serverSync.syncToServer(localPath, remotePath, { serverName });
}

/**
 * Pull all results from the server.
 * Downloads everything in ~/lvl3quant/alpha_discovery/results/ to local.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function syncAll(opts = {}) {
  const { serverName = 'jupiter', forceOverwrite = false } = opts;
  const { getConn } = require('../server_compute/connection');

  try {
    const conn = await getConn(serverName);
    const sftp = await getSftp(conn);

    const remoteDir = SERVER_RESULTS_ROOT;
    const expanded  = await expandRemotePath(conn, remoteDir);
    const localDir  = LOCAL_RESULTS_ROOT;

    const stats = await downloadDirectory(sftp, conn, expanded, localDir, forceOverwrite);

    return {
      success:    true,
      direction:  'down',
      remoteDir,
      localDir,
      bytesKB:    (stats.bytes / 1024).toFixed(1),
      ...stats,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ===========================================================================
// Exports
// ===========================================================================

module.exports = {
  syncTaskResults,
  syncTaskLog,
  syncFromServer,
  syncToServer,
  syncAll,

  // Constants
  LOCAL_RESULTS_ROOT,
  SERVER_RESULTS_ROOT,
};
