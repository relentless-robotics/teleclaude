/**
 * TeleClaude Multi-Agent System - Core Modules
 *
 * Redis-based infrastructure for multi-agent coordination
 */

const redis = require('./redis_client');
const taskQueue = require('./task_queue');
const pubsub = require('./pubsub');
const agentState = require('./agent_state');
const RedisAgent = require('./redis_agent');
const RedisOrchestrator = require('./redis_orchestrator');
const modelRouter = require('./model_router');

module.exports = {
  // Core Redis client
  redis,

  // Task queue system
  taskQueue,

  // Pub/sub messaging
  pubsub,

  // Agent state management
  agentState,

  // Base agent class
  RedisAgent,

  // Orchestrator
  RedisOrchestrator,

  // Model router (task → runtime mapping)
  modelRouter,

  // Convenience: Create a new orchestrator
  createOrchestrator: (options) => new RedisOrchestrator(options),

  // Convenience: Create a new agent
  createAgent: (name, options) => new RedisAgent(name, options),

  // Initialize the system (connect Redis, setup orchestrator)
  async initialize(options = {}) {
    console.log('Initializing TeleClaude Multi-Agent System...');

    // Connect Redis
    await redis.connect();
    console.log('✓ Redis connected');

    // Connect pub/sub
    await pubsub.connect();
    console.log('✓ Pub/Sub connected');

    // Optionally start orchestrator
    if (options.startOrchestrator !== false) {
      const orchestrator = new RedisOrchestrator(options.orchestrator || {});
      await orchestrator.start();
      console.log('✓ Orchestrator started');
      return { redis, pubsub, orchestrator };
    }

    return { redis, pubsub };
  },

  // Shutdown the system gracefully
  async shutdown() {
    console.log('Shutting down TeleClaude Multi-Agent System...');

    // Disconnect pub/sub
    await pubsub.disconnect();
    console.log('✓ Pub/Sub disconnected');

    // Disconnect Redis
    await redis.disconnect();
    console.log('✓ Redis disconnected');

    console.log('Shutdown complete');
  },

  // Get system status
  async getSystemStatus() {
    const [redisStatus, pubsubStatus, systemStats] = await Promise.all([
      Promise.resolve(redis.getStatus()),
      Promise.resolve(pubsub.getStatus()),
      agentState.getSystemStats()
    ]);

    return {
      timestamp: Date.now(),
      redis: redisStatus,
      pubsub: pubsubStatus,
      agents: systemStats
    };
  }
};
