/**
 * Financial Agent Launcher
 *
 * Starts the hourly financial agent as a persistent background process
 * that survives Claude session resets.
 *
 * Usage:
 *   node start_financial_agent.js          # Start in foreground
 *   node start_financial_agent.js daemon   # Start as background daemon
 *   node start_financial_agent.js status   # Check status
 *   node start_financial_agent.js stop     # Stop the daemon
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENT_SCRIPT = path.join(__dirname, 'hourly_financial_agent.js');
const PID_FILE = path.join(__dirname, 'data', 'financial_agent.pid');
const LOG_FILE = path.join(__dirname, '..', 'task_logs', 'financial_agent.log');

// Ensure directories exist
const dataDir = path.join(__dirname, 'data');
const logDir = path.join(__dirname, '..', 'task_logs');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Discord notification via MCP bridge
async function notifyDiscord(message) {
  // Write to a file that the main bridge will pick up
  const notifyFile = path.join(__dirname, '..', 'pending_notifications.json');
  let notifications = [];
  if (fs.existsSync(notifyFile)) {
    try {
      notifications = JSON.parse(fs.readFileSync(notifyFile, 'utf8'));
    } catch (e) {
      notifications = [];
    }
  }
  notifications.push({
    message,
    timestamp: new Date().toISOString(),
    source: 'financial_agent'
  });
  fs.writeFileSync(notifyFile, JSON.stringify(notifications, null, 2));
}

function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
  try {
    // Check if process exists
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    // Process doesn't exist, clean up stale PID file
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

function startDaemon() {
  const existingPid = isRunning();
  if (existingPid) {
    console.log(`Financial agent already running (PID: ${existingPid})`);
    return existingPid;
  }

  console.log('Starting financial agent daemon...');

  // Open log file for writing
  const logFd = fs.openSync(LOG_FILE, 'a');

  // Spawn detached process
  const child = spawn('node', [AGENT_SCRIPT, 'start'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: __dirname,
  });

  // Save PID
  fs.writeFileSync(PID_FILE, child.pid.toString());

  // Unref to allow parent to exit
  child.unref();

  console.log(`Financial agent started (PID: ${child.pid})`);
  console.log(`Logs: ${LOG_FILE}`);

  // Notify Discord
  notifyDiscord('📊 **Hourly Financial Agent Started**\n\nScanning watchlist every hour for:\n• Entry opportunities\n• Exit signals\n• Big moves\n• Upcoming catalysts');

  return child.pid;
}

function stopDaemon() {
  const pid = isRunning();
  if (!pid) {
    console.log('Financial agent is not running');
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`Financial agent stopped (PID: ${pid})`);
    notifyDiscord('🛑 Hourly Financial Agent stopped');
    return true;
  } catch (e) {
    console.error('Failed to stop agent:', e.message);
    return false;
  }
}

function getStatus() {
  const pid = isRunning();

  const status = {
    running: !!pid,
    pid: pid || null,
    logFile: LOG_FILE,
    pidFile: PID_FILE,
  };

  // Get last scan from log
  if (fs.existsSync(LOG_FILE)) {
    const logContent = fs.readFileSync(LOG_FILE, 'utf8');
    const lastScanMatch = logContent.match(/\[(\d{4}-\d{2}-\d{2}T[\d:\.]+Z)\] Starting hourly financial scan/g);
    if (lastScanMatch) {
      const lastLine = lastScanMatch[lastScanMatch.length - 1];
      const timestamp = lastLine.match(/\[(.*?)\]/)[1];
      status.lastScan = timestamp;
    }
  }

  // Get watchlist
  const watchlistFile = path.join(__dirname, 'data', 'watchlist.json');
  if (fs.existsSync(watchlistFile)) {
    const watchlist = JSON.parse(fs.readFileSync(watchlistFile, 'utf8'));
    status.watchlist = {
      dickCapital: watchlist.dickCapital?.length || 0,
      independent: watchlist.independent?.length || 0,
      positions: watchlist.positions?.length || 0,
    };
  }

  return status;
}

function showRecentLogs(lines = 50) {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('No logs yet');
    return;
  }

  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const allLines = content.split('\n');
  const recentLines = allLines.slice(-lines).join('\n');
  console.log(recentLines);
}

// CLI
const command = process.argv[2] || 'daemon';

switch (command) {
  case 'daemon':
  case 'start':
    startDaemon();
    break;

  case 'stop':
    stopDaemon();
    break;

  case 'status':
    const status = getStatus();
    console.log('\n📊 Financial Agent Status\n');
    console.log(`Running: ${status.running ? '✅ Yes' : '❌ No'}`);
    if (status.pid) console.log(`PID: ${status.pid}`);
    if (status.lastScan) console.log(`Last Scan: ${status.lastScan}`);
    if (status.watchlist) {
      console.log(`\nWatchlist:`);
      console.log(`  Dick Capital picks: ${status.watchlist.dickCapital}`);
      console.log(`  Independent picks: ${status.watchlist.independent}`);
      console.log(`  Active positions: ${status.watchlist.positions}`);
    }
    console.log(`\nLog file: ${status.logFile}`);
    break;

  case 'logs':
    const numLines = parseInt(process.argv[3]) || 50;
    showRecentLogs(numLines);
    break;

  case 'foreground':
    // Run in foreground (for testing)
    const { scheduler } = require('./hourly_financial_agent.js');
    scheduler.start();
    break;

  case 'scan':
    // Run single scan
    const { runHourlyScan } = require('./hourly_financial_agent.js');
    runHourlyScan().then(result => {
      console.log('\nScan complete. Signals:', result.signals);
    });
    break;

  default:
    console.log(`
Financial Agent Launcher

Commands:
  daemon/start  - Start as background daemon
  stop          - Stop the daemon
  status        - Check agent status
  logs [n]      - Show last n log lines (default 50)
  foreground    - Run in foreground (Ctrl+C to stop)
  scan          - Run a single scan now
`);
}
