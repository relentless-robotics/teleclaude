/**
 * PM2 Ecosystem Configuration for Auto-Dispatch
 *
 * Usage:
 *   pm2 start compute/auto_dispatch.ecosystem.js
 *   pm2 stop auto-dispatch
 *   pm2 restart auto-dispatch
 *   pm2 logs auto-dispatch
 *   pm2 save          # persist across reboots
 *
 * CLI utilities (run directly, not via PM2):
 *   node compute/auto_dispatch.js --status                              # Show state + queues
 *   node compute/auto_dispatch.js --enqueue --node neptune --command "python train.py" --desc "WF fold 74+" --priority 3
 *   node compute/auto_dispatch.js --drain --node uranus                 # Clear queue
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'auto-dispatch',
      script: path.join(__dirname, 'auto_dispatch.js'),
      cwd: path.join(__dirname, '..'),

      // Environment
      env: {
        NODE_ENV: 'production',
        QCC_PORT: 3456,
        AD_POLL_MS: 60000,         // 60s health poll
        AD_CRASH_CONFIRM_MS: 120000, // 2 min crash confirm window
        AD_LOG_TAIL_MS: 90000,     // 90s log check interval
      },

      // Restart policy
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 5000,

      // Logging
      log_file: path.join(__dirname, '..', 'logs', 'auto-dispatch-pm2.log'),
      error_file: path.join(__dirname, '..', 'logs', 'auto-dispatch-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'auto-dispatch-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Memory limit — restart if exceeds 256MB
      max_memory_restart: '256M',

      // No file watching — state is managed internally
      watch: false,

      // Windows: fork mode
      exec_mode: 'fork',
      instances: 1,

      // Graceful shutdown timeout
      kill_timeout: 5000,
    }
  ]
};
