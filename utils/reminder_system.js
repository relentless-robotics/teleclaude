/**
 * Self-Reminder System
 *
 * Allows Claude to set reminders for itself that trigger Discord messages.
 * Fully local - no external services needed.
 *
 * Features:
 * - One-time reminders (at specific time or in X minutes)
 * - Recurring reminders (every X minutes/hours)
 * - Project-tagged reminders
 * - Full CRUD control
 *
 * Usage:
 *   const reminders = require('./utils/reminder_system');
 *
 *   // Add a one-time reminder
 *   reminders.addReminder({
 *     message: "Check SMCI position",
 *     inMinutes: 60,
 *     tags: ["trading", "smci"]
 *   });
 *
 *   // Add recurring reminder
 *   reminders.addReminder({
 *     message: "Hourly trade check",
 *     recurring: true,
 *     intervalMinutes: 60,
 *     tags: ["trading"]
 *   });
 *
 *   // Start the reminder daemon
 *   reminders.startDaemon(sendToDiscord);
 */

const fs = require('fs');
const path = require('path');

const REMINDERS_FILE = path.join(__dirname, '..', 'data', 'reminders.json');
const CHECK_INTERVAL = 60 * 1000; // Check every minute

let daemonRunning = false;
let daemonInterval = null;
let discordSender = null;

/**
 * Load reminders from file
 */
function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading reminders:', e.message);
    }
    return { reminders: [], lastId: 0 };
}

/**
 * Save reminders to file
 */
function saveReminders(data) {
    const dir = path.dirname(REMINDERS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Add a new reminder
 *
 * @param {Object} options
 * @param {string} options.message - The reminder message
 * @param {number} [options.inMinutes] - Trigger in X minutes from now
 * @param {Date|string} [options.at] - Trigger at specific time
 * @param {boolean} [options.recurring=false] - Is this a recurring reminder?
 * @param {number} [options.intervalMinutes] - For recurring: interval in minutes
 * @param {string[]} [options.tags] - Tags for categorization
 * @param {boolean} [options.enabled=true] - Is the reminder active?
 * @param {string} [options.marketHoursOnly=false] - Only trigger during market hours (9:30-16:00 ET)
 */
function addReminder(options) {
    const data = loadReminders();

    const reminder = {
        id: ++data.lastId,
        message: options.message,
        recurring: options.recurring || false,
        intervalMinutes: options.intervalMinutes || 60,
        tags: options.tags || [],
        enabled: options.enabled !== false,
        marketHoursOnly: options.marketHoursOnly || false,
        createdAt: new Date().toISOString(),
        lastTriggered: null,
        triggerCount: 0
    };

    // Calculate next trigger time
    if (options.inMinutes) {
        reminder.nextTrigger = new Date(Date.now() + options.inMinutes * 60 * 1000).toISOString();
    } else if (options.at) {
        reminder.nextTrigger = new Date(options.at).toISOString();
    } else if (options.recurring) {
        reminder.nextTrigger = new Date(Date.now() + options.intervalMinutes * 60 * 1000).toISOString();
    } else {
        // Default: 1 hour from now
        reminder.nextTrigger = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }

    data.reminders.push(reminder);
    saveReminders(data);

    console.log(`[Reminder] Added: "${reminder.message}" - Next trigger: ${reminder.nextTrigger}`);
    return reminder;
}

/**
 * Remove a reminder by ID
 */
function removeReminder(id) {
    const data = loadReminders();
    const index = data.reminders.findIndex(r => r.id === id);

    if (index === -1) {
        return { success: false, error: 'Reminder not found' };
    }

    const removed = data.reminders.splice(index, 1)[0];
    saveReminders(data);

    console.log(`[Reminder] Removed: "${removed.message}"`);
    return { success: true, removed };
}

/**
 * Update a reminder
 */
function updateReminder(id, updates) {
    const data = loadReminders();
    const reminder = data.reminders.find(r => r.id === id);

    if (!reminder) {
        return { success: false, error: 'Reminder not found' };
    }

    Object.assign(reminder, updates);
    saveReminders(data);

    return { success: true, reminder };
}

/**
 * Enable/disable a reminder
 */
function toggleReminder(id, enabled) {
    return updateReminder(id, { enabled });
}

/**
 * List all reminders
 */
function listReminders(filter = {}) {
    const data = loadReminders();
    let reminders = data.reminders;

    if (filter.enabled !== undefined) {
        reminders = reminders.filter(r => r.enabled === filter.enabled);
    }
    if (filter.tag) {
        reminders = reminders.filter(r => r.tags.includes(filter.tag));
    }
    if (filter.recurring !== undefined) {
        reminders = reminders.filter(r => r.recurring === filter.recurring);
    }

    return reminders;
}

/**
 * Get pending reminders (due now)
 */
function getPendingReminders() {
    const data = loadReminders();
    const now = new Date();

    return data.reminders.filter(r => {
        if (!r.enabled) return false;
        if (!r.nextTrigger) return false;

        const triggerTime = new Date(r.nextTrigger);
        return triggerTime <= now;
    });
}

/**
 * Check if within market hours (9:30 AM - 4:00 PM ET)
 */
function isMarketHours() {
    const now = new Date();
    // Convert to ET (rough approximation - doesn't account for DST perfectly)
    const etHour = now.getUTCHours() - 5;
    const etMinutes = now.getUTCMinutes();
    const etTime = etHour + etMinutes / 60;

    return etTime >= 9.5 && etTime <= 16;
}

/**
 * Process a triggered reminder
 */
async function processReminder(reminder, sendFunc) {
    const data = loadReminders();
    const r = data.reminders.find(x => x.id === reminder.id);

    if (!r) return;

    // Check market hours restriction
    if (r.marketHoursOnly && !isMarketHours()) {
        // Skip but reschedule for next check
        r.nextTrigger = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // Check again in 30 min
        saveReminders(data);
        return;
    }

    // Send the reminder
    const message = `**REMINDER** [${r.tags.join(', ') || 'general'}]\n\n${r.message}`;

    try {
        if (sendFunc) {
            await sendFunc(message);
        } else {
            console.log('[REMINDER TRIGGERED]:', message);
        }
    } catch (e) {
        console.error('Error sending reminder:', e.message);
    }

    // Update reminder state
    r.lastTriggered = new Date().toISOString();
    r.triggerCount++;

    if (r.recurring) {
        // Schedule next occurrence
        r.nextTrigger = new Date(Date.now() + r.intervalMinutes * 60 * 1000).toISOString();
    } else {
        // One-time reminder - disable it
        r.enabled = false;
    }

    saveReminders(data);
}

/**
 * Check and process all pending reminders
 */
async function checkReminders(sendFunc) {
    const pending = getPendingReminders();

    for (const reminder of pending) {
        await processReminder(reminder, sendFunc);
    }

    return pending.length;
}

/**
 * Start the reminder daemon
 *
 * @param {Function} sendToDiscord - Function to send Discord messages
 */
function startDaemon(sendToDiscord) {
    if (daemonRunning) {
        console.log('[Reminder Daemon] Already running');
        return;
    }

    discordSender = sendToDiscord;
    daemonRunning = true;

    console.log('[Reminder Daemon] Starting...');
    console.log(`[Reminder Daemon] Checking every ${CHECK_INTERVAL / 1000} seconds`);

    // Initial check
    checkReminders(discordSender);

    // Schedule recurring checks
    daemonInterval = setInterval(() => {
        checkReminders(discordSender);
    }, CHECK_INTERVAL);

    return true;
}

/**
 * Stop the reminder daemon
 */
function stopDaemon() {
    if (!daemonRunning) {
        return false;
    }

    clearInterval(daemonInterval);
    daemonRunning = false;
    console.log('[Reminder Daemon] Stopped');
    return true;
}

/**
 * Check if daemon is running
 */
function isDaemonRunning() {
    return daemonRunning;
}

/**
 * Format reminders for display
 */
function formatReminders() {
    const reminders = listReminders();

    if (reminders.length === 0) {
        return 'No reminders set.';
    }

    let msg = `**Active Reminders (${reminders.length}):**\n\n`;

    for (const r of reminders) {
        const status = r.enabled ? '🟢' : '⭕';
        const type = r.recurring ? `🔄 Every ${r.intervalMinutes}min` : '⏰ One-time';
        const next = r.nextTrigger ? new Date(r.nextTrigger).toLocaleString() : 'N/A';
        const tags = r.tags.length > 0 ? `[${r.tags.join(', ')}]` : '';

        msg += `${status} **#${r.id}** ${tags}\n`;
        msg += `   ${r.message}\n`;
        msg += `   ${type} | Next: ${next}\n`;
        if (r.triggerCount > 0) {
            msg += `   Triggered ${r.triggerCount}x | Last: ${new Date(r.lastTriggered).toLocaleString()}\n`;
        }
        msg += '\n';
    }

    return msg;
}

/**
 * Quick helper to add trading position check reminder
 */
function addTradingReminder(intervalMinutes = 60) {
    return addReminder({
        message: `**TRADE CHECK TIME**\n\nRun: \`node swing_options/index.js positions\`\n\nCheck:\n- Position P/L\n- Exit signals (target/stop)\n- New opportunities`,
        recurring: true,
        intervalMinutes: intervalMinutes,
        tags: ['trading', 'positions', 'alpaca'],
        marketHoursOnly: true
    });
}

/**
 * Clear all reminders
 */
function clearAllReminders() {
    saveReminders({ reminders: [], lastId: 0 });
    console.log('[Reminder] All reminders cleared');
    return true;
}

// Export
module.exports = {
    addReminder,
    removeReminder,
    updateReminder,
    toggleReminder,
    listReminders,
    getPendingReminders,
    checkReminders,
    startDaemon,
    stopDaemon,
    isDaemonRunning,
    formatReminders,
    addTradingReminder,
    clearAllReminders,
    isMarketHours
};

// CLI
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'list':
            console.log(formatReminders());
            break;

        case 'add':
            const message = args.slice(1).join(' ') || 'Test reminder';
            const reminder = addReminder({
                message,
                inMinutes: 1,
                tags: ['cli']
            });
            console.log('Added reminder:', reminder);
            break;

        case 'add-trading':
            const interval = parseInt(args[1]) || 60;
            const tr = addTradingReminder(interval);
            console.log('Added trading reminder:', tr);
            break;

        case 'remove':
            const id = parseInt(args[1]);
            if (!id) {
                console.log('Usage: remove <id>');
                break;
            }
            console.log(removeReminder(id));
            break;

        case 'clear':
            clearAllReminders();
            break;

        case 'daemon':
            startDaemon((msg) => console.log('[DISCORD]:', msg));
            // Keep alive
            process.on('SIGINT', () => {
                stopDaemon();
                process.exit(0);
            });
            setInterval(() => {}, 1000); // Keep process alive
            break;

        case 'check':
            checkReminders((msg) => console.log('[ALERT]:', msg)).then(count => {
                console.log(`Processed ${count} reminders`);
            });
            break;

        default:
            console.log('Reminder System CLI');
            console.log('Commands:');
            console.log('  list              - Show all reminders');
            console.log('  add <message>     - Add one-time reminder (1 min)');
            console.log('  add-trading [min] - Add recurring trading check');
            console.log('  remove <id>       - Remove reminder');
            console.log('  clear             - Clear all reminders');
            console.log('  check             - Process pending reminders');
            console.log('  daemon            - Run reminder daemon');
    }
}
