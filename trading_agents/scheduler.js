/**
 * Trading Agent Scheduler
 *
 * Central scheduler that manages all trading agents based on market hours.
 * Runs appropriate agents at the right times and coordinates their activities.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const marketHours = require('./market_hours');
const discord = require('./discord_channels');

// Import agents
const PreMarketAgent = require('./agents/pre_market');
const SwingScannerAgent = require('./agents/swing_scanner');
const AfterHoursAgent = require('./agents/after_hours');
const OvernightAgent = require('./agents/overnight');
const DayTraderAgent = require('./agents/day_trader');
const brain = require('./shared_brain');

class TradingScheduler {
  constructor() {
    this.agents = {
      preMarket: new PreMarketAgent(),
      swingScanner: new SwingScannerAgent(),
      afterHours: new AfterHoursAgent(),
      overnight: new OvernightAgent(),
      dayTrader: new DayTraderAgent(),
    };

    this.intervals = {};
    this.isRunning = false;
    this.stateFile = config.paths.agentStateFile;
    this.checkInterval = 60 * 1000; // Check every minute
    this.mainLoop = null;
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
      '🚀 **Trading Agent System Started**\n\n' +
      'Agents running automatically:\n' +
      '• 🌅 Pre-Market: 7:00-9:30 AM ET (every 15 min)\n' +
      '• 📊 Swing Scanner: 9:30 AM-4:00 PM ET (every 30 min)\n' +
      '• ⚡ Day Trader: 9:30 AM-4:00 PM ET (every 15 min) [OPTIONS]\n' +
      '• 🔬 After Hours: 4:30 PM ET (once daily)\n' +
      '• 🌙 Overnight: 8:00 PM-7:00 AM ET (every hour)\n\n' +
      `Current time: ${marketHours.getETHourMinute().time} ET\n` +
      `Market status: ${marketHours.getCurrentSession().session}`
    );

    // Start main loop
    this.mainLoop = setInterval(() => this.tick(), this.checkInterval);

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

    // Clear main loop
    if (this.mainLoop) {
      clearInterval(this.mainLoop);
      this.mainLoop = null;
    }

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
    const status = marketHours.getStatus();
    const now = new Date();
    const minute = now.getMinutes();

    // Pre-Market Agent (every 15 minutes)
    if (status.agents.preMarket.run && minute % 15 === 0) {
      await this.runAgent('preMarket');
    }

    // Swing Scanner (every 30 minutes)
    if (status.agents.swingScanner.run && minute % 30 === 0) {
      await this.runAgent('swingScanner');
    }

    // Day Trader (every 15 minutes during market hours)
    if (status.agents.swingScanner.run && minute % 15 === 0) {
      await this.runAgent('dayTrader');
    }

    // After Hours (once at 4:30 PM)
    if (status.agents.afterHours.run && status.currentTimeET === '16:30') {
      await this.runAgent('afterHours');
    }

    // Overnight (every hour on the hour)
    if (status.agents.overnight.run && minute === 0) {
      await this.runAgent('overnight');
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

    try {
      console.log(`[${new Date().toISOString()}] Running ${agent.name}...`);
      await agent.run();
      this.updateAgentState(agentName, 'success');
    } catch (error) {
      console.error(`Agent ${agentName} error:`, error);
      this.updateAgentState(agentName, 'error', error.message);
      await discord.error(`**Agent Error: ${agent.name}**\n${error.message}`);
    }
  }

  /**
   * Force run an agent (manual trigger)
   */
  async forceRun(agentName) {
    console.log(`Force running agent: ${agentName}`);
    await this.runAgent(agentName);
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

    return {
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
        if (agentName && scheduler.agents[agentName]) {
          await scheduler.forceRun(agentName);
        } else {
          console.log('Available agents:', Object.keys(scheduler.agents).join(', '));
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
