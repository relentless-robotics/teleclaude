/**
 * PM2 Ecosystem for Queue Watcher
 *
 * Usage:
 *   pm2 start compute/queue_watcher.ecosystem.js
 *   pm2 stop  queue-watcher
 *   pm2 restart queue-watcher
 *   pm2 logs  queue-watcher
 *   pm2 save
 *
 * CLI utilities (run directly without PM2):
 *   node compute/queue_watcher.js --status
 *   node compute/queue_watcher.js --add --node jupiter --name hold_time --cmd "python3 scripts/hold_opt.py" --priority 2
 *   node compute/queue_watcher.js --complete --node razer --id job_abc123_xyz --result "IC=0.17, Sortino=2.4"
 *   node compute/queue_watcher.js --fail     --node razer --id job_abc123_xyz --error "OOM at fold 12"
 *   node compute/queue_watcher.js --retry    --node razer --id job_abc123_xyz
 *   node compute/queue_watcher.js --drain    --node saturn
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name:   'queue-watcher',
      script: path.join(__dirname, 'queue_watcher.js'),
      cwd:    path.join(__dirname, '..'),

      env: {
        NODE_ENV:     'production',
        QCC_PORT:     3456,
        QW_POLL_MS:   60000,   // 60s poll interval
        QW_LOW_DEPTH: 5,       // Alert when queue < 5 items
        QW_LAUNCH_MS: 60000,   // 60s launch timeout
      },

      autorestart:    true,
      max_restarts:   20,
      min_uptime:     '10s',
      restart_delay:  5000,

      log_file:       path.join(__dirname, '..', 'logs', 'queue-watcher-pm2.log'),
      error_file:     path.join(__dirname, '..', 'logs', 'queue-watcher-error.log'),
      out_file:       path.join(__dirname, '..', 'logs', 'queue-watcher-out.log'),
      merge_logs:     true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      max_memory_restart: '128M',
      watch:          false,
      exec_mode:      'fork',
      instances:      1,
      kill_timeout:   5000,
    }
  ]
};
