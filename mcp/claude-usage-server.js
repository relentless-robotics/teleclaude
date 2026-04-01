#!/usr/bin/env node
/**
 * Claude Code Usage MCP Server
 *
 * Reads ~/.claude/projects/**\/*.jsonl files and aggregates token usage
 * from assistant message records. Deduplicates by message ID.
 *
 * Tools:
 *   claude_usage_today   — token usage for today (last 24 h)
 *   claude_usage_summary — usage breakdown by model for past N days
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ── Config ───────────────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:/Users/Footb',
  '.claude', 'projects',
);

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = path.join(LOGS_DIR, `mcp-claude-usage-${new Date().toISOString().split('T')[0]}.log`);

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg, data) {
  const ts   = new Date().toISOString();
  let   line = `[${ts}] [${level}] ${msg}`;
  if (data !== undefined) {
    try { line += `\n  ${JSON.stringify(data)}`; } catch (_) {}
  }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function walkJsonl(dir) {
  let files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(walkJsonl(full));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  } catch { /* skip unreadable */ }
  return files;
}

function newBucket() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, messages: 0 };
}

function addToModel(byModel, model, inp, out, cw, cr, total) {
  const key = model || 'unknown';
  if (!byModel[key]) byModel[key] = newBucket();
  byModel[key].input         += inp;
  byModel[key].output        += out;
  byModel[key].cacheCreation += cw;
  byModel[key].cacheRead     += cr;
  byModel[key].total         += total;
  byModel[key].messages      += 1;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Core scrape ───────────────────────────────────────────────────────────────

/**
 * Scrape all .jsonl files and return per-message records within cutoffMs.
 * Returns { totals, byModel, filesScanned, uniqueMessages, parseErrors }.
 */
function scrape(cutoffMs) {
  const now    = Date.now();
  const cutoff = now - cutoffMs;
  const files  = walkJsonl(CLAUDE_PROJECTS_DIR);
  const seen   = new Set();

  const totals  = newBucket();
  const byModel = {};
  let   filesScanned  = 0;
  let   parseErrors   = 0;

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    filesScanned++;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }

      if (rec.type !== 'assistant') continue;
      const msg = rec.message;
      if (!msg || typeof msg !== 'object') continue;
      const usage = msg.usage;
      if (!usage) continue;
      const msgId = msg.id;
      if (!msgId || seen.has(msgId)) continue;

      let ts = null;
      try { const d = new Date(rec.timestamp); if (!isNaN(d)) ts = d.getTime(); } catch {}
      if (!ts || ts < cutoff) continue;

      seen.add(msgId);

      const inp   = usage.input_tokens                || 0;
      const out   = usage.output_tokens               || 0;
      const cw    = usage.cache_creation_input_tokens || 0;
      const cr    = usage.cache_read_input_tokens     || 0;
      const total = inp + out + cw + cr;
      const model = msg.model || 'unknown';

      totals.input         += inp;
      totals.output        += out;
      totals.cacheCreation += cw;
      totals.cacheRead     += cr;
      totals.total         += total;
      totals.messages      += 1;

      addToModel(byModel, model, inp, out, cw, cr, total);
    }
  }

  return { totals, byModel, filesScanned, uniqueMessages: seen.size, parseErrors };
}

/**
 * Scrape for per-day breakdowns over the past `days` days.
 * Returns array of { date, totals, byModel }.
 */
function scrapeByDay(days) {
  const now   = Date.now();
  const files = walkJsonl(CLAUDE_PROJECTS_DIR);
  const seen  = new Set();

  const cutoff = now - days * 24 * 60 * 60 * 1000;

  // Bucket by date string "YYYY-MM-DD"
  const dateMap = {};   // date → { totals, byModel }
  let   parseErrors = 0;
  let   filesScanned = 0;

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    filesScanned++;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }

      if (rec.type !== 'assistant') continue;
      const msg = rec.message;
      if (!msg || typeof msg !== 'object') continue;
      const usage = msg.usage;
      if (!usage) continue;
      const msgId = msg.id;
      if (!msgId || seen.has(msgId)) continue;

      let ts = null;
      try { const d = new Date(rec.timestamp); if (!isNaN(d)) ts = d.getTime(); } catch {}
      if (!ts || ts < cutoff) continue;

      seen.add(msgId);

      const inp   = usage.input_tokens                || 0;
      const out   = usage.output_tokens               || 0;
      const cw    = usage.cache_creation_input_tokens || 0;
      const cr    = usage.cache_read_input_tokens     || 0;
      const total = inp + out + cw + cr;
      const model = msg.model || 'unknown';

      // Local date string
      const dt   = new Date(ts);
      const date = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;

      if (!dateMap[date]) dateMap[date] = { totals: newBucket(), byModel: {} };
      const bucket = dateMap[date];
      bucket.totals.input         += inp;
      bucket.totals.output        += out;
      bucket.totals.cacheCreation += cw;
      bucket.totals.cacheRead     += cr;
      bucket.totals.total         += total;
      bucket.totals.messages      += 1;
      addToModel(bucket.byModel, model, inp, out, cw, cr, total);
    }
  }

  // Return sorted most-recent first
  const rows = Object.entries(dateMap)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, data]) => ({ date, ...data }));

  return { rows, filesScanned, uniqueMessages: seen.size, parseErrors };
}

// ── Tool implementations ──────────────────────────────────────────────────────

function claude_usage_today() {
  const windowMs = 24 * 60 * 60 * 1000;
  const { totals, byModel, filesScanned, uniqueMessages, parseErrors } = scrape(windowMs);

  // Next UTC midnight reset
  const now = new Date();
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

  return {
    window: 'last_24h',
    generatedAt: new Date().toISOString(),
    resetAt,
    filesScanned,
    uniqueMessages,
    parseErrors,
    totals,
    byModel,
  };
}

function claude_usage_summary({ days } = {}) {
  const numDays = Math.max(1, Math.min(parseInt(days) || 7, 90));
  const { rows, filesScanned, uniqueMessages, parseErrors } = scrapeByDay(numDays);

  // Aggregate totals across all days for a grand summary
  const grand = newBucket();
  const grandByModel = {};
  for (const row of rows) {
    grand.input         += row.totals.input;
    grand.output        += row.totals.output;
    grand.cacheCreation += row.totals.cacheCreation;
    grand.cacheRead     += row.totals.cacheRead;
    grand.total         += row.totals.total;
    grand.messages      += row.totals.messages;
    for (const [model, b] of Object.entries(row.byModel)) {
      if (!grandByModel[model]) grandByModel[model] = newBucket();
      grandByModel[model].input         += b.input;
      grandByModel[model].output        += b.output;
      grandByModel[model].cacheCreation += b.cacheCreation;
      grandByModel[model].cacheRead     += b.cacheRead;
      grandByModel[model].total         += b.total;
      grandByModel[model].messages      += b.messages;
    }
  }

  return {
    days: numDays,
    generatedAt: new Date().toISOString(),
    filesScanned,
    uniqueMessages,
    parseErrors,
    grandTotal: grand,
    grandByModel,
    byDay: rows,
  };
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'claude_usage_today',
    description: 'Get Claude Code token usage for the last 24 hours. Returns input, output, cache_creation, cache_read totals and a breakdown by model.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'claude_usage_summary',
    description: 'Get Claude Code token usage breakdown by day and by model for the past N days (default 7, max 90). Returns per-day rows plus grand totals.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of past days to include (default: 7, max: 90)' },
      },
    },
  },
];

// ── MCP Protocol ──────────────────────────────────────────────────────────────

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function toolResult(value) {
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  };
}

async function handleToolCall(name, args) {
  log('INFO', `Tool call: ${name}`, args);
  try {
    let result;
    switch (name) {
      case 'claude_usage_today':   result = claude_usage_today(); break;
      case 'claude_usage_summary': result = claude_usage_summary(args || {}); break;
      default: return { error: `Unknown tool: ${name}` };
    }
    log('INFO', `Tool result: ${name}`, typeof result === 'object' ? JSON.stringify(result).slice(0, 300) : result);
    return result;
  } catch (e) {
    log('ERROR', `Tool ${name} threw`, e.message);
    return { error: e.message };
  }
}

// ── Main stdin/stdout MCP loop ────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch (e) {
    log('WARN', 'Failed to parse JSON line', trimmed.slice(0, 200));
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-usage-server', version: '1.0.0' },
      });
      return;
    }

    if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs  = params?.arguments || {};
      const result    = await handleToolCall(toolName, toolArgs);
      respond(id, toolResult(result));
      return;
    }

    if (method?.startsWith('notifications/')) {
      // No response for notifications
      return;
    }

    respondError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    log('ERROR', `Unhandled error for method ${method}`, e.message);
    respondError(id, -32603, `Internal error: ${e.message}`);
  }
});

rl.on('close', () => {
  log('INFO', 'stdin closed — claude-usage-server shutting down');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', e.message);
});

log('INFO', 'claude-usage-server started');
