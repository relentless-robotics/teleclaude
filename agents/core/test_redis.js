/**
 * Test script for Redis Multi-Agent System
 *
 * Tests basic connectivity and functionality
 */

const {
  redis,
  taskQueue,
  pubsub,
  agentState,
  RedisAgent,
  RedisOrchestrator,
  initialize,
  shutdown,
  getSystemStatus
} = require('./index');

async function testRedisConnection() {
  console.log('\n=== Testing Redis Connection ===');
  try {
    await redis.connect();
    const pong = await redis.ping();
    console.log('✓ Redis ping:', pong);
    return true;
  } catch (error) {
    console.error('✗ Redis connection failed:', error.message);
    return false;
  }
}

async function testTaskQueue() {
  console.log('\n=== Testing Task Queue ===');
  try {
    // Push a test task
    const taskId = await taskQueue.pushTask('test-agent', {
      type: 'test',
      data: 'Hello from task queue'
    });
    console.log('✓ Task pushed:', taskId);

    // Get queue depth
    const depth = await taskQueue.getQueueDepth('test-agent');
    console.log('✓ Queue depth:', depth);

    // Get task status
    const status = await taskQueue.getTaskStatus(taskId);
    console.log('✓ Task status:', status.status);

    // Pop the task (non-blocking)
    const task = await taskQueue.popTask('test-agent', 1);
    if (task) {
      console.log('✓ Task popped:', task.id);
      await taskQueue.completeTask(task.id, { message: 'Task completed!' });
      console.log('✓ Task completed');
    }

    return true;
  } catch (error) {
    console.error('✗ Task queue test failed:', error.message);
    return false;
  }
}

async function testPubSub() {
  console.log('\n=== Testing Pub/Sub ===');
  try {
    await pubsub.connect();

    // Subscribe to test channel
    let receivedMessage = null;
    await pubsub.subscribe('test-channel', (message) => {
      receivedMessage = message;
      console.log('✓ Message received:', message);
    });

    // Publish a message
    await pubsub.publish('test-channel', { text: 'Hello from pub/sub!' });

    // Wait for message
    await new Promise(resolve => setTimeout(resolve, 100));

    if (receivedMessage) {
      console.log('✓ Pub/Sub working');
      return true;
    } else {
      console.error('✗ No message received');
      return false;
    }
  } catch (error) {
    console.error('✗ Pub/Sub test failed:', error.message);
    return false;
  }
}

async function testAgentState() {
  console.log('\n=== Testing Agent State ===');
  try {
    // Register a test agent
    await agentState.registerAgent('test-agent', {
      capabilities: { type: 'test' }
    });
    console.log('✓ Agent registered');

    // Update heartbeat
    await agentState.updateHeartbeat('test-agent');
    console.log('✓ Heartbeat updated');

    // Get agent state
    const state = await agentState.getAgentState('test-agent');
    console.log('✓ Agent state:', state.name, state.status, 'isAlive:', state.isAlive);

    // Get system stats
    const stats = await agentState.getSystemStats();
    console.log('✓ System stats:', stats.totalAgents, 'agents,', stats.totalTasks, 'tasks');

    // Cleanup
    await agentState.unregisterAgent('test-agent');
    console.log('✓ Agent unregistered');

    return true;
  } catch (error) {
    console.error('✗ Agent state test failed:', error.message);
    return false;
  }
}

async function testSystemInitialization() {
  console.log('\n=== Testing System Initialization ===');
  try {
    const { redis: r, pubsub: p, orchestrator } = await initialize({
      startOrchestrator: true,
      orchestrator: {
        autoBalance: true,
        healthCheckInterval: 30000
      }
    });

    console.log('✓ System initialized');

    // Get system status
    const status = await getSystemStatus();
    console.log('✓ System status:', JSON.stringify(status, null, 2));

    // Stop orchestrator
    if (orchestrator) {
      await orchestrator.stop();
      console.log('✓ Orchestrator stopped');
    }

    return true;
  } catch (error) {
    console.error('✗ System initialization failed:', error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  Redis Multi-Agent System Test Suite  ║');
  console.log('╚════════════════════════════════════════╝');

  const results = {
    redis: await testRedisConnection(),
    taskQueue: await testTaskQueue(),
    pubsub: await testPubSub(),
    agentState: await testAgentState(),
    system: await testSystemInitialization()
  };

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║           Test Results                 ║');
  console.log('╚════════════════════════════════════════╝');

  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;

  Object.entries(results).forEach(([test, result]) => {
    const icon = result ? '✓' : '✗';
    const status = result ? 'PASS' : 'FAIL';
    console.log(`${icon} ${test.padEnd(20)} ${status}`);
  });

  console.log(`\nTotal: ${passed}/${total} tests passed`);

  // Cleanup
  await shutdown();

  process.exit(passed === total ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
