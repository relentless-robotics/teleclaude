/**
 * Subagent Registry — Auto-registration for spawned background agents.
 *
 * Background Claude tasks call these functions to register themselves in
 * dashboard-app/data/subagents.json so they appear on the Agents page.
 *
 * Usage (inside a spawned agent):
 *
 *   const registry = require('./utils/subagent_registry');
 *
 *   // Register at start (status: running)
 *   registry.register({
 *     id: 'my_task_001',
 *     name: 'My Background Task',
 *     description: 'What this task is doing',
 *     type: 'backtest',   // backtest | research | code | training | deploy
 *     model: 'sonnet',    // haiku | sonnet | opus
 *     server: 'Jupiter',  // or null for local
 *     parent: 'quantAgent',
 *   });
 *
 *   // Update progress mid-task (shorthand — just pass new description string)
 *   registry.progress('my_task_001', 'Step 2/3: Running sweep...');
 *   // Or full update with any fields:
 *   registry.update('my_task_001', { description: 'Step 2/3: Running sweep...', server: 'Jupiter' });
 *
 *   // Mark complete
 *   registry.complete('my_task_001', 'Sweep done: 42 profitable combos out of 192');
 *
 *   // Mark failed
 *   registry.fail('my_task_001', 'SSH timeout on Jupiter');
 */

const fs = require('fs');
const path = require('path');

const SUBAGENTS_FILE = path.join(
  __dirname, '..', 'dashboard-app', 'data', 'subagents.json'
);

const MAX_AGENTS = 50; // Keep only the 50 most recent entries

/**
 * Read the current subagents.json file.
 * @returns {{ lastUpdated: string, agents: SubAgent[] }}
 */
function _read() {
  try {
    const raw = fs.readFileSync(SUBAGENTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { lastUpdated: new Date().toISOString(), agents: [] };
  }
}

/**
 * Write the subagents.json file atomically (write to temp, then rename).
 * @param {{ lastUpdated: string, agents: SubAgent[] }} data
 */
function _write(data) {
  data.lastUpdated = new Date().toISOString();
  const tmp = SUBAGENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, SUBAGENTS_FILE);
}

/**
 * Register a new background agent (status: running).
 *
 * @param {Object} opts
 * @param {string} opts.id          - Unique ID (used for updates/completion)
 * @param {string} opts.name        - Human-readable name
 * @param {string} opts.description - What the task is doing
 * @param {string} [opts.type]      - 'backtest' | 'research' | 'code' | 'training' | 'deploy'
 * @param {string} [opts.model]     - 'haiku' | 'sonnet' | 'opus' | 'N/A'
 * @param {string|null} [opts.server] - Server name or null for local
 * @param {string} [opts.parent]    - Parent agent key (e.g. 'quantAgent')
 */
function register(opts) {
  const { id, name, description, type = 'research', model = 'sonnet', server = null, parent = null } = opts;

  if (!id || !name) {
    console.error('[SubagentRegistry] register() requires id and name');
    return false;
  }

  const data = _read();

  // Remove any existing entry with the same id
  data.agents = data.agents.filter(a => a.id !== id);

  // Prepend the new entry
  data.agents.unshift({
    id,
    name,
    description: description || '',
    status: 'running',
    model,
    server,
    parent,
    type,
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
  });

  // Trim to MAX_AGENTS
  if (data.agents.length > MAX_AGENTS) {
    data.agents = data.agents.slice(0, MAX_AGENTS);
  }

  _write(data);
  console.log(`[SubagentRegistry] Registered: ${id} (${name})`);
  return true;
}

/**
 * Update an existing agent's fields (e.g. to update description/progress mid-task).
 *
 * @param {string} id     - The agent id
 * @param {Object} fields - Fields to merge in (description, server, model, etc.)
 */
function update(id, fields) {
  const data = _read();
  const idx = data.agents.findIndex(a => a.id === id);

  if (idx < 0) {
    console.warn(`[SubagentRegistry] update(): agent "${id}" not found — registering as orphan`);
    // Auto-register as a running agent with provided fields
    return register({ id, name: id, ...fields });
  }

  Object.assign(data.agents[idx], fields);
  _write(data);
  return true;
}

/**
 * Mark an agent as completed successfully.
 *
 * @param {string} id      - The agent id
 * @param {string} result  - Short summary of what was accomplished
 */
function complete(id, result = '') {
  const data = _read();
  const idx = data.agents.findIndex(a => a.id === id);

  if (idx < 0) {
    console.warn(`[SubagentRegistry] complete(): agent "${id}" not found`);
    return false;
  }

  data.agents[idx].status = 'completed';
  data.agents[idx].completedAt = new Date().toISOString();
  data.agents[idx].result = result;
  _write(data);
  console.log(`[SubagentRegistry] Completed: ${id}`);
  return true;
}

/**
 * Mark an agent as failed.
 *
 * @param {string} id    - The agent id
 * @param {string} error - Error message
 */
function fail(id, error = '') {
  const data = _read();
  const idx = data.agents.findIndex(a => a.id === id);

  if (idx < 0) {
    console.warn(`[SubagentRegistry] fail(): agent "${id}" not found`);
    return false;
  }

  data.agents[idx].status = 'failed';
  data.agents[idx].completedAt = new Date().toISOString();
  data.agents[idx].result = error ? `ERROR: ${error}` : 'Failed';
  _write(data);
  console.log(`[SubagentRegistry] Failed: ${id} — ${error}`);
  return true;
}

/**
 * Get the current status of a registered agent.
 *
 * @param {string} id - The agent id
 * @returns {Object|null}
 */
function getAgent(id) {
  const data = _read();
  return data.agents.find(a => a.id === id) || null;
}

/**
 * List all currently registered agents.
 *
 * @param {{ status?: string }} [filter] - Optional filter by status
 * @returns {Object[]}
 */
function list(filter = {}) {
  const data = _read();
  if (filter.status) {
    return data.agents.filter(a => a.status === filter.status);
  }
  return data.agents;
}

/**
 * List only agents that are currently running.
 * Convenience wrapper around list({ status: 'running' }).
 *
 * @returns {Object[]}
 */
function getRunning() {
  return list({ status: 'running' });
}

/**
 * Update the description of a running agent (progress update shorthand).
 * Equivalent to update(id, { description }).
 *
 * @param {string} id          - The agent id
 * @param {string} description - Current step / progress message
 */
function progress(id, description) {
  return update(id, { description });
}

/**
 * Remove stale completed/failed agents older than N days.
 *
 * @param {number} [daysOld=7] - Remove entries completed more than this many days ago
 */
function cleanup(daysOld = 7) {
  const data = _read();
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const before = data.agents.length;

  data.agents = data.agents.filter(a => {
    if (a.status === 'running') return true; // Never remove running
    if (!a.completedAt) return true;
    return new Date(a.completedAt) > cutoff;
  });

  _write(data);
  const removed = before - data.agents.length;
  if (removed > 0) {
    console.log(`[SubagentRegistry] Cleanup: removed ${removed} old entries`);
  }
  return removed;
}

module.exports = { register, update, progress, complete, fail, getAgent, list, getRunning, cleanup };
