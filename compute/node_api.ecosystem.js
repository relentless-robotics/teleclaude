/**
 * node_api.ecosystem.js — PM2 configuration for node_api_server.py
 *
 * Deploy one instance per physical machine. The NODE_NAME env var tells the
 * server which node it is (used for queue file detection and logging).
 *
 * Deploy on a specific node:
 *   pm2 start compute/node_api.ecosystem.js --only node-api-neptune
 *   pm2 start compute/node_api.ecosystem.js --only node-api-uranus
 *   pm2 start compute/node_api.ecosystem.js --only node-api-razer
 *   pm2 start compute/node_api.ecosystem.js --only node-api-jupiter
 *   pm2 start compute/node_api.ecosystem.js --only node-api-saturn
 *
 * Deploy on the current machine (auto-detect by hostname):
 *   pm2 start compute/node_api.ecosystem.js --only node-api-$(hostname | tr '[:upper:]' '[:lower:]')
 *
 * Save after starting so PM2 restarts on reboot:
 *   pm2 save
 *
 * View logs:
 *   pm2 logs node-api-neptune
 *   pm2 logs node-api-jupiter
 *
 * Environment variable required on each node:
 *   NODE_API_KEY=<shared-secret>  (same value across all nodes)
 *
 * Or place in compute/.env:
 *   NODE_API_KEY=<shared-secret>
 *
 * The shared secret must match the key used in NodeAPI clients:
 *   new NodeAPI(host, 8765, process.env.NODE_API_KEY)
 */

'use strict';

const path = require('path');

// Absolute path to this ecosystem file's directory (compute/)
const COMPUTE_DIR = __dirname;

// The Flask server script (relative to COMPUTE_DIR)
const SERVER_SCRIPT = path.join(COMPUTE_DIR, 'node_api_server.py');

// Common PM2 options shared across all node instances
const COMMON = {
  script:     SERVER_SCRIPT,
  interpreter: 'python',        // 'python3' on Linux; adjust per node if needed
  instances:  1,
  autorestart: true,
  watch:      false,
  max_memory_restart: '256M',   // restart if Flask leaks — unlikely but safe

  // Restart policy: exponential backoff, max 10 restarts in 5 minutes
  restart_delay:       2000,
  max_restarts:        10,
  min_uptime:          '30s',   // must be up 30s to count as "started"

  // Log rotation (PM2 logrotate module handles this, but set reasonable limits)
  log_date_format:     'YYYY-MM-DD HH:mm:ss',
  merge_logs:          true,

  // Environment variables (overridden per-node below)
  env: {
    NODE_API_PORT: '8765',
    NODE_API_KEY:  process.env.NODE_API_KEY || '',  // inherit from current env
    PYTHONUNBUFFERED: '1',                           // real-time log output
  },
};

module.exports = {
  apps: [
    // ── Neptune (local Windows, localhost) ────────────────────────────────
    {
      ...COMMON,
      name:        'node-api-neptune',
      interpreter: 'python',      // Windows: 'python' → py launcher
      cwd:         COMPUTE_DIR,
      env: {
        ...COMMON.env,
        NODE_NAME:     'neptune',
        NODE_API_PORT: '8765',
        // Neptune uses the paper engine — keep Flask at normal priority
        // (paper engine itself runs inference, Flask is just a thin API)
      },
      // Windows-specific: hide the console window
      windowsHide: true,
    },

    // ── Uranus (remote Windows, 100.100.83.37) ────────────────────────────
    // Run this config file DIRECTLY on the Uranus machine, not via PM2 SSH.
    // After SSH-ing to Uranus:
    //   cd C:\Users\nick\Lvl3Quant && pm2 start compute/node_api.ecosystem.js --only node-api-uranus
    {
      ...COMMON,
      name:        'node-api-uranus',
      interpreter: 'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
      cwd:         'C:\\Users\\nick\\Lvl3Quant\\compute',
      env: {
        ...COMMON.env,
        NODE_NAME:     'uranus',
        NODE_API_PORT: '8765',
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
    },

    // ── Razer (remote Windows, 100.102.215.75) ────────────────────────────
    {
      ...COMMON,
      name:        'node-api-razer',
      interpreter: 'C:\\Python311\\python.exe',
      cwd:         'C:\\Users\\claude\\Lvl3Quant\\compute',
      env: {
        ...COMMON.env,
        NODE_NAME:     'razer',
        NODE_API_PORT: '8765',
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
    },

    // ── Jupiter (remote Linux/WSL, 192.168.0.108) ─────────────────────────
    {
      ...COMMON,
      name:        'node-api-jupiter',
      interpreter: 'python3',
      cwd:         '/home/jupiter/Lvl3Quant/compute',
      env: {
        ...COMMON.env,
        NODE_NAME:     'jupiter',
        NODE_API_PORT: '8765',
        PYTHONUNBUFFERED: '1',
      },
    },

    // ── Saturn (remote Linux, 10.0.0.2) ──────────────────────────────────
    // Accessible via Jupiter as a hop. Run this directly on Saturn after SSH-ing in.
    // ssh jupiter@192.168.0.108 then ssh saturn@10.0.0.2
    {
      ...COMMON,
      name:        'node-api-saturn',
      interpreter: 'python3',
      cwd:         '/home/saturn/Lvl3Quant/compute',
      env: {
        ...COMMON.env,
        NODE_NAME:     'saturn',
        NODE_API_PORT: '8765',
        PYTHONUNBUFFERED: '1',
      },
    },
  ],
};
