/**
 * monitor.js — Server Health Monitor for Lvl3Quant
 *
 * Provides real-time visibility into the Jupiter server's health, resource usage,
 * and active job status. Reads heartbeat file to confirm server responsiveness.
 *
 * Usage:
 *   const monitor = require('./server_compute/monitor');
 *   const status = await monitor.getServerStatus();
 *   const jobs = await monitor.getActiveJobs();
 *   const hb = await monitor.getHeartbeat();
 */

'use strict';

const { getConnection, loadConfig } = require('../utils/ssh_manager');
const { execRemote, listRemote } = require('./sync');
const { listJobs, REMOTE_BASE, LOGS_BASE } = require('./runner');

const DEFAULT_SERVER = 'jupiter';
const HEARTBEAT_FILE = `${REMOTE_BASE}/.heartbeat`;

// =============================================================================
// Server Status
// =============================================================================

/**
 * Get comprehensive server status in one SSH session.
 * Batches all stat commands to minimize round-trips.
 *
 * @param {string} serverName
 * @returns {Promise<object>} - CPU, RAM, disk, uptime, load, network info
 */
async function getServerStatus(serverName = DEFAULT_SERVER) {
  try {
    const conn = await getConnection(serverName);

    // Run all stat commands in one bash session
    const statsCmd = `
python3 -c "
import os, json, psutil, datetime

try:
    cpu = psutil.cpu_percent(interval=1)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage(os.path.expanduser('~'))
    load = os.getloadavg()
    boot = psutil.boot_time()
    uptime_sec = (datetime.datetime.now().timestamp() - boot)

    print(json.dumps({
        'cpu_pct': round(cpu, 1),
        'cpu_cores': psutil.cpu_count(),
        'cpu_logical': psutil.cpu_count(logical=True),
        'ram_total_mb': round(mem.total / 1024 / 1024),
        'ram_used_mb': round(mem.used / 1024 / 1024),
        'ram_free_mb': round(mem.available / 1024 / 1024),
        'ram_pct': round(mem.percent, 1),
        'disk_total_gb': round(disk.total / 1024**3, 1),
        'disk_used_gb': round(disk.used / 1024**3, 1),
        'disk_free_gb': round(disk.free / 1024**3, 1),
        'disk_pct': round(disk.percent, 1),
        'load_1m': round(load[0], 2),
        'load_5m': round(load[1], 2),
        'load_15m': round(load[2], 2),
        'uptime_sec': round(uptime_sec),
        'source': 'psutil'
    }))
except ImportError:
    import subprocess, re

    # Fallback to shell commands
    free_out = subprocess.check_output(['free', '-m'], text=True).split('\n')[1].split()
    ram_total = int(free_out[1])
    ram_used = int(free_out[2])
    ram_free = int(free_out[3])

    df_out = subprocess.check_output(['df', '-BG', os.path.expanduser('~')], text=True).split('\n')[1].split()
    disk_total = int(df_out[1].rstrip('G'))
    disk_used = int(df_out[2].rstrip('G'))
    disk_free = int(df_out[3].rstrip('G'))

    load_out = open('/proc/loadavg').read().split()
    uptime_out = open('/proc/uptime').read().split()[0]

    cpu_out = subprocess.check_output(['top', '-bn1'], text=True)
    cpu_match = re.search(r'Cpu.*?([\\d.]+)\\s*us', cpu_out)
    cpu_pct = float(cpu_match.group(1)) if cpu_match else 0.0

    print(json.dumps({
        'cpu_pct': cpu_pct,
        'cpu_cores': int(subprocess.check_output(['nproc'], text=True).strip()),
        'cpu_logical': int(subprocess.check_output(['nproc', '--all'], text=True).strip()),
        'ram_total_mb': ram_total,
        'ram_used_mb': ram_used,
        'ram_free_mb': ram_free,
        'ram_pct': round(ram_used / ram_total * 100, 1),
        'disk_total_gb': disk_total,
        'disk_used_gb': disk_used,
        'disk_free_gb': disk_free,
        'disk_pct': round(disk_used / disk_total * 100, 1),
        'load_1m': float(load_out[0]),
        'load_5m': float(load_out[1]),
        'load_15m': float(load_out[2]),
        'uptime_sec': round(float(uptime_out)),
        'source': 'shell'
    }))
"
`;

    const result = await execRemote(conn, statsCmd);

    let stats = {};
    try {
      stats = JSON.parse(result.stdout);
    } catch (e) {
      // Fallback: use individual shell commands
      stats = await getServerStatusShell(conn);
    }

    // Add human-readable uptime
    stats.uptime_human = formatUptime(stats.uptime_sec || 0);
    stats.ram_total_gb = ((stats.ram_total_mb || 0) / 1024).toFixed(1);
    stats.ram_used_gb = ((stats.ram_used_mb || 0) / 1024).toFixed(1);
    stats.ram_free_gb = ((stats.ram_free_mb || 0) / 1024).toFixed(1);
    stats.timestamp = new Date().toISOString();
    stats.server = serverName;
    stats.reachable = true;

    return stats;

  } catch (err) {
    return {
      reachable: false,
      error: err.message,
      server: serverName,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Fallback stats gathering using individual shell commands (no Python needed).
 */
async function getServerStatusShell(conn) {
  const cmds = {
    cpu_pct:      "top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}' | tr -d '%'",
    cpu_cores:    'nproc',
    ram_total_mb: "free -m | awk 'NR==2{print $2}'",
    ram_used_mb:  "free -m | awk 'NR==2{print $3}'",
    ram_free_mb:  "free -m | awk 'NR==2{print $7}'",
    disk_total_gb:"df -BG ~ | awk 'NR==2{print $2}' | tr -dG",
    disk_used_gb: "df -BG ~ | awk 'NR==2{print $3}' | tr -dG",
    disk_free_gb: "df -BG ~ | awk 'NR==2{print $4}' | tr -dG",
    load_1m:      "cat /proc/loadavg | awk '{print $1}'",
    load_5m:      "cat /proc/loadavg | awk '{print $2}'",
    load_15m:     "cat /proc/loadavg | awk '{print $3}'",
    uptime_sec:   "cat /proc/uptime | awk '{print int($1)}'",
  };

  const stats = { source: 'shell_fallback' };
  for (const [key, cmd] of Object.entries(cmds)) {
    const r = await execRemote(conn, cmd);
    const val = r.stdout.trim();
    stats[key] = val ? (isNaN(val) ? val : parseFloat(val)) : null;
  }
  stats.ram_pct = stats.ram_total_mb ? ((stats.ram_used_mb / stats.ram_total_mb) * 100).toFixed(1) : null;
  stats.disk_pct = stats.disk_total_gb ? ((stats.disk_used_gb / stats.disk_total_gb) * 100).toFixed(1) : null;
  return stats;
}

// =============================================================================
// Heartbeat
// =============================================================================

/**
 * Read the heartbeat file to check if the server's cron job is alive.
 * Heartbeat is written every minute by the cron job set up in deploy.sh.
 *
 * @param {string} serverName
 * @returns {Promise<{alive: boolean, lastBeat: string, ageSeconds: number, ageMinutes: number}>}
 */
async function getHeartbeat(serverName = DEFAULT_SERVER) {
  try {
    const conn = await getConnection(serverName);
    const result = await execRemote(conn, `cat "${HEARTBEAT_FILE}" 2>/dev/null || echo "NOT_FOUND"`);

    if (result.stdout === 'NOT_FOUND' || !result.stdout.trim()) {
      return {
        alive: false,
        lastBeat: null,
        ageSeconds: null,
        ageMinutes: null,
        message: 'Heartbeat file not found. Run deploy.sh first.',
      };
    }

    const lastBeat = result.stdout.trim();
    const beatTime = new Date(lastBeat);
    const ageSeconds = Math.floor((Date.now() - beatTime.getTime()) / 1000);
    const ageMinutes = (ageSeconds / 60).toFixed(1);

    return {
      alive: ageSeconds < 180, // Consider alive if beat within last 3 minutes
      lastBeat,
      ageSeconds,
      ageMinutes: parseFloat(ageMinutes),
      server: serverName,
    };
  } catch (err) {
    return {
      alive: false,
      error: err.message,
      server: serverName,
    };
  }
}

// =============================================================================
// Active Jobs
// =============================================================================

/**
 * Get all active jobs with their current status and resource usage.
 * Cross-references tmux sessions with job metadata.
 *
 * @param {string} serverName
 * @returns {Promise<Array<object>>}
 */
async function getActiveJobs(serverName = DEFAULT_SERVER) {
  try {
    const jobs = await listJobs(serverName);

    // Enrich with progress info
    const enriched = [];
    for (const job of jobs) {
      const progress = await getJobProgress(job.jobId, serverName);
      enriched.push({
        ...job,
        progress,
      });
    }

    return enriched;
  } catch (err) {
    return [];
  }
}

// =============================================================================
// Job Progress
// =============================================================================

/**
 * Get progress for a specific job, with enhanced log parsing.
 *
 * @param {string} jobId
 * @param {string} serverName
 * @returns {Promise<object>}
 */
async function getJobProgress(jobId, serverName = DEFAULT_SERVER) {
  try {
    const conn = await getConnection(serverName);
    const logFile = `${LOGS_BASE}/job_${jobId}.log`;

    // Get last 30 lines
    const result = await execRemote(conn, `tail -n 30 "${logFile}" 2>/dev/null || echo ""`);
    const lines = result.stdout.split('\n').filter(l => l.trim());

    // Progress parsing patterns
    const patterns = [
      // [30/100] or (30/100)
      { re: /[\[(](\d+)\s*\/\s*(\d+)[\])]/, type: 'fraction' },
      // epoch 30/100 or step 30/100 or iter 30/100
      { re: /(?:epoch|step|batch|iter(?:ation)?)\s*[:\s]+(\d+)\s*[\/of]+\s*(\d+)/i, type: 'fraction' },
      // ETA or elapsed patterns from tqdm/sklearn
      { re: /(\d+)%\|/, type: 'percent' },
      // 30% complete
      { re: /(\d+(?:\.\d+)?)\s*%\s*(?:complete|done|finished)?/i, type: 'percent' },
      // Progress: 30/100 or Completed: 30 of 100
      { re: /(?:progress|completed)[:\s]+(\d+)\s*(?:of|\/)\s*(\d+)/i, type: 'fraction' },
      // LightGBM style: [100]  train's ...
      { re: /^\[(\d+)\]\s+(?:train|valid|cv)/i, type: 'lgbm_iter' },
    ];

    let found = false;
    let current = null;
    let total = null;
    let pct = null;
    let matchLine = null;

    for (const line of [...lines].reverse()) {
      for (const { re, type } of patterns) {
        const m = line.match(re);
        if (m) {
          if (type === 'fraction') {
            current = parseInt(m[1]);
            total = parseInt(m[2]);
            pct = total > 0 ? (current / total * 100).toFixed(1) : null;
          } else if (type === 'percent') {
            pct = parseFloat(m[1]).toFixed(1);
          } else if (type === 'lgbm_iter') {
            current = parseInt(m[1]);
            // LightGBM: we don't know total from this pattern alone
          }
          matchLine = line.trim();
          found = true;
          break;
        }
      }
      if (found) break;
    }

    // Check for completion/error in recent lines
    const lastLine = lines[lines.length - 1] || '';
    const isComplete = lastLine.includes('[JOB_DONE:') || lastLine.includes('Done!') || lastLine.includes('Finished');
    const hasError = lastLine.includes('Error') || lastLine.includes('Traceback') || lastLine.includes('FAILED');

    return {
      jobId,
      found,
      current,
      total,
      pct: pct ? parseFloat(pct) : null,
      recentLines: lines.slice(-5),
      matchLine,
      isComplete,
      hasError,
      server: serverName,
    };
  } catch (err) {
    return {
      jobId,
      found: false,
      error: err.message,
      server: serverName,
    };
  }
}

// =============================================================================
// Full Dashboard
// =============================================================================

/**
 * Get a complete snapshot of the server: health + active jobs.
 * Designed to be called periodically for monitoring.
 *
 * @param {string} serverName
 * @returns {Promise<object>}
 */
async function getDashboard(serverName = DEFAULT_SERVER) {
  const [serverStatus, heartbeat, activeJobs] = await Promise.all([
    getServerStatus(serverName),
    getHeartbeat(serverName),
    getActiveJobs(serverName),
  ]);

  return {
    timestamp: new Date().toISOString(),
    server: serverName,
    health: {
      reachable: serverStatus.reachable,
      heartbeat: heartbeat.alive,
      lastHeartbeat: heartbeat.lastBeat,
      heartbeatAge: heartbeat.ageMinutes ? `${heartbeat.ageMinutes}m ago` : 'unknown',
    },
    resources: serverStatus.reachable ? {
      cpu: `${serverStatus.cpu_pct}%`,
      ram: `${serverStatus.ram_used_gb}GB / ${serverStatus.ram_total_gb}GB (${serverStatus.ram_pct}%)`,
      disk: `${serverStatus.disk_used_gb}GB / ${serverStatus.disk_total_gb}GB (${serverStatus.disk_pct}%)`,
      load: `${serverStatus.load_1m} / ${serverStatus.load_5m} / ${serverStatus.load_15m}`,
      uptime: serverStatus.uptime_human,
      cores: serverStatus.cpu_cores,
    } : null,
    jobs: activeJobs.map(j => ({
      jobId: j.jobId,
      name: j.meta?.name || j.jobId,
      running: j.running,
      progress: j.progress?.pct ? `${j.progress.pct}%` : 'unknown',
      lastLine: j.progress?.recentLines?.[j.progress.recentLines.length - 1] || '',
    })),
    jobCount: activeJobs.length,
    raw: { serverStatus, heartbeat },
  };
}

/**
 * Format dashboard as a human-readable string for Discord/console.
 */
function formatDashboard(dashboard) {
  const { health, resources, jobs, timestamp } = dashboard;
  const lines = [];

  lines.push(`**Server: ${dashboard.server}** — ${timestamp.replace('T', ' ').slice(0, 19)} UTC`);
  lines.push('');

  if (!health.reachable) {
    lines.push('OFFLINE — cannot reach server');
    return lines.join('\n');
  }

  // Health
  const hbIcon = health.heartbeat ? 'OK' : 'STALE';
  lines.push(`Heartbeat: ${hbIcon} (${health.heartbeatAge})`);
  lines.push('');

  // Resources
  if (resources) {
    lines.push('**Resources:**');
    lines.push(`  CPU:   ${resources.cpu} (${resources.cores} cores, load: ${resources.load})`);
    lines.push(`  RAM:   ${resources.ram}`);
    lines.push(`  Disk:  ${resources.disk}`);
    lines.push(`  Up:    ${resources.uptime}`);
    lines.push('');
  }

  // Jobs
  if (jobs.length === 0) {
    lines.push('No active jobs.');
  } else {
    lines.push(`**Active Jobs (${jobs.length}):**`);
    for (const job of jobs) {
      lines.push(`  [${job.jobId}] ${job.name}`);
      lines.push(`    Progress: ${job.progress}`);
      if (job.lastLine) lines.push(`    Last: ${job.lastLine.slice(0, 100)}`);
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  getServerStatus,
  getHeartbeat,
  getActiveJobs,
  getJobProgress,
  getDashboard,
  formatDashboard,
};
