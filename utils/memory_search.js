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
 *   2. searchMemory("YOUR_JUPITER_LAN_IP") — exact, finds specific IPs/tickers/PIDs
 *
 * USAGE:
 *   const { searchMemory, searchMemoryRegex } = require('./utils/memory_search');
 *   const results = await searchMemory('YOUR_JUPITER_LAN_IP');
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
  'C--Users-YOUR_USERNAME-Documents-Github-teleclaude-main',
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

/**
 * Quick lookup helper — searches for a term and prints formatted results to stdout.
 * Useful when running this file directly: node utils/memory_search.js "YOUR_JUPITER_LAN_IP"
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node utils/memory_search.js <search-term> [--case-sensitive]');
    console.log('       node utils/memory_search.js --regex "<pattern>"');
    process.exit(0);
  }

  let results;
  if (args[0] === '--regex' && args[1]) {
    const pattern = new RegExp(args[1], 'gi');
    results = searchMemoryRegex(pattern);
    console.log(formatResults(results, args[1]));
  } else {
    const caseSensitive = args.includes('--case-sensitive');
    const query = args.filter(a => !a.startsWith('--')).join(' ');
    results = searchMemory(query, { caseSensitive });
    console.log(formatResults(results, query));
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  searchMemory,
  searchMemoryRegex,
  formatResults,
  getMemoryFiles,
  DEFAULT_MEMORY_DIR,
};
