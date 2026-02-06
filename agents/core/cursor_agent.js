/**
 * Cursor CLI Agent Runner
 *
 * Runs autonomous agents using Cursor CLI with the FREE 'auto' model.
 * This is the backbone of our multi-agent system - $0 cost for workers!
 *
 * Architecture:
 * - Each agent gets its own working directory
 * - Agents read tasks from a queue (JSON files)
 * - Agents write results back to results directory
 * - Orchestrator (Opus) monitors and coordinates
 *
 * Usage:
 *   const { CursorAgent, launchAgent } = require('./cursor_agent');
 *
 *   const agent = await launchAgent({
 *     name: 'trading-agent',
 *     instructions: 'Monitor positions and execute trades...',
 *     workingDir: './agents/trading'
 *   });
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Paths
const AGENTS_DIR = path.join(__dirname, '..');
const TASKS_DIR = path.join(AGENTS_DIR, 'tasks');
const RESULTS_DIR = path.join(AGENTS_DIR, 'results');
const HEARTBEATS_DIR = path.join(AGENTS_DIR, 'heartbeats');
const LOGS_DIR = path.join(AGENTS_DIR, 'logs');

// Ensure directories exist
[TASKS_DIR, RESULTS_DIR, HEARTBEATS_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/**
 * Find Cursor CLI executable
 */
function findCursorCLI() {
    const possiblePaths = [
        // Windows
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'cursor.exe'),
        'C:\\Users\\Footb\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
        // Linux
        '/usr/bin/cursor',
        '/usr/local/bin/cursor',
        path.join(os.homedir(), '.cursor', 'bin', 'cursor'),
        // Via npm
        'cursor'
    ];

    for (const p of possiblePaths) {
        try {
            if (fs.existsSync(p)) {
                return p;
            }
            // Try to execute it
            execSync(`"${p}" --version`, { stdio: 'ignore' });
            return p;
        } catch (e) {
            continue;
        }
    }

    return null;
}

/**
 * CursorAgent class - runs tasks using Cursor CLI
 */
class CursorAgent {
    constructor(options = {}) {
        this.name = options.name || 'agent-' + Date.now();
        this.workingDir = options.workingDir || path.join(AGENTS_DIR, this.name);
        this.instructions = options.instructions || '';
        this.model = 'auto'; // Always use auto (FREE!)
        this.cursorPath = findCursorCLI();
        this.process = null;
        this.status = 'idle';
        this.lastHeartbeat = null;
        this.tasksCompleted = 0;
        this.logFile = path.join(LOGS_DIR, `${this.name}.log`);

        // Ensure working directory exists
        if (!fs.existsSync(this.workingDir)) {
            fs.mkdirSync(this.workingDir, { recursive: true });
        }

        // Write instructions file
        this.instructionsFile = path.join(this.workingDir, 'AGENT_INSTRUCTIONS.md');
        fs.writeFileSync(this.instructionsFile, this.instructions);
    }

    /**
     * Log message to file and console
     */
    log(message) {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${this.name}] ${message}\n`;
        fs.appendFileSync(this.logFile, logLine);
        console.log(logLine.trim());
    }

    /**
     * Write heartbeat file
     */
    writeHeartbeat() {
        const heartbeat = {
            agent: this.name,
            status: this.status,
            lastHeartbeat: new Date().toISOString(),
            tasksCompleted: this.tasksCompleted,
            pid: this.process?.pid || null,
            workingDir: this.workingDir
        };

        const heartbeatFile = path.join(HEARTBEATS_DIR, `${this.name}.json`);
        fs.writeFileSync(heartbeatFile, JSON.stringify(heartbeat, null, 2));
        this.lastHeartbeat = heartbeat.lastHeartbeat;
    }

    /**
     * Run a single task using Cursor CLI
     */
    async runTask(task) {
        if (!this.cursorPath) {
            throw new Error('Cursor CLI not found. Install Cursor or set path manually.');
        }

        this.status = 'running';
        this.writeHeartbeat();
        this.log(`Starting task: ${task.id} - ${task.action}`);

        const taskPrompt = this.buildTaskPrompt(task);

        return new Promise((resolve, reject) => {
            // Write task to a temp file for Cursor to read
            const taskFile = path.join(this.workingDir, 'current_task.md');
            fs.writeFileSync(taskFile, taskPrompt);

            // Run Cursor CLI in agent mode
            const args = [
                'agent',
                '--model', this.model,
                '--print',
                taskPrompt.substring(0, 1000) // Cursor CLI has arg length limits
            ];

            this.log(`Running: cursor ${args.join(' ')}`);

            this.process = spawn(this.cursorPath, args, {
                cwd: this.workingDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            });

            let stdout = '';
            let stderr = '';

            this.process.stdout.on('data', (data) => {
                stdout += data.toString();
                this.log(`[stdout] ${data.toString().trim()}`);
            });

            this.process.stderr.on('data', (data) => {
                stderr += data.toString();
                this.log(`[stderr] ${data.toString().trim()}`);
            });

            this.process.on('close', (code) => {
                this.status = 'idle';
                this.tasksCompleted++;
                this.writeHeartbeat();

                const result = {
                    taskId: task.id,
                    agent: this.name,
                    status: code === 0 ? 'completed' : 'failed',
                    exitCode: code,
                    stdout,
                    stderr,
                    completedAt: new Date().toISOString()
                };

                // Write result
                const resultFile = path.join(RESULTS_DIR, `${task.id}.json`);
                fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));

                this.log(`Task ${task.id} completed with code ${code}`);

                if (code === 0) {
                    resolve(result);
                } else {
                    reject(new Error(`Task failed with code ${code}: ${stderr}`));
                }
            });

            this.process.on('error', (err) => {
                this.status = 'error';
                this.writeHeartbeat();
                this.log(`Process error: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Build the full prompt for a task
     */
    buildTaskPrompt(task) {
        return `# Agent Task

## Agent Instructions
${this.instructions}

## Current Task
**ID:** ${task.id}
**Type:** ${task.type}
**Action:** ${task.action}
**Priority:** ${task.priority}

## Task Details
${JSON.stringify(task.params || {}, null, 2)}

## Instructions
Complete this task according to your agent instructions.
Write any results or findings to files in the working directory.
If you need to alert the orchestrator, write to: ../results/${task.id}.json

## Expected Output
Provide a clear summary of what was done and any results.
`;
    }

    /**
     * Watch for new tasks
     */
    startWatching(pollInterval = 5000) {
        this.log(`Starting task watcher (polling every ${pollInterval}ms)`);
        this.status = 'watching';
        this.writeHeartbeat();

        const agentTaskDir = path.join(TASKS_DIR, this.name);
        if (!fs.existsSync(agentTaskDir)) {
            fs.mkdirSync(agentTaskDir, { recursive: true });
        }

        this.watchInterval = setInterval(async () => {
            try {
                const pendingDir = path.join(agentTaskDir, 'pending');
                if (!fs.existsSync(pendingDir)) {
                    fs.mkdirSync(pendingDir, { recursive: true });
                    return;
                }

                const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));

                for (const file of files) {
                    const taskPath = path.join(pendingDir, file);
                    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));

                    // Move to processing
                    const processingDir = path.join(agentTaskDir, 'processing');
                    if (!fs.existsSync(processingDir)) {
                        fs.mkdirSync(processingDir, { recursive: true });
                    }
                    fs.renameSync(taskPath, path.join(processingDir, file));

                    // Execute task
                    try {
                        await this.runTask(task);

                        // Move to completed
                        const completedDir = path.join(agentTaskDir, 'completed');
                        if (!fs.existsSync(completedDir)) {
                            fs.mkdirSync(completedDir, { recursive: true });
                        }
                        fs.renameSync(
                            path.join(processingDir, file),
                            path.join(completedDir, file)
                        );
                    } catch (e) {
                        this.log(`Task failed: ${e.message}`);
                        // Move to failed
                        const failedDir = path.join(agentTaskDir, 'failed');
                        if (!fs.existsSync(failedDir)) {
                            fs.mkdirSync(failedDir, { recursive: true });
                        }
                        fs.renameSync(
                            path.join(processingDir, file),
                            path.join(failedDir, file)
                        );
                    }
                }

                this.writeHeartbeat();
            } catch (e) {
                this.log(`Watcher error: ${e.message}`);
            }
        }, pollInterval);
    }

    /**
     * Stop watching for tasks
     */
    stopWatching() {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
            this.watchInterval = null;
        }
        this.status = 'stopped';
        this.writeHeartbeat();
        this.log('Stopped watching for tasks');
    }

    /**
     * Kill the current process
     */
    kill() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.stopWatching();
    }
}

/**
 * Launch a new agent
 */
async function launchAgent(options) {
    const agent = new CursorAgent(options);

    // If continuous mode, start watching
    if (options.continuous) {
        agent.startWatching(options.pollInterval || 5000);
    }

    return agent;
}

/**
 * Queue a task for an agent
 */
function queueTask(agentName, task) {
    const taskId = task.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullTask = {
        ...task,
        id: taskId,
        queuedAt: new Date().toISOString()
    };

    const pendingDir = path.join(TASKS_DIR, agentName, 'pending');
    if (!fs.existsSync(pendingDir)) {
        fs.mkdirSync(pendingDir, { recursive: true });
    }

    const taskFile = path.join(pendingDir, `${taskId}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(fullTask, null, 2));

    console.log(`Queued task ${taskId} for agent ${agentName}`);
    return taskId;
}

/**
 * Get result of a task
 */
function getTaskResult(taskId) {
    const resultFile = path.join(RESULTS_DIR, `${taskId}.json`);
    if (fs.existsSync(resultFile)) {
        return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    }
    return null;
}

/**
 * List all agent heartbeats (status)
 */
function listAgents() {
    const agents = [];
    if (fs.existsSync(HEARTBEATS_DIR)) {
        const files = fs.readdirSync(HEARTBEATS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const heartbeat = JSON.parse(
                    fs.readFileSync(path.join(HEARTBEATS_DIR, file), 'utf8')
                );
                agents.push(heartbeat);
            } catch (e) {
                // Skip invalid files
            }
        }
    }
    return agents;
}

/**
 * Check if an agent is alive (heartbeat within last 2 minutes)
 */
function isAgentAlive(agentName) {
    const heartbeatFile = path.join(HEARTBEATS_DIR, `${agentName}.json`);
    if (!fs.existsSync(heartbeatFile)) {
        return false;
    }

    try {
        const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
        const lastBeat = new Date(heartbeat.lastHeartbeat);
        const now = new Date();
        const diffMs = now - lastBeat;
        return diffMs < 120000; // 2 minutes
    } catch (e) {
        return false;
    }
}

// Export
module.exports = {
    CursorAgent,
    launchAgent,
    queueTask,
    getTaskResult,
    listAgents,
    isAgentAlive,
    findCursorCLI,
    AGENTS_DIR,
    TASKS_DIR,
    RESULTS_DIR,
    HEARTBEATS_DIR,
    LOGS_DIR
};

// CLI
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'list':
            console.log('Active Agents:');
            console.log(JSON.stringify(listAgents(), null, 2));
            break;

        case 'test':
            console.log('Testing Cursor CLI...');
            const cursorPath = findCursorCLI();
            if (cursorPath) {
                console.log('Found:', cursorPath);
            } else {
                console.log('Cursor CLI not found!');
            }
            break;

        case 'demo':
            (async () => {
                console.log('Launching demo agent...');
                const agent = await launchAgent({
                    name: 'demo-agent',
                    instructions: 'You are a demo agent. Respond to tasks briefly.',
                    continuous: false
                });

                // Queue a test task
                const taskId = queueTask('demo-agent', {
                    type: 'test',
                    action: 'Say hello',
                    priority: 'low',
                    params: { message: 'Hello from the orchestrator!' }
                });

                console.log('Queued task:', taskId);
                console.log('Agent would process this when running in continuous mode.');
            })();
            break;

        default:
            console.log('Cursor Agent CLI');
            console.log('Commands:');
            console.log('  list    - List active agents');
            console.log('  test    - Test Cursor CLI availability');
            console.log('  demo    - Run demo agent');
    }
}
