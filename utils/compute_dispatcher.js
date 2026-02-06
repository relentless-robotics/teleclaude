/**
 * Compute Task Dispatcher
 *
 * Intelligently dispatches tasks to available compute resources
 * based on requirements (CPU, GPU, RAM, etc.)
 */

const { sshExec, pingServer, getSystemStats, getGPUStats, listServers, startRemoteTask } = require('./remote_compute');
const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, '..', 'logs', 'dispatched_tasks');
if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });

/**
 * Task requirements interface
 */
const TASK_PROFILES = {
    'quant-training': {
        minRAM: 16, // GB
        preferGPU: true,
        minCPU: 4,
        estimatedDuration: '4-8 hours'
    },
    'data-processing': {
        minRAM: 8,
        preferGPU: false,
        minCPU: 2,
        estimatedDuration: '1-2 hours'
    },
    'ml-inference': {
        minRAM: 4,
        preferGPU: true,
        minCPU: 2,
        estimatedDuration: '< 1 hour'
    },
    'general': {
        minRAM: 2,
        preferGPU: false,
        minCPU: 1,
        estimatedDuration: 'varies'
    }
};

/**
 * Get available compute resources across all servers
 */
async function getAvailableCompute() {
    const servers = await listServers();
    const resources = [];

    for (const server of servers) {
        if (!server.reachable) continue;

        try {
            const stats = getSystemStats(server.name);
            const gpu = getGPUStats(server.name);

            resources.push({
                name: server.name,
                host: server.host,
                cpu: {
                    usage: parseFloat(stats.cpu) || 0,
                    available: 100 - (parseFloat(stats.cpu) || 0),
                    loadAvg: stats.loadAvg
                },
                memory: {
                    totalMB: parseInt(stats.memoryTotal) || 0,
                    usedMB: parseInt(stats.memoryUsed) || 0,
                    usedPercent: parseFloat(stats.memory) || 0,
                    availableMB: (parseInt(stats.memoryTotal) || 0) - (parseInt(stats.memoryUsed) || 0)
                },
                gpu: gpu,
                uptime: stats.uptime,
                processes: parseInt(stats.processes) || 0
            });
        } catch (error) {
            console.error(`Failed to get stats for ${server.name}:`, error.message);
        }
    }

    return resources;
}

/**
 * Find best server for a task based on requirements
 */
async function findBestServer(requirements = {}) {
    const resources = await getAvailableCompute();

    if (resources.length === 0) {
        return { success: false, error: 'No servers available' };
    }

    const { minRAM = 1, preferGPU = false, minCPU = 1 } = requirements;

    // Score each server
    const scored = resources.map(server => {
        let score = 0;

        // RAM score
        const ramGB = server.memory.availableMB / 1024;
        if (ramGB >= minRAM) {
            score += 10 + Math.min(ramGB, 64); // Bonus for extra RAM up to 64GB
        } else {
            score -= 100; // Penalty for insufficient RAM
        }

        // CPU score (prefer lower usage)
        score += (100 - server.cpu.usage) / 10;

        // GPU score
        if (preferGPU && server.gpu.hasGPU) {
            const gpu = server.gpu.gpus[0];
            score += 20;
            score += (100 - gpu.utilizationPercent) / 5;
        } else if (preferGPU && !server.gpu.hasGPU) {
            score -= 50;
        }

        return { ...server, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score < 0) {
        return {
            success: false,
            error: 'No server meets requirements',
            available: resources
        };
    }

    return {
        success: true,
        server: best,
        alternatives: scored.slice(1, 4)
    };
}

/**
 * Dispatch a task to the best available server
 */
async function dispatchTask(taskConfig) {
    const {
        name,
        command,
        profile = 'general',
        requirements = {},
        workingDir = '~',
        env = {},
        notifyOnComplete = true
    } = taskConfig;

    // Get profile requirements
    const profileReqs = TASK_PROFILES[profile] || TASK_PROFILES.general;
    const mergedReqs = { ...profileReqs, ...requirements };

    // Find best server
    const serverResult = await findBestServer(mergedReqs);
    if (!serverResult.success) {
        return serverResult;
    }

    const server = serverResult.server;

    // Build environment string
    const envStr = Object.entries(env)
        .map(([k, v]) => `export ${k}="${v}"`)
        .join(' && ');

    // Build full command
    const fullCommand = envStr
        ? `cd ${workingDir} && ${envStr} && ${command}`
        : `cd ${workingDir} && ${command}`;

    // Start the task
    const taskResult = startRemoteTask(server.name, fullCommand, name);

    if (taskResult.success) {
        // Record dispatch info
        const dispatchInfo = {
            ...taskResult,
            profile,
            requirements: mergedReqs,
            serverStats: {
                cpu: server.cpu.usage,
                memoryUsed: server.memory.usedPercent,
                hasGPU: server.gpu.hasGPU
            },
            dispatchedAt: new Date().toISOString()
        };

        const infoFile = path.join(TASKS_DIR, `${name}_${taskResult.pid}.json`);
        fs.writeFileSync(infoFile, JSON.stringify(dispatchInfo, null, 2));

        return {
            success: true,
            dispatch: dispatchInfo,
            server: server.name,
            message: `Task "${name}" dispatched to ${server.name} (PID: ${taskResult.pid})`
        };
    }

    return taskResult;
}

/**
 * Dispatch training job specifically
 */
async function dispatchTraining(projectName, projectPath, script, args = []) {
    return dispatchTask({
        name: `training_${projectName}`,
        command: `source venv/bin/activate 2>/dev/null || true && python ${script} ${args.join(' ')}`,
        profile: 'quant-training',
        workingDir: projectPath,
        env: {
            PYTHONUNBUFFERED: '1'
        }
    });
}

/**
 * Get status of all dispatched tasks
 */
function getDispatchedTasks() {
    const tasks = [];

    if (!fs.existsSync(TASKS_DIR)) return tasks;

    const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
        try {
            const info = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file)));
            tasks.push(info);
        } catch (e) {
            // Skip invalid files
        }
    }

    return tasks;
}

/**
 * Monitor all active tasks and return their status
 */
async function monitorTasks() {
    const tasks = getDispatchedTasks();
    const status = [];

    for (const task of tasks) {
        const { checkRemoteTask, getRemoteTaskLogs } = require('./remote_compute');

        const taskStatus = checkRemoteTask(task.server, task.pid);
        const logs = getRemoteTaskLogs(task.server, task.logFile, 10);

        status.push({
            name: task.taskName,
            server: task.server,
            pid: task.pid,
            running: taskStatus.running,
            elapsed: taskStatus.elapsed,
            recentLogs: logs.success ? logs.logs : 'N/A',
            startTime: task.startTime
        });
    }

    return status;
}

/**
 * Format compute resources for display
 */
function formatResourcesReport(resources) {
    let report = '=== COMPUTE RESOURCES ===\n\n';

    for (const server of resources) {
        report += `📦 ${server.name} (${server.host})\n`;
        report += `   CPU: ${server.cpu.usage.toFixed(1)}% used (load: ${server.cpu.loadAvg})\n`;
        report += `   RAM: ${(server.memory.usedMB / 1024).toFixed(1)}GB / ${(server.memory.totalMB / 1024).toFixed(1)}GB (${server.memory.usedPercent}%)\n`;

        if (server.gpu.hasGPU) {
            for (const gpu of server.gpu.gpus) {
                report += `   GPU ${gpu.index}: ${gpu.name}\n`;
                report += `        Util: ${gpu.utilizationPercent}% | VRAM: ${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB | Temp: ${gpu.temperatureC}°C\n`;
            }
        } else {
            report += `   GPU: None\n`;
        }

        report += `   Uptime: ${server.uptime}\n\n`;
    }

    return report;
}

module.exports = {
    // Resource discovery
    getAvailableCompute,
    findBestServer,
    formatResourcesReport,

    // Task dispatch
    dispatchTask,
    dispatchTraining,

    // Monitoring
    getDispatchedTasks,
    monitorTasks,

    // Config
    TASK_PROFILES
};

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0];

    (async () => {
        switch (cmd) {
            case 'resources':
                const resources = await getAvailableCompute();
                console.log(formatResourcesReport(resources));
                break;

            case 'find':
                const profile = args[1] || 'general';
                const result = await findBestServer(TASK_PROFILES[profile] || {});
                if (result.success) {
                    console.log(`Best server for "${profile}": ${result.server.name}`);
                    console.log(`  Score: ${result.server.score}`);
                } else {
                    console.log('No suitable server found');
                }
                break;

            case 'status':
                const status = await monitorTasks();
                console.log('Active Tasks:');
                status.forEach(t => {
                    const state = t.running ? '🟢 Running' : '⚪ Stopped';
                    console.log(`  ${t.name} on ${t.server}: ${state}`);
                    if (t.elapsed) console.log(`    Elapsed: ${t.elapsed}`);
                });
                break;

            default:
                console.log('Compute Dispatcher');
                console.log('Usage:');
                console.log('  node compute_dispatcher.js resources  - Show all compute resources');
                console.log('  node compute_dispatcher.js find [profile] - Find best server for profile');
                console.log('  node compute_dispatcher.js status     - Show active tasks');
        }
    })();
}
