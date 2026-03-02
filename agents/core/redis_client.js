/**
 * Redis Client Wrapper
 *
 * Singleton Redis client with auto-reconnect and helper methods
 */

const Redis = require('ioredis');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  /**
   * Connect to Redis server
   * @returns {Promise<Redis>} Connected Redis client
   */
  async connect() {
    if (this.client && this.isConnected) {
      return this.client;
    }

    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;

    this.client = new Redis({
      host,
      port,
      password,
      retryStrategy: (times) => {
        if (times > this.maxReconnectAttempts) {
          console.error(`Redis: Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
          return null;
        }
        const delay = Math.min(times * 200, 2000);
        console.log(`Redis: Reconnecting in ${delay}ms (attempt ${times}/${this.maxReconnectAttempts})`);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false
    });

    // Event handlers
    this.client.on('connect', () => {
      console.log(`Redis: Connected to ${host}:${port}`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.client.on('ready', () => {
      console.log('Redis: Ready to accept commands');
    });

    this.client.on('error', (err) => {
      console.error('Redis: Error -', err.message);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      console.log('Redis: Connection closed');
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      this.reconnectAttempts++;
      console.log(`Redis: Reconnecting... (attempt ${this.reconnectAttempts})`);
    });

    // Wait for connection to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout after 10s'));
      }, 10000);

      this.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return this.client;
  }

  /**
   * Get the Redis client (auto-connect if needed)
   * @returns {Promise<Redis>}
   */
  async getClient() {
    if (!this.client || !this.isConnected) {
      await this.connect();
    }
    return this.client;
  }

  /**
   * Ping Redis server
   * @returns {Promise<string>} 'PONG' if successful
   */
  async ping() {
    const client = await this.getClient();
    return client.ping();
  }

  /**
   * Close connection
   */
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
      console.log('Redis: Disconnected');
    }
  }

  /**
   * Set key with optional expiry
   * @param {string} key
   * @param {string} value
   * @param {number} ttl - Time to live in seconds (optional)
   */
  async set(key, value, ttl) {
    const client = await this.getClient();
    if (ttl) {
      return client.set(key, value, 'EX', ttl);
    }
    return client.set(key, value);
  }

  /**
   * Get key value
   * @param {string} key
   */
  async get(key) {
    const client = await this.getClient();
    return client.get(key);
  }

  /**
   * Delete key(s)
   * @param {...string} keys
   */
  async del(...keys) {
    const client = await this.getClient();
    return client.del(...keys);
  }

  /**
   * Check if key exists
   * @param {string} key
   */
  async exists(key) {
    const client = await this.getClient();
    return client.exists(key);
  }

  /**
   * Set hash field
   * @param {string} key
   * @param {string} field
   * @param {string} value
   */
  async hset(key, field, value) {
    const client = await this.getClient();
    return client.hset(key, field, value);
  }

  /**
   * Get hash field
   * @param {string} key
   * @param {string} field
   */
  async hget(key, field) {
    const client = await this.getClient();
    return client.hget(key, field);
  }

  /**
   * Get all hash fields
   * @param {string} key
   */
  async hgetall(key) {
    const client = await this.getClient();
    return client.hgetall(key);
  }

  /**
   * Delete hash field
   * @param {string} key
   * @param {string} field
   */
  async hdel(key, field) {
    const client = await this.getClient();
    return client.hdel(key, field);
  }

  /**
   * Add to set
   * @param {string} key
   * @param {...string} members
   */
  async sadd(key, ...members) {
    const client = await this.getClient();
    return client.sadd(key, ...members);
  }

  /**
   * Get all set members
   * @param {string} key
   */
  async smembers(key) {
    const client = await this.getClient();
    return client.smembers(key);
  }

  /**
   * Remove from set
   * @param {string} key
   * @param {...string} members
   */
  async srem(key, ...members) {
    const client = await this.getClient();
    return client.srem(key, ...members);
  }

  /**
   * Push to list (left)
   * @param {string} key
   * @param {...string} values
   */
  async lpush(key, ...values) {
    const client = await this.getClient();
    return client.lpush(key, ...values);
  }

  /**
   * Pop from list (right, blocking)
   * @param {string} key
   * @param {number} timeout - Timeout in seconds
   */
  async brpop(key, timeout = 0) {
    const client = await this.getClient();
    return client.brpop(key, timeout);
  }

  /**
   * Get list length
   * @param {string} key
   */
  async llen(key) {
    const client = await this.getClient();
    return client.llen(key);
  }

  /**
   * Get list range
   * @param {string} key
   * @param {number} start
   * @param {number} stop
   */
  async lrange(key, start, stop) {
    const client = await this.getClient();
    return client.lrange(key, start, stop);
  }

  /**
   * Trim list to specified range
   * @param {string} key
   * @param {number} start
   * @param {number} stop
   */
  async ltrim(key, start, stop) {
    const client = await this.getClient();
    return client.ltrim(key, start, stop);
  }

  /**
   * Set expiry on key
   * @param {string} key
   * @param {number} seconds
   */
  async expire(key, seconds) {
    const client = await this.getClient();
    return client.expire(key, seconds);
  }

  /**
   * Get keys matching pattern
   * @param {string} pattern
   */
  async keys(pattern) {
    const client = await this.getClient();
    return client.keys(pattern);
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Singleton instance
const redisClient = new RedisClient();

module.exports = redisClient;
