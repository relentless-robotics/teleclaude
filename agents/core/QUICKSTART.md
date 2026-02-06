# Quick Start Guide - Redis Multi-Agent System

Get the multi-agent system running in 5 minutes!

## Prerequisites

- Node.js 18+ installed
- Docker installed (for Redis)
- TeleClaude project cloned

## Step 1: Start Redis (2 minutes)

### Option A: Using Docker (Recommended)

```bash
cd C:\Users\Footb\Documents\Github\teleclaude-main\docker
docker-compose -f docker-compose.agents.yml up -d redis
```

Verify Redis is running:
```bash
docker ps
# Should show: teleclaude-redis
```

### Option B: Local Redis (Windows)

Download and run Redis:
```bash
# Using Chocolatey
choco install redis-64

# Or download from: https://github.com/microsoftarchive/redis/releases

# Run
redis-server
```

## Step 2: Verify Installation (1 minute)

```bash
cd C:\Users\Footb\Documents\Github\teleclaude-main
node -e "const {redis} = require('./agents/core'); redis.ping().then(console.log)"
```

Expected output: `PONG`

## Step 3: Run Tests (1 minute)

```bash
node agents/core/test_redis.js
```

Expected output:
```
╔════════════════════════════════════════╗
║  Redis Multi-Agent System Test Suite  ║
╚════════════════════════════════════════╝

=== Testing Redis Connection ===
✓ Redis ping: PONG

=== Testing Task Queue ===
✓ Task pushed: task:...
✓ Queue depth: 1
✓ Task status: pending
✓ Task popped: task:...
✓ Task completed

=== Testing Pub/Sub ===
✓ Message received: { text: 'Hello from pub/sub!' }
✓ Pub/Sub working

=== Testing Agent State ===
✓ Agent registered
✓ Heartbeat updated
✓ Agent state: test-agent idle isAlive: true
✓ System stats: 1 agents, 0 tasks
✓ Agent unregistered

=== Testing System Initialization ===
✓ System initialized
✓ System status: {...}
✓ Orchestrator stopped

╔════════════════════════════════════════╗
║           Test Results                 ║
╚════════════════════════════════════════╝
✓ redis               PASS
✓ taskQueue           PASS
✓ pubsub              PASS
✓ agentState          PASS
✓ system              PASS

Total: 5/5 tests passed
```

## Step 4: Run Example Demo (1 minute)

```bash
node agents/core/example_agent.js
```

This demonstrates:
- Starting multiple agents (TradingAgent, DataAgent)
- Delegating tasks via orchestrator
- Real-time alerts and messaging
- Health monitoring

Expected output:
```
╔════════════════════════════════════════╗
║    Multi-Agent System Demo            ║
╚════════════════════════════════════════╝

Starting orchestrator...
✓ Orchestrator started
Starting agent: trading-agent
Agent registered: trading-agent
✓ Agents started

Delegating tasks...

Orchestrator: Delegated task task:... to trading-agent
Processing analyze task: {...}
Analyzing market: { symbol: 'AAPL' }
[ORCHESTRATOR] Alert from trading-agent: Analysis complete for AAPL
[ORCHESTRATOR] Task task:... completed by trading-agent

System Status:
{
  "timestamp": 1234567890,
  "system": {
    "totalAgents": 2,
    "activeAgents": 2,
    "totalTasks": 3
  },
  ...
}

✓ Demo complete
```

## Step 5: Create Your Own Agent

Create a new file `agents/my_agent.js`:

```javascript
const { RedisAgent, RedisOrchestrator, initialize } = require('./core');

class MyAgent extends RedisAgent {
  constructor() {
    super('my-agent', {
      capabilities: { type: 'custom' },
      autoStart: true
    });
  }

  async processTask(task) {
    console.log('Processing:', task);

    // Your work here
    await new Promise(resolve => setTimeout(resolve, 1000));

    return { success: true, data: 'Processed!' };
  }
}

async function main() {
  // Initialize system
  const { orchestrator } = await initialize();

  // Start your agent
  const agent = new MyAgent();
  await agent.start();

  // Delegate a task
  await orchestrator.delegateTask('my-agent', {
    type: 'test',
    data: { message: 'Hello!' }
  });

  // Wait for completion
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Cleanup
  await agent.stop();
  await orchestrator.stop();
}

main().catch(console.error);
```

Run it:
```bash
node agents/my_agent.js
```

## Common Commands

### Start Redis
```bash
docker-compose -f docker/docker-compose.agents.yml up -d redis
```

### Stop Redis
```bash
docker-compose -f docker/docker-compose.agents.yml down
```

### View Redis Logs
```bash
docker logs teleclaude-redis
```

### Redis Commander UI (for debugging)
```bash
docker-compose -f docker/docker-compose.agents.yml --profile debug up redis-commander
```
Access at: http://localhost:8081

### Clear All Redis Data
```bash
docker exec teleclaude-redis redis-cli FLUSHALL
```

## Environment Variables

Create `.env` file in project root:

```bash
# Redis connection
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Agent settings
AGENT_HEARTBEAT_INTERVAL=30000  # 30 seconds
TASK_TIMEOUT=300000             # 5 minutes
```

## Troubleshooting

### "Redis connection timeout"
**Problem:** Redis not running or wrong host/port

**Solution:**
```bash
# Check if Redis is running
docker ps | grep redis

# Or test connection
telnet localhost 6379
```

### "Agent not receiving tasks"
**Problem:** Agent name mismatch or not started

**Solution:**
```javascript
// Check registered agents
const { agentState } = require('./agents/core');
const agents = await agentState.listActiveAgents();
console.log(agents);
```

### "Task timeout"
**Problem:** Task takes longer than timeout

**Solution:**
```javascript
// Increase timeout in agent constructor
new MyAgent('name', { taskTimeout: 600000 }) // 10 minutes
```

## Next Steps

- Read full documentation: `agents/core/README.md`
- Explore example agents: `agents/core/example_agent.js`
- Review architecture in main `README.md`
- Deploy with Docker for production

## Useful Resources

- **ioredis docs:** https://github.com/redis/ioredis
- **Redis commands:** https://redis.io/commands
- **Redis patterns:** https://redis.io/docs/manual/patterns/

## Support

Issues? Check:
1. Redis is running (`docker ps`)
2. Node.js version 18+ (`node --version`)
3. ioredis installed (`npm ls ioredis`)
4. Firewall not blocking port 6379

Still stuck? Review test output for specific errors:
```bash
node agents/core/test_redis.js
```
