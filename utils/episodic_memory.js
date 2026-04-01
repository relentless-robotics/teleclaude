'use strict';
/**
 * episodic_memory.js — Episodic memory layer for the teleclaude bridge.
 *
 * Stores EVENTS: what happened, when, outcome, context.
 * Each episode is a structured record of something that occurred, optimized
 * for temporal queries ("what happened on Neptune yesterday?") and pattern
 * detection ("how many times has training crashed this week?").
 *
 * Storage: memory/episodes/ as dated JSONL files (one per day).
 * Each line is a JSON object — append-only, fast writes, easy to stream.
 *
 * USAGE:
 *   const em = require('./utils/episodic_memory');
 *   em.record({
 *     event_type: 'training_crashed',
 *     description: 'WF CNN fold 73 CUDA OOM on Neptune',
 *     node: 'neptune',
 *     outcome: 'failed',
 *     tags: ['cnn', 'wf', 'cuda'],
 *     metadata: { fold: 73, error: 'CUDA out of memory' }
 *   });
 *
 *   const crashes = em.query({ event_type: 'training_crashed', node: 'neptune', last_days: 7 });
 *   const today = em.getToday();
 *   const recent = em.getRecent(20);
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
  'C--Users-Footb-Documents-Github-teleclaude-main',
  'memory'
);

const EPISODES_DIR = path.join(MEMORY_DIR, 'episodes');

/** Valid event types — enforced on record() */
const EVENT_TYPES = [
  'training_completed',
  'training_crashed',
  'training_started',
  'experiment_result',
  'trade_executed',
  'alert_fired',
  'decision_made',
  'research_finding',
  'deployment',
  'node_status_change',
  'error',
  'session_start',
  'session_end',
  'memory_consolidated',
  'custom',
];

/** Valid outcome values */
const OUTCOMES = ['success', 'failed', 'partial', 'pending', 'unknown'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getEpisodeFilePath(dateStr) {
  return path.join(EPISODES_DIR, `${dateStr}.jsonl`);
}

/**
 * Generate a compact session ID from timestamp.
 * Format: YYYYMMDD-HHMM-XXXX where XXXX is random hex.
 */
function generateSessionId() {
  const now = new Date();
  const datepart = getDateStr(now).replace(/-/g, '');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const rand = Math.random().toString(16).slice(2, 6);
  return `${datepart}-${h}${m}-${rand}`;
}

// Module-level session ID — set once per process lifetime
let _sessionId = null;
function getSessionId() {
  if (!_sessionId) {
    _sessionId = generateSessionId();
  }
  return _sessionId;
}

/**
 * Parse a single JSONL line safely.
 * @param {string} line
 * @returns {Object|null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}

/**
 * Read all episodes from a JSONL file.
 * @param {string} filePath
 * @returns {Object[]}
 */
function readEpisodeFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const episodes = [];
    for (const line of lines) {
      const ep = parseLine(line);
      if (ep) episodes.push(ep);
    }
    return episodes;
  } catch (e) {
    return [];
  }
}

/**
 * List all episode files sorted by date (most recent first).
 * @returns {{ dateStr: string, filePath: string }[]}
 */
function listEpisodeFiles() {
  ensureDir(EPISODES_DIR);
  try {
    const files = fs.readdirSync(EPISODES_DIR)
      .filter(f => f.endsWith('.jsonl') && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => ({
        dateStr: f.replace('.jsonl', ''),
        filePath: path.join(EPISODES_DIR, f),
      }))
      .sort((a, b) => b.dateStr.localeCompare(a.dateStr));
    return files;
  } catch (e) {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record an episode to today's JSONL file.
 *
 * @param {Object} episode
 * @param {string} episode.event_type - One of EVENT_TYPES
 * @param {string} episode.description - Human-readable description of what happened
 * @param {string} [episode.node] - Compute node involved (neptune, uranus, razer, jupiter, saturn)
 * @param {string} [episode.outcome='unknown'] - One of OUTCOMES
 * @param {string[]} [episode.tags=[]] - Searchable tags
 * @param {Object} [episode.metadata={}] - Arbitrary structured data (fold number, IC, PID, etc.)
 * @param {string} [episode.session_id] - Override session ID (default: auto-generated)
 * @returns {Object} The stored episode (with timestamp and id added)
 */
function record(episode) {
  if (!episode || !episode.event_type || !episode.description) {
    throw new Error('Episode must have event_type and description');
  }

  if (!EVENT_TYPES.includes(episode.event_type)) {
    throw new Error(`Invalid event_type "${episode.event_type}". Valid types: ${EVENT_TYPES.join(', ')}`);
  }

  const outcome = episode.outcome || 'unknown';
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome "${outcome}". Valid outcomes: ${OUTCOMES.join(', ')}`);
  }

  const now = new Date();
  const stored = {
    id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now.toISOString(),
    event_type: episode.event_type,
    description: episode.description,
    node: episode.node || null,
    outcome,
    tags: Array.isArray(episode.tags) ? episode.tags : [],
    metadata: episode.metadata || {},
    session_id: episode.session_id || getSessionId(),
  };

  ensureDir(EPISODES_DIR);
  const filePath = getEpisodeFilePath(getDateStr(now));
  fs.appendFileSync(filePath, JSON.stringify(stored) + '\n', 'utf8');

  return stored;
}

/**
 * Record an episode from a session_logger entry.
 * Converts the session log format into an episodic memory entry.
 *
 * @param {string} heading - The session log heading (e.g., "BookSpatialCNN fold 5 complete")
 * @param {string[]} bullets - The bullet points from the session log
 * @param {string} [eventType='custom'] - Override event type detection
 * @returns {Object} The stored episode
 */
function recordFromSessionLog(heading, bullets, eventType) {
  // Auto-detect event type from heading if not provided
  let detectedType = eventType || 'custom';
  if (!eventType) {
    const h = heading.toLowerCase();
    if (h.includes('error') || h.includes('crash') || h.includes('fail')) {
      detectedType = h.includes('training') ? 'training_crashed' : 'error';
    } else if (h.includes('complete') || h.includes('done') || h.includes('finish')) {
      detectedType = h.includes('training') || h.includes('fold') ? 'training_completed' : 'custom';
    } else if (h.includes('result')) {
      detectedType = 'experiment_result';
    } else if (h.includes('decision')) {
      detectedType = 'decision_made';
    } else if (h.includes('session start')) {
      detectedType = 'session_start';
    } else if (h.includes('session end') || h.includes('flush')) {
      detectedType = 'session_end';
    } else if (h.includes('trade') || h.includes('execution')) {
      detectedType = 'trade_executed';
    } else if (h.includes('deploy')) {
      detectedType = 'deployment';
    } else if (h.includes('research') || h.includes('finding') || h.includes('discovery')) {
      detectedType = 'research_finding';
    } else if (h.includes('start') && (h.includes('training') || h.includes('fold'))) {
      detectedType = 'training_started';
    }
  }

  // Extract node from bullets if present
  let node = null;
  const nodePattern = /\b(neptune|uranus|razer|jupiter|saturn)\b/i;
  const headingMatch = heading.match(nodePattern);
  if (headingMatch) {
    node = headingMatch[1].toLowerCase();
  } else {
    for (const b of bullets) {
      const m = b.match(nodePattern);
      if (m) { node = m[1].toLowerCase(); break; }
    }
  }

  // Detect outcome
  let outcome = 'unknown';
  const allText = (heading + ' ' + bullets.join(' ')).toLowerCase();
  if (allText.includes('error') || allText.includes('crash') || allText.includes('fail') || allText.includes('unresolved')) {
    outcome = 'failed';
  } else if (allText.includes('complete') || allText.includes('success') || allText.includes('done') || allText.includes('clean')) {
    outcome = 'success';
  } else if (allText.includes('partial') || allText.includes('in progress')) {
    outcome = 'partial';
  } else if (allText.includes('pending') || allText.includes('started') || allText.includes('running')) {
    outcome = 'pending';
  }

  // Extract tags from bullets
  const tags = [];
  const tagPatterns = [
    /\bIC[=: ]+([0-9.]+)/i,
    /\bSharpe[=: ]+([0-9.]+)/i,
    /\bfold[=: ]+(\d+)/i,
    /\bGPU[=: ]+(\d+%?)/i,
    /\bPID[=: ]+(\d+)/i,
  ];
  for (const b of bullets) {
    for (const pat of tagPatterns) {
      const m = b.match(pat);
      if (m) tags.push(m[0].trim());
    }
  }

  return record({
    event_type: detectedType,
    description: heading,
    node,
    outcome,
    tags,
    metadata: { bullets, source: 'session_logger' },
  });
}

/**
 * Query episodes with flexible filters.
 *
 * @param {Object} [filters={}]
 * @param {string} [filters.event_type] - Filter by event type
 * @param {string} [filters.node] - Filter by compute node
 * @param {string} [filters.outcome] - Filter by outcome
 * @param {string[]} [filters.tags] - Filter by tags (any match)
 * @param {string} [filters.text] - Full-text search in description
 * @param {number} [filters.last_days=7] - Look back N days
 * @param {string} [filters.date] - Specific date (YYYY-MM-DD)
 * @param {string} [filters.session_id] - Filter by session ID
 * @param {number} [filters.limit=100] - Max results
 * @returns {Object[]} Matching episodes, most recent first
 */
function query(filters = {}) {
  const {
    event_type,
    node,
    outcome,
    tags,
    text,
    last_days = 7,
    date,
    session_id,
    limit = 100,
  } = filters;

  // Determine which files to read
  let filesToRead;
  if (date) {
    filesToRead = [{ dateStr: date, filePath: getEpisodeFilePath(date) }];
  } else {
    const allFiles = listEpisodeFiles();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - last_days);
    const cutoffStr = getDateStr(cutoff);
    filesToRead = allFiles.filter(f => f.dateStr >= cutoffStr);
  }

  const results = [];
  const textLower = text ? text.toLowerCase() : null;
  const tagsLower = tags ? tags.map(t => t.toLowerCase()) : null;

  for (const file of filesToRead) {
    const episodes = readEpisodeFile(file.filePath);
    for (const ep of episodes) {
      // Apply filters
      if (event_type && ep.event_type !== event_type) continue;
      if (node && ep.node !== node.toLowerCase()) continue;
      if (outcome && ep.outcome !== outcome) continue;
      if (session_id && ep.session_id !== session_id) continue;

      if (textLower) {
        const desc = (ep.description || '').toLowerCase();
        const meta = JSON.stringify(ep.metadata || {}).toLowerCase();
        if (!desc.includes(textLower) && !meta.includes(textLower)) continue;
      }

      if (tagsLower) {
        const epTags = (ep.tags || []).map(t => t.toLowerCase());
        const hasAny = tagsLower.some(t => epTags.includes(t));
        if (!hasAny) continue;
      }

      results.push(ep);
    }
  }

  // Sort by timestamp descending (most recent first)
  results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return results.slice(0, limit);
}

/**
 * Get all episodes from today.
 * @returns {Object[]}
 */
function getToday() {
  return query({ date: getDateStr(), limit: 500 });
}

/**
 * Get the N most recent episodes across all days.
 * @param {number} [n=20]
 * @returns {Object[]}
 */
function getRecent(n = 20) {
  return query({ last_days: 30, limit: n });
}

/**
 * Count episodes matching filters (useful for pattern detection).
 *
 * @param {Object} filters - Same as query() filters
 * @returns {number}
 */
function count(filters = {}) {
  // Use a high limit to count all
  const overridden = { ...filters, limit: 100000 };
  return query(overridden).length;
}

/**
 * Get episode statistics for a time range.
 *
 * @param {number} [days=7] - Look back N days
 * @returns {Object} Statistics summary
 */
function getStats(days = 7) {
  const episodes = query({ last_days: days, limit: 100000 });

  const byType = {};
  const byNode = {};
  const byOutcome = {};
  const byDay = {};

  for (const ep of episodes) {
    byType[ep.event_type] = (byType[ep.event_type] || 0) + 1;
    if (ep.node) byNode[ep.node] = (byNode[ep.node] || 0) + 1;
    byOutcome[ep.outcome] = (byOutcome[ep.outcome] || 0) + 1;
    const day = ep.timestamp ? ep.timestamp.slice(0, 10) : 'unknown';
    byDay[day] = (byDay[day] || 0) + 1;
  }

  return {
    total: episodes.length,
    days_covered: Object.keys(byDay).length,
    by_type: byType,
    by_node: byNode,
    by_outcome: byOutcome,
    by_day: byDay,
  };
}

/**
 * Get all episodes for a specific session.
 * @param {string} sessionId
 * @returns {Object[]}
 */
function getSession(sessionId) {
  return query({ session_id: sessionId, last_days: 30, limit: 10000 });
}

/**
 * Delete episodes older than N days (for archival/cleanup).
 * @param {number} [olderThanDays=30]
 * @returns {{ deleted: number, files: string[] }}
 */
function purgeOld(olderThanDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffStr = getDateStr(cutoff);

  const allFiles = listEpisodeFiles();
  const toDelete = allFiles.filter(f => f.dateStr < cutoffStr);

  let deleted = 0;
  const deletedFiles = [];
  for (const file of toDelete) {
    try {
      const episodes = readEpisodeFile(file.filePath);
      deleted += episodes.length;
      fs.unlinkSync(file.filePath);
      deletedFiles.push(file.dateStr);
    } catch (e) {
      // skip files that can't be deleted
    }
  }

  return { deleted, files: deletedFiles };
}

/**
 * Format episodes for display (Discord/terminal).
 * @param {Object[]} episodes
 * @param {Object} [opts]
 * @param {boolean} [opts.compact=false] - Single-line format
 * @returns {string}
 */
function format(episodes, opts = {}) {
  if (episodes.length === 0) return '(no episodes found)';

  const lines = [];
  for (const ep of episodes) {
    const ts = ep.timestamp ? ep.timestamp.slice(0, 16).replace('T', ' ') : '?';
    const nodeStr = ep.node ? `[${ep.node}]` : '';
    const outcomeStr = ep.outcome !== 'unknown' ? `(${ep.outcome})` : '';
    const tagStr = ep.tags && ep.tags.length > 0 ? ` {${ep.tags.join(', ')}}` : '';

    if (opts.compact) {
      lines.push(`${ts} ${ep.event_type} ${nodeStr} ${ep.description} ${outcomeStr}${tagStr}`);
    } else {
      lines.push(`**${ts}** \`${ep.event_type}\` ${nodeStr} ${outcomeStr}`);
      lines.push(`  ${ep.description}${tagStr}`);
      if (ep.metadata && Object.keys(ep.metadata).length > 0 && !ep.metadata.bullets) {
        const metaStr = Object.entries(ep.metadata).map(([k, v]) => `${k}=${v}`).join(', ');
        lines.push(`  > ${metaStr}`);
      }
    }
  }

  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'query' || cmd === 'search') {
    const text = args.slice(1).join(' ');
    const results = query({ text, last_days: 14 });
    console.log(format(results));
  } else if (cmd === 'today') {
    const results = getToday();
    console.log(format(results));
  } else if (cmd === 'recent') {
    const n = parseInt(args[1]) || 20;
    const results = getRecent(n);
    console.log(format(results));
  } else if (cmd === 'stats') {
    const days = parseInt(args[1]) || 7;
    const stats = getStats(days);
    console.log(JSON.stringify(stats, null, 2));
  } else if (cmd === 'record') {
    // Quick record from CLI: node episodic_memory.js record <type> <description>
    const type = args[1] || 'custom';
    const desc = args.slice(2).join(' ') || 'Manual CLI entry';
    const ep = record({ event_type: type, description: desc });
    console.log('Recorded:', ep.id);
  } else {
    console.log('Usage:');
    console.log('  node episodic_memory.js today                    — show today\'s episodes');
    console.log('  node episodic_memory.js recent [N]               — show N most recent episodes');
    console.log('  node episodic_memory.js search <text>            — search episodes');
    console.log('  node episodic_memory.js stats [days]             — show statistics');
    console.log('  node episodic_memory.js record <type> <desc>     — record an episode');
  }
}

module.exports = {
  record,
  recordFromSessionLog,
  query,
  getToday,
  getRecent,
  count,
  getStats,
  getSession,
  purgeOld,
  format,
  getSessionId,
  listEpisodeFiles,
  EVENT_TYPES,
  OUTCOMES,
  EPISODES_DIR,
  MEMORY_DIR,
};
