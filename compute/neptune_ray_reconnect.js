/**
 * neptune_ray_reconnect.js — Reconnect Neptune to Ray cluster
 * Uses windowsHide:true to avoid visible CMD windows.
 * Run: node compute/neptune_ray_reconnect.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

const RAY_HEAD = '192.168.0.108:6379';
// IMPORTANT: Must use the ray that matches the cluster version (2.54.1 / Python 3.11).
// The Windows Store Python path (Packages/...) has ray 2.54.1 matching the cluster.
// The Programs/Python311 path has ray 2.49.0 — DO NOT use that one.
const RAY_EXE_PATHS = [
  'C:/Users/Footb/AppData/Local/Packages/PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0/LocalCache/local-packages/Python311/Scripts/ray.exe',
  'C:/Users/Footb/AppData/Local/Programs/Python/Python311/Scripts/ray.exe',  // 2.49.0 fallback — may fail version check
];

const env = {
  ...process.env,
  RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER: '1',
  RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL: 'minor',
};

function runRay(rayExe, args) {
  return new Promise((resolve) => {
    const proc = spawn(rayExe, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout?.on('data', d => { out += d.toString(); });
    proc.stderr?.on('data', d => { out += d.toString(); });
    proc.on('exit', code => resolve({ code, out }));
    proc.on('error', e => resolve({ code: -1, out: e.message }));
    setTimeout(() => { proc.kill(); resolve({ code: -1, out: out + ' [timeout]' }); }, 90_000);
  });
}

async function main() {
  let rayExe = null;
  for (const p of RAY_EXE_PATHS) {
    if (fs.existsSync(p)) { rayExe = p; break; }
  }
  if (!rayExe) { console.error('ray.exe not found at expected paths'); process.exit(1); }
  console.log('Using ray:', rayExe);

  console.log('Stopping existing Ray workers...');
  const stop = await runRay(rayExe, ['stop', '--force']);
  console.log('Stop result:', stop.out.slice(-150) || '(no output)');

  await new Promise(r => setTimeout(r, 3000));

  console.log('Starting Ray worker...');
  const start = await runRay(rayExe, ['start', `--address=${RAY_HEAD}`, '--num-gpus=1']);
  console.log('Start result:', start.out.slice(-400) || '(no output)');
  console.log('Exit code:', start.code);

  if (start.out.includes('Ray runtime started') || start.out.includes('already running')) {
    console.log('SUCCESS - Neptune reconnected to Ray cluster');
    process.exit(0);
  } else {
    console.log('WARNING - Could not confirm Ray runtime started');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
