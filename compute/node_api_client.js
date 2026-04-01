/**
 * node_api_client.js — Node.js HTTP client for compute node REST API.
 *
 * Wraps all endpoints of node_api_server.py so the QCC, queue_watcher,
 * and researcher agents can talk to nodes over HTTP instead of SSH.
 *
 * Usage:
 *   const NodeAPI = require('./compute/node_api_client');
 *
 *   const jupiter = new NodeAPI('192.168.0.108', 8765, process.env.NODE_API_KEY);
 *   const health  = await jupiter.health();
 *   const result  = await jupiter.exec('python3 scripts/fill_sim.py', { timeout: 120 });
 *   const pid     = await jupiter.exec('python3 train.py', { background: true });
 *   const gpus    = await jupiter.gpu();
 *   const procs   = await jupiter.processes();
 *   await jupiter.upload('/local/script.py', '/home/jupiter/Lvl3Quant/scripts/script.py');
 *   const tail    = await jupiter.logs('/home/jupiter/Lvl3Quant/training.log', 100);
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Pre-configured node pool ──────────────────────────────────────────────────

const NODE_CONFIGS = {
  neptune: { host: 'localhost',       port: 8765 },
  uranus:  { host: '100.100.83.37',   port: 8765 },
  razer:   { host: '100.102.215.75',  port: 8765 },
  jupiter: { host: '192.168.0.108',   port: 8765 },
  saturn:  { host: '10.0.0.2',        port: 8765 },
};

// ── NodeAPI class ─────────────────────────────────────────────────────────────

class NodeAPI {
  /**
   * @param {string} host        — IP address or hostname
   * @param {number} [port=8765] — API server port
   * @param {string} [apiKey]    — Value for X-API-Key header; defaults to NODE_API_KEY env var
   * @param {object} [opts]
   * @param {number}  [opts.defaultTimeout=30000] — Default HTTP timeout in ms
   * @param {boolean} [opts.tls=false]            — Use HTTPS (self-signed OK)
   */
  constructor(host, port = 8765, apiKey = null, opts = {}) {
    this.host    = host;
    this.port    = port;
    this.apiKey  = apiKey || process.env.NODE_API_KEY || '';
    this.timeout = opts.defaultTimeout || 30_000;
    this.tls     = opts.tls || false;
    this._driver = this.tls ? https : http;
    this._base   = `${this.tls ? 'https' : 'http'}://${host}:${port}`;
  }

  // ── Low-level HTTP helpers ─────────────────────────────────────────────────

  /**
   * Generic HTTP request. Returns parsed JSON body.
   * @param {string} method
   * @param {string} urlPath
   * @param {object|null} body
   * @param {object} [extraHeaders]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  _request(method, urlPath, body = null, extraHeaders = {}, timeoutMs = null) {
    const ms = timeoutMs || this.timeout;
    return new Promise((resolve, reject) => {
      const data    = body ? JSON.stringify(body) : null;
      const headers = {
        'Content-Type': 'application/json',
        ...extraHeaders,
      };
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;
      if (data) headers['Content-Length'] = Buffer.byteLength(data);

      const opts = {
        method,
        hostname: this.host,
        port:     this.port,
        path:     urlPath,
        headers,
        timeout:  ms,
        // Allow self-signed certs for HTTPS
        rejectUnauthorized: false,
      };

      const req = this._driver.request(opts, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(raw);
            }
          } else {
            let msg;
            try { msg = JSON.parse(raw); } catch { msg = raw; }
            const err = new Error(
              `HTTP ${res.statusCode} from ${this._base}${urlPath}: ` +
              (typeof msg === 'object' ? (msg.error || JSON.stringify(msg)) : String(raw).slice(0, 200))
            );
            err.statusCode = res.statusCode;
            err.body       = msg;
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${ms}ms: ${method} ${this._base}${urlPath}`));
      });

      if (data) req.write(data);
      req.end();
    });
  }

  _get(urlPath, query = {}, timeoutMs = null) {
    const qs = Object.keys(query).length
      ? '?' + new URLSearchParams(query).toString()
      : '';
    return this._request('GET', urlPath + qs, null, {}, timeoutMs);
  }

  _post(urlPath, body, timeoutMs = null) {
    return this._request('POST', urlPath, body, {}, timeoutMs);
  }

  // ── Multipart upload (binary-safe) ────────────────────────────────────────

  /**
   * Upload a file using multipart/form-data.
   * @param {string} localPath   — Local file path to read
   * @param {string} remotePath  — Destination path on the remote node
   * @returns {Promise<object>}
   */
  upload(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(localPath)) {
        return reject(new Error(`Local file not found: ${localPath}`));
      }

      const boundary   = `----NodeAPIBoundary${Date.now()}`;
      const filename   = path.basename(localPath);
      const fileBuffer = fs.readFileSync(localPath);

      const preamble = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
      );
      const pathPart = Buffer.from(
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="path"\r\n\r\n` +
        `${remotePath}` +
        `\r\n--${boundary}--\r\n`
      );

      const body          = Buffer.concat([preamble, fileBuffer, pathPart]);
      const headers       = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length };
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;

      const opts = {
        method:   'POST',
        hostname: this.host,
        port:     this.port,
        path:     '/upload',
        headers,
        timeout:  120_000,   // uploads can be slow
        rejectUnauthorized: false,
      };

      const req = this._driver.request(opts, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(`Upload HTTP ${res.statusCode}: ${parsed.error || raw}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          } catch {
            reject(new Error(`Upload: non-JSON response: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Upload timed out')); });
      req.write(body);
      req.end();
    });
  }

  // ── Public API methods ─────────────────────────────────────────────────────

  /**
   * GET /health — Node health: GPU, RAM, disk, uptime.
   * No API key required. Use this for liveness checks.
   */
  health() {
    return this._get('/health', {}, 10_000);
  }

  /**
   * GET /gpu — GPU status: util%, memory, power, temperature.
   */
  gpu() {
    return this._get('/gpu', {}, 10_000);
  }

  /**
   * GET /processes — Python processes with command lines.
   */
  processes() {
    return this._get('/processes', {}, 15_000);
  }

  /**
   * POST /exec — Execute a command on the node.
   *
   * @param {string} command — Shell command to run
   * @param {object} [opts]
   * @param {number}  [opts.timeout=60]     — Timeout in seconds (for blocking mode)
   * @param {boolean} [opts.background=false] — If true, launch detached and return PID immediately
   * @param {string}  [opts.cwd]            — Working directory on the remote node
   *
   * @returns {Promise<object>} blocking: {stdout, stderr, exitCode, duration_ms}
   *                            background: {pid, background: true, command, started_at}
   */
  exec(command, opts = {}) {
    const timeout    = opts.timeout    || DEFAULT_EXEC_TIMEOUT_S;
    const background = opts.background || false;
    const cwd        = opts.cwd        || null;
    // HTTP timeout: for blocking exec, give the server timeout + 10s overhead
    const httpMs = background ? 10_000 : (timeout + 10) * 1000;
    return this._post('/exec', { command, timeout, background, cwd }, httpMs);
  }

  /**
   * GET /logs — Tail a log file on the node.
   *
   * @param {string} logPath — Absolute path to log file on the node
   * @param {number} [lines=50]
   */
  logs(logPath, lines = 50) {
    return this._get('/logs', { path: logPath, lines: String(lines) }, 15_000);
  }

  /**
   * GET /queue — Read this node's job queue file.
   * @param {string} [nodeName] — Optional: specify node name (auto-detected otherwise)
   */
  queue(nodeName = null) {
    const q = nodeName ? { node: nodeName } : {};
    return this._get('/queue', q, 10_000);
  }

  /**
   * POST /queue/complete — Mark a job as complete.
   * @param {string} jobId
   * @param {object} [opts]
   * @param {string} [opts.result]    — Result summary (e.g. "IC=0.17")
   * @param {number} [opts.exitCode]
   * @param {string} [opts.node]      — Node name override
   */
  queueComplete(jobId, opts = {}) {
    return this._post('/queue/complete', {
      job_id:    jobId,
      result:    opts.result   || '',
      exit_code: opts.exitCode !== undefined ? opts.exitCode : null,
      node:      opts.node     || null,
    });
  }

  /**
   * Convenience: check if node is reachable. Returns true/false.
   */
  async ping(timeoutMs = 5_000) {
    try {
      await this._get('/health', {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  toString() {
    return `NodeAPI(${this._base})`;
  }
}

// Default execution timeout for blocking commands (seconds)
const DEFAULT_EXEC_TIMEOUT_S = 60;

// ── Factory: get a pre-configured client by node name ─────────────────────────

/**
 * Create a NodeAPI client for a known compute node.
 *
 * @param {string} nodeName — 'neptune', 'uranus', 'razer', 'jupiter', 'saturn'
 * @param {string} [apiKey] — Override API key (defaults to NODE_API_KEY env)
 * @returns {NodeAPI}
 */
function getNode(nodeName, apiKey = null) {
  const cfg = NODE_CONFIGS[nodeName.toLowerCase()];
  if (!cfg) {
    throw new Error(
      `Unknown node: '${nodeName}'. Valid nodes: ${Object.keys(NODE_CONFIGS).join(', ')}`
    );
  }
  return new NodeAPI(cfg.host, cfg.port, apiKey);
}

/**
 * Create clients for ALL nodes. Returns a Map of name -> NodeAPI.
 * @param {string} [apiKey]
 * @returns {Map<string, NodeAPI>}
 */
function getAllNodes(apiKey = null) {
  const map = new Map();
  for (const [name, cfg] of Object.entries(NODE_CONFIGS)) {
    map.set(name, new NodeAPI(cfg.host, cfg.port, apiKey));
  }
  return map;
}

/**
 * Ping all nodes and return a status object.
 * @param {string} [apiKey]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>} { neptune: true, uranus: false, ... }
 */
async function pingAll(apiKey = null, timeoutMs = 5_000) {
  const results = {};
  const nodes   = getAllNodes(apiKey);
  await Promise.all(
    Array.from(nodes.entries()).map(async ([name, api]) => {
      results[name] = await api.ping(timeoutMs);
    })
  );
  return results;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  NodeAPI,
  NODE_CONFIGS,
  getNode,
  getAllNodes,
  pingAll,
};
