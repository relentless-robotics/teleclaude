/**
 * Trading Agents Configuration
 *
 * Central configuration for all trading agents and Discord channels.
 */

const path = require('path');

module.exports = {
  // Market Hours (Eastern Time)
  marketHours: {
    preMarketStart: '07:00',
    marketOpen: '09:30',
    marketClose: '16:00',
    afterHoursEnd: '20:00',
    timezone: 'America/New_York',
  },

  // Agent Schedules
  agents: {
    preMarket: {
      name: 'Pre-Market Agent',
      emoji: '🌅',
      enabled: true,
      schedule: {
        start: '07:00',
        end: '09:30',
        intervalMinutes: 15,
      },
      tasks: [
        'scan_premarket_movers',
        'check_overnight_news',
        'analyze_futures',
        'prepare_watchlist',
      ],
    },
    swingScanner: {
      name: 'Swing Scanner',
      emoji: '📊',
      enabled: true,
      schedule: {
        start: '09:30',
        end: '16:00',
        intervalMinutes: 30,
      },
      tasks: [
        'scan_watchlist',
        'check_entry_signals',
        'monitor_positions',
        'evaluate_exits',
      ],
    },
    afterHours: {
      name: 'After Hours Analyst',
      emoji: '🔬',
      enabled: true,
      schedule: {
        start: '16:00',
        end: '20:00',
        runOnce: true, // Only runs once at 16:30
        runAt: '16:30',
      },
      tasks: [
        'daily_performance_review',
        'deep_analysis',
        'earnings_review',
        'next_day_preparation',
      ],
    },
    overnight: {
      name: 'Overnight Watcher',
      emoji: '🌙',
      enabled: true,
      schedule: {
        start: '20:00',
        end: '07:00',
        intervalMinutes: 60,
      },
      tasks: [
        'monitor_futures',
        'scan_global_markets',
        'check_breaking_news',
      ],
    },
  },

  // Discord Webhooks (to be configured)
  discord: {
    webhooks: {
      systemStatus: process.env.DISCORD_WEBHOOK_SYSTEM || null,
      mainChat: process.env.DISCORD_WEBHOOK_MAIN || null,
      preMarket: process.env.DISCORD_WEBHOOK_PREMARKET || null,
      swingScanner: process.env.DISCORD_WEBHOOK_SWING || null,
      afterHours: process.env.DISCORD_WEBHOOK_AFTERHOURS || null,
      overnight: process.env.DISCORD_WEBHOOK_OVERNIGHT || null,
      tradeExecutions: process.env.DISCORD_WEBHOOK_TRADES || null,
      alerts: process.env.DISCORD_WEBHOOK_ALERTS || null,
      watchlist: process.env.DISCORD_WEBHOOK_WATCHLIST || null,
      pnl: process.env.DISCORD_WEBHOOK_PNL || null,
      research: process.env.DISCORD_WEBHOOK_RESEARCH || null,
      optionsFlow: process.env.DISCORD_WEBHOOK_OPTIONS || null,
      errors: process.env.DISCORD_WEBHOOK_ERRORS || null,
    },
    // Fallback to single channel if webhooks not configured
    useSingleChannel: true,
  },

  // Data Storage
  paths: {
    dataDir: path.join(__dirname, 'data'),
    logsDir: path.join(__dirname, 'logs'),
    watchlistFile: path.join(__dirname, 'data', 'watchlist.json'),
    positionsFile: path.join(__dirname, 'data', 'positions.json'),
    historyFile: path.join(__dirname, 'data', 'trade_history.json'),
    agentStateFile: path.join(__dirname, 'data', 'agent_state.json'),
  },

  // Trading Parameters
  trading: {
    maxPositionPct: 0.10,      // Max 10% per position
    defaultPositionPct: 0.05,  // Default 5% position
    minPositionPct: 0.02,      // Min 2% position
    maxOpenPositions: 10,       // Max concurrent positions
    minUpside: 0.15,           // Minimum 15% upside required
    maxAboveEntry: 0.05,       // Max 5% above entry to consider
  },

  // Alert Thresholds
  alerts: {
    bigMovePercent: 5,         // Alert on 5%+ moves
    volumeSpike: 3,            // 3x average volume
    nearEntry: 0.03,           // Within 3% of entry target
    nearTarget: 0.05,          // Within 5% of price target
  },
};
