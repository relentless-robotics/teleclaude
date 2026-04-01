'use strict';
/**
 * shortterm_memory.js — SQLite-backed short-term memory for the teleclaude bridge.
 *
 * Tracks tasks, findings, compute jobs, and restart context in a lightweight
 * local database. Items auto-decay: completed items older than their decay_hours
 * get archived, and archived items older than 7 days get deleted.
 *
 * USAGE:
 *   const stm = require('./utils/shortterm_memory');
 *   stm.addTask('Deploy CNN model', 'high', ['quant', 'deploy']);
 *   stm.addFinding('IC decayed to 0.045', 'Details...', 'cnn_oot_sweep', ['cnn']);
 *   stm.addComputeJob('Neptune', 'WF training fold 12', ['cnn', 'training']);
 *   const ctx = stm.getActiveContext();   // compact string for restart
 *   const results = stm.search('CNN');    // text search
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'shortterm_memory.db');

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','archived')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    decay_hours INTEGER NOT NULL DEFAULT 24,
    notes TEXT,
    tags TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    details TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    promoted_to_longterm INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS compute_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','stale')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    result_summary TEXT,
    tags TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS restart_context (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    blob TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmts = {
  insertTask: db.prepare(`
    INSERT INTO tasks (description, priority, tags) VALUES (?, ?, ?)
  `),
  updateTask: db.prepare(`
    UPDATE tasks SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
    WHERE id = ?
  `),
  completeTask: db.prepare(`
    UPDATE tasks SET status = 'done', notes = COALESCE(?, notes),
      completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `),
  insertFinding: db.prepare(`
    INSERT INTO findings (summary, details, source, tags) VALUES (?, ?, ?, ?)
  `),
  insertComputeJob: db.prepare(`
    INSERT INTO compute_jobs (machine, description, tags) VALUES (?, ?, ?)
  `),
  updateComputeJob: db.prepare(`
    UPDATE compute_jobs SET status = ?, result_summary = COALESCE(?, result_summary),
      updated_at = datetime('now')
    WHERE id = ?
  `),
  // Decay: archive completed tasks past their decay window
  archiveDecayed: db.prepare(`
    UPDATE tasks SET status = 'archived', updated_at = datetime('now')
    WHERE status = 'done'
      AND completed_at IS NOT NULL
      AND (julianday('now') - julianday(completed_at)) * 24 > decay_hours
  `),
  // Delete archived items older than 7 days
  deleteOldArchived: db.prepare(`
    DELETE FROM tasks
    WHERE status = 'archived'
      AND (julianday('now') - julianday(updated_at)) > 7
  `),
  // Mark stale compute jobs (running but not updated in 6 hours)
  markStaleJobs: db.prepare(`
    UPDATE compute_jobs SET status = 'stale', updated_at = datetime('now')
    WHERE status = 'running'
      AND (julianday('now') - julianday(updated_at)) * 24 > 6
  `),
  // Queries for active context
  activeTasks: db.prepare(`
    SELECT id, description, status, priority, created_at, notes, tags
    FROM tasks WHERE status != 'archived'
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at DESC
  `),
  recentFindings: db.prepare(`
    SELECT id, summary, source, created_at, promoted_to_longterm, tags
    FROM findings
    WHERE (julianday('now') - julianday(created_at)) <= 1
    ORDER BY created_at DESC
  `),
  runningJobs: db.prepare(`
    SELECT id, machine, description, status, started_at, updated_at, result_summary, tags
    FROM compute_jobs
    WHERE status IN ('running', 'stale')
    ORDER BY started_at DESC
  `),
  // Upsert restart blob
  upsertRestart: db.prepare(`
    INSERT INTO restart_context (id, blob, generated_at) VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, generated_at = datetime('now')
  `),
  getRestart: db.prepare(`SELECT blob, generated_at FROM restart_context WHERE id = 1`),
  // Search
  searchTasks: db.prepare(`
    SELECT 'task' as type, id, description as text, status, priority, tags
    FROM tasks WHERE status != 'archived'
      AND (description LIKE '%' || ? || '%' OR notes LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%')
  `),
  searchFindings: db.prepare(`
    SELECT 'finding' as type, id, summary as text, source, tags
    FROM findings
    WHERE summary LIKE '%' || ? || '%' OR details LIKE '%' || ? || '%'
      OR source LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%'
  `),
  searchJobs: db.prepare(`
    SELECT 'compute_job' as type, id, description as text, machine, status, tags
    FROM compute_jobs
    WHERE status IN ('running', 'stale')
      AND (description LIKE '%' || ? || '%' OR machine LIKE '%' || ? || '%'
        OR result_summary LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%')
  `),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run decay: archive old completed tasks, delete old archived items, mark stale jobs.
 */
function decay() {
  stmts.archiveDecayed.run();
  stmts.deleteOldArchived.run();
  stmts.markStaleJobs.run();
}

/**
 * Add a new task.
 * @param {string} desc - Task description
 * @param {string} [priority='medium'] - urgent|high|medium|low
 * @param {string[]} [tags=[]] - Tag array
 * @returns {{ id: number }} The inserted task id
 */
function addTask(desc, priority = 'medium', tags = []) {
  const info = stmts.insertTask.run(desc, priority, JSON.stringify(tags));
  return { id: info.lastInsertRowid };
}

/**
 * Update a task's status and optional notes.
 * @param {number} id
 * @param {string} status - pending|in_progress|done|archived
 * @param {string} [notes]
 */
function updateTask(id, status, notes = null) {
  stmts.updateTask.run(status, notes, id);
}

/**
 * Mark a task as done with a result note.
 * @param {number} id
 * @param {string} [result]
 */
function completeTask(id, result = null) {
  stmts.completeTask.run(result, id);
}

/**
 * Add a finding (result from sweep, analysis, etc).
 * @param {string} summary - Short summary
 * @param {string} [details] - Longer details
 * @param {string} [source] - Which sweep/analysis produced this
 * @param {string[]} [tags=[]]
 * @returns {{ id: number }}
 */
function addFinding(summary, details = null, source = null, tags = []) {
  const info = stmts.insertFinding.run(summary, details, source, JSON.stringify(tags));
  return { id: info.lastInsertRowid };
}

/**
 * Add a compute job to track.
 * @param {string} machine - Neptune|Uranus|Jupiter|Saturn
 * @param {string} desc - Job description
 * @param {string[]} [tags=[]]
 * @returns {{ id: number }}
 */
function addComputeJob(machine, desc, tags = []) {
  const info = stmts.insertComputeJob.run(machine, desc, JSON.stringify(tags));
  return { id: info.lastInsertRowid };
}

/**
 * Update a compute job's status and optional result summary.
 * @param {number} id
 * @param {string} status - running|done|failed|stale
 * @param {string} [result]
 */
function updateComputeJob(id, status, result = null) {
  stmts.updateComputeJob.run(status, result, id);
}

/**
 * Get a compact context string (<50 lines) of all active items.
 * Suitable for loading on restart to restore short-term awareness.
 * @returns {string}
 */
function getActiveContext() {
  decay(); // auto-decay on access

  const lines = [];
  lines.push('=== SHORT-TERM MEMORY CONTEXT ===');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Tasks
  const tasks = stmts.activeTasks.all();
  if (tasks.length > 0) {
    lines.push(`--- TASKS (${tasks.length}) ---`);
    for (const t of tasks) {
      const tags = JSON.parse(t.tags || '[]');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      lines.push(`  #${t.id} [${t.priority}/${t.status}] ${t.description}${tagStr}`);
      if (t.notes) lines.push(`     -> ${t.notes}`);
    }
    lines.push('');
  }

  // Findings (last 24h)
  const findings = stmts.recentFindings.all();
  if (findings.length > 0) {
    lines.push(`--- FINDINGS (last 24h: ${findings.length}) ---`);
    for (const f of findings) {
      const tags = JSON.parse(f.tags || '[]');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      const promoted = f.promoted_to_longterm ? ' *PROMOTED*' : '';
      lines.push(`  #${f.id} ${f.summary} (src: ${f.source || 'n/a'})${tagStr}${promoted}`);
    }
    lines.push('');
  }

  // Running compute
  const jobs = stmts.runningJobs.all();
  if (jobs.length > 0) {
    lines.push(`--- COMPUTE (active: ${jobs.length}) ---`);
    for (const j of jobs) {
      const tags = JSON.parse(j.tags || '[]');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      const stale = j.status === 'stale' ? ' *STALE*' : '';
      lines.push(`  #${j.id} [${j.machine}] ${j.description} (since ${j.started_at})${tagStr}${stale}`);
      if (j.result_summary) lines.push(`     -> ${j.result_summary}`);
    }
    lines.push('');
  }

  if (tasks.length === 0 && findings.length === 0 && jobs.length === 0) {
    lines.push('(empty — no active tasks, recent findings, or running jobs)');
  }

  return lines.join('\n');
}

/**
 * Generate, store, and return the restart context blob.
 * @returns {string}
 */
function getRestartBlob() {
  const blob = getActiveContext();
  stmts.upsertRestart.run(blob);
  return blob;
}

/**
 * Search across all active tasks, recent findings, and running compute jobs.
 * @param {string} query - Search text (case-insensitive via SQLite LIKE)
 * @returns {Array<{type: string, id: number, text: string, [key: string]: any}>}
 */
function search(query) {
  const q = query;
  const results = [
    ...stmts.searchTasks.all(q, q, q),
    ...stmts.searchFindings.all(q, q, q, q),
    ...stmts.searchJobs.all(q, q, q, q),
  ];
  // Parse tags back to arrays
  for (const r of results) {
    if (r.tags) r.tags = JSON.parse(r.tags);
  }
  return results;
}

/**
 * Get raw database handle for advanced queries.
 * @returns {Database}
 */
function getDb() {
  return db;
}

// Run decay on module load
decay();

module.exports = {
  addTask,
  updateTask,
  completeTask,
  addFinding,
  addComputeJob,
  updateComputeJob,
  decay,
  getActiveContext,
  getRestartBlob,
  search,
  getDb,
};
