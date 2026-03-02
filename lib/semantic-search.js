/**
 * Local Semantic Search Engine
 * TF-IDF based semantic similarity without external dependencies
 *
 * Features:
 * - Term Frequency-Inverse Document Frequency (TF-IDF)
 * - Cosine similarity for document matching
 * - Automatic index building and caching
 * - Fuzzy matching for typos
 * - Synonym expansion (basic)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Common English stop words to filter out
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'the', 'this', 'but', 'they', 'have', 'had', 'what', 'when',
  'where', 'who', 'which', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'can', 'should', 'now', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'do', 'does', 'did', 'done', 'been', 'being'
]);

// Basic synonym groups for expansion
const SYNONYMS = {
  // Programming
  'code': ['programming', 'coding', 'development', 'software'],
  'bug': ['error', 'issue', 'problem', 'defect', 'fault'],
  'fix': ['repair', 'resolve', 'patch', 'correct', 'solve'],
  'api': ['endpoint', 'interface', 'service'],
  'auth': ['authentication', 'login', 'oauth', 'authorization'],

  // Tasks
  'pr': ['pull request', 'merge request'],
  'task': ['todo', 'item', 'work', 'job'],
  'bounty': ['reward', 'payment', 'prize'],
  'review': ['check', 'examine', 'inspect'],

  // Status
  'pending': ['waiting', 'queued', 'upcoming'],
  'done': ['completed', 'finished', 'resolved'],
  'urgent': ['critical', 'important', 'priority'],

  // Actions
  'create': ['make', 'build', 'generate', 'add'],
  'delete': ['remove', 'drop', 'destroy'],
  'update': ['modify', 'change', 'edit', 'alter']
};

// Build reverse synonym map
const SYNONYM_MAP = {};
for (const [key, values] of Object.entries(SYNONYMS)) {
  SYNONYM_MAP[key] = values;
  for (const val of values) {
    if (!SYNONYM_MAP[val]) SYNONYM_MAP[val] = [];
    SYNONYM_MAP[val].push(key);
    // Add other synonyms in the group
    for (const other of values) {
      if (other !== val && !SYNONYM_MAP[val].includes(other)) {
        SYNONYM_MAP[val].push(other);
      }
    }
  }
}

/**
 * Tokenize text into terms
 */
function tokenize(text) {
  if (!text) return [];

  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')  // Remove punctuation except hyphens
    .replace(/\s+/g, ' ')        // Normalize whitespace
    .trim()
    .split(' ')
    .filter(term => term.length > 1 && !STOP_WORDS.has(term));
}

/**
 * Expand terms with synonyms
 */
function expandTerms(terms) {
  const expanded = new Set(terms);

  for (const term of terms) {
    const synonyms = SYNONYM_MAP[term];
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn);
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Simple stemmer (suffix stripping)
 */
function stem(word) {
  // Very basic stemming - just handles common suffixes
  if (word.length < 4) return word;

  const suffixes = ['ing', 'ed', 'er', 'est', 'ly', 's', 'es', 'tion', 'ment'];

  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      return word.slice(0, -suffix.length);
    }
  }

  return word;
}

/**
 * Process text for indexing
 */
function processText(text) {
  const tokens = tokenize(text);
  const stemmed = tokens.map(stem);
  return stemmed;
}

/**
 * Semantic Search Index
 */
class SemanticIndex {
  constructor(indexPath = null) {
    this.documents = new Map();  // id -> { text, tokens, vector }
    this.idf = new Map();        // term -> idf score
    this.termDocs = new Map();   // term -> Set of doc ids
    this.indexPath = indexPath;

    if (indexPath && fs.existsSync(indexPath)) {
      this.load();
    }
  }

  /**
   * Add a document to the index
   */
  addDocument(id, text, metadata = {}) {
    const tokens = processText(text);
    const termFreq = new Map();

    // Calculate term frequency
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Normalize term frequency
    const maxFreq = Math.max(...termFreq.values(), 1);
    for (const [term, freq] of termFreq) {
      termFreq.set(term, freq / maxFreq);
    }

    // Track which documents contain each term
    for (const token of new Set(tokens)) {
      if (!this.termDocs.has(token)) {
        this.termDocs.set(token, new Set());
      }
      this.termDocs.get(token).add(id);
    }

    this.documents.set(id, {
      text,
      tokens,
      termFreq,
      metadata,
      vector: null  // Computed lazily after all docs added
    });

    // Invalidate IDF cache
    this.idf.clear();
  }

  /**
   * Remove a document from the index
   */
  removeDocument(id) {
    const doc = this.documents.get(id);
    if (!doc) return false;

    // Remove from term tracking
    for (const token of new Set(doc.tokens)) {
      const docs = this.termDocs.get(token);
      if (docs) {
        docs.delete(id);
        if (docs.size === 0) {
          this.termDocs.delete(token);
        }
      }
    }

    this.documents.delete(id);
    this.idf.clear();  // Invalidate IDF cache
    return true;
  }

  /**
   * Update IDF values for all terms
   */
  updateIDF() {
    const N = this.documents.size;
    if (N === 0) return;

    for (const [term, docs] of this.termDocs) {
      // IDF = log(N / (1 + df)) where df = document frequency
      this.idf.set(term, Math.log(N / (1 + docs.size)));
    }
  }

  /**
   * Compute TF-IDF vector for a document
   */
  computeVector(doc) {
    if (this.idf.size === 0) {
      this.updateIDF();
    }

    const vector = new Map();

    for (const [term, tf] of doc.termFreq) {
      const idf = this.idf.get(term) || 0;
      vector.set(term, tf * idf);
    }

    return vector;
  }

  /**
   * Compute TF-IDF vector for a query
   */
  computeQueryVector(queryText, expandSynonyms = true) {
    let tokens = processText(queryText);

    if (expandSynonyms) {
      tokens = expandTerms(tokens);
    }

    const termFreq = new Map();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Normalize
    const maxFreq = Math.max(...termFreq.values(), 1);
    for (const [term, freq] of termFreq) {
      termFreq.set(term, freq / maxFreq);
    }

    // Apply IDF
    if (this.idf.size === 0) {
      this.updateIDF();
    }

    const vector = new Map();
    for (const [term, tf] of termFreq) {
      const idf = this.idf.get(term) || 0.1;  // Small non-zero for unseen terms
      vector.set(term, tf * idf);
    }

    return vector;
  }

  /**
   * Cosine similarity between two vectors
   */
  cosineSimilarity(vec1, vec2) {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    // Get all unique terms
    const allTerms = new Set([...vec1.keys(), ...vec2.keys()]);

    for (const term of allTerms) {
      const v1 = vec1.get(term) || 0;
      const v2 = vec2.get(term) || 0;

      dotProduct += v1 * v2;
      norm1 += v1 * v1;
      norm2 += v2 * v2;
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) return 0;

    return dotProduct / (norm1 * norm2);
  }

  /**
   * Search for similar documents
   */
  search(query, options = {}) {
    const {
      limit = 10,
      threshold = 0.1,
      expandSynonyms = true,
      boostRecent = false,
      recentDays = 7
    } = options;

    if (this.documents.size === 0) {
      return [];
    }

    // Compute query vector
    const queryVector = this.computeQueryVector(query, expandSynonyms);

    // Score all documents
    const results = [];

    for (const [id, doc] of this.documents) {
      // Compute or retrieve document vector
      if (!doc.vector) {
        doc.vector = this.computeVector(doc);
      }

      let score = this.cosineSimilarity(queryVector, doc.vector);

      // Boost recent documents
      if (boostRecent && doc.metadata.created) {
        const age = (Date.now() - new Date(doc.metadata.created).getTime()) / (1000 * 60 * 60 * 24);
        if (age < recentDays) {
          score *= 1 + (1 - age / recentDays) * 0.5;  // Up to 50% boost
        }
      }

      if (score >= threshold) {
        results.push({
          id,
          score,
          text: doc.text,
          metadata: doc.metadata
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * Find similar documents to a given document
   */
  findSimilar(docId, limit = 5) {
    const doc = this.documents.get(docId);
    if (!doc) return [];

    return this.search(doc.text, { limit: limit + 1 })
      .filter(r => r.id !== docId)
      .slice(0, limit);
  }

  /**
   * Save index to disk
   */
  save() {
    if (!this.indexPath) return false;

    const data = {
      documents: [],
      version: 1,
      savedAt: new Date().toISOString()
    };

    for (const [id, doc] of this.documents) {
      data.documents.push({
        id,
        text: doc.text,
        metadata: doc.metadata
      });
    }

    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      console.error('Failed to save semantic index:', e.message);
      return false;
    }
  }

  /**
   * Load index from disk
   */
  load() {
    if (!this.indexPath || !fs.existsSync(this.indexPath)) {
      return false;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));

      for (const doc of data.documents) {
        this.addDocument(doc.id, doc.text, doc.metadata);
      }

      return true;
    } catch (e) {
      console.error('Failed to load semantic index:', e.message);
      return false;
    }
  }

  /**
   * Get index statistics
   */
  getStats() {
    return {
      documentCount: this.documents.size,
      uniqueTerms: this.termDocs.size,
      avgDocLength: this.documents.size > 0
        ? Array.from(this.documents.values())
            .reduce((sum, doc) => sum + doc.tokens.length, 0) / this.documents.size
        : 0
    };
  }
}

module.exports = {
  SemanticIndex,
  tokenize,
  processText,
  expandTerms,
  STOP_WORDS,
  SYNONYMS
};
