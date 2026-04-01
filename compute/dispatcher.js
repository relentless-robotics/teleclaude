/**
 * dispatcher.js — Compute Dispatcher for PC + Jupiter Server
 *
 * Intelligently routes tasks between the local PC (GPU + fast CPU, 34GB RAM)
 * and the Jupiter server (CPU only, 46GB RAM). Claude remains the orchestrator —
 * this is a routing tool Claude uses to manage parallel work.
 *
 * Routing Logic:
 *   GPU required        → PC only (or QUEUE if gaming mode is ON)
 *   estimatedRam > 30GB → Server only (PC can't handle it)
 *   Gaming mode ON      → Server for everything
 *   CPU task, both idle → Server preferred (keep PC free)
 *   CPU task, both busy → QUEUE
 *
 * Usage:
 *   const dispatcher = require('./compute/dispatcher');
 *   dispatcher.addTask({ name: '...', template: 'multi_alpha_scan', params: {...} });
 *   await dispatcher.dispatch();
 *   await dispatcher.checkAll();
 *   const status = dispatcher.getStatus();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const STATE_FILE = path.join(__dirname, 'state.json');

// =============================================================================
// Task ID Generation
// =============================================================================

function generateTaskId(name) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString('hex');
  // Sanitize name for ID use
  const slug = (name || 'task').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  return `${slug}_${ts}_${rand}`;
}

// =============================================================================
// ComputeDispatcher
// =============================================================================

class ComputeDispatcher {
  constructor() {
    this.queue = [];
    this.running = {};
    this.completed = {};
    this.failed = {};
    this.gamingMode = false;

    this.machines = {
      pc: {
        name: 'PC',
        host: 'localhost',
        capabilities: ['gpu', 'cpu', 'fast_single_thread'],
        gpu: 'RTX 3090',
        ram_gb: 34,
        status: 'available',   // available, busy, gaming
        maxConcurrent: 1,      // Only 1 heavy task at a time (RAM limited)
        activeJobs: [],
      },
      server: {
        name: 'Jupiter',
        host: process.env.JUPITER_HOST || '192.168.137.2',
        username: process.env.JUPITER_USER || 'jupiter',
        password: process.env.JUPITER_PASS || '',
        capabilities: ['cpu', 'high_ram'],
        gpu: null,
        ram_gb: 46,
        status: 'available',
        maxConcurrent: 2,      // Can run 2 tasks if RAM permits
        activeJobs: [],
      },
    };

    // Load persisted state
    this._loadState();
  }

  // ===========================================================================
  // Task Management
  // ===========================================================================

  /**
   * Add a task to the queue.
   *
   * @param {object} taskDef
   * @param {string}   taskDef.name          - Human-readable name
   * @param {string}   [taskDef.template]    - Key from TASK_TEMPLATES
   * @param {object}   [taskDef.params]      - Template interpolation params
   * @param {string}   [taskDef.type]        - 'cpu', 'gpu', 'high_ram'
   * @param {string[]} [taskDef.requires]    - Required capabilities: ['gpu'], ['high_ram'], etc.
   * @param {string[]} [taskDef.dependsOn]   - Array of task IDs that must complete first
   * @param {number}   [taskDef.estimatedRam]  - GB of RAM estimated
   * @param {string}   [taskDef.estimatedTime] - Human string like '2-4 hours'
   * @param {number}   [taskDef.priority]    - Lower = higher priority (default 5)
   * @param {object}   [taskDef.command]     - { pc: '...', server: '...' } override
   * @param {object}   [taskDef.workingDir]  - { pc: '...', server: '...' } override
   *
   * @returns {string} taskId
   */
  addTask(taskDef) {
    const { TASK_TEMPLATES } = require('./tasks');

    const id = taskDef.id || generateTaskId(taskDef.name || taskDef.template || 'task');

    // Merge template if provided
    let merged = { ...taskDef };
    if (taskDef.template && TASK_TEMPLATES[taskDef.template]) {
      const tmpl = TASK_TEMPLATES[taskDef.template];
      merged = {
        ...tmpl,
        ...taskDef,
        // Keep template command/workingDir if not overridden
        command:    taskDef.command    || tmpl.command,
        workingDir: taskDef.workingDir || tmpl.workingDir,
        requires:   taskDef.requires   || tmpl.requires   || [],
        estimatedRam:  taskDef.estimatedRam  != null ? taskDef.estimatedRam  : tmpl.estimatedRam,
        estimatedTime: taskDef.estimatedTime || tmpl.estimatedTime,
      };
    }

    // Interpolate params into command strings
    const params = taskDef.params || {};
    if (merged.command) {
      const interpolate = (str) => {
        if (typeof str !== 'string') return str;
        return str.replace(/\{(\w+)\}/g, (_, k) => params[k] !== undefined ? params[k] : `{${k}}`);
      };
      merged.command = {
        pc:     interpolate(merged.command.pc),
        server: interpolate(merged.command.server),
      };
    }

    const task = {
      id,
      name:          merged.name || id,
      template:      taskDef.template || null,
      params,
      type:          merged.type || 'cpu',
      requires:      merged.requires || [],
      dependsOn:     merged.dependsOn || [],
      estimatedRam:  merged.estimatedRam || 0,
      estimatedTime: merged.estimatedTime || 'unknown',
      priority:      merged.priority != null ? merged.priority : 5,
      command:       merged.command || null,
      workingDir:    merged.workingDir || null,
      status:        'queued',
      addedAt:       new Date().toISOString(),
      machine:       null,
      jobHandle:     null,
      startedAt:     null,
      completedAt:   null,
      error:         null,
    };

    this.queue.push(task);
    // Sort by priority (ascending — lower number = higher priority)
    this.queue.sort((a, b) => a.priority - b.priority);

    this._saveState();

    console.log(`[dispatcher] Queued task "${task.name}" (${id}) — requires: [${task.requires.join(', ')}], estimatedRam: ${task.estimatedRam}GB`);
    return id;
  }

  /**
   * Remove a task from the queue by ID.
   * @returns {boolean} true if removed
   */
  removeTask(taskId) {
    const before = this.queue.length;
    this.queue = this.queue.filter(t => t.id !== taskId);
    this._saveState();
    return this.queue.length < before;
  }

  // ===========================================================================
  // Gaming Mode
  // ===========================================================================

  /**
   * Enable or disable gaming mode.
   * When ON: all tasks route to server. PC tasks that can't run on server are queued.
   */
  setGamingMode(enabled) {
    this.gamingMode = !!enabled;
    if (enabled) {
      this.machines.pc.status = 'gaming';
      console.log('[dispatcher] Gaming mode ON — all compute routed to Jupiter server');
    } else {
      if (this.machines.pc.status === 'gaming') {
        this.machines.pc.status = this.machines.pc.activeJobs.length > 0 ? 'busy' : 'available';
      }
      console.log('[dispatcher] Gaming mode OFF — PC available again');
    }
    this._saveState();
  }

  // ===========================================================================
  // Routing Logic
  // ===========================================================================

  /**
   * Determine which machine to assign a given task to.
   * Returns 'pc', 'server', or 'queue' (can't dispatch right now).
   *
   * @param {object} task
   * @returns {'pc'|'server'|'queue'}
   */
  _routeTask(task) {
    const { pc, server } = this.machines;
    const requires = task.requires || [];
    const ram = task.estimatedRam || 0;

    // ---- GPU required --------------------------------------------------------
    if (requires.includes('gpu')) {
      if (this.gamingMode) {
        return 'queue'; // GPU tasks wait until gaming is off
      }
      if (pc.activeJobs.length < pc.maxConcurrent) {
        return 'pc';
      }
      return 'queue';
    }

    // ---- High RAM required (>30GB, PC can't handle it) -----------------------
    if (ram > 30 || requires.includes('high_ram')) {
      if (server.activeJobs.length < server.maxConcurrent) {
        return 'server';
      }
      return 'queue';
    }

    // ---- Gaming mode: everything goes to server ------------------------------
    if (this.gamingMode) {
      if (server.activeJobs.length < server.maxConcurrent) {
        return 'server';
      }
      return 'queue';
    }

    // ---- Normal CPU task: prefer server to keep PC free ----------------------
    const serverFree = server.activeJobs.length < server.maxConcurrent;
    const pcFree     = pc.activeJobs.length < pc.maxConcurrent;

    if (serverFree && pcFree) {
      return 'server'; // Both free → prefer server
    }
    if (serverFree) {
      return 'server'; // Server free, PC busy
    }
    if (pcFree) {
      return 'pc';     // PC free, server busy
    }

    return 'queue'; // Both busy
  }

  /**
   * Check if all dependencies for a task are satisfied (completed successfully).
   *
   * @param {object} task
   * @returns {boolean}
   */
  _depsMetFor(task) {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;

    for (const depId of task.dependsOn) {
      const completed = this.completed[depId];
      if (!completed) return false;
      // If dependency failed, this task is blocked
      if (completed.status === 'failed') {
        console.warn(`[dispatcher] Task "${task.name}" has a failed dependency: ${depId}`);
        return false;
      }
    }
    return true;
  }

  // ===========================================================================
  // Dispatch
  // ===========================================================================

  /**
   * Route and launch all queued tasks that are ready to run.
   * Called by Claude (or checkAll) whenever capacity may be available.
   *
   * @returns {Promise<Array<{taskId, machine, jobHandle}>>} Dispatched tasks info
   */
  async dispatch() {
    const executor = require('./executor');
    const dispatched = [];

    // Refresh machine status from running jobs first
    this._syncMachineStatus();

    // Work through queue in priority order
    const toDispatch = [];
    for (const task of this.queue) {
      if (!this._depsMetFor(task)) {
        console.log(`[dispatcher] Task "${task.name}" waiting on dependencies`);
        continue;
      }

      const machine = this._routeTask(task);
      if (machine === 'queue') {
        console.log(`[dispatcher] Task "${task.name}" cannot dispatch yet (capacity full)`);
        continue; // Can't run now
      }

      toDispatch.push({ task, machine });
    }

    // Actually dispatch the selected tasks
    for (const { task, machine } of toDispatch) {
      try {
        console.log(`[dispatcher] Dispatching "${task.name}" → ${machine.toUpperCase()}`);

        const jobHandle = await executor.execute(task, machine);

        // Update task state
        task.status    = 'running';
        task.machine   = machine;
        task.startedAt = new Date().toISOString();
        task.jobHandle = jobHandle;

        // Move from queue to running
        this.queue = this.queue.filter(t => t.id !== task.id);
        this.running[task.id] = task;

        // Update machine active jobs
        this.machines[machine].activeJobs.push(task.id);
        if (this.machines[machine].activeJobs.length >= this.machines[machine].maxConcurrent) {
          this.machines[machine].status = 'busy';
        }

        dispatched.push({ taskId: task.id, machine, jobHandle });

      } catch (err) {
        console.error(`[dispatcher] Failed to dispatch "${task.name}": ${err.message}`);
        task.status = 'failed';
        task.error  = err.message;
        this.queue  = this.queue.filter(t => t.id !== task.id);
        this.failed[task.id] = task;
      }
    }

    this._saveState();
    return dispatched;
  }

  // ===========================================================================
  // Status Checking
  // ===========================================================================

  /**
   * Check all running tasks for completion/failure.
   * Automatically dispatches queued tasks when capacity frees up.
   *
   * @returns {Promise<object>} { checked, completed, failed, dispatched }
   */
  async checkAll() {
    const executor = require('./executor');
    const results = { checked: 0, completed: [], failed: [], dispatched: [] };

    for (const [taskId, task] of Object.entries(this.running)) {
      try {
        results.checked++;
        const status = await executor.checkStatus(task);

        if (status.status === 'completed') {
          console.log(`[dispatcher] Task "${task.name}" COMPLETED on ${task.machine}`);
          task.status      = 'completed';
          task.completedAt = new Date().toISOString();
          task.exitCode    = status.exitCode;
          task.lastLines   = status.lastLines;

          // Remove from running, move to completed
          delete this.running[taskId];
          this.completed[taskId] = task;

          // Free machine slot
          this._freeMachineSlot(task.machine, taskId);

          results.completed.push(taskId);

          // Auto-sync results if task ran on server
          if (task.machine === 'server') {
            this._autoSyncResults(task).catch(err => {
              console.warn(`[dispatcher] Auto-sync for ${taskId} failed: ${err.message}`);
            });
          }

        } else if (status.status === 'failed') {
          console.error(`[dispatcher] Task "${task.name}" FAILED on ${task.machine}: ${status.error || 'exit code ' + status.exitCode}`);
          task.status      = 'failed';
          task.completedAt = new Date().toISOString();
          task.exitCode    = status.exitCode;
          task.error       = status.error || `exit code ${status.exitCode}`;
          task.lastLines   = status.lastLines;

          delete this.running[taskId];
          this.failed[taskId] = task;

          this._freeMachineSlot(task.machine, taskId);
          results.failed.push(taskId);

        } else {
          // Still running — update progress info
          task.progress = status.progress;
          task.lastLines = status.lastLines;
        }

      } catch (err) {
        console.warn(`[dispatcher] Error checking task "${task.name}": ${err.message}`);
      }
    }

    this._saveState();

    // Auto-dispatch newly available tasks
    if (results.completed.length > 0 || results.failed.length > 0) {
      const newDispatched = await this.dispatch();
      results.dispatched = newDispatched.map(d => d.taskId);
    }

    return results;
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  /**
   * Get full dispatcher status.
   * @returns {object}
   */
  getStatus() {
    return {
      gamingMode: this.gamingMode,
      machines: {
        pc: {
          ...this.machines.pc,
          activeJobCount: this.machines.pc.activeJobs.length,
        },
        server: {
          ...this.machines.server,
          activeJobCount: this.machines.server.activeJobs.length,
        },
      },
      queue:     this.queue.map(t => this._summarizeTask(t)),
      running:   Object.values(this.running).map(t => this._summarizeTask(t)),
      completed: Object.values(this.completed).map(t => this._summarizeTask(t)),
      failed:    Object.values(this.failed).map(t => this._summarizeTask(t)),
      counts: {
        queued:    this.queue.length,
        running:   Object.keys(this.running).length,
        completed: Object.keys(this.completed).length,
        failed:    Object.keys(this.failed).length,
      },
    };
  }

  /**
   * Format status as a readable string for Discord/console.
   * @returns {string}
   */
  formatStatus() {
    const s = this.getStatus();
    const lines = [];

    lines.push(`**Compute Dispatcher** ${s.gamingMode ? '[GAMING MODE — all → server]' : ''}`);
    lines.push('');
    lines.push(`**Machines:**`);
    lines.push(`  PC (${s.machines.pc.gpu}, ${s.machines.pc.ram_gb}GB RAM): ${s.machines.pc.status} (${s.machines.pc.activeJobCount}/${s.machines.pc.maxConcurrent} jobs)`);
    lines.push(`  Jupiter (CPU, ${s.machines.server.ram_gb}GB RAM):     ${s.machines.server.status} (${s.machines.server.activeJobCount}/${s.machines.server.maxConcurrent} jobs)`);
    lines.push('');

    if (s.running.length > 0) {
      lines.push(`**Running (${s.running.length}):**`);
      for (const t of s.running) {
        const prog = t.progress ? ` — ${t.progress}` : '';
        const elapsed = t.startedAt ? ` (${_fmtElapsed(t.startedAt)})` : '';
        lines.push(`  [${t.id.split('_').slice(-2).join('_')}] ${t.name} → ${(t.machine || '?').toUpperCase()}${elapsed}${prog}`);
      }
      lines.push('');
    }

    if (s.queue.length > 0) {
      lines.push(`**Queued (${s.queue.length}):**`);
      for (const t of s.queue) {
        const deps = t.dependsOn && t.dependsOn.length > 0 ? ` (waits: ${t.dependsOn.join(', ')})` : '';
        lines.push(`  ${t.name} — requires: [${(t.requires || []).join(', ') || 'cpu'}], ~${t.estimatedRam}GB${deps}`);
      }
      lines.push('');
    }

    lines.push(`**Counts:** ${s.counts.queued} queued | ${s.counts.running} running | ${s.counts.completed} done | ${s.counts.failed} failed`);

    return lines.join('\n');
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  _summarizeTask(task) {
    return {
      id:           task.id,
      name:         task.name,
      status:       task.status,
      machine:      task.machine,
      requires:     task.requires,
      estimatedRam: task.estimatedRam,
      priority:     task.priority,
      dependsOn:    task.dependsOn,
      startedAt:    task.startedAt,
      completedAt:  task.completedAt,
      progress:     task.progress || null,
      error:        task.error || null,
      jobHandle:    task.jobHandle ? { id: task.jobHandle.id || task.jobHandle.jobId, machine: task.machine } : null,
    };
  }

  _freeMachineSlot(machineName, taskId) {
    const machine = this.machines[machineName];
    if (machine) {
      machine.activeJobs = machine.activeJobs.filter(id => id !== taskId);
      if (machine.activeJobs.length === 0 && machine.status !== 'gaming') {
        machine.status = 'available';
      } else if (machine.activeJobs.length < machine.maxConcurrent && machine.status === 'busy') {
        machine.status = 'available';
      }
    }
  }

  _syncMachineStatus() {
    // Sync machine status from current active job counts
    for (const [name, machine] of Object.entries(this.machines)) {
      if (machine.status === 'gaming') continue;
      if (machine.activeJobs.length === 0) {
        machine.status = 'available';
      } else if (machine.activeJobs.length >= machine.maxConcurrent) {
        machine.status = 'busy';
      } else {
        machine.status = 'available'; // Has some capacity
      }
    }
  }

  async _autoSyncResults(task) {
    if (!task.jobHandle || !task.jobHandle.logFile) return;

    try {
      const syncer = require('./sync');
      await syncer.syncTaskResults(task);
      console.log(`[dispatcher] Auto-sync complete for "${task.name}"`);
    } catch (err) {
      console.warn(`[dispatcher] Auto-sync failed for "${task.name}": ${err.message}`);
    }
  }

  // ===========================================================================
  // State Persistence
  // ===========================================================================

  _saveState() {
    try {
      const state = {
        gamingMode:  this.gamingMode,
        machines:    this.machines,
        queue:       this.queue,
        running:     this.running,
        completed:   this.completed,
        failed:      this.failed,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[dispatcher] Could not save state: ${err.message}`);
    }
  }

  _loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;

      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

      this.gamingMode = state.gamingMode || false;
      this.queue      = state.queue      || [];
      this.running    = state.running    || {};
      this.completed  = state.completed  || {};
      this.failed     = state.failed     || {};

      // Restore machine config overrides from state (status, activeJobs)
      // but keep hardware specs from the constructor defaults
      if (state.machines) {
        for (const [name, savedMachine] of Object.entries(state.machines)) {
          if (this.machines[name]) {
            this.machines[name].status     = savedMachine.status     || this.machines[name].status;
            this.machines[name].activeJobs = savedMachine.activeJobs || [];
          }
        }
      }

      const qLen = this.queue.length;
      const rLen = Object.keys(this.running).length;
      if (qLen > 0 || rLen > 0) {
        console.log(`[dispatcher] Restored state: ${qLen} queued, ${rLen} running`);
      }
    } catch (err) {
      console.warn(`[dispatcher] Could not load state (starting fresh): ${err.message}`);
    }
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function _fmtElapsed(startedAt) {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h${m}m`;
}

// ===========================================================================
// Singleton Export
// ===========================================================================

// Export a singleton so all modules share the same dispatcher instance
const instance = new ComputeDispatcher();

module.exports = instance;
module.exports.ComputeDispatcher = ComputeDispatcher;
module.exports._generateTaskId = generateTaskId;
