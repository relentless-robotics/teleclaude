/**
 * Smart Model Router
 *
 * Analyzes tasks and routes to optimal model:
 * - cursor_auto (FREE) - no MCP needed
 * - sonnet_mcp ($3/M) - MCP tools required
 * - opus (escalate) - critical decisions only
 */

// Tools that REQUIRE MCP (can't be done via workarounds)
const MCP_REQUIRED_TOOLS = [
  'send_to_discord',
  'send_to_telegram',
  'send_file_to_discord',
  'WebSearch',  // Native web search
  // Note: Memory can be done via Redis, so NOT required
  // Note: Browser can be done via utils, so NOT required
];

// Keywords that suggest MCP tools needed
const MCP_KEYWORDS = [
  'discord', 'telegram', 'send message', 'notify user',
  'web search', 'search the web', 'google for',
  'real-time', 'immediately notify', 'alert user'
];

// Keywords that suggest complex reasoning (Opus territory)
const OPUS_KEYWORDS = [
  'architecture', 'design system', 'security audit',
  'critical decision', 'strategy', 'plan the approach',
  'evaluate tradeoffs', 'complex debugging'
];

// Task types that work fine with Cursor AUTO
const CURSOR_SAFE_TYPES = [
  'code_edit', 'file_read', 'file_write', 'refactor',
  'bug_fix', 'test_write', 'documentation',
  'api_call', 'data_processing', 'script_run',
  'trading_execute', 'browser_automation', 'git_operations'
];

/**
 * Analyze a task and determine best model
 * @param {Object} task - Task object with type, description, requirements
 * @returns {Object} - { model, reason, cost }
 */
function routeTask(task) {
  const description = (task.description || '').toLowerCase();
  const taskType = task.type || 'unknown';
  const requirements = task.requirements || [];

  // Check for explicit MCP tool requirements
  for (const tool of requirements) {
    if (MCP_REQUIRED_TOOLS.includes(tool)) {
      return {
        model: 'sonnet_mcp',
        reason: `Requires MCP tool: ${tool}`,
        cost: '$3/M tokens',
        runtime: 'claude_api'
      };
    }
  }

  // Check for MCP keywords in description
  for (const keyword of MCP_KEYWORDS) {
    if (description.includes(keyword)) {
      return {
        model: 'sonnet_mcp',
        reason: `Description suggests MCP needed: "${keyword}"`,
        cost: '$3/M tokens',
        runtime: 'claude_api'
      };
    }
  }

  // Check for Opus-level complexity
  for (const keyword of OPUS_KEYWORDS) {
    if (description.includes(keyword)) {
      return {
        model: 'opus_escalate',
        reason: `Complex task requiring orchestrator: "${keyword}"`,
        cost: '$15/M tokens',
        runtime: 'escalate_to_orchestrator'
      };
    }
  }

  // Check if task type is known to be Cursor-safe
  if (CURSOR_SAFE_TYPES.includes(taskType)) {
    return {
      model: 'cursor_auto',
      reason: `Task type "${taskType}" works with Cursor AUTO`,
      cost: 'FREE',
      runtime: 'cursor_cli'
    };
  }

  // Default: Use Cursor AUTO (free) unless proven otherwise
  return {
    model: 'cursor_auto',
    reason: 'Default to FREE tier - no MCP requirements detected',
    cost: 'FREE',
    runtime: 'cursor_cli'
  };
}

/**
 * Batch route multiple tasks
 */
function routeTasks(tasks) {
  return tasks.map(task => ({
    task,
    routing: routeTask(task)
  }));
}

/**
 * Get routing statistics
 */
function getRoutingStats(tasks) {
  const routed = routeTasks(tasks);
  const stats = {
    total: tasks.length,
    cursor_auto: 0,
    sonnet_mcp: 0,
    opus_escalate: 0,
    estimated_cost: 0
  };

  for (const { routing } of routed) {
    stats[routing.model]++;
    if (routing.model === 'sonnet_mcp') {
      stats.estimated_cost += 0.003; // Rough estimate per task
    } else if (routing.model === 'opus_escalate') {
      stats.estimated_cost += 0.015;
    }
  }

  return stats;
}

/**
 * Check if a specific tool requires MCP
 */
function requiresMCP(toolName) {
  return MCP_REQUIRED_TOOLS.includes(toolName);
}

/**
 * Add custom MCP-required tool
 */
function addMCPTool(toolName) {
  if (!MCP_REQUIRED_TOOLS.includes(toolName)) {
    MCP_REQUIRED_TOOLS.push(toolName);
  }
}

/**
 * Format routing decision for logging
 */
function formatRouting(task, routing) {
  return `[${routing.model}] ${task.type || 'task'}: ${routing.reason} (${routing.cost})`;
}

module.exports = {
  routeTask,
  routeTasks,
  getRoutingStats,
  requiresMCP,
  addMCPTool,
  formatRouting,
  MCP_REQUIRED_TOOLS,
  MCP_KEYWORDS,
  OPUS_KEYWORDS,
  CURSOR_SAFE_TYPES
};

// CLI test
if (require.main === module) {
  const testTasks = [
    { type: 'code_edit', description: 'Fix bug in user.js' },
    { type: 'notification', description: 'Send discord message about completion' },
    { type: 'research', description: 'Search the web for API documentation' },
    { type: 'trading', description: 'Execute buy order for SMCI' },
    { type: 'planning', description: 'Design system architecture for new feature' },
    { type: 'browser', description: 'Login to GitHub and create PR' },
  ];

  console.log('Model Router Test:\n');
  for (const task of testTasks) {
    const routing = routeTask(task);
    console.log(formatRouting(task, routing));
  }

  console.log('\nStats:', getRoutingStats(testTasks));
}
