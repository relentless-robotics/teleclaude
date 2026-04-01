'use strict';
/**
 * session_handoff.js — Session handoff helper for seamless restarts.
 *
 * On session end: dumps current state to episodic memory and creates a
 * compact handoff blob that the next session can load instantly.
 *
 * On session start: loads recent episodes + relevant semantic facts
 * for instant context recovery. This is what makes restart #35 seamless.
 *
 * USAGE:
 *   const handoff = require('./utils/session_handoff');
 *
 *   // At session end:
 *   handoff.endSession({
 *     completed: ['Deployed CNN model', 'Fixed Jupiter SSH'],
 *     pending: ['Uranus training fold 73 needs restart'],
 *     notes: 'Neptune GPU idle, consider starting new job'
 *   });
 *
 *   // At session start:
 *   const context = handoff.startSession();
 *   console.log(context.summary);  // Human-readable summary for the AI
 */

const fs = require('fs');
const path = require('path');

// Lazy-load dependencies to avoid circular requires
let _episodic = null;
let _semantic = null;
let _sessionLogger = null;
let _shortterm = null;

function getEpisodic() {
  if (!_episodic) _episodic = require('./episodic_memory');
  return _episodic;
}

function getSemantic() {
  if (!_semantic) _semantic = require('./semantic_memory');
  return _semantic;
}

function getSessionLogger() {
  if (!_sessionLogger) _sessionLogger = require('./session_logger');
  return _sessionLogger;
}

function getShortterm() {
  if (!_shortterm) {
    try { _shortterm = require('./shortterm_memory'); } catch (e) { _shortterm = null; }
  }
  return _shortterm;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  'projects',
  'C--Users-Footb-Documents-Github-teleclaude-main',
  'memory'
);

const HANDOFF_FILE = path.join(MEMORY_DIR, 'handoff.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Session End ────────────────────────────────────────────────────────────

/**
 * End the current session: dump state to episodic memory, session log,
 * and create a handoff blob for the next session.
 *
 * @param {Object} [state={}]
 * @param {string[]} [state.completed=[]] - Tasks completed this session
 * @param {string[]} [state.pending=[]] - Tasks still pending
 * @param {string} [state.notes=''] - Free-form notes for next session
 * @param {Object} [state.computeStatus={}] - Current compute cluster status
 * @param {Object} [state.metadata={}] - Any additional structured data
 * @returns {Object} The handoff blob that was saved
 */
function endSession(state = {}) {
  const {
    completed = [],
    pending = [],
    notes = '',
    computeStatus = {},
    metadata = {},
  } = state;

  const episodic = getEpisodic();
  const logger = getSessionLogger();

  // 1. Record session end in episodic memory
  try {
    episodic.record({
      event_type: 'session_end',
      description: `Session ended. ${completed.length} completed, ${pending.length} pending.`,
      outcome: 'success',
      tags: ['session', 'handoff'],
      metadata: {
        completed,
        pending,
        notes,
        compute_status: computeStatus,
        ...metadata,
      },
    });
  } catch (e) {
    // Non-critical
  }

  // 2. Log to session logger
  try {
    logger.logSessionEnd(pending);
  } catch (e) {
    // Non-critical
  }

  // 3. Build handoff blob
  const handoff = {
    timestamp: new Date().toISOString(),
    session_id: episodic.getSessionId(),
    completed,
    pending,
    notes,
    compute_status: computeStatus,

    // Include recent episodes (last 6 hours) for continuity
    recent_episodes: [],

    // Include high-priority semantic facts
    key_facts: [],

    // Short-term memory snapshot
    shortterm_context: '',

    metadata,
  };

  // Gather recent episodes
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000);
    const recent = episodic.query({ last_days: 1, limit: 30 });
    handoff.recent_episodes = recent
      .filter(ep => new Date(ep.timestamp) >= sixHoursAgo)
      .map(ep => ({
        timestamp: ep.timestamp,
        type: ep.event_type,
        description: ep.description,
        node: ep.node,
        outcome: ep.outcome,
      }));
  } catch (e) {
    // Non-critical
  }

  // Gather key semantic facts (high confidence, recently updated)
  try {
    const semantic = getSemantic();
    const allFacts = semantic.exportAll();
    // Sort by updated_at descending, take top 20 high-confidence facts
    const keyFacts = allFacts
      .filter(f => f.confidence >= 0.7)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 20);
    handoff.key_facts = keyFacts.map(f => ({
      category: f.category,
      content: f.content,
      confidence: f.confidence,
    }));
  } catch (e) {
    // Non-critical
  }

  // Short-term memory snapshot
  try {
    const stm = getShortterm();
    if (stm) {
      handoff.shortterm_context = stm.getActiveContext();
    }
  } catch (e) {
    // Non-critical
  }

  // 4. Save handoff blob
  ensureDir(MEMORY_DIR);
  try {
    fs.writeFileSync(HANDOFF_FILE, JSON.stringify(handoff, null, 2), 'utf8');
  } catch (e) {
    // If we can't write to the standard location, try the project data dir
    const fallback = path.join(__dirname, '..', 'data', 'handoff.json');
    fs.writeFileSync(fallback, JSON.stringify(handoff, null, 2), 'utf8');
  }

  return handoff;
}

// ─── Session Start ──────────────────────────────────────────────────────────

/**
 * Start a new session: load the handoff blob and build a context summary
 * for the AI to immediately understand what's going on.
 *
 * @param {Object} [opts={}]
 * @param {number} [opts.recentHours=12] - How many hours of episodes to include
 * @param {number} [opts.maxFacts=15] - Max semantic facts to include
 * @returns {Object} Context package with .summary (string) and structured data
 */
function startSession(opts = {}) {
  const { recentHours = 12, maxFacts = 15 } = opts;

  const episodic = getEpisodic();
  const logger = getSessionLogger();

  // 1. Load handoff blob (if exists)
  let handoff = null;
  try {
    if (fs.existsSync(HANDOFF_FILE)) {
      handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
    }
  } catch (e) {
    // No handoff available
  }

  // 2. Record session start
  try {
    episodic.record({
      event_type: 'session_start',
      description: handoff
        ? `Session started. Resuming from ${handoff.timestamp}. ${(handoff.pending || []).length} pending tasks.`
        : 'Session started (no handoff available).',
      outcome: 'success',
      tags: ['session', 'startup'],
      metadata: {
        previous_session_id: handoff ? handoff.session_id : null,
        pending_from_last: handoff ? handoff.pending : [],
      },
    });
  } catch (e) {
    // Non-critical
  }

  // 3. Log to session logger
  try {
    logger.logSessionStart({
      handoff: handoff ? 'loaded' : 'none',
      pending: handoff ? `${(handoff.pending || []).length} items` : '0',
    });
  } catch (e) {
    // Non-critical
  }

  // 4. Gather recent episodes (regardless of handoff)
  let recentEpisodes = [];
  try {
    const cutoff = new Date(Date.now() - recentHours * 3600 * 1000);
    const recent = episodic.query({ last_days: 2, limit: 50 });
    recentEpisodes = recent.filter(ep => new Date(ep.timestamp) >= cutoff);
  } catch (e) {
    // Non-critical
  }

  // 5. Gather relevant semantic facts
  let keyFacts = [];
  try {
    const semantic = getSemantic();
    const allFacts = semantic.exportAll();
    keyFacts = allFacts
      .filter(f => f.confidence >= 0.7)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, maxFacts);
  } catch (e) {
    // Non-critical
  }

  // 6. Build summary
  const summary = buildSummary(handoff, recentEpisodes, keyFacts);

  return {
    summary,
    handoff,
    recent_episodes: recentEpisodes,
    key_facts: keyFacts,
    session_id: episodic.getSessionId(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a human-readable summary for the AI from session context.
 *
 * @param {Object|null} handoff
 * @param {Object[]} recentEpisodes
 * @param {Object[]} keyFacts
 * @returns {string}
 */
function buildSummary(handoff, recentEpisodes, keyFacts) {
  const lines = [];
  lines.push('=== SESSION CONTEXT RECOVERY ===');
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push('');

  // Handoff info
  if (handoff) {
    const age = Math.round((Date.now() - new Date(handoff.timestamp).getTime()) / 3600000);
    lines.push(`--- HANDOFF FROM PREVIOUS SESSION (${age}h ago) ---`);

    if (handoff.pending && handoff.pending.length > 0) {
      lines.push('PENDING TASKS:');
      for (const p of handoff.pending) {
        lines.push(`  * ${p}`);
      }
    }

    if (handoff.completed && handoff.completed.length > 0) {
      lines.push(`COMPLETED LAST SESSION (${handoff.completed.length} items):`);
      for (const c of handoff.completed.slice(0, 5)) {
        lines.push(`  - ${c}`);
      }
      if (handoff.completed.length > 5) {
        lines.push(`  ... and ${handoff.completed.length - 5} more`);
      }
    }

    if (handoff.notes) {
      lines.push(`NOTES: ${handoff.notes}`);
    }

    if (handoff.compute_status && Object.keys(handoff.compute_status).length > 0) {
      lines.push('COMPUTE STATUS:');
      for (const [node, status] of Object.entries(handoff.compute_status)) {
        lines.push(`  ${node}: ${typeof status === 'string' ? status : JSON.stringify(status)}`);
      }
    }

    lines.push('');
  } else {
    lines.push('(No handoff from previous session)');
    lines.push('');
  }

  // Recent episodes
  if (recentEpisodes.length > 0) {
    lines.push(`--- RECENT ACTIVITY (${recentEpisodes.length} events) ---`);

    // Group by type for readability
    const byType = {};
    for (const ep of recentEpisodes) {
      const type = ep.event_type || 'unknown';
      if (!byType[type]) byType[type] = [];
      byType[type].push(ep);
    }

    for (const [type, eps] of Object.entries(byType)) {
      lines.push(`${type} (${eps.length}):`);
      for (const ep of eps.slice(0, 5)) {
        const ts = ep.timestamp ? ep.timestamp.slice(11, 16) : '?';
        const nodeStr = ep.node ? ` [${ep.node}]` : '';
        const outcomeStr = ep.outcome && ep.outcome !== 'unknown' ? ` (${ep.outcome})` : '';
        lines.push(`  ${ts}${nodeStr} ${ep.description}${outcomeStr}`);
      }
      if (eps.length > 5) lines.push(`  ... and ${eps.length - 5} more`);
    }
    lines.push('');
  }

  // Key semantic facts
  if (keyFacts.length > 0) {
    lines.push(`--- KEY FACTS (${keyFacts.length}) ---`);
    // Group by category
    const byCat = {};
    for (const f of keyFacts) {
      const cat = f.category || 'unknown';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(f);
    }

    for (const [cat, facts] of Object.entries(byCat)) {
      lines.push(`[${cat}]`);
      for (const f of facts) {
        lines.push(`  ${f.content}`);
      }
    }
    lines.push('');
  }

  lines.push('=== END CONTEXT RECOVERY ===');
  return lines.join('\n');
}

/**
 * Get a quick status check — is there a pending handoff?
 * @returns {{ hasHandoff: boolean, age_hours: number|null, pending_count: number }}
 */
function checkHandoff() {
  try {
    if (!fs.existsSync(HANDOFF_FILE)) {
      return { hasHandoff: false, age_hours: null, pending_count: 0 };
    }
    const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
    const ageHours = Math.round((Date.now() - new Date(handoff.timestamp).getTime()) / 3600000);
    return {
      hasHandoff: true,
      age_hours: ageHours,
      pending_count: (handoff.pending || []).length,
    };
  } catch (e) {
    return { hasHandoff: false, age_hours: null, pending_count: 0 };
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'start') {
    const ctx = startSession();
    console.log(ctx.summary);
  } else if (cmd === 'end') {
    const pending = args.slice(1);
    const handoff = endSession({ pending });
    console.log('Session ended. Handoff saved.');
    console.log(`Pending items: ${handoff.pending.length}`);
    console.log(`Recent episodes: ${handoff.recent_episodes.length}`);
    console.log(`Key facts: ${handoff.key_facts.length}`);
  } else if (cmd === 'check') {
    const status = checkHandoff();
    console.log(JSON.stringify(status, null, 2));
  } else if (cmd === 'view') {
    try {
      const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
      console.log(JSON.stringify(handoff, null, 2));
    } catch (e) {
      console.log('No handoff file found.');
    }
  } else {
    console.log('Usage:');
    console.log('  node session_handoff.js start                     — start session, load context');
    console.log('  node session_handoff.js end [pending items...]    — end session, save handoff');
    console.log('  node session_handoff.js check                     — check handoff status');
    console.log('  node session_handoff.js view                      — view raw handoff data');
  }
}

module.exports = {
  startSession,
  endSession,
  checkHandoff,
  buildSummary,
  HANDOFF_FILE,
};
