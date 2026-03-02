/**
 * Results Collector — Pulls MBO sim results from Jupiter/Saturn and updates dashboard JSON files.
 *
 * Runs periodically to:
 * 1. SSH into Jupiter/Saturn and fetch sweep result summaries
 * 2. Update dashboard-app/data/backtest_results.json with new runs
 * 3. Update dashboard-app/data/tasks.json with progress/heartbeats
 * 4. Generate signal_sweep_summary.json for the quant tab heatmap
 *
 * Usage: node utils/results_collector.js [--once] [--interval 300]
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const DASHBOARD_DATA = path.join(__dirname, '..', 'dashboard-app', 'data');
const BACKTEST_FILE = path.join(DASHBOARD_DATA, 'backtest_results.json');
const TASKS_FILE = path.join(DASHBOARD_DATA, 'tasks.json');
const SIGNAL_SWEEP_FILE = path.join(DASHBOARD_DATA, 'signal_sweep_summary.json');

// SSH helper using paramiko via Python
function sshExec(host, command, timeout = 30) {
  const pyScript = `
import paramiko, sys, json
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    ssh.connect('${host}', username='jupiter', password='YOUR_SERVER_PASSWORD', timeout=10)
    stdin, stdout, stderr = ssh.exec_command(${JSON.stringify(command)}, timeout=${timeout})
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    print(json.dumps({'stdout': out, 'stderr': err, 'ok': True}))
except Exception as e:
    print(json.dumps({'stdout': '', 'stderr': str(e), 'ok': False}))
finally:
    ssh.close()
`;
  try {
    const result = execSync(`python -c ${JSON.stringify(pyScript)}`, {
      timeout: (timeout + 15) * 1000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result.trim());
  } catch (e) {
    return { stdout: '', stderr: e.message, ok: false };
  }
}

function saturnExec(command, timeout = 30) {
  const pyScript = `
import paramiko, sys, json
# Two-hop: Jupiter -> Saturn
jump = paramiko.SSHClient()
jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    jump.connect('YOUR_JUPITER_LAN_IP', username='jupiter', password='YOUR_SERVER_PASSWORD', timeout=10)
    transport = jump.get_transport()
    channel = transport.open_channel('direct-tcpip', ('YOUR_SATURN_IP', 22), ('YOUR_JUPITER_LAN_IP', 0))
    target = paramiko.SSHClient()
    target.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    target.connect('YOUR_SATURN_IP', username='saturn', password='YOUR_SERVER_PASSWORD', sock=channel, timeout=10)
    stdin, stdout, stderr = target.exec_command(${JSON.stringify(command)}, timeout=${timeout})
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    print(json.dumps({'stdout': out, 'stderr': err, 'ok': True}))
    target.close()
except Exception as e:
    print(json.dumps({'stdout': '', 'stderr': str(e), 'ok': False}))
finally:
    jump.close()
`;
  try {
    const result = execSync(`python -c ${JSON.stringify(pyScript)}`, {
      timeout: (timeout + 20) * 1000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result.trim());
  } catch (e) {
    return { stdout: '', stderr: e.message, ok: false };
  }
}

function collectJupiterResults() {
  console.log('[Jupiter] Collecting signal sweep results...');

  // Get result count and breakdown
  const countCmd = `
cd /home/jupiter/lvl3quant && python3 -c "
import json, glob, sys
files = glob.glob('alpha_discovery/results/sig_*.json')
by_strat = {}
profitable = 0
total = len(files)
best_overall = None
for f in sorted(files):
    try:
        with open(f) as fh:
            d = json.load(fh)
        pnl = d.get('total_pnl_dollars', d.get('pnl_dollars', 0))
        trades = d.get('total_trades', d.get('n_trades', 0))
        parts = f.split('sig_')[1].replace('.json', '')
        # Extract strategy name (everything before the date)
        tokens = parts.split('_')
        date_idx = None
        for i, t in enumerate(tokens):
            if len(t) == 4 and t.isdigit() and int(t) >= 2020:
                date_idx = i
                break
        if date_idx:
            strat = '_'.join(tokens[:date_idx])
        else:
            strat = 'unknown'
        if strat not in by_strat:
            by_strat[strat] = {'count': 0, 'profitable': 0, 'total_pnl': 0, 'best_pnl': -999999, 'best_combo': '', 'total_trades': 0}
        by_strat[strat]['count'] += 1
        by_strat[strat]['total_pnl'] += pnl
        by_strat[strat]['total_trades'] += trades
        if pnl > 0:
            by_strat[strat]['profitable'] += 1
            profitable += 1
        if pnl > by_strat[strat]['best_pnl']:
            by_strat[strat]['best_pnl'] = pnl
            by_strat[strat]['best_combo'] = parts
        if best_overall is None or pnl > best_overall['pnl']:
            best_overall = {'pnl': pnl, 'combo': parts, 'trades': trades}
    except:
        pass
print(json.dumps({
    'total': total, 'profitable': profitable,
    'by_strat': by_strat,
    'best': best_overall,
    'server': 'jupiter'
}))
"`;

  const result = sshExec('YOUR_JUPITER_LAN_IP', countCmd, 60);
  if (result.ok && result.stdout.trim()) {
    try {
      return JSON.parse(result.stdout.trim().split('\n').pop());
    } catch (e) {
      console.error('[Jupiter] Parse error:', e.message);
    }
  }
  console.error('[Jupiter] Failed:', result.stderr?.substring(0, 200));
  return null;
}

function collectSaturnResults() {
  console.log('[Saturn] Collecting signal sweep results...');

  const countCmd = `
cd /home/saturn/lvl3quant && python3 -c "
import json, glob, sys
files = glob.glob('alpha_discovery/results/sig_*.json')
by_strat = {}
profitable = 0
total = len(files)
best_overall = None
for f in sorted(files):
    try:
        with open(f) as fh:
            d = json.load(fh)
        pnl = d.get('total_pnl_dollars', d.get('pnl_dollars', 0))
        trades = d.get('total_trades', d.get('n_trades', 0))
        parts = f.split('sig_')[1].replace('.json', '')
        tokens = parts.split('_')
        date_idx = None
        for i, t in enumerate(tokens):
            if len(t) == 4 and t.isdigit() and int(t) >= 2020:
                date_idx = i
                break
        if date_idx:
            strat = '_'.join(tokens[:date_idx])
        else:
            strat = 'unknown'
        if strat not in by_strat:
            by_strat[strat] = {'count': 0, 'profitable': 0, 'total_pnl': 0, 'best_pnl': -999999, 'best_combo': '', 'total_trades': 0}
        by_strat[strat]['count'] += 1
        by_strat[strat]['total_pnl'] += pnl
        by_strat[strat]['total_trades'] += trades
        if pnl > 0:
            by_strat[strat]['profitable'] += 1
            profitable += 1
        if pnl > by_strat[strat]['best_pnl']:
            by_strat[strat]['best_pnl'] = pnl
            by_strat[strat]['best_combo'] = parts
        if best_overall is None or pnl > best_overall['pnl']:
            best_overall = {'pnl': pnl, 'combo': parts, 'trades': trades}
    except:
        pass
# Check if sweep is still running
import subprocess
ps = subprocess.run(['pgrep', '-f', 'run_all_signal'], capture_output=True, text=True)
running = len(ps.stdout.strip().split()) > 0 if ps.stdout.strip() else False
print(json.dumps({
    'total': total, 'profitable': profitable,
    'by_strat': by_strat,
    'best': best_overall,
    'server': 'saturn',
    'still_running': running
}))
"`;

  const result = saturnExec(countCmd, 60);
  if (result.ok && result.stdout.trim()) {
    try {
      return JSON.parse(result.stdout.trim().split('\n').pop());
    } catch (e) {
      console.error('[Saturn] Parse error:', e.message);
    }
  }
  console.error('[Saturn] Failed:', result.stderr?.substring(0, 200));
  return null;
}

function updateDashboard(jupiterData, saturnData) {
  const now = new Date().toISOString();

  // Read existing backtest results
  let backtestData;
  try {
    backtestData = JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf-8'));
  } catch {
    backtestData = { meta: {}, runs: [], queue: [] };
  }

  // Merge server results into signal_sweep_summary.json for quant tab
  const sweepSummary = {
    meta: {
      description: 'Signal strategy MBO fill sim sweep — raw microstructure signals',
      lastUpdated: now,
      simEngine: 'Rust fill_sim_cli (FIFO queue MBO sim)',
      costModel: '$3.00 RT, ES tick = $12.50',
    },
    servers: {},
    combined: {
      totalResults: 0,
      totalProfitable: 0,
      strategies: {},
    },
  };

  for (const [label, data] of [['jupiter', jupiterData], ['saturn', saturnData]]) {
    if (!data) continue;
    sweepSummary.servers[label] = {
      total: data.total,
      profitable: data.profitable,
      profitableRate: data.total > 0 ? (data.profitable / data.total * 100).toFixed(1) + '%' : '0%',
      best: data.best,
      stillRunning: data.still_running || false,
      lastChecked: now,
    };
    sweepSummary.combined.totalResults += data.total;
    sweepSummary.combined.totalProfitable += data.profitable;

    // Merge strategy data
    for (const [strat, info] of Object.entries(data.by_strat || {})) {
      if (!sweepSummary.combined.strategies[strat]) {
        sweepSummary.combined.strategies[strat] = {
          results: 0, profitable: 0, totalPnl: 0, bestPnl: -999999, bestCombo: '', totalTrades: 0,
        };
      }
      const s = sweepSummary.combined.strategies[strat];
      s.results += info.count;
      s.profitable += info.profitable;
      s.totalPnl += info.total_pnl;
      s.totalTrades += info.total_trades;
      if (info.best_pnl > s.bestPnl) {
        s.bestPnl = info.best_pnl;
        s.bestCombo = info.best_combo;
      }
    }
  }

  // Write signal sweep summary
  fs.writeFileSync(SIGNAL_SWEEP_FILE, JSON.stringify(sweepSummary, null, 2));
  console.log(`[Dashboard] Updated ${SIGNAL_SWEEP_FILE}`);

  // Update backtest_results.json — add/update signal sweep run entries
  const existingIds = new Set(backtestData.runs.map(r => r.id));

  for (const [strat, info] of Object.entries(sweepSummary.combined.strategies)) {
    const runId = `signal_sweep_${strat}`;
    const isProfitable = info.profitable > 0;
    const winRate = info.results > 0 ? info.profitable / info.results : 0;

    const run = {
      id: runId,
      name: `Signal Sweep: ${strat}`,
      description: `Raw ${strat} microstructure signal through MBO fill sim. ${info.results} param combos tested across 50 days.`,
      status: 'running',
      verdict: info.results < 100 ? null : (isProfitable ? 'MARGINAL' : 'DISCARDED'),
      server: 'jupiter+saturn',
      startedAt: '2026-02-26T23:51:00Z',
      completedAt: null,
      config: {
        signal: strat,
        simEngine: 'Rust fill_sim_cli',
        holdMs: 'SWEEP: [2000,5000,10000,30000]',
        trailingTicks: 'SWEEP: [4,8,12]',
        signalThreshold: 'SWEEP: [0,0.05,0.1,0.2,0.3,0.5,0.7,0.9]',
        signalFlip: 'SWEEP: [true,false]',
        totalCombos: 192,
        daysPerCombo: 50,
      },
      summary: {
        combosTotal: 192,
        combosComplete: Math.round(info.results / 50),
        totalResults: info.results,
        totalTrades: info.totalTrades,
        totalPnl: Math.round(info.totalPnl * 100) / 100,
        profitable: info.profitable,
        profitableRate: winRate,
        bestPnl: info.bestPnl,
        bestCombo: info.bestCombo,
      },
      perDay: [],
      learnings: isProfitable
        ? `${info.profitable}/${info.results} results profitable. Best: ${info.bestCombo} ($${info.bestPnl.toFixed(2)}). Needs further validation.`
        : `0/${info.results} profitable so far. Signal has IC but doesn't survive MBO fill realism + costs.`,
    };

    // Update or add
    const idx = backtestData.runs.findIndex(r => r.id === runId);
    if (idx >= 0) {
      backtestData.runs[idx] = run;
    } else {
      backtestData.runs.push(run);
    }
  }

  backtestData.meta.lastUpdated = now;
  fs.writeFileSync(BACKTEST_FILE, JSON.stringify(backtestData, null, 2));
  console.log(`[Dashboard] Updated ${BACKTEST_FILE} (${backtestData.runs.length} runs)`);

  // Update tasks.json with progress and heartbeats
  try {
    const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));

    for (const task of tasks) {
      if (task.id === 'sig_sweep_saturn' && saturnData) {
        task.progress = `${saturnData.total}/57,600 jobs (${(saturnData.total / 576).toFixed(1)}%)`;
        task.progressPct = Math.round(saturnData.total / 576 * 10) / 10;
        task.lastHeartbeat = now;
        if (!saturnData.still_running) {
          task.status = 'done';
          task.completedAt = now;
        }
      }
      if (task.id === 'sig_sweep_jupiter' && jupiterData) {
        const jupiterTotal = jupiterData.total - 717; // subtract part 1 results
        task.progress = `${Math.max(0, jupiterTotal)}/38,400 jobs`;
        task.progressPct = Math.max(0, Math.round(jupiterTotal / 384 * 10) / 10);
        task.lastHeartbeat = now;
      }
    }

    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    console.log(`[Dashboard] Updated ${TASKS_FILE}`);
  } catch (e) {
    console.error('[Dashboard] Tasks update error:', e.message);
  }
}

async function collect() {
  console.log(`\n[${new Date().toISOString()}] Collecting results...`);

  const jupiterData = collectJupiterResults();
  const saturnData = collectSaturnResults();

  if (jupiterData || saturnData) {
    updateDashboard(jupiterData, saturnData);

    // Print summary
    const jTotal = jupiterData?.total || 0;
    const sTotal = saturnData?.total || 0;
    const jProf = jupiterData?.profitable || 0;
    const sProf = saturnData?.profitable || 0;
    console.log(`\n=== SUMMARY ===`);
    console.log(`Jupiter: ${jTotal} results, ${jProf} profitable (${jTotal > 0 ? (jProf/jTotal*100).toFixed(1) : 0}%)`);
    console.log(`Saturn:  ${sTotal} results, ${sProf} profitable (${sTotal > 0 ? (sProf/sTotal*100).toFixed(1) : 0}%)`);
    console.log(`Combined: ${jTotal + sTotal} results, ${jProf + sProf} profitable`);

    if (jupiterData?.best) {
      console.log(`Jupiter best: ${jupiterData.best.combo} → $${jupiterData.best.pnl}`);
    }
    if (saturnData?.best) {
      console.log(`Saturn best:  ${saturnData.best.combo} → $${saturnData.best.pnl}`);
    }
  } else {
    console.log('[WARNING] No data from either server');
  }
}

// Main
const args = process.argv.slice(2);
const once = args.includes('--once');
const intervalIdx = args.indexOf('--interval');
const intervalSecs = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1]) || 300 : 300;

collect().then(() => {
  if (!once) {
    console.log(`\nRunning every ${intervalSecs}s. Press Ctrl+C to stop.`);
    setInterval(collect, intervalSecs * 1000);
  }
});
