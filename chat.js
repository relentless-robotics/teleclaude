#!/usr/bin/env node
/**
 * Claude Telegram Bridge - Local Chat Mode
 * A simple terminal interface to chat with Claude without Telegram
 * Cross-platform Windows/Unix compatible
 *
 * Run with: node chat.js or npm run chat
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pty = require('node-pty');

// Cross-platform utilities
const platform = require('./lib/platform');

// Configuration
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BRIDGE_DIR = __dirname;

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
let rl = null;
let isProcessing = false;
let responseBuffer = '';
let responseTimeout = null;

function printHeader() {
  console.clear();
  console.log('');
  console.log(c('cyan', '  ╔═══════════════════════════════════════════════════════════════╗'));
  console.log(c('cyan', '  ║') + c('bold', '       Claude Telegram Bridge - Local Chat Mode               ') + c('cyan', '║'));
  console.log(c('cyan', '  ╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(c('dim', '  Type your message and press Enter to send.'));
  console.log(c('dim', '  Commands: /help, /clear, /quit'));
  console.log('');
  console.log(c('dim', '  ─────────────────────────────────────────────────────────────────'));
  console.log('');
}

function printHelp() {
  console.log('');
  console.log(c('cyan', '  Available Commands:'));
  console.log('');
  console.log(`  ${c('bold', '/help')}    - Show this help message`);
  console.log(`  ${c('bold', '/clear')}   - Clear the screen`);
  console.log(`  ${c('bold', '/status')} - Check Claude process status`);
  console.log(`  ${c('bold', '/restart')} - Restart Claude session`);
  console.log(`  ${c('bold', '/quit')}    - Exit chat mode`);
  console.log('');
}

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

function cleanAnsi(text) {
  // Remove ANSI escape codes
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function processResponse(data) {
  responseBuffer += data;

  // Clear previous timeout
  if (responseTimeout) {
    clearTimeout(responseTimeout);
  }

  // Set timeout to flush buffer after response seems complete
  responseTimeout = setTimeout(() => {
    if (responseBuffer.trim()) {
      const clean = cleanAnsi(responseBuffer);

      // Filter out internal status messages and prompts
      const lines = clean.split('\n').filter(line => {
        const trimmed = line.trim();
        // Filter out common Claude CLI output noise
        if (!trimmed) return false;
        if (trimmed.startsWith('>')) return false;
        if (trimmed.includes('Thinking')) return false;
        if (trimmed.match(/^[\s│├└─┐┌┘┤┬┴┼]+$/)) return false;
        if (trimmed === 'Claude') return false;
        return true;
      });

      if (lines.length > 0) {
        console.log('');
        console.log(c('green', '  Claude:'));
        lines.forEach(line => {
          console.log(c('white', `  ${line}`));
        });
        console.log('');
      }

      responseBuffer = '';
      isProcessing = false;
      promptUser();
    }
  }, 2000);
}

function startClaude() {
  console.log(c('yellow', '  Starting Claude...'));
  console.log('');

  const workdir = config?.workdir || platform.getHomeDir();

  // Cross-platform PTY spawning
  claude = pty.spawn('claude', [
    '--dangerously-skip-permissions'
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: workdir,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      HOME: workdir,
      USERPROFILE: workdir // Windows equivalent
    },
    useConpty: platform.isWindows // Use ConPTY on Windows
  });

  claude.onData((data) => {
    processResponse(data);
  });

  claude.onExit((e) => {
    console.log('');
    console.log(c('yellow', `  Claude exited (code: ${e.exitCode})`));
    claude = null;

    if (rl) {
      console.log(c('dim', '  Use /restart to start a new session, or /quit to exit.'));
      console.log('');
      promptUser();
    }
  });

  // Wait for Claude to be ready
  setTimeout(() => {
    console.log(c('green', '  Claude is ready!'));
    console.log('');
    isProcessing = false;
    promptUser();
  }, 3000);
}

function sendToClaude(message) {
  if (!claude) {
    console.log(c('red', '  Claude is not running. Use /restart to start.'));
    promptUser();
    return;
  }

  isProcessing = true;
  console.log('');
  console.log(c('dim', '  Sending to Claude...'));

  claude.write(message);
  setTimeout(() => {
    if (claude) claude.write('\r');
  }, 100);
}

function promptUser() {
  if (isProcessing) return;

  rl.question(c('cyan', '  You: '), (input) => {
    const trimmed = input.trim();

    if (!trimmed) {
      promptUser();
      return;
    }

    // Handle commands
    if (trimmed.startsWith('/')) {
      const cmd = trimmed.toLowerCase();

      switch (cmd) {
        case '/help':
          printHelp();
          promptUser();
          break;

        case '/clear':
          printHeader();
          promptUser();
          break;

        case '/status':
          if (claude) {
            console.log(c('green', `  Claude is running (PID: ${claude.pid})`));
          } else {
            console.log(c('yellow', '  Claude is not running'));
          }
          console.log('');
          promptUser();
          break;

        case '/restart':
          if (claude) {
            console.log(c('yellow', '  Restarting Claude...'));
            claude.kill();
            claude = null;
          }
          setTimeout(startClaude, 1000);
          break;

        case '/quit':
        case '/exit':
          console.log('');
          console.log(c('cyan', '  Goodbye!'));
          console.log('');
          if (claude) claude.kill();
          rl.close();
          process.exit(0);
          break;

        default:
          console.log(c('yellow', `  Unknown command: ${cmd}`));
          console.log(c('dim', '  Type /help for available commands.'));
          console.log('');
          promptUser();
      }

      return;
    }

    // Send message to Claude
    sendToClaude(trimmed);
  });
}

async function main() {
  // Load config if exists
  config = loadConfig();

  printHeader();

  // Check if Claude Code is installed
  if (!platform.commandExists('claude')) {
    console.log(c('red', '  Error: Claude Code CLI is not installed.'));
    console.log('');
    console.log(c('dim', '  Install it with: npm install -g @anthropic-ai/claude-code'));
    console.log('');
    process.exit(1);
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Handle Ctrl+C
  rl.on('close', () => {
    console.log('');
    if (claude) claude.kill();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('');
    console.log(c('cyan', '  Goodbye!'));
    if (claude) claude.kill();
    rl.close();
    process.exit(0);
  });

  // Start Claude
  startClaude();
}

main().catch(console.error);
