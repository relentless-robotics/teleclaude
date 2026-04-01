/**
 * System Status — Comprehensive status report for all subsystems.
 *
 * Aggregates: CNN training, trading agents, prediction markets, AeroForge,
 * GPU status, compute health, and memory freshness.
 *
 * Usage:
 *   node trading_agents/system_status.js             # print to console
 *   node trading_agents/system_status.js --discord    # send to Discord
 *
 * From code:
 *   const { generateStatusReport } = require('./trading_agents/system_status');
 *   const report = await generateStatusReport();
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');

// ============================================================================
// SUBSYSTEM CHECKS
// ============================================================================

function getGPUStatus() {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader',
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    ).trim();
    const parts = output.split(',').map(s => s.trim());
    return {
      name: parts[4] || 'GPU',
      utilization: parseInt(parts[0]),
      memUsed: parseInt(parts[1]),
      memTotal: parseInt(parts[2]),
      temp: parseInt(parts[3]),
      status: parseInt(parts[0]) > 50 ? 'ACTIVE' : 'IDLE',
    };
  } catch (e) {
    return null;
  }
}

function getCNNStatus() {
  const resultsDir = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\alpha_discovery\\deep_models\\results';
  try {
    // Find latest log
    const files = fs.readdirSync(resultsDir)
      .filter(f => f.startsWith('walkforward_book_') && f.endsWith('.log') && !f.includes('resume'))
      .sort().reverse();
    if (files.length === 0) return { status: 'NO_LOG' };

    const logFile = path.join(resultsDir, files[0]);
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');

    // Parse latest fold and epoch
    let lastFold = null, lastEpoch = null, totalFolds = 94;
    let checkpointSkip = 0;

    for (const line of lines) {
      const foldMatch = line.match(/Fold (\d+)\/(\d+)/);
      if (foldMatch) {
        lastFold = parseInt(foldMatch[1]);
        totalFolds = parseInt(foldMatch[2]);
      }
      const epochMatch = line.match(/Epoch (\d+)\/(\d+):.*IC=([+-]?[\d.]+)/);
      if (epochMatch) {
        lastEpoch = {
          epoch: parseInt(epochMatch[1]),
          total: parseInt(epochMatch[2]),
          ic: parseFloat(epochMatch[3]),
        };
      }
      const skipMatch = line.match(/Skipping (\d+) completed folds.*IC.*:\s*([+-]?[\d.]+)/);
      if (skipMatch) {
        checkpointSkip = parseInt(skipMatch[1]);
      }
    }

    // Read checkpoint
    let checkpointIC = null;
    const cpFiles = fs.readdirSync(resultsDir)
      .filter(f => f.startsWith('checkpoint_book_') && f.endsWith('.json'))
      .sort().reverse();
    if (cpFiles.length > 0) {
      const cp = JSON.parse(fs.readFileSync(path.join(resultsDir, cpFiles[0]), 'utf8'));
      checkpointIC = {
        folds: cp.completed_folds,
        meanIC: cp.mean_ic,
        allPositive: cp.all_positive,
      };
    }

    return {
      status: 'TRAINING',
      logFile: files[0],
      currentFold: lastFold,
      totalFolds,
      currentEpoch: lastEpoch,
      checkpointFolds: checkpointIC?.folds || checkpointSkip,
      checkpointMeanIC: checkpointIC?.meanIC,
      checkpointAllPositive: checkpointIC?.allPositive,
    };
  } catch (e) {
    return { status: 'ERROR', error: e.message };
  }
}

function getTradingAgentStatus() {
  const stateFile = path.join(DATA_DIR, 'agent_state.json');
  try {
    if (!fs.existsSync(stateFile)) return { status: 'NOT_RUNNING' };
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const agents = {};
    for (const [name, info] of Object.entries(state.agents || {})) {
      const lastRun = info.lastRun ? new Date(info.lastRun) : null;
      const ageMin = lastRun ? Math.round((Date.now() - lastRun.getTime()) / 60000) : null;
      agents[name] = {
        status: info.status || 'unknown',
        lastRun: info.lastRun,
        ageMin,
        stale: ageMin > 120,
      };
    }
    return { status: 'CONFIGURED', agents };
  } catch (e) {
    return { status: 'ERROR', error: e.message };
  }
}

function getPredictionMarketsStatus() {
  const pmState = path.join(DATA_DIR, 'prediction_markets_state.json');
  const fomcFile = path.join(__dirname, 'prediction_markets', 'data', 'fomc_divergence_history.json');
  const volSignal = path.join(__dirname, 'prediction_markets', 'data', 'vol_signal.json');

  const result = { status: 'CONFIGURED' };

  // PM state
  try {
    if (fs.existsSync(pmState)) {
      const state = JSON.parse(fs.readFileSync(pmState, 'utf8'));
      result.lastScan = state.lastScan;
      result.opportunities = state.activeOpportunities?.length || 0;
    }
  } catch (e) {}

  // FOMC
  try {
    if (fs.existsSync(fomcFile)) {
      const fomc = JSON.parse(fs.readFileSync(fomcFile, 'utf8'));
      const latest = Array.isArray(fomc) ? fomc[fomc.length - 1] : fomc;
      result.fomc = {
        signal: latest?.signal || 'UNKNOWN',
        divergence: latest?.max_divergence != null ? (latest.max_divergence * 100).toFixed(1) : null,
        nextMeeting: latest?.meeting,
        daysTo: latest?.days_to_meeting,
      };
    }
  } catch (e) {}

  // Vol signal
  try {
    if (fs.existsSync(volSignal)) {
      const sig = JSON.parse(fs.readFileSync(volSignal, 'utf8'));
      const ageMin = Math.round((Date.now() - new Date(sig.timestamp).getTime()) / 60000);
      result.volSignal = {
        vol: sig.raw_prediction_pct,
        age: ageMin,
        stale: ageMin > 120,
      };
    }
  } catch (e) {}

  return result;
}

function getAeroForgeStatus() {
  try {
    const output = execSync('curl -s http://localhost:8000/api/health', {
      encoding: 'utf8', timeout: 5000,
    }).trim();
    const data = JSON.parse(output);
    return {
      status: data.status === 'ok' ? 'RUNNING' : 'ERROR',
      port: 8000,
      dbOk: data.db_ok,
      pending: data.jobs_pending,
      running: data.jobs_running,
    };
  } catch (e) {
    return { status: 'OFFLINE', port: 8000 };
  }
}

function getMemoryHealth() {
  const memFile = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.claude', 'projects', 'C--Users-Footb-Documents-Github-teleclaude-main', 'memory', 'MEMORY.md'
  );
  try {
    if (!fs.existsSync(memFile)) return { status: 'NOT_FOUND' };
    const content = fs.readFileSync(memFile, 'utf8');
    const lines = content.split('\n').length;
    const match = content.match(/Updated: ([\d-]+ [\d:]+)/);
    return {
      status: 'OK',
      lines,
      lastUpdated: match ? match[1] : 'unknown',
      overLimit: lines > 200,
    };
  } catch (e) {
    return { status: 'ERROR', error: e.message };
  }
}

// ============================================================================
// REPORT GENERATOR
// ============================================================================

async function generateStatusReport() {
  const gpu = getGPUStatus();
  const cnn = getCNNStatus();
  const agents = getTradingAgentStatus();
  const pm = getPredictionMarketsStatus();
  const aero = getAeroForgeStatus();
  const memory = getMemoryHealth();
  const timeET = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: true,
  });

  return { gpu, cnn, agents, predictionMarkets: pm, aeroforge: aero, memory, timeET };
}

function formatReport(report) {
  let msg = `**SYSTEM STATUS — ${report.timeET} ET**\n\n`;

  // GPU
  if (report.gpu) {
    const g = report.gpu;
    const emoji = g.utilization > 80 ? '🔥' : g.utilization > 20 ? '⚡' : '💤';
    msg += `**GPU:** ${emoji} ${g.name} | ${g.utilization}% | ${g.memUsed}/${g.memTotal} MiB | ${g.temp}°C\n`;
  } else {
    msg += `**GPU:** ❌ Not available\n`;
  }

  // CNN
  const c = report.cnn;
  if (c.status === 'TRAINING') {
    const progress = ((c.currentFold || 0) / c.totalFolds * 100).toFixed(0);
    msg += `**CNN:** 🧠 Fold ${c.currentFold}/${c.totalFolds} (${progress}%)`;
    if (c.currentEpoch) msg += ` | Epoch ${c.currentEpoch.epoch}/${c.currentEpoch.total} IC=${c.currentEpoch.ic > 0 ? '+' : ''}${c.currentEpoch.ic.toFixed(4)}`;
    if (c.checkpointMeanIC) msg += ` | Mean IC=+${c.checkpointMeanIC.toFixed(4)}`;
    msg += '\n';
  } else {
    msg += `**CNN:** ${c.status}\n`;
  }

  // AeroForge
  const a = report.aeroforge;
  msg += `**AeroForge:** ${a.status === 'RUNNING' ? '✅' : '❌'} ${a.status} (port ${a.port})\n`;

  // Prediction Markets
  const pm = report.predictionMarkets;
  msg += `**Pred Markets:** ${pm.opportunities || 0} opps`;
  if (pm.fomc) msg += ` | FOMC: ${pm.fomc.signal} (${pm.fomc.divergence}% gap)`;
  if (pm.volSignal) msg += ` | Vol: ${pm.volSignal.vol?.toFixed(1)}%${pm.volSignal.stale ? ' ⚠️STALE' : ''}`;
  msg += '\n';

  // Trading Agents
  const ta = report.agents;
  if (ta.status === 'CONFIGURED' && ta.agents) {
    const active = Object.values(ta.agents).filter(a => a.ageMin !== null && a.ageMin < 120).length;
    const total = Object.keys(ta.agents).length;
    msg += `**Agents:** ${active}/${total} active (last 2h)\n`;
  } else {
    msg += `**Agents:** ${ta.status}\n`;
  }

  // Memory
  const m = report.memory;
  msg += `**Memory:** ${m.lines || '?'} lines | Updated: ${m.lastUpdated || '?'}${m.overLimit ? ' ⚠️ OVER 200' : ''}\n`;

  return msg;
}

// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  const sendDiscord = process.argv.includes('--discord');

  generateStatusReport().then(async (report) => {
    const formatted = formatReport(report);
    console.log(formatted);

    if (sendDiscord) {
      try {
        const discord = require('./discord_channels');
        await discord.systemStatus(formatted);
        console.log('\nSent to Discord #system-status');
      } catch (e) {
        console.error('Discord send failed:', e.message);
      }
    }
  }).catch(e => console.error('Error:', e.message));
}

module.exports = { generateStatusReport, formatReport };
