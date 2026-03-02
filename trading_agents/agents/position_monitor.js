/**
 * Position Monitor - Threshold-Triggered LLM Reasoning + ORDER EXECUTION
 *
 * Runs every 60 seconds during market hours. Checks ALL positions
 * (day trade + swing) for significant moves. When a threshold is
 * crossed, triggers a lightweight LLM call to decide: hold, add, or cut.
 *
 * NOW ACTUALLY EXECUTES: TRIM, CLOSE, and enforces trailing stops.
 *
 * Data Source: ALPACA POSITION API (real-time, no Yahoo delay)
 *
 * Thresholds:
 * - ±2% move from last check → trigger analysis
 * - ±5% move from entry → trigger analysis
 * - New high/low for the day → trigger analysis
 *
 * Stops:
 * - Trailing stops: only move UP (for longs), never down
 * - Auto-close when price crosses below stop
 * - LLM can suggest new stop, but only accepted if HIGHER than current
 *
 * Uses Groq Kimi K2 (FREE) with a compact prompt focused on the
 * specific position, not the full market dump.
 */

const brain = require('../shared_brain');
const discord = require('../discord_channels');

// Event Logger
let eventLogger;
try {
  eventLogger = require('../event_logger');
} catch (e) {
  console.warn('[PositionMonitor] Event logger not available:', e.message);
}

// LLM Reasoning
let reasoning;
try {
  reasoning = require('../../utils/llm_reasoning');
} catch (e) {
  console.warn('[PositionMonitor] LLM reasoning not available:', e.message);
}

// Alpaca clients
let daytradeClient, swingClient;
try { daytradeClient = require('../../swing_options/daytrade_client'); } catch (e) {}
try { swingClient = require('../../swing_options/alpaca_client'); } catch (e) {}

// Trade Journal (peak tracking + close logging)
let journal;
try {
  journal = require('../trade_journal');
} catch (e) {
  console.warn('[PositionMonitor] Trade journal not available:', e.message);
}

// ============================================================================
// STATE TRACKING
// ============================================================================

// Track last-known state for threshold detection
// symbol -> { lastPrice, lastCheckTime, entryPrice, dayHigh, dayLow, alertCount, ... }
const positionState = new Map();

// Track trailing stops per position (only move UP for longs, DOWN for shorts)
// symbol -> { stopPrice, setAt, setReason }
const trailingStops = new Map();

// Track which symbols have been trimmed today (prevent over-trimming)
const trimmedToday = new Set();

// Track executed actions for LLM confirmation
// symbol -> [{ action, time, qty, price, orderId }]
const executedActions = new Map();

const THRESHOLDS = {
  moveFromLastCheck: 0.02,   // ±2% from last 60s check
  moveFromEntry: 0.05,       // ±5% from entry price
  maxAlertsPerSymbol: 8,     // Max alerts per symbol per day
  cooldownMs: 3 * 60 * 1000, // 3 min cooldown between alerts on same symbol
};

// ============================================================================
// LLM PROMPT - Updated with execution awareness
// ============================================================================

const MONITOR_PROMPT = `You are a position risk manager that EXECUTES decisions. When you say TRIM or CLOSE, the system WILL place real orders. Be precise.

IMPORTANT RULES:
- TRIM = sell HALF the position. Only recommend when the gain justifies it or risk is real.
- CLOSE = sell ALL. Only for clear thesis breaks or stop-loss situations.
- Stops should TRAIL UP with winners. NEVER lower a stop below its current level.
- If the position is working (profitable, thesis intact), default to HOLD.
- Don't panic on normal volatility. Options move fast - that's expected.

RESPOND IN JSON ONLY:
{
  "action": "HOLD" | "TRIM" | "CLOSE" | "WATCH",
  "urgency": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "1-2 sentence explanation",
  "adjustStopTo": null or price number (MUST be HIGHER than current stop for longs),
  "thesisIntact": true or false
}

CRITICAL: "adjustStopTo" must ONLY go UP for long positions. If the current stop is $5, you cannot suggest $4.50.`;

// ============================================================================
// THRESHOLD CHECKING (uses Alpaca price, not Yahoo)
// ============================================================================

function checkThresholds(position, currentPrice) {
  const symbol = position.symbol;
  const state = positionState.get(symbol);
  const alerts = [];

  if (!currentPrice || currentPrice <= 0) return alerts;

  const now = Date.now();
  const entryPrice = position.avgEntry;

  // Initialize state if first check
  if (!state) {
    positionState.set(symbol, {
      lastPrice: currentPrice,
      lastCheckTime: now,
      entryPrice,
      dayHigh: currentPrice,
      dayLow: currentPrice,
      alertCount: 0,
      lastAlertTime: 0,
    });
    return alerts; // No alerts on first tick
  }

  // Check cooldown
  if (now - state.lastAlertTime < THRESHOLDS.cooldownMs) {
    // Still update price tracking even if on cooldown
    state.lastPrice = currentPrice;
    state.lastCheckTime = now;
    if (currentPrice > state.dayHigh) state.dayHigh = currentPrice;
    if (currentPrice < state.dayLow) state.dayLow = currentPrice;
    return alerts;
  }
  if (state.alertCount >= THRESHOLDS.maxAlertsPerSymbol) {
    state.lastPrice = currentPrice;
    return alerts;
  }

  // 1. Rapid move from last check (±2%)
  if (state.lastPrice > 0) {
    const moveFromLast = (currentPrice - state.lastPrice) / state.lastPrice;
    if (Math.abs(moveFromLast) >= THRESHOLDS.moveFromLastCheck) {
      alerts.push({
        type: 'RAPID_MOVE',
        symbol,
        direction: moveFromLast > 0 ? 'UP' : 'DOWN',
        magnitude: (moveFromLast * 100).toFixed(2) + '%',
        message: `${symbol} moved ${(moveFromLast * 100).toFixed(1)}% in ~60 seconds`,
      });
    }
  }

  // 2. Move from entry crossing ±5% threshold
  if (entryPrice > 0) {
    const moveFromEntry = (currentPrice - entryPrice) / entryPrice;
    const prevMoveFromEntry = (state.lastPrice - entryPrice) / entryPrice;
    if (Math.abs(moveFromEntry) >= THRESHOLDS.moveFromEntry && Math.abs(prevMoveFromEntry) < THRESHOLDS.moveFromEntry) {
      alerts.push({
        type: 'ENTRY_THRESHOLD',
        symbol,
        direction: moveFromEntry > 0 ? 'PROFIT' : 'LOSS',
        magnitude: (moveFromEntry * 100).toFixed(2) + '%',
        message: `${symbol} is now ${(moveFromEntry * 100).toFixed(1)}% from entry ($${entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)})`,
      });
    }
  }

  // 3. New day high/low (0.5% margin to avoid noise)
  if (currentPrice > state.dayHigh * 1.005) {
    alerts.push({
      type: 'NEW_HIGH',
      symbol,
      message: `${symbol} new intraday high: $${currentPrice.toFixed(2)} (prev high: $${state.dayHigh.toFixed(2)})`,
    });
  }
  if (currentPrice < state.dayLow * 0.995) {
    alerts.push({
      type: 'NEW_LOW',
      symbol,
      message: `${symbol} new intraday low: $${currentPrice.toFixed(2)} (prev low: $${state.dayLow.toFixed(2)})`,
    });
  }

  // Update state (ALWAYS, even without alerts)
  state.lastPrice = currentPrice;
  state.lastCheckTime = now;
  if (currentPrice > state.dayHigh) state.dayHigh = currentPrice;
  if (currentPrice < state.dayLow) state.dayLow = currentPrice;

  if (alerts.length > 0) {
    state.alertCount += alerts.length;
    state.lastAlertTime = now;
  }

  return alerts;
}

// ============================================================================
// STOP ENFORCEMENT
// ============================================================================

/**
 * Check if price has crossed below the trailing stop.
 * Returns the stop info if triggered, null otherwise.
 */
function checkStop(symbol, currentPrice, side = 'long') {
  const stop = trailingStops.get(symbol);
  if (!stop || !stop.stopPrice) return null;

  if (side === 'long' && currentPrice <= stop.stopPrice) {
    return stop;
  }
  if (side === 'short' && currentPrice >= stop.stopPrice) {
    return stop;
  }
  return null;
}

/**
 * Update trailing stop - ONLY moves UP for longs, DOWN for shorts.
 * Returns true if stop was updated, false if rejected (would lower it).
 */
function updateStop(symbol, newStopPrice, reason, side = 'long') {
  const existing = trailingStops.get(symbol);

  if (!existing) {
    // First stop - accept it
    trailingStops.set(symbol, {
      stopPrice: newStopPrice,
      setAt: new Date().toISOString(),
      setReason: reason,
    });
    return true;
  }

  // Only accept if moving in the right direction
  if (side === 'long' && newStopPrice > existing.stopPrice) {
    trailingStops.set(symbol, {
      stopPrice: newStopPrice,
      setAt: new Date().toISOString(),
      setReason: reason,
      previousStop: existing.stopPrice,
    });
    return true;
  }
  if (side === 'short' && newStopPrice < existing.stopPrice) {
    trailingStops.set(symbol, {
      stopPrice: newStopPrice,
      setAt: new Date().toISOString(),
      setReason: reason,
      previousStop: existing.stopPrice,
    });
    return true;
  }

  // Rejected - would lower the stop
  return false;
}

// ============================================================================
// LLM ANALYSIS
// ============================================================================

async function analyzePosition(position, alerts, context) {
  if (!reasoning) return null;

  const provider = reasoning.findAvailableProvider();
  if (!provider) return null;

  const state = positionState.get(position.symbol);
  const stop = trailingStops.get(position.symbol);
  const plPct = position.unrealizedPLPct;
  const recentActions = executedActions.get(position.symbol) || [];

  const userMsg = `POSITION ALERT: ${alerts.map(a => a.message).join('; ')}

POSITION:
- Symbol: ${position.symbol}
- Account: ${position.account === 'daytrade' ? 'DAY TRADE' : 'SWING'}
- Side: ${position.side || 'long'}
- Qty: ${position.qty}
- Entry: $${position.avgEntry.toFixed(2)}
- Current: $${position.currentPrice.toFixed(2)} (from Alpaca, real-time)
- P&L: ${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}% ($${position.unrealizedPL?.toFixed(2) || '?'})
- Day High: $${state?.dayHigh?.toFixed(2) || '?'} | Day Low: $${state?.dayLow?.toFixed(2) || '?'}
- Current Stop: ${stop ? '$' + stop.stopPrice.toFixed(2) : 'NONE SET'}

${recentActions.length > 0 ? 'RECENT ACTIONS ON THIS POSITION:\n' + recentActions.slice(-3).map(a => `- ${a.action} ${a.qty}x @ $${a.price?.toFixed(2) || '?'} (${a.time})`).join('\n') + '\n' : ''}
MARKET CONTEXT:
- VIX: ${context.vix || 'N/A'}
- Market: ${context.regime || 'Unknown'}
- Sentiment: ${context.sentiment || 'Unknown'}

RECENT NEWS: ${(context.news || []).slice(0, 3).map(n => n.headline).join('; ') || 'None'}

TODAY'S TRADES ON THIS UNDERLYING:
${(context.todayTrades || []).filter(t => t.symbol === position.symbol || t.underlying === (position.underlying || position.symbol.replace(/\d{6}[CP]\d{8}/, ''))).map(t => `- ${t.action} ${t.symbol} ${t.direction || ''} x${t.qty || '?'} (${t.reason || 'no reason'})`).join('\n') || 'No prior trades on this symbol today.'}

REMEMBER: TRIM/CLOSE will EXECUTE real orders. Be conservative. If thesis is intact, HOLD. Consider today's trade history before contradicting prior decisions.
Respond JSON only.`;

  try {
    const result = await reasoning.callLLMWithFallback([
      { role: 'system', content: MONITOR_PROMPT },
      { role: 'user', content: userMsg },
    ], { temperature: 0.2, maxTokens: 256 });

    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch (e) {
      const m = result.content.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    return { ...parsed, provider: result.provider };
  } catch (e) {
    console.error('[PositionMonitor] LLM error (all providers failed):', e.message);
    return null;
  }
}

// ============================================================================
// ORDER EXECUTION
// ============================================================================

function getClient(account) {
  return account === 'daytrade' ? daytradeClient : swingClient;
}

/**
 * Execute a TRIM (sell half the position)
 */
async function executeTrim(position) {
  const client = getClient(position.account);
  if (!client) return { success: false, reason: 'No client available' };

  const trimQty = Math.max(1, Math.floor(position.qty / 2));

  try {
    const result = await client.closePosition(position.symbol, trimQty);
    const action = {
      action: 'TRIM',
      qty: trimQty,
      price: position.currentPrice,
      time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
      orderId: result?.id || result?.order_id || null,
    };

    // Track executed action
    if (!executedActions.has(position.symbol)) executedActions.set(position.symbol, []);
    executedActions.get(position.symbol).push(action);
    trimmedToday.add(position.symbol);

    // Log to journal
    if (journal) {
      try {
        await journal.closeTrade({
          symbol: position.symbol,
          account: position.account === 'daytrade' ? 'day' : 'swing',
          exitPrice: position.currentPrice,
          exitQty: trimQty,
          reasoning: `TRIM: Sold ${trimQty} of ${position.qty} at $${position.currentPrice.toFixed(2)}`,
        });
      } catch (e) {}
    }

    return { success: true, qty: trimQty, orderId: action.orderId };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

/**
 * Execute a CLOSE (sell entire position)
 */
async function executeClose(position, reason) {
  const client = getClient(position.account);
  if (!client) return { success: false, reason: 'No client available' };

  try {
    const result = await client.closePosition(position.symbol);
    const action = {
      action: 'CLOSE',
      qty: position.qty,
      price: position.currentPrice,
      time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
      orderId: result?.id || result?.order_id || null,
      reason,
    };

    if (!executedActions.has(position.symbol)) executedActions.set(position.symbol, []);
    executedActions.get(position.symbol).push(action);

    // Log to journal
    if (journal) {
      try {
        await journal.closeTrade({
          symbol: position.symbol,
          account: position.account === 'daytrade' ? 'day' : 'swing',
          exitPrice: position.currentPrice,
          reasoning: reason,
        });
      } catch (e) {}
    }

    // Clean up state
    trailingStops.delete(position.symbol);

    return { success: true, qty: position.qty, orderId: action.orderId };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

/**
 * Verify an order was filled by checking Alpaca orders
 */
async function verifyOrderFilled(position, orderId) {
  if (!orderId) return null;
  const client = getClient(position.account);
  if (!client) return null;

  try {
    // Small delay to let order process
    await new Promise(r => setTimeout(r, 2000));
    const orders = await client.getOrders({ status: 'all', limit: 5 });
    const order = (orders || []).find(o => o.id === orderId);
    if (order) {
      return {
        status: order.status,
        filledQty: order.filled_qty,
        filledAvgPrice: order.filled_avg_price,
        filled: order.status === 'filled',
      };
    }
  } catch (e) {}
  return null;
}

// ============================================================================
// GET ALL POSITIONS (from Alpaca - real-time data)
// ============================================================================

async function getAllPositions() {
  const positions = [];

  if (daytradeClient) {
    try {
      const dtPositions = await daytradeClient.getPositions();
      (dtPositions || []).forEach(p => positions.push({
        ...p,
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        unrealizedPL: parseFloat(p.unrealized_pl || 0),
        unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
        marketValue: parseFloat(p.market_value || 0),
        costBasis: parseFloat(p.cost_basis || 0),
        changeToday: parseFloat(p.change_today || 0) * 100,
        account: 'daytrade',
        side: p.side || 'long',
      }));
    } catch (e) {}
  }

  if (swingClient) {
    try {
      const swPositions = await swingClient.getPositions();
      (swPositions || []).forEach(p => positions.push({
        ...p,
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        unrealizedPL: parseFloat(p.unrealized_pl || 0),
        unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
        marketValue: parseFloat(p.market_value || 0),
        costBasis: parseFloat(p.cost_basis || 0),
        changeToday: parseFloat(p.change_today || 0) * 100,
        account: 'swing',
        side: p.side || 'long',
      }));
    } catch (e) {}
  }

  return positions;
}

// ============================================================================
// POSITION MONITOR CLASS
// ============================================================================

class PositionMonitor {
  constructor() {
    this.name = 'Position Monitor';
    this.emoji = '👁️';
    this.lastRun = null;
    this.isRunning = false;
  }

  /**
   * Single tick - check all positions using ALPACA data (no Yahoo)
   */
  async tick() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const positions = await getAllPositions();
      if (positions.length === 0) {
        this.isRunning = false;
        return;
      }

      // Market context from brain
      const ctx = brain.ctx;
      const context = {
        vix: ctx.market.vix,
        regime: ctx.market.regime,
        sentiment: ctx.sentiment.overall,
        news: ctx.catalysts.newsBreaking || [],
        todayTrades: (ctx.dayTrader.trades || []).slice(-10),
      };

      for (const position of positions) {
        const currentPrice = position.currentPrice;
        if (!currentPrice || currentPrice <= 0) continue;

        // Update trade journal peak/trough (uses Alpaca price)
        if (journal) {
          try {
            const acct = position.account === 'daytrade' ? 'day' : 'swing';
            journal.updatePeak(position.symbol, acct, currentPrice);
          } catch (e) {}
        }

        // ---- STOP ENFORCEMENT (runs every tick, no cooldown) ----
        const stopTriggered = checkStop(position.symbol, currentPrice, position.side);
        if (stopTriggered) {
          console.log(`[PositionMonitor] STOP TRIGGERED for ${position.symbol} at $${currentPrice.toFixed(2)} (stop: $${stopTriggered.stopPrice.toFixed(2)})`);

          // Log stop triggered
          if (eventLogger) {
            eventLogger.logTradingEvent({
              agent: 'position_monitor',
              type: 'STOP_TRIGGERED',
              symbol: position.symbol,
              side: 'sell',
              qty: position.qty,
              price: currentPrice,
              stop_price: stopTriggered.stopPrice,
              reason: stopTriggered.setReason,
              pnl: position.unrealizedPL,
              result: 'pending',
            });
          }

          const closeResult = await executeClose(position, `Stop loss triggered at $${stopTriggered.stopPrice.toFixed(2)}`);

          const verified = closeResult.success ? await verifyOrderFilled(position, closeResult.orderId) : null;

          await discord.alert(
            `${this.emoji} **STOP LOSS TRIGGERED** [${position.account === 'daytrade' ? 'DAY' : 'SWING'}]\n\n` +
            `🔴 **${position.symbol}** hit stop at $${stopTriggered.stopPrice.toFixed(2)}\n` +
            `Entry: $${position.avgEntry.toFixed(2)} → Exit: $${currentPrice.toFixed(2)} (${position.unrealizedPLPct >= 0 ? '+' : ''}${position.unrealizedPLPct.toFixed(1)}%)\n` +
            `Qty: ${position.qty} | P&L: $${position.unrealizedPL.toFixed(2)}\n\n` +
            `**Order:** ${closeResult.success ? '✅ FILLED' : '❌ FAILED: ' + closeResult.reason}\n` +
            (verified ? `**Confirmed:** ${verified.filledQty} filled @ $${verified.filledAvgPrice}\n` : '') +
            `_Stop was set: ${stopTriggered.setReason}_`
          );

          brain.addReasoning(
            `STOP TRIGGERED: ${position.symbol} closed at $${currentPrice.toFixed(2)} (stop: $${stopTriggered.stopPrice.toFixed(2)})`,
            'CLOSE'
          );
          continue; // Position is closed, move to next
        }

        // ---- THRESHOLD ALERTS (with cooldown) ----
        const alerts = checkThresholds(position, currentPrice);
        if (alerts.length === 0) continue;

        console.log(`[PositionMonitor] ${alerts.length} alert(s) for ${position.symbol}`);

        // Get LLM analysis
        const analysis = await analyzePosition(position, alerts, context);

        // Log LLM decision
        if (eventLogger && analysis) {
          eventLogger.logTradingEvent({
            agent: 'position_monitor',
            type: 'DECISION',
            symbol: position.symbol,
            side: analysis.action === 'CLOSE' ? 'sell' : analysis.action === 'TRIM' ? 'sell' : 'hold',
            reason: analysis.reasoning,
            conviction: analysis.urgency,
            data: {
              action: analysis.action,
              thesisIntact: analysis.thesisIntact,
              adjustStopTo: analysis.adjustStopTo,
              provider: analysis.provider,
            },
            result: 'pending',
          });
        }

        // ---- EXECUTE LLM DECISIONS ----
        let executionResult = null;

        if (analysis?.action === 'CLOSE' && analysis.urgency === 'HIGH') {
          // CLOSE - full position exit (always allowed)
          executionResult = await executeClose(position, `LLM CLOSE: ${analysis.reasoning}`);
          const verified = executionResult.success ? await verifyOrderFilled(position, executionResult.orderId) : null;
          executionResult.verified = verified;

        } else if (analysis?.action === 'TRIM' && analysis.urgency === 'HIGH') {
          // TRIM - sell half. Can trim multiple times if thesis changes.
          // Guard: must have >1 qty to trim (otherwise just close)
          if (position.qty <= 1) {
            // Can't trim 1 unit - treat as CLOSE
            executionResult = await executeClose(position, `LLM TRIM→CLOSE (qty=1): ${analysis.reasoning}`);
          } else {
            executionResult = await executeTrim(position);
          }
          const verified = executionResult.success ? await verifyOrderFilled(position, executionResult.orderId) : null;
          executionResult.verified = verified;
          executionResult.action = 'TRIM';
        }

        // ---- UPDATE TRAILING STOP (only UP for longs) ----
        if (analysis?.adjustStopTo) {
          const newStop = parseFloat(analysis.adjustStopTo);
          if (newStop > 0) {
            const accepted = updateStop(position.symbol, newStop, analysis.reasoning, position.side);
            if (!accepted) {
              analysis._stopRejected = true;
              analysis._currentStop = trailingStops.get(position.symbol)?.stopPrice;

              // Log rejected stop adjustment
              if (eventLogger) {
                eventLogger.logTradingEvent({
                  agent: 'position_monitor',
                  type: 'STOP_FAILED',
                  symbol: position.symbol,
                  stop_price: newStop,
                  reason: `Stop adjustment rejected: would lower from $${analysis._currentStop.toFixed(2)}`,
                  result: 'rejected',
                });
              }
            } else {
              // Log successful stop adjustment
              if (eventLogger) {
                eventLogger.logTradingEvent({
                  agent: 'position_monitor',
                  type: 'STOP_SET',
                  symbol: position.symbol,
                  stop_price: newStop,
                  reason: analysis.reasoning,
                  result: 'success',
                });
              }
            }
          }
        }

        // Post to Discord with execution details
        await this.postAlert(position, alerts, analysis, executionResult);

        // Store in brain
        brain.addReasoning(
          `MONITOR: ${position.symbol} ${alerts[0].type} - LLM: ${analysis?.action || 'N/A'}${executionResult?.success ? ' [EXECUTED]' : ''}: ${analysis?.reasoning || 'No analysis'}`,
          analysis?.action || 'ALERT'
        );
      }

      this.lastRun = new Date();
    } catch (error) {
      console.error('[PositionMonitor] Error:', error.message);
    }

    this.isRunning = false;
  }

  /**
   * Post alert to Discord with execution confirmation
   */
  async postAlert(position, alerts, analysis, executionResult) {
    const acctLabel = position.account === 'daytrade' ? 'DAY' : 'SWING';
    const state = positionState.get(position.symbol);
    const stop = trailingStops.get(position.symbol);

    let msg = `${this.emoji} **POSITION ALERT** [${acctLabel}]\n\n`;

    // Alert triggers
    for (const alert of alerts) {
      const emoji = alert.type === 'NEW_HIGH' ? '📈' : alert.type === 'NEW_LOW' ? '📉' : '⚡';
      msg += `${emoji} ${alert.message}\n`;
    }
    msg += '\n';

    // Position details (ALL from Alpaca - accurate)
    const plPct = position.unrealizedPLPct;
    const plEmoji = plPct >= 0 ? '🟢' : '🔴';
    msg += `**${position.symbol}**: ${position.qty}x @ $${position.avgEntry.toFixed(2)} → $${position.currentPrice.toFixed(2)} (${plEmoji} ${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}%)\n`;
    msg += `P&L: $${position.unrealizedPL.toFixed(2)} | Day High: $${state?.dayHigh?.toFixed(2) || '?'} | Day Low: $${state?.dayLow?.toFixed(2) || '?'}\n`;
    if (stop) msg += `Trailing Stop: $${stop.stopPrice.toFixed(2)}\n`;
    msg += '\n';

    // LLM analysis
    if (analysis) {
      const urgencyEmoji = analysis.urgency === 'HIGH' ? '🔴' : analysis.urgency === 'MEDIUM' ? '🟡' : '🟢';
      msg += `**LLM Decision:** ${analysis.action} ${urgencyEmoji}\n`;
      msg += `_${analysis.reasoning}_\n`;
      msg += `Thesis intact: ${analysis.thesisIntact ? '✅' : '❌'}\n`;

      // Stop adjustment result
      if (analysis.adjustStopTo) {
        if (analysis._stopRejected) {
          msg += `Stop suggestion $${analysis.adjustStopTo} **REJECTED** (would lower from $${analysis._currentStop.toFixed(2)}) ⛔\n`;
        } else {
          msg += `Stop updated → $${analysis.adjustStopTo} ✅\n`;
        }
      }
      if (analysis.provider) msg += `_via ${analysis.provider}_\n`;
    }

    // EXECUTION RESULT
    if (executionResult) {
      msg += '\n';
      if (executionResult.success) {
        const actionLabel = executionResult.action === 'TRIM' ? 'TRIMMED' : 'CLOSED';
        msg += `**✅ ORDER EXECUTED: ${actionLabel} ${executionResult.qty}x @ $${position.currentPrice.toFixed(2)}**\n`;
        if (executionResult.verified?.filled) {
          msg += `**Confirmed:** ${executionResult.verified.filledQty} filled @ $${executionResult.verified.filledAvgPrice}\n`;
        } else if (executionResult.verified) {
          msg += `Order status: ${executionResult.verified.status}\n`;
        }
      } else {
        msg += `**❌ ORDER FAILED:** ${executionResult.reason}\n`;
      }
    } else if (analysis?.action === 'TRIM' && trimmedToday.has(position.symbol)) {
      msg += '\n_TRIM skipped: already trimmed this symbol today_\n';
    } else if (analysis?.action === 'TRIM' && analysis.urgency !== 'HIGH') {
      msg += '\n_TRIM noted but not executed (urgency not HIGH)_\n';
    } else if (analysis?.action === 'CLOSE' && analysis.urgency !== 'HIGH') {
      msg += '\n_CLOSE noted but not executed (urgency not HIGH)_\n';
    }

    await discord.alert(msg);
  }

  /**
   * Set initial stop for a new position (called by day trader / swing scanner)
   */
  setStop(symbol, stopPrice, reason = 'Initial stop') {
    trailingStops.set(symbol, {
      stopPrice,
      setAt: new Date().toISOString(),
      setReason: reason,
    });
    console.log(`[PositionMonitor] Stop set for ${symbol}: $${stopPrice.toFixed(2)}`);
  }

  /**
   * Reset daily state (call at start of day)
   */
  resetDaily() {
    positionState.clear();
    trimmedToday.clear();
    executedActions.clear();
    // Note: trailingStops persist across days (intentional)
  }

  /**
   * Get monitor status
   */
  getStatus() {
    return {
      trackedPositions: positionState.size,
      stops: [...trailingStops.entries()].map(([sym, s]) => ({
        symbol: sym,
        stopPrice: s.stopPrice,
        setAt: s.setAt,
      })),
      positions: [...positionState.entries()].map(([sym, state]) => ({
        symbol: sym,
        lastPrice: state.lastPrice,
        dayHigh: state.dayHigh,
        dayLow: state.dayLow,
        alertCount: state.alertCount,
      })),
      trimmedToday: [...trimmedToday],
      executedActions: Object.fromEntries(executedActions),
    };
  }
}

// Export class AND module-level stop functions so other agents can set stops
module.exports = PositionMonitor;
module.exports.setStop = function(symbol, stopPrice, reason) {
  return updateStop(symbol, stopPrice, reason || 'Initial stop', 'long');
};
module.exports.getStop = function(symbol) {
  return trailingStops.get(symbol) || null;
};
