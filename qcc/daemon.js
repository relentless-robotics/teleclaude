#!/usr/bin/env node
/**
 * QCC Daemon — Persistent Quant Command Center
 *
 * Runs independently of Claude as a standalone process (via PM2).
 * Provides:
 *   1. HTTP server for dashboard + health API (port 3456)
 *   2. Continuous compute node monitoring (SSH heartbeat every 60s)
 *   3. GPU utilization tracking and idle detection
 *   4. Training progress monitoring
 *   5. Discord webhook alerts for critical events
 *   6. JSON-RPC endpoint so Claude can connect as MCP client
 *
 * Usage:
 *   node qcc/daemon.js                    # Direct run
 *   pm2 start qcc/ecosystem.config.js     # PM2 managed
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// Paths relative to project root
const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const DB_PATH = path.join(DATA_DIR, 'qcc.db');
const PAPER_STATE_PATH = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\live_trading\\logs\\paper\\live_state.json';
const DASHBOARD_DIR = path.join(BASE_DIR, 'quant_dashboard');

// Config
const HTTP_PORT = parseInt(process.env.QCC_PORT || '3456', 10);
const HEARTBEAT_INTERVAL = parseInt(process.env.QCC_HEARTBEAT_MS || '60000', 10);
const GPU_CHECK_INTERVAL = parseInt(process.env.QCC_GPU_CHECK_MS || '120000', 10);
const TRAINING_CHECK_INTERVAL = parseInt(process.env.QCC_TRAINING_CHECK_MS || '300000', 10);
const JOB_DISPATCH_INTERVAL = parseInt(process.env.QCC_JOB_DISPATCH_MS || '30000', 10);
const PIPELINE_CHECK_INTERVAL = parseInt(process.env.QCC_PIPELINE_CHECK_MS || '600000', 10); // 10 min
const TRAINING_LOG_MONITOR_INTERVAL = parseInt(process.env.QCC_TRAINING_LOG_MONITOR_MS || '900000', 10); // 15 min
const STREAMLIT_PORT = parseInt(process.env.QCC_STREAMLIT_PORT || '8501', 10);

// ========================
// TRADING CALENDAR
// ========================
// ES futures trade Sun 6PM - Fri 5PM ET with daily maintenance 5-6PM ET
// RTH (Regular Trading Hours): Mon-Fri 9:30 AM - 4:00 PM ET
const US_MARKET_HOLIDAYS = [
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
];

function getETNow() {
  // Approximate ET (UTC-4 EDT, UTC-5 EST). For production, use a proper timezone lib.
  return new Date(Date.now() - 4 * 3600000);
}

function isTradingDay(dateOrNull) {
  const d = dateOrNull || getETNow();
  const day = d.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const dateStr = d.toISOString().split('T')[0];
  return !US_MARKET_HOLIDAYS.includes(dateStr);
}

function isRTH(dateOrNull) {
  const d = dateOrNull || getETNow();
  if (!isTradingDay(d)) return false;
  const h = d.getHours();
  const m = d.getMinutes();
  // 9:30 AM - 4:00 PM ET
  if (h < 9 || (h === 9 && m < 30) || h >= 16) return false;
  return true;
}

function isESOpen(dateOrNull) {
  // ES futures open Sun 6PM - Fri 5PM ET (with 5-6PM maintenance daily)
  const d = dateOrNull || getETNow();
  const day = d.getDay();
  const h = d.getHours();
  // Closed: Fri 5PM - Sun 6PM
  if (day === 6) return false; // All Saturday
  if (day === 0 && h < 18) return false; // Sunday before 6PM
  if (day === 5 && h >= 17) return false; // Friday after 5PM
  // Daily maintenance: 5-6PM ET
  if (h === 17) return false;
  return true;
}

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Logging
const LOG_FILE = path.join(LOGS_DIR, `qcc-daemon-${new Date().toISOString().split('T')[0]}.log`);

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch (e) { entry += ' | [unserializable]'; }
  }
  entry += '\n';
  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (e) {}
  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(entry);
  }
}

// ========================
// IMPORTS — reuse existing modules
// ========================

const { QCCDatabase } = require('../lib/qcc-database');
const { QCCSSHPool } = require('../lib/qcc-ssh');
const webhookNotifier = require('../utils/webhook_notifier');
const { eventBus, handleStreamRoute, getActiveStreamCount, destroyAllStreams } = require('./log-stream');

// ========================
// GLOBAL STATE
// ========================

let db = null;
let sshPool = null;
let streamlitProcess = null;
let httpServer = null;

// Track state for alert deduplication
const alertState = {
  nodeDownSince: {},       // node -> timestamp when first detected down
  nodeAlertSent: {},       // node -> timestamp when last alert sent
  gpuIdleSince: {},        // node -> timestamp when GPU first went idle
  gpuIdleAlertSent: {},    // node -> timestamp when last idle alert sent
  lastTrainingState: {},   // job_id -> { status, fold }
  logMonitorAlerts: {},    // key -> { type, timestamp } for dedup of training log monitor alerts
  // Deep GPU health monitoring state
  gpuDataStarvedSince: {}, // node -> timestamp when data-starved condition first detected
  gpuDataStarvedAlertSent: {}, // node -> timestamp when last data-starved alert sent
};

// Per-node GPU metrics cache for power efficiency and batch rate tracking
// nodeName -> { powerW, powerLimitW, efficiency, lastPollTime,
//               logSize, logSizeCheckedAt, logPath,
//               batchNum, batchTime, batchesPerHour, batchAlertSent }
const gpuMetricsCache = {};

// Monitoring intervals
const intervals = [];

// ========================
// INITIALIZATION
// ========================

function initialize() {
  log('INFO', 'QCC Daemon starting...');

  // Init database
  try {
    db = new QCCDatabase(DB_PATH);
    const seeded = db.seedIfEmpty();
    log('INFO', `Database initialized at ${DB_PATH}`, { seeded });
  } catch (e) {
    log('ERROR', 'Failed to initialize database', { error: e.message });
    process.exit(1);
  }

  // Init SSH pool (but don't start heartbeat — we manage our own)
  try {
    sshPool = new QCCSSHPool(db);
    log('INFO', 'SSH pool initialized');
  } catch (e) {
    log('ERROR', 'Failed to initialize SSH pool', { error: e.message });
    process.exit(1);
  }

  // Start HTTP server
  startHTTPServer();

  // Start Streamlit dashboard
  startStreamlitDashboard();

  // Load persisted training log state
  loadTrainingLogState();

  // Start monitoring loops
  startMonitoring();

  // Start MCP stdio bridge (optional, for Claude to connect)
  // Claude connects via stdin/stdout when spawning this as MCP server.
  // When run as daemon, the MCP interface is available via HTTP /mcp endpoint instead.

  log('INFO', `QCC Daemon ready on port ${HTTP_PORT}`);

  // Send startup notification
  sendDiscordAlert('info', 'QCC Daemon Started', `Daemon online at port ${HTTP_PORT}. Monitoring ${db.getNodes().length} compute nodes.`);
}

// ========================
// DISCORD ALERTS
// ========================

async function sendDiscordAlert(type, title, description, fields = []) {
  try {
    await webhookNotifier.notify(type, title, description, fields);
    log('INFO', `Discord alert sent: ${title}`);
  } catch (e) {
    log('WARN', `Discord alert failed: ${e.message}`);
  }
  // Also emit to SSE event bus for live dashboard subscribers
  eventBus.alert(type, 'discord_alert', `${title}: ${description}`);
}

// ========================
// HTTP SERVER
// ========================

function startHTTPServer() {
  httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    const pathname = url.pathname;

    try {
      // API Routes
      if (pathname === '/api/health') {
        return sendJSON(res, await getHealthData());
      }
      if (pathname === '/api/nodes') {
        return sendJSON(res, getNodesData());
      }
      if (pathname === '/api/nodes/live') {
        return sendJSON(res, await getLiveNodesData());
      }
      if (pathname === '/api/training') {
        return sendJSON(res, getTrainingData());
      }
      if (pathname === '/api/models') {
        return sendJSON(res, getModelsData());
      }
      if (pathname === '/api/cards') {
        return sendJSON(res, getCardsData());
      }
      if (pathname === '/api/alerts') {
        return sendJSON(res, getAlertsData());
      }
      if (pathname === '/api/paper') {
        return sendJSON(res, getPaperStatus());
      }
      if (pathname === '/api/sweeps') {
        return sendJSON(res, getSweepsData());
      }
      if (pathname === '/api/research') {
        return sendJSON(res, getResearchData());
      }
      if (pathname === '/api/experiment' && req.method === 'POST') {
        // Accept experiment results from research_harness.py
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const result = db.createExperiment(data);
            sendJSON(res, { message: 'Experiment logged', id: result.id });
          } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      if (pathname === '/api/experiments') {
        const stage = url.searchParams.get('stage');
        const limit = parseInt(url.searchParams.get('limit') || '50');
        return sendJSON(res, db.listExperiments(stage, limit));
      }
      if (pathname === '/api/experiments/leaderboard') {
        const stage = url.searchParams.get('stage');
        const horizon = url.searchParams.get('horizon') ? parseInt(url.searchParams.get('horizon')) : null;
        return sendJSON(res, db.getExperimentLeaderboard(stage, horizon));
      }
      if (pathname === '/api/pipeline') {
        const date = url.searchParams.get('date');
        if (date) {
          return sendJSON(res, db.getPipelineStatus(date));
        }
        return sendJSON(res, db.getPipelineOverview(60));
      }
      if (pathname === '/api/daemon-status') {
        return sendJSON(res, getDaemonStatus());
      }

      // SSH exec endpoint — execute command on a node via persistent QCC SSH pool
      if (pathname.startsWith('/api/ssh/exec') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { node, command, timeout_ms } = JSON.parse(body);
            if (!node || !command) {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'node and command required' }));
            }
            const result = await sshPool.exec(node, command, timeout_ms || 30000);
            sendJSON(res, result);
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // Training registration endpoint — called by remote training scripts
      if (pathname === '/api/training/register' && req.method === 'POST') {
        return handleTrainingRegister(req, res);
      }

      // Scheduled tasks status
      if (pathname === '/api/scheduled-tasks') {
        return sendJSON(res, db.listScheduledTasks());
      }

      // PnL API
      if (pathname === '/api/pnl') {
        // Current PnL for all cards — latest snapshots + today's daily summary
        const snapshots = db.getLatestSnapshots();
        const today = getETDateString(new Date());
        const dailyPnl = db.getDailyPnl(today);
        return sendJSON(res, { snapshots, daily: dailyPnl, date: today });
      }
      if (pathname === '/api/pnl/history') {
        const card = url.searchParams.get('card');
        const days = parseInt(url.searchParams.get('days') || '30', 10);
        if (!card) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'card parameter required' }));
          return;
        }
        const cardRow = db.getCard(card);
        if (!cardRow) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Card '${card}' not found` }));
          return;
        }
        const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const history = db.getPnlHistory(cardRow.id, startDate);
        const drawdown = db.getDrawdown(cardRow.id);
        return sendJSON(res, { card, card_id: cardRow.id, days, history, drawdown });
      }
      if (pathname === '/api/pnl/summary') {
        return sendJSON(res, db.getPerformanceSummary());
      }

      // Job Queue API
      if (pathname === '/api/queue') {
        return sendJSON(res, db.getQueueDepth());
      }
      if (pathname === '/api/jobs' && req.method === 'GET') {
        const status = url.searchParams.get('status') || null;
        const node = url.searchParams.get('node') || null;
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        return sendJSON(res, db.listJobs(status, node, limit));
      }
      if (pathname.match(/^\/api\/jobs\/(\d+)$/) && req.method === 'GET') {
        const jobId = parseInt(pathname.split('/').pop(), 10);
        const job = db.getJobStatus(jobId);
        if (!job) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Job not found' }));
          return;
        }
        return sendJSON(res, job);
      }
      if (pathname === '/api/jobs' && req.method === 'POST') {
        return handleJobSubmit(req, res);
      }
      if (pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/) && req.method === 'POST') {
        const jobId = parseInt(pathname.split('/')[3], 10);
        const result = db.cancelJob(jobId);
        if (result.changes === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Job not found or not in cancellable state' }));
          return;
        }
        return sendJSON(res, { status: 'cancelled', job_id: jobId });
      }

      // Node State History API
      const nodeHistoryMatch = pathname.match(/^\/api\/nodes\/([^/]+)\/history$/);
      if (nodeHistoryMatch && req.method === 'GET') {
        const nodeName = nodeHistoryMatch[1];
        const hours = parseInt(url.searchParams.get('hours') || '24', 10);
        const history = db.getNodeHistory(nodeName, hours);
        return sendJSON(res, { node: nodeName, hours, count: history.length, history });
      }
      const nodeUptimeMatch = pathname.match(/^\/api\/nodes\/([^/]+)\/uptime$/);
      if (nodeUptimeMatch && req.method === 'GET') {
        const nodeName = nodeUptimeMatch[1];
        const days = parseInt(url.searchParams.get('days') || '7', 10);
        const uptime = db.getNodeUptime(nodeName, days);
        return sendJSON(res, uptime);
      }

      // MCP JSON-RPC endpoint (POST /mcp)
      if (pathname === '/mcp' && req.method === 'POST') {
        return handleMCPRequest(req, res);
      }

      // Dashboard redirect — proxy to Streamlit
      if (pathname === '/' || pathname === '/dashboard') {
        res.writeHead(302, { Location: `http://localhost:${STREAMLIT_PORT}` });
        res.end();
        return;
      }

      // Serve static dashboard page (standalone HTML for when Streamlit is down)
      if (pathname === '/status') {
        return serveStatusPage(res);
      }

      // Live WebSocket tick chart — served from quant_dashboard/live_chart.html
      if (pathname === '/live' || pathname === '/live-chart') {
        const chartPath = path.join(DASHBOARD_DIR, 'live_chart.html');
        fs.readFile(chartPath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('live_chart.html not found at ' + chartPath);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
          }
        });
        return;
      }

      // SSE streaming routes: /sse/logs/:jobId, /sse/training/:node, /sse/events, /logs/:jobId
      if (handleStreamRoute(req, res, pathname, db, sshPool, log)) {
        return;
      }

      // Proxy /api/research/* to orchestrator on port 3457
      if (pathname.startsWith('/api/research/')) {
        return proxyToOrchestrator(req, res, url);
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (e) {
      log('ERROR', `HTTP handler error: ${e.message}`, { path: pathname });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    log('INFO', `HTTP server listening on port ${HTTP_PORT}`);
  });

  httpServer.on('error', (e) => {
    log('ERROR', `HTTP server error: ${e.message}`);
    if (e.code === 'EADDRINUSE') {
      log('ERROR', `Port ${HTTP_PORT} already in use. Set QCC_PORT env to change.`);
      process.exit(1);
    }
  });
}

function sendJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Proxy requests to the research orchestrator on port 3457.
 * Falls back gracefully if orchestrator is not running.
 */
function proxyToOrchestrator(req, res, parsedUrl) {
  const orchPort = parseInt(process.env.ORCH_PORT || '3457', 10);
  const options = {
    hostname: '127.0.0.1',
    port: orchPort,
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Research orchestrator unavailable',
      detail: `Could not connect to orchestrator on port ${orchPort}. Is qcc-orchestrator running?`,
      hint: 'pm2 start qcc/ecosystem.config.js',
    }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Orchestrator request timed out' }));
  });

  // Pipe request body for POST/PUT
  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function handleJobSubmit(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      if (!data.job_name || !data.command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'job_name and command are required' }));
        return;
      }
      const result = db.enqueueJob(data);
      log('INFO', `Job enqueued: ${data.job_name} (id=${result.id})`, { job_type: data.job_type, node: data.node_name });
      sendJSON(res, { status: 'queued', job_id: result.id, job_name: data.job_name });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleTrainingRegister(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { node, model_type, description, pid, total_folds, start_fold } = data;
      if (!node) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'node is required' }));
        return;
      }

      // Find or create model entry
      let modelId = null;
      if (model_type) {
        const existing = db.db.prepare(
          "SELECT id FROM models WHERE name = ? AND status = 'training' ORDER BY created_at DESC LIMIT 1"
        ).get(model_type);
        if (existing) {
          modelId = existing.id;
        } else {
          const m = db.registerModel({
            name: model_type,
            architecture: model_type.includes('wider') ? 'wider_cnn'
              : model_type.includes('hybrid') ? 'hybrid' : 'cnn',
            node,
            total_folds: total_folds || null,
            status: 'training',
          });
          modelId = m.id;
        }
      }

      // Check if there's already a running job for this node+pid combo
      if (pid) {
        const existing = db.db.prepare(
          "SELECT id FROM training_jobs WHERE node = ? AND pid = ? AND status = 'running'"
        ).get(node, pid);
        if (existing) {
          sendJSON(res, { status: 'already_registered', job_id: existing.id });
          return;
        }
      }

      const job = db.createTrainingJob({
        model_id: modelId,
        node,
        job_type: 'training',
        description: description || (model_type ? `${model_type} WF` : 'Training job'),
        pid: pid || null,
        start_fold: start_fold || null,
        total_folds: total_folds || null,
        status: 'running',
      });

      log('INFO', `Training job registered via API: ${job.id} on ${node}`, { model_type, pid, total_folds });
      sendJSON(res, { status: 'registered', job_id: job.id, model_id: modelId });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ========================
// API DATA HELPERS
// ========================

async function getHealthData() {
  const health = db.healthCheck();
  let paperStatus = { status: 'unknown' };
  try {
    if (fs.existsSync(PAPER_STATE_PATH)) {
      paperStatus = { status: 'running', state: JSON.parse(fs.readFileSync(PAPER_STATE_PATH, 'utf8')) };
    } else {
      paperStatus = { status: 'not_running' };
    }
  } catch (e) {
    paperStatus = { status: 'error', message: e.message };
  }

  // Enrich nodes with SSH connection status
  const connStatus = sshPool.getConnectionStatus();
  const enrichedNodes = health.nodes.map(n => {
    const conn = connStatus.find(c => c.name === n.name);
    return { ...n, ssh_connected: conn?.connected || false, ssh_error: conn?.error || null };
  });

  return {
    timestamp: new Date().toISOString(),
    daemon_uptime_sec: Math.floor(process.uptime()),
    paper_engine: paperStatus,
    nodes: enrichedNodes,
    active_jobs: health.active_jobs,
    stale_jobs: health.stale_jobs,
    unresolved_alerts: health.unresolved_alerts,
    scheduled_tasks: health.scheduled_tasks,
    recent_trades: health.recent_trades,
    streamlit_running: streamlitProcess !== null && !streamlitProcess.killed,
    trading_calendar: {
      is_trading_day: isTradingDay(),
      is_rth: isRTH(),
      is_es_open: isESOpen(),
      et_time: getETNow().toISOString(),
      next_open: !isESOpen() ? 'Sunday 6:00 PM ET' : null,
    },
  };
}

function getNodesData() {
  const nodes = db.getNodes();
  const connStatus = sshPool.getConnectionStatus();
  return nodes.map(n => {
    const conn = connStatus.find(c => c.name === n.name);
    const cache = gpuMetricsCache[n.name] || {};
    return {
      ...n,
      ssh_connected: conn?.connected || false,
      ssh_error: conn?.error || null,
      // Deep GPU health fields (from latest poll cycle)
      gpu_power_w: cache.powerW !== undefined ? cache.powerW : (n.last_gpu_power_w || null),
      gpu_power_limit_w: cache.powerLimitW !== undefined ? cache.powerLimitW : (n.gpu_power_limit_w || null),
      gpu_power_efficiency_pct: cache.efficiency !== undefined ? cache.efficiency : null,
      gpu_batch_rates: cache.batchRates || null,
    };
  });
}

async function getLiveNodesData() {
  const nodes = db.getNodes();
  const results = [];
  for (const node of nodes) {
    const gpuStatus = await sshPool.getGPUStatus(node.name);
    const conn = sshPool.getConnectionStatus().find(c => c.name === node.name);
    const cache = gpuMetricsCache[node.name] || {};
    // Compute live efficiency if power data available
    let liveEfficiency = null;
    if (gpuStatus?.gpu_power_w != null && gpuStatus?.gpu_power_limit_w != null && gpuStatus.gpu_power_limit_w > 0) {
      liveEfficiency = parseFloat(((gpuStatus.gpu_power_w / gpuStatus.gpu_power_limit_w) * 100).toFixed(1));
    }
    results.push({
      ...node,
      ssh_connected: conn?.connected || false,
      live_gpu: gpuStatus ? {
        ...gpuStatus,
        gpu_power_efficiency_pct: liveEfficiency,
      } : null,
      gpu_batch_rates: cache.batchRates || null,
    });
  }
  return results;
}

function getTrainingData() {
  // Build log-based training summary
  const logMonitor = {};
  for (const [logFile, state] of Object.entries(trainingLogState)) {
    logMonitor[path.basename(logFile)] = {
      modelType: state.modelType,
      status: state.status,
      currentFold: state.currentFold,
      totalFolds: state.totalFolds,
      lastIC: state.lastIC,
      avgIC: state.foldICs.length > 0
        ? parseFloat((state.foldICs.reduce((a, b) => a + b, 0) / state.foldICs.length).toFixed(4))
        : null,
      foldCount: state.foldICs.length,
      startTime: state.startTime,
    };
  }

  return {
    running: db.listTrainingJobs('running'),
    recent_completed: db.listTrainingJobs('completed'),
    queued: db.listTrainingJobs('queued'),
    log_monitor: logMonitor,
  };
}

function getModelsData() {
  return db.listModels(null, 100);
}

function getCardsData() {
  return db.listCards();
}

function getAlertsData() {
  return {
    unresolved: db.listAlerts(false, 50),
    recent_resolved: db.listAlerts(true, 20),
  };
}

function getPaperStatus() {
  try {
    if (fs.existsSync(PAPER_STATE_PATH)) {
      return { status: 'running', state: JSON.parse(fs.readFileSync(PAPER_STATE_PATH, 'utf8')) };
    }
    return { status: 'not_running' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

function getSweepsData() {
  return {
    running: db.listSweeps('running'),
    completed: db.listSweeps('completed'),
  };
}

function getResearchData() {
  return db.listResearch();
}

function getDaemonStatus() {
  let queueDepth = null;
  try { queueDepth = db.getQueueDepth(); } catch (e) {}
  return {
    uptime_sec: Math.floor(process.uptime()),
    pid: process.pid,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    db_path: DB_PATH,
    http_port: HTTP_PORT,
    streamlit_port: STREAMLIT_PORT,
    streamlit_running: streamlitProcess !== null && !streamlitProcess.killed,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL,
    gpu_check_interval_ms: GPU_CHECK_INTERVAL,
    training_check_interval_ms: TRAINING_CHECK_INTERVAL,
    job_dispatch_interval_ms: JOB_DISPATCH_INTERVAL,
    ssh_connections: sshPool.getConnectionStatus(),
    job_queue: queueDepth,
    alert_state: {
      nodes_down: Object.keys(alertState.nodeDownSince),
      gpus_idle: Object.keys(alertState.gpuIdleSince),
      log_monitor_active_alerts: Object.keys(alertState.logMonitorAlerts).length,
    },
    training_log_monitor_interval_ms: TRAINING_LOG_MONITOR_INTERVAL,
    active_log_streams: getActiveStreamCount(),
  };
}

// ========================
// STATUS PAGE (standalone HTML)
// ========================

function serveStatusPage(res) {
  const html = buildStatusHTML();
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function buildStatusHTML() {
  const nodes = db.getNodes();
  const connStatus = sshPool.getConnectionStatus();
  const jobs = db.listTrainingJobs('running');
  const alerts = db.listAlerts(false, 10);

  const nodeRows = nodes.map(n => {
    const conn = connStatus.find(c => c.name === n.name);
    const statusColor = n.status === 'online' || n.status === 'training' ? '#4ade80'
      : n.status === 'idle' ? '#fbbf24' : '#ef4444';
    return `<tr>
      <td>${n.name}</td>
      <td style="color:${statusColor}">${n.status}</td>
      <td>${n.gpu || 'none'}</td>
      <td>${n.last_gpu_util != null ? n.last_gpu_util + '%' : '-'}</td>
      <td>${conn?.connected ? 'Yes' : 'No'}</td>
      <td>${n.last_heartbeat || 'never'}</td>
    </tr>`;
  }).join('');

  const jobRows = jobs.map(j => `<tr>
    <td>${j.id}</td>
    <td>${j.node}</td>
    <td>${j.description || j.job_type}</td>
    <td>${j.current_fold || '-'}/${j.total_folds || '-'}</td>
    <td>${j.progress_pct ? j.progress_pct + '%' : '-'}</td>
    <td><a href="/logs/${j.id}">View Logs</a></td>
  </tr>`).join('') || '<tr><td colspan="6">No active training jobs</td></tr>';

  const alertRows = alerts.map(a => {
    const color = a.severity === 'critical' ? '#ef4444' : a.severity === 'warning' ? '#fbbf24' : '#3b82f6';
    return `<tr>
      <td style="color:${color}">${a.severity}</td>
      <td>${a.source}</td>
      <td>${a.message}</td>
      <td>${a.created_at}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4">No unresolved alerts</td></tr>';

  return `<!DOCTYPE html>
<html><head><title>QCC Status</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  body { background:#0f1117; color:#e5e7eb; font-family:monospace; margin:20px; }
  h1 { color:#8b5cf6; } h2 { color:#6366f1; margin-top:24px; }
  table { border-collapse:collapse; width:100%; margin:8px 0; }
  th,td { border:1px solid #2d3139; padding:6px 10px; text-align:left; }
  th { background:#1a1d24; color:#9ca3af; }
  tr:hover { background:#1a1d24; }
  .uptime { color:#4ade80; }
  a { color:#8b5cf6; }
</style></head><body>
<h1>QCC — Quant Command Center</h1>
<p>Daemon uptime: <span class="uptime">${Math.floor(process.uptime())}s</span>
 | PID: ${process.pid}
 | <a href="http://localhost:${STREAMLIT_PORT}">Full Dashboard</a>
 | <a href="/api/health">Health API</a>
 | <a href="/sse/events">Event Stream (SSE)</a></p>

<h2>Compute Nodes</h2>
<table><tr><th>Node</th><th>Status</th><th>GPU</th><th>GPU Util</th><th>SSH</th><th>Last Heartbeat</th></tr>
${nodeRows}</table>

<h2>Active Training</h2>
<table><tr><th>Job</th><th>Node</th><th>Description</th><th>Fold</th><th>Progress</th><th>Logs</th></tr>
${jobRows}</table>

<h2>Unresolved Alerts</h2>
<table><tr><th>Severity</th><th>Source</th><th>Message</th><th>Time</th></tr>
${alertRows}</table>

<p style="color:#6b7280;margin-top:20px;">Auto-refreshes every 30s</p>
</body></html>`;
}

// ========================
// MCP HANDLER (HTTP POST /mcp)
// ========================

async function handleMCPRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const msg = JSON.parse(body);
      const { id, method, params } = msg;

      if (method === 'initialize') {
        return sendJSON(res, {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'qcc-daemon', version: '2.0.0' },
          }
        });
      }

      if (method === 'tools/list') {
        // Dynamically import tools list from the MCP server
        const tools = getToolsList();
        return sendJSON(res, { jsonrpc: '2.0', id, result: { tools } });
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params;
        const result = await handleTool(name, args || {});
        if (result) {
          return sendJSON(res, { jsonrpc: '2.0', id, result });
        }
        return sendJSON(res, {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Unknown tool: ${name}` }
        });
      }

      // Unknown method
      return sendJSON(res, {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Unknown method: ${method}` }
      });

    } catch (e) {
      log('ERROR', `MCP handler error: ${e.message}`);
      return sendJSON(res, {
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: `Parse error: ${e.message}` }
      });
    }
  });
}

// ========================
// TOOL SURFACE (reused from qcc-server.js)
// ========================

function getToolsList() {
  // Same tool definitions as mcp/qcc-server.js — load dynamically
  // to avoid duplication and stay in sync
  try {
    // We read the source file and extract the TOOLS array
    // But since that's fragile, we duplicate the essential ones here
    // and add daemon-specific tools
    return [
      { name: 'qcc_node_status', description: 'Get status of compute nodes', inputSchema: { type: 'object', properties: { node: { type: 'string' }, live_check: { type: 'boolean' } } } },
      { name: 'qcc_ssh_exec', description: 'Execute command on remote node via SSH', inputSchema: { type: 'object', properties: { node: { type: 'string' }, command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['node', 'command'] } },
      { name: 'qcc_training_status', description: 'Get training job status', inputSchema: { type: 'object', properties: { status: { type: 'string' }, node: { type: 'string' } } } },
      { name: 'qcc_health_check', description: 'Comprehensive health check', inputSchema: { type: 'object', properties: {} } },
      { name: 'qcc_alert_list', description: 'List alerts', inputSchema: { type: 'object', properties: { resolved: { type: 'boolean' }, limit: { type: 'number' } } } },
      { name: 'qcc_paper_status', description: 'Paper trading engine status', inputSchema: { type: 'object', properties: {} } },
      { name: 'qcc_model_list', description: 'List models', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'qcc_card_list', description: 'List trading cards', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
      { name: 'qcc_daemon_status', description: 'QCC daemon internal status', inputSchema: { type: 'object', properties: {} } },
      { name: 'qcc_job_submit', description: 'Submit a job to the queue', inputSchema: { type: 'object', properties: { job_type: { type: 'string' }, job_name: { type: 'string' }, node_name: { type: 'string' }, requires_gpu: { type: 'boolean' }, command: { type: 'string' }, working_dir: { type: 'string' }, config_json: { type: 'string' }, priority: { type: 'number' }, depends_on: { type: 'number' }, chain_next: { type: 'string' } }, required: ['job_name', 'command'] } },
      { name: 'qcc_job_status', description: 'Get status of a specific job', inputSchema: { type: 'object', properties: { job_id: { type: 'number' } }, required: ['job_id'] } },
      { name: 'qcc_job_list', description: 'List jobs with optional filters', inputSchema: { type: 'object', properties: { status: { type: 'string' }, node: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'qcc_job_cancel', description: 'Cancel a queued or assigned job', inputSchema: { type: 'object', properties: { job_id: { type: 'number' } }, required: ['job_id'] } },
      { name: 'qcc_queue_depth', description: 'Get queue depth summary per node', inputSchema: { type: 'object', properties: {} } },
      { name: 'qcc_pipeline_status', description: 'Check data pipeline status for a date or overview of all dates', inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD for specific date, omit for overview' }, limit: { type: 'number', description: 'Max dates for overview (default 60)' } } } },
      { name: 'qcc_pipeline_trigger', description: 'Manually trigger a pipeline stage for a specific date', inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, stage: { type: 'string', description: 'mbo_raw, tensor_cache, predictions, validated' }, node: { type: 'string', description: 'Target node (default: jupiter)' } }, required: ['date', 'stage'] } },
      { name: 'qcc_training_register', description: 'Register a new training job (called by remote training scripts)', inputSchema: { type: 'object', properties: { node: { type: 'string' }, model_type: { type: 'string' }, description: { type: 'string' }, pid: { type: 'number' }, total_folds: { type: 'number' }, start_fold: { type: 'number' } }, required: ['node'] } },
      { name: 'qcc_scheduled_tasks', description: 'List scheduled tasks and their last_run status', inputSchema: { type: 'object', properties: {} } },
    ];
  } catch (e) {
    return [];
  }
}

function toolResult(text) {
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] };
}

async function handleTool(name, args) {
  switch (name) {
    case 'qcc_node_status': {
      if (args.node) {
        const node = db.getNode(args.node);
        if (!node) return toolResult({ error: `Node '${args.node}' not found` });
        if (args.live_check) {
          const gpuStatus = await sshPool.getGPUStatus(args.node);
          const connStatus = sshPool.getConnectionStatus().find(c => c.name === args.node);
          return toolResult({ ...node, live_gpu: gpuStatus, ssh_connected: connStatus?.connected || false });
        }
        return toolResult(node);
      }
      return toolResult(getNodesData());
    }
    case 'qcc_ssh_exec': {
      const result = await sshPool.exec(args.node, args.command, args.timeout_ms || 30000);
      return toolResult({ node: args.node, command: args.command, ...result });
    }
    case 'qcc_training_status':
      return toolResult(db.listTrainingJobs(args.status || null, args.node || null));
    case 'qcc_health_check':
      return toolResult(await getHealthData());
    case 'qcc_alert_list':
      return toolResult(db.listAlerts(args.resolved !== undefined ? args.resolved : null, args.limit || 50));
    case 'qcc_paper_status':
      return toolResult(getPaperStatus());
    case 'qcc_model_list':
      return toolResult(db.listModels(args.status || null, args.limit || 50));
    case 'qcc_card_list':
      return toolResult(db.listCards(args.status || null));
    case 'qcc_daemon_status':
      return toolResult(getDaemonStatus());
    case 'qcc_job_submit': {
      if (!args.job_name || !args.command) return toolResult({ error: 'job_name and command are required' });
      const result = db.enqueueJob(args);
      log('INFO', `Job enqueued via MCP: ${args.job_name} (id=${result.id})`);
      return toolResult({ status: 'queued', job_id: result.id, job_name: args.job_name });
    }
    case 'qcc_job_status': {
      const job = db.getJobStatus(args.job_id);
      if (!job) return toolResult({ error: `Job ${args.job_id} not found` });
      return toolResult(job);
    }
    case 'qcc_job_list': {
      const jobs = db.listJobs(args.status || null, args.node || null, args.limit || 50);
      return toolResult({ count: jobs.length, jobs });
    }
    case 'qcc_job_cancel': {
      const result = db.cancelJob(args.job_id);
      if (result.changes === 0) return toolResult({ error: `Job ${args.job_id} not found or not cancellable` });
      return toolResult({ status: 'cancelled', job_id: args.job_id });
    }
    case 'qcc_queue_depth':
      return toolResult(db.getQueueDepth());
    case 'qcc_pipeline_status': {
      if (args.date) {
        return toolResult({ date: args.date, stages: db.getPipelineStatus(args.date) });
      }
      return toolResult(db.getPipelineOverview(args.limit || 60));
    }
    case 'qcc_pipeline_trigger': {
      const vStages = ['mbo_raw', 'tensor_cache', 'predictions', 'validated'];
      if (!vStages.includes(args.stage)) {
        return toolResult({ error: 'Invalid stage. Must be: ' + vStages.join(', ') });
      }
      const tNode = args.node || PIPELINE_CONFIG.source_node;
      const dc = args.date.replace(/-/g, '');
      if (args.stage === 'mbo_raw') {
        db.updatePipelineStage(args.date, 'mbo_raw', 'completed', PIPELINE_CONFIG.mbo_dir + '/glbx-mdp3-' + dc + '.mbo.dbn.zst');
        return toolResult({ message: 'Marked mbo_raw completed for ' + args.date });
      }
      const cmdMap = {
        tensor_cache: 'cd /home/footb/Lvl3Quant && python3 -m data_pipeline.build_tensors --date ' + args.date,
        predictions: 'cd /home/footb/Lvl3Quant && python3 -m data_pipeline.generate_predictions --date ' + args.date,
        validated: 'cd /home/footb/Lvl3Quant && python3 -m data_pipeline.validate_oot --date ' + args.date,
      };
      const pj = db.enqueueJob({
        job_type: 'pipeline', job_name: args.stage + ' ' + args.date + ' (manual)',
        node_name: tNode, requires_gpu: args.stage === 'predictions',
        command: cmdMap[args.stage], working_dir: '/home/footb/Lvl3Quant',
        config_json: JSON.stringify({ pipeline_stage: args.stage, date: args.date, manual: true }),
        priority: 3,
      });
      db.updatePipelineStage(args.date, args.stage, 'pending');
      db.linkPipelineJob(args.date, args.stage, pj.id);
      return toolResult({ message: 'Triggered ' + args.stage + ' for ' + args.date, job_id: pj.id, node: tNode });
    }
    case 'qcc_training_register': {
      const { node, model_type, description, pid, total_folds, start_fold } = args;
      if (!node) return toolResult({ error: 'node is required' });
      let modelId = null;
      if (model_type) {
        const existing = db.db.prepare(
          "SELECT id FROM models WHERE name = ? AND status = 'training' ORDER BY created_at DESC LIMIT 1"
        ).get(model_type);
        if (existing) {
          modelId = existing.id;
        } else {
          const m = db.registerModel({
            name: model_type,
            architecture: model_type.includes('wider') ? 'wider_cnn' : model_type.includes('hybrid') ? 'hybrid' : 'cnn',
            node,
            total_folds: total_folds || null,
            status: 'training',
          });
          modelId = m.id;
        }
      }
      if (pid) {
        const dup = db.db.prepare(
          "SELECT id FROM training_jobs WHERE node = ? AND pid = ? AND status = 'running'"
        ).get(node, pid);
        if (dup) return toolResult({ status: 'already_registered', job_id: dup.id });
      }
      const job = db.createTrainingJob({
        model_id: modelId, node, job_type: 'training',
        description: description || (model_type ? `${model_type} WF` : 'Training job'),
        pid: pid || null, start_fold: start_fold || null,
        total_folds: total_folds || null, status: 'running',
      });
      return toolResult({ status: 'registered', job_id: job.id, model_id: modelId });
    }
    case 'qcc_scheduled_tasks':
      return toolResult(db.listScheduledTasks());
    default:
      return null;
  }
}

// ========================
// STREAMLIT DASHBOARD
// ========================

function startStreamlitDashboard() {
  if (!fs.existsSync(path.join(DASHBOARD_DIR, 'app.py'))) {
    log('WARN', 'Streamlit dashboard not found at quant_dashboard/app.py');
    return;
  }

  // Check if Streamlit is already running on the port
  const net = require('net');
  const tester = net.createServer();
  tester.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('INFO', `Streamlit already running on port ${STREAMLIT_PORT}`);
    }
  });
  tester.once('listening', () => {
    tester.close();
    launchStreamlit();
  });
  tester.listen(STREAMLIT_PORT);
}

function launchStreamlit() {
  log('INFO', 'Launching Streamlit dashboard...');

  streamlitProcess = spawn('python', [
    '-m', 'streamlit', 'run',
    path.join(DASHBOARD_DIR, 'app.py'),
    '--server.port', String(STREAMLIT_PORT),
    '--server.headless', 'true',
    '--server.address', '0.0.0.0',
    '--browser.gatherUsageStats', 'false',
  ], {
    cwd: BASE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });

  streamlitProcess.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) log('DEBUG', `[Streamlit] ${line}`);
  });

  streamlitProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line && !line.includes('You can now view your Streamlit app')) {
      log('DEBUG', `[Streamlit] ${line}`);
    }
  });

  streamlitProcess.on('exit', (code) => {
    log('WARN', `Streamlit exited with code ${code}`);
    streamlitProcess = null;

    // Auto-restart after 10s
    setTimeout(() => {
      if (!shuttingDown) {
        log('INFO', 'Auto-restarting Streamlit...');
        launchStreamlit();
      }
    }, 10000);
  });

  log('INFO', `Streamlit launching on port ${STREAMLIT_PORT}`);
}

// ========================
// MONITORING LOOPS
// ========================

function startMonitoring() {
  // 1. SSH heartbeat — every 60s
  const hbInterval = setInterval(async () => {
    try {
      await runHeartbeatCheck();
    } catch (e) {
      log('ERROR', `Heartbeat check failed: ${e.message}`);
    }
  }, HEARTBEAT_INTERVAL);
  intervals.push(hbInterval);

  // 2. GPU utilization check — every 120s
  const gpuInterval = setInterval(async () => {
    try {
      await runGPUCheck();
    } catch (e) {
      log('ERROR', `GPU check failed: ${e.message}`);
    }
  }, GPU_CHECK_INTERVAL);
  intervals.push(gpuInterval);

  // 3. Training progress check — every 5 min
  const trainingInterval = setInterval(async () => {
    try {
      await runTrainingCheck();
    } catch (e) {
      log('ERROR', `Training check failed: ${e.message}`);
    }
  }, TRAINING_CHECK_INTERVAL);
  intervals.push(trainingInterval);

  // 4. Paper engine watchdog — every 60s
  const paperInterval = setInterval(() => {
    try {
      checkPaperEngine();
    } catch (e) {
      log('ERROR', `Paper engine check failed: ${e.message}`);
    }
  }, 60000);
  intervals.push(paperInterval);

  // 4b. PnL snapshot loop — every 60s (alongside paper engine watchdog)
  const pnlSnapshotInterval = setInterval(() => {
    try {
      takePnlSnapshots();
      checkEndOfDay();
    } catch (e) {
      log('ERROR', `PnL snapshot failed: ${e.message}`);
    }
  }, 60000);
  intervals.push(pnlSnapshotInterval);

  // 5. Job queue dispatcher — every 30s
  const jobDispatchInterval = setInterval(async () => {
    try {
      await runJobDispatcher();
    } catch (e) {
      log('ERROR', `Job dispatcher failed: ${e.message}`);
    }
  }, JOB_DISPATCH_INTERVAL);
  intervals.push(jobDispatchInterval);

  // 6. Pipeline check — every 10 min
  const pipelineInterval = setInterval(async () => {
    try {
      await runPipelineCheck();
    } catch (e) {
      log('ERROR', `Pipeline check failed: ${e.message}`);
    }
  }, PIPELINE_CHECK_INTERVAL);
  intervals.push(pipelineInterval);

  // 7. Training log monitor — every 15 min, checks for stuck/silent training jobs
  const trainingLogMonitorInterval = setInterval(async () => {
    try {
      await runTrainingLogMonitor();
    } catch (e) {
      log('ERROR', `Training log monitor failed: ${e.message}`);
    }
  }, TRAINING_LOG_MONITOR_INTERVAL);
  intervals.push(trainingLogMonitorInterval);

  // 8. Scheduled tasks executor — every 60s checks cron expressions and fires due tasks
  const scheduledTaskInterval = setInterval(async () => {
    try {
      await runScheduledTasks();
    } catch (e) {
      log('ERROR', `Scheduled tasks runner failed: ${e.message}`);
    }
  }, 60000);
  intervals.push(scheduledTaskInterval);

  // Run initial checks after 5s delay (let SSH pool warm up)
  setTimeout(async () => {
    log('INFO', 'Running initial monitoring checks...');
    try { await runHeartbeatCheck(); } catch (e) { log('ERROR', `Initial heartbeat: ${e.message}`); }
    try { await runGPUCheck(); } catch (e) { log('ERROR', `Initial GPU check: ${e.message}`); }
    // Run initial pipeline scan + training log monitor after 30s (SSH needs to be warmed up)
    setTimeout(async () => {
      try { await runPipelineCheck(); } catch (e) { log('ERROR', `Initial pipeline check: ${e.message}`); }
      try { await runTrainingLogMonitor(); } catch (e) { log('ERROR', `Initial training log monitor: ${e.message}`); }
    }, 25000);
  }, 5000);

  log('INFO', 'Monitoring loops started', {
    heartbeat_ms: HEARTBEAT_INTERVAL,
    gpu_ms: GPU_CHECK_INTERVAL,
    training_ms: TRAINING_CHECK_INTERVAL,
    job_dispatch_ms: JOB_DISPATCH_INTERVAL,
    pipeline_ms: PIPELINE_CHECK_INTERVAL,
    training_log_monitor_ms: TRAINING_LOG_MONITOR_INTERVAL,
  });
}

// ========================
// HEARTBEAT CHECK
// ========================

async function runHeartbeatCheck() {
  const results = await sshPool.heartbeat();
  const now = Date.now();

  for (const [nodeName, result] of Object.entries(results)) {
    if (result.status === 'offline') {
      // Track when node first went down
      if (!alertState.nodeDownSince[nodeName]) {
        alertState.nodeDownSince[nodeName] = now;
      }

      // Alert after 2 consecutive failures (2 min) and then every 10 min
      const downDuration = now - alertState.nodeDownSince[nodeName];
      const lastAlert = alertState.nodeAlertSent[nodeName] || 0;
      const timeSinceAlert = now - lastAlert;

      if (downDuration >= HEARTBEAT_INTERVAL && (lastAlert === 0 || timeSinceAlert >= 600000)) {
        const downMinutes = Math.round(downDuration / 60000);
        db.sendAlert('warning', 'node_monitor', `${nodeName} offline for ${downMinutes} min: ${result.error || 'unknown'}`, nodeName);
        sendDiscordAlert('warning', `Node Down: ${nodeName}`,
          `${nodeName} has been offline for ${downMinutes} minutes.`,
          [{ name: 'Error', value: result.error || 'Connection failed', inline: false }]
        );
        eventBus.nodeDown(nodeName, result.error || 'Connection failed');
        alertState.nodeAlertSent[nodeName] = now;
      }
    } else {
      // Node is back online — send recovery alert if it was down
      if (alertState.nodeDownSince[nodeName]) {
        const downDuration = Math.round((now - alertState.nodeDownSince[nodeName]) / 60000);
        if (downDuration >= 2) {
          db.sendAlert('info', 'node_monitor', `${nodeName} back online after ${downDuration} min`, nodeName);
          sendDiscordAlert('success', `Node Recovered: ${nodeName}`,
            `${nodeName} is back online after ${downDuration} minutes.`
          );
          eventBus.nodeUp(nodeName);
        }
        delete alertState.nodeDownSince[nodeName];
        delete alertState.nodeAlertSent[nodeName];
      }
    }
  }

  // Record state history for each node from heartbeat
  const hbTimestamp = new Date().toISOString();
  for (const [nodeName, result] of Object.entries(results)) {
    try {
      const activeJobs = db.listJobs('running', nodeName, 100).length;
      db.recordNodeState({
        node_name: nodeName,
        timestamp: hbTimestamp,
        status: result.status || 'unknown',
        active_jobs: activeJobs,
      });
    } catch (e) {
      log('WARN', `Failed to record state for ${nodeName}: ${e.message}`);
    }
  }

  // Prune old history once per day
  if (!runHeartbeatCheck._lastPrune || (now - runHeartbeatCheck._lastPrune) > 86400000) {
    try {
      const pruned = db.pruneNodeHistory(7);
      if (pruned.deleted > 0) log('INFO', `Pruned ${pruned.deleted} old node history records`);
      runHeartbeatCheck._lastPrune = now;
    } catch (e) {
      log('WARN', `Failed to prune node history: ${e.message}`);
    }
  }

  log('DEBUG', 'Heartbeat check complete', results);
}

// ========================
// GPU CHECK
// ========================

async function runGPUCheck() {
  const nodes = db.getNodes();
  const now = Date.now();

  for (const node of nodes) {
    if (!node.gpu || node.gpu === 'none') continue;

    const gpuStatus = await sshPool.getGPUStatus(node.name);
    if (!gpuStatus) continue;

    // ── 3. Power Efficiency Score ──
    // Compute and cache efficiency for this node; included in /api/nodes response
    if (!gpuMetricsCache[node.name]) gpuMetricsCache[node.name] = {};
    const cache = gpuMetricsCache[node.name];

    cache.powerW = gpuStatus.gpu_power_w;
    cache.powerLimitW = gpuStatus.gpu_power_limit_w;
    cache.lastPollTime = now;

    if (gpuStatus.gpu_power_w !== null && gpuStatus.gpu_power_limit_w !== null && gpuStatus.gpu_power_limit_w > 0) {
      cache.efficiency = parseFloat(((gpuStatus.gpu_power_w / gpuStatus.gpu_power_limit_w) * 100).toFixed(1));
    } else {
      cache.efficiency = null;
    }

    log('DEBUG', `GPU status for ${node.name}`, {
      ...gpuStatus,
      power_efficiency_pct: cache.efficiency,
    });

    // Record GPU metrics into node state history
    try {
      db.recordNodeState({
        node_name: node.name,
        timestamp: new Date().toISOString(),
        status: gpuStatus.gpu_util > 50 ? 'training' : (gpuStatus.gpu_util > 5 ? 'idle' : 'idle'),
        gpu_util: gpuStatus.gpu_util,
        gpu_mem_mb: gpuStatus.gpu_mem_used_mb,
        gpu_temp: gpuStatus.gpu_temp,
      });
    } catch (e) {
      log('WARN', `Failed to record GPU state for ${node.name}: ${e.message}`);
    }

    // Detect GPU idle (< 5% utilization)
    if (gpuStatus.gpu_util < 5) {
      if (!alertState.gpuIdleSince[node.name]) {
        alertState.gpuIdleSince[node.name] = now;
      }

      // Alert after 10 min idle, then every 30 min
      const idleDuration = now - alertState.gpuIdleSince[node.name];
      const lastAlert = alertState.gpuIdleAlertSent[node.name] || 0;
      const timeSinceAlert = now - lastAlert;

      if (idleDuration >= 600000 && (lastAlert === 0 || timeSinceAlert >= 1800000)) {
        const idleMinutes = Math.round(idleDuration / 60000);
        db.sendAlert('warning', 'gpu_monitor', `${node.name} GPU idle for ${idleMinutes} min (${node.gpu})`, node.name);
        sendDiscordAlert('warning', `GPU Idle: ${node.name}`,
          `${node.gpu} on ${node.name} has been idle for ${idleMinutes} minutes. Consider launching training.`,
          [
            { name: 'GPU Util', value: `${gpuStatus.gpu_util}%`, inline: true },
            { name: 'GPU Temp', value: `${gpuStatus.gpu_temp}C`, inline: true },
            { name: 'VRAM', value: `${gpuStatus.gpu_mem_used_mb}/${gpuStatus.gpu_mem_total_mb} MB`, inline: true },
          ]
        );
        alertState.gpuIdleAlertSent[node.name] = now;
      }
    } else {
      // GPU is active — clear idle tracking
      if (alertState.gpuIdleSince[node.name]) {
        delete alertState.gpuIdleSince[node.name];
        delete alertState.gpuIdleAlertSent[node.name];
      }
    }

    // ── 1. Power Draw / Data-Starved Detection ──
    // High util + low power = DataLoader bottleneck (GPU waiting for data, not computing)
    // Only check when GPU util is high (>= 80%) and we have power data
    if (gpuStatus.gpu_util >= 80 &&
        gpuStatus.gpu_power_w !== null &&
        gpuStatus.gpu_power_limit_w !== null &&
        gpuStatus.gpu_power_limit_w > 0) {

      const powerPct = (gpuStatus.gpu_power_w / gpuStatus.gpu_power_limit_w) * 100;

      if (powerPct < 50) {
        // Data-starved condition: high util, low power
        if (!alertState.gpuDataStarvedSince[node.name]) {
          alertState.gpuDataStarvedSince[node.name] = now;
          log('WARN', `GPU data-starved condition detected on ${node.name}: ` +
            `${gpuStatus.gpu_util}% util, ${gpuStatus.gpu_power_w.toFixed(1)}W / ${gpuStatus.gpu_power_limit_w}W`);
        }

        const starvedDuration = now - alertState.gpuDataStarvedSince[node.name];
        const lastStarvedAlert = alertState.gpuDataStarvedAlertSent[node.name] || 0;
        const timeSinceStarvedAlert = now - lastStarvedAlert;

        // Alert after 10 min sustained, then every 30 min
        if (starvedDuration >= 600000 && (lastStarvedAlert === 0 || timeSinceStarvedAlert >= 1800000)) {
          const starvedMinutes = Math.round(starvedDuration / 60000);
          const efficiencyPct = cache.efficiency !== null ? `${cache.efficiency}%` : 'N/A';
          db.sendAlert('warning', 'gpu_data_starved',
            `${node.name} GPU data-starved: ${gpuStatus.gpu_util}% util but only ` +
            `${gpuStatus.gpu_power_w.toFixed(1)}W / ${gpuStatus.gpu_power_limit_w}W for ${starvedMinutes} min`,
            node.name);
          sendDiscordAlert('warning', `GPU Data-Starved: ${node.name}`,
            `GPU data-starved: ${gpuStatus.gpu_util}% util but only ${gpuStatus.gpu_power_w.toFixed(1)}W / ${gpuStatus.gpu_power_limit_w}W. ` +
            `DataLoader likely bottlenecked — GPU is waiting for data, not computing. Condition sustained for ${starvedMinutes} min.`,
            [
              { name: 'GPU Util', value: `${gpuStatus.gpu_util}%`, inline: true },
              { name: 'Power Draw', value: `${gpuStatus.gpu_power_w.toFixed(1)}W / ${gpuStatus.gpu_power_limit_w}W`, inline: true },
              { name: 'Power Efficiency', value: efficiencyPct, inline: true },
              { name: 'Sustained', value: `${starvedMinutes} min`, inline: true },
              { name: 'Fix', value: 'Increase num_workers, prefetch_factor, or pin_memory in DataLoader', inline: false },
            ]
          );
          alertState.gpuDataStarvedAlertSent[node.name] = now;
          log('WARN', `Data-starved alert sent for ${node.name} (${starvedMinutes} min, eff=${efficiencyPct})`);
        }
      } else {
        // Power draw is healthy relative to util — clear data-starved tracking
        if (alertState.gpuDataStarvedSince[node.name]) {
          delete alertState.gpuDataStarvedSince[node.name];
          delete alertState.gpuDataStarvedAlertSent[node.name];
          log('INFO', `${node.name} GPU data-starved condition cleared (power now ${gpuStatus.gpu_power_w.toFixed(1)}W)`);
        }
      }
    } else if (gpuStatus.gpu_util < 80) {
      // Util dropped below threshold — clear data-starved state
      if (alertState.gpuDataStarvedSince[node.name]) {
        delete alertState.gpuDataStarvedSince[node.name];
        delete alertState.gpuDataStarvedAlertSent[node.name];
      }
    }

    // ── CRITICAL: Cross-reference GPU state with active training jobs ──
    // If a job says "running" on this node but GPU is idle, something is wrong
    try {
      const activeJobs = db.db.prepare(
        "SELECT id, description FROM training_jobs WHERE node = ? AND status = 'running'"
      ).all(node.name);

      if (activeJobs.length > 0 && gpuStatus.gpu_util < 5) {
        // Job says running but GPU is idle — CONFLICT
        const jobDescs = activeJobs.map(j => `#${j.id}: ${j.description}`).join(', ');
        const alertKey = `conflict_${node.name}`;
        const lastConflictAlert = alertState[alertKey] || 0;
        // Alert every 15 min
        if (now - lastConflictAlert >= 900000) {
          db.sendAlert('critical', 'gpu_job_conflict',
            `${node.name}: training job(s) [${jobDescs}] marked RUNNING but GPU is at ${gpuStatus.gpu_util}%! ` +
            `Training may have crashed, stalled, or finished without updating status. INVESTIGATE IMMEDIATELY.`,
            node.name);
          sendDiscordAlert('critical', `GPU/Job Conflict: ${node.name}`,
            `Training job(s) are marked as RUNNING but GPU utilization is only ${gpuStatus.gpu_util}%. ` +
            `Jobs: ${jobDescs}. Training may have crashed or completed without updating QCC.`,
            [
              { name: 'GPU Util', value: `${gpuStatus.gpu_util}%`, inline: true },
              { name: 'Active Jobs', value: jobDescs.substring(0, 100), inline: true },
            ]
          );
          alertState[alertKey] = now;
          log('CRITICAL', `GPU/Job conflict on ${node.name}: GPU ${gpuStatus.gpu_util}% but jobs running: ${jobDescs}`);
        }
      } else if (activeJobs.length > 0 && gpuStatus.gpu_util >= 5) {
        // Clear conflict state
        delete alertState[`conflict_${node.name}`];
      } else if (activeJobs.length === 0 && gpuStatus.gpu_util >= 50) {
        // GPU is busy but no training_jobs entry exists — auto-register a placeholder
        const autoKey = `auto_register_${node.name}`;
        const lastAutoRegister = alertState[autoKey] || 0;
        // Only auto-register once per 10 min per node to avoid spam
        if (now - lastAutoRegister >= 600000) {
          try {
            const autoJob = db.createTrainingJob({
              node: node.name,
              job_type: 'training',
              description: `Auto-detected training (GPU ${gpuStatus.gpu_util}% — registered by GPU monitor)`,
              status: 'running',
            });
            alertState[autoKey] = now;
            log('INFO', `Auto-registered training job ${autoJob.id} for ${node.name} (GPU ${gpuStatus.gpu_util}%)`);
          } catch (e) {
            log('WARN', `Failed to auto-register training job for ${node.name}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      log('WARN', `Failed to cross-check GPU/job state for ${node.name}: ${e.message}`);
    }
  }
}

// ========================
// TRAINING PROGRESS CHECK — LOG-BASED MONITORING
// ========================

// Directories to scan for training log files (local — Neptune)
const TRAINING_LOG_DIRS = [
  'C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/deep_models/results',
  'C:/Users/Footb/Documents/Github/Lvl3Quant/logs/overnight',
];

// Remote node training log directories (scanned via SSH)
// Each node may be Windows or Linux — we try both path styles
const REMOTE_TRAINING_PATHS = {
  uranus: {
    resultsDir: 'C:/Users/Nick/Documents/Lvl3Quant/alpha_discovery/deep_models/results',
    os: 'windows',
  },
  razer: {
    resultsDir: 'C:/Users/claude/Documents/Lvl3Quant/alpha_discovery/deep_models/results',
    os: 'windows',
  },
  jupiter: {
    resultsDir: 'C:/Users/jupiter/Documents/Lvl3Quant/alpha_discovery/deep_models/results',
    os: 'windows',
  },
};

// Track GPU idle vs registered training for remote alert correlation
const remoteTrainingTracker = {};
// remoteTrainingTracker[nodeName] = { activeLogs: [...], lastGpuCheck: timestamp, gpuIdleMinutes: N }

// Persistent state for log-based training monitoring
// Key: absolute log file path → state object
const trainingLogState = {};

// State file for persistence across daemon restarts
const TRAINING_LOG_STATE_PATH = path.join(DATA_DIR, 'training_log_state.json');

// Load persisted training log state on startup
function loadTrainingLogState() {
  try {
    if (fs.existsSync(TRAINING_LOG_STATE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(TRAINING_LOG_STATE_PATH, 'utf8'));
      for (const [logFile, state] of Object.entries(saved)) {
        trainingLogState[logFile] = state;
      }
      log('INFO', `Loaded training log state: ${Object.keys(saved).length} tracked logs`);
    }
  } catch (e) {
    log('WARN', `Failed to load training log state: ${e.message}`);
  }
}

function saveTrainingLogState() {
  try {
    fs.writeFileSync(TRAINING_LOG_STATE_PATH, JSON.stringify(trainingLogState, null, 2), 'utf8');
  } catch (e) {
    log('WARN', `Failed to save training log state: ${e.message}`);
  }
}

/**
 * Find the most recently modified .log files in training output directories.
 * Returns array of { path, mtime } sorted by mtime descending.
 * Only returns files modified in the last 24 hours.
 */
function findActiveTrainingLogs() {
  const activeLogs = [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h ago

  for (const dir of TRAINING_LOG_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.log')) continue;
        // Only match walkforward_* or known training log patterns
        if (!entry.name.startsWith('walkforward_') &&
            !entry.name.startsWith('standard_cnn') &&
            !entry.name.startsWith('wider_cnn') &&
            !entry.name.startsWith('book_') &&
            !entry.name.startsWith('hybrid_')) continue;

        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > cutoff) {
            activeLogs.push({ path: fullPath, mtime: stat.mtimeMs, size: stat.size });
          }
        } catch (e) { /* skip unreadable files */ }
      }

      // Also check one level of subdirectories (e.g., results/sg7p2/)
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const subdir = path.join(dir, entry.name);
          const subEntries = fs.readdirSync(subdir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isFile() || !subEntry.name.endsWith('.log')) continue;
            const fullPath = path.join(subdir, subEntry.name);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.mtimeMs > cutoff) {
                activeLogs.push({ path: fullPath, mtime: stat.mtimeMs, size: stat.size });
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* skip unreadable subdirs */ }
      }
    } catch (e) {
      log('WARN', `Failed to scan training log dir ${dir}: ${e.message}`);
    }
  }

  // Sort by mtime descending (most recent first)
  activeLogs.sort((a, b) => b.mtime - a.mtime);
  return activeLogs;
}

/**
 * Find active training logs on remote nodes via SSH.
 * Returns array of { path, mtime, size, node } for each remote log found.
 */
async function findRemoteTrainingLogs() {
  const remoteLogs = [];

  for (const [nodeName, config] of Object.entries(REMOTE_TRAINING_PATHS)) {
    // Skip nodes that aren't connected
    const connStatus = sshPool.getConnectionStatus().find(c => c.name === nodeName);
    if (!connStatus?.connected) continue;

    try {
      const dir = config.resultsDir;
      let cmd;
      if (config.os === 'windows') {
        // PowerShell: list log files modified in the last 24h with size and mtime
        cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${dir}' -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-24) -and ($_.Name -match '^(walkforward_|standard_cnn|wider_cnn|book_|hybrid_)') } | ForEach-Object { $_.FullName + '|' + $_.Length + '|' + $_.LastWriteTime.ToString('o') }"`;
      } else {
        cmd = `find ${dir} -maxdepth 2 -name '*.log' -mmin -1440 2>/dev/null | while read f; do stat --format '%n|%s|%Y' "$f" 2>/dev/null; done`;
      }

      const result = await sshPool.exec(nodeName, cmd, 15000);
      if (result.exitCode !== 0 || !result.stdout.trim()) continue;

      const lines = result.stdout.trim().split('\n').filter(l => l.includes('|'));
      for (const line of lines) {
        const parts = line.trim().split('|');
        if (parts.length < 3) continue;
        const filePath = parts[0];
        const size = parseInt(parts[1]) || 0;
        const mtime = config.os === 'windows'
          ? new Date(parts[2]).getTime()
          : parseInt(parts[2]) * 1000; // Unix timestamp to ms

        if (isNaN(mtime) || size === 0) continue;

        remoteLogs.push({
          path: filePath,
          mtime,
          size,
          node: nodeName,
        });
      }
    } catch (e) {
      log('DEBUG', `Failed to scan remote training logs on ${nodeName}: ${e.message}`);
    }
  }

  remoteLogs.sort((a, b) => b.mtime - a.mtime);
  return remoteLogs;
}

/**
 * Read new content from a remote training log file incrementally via SSH.
 * Uses byte offset to only read new data since last check.
 * Returns the new content string, or null on failure.
 */
async function readRemoteLogIncremental(nodeName, logFilePath, lastReadPosition, config) {
  try {
    let cmd;
    if (config.os === 'windows') {
      // PowerShell: read from byte offset to end
      // Using .NET stream for efficient byte-offset reading
      cmd = `powershell -NoProfile -Command "$f=[System.IO.File]::OpenRead('${logFilePath.replace(/'/g, "''")}'); $f.Seek(${lastReadPosition}, 'Begin') | Out-Null; $buf=New-Object byte[] ($f.Length - ${lastReadPosition}); $n=$f.Read($buf,0,$buf.Length); $f.Close(); [System.Text.Encoding]::UTF8.GetString($buf,0,$n)"`;
    } else {
      cmd = `tail -c +${lastReadPosition + 1} "${logFilePath}"`;
    }

    const result = await sshPool.exec(nodeName, cmd, 15000);
    if (result.exitCode === 0 && result.stdout) {
      return result.stdout;
    }
    return null;
  } catch (e) {
    log('DEBUG', `Failed to read remote log ${logFilePath} on ${nodeName}: ${e.message}`);
    return null;
  }
}

/**
 * Read the header (first 4KB) of a remote log file for model type detection.
 */
async function readRemoteLogHeader(nodeName, logFilePath, config) {
  try {
    let cmd;
    if (config.os === 'windows') {
      cmd = `powershell -NoProfile -Command "$f=[System.IO.File]::OpenRead('${logFilePath.replace(/'/g, "''")}'); $buf=New-Object byte[] ([Math]::Min(4096, $f.Length)); $n=$f.Read($buf,0,$buf.Length); $f.Close(); [System.Text.Encoding]::UTF8.GetString($buf,0,$n)"`;
    } else {
      cmd = `head -c 4096 "${logFilePath}"`;
    }

    const result = await sshPool.exec(nodeName, cmd, 10000);
    if (result.exitCode === 0) return result.stdout;
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * Parse remote training log content (same logic as parseTrainingLogIncremental,
 * but works on content string directly rather than reading from filesystem).
 */
function parseLogContent(newContent, state) {
  const events = [];
  const lines = newContent.split('\n');

  for (const line of lines) {
    const foldStartMatch = line.match(/--- Fold (\d+)\/(\d+)\s*\|/);
    if (foldStartMatch) {
      state.currentFold = parseInt(foldStartMatch[1]);
      state.totalFolds = parseInt(foldStartMatch[2]);
      state.status = 'training';
      events.push({ type: 'fold_start', fold: state.currentFold, total: state.totalFolds });
      continue;
    }

    const foldICMatch = line.match(/Fold IC:\s*([+-]?\d+\.\d+)\s*\(best over (\d+) epochs?\)\s*\[(\d+\.?\d*)s total\]/);
    if (foldICMatch) {
      const ic = parseFloat(foldICMatch[1]);
      const foldTime = parseFloat(foldICMatch[3]);
      state.lastIC = ic;
      state.foldICs.push(ic);
      state.lastFoldTime = foldTime;
      events.push({
        type: 'fold_complete',
        fold: state.currentFold,
        total: state.totalFolds,
        ic,
        foldTime,
        avgIC: state.foldICs.length > 0
          ? parseFloat((state.foldICs.reduce((a, b) => a + b, 0) / state.foldICs.length).toFixed(4))
          : ic,
      });
      continue;
    }

    const totalTimeMatch = line.match(/Total time for (\w+):\s*([\d.]+)s\s*\(([\d.]+)m\)/);
    if (totalTimeMatch) {
      const totalSeconds = parseFloat(totalTimeMatch[2]);
      if (totalSeconds > 60) {
        state.status = 'completed';
        events.push({
          type: 'training_complete',
          modelName: totalTimeMatch[1],
          totalSeconds,
          totalMinutes: parseFloat(totalTimeMatch[3]),
          totalFolds: state.totalFolds,
          avgIC: state.foldICs.length > 0
            ? parseFloat((state.foldICs.reduce((a, b) => a + b, 0) / state.foldICs.length).toFixed(4))
            : null,
          foldCount: state.foldICs.length,
        });
      }
      continue;
    }

    const totalFoldsMatch = line.match(/Total folds:\s*(\d+)/);
    if (totalFoldsMatch) { state.totalFolds = parseInt(totalFoldsMatch[1]); continue; }

    if (line.includes('WARM START: Loaded weights')) { events.push({ type: 'warm_start' }); continue; }
    if (line.includes('Warm start failed')) { events.push({ type: 'warm_start_failed' }); continue; }

    const checkpointMatch = line.match(/CHECKPOINT RESUME: Skipping (\d+) completed folds \(IC so far: ([+-]?\d+\.\d+)\)/);
    if (checkpointMatch) {
      state.currentFold = parseInt(checkpointMatch[1]);
      events.push({ type: 'checkpoint_resume', skippedFolds: state.currentFold, icSoFar: parseFloat(checkpointMatch[2]) });
      continue;
    }

    const trainingHeaderMatch = line.match(/# TRAINING:\s*(\S+)/);
    if (trainingHeaderMatch) { state.trainingTarget = trainingHeaderMatch[1]; continue; }

    const paramsMatch = line.match(/Model params:\s*([\d,]+)/);
    if (paramsMatch && !state.modelParams) { state.modelParams = parseInt(paramsMatch[1].replace(/,/g, '')); continue; }

    if (line.includes('window_mode:')) {
      if (line.includes('sliding')) state.windowMode = 'sliding';
      else if (line.includes('expanding')) state.windowMode = 'expanding';
      continue;
    }

    if (line.includes('**OVERFIT**')) {
      const epochOverfitMatch = line.match(/Epoch (\d+)\/(\d+):.*IC=([+-]?\d+\.\d+)/);
      if (epochOverfitMatch) {
        events.push({
          type: 'overfit_epoch',
          epoch: parseInt(epochOverfitMatch[1]),
          totalEpochs: parseInt(epochOverfitMatch[2]),
          ic: parseFloat(epochOverfitMatch[3]),
        });
      }
      continue;
    }
  }

  return events;
}

/**
 * Detect model type from log file name or content.
 * Returns a human-readable name like "Standard CNN WF", "Wider CNN WF", "Hybrid WF", etc.
 */
function detectModelType(logFilePath, headerContent) {
  const basename = path.basename(logFilePath).toLowerCase();

  // Check the header for model params count to distinguish standard vs wider
  let paramCount = 0;
  const paramMatch = headerContent && headerContent.match(/Model params:\s*([\d,]+)/);
  if (paramMatch) {
    paramCount = parseInt(paramMatch[1].replace(/,/g, ''));
  }

  // Check window_mode from header
  let windowMode = 'expanding';
  if (headerContent && headerContent.includes('window_mode:     sliding')) {
    windowMode = 'sliding';
  }

  // Detect from filename first
  if (basename.includes('wider_cnn') || basename.includes('wider_')) {
    return 'Wider CNN WF';
  }
  if (basename.includes('standard_cnn')) {
    return 'Standard CNN WF';
  }
  if (basename.includes('hybrid')) {
    return 'Hybrid WF';
  }
  if (basename.includes('lstm')) {
    return 'LSTM WF';
  }
  if (basename.includes('gnn')) {
    return 'GNN WF';
  }
  if (basename.includes('oot_lean') || basename.includes('oot_')) {
    return 'OOT Lean WF';
  }
  if (basename.includes('event')) {
    return 'Event Transformer WF';
  }
  if (basename.includes('bookspatialcnn')) {
    return 'BookSpatialCNN WF';
  }

  // Infer from param count (standard ~4M, wider ~12.6M)
  if (paramCount > 8000000) {
    return windowMode === 'sliding' ? 'Wider CNN WF' : 'Wider CNN WF (expanding)';
  }
  if (paramCount > 2000000) {
    return windowMode === 'expanding' ? 'Standard CNN WF' : 'Standard CNN WF (sliding)';
  }

  // Fallback: use the training type from header
  if (headerContent) {
    const trainingMatch = headerContent.match(/# TRAINING:\s*(\S+)/);
    if (trainingMatch) {
      return `${trainingMatch[1]} WF`;
    }
  }

  return 'Unknown WF';
}

/**
 * Parse new content from a training log file incrementally.
 * Reads from lastReadPosition to end of file.
 * Returns parsed events.
 */
function parseTrainingLogIncremental(logFilePath, state) {
  const events = [];

  let fileSize;
  try {
    const stat = fs.statSync(logFilePath);
    fileSize = stat.size;
  } catch (e) {
    return events;
  }

  // Nothing new to read
  if (fileSize <= state.lastReadPosition) {
    return events;
  }

  // Read new content from the byte offset
  let newContent;
  try {
    const fd = fs.openSync(logFilePath, 'r');
    const bytesToRead = fileSize - state.lastReadPosition;
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, state.lastReadPosition);
    fs.closeSync(fd);
    newContent = buffer.toString('utf8');
  } catch (e) {
    log('WARN', `Failed to read training log ${logFilePath}: ${e.message}`);
    return events;
  }

  // Update read position
  state.lastReadPosition = fileSize;

  // Parse line by line
  const lines = newContent.split('\n');

  for (const line of lines) {
    // --- Fold N/M | Train: ... | Test: ... ---
    const foldStartMatch = line.match(/--- Fold (\d+)\/(\d+)\s*\|/);
    if (foldStartMatch) {
      const currentFold = parseInt(foldStartMatch[1]);
      const totalFolds = parseInt(foldStartMatch[2]);
      state.currentFold = currentFold;
      state.totalFolds = totalFolds;
      state.status = 'training';
      events.push({ type: 'fold_start', fold: currentFold, total: totalFolds });
      continue;
    }

    // Fold IC: +0.1234 (best over N epochs) [Ns total]
    const foldICMatch = line.match(/Fold IC:\s*([+-]?\d+\.\d+)\s*\(best over (\d+) epochs?\)\s*\[(\d+\.?\d*)s total\]/);
    if (foldICMatch) {
      const ic = parseFloat(foldICMatch[1]);
      const foldTime = parseFloat(foldICMatch[3]);
      state.lastIC = ic;
      state.foldICs.push(ic);
      state.lastFoldTime = foldTime;
      events.push({
        type: 'fold_complete',
        fold: state.currentFold,
        total: state.totalFolds,
        ic,
        foldTime,
        avgIC: state.foldICs.length > 0
          ? parseFloat((state.foldICs.reduce((a, b) => a + b, 0) / state.foldICs.length).toFixed(4))
          : ic,
      });
      continue;
    }

    // Total time for book: 12345.6s (205.9m)
    const totalTimeMatch = line.match(/Total time for (\w+):\s*([\d.]+)s\s*\(([\d.]+)m\)/);
    if (totalTimeMatch) {
      const modelName = totalTimeMatch[1];
      const totalSeconds = parseFloat(totalTimeMatch[2]);
      const totalMinutes = parseFloat(totalTimeMatch[3]);
      // Only treat as real completion if training actually ran (>60s)
      if (totalSeconds > 60) {
        state.status = 'completed';
        events.push({
          type: 'training_complete',
          modelName,
          totalSeconds,
          totalMinutes,
          totalFolds: state.totalFolds,
          avgIC: state.foldICs.length > 0
            ? parseFloat((state.foldICs.reduce((a, b) => a + b, 0) / state.foldICs.length).toFixed(4))
            : null,
          foldCount: state.foldICs.length,
        });
      }
      continue;
    }

    // Total folds from header: Total folds: 84
    const totalFoldsMatch = line.match(/Total folds:\s*(\d+)/);
    if (totalFoldsMatch) {
      state.totalFolds = parseInt(totalFoldsMatch[1]);
      continue;
    }

    // WARM START: Loaded weights
    if (line.includes('WARM START: Loaded weights')) {
      events.push({ type: 'warm_start' });
      continue;
    }

    // Warm start failed
    if (line.includes('Warm start failed')) {
      events.push({ type: 'warm_start_failed' });
      continue;
    }

    // CHECKPOINT RESUME: Skipping N completed folds (IC so far: +0.0587)
    const checkpointMatch = line.match(/CHECKPOINT RESUME: Skipping (\d+) completed folds \(IC so far: ([+-]?\d+\.\d+)\)/);
    if (checkpointMatch) {
      const skippedFolds = parseInt(checkpointMatch[1]);
      const icSoFar = parseFloat(checkpointMatch[2]);
      state.currentFold = skippedFolds;
      events.push({ type: 'checkpoint_resume', skippedFolds, icSoFar });
      continue;
    }

    // # TRAINING: BOOK (or LSTM, EVENT, etc.)
    const trainingHeaderMatch = line.match(/# TRAINING:\s*(\S+)/);
    if (trainingHeaderMatch) {
      state.trainingTarget = trainingHeaderMatch[1];
      continue;
    }

    // Model params: 4,012,833
    const paramsMatch = line.match(/Model params:\s*([\d,]+)/);
    if (paramsMatch && !state.modelParams) {
      state.modelParams = parseInt(paramsMatch[1].replace(/,/g, ''));
      continue;
    }

    // window_mode
    if (line.includes('window_mode:')) {
      if (line.includes('sliding')) state.windowMode = 'sliding';
      else if (line.includes('expanding')) state.windowMode = 'expanding';
      continue;
    }

    // **OVERFIT** marker on epoch lines
    if (line.includes('**OVERFIT**')) {
      const epochOverfitMatch = line.match(/Epoch (\d+)\/(\d+):.*IC=([+-]?\d+\.\d+)/);
      if (epochOverfitMatch) {
        events.push({
          type: 'overfit_epoch',
          epoch: parseInt(epochOverfitMatch[1]),
          totalEpochs: parseInt(epochOverfitMatch[2]),
          ic: parseFloat(epochOverfitMatch[3]),
        });
      }
      continue;
    }
  }

  return events;
}

/**
 * Main log-based training check.
 * Scans for active log files, parses new content incrementally, sends Discord alerts.
 */
async function runTrainingCheck() {
  // --- Part 1: Log-based monitoring ---
  const activeLogs = findActiveTrainingLogs();

  // Track which logs are currently active (modified in last 30 min)
  const recentCutoff = Date.now() - 30 * 60 * 1000;

  for (const logInfo of activeLogs) {
    const logFile = logInfo.path;

    // Initialize state for new log files
    if (!trainingLogState[logFile]) {
      // Read the full file for the first time to get header info
      let headerContent = '';
      try {
        const fd = fs.openSync(logFile, 'r');
        const headerBuf = Buffer.alloc(Math.min(4096, logInfo.size));
        fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
        fs.closeSync(fd);
        headerContent = headerBuf.toString('utf8');
      } catch (e) { /* ignore */ }

      const modelType = detectModelType(logFile, headerContent);

      trainingLogState[logFile] = {
        logFile,
        lastReadPosition: 0,
        modelType,
        currentFold: 0,
        totalFolds: 0,
        lastIC: null,
        foldICs: [],
        lastFoldTime: null,
        startTime: new Date(logInfo.mtime).toISOString(),
        status: 'training',
        lastAlertFold: 0,        // last fold we sent a progress alert for
        completionAlerted: false, // whether we already sent a completion alert
        transitionAlerted: false, // whether we alerted on job transition
        modelParams: null,
        windowMode: null,
        trainingTarget: null,
      };

      // For brand new files (created in last 5 min), send a "started" alert
      if (logInfo.mtime > Date.now() - 5 * 60 * 1000) {
        log('INFO', `New training log detected: ${logFile} (${modelType})`);
        sendDiscordAlert('info', `Training Started: ${modelType}`,
          `New training run detected on Neptune.`,
          [
            { name: 'Log', value: path.basename(logFile), inline: false },
          ]
        );
      }
    }

    const state = trainingLogState[logFile];

    // Skip completed/alerted logs that haven't been modified recently
    if (state.status === 'completed' && state.completionAlerted && logInfo.mtime < recentCutoff) {
      continue;
    }

    // Parse new content
    const events = parseTrainingLogIncremental(logFile, state);

    // Process events and send alerts
    for (const event of events) {
      switch (event.type) {
        case 'fold_start': {
          // Detect model type from first fold if we haven't yet
          if (state.totalFolds === 0 || !state.totalFolds) {
            state.totalFolds = event.total;
          }

          // If this is fold 1, send a "started" alert (if we haven't already from file creation)
          if (event.fold === 1 && state.lastAlertFold === 0) {
            const headerContent = state.trainingTarget || '';
            state.modelType = detectModelType(logFile, headerContent) || state.modelType;
            log('INFO', `Training started: ${state.modelType} — fold 1/${event.total}`);
            sendDiscordAlert('info', `Training Started: ${state.modelType}`,
              `Fold 1/${event.total} beginning on Neptune.`,
              [
                { name: 'Log', value: path.basename(logFile), inline: false },
                { name: 'Total Folds', value: String(event.total), inline: true },
              ]
            );
            state.lastAlertFold = 1;
          }

          // Emit SSE event for dashboard
          eventBus.trainingProgress(
            logFile, 'neptune', event.fold, event.total,
            Math.round((event.fold / event.total) * 100)
          );
          break;
        }

        case 'fold_complete': {
          log('DEBUG', `Fold ${event.fold}/${event.total} complete: IC=${event.ic}, avg=${event.avgIC}`);

          // Alert every 5 folds
          if (event.fold - state.lastAlertFold >= 5) {
            const elapsed = state.startTime
              ? ((Date.now() - new Date(state.startTime).getTime()) / 3600000).toFixed(1)
              : '?';
            sendDiscordAlert('info', `${state.modelType} — fold ${event.fold}/${event.total}`,
              `Training progress on Neptune.`,
              [
                { name: 'Last IC', value: event.ic.toFixed(4), inline: true },
                { name: 'Avg IC', value: event.avgIC.toFixed(4), inline: true },
                { name: 'Elapsed', value: `${elapsed}h`, inline: true },
              ]
            );
            state.lastAlertFold = event.fold;
          }

          // Alert on OVERFIT or negative IC folds
          if (event.ic < -0.01) {
            sendDiscordAlert('warning', `WARNING: ${state.modelType} fold ${event.fold} IC: ${event.ic.toFixed(4)}`,
              `Negative IC on fold ${event.fold}/${event.total} — possible overfit.`,
              [
                { name: 'Fold IC', value: event.ic.toFixed(4), inline: true },
                { name: 'Avg IC', value: event.avgIC.toFixed(4), inline: true },
              ]
            );
          }

          // Emit SSE
          eventBus.trainingProgress(
            logFile, 'neptune', event.fold, event.total,
            Math.round((event.fold / event.total) * 100)
          );
          break;
        }

        case 'training_complete': {
          if (!state.completionAlerted) {
            const hours = (event.totalMinutes / 60).toFixed(1);
            log('INFO', `Training COMPLETE: ${state.modelType} — ${event.foldCount} folds, avg IC: ${event.avgIC}, time: ${hours}h`);
            sendDiscordAlert('success', `Training COMPLETE: ${state.modelType}`,
              `${event.modelName} walk-forward finished on Neptune.`,
              [
                { name: 'Folds', value: String(event.foldCount), inline: true },
                { name: 'Avg IC', value: event.avgIC !== null ? event.avgIC.toFixed(4) : 'N/A', inline: true },
                { name: 'Total Time', value: `${hours}h`, inline: true },
                { name: 'Log', value: path.basename(logFile), inline: false },
              ]
            );
            state.completionAlerted = true;
            state.status = 'completed';

            // Check if another training started shortly after in a different log
            // (job transition detection handled below)
          }
          break;
        }

        case 'checkpoint_resume': {
          log('INFO', `Checkpoint resume: skipping ${event.skippedFolds} folds (IC so far: ${event.icSoFar})`);
          state.currentFold = event.skippedFolds;
          state.lastAlertFold = event.skippedFolds; // Don't re-alert for skipped folds
          break;
        }

        case 'warm_start_failed': {
          sendDiscordAlert('warning', `Warm Start Failed: ${state.modelType}`,
            `Warm start failed on Neptune — training from scratch.`,
            [
              { name: 'Log', value: path.basename(logFile), inline: false },
            ]
          );
          break;
        }

        // warm_start and overfit_epoch are logged but don't trigger alerts by themselves
        default:
          break;
      }
    }
  }

  // --- Part 1b: Job transition detection ---
  // If a log just completed and a new log appeared, alert about the transition
  const completedLogs = Object.values(trainingLogState).filter(s => s.status === 'completed' && !s.transitionAlerted);
  const runningLogs = Object.values(trainingLogState).filter(s => s.status === 'training' && s.currentFold > 0);

  for (const completed of completedLogs) {
    // Find a running log that started after this one completed
    const completedTime = new Date(completed.startTime).getTime();
    for (const running of runningLogs) {
      const runningTime = new Date(running.startTime).getTime();
      if (runningTime > completedTime && !completed.transitionAlerted) {
        sendDiscordAlert('info', `Job Transition`,
          `${completed.modelType} finished, ${running.modelType} started.`,
          [
            { name: 'Completed', value: completed.modelType, inline: true },
            { name: 'Started', value: running.modelType, inline: true },
            { name: 'New Folds', value: `${running.currentFold}/${running.totalFolds}`, inline: true },
          ]
        );
        completed.transitionAlerted = true;
        break;
      }
    }
  }

  // --- Part 1c: Stale log detection ---
  // If the most recent active log hasn't been updated in 30+ min but GPU is busy, something is wrong
  for (const logInfo of activeLogs.slice(0, 3)) { // Check top 3 most recent
    const state = trainingLogState[logInfo.path];
    if (!state || state.status === 'completed') continue;

    if (logInfo.mtime < recentCutoff && state.currentFold > 0 && state.currentFold < state.totalFolds) {
      const staleMins = Math.round((Date.now() - logInfo.mtime) / 60000);
      if (!state._staleAlerted) {
        sendDiscordAlert('warning', `Training Log Stale: ${state.modelType}`,
          `No new log output for ${staleMins} min. Fold ${state.currentFold}/${state.totalFolds}.`,
          [
            { name: 'Last IC', value: state.lastIC !== null ? state.lastIC.toFixed(4) : 'N/A', inline: true },
            { name: 'Log', value: path.basename(logInfo.path), inline: false },
          ]
        );
        state._staleAlerted = true;
      }
    } else {
      // Log is being updated again, clear stale flag
      if (state._staleAlerted) {
        state._staleAlerted = false;
      }
    }
  }

  // Save state periodically
  saveTrainingLogState();

  // --- Part 1d: Remote node training log monitoring ---
  try {
    const remoteLogs = await findRemoteTrainingLogs();
    const remoteRecentCutoff = Date.now() - 30 * 60 * 1000;

    for (const logInfo of remoteLogs) {
      const { node: nodeName, path: logFile, mtime, size } = logInfo;
      const config = REMOTE_TRAINING_PATHS[nodeName];
      // Use a composite key: node:path
      const stateKey = `${nodeName}:${logFile}`;

      // Initialize state for new remote log files
      if (!trainingLogState[stateKey]) {
        const headerContent = await readRemoteLogHeader(nodeName, logFile, config);
        const modelType = detectModelType(logFile, headerContent);

        trainingLogState[stateKey] = {
          logFile,
          node: nodeName,
          remote: true,
          lastReadPosition: 0,
          modelType,
          currentFold: 0,
          totalFolds: 0,
          lastIC: null,
          foldICs: [],
          lastFoldTime: null,
          startTime: new Date(mtime).toISOString(),
          status: 'training',
          lastAlertFold: 0,
          completionAlerted: false,
          transitionAlerted: false,
          modelParams: null,
          windowMode: null,
          trainingTarget: null,
        };

        // Alert for brand new files (created in last 5 min)
        if (mtime > Date.now() - 5 * 60 * 1000) {
          log('INFO', `New remote training log detected on ${nodeName}: ${path.basename(logFile)} (${modelType})`);
          sendDiscordAlert('info', `Training Started: ${modelType}`,
            `New training run detected on **${nodeName}**.`,
            [{ name: 'Log', value: path.basename(logFile), inline: false }]
          );
        }
      }

      const state = trainingLogState[stateKey];

      // Skip completed/alerted logs that haven't been modified recently
      if (state.status === 'completed' && state.completionAlerted && mtime < remoteRecentCutoff) {
        continue;
      }

      // Read incremental content via SSH
      if (size > state.lastReadPosition) {
        const newContent = await readRemoteLogIncremental(nodeName, logFile, state.lastReadPosition, config);
        if (newContent) {
          state.lastReadPosition = size;
          const events = parseLogContent(newContent, state);

          // Process events — same logic as local but with node name in alerts
          for (const event of events) {
            switch (event.type) {
              case 'fold_start': {
                if (event.fold === 1 && state.lastAlertFold === 0) {
                  log('INFO', `Remote training started on ${nodeName}: ${state.modelType} — fold 1/${event.total}`);
                  sendDiscordAlert('info', `Training Started: ${state.modelType}`,
                    `Fold 1/${event.total} on **${nodeName}**.`,
                    [
                      { name: 'Node', value: nodeName, inline: true },
                      { name: 'Log', value: path.basename(logFile), inline: false },
                      { name: 'Total Folds', value: String(event.total), inline: true },
                    ]
                  );
                  state.lastAlertFold = 1;
                }
                eventBus.trainingProgress(stateKey, nodeName, event.fold, event.total,
                  Math.round((event.fold / event.total) * 100));
                break;
              }

              case 'fold_complete': {
                log('DEBUG', `[${nodeName}] Fold ${event.fold}/${event.total}: IC=${event.ic}, avg=${event.avgIC}`);

                // Alert every 5 folds
                if (event.fold - state.lastAlertFold >= 5) {
                  const elapsed = state.startTime
                    ? ((Date.now() - new Date(state.startTime).getTime()) / 3600000).toFixed(1)
                    : '?';
                  sendDiscordAlert('info', `${state.modelType} — fold ${event.fold}/${event.total}`,
                    `Training progress on **${nodeName}**.`,
                    [
                      { name: 'Node', value: nodeName, inline: true },
                      { name: 'Last IC', value: event.ic.toFixed(4), inline: true },
                      { name: 'Avg IC', value: event.avgIC.toFixed(4), inline: true },
                      { name: 'Elapsed', value: `${elapsed}h`, inline: true },
                    ]
                  );
                  state.lastAlertFold = event.fold;
                }

                if (event.ic < -0.01) {
                  sendDiscordAlert('warning', `WARNING: ${state.modelType} fold ${event.fold} IC: ${event.ic.toFixed(4)}`,
                    `Negative IC on ${nodeName} fold ${event.fold}/${event.total}.`,
                    [
                      { name: 'Node', value: nodeName, inline: true },
                      { name: 'Fold IC', value: event.ic.toFixed(4), inline: true },
                      { name: 'Avg IC', value: event.avgIC.toFixed(4), inline: true },
                    ]
                  );
                }

                eventBus.trainingProgress(stateKey, nodeName, event.fold, event.total,
                  Math.round((event.fold / event.total) * 100));
                break;
              }

              case 'training_complete': {
                if (!state.completionAlerted) {
                  const hours = (event.totalMinutes / 60).toFixed(1);
                  log('INFO', `Remote training COMPLETE on ${nodeName}: ${state.modelType} — ${event.foldCount} folds, avg IC: ${event.avgIC}, time: ${hours}h`);
                  sendDiscordAlert('success', `Training COMPLETE: ${state.modelType}`,
                    `Walk-forward finished on **${nodeName}**.`,
                    [
                      { name: 'Node', value: nodeName, inline: true },
                      { name: 'Folds', value: String(event.foldCount), inline: true },
                      { name: 'Avg IC', value: event.avgIC !== null ? event.avgIC.toFixed(4) : 'N/A', inline: true },
                      { name: 'Total Time', value: `${hours}h`, inline: true },
                      { name: 'Log', value: path.basename(logFile), inline: false },
                    ]
                  );
                  state.completionAlerted = true;
                  state.status = 'completed';
                }
                break;
              }

              case 'checkpoint_resume': {
                log('INFO', `[${nodeName}] Checkpoint resume: skipping ${event.skippedFolds} folds`);
                state.lastAlertFold = event.skippedFolds;
                break;
              }

              case 'warm_start_failed': {
                sendDiscordAlert('warning', `Warm Start Failed: ${state.modelType}`,
                  `Warm start failed on **${nodeName}** — training from scratch.`,
                  [{ name: 'Log', value: path.basename(logFile), inline: false }]
                );
                break;
              }

              default:
                break;
            }
          }
        }
      }

      // Track active remote logs per node for GPU idle correlation
      if (!remoteTrainingTracker[nodeName]) {
        remoteTrainingTracker[nodeName] = { activeLogs: [], lastGpuCheck: 0, gpuIdleMinutes: 0 };
      }
      if (state.status === 'training' && mtime > remoteRecentCutoff) {
        const tracker = remoteTrainingTracker[nodeName];
        if (!tracker.activeLogs.includes(stateKey)) {
          tracker.activeLogs.push(stateKey);
        }
      }

      // Stale log detection for remote nodes
      if (state.status === 'training' && mtime < remoteRecentCutoff &&
          state.currentFold > 0 && state.currentFold < state.totalFolds) {
        const staleMins = Math.round((Date.now() - mtime) / 60000);
        if (!state._staleAlerted) {
          sendDiscordAlert('warning', `Training Log Stale: ${state.modelType} on ${nodeName}`,
            `No new log output for ${staleMins} min. Fold ${state.currentFold}/${state.totalFolds}.`,
            [
              { name: 'Node', value: nodeName, inline: true },
              { name: 'Last IC', value: state.lastIC !== null ? state.lastIC.toFixed(4) : 'N/A', inline: true },
              { name: 'Log', value: path.basename(logFile), inline: false },
            ]
          );
          state._staleAlerted = true;
        }
      } else if (state._staleAlerted && mtime >= remoteRecentCutoff) {
        state._staleAlerted = false;
      }
    }

    // Clean up remoteTrainingTracker — remove logs that are no longer active
    for (const nodeName of Object.keys(remoteTrainingTracker)) {
      const tracker = remoteTrainingTracker[nodeName];
      tracker.activeLogs = tracker.activeLogs.filter(key => {
        const state = trainingLogState[key];
        return state && state.status === 'training';
      });
    }
  } catch (e) {
    log('WARN', `Remote training check failed: ${e.message}`);
  }

  // --- Part 1e: GPU idle + training registered mismatch detection ---
  // If a remote node's GPU has been idle for >10 min but we have a training job registered for it,
  // alert that training may have stopped.
  try {
    for (const [nodeName, config] of Object.entries(REMOTE_TRAINING_PATHS)) {
      const connStatus = sshPool.getConnectionStatus().find(c => c.name === nodeName);
      if (!connStatus?.connected) continue;

      const tracker = remoteTrainingTracker[nodeName] || { activeLogs: [], lastGpuCheck: 0, gpuIdleMinutes: 0 };
      remoteTrainingTracker[nodeName] = tracker;

      // Check GPU utilization
      const gpuStatus = await sshPool.getGPUStatus(nodeName);
      if (!gpuStatus) continue;

      const now = Date.now();
      if (gpuStatus.gpu_util < 5) {
        // GPU idle — track duration
        if (!tracker.gpuIdleSince) tracker.gpuIdleSince = now;
        const idleMinutes = Math.round((now - tracker.gpuIdleSince) / 60000);
        tracker.gpuIdleMinutes = idleMinutes;

        // If GPU idle > 10 min AND we have active training logs registered, alert
        if (idleMinutes >= 10 && tracker.activeLogs.length > 0 && !tracker._gpuTrainingMismatchAlerted) {
          const activeModels = tracker.activeLogs.map(key => {
            const state = trainingLogState[key];
            return state ? `${state.modelType} (fold ${state.currentFold}/${state.totalFolds})` : key;
          }).join(', ');

          sendDiscordAlert('warning', `Training may have stopped on ${nodeName}`,
            `GPU idle for ${idleMinutes} min but training jobs are registered.`,
            [
              { name: 'Node', value: nodeName, inline: true },
              { name: 'GPU Util', value: `${gpuStatus.gpu_util}%`, inline: true },
              { name: 'Active Jobs', value: activeModels, inline: false },
            ]
          );
          tracker._gpuTrainingMismatchAlerted = true;
        }
      } else {
        // GPU active — clear tracking
        tracker.gpuIdleSince = null;
        tracker.gpuIdleMinutes = 0;
        tracker._gpuTrainingMismatchAlerted = false;
      }
    }
  } catch (e) {
    log('WARN', `GPU/training mismatch check failed: ${e.message}`);
  }

  // --- Part 2: DB-based training check (kept for backward compat with manually registered jobs) ---
  const jobs = db.listTrainingJobs('running');
  for (const job of jobs) {
    const prev = alertState.lastTrainingState[job.id];
    const current = { status: job.status, fold: job.current_fold, progress: job.progress_pct };

    if (job.current_fold || job.progress_pct) {
      eventBus.trainingProgress(job.id, job.node, job.current_fold, job.total_folds, job.progress_pct);
    }

    if (prev && prev.status === 'running' && job.status === 'completed') {
      db.sendAlert('info', 'training_monitor', `Training job ${job.id} completed on ${job.node}: ${job.description}`, job.node);
      sendDiscordAlert('success', `Training Complete: ${job.description || 'Job ' + job.id}`,
        `Training job on ${job.node} has finished.`,
        [
          { name: 'Job ID', value: String(job.id), inline: true },
          { name: 'Node', value: job.node, inline: true },
          { name: 'Folds', value: `${job.current_fold || '?'}/${job.total_folds || '?'}`, inline: true },
        ]
      );
    }

    alertState.lastTrainingState[job.id] = current;
  }

  // Check for newly completed DB jobs
  for (const [jobId, prev] of Object.entries(alertState.lastTrainingState)) {
    if (prev.status === 'running' && !jobs.find(j => j.id === parseInt(jobId))) {
      try {
        const allJobs = db.listTrainingJobs();
        const job = allJobs.find(j => j.id === parseInt(jobId));
        if (job && (job.status === 'completed' || job.status === 'failed')) {
          const type = job.status === 'completed' ? 'success' : 'error';
          const title = job.status === 'completed' ? 'Training Complete' : 'Training Failed';
          sendDiscordAlert(type, `${title}: ${job.description || 'Job ' + job.id}`,
            `Job ${job.id} on ${job.node} — ${job.status}`,
            [
              { name: 'Node', value: job.node, inline: true },
              { name: 'Status', value: job.status, inline: true },
            ]
          );
          alertState.lastTrainingState[jobId] = { status: job.status, fold: job.current_fold };
        }
      } catch (e) {
        log('WARN', `Error checking completed job ${jobId}: ${e.message}`);
      }
    }
  }
}

// ========================
// TRAINING LOG MONITOR — Detects stuck/silent training jobs
// ========================

/**
 * Training log monitor: runs every 15 minutes.
 * Checks active training jobs (from both training_jobs and job_queue tables)
 * for signs of being stuck or producing no output.
 *
 * Checks performed:
 *   1. Log file freshness — no modification in 30 min → WARNING
 *   2. Epoch progress — no new epoch line in 60 min → WARNING
 *   3. Results directory empty after 2h of running → CRITICAL
 *   4. Zero-output detection — log file <1KB after 30 min → CRITICAL
 */
async function runTrainingLogMonitor() {
  log('INFO', 'Training log monitor running...');
  const now = Date.now();

  // Gather all active training jobs from both tables
  const activeJobs = [];

  // From training_jobs table (legacy/registered jobs)
  try {
    const trainingJobs = db.listTrainingJobs('running');
    for (const job of trainingJobs) {
      activeJobs.push({
        id: `tj_${job.id}`,
        source: 'training_jobs',
        node: job.node,
        description: job.description || `Training job ${job.id}`,
        startedAt: job.started_at ? new Date(job.started_at).getTime() : now,
        pid: job.pid,
        logPath: null, // Will be determined below
      });
    }
  } catch (e) {
    log('WARN', `Training log monitor: failed to list training_jobs: ${e.message}`);
  }

  // From job_queue table (dispatched jobs with job_type involving training)
  try {
    const queueJobs = db.listJobs('running', null, 100);
    for (const job of queueJobs) {
      if (!job.job_type || !['training', 'sweep'].includes(job.job_type)) continue;
      activeJobs.push({
        id: `jq_${job.id}`,
        source: 'job_queue',
        node: job.node_name,
        description: job.job_name || `Queue job ${job.id}`,
        startedAt: job.started_at ? new Date(job.started_at).getTime() : now,
        pid: job.pid,
        logPath: job.working_dir ? null : null, // Log path comes from convention
      });
    }
  } catch (e) {
    log('WARN', `Training log monitor: failed to list job_queue: ${e.message}`);
  }

  // Also check tracked logs in trainingLogState that are still 'training'
  for (const [key, state] of Object.entries(trainingLogState)) {
    if (state.status !== 'training') continue;
    const nodeName = state.node || (state.remote ? key.split(':')[0] : 'neptune');
    // Avoid duplicating jobs we already have
    const alreadyTracked = activeJobs.some(j => j.node === nodeName && j.description === state.modelType);
    if (!alreadyTracked) {
      activeJobs.push({
        id: `log_${key}`,
        source: 'trainingLogState',
        node: nodeName,
        description: state.modelType || path.basename(state.logFile || key),
        startedAt: state.startTime ? new Date(state.startTime).getTime() : now,
        pid: null,
        logPath: state.logFile || (state.remote ? key.split(':').slice(1).join(':') : key),
        stateKey: key,
      });
    }
  }

  if (activeJobs.length === 0) {
    log('DEBUG', 'Training log monitor: no active training jobs');
    return;
  }

  log('INFO', `Training log monitor: checking ${activeJobs.length} active job(s)`);

  for (const job of activeJobs) {
    const jobRunMinutes = Math.round((now - job.startedAt) / 60000);
    const isLocal = !job.node || job.node === 'neptune' || job.node === 'localhost';
    const alertKey = `${job.node}:${job.id}`;

    try {
      await checkJobLogHealth(job, jobRunMinutes, isLocal, alertKey, now);
    } catch (e) {
      log('WARN', `Training log monitor: error checking job ${job.id} on ${job.node}: ${e.message}`);
    }
  }
}

/**
 * Check a single training job for stuck/silent indicators.
 */
async function checkJobLogHealth(job, jobRunMinutes, isLocal, alertKey, now) {
  const config = REMOTE_TRAINING_PATHS[job.node];

  // Determine log file path
  let logPath = job.logPath;
  if (!logPath && job.stateKey) {
    const state = trainingLogState[job.stateKey];
    if (state) logPath = state.logFile;
  }

  // If we don't have a specific log path, try the QCC job log convention
  if (!logPath) {
    // Try QCC job log: C:\temp\qcc_job_<id>.log
    const numericId = job.id.replace(/^[a-z]+_/, '');
    if (isLocal) {
      const candidatePath = `C:\\temp\\qcc_job_${numericId}.log`;
      if (fs.existsSync(candidatePath)) logPath = candidatePath;
    }
  }

  // --- Check 1: Log file freshness ---
  let logStat = null;
  if (logPath) {
    logStat = await getLogFileStat(logPath, isLocal, job.node, config);
  }

  if (logStat) {
    const logAgeMinutes = Math.round((now - logStat.mtime) / 60000);

    // Check 4 (zero-output): Log file <1KB after 30+ min of running
    if (logStat.size < 1024 && jobRunMinutes >= 30) {
      if (!isAlertRecent(alertKey, 'zero_output', 60)) {
        log('WARN', `CRITICAL: Job "${job.description}" on ${job.node} has log <1KB after ${jobRunMinutes} min — log capture likely broken`);
        sendDiscordAlert('error', `CRITICAL: Zero Output — ${job.description}`,
          `Training job on **${job.node}** has produced <1KB of log after ${jobRunMinutes} min. Log capture is likely broken.`,
          [
            { name: 'Node', value: job.node || 'neptune', inline: true },
            { name: 'Running For', value: `${jobRunMinutes} min`, inline: true },
            { name: 'Log Size', value: `${logStat.size} bytes`, inline: true },
            { name: 'Log File', value: path.basename(logPath), inline: false },
          ]
        );
        db.sendAlert('critical', 'training_log_monitor', `Zero output: ${job.description} on ${job.node} — log <1KB after ${jobRunMinutes} min`, job.node);
        recordAlert(alertKey, 'zero_output');
      }
      return; // No point checking further if log is basically empty
    }

    // Check 1: Log file not modified in 30+ minutes
    if (logAgeMinutes >= 30 && jobRunMinutes >= 30) {
      if (!isAlertRecent(alertKey, 'stale_log', 60)) {
        log('WARN', `WARNING: Job "${job.description}" on ${job.node} — log not modified in ${logAgeMinutes} min`);
        sendDiscordAlert('warning', `Training Log Stale — ${job.description}`,
          `Log file on **${job.node}** has not been modified in ${logAgeMinutes} min.`,
          [
            { name: 'Node', value: job.node || 'neptune', inline: true },
            { name: 'Running For', value: `${jobRunMinutes} min`, inline: true },
            { name: 'Log Stale For', value: `${logAgeMinutes} min`, inline: true },
            { name: 'Log File', value: path.basename(logPath), inline: false },
          ]
        );
        db.sendAlert('warning', 'training_log_monitor', `Stale log: ${job.description} on ${job.node} — no output for ${logAgeMinutes} min`, job.node);
        recordAlert(alertKey, 'stale_log');
      }
    }

    // Check 2: Epoch progress — look for recent epoch lines in the log tail
    if (logAgeMinutes < 30 && jobRunMinutes >= 60) {
      // Log is being written to, but check if epochs are progressing
      await checkEpochProgress(job, logPath, isLocal, config, alertKey, jobRunMinutes, now);
    }

    // ── 2. Training Progress Rate (batch rate) ──
    // Track log size growth and parse batch X/Y lines to compute batches/hour.
    // Only run if log is fresh enough to be active.
    if (logAgeMinutes < 30 && jobRunMinutes >= 30 && logStat) {
      await checkBatchProgressRate(job, logPath, isLocal, config, alertKey, logStat, now);
    }
  } else if (jobRunMinutes >= 30) {
    // No log file found at all after 30 minutes
    if (!isAlertRecent(alertKey, 'no_log_file', 60)) {
      log('WARN', `CRITICAL: Job "${job.description}" on ${job.node} has no log file after ${jobRunMinutes} min`);
      sendDiscordAlert('error', `CRITICAL: No Log File — ${job.description}`,
        `Training job on **${job.node}** has no detectable log file after ${jobRunMinutes} min.`,
        [
          { name: 'Node', value: job.node || 'neptune', inline: true },
          { name: 'Running For', value: `${jobRunMinutes} min`, inline: true },
        ]
      );
      db.sendAlert('critical', 'training_log_monitor', `No log file: ${job.description} on ${job.node} after ${jobRunMinutes} min`, job.node);
      recordAlert(alertKey, 'no_log_file');
    }
  }

  // Check 3: Results directory empty after 2 hours
  if (jobRunMinutes >= 120) {
    await checkResultsDirectory(job, isLocal, config, alertKey, jobRunMinutes);
  }
}

/**
 * Get file stat (size, mtime) for a log file — local or remote via SSH.
 * Returns { size, mtime } or null if file not found.
 */
async function getLogFileStat(logPath, isLocal, nodeName, config) {
  if (isLocal) {
    try {
      const stat = fs.statSync(logPath);
      return { size: stat.size, mtime: stat.mtimeMs };
    } catch (e) {
      return null;
    }
  }

  // Remote: check via SSH
  const connStatus = sshPool.getConnectionStatus().find(c => c.name === nodeName);
  if (!connStatus?.connected) return null;

  const isWindows = config?.os === 'windows';
  try {
    let cmd;
    if (isWindows) {
      cmd = `powershell -NoProfile -Command "if (Test-Path '${logPath}') { $f=Get-Item '${logPath}'; $f.Length.ToString() + '|' + $f.LastWriteTime.ToString('o') } else { 'NOT_FOUND' }"`;
    } else {
      cmd = `stat --format '%s|%Y' "${logPath}" 2>/dev/null || echo 'NOT_FOUND'`;
    }

    const result = await sshPool.exec(nodeName, cmd, 10000);
    if (result.exitCode !== 0 || !result.stdout.trim() || result.stdout.trim() === 'NOT_FOUND') {
      return null;
    }

    const parts = result.stdout.trim().split('|');
    if (parts.length < 2) return null;

    const size = parseInt(parts[0]) || 0;
    const mtime = isWindows
      ? new Date(parts[1]).getTime()
      : parseInt(parts[1]) * 1000;

    if (isNaN(mtime)) return null;
    return { size, mtime };
  } catch (e) {
    log('DEBUG', `getLogFileStat failed for ${logPath} on ${nodeName}: ${e.message}`);
    return null;
  }
}

/**
 * Check epoch progress by reading the tail of a log file and looking for
 * recent epoch completion lines.
 */
async function checkEpochProgress(job, logPath, isLocal, config, alertKey, jobRunMinutes, now) {
  let tailContent = '';

  if (isLocal) {
    try {
      const stat = fs.statSync(logPath);
      const readSize = Math.min(8192, stat.size);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      tailContent = buf.toString('utf8');
    } catch (e) {
      return; // Can't read, skip this check
    }
  } else {
    // Remote: read last 8KB via SSH
    const connStatus = sshPool.getConnectionStatus().find(c => c.name === job.node);
    if (!connStatus?.connected) return;

    const isWindows = config?.os === 'windows';
    try {
      let cmd;
      if (isWindows) {
        cmd = `powershell -NoProfile -Command "$f=[System.IO.File]::OpenRead('${logPath.replace(/'/g, "''")}'); $start=[Math]::Max(0, $f.Length - 8192); $f.Seek($start, 'Begin') | Out-Null; $buf=New-Object byte[] ($f.Length - $start); $n=$f.Read($buf,0,$buf.Length); $f.Close(); [System.Text.Encoding]::UTF8.GetString($buf,0,$n)"`;
      } else {
        cmd = `tail -c 8192 "${logPath}"`;
      }

      const result = await sshPool.exec(job.node, cmd, 10000);
      if (result.exitCode === 0 && result.stdout) {
        tailContent = result.stdout;
      }
    } catch (e) {
      return;
    }
  }

  if (!tailContent) return;

  // Look for epoch lines in the tail content
  const epochPattern = /Epoch\s+\d+\/\d+[:\s].*(IC=|loss=)/g;
  const foldPattern = /Fold IC:\s*[+-]?\d+\.\d+/g;

  const hasRecentEpoch = epochPattern.test(tailContent);
  const hasRecentFold = foldPattern.test(tailContent);

  // If neither pattern found in the last 8KB AND job has been running 60+ min, alert
  if (!hasRecentEpoch && !hasRecentFold && jobRunMinutes >= 60) {
    // Check if the state already shows progress (fold tracking)
    const stateKey = job.stateKey;
    if (stateKey) {
      const state = trainingLogState[stateKey];
      // If state shows active fold progress in the last hour, skip
      if (state && state.currentFold > 0 && state.currentFold < state.totalFolds) {
        // This is already tracked by the stale log detection in runTrainingCheck
        return;
      }
    }

    if (!isAlertRecent(alertKey, 'no_epoch', 120)) {
      log('WARN', `WARNING: Job "${job.description}" on ${job.node} — no epoch progress found in last 8KB of log after ${jobRunMinutes} min`);
      sendDiscordAlert('warning', `No Epoch Progress — ${job.description}`,
        `Training job on **${job.node}** shows no epoch completion lines in recent log output after ${jobRunMinutes} min.`,
        [
          { name: 'Node', value: job.node || 'neptune', inline: true },
          { name: 'Running For', value: `${jobRunMinutes} min`, inline: true },
          { name: 'Log File', value: path.basename(logPath), inline: false },
        ]
      );
      db.sendAlert('warning', 'training_log_monitor', `No epoch progress: ${job.description} on ${job.node} after ${jobRunMinutes} min`, job.node);
      recordAlert(alertKey, 'no_epoch');
    }
  }
}

/**
 * ── 2. Training Progress Rate ──
 * Track log file size growth and parse "batch X/Y" lines to compute batches/hour.
 *
 * Two sub-checks:
 *   A) Log size growth: if the file hasn't grown by >= 100 bytes in 30 min, alert.
 *      (Different from the mtime staleness check — the file could be touched but content unchanged.)
 *   B) Batch rate: parse "batch X/Y" from log tail; if batches/hour < 10, alert.
 *
 * State is persisted in gpuMetricsCache[nodeName].batchTracking[logPath].
 */
async function checkBatchProgressRate(job, logPath, isLocal, config, alertKey, logStat, now) {
  const nodeName = job.node || 'neptune';
  if (!gpuMetricsCache[nodeName]) gpuMetricsCache[nodeName] = {};
  if (!gpuMetricsCache[nodeName].batchTracking) gpuMetricsCache[nodeName].batchTracking = {};

  const tracking = gpuMetricsCache[nodeName].batchTracking;
  const logKey = logPath;

  // Initialize tracking entry for this log file
  if (!tracking[logKey]) {
    tracking[logKey] = {
      firstSeenSize: logStat.size,
      firstSeenTime: now,
      lastSize: logStat.size,
      lastSizeTime: now,
      lastBatchNum: null,
      lastBatchTime: null,
      batchesPerHour: null,
    };
    return; // Need at least one prior snapshot to compute growth
  }

  const t = tracking[logKey];

  // ── Sub-check A: Log size growth ──
  const sizeDeltaBytes = logStat.size - t.lastSize;
  const timeSinceLastCheck = now - t.lastSizeTime; // ms

  if (sizeDeltaBytes < 100 && timeSinceLastCheck >= 1800000) {
    // Less than 100 bytes added in 30 min — file is effectively stalled
    if (!isAlertRecent(alertKey, 'log_no_growth', 60)) {
      const staleMin = Math.round(timeSinceLastCheck / 60000);
      log('WARN', `Log no-growth: ${job.description} on ${nodeName} — only ${sizeDeltaBytes} bytes added in ${staleMin} min`);
      sendDiscordAlert('warning', `Training Stalled — ${job.description}`,
        `Log file on **${nodeName}** grew by only ${sizeDeltaBytes} bytes in ${staleMin} min. Training may be stuck between batches or in a deadlock.`,
        [
          { name: 'Node', value: nodeName, inline: true },
          { name: 'Size Added', value: `${sizeDeltaBytes} bytes`, inline: true },
          { name: 'Time Window', value: `${staleMin} min`, inline: true },
          { name: 'Log File', value: path.basename(logPath), inline: false },
        ]
      );
      db.sendAlert('warning', 'training_log_monitor',
        `Log no-growth: ${job.description} on ${nodeName} — ${sizeDeltaBytes} bytes in ${staleMin} min`, nodeName);
      recordAlert(alertKey, 'log_no_growth');
    }
  }

  // Update size snapshot whenever we get a significant write (or after 30+ min)
  if (sizeDeltaBytes >= 100 || timeSinceLastCheck >= 1800000) {
    t.lastSize = logStat.size;
    t.lastSizeTime = now;
  }

  // ── Sub-check B: Batch rate ──
  // Read last 8KB of log to find most recent "batch X/Y" line
  let tailContent = '';
  if (isLocal) {
    try {
      const readSize = Math.min(8192, logStat.size);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, readSize, Math.max(0, logStat.size - readSize));
      fs.closeSync(fd);
      tailContent = buf.toString('utf8');
    } catch (e) {
      return;
    }
  } else {
    const connStatus = sshPool.getConnectionStatus().find(c => c.name === nodeName);
    if (!connStatus?.connected) return;
    const isWindows = config?.os === 'windows';
    try {
      let cmd;
      if (isWindows) {
        cmd = `powershell -NoProfile -Command "$f=[System.IO.File]::OpenRead('${logPath.replace(/'/g, "''")}'); $start=[Math]::Max(0, $f.Length - 8192); $f.Seek($start, 'Begin') | Out-Null; $buf=New-Object byte[] ($f.Length - $start); $n=$f.Read($buf,0,$buf.Length); $f.Close(); [System.Text.Encoding]::UTF8.GetString($buf,0,$n)"`;
      } else {
        cmd = `tail -c 8192 "${logPath}"`;
      }
      const result = await sshPool.exec(nodeName, cmd, 10000);
      if (result.exitCode === 0 && result.stdout) tailContent = result.stdout;
    } catch (e) {
      return;
    }
  }

  if (!tailContent) return;

  // Match patterns like: "batch 42/100", "Batch 42/100", "step 42/100", "[42/100]"
  // Use the last match found (most recent batch line in the tail)
  const batchPattern = /(?:batch|step|Batch|Step)\s+(\d+)\s*\/\s*(\d+)/gi;
  let lastMatch = null;
  let m;
  while ((m = batchPattern.exec(tailContent)) !== null) lastMatch = m;

  if (!lastMatch) return;

  const currentBatch = parseInt(lastMatch[1]);

  if (t.lastBatchNum !== null && t.lastBatchTime !== null) {
    const batchDelta = currentBatch - t.lastBatchNum;
    const timeDeltaHours = (now - t.lastBatchTime) / 3600000;

    if (timeDeltaHours > 0 && batchDelta >= 0) {
      t.batchesPerHour = parseFloat((batchDelta / timeDeltaHours).toFixed(1));
      // Store on node cache for dashboard visibility
      if (!gpuMetricsCache[nodeName].batchRates) gpuMetricsCache[nodeName].batchRates = {};
      gpuMetricsCache[nodeName].batchRates[path.basename(logPath)] = {
        batchesPerHour: t.batchesPerHour,
        currentBatch,
        measuredAt: new Date(now).toISOString(),
      };

      log('DEBUG', `Batch rate for ${nodeName} [${path.basename(logPath)}]: ${t.batchesPerHour} batches/hr (delta ${batchDelta} in ${(timeDeltaHours * 60).toFixed(1)} min)`);

      if (t.batchesPerHour < 10 && batchDelta > 0) {
        if (!isAlertRecent(alertKey, 'slow_batch_rate', 120)) {
          log('WARN', `Extremely slow batch rate on ${nodeName}: ${t.batchesPerHour} batches/hr for ${job.description}`);
          sendDiscordAlert('warning', `Training Extremely Slow — ${job.description}`,
            `Training on **${nodeName}** is processing only **${t.batchesPerHour} batches/hour**. ` +
            `Check num_workers, prefetch_factor, and pin_memory in the DataLoader. Consider increasing num_workers or pre-loading data to RAM.`,
            [
              { name: 'Node', value: nodeName, inline: true },
              { name: 'Batch Rate', value: `${t.batchesPerHour} batches/hr`, inline: true },
              { name: 'Current Batch', value: `${currentBatch}`, inline: true },
              { name: 'Log File', value: path.basename(logPath), inline: false },
              { name: 'Fix', value: 'Increase num_workers, prefetch_factor, or pin_memory in DataLoader', inline: false },
            ]
          );
          db.sendAlert('warning', 'training_log_monitor',
            `Extremely slow batch rate: ${t.batchesPerHour} batches/hr for ${job.description} on ${nodeName}`, nodeName);
          recordAlert(alertKey, 'slow_batch_rate');
        }
      }
    }
  }

  // Update batch snapshot
  t.lastBatchNum = currentBatch;
  t.lastBatchTime = now;
}

/**
 * Check if a training job's results directory has any output files
 * (.pt weights, .npz predictions, .json results) after running 2+ hours.
 */
async function checkResultsDirectory(job, isLocal, config, alertKey, jobRunMinutes) {
  // Determine the results directory based on node
  let resultsDir;
  if (isLocal) {
    resultsDir = TRAINING_LOG_DIRS[0]; // Neptune results dir
  } else if (config) {
    resultsDir = config.resultsDir;
  } else {
    return; // Unknown node, skip
  }

  // Get the model type to narrow the search
  let modelType = null;
  if (job.stateKey && trainingLogState[job.stateKey]) {
    modelType = trainingLogState[job.stateKey].modelType;
  }

  let hasResults = false;

  if (isLocal) {
    try {
      if (!fs.existsSync(resultsDir)) return;
      const files = fs.readdirSync(resultsDir, { recursive: true });
      for (const file of files) {
        const fname = typeof file === 'string' ? file : file.toString();
        if (fname.endsWith('.pt') || fname.endsWith('.npz') || fname.endsWith('.json')) {
          // Check if this result file was created after the job started
          try {
            const fstat = fs.statSync(path.join(resultsDir, fname));
            if (fstat.mtimeMs >= job.startedAt) {
              hasResults = true;
              break;
            }
          } catch (e) { /* skip */ }
        }
      }
    } catch (e) {
      return; // Can't scan directory, skip
    }
  } else {
    // Remote: check via SSH
    const connStatus = sshPool.getConnectionStatus().find(c => c.name === job.node);
    if (!connStatus?.connected) return;

    const isWindows = config?.os === 'windows';
    const jobStartISO = new Date(job.startedAt).toISOString();
    try {
      let cmd;
      if (isWindows) {
        cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${resultsDir}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { ($_.Extension -in '.pt','.npz','.json') -and ($_.LastWriteTime -gt [DateTime]::Parse('${jobStartISO}')) } | Select-Object -First 1 -ExpandProperty Name"`;
      } else {
        const startEpoch = Math.floor(job.startedAt / 1000);
        cmd = `find "${resultsDir}" -maxdepth 3 \\( -name '*.pt' -o -name '*.npz' -o -name '*.json' \\) -newermt @${startEpoch} 2>/dev/null | head -1`;
      }

      const result = await sshPool.exec(job.node, cmd, 15000);
      if (result.exitCode === 0 && result.stdout.trim()) {
        hasResults = true;
      }
    } catch (e) {
      return;
    }
  }

  if (!hasResults) {
    if (!isAlertRecent(alertKey, 'empty_results', 120)) {
      log('WARN', `CRITICAL: Job "${job.description}" on ${job.node} — no result files after ${jobRunMinutes} min`);
      sendDiscordAlert('error', `CRITICAL: No Results — ${job.description}`,
        `Training job on **${job.node}** has produced no output files (.pt/.npz/.json) after ${jobRunMinutes} min.`,
        [
          { name: 'Node', value: job.node || 'neptune', inline: true },
          { name: 'Running For', value: `${jobRunMinutes} min (${(jobRunMinutes / 60).toFixed(1)}h)`, inline: true },
          { name: 'Results Dir', value: path.basename(resultsDir), inline: false },
        ]
      );
      db.sendAlert('critical', 'training_log_monitor', `Empty results: ${job.description} on ${job.node} — no output files after ${jobRunMinutes} min`, job.node);
      recordAlert(alertKey, 'empty_results');
    }
  }
}

/**
 * Check if an alert of this type was sent recently (within cooldownMinutes).
 * Prevents spamming the same alert every 15 minutes.
 */
function isAlertRecent(alertKey, alertType, cooldownMinutes) {
  const key = `${alertKey}:${alertType}`;
  const prev = alertState.logMonitorAlerts[key];
  if (!prev) return false;
  return (Date.now() - prev.timestamp) < cooldownMinutes * 60000;
}

/**
 * Record that an alert was sent for dedup tracking.
 */
function recordAlert(alertKey, alertType) {
  const key = `${alertKey}:${alertType}`;
  alertState.logMonitorAlerts[key] = { type: alertType, timestamp: Date.now() };
}

// ========================
// JOB QUEUE DISPATCHER
// ========================

async function runJobDispatcher() {
  // Phase 1: Check running jobs for completion
  const runningJobs = db.getRunningJobs();
  for (const job of runningJobs) {
    if (!job.node_name || !job.pid) continue;
    try {
      await checkRunningJob(job);
    } catch (e) {
      log('WARN', `Error checking job ${job.id} on ${job.node_name}: ${e.message}`);
    }
  }

  // Phase 2: Dispatch queued jobs to available nodes
  const nodes = db.getNodes();
  for (const node of nodes) {
    const connStatus = sshPool.getConnectionStatus().find(c => c.name === node.name);
    if (!connStatus?.connected) continue;

    // Check node capacity
    const nodeAvailable = await isNodeAvailable(node);
    if (!nodeAvailable) continue;

    // Find next job for this node
    const job = db.getNextJob(node.name);
    if (!job) continue;

    // If job requires GPU and node has no GPU, skip
    if (job.requires_gpu && (!node.gpu || node.gpu === 'none')) continue;

    // Reserve resources before launching to prevent double-dispatch
    try {
      const resourceType = job.requires_gpu ? 'gpu' : 'cpu_slot';
      db.reserveResource(node.name, resourceType, job.id);
      // Also reserve a cpu_slot for GPU jobs (they use CPU too)
      if (job.requires_gpu) {
        db.reserveResource(node.name, 'cpu_slot', job.id);
      }
    } catch (e) {
      log('WARN', `Resource already reserved for job ${job.id} on ${node.name}, skipping`);
      continue;
    }

    // Claim and launch
    try {
      await launchJob(job, node);
    } catch (e) {
      log('ERROR', `Failed to launch job ${job.id} on ${node.name}: ${e.message}`);
      db.failJob(job.id, -1, e.message);
    }
  }
}
async function isNodeAvailable(node) {
  const hasGPU = node.gpu && node.gpu !== 'none';

  // Check resource reservations � prevents double-dispatch within the same cycle
  if (hasGPU) {
    if (!db.isResourceAvailable(node.name, 'gpu')) return false;

    // Also check actual GPU utilization as a fallback
    if (node.last_gpu_util !== null && node.last_gpu_util > 80) return false;
  }

  // Check CPU slot reservations (max 3 concurrent jobs per node)
  if (!db.isResourceAvailable(node.name, 'cpu_slot', 3)) return false;

  // Check CPU load via SSH (quick check)
  try {
    const isWindows = node.os === 'windows';
    const loadCmd = isWindows
      ? "powershell -Command \"(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples[0].CookedValue\""
      : "cat /proc/loadavg | awk '{print $1}'";
    const result = await sshPool.exec(node.name, loadCmd, 5000);
    if (result.exitCode === 0) {
      const load = parseFloat(result.stdout.trim());
      if (isWindows) {
        // Windows returns CPU percentage directly
        if (load > 80) return false;
      } else {
        // Linux loadavg: compare to reasonable threshold
        if (load > 4) return false;
      }
    }
  } catch (e) {
    // Can't check load, assume available
  }

  return true;
}

async function launchJob(job, node) {
  log('INFO', `Launching job ${job.id} (${job.job_name}) on ${node.name}`);

  // Claim the job
  db.claimJob(job.id, node.name);

  // Build the launch command with nohup and output redirection
  const isWindows = node.os === 'windows';
  let launchCmd;

  if (isWindows) {
    // Windows: use Start-Process via powershell to run detached
    const logFile = `C:\\temp\\qcc_job_${job.id}.log`;
    const cdPart = job.working_dir ? `cd '${job.working_dir}'; ` : '';
    launchCmd = `powershell -Command "${cdPart}Start-Process -FilePath cmd.exe -ArgumentList '/c ${job.command.replace(/"/g, '\\"')} > ${logFile} 2>&1' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id"`;
  } else {
    // Linux: nohup with background
    const logFile = `/tmp/qcc_job_${job.id}.log`;
    const cdPart = job.working_dir ? `cd '${job.working_dir}' && ` : '';
    launchCmd = `${cdPart}nohup ${job.command} > ${logFile} 2>&1 & echo $!`;
  }

  const result = await sshPool.exec(node.name, launchCmd, 15000);

  if (result.exitCode !== 0) {
    db.failJob(job.id, result.exitCode, (result.stderr || '').slice(-500));
    log('ERROR', `Job ${job.id} launch failed on ${node.name}`, { stderr: result.stderr });
    sendDiscordAlert('error', `Job Failed to Launch: ${job.job_name}`,
      `Job ${job.id} failed to start on ${node.name}.`,
      [{ name: 'Error', value: (result.stderr || 'Unknown error').slice(0, 200), inline: false }]
    );
    return;
  }

  // Parse PID from output
  const pid = parseInt(result.stdout.trim().split('\n').pop().trim(), 10);
  if (isNaN(pid)) {
    db.failJob(job.id, -1, `Could not parse PID from output: ${result.stdout.slice(0, 200)}`);
    log('ERROR', `Job ${job.id}: could not parse PID`, { stdout: result.stdout });
    return;
  }

  // Mark as running
  db.startJob(job.id, pid);
  log('INFO', `Job ${job.id} running on ${node.name} with PID ${pid}`);

  sendDiscordAlert('info', `Job Started: ${job.job_name}`,
    `Job ${job.id} launched on ${node.name} (PID: ${pid}).`,
    [
      { name: 'Type', value: job.job_type, inline: true },
      { name: 'Priority', value: String(job.priority), inline: true },
      { name: 'Node', value: node.name, inline: true },
    ]
  );
  eventBus.jobStarted(job.id, job.job_name, node.name, pid);
}

async function checkRunningJob(job) {
  const node = db.getNode(job.node_name);
  if (!node) return;

  const isWindows = node.os === 'windows';

  // Check if PID is still alive
  const checkCmd = isWindows
    ? `powershell -Command "Get-Process -Id ${job.pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`
    : `kill -0 ${job.pid} 2>/dev/null && echo alive || echo dead`;

  const result = await sshPool.exec(job.node_name, checkCmd, 10000);

  let isAlive;
  if (isWindows) {
    isAlive = result.exitCode === 0 && result.stdout.trim() === String(job.pid);
  } else {
    isAlive = result.stdout.trim() === 'alive';
  }

  if (isAlive) {
    // Optionally read last lines of log for progress update
    const logFile = isWindows ? `C:\\temp\\qcc_job_${job.id}.log` : `/tmp/qcc_job_${job.id}.log`;
    const tailCmd = isWindows
      ? `powershell -Command "if (Test-Path '${logFile}') { Get-Content '${logFile}' -Tail 5 } else { '' }"`
      : `tail -5 ${logFile} 2>/dev/null || true`;

    const logResult = await sshPool.exec(job.node_name, tailCmd, 5000);
    if (logResult.exitCode === 0 && logResult.stdout.trim()) {
      // Update output_tail for progress tracking
      db.db.prepare(`UPDATE job_queue SET output_tail = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(logResult.stdout.trim().slice(-500), job.id);
    }
    return;
  }

  // Process is dead — determine exit status
  log('INFO', `Job ${job.id} (${job.job_name}) on ${job.node_name} has finished`);

  // Read the output log
  const logFile = isWindows ? `C:\\temp\\qcc_job_${job.id}.log` : `/tmp/qcc_job_${job.id}.log`;
  const readCmd = isWindows
    ? `powershell -Command "if (Test-Path '${logFile}') { Get-Content '${logFile}' -Tail 50 } else { 'No log file found' }"`
    : `tail -50 ${logFile} 2>/dev/null || echo 'No log file found'`;

  const logResult = await sshPool.exec(job.node_name, readCmd, 10000);
  const outputTail = (logResult.stdout || '').slice(-500);

  // Try to determine exit code (best effort)
  // For now, if process is dead and log exists, assume exit code 0 (success)
  // We can try to find error indicators in the output
  const hasError = /error|exception|traceback|failed|fatal/i.test(outputTail);
  const exitCode = hasError ? 1 : 0;

  if (exitCode === 0) {
    // Parse results from output if this is a training fold
    let resultJson = null;
    if (job.job_type === 'training_fold') {
      resultJson = parseTrainingOutput(outputTail);
    }

    db.completeJob(job.id, 0, resultJson, outputTail);

    sendDiscordAlert('success', `Job Complete: ${job.job_name}`,
      `Job ${job.id} on ${job.node_name} finished successfully.`,
      [
        { name: 'Duration', value: formatDuration(job.started_at), inline: true },
        { name: 'Output (last)', value: outputTail.slice(-200) || 'N/A', inline: false },
      ]
    );
    eventBus.jobCompleted(job.id, job.job_name, job.node_name, 0, outputTail.slice(-200));

    // Handle chain_next — auto-create the next job
    if (job.chain_next) {
      handleChainNext(job, outputTail);
    }
  } else {
    db.failJob(job.id, exitCode, outputTail);

    sendDiscordAlert('error', `Job Failed: ${job.job_name}`,
      `Job ${job.id} on ${job.node_name} failed.`,
      [
        { name: 'Duration', value: formatDuration(job.started_at), inline: true },
        { name: 'Error', value: outputTail.slice(-200) || 'Unknown error', inline: false },
      ]
    );
    eventBus.jobFailed(job.id, job.job_name, job.node_name, exitCode, outputTail.slice(-200));
  }
}

function parseTrainingOutput(output) {
  // Try to extract IC, fold number, loss from training output
  const result = {};

  const icMatch = output.match(/(?:ic|IC)[=:\s]+(-?[\d.]+)/);
  if (icMatch) result.ic = parseFloat(icMatch[1]);

  const foldMatch = output.match(/(?:fold|Fold)[=:\s]+(\d+)/);
  if (foldMatch) result.fold = parseInt(foldMatch[1]);

  const lossMatch = output.match(/(?:val_loss|val loss)[=:\s]+([\d.]+)/);
  if (lossMatch) result.val_loss = parseFloat(lossMatch[1]);

  const sharpeMatch = output.match(/(?:sharpe|Sharpe)[=:\s]+(-?[\d.]+)/);
  if (sharpeMatch) result.sharpe = parseFloat(sharpeMatch[1]);

  return Object.keys(result).length > 0 ? JSON.stringify(result) : null;
}

function handleChainNext(completedJob, output) {
  try {
    const chain = typeof completedJob.chain_next === 'string'
      ? JSON.parse(completedJob.chain_next)
      : completedJob.chain_next;

    if (!chain || !chain.type) return;

    // Parse fold number from output if available
    let currentFold = null;
    const foldMatch = output.match(/(?:fold|Fold)[=:\s]+(\d+)/);
    if (foldMatch) currentFold = parseInt(foldMatch[1]);

    // Build next job
    let nextFold = chain.fold;
    if (nextFold === undefined && currentFold !== null) {
      nextFold = currentFold + 1;
    }

    let command = chain.command_template || chain.command;
    if (command && nextFold !== undefined) {
      command = command.replace(/\{fold\}/g, String(nextFold));
    }

    if (!command) {
      log('WARN', `chain_next for job ${completedJob.id} has no command`);
      return;
    }

    // Build the chain_next for the NEXT job (increment fold again)
    let nextChain = null;
    if (chain.max_fold === undefined || nextFold < chain.max_fold) {
      nextChain = { ...chain };
      if (nextFold !== undefined) {
        nextChain.fold = nextFold + 1;
      }
    }

    const newJob = db.enqueueJob({
      job_type: chain.type || completedJob.job_type,
      job_name: `${completedJob.job_name} (fold ${nextFold || '?'})`,
      node_name: completedJob.node_name,
      requires_gpu: completedJob.requires_gpu,
      command,
      working_dir: completedJob.working_dir,
      config_json: completedJob.config_json,
      priority: completedJob.priority,
      depends_on: completedJob.id,
      chain_next: nextChain ? JSON.stringify(nextChain) : null,
      created_by: 'auto_chain',
    });

    log('INFO', `Auto-chained job ${newJob.id} from completed job ${completedJob.id} (fold ${nextFold})`);

    sendDiscordAlert('info', `Job Chained: fold ${nextFold}`,
      `Auto-created job ${newJob.id} from completed job ${completedJob.id}.`,
      [
        { name: 'Next Fold', value: String(nextFold || '?'), inline: true },
        { name: 'Node', value: completedJob.node_name, inline: true },
      ]
    );

    // If this was a training fold, try to store the IC in fold_results
    if (chain.type === 'training_fold' && completedJob.result_json) {
      try {
        const result = JSON.parse(completedJob.result_json);
        if (result.ic !== undefined) {
          db.recordFoldResult({
            fold_number: currentFold,
            ic: result.ic,
            val_loss: result.val_loss || null,
            node_name: completedJob.node_name,
            status: 'completed',
            completed_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        log('WARN', `Could not record fold result for job ${completedJob.id}: ${e.message}`);
      }
    }
  } catch (e) {
    log('ERROR', `chain_next handling failed for job ${completedJob.id}: ${e.message}`);
  }
}

function formatDuration(startedAt) {
  if (!startedAt) return 'unknown';
  const sec = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

// ========================
// PIPELINE CHECK
// ========================

// Known data paths on Jupiter
const PIPELINE_CONFIG = {
  mbo_dir: '/home/footb/Lvl3Quant/data/raw/mbo',
  mbo_pattern: 'glbx-mdp3-*.mbo.dbn.zst',
  tensor_dir: '/home/footb/Lvl3Quant/data/processed/book_tensors',
  predictions_dir: '/home/footb/Lvl3Quant/data/processed/cnn_wf_stacked_predictions',
  predictions_pattern: '*.npz',
  source_node: 'jupiter',
};

async function runPipelineCheck() {
  log('INFO', 'Running pipeline check...');

  // Step 1: Scan for MBO files on Jupiter and register them
  try {
    await scanMBOFiles();
  } catch (e) {
    log('WARN', `MBO scan failed (SSH may not be connected): ${e.message}`);
  }

  // Step 2: Scan for prediction files
  try {
    await scanPredictionFiles();
  } catch (e) {
    log('WARN', `Prediction scan failed: ${e.message}`);
  }

  // Step 3: Check for missing stages and auto-enqueue jobs
  autoEnqueuePipelineJobs();

  log('INFO', 'Pipeline check complete');
}

async function scanMBOFiles() {
  const node = PIPELINE_CONFIG.source_node;
  const connStatus = sshPool.getConnectionStatus().find(c => c.name === node);
  if (!connStatus?.connected) {
    log('DEBUG', `Skipping MBO scan: ${node} not connected`);
    return;
  }

  // List MBO files
  const cmd = `ls -1 ${PIPELINE_CONFIG.mbo_dir}/${PIPELINE_CONFIG.mbo_pattern} 2>/dev/null | head -200`;
  const result = await sshPool.exec(node, cmd, 15000);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log('DEBUG', 'No MBO files found or ls failed');
    return;
  }

  const files = result.stdout.trim().split('\n').filter(f => f.trim());
  let registered = 0;

  for (const filePath of files) {
    // Extract date from filename: glbx-mdp3-YYYYMMDD.mbo.dbn.zst
    const dateMatch = filePath.match(/glbx-mdp3-(\d{4})(\d{2})(\d{2})/);
    if (!dateMatch) continue;
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

    // Check if this date already has mbo_raw registered
    const existing = db.db.prepare(
      "SELECT id FROM data_pipelines WHERE date = ? AND stage = 'mbo_raw'"
    ).get(date);

    if (!existing) {
      db.updatePipelineStage(date, 'mbo_raw', 'completed', filePath, null);
      registered++;
    }
  }

  if (registered > 0) {
    log('INFO', `Registered ${registered} new MBO dates in pipeline`);
  }
}

async function scanPredictionFiles() {
  const node = PIPELINE_CONFIG.source_node;
  const connStatus = sshPool.getConnectionStatus().find(c => c.name === node);
  if (!connStatus?.connected) {
    log('DEBUG', `Skipping prediction scan: ${node} not connected`);
    return;
  }

  // List prediction files
  const cmd = `ls -1 ${PIPELINE_CONFIG.predictions_dir}/${PIPELINE_CONFIG.predictions_pattern} 2>/dev/null | head -200`;
  const result = await sshPool.exec(node, cmd, 15000);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log('DEBUG', 'No prediction files found or ls failed');
    return;
  }

  const files = result.stdout.trim().split('\n').filter(f => f.trim());
  let registered = 0;

  for (const filePath of files) {
    // Extract date from filename — expecting YYYY-MM-DD or YYYYMMDD in filename
    const dateMatch = filePath.match(/(\d{4})-(\d{2})-(\d{2})/) || filePath.match(/(\d{4})(\d{2})(\d{2})/);
    if (!dateMatch) continue;
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

    const existing = db.db.prepare(
      "SELECT id FROM data_pipelines WHERE date = ? AND stage = 'predictions'"
    ).get(date);

    if (!existing) {
      db.updatePipelineStage(date, 'predictions', 'completed', filePath, null);
      registered++;
    }
  }

  if (registered > 0) {
    log('INFO', `Registered ${registered} new prediction dates in pipeline`);
  }
}

function autoEnqueuePipelineJobs() {
  const node = PIPELINE_CONFIG.source_node;

  // Find dates with MBO but no tensor cache
  const needsTensors = db.getIncompleteStages('tensor_cache');
  for (const row of needsTensors.slice(0, 5)) { // Limit to 5 at a time
    const date = row.date;
    const dateCompact = date.replace(/-/g, '');

    // Check if a job is already queued for this
    const existingJob = db.db.prepare(`
      SELECT id FROM job_queue WHERE job_name LIKE ? AND status IN ('queued', 'assigned', 'running')
    `).get(`%tensor%${date}%`);

    if (existingJob) continue;

    const mboPath = `${PIPELINE_CONFIG.mbo_dir}/glbx-mdp3-${dateCompact}.mbo.dbn.zst`;
    const outputPath = `${PIPELINE_CONFIG.tensor_dir}/${date}`;

    const job = db.enqueueJob({
      job_type: 'pipeline',
      job_name: `tensor_cache ${date}`,
      node_name: node,
      requires_gpu: false,
      command: `cd /home/footb/Lvl3Quant && python3 -m data_pipeline.build_tensors --date ${date} --input ${mboPath} --output ${outputPath}`,
      working_dir: '/home/footb/Lvl3Quant',
      config_json: JSON.stringify({ pipeline_stage: 'tensor_cache', date }),
      priority: 7, // Lower priority than training
    });

    db.updatePipelineStage(date, 'tensor_cache', 'pending');
    db.linkPipelineJob(date, 'tensor_cache', job.id);
    log('INFO', `Auto-enqueued tensor_cache job for ${date} (job_id=${job.id})`);
  }

  // Find dates with tensor cache but no predictions
  const needsPredictions = db.getIncompleteStages('predictions');
  for (const row of needsPredictions.slice(0, 5)) {
    const date = row.date;

    const existingJob = db.db.prepare(`
      SELECT id FROM job_queue WHERE job_name LIKE ? AND status IN ('queued', 'assigned', 'running')
    `).get(`%predict%${date}%`);

    if (existingJob) continue;

    const tensorPath = `${PIPELINE_CONFIG.tensor_dir}/${date}`;
    const outputPath = `${PIPELINE_CONFIG.predictions_dir}/${date}.npz`;

    const job = db.enqueueJob({
      job_type: 'pipeline',
      job_name: `predictions ${date}`,
      node_name: null, // Any GPU node
      requires_gpu: true,
      command: `cd /home/footb/Lvl3Quant && python3 -m data_pipeline.generate_predictions --date ${date} --input ${tensorPath} --output ${outputPath}`,
      working_dir: '/home/footb/Lvl3Quant',
      config_json: JSON.stringify({ pipeline_stage: 'predictions', date }),
      priority: 6,
    });

    db.updatePipelineStage(date, 'predictions', 'pending');
    db.linkPipelineJob(date, 'predictions', job.id);
    log('INFO', `Auto-enqueued predictions job for ${date} (job_id=${job.id})`);
  }

  // Find dates with predictions but no validation
  const needsValidation = db.getIncompleteStages('validated');
  for (const row of needsValidation.slice(0, 5)) {
    const date = row.date;

    const existingJob = db.db.prepare(`
      SELECT id FROM job_queue WHERE job_name LIKE ? AND status IN ('queued', 'assigned', 'running')
    `).get(`%validat%${date}%`);

    if (existingJob) continue;

    const predPath = `${PIPELINE_CONFIG.predictions_dir}/${date}.npz`;

    const job = db.enqueueJob({
      job_type: 'pipeline',
      job_name: `validation ${date}`,
      node_name: node,
      requires_gpu: false,
      command: `cd /home/footb/Lvl3Quant && python3 -m data_pipeline.validate_oot --date ${date} --predictions ${predPath}`,
      working_dir: '/home/footb/Lvl3Quant',
      config_json: JSON.stringify({ pipeline_stage: 'validated', date }),
      priority: 7,
    });

    db.updatePipelineStage(date, 'validated', 'pending');
    db.linkPipelineJob(date, 'validated', job.id);
    log('INFO', `Auto-enqueued validation job for ${date} (job_id=${job.id})`);
  }
}

// ========================
// SCHEDULED TASKS EXECUTOR
// ========================

// Parse a cron expression and return true if it should fire at the current minute.
// Supports standard 5-field cron: "* * * * *", "step */15", ranges "0 6 * * 1-5", etc.
// Fields: minute hour day-of-month month day-of-week
function cronMatches(expr, now) {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minField, hourField, domField, monField, dowField] = parts;

    const minute = now.getMinutes();
    const hour = now.getHours();
    const dom = now.getDate();
    const month = now.getMonth() + 1; // 1-12
    const dow = now.getDay(); // 0=Sun

    function fieldMatches(field, value) {
      if (field === '*') return true;
      // */N step
      const stepMatch = field.match(/^\*\/(\d+)$/);
      if (stepMatch) return value % parseInt(stepMatch[1]) === 0;
      // Range a-b
      const rangeMatch = field.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) return value >= parseInt(rangeMatch[1]) && value <= parseInt(rangeMatch[2]);
      // List a,b,c
      if (field.includes(',')) return field.split(',').map(Number).includes(value);
      // Plain number
      return parseInt(field) === value;
    }

    return fieldMatches(minField, minute)
      && fieldMatches(hourField, hour)
      && fieldMatches(domField, dom)
      && fieldMatches(monField, month)
      && fieldMatches(dowField, dow);
  } catch (e) {
    return false;
  }
}

async function runScheduledTasks() {
  const now = new Date();
  // Use ET time for cron matching (trading-day aware)
  const etNow = getETNow();
  const tasks = db.listScheduledTasks(true); // enabled only

  for (const task of tasks) {
    if (!task.enabled) continue;
    if (!cronMatches(task.cron_expr, etNow)) continue;

    // Avoid re-running within the same minute
    if (task.last_run) {
      const lastRun = new Date(task.last_run);
      const diffMs = now - lastRun;
      if (diffMs < 55000) continue; // already ran within the last 55s
    }

    log('INFO', `Running scheduled task: ${task.name} (${task.cron_expr})`);

    try {
      let status = 'ok';
      let error = null;

      switch (task.task_type) {
        case 'health': {
          // Run health check and update node statuses
          const health = db.healthCheck();
          const staleCount = health.stale_jobs.length;
          const alertCount = health.unresolved_alerts.length;
          log('INFO', `Health check: ${health.nodes.length} nodes, ${health.active_jobs.length} active jobs, ${staleCount} stale, ${alertCount} alerts`);

          // Mark stale jobs
          for (const staleJob of health.stale_jobs) {
            try {
              db.updateTrainingJob(staleJob.id, {
                status: 'stale',
                error_msg: 'No heartbeat for >30 min (detected by scheduled health check)',
              });
              log('WARN', `Marked job ${staleJob.id} as stale on ${staleJob.node}`);
            } catch (e) {
              log('WARN', `Failed to mark job ${staleJob.id} stale: ${e.message}`);
            }
          }

          // Discord alert if there are critical unresolved alerts
          const criticalAlerts = health.unresolved_alerts.filter(a => a.severity === 'critical');
          if (criticalAlerts.length > 0) {
            const msgs = criticalAlerts.slice(0, 3).map(a => `• ${a.source}: ${a.message.slice(0, 80)}`).join('\n');
            sendDiscordAlert('warning', `Health Check: ${criticalAlerts.length} critical alerts`,
              `Unresolved critical alerts:\n${msgs}`
            );
          }
          break;
        }
        case 'report': {
          // EOD report (supplemental — main logic is in checkEndOfDay)
          if (isTradingDay()) {
            log('INFO', 'EOD report task triggered');
          }
          break;
        }
        case 'scan': {
          // Data integrity scan — just log for now, SSH not guaranteed
          log('INFO', `Data verify scan task triggered: ${task.name}`);
          break;
        }
        default: {
          log('DEBUG', `Scheduled task ${task.name} (${task.task_type}) triggered — no handler implemented`);
          break;
        }
      }

      db.updateScheduledTask(task.name, {
        last_run: now.toISOString(),
        last_status: status,
        last_error: error,
      });
    } catch (e) {
      log('ERROR', `Scheduled task ${task.name} failed: ${e.message}`);
      db.updateScheduledTask(task.name, {
        last_run: now.toISOString(),
        last_status: 'error',
        last_error: e.message,
      });
    }
  }
}

// ========================
// PAPER ENGINE WATCHDOG
// ========================

let paperWasRunning = null;

function checkPaperEngine() {
  const isRunning = fs.existsSync(PAPER_STATE_PATH);

  if (paperWasRunning === true && !isRunning) {
    // Paper engine went down
    db.sendAlert('critical', 'paper_engine', 'Paper trading engine stopped (live_state.json missing)');
    sendDiscordAlert('error', 'Paper Engine DOWN',
      'The paper trading engine has stopped. live_state.json is missing.'
    );
  } else if (paperWasRunning === false && isRunning) {
    // Paper engine came back up
    db.sendAlert('info', 'paper_engine', 'Paper trading engine started');
    sendDiscordAlert('success', 'Paper Engine Started',
      'Paper trading engine is now running.'
    );
  }

  // Check staleness — if file exists but hasn't been updated in 5 min, engine may be frozen
  if (isRunning) {
    try {
      const stats = fs.statSync(PAPER_STATE_PATH);
      const age = Date.now() - stats.mtimeMs;
      if (age > 300000) { // 5 min
        log('WARN', `Paper state file is ${Math.round(age/1000)}s old — engine may be frozen`);
      }
    } catch (e) {}

    // ── SIGNAL FRESHNESS CHECK ──
    // Only check during RTH on trading days (uses trading calendar above)
    if (isRTH()) {
      const today = getETNow().toISOString().split('T')[0];
      const signalDir = path.dirname(PAPER_STATE_PATH);
      const signalFile = path.join(signalDir, `Card1_${today}_signals.jsonl`);
      try {
        if (fs.existsSync(signalFile)) {
          const sigStats = fs.statSync(signalFile);
          const sigAge = Date.now() - sigStats.mtimeMs;
          if (sigAge > 120000) { // 2 min stale during RTH
            const sigAgeMin = Math.round(sigAge / 60000);
            const alertKey = 'signal_stale_alert';
            const lastAlert = alertState[alertKey] || 0;
            if (Date.now() - lastAlert >= 300000) { // alert every 5 min
              db.sendAlert('critical', 'inference_watchdog',
                `Signal pipeline STALE for ${sigAgeMin} min during RTH! ` +
                `${signalFile} last modified ${sigAgeMin} min ago. ` +
                `Inference may have crashed. RESTART paper engine immediately.`);
              sendDiscordAlert('critical', 'INFERENCE PIPELINE DOWN',
                `Signal files haven't been updated in ${sigAgeMin} minutes during RTH. ` +
                `The prediction pipeline may have crashed while the MBO receiver is still running. ` +
                `Restart the paper engine immediately.`,
                [
                  { name: 'Signal File', value: `Card1_${today}_signals.jsonl`, inline: true },
                  { name: 'Stale For', value: `${sigAgeMin} min`, inline: true },
                ]
              );
              alertState[alertKey] = Date.now();
              log('CRITICAL', `Signal pipeline stale for ${sigAgeMin} min during RTH!`);
            }
          }
        } else {
          // No signal file for today at all during RTH — CRITICAL
          const alertKey = 'signal_missing_alert';
          const lastAlert = alertState[alertKey] || 0;
          if (Date.now() - lastAlert >= 600000) { // alert every 10 min
            db.sendAlert('critical', 'inference_watchdog',
              `NO signal file exists for ${today} during RTH! ` +
              `Inference pipeline is NOT running. RESTART paper engine.`);
            sendDiscordAlert('critical', 'NO SIGNALS TODAY',
              `No signal file (Card1_${today}_signals.jsonl) exists during market hours. ` +
              `The inference pipeline is completely dead.`
            );
            alertState[alertKey] = Date.now();
            log('CRITICAL', `No signal file for ${today} during RTH!`);
          }
        }
      } catch (e) {
        log('WARN', `Signal freshness check failed: ${e.message}`);
      }
    }
  }

  paperWasRunning = isRunning;
}

// ========================
// PNL SNAPSHOT LOOP
// ========================

let lastEodSummarizeDate = null;

function takePnlSnapshots() {
  if (!fs.existsSync(PAPER_STATE_PATH)) return;
  try {
    const raw = fs.readFileSync(PAPER_STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    const now = new Date().toISOString();
    const cards = state.cards || state;
    for (const [cardName, cardState] of Object.entries(cards)) {
      if (!cardName.startsWith('Card') && !cardName.match(/^[A-Z]/)) continue;
      if (typeof cardState !== 'object' || cardState === null) continue;
      try {
        db.recordPnlSnapshot({
          timestamp: now,
          card_name: cardName,
          cumulative_pnl: cardState.pnl ?? cardState.cumulative_pnl ?? cardState.realized_pnl ?? null,
          trades_today: cardState.trades ?? cardState.trades_today ?? cardState.total_trades ?? null,
          position: cardState.position ?? cardState.pos ?? 0,
          unrealized_pnl: cardState.unrealized_pnl ?? cardState.unrealized ?? null,
          zscore: cardState.zscore ?? cardState.z_score ?? cardState.last_zscore ?? null,
          conviction: cardState.conviction ?? cardState.last_conviction ?? null,
          vol_percentile: cardState.vol_percentile ?? cardState.vol_pctile ?? null,
        });
      } catch (e) {
        log('WARN', `Failed to record PnL snapshot for ${cardName}: ${e.message}`);
      }
    }
    log('DEBUG', `PnL snapshots recorded for ${Object.keys(cards).length} cards`);
  } catch (e) {
    log('WARN', `PnL snapshot failed: ${e.message}`);
  }
}

function checkEndOfDay() {
  const now = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMinute = now.getUTCMinutes();
  const todayDate = getETDateString(now);
  if (etHour === 16 && etMinute >= 1 && etMinute <= 5 && lastEodSummarizeDate !== todayDate) {
    lastEodSummarizeDate = todayDate;
    log('INFO', `End of day: summarizing PnL for ${todayDate}`);
    try {
      const results = db.summarizeDay(todayDate);
      if (results.length > 0) {
        const totalPnl = results.reduce((sum, r) => sum + (r.net_pnl || 0), 0);
        const totalTrades = results.reduce((sum, r) => sum + (r.trades || 0), 0);
        const cardLines = results.map(r =>
          `${r.card_name}: $${(r.net_pnl || 0).toFixed(2)} (${r.trades} trades, DD $${(r.max_drawdown || 0).toFixed(2)})`
        ).join('\n');
        sendDiscordAlert('info', `EOD PnL Summary - ${todayDate}`,
          `**Total: $${totalPnl.toFixed(2)}** | ${totalTrades} trades\n\n${cardLines}`
        );
        log('INFO', `EOD summary: $${totalPnl.toFixed(2)} across ${results.length} cards`);
      }
    } catch (e) {
      log('ERROR', `EOD summarize failed: ${e.message}`);
    }
  }
}

function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function getETDateString(date) {
  const etOffset = isDST(date) ? -4 : -5;
  const etTime = new Date(date.getTime() + etOffset * 3600000);
  return etTime.toISOString().split('T')[0];
}

// ========================
// GRACEFUL SHUTDOWN
// ========================

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `Shutting down on ${signal}...`);

  // Stop monitoring
  for (const iv of intervals) clearInterval(iv);

  // Kill active log streams
  destroyAllStreams();

  // Kill Streamlit
  if (streamlitProcess && !streamlitProcess.killed) {
    try { streamlitProcess.kill(); } catch (e) {}
  }

  // Destroy SSH pool
  if (sshPool) {
    try { sshPool.destroy(); } catch (e) {}
  }

  // Close database
  if (db) {
    try { db.close(); } catch (e) {}
  }

  // Close HTTP server
  if (httpServer) {
    httpServer.close(() => {
      log('INFO', 'HTTP server closed');
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log('ERROR', `Uncaught exception: ${e.message}`, { stack: e.stack });
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});

// ========================
// ENTRY POINT
// ========================

initialize();
