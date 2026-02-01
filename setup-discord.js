#!/usr/bin/env node
/**
 * Claude Discord Bridge - Add/Upgrade to Discord Mode
 * Use this to add Discord support to an existing setup
 * Cross-platform Windows/Unix compatible
 *
 * Run with: node setup-discord.js or npm run setup-discord
 */

const fs = require('fs');
const path = require('path');
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
const MCP_CONFIG = path.join(__dirname, 'mcp', 'discord-config.json');
const BRIDGE_DIR = __dirname;

// Cross-platform detection
const isWindows = process.platform === 'win32';

// Cross-platform home directory
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
  console.log(c('cyan', '  +===============================================================+'));
  console.log(c('cyan', '  |') + c('bold', '       Add Discord to Claude Code Bridge                      ') + c('cyan', '|'));
  console.log(c('cyan', '  +===============================================================+'));
  console.log('');
}

function printStep(current, total, title) {
  console.log(c('blue', `  +-------------------------------------------------------------+`));
  console.log(c('blue', `  | `) + c('bold', `Step ${current}/${total}: ${title}`.padEnd(57)) + c('blue', ` |`));
  console.log(c('blue', `  +-------------------------------------------------------------+`));
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
  const frames = ['|', '/', '-', '\\'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${c('cyan', frames[i++ % frames.length])} ${text}`);
  }, 100);
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
// STEP 1: Discord Bot Setup
// ============================================

async function setupDiscordBot(rl) {
  printHeader();
  printStep(1, 3, 'Discord Bot Setup');

  console.log(c('cyan', '  To create a Discord bot, follow these steps:'));
  console.log('');
  console.log('  1. Go to ' + c('bold', 'https://discord.com/developers/applications'));
  console.log('  2. Click ' + c('bold', '"New Application"') + ' and give it a name');
  console.log('  3. Go to the ' + c('bold', '"Bot"') + ' section in the left sidebar');
  console.log('  4. Click ' + c('bold', '"Reset Token"') + ' to generate a new token');
  console.log('  5. Copy the token (you can only see it once!)');
  console.log('');
  console.log(c('yellow', '  IMPORTANT: Enable these Privileged Gateway Intents:'));
  console.log('    - MESSAGE CONTENT INTENT');
  console.log('');
  console.log(c('dim', '  Token format: MTIzNDU2Nzg5MDEyMzQ1Njc4.Xxxxxx.Xxxxxxxxxxxxxxxxxxxxxxx'));
  console.log('');

  let token = '';
  let valid = false;

  while (!valid) {
    token = await prompt(rl, 'Enter your Discord Bot Token');

    if (!token) {
      error('Bot token is required.');
      console.log('');
      continue;
    }

    console.log('');
    const validateSpinner = spinner('Validating bot token...');

    try {
      const { Client, GatewayIntentBits } = require('discord.js');
      const testClient = new Client({
        intents: [GatewayIntentBits.Guilds]
      });

      await testClient.login(token);
      const botUser = testClient.user;
      await testClient.destroy();

      validateSpinner.stop(`Bot validated: ${botUser.tag}`);
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

  console.log(c('cyan', '  You need to specify which Discord users can DM your bot.'));
  console.log('');
  console.log('  To find your Discord user ID:');
  console.log('  1. Enable Developer Mode in Discord:');
  console.log('     Settings > App Settings > Advanced > Developer Mode');
  console.log('  2. Right-click your profile picture or username');
  console.log('  3. Click ' + c('bold', '"Copy User ID"'));
  console.log('');
  console.log(c('dim', '  Enter multiple IDs separated by commas'));
  console.log(c('dim', '  Example: 123456789012345678, 987654321098765432'));
  console.log('');

  let userIds = [];

  while (userIds.length === 0) {
    const input = await prompt(rl, 'Enter allowed Discord user ID(s)');

    if (!input) {
      error('At least one user ID is required.');
      console.log('');
      continue;
    }

    userIds = input.split(',')
      .map(id => id.trim())
      .filter(id => /^\d{17,19}$/.test(id)); // Discord IDs are 17-19 digit snowflakes

    if (userIds.length === 0) {
      error('No valid user IDs found. Discord IDs are 17-19 digit numbers.');
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

  console.log(c('cyan', '  Saving Discord configuration...'));
  console.log('');

  // Merge with existing config
  const config = {
    ...existingConfig,
    mode: 'discord',
    discordToken: token,
    discordAllowedUsers: userIds
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

  // Update MCP config with absolute path
  const mcpSpinner = spinner('Updating MCP configuration...');
  try {
    const mcpConfig = {
      mcpServers: {
        discord: {
          command: 'node',
          args: [path.join(BRIDGE_DIR, 'mcp', 'discord-bridge.js')]
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
  console.log(c('green', '  +===============================================================+'));
  console.log(c('green', '  |') + c('bold', '              Discord Setup Complete!                         ') + c('green', '|'));
  console.log(c('green', '  +===============================================================+'));
  console.log('');

  // Show summary
  console.log(c('cyan', '  Configuration Summary:'));
  console.log(c('dim', '  ---------------------------------------------------------------'));
  console.log(`  Mode:          ${c('green', 'Discord')}`);
  console.log(`  Bot Token:     ${c('dim', token.slice(0, 20) + '...' + token.slice(-5))}`);
  console.log(`  Allowed Users: ${userIds.join(', ')}`);
  console.log(`  Working Dir:   ${config.workdir || 'default'}`);
  console.log(c('dim', '  ---------------------------------------------------------------'));
  console.log('');

  console.log(c('yellow', '  NEXT STEPS:'));
  console.log('');
  console.log('  1. Invite your bot to a server (required for DM functionality):');
  console.log('     https://discord.com/developers/applications');
  console.log('     > Your App > OAuth2 > URL Generator');
  console.log('     > Select "bot" scope');
  console.log('     > Copy the URL and open it in your browser');
  console.log('');
  console.log('  2. DM your bot directly to start chatting with Claude!');
  console.log('');

  const startNow = await confirm(rl, 'Would you like to start the Discord bridge now?', true);

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

  // Check if already has Discord configured
  if (existingConfig?.discordToken) {
    printHeader();
    console.log(c('yellow', '  Discord is already configured!'));
    console.log('');

    const overwrite = await confirm(rl, 'Do you want to reconfigure Discord? This will overwrite existing settings', false);

    if (!overwrite) {
      console.log('');
      info('To start the Discord bridge, run: npm start');
      info('To use CLI mode, run: npm run chat');
      console.log('');
      rl.close();
      process.exit(0);
    }
  }

  try {
    // Step 1: Discord Bot
    const token = await setupDiscordBot(rl);

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
      console.log(c('cyan', '  Starting the Discord bridge...'));
      console.log(c('dim', '  ---------------------------------------------------------------'));
      console.log('');

      // Start the bridge
      require('./index.js');
    } else {
      console.log('');
      info('To start the Discord bridge later, run: npm start');
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
