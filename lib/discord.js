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

// Configuration paths
const BRIDGE_DIR = path.dirname(__dirname);
const OUTPUT_FILE = platform.getDiscordOutputFile();
const MCP_CONFIG = path.join(BRIDGE_DIR, 'mcp', 'discord-config.json');
const IMAGES_DIR = path.join(BRIDGE_DIR, 'images');
const MAX_MSG = 2000; // Discord's limit (vs Telegram's 4000)

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
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

**File Commands**
/pwd - Show current working directory
/cd <path> - Change working directory
/getfile <path> - Download a file

/help - Show this message`
    );
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
  }, 500);

  // Handle messages
  client.on('messageCreate', async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // DM-only mode: only respond to DMs
    if (!message.channel.isDMBased()) return;

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

    // Handle attachments (images) - batch multiple images together
    if (message.attachments.size > 0) {
      const imageAttachments = [];
      const otherAttachments = [];

      for (const [, attachment] of message.attachments) {
        const contentType = attachment.contentType || '';
        if (contentType.startsWith('image/')) {
          imageAttachments.push(attachment);
        } else {
          otherAttachments.push(attachment);
        }
      }

      // Process all images together
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

      // Notify about unsupported attachments
      if (otherAttachments.length > 0) {
        const names = otherAttachments.map(a => a.name).join(', ');
        await message.channel.send(`I received some attachments (${names}), but I currently only support images.`);
      }
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
  } catch (error) {
    logger.loggers.system.error('Failed to login to Discord', { error: error.message });
    console.error('Failed to login to Discord:', error.message);
    process.exit(1);
  }
}

module.exports = {
  startDiscordMode
};
