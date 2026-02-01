/**
 * Cyber Tools MCP Skill
 * Provides cybersecurity tools via WSL2 Kali Linux
 *
 * IMPORTANT: This skill is for WHITE HAT security testing only.
 * Only scan authorized targets. All operations are logged.
 */

const { runInWSL, runTool, isWSLAvailable, isToolInstalled } = require('../utils/wsl_bridge');
const { analyzeBinary, decompileFunction, listFunctions, extractStrings, getBinaryInfo } = require('../utils/ghidra_bridge');
const fs = require('fs').promises;
const path = require('path');

// Load authorized targets configuration
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'cyber_authorized_targets.json');

/**
 * Load configuration with authorized targets
 * @returns {Promise<Object>}
 */
async function loadConfig() {
  try {
    const configData = await fs.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(configData);
  } catch (error) {
    // Return default config if file doesn't exist
    return {
      authorized_targets: ['127.0.0.1', 'localhost', '192.168.*.*'],
      require_confirmation: true,
      logging_enabled: true
    };
  }
}

/**
 * Check if target is authorized
 * @param {string} target - Target IP/hostname
 * @returns {Promise<boolean>}
 */
async function isAuthorizedTarget(target) {
  const config = await loadConfig();

  // Always allow localhost
  if (target === 'localhost' || target === '127.0.0.1') {
    return true;
  }

  // Check against authorized patterns
  for (const pattern of config.authorized_targets) {
    if (pattern.includes('*')) {
      // Wildcard matching
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      if (regex.test(target)) {
        return true;
      }
    } else if (pattern === target) {
      return true;
    }
  }

  return false;
}

/**
 * Log security operation
 * @param {string} operation - Operation name
 * @param {Object} details - Operation details
 */
async function logOperation(operation, details) {
  const logDir = path.join(__dirname, '..', 'logs');
  const logFile = path.join(logDir, 'cyber_tools.log');

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${operation} | ${JSON.stringify(details)}\n`;

  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, logEntry);
  } catch (error) {
    console.error('Failed to log operation:', error.message);
  }
}

// ============================================================================
// NETWORK RECONNAISSANCE
// ============================================================================

/**
 * Perform nmap scan
 * @param {string} target - Target IP/hostname
 * @param {Object} options - Scan options
 * @param {string} options.scanType - 'ping', 'tcp', 'udp', 'service', 'os', 'vuln'
 * @param {string} options.ports - Port specification (e.g., '1-1000', '80,443')
 * @param {boolean} options.verbose - Verbose output
 * @returns {Promise<Object>}
 */
async function nmapScan(target, options = {}) {
  const {
    scanType = 'tcp',
    ports = '1-1000',
    verbose = false
  } = options;

  // Verify target authorization
  const authorized = await isAuthorizedTarget(target);
  if (!authorized) {
    throw new Error(`Target ${target} is not authorized. Add to cyber_authorized_targets.json first.`);
  }

  // Build nmap command
  let nmapArgs = [];

  switch (scanType) {
    case 'ping':
      nmapArgs = ['-sn', target];
      break;
    case 'tcp':
      nmapArgs = ['-sT', '-p', ports, target];
      break;
    case 'udp':
      nmapArgs = ['-sU', '-p', ports, target];
      break;
    case 'service':
      nmapArgs = ['-sV', '-p', ports, target];
      break;
    case 'os':
      nmapArgs = ['-O', target];
      break;
    case 'vuln':
      nmapArgs = ['--script=vuln', '-p', ports, target];
      break;
    default:
      nmapArgs = ['-p', ports, target];
  }

  if (verbose) {
    nmapArgs.push('-v');
  }

  // Log operation
  await logOperation('nmap_scan', { target, scanType, ports });

  // Run nmap
  const result = await runTool('nmap', nmapArgs, { timeout: 300000 });

  return {
    target,
    scanType,
    output: result.stdout,
    success: result.exitCode === 0
  };
}

/**
 * DNS enumeration
 * @param {string} domain - Domain to enumerate
 * @returns {Promise<Object>}
 */
async function dnsEnum(domain) {
  await logOperation('dns_enum', { domain });

  const digResult = await runTool('dig', [domain, 'ANY'], { skipValidation: true });
  const whoisResult = await runTool('whois', [domain], { skipValidation: true });

  return {
    domain,
    dig: digResult.stdout,
    whois: whoisResult.stdout
  };
}

/**
 * Port scan with masscan (fast scanner)
 * @param {string} target - Target IP/range
 * @param {string} ports - Port range (e.g., '1-65535')
 * @param {number} rate - Packets per second (default: 1000)
 * @returns {Promise<Object>}
 */
async function masscanScan(target, ports = '1-1000', rate = 1000) {
  const authorized = await isAuthorizedTarget(target);
  if (!authorized) {
    throw new Error(`Target ${target} is not authorized.`);
  }

  await logOperation('masscan', { target, ports, rate });

  const result = await runTool('masscan', [target, '-p', ports, '--rate', rate.toString()], {
    timeout: 600000
  });

  return {
    target,
    ports,
    output: result.stdout,
    success: result.exitCode === 0
  };
}

// ============================================================================
// WEB SECURITY
// ============================================================================

/**
 * Nikto web vulnerability scanner
 * @param {string} target - Target URL
 * @param {Object} options - Scan options
 * @returns {Promise<Object>}
 */
async function niktoScan(target, options = {}) {
  const { port = 80, ssl = false } = options;

  // Extract hostname for authorization check
  const hostname = new URL(target).hostname;
  const authorized = await isAuthorizedTarget(hostname);
  if (!authorized) {
    throw new Error(`Target ${hostname} is not authorized.`);
  }

  await logOperation('nikto_scan', { target, port, ssl });

  const args = ['-h', target, '-p', port.toString()];
  if (ssl) {
    args.push('-ssl');
  }

  const result = await runTool('nikto', args, { timeout: 600000 });

  return {
    target,
    output: result.stdout,
    success: result.exitCode === 0
  };
}

/**
 * Gobuster directory enumeration
 * @param {string} url - Target URL
 * @param {string} wordlist - Path to wordlist (in WSL)
 * @param {Object} options - Options
 * @returns {Promise<Object>}
 */
async function gobusterDir(url, wordlist = '/usr/share/wordlists/dirb/common.txt', options = {}) {
  const { extensions = '', threads = 10 } = options;

  const hostname = new URL(url).hostname;
  const authorized = await isAuthorizedTarget(hostname);
  if (!authorized) {
    throw new Error(`Target ${hostname} is not authorized.`);
  }

  await logOperation('gobuster_dir', { url, wordlist });

  const args = ['dir', '-u', url, '-w', wordlist, '-t', threads.toString()];
  if (extensions) {
    args.push('-x', extensions);
  }

  const result = await runTool('gobuster', args, { timeout: 600000 });

  return {
    url,
    output: result.stdout,
    success: result.exitCode === 0
  };
}

/**
 * ffuf - Fast web fuzzer
 * @param {string} url - Target URL with FUZZ keyword
 * @param {string} wordlist - Wordlist path
 * @param {Object} options - Options
 * @returns {Promise<Object>}
 */
async function ffuzzer(url, wordlist = '/usr/share/wordlists/dirb/common.txt', options = {}) {
  const { filterCodes = '404', threads = 40 } = options;

  const hostname = new URL(url.replace('FUZZ', 'test')).hostname;
  const authorized = await isAuthorizedTarget(hostname);
  if (!authorized) {
    throw new Error(`Target ${hostname} is not authorized.`);
  }

  await logOperation('ffuf', { url, wordlist });

  const args = ['-u', url, '-w', wordlist, '-fc', filterCodes, '-t', threads.toString()];

  const result = await runTool('ffuf', args, { timeout: 600000 });

  return {
    url,
    output: result.stdout,
    success: result.exitCode === 0
  };
}

// ============================================================================
// REVERSE ENGINEERING
// ============================================================================

/**
 * Analyze binary with Ghidra
 * @param {string} binaryPath - Path to binary file
 * @returns {Promise<Object>}
 */
async function analyzeWithGhidra(binaryPath) {
  await logOperation('ghidra_analyze', { binaryPath });

  const result = await analyzeBinary(binaryPath);
  return result;
}

/**
 * Decompile function from binary
 * @param {string} binaryPath - Path to binary
 * @param {string} functionAddress - Function address or name
 * @returns {Promise<string>}
 */
async function decompile(binaryPath, functionAddress) {
  await logOperation('ghidra_decompile', { binaryPath, functionAddress });

  const code = await decompileFunction(binaryPath, functionAddress);
  return code;
}

/**
 * List functions in binary
 * @param {string} binaryPath - Path to binary
 * @returns {Promise<Array>}
 */
async function listBinaryFunctions(binaryPath) {
  await logOperation('ghidra_list_functions', { binaryPath });

  const functions = await listFunctions(binaryPath);
  return functions;
}

/**
 * Extract strings from binary
 * @param {string} binaryPath - Path to binary
 * @param {number} minLength - Minimum string length
 * @returns {Promise<Array>}
 */
async function binaryStrings(binaryPath, minLength = 4) {
  await logOperation('extract_strings', { binaryPath, minLength });

  const strings = await extractStrings(binaryPath, { minLength });
  return strings;
}

/**
 * Get basic binary information
 * @param {string} binaryPath - Path to binary
 * @returns {Promise<Object>}
 */
async function binaryInfo(binaryPath) {
  await logOperation('binary_info', { binaryPath });

  const info = await getBinaryInfo(binaryPath);
  return info;
}

// ============================================================================
// SYSTEM STATUS
// ============================================================================

/**
 * Check WSL and tools status
 * @returns {Promise<Object>}
 */
async function checkStatus() {
  const wslAvailable = await isWSLAvailable();

  if (!wslAvailable) {
    return {
      wsl: false,
      message: 'WSL not available. Run setup_wsl_kali.ps1'
    };
  }

  const tools = {};
  const toolList = ['nmap', 'nikto', 'gobuster', 'masscan', 'ffuf', 'ghidra'];

  for (const tool of toolList) {
    tools[tool] = await isToolInstalled(tool);
  }

  const config = await loadConfig();

  return {
    wsl: true,
    tools,
    config
  };
}

// ============================================================================
// MCP EXPORTS
// ============================================================================

module.exports = {
  // Network tools
  nmapScan,
  dnsEnum,
  masscanScan,

  // Web security tools
  niktoScan,
  gobusterDir,
  ffuzzer,

  // Reverse engineering tools
  analyzeWithGhidra,
  decompile,
  listBinaryFunctions,
  binaryStrings,
  binaryInfo,

  // Utilities
  checkStatus,
  isAuthorizedTarget,
  loadConfig
};
