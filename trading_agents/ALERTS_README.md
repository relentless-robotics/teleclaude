# IASM Alert & Monitoring System

**Comprehensive monitoring and alerting for the IASM trading pipeline.**

## Overview

The alert system monitors critical aspects of the trading pipeline and sends Discord notifications when issues arise. It integrates seamlessly with the scheduler and runs automatically during market hours.

## Components

### 1. `alerts.js` - Alert & Monitoring System

**Purpose:** Monitors trading system health and sends Discord alerts

**Features:**
- Regime transition detection
- Drawdown alerts (warning/critical/extreme levels)
- Model degradation detection (hit rate monitoring)
- Signal quality checks (staleness, count, confidence)
- System health monitoring (file staleness, halts, errors)
- Position alerts (max positions, max hold time warnings)

**Alert Types:**

| Alert Type | Trigger | Discord Channel |
|------------|---------|-----------------|
| Regime Transition | Market regime changes (e.g., LOW_VOL_TREND → HIGH_VOL_CHOPPY) | `alerts` |
| Drawdown Warning | Daily P&L < -0.5% | `alerts` |
| Drawdown Critical | Daily P&L < -0.75% | `alerts` |
| Drawdown Extreme | Daily P&L < -1.0% | `alerts` |
| Model Degradation | Rolling hit rate < 50% (20-trade sample) | `alerts` |
| Signal File Missing | `tree_signals_latest.json` not found | `alerts` |
| Signals Stale | Signals older than 10 minutes | `alerts` |
| No Signals | Signal count = 0 | `alerts` |
| Low Confidence | Average signal confidence < 55% | `alerts` |
| Trading Halted | Executor halted flag set | `alerts` |
| High Veto Rate | >80% of signals vetoed | `alerts` |
| Executor Errors | Recent errors in state file | `systemStatus` |
| Max Positions | Position count > 5 | `alerts` |
| Max Hold Warning | Position approaching 4-hour max hold | `tradeExecutions` |

**State Tracking:**

The system tracks what's already been alerted to avoid spam. State is reset daily.

**Data Sources:**
- `tree_signals_latest.json` - Signal data, regime info
- `intraday_executor_state.json` - Positions, P&L, errors
- `data/intraday_executions.jsonl` - Trade history (for hit rate)
- `data/alert_state.json` - Alert state tracking

### 2. `auto_retrain.js` - Automated Model Retraining

**Purpose:** Automatically retrain IASM models when needed

**Triggers:**

1. **Scheduled:** Every Sunday at 8:00 PM ET (weekly retrain)
2. **Staleness:** Models older than 7 days
3. **Performance Degradation:** Rolling hit rate < 50% (20-trade sample)

**How It Works:**

```
1. Check if retraining is needed
2. If yes:
   - Send Discord notification (start)
   - Execute WSL2 Python training pipeline
   - Wait for completion (30-minute timeout)
   - Send Discord notification (success/failure)
3. Log event to retrain_history.jsonl
4. Update retrain_state.json
```

**Data Files:**
- `data/retrain_state.json` - Last retrain time, success status, consecutive failures
- `data/retrain_history.jsonl` - Event log of all retrain attempts

**Configuration:**

```javascript
CONFIG = {
  scheduledTime: { dayOfWeek: 0, hour: 20, minute: 0 },  // Sunday 8 PM ET
  maxModelAgeDays: 7,
  performanceThresholds: {
    minIC: 0.03,
    minHitRate: 0.50,
    minSampleSize: 20,
  },
}
```

## Integration with Scheduler

**Added to `scheduler.js`:**

```javascript
// Alert monitoring (every 60s during market hours)
this.alertLoop = setInterval(() => {
  const status = marketHours.getStatus();
  if (status.isMarketOpen) {
    alerts.checkAlerts().catch(e => console.error('[Alerts]', e.message));
  }
}, 60 * 1000);

// Auto-retrain check (every hour at :00)
if (minute === 0) {
  const retrainResult = await autoRetrain.checkAndRetrain();
  if (retrainResult.triggered) {
    console.log('[Scheduler] Auto-retrain triggered:', retrainResult.reason);
  }
}
```

## Usage

### Standalone Testing

**Check alerts manually:**
```bash
cd trading_agents
node alerts.js check
```

**Get system status:**
```bash
node alerts.js status
```

**Start monitoring loop:**
```bash
node alerts.js monitor
```

**Check retrain status:**
```bash
node auto_retrain.js status
```

**Force retrain:**
```bash
node auto_retrain.js force
```

**Check if retrain needed:**
```bash
node auto_retrain.js check
```

### Programmatic Usage

**alerts.js:**
```javascript
const alerts = require('./alerts');

// Run all alert checks once
await alerts.checkAlerts();

// Get current status
const status = alerts.getStatus();
console.log(status);

// Access thresholds
console.log(alerts.THRESHOLDS);
```

**auto_retrain.js:**
```javascript
const autoRetrain = require('./auto_retrain');

// Check and retrain if needed
const result = await autoRetrain.checkAndRetrain();

// Force retrain
await autoRetrain.executeRetrain('Manual override');

// Get status
const status = autoRetrain.getStatus();

// Check staleness
const stale = autoRetrain.checkModelStaleness();

// Check performance
const perf = autoRetrain.checkPerformanceDegradation();
```

## Alert Thresholds

**Customizable in `alerts.js`:**

```javascript
const THRESHOLDS = {
  drawdown: {
    warning: -0.5,    // -0.5% daily P&L
    critical: -0.75,  // -0.75% daily P&L
    extreme: -1.0,    // -1.0% daily P&L
  },
  model: {
    minIC: 0.03,
    minHitRate: 0.50,
  },
  signals: {
    minCount: 1,
    minConfidence: 0.55,
    staleMinutes: 10,
  },
  positions: {
    maxConcurrent: 5,
    maxHoldHours: 4,
  },
};
```

## Discord Channels Used

| Channel | Alerts |
|---------|--------|
| `alerts` | Regime, drawdown, model degradation, signal quality, system health, max positions |
| `systemStatus` | Executor errors, general system issues |
| `tradeExecutions` | Position hold time warnings |
| `iasmSignals` | Retrain start/complete notifications |
| `errors` | Retrain failures |

## Monitoring Intervals

| Component | Interval | Active When |
|-----------|----------|-------------|
| Alert checks | 60 seconds | Market hours only |
| Auto-retrain check | 60 minutes | Always (checks schedule) |
| Position monitor | 60 seconds | Market hours only |
| IASM pipeline | 60 seconds | 9:45 AM - 3:45 PM ET |

## State Files

All state files are in `trading_agents/data/`:

```
alert_state.json          - Alert tracking (what's been alerted)
retrain_state.json        - Retrain history and status
retrain_history.jsonl     - Log of all retrain events
intraday_executor_state.json  - Executor state (positions, P&L)
intraday_executions.jsonl     - Trade execution log
```

## Error Handling

**Alert System:**
- Catches and logs all errors
- Continues monitoring even if one check fails
- Sends Discord error notifications for critical failures

**Auto-Retrain:**
- Tracks consecutive failures
- 30-minute timeout for Python training
- Fallback to native Windows Python if WSL2 fails
- Continues trading with existing models if retrain fails
- Sends Discord notifications for both success and failure

## Performance Impact

**Alert System:**
- Lightweight checks (file reads, JSON parsing)
- ~100ms per check cycle
- No impact on trading execution

**Auto-Retrain:**
- Only runs when needed (weekly or on degradation)
- Runs in background (does not block trading)
- Training takes 10-20 minutes
- No impact on live trading (uses existing models until complete)

## Best Practices

1. **Monitor Discord channels** - Critical alerts require immediate attention
2. **Review retrain logs** - Check `retrain_history.jsonl` weekly
3. **Adjust thresholds** - Tune based on your risk tolerance
4. **Test manually** - Run `node alerts.js check` before market open
5. **Check status** - Run `node alerts.js status` to verify system health
6. **Review performance** - Monitor hit rate and adjust retrain thresholds

## Troubleshooting

**Problem: No alerts firing**
- Check `alert_state.json` - may have already alerted today
- Delete state file to reset: `rm data/alert_state.json`
- Run `node alerts.js check` manually

**Problem: Too many duplicate alerts**
- Alert deduplication should prevent this
- Check `alert_state.json` for state corruption
- Increase `staleMinutes` threshold if signal staleness is flapping

**Problem: Retrain not triggering on Sunday**
- Check system time zone is correct (ET expected)
- Verify scheduler is running during Sunday 8 PM window
- Run `node auto_retrain.js status` to see next scheduled time
- Check `retrain_state.json` for `lastScheduledRun` date

**Problem: Retrain failing**
- Check WSL2 is running: `wsl -d Ubuntu-22.04 -- echo "test"`
- Verify conda environment: `wsl -d Ubuntu-22.04 -- which python`
- Check Alpaca credentials in `.env`
- Review error in Discord `errors` channel
- Try manual retrain: `node auto_retrain.js force`

**Problem: Signal file always stale**
- IASM pipeline may not be running
- Check `intraday_pipeline.js` status
- Verify Python prediction script is working
- Run manually: `python -m intraday_model.generate_tree_signals export`

## Future Enhancements

Potential additions:

1. **Email alerts** - Send critical alerts via email
2. **SMS alerts** - Twilio integration for extreme events
3. **Metric dashboards** - Web dashboard for real-time monitoring
4. **Alert history** - Queryable alert log for analysis
5. **Adaptive thresholds** - Auto-adjust based on market regime
6. **Multi-model voting** - Retrain only if multiple degradation signals
7. **A/B testing** - Compare old vs new models before switching

## Code Examples

**Example 1: Add custom alert**

```javascript
// In alerts.js, add new check function:
async function checkCustomCondition() {
  const data = loadSomeData();
  if (data.metric > THRESHOLD) {
    const alertKey = `custom_alert_${alertState.state.date}`;
    if (!alertState.hasAlerted('signal', alertKey)) {
      await discord.alert('⚠️ **CUSTOM ALERT**\n\nYour message here');
      alertState.markAlerted('signal', alertKey);
    }
  }
}

// Add to checkAlerts():
await checkCustomCondition();
```

**Example 2: Change retrain schedule**

```javascript
// In auto_retrain.js, modify CONFIG:
scheduledTime: {
  dayOfWeek: 0,  // 0=Sunday, 1=Monday, etc.
  hour: 20,      // 8 PM ET
  minute: 0,
}
```

**Example 3: Query recent alerts**

```javascript
const fs = require('fs');
const alertState = JSON.parse(fs.readFileSync('data/alert_state.json', 'utf8'));

console.log('Drawdown alerts today:', alertState.drawdownAlertsToday);
console.log('Model alerts:', alertState.modelAlerts);
console.log('Last check:', alertState.lastCheckTime);
```

---

## Summary

The IASM Alert & Monitoring System provides comprehensive oversight of the trading pipeline with:

✅ **Real-time monitoring** - 60-second checks during market hours
✅ **Smart alerting** - Deduplication prevents spam
✅ **Multi-channel** - Discord integration for visibility
✅ **Automated recovery** - Auto-retrain on degradation
✅ **Scheduled maintenance** - Weekly retraining on Sundays
✅ **Comprehensive logging** - Full audit trail of events
✅ **Graceful degradation** - Continues trading even if monitoring fails

**The system is now active and integrated into the scheduler.**
