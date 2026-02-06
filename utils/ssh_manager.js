/**
 * SSH Manager - Robust SSH connection management using ssh2 library
 *
 * Provides reliable password and key-based SSH authentication,
 * command execution, file transfer, and connection pooling.
 */

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'remote_servers.json');

// Connection pool for reusing SSH connections
const connectionPool = new Map();

/**
 * Load server configuration
 */
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    return { servers: {} };
}

/**
 * Get or create SSH connection to a server
 */
function getConnection(serverName) {
    return new Promise((resolve, reject) => {
        // Check pool first
        if (connectionPool.has(serverName)) {
            const conn = connectionPool.get(serverName);
            if (conn._sock && !conn._sock.destroyed) {
                return resolve(conn);
            }
            // Connection is dead, remove from pool
            connectionPool.delete(serverName);
        }

        const config = loadConfig();
        const server = config.servers[serverName];

        if (!server) {
            return reject(new Error(`Unknown server: ${serverName}`));
        }

        const conn = new Client();

        conn.on('ready', () => {
            console.log(`SSH connection established to ${serverName}`);
            connectionPool.set(serverName, conn);
            resolve(conn);
        });

        conn.on('error', (err) => {
            console.error(`SSH connection error for ${serverName}:`, err.message);
            connectionPool.delete(serverName);
            reject(err);
        });

        conn.on('close', () => {
            console.log(`SSH connection closed for ${serverName}`);
            connectionPool.delete(serverName);
        });

        // Connection options
        const connOptions = {
            host: server.host,
            port: server.port || 22,
            username: server.user,
            readyTimeout: 30000,
            keepaliveInterval: 10000
        };

        // Use key if available, otherwise password
        if (server.keyFile && fs.existsSync(server.keyFile)) {
            connOptions.privateKey = fs.readFileSync(server.keyFile);
        } else if (server.password) {
            connOptions.password = server.password;
        }

        conn.connect(connOptions);
    });
}

/**
 * Execute command on remote server
 */
async function exec(serverName, command, options = {}) {
    const { timeout = 60000, sudo = false, stream = false } = options;

    try {
        const conn = await getConnection(serverName);
        const config = loadConfig();
        const server = config.servers[serverName];

        return new Promise((resolve, reject) => {
            let fullCommand = command;

            // Handle sudo with password
            if (sudo && server.password) {
                fullCommand = `echo '${server.password}' | sudo -S bash -c '${command.replace(/'/g, "'\\''")}'`;
            } else if (sudo) {
                fullCommand = `sudo ${command}`;
            }

            conn.exec(fullCommand, { pty: sudo }, (err, channel) => {
                if (err) return reject(err);

                let stdout = '';
                let stderr = '';

                // Set timeout
                const timeoutId = setTimeout(() => {
                    channel.close();
                    reject(new Error(`Command timed out after ${timeout}ms`));
                }, timeout);

                channel.on('data', (data) => {
                    const str = data.toString();
                    stdout += str;
                    if (stream && options.onData) {
                        options.onData(str);
                    }
                });

                channel.stderr.on('data', (data) => {
                    const str = data.toString();
                    stderr += str;
                    if (stream && options.onError) {
                        options.onError(str);
                    }
                });

                channel.on('close', (code) => {
                    clearTimeout(timeoutId);
                    resolve({
                        success: code === 0,
                        code,
                        stdout: stdout.trim(),
                        stderr: stderr.trim(),
                        server: serverName
                    });
                });
            });
        });
    } catch (error) {
        return {
            success: false,
            error: error.message,
            server: serverName
        };
    }
}

/**
 * Execute multiple commands in sequence
 */
async function execMultiple(serverName, commands, options = {}) {
    const results = [];

    for (const cmd of commands) {
        const result = await exec(serverName, cmd, options);
        results.push({ command: cmd, ...result });

        // Stop on first failure if specified
        if (!result.success && options.stopOnError) {
            break;
        }
    }

    return results;
}

/**
 * Upload file to remote server
 */
async function uploadFile(serverName, localPath, remotePath) {
    try {
        const conn = await getConnection(serverName);

        return new Promise((resolve, reject) => {
            conn.sftp((err, sftp) => {
                if (err) return reject(err);

                const readStream = fs.createReadStream(localPath);
                const writeStream = sftp.createWriteStream(remotePath);

                writeStream.on('close', () => {
                    resolve({
                        success: true,
                        localPath,
                        remotePath,
                        server: serverName
                    });
                });

                writeStream.on('error', (err) => {
                    reject(err);
                });

                readStream.pipe(writeStream);
            });
        });
    } catch (error) {
        return {
            success: false,
            error: error.message,
            server: serverName
        };
    }
}

/**
 * Download file from remote server
 */
async function downloadFile(serverName, remotePath, localPath) {
    try {
        const conn = await getConnection(serverName);

        return new Promise((resolve, reject) => {
            conn.sftp((err, sftp) => {
                if (err) return reject(err);

                sftp.fastGet(remotePath, localPath, (err) => {
                    if (err) return reject(err);
                    resolve({
                        success: true,
                        localPath,
                        remotePath,
                        server: serverName
                    });
                });
            });
        });
    } catch (error) {
        return {
            success: false,
            error: error.message,
            server: serverName
        };
    }
}

/**
 * Get system information from remote server
 */
async function getSystemInfo(serverName) {
    const commands = {
        hostname: 'hostname',
        os: 'cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"',
        kernel: 'uname -r',
        uptime: 'uptime -p',
        cpuModel: "cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2 | xargs",
        cpuCores: 'nproc',
        memoryTotal: "free -m | awk 'NR==2{print $2}'",
        memoryUsed: "free -m | awk 'NR==2{print $3}'",
        diskTotal: "df -h / | awk 'NR==2{print $2}'",
        diskUsed: "df -h / | awk 'NR==2{print $3}'",
        loadAvg: 'cat /proc/loadavg',
        gpuInfo: 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "No GPU"'
    };

    const info = {};

    for (const [key, cmd] of Object.entries(commands)) {
        const result = await exec(serverName, cmd);
        info[key] = result.success ? result.stdout : 'N/A';
    }

    return info;
}

/**
 * Start a background process on remote server
 */
async function startBackground(serverName, command, options = {}) {
    const { name = `task_${Date.now()}`, logFile } = options;

    const log = logFile || `/tmp/${name}.log`;
    const pidFile = `/tmp/${name}.pid`;

    // Start process in background with nohup
    const bgCommand = `nohup bash -c '${command.replace(/'/g, "'\\''")}' > ${log} 2>&1 & echo $! > ${pidFile} && cat ${pidFile}`;

    const result = await exec(serverName, bgCommand);

    if (result.success) {
        const pid = result.stdout.trim();
        return {
            success: true,
            pid,
            name,
            logFile: log,
            pidFile,
            server: serverName
        };
    }

    return result;
}

/**
 * Check if a background process is running
 */
async function checkProcess(serverName, pid) {
    const result = await exec(serverName, `ps -p ${pid} -o pid,stat,etime,args --no-headers 2>/dev/null`);

    if (result.success && result.stdout) {
        const parts = result.stdout.trim().split(/\s+/);
        return {
            running: true,
            pid: parts[0],
            status: parts[1],
            elapsed: parts[2],
            command: parts.slice(3).join(' ')
        };
    }

    return { running: false, pid };
}

/**
 * Get logs from a background process
 */
async function getProcessLogs(serverName, logFile, lines = 50) {
    return exec(serverName, `tail -n ${lines} ${logFile} 2>/dev/null || echo "Log file not found"`);
}

/**
 * Kill a background process
 */
async function killProcess(serverName, pid) {
    return exec(serverName, `kill ${pid} 2>/dev/null && echo "Killed" || echo "Process not found"`);
}

/**
 * Test connection to a server
 */
async function testConnection(serverName) {
    try {
        const conn = await getConnection(serverName);
        const result = await exec(serverName, 'echo "Connection successful"');
        return {
            success: true,
            message: 'Connection successful',
            server: serverName
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            server: serverName
        };
    }
}

/**
 * Close connection to a server
 */
function closeConnection(serverName) {
    if (connectionPool.has(serverName)) {
        const conn = connectionPool.get(serverName);
        conn.end();
        connectionPool.delete(serverName);
        return { success: true, message: `Connection to ${serverName} closed` };
    }
    return { success: false, message: `No active connection to ${serverName}` };
}

/**
 * Close all connections
 */
function closeAllConnections() {
    for (const [name, conn] of connectionPool) {
        conn.end();
    }
    connectionPool.clear();
    return { success: true, message: 'All connections closed' };
}

/**
 * Install packages on remote server (apt-based)
 */
async function installPackages(serverName, packages) {
    const pkgList = Array.isArray(packages) ? packages.join(' ') : packages;
    return exec(serverName, `apt-get update && apt-get install -y ${pkgList}`, { sudo: true, timeout: 300000 });
}

/**
 * Clone git repository on remote server
 */
async function gitClone(serverName, repoUrl, targetPath, options = {}) {
    const { branch } = options;
    let cmd = `git clone ${repoUrl} ${targetPath}`;
    if (branch) cmd += ` -b ${branch}`;
    return exec(serverName, cmd, { timeout: 120000 });
}

/**
 * Setup Python virtual environment
 */
async function setupPythonEnv(serverName, projectPath, requirements = 'requirements.txt') {
    const commands = [
        `cd ${projectPath} && python3 -m venv venv`,
        `cd ${projectPath} && source venv/bin/activate && pip install --upgrade pip`,
        `cd ${projectPath} && source venv/bin/activate && pip install -r ${requirements}`
    ];

    return execMultiple(serverName, commands, { timeout: 300000 });
}

module.exports = {
    // Connection management
    getConnection,
    testConnection,
    closeConnection,
    closeAllConnections,

    // Command execution
    exec,
    execMultiple,

    // File operations
    uploadFile,
    downloadFile,

    // System info
    getSystemInfo,

    // Process management
    startBackground,
    checkProcess,
    getProcessLogs,
    killProcess,

    // Setup utilities
    installPackages,
    gitClone,
    setupPythonEnv,

    // Config
    loadConfig
};

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0];
    const server = args[1] || 'jupiter-desktop';

    (async () => {
        switch (cmd) {
            case 'test':
                console.log(`Testing connection to ${server}...`);
                const testResult = await testConnection(server);
                console.log(testResult);
                break;

            case 'info':
                console.log(`Getting system info for ${server}...`);
                const info = await getSystemInfo(server);
                console.log(JSON.stringify(info, null, 2));
                break;

            case 'exec':
                const command = args.slice(2).join(' ');
                if (!command) {
                    console.log('Usage: node ssh_manager.js exec <server> <command>');
                    break;
                }
                const execResult = await exec(server, command);
                console.log(execResult.success ? execResult.stdout : `Error: ${execResult.error || execResult.stderr}`);
                break;

            default:
                console.log('SSH Manager');
                console.log('Usage:');
                console.log('  node ssh_manager.js test [server]  - Test connection');
                console.log('  node ssh_manager.js info [server]  - Get system info');
                console.log('  node ssh_manager.js exec <server> <command> - Execute command');
        }

        closeAllConnections();
    })();
}
