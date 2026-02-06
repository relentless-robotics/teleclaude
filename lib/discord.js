/**
 * Discord Bridge Module
 * Core Discord functionality mirroring index.js Telegram patterns
 *
 * Features:
 * - Discord.js client initialization with required intents
 * - Message event handling (messageCreate)
 * - DM-only mode with user ID whitelist
 * - Chunked message sending (2000 char limit)
 * - Image/attachment download handling
 * - Command handling (/help, /status, /restart, etc.)
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Cross-platform utilities
const platform = require('./platform');

// Import logging system
const logger = require('./logger');

// Import reminder system for self-reminders
let reminderSystem = null;
try {
  reminderSystem = require('../utils/reminder_system');
} catch (e) {
  console.log('Reminder system not available:', e.message);
}

// Configuration paths
const BRIDGE_DIR = path.dirname(__dirname);
const OUTPUT_FILE = platform.getDiscordOutputFile();
const MCP_CONFIG = path.join(BRIDGE_DIR, 'mcp', 'discord-config.json');
const IMAGES_DIR = path.join(BRIDGE_DIR, 'images');
const DOWNLOADS_DIR = path.join(BRIDGE_DIR, 'downloads');
const MAX_MSG = 2000; // Discord's limit (vs Telegram's 4000)

// Ensure directories exist
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function c(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

// State
let config = null;
let client = null;
let claude = null;
let currentChannel = null;
let lastMtime = 0;
let claudeStartTime = null;
let lastUserMessage = null;
let lastUserMessageTime = null;
let currentWorkingDir = BRIDGE_DIR; // Track working directory for /cd and /pwd

// Trading server channels (populated when bot joins a server)
let tradingChannels = {
  general: null,
  preMarket: null,
  swingScanner: null,
  afterHours: null,
  overnight: null,
  tradeExecution: null,
  alerts: null,
  pnl: null,
  systemStatus: null
};
let tradingGuild = null; // The server we're managing

// Trading system integration
let tradingSystem = null;
let tradingSystemRunning = false;

function startTradingScheduler() {
  if (tradingSystemRunning) {
    console.log('Trading scheduler already running');
    return;
  }

  try {
    const { startTradingSystem, getSystemStatus } = require('../trading_agents');

    // Create a send function that routes to trading channels
    const tradingSend = async (message) => {
      if (currentChannel) {
        await sendChunked(message);
      }
    };

    startTradingSystem(tradingSend).then((sys) => {
      tradingSystem = sys;
      tradingSystemRunning = true;
      console.log('Trading agent scheduler started');
      logger.loggers.system.info('Trading scheduler started');
    }).catch(err => {
      console.error('Failed to start trading scheduler:', err.message);
      logger.loggers.system.error('Trading scheduler failed to start', { error: err.message });
    });
  } catch (e) {
    console.error('Trading agents module not available:', e.message);
  }
}

async function stopTradingScheduler() {
  if (!tradingSystemRunning) return;
  try {
    const { stopTradingSystem } = require('../trading_agents');
    await stopTradingSystem();
    tradingSystemRunning = false;
    tradingSystem = null;
    console.log('Trading scheduler stopped');
  } catch (e) {
    console.error('Failed to stop trading scheduler:', e.message);
  }
}

// ============================================
// PROCESS MANAGEMENT
// ============================================

function killOrphanedClaude() {
  logger.logSystemCommand('killOrphanedClaude', { reason: 'cleanup' });
  const result = platform.killClaudeProcesses();
  if (result) {
    logger.loggers.system.info('killOrphanedClaude completed successfully');
  }
  return result;
}

function getProcessStatus() {
  return platform.getProcessStatus();
}

// ============================================
// IMAGE/ATTACHMENT HANDLING
// ============================================

async function downloadDiscordAttachment(attachment) {
  try {
    const url = attachment.url;
    const filename = attachment.name || 'attachment';

    // Determine file extension
    let ext = path.extname(filename) || '.jpg';

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const localFilename = `discord_${timestamp}${ext}`;
    const localPath = path.join(IMAGES_DIR, localFilename);

    logger.loggers.bridge.info('Downloading attachment from Discord', {
      url,
      filename,
      localPath,
    });

    // Download file
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(localPath);
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(localPath);
          https.get(response.headers.location, (redirectResponse) => {
            const newFile = fs.createWriteStream(localPath);
            redirectResponse.pipe(newFile);
            newFile.on('finish', () => {
              newFile.close();
              logger.loggers.bridge.info('Attachment downloaded successfully', { localPath });
              resolve(localPath);
            });
          }).on('error', (err) => {
            fs.unlink(localPath, () => {});
            logger.loggers.bridge.error('Failed to download attachment (redirect)', { error: err.message });
            reject(err);
          });
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          logger.loggers.bridge.info('Attachment downloaded successfully', { localPath });
          resolve(localPath);
        });
      }).on('error', (err) => {
        fs.unlink(localPath, () => {});
        logger.loggers.bridge.error('Failed to download attachment', { error: err.message });
        reject(err);
      });
    });
  } catch (error) {
    logger.loggers.bridge.error('Error in downloadDiscordAttachment', { error: error.message });
    throw error;
  }
}

// ============================================
// CLAUDE MANAGEMENT
// ============================================

function startClaude() {
  if (claude) {
    logger.loggers.system.warn('startClaude called but Claude already running');
    return;
  }

  // Ensure output file directory exists
  platform.ensureDir(path.dirname(OUTPUT_FILE));
  fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
  lastMtime = Date.now();
  claudeStartTime = Date.now();

  logger.logClaudeStart();
  logger.loggers.claude.info('Spawning Claude process for Discord', {
    cwd: currentWorkingDir,
    mcpConfig: MCP_CONFIG,
  });

  console.log('Starting Claude with Discord MCP...');

  // Get full path to Claude executable
  const claudePath = platform.getCommandPath('claude');

  claude = pty.spawn(claudePath, [
    '--dangerously-skip-permissions',
    '--mcp-config', MCP_CONFIG
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: currentWorkingDir, // Use tracked working directory (can be changed via /cd)
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      HOME: config.workdir,
      USERPROFILE: config.workdir,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
    },
    useConpty: platform.isWindows
  });

  logger.loggers.claude.info('Claude process spawned', { pid: claude.pid });

  claude.onData((data) => {
    const raw = data.toString();
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

    logger.logClaudeOutput(clean);

    if (clean) console.log('PTY:', clean.slice(0, 200));

    if (clean.toLowerCase().includes('error') || clean.toLowerCase().includes('exception')) {
      logger.loggers.claude.warn('Potential error detected in Claude output', { output: clean.slice(0, 500) });
    }
    if (clean.toLowerCase().includes('timeout')) {
      logger.loggers.claude.warn('Timeout detected in Claude output', { output: clean.slice(0, 500) });
    }
    if (clean.toLowerCase().includes('task') && (clean.toLowerCase().includes('spawn') || clean.toLowerCase().includes('agent'))) {
      logger.logAgentSpawned(clean.slice(0, 300));
    }
  });

  claude.onExit((e) => {
    const uptime = claudeStartTime ? Date.now() - claudeStartTime : 0;
    logger.logClaudeExit(e.exitCode, e.signal);
    logger.loggers.system.info('Claude uptime before exit', {
      uptimeMs: uptime,
      uptimeReadable: `${Math.round(uptime / 1000)}s`,
      lastUserMessage,
      timeSinceLastMessage: lastUserMessageTime ? Date.now() - lastUserMessageTime : null,
    });

    console.log('Claude exited:', e.exitCode);
    claude = null;
    claudeStartTime = null;
    if (currentChannel) {
      currentChannel.send('Claude session ended. Send a message to restart.').catch(() => {});
    }
  });

  // Handle bypass permissions prompt, then send init
  setTimeout(() => {
    if (!claude) {
      logger.loggers.claude.warn('Claude not ready for bypass prompt, skipping');
      console.log('Claude not ready, skipping');
      return;
    }
    logger.loggers.claude.info('Accepting bypass permissions prompt');
    console.log('Accepting bypass permissions...');
    // Send down arrow to select "Yes, I accept" then Enter
    claude.write('\x1b[B'); // Down arrow
    setTimeout(() => {
      if (claude) {
        claude.write('\r'); // Enter to confirm

        // Now wait for Claude to fully start, then send init
        setTimeout(() => {
          if (!claude) {
            logger.loggers.claude.warn('Claude not ready for init, skipping');
            console.log('Claude not ready for init, skipping');
            return;
          }
          logger.loggers.claude.info('Sending init message to Claude');
          console.log('Sending init...');
          claude.write('Confirm you\'re ready by using send_to_discord.');
          setTimeout(() => {
            if (claude) {
              logger.loggers.claude.debug('Sending Enter key');
              claude.write('\r');
            }
          }, 500);
        }, 3000);
      }
    }, 300);
  }, 2000);

  console.log('Claude started');
}

// ============================================
// MESSAGE HANDLING
// ============================================

async function sendChunked(text) {
  if (!currentChannel) {
    logger.loggers.bridge.warn('No channel to send to');
    return;
  }

  logger.loggers.bridge.info('Sending Discord message', {
    channelId: currentChannel.id,
    textLength: text.length,
  });

  console.log('sendChunked called, text length:', text.length);
  const chunks = [];

  while (text.length > 0) {
    if (text.length <= MAX_MSG) {
      chunks.push(text);
      break;
    }
    // Find a good break point (newline or space)
    let i = text.lastIndexOf('\n', MAX_MSG);
    if (i < 500) {
      i = text.lastIndexOf(' ', MAX_MSG);
    }
    if (i < 500) i = MAX_MSG;
    chunks.push(text.slice(0, i));
    text = text.slice(i).trim();
  }

  logger.loggers.bridge.debug('Splitting message into chunks', { chunkCount: chunks.length });
  console.log('Sending', chunks.length, 'chunks');

  for (let idx = 0; idx < chunks.length; idx++) {
    try {
      await currentChannel.send(chunks[idx]);
      logger.loggers.bridge.debug(`Chunk ${idx + 1}/${chunks.length} sent successfully`);
      console.log('Chunk', idx + 1, 'sent OK');
      // Rate limit protection
      if (idx < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (e) {
      logger.loggers.bridge.error('Failed to send Discord message', { error: e.message });
      console.error('Send error:', e.message);
    }
  }
}

function sendToClaude(userMessage) {
  if (!claude) {
    logger.loggers.claude.info('Claude not running, starting...');
    startClaude();
    setTimeout(() => sendToClaude(userMessage), 7000);
    return;
  }

  lastUserMessage = userMessage;
  lastUserMessageTime = Date.now();

  logger.logClaudeInput(userMessage);
  console.log('To Claude:', userMessage.slice(0, 60));
  claude.write(userMessage);
  setTimeout(() => {
    if (claude) {
      logger.loggers.claude.debug('Sending Enter key after user message');
      claude.write('\r');
    }
  }, 300);
}

// ============================================
// COMMAND HANDLING
// ============================================

async function handleCommand(message) {
  const text = message.content;

  if (text === '/help') {
    logger.logSystemCommand('/help');
    await message.channel.send(
`**Bridge Commands**

/status - Check if Claude is running + process info
/restart - Graceful restart (kill current, start new)
/kill - Nuclear kill ALL Claude processes
/reset - Full reset (kill all + restart fresh)
/ping - Check if bridge is responsive
/logs - View recent log entries

**Trading Commands**
/trading - Show trading system status
/trading start - Start the trading scheduler
/trading stop - Stop the trading scheduler
/trading run <agent> - Force run an agent
/trading channels - Setup/refresh trading channels

**File Commands**
/pwd - Show current working directory
/cd <path> - Change working directory
/getfile <path> - Download a file

**Reminder Commands**
/reminders - List all active reminders
/reminder add <msg> - Add reminder (triggers in 1 hour)
/reminder trading [mins] - Add trading check reminder
/reminder remove <id> - Remove a reminder
/reminder clear - Clear all reminders

/help - Show this message`
    );
    return true;
  }

  // Reminder commands
  if (text === '/reminders' || text === '/reminder list') {
    logger.logSystemCommand('/reminders');
    if (!reminderSystem) {
      await message.channel.send('Reminder system not available.');
      return true;
    }
    await message.channel.send(reminderSystem.formatReminders());
    return true;
  }

  if (text.startsWith('/reminder ')) {
    logger.logSystemCommand('/reminder');
    if (!reminderSystem) {
      await message.channel.send('Reminder system not available.');
      return true;
    }

    const parts = text.slice(10).split(' ');
    const action = parts[0];

    if (action === 'add') {
      const msg = parts.slice(1).join(' ') || 'Reminder';
      const reminder = reminderSystem.addReminder({
        message: msg,
        inMinutes: 60,
        tags: ['manual']
      });
      await message.channel.send(`Reminder #${reminder.id} added. Triggers at ${new Date(reminder.nextTrigger).toLocaleString()}`);
      return true;
    }

    if (action === 'trading') {
      const interval = parseInt(parts[1]) || 60;
      const reminder = reminderSystem.addTradingReminder(interval);
      await message.channel.send(`Trading reminder #${reminder.id} added. Checks every ${interval} minutes during market hours.`);
      return true;
    }

    if (action === 'remove') {
      const id = parseInt(parts[1]);
      if (!id) {
        await message.channel.send('Usage: /reminder remove <id>');
        return true;
      }
      const result = reminderSystem.removeReminder(id);
      await message.channel.send(result.success ? `Reminder #${id} removed.` : result.error);
      return true;
    }

    if (action === 'clear') {
      reminderSystem.clearAllReminders();
      await message.channel.send('All reminders cleared.');
      return true;
    }

    await message.channel.send('Unknown reminder command. Use /help to see options.');
    return true;
  }

  // Trading system commands
  if (text === '/trading' || text.startsWith('/trading ')) {
    logger.logSystemCommand('/trading');
    const parts = text.split(' ');
    const action = parts[1] || 'status';

    if (action === 'start') {
      if (tradingSystemRunning) {
        await message.channel.send('Trading scheduler is already running.');
      } else {
        await message.channel.send('Starting trading scheduler...');
        startTradingScheduler();
      }
      return true;
    }

    if (action === 'stop') {
      if (!tradingSystemRunning) {
        await message.channel.send('Trading scheduler is not running.');
      } else {
        await message.channel.send('Stopping trading scheduler...');
        await stopTradingScheduler();
        await message.channel.send('Trading scheduler stopped.');
      }
      return true;
    }

    if (action === 'run') {
      const agentName = parts[2];
      if (!agentName) {
        await message.channel.send('Usage: /trading run <preMarket|swingScanner|afterHours|overnight>');
        return true;
      }
      try {
        const { runAgent } = require('../trading_agents');
        await message.channel.send(`Force running ${agentName}...`);
        await runAgent(agentName);
        await message.channel.send(`${agentName} completed.`);
      } catch (e) {
        await message.channel.send(`Error: ${e.message}`);
      }
      return true;
    }

    if (action === 'channels') {
      if (!tradingGuild) {
        await message.channel.send('No trading server set. Add bot to a server first.');
        return true;
      }
      await message.channel.send('Setting up trading channels...');
      await setupTradingChannels(tradingGuild);
      await message.channel.send('Trading channels created/updated.');
      return true;
    }

    // Default: status
    try {
      const { getSystemStatus } = require('../trading_agents');
      const status = getSystemStatus();
      let msg = '**Trading System Status**\n\n';
      msg += `Scheduler: ${tradingSystemRunning ? 'Running' : 'Stopped'}\n`;
      msg += `Server: ${tradingGuild?.name || 'Not set'}\n`;
      msg += `Channels: ${Object.values(tradingChannels).filter(c => c).length}/9\n\n`;

      if (status && status.agents) {
        msg += '**Agents:**\n';
        for (const [name, agent] of Object.entries(status.agents)) {
          const active = agent.shouldRun ? 'Active' : 'Idle';
          const lastRun = agent.lastRun ? new Date(agent.lastRun).toLocaleTimeString() : 'Never';
          msg += `${agent.emoji} ${agent.name}: ${active} (last: ${lastRun})\n`;
        }
      }

      msg += '\n**Commands:** /trading start|stop|status|run <agent>|channels';
      await message.channel.send(msg);
    } catch (e) {
      await message.channel.send(`Trading system: ${tradingSystemRunning ? 'Running' : 'Stopped'}\nError getting details: ${e.message}`);
    }
    return true;
  }

  if (text === '/ping') {
    logger.logSystemCommand('/ping');
    await message.channel.send('pong');
    return true;
  }

  if (text === '/logs' || text.startsWith('/logs ')) {
    logger.logSystemCommand('/logs');
    const parts = text.split(' ');
    const category = parts[1] || 'bridge';
    const lines = parseInt(parts[2]) || 20;

    const logContent = logger.getRecentLogs(category, lines);
    const truncated = logContent.length > 1900 ? logContent.slice(-1900) : logContent;

    await message.channel.send(`**Recent ${category} logs:**\n\`\`\`\n${truncated}\n\`\`\``);
    return true;
  }

  if (text === '/status') {
    logger.logSystemCommand('/status');
    const status = getProcessStatus();
    const claudeStatus = claude ? 'Running' : 'Not running';
    const pid = claude?.pid || 'N/A';
    const uptime = claudeStartTime ? Math.round((Date.now() - claudeStartTime) / 1000) : 0;
    const lastMsgAgo = lastUserMessageTime ? Math.round((Date.now() - lastUserMessageTime) / 1000) : 'N/A';

    const logFiles = logger.getLogFilesInfo();
    const logInfo = logFiles.slice(0, 5).map(f => `  ${f.name} (${Math.round(f.size/1024)}KB)`).join('\n');

    await message.channel.send(
`**Status**
Claude: ${claudeStatus}
PID: ${pid}
Uptime: ${uptime}s
Last user message: ${lastMsgAgo}s ago
Related processes: ${status.count}

**Log Files:**
${logInfo || '  None'}

Use /logs [category] to view logs
Categories: bridge, claude, mcp, agent, system`
    );
    return true;
  }

  if (text === '/restart') {
    logger.logSystemCommand('/restart');
    await message.channel.send('Restarting Claude...');
    if (claude) {
      logger.loggers.system.info('Killing Claude for restart');
      claude.kill();
      claude = null;
    }
    setTimeout(startClaude, 1000);
    return true;
  }

  if (text === '/kill') {
    logger.logSystemCommand('/kill');
    await message.channel.send('Killing all Claude processes...');
    if (claude) {
      logger.loggers.system.info('Killing Claude process');
      claude.kill();
      claude = null;
    }
    killOrphanedClaude();
    await message.channel.send('All Claude processes killed. Use /restart to start fresh.');
    return true;
  }

  if (text === '/reset') {
    logger.logSystemCommand('/reset');
    await message.channel.send('Full reset in progress...');
    if (claude) {
      logger.loggers.system.info('Killing Claude for full reset');
      claude.kill();
      claude = null;
    }
    killOrphanedClaude();
    setTimeout(async () => {
      startClaude();
      await message.channel.send('Reset complete. Claude restarting...');
    }, 2000);
    return true;
  }

  // /pwd - Show current working directory
  if (text === '/pwd') {
    logger.logSystemCommand('/pwd');
    await message.channel.send(`Current directory: \`${currentWorkingDir}\``);
    return true;
  }

  // /cd <path> - Change working directory
  if (text.startsWith('/cd ')) {
    logger.logSystemCommand('/cd');
    const targetPath = text.slice(4).trim();

    // Resolve path (absolute or relative to current)
    const newPath = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(currentWorkingDir, targetPath);

    // Check if directory exists
    if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
      currentWorkingDir = newPath;
      logger.loggers.bridge.info('Changed working directory', { newPath });
      await message.channel.send(`Changed to: \`${currentWorkingDir}\``);

      // Notify Claude of the directory change
      if (claude) {
        sendToClaude(`[System: Working directory changed to ${currentWorkingDir}]`);
      }
    } else {
      await message.channel.send(`Directory not found: \`${newPath}\``);
    }
    return true;
  }

  // /getfile <path> - Send a file to the user
  if (text.startsWith('/getfile ')) {
    logger.logSystemCommand('/getfile');
    const filePath = text.slice(9).trim();

    // Resolve path (absolute or relative to current working dir)
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(currentWorkingDir, filePath);

    // Check if file exists
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const stats = fs.statSync(fullPath);
      const maxSize = 25 * 1024 * 1024; // 25MB Discord limit for bots

      if (stats.size > maxSize) {
        await message.channel.send(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Discord limit is 25MB.`);
      } else {
        logger.loggers.bridge.info('Sending file to user', { path: fullPath, size: stats.size });
        try {
          await message.channel.send({
            content: `File: ${path.basename(fullPath)} (${Math.round(stats.size / 1024)}KB)`,
            files: [fullPath]
          });
        } catch (err) {
          logger.loggers.bridge.error('Failed to send file', { error: err.message });
          await message.channel.send(`Failed to send file: ${err.message}`);
        }
      }
    } else {
      await message.channel.send(`File not found: \`${fullPath}\``);
    }
    return true;
  }

  return false;
}

// ============================================
// TRADING SERVER SETUP
// ============================================

const TRADING_CHANNEL_CONFIG = [
  { key: 'general', name: 'general', topic: 'General discussion with Claude' },
  { key: 'preMarket', name: 'pre-market', topic: 'Pre-market analysis (7-9:30 AM ET)' },
  { key: 'swingScanner', name: 'swing-scanner', topic: 'Market hours scanning (9:30 AM-4 PM ET)' },
  { key: 'afterHours', name: 'after-hours', topic: 'Daily analysis (4:30 PM ET)' },
  { key: 'overnight', name: 'overnight', topic: 'Overnight market watch (8 PM-7 AM ET)' },
  { key: 'tradeExecution', name: 'trade-execution', topic: 'Trade alerts and executions' },
  { key: 'alerts', name: 'alerts', topic: 'Important notifications' },
  { key: 'pnl', name: 'pnl', topic: 'P&L updates' },
  { key: 'systemStatus', name: 'system-status', topic: 'System health and status' }
];

async function setupTradingChannels(guild) {
  console.log(`Setting up trading channels in server: ${guild.name}`);
  logger.loggers.system.info('Setting up trading channels', { guildName: guild.name, guildId: guild.id });

  tradingGuild = guild;

  // Find or create a "Trading Agents" category
  let category = guild.channels.cache.find(c => c.name === 'Trading Agents' && c.type === 4);
  if (!category) {
    try {
      category = await guild.channels.create({
        name: 'Trading Agents',
        type: 4, // Category
        reason: 'Trading agent channels category'
      });
      console.log('Created Trading Agents category');
    } catch (err) {
      console.error('Failed to create category:', err.message);
      logger.loggers.system.error('Failed to create category', { error: err.message });
    }
  }

  // Create each channel
  for (const channelConfig of TRADING_CHANNEL_CONFIG) {
    // Check if channel already exists
    let channel = guild.channels.cache.find(c => c.name === channelConfig.name && c.type === 0);

    if (!channel) {
      try {
        channel = await guild.channels.create({
          name: channelConfig.name,
          type: 0, // Text channel
          topic: channelConfig.topic,
          parent: category?.id,
          reason: 'Trading agent channel'
        });
        console.log(`Created channel: #${channelConfig.name}`);
        logger.loggers.system.info('Created trading channel', { name: channelConfig.name });
      } catch (err) {
        console.error(`Failed to create #${channelConfig.name}:`, err.message);
        logger.loggers.system.error('Failed to create channel', { name: channelConfig.name, error: err.message });
        continue;
      }
    } else {
      console.log(`Channel #${channelConfig.name} already exists`);
    }

    tradingChannels[channelConfig.key] = channel;
  }

  // Save channel IDs to config file for trading agents
  const channelIds = {};
  for (const [key, channel] of Object.entries(tradingChannels)) {
    if (channel) channelIds[key] = channel.id;
  }

  const tradingConfigPath = path.join(BRIDGE_DIR, 'trading_agents', 'data', 'discord_channels.json');
  try {
    fs.mkdirSync(path.dirname(tradingConfigPath), { recursive: true });
    fs.writeFileSync(tradingConfigPath, JSON.stringify({ guildId: guild.id, channels: channelIds }, null, 2));
    console.log('Saved channel IDs to trading_agents config');
  } catch (err) {
    console.error('Failed to save channel config:', err.message);
  }

  // Send welcome message to general channel
  if (tradingChannels.general) {
    await tradingChannels.general.send(
      '**Trading Agent System Connected**\n\n' +
      'Channels have been set up for each agent:\n' +
      '• #pre-market - Pre-market analysis (7-9:30 AM ET)\n' +
      '• #swing-scanner - Market hours scanning (9:30 AM-4 PM ET)\n' +
      '• #after-hours - Daily analysis (4:30 PM ET)\n' +
      '• #overnight - Overnight market watch (8 PM-7 AM ET)\n' +
      '• #trade-execution - Trade alerts\n' +
      '• #alerts - Important notifications\n' +
      '• #pnl - P&L updates\n' +
      '• #system-status - System health\n\n' +
      'The trading scheduler will start posting to these channels automatically during market hours.'
    );
  }

  return tradingChannels;
}

// Send message to a specific trading channel
async function sendToTradingChannel(channelKey, message) {
  const channel = tradingChannels[channelKey];
  if (!channel) {
    console.log(`Trading channel ${channelKey} not set up, falling back to DM`);
    if (currentChannel) {
      await sendChunked(`[${channelKey}] ${message}`);
    }
    return false;
  }

  try {
    // Handle chunking for long messages
    const MAX_MSG = 2000;
    if (message.length <= MAX_MSG) {
      await channel.send(message);
    } else {
      const chunks = [];
      let text = message;
      while (text.length > 0) {
        if (text.length <= MAX_MSG) {
          chunks.push(text);
          break;
        }
        let i = text.lastIndexOf('\n', MAX_MSG);
        if (i < 500) i = text.lastIndexOf(' ', MAX_MSG);
        if (i < 500) i = MAX_MSG;
        chunks.push(text.slice(0, i));
        text = text.slice(i).trim();
      }
      for (const chunk of chunks) {
        await channel.send(chunk);
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return true;
  } catch (err) {
    console.error(`Failed to send to ${channelKey}:`, err.message);
    return false;
  }
}

// ============================================
// DISCORD MODE
// ============================================

async function startDiscordMode(cfg) {
  config = cfg;

  // Create Discord client with required intents
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel] // Required for DMs
  });

  logger.loggers.system.info('Discord bridge starting');
  logger.loggers.system.info('Allowed Discord users', { allowedUsers: config.discordAllowedUsers });
  console.log('Claude Discord Bridge starting...');
  console.log(`Allowed users: ${config.discordAllowedUsers.join(', ')}`);

  // Watch output file for Claude responses
  setInterval(() => {
    try {
      const stat = fs.statSync(OUTPUT_FILE);
      if (stat.mtimeMs > lastMtime && stat.size > 0) {
        lastMtime = stat.mtimeMs;
        const content = fs.readFileSync(OUTPUT_FILE, 'utf8').trim();

        if (content) {
          logger.logMcpToolResult('send_to_discord', true, content);
          logger.loggers.bridge.info('Response received from Claude via MCP', {
            contentLength: content.length,
            preview: content.slice(0, 200),
          });

          console.log('Got:', content.slice(0, 100));
          if (currentChannel) {
            console.log('Sending to Discord...');
            sendChunked(content);
          } else {
            logger.loggers.bridge.warn('No channel set, dropping message', { content: content.slice(0, 200) });
            console.log('No channel yet, dropping message');
          }
          fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
          lastMtime = Date.now();
        }
      }
    } catch (e) {}

    // Check for file send requests
    const fileRequestPath = OUTPUT_FILE.replace('.txt', '-file-request.json');
    try {
      if (fs.existsSync(fileRequestPath)) {
        const stat = fs.statSync(fileRequestPath);
        if (stat.size > 0) {
          try {
            const requestJson = fs.readFileSync(fileRequestPath, 'utf8');
            const request = JSON.parse(requestJson);

            if (request.filePath && currentChannel) {
              const filePath = request.filePath;
              logger.loggers.bridge.debug('File request detected', {
                filePath,
                hasMessage: !!request.message,
                fileExists: fs.existsSync(filePath)
              });

              if (fs.existsSync(filePath)) {
                const fileStats = fs.statSync(filePath);
                const maxSize = 25 * 1024 * 1024; // 25MB Discord limit

                if (fileStats.size <= maxSize) {
                  logger.loggers.bridge.info('Sending file via MCP request', {
                    path: filePath,
                    size: fileStats.size,
                    message: request.message?.slice(0, 100) || 'No message'
                  });

                  currentChannel.send({
                    content: request.message || `File: ${path.basename(filePath)}`,
                    files: [filePath]
                  }).then(() => {
                    logger.loggers.bridge.info('File sent successfully', { path: filePath });
                  }).catch(err => {
                    logger.loggers.bridge.error('Failed to send file to Discord', {
                      error: err.message,
                      code: err.code,
                      status: err.status,
                      path: filePath
                    });
                    currentChannel.send(`Error sending file: ${err.message}`).catch(() => {});
                  });
                } else {
                  logger.loggers.bridge.warn('File too large', {
                    path: filePath,
                    sizeMB: Math.round(fileStats.size / 1024 / 1024),
                    maxMB: 25
                  });
                  currentChannel.send(`File too large: ${Math.round(fileStats.size / 1024 / 1024)}MB (limit 25MB)`).catch(() => {});
                }
              } else {
                logger.loggers.bridge.warn('File not found', { path: filePath });
                currentChannel.send(`File not found: ${filePath}`).catch(() => {});
              }
            } else {
              logger.loggers.bridge.warn('Invalid file request', {
                hasFilePath: !!request.filePath,
                hasChannel: !!currentChannel
              });
            }

            // Clear the request file
            fs.writeFileSync(fileRequestPath, '', 'utf8');
          } catch (parseError) {
            logger.loggers.bridge.error('Failed to parse file request JSON', {
              error: parseError.message,
              file: fileRequestPath
            });
            fs.writeFileSync(fileRequestPath, '', 'utf8');
          }
        }
      }
    } catch (e) {
      logger.loggers.bridge.error('Error checking file requests', { error: e.message });
    }
  }, 500);

  // Handle messages
  client.on('messageCreate', async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Allow DMs and messages from our trading server
    const isDM = message.channel.isDMBased();
    const isFromTradingServer = tradingGuild && message.guild?.id === tradingGuild.id;

    if (!isDM && !isFromTradingServer) return;

    const userId = message.author.id;
    const text = message.content || '';

    logger.loggers.bridge.info('Discord message received', {
      userId,
      username: message.author.username,
      text: text.slice(0, 100),
    });
    console.log('MSG:', userId, text?.slice(0, 50));

    // Authorization check
    if (!config.discordAllowedUsers.includes(userId)) {
      logger.loggers.bridge.warn('UNAUTHORIZED ACCESS ATTEMPT', {
        userId,
        username: message.author.username,
        messageText: text.slice(0, 100),
        timestamp: new Date().toISOString(),
      });
      console.log(`[SECURITY] Unauthorized access attempt from user ${userId} (${message.author.username})`);
      // Silently ignore unauthorized users (as per plan for DM-only mode)
      return;
    }

    // Store channel for responses
    currentChannel = message.channel;

    // Handle commands
    if (text.startsWith('/')) {
      const handled = await handleCommand(message);
      if (handled) return;
    }

    // Forward non-command text messages to Claude
    if (text && !text.startsWith('/')) {
      sendToClaude(text);
    }

    // Handle ALL attachments (images, documents, code, etc.)
    if (message.attachments.size > 0) {
      const imageAttachments = [];
      const fileAttachments = [];

      for (const [, attachment] of message.attachments) {
        const contentType = attachment.contentType || '';
        if (contentType.startsWith('image/')) {
          imageAttachments.push(attachment);
        } else {
          fileAttachments.push(attachment);
        }
      }

      // Process images (save to images/)
      if (imageAttachments.length > 0) {
        console.log(`${imageAttachments.length} image attachment(s) received, downloading...`);

        const downloadPromises = imageAttachments.map(att =>
          downloadDiscordAttachment(att).catch(err => {
            logger.loggers.bridge.error('Failed to download attachment', { name: att.name, error: err.message });
            return null;
          })
        );

        const localPaths = await Promise.all(downloadPromises);
        const validPaths = localPaths.filter(p => p !== null);

        if (validPaths.length > 0) {
          let msgText;
          if (validPaths.length === 1) {
            msgText = `[Image received and saved to: ${validPaths[0]}]\n\nYou can view this image using the Read tool on that file path.`;
          } else {
            const pathsList = validPaths.map((p, i) => `${i + 1}. ${p}`).join('\n');
            msgText = `[${validPaths.length} images received and saved to:\n${pathsList}]\n\nYou can view these images using the Read tool on each file path.`;
          }
          sendToClaude(msgText);
        } else {
          await message.channel.send('Sorry, I failed to process those images. Please try again.');
        }
      }

      // Process other files (save to downloads/)
      if (fileAttachments.length > 0) {
        console.log(`${fileAttachments.length} file attachment(s) received, downloading...`);

        const downloadPromises = fileAttachments.map(async (att) => {
          try {
            const url = att.url;
            const filename = att.name || 'file';
            const timestamp = Date.now();
            const localFilename = `${timestamp}_${filename}`;
            const localPath = path.join(DOWNLOADS_DIR, localFilename);

            logger.loggers.bridge.info('Downloading file attachment', { url, filename, localPath });

            return new Promise((resolve, reject) => {
              const file = fs.createWriteStream(localPath);
              https.get(url, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                  file.close();
                  fs.unlinkSync(localPath);
                  https.get(response.headers.location, (redirectResponse) => {
                    const newFile = fs.createWriteStream(localPath);
                    redirectResponse.pipe(newFile);
                    newFile.on('finish', () => {
                      newFile.close();
                      resolve({ path: localPath, name: filename, size: att.size });
                    });
                  }).on('error', reject);
                  return;
                }
                response.pipe(file);
                file.on('finish', () => {
                  file.close();
                  resolve({ path: localPath, name: filename, size: att.size });
                });
              }).on('error', reject);
            });
          } catch (err) {
            logger.loggers.bridge.error('Failed to download file', { name: att.name, error: err.message });
            return null;
          }
        });

        const results = await Promise.all(downloadPromises);
        const validFiles = results.filter(r => r !== null);

        if (validFiles.length > 0) {
          let msgText;
          if (validFiles.length === 1) {
            const f = validFiles[0];
            msgText = `[File received: ${f.name} (${Math.round(f.size / 1024)}KB)]\nSaved to: ${f.path}\n\nYou can read this file using the Read tool.`;
          } else {
            const filesList = validFiles.map((f, i) => `${i + 1}. ${f.name} (${Math.round(f.size / 1024)}KB) → ${f.path}`).join('\n');
            msgText = `[${validFiles.length} files received:\n${filesList}]\n\nYou can read these files using the Read tool.`;
          }
          sendToClaude(msgText);
          await message.channel.send(`Received ${validFiles.length} file(s). Processing...`);
        } else {
          await message.channel.send('Sorry, I failed to download those files. Please try again.');
        }
      }
    }
  });

  // Handle bot joining a new server - auto-setup trading channels
  client.on('guildCreate', async (guild) => {
    console.log(`Bot joined server: ${guild.name} (${guild.id})`);
    logger.loggers.system.info('Bot joined new server', { name: guild.name, id: guild.id });

    // Setup trading channels automatically
    await setupTradingChannels(guild);

    // Start trading scheduler
    startTradingScheduler();

    // Notify via DM if we have a channel
    if (currentChannel) {
      await currentChannel.send(`I've joined the server "${guild.name}" and set up all the trading channels!`);
    }
  });

  // On ready, find trading server and setup channels
  client.on('ready', async () => {
    console.log(`Bot ready. In ${client.guilds.cache.size} server(s).`);

    // Find the trading server - check saved config first, then search guilds
    let guild = null;
    const tradingConfigPath = path.join(BRIDGE_DIR, 'trading_agents', 'data', 'discord_channels.json');

    // 1. Check saved guild ID from previous setup
    if (fs.existsSync(tradingConfigPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(tradingConfigPath, 'utf8'));
        if (saved.guildId) {
          guild = client.guilds.cache.get(saved.guildId);
          if (guild) console.log(`Found saved trading server: ${guild.name}`);
        }
      } catch (e) {}
    }

    // 2. Look for a server with "Trading Agents" category
    if (!guild) {
      guild = client.guilds.cache.find(g =>
        g.channels.cache.some(c => c.name === 'Trading Agents' && c.type === 4)
      );
      if (guild) console.log(`Found server with Trading Agents category: ${guild.name}`);
    }

    // 3. Look for a server with trading channels already
    if (!guild) {
      guild = client.guilds.cache.find(g =>
        g.channels.cache.some(c => c.name === 'pre-market' || c.name === 'swing-scanner')
      );
      if (guild) console.log(`Found server with trading channels: ${guild.name}`);
    }

    // 4. If only one non-DM server, use that
    if (!guild && client.guilds.cache.size >= 1) {
      guild = client.guilds.cache.first();
      console.log(`Using server: ${guild.name}`);
    }

    if (guild) {
      // Check if channels already exist or need setup
      const hasChannels = guild.channels.cache.some(c => c.name === 'pre-market');
      if (!hasChannels) {
        console.log('Setting up trading channels...');
        await setupTradingChannels(guild);
      } else {
        console.log('Trading channels already exist, loading...');
        tradingGuild = guild;
        for (const channelConfig of TRADING_CHANNEL_CONFIG) {
          const channel = guild.channels.cache.find(c => c.name === channelConfig.name);
          if (channel) tradingChannels[channelConfig.key] = channel;
        }

        // Save channel IDs to config for trading agents module
        const channelIds = {};
        for (const [key, channel] of Object.entries(tradingChannels)) {
          if (channel) channelIds[key] = channel.id;
        }
        const savedConfigPath = path.join(BRIDGE_DIR, 'trading_agents', 'data', 'discord_channels.json');
        try {
          fs.mkdirSync(path.dirname(savedConfigPath), { recursive: true });
          fs.writeFileSync(savedConfigPath, JSON.stringify({ guildId: guild.id, channels: channelIds }, null, 2));
          console.log('Saved channel IDs to trading_agents config');
        } catch (err) {
          console.error('Failed to save channel config:', err.message);
        }
      }

      // Auto-start trading scheduler
      startTradingScheduler();
    } else {
      console.log('No server found - add the bot to a Discord server to enable trading channels');
    }
  });

  client.on('error', (error) => {
    logger.logUnhandledError('discord_client', error);
    console.error('Discord client error:', error.message);
  });

  // Cross-platform shutdown handling
  platform.setupShutdownHandlers((signal) => {
    logger.loggers.system.info(`${signal} received, shutting down`);
    if (claude) claude.kill();
    if (client) client.destroy();
    process.exit(0);
  });

  process.on('uncaughtException', (e) => {
    logger.logUnhandledError('uncaughtException', e);
    console.error('Uncaught exception:', e);
  });

  process.on('unhandledRejection', (e) => {
    logger.logUnhandledError('unhandledRejection', e);
    console.error('Unhandled rejection:', e);
  });

  // Create output file and login
  platform.ensureDir(path.dirname(OUTPUT_FILE));
  fs.writeFileSync(OUTPUT_FILE, '', 'utf8');

  // Login to Discord
  try {
    await client.login(config.discordToken);
    console.log(`Discord bot logged in as ${client.user.tag}`);
    logger.loggers.system.info('Discord bot logged in', { tag: client.user.tag });

    // Start Claude after successful login
    startClaude();
    logger.loggers.system.info('Discord bridge ready and listening');
    console.log('Ready - waiting for Discord DMs');

    // Start reminder daemon for self-reminders
    if (reminderSystem) {
      console.log('Starting reminder daemon...');
      logger.loggers.system.info('Starting reminder daemon');

      // Create a send function that uses the current channel
      const sendReminder = async (message) => {
        if (currentChannel) {
          logger.loggers.bridge.info('Sending reminder', { message: message.slice(0, 100) });
          await sendChunked(message);
        } else {
          console.log('[Reminder] No channel set, queuing reminder');
        }
      };

      reminderSystem.startDaemon(sendReminder);
      console.log('Reminder daemon started');
    }
  } catch (error) {
    logger.loggers.system.error('Failed to login to Discord', { error: error.message });
    console.error('Failed to login to Discord:', error.message);
    process.exit(1);
  }
}

module.exports = {
  startDiscordMode,
  sendToTradingChannel,
  setupTradingChannels,
  startTradingScheduler,
  stopTradingScheduler,
  getTradingChannels: () => tradingChannels,
  getTradingGuild: () => tradingGuild,
  isTradingRunning: () => tradingSystemRunning
};
