#!/usr/bin/env node
/**
 * launch_alpha_capture.js
 *
 * Transfers alpha_capture_sweep.py to Jupiter via Jupiter Flask API,
 * then launches it in a tmux session.
 *
 * API: POST http://192.168.0.108:8765/exec   X-API-Key: qcc_node_api_2026
 *      body: { "command": "..." }            response: { stdout, stderr, exit_code }
 *
 * Queue position gate flag: --min-queue-pos (not --min-queue-position)
 *
 * Uses Node.js http module ONLY — no visible windows.
 *
 * Usage:
 *   node scripts/launch_alpha_capture.js [--status] [--tail] [--kill]
 *
 *   (no args)  — transfer script + launch sweep in tmux
 *   --status   — check if sweep is running, show tail of log
 *   --tail     — tail the live log
 *   --kill     — kill the sweep session
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Jupiter Flask API ────────────────────────────────────────────────────────

const JUPITER_HOST = '192.168.0.108';
const JUPITER_PORT = 8765;
const JUPITER_KEY  = 'qcc_node_api_2026';

const TMUX_SESSION = 'alpha_capture';
const REMOTE_SCRIPT = '/home/jupiter/Lvl3Quant/scripts/alpha_capture_sweep.py';
const REMOTE_LOG    = '/home/jupiter/Lvl3Quant/data/processed/alpha_capture_sweep/sweep.log';
const SUMMARY_JSON  = '/home/jupiter/Lvl3Quant/data/processed/alpha_capture_sweep/summary.json';
const REPORT_TXT    = '/home/jupiter/Lvl3Quant/data/processed/alpha_capture_sweep/alpha_capture_report.txt';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function jupiterExec(command, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command });
    const req  = http.request(
      {
        host:    JUPITER_HOST,
        port:    JUPITER_PORT,
        path:    '/exec',
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-API-Key':      JUPITER_KEY,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', d => (raw += d));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { resolve({ stdout: raw, stderr: '', exit_code: -1 }); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Jupiter API timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ── Transfer script via base64 chunks ─────────────────────────────────────────

async function transferScript(localPath, remotePath) {
  const src  = fs.readFileSync(localPath, 'utf-8');
  const b64  = Buffer.from(src).toString('base64');
  const tmp  = remotePath + '.b64.tmp';
  const CHUNK = 3000;   // safe for shell command line limits
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    chunks.push(b64.slice(i, i + CHUNK));
  }

  log(`Script: ${src.length} chars  →  b64: ${b64.length} chars  →  ${chunks.length} chunks`);

  // Write first chunk (overwrite)
  let r = await jupiterExec(`printf '%s' '${chunks[0]}' > ${tmp} && echo C0_OK`);
  if (r.exit_code !== 0) throw new Error(`Chunk 0 failed: ${r.stderr}`);
  log('Chunk 0 written');

  // Append remaining chunks
  for (let i = 1; i < chunks.length; i++) {
    r = await jupiterExec(`printf '%s' '${chunks[i]}' >> ${tmp} && echo C${i}_OK`);
    if (r.exit_code !== 0) throw new Error(`Chunk ${i} failed: ${r.stderr}`);
    if (i % 5 === 0 || i === chunks.length - 1) {
      log(`  Chunk ${i}/${chunks.length - 1} written`);
    }
  }

  // Decode
  const decCmd = `python3 -c "import base64; open('${remotePath}','wb').write(base64.b64decode(open('${tmp}').read().strip()))" && rm ${tmp} && echo DECODE_OK`;
  r = await jupiterExec(decCmd, 30_000);
  if (r.exit_code !== 0 || !r.stdout.includes('DECODE_OK')) {
    throw new Error(`Decode failed: ${r.stderr || r.stdout}`);
  }
  log(`Script decoded to ${remotePath}`);

  // Syntax check
  r = await jupiterExec(`python3 -c "import ast; ast.parse(open('${remotePath}').read()); print('SYNTAX_OK')"`, 15_000);
  if (!r.stdout.includes('SYNTAX_OK')) {
    throw new Error(`Syntax error: ${r.stderr || r.stdout}`);
  }
  log('Syntax OK');
}

// ── Main actions ──────────────────────────────────────────────────────────────

async function checkStatus() {
  log('=== Status check ===');

  // tmux alive?
  const ts = await jupiterExec(`tmux list-sessions 2>&1`);
  const running = ts.stdout.includes(TMUX_SESSION);
  log(`tmux session '${TMUX_SESSION}': ${running ? 'RUNNING' : 'NOT RUNNING'}`);

  // Process alive?
  const ps = await jupiterExec(`ps aux | grep alpha_capture_sweep | grep -v grep | head -3`);
  if (ps.stdout.trim()) {
    log(`Process: ${ps.stdout.trim().split('\n')[0]}`);
  } else {
    log('Process: not found in ps');
  }

  // Tail log
  const tail = await jupiterExec(`tail -30 ${REMOTE_LOG} 2>/dev/null || echo "(log not yet created)"`);
  log('=== Last 30 log lines ===');
  console.log(tail.stdout || '(empty)');

  // Summary if exists
  const sum = await jupiterExec(`test -f ${SUMMARY_JSON} && echo EXISTS || echo MISSING`);
  if (sum.stdout.includes('EXISTS')) {
    const rpt = await jupiterExec(`cat ${REPORT_TXT} 2>/dev/null | tail -60`);
    log('=== Report (tail) ===');
    console.log(rpt.stdout || '(empty)');
  } else {
    log('Summary not yet generated (sweep still running)');
  }
}

async function tailLog() {
  log(`Tailing ${REMOTE_LOG} (Ctrl+C to stop)...`);
  log('Note: polling every 10s (no live tail over HTTP API)');
  let lastLines = 0;
  while (true) {
    const r = await jupiterExec(`wc -l ${REMOTE_LOG} 2>/dev/null | awk '{print $1}'`);
    const currentLines = parseInt(r.stdout.trim(), 10) || 0;
    if (currentLines > lastLines) {
      const delta = currentLines - lastLines;
      const tail  = await jupiterExec(
        `tail -${Math.min(delta + 5, 50)} ${REMOTE_LOG} 2>/dev/null`
      );
      console.log(tail.stdout);
      lastLines = currentLines;
    }
    await new Promise(res => setTimeout(res, 10_000));
  }
}

async function killSweep() {
  log(`Killing tmux session '${TMUX_SESSION}'...`);
  const r = await jupiterExec(`tmux kill-session -t ${TMUX_SESSION} 2>&1; echo DONE`);
  log(r.stdout.trim());
}

async function launch() {
  // ── 1. Verify fill_sim_cli exists on Jupiter ────────────────────────────
  log('Verifying fill_sim_cli on Jupiter...');
  const fsCheck = await jupiterExec(
    'test -f /home/jupiter/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli && echo OK || echo MISSING'
  );
  if (fsCheck.stdout.includes('MISSING')) {
    log('ERROR: fill_sim_cli not found on Jupiter. Build it first.');
    process.exit(1);
  }
  log('fill_sim_cli: OK');

  // ── 2. Verify pred/MBO data ─────────────────────────────────────────────
  log('Checking OOS WF predictions and MBO data...');
  const dataCheck = await jupiterExec(
    'ls /home/jupiter/Lvl3Quant/data/processed/wider_cnn_preds/per_day_oos/*.npz 2>/dev/null | wc -l && ' +
    'ls /home/jupiter/Lvl3Quant/data/raw/mbo/*.mbo.dbn.zst 2>/dev/null | wc -l'
  );
  log(`Data check: ${dataCheck.stdout.trim().replace('\n', ' preds | ')} mbo files`);

  // ── 3. Transfer script ──────────────────────────────────────────────────
  const localScript = path.join(__dirname, 'alpha_capture_sweep.py');
  if (!fs.existsSync(localScript)) {
    log(`ERROR: Local script not found: ${localScript}`);
    process.exit(1);
  }
  log(`Transferring ${localScript} → Jupiter:${REMOTE_SCRIPT}`);
  await transferScript(localScript, REMOTE_SCRIPT);

  // ── 4. Kill existing session if any ────────────────────────────────────
  await jupiterExec(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null; echo done`);
  await new Promise(res => setTimeout(res, 1000));

  // ── 5. Create output dir ────────────────────────────────────────────────
  await jupiterExec(`mkdir -p /home/jupiter/Lvl3Quant/data/processed/alpha_capture_sweep`);

  // ── 6. Launch in tmux ──────────────────────────────────────────────────
  const launchCmd = [
    `tmux new-session -d -s ${TMUX_SESSION}`,
    `"cd /home/jupiter/Lvl3Quant && `,
    `python3 -u ${REMOTE_SCRIPT} 2>&1 | tee ${REMOTE_LOG}"`,
    `&& echo LAUNCHED`,
  ].join(' ');

  log('Launching tmux session...');
  const launch = await jupiterExec(launchCmd, 15_000);
  if (!launch.stdout.includes('LAUNCHED') && launch.exit_code !== 0) {
    log(`Launch warning: ${launch.stdout} | ${launch.stderr}`);
  } else {
    log('Launched OK');
  }

  // ── 7. Wait 5s and verify running ──────────────────────────────────────
  await new Promise(res => setTimeout(res, 5_000));
  const sessions = await jupiterExec('tmux list-sessions 2>&1');
  if (sessions.stdout.includes(TMUX_SESSION)) {
    log(`tmux session '${TMUX_SESSION}' confirmed RUNNING`);
  } else {
    log(`WARNING: tmux session '${TMUX_SESSION}' not found after launch`);
  }

  // ── 8. Show process ────────────────────────────────────────────────────
  const ps = await jupiterExec(
    'ps aux | grep alpha_capture_sweep | grep -v grep | head -3'
  );
  if (ps.stdout.trim()) {
    log(`Process running: ${ps.stdout.trim().split('\n')[0].split(/\s+/).slice(0, 12).join(' ')}`);
  }

  // ── 9. Peek at first log lines ─────────────────────────────────────────
  await new Promise(res => setTimeout(res, 3_000));
  const peek = await jupiterExec(`head -20 ${REMOTE_LOG} 2>/dev/null || echo "(log not yet created)"`);
  log('=== Initial log ===');
  console.log(peek.stdout || '(empty)');

  log('');
  log('=== LAUNCH COMPLETE ===');
  log(`Monitor: node scripts/launch_alpha_capture.js --status`);
  log(`Tail:    node scripts/launch_alpha_capture.js --tail`);
  log(`Log:     ${REMOTE_LOG}`);
  log(`Summary: ${SUMMARY_JSON}`);
  log(`Report:  ${REPORT_TXT}`);
  log('');
  log('Expected runtime: ~30-90 min depending on how many dates have both preds+MBO');
  log('');
  log('SWEEP STRUCTURE:');
  log('  Phase 1: SL sweep  — 5 configs × 8 SL values × N dates');
  log('  Phase 2: Hold sweep — 5 configs × 7 hold times × N dates (best SL)');
  log('  Phase 3: Gate sweep — 5 configs × 4 gate types × N dates');
  log('  Phase 4: Combo     — best SL + best hold + best gates combined');
  log('');
  log('KEY QUESTION: If Sortino peaks at 10-30s hold → real alpha.');
  log('  If better at 2hr → edge was just time-in-market exposure.');
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

(async () => {
  try {
    if (args.includes('--status')) {
      await checkStatus();
    } else if (args.includes('--tail')) {
      await tailLog();
    } else if (args.includes('--kill')) {
      await killSweep();
    } else {
      await launch();
    }
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  }
})();
