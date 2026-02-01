/**
 * Docker ColorHat Bridge
 *
 * Runs all security tools in isolated Docker containers.
 * NEVER runs security tools on the host system.
 *
 * Security features:
 * - All commands run in disposable containers
 * - Non-root execution inside containers
 * - Network isolation by default
 * - Full audit logging
 * - Resource limits enforced
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Import security modules
let ipTrace, defensiveSecurity;
try {
  ipTrace = require('./ip_traceability');
  defensiveSecurity = require('./defensive_security');
} catch (e) {
  // Modules may not exist yet
  ipTrace = null;
  defensiveSecurity = null;
}

// Paths
const DOCKER_DIR = path.join(__dirname, '..', 'docker');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const WORKSPACE_DIR = path.join(DOCKER_DIR, 'workspace');
const BINARIES_DIR = path.join(DOCKER_DIR, 'binaries');

// Ensure directories exist
[LOGS_DIR, WORKSPACE_DIR, BINARIES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Container image name
const COLORHAT_IMAGE = 'teleclaude/colorhat:latest';
const CONTAINER_NAME = 'colorhat-security';

/**
 * Check if Docker is available
 * @returns {boolean}
 */
function isDockerAvailable() {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if Docker daemon is running
 * @returns {boolean}
 */
function isDockerRunning() {
  try {
    execSync('docker ps', { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if ColorHat image exists
 * @returns {boolean}
 */
function isImageBuilt() {
  try {
    const result = execSync(`docker images -q ${COLORHAT_IMAGE}`, { encoding: 'utf-8' });
    return result.trim().length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Build the ColorHat Docker image
 * @returns {Promise<boolean>}
 */
async function buildImage() {
  return new Promise((resolve, reject) => {
    console.log('Building ColorHat Docker image...');

    const build = spawn('docker', [
      'build',
      '-t', COLORHAT_IMAGE,
      '-f', path.join(DOCKER_DIR, 'Dockerfile.colorhat'),
      DOCKER_DIR
    ], { stdio: 'inherit' });

    build.on('close', (code) => {
      if (code === 0) {
        console.log('ColorHat image built successfully');
        resolve(true);
      } else {
        reject(new Error(`Build failed with code ${code}`));
      }
    });
  });
}

/**
 * Run a command in the ColorHat container
 * @param {string} command - Command to run
 * @param {Object} options - Execution options
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function runInContainer(command, options = {}) {
  const {
    timeout = 300000,  // 5 minute default
    allowNetwork = false,
    mountWorkspace = true,
    interactive = false
  } = options;

  // Validate Docker is available
  if (!isDockerAvailable()) {
    throw new Error('Docker is not installed. Run ADMIN_SETUP.ps1 to install Docker Desktop.');
  }

  if (!isDockerRunning()) {
    throw new Error('Docker daemon is not running. Start Docker Desktop.');
  }

  // Build image if needed
  if (!isImageBuilt()) {
    await buildImage();
  }

  // Log the command
  const logEntry = {
    timestamp: new Date().toISOString(),
    command,
    options: { allowNetwork, timeout }
  };

  const logFile = path.join(LOGS_DIR, 'docker_colorhat.log');
  fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

  // Build docker run command
  const dockerArgs = [
    'run',
    '--rm',  // Remove container after execution
    '--security-opt', 'no-new-privileges:true',
    '--cap-drop', 'ALL',
    '--cap-add', 'NET_RAW',  // For nmap
    '--memory', '2g',
    '--cpus', '2',
    '--user', 'colorhat',
  ];

  // Network isolation
  if (!allowNetwork) {
    dockerArgs.push('--network', 'none');
  }

  // Mount workspace
  if (mountWorkspace) {
    dockerArgs.push('-v', `${WORKSPACE_DIR}:/home/colorhat/workspace:rw`);
  }

  // Mount binaries for analysis (read-only)
  dockerArgs.push('-v', `${BINARIES_DIR}:/home/colorhat/binaries:ro`);

  // Add image and command
  dockerArgs.push(COLORHAT_IMAGE);
  dockerArgs.push('sh', '-c', command);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('docker', dockerArgs, {
      timeout
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Log result
      const resultLog = {
        timestamp: new Date().toISOString(),
        command,
        exitCode: code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length
      };
      fs.appendFileSync(logFile, JSON.stringify(resultLog) + '\n');

      resolve({
        stdout,
        stderr,
        exitCode: code || 0
      });
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Handle timeout
    setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
  });
}

/**
 * Run nmap scan in container
 * @param {string} target - Target to scan
 * @param {Object} options - Scan options
 * @returns {Promise<Object>}
 */
async function nmapScan(target, options = {}) {
  const {
    ports = '1-1000',
    scanType = 'tcp',  // tcp, udp, service, quick
    verbose = false
  } = options;

  // Log IP traceability
  if (ipTrace) {
    ipTrace.logColorHatTarget(target, 'nmap', `${scanType} scan on ports ${ports}`);
  }

  let nmapFlags = ['-oX', '-'];  // XML output to stdout

  switch (scanType) {
    case 'tcp':
      nmapFlags.push('-sT');
      break;
    case 'udp':
      nmapFlags.push('-sU');
      break;
    case 'service':
      nmapFlags.push('-sV');
      break;
    case 'quick':
      nmapFlags.push('-T4', '-F');
      break;
  }

  if (verbose) {
    nmapFlags.push('-v');
  }

  nmapFlags.push('-p', ports);
  nmapFlags.push(target);

  const command = `nmap ${nmapFlags.join(' ')}`;

  const result = await runInContainer(command, { allowNetwork: true });

  // Log completion
  if (defensiveSecurity) {
    defensiveSecurity.logSecurityEvent('colorhat', `nmap scan completed on ${target}`, {
      scanType,
      ports,
      exitCode: result.exitCode
    });
  }

  return {
    success: result.exitCode === 0,
    output: result.stdout,
    errors: result.stderr,
    command,
    target,
    traced: true
  };
}

/**
 * Run nikto web vulnerability scan in container
 * @param {string} target - Target URL
 * @param {Object} options - Scan options
 * @returns {Promise<Object>}
 */
async function niktoScan(target, options = {}) {
  const { port = 80 } = options;

  const command = `nikto -h ${target} -p ${port} -Format txt`;

  const result = await runInContainer(command, {
    allowNetwork: true,
    timeout: 600000  // 10 minutes for web scans
  });

  return {
    success: result.exitCode === 0,
    output: result.stdout,
    errors: result.stderr,
    command
  };
}

/**
 * Run gobuster directory enumeration in container
 * @param {string} target - Target URL
 * @param {string} wordlist - Path to wordlist (inside container)
 * @returns {Promise<Object>}
 */
async function gobusterScan(target, wordlist = '/usr/share/wordlists/dirb/common.txt') {
  const command = `gobuster dir -u ${target} -w ${wordlist} -q`;

  const result = await runInContainer(command, {
    allowNetwork: true,
    timeout: 600000
  });

  return {
    success: result.exitCode === 0,
    output: result.stdout,
    errors: result.stderr,
    command
  };
}

/**
 * Analyze binary with Ghidra in container
 * @param {string} binaryPath - Path to binary (will be copied to container)
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>}
 */
async function analyzeWithGhidra(binaryPath, options = {}) {
  const { decompile = true } = options;

  // Copy binary to binaries directory
  const binaryName = path.basename(binaryPath);
  const containerBinaryPath = `/home/colorhat/binaries/${binaryName}`;

  if (fs.existsSync(binaryPath)) {
    fs.copyFileSync(binaryPath, path.join(BINARIES_DIR, binaryName));
  }

  // Ghidra headless analysis
  const command = `analyzeHeadless /tmp/ghidra_project analysis -import ${containerBinaryPath} -postScript /dev/null -scriptlog /dev/stdout`;

  const result = await runInContainer(command, {
    allowNetwork: false,
    timeout: 900000  // 15 minutes for analysis
  });

  return {
    success: result.exitCode === 0,
    output: result.stdout,
    errors: result.stderr,
    command
  };
}

/**
 * Extract strings from binary in container
 * @param {string} binaryPath - Path to binary
 * @param {number} minLength - Minimum string length
 * @returns {Promise<Object>}
 */
async function extractStrings(binaryPath, minLength = 4) {
  const binaryName = path.basename(binaryPath);

  // Copy binary to binaries directory
  if (fs.existsSync(binaryPath)) {
    fs.copyFileSync(binaryPath, path.join(BINARIES_DIR, binaryName));
  }

  const command = `strings -n ${minLength} /home/colorhat/binaries/${binaryName}`;

  const result = await runInContainer(command, { allowNetwork: false });

  return {
    success: result.exitCode === 0,
    strings: result.stdout.split('\n').filter(s => s.trim()),
    errors: result.stderr
  };
}

/**
 * Get ColorHat status
 * @returns {Object}
 */
function getStatus() {
  return {
    dockerInstalled: isDockerAvailable(),
    dockerRunning: isDockerRunning(),
    imageBuilt: isImageBuilt(),
    workspaceDir: WORKSPACE_DIR,
    binariesDir: BINARIES_DIR,
    logsDir: LOGS_DIR,
    ready: isDockerAvailable() && isDockerRunning() && isImageBuilt()
  };
}

/**
 * Initialize ColorHat (build image if needed)
 * @returns {Promise<boolean>}
 */
async function initialize() {
  if (!isDockerAvailable()) {
    throw new Error('Docker is not installed');
  }

  if (!isDockerRunning()) {
    throw new Error('Docker daemon is not running');
  }

  if (!isImageBuilt()) {
    await buildImage();
  }

  return true;
}

module.exports = {
  isDockerAvailable,
  isDockerRunning,
  isImageBuilt,
  buildImage,
  runInContainer,
  nmapScan,
  niktoScan,
  gobusterScan,
  analyzeWithGhidra,
  extractStrings,
  getStatus,
  initialize,
  WORKSPACE_DIR,
  BINARIES_DIR,
  LOGS_DIR
};
