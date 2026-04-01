## MANDATORY: ERROR AND LIMIT NOTIFICATIONS

**The user MUST be notified via Discord of ANY of these events:**

1. **Rate limit hit** - Immediately notify with reset time
2. **Authentication failure** - Notify and explain
3. **Task failure** - Notify with error details
4. **Unexpected state** - Notify and ask for guidance
5. **Long delay** - If task takes >2 minutes, send progress update

### Notification Templates

```
Rate limit: "⚠️ Rate limit reached. Resets at [time]. Task '[name]' paused at step [X]."

Auth failure: "🔐 Authentication failed for [service]. May need fresh login."

Task failure: "❌ Task '[name]' failed: [brief error]. [What was completed] [What remains]"

Progress: "⏳ Still working on [task]... Currently: [step]. ~[X]% complete."
```

---

## PERSISTENT TASK SYSTEM (Session-Independent)

**Long-running tasks (training, batch jobs) now persist across Claude session resets.**

### Architecture

- **SQLite Registry:** `memory/persistent_tasks.db` - tracks all tasks with PID, status, checkpoints
- **Persistent Logs:** `task_logs/` - all output logged to files, not just session memory
- **Checkpoints:** `task_checkpoints/` - progress snapshots for recovery

### Launching Persistent Tasks

```javascript
const { launchLvl3Quant, launchMacroStrategy, launchTraining } = require('./utils/training_launcher');

// Launch Lvl3Quant training (survives session reset!)
const task = launchLvl3Quant({ mode: 'hard', priority: 'URGENT' });
console.log(task.id, task.logFile);

// Launch MacroStrategy GA
const gaTask = launchMacroStrategy({ script: 'run.py' });

// Generic Python training
const customTask = launchTraining({
  name: 'My Training Job',
  script: 'train.py',
  args: ['--epochs=100'],
  workingDir: 'C:\\path\\to\\project',
  priority: 'DAILY'
});
```

### Checking Task Status

```javascript
const { getTrainingStatus, getActiveTrainings, listTasks } = require('./utils/training_launcher');
const { checkAllActiveTasks, getTaskSummary } = require('./utils/persistent_tasks');

// Get status of specific task
const status = getTrainingStatus('task_abc123');
console.log(status.progress); // { currentEpoch, totalEpochs, currentLoss, metrics }

// Get all active training tasks with progress
const trainings = getActiveTrainings();

// List all tasks (including completed)
const allTasks = listTasks({ includeCompleted: true });

// Summary stats
const summary = getTaskSummary();
```

### Reading Task Logs

```javascript
const { getTaskLog, getTaskLogTail } = require('./utils/persistent_tasks');

// Last 50 lines
const recent = getTaskLogTail('task_abc123', 50);

// Full log
const fullLog = getTaskLog('task_abc123');
```

### Task Lifecycle

1. **Launch:** `launchTraining()` → creates detached process, logs to file
2. **Running:** Process runs independently, output captured to `task_logs/`
3. **Session Reset:** Task continues! Log file persists.
4. **New Session:** `checkAllActiveTasks()` reads logs, updates status
5. **Complete:** Exit code captured, status updated to completed/failed

### Startup Integration

```javascript
const { runStartupCheck, formatStartupReport } = require('./utils/startup_check');

// At session start
const report = await runStartupCheck();
send_to_discord(formatStartupReport(report));
// Shows: active tasks, recently completed, warnings
```

### Why This Matters

- **Training jobs don't disappear** when Claude context resets
- **Progress is always visible** via log files
- **Automatic status sync** on new sessions
- **No more "what happened to my training?"**

---

## MANDATORY: SESSION STARTUP ROUTINE

**At the START of every new conversation/session, Claude MUST:**

1. **Check persistent tasks** - Run startup check for any running/completed tasks
2. **Check pending memories** - Run `check_pending()` to see URGENT and DAILY items
3. **Report status** - Send a brief summary to the user of any items needing attention
4. **Check token usage** - Review current daily budget status

### Startup Sequence

```
1. Run persistent task check:
   const { runStartupCheck, formatStartupReport } = require('./utils/startup_check');
   const taskReport = await runStartupCheck();

2. Call check_pending() from memory MCP

3. Send combined summary to user via Discord/Telegram:
   - Active persistent tasks with progress
   - Recently completed tasks
   - URGENT/DAILY memory items

4. Ready for user commands
```

### Example Startup Message

```
📋 Session started. Checking pending items...

Found 2 DAILY priority items:
- Alpaca 2FA completion pending
- Bounty platforms to monitor (Algora, HackerOne)

Budget status: 15.3% used ($1.53 of $10.00)

Ready for commands!
```

### Why This Matters

- Ensures continuity between sessions
- Nothing falls through the cracks
- User immediately knows what needs attention
- Proactive rather than reactive

---

## TOKEN TRACKING & BUDGET MANAGEMENT

**Module:** `utils/token_tracker.js`

Track token usage, costs, and get preemptive warnings before hitting limits.

### Usage

```javascript
const {
  recordUsage,
  getUsageStatus,
  estimateTaskCost,
  getUsageReport,
  preflightCheck,
  setDailyBudget
} = require('./utils/token_tracker');

// Record usage after an API call
recordUsage('sonnet', inputTokens, outputTokens, 'Task description');

// Get current status
const status = getUsageStatus();
// Returns: { spent, budget, remaining, percentUsed, status: 'OK'|'WARNING'|'CRITICAL' }

// Check before starting a task
const preflight = preflightCheck('opus', estimatedInput, estimatedOutput);
if (preflight.shouldWarn) {
  send_to_discord(`⚠️ ${preflight.message}`);
}

// Get formatted report
const report = getUsageReport();

// Set daily budget
setDailyBudget(15.00); // $15/day
```

### Budget Status Indicators

| Status | Meaning | Action |
|--------|---------|--------|
| OK | <80% budget used | Proceed normally |
| WARNING | 80-95% used | Consider using cheaper models |
| CRITICAL | >95% used | Only essential tasks |

### Preemptive Warnings

Before spawning expensive agents, check the budget:

```javascript
const estimate = estimateTaskCost('opus', 50000, 10000);
if (estimate.recommendation === 'BLOCK') {
  send_to_discord(`❌ Task would exceed budget. Currently at ${estimate.afterTaskPercent}%`);
  return;
}
```

### Storage

- Usage data: `logs/token_usage.json`
- Persists across sessions
- Tracks by day and by model

---

## STATUS DASHBOARD

**Module:** `utils/dashboard.js`

Local web dashboard showing system status at a glance.

### Starting the Dashboard

```bash
node utils/dashboard.js
```

Access at: **http://localhost:3847**

### Endpoints

| URL | Description |
|-----|-------------|
| `/` | HTML dashboard with live stats |
| `/api` or `/api/status` | JSON API response |
| `/health` | Health check endpoint |

### What It Shows

- **Token Usage**: Daily spend, budget %, status indicator
- **Memory System**: Count by priority, recent memories
- **System Status**: Active tasks, last activity
- **Quick Stats**: Urgent items, daily tasks, API calls

### Auto-Refresh

Dashboard auto-refreshes every 30 seconds.

### API Response Format

```json
{
  "timestamp": "2026-01-31T...",
  "memory": { "total": 8, "byPriority": {...}, "recent": [...] },
  "tokens": { "spent": "1.53", "budget": "10.00", "percent": "15.3", "status": "OK" },
  "system": { "lastActive": "...", "activeTasks": [] }
}
```

---

## DISCORD WEBHOOK NOTIFICATIONS

**Module:** `utils/webhook_notifier.js`

Send push notifications to Discord for important events.

### Setup

1. Create a Discord webhook in your server:
   - Server Settings → Integrations → Webhooks → New Webhook
   - Copy the webhook URL

2. Configure in `config/webhooks.json`:
```json
{
  "webhooks": {
    "default": "https://discord.com/api/webhooks/YOUR_WEBHOOK_URL"
  }
}
```

### Usage

```javascript
const { notifications } = require('./utils/webhook_notifier');

// Task completed
await notifications.taskComplete('Browser login', 'Successfully logged into GitHub');

// Task failed
await notifications.taskFailed('API setup', 'Connection timeout after 30s');

// Rate limit hit
await notifications.rateLimit('3:45 PM');

// Auth failed
await notifications.authFailed('Google', 'Session expired');

// CAPTCHA detected
await notifications.captchaDetected('GitHub', './screenshots/captcha_123.png');

// Budget warning
await notifications.budgetWarning(85.5, 1.45);

// Generic notifications
await notifications.info('Update', 'New feature deployed');
await notifications.warning('Attention', 'Disk space low');
await notifications.error('Error', 'Database connection failed');
await notifications.success('Done', 'Backup completed');
```

### Testing

```javascript
const { testWebhook } = require('./utils/webhook_notifier');
await testWebhook('default'); // Sends test notification
```

### When Webhooks Fire

Background agents should use webhooks for:
- Task completion (success or failure)
- Rate limits encountered
- Authentication issues
- CAPTCHAs detected
- Any error requiring user attention

### Notification Types

| Type | Color | Use For |
|------|-------|---------|
| success | Green | Completed tasks |
| error | Red | Failures |
| warning | Yellow | Warnings |
| info | Blue | General info |
| task_complete | Purple | Task done |
| task_failed | Red | Task failed |
| rate_limit | Orange | Rate limits |
| auth_failed | Dark red | Auth issues |
| captcha | Yellow | CAPTCHAs |

---

