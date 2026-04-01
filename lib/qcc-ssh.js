/**
 * QCC SSH Connection Pool — Persistent SSH connections with heartbeat monitoring
 *
 * Manages SSH connections to all compute nodes, with auto-reconnect,
 * heartbeat keepalive, and ProxyJump support for Saturn (via Jupiter).
 *
 * Neptune is treated as localhost (no SSH needed).
 *
 * Connection strategy:
 *   1. Try ssh2 (Node native) with corrected config
 *   2. Fallback to Python paramiko via utils/ssh_exec.py subprocess
 */

const { Client } = require('ssh2');
const { readFileSync, existsSync } = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Load remote_servers.json for correct usernames/passwords as fallback
const SERVERS_CONFIG_PATH = path.join(__dirname, '..', 'config', 'remote_servers.json');
const SSH_EXEC_PY = path.join(__dirname, '..', 'utils', 'ssh_exec.py');

function _loadServersJson() {
  try {
    if (existsSync(SERVERS_CONFIG_PATH)) {
      return JSON.parse(readFileSync(SERVERS_CONFIG_PATH, 'utf8')).servers || {};
    }
  } catch (e) { /* ignore */ }
  return {};
}

class QCCSSHPool {
  constructor(db) {
    this.db = db;
    this._dbClosed = false;
    // Map: node_name -> { client, connected, local, lastHeartbeat, error, method }
    this.connections = new Map();
    this.heartbeatInterval = null;
    this._reconnecting = new Set(); // prevent concurrent reconnect attempts
    this._serversJson = _loadServersJson();
    this._paramikoAvailable = null; // cached check
  }

  /**
   * Initialize the pool. Fixes DB usernames from remote_servers.json if mismatched.
   */
  init() {
    this._fixDBUsernames();
  }

  /**
   * Fix DB ssh_user entries that were incorrectly set to 'footb' for all nodes.
   * Reads the correct usernames from remote_servers.json.
   */
  _fixDBUsernames() {
    const correctUsers = {
      jupiter: this._serversJson.jupiter?.user || 'jupiter',
      uranus: this._serversJson.uranus?.user || 'nick',
      saturn: this._serversJson.saturn?.user || 'saturn',
      razer: this._serversJson.razer?.user || 'claude',
    };

    for (const [nodeName, correctUser] of Object.entries(correctUsers)) {
      try {
        const node = this.db.getNode(nodeName);
        if (node && node.ssh_user !== correctUser) {
          this.db.db.prepare(
            'UPDATE compute_nodes SET ssh_user = ?, updated_at = datetime(\'now\') WHERE name = ?'
          ).run(correctUser, nodeName);
        }
      } catch (e) { /* node may not exist */ }
    }
  }

  /** Safe wrapper for db.updateNodeStatus — no-ops if DB is closed */
  _safeUpdateNodeStatus(nodeName, status, gpuUtil = null, gpuMemMb = null, ramPct = null, gpuPowerW = null, gpuPowerLimitW = null) {
    if (this._dbClosed) return;
    try {
      this.db.updateNodeStatus(nodeName, status, gpuUtil, gpuMemMb, ramPct, gpuPowerW, gpuPowerLimitW);
    } catch (e) {
      // DB was closed between check and call — mark closed to skip future calls
      this._dbClosed = true;
    }
  }

  /**
   * Get SSH config for a node from the database
   */
  getNodeConfig(nodeName) {
    return this.db.getNode(nodeName);
  }

  /**
   * Build ssh2 connection config from node record.
   * Key fixes vs original: disable agent, increase timeouts, set algorithms.
   */
  _buildSSHConfig(node) {
    // Resolve correct username: DB > remote_servers.json > fallback
    const serverJson = this._serversJson[node.name];
    const username = node.ssh_user || serverJson?.user || 'footb';

    const config = {
      host: node.tailscale_ip || node.host,
      port: node.port || 22,
      username,
      readyTimeout: 30000,        // was 10000 — match paramiko's 30s
      keepaliveInterval: 10000,   // was 30000 — more frequent keepalive
      keepaliveCountMax: 3,
      // Critical: disable SSH agent and host-based auth (matches paramiko's allow_agent=False)
      agent: false,
      agentForward: false,
      tryKeyboard: false,
      // Explicit algorithm list for compatibility with OpenSSH on Windows
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
      },
    };

    // Auth: try key first, then password
    if (node.ssh_key_path && (node.ssh_auth_method === 'key' || node.ssh_auth_method === 'both')) {
      try {
        // Resolve ~ to home directory
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const keyPath = node.ssh_key_path.replace(/^~[/\\]?/, home + path.sep);
        if (existsSync(keyPath)) {
          config.privateKey = readFileSync(keyPath);
        }
      } catch (e) {
        // Key not readable, fall through to password
      }
    }

    // Also try default key locations if no explicit key configured
    if (!config.privateKey) {
      const defaultKeys = [
        path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_ed25519'),
        path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_rsa'),
      ];
      for (const keyPath of defaultKeys) {
        try {
          if (existsSync(keyPath)) {
            config.privateKey = readFileSync(keyPath);
            break;
          }
        } catch (e) { /* ignore */ }
      }
    }

    // Password auth
    const password = node.ssh_password || serverJson?.password;
    if (password) {
      config.password = password;
    }

    return config;
  }

  /**
   * Check if Python paramiko is available for fallback.
   */
  _checkParamiko() {
    if (this._paramikoAvailable !== null) return this._paramikoAvailable;
    try {
      execSync('python -c "import paramiko"', { timeout: 5000, stdio: 'ignore', windowsHide: true });
      this._paramikoAvailable = true;
    } catch (e) {
      try {
        execSync('python3 -c "import paramiko"', { timeout: 5000, stdio: 'ignore', windowsHide: true });
        this._paramikoAvailable = true;
      } catch (e2) {
        this._paramikoAvailable = false;
      }
    }
    return this._paramikoAvailable;
  }

  /**
   * Execute a command via Python paramiko subprocess (fallback).
   * Uses utils/ssh_exec.py which is known to work.
   */
  _execViaParamiko(nodeName, command, timeoutMs = 30000) {
    try {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      // Escape the command for shell
      const escapedCmd = command.replace(/"/g, '\\"');
      const fullCmd = `${pythonCmd} "${SSH_EXEC_PY}" --server ${nodeName} --timeout ${Math.floor(timeoutMs / 1000)} "${escapedCmd}"`;

      let stdout = execSync(fullCmd, {
        timeout: timeoutMs + 5000, // extra buffer for Python startup
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      // ssh_exec.py prints "[servername]" as first line — strip it
      const prefixLine = `[${nodeName}]`;
      if (stdout.startsWith(prefixLine)) {
        stdout = stdout.slice(prefixLine.length).replace(/^\r?\n/, '');
      }

      return { stdout, stderr: '', exitCode: 0 };
    } catch (e) {
      let stdout = e.stdout || '';
      // Strip prefix from error output too
      const prefixLine = `[${nodeName}]`;
      if (stdout.startsWith(prefixLine)) {
        stdout = stdout.slice(prefixLine.length).replace(/^\r?\n/, '');
      }
      return {
        stdout,
        stderr: e.stderr || e.message,
        exitCode: e.status || 1,
      };
    }
  }

  /**
   * Connect to a compute node. Neptune is always local.
   * Returns true on success, false on failure.
   */
  async connect(nodeName) {
    const node = this.getNodeConfig(nodeName);
    if (!node) throw new Error(`Unknown node: ${nodeName}`);

    // Neptune is localhost -- no SSH needed
    if (node.name === 'neptune') {
      this.connections.set('neptune', {
        client: null,
        connected: true,
        local: true,
        lastHeartbeat: Date.now(),
        error: null,
        method: 'local',
      });
      this._safeUpdateNodeStatus('neptune', 'online');
      return true;
    }

    // Prevent concurrent reconnect attempts
    if (this._reconnecting.has(nodeName)) return false;
    this._reconnecting.add(nodeName);

    try {
      // Close existing connection if any
      const existing = this.connections.get(nodeName);
      if (existing?.client) {
        try { existing.client.end(); } catch (e) { /* ignore */ }
      }

      // Saturn requires ProxyJump through Jupiter
      if (node.hop_through) {
        const ok = await this._connectViaJumpHost(node);
        if (ok) return true;
        // Jump host via ssh2 failed, try paramiko fallback
        return this._connectViaParamiko(nodeName);
      }

      // Try ssh2 direct connection first
      const ok = await this._connectDirect(node);
      if (ok) return true;

      // ssh2 failed — try paramiko fallback
      return this._connectViaParamiko(nodeName);
    } finally {
      this._reconnecting.delete(nodeName);
    }
  }

  /**
   * Mark a node as using paramiko fallback (no persistent connection,
   * each exec() call will spawn a subprocess).
   */
  _connectViaParamiko(nodeName) {
    if (!this._checkParamiko()) {
      // No paramiko either
      return false;
    }

    // Test paramiko connection with a simple command
    const result = this._execViaParamiko(nodeName, 'echo __paramiko_ok__', 15000);
    if (result.exitCode === 0 && result.stdout.includes('__paramiko_ok__')) {
      this.connections.set(nodeName, {
        client: null,
        connected: true,
        local: false,
        lastHeartbeat: Date.now(),
        error: null,
        method: 'paramiko', // flag: use paramiko subprocess for all exec
      });
      this._safeUpdateNodeStatus(nodeName, 'online');
      return true;
    }

    // Paramiko also failed
    this.connections.set(nodeName, {
      client: null,
      connected: false,
      local: false,
      lastHeartbeat: Date.now(),
      error: `ssh2 and paramiko both failed. Paramiko: ${result.stderr.slice(0, 200)}`,
      method: null,
    });
    this._safeUpdateNodeStatus(nodeName, 'offline');
    return false;
  }

  /**
   * Direct SSH connection (no jump host)
   */
  async _connectDirect(node) {
    const sshConfig = this._buildSSHConfig(node);

    return new Promise((resolve) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        try { client.end(); } catch (e) { /* ignore */ }
        this.connections.set(node.name, {
          client: null,
          connected: false,
          local: false,
          lastHeartbeat: Date.now(),
          error: 'ssh2 connection timeout (30s)',
          method: null,
        });
        resolve(false);
      }, 35000); // slightly longer than readyTimeout

      client.on('ready', () => {
        clearTimeout(timeout);
        this.connections.set(node.name, {
          client,
          connected: true,
          local: false,
          lastHeartbeat: Date.now(),
          error: null,
          method: 'ssh2',
        });
        this._safeUpdateNodeStatus(node.name, 'online');
        resolve(true);
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        this.connections.set(node.name, {
          client: null,
          connected: false,
          local: false,
          lastHeartbeat: Date.now(),
          error: `ssh2: ${err.message}`,
          method: null,
        });
        resolve(false);
      });

      client.on('close', () => {
        const entry = this.connections.get(node.name);
        if (entry && entry.method === 'ssh2') {
          entry.connected = false;
          entry.client = null;
        }
      });

      client.on('end', () => {
        const entry = this.connections.get(node.name);
        if (entry && entry.method === 'ssh2') {
          entry.connected = false;
          entry.client = null;
        }
      });

      try {
        client.connect(sshConfig);
      } catch (e) {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  /**
   * Connect via a jump host (ProxyJump). Used for Saturn -> Jupiter.
   */
  async _connectViaJumpHost(node) {
    const jumpNode = this.getNodeConfig(node.hop_through);
    if (!jumpNode) {
      this.connections.set(node.name, {
        client: null,
        connected: false,
        local: false,
        lastHeartbeat: Date.now(),
        error: `Jump host '${node.hop_through}' not found in database`,
        method: null,
      });
      this._safeUpdateNodeStatus(node.name, 'offline');
      return false;
    }

    // Ensure jump host is connected via ssh2 (not paramiko — we need the client object)
    const jumpEntry = this.connections.get(node.hop_through);
    if (!jumpEntry?.connected || !jumpEntry?.client || jumpEntry?.method !== 'ssh2') {
      // Try to get an ssh2 connection to the jump host
      const existing = this.connections.get(node.hop_through);
      if (existing?.client) {
        try { existing.client.end(); } catch (e) { /* ignore */ }
      }
      const jumpOk = await this._connectDirect(jumpNode);
      if (!jumpOk) {
        this.connections.set(node.name, {
          client: null,
          connected: false,
          local: false,
          lastHeartbeat: Date.now(),
          error: `Jump host '${node.hop_through}' ssh2 connection failed`,
          method: null,
        });
        return false;
      }
    }

    const jumpClient = this.connections.get(node.hop_through)?.client;
    if (!jumpClient) {
      return false;
    }

    // Open a forwarding channel through the jump host
    return new Promise((resolve) => {
      const targetHost = node.host; // Saturn's LAN IP (10.0.0.2)
      const targetPort = node.port || 22;

      const overallTimeout = setTimeout(() => {
        this.connections.set(node.name, {
          client: null,
          connected: false,
          local: false,
          lastHeartbeat: Date.now(),
          error: 'ProxyJump timeout (30s)',
          method: null,
        });
        resolve(false);
      }, 30000);

      jumpClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
        if (err) {
          clearTimeout(overallTimeout);
          this.connections.set(node.name, {
            client: null,
            connected: false,
            local: false,
            lastHeartbeat: Date.now(),
            error: `ProxyJump forward failed: ${err.message}`,
            method: null,
          });
          resolve(false);
          return;
        }

        // Now connect through the tunnel
        const targetConfig = this._buildSSHConfig(node);
        delete targetConfig.host;
        delete targetConfig.port;
        targetConfig.sock = stream;

        const targetClient = new Client();

        targetClient.on('ready', () => {
          clearTimeout(overallTimeout);
          this.connections.set(node.name, {
            client: targetClient,
            connected: true,
            local: false,
            lastHeartbeat: Date.now(),
            error: null,
            method: 'ssh2',
            jumpStream: stream, // keep reference to prevent GC
          });
          this._safeUpdateNodeStatus(node.name, 'online');
          resolve(true);
        });

        targetClient.on('error', (err2) => {
          clearTimeout(overallTimeout);
          this.connections.set(node.name, {
            client: null,
            connected: false,
            local: false,
            lastHeartbeat: Date.now(),
            error: `ProxyJump target error: ${err2.message}`,
            method: null,
          });
          resolve(false);
        });

        targetClient.on('close', () => {
          const entry = this.connections.get(node.name);
          if (entry) {
            entry.connected = false;
            entry.client = null;
          }
        });

        try {
          targetClient.connect(targetConfig);
        } catch (e) {
          clearTimeout(overallTimeout);
          resolve(false);
        }
      });
    });
  }

  /**
   * Execute a command on a node. Auto-reconnects if disconnected.
   * Returns { stdout, stderr, exitCode }.
   */
  async exec(nodeName, command, timeoutMs = 30000) {
    const entry = this.connections.get(nodeName);

    // Neptune = local execution
    if (entry?.local || nodeName === 'neptune') {
      try {
        const stdout = execSync(command, {
          timeout: timeoutMs,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024, // 10MB
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

    // Paramiko-mode nodes: always use subprocess
    if (entry?.connected && entry?.method === 'paramiko') {
      return this._execViaParamiko(nodeName, command, timeoutMs);
    }

    // Check ssh2 connection, reconnect if needed
    if (!entry?.connected || !entry?.client) {
      const ok = await this.connect(nodeName);
      if (!ok) {
        const connEntry = this.connections.get(nodeName);
        return {
          stdout: '',
          stderr: `Cannot connect to ${nodeName}: ${connEntry?.error || 'unknown error'}`,
          exitCode: -1,
        };
      }
      // After reconnect, check if we ended up in paramiko mode
      const newEntry = this.connections.get(nodeName);
      if (newEntry?.method === 'paramiko') {
        return this._execViaParamiko(nodeName, command, timeoutMs);
      }
    }

    // Try ssh2 exec
    const result = await this._execOnClient(nodeName, command, timeoutMs);

    // If ssh2 exec failed with connection error, try paramiko fallback
    if (result.exitCode === -1 && result.stderr && !result.stdout) {
      if (this._checkParamiko()) {
        const paraResult = this._execViaParamiko(nodeName, command, timeoutMs);
        if (paraResult.exitCode !== 1 || paraResult.stdout) {
          // Paramiko worked, switch this node to paramiko mode
          this.connections.set(nodeName, {
            client: null,
            connected: true,
            local: false,
            lastHeartbeat: Date.now(),
            error: null,
            method: 'paramiko',
          });
          this._safeUpdateNodeStatus(nodeName, 'online');
          return paraResult;
        }
      }
    }

    return result;
  }

  /**
   * Execute a command on an already-connected ssh2 client.
   */
  _execOnClient(nodeName, command, timeoutMs) {
    return new Promise((resolve) => {
      const conn = this.connections.get(nodeName);
      if (!conn?.client || !conn.connected) {
        resolve({ stdout: '', stderr: `${nodeName} not connected`, exitCode: -1 });
        return;
      }

      const timer = setTimeout(() => {
        resolve({ stdout: '', stderr: `Command timed out after ${timeoutMs}ms`, exitCode: -1 });
      }, timeoutMs);

      conn.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          // Connection may have dropped
          conn.connected = false;
          resolve({ stdout: '', stderr: err.message, exitCode: -1 });
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code, signal) => {
          clearTimeout(timer);
          conn.lastHeartbeat = Date.now();
          resolve({
            stdout,
            stderr,
            exitCode: code != null ? code : (signal ? -1 : 0),
          });
        });

        stream.on('error', (streamErr) => {
          clearTimeout(timer);
          resolve({ stdout, stderr: stderr + streamErr.message, exitCode: -1 });
        });
      });
    });
  }

  /**
   * Run heartbeat check on all nodes.
   * Pings connected nodes, attempts reconnection for disconnected ones.
   */
  async heartbeat() {
    const nodes = this.db.getNodes();
    const results = {};

    for (const node of nodes) {
      if (node.name === 'neptune') {
        // Local heartbeat - always online
        this._safeUpdateNodeStatus('neptune', 'online');
        results.neptune = { status: 'online', local: true };
        continue;
      }

      const entry = this.connections.get(node.name);

      if (!entry?.connected) {
        // Try connecting
        const ok = await this.connect(node.name);
        const connEntry = this.connections.get(node.name);
        results[node.name] = {
          status: ok ? 'online' : 'offline',
          method: connEntry?.method || null,
          reconnected: ok,
          error: ok ? null : connEntry?.error,
        };
        continue;
      }

      // Send heartbeat command (simple echo)
      const result = await this.exec(node.name, 'echo ok', 10000);
      if (result.exitCode === 0 && result.stdout.trim().includes('ok')) {
        this._safeUpdateNodeStatus(node.name, 'online');
        results[node.name] = { status: 'online', method: entry.method };
      } else {
        this._safeUpdateNodeStatus(node.name, 'offline');
        entry.connected = false;
        entry.client = null;
        // Try reconnecting
        const ok = await this.connect(node.name);
        const connEntry = this.connections.get(node.name);
        results[node.name] = {
          status: ok ? 'online' : 'offline',
          method: connEntry?.method || null,
          reconnected: ok,
          error: ok ? null : result.stderr,
        };
      }
    }

    return results;
  }

  /**
   * Get GPU status for a node via nvidia-smi.
   * Returns { gpu_util, gpu_mem_used_mb, gpu_mem_total_mb, gpu_temp, gpu_power_w, gpu_power_limit_w } or null on failure.
   * Power fields will be null if the GPU does not support power reporting.
   */
  async getGPUStatus(nodeName) {
    const node = this.getNodeConfig(nodeName);
    if (!node?.gpu || node.gpu === 'none') {
      return null; // No GPU on this node
    }

    // Query utilization, memory, temperature, and power in a single nvidia-smi call
    const cmd = 'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits';
    const result = await this.exec(nodeName, cmd, 10000);

    if (result.exitCode !== 0) return null;

    const line = result.stdout.trim().split('\n')[0]; // First GPU
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 4) return null;

    // Parse power fields — some GPUs report "[N/A]" or empty, handle gracefully
    let gpuPowerW = null;
    let gpuPowerLimitW = null;
    if (parts.length >= 6) {
      const rawPower = parseFloat(parts[4]);
      const rawLimit = parseFloat(parts[5]);
      if (!isNaN(rawPower)) gpuPowerW = rawPower;
      if (!isNaN(rawLimit)) gpuPowerLimitW = rawLimit;
    }

    const status = {
      gpu_util: parseFloat(parts[0]) || 0,
      gpu_mem_used_mb: parseInt(parts[1]) || 0,
      gpu_mem_total_mb: parseInt(parts[2]) || 0,
      gpu_temp: parseInt(parts[3]) || 0,
      gpu_power_w: gpuPowerW,
      gpu_power_limit_w: gpuPowerLimitW,
    };

    // Update database with latest GPU stats (including power)
    this._safeUpdateNodeStatus(
      nodeName,
      status.gpu_util > 50 ? 'training' : 'idle',
      status.gpu_util,
      status.gpu_mem_used_mb,
      null,
      gpuPowerW,
      gpuPowerLimitW
    );

    return status;
  }

  /**
   * Get connection status summary for all nodes.
   */
  getConnectionStatus() {
    const nodes = this.db.getNodes();
    return nodes.map(node => {
      const entry = this.connections.get(node.name);
      return {
        name: node.name,
        connected: entry?.connected || false,
        local: entry?.local || false,
        method: entry?.method || null,
        lastHeartbeat: entry?.lastHeartbeat ? new Date(entry.lastHeartbeat).toISOString() : null,
        error: entry?.error || null,
      };
    });
  }

  /**
   * Start periodic heartbeat checks.
   * @param {number} intervalMs - Interval between heartbeats (default 60s)
   */
  startHeartbeat(intervalMs = 60000) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.heartbeat().catch(err => {
        // Heartbeat errors should not crash the server
        try { process.stderr.write(`QCC SSH heartbeat error: ${err.message}\n`); } catch (e) {}
      });
    }, intervalMs);

    // Run initial heartbeat
    this.heartbeat().catch(err => {
      try { process.stderr.write(`QCC SSH initial heartbeat error: ${err.message}\n`); } catch (e) {}
    });
  }

  /**
   * Stop periodic heartbeat checks.
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Disconnect a specific node.
   */
  disconnect(nodeName) {
    const entry = this.connections.get(nodeName);
    if (entry?.client) {
      try { entry.client.end(); } catch (e) { /* ignore */ }
    }
    this.connections.delete(nodeName);
  }

  /**
   * Shut down all connections and stop heartbeat.
   */
  destroy() {
    this._dbClosed = true; // Prevent any further DB writes from callbacks
    this.stopHeartbeat();
    for (const [name, entry] of this.connections) {
      if (entry.client) {
        try { entry.client.end(); } catch (e) { /* ignore */ }
      }
    }
    this.connections.clear();
  }
}

module.exports = { QCCSSHPool };
