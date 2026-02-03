#!/usr/bin/env node
/**
 * MCP Memory Server v3 - With Semantic Search + Project Tracking
 * Persistent memory system for Claude with TF-IDF based semantic recall
 *
 * NEW in v3:
 *   - Project tracking for multi-step tasks
 *   - Step-by-step progress management
 *   - Blocker tracking
 *   - Project indexing in semantic search
 *
 * v2 features:
 *   - Semantic search using TF-IDF + cosine similarity
 *   - Synonym expansion for better matching
 *   - Automatic indexing of all memories
 *   - Similar memory suggestions
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

// Import semantic search
const { SemanticIndex } = require('../lib/semantic-search');

// Storage location
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.json');
const PROJECTS_FILE = path.join(MEMORY_DIR, 'projects.json');
const INDEX_FILE = path.join(MEMORY_DIR, 'semantic-index.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', `mcp-memory-${new Date().toISOString().split('T')[0]}.log`);

// Ensure directories exist
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Priority levels
const PRIORITIES = {
  URGENT: 1,    // Check every conversation
  DAILY: 2,     // Check once per day
  WEEKLY: 3,    // Check weekly
  ARCHIVE: 4    // Long-term storage, rarely checked
};

// Project status levels
const PROJECT_STATUS = {
  planning: 'planning',
  in_progress: 'in_progress',
  blocked: 'blocked',
  completed: 'completed',
  abandoned: 'abandoned'
};

// Step status levels
const STEP_STATUS = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  skipped: 'skipped'
};

// Semantic search index
let semanticIndex = new SemanticIndex(INDEX_FILE);

/**
 * Load projects from disk
 */
function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const data = fs.readFileSync(PROJECTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    log('ERROR', 'Failed to load projects', { error: e.message });
  }
  return { projects: [], metadata: { created: new Date().toISOString(), version: 1 } };
}

/**
 * Save projects to disk
 */
function saveProjects(data) {
  try {
    data.metadata.lastModified = new Date().toISOString();
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf8');
    log('INFO', 'Projects saved', { count: data.projects.length });
    return true;
  } catch (e) {
    log('ERROR', 'Failed to save projects', { error: e.message });
    return false;
  }
}

/**
 * Index a project in semantic search
 */
function indexProject(project) {
  const indexText = `PROJECT: ${project.name} ${project.description || ''} ${project.tags.join(' ')} ${project.steps.map(s => s.task).join(' ')}`;
  semanticIndex.addDocument(`project_${project.id}`, indexText, {
    type: 'project',
    priority: project.priority,
    created: project.created,
    tags: project.tags
  });
}

/**
 * Calculate project progress
 */
function calculateProgress(project) {
  if (!project.steps || project.steps.length === 0) return 0;
  const completed = project.steps.filter(s => s.status === 'completed').length;
  return Math.round((completed / project.steps.length) * 100);
}

/**
 * Get current step (first non-completed step)
 */
function getCurrentStep(project) {
  return project.steps.find(s => s.status !== 'completed' && s.status !== 'skipped');
}

/**
 * Format project for display
 */
function formatProject(p, verbose = false) {
  const progress = calculateProgress(p);
  const currentStep = getCurrentStep(p);
  const blockerCount = p.blockers ? p.blockers.filter(b => !b.resolved).length : 0;

  let result = `[${p.id}] ${p.name} - ${p.status.toUpperCase()} (${progress}%)`;
  if (blockerCount > 0) result += ` [${blockerCount} BLOCKERS]`;
  if (currentStep) result += `\n  Current: Step ${currentStep.id} - ${currentStep.task}`;

  if (verbose) {
    result += `\n  Priority: ${p.priority}`;
    result += `\n  Tags: ${p.tags.join(', ') || 'none'}`;
    result += `\n  Steps:`;
    for (const step of p.steps) {
      const statusIcon = step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '→' : step.status === 'skipped' ? '⊘' : '○';
      result += `\n    ${statusIcon} ${step.id}. ${step.task}`;
      if (step.notes) result += ` (${step.notes})`;
    }
    if (blockerCount > 0) {
      result += `\n  Blockers:`;
      for (const blocker of p.blockers.filter(b => !b.resolved)) {
        result += `\n    ⚠ ${blocker.description}`;
      }
    }
  }

  return result;
}

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
 * Load memories from disk
 */
function loadMemories() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = fs.readFileSync(MEMORY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    log('ERROR', 'Failed to load memories', { error: e.message });
  }
  return { memories: [], metadata: { created: new Date().toISOString(), version: 2 } };
}

/**
 * Save memories to disk
 */
function saveMemories(data) {
  try {
    data.metadata.lastModified = new Date().toISOString();
    data.metadata.version = 2;
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
    log('INFO', 'Memories saved', { count: data.memories.length });
    return true;
  } catch (e) {
    log('ERROR', 'Failed to save memories', { error: e.message });
    return false;
  }
}

/**
 * Rebuild semantic index from all memories
 */
function rebuildIndex() {
  const data = loadMemories();
  semanticIndex = new SemanticIndex(INDEX_FILE);

  for (const memory of data.memories) {
    if (!isExpired(memory) && memory.status !== 'completed') {
      // Combine content and tags for better indexing
      const indexText = `${memory.content} ${memory.tags.join(' ')}`;
      semanticIndex.addDocument(memory.id, indexText, {
        priority: memory.priority,
        created: memory.created,
        tags: memory.tags
      });
    }
  }

  semanticIndex.save();
  log('INFO', 'Semantic index rebuilt', semanticIndex.getStats());
}

/**
 * Add memory to semantic index
 */
function indexMemory(memory) {
  const indexText = `${memory.content} ${memory.tags.join(' ')}`;
  semanticIndex.addDocument(memory.id, indexText, {
    priority: memory.priority,
    created: memory.created,
    tags: memory.tags
  });
}

/**
 * Generate unique ID
 */
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Check if memory is expired
 */
function isExpired(memory) {
  if (!memory.expires) return false;
  return new Date(memory.expires) < new Date();
}

/**
 * Semantic search memories
 */
function semanticSearchMemories(query, options = {}) {
  const {
    priorityFilter = null,
    tagFilter = null,
    includeCompleted = false,
    limit = 20,
    threshold = 0.05  // Lower threshold for more results
  } = options;

  // Get semantic matches
  const semanticResults = semanticIndex.search(query, {
    limit: limit * 2,  // Get more, then filter
    threshold,
    expandSynonyms: true,
    boostRecent: true,
    recentDays: 14
  });

  // Load memories for filtering
  const data = loadMemories();
  const memoryMap = new Map(data.memories.map(m => [m.id, m]));

  // Filter and enhance results
  const results = [];

  for (const result of semanticResults) {
    const memory = memoryMap.get(result.id);
    if (!memory) continue;

    // Skip expired
    if (isExpired(memory)) continue;

    // Skip completed unless requested
    if (!includeCompleted && memory.status === 'completed') continue;

    // Priority filter
    if (priorityFilter && memory.priority !== priorityFilter) continue;

    // Tag filter
    if (tagFilter && !memory.tags.some(t => t.toLowerCase() === tagFilter.toLowerCase())) continue;

    results.push({
      ...memory,
      relevanceScore: result.score
    });

    if (results.length >= limit) break;
  }

  // Sort by relevance, then priority
  results.sort((a, b) => {
    // Higher relevance first
    const scoreDiff = b.relevanceScore - a.relevanceScore;
    if (Math.abs(scoreDiff) > 0.1) return scoreDiff;

    // Then by priority
    return PRIORITIES[a.priority] - PRIORITIES[b.priority];
  });

  return results;
}

/**
 * Keyword search memories (fallback)
 */
function keywordSearchMemories(memories, query, priorityFilter = null, tagFilter = null, includeCompleted = false) {
  const queryLower = query ? query.toLowerCase() : '';

  return memories.filter(m => {
    if (isExpired(m)) return false;
    if (!includeCompleted && m.status === 'completed') return false;
    if (priorityFilter && m.priority !== priorityFilter) return false;
    if (tagFilter && !m.tags.some(t => t.toLowerCase() === tagFilter.toLowerCase())) return false;

    if (queryLower) {
      const contentMatch = m.content.toLowerCase().includes(queryLower);
      const tagMatch = m.tags.some(t => t.toLowerCase().includes(queryLower));
      if (!contentMatch && !tagMatch) return false;
    }

    return true;
  }).sort((a, b) => {
    const priorityDiff = PRIORITIES[a.priority] - PRIORITIES[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.created) - new Date(a.created);
  });
}

/**
 * Combined search - semantic + keyword fallback
 */
function searchMemories(query, options = {}) {
  const data = loadMemories();

  // Try semantic search first
  if (query && semanticIndex.documents.size > 0) {
    const semanticResults = semanticSearchMemories(query, options);

    // If we got good semantic results, use them
    if (semanticResults.length > 0 && semanticResults[0].relevanceScore > 0.1) {
      return semanticResults;
    }
  }

  // Fallback to keyword search
  return keywordSearchMemories(
    data.memories,
    query,
    options.priorityFilter,
    options.tagFilter,
    options.includeCompleted
  );
}

/**
 * Format memory for display
 */
function formatMemory(m, showScore = false) {
  let result = `[${m.id}] [${m.priority}] ${m.content}`;
  if (m.tags.length) result += ` (tags: ${m.tags.join(', ')})`;
  if (m.status === 'completed') result += ' [DONE]';
  if (showScore && m.relevanceScore) result += ` (relevance: ${(m.relevanceScore * 100).toFixed(0)}%)`;
  return result;
}

// MCP Server Implementation
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

// Tool definitions
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
  // Project tracking tools
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

// Tool implementations
function handleRemember(args) {
  const data = loadMemories();

  const memory = {
    id: generateId(),
    content: args.content,
    priority: args.priority || 'DAILY',
    tags: args.tags || [],
    created: new Date().toISOString(),
    lastChecked: null,
    status: 'active'
  };

  if (args.expires_days) {
    const expires = new Date();
    expires.setDate(expires.getDate() + args.expires_days);
    memory.expires = expires.toISOString();
  }

  data.memories.push(memory);
  saveMemories(data);

  // Add to semantic index
  indexMemory(memory);
  semanticIndex.save();

  log('INFO', 'Memory stored', memory);

  // Find similar existing memories
  const similar = semanticIndex.findSimilar(memory.id, 3);
  let similarText = '';
  if (similar.length > 0) {
    const memoryMap = new Map(data.memories.map(m => [m.id, m]));
    similarText = '\n\nRelated memories:\n' + similar.map(s => {
      const m = memoryMap.get(s.id);
      return m ? `- ${m.content.slice(0, 80)}...` : '';
    }).filter(x => x).join('\n');
  }

  return {
    content: [{
      type: 'text',
      text: `Memory stored with ID: ${memory.id}\n\nPriority: ${memory.priority}\nTags: ${memory.tags.join(', ') || 'none'}\nExpires: ${memory.expires || 'never'}${similarText}`
    }]
  };
}

function handleRecall(args) {
  const results = searchMemories(args.query || '', {
    priorityFilter: args.priority,
    tagFilter: args.tag,
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

  // Check if results have relevance scores (semantic search was used)
  const hasScores = results[0].relevanceScore !== undefined;

  const formatted = results.map(m => formatMemory(m, hasScores)).join('\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} memories${hasScores ? ' (semantic search)' : ''}:\n\n${formatted}`
    }]
  };
}

function handleCheckPending() {
  const memoryData = loadMemories();
  const projectData = loadProjects();

  // Get URGENT and DAILY items that are active
  const urgent = keywordSearchMemories(memoryData.memories, null, 'URGENT');
  const daily = keywordSearchMemories(memoryData.memories, null, 'DAILY');

  // Get active projects (not completed/abandoned)
  const activeProjects = projectData.projects.filter(p =>
    ['planning', 'in_progress', 'blocked'].includes(p.status)
  ).sort((a, b) => {
    // Blocked first, then by priority
    if (a.status === 'blocked' && b.status !== 'blocked') return -1;
    if (b.status === 'blocked' && a.status !== 'blocked') return 1;
    return PRIORITIES[a.priority] - PRIORITIES[b.priority];
  });

  // Update lastChecked
  const now = new Date().toISOString();
  [...urgent, ...daily].forEach(m => {
    const mem = memoryData.memories.find(x => x.id === m.id);
    if (mem) mem.lastChecked = now;
  });
  saveMemories(memoryData);

  let response = '';

  if (urgent.length > 0) {
    response += `**URGENT (${urgent.length}):**\n${urgent.map(m => formatMemory(m)).join('\n')}\n\n`;
  }

  if (daily.length > 0) {
    response += `**DAILY (${daily.length}):**\n${daily.map(m => formatMemory(m)).join('\n')}\n\n`;
  }

  if (activeProjects.length > 0) {
    const blocked = activeProjects.filter(p => p.status === 'blocked');
    const inProgress = activeProjects.filter(p => p.status !== 'blocked');

    if (blocked.length > 0) {
      response += `**BLOCKED PROJECTS (${blocked.length}):**\n${blocked.map(p => formatProject(p, false)).join('\n\n')}\n\n`;
    }
    if (inProgress.length > 0) {
      response += `**ACTIVE PROJECTS (${inProgress.length}):**\n${inProgress.map(p => formatProject(p, false)).join('\n\n')}`;
    }
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

function handleCompleteMemory(args) {
  const data = loadMemories();
  const memory = data.memories.find(m => m.id === args.id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  memory.status = 'completed';
  memory.completedAt = new Date().toISOString();
  saveMemories(data);

  // Remove from semantic index (completed items shouldn't show in search)
  semanticIndex.removeDocument(args.id);
  semanticIndex.save();

  log('INFO', 'Memory completed', { id: args.id });

  return {
    content: [{
      type: 'text',
      text: `Marked as completed: ${memory.content}`
    }]
  };
}

function handleForget(args) {
  const data = loadMemories();
  const index = data.memories.findIndex(m => m.id === args.id);

  if (index === -1) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  const removed = data.memories.splice(index, 1)[0];
  saveMemories(data);

  // Remove from semantic index
  semanticIndex.removeDocument(args.id);
  semanticIndex.save();

  log('INFO', 'Memory deleted', { id: args.id, content: removed.content });

  return {
    content: [{
      type: 'text',
      text: `Deleted memory: ${removed.content}`
    }]
  };
}

function handleListMemories(args) {
  const data = loadMemories();
  let memories = data.memories;

  // Filter by priority
  if (args.priority) {
    memories = memories.filter(m => m.priority === args.priority);
  }

  // Filter by status
  const status = args.status || 'active';
  if (status !== 'all') {
    memories = memories.filter(m => m.status === status);
  }

  // Filter expired
  memories = memories.filter(m => !isExpired(m));

  // Sort by priority then date
  memories.sort((a, b) => {
    const priorityDiff = PRIORITIES[a.priority] - PRIORITIES[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.created) - new Date(a.created);
  });

  // Limit
  const limit = args.limit || 50;
  memories = memories.slice(0, limit);

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

  // Add index stats
  const stats = semanticIndex.getStats();
  response += `\n_Semantic index: ${stats.documentCount} documents, ${stats.uniqueTerms} terms_`;

  return {
    content: [{
      type: 'text',
      text: response.trim()
    }]
  };
}

function handleUpdateMemory(args) {
  const data = loadMemories();
  const memory = data.memories.find(m => m.id === args.id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  if (args.content) memory.content = args.content;
  if (args.priority) memory.priority = args.priority;
  if (args.tags) memory.tags = args.tags;
  if (args.add_tags) memory.tags = [...new Set([...memory.tags, ...args.add_tags])];

  memory.updatedAt = new Date().toISOString();
  saveMemories(data);

  // Update semantic index
  semanticIndex.removeDocument(args.id);
  indexMemory(memory);
  semanticIndex.save();

  log('INFO', 'Memory updated', { id: args.id });

  return {
    content: [{
      type: 'text',
      text: `Updated memory:\n${formatMemory(memory)}`
    }]
  };
}

function handleFindSimilar(args) {
  const data = loadMemories();
  const memory = data.memories.find(m => m.id === args.id);

  if (!memory) {
    return {
      content: [{
        type: 'text',
        text: `Memory not found: ${args.id}`
      }]
    };
  }

  const limit = args.limit || 5;
  const similar = semanticIndex.findSimilar(args.id, limit);

  if (similar.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No similar memories found for: ${memory.content.slice(0, 50)}...`
      }]
    };
  }

  const memoryMap = new Map(data.memories.map(m => [m.id, m]));
  const results = similar.map(s => {
    const m = memoryMap.get(s.id);
    if (!m) return null;
    return `[${(s.score * 100).toFixed(0)}% similar] ${formatMemory(m)}`;
  }).filter(x => x);

  return {
    content: [{
      type: 'text',
      text: `Memories similar to "${memory.content.slice(0, 50)}...":\n\n${results.join('\n')}`
    }]
  };
}

function handleRebuildIndex() {
  rebuildIndex();
  const stats = semanticIndex.getStats();

  return {
    content: [{
      type: 'text',
      text: `Semantic index rebuilt.\n\nStats:\n- Documents: ${stats.documentCount}\n- Unique terms: ${stats.uniqueTerms}\n- Avg doc length: ${stats.avgDocLength.toFixed(1)} terms`
    }]
  };
}

// ===== PROJECT HANDLERS =====

function handleCreateProject(args) {
  const data = loadProjects();

  const project = {
    id: generateId(),
    name: args.name,
    description: args.description || '',
    status: 'planning',
    priority: args.priority || 'DAILY',
    tags: args.tags || [],
    steps: args.steps.map((task, idx) => ({
      id: idx + 1,
      task,
      status: 'pending',
      createdAt: new Date().toISOString(),
      notes: null
    })),
    blockers: [],
    created: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.projects.push(project);
  saveProjects(data);

  // Index in semantic search
  indexProject(project);
  semanticIndex.save();

  log('INFO', 'Project created', { id: project.id, name: project.name });

  return {
    content: [{
      type: 'text',
      text: `Project created: ${project.id}\n\n${formatProject(project, true)}`
    }]
  };
}

function handleGetProject(args) {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === args.id);

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

function handleListProjects(args) {
  const data = loadProjects();
  let projects = data.projects;

  // Filter by status
  const statusFilter = args.status || 'active';
  if (statusFilter === 'active') {
    projects = projects.filter(p => ['planning', 'in_progress', 'blocked'].includes(p.status));
  } else if (statusFilter !== 'all') {
    projects = projects.filter(p => p.status === statusFilter);
  }

  // Sort by priority then date
  projects.sort((a, b) => {
    const priorityDiff = PRIORITIES[a.priority] - PRIORITIES[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  if (projects.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No projects found with status: ${statusFilter}`
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

function handleUpdateProject(args) {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === args.id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.id}`
      }]
    };
  }

  if (args.name) project.name = args.name;
  if (args.description) project.description = args.description;
  if (args.status) project.status = args.status;
  if (args.priority) project.priority = args.priority;
  if (args.tags) project.tags = args.tags;

  project.updatedAt = new Date().toISOString();
  saveProjects(data);

  // Re-index
  semanticIndex.removeDocument(`project_${project.id}`);
  indexProject(project);
  semanticIndex.save();

  log('INFO', 'Project updated', { id: args.id });

  return {
    content: [{
      type: 'text',
      text: `Project updated:\n\n${formatProject(project, true)}`
    }]
  };
}

function handleUpdateStep(args) {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === args.project_id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const step = project.steps.find(s => s.id === args.step_id);
  if (!step) {
    return {
      content: [{
        type: 'text',
        text: `Step not found: ${args.step_id} in project ${args.project_id}`
      }]
    };
  }

  const oldStatus = step.status;

  if (args.status) {
    step.status = args.status;
    if (args.status === 'in_progress' && !step.startedAt) {
      step.startedAt = new Date().toISOString();
    }
    if (args.status === 'completed' && !step.completedAt) {
      step.completedAt = new Date().toISOString();
    }
  }
  if (args.notes) {
    step.notes = args.notes;
  }

  // Auto-update project status based on steps
  const allCompleted = project.steps.every(s => s.status === 'completed' || s.status === 'skipped');
  const anyInProgress = project.steps.some(s => s.status === 'in_progress');
  const hasActiveBlockers = project.blockers.some(b => !b.resolved);

  if (allCompleted) {
    project.status = 'completed';
  } else if (hasActiveBlockers) {
    project.status = 'blocked';
  } else if (anyInProgress) {
    project.status = 'in_progress';
  }

  project.updatedAt = new Date().toISOString();
  saveProjects(data);

  log('INFO', 'Step updated', { projectId: args.project_id, stepId: args.step_id, oldStatus, newStatus: step.status });

  const progress = calculateProgress(project);
  return {
    content: [{
      type: 'text',
      text: `Step ${step.id} updated: ${oldStatus} → ${step.status}\n\nProject progress: ${progress}%\n\n${formatProject(project, false)}`
    }]
  };
}

function handleAddStep(args) {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === args.project_id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const newStep = {
    id: project.steps.length + 1,
    task: args.task,
    status: 'pending',
    createdAt: new Date().toISOString(),
    notes: null
  };

  // Insert at position
  if (args.after_step !== undefined) {
    project.steps.splice(args.after_step, 0, newStep);
    // Renumber all steps
    project.steps.forEach((s, idx) => s.id = idx + 1);
  } else {
    project.steps.push(newStep);
  }

  project.updatedAt = new Date().toISOString();
  saveProjects(data);

  // Re-index
  semanticIndex.removeDocument(`project_${project.id}`);
  indexProject(project);
  semanticIndex.save();

  log('INFO', 'Step added', { projectId: args.project_id, task: args.task });

  return {
    content: [{
      type: 'text',
      text: `Step added to project ${project.name}:\n\n${formatProject(project, true)}`
    }]
  };
}

function handleAddBlocker(args) {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === args.project_id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const blocker = {
    id: generateId(),
    description: args.description,
    stepId: args.step_id || null,
    createdAt: new Date().toISOString(),
    resolved: false,
    resolvedAt: null,
    resolution: null
  };

  project.blockers.push(blocker);
  project.status = 'blocked';
  project.updatedAt = new Date().toISOString();
  saveProjects(data);

  log('INFO', 'Blocker added', { projectId: args.project_id, blockerId: blocker.id });

  return {
    content: [{
      type: 'text',
      text: `Blocker added to project ${project.name}:\n\n⚠ ${blocker.description}\n\nBlocker ID: ${blocker.id}`
    }]
  };
}

function handleResolveBlocker(args) {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === args.project_id);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project not found: ${args.project_id}`
      }]
    };
  }

  const blocker = project.blockers.find(b => b.id === args.blocker_id);
  if (!blocker) {
    return {
      content: [{
        type: 'text',
        text: `Blocker not found: ${args.blocker_id}`
      }]
    };
  }

  blocker.resolved = true;
  blocker.resolvedAt = new Date().toISOString();
  blocker.resolution = args.resolution || 'Resolved';

  // Check if any blockers remain
  const hasActiveBlockers = project.blockers.some(b => !b.resolved);
  if (!hasActiveBlockers && project.status === 'blocked') {
    project.status = 'in_progress';
  }

  project.updatedAt = new Date().toISOString();
  saveProjects(data);

  log('INFO', 'Blocker resolved', { projectId: args.project_id, blockerId: args.blocker_id });

  return {
    content: [{
      type: 'text',
      text: `Blocker resolved: ${blocker.description}\n\nResolution: ${blocker.resolution}\n\nProject status: ${project.status}`
    }]
  };
}

// Initialize: Load existing memories and projects into index
function initialize() {
  const memoryData = loadMemories();
  const projectData = loadProjects();

  // If index is empty but we have data, rebuild it
  if (semanticIndex.documents.size === 0 && (memoryData.memories.length > 0 || projectData.projects.length > 0)) {
    log('INFO', 'Rebuilding semantic index from existing memories and projects');
    rebuildIndex();

    // Index projects too
    for (const project of projectData.projects) {
      if (project.status !== 'completed' && project.status !== 'abandoned') {
        indexProject(project);
      }
    }
    semanticIndex.save();
  }
}

log('INFO', 'Memory MCP Server v3 (Semantic + Projects) starting');

// Initialize on startup
initialize();

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    log('DEBUG', `Received: ${method}`, { id });

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-server', version: '3.0.0' }
      });
    }
    else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      log('INFO', `Tool call: ${name}`, args);

      let result;
      switch (name) {
        case 'remember':
          result = handleRemember(args || {});
          break;
        case 'recall':
          result = handleRecall(args || {});
          break;
        case 'check_pending':
          result = handleCheckPending();
          break;
        case 'complete_memory':
          result = handleCompleteMemory(args || {});
          break;
        case 'forget':
          result = handleForget(args || {});
          break;
        case 'list_memories':
          result = handleListMemories(args || {});
          break;
        case 'update_memory':
          result = handleUpdateMemory(args || {});
          break;
        case 'find_similar':
          result = handleFindSimilar(args || {});
          break;
        case 'rebuild_index':
          result = handleRebuildIndex();
          break;
        // Project tools
        case 'create_project':
          result = handleCreateProject(args || {});
          break;
        case 'get_project':
          result = handleGetProject(args || {});
          break;
        case 'list_projects':
          result = handleListProjects(args || {});
          break;
        case 'update_project':
          result = handleUpdateProject(args || {});
          break;
        case 'update_step':
          result = handleUpdateStep(args || {});
          break;
        case 'add_step':
          result = handleAddStep(args || {});
          break;
        case 'add_blocker':
          result = handleAddBlocker(args || {});
          break;
        case 'resolve_blocker':
          result = handleResolveBlocker(args || {});
          break;
        default:
          respondError(id, -32601, `Unknown tool: ${name}`);
          return;
      }

      respond(id, result);
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
  // Save index on shutdown
  semanticIndex.save();
  log('INFO', 'Memory MCP Server v3 shutting down');
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', { error: e.message, stack: e.stack });
});

log('INFO', 'Memory MCP Server v3 ready');
process.stderr.write('Memory MCP server v3 (semantic search + project tracking) started\n');
