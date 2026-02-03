#!/usr/bin/env node
/**
 * MCP Memory Server v4 - SQLite + Chroma Hybrid System
 *
 * Production-grade memory system with:
 * - SQLite for structured storage and exact queries
 * - Chroma vector database for true semantic search
 * - Model-agnostic embeddings (local/OpenAI/TF-IDF fallback)
 * - Enterprise security (sanitization, optional encryption, audit logging)
 * - Reciprocal Rank Fusion for optimal search results
 *
 * FULLY BACKWARD COMPATIBLE with v3 - same 17 tools, same signatures
 *
 * Memory Tools:
 *   - remember: Store a memory with priority, tags, and optional expiration
 *   - recall: Search memories semantically by query and/or tags
 *   - check_pending: Get all items needing attention (URGENT and DAILY)
 *   - complete_memory: Mark a memory as completed
 *   - forget: Remove a memory
 *   - list_memories: List all memories with optional filters
 *   - update_memory: Modify an existing memory
 *   - find_similar: Find memories similar to a given memory
 *   - rebuild_index: Rebuild the semantic search index
 *
 * Project Tools:
 *   - create_project: Create a multi-step project
 *   - get_project: Get full project details
 *   - list_projects: List all projects
 *   - update_project: Update project metadata
 *   - update_step: Update a step's status
 *   - add_step: Add a new step to a project
 *   - add_blocker: Add a blocker to a project
 *   - resolve_blocker: Remove a blocker
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// Import components
const { SQLiteEngine } = require('../lib/sqlite-engine');
const { getEmbeddingService } = require('../lib/embedding-service');
const { ChromaEngine } = require('../lib/chroma-engine');
const { QueryFusion } = require('../lib/query-fusion');
const { getSecurityManager } = require('../lib/security');

// Directories
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, `mcp-memory-${new Date().toISOString().split('T')[0]}.log`);

// Ensure directories exist
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Priority levels
const PRIORITIES = {
  URGENT: 1,
  DAILY: 2,
  WEEKLY: 3,
  ARCHIVE: 4
};

// Engine instances
let sqliteEngine = null;
let embeddingService = null;
let chromaEngine = null;
let queryFusion = null;
let securityManager = null;
let initialized = false;

/**
 * Logging
 */
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    try {
      entry += `\n  DATA: ${JSON.stringify(data, null, 2)}`;
    } catch (e) {
      entry += `\n  DATA: [Unable to serialize]`;
    }
  }
  entry += '\n';
  try {
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
  } catch (e) { }
}

/**
 * Initialize all engines
 */
async function initialize() {
  if (initialized) return;

  log('INFO', 'Initializing Memory Server v4...');

  try {
    // Initialize security manager
    securityManager = getSecurityManager();
    log('INFO', 'Security manager initialized');

    // Initialize SQLite
    sqliteEngine = new SQLiteEngine();
    await sqliteEngine.init();
    log('INFO', 'SQLite engine initialized');

    // Initialize embedding service
    try {
      embeddingService = await getEmbeddingService();
      log('INFO', `Embedding service initialized: ${embeddingService.getInfo().provider}`);
    } catch (e) {
      log('WARN', `Embedding service initialization failed: ${e.message}`);
      // Continue without embeddings - will use TF-IDF fallback
    }

    // Initialize Chroma
    try {
      chromaEngine = new ChromaEngine();
      await chromaEngine.init(embeddingService);
      log('INFO', 'Chroma engine initialized');
    } catch (e) {
      log('WARN', `Chroma initialization failed: ${e.message}`);
      // Continue without Chroma - SQLite FTS will handle search
    }

    // Initialize query fusion
    queryFusion = new QueryFusion(sqliteEngine, chromaEngine);
    log('INFO', 'Query fusion initialized');

    initialized = true;
    log('INFO', 'Memory Server v4 fully initialized');

  } catch (e) {
    log('ERROR', 'Initialization failed', { error: e.message, stack: e.stack });
    throw e;
  }
}

/**
 * Generate unique ID
 */
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Format memory for display
 */
function formatMemory(m, showScore = false) {
  let result = `[${m.id}] [${m.priority}] ${m.content}`;
  if (m.tags && m.tags.length) result += ` (tags: ${m.tags.join(', ')})`;
  if (m.status === 'completed') result += ' [DONE]';
  if (showScore && m.relevanceScore) result += ` (relevance: ${(m.relevanceScore * 100).toFixed(0)}%)`;
  if (showScore && m.fusionScore) result += ` (fusion: ${(m.fusionScore * 100).toFixed(0)}%)`;
  return result;
}

/**
 * Format project for display
 */
function formatProject(p, verbose = false) {
  const progress = p.stepsTotal > 0
    ? Math.round((p.stepsCompleted / p.stepsTotal) * 100)
    : 0;

  let result = `[${p.id}] ${p.name} - ${p.status.toUpperCase()} (${progress}%)`;
  if (p.activeBlockers > 0) result += ` [${p.activeBlockers} BLOCKERS]`;
  if (p.currentStep) result += `\n  Current: Step ${p.currentStep.id} - ${p.currentStep.task}`;

  if (verbose) {
    result += `\n  Priority: ${p.priority}`;
    result += `\n  Tags: ${p.tags.join(', ') || 'none'}`;
    if (p.steps && p.steps.length > 0) {
      result += `\n  Steps:`;
      for (const step of p.steps) {
        const statusIcon = step.status === 'completed' ? '✓' :
                          step.status === 'in_progress' ? '→' :
                          step.status === 'skipped' ? '⊘' : '○';
        result += `\n    ${statusIcon} ${step.id}. ${step.task}`;
        if (step.notes) result += ` (${step.notes})`;
      }
    }
    if (p.blockers && p.blockers.filter(b => !b.resolved).length > 0) {
      result += `\n  Blockers:`;
      for (const blocker of p.blockers.filter(b => !b.resolved)) {
        result += `\n    ⚠ ${blocker.description}`;
      }
    }
  }

  return result;
}

// ==================== TOOL HANDLERS ====================

async function handleRemember(args) {
  // Rate limit check
  const rateCheck = securityManager.checkRateLimit('remember');
  if (!rateCheck.allowed) {
    return {
      content: [{
        type: 'text',
        text: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`
      }]
    };
  }

  // Sanitize input
  const sanitized = securityManager.sanitizeMemory(args);
  const id = generateId();

  // Calculate expiry
  let expires = null;
  if (sanitized.expires_days) {
    const expiresDate = new Date();
    expiresDate.setDate(expiresDate.getDate() + sanitized.expires_days);
    expires = expiresDate.toISOString();
  }

  const memory = {
    id,
    content: sanitized.content,
    priority: sanitized.priority,
    tags: sanitized.tags,
    created: new Date().toISOString(),
    expires,
    status: 'active'
  };

  // Store in SQLite
  sqliteEngine.insertMemory(memory);

  // Store in Chroma (async, don't block)
  if (chromaEngine && embeddingService) {
    try {
      const embedding = await embeddingService.embed(memory.content);
      await chromaEngine.upsertMemory(id, memory.content, {
        priority: memory.priority,
        status: memory.status,
        created: memory.created
      }, embedding);
    } catch (e) {
      log('WARN', 'Chroma upsert failed', { error: e.message });
    }
  }

  // Audit log
  securityManager.audit('create', 'memory', id, { priority: memory.priority });

  log('INFO', 'Memory stored', { id, priority: memory.priority });

  // Find similar memories
  let similarText = '';
  if (chromaEngine) {
    try {
      const similar = await chromaEngine.findSimilarMemories(id, 3);
      if (similar.length > 0) {
        similarText = '\n\nRelated memories:\n' + similar.map(s =>
          `- ${(s.document || '').slice(0, 80)}...`
        ).join('\n');
      }
    } catch (e) {
      // Ignore similarity errors
    }
  }

  return {
    content: [{
      type: 'text',
      text: `Memory stored with ID: ${id}\n\nPriority: ${memory.priority}\nTags: ${memory.tags.join(', ') || 'none'}\nExpires: ${memory.expires || 'never'}${similarText}`
    }]
  };
}

async function handleRecall(args) {
  const rateCheck = securityManager.checkRateLimit('recall');
  if (!rateCheck.allowed) {
    return {
      content: [{
        type: 'text',
        text: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`
      }]
    };
  }

  const results = await queryFusion.searchMemories(args.query || '', {
    priority: args.priority,
    tag: args.tag,
    includeCompleted: args.include_completed,
    limit: 20
  });

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No memories found matching your query.'
      }]
    };
  }

  const hasScores = results[0].fusionScore !== undefined || results[0].relevanceScore !== undefined;
  const formatted = results.map(m => formatMemory(m, hasScores)).join('\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} memories (hybrid search):\n\n${formatted}`
    }]
  };
}

async function handleCheckPending() {
  // Get pending memories from SQLite
  const pending = sqliteEngine.getPendingMemories();
  const urgent = pending.filter(m => m.priority === 'URGENT');
  const daily = pending.filter(m => m.priority === 'DAILY');

  // Get active projects
  const projects = sqliteEngine.listProjects({ status: 'active' });
  const blocked = projects.filter(p => p.status === 'blocked');
  const active = projects.filter(p => p.status !== 'blocked');

  // Update lastChecked for memories
  const now = new Date().toISOString();
  for (const m of pending) {
    sqliteEngine.updateMemory(m.id, { lastChecked: now });
  }

  let response = '';

  if (urgent.length > 0) {
    response += `**URGENT (${urgent.length}):**\n${urgent.map(m => formatMemory(m)).join('\n')}\n\n`;
  }

  if (daily.length > 0) {
    response += `**DAILY (${daily.length}):**\n${daily.map(m => formatMemory(m)).join('\n')}\n\n`;
  }

  if (blocked.length > 0) {
    response += `**BLOCKED PROJECTS (${blocked.length}):**\n${blocked.map(p => formatProject(p, false)).join('\n\n')}\n\n`;
  }

  if (active.length > 0) {
    response += `**ACTIVE PROJECTS (${active.length}):**\n${active.map(p => formatProject(p, false)).join('\n\n')}`;
  }

  if (!response) {
    response = 'No pending items! All caught up.';
  }

  return {
    content: [{
      type: 'text',
      text: response.trim()
    }]
  };
}

async function handleCompleteMemory(args) {
  const id = securityManager.sanitizeId(args.id);
  const memory = sqliteEngine.getMemory(id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  sqliteEngine.updateMemory(id, {
    status: 'completed',
    completedAt: new Date().toISOString()
  });

  // Remove from Chroma (completed items shouldn't appear in search)
  if (chromaEngine) {
    try {
      await chromaEngine.deleteMemory(id);
    } catch (e) {
      log('WARN', 'Chroma delete failed', { error: e.message });
    }
  }

  securityManager.audit('complete', 'memory', id, {});
  log('INFO', 'Memory completed', { id });

  return {
    content: [{
      type: 'text',
      text: `Marked as completed: ${memory.content}`
    }]
  };
}

async function handleForget(args) {
  const rateCheck = securityManager.checkRateLimit('delete');
  if (!rateCheck.allowed) {
    return {
      content: [{
        type: 'text',
        text: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`
      }]
    };
  }

  const id = securityManager.sanitizeId(args.id);
  const memory = sqliteEngine.getMemory(id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  // Delete from SQLite
  sqliteEngine.deleteMemory(id);

  // Delete from Chroma
  if (chromaEngine) {
    try {
      await chromaEngine.deleteMemory(id);
    } catch (e) {
      log('WARN', 'Chroma delete failed', { error: e.message });
    }
  }

  securityManager.audit('delete', 'memory', id, {});
  log('INFO', 'Memory deleted', { id });

  return {
    content: [{
      type: 'text',
      text: `Deleted memory: ${memory.content}`
    }]
  };
}

async function handleListMemories(args) {
  const memories = sqliteEngine.listMemories({
    priority: args.priority,
    status: args.status || 'active',
    limit: args.limit || 50
  });

  if (memories.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No memories found.'
      }]
    };
  }

  // Group by priority
  const grouped = {};
  memories.forEach(m => {
    if (!grouped[m.priority]) grouped[m.priority] = [];
    grouped[m.priority].push(m);
  });

  let response = `Total: ${memories.length} memories\n\n`;

  for (const priority of ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE']) {
    if (grouped[priority]) {
      response += `**${priority} (${grouped[priority].length}):**\n`;
      response += grouped[priority].map(m => formatMemory(m)).join('\n');
      response += '\n\n';
    }
  }

  // Add stats
  const stats = sqliteEngine.getStats();
  response += `\n_Database: ${stats.memories} memories, ${stats.tags} tags_`;

  return {
    content: [{
      type: 'text',
      text: response.trim()
    }]
  };
}

async function handleUpdateMemory(args) {
  const rateCheck = securityManager.checkRateLimit('update');
  if (!rateCheck.allowed) {
    return {
      content: [{
        type: 'text',
        text: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`
      }]
    };
  }

  const id = securityManager.sanitizeId(args.id);
  const memory = sqliteEngine.getMemory(id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  const updates = {};
  if (args.content) updates.content = securityManager.sanitizer.sanitizeContent(args.content);
  if (args.priority) updates.priority = securityManager.sanitizer.validatePriority(args.priority);
  if (args.tags) updates.tags = securityManager.sanitizer.sanitizeTags(args.tags);
  if (args.add_tags) updates.addTags = securityManager.sanitizer.sanitizeTags(args.add_tags);

  sqliteEngine.updateMemory(id, updates);

  // Update in Chroma if content changed
  if (chromaEngine && updates.content) {
    try {
      const updatedMemory = sqliteEngine.getMemory(id);
      const embedding = embeddingService ? await embeddingService.embed(updatedMemory.content) : null;
      if (embedding) {
        await chromaEngine.upsertMemory(id, updatedMemory.content, {
          priority: updatedMemory.priority,
          status: updatedMemory.status
        }, embedding);
      }
    } catch (e) {
      log('WARN', 'Chroma update failed', { error: e.message });
    }
  }

  securityManager.audit('update', 'memory', id, updates);
  log('INFO', 'Memory updated', { id });

  const updatedMemory = sqliteEngine.getMemory(id);
  return {
    content: [{
      type: 'text',
      text: `Updated memory:\n${formatMemory(updatedMemory)}`
    }]
  };
}

async function handleFindSimilar(args) {
  const id = securityManager.sanitizeId(args.id);
  const memory = sqliteEngine.getMemory(id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  const limit = args.limit || 5;
  const similar = await queryFusion.findSimilarMemories(id, limit);

  if (similar.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No similar memories found for: ${memory.content.slice(0, 50)}...`
      }]
    };
  }

  const results = similar.map(s =>
    `[${((s.fusionScore || s.relevanceScore || 0) * 100).toFixed(0)}% similar] ${formatMemory(s)}`
  );

  return {
    content: [{
      type: 'text',
      text: `Memories similar to "${memory.content.slice(0, 50)}...":\n\n${results.join('\n')}`
    }]
  };
}

async function handleRebuildIndex() {
  log('INFO', 'Rebuilding indexes...');

  // Clear and rebuild Chroma
  if (chromaEngine) {
    try {
      await chromaEngine.clear();

      // Re-index all active memories
      const memories = sqliteEngine.listMemories({ status: 'active', limit: 10000 });

      if (embeddingService && memories.length > 0) {
        const items = [];
        for (const memory of memories) {
          const embedding = await embeddingService.embed(memory.content);
          items.push({
            id: memory.id,
            content: memory.content,
            metadata: {
              priority: memory.priority,
              status: memory.status,
              created: memory.created
            },
            embedding
          });
        }
        await chromaEngine.upsertMemoriesBatch(items);
      }

      // Re-index projects
      const projects = sqliteEngine.listProjects({ status: 'all' });
      for (const project of projects) {
        const fullProject = sqliteEngine.getProject(project.id);
        if (fullProject) {
          const stepsText = fullProject.steps.map(s => s.task).join(' ');
          const content = `${fullProject.name} ${fullProject.description || ''} ${stepsText}`;
          const embedding = embeddingService ? await embeddingService.embed(content) : null;
          if (embedding) {
            await chromaEngine.upsertProject(fullProject.id, fullProject.name, fullProject.description, fullProject.steps, {
              priority: fullProject.priority,
              status: fullProject.status
            }, embedding);
          }
        }
      }

      log('INFO', 'Indexes rebuilt successfully');
    } catch (e) {
      log('ERROR', 'Index rebuild failed', { error: e.message });
      return {
        content: [{
          type: 'text',
          text: `Index rebuild failed: ${e.message}`
        }]
      };
    }
  }

  const stats = sqliteEngine.getStats();
  const chromaStats = chromaEngine ? await chromaEngine.getStats() : { memories: 0, projects: 0 };

  return {
    content: [{
      type: 'text',
      text: `Indexes rebuilt.\n\nSQLite: ${stats.memories} memories, ${stats.projects} projects\nChroma: ${chromaStats.memories} memory vectors, ${chromaStats.projects} project vectors`
    }]
  };
}

// ==================== PROJECT HANDLERS ====================

async function handleCreateProject(args) {
  const sanitized = securityManager.sanitizeProject(args);
  const id = generateId();

  const project = {
    id,
    name: sanitized.name,
    description: sanitized.description,
    status: 'planning',
    priority: sanitized.priority,
    tags: sanitized.tags,
    steps: sanitized.steps,
    created: new Date().toISOString()
  };

  sqliteEngine.insertProject(project);

  // Index in Chroma
  if (chromaEngine && embeddingService) {
    try {
      const stepsText = project.steps.map(s => typeof s === 'string' ? s : s.task).join(' ');
      const content = `${project.name} ${project.description} ${stepsText}`;
      const embedding = await embeddingService.embed(content);
      await chromaEngine.upsertProject(id, project.name, project.description, project.steps, {
        priority: project.priority,
        status: project.status
      }, embedding);
    } catch (e) {
      log('WARN', 'Project Chroma index failed', { error: e.message });
    }
  }

  securityManager.audit('create', 'project', id, { name: project.name });
  log('INFO', 'Project created', { id, name: project.name });

  const fullProject = sqliteEngine.getProject(id);

  return {
    content: [{
      type: 'text',
      text: `Project created: ${id}\n\n${formatProject(fullProject, true)}`
    }]
  };
}

async function handleGetProject(args) {
  const id = securityManager.sanitizeId(args.id);
  const project = sqliteEngine.getProject(id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.id}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: formatProject(project, true)
    }]
  };
}

async function handleListProjects(args) {
  const projects = sqliteEngine.listProjects({
    status: args.status || 'active'
  });

  if (projects.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No projects found with status: ${args.status || 'active'}`
      }]
    };
  }

  const formatted = projects.map(p => formatProject(p, false)).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${projects.length} projects:\n\n${formatted}`
    }]
  };
}

async function handleUpdateProject(args) {
  const id = securityManager.sanitizeId(args.id);
  const project = sqliteEngine.getProject(id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.id}`
      }]
    };
  }

  const updates = {};
  if (args.name) updates.name = securityManager.sanitizer.sanitizeContent(args.name).slice(0, 200);
  if (args.description) updates.description = securityManager.sanitizer.sanitizeContent(args.description).slice(0, 5000);
  if (args.status) updates.status = securityManager.sanitizer.validateStatus(args.status, 'project');
  if (args.priority) updates.priority = securityManager.sanitizer.validatePriority(args.priority);
  if (args.tags) updates.tags = securityManager.sanitizer.sanitizeTags(args.tags);

  sqliteEngine.updateProject(id, updates);

  // Update in Chroma
  if (chromaEngine && embeddingService && (updates.name || updates.description)) {
    try {
      const updatedProject = sqliteEngine.getProject(id);
      const stepsText = updatedProject.steps.map(s => s.task).join(' ');
      const content = `${updatedProject.name} ${updatedProject.description || ''} ${stepsText}`;
      const embedding = await embeddingService.embed(content);
      await chromaEngine.upsertProject(id, updatedProject.name, updatedProject.description, updatedProject.steps, {
        priority: updatedProject.priority,
        status: updatedProject.status
      }, embedding);
    } catch (e) {
      log('WARN', 'Project Chroma update failed', { error: e.message });
    }
  }

  securityManager.audit('update', 'project', id, updates);
  log('INFO', 'Project updated', { id });

  const updatedProject = sqliteEngine.getProject(id);

  return {
    content: [{
      type: 'text',
      text: `Project updated:\n\n${formatProject(updatedProject, true)}`
    }]
  };
}

async function handleUpdateStep(args) {
  const projectId = securityManager.sanitizeId(args.project_id);
  const project = sqliteEngine.getProject(projectId);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const stepNumber = parseInt(args.step_id);
  if (isNaN(stepNumber) || stepNumber < 1) {
    return {
      content: [{
        type: 'text',
        text: `Invalid step number: ${args.step_id}`
      }]
    };
  }

  const step = project.steps.find(s => s.id === stepNumber);
  if (!step) {
    return {
      content: [{
        type: 'text',
        text: `Step not found: ${stepNumber} in project ${projectId}`
      }]
    };
  }

  const oldStatus = step.status;
  const updates = {};
  if (args.status) updates.status = securityManager.sanitizer.validateStatus(args.status, 'step');
  if (args.notes) updates.notes = securityManager.sanitizer.sanitizeContent(args.notes).slice(0, 1000);

  sqliteEngine.updateStep(projectId, stepNumber, updates);

  securityManager.audit('update', 'project_step', `${projectId}:${stepNumber}`, { oldStatus, ...updates });
  log('INFO', 'Step updated', { projectId, stepNumber, oldStatus, newStatus: updates.status });

  const updatedProject = sqliteEngine.getProject(projectId);
  const progress = updatedProject.stepsTotal > 0
    ? Math.round((updatedProject.stepsCompleted / updatedProject.stepsTotal) * 100)
    : 0;

  return {
    content: [{
      type: 'text',
      text: `Step ${stepNumber} updated: ${oldStatus} → ${updates.status || step.status}\n\nProject progress: ${progress}%\n\n${formatProject(updatedProject, false)}`
    }]
  };
}

async function handleAddStep(args) {
  const projectId = securityManager.sanitizeId(args.project_id);
  const project = sqliteEngine.getProject(projectId);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const task = securityManager.sanitizer.sanitizeContent(args.task).slice(0, 500);
  const afterStep = args.after_step !== undefined ? parseInt(args.after_step) : null;

  sqliteEngine.addStep(projectId, task, afterStep);

  // Re-index in Chroma
  if (chromaEngine && embeddingService) {
    try {
      const updatedProject = sqliteEngine.getProject(projectId);
      const stepsText = updatedProject.steps.map(s => s.task).join(' ');
      const content = `${updatedProject.name} ${updatedProject.description || ''} ${stepsText}`;
      const embedding = await embeddingService.embed(content);
      await chromaEngine.upsertProject(projectId, updatedProject.name, updatedProject.description, updatedProject.steps, {
        priority: updatedProject.priority,
        status: updatedProject.status
      }, embedding);
    } catch (e) {
      log('WARN', 'Project Chroma re-index failed', { error: e.message });
    }
  }

  securityManager.audit('add_step', 'project', projectId, { task });
  log('INFO', 'Step added', { projectId, task });

  const updatedProject = sqliteEngine.getProject(projectId);

  return {
    content: [{
      type: 'text',
      text: `Step added to project ${project.name}:\n\n${formatProject(updatedProject, true)}`
    }]
  };
}

async function handleAddBlocker(args) {
  const projectId = securityManager.sanitizeId(args.project_id);
  const project = sqliteEngine.getProject(projectId);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const description = securityManager.sanitizer.sanitizeContent(args.description).slice(0, 1000);
  const stepId = args.step_id ? parseInt(args.step_id) : null;

  const blockerId = sqliteEngine.addBlocker(projectId, description, stepId);

  securityManager.audit('add_blocker', 'project', projectId, { blockerId, description });
  log('INFO', 'Blocker added', { projectId, blockerId });

  return {
    content: [{
      type: 'text',
      text: `Blocker added to project ${project.name}:\n\n⚠ ${description}\n\nBlocker ID: ${blockerId}`
    }]
  };
}

async function handleResolveBlocker(args) {
  const projectId = securityManager.sanitizeId(args.project_id);
  const blockerId = securityManager.sanitizeId(args.blocker_id);

  const project = sqliteEngine.getProject(projectId);
  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const blocker = project.blockers.find(b => b.id === blockerId);
  if (!blocker) {
    return {
      content: [{
        type: 'text',
        text: `Blocker not found: ${blockerId}`
      }]
    };
  }

  const resolution = securityManager.sanitizer.sanitizeContent(args.resolution || 'Resolved').slice(0, 500);

  sqliteEngine.resolveBlocker(projectId, blockerId, resolution);

  securityManager.audit('resolve_blocker', 'project', projectId, { blockerId, resolution });
  log('INFO', 'Blocker resolved', { projectId, blockerId });

  const updatedProject = sqliteEngine.getProject(projectId);

  return {
    content: [{
      type: 'text',
      text: `Blocker resolved: ${blocker.description}\n\nResolution: ${resolution}\n\nProject status: ${updatedProject.status}`
    }]
  };
}

// ==================== TOOL DEFINITIONS ====================

const TOOLS = [
  {
    name: 'remember',
    description: 'Store a memory for later recall. Use this to remember important things like active bounties, pending PRs, tasks to follow up on, or any information you need to track.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to remember (e.g., "PR #45 submitted to algora/repo, awaiting review")'
        },
        priority: {
          type: 'string',
          enum: ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'],
          description: 'Priority level: URGENT (check every conversation), DAILY (check daily), WEEKLY (check weekly), ARCHIVE (long-term storage)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization (e.g., ["bounty", "algora", "pr"])'
        },
        expires_days: {
          type: 'number',
          description: 'Optional: Number of days until this memory expires (default: no expiration)'
        }
      },
      required: ['content', 'priority']
    }
  },
  {
    name: 'recall',
    description: 'Search and retrieve memories by query, tags, or priority. Uses semantic search to find related memories even with different wording.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against memory content and tags'
        },
        priority: {
          type: 'string',
          enum: ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'],
          description: 'Filter by priority level'
        },
        tag: {
          type: 'string',
          description: 'Filter by specific tag'
        },
        include_completed: {
          type: 'boolean',
          description: 'Include completed memories in results (default: false)'
        }
      }
    }
  },
  {
    name: 'check_pending',
    description: 'Get all memories that need attention (URGENT and DAILY priorities). Use this at the start of conversations to see what needs follow-up.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'complete_memory',
    description: 'Mark a memory as completed. Use this when a task/bounty/PR is done.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The memory ID to mark as completed'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'forget',
    description: 'Permanently delete a memory.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The memory ID to delete'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'list_memories',
    description: 'List all memories with optional filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        priority: {
          type: 'string',
          enum: ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'],
          description: 'Filter by priority'
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'all'],
          description: 'Filter by status (default: active)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of memories to return (default: 50)'
        }
      }
    }
  },
  {
    name: 'update_memory',
    description: 'Update an existing memory (change content, priority, tags, or status).',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The memory ID to update'
        },
        content: {
          type: 'string',
          description: 'New content (optional)'
        },
        priority: {
          type: 'string',
          enum: ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'],
          description: 'New priority (optional)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (optional, replaces existing)'
        },
        add_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add (optional)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'find_similar',
    description: 'Find memories similar to a given memory ID. Useful for finding related context.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The memory ID to find similar memories for'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of similar memories to return (default: 5)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'rebuild_index',
    description: 'Rebuild the semantic search index. Use if search results seem stale or after bulk imports.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // Project tools
  {
    name: 'create_project',
    description: 'Create a new multi-step project for tracking complex tasks. Projects have steps, status, and blockers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name (e.g., "Build Chrome Extension")'
        },
        description: {
          type: 'string',
          description: 'Detailed description of the project goal'
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of step descriptions in order (e.g., ["Research competitors", "Design architecture", "Build MVP"])'
        },
        priority: {
          type: 'string',
          enum: ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'],
          description: 'Priority level for the project'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization'
        }
      },
      required: ['name', 'steps']
    }
  },
  {
    name: 'get_project',
    description: 'Get full details of a project including all steps and blockers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The project ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'list_projects',
    description: 'List all projects with optional status filter.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['planning', 'in_progress', 'blocked', 'completed', 'abandoned', 'active', 'all'],
          description: 'Filter by status. "active" = planning + in_progress + blocked (default)'
        }
      }
    }
  },
  {
    name: 'update_project',
    description: 'Update project metadata (name, description, priority, status, tags).',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The project ID'
        },
        name: {
          type: 'string',
          description: 'New project name'
        },
        description: {
          type: 'string',
          description: 'New description'
        },
        status: {
          type: 'string',
          enum: ['planning', 'in_progress', 'blocked', 'completed', 'abandoned'],
          description: 'New status'
        },
        priority: {
          type: 'string',
          enum: ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'],
          description: 'New priority'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (replaces existing)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'update_step',
    description: 'Update a step\'s status or add notes. Use this to track progress through a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID'
        },
        step_id: {
          type: 'number',
          description: 'The step number (1-indexed)'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'skipped'],
          description: 'New step status'
        },
        notes: {
          type: 'string',
          description: 'Notes about this step (progress, findings, etc.)'
        }
      },
      required: ['project_id', 'step_id']
    }
  },
  {
    name: 'add_step',
    description: 'Add a new step to an existing project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID'
        },
        task: {
          type: 'string',
          description: 'Description of the new step'
        },
        after_step: {
          type: 'number',
          description: 'Insert after this step number (0 = at beginning, omit = at end)'
        }
      },
      required: ['project_id', 'task']
    }
  },
  {
    name: 'add_blocker',
    description: 'Add a blocker to a project. Blockers are issues preventing progress.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID'
        },
        description: {
          type: 'string',
          description: 'Description of the blocker'
        },
        step_id: {
          type: 'number',
          description: 'Which step is blocked (optional)'
        }
      },
      required: ['project_id', 'description']
    }
  },
  {
    name: 'resolve_blocker',
    description: 'Mark a blocker as resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID'
        },
        blocker_id: {
          type: 'string',
          description: 'The blocker ID to resolve'
        },
        resolution: {
          type: 'string',
          description: 'How the blocker was resolved'
        }
      },
      required: ['project_id', 'blocker_id']
    }
  }
];

// ==================== MCP SERVER ====================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  log('DEBUG', `Response for id=${id}`, result);
  process.stdout.write(response + '\n');
}

function respondError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  log('ERROR', `Error response for id=${id}`, { code, message });
  process.stdout.write(response + '\n');
}

log('INFO', 'Memory MCP Server v4 (SQLite + Chroma Hybrid) starting');

// Initialize on first request
let initPromise = null;

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    log('DEBUG', `Received: ${method}`, { id });

    // Ensure initialization
    if (!initialized && !initPromise) {
      initPromise = initialize();
    }
    if (initPromise) {
      await initPromise;
      initPromise = null;
    }

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-server', version: '4.0.0' }
      });
    }
    else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      log('INFO', `Tool call: ${name}`, args);

      let result;
      try {
        switch (name) {
          case 'remember':
            result = await handleRemember(args || {});
            break;
          case 'recall':
            result = await handleRecall(args || {});
            break;
          case 'check_pending':
            result = await handleCheckPending();
            break;
          case 'complete_memory':
            result = await handleCompleteMemory(args || {});
            break;
          case 'forget':
            result = await handleForget(args || {});
            break;
          case 'list_memories':
            result = await handleListMemories(args || {});
            break;
          case 'update_memory':
            result = await handleUpdateMemory(args || {});
            break;
          case 'find_similar':
            result = await handleFindSimilar(args || {});
            break;
          case 'rebuild_index':
            result = await handleRebuildIndex();
            break;
          // Project tools
          case 'create_project':
            result = await handleCreateProject(args || {});
            break;
          case 'get_project':
            result = await handleGetProject(args || {});
            break;
          case 'list_projects':
            result = await handleListProjects(args || {});
            break;
          case 'update_project':
            result = await handleUpdateProject(args || {});
            break;
          case 'update_step':
            result = await handleUpdateStep(args || {});
            break;
          case 'add_step':
            result = await handleAddStep(args || {});
            break;
          case 'add_blocker':
            result = await handleAddBlocker(args || {});
            break;
          case 'resolve_blocker':
            result = await handleResolveBlocker(args || {});
            break;
          default:
            respondError(id, -32601, `Unknown tool: ${name}`);
            return;
        }

        respond(id, result);
      } catch (e) {
        log('ERROR', `Tool ${name} failed`, { error: e.message, stack: e.stack });
        respond(id, {
          content: [{
            type: 'text',
            text: `Error: ${e.message}`
          }]
        });
      }
    }
    else if (method === 'notifications/initialized') {
      // No response needed
    }
    else {
      respondError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    log('ERROR', 'Parse error', { error: e.message, line: line.slice(0, 200) });
  }
});

rl.on('close', () => {
  if (sqliteEngine) {
    sqliteEngine.close();
  }
  if (securityManager) {
    securityManager.shutdown();
  }
  log('INFO', 'Memory MCP Server v4 shutting down');
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', { error: e.message, stack: e.stack });
});

log('INFO', 'Memory MCP Server v4 ready');
process.stderr.write('Memory MCP server v4 (SQLite + Chroma hybrid) started\n');
