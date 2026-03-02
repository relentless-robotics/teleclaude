/**
 * Persistent Task Manager
 *
 * Manages long-running tasks that persist across Claude session resets.
 * Tasks run independently via detached processes with output logged to files.
 * Status tracked in SQLite for cross-session persistence.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

// Paths
const DB_PATH = path.join(__dirname, '..', 'memory', 'persistent_tasks.db');
const LOGS_DIR = path.join(__dirname, '..', 'task_logs');
const CHECKPOINTS_DIR = path.join(__dirname, '..', 'task_checkpoints');

// Ensure directories exist
[LOGS_DIR, CHECKPOINTS_DIR, path.dirname(DB_PATH)].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Initialize database
let db;
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      command TEXT NOT NULL,
      working_dir TEXT,
      pid INTEGER,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'DAILY',
      started_at TEXT,
      last_checkpoint TEXT,
      last_checkpoint_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      log_file TEXT,
      checkpoint_file TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      level TEXT DEFAULT 'INFO',
      message TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS task_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      checkpoint_data TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
  `);
}

/**
 * Generate a unique task ID
 */
function generateTaskId() {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}

/**
 * Launch a persistent task that survives session resets
 *
 * @param {Object} options
 * @param {string} options.name - Human-readable task name
 * @param {string} options.type - Task type (training, browser, script, etc.)
 * @param {string} options.command - Command to execute
 * @param {string} options.workingDir - Working directory
 * @param {string} options.priority - URGENT, DAILY, WEEKLY
 * @param {Object} options.metadata - Additional metadata
 * @returns {Object} Task info including ID and log file path
 */
function launchTask(options) {
  const { name, type, command, priority = 'DAILY', metadata = {} } = options;

  // Normalize working directory path
  const workingDir = options.workingDir ? path.resolve(options.workingDir) : process.cwd();

  const taskId = generateTaskId();
  const logFile = path.join(LOGS_DIR, `${taskId}.log`);
  const checkpointFile = path.join(CHECKPOINTS_DIR, `${taskId}.json`);
  const startedAt = new Date().toISOString();

  // Create initial log file
  fs.writeFileSync(logFile, `=== Task: ${name} ===\nID: ${taskId}\nStarted: ${startedAt}\nCommand: ${command}\nWorking Dir: ${workingDir}\n${'='.repeat(50)}\n\n`);

  // Create batch script to run the task
  const wrapperScript = path.join(LOGS_DIR, `${taskId}_wrapper.bat`);
  const batchScript = `@echo off
cd /d "${workingDir}"
echo Task started at %date% %time% >> "${logFile}"
${command} >> "${logFile}" 2>&1
echo. >> "${logFile}"
echo === Task Completed === >> "${logFile}"
echo Exit Code: %errorlevel% >> "${logFile}"
echo Completed: %date% %time% >> "${logFile}"
echo {"status": "completed", "exit_code": %errorlevel%, "completed_at": "%date% %time%"} > "${checkpointFile}"
`;

  fs.writeFileSync(wrapperScript, batchScript);

  // Create VBS script to launch truly detached (Windows-specific)
  const vbsScript = path.join(LOGS_DIR, `${taskId}_launcher.vbs`);
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${wrapperScript}""", 0, False
`;
  fs.writeFileSync(vbsScript, vbsContent);

  // Insert into database first (before launching, so we track even if launch fails)
  const d = getDb();
  d.prepare(`
    INSERT INTO tasks (id, name, type, command, working_dir, pid, status, priority, started_at, log_file, checkpoint_file, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
  `).run(taskId, name, type, command, workingDir, null, priority, startedAt, logFile, checkpointFile, JSON.stringify(metadata));

  // Use exec with shell to launch the VBS script (truly detached on Windows)
  exec(`cscript //nologo "${vbsScript}"`, {
    cwd: workingDir || process.cwd(),
    windowsHide: true
  }, (err) => {
    if (err) {
      logTaskEvent(taskId, 'ERROR', `Failed to launch: ${err.message}`);
      // Update status to failed
      d.prepare(`UPDATE tasks SET status = 'failed' WHERE id = ?`).run(taskId);
    } else {
      logTaskEvent(taskId, 'INFO', `Task launched via VBS script`);
    }
  });

  return {
    id: taskId,
    name,
    type,
    pid: null, // PID not available with VBS launch, check log file for process
    status: 'running',
    logFile,
    checkpointFile,
    startedAt
  };
}

/**
 * Log an event for a task
 */
function logTaskEvent(taskId, level, message) {
  const d = getDb();
  d.prepare(`INSERT INTO task_logs (task_id, level, message) VALUES (?, ?, ?)`).run(taskId, level, message);
}

/**
 * Save a checkpoint for a task
 */
function saveCheckpoint(taskId, checkpointData) {
  const d = getDb();
  const timestamp = new Date().toISOString();

  d.prepare(`INSERT INTO task_checkpoints (task_id, checkpoint_data) VALUES (?, ?)`).run(taskId, JSON.stringify(checkpointData));
  d.prepare(`UPDATE tasks SET last_checkpoint = ?, last_checkpoint_at = ? WHERE id = ?`).run(JSON.stringify(checkpointData), timestamp, taskId);
}

/**
 * Check if a process is still running by PID
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check status of a task and update database
 */
function checkTaskStatus(taskId) {
  const d = getDb();
  const task = d.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);

  if (!task) {
    return null;
  }

  // If already completed, return as-is
  if (task.status === 'completed' || task.status === 'failed') {
    return formatTask(task);
  }

  // Check checkpoint file for completion
  if (task.checkpoint_file && fs.existsSync(task.checkpoint_file)) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(task.checkpoint_file, 'utf-8'));
      if (checkpoint.status === 'completed' || checkpoint.status === 'failed') {
        d.prepare(`UPDATE tasks SET status = ?, exit_code = ?, completed_at = ? WHERE id = ?`)
          .run(checkpoint.status, checkpoint.exit_code || null, checkpoint.completed_at || new Date().toISOString(), taskId);
        task.status = checkpoint.status;
        task.exit_code = checkpoint.exit_code;
        task.completed_at = checkpoint.completed_at;
        logTaskEvent(taskId, 'INFO', `Task ${checkpoint.status} with exit code ${checkpoint.exit_code}`);
      }
    } catch (e) {
      // Checkpoint not ready yet
    }
  }

  // Check if process is still running
  if (task.status === 'running' && task.pid) {
    const running = isProcessRunning(task.pid);
    if (!running) {
      // Process ended but no checkpoint - check log file
      const logTail = getTaskLogTail(taskId, 20);
      if (logTail.includes('Task Completed') || logTail.includes('Exit Code:')) {
        d.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), taskId);
        task.status = 'completed';
      } else {
        d.prepare(`UPDATE tasks SET status = 'unknown', completed_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), taskId);
        task.status = 'unknown';
      }
      logTaskEvent(taskId, 'INFO', `Process no longer running, status: ${task.status}`);
    }
  }

  return formatTask(task);
}

/**
 * Get the tail of a task's log file
 */
function getTaskLogTail(taskId, lines = 50) {
  const d = getDb();
  const task = d.prepare(`SELECT log_file FROM tasks WHERE id = ?`).get(taskId);

  if (!task || !task.log_file || !fs.existsSync(task.log_file)) {
    return '';
  }

  try {
    const content = fs.readFileSync(task.log_file, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch (e) {
    return `Error reading log: ${e.message}`;
  }
}

/**
 * Get full task log
 */
function getTaskLog(taskId) {
  const d = getDb();
  const task = d.prepare(`SELECT log_file FROM tasks WHERE id = ?`).get(taskId);

  if (!task || !task.log_file || !fs.existsSync(task.log_file)) {
    return '';
  }

  try {
    return fs.readFileSync(task.log_file, 'utf-8');
  } catch (e) {
    return `Error reading log: ${e.message}`;
  }
}

/**
 * List all tasks with optional filters
 */
function listTasks(options = {}) {
  const { status, priority, type, includeCompleted = false } = options;
  const d = getDb();

  let query = `SELECT * FROM tasks WHERE 1=1`;
  const params = [];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  } else if (!includeCompleted) {
    query += ` AND status NOT IN ('completed', 'failed')`;
  }

  if (priority) {
    query += ` AND priority = ?`;
    params.push(priority);
  }

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }

  query += ` ORDER BY created_at DESC`;

  const tasks = d.prepare(query).all(...params);
  return tasks.map(formatTask);
}

/**
 * Get all active (running) tasks
 */
function getActiveTasks() {
  return listTasks({ status: 'running' });
}

/**
 * Check all active tasks and update their status
 */
function checkAllActiveTasks() {
  const activeTasks = getActiveTasks();
  return activeTasks.map(task => checkTaskStatus(task.id));
}

/**
 * Format task for output
 */
function formatTask(task) {
  let metadata = {};
  try {
    metadata = task.metadata ? JSON.parse(task.metadata) : {};
  } catch (e) {}

  let lastCheckpoint = null;
  try {
    lastCheckpoint = task.last_checkpoint ? JSON.parse(task.last_checkpoint) : null;
  } catch (e) {}

  return {
    id: task.id,
    name: task.name,
    type: task.type,
    command: task.command,
    workingDir: task.working_dir,
    pid: task.pid,
    status: task.status,
    priority: task.priority,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    exitCode: task.exit_code,
    logFile: task.log_file,
    lastCheckpoint,
    lastCheckpointAt: task.last_checkpoint_at,
    metadata,
    createdAt: task.created_at
  };
}

/**
 * Update task status manually
 */
function updateTaskStatus(taskId, status, additionalData = {}) {
  const d = getDb();

  const updates = ['status = ?'];
  const params = [status];

  if (status === 'completed' || status === 'failed') {
    updates.push('completed_at = ?');
    params.push(new Date().toISOString());
  }

  if (additionalData.exitCode !== undefined) {
    updates.push('exit_code = ?');
    params.push(additionalData.exitCode);
  }

  if (additionalData.lastCheckpoint) {
    updates.push('last_checkpoint = ?', 'last_checkpoint_at = ?');
    params.push(JSON.stringify(additionalData.lastCheckpoint), new Date().toISOString());
  }

  params.push(taskId);

  d.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logTaskEvent(taskId, 'INFO', `Status updated to ${status}`);

  return checkTaskStatus(taskId);
}

/**
 * Archive old completed tasks (move to archive table or delete)
 */
function archiveCompletedTasks(olderThanDays = 7) {
  const d = getDb();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  // Get tasks to archive
  const tasksToArchive = d.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('completed', 'failed')
    AND completed_at < ?
  `).all(cutoff);

  // Delete old logs
  for (const task of tasksToArchive) {
    if (task.log_file && fs.existsSync(task.log_file)) {
      try { fs.unlinkSync(task.log_file); } catch (e) {}
    }
    if (task.checkpoint_file && fs.existsSync(task.checkpoint_file)) {
      try { fs.unlinkSync(task.checkpoint_file); } catch (e) {}
    }
    // Delete wrapper script
    const wrapperScript = task.log_file?.replace('.log', '_wrapper.ps1');
    if (wrapperScript && fs.existsSync(wrapperScript)) {
      try { fs.unlinkSync(wrapperScript); } catch (e) {}
    }
  }

  // Delete from database
  const result = d.prepare(`
    DELETE FROM tasks
    WHERE status IN ('completed', 'failed')
    AND completed_at < ?
  `).run(cutoff);

  // Clean up orphaned logs
  d.prepare(`DELETE FROM task_logs WHERE task_id NOT IN (SELECT id FROM tasks)`).run();
  d.prepare(`DELETE FROM task_checkpoints WHERE task_id NOT IN (SELECT id FROM tasks)`).run();

  return {
    archived: result.changes,
    tasks: tasksToArchive.map(t => t.name)
  };
}

/**
 * Get task by ID
 */
function getTask(taskId) {
  return checkTaskStatus(taskId);
}

/**
 * Generate a summary report of all tasks
 */
function getTaskSummary() {
  const d = getDb();

  const stats = d.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM tasks
    GROUP BY status
  `).all();

  const activeTasks = checkAllActiveTasks();

  const byPriority = d.prepare(`
    SELECT
      priority,
      COUNT(*) as count
    FROM tasks
    WHERE status = 'running'
    GROUP BY priority
  `).all();

  return {
    stats: Object.fromEntries(stats.map(s => [s.status, s.count])),
    byPriority: Object.fromEntries(byPriority.map(p => [p.priority, p.count])),
    activeTasks: activeTasks.filter(t => t.status === 'running'),
    recentlyCompleted: listTasks({ status: 'completed' }).slice(0, 5)
  };
}

/**
 * Kill a running task
 */
function killTask(taskId) {
  const task = getTask(taskId);
  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  if (task.status !== 'running') {
    return { success: false, error: `Task is not running (status: ${task.status})` };
  }

  try {
    process.kill(task.pid, 'SIGTERM');
    updateTaskStatus(taskId, 'killed');
    logTaskEvent(taskId, 'WARN', 'Task killed by user');
    return { success: true, message: `Task ${taskId} killed` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Export functions
module.exports = {
  launchTask,
  getTask,
  checkTaskStatus,
  getTaskLog,
  getTaskLogTail,
  listTasks,
  getActiveTasks,
  checkAllActiveTasks,
  updateTaskStatus,
  archiveCompletedTasks,
  getTaskSummary,
  killTask,
  saveCheckpoint,
  logTaskEvent,
  // Constants
  LOGS_DIR,
  CHECKPOINTS_DIR,
  DB_PATH
};
