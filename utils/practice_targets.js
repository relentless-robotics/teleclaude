/**
 * Practice Targets Manager
 * Manage local vulnerable environments for pentesting practice
 *
 * Usage:
 *   const { startTargets, listTargets } = require('./utils/practice_targets');
 *   await startTargets(['dvwa', 'juice-shop']);
 */

const { execSync, spawn } = require('child_process');
const path = require('path');

const DOCKER_COMPOSE_PATH = path.join(__dirname, '..', 'docker', 'practice-targets', 'docker-compose.yml');

// Available practice targets with descriptions
const TARGETS = {
  'dvwa': {
    name: 'DVWA',
    fullName: 'Damn Vulnerable Web Application',
    port: 8081,
    url: 'http://localhost:8081',
    credentials: 'admin / password (then setup database)',
    description: 'Classic web vulnerabilities: SQLi, XSS, CSRF, File Upload, Command Injection',
    difficulty: 'Beginner',
    services: ['dvwa', 'dvwa-db']
  },
  'juice-shop': {
    name: 'Juice Shop',
    fullName: 'OWASP Juice Shop',
    port: 3000,
    url: 'http://localhost:3000',
    credentials: 'Register your own account',
    description: 'Modern web app with 100+ challenges. Gamified with scoreboard.',
    difficulty: 'Beginner to Advanced',
    services: ['juice-shop']
  },
  'webgoat': {
    name: 'WebGoat',
    fullName: 'OWASP WebGoat',
    port: 8080,
    url: 'http://localhost:8080/WebGoat',
    credentials: 'Register your own account',
    description: 'Guided lessons on web security vulnerabilities',
    difficulty: 'Beginner',
    services: ['webgoat']
  },
  'bwapp': {
    name: 'bWAPP',
    fullName: 'Buggy Web Application',
    port: 8082,
    url: 'http://localhost:8082',
    credentials: 'bee / bug',
    description: 'Over 100 web vulnerabilities including OWASP Top 10',
    difficulty: 'Beginner to Intermediate',
    services: ['bwapp']
  },
  'mutillidae': {
    name: 'Mutillidae',
    fullName: 'OWASP Mutillidae II',
    port: 8083,
    url: 'http://localhost:8083/mutillidae',
    credentials: 'Various test accounts',
    description: 'OWASP Top 10 and more with hints system',
    difficulty: 'Beginner to Intermediate',
    services: ['mutillidae']
  },
  'nodegoat': {
    name: 'NodeGoat',
    fullName: 'OWASP NodeGoat',
    port: 4000,
    url: 'http://localhost:4000',
    credentials: 'Register your own account',
    description: 'Vulnerable Node.js application',
    difficulty: 'Intermediate',
    services: ['nodegoat']
  },
  'wordpress': {
    name: 'Vuln WordPress',
    fullName: 'Vulnerable WordPress 4.6',
    port: 8084,
    url: 'http://localhost:8084',
    credentials: 'Setup during install',
    description: 'Old WordPress version with known vulnerabilities',
    difficulty: 'Intermediate',
    services: ['vuln-wordpress', 'vuln-wp-db']
  },
  'crapi': {
    name: 'crAPI',
    fullName: 'Completely Ridiculous API',
    port: 8888,
    url: 'http://localhost:8888',
    credentials: 'Register your own account',
    description: 'Vulnerable API for API security testing',
    difficulty: 'Intermediate to Advanced',
    services: ['crapi-web', 'crapi-api', 'crapi-db']
  },
  'ssh': {
    name: 'Vuln SSH',
    fullName: 'Vulnerable SSH Server',
    port: 2222,
    url: 'ssh://localhost:2222',
    credentials: 'root / root',
    description: 'Basic SSH target for brute force practice',
    difficulty: 'Beginner',
    services: ['vuln-ssh']
  }
};

/**
 * Get WSL path for docker-compose file
 */
function getWSLPath() {
  const winPath = DOCKER_COMPOSE_PATH.replace(/\\/g, '/');
  return `/mnt/c${winPath.substring(2)}`;
}

/**
 * Start specific practice targets
 * @param {Array|string} targets - Target names or 'all'
 */
async function startTargets(targets = 'all') {
  const wslPath = getWSLPath();

  if (targets === 'all') {
    console.log('[*] Starting ALL practice targets...');
    console.log('[!] WARNING: This will use significant resources');

    execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" up -d`, {
      stdio: 'inherit'
    });
  } else {
    const targetList = Array.isArray(targets) ? targets : [targets];
    const services = [];

    for (const target of targetList) {
      if (TARGETS[target]) {
        services.push(...TARGETS[target].services);
        console.log(`[*] Starting ${TARGETS[target].fullName}...`);
      } else {
        console.log(`[!] Unknown target: ${target}`);
      }
    }

    if (services.length > 0) {
      const serviceStr = services.join(' ');
      execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" up -d ${serviceStr}`, {
        stdio: 'inherit'
      });
    }
  }

  console.log('\n[+] Targets started! Access URLs:');
  listRunningTargets();
}

/**
 * Stop practice targets
 * @param {Array|string} targets - Target names or 'all'
 */
async function stopTargets(targets = 'all') {
  const wslPath = getWSLPath();

  if (targets === 'all') {
    console.log('[*] Stopping all practice targets...');
    execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" down`, {
      stdio: 'inherit'
    });
  } else {
    const targetList = Array.isArray(targets) ? targets : [targets];
    const services = [];

    for (const target of targetList) {
      if (TARGETS[target]) {
        services.push(...TARGETS[target].services);
      }
    }

    if (services.length > 0) {
      const serviceStr = services.join(' ');
      execSync(`wsl -d kali-linux -u teleclaude -- docker-compose -f "${wslPath}" stop ${serviceStr}`, {
        stdio: 'inherit'
      });
    }
  }
}

/**
 * List all available targets
 */
function listTargets() {
  console.log('\n=== Available Practice Targets ===\n');

  for (const [key, target] of Object.entries(TARGETS)) {
    console.log(`${key.padEnd(12)} - ${target.fullName}`);
    console.log(`${''.padEnd(12)}   Port: ${target.port} | Difficulty: ${target.difficulty}`);
    console.log(`${''.padEnd(12)}   ${target.description}`);
    console.log('');
  }
}

/**
 * List currently running targets with URLs
 */
function listRunningTargets() {
  try {
    const result = execSync('wsl -d kali-linux -u teleclaude -- docker ps --format "{{.Names}}"', {
      encoding: 'utf-8'
    });

    const running = result.trim().split('\n').filter(n => n);

    console.log('\n=== Running Targets ===\n');

    for (const [key, target] of Object.entries(TARGETS)) {
      const isRunning = target.services.some(s => running.includes(s));

      if (isRunning) {
        console.log(`[RUNNING] ${target.name}`);
        console.log(`          URL: ${target.url}`);
        console.log(`          Credentials: ${target.credentials}`);
        console.log('');
      }
    }
  } catch (error) {
    console.log('Could not get running containers');
  }
}

/**
 * Get target info
 * @param {string} target - Target name
 */
function getTargetInfo(target) {
  return TARGETS[target] || null;
}

/**
 * Print challenge suggestions for a target
 * @param {string} target - Target name
 */
function printChallenges(target) {
  const challenges = {
    'dvwa': [
      '1. Set security level to "Low" first',
      '2. SQL Injection - Extract database info',
      '3. XSS (Reflected) - Pop an alert box',
      '4. XSS (Stored) - Persistent XSS in guestbook',
      '5. Command Injection - Execute system commands',
      '6. File Upload - Upload a PHP shell',
      '7. CSRF - Change admin password',
      '8. Brute Force - Crack the login',
      '9. Increase security level and repeat!'
    ],
    'juice-shop': [
      '1. Find the hidden scoreboard',
      '2. Log in as admin without password',
      '3. Access another user\'s basket',
      '4. Find the confidential document',
      '5. Perform DOM XSS attack',
      '6. Forge a coupon code',
      '7. Access the administration section',
      '8. Retrieve the photo of Bjoern\'s cat',
      '9. Check scoreboard for 100+ more challenges!'
    ],
    'webgoat': [
      '1. Complete the Introduction lessons',
      '2. General - HTTP Basics',
      '3. Injection Flaws - SQL Injection',
      '4. Authentication Flaws',
      '5. Cross-Site Scripting',
      '6. Access Control Flaws',
      '7. AJAX Security',
      '8. Cryptography',
      '9. Follow the guided lessons!'
    ]
  };

  if (challenges[target]) {
    console.log(`\n=== ${TARGETS[target].fullName} Challenges ===\n`);
    challenges[target].forEach(c => console.log(c));
  } else {
    console.log(`No specific challenges listed for ${target}`);
    console.log('Explore the application and try common attacks!');
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'start':
      const startTarget = args[1] || 'all';
      await startTargets(startTarget);
      break;

    case 'stop':
      const stopTarget = args[1] || 'all';
      await stopTargets(stopTarget);
      break;

    case 'list':
      listTargets();
      break;

    case 'status':
      listRunningTargets();
      break;

    case 'info':
      const infoTarget = args[1];
      if (infoTarget && TARGETS[infoTarget]) {
        const t = TARGETS[infoTarget];
        console.log(`\n${t.fullName}`);
        console.log(`${'='.repeat(t.fullName.length)}`);
        console.log(`URL: ${t.url}`);
        console.log(`Port: ${t.port}`);
        console.log(`Credentials: ${t.credentials}`);
        console.log(`Difficulty: ${t.difficulty}`);
        console.log(`\nDescription: ${t.description}`);
        printChallenges(infoTarget);
      } else {
        console.log('Usage: node practice_targets.js info <target>');
        listTargets();
      }
      break;

    case 'challenges':
      const chalTarget = args[1];
      if (chalTarget) {
        printChallenges(chalTarget);
      } else {
        console.log('Usage: node practice_targets.js challenges <target>');
      }
      break;

    default:
      console.log('Practice Targets Manager');
      console.log('========================');
      console.log('');
      console.log('Commands:');
      console.log('  start [target|all]     - Start practice target(s)');
      console.log('  stop [target|all]      - Stop practice target(s)');
      console.log('  list                   - List all available targets');
      console.log('  status                 - Show running targets');
      console.log('  info <target>          - Show target details');
      console.log('  challenges <target>    - Show suggested challenges');
      console.log('');
      console.log('Examples:');
      console.log('  node practice_targets.js start dvwa');
      console.log('  node practice_targets.js start juice-shop');
      console.log('  node practice_targets.js info dvwa');
      console.log('');
      console.log('WARNING: These are intentionally vulnerable!');
      console.log('Only run on isolated/local networks.');
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  startTargets,
  stopTargets,
  listTargets,
  listRunningTargets,
  getTargetInfo,
  printChallenges,
  TARGETS
};
