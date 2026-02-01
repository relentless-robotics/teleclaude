/**
 * Cursor CLI Wrapper
 *
 * Utility for using Cursor AI agent from Node.js scripts.
 * Requires Cursor Pro subscription.
 *
 * IMPORTANT: Always uses "auto" model by default - this is FREE with Cursor Pro!
 *
 * Usage:
 *   const { cursorAgent, cursorAsk, cursorPlan } = require('./utils/cursor_cli');
 *
 *   // Quick ask (non-interactive) - uses auto model (FREE)
 *   const answer = await cursorAsk('Explain this function');
 *
 *   // Plan mode - uses auto model (FREE)
 *   const plan = await cursorPlan('Refactor the authentication system');
 *
 *   // Full agent task - uses auto model (FREE)
 *   const result = await cursorAgent('Fix the bug in user.js');
 *
 * Available Models:
 *   - 'auto' (DEFAULT - FREE with Pro, recommended)
 *   - 'claude-3.5-sonnet'
 *   - 'gpt-4'
 *   - 'gpt-4o'
 *   - 'claude-3-opus'
 */

const { spawn, execSync } = require('child_process');
const path = require('path');

// Cursor CLI path
const CURSOR_PATH = 'C:\\Users\\Footb\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd';

/**
 * Check if Cursor CLI is available
 */
function isCursorAvailable() {
    try {
        execSync('cursor --version', { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get Cursor version
 */
function getCursorVersion() {
    try {
        return execSync('cursor --version', { encoding: 'utf-8' }).trim();
    } catch {
        return null;
    }
}

/**
 * Run Cursor agent in non-interactive mode
 *
 * @param {string} prompt - The task/question for the agent
 * @param {object} options - Options
 * @param {string} options.mode - 'agent' | 'ask' | 'plan'
 * @param {string} options.model - Model to use (default: 'auto' - FREE with Pro!)
 * @param {string} options.outputFormat - 'text' | 'json'
 * @param {string} options.workingDir - Working directory
 * @param {number} options.timeout - Timeout in ms (default: 120000)
 * @returns {Promise<string>} Agent response
 */
async function runCursor(prompt, options = {}) {
    const {
        mode = 'agent',
        model = 'auto',  // IMPORTANT: 'auto' is FREE with Cursor Pro!
        outputFormat = 'text',
        workingDir = process.cwd(),
        timeout = 120000
    } = options;

    return new Promise((resolve, reject) => {
        const args = [
            'agent',
            '--print',
            `--mode=${mode}`,
            `--model=${model}`,
            `--output-format=${outputFormat}`,
            prompt
        ];

        const proc = spawn('cursor', args, {
            cwd: workingDir,
            shell: true,
            timeout
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Cursor exited with code ${code}: ${stderr}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Ask Cursor a question (no file modifications)
 */
async function cursorAsk(question, workingDir = process.cwd()) {
    return runCursor(question, { mode: 'ask', workingDir });
}

/**
 * Get Cursor to plan an approach
 */
async function cursorPlan(task, workingDir = process.cwd()) {
    return runCursor(task, { mode: 'plan', workingDir });
}

/**
 * Run Cursor agent for a task
 */
async function cursorAgent(task, workingDir = process.cwd()) {
    return runCursor(task, { mode: 'agent', workingDir });
}

/**
 * Open a file in Cursor editor
 */
function openInCursor(filePath) {
    try {
        execSync(`cursor "${filePath}"`, { stdio: 'inherit' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Open folder in Cursor
 */
function openFolderInCursor(folderPath) {
    try {
        execSync(`cursor "${folderPath}"`, { stdio: 'inherit' });
        return true;
    } catch {
        return false;
    }
}

/**
 * List previous Cursor agent conversations
 */
async function listConversations() {
    return new Promise((resolve, reject) => {
        const proc = spawn('cursor', ['agent', 'ls'], {
            shell: true
        });

        let stdout = '';
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error('Failed to list conversations'));
            }
        });
    });
}

/**
 * Resume a previous conversation
 */
async function resumeConversation(threadId = null) {
    const args = threadId
        ? ['agent', 'resume', threadId]
        : ['agent', 'resume'];

    return new Promise((resolve, reject) => {
        const proc = spawn('cursor', args, { shell: true });

        let stdout = '';
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error('Failed to resume conversation'));
            }
        });
    });
}

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];
    const prompt = args.slice(1).join(' ');

    async function main() {
        if (!isCursorAvailable()) {
            console.error('Cursor CLI not available');
            process.exit(1);
        }

        console.log(`Cursor ${getCursorVersion()}\n`);

        switch (command) {
            case 'ask':
                console.log(await cursorAsk(prompt));
                break;
            case 'plan':
                console.log(await cursorPlan(prompt));
                break;
            case 'agent':
                console.log(await cursorAgent(prompt));
                break;
            case 'ls':
                console.log(await listConversations());
                break;
            case 'resume':
                console.log(await resumeConversation(prompt || null));
                break;
            default:
                console.log('Cursor CLI Wrapper\n');
                console.log('Usage:');
                console.log('  node cursor_cli.js ask "your question"');
                console.log('  node cursor_cli.js plan "your task"');
                console.log('  node cursor_cli.js agent "your task"');
                console.log('  node cursor_cli.js ls');
                console.log('  node cursor_cli.js resume [thread_id]');
        }
    }

    main().catch(console.error);
}

module.exports = {
    isCursorAvailable,
    getCursorVersion,
    runCursor,
    cursorAsk,
    cursorPlan,
    cursorAgent,
    openInCursor,
    openFolderInCursor,
    listConversations,
    resumeConversation
};
