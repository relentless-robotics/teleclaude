#!/usr/bin/env node
/**
 * Quant Dashboard — Express Backend
 *
 * Single-file backend serving the dashboard UI and proxying data from:
 *   - Ray cluster API (192.168.0.108:8265)
 *   - MLflow REST API (localhost:5000)
 *   - QCC SQLite database (data/qcc.db)
 *   - Trading agent JSON files (trading_agents/data/)
 *   - Paper trading engine state (Lvl3Quant/live_trading/logs/paper/)
 *
 * Serves on port 8501.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.DASHBOARD_PORT || '8502', 10);
const RAY_HOST = '192.168.0.108';
const RAY_PORT = 8265;
const MLFLOW_HOST = 'localhost';
const MLFLOW_PORT = 5000;
const QCC_PORT = 3456;

const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'qcc.db');
const TRADING_DATA_DIR = path.join(BASE_DIR, 'trading_agents', 'data');

const PAPER_STATE_PATH = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\live_trading\\logs\\paper\\live_state.json';
const PAPER_TRADES_DIR = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\live_trading\\logs\\paper';

const NODE_FLASK = {
  neptune: { host: 'localhost', port: 5050 },
  uranus: { host: '100.100.83.37', port: 5050 },
  razer: { host: '100.102.215.75', port: 5050 },
  jupiter: { host: '192.168.0.108', port: 5050 },
  saturn: { host: '100.101.101.9', port: 5050 },
};

// ── Database ────────────────────────────────────────────────────────────────

let db = null;

function initDB() {
  try {
    const Database = require('better-sqlite3');
    if (fs.existsSync(DB_PATH)) {
      db = new Database(DB_PATH, { readonly: true });
      db.pragma('journal_mode = WAL');
      console.log(`[DB] Connected to ${DB_PATH}`);
    } else {
      console.log(`[DB] Database not found at ${DB_PATH} — QCC queries will return empty`);
    }
  } catch (e) {
    console.log(`[DB] Failed to load better-sqlite3: ${e.message} — QCC queries will return empty`);
  }
}

function dbAll(sql, params = []) {
  if (!db) return [];
  try { return db.prepare(sql).all(...params); } catch (e) { return []; }
}

function dbGet(sql, params = []) {
  if (!db) return null;
  try { return db.prepare(sql).get(...params); } catch (e) { return null; }
}

// ── HTTP Proxy Helpers ──────────────────────────────────────────────────────

function httpGet(host, port, urlPath, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: host, port, path: urlPath, method: 'GET',
      headers: { 'Accept': 'application/json' }, timeout }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(raw); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(host, port, urlPath, payload, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: host, port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' }, timeout }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(raw); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Read JSON file safely ───────────────────────────────────────────────────

function readJsonFile(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { return null; }
}

function readJsonLines(filepath, limit = 200) {
  try {
    if (!fs.existsSync(filepath)) return [];
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ── API Route Handlers ──────────────────────────────────────────────────────

async function apiCluster() {
  const result = { nodes: {}, ray: null, qcc: null, timestamp: new Date().toISOString() };

  // Ray cluster status
  try {
    result.ray = await httpGet(RAY_HOST, RAY_PORT, '/api/cluster_status', 6000);
  } catch (e) {
    result.ray = { error: e.message, endpoint: `${RAY_HOST}:${RAY_PORT}` };
  }

  // Ray nodes
  try {
    const nodes = await httpGet(RAY_HOST, RAY_PORT, '/nodes?view=summary', 6000);
    result.rayNodes = nodes;
  } catch (e) {
    result.rayNodes = { error: e.message };
  }

  // QCC node status from database
  const dbNodes = dbAll('SELECT * FROM compute_nodes ORDER BY name');
  for (const n of dbNodes) {
    result.nodes[n.name] = {
      host: n.host,
      tailscale_ip: n.tailscale_ip,
      gpu: n.gpu,
      gpu_vram_gb: n.gpu_vram_gb,
      ram_gb: n.ram_gb,
      status: n.status,
      last_heartbeat: n.last_heartbeat,
      last_gpu_util: n.last_gpu_util,
      last_gpu_mem_mb: n.last_gpu_mem_mb,
      last_ram_pct: n.last_ram_pct,
    };
  }

  // If no DB nodes, provide static fallback
  if (dbNodes.length === 0) {
    const staticNodes = {
      neptune: { host: 'localhost', gpu: 'RTX 3090', gpu_vram_gb: 24, ram_gb: 64, status: 'unknown' },
      uranus: { host: '100.100.83.37', gpu: 'RTX 5090', gpu_vram_gb: 32, ram_gb: 64, status: 'unknown' },
      razer: { host: '100.102.215.75', gpu: 'RTX 3070', gpu_vram_gb: 8, ram_gb: 32, status: 'unknown' },
      jupiter: { host: '192.168.0.108', gpu: 'None (CPU)', gpu_vram_gb: 0, ram_gb: 64, status: 'unknown' },
      saturn: { host: '100.101.101.9', gpu: 'None (CPU)', gpu_vram_gb: 0, ram_gb: 32, status: 'unknown' },
    };
    result.nodes = staticNodes;
  }

  // Flask API health checks per node (parallel)
  const flaskChecks = Object.entries(NODE_FLASK).map(async ([name, cfg]) => {
    try {
      const health = await httpGet(cfg.host, cfg.port, '/health', 4000);
      if (result.nodes[name]) result.nodes[name].flask = { status: 'up', data: health };
    } catch (e) {
      if (result.nodes[name]) result.nodes[name].flask = { status: 'unreachable', error: e.message };
    }
  });
  await Promise.all(flaskChecks);

  // QCC daemon health
  try {
    result.qcc = await httpGet('localhost', QCC_PORT, '/api/health', 4000);
  } catch (e) {
    result.qcc = { error: e.message, endpoint: `localhost:${QCC_PORT}` };
  }

  return result;
}

async function apiTraining() {
  const result = { jobs: [], queue: {}, models: [] };

  // Active training jobs
  result.jobs = dbAll(`
    SELECT tj.*, m.name as model_name, m.architecture
    FROM training_jobs tj
    LEFT JOIN models m ON tj.model_id = m.id
    ORDER BY tj.started_at DESC
    LIMIT 50
  `);

  // Job queue depth per node
  const queueRows = dbAll(`
    SELECT node_name, status, COUNT(*) as count
    FROM job_queue
    GROUP BY node_name, status
    ORDER BY node_name
  `);
  for (const r of queueRows) {
    if (!result.queue[r.node_name]) result.queue[r.node_name] = {};
    result.queue[r.node_name][r.status] = r.count;
  }

  // Models summary
  result.models = dbAll(`
    SELECT id, name, architecture, status, total_folds, completed_folds,
           mean_ic, best_ic, latest_ic, node, updated_at
    FROM models
    ORDER BY updated_at DESC
    LIMIT 30
  `);

  return result;
}

async function apiMlflow() {
  const result = { experiments: [], recentRuns: [], error: null };

  try {
    const expRes = await httpPost(MLFLOW_HOST, MLFLOW_PORT,
      '/api/2.0/mlflow/experiments/search',
      { max_results: 100, view_type: 'ACTIVE_ONLY' }, 10000);
    result.experiments = (expRes.experiments || []).map(e => ({
      id: e.experiment_id,
      name: e.name,
      lifecycle_stage: e.lifecycle_stage,
      last_update_time: e.last_update_time,
    }));

    // Get runs from each experiment (last 5 per experiment, up to 3 experiments)
    const topExps = result.experiments.slice(0, 5);
    for (const exp of topExps) {
      try {
        const runsRes = await httpPost(MLFLOW_HOST, MLFLOW_PORT,
          '/api/2.0/mlflow/runs/search',
          { experiment_ids: [exp.id], max_results: 10, run_view_type: 'ACTIVE_ONLY',
            order_by: ['attribute.start_time DESC'] }, 8000);
        const runs = (runsRes.runs || []).map(r => ({
          run_id: r.info?.run_id,
          experiment_name: exp.name,
          experiment_id: exp.id,
          status: r.info?.status,
          start_time: r.info?.start_time,
          end_time: r.info?.end_time,
          metrics: r.data?.metrics || {},
          params: r.data?.params || {},
        }));
        result.recentRuns.push(...runs);
      } catch (_) {}
    }

    // Sort all runs by start time
    result.recentRuns.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
    result.recentRuns = result.recentRuns.slice(0, 50);
  } catch (e) {
    result.error = e.message;
    result.endpoint = `${MLFLOW_HOST}:${MLFLOW_PORT}`;
  }

  return result;
}

async function apiPaper() {
  const result = { engine: null, trades: [], cards: [], pnl: {}, error: null };

  // Paper engine state
  result.engine = readJsonFile(PAPER_STATE_PATH);
  if (!result.engine) {
    result.error = `Paper state not found at ${PAPER_STATE_PATH}`;
  }

  // QCC PnL data
  result.pnlSnapshots = dbAll(`
    SELECT card_name, position, cumulative_pnl, unrealized_pnl, zscore, conviction, timestamp
    FROM pnl_snapshots
    WHERE timestamp > datetime('now', '-1 day')
    ORDER BY timestamp DESC
    LIMIT 500
  `);

  result.dailyPnl = dbAll(`
    SELECT card_name, date, trades, gross_pnl, net_pnl, commission,
           win_count, loss_count, avg_win, avg_loss, max_drawdown, sharpe_daily, fill_rate, notes
    FROM daily_pnl
    ORDER BY date DESC
    LIMIT 100
  `);

  // Cards from DB
  result.cards = dbAll('SELECT * FROM cards ORDER BY name');

  // Card profiles (latest per card)
  result.cardProfiles = dbAll(`
    SELECT cp.*
    FROM card_performance_profiles cp
    INNER JOIN (
      SELECT card_name, MAX(profile_date) as max_date
      FROM card_performance_profiles
      GROUP BY card_name
    ) latest ON cp.card_name = latest.card_name AND cp.profile_date = latest.max_date
    ORDER BY cp.card_name
  `);

  // Trade history from QCC DB
  result.dbTrades = dbAll(`
    SELECT * FROM trade_history
    ORDER BY entry_time DESC
    LIMIT 100
  `);

  // Trade history from JSONL
  result.trades = readJsonLines(path.join(TRADING_DATA_DIR, 'intraday_executions.jsonl'), 100);
  result.esTrades = readJsonLines(path.join(TRADING_DATA_DIR, 'es_micro_trades.jsonl'), 100);

  // Compute per-card aggregate stats (Sortino, trades/day)
  const cardStatsMap = {};
  for (const d of result.dailyPnl) {
    const cn = d.card_name || 'unknown';
    if (!cardStatsMap[cn]) cardStatsMap[cn] = { pnls: [], tradingDays: 0, totalTrades: 0 };
    cardStatsMap[cn].pnls.push(d.net_pnl || 0);
    if ((d.trades || 0) > 0) cardStatsMap[cn].tradingDays++;
    cardStatsMap[cn].totalTrades += (d.trades || 0);
  }
  result.cardStats = {};
  for (const [cn, s] of Object.entries(cardStatsMap)) {
    result.cardStats[cn] = {
      sortino: calcSortino(s.pnls),
      sharpe: calcSharpe(s.pnls),
      tradesPerDay: s.tradingDays > 0 ? s.totalTrades / s.tradingDays : 0,
      tradingDays: s.tradingDays,
      totalTrades: s.totalTrades,
    };
  }

  // Overall Sortino
  const allDailyPnls = result.dailyPnl.map(d => d.net_pnl || 0);
  result.overallSortino = calcSortino(allDailyPnls);
  const allTradingDays = result.dailyPnl.filter(d => (d.trades || 0) > 0).length;
  const allTotalTrades = result.dailyPnl.reduce((s, d) => s + (d.trades || 0), 0);
  result.overallTradesPerDay = allTradingDays > 0 ? allTotalTrades / allTradingDays : 0;

  return result;
}

// ── Sortino / Sharpe / Stats Helpers ────────────────────────────────────

function calcSortino(dailyPnls, targetReturn = 0) {
  if (!dailyPnls || dailyPnls.length < 2) return null;
  const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
  const downsideSquares = dailyPnls
    .filter(v => v < targetReturn)
    .map(v => (v - targetReturn) ** 2);
  if (downsideSquares.length === 0) return mean > 0 ? 99.99 : 0; // no downside
  const downsideDev = Math.sqrt(downsideSquares.reduce((s, v) => s + v, 0) / dailyPnls.length);
  if (downsideDev === 0) return 0;
  return (mean - targetReturn) / downsideDev * Math.sqrt(252);
}

function calcSharpe(dailyPnls) {
  if (!dailyPnls || dailyPnls.length < 2) return null;
  const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
  const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

function calcMaxDrawdown(dailyPnls) {
  if (!dailyPnls || dailyPnls.length === 0) return { maxDD: 0, maxDDDuration: 0 };
  let cumPnl = 0, peak = 0, maxDD = 0, maxDDDuration = 0;
  let ddStart = 0, inDD = false;
  for (let i = 0; i < dailyPnls.length; i++) {
    cumPnl += dailyPnls[i];
    if (cumPnl > peak) {
      peak = cumPnl;
      if (inDD) {
        maxDDDuration = Math.max(maxDDDuration, i - ddStart);
        inDD = false;
      }
    } else {
      if (!inDD) { ddStart = i; inDD = true; }
      maxDD = Math.min(maxDD, cumPnl - peak);
    }
  }
  if (inDD) maxDDDuration = Math.max(maxDDDuration, dailyPnls.length - ddStart);
  return { maxDD, maxDDDuration };
}

// ── Detailed Card Endpoint ─────────────────────────────────────────────

async function apiPaperCard(cardName) {
  const result = { card: null, dailyPnl: [], trades: [], profile: null,
    stats: {}, ootResults: null, monteCarlo: null, equityCurve: [], error: null };

  // Card config from DB
  result.card = dbGet('SELECT * FROM cards WHERE name = ?', [cardName]);
  if (!result.card) {
    result.error = `Card "${cardName}" not found`;
    return result;
  }

  // Daily PnL for this card
  result.dailyPnl = dbAll(`
    SELECT date, trades, gross_pnl, net_pnl, commission,
           win_count, loss_count, avg_win, avg_loss, max_drawdown, sharpe_daily, fill_rate, notes
    FROM daily_pnl
    WHERE card_name = ?
    ORDER BY date ASC
  `, [cardName]);

  // Card performance profile (latest)
  result.profile = dbGet(`
    SELECT * FROM card_performance_profiles
    WHERE card_name = ?
    ORDER BY profile_date DESC
    LIMIT 1
  `, [cardName]);

  // Trade history from QCC DB for this card
  result.trades = dbAll(`
    SELECT * FROM trade_history
    WHERE card_name = ?
    ORDER BY entry_time DESC, session_date DESC, created_at DESC
    LIMIT 500
  `, [cardName]);

  // Also load trades from paper engine JSONL files
  const paperTradesDir = PAPER_TRADES_DIR;
  try {
    if (fs.existsSync(paperTradesDir)) {
      const files = fs.readdirSync(paperTradesDir)
        .filter(f => f.startsWith(cardName + '_') && f.endsWith('_trades.jsonl'))
        .sort();
      for (const file of files) {
        const lines = readJsonLines(path.join(paperTradesDir, file), 200);
        for (const line of lines) {
          result.trades.push({
            card_name: line.card || cardName,
            session_date: line.ts ? line.ts.split('T')[0] : null,
            side: line.side,
            entry_price: line.entry_price,
            exit_price: line.exit_price,
            entry_time: line.ts,
            exit_time: null,
            pnl_dollars: line.pnl_dollars,
            pnl_ticks: line.pnl_ticks || null,
            hold_sec: line.hold_time_ms ? line.hold_time_ms / 1000 : null,
            mae_ticks: line.mae_ticks || null,
            mfe_ticks: line.mfe_ticks || null,
            exit_reason: line.exit_reason,
            entry_zscore: line.entry_zscore || null,
            conviction: line.conviction || null,
            vol_percentile: line.vol_percentile || null,
            signal_strength: line.signalStrength || line.signal_strength || null,
            source: 'jsonl',
          });
        }
      }
    }
  } catch (e) { /* ignore file errors */ }

  // Sort trades by time descending
  result.trades.sort((a, b) => {
    const ta = a.entry_time || a.session_date || '';
    const tb = b.entry_time || b.session_date || '';
    return String(tb).localeCompare(String(ta));
  });

  // Calculate stats
  const dailyPnls = result.dailyPnl.map(d => d.net_pnl || 0);
  const tradingDays = result.dailyPnl.filter(d => (d.trades || 0) > 0).length;
  const totalTrades = result.dailyPnl.reduce((s, d) => s + (d.trades || 0), 0);
  const totalWins = result.dailyPnl.reduce((s, d) => s + (d.win_count || 0), 0);
  const totalLosses = result.dailyPnl.reduce((s, d) => s + (d.loss_count || 0), 0);
  const totalPnl = dailyPnls.reduce((s, v) => s + v, 0);
  const avgWin = result.dailyPnl.reduce((s, d) => s + (d.avg_win || 0), 0) / (result.dailyPnl.filter(d => d.avg_win).length || 1);
  const avgLoss = result.dailyPnl.reduce((s, d) => s + (d.avg_loss || 0), 0) / (result.dailyPnl.filter(d => d.avg_loss).length || 1);
  const { maxDD, maxDDDuration } = calcMaxDrawdown(dailyPnls);

  result.stats = {
    totalPnl,
    sortino: calcSortino(dailyPnls),
    sharpe: calcSharpe(dailyPnls),
    winRate: (totalWins + totalLosses) > 0 ? totalWins / (totalWins + totalLosses) : null,
    avgWin,
    avgLoss,
    wlr: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null,
    tradesPerDay: tradingDays > 0 ? totalTrades / tradingDays : 0,
    totalTrades,
    tradingDays,
    maxDrawdown: maxDD,
    maxDrawdownDuration: maxDDDuration,
    convictionThreshold: result.card.conviction_threshold,
    tpTicks: result.card.tp_ticks,
    slTicks: result.card.sl_ticks,
  };

  // Equity curve (cumulative PnL per day)
  let cumPnl = 0;
  result.equityCurve = result.dailyPnl.map(d => {
    cumPnl += (d.net_pnl || 0);
    return { date: d.date, cumPnl, dailyPnl: d.net_pnl || 0 };
  });

  // OOT results from card_performance_profiles
  if (result.profile) {
    result.ootResults = {
      ootStart: result.profile.oot_start,
      ootEnd: result.profile.oot_end,
      nDays: result.profile.n_days,
      sharpe: result.profile.sharpe,
      winRate: result.profile.win_rate,
      totalPnl: result.profile.total_pnl,
      positiveDayPct: result.profile.positive_day_pct,
      maxDrawdown: result.profile.max_drawdown,
      edgeDecay: result.profile.edge_decay_json ? JSON.parse(result.profile.edge_decay_json || '{}') : null,
    };
  }

  // Monte Carlo from experiment_results or strategy_results
  const mcResult = dbGet(`
    SELECT mc_p5_sortino, mc_prob_profit, config_json, sortino, sharpe, win_rate, total_pnl, max_dd
    FROM experiment_results
    WHERE experiment_name LIKE ? AND mc_p5_sortino IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `, [`%${cardName}%`]);
  if (mcResult) {
    result.monteCarlo = {
      medianSortino: mcResult.sortino,
      p5Sortino: mcResult.mc_p5_sortino,
      p95Sortino: null,
      probProfit: mcResult.mc_prob_profit,
      maxDD: mcResult.max_dd,
    };
  }

  // Also check strategy_results
  if (!result.monteCarlo) {
    const srResult = dbGet(`
      SELECT sortino, sharpe, win_rate, total_pnl, max_drawdown_pct, monte_carlo_passed
      FROM strategy_results
      WHERE strategy_name LIKE ?
      ORDER BY created_at DESC LIMIT 1
    `, [`%${cardName}%`]);
    if (srResult && srResult.monte_carlo_passed != null) {
      result.monteCarlo = {
        medianSortino: srResult.sortino,
        p5Sortino: null,
        p95Sortino: null,
        probProfit: srResult.monte_carlo_passed ? 1 : 0,
        maxDD: srResult.max_drawdown_pct,
      };
    }
  }

  return result;
}

async function apiResearch() {
  const result = { projects: [], experiments: [], sweeps: [] };

  result.projects = dbAll(`
    SELECT * FROM research_projects
    WHERE status IN ('proposed', 'active', 'blocked')
    ORDER BY priority ASC, updated_at DESC
    LIMIT 30
  `);

  result.experiments = dbAll(`
    SELECT * FROM research_experiments
    ORDER BY created_at DESC
    LIMIT 30
  `);

  result.sweeps = dbAll(`
    SELECT * FROM sweeps
    ORDER BY started_at DESC
    LIMIT 20
  `);

  return result;
}

async function apiHealth() {
  const result = { alerts: [], rayJobs: [], agents: null, timestamp: new Date().toISOString() };

  // Unresolved alerts
  result.alerts = dbAll(`
    SELECT * FROM alerts
    WHERE resolved = 0
    ORDER BY created_at DESC
    LIMIT 50
  `);

  // Recent resolved alerts
  result.recentAlerts = dbAll(`
    SELECT * FROM alerts
    ORDER BY created_at DESC
    LIMIT 30
  `);

  // Ray jobs
  try {
    const res = await httpGet(RAY_HOST, RAY_PORT, '/api/jobs/', 6000);
    const jobs = Array.isArray(res) ? res : (res?.jobs || []);
    result.rayJobs = (Array.isArray(jobs) ? jobs : [])
      .sort((a, b) => (b.start_time || 0) - (a.start_time || 0))
      .slice(0, 30);
  } catch (e) {
    result.rayJobs = { error: e.message };
  }

  // Agent state
  result.agents = readJsonFile(path.join(TRADING_DATA_DIR, 'agent_state.json'));

  // Node history (last 24h)
  result.nodeHistory = dbAll(`
    SELECT node_name, status, gpu_util, gpu_mem_mb, gpu_temp, ram_pct, timestamp
    FROM node_state_history
    WHERE timestamp > datetime('now', '-24 hours')
    ORDER BY timestamp DESC
    LIMIT 500
  `);

  return result;
}

async function apiRayJobs() {
  try {
    const res = await httpGet(RAY_HOST, RAY_PORT, '/api/jobs/', 8000);
    const jobs = Array.isArray(res) ? res : (res?.jobs || []);
    return { jobs: (Array.isArray(jobs) ? jobs : []).sort((a, b) => (b.start_time || 0) - (a.start_time || 0)).slice(0, 50) };
  } catch (e) {
    return { error: e.message, endpoint: `${RAY_HOST}:${RAY_PORT}` };
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

function sendJSON(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHTML(res, filepath) {
  fs.readFile(filepath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  });
}

function sendStatic(res, filepath) {
  const ext = path.extname(filepath);
  const mimeTypes = {
    '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  };
  fs.readFile(filepath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  try {
    // API routes
    if (pathname === '/api/cluster') return sendJSON(res, await apiCluster());
    if (pathname === '/api/training') return sendJSON(res, await apiTraining());
    if (pathname === '/api/mlflow') return sendJSON(res, await apiMlflow());
    if (pathname === '/api/paper') return sendJSON(res, await apiPaper());
    // /api/paper/card/:cardName
    if (pathname.startsWith('/api/paper/card/')) {
      const cardName = decodeURIComponent(pathname.replace('/api/paper/card/', ''));
      return sendJSON(res, await apiPaperCard(cardName));
    }
    if (pathname === '/api/research') return sendJSON(res, await apiResearch());
    if (pathname === '/api/health') return sendJSON(res, await apiHealth());
    if (pathname === '/api/ray/jobs') return sendJSON(res, await apiRayJobs());

    // Static files
    if (pathname === '/' || pathname === '/index.html') {
      return sendHTML(res, path.join(__dirname, 'index.html'));
    }

    // Serve any file in this directory (css, js, etc)
    const safePath = path.join(__dirname, pathname.replace(/\.\./g, ''));
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      return sendStatic(res, safePath);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error(`[ERROR] ${pathname}: ${e.message}`);
    sendJSON(res, { error: e.message });
  }
});

initDB();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Kill the existing process or change PORT.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  Quant Dashboard running at http://localhost:${PORT}\n`);
  console.log(`  Data sources:`);
  console.log(`    Ray cluster:   ${RAY_HOST}:${RAY_PORT}`);
  console.log(`    MLflow:        ${MLFLOW_HOST}:${MLFLOW_PORT}`);
  console.log(`    QCC DB:        ${DB_PATH} (${db ? 'connected' : 'not found'})`);
  console.log(`    Paper state:   ${PAPER_STATE_PATH}`);
  console.log(`    Trading data:  ${TRADING_DATA_DIR}\n`);
});
