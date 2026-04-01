/**
 * PM2 Ecosystem Config — MLflow Tracking Server
 *
 * Usage:
 *   pm2 start compute/mlflow.ecosystem.js
 *   pm2 save
 *
 * Dashboard: http://localhost:5000
 * Logs:      pm2 logs mlflow-server
 */

module.exports = {
  apps: [
    {
      name: 'mlflow-server',
      script: 'python',
      args: 'scripts/start_mlflow.py',
      cwd: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        MLFLOW_TRACKING_URI: 'http://localhost:5000',
        MLFLOW_SERVER_ALLOWED_HOSTS: '*',
        PYTHONUNBUFFERED: '1',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\mlflow\\mlflow_err.log',
      out_file:   'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\mlflow\\mlflow_out.log',
    },
    {
      // Proxy that rewrites Host header to 'localhost' so Tailscale IPs (100.x.x.x) can reach MLflow.
      // Uranus training connects to http://100.109.245.73:5001 which forwards to localhost:5000.
      // Without this, MLflow rejects external IPs with "Invalid Host header - DNS rebinding attack".
      name: 'mlflow-proxy',
      script: 'python',
      args: 'scripts/mlflow_proxy.py',
      cwd: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 2000,
      env: {
        PYTHONUNBUFFERED: '1',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\mlflow\\mlflow_proxy_err.log',
      out_file:   'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\mlflow\\mlflow_proxy_out.log',
    },
  ],
};
