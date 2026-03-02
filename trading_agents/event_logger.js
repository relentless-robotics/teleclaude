/**
 * Trading Event Logger - Structured logging for all trading events
 *
 * Logs every trading event in JSONL format (one JSON object per line).
 * Provides comprehensive audit trail that can be reconciled with Alpaca order history.
 *
 * Event Types:
 * - DECISION: LLM reasoning and decisions
 * - ORDER_PLACED: Order submitted to Alpaca
 * - ORDER_FILLED: Order confirmed filled
 * - ORDER_FAILED: Order rejected/timeout
 * - STOP_SET: Stop loss set or adjusted
 * - STOP_TRIGGERED: Stop loss executed
 * - STOP_FAILED: Stop loss failed to set
 * - SCAN_RESULT: Scanner found opportunities
 * - LLM_REASONING: LLM analysis output
 * - POSITION_CHECK: Position monitor status check
 * - EXIT_SIGNAL: Exit criteria met
 * - RECONCILIATION: Daily Alpaca reconciliation
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(LOG_DIR, 'trading_events.jsonl');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

// Ensure data directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log a trading event to JSONL file
 * @param {object} event - Event object with required fields
 */
function logTradingEvent(event) {
  const entry = {
    timestamp: new Date().toISOString(),
    agent: event.agent || 'unknown',        // 'day_trader', 'swing_scanner', 'position_monitor'
    type: event.type,                        // Event type (see above)
    symbol: event.symbol || null,
    side: event.side || null,                // 'buy', 'sell'
    qty: event.qty || null,
    price: event.price || null,
    order_id: event.order_id || null,
    stop_price: event.stop_price || null,
    reason: event.reason || null,            // LLM's reasoning or trigger reason
    conviction: event.conviction || null,
    data_snapshot: event.data || null,       // Key data at time of decision (price, RSI, volume)
    result: event.result || null,            // 'success', 'failed', 'partial', 'timeout'
    error: event.error || null,
    pnl: event.pnl || null,
    alpaca_order_id: event.alpaca_order_id || null,
  };

  // Append to JSONL file
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

    // Console log for visibility in scheduler
    console.log(`[TRADE_LOG] ${entry.type} ${entry.symbol || ''} ${entry.side || ''} ${entry.reason || ''}`);

    // Check file size and rotate if needed
    rotateIfNeeded();
  } catch (e) {
    console.error(`[TRADE_LOG] Failed to write event: ${e.message}`);
  }

  return entry;
}

/**
 * Rotate log file if it exceeds max size
 */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;

    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const archivePath = path.join(LOG_DIR, `trading_events_${timestamp}.jsonl`);

      // Rename current log to archive
      fs.renameSync(LOG_FILE, archivePath);
      console.log(`[TRADE_LOG] Rotated log to ${archivePath}`);
    }
  } catch (e) {
    console.error(`[TRADE_LOG] Rotation error: ${e.message}`);
  }
}

/**
 * Read today's events from log file
 */
function readTodayEvents() {
  if (!fs.existsSync(LOG_FILE)) return [];

  const today = new Date().toISOString().split('T')[0];
  const events = [];

  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.timestamp && event.timestamp.startsWith(today)) {
          events.push(event);
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (e) {
    console.error(`[TRADE_LOG] Error reading events: ${e.message}`);
  }

  return events;
}

/**
 * Query events with filters
 * @param {object} filters - { agent, type, symbol, since, until, result }
 */
function queryEvents(filters = {}) {
  if (!fs.existsSync(LOG_FILE)) return [];

  const events = [];

  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Apply filters
        if (filters.agent && event.agent !== filters.agent) continue;
        if (filters.type && event.type !== filters.type) continue;
        if (filters.symbol && event.symbol !== filters.symbol) continue;
        if (filters.result && event.result !== filters.result) continue;
        if (filters.since && event.timestamp < filters.since) continue;
        if (filters.until && event.timestamp > filters.until) continue;

        events.push(event);
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (e) {
    console.error(`[TRADE_LOG] Error querying events: ${e.message}`);
  }

  return events;
}

/**
 * Reconcile today's events with Alpaca order history
 * @param {object} alpacaClient - Alpaca client instance
 * @param {string} account - 'day' or 'swing'
 */
async function logReconciliation(alpacaClient, account) {
  if (!alpacaClient) {
    logTradingEvent({
      agent: 'reconciliation',
      type: 'RECONCILIATION',
      reason: 'No Alpaca client available',
      result: 'skipped',
    });
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const todayStart = `${today}T00:00:00Z`;

  try {
    // Pull today's Alpaca orders
    const orders = await alpacaClient.getOrders({
      status: 'all',
      limit: 50,
      after: todayStart
    });

    const filled = (orders || []).filter(o => o.status === 'filled');

    // Read today's log events
    const todayEvents = readTodayEvents();
    const loggedOrders = todayEvents
      .filter(e => e.type === 'ORDER_FILLED')
      .map(e => e.alpaca_order_id)
      .filter(Boolean);

    // Find discrepancies
    const unlogged = filled.filter(o => !loggedOrders.includes(o.id));

    logTradingEvent({
      agent: 'reconciliation',
      type: 'RECONCILIATION',
      reason: `Alpaca: ${filled.length} orders, Logged: ${loggedOrders.length}, Missing: ${unlogged.length}`,
      data: {
        alpaca_count: filled.length,
        logged_count: loggedOrders.length,
        missing_count: unlogged.length,
        missing_orders: unlogged.map(o => ({
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          qty: o.qty,
          filled_at: o.filled_at,
          filled_avg_price: o.filled_avg_price,
        })),
      },
      result: unlogged.length === 0 ? 'success' : 'discrepancy',
    });

    console.log(`[TRADE_LOG] Reconciliation: ${filled.length} Alpaca orders, ${loggedOrders.length} logged, ${unlogged.length} missing`);

    return {
      alpacaCount: filled.length,
      loggedCount: loggedOrders.length,
      missingCount: unlogged.length,
      missingOrders: unlogged,
    };
  } catch (e) {
    logTradingEvent({
      agent: 'reconciliation',
      type: 'RECONCILIATION',
      reason: 'Reconciliation failed',
      error: e.message,
      result: 'failed',
    });

    console.error(`[TRADE_LOG] Reconciliation error: ${e.message}`);
    return {
      alpacaCount: 0,
      loggedCount: 0,
      missingCount: 0,
      error: e.message,
    };
  }
}

/**
 * Get summary stats for today's events
 */
function getTodayStats() {
  const events = readTodayEvents();

  const stats = {
    total: events.length,
    byAgent: {},
    byType: {},
    decisions: 0,
    ordersPlaced: 0,
    ordersFilled: 0,
    ordersFailed: 0,
    stopsSet: 0,
    stopsTriggered: 0,
    stopsFailed: 0,
    exitSignals: 0,
  };

  for (const event of events) {
    // Count by agent
    stats.byAgent[event.agent] = (stats.byAgent[event.agent] || 0) + 1;

    // Count by type
    stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;

    // Specific counters
    if (event.type === 'DECISION') stats.decisions++;
    if (event.type === 'ORDER_PLACED') stats.ordersPlaced++;
    if (event.type === 'ORDER_FILLED') stats.ordersFilled++;
    if (event.type === 'ORDER_FAILED') stats.ordersFailed++;
    if (event.type === 'STOP_SET') stats.stopsSet++;
    if (event.type === 'STOP_TRIGGERED') stats.stopsTriggered++;
    if (event.type === 'STOP_FAILED') stats.stopsFailed++;
    if (event.type === 'EXIT_SIGNAL') stats.exitSignals++;
  }

  return stats;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  logTradingEvent,
  readTodayEvents,
  queryEvents,
  logReconciliation,
  getTodayStats,
};

// CLI for quick testing
if (require.main === module) {
  const cmd = process.argv[2] || 'stats';

  switch (cmd) {
    case 'stats':
      console.log('Today\'s Trading Event Stats:');
      console.log(JSON.stringify(getTodayStats(), null, 2));
      break;

    case 'today':
      console.log('Today\'s Events:');
      console.log(JSON.stringify(readTodayEvents(), null, 2));
      break;

    case 'query':
      const filter = process.argv[3];
      const value = process.argv[4];
      console.log(`Events matching ${filter}=${value}:`);
      console.log(JSON.stringify(queryEvents({ [filter]: value }), null, 2));
      break;

    case 'test':
      console.log('Logging test event...');
      logTradingEvent({
        agent: 'test',
        type: 'DECISION',
        symbol: 'TEST',
        side: 'buy',
        qty: 10,
        price: 100.50,
        reason: 'Test event',
        conviction: 'HIGH',
        data: { rsi: 30, volume: 1000000 },
        result: 'success',
      });
      console.log('Test event logged successfully');
      break;

    default:
      console.log('Usage: node event_logger.js [stats|today|query <field> <value>|test]');
  }
}
