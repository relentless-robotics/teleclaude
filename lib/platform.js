/**
 * Cross-platform utilities for Windows/Unix compatibility
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const isWindows = process.platform === 'win32';

/**
 * Get the home directory cross-platform
 */
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || (isWindows ? 'C:\\Users\\Default' : '/home');
}

/**
 * Get temp directory cross-platform
 */
function getTempDir() {
  return os.tmpdir();
}

/**
 * Get the output file path for Telegram (cross-platform)
 */
function getOutputFile() {
  return path.join(getTempDir(), 'tg-response.txt');
}

/**
 * Get the output file path for Discord (cross-platform)
 */
function getDiscordOutputFile() {
  return path.join(getTempDir(), 'discord-response.txt');
}

/**
 * Get the appropriate shell for the platform
 */
function getShell() {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

/**
 * Get the 'which' equivalent command for finding executables
 */
function getWhichCommand() {
  return isWindows ? 'where' : 'which';
}

/**
 * Clear the terminal screen cross-platform
 */
function clearScreen() {
  if (isWindows) {
    // On Windows, console.clear() works but we can also use cls
    process.stdout.write('\x1Bc');
  } else {
    process.stdout.write('\x1Bc');
  }
}

/**
 * Setup graceful shutdown handlers cross-platform
 * Windows doesn't have SIGINT/SIGTERM the same way Unix does
 */
function setupShutdownHandlers(cleanupFn) {
  // Handle Ctrl+C - works on both platforms
  process.on('SIGINT', () => {
    cleanupFn('SIGINT');
  });

  // SIGTERM - Unix only, ignored on Windows
  if (!isWindows) {
    process.on('SIGTERM', () => {
      cleanupFn('SIGTERM');
    });
  }

  // Windows-specific: handle when the console window is closed
  if (isWindows) {
    // Handle console close event on Windows
    process.on('SIGHUP', () => {
      cleanupFn('SIGHUP');
    });
  }

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanupFn('uncaughtException');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection:', reason);
  });
}

/**
 * Normalize a path for the current platform
 * Converts forward/backward slashes to the appropriate separator
 */
function normalizePath(inputPath) {
  if (!inputPath) return inputPath;
  return path.normalize(inputPath);
}

/**
 * Join paths safely, handling mixed separators
 */
function joinPaths(...parts) {
  return path.join(...parts.map(p => p ? String(p) : ''));
}

/**
 * Check if a command exists
 */
function commandExists(command) {
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

/**
 * Get the full path to a command
 */
function getCommandPath(command) {
  try {
    if (isWindows) {
      const output = execSync(`where ${command}`, { encoding: 'utf8' });
      const paths = output.split(/[\r\n]+/).map(p => p.trim()).filter(p => p);
      
      // Prefer .cmd or .exe on Windows to avoid Error 193 (Bad EXE format)
      const preferred = paths.find(p => p.toLowerCase().endsWith('.cmd') || p.toLowerCase().endsWith('.exe') || p.toLowerCase().endsWith('.bat'));
      return preferred || paths[0] || command;
    } else {
      return execSync(`which ${command}`, { encoding: 'utf8' }).trim();
    }
  } catch (e) {
    return command;
  }
}

/**
 * Get command version
 */
function getCommandVersion(command) {
  try {
    const cmd = isWindows ? `${command} --version 2>nul` : `${command} --version 2>/dev/null`;
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Kill processes by name pattern (cross-platform)
 */
function killProcessesByPattern(pattern) {
  try {
    if (isWindows) {
      // On Windows, use taskkill with filter
      // This is best-effort - may not kill all matching processes
      execSync(`taskkill /F /IM node.exe /FI "WINDOWTITLE eq *${pattern}*" 2>nul`, { stdio: 'ignore' });
    } else {
      execSync(`pkill -f "${pattern}" 2>/dev/null || true`, { stdio: 'ignore' });
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Kill Claude-related processes
 */
function killClaudeProcesses() {
  try {
    if (isWindows) {
      // On Windows, we can't easily filter by command line args
      // Best effort: kill specific window titles or rely on process.kill()
      // The main process management is done via node-pty kill()
      return true;
    } else {
      execSync('pkill -f "claude.*mcp-config.*telegram" 2>/dev/null || true', { stdio: 'ignore' });
      execSync('pkill -f "telegram-bridge.js" 2>/dev/null || true', { stdio: 'ignore' });
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Get process status info
 */
function getProcessStatus() {
  try {
    if (isWindows) {
      // On Windows, checking for specific processes is harder
      // Return basic info
      return { count: 0, details: 'Windows process checking not available' };
    } else {
      const ps = execSync('ps aux | grep -E "claude|telegram-bridge" | grep -v grep | wc -l', { encoding: 'utf8' }).trim();
      const procs = execSync('ps aux | grep -E "claude.*mcp-config" | grep -v grep | head -3', { encoding: 'utf8' }).trim();
      return { count: parseInt(ps) || 0, details: procs || 'none' };
    }
  } catch (e) {
    return { count: 0, details: 'error checking' };
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute command with cross-platform shell
 */
function execCommand(command, options = {}) {
  const execOptions = {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  };

  if (isWindows) {
    execOptions.shell = true;
  }

  return execSync(command, execOptions);
}

/**
 * Spawn a process cross-platform
 */
function spawnProcess(command, args = [], options = {}) {
  const spawnOptions = {
    stdio: 'inherit',
    ...options
  };

  if (isWindows) {
    spawnOptions.shell = true;
  }

  return spawn(command, args, spawnOptions);
}

/**
 * Install npm package globally
 */
function npmInstallGlobal(packageName) {
  try {
    const cmd = `npm install -g ${packageName}`;
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Install npm packages locally
 */
function npmInstall() {
  try {
    execSync('npm install', { stdio: 'inherit' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if dependencies are installed
 */
function areDependenciesInstalled(projectDir) {
  const nodeModulesPath = path.join(projectDir, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return false;
  }

  // Check for key dependencies
  const requiredDeps = ['node-telegram-bot-api', 'node-pty'];
  for (const dep of requiredDeps) {
    if (!fs.existsSync(path.join(nodeModulesPath, dep))) {
      return false;
    }
  }

  return true;
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

module.exports = {
  isWindows,
  getHomeDir,
  getTempDir,
  getOutputFile,
  getDiscordOutputFile,
  getShell,
  getWhichCommand,
  clearScreen,
  setupShutdownHandlers,
  normalizePath,
  joinPaths,
  commandExists,
  getCommandPath,
  getCommandVersion,
  killProcessesByPattern,
  killClaudeProcesses,
  getProcessStatus,
  sleep,
  execCommand,
  spawnProcess,
  npmInstallGlobal,
  npmInstall,
  areDependenciesInstalled,
  ensureDir
};
