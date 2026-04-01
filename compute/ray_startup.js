/**
 * ray_startup.js — Ensure Ray cluster is running on boot.
 *
 * Architecture (updated 2026-03-29):
 *   - Jupiter (192.168.0.108): HEAD node — conda ray311 env (Python 3.11)
 *   - Neptune (this PC):       Worker   — Windows, RTX 3090 GPU
 *   - Saturn  (10.0.0.2):     Worker   — Linux, CPU (conda ray311 env)
 *   - Uranus  (100.100.83.37): Worker  — Windows, RTX 5090 GPU [Tailscale]
 *   - Razer   (100.102.215.75): Worker — Windows, RTX 3070 GPU [Tailscale]
 *
 * Env vars required on Windows nodes:
 *   RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1
 *   RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor
 *
 * Usage:
 *   pm2 start compute/ray_startup.js --name ray-startup --no-autorestart
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const { NodeAPI } = require('./node_api_client');

const API_KEY       = process.env.NODE_API_KEY || 'qcc_node_api_2026';
const RAY_HEAD_IP   = '192.168.0.108';
const RAY_HEAD_PORT = 6379;

// Conda-based ray binaries (Python 3.11)
const JUPITER_RAY = '/home/jupiter/miniconda3/envs/ray311/bin/ray';
const SATURN_RAY  = '/home/saturn/miniconda3/envs/ray311/bin/ray';

const VERSION_ENV = 'RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function checkRayRunning() {
  try {
    const res = await fetch(`http://${RAY_HEAD_IP}:8265/nodes?view=summary`);
    const data = await res.json();
    const nodes = data?.data?.summary || [];
    return nodes.length > 0;
  } catch {
    return false;
  }
}

async function startJupiterHead(jupiter) {
  console.log('[ray_startup] Starting Ray HEAD on Jupiter (conda ray311)...');
  const r = await jupiter.exec(
    `${JUPITER_RAY} stop --force 2>&1 || true; rm -rf /tmp/ray/ 2>/dev/null; sleep 1; ` +
    `${VERSION_ENV} ${JUPITER_RAY} start --head --port=${RAY_HEAD_PORT} ` +
    `--dashboard-host=0.0.0.0 --dashboard-port=8265 ` +
    `--node-name=jupiter-head 2>&1`,
    { timeout: 60 }
  );
  if (r.stdout?.includes('Ray runtime started')) {
    console.log('[ray_startup] Jupiter HEAD started');
    return true;
  }
  console.error('[ray_startup] Jupiter HEAD failed:', r.stdout?.slice(-300));
  return false;
}

async function connectSaturnWorker(jupiter) {
  console.log('[ray_startup] Connecting Saturn worker (conda ray311)...');
  const r = await jupiter.exec(
    `ssh -o StrictHostKeyChecking=no saturn@10.0.0.2 ` +
    `'${SATURN_RAY} stop --force 2>&1 || true; rm -rf /tmp/ray/ 2>/dev/null; sleep 1; ` +
    `${VERSION_ENV} ${SATURN_RAY} start --address=${RAY_HEAD_IP}:${RAY_HEAD_PORT} ` +
    `--node-name=saturn-worker 2>&1'`,
    { timeout: 90 }
  );
  if (r.stdout?.includes('Ray runtime started')) {
    console.log('[ray_startup] Saturn worker connected');
    return true;
  }
  console.warn('[ray_startup] Saturn failed:', r.stdout?.slice(-200));
  return false;
}

function connectNeptuneWorker() {
  console.log('[ray_startup] Connecting Neptune Windows worker...');
  const env = { ...process.env,
    RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER: '1',
    RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL: 'minor',
  };

  const r = spawnSync('python', [
    '-m', 'ray.scripts.scripts', 'start',
    `--address=${RAY_HEAD_IP}:${RAY_HEAD_PORT}`,
    '--node-name=neptune-win',
    '--num-gpus=1',
    '--resources={"GPU_RTX3090": 1}',
  ], { encoding: 'utf8', timeout: 60000, env, windowsHide: true });

  if (r.stdout?.includes('Ray runtime started')) {
    console.log('[ray_startup] Neptune worker connected (GPU=1)');
    return true;
  }
  console.warn('[ray_startup] Neptune failed:', (r.stderr || r.stdout)?.slice(-200));
  return false;
}

async function connectTailscaleWorker(name, ip, rayBin, gpuArgs) {
  console.log(`[ray_startup] Connecting ${name} worker (Tailscale)...`);
  const client = new NodeAPI(ip, 8765, API_KEY, { defaultTimeout: 90000 });

  // Check reachability
  try {
    await client.health();
  } catch (e) {
    console.warn(`[ray_startup] ${name} unreachable: ${e.message}`);
    return false;
  }

  // Check if it can reach Jupiter
  try {
    const ping = await client.exec(`ping -n 1 -w 3000 ${RAY_HEAD_IP} 2>&1`, { timeout: 10 });
    if (!ping.stdout?.includes('TTL=') && !ping.stdout?.includes('bytes from')) {
      console.warn(`[ray_startup] ${name} cannot reach Jupiter (${RAY_HEAD_IP}). Enable Tailscale on Jupiter.`);
      return false;
    }
  } catch (e) {
    console.warn(`[ray_startup] ${name} ping check failed: ${e.message}`);
    return false;
  }

  const cmd =
    `set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1&& ` +
    `set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor&& ` +
    `${rayBin} start ` +
    `--address=${RAY_HEAD_IP}:${RAY_HEAD_PORT} ` +
    `--node-name=${name}-win ${gpuArgs}`;

  try {
    const r = await client.exec(cmd, { timeout: 90 });
    if (r.stdout?.includes('Ray runtime started')) {
      console.log(`[ray_startup] ${name} worker connected`);
      return true;
    }
    console.warn(`[ray_startup] ${name} failed:`, r.stdout?.slice(-200));
    return false;
  } catch (e) {
    console.warn(`[ray_startup] ${name} error: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('[ray_startup] Checking if Ray cluster is already running...');

  const alreadyUp = await checkRayRunning();
  if (alreadyUp) {
    console.log('[ray_startup] Ray cluster already running.');
    console.log(`[ray_startup] Dashboard: http://${RAY_HEAD_IP}:8265`);
    process.exit(0);
  }

  console.log('[ray_startup] Ray not running. Starting cluster...');
  await sleep(3000);

  const jupiter = new NodeAPI(RAY_HEAD_IP, 8765, API_KEY, { defaultTimeout: 90000 });

  // 1. Check Jupiter reachable
  try {
    const health = await jupiter.health();
    console.log(`[ray_startup] Jupiter health: ${health.status} (${health.hostname})`);
  } catch (e) {
    console.error(`[ray_startup] Jupiter not reachable: ${e.message}`);
    process.exit(1);
  }

  // 2. Start HEAD
  if (!await startJupiterHead(jupiter)) {
    console.error('[ray_startup] Failed to start Ray head.');
    process.exit(1);
  }
  await sleep(3000);

  // 3. LAN workers
  connectNeptuneWorker();
  await connectSaturnWorker(jupiter);

  // 4. Tailscale workers (may fail if Jupiter lacks Tailscale)
  await connectTailscaleWorker('uranus', '100.100.83.37',
    'python -m ray.scripts.scripts', '--num-gpus=1 --resources={"GPU_RTX5090": 1}');
  await connectTailscaleWorker('razer', '100.102.215.75',
    'C:\\Python311\\python.exe -m ray.scripts.scripts', '--num-gpus=1 --resources={"GPU_RTX3070": 1}');

  await sleep(3000);

  // 5. Report status
  console.log('[ray_startup] Checking final cluster status...');
  try {
    const res = await fetch(`http://${RAY_HEAD_IP}:8265/nodes?view=summary`);
    const data = await res.json();
    const nodes = data?.data?.summary || [];
    console.log(`[ray_startup] Cluster: ${nodes.length} nodes`);
    for (const n of nodes) {
      const r = n.raylet?.resourcesTotal || {};
      console.log(`  ${n.hostname} IP=${n.ip} CPU=${r.CPU || 0} GPU=${r.GPU || 0} state=${n.raylet?.state}`);
    }
    console.log(`[ray_startup] Dashboard: http://${RAY_HEAD_IP}:8265`);
  } catch (e) {
    console.error(`[ray_startup] Could not verify cluster: ${e.message}`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('[ray_startup] Fatal:', e.message);
  process.exit(1);
});
