'use strict';
/**
 * memory_dedup.js — Deduplication and contradiction detection for the memory system.
 *
 * Reads all memory .md files and identifies:
 *   1. DUPLICATES — same fact stated in multiple files
 *   2. CONTRADICTIONS — different values for the same key in different files
 *      (e.g., two different IPs for Jupiter, two different PIDs for the same job)
 *
 * Run periodically as maintenance:
 *   node utils/memory_dedup.js
 *   node utils/memory_dedup.js --json  (machine-readable output)
 *
 * USAGE (as module):
 *   const { runDedup } = require('./utils/memory_dedup');
 *   const report = await runDedup();
 *   console.log(report.summary);
 *
 * The report is also useful for the AI bridge to detect stale/conflicting info
 * before making decisions based on memory.
 */

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
  'C--Users-YOUR_USERNAME-Documents-Github-teleclaude-main',
  'memory'
);

// ─── Patterns that extract key facts for contradiction detection ───────────────

/**
 * Each detector has:
 *   label: human-readable name for the fact type
 *   pattern: RegExp with a capture group for the value
 *   normalize: optional function to normalize value before comparing
 */
const FACT_DETECTORS = [
  // Server IPs
  {
    label: 'Jupiter LAN IP',
    pattern: /(?:LAN|192\.168)\s*(?:IP\s*:?\s*|:\s*)(192\.168\.\d+\.\d+)/i,
    normalize: v => v.trim(),
  },
  {
    label: 'Jupiter Tailscale IP',
    pattern: /(?:Tailscale|tailscale)\s*(?:IP\s*:?\s*|:\s*)(100\.\d+\.\d+\.\d+)/i,
    normalize: v => v.trim(),
  },
  // Server credentials
  {
    label: 'Jupiter SSH user',
    pattern: /(?:User|Username|user)\s*:\s*([a-zA-Z][a-zA-Z0-9_-]+)(?:\s|$)/,
    normalize: v => v.toLowerCase().trim(),
  },
  {
    label: 'Jupiter SSH password',
    pattern: /(?:PW|Password|password)\s*:\s*([^\s|,\n]+)/,
    normalize: v => v.trim(),
  },
  // GPU model
  {
    label: 'PC GPU',
    pattern: /(?:GPU|graphics)\s*:\s*(RTX\s*\d+[A-Z0-9 ]*)/i,
    normalize: v => v.replace(/\s+/g, ' ').trim().toUpperCase(),
  },
  // Fill sim path
  {
    label: 'mbo_fill_sim.py path',
    pattern: /((?:[A-Z]:[\\\/]|~\/)[^\s\n]+mbo_fill_sim\.py)/i,
    normalize: v => v.replace(/\\/g, '/').trim(),
  },
  // Best strategy Sharpe
  {
    label: 'rl_reward 30s Sharpe',
    pattern: /(?:30s\s+)?rl_reward.*?Sharpe\s+\+?([0-9]+\.[0-9]+)/i,
    normalize: v => parseFloat(v).toFixed(2),
  },
  // mbo_fill_sim.py line count
  {
    label: 'mbo_fill_sim.py line count',
    pattern: /mbo_fill_sim\.py\s*\((\d+)\s*lines\)/i,
    normalize: v => v.trim(),
  },
  // PC Tailscale IP
  {
    label: 'PC (Neptune) Tailscale IP',
    pattern: /(?:Neptune|this\s*PC)\s*.*?IP\s*:?\s*(100\.\d+\.\d+\.\d+)/i,
    normalize: v => v.trim(),
  },
  // ES tick value
  {
    label: 'ES tick value',
    pattern: /ES\s+tick\s*=?\s*\$([0-9.]+)/i,
    normalize: v => parseFloat(v).toFixed(2),
  },
  // RT cost
  {
    label: 'RT cost',
    pattern: /\$([0-9.]+)\s+RT\b/i,
    normalize: v => parseFloat(v).toFixed(2),
  },
];

/**
 * Read all memory files.
 * @param {string} dir
 * @returns {{ name: string, path: string, lines: string[] }[]}
 */
function readAllMemoryFiles(dir) {
  const result = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const filePath = path.join(dir, entry.name);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          result.push({
            name: entry.name,
            path: filePath,
            lines: content.split('\n'),
          });
        } catch (e) {
          // skip unreadable files
        }
      }
    }
  } catch (e) {
    // fallback: return empty
  }
  return result;
}

/**
 * Extract facts from a set of lines using a detector.
 * @param {string[]} lines
 * @param {Object} detector
 * @returns {{ value: string, lineNumber: number, rawLine: string }[]}
 */
function extractFacts(lines, detector) {
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(detector.pattern);
    if (m && m[1]) {
      const value = detector.normalize ? detector.normalize(m[1]) : m[1].trim();
      if (value) {
        matches.push({ value, lineNumber: i + 1, rawLine: lines[i].trim() });
      }
    }
  }
  return matches;
}

/**
 * Find duplicate content blocks across files (paragraph-level).
 * A "duplicate" is any sequence of 3+ non-empty, non-header lines that appears
 * verbatim (trimmed) in more than one file.
 *
 * @param {{ name: string, lines: string[] }[]} files
 * @returns {{ text: string, foundIn: { file: string, lineNumber: number }[] }[]}
 */
function findDuplicateBlocks(files) {
  // Build n-gram index: trigram of consecutive content lines → occurrences
  const index = new Map(); // normalized_trigram → [{ file, startLine }]

  for (const file of files) {
    const contentLines = [];
    for (let i = 0; i < file.lines.length; i++) {
      const l = file.lines[i].trim();
      // Skip headers, horizontal rules, blank lines, table separators
      if (l && !l.startsWith('#') && !l.startsWith('---') && !/^\|[-| ]+\|$/.test(l)) {
        contentLines.push({ text: l, originalLine: i + 1 });
      }
    }

    for (let i = 0; i < contentLines.length - 2; i++) {
      const trigram = [
        contentLines[i].text,
        contentLines[i + 1].text,
        contentLines[i + 2].text,
      ].join('\n');

      if (!index.has(trigram)) {
        index.set(trigram, []);
      }
      index.get(trigram).push({ file: file.name, startLine: contentLines[i].originalLine });
    }
  }

  // Collect trigrams that appear in 2+ different files
  const duplicates = [];
  for (const [text, occurrences] of index.entries()) {
    const fileSet = new Set(occurrences.map(o => o.file));
    if (fileSet.size >= 2) {
      // One occurrence per file (deduplicate within-file repeats)
      const uniqueByFile = [];
      const seen = new Set();
      for (const occ of occurrences) {
        if (!seen.has(occ.file)) {
          seen.add(occ.file);
          uniqueByFile.push(occ);
        }
      }
      duplicates.push({ text, foundIn: uniqueByFile });
    }
  }

  return duplicates;
}

/**
 * Run the full dedup analysis.
 *
 * @param {string} [memoryDir] - Override memory directory
 * @returns {{
 *   contradictions: { label: string, values: { file: string, value: string, lineNumber: number, rawLine: string }[] }[],
 *   duplicates: { text: string, foundIn: { file: string, startLine: number }[] }[],
 *   summary: string,
 *   timestamp: string
 * }}
 */
function runDedup(memoryDir) {
  const dir = memoryDir || MEMORY_DIR;
  const files = readAllMemoryFiles(dir);

  if (files.length === 0) {
    return {
      contradictions: [],
      duplicates: [],
      summary: 'No memory files found in: ' + dir,
      timestamp: new Date().toISOString(),
    };
  }

  // ── 1. Contradiction Detection ──────────────────────────────────────────────
  const contradictions = [];

  for (const detector of FACT_DETECTORS) {
    // Map: normalizedValue → [{ file, value, lineNumber, rawLine }]
    const valueMap = new Map();

    for (const file of files) {
      const facts = extractFacts(file.lines, detector);
      for (const fact of facts) {
        if (!valueMap.has(fact.value)) {
          valueMap.set(fact.value, []);
        }
        valueMap.get(fact.value).push({
          file: file.name,
          value: fact.value,
          lineNumber: fact.lineNumber,
          rawLine: fact.rawLine,
        });
      }
    }

    // If multiple distinct values found, it's a potential contradiction
    if (valueMap.size >= 2) {
      const allInstances = [];
      for (const instances of valueMap.values()) {
        allInstances.push(...instances);
      }
      contradictions.push({
        label: detector.label,
        values: allInstances,
      });
    }
  }

  // ── 2. Duplicate Block Detection ────────────────────────────────────────────
  const duplicates = findDuplicateBlocks(files);

  // ── 3. Format Summary ───────────────────────────────────────────────────────
  const lines = [
    `# Memory Dedup Report`,
    `*Generated: ${new Date().toISOString()}*`,
    `*Files scanned: ${files.map(f => f.name).join(', ')}*`,
    '',
    `## Contradictions (${contradictions.length} found)`,
  ];

  if (contradictions.length === 0) {
    lines.push('No contradictions detected.');
  } else {
    for (const c of contradictions) {
      lines.push(`\n### ${c.label}`);
      for (const v of c.values) {
        lines.push(`- **${v.file}:${v.lineNumber}** → \`${v.value}\``);
        lines.push(`  > ${v.rawLine}`);
      }
    }
  }

  lines.push('');
  lines.push(`## Duplicate Blocks (${duplicates.length} found)`);

  if (duplicates.length === 0) {
    lines.push('No duplicate content blocks detected.');
  } else {
    // Show top 10 most-duplicated to keep report readable
    const topDups = duplicates.slice(0, 10);
    for (const d of topDups) {
      lines.push(`\n### Appears in: ${d.foundIn.map(f => `${f.file}:${f.startLine}`).join(', ')}`);
      lines.push('```');
      lines.push(d.text.slice(0, 200) + (d.text.length > 200 ? '...' : ''));
      lines.push('```');
    }
    if (duplicates.length > 10) {
      lines.push(`*(${duplicates.length - 10} more duplicate blocks omitted)*`);
    }
  }

  const summary = lines.join('\n');

  return {
    contradictions,
    duplicates,
    summary,
    timestamp: new Date().toISOString(),
  };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const report = runDedup();

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      contradictions: report.contradictions,
      duplicateCount: report.duplicates.length,
      timestamp: report.timestamp,
    }, null, 2));
  } else {
    console.log(report.summary);
  }
}

module.exports = {
  runDedup,
  findDuplicateBlocks,
  FACT_DETECTORS,
  MEMORY_DIR,
};
