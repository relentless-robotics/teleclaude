/**
 * Pub/Sub Communication System
 *
 * Real-time messaging between agents using Redis pub/sub
 */

const Redis = require('ioredis');

class PubSubManager {
  constructor() {
    this.publisher = null;
    this.subscriber = null;
    this.channels = new Map(); // channel -> Set of callbacks
    this.isConnected = false;
  }

  /**
   * Initialize pub/sub connections
   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;

    const config = {
      host,
      port,
      password,
      retryStrategy: (times) => {
        if (times > 10) return null;
        return Math.min(times * 200, 2000);
      }
    };

    // Publisher connection
    this.publisher = new Redis(config);

    // Subscriber connection (separate connection required)
    this.subscriber = new Redis(config);

    this.publisher.on('error', (err) => {
      console.error('PubSub Publisher Error:', err.message);
    });

    this.subscriber.on('error', (err) => {
      console.error('PubSub Subscriber Error:', err.message);
    });

    this.subscriber.on('message', (channel, message) => {
      this._handleMessage(channel, message);
    });

    this.subscriber.on('pmessage', (pattern, channel, message) => {
      this._handleMessage(channel, message);
    });

    await Promise.all([
      this.publisher.ping(),
      this.subscriber.ping()
    ]);

    this.isConnected = true;
    console.log('PubSub: Connected');
  }

  /**
   * Handle incoming message
   * @private
   */
  _handleMessage(channel, message) {
    const callbacks = this.channels.get(channel);
    if (!callbacks || callbacks.size === 0) {
      return;
    }

    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      data = message; // Plain string message
    }

    callbacks.forEach(callback => {
      try {
        callback(data, channel);
      } catch (error) {
        console.error(`PubSub: Error in callback for ${channel}:`, error.message);
      }
    });
  }

  /**
   * Publish a message to a channel
   * @param {string} channel - Channel name
   * @param {object|string} message - Message to publish
   */
  async publish(channel, message) {
    if (!this.isConnected) {
      await this.connect();
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    await this.publisher.publish(channel, payload);
  }

  /**
   * Subscribe to a channel
   * @param {string} channel - Channel name
   * @param {function} callback - Callback(message, channel)
   */
  async subscribe(channel, callback) {
    if (!this.isConnected) {
      await this.connect();
    }

    // Add callback to channel
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
      await this.subscriber.subscribe(channel);
      console.log(`PubSub: Subscribed to ${channel}`);
    }

    this.channels.get(channel).add(callback);
  }

  /**
   * Unsubscribe from a channel
   * @param {string} channel - Channel name
   * @param {function} callback - Specific callback to remove (optional)
   */
  async unsubscribe(channel, callback = null) {
    const callbacks = this.channels.get(channel);
    if (!callbacks) {
      return;
    }

    if (callback) {
      callbacks.delete(callback);
    }

    // If no callbacks left, unsubscribe from Redis
    if (!callback || callbacks.size === 0) {
      await this.subscriber.unsubscribe(channel);
      this.channels.delete(channel);
      console.log(`PubSub: Unsubscribed from ${channel}`);
    }
  }

  /**
   * Subscribe to a pattern
   * @param {string} pattern - Pattern (e.g., 'agent:*')
   * @param {function} callback - Callback(message, channel)
   */
  async psubscribe(pattern, callback) {
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.channels.has(pattern)) {
      this.channels.set(pattern, new Set());
      await this.subscriber.psubscribe(pattern);
      console.log(`PubSub: Pattern subscribed to ${pattern}`);
    }

    this.channels.get(pattern).add(callback);
  }

  /**
   * Unsubscribe from a pattern
   * @param {string} pattern - Pattern
   * @param {function} callback - Specific callback to remove (optional)
   */
  async punsubscribe(pattern, callback = null) {
    const callbacks = this.channels.get(pattern);
    if (!callbacks) {
      return;
    }

    if (callback) {
      callbacks.delete(callback);
    }

    if (!callback || callbacks.size === 0) {
      await this.subscriber.punsubscribe(pattern);
      this.channels.delete(pattern);
      console.log(`PubSub: Pattern unsubscribed from ${pattern}`);
    }
  }

  /**
   * Send an alert to the alerts channel
   * @param {string} agentName - Agent sending the alert
   * @param {string} severity - 'info', 'warning', 'error', 'critical'
   * @param {string} message - Alert message
   * @param {object} metadata - Additional data (optional)
   */
  async sendAlert(agentName, severity, message, metadata = {}) {
    const alert = {
      agentName,
      severity,
      message,
      timestamp: Date.now(),
      ...metadata
    };

    await this.publish('alerts', alert);
    console.log(`Alert [${severity}] from ${agentName}: ${message}`);
  }

  /**
   * Send a message to a specific agent
   * @param {string} agentName - Target agent
   * @param {object|string} message - Message to send
   */
  async sendToAgent(agentName, message) {
    const channel = `agent:${agentName}`;
    await this.publish(channel, message);
  }

  /**
   * Broadcast a message to all agents
   * @param {object|string} message - Message to broadcast
   */
  async broadcastToAll(message) {
    await this.publish('orchestrator', message);
  }

  /**
   * Subscribe to alerts
   * @param {function} callback - Callback(alert)
   */
  async onAlert(callback) {
    await this.subscribe('alerts', callback);
  }

  /**
   * Subscribe to orchestrator messages (broadcasts)
   * @param {function} callback - Callback(message)
   */
  async onBroadcast(callback) {
    await this.subscribe('orchestrator', callback);
  }

  /**
   * Subscribe to agent-specific messages
   * @param {string} agentName - Agent name
   * @param {function} callback - Callback(message)
   */
  async onAgentMessage(agentName, callback) {
    await this.subscribe(`agent:${agentName}`, callback);
  }

  /**
   * Subscribe to all agent messages
   * @param {function} callback - Callback(message, channel)
   */
  async onAnyAgentMessage(callback) {
    await this.psubscribe('agent:*', callback);
  }

  /**
   * Subscribe to task events
   * @param {string} event - 'completed' or 'failed'
   * @param {function} callback - Callback(data)
   */
  async onTaskEvent(event, callback) {
    await this.subscribe(`task:${event}`, callback);
  }

  /**
   * Get list of active channels
   * @returns {Array<string>}
   */
  getActiveChannels() {
    return Array.from(this.channels.keys());
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect() {
    if (this.subscriber) {
      // Unsubscribe from all channels
      for (const channel of this.channels.keys()) {
        if (channel.includes('*')) {
          await this.subscriber.punsubscribe(channel);
        } else {
          await this.subscriber.unsubscribe(channel);
        }
      }

      await this.subscriber.quit();
      this.subscriber = null;
    }

    if (this.publisher) {
      await this.publisher.quit();
      this.publisher = null;
    }

    this.channels.clear();
    this.isConnected = false;
    console.log('PubSub: Disconnected');
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      activeChannels: this.getActiveChannels(),
      channelCount: this.channels.size
    };
  }
}

module.exports = new PubSubManager();
