/**
 * connection.js — Shared SSH Connection Factory for server_compute modules
 *
 * Provides a connection pool with keepalive, retry logic, and graceful
 * degradation. All server_compute modules import from here.
 *
 * This module wraps utils/ssh_manager.js and adds:
 *  - Automatic password resolution from vault/env
 *  - Connection retry with exponential backoff
 *  - Keepalive configuration for long-running operations
 *  - Clear error messages when server is unreachable
 *
 * Usage:
 *   const { getConn, execOn, closeAll } = require('./server_compute/connection');
 *   const conn = await getConn('jupiter-desktop');
 *   const { stdout } = await execOn(conn, 'uptime');
 *   closeAll();
 */

'use strict';

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'remote_servers.json');

// Connection pool: serverName -> { conn, lastUsed }
const pool = new Map();

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load server configuration. Resolves password from vault if it's a placeholder.
 */
function loadServerConfig(serverName) {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Config file not found: ${CONFIG_FILE}`);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const server = config.servers[serverName];

  if (!server) {
    const available = Object.keys(config.servers).join(', ');
    throw new Error(`Unknown server: "${serverName}". Available: ${available}`);
  }

  // Resolve password
  let password = server.password;

  // Handle vault references like [SECURED:KEY_NAME]
  if (password && password.startsWith('[SECURED:')) {
    const keyName = password.match(/\[SECURED:(.+?)\]/)?.[1];
    if (keyName) {
      // Try vault first
      try {
        const { getSecret } = require('../security/vault_loader');
        password = getSecret(keyName, 'server_compute');
      } catch (e) {
        // Try environment variable
        password = process.env[keyName] || null;
      }

      if (!password) {
        throw new Error(
          `Cannot resolve password for server "${serverName}". ` +
          `Set ${keyName} in vault or as environment variable. ` +
          `Or set the password directly in config/remote_servers.json.`
        );
      }
    }
  }

  return {
    ...server,
    password,
    // Support both 'user' and 'username' fields
    username: server.username || server.user,
  };
}

// =============================================================================
// Connection Factory
// =============================================================================

/**
 * Get or create an SSH connection to a server.
 * Uses connection pooling — if existing connection is alive, reuses it.
 *
 * @param {string} serverName - Key in remote_servers.json
 * @param {object} [opts] - { maxRetries, retryDelayMs }
 * @returns {Promise<Client>} - ssh2 Client, already connected
 */
async function getConn(serverName = 'jupiter', opts = {}) {
  const { maxRetries = 3, retryDelayMs = 2000 } = opts;

  // Return cached connection if still alive
  if (pool.has(serverName)) {
    const { conn } = pool.get(serverName);
    if (conn._sock && !conn._sock.destroyed) {
      pool.get(serverName).lastUsed = Date.now();
      return conn;
    }
    // Dead connection — remove from pool
    pool.delete(serverName);
  }

  // Create new connection with retries
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const conn = await createConnection(serverName);
      pool.set(serverName, { conn, lastUsed: Date.now() });
      return conn;
    } catch (err) {
      lastError = err;

      // Don't retry auth failures (password wrong)
      if (err.message.includes('Authentication') || err.message.includes('Cannot resolve password')) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = retryDelayMs * Math.pow(1.5, attempt - 1);
        console.warn(`[connection] Attempt ${attempt}/${maxRetries} failed for ${serverName}: ${err.message}. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted
  throw new Error(
    `Failed to connect to ${serverName} after ${maxRetries} attempts. ` +
    `Last error: ${lastError.message}. ` +
    (lastError.message.includes('ECONNREFUSED') || lastError.message.includes('connect')
      ? 'Is the server running? Is SSH accessible? (If password auth is failing, reset password on server console.)'
      : '')
  );
}

/**
 * Create a fresh SSH connection.
 */
function createConnection(serverName) {
  return new Promise((resolve, reject) => {
    const server = loadServerConfig(serverName);

    const conn = new Client();

    conn.on('ready', () => {
      resolve(conn);
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.on('close', () => {
      pool.delete(serverName);
    });

    conn.on('end', () => {
      pool.delete(serverName);
    });

    // Build connection options
    const connOpts = {
      host: server.host,
      port: server.port || 22,
      username: server.username || server.user,
      readyTimeout: 30000,
      keepaliveInterval: 15000,  // Send keepalive every 15s
      keepaliveCountMax: 4,       // Drop after 4 failed keepalives (60s)
    };

    // Auth: key file preferred, then password
    if (server.keyFile && fs.existsSync(server.keyFile)) {
      connOpts.privateKey = fs.readFileSync(server.keyFile);
    } else if (server.password) {
      connOpts.password = server.password;
    } else {
      return reject(new Error(`No authentication method for server ${serverName}. Set password or keyFile in config.`));
    }

    conn.connect(connOpts);
  });
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute a command on a connected server.
 *
 * @param {Client} conn - ssh2 Client
 * @param {string} command
 * @param {object} [opts] - { timeout, pty }
 * @returns {Promise<{stdout, stderr, code}>}
 */
function execOn(conn, command, opts = {}) {
  const { timeout = 120000, pty = false } = opts;

  return new Promise((resolve, reject) => {
    const execOpts = {};
    if (pty) execOpts.pty = true;

    conn.exec(command, execOpts, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) {}
        reject(new Error(`Command timed out after ${timeout}ms: ${command.slice(0, 100)}`));
      }, timeout);

      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', code => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      });
    });
  });
}

/**
 * Execute a command with sudo.
 * Uses echo-pipe method to pass password to sudo.
 */
async function sudoOn(conn, serverName, command, opts = {}) {
  const server = loadServerConfig(serverName);
  const password = server.password;

  if (!password) {
    throw new Error(`Need server password for sudo on ${serverName}`);
  }

  // Use -S flag to read password from stdin
  const sudoCmd = `echo '${password.replace(/'/g, "'\\''")}' | sudo -S bash -c '${command.replace(/'/g, "'\\''")}'`;
  return execOn(conn, sudoCmd, { ...opts, pty: true });
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Close connection to a specific server.
 */
function closeConn(serverName) {
  if (pool.has(serverName)) {
    const { conn } = pool.get(serverName);
    try { conn.end(); } catch (e) {}
    pool.delete(serverName);
    return true;
  }
  return false;
}

/**
 * Close all pooled connections.
 */
function closeAll() {
  for (const [name, { conn }] of pool) {
    try { conn.end(); } catch (e) {}
  }
  pool.clear();
}

/**
 * Get pool status (for debugging).
 */
function getPoolStatus() {
  const status = {};
  for (const [name, { conn, lastUsed }] of pool) {
    status[name] = {
      alive: conn._sock && !conn._sock.destroyed,
      lastUsedMs: Date.now() - lastUsed,
    };
  }
  return status;
}

/**
 * Quick connectivity check — returns true if server is reachable via SSH.
 */
async function isReachable(serverName = 'jupiter') {
  try {
    const conn = await getConn(serverName, { maxRetries: 1 });
    const result = await execOn(conn, 'echo ok');
    return result.stdout === 'ok';
  } catch (e) {
    return false;
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  getConn,
  execOn,
  sudoOn,
  closeConn,
  closeAll,
  getPoolStatus,
  isReachable,
  loadServerConfig,
};
