/**
 * PM2 Ecosystem Configuration for Node Researchers
 *
 * One researcher process per compute node. Each monitors its node independently,
 * detects crashes, launches jobs, and reports to Discord.
 *
 * Usage:
 *   pm2 start compute/researcher.ecosystem.js       # Start all researchers
 *   pm2 stop researcher-neptune                      # Stop one
 *   pm2 restart researcher-uranus                    # Restart one
 *   pm2 logs researcher-razer                        # View logs
 *   pm2 save                                         # Persist across reboots
 *
 * Status CLI (direct, not PM2):
 *   node compute/node_researcher.js --node neptune --status
 *
 * Enqueue a job:
 *   node compute/node_researcher.js --node uranus --enqueue --command "python train.py" --desc "My experiment" --priority 2
 */

const path = require('path');

const SCRIPT = path.join(__dirname, 'node_researcher.js');
const CWD = path.join(__dirname, '..');
const LOG_DIR = path.join(__dirname, '..', 'logs');

function makeApp(nodeName) {
  return {
    name: `researcher-${nodeName}`,
    script: SCRIPT,
    args: `--node ${nodeName}`,
    cwd: CWD,

    // Environment
    env: {
      NODE_ENV: 'production',
      QCC_PORT: 3456,
    },

    // Restart policy — resilient, always come back
    autorestart: true,
    max_restarts: 50,
    min_uptime: '10s',
    restart_delay: 10000,   // 10s between restarts

    // Logging
    log_file: path.join(LOG_DIR, `researcher-${nodeName}-pm2.log`),
    error_file: path.join(LOG_DIR, `researcher-${nodeName}-error.log`),
    out_file: path.join(LOG_DIR, `researcher-${nodeName}-out.log`),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

    // Memory limit — restart if exceeds 128MB
    max_memory_restart: '128M',

    // No file watching
    watch: false,

    // Windows: fork mode
    exec_mode: 'fork',
    instances: 1,

    // Graceful shutdown
    kill_timeout: 5000,
  };
}

module.exports = {
  apps: [
    makeApp('neptune'),
    makeApp('uranus'),
    makeApp('razer'),
    makeApp('jupiter'),
    makeApp('saturn'),
  ]
};
