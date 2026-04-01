#!/usr/bin/env node
/**
 * db_organizer.js — QCC Database Result Organizer
 *
 * Scans all compute nodes for research results scattered across log files,
 * JSONs, and CSVs. Parses key metrics and inserts into QCC SQLite tables:
 *   - experiment_results: unified view of all ML/quant experiments
 *   - sweep_configs: parameter sweep configurations
 *   - strategy_results: (existing table, augmented)
 *
 * Tags each result with: node, timestamp, leakage_status, researcher.
 * Deduplicates by (experiment_name, node, log_path) composite key.
 *
 * Usage:
 *   node compute/db_organizer.js                  — full scan, all nodes
 *   node compute/db_organizer.js --node neptune   — scan single node
 *   node compute/db_organizer.js --dry-run        — parse but don't insert
 *   node compute/db_organizer.js --since 2026-03-20 — only results after date
 *
 * Programmatic:
 *   const { scanAndIndex, scanNode } = require('./compute/db_organizer');
 *   const report = await scanAndIndex();
 *   const report = await scanNode('neptune');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------------------
// Paths & Config
// ---------------------------------------------------------------------------

const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const DB_PATH = path.join(DATA_DIR, 'qcc.db');
const LOG_FILE = path.join(LOGS_DIR, `db-organizer-${new Date().toISOString().split('T')[0]}.log`);
const QCC_BASE = 'http://localhost:3456';

// Ensure dirs
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [DB-ORG] [${level}] ${message}`;
  if (data) {
    try { entry += ` | ${JSON.stringify(data)}`; } catch (e) { entry += ' | [unserializable]'; }
  }
  entry += '\n';
  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (e) {}
  if (level === 'ERROR') {
    process.stderr.write(entry);
  } else {
    process.stdout.write(entry);
  }
}

// ---------------------------------------------------------------------------
// Database Setup — creates experiment_results table via migration
// ---------------------------------------------------------------------------

let db = null;

function initDatabase() {
  const { QCCDatabase } = require('../lib/qcc-database');
  db = new QCCDatabase(DB_PATH);

  // Create experiment_results table (the new unified results index)
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS experiment_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_name TEXT NOT NULL,
      node TEXT,
      researcher TEXT,
      model_type TEXT,
      ic REAL,
      sortino REAL,
      sharpe REAL,
      win_rate REAL,
      total_pnl REAL,
      n_trades INTEGER,
      n_days INTEGER,
      max_dd REAL,
      leakage_status TEXT DEFAULT 'PENDING',
      mc_p5_sortino REAL,
      mc_prob_profit REAL,
      config_json TEXT,
      log_path TEXT,
      source_type TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      notes TEXT,
      UNIQUE(experiment_name, node, log_path)
    );

    CREATE TABLE IF NOT EXISTS sweep_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sweep_name TEXT NOT NULL,
      node TEXT,
      sweep_type TEXT,
      param_grid_json TEXT,
      best_config_json TEXT,
      best_metric_name TEXT,
      best_metric_value REAL,
      total_configs INTEGER,
      completed_configs INTEGER,
      source_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(sweep_name, node, source_path)
    );

    CREATE INDEX IF NOT EXISTS idx_expr_name ON experiment_results(experiment_name);
    CREATE INDEX IF NOT EXISTS idx_expr_node ON experiment_results(node);
    CREATE INDEX IF NOT EXISTS idx_expr_researcher ON experiment_results(researcher);
    CREATE INDEX IF NOT EXISTS idx_expr_model_type ON experiment_results(model_type);
    CREATE INDEX IF NOT EXISTS idx_expr_ic ON experiment_results(ic);
    CREATE INDEX IF NOT EXISTS idx_expr_sortino ON experiment_results(sortino);
    CREATE INDEX IF NOT EXISTS idx_expr_sharpe ON experiment_results(sharpe);
    CREATE INDEX IF NOT EXISTS idx_expr_created ON experiment_results(created_at);
    CREATE INDEX IF NOT EXISTS idx_expr_leakage ON experiment_results(leakage_status);

    CREATE INDEX IF NOT EXISTS idx_sweep_cfg_name ON sweep_configs(sweep_name);
    CREATE INDEX IF NOT EXISTS idx_sweep_cfg_node ON sweep_configs(node);
  `);

  log('INFO', `Database initialized at ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Node Configuration
// ---------------------------------------------------------------------------

const NODE_CONFIGS = {
  neptune: {
    host: 'localhost',
    lvl3_root: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    isLocal: true,
    scan_paths: [
      // Training logs
      { pattern: 'training/logs/**/*.log', type: 'training_log' },
      { pattern: 'training/logs/**/*.json', type: 'training_result' },
      // Sweep outputs
      { pattern: 'sweeps/**/*.json', type: 'sweep_result' },
      { pattern: 'sweeps/**/*.csv', type: 'sweep_csv' },
      // Research results
      { pattern: 'research/**/*.json', type: 'research_result' },
      { pattern: 'research/**/*.log', type: 'research_log' },
      // Fill sim
      { pattern: 'live_trading/logs/fillsim/**/*.json', type: 'fillsim_result' },
      // Paper trading
      { pattern: 'live_trading/logs/paper/**/*.json', type: 'paper_result' },
    ]
  },
  uranus: {
    host: '100.100.83.37',
    lvl3_root: 'C:\\Users\\nick\\Lvl3Quant',
    isLocal: false,
    scan_paths: [
      { pattern: 'training/logs/**/*.log', type: 'training_log' },
      { pattern: 'training/logs/**/*.json', type: 'training_result' },
      { pattern: 'sweeps/**/*.json', type: 'sweep_result' },
      { pattern: 'research/**/*.json', type: 'research_result' },
    ]
  },
  razer: {
    host: '100.102.215.75',
    lvl3_root: 'C:\\Users\\claude\\Lvl3Quant',
    isLocal: false,
    scan_paths: [
      { pattern: 'research/**/*.json', type: 'research_result' },
      { pattern: 'research/**/*.log', type: 'research_log' },
      { pattern: 'sweeps/**/*.json', type: 'sweep_result' },
    ]
  },
  jupiter: {
    host: '100.102.174.30',
    lvl3_root: '/home/jupiter/Lvl3Quant',
    isLocal: false,
    scan_paths: [
      { pattern: 'research/**/*.json', type: 'research_result' },
      { pattern: 'fillsim/**/*.json', type: 'fillsim_result' },
    ]
  },
  saturn: {
    host: '100.101.101.9',
    lvl3_root: '/home/saturn/Lvl3Quant',
    isLocal: false,
    scan_paths: [
      { pattern: 'research/**/*.json', type: 'research_result' },
    ]
  }
};

// ---------------------------------------------------------------------------
// QCC SSH Exec Helper — uses QCC daemon's SSH pool
// ---------------------------------------------------------------------------

function qccApiCall(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, QCC_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Execute a command on a remote node via QCC daemon SSH pool.
 */
async function sshExec(node, command) {
  try {
    const result = await qccApiCall(`/api/ssh/exec`, 'POST', { node, command });
    return result.stdout || result.output || '';
  } catch (e) {
    log('WARN', `SSH exec failed on ${node}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local File Scanner
// ---------------------------------------------------------------------------

/**
 * Recursively find files matching a glob-like pattern under basePath.
 * Simple glob: supports ** (any depth) and * (any file).
 */
function findFiles(basePath, pattern, sinceDate = null) {
  const results = [];
  const parts = pattern.split('/');

  function walk(dir, partIndex) {
    if (partIndex >= parts.length) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return; // dir doesn't exist or no permission
    }

    const part = parts[partIndex];
    const isLast = partIndex === parts.length - 1;

    if (part === '**') {
      // Match any depth — try this level and recurse deeper
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, partIndex);     // stay at ** level
          walk(fullPath, partIndex + 1); // move past **
        } else if (isLast || partIndex + 1 === parts.length - 1) {
          // Check against next part (the filename pattern)
          const filePattern = isLast ? '*' : parts[partIndex + 1];
          if (matchGlob(entry.name, filePattern)) {
            if (sinceDate) {
              try {
                const stat = fs.statSync(fullPath);
                if (stat.mtime >= sinceDate) results.push(fullPath);
              } catch (e) {}
            } else {
              results.push(fullPath);
            }
          }
        }
      }
    } else if (isLast) {
      // File pattern
      for (const entry of entries) {
        if (!entry.isDirectory() && matchGlob(entry.name, part)) {
          const fullPath = path.join(dir, entry.name);
          if (sinceDate) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.mtime >= sinceDate) results.push(fullPath);
            } catch (e) {}
          } else {
            results.push(fullPath);
          }
        }
      }
    } else {
      // Directory pattern
      for (const entry of entries) {
        if (entry.isDirectory() && matchGlob(entry.name, part)) {
          walk(path.join(dir, entry.name), partIndex + 1);
        }
      }
    }
  }

  walk(basePath, 0);
  return results;
}

function matchGlob(name, pattern) {
  if (pattern === '*') return true;
  if (pattern === '**') return true;
  // Convert simple glob to regex: *.json => ^.*\.json$
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
  );
  return regex.test(name);
}

// ---------------------------------------------------------------------------
// Result Parsers
// ---------------------------------------------------------------------------

/**
 * Infer researcher role from file path and content.
 */
function inferResearcher(filePath, content) {
  const lower = filePath.toLowerCase();
  if (lower.includes('cnn') || lower.includes('lstm') || lower.includes('deep') || lower.includes('torch')) return 'ML';
  if (lower.includes('lgbm') || lower.includes('gradient') || lower.includes('boost')) return 'ML';
  if (lower.includes('strategy') || lower.includes('fillsim') || lower.includes('backtest')) return 'QUANT';
  if (lower.includes('sweep') || lower.includes('optuna') || lower.includes('optimization')) return 'QUANT';
  if (lower.includes('sync') || lower.includes('pipeline') || lower.includes('deploy')) return 'INFRA';
  if (content) {
    if (content.ic !== undefined || content.train_loss !== undefined) return 'ML';
    if (content.sharpe !== undefined || content.pnl !== undefined || content.trades !== undefined) return 'QUANT';
  }
  return 'ML'; // default
}

/**
 * Infer model type from file path and content.
 */
function inferModelType(filePath, content) {
  const lower = filePath.toLowerCase();
  if (lower.includes('cnn') || lower.includes('spatial_cnn') || lower.includes('book_spatial')) return 'cnn';
  if (lower.includes('lgbm') || lower.includes('lightgbm') || lower.includes('gradient_boost')) return 'lgbm';
  if (lower.includes('lstm')) return 'lstm';
  if (lower.includes('transformer')) return 'transformer';
  if (lower.includes('math') || lower.includes('wall_bounce') || lower.includes('iceberg')) return 'math';
  if (lower.includes('fillsim') || lower.includes('fill_sim')) return 'fillsim';
  if (content && content.model_type) return content.model_type;
  return 'unknown';
}

/**
 * Detect leakage status from content or file name.
 */
function inferLeakageStatus(filePath, content) {
  if (content) {
    if (content.leakage_status) return content.leakage_status;
    if (content.leakage_check === true || content.leakage_passed === true) return 'PASSED';
    if (content.leakage_check === false || content.leakage_passed === false) return 'FAILED';
    // Expanding window is lower leakage risk
    if (content.window_mode === 'expanding') return 'PASSED';
    if (content.window_mode === 'sliding') return 'PENDING';
  }
  return 'PENDING';
}

/**
 * Parse a JSON result file into experiment_results row.
 */
function parseJSONResult(filePath, nodeName) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    // Skip if it's not a result file (e.g., config-only files)
    if (!data.ic && !data.sharpe && !data.sortino && !data.pnl && !data.total_pnl &&
        !data.mean_ic && !data.results && !data.metrics && !data.summary) {
      return null;
    }

    // Flatten — handle nested result structures
    let metrics = data;
    if (data.results && typeof data.results === 'object') metrics = { ...data, ...data.results };
    if (data.metrics && typeof data.metrics === 'object') metrics = { ...data, ...data.metrics };
    if (data.summary && typeof data.summary === 'object') metrics = { ...data, ...data.summary };

    const experimentName = data.experiment_name || data.name ||
      path.basename(filePath, path.extname(filePath));

    return {
      experiment_name: experimentName,
      node: nodeName,
      researcher: inferResearcher(filePath, metrics),
      model_type: inferModelType(filePath, metrics),
      ic: metrics.ic || metrics.mean_ic || metrics.ic_mean || null,
      sortino: metrics.sortino || metrics.sortino_ratio || null,
      sharpe: metrics.sharpe || metrics.sharpe_ratio || null,
      win_rate: metrics.win_rate || metrics.wr || metrics.winRate || null,
      total_pnl: metrics.total_pnl || metrics.pnl || metrics.net_pnl || null,
      n_trades: metrics.n_trades || metrics.trades || metrics.total_trades || metrics.num_trades || null,
      n_days: metrics.n_days || metrics.days || metrics.data_days || null,
      max_dd: metrics.max_dd || metrics.max_drawdown || metrics.maxDrawdown || null,
      leakage_status: inferLeakageStatus(filePath, metrics),
      mc_p5_sortino: metrics.mc_p5_sortino || metrics.monte_carlo_p5_sortino || null,
      mc_prob_profit: metrics.mc_prob_profit || metrics.monte_carlo_prob_profit || null,
      config_json: data.config ? JSON.stringify(data.config) : (data.config_json || null),
      log_path: filePath,
      source_type: 'json',
      notes: data.notes || null
    };
  } catch (e) {
    log('WARN', `Failed to parse JSON: ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Parse a training log file for IC/loss metrics.
 * Looks for lines like: "Fold 15 | IC: 0.1234 | Train Loss: 0.0567 | Val Loss: 0.0589"
 */
function parseTrainingLog(filePath, nodeName) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Patterns we look for in training logs
    const foldResults = [];
    const icPattern = /(?:IC|ic)[:\s=]+(-?[\d.]+)/;
    const sortPattern = /(?:Sortino|sortino)[:\s=]+(-?[\d.]+)/;
    const sharpePattern = /(?:Sharpe|sharpe)[:\s=]+(-?[\d.]+)/;
    const lossPattern = /(?:val[_ ]loss|val_loss)[:\s=]+([\d.]+)/i;

    let lastIC = null;
    let allICs = [];
    let lastSortino = null;
    let lastSharpe = null;

    for (const line of lines) {
      const icMatch = line.match(icPattern);
      if (icMatch) {
        lastIC = parseFloat(icMatch[1]);
        if (!isNaN(lastIC)) allICs.push(lastIC);
      }
      const sortMatch = line.match(sortPattern);
      if (sortMatch) lastSortino = parseFloat(sortMatch[1]);
      const sharpeMatch = line.match(sharpePattern);
      if (sharpeMatch) lastSharpe = parseFloat(sharpeMatch[1]);
    }

    if (allICs.length === 0 && !lastSortino && !lastSharpe) return null;

    const meanIC = allICs.length > 0 ? allICs.reduce((a, b) => a + b, 0) / allICs.length : null;
    const experimentName = path.basename(path.dirname(filePath)) + '/' + path.basename(filePath, '.log');

    return {
      experiment_name: experimentName,
      node: nodeName,
      researcher: inferResearcher(filePath, null),
      model_type: inferModelType(filePath, null),
      ic: meanIC,
      sortino: lastSortino,
      sharpe: lastSharpe,
      win_rate: null,
      total_pnl: null,
      n_trades: null,
      n_days: null,
      max_dd: null,
      leakage_status: 'PENDING',
      mc_p5_sortino: null,
      mc_prob_profit: null,
      config_json: null,
      log_path: filePath,
      source_type: 'log',
      notes: `Parsed from log, ${allICs.length} fold ICs found`
    };
  } catch (e) {
    log('WARN', `Failed to parse log: ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Parse a CSV sweep output into sweep_configs rows.
 */
function parseSweepCSV(filePath, nodeName) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length < 2) return null;

    const headers = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] ? vals[i].trim() : null; });
      return obj;
    });

    // Find best config by sharpe or sortino or pnl
    let bestMetric = 'sharpe';
    let bestValue = -Infinity;
    let bestConfig = null;

    for (const row of rows) {
      for (const metric of ['sortino', 'sharpe', 'pnl', 'total_pnl']) {
        if (row[metric] !== undefined && row[metric] !== null) {
          const val = parseFloat(row[metric]);
          if (!isNaN(val) && val > bestValue) {
            bestValue = val;
            bestMetric = metric;
            bestConfig = row;
          }
        }
      }
    }

    const sweepName = path.basename(filePath, '.csv');

    return {
      sweep_name: sweepName,
      node: nodeName,
      sweep_type: 'grid',
      param_grid_json: JSON.stringify(headers.filter(h => !['sharpe', 'sortino', 'pnl', 'total_pnl', 'trades', 'win_rate'].includes(h))),
      best_config_json: bestConfig ? JSON.stringify(bestConfig) : null,
      best_metric_name: bestMetric,
      best_metric_value: bestValue !== -Infinity ? bestValue : null,
      total_configs: rows.length,
      completed_configs: rows.length,
      source_path: filePath
    };
  } catch (e) {
    log('WARN', `Failed to parse CSV sweep: ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Parse remote node output — SSH `find` + `cat` results.
 * Returns array of parsed result objects.
 */
function parseRemoteResults(rawOutput, nodeName, fileType) {
  const results = [];
  if (!rawOutput) return results;

  // The SSH output is expected as JSON blocks separated by file markers
  // We ask the remote command to output: ---FILE:path---\n{json}\n
  const blocks = rawOutput.split(/---FILE:([^\n]+)---\n/);

  for (let i = 1; i < blocks.length; i += 2) {
    const filePath = blocks[i].trim();
    const content = blocks[i + 1];
    if (!content || !content.trim()) continue;

    try {
      const data = JSON.parse(content.trim());
      const parsed = {
        experiment_name: data.experiment_name || data.name || path.basename(filePath, path.extname(filePath)),
        node: nodeName,
        researcher: inferResearcher(filePath, data),
        model_type: inferModelType(filePath, data),
        ic: data.ic || data.mean_ic || data.ic_mean || null,
        sortino: data.sortino || data.sortino_ratio || null,
        sharpe: data.sharpe || data.sharpe_ratio || null,
        win_rate: data.win_rate || data.wr || null,
        total_pnl: data.total_pnl || data.pnl || null,
        n_trades: data.n_trades || data.trades || null,
        n_days: data.n_days || data.days || null,
        max_dd: data.max_dd || data.max_drawdown || null,
        leakage_status: inferLeakageStatus(filePath, data),
        mc_p5_sortino: data.mc_p5_sortino || null,
        mc_prob_profit: data.mc_prob_profit || null,
        config_json: data.config ? JSON.stringify(data.config) : null,
        log_path: filePath,
        source_type: 'json_remote',
        notes: `Collected from ${nodeName} via SSH`
      };
      results.push(parsed);
    } catch (e) {
      // Not valid JSON, skip
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Database Insert (with dedup)
// ---------------------------------------------------------------------------

function insertExperimentResult(row) {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.db.prepare(`
    INSERT OR IGNORE INTO experiment_results (
      experiment_name, node, researcher, model_type,
      ic, sortino, sharpe, win_rate, total_pnl,
      n_trades, n_days, max_dd, leakage_status,
      mc_p5_sortino, mc_prob_profit, config_json,
      log_path, source_type, notes
    ) VALUES (
      @experiment_name, @node, @researcher, @model_type,
      @ic, @sortino, @sharpe, @win_rate, @total_pnl,
      @n_trades, @n_days, @max_dd, @leakage_status,
      @mc_p5_sortino, @mc_prob_profit, @config_json,
      @log_path, @source_type, @notes
    )
  `);

  try {
    const info = stmt.run(row);
    return info.changes > 0; // true if inserted (not duplicate)
  } catch (e) {
    log('WARN', `Insert failed for ${row.experiment_name}: ${e.message}`);
    return false;
  }
}

function insertSweepConfig(row) {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.db.prepare(`
    INSERT OR IGNORE INTO sweep_configs (
      sweep_name, node, sweep_type, param_grid_json,
      best_config_json, best_metric_name, best_metric_value,
      total_configs, completed_configs, source_path
    ) VALUES (
      @sweep_name, @node, @sweep_type, @param_grid_json,
      @best_config_json, @best_metric_name, @best_metric_value,
      @total_configs, @completed_configs, @source_path
    )
  `);

  try {
    const info = stmt.run(row);
    return info.changes > 0;
  } catch (e) {
    log('WARN', `Sweep insert failed for ${row.sweep_name}: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Node Scanners
// ---------------------------------------------------------------------------

/**
 * Scan a local node for results.
 */
function scanLocalNode(nodeName, config, sinceDate = null) {
  const report = { node: nodeName, experiments: 0, sweeps: 0, skipped: 0, errors: 0 };
  const lvl3Root = config.lvl3_root;

  if (!fs.existsSync(lvl3Root)) {
    log('WARN', `Lvl3 root not found for ${nodeName}: ${lvl3Root}`);
    return report;
  }

  for (const scanDef of config.scan_paths) {
    const files = findFiles(lvl3Root, scanDef.pattern, sinceDate);
    log('INFO', `Found ${files.length} files matching ${scanDef.pattern} on ${nodeName}`);

    for (const filePath of files) {
      try {
        const ext = path.extname(filePath).toLowerCase();

        if (scanDef.type === 'sweep_csv' || (scanDef.type === 'sweep_result' && ext === '.csv')) {
          const sweep = parseSweepCSV(filePath, nodeName);
          if (sweep) {
            if (insertSweepConfig(sweep)) {
              report.sweeps++;
            } else {
              report.skipped++;
            }
          }
        } else if (ext === '.json') {
          const result = parseJSONResult(filePath, nodeName);
          if (result) {
            if (insertExperimentResult(result)) {
              report.experiments++;
            } else {
              report.skipped++;
            }
          }
        } else if (ext === '.log') {
          const result = parseTrainingLog(filePath, nodeName);
          if (result) {
            if (insertExperimentResult(result)) {
              report.experiments++;
            } else {
              report.skipped++;
            }
          }
        }
      } catch (e) {
        log('ERROR', `Error processing ${filePath}: ${e.message}`);
        report.errors++;
      }
    }
  }

  return report;
}

/**
 * Scan a remote node via SSH.
 * Uses QCC daemon SSH pool to list and read result files.
 */
async function scanRemoteNode(nodeName, config, sinceDate = null) {
  const report = { node: nodeName, experiments: 0, sweeps: 0, skipped: 0, errors: 0 };
  const lvl3Root = config.lvl3_root;

  // Check if node is reachable first
  const nodeStatus = await qccApiCall(`/api/nodes/${nodeName}`);
  if (!nodeStatus || nodeStatus.status === 'offline') {
    log('WARN', `Node ${nodeName} is offline, skipping`);
    report.errors++;
    return report;
  }

  for (const scanDef of config.scan_paths) {
    // Build find command for the remote node
    const isWindows = config.host !== '100.101.101.9' && !lvl3Root.startsWith('/');
    const ext = scanDef.pattern.split('.').pop();
    let findCmd;

    if (isWindows) {
      // PowerShell: find JSON/log files recursively
      const searchDir = lvl3Root + '\\' + scanDef.pattern.split('/')[0];
      const sinceFilter = sinceDate
        ? ` | Where-Object { $_.LastWriteTime -gt '${sinceDate.toISOString()}' }`
        : '';
      findCmd = `powershell -Command "Get-ChildItem -Path '${searchDir}' -Recurse -Filter '*.${ext}' ${sinceFilter} | Select-Object -First 50 | ForEach-Object { Write-Output ('---FILE:' + $_.FullName + '---'); Get-Content $_.FullName -Raw }"`;
    } else {
      // Linux: find + cat
      const searchDir = lvl3Root + '/' + scanDef.pattern.split('/')[0];
      const sinceFilter = sinceDate ? `-newer /tmp/since_marker` : '';
      findCmd = `find ${searchDir} -name '*.${ext}' ${sinceFilter} -type f | head -50 | while read f; do echo "---FILE:$f---"; cat "$f"; done`;
    }

    const output = await sshExec(nodeName, findCmd);
    if (!output) continue;

    const results = parseRemoteResults(output, nodeName, scanDef.type);
    for (const result of results) {
      try {
        if (insertExperimentResult(result)) {
          report.experiments++;
        } else {
          report.skipped++;
        }
      } catch (e) {
        log('ERROR', `Insert error for remote result on ${nodeName}: ${e.message}`);
        report.errors++;
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Also scan teleclaude-local results (scripts output, sweep_output.txt, etc.)
// ---------------------------------------------------------------------------

function scanTeleclaudeLocal(sinceDate = null) {
  const report = { node: 'neptune', experiments: 0, sweeps: 0, skipped: 0, errors: 0, source: 'teleclaude' };

  // Scan scripts/ output files
  const scriptsDir = path.join(BASE_DIR, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const files = findFiles(scriptsDir, '**/*.json', sinceDate);
    for (const filePath of files) {
      const result = parseJSONResult(filePath, 'neptune');
      if (result) {
        result.notes = (result.notes || '') + ' [teleclaude/scripts]';
        if (insertExperimentResult(result)) report.experiments++;
        else report.skipped++;
      }
    }
  }

  // Scan sweep_output.txt and similar top-level outputs
  const topLevelOutputs = ['sweep_output.txt', 'lgbm_razer_output.txt', 'card_report_output.txt'];
  for (const fname of topLevelOutputs) {
    const fpath = path.join(BASE_DIR, fname);
    if (fs.existsSync(fpath)) {
      try {
        const stat = fs.statSync(fpath);
        if (sinceDate && stat.mtime < sinceDate) continue;
        // These are typically log-style; try log parser
        const result = parseTrainingLog(fpath, 'neptune');
        if (result) {
          result.notes = (result.notes || '') + ` [teleclaude/${fname}]`;
          if (insertExperimentResult(result)) report.experiments++;
          else report.skipped++;
        }
      } catch (e) {
        report.errors++;
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a single node and index its results.
 */
async function scanNode(nodeName, sinceDate = null) {
  if (!db) initDatabase();

  const config = NODE_CONFIGS[nodeName];
  if (!config) {
    log('ERROR', `Unknown node: ${nodeName}`);
    return { node: nodeName, error: 'Unknown node' };
  }

  log('INFO', `Starting scan of ${nodeName}...`);

  if (config.isLocal) {
    return scanLocalNode(nodeName, config, sinceDate);
  } else {
    return await scanRemoteNode(nodeName, config, sinceDate);
  }
}

/**
 * Full scan — all nodes + teleclaude local.
 */
async function scanAndIndex(options = {}) {
  if (!db) initDatabase();

  const sinceDate = options.since ? new Date(options.since) : null;
  const targetNode = options.node || null;
  const dryRun = options.dryRun || false;

  const startTime = Date.now();
  const reports = [];

  log('INFO', '=== DB Organizer: Starting full scan ===');
  if (sinceDate) log('INFO', `Filtering results since ${sinceDate.toISOString()}`);

  // Scan local teleclaude results first
  if (!targetNode || targetNode === 'neptune') {
    const localReport = scanTeleclaudeLocal(sinceDate);
    reports.push(localReport);
    log('INFO', `Teleclaude local: ${localReport.experiments} experiments, ${localReport.sweeps} sweeps`);
  }

  // Scan each node
  const nodesToScan = targetNode ? [targetNode] : Object.keys(NODE_CONFIGS);
  for (const nodeName of nodesToScan) {
    try {
      const report = await scanNode(nodeName, sinceDate);
      reports.push(report);
      log('INFO', `${nodeName}: ${report.experiments} experiments, ${report.sweeps} sweeps, ${report.skipped} skipped, ${report.errors} errors`);
    } catch (e) {
      log('ERROR', `Failed to scan ${nodeName}: ${e.message}`);
      reports.push({ node: nodeName, experiments: 0, sweeps: 0, skipped: 0, errors: 1, error: e.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totals = reports.reduce((acc, r) => ({
    experiments: acc.experiments + (r.experiments || 0),
    sweeps: acc.sweeps + (r.sweeps || 0),
    skipped: acc.skipped + (r.skipped || 0),
    errors: acc.errors + (r.errors || 0),
  }), { experiments: 0, sweeps: 0, skipped: 0, errors: 0 });

  const summary = {
    elapsed_sec: parseFloat(elapsed),
    ...totals,
    nodes_scanned: reports.length,
    reports
  };

  log('INFO', `=== Scan complete in ${elapsed}s: ${totals.experiments} experiments, ${totals.sweeps} sweeps indexed ===`);

  return summary;
}

/**
 * Get summary statistics from the database.
 */
function getSummary() {
  if (!db) initDatabase();

  const total = db.db.prepare('SELECT COUNT(*) as cnt FROM experiment_results').get().cnt;
  const byNode = db.db.prepare('SELECT node, COUNT(*) as cnt FROM experiment_results GROUP BY node').all();
  const byResearcher = db.db.prepare('SELECT researcher, COUNT(*) as cnt FROM experiment_results GROUP BY researcher').all();
  const byModelType = db.db.prepare('SELECT model_type, COUNT(*) as cnt FROM experiment_results GROUP BY model_type').all();
  const topIC = db.db.prepare('SELECT experiment_name, node, ic, model_type FROM experiment_results WHERE ic IS NOT NULL ORDER BY ic DESC LIMIT 10').all();
  const topSortino = db.db.prepare('SELECT experiment_name, node, sortino, model_type FROM experiment_results WHERE sortino IS NOT NULL ORDER BY sortino DESC LIMIT 10').all();
  const sweepCount = db.db.prepare('SELECT COUNT(*) as cnt FROM sweep_configs').get().cnt;
  const leakageBreakdown = db.db.prepare('SELECT leakage_status, COUNT(*) as cnt FROM experiment_results GROUP BY leakage_status').all();

  return {
    total_experiments: total,
    total_sweeps: sweepCount,
    by_node: byNode,
    by_researcher: byResearcher,
    by_model_type: byModelType,
    leakage_breakdown: leakageBreakdown,
    top_ic: topIC,
    top_sortino: topSortino
  };
}

/**
 * Close database connection.
 */
function close() {
  if (db) {
    db.db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--node' && args[i + 1]) { flags.node = args[++i]; }
    else if (args[i] === '--since' && args[i + 1]) { flags.since = args[++i]; }
    else if (args[i] === '--dry-run') { flags.dryRun = true; }
    else if (args[i] === '--summary') { flags.summary = true; }
  }

  initDatabase();

  if (flags.summary) {
    const summary = getSummary();
    console.log(JSON.stringify(summary, null, 2));
    close();
    return;
  }

  const report = await scanAndIndex(flags);
  console.log('\n=== DB Organizer Report ===');
  console.log(JSON.stringify(report, null, 2));

  const summary = getSummary();
  console.log('\n=== Database Summary ===');
  console.log(`Total experiments: ${summary.total_experiments}`);
  console.log(`Total sweeps: ${summary.total_sweeps}`);
  console.log(`By node: ${JSON.stringify(summary.by_node)}`);
  console.log(`By researcher: ${JSON.stringify(summary.by_researcher)}`);
  console.log(`Leakage status: ${JSON.stringify(summary.leakage_breakdown)}`);

  close();
}

module.exports = {
  scanAndIndex,
  scanNode,
  getSummary,
  initDatabase,
  close,
  insertExperimentResult,
  insertSweepConfig,
  parseJSONResult,
  parseTrainingLog,
  parseSweepCSV,
};

if (require.main === module) {
  main().catch(e => {
    log('ERROR', `Fatal: ${e.message}`);
    process.exit(1);
  });
}
