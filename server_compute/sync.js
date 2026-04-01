/**
 * sync.js — Bidirectional File Sync for Lvl3Quant
 *
 * Handles uploading code/data to the Jupiter server and downloading results.
 * Uses ssh2's SFTP with resume support for large files.
 *
 * Usage:
 *   const sync = require('./server_compute/sync');
 *   await sync.syncCodebase();
 *   await sync.syncResults();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getConnection, loadConfig, closeConnection } = require('../utils/ssh_manager');

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_SERVER = 'jupiter';

function getServerConfig(serverName = DEFAULT_SERVER) {
  const config = loadConfig();
  const server = config.servers[serverName];
  if (!server) throw new Error(`Unknown server: ${serverName}`);

  return {
    ...server,
    remoteBase: server.remoteBase || '~/lvl3quant',
    localLvl3: server.localBase || 'C:/Users/Footb/Documents/Github/Lvl3Quant',
    localTeleclaude: path.join(__dirname, '..'),
  };
}

// Local paths for Lvl3Quant project
const LOCAL_ALPHA_DISCOVERY = 'C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery';
const LOCAL_FEATURE_CACHE   = 'C:/Users/Footb/Documents/Github/Lvl3Quant/data/processed/mbo_features_cache';
const LOCAL_RESULTS_DIR     = 'C:/Users/Footb/Documents/Github/Lvl3Quant/results';

// =============================================================================
// SSH/SFTP Connection Helper
// =============================================================================

/**
 * Get an SFTP session from an existing SSH connection.
 * @param {object} conn - ssh2 Client connection
 * @returns {Promise<object>} sftp session
 */
function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(new Error(`SFTP error: ${err.message}`));
      resolve(sftp);
    });
  });
}

/**
 * Execute a command on the remote server.
 * @param {object} conn - ssh2 Client connection
 * @param {string} command
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function execRemote(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';

      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', code => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
    });
  });
}

// =============================================================================
// Remote Directory Helpers
// =============================================================================

/**
 * Ensure remote directory exists (mkdir -p equivalent via SFTP + exec).
 */
async function ensureRemoteDir(conn, remotePath) {
  // Expand ~ manually
  const { stdout: home } = await execRemote(conn, 'echo $HOME');
  const expanded = remotePath.replace(/^~/, home.trim());
  await execRemote(conn, `mkdir -p "${expanded}"`);
  return expanded;
}

/**
 * List remote directory contents with sizes.
 * Returns array of {name, size, isDir}
 */
async function listRemote(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return resolve([]); // Directory might not exist
      const entries = list.map(e => ({
        name: e.filename,
        size: e.attrs.size,
        isDir: (e.attrs.mode & 0o170000) === 0o040000,
        mtime: e.attrs.mtime,
      }));
      resolve(entries);
    });
  });
}

/**
 * Get remote file size, returns -1 if not found.
 */
async function getRemoteFileSize(sftp, remotePath) {
  return new Promise(resolve => {
    sftp.stat(remotePath, (err, stat) => {
      resolve(err ? -1 : stat.size);
    });
  });
}

// =============================================================================
// Upload Helpers
// =============================================================================

/**
 * Upload a single file via SFTP with resume support.
 * If remote file already exists and has same size, skip.
 *
 * @param {object} sftp
 * @param {string} localFile
 * @param {string} remoteFile
 * @param {object} opts - { onProgress, forceOverwrite }
 * @returns {Promise<{skipped: boolean, bytes: number}>}
 */
async function uploadFile(sftp, localFile, remoteFile, opts = {}) {
  const { onProgress, forceOverwrite = false } = opts;

  const localStat = fs.statSync(localFile);
  const localSize = localStat.size;

  // Check if remote exists with same size (skip if match)
  if (!forceOverwrite) {
    const remoteSize = await getRemoteFileSize(sftp, remoteFile);
    if (remoteSize === localSize) {
      return { skipped: true, bytes: 0 };
    }
  }

  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localFile);
    const writeStream = sftp.createWriteStream(remoteFile);

    let bytesTransferred = 0;
    const startTime = Date.now();

    readStream.on('data', chunk => {
      bytesTransferred += chunk.length;
      if (onProgress) {
        const pct = ((bytesTransferred / localSize) * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = bytesTransferred / elapsed / 1024 / 1024; // MB/s
        onProgress({ bytesTransferred, totalBytes: localSize, pct, speed });
      }
    });

    writeStream.on('close', () => resolve({ skipped: false, bytes: bytesTransferred }));
    writeStream.on('error', reject);
    readStream.on('error', reject);

    readStream.pipe(writeStream);
  });
}

/**
 * Recursively upload a local directory to a remote path.
 * @returns {Promise<{files: number, skipped: number, bytes: number, errors: Array}>}
 */
async function uploadDirectory(sftp, conn, localDir, remoteDir, opts = {}) {
  const { onProgress, filter, forceOverwrite = false } = opts;

  const stats = { files: 0, skipped: 0, bytes: 0, errors: [] };

  // Ensure remote dir exists
  await ensureRemoteDir(conn, remoteDir);

  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;

    // Apply filter if provided
    if (filter && !filter(entry.name, localPath)) continue;

    if (entry.isDirectory()) {
      const subStats = await uploadDirectory(sftp, conn, localPath, remotePath, opts);
      stats.files   += subStats.files;
      stats.skipped += subStats.skipped;
      stats.bytes   += subStats.bytes;
      stats.errors   = stats.errors.concat(subStats.errors);
    } else {
      try {
        const result = await uploadFile(sftp, localPath, remotePath, {
          forceOverwrite,
          onProgress: onProgress ? (p) => onProgress({ file: entry.name, ...p }) : null,
        });

        if (result.skipped) {
          stats.skipped++;
        } else {
          stats.files++;
          stats.bytes += result.bytes;
        }
      } catch (err) {
        stats.errors.push({ file: localPath, error: err.message });
      }
    }
  }

  return stats;
}

// =============================================================================
// Download Helpers
// =============================================================================

/**
 * Download a single file via SFTP with resume support.
 * If local file already exists and has same size as remote, skip.
 */
async function downloadFile(sftp, remoteFile, localFile, opts = {}) {
  const { onProgress, forceOverwrite = false } = opts;

  const remoteSize = await getRemoteFileSize(sftp, remoteFile);
  if (remoteSize === -1) throw new Error(`Remote file not found: ${remoteFile}`);

  if (!forceOverwrite && fs.existsSync(localFile)) {
    const localSize = fs.statSync(localFile).size;
    if (localSize === remoteSize) {
      return { skipped: true, bytes: 0 };
    }
  }

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(localFile), { recursive: true });

    const writeStream = fs.createWriteStream(localFile);
    const readStream = sftp.createReadStream(remoteFile);

    let bytesTransferred = 0;
    const startTime = Date.now();

    readStream.on('data', chunk => {
      bytesTransferred += chunk.length;
      if (onProgress) {
        const pct = ((bytesTransferred / remoteSize) * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = bytesTransferred / elapsed / 1024 / 1024;
        onProgress({ bytesTransferred, totalBytes: remoteSize, pct, speed });
      }
    });

    writeStream.on('close', () => resolve({ skipped: false, bytes: bytesTransferred }));
    writeStream.on('error', reject);
    readStream.on('error', reject);

    readStream.pipe(writeStream);
  });
}

/**
 * Recursively download a remote directory to a local path.
 */
async function downloadDirectory(sftp, conn, remoteDir, localDir, opts = {}) {
  const { onProgress, filter, forceOverwrite = false } = opts;
  const stats = { files: 0, skipped: 0, bytes: 0, errors: [] };

  fs.mkdirSync(localDir, { recursive: true });

  const entries = await listRemote(sftp, remoteDir);

  for (const entry of entries) {
    const remotePath = `${remoteDir}/${entry.name}`;
    const localPath = path.join(localDir, entry.name);

    if (filter && !filter(entry.name)) continue;

    if (entry.isDir) {
      const subStats = await downloadDirectory(sftp, conn, remotePath, localPath, opts);
      stats.files   += subStats.files;
      stats.skipped += subStats.skipped;
      stats.bytes   += subStats.bytes;
      stats.errors   = stats.errors.concat(subStats.errors);
    } else {
      try {
        const result = await downloadFile(sftp, remotePath, localPath, {
          forceOverwrite,
          onProgress: onProgress ? (p) => onProgress({ file: entry.name, ...p }) : null,
        });

        if (result.skipped) {
          stats.skipped++;
        } else {
          stats.files++;
          stats.bytes += result.bytes;
        }
      } catch (err) {
        stats.errors.push({ file: remotePath, error: err.message });
      }
    }
  }

  return stats;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Upload a local file or directory to the remote server.
 *
 * @param {string} localPath - Absolute local path
 * @param {string} remotePath - Remote path (absolute or ~/relative)
 * @param {object} opts - { serverName, onProgress, forceOverwrite }
 * @returns {Promise<object>} Transfer stats
 */
async function syncToServer(localPath, remotePath, opts = {}) {
  const { serverName = DEFAULT_SERVER, onProgress, forceOverwrite = false } = opts;
  const conn = await getConnection(serverName);
  const sftp = await getSftp(conn);

  try {
    const lstat = fs.statSync(localPath);

    if (lstat.isDirectory()) {
      const stats = await uploadDirectory(sftp, conn, localPath, remotePath, { onProgress, forceOverwrite });
      return { success: true, direction: 'up', localPath, remotePath, ...stats };
    } else {
      const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
      await ensureRemoteDir(conn, remoteDir);
      const result = await uploadFile(sftp, localPath, remotePath, { onProgress, forceOverwrite });
      return { success: true, direction: 'up', localPath, remotePath, ...result };
    }
  } catch (err) {
    return { success: false, error: err.message, localPath, remotePath };
  }
}

/**
 * Download a remote file or directory to local.
 *
 * @param {string} remotePath - Remote path
 * @param {string} localPath - Local destination
 * @param {object} opts - { serverName, onProgress, forceOverwrite }
 * @returns {Promise<object>} Transfer stats
 */
async function syncFromServer(remotePath, localPath, opts = {}) {
  const { serverName = DEFAULT_SERVER, onProgress, forceOverwrite = false } = opts;
  const conn = await getConnection(serverName);
  const sftp = await getSftp(conn);

  try {
    // Check if remote is a file or directory
    const remoteEntries = await listRemote(sftp, remotePath);

    if (remoteEntries.length === 0) {
      // It's a file (listRemote would return [] for a non-dir or return empty dir)
      // Try direct file stat
      const remoteSize = await getRemoteFileSize(sftp, remotePath);
      if (remoteSize === -1) {
        return { success: false, error: `Remote path not found: ${remotePath}` };
      }
      const result = await downloadFile(sftp, remotePath, localPath, { onProgress, forceOverwrite });
      return { success: true, direction: 'down', remotePath, localPath, ...result };
    } else {
      const stats = await downloadDirectory(sftp, conn, remotePath, localPath, { onProgress, forceOverwrite });
      return { success: true, direction: 'down', remotePath, localPath, ...stats };
    }
  } catch (err) {
    return { success: false, error: err.message, remotePath, localPath };
  }
}

/**
 * Sync the alpha_discovery/ codebase to the server.
 * Excludes __pycache__, .pyc files, and large data files.
 */
async function syncCodebase(opts = {}) {
  const { serverName = DEFAULT_SERVER, onProgress, forceOverwrite = false } = opts;
  const serverConfig = getServerConfig(serverName);

  console.log(`[sync] Uploading alpha_discovery/ to ${serverName}:${serverConfig.remoteBase}/alpha_discovery/`);

  const filter = (name) => {
    if (name === '__pycache__') return false;
    if (name.endsWith('.pyc')) return false;
    if (name.endsWith('.pyo')) return false;
    if (name === '.git') return false;
    if (name === 'node_modules') return false;
    if (name === '.DS_Store') return false;
    return true;
  };

  const localPath = LOCAL_ALPHA_DISCOVERY;
  const remotePath = `${serverConfig.remoteBase}/alpha_discovery`;

  if (!fs.existsSync(localPath)) {
    return { success: false, error: `Local path not found: ${localPath}` };
  }

  return syncToServer(localPath, remotePath, { serverName, onProgress, forceOverwrite, filter });
}

/**
 * Sync the feature cache NPZ files to the server.
 * These are large files (~200MB each compressed). Batches them and uses resume.
 *
 * @param {object} opts - { serverName, onProgress, batchSize, forceOverwrite }
 */
async function syncFeatureCache(opts = {}) {
  const {
    serverName = DEFAULT_SERVER,
    onProgress,
    batchSize = 5,
    forceOverwrite = false,
  } = opts;

  const serverConfig = getServerConfig(serverName);
  const localDir = LOCAL_FEATURE_CACHE;
  const remoteDir = `${serverConfig.remoteBase}/data/features`;

  if (!fs.existsSync(localDir)) {
    return { success: false, error: `Feature cache not found: ${localDir}` };
  }

  const allFiles = fs.readdirSync(localDir)
    .filter(f => f.endsWith('.npz'))
    .sort();

  console.log(`[sync] Found ${allFiles.length} NPZ files in feature cache`);
  console.log(`[sync] Uploading to ${serverName}:${remoteDir} in batches of ${batchSize}`);

  const conn = await getConnection(serverName);
  const sftp = await getSftp(conn);
  await ensureRemoteDir(conn, remoteDir);

  const overallStats = { files: 0, skipped: 0, bytes: 0, errors: [] };

  // Process in batches
  for (let i = 0; i < allFiles.length; i += batchSize) {
    const batch = allFiles.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(allFiles.length / batchSize);

    console.log(`[sync] Batch ${batchNum}/${totalBatches}: ${batch[0]} ... ${batch[batch.length - 1]}`);

    // Upload files in this batch sequentially (avoid overwhelming SFTP)
    for (const filename of batch) {
      const localFile = path.join(localDir, filename);
      const remoteFile = `${remoteDir}/${filename}`;
      const fileSize = fs.statSync(localFile).size;

      try {
        const result = await uploadFile(sftp, localFile, remoteFile, {
          forceOverwrite,
          onProgress: (p) => {
            if (onProgress) onProgress({ batch: batchNum, totalBatches, file: filename, ...p });
            else process.stdout.write(`\r  ${filename}: ${p.pct}% (${p.speed.toFixed(1)} MB/s)   `);
          },
        });

        if (result.skipped) {
          overallStats.skipped++;
          console.log(`\n  [skip] ${filename} (${(fileSize / 1024 / 1024).toFixed(0)}MB, already synced)`);
        } else {
          overallStats.files++;
          overallStats.bytes += result.bytes;
          console.log(`\n  [ok]   ${filename} (${(fileSize / 1024 / 1024).toFixed(0)}MB uploaded)`);
        }
      } catch (err) {
        overallStats.errors.push({ file: filename, error: err.message });
        console.error(`\n  [err]  ${filename}: ${err.message}`);
      }
    }
  }

  return {
    success: true,
    direction: 'up',
    localDir,
    remoteDir,
    totalFiles: allFiles.length,
    ...overallStats,
    bytesGB: (overallStats.bytes / 1024 / 1024 / 1024).toFixed(2),
  };
}

/**
 * Download results from the server to local machine.
 *
 * @param {string|null} jobId - Specific job ID to pull, or null for all results
 * @param {string|null} localDest - Local destination (default: LOCAL_RESULTS_DIR)
 * @param {object} opts
 */
async function syncResults(jobId = null, localDest = null, opts = {}) {
  const { serverName = DEFAULT_SERVER, onProgress, forceOverwrite = false } = opts;
  const serverConfig = getServerConfig(serverName);

  const remoteDir = jobId
    ? `${serverConfig.remoteBase}/results/job_${jobId}`
    : `${serverConfig.remoteBase}/results`;

  const localDir = localDest || LOCAL_RESULTS_DIR;

  console.log(`[sync] Downloading results from ${serverName}:${remoteDir} -> ${localDir}`);

  return syncFromServer(remoteDir, localDir, { serverName, onProgress, forceOverwrite });
}

/**
 * Get sync status — compare local vs remote file counts and sizes.
 * Useful for quick health check before a job.
 */
async function getSyncStatus(opts = {}) {
  const { serverName = DEFAULT_SERVER } = opts;
  const serverConfig = getServerConfig(serverName);

  try {
    const conn = await getConnection(serverName);
    const sftp = await getSftp(conn);

    // Check feature cache
    const remoteFeatureDir = `${serverConfig.remoteBase}/data/features`;
    const remoteFeatures = await listRemote(sftp, remoteFeatureDir);
    const remoteNpzCount = remoteFeatures.filter(e => e.name.endsWith('.npz')).length;

    let localNpzCount = 0;
    if (fs.existsSync(LOCAL_FEATURE_CACHE)) {
      localNpzCount = fs.readdirSync(LOCAL_FEATURE_CACHE).filter(f => f.endsWith('.npz')).length;
    }

    // Check alpha_discovery
    const remoteCodeDir = `${serverConfig.remoteBase}/alpha_discovery`;
    const remoteCodeEntries = await listRemote(sftp, remoteCodeDir);

    return {
      success: true,
      featureCache: {
        local: localNpzCount,
        remote: remoteNpzCount,
        synced: localNpzCount === remoteNpzCount,
        missing: localNpzCount - remoteNpzCount,
      },
      codebase: {
        remoteFiles: remoteCodeEntries.length,
        exists: remoteCodeEntries.length > 0,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  syncToServer,
  syncFromServer,
  syncCodebase,
  syncFeatureCache,
  syncResults,
  getSyncStatus,

  // Low-level helpers (for use by other modules)
  getSftp,
  execRemote,
  ensureRemoteDir,
  uploadFile,
  uploadDirectory,
  downloadFile,
  downloadDirectory,
  getRemoteFileSize,
  listRemote,
};
