'use strict';
/**
 * semantic_memory.js — Semantic memory layer for the teleclaude bridge.
 *
 * Stores FACTS: things that are true, rules, configurations, relationships.
 * Unlike episodic memory (events in time), semantic memory is atemporal —
 * it represents the current state of knowledge.
 *
 * Key feature: facts can SUPERSEDE older facts, providing clean contradiction
 * resolution. When a new fact supersedes an old one, the old fact is marked
 * as superseded but kept for audit trail.
 *
 * Storage: memory/semantic/ as categorized JSON files (one per category).
 *
 * USAGE:
 *   const sm = require('./utils/semantic_memory');
 *   sm.store({
 *     category: 'model_result',
 *     content: 'BookSpatialCNN wider achieves IC=0.261 on 10s horizon',
 *     confidence: 0.95,
 *     source: 'WF fold 167 complete run',
 *     tags: ['cnn', 'wider', '10s']
 *   });
 *
 *   const facts = sm.query({ category: 'model_result', text: 'CNN IC' });
 *   const nodeConfig = sm.getByCategory('node_config');
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
  'C--Users-Footb-Documents-Github-teleclaude-main',
  'memory'
);

const SEMANTIC_DIR = path.join(MEMORY_DIR, 'semantic');

/** Valid categories */
const CATEGORIES = [
  'node_config',       // Compute node configurations, IPs, paths
  'model_result',      // Training results, IC scores, Sharpe ratios
  'strategy_rule',     // Trading rules, thresholds, card configs
  'infrastructure',    // System setup, ports, services, dependencies
  'research_finding',  // Discoveries, hypotheses, analysis conclusions
  'operational_rule',  // Process rules (never do X, always do Y)
  'credential',        // Account references (no secrets — just "uses account X")
  'project_status',    // Current state of active projects
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateId() {
  return 'sf-' + crypto.randomBytes(6).toString('hex');
}

function getCategoryFilePath(category) {
  return path.join(SEMANTIC_DIR, `${category}.json`);
}

/**
 * Read all facts from a category file.
 * @param {string} category
 * @returns {Object[]}
 */
function readCategoryFile(category) {
  const filePath = getCategoryFilePath(category);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

/**
 * Write all facts to a category file (atomic write via rename).
 * @param {string} category
 * @param {Object[]} facts
 */
function writeCategoryFile(category, facts) {
  ensureDir(SEMANTIC_DIR);
  const filePath = getCategoryFilePath(category);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(facts, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Simple BM25-ish scoring for text relevance.
 * @param {string} query - Search query (lowercased)
 * @param {string} text - Text to score against (lowercased)
 * @returns {number} Score (0 = no match)
 */
function textScore(query, text) {
  if (!query || !text) return 0;
  const queryTokens = query.split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return 0;

  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) {
      // Exact word bonus
      const wordBoundary = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      score += wordBoundary.test(text) ? 2 : 1;
    }
  }

  // Normalize by query length
  return score / queryTokens.length;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Store a new fact in semantic memory.
 *
 * @param {Object} fact
 * @param {string} fact.category - One of CATEGORIES
 * @param {string} fact.content - The fact itself (human-readable)
 * @param {number} [fact.confidence=0.8] - Confidence level 0.0-1.0
 * @param {string} [fact.source] - Where this fact came from
 * @param {string[]} [fact.tags=[]] - Searchable tags
 * @param {string} [fact.supersedes] - ID of the fact this replaces
 * @param {Object} [fact.metadata={}] - Arbitrary structured data
 * @returns {Object} The stored fact (with id, created_at added)
 */
function store(fact) {
  if (!fact || !fact.category || !fact.content) {
    throw new Error('Fact must have category and content');
  }

  if (!CATEGORIES.includes(fact.category)) {
    throw new Error(`Invalid category "${fact.category}". Valid: ${CATEGORIES.join(', ')}`);
  }

  const confidence = typeof fact.confidence === 'number'
    ? Math.max(0, Math.min(1, fact.confidence))
    : 0.8;

  const now = new Date().toISOString();
  const stored = {
    id: generateId(),
    category: fact.category,
    content: fact.content,
    confidence,
    source: fact.source || null,
    tags: Array.isArray(fact.tags) ? fact.tags : [],
    metadata: fact.metadata || {},
    created_at: now,
    updated_at: now,
    supersedes: fact.supersedes || null,
    superseded_by: null,
  };

  // Load existing facts for this category
  const facts = readCategoryFile(fact.category);

  // If this supersedes another fact, mark the old one
  if (stored.supersedes) {
    for (const existing of facts) {
      if (existing.id === stored.supersedes) {
        existing.superseded_by = stored.id;
        existing.updated_at = now;
        break;
      }
    }
  }

  facts.push(stored);
  writeCategoryFile(fact.category, facts);

  return stored;
}

/**
 * Update an existing fact's content or confidence.
 *
 * @param {string} id - Fact ID
 * @param {Object} updates - Fields to update (content, confidence, tags, metadata)
 * @returns {Object|null} Updated fact, or null if not found
 */
function update(id, updates) {
  for (const category of CATEGORIES) {
    const facts = readCategoryFile(category);
    const idx = facts.findIndex(f => f.id === id);
    if (idx >= 0) {
      const fact = facts[idx];
      if (updates.content !== undefined) fact.content = updates.content;
      if (updates.confidence !== undefined) fact.confidence = Math.max(0, Math.min(1, updates.confidence));
      if (updates.tags !== undefined) fact.tags = updates.tags;
      if (updates.metadata !== undefined) fact.metadata = { ...fact.metadata, ...updates.metadata };
      if (updates.source !== undefined) fact.source = updates.source;
      fact.updated_at = new Date().toISOString();
      facts[idx] = fact;
      writeCategoryFile(category, facts);
      return fact;
    }
  }
  return null;
}

/**
 * Store a fact that supersedes an existing one (by content match).
 * Searches for existing facts with similar content and auto-supersedes.
 *
 * @param {Object} fact - Same as store()
 * @param {string} [matchText] - Text to match against existing facts (defaults to first 50 chars of content)
 * @returns {Object} The stored fact
 */
function storeOrUpdate(fact, matchText) {
  const searchText = (matchText || fact.content.slice(0, 50)).toLowerCase();
  const existing = readCategoryFile(fact.category);

  // Find the most relevant active (non-superseded) fact
  let bestMatch = null;
  let bestScore = 0;
  for (const f of existing) {
    if (f.superseded_by) continue; // skip already superseded
    const score = textScore(searchText, f.content.toLowerCase());
    if (score > bestScore && score >= 1.0) {
      bestScore = score;
      bestMatch = f;
    }
  }

  if (bestMatch) {
    fact.supersedes = bestMatch.id;
  }

  return store(fact);
}

/**
 * Get all active (non-superseded) facts for a category.
 *
 * @param {string} category
 * @param {Object} [opts]
 * @param {boolean} [opts.includeSuperseded=false] - Include superseded facts
 * @param {number} [opts.minConfidence=0] - Minimum confidence threshold
 * @returns {Object[]}
 */
function getByCategory(category, opts = {}) {
  const { includeSuperseded = false, minConfidence = 0 } = opts;
  const facts = readCategoryFile(category);

  return facts.filter(f => {
    if (!includeSuperseded && f.superseded_by) return false;
    if (f.confidence < minConfidence) return false;
    return true;
  });
}

/**
 * Query facts across all categories with flexible filters.
 *
 * @param {Object} [filters={}]
 * @param {string} [filters.category] - Filter by category
 * @param {string} [filters.text] - Full-text search in content
 * @param {string[]} [filters.tags] - Filter by tags (any match)
 * @param {number} [filters.minConfidence=0] - Minimum confidence
 * @param {boolean} [filters.includeSuperseded=false] - Include superseded facts
 * @param {number} [filters.limit=50] - Max results
 * @returns {Object[]} Matching facts, sorted by relevance (if text search) or recency
 */
function query(filters = {}) {
  const {
    category,
    text,
    tags,
    minConfidence = 0,
    includeSuperseded = false,
    limit = 50,
  } = filters;

  const categoriesToSearch = category ? [category] : CATEGORIES;
  const textLower = text ? text.toLowerCase() : null;
  const tagsLower = tags ? tags.map(t => t.toLowerCase()) : null;

  const results = [];

  for (const cat of categoriesToSearch) {
    const facts = readCategoryFile(cat);
    for (const f of facts) {
      if (!includeSuperseded && f.superseded_by) continue;
      if (f.confidence < minConfidence) continue;

      if (tagsLower) {
        const fTags = (f.tags || []).map(t => t.toLowerCase());
        const hasAny = tagsLower.some(t => fTags.includes(t));
        if (!hasAny) continue;
      }

      let relevance = 0;
      if (textLower) {
        const contentLower = (f.content || '').toLowerCase();
        const tagText = (f.tags || []).join(' ').toLowerCase();
        const allText = contentLower + ' ' + tagText;
        relevance = textScore(textLower, allText);
        if (relevance === 0) continue;
      }

      results.push({ ...f, _relevance: relevance });
    }
  }

  // Sort: by relevance (desc) if text search, otherwise by updated_at (desc)
  if (textLower) {
    results.sort((a, b) => {
      const relDiff = (b._relevance || 0) - (a._relevance || 0);
      if (relDiff !== 0) return relDiff;
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
  } else {
    results.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  // Clean up internal scoring field
  const cleaned = results.slice(0, limit).map(r => {
    const { _relevance, ...rest } = r;
    return rest;
  });

  return cleaned;
}

/**
 * Get a single fact by ID.
 * @param {string} id
 * @returns {Object|null}
 */
function getById(id) {
  for (const category of CATEGORIES) {
    const facts = readCategoryFile(category);
    const found = facts.find(f => f.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Delete a fact by ID (hard delete).
 * @param {string} id
 * @returns {boolean} True if deleted
 */
function remove(id) {
  for (const category of CATEGORIES) {
    const facts = readCategoryFile(category);
    const idx = facts.findIndex(f => f.id === id);
    if (idx >= 0) {
      facts.splice(idx, 1);
      writeCategoryFile(category, facts);
      return true;
    }
  }
  return false;
}

/**
 * Find contradictions within a category.
 * Two active facts contradict if they have high text overlap but different key values.
 *
 * @param {string} [category] - Check specific category, or all if omitted
 * @returns {{ fact1: Object, fact2: Object, overlap: number }[]}
 */
function findContradictions(category) {
  const categoriesToCheck = category ? [category] : CATEGORIES;
  const contradictions = [];

  for (const cat of categoriesToCheck) {
    const facts = readCategoryFile(cat).filter(f => !f.superseded_by);

    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i];
        const b = facts[j];

        // Check tag overlap
        const aTags = new Set((a.tags || []).map(t => t.toLowerCase()));
        const bTags = new Set((b.tags || []).map(t => t.toLowerCase()));
        let tagOverlap = 0;
        for (const t of aTags) {
          if (bTags.has(t)) tagOverlap++;
        }

        // Check content overlap
        const contentOverlap = textScore(
          a.content.toLowerCase().split(/\s+/).slice(0, 5).join(' '),
          b.content.toLowerCase()
        );

        // High overlap in tags or content but different facts = potential contradiction
        const totalOverlap = tagOverlap + contentOverlap;
        if (totalOverlap >= 2 && a.content !== b.content) {
          contradictions.push({ fact1: a, fact2: b, overlap: totalOverlap });
        }
      }
    }
  }

  // Sort by overlap descending
  contradictions.sort((a, b) => b.overlap - a.overlap);
  return contradictions;
}

/**
 * Get statistics across all semantic memory.
 * @returns {Object}
 */
function getStats() {
  const stats = { total: 0, active: 0, superseded: 0, by_category: {}, by_confidence: {} };

  for (const cat of CATEGORIES) {
    const facts = readCategoryFile(cat);
    const active = facts.filter(f => !f.superseded_by);
    const superseded = facts.length - active.length;

    stats.total += facts.length;
    stats.active += active.length;
    stats.superseded += superseded;
    stats.by_category[cat] = { total: facts.length, active: active.length };
  }

  // Confidence distribution
  const buckets = { high: 0, medium: 0, low: 0 };
  for (const cat of CATEGORIES) {
    for (const f of readCategoryFile(cat)) {
      if (f.superseded_by) continue;
      if (f.confidence >= 0.8) buckets.high++;
      else if (f.confidence >= 0.5) buckets.medium++;
      else buckets.low++;
    }
  }
  stats.by_confidence = buckets;

  return stats;
}

/**
 * Format facts for display (Discord/terminal).
 * @param {Object[]} facts
 * @param {Object} [opts]
 * @param {boolean} [opts.compact=false]
 * @returns {string}
 */
function format(facts, opts = {}) {
  if (facts.length === 0) return '(no facts found)';

  const lines = [];
  for (const f of facts) {
    const conf = `${Math.round(f.confidence * 100)}%`;
    const tagStr = f.tags && f.tags.length > 0 ? ` {${f.tags.join(', ')}}` : '';
    const supersededStr = f.superseded_by ? ' [SUPERSEDED]' : '';

    if (opts.compact) {
      lines.push(`[${f.category}] (${conf}) ${f.content}${tagStr}${supersededStr}`);
    } else {
      lines.push(`**${f.id}** \`${f.category}\` (${conf} confidence)${supersededStr}`);
      lines.push(`  ${f.content}${tagStr}`);
      if (f.source) lines.push(`  source: ${f.source}`);
      lines.push(`  updated: ${f.updated_at}`);
    }
  }

  return lines.join('\n');
}

/**
 * Export all active facts as a flat list (for BM25 indexing).
 * @returns {{ id: string, category: string, content: string, confidence: number, tags: string[], updated_at: string }[]}
 */
function exportAll() {
  const all = [];
  for (const cat of CATEGORIES) {
    const facts = readCategoryFile(cat).filter(f => !f.superseded_by);
    for (const f of facts) {
      all.push({
        id: f.id,
        category: f.category,
        content: f.content,
        confidence: f.confidence,
        tags: f.tags || [],
        updated_at: f.updated_at,
      });
    }
  }
  return all;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'query' || cmd === 'search') {
    const text = args.slice(1).join(' ');
    const results = query({ text });
    console.log(format(results));
  } else if (cmd === 'category') {
    const cat = args[1];
    if (!cat || !CATEGORIES.includes(cat)) {
      console.log('Valid categories:', CATEGORIES.join(', '));
    } else {
      const facts = getByCategory(cat);
      console.log(format(facts));
    }
  } else if (cmd === 'stats') {
    console.log(JSON.stringify(getStats(), null, 2));
  } else if (cmd === 'contradictions') {
    const cat = args[1] || undefined;
    const results = findContradictions(cat);
    if (results.length === 0) {
      console.log('No contradictions found.');
    } else {
      for (const c of results) {
        console.log(`\nPotential contradiction (overlap=${c.overlap.toFixed(1)}):`);
        console.log(`  A: [${c.fact1.id}] ${c.fact1.content}`);
        console.log(`  B: [${c.fact2.id}] ${c.fact2.content}`);
      }
    }
  } else if (cmd === 'store') {
    const cat = args[1];
    const content = args.slice(2).join(' ');
    if (!cat || !content) {
      console.log('Usage: node semantic_memory.js store <category> <content>');
    } else {
      const f = store({ category: cat, content });
      console.log('Stored:', f.id);
    }
  } else {
    console.log('Usage:');
    console.log('  node semantic_memory.js search <text>              — search all facts');
    console.log('  node semantic_memory.js category <name>            — list facts in category');
    console.log('  node semantic_memory.js stats                      — show statistics');
    console.log('  node semantic_memory.js contradictions [category]  — find contradictions');
    console.log('  node semantic_memory.js store <category> <content> — store a new fact');
    console.log('\nCategories:', CATEGORIES.join(', '));
  }
}

module.exports = {
  store,
  storeOrUpdate,
  update,
  getByCategory,
  query,
  getById,
  remove,
  findContradictions,
  getStats,
  format,
  exportAll,
  CATEGORIES,
  SEMANTIC_DIR,
  MEMORY_DIR,
};
