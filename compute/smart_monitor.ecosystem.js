/**
 * PM2 Ecosystem Config — Smart Monitor
 *
 * Usage:
 *   pm2 start compute/smart_monitor.ecosystem.js
 *   pm2 save
 *
 * Single-shot check: node compute/smart_monitor.js
 * Status view:       node compute/smart_monitor.js --status
 * Logs:              pm2 logs smart-monitor
 */

module.exports = {
  apps: [
    {
      name:         'smart-monitor',
      script:       'compute/smart_monitor.js',
      args:         '--daemon',
      cwd:          'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main',
      interpreter:  'node',
      autorestart:  true,
      watch:        false,
      max_restarts: 20,
      restart_delay: 10000,
      env: {
        NODE_ENV:             'production',
        QCC_PORT:             '3456',
        MLFLOW_TRACKING_URI:  'http://localhost:5000',
        // Tunable thresholds (override here or via environment)
        SM_POLL_MS:           '300000',   // 5 minutes
        SM_WINDOW_SIZE:       '5',        // 5 samples = 25 minutes
        SM_GPU_IDLE:          '5',        // % threshold
        SM_POWER_DEAD:        '50',       // Watts — below this = truly idle (not loading)
        SM_LOG_STALE:         '30',       // minutes
        SM_ALERT_COOLDOWN:    '1800000',  // 30 minutes between repeat alerts
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\compute\\smart_monitor_err.log',
      out_file:   'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\compute\\smart_monitor_out.log',
    },
  ],
};
