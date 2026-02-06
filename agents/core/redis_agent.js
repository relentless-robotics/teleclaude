/**
 * Base Redis Agent Class
 *
 * Foundation for all agents in the multi-agent system
 * Handles task processing, communication, and lifecycle management
 */

const taskQueue = require('./task_queue');
const pubsub = require('./pubsub');
const agentState = require('./agent_state');

class RedisAgent {
  constructor(name, options = {}) {
    this.name = name;
    this.capabilities = options.capabilities || {};
    this.heartbeatInterval = parseInt(process.env.AGENT_HEARTBEAT_INTERVAL || '30000', 10);
    this.heartbeatTimer = null;
    this.isRunning = false;
    this.currentTask = null;

    // Configuration
    this.config = {
      autoStart: options.autoStart !== false,
      maxConcurrentTasks: options.maxConcurrentTasks || 1,
      taskTimeout: options.taskTimeout || 300000, // 5 minutes
      ...options
    };
  }

  /**
   * Start the agent
   */
  async start() {
    if (this.isRunning) {
      console.log(`Agent ${this.name} is already running`);
      return;
    }

    console.log(`Starting agent: ${this.name}`);

    // Register with state manager
    await agentState.registerAgent(this.name, this.capabilities);

    // Subscribe to channels
    await this._setupSubscriptions();

    // Start heartbeat
    this._startHeartbeat();

    // Set status to idle
    await agentState.setAgentStatus(this.name, 'idle');

    this.isRunning = true;

    // Send startup alert
    await pubsub.sendAlert(this.name, 'info', 'Agent started', {
      capabilities: this.capabilities
    });

    // Start processing loop if autoStart enabled
    if (this.config.autoStart) {
      this._startProcessingLoop();
    }

    console.log(`Agent ${this.name} is ready`);
  }

  /**
   * Setup pub/sub subscriptions
   * @private
   */
  async _setupSubscriptions() {
    // Listen for agent-specific messages
    await pubsub.onAgentMessage(this.name, (message) => {
      this.onMessage(message);
    });

    // Listen for broadcasts
    await pubsub.onBroadcast((message) => {
      this.onBroadcast(message);
    });

    // Listen for task completion events (for coordination)
    await pubsub.onTaskEvent('completed', (data) => {
      this.onTaskCompleted(data);
    });

    await pubsub.onTaskEvent('failed', (data) => {
      this.onTaskFailed(data);
    });
  }

  /**
   * Start heartbeat timer
   * @private
   */
  _startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await agentState.updateHeartbeat(this.name);
      } catch (error) {
        console.error(`Heartbeat failed for ${this.name}:`, error.message);
      }
    }, this.heartbeatInterval);
  }

  /**
   * Stop heartbeat timer
   * @private
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Start task processing loop
   * @private
   */
  _startProcessingLoop() {
    (async () => {
      while (this.isRunning) {
        try {
          await this.waitForTask();
        } catch (error) {
          console.error(`Processing loop error in ${this.name}:`, error.message);
          await this.sendAlert('error', 'Processing loop error', { error: error.message });
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    })();
  }

  /**
   * Wait for and process next task (blocking)
   */
  async waitForTask() {
    if (!this.isRunning) {
      return;
    }

    // Set status to idle while waiting
    await agentState.setAgentStatus(this.name, 'idle');

    // Blocking pop from queue (waits up to 30 seconds)
    const task = await taskQueue.popTask(this.name, 30);

    if (!task) {
      // Timeout reached, loop will retry
      return;
    }

    // Process the task
    await this._executeTask(task);
  }

  /**
   * Execute a task with error handling
   * @private
   */
  async _executeTask(task) {
    this.currentTask = task;

    try {
      console.log(`Agent ${this.name} processing task ${task.id}`);

      // Set status to running
      await agentState.setAgentStatus(this.name, 'running', {
        taskId: task.id,
        taskType: task.type
      });

      // Start timeout timer
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeout);
      });

      // Race between task execution and timeout
      const result = await Promise.race([
        this.processTask(task),
        timeoutPromise
      ]);

      // Task completed successfully
      await this.sendResult(task.id, result);
      await agentState.incrementTaskCount(this.name, 'success');

      console.log(`Task ${task.id} completed successfully`);

    } catch (error) {
      console.error(`Task ${task.id} failed:`, error.message);

      // Task failed
      await taskQueue.failTask(task.id, error);
      await agentState.incrementTaskCount(this.name, 'failure');

      // Send failure alert
      await this.sendAlert('error', `Task failed: ${error.message}`, {
        taskId: task.id,
        error: error.message
      });

    } finally {
      this.currentTask = null;
    }
  }

  /**
   * Process a task (override in subclass)
   * @param {object} task - Task to process
   * @returns {Promise<object>} Task result
   */
  async processTask(task) {
    throw new Error('processTask() must be implemented by subclass');
  }

  /**
   * Send task result
   * @param {string} taskId - Task ID
   * @param {object} result - Result data
   */
  async sendResult(taskId, result) {
    await taskQueue.completeTask(taskId, result);
  }

  /**
   * Send an alert
   * @param {string} severity - 'info', 'warning', 'error', 'critical'
   * @param {string} message - Alert message
   * @param {object} metadata - Additional data
   */
  async sendAlert(severity, message, metadata = {}) {
    await pubsub.sendAlert(this.name, severity, message, metadata);
  }

  /**
   * Send message to another agent
   * @param {string} agentName - Target agent
   * @param {object|string} message - Message to send
   */
  async sendToAgent(agentName, message) {
    await pubsub.sendToAgent(agentName, message);
  }

  /**
   * Broadcast message to all agents
   * @param {object|string} message - Message to broadcast
   */
  async broadcast(message) {
    await pubsub.broadcastToAll(message);
  }

  /**
   * Handle incoming message (override in subclass)
   * @param {object|string} message - Received message
   */
  onMessage(message) {
    console.log(`Agent ${this.name} received message:`, message);
  }

  /**
   * Handle broadcast message (override in subclass)
   * @param {object|string} message - Broadcast message
   */
  onBroadcast(message) {
    console.log(`Agent ${this.name} received broadcast:`, message);
  }

  /**
   * Handle task completion event from other agents (override in subclass)
   * @param {object} data - Completion data
   */
  onTaskCompleted(data) {
    // Override if coordination needed
  }

  /**
   * Handle task failure event from other agents (override in subclass)
   * @param {object} data - Failure data
   */
  onTaskFailed(data) {
    // Override if coordination needed
  }

  /**
   * Get agent statistics
   */
  async getStats() {
    return agentState.getAgentStats(this.name);
  }

  /**
   * Get agent state
   */
  async getState() {
    return agentState.getAgentState(this.name);
  }

  /**
   * Update capabilities
   * @param {object} capabilities - New capabilities
   */
  async updateCapabilities(capabilities) {
    this.capabilities = { ...this.capabilities, ...capabilities };
    await agentState.updateCapabilities(this.name, this.capabilities);
  }

  /**
   * Stop the agent
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log(`Stopping agent: ${this.name}`);

    this.isRunning = false;

    // Stop heartbeat
    this._stopHeartbeat();

    // Wait for current task to finish (with timeout)
    if (this.currentTask) {
      console.log(`Waiting for current task ${this.currentTask.id} to finish...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Set status to offline
    await agentState.setAgentStatus(this.name, 'offline');

    // Send shutdown alert
    await pubsub.sendAlert(this.name, 'info', 'Agent stopped');

    // Unsubscribe from channels
    await pubsub.unsubscribe(`agent:${this.name}`);
    await pubsub.unsubscribe('orchestrator');

    // Unregister from state manager
    await agentState.unregisterAgent(this.name);

    console.log(`Agent ${this.name} stopped`);
  }

  /**
   * Pause task processing
   */
  async pause() {
    if (!this.isRunning) {
      return;
    }

    await agentState.setAgentStatus(this.name, 'paused');
    console.log(`Agent ${this.name} paused`);
  }

  /**
   * Resume task processing
   */
  async resume() {
    if (!this.isRunning) {
      return;
    }

    await agentState.setAgentStatus(this.name, 'idle');
    console.log(`Agent ${this.name} resumed`);
  }

  /**
   * Get current task info
   */
  getCurrentTask() {
    return this.currentTask;
  }

  /**
   * Get queue depth
   */
  async getQueueDepth() {
    return taskQueue.getQueueDepth(this.name);
  }

  /**
   * Get pending tasks
   */
  async getPendingTasks() {
    return taskQueue.listPendingTasks(this.name);
  }
}

module.exports = RedisAgent;
