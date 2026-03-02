/**
 * Agent State Management
 *
 * Registry and health tracking for all agents in the system
 */

const redis = require('./redis_client');

class AgentStateManager {
  constructor() {
    this.heartbeatInterval = parseInt(process.env.AGENT_HEARTBEAT_INTERVAL || '30000', 10);
    this.heartbeatTimeout = this.heartbeatInterval * 3; // Consider dead after 3 missed heartbeats
  }

  /**
   * Register a new agent
   * @param {string} name - Agent name
   * @param {object} capabilities - Agent capabilities/metadata
   */
  async registerAgent(name, capabilities = {}) {
    const agentKey = `agent:${name}`;
    const registryKey = 'agents:registry';

    const agentData = {
      name,
      status: 'idle',
      capabilities,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      taskCount: 0,
      successCount: 0,
      failureCount: 0
    };

    // Store agent data in hash
    await redis.set(agentKey, JSON.stringify(agentData));

    // Add to registry set
    await redis.sadd(registryKey, name);

    console.log(`Agent registered: ${name}`);
    return agentData;
  }

  /**
   * Unregister an agent
   * @param {string} name - Agent name
   */
  async unregisterAgent(name) {
    const agentKey = `agent:${name}`;
    const registryKey = 'agents:registry';

    await redis.del(agentKey);
    await redis.srem(registryKey, name);

    console.log(`Agent unregistered: ${name}`);
  }

  /**
   * Update agent heartbeat
   * @param {string} name - Agent name
   */
  async updateHeartbeat(name) {
    const agentKey = `agent:${name}`;
    const agentData = await this.getAgentState(name);

    if (!agentData) {
      throw new Error(`Agent ${name} not registered`);
    }

    agentData.lastHeartbeat = Date.now();
    await redis.set(agentKey, JSON.stringify(agentData));
  }

  /**
   * Get agent state
   * @param {string} name - Agent name
   * @returns {Promise<object|null>}
   */
  async getAgentState(name) {
    const agentKey = `agent:${name}`;
    const data = await redis.get(agentKey);

    if (!data) {
      return null;
    }

    const agent = JSON.parse(data);

    // Add computed fields
    const now = Date.now();
    const timeSinceHeartbeat = now - agent.lastHeartbeat;
    agent.isAlive = timeSinceHeartbeat < this.heartbeatTimeout;
    agent.timeSinceHeartbeat = timeSinceHeartbeat;

    return agent;
  }

  /**
   * Set agent status
   * @param {string} name - Agent name
   * @param {string} status - 'idle', 'running', 'busy', 'error'
   * @param {object} metadata - Additional status info (optional)
   */
  async setAgentStatus(name, status, metadata = {}) {
    const agentData = await this.getAgentState(name);

    if (!agentData) {
      throw new Error(`Agent ${name} not registered`);
    }

    agentData.status = status;
    agentData.statusMetadata = metadata;
    agentData.statusUpdatedAt = Date.now();

    const agentKey = `agent:${name}`;
    await redis.set(agentKey, JSON.stringify(agentData));

    console.log(`Agent ${name} status: ${status}`);
  }

  /**
   * Update agent capabilities
   * @param {string} name - Agent name
   * @param {object} capabilities - Updated capabilities
   */
  async updateCapabilities(name, capabilities) {
    const agentData = await this.getAgentState(name);

    if (!agentData) {
      throw new Error(`Agent ${name} not registered`);
    }

    agentData.capabilities = { ...agentData.capabilities, ...capabilities };

    const agentKey = `agent:${name}`;
    await redis.set(agentKey, JSON.stringify(agentData));

    console.log(`Agent ${name} capabilities updated`);
  }

  /**
   * Increment agent task counters
   * @param {string} name - Agent name
   * @param {string} result - 'success' or 'failure'
   */
  async incrementTaskCount(name, result = 'success') {
    const agentData = await this.getAgentState(name);

    if (!agentData) {
      throw new Error(`Agent ${name} not registered`);
    }

    agentData.taskCount++;
    if (result === 'success') {
      agentData.successCount++;
    } else {
      agentData.failureCount++;
    }

    const agentKey = `agent:${name}`;
    await redis.set(agentKey, JSON.stringify(agentData));
  }

  /**
   * List all registered agents
   * @returns {Promise<Array<string>>}
   */
  async listAgents() {
    const registryKey = 'agents:registry';
    return redis.smembers(registryKey);
  }

  /**
   * List active agents (recent heartbeat)
   * @returns {Promise<Array<object>>}
   */
  async listActiveAgents() {
    const agentNames = await this.listAgents();
    const agents = [];

    for (const name of agentNames) {
      const agent = await this.getAgentState(name);
      if (agent && agent.isAlive) {
        agents.push(agent);
      }
    }

    return agents;
  }

  /**
   * List inactive/dead agents
   * @returns {Promise<Array<object>>}
   */
  async listInactiveAgents() {
    const agentNames = await this.listAgents();
    const agents = [];

    for (const name of agentNames) {
      const agent = await this.getAgentState(name);
      if (agent && !agent.isAlive) {
        agents.push(agent);
      }
    }

    return agents;
  }

  /**
   * Get all agents with their states
   * @returns {Promise<Array<object>>}
   */
  async getAllAgentStates() {
    const agentNames = await this.listAgents();
    const agents = [];

    for (const name of agentNames) {
      const agent = await this.getAgentState(name);
      if (agent) {
        agents.push(agent);
      }
    }

    return agents;
  }

  /**
   * Find agents by capability
   * @param {string} capability - Capability to search for
   * @returns {Promise<Array<object>>}
   */
  async findAgentsByCapability(capability) {
    const agents = await this.getAllAgentStates();
    return agents.filter(agent =>
      agent.capabilities &&
      (agent.capabilities[capability] || agent.capabilities.includes?.(capability))
    );
  }

  /**
   * Get agent statistics
   * @param {string} name - Agent name
   * @returns {Promise<object>}
   */
  async getAgentStats(name) {
    const agent = await this.getAgentState(name);

    if (!agent) {
      return null;
    }

    const uptime = Date.now() - agent.registeredAt;
    const successRate = agent.taskCount > 0
      ? (agent.successCount / agent.taskCount * 100).toFixed(2)
      : 0;

    return {
      name: agent.name,
      status: agent.status,
      isAlive: agent.isAlive,
      uptime,
      uptimeHours: (uptime / 1000 / 60 / 60).toFixed(2),
      taskCount: agent.taskCount,
      successCount: agent.successCount,
      failureCount: agent.failureCount,
      successRate: `${successRate}%`
    };
  }

  /**
   * Get system-wide statistics
   * @returns {Promise<object>}
   */
  async getSystemStats() {
    const agents = await this.getAllAgentStates();
    const active = agents.filter(a => a.isAlive);
    const inactive = agents.filter(a => !a.isAlive);

    const totalTasks = agents.reduce((sum, a) => sum + a.taskCount, 0);
    const totalSuccess = agents.reduce((sum, a) => sum + a.successCount, 0);
    const totalFailures = agents.reduce((sum, a) => sum + a.failureCount, 0);

    const systemSuccessRate = totalTasks > 0
      ? (totalSuccess / totalTasks * 100).toFixed(2)
      : 0;

    return {
      totalAgents: agents.length,
      activeAgents: active.length,
      inactiveAgents: inactive.length,
      totalTasks,
      totalSuccess,
      totalFailures,
      systemSuccessRate: `${systemSuccessRate}%`,
      agentsByStatus: {
        idle: agents.filter(a => a.status === 'idle').length,
        running: agents.filter(a => a.status === 'running').length,
        busy: agents.filter(a => a.status === 'busy').length,
        error: agents.filter(a => a.status === 'error').length
      }
    };
  }

  /**
   * Cleanup dead agents from registry
   * @returns {Promise<Array<string>>} Names of removed agents
   */
  async cleanupDeadAgents() {
    const inactive = await this.listInactiveAgents();
    const removed = [];

    for (const agent of inactive) {
      const timeSinceDeath = Date.now() - agent.lastHeartbeat;
      // Remove if dead for more than 5 minutes
      if (timeSinceDeath > 300000) {
        await this.unregisterAgent(agent.name);
        removed.push(agent.name);
      }
    }

    if (removed.length > 0) {
      console.log(`Cleaned up dead agents: ${removed.join(', ')}`);
    }

    return removed;
  }

  /**
   * Get recommended agent for a task
   * @param {object} taskRequirements - Required capabilities
   * @returns {Promise<object|null>} Best agent or null
   */
  async recommendAgent(taskRequirements = {}) {
    const activeAgents = await this.listActiveAgents();

    if (activeAgents.length === 0) {
      return null;
    }

    // Filter by capabilities if specified
    let candidates = activeAgents;
    if (taskRequirements.capabilities) {
      candidates = candidates.filter(agent => {
        const caps = agent.capabilities || {};
        return Object.entries(taskRequirements.capabilities).every(
          ([key, value]) => caps[key] === value
        );
      });
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by success rate and current load
    candidates.sort((a, b) => {
      const aSuccessRate = a.taskCount > 0 ? a.successCount / a.taskCount : 0;
      const bSuccessRate = b.taskCount > 0 ? b.successCount / b.taskCount : 0;

      const aIsBusy = a.status === 'busy' ? 1 : 0;
      const bIsBusy = b.status === 'busy' ? 1 : 0;

      // Prefer non-busy agents with higher success rate
      if (aIsBusy !== bIsBusy) return aIsBusy - bIsBusy;
      return bSuccessRate - aSuccessRate;
    });

    return candidates[0];
  }
}

module.exports = new AgentStateManager();
