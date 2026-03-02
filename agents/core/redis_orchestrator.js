/**
 * Redis Orchestrator
 *
 * Central coordinator for multi-agent system
 * Delegates tasks, monitors health, and coordinates agents
 */

const taskQueue = require('./task_queue');
const pubsub = require('./pubsub');
const agentState = require('./agent_state');

class RedisOrchestrator {
  constructor(options = {}) {
    this.name = 'orchestrator';
    this.isRunning = false;

    this.config = {
      autoBalance: options.autoBalance !== false,
      healthCheckInterval: options.healthCheckInterval || 60000, // 1 minute
      ...options
    };

    this.alertCallbacks = [];
    this.resultCallbacks = [];
    this.healthCheckTimer = null;
  }

  /**
   * Start the orchestrator
   */
  async start() {
    if (this.isRunning) {
      console.log('Orchestrator is already running');
      return;
    }

    console.log('Starting orchestrator...');

    // Subscribe to alerts
    await pubsub.onAlert((alert) => {
      this._handleAlert(alert);
    });

    // Subscribe to task completion events
    await pubsub.onTaskEvent('completed', (data) => {
      this._handleResult(data);
    });

    await pubsub.onTaskEvent('failed', (data) => {
      this._handleResult(data);
    });

    // Start health monitoring
    if (this.config.healthCheckInterval > 0) {
      this._startHealthMonitoring();
    }

    this.isRunning = true;
    console.log('Orchestrator started');
  }

  /**
   * Handle incoming alert
   * @private
   */
  _handleAlert(alert) {
    console.log(`[ALERT ${alert.severity}] ${alert.agentName}: ${alert.message}`);

    // Call registered callbacks
    this.alertCallbacks.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        console.error('Error in alert callback:', error.message);
      }
    });

    // Handle critical alerts
    if (alert.severity === 'critical') {
      this._handleCriticalAlert(alert);
    }
  }

  /**
   * Handle critical alerts
   * @private
   */
  async _handleCriticalAlert(alert) {
    console.error(`CRITICAL ALERT from ${alert.agentName}: ${alert.message}`);

    // Check agent health
    const agent = await agentState.getAgentState(alert.agentName);
    if (agent && !agent.isAlive) {
      console.log(`Agent ${alert.agentName} appears to be dead, cleaning up...`);
      // Could implement automatic recovery here
    }
  }

  /**
   * Handle task result
   * @private
   */
  _handleResult(data) {
    console.log(`Task ${data.taskId} result from ${data.agentName}`);

    // Call registered callbacks
    this.resultCallbacks.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('Error in result callback:', error.message);
      }
    });
  }

  /**
   * Start health monitoring
   * @private
   */
  _startHealthMonitoring() {
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this._performHealthCheck();
      } catch (error) {
        console.error('Health check error:', error.message);
      }
    }, this.config.healthCheckInterval);

    console.log(`Health monitoring started (interval: ${this.config.healthCheckInterval}ms)`);
  }

  /**
   * Perform health check on all agents
   * @private
   */
  async _performHealthCheck() {
    const inactive = await agentState.listInactiveAgents();

    if (inactive.length > 0) {
      console.log(`Health check: ${inactive.length} inactive agents detected`);
      inactive.forEach(agent => {
        console.log(`  - ${agent.name} (last seen ${Math.floor(agent.timeSinceHeartbeat / 1000)}s ago)`);
      });

      // Cleanup dead agents
      await agentState.cleanupDeadAgents();
    }

    // Log system stats
    const stats = await agentState.getSystemStats();
    console.log(`System stats: ${stats.activeAgents}/${stats.totalAgents} agents active, ${stats.totalTasks} total tasks`);
  }

  /**
   * Delegate a task to a specific agent
   * @param {string} agentName - Target agent
   * @param {object} task - Task data
   * @returns {Promise<string>} Task ID
   */
  async delegateTask(agentName, task) {
    const taskId = await taskQueue.pushTask(agentName, task);
    console.log(`Orchestrator: Delegated task ${taskId} to ${agentName}`);
    return taskId;
  }

  /**
   * Delegate task to best available agent
   * @param {object} task - Task data
   * @param {object} requirements - Task requirements
   * @returns {Promise<string>} Task ID
   */
  async delegateToAny(task, requirements = {}) {
    const agent = await agentState.recommendAgent(requirements);

    if (!agent) {
      throw new Error('No suitable agent available');
    }

    console.log(`Orchestrator: Auto-delegating to ${agent.name}`);
    return this.delegateTask(agent.name, task);
  }

  /**
   * Broadcast message to all agents
   * @param {object|string} message - Message to broadcast
   */
  async broadcast(message) {
    await pubsub.broadcastToAll(message);
    console.log('Orchestrator: Broadcast sent');
  }

  /**
   * Send message to specific agent
   * @param {string} agentName - Target agent
   * @param {object|string} message - Message to send
   */
  async respondToAgent(agentName, message) {
    await pubsub.sendToAgent(agentName, message);
    console.log(`Orchestrator: Message sent to ${agentName}`);
  }

  /**
   * Register alert callback
   * @param {function} callback - Callback(alert)
   */
  onAlert(callback) {
    this.alertCallbacks.push(callback);
  }

  /**
   * Register result callback
   * @param {function} callback - Callback(data)
   */
  onResult(callback) {
    this.resultCallbacks.push(callback);
  }

  /**
   * Get system status
   * @returns {Promise<object>}
   */
  async getSystemStatus() {
    const [systemStats, activeAgents, allAgents] = await Promise.all([
      agentState.getSystemStats(),
      agentState.listActiveAgents(),
      agentState.getAllAgentStates()
    ]);

    // Get queue stats for each agent
    const queueStats = {};
    for (const agent of allAgents) {
      queueStats[agent.name] = await taskQueue.getQueueStats(agent.name);
    }

    return {
      timestamp: Date.now(),
      system: systemStats,
      activeAgents: activeAgents.map(a => ({
        name: a.name,
        status: a.status,
        taskCount: a.taskCount,
        successRate: a.taskCount > 0
          ? ((a.successCount / a.taskCount) * 100).toFixed(2) + '%'
          : 'N/A',
        timeSinceHeartbeat: Math.floor(a.timeSinceHeartbeat / 1000) + 's'
      })),
      queues: queueStats
    };
  }

  /**
   * Get detailed agent status
   * @param {string} agentName - Agent name
   * @returns {Promise<object>}
   */
  async getAgentStatus(agentName) {
    const [state, stats, queueStats, pendingTasks, processingTasks] = await Promise.all([
      agentState.getAgentState(agentName),
      agentState.getAgentStats(agentName),
      taskQueue.getQueueStats(agentName),
      taskQueue.listPendingTasks(agentName),
      taskQueue.getProcessingTasks(agentName)
    ]);

    return {
      state,
      stats,
      queue: queueStats,
      pendingTasks,
      processingTasks
    };
  }

  /**
   * Get task status
   * @param {string} taskId - Task ID
   * @returns {Promise<object>}
   */
  async getTaskStatus(taskId) {
    return taskQueue.getTaskStatus(taskId);
  }

  /**
   * Cancel a pending task
   * @param {string} taskId - Task ID
   */
  async cancelTask(taskId) {
    return taskQueue.cancelTask(taskId);
  }

  /**
   * Get queue depth for agent
   * @param {string} agentName - Agent name
   * @returns {Promise<number>}
   */
  async getQueueDepth(agentName) {
    return taskQueue.getQueueDepth(agentName);
  }

  /**
   * List all agents
   * @returns {Promise<Array>}
   */
  async listAgents() {
    return agentState.getAllAgentStates();
  }

  /**
   * Find agents by capability
   * @param {string} capability - Capability to search for
   * @returns {Promise<Array>}
   */
  async findAgents(capability) {
    return agentState.findAgentsByCapability(capability);
  }

  /**
   * Clear all tasks for an agent
   * @param {string} agentName - Agent name
   */
  async clearAgentTasks(agentName) {
    await taskQueue.clearAgentTasks(agentName);
    console.log(`Orchestrator: Cleared tasks for ${agentName}`);
  }

  /**
   * Rebalance tasks across agents (if enabled)
   */
  async rebalanceTasks() {
    if (!this.config.autoBalance) {
      console.log('Auto-balancing is disabled');
      return;
    }

    const agents = await agentState.listActiveAgents();
    if (agents.length < 2) {
      console.log('Not enough agents for rebalancing');
      return;
    }

    console.log('Rebalancing tasks across agents...');

    // Get queue depths
    const queues = await Promise.all(
      agents.map(async (agent) => ({
        name: agent.name,
        depth: await taskQueue.getQueueDepth(agent.name)
      }))
    );

    // Sort by queue depth
    queues.sort((a, b) => b.depth - a.depth);

    const maxDepth = queues[0].depth;
    const minDepth = queues[queues.length - 1].depth;

    if (maxDepth - minDepth < 5) {
      console.log('Queues are already balanced');
      return;
    }

    // TODO: Implement task redistribution logic
    console.log('Task rebalancing not yet implemented');
  }

  /**
   * Stop the orchestrator
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping orchestrator...');

    // Stop health monitoring
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Unsubscribe from channels
    await pubsub.unsubscribe('alerts');
    await pubsub.unsubscribe('task:completed');
    await pubsub.unsubscribe('task:failed');

    this.isRunning = false;
    console.log('Orchestrator stopped');
  }

  /**
   * Emergency shutdown of all agents
   */
  async emergencyShutdown() {
    console.log('EMERGENCY SHUTDOWN initiated');

    await this.broadcast({
      type: 'shutdown',
      reason: 'Emergency shutdown requested',
      timestamp: Date.now()
    });

    // Wait for agents to process shutdown
    await new Promise(resolve => setTimeout(resolve, 5000));

    await this.stop();
  }

  /**
   * Get orchestrator status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      alertCallbacks: this.alertCallbacks.length,
      resultCallbacks: this.resultCallbacks.length
    };
  }
}

module.exports = RedisOrchestrator;
