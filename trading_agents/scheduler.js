/**
 * Trading Agent Scheduler
 *
 * Central scheduler that manages all trading agents based on market hours.
 * Runs appropriate agents at the right times and coordinates their activities.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const config = require('./config');
const marketHours = require('./market_hours');
const discord = require('./discord_channels');

// Import agents
const PreMarketAgent = require('./agents/pre_market');
const SwingScannerAgent = require('./agents/swing_scanner');
const AfterHoursAgent = require('./agents/after_hours');
const OvernightAgent = require('./agents/overnight');
const DayTraderAgent = require('./agents/day_trader');
const PositionMonitor = require('./agents/position_monitor');
const NewsFeed = require('./agents/news_feed');
const ResearchDispatcher = require('./agents/research_dispatcher');
const brain = require('./shared_brain');

// Alpha Strategy Agents
let VolRegimeTrader, QuantSwingScanner, ESMicrostructureTrader, PredictionMarketsAgent;
try { VolRegimeTrader = require('./agents/vol_regime_trader'); } catch (e) { console.warn('[Scheduler] Vol Regime Trader not available:', e.message); }
try { QuantSwingScanner = require('./agents/quant_swing'); } catch (e) { console.warn('[Scheduler] Quant Swing Scanner not available:', e.message); }
try { ESMicrostructureTrader = require('./agents/es_microstructure'); } catch (e) { console.warn('[Scheduler] ES Microstructure not available:', e.message); }
try { PredictionMarketsAgent = require('./agents/prediction_markets_agent'); } catch (e) { console.warn('[Scheduler] Prediction Markets not available:', e.message); }
let CNNMonitor, WheelStrategyAgent, PredictionMarketsScannerAgent;
try { CNNMonitor = require('./agents/cnn_monitor'); } catch (e) { console.warn('[Scheduler] CNN Monitor not available:', e.message); }
try { WheelStrategyAgent = require('./agents/wheel_strategy_agent'); } catch (e) { console.warn('[Scheduler] Wheel Strategy not available:', e.message); }
try { PredictionMarketsScannerAgent = require('./agents/prediction_markets_scanner_agent'); } catch (e) { console.warn('[Scheduler] Prediction Markets Scanner not available:', e.message); }

// IASM Intraday Pipeline (meta-learner -> executor -> Alpaca)
let intradayPipeline;
try {
  intradayPipeline = require('./intraday_pipeline');
} catch (e) {
  console.warn('[Scheduler] Intraday pipeline not available:', e.message);
}

// Alert & Monitoring System
const alerts = require('./alerts');
const autoRetrain = require('./auto_retrain');

// Core Service Agents (always-on)
let MemoryManager, SecuritySentinel;
try { MemoryManager = require('./agents/memory_manager'); } catch (e) { console.warn('[Scheduler] Memory Manager not available:', e.message); }
try { SecuritySentinel = require('./agents/security_sentinel'); } catch (e) { console.warn('[Scheduler] Security Sentinel not available:', e.message); }

class TradingScheduler {
  constructor() {
    // DISABLED AGENTS (2026-03-11): Only prediction markets + wheel strategy are active
    // Pre-market, swing scanner, after hours, day trader, overnight kept as objects but NOT scheduled
    this.agents = {
      // preMarket: new PreMarketAgent(),       // DISABLED
      // swingScanner: new SwingScannerAgent(),  // DISABLED
      // afterHours: new AfterHoursAgent(),      // DISABLED
      overnight: new OvernightAgent(),           // Keep for global macro context
      // dayTrader: new DayTraderAgent(),        // DISABLED
    };

    // Alpha Strategy Agents — only prediction markets + wheel active
    // if (VolRegimeTrader) this.agents.volRegime = new VolRegimeTrader();       // DISABLED
    // if (QuantSwingScanner) this.agents.quantSwing = new QuantSwingScanner();  // DISABLED
    // if (ESMicrostructureTrader) this.agents.esMicro = new ESMicrostructureTrader(); // DISABLED
    if (PredictionMarketsAgent) this.agents.predMarkets = new PredictionMarketsAgent();
    // if (CNNMonitor) this.agents.cnnMonitor = new CNNMonitor();                // DISABLED
    if (WheelStrategyAgent) this.agents.wheelStrategy = new WheelStrategyAgent();
    if (PredictionMarketsScannerAgent) this.agents.predMarketsScanner = new PredictionMarketsScannerAgent();

    // Core Service Agents (always-on, not market-dependent)
    if (MemoryManager) this.memoryManager = new MemoryManager();
    if (SecuritySentinel) this.securitySentinel = new SecuritySentinel();

    // Special fast-loop agents (not on main tick schedule)
    this.positionMonitor = new PositionMonitor();
    this.newsFeed = new NewsFeed();
    this.researchDispatcher = new ResearchDispatcher();

    this.intervals = {};
    this.isRunning = false;
    this._tickInProgress = false; // Re-entrance guard for tick()
    this._agentRunning = {};      // Per-agent re-entrance guard
    this.stateFile = config.paths.agentStateFile;
    this.checkInterval = 60 * 1000; // Check every minute
    this.mainLoop = null;
    this.monitorLoop = null;
    this.newsLoop = null;
    this.alertLoop = null;        // Alert monitoring loop
    this.serviceLoop = null;      // Core service agents loop (memory, security)
    this._researchRanTimes = new Set(); // Track which research windows ran today
    this._lastMemoryRunMinute = -1;
    this._lastSecurityRunHour = -1;
  }

  /**
   * Initialize the scheduler
   */
  async init(sendToDiscord = null) {
    console.log('🚀 Initializing Trading Agent Scheduler...');

    // Ensure data directories exist
    const dirs = [config.paths.dataDir, config.paths.logsDir];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Set Discord fallback
    if (sendToDiscord) {
      discord.setFallbackSend(sendToDiscord);
    }

    // Load webhooks from file if available
    discord.loadWebhooksFromFile();

    // Load previous state
    this.loadState();

    console.log('✅ Scheduler initialized');
    return this;
  }

  /**
   * Start the scheduler
   */
  async start() {
    if (this.isRunning) {
      console.log('Scheduler already running');
      return;
    }

    this.isRunning = true;
    console.log('▶️ Starting Trading Agent Scheduler...');

    // Send startup notification
    await discord.systemStatus(
      '🚀 **Trading Agent System v2 Started**\n\n' +
      'Active agents:\n' +
      '• 🎲 Prediction Markets: 8:00 AM & 12:00 PM ET (2x daily) [FOMC+VOL+ARB]\n' +
      '• 🔍 Pred Markets Scanner: Market hrs (30 min) / Off-hrs (2 hr) [SCALP SIGNALS]\n' +
      '• 🎡 Wheel Strategy: Market hours [CSP SCREENING + POSITION MGMT]\n' +
      '• 🌙 Overnight: 8:00 PM-7:00 AM ET (every hour) [GLOBAL MACRO]\n\n' +
      `Current time: ${marketHours.getETHourMinute().time} ET\n` +
      `Market status: ${marketHours.getCurrentSession().session}`
    );

    // Load V9 MacroStrategy predictions into shared brain (NEW unified loader)
    try {
      const v9Loader = require('./v9_loader');
      const predData = v9Loader.loadAndWrite(brain);
      if (predData) {
        const f = predData._freshness;
        console.log(`[Scheduler] V9 predictions loaded: ${predData.universe_size} symbols, age ${f.ageDays}d${f.isStale ? ' (STALE)' : ''}`);
        await discord.macrostrategyV9(
          `📈 **V9 MacroStrategy Predictions Loaded**\n` +
          `Model: ${predData.model_version} (${predData.execution_config})\n` +
          `Age: ${f.ageDays}d${f.isStale ? ' (STALE!)' : ''} | Universe: ${predData.universe_size} symbols\n` +
          `Top longs (Q1): ${predData.portfolio_action?.top_longs?.slice(0, 5).join(', ') || 'N/A'}\n` +
          `Next rebalance: ${predData.portfolio_action?.rebalance_due || 'N/A'}\n` +
          `Backtest: ${predData.model_metrics?.backtest_return || 'N/A'} return, ${predData.model_metrics?.backtest_sharpe || 'N/A'} Sharpe`
        );
      } else {
        console.warn('[Scheduler] V9 predictions not available (run: python generate_v9_predictions.py)');
      }
    } catch (e) {
      console.warn('[Scheduler] V9 loader error:', e.message);
    }

    // LEGACY: Load old V9 macro alpha scores (for backwards compatibility)
    // This can be removed once generate_v9_predictions.py is confirmed working
    try {
      const v9MacroLoader = require('./v9_macro_loader');
      const alphaData = v9MacroLoader.loadAndWrite(brain);
      if (alphaData) {
        const f = alphaData._freshness;
        console.log(`[Scheduler] V9 macro alpha (legacy) loaded: ${Object.keys(alphaData.scores).length} symbols, age ${f.ageDays}d`);
      }
    } catch (e) {
      // Silent - legacy loader not critical
    }

    // Load IASM intraday signals into shared brain
    try {
      const iasmLoader = require('./iasm_loader');
      const iasmData = iasmLoader.loadAndWrite(brain);
      if (iasmData) {
        const f = iasmData._freshness;
        console.log(`[Scheduler] IASM signals loaded: ${iasmData.signals.length} signals, age ${f.ageMinutes}m${f.isStale ? ' (STALE)' : ''}`);
        await discord.iasmSignals(
          `🤖 **IASM Intraday Model Loaded**\n` +
          `Signals: ${iasmData.signals.length} | Age: ${f.ageMinutes}m${f.isStale ? ' (STALE)' : ''}\n` +
          `Model: ${iasmData.model_metrics?.recent_ic ? 'IC=' + iasmData.model_metrics.recent_ic.toFixed(3) : 'metrics pending'}`
        );
      } else {
        console.warn('[Scheduler] IASM signals not available (run: python -m intraday_model.run predict)');
      }
    } catch (e) {
      console.warn('[Scheduler] IASM loader error:', e.message);
    }

    // Start main loop (agent scheduling every 60s)
    this.mainLoop = setInterval(() => this.tick(), this.checkInterval);

    // Position Monitor — DISABLED (2026-03-11, only using wheel + pred markets)
    // this.monitorLoop = setInterval(() => {
    //   const status = marketHours.getStatus();
    //   if (status.isMarketOpen) {
    //     this.positionMonitor.tick().catch(e => console.error('[Monitor]', e.message));
    //   }
    // }, 60 * 1000);

    // Alert monitoring — RE-ENABLED (2026-03-24)
    // Runs every 60s, checks QCC alerts + trading alerts, posts critical to Discord
    this.alertLoop = setInterval(async () => {
      try {
        // Check QCC unresolved critical alerts
        const resp = await fetch('http://localhost:3456/api/health').then(r => r.json()).catch(() => null);
        if (resp && resp.unresolved_alerts) {
          const criticals = resp.unresolved_alerts.filter(a => a.severity === 'critical' && Date.now() - new Date(a.created_at).getTime() < 10 * 60 * 1000);
          for (const alert of criticals.slice(0, 3)) {
            console.log(`[AlertTriage] CRITICAL: ${alert.message}`);
          }
        }
        // Also run trading alerts during market hours
        const status = marketHours.getStatus();
        if (status.isMarketOpen) {
          await alerts.checkAlerts().catch(e => console.error('[Alerts]', e.message));
        }
      } catch (e) {
        console.error('[AlertTriage]', e.message);
      }
    }, 60 * 1000);

    // Core service agents loop (runs every 5 min, checks if memory/security should run)
    this.serviceLoop = setInterval(() => this._serviceAgentTick(), 5 * 60 * 1000);
    // Run initial service agent tick
    this._serviceAgentTick();

    // News feed — DISABLED (2026-03-11)
    // this.newsFeed.run().catch(e => console.error('[News] Initial fetch:', e.message));

    // IASM Intraday Pipeline — DISABLED (2026-03-11)
    // if (intradayPipeline) {
    //   try {
    //     await intradayPipeline.start();
    //     console.log('[Scheduler] IASM Intraday Pipeline started');
    //   } catch (e) {
    //     console.error('[Scheduler] Failed to start intraday pipeline:', e.message);
    //   }
    // }

    // Run initial tick
    await this.tick();

    console.log('✅ Scheduler started');
  }

  /**
   * Stop the scheduler
   */
  async stop() {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop IASM Intraday Pipeline
    if (intradayPipeline) {
      try {
        await intradayPipeline.stop();
        console.log('[Scheduler] IASM Intraday Pipeline stopped');
      } catch (e) {
        console.warn('[Scheduler] Error stopping intraday pipeline:', e.message);
      }
    }

    // Clear main loop
    if (this.mainLoop) {
      clearInterval(this.mainLoop);
      this.mainLoop = null;
    }

    // Clear position monitor, alert monitoring, service agents, and news feed
    if (this.monitorLoop) { clearInterval(this.monitorLoop); this.monitorLoop = null; }
    if (this.alertLoop) { clearInterval(this.alertLoop); this.alertLoop = null; }
    if (this.serviceLoop) { clearInterval(this.serviceLoop); this.serviceLoop = null; }

    // Clear all agent intervals
    for (const [name, interval] of Object.entries(this.intervals)) {
      if (interval) {
        clearInterval(interval);
        this.intervals[name] = null;
      }
    }

    // Save state
    this.saveState();

    await discord.systemStatus('🛑 Trading Agent System Stopped');
    console.log('⏹️ Scheduler stopped');
  }

  /**
   * Main tick - check which agents should run
   */
  async tick() {
    // Re-entrance guard: skip if previous tick is still running (LLM calls can be slow)
    if (this._tickInProgress) {
      console.log(`[Scheduler] Tick skipped - previous tick still in progress`);
      return;
    }
    this._tickInProgress = true;

    try {
      await this._tickInner();
    } finally {
      this._tickInProgress = false;
    }
  }

  async _tickInner() {
    const status = marketHours.getStatus();
    const now = new Date();
    const minute = now.getMinutes();

    // WEEKEND/HOLIDAY GUARD: Skip all market-hours agents on non-trading days
    if (!status.isTradingDay) {
      // On non-trading days, only run overnight once at 8 PM for global/futures context
      if (status.agents.overnight.run && minute === 0) {
        const etHour = parseInt((status.currentTimeET || '00:00').split(':')[0]);
        // Only run at 8 PM on non-trading days (once, not every hour)
        if (etHour === 20 && !this._weekendOvernightRan) {
          this._weekendOvernightRan = true;
          await this.runAgent('overnight');
        }
        // Reset flag at midnight
        if (etHour === 0) this._weekendOvernightRan = false;
      }
      return; // Skip all other agents
    }

    // Pre-Market Agent — DISABLED (2026-03-11)
    // if (status.agents.preMarket.run && minute % 15 === 0) {
    //   await this.runAgent('preMarket');
    // }

    // Swing Scanner — DISABLED (2026-03-11)
    // if (status.agents.swingScanner.run && minute % 30 === 0) {
    //   await this.runAgent('swingScanner');
    // }

    // V9 MacroStrategy Prediction Refresh (daily at market open 9:30 AM, Sunday evenings)
    // V9 is a WEEKLY rebalance model, so refresh once daily is sufficient
    const etTime = status.currentTimeET || '';
    const dayOfWeek = now.getDay();
    if (etTime >= '09:30' && etTime <= '09:35' && minute % 5 === 0) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (this._lastV9RefreshDate !== today) {
        this._lastV9RefreshDate = today;
        try {
          const v9Loader = require('./v9_loader');
          const v9Data = v9Loader.loadV9Predictions({ allowStale: true, returnStale: true });
          if (v9Data) {
            const f = v9Data._freshness;
            if (f.isStale || f.ageDays > 1) {
              console.log(`[Scheduler] V9 predictions stale (${f.ageDays}d old) - triggering refresh...`);
              await discord.macrostrategyV9('📊 Refreshing V9 MacroStrategy predictions (weekly model)...');
              const success = v9Loader.refreshV9Predictions({ updateData: false });
              if (success) {
                const refreshed = v9Loader.loadAndWrite(brain);
                if (refreshed) {
                  await discord.macrostrategyV9(
                    `📈 **V9 Predictions Refreshed**\n` +
                    `Universe: ${refreshed.universe_size} symbols | Top ${refreshed.portfolio_action?.top_longs?.length || 0} longs`
                  );
                }
              }
            } else {
              console.log(`[Scheduler] V9 predictions current (${f.ageDays}d old)`);
            }
          }
        } catch (e) {
          console.warn('[Scheduler] V9 refresh error:', e.message);
        }
      }
    }

    // Sunday evening V9 refresh (8 PM) for pre-market prep
    if (dayOfWeek === 0 && etTime >= '20:00' && etTime <= '20:05' && minute % 5 === 0) {
      if (!this._sundayV9RefreshDone) {
        this._sundayV9RefreshDone = true;
        try {
          console.log('[Scheduler] Sunday evening V9 refresh...');
          const v9Loader = require('./v9_loader');
          v9Loader.refreshV9Predictions({ updateData: false });
          await discord.macrostrategyV9('📊 V9 predictions refreshed for upcoming week');
        } catch (e) {
          console.warn('[Scheduler] Sunday V9 refresh error:', e.message);
        }
      }
    } else if (dayOfWeek !== 0) {
      // Reset Sunday flag on other days
      this._sundayV9RefreshDone = false;
    }

    // IASM Signal Refresh — DISABLED (2026-03-11)

    // Day Trader — DISABLED (2026-03-11)
    // if (status.isMarketOpen && minute % 10 === 0) {
    //   await this.runAgent('dayTrader');
    // }

    // Alpha 2: Vol Regime Trader — DISABLED (2026-03-11)
    // if (status.isMarketOpen && minute % 30 === 0 && this.agents.volRegime) {
    //   await this.runAgent('volRegime');
    // }

    // Alpha 3: Quant Swing Scanner — DISABLED (2026-03-11)
    // if (status.isMarketOpen && minute === 15 && this.agents.quantSwing) {
    //   await this.runAgent('quantSwing');
    // }

    // Alpha 1: ES Microstructure — DISABLED (2026-03-11)
    // if (status.isMarketOpen && minute % 10 === 5 && this.agents.esMicro) {
    //   await this.runAgent('esMicro');
    // }

    // Prediction Markets Scanner (2x daily: 8:00 AM and 12:00 PM ET)
    if (this.agents.predMarkets) {
      const pmWindows = [
        { start: '08:00', end: '08:05' },
        { start: '12:00', end: '12:05' },
      ];
      const pmToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (this._lastPredMarketsDate !== pmToday) {
        this._predMarketsRanTimes = new Set();
        this._lastPredMarketsDate = pmToday;
      }
      for (const window of pmWindows) {
        const key = window.start;
        if (etTime >= window.start && etTime <= window.end && !this._predMarketsRanTimes?.has(key)) {
          if (!this._predMarketsRanTimes) this._predMarketsRanTimes = new Set();
          this._predMarketsRanTimes.add(key);
          await this.runAgent('predMarkets');
        }
      }
    }

    // Prediction Markets Scanner (every 30 min market hours, every 2 hours off-hours)
    if (this.agents.predMarketsScanner) {
      const isMarketHours = status.isMarketOpen;
      if (isMarketHours && minute % 30 === 0) {
        // Market hours: every 30 minutes
        await this.runAgent('predMarketsScanner');
      } else if (!isMarketHours && minute === 0) {
        // Off-hours: every 2 hours (on even hours) for political/global markets
        const etHour = parseInt((etTime || '00:00').split(':')[0]);
        if (etHour % 2 === 0) {
          await this.runAgent('predMarketsScanner');
        }
      }
    }

    // CNN Walkforward Monitor — DISABLED (training complete 94/94 folds, IC=0.1298)
    // Re-enable if new training run is started
    // if (this.agents.cnnMonitor && minute % 30 === 15) {
    //   await this.runAgent('cnnMonitor');
    // }

    // Wheel Strategy Agent (Sunday 6PM weekly plays, weekday 9AM position check)
    if (this.agents.wheelStrategy) {
      await this.runAgent('wheelStrategy');
    }

    // After Hours — DISABLED (2026-03-11)
    // if (status.agents.afterHours.run) {
    //   const etTime = status.currentTimeET || '';
    //   const isAfterHoursWindow = etTime >= '16:30' && etTime <= '16:35';
    //   const alreadyRanToday = this._afterHoursRanDate === new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    //   if (isAfterHoursWindow && !alreadyRanToday) {
    //     this._afterHoursRanDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    //     await this.runAgent('afterHours');
    //   }
    // }

    // Overnight (every hour on the hour during trading days only)
    if (status.agents.overnight.run && minute === 0) {
      await this.runAgent('overnight');
    }

    // Auto-Retrain — DISABLED (2026-03-11)
    // Research Dispatcher — DISABLED (2026-03-11)
  }

  /**
   * Run the research dispatcher (non-blocking)
   */
  async _runResearch(mode) {
    try {
      console.log(`[${new Date().toISOString()}] 🔎 Research Dispatcher (${mode}) starting...`);
      await this.researchDispatcher.run(mode === 'premarket' ? 'full' : 'full');
      console.log(`[${new Date().toISOString()}] 🔎 Research Dispatcher (${mode}) completed`);
    } catch (e) {
      console.error(`[Research Dispatcher] Error:`, e.message);
      await discord.error(`**Research Dispatcher Error (${mode}):** ${e.message}`);
    }
  }

  /**
   * Service agent tick — runs memory manager (every 30 min) and security sentinel (every hour).
   * These are always-on agents, independent of market hours.
   */
  async _serviceAgentTick() {
    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();
    const halfHourSlot = hour * 2 + Math.floor(minute / 30); // 0-47

    // Memory Manager: every 30 minutes
    if (this.memoryManager && halfHourSlot !== this._lastMemoryRunMinute) {
      this._lastMemoryRunMinute = halfHourSlot;
      try {
        console.log(`[${now.toISOString()}] 🧠 Memory Manager running...`);
        const report = await this.memoryManager.run();
        this.updateAgentState('memoryManager', 'success');
        // Send to Discord if health dropped
        if (report && report.healthScore < 80) {
          await this.memoryManager.reportToDiscord(report);
        }
        console.log(`[${new Date().toISOString()}] 🧠 Memory Manager completed (health: ${report?.healthScore || '?'}/100)`);
      } catch (e) {
        console.error('[Memory Manager] Error:', e.message);
        this.updateAgentState('memoryManager', 'error', e.message);
      }
    }

    // Security Sentinel: every hour (at the top of the hour)
    if (this.securitySentinel && hour !== this._lastSecurityRunHour) {
      this._lastSecurityRunHour = hour;
      try {
        console.log(`[${now.toISOString()}] 🛡️ Security Sentinel running...`);
        const report = await this.securitySentinel.run();
        this.updateAgentState('securitySentinel', 'success');
        // Send to Discord if security score dropped
        if (report && report.score < 80) {
          await this.securitySentinel.reportToDiscord(report);
        }
        console.log(`[${new Date().toISOString()}] 🛡️ Security Sentinel completed (score: ${report?.score || '?'}/100)`);
      } catch (e) {
        console.error('[Security Sentinel] Error:', e.message);
        this.updateAgentState('securitySentinel', 'error', e.message);
      }
    }
  }

  /**
   * Run a specific agent
   */
  async runAgent(agentName) {
    const agent = this.agents[agentName];
    if (!agent) {
      console.error(`Unknown agent: ${agentName}`);
      return;
    }

    // Per-agent re-entrance guard: skip if this specific agent is still running
    if (this._agentRunning[agentName]) {
      console.log(`[Scheduler] ${agent.name} still running from previous cycle - skipping`);
      return;
    }

    this._agentRunning[agentName] = true;
    try {
      console.log(`[${new Date().toISOString()}] Running ${agent.name}...`);
      await agent.run();
      this.updateAgentState(agentName, 'success');
    } catch (error) {
      console.error(`Agent ${agentName} error:`, error);
      this.updateAgentState(agentName, 'error', error.message);
      await discord.error(`**Agent Error: ${agent.name}**\n${error.message}`);
    } finally {
      this._agentRunning[agentName] = false;
    }
  }

  /**
   * Force run an agent (manual trigger)
   */
  async forceRun(agentName) {
    console.log(`Force running agent: ${agentName}`);
    if (agentName === 'research') {
      await this._runResearch('manual');
    } else if (agentName === 'memoryManager' && this.memoryManager) {
      const report = await this.memoryManager.run();
      this.updateAgentState('memoryManager', 'success');
      if (report) await this.memoryManager.reportToDiscord(report);
    } else if (agentName === 'securitySentinel' && this.securitySentinel) {
      const report = await this.securitySentinel.run();
      this.updateAgentState('securitySentinel', 'success');
      if (report) await this.securitySentinel.reportToDiscord(report);
    } else {
      await this.runAgent(agentName);
    }
  }

  /**
   * Update agent state
   */
  updateAgentState(agentName, status, error = null) {
    const state = this.loadState();
    state.agents[agentName] = {
      lastRun: new Date().toISOString(),
      status,
      error,
    };
    this.saveState(state);
  }

  /**
   * Load scheduler state
   */
  loadState() {
    if (fs.existsSync(this.stateFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      } catch (e) {
        console.error('Failed to load state:', e);
      }
    }
    return {
      startedAt: null,
      agents: {},
    };
  }

  /**
   * Save scheduler state
   */
  saveState(state = null) {
    const toSave = state || {
      startedAt: this.isRunning ? new Date().toISOString() : null,
      agents: Object.fromEntries(
        Object.entries(this.agents).map(([name, agent]) => [
          name,
          { lastRun: agent.lastRun?.toISOString() || null },
        ])
      ),
    };
    fs.writeFileSync(this.stateFile, JSON.stringify(toSave, null, 2));
  }

  /**
   * Get current status
   */
  getStatus() {
    const marketStatus = marketHours.getStatus();
    const state = this.loadState();

    const status = {
      isRunning: this.isRunning,
      marketStatus,
      agents: Object.fromEntries(
        Object.entries(this.agents).map(([name, agent]) => [
          name,
          {
            name: agent.name,
            emoji: agent.emoji,
            lastRun: state.agents[name]?.lastRun || null,
            shouldRun: marketStatus.agents[name]?.run || false,
            status: state.agents[name]?.status || 'unknown',
          },
        ])
      ),
    };

    // Add service agent statuses
    if (this.memoryManager) {
      status.memoryManager = this.memoryManager.getStatus();
    }
    if (this.securitySentinel) {
      status.securitySentinel = this.securitySentinel.getStatus();
    }

    // Add intraday pipeline status
    if (intradayPipeline) {
      try {
        status.intradayPipeline = intradayPipeline.getStatus();
      } catch (e) {
        status.intradayPipeline = { error: e.message };
      }
    }

    return status;
  }

  /**
   * Format status for Discord
   */
  async sendStatusUpdate() {
    const status = this.getStatus();

    let message = '**📊 TRADING SYSTEM STATUS**\n\n';
    message += `**Market:** ${status.marketStatus.session}\n`;
    message += `**Time:** ${status.marketStatus.currentTimeET} ET\n`;
    message += `**Trading Day:** ${status.marketStatus.isTradingDay ? 'Yes' : 'No'}\n\n`;

    message += '**Agents:**\n';
    for (const [name, agent] of Object.entries(status.agents)) {
      const statusEmoji = agent.status === 'success' ? '✅' : agent.status === 'error' ? '❌' : '⏸️';
      const activeEmoji = agent.shouldRun ? '🟢' : '⚪';
      message += `${agent.emoji} ${agent.name}: ${statusEmoji} ${activeEmoji}\n`;
      if (agent.lastRun) {
        message += `   Last run: ${new Date(agent.lastRun).toLocaleTimeString()}\n`;
      }
    }

    if (status.marketStatus.nextEvent) {
      message += `\n**Next:** ${status.marketStatus.nextEvent.event}`;
      if (status.marketStatus.nextEvent.hoursUntil) {
        message += ` in ${status.marketStatus.nextEvent.hoursUntil} hours`;
      }
    }

    await discord.systemStatus(message);
  }
}

// Create singleton
const scheduler = new TradingScheduler();

// Export
module.exports = {
  scheduler,
  TradingScheduler,
};

// CLI
if (require.main === module) {
  const command = process.argv[2] || 'status';

  (async () => {
    await scheduler.init();

    switch (command) {
      case 'start':
        await scheduler.start();
        console.log('Press Ctrl+C to stop');
        break;

      case 'status':
        const status = scheduler.getStatus();
        console.log(JSON.stringify(status, null, 2));
        break;

      case 'run':
        const agentName = process.argv[3];
        if (agentName === 'research') {
          await scheduler.forceRun('research');
        } else if (agentName && scheduler.agents[agentName]) {
          await scheduler.forceRun(agentName);
        } else {
          console.log('Available agents:', Object.keys(scheduler.agents).join(', ') + ', research');
        }
        process.exit(0);
        break;

      case 'market':
        console.log(JSON.stringify(marketHours.getStatus(), null, 2));
        break;

      default:
        console.log(`
Trading Agent Scheduler

Commands:
  start   - Start the scheduler
  status  - Show current status
  run <agent> - Force run an agent
  market  - Show market hours status

Agents: preMarket, swingScanner, afterHours, overnight, predMarkets
        `);
    }
  })();
}
