#!/usr/bin/env node
/**
 * MCP Memory Server v2 - With Semantic Search
 * Persistent memory system for Claude with TF-IDF based semantic recall
 *
 * NEW in v2:
 *   - Semantic search using TF-IDF + cosine similarity
 *   - Synonym expansion for better matching
 *   - Automatic indexing of all memories
 *   - Similar memory suggestions
 *   - Memory summarization
 *
 * Tools:
 *   - remember: Store a memory with priority, tags, and optional expiration
 *   - recall: Search memories semantically by query and/or tags
 *   - check_pending: Get all items needing attention (URGENT and DAILY)
 *   - complete_memory: Mark a memory as completed
 *   - forget: Remove a memory
 *   - list_memories: List all memories with optional filters
 *   - update_memory: Modify an existing memory
 *   - find_similar: Find memories similar to a given memory
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

// Semantic search index
let semanticIndex = new SemanticIndex(INDEX_FILE);

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
  const data = loadMemories();

  // Get URGENT and DAILY items that are active
  const urgent = keywordSearchMemories(data.memories, null, 'URGENT');
  const daily = keywordSearchMemories(data.memories, null, 'DAILY');

  // Update lastChecked
  const now = new Date().toISOString();
  [...urgent, ...daily].forEach(m => {
    const mem = data.memories.find(x => x.id === m.id);
    if (mem) mem.lastChecked = now;
  });
  saveMemories(data);

  let response = '';

  if (urgent.length > 0) {
    response += `**URGENT (${urgent.length}):**\n${urgent.map(m => formatMemory(m)).join('\n')}\n\n`;
  }

  if (daily.length > 0) {
    response += `**DAILY (${daily.length}):**\n${daily.map(m => formatMemory(m)).join('\n')}`;
  }

  if (!response) {
    response = 'No pending items! All caught up.';
  }

  return {
    content: [{
      type: 'text',
      text: response
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

// Initialize: Load existing memories into index
function initialize() {
  const data = loadMemories();

  // If index is empty but we have memories, rebuild it
  if (semanticIndex.documents.size === 0 && data.memories.length > 0) {
    log('INFO', 'Rebuilding semantic index from existing memories');
    rebuildIndex();
  }
}

log('INFO', 'Memory MCP Server v2 (Semantic) starting');

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
        serverInfo: { name: 'memory-server', version: '2.0.0' }
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
  log('INFO', 'Memory MCP Server v2 shutting down');
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', { error: e.message, stack: e.stack });
});

log('INFO', 'Memory MCP Server v2 ready');
process.stderr.write('Memory MCP server v2 (semantic search) started\n');
