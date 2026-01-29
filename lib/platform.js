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
 * Get the output file path (cross-platform)
 */
function getOutputFile() {
  if (isWindows) {
    return path.join(getTempDir(), 'tg-response.txt');
  }
  return '/tmp/tg-response.txt';
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
  commandExists,
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
