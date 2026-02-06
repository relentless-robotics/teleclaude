/**
 * Orchestrator - Central Command for Multi-Agent System
 *
 * The Orchestrator (Opus) coordinates all worker agents.
 * It delegates tasks, monitors progress, and handles escalations.
 *
 * Key Responsibilities:
 * - Task delegation to appropriate agents
 * - Agent health monitoring
 * - Result aggregation and user notification
 * - Alert handling and escalation
 *
 * Usage:
 *   const { Orchestrator } = require('./orchestrator');
 *   const orch = new Orchestrator();
 *
 *   // Delegate task
 *   await orch.delegateTask('trading-agent', {
 *     action: 'check_positions',
 *     priority: 'high'
 *   });
 *
 *   // Check agent status
 *   const status = orch.getAgentStatus('trading-agent');
 */

const fs = require('fs');
const path = require('path');
const {
    CursorAgent,
    launchAgent,
    queueTask,
    getTaskResult,
    listAgents,
    isAgentAlive,
    TASKS_DIR,
    RESULTS_DIR,
    HEARTBEATS_DIR
} = require('./cursor_agent');

const ALERTS_DIR = path.join(__dirname, '..', 'alerts');
const CONFIG_DIR = path.join(__dirname, '..', 'config');

// Ensure directories
[ALERTS_DIR, CONFIG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/**
 * Agent registry with their capabilities
 */
const AGENT_REGISTRY = {
    'trading-agent': {
        capabilities: ['trading', 'market-analysis', 'position-management'],
        instructionsFile: '../trading/INSTRUCTIONS.md',
        priority: 'high'
    },
    'bounty-agent': {
        capabilities: ['github', 'code-review', 'pr-management', 'bounty-hunting'],
        instructionsFile: '../bounty/INSTRUCTIONS.md',
        priority: 'medium'
    },
    'security-agent': {
        capabilities: ['security-scan', 'log-monitoring', 'vulnerability-check'],
        instructionsFile: '../security/INSTRUCTIONS.md',
        priority: 'high'
    },
    'compute-agent': {
        capabilities: ['ml-training', 'data-processing', 'batch-jobs'],
        instructionsFile: '../compute/INSTRUCTIONS.md',
        priority: 'low'
    }
};

/**
 * Orchestrator class
 */
class Orchestrator {
    constructor(options = {}) {
        this.agents = new Map();
        this.alertCallbacks = [];
        this.resultCallbacks = [];
        this.checkInterval = null;
        this.discordSender = options.discordSender || console.log;
    }

    /**
     * Register a Discord sender function
     */
    setDiscordSender(sender) {
        this.discordSender = sender;
    }

    /**
     * Launch an agent
     */
    async launchAgent(agentName, options = {}) {
        const registry = AGENT_REGISTRY[agentName];
        if (!registry) {
            throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(AGENT_REGISTRY).join(', ')}`);
        }

        // Load instructions
        let instructions = '';
        try {
            const instructionsPath = path.join(__dirname, registry.instructionsFile);
            if (fs.existsSync(instructionsPath)) {
                instructions = fs.readFileSync(instructionsPath, 'utf8');
            }
        } catch (e) {
            console.warn(`Could not load instructions for ${agentName}: ${e.message}`);
        }

        const agent = await launchAgent({
            name: agentName,
            instructions,
            continuous: options.continuous !== false,
            pollInterval: options.pollInterval || 5000,
            ...options
        });

        this.agents.set(agentName, agent);
        console.log(`Launched agent: ${agentName}`);

        return agent;
    }

    /**
     * Delegate a task to an agent
     */
    async delegateTask(agentName, task) {
        // Validate agent exists or can be created
        if (!AGENT_REGISTRY[agentName]) {
            throw new Error(`Unknown agent: ${agentName}`);
        }

        // Queue the task
        const taskId = queueTask(agentName, {
            ...task,
            from: 'orchestrator',
            to: agentName,
            createdAt: new Date().toISOString()
        });

        console.log(`Delegated task ${taskId} to ${agentName}`);
        return taskId;
    }

    /**
     * Delegate task to best available agent based on capability
     */
    async delegateByCapability(capability, task) {
        // Find agent with matching capability
        for (const [agentName, config] of Object.entries(AGENT_REGISTRY)) {
            if (config.capabilities.includes(capability)) {
                return this.delegateTask(agentName, task);
            }
        }

        throw new Error(`No agent found with capability: ${capability}`);
    }

    /**
     * Get status of an agent
     */
    getAgentStatus(agentName) {
        const heartbeatFile = path.join(HEARTBEATS_DIR, `${agentName}.json`);
        if (!fs.existsSync(heartbeatFile)) {
            return { status: 'not_running', alive: false };
        }

        try {
            const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
            const alive = isAgentAlive(agentName);
            return {
                ...heartbeat,
                alive,
                age: Date.now() - new Date(heartbeat.lastHeartbeat).getTime()
            };
        } catch (e) {
            return { status: 'error', error: e.message };
        }
    }

    /**
     * Get status of all agents
     */
    getAllAgentStatus() {
        const status = {};
        for (const agentName of Object.keys(AGENT_REGISTRY)) {
            status[agentName] = this.getAgentStatus(agentName);
        }
        return status;
    }

    /**
     * Check for pending results and alerts
     */
    checkResults() {
        const results = [];

        // Check results directory
        if (fs.existsSync(RESULTS_DIR)) {
            const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const result = JSON.parse(
                        fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8')
                    );
                    if (!result._processed) {
                        results.push(result);
                    }
                } catch (e) {
                    // Skip invalid files
                }
            }
        }

        return results;
    }

    /**
     * Check for alerts
     */
    checkAlerts() {
        const alerts = [];

        if (fs.existsSync(ALERTS_DIR)) {
            const files = fs.readdirSync(ALERTS_DIR).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const alert = JSON.parse(
                        fs.readFileSync(path.join(ALERTS_DIR, file), 'utf8')
                    );
                    if (!alert._acknowledged) {
                        alerts.push({ ...alert, file });
                    }
                } catch (e) {
                    // Skip invalid files
                }
            }
        }

        return alerts.sort((a, b) => {
            const priority = { critical: 0, warning: 1, info: 2 };
            return (priority[a.severity] || 2) - (priority[b.severity] || 2);
        });
    }

    /**
     * Acknowledge an alert
     */
    acknowledgeAlert(alertFile) {
        const alertPath = path.join(ALERTS_DIR, alertFile);
        if (fs.existsSync(alertPath)) {
            const alert = JSON.parse(fs.readFileSync(alertPath, 'utf8'));
            alert._acknowledged = true;
            alert._acknowledgedAt = new Date().toISOString();
            fs.writeFileSync(alertPath, JSON.stringify(alert, null, 2));
        }
    }

    /**
     * Send an alert (for agents to use)
     */
    static sendAlert(agentName, severity, message, data = {}) {
        const alert = {
            id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            agent: agentName,
            severity, // 'critical', 'warning', 'info'
            message,
            data,
            createdAt: new Date().toISOString(),
            _acknowledged: false
        };

        const alertFile = path.join(ALERTS_DIR, `${alert.id}.json`);
        fs.writeFileSync(alertFile, JSON.stringify(alert, null, 2));

        console.log(`[ALERT] [${severity.toUpperCase()}] [${agentName}] ${message}`);
        return alert;
    }

    /**
     * Start monitoring loop
     */
    startMonitoring(intervalMs = 30000) {
        console.log(`Starting orchestrator monitoring (every ${intervalMs / 1000}s)`);

        this.checkInterval = setInterval(async () => {
            // Check agent health
            const status = this.getAllAgentStatus();
            for (const [name, s] of Object.entries(status)) {
                if (s.status === 'running' && !s.alive) {
                    console.warn(`Agent ${name} appears dead (no heartbeat)`);
                    this.discordSender(`Warning: Agent ${name} has stopped responding`);
                }
            }

            // Check for alerts
            const alerts = this.checkAlerts();
            for (const alert of alerts) {
                if (alert.severity === 'critical') {
                    this.discordSender(
                        `**CRITICAL ALERT** from ${alert.agent}:\n${alert.message}`
                    );
                    this.acknowledgeAlert(alert.file);
                }
            }

            // Check for results
            const results = this.checkResults();
            // Process results (notify callbacks)
            for (const callback of this.resultCallbacks) {
                for (const result of results) {
                    callback(result);
                }
            }
        }, intervalMs);
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * Register callback for results
     */
    onResult(callback) {
        this.resultCallbacks.push(callback);
    }

    /**
     * Register callback for alerts
     */
    onAlert(callback) {
        this.alertCallbacks.push(callback);
    }

    /**
     * Format status for display
     */
    formatStatus() {
        const status = this.getAllAgentStatus();
        let msg = '**Multi-Agent System Status**\n\n';

        for (const [name, s] of Object.entries(status)) {
            const emoji = s.alive ? '🟢' : (s.status === 'not_running' ? '⚪' : '🔴');
            msg += `${emoji} **${name}**\n`;
            msg += `   Status: ${s.status || 'unknown'}\n`;
            if (s.tasksCompleted !== undefined) {
                msg += `   Tasks: ${s.tasksCompleted} completed\n`;
            }
            if (s.lastHeartbeat) {
                const age = Math.round((Date.now() - new Date(s.lastHeartbeat).getTime()) / 1000);
                msg += `   Last seen: ${age}s ago\n`;
            }
            msg += '\n';
        }

        const alerts = this.checkAlerts();
        if (alerts.length > 0) {
            msg += `**Pending Alerts:** ${alerts.length}\n`;
            for (const alert of alerts.slice(0, 3)) {
                msg += `- [${alert.severity}] ${alert.message}\n`;
            }
        }

        return msg;
    }

    /**
     * Shutdown all agents
     */
    shutdown() {
        this.stopMonitoring();
        for (const [name, agent] of this.agents) {
            console.log(`Stopping agent: ${name}`);
            agent.kill();
        }
        this.agents.clear();
    }
}

/**
 * Quick function to delegate a task
 */
async function delegateTask(agentName, task) {
    const orch = new Orchestrator();
    return orch.delegateTask(agentName, task);
}

/**
 * Get all agent statuses
 */
function getSystemStatus() {
    const orch = new Orchestrator();
    return orch.formatStatus();
}

// Export
module.exports = {
    Orchestrator,
    delegateTask,
    getSystemStatus,
    AGENT_REGISTRY
};

// CLI
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    const orch = new Orchestrator();

    switch (command) {
        case 'status':
            console.log(orch.formatStatus());
            break;

        case 'alerts':
            const alerts = orch.checkAlerts();
            console.log('Pending Alerts:');
            console.log(JSON.stringify(alerts, null, 2));
            break;

        case 'delegate':
            if (args.length < 3) {
                console.log('Usage: delegate <agent> <action>');
                break;
            }
            delegateTask(args[1], {
                action: args[2],
                priority: 'medium',
                params: {}
            }).then(taskId => {
                console.log('Delegated task:', taskId);
            });
            break;

        case 'monitor':
            console.log('Starting orchestrator monitor...');
            orch.startMonitoring(30000);
            process.on('SIGINT', () => {
                orch.shutdown();
                process.exit(0);
            });
            setInterval(() => {}, 1000); // Keep alive
            break;

        default:
            console.log('Orchestrator CLI');
            console.log('Commands:');
            console.log('  status    - Show all agent status');
            console.log('  alerts    - Show pending alerts');
            console.log('  delegate  - Delegate task to agent');
            console.log('  monitor   - Start monitoring loop');
    }
}
