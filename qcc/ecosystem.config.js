/**
 * PM2 Ecosystem Configuration for QCC Daemon + Research Orchestrator
 *
 * Usage:
 *   pm2 start qcc/ecosystem.config.js
 *   pm2 stop qcc-daemon
 *   pm2 stop qcc-orchestrator
 *   pm2 restart qcc-daemon
 *   pm2 logs qcc-orchestrator
 *   pm2 save          # persist across reboots
 *   pm2 startup       # auto-start PM2 on system boot
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'qcc-daemon',
      script: path.join(__dirname, 'daemon.js'),
      cwd: path.join(__dirname, '..'),

      // Environment
      env: {
        NODE_ENV: 'production',
        QCC_PORT: 3456,
        QCC_STREAMLIT_PORT: 8501,
        QCC_HEARTBEAT_MS: 60000,
        QCC_GPU_CHECK_MS: 120000,
        QCC_TRAINING_CHECK_MS: 300000,
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Logging
      log_file: path.join(__dirname, '..', 'logs', 'qcc-daemon-pm2.log'),
      error_file: path.join(__dirname, '..', 'logs', 'qcc-daemon-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'qcc-daemon-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Memory limit — restart if exceeds 512MB
      max_memory_restart: '512M',

      // Watch (disabled — we manage our own state)
      watch: false,

      // Windows: don't use cluster mode
      exec_mode: 'fork',
      instances: 1,

      // Kill timeout (give Streamlit time to shut down)
      kill_timeout: 10000,
    },
    {
      name: 'qcc-orchestrator',
      script: path.join(__dirname, 'orchestrator.js'),
      cwd: path.join(__dirname, '..'),

      // Environment
      env: {
        NODE_ENV: 'production',
        ORCH_PORT: 3457,
        ORCH_POLL_MS: 60000,      // Node status polling
        ORCH_DISPATCH_MS: 30000,   // Dispatch check
        ORCH_MONITOR_MS: 300000,   // Experiment monitoring
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Logging
      log_file: path.join(__dirname, '..', 'logs', 'orchestrator-pm2.log'),
      error_file: path.join(__dirname, '..', 'logs', 'orchestrator-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'orchestrator-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Memory limit
      max_memory_restart: '256M',

      watch: false,
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 5000,

      // Start after daemon has had time to initialize
      wait_ready: false,
    },
    {
      name: 'alert-router',
      script: path.join(__dirname, '..', 'compute', 'alert_router.js'),
      cwd: path.join(__dirname, '..'),

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Logging
      log_file: path.join(__dirname, '..', 'logs', 'alert-router-pm2.log'),
      error_file: path.join(__dirname, '..', 'logs', 'alert-router-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'alert-router-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Memory limit
      max_memory_restart: '128M',

      watch: false,
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 5000,
    },
    {
      name: 'sleep-orchestrator',
      script: path.join(__dirname, '..', 'compute', 'sleep_orchestrator.js'),
      cwd: path.join(__dirname, '..'),

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Logging
      log_file: path.join(__dirname, '..', 'logs', 'sleep-orchestrator-pm2.log'),
      error_file: path.join(__dirname, '..', 'logs', 'sleep-orchestrator-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'sleep-orchestrator-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Memory limit — lightweight scheduler
      max_memory_restart: '128M',

      watch: false,
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 5000,
    },

    // ── TeleClaude Watchdog (main bridge) ─────────────────────────────────────
    // Manages the Discord/Telegram bridge (index.js) with auto-restart.
    // Runs hidden via PM2 — NO visible CMD windows.
    // Previously started via "npm start" from Explorer (caused visible CMD popup).
    {
      name: 'teleclaude-bridge',
      script: path.join(__dirname, '..', 'watchdog.js'),
      cwd: path.join(__dirname, '..'),

      env: {
        NODE_ENV: 'production',
        TELECLAUDE_WATCHDOG: '1',
      },

      // Restart policy
      autorestart: true,
      max_restarts: 50,
      min_uptime: '20s',
      restart_delay: 3000,

      // Logging
      log_file: path.join(__dirname, '..', 'logs', 'teleclaude-bridge-pm2.log'),
      error_file: path.join(__dirname, '..', 'logs', 'teleclaude-bridge-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'teleclaude-bridge-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      max_memory_restart: '512M',

      watch: false,
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 15000,
    }
  ]
};
