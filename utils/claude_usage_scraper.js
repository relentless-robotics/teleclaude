/**
 * Claude Code Usage Scraper
 *
 * Reads all .claude/projects/**\/*.jsonl files and aggregates token usage
 * from assistant message snapshots, bucketed by hourly / daily / weekly windows.
 *
 * Output JSON is saved to dashboard-app/data/claude_usage.json and can be
 * polled by the dashboard API route without requiring any external requests.
 *
 * Usage:
 *   node utils/claude_usage_scraper.js           # run once
 *   node utils/claude_usage_scraper.js --watch   # re-run every 30 s
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:/Users/YOUR_USERNAME',
  '.claude', 'projects',
);

const OUTPUT_DIR = path.join(__dirname, '..', 'dashboard-app', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'claude_usage.json');

// ── Claude Pro / Max subscription limits (tokens per window) ─────────────────
// Claude Pro: ~88,000 output tokens per 5-hour sliding window (Anthropic docs)
// These are approximate — Anthropic doesn't publish exact token limits.
// We use conservative known values; set to 0 to hide the bar.
const LIMITS = {
  // 5-hour window for Claude Pro (~88 k output tokens)
  // We track ALL tokens (input + output + cache) for a broader picture.
  // The real throttle is on output tokens, but showing total gives context.
  hourly: {
    windowMs:       1  * 60 * 60 * 1000,   // 1-hour rolling window
    outputLimit:    30_000,                 // ~30k output tokens/hour (conservative Pro)
    totalLimit:     500_000,               // total (inc. cache reads) — indicative only
  },
  daily: {
    windowMs:       24 * 60 * 60 * 1000,
    outputLimit:    200_000,               // ~200k output tokens/day
    totalLimit:     10_000_000,
  },
  weekly: {
    windowMs:       7  * 24 * 60 * 60 * 1000,
    outputLimit:    1_000_000,
    totalLimit:     50_000_000,
  },
};

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
  } catch { /* skip unreadable dirs */ }
  return files;
}

function parseTimestamp(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.getTime();
  } catch { return null; }
}

// ── Core aggregation ─────────────────────────────────────────────────────────

function scrape() {
  const now   = Date.now();
  const files = walkJsonl(CLAUDE_PROJECTS_DIR);

  // We need per-message data to bucket into time windows.
  // Keys: hourly, daily, weekly
  const windows = {
    hourly:  { cutoff: now - LIMITS.hourly.windowMs,  tokens: newBucket() },
    daily:   { cutoff: now - LIMITS.daily.windowMs,   tokens: newBucket() },
    weekly:  { cutoff: now - LIMITS.weekly.windowMs,  tokens: newBucket() },
  };

  // Dedup by message ID so snapshot-repeated entries don't double-count
  const seenIds = new Set();

  // Per-hour buckets for sparkline (last 24 hours)
  const hourlyBuckets = {};   // key = "YYYY-MM-DDTHH" → {output, total}

  let filesRead  = 0;
  let parseErrors = 0;

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch { continue; }

    filesRead++;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); }
      catch { parseErrors++; continue; }

      if (rec.type !== 'assistant') continue;

      const msg = rec.message;
      if (!msg || typeof msg !== 'object') continue;

      const usage = msg.usage;
      if (!usage) continue;

      const msgId = msg.id;
      if (!msgId || seenIds.has(msgId)) continue;

      const ts = parseTimestamp(rec.timestamp);
      if (!ts) continue;

      seenIds.add(msgId);

      const inp  = usage.input_tokens                || 0;
      const out  = usage.output_tokens               || 0;
      const cw   = usage.cache_creation_input_tokens || 0;
      const cr   = usage.cache_read_input_tokens     || 0;
      const total = inp + out + cw + cr;

      // Time-window buckets
      for (const win of Object.values(windows)) {
        if (ts >= win.cutoff) {
          win.tokens.input         += inp;
          win.tokens.output        += out;
          win.tokens.cacheCreation += cw;
          win.tokens.cacheRead     += cr;
          win.tokens.total         += total;
          win.tokens.messages      += 1;
        }
      }

      // Hourly sparkline (last 24 h)
      if (ts >= now - 24 * 60 * 60 * 1000) {
        const dt  = new Date(ts);
        const key = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}`;
        if (!hourlyBuckets[key]) hourlyBuckets[key] = { output: 0, total: 0, messages: 0 };
        hourlyBuckets[key].output   += out;
        hourlyBuckets[key].total    += total;
        hourlyBuckets[key].messages += 1;
      }
    }
  }

  // Build ordered sparkline array (last 24 hours, every hour)
  const sparkline = [];
  for (let h = 23; h >= 0; h--) {
    const dt  = new Date(now - h * 60 * 60 * 1000);
    const key = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}`;
    sparkline.push({
      hour:     key,
      output:   (hourlyBuckets[key] || {}).output   || 0,
      total:    (hourlyBuckets[key] || {}).total     || 0,
      messages: (hourlyBuckets[key] || {}).messages  || 0,
    });
  }

  // Next reset times (top of the next full hour, day, week)
  const nextHourReset  = new Date(Math.ceil(now / (60*60*1000)) * (60*60*1000)).toISOString();
  const todayMidnight  = new Date(now);
  todayMidnight.setUTCHours(24, 0, 0, 0);
  const nextDayReset   = todayMidnight.toISOString();
  // Weekly reset: next Monday 00:00 UTC
  const dayOfWeek      = new Date(now).getUTCDay(); // 0=Sun
  const daysToMonday   = (8 - dayOfWeek) % 7 || 7;
  const nextWeekReset  = new Date(todayMidnight.getTime() + (daysToMonday - 1) * 24*60*60*1000).toISOString();

  const result = {
    generatedAt: new Date().toISOString(),
    filesScanned: filesRead,
    uniqueMessages: seenIds.size,
    parseErrors,

    limits: {
      hourly: {
        windowMs:    LIMITS.hourly.windowMs,
        outputLimit: LIMITS.hourly.outputLimit,
        totalLimit:  LIMITS.hourly.totalLimit,
        resetAt:     nextHourReset,
      },
      daily: {
        windowMs:    LIMITS.daily.windowMs,
        outputLimit: LIMITS.daily.outputLimit,
        totalLimit:  LIMITS.daily.totalLimit,
        resetAt:     nextDayReset,
      },
      weekly: {
        windowMs:    LIMITS.weekly.windowMs,
        outputLimit: LIMITS.weekly.outputLimit,
        totalLimit:  LIMITS.weekly.totalLimit,
        resetAt:     nextWeekReset,
      },
    },

    hourly:  { ...windows.hourly.tokens,  resetAt: nextHourReset  },
    daily:   { ...windows.daily.tokens,   resetAt: nextDayReset   },
    weekly:  { ...windows.weekly.tokens,  resetAt: nextWeekReset  },

    sparkline,  // 24-element array, oldest first
  };

  // Write output
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`[claude_usage_scraper] Written to ${OUTPUT_FILE} — ${seenIds.size} msgs, ${filesRead} files, ${new Date().toISOString()}`);
  } catch (e) {
    console.error('[claude_usage_scraper] Write error:', e.message);
  }

  return result;
}

function newBucket() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, messages: 0 };
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Entry point ───────────────────────────────────────────────────────────────

const watchMode = process.argv.includes('--watch');

scrape();

if (watchMode) {
  const INTERVAL_MS = 30_000;
  console.log(`[claude_usage_scraper] Watch mode — refreshing every ${INTERVAL_MS / 1000}s`);
  setInterval(scrape, INTERVAL_MS);
}
