# Structured Trading Event Logging System

**Implementation Date:** 2026-02-10

## Overview

Comprehensive structured logging system that records EVERY trading event in JSONL format (one JSON object per line). Provides complete audit trail that can be reconciled with Alpaca order history.

## Files Created/Modified

### New Files
- `trading_agents/event_logger.js` - Core logging module
- `trading_agents/data/trading_events.jsonl` - JSONL log file (auto-created)

### Modified Files
- `trading_agents/agents/day_trader.js` - Added 10+ logging calls
- `trading_agents/agents/swing_scanner.js` - Added 8+ logging calls
- `trading_agents/agents/position_monitor.js` - Added 6+ logging calls

## Event Types

| Event Type | Description | Logged By |
|------------|-------------|-----------|
| `DECISION` | LLM reasoning and trade decisions | day_trader, swing_scanner, position_monitor |
| `ORDER_PLACED` | Order submitted to Alpaca | day_trader, swing_scanner |
| `ORDER_FILLED` | Order confirmed filled | day_trader, swing_scanner |
| `ORDER_FAILED` | Order rejected/timeout | day_trader, swing_scanner |
| `STOP_SET` | Stop loss set or adjusted | day_trader, swing_scanner, position_monitor |
| `STOP_TRIGGERED` | Stop loss executed | swing_scanner, position_monitor |
| `STOP_FAILED` | Stop loss failed to set | day_trader, position_monitor |
| `SCAN_RESULT` | Scanner found opportunities | swing_scanner |
| `LLM_REASONING` | LLM analysis output | day_trader, swing_scanner |
| `POSITION_CHECK` | Position monitor status check | position_monitor |
| `EXIT_SIGNAL` | Exit criteria met | swing_scanner, position_monitor |
| `RECONCILIATION` | Daily Alpaca reconciliation | day_trader |

## Log Format

Each event is a JSON object on a single line (JSONL format):

```json
{
  "timestamp": "2026-02-10T16:04:38.310Z",
  "agent": "day_trader",
  "type": "DECISION",
  "symbol": "AMD",
  "side": "buy",
  "qty": 10,
  "price": 150.50,
  "order_id": "abc123",
  "stop_price": 145.00,
  "reason": "LLM: Oversold RSI + volume spike",
  "conviction": "HIGH",
  "data_snapshot": {
    "rsi": 28,
    "volume": 5000000,
    "price": 150.50
  },
  "result": "success",
  "error": null,
  "pnl": null,
  "alpaca_order_id": "abc123"
}
```

## Key Features

### 1. Complete Audit Trail
- Every decision recorded BEFORE execution
- Every order recorded at placement and fill/fail
- Every stop loss recorded when set and triggered
- Timestamps in ISO format for precise ordering

### 2. Alpaca Reconciliation
- Daily reconciliation compares log with Alpaca order history
- Identifies missing events (orders that weren't logged)
- Logs discrepancies for investigation
- Run automatically at end of day_trader cycles

### 3. Data Snapshot
- Captures key market data at time of decision (RSI, volume, price)
- Enables post-trade analysis: "What did we know when we made this decision?"
- Can correlate decisions with market conditions

### 4. Log Rotation
- Automatically rotates when file exceeds 10MB
- Archives to `trading_events_YYYY-MM-DD.jsonl`
- Prevents unlimited log growth

### 5. Console Visibility
- Every event also logs to console for scheduler visibility
- Format: `[TRADE_LOG] <type> <symbol> <side> <reason>`
- Example: `[TRADE_LOG] DECISION AMD buy LLM: Oversold RSI + volume spike`

## Usage

### Query Events

```bash
# View today's stats
node trading_agents/event_logger.js stats

# View all today's events
node trading_agents/event_logger.js today

# Query specific events
node trading_agents/event_logger.js query symbol AMD
node trading_agents/event_logger.js query type STOP_TRIGGERED
node trading_agents/event_logger.js query agent day_trader

# Test logging
node trading_agents/event_logger.js test
```

### Programmatic Access

```javascript
const { logTradingEvent, queryEvents, readTodayEvents, getTodayStats } = require('./event_logger');

// Log an event
logTradingEvent({
  agent: 'day_trader',
  type: 'DECISION',
  symbol: 'AMD',
  side: 'buy',
  qty: 10,
  price: 150.50,
  reason: 'LLM recommendation',
  conviction: 'HIGH',
  data: { rsi: 28, volume: 5000000 },
  result: 'success',
});

// Query events
const stops = queryEvents({ type: 'STOP_TRIGGERED', symbol: 'AMD' });
const failures = queryEvents({ type: 'STOP_FAILED' });
const todayDecisions = queryEvents({ type: 'DECISION', since: todayStart });

// Get today's stats
const stats = getTodayStats();
console.log(`Today: ${stats.decisions} decisions, ${stats.ordersFilled} fills, ${stats.ordersFailed} failures`);

// Get all today's events
const events = readTodayEvents();
```

## Integration Points

### Day Trader
- **Line ~1251**: Logs LLM reasoning + all decisions
- **Line ~1469**: Logs order placed (equity)
- **Line ~1516**: Logs stop set success/failure
- **Line ~379**: Logs order filled/failed/timeout
- **Line ~431**: Runs daily reconciliation

### Swing Scanner
- **Line ~774**: Logs LLM decisions + entry picks
- **Line ~467**: Logs stop loss triggered
- **Line ~516**: Logs profit target exit
- **Line ~563**: Logs trailing stop triggered
- **Line ~830**: Logs order placed
- **Line ~854**: Logs order filled/failed

### Position Monitor
- **Line ~544**: Logs stop triggered
- **Line ~574**: Logs LLM decision
- **Line ~599**: Logs stop set/rejected

## Daily Workflow

1. **Pre-market**: Overnight agent runs, no trading yet
2. **Market open**: Day trader + swing scanner start
   - Every LLM decision logged
   - Every order logged at placement
   - Every fill/failure logged within 30s
3. **During day**: Position monitor runs every 60s
   - Logs significant moves (POSITION_CHECK)
   - Logs LLM analysis when triggered
   - Logs stop triggers/adjustments
4. **End of day**: Day trader runs reconciliation
   - Compares log with Alpaca orders
   - Logs discrepancies
   - Summary shows: X logged, Y Alpaca, Z missing

## Post-Trade Analysis

### Example Queries

**Show all AMD trades today:**
```bash
node event_logger.js query symbol AMD
```

**Find all stop failures:**
```bash
node event_logger.js query type STOP_FAILED
```

**Get all decisions by day trader:**
```bash
node event_logger.js query agent day_trader | grep DECISION
```

**Reconciliation summary:**
```bash
node event_logger.js query type RECONCILIATION
```

### Analysis Workflow

1. Read trading_events.jsonl into analysis tool (Python, Excel, etc.)
2. Filter by symbol, date range, agent, type
3. Correlate DECISION → ORDER_PLACED → ORDER_FILLED → STOP_SET → STOP_TRIGGERED
4. Calculate time between events
5. Compare decision data (RSI, volume) with outcome
6. Identify patterns: What conditions lead to stop failures? What conviction scores correlate with wins?

## Log File Location

**Primary log:** `trading_agents/data/trading_events.jsonl`
**Archives:** `trading_agents/data/trading_events_YYYY-MM-DD.jsonl`

## Maintenance

### Log Rotation
- Automatic when file exceeds 10MB
- Archives named by date of rotation
- Old archives can be deleted or compressed after analysis

### Disk Space
- Expect ~1-5KB per event
- ~500-1000 events per day = 500KB-5MB daily
- 10MB limit = ~2-3 days of heavy trading
- Archives compress well (JSONL is text)

## Future Enhancements

1. **Add more data snapshots**: Greeks for options, bid-ask spread, order book depth
2. **Event correlation**: Link DECISION → ORDER_PLACED → ORDER_FILLED by ID
3. **Real-time dashboard**: Stream events to web dashboard
4. **Alert on anomalies**: Email/Discord when reconciliation shows discrepancies
5. **Machine learning**: Train models on decision data + outcomes

## Testing

```bash
# Test logging
cd trading_agents
node event_logger.js test

# Verify log file created
ls data/trading_events.jsonl

# View logged event
node event_logger.js today

# Check stats
node event_logger.js stats
```

## Troubleshooting

**No events logged:**
- Check if `trading_agents/data/` directory exists (auto-created)
- Check file permissions
- Check console for `[TRADE_LOG]` messages

**Reconciliation shows missing events:**
- Normal for first day (no prior events)
- Check if order was placed before logging system was added
- Check if agent crashed between order placement and logging

**Log file too large:**
- Manual rotation: `mv trading_events.jsonl trading_events_archive.jsonl`
- Automatic rotation triggers at 10MB

## Summary

This structured logging system provides:
- ✅ Complete audit trail of all trading decisions and executions
- ✅ Reconciliation with Alpaca order history
- ✅ Post-trade analysis capability
- ✅ Data snapshots at time of decision
- ✅ Easy querying and filtering
- ✅ Automatic log rotation
- ✅ No performance impact (append-only writes)

All trading agents now log comprehensively. Every decision, order, stop, and exit is recorded. The log can be compared with Alpaca's order history to ensure nothing is missed.
