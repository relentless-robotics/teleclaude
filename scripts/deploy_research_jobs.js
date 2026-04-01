#!/usr/bin/env node
/**
 * deploy_research_jobs.js
 *
 * Deploys 4 research jobs to Jupiter and Saturn:
 *   Jupiter:
 *     1. orderflow_features.py  — volume profile, footprint delta, large order detection
 *     2. monte_carlo_top5.py    — 1000-path MC on top 5 fill sim configs
 *   Saturn:
 *     1. tod_deep_analysis.py   — 30-min bucket + day-of-week breakdown
 *     2. queue_tpsl_sweep.py    — queue position x TP/SL interaction sweep
 *
 * Uses Jupiter Flask API (192.168.0.108:8765) and QCC SSH for Saturn (localhost:3456).
 * All communication via Node.js http module. No visible windows on Neptune.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const JUPITER_HOST    = '192.168.0.108';
const JUPITER_PORT    = 8765;
const JUPITER_API_KEY = 'qcc_node_api_2026';

const QCC_HOST = 'localhost';
const QCC_PORT = 3456;

const SCRIPTS_DIR = path.join(__dirname);

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function jupiterExec(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command, timeout: Math.floor(timeoutMs / 1000) });
    const options = {
      hostname: JUPITER_HOST,
      port:     JUPITER_PORT,
      path:     '/exec',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key':      JUPITER_API_KEY,
      },
      timeout: timeoutMs + 5000,
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try   { resolve(JSON.parse(raw)); }
        catch { resolve({ stdout: raw, stderr: '', exitCode: 0 }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Jupiter request timed out')); });
    req.write(body);
    req.end();
  });
}

function qccSshExec(node, command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ node, command, timeout: Math.floor(timeoutMs / 1000) });
    const options = {
      hostname: QCC_HOST,
      port:     QCC_PORT,
      path:     '/api/ssh/exec',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs + 5000,
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try   { resolve(JSON.parse(raw)); }
        catch { resolve({ stdout: raw, stderr: '', exitCode: 0 }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('QCC SSH request timed out')); });
    req.write(body);
    req.end();
  });
}

// Upload a local file to a remote path using base64 over Python one-liner.
function uploadToJupiter(localPath, remotePath) {
  const content = fs.readFileSync(localPath);
  const b64     = content.toString('base64');
  const cmd     = 'python3 -c "import base64,os; d=base64.b64decode(\'' + b64 + '\'); ' +
                  'os.makedirs(os.path.dirname(\'' + remotePath + '\'), exist_ok=True); ' +
                  'open(\'' + remotePath + '\',\'wb\').write(d); ' +
                  'print(\'uploaded:' + remotePath + '\')"';
  return jupiterExec(cmd, 30000);
}

function uploadToSaturn(localPath, remotePath) {
  const content = fs.readFileSync(localPath);
  const b64     = content.toString('base64');
  const cmd     = 'python3 -c "import base64,os; d=base64.b64decode(\'' + b64 + '\'); ' +
                  'os.makedirs(os.path.dirname(\'' + remotePath + '\'), exist_ok=True); ' +
                  'open(\'' + remotePath + '\',\'wb\').write(d); ' +
                  'print(\'uploaded:' + remotePath + '\')"';
  return qccSshExec('saturn', cmd, 30000);
}

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function outputOf(res) {
  return (res.stdout || res.output || '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Research Job Deployment ===');
  log('Jupiter: ' + JUPITER_HOST + ':' + JUPITER_PORT + ' | QCC Saturn: ' + QCC_HOST + ':' + QCC_PORT);

  // ── Step 1: Probe Jupiter ─────────────────────────────────────────────────
  log('\n--- Step 1: Probe Jupiter ---');
  let jupiterAlive = false;
  try {
    const probe = await jupiterExec('echo ALIVE && nproc && free -h | grep Mem | head -1', 10000);
    if (outputOf(probe).includes('ALIVE')) {
      jupiterAlive = true;
      log('Jupiter OK: ' + outputOf(probe).split('\n').join(' | '));
    } else {
      log('Jupiter probe response: ' + JSON.stringify(probe).substring(0, 200));
    }
  } catch (e) {
    log('Jupiter probe error: ' + e.message);
  }

  if (jupiterAlive) {
    // Data inventory
    const dataProbe = await jupiterExec(
      'ls /home/jupiter/Lvl3Quant/data/ 2>/dev/null && echo "---" && ' +
      'ls /home/jupiter/Lvl3Quant/data/processed/ 2>/dev/null | head -25 && echo "---" && ' +
      'echo "tensor_files:" && ls /home/jupiter/Lvl3Quant/data/processed/dl_book_cache_oot/ 2>/dev/null | wc -l && ' +
      'echo "conv_sweep:" && ls /home/jupiter/Lvl3Quant/data/processed/conviction_threshold_sweep/ 2>/dev/null',
      20000
    );
    log('Jupiter data inventory:\n' + outputOf(dataProbe).substring(0, 600));

    // ── Step 2: Orderflow features ─────────────────────────────────────────
    log('\n--- Step 2: Upload + launch orderflow_features.py ---');
    const localOF = path.join(SCRIPTS_DIR, 'orderflow_features.py');
    const remoteOF = '/home/jupiter/Lvl3Quant/scripts/orderflow_features.py';
    const upOF = await uploadToJupiter(localOF, remoteOF);
    log('Upload orderflow: ' + outputOf(upOF).substring(0, 150));
    if (upOF.exitCode !== 0 && upOF.stderr) {
      log('Upload stderr: ' + (upOF.stderr || '').substring(0, 150));
    }

    await jupiterExec('mkdir -p /home/jupiter/Lvl3Quant/data/processed/orderflow_features /home/jupiter/Lvl3Quant/logs', 10000);
    await jupiterExec('tmux kill-session -t orderflow 2>/dev/null; true', 5000);
    const launchOF = await jupiterExec(
      'tmux new-session -d -s orderflow "cd /home/jupiter/Lvl3Quant && python3 scripts/orderflow_features.py 2>&1 | tee logs/orderflow_features.log; echo EXIT_CODE:$?" && echo LAUNCHED',
      15000
    );
    log('Orderflow launch: ' + outputOf(launchOF));

    // ── Step 3: Monte Carlo top 5 ──────────────────────────────────────────
    log('\n--- Step 3: Upload + launch monte_carlo_top5.py ---');
    const localMC  = path.join(SCRIPTS_DIR, 'monte_carlo_top5.py');
    const remoteMC = '/home/jupiter/Lvl3Quant/scripts/monte_carlo_top5.py';
    const upMC = await uploadToJupiter(localMC, remoteMC);
    log('Upload MC: ' + outputOf(upMC).substring(0, 150));

    await jupiterExec('mkdir -p /home/jupiter/Lvl3Quant/data/processed/monte_carlo_top5', 10000);
    await jupiterExec('tmux kill-session -t montecarlo 2>/dev/null; true', 5000);
    const launchMC = await jupiterExec(
      'tmux new-session -d -s montecarlo "cd /home/jupiter/Lvl3Quant && python3 scripts/monte_carlo_top5.py 2>&1 | tee logs/monte_carlo_top5.log; echo EXIT_CODE:$?" && echo LAUNCHED',
      15000
    );
    log('Monte Carlo launch: ' + outputOf(launchMC));

    // Wait and tail
    log('\nWaiting 8s for Jupiter initial output...');
    await new Promise(r => setTimeout(r, 8000));

    const tailOF = await jupiterExec('tail -15 /home/jupiter/Lvl3Quant/logs/orderflow_features.log 2>/dev/null || echo "(no output yet)"', 10000);
    log('\n[Jupiter] orderflow_features.log:\n' + outputOf(tailOF));

    const tailMC = await jupiterExec('tail -15 /home/jupiter/Lvl3Quant/logs/monte_carlo_top5.log 2>/dev/null || echo "(no output yet)"', 10000);
    log('\n[Jupiter] monte_carlo_top5.log:\n' + outputOf(tailMC));

    const jSessions = await jupiterExec('tmux ls 2>/dev/null || echo "no sessions"', 5000);
    log('\nJupiter tmux sessions: ' + outputOf(jSessions));
  } else {
    log('SKIPPING Jupiter jobs (unreachable).');
  }

  // ── Step 4: Probe Saturn ──────────────────────────────────────────────────
  log('\n--- Step 4: Probe Saturn via QCC SSH ---');
  let saturnAlive = false;
  try {
    const probe = await qccSshExec('saturn', 'echo ALIVE && nproc && free -h | grep Mem | head -1', 15000);
    const out = outputOf(probe);
    if (out.includes('ALIVE')) {
      saturnAlive = true;
      log('Saturn OK: ' + out.split('\n').join(' | '));
    } else {
      log('Saturn probe response: ' + JSON.stringify(probe).substring(0, 300));
    }
  } catch (e) {
    log('Saturn probe error: ' + e.message);
  }

  if (saturnAlive) {
    const satData = await qccSshExec('saturn',
      'ls /home/saturn/Lvl3Quant/data/processed/ 2>/dev/null | head -20 && echo "---" && ' +
      'ls /home/saturn/Lvl3Quant/data/processed/conviction_threshold_sweep/ 2>/dev/null',
      20000
    );
    log('Saturn data layout:\n' + outputOf(satData).substring(0, 400));

    // ── Step 5: ToD deep analysis ────────────────────────────────────────
    log('\n--- Step 5: Upload + launch tod_deep_analysis.py ---');
    const localToD  = path.join(SCRIPTS_DIR, 'tod_deep_analysis.py');
    const remoteToD = '/home/saturn/Lvl3Quant/scripts/tod_deep_analysis.py';

    await qccSshExec('saturn', 'mkdir -p /home/saturn/Lvl3Quant/scripts /home/saturn/Lvl3Quant/data/processed/tod_deep_analysis /home/saturn/Lvl3Quant/logs', 10000);
    const upToD = await uploadToSaturn(localToD, remoteToD);
    log('Upload ToD: ' + outputOf(upToD).substring(0, 150));

    await qccSshExec('saturn', 'tmux kill-session -t tod_deep 2>/dev/null; true', 5000);
    const launchToD = await qccSshExec('saturn',
      'tmux new-session -d -s tod_deep "cd /home/saturn/Lvl3Quant && python3 scripts/tod_deep_analysis.py 2>&1 | tee logs/tod_deep_analysis.log; echo EXIT_CODE:$?" && echo LAUNCHED',
      15000
    );
    log('ToD deep launch: ' + outputOf(launchToD));

    // ── Step 6: Queue x TP/SL sweep ──────────────────────────────────────
    log('\n--- Step 6: Upload + launch queue_tpsl_sweep.py ---');
    const localQT  = path.join(SCRIPTS_DIR, 'queue_tpsl_sweep.py');
    const remoteQT = '/home/saturn/Lvl3Quant/scripts/queue_tpsl_sweep.py';

    await qccSshExec('saturn', 'mkdir -p /home/saturn/Lvl3Quant/data/processed/queue_tpsl_sweep', 10000);
    const upQT = await uploadToSaturn(localQT, remoteQT);
    log('Upload queue_tpsl: ' + outputOf(upQT).substring(0, 150));

    await qccSshExec('saturn', 'tmux kill-session -t queue_tpsl 2>/dev/null; true', 5000);
    const launchQT = await qccSshExec('saturn',
      'tmux new-session -d -s queue_tpsl "cd /home/saturn/Lvl3Quant && python3 scripts/queue_tpsl_sweep.py 2>&1 | tee logs/queue_tpsl_sweep.log; echo EXIT_CODE:$?" && echo LAUNCHED',
      15000
    );
    log('Queue x TP/SL launch: ' + outputOf(launchQT));

    // Wait and tail
    log('\nWaiting 8s for Saturn initial output...');
    await new Promise(r => setTimeout(r, 8000));

    const tailToD = await qccSshExec('saturn', 'tail -15 /home/saturn/Lvl3Quant/logs/tod_deep_analysis.log 2>/dev/null || echo "(no output yet)"', 10000);
    log('\n[Saturn] tod_deep_analysis.log:\n' + outputOf(tailToD));

    const tailQT = await qccSshExec('saturn', 'tail -15 /home/saturn/Lvl3Quant/logs/queue_tpsl_sweep.log 2>/dev/null || echo "(no output yet)"', 10000);
    log('\n[Saturn] queue_tpsl_sweep.log:\n' + outputOf(tailQT));

    const sSessions = await qccSshExec('saturn', 'tmux ls 2>/dev/null || echo "no sessions"', 5000);
    log('\nSaturn tmux sessions: ' + outputOf(sSessions));

  } else {
    log('SKIPPING Saturn jobs (unreachable via QCC SSH).');
  }

  log('\n=== DEPLOYMENT COMPLETE ===');
  if (jupiterAlive) {
    log('  Jupiter orderflow:    tail -f /home/jupiter/Lvl3Quant/logs/orderflow_features.log');
    log('  Jupiter Monte Carlo:  tail -f /home/jupiter/Lvl3Quant/logs/monte_carlo_top5.log');
    log('  Jupiter results:');
    log('    /home/jupiter/Lvl3Quant/data/processed/orderflow_features/summary.json');
    log('    /home/jupiter/Lvl3Quant/data/processed/monte_carlo_top5/monte_carlo_summary.json');
  }
  if (saturnAlive) {
    log('  Saturn ToD:          tail -f /home/saturn/Lvl3Quant/logs/tod_deep_analysis.log');
    log('  Saturn queue sweep:  tail -f /home/saturn/Lvl3Quant/logs/queue_tpsl_sweep.log');
    log('  Saturn results:');
    log('    /home/saturn/Lvl3Quant/data/processed/tod_deep_analysis/tod_deep_summary.json');
    log('    /home/saturn/Lvl3Quant/data/processed/queue_tpsl_sweep/queue_tpsl_sweep_summary.json');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
