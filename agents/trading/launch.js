/**
 * Trading Agent Launcher
 *
 * Starts the trading agent in continuous mode.
 * Run this on the server (or locally for testing).
 *
 * Usage:
 *   node launch.js         - Start in continuous mode
 *   node launch.js test    - Run single task test
 */

const path = require('path');
const { launchAgent, queueTask, getTaskResult } = require('../core/cursor_agent');

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'continuous';

    console.log('='.repeat(50));
    console.log('TRADING AGENT LAUNCHER');
    console.log('='.repeat(50));
    console.log(`Mode: ${mode}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log('');

    // Read instructions
    const instructionsPath = path.join(__dirname, 'INSTRUCTIONS.md');
    const fs = require('fs');
    const instructions = fs.readFileSync(instructionsPath, 'utf8');

    // Launch agent
    const agent = await launchAgent({
        name: 'trading-agent',
        instructions,
        workingDir: __dirname,
        continuous: mode === 'continuous',
        pollInterval: 60000 // Check every minute
    });

    console.log(`Agent launched: ${agent.name}`);
    console.log(`Working dir: ${agent.workingDir}`);
    console.log(`Status: ${agent.status}`);

    if (mode === 'test') {
        // Run a single test task
        console.log('\nRunning test task...');

        const taskId = queueTask('trading-agent', {
            type: 'trading',
            action: 'check_positions',
            priority: 'high',
            params: {
                test: true
            }
        });

        console.log(`Queued task: ${taskId}`);
        console.log('\nWaiting for result...');

        // Wait for result (up to 60 seconds)
        let result = null;
        const startTime = Date.now();
        while (!result && (Date.now() - startTime) < 60000) {
            await new Promise(r => setTimeout(r, 2000));
            result = getTaskResult(taskId);
        }

        if (result) {
            console.log('\nResult:');
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log('\nNo result received within timeout.');
        }

        agent.kill();
        process.exit(0);
    }

    // Continuous mode - keep running
    console.log('\nRunning in continuous mode. Press Ctrl+C to stop.');
    console.log('Agent is watching for tasks in:', path.join(__dirname, '..', 'tasks', 'trading-agent', 'pending'));

    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        agent.kill();
        process.exit(0);
    });

    // Keep process alive
    setInterval(() => {
        // Heartbeat
    }, 10000);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
