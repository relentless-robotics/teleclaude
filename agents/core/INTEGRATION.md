# Integration Guide - Redis Multi-Agent System with TeleClaude

How to integrate the Redis multi-agent system with the existing TeleClaude bridge.

## Architecture Overview

```
┌──────────────┐
│   Discord    │
│   User       │
└──────┬───────┘
       │
┌──────▼───────────────────────────┐
│  TeleClaude Bridge (Opus)        │  Main orchestrator
│  - Receives user commands        │
│  - Delegates to agents via Redis │
│  - Sends results to Discord      │
└──────┬───────────────────────────┘
       │
┌──────▼──────────┐
│  Redis Server   │  Message broker + task queue
└──────┬──────────┘
       │
┌──────┴─────────────────────────────────────┐
│                                            │
┌──────▼─────────┐                 ┌─────────▼────────┐
│ Background     │                 │ Specialized      │
│ Agents         │                 │ Agents           │
│ (Sonnet/Haiku) │                 │ (Trading, etc.)  │
└────────────────┘                 └──────────────────┘
```

## Integration Steps

### 1. Initialize Redis in Bridge Startup

In your main bridge file (e.g., `discord-bridge.js`):

```javascript
const { initialize, RedisOrchestrator } = require('./agents/core');

let orchestrator = null;

async function startBridge() {
  console.log('Starting TeleClaude Discord Bridge...');

  // Initialize Redis multi-agent system
  const { orchestrator: orch } = await initialize({
    startOrchestrator: true,
    orchestrator: {
      autoBalance: true,
      healthCheckInterval: 60000
    }
  });

  orchestrator = orch;

  // Register alert handler
  orchestrator.onAlert((alert) => {
    if (alert.severity === 'critical' || alert.severity === 'error') {
      sendToDiscord(`⚠️ Agent Alert: ${alert.agentName} - ${alert.message}`);
    }
  });

  // Register result handler
  orchestrator.onResult((data) => {
    console.log(`Task ${data.taskId} completed by ${data.agentName}`);
  });

  console.log('✓ Redis multi-agent system initialized');

  // Continue with existing bridge setup...
}
```

### 2. Delegate Tasks from Bridge

Replace direct Task tool calls with Redis task delegation:

**Old Approach:**
```javascript
// User: "Search for a file"
Task(prompt="Search for file...", subagent_type="general-purpose", model="haiku")
```

**New Approach:**
```javascript
// User: "Search for a file"
const taskId = await orchestrator.delegateTask('file-search-agent', {
  type: 'search',
  data: { pattern: '*.js', path: '/src' }
});

// Wait for result or set callback
orchestrator.onResult((data) => {
  if (data.taskId === taskId) {
    sendToDiscord(`Found ${data.result.files.length} files`);
  }
});
```

### 3. Create Specialized Agents

**File Search Agent** (`agents/file_search_agent.js`):

```javascript
const { RedisAgent } = require('./core');
const { Glob } = require('../tools'); // Your existing tools

class FileSearchAgent extends RedisAgent {
  constructor() {
    super('file-search-agent', {
      capabilities: {
        type: 'search',
        operations: ['glob', 'grep', 'find']
      },
      autoStart: true,
      taskTimeout: 30000
    });
  }

  async processTask(task) {
    switch (task.type) {
      case 'glob':
        return await this.globSearch(task.data);
      case 'grep':
        return await this.grepSearch(task.data);
      default:
        throw new Error(`Unknown search type: ${task.type}`);
    }
  }

  async globSearch(data) {
    // Use existing Glob tool
    const files = await Glob({ pattern: data.pattern, path: data.path });
    return { files };
  }

  async grepSearch(data) {
    // Use existing Grep tool
    const results = await Grep({
      pattern: data.pattern,
      path: data.path,
      output_mode: 'files_with_matches'
    });
    return { results };
  }
}

module.exports = FileSearchAgent;
```

**Browser Automation Agent** (`agents/browser_agent.js`):

```javascript
const { RedisAgent } = require('./core');
const browser = require('../utils/browser');

class BrowserAgent extends RedisAgent {
  constructor() {
    super('browser-agent', {
      capabilities: {
        type: 'automation',
        browser: true
      },
      autoStart: true,
      taskTimeout: 300000 // 5 minutes for browser tasks
    });
  }

  async processTask(task) {
    const session = await browser.launch({
      stealth: true,
      auth: task.data.auth || null
    });

    try {
      switch (task.type) {
        case 'navigate':
          await session.goto(task.data.url);
          return { success: true, url: task.data.url };

        case 'login':
          return await this.performLogin(session, task.data);

        case 'scrape':
          return await this.scrapeData(session, task.data);

        default:
          throw new Error(`Unknown browser task: ${task.type}`);
      }
    } finally {
      await session.close();
    }
  }

  async performLogin(session, data) {
    await session.goto(data.loginUrl);
    await session.autoFillLogin();
    await session.click(data.submitSelector);
    return { success: true };
  }

  async scrapeData(session, data) {
    await session.goto(data.url);
    const content = await session.page.content();
    return { content };
  }
}

module.exports = BrowserAgent;
```

### 4. Start Agents on Bridge Startup

```javascript
const FileSearchAgent = require('./agents/file_search_agent');
const BrowserAgent = require('./agents/browser_agent');

async function startBridge() {
  // ... Initialize orchestrator (from step 1) ...

  // Start specialized agents
  const fileSearchAgent = new FileSearchAgent();
  const browserAgent = new BrowserAgent();

  await Promise.all([
    fileSearchAgent.start(),
    browserAgent.start()
  ]);

  console.log('✓ Agents started');

  // Continue with bridge...
}
```

### 5. Handle User Commands with Task Delegation

```javascript
async function handleUserMessage(message) {
  // Parse command
  if (message.startsWith('search for')) {
    const pattern = extractPattern(message);

    await sendToDiscord('Searching files...');

    const taskId = await orchestrator.delegateTask('file-search-agent', {
      type: 'glob',
      data: { pattern, path: process.cwd() }
    });

    // Set up result handler
    const timeout = setTimeout(() => {
      sendToDiscord('Search timed out');
    }, 30000);

    orchestrator.onResult((data) => {
      if (data.taskId === taskId) {
        clearTimeout(timeout);
        const files = data.result.files;
        sendToDiscord(`Found ${files.length} files:\n${files.slice(0, 10).join('\n')}`);
      }
    });

  } else if (message.startsWith('login to')) {
    const site = extractSite(message);

    await sendToDiscord('Starting browser automation...');

    const taskId = await orchestrator.delegateTask('browser-agent', {
      type: 'login',
      data: {
        loginUrl: getSiteLoginUrl(site),
        submitSelector: 'button[type="submit"]',
        auth: 'google'
      }
    });

    orchestrator.onResult((data) => {
      if (data.taskId === taskId) {
        if (data.result.success) {
          sendToDiscord('✓ Login successful!');
        } else {
          sendToDiscord('✗ Login failed');
        }
      }
    });

  } else {
    // Fall back to existing Claude processing
    processWithClaude(message);
  }
}
```

### 6. Graceful Shutdown

```javascript
const { shutdown } = require('./agents/core');

async function stopBridge() {
  console.log('Stopping TeleClaude bridge...');

  // Stop orchestrator
  if (orchestrator) {
    await orchestrator.emergencyShutdown();
  }

  // Shutdown Redis system
  await shutdown();

  console.log('✓ Bridge stopped');
  process.exit(0);
}

process.on('SIGINT', stopBridge);
process.on('SIGTERM', stopBridge);
```

## Agent Distribution Strategies

### Strategy 1: All Agents in Bridge Process

Simple deployment - all agents run in the same Node.js process as the bridge.

**Pros:** Simple, no additional processes
**Cons:** High memory usage, single point of failure

```javascript
// In main bridge
const agents = [
  new FileSearchAgent(),
  new BrowserAgent(),
  new DataAgent()
];

for (const agent of agents) {
  await agent.start();
}
```

### Strategy 2: Separate Agent Processes

Each agent runs as a separate Node.js process.

**Pros:** Isolation, can restart individually
**Cons:** More complex deployment

**Start script** (`agents/start_file_search.js`):
```javascript
const FileSearchAgent = require('./file_search_agent');
const { initialize } = require('./core');

async function main() {
  await initialize({ startOrchestrator: false });
  const agent = new FileSearchAgent();
  await agent.start();

  console.log('File search agent running...');
}

main().catch(console.error);
```

Run separately:
```bash
node agents/start_file_search.js &
node agents/start_browser.js &
```

### Strategy 3: Containerized Agents

Each agent in its own Docker container.

**Dockerfile** (`agents/file_search/Dockerfile`):
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "start_file_search.js"]
```

**docker-compose.yml** addition:
```yaml
services:
  file-search-agent:
    build: ./agents/file_search
    environment:
      - REDIS_HOST=redis
      - AGENT_NAME=file-search-agent
    depends_on:
      - redis
    restart: unless-stopped
    networks:
      - agent-network
```

## Monitoring Integration

### Add Status Command

```javascript
async function handleStatusCommand() {
  const status = await orchestrator.getSystemStatus();

  const message = `
📊 System Status

**Agents:** ${status.system.activeAgents}/${status.system.totalAgents} active
**Tasks:** ${status.system.totalTasks} total
**Success Rate:** ${status.system.systemSuccessRate}

**Active Agents:**
${status.activeAgents.map(a => `- ${a.name}: ${a.status} (${a.taskCount} tasks)`).join('\n')}

**Queues:**
${Object.entries(status.queues).map(([name, q]) =>
  `- ${name}: ${q.pending} pending, ${q.processing} processing`
).join('\n')}
  `;

  await sendToDiscord(message);
}
```

### Alert Forwarding

```javascript
orchestrator.onAlert((alert) => {
  const emoji = {
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    critical: '🚨'
  }[alert.severity] || '📢';

  sendToDiscord(`${emoji} **${alert.agentName}:** ${alert.message}`);
});
```

## Benefits of This Integration

1. **Scalability:** Agents can run on separate machines
2. **Reliability:** Agent crashes don't affect the bridge
3. **Performance:** Long tasks don't block the main bridge
4. **Model Optimization:** Use cheaper models (Haiku, Sonnet) for agents
5. **Specialization:** Agents can have domain-specific logic
6. **Monitoring:** Centralized view of all agent activity

## Migration Path

1. **Phase 1:** Initialize Redis system in bridge
2. **Phase 2:** Create first agent (file search)
3. **Phase 3:** Delegate file operations to agent
4. **Phase 4:** Add browser automation agent
5. **Phase 5:** Add trading/API agents
6. **Phase 6:** Containerize agents for production

## Example: Complete Bridge Integration

See `examples/integrated_bridge.js` for a full working example combining:
- Discord bridge
- Redis orchestrator
- Multiple agents (file search, browser, data)
- Status monitoring
- Graceful shutdown

Run it:
```bash
node examples/integrated_bridge.js
```

## Troubleshooting

**Agents not receiving tasks:**
- Check agent is registered: `await agentState.listActiveAgents()`
- Verify Redis connection: `await redis.ping()`
- Check task was pushed: `await taskQueue.getQueueDepth('agent-name')`

**Bridge can't connect to Redis:**
- Ensure Redis is running: `docker ps | grep redis`
- Check REDIS_HOST env variable matches

**Tasks timing out:**
- Increase agent timeout in constructor
- Check agent is actually processing (logs)

## Next Steps

1. Start with Strategy 1 (all agents in bridge)
2. Monitor performance and memory usage
3. Move heavy agents to separate processes (Strategy 2)
4. Containerize for production (Strategy 3)
5. Add monitoring dashboard
6. Implement task persistence for critical operations

---

**Full integration example coming soon in:** `examples/integrated_bridge.js`
