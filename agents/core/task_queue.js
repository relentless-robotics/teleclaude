/**
 * Task Queue System
 *
 * Redis-based task queue for multi-agent coordination
 * Uses Redis lists for FIFO queues and blocking pops
 */

const redis = require('./redis_client');
const { v4: uuidv4 } = require('uuid');

class TaskQueue {
  constructor() {
    this.taskTimeout = parseInt(process.env.TASK_TIMEOUT || '300000', 10); // 5 minutes default
  }

  /**
   * Generate unique task ID
   * @returns {string}
   */
  generateTaskId() {
    return `task:${Date.now()}:${uuidv4()}`;
  }

  /**
   * Push a task to an agent's pending queue
   * @param {string} agentName - Target agent
   * @param {object} task - Task data
   * @returns {Promise<string>} Task ID
   */
  async pushTask(agentName, task) {
    const taskId = this.generateTaskId();
    const taskData = {
      id: taskId,
      agentName,
      createdAt: Date.now(),
      status: 'pending',
      ...task
    };

    const queueKey = `tasks:${agentName}:pending`;
    const taskKey = `task:${taskId}`;

    // Store task data
    await redis.set(taskKey, JSON.stringify(taskData));

    // Add to pending queue
    await redis.lpush(queueKey, taskId);

    // Add to global task tracking set
    await redis.sadd('tasks:all', taskId);

    // Set expiry on task data (cleanup after timeout)
    await redis.expire(taskKey, Math.ceil(this.taskTimeout / 1000) * 2);

    console.log(`Task ${taskId} pushed to ${agentName} queue`);
    return taskId;
  }

  /**
   * Pop a task from agent's pending queue (blocking)
   * @param {string} agentName - Agent requesting task
   * @param {number} timeout - Block timeout in seconds (0 = infinite)
   * @returns {Promise<object|null>} Task object or null if timeout
   */
  async popTask(agentName, timeout = 30) {
    const queueKey = `tasks:${agentName}:pending`;

    try {
      // Blocking pop from queue
      const result = await redis.brpop(queueKey, timeout);

      if (!result) {
        return null; // Timeout reached
      }

      const [, taskId] = result;
      const taskKey = `task:${taskId}`;

      // Get task data
      const taskData = await redis.get(taskKey);
      if (!taskData) {
        console.error(`Task ${taskId} data not found`);
        return null;
      }

      const task = JSON.parse(taskData);

      // Move to processing
      task.status = 'processing';
      task.startedAt = Date.now();
      await redis.set(taskKey, JSON.stringify(task));

      // Add to processing set
      await redis.sadd(`tasks:${agentName}:processing`, taskId);

      console.log(`Task ${taskId} popped by ${agentName}`);
      return task;
    } catch (error) {
      console.error(`Error popping task for ${agentName}:`, error.message);
      return null;
    }
  }

  /**
   * Mark task as completed
   * @param {string} taskId - Task ID
   * @param {object} result - Result data
   */
  async completeTask(taskId, result = {}) {
    const taskKey = `task:${taskId}`;

    // Get current task data
    const taskData = await redis.get(taskKey);
    if (!taskData) {
      throw new Error(`Task ${taskId} not found`);
    }

    const task = JSON.parse(taskData);
    const agentName = task.agentName;

    // Update task
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    task.duration = task.completedAt - (task.startedAt || task.createdAt);

    await redis.set(taskKey, JSON.stringify(task));

    // Remove from processing
    await redis.srem(`tasks:${agentName}:processing`, taskId);

    // Add to completed list (keep last 100)
    const completedKey = `tasks:${agentName}:completed`;
    await redis.lpush(completedKey, taskId);
    await redis.ltrim(completedKey, 0, 99);

    // Publish completion event
    const client = await redis.getClient();
    await client.publish('task:completed', JSON.stringify({ taskId, agentName, result }));

    console.log(`Task ${taskId} completed by ${agentName} (${task.duration}ms)`);
    return task;
  }

  /**
   * Mark task as failed
   * @param {string} taskId - Task ID
   * @param {string|object} error - Error info
   */
  async failTask(taskId, error) {
    const taskKey = `task:${taskId}`;

    // Get current task data
    const taskData = await redis.get(taskKey);
    if (!taskData) {
      throw new Error(`Task ${taskId} not found`);
    }

    const task = JSON.parse(taskData);
    const agentName = task.agentName;

    // Update task
    task.status = 'failed';
    task.failedAt = Date.now();
    task.error = typeof error === 'string' ? error : error.message || String(error);
    task.duration = task.failedAt - (task.startedAt || task.createdAt);

    await redis.set(taskKey, JSON.stringify(task));

    // Remove from processing
    await redis.srem(`tasks:${agentName}:processing`, taskId);

    // Add to failed list (keep last 50)
    const failedKey = `tasks:${agentName}:failed`;
    await redis.lpush(failedKey, taskId);
    await redis.ltrim(failedKey, 0, 49);

    // Publish failure event
    const client = await redis.getClient();
    await client.publish('task:failed', JSON.stringify({ taskId, agentName, error: task.error }));

    console.log(`Task ${taskId} failed: ${task.error}`);
    return task;
  }

  /**
   * Get task status and data
   * @param {string} taskId - Task ID
   * @returns {Promise<object|null>}
   */
  async getTaskStatus(taskId) {
    const taskKey = `task:${taskId}`;
    const taskData = await redis.get(taskKey);

    if (!taskData) {
      return null;
    }

    return JSON.parse(taskData);
  }

  /**
   * List pending tasks for an agent
   * @param {string} agentName - Agent name
   * @returns {Promise<Array>} Array of task IDs
   */
  async listPendingTasks(agentName) {
    const queueKey = `tasks:${agentName}:pending`;
    return redis.lrange(queueKey, 0, -1);
  }

  /**
   * Get queue depth (number of pending tasks)
   * @param {string} agentName - Agent name
   * @returns {Promise<number>}
   */
  async getQueueDepth(agentName) {
    const queueKey = `tasks:${agentName}:pending`;
    return redis.llen(queueKey);
  }

  /**
   * Get processing tasks for an agent
   * @param {string} agentName - Agent name
   * @returns {Promise<Array>}
   */
  async getProcessingTasks(agentName) {
    return redis.smembers(`tasks:${agentName}:processing`);
  }

  /**
   * Get completed tasks for an agent
   * @param {string} agentName - Agent name
   * @param {number} limit - Max number to return
   * @returns {Promise<Array>}
   */
  async getCompletedTasks(agentName, limit = 10) {
    const completedKey = `tasks:${agentName}:completed`;
    const taskIds = await redis.lrange(completedKey, 0, limit - 1);

    const tasks = [];
    for (const taskId of taskIds) {
      const task = await this.getTaskStatus(taskId);
      if (task) tasks.push(task);
    }

    return tasks;
  }

  /**
   * Get failed tasks for an agent
   * @param {string} agentName - Agent name
   * @param {number} limit - Max number to return
   * @returns {Promise<Array>}
   */
  async getFailedTasks(agentName, limit = 10) {
    const failedKey = `tasks:${agentName}:failed`;
    const taskIds = await redis.lrange(failedKey, 0, limit - 1);

    const tasks = [];
    for (const taskId of taskIds) {
      const task = await this.getTaskStatus(taskId);
      if (task) tasks.push(task);
    }

    return tasks;
  }

  /**
   * Get queue statistics for an agent
   * @param {string} agentName - Agent name
   * @returns {Promise<object>}
   */
  async getQueueStats(agentName) {
    const [pending, processing, completed, failed] = await Promise.all([
      this.getQueueDepth(agentName),
      this.getProcessingTasks(agentName).then(t => t.length),
      redis.llen(`tasks:${agentName}:completed`),
      redis.llen(`tasks:${agentName}:failed`)
    ]);

    return {
      agentName,
      pending,
      processing,
      completed,
      failed,
      total: pending + processing
    };
  }

  /**
   * Clear all tasks for an agent
   * @param {string} agentName - Agent name
   */
  async clearAgentTasks(agentName) {
    const keys = [
      `tasks:${agentName}:pending`,
      `tasks:${agentName}:processing`,
      `tasks:${agentName}:completed`,
      `tasks:${agentName}:failed`
    ];

    await redis.del(...keys);
    console.log(`Cleared all tasks for ${agentName}`);
  }

  /**
   * Cancel a pending task
   * @param {string} taskId - Task ID
   */
  async cancelTask(taskId) {
    const task = await this.getTaskStatus(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== 'pending') {
      throw new Error(`Cannot cancel task with status: ${task.status}`);
    }

    const agentName = task.agentName;
    const queueKey = `tasks:${agentName}:pending`;

    // Remove from queue
    const client = await redis.getClient();
    await client.lrem(queueKey, 0, taskId);

    // Update status
    task.status = 'cancelled';
    task.cancelledAt = Date.now();
    await redis.set(`task:${taskId}`, JSON.stringify(task));

    console.log(`Task ${taskId} cancelled`);
    return task;
  }
}

module.exports = new TaskQueue();
