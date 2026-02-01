#!/usr/bin/env node
/**
 * Claude Code <-> Telegram Bridge
 * Open-source template for running Claude Code CLI via Telegram
 *
 * Features:
 * - First-run bootstrap setup via terminal
 * - MCP server for send_to_telegram tool
 * - Process management commands (/status, /restart, /kill, /reset)
 * - Chunked message sending for long responses
 * - CLI-only mode (no Telegram required)
 * - Cross-platform Windows/Unix compatibility
 * - Image receiving from Telegram
 * - Comprehensive logging system
 */

const TelegramBot = require('node-telegram-bot-api');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

// Cross-platform utilities
const platform = require('./lib/platform');

// Import logging system
const logger = require('./lib/logger');

// Configuration paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BRIDGE_DIR = __dirname;
const OUTPUT_FILE = platform.getOutputFile();
const MCP_CONFIG = path.join(__dirname, 'mcp', 'config.json');
const IMAGES_DIR = path.join(__dirname, 'images');
const MAX_MSG = 4000;

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

let config = null;
let claude = null;
let chatId = null;
let lastMtime = 0;
let claudeStartTime = null;
let lastUserMessage = null;
let lastUserMessageTime = null;
let bot = null;
let currentWorkingDir = __dirname; // Track working directory for /cd and /pwd

// Media group handling - batch multiple images sent together
const mediaGroups = new Map(); // media_group_id -> { images: [], caption: '', timer: null }

// ============================================
// BOOTSTRAP FUNCTIONS
// ============================================

async function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function validateTelegramToken(token) {
  try {
    const testBot = new TelegramBot(token);
    const me = await testBot.getMe();
    console.log(`\n  Bot validated: @${me.username} (${me.first_name})`);
    return true;
  } catch (e) {
    console.log(`\n  Error: Invalid token - ${e.message}`);
    return false;
  }
}

async function bootstrap() {
  console.log('\n========================================');
  console.log('   Claude Telegram Bridge - Setup');
  console.log('========================================\n');
  console.log('No configuration found. Let\'s set up your bridge.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    // Step 1: Telegram Bot Token
    console.log('Step 1: Telegram Bot Token');
    console.log('  Create a bot with @BotFather on Telegram and get the token.');
    console.log('  The token looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz\n');

    let token = '';
    let valid = false;
    while (!valid) {
      token = await prompt(rl, 'Enter your Telegram Bot Token: ');
      if (!token) {
        console.log('  Token is required.\n');
        continue;
      }
      console.log('  Validating token...');
      valid = await validateTelegramToken(token);
      if (!valid) {
        console.log('  Please try again.\n');
      }
    }

    // Step 2: Allowed User IDs
    console.log('\n\nStep 2: Allowed Telegram User IDs');
    console.log('  Only these users can interact with the bot.');
    console.log('  Find your ID by messaging @userinfobot on Telegram.');
    console.log('  Enter comma-separated IDs (e.g., 123456789, 987654321)\n');

    let userIds = [];
    while (userIds.length === 0) {
      const input = await prompt(rl, 'Enter allowed user IDs: ');
      userIds = input.split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id) && id > 0);

      if (userIds.length === 0) {
        console.log('  At least one valid user ID is required.\n');
      }
    }
    console.log(`  Allowed users: ${userIds.join(', ')}`);

    // Step 3: Working Directory
    console.log('\n\nStep 3: Working Directory');
    console.log('  The directory Claude will have access to.');
    console.log('  Press Enter to use your home directory.\n');

    const defaultWorkdir = platform.getHomeDir();
    const workdir = await prompt(rl, `Working directory [${defaultWorkdir}]: `) || defaultWorkdir;

    if (!fs.existsSync(workdir)) {
      console.log(`  Warning: Directory ${workdir} does not exist. Creating it...`);
      fs.mkdirSync(workdir, { recursive: true });
    }
    console.log(`  Working directory: ${workdir}`);

    // Step 4: Optional Credentials
    console.log('\n\nStep 4: Default Login Credentials (Optional)');
    console.log('  These will be stored in CLAUDE.md for browser automation.');
    console.log('  Press Enter to skip.\n');

    const email = await prompt(rl, 'Default email for logins (optional): ');
    const password = await prompt(rl, 'Default password for logins (optional): ');

    // Create config
    config = {
      mode: 'telegram',
      telegramToken: token,
      allowedUsers: userIds,
      workdir: workdir,
      credentials: {
        email: email || null,
        password: password || null
      }
    };

    // Save config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`\n  Configuration saved to ${CONFIG_FILE}`);

    // Update CLAUDE.md with credentials if provided
    if (email || password) {
      updateClaudeMdCredentials(email, password);
    }

    // Update MCP config with correct path
    updateMcpConfig();

    console.log('\n========================================');
    console.log('   Setup Complete!');
    console.log('========================================');
    console.log('\nStarting the bridge...\n');

    rl.close();
    return true;

  } catch (e) {
    console.error('Setup error:', e.message);
    rl.close();
    return false;
  }
}

function updateClaudeMdCredentials(email, password) {
  const claudeMdPath = path.join(BRIDGE_DIR, 'CLAUDE.md');
  let content = fs.readFileSync(claudeMdPath, 'utf8');

  if (email) {
    content = content.replace(
      /- \*\*Email:\*\* \[YOUR_EMAIL\]/g,
      `- **Email:** ${email}`
    );
  }
  if (password) {
    content = content.replace(
      /- \*\*Password:\*\* \[YOUR_PASSWORD\]/g,
      `- **Password:** ${password}`
    );
  }

  fs.writeFileSync(claudeMdPath, content);
}

function updateMcpConfig() {
  const mcpConfig = {
    mcpServers: {
      telegram: {
        command: 'node',
        args: [path.join(BRIDGE_DIR, 'mcp', 'telegram-bridge.js')]
      }
    }
  };
  fs.writeFileSync(MCP_CONFIG, JSON.stringify(mcpConfig, null, 2));
}

// ============================================
// LOAD CONFIGURATION
// ============================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading config:', e.message);
    return null;
  }
}

// Determine mode from config (backwards compatible)
function getMode(cfg) {
  if (!cfg) return null;
  // If mode is explicitly set, use it
  if (cfg.mode) return cfg.mode;
  // Backwards compatibility: if discordToken exists, assume discord mode
  if (cfg.discordToken) return 'discord';
  // Backwards compatibility: if telegramToken exists, assume telegram mode
  if (cfg.telegramToken) return 'telegram';
  // Otherwise, assume CLI mode
  return 'cli';
}

// Check if running directly without config (show setup message)
function showSetupMessage() {
  console.log('');
  console.log(c('cyan', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('cyan', '  ║') + c('bold', '       Claude Code Bridge - Welcome!                          ') + c('cyan', '║'));
  console.log(c('cyan', '  ╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(c('dim', '  No configuration found. Choose how you want to use Claude:'));
  console.log('');
  console.log(c('green', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(`  ${c('bold', '[1]')} ${c('green', 'CLI Mode')} ${c('yellow', '(Recommended - Quick Start)')}`);
  console.log(c('dim', '      Chat with Claude directly in this terminal.'));
  console.log(c('dim', '      No setup required - start chatting immediately!'));
  console.log('');
  console.log(`  ${c('bold', '[2]')} ${c('cyan', 'Telegram Mode')} ${c('dim', '(Full Setup)')}`);
  console.log(c('dim', '      Control Claude from your phone via Telegram.'));
  console.log(c('dim', '      Requires creating a Telegram bot first.'));
  console.log('');
  console.log(`  ${c('bold', '[3]')} ${c('magenta', 'Discord Mode')} ${c('dim', '(Full Setup)')}`);
  console.log(c('dim', '      Control Claude via Discord DMs.'));
  console.log(c('dim', '      Requires creating a Discord bot first.'));
  console.log('');
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(c('dim', '  You can add Telegram later with: npm run setup-telegram'));
  console.log(c('dim', '  You can add Discord later with: npm run setup-discord'));
  console.log('');
}

// ============================================
// PROCESS MANAGEMENT (Cross-platform)
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
// IMAGE HANDLING
// ============================================

// Download image from Telegram and save locally
async function downloadTelegramFile(fileId, originalFilename) {
  try {
    // Get file info from Telegram
    const fileInfo = await bot.getFile(fileId);
    const filePath = fileInfo.file_path;

    // Determine file extension
    let ext = path.extname(filePath) || path.extname(originalFilename || '') || '.jpg';

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const localFilename = `image_${timestamp}${ext}`;
    const localPath = path.join(IMAGES_DIR, localFilename);

    // Download URL
    const downloadUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${filePath}`;

    logger.loggers.bridge.info('Downloading image from Telegram', {
      fileId,
      filePath,
      localPath,
    });

    // Download file
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(localPath);
      https.get(downloadUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          logger.loggers.bridge.info('Image downloaded successfully', { localPath });
          resolve(localPath);
        });
      }).on('error', (err) => {
        fs.unlink(localPath, () => {}); // Delete partial file
        logger.loggers.bridge.error('Failed to download image', { error: err.message });
        reject(err);
      });
    });
  } catch (error) {
    logger.loggers.bridge.error('Error in downloadTelegramFile', { error: error.message });
    throw error;
  }
}

// Process a media group (multiple images sent together)
async function processMediaGroup(groupId) {
  const group = mediaGroups.get(groupId);
  if (!group || group.images.length === 0) {
    mediaGroups.delete(groupId);
    return;
  }

  logger.loggers.bridge.info('Processing media group', {
    groupId,
    imageCount: group.images.length,
    caption: group.caption,
  });

  // Download all images in parallel
  const downloadPromises = group.images.map((photo, index) => {
    const filename = `photo_${groupId}_${index + 1}.jpg`;
    return downloadTelegramFile(photo.file_id, filename)
      .catch(err => {
        logger.loggers.bridge.error('Failed to download group image', { index, error: err.message });
        return null;
      });
  });

  const localPaths = await Promise.all(downloadPromises);
  const validPaths = localPaths.filter(p => p !== null);

  if (validPaths.length > 0) {
    const pathsList = validPaths.map((p, i) => `${i + 1}. ${p}`).join('\n');
    const message = `[${validPaths.length} images received and saved to:\n${pathsList}]\n\nYou can view these images using the Read tool on each file path.${group.caption ? `\n\nCaption from user: ${group.caption}` : ''}`;
    sendToClaude(message);
  } else {
    bot.sendMessage(chatId, 'Sorry, I failed to process those images. Please try again.');
  }

  mediaGroups.delete(groupId);
}

// ============================================
// CLAUDE MANAGEMENT (Telegram Mode)
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
  logger.loggers.claude.info('Spawning Claude process', {
    cwd: currentWorkingDir,
    mcpConfig: MCP_CONFIG,
  });

  console.log('Starting Claude with MCP...');

  // Get full path to Claude executable (important for Windows node-pty)
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
      USERPROFILE: config.workdir, // Windows equivalent
      // Playwright browser settings (optional - use system browser)
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
    },
    useConpty: platform.isWindows // Use ConPTY on Windows
  });

  logger.loggers.claude.info('Claude process spawned', { pid: claude.pid });

  claude.onData((data) => {
    // Log PTY output for debugging
    const raw = data.toString();
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

    // Log to file
    logger.logClaudeOutput(clean);

    // Also console log for real-time monitoring
    if (clean) console.log('PTY:', clean.slice(0, 200));

    // Detect potential issues in output
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
    if (chatId) bot.sendMessage(chatId, 'Claude session ended. Send a message to restart.');
  });

  // Init prompt
  setTimeout(() => {
    if (!claude) {
      logger.loggers.claude.warn('Claude not ready for init, skipping');
      console.log('Claude not ready for init, skipping');
      return;
    }
    logger.loggers.claude.info('Sending init message to Claude');
    console.log('Sending init...');
    claude.write('Confirm you\'re ready by using send_to_telegram.');
    setTimeout(() => {
      if (claude) {
        logger.loggers.claude.debug('Sending Enter key');
        claude.write('\r');
      }
    }, 500);
  }, 5000);

  console.log('Claude started');
}

// ============================================
// MESSAGE HANDLING (Telegram Mode)
// ============================================

function sendChunked(text) {
  logger.logTelegramSend(chatId, text);
  console.log('sendChunked called, text length:', text.length);
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= MAX_MSG) { chunks.push(text); break; }
    let i = text.lastIndexOf('\n', MAX_MSG);
    if (i < 500) i = MAX_MSG;
    chunks.push(text.slice(0, i));
    text = text.slice(i).trim();
  }

  logger.loggers.bridge.debug('Splitting message into chunks', { chunkCount: chunks.length });
  console.log('Sending', chunks.length, 'chunks to chatId:', chatId);
  chunks.forEach((chunk, idx) => {
    setTimeout(() => {
      console.log('Sending chunk', idx + 1);
      bot.sendMessage(chatId, chunk)
        .then(() => {
          logger.loggers.bridge.debug(`Chunk ${idx + 1}/${chunks.length} sent successfully`);
          console.log('Chunk', idx + 1, 'sent OK');
        })
        .catch(e => {
          logger.logTelegramSendError(chatId, e);
          console.error('Send error:', e.message);
        });
    }, idx * 300);
  });
}

function sendToClaude(userMessage) {
  if (!claude) {
    logger.loggers.claude.info('Claude not running, starting...');
    startClaude();
    setTimeout(() => sendToClaude(userMessage), 7000);
    return;
  }

  // Track last message for debugging
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
// TELEGRAM MODE
// ============================================

async function startTelegramMode() {
  // Ensure MCP config path is correct
  updateMcpConfig();

  // Initialize bot
  bot = new TelegramBot(config.telegramToken, { polling: true });

  logger.loggers.system.info('Bridge started (with comprehensive logging)');
  logger.loggers.system.info('Allowed Telegram IDs', { allowedUsers: config.allowedUsers });
  console.log('Claude Telegram Bridge started');
  console.log(`Allowed users: ${config.allowedUsers.join(', ')}`);

  // Watch output file for Claude responses
  setInterval(() => {
    try {
      const stat = fs.statSync(OUTPUT_FILE);
      if (stat.mtimeMs > lastMtime && stat.size > 0) {
        lastMtime = stat.mtimeMs;
        const content = fs.readFileSync(OUTPUT_FILE, 'utf8').trim();

        if (content) {
          logger.logMcpToolResult('send_to_telegram', true, content);
          logger.loggers.bridge.info('Response received from Claude via MCP', {
            contentLength: content.length,
            preview: content.slice(0, 200),
          });

          console.log('Got:', content.slice(0, 100));
          console.log('chatId:', chatId);
          if (chatId) {
            console.log('Sending to Telegram...');
            sendChunked(content);
          } else {
            logger.loggers.bridge.warn('No chatId set, dropping message', { content: content.slice(0, 200) });
            console.log('No chatId yet, dropping message');
          }
          fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
          lastMtime = Date.now();
        }
      }
    } catch (e) {}
  }, 500);

  // Handle messages
  bot.on('message', (msg) => {
    const userId = msg.from.id;
    const msgChatId = msg.chat.id;
    const text = msg.text || '';

    logger.logUserMessage(userId, msgChatId, text);
    console.log('MSG:', userId, text?.slice(0, 50));

    if (!config.allowedUsers.includes(userId)) {
      // Log detailed unauthorized access attempt
      logger.loggers.bridge.warn('UNAUTHORIZED ACCESS ATTEMPT', {
        userId,
        username: msg.from.username || 'unknown',
        firstName: msg.from.first_name || 'unknown',
        lastName: msg.from.last_name || 'unknown',
        chatId: msgChatId,
        messageText: text.slice(0, 100),
        timestamp: new Date().toISOString(),
      });
      console.log(`[SECURITY] Unauthorized access attempt from user ${userId} (${msg.from.username || 'no username'})`);

      // Send polite rejection message
      bot.sendMessage(msgChatId,
        'Sorry, this bot is private and only accessible to authorized users. ' +
        'If you believe this is an error, please contact the bot administrator.'
      ).catch(e => {
        logger.loggers.bridge.error('Failed to send rejection message', { error: e.message });
      });
      return;
    }

    chatId = msgChatId;

    // Command handlers
    if (text === '/help') {
      logger.logSystemCommand('/help');
      bot.sendMessage(chatId,
`*Bridge Commands*

/status - Check if Claude is running + process info
/restart - Graceful restart (kill current, start new)
/kill - Nuclear kill ALL Claude processes
/reset - Full reset (kill all + restart fresh)
/ping - Check if bridge is responsive
/logs - Show recent log entries

*File Commands*
/pwd - Show current working directory
/cd <path> - Change working directory
/getfile <path> - Download a file

/help - Show this message`, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/ping') {
      logger.logSystemCommand('/ping');
      bot.sendMessage(chatId, 'pong');
      return;
    }

    // /logs - Show recent logs
    if (text === '/logs' || text.startsWith('/logs ')) {
      logger.logSystemCommand('/logs');
      const parts = text.split(' ');
      const category = parts[1] || 'bridge';
      const lines = parseInt(parts[2]) || 20;

      const logContent = logger.getRecentLogs(category, lines);
      const truncated = logContent.length > 3500 ? logContent.slice(-3500) : logContent;

      bot.sendMessage(chatId, `*Recent ${category} logs:*\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' })
        .catch(() => {
          // If markdown fails, send without formatting
          bot.sendMessage(chatId, `Recent ${category} logs:\n${truncated}`);
        });
      return;
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

      bot.sendMessage(chatId,
`*Status*
Claude: ${claudeStatus}
PID: ${pid}
Uptime: ${uptime}s
Last user message: ${lastMsgAgo}s ago
Related processes: ${status.count}

*Log Files:*
${logInfo || '  None'}

Use /logs [category] to view logs
Categories: bridge, claude, mcp, agent, system`, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/restart') {
      logger.logSystemCommand('/restart');
      bot.sendMessage(chatId, 'Restarting Claude...');
      if (claude) {
        logger.loggers.system.info('Killing Claude for restart');
        claude.kill();
        claude = null;
      }
      setTimeout(startClaude, 1000);
      return;
    }

    if (text === '/kill') {
      logger.logSystemCommand('/kill');
      bot.sendMessage(chatId, 'Killing all Claude processes...');
      if (claude) {
        logger.loggers.system.info('Killing Claude process');
        claude.kill();
        claude = null;
      }
      killOrphanedClaude();
      bot.sendMessage(chatId, 'All Claude processes killed. Use /restart to start fresh.');
      return;
    }

    if (text === '/reset') {
      logger.logSystemCommand('/reset');
      bot.sendMessage(chatId, 'Full reset in progress...');
      if (claude) {
        logger.loggers.system.info('Killing Claude for full reset');
        claude.kill();
        claude = null;
      }
      killOrphanedClaude();
      setTimeout(() => {
        startClaude();
        bot.sendMessage(chatId, 'Reset complete. Claude restarting...');
      }, 2000);
      return;
    }

    // /pwd - Show current working directory
    if (text === '/pwd') {
      logger.logSystemCommand('/pwd');
      bot.sendMessage(chatId, `Current directory: \`${currentWorkingDir}\``, { parse_mode: 'Markdown' });
      return;
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
        bot.sendMessage(chatId, `Changed to: \`${currentWorkingDir}\``, { parse_mode: 'Markdown' });

        // Notify Claude of the directory change
        if (claude) {
          sendToClaude(`[System: Working directory changed to ${currentWorkingDir}]`);
        }
      } else {
        bot.sendMessage(chatId, `Directory not found: \`${newPath}\``, { parse_mode: 'Markdown' });
      }
      return;
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
        const maxSize = 50 * 1024 * 1024; // 50MB Telegram limit

        if (stats.size > maxSize) {
          bot.sendMessage(chatId, `File too large (${Math.round(stats.size / 1024 / 1024)}MB). Telegram limit is 50MB.`);
        } else {
          logger.loggers.bridge.info('Sending file to user', { path: fullPath, size: stats.size });
          bot.sendDocument(chatId, fullPath, {
            caption: path.basename(fullPath)
          }).then(() => {
            bot.sendMessage(chatId, `Sent: ${path.basename(fullPath)} (${Math.round(stats.size / 1024)}KB)`);
          }).catch((err) => {
            logger.loggers.bridge.error('Failed to send file', { error: err.message });
            bot.sendMessage(chatId, `Failed to send file: ${err.message}`);
          });
        }
      } else {
        bot.sendMessage(chatId, `File not found: \`${fullPath}\``, { parse_mode: 'Markdown' });
      }
      return;
    }

    // Forward non-command text messages to Claude
    if (text && !text.startsWith('/')) {
      sendToClaude(text);
    }

    // Handle photos
    if (msg.photo && msg.photo.length > 0) {
      // Telegram sends photos in multiple sizes; get the largest one
      const photo = msg.photo[msg.photo.length - 1];
      const caption = msg.caption || '';
      const mediaGroupId = msg.media_group_id;

      logger.loggers.bridge.info('Photo received', {
        fileId: photo.file_id,
        width: photo.width,
        height: photo.height,
        caption,
        mediaGroupId: mediaGroupId || 'single',
      });

      // If part of a media group, batch with other images
      if (mediaGroupId) {
        if (!mediaGroups.has(mediaGroupId)) {
          mediaGroups.set(mediaGroupId, { images: [], caption: '', timer: null });
        }
        const group = mediaGroups.get(mediaGroupId);
        group.images.push(photo);
        if (caption) group.caption = caption; // Use last caption

        // Clear existing timer and set new one (wait for more images)
        if (group.timer) clearTimeout(group.timer);
        group.timer = setTimeout(() => processMediaGroup(mediaGroupId), 1000);

        console.log(`Photo added to media group ${mediaGroupId} (${group.images.length} images so far)`);
        return;
      }

      // Single photo - process immediately
      console.log('Photo received, downloading...');

      downloadTelegramFile(photo.file_id, 'photo.jpg')
        .then((localPath) => {
          const message = `[Image received and saved to: ${localPath}]\n\nYou can view this image using the Read tool on that file path.${caption ? `\n\nCaption from user: ${caption}` : ''}`;
          sendToClaude(message);
        })
        .catch((err) => {
          logger.loggers.bridge.error('Failed to process photo', { error: err.message });
          bot.sendMessage(chatId, 'Sorry, I failed to process that image. Please try again.');
        });
      return;
    }

    // Handle documents (including images sent as files)
    if (msg.document) {
      const doc = msg.document;
      const mimeType = doc.mime_type || '';
      const caption = msg.caption || '';

      logger.loggers.bridge.info('Document received', {
        fileId: doc.file_id,
        fileName: doc.file_name,
        mimeType,
        fileSize: doc.file_size,
      });

      // Check if it's an image
      if (mimeType.startsWith('image/')) {
        console.log('Image document received, downloading...');

        downloadTelegramFile(doc.file_id, doc.file_name)
          .then((localPath) => {
            const message = `[Image received and saved to: ${localPath}]\n\nYou can view this image using the Read tool on that file path.${caption ? `\n\nCaption from user: ${caption}` : ''}`;
            sendToClaude(message);
          })
          .catch((err) => {
            logger.loggers.bridge.error('Failed to process image document', { error: err.message });
            bot.sendMessage(chatId, 'Sorry, I failed to process that image. Please try again.');
          });
        return;
      } else {
        // Non-image document
        bot.sendMessage(chatId, `I received a document (${doc.file_name}), but I currently only support images. Please send images as photos or image files.`);
        return;
      }
    }
  });

  bot.on('polling_error', e => {
    logger.logUnhandledError('telegram_polling', e);
    console.error('Poll:', e.message);
  });

  // Cross-platform shutdown handling
  platform.setupShutdownHandlers((signal) => {
    logger.loggers.system.info(`${signal} received, shutting down`);
    if (claude) claude.kill();
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

  // Create output file and start Claude
  platform.ensureDir(path.dirname(OUTPUT_FILE));
  fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
  startClaude();
  logger.loggers.system.info('Bridge ready and listening');
  console.log('Ready - waiting for Telegram messages');
}

// ============================================
// CLI MODE QUICK SETUP
// ============================================

async function quickCliSetup(rl) {
  console.log('');
  console.log(c('green', '  Setting up CLI mode...'));
  console.log('');

  // Check Claude CLI
  console.log(c('dim', '  Checking Claude Code CLI...'));
  const claudeVersion = platform.getCommandVersion('claude');
  if (claudeVersion) {
    console.log(`  ${c('green', '[OK]')} Claude Code CLI found: ${claudeVersion}`);
  } else {
    console.log(`  ${c('red', '[X]')} Claude Code CLI not found.`);
    console.log('');
    console.log(c('dim', '  Install it with: npm install -g @anthropic-ai/claude-code'));
    console.log('');
    const cont = await prompt(rl, `  ${c('yellow', '?')} Continue anyway? (y/N): `);
    if (!cont.toLowerCase().startsWith('y')) {
      rl.close();
      process.exit(1);
    }
  }

  // Working directory
  console.log('');
  const defaultWorkdir = platform.getHomeDir();
  const workdirInput = await prompt(rl, `  ${c('yellow', '?')} Working directory ${c('dim', `[${defaultWorkdir}]`)}: `);
  const workdir = workdirInput || defaultWorkdir;

  if (!fs.existsSync(workdir)) {
    console.log(c('yellow', `  Creating directory: ${workdir}`));
    fs.mkdirSync(workdir, { recursive: true });
  }

  // Save minimal config
  const cliConfig = {
    mode: 'cli',
    workdir: workdir,
    credentials: { email: null, password: null }
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cliConfig, null, 2));
  console.log('');
  console.log(`  ${c('green', '[OK]')} Configuration saved!`);
  console.log('');
  console.log(c('cyan', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(c('dim', '  To add Telegram later: npm run setup-telegram'));
  console.log('');

  rl.close();
  return cliConfig;
}

// ============================================
// MAIN
// ============================================

async function main() {
  // Load config
  config = loadConfig();

  // If no config exists, show mode selection
  if (!config) {
    // Check if this is a direct run (not from setup.js)
    const isFromSetup = process.argv.includes('--from-setup');
    const isTelegramSetup = process.argv.includes('--telegram-setup');

    if (isTelegramSetup) {
      // Force Telegram setup mode
      require('./setup.js');
      return;
    }

    if (!isFromSetup) {
      showSetupMessage();

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const choice = await prompt(rl, `  ${c('yellow', '?')} Choose mode ${c('dim', '[1]')}: `);

      if (choice === '2') {
        rl.close();
        // Run full Telegram setup
        require('./setup.js');
        return;
      } else if (choice === '3') {
        rl.close();
        // Run Discord setup
        require('./setup-discord.js');
        return;
      } else {
        // CLI mode quick setup (default)
        config = await quickCliSetup(rl);
        // Start CLI chat
        require('./chat.js');
        return;
      }
    }

    // Fallback to inline bootstrap if called from setup
    const success = await bootstrap();
    if (!success) {
      console.error('Setup failed. Exiting.');
      process.exit(1);
    }
    config = loadConfig();
  }

  // Determine mode and start appropriate interface
  const mode = getMode(config);

  if (mode === 'cli') {
    // Start CLI chat mode
    console.log(c('cyan', '  Starting CLI mode...'));
    console.log(c('dim', '  To switch to Telegram mode: npm run setup-telegram'));
    console.log(c('dim', '  To switch to Discord mode: npm run setup-discord'));
    console.log('');
    require('./chat.js');
    return;
  }

  if (mode === 'discord') {
    // Start Discord mode
    const { startDiscordMode } = require('./lib/discord');
    await startDiscordMode(config);
    return;
  }

  // Telegram mode
  await startTelegramMode();
}

main().catch(console.error);
