/**
 * Wheel Strategy Agent — Full Automation Pipeline
 *
 * Calls automation.py at scheduled times for the complete wheel cycle:
 *   - Monday 9:45 AM ET:   --morning  (optimize + submit CSPs)
 *   - Tue-Thu 10:00 AM ET: --daily    (monitor, assignments, early close)
 *   - Friday 3:00 PM ET:   --friday   (expiry management)
 *   - Sunday 6:00 PM ET:   --weekly-report
 *
 * Also runs --daily on Monday/Friday at 10:00 AM in addition to
 * the morning/friday-specific runs.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const discord = require('../discord_channels');

const WHEEL_DIR = path.join(__dirname, '..', 'wheel_strategy');
const AUTOMATION_SCRIPT = path.join(WHEEL_DIR, 'automation.py');
const STATE_FILE = path.join(__dirname, '..', 'data', 'wheel_strategy_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return {
    lastMorningRun: null,
    lastDailyRun: null,
    lastFridayRun: null,
    lastWeeklyReport: null,
    lastStatusCheck: null,
    runHistory: [],
  };
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  if (state.runHistory && state.runHistory.length > 200) {
    state.runHistory = state.runHistory.slice(-200);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function runAutomation(mode) {
  return new Promise((resolve, reject) => {
    execFile('python', [AUTOMATION_SCRIPT, `--${mode}`], {
      cwd: WHEEL_DIR,
      timeout: 180000, // 3 minutes
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = `${err.message}\nstderr: ${stderr}`.slice(0, 500);
        reject(new Error(errMsg));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Check if a specific run has already happened today.
 */
function hasRunToday(isoString) {
  if (!isoString) return false;
  const lastRun = new Date(isoString);
  const now = new Date();
  return lastRun.toDateString() === now.toDateString();
}

/**
 * Get current ET hour (rough approximation using UTC offset).
 * For proper timezone handling, use Intl or a library.
 */
function getETHour() {
  const now = new Date();
  // Create a formatter for Eastern Time
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);
  return { hour: etDate.getHours(), minute: etDate.getMinutes(), day: etDate.getDay() };
}

class WheelStrategyAgent {
  constructor() {
    this.state = loadState();
  }

  /**
   * Record a run in history for debugging.
   */
  _recordRun(mode, success, detail = '') {
    if (!this.state.runHistory) this.state.runHistory = [];
    this.state.runHistory.push({
      timestamp: new Date().toISOString(),
      mode,
      success,
      detail: detail.slice(0, 200),
    });
  }

  /**
   * Run a mode and send output to Discord.
   */
  async _runAndSend(mode, stateKey) {
    console.log(`[WheelAgent] Running --${mode}...`);
    try {
      const output = await runAutomation(mode);
      if (output) {
        try {
          await discord.send('wheelStrategy', output);
        } catch (e) {
          console.log(`[WheelAgent] Discord send failed: ${e.message}`);
          console.log(output);
        }
      }
      this.state[stateKey] = new Date().toISOString();
      this._recordRun(mode, true);
      saveState(this.state);
      return { action: mode, success: true };
    } catch (e) {
      console.error(`[WheelAgent] ${mode} error:`, e.message);
      this._recordRun(mode, false, e.message);
      saveState(this.state);

      // Send error to Discord
      try {
        await discord.send('wheelStrategy',
          `**Wheel ${mode} — ERROR**\n\`\`\`\n${e.message.slice(0, 500)}\n\`\`\``
        );
      } catch (_) {}

      return { action: mode, success: false, error: e.message };
    }
  }

  /**
   * Main scheduler entry point. Called periodically by the trading scheduler.
   * Determines what to run based on current time (ET).
   */
  async run() {
    const { hour, minute, day } = getETHour();

    // ── Sunday 6:00 PM ET: Weekly report ──────────────────────────────
    if (day === 0 && hour >= 18 && !hasRunToday(this.state.lastWeeklyReport)) {
      return this._runAndSend('weekly-report', 'lastWeeklyReport');
    }

    // ── Monday 9:45+ AM ET: Morning optimization + submit ─────────────
    if (day === 1 && hour === 9 && minute >= 45 && !hasRunToday(this.state.lastMorningRun)) {
      return this._runAndSend('morning', 'lastMorningRun');
    }
    // Also catch if scheduler runs at 10 AM and morning hasn't run
    if (day === 1 && hour === 10 && !hasRunToday(this.state.lastMorningRun)) {
      return this._runAndSend('morning', 'lastMorningRun');
    }

    // ── Friday 3:00 PM ET: Expiry management ─────────────────────────
    if (day === 5 && hour >= 15 && !hasRunToday(this.state.lastFridayRun)) {
      return this._runAndSend('friday', 'lastFridayRun');
    }

    // ── Weekdays 10:00 AM ET: Daily monitoring ────────────────────────
    if (day >= 1 && day <= 5 && hour >= 10 && !hasRunToday(this.state.lastDailyRun)) {
      return this._runAndSend('daily', 'lastDailyRun');
    }

    return { action: 'idle' };
  }

  /**
   * Force-run a specific mode (for manual invocation).
   */
  async forceRun(mode) {
    const keyMap = {
      'morning': 'lastMorningRun',
      'daily': 'lastDailyRun',
      'friday': 'lastFridayRun',
      'weekly-report': 'lastWeeklyReport',
      'status': 'lastStatusCheck',
    };
    const stateKey = keyMap[mode] || 'lastStatusCheck';
    return this._runAndSend(mode, stateKey);
  }

  /**
   * Get agent status for the scheduler dashboard.
   */
  getStatus() {
    return {
      lastMorningRun: this.state.lastMorningRun,
      lastDailyRun: this.state.lastDailyRun,
      lastFridayRun: this.state.lastFridayRun,
      lastWeeklyReport: this.state.lastWeeklyReport,
      recentRuns: (this.state.runHistory || []).slice(-5),
    };
  }
}

module.exports = WheelStrategyAgent;
