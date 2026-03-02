/**
 * Memory Manager — Core Service Agent
 *
 * Runs alongside the orchestrator as a permanent background service.
 * READ-HEAVY, WRITE-CAUTIOUS: freely reads and analyzes all memory files,
 * but never deletes or directly modifies them without orchestrator approval.
 *
 * Responsibilities:
 *   1. Staleness detection (sections with timestamps >24h old)
 *   2. Deduplication and contradiction checks (via memory_dedup.js)
 *   3. File size enforcement (per-file line limits)
 *   4. Index verification (INDEX.md references vs actual files)
 *   5. Session log maintenance (archive logs >30 days old)
 *   6. Task & job tracking (agent runs, compute jobs — ensure results persist)
 *   7. Structured health reports with LLM-powered recommendations
 *
 * SAFETY RULES (NEVER VIOLATED):
 *   - NEVER delete memory files without orchestrator approval
 *   - NEVER modify MEMORY.md directly — only propose edits
 *   - NEVER overwrite session logs — they are append-only
 *   - All write proposals logged to trading_agents/data/memory_manager_state.json
 *
 * Usage:
 *   const MemoryManager = require('./trading_agents/agents/memory_manager');
 *   const mgr = new MemoryManager();
 *   await mgr.run();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Dependency loading (graceful fallbacks) ---

let reasoning;
try {
  reasoning = require('../../utils/llm_reasoning');
} catch (e) {
  console.warn('[MemoryManager] LLM reasoning not available:', e.message);
}

let discord;
try {
  discord = require('../discord_channels');
} catch (e) {
  console.warn('[MemoryManager] Discord channels not available:', e.message);
}

let dedup;
try {
  dedup = require('../../utils/memory_dedup');
} catch (e) {
  console.warn('[MemoryManager] memory_dedup not available:', e.message);
}

// --- Constants ---

const MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || os.homedir(),
  '.claude',
  'projects',
  'C--Users-YOUR_USERNAME-Documents-Github-teleclaude-main',
  'memory'
);

const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

const STATE_FILE = path.join(__dirname, '..', 'data', 'memory_manager_state.json');
const AGENT_STATE_FILE = path.join(__dirname, '..', 'data', 'agent_state.json');
const TRADING_DATA_DIR = path.join(__dirname, '..', 'data');

/** Per-file line limits. Files not listed here default to 300. */
const FILE_SIZE_LIMITS = {
  'MEMORY.md': 200,
  'lvl3quant.md': 300,
  'infrastructure.md': 200,
  'teleclaude.md': 200,
  'INDEX.md': 150,
  'CONVENTIONS.md': 400,
};

const DEFAULT_LINE_LIMIT = 300;

/** Staleness threshold in hours */
const STALENESS_HOURS = 24;

/** Session log archive threshold in days */
const SESSION_ARCHIVE_DAYS = 30;


// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Read and parse the state file, returning defaults if missing/corrupt.
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[MemoryManager] Could not load state file:', e.message);
  }
  return {
    lastRun: null,
    healthScore: 100,
    pendingProposals: [],
    lastReport: null,
  };
}

/**
 * Persist state to disk (atomic-ish write via temp file).
 */
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[MemoryManager] Failed to save state:', e.message);
  }
}

/**
 * Get current ISO timestamp string.
 */
function now() {
  return new Date().toISOString();
}

/**
 * Parse a date string from memory file content. Handles formats like:
 *   *Last updated: 2026-02-25*
 *   *Last updated: 2026-02-26 04:40*
 *   Last Updated | 2026-02-25
 * Returns Date object or null.
 */
function parseTimestamp(text) {
  // Match YYYY-MM-DD with optional HH:MM
  const match = text.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
  if (!match) return null;
  const dateStr = match[1];
  const timeStr = match[2] || '00:00';
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Calculate hours elapsed since a given date.
 */
function hoursAgo(date) {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

/**
 * Read all .md files in the memory directory (non-recursive, top level only).
 * Returns array of { name, filePath, content, lines, lineCount }.
 */
function readMemoryFiles() {
  const results = [];
  try {
    const entries = fs.readdirSync(MEMORY_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const filePath = path.join(MEMORY_DIR, entry.name);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          results.push({
            name: entry.name,
            filePath,
            content,
            lines,
            lineCount: lines.length,
          });
        } catch (e) {
          // Skip unreadable files
        }
      }
    }
  } catch (e) {
    console.error('[MemoryManager] Failed to read memory directory:', e.message);
  }
  return results;
}


// ============================================================================
// MemoryManager Class
// ============================================================================

class MemoryManager {
  constructor() {
    this.name = 'Memory Manager';
    this.emoji = '\uD83E\uDDE0'; // brain emoji
    this.lastRun = null;
    this.memoryDir = MEMORY_DIR;
    this.state = loadState();
  }

  // --------------------------------------------------------------------------
  // Main Entry Point
  // --------------------------------------------------------------------------

  /**
   * Run the full memory health check pipeline.
   * Returns a structured health report object.
   */
  async run() {
    const startTime = Date.now();
    console.log(`[${now()}] ${this.emoji} Memory Manager starting health check...`);

    try {
      // Run all checks in parallel where possible
      const [staleness, dedupResult, fileSizes, indexCheck, sessionCheck, tasksAndJobs] = await Promise.all([
        this.checkStaleness(),
        this.checkDedup(),
        this.checkFileSizes(),
        this.checkIndex(),
        this.checkSessionLogs(),
        this.checkTasksAndJobs(),
      ]);

      // Generate the aggregated health report
      const report = await this.generateHealthReport({
        staleness,
        dedup: dedupResult,
        fileSizes,
        index: indexCheck,
        sessions: sessionCheck,
        tasksAndJobs,
      });

      // Run LLM analysis on the report (non-critical, wrapped in try/catch)
      let llmRecommendations = null;
      try {
        llmRecommendations = await this.getLLMRecommendations(report);
        report.llmRecommendations = llmRecommendations;
      } catch (e) {
        console.warn('[MemoryManager] LLM analysis skipped:', e.message);
        report.llmRecommendations = null;
      }

      // Update state
      this.state.lastRun = now();
      this.state.healthScore = report.healthScore;
      this.state.lastReport = report;
      this.lastRun = new Date();
      saveState(this.state);

      const elapsed = Date.now() - startTime;
      console.log(`[${now()}] ${this.emoji} Memory Manager completed in ${elapsed}ms (health: ${report.healthScore}/100)`);

      return report;

    } catch (e) {
      console.error(`[${now()}] ${this.emoji} Memory Manager FAILED:`, e.message);
      this.state.lastRun = now();
      saveState(this.state);
      throw e;
    }
  }

  // --------------------------------------------------------------------------
  // 1. Staleness Detection
  // --------------------------------------------------------------------------

  /**
   * Scan all memory files for sections with timestamps older than 24h.
   * Focuses on meaningful section-level staleness, not individual table rows.
   * Returns { staleCount, staleSections: [{ file, section, lastUpdated, hoursStale }] }
   */
  async checkStaleness() {
    const files = readMemoryFiles();
    const staleSections = [];

    // Track which file+section combos we've already recorded to avoid duplicates
    const seen = new Set();

    for (const file of files) {
      let currentSection = null;
      let inStalenessTable = false;

      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i];

        // Detect section headers (## or ###)
        const headerMatch = line.match(/^(#{2,3})\s+(.+)/);
        if (headerMatch) {
          currentSection = headerMatch[2].trim();
          // Detect the STALENESS MARKERS table specifically
          inStalenessTable = /staleness markers/i.test(currentSection);
          continue;
        }

        // Detect inline timestamp markers (the primary staleness signal)
        // Patterns: *Last updated: YYYY-MM-DD* or *Last updated: YYYY-MM-DD HH:MM*
        const tsMatch = line.match(/\*(?:Last updated|Updated):?\s*(.+?)\*/i);
        if (tsMatch) {
          const date = parseTimestamp(tsMatch[1]);
          if (date) {
            const hours = hoursAgo(date);
            if (hours > STALENESS_HOURS) {
              const key = `${file.name}::${currentSection || '(top-level)'}`;
              if (!seen.has(key)) {
                seen.add(key);
                staleSections.push({
                  file: file.name,
                  section: currentSection || '(top-level)',
                  lastUpdated: date.toISOString(),
                  hoursStale: Math.round(hours),
                  line: i + 1,
                });
              }
            }
          }
        }

        // Check STALENESS MARKERS table rows in MEMORY.md
        // These are the authoritative per-section timestamps
        // Format: | PROJECTS | 2026-02-25 | ... |
        if (inStalenessTable && file.name === 'MEMORY.md') {
          const tableMatch = line.match(/^\|\s*([A-Z][A-Z ]+?)\s*\|\s*(\d{4}-\d{2}-\d{2}[\s\d:]*)\s*\|/);
          if (tableMatch) {
            const sectionName = tableMatch[1].trim();
            const date = parseTimestamp(tableMatch[2]);
            if (date) {
              const hours = hoursAgo(date);
              if (hours > STALENESS_HOURS) {
                const key = `${file.name}::${sectionName}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  staleSections.push({
                    file: file.name,
                    section: sectionName,
                    lastUpdated: date.toISOString(),
                    hoursStale: Math.round(hours),
                    line: i + 1,
                  });
                }
              }
            }
          }
        }
      }
    }

    return {
      staleCount: staleSections.length,
      staleSections,
    };
  }

  // --------------------------------------------------------------------------
  // 2. Deduplication Check
  // --------------------------------------------------------------------------

  /**
   * Run the existing dedup tool and return its results.
   * Returns { contradictionCount, duplicateCount, contradictions, summary }
   */
  async checkDedup() {
    if (!dedup || !dedup.runDedup) {
      return {
        contradictionCount: 0,
        duplicateCount: 0,
        contradictions: [],
        summary: 'Dedup module not available',
        error: true,
      };
    }

    try {
      const report = dedup.runDedup(this.memoryDir);
      return {
        contradictionCount: report.contradictions.length,
        duplicateCount: report.duplicates.length,
        contradictions: report.contradictions,
        summary: report.summary,
        error: false,
      };
    } catch (e) {
      console.error('[MemoryManager] Dedup check failed:', e.message);
      return {
        contradictionCount: 0,
        duplicateCount: 0,
        contradictions: [],
        summary: `Dedup failed: ${e.message}`,
        error: true,
      };
    }
  }

  // --------------------------------------------------------------------------
  // 3. File Size Enforcement
  // --------------------------------------------------------------------------

  /**
   * Check each memory file against its size limit.
   * Returns { oversizedCount, oversizedFiles: [{ file, lineCount, limit, overage }] }
   */
  async checkFileSizes() {
    const files = readMemoryFiles();
    const oversizedFiles = [];

    for (const file of files) {
      const limit = FILE_SIZE_LIMITS[file.name] || DEFAULT_LINE_LIMIT;
      if (file.lineCount > limit) {
        oversizedFiles.push({
          file: file.name,
          lineCount: file.lineCount,
          limit,
          overage: file.lineCount - limit,
        });
      }
    }

    return {
      oversizedCount: oversizedFiles.length,
      oversizedFiles,
    };
  }

  // --------------------------------------------------------------------------
  // 4. Index Verification
  // --------------------------------------------------------------------------

  /**
   * Check that INDEX.md references match actual files on disk.
   * Returns { missingFiles, orphanFiles, missingCount, orphanCount }
   */
  async checkIndex() {
    const result = {
      missingFiles: [],   // Referenced in INDEX.md but not on disk
      orphanFiles: [],    // On disk but not referenced in INDEX.md
      missingCount: 0,
      orphanCount: 0,
    };

    // Read INDEX.md
    const indexPath = path.join(this.memoryDir, 'INDEX.md');
    let indexContent = '';
    try {
      indexContent = fs.readFileSync(indexPath, 'utf8');
    } catch (e) {
      result.missingFiles.push({ file: 'INDEX.md', reason: 'INDEX.md itself does not exist' });
      result.missingCount = 1;
      return result;
    }

    // Extract file references from INDEX.md
    // Matches patterns like: | MEMORY.md | ... or MEMORY.md:10 or `memory/lvl3quant.md`
    const referencedFiles = new Set();
    const fileRefPattern = /(?:^|\s|\|)([A-Za-z_][\w-]*\.md)(?:\s|\||:|$)/gm;
    let match;
    while ((match = fileRefPattern.exec(indexContent)) !== null) {
      referencedFiles.add(match[1]);
    }

    // Also catch session directory reference
    const hasSessionRef = /sessions?\//i.test(indexContent);

    // Get actual files on disk
    const actualFiles = new Set();
    try {
      const entries = fs.readdirSync(this.memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          actualFiles.add(entry.name);
        }
      }
    } catch (e) {
      // Can't read directory — report as error
    }

    // Check for files referenced but missing on disk
    for (const ref of referencedFiles) {
      // Skip self-references to INDEX.md
      if (ref === 'INDEX.md') continue;
      if (!actualFiles.has(ref)) {
        result.missingFiles.push({
          file: ref,
          reason: 'Referenced in INDEX.md but not found on disk',
        });
      }
    }

    // Check for files on disk but not referenced in INDEX.md
    for (const actual of actualFiles) {
      if (actual === 'INDEX.md') continue;
      if (!referencedFiles.has(actual)) {
        result.orphanFiles.push({
          file: actual,
          reason: 'Exists on disk but not referenced in INDEX.md',
        });
      }
    }

    // Check sessions directory exists if referenced
    if (hasSessionRef) {
      if (!fs.existsSync(SESSIONS_DIR)) {
        result.missingFiles.push({
          file: 'sessions/',
          reason: 'Sessions directory referenced but does not exist',
        });
      }
    }

    result.missingCount = result.missingFiles.length;
    result.orphanCount = result.orphanFiles.length;
    return result;
  }

  // --------------------------------------------------------------------------
  // 5. Session Log Maintenance
  // --------------------------------------------------------------------------

  /**
   * Check session logs. Identify logs older than 30 days that could be archived.
   * NEVER deletes — only identifies candidates.
   * Returns { totalLogs, archiveCandidates: [{ file, date, ageDays }], totalLines }
   */
  async checkSessionLogs() {
    const result = {
      totalLogs: 0,
      archiveCandidates: [],
      totalLines: 0,
    };

    if (!fs.existsSync(SESSIONS_DIR)) {
      return result;
    }

    try {
      const entries = fs.readdirSync(SESSIONS_DIR).filter(
        f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f)
      );

      result.totalLogs = entries.length;
      const cutoff = Date.now() - (SESSION_ARCHIVE_DAYS * 24 * 60 * 60 * 1000);

      for (const entry of entries) {
        const dateStr = entry.replace('.md', '');
        const date = new Date(dateStr + 'T00:00:00');

        // Count lines
        try {
          const content = fs.readFileSync(path.join(SESSIONS_DIR, entry), 'utf8');
          result.totalLines += content.split('\n').length;
        } catch (e) {
          // Skip unreadable
        }

        if (!isNaN(date.getTime()) && date.getTime() < cutoff) {
          const ageDays = Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
          result.archiveCandidates.push({
            file: entry,
            date: dateStr,
            ageDays,
          });
        }
      }
    } catch (e) {
      console.error('[MemoryManager] Session log check failed:', e.message);
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // 6. Task & Job Tracking
  // --------------------------------------------------------------------------

  /**
   * Scan agent states, compute job files, and cross-reference with memory
   * to ensure completed work has its results persisted.
   *
   * Checks:
   *   - agent_state.json: all agent last-run times and statuses
   *   - Data files: daily_reports, research_picks, quant scores, etc.
   *   - Cross-reference: are recent completed results captured in memory?
   *
   * Returns { agents, jobs, unpersistedResults }
   */
  async checkTasksAndJobs() {
    const result = {
      agentCount: 0,
      agentsRunning: 0,
      agentsErrored: 0,
      agentsIdle: 0,
      agents: [],
      dataFiles: [],
      unpersistedCount: 0,
      unpersisted: [],
    };

    // 1. Read agent_state.json
    try {
      if (fs.existsSync(AGENT_STATE_FILE)) {
        const stateData = JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8'));
        const agents = stateData.agents || {};

        for (const [name, info] of Object.entries(agents)) {
          const status = info.status || 'unknown';
          const lastRun = info.lastRun ? new Date(info.lastRun) : null;
          const hoursAgoVal = lastRun ? hoursAgo(lastRun) : null;

          result.agents.push({
            name,
            status,
            lastRun: info.lastRun || null,
            hoursAgo: hoursAgoVal ? Math.round(hoursAgoVal) : null,
            error: info.error || null,
          });

          result.agentCount++;
          if (status === 'error') result.agentsErrored++;
          else if (status === 'success' || status === 'running') result.agentsRunning++;
          else result.agentsIdle++;
        }
      }
    } catch (e) {
      console.warn('[MemoryManager] Could not read agent_state.json:', e.message);
    }

    // 2. Scan trading data files for recent results
    const DATA_FILES_TO_CHECK = [
      { file: 'daily_context.json', label: 'Daily Context' },
      { file: 'research_picks.json', label: 'Research Picks' },
      { file: 'quant_swing_scores.json', label: 'Quant Swing Scores' },
      { file: 'quant_swing_state.json', label: 'Quant Swing State' },
      { file: 'vol_regime_state.json', label: 'Vol Regime State' },
      { file: 'es_micro_state.json', label: 'ES Micro State' },
      { file: 'alert_state.json', label: 'Alert State' },
      { file: 'macro_alpha_scores.json', label: 'Macro Alpha Scores' },
    ];

    for (const { file, label } of DATA_FILES_TO_CHECK) {
      const filePath = path.join(TRADING_DATA_DIR, file);
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
          result.dataFiles.push({
            file,
            label,
            lastModified: stat.mtime.toISOString(),
            ageHours: Math.round(ageHours),
            sizeBytes: stat.size,
          });
        }
      } catch (e) {
        // Skip unreadable files
      }
    }

    // 3. Check daily report directory for recent reports
    const dailyReportsDir = path.join(TRADING_DATA_DIR, 'daily_reports');
    try {
      if (fs.existsSync(dailyReportsDir)) {
        const reports = fs.readdirSync(dailyReportsDir)
          .filter(f => f.endsWith('.json'))
          .sort()
          .reverse()
          .slice(0, 5);

        for (const reportFile of reports) {
          const stat = fs.statSync(path.join(dailyReportsDir, reportFile));
          result.dataFiles.push({
            file: `daily_reports/${reportFile}`,
            label: 'Daily Report',
            lastModified: stat.mtime.toISOString(),
            ageHours: Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60)),
            sizeBytes: stat.size,
          });
        }
      }
    } catch (e) {
      // Skip
    }

    // 4. Cross-reference: check if recent agent errors/completions are in memory
    // Read memory files to see if they mention recent agent results
    const memoryFiles = readMemoryFiles();
    const memoryContent = memoryFiles.map(f => f.content).join('\n').toLowerCase();

    // Flag agents that errored recently but aren't mentioned in memory
    for (const agent of result.agents) {
      if (agent.status === 'error' && agent.hoursAgo !== null && agent.hoursAgo < 24) {
        const agentNameLower = agent.name.toLowerCase();
        if (!memoryContent.includes(agentNameLower) || !memoryContent.includes('error')) {
          result.unpersisted.push({
            type: 'AGENT_ERROR',
            name: agent.name,
            detail: `Agent "${agent.name}" errored ${agent.hoursAgo}h ago: ${agent.error || 'unknown error'}`,
            action: 'Record error in session log or memory file',
          });
        }
      }
    }

    // Flag data files that were modified recently (< 4h) but may not be reflected in memory
    for (const df of result.dataFiles) {
      if (df.ageHours < 4 && df.sizeBytes > 100) {
        const labelLower = df.label.toLowerCase();
        // Check if the corresponding result type is mentioned with a recent date in memory
        if (!memoryContent.includes(labelLower)) {
          result.unpersisted.push({
            type: 'RECENT_DATA',
            name: df.file,
            detail: `${df.label} (${df.file}) updated ${df.ageHours}h ago but not found in memory`,
            action: 'Consider logging key results to session log',
          });
        }
      }
    }

    result.unpersistedCount = result.unpersisted.length;
    return result;
  }

  // --------------------------------------------------------------------------
  // 7. Health Report Generation
  // --------------------------------------------------------------------------

  /**
   * Aggregate all check results into a structured health report.
   * Computes a health score 0-100 based on issues found.
   */
  async generateHealthReport({ staleness, dedup, fileSizes, index, sessions, tasksAndJobs }) {
    // Compute total memory stats
    const files = readMemoryFiles();
    const totalFiles = files.length;
    const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);

    // Build recommendations list
    const recommendations = [];

    // Staleness recommendations
    for (const stale of staleness.staleSections) {
      recommendations.push({
        type: 'STALE',
        severity: stale.hoursStale > 72 ? 'HIGH' : 'MEDIUM',
        message: `${stale.file} section "${stale.section}" is ${stale.hoursStale}h stale (line ${stale.line})`,
        action: `Update timestamp and verify content in ${stale.file}`,
      });
    }

    // Contradiction recommendations
    for (const contradiction of (dedup.contradictions || [])) {
      recommendations.push({
        type: 'CONTRADICTION',
        severity: 'HIGH',
        message: `"${contradiction.label}" has conflicting values across files`,
        action: `Resolve: ${contradiction.values.map(v => `${v.file}:${v.lineNumber} = "${v.value}"`).join(' vs ')}`,
      });
    }

    // Oversized file recommendations
    for (const oversized of fileSizes.oversizedFiles) {
      recommendations.push({
        type: 'OVERSIZED',
        severity: oversized.overage > 100 ? 'HIGH' : 'MEDIUM',
        message: `${oversized.file} is ${oversized.lineCount} lines (limit: ${oversized.limit}, over by ${oversized.overage})`,
        action: `Archive or consolidate content in ${oversized.file} to bring under ${oversized.limit} lines`,
      });
    }

    // Index recommendations
    for (const missing of index.missingFiles) {
      recommendations.push({
        type: 'MISSING_FILE',
        severity: 'MEDIUM',
        message: `${missing.file}: ${missing.reason}`,
        action: `Remove stale reference from INDEX.md or restore the file`,
      });
    }
    for (const orphan of index.orphanFiles) {
      recommendations.push({
        type: 'ORPHAN_FILE',
        severity: 'LOW',
        message: `${orphan.file}: ${orphan.reason}`,
        action: `Add reference to INDEX.md or consider archiving`,
      });
    }

    // Session log recommendations
    for (const candidate of sessions.archiveCandidates) {
      recommendations.push({
        type: 'ARCHIVE_SESSION',
        severity: 'LOW',
        message: `Session log ${candidate.file} is ${candidate.ageDays} days old`,
        action: `Archive to sessions/archive/ or compress`,
      });
    }

    // Task & Job recommendations
    if (tasksAndJobs) {
      for (const item of (tasksAndJobs.unpersisted || [])) {
        recommendations.push({
          type: item.type === 'AGENT_ERROR' ? 'AGENT_ERROR' : 'UNPERSISTED_RESULT',
          severity: item.type === 'AGENT_ERROR' ? 'HIGH' : 'MEDIUM',
          message: item.detail,
          action: item.action,
        });
      }

      // Flag agents that haven't run in >6 hours during market hours
      for (const agent of (tasksAndJobs.agents || [])) {
        if (agent.hoursAgo !== null && agent.hoursAgo > 6 && agent.status !== 'disabled') {
          recommendations.push({
            type: 'AGENT_STALE',
            severity: 'MEDIUM',
            message: `Agent "${agent.name}" last ran ${agent.hoursAgo}h ago`,
            action: `Check if ${agent.name} should be running — may need restart`,
          });
        }
      }
    }

    // --- Health Score Calculation ---
    // Start at 100, deduct for issues. Each category has a max deduction cap
    // to prevent a single noisy category from dominating the score.
    let healthScore = 100;

    // Staleness: -2 per stale section, capped at -20
    const stalenessDeduction = Math.min(20, staleness.staleCount * 2);
    healthScore -= stalenessDeduction;

    // Contradictions: -8 each, capped at -30 (these are serious)
    const contradictionDeduction = Math.min(30, (dedup.contradictionCount || 0) * 8);
    healthScore -= contradictionDeduction;

    // Oversized files: -5 per file, capped at -15
    const oversizedDeduction = Math.min(15, fileSizes.oversizedCount * 5);
    healthScore -= oversizedDeduction;

    // Missing index entries: -3 each, capped at -10
    const missingDeduction = Math.min(10, index.missingCount * 3);
    healthScore -= missingDeduction;

    // Orphan files (lower severity): -1 each, capped at -5
    const orphanDeduction = Math.min(5, index.orphanCount * 1);
    healthScore -= orphanDeduction;

    // Dedup module error: -5 (can't verify integrity)
    if (dedup.error) healthScore -= 5;

    // Clamp to 0-100
    healthScore = Math.max(0, Math.min(100, healthScore));

    const report = {
      timestamp: now(),
      healthScore,
      summary: {
        totalFiles,
        totalLines,
        sessionLogs: sessions.totalLogs,
        sessionLogLines: sessions.totalLines,
      },
      staleness: {
        staleCount: staleness.staleCount,
        sections: staleness.staleSections,
      },
      dedup: {
        contradictionCount: dedup.contradictionCount,
        duplicateCount: dedup.duplicateCount,
        error: dedup.error || false,
      },
      fileSizes: {
        oversizedCount: fileSizes.oversizedCount,
        files: fileSizes.oversizedFiles,
      },
      index: {
        missingCount: index.missingCount,
        orphanCount: index.orphanCount,
        missingFiles: index.missingFiles,
        orphanFiles: index.orphanFiles,
      },
      sessions: {
        totalLogs: sessions.totalLogs,
        archiveCandidateCount: sessions.archiveCandidates.length,
        archiveCandidates: sessions.archiveCandidates,
      },
      tasksAndJobs: tasksAndJobs ? {
        agentCount: tasksAndJobs.agentCount,
        agentsRunning: tasksAndJobs.agentsRunning,
        agentsErrored: tasksAndJobs.agentsErrored,
        agentsIdle: tasksAndJobs.agentsIdle,
        dataFilesTracked: tasksAndJobs.dataFiles.length,
        unpersistedCount: tasksAndJobs.unpersistedCount,
        unpersisted: tasksAndJobs.unpersisted,
      } : null,
      recommendations,
      recommendationCount: recommendations.length,
      llmRecommendations: null, // Populated later if LLM is available
    };

    return report;
  }

  // --------------------------------------------------------------------------
  // 7. LLM-Powered Analysis
  // --------------------------------------------------------------------------

  /**
   * Use Groq (free) to analyze the health report and produce natural language
   * recommendations. Falls back through providers via callLLMWithFallback.
   */
  async getLLMRecommendations(report) {
    if (!reasoning || !reasoning.callLLMWithFallback) {
      throw new Error('LLM reasoning module not available');
    }

    // Build a compact summary for the LLM (avoid sending full file contents)
    const summaryForLLM = {
      healthScore: report.healthScore,
      totalFiles: report.summary.totalFiles,
      totalLines: report.summary.totalLines,
      staleCount: report.staleness.staleCount,
      staleSections: report.staleness.sections.map(s => `${s.file}/"${s.section}" (${s.hoursStale}h)`),
      contradictions: report.dedup.contradictionCount,
      duplicates: report.dedup.duplicateCount,
      oversizedFiles: report.fileSizes.files.map(f => `${f.file}: ${f.lineCount}/${f.limit}`),
      missingIndexRefs: report.index.missingFiles.map(f => f.file),
      orphanFiles: report.index.orphanFiles.map(f => f.file),
      sessionArchiveCandidates: report.sessions.archiveCandidateCount,
      recommendationCount: report.recommendationCount,
    };

    const prompt = `You are a memory system health analyst for a trading AI platform.

Analyze this memory health report and provide 3-5 actionable recommendations, prioritized by impact.

HEALTH REPORT:
${JSON.stringify(summaryForLLM, null, 2)}

CONTEXT:
- Memory files store project state, infrastructure info, strategy results, and session logs
- MEMORY.md is the main navigation hub (200 line limit)
- lvl3quant.md tracks a quantitative trading research project (300 line limit)
- Session logs are daily append-only files in sessions/
- Contradictions are the most dangerous issue (can cause wrong decisions)
- Stale sections may lead to acting on outdated compute/strategy info

Respond in this JSON format:
{
  "overallAssessment": "1-2 sentence summary",
  "topPriority": "Single most important thing to fix",
  "recommendations": [
    { "priority": 1, "action": "what to do", "reason": "why it matters" }
  ]
}`;

    const result = await reasoning.callLLMWithFallback([
      {
        role: 'system',
        content: 'You are a concise technical analyst. Respond only with the requested JSON. No markdown fences.',
      },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.2,
      maxTokens: 512,
    });

    // Parse response
    try {
      // Try direct JSON parse first
      return JSON.parse(result.content);
    } catch (e) {
      // Extract JSON from response if wrapped in other text
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      // Return raw text if parsing fails
      return { rawResponse: result.content, provider: result.provider };
    }
  }

  // --------------------------------------------------------------------------
  // Discord Reporting
  // --------------------------------------------------------------------------

  /**
   * Format and send a health report summary to #system-status.
   * Sends a concise Discord-friendly message.
   */
  async reportToDiscord(report) {
    if (!discord) {
      console.warn('[MemoryManager] Discord not available, skipping report');
      return;
    }

    const scoreEmoji = report.healthScore >= 90 ? '\u2705'   // green check
      : report.healthScore >= 70 ? '\u26A0\uFE0F'           // warning
      : '\u274C';                                            // red X

    const lines = [
      `${this.emoji} **Memory Health Report** ${scoreEmoji} Score: ${report.healthScore}/100`,
      '',
      `**Files:** ${report.summary.totalFiles} files, ${report.summary.totalLines} lines | **Sessions:** ${report.summary.sessionLogs} logs`,
    ];

    // Issues summary
    const issues = [];
    if (report.staleness.staleCount > 0) {
      issues.push(`${report.staleness.staleCount} stale section(s)`);
    }
    if (report.dedup.contradictionCount > 0) {
      issues.push(`${report.dedup.contradictionCount} contradiction(s)`);
    }
    if (report.fileSizes.oversizedCount > 0) {
      issues.push(`${report.fileSizes.oversizedCount} oversized file(s)`);
    }
    if (report.index.missingCount > 0) {
      issues.push(`${report.index.missingCount} missing index ref(s)`);
    }
    if (report.index.orphanCount > 0) {
      issues.push(`${report.index.orphanCount} orphan file(s)`);
    }
    if (report.sessions.archiveCandidateCount > 0) {
      issues.push(`${report.sessions.archiveCandidateCount} session(s) to archive`);
    }

    if (issues.length > 0) {
      lines.push(`**Issues:** ${issues.join(' | ')}`);
    } else {
      lines.push('**Issues:** None found');
    }

    // Top recommendations (max 3 for Discord brevity)
    const topRecs = report.recommendations
      .filter(r => r.severity === 'HIGH')
      .slice(0, 3);

    if (topRecs.length > 0) {
      lines.push('');
      lines.push('**Top Issues:**');
      for (const rec of topRecs) {
        lines.push(`- [${rec.type}] ${rec.message}`);
      }
    }

    // LLM recommendation if available
    if (report.llmRecommendations && report.llmRecommendations.topPriority) {
      lines.push('');
      lines.push(`**AI Priority:** ${report.llmRecommendations.topPriority}`);
    }

    const message = lines.join('\n');

    try {
      await discord.send('memoryHealth', message);
      console.log('[MemoryManager] Health report sent to #memory-health');
    } catch (e) {
      console.error('[MemoryManager] Failed to send Discord report:', e.message);
    }
  }

  // --------------------------------------------------------------------------
  // Proposal Management
  // --------------------------------------------------------------------------

  /**
   * Add a proposed edit to the pending proposals list.
   * Proposals are NOT executed — they await orchestrator approval.
   *
   * @param {string} type - 'EDIT' | 'ARCHIVE' | 'DELETE' | 'CONSOLIDATE'
   * @param {string} targetFile - File to modify
   * @param {string} description - What the proposal does
   * @param {object} [details] - Additional details (line numbers, new content, etc.)
   */
  addProposal(type, targetFile, description, details = {}) {
    const proposal = {
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      targetFile,
      description,
      details,
      createdAt: now(),
      status: 'PENDING', // PENDING | APPROVED | REJECTED | EXECUTED
    };

    this.state.pendingProposals.push(proposal);
    saveState(this.state);

    console.log(`[MemoryManager] Proposal added: [${type}] ${targetFile} — ${description}`);
    return proposal;
  }

  /**
   * Get all pending proposals.
   */
  getPendingProposals() {
    return this.state.pendingProposals.filter(p => p.status === 'PENDING');
  }

  /**
   * Mark a proposal as approved/rejected by the orchestrator.
   */
  updateProposal(proposalId, status) {
    const proposal = this.state.pendingProposals.find(p => p.id === proposalId);
    if (proposal) {
      proposal.status = status;
      proposal.updatedAt = now();
      saveState(this.state);
    }
    return proposal;
  }

  /**
   * Clear all completed (approved/rejected/executed) proposals.
   */
  clearCompletedProposals() {
    this.state.pendingProposals = this.state.pendingProposals.filter(
      p => p.status === 'PENDING'
    );
    saveState(this.state);
  }

  // --------------------------------------------------------------------------
  // Convenience / Query Methods
  // --------------------------------------------------------------------------

  /**
   * Get the last health report without re-running checks.
   */
  getLastReport() {
    return this.state.lastReport;
  }

  /**
   * Get current health score without re-running checks.
   */
  getHealthScore() {
    return this.state.healthScore;
  }

  /**
   * Quick status for the scheduler / other agents.
   */
  getStatus() {
    return {
      name: this.name,
      lastRun: this.state.lastRun,
      healthScore: this.state.healthScore,
      pendingProposals: this.getPendingProposals().length,
    };
  }

  /**
   * Reset daily state (called by scheduler at midnight if needed).
   */
  resetDaily() {
    // Clear old completed proposals (keep pending)
    this.clearCompletedProposals();
    console.log(`[MemoryManager] Daily reset complete`);
  }
}


// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
  const mgr = new MemoryManager();
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'run' || !cmd) {
    mgr.run().then(report => {
      console.log('\n' + JSON.stringify(report, null, 2));
    }).catch(e => {
      console.error('Run failed:', e.message);
      process.exit(1);
    });
  } else if (cmd === 'staleness') {
    mgr.checkStaleness().then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (cmd === 'dedup') {
    mgr.checkDedup().then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (cmd === 'sizes') {
    mgr.checkFileSizes().then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (cmd === 'index') {
    mgr.checkIndex().then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (cmd === 'sessions') {
    mgr.checkSessionLogs().then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (cmd === 'status') {
    console.log(JSON.stringify(mgr.getStatus(), null, 2));
  } else if (cmd === 'proposals') {
    console.log(JSON.stringify(mgr.getPendingProposals(), null, 2));
  } else if (cmd === 'report') {
    // Send last report to Discord
    const report = mgr.getLastReport();
    if (report) {
      mgr.reportToDiscord(report).then(() => console.log('Report sent.'));
    } else {
      console.log('No report available. Run health check first.');
    }
  } else {
    console.log('Usage: node memory_manager.js [run|staleness|dedup|sizes|index|sessions|status|proposals|report]');
  }
}

module.exports = MemoryManager;
