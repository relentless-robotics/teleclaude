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
 */

const TelegramBot = require('node-telegram-bot-api');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Cross-platform utilities
const platform = require('./lib/platform');

// Configuration paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BRIDGE_DIR = __dirname;
const OUTPUT_FILE = platform.getOutputFile();
const MCP_CONFIG = path.join(__dirname, 'mcp', 'config.json');
const MAX_MSG = 4000;

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
let bot = null;

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
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(c('dim', '  You can add Telegram later with: npm run setup-telegram'));
  console.log('');
}

// ============================================
// PROCESS MANAGEMENT (Cross-platform)
// ============================================

function killOrphanedClaude() {
  return platform.killClaudeProcesses();
}

function getProcessStatus() {
  return platform.getProcessStatus();
}

// ============================================
// CLAUDE MANAGEMENT (Telegram Mode)
// ============================================

function startClaude() {
  if (claude) return;

  // Ensure output file directory exists
  platform.ensureDir(path.dirname(OUTPUT_FILE));
  fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
  lastMtime = Date.now();

  console.log('Starting Claude with MCP...');

  // On Windows, node-pty needs shell: true for proper command execution
  const shell = platform.isWindows ? 'cmd.exe' : undefined;

  claude = pty.spawn('claude', [
    '--dangerously-skip-permissions',
    '--mcp-config', MCP_CONFIG
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: BRIDGE_DIR,
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

  claude.onData((data) => {
    const clean = data.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (clean) console.log('PTY:', clean.slice(0, 200));
  });

  claude.onExit((e) => {
    console.log('Claude exited:', e.exitCode);
    claude = null;
    if (chatId) bot.sendMessage(chatId, 'Claude session ended. Send a message to restart.');
  });

  // Init prompt
  setTimeout(() => {
    if (!claude) {
      console.log('Claude not ready for init, skipping');
      return;
    }
    console.log('Sending init...');
    claude.write('Confirm you\'re ready by using send_to_telegram.');
    setTimeout(() => {
      if (claude) claude.write('\r');
    }, 500);
  }, 5000);

  console.log('Claude started');
}

// ============================================
// MESSAGE HANDLING (Telegram Mode)
// ============================================

function sendChunked(text) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= MAX_MSG) { chunks.push(text); break; }
    let i = text.lastIndexOf('\n', MAX_MSG);
    if (i < 500) i = MAX_MSG;
    chunks.push(text.slice(0, i));
    text = text.slice(i).trim();
  }

  chunks.forEach((c, idx) => {
    setTimeout(() => {
      bot.sendMessage(chatId, c)
        .catch(e => console.error('Send error:', e.message));
    }, idx * 300);
  });
}

function sendToClaude(userMessage) {
  if (!claude) {
    startClaude();
    setTimeout(() => sendToClaude(userMessage), 7000);
    return;
  }

  console.log('To Claude:', userMessage.slice(0, 60));
  claude.write(userMessage);
  setTimeout(() => {
    if (claude) claude.write('\r');
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

  console.log('Claude Telegram Bridge started');
  console.log(`Allowed users: ${config.allowedUsers.join(', ')}`);

  // Watch output file for Claude responses
  setInterval(() => {
    try {
      const stat = fs.statSync(OUTPUT_FILE);
      if (stat.mtimeMs > lastMtime && stat.size > 0) {
        lastMtime = stat.mtimeMs;
        const content = fs.readFileSync(OUTPUT_FILE, 'utf8').trim();

        if (content && chatId) {
          sendChunked(content);
          fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
          lastMtime = Date.now();
        }
      }
    } catch (e) {}
  }, 500);

  // Handle messages
  bot.on('message', (msg) => {
    console.log('MSG:', msg.from.id, msg.text?.slice(0, 50));

    if (!config.allowedUsers.includes(msg.from.id)) {
      bot.sendMessage(msg.chat.id, 'Access denied. Your user ID is not in the allowed list.');
      return;
    }

    chatId = msg.chat.id;
    const text = msg.text;

    // Command handlers
    if (text === '/help') {
      bot.sendMessage(chatId,
`*Bridge Commands*

/status - Check if Claude is running
/restart - Restart Claude session
/kill - Kill all Claude processes
/reset - Full reset and restart
/ping - Check bridge responsiveness
/help - Show this message`, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/ping') {
      bot.sendMessage(chatId, 'pong');
      return;
    }

    if (text === '/status') {
      const status = getProcessStatus();
      const claudeStatus = claude ? 'Running' : 'Not running';
      const pid = claude?.pid || 'N/A';
      bot.sendMessage(chatId,
`*Status*
Claude: ${claudeStatus}
PID: ${pid}
Related processes: ${status.count}`, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/restart') {
      bot.sendMessage(chatId, 'Restarting Claude...');
      if (claude) {
        claude.kill();
        claude = null;
      }
      setTimeout(startClaude, 1000);
      return;
    }

    if (text === '/kill') {
      bot.sendMessage(chatId, 'Killing all Claude processes...');
      if (claude) {
        claude.kill();
        claude = null;
      }
      killOrphanedClaude();
      bot.sendMessage(chatId, 'All Claude processes killed. Use /restart to start fresh.');
      return;
    }

    if (text === '/reset') {
      bot.sendMessage(chatId, 'Full reset in progress...');
      if (claude) {
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

    // Forward non-command messages to Claude
    if (text && !text.startsWith('/')) {
      sendToClaude(text);
    }
  });

  bot.on('polling_error', e => console.error('Poll:', e.message));
  process.on('SIGINT', () => { if (claude) claude.kill(); process.exit(0); });

  // Create output file and start Claude
  platform.ensureDir(path.dirname(OUTPUT_FILE));
  fs.writeFileSync(OUTPUT_FILE, '', 'utf8');
  startClaude();
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
    console.log('');
    require('./chat.js');
    return;
  }

  // Telegram mode
  await startTelegramMode();
}

main().catch(console.error);
