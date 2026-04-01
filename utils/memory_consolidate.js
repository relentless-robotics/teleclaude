'use strict';
/**
 * memory_consolidate.js — Memory consolidation pipeline.
 *
 * Designed to run nightly (or on-demand): reviews the day's episodic memory,
 * extracts durable facts into semantic memory, detects contradictions,
 * and archives old episodes.
 *
 * The consolidation loop:
 *   1. Read today's (or specified day's) episodes
 *   2. For each episode, determine if it contains a new semantic fact
 *   3. Store/update semantic facts (with supersession)
 *   4. Run contradiction detection on updated semantic store
 *   5. Archive old episodes (>30 days by default)
 *   6. Return a consolidation report
 *
 * USAGE:
 *   const { consolidate } = require('./utils/memory_consolidate');
 *   const report = consolidate();          // consolidate today
 *   const report = consolidate('2026-03-25'); // specific day
 *
 *   // As nightly job:
 *   const { nightlyConsolidate } = require('./utils/memory_consolidate');
 *   const report = nightlyConsolidate();
 */

const fs = require('fs');
const path = require('path');
const episodic = require('./episodic_memory');
const semantic = require('./semantic_memory');

// ─── Extraction Rules ───────────────────────────────────────────────────────

/**
 * Rules for extracting semantic facts from episodes.
 * Each rule has:
 *   - match: function(episode) => boolean — does this episode match?
 *   - extract: function(episode) => { category, content, confidence, tags } | null
 */
const EXTRACTION_RULES = [
  // Training completed => model_result fact
  {
    name: 'training_result',
    match: (ep) => ep.event_type === 'training_completed' && ep.outcome === 'success',
    extract: (ep) => {
      const meta = ep.metadata || {};
      const parts = [ep.description];
      if (meta.ic) parts.push(`IC=${meta.ic}`);
      if (meta.sharpe) parts.push(`Sharpe=${meta.sharpe}`);
      if (meta.sortino) parts.push(`Sortino=${meta.sortino}`);
      if (meta.fold) parts.push(`fold=${meta.fold}`);

      return {
        category: 'model_result',
        content: parts.join(', '),
        confidence: 0.9,
        tags: [...(ep.tags || []), ep.node].filter(Boolean),
        source: `episodic:${ep.id}`,
      };
    },
  },

  // Training crashed => operational knowledge
  {
    name: 'training_crash',
    match: (ep) => ep.event_type === 'training_crashed',
    extract: (ep) => {
      const meta = ep.metadata || {};
      return {
        category: 'infrastructure',
        content: `Training crash on ${ep.node || 'unknown'}: ${ep.description}${meta.error ? ` (${meta.error})` : ''}`,
        confidence: 0.85,
        tags: ['crash', ...(ep.tags || []), ep.node].filter(Boolean),
        source: `episodic:${ep.id}`,
      };
    },
  },

  // Experiment results => research_finding
  {
    name: 'experiment_result',
    match: (ep) => ep.event_type === 'experiment_result',
    extract: (ep) => {
      const meta = ep.metadata || {};
      const parts = [ep.description];
      // Pull out key metrics from metadata
      for (const key of ['ic', 'sharpe', 'sortino', 'accuracy', 'pnl']) {
        if (meta[key] !== undefined) parts.push(`${key}=${meta[key]}`);
      }

      return {
        category: 'research_finding',
        content: parts.join(', '),
        confidence: ep.outcome === 'success' ? 0.85 : 0.6,
        tags: [...(ep.tags || []), ep.node].filter(Boolean),
        source: `episodic:${ep.id}`,
      };
    },
  },

  // Research finding => research_finding fact
  {
    name: 'research_finding',
    match: (ep) => ep.event_type === 'research_finding',
    extract: (ep) => ({
      category: 'research_finding',
      content: ep.description,
      confidence: 0.8,
      tags: [...(ep.tags || []), ep.node].filter(Boolean),
      source: `episodic:${ep.id}`,
    }),
  },

  // Decision made => operational_rule (if it sounds like a rule)
  {
    name: 'decision_to_rule',
    match: (ep) => {
      if (ep.event_type !== 'decision_made') return false;
      const desc = (ep.description || '').toLowerCase();
      // Only promote decisions that sound like lasting rules
      return desc.includes('never') || desc.includes('always') ||
             desc.includes('rule') || desc.includes('policy') ||
             desc.includes('standard') || desc.includes('protocol');
    },
    extract: (ep) => ({
      category: 'operational_rule',
      content: ep.description,
      confidence: 0.75,
      tags: [...(ep.tags || []), 'decision'].filter(Boolean),
      source: `episodic:${ep.id}`,
    }),
  },

  // Node status change => node_config
  {
    name: 'node_status',
    match: (ep) => ep.event_type === 'node_status_change' && ep.node,
    extract: (ep) => ({
      category: 'node_config',
      content: `${ep.node}: ${ep.description}`,
      confidence: 0.9,
      tags: [ep.node, 'status', ...(ep.tags || [])].filter(Boolean),
      source: `episodic:${ep.id}`,
    }),
  },

  // Deployment => infrastructure
  {
    name: 'deployment',
    match: (ep) => ep.event_type === 'deployment',
    extract: (ep) => ({
      category: 'infrastructure',
      content: ep.description,
      confidence: ep.outcome === 'success' ? 0.9 : 0.7,
      tags: ['deployment', ...(ep.tags || []), ep.node].filter(Boolean),
      source: `episodic:${ep.id}`,
    }),
  },

  // Trade executed => strategy_rule (extract patterns, not individual trades)
  {
    name: 'trade_pattern',
    match: (ep) => ep.event_type === 'trade_executed' && ep.metadata && ep.metadata.pattern,
    extract: (ep) => ({
      category: 'strategy_rule',
      content: `Trade pattern: ${ep.metadata.pattern}. ${ep.description}`,
      confidence: 0.7,
      tags: ['trade', ...(ep.tags || [])].filter(Boolean),
      source: `episodic:${ep.id}`,
    }),
  },
];

// ─── Consolidation Engine ───────────────────────────────────────────────────

/**
 * Extract semantic facts from a set of episodes.
 *
 * @param {Object[]} episodes
 * @returns {{ extracted: Object[], skipped: number }}
 */
function extractFacts(episodes) {
  const extracted = [];
  let skipped = 0;

  for (const ep of episodes) {
    let matched = false;
    for (const rule of EXTRACTION_RULES) {
      if (rule.match(ep)) {
        try {
          const fact = rule.extract(ep);
          if (fact) {
            extracted.push({
              ...fact,
              _rule: rule.name,
              _episode_id: ep.id,
            });
            matched = true;
            break; // First matching rule wins
          }
        } catch (e) {
          // Skip malformed episodes
        }
      }
    }
    if (!matched) skipped++;
  }

  return { extracted, skipped };
}

/**
 * Consolidate a day's episodes into semantic memory.
 *
 * @param {string} [dateStr] - Date to consolidate (YYYY-MM-DD), defaults to today
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] - If true, don't actually store — just report what would happen
 * @param {boolean} [opts.force=false] - Re-consolidate even if already done
 * @returns {Object} Consolidation report
 */
function consolidate(dateStr, opts = {}) {
  const { dryRun = false, force = false } = opts;
  const targetDate = dateStr || _getDateStr();

  // Get episodes for the target day
  const episodes = episodic.query({ date: targetDate, limit: 10000 });

  if (episodes.length === 0) {
    return {
      date: targetDate,
      episodes_reviewed: 0,
      facts_extracted: 0,
      facts_stored: 0,
      skipped: 0,
      contradictions: [],
      status: 'no_episodes',
    };
  }

  // Check if already consolidated (look for consolidation episode)
  if (!force) {
    const alreadyDone = episodes.find(
      ep => ep.event_type === 'memory_consolidated' && ep.description.includes(targetDate)
    );
    if (alreadyDone) {
      return {
        date: targetDate,
        episodes_reviewed: episodes.length,
        facts_extracted: 0,
        facts_stored: 0,
        skipped: 0,
        contradictions: [],
        status: 'already_consolidated',
      };
    }
  }

  // Extract facts
  const { extracted, skipped } = extractFacts(episodes);

  // Store facts (unless dry run)
  let stored = 0;
  const storedFacts = [];
  if (!dryRun) {
    for (const factData of extracted) {
      const { _rule, _episode_id, ...fact } = factData;
      try {
        const result = semantic.storeOrUpdate(fact, fact.content.slice(0, 80));
        storedFacts.push(result);
        stored++;
      } catch (e) {
        // Skip facts that fail to store
      }
    }
  }

  // Check for contradictions in the updated semantic store
  const contradictions = semantic.findContradictions();

  // Record consolidation event
  if (!dryRun) {
    try {
      episodic.record({
        event_type: 'memory_consolidated',
        description: `Consolidated ${targetDate}: ${episodes.length} episodes -> ${stored} facts`,
        outcome: 'success',
        tags: ['consolidation'],
        metadata: {
          date: targetDate,
          episodes_reviewed: episodes.length,
          facts_stored: stored,
          contradictions_found: contradictions.length,
        },
      });
    } catch (e) {
      // Non-critical
    }
  }

  return {
    date: targetDate,
    episodes_reviewed: episodes.length,
    facts_extracted: extracted.length,
    facts_stored: stored,
    skipped,
    contradictions: contradictions.map(c => ({
      fact1: { id: c.fact1.id, content: c.fact1.content },
      fact2: { id: c.fact2.id, content: c.fact2.content },
      overlap: c.overlap,
    })),
    stored_facts: storedFacts.map(f => ({ id: f.id, category: f.category, content: f.content })),
    status: dryRun ? 'dry_run' : 'completed',
  };
}

/**
 * Run nightly consolidation:
 *   1. Consolidate today's episodes
 *   2. Consolidate yesterday's (in case missed)
 *   3. Archive old episodes
 *   4. Run contradiction detection
 *
 * @param {Object} [opts]
 * @param {number} [opts.archiveAfterDays=30] - Archive episodes older than this
 * @param {boolean} [opts.dryRun=false]
 * @returns {Object} Full nightly report
 */
function nightlyConsolidate(opts = {}) {
  const { archiveAfterDays = 30, dryRun = false } = opts;

  const today = _getDateStr();
  const yesterday = _getDateStr(new Date(Date.now() - 86400000));

  // Consolidate today and yesterday
  const todayReport = consolidate(today, { dryRun });
  const yesterdayReport = consolidate(yesterday, { dryRun });

  // Archive old episodes
  let archiveResult = { deleted: 0, files: [] };
  if (!dryRun) {
    archiveResult = episodic.purgeOld(archiveAfterDays);
  }

  // Full contradiction check
  const allContradictions = semantic.findContradictions();

  // Semantic memory stats
  const semanticStats = semantic.getStats();

  return {
    timestamp: new Date().toISOString(),
    today: todayReport,
    yesterday: yesterdayReport,
    archived: archiveResult,
    contradictions: allContradictions.map(c => ({
      fact1: { id: c.fact1.id, content: c.fact1.content },
      fact2: { id: c.fact2.id, content: c.fact2.content },
      overlap: c.overlap,
    })),
    semantic_stats: semanticStats,
    status: dryRun ? 'dry_run' : 'completed',
  };
}

/**
 * Consolidate a range of dates.
 *
 * @param {string} startDate - Start date YYYY-MM-DD
 * @param {string} endDate - End date YYYY-MM-DD
 * @param {Object} [opts]
 * @returns {Object[]} Array of consolidation reports
 */
function consolidateRange(startDate, endDate, opts = {}) {
  const reports = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = _getDateStr(d);
    reports.push(consolidate(dateStr, opts));
  }

  return reports;
}

/**
 * Format consolidation report for display.
 * @param {Object} report
 * @returns {string}
 */
function formatReport(report) {
  const lines = [];

  if (report.today) {
    // Nightly report format
    lines.push('## Nightly Consolidation Report');
    lines.push(`*${report.timestamp}*\n`);
    lines.push(`**Today (${report.today.date}):** ${report.today.episodes_reviewed} episodes -> ${report.today.facts_stored} facts (${report.today.status})`);
    lines.push(`**Yesterday (${report.yesterday.date}):** ${report.yesterday.episodes_reviewed} episodes -> ${report.yesterday.facts_stored} facts (${report.yesterday.status})`);
    lines.push(`**Archived:** ${report.archived.deleted} old episodes from ${report.archived.files.length} files`);
    lines.push(`**Contradictions:** ${report.contradictions.length} found`);
    lines.push(`**Semantic store:** ${report.semantic_stats.active} active facts across ${Object.keys(report.semantic_stats.by_category).length} categories`);

    if (report.contradictions.length > 0) {
      lines.push('\n### Contradictions to Review:');
      for (const c of report.contradictions.slice(0, 5)) {
        lines.push(`- **${c.fact1.id}**: ${c.fact1.content.slice(0, 80)}`);
        lines.push(`  vs **${c.fact2.id}**: ${c.fact2.content.slice(0, 80)}`);
      }
    }
  } else {
    // Single day report format
    lines.push(`## Consolidation: ${report.date}`);
    lines.push(`Episodes reviewed: ${report.episodes_reviewed}`);
    lines.push(`Facts extracted: ${report.facts_extracted}, stored: ${report.facts_stored}`);
    lines.push(`Status: ${report.status}`);

    if (report.stored_facts && report.stored_facts.length > 0) {
      lines.push('\n### New Facts:');
      for (const f of report.stored_facts) {
        lines.push(`- [${f.category}] ${f.content.slice(0, 100)}`);
      }
    }

    if (report.contradictions.length > 0) {
      lines.push('\n### Contradictions:');
      for (const c of report.contradictions.slice(0, 5)) {
        lines.push(`- ${c.fact1.content.slice(0, 60)} vs ${c.fact2.content.slice(0, 60)}`);
      }
    }
  }

  return lines.join('\n');
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function _getDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'nightly') {
    const dryRun = args.includes('--dry-run');
    const report = nightlyConsolidate({ dryRun });
    console.log(formatReport(report));
  } else if (cmd === 'day') {
    const dateStr = args[1];
    const dryRun = args.includes('--dry-run');
    const report = consolidate(dateStr, { dryRun });
    console.log(formatReport(report));
  } else if (cmd === 'range') {
    const start = args[1];
    const end = args[2];
    if (!start || !end) {
      console.log('Usage: node memory_consolidate.js range <start-date> <end-date>');
    } else {
      const reports = consolidateRange(start, end);
      for (const r of reports) console.log(formatReport(r), '\n');
    }
  } else if (cmd === 'dry-run') {
    const report = nightlyConsolidate({ dryRun: true });
    console.log(formatReport(report));
  } else {
    console.log('Usage:');
    console.log('  node memory_consolidate.js nightly [--dry-run]       — full nightly consolidation');
    console.log('  node memory_consolidate.js day [YYYY-MM-DD] [--dry-run] — consolidate one day');
    console.log('  node memory_consolidate.js range <start> <end>       — consolidate date range');
    console.log('  node memory_consolidate.js dry-run                   — preview without writing');
  }
}

module.exports = {
  consolidate,
  nightlyConsolidate,
  consolidateRange,
  extractFacts,
  formatReport,
  EXTRACTION_RULES,
};
