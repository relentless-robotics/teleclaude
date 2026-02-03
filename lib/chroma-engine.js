/**
 * Chroma Vector Database Engine for Memory System v4
 *
 * Provides semantic similarity search using Chroma vector database.
 * Features:
 * - Collection management for memories and projects
 * - Upsert/delete operations
 * - K-nearest neighbor similarity search
 * - Metadata filtering
 */

const path = require('path');
const fs = require('fs');

// Data directory for Chroma persistence
const CHROMA_DIR = path.join(__dirname, '..', 'memory', 'chroma');

// Collection names
const MEMORIES_COLLECTION = 'memories';
const PROJECTS_COLLECTION = 'projects';

/**
 * Chroma Engine Class
 */
class ChromaEngine {
  constructor(persistDir = CHROMA_DIR) {
    this.persistDir = persistDir;
    this.client = null;
    this.memoriesCollection = null;
    this.projectsCollection = null;
    this.initialized = false;
    this.embeddingService = null;

    // Ensure directory exists
    if (!fs.existsSync(persistDir)) {
      fs.mkdirSync(persistDir, { recursive: true });
    }
  }

  /**
   * Initialize Chroma client and collections
   */
  async init(embeddingService = null) {
    if (this.initialized) return this;

    this.embeddingService = embeddingService;

    try {
      // Dynamic import for ChromaDB
      const { ChromaClient } = await import('chromadb');

      // Create client with persistence
      this.client = new ChromaClient({
        path: this.persistDir
      });

      // Create or get collections
      // Note: ChromaDB uses its own embedding function, but we'll provide our own
      this.memoriesCollection = await this.client.getOrCreateCollection({
        name: MEMORIES_COLLECTION,
        metadata: { description: 'Memory storage for Claude' }
      });

      this.projectsCollection = await this.client.getOrCreateCollection({
        name: PROJECTS_COLLECTION,
        metadata: { description: 'Project storage for Claude' }
      });

      this.initialized = true;
      console.error('[ChromaEngine] Initialized successfully');
      return this;
    } catch (e) {
      console.error(`[ChromaEngine] Initialization failed: ${e.message}`);
      // Fall back to in-memory implementation
      return this._initInMemory();
    }
  }

  /**
   * Initialize in-memory fallback when Chroma is not available
   */
  _initInMemory() {
    console.error('[ChromaEngine] Using in-memory fallback');

    this.memoriesCollection = new InMemoryCollection(MEMORIES_COLLECTION);
    this.projectsCollection = new InMemoryCollection(PROJECTS_COLLECTION);

    // Load persisted data if available
    this._loadFromDisk();

    this.initialized = true;
    return this;
  }

  /**
   * Set embedding service
   */
  setEmbeddingService(embeddingService) {
    this.embeddingService = embeddingService;
  }

  // ==================== MEMORY OPERATIONS ====================

  /**
   * Upsert memory into vector store
   */
  async upsertMemory(id, content, metadata = {}, embedding = null) {
    if (!this.initialized) {
      await this.init();
    }

    // Get or compute embedding
    const vector = embedding || (this.embeddingService
      ? await this.embeddingService.embed(content)
      : null);

    if (!vector) {
      throw new Error('No embedding provided and no embedding service available');
    }

    await this.memoriesCollection.upsert({
      ids: [id],
      embeddings: [vector],
      documents: [content],
      metadatas: [metadata]
    });

    // Save to disk for in-memory fallback
    if (this.memoriesCollection instanceof InMemoryCollection) {
      this._saveToDisk();
    }
  }

  /**
   * Upsert multiple memories (batch)
   */
  async upsertMemoriesBatch(items) {
    if (!this.initialized) {
      await this.init();
    }

    const ids = items.map(i => i.id);
    const documents = items.map(i => i.content);
    const metadatas = items.map(i => i.metadata || {});

    // Get or compute embeddings
    let embeddings = items.map(i => i.embedding);
    const needsEmbedding = embeddings.some(e => !e);

    if (needsEmbedding && this.embeddingService) {
      const textsToEmbed = items.filter((_, idx) => !embeddings[idx]).map(i => i.content);
      const newEmbeddings = await this.embeddingService.embedBatch(textsToEmbed);

      let embeddingIdx = 0;
      embeddings = embeddings.map((e, idx) =>
        e || newEmbeddings[embeddingIdx++]
      );
    }

    await this.memoriesCollection.upsert({
      ids,
      embeddings,
      documents,
      metadatas
    });

    if (this.memoriesCollection instanceof InMemoryCollection) {
      this._saveToDisk();
    }
  }

  /**
   * Delete memory from vector store
   */
  async deleteMemory(id) {
    if (!this.initialized) {
      await this.init();
    }

    await this.memoriesCollection.delete({ ids: [id] });

    if (this.memoriesCollection instanceof InMemoryCollection) {
      this._saveToDisk();
    }
  }

  /**
   * Search memories by semantic similarity
   */
  async searchMemories(query, options = {}) {
    if (!this.initialized) {
      await this.init();
    }

    const {
      limit = 10,
      threshold = 0.3,
      whereFilter = null
    } = options;

    // Get query embedding
    let queryEmbedding;
    if (typeof query === 'string') {
      if (!this.embeddingService) {
        throw new Error('Embedding service required for text queries');
      }
      queryEmbedding = await this.embeddingService.embed(query);
    } else {
      // Assume it's already an embedding
      queryEmbedding = query;
    }

    // Query collection
    const results = await this.memoriesCollection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereFilter
    });

    // Format and filter by threshold
    return this._formatQueryResults(results, threshold);
  }

  /**
   * Find memories similar to a given memory
   */
  async findSimilarMemories(id, limit = 5) {
    if (!this.initialized) {
      await this.init();
    }

    // Get the memory's embedding
    const existing = await this.memoriesCollection.get({ ids: [id] });
    if (!existing || !existing.embeddings || !existing.embeddings[0]) {
      return [];
    }

    const embedding = existing.embeddings[0];

    // Search excluding the original
    const results = await this.memoriesCollection.query({
      queryEmbeddings: [embedding],
      nResults: limit + 1
    });

    // Filter out the original and format
    const formatted = this._formatQueryResults(results, 0.1);
    return formatted.filter(r => r.id !== id).slice(0, limit);
  }

  // ==================== PROJECT OPERATIONS ====================

  /**
   * Upsert project into vector store
   */
  async upsertProject(id, name, description, steps, metadata = {}, embedding = null) {
    if (!this.initialized) {
      await this.init();
    }

    // Create searchable text from project components
    const stepsText = Array.isArray(steps)
      ? steps.map(s => typeof s === 'string' ? s : s.task).join(' ')
      : '';
    const content = `${name} ${description || ''} ${stepsText}`;

    // Get or compute embedding
    const vector = embedding || (this.embeddingService
      ? await this.embeddingService.embed(content)
      : null);

    if (!vector) {
      throw new Error('No embedding provided and no embedding service available');
    }

    await this.projectsCollection.upsert({
      ids: [id],
      embeddings: [vector],
      documents: [content],
      metadatas: [{ name, ...metadata }]
    });

    if (this.projectsCollection instanceof InMemoryCollection) {
      this._saveToDisk();
    }
  }

  /**
   * Delete project from vector store
   */
  async deleteProject(id) {
    if (!this.initialized) {
      await this.init();
    }

    await this.projectsCollection.delete({ ids: [id] });

    if (this.projectsCollection instanceof InMemoryCollection) {
      this._saveToDisk();
    }
  }

  /**
   * Search projects by semantic similarity
   */
  async searchProjects(query, options = {}) {
    if (!this.initialized) {
      await this.init();
    }

    const { limit = 10, threshold = 0.3 } = options;

    let queryEmbedding;
    if (typeof query === 'string') {
      if (!this.embeddingService) {
        throw new Error('Embedding service required for text queries');
      }
      queryEmbedding = await this.embeddingService.embed(query);
    } else {
      queryEmbedding = query;
    }

    const results = await this.projectsCollection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit
    });

    return this._formatQueryResults(results, threshold);
  }

  // ==================== UNIFIED SEARCH ====================

  /**
   * Search both memories and projects
   */
  async searchAll(query, options = {}) {
    const { memoryLimit = 10, projectLimit = 5, threshold = 0.3 } = options;

    const [memories, projects] = await Promise.all([
      this.searchMemories(query, { limit: memoryLimit, threshold }),
      this.searchProjects(query, { limit: projectLimit, threshold })
    ]);

    return {
      memories,
      projects
    };
  }

  // ==================== UTILITIES ====================

  /**
   * Format query results from Chroma
   */
  _formatQueryResults(results, threshold = 0) {
    if (!results || !results.ids || !results.ids[0]) {
      return [];
    }

    const formatted = [];
    const ids = results.ids[0];
    const distances = results.distances ? results.distances[0] : null;
    const documents = results.documents ? results.documents[0] : null;
    const metadatas = results.metadatas ? results.metadatas[0] : null;

    for (let i = 0; i < ids.length; i++) {
      // Chroma returns L2 distance, convert to similarity score
      // Lower distance = higher similarity
      const distance = distances ? distances[i] : 0;
      const score = 1 / (1 + distance); // Convert distance to 0-1 similarity

      if (score >= threshold) {
        formatted.push({
          id: ids[i],
          score,
          distance,
          document: documents ? documents[i] : null,
          metadata: metadatas ? metadatas[i] : null
        });
      }
    }

    // Sort by score descending
    return formatted.sort((a, b) => b.score - a.score);
  }

  /**
   * Get collection statistics
   */
  async getStats() {
    if (!this.initialized) {
      await this.init();
    }

    const memoriesCount = await this.memoriesCollection.count();
    const projectsCount = await this.projectsCollection.count();

    return {
      memories: memoriesCount,
      projects: projectsCount,
      persistDir: this.persistDir,
      inMemory: this.memoriesCollection instanceof InMemoryCollection
    };
  }

  /**
   * Clear all data
   */
  async clear() {
    if (this.memoriesCollection) {
      if (this.memoriesCollection instanceof InMemoryCollection) {
        this.memoriesCollection.clear();
      } else {
        await this.client.deleteCollection({ name: MEMORIES_COLLECTION });
        this.memoriesCollection = await this.client.getOrCreateCollection({ name: MEMORIES_COLLECTION });
      }
    }

    if (this.projectsCollection) {
      if (this.projectsCollection instanceof InMemoryCollection) {
        this.projectsCollection.clear();
      } else {
        await this.client.deleteCollection({ name: PROJECTS_COLLECTION });
        this.projectsCollection = await this.client.getOrCreateCollection({ name: PROJECTS_COLLECTION });
      }
    }

    // Clear persisted data
    const persistFile = path.join(this.persistDir, 'in-memory-store.json');
    if (fs.existsSync(persistFile)) {
      fs.unlinkSync(persistFile);
    }
  }

  /**
   * Save in-memory data to disk
   */
  _saveToDisk() {
    if (!(this.memoriesCollection instanceof InMemoryCollection)) return;

    const data = {
      memories: this.memoriesCollection.toJSON(),
      projects: this.projectsCollection.toJSON(),
      savedAt: new Date().toISOString()
    };

    const persistFile = path.join(this.persistDir, 'in-memory-store.json');
    fs.writeFileSync(persistFile, JSON.stringify(data));
  }

  /**
   * Load in-memory data from disk
   */
  _loadFromDisk() {
    const persistFile = path.join(this.persistDir, 'in-memory-store.json');
    if (!fs.existsSync(persistFile)) return;

    try {
      const data = JSON.parse(fs.readFileSync(persistFile, 'utf8'));

      if (data.memories && this.memoriesCollection instanceof InMemoryCollection) {
        this.memoriesCollection.loadFromJSON(data.memories);
      }
      if (data.projects && this.projectsCollection instanceof InMemoryCollection) {
        this.projectsCollection.loadFromJSON(data.projects);
      }

      console.error('[ChromaEngine] Loaded from disk');
    } catch (e) {
      console.error(`[ChromaEngine] Failed to load from disk: ${e.message}`);
    }
  }
}

/**
 * In-Memory Collection Fallback
 * Used when Chroma is not available
 */
class InMemoryCollection {
  constructor(name) {
    this.name = name;
    this.items = new Map(); // id -> { embedding, document, metadata }
  }

  async upsert({ ids, embeddings, documents, metadatas }) {
    for (let i = 0; i < ids.length; i++) {
      this.items.set(ids[i], {
        embedding: embeddings[i],
        document: documents ? documents[i] : null,
        metadata: metadatas ? metadatas[i] : {}
      });
    }
  }

  async delete({ ids }) {
    for (const id of ids) {
      this.items.delete(id);
    }
  }

  async get({ ids }) {
    const embeddings = [];
    const documents = [];
    const metadatas = [];

    for (const id of ids) {
      const item = this.items.get(id);
      if (item) {
        embeddings.push(item.embedding);
        documents.push(item.document);
        metadatas.push(item.metadata);
      }
    }

    return {
      ids,
      embeddings,
      documents,
      metadatas
    };
  }

  async query({ queryEmbeddings, nResults, where }) {
    const queryEmbedding = queryEmbeddings[0];
    const results = [];

    for (const [id, item] of this.items) {
      // Apply where filter if provided
      if (where && !this._matchesFilter(item.metadata, where)) {
        continue;
      }

      const distance = this._euclideanDistance(queryEmbedding, item.embedding);
      results.push({ id, distance, ...item });
    }

    // Sort by distance (lower is better)
    results.sort((a, b) => a.distance - b.distance);
    const top = results.slice(0, nResults);

    return {
      ids: [top.map(r => r.id)],
      distances: [top.map(r => r.distance)],
      documents: [top.map(r => r.document)],
      metadatas: [top.map(r => r.metadata)]
    };
  }

  async count() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }

  _euclideanDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;

    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  _matchesFilter(metadata, where) {
    if (!where || !metadata) return true;

    for (const [key, value] of Object.entries(where)) {
      if (metadata[key] !== value) return false;
    }
    return true;
  }

  toJSON() {
    const data = [];
    for (const [id, item] of this.items) {
      data.push({ id, ...item });
    }
    return data;
  }

  loadFromJSON(data) {
    for (const item of data) {
      this.items.set(item.id, {
        embedding: item.embedding,
        document: item.document,
        metadata: item.metadata
      });
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create Chroma engine instance
 */
async function getChromaEngine(embeddingService = null) {
  if (!instance) {
    instance = new ChromaEngine();
    await instance.init(embeddingService);
  } else if (embeddingService) {
    instance.setEmbeddingService(embeddingService);
  }
  return instance;
}

module.exports = {
  ChromaEngine,
  InMemoryCollection,
  getChromaEngine,
  CHROMA_DIR,
  MEMORIES_COLLECTION,
  PROJECTS_COLLECTION
};
