#!/usr/bin/env node
/**
 * Rithmic Connection Guard
 *
 * Prevents multiple Rithmic connections by checking for active connections
 * before allowing a new one. The paper engine (run_paper.py) is the SOLE
 * connection authority.
 *
 * Usage:
 *   node rithmic_connection_guard.js check    — exits 0 if safe to connect, 1 if blocked
 *   node rithmic_connection_guard.js kill      — kills any stale Rithmic connections
 *   node rithmic_connection_guard.js status    — prints connection status
 *
 * Integration: Call `check` before any Rithmic connection attempt.
 * QCC, Claude agents, and MCP tools should NEVER connect to Rithmic directly.
 * They should read from:
 *   - QCC /api/health (paper_engine state)
 *   - ws://localhost:8600 (live state WebSocket)
 *   - paper_state.json (file-based fallback)
 */

const { execSync } = require('child_process');
const path = require('path');

const RITHMIC_IP_PREFIX = '160.79.104';
const LOCKFILE = path.join(__dirname, '..', '.rithmic_lock');
const fs = require('fs');

function getActiveConnections() {
  try {
    const output = execSync('netstat -an', { encoding: 'utf8', timeout: 5000 });
    const lines = output.split('\n').filter(l => l.includes(RITHMIC_IP_PREFIX) && l.includes('ESTABLISHED'));
    return lines.map(l => {
      const parts = l.trim().split(/\s+/);
      return { local: parts[1], remote: parts[2], state: parts[3] };
    });
  } catch (e) {
    return [];
  }
}

function getPaperEnginePid() {
  try {
    const output = execSync(
      'powershell -Command "Get-WmiObject Win32_Process -Filter \\"CommandLine LIKE \'%run_paper%\'\\" | Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf8', timeout: 5000 }
    );
    const pids = output.trim().split('\n').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
    return pids;
  } catch (e) {
    return [];
  }
}

function check() {
  const conns = getActiveConnections();
  const pids = getPaperEnginePid();

  if (conns.length > 0) {
    console.error(`BLOCKED: ${conns.length} active Rithmic connection(s) found.`);
    console.error(`Paper engine PIDs: ${pids.length > 0 ? pids.join(', ') : 'NONE'}`);
    conns.forEach(c => console.error(`  ${c.local} -> ${c.remote} [${c.state}]`));
    process.exit(1);
  }

  console.log('OK: No active Rithmic connections. Safe to connect.');
  process.exit(0);
}

function kill() {
  const pids = getPaperEnginePid();
  if (pids.length === 0) {
    console.log('No paper engine processes found.');
    return;
  }

  pids.forEach(pid => {
    try {
      execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8' });
      console.log(`Killed PID ${pid}`);
    } catch (e) {
      console.error(`Failed to kill PID ${pid}: ${e.message}`);
    }
  });

  // Wait for connections to close
  console.log('Waiting 5s for connections to close...');
  setTimeout(() => {
    const conns = getActiveConnections();
    console.log(`Remaining connections: ${conns.length}`);
  }, 5000);
}

function status() {
  const conns = getActiveConnections();
  const pids = getPaperEnginePid();

  console.log('=== Rithmic Connection Status ===');
  console.log(`Active connections: ${conns.length}`);
  conns.forEach(c => console.log(`  ${c.local} -> ${c.remote} [${c.state}]`));
  console.log(`Paper engine PIDs: ${pids.length > 0 ? pids.join(', ') : 'NONE'}`);
  console.log(`Lockfile: ${fs.existsSync(LOCKFILE) ? 'EXISTS' : 'none'}`);
  console.log('=== End ===');
}

const cmd = process.argv[2] || 'status';
switch (cmd) {
  case 'check': check(); break;
  case 'kill': kill(); break;
  case 'status': status(); break;
  default: console.log('Usage: node rithmic_connection_guard.js [check|kill|status]');
}
