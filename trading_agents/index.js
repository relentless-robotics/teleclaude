/**
 * Trading Agents System
 *
 * Unified entry point for the trading agent infrastructure.
 *
 * Usage:
 *   const { startTradingSystem } = require('./trading_agents');
 *   await startTradingSystem(sendToDiscordFunction);
 */

const { scheduler } = require('./scheduler');
const discord = require('./discord_channels');
const marketHours = require('./market_hours');
const config = require('./config');

/**
 * Start the full trading system
 */
async function startTradingSystem(sendToDiscord) {
  console.log('🏦 Starting Trading Agent System...');

  // Initialize with Discord function
  await scheduler.init(sendToDiscord);

  // Start the scheduler
  await scheduler.start();

  return scheduler;
}

/**
 * Stop the trading system
 */
async function stopTradingSystem() {
  await scheduler.stop();
}

/**
 * Get system status
 */
function getSystemStatus() {
  return scheduler.getStatus();
}

/**
 * Force run a specific agent
 */
async function runAgent(agentName) {
  return scheduler.forceRun(agentName);
}

/**
 * Get market hours info
 */
function getMarketHours() {
  return marketHours.getStatus();
}

/**
 * Configure Discord webhooks
 */
function configureWebhooks(webhooks) {
  Object.assign(discord.webhooks, webhooks);
}

module.exports = {
  // Main functions
  startTradingSystem,
  stopTradingSystem,
  getSystemStatus,
  runAgent,
  getMarketHours,
  configureWebhooks,

  // Direct access
  scheduler,
  discord,
  marketHours,
  config,
};
