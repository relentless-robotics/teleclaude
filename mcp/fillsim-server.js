#!/usr/bin/env node
/**
 * Fill Sim MCP Server
 *
 * Provides MCP tools for running fill simulations on Jupiter via the Flask API.
 * Wraps the fill_sim_cli Rust binary deployed at:
 *   /home/jupiter/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli
 *
 * Tools:
 *   fillsim_run     — Run a single fill sim config, return results
 *   fillsim_sweep   — Launch a parameter sweep script on Jupiter
 *   fillsim_results — Get top-N results from a completed sweep
 *   fillsim_status  — Check if a fill sim job is running on Jupiter
 */

'use strict';

const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const JUPITER_HOST = '192.168.0.108';
const JUPITER_PORT = 8765;
const JUPITER_API_KEY = 'qcc_node_api_2026';

const FILL_SIM_BIN = '/home/jupiter/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli';

// Default data paths on Jupiter
const DEFAULT_MBO_DIR   = '/home/jupiter/Lvl3Quant/data/mbo';
const DEFAULT_PREDS_DIR = '/home/jupiter/Lvl3Quant/data/predictions';
const DEFAULT_OUT_DIR   = '/home/jupiter/Lvl3Quant/data/fillsim_results';

// ── Logging ──────────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = path.join(LOGS_DIR, `mcp-fillsim-${new Date().toISOString().split('T')[0]}.log`);

function log(level, msg, data) {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] ${msg}`;
  if (data !== undefined) {
    try { line += `\n  ${JSON.stringify(data)}`; } catch (_) {}
  }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function jupiterExec(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command, timeout: Math.floor(timeoutMs / 1000) });
    const options = {
      hostname: JUPITER_HOST,
      port: JUPITER_PORT,
      path: '/exec',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key': JUPITER_API_KEY,
      },
      timeout: timeoutMs + 5000,
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (_) {
          resolve({ stdout: raw, stderr: '', exitCode: 0 });
        }
      });
    });

    req.setTimeout(timeoutMs + 5000, () => {
      req.destroy();
      reject(new Error(`Jupiter exec timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Tool: fillsim_run ─────────────────────────────────────────────────────────

/**
 * Run a single fill sim configuration.
 * Constructs the fill_sim_cli command from params and executes it on Jupiter.
 */
async function fillsim_run({
  card,
  mbo_file,
  predictions_file,
  output_file,
  tp,
  sl,
  signal_threshold,
  hold_ms,
  min_queue_pos,
  max_queue_pos,
  time_window_start,
  time_window_end,
  prime_hours,
  latency_ms,
  chase_entry,
  market_entry,
  size,
  quiet,
}) {
  if (!mbo_file && !card) {
    return { error: 'Either mbo_file or card (used to derive paths) is required' };
  }
  if (!predictions_file) {
    return { error: 'predictions_file is required' };
  }

  const mbo = mbo_file || `${DEFAULT_MBO_DIR}/${card}.dbn.zst`;
  const preds = predictions_file;
  const ts = Date.now();
  const out = output_file || `${DEFAULT_OUT_DIR}/run_${card || 'custom'}_${ts}.json`;

  // Build CLI args
  const args = [
    `--mbo-file "${mbo}"`,
    `--predictions "${preds}"`,
    `--output "${out}"`,
  ];

  if (tp !== undefined && tp !== null)                 args.push(`--take-profit-ticks ${tp}`);
  if (sl !== undefined && sl !== null)                 args.push(`--stop-loss-ticks ${sl}`);
  if (signal_threshold !== undefined)                  args.push(`--signal-threshold ${signal_threshold}`);
  if (hold_ms !== undefined)                           args.push(`--hold-ms ${hold_ms}`);
  if (min_queue_pos !== undefined && min_queue_pos > 0) args.push(`--min-queue-pos ${min_queue_pos}`);
  if (max_queue_pos !== undefined && max_queue_pos < 999999) args.push(`--max-queue-pos ${max_queue_pos}`);
  if (time_window_start)                               args.push(`--time-window-start "${time_window_start}"`);
  if (time_window_end)                                 args.push(`--time-window-end "${time_window_end}"`);
  if (prime_hours)                                     args.push('--prime-hours');
  if (latency_ms !== undefined && latency_ms > 0)      args.push(`--latency-ms ${latency_ms}`);
  if (chase_entry)                                     args.push('--chase-entry');
  if (market_entry)                                    args.push('--market-entry');
  if (size !== undefined && size > 0)                  args.push(`--size ${size}`);
  if (quiet)                                           args.push('--quiet');

  // Ensure output directory exists
  const mkdirCmd = `mkdir -p "${DEFAULT_OUT_DIR}"`;
  await jupiterExec(mkdirCmd, 5000).catch(() => {});

  const cmd = `${FILL_SIM_BIN} ${args.join(' ')}`;
  log('INFO', 'fillsim_run', { cmd: cmd.slice(0, 200) });

  try {
    const result = await jupiterExec(cmd, 120000);

    if (result.exitCode !== 0) {
      return {
        error: 'fill_sim_cli failed',
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        command: cmd,
      };
    }

    // Parse the compact JSON summary from stdout (last line of stdout)
    let summary = null;
    const stdoutLines = (result.stdout || '').trim().split('\n');
    for (let i = stdoutLines.length - 1; i >= 0; i--) {
      const line = stdoutLines[i].trim();
      if (line.startsWith('{')) {
        try { summary = JSON.parse(line); break; } catch (_) {}
      }
    }

    // Also try to read the full output JSON
    let fullResult = null;
    try {
      const catResult = await jupiterExec(`cat "${out}"`, 10000);
      if (catResult.exitCode === 0 && catResult.stdout) {
        fullResult = JSON.parse(catResult.stdout);
      }
    } catch (_) {}

    return {
      success: true,
      output_file: out,
      summary,
      // Key metrics at top level for easy access
      pnl: fullResult?.total_pnl_dollars ?? summary?.pnl,
      trades: fullResult?.total_trades ?? summary?.trades,
      win_rate: fullResult?.win_rate ?? summary?.wr,
      fill_rate: fullResult?.fill_rate ?? summary?.fr,
      sharpe: fullResult?.sharpe_per_trade ?? summary?.sharpe,
      sortino: fullResult?.summary?.sortino ?? null,
      profit_factor: fullResult?.profit_factor ?? summary?.pf,
      avg_queue_position: fullResult?.avg_queue_position ?? null,
      stderr_preview: result.stderr ? result.stderr.slice(-500) : null,
    };
  } catch (e) {
    return { error: e.message, command: cmd };
  }
}

// ── Tool: fillsim_sweep ───────────────────────────────────────────────────────

/**
 * Launch a parameter sweep on Jupiter.
 * Finds the sweep script and runs it in the background (nohup).
 */
async function fillsim_sweep({
  card,
  tp_range,
  sl_range,
  threshold_range,
  sweep_script,
  extra_args,
}) {
  if (!card) return { error: 'card is required' };

  // Prefer a specified script, otherwise look for common sweep scripts
  const scriptPath = sweep_script || `/home/jupiter/Lvl3Quant/scripts/fill_sim_queue_fade_iceberg.py`;

  const args = [`--card ${card}`];
  if (tp_range)        args.push(`--tp-range "${tp_range}"`);
  if (sl_range)        args.push(`--sl-range "${sl_range}"`);
  if (threshold_range) args.push(`--threshold-range "${threshold_range}"`);
  if (extra_args)      args.push(extra_args);

  const logFile = `/home/jupiter/Lvl3Quant/logs/sweep_${card}_${Date.now()}.log`;
  const cmd = `nohup python3 ${scriptPath} ${args.join(' ')} > ${logFile} 2>&1 & echo $!`;

  log('INFO', 'fillsim_sweep', { card, scriptPath, args });

  try {
    const result = await jupiterExec(cmd, 30000);
    const pid = (result.stdout || '').trim();

    return {
      success: true,
      job_launched: true,
      pid,
      log_file: logFile,
      script: scriptPath,
      card,
      message: `Sweep launched for card ${card}. PID: ${pid}. Monitor: tail -f ${logFile}`,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Tool: fillsim_results ─────────────────────────────────────────────────────

/**
 * Read top-N fill sim results sorted by Sortino ratio.
 * results_path can be a directory (scans JSON files) or a single JSON file.
 */
async function fillsim_results({ results_path, top_n, sort_by }) {
  const rPath = results_path || DEFAULT_OUT_DIR;
  const n = top_n || 10;
  const sortMetric = sort_by || 'sortino';

  // Check if it's a directory or file
  const statCmd = `stat -c '%F' "${rPath}" 2>&1`;
  const statResult = await jupiterExec(statCmd, 5000);
  const isDir = (statResult.stdout || '').includes('directory');

  let files = [];
  if (isDir) {
    const lsResult = await jupiterExec(`ls "${rPath}"/*.json 2>/dev/null | head -200`, 10000);
    if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
      files = lsResult.stdout.trim().split('\n').filter(f => f.endsWith('.json'));
    }
  } else {
    files = [rPath];
  }

  if (files.length === 0) {
    return { error: `No JSON result files found in: ${rPath}`, results_path: rPath };
  }

  // Read all files in parallel (batched)
  const results = [];
  const BATCH = 20;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const catCmd = batch.map(f => `cat "${f}"`).join(' && echo "---SEP---" && ');
    const catResult = await jupiterExec(catCmd, 30000);

    if (catResult.exitCode === 0) {
      const chunks = (catResult.stdout || '').split('---SEP---');
      for (let j = 0; j < chunks.length; j++) {
        const chunk = chunks[j].trim();
        if (!chunk) continue;
        try {
          const data = JSON.parse(chunk);
          results.push({
            file: batch[j],
            pnl: data.total_pnl_dollars,
            trades: data.total_trades,
            win_rate: data.win_rate,
            fill_rate: data.fill_rate,
            sharpe: data.sharpe_per_trade,
            sortino: data.summary?.sortino,
            profit_factor: data.profit_factor,
            avg_queue_pos: data.avg_queue_position,
            signal_threshold: data.signal_threshold,
            config: data.config,
          });
        } catch (_) {}
      }
    }
  }

  if (results.length === 0) {
    return { error: 'Could not parse any result files', files_found: files.length };
  }

  // Sort by requested metric
  results.sort((a, b) => {
    const av = a[sortMetric] ?? a.sharpe ?? -999;
    const bv = b[sortMetric] ?? b.sharpe ?? -999;
    return bv - av;
  });

  return {
    total_files: files.length,
    parsed: results.length,
    sort_by: sortMetric,
    top: results.slice(0, n),
  };
}

// ── Tool: fillsim_status ──────────────────────────────────────────────────────

/**
 * Check if fill sim jobs are currently running on Jupiter.
 */
async function fillsim_status() {
  try {
    // Check for running fill_sim_cli processes
    const psCmd = `ps aux | grep fill_sim_cli | grep -v grep || echo "NO_PROCESS"`;
    const psResult = await jupiterExec(psCmd, 10000);

    // Check for running sweep scripts
    const sweepCmd = `ps aux | grep -E "fill_sim.*py|sweep.*py" | grep -v grep || echo "NO_SWEEP"`;
    const sweepResult = await jupiterExec(sweepCmd, 10000);

    // Count recent output files
    const countCmd = `ls ${DEFAULT_OUT_DIR}/*.json 2>/dev/null | wc -l`;
    const countResult = await jupiterExec(countCmd, 5000);

    // Get the most recent result file
    const latestCmd = `ls -t ${DEFAULT_OUT_DIR}/*.json 2>/dev/null | head -1`;
    const latestResult = await jupiterExec(latestCmd, 5000);

    const fillSimRunning = !(psResult.stdout || '').includes('NO_PROCESS');
    const sweepRunning   = !(sweepResult.stdout || '').includes('NO_SWEEP');

    return {
      fill_sim_running: fillSimRunning,
      sweep_running: sweepRunning,
      active_processes: fillSimRunning ? (psResult.stdout || '').trim() : null,
      sweep_processes: sweepRunning ? (sweepResult.stdout || '').trim() : null,
      total_result_files: parseInt((countResult.stdout || '0').trim()) || 0,
      latest_result: (latestResult.stdout || '').trim() || null,
      results_dir: DEFAULT_OUT_DIR,
      binary: FILL_SIM_BIN,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'fillsim_run',
    description: [
      'Run a single fill sim configuration on Jupiter using fill_sim_cli.',
      'Executes the Rust fill simulator with specified TP/SL/threshold/queue/time-window params.',
      'Returns PnL, Sortino, win rate, fill rate, and trades/day.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        card:              { type: 'string',  description: 'Card ID (used to derive default MBO file path)' },
        mbo_file:          { type: 'string',  description: 'Absolute path to MBO .dbn/.dbn.zst file on Jupiter' },
        predictions_file:  { type: 'string',  description: 'Absolute path to predictions .npz file on Jupiter' },
        output_file:       { type: 'string',  description: 'Output JSON path (auto-generated if omitted)' },
        tp:                { type: 'number',  description: 'Take profit in ticks (e.g. 4.0)' },
        sl:                { type: 'number',  description: 'Stop loss in ticks (e.g. 2.0)' },
        signal_threshold:  { type: 'number',  description: 'Signal threshold |pred| > this (default 0.0)' },
        hold_ms:           { type: 'number',  description: 'Max hold time in ms (default 10000)' },
        min_queue_pos:     { type: 'number',  description: 'Min queue position filter (Track 2A) — skip trades with queue_pos < this' },
        max_queue_pos:     { type: 'number',  description: 'Max queue position filter (Track 2A) — skip trades with queue_pos > this' },
        time_window_start: { type: 'string',  description: 'Time window start ET HH:MM (Track 2B, e.g. "09:30")' },
        time_window_end:   { type: 'string',  description: 'Time window end ET HH:MM (Track 2B, e.g. "11:30")' },
        prime_hours:       { type: 'boolean', description: 'Restrict to prime hours 10:30-14:30 ET' },
        latency_ms:        { type: 'number',  description: 'Order submission latency in ms (default 0)' },
        chase_entry:       { type: 'boolean', description: 'Enable chase/cancel-replace entry mode' },
        market_entry:      { type: 'boolean', description: 'Use market orders instead of passive limit' },
        size:              { type: 'number',  description: 'Contracts per order (default 1)' },
        quiet:             { type: 'boolean', description: 'Suppress verbose fill sim output' },
      },
    },
  },
  {
    name: 'fillsim_sweep',
    description: [
      'Launch a fill sim parameter sweep on Jupiter (background, nohup).',
      'Runs a sweep Python script for the specified card. Returns job PID and log file path.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        card:            { type: 'string', description: 'Card ID to sweep' },
        tp_range:        { type: 'string', description: 'Take profit range e.g. "2,4,6,8,10"' },
        sl_range:        { type: 'string', description: 'Stop loss range e.g. "1,2,3,4"' },
        threshold_range: { type: 'string', description: 'Signal threshold range e.g. "0.5,1.0,1.5,2.0"' },
        sweep_script:    { type: 'string', description: 'Absolute path to sweep script (optional, uses default if omitted)' },
        extra_args:      { type: 'string', description: 'Extra CLI args to pass to the sweep script' },
      },
      required: ['card'],
    },
  },
  {
    name: 'fillsim_results',
    description: [
      'Read and rank fill sim results from a directory or file on Jupiter.',
      'Returns top-N configs sorted by Sortino ratio (or other metric).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        results_path: { type: 'string', description: 'Directory or JSON file path on Jupiter (default: fillsim_results dir)' },
        top_n:        { type: 'number', description: 'Number of top results to return (default 10)' },
        sort_by:      { type: 'string', description: 'Metric to sort by: sortino, sharpe, pnl, win_rate (default: sortino)' },
      },
    },
  },
  {
    name: 'fillsim_status',
    description: 'Check if fill sim jobs are currently running on Jupiter. Shows active processes and result file count.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── MCP Protocol ──────────────────────────────────────────────────────────────

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function toolResult(value) {
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  };
}

async function handleToolCall(name, args) {
  log('INFO', `Tool call: ${name}`, args);
  try {
    let result;
    switch (name) {
      case 'fillsim_run':     result = await fillsim_run(args || {}); break;
      case 'fillsim_sweep':   result = await fillsim_sweep(args || {}); break;
      case 'fillsim_results': result = await fillsim_results(args || {}); break;
      case 'fillsim_status':  result = await fillsim_status(); break;
      default: return { error: `Unknown tool: ${name}` };
    }
    log('INFO', `Tool result: ${name}`, typeof result === 'object' ? JSON.stringify(result).slice(0, 400) : result);
    return result;
  } catch (e) {
    log('ERROR', `Tool ${name} threw`, e.message);
    return { error: e.message };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch (e) {
    log('WARN', 'Failed to parse JSON line', trimmed.slice(0, 200));
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fillsim-server', version: '1.0.0' },
      });
      return;
    }

    if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs  = params?.arguments || {};
      const result    = await handleToolCall(toolName, toolArgs);
      respond(id, toolResult(result));
      return;
    }

    if (method?.startsWith('notifications/')) return;

    respondError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    log('ERROR', `Unhandled error for ${method}`, e.message);
    respondError(id, -32603, `Internal error: ${e.message}`);
  }
});

rl.on('close', () => {
  log('INFO', 'stdin closed — fillsim-server shutting down');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', e.message);
});

log('INFO', 'fillsim-server started');
