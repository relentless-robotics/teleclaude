/**
 * mlflow_launcher.js — PM2-compatible MLflow server launcher for Neptune (Windows)
 *
 * Spawns MLflow tracking server using Windows Store Python (3.11 with mlflow installed).
 * PM2 can't directly exec Windows Store apps due to path restrictions.
 * This shim spawns MLflow via `python -m mlflow` and keeps PM2 alive.
 *
 * Usage (PM2): pm2 start compute/mlflow_launcher.js --name mlflow-server
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Windows Store Python — has mlflow 3.x. Use python.exe, not mlflow.exe
// (mlflow.exe on Windows sometimes has issues with cwd glob expansion)
const PYTHON_PATHS = [
  'C:/Users/Footb/AppData/Local/Microsoft/WindowsApps/PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0/python.exe',
  'C:/Users/Footb/AppData/Local/Packages/PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0/LocalCache/local-packages/Python311/Scripts/python.exe',
];

const BACKEND_STORE = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\mlflow\\mlflow.db';
const ARTIFACT_ROOT = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\mlflow\\artifacts';
const HOST = '0.0.0.0';
const PORT = '5000';
const CWD  = 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main';

function ensureDirs() {
  const dirs = [
    path.dirname(BACKEND_STORE),
    ARTIFACT_ROOT,
  ];
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function startMlflow() {
  ensureDirs();

  const backendUri = `sqlite:///${BACKEND_STORE}`;

  // Always use python -m mlflow (avoids mlflow.exe glob expansion bug on Windows)
  // NOTE: spawn() does NOT use shell glob expansion, so quoting is fine here.
  // MLflow 3.x requires explicit host list — 'all' and '*' are not valid values.
  // List all IPs that need access: localhost, LAN (192.168.0.x), Tailscale (100.x.x.x).
  // MLflow 3.x validates the full Host header including port (e.g. "localhost:5000").
  // Must include both bare hostname AND hostname:port variants.
  const ALLOWED_HOSTS = [
    'localhost',
    'localhost:5000',
    'localhost:5001',
    '127.0.0.1',
    '127.0.0.1:5000',
    '127.0.0.1:5001',
    '0.0.0.0',
    '0.0.0.0:5000',
    '192.168.0.101',         // Neptune LAN
    '192.168.0.101:5000',
    '192.168.0.108',         // Jupiter LAN
    '10.0.0.2',              // Saturn
    '100.109.245.73',        // Neptune Tailscale
    '100.109.245.73:5000',
    '100.109.245.73:5001',
    '100.71.253.30',         // Jupiter Tailscale
    '100.101.101.9',         // Saturn Tailscale
    '100.100.83.37',         // Uranus Tailscale
    '100.102.215.75',        // Razer Tailscale
  ].join(',');

  const exe  = 'python';
  const args = [
    '-m', 'mlflow', 'server',
    '--backend-store-uri', backendUri,
    '--default-artifact-root', ARTIFACT_ROOT,
    '--host', HOST,
    '--port', PORT,
    '--workers', '2',
    '--allowed-hosts', ALLOWED_HOSTS,
  ];

  const env = {
    ...process.env,
    MLFLOW_SERVER_ALLOWED_HOSTS: ALLOWED_HOSTS,
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
  };

  console.log(`[mlflow_launcher] Starting MLflow on ${HOST}:${PORT}`);
  console.log(`[mlflow_launcher] Backend: ${backendUri}`);
  console.log(`[mlflow_launcher] Artifacts: ${ARTIFACT_ROOT}`);

  const proc = spawn(exe, args, {
    cwd: CWD,
    env,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  proc.on('exit', (code, signal) => {
    console.error(`[mlflow_launcher] MLflow exited code=${code} signal=${signal}`);
    process.exit(code || 1);
  });

  proc.on('error', (e) => {
    console.error(`[mlflow_launcher] Spawn error: ${e.message}`);
    process.exit(1);
  });

  console.log(`[mlflow_launcher] MLflow PID: ${proc.pid}`);
}

startMlflow();
