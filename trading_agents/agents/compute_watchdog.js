/**
 * Compute Watchdog Agent
 *
 * Permanent monitoring agent for all 3 compute machines.
 * Enforces the "NEVER leave compute idle" rule.
 *
 * Machines:
 *   PC (Neptune)  — Local, RTX 3090 24GB VRAM, Lvl3Quant + TeleClaude
 *   Jupiter       — Dell PowerEdge R630XL, 16-core Xeon, 46GB RAM (SSH via ssh_exec.py)
 *   Saturn        — Dell PowerEdge R810, 48-core Xeon, 62GB RAM (SSH via ssh_saturn.py two-hop)
 *
 * Alerts via Discord #system-status channel.
 * State persisted to trading_agents/data/compute_watchdog_state.json.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Discord channel manager for alerts
let discord;
try {
  discord = require('../discord_channels');
} catch (e) {
  console.warn('[ComputeWatchdog] Discord channels not available:', e.message);
}

// LLM reasoning for intelligent analysis of anomalies
let reasoning;
try {
  reasoning = require('../../utils/llm_reasoning');
} catch (e) {
  console.warn('[ComputeWatchdog] LLM reasoning not available:', e.message);
}

// ── Paths ────────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, '..', 'data', 'compute_watchdog_state.json');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SSH_EXEC_PY = path.join(PROJECT_ROOT, 'utils', 'ssh_exec.py');
const SSH_SATURN_PY = path.join(PROJECT_ROOT, 'utils', 'ssh_saturn.py');
const LVL3QUANT_PATH = 'C:\\Users\\YOUR_USERNAME\\Documents\\Github\\Lvl3Quant';

// ── Alert severity levels ────────────────────────────────────────────────────

const SEVERITY = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

// ── Idle thresholds (milliseconds) ──────────────────────────────────────────

const IDLE_THRESHOLD_CPU = 10;           // <10% CPU = idle
const IDLE_WARNING_MS = 15 * 60 * 1000;  // 15 minutes
const IDLE_CRITICAL_MS = 30 * 60 * 1000; // 30 minutes

// ── Disk / memory thresholds ─────────────────────────────────────────────────

const DISK_CRITICAL_PCT = 5;   // <5% free = CRITICAL
const DISK_WARNING_PCT = 20;   // <20% free = WARNING
const MEM_WARNING_PCT = 90;    // >90% used = WARNING

// ── Max alerts history ───────────────────────────────────────────────────────

const MAX_ALERTS_HISTORY = 50;

// ── Gaming process names (PC idle exception) ─────────────────────────────────

const GAME_PROCESSES = [
  'steam.exe', 'steamwebhelper.exe',
  'EscapeFromTarkov.exe', 'Tarkov.exe',
  'valorant.exe', 'VALORANT-Win64-Shipping.exe',
  'cs2.exe', 'csgo.exe',
  'FortniteClient-Win64-Shipping.exe',
  'RocketLeague.exe',
  'Overwatch.exe',
  'destiny2.exe',
  'javaw.exe',       // Minecraft
  'GTA5.exe', 'RDR2.exe',
  'eldenring.exe',
  'bg3.exe', 'bg3_dx11.exe',
  'Cyberpunk2077.exe',
  'Helldivers2.exe',
  'Palworld-Win64-Shipping.exe',
];


class ComputeWatchdog {
  constructor() {
    this.name = 'Compute Watchdog';
    this.emoji = '\uD83D\uDC41\uFE0F';  // eye emoji
    this.lastRun = null;
    this.idleTracking = {};  // { machine: { startedAt, duration } }
    this.machines = {
      pc: { name: 'PC (Neptune)', type: 'local' },
      jupiter: { name: 'Jupiter', type: 'ssh', ip: 'YOUR_JUPITER_LAN_IP' },
      saturn: { name: 'Saturn', type: 'ssh-hop', ip: 'YOUR_SATURN_IP' },
    };
    this.previousState = null;  // for crash detection (compare tmux sessions)
    this._loadState();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // State persistence
  // ════════════════════════════════════════════════════════════════════════════

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.idleTracking = data.idleTracking || {};
        this.previousState = data.machines || null;
        this.lastRun = data.lastRun ? new Date(data.lastRun) : null;
      }
    } catch (e) {
      console.warn('[ComputeWatchdog] Could not load state:', e.message);
    }
  }

  _saveState(state) {
    try {
      // Keep alert history bounded
      if (state.alerts && state.alerts.length > MAX_ALERTS_HISTORY) {
        state.alerts = state.alerts.slice(-MAX_ALERTS_HISTORY);
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[ComputeWatchdog] Could not save state:', e.message);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Shell helpers
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Run a local command, return stdout or null on failure.
   */
  _exec(command, timeoutMs = 15000) {
    try {
      return execSync(command, {
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      return null;
    }
  }

  /**
   * Execute command on Jupiter via ssh_exec.py.
   * Returns stdout string or null on failure.
   */
  _sshJupiter(command, timeoutMs = 30000) {
    try {
      const escaped = command.replace(/"/g, '\\"');
      const result = execSync(
        `python "${SSH_EXEC_PY}" "${escaped}"`,
        { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return result.trim();
    } catch (e) {
      return null;
    }
  }

  /**
   * Execute command on Saturn via ssh_saturn.py (two-hop through Jupiter).
   * Returns stdout string or null on failure.
   */
  _sshSaturn(command, timeoutMs = 45000) {
    try {
      const escaped = command.replace(/"/g, '\\"');
      const result = execSync(
        `python "${SSH_SATURN_PY}" "${escaped}"`,
        { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return result.trim();
    } catch (e) {
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Main run cycle
  // ════════════════════════════════════════════════════════════════════════════

  async run() {
    const startTime = Date.now();
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${this.emoji} Compute Watchdog starting...`);

    const findings = [];  // collected alerts to send

    // Check all 3 machines in sequence (SSH calls are blocking anyway)
    const pcStatus = await this.checkPC();
    const jupiterStatus = await this.checkJupiter();
    const saturnStatus = await this.checkSaturn();

    // Idle detection
    const pcIdleAlert = this.detectIdle('pc', pcStatus.cpu, pcStatus.isGaming);
    const jupiterIdleAlert = this.detectIdle('jupiter', jupiterStatus.cpu, false);
    const saturnIdleAlert = this.detectIdle('saturn', saturnStatus.cpu, false);

    if (pcIdleAlert) findings.push(pcIdleAlert);
    if (jupiterIdleAlert) findings.push(jupiterIdleAlert);
    if (saturnIdleAlert) findings.push(saturnIdleAlert);

    // Crash detection (compare with previous state)
    const crashAlerts = this.detectCrashes(pcStatus, jupiterStatus, saturnStatus);
    findings.push(...crashAlerts);

    // Resource threshold alerts
    findings.push(...this._checkThresholds('pc', pcStatus));
    findings.push(...this._checkThresholds('jupiter', jupiterStatus));
    findings.push(...this._checkThresholds('saturn', saturnStatus));

    // Build state object for persistence and dashboard
    const now = new Date().toISOString();
    const state = {
      lastRun: now,
      machines: {
        pc: {
          status: pcStatus.reachable ? 'online' : 'unreachable',
          cpu: pcStatus.cpu,
          mem: pcStatus.mem,
          gpu: pcStatus.gpu,
          gpuMem: pcStatus.gpuMem,
          disk: pcStatus.disk,
          activeJobs: pcStatus.activeJobs,
          isGaming: pcStatus.isGaming,
          lastChecked: now,
        },
        jupiter: {
          status: jupiterStatus.reachable ? 'online' : 'unreachable',
          cpu: jupiterStatus.cpu,
          mem: jupiterStatus.mem,
          disk: jupiterStatus.disk,
          activeJobs: jupiterStatus.activeJobs,
          tmuxSessions: jupiterStatus.tmuxSessions,
          lastChecked: now,
        },
        saturn: {
          status: saturnStatus.reachable ? 'online' : 'unreachable',
          cpu: saturnStatus.cpu,
          mem: saturnStatus.mem,
          disk: saturnStatus.disk,
          activeJobs: saturnStatus.activeJobs,
          tmuxSessions: saturnStatus.tmuxSessions,
          lastChecked: now,
        },
      },
      alerts: [],
      idleTracking: this.idleTracking,
    };

    // Preserve recent alert history from previous state
    try {
      if (fs.existsSync(STATE_FILE)) {
        const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        state.alerts = prev.alerts || [];
      }
    } catch (e) { /* start fresh */ }

    // Append new alerts
    for (const f of findings) {
      state.alerts.push({ ...f, time: now });
    }

    // Save state
    this.previousState = state.machines;
    this._saveState(state);

    // Send alerts to Discord
    await this.alertIfNeeded(findings, state);

    this.lastRun = new Date();
    const elapsed = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] ${this.emoji} Compute Watchdog completed in ${elapsed}ms — ` +
      `PC:${pcStatus.cpu}% JUP:${jupiterStatus.cpu}% SAT:${saturnStatus.cpu}% | ${findings.length} alert(s)`);

    return state;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PC (Neptune) — Local checks
  // ════════════════════════════════════════════════════════════════════════════

  async checkPC() {
    const result = {
      reachable: true,
      cpu: 0,
      mem: 0,
      gpu: 0,
      gpuMem: 0,
      disk: 0,
      activeJobs: [],
      isGaming: false,
    };

    try {
      // ── CPU utilization ──
      // Use wmic to get CPU load on Windows
      const cpuRaw = this._exec(
        'wmic cpu get loadpercentage /value'
      );
      if (cpuRaw) {
        const match = cpuRaw.match(/LoadPercentage=(\d+)/);
        if (match) result.cpu = parseInt(match[1], 10);
      }

      // ── Memory utilization ──
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      result.mem = Math.round(((totalMem - freeMem) / totalMem) * 100);

      // ── GPU utilization via nvidia-smi ──
      const gpuRaw = this._exec(
        'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits'
      );
      if (gpuRaw) {
        const parts = gpuRaw.split(',').map(s => s.trim());
        if (parts.length >= 3) {
          result.gpu = parseInt(parts[0], 10) || 0;
          const memUsed = parseInt(parts[1], 10) || 0;
          const memTotal = parseInt(parts[2], 10) || 1;
          result.gpuMem = Math.round((memUsed / memTotal) * 100);
        }
      }

      // ── Disk space (C: drive) ──
      const diskRaw = this._exec(
        'wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /value'
      );
      if (diskRaw) {
        const freeMatch = diskRaw.match(/FreeSpace=(\d+)/);
        const sizeMatch = diskRaw.match(/Size=(\d+)/);
        if (freeMatch && sizeMatch) {
          const free = parseInt(freeMatch[1], 10);
          const total = parseInt(sizeMatch[1], 10);
          result.disk = Math.round((free / total) * 100);  // percent FREE
        }
      }

      // ── Active compute jobs (python, node training processes) ──
      const taskRaw = this._exec(
        'tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH'
      );
      if (taskRaw && !taskRaw.includes('No tasks')) {
        const pyLines = taskRaw.split('\n').filter(l => l.includes('python'));
        for (const line of pyLines) {
          const cols = line.split(',').map(s => s.replace(/"/g, '').trim());
          if (cols.length >= 2) {
            result.activeJobs.push({ type: 'python', pid: cols[1], name: cols[0] });
          }
        }
      }

      // Check for node training jobs
      const nodeRaw = this._exec(
        'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH'
      );
      if (nodeRaw && !nodeRaw.includes('No tasks')) {
        const nodeLines = nodeRaw.split('\n').filter(l => l.includes('node'));
        for (const line of nodeLines) {
          const cols = line.split(',').map(s => s.replace(/"/g, '').trim());
          if (cols.length >= 2) {
            result.activeJobs.push({ type: 'node', pid: cols[1], name: cols[0] });
          }
        }
      }

      // ── GPU processes (what's running on the GPU) ──
      const gpuProcs = this._exec(
        'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits'
      );
      if (gpuProcs && gpuProcs.trim().length > 0) {
        for (const line of gpuProcs.split('\n')) {
          const parts = line.split(',').map(s => s.trim());
          if (parts.length >= 3) {
            result.activeJobs.push({
              type: 'gpu',
              pid: parts[0],
              name: parts[1],
              gpuMemMB: parts[2],
            });
          }
        }
      }

      // ── Gaming detection ──
      const taskListAll = this._exec('tasklist /FO CSV /NH');
      if (taskListAll) {
        const runningProcs = taskListAll.toLowerCase();
        for (const game of GAME_PROCESSES) {
          if (runningProcs.includes(game.toLowerCase())) {
            result.isGaming = true;
            break;
          }
        }
      }

    } catch (e) {
      console.error('[ComputeWatchdog] PC check error:', e.message);
      result.reachable = false;
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Jupiter — SSH checks via ssh_exec.py
  // ════════════════════════════════════════════════════════════════════════════

  async checkJupiter() {
    const result = {
      reachable: false,
      cpu: 0,
      mem: 0,
      disk: 0,
      activeJobs: [],
      tmuxSessions: [],
    };

    // Single compound command to minimize SSH round-trips
    const cmd = [
      // CPU: average idle from mpstat (or top fallback)
      "top -bn1 | grep 'Cpu(s)' | awk '{print 100 - $8}'",
      // Memory: used percent
      "free | awk '/Mem:/{printf \"%.0f\", ($3/$2)*100}'",
      // Disk: percent used on root
      "df -h / | awk 'NR==2{print $5}' | tr -d '%'",
      // Tmux sessions
      "tmux list-sessions 2>/dev/null || echo 'NO_TMUX'",
      // Running python processes (command lines)
      "ps aux --sort=-%cpu | grep -E 'python|cargo' | grep -v grep | head -10",
    ].join(' && echo "---SEPARATOR---" && ');

    const raw = this._sshJupiter(cmd);
    if (raw === null) {
      console.warn('[ComputeWatchdog] Jupiter unreachable');
      return result;
    }

    result.reachable = true;

    try {
      const sections = raw.split('---SEPARATOR---').map(s => s.trim());

      // CPU
      if (sections[0]) {
        const cpuVal = parseFloat(sections[0]);
        if (!isNaN(cpuVal)) result.cpu = Math.round(cpuVal);
      }

      // Memory
      if (sections[1]) {
        const memVal = parseInt(sections[1], 10);
        if (!isNaN(memVal)) result.mem = memVal;
      }

      // Disk (percent USED — convert to percent FREE for consistency)
      if (sections[2]) {
        const diskUsed = parseInt(sections[2], 10);
        if (!isNaN(diskUsed)) result.disk = 100 - diskUsed;  // percent FREE
      }

      // Tmux sessions
      if (sections[3] && sections[3] !== 'NO_TMUX') {
        const lines = sections[3].split('\n').filter(l => l.trim());
        for (const line of lines) {
          const nameMatch = line.match(/^([^:]+):/);
          const windowMatch = line.match(/(\d+) windows/);
          const attachedMatch = line.includes('(attached)');
          result.tmuxSessions.push({
            name: nameMatch ? nameMatch[1].trim() : line.trim(),
            windows: windowMatch ? parseInt(windowMatch[1], 10) : 0,
            attached: attachedMatch,
          });
        }
      }

      // Running processes
      if (sections[4]) {
        const procLines = sections[4].split('\n').filter(l => l.trim());
        for (const line of procLines) {
          // Skip the [Connected via ...] prefix line from ssh_exec.py
          if (line.startsWith('[Connected')) continue;
          const parts = line.split(/\s+/);
          if (parts.length >= 11) {
            const cpu = parseFloat(parts[2]) || 0;
            const mem = parseFloat(parts[3]) || 0;
            const cmd = parts.slice(10).join(' ');
            if (cpu > 0.5 || mem > 0.5) {
              result.activeJobs.push({
                type: cmd.includes('python') ? 'python' : cmd.includes('cargo') ? 'cargo' : 'other',
                pid: parts[1],
                cpu: cpu,
                mem: mem,
                command: cmd.substring(0, 120),
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('[ComputeWatchdog] Jupiter parse error:', e.message);
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Saturn — SSH checks via ssh_saturn.py (two-hop through Jupiter)
  // ════════════════════════════════════════════════════════════════════════════

  async checkSaturn() {
    const result = {
      reachable: false,
      cpu: 0,
      mem: 0,
      disk: 0,
      activeJobs: [],
      tmuxSessions: [],
    };

    // Single compound command
    const cmd = [
      "top -bn1 | grep 'Cpu(s)' | awk '{print 100 - $8}'",
      "free | awk '/Mem:/{printf \"%.0f\", ($3/$2)*100}'",
      "df -h / | awk 'NR==2{print $5}' | tr -d '%'",
      "tmux list-sessions 2>/dev/null || echo 'NO_TMUX'",
      "ps aux --sort=-%cpu | grep -E 'python|cargo' | grep -v grep | head -10",
    ].join(' && echo "---SEPARATOR---" && ');

    const raw = this._sshSaturn(cmd);
    if (raw === null) {
      console.warn('[ComputeWatchdog] Saturn unreachable');
      return result;
    }

    result.reachable = true;

    try {
      const sections = raw.split('---SEPARATOR---').map(s => s.trim());

      // CPU
      if (sections[0]) {
        // Filter out the "Running on Saturn:" prefix line from ssh_saturn.py
        const cpuLine = sections[0].split('\n').pop();
        const cpuVal = parseFloat(cpuLine);
        if (!isNaN(cpuVal)) result.cpu = Math.round(cpuVal);
      }

      // Memory
      if (sections[1]) {
        const memVal = parseInt(sections[1], 10);
        if (!isNaN(memVal)) result.mem = memVal;
      }

      // Disk (percent USED -> percent FREE)
      if (sections[2]) {
        const diskUsed = parseInt(sections[2], 10);
        if (!isNaN(diskUsed)) result.disk = 100 - diskUsed;
      }

      // Tmux sessions
      if (sections[3] && sections[3] !== 'NO_TMUX') {
        const lines = sections[3].split('\n').filter(l => l.trim());
        for (const line of lines) {
          const nameMatch = line.match(/^([^:]+):/);
          const windowMatch = line.match(/(\d+) windows/);
          const attachedMatch = line.includes('(attached)');
          result.tmuxSessions.push({
            name: nameMatch ? nameMatch[1].trim() : line.trim(),
            windows: windowMatch ? parseInt(windowMatch[1], 10) : 0,
            attached: attachedMatch,
          });
        }
      }

      // Running processes
      if (sections[4]) {
        const procLines = sections[4].split('\n').filter(l => l.trim());
        for (const line of procLines) {
          if (line.startsWith('Running on Saturn')) continue;
          if (line.startsWith('Method:')) continue;
          const parts = line.split(/\s+/);
          if (parts.length >= 11) {
            const cpu = parseFloat(parts[2]) || 0;
            const mem = parseFloat(parts[3]) || 0;
            const cmd = parts.slice(10).join(' ');
            if (cpu > 0.5 || mem > 0.5) {
              result.activeJobs.push({
                type: cmd.includes('python') ? 'python' : cmd.includes('cargo') ? 'cargo' : 'other',
                pid: parts[1],
                cpu: cpu,
                mem: mem,
                command: cmd.substring(0, 120),
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('[ComputeWatchdog] Saturn parse error:', e.message);
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Idle detection
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Track idle state for a machine. Returns an alert object if thresholds exceeded,
   * or null if the machine is busy / exception applies.
   */
  detectIdle(machine, cpuPercent, isGaming = false) {
    const now = Date.now();

    // PC gaming exception: idle CPU is expected if user is gaming
    if (machine === 'pc' && isGaming) {
      delete this.idleTracking[machine];
      return null;
    }

    // Machine unreachable: don't count as idle (separate alert handles that)
    if (cpuPercent === 0 && !this.idleTracking[machine]) {
      return null;
    }

    if (cpuPercent < IDLE_THRESHOLD_CPU) {
      // Machine is idle — start or continue tracking
      if (!this.idleTracking[machine]) {
        this.idleTracking[machine] = { startedAt: now, lastCpu: cpuPercent };
      }
      this.idleTracking[machine].lastCpu = cpuPercent;

      const duration = now - this.idleTracking[machine].startedAt;

      if (duration >= IDLE_CRITICAL_MS) {
        return {
          severity: SEVERITY.CRITICAL,
          machine,
          machineName: this.machines[machine].name,
          type: 'idle',
          message: `${this.machines[machine].name} IDLE for ${Math.round(duration / 60000)} minutes! CPU: ${cpuPercent}%. NEVER leave compute idle.`,
          duration,
        };
      } else if (duration >= IDLE_WARNING_MS) {
        return {
          severity: SEVERITY.WARNING,
          machine,
          machineName: this.machines[machine].name,
          type: 'idle',
          message: `${this.machines[machine].name} idle for ${Math.round(duration / 60000)} minutes (CPU: ${cpuPercent}%). Consider assigning work.`,
          duration,
        };
      }
    } else {
      // Machine is busy — clear idle tracking
      if (this.idleTracking[machine]) {
        delete this.idleTracking[machine];
      }
    }

    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Crash detection
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Compare current state with previous state to detect:
   * - Tmux sessions that disappeared (server jobs died)
   * - GPU processes that vanished (GPU crash)
   * - Machines that went from online to unreachable
   */
  detectCrashes(pcStatus, jupiterStatus, saturnStatus) {
    const alerts = [];
    if (!this.previousState) return alerts;

    const prev = this.previousState;

    // ── Machine unreachable ──
    if (prev.jupiter?.status === 'online' && !jupiterStatus.reachable) {
      alerts.push({
        severity: SEVERITY.CRITICAL,
        machine: 'jupiter',
        machineName: 'Jupiter',
        type: 'unreachable',
        message: 'Jupiter went OFFLINE! Was online on previous check.',
      });
    }
    if (prev.saturn?.status === 'online' && !saturnStatus.reachable) {
      alerts.push({
        severity: SEVERITY.CRITICAL,
        machine: 'saturn',
        machineName: 'Saturn',
        type: 'unreachable',
        message: 'Saturn went OFFLINE! Was online on previous check.',
      });
    }

    // ── Tmux sessions disappeared on Jupiter ──
    const prevJupTmux = (prev.jupiter?.tmuxSessions || []).map(s => s.name || s);
    const currJupTmux = jupiterStatus.tmuxSessions.map(s => s.name);
    for (const session of prevJupTmux) {
      if (typeof session === 'string' && !currJupTmux.includes(session) && jupiterStatus.reachable) {
        alerts.push({
          severity: SEVERITY.WARNING,
          machine: 'jupiter',
          machineName: 'Jupiter',
          type: 'tmux_died',
          message: `Jupiter tmux session "${session}" disappeared! Job may have crashed.`,
        });
      }
    }

    // ── Tmux sessions disappeared on Saturn ──
    const prevSatTmux = (prev.saturn?.tmuxSessions || []).map(s => s.name || s);
    const currSatTmux = saturnStatus.tmuxSessions.map(s => s.name);
    for (const session of prevSatTmux) {
      if (typeof session === 'string' && !currSatTmux.includes(session) && saturnStatus.reachable) {
        alerts.push({
          severity: SEVERITY.WARNING,
          machine: 'saturn',
          machineName: 'Saturn',
          type: 'tmux_died',
          message: `Saturn tmux session "${session}" disappeared! Job may have crashed.`,
        });
      }
    }

    // ── GPU processes disappeared on PC (GPU crash) ──
    const prevGpuJobs = (prev.pc?.activeJobs || []).filter(j => j.type === 'gpu');
    const currGpuJobs = pcStatus.activeJobs.filter(j => j.type === 'gpu');
    if (prevGpuJobs.length > 0 && currGpuJobs.length === 0 && pcStatus.reachable) {
      alerts.push({
        severity: SEVERITY.CRITICAL,
        machine: 'pc',
        machineName: 'PC (Neptune)',
        type: 'gpu_crash',
        message: `GPU processes vanished! Had ${prevGpuJobs.length} GPU job(s) on previous check, now 0. Possible GPU crash.`,
      });
    }

    return alerts;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Threshold checks (disk, memory)
  // ════════════════════════════════════════════════════════════════════════════

  _checkThresholds(machine, status) {
    const alerts = [];
    const name = this.machines[machine].name;

    if (!status.reachable) {
      // Only alert unreachable if we don't already have a crash-detection alert for it
      // (crash detection handles online->offline transition)
      if (!this.previousState || this.previousState[machine]?.status !== 'online') {
        alerts.push({
          severity: SEVERITY.CRITICAL,
          machine,
          machineName: name,
          type: 'unreachable',
          message: `${name} is unreachable!`,
        });
      }
      return alerts;
    }

    // Disk space (status.disk = percent FREE)
    if (status.disk > 0 && status.disk < DISK_CRITICAL_PCT) {
      alerts.push({
        severity: SEVERITY.CRITICAL,
        machine,
        machineName: name,
        type: 'disk_full',
        message: `${name} disk almost full! Only ${status.disk}% free.`,
      });
    } else if (status.disk > 0 && status.disk < DISK_WARNING_PCT) {
      alerts.push({
        severity: SEVERITY.WARNING,
        machine,
        machineName: name,
        type: 'disk_low',
        message: `${name} disk space low: ${status.disk}% free.`,
      });
    }

    // Memory
    if (status.mem > MEM_WARNING_PCT) {
      alerts.push({
        severity: SEVERITY.WARNING,
        machine,
        machineName: name,
        type: 'mem_high',
        message: `${name} memory high: ${status.mem}% used.`,
      });
    }

    return alerts;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Status generation (for dashboard / on-demand queries)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Generate a human-readable status summary.
   */
  async generateStatus() {
    try {
      if (!fs.existsSync(STATE_FILE)) return 'No compute watchdog data yet. Run the agent first.';
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const m = state.machines;

      let summary = `**${this.emoji} Compute Watchdog Status**\n`;
      summary += `Last check: ${state.lastRun || 'never'}\n\n`;

      // PC
      const pc = m.pc;
      const pcIcon = pc.status === 'online' ? '\u2705' : '\u274C';
      summary += `${pcIcon} **PC (Neptune):** CPU ${pc.cpu}% | RAM ${pc.mem}% | GPU ${pc.gpu}% (VRAM ${pc.gpuMem || 0}%) | Disk ${pc.disk}% free`;
      if (pc.isGaming) summary += ' [GAMING]';
      summary += `\n   Jobs: ${(pc.activeJobs || []).length} process(es)\n\n`;

      // Jupiter
      const jup = m.jupiter;
      const jupIcon = jup.status === 'online' ? '\u2705' : '\u274C';
      summary += `${jupIcon} **Jupiter:** CPU ${jup.cpu}% | RAM ${jup.mem}% | Disk ${jup.disk}% free\n`;
      summary += `   Tmux: ${(jup.tmuxSessions || []).map(s => s.name || s).join(', ') || 'none'}\n`;
      summary += `   Jobs: ${(jup.activeJobs || []).length} process(es)\n\n`;

      // Saturn
      const sat = m.saturn;
      const satIcon = sat.status === 'online' ? '\u2705' : '\u274C';
      summary += `${satIcon} **Saturn:** CPU ${sat.cpu}% | RAM ${sat.mem}% | Disk ${sat.disk}% free\n`;
      summary += `   Tmux: ${(sat.tmuxSessions || []).map(s => s.name || s).join(', ') || 'none'}\n`;
      summary += `   Jobs: ${(sat.activeJobs || []).length} process(es)\n\n`;

      // Recent alerts
      const recentAlerts = (state.alerts || []).slice(-5);
      if (recentAlerts.length > 0) {
        summary += `**Recent Alerts:**\n`;
        for (const a of recentAlerts) {
          const icon = a.severity === 'CRITICAL' ? '\uD83D\uDD34' : a.severity === 'WARNING' ? '\uD83D\uDFE1' : '\uD83D\uDD35';
          summary += `${icon} ${a.message}\n`;
        }
      }

      // Idle tracking
      const idleKeys = Object.keys(state.idleTracking || {});
      if (idleKeys.length > 0) {
        summary += `\n**Idle Machines:**\n`;
        for (const key of idleKeys) {
          const info = state.idleTracking[key];
          const mins = Math.round((Date.now() - info.startedAt) / 60000);
          summary += `\u26A0\uFE0F ${this.machines[key]?.name || key}: idle ${mins} min (CPU ${info.lastCpu}%)\n`;
        }
      }

      return summary;
    } catch (e) {
      return `Error generating status: ${e.message}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Alert dispatch
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Send alerts to Discord #system-status channel.
   * Only sends CRITICAL and WARNING; INFO is logged silently.
   */
  async alertIfNeeded(findings, state) {
    if (!discord || findings.length === 0) return;

    const criticals = findings.filter(f => f.severity === SEVERITY.CRITICAL);
    const warnings = findings.filter(f => f.severity === SEVERITY.WARNING);

    // Always send criticals immediately
    if (criticals.length > 0) {
      let msg = `\uD83D\uDD34 **COMPUTE WATCHDOG - CRITICAL**\n\n`;
      for (const c of criticals) {
        msg += `\u274C ${c.message}\n`;
      }
      msg += `\nTime: ${new Date().toISOString()}`;
      try {
        await discord.systemStatus(msg);
      } catch (e) {
        console.error('[ComputeWatchdog] Failed to send CRITICAL alert:', e.message);
      }
    }

    // Send warnings (batched)
    if (warnings.length > 0) {
      let msg = `\uD83D\uDFE1 **COMPUTE WATCHDOG - WARNING**\n\n`;
      for (const w of warnings) {
        msg += `\u26A0\uFE0F ${w.message}\n`;
      }
      msg += `\nTime: ${new Date().toISOString()}`;
      try {
        await discord.systemStatus(msg);
      } catch (e) {
        console.error('[ComputeWatchdog] Failed to send WARNING alert:', e.message);
      }
    }

    // If we have CRITICAL idle alerts and LLM is available, ask for suggestions
    const idleAlerts = criticals.filter(f => f.type === 'idle');
    if (idleAlerts.length > 0 && reasoning) {
      try {
        const prompt = `A compute machine is sitting idle and wasting resources. Here is the current state of all machines:\n\n${JSON.stringify(state.machines, null, 2)}\n\nIdle alerts:\n${idleAlerts.map(a => `- ${a.message}`).join('\n')}\n\nThe project is Lvl3Quant (quantitative trading ML). These machines should be running training jobs, backtests, MBO fill sims, or parameter sweeps at all times.\n\nSuggest 2-3 specific jobs that could be assigned to the idle machine(s) based on typical ML/quant workloads. Keep it brief (3-4 sentences total).`;

        const result = await reasoning.callLLMWithFallback([
          { role: 'system', content: 'You are a compute resource manager for a quantitative trading ML project. Be specific and actionable.' },
          { role: 'user', content: prompt },
        ], { temperature: 0.3, maxTokens: 300 });

        if (result && result.content) {
          const suggestion = `\uD83E\uDD16 **Watchdog Suggestion:**\n${result.content}`;
          await discord.systemStatus(suggestion);
        }
      } catch (e) {
        // LLM suggestion is best-effort, don't fail on it
        console.warn('[ComputeWatchdog] LLM suggestion failed:', e.message);
      }
    }
  }
}

module.exports = ComputeWatchdog;
