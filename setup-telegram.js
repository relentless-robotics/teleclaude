#!/usr/bin/env node
/**
 * Claude Telegram Bridge - Add/Upgrade to Telegram Mode
 * Use this to add Telegram support to an existing CLI-only setup
 * Cross-platform Windows/Unix compatible
 *
 * Run with: node setup-telegram.js or npm run setup-telegram
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// Cross-platform utilities
let platform;
try {
  platform = require('./lib/platform');
} catch (e) {
  // Platform module not available yet
  platform = null;
}

// Configuration paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CLAUDE_MD = path.join(__dirname, 'CLAUDE.md');
const MCP_CONFIG = path.join(__dirname, 'mcp', 'config.json');

// Cross-platform detection
const isWindows = process.platform === 'win32';

// Cross-platform home directory (uses platform module if available)
function getHomeDir() {
  if (platform) return platform.getHomeDir();
  return process.env.HOME || process.env.USERPROFILE || require('os').homedir() || (isWindows ? 'C:\\Users\\Default' : '/home');
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

function printHeader() {
  console.clear();
  console.log('');
  console.log(c('cyan', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('cyan', '  ║') + c('bold', '       Add Telegram to Claude Code Bridge                     ') + c('cyan', '║'));
  console.log(c('cyan', '  ╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');
}

function printStep(current, total, title) {
  console.log(c('blue', `  ┌─────────────────────────────────────────────────────────────┐`));
  console.log(c('blue', `  │ `) + c('bold', `Step ${current}/${total}: ${title}`.padEnd(57)) + c('blue', ` │`));
  console.log(c('blue', `  └─────────────────────────────────────────────────────────────┘`));
  console.log('');
}

function success(msg) {
  console.log(`  ${c('green', '[OK]')} ${msg}`);
}

function error(msg) {
  console.log(`  ${c('red', '[X]')} ${msg}`);
}

function warning(msg) {
  console.log(`  ${c('yellow', '[!]')} ${msg}`);
}

function info(msg) {
  console.log(`  ${c('blue', '[i]')} ${msg}`);
}

function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${c('cyan', frames[i++ % frames.length])} ${text}`);
  }, 80);
  return {
    stop: (finalText, isSuccess = true) => {
      clearInterval(interval);
      const icon = isSuccess ? c('green', '[OK]') : c('red', '[X]');
      process.stdout.write(`\r  ${icon} ${finalText}\n`);
    }
  };
}

async function prompt(rl, question, defaultValue = '') {
  return new Promise((resolve) => {
    const displayDefault = defaultValue ? c('dim', ` [${defaultValue}]`) : '';
    rl.question(`  ${c('yellow', '?')} ${question}${displayDefault}: `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? c('dim', ' (Y/n)') : c('dim', ' (y/N)');
  const answer = await prompt(rl, question + hint);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

function pressEnter(rl) {
  return new Promise((resolve) => {
    rl.question(`\n  ${c('dim', 'Press Enter to continue...')}`, () => resolve());
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ============================================
// STEP 1: Telegram Bot Setup
// ============================================

async function setupTelegramBot(rl) {
  printHeader();
  printStep(1, 3, 'Telegram Bot Setup');

  console.log(c('cyan', '  To create a Telegram bot, follow these steps:'));
  console.log('');
  console.log('  1. Open Telegram and search for ' + c('bold', '@BotFather'));
  console.log('  2. Send ' + c('bold', '/newbot') + ' to BotFather');
  console.log('  3. Choose a name for your bot (e.g., "My Claude Bot")');
  console.log('  4. Choose a username ending in "bot" (e.g., "my_claude_bot")');
  console.log('  5. BotFather will give you an API token');
  console.log('');
  console.log(c('dim', '  Token format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz'));
  console.log('');

  let token = '';
  let valid = false;

  while (!valid) {
    token = await prompt(rl, 'Enter your Telegram Bot Token');

    if (!token) {
      error('Bot token is required.');
      console.log('');
      continue;
    }

    console.log('');
    const validateSpinner = spinner('Validating bot token...');

    try {
      const TelegramBot = require('node-telegram-bot-api');
      const testBot = new TelegramBot(token);
      const me = await testBot.getMe();

      validateSpinner.stop(`Bot validated: @${me.username} (${me.first_name})`);
      valid = true;
    } catch (e) {
      validateSpinner.stop('Invalid token', false);
      console.log('');
      error(`Error: ${e.message}`);
      console.log('');

      const retry = await confirm(rl, 'Would you like to try again?', true);
      if (!retry) {
        console.log('\nSetup cancelled.\n');
        process.exit(1);
      }
      console.log('');
    }
  }

  await pressEnter(rl);
  return token;
}

// ============================================
// STEP 2: User Access
// ============================================

async function setupUserAccess(rl) {
  printHeader();
  printStep(2, 3, 'User Access Configuration');

  console.log(c('cyan', '  You need to specify which Telegram users can use your bot.'));
  console.log('');
  console.log('  To find your Telegram user ID:');
  console.log('  1. Open Telegram and search for ' + c('bold', '@userinfobot'));
  console.log('  2. Send any message to the bot');
  console.log('  3. It will reply with your user ID');
  console.log('');
  console.log(c('dim', '  Enter multiple IDs separated by commas (e.g., 123456789, 987654321)'));
  console.log('');

  let userIds = [];

  while (userIds.length === 0) {
    const input = await prompt(rl, 'Enter allowed Telegram user ID(s)');

    if (!input) {
      error('At least one user ID is required.');
      console.log('');
      continue;
    }

    userIds = input.split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id) && id > 0);

    if (userIds.length === 0) {
      error('No valid user IDs found. Please enter numeric IDs.');
      console.log('');
    }
  }

  console.log('');
  success(`Allowed users: ${userIds.join(', ')}`);

  await pressEnter(rl);
  return userIds;
}

// ============================================
// STEP 3: Save Configuration
// ============================================

async function saveConfiguration(rl, existingConfig, token, userIds) {
  printHeader();
  printStep(3, 3, 'Save Configuration');

  console.log(c('cyan', '  Saving Telegram configuration...'));
  console.log('');

  // Merge with existing config
  const config = {
    ...existingConfig,
    mode: 'telegram',
    telegramToken: token,
    allowedUsers: userIds
  };

  // Save config.json
  const configSpinner = spinner('Saving config.json...');
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    configSpinner.stop('config.json saved');
  } catch (e) {
    configSpinner.stop('Failed to save config.json', false);
    error(e.message);
    process.exit(1);
  }

  // Update MCP config
  const mcpSpinner = spinner('Updating MCP configuration...');
  try {
    const mcpConfig = {
      mcpServers: {
        telegram: {
          command: 'node',
          args: [path.join(__dirname, 'mcp', 'telegram-bridge.js')]
        }
      }
    };
    fs.writeFileSync(MCP_CONFIG, JSON.stringify(mcpConfig, null, 2));
    mcpSpinner.stop('MCP configuration updated');
  } catch (e) {
    mcpSpinner.stop('Failed to update MCP config', false);
    error(e.message);
  }

  console.log('');
  console.log(c('green', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('green', '  ║') + c('bold', '              Telegram Setup Complete!                        ') + c('green', '║'));
  console.log(c('green', '  ╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');

  // Show summary
  console.log(c('cyan', '  Configuration Summary:'));
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
  console.log(`  Mode:          ${c('green', 'Telegram')}`);
  console.log(`  Bot Token:     ${c('dim', token.slice(0, 10) + '...' + token.slice(-5))}`);
  console.log(`  Allowed Users: ${userIds.join(', ')}`);
  console.log(`  Working Dir:   ${config.workdir || 'default'}`);
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
  console.log('');

  const startNow = await confirm(rl, 'Would you like to start the Telegram bridge now?', true);

  return startNow;
}

// ============================================
// MAIN
// ============================================

async function main() {
  // Load existing config
  const existingConfig = loadConfig();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Check if already has Telegram configured
  if (existingConfig?.telegramToken) {
    printHeader();
    console.log(c('yellow', '  Telegram is already configured!'));
    console.log('');

    const overwrite = await confirm(rl, 'Do you want to reconfigure Telegram? This will overwrite existing settings', false);

    if (!overwrite) {
      console.log('');
      info('To start the Telegram bridge, run: npm start');
      info('To use CLI mode, run: npm run chat');
      console.log('');
      rl.close();
      process.exit(0);
    }
  }

  try {
    // Step 1: Telegram Bot
    const token = await setupTelegramBot(rl);

    // Step 2: User Access
    const userIds = await setupUserAccess(rl);

    // Step 3: Save
    const baseConfig = existingConfig || {
      workdir: getHomeDir(),
      credentials: { email: null, password: null }
    };

    const startNow = await saveConfiguration(rl, baseConfig, token, userIds);

    rl.close();

    if (startNow) {
      console.log('');
      console.log(c('cyan', '  Starting the Telegram bridge...'));
      console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
      console.log('');

      // Start the bridge
      require('./index.js');
    } else {
      console.log('');
      info('To start the Telegram bridge later, run: npm start');
      info('To use CLI mode instead, run: npm run chat');
      console.log('');
    }

  } catch (e) {
    console.error('\nSetup error:', e.message);
    rl.close();
    process.exit(1);
  }
}

main();
