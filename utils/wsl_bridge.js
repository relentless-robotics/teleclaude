/**
 * WSL Bridge Module
 * Executes commands in WSL2 from Node.js with safety controls
 *
 * Usage:
 *   const { runInWSL, isWSLAvailable } = require('./utils/wsl_bridge');
 *   const result = await runInWSL('nmap -sV localhost');
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

// Default WSL distribution
const DEFAULT_DISTRO = 'kali-linux';

// Timeout for commands (default 5 minutes)
const DEFAULT_TIMEOUT = 300000;

// Whitelisted security tools - comprehensive pentesting toolkit
const ALLOWED_TOOLS = [
  // === Network Reconnaissance ===
  'nmap',           // Port scanning, service detection, OS fingerprinting
  'masscan',        // Fast port scanner
  'rustscan',       // Fast port scanner with nmap integration
  'zmap',           // Internet-wide scanner
  'unicornscan',    // Async TCP/UDP scanner

  // === DNS & Domain ===
  'dig',            // DNS lookup
  'nslookup',       // DNS query
  'whois',          // Domain registration info
  'host',           // DNS lookup utility
  'dnsrecon',       // DNS enumeration
  'dnsenum',        // DNS enumeration
  'fierce',         // DNS reconnaissance
  'subfinder',      // Subdomain discovery
  'amass',          // Attack surface mapping
  'assetfinder',    // Find domains and subdomains
  'httprobe',       // Probe for working HTTP servers

  // === Web Application Testing ===
  'nikto',          // Web vulnerability scanner
  'gobuster',       // Directory/file brute-forcing
  'dirb',           // Web content scanner
  'dirbuster',      // Directory brute-force
  'ffuf',           // Fast web fuzzer
  'wfuzz',          // Web application fuzzer
  'whatweb',        // Web scanner/fingerprinter
  'wpscan',         // WordPress vulnerability scanner
  'sqlmap',         // SQL injection automation
  'xsser',          // XSS vulnerability scanner
  'commix',         // Command injection exploiter
  'nuclei',         // Vulnerability scanner with templates
  'httpx',          // Fast HTTP toolkit
  'arjun',          // HTTP parameter discovery
  'paramspider',    // Parameter mining

  // === Password Attacks ===
  'hydra',          // Network login cracker
  'medusa',         // Parallel password cracker
  'john',           // John the Ripper
  'hashcat',        // Advanced password recovery
  'hash-identifier', // Identify hash types
  'hashid',         // Identify hash types
  'crunch',         // Wordlist generator
  'cewl',           // Custom wordlist generator
  'cupp',           // Common User Passwords Profiler

  // === Exploitation ===
  'msfconsole',     // Metasploit Framework
  'msfvenom',       // Payload generator
  'searchsploit',   // Exploit database search
  'exploitdb',      // Exploit database

  // === SMB/Windows ===
  'enum4linux',     // SMB enumeration
  'smbclient',      // SMB client
  'smbmap',         // SMB share mapper
  'crackmapexec',   // Swiss army knife for pentesting
  'cme',            // CrackMapExec alias
  'impacket-scripts', // Impacket tools
  'psexec.py',      // Remote execution
  'secretsdump.py', // Dump secrets
  'rpcclient',      // RPC client
  'nbtscan',        // NetBIOS scanner

  // === Wireless ===
  'aircrack-ng',    // WiFi security
  'airmon-ng',      // Monitor mode
  'airodump-ng',    // Packet capture
  'aireplay-ng',    // Packet injection
  'wifite',         // Automated wireless auditing
  'reaver',         // WPS attack
  'bully',          // WPS brute force

  // === Network Utilities ===
  'traceroute',
  'ping',
  'curl',
  'wget',
  'netcat',
  'nc',
  'ncat',
  'socat',          // Multipurpose relay
  'proxychains',    // Proxy chains
  'chisel',         // TCP tunnel
  'ssh',
  'scp',
  'rsync',

  // === Packet Analysis ===
  'tcpdump',
  'wireshark',
  'tshark',
  'ettercap',       // MITM attacks
  'bettercap',      // Swiss army knife
  'arpspoof',       // ARP spoofing
  'dsniff',         // Network auditing

  // === Reverse Engineering ===
  'ghidra',
  'analyzeHeadless',
  'radare2',        // Reverse engineering framework
  'r2',             // Radare2 alias
  'rizin',          // RE framework (radare2 fork)
  'gdb',            // GNU Debugger
  'objdump',
  'readelf',
  'nm',             // Symbol listing
  'ldd',            // Shared library deps
  'strings',
  'file',
  'xxd',            // Hex dump
  'hexdump',
  'binwalk',        // Firmware analysis
  'foremost',       // File carving

  // === Forensics ===
  'volatility',     // Memory forensics
  'autopsy',        // Digital forensics
  'sleuthkit',      // File system forensics
  'exiftool',       // Metadata extraction
  'steghide',       // Steganography
  'stegseek',       // Stego cracker
  'zsteg',          // PNG/BMP stego

  // === OSINT ===
  'theharvester',   // Email/subdomain harvester
  'recon-ng',       // OSINT framework
  'maltego',        // OSINT and forensics
  'spiderfoot',     // OSINT automation
  'sherlock',       // Username hunting
  'holehe',         // Email OSINT

  // === Debugging & Tracing ===
  'strace',
  'ltrace',
  'valgrind',       // Memory debugging

  // === Container & Cloud ===
  'docker',
  'docker-compose',
  'docker-buildx',
  'kubectl',        // Kubernetes
  'awscli',         // AWS CLI
  'az',             // Azure CLI
  'gcloud',         // Google Cloud CLI

  // === Misc Utilities ===
  'python',
  'python3',
  'pip',
  'pip3',
  'ruby',
  'gem',
  'perl',
  'php',
  'node',
  'npm',
  'go',
  'git',
  'make',
  'gcc',
  'g++',
  'base64',
  'openssl',
  'gpg',
  'jq',             // JSON processor
  'yq',             // YAML processor
  'xargs',
  'find',
  'locate',
  'updatedb',
  'tar',
  'gzip',
  'unzip',
  'zip',
  '7z'
];

// Dangerous commands that require explicit approval
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /mkfs/,
  /dd\s+if=/,
  /:(){ :|:& };:/,  // Fork bomb
  /chmod\s+-R\s+777/,
  /chown\s+-R/,
  />\/dev\/sda/,
  /shutdown/,
  /reboot/,
  /halt/
];

/**
 * Check if WSL is available and configured
 * @returns {Promise<boolean>}
 */
async function isWSLAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('wsl', ['--list', '--quiet'], {
      shell: true,
      windowsHide: true
    });

    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && output.includes(DEFAULT_DISTRO)) {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Validate command against whitelist and dangerous patterns
 * @param {string} command - Command to validate
 * @returns {Object} - { valid: boolean, reason: string }
 */
function validateCommand(command) {
  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        valid: false,
        reason: `Command contains dangerous pattern: ${pattern}`
      };
    }
  }

  // Extract the base command (first word)
  const baseCommand = command.trim().split(/\s+/)[0];

  // Check if it's a shell built-in or whitelisted tool
  const shellBuiltins = ['echo', 'cat', 'grep', 'awk', 'sed', 'ls', 'cd', 'pwd'];
  const isAllowed = ALLOWED_TOOLS.includes(baseCommand) || shellBuiltins.includes(baseCommand);

  if (!isAllowed) {
    return {
      valid: false,
      reason: `Command '${baseCommand}' is not in the whitelist. Allowed tools: ${ALLOWED_TOOLS.join(', ')}`
    };
  }

  return { valid: true, reason: 'OK' };
}

/**
 * Execute a command in WSL
 * @param {string} command - Command to execute
 * @param {Object} options - Options
 * @param {string} options.distro - WSL distribution to use
 * @param {number} options.timeout - Timeout in milliseconds
 * @param {boolean} options.skipValidation - Skip command validation (USE WITH CAUTION)
 * @param {string} options.workingDir - Working directory in WSL
 * @returns {Promise<Object>} - { stdout, stderr, exitCode, timedOut }
 */
async function runInWSL(command, options = {}) {
  const {
    distro = DEFAULT_DISTRO,
    timeout = DEFAULT_TIMEOUT,
    skipValidation = false,
    workingDir = null
  } = options;

  // Validate command unless explicitly skipped
  if (!skipValidation) {
    const validation = validateCommand(command);
    if (!validation.valid) {
      throw new Error(`Command validation failed: ${validation.reason}`);
    }
  }

  // Check WSL availability
  const wslReady = await isWSLAvailable();
  if (!wslReady) {
    throw new Error(`WSL distribution '${distro}' is not available. Run setup_wsl_kali.ps1 first.`);
  }

  // Prepare the command
  let fullCommand = command;
  if (workingDir) {
    fullCommand = `cd ${workingDir} && ${command}`;
  }

  // Log the command
  await logCommand(command, options);

  return new Promise((resolve, reject) => {
    const proc = spawn('wsl', ['-d', distro, 'bash', '-c', fullCommand], {
      shell: true,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Set timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');

      // Force kill if still running after 5 seconds
      setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timeoutId);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to execute command: ${error.message}`));
    });
  });
}

/**
 * Log command execution for audit trail
 * @param {string} command - Command executed
 * @param {Object} options - Options used
 */
async function logCommand(command, options) {
  const logDir = path.join(__dirname, '..', 'logs');
  const logFile = path.join(logDir, 'wsl_commands.log');

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${command} | Options: ${JSON.stringify(options)}\n`;

  try {
    // Ensure log directory exists
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, logEntry);
  } catch (error) {
    console.error('Failed to log command:', error.message);
  }
}

/**
 * Run a tool with automatic output handling
 * @param {string} tool - Tool name (e.g., 'nmap', 'nikto')
 * @param {Array<string>} args - Tool arguments
 * @param {Object} options - Options (same as runInWSL)
 * @returns {Promise<Object>}
 */
async function runTool(tool, args = [], options = {}) {
  const command = `${tool} ${args.join(' ')}`;
  return await runInWSL(command, options);
}

/**
 * Check if a specific tool is installed in WSL
 * @param {string} tool - Tool name to check
 * @returns {Promise<boolean>}
 */
async function isToolInstalled(tool) {
  try {
    const result = await runInWSL(`which ${tool}`, { skipValidation: true });
    return result.exitCode === 0 && result.stdout.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get WSL distribution info
 * @returns {Promise<Object>}
 */
async function getWSLInfo() {
  try {
    const result = await runInWSL('uname -a && lsb_release -a', { skipValidation: true });
    return {
      available: true,
      info: result.stdout
    };
  } catch (error) {
    return {
      available: false,
      error: error.message
    };
  }
}

/**
 * Convert Windows path to WSL path
 * @param {string} windowsPath - Windows path
 * @returns {string} - WSL path
 */
function windowsToWSLPath(windowsPath) {
  // C:\Users\Footb\file.txt -> /mnt/c/Users/Footb/file.txt
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(.*)/);

  if (match) {
    const drive = match[1].toLowerCase();
    const pathPart = match[2];
    return `/mnt/${drive}${pathPart}`;
  }

  return normalized;
}

/**
 * Convert WSL path to Windows path
 * @param {string} wslPath - WSL path
 * @returns {string} - Windows path
 */
function wslToWindowsPath(wslPath) {
  // /mnt/c/Users/Footb/file.txt -> C:\Users\Footb\file.txt
  const match = wslPath.match(/^\/mnt\/([a-z])(.*)/);

  if (match) {
    const drive = match[1].toUpperCase();
    const pathPart = match[2].replace(/\//g, '\\');
    return `${drive}:${pathPart}`;
  }

  return wslPath;
}

module.exports = {
  runInWSL,
  runTool,
  isWSLAvailable,
  isToolInstalled,
  getWSLInfo,
  validateCommand,
  windowsToWSLPath,
  wslToWindowsPath,
  ALLOWED_TOOLS,
  DEFAULT_DISTRO
};
