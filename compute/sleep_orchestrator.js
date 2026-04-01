#!/usr/bin/env node
/**
 * sleep_orchestrator.js — Overnight Automation for QCC
 *
 * PM2 process that activates after market close and runs overnight tasks:
 *   - 4:30 PM ET: Result collection + database indexing (db_organizer)
 *   - 5:00 PM ET: Memory consolidation + log cleanup
 *   - 6:00 AM ET: Pre-market health check + summary to Discord
 *
 * Runs continuously but only executes tasks at scheduled times.
 * Uses a tick-based scheduler (checks every 60s) rather than cron.
 *
 * Usage:
 *   node compute/sleep_orchestrator.js                — run continuously
 *   node compute/sleep_orchestrator.js --run-now      — execute all tasks immediately
 *   node compute/sleep_orchestrator.js --run phase1   — run specific phase
 *   node compute/sleep_orchestrator.js --status       — show last run status
 *
 * PM2:
 *   pm2 start qcc/ecosystem.config.js   (includes sleep-orchestrator entry)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, exec } = require('child_process');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Paths & Config
// ---------------------------------------------------------------------------

const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const MEMORY_DIR = path.join(BASE_DIR, '.claude', 'projects', 'C--Users-Footb-Documents-Github-teleclaude-main', 'memory');
const STATE_FILE = path.join(DATA_DIR, 'sleep_orchestrator_state.json');
const LOG_FILE = path.join(LOGS_DIR, `sleep-orchestrator-${new Date().toISOString().split('T')[0]}.log`);
const QCC_BASE = 'http://localhost:3456';

const TICK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const LOG_RETENTION_DAYS = 7;
const LOG_ARCHIVE_DIR = path.join(LOGS_DIR, 'archive');

// Ensure dirs
for (const dir of [DATA_DIR, LOGS_DIR, LOG_ARCHIVE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [SLEEP-ORCH] [${level}] ${message}`;
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
// Time Utilities (ET)
// ---------------------------------------------------------------------------

function getETNow() {
  // Use Intl to get accurate ET offset (handles DST)
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etStr);
}

function getETHour() {
  const et = getETNow();
  return et.getHours();
}

function getETMinute() {
  const et = getETNow();
  return et.getMinutes();
}

function isWeekday() {
  const et = getETNow();
  const day = et.getDay();
  return day >= 1 && day <= 5;
}

function todayDateStr() {
  const et = getETNow();
  return et.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    log('WARN', `Failed to load state: ${e.message}`);
  }
  return {
    last_phase1_date: null, // Result collection
    last_phase2_date: null, // Memory consolidation
    last_phase3_date: null, // Pre-market health check
    last_run_results: {},
    total_runs: 0
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log('ERROR', `Failed to save state: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Discord Notification
// ---------------------------------------------------------------------------

const webhookNotifier = require('../utils/webhook_notifier');

async function notifyDiscord(type, title, description, fields = []) {
  try {
    await webhookNotifier.notify(type, title, description, fields);
    log('INFO', `Discord notification sent: ${title}`);
  } catch (e) {
    log('ERROR', `Discord notification failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// QCC API Helper
// ---------------------------------------------------------------------------

function qccApiCall(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, QCC_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('QCC API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Phase 1: Result Collection + Database Indexing (4:30 PM ET)
// ---------------------------------------------------------------------------

async function phase1_resultCollection() {
  log('INFO', '=== Phase 1: Result Collection ===');
  const startTime = Date.now();
  const results = { phase: 'result_collection', status: 'running', errors: [] };

  try {
    // Run db_organizer
    const dbOrganizer = require('./db_organizer');
    dbOrganizer.initDatabase();

    const scanReport = await dbOrganizer.scanAndIndex({ since: null });
    results.scan = scanReport;

    const summary = dbOrganizer.getSummary();
    results.db_summary = {
      total_experiments: summary.total_experiments,
      total_sweeps: summary.total_sweeps,
      by_node: summary.by_node,
      top_ic: summary.top_ic ? summary.top_ic.slice(0, 3) : []
    };

    dbOrganizer.close();

    results.status = 'completed';
    results.elapsed_sec = ((Date.now() - startTime) / 1000).toFixed(1);
    log('INFO', `Phase 1 complete: ${scanReport.experiments} experiments indexed in ${results.elapsed_sec}s`);
  } catch (e) {
    results.status = 'failed';
    results.error = e.message;
    results.errors.push(e.message);
    log('ERROR', `Phase 1 failed: ${e.message}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 2: Memory Consolidation + Log Cleanup (5:00 PM ET)
// ---------------------------------------------------------------------------

async function phase2_memoryAndCleanup() {
  log('INFO', '=== Phase 2: Memory Consolidation + Log Cleanup ===');
  const startTime = Date.now();
  const results = { phase: 'memory_and_cleanup', status: 'running', errors: [] };

  // 2a. Memory consolidation
  try {
    const { nightlyConsolidate } = require('../utils/memory_consolidate');
    const consolidateReport = nightlyConsolidate();
    results.memory_consolidation = consolidateReport;
    log('INFO', 'Memory consolidation complete', consolidateReport);
  } catch (e) {
    results.errors.push(`Memory consolidation failed: ${e.message}`);
    log('ERROR', `Memory consolidation failed: ${e.message}`);
  }

  // 2b. Log cleanup — archive logs older than LOG_RETENTION_DAYS
  try {
    const archiveReport = archiveLogs();
    results.log_cleanup = archiveReport;
    log('INFO', `Log cleanup: ${archiveReport.archived} archived, ${archiveReport.deleted} deleted`);
  } catch (e) {
    results.errors.push(`Log cleanup failed: ${e.message}`);
    log('ERROR', `Log cleanup failed: ${e.message}`);
  }

  // 2c. Data verification — check MBO data integrity for tomorrow
  try {
    const dataReport = await verifyMBOData();
    results.data_verification = dataReport;
    log('INFO', `MBO data verification: ${dataReport.status}`);
  } catch (e) {
    results.errors.push(`Data verification failed: ${e.message}`);
    log('ERROR', `Data verification failed: ${e.message}`);
  }

  // 2d. Research queue prep — review completions, suggest next
  try {
    const researchReport = await prepResearchQueue();
    results.research_prep = researchReport;
    log('INFO', `Research prep: ${researchReport.completed_today} completed, ${researchReport.queued_next} queued`);
  } catch (e) {
    results.errors.push(`Research prep failed: ${e.message}`);
    log('ERROR', `Research prep failed: ${e.message}`);
  }

  // 2e. Researcher doc updates
  try {
    const docReport = updateResearcherDocs();
    results.doc_updates = docReport;
    log('INFO', `Researcher docs updated: ${docReport.updated} files`);
  } catch (e) {
    results.errors.push(`Researcher doc update failed: ${e.message}`);
    log('ERROR', `Researcher doc update failed: ${e.message}`);
  }

  results.status = results.errors.length === 0 ? 'completed' : 'partial';
  results.elapsed_sec = ((Date.now() - startTime) / 1000).toFixed(1);
  log('INFO', `Phase 2 complete in ${results.elapsed_sec}s with ${results.errors.length} errors`);

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3: Pre-Market Health Check (6:00 AM ET)
// ---------------------------------------------------------------------------

async function phase3_healthCheck() {
  log('INFO', '=== Phase 3: Pre-Market Health Check ===');
  const startTime = Date.now();
  const results = { phase: 'health_check', status: 'running', errors: [] };

  // 3a. Node status check
  try {
    const healthData = await qccApiCall('/api/health');
    results.qcc_health = healthData;
  } catch (e) {
    results.errors.push(`QCC health check failed: ${e.message}`);
    results.qcc_health = { status: 'unreachable', error: e.message };
  }

  // 3b. Check node connectivity
  const nodeStatuses = {};
  for (const nodeName of ['neptune', 'uranus', 'razer', 'jupiter', 'saturn']) {
    try {
      const status = await qccApiCall(`/api/nodes/${nodeName}`);
      nodeStatuses[nodeName] = {
        status: status.status || 'unknown',
        gpu_util: status.last_gpu_util || null,
        last_heartbeat: status.last_heartbeat || null
      };
    } catch (e) {
      nodeStatuses[nodeName] = { status: 'unreachable', error: e.message };
    }
  }
  results.node_statuses = nodeStatuses;

  // 3c. Check paper engine status
  try {
    const paperState = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\live_trading\\logs\\paper\\live_state.json';
    if (fs.existsSync(paperState)) {
      const state = JSON.parse(fs.readFileSync(paperState, 'utf8'));
      results.paper_engine = {
        running: true,
        cards: state.cards ? Object.keys(state.cards).length : 0,
        total_pnl: state.total_pnl || state.cumulative_pnl || null,
        last_updated: state.timestamp || state.last_updated || null
      };
    } else {
      results.paper_engine = { running: false, error: 'State file not found' };
    }
  } catch (e) {
    results.paper_engine = { running: false, error: e.message };
  }

  // 3d. Check training jobs
  try {
    const training = await qccApiCall('/api/training');
    results.active_training = training;
  } catch (e) {
    results.active_training = { error: e.message };
  }

  // 3e. Get overnight db_organizer summary
  try {
    const dbOrganizer = require('./db_organizer');
    dbOrganizer.initDatabase();
    const dbSummary = dbOrganizer.getSummary();
    results.db_summary = {
      total_experiments: dbSummary.total_experiments,
      top_3_ic: dbSummary.top_ic ? dbSummary.top_ic.slice(0, 3).map(r => `${r.experiment_name} (${r.node}): IC=${r.ic}`) : [],
      top_3_sortino: dbSummary.top_sortino ? dbSummary.top_sortino.slice(0, 3).map(r => `${r.experiment_name}: Sortino=${r.sortino}`) : []
    };
    dbOrganizer.close();
  } catch (e) {
    results.db_summary = { error: e.message };
  }

  results.status = results.errors.length === 0 ? 'completed' : 'partial';
  results.elapsed_sec = ((Date.now() - startTime) / 1000).toFixed(1);

  // 3f. Post summary to Discord #system-status
  await postOvernightSummary(results);

  log('INFO', `Phase 3 complete in ${results.elapsed_sec}s`);
  return results;
}

// ---------------------------------------------------------------------------
// Sub-Tasks
// ---------------------------------------------------------------------------

/**
 * Archive logs older than LOG_RETENTION_DAYS, compress with gzip.
 */
function archiveLogs() {
  const report = { archived: 0, deleted: 0, bytes_saved: 0 };
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let entries;
  try {
    entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
  } catch (e) {
    return report;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (entry.name.endsWith('.gz')) continue; // Already compressed

    const filePath = path.join(LOGS_DIR, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtime < cutoff) {
        // Compress to archive
        const content = fs.readFileSync(filePath);
        const compressed = zlib.gzipSync(content);
        const archivePath = path.join(LOG_ARCHIVE_DIR, entry.name + '.gz');
        fs.writeFileSync(archivePath, compressed);
        report.bytes_saved += stat.size - compressed.length;

        // Delete original
        fs.unlinkSync(filePath);
        report.archived++;
        log('INFO', `Archived: ${entry.name} (${(stat.size / 1024).toFixed(1)}KB -> ${(compressed.length / 1024).toFixed(1)}KB)`);
      }
    } catch (e) {
      log('WARN', `Failed to archive ${entry.name}: ${e.message}`);
    }
  }

  // Clean up very old archives (>30 days)
  const archiveCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const archiveEntries = fs.readdirSync(LOG_ARCHIVE_DIR);
    for (const fname of archiveEntries) {
      const fpath = path.join(LOG_ARCHIVE_DIR, fname);
      try {
        const stat = fs.statSync(fpath);
        if (stat.mtime < archiveCutoff) {
          fs.unlinkSync(fpath);
          report.deleted++;
        }
      } catch (e) {}
    }
  } catch (e) {}

  return report;
}

/**
 * Verify MBO data for the next trading day.
 */
async function verifyMBOData() {
  const report = { status: 'unknown', dates_checked: 0, missing: [] };

  try {
    const dataResult = await qccApiCall('/api/data/inventory');
    if (dataResult && dataResult.files) {
      report.status = 'ok';
      report.total_files = dataResult.files.length || 0;

      // Check if today's data exists
      const today = todayDateStr();
      const todayFiles = (dataResult.files || []).filter(f => f.date === today);
      report.today_data = todayFiles.length > 0 ? 'present' : 'missing';
      report.dates_checked = 1;

      if (todayFiles.length === 0) {
        report.missing.push(today);
        report.status = 'warning';
      }
    } else {
      // Fallback: check local data dir
      const mboDir = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\data\\mbo';
      if (fs.existsSync(mboDir)) {
        const files = fs.readdirSync(mboDir);
        report.total_files = files.length;
        report.status = files.length > 0 ? 'ok' : 'empty';
      } else {
        report.status = 'dir_not_found';
      }
    }
  } catch (e) {
    report.status = 'error';
    report.error = e.message;
  }

  return report;
}

/**
 * Review completed research and queue next experiments.
 */
async function prepResearchQueue() {
  const report = { completed_today: 0, queued_next: 0, suggestions: [] };

  try {
    // Check research_queue via QCC
    const queueData = await qccApiCall('/api/research');
    if (queueData && Array.isArray(queueData.items || queueData)) {
      const items = queueData.items || queueData;
      const today = todayDateStr();

      // Count today's completions
      report.completed_today = items.filter(
        i => i.status === 'completed' && i.completed_at && i.completed_at.startsWith(today)
      ).length;

      // Count queued items
      report.queued_next = items.filter(i => i.status === 'queued').length;
    }
  } catch (e) {
    report.error = e.message;
  }

  return report;
}

/**
 * Update researcher context docs with daily summary.
 */
function updateResearcherDocs() {
  const report = { updated: 0 };
  const researchersDir = path.join(BASE_DIR, 'qcc', 'researchers');

  if (!fs.existsSync(researchersDir)) return report;

  const today = todayDateStr();
  const contextFiles = ['alpha_context.json', 'omega_context.json', 'sigma_context.json', 'theta_context.json'];

  for (const fname of contextFiles) {
    const fpath = path.join(researchersDir, fname);
    if (!fs.existsSync(fpath)) continue;

    try {
      const context = JSON.parse(fs.readFileSync(fpath, 'utf8'));

      // Append daily log entry
      if (!context.daily_logs) context.daily_logs = [];
      const alreadyLogged = context.daily_logs.some(l => l.date === today);
      if (!alreadyLogged) {
        context.daily_logs.push({
          date: today,
          note: 'Overnight consolidation complete. Check experiment_results table for indexed results.',
          automated: true
        });

        // Trim old logs (keep last 30)
        if (context.daily_logs.length > 30) {
          context.daily_logs = context.daily_logs.slice(-30);
        }

        context.last_consolidation = today;
        fs.writeFileSync(fpath, JSON.stringify(context, null, 2));
        report.updated++;
      }
    } catch (e) {
      log('WARN', `Failed to update ${fname}: ${e.message}`);
    }
  }

  return report;
}

/**
 * Post overnight summary to Discord #system-status.
 */
async function postOvernightSummary(healthResults) {
  const today = todayDateStr();
  const state = loadState();

  // Build status lines
  const nodeLines = [];
  if (healthResults.node_statuses) {
    for (const [name, info] of Object.entries(healthResults.node_statuses)) {
      const statusEmoji = info.status === 'online' ? 'UP' : info.status === 'training' ? 'TRAINING' : 'DOWN';
      const gpuStr = info.gpu_util !== null ? ` GPU:${info.gpu_util}%` : '';
      nodeLines.push(`${name}: ${statusEmoji}${gpuStr}`);
    }
  }

  const paperStr = healthResults.paper_engine
    ? (healthResults.paper_engine.running
      ? `Running (${healthResults.paper_engine.cards} cards, PnL: $${healthResults.paper_engine.total_pnl || '?'})`
      : 'OFFLINE')
    : 'Unknown';

  const dbStr = healthResults.db_summary
    ? `${healthResults.db_summary.total_experiments || 0} experiments indexed`
    : 'N/A';

  const fields = [
    { name: 'Compute Nodes', value: nodeLines.join('\n') || 'No data', inline: false },
    { name: 'Paper Engine', value: paperStr, inline: true },
    { name: 'Results DB', value: dbStr, inline: true },
  ];

  if (healthResults.db_summary && healthResults.db_summary.top_3_ic) {
    fields.push({
      name: 'Top IC Results',
      value: healthResults.db_summary.top_3_ic.join('\n') || 'None',
      inline: false
    });
  }

  // Phase 1/2 results from last night
  if (state.last_run_results.phase1) {
    const p1 = state.last_run_results.phase1;
    fields.push({
      name: 'Overnight Indexing',
      value: `${p1.scan ? p1.scan.experiments : 0} new experiments, ${p1.scan ? p1.scan.sweeps : 0} sweeps`,
      inline: true
    });
  }
  if (state.last_run_results.phase2) {
    const p2 = state.last_run_results.phase2;
    const logStr = p2.log_cleanup ? `${p2.log_cleanup.archived} logs archived` : '';
    fields.push({
      name: 'Overnight Cleanup',
      value: logStr || 'Done',
      inline: true
    });
  }

  const description = `Pre-market health report for ${today}. ${isWeekday() ? 'Trading day.' : 'Non-trading day.'}`;

  await notifyDiscord('info', `Overnight Report: ${today}`, description, fields);
}

// ---------------------------------------------------------------------------
// Scheduler Logic
// ---------------------------------------------------------------------------

let state = loadState();

/**
 * Check if a phase should run based on current time and last execution.
 */
function shouldRunPhase(phaseKey, targetHour, targetMinute, windowMinutes = 5) {
  const hour = getETHour();
  const minute = getETMinute();
  const today = todayDateStr();

  // Already ran today?
  if (state[phaseKey] === today) return false;

  // Within the execution window?
  if (hour === targetHour && minute >= targetMinute && minute < targetMinute + windowMinutes) {
    return true;
  }

  return false;
}

/**
 * Main tick — called every TICK_INTERVAL_MS.
 */
async function tick() {
  try {
    // Phase 1: 4:30 PM ET — Result collection
    if (shouldRunPhase('last_phase1_date', 16, 30)) {
      log('INFO', 'Triggering Phase 1: Result Collection');
      const result = await phase1_resultCollection();
      state.last_phase1_date = todayDateStr();
      state.last_run_results.phase1 = result;
      state.total_runs++;
      saveState(state);
    }

    // Phase 2: 5:00 PM ET — Memory consolidation + cleanup
    if (shouldRunPhase('last_phase2_date', 17, 0)) {
      log('INFO', 'Triggering Phase 2: Memory Consolidation + Cleanup');
      const result = await phase2_memoryAndCleanup();
      state.last_phase2_date = todayDateStr();
      state.last_run_results.phase2 = result;
      state.total_runs++;
      saveState(state);
    }

    // Phase 3: 6:00 AM ET — Pre-market health check
    if (shouldRunPhase('last_phase3_date', 6, 0)) {
      log('INFO', 'Triggering Phase 3: Pre-Market Health Check');
      const result = await phase3_healthCheck();
      state.last_phase3_date = todayDateStr();
      state.last_run_results.phase3 = result;
      state.total_runs++;
      saveState(state);
    }
  } catch (e) {
    log('ERROR', `Tick error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLI & Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // --status: show last run state
  if (args.includes('--status')) {
    const st = loadState();
    console.log(JSON.stringify(st, null, 2));
    return;
  }

  // --run-now: execute all phases immediately
  if (args.includes('--run-now')) {
    log('INFO', '=== Manual run: executing all phases ===');
    initAll();

    const r1 = await phase1_resultCollection();
    console.log('Phase 1:', JSON.stringify(r1, null, 2));

    const r2 = await phase2_memoryAndCleanup();
    console.log('Phase 2:', JSON.stringify(r2, null, 2));

    const r3 = await phase3_healthCheck();
    console.log('Phase 3:', JSON.stringify(r3, null, 2));

    state.last_phase1_date = todayDateStr();
    state.last_phase2_date = todayDateStr();
    state.last_phase3_date = todayDateStr();
    state.last_run_results = { phase1: r1, phase2: r2, phase3: r3 };
    state.total_runs++;
    saveState(state);
    return;
  }

  // --run <phase>: run a specific phase
  const runIdx = args.indexOf('--run');
  if (runIdx !== -1 && args[runIdx + 1]) {
    const phase = args[runIdx + 1];
    initAll();

    if (phase === 'phase1' || phase === '1') {
      const r = await phase1_resultCollection();
      console.log(JSON.stringify(r, null, 2));
      state.last_phase1_date = todayDateStr();
      state.last_run_results.phase1 = r;
    } else if (phase === 'phase2' || phase === '2') {
      const r = await phase2_memoryAndCleanup();
      console.log(JSON.stringify(r, null, 2));
      state.last_phase2_date = todayDateStr();
      state.last_run_results.phase2 = r;
    } else if (phase === 'phase3' || phase === '3') {
      const r = await phase3_healthCheck();
      console.log(JSON.stringify(r, null, 2));
      state.last_phase3_date = todayDateStr();
      state.last_run_results.phase3 = r;
    } else {
      console.error(`Unknown phase: ${phase}. Use phase1, phase2, or phase3.`);
      process.exit(1);
    }
    state.total_runs++;
    saveState(state);
    return;
  }

  // Default: continuous scheduler mode
  log('INFO', '=== Sleep Orchestrator starting (continuous mode) ===');
  log('INFO', `Schedule: Phase1=4:30PM ET, Phase2=5:00PM ET, Phase3=6:00AM ET`);
  log('INFO', `State: ${JSON.stringify(state)}`);

  initAll();

  // Initial tick
  await tick();

  // Schedule recurring ticks
  setInterval(tick, TICK_INTERVAL_MS);

  // Keep process alive
  process.on('SIGINT', () => {
    log('INFO', 'Sleep orchestrator shutting down (SIGINT)');
    saveState(state);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('INFO', 'Sleep orchestrator shutting down (SIGTERM)');
    saveState(state);
    process.exit(0);
  });
}

function initAll() {
  state = loadState();
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------

module.exports = {
  phase1_resultCollection,
  phase2_memoryAndCleanup,
  phase3_healthCheck,
  archiveLogs,
  verifyMBOData,
  prepResearchQueue,
  updateResearcherDocs,
  postOvernightSummary,
  loadState,
};

if (require.main === module) {
  main().catch(e => {
    log('ERROR', `Fatal: ${e.message}`);
    process.exit(1);
  });
}
