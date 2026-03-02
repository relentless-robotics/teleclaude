/**
 * Model-Agnostic Embedding Service for Memory System v4
 *
 * Provides embeddings from multiple sources with automatic fallback:
 * 1. Local sentence-transformers via @xenova/transformers (default, free)
 * 2. OpenAI API (if key available)
 * 3. Simple TF-IDF (always available fallback)
 *
 * Features:
 * - Automatic model selection based on availability
 * - Embedding caching
 * - Batch processing support
 * - Model-agnostic interface
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Try to load OpenAI if available
let OpenAI = null;
try {
  OpenAI = require('openai');
} catch (e) {
  // OpenAI not installed
}

// Configuration paths
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CACHE_DIR = path.join(__dirname, '..', 'memory', 'embedding-cache');
const CONFIG_FILE = path.join(CONFIG_DIR, 'embedding.json');

// Default configuration
const DEFAULT_CONFIG = {
  provider: 'auto', // 'auto', 'local', 'openai', 'tfidf'
  localModel: 'Xenova/all-MiniLM-L6-v2',
  openaiModel: 'text-embedding-3-small',
  dimensions: 384, // MiniLM default
  cacheEnabled: true,
  cacheTTLDays: 30,
  batchSize: 32
};

/**
 * Simple TF-IDF based embedding fallback
 * Always available, no dependencies
 */
class TFIDFEmbedding {
  constructor() {
    this.vocabulary = new Map();
    this.idf = new Map();
    this.docCount = 0;
  }

  /**
   * Tokenize text
   */
  tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  /**
   * Update vocabulary with new document
   */
  addDocument(text) {
    const tokens = new Set(this.tokenize(text));
    this.docCount++;

    for (const token of tokens) {
      this.idf.set(token, (this.idf.get(token) || 0) + 1);
      if (!this.vocabulary.has(token)) {
        this.vocabulary.set(token, this.vocabulary.size);
      }
    }
  }

  /**
   * Generate sparse TF-IDF vector as dense array
   */
  embed(text, dimensions = 384) {
    const tokens = this.tokenize(text);
    const termFreq = new Map();

    // Count term frequency
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Create dense vector using hash trick for fixed dimensions
    const vector = new Array(dimensions).fill(0);
    const maxTF = Math.max(...termFreq.values(), 1);

    for (const [token, tf] of termFreq) {
      const normalizedTF = tf / maxTF;
      const idf = this.docCount > 0
        ? Math.log(this.docCount / (1 + (this.idf.get(token) || 0)))
        : 1;
      const tfidf = normalizedTF * idf;

      // Hash token to dimension index
      const hash = this._hash(token);
      const idx = Math.abs(hash) % dimensions;

      // Use sign from hash for variance
      const sign = hash >= 0 ? 1 : -1;
      vector[idx] += sign * tfidf;
    }

    // Normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  /**
   * Simple string hash
   */
  _hash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }
}

/**
 * Main Embedding Service Class
 */
class EmbeddingService {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = null;
    this.providerName = 'none';
    this.dimensions = this.config.dimensions;
    this.cache = new Map();
    this.tfidfFallback = new TFIDFEmbedding();
    this.pipeline = null;
    this.openaiClient = null;
    this.initialized = false;

    // Ensure cache directory exists
    if (this.config.cacheEnabled && !fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  }

  /**
   * Initialize embedding provider
   */
  async init() {
    if (this.initialized) return this;

    const provider = this.config.provider;

    // Auto-detect best provider
    if (provider === 'auto' || provider === 'local') {
      try {
        // Try loading transformers.js
        const { pipeline, env } = await import('@xenova/transformers');

        // Disable local model check warning
        env.allowLocalModels = false;

        console.error(`[EmbeddingService] Loading local model: ${this.config.localModel}`);
        this.pipeline = await pipeline('feature-extraction', this.config.localModel);
        this.providerName = 'local';
        this.dimensions = 384; // MiniLM-L6-v2 dimension
        this.initialized = true;
        console.error('[EmbeddingService] Local model loaded successfully');
        return this;
      } catch (e) {
        console.error(`[EmbeddingService] Local model failed: ${e.message}`);
        if (provider === 'local') {
          throw new Error(`Local embedding model unavailable: ${e.message}`);
        }
      }
    }

    if (provider === 'auto' || provider === 'openai') {
      try {
        // Try OpenAI
        const apiKey = this._getOpenAIKey();
        if (apiKey && OpenAI) {
          this.openaiClient = new OpenAI({ apiKey });
          this.providerName = 'openai';
          this.dimensions = 1536; // text-embedding-3-small default
          this.initialized = true;
          console.error('[EmbeddingService] OpenAI embeddings initialized');
          return this;
        } else if (provider === 'openai') {
          throw new Error('OpenAI API key not found');
        }
      } catch (e) {
        console.error(`[EmbeddingService] OpenAI failed: ${e.message}`);
        if (provider === 'openai') {
          throw new Error(`OpenAI embedding unavailable: ${e.message}`);
        }
      }
    }

    // Fall back to TF-IDF
    console.error('[EmbeddingService] Using TF-IDF fallback');
    this.providerName = 'tfidf';
    this.dimensions = 384;
    this.initialized = true;

    return this;
  }

  /**
   * Get OpenAI API key from various sources
   */
  _getOpenAIKey() {
    // Environment variable
    if (process.env.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }

    // Try reading from API_KEYS.md
    try {
      const apiKeysPath = path.join(__dirname, '..', 'API_KEYS.md');
      if (fs.existsSync(apiKeysPath)) {
        const content = fs.readFileSync(apiKeysPath, 'utf8');
        const match = content.match(/API Key\s*\|\s*`(sk-[^`]+)`/);
        if (match) {
          return match[1];
        }
      }
    } catch (e) {
      // Ignore
    }

    return null;
  }

  /**
   * Generate embedding for text
   */
  async embed(text) {
    if (!this.initialized) {
      await this.init();
    }

    if (!text || typeof text !== 'string') {
      return new Array(this.dimensions).fill(0);
    }

    // Check cache
    if (this.config.cacheEnabled) {
      const cached = this._getCached(text);
      if (cached) return cached;
    }

    let embedding;

    switch (this.providerName) {
      case 'local':
        embedding = await this._embedLocal(text);
        break;
      case 'openai':
        embedding = await this._embedOpenAI(text);
        break;
      case 'tfidf':
      default:
        embedding = this.tfidfFallback.embed(text, this.dimensions);
    }

    // Cache result
    if (this.config.cacheEnabled) {
      this._setCache(text, embedding);
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async embedBatch(texts) {
    if (!this.initialized) {
      await this.init();
    }

    const results = [];
    const uncachedTexts = [];
    const uncachedIndices = [];

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const cached = this.config.cacheEnabled ? this._getCached(texts[i]) : null;
      if (cached) {
        results[i] = cached;
      } else {
        uncachedTexts.push(texts[i]);
        uncachedIndices.push(i);
      }
    }

    // Process uncached in batches
    if (uncachedTexts.length > 0) {
      const batchSize = this.config.batchSize;

      for (let i = 0; i < uncachedTexts.length; i += batchSize) {
        const batch = uncachedTexts.slice(i, i + batchSize);
        const batchIndices = uncachedIndices.slice(i, i + batchSize);

        let embeddings;
        switch (this.providerName) {
          case 'local':
            embeddings = await this._embedLocalBatch(batch);
            break;
          case 'openai':
            embeddings = await this._embedOpenAIBatch(batch);
            break;
          case 'tfidf':
          default:
            embeddings = batch.map(t => this.tfidfFallback.embed(t, this.dimensions));
        }

        // Store results and cache
        for (let j = 0; j < embeddings.length; j++) {
          const idx = batchIndices[j];
          results[idx] = embeddings[j];

          if (this.config.cacheEnabled) {
            this._setCache(batch[j], embeddings[j]);
          }
        }
      }
    }

    return results;
  }

  /**
   * Local embedding using transformers.js
   */
  async _embedLocal(text) {
    const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  /**
   * Local batch embedding
   */
  async _embedLocalBatch(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await this._embedLocal(text));
    }
    return results;
  }

  /**
   * OpenAI embedding
   */
  async _embedOpenAI(text) {
    const response = await this.openaiClient.embeddings.create({
      model: this.config.openaiModel,
      input: text
    });
    return response.data[0].embedding;
  }

  /**
   * OpenAI batch embedding
   */
  async _embedOpenAIBatch(texts) {
    const response = await this.openaiClient.embeddings.create({
      model: this.config.openaiModel,
      input: texts
    });
    return response.data.map(d => d.embedding);
  }

  /**
   * Add document to TF-IDF vocabulary (for fallback)
   */
  addToVocabulary(text) {
    this.tfidfFallback.addDocument(text);
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dot / (normA * normB);
  }

  /**
   * Get cache key for text
   */
  _getCacheKey(text) {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  /**
   * Get cached embedding
   */
  _getCached(text) {
    const key = this._getCacheKey(text);

    // Check memory cache first
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // Check disk cache
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    if (fs.existsSync(cacheFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

        // Check TTL
        const age = (Date.now() - new Date(data.created).getTime()) / (1000 * 60 * 60 * 24);
        if (age < this.config.cacheTTLDays) {
          this.cache.set(key, data.embedding);
          return data.embedding;
        } else {
          // Expired, delete
          fs.unlinkSync(cacheFile);
        }
      } catch (e) {
        // Invalid cache file
      }
    }

    return null;
  }

  /**
   * Cache embedding
   */
  _setCache(text, embedding) {
    const key = this._getCacheKey(text);

    // Memory cache
    this.cache.set(key, embedding);

    // Disk cache
    const cacheFile = path.join(CACHE_DIR, `${key}.json`);
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({
        text: text.slice(0, 100), // Store preview for debugging
        embedding,
        provider: this.providerName,
        created: new Date().toISOString()
      }));
    } catch (e) {
      // Cache write failure is not critical
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();

    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, file));
          } catch (e) {
            // Ignore
          }
        }
      }
    }
  }

  /**
   * Get provider info
   */
  getInfo() {
    return {
      provider: this.providerName,
      dimensions: this.dimensions,
      cacheEnabled: this.config.cacheEnabled,
      cacheSize: this.cache.size,
      initialized: this.initialized
    };
  }

  /**
   * Save configuration
   */
  saveConfig() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  /**
   * Load configuration
   */
  static loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch (e) {
        // Invalid config
      }
    }
    return DEFAULT_CONFIG;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create embedding service instance
 */
async function getEmbeddingService(config = null) {
  if (!instance || config) {
    instance = new EmbeddingService(config || EmbeddingService.loadConfig());
    await instance.init();
  }
  return instance;
}

module.exports = {
  EmbeddingService,
  TFIDFEmbedding,
  getEmbeddingService,
  DEFAULT_CONFIG,
  CACHE_DIR,
  CONFIG_FILE
};
