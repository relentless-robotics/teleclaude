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
let VolRegimeTrader, QuantSwingScanner, ESMicrostructureTrader;
try { VolRegimeTrader = require('./agents/vol_regime_trader'); } catch (e) { console.warn('[Scheduler] Vol Regime Trader not available:', e.message); }
try { QuantSwingScanner = require('./agents/quant_swing'); } catch (e) { console.warn('[Scheduler] Quant Swing Scanner not available:', e.message); }
try { ESMicrostructureTrader = require('./agents/es_microstructure'); } catch (e) { console.warn('[Scheduler] ES Microstructure not available:', e.message); }

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
    this.agents = {
      preMarket: new PreMarketAgent(),
      swingScanner: new SwingScannerAgent(),
      afterHours: new AfterHoursAgent(),
      overnight: new OvernightAgent(),
      dayTrader: new DayTraderAgent(),
    };

    // Alpha Strategy Agents
    if (VolRegimeTrader) this.agents.volRegime = new VolRegimeTrader();
    if (QuantSwingScanner) this.agents.quantSwing = new QuantSwingScanner();
    if (ESMicrostructureTrader) this.agents.esMicro = new ESMicrostructureTrader();

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
      'Agents running automatically:\n' +
      '• 🌅 Pre-Market: 7:00-9:30 AM ET (every 15 min)\n' +
      '• 📊 Swing Scanner: 9:30 AM-4:00 PM ET (every 30 min) [LLM]\n' +
      '• ⚡ Day Trader: 9:30 AM-4:00 PM ET (every 10 min) [LLM+OPTIONS]\n' +
      '• 🤖 IASM Pipeline: 9:45 AM-3:45 PM ET (every 60s) [META-LEARNER->EXECUTOR]\n' +
      '• 👁️ Position Monitor: Market hours (every 60s) [LLM ALERTS]\n' +
      '• 📰 News Feed: Market hours (every 5 min)\n' +
      '• 🔎 Research Dispatcher: 7:30 AM, 12:00 PM, 5:00 PM ET\n' +
      '• 🔬 After Hours: 4:30 PM ET (once daily)\n' +
      '• 🌙 Overnight: 8:00 PM-7:00 AM ET (every hour)\n' +
      '• 🌊 Vol Regime Trader: 9:30 AM-4:00 PM ET (every 30 min) [ALPHA 2]\n' +
      '• 📊 Quant Swing Scanner: 9:30 AM-4:00 PM ET (hourly) [ALPHA 3]\n' +
      '• ⚡ ES Microstructure: 9:30 AM-4:00 PM ET (every 10 min) [ALPHA 1]\n\n' +
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

    // Start position monitor (every 60s during market hours)
    this.monitorLoop = setInterval(() => {
      const status = marketHours.getStatus();
      if (status.isMarketOpen) {
        this.positionMonitor.tick().catch(e => console.error('[Monitor]', e.message));
      }
    }, 60 * 1000);

    // Start alert monitoring (every 60s during market hours)
    this.alertLoop = setInterval(() => {
      const status = marketHours.getStatus();
      if (status.isMarketOpen) {
        alerts.checkAlerts().catch(e => console.error('[Alerts]', e.message));
      }
    }, 60 * 1000);

    // Core service agents loop (runs every 5 min, checks if memory/security should run)
    this.serviceLoop = setInterval(() => this._serviceAgentTick(), 5 * 60 * 1000);
    // Run initial service agent tick
    this._serviceAgentTick();

    // News feed runs on-demand (agents fetch before LLM calls), not on a separate loop.
    // Initial fetch to populate brain with headlines for first agent run.
    this.newsFeed.run().catch(e => console.error('[News] Initial fetch:', e.message));

    // Start IASM Intraday Pipeline (runs its own 60s loop during 9:45-3:45 ET)
    // This does NOT conflict with the dayTrader agent - the dayTrader is the veto/monitor,
    // while the pipeline orchestrates signal generation -> execution
    if (intradayPipeline) {
      try {
        await intradayPipeline.start();
        console.log('[Scheduler] IASM Intraday Pipeline started');
      } catch (e) {
        console.error('[Scheduler] Failed to start intraday pipeline:', e.message);
      }
    }

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

    // Pre-Market Agent (every 15 minutes)
    if (status.agents.preMarket.run && minute % 15 === 0) {
      await this.runAgent('preMarket');
    }

    // Swing Scanner (every 30 minutes during market hours)
    if (status.agents.swingScanner.run && minute % 30 === 0) {
      await this.runAgent('swingScanner');
    }

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

    // IASM Signal Refresh (every 10 minutes during market hours)
    // Runs BEFORE day trader so fresh signals are available
    if (status.isMarketOpen && minute % 10 === 0) {
      try {
        const iasmLoader = require('./iasm_loader');
        const iasmData = iasmLoader.loadAndWrite(brain);
        if (iasmData) {
          const f = iasmData._freshness;
          if (f.isStale) {
            console.log(`[Scheduler] IASM signals stale (${f.ageMinutes}m) - triggering refresh...`);
            iasmLoader.refreshSignals({ updateData: true });
            // Reload after refresh
            const refreshed = iasmLoader.loadAndWrite(brain);
            if (refreshed) {
              // Record fresh signals for independent performance tracking
              try {
                const iasmPerf = require('./iasm_performance');
                iasmPerf.recordSignalBatch(refreshed);
              } catch (pe) { console.warn('[Scheduler] IASM perf record:', pe.message); }
              // Post refreshed signals to dedicated IASM channel
              const topSignals = refreshed.signals.slice(0, 5).map(s =>
                `${s.direction === 'long' ? '🟢' : '🔴'} **${s.symbol}** ${s.direction.toUpperCase()} | Conf: ${(s.confidence * 100).toFixed(0)}% | Horizon: ${s.horizon}`
              ).join('\n');
              await discord.iasmSignals(
                `⚡ **IASM Signals Refreshed**\n` +
                `${refreshed.signals.length} signals | ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}\n` +
                topSignals
              );
            }
          } else {
            console.log(`[Scheduler] IASM signals loaded: ${iasmData.signals.length} signals (${f.ageMinutes}m old)`);
          }
        }
      } catch (e) {
        console.warn('[Scheduler] IASM refresh error:', e.message);
      }

      // Resolve expired IASM signals for performance tracking
      try {
        const iasmPerf = require('./iasm_performance');
        iasmPerf.resolveExpiredSignals();
      } catch (e) { /* ignore if no price data yet */ }
    }

    // Day Trader (every 10 minutes during market hours) - faster cycles for better entries/exits
    if (status.isMarketOpen && minute % 10 === 0) {
      await this.runAgent('dayTrader');
    }

    // Alpha 2: Vol Regime Trader (every 30 minutes during market hours)
    if (status.isMarketOpen && minute % 30 === 0 && this.agents.volRegime) {
      await this.runAgent('volRegime');
    }

    // Alpha 3: Quant Swing Scanner (every 60 minutes during market hours, offset by 15 min)
    if (status.isMarketOpen && minute === 15 && this.agents.quantSwing) {
      await this.runAgent('quantSwing');
    }

    // Alpha 1: ES Microstructure Monitor (every 10 minutes during futures hours)
    // ES futures trade nearly 24h, but we focus on RTH
    if (status.isMarketOpen && minute % 10 === 5 && this.agents.esMicro) {
      await this.runAgent('esMicro');
    }

    // After Hours (once at 4:30 PM - use range check since exact match is fragile)
    if (status.agents.afterHours.run) {
      const etTime = status.currentTimeET || '';
      const isAfterHoursWindow = etTime >= '16:30' && etTime <= '16:35';
      const alreadyRanToday = this._afterHoursRanDate === new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (isAfterHoursWindow && !alreadyRanToday) {
        this._afterHoursRanDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        await this.runAgent('afterHours');
      }
    }

    // Overnight (every hour on the hour during trading days only)
    if (status.agents.overnight.run && minute === 0) {
      await this.runAgent('overnight');
    }

    // Auto-Retrain Check (runs every hour at :00, checks staleness and performance)
    if (minute === 0) {
      try {
        const retrainResult = await autoRetrain.checkAndRetrain();
        if (retrainResult.triggered) {
          console.log('[Scheduler] Auto-retrain triggered:', retrainResult.reason);
        }
      } catch (e) {
        console.warn('[Scheduler] Auto-retrain check error:', e.message);
      }
    }

    // Research Dispatcher (3x daily: 7:30 AM, 12:00 PM, 5:00 PM ET)
    const researchToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (this._lastResearchDate !== researchToday) {
      this._researchRanTimes = new Set();
      this._lastResearchDate = researchToday;
    }
    const researchWindows = [
      { key: 'premarket', start: '07:30', end: '07:35' },
      { key: 'midday', start: '12:00', end: '12:05' },
      { key: 'evening', start: '17:00', end: '17:05' },
    ];
    for (const window of researchWindows) {
      if (etTime >= window.start && etTime <= window.end && !this._researchRanTimes.has(window.key)) {
        this._researchRanTimes.add(window.key);
        this._runResearch(window.key).catch(e => console.error('[Research]', e.message));
      }
    }
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

Agents: preMarket, swingScanner, afterHours, overnight
        `);
    }
  })();
}
