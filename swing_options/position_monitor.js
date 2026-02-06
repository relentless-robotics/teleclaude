/**
 * Position Monitor - Active Reminder System
 *
 * Runs on a schedule and sends Discord alerts to remind Claude to check trades.
 * This provides ACTIVE reminders, not passive memory.
 *
 * Usage:
 *   node position_monitor.js          - Run once (check and alert)
 *   node position_monitor.js daemon   - Run continuously (check every hour)
 *   node position_monitor.js status   - Just show status, no alert
 */

const alpaca = require('./alpaca_client');
const path = require('path');

// Discord webhook for sending reminders (uses MCP if available, otherwise logs)
let discordAvailable = false;
let sendToDiscord = async (msg) => {
    console.log('[DISCORD ALERT]:', msg);
};

// Try to load Discord MCP
try {
    // This runs standalone, so we'll use a simple webhook approach
    // or write to a file that the main process can pick up
    const fs = require('fs');
    const alertFile = path.join(__dirname, '..', 'alerts', 'trade_alerts.json');

    sendToDiscord = async (msg) => {
        console.log('[ALERT]:', msg);

        // Write to alert file for pickup
        const alertDir = path.dirname(alertFile);
        if (!fs.existsSync(alertDir)) {
            fs.mkdirSync(alertDir, { recursive: true });
        }

        const alerts = fs.existsSync(alertFile)
            ? JSON.parse(fs.readFileSync(alertFile, 'utf8'))
            : [];

        alerts.push({
            timestamp: new Date().toISOString(),
            message: msg,
            read: false
        });

        // Keep last 50 alerts
        while (alerts.length > 50) alerts.shift();

        fs.writeFileSync(alertFile, JSON.stringify(alerts, null, 2));

        // Also try Discord webhook if configured
        await sendWebhook(msg);
    };
} catch (e) {
    console.log('Alert system initialized (console only)');
}

// Discord webhook sender
async function sendWebhook(message) {
    try {
        const fs = require('fs');
        const configPath = path.join(__dirname, '..', 'config', 'webhooks.json');

        if (!fs.existsSync(configPath)) return;

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const webhookUrl = config.webhooks?.trading || config.webhooks?.default;

        if (!webhookUrl) return;

        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: message,
                username: 'Trade Monitor'
            })
        });

        console.log('[Webhook sent]');
    } catch (e) {
        // Webhook failed, that's ok
    }
}

/**
 * Check positions and generate status report
 */
async function checkPositions() {
    try {
        const clock = await alpaca.getClock();
        const account = await alpaca.getAccount();
        const positions = await alpaca.getPositions();
        const orders = await alpaca.getOrders('open');

        return {
            marketOpen: clock.is_open,
            nextOpen: clock.next_open,
            nextClose: clock.next_close,
            equity: parseFloat(account.equity),
            cash: parseFloat(account.cash),
            buyingPower: parseFloat(account.buying_power),
            positions: positions.map(p => ({
                symbol: p.symbol,
                qty: parseFloat(p.qty),
                avgEntry: parseFloat(p.avg_entry_price),
                currentPrice: parseFloat(p.current_price),
                marketValue: parseFloat(p.market_value),
                unrealizedPL: parseFloat(p.unrealized_pl),
                unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100
            })),
            openOrders: orders.map(o => ({
                id: o.id,
                symbol: o.symbol,
                side: o.side,
                qty: o.qty,
                type: o.type,
                status: o.status
            })),
            timestamp: new Date().toISOString()
        };
    } catch (e) {
        console.error('Error checking positions:', e.message);
        return { error: e.message };
    }
}

/**
 * Format status for Discord/alert
 */
function formatAlert(status) {
    if (status.error) {
        return `**TRADE MONITOR ERROR**\n${status.error}`;
    }

    const marketStatus = status.marketOpen ? '🟢 OPEN' : '🔴 CLOSED';

    let msg = `**HOURLY TRADE CHECK** (${new Date().toLocaleTimeString()})\n\n`;
    msg += `Market: ${marketStatus}\n`;
    msg += `Equity: $${status.equity.toLocaleString()}\n\n`;

    if (status.positions.length > 0) {
        msg += `**Positions:**\n`;
        for (const p of status.positions) {
            const emoji = p.unrealizedPL >= 0 ? '🟢' : '🔴';
            msg += `${emoji} ${p.symbol}: ${p.qty} @ $${p.avgEntry.toFixed(2)} → $${p.currentPrice.toFixed(2)} (${p.unrealizedPLPct >= 0 ? '+' : ''}${p.unrealizedPLPct.toFixed(1)}%)\n`;
        }

        const totalPL = status.positions.reduce((sum, p) => sum + p.unrealizedPL, 0);
        msg += `\nTotal P/L: ${totalPL >= 0 ? '🟢' : '🔴'} $${totalPL.toFixed(2)}\n`;
    } else {
        msg += `**Positions:** None\n`;
    }

    if (status.openOrders.length > 0) {
        msg += `\n**Open Orders:** ${status.openOrders.length}\n`;
        for (const o of status.openOrders) {
            msg += `• ${o.side.toUpperCase()} ${o.qty} ${o.symbol} (${o.status})\n`;
        }
    }

    msg += `\n_Check command: node swing_options/index.js positions_`;

    return msg;
}

/**
 * Main monitoring function
 */
async function monitor(options = {}) {
    console.log(`\n[${new Date().toISOString()}] Running position check...`);

    const status = await checkPositions();

    if (options.statusOnly) {
        console.log(JSON.stringify(status, null, 2));
        return status;
    }

    // Generate alert
    const alert = formatAlert(status);

    // Send alert
    await sendToDiscord(alert);

    // Check for significant moves that need immediate attention
    if (status.positions) {
        for (const p of status.positions) {
            if (p.unrealizedPLPct <= -7) {
                await sendToDiscord(`**STOP LOSS WARNING** ${p.symbol} down ${p.unrealizedPLPct.toFixed(1)}% - Consider exiting!`);
            }
            if (p.unrealizedPLPct >= 15) {
                await sendToDiscord(`**TARGET ALERT** ${p.symbol} up ${p.unrealizedPLPct.toFixed(1)}% - Consider taking profits!`);
            }
        }
    }

    return status;
}

/**
 * Daemon mode - run continuously
 */
async function daemon() {
    const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

    console.log('Starting position monitor daemon...');
    console.log(`Checking every ${CHECK_INTERVAL / 1000 / 60} minutes`);
    console.log('Press Ctrl+C to stop\n');

    // Initial check
    await monitor();

    // Schedule recurring checks
    setInterval(async () => {
        // Only alert during market hours (roughly 9 AM - 5 PM ET)
        const hour = new Date().getHours();
        const isMarketHours = hour >= 9 && hour <= 17;

        if (isMarketHours) {
            await monitor();
        } else {
            console.log(`[${new Date().toISOString()}] Outside market hours, skipping alert`);
        }
    }, CHECK_INTERVAL);

    // Keep process alive
    process.on('SIGINT', () => {
        console.log('\nStopping monitor daemon...');
        process.exit(0);
    });
}

/**
 * Get pending alerts (for main process to read)
 */
function getPendingAlerts() {
    const fs = require('fs');
    const alertFile = path.join(__dirname, '..', 'alerts', 'trade_alerts.json');

    if (!fs.existsSync(alertFile)) return [];

    try {
        const alerts = JSON.parse(fs.readFileSync(alertFile, 'utf8'));
        return alerts.filter(a => !a.read);
    } catch (e) {
        return [];
    }
}

/**
 * Mark alerts as read
 */
function markAlertsRead() {
    const fs = require('fs');
    const alertFile = path.join(__dirname, '..', 'alerts', 'trade_alerts.json');

    if (!fs.existsSync(alertFile)) return;

    try {
        const alerts = JSON.parse(fs.readFileSync(alertFile, 'utf8'));
        alerts.forEach(a => a.read = true);
        fs.writeFileSync(alertFile, JSON.stringify(alerts, null, 2));
    } catch (e) {
        // ignore
    }
}

// Export
module.exports = {
    checkPositions,
    monitor,
    daemon,
    formatAlert,
    getPendingAlerts,
    markAlertsRead
};

// CLI
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'daemon':
        case 'start':
            daemon();
            break;

        case 'status':
            monitor({ statusOnly: true });
            break;

        default:
            // Single check with alert
            monitor().then(() => {
                console.log('\nMonitor check complete.');
                // Give time for webhook
                setTimeout(() => process.exit(0), 2000);
            });
    }
}
