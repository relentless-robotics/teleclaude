#!/usr/bin/env node
/**
 * Ray + MLflow + Cluster MCP Server
 *
 * Provides tools for interacting with:
 *   - Ray cluster (192.168.0.108:8265) — job submission, status, node info
 *   - MLflow (localhost:5000) — experiment/run search, best-run lookup
 *   - Cluster nodes — health checks, command execution via Flask APIs
 *
 * Tools:
 *   Ray:     ray_status, ray_submit_task, ray_job_status, ray_list_jobs
 *   MLflow:  mlflow_list_experiments, mlflow_search_runs, mlflow_get_best_run
 *   Cluster: cluster_health, node_exec
 */

'use strict';

const http = require('http');
const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const RAY_HOST = '192.168.0.108';
const RAY_PORT = 8265;
const MLFLOW_HOST = '127.0.0.1';
const MLFLOW_PORT = 5000;

// Flask API endpoints per node (port 5050 by default — adjust to match actual deployment)
const NODE_FLASK = {
  neptune: { host: 'localhost',         port: 5050 },
  uranus:  { host: '100.100.83.37',     port: 5050 },
  razer:   { host: '100.102.215.75',    port: 5050 },
  jupiter: { host: '192.168.0.108',     port: 5050 },
  saturn:  { host: '100.101.101.9',     port: 5050 },
};

// QCC daemon (local)
const QCC_HOST = 'localhost';
const QCC_PORT = 3456;

// ── Logging ──────────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = path.join(LOGS_DIR, `mcp-ray-mlflow-${new Date().toISOString().split('T')[0]}.log`);

function log(level, msg, data) {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] ${msg}`;
  if (data !== undefined) {
    try { line += `\n  ${JSON.stringify(data)}`; } catch (_) {}
  }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Make an HTTP/HTTPS request and return { statusCode, body (parsed JSON or raw string) }.
 */
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed, raw });
      });
    });
    req.setTimeout(options.timeout || 15000, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${options.timeout || 15000}ms`));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function get(host, port, urlPath, timeout = 12000) {
  return httpRequest({ hostname: host, port, path: urlPath, method: 'GET',
    headers: { 'Accept': 'application/json', 'Host': `${host}:${port}` }, timeout });
}

function post(host, port, urlPath, payload, timeout = 12000) {
  const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return httpRequest({
    hostname: host, port, path: urlPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'Host': `${host}:${port}` },
    timeout
  }, bodyStr);
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function ray_status() {
  const errors = [];
  let clusterInfo = null;
  let nodesInfo = null;

  try {
    const res = await get(RAY_HOST, RAY_PORT, '/api/cluster_status', 10000);
    if (res.statusCode === 200) clusterInfo = res.body;
    else errors.push(`cluster_status HTTP ${res.statusCode}`);
  } catch (e) {
    errors.push(`cluster_status: ${e.message}`);
  }

  try {
    const res = await get(RAY_HOST, RAY_PORT, '/nodes?view=summary', 10000);
    if (res.statusCode === 200) nodesInfo = res.body;
    else {
      // try alternate path
      const res2 = await get(RAY_HOST, RAY_PORT, '/api/v0/nodes', 10000);
      if (res2.statusCode === 200) nodesInfo = res2.body;
      else errors.push(`nodes HTTP ${res.statusCode}`);
    }
  } catch (e) {
    errors.push(`nodes: ${e.message}`);
  }

  const result = { ray_host: `${RAY_HOST}:${RAY_PORT}`, cluster_status: clusterInfo, nodes: nodesInfo };
  if (errors.length) result.errors = errors;
  return result;
}

async function ray_submit_task({ script_path, node_preference, args: jobArgs }) {
  if (!script_path) return { error: 'script_path is required' };

  // Convert Windows paths to Unix paths for WSL-based Ray head node
  let unixPath = script_path.replace(/\\/g, '/');
  // Map Windows drive paths to WSL mount points
  // C:\Users\Footb\... → /mnt/c/Users/Footb/...
  unixPath = unixPath.replace(/^([A-Z]):\//, (_, drive) => `/mnt/${drive.toLowerCase()}/`);

  // Also convert any Windows paths in args
  let unixArgs = jobArgs || '';
  unixArgs = unixArgs.replace(/([A-Z]):\\([^\s]+)/g, (match, drive, rest) => {
    return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
  });

  const entrypoint = `python3 ${unixPath}${unixArgs ? ' ' + unixArgs : ''}`;
  const payload = {
    entrypoint,
    runtime_env: {},
    metadata: { node_preference: node_preference || 'any' },
  };

  try {
    const res = await post(RAY_HOST, RAY_PORT, '/api/jobs/', payload, 20000);
    if (res.statusCode === 200 || res.statusCode === 201) {
      return { success: true, job_id: res.body?.submission_id || res.body?.job_id, response: res.body };
    }
    return { error: `Ray Jobs API returned HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { error: `Failed to submit job: ${e.message}` };
  }
}

async function ray_job_status({ job_id }) {
  if (!job_id) return { error: 'job_id is required' };
  try {
    const res = await get(RAY_HOST, RAY_PORT, `/api/jobs/${encodeURIComponent(job_id)}`, 10000);
    if (res.statusCode === 200) return res.body;
    return { error: `HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { error: e.message };
  }
}

async function ray_list_jobs() {
  try {
    const res = await get(RAY_HOST, RAY_PORT, '/api/jobs/', 10000);
    if (res.statusCode === 200) {
      const jobs = Array.isArray(res.body) ? res.body : (res.body?.jobs || res.body);
      // Return newest first, cap at 50
      const sorted = Array.isArray(jobs)
        ? jobs.sort((a, b) => (b.start_time || 0) - (a.start_time || 0)).slice(0, 50)
        : jobs;
      return { count: Array.isArray(sorted) ? sorted.length : '?', jobs: sorted };
    }
    return { error: `HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { error: e.message };
  }
}

// ── MLflow ────────────────────────────────────────────────────────────────────

async function mlflow_list_experiments() {
  try {
    const res = await post(MLFLOW_HOST, MLFLOW_PORT,
      '/api/2.0/mlflow/experiments/search',
      { max_results: 200, view_type: 'ACTIVE_ONLY' }, 15000);
    if (res.statusCode === 200) {
      const exps = res.body?.experiments || [];
      return {
        count: exps.length,
        experiments: exps.map(e => ({
          id: e.experiment_id,
          name: e.name,
          artifact_location: e.artifact_location,
          lifecycle_stage: e.lifecycle_stage,
          last_update_time: e.last_update_time,
        }))
      };
    }
    return { error: `HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { error: e.message };
  }
}

async function resolveExperimentId(experiment_name) {
  // First try to get experiment by name
  try {
    const res = await get(MLFLOW_HOST, MLFLOW_PORT,
      `/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(experiment_name)}`, 10000);
    if (res.statusCode === 200 && res.body?.experiment) {
      return res.body.experiment.experiment_id;
    }
  } catch (_) {}

  // Fallback: list all and search
  try {
    const listRes = await post(MLFLOW_HOST, MLFLOW_PORT,
      '/api/2.0/mlflow/experiments/search',
      { max_results: 200, view_type: 'ACTIVE_ONLY' }, 15000);
    if (listRes.statusCode === 200) {
      const exp = (listRes.body?.experiments || []).find(e =>
        e.name === experiment_name || e.name.toLowerCase().includes(experiment_name.toLowerCase())
      );
      return exp?.experiment_id || null;
    }
  } catch (_) {}
  return null;
}

async function mlflow_search_runs({ experiment_name, max_results }) {
  if (!experiment_name) return { error: 'experiment_name is required' };
  const expId = await resolveExperimentId(experiment_name);
  if (!expId) return { error: `Experiment not found: ${experiment_name}` };

  try {
    const payload = {
      experiment_ids: [expId],
      max_results: max_results || 50,
      run_view_type: 'ACTIVE_ONLY',
      order_by: ['attribute.start_time DESC'],
    };
    const res = await post(MLFLOW_HOST, MLFLOW_PORT, '/api/2.0/mlflow/runs/search', payload, 20000);
    if (res.statusCode === 200) {
      const runs = res.body?.runs || [];
      return {
        experiment_id: expId,
        experiment_name,
        count: runs.length,
        runs: runs.map(r => ({
          run_id: r.info?.run_id,
          status: r.info?.status,
          start_time: r.info?.start_time,
          end_time: r.info?.end_time,
          artifact_uri: r.info?.artifact_uri,
          metrics: r.data?.metrics || {},
          params: r.data?.params || {},
          tags: r.data?.tags || {},
        }))
      };
    }
    return { error: `HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { error: e.message };
  }
}

async function mlflow_get_best_run({ experiment_name, metric, order }) {
  if (!experiment_name || !metric) return { error: 'experiment_name and metric are required' };
  const expId = await resolveExperimentId(experiment_name);
  if (!expId) return { error: `Experiment not found: ${experiment_name}` };

  const ascending = (order || 'desc').toLowerCase() === 'asc';
  const orderClause = ascending ? `metrics.${metric} ASC` : `metrics.${metric} DESC`;

  try {
    const payload = {
      experiment_ids: [expId],
      max_results: 1,
      run_view_type: 'ACTIVE_ONLY',
      order_by: [orderClause],
      filter: `metrics.${metric} > -999999`,  // must have the metric
    };
    const res = await post(MLFLOW_HOST, MLFLOW_PORT, '/api/2.0/mlflow/runs/search', payload, 20000);
    if (res.statusCode === 200) {
      const runs = res.body?.runs || [];
      if (!runs.length) return { error: `No runs with metric '${metric}' in experiment '${experiment_name}'` };
      const r = runs[0];
      return {
        experiment_id: expId,
        experiment_name,
        metric,
        order: order || 'desc',
        best_value: r.data?.metrics?.[metric],
        run_id: r.info?.run_id,
        status: r.info?.status,
        start_time: r.info?.start_time,
        metrics: r.data?.metrics || {},
        params: r.data?.params || {},
      };
    }
    return { error: `HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Cluster / Node tools ──────────────────────────────────────────────────────

async function cluster_health() {
  const results = {};

  // QCC daemon health
  try {
    const res = await get(QCC_HOST, QCC_PORT, '/api/health', 8000);
    results.qcc_daemon = { status: res.statusCode === 200 ? 'up' : 'error', data: res.body };
  } catch (e) {
    results.qcc_daemon = { status: 'unreachable', error: e.message };
  }

  // Per-node Flask API health checks
  const nodeChecks = Object.entries(NODE_FLASK).map(async ([nodeName, cfg]) => {
    try {
      const res = await get(cfg.host, cfg.port, '/health', 6000);
      results[nodeName] = {
        status: res.statusCode === 200 ? 'up' : `http_${res.statusCode}`,
        host: cfg.host,
        port: cfg.port,
        data: res.body,
      };
    } catch (e) {
      results[nodeName] = {
        status: 'unreachable',
        host: cfg.host,
        port: cfg.port,
        error: e.message,
      };
    }
  });

  await Promise.all(nodeChecks);

  const upCount = Object.values(results).filter(v => v.status === 'up').length;
  const totalCount = Object.keys(results).length;
  return { summary: `${upCount}/${totalCount} services up`, timestamp: new Date().toISOString(), nodes: results };
}

async function node_exec({ node, command }) {
  if (!node || !command) return { error: 'node and command are required' };
  const cfg = NODE_FLASK[node.toLowerCase()];
  if (!cfg) {
    return { error: `Unknown node '${node}'. Valid: ${Object.keys(NODE_FLASK).join(', ')}` };
  }

  try {
    const payload = { command };
    const res = await post(cfg.host, cfg.port, '/exec', payload, 30000);
    if (res.statusCode === 200) return { node, command, result: res.body };
    return { node, command, error: `HTTP ${res.statusCode}`, body: res.body };
  } catch (e) {
    return { node, command, error: e.message };
  }
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ray_status',
    description: 'Get Ray cluster status — nodes, resources, running tasks. Queries the Ray dashboard API at 192.168.0.108:8265.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'ray_submit_task',
    description: 'Submit a Python script as a job to the Ray cluster. Returns job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        script_path: { type: 'string', description: 'Absolute path to Python script on the Ray node' },
        node_preference: { type: 'string', description: 'Scheduling hint: gpu, cpu, or any (default: any)' },
        args: { type: 'string', description: 'Additional CLI arguments to pass to the script' }
      },
      required: ['script_path']
    }
  },
  {
    name: 'ray_job_status',
    description: 'Get status of a specific Ray job by job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Ray job submission ID' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'ray_list_jobs',
    description: 'List recent Ray jobs (newest first, up to 50).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mlflow_list_experiments',
    description: 'List all active MLflow experiments on localhost:5000.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mlflow_search_runs',
    description: 'Search runs in an MLflow experiment. Returns runs newest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment_name: { type: 'string', description: 'Experiment name (partial match supported)' },
        max_results: { type: 'number', description: 'Max runs to return (default 50)' }
      },
      required: ['experiment_name']
    }
  },
  {
    name: 'mlflow_get_best_run',
    description: 'Get the single best run in an MLflow experiment ranked by a metric.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment_name: { type: 'string', description: 'Experiment name' },
        metric: { type: 'string', description: 'Metric key to rank by (e.g. "ic_mean", "sortino", "val_loss")' },
        order: { type: 'string', description: 'asc or desc (default: desc — higher is better)' }
      },
      required: ['experiment_name', 'metric']
    }
  },
  {
    name: 'cluster_health',
    description: 'Full cluster health check — pings QCC daemon and Flask API /health on all 5 nodes (neptune, uranus, razer, jupiter, saturn).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'node_exec',
    description: 'Execute a shell command on a named compute node via its local Flask API /exec endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node name: neptune, uranus, razer, jupiter, saturn' },
        command: { type: 'string', description: 'Shell command to execute on the node' }
      },
      required: ['node', 'command']
    }
  },
];

// ── MCP Protocol ──────────────────────────────────────────────────────────────

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function toolResult(value) {
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }]
  };
}

async function handleToolCall(name, args) {
  log('INFO', `Tool call: ${name}`, args);
  try {
    let result;
    switch (name) {
      case 'ray_status':        result = await ray_status(); break;
      case 'ray_submit_task':   result = await ray_submit_task(args || {}); break;
      case 'ray_job_status':    result = await ray_job_status(args || {}); break;
      case 'ray_list_jobs':     result = await ray_list_jobs(); break;
      case 'mlflow_list_experiments': result = await mlflow_list_experiments(); break;
      case 'mlflow_search_runs':      result = await mlflow_search_runs(args || {}); break;
      case 'mlflow_get_best_run':     result = await mlflow_get_best_run(args || {}); break;
      case 'cluster_health':          result = await cluster_health(); break;
      case 'node_exec':               result = await node_exec(args || {}); break;
      default: return { error: `Unknown tool: ${name}` };
    }
    log('INFO', `Tool result: ${name}`, typeof result === 'object' ? JSON.stringify(result).slice(0, 300) : result);
    return result;
  } catch (e) {
    log('ERROR', `Tool ${name} threw`, e.message);
    return { error: e.message };
  }
}

// ── Main stdin/stdout MCP loop ────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch (e) {
    log('WARN', 'Failed to parse JSON line', trimmed.slice(0, 200));
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ray-mlflow-server', version: '1.0.0' }
      });
      return;
    }

    if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs  = params?.arguments || {};
      const result    = await handleToolCall(toolName, toolArgs);
      respond(id, toolResult(result));
      return;
    }

    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      // No response for notifications
      return;
    }

    // Unknown method
    respondError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    log('ERROR', `Unhandled error for method ${method}`, e.message);
    respondError(id, -32603, `Internal error: ${e.message}`);
  }
});

rl.on('close', () => {
  log('INFO', 'stdin closed — ray-mlflow-server shutting down');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', e.message);
});

log('INFO', 'ray-mlflow-server started');
