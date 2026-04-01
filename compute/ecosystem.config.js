/**
 * ecosystem.config.js — PM2 Ecosystem (Ray-based architecture)
 *
 * Manages persistent processes that run 24/7, independent of any Claude session.
 * Researcher agents are spawned by the main Claude session on startup (not PM2).
 * Ray handles distributed compute scheduling.
 *
 * PROCESSES:
 *   qcc-daemon         — QCC API server (port 3456), node monitoring, job queue
 *   queue-watcher      — Auto-dispatches jobs from job_queue.js when nodes free up
 *   ray-startup        — One-shot: starts Ray cluster head + workers at boot
 *   ray-orchestrator   — Dispatches jobs from queues to Ray cluster (60s loop)
 *   mlflow             — MLflow tracking server (port 5000)
 *
 * QUICK START:
 *   cd C:\Users\Footb\Documents\Github\teleclaude-main
 *   pm2 start compute/ecosystem.config.js
 *   pm2 save
 *   pm2 startup         # enable autostart on Windows boot (run the printed command as admin)
 *
 * USEFUL COMMANDS:
 *   pm2 status                                     # see all processes
 *   pm2 logs ray-orchestrator --lines 100          # tail logs
 *   pm2 restart qcc-daemon                         # restart one
 *
 * ENVIRONMENT VARIABLES:
 *   ANTHROPIC_API_KEY   — required for Claude reasoning calls
 *   NODE_PASSWORD       — SSH password for all remote nodes (default: read from memory)
 *   QCC_PORT            — QCC daemon port (default: 3456)
 *   MLFLOW_TRACKING_URI — MLflow URL (default: http://localhost:5000)
 */

'use strict';

const path = require('path');

const ROOT         = path.join(__dirname, '..');  // teleclaude-main/
const LOG_DIR      = path.join(ROOT, 'logs');

/**
 * Build a PM2 app entry for a researcher agent.
 *
 * @param {object} opts
 * @param {string}   opts.name       - PM2 process name
 * @param {string}   opts.script     - path to the JS entry point
 * @param {string}   opts.logPrefix  - prefix for log file names
 * @param {number}   [opts.memoryMB] - max memory before PM2 restarts (default 256)
 * @param {object}   [opts.env]      - extra environment variables
 */
function makeApp(opts) {
  const {
    name,
    script,
    logPrefix,
    memoryMB = 256,
    env = {},
  } = opts;

  return {
    name,
    script,
    cwd: ROOT,

    // ── Environment ──────────────────────────────────────────────────────────
    env: {
      NODE_ENV:            'production',
      QCC_PORT:            '3456',
      MLFLOW_TRACKING_URI: 'http://localhost:5000',
      PYTHONUTF8:          '1',
      PYTHONIOENCODING:    'utf-8',
      ...env,
    },

    // ── Restart policy ───────────────────────────────────────────────────────
    // Researchers MUST stay alive — always restart on crash, limited to avoid
    // spin-loops caused by repeated startup errors.
    autorestart:        true,
    max_restarts:       50,        // per instance lifetime (not per hour)
    min_uptime:         '20s',     // must stay up ≥20s before restart counter resets
    restart_delay:      20000,     // 20s backoff between restarts

    // ── Log files ────────────────────────────────────────────────────────────
    out_file:        path.join(LOG_DIR, `${logPrefix}-out.log`),
    error_file:      path.join(LOG_DIR, `${logPrefix}-error.log`),
    log_file:        path.join(LOG_DIR, `${logPrefix}-combined.log`),
    merge_logs:      true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

    // ── Memory limit ─────────────────────────────────────────────────────────
    // Restart if the process grows beyond this — protects against memory leaks
    // in long-running SSH pools or Claude context accumulation.
    max_memory_restart: `${memoryMB}M`,

    // ── Execution mode ───────────────────────────────────────────────────────
    // Fork mode required on Windows (cluster mode uses IPC that doesn't work
    // with long-running polling loops on this platform).
    exec_mode: 'fork',
    instances: 1,

    // No file watching — we don't want restarts on code edits while trading
    watch: false,

    // ── Graceful shutdown ────────────────────────────────────────────────────
    // Give the loop up to 15s to finish its current sleep before SIGKILL.
    kill_timeout:   15000,
    listen_timeout: 5000,
  };
}

// ============================================================================
// PM2 APP DEFINITIONS
// ============================================================================

module.exports = {
  apps: [

    // ── Ray Cluster Startup ───────────────────────────────────────────────────
    // Runs ONCE at boot to start the Ray cluster (head + workers).
    // Exits after startup (no auto-restart).
    // Use with: pm2 start compute/ecosystem.config.js --only ray-startup
    {
      name:        'ray-startup',
      script:      path.join(__dirname, 'ray_startup.js'),
      cwd:         ROOT,
      autorestart: false,   // runs once then exits
      out_file:    path.join(LOG_DIR, 'ray-startup-out.log'),
      error_file:  path.join(LOG_DIR, 'ray-startup-error.log'),
      merge_logs:  true,
      exec_mode:   'fork',
      instances:   1,
      watch:       false,
      env: {
        NODE_API_KEY: 'qcc_node_api_2026',
      },
    },

    // ── Ray Orchestrator ─────────────────────────────────────────────────────
    // Python-based Ray distributed task orchestrator.
    // Connects to Ray cluster (head: Jupiter 192.168.0.108:6379).
    // Dispatches jobs from job_queue_*.json to the Ray cluster.
    // GPU jobs on Razer dispatched via Flask API.
    // Auto-logs every completed job to MLflow (Neptune Tailscale: 100.109.245.73:5000).
    // Reads researcher state files for priority-aware job dispatch.
    // Loop: 60s
    {
      name:        'ray-orchestrator',
      // Windows: PM2 cannot exec Windows Store Python as an interpreter directly.
      // Use a JS runner shim (ray_orchestrator_runner.js) that spawns the Python
      // subprocess — same pattern used by other persistent compute processes here.
      script:      path.join(__dirname, 'ray_orchestrator_runner.js'),
      cwd:         ROOT,
      autorestart:        true,
      max_restarts:       20,
      min_uptime:         '30s',
      restart_delay:      15000,
      out_file:        path.join(LOG_DIR, 'ray-orchestrator-out.log'),
      error_file:      path.join(LOG_DIR, 'ray-orchestrator-error.log'),
      log_file:        path.join(LOG_DIR, 'ray-orchestrator-combined.log'),
      merge_logs:      true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '256M',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      kill_timeout: 15000,
      env: {
        NODE_API_KEY:          'qcc_node_api_2026',
        PYTHONUTF8:            '1',
        PYTHONIOENCODING:      'utf-8',
        // Orchestrator runs ON Neptune — use localhost so Host header matches.
        // Remote job scripts get MLFLOW_TRACKING_URI injected via _dispatch_to_ray
        // pointing to 100.109.245.73:5000 (requires MLflow --allowed-hosts all).
        MLFLOW_TRACKING_URI:   'http://localhost:5000',
      },
    },

    // ── Ray Watchdog ─────────────────────────────────────────────────────────
    // Monitors the Ray cluster every 60 seconds for dropped nodes.
    // Auto-reconnects Razer (Flask API), Uranus (SSH+PowerShell), Saturn (SSH hop),
    // Neptune (local spawnSync). Alerts Discord on drops and reconnects.
    // History persisted to compute/ray_watchdog_history.json.
    // Dashboard queried: http://192.168.0.108:8265/nodes?view=summary
    makeApp({
      name:      'ray-watchdog',
      script:    path.join(__dirname, 'ray_watchdog.js'),
      logPrefix: 'ray-watchdog',
      memoryMB:  128,
      env: {
        NODE_API_KEY: 'qcc_node_api_2026',
      },
    }),

    // ── Persistent Autonomous Monitor ────────────────────────────────────────
    // Runs 24/7: polls MLflow for fold completions, checks GPU idle, sends
    // deep evaluation prompts every 15 min. Independent of Claude session.
    // Survives restarts. THIS IS THE AUTONOMOUS BRAIN BACKUP.
    makeApp({
      name:      'persistent-monitor',
      script:    path.join(__dirname, 'persistent_monitor.js'),
      logPrefix: 'persistent-monitor',
      memoryMB:  128,
      env: {
        TELECLAUDE_DIR: ROOT,
      },
    }),

  ],
};
