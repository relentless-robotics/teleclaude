/**
 * Docker Security Tools Manager
 * Launch and manage security containers with different anonymity levels
 *
 * Usage:
 *   const { launchContainer, runSecurityTool } = require('./utils/docker_security');
 *   await launchContainer('tor');
 *   const result = await runSecurityTool('nmap', ['-sV', 'target.com'], { anonymity: 'tor' });
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOCKER_DIR = path.join(__dirname, '..', 'docker');
const WORKSPACE_DIR = path.join(DOCKER_DIR, 'workspace');
const OUTPUT_DIR = path.join(DOCKER_DIR, 'output');
const VPN_CONFIGS_DIR = path.join(DOCKER_DIR, 'vpn-configs');

// Anonymity levels
const ANONYMITY_LEVELS = {
  none: {
    container: 'kali-tools',
    description: 'No anonymity - direct connection',
    speed: 'Fast',
    risk: 'Your IP is visible'
  },
  tor: {
    container: 'kali-anon',
    description: 'Traffic routed through Tor network',
    speed: 'Slow',
    risk: 'Exit node can see unencrypted traffic'
  },
  vpn: {
    container: 'kali-vpn',
    description: 'Traffic routed through VPN',
    speed: 'Medium',
    risk: 'VPN provider can log traffic'
  },
  full: {
    container: 'kali-full-anon',
    description: 'VPN + Tor (maximum anonymity)',
    speed: 'Very slow',
    risk: 'Minimal - multi-hop protection'
  }
};

/**
 * Ensure Docker directories exist
 */
function ensureDirectories() {
  [WORKSPACE_DIR, OUTPUT_DIR, VPN_CONFIGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

/**
 * Check if Docker is available
 * @returns {boolean}
 */
function isDockerAvailable() {
  try {
    execSync('wsl -d kali-linux -u teleclaude -- docker --version', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Build Docker images
 * @param {string} imageName - Specific image to build (or 'all')
 * @returns {Promise<Object>}
 */
async function buildImages(imageName = 'all') {
  ensureDirectories();

  const dockerComposePath = path.join(DOCKER_DIR, 'docker-compose.yml').replace(/\\/g, '/');
  const wslPath = `/mnt/c${dockerComposePath.substring(2)}`;

  const results = {};

  if (imageName === 'all' || imageName === 'kali-tools') {
    console.log('Building kali-tools image...');
    try {
      execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" build kali-tools`, {
        stdio: 'inherit',
        cwd: DOCKER_DIR
      });
      results['kali-tools'] = 'success';
    } catch (error) {
      results['kali-tools'] = error.message;
    }
  }

  if (imageName === 'all' || imageName === 'kali-anon') {
    console.log('Building kali-anon image...');
    try {
      execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" build kali-anon`, {
        stdio: 'inherit',
        cwd: DOCKER_DIR
      });
      results['kali-anon'] = 'success';
    } catch (error) {
      results['kali-anon'] = error.message;
    }
  }

  if (imageName === 'all' || imageName === 'vpn-gateway') {
    console.log('Building vpn-gateway image...');
    try {
      execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" build vpn-gateway`, {
        stdio: 'inherit',
        cwd: DOCKER_DIR
      });
      results['vpn-gateway'] = 'success';
    } catch (error) {
      results['vpn-gateway'] = error.message;
    }
  }

  return results;
}

/**
 * Launch a security container
 * @param {string} anonymityLevel - 'none', 'tor', 'vpn', or 'full'
 * @param {Object} options - Additional options
 * @returns {Promise<Object>}
 */
async function launchContainer(anonymityLevel = 'none', options = {}) {
  if (!ANONYMITY_LEVELS[anonymityLevel]) {
    throw new Error(`Invalid anonymity level: ${anonymityLevel}. Choose: ${Object.keys(ANONYMITY_LEVELS).join(', ')}`);
  }

  ensureDirectories();

  const level = ANONYMITY_LEVELS[anonymityLevel];
  const containerName = options.name || level.container;

  console.log(`[*] Launching ${containerName} (${level.description})`);
  console.log(`    Speed: ${level.speed}`);
  console.log(`    Risk: ${level.risk}`);

  const dockerComposePath = path.join(DOCKER_DIR, 'docker-compose.yml').replace(/\\/g, '/');
  const wslPath = `/mnt/c${dockerComposePath.substring(2)}`;

  // Start container
  try {
    execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" up -d ${level.container}`, {
      stdio: 'inherit'
    });

    return {
      success: true,
      container: containerName,
      anonymity: anonymityLevel,
      description: level.description
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Run a security tool in a container
 * @param {string} tool - Tool name (e.g., 'nmap', 'sqlmap')
 * @param {Array} args - Tool arguments
 * @param {Object} options - Options including anonymity level
 * @returns {Promise<Object>}
 */
async function runSecurityTool(tool, args = [], options = {}) {
  const anonymityLevel = options.anonymity || 'none';
  const level = ANONYMITY_LEVELS[anonymityLevel];

  if (!level) {
    throw new Error(`Invalid anonymity level: ${anonymityLevel}`);
  }

  const containerName = level.container;
  const command = `${tool} ${args.join(' ')}`;

  // For Tor anonymity, wrap with proxychains
  let fullCommand = command;
  if (anonymityLevel === 'tor' || anonymityLevel === 'full') {
    fullCommand = `proxychains4 -q ${command}`;
  }

  console.log(`[*] Running: ${tool} (via ${containerName})`);
  console.log(`[*] Anonymity: ${anonymityLevel}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('wsl', [
      '-d', 'kali-linux',
      '-u', 'teleclaude',
      '--',
      'docker', 'exec', containerName,
      'bash', '-c', fullCommand
    ], {
      shell: true
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (options.stream) {
        process.stdout.write(data);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (options.stream) {
        process.stderr.write(data);
      }
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        tool,
        anonymity: anonymityLevel
      });
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Stop all security containers
 * @returns {Promise<void>}
 */
async function stopAllContainers() {
  const dockerComposePath = path.join(DOCKER_DIR, 'docker-compose.yml').replace(/\\/g, '/');
  const wslPath = `/mnt/c${dockerComposePath.substring(2)}`;

  execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" down`, {
    stdio: 'inherit'
  });
}

/**
 * Get current IP for a container
 * @param {string} anonymityLevel - Anonymity level to check
 * @returns {Promise<string>}
 */
async function getCurrentIP(anonymityLevel = 'none') {
  const level = ANONYMITY_LEVELS[anonymityLevel];
  const containerName = level.container;

  let command = 'curl -s ifconfig.me';
  if (anonymityLevel === 'tor' || anonymityLevel === 'full') {
    command = 'curl --socks5-hostname localhost:9050 -s ifconfig.me';
  }

  try {
    const result = execSync(`wsl -d kali-linux -u teleclaude -- docker exec ${containerName} ${command}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Add VPN configuration
 * @param {string} configPath - Path to VPN config file
 * @param {string} type - 'openvpn' or 'wireguard'
 */
function addVPNConfig(configPath, type = 'openvpn') {
  ensureDirectories();

  const destName = type === 'wireguard' ? 'wg0.conf' : 'client.ovpn';
  const destPath = path.join(VPN_CONFIGS_DIR, destName);

  fs.copyFileSync(configPath, destPath);
  console.log(`VPN config copied to ${destPath}`);
}

/**
 * Get status of all containers
 * @returns {Promise<Object>}
 */
async function getStatus() {
  try {
    const result = execSync('wsl -d kali-linux -u teleclaude -- docker ps --format "{{.Names}}: {{.Status}}"', {
      encoding: 'utf-8'
    });

    const containers = {};
    result.trim().split('\n').forEach(line => {
      const [name, status] = line.split(': ');
      if (name && name.startsWith('kali') || name === 'vpn-gateway') {
        containers[name] = status;
      }
    });

    return containers;
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Interactive shell into a container
 * @param {string} anonymityLevel - Anonymity level
 */
function shell(anonymityLevel = 'none') {
  const level = ANONYMITY_LEVELS[anonymityLevel];
  const containerName = level.container;

  console.log(`[*] Opening shell in ${containerName} (${level.description})`);

  spawn('wsl', [
    '-d', 'kali-linux',
    '-u', 'teleclaude',
    '--',
    'docker', 'exec', '-it', containerName, '/bin/bash'
  ], {
    stdio: 'inherit',
    shell: true
  });
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'build':
      console.log('Building Docker images...');
      await buildImages(args[1] || 'all');
      break;

    case 'start':
      const level = args[1] || 'none';
      await launchContainer(level);
      break;

    case 'stop':
      await stopAllContainers();
      break;

    case 'status':
      const status = await getStatus();
      console.log('Container Status:');
      Object.entries(status).forEach(([name, stat]) => {
        console.log(`  ${name}: ${stat}`);
      });
      break;

    case 'shell':
      shell(args[1] || 'none');
      break;

    case 'ip':
      const ip = await getCurrentIP(args[1] || 'none');
      console.log(`Current IP (${args[1] || 'none'}): ${ip}`);
      break;

    case 'run':
      const tool = args[1];
      const toolArgs = args.slice(2);
      const result = await runSecurityTool(tool, toolArgs, { stream: true });
      console.log(`\nExit code: ${result.exitCode}`);
      break;

    default:
      console.log('Docker Security Tools Manager');
      console.log('');
      console.log('Usage:');
      console.log('  node docker_security.js build [image]      - Build Docker images');
      console.log('  node docker_security.js start <level>      - Start container (none/tor/vpn/full)');
      console.log('  node docker_security.js stop               - Stop all containers');
      console.log('  node docker_security.js status             - Show container status');
      console.log('  node docker_security.js shell <level>      - Interactive shell');
      console.log('  node docker_security.js ip <level>         - Check current IP');
      console.log('  node docker_security.js run <tool> [args]  - Run tool in container');
      console.log('');
      console.log('Anonymity Levels:');
      Object.entries(ANONYMITY_LEVELS).forEach(([level, info]) => {
        console.log(`  ${level.padEnd(6)} - ${info.description} (${info.speed})`);
      });
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  buildImages,
  launchContainer,
  runSecurityTool,
  stopAllContainers,
  getCurrentIP,
  addVPNConfig,
  getStatus,
  shell,
  ANONYMITY_LEVELS,
  isDockerAvailable
};
