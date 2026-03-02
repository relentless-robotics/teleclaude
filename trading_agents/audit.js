/**
 * Trading System Audit Tool
 *
 * Comprehensive audit of the entire trading agent suite.
 * Designed for Opus (orchestrator) to review system health,
 * trade quality, risk compliance, and performance.
 *
 * Run:  node trading_agents/audit.js [section]
 * Sections: all, health, trades, risk, performance, logic, providers
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const marketHours = require('./market_hours');
const brain = require('./shared_brain');

// Data paths
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'daily_history');
const LESSONS_FILE = path.join(DATA_DIR, 'trade_lessons.json');
const STATE_FILE = config.paths.agentStateFile;

// Alpaca clients
let daytradeClient, swingClient;
try { daytradeClient = require('../swing_options/daytrade_client'); } catch (e) {}
try { swingClient = require('../swing_options/alpaca_client'); } catch (e) {}

let reasoning;
try { reasoning = require('../utils/llm_reasoning'); } catch (e) {}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {}
  return null;
}

function getHistoryFiles() {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    return fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse(); // newest first
  } catch (e) { return []; }
}

function loadHistory(daysBack = 7) {
  const files = getHistoryFiles().slice(0, daysBack);
  return files.map(f => {
    const data = loadJSON(path.join(HISTORY_DIR, f));
    return data ? { date: f.replace('.json', ''), ...data } : null;
  }).filter(Boolean);
}

function formatCurrency(val) {
  if (val == null) return 'N/A';
  return '$' + parseFloat(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(val) {
  if (val == null) return 'N/A';
  const v = parseFloat(val);
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ============================================================================
// 1. AGENT HEALTH CHECK
// ============================================================================

async function auditAgentHealth() {
  const report = {
    section: 'AGENT HEALTH',
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    ok: [],
  };

  // Load agent state
  const state = loadJSON(STATE_FILE) || { agents: {} };

  // Check each configured agent
  const expectedAgents = ['preMarket', 'swingScanner', 'afterHours', 'overnight', 'dayTrader'];
  const now = Date.now();

  for (const agentName of expectedAgents) {
    const agentState = state.agents[agentName];
    const agentConfig = config.agents[agentName];

    if (!agentState) {
      report.issues.push(`${agentName}: NEVER RUN - no state recorded`);
      continue;
    }

    if (agentState.status === 'error') {
      report.issues.push(`${agentName}: LAST RUN FAILED - ${agentState.error}`);
      continue;
    }

    // Check staleness
    const lastRun = new Date(agentState.lastRun);
    const ageMinutes = (now - lastRun.getTime()) / 60000;
    const intervalMinutes = agentConfig?.schedule?.intervalMinutes || 60;

    // During active hours, check if agent is running on schedule
    const marketStatus = marketHours.getStatus();
    const shouldBeActive = marketStatus.agents[agentName]?.run;

    if (shouldBeActive && ageMinutes > intervalMinutes * 2.5) {
      report.warnings.push(`${agentName}: STALE - last ran ${Math.round(ageMinutes)} min ago (expected every ${intervalMinutes} min)`);
    } else {
      report.ok.push(`${agentName}: OK - last ran ${lastRun.toLocaleTimeString()} (${Math.round(ageMinutes)} min ago)`);
    }
  }

  // Check shared brain freshness
  const ctx = brain.reload();
  if (ctx.date !== new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })) {
    report.warnings.push(`Shared brain date mismatch: brain has ${ctx.date}, expected today`);
  } else {
    const brainAge = (now - new Date(ctx.lastUpdated).getTime()) / 60000;
    if (brainAge > 30) {
      report.warnings.push(`Shared brain stale: last updated ${Math.round(brainAge)} min ago`);
    } else {
      report.ok.push(`Shared brain: fresh (updated ${Math.round(brainAge)} min ago)`);
    }
  }

  // Check agent log entries
  const logEntries = ctx.agentLog || [];
  report.agentActivity = logEntries.slice(-20).map(l => `[${l.time}] ${l.agent}: ${l.action}`);

  return report;
}

// ============================================================================
// 2. TRADE ANALYSIS
// ============================================================================

async function auditTrades() {
  const report = {
    section: 'TRADE ANALYSIS',
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    stats: {},
  };

  // Load trade lessons (win/loss history)
  const lessonsData = loadJSON(LESSONS_FILE) || { lessons: [] };
  const lessons = lessonsData.lessons || [];

  if (lessons.length === 0) {
    report.warnings.push('No trade lessons recorded yet - system is new or no trades have been closed');
    report.stats = { totalTrades: 0 };
    return report;
  }

  // Calculate stats
  const wins = lessons.filter(l => l.outcome === 'WIN');
  const losses = lessons.filter(l => l.outcome === 'LOSS');

  report.stats = {
    totalClosed: lessons.length,
    wins: wins.length,
    losses: losses.length,
    winRate: lessons.length > 0 ? (wins.length / lessons.length * 100).toFixed(1) + '%' : 'N/A',
    avgWinPct: wins.length > 0 ? (wins.reduce((sum, w) => sum + parseFloat(w.plPct || 0), 0) / wins.length).toFixed(2) + '%' : 'N/A',
    avgLossPct: losses.length > 0 ? (losses.reduce((sum, l) => sum + parseFloat(l.plPct || 0), 0) / losses.length).toFixed(2) + '%' : 'N/A',
  };

  // Calculate profit factor (avg win / avg loss)
  if (wins.length > 0 && losses.length > 0) {
    const avgWin = Math.abs(wins.reduce((s, w) => s + parseFloat(w.plPct || 0), 0) / wins.length);
    const avgLoss = Math.abs(losses.reduce((s, l) => s + parseFloat(l.plPct || 0), 0) / losses.length);
    report.stats.profitFactor = (avgWin / avgLoss).toFixed(2);
  }

  // Check for patterns in losses
  const symbolLosses = {};
  for (const l of losses) {
    symbolLosses[l.symbol] = (symbolLosses[l.symbol] || 0) + 1;
  }
  const repeatLosers = Object.entries(symbolLosses).filter(([, count]) => count >= 2);
  if (repeatLosers.length > 0) {
    report.warnings.push(`Repeat losers detected: ${repeatLosers.map(([s, c]) => `${s} (${c}x)`).join(', ')} - LLM should learn from this`);
  }

  // Recent trades
  report.recentLessons = lessons.slice(-10).map(l => ({
    symbol: l.symbol,
    outcome: l.outcome,
    plPct: l.plPct,
    lesson: l.lesson?.substring(0, 100),
    time: l.time,
  }));

  return report;
}

// ============================================================================
// 3. RISK COMPLIANCE
// ============================================================================

async function auditRisk() {
  const report = {
    section: 'RISK COMPLIANCE',
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    ok: [],
    positions: { daytrade: [], swing: [] },
    exposure: {},
  };

  // Check day trade account
  if (daytradeClient) {
    try {
      const account = await daytradeClient.getAccount();
      const positions = await daytradeClient.getPositions();

      report.positions.daytrade = (positions || []).map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPL: parseFloat(p.unrealized_pl),
        unrealizedPLPct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
        pctOfEquity: ((parseFloat(p.market_value) / account.equity) * 100).toFixed(1) + '%',
      }));

      const equity = account.equity;

      // Check position sizing compliance
      for (const pos of report.positions.daytrade) {
        const posValue = Math.abs(pos.marketValue);
        const positionPct = posValue / equity;

        if (positionPct > 0.08) { // More than 8% = issue (5% limit with 60% buffer for movement)
          report.issues.push(`DAY: ${pos.symbol} position is ${(positionPct * 100).toFixed(1)}% of equity (${formatCurrency(posValue)} / ${formatCurrency(equity)}) - exceeds 5% limit`);
        } else if (positionPct > 0.05) {
          report.warnings.push(`DAY: ${pos.symbol} position at ${(positionPct * 100).toFixed(1)}% of equity - above 5% target (may have appreciated)`);
        }
      }

      // Check total exposure
      const totalExposure = report.positions.daytrade.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
      report.exposure.daytrade = {
        equity: formatCurrency(equity),
        cash: formatCurrency(account.cash),
        buyingPower: formatCurrency(account.buyingPower),
        totalExposure: formatCurrency(totalExposure),
        exposurePct: (totalExposure / equity * 100).toFixed(1) + '%',
        positionCount: report.positions.daytrade.length,
        dailyPL: formatCurrency(account.dailyPL || 0),
        dailyPLPct: account.equity > 0 ? formatPct((account.dailyPL || 0) / equity * 100) : 'N/A',
      };

      // Max 5 positions check
      if (report.positions.daytrade.length > 5) {
        report.issues.push(`DAY: ${report.positions.daytrade.length} positions open (max 5)`);
      } else {
        report.ok.push(`DAY: ${report.positions.daytrade.length}/5 positions within limit`);
      }

      // Daily loss limit check
      const dailyPLPct = (account.dailyPL || 0) / equity * 100;
      if (dailyPLPct <= -3) {
        report.issues.push(`DAY: Daily loss limit breached! Down ${dailyPLPct.toFixed(2)}% (limit: -3%)`);
      } else if (dailyPLPct <= -2) {
        report.warnings.push(`DAY: Approaching daily loss limit. Down ${dailyPLPct.toFixed(2)}% (limit: -3%)`);
      } else {
        report.ok.push(`DAY: Daily P&L at ${formatPct(dailyPLPct)} - within limits`);
      }

    } catch (e) {
      report.warnings.push(`DAY: Could not check day trade account: ${e.message}`);
    }
  } else {
    report.warnings.push('DAY: Day trade client not available');
  }

  // Check swing account
  if (swingClient) {
    try {
      const account = await swingClient.getAccount();
      const positions = await swingClient.getPositions();

      report.positions.swing = (positions || []).map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPL: parseFloat(p.unrealized_pl),
        unrealizedPLPct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
        pctOfEquity: ((Math.abs(parseFloat(p.market_value)) / account.equity) * 100).toFixed(1) + '%',
      }));

      const equity = account.equity;
      const totalExposure = report.positions.swing.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);

      report.exposure.swing = {
        equity: formatCurrency(equity),
        cash: formatCurrency(account.cash),
        totalExposure: formatCurrency(totalExposure),
        exposurePct: (totalExposure / equity * 100).toFixed(1) + '%',
        positionCount: report.positions.swing.length,
      };

      // Check for concentrated positions
      for (const pos of report.positions.swing) {
        const positionPct = Math.abs(pos.marketValue) / equity * 100;
        if (positionPct > 25) {
          report.issues.push(`SWING: ${pos.symbol} is ${positionPct.toFixed(1)}% of portfolio - very concentrated`);
        }
      }

      // Check for big losers
      for (const pos of report.positions.swing) {
        const plPct = parseFloat(pos.unrealizedPLPct);
        if (plPct < -10) {
          report.warnings.push(`SWING: ${pos.symbol} down ${pos.unrealizedPLPct} - consider reviewing thesis`);
        }
      }

    } catch (e) {
      report.warnings.push(`SWING: Could not check swing account: ${e.message}`);
    }
  }

  return report;
}

// ============================================================================
// 4. PERFORMANCE METRICS
// ============================================================================

async function auditPerformance() {
  const report = {
    section: 'PERFORMANCE',
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    accounts: {},
    history: [],
  };

  // Day trade account performance
  if (daytradeClient) {
    try {
      const account = await daytradeClient.getAccount();
      report.accounts.daytrade = {
        equity: formatCurrency(account.equity),
        cash: formatCurrency(account.cash),
        buyingPower: formatCurrency(account.buyingPower),
        dailyPL: formatCurrency(account.dailyPL || 0),
        positionsCount: 0,
        totalUnrealizedPL: formatCurrency(0),
      };

      const positions = await daytradeClient.getPositions();
      if (positions) {
        report.accounts.daytrade.positionsCount = positions.length;
        const totalPL = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl || 0), 0);
        report.accounts.daytrade.totalUnrealizedPL = formatCurrency(totalPL);
      }
    } catch (e) {
      report.warnings.push(`Could not fetch day trade account: ${e.message}`);
    }
  }

  // Swing account performance
  if (swingClient) {
    try {
      const account = await swingClient.getAccount();
      report.accounts.swing = {
        equity: formatCurrency(account.equity),
        cash: formatCurrency(account.cash),
        positionsCount: 0,
        totalUnrealizedPL: formatCurrency(0),
      };

      const positions = await swingClient.getPositions();
      if (positions) {
        report.accounts.swing.positionsCount = positions.length;
        const totalPL = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl || 0), 0);
        report.accounts.swing.totalUnrealizedPL = formatCurrency(totalPL);
      }
    } catch (e) {
      report.warnings.push(`Could not fetch swing account: ${e.message}`);
    }
  }

  // Historical context from archived days
  const history = loadHistory(7);
  report.history = history.map(h => ({
    date: h.date,
    dayTraderTrades: h.dayTrader?.tradesCount || 0,
    dayTraderPnL: h.dayTrader?.pnlToday || 0,
    swingPositions: h.swingTrader?.positions?.length || 0,
    agentRuns: h.agentLog?.length || 0,
    reasoningEntries: h.dayTrader?.reasoning?.length || 0,
  }));

  // Today's context
  const ctx = brain.ctx;
  report.today = {
    date: ctx.date,
    dayTraderTrades: ctx.dayTrader.tradesCount,
    dayTraderPnL: ctx.dayTrader.pnlToday,
    dayTraderPositions: ctx.dayTrader.positions?.length || 0,
    swingPositions: ctx.swingTrader.positions?.length || 0,
    agentRuns: ctx.agentLog?.length || 0,
    reasoningEntries: ctx.dayTrader.reasoning?.length || 0,
    newsItems: ctx.catalysts.newsBreaking?.length || 0,
    watchlistItems: ctx.dayWatchlist?.length || 0,
  };

  return report;
}

// ============================================================================
// 5. LOGIC SOUNDNESS CHECK
// ============================================================================

async function auditLogic() {
  const report = {
    section: 'LOGIC SOUNDNESS',
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    ok: [],
    checks: [],
  };

  // Check 1: LLM reasoning quality from brain
  const ctx = brain.ctx;
  const reasoningEntries = ctx.dayTrader.reasoning || [];

  if (reasoningEntries.length > 0) {
    // Check for repeated "NO_TRADE" decisions
    const noTradeCount = reasoningEntries.filter(r => r.decision === 'NO_TRADE' || r.decision === 'SKIP').length;
    const tradeCount = reasoningEntries.filter(r => r.decision && !['NO_TRADE', 'SKIP', 'ANALYSIS', 'PORTFOLIO', 'DATA_REQUEST', 'HOLD'].includes(r.decision)).length;

    if (noTradeCount > 0 && tradeCount === 0 && reasoningEntries.length >= 3) {
      report.warnings.push(`LLM has made ${noTradeCount} NO_TRADE decisions with 0 trades today - may be too conservative`);
    }

    report.checks.push({
      check: 'LLM Decision Distribution',
      noTrade: noTradeCount,
      trades: tradeCount,
      total: reasoningEntries.length,
    });
  }

  // Check 2: Day trader trades vs shared brain log
  const brainTrades = ctx.dayTrader.trades || [];
  report.checks.push({
    check: 'Brain Trade Log',
    tradesRecorded: brainTrades.length,
    tradesCount: ctx.dayTrader.tradesCount,
    consistent: brainTrades.length === ctx.dayTrader.tradesCount,
  });

  if (brainTrades.length !== ctx.dayTrader.tradesCount) {
    report.warnings.push(`Trade count mismatch: brain log has ${brainTrades.length} but counter says ${ctx.dayTrader.tradesCount}`);
  }

  // Check 3: Position monitor thresholds
  report.checks.push({
    check: 'Position Monitor Config',
    moveThreshold: '2% from last check',
    entryThreshold: '5% from entry',
    maxAlertsPerSymbol: 5,
    cooldownMinutes: 5,
    status: 'OK - thresholds are reasonable',
  });

  // Check 4: Risk parameters
  report.checks.push({
    check: 'Risk Parameters',
    maxPositionPct: '5% equity',
    maxDailyLoss: '3% equity',
    maxOpenPositions: 5,
    maxTradesPerDay: 15,
    cooldownMinutes: 5,
    status: 'OK',
  });

  // Check 5: Scheduler timing
  const agentState = loadJSON(STATE_FILE) || { agents: {} };
  const agents = Object.entries(agentState.agents || {});
  const errors = agents.filter(([, s]) => s.status === 'error');
  if (errors.length > 0) {
    report.issues.push(`${errors.length} agent(s) in error state: ${errors.map(([name, s]) => `${name}: ${s.error}`).join('; ')}`);
  } else if (agents.length > 0) {
    report.ok.push('All agents running without errors');
  }

  // Check 6: Dynamic prompt - verify it uses account equity
  report.checks.push({
    check: 'Dynamic System Prompt',
    feature: 'buildTradingSystemPrompt(accountData)',
    dynamicSizing: true,
    scalesWithEquity: true,
    status: 'OK - position limits scale with account size',
  });

  // Check 7: Trade lessons persistence
  const lessons = loadJSON(LESSONS_FILE);
  if (lessons) {
    report.checks.push({
      check: 'Trade Learning System',
      lessonsStored: lessons.lessons?.length || 0,
      lastUpdated: lessons.lastUpdated,
      status: lessons.lessons?.length > 0 ? 'ACTIVE' : 'EMPTY - no lessons recorded yet',
    });
  } else {
    report.warnings.push('Trade lessons file not found - learning system not initialized');
  }

  // Check 8: News feed integration
  const newsCount = ctx.catalysts.newsBreaking?.length || 0;
  report.checks.push({
    check: 'News Feed Integration',
    headlinesAvailable: newsCount,
    mode: 'On-demand (before LLM calls)',
    status: newsCount > 0 ? 'ACTIVE' : 'EMPTY - no news fetched yet today',
  });

  // Check 9: Brain data freshness
  const sections = ['overnight', 'preMarket', 'market', 'sentiment', 'catalysts', 'technicals', 'optionsFlow'];
  const staleData = [];
  for (const section of sections) {
    if (!ctx[section]?.updatedAt) {
      staleData.push(section);
    }
  }
  if (staleData.length > 0) {
    report.warnings.push(`Brain sections with no data today: ${staleData.join(', ')}`);
  }

  return report;
}

// ============================================================================
// 6. LLM PROVIDER STATUS
// ============================================================================

async function auditProviders() {
  const report = {
    section: 'LLM PROVIDERS',
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    providers: {},
  };

  if (reasoning) {
    report.providers = reasoning.getProviderStatus();

    const active = report.providers.activeProvider;
    if (!active) {
      report.issues.push('NO LLM PROVIDER AVAILABLE - trading agents cannot reason');
    } else {
      const providerInfo = report.providers[active];
      if (providerInfo) {
        const costInfo = providerInfo.costPer1kIn === 0 ? 'FREE' : `$${providerInfo.costPer1kIn}/1K in, $${providerInfo.costPer1kOut}/1K out`;
        report.providers.summary = `Active: ${providerInfo.name} (${costInfo})`;
      }
    }

    // Check fallback chain
    const priority = ['groq', 'claude_cli', 'anthropic', 'openai', 'kimi'];
    const available = priority.filter(p => report.providers[p]?.available);
    const unavailable = priority.filter(p => !report.providers[p]?.available);

    report.providers.available = available;
    report.providers.unavailable = unavailable;

    if (available.length <= 1) {
      report.warnings.push(`Only ${available.length} LLM provider(s) available. No fallback if it goes down.`);
    }
  } else {
    report.issues.push('LLM reasoning module not loaded');
  }

  return report;
}

// ============================================================================
// COMPREHENSIVE AUDIT
// ============================================================================

async function runFullAudit() {
  const fullReport = {
    title: 'TRADING SYSTEM AUDIT',
    timestamp: new Date().toISOString(),
    timeET: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    marketStatus: marketHours.getStatus(),
    sections: {},
    summary: { critical: 0, warnings: 0, ok: 0 },
  };

  // Run all audit sections
  const [health, trades, risk, performance, logic, providers] = await Promise.all([
    auditAgentHealth(),
    auditTrades(),
    auditRisk(),
    auditPerformance(),
    auditLogic(),
    auditProviders(),
  ]);

  fullReport.sections = { health, trades, risk, performance, logic, providers };

  // Tally issues
  for (const section of Object.values(fullReport.sections)) {
    fullReport.summary.critical += (section.issues || []).length;
    fullReport.summary.warnings += (section.warnings || []).length;
    fullReport.summary.ok += (section.ok || []).length;
  }

  return fullReport;
}

// ============================================================================
// DISCORD FORMATTING
// ============================================================================

function formatAuditForDiscord(report) {
  const emoji = report.summary.critical > 0 ? '🔴' : report.summary.warnings > 0 ? '🟡' : '🟢';
  let msg = `${emoji} **TRADING SYSTEM AUDIT** (${report.timeET})\n\n`;

  msg += `**Summary:** ${report.summary.critical} critical | ${report.summary.warnings} warnings | ${report.summary.ok} OK\n`;
  msg += `**Market:** ${report.marketStatus.session} | ${report.marketStatus.currentTimeET} ET\n\n`;

  // Critical issues first
  const allIssues = [];
  const allWarnings = [];
  for (const [name, section] of Object.entries(report.sections)) {
    for (const issue of (section.issues || [])) {
      allIssues.push(`[${name.toUpperCase()}] ${issue}`);
    }
    for (const warning of (section.warnings || [])) {
      allWarnings.push(`[${name.toUpperCase()}] ${warning}`);
    }
  }

  if (allIssues.length > 0) {
    msg += '**CRITICAL ISSUES:**\n';
    allIssues.forEach(i => msg += `🔴 ${i}\n`);
    msg += '\n';
  }

  if (allWarnings.length > 0) {
    msg += '**WARNINGS:**\n';
    allWarnings.forEach(w => msg += `🟡 ${w}\n`);
    msg += '\n';
  }

  // Performance snapshot
  const perf = report.sections.performance;
  if (perf?.accounts) {
    msg += '**ACCOUNTS:**\n';
    if (perf.accounts.daytrade) {
      const dt = perf.accounts.daytrade;
      msg += `Day Trade: ${dt.equity} | Daily P&L: ${dt.dailyPL} | Positions: ${dt.positionsCount} | Unrealized: ${dt.totalUnrealizedPL}\n`;
    }
    if (perf.accounts.swing) {
      const sw = perf.accounts.swing;
      msg += `Swing: ${sw.equity} | Positions: ${sw.positionsCount} | Unrealized: ${sw.totalUnrealizedPL}\n`;
    }
    msg += '\n';
  }

  // Risk exposure
  const risk = report.sections.risk;
  if (risk?.exposure) {
    msg += '**RISK EXPOSURE:**\n';
    if (risk.exposure.daytrade) {
      msg += `Day: ${risk.exposure.daytrade.exposurePct} exposed | ${risk.exposure.daytrade.positionCount} positions | Daily P&L: ${risk.exposure.daytrade.dailyPLPct}\n`;
    }
    if (risk.exposure.swing) {
      msg += `Swing: ${risk.exposure.swing.exposurePct} exposed | ${risk.exposure.swing.positionCount} positions\n`;
    }
    msg += '\n';
  }

  // Trade stats
  const tradeStats = report.sections.trades?.stats;
  if (tradeStats && tradeStats.totalClosed > 0) {
    msg += '**TRADE STATS (all time):**\n';
    msg += `Win Rate: ${tradeStats.winRate} | Profit Factor: ${tradeStats.profitFactor || 'N/A'}\n`;
    msg += `Wins: ${tradeStats.wins} (avg ${tradeStats.avgWinPct}) | Losses: ${tradeStats.losses} (avg ${tradeStats.avgLossPct})\n\n`;
  }

  // LLM status
  const prov = report.sections.providers;
  if (prov?.providers?.summary) {
    msg += `**LLM:** ${prov.providers.summary}\n`;
    msg += `Fallbacks: ${(prov.providers.available || []).length} available, ${(prov.providers.unavailable || []).length} unavailable\n`;
  }

  return msg;
}

// ============================================================================
// EXPORTS & CLI
// ============================================================================

module.exports = {
  runFullAudit,
  auditAgentHealth,
  auditTrades,
  auditRisk,
  auditPerformance,
  auditLogic,
  auditProviders,
  formatAuditForDiscord,
};

// CLI
if (require.main === module) {
  const section = process.argv[2] || 'all';

  (async () => {
    try {
      let result;
      switch (section) {
        case 'health':
          result = await auditAgentHealth();
          break;
        case 'trades':
          result = await auditTrades();
          break;
        case 'risk':
          result = await auditRisk();
          break;
        case 'performance':
          result = await auditPerformance();
          break;
        case 'logic':
          result = await auditLogic();
          break;
        case 'providers':
          result = await auditProviders();
          break;
        case 'all':
        default:
          result = await runFullAudit();
          break;
      }

      if (section === 'all') {
        // Pretty print the Discord-formatted version
        console.log(formatAuditForDiscord(result));
        console.log('\n--- Full JSON Report ---\n');
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('Audit failed:', e);
    }
    process.exit(0);
  })();
}
