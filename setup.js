#!/usr/bin/env node
/**
 * Claude Telegram Bridge - Setup Wizard
 * A beautiful terminal-based setup wizard for first-time configuration
 * Cross-platform Windows/Unix compatible
 *
 * Run with: node setup.js or npm run setup
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

// Cross-platform utilities - imported after npm install check
let platform = null;

// Configuration paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CLAUDE_MD = path.join(__dirname, 'CLAUDE.md');
const MCP_CONFIG = path.join(__dirname, 'mcp', 'config.json');

// Cross-platform detection (basic check before platform.js is available)
const isWindows = process.platform === 'win32';

// ANSI color codes (works without chalk)
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
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
};

// Helper functions
function c(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

// Cross-platform helper functions
// These are used before platform.js is available (during bootstrap)
// After bootstrap, we use the platform module instead
function getHomeDirFallback() {
  return process.env.HOME || process.env.USERPROFILE || require('os').homedir() || (isWindows ? 'C:\\Users\\Default' : '/home');
}

function commandExistsFallback(command) {
  try {
    if (isWindows) {
      execSync(`where ${command}`, { stdio: 'pipe' });
    } else {
      execSync(`which ${command} 2>/dev/null`, { stdio: 'pipe' });
    }
    return true;
  } catch (e) {
    return false;
  }
}

function getCommandVersionFallback(command) {
  try {
    const cmd = isWindows ? `${command} --version 2>nul` : `${command} --version 2>/dev/null`;
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

// Wrapper functions that use platform module when available, fallback otherwise
function getHomeDir() {
  if (platform) return platform.getHomeDir();
  return getHomeDirFallback();
}

function commandExists(command) {
  if (platform) return platform.commandExists(command);
  return commandExistsFallback(command);
}

function getCommandVersion(command) {
  if (platform) return platform.getCommandVersion(command);
  return getCommandVersionFallback(command);
}

function printHeader() {
  console.clear();
  console.log('');
  console.log(c('cyan', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('cyan', '  ║') + c('bold', '       Claude Code Bridge - Setup Wizard                      ') + c('cyan', '║'));
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

// ============================================
// BOOTSTRAP: Check and install dependencies
// ============================================

async function bootstrapDependencies() {
  printHeader();
  console.log(c('cyan', '  Checking prerequisites...'));
  console.log('');

  // Check if node_modules exists
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log(c('yellow', '  [!] Dependencies not installed'));
    console.log('');
    const sp = spinner('Installing npm dependencies...');

    try {
      execSync('npm install', {
        cwd: __dirname,
        stdio: 'pipe'
      });
      sp.stop('Dependencies installed successfully');
    } catch (e) {
      sp.stop('Failed to install dependencies', false);
      console.log('');
      error(`Error: ${e.message}`);
      console.log('');
      info('Try running: npm install');
      console.log('');
      process.exit(1);
    }
  } else {
    success('Dependencies already installed');
  }

  // Now that dependencies are installed, load the platform module
  try {
    platform = require('./lib/platform');
  } catch (e) {
    // Platform module not available, will use fallbacks
  }

  console.log('');
}

// ============================================
// MODE SELECTION
// ============================================

async function selectMode(rl) {
  printHeader();

  console.log(c('dim', '  Choose how you want to use Claude Code Bridge:'));
  console.log('');
  console.log(c('green', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(`  ${c('bold', '[1]')} ${c('green', 'CLI Mode')} ${c('yellow', '(Recommended - Quick Start)')}`);
  console.log(c('dim', '      Chat with Claude directly in this terminal.'));
  console.log(c('dim', '      Minimal setup - start chatting immediately!'));
  console.log('');
  console.log(`  ${c('bold', '[2]')} ${c('cyan', 'Telegram Mode')} ${c('dim', '(Full Setup)')}`);
  console.log(c('dim', '      Control Claude from your phone via Telegram.'));
  console.log(c('dim', '      Requires creating a Telegram bot first.'));
  console.log('');
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(c('dim', '  You can add Telegram later with: npm run setup-telegram'));
  console.log('');

  const choice = await prompt(rl, 'Choose mode', '1');

  return choice === '2' ? 'telegram' : 'cli';
}

// ============================================
// STEP 1: System Check
// ============================================

async function checkSystem(rl, totalSteps) {
  printHeader();
  printStep(1, totalSteps, 'System Check');

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

  if (majorVersion >= 18) {
    success(`Node.js ${nodeVersion} detected`);
  } else {
    error(`Node.js ${nodeVersion} detected - version 18+ required`);
    console.log('');
    info('Please upgrade Node.js: https://nodejs.org/');
    process.exit(1);
  }

  // Check platform
  console.log('');
  if (isWindows) {
    success('Platform: Windows');
  } else {
    success(`Platform: ${process.platform}`);
  }

  // Check if Claude Code CLI is installed
  console.log('');
  const sp = spinner('Checking for Claude Code CLI...');

  let claudeInstalled = false;
  let claudeVersion = '';

  claudeVersion = getCommandVersion('claude');
  if (claudeVersion) {
    claudeInstalled = true;
    sp.stop(`Claude Code CLI found: ${claudeVersion}`);
  } else {
    sp.stop('Claude Code CLI not found', false);
  }

  if (!claudeInstalled) {
    console.log('');
    warning('Claude Code CLI is required for this bridge to work.');
    console.log('');

    const install = await confirm(rl, 'Would you like to install Claude Code CLI now?', true);

    if (install) {
      console.log('');
      const installSpinner = spinner('Installing Claude Code CLI via npm...');

      try {
        execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'pipe' });
        installSpinner.stop('Claude Code CLI installed successfully!');
        claudeInstalled = true;
      } catch (e) {
        installSpinner.stop('Installation failed', false);
        console.log('');
        error(`Error: ${e.message}`);
        console.log('');
        info('Try running manually: npm install -g @anthropic-ai/claude-code');
        if (isWindows) {
          info('On Windows, you may need to run as Administrator.');
        } else {
          info('You may need sudo permissions: sudo npm install -g @anthropic-ai/claude-code');
        }

        const continueAnyway = await confirm(rl, 'Continue setup anyway?', false);
        if (!continueAnyway) {
          console.log('\nSetup cancelled. Please install Claude Code CLI and try again.\n');
          process.exit(1);
        }
      }
    } else {
      console.log('');
      info('You can install it later with: npm install -g @anthropic-ai/claude-code');
      const continueAnyway = await confirm(rl, 'Continue setup anyway?', false);
      if (!continueAnyway) {
        console.log('\nSetup cancelled.\n');
        process.exit(1);
      }
    }
  }

  await pressEnter(rl);
  return { claudeInstalled, claudeVersion };
}

// ============================================
// STEP 2: Claude Code Authentication
// ============================================

async function checkClaudeAuth(rl, claudeInstalled, totalSteps) {
  printHeader();
  printStep(2, totalSteps, 'Claude Code Authentication');

  if (!claudeInstalled) {
    warning('Claude Code CLI is not installed. Skipping authentication check.');
    await pressEnter(rl);
    return false;
  }

  info('Claude Code needs to be authenticated with your Anthropic account.');
  console.log('');

  // Check if already authenticated
  const authSpinner = spinner('Checking authentication status...');

  let isAuthenticated = false;

  try {
    // Try running a simple command that requires auth
    execSync('claude --version', {
      stdio: 'pipe',
      timeout: 10000
    });

    // If we get here, basic CLI works. Let's assume auth might be needed on first use.
    // Claude Code typically prompts for auth interactively.
    authSpinner.stop('Claude Code CLI is ready');
    isAuthenticated = true;
  } catch (e) {
    authSpinner.stop('Could not verify authentication', false);
  }

  console.log('');
  info('If you haven\'t authenticated yet, Claude will prompt you on first use.');
  console.log('');
  console.log(c('cyan', '  To authenticate manually, open a new terminal and run:'));
  console.log(c('white', '  $ claude'));
  console.log(c('dim', '  Follow the prompts to log in with your Anthropic account.'));
  console.log('');

  const confirmed = await confirm(rl, 'Have you authenticated with Claude Code (or will do so later)?', true);

  await pressEnter(rl);
  return confirmed;
}

// ============================================
// STEP 3: Telegram Bot Setup
// ============================================

async function setupTelegramBot(rl, totalSteps) {
  printHeader();
  printStep(3, totalSteps, 'Telegram Bot Setup');

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
      // Dynamically import node-telegram-bot-api
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
// STEP 4: User Access
// ============================================

async function setupUserAccess(rl, totalSteps) {
  printHeader();
  printStep(4, totalSteps, 'User Access Configuration');

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
// Working Directory (for both modes)
// ============================================

async function setupWorkdir(rl, stepNum, totalSteps) {
  printHeader();
  printStep(stepNum, totalSteps, 'Working Directory');

  console.log(c('cyan', '  Choose where Claude will have file system access.'));
  console.log('');
  info('Claude will be able to read, write, and execute files in this directory.');
  console.log('');

  const defaultWorkdir = getHomeDir();
  let workdir = '';

  while (!workdir) {
    workdir = await prompt(rl, 'Working directory', defaultWorkdir);

    if (!fs.existsSync(workdir)) {
      console.log('');
      warning(`Directory "${workdir}" does not exist.`);

      const create = await confirm(rl, 'Create this directory?', true);

      if (create) {
        try {
          fs.mkdirSync(workdir, { recursive: true });
          success(`Created directory: ${workdir}`);
        } catch (e) {
          error(`Could not create directory: ${e.message}`);
          workdir = '';
          console.log('');
        }
      } else {
        workdir = '';
        console.log('');
      }
    }
  }

  console.log('');
  success(`Working directory: ${workdir}`);

  await pressEnter(rl);
  return workdir;
}

// ============================================
// Optional Credentials
// ============================================

async function setupCredentials(rl, stepNum, totalSteps) {
  printHeader();
  printStep(stepNum, totalSteps, 'Default Login Credentials (Optional)');

  console.log(c('cyan', '  You can optionally configure default login credentials.'));
  console.log('');
  info('These are used by Claude for browser automation tasks');
  info('(e.g., logging into websites on your behalf).');
  console.log('');
  warning('Credentials are stored in plain text in CLAUDE.md');
  console.log('');

  const setupCreds = await confirm(rl, 'Would you like to set up default credentials?', false);

  let email = null;
  let password = null;

  if (setupCreds) {
    console.log('');
    email = await prompt(rl, 'Default email for logins');
    password = await prompt(rl, 'Default password for logins');

    if (email || password) {
      console.log('');
      success('Credentials will be saved to CLAUDE.md');
    }
  } else {
    console.log('');
    info('Skipping credentials setup. You can add them later to CLAUDE.md');
  }

  await pressEnter(rl);
  return { email: email || null, password: password || null };
}

// ============================================
// Save Configuration (CLI Mode)
// ============================================

async function saveCliConfiguration(rl, workdir, credentials, totalSteps) {
  printHeader();
  printStep(totalSteps, totalSteps, 'Save Configuration');

  console.log(c('cyan', '  Saving your configuration...'));
  console.log('');

  // Create config object
  const config = {
    mode: 'cli',
    workdir: workdir,
    credentials: credentials
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

  // Update CLAUDE.md with credentials if provided
  if (credentials.email || credentials.password) {
    const credSpinner = spinner('Updating CLAUDE.md with credentials...');
    try {
      let claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');

      if (credentials.email) {
        claudeMd = claudeMd.replace(
          /- \*\*Email:\*\* \[YOUR_EMAIL\]/g,
          `- **Email:** ${credentials.email}`
        );
      }
      if (credentials.password) {
        claudeMd = claudeMd.replace(
          /- \*\*Password:\*\* \[YOUR_PASSWORD\]/g,
          `- **Password:** ${credentials.password}`
        );
      }

      fs.writeFileSync(CLAUDE_MD, claudeMd);
      credSpinner.stop('CLAUDE.md updated');
    } catch (e) {
      credSpinner.stop('Could not update CLAUDE.md', false);
    }
  }

  console.log('');
  console.log(c('green', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('green', '  ║') + c('bold', '                 Setup Complete!                               ') + c('green', '║'));
  console.log(c('green', '  ╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');

  // Show summary
  console.log(c('cyan', '  Configuration Summary:'));
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
  console.log(`  Mode:          ${c('green', 'CLI (Local Chat)')}`);
  console.log(`  Working Dir:   ${workdir}`);
  console.log(`  Credentials:   ${credentials.email ? 'Configured' : 'Not set'}`);
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(c('dim', '  To add Telegram later: npm run setup-telegram'));
  console.log('');

  const startNow = await confirm(rl, 'Would you like to start chatting with Claude now?', true);

  return startNow;
}

// ============================================
// Save Configuration (Telegram Mode)
// ============================================

async function saveTelegramConfiguration(rl, token, userIds, workdir, credentials, totalSteps) {
  printHeader();
  printStep(totalSteps, totalSteps, 'Save & Verify Configuration');

  console.log(c('cyan', '  Saving your configuration...'));
  console.log('');

  // Create config object
  const config = {
    mode: 'telegram',
    telegramToken: token,
    allowedUsers: userIds,
    workdir: workdir,
    credentials: credentials
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

  // Update CLAUDE.md with credentials if provided
  if (credentials.email || credentials.password) {
    const credSpinner = spinner('Updating CLAUDE.md with credentials...');
    try {
      let claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');

      if (credentials.email) {
        claudeMd = claudeMd.replace(
          /- \*\*Email:\*\* \[YOUR_EMAIL\]/g,
          `- **Email:** ${credentials.email}`
        );
      }
      if (credentials.password) {
        claudeMd = claudeMd.replace(
          /- \*\*Password:\*\* \[YOUR_PASSWORD\]/g,
          `- **Password:** ${credentials.password}`
        );
      }

      fs.writeFileSync(CLAUDE_MD, claudeMd);
      credSpinner.stop('CLAUDE.md updated');
    } catch (e) {
      credSpinner.stop('Could not update CLAUDE.md', false);
    }
  }

  console.log('');
  console.log(c('green', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('green', '  ║') + c('bold', '                 Setup Complete!                               ') + c('green', '║'));
  console.log(c('green', '  ╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');

  // Show summary
  console.log(c('cyan', '  Configuration Summary:'));
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
  console.log(`  Mode:          ${c('cyan', 'Telegram')}`);
  console.log(`  Bot Token:     ${c('dim', token.slice(0, 10) + '...' + token.slice(-5))}`);
  console.log(`  Allowed Users: ${userIds.join(', ')}`);
  console.log(`  Working Dir:   ${workdir}`);
  console.log(`  Credentials:   ${credentials.email ? 'Configured' : 'Not set'}`);
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
  console.log('');

  const startNow = await confirm(rl, 'Would you like to start the bridge now?', true);

  return startNow;
}

// ============================================
// MAIN
// ============================================

async function main() {
  // Bootstrap: Install dependencies if needed
  await bootstrapDependencies();

  // Check if already configured
  if (fs.existsSync(CONFIG_FILE)) {
    printHeader();
    console.log(c('yellow', '  Configuration already exists!'));
    console.log('');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const overwrite = await confirm(rl, 'Do you want to reconfigure? This will overwrite existing settings', false);

    if (!overwrite) {
      console.log('');
      info('To start the bridge, run: npm start');
      info('To use local chat mode, run: npm run chat');
      console.log('');
      rl.close();
      process.exit(0);
    }

    rl.close();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    // First, select mode
    const mode = await selectMode(rl);

    if (mode === 'cli') {
      // CLI Mode: 4 steps (System, Auth, Workdir, Credentials + Save)
      const totalSteps = 5;

      // Step 1: System Check
      const { claudeInstalled } = await checkSystem(rl, totalSteps);

      // Step 2: Claude Authentication
      await checkClaudeAuth(rl, claudeInstalled, totalSteps);

      // Step 3: Working Directory
      const workdir = await setupWorkdir(rl, 3, totalSteps);

      // Step 4: Credentials
      const credentials = await setupCredentials(rl, 4, totalSteps);

      // Step 5: Save
      const startNow = await saveCliConfiguration(rl, workdir, credentials, totalSteps);

      rl.close();

      if (startNow) {
        console.log('');
        console.log(c('cyan', '  Starting CLI chat mode...'));
        console.log(c('dim', '  ─────────────────────────────────────────────────────────────'));
        console.log('');

        // Start chat mode
        require('./chat.js');
      } else {
        console.log('');
        info('To start CLI chat, run: npm run chat');
        info('To add Telegram, run: npm run setup-telegram');
        console.log('');
      }

    } else {
      // Telegram Mode: 7 steps
      const totalSteps = 7;

      // Step 1: System Check
      const { claudeInstalled } = await checkSystem(rl, totalSteps);

      // Step 2: Claude Authentication
      await checkClaudeAuth(rl, claudeInstalled, totalSteps);

      // Step 3: Telegram Bot Setup
      const token = await setupTelegramBot(rl, totalSteps);

      // Step 4: User Access
      const userIds = await setupUserAccess(rl, totalSteps);

      // Step 5: Working Directory
      const workdir = await setupWorkdir(rl, 5, totalSteps);

      // Step 6: Credentials
      const credentials = await setupCredentials(rl, 6, totalSteps);

      // Step 7: Save & Verify
      const startNow = await saveTelegramConfiguration(rl, token, userIds, workdir, credentials, totalSteps);

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
        info('To use local chat mode, run: npm run chat');
        console.log('');
      }
    }

  } catch (e) {
    console.error('\nSetup error:', e.message);
    rl.close();
    process.exit(1);
  }
}

main();
