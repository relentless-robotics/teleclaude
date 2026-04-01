/**
 * ray_orchestrator_runner.js
 *
 * Thin Node.js wrapper that spawns ray_orchestrator.py as a child process.
 * Needed because PM2 on Windows cannot directly run Windows Store (UWP) Python
 * as an interpreter — but it CAN run a JS file that spawns the Python subprocess.
 *
 * This file is the PM2 entry point for the 'ray-orchestrator' process.
 * The actual orchestration logic lives in ray_orchestrator.py.
 *
 * Usage:
 *   pm2 start compute/ray_orchestrator_runner.js --name ray-orchestrator
 *
 * Environment vars forwarded to the Python process:
 *   NODE_API_KEY, MLFLOW_TRACKING_URI, PYTHONUTF8, PYTHONIOENCODING,
 *   DISCORD_WEBHOOK
 */

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');

const ROOT        = path.join(__dirname, '..');
const SCRIPT      = path.join(__dirname, 'ray_orchestrator.py');

// Find python3 — try a few common Windows locations
const PYTHON_CANDIDATES = [
  'python3',
  'python',
  'C:\\Python311\\python.exe',
  'C:\\Python310\\python.exe',
  'C:\\Users\\Footb\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
];

function findPython() {
  const { execSync } = require('child_process');
  // Ask the shell which python resolves to
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      const out = execSync(`${candidate} --version`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (out.trim().startsWith('Python')) {
        return candidate;
      }
    } catch (_) {
      // try next
    }
  }
  return null;
}

function start() {
  const python = findPython();
  if (!python) {
    console.error('[ray-orchestrator-runner] ERROR: No Python found in PATH. Install Python 3.10+');
    process.exit(1);
  }

  console.log(`[ray-orchestrator-runner] Launching: ${python} ${SCRIPT}`);
  console.log(`[ray-orchestrator-runner] MLFLOW_TRACKING_URI=${process.env.MLFLOW_TRACKING_URI || 'http://100.109.245.73:5000'}`);

  const env = {
    ...process.env,
    PYTHONUTF8:          '1',
    PYTHONIOENCODING:    'utf-8',
    MLFLOW_TRACKING_URI: process.env.MLFLOW_TRACKING_URI || 'http://100.109.245.73:5000',
    NODE_API_KEY:        process.env.NODE_API_KEY        || 'qcc_node_api_2026',
  };

  const child = spawn(python, [SCRIPT], {
    cwd:   ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));

  child.on('exit', (code, signal) => {
    console.log(`[ray-orchestrator-runner] Python process exited (code=${code} signal=${signal})`);
    // Exit with the same code so PM2 can restart if needed
    process.exit(code || 0);
  });

  child.on('error', err => {
    console.error(`[ray-orchestrator-runner] Spawn error: ${err.message}`);
    process.exit(1);
  });

  // Forward SIGTERM/SIGINT to the child
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT',  () => child.kill('SIGINT'));
}

start();
