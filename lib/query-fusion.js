/**
 * Query Fusion Module for Memory System v4
 *
 * Combines SQLite structured queries with Chroma semantic search
 * using Reciprocal Rank Fusion (RRF) for optimal result ranking.
 *
 * Features:
 * - Hybrid search (filter + semantic)
 * - Reciprocal Rank Fusion (RRF) scoring
 * - Configurable weight balancing
 * - Result deduplication and merging
 */

const path = require('path');

// Default fusion configuration
const DEFAULT_CONFIG = {
  // RRF constant (higher = more equal weight)
  rrfK: 60,

  // Weight for each source (should sum to 1.0)
  weights: {
    sqlite: 0.3,    // Structured/exact matches
    chroma: 0.7     // Semantic similarity
  },

  // Minimum scores to include results
  thresholds: {
    sqlite: 0.0,
    chroma: 0.2
  },

  // Default limits
  defaultLimit: 20,
  maxLimit: 100,

  // Boost factors
  boosts: {
    recency: 0.1,       // Boost per day (up to 7 days)
    priority: {
      URGENT: 1.3,
      DAILY: 1.1,
      WEEKLY: 1.0,
      ARCHIVE: 0.8
    }
  }
};

/**
 * Reciprocal Rank Fusion
 * Combines multiple ranked lists into a single ranking
 */
class RRFusion {
  constructor(k = 60) {
    this.k = k;
  }

  /**
   * Calculate RRF score for a single rank
   * score = 1 / (k + rank)
   */
  score(rank) {
    return 1 / (this.k + rank);
  }

  /**
   * Fuse multiple ranked result lists
   * @param {Array} rankedLists - Array of { results: [...], weight: number }
   * @returns {Array} Fused results sorted by combined score
   */
  fuse(rankedLists) {
    const scoreMap = new Map(); // id -> { item, score }

    for (const { results, weight } of rankedLists) {
      for (let rank = 0; rank < results.length; rank++) {
        const item = results[rank];
        const id = item.id;
        const rrfScore = this.score(rank + 1) * weight;

        if (scoreMap.has(id)) {
          const existing = scoreMap.get(id);
          existing.score += rrfScore;
          existing.sources.push({ rank: rank + 1, weight });
        } else {
          scoreMap.set(id, {
            item: { ...item },
            score: rrfScore,
            sources: [{ rank: rank + 1, weight }]
          });
        }
      }
    }

    // Convert to array and sort by score
    const fused = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score);

    return fused;
  }
}

/**
 * Query Fusion Engine
 */
class QueryFusion {
  constructor(sqliteEngine, chromaEngine, config = {}) {
    this.sqlite = sqliteEngine;
    this.chroma = chromaEngine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rrfusion = new RRFusion(this.config.rrfK);
  }

  /**
   * Set engines after construction
   */
  setEngines(sqliteEngine, chromaEngine) {
    this.sqlite = sqliteEngine;
    this.chroma = chromaEngine;
  }

  /**
   * Hybrid search for memories
   *
   * @param {string} query - Search query (text for semantic search)
   * @param {Object} options - Search options
   * @returns {Array} Fused, ranked results
   */
  async searchMemories(query, options = {}) {
    const {
      limit = this.config.defaultLimit,
      priority = null,
      tag = null,
      includeCompleted = false,
      useStructured = true,
      useSemantic = true
    } = options;

    const rankedLists = [];

    // 1. SQLite Full-Text Search (structured)
    if (useStructured && query && this.sqlite) {
      try {
        const sqliteResults = this.sqlite.searchMemoriesFTS(query, {
          limit: limit * 2,
          includeCompleted
        });

        // Apply filters
        let filtered = sqliteResults;
        if (priority) {
          filtered = filtered.filter(m => m.priority === priority);
        }
        if (tag) {
          filtered = filtered.filter(m => m.tags && m.tags.some(t =>
            t.toLowerCase() === tag.toLowerCase()
          ));
        }

        // Apply priority boost
        filtered = this._applyBoosts(filtered);

        rankedLists.push({
          results: filtered.slice(0, limit),
          weight: this.config.weights.sqlite
        });
      } catch (e) {
        console.error('[QueryFusion] SQLite search error:', e.message);
      }
    }

    // 2. Chroma Semantic Search
    if (useSemantic && query && this.chroma) {
      try {
        // Build where filter for Chroma
        const whereFilter = this._buildChromaFilter({ priority, includeCompleted });

        const chromaResults = await this.chroma.searchMemories(query, {
          limit: limit * 2,
          threshold: this.config.thresholds.chroma,
          whereFilter
        });

        // Tag filter (post-hoc since Chroma may not have tags in metadata)
        let filtered = chromaResults;
        if (tag) {
          // Need to cross-reference with SQLite for tag filtering
          filtered = await this._filterByTag(chromaResults, tag);
        }

        // Convert Chroma results to common format
        const formattedResults = filtered.map(r => ({
          id: r.id,
          content: r.document,
          relevanceScore: r.score,
          ...r.metadata
        }));

        // Apply boosts
        const boosted = this._applyBoosts(formattedResults);

        rankedLists.push({
          results: boosted.slice(0, limit),
          weight: this.config.weights.chroma
        });
      } catch (e) {
        console.error('[QueryFusion] Chroma search error:', e.message);
      }
    }

    // 3. If no search sources, fall back to listing
    if (rankedLists.length === 0) {
      if (this.sqlite) {
        const listed = this.sqlite.listMemories({
          priority,
          status: includeCompleted ? 'all' : 'active',
          tag,
          limit
        });
        return listed.map(m => ({ ...m, fusionScore: 1.0 }));
      }
      return [];
    }

    // 4. Fuse results using RRF
    const fused = this.rrfusion.fuse(rankedLists);

    // 5. Enrich with full data from SQLite
    const enriched = await this._enrichMemories(fused.slice(0, limit));

    return enriched;
  }

  /**
   * Hybrid search for projects
   */
  async searchProjects(query, options = {}) {
    const {
      limit = 10,
      status = 'active',
      useSemantic = true
    } = options;

    const rankedLists = [];

    // Chroma semantic search
    if (useSemantic && query && this.chroma) {
      try {
        const chromaResults = await this.chroma.searchProjects(query, {
          limit: limit * 2,
          threshold: this.config.thresholds.chroma
        });

        const formattedResults = chromaResults.map(r => ({
          id: r.id,
          name: r.metadata?.name,
          relevanceScore: r.score,
          ...r.metadata
        }));

        rankedLists.push({
          results: formattedResults,
          weight: this.config.weights.chroma
        });
      } catch (e) {
        console.error('[QueryFusion] Chroma project search error:', e.message);
      }
    }

    // SQLite listing (always include for full data)
    if (this.sqlite) {
      const listed = this.sqlite.listProjects({ status, limit: limit * 2 });

      // Filter by query if provided
      let filtered = listed;
      if (query) {
        const queryLower = query.toLowerCase();
        filtered = listed.filter(p =>
          p.name.toLowerCase().includes(queryLower) ||
          (p.description && p.description.toLowerCase().includes(queryLower))
        );
      }

      rankedLists.push({
        results: filtered,
        weight: this.config.weights.sqlite
      });
    }

    if (rankedLists.length === 0) {
      return [];
    }

    // Fuse and return
    const fused = this.rrfusion.fuse(rankedLists);
    const enriched = await this._enrichProjects(fused.slice(0, limit));

    return enriched;
  }

  /**
   * Find similar memories using both engines
   */
  async findSimilarMemories(memoryId, limit = 5) {
    const rankedLists = [];

    // Chroma semantic similarity
    if (this.chroma) {
      try {
        const chromaResults = await this.chroma.findSimilarMemories(memoryId, limit * 2);
        rankedLists.push({
          results: chromaResults.map(r => ({ id: r.id, score: r.score })),
          weight: this.config.weights.chroma
        });
      } catch (e) {
        console.error('[QueryFusion] Chroma similar error:', e.message);
      }
    }

    // SQLite text similarity (if memory content available)
    if (this.sqlite) {
      const memory = this.sqlite.getMemory(memoryId);
      if (memory) {
        try {
          const ftsResults = this.sqlite.searchMemoriesFTS(memory.content, {
            limit: limit * 2
          }).filter(m => m.id !== memoryId);

          rankedLists.push({
            results: ftsResults,
            weight: this.config.weights.sqlite
          });
        } catch (e) {
          // FTS might fail for some content
        }
      }
    }

    if (rankedLists.length === 0) {
      return [];
    }

    const fused = this.rrfusion.fuse(rankedLists);
    const enriched = await this._enrichMemories(fused.slice(0, limit));

    return enriched;
  }

  /**
   * Universal search across memories and projects
   */
  async searchAll(query, options = {}) {
    const { memoryLimit = 15, projectLimit = 5 } = options;

    const [memories, projects] = await Promise.all([
      this.searchMemories(query, { ...options, limit: memoryLimit }),
      this.searchProjects(query, { ...options, limit: projectLimit })
    ]);

    return { memories, projects };
  }

  // ==================== INTERNAL HELPERS ====================

  /**
   * Apply boost factors to results
   */
  _applyBoosts(results) {
    const now = Date.now();

    return results.map(r => {
      let boost = 1.0;

      // Priority boost
      if (r.priority && this.config.boosts.priority[r.priority]) {
        boost *= this.config.boosts.priority[r.priority];
      }

      // Recency boost (for items created in last 7 days)
      if (r.created) {
        const ageInDays = (now - new Date(r.created).getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays < 7) {
          boost *= 1 + (this.config.boosts.recency * (7 - ageInDays));
        }
      }

      return {
        ...r,
        _boost: boost,
        relevanceScore: (r.relevanceScore || 1) * boost
      };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Build Chroma where filter
   */
  _buildChromaFilter(options) {
    const { priority, includeCompleted } = options;
    const conditions = {};

    if (priority) {
      conditions.priority = priority;
    }

    if (!includeCompleted) {
      conditions.status = 'active';
    }

    return Object.keys(conditions).length > 0 ? conditions : null;
  }

  /**
   * Filter results by tag (cross-reference with SQLite)
   */
  async _filterByTag(results, tag) {
    if (!this.sqlite || !tag) return results;

    const tagLower = tag.toLowerCase();
    const filtered = [];

    for (const result of results) {
      const memory = this.sqlite.getMemory(result.id);
      if (memory && memory.tags && memory.tags.some(t => t.toLowerCase() === tagLower)) {
        filtered.push(result);
      }
    }

    return filtered;
  }

  /**
   * Enrich fused memory results with full data from SQLite
   */
  async _enrichMemories(fusedResults) {
    if (!this.sqlite) {
      return fusedResults.map(r => ({
        ...r.item,
        fusionScore: r.score,
        fusionSources: r.sources
      }));
    }

    const enriched = [];

    for (const { item, score, sources } of fusedResults) {
      const fullMemory = this.sqlite.getMemory(item.id);
      if (fullMemory) {
        enriched.push({
          ...fullMemory,
          relevanceScore: item.relevanceScore,
          fusionScore: score,
          fusionSources: sources
        });
      } else {
        // Memory exists in Chroma but not SQLite (shouldn't happen normally)
        enriched.push({
          ...item,
          fusionScore: score,
          fusionSources: sources
        });
      }
    }

    return enriched;
  }

  /**
   * Enrich fused project results with full data from SQLite
   */
  async _enrichProjects(fusedResults) {
    if (!this.sqlite) {
      return fusedResults.map(r => ({
        ...r.item,
        fusionScore: r.score
      }));
    }

    const enriched = [];

    for (const { item, score, sources } of fusedResults) {
      const fullProject = this.sqlite.getProject(item.id);
      if (fullProject) {
        enriched.push({
          ...fullProject,
          fusionScore: score,
          fusionSources: sources
        });
      } else {
        enriched.push({
          ...item,
          fusionScore: score,
          fusionSources: sources
        });
      }
    }

    return enriched;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.rrfusion = new RRFusion(this.config.rrfK);
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Get search statistics
   */
  getStats() {
    return {
      rrfK: this.config.rrfK,
      weights: { ...this.config.weights },
      thresholds: { ...this.config.thresholds },
      sqliteAvailable: !!this.sqlite,
      chromaAvailable: !!this.chroma
    };
  }
}

/**
 * Result Merger utility
 * For cases where we need to merge results without full RRF
 */
class ResultMerger {
  /**
   * Deduplicate results by ID, keeping highest score
   */
  static deduplicate(results) {
    const seen = new Map();

    for (const result of results) {
      const existing = seen.get(result.id);
      if (!existing || (result.score || 0) > (existing.score || 0)) {
        seen.set(result.id, result);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Interleave results from multiple sources
   */
  static interleave(...resultArrays) {
    const merged = [];
    const maxLen = Math.max(...resultArrays.map(a => a.length));

    for (let i = 0; i < maxLen; i++) {
      for (const arr of resultArrays) {
        if (i < arr.length) {
          merged.push(arr[i]);
        }
      }
    }

    return this.deduplicate(merged);
  }

  /**
   * Score-weighted merge
   */
  static scoreWeightedMerge(results, weights) {
    const scoreMap = new Map();

    for (let i = 0; i < results.length; i++) {
      const weight = weights[i] || 1.0;

      for (const result of results[i]) {
        const existing = scoreMap.get(result.id);
        const weightedScore = (result.score || 1.0) * weight;

        if (existing) {
          existing.score += weightedScore;
          existing.count++;
        } else {
          scoreMap.set(result.id, {
            ...result,
            score: weightedScore,
            count: 1
          });
        }
      }
    }

    return Array.from(scoreMap.values())
      .map(r => ({ ...r, score: r.score / r.count })) // Average
      .sort((a, b) => b.score - a.score);
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create query fusion instance
 */
function getQueryFusion(sqliteEngine = null, chromaEngine = null, config = null) {
  if (!instance || config) {
    instance = new QueryFusion(sqliteEngine, chromaEngine, config);
  } else {
    if (sqliteEngine) instance.sqlite = sqliteEngine;
    if (chromaEngine) instance.chroma = chromaEngine;
  }
  return instance;
}

module.exports = {
  QueryFusion,
  RRFusion,
  ResultMerger,
  getQueryFusion,
  DEFAULT_CONFIG
};
