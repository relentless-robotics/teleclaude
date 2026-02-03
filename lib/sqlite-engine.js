/**
 * SQLite Engine for Memory System v4
 *
 * Provides structured storage for memories and projects using SQLite.
 * Uses sql.js (pure JavaScript SQLite) for cross-platform compatibility.
 *
 * Features:
 * - Full-text search with FTS5
 * - Audit logging for all write operations
 * - Tag management with many-to-many relationships
 * - Efficient filtering and exact queries
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Default paths
const DATA_DIR = path.join(__dirname, '..', 'memory');
const DB_FILE = path.join(DATA_DIR, 'memory.db');

// Cache the SQL.js instance
let SQL = null;

/**
 * SQLite Engine Class
 */
class SQLiteEngine {
  constructor(dbPath = DB_FILE) {
    this.dbPath = dbPath;
    this.db = null;

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Initialize database connection and schema
   */
  async init() {
    // Initialize SQL.js
    if (!SQL) {
      SQL = await initSqlJs();
    }

    // Load existing database or create new
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    // Create schema
    this._createSchema();

    // Save to ensure file exists
    this._save();

    return this;
  }

  /**
   * Save database to disk
   */
  _save() {
    if (this.db) {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    }
  }

  /**
   * Create database schema
   */
  _createSchema() {
    // Core memories table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        priority TEXT CHECK(priority IN ('URGENT','DAILY','WEEKLY','ARCHIVE')) DEFAULT 'DAILY',
        status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','deleted')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT,
        completed_at TEXT,
        expires_at TEXT,
        last_checked TEXT,
        encrypted INTEGER DEFAULT 0,
        access_level TEXT DEFAULT 'standard'
      );
    `);

    // Tags table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      );
    `);

    // Memory-tag relationship
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (memory_id, tag_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );
    `);

    // Projects table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'planning' CHECK(status IN ('planning','in_progress','blocked','completed','abandoned')),
        priority TEXT CHECK(priority IN ('URGENT','DAILY','WEEKLY','ARCHIVE')) DEFAULT 'DAILY',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      );
    `);

    // Project tags
    this.db.run(`
      CREATE TABLE IF NOT EXISTS project_tags (
        project_id TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (project_id, tag_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );
    `);

    // Project steps
    this.db.run(`
      CREATE TABLE IF NOT EXISTS project_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        task TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','skipped')),
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(project_id, step_number)
      );
    `);

    // Project blockers
    this.db.run(`
      CREATE TABLE IF NOT EXISTS project_blockers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        step_id INTEGER,
        description TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        resolution TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `);

    // Audit log
    this.db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'claude',
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Indexes for common queries
    this._runSafe(`CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority);`);
    this._runSafe(`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);`);
    this._runSafe(`CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);`);
    this._runSafe(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);`);
    this._runSafe(`CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);`);
    this._runSafe(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);`);
  }

  /**
   * Run SQL safely (ignore errors for CREATE INDEX IF NOT EXISTS etc)
   */
  _runSafe(sql) {
    try {
      this.db.run(sql);
    } catch (e) {
      // Ignore errors (e.g., index already exists)
    }
  }

  /**
   * Execute SQL and get all results
   */
  _all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  /**
   * Execute SQL and get first result
   */
  _get(sql, params = []) {
    const results = this._all(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute SQL (no return value)
   */
  _run(sql, params = []) {
    this.db.run(sql, params);
  }

  // ==================== MEMORY OPERATIONS ====================

  /**
   * Insert a new memory
   */
  insertMemory(memory) {
    const id = memory.id || this._generateId();

    this._run(`
      INSERT INTO memories (id, content, priority, status, created_at, expires_at, last_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      memory.content,
      memory.priority || 'DAILY',
      memory.status || 'active',
      memory.created || new Date().toISOString(),
      memory.expires || null,
      memory.lastChecked || null
    ]);

    // Add tags
    if (memory.tags && memory.tags.length > 0) {
      this._setMemoryTags(id, memory.tags);
    }

    // Audit log
    this._audit('memory', id, 'create', { priority: memory.priority });

    this._save();
    return id;
  }

  /**
   * Get memory by ID
   */
  getMemory(id) {
    const memory = this._get(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return null;

    // Get tags
    memory.tags = this._getMemoryTags(id);

    return this._formatMemory(memory);
  }

  /**
   * Update memory
   */
  updateMemory(id, updates) {
    const fields = [];
    const values = [];

    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completedAt);
    }
    if (updates.lastChecked !== undefined) {
      fields.push('last_checked = ?');
      values.push(updates.lastChecked);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this._run(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`, values);

    // Update tags if provided
    if (updates.tags !== undefined) {
      this._setMemoryTags(id, updates.tags);
    }
    if (updates.addTags !== undefined) {
      const currentTags = this._getMemoryTags(id);
      const newTags = [...new Set([...currentTags, ...updates.addTags])];
      this._setMemoryTags(id, newTags);
    }

    // Audit log
    this._audit('memory', id, 'update', updates);

    this._save();
    return true;
  }

  /**
   * Delete memory
   */
  deleteMemory(id) {
    // Remove tags
    this._run('DELETE FROM memory_tags WHERE memory_id = ?', [id]);

    // Remove memory
    this._run('DELETE FROM memories WHERE id = ?', [id]);

    // Audit log
    this._audit('memory', id, 'delete', {});

    this._save();
    return true;
  }

  /**
   * List memories with filters
   */
  listMemories(options = {}) {
    const {
      priority = null,
      status = 'active',
      tag = null,
      includeExpired = false,
      limit = 50,
      offset = 0
    } = options;

    let query = 'SELECT m.* FROM memories m';
    const params = [];
    const conditions = [];

    // Tag filter requires join
    if (tag) {
      query += ' JOIN memory_tags mt ON m.id = mt.memory_id JOIN tags t ON mt.tag_id = t.id';
      conditions.push('LOWER(t.name) = LOWER(?)');
      params.push(tag);
    }

    // Priority filter
    if (priority) {
      conditions.push('m.priority = ?');
      params.push(priority);
    }

    // Status filter
    if (status && status !== 'all') {
      conditions.push('m.status = ?');
      params.push(status);
    }

    // Expiry filter
    if (!includeExpired) {
      conditions.push("(m.expires_at IS NULL OR m.expires_at > datetime('now'))");
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += " ORDER BY CASE m.priority WHEN 'URGENT' THEN 1 WHEN 'DAILY' THEN 2 WHEN 'WEEKLY' THEN 3 WHEN 'ARCHIVE' THEN 4 END, m.created_at DESC";
    query += ` LIMIT ${limit} OFFSET ${offset}`;

    const memories = this._all(query, params);

    // Get tags for each memory
    return memories.map(m => {
      m.tags = this._getMemoryTags(m.id);
      return this._formatMemory(m);
    });
  }

  /**
   * Full-text search memories (keyword-based since FTS5 not available in sql.js)
   */
  searchMemoriesFTS(query, options = {}) {
    const { limit = 20, includeCompleted = false } = options;

    if (!query || typeof query !== 'string') return [];

    // Split query into words for LIKE matching
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return [];

    let sql = `SELECT * FROM memories WHERE `;
    const conditions = words.map(() => `LOWER(content) LIKE ?`);
    sql += `(${conditions.join(' OR ')})`;

    const params = words.map(w => `%${w}%`);

    if (!includeCompleted) {
      sql += " AND status = 'active'";
    }

    sql += " AND (expires_at IS NULL OR expires_at > datetime('now'))";
    sql += ` LIMIT ${limit}`;

    const memories = this._all(sql, params);

    return memories.map(m => {
      m.tags = this._getMemoryTags(m.id);
      return this._formatMemory(m);
    });
  }

  /**
   * Get pending memories (URGENT + DAILY)
   */
  getPendingMemories() {
    const memories = this._all(`
      SELECT * FROM memories
      WHERE priority IN ('URGENT', 'DAILY')
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY CASE priority WHEN 'URGENT' THEN 1 WHEN 'DAILY' THEN 2 END, created_at DESC
    `);

    return memories.map(m => {
      m.tags = this._getMemoryTags(m.id);
      return this._formatMemory(m);
    });
  }

  // ==================== PROJECT OPERATIONS ====================

  /**
   * Insert a new project
   */
  insertProject(project) {
    const id = project.id || this._generateId();
    const now = new Date().toISOString();

    // Insert project
    this._run(`
      INSERT INTO projects (id, name, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      project.name,
      project.description || '',
      project.status || 'planning',
      project.priority || 'DAILY',
      project.created || now,
      now
    ]);

    // Insert steps
    if (project.steps && project.steps.length > 0) {
      project.steps.forEach((step, index) => {
        const stepNum = typeof step === 'string' ? index + 1 : (step.id || index + 1);
        const task = typeof step === 'string' ? step : step.task;
        const status = typeof step === 'string' ? 'pending' : (step.status || 'pending');
        const notes = typeof step === 'string' ? null : (step.notes || null);

        this._run(`
          INSERT INTO project_steps (project_id, step_number, task, status, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [id, stepNum, task, status, notes, now]);
      });
    }

    // Add tags
    if (project.tags && project.tags.length > 0) {
      this._setProjectTags(id, project.tags);
    }

    // Audit log
    this._audit('project', id, 'create', { name: project.name });

    this._save();
    return id;
  }

  /**
   * Get project by ID with all details
   */
  getProject(id) {
    const project = this._get('SELECT * FROM projects WHERE id = ?', [id]);
    if (!project) return null;

    // Get steps
    project.steps = this._all(`
      SELECT * FROM project_steps WHERE project_id = ? ORDER BY step_number
    `, [id]).map(s => this._formatStep(s));

    // Get blockers
    project.blockers = this._all(`
      SELECT * FROM project_blockers WHERE project_id = ? ORDER BY created_at
    `, [id]).map(b => this._formatBlocker(b));

    // Get tags
    project.tags = this._getProjectTags(id);

    return this._formatProject(project);
  }

  /**
   * Update project
   */
  updateProject(id, updates) {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this._run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);

    // Update tags if provided
    if (updates.tags !== undefined) {
      this._setProjectTags(id, updates.tags);
    }

    // Audit log
    this._audit('project', id, 'update', updates);

    this._save();
    return true;
  }

  /**
   * Update project step
   */
  updateStep(projectId, stepNumber, updates) {
    const fields = [];
    const values = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);

      if (updates.status === 'in_progress') {
        fields.push('started_at = COALESCE(started_at, ?)');
        values.push(new Date().toISOString());
      }
      if (updates.status === 'completed') {
        fields.push('completed_at = ?');
        values.push(new Date().toISOString());
      }
    }
    if (updates.notes !== undefined) {
      fields.push('notes = ?');
      values.push(updates.notes);
    }

    values.push(projectId, stepNumber);

    this._run(`UPDATE project_steps SET ${fields.join(', ')} WHERE project_id = ? AND step_number = ?`, values);

    // Update project status based on steps
    this._autoUpdateProjectStatus(projectId);

    // Audit log
    this._audit('project_step', `${projectId}:${stepNumber}`, 'update', updates);

    this._save();
    return true;
  }

  /**
   * Add step to project
   */
  addStep(projectId, task, afterStep = null) {
    // Get current max step number
    const result = this._get('SELECT MAX(step_number) as max FROM project_steps WHERE project_id = ?', [projectId]);
    const max = result?.max || 0;

    let stepNumber;
    if (afterStep !== null && afterStep !== undefined) {
      // Shift steps after insertion point
      this._run(`
        UPDATE project_steps SET step_number = step_number + 1
        WHERE project_id = ? AND step_number > ?
      `, [projectId, afterStep]);

      stepNumber = afterStep + 1;
    } else {
      stepNumber = max + 1;
    }

    // Insert new step
    this._run(`
      INSERT INTO project_steps (project_id, step_number, task, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `, [projectId, stepNumber, task, new Date().toISOString()]);

    // Update project timestamp
    this._run('UPDATE projects SET updated_at = ? WHERE id = ?', [new Date().toISOString(), projectId]);

    // Audit log
    this._audit('project_step', `${projectId}:${stepNumber}`, 'create', { task });

    this._save();
    return stepNumber;
  }

  /**
   * Add blocker to project
   */
  addBlocker(projectId, description, stepId = null) {
    const id = this._generateId();
    const now = new Date().toISOString();

    this._run(`
      INSERT INTO project_blockers (id, project_id, step_id, description, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [id, projectId, stepId, description, now]);

    // Update project status to blocked
    this._run("UPDATE projects SET status = 'blocked', updated_at = ? WHERE id = ?", [now, projectId]);

    // Audit log
    this._audit('project_blocker', id, 'create', { description });

    this._save();
    return id;
  }

  /**
   * Resolve blocker
   */
  resolveBlocker(projectId, blockerId, resolution = 'Resolved') {
    const now = new Date().toISOString();

    this._run(`
      UPDATE project_blockers SET resolved = 1, resolution = ?, resolved_at = ?
      WHERE id = ? AND project_id = ?
    `, [resolution, now, blockerId, projectId]);

    // Check if any blockers remain
    const remaining = this._get('SELECT COUNT(*) as count FROM project_blockers WHERE project_id = ? AND resolved = 0', [projectId]);

    if (remaining.count === 0) {
      // No blockers remain, update project status
      this._run("UPDATE projects SET status = 'in_progress', updated_at = ? WHERE id = ?", [now, projectId]);
    }

    // Audit log
    this._audit('project_blocker', blockerId, 'resolve', { resolution });

    this._save();
    return true;
  }

  /**
   * List projects
   */
  listProjects(options = {}) {
    const { status = 'active', limit = 50 } = options;

    let query = 'SELECT * FROM projects';
    const params = [];

    if (status === 'active') {
      query += " WHERE status IN ('planning', 'in_progress', 'blocked')";
    } else if (status !== 'all') {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += " ORDER BY CASE priority WHEN 'URGENT' THEN 1 WHEN 'DAILY' THEN 2 WHEN 'WEEKLY' THEN 3 WHEN 'ARCHIVE' THEN 4 END, updated_at DESC";
    query += ` LIMIT ${limit}`;

    const projects = this._all(query, params);

    return projects.map(p => {
      p.tags = this._getProjectTags(p.id);

      // Get steps count
      const stepStats = this._get(`
        SELECT COUNT(*) as total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM project_steps WHERE project_id = ?
      `, [p.id]);
      p.stepsTotal = stepStats?.total || 0;
      p.stepsCompleted = stepStats?.completed || 0;

      // Get current step
      p.currentStep = this._get(`
        SELECT * FROM project_steps
        WHERE project_id = ? AND status NOT IN ('completed', 'skipped')
        ORDER BY step_number LIMIT 1
      `, [p.id]);

      // Get active blockers count
      const blockerCount = this._get('SELECT COUNT(*) as count FROM project_blockers WHERE project_id = ? AND resolved = 0', [p.id]);
      p.activeBlockers = blockerCount?.count || 0;

      return this._formatProject(p);
    });
  }

  // ==================== AUDIT OPERATIONS ====================

  /**
   * Get audit log entries
   */
  getAuditLog(options = {}) {
    const { entityType = null, entityId = null, limit = 100 } = options;

    let query = 'SELECT * FROM audit_log';
    const params = [];
    const conditions = [];

    if (entityType) {
      conditions.push('entity_type = ?');
      params.push(entityType);
    }
    if (entityId) {
      conditions.push('entity_id = ?');
      params.push(entityId);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit}`;

    return this._all(query, params);
  }

  // ==================== STATISTICS ====================

  /**
   * Get database statistics
   */
  getStats() {
    const memoryCount = this._get("SELECT COUNT(*) as count FROM memories WHERE status = 'active'")?.count || 0;
    const projectCount = this._get('SELECT COUNT(*) as count FROM projects')?.count || 0;
    const tagCount = this._get('SELECT COUNT(*) as count FROM tags')?.count || 0;
    const auditCount = this._get('SELECT COUNT(*) as count FROM audit_log')?.count || 0;

    const byPriority = {};
    const priorityRows = this._all("SELECT priority, COUNT(*) as count FROM memories WHERE status = 'active' GROUP BY priority");
    for (const row of priorityRows) {
      byPriority[row.priority] = row.count;
    }

    return {
      memories: memoryCount,
      projects: projectCount,
      tags: tagCount,
      auditEntries: auditCount,
      byPriority
    };
  }

  // ==================== INTERNAL HELPERS ====================

  /**
   * Generate unique ID
   */
  _generateId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Get tags for a memory
   */
  _getMemoryTags(memoryId) {
    const rows = this._all(`
      SELECT t.name FROM tags t
      JOIN memory_tags mt ON t.id = mt.tag_id
      WHERE mt.memory_id = ?
    `, [memoryId]);
    return rows.map(r => r.name);
  }

  /**
   * Set tags for a memory
   */
  _setMemoryTags(memoryId, tags) {
    // Remove existing tags
    this._run('DELETE FROM memory_tags WHERE memory_id = ?', [memoryId]);

    if (!tags || tags.length === 0) return;

    // Insert or get tag IDs
    for (const tag of tags) {
      this._run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tag]);
      const tagRow = this._get('SELECT id FROM tags WHERE name = ?', [tag]);
      if (tagRow) {
        this._run('INSERT OR IGNORE INTO memory_tags (memory_id, tag_id) VALUES (?, ?)', [memoryId, tagRow.id]);
      }
    }
  }

  /**
   * Get tags for a project
   */
  _getProjectTags(projectId) {
    const rows = this._all(`
      SELECT t.name FROM tags t
      JOIN project_tags pt ON t.id = pt.tag_id
      WHERE pt.project_id = ?
    `, [projectId]);
    return rows.map(r => r.name);
  }

  /**
   * Set tags for a project
   */
  _setProjectTags(projectId, tags) {
    // Remove existing tags
    this._run('DELETE FROM project_tags WHERE project_id = ?', [projectId]);

    if (!tags || tags.length === 0) return;

    for (const tag of tags) {
      this._run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tag]);
      const tagRow = this._get('SELECT id FROM tags WHERE name = ?', [tag]);
      if (tagRow) {
        this._run('INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES (?, ?)', [projectId, tagRow.id]);
      }
    }
  }

  /**
   * Auto-update project status based on steps
   */
  _autoUpdateProjectStatus(projectId) {
    const project = this._get('SELECT status FROM projects WHERE id = ?', [projectId]);
    if (!project) return;

    const steps = this._all('SELECT status FROM project_steps WHERE project_id = ?', [projectId]);
    const blockerCount = this._get('SELECT COUNT(*) as count FROM project_blockers WHERE project_id = ? AND resolved = 0', [projectId]);

    const allCompleted = steps.every(s => s.status === 'completed' || s.status === 'skipped');
    const anyInProgress = steps.some(s => s.status === 'in_progress');
    const hasActiveBlockers = (blockerCount?.count || 0) > 0;

    let newStatus = project.status;
    if (allCompleted && steps.length > 0) {
      newStatus = 'completed';
    } else if (hasActiveBlockers) {
      newStatus = 'blocked';
    } else if (anyInProgress) {
      newStatus = 'in_progress';
    }

    if (newStatus !== project.status) {
      this._run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', [newStatus, new Date().toISOString(), projectId]);
    }
  }

  /**
   * Add audit log entry
   */
  _audit(entityType, entityId, action, details) {
    try {
      this._run(`
        INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [entityType, entityId, action, JSON.stringify(details), new Date().toISOString()]);
    } catch (e) {
      // Audit logging should not fail the main operation
      console.error('Audit log error:', e.message);
    }
  }

  /**
   * Format memory from DB row to API format
   */
  _formatMemory(row) {
    return {
      id: row.id,
      content: row.content,
      priority: row.priority,
      status: row.status,
      tags: row.tags || [],
      created: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      expires: row.expires_at,
      lastChecked: row.last_checked
    };
  }

  /**
   * Format project from DB row to API format
   */
  _formatProject(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      priority: row.priority,
      tags: row.tags || [],
      steps: row.steps || [],
      blockers: row.blockers || [],
      stepsTotal: row.stepsTotal,
      stepsCompleted: row.stepsCompleted,
      currentStep: row.currentStep ? this._formatStep(row.currentStep) : null,
      activeBlockers: row.activeBlockers || 0,
      created: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Format step from DB row
   */
  _formatStep(row) {
    return {
      id: row.step_number,
      task: row.task,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  }

  /**
   * Format blocker from DB row
   */
  _formatBlocker(row) {
    return {
      id: row.id,
      description: row.description,
      stepId: row.step_id,
      resolved: !!row.resolved,
      resolution: row.resolution,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at
    };
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this._save();
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Get all memory IDs (for batch operations)
   */
  getAllMemoryIds() {
    return this._all("SELECT id FROM memories WHERE status = 'active'").map(r => r.id);
  }

  /**
   * Get all project IDs
   */
  getAllProjectIds() {
    return this._all("SELECT id FROM projects WHERE status NOT IN ('completed', 'abandoned')").map(r => r.id);
  }
}

module.exports = {
  SQLiteEngine,
  DB_FILE,
  DATA_DIR
};
