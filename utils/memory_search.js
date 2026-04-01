'use strict';
/**
 * memory_search.js — BM25-style exact-match search layer for the memory system.
 *
 * The MCP recall() function is pure semantic (vector search). It misses:
 *   - PIDs, port numbers, IPs
 *   - Exact ticker symbols and strategy names
 *   - File paths, error codes
 *   - Anything that needs exact-token lookup
 *
 * This module provides the complementary exact-search layer.
 * Use alongside recall() for full coverage:
 *   1. recall("keywords") — semantic, finds conceptually related memories
 *   2. searchMemory("192.168.137.2") — exact, finds specific IPs/tickers/PIDs
 *
 * USAGE:
 *   const { searchMemory, searchMemoryRegex } = require('./utils/memory_search');
 *   const results = await searchMemory('192.168.137.2');
 *   const results = await searchMemoryRegex(/PID\s+\d+/gi);
 *
 * Returns array of MatchResult objects:
 *   { file, lineNumber, line, context: [before3lines..., match, after3lines...] }
 */

const fs = require('fs');
const path = require('path');

// Default memory directory — Claude's project memory for teleclaude-main
const DEFAULT_MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
  'C--Users-Footb-Documents-Github-teleclaude-main',
  'memory'
);

// Also search the MEMORY.md that is always in context (same location)
const CONTEXT_FILES = [
  path.join(DEFAULT_MEMORY_DIR, 'MEMORY.md'),
  path.join(DEFAULT_MEMORY_DIR, 'lvl3quant.md'),
  path.join(DEFAULT_MEMORY_DIR, 'infrastructure.md'),
  path.join(DEFAULT_MEMORY_DIR, 'teleclaude.md'),
  path.join(DEFAULT_MEMORY_DIR, 'strategy_results.md'),
  path.join(DEFAULT_MEMORY_DIR, 'compute_status.md'),
];

/**
 * @typedef {Object} MatchResult
 * @property {string} file - Relative file name (e.g. "infrastructure.md")
 * @property {number} lineNumber - 1-indexed line number of the match
 * @property {string} line - The exact matching line (trimmed)
 * @property {string[]} context - Up to 7 lines: 3 before + match + 3 after
 * @property {string} matchType - "substring" | "regex"
 */

/**
 * Read a file safely, returning [] on error.
 * @param {string} filePath
 * @returns {string[]} lines
 */
function readLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n');
  } catch (e) {
    return [];
  }
}

/**
 * Build context window around a match.
 * @param {string[]} lines - All lines in the file
 * @param {number} idx - 0-indexed match line
 * @param {number} contextSize - lines before/after (default 3)
 * @returns {string[]}
 */
function buildContext(lines, idx, contextSize = 3) {
  const start = Math.max(0, idx - contextSize);
  const end = Math.min(lines.length - 1, idx + contextSize);
  const result = [];
  for (let i = start; i <= end; i++) {
    const prefix = i === idx ? '>>> ' : '    ';
    result.push(`${prefix}L${i + 1}: ${lines[i]}`);
  }
  return result;
}

/**
 * Get all .md files in the memory directory.
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function getMemoryFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && entry.name === 'sessions') {
        // Also search daily session logs
        try {
          const sessionEntries = fs.readdirSync(path.join(dir, 'sessions'), { withFileTypes: true });
          for (const se of sessionEntries) {
            if (se.isFile() && se.name.endsWith('.md')) {
              files.push(path.join(dir, 'sessions', se.name));
            }
          }
        } catch (e) {
          // sessions dir may not exist yet
        }
      }
    }
    return files;
  } catch (e) {
    // Fallback: return the known context files
    return CONTEXT_FILES.filter(f => {
      try { fs.accessSync(f); return true; } catch (e2) { return false; }
    });
  }
}

/**
 * Exact substring search across all memory .md files.
 *
 * @param {string} query - Plain text substring to search for (case-insensitive by default)
 * @param {Object} [opts]
 * @param {boolean} [opts.caseSensitive=false] - Case-sensitive match
 * @param {number} [opts.contextLines=3] - Lines of context before/after match
 * @param {string} [opts.memoryDir] - Override memory directory path
 * @returns {MatchResult[]}
 */
function searchMemory(query, opts = {}) {
  const {
    caseSensitive = false,
    contextLines = 3,
    memoryDir = DEFAULT_MEMORY_DIR,
  } = opts;

  if (!query || query.trim() === '') return [];

  const searchStr = caseSensitive ? query : query.toLowerCase();
  const files = getMemoryFiles(memoryDir);
  const results = [];

  for (const filePath of files) {
    const lines = readLines(filePath);
    const fileName = path.relative(memoryDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      const lineToSearch = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (lineToSearch.includes(searchStr)) {
        results.push({
          file: fileName,
          lineNumber: i + 1,
          line: lines[i].trim(),
          context: buildContext(lines, i, contextLines),
          matchType: 'substring',
        });
      }
    }
  }

  return results;
}

/**
 * Regex search across all memory .md files.
 *
 * @param {RegExp} pattern - Regex pattern (use /gi flags for global case-insensitive)
 * @param {Object} [opts]
 * @param {number} [opts.contextLines=3] - Lines of context before/after match
 * @param {string} [opts.memoryDir] - Override memory directory path
 * @returns {MatchResult[]}
 */
function searchMemoryRegex(pattern, opts = {}) {
  const {
    contextLines = 3,
    memoryDir = DEFAULT_MEMORY_DIR,
  } = opts;

  if (!(pattern instanceof RegExp)) {
    throw new TypeError('pattern must be a RegExp');
  }

  const files = getMemoryFiles(memoryDir);
  const results = [];

  for (const filePath of files) {
    const lines = readLines(filePath);
    const fileName = path.relative(memoryDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        results.push({
          file: fileName,
          lineNumber: i + 1,
          line: lines[i].trim(),
          context: buildContext(lines, i, contextLines),
          matchType: 'regex',
        });
      }
    }
  }

  return results;
}

/**
 * Format results for Discord/terminal display.
 * @param {MatchResult[]} results
 * @param {string} query - Original query for display
 * @returns {string}
 */
function formatResults(results, query) {
  if (results.length === 0) {
    return `No matches found for: "${query}"`;
  }

  const lines = [`**Memory Search: "${query}"** — ${results.length} match(es)\n`];
  for (const r of results) {
    lines.push(`**${r.file}:${r.lineNumber}**`);
    lines.push('```');
    lines.push(...r.context);
    lines.push('```');
  }
  return lines.join('\n');
}

// ─── Enhanced Cross-Layer Search ────────────────────────────────────────────

/**
 * Parse a structured query string.
 * Supports: "node:neptune type:training_crash last:7d some text"
 *
 * @param {string} queryStr
 * @returns {{ text: string, filters: Object }}
 */
function parseStructuredQuery(queryStr) {
  const filters = {};
  const textParts = [];

  const tokens = queryStr.split(/\s+/);
  for (const token of tokens) {
    const colonIdx = token.indexOf(':');
    if (colonIdx > 0 && colonIdx < token.length - 1) {
      const key = token.slice(0, colonIdx).toLowerCase();
      const value = token.slice(colonIdx + 1);

      switch (key) {
        case 'node':
          filters.node = value.toLowerCase();
          break;
        case 'type':
          filters.event_type = value;
          break;
        case 'category':
        case 'cat':
          filters.category = value;
          break;
        case 'outcome':
          filters.outcome = value;
          break;
        case 'last': {
          // Parse duration: 7d, 24h, 2w
          const match = value.match(/^(\d+)([dhw])$/);
          if (match) {
            const num = parseInt(match[1]);
            const unit = match[2];
            if (unit === 'd') filters.last_days = num;
            else if (unit === 'h') filters.last_days = num / 24;
            else if (unit === 'w') filters.last_days = num * 7;
          }
          break;
        }
        case 'confidence':
        case 'conf':
          filters.minConfidence = parseFloat(value);
          break;
        case 'tag':
          if (!filters.tags) filters.tags = [];
          filters.tags.push(value);
          break;
        default:
          textParts.push(token);
      }
    } else {
      textParts.push(token);
    }
  }

  return { text: textParts.join(' '), filters };
}

/**
 * Search across ALL memory layers: markdown files, episodic memory, and semantic memory.
 * Returns unified results with source indicators and weighted scoring.
 *
 * @param {string} queryStr - Plain text or structured query (e.g., "node:neptune type:training_crash CNN")
 * @param {Object} [opts]
 * @param {boolean} [opts.caseSensitive=false]
 * @param {number} [opts.contextLines=3]
 * @param {string} [opts.memoryDir]
 * @param {number} [opts.limit=50] - Max results per layer
 * @returns {{ markdown: MatchResult[], episodic: Object[], semantic: Object[], total: number }}
 */
function searchAll(queryStr, opts = {}) {
  const {
    caseSensitive = false,
    contextLines = 3,
    memoryDir = DEFAULT_MEMORY_DIR,
    limit = 50,
  } = opts;

  if (!queryStr || queryStr.trim() === '') {
    return { markdown: [], episodic: [], semantic: [], total: 0 };
  }

  const { text, filters } = parseStructuredQuery(queryStr);

  // Layer 1: Markdown files (existing BM25)
  const markdownResults = text
    ? searchMemory(text, { caseSensitive, contextLines, memoryDir }).slice(0, limit)
    : [];

  // Layer 2: Episodic memory
  let episodicResults = [];
  try {
    const episodic = require('./episodic_memory');
    const epQuery = {
      text: text || undefined,
      last_days: filters.last_days || 14,
      limit,
    };
    if (filters.event_type) epQuery.event_type = filters.event_type;
    if (filters.node) epQuery.node = filters.node;
    if (filters.outcome) epQuery.outcome = filters.outcome;
    if (filters.tags) epQuery.tags = filters.tags;

    episodicResults = episodic.query(epQuery);
  } catch (e) {
    // Episodic memory module not available or failed
  }

  // Layer 3: Semantic memory
  let semanticResults = [];
  try {
    const semantic = require('./semantic_memory');
    const semQuery = { text: text || undefined, limit };
    if (filters.category) semQuery.category = filters.category;
    if (filters.minConfidence) semQuery.minConfidence = filters.minConfidence;
    if (filters.tags) semQuery.tags = filters.tags;

    semanticResults = semantic.query(semQuery);
  } catch (e) {
    // Semantic memory module not available or failed
  }

  return {
    markdown: markdownResults,
    episodic: episodicResults,
    semantic: semanticResults,
    total: markdownResults.length + episodicResults.length + semanticResults.length,
  };
}

/**
 * Format unified search results for display.
 *
 * @param {Object} results - Output from searchAll()
 * @param {string} query
 * @returns {string}
 */
function formatAllResults(results, query) {
  if (results.total === 0) {
    return `No matches found across any memory layer for: "${query}"`;
  }

  const lines = [
    `**Unified Memory Search: "${query}"** — ${results.total} total match(es)`,
    '',
  ];

  if (results.semantic.length > 0) {
    lines.push(`### Semantic Facts (${results.semantic.length})`);
    for (const f of results.semantic.slice(0, 10)) {
      const conf = `${Math.round(f.confidence * 100)}%`;
      const tagStr = f.tags && f.tags.length > 0 ? ` {${f.tags.join(', ')}}` : '';
      lines.push(`- **[${f.category}]** (${conf}) ${f.content}${tagStr}`);
    }
    lines.push('');
  }

  if (results.episodic.length > 0) {
    lines.push(`### Episodes (${results.episodic.length})`);
    for (const ep of results.episodic.slice(0, 10)) {
      const ts = ep.timestamp ? ep.timestamp.slice(0, 16).replace('T', ' ') : '?';
      const nodeStr = ep.node ? ` [${ep.node}]` : '';
      lines.push(`- **${ts}** \`${ep.event_type}\`${nodeStr} — ${ep.description}`);
    }
    lines.push('');
  }

  if (results.markdown.length > 0) {
    lines.push(`### Markdown Files (${results.markdown.length})`);
    for (const r of results.markdown.slice(0, 10)) {
      lines.push(`- **${r.file}:${r.lineNumber}** — ${r.line.slice(0, 120)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Quick lookup helper — searches for a term and prints formatted results to stdout.
 * Useful when running this file directly: node utils/memory_search.js "192.168.137.2"
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node utils/memory_search.js <search-term> [--case-sensitive]');
    console.log('       node utils/memory_search.js --regex "<pattern>"');
    console.log('       node utils/memory_search.js --all "<structured query>"');
    console.log('');
    console.log('Structured query syntax:');
    console.log('  node:neptune type:training_crash last:7d CNN model');
    console.log('  category:model_result confidence:0.8 wider CNN');
    console.log('  tag:cnn last:14d');
    process.exit(0);
  }

  if (args[0] === '--all') {
    const query = args.slice(1).join(' ');
    const results = searchAll(query);
    console.log(formatAllResults(results, query));
  } else if (args[0] === '--regex' && args[1]) {
    const pattern = new RegExp(args[1], 'gi');
    const results = searchMemoryRegex(pattern);
    console.log(formatResults(results, args[1]));
  } else {
    const caseSensitive = args.includes('--case-sensitive');
    const query = args.filter(a => !a.startsWith('--')).join(' ');
    const results = searchMemory(query, { caseSensitive });
    console.log(formatResults(results, query));
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  searchMemory,
  searchMemoryRegex,
  searchAll,
  parseStructuredQuery,
  formatResults,
  formatAllResults,
  getMemoryFiles,
  DEFAULT_MEMORY_DIR,
};
