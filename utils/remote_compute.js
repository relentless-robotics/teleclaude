/**
 * Remote Compute Management Module
 *
 * Provides SSH-based remote command execution, monitoring, and task dispatch
 * for managing compute resources across multiple servers.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'remote_servers.json');
const SSH_KEY_DIR = path.join(__dirname, '..', 'config', 'ssh_keys');
const LOGS_DIR = path.join(__dirname, '..', 'logs', 'remote_compute');

// Ensure directories exist
[path.dirname(CONFIG_FILE), SSH_KEY_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Default server configuration
// Load password from vault at runtime
function getDefaultConfig() {
    const { getInternal } = require('../security/vault');

    return {
        servers: {
            'jupiter-desktop': {
                host: '100.71.253.30',
                user: 'jupiter-desktop',
                password: getInternal('JUPITER_DESKTOP_SSH_PASSWORD'),
                description: 'Dell PowerEdge R630XL - Ubuntu Server',
                capabilities: ['cpu', 'ram', 'docker'],
                tailscale: true
            }
        },
        defaultTimeout: 30000,
        sshOptions: ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null']
    };
}

const DEFAULT_CONFIG = getDefaultConfig();

// Load or initialize config
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Execute SSH command on remote server
 */
function sshExec(serverName, command, options = {}) {
    const config = loadConfig();
    const server = config.servers[serverName];

    if (!server) {
        throw new Error(`Unknown server: ${serverName}. Available: ${Object.keys(config.servers).join(', ')}`);
    }

    const { timeout = config.defaultTimeout, sudo = false, background = false } = options;

    // Build SSH command
    const sshArgs = [
        ...config.sshOptions,
        '-o', 'ConnectTimeout=10',
        `${server.user}@${server.host}`
    ];

    // Add password via sshpass if no key auth
    let sshCmd = 'ssh';
    let fullArgs = [...sshArgs];

    // For password auth, we'll use sshpass or expect
    // On Windows, we might need to use plink or handle differently
    const isWindows = process.platform === 'win32';

    let remoteCmd = command;
    if (sudo) {
        remoteCmd = `echo '${server.password}' | sudo -S ${command}`;
    }

    if (background) {
        remoteCmd = `nohup ${remoteCmd} > /dev/null 2>&1 &`;
    }

    fullArgs.push(remoteCmd);

    try {
        if (isWindows) {
            // Use plink if available, otherwise try ssh with password via stdin
            const plinkPath = 'C:\\Program Files\\PuTTY\\plink.exe';
            if (fs.existsSync(plinkPath)) {
                const result = execSync(
                    `"${plinkPath}" -batch -pw "${server.password}" ${server.user}@${server.host} "${remoteCmd}"`,
                    { timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                return { success: true, output: result, server: serverName };
            }
            // Fallback to ssh (might prompt for password)
        }

        const result = execSync(`ssh ${fullArgs.join(' ')}`, {
            timeout,
            encoding: 'utf8',
            env: { ...process.env, SSHPASS: server.password }
        });

        return { success: true, output: result, server: serverName };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            stderr: error.stderr?.toString(),
            server: serverName
        };
    }
}

/**
 * Check if server is reachable
 */
function pingServer(serverName) {
    const config = loadConfig();
    const server = config.servers[serverName];

    if (!server) {
        return { reachable: false, error: `Unknown server: ${serverName}` };
    }

    try {
        const isWindows = process.platform === 'win32';
        const pingCmd = isWindows
            ? `ping -n 1 -w 3000 ${server.host}`
            : `ping -c 1 -W 3 ${server.host}`;

        execSync(pingCmd, { encoding: 'utf8', stdio: 'pipe' });
        return { reachable: true, host: server.host };
    } catch (error) {
        return { reachable: false, host: server.host, error: 'Host unreachable' };
    }
}

/**
 * Get system stats from remote server
 */
function getSystemStats(serverName) {
    const commands = {
        cpu: "top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1",
        memory: "free -m | awk 'NR==2{printf \"%.1f%%\\n\", $3*100/$2}'",
        memoryTotal: "free -m | awk 'NR==2{print $2}'",
        memoryUsed: "free -m | awk 'NR==2{print $3}'",
        disk: "df -h / | awk 'NR==2{print $5}'",
        uptime: "uptime -p",
        loadAvg: "cat /proc/loadavg | awk '{print $1, $2, $3}'",
        processes: "ps aux | wc -l"
    };

    const stats = {};
    for (const [key, cmd] of Object.entries(commands)) {
        const result = sshExec(serverName, cmd);
        stats[key] = result.success ? result.output.trim() : 'N/A';
    }

    return stats;
}

/**
 * Get GPU stats (if NVIDIA GPU present)
 */
function getGPUStats(serverName) {
    const result = sshExec(serverName, 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || echo "NO_GPU"');

    if (!result.success || result.output.includes('NO_GPU')) {
        return { hasGPU: false };
    }

    const lines = result.output.trim().split('\n');
    const gpus = lines.map((line, idx) => {
        const [name, utilization, memUsed, memTotal, temp] = line.split(', ');
        return {
            index: idx,
            name: name.trim(),
            utilizationPercent: parseFloat(utilization),
            memoryUsedMB: parseInt(memUsed),
            memoryTotalMB: parseInt(memTotal),
            temperatureC: parseInt(temp)
        };
    });

    return { hasGPU: true, gpus };
}

/**
 * Execute command with sudo privileges
 */
function sudoExec(serverName, command, options = {}) {
    return sshExec(serverName, command, { ...options, sudo: true });
}

/**
 * Install package on remote server
 */
function installPackage(serverName, packageName) {
    return sudoExec(serverName, `apt-get update && apt-get install -y ${packageName}`);
}

/**
 * Start a background task on remote server
 */
function startRemoteTask(serverName, command, taskName) {
    const timestamp = Date.now();
    const logFile = `/tmp/task_${taskName}_${timestamp}.log`;

    const wrappedCmd = `nohup bash -c '${command}' > ${logFile} 2>&1 & echo $!`;
    const result = sshExec(serverName, wrappedCmd);

    if (result.success) {
        const pid = result.output.trim();
        const taskInfo = {
            taskName,
            pid,
            logFile,
            startTime: new Date().toISOString(),
            server: serverName,
            command
        };

        // Save task info locally
        const tasksFile = path.join(LOGS_DIR, 'active_tasks.json');
        const tasks = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile)) : {};
        tasks[`${serverName}_${pid}`] = taskInfo;
        fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

        return { success: true, ...taskInfo };
    }

    return result;
}

/**
 * Check status of remote task
 */
function checkRemoteTask(serverName, pid) {
    const checkCmd = `ps -p ${pid} -o pid,stat,etime,cmd --no-headers 2>/dev/null || echo "NOT_RUNNING"`;
    const result = sshExec(serverName, checkCmd);

    if (!result.success) return { running: false, error: result.error };

    if (result.output.includes('NOT_RUNNING')) {
        return { running: false, status: 'completed_or_failed' };
    }

    const parts = result.output.trim().split(/\s+/);
    return {
        running: true,
        pid: parts[0],
        status: parts[1],
        elapsed: parts[2],
        command: parts.slice(3).join(' ')
    };
}

/**
 * Get logs from remote task
 */
function getRemoteTaskLogs(serverName, logFile, lines = 50) {
    const result = sshExec(serverName, `tail -n ${lines} ${logFile} 2>/dev/null || echo "LOG_NOT_FOUND"`);

    if (result.success && !result.output.includes('LOG_NOT_FOUND')) {
        return { success: true, logs: result.output };
    }

    return { success: false, error: 'Log file not found' };
}

/**
 * Kill remote task
 */
function killRemoteTask(serverName, pid) {
    return sshExec(serverName, `kill ${pid} 2>/dev/null && echo "KILLED" || echo "NOT_FOUND"`);
}

/**
 * Transfer file to remote server
 */
function uploadFile(serverName, localPath, remotePath) {
    const config = loadConfig();
    const server = config.servers[serverName];

    try {
        const isWindows = process.platform === 'win32';
        const scpCmd = isWindows
            ? `pscp -pw "${server.password}" "${localPath}" ${server.user}@${server.host}:${remotePath}`
            : `sshpass -p "${server.password}" scp ${config.sshOptions.join(' ')} "${localPath}" ${server.user}@${server.host}:${remotePath}`;

        execSync(scpCmd, { encoding: 'utf8', stdio: 'pipe' });
        return { success: true, remotePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Download file from remote server
 */
function downloadFile(serverName, remotePath, localPath) {
    const config = loadConfig();
    const server = config.servers[serverName];

    try {
        const isWindows = process.platform === 'win32';
        const scpCmd = isWindows
            ? `pscp -pw "${server.password}" ${server.user}@${server.host}:${remotePath} "${localPath}"`
            : `sshpass -p "${server.password}" scp ${config.sshOptions.join(' ')} ${server.user}@${server.host}:${remotePath} "${localPath}"`;

        execSync(scpCmd, { encoding: 'utf8', stdio: 'pipe' });
        return { success: true, localPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Setup SSH key authentication (more secure than password)
 */
function setupSSHKey(serverName) {
    const config = loadConfig();
    const server = config.servers[serverName];
    const keyPath = path.join(SSH_KEY_DIR, `${serverName}_rsa`);

    // Generate key if doesn't exist
    if (!fs.existsSync(keyPath)) {
        try {
            execSync(`ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N "" -C "teleclaude@${serverName}"`, {
                encoding: 'utf8',
                stdio: 'pipe'
            });
        } catch (error) {
            return { success: false, error: `Key generation failed: ${error.message}` };
        }
    }

    // Copy public key to server
    const pubKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
    const copyCmd = `mkdir -p ~/.ssh && echo "${pubKey}" >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;

    const result = sshExec(serverName, copyCmd);
    if (result.success) {
        // Update config to use key
        config.servers[serverName].keyFile = keyPath;
        saveConfig(config);
        return { success: true, keyPath, message: 'SSH key setup complete' };
    }

    return { success: false, error: result.error };
}

/**
 * Add a new server to configuration
 */
function addServer(name, host, user, password, options = {}) {
    const config = loadConfig();
    config.servers[name] = {
        host,
        user,
        password,
        description: options.description || '',
        capabilities: options.capabilities || ['cpu', 'ram'],
        tailscale: options.tailscale || false,
        ...options
    };
    saveConfig(config);
    return { success: true, server: name };
}

/**
 * List all configured servers with status
 */
async function listServers() {
    const config = loadConfig();
    const servers = [];

    for (const [name, server] of Object.entries(config.servers)) {
        const pingResult = pingServer(name);
        servers.push({
            name,
            host: server.host,
            user: server.user,
            description: server.description,
            capabilities: server.capabilities,
            reachable: pingResult.reachable
        });
    }

    return servers;
}

/**
 * Setup Python environment on remote server
 */
function setupPythonEnv(serverName, projectPath, requirements = 'requirements.txt') {
    const commands = [
        `cd ${projectPath}`,
        'python3 -m venv venv',
        'source venv/bin/activate',
        `pip install -r ${requirements}`
    ];

    return sshExec(serverName, commands.join(' && '));
}

/**
 * Clone git repo on remote server
 */
function cloneRepo(serverName, repoUrl, targetPath) {
    return sshExec(serverName, `git clone ${repoUrl} ${targetPath}`);
}

/**
 * Start training job on remote server
 */
function startTrainingJob(serverName, projectPath, script, args = []) {
    const taskName = `training_${path.basename(script, '.py')}`;
    const command = `cd ${projectPath} && source venv/bin/activate && python ${script} ${args.join(' ')}`;
    return startRemoteTask(serverName, command, taskName);
}

// Export all functions
module.exports = {
    // Core SSH
    sshExec,
    sudoExec,
    pingServer,

    // System monitoring
    getSystemStats,
    getGPUStats,

    // Task management
    startRemoteTask,
    checkRemoteTask,
    getRemoteTaskLogs,
    killRemoteTask,

    // File transfer
    uploadFile,
    downloadFile,

    // Server management
    addServer,
    listServers,
    loadConfig,
    saveConfig,

    // Setup utilities
    setupSSHKey,
    setupPythonEnv,
    cloneRepo,
    installPackage,

    // Training specific
    startTrainingJob
};

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'list':
            listServers().then(servers => {
                console.log('Configured Servers:');
                servers.forEach(s => {
                    const status = s.reachable ? '✓ ONLINE' : '✗ OFFLINE';
                    console.log(`  ${s.name}: ${s.host} [${status}]`);
                    console.log(`    User: ${s.user}, Capabilities: ${s.capabilities.join(', ')}`);
                });
            });
            break;

        case 'ping':
            const server = args[1] || 'jupiter-desktop';
            const result = pingServer(server);
            console.log(`${server}: ${result.reachable ? 'REACHABLE' : 'UNREACHABLE'}`);
            break;

        case 'stats':
            const statsServer = args[1] || 'jupiter-desktop';
            const stats = getSystemStats(statsServer);
            console.log(`System Stats for ${statsServer}:`);
            console.log(JSON.stringify(stats, null, 2));
            break;

        case 'exec':
            const execServer = args[1];
            const execCmd = args.slice(2).join(' ');
            if (!execServer || !execCmd) {
                console.log('Usage: node remote_compute.js exec <server> <command>');
                process.exit(1);
            }
            const execResult = sshExec(execServer, execCmd);
            console.log(execResult.success ? execResult.output : `Error: ${execResult.error}`);
            break;

        default:
            console.log('Remote Compute Manager');
            console.log('Usage:');
            console.log('  node remote_compute.js list          - List all servers');
            console.log('  node remote_compute.js ping <server> - Check server connectivity');
            console.log('  node remote_compute.js stats <server> - Get system stats');
            console.log('  node remote_compute.js exec <server> <cmd> - Execute command');
    }
}
