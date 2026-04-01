/**
 * Discord Webhook Notifier
 *
 * Sends notifications to Discord via webhooks for task completion,
 * rate limits, errors, and other important events.
 *
 * Setup: Add your webhook URL to config/webhooks.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'webhooks.json');
const MAIN_CONFIG = path.join(__dirname, '..', 'config.json');
const CHANNELS_FILE = path.join(__dirname, '..', 'trading_agents', 'data', 'discord_channels.json');

/**
 * Load webhook configuration
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading webhook config:', e.message);
  }
  return { webhooks: {} };
}

/**
 * Save webhook configuration
 */
function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Send message to Discord webhook
 */
async function sendWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);

    const data = JSON.stringify(payload);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, statusCode: res.statusCode });
        } else {
          reject(new Error(`Webhook failed: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Notification types with colors and emojis
 */
const NOTIFICATION_TYPES = {
  success: { color: 0x4ade80, emoji: '✅' },
  error: { color: 0xef4444, emoji: '❌' },
  warning: { color: 0xfbbf24, emoji: '⚠️' },
  info: { color: 0x3b82f6, emoji: 'ℹ️' },
  task_complete: { color: 0x8b5cf6, emoji: '🎉' },
  task_failed: { color: 0xef4444, emoji: '💥' },
  rate_limit: { color: 0xf97316, emoji: '🚫' },
  auth_failed: { color: 0xdc2626, emoji: '🔐' },
  captcha: { color: 0xeab308, emoji: '🤖' }
};

/**
 * Create Discord embed message
 */
function createEmbed(type, title, description, fields = []) {
  const notifType = NOTIFICATION_TYPES[type] || NOTIFICATION_TYPES.info;

  return {
    embeds: [{
      title: `${notifType.emoji} ${title}`,
      description: description,
      color: notifType.color,
      fields: fields.map(f => ({
        name: f.name,
        value: String(f.value).slice(0, 1024),
        inline: f.inline !== false
      })),
      timestamp: new Date().toISOString(),
      footer: {
        text: 'TeleClaude Notification'
      }
    }]
  };
}

/**
 * Send message to Discord channel via Bot API (fallback when no webhook URL configured)
 */
async function sendViaBotToken(channelId, payload) {
  let botToken = null;
  try {
    const config = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
    botToken = config.discordToken;
  } catch (e) { /* no config */ }
  if (!botToken) throw new Error('No bot token in config.json');

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, statusCode: res.statusCode });
        } else {
          reject(new Error(`Bot API failed: ${res.statusCode} - ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Resolve target channel ID for a notification type
 */
function resolveChannelId(notifType) {
  try {
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
    // Route alerts/errors to #alerts, everything else to #system-status
    if (['error', 'task_failed', 'auth_failed', 'rate_limit'].includes(notifType)) {
      return channels.channels?.alerts || channels.channels?.systemStatus || null;
    }
    return channels.channels?.systemStatus || null;
  } catch (e) { return null; }
}

/**
 * Send notification to configured webhook
 * Falls back to Discord Bot API if no webhook URL is set but a bot token exists.
 */
async function notify(type, title, description, fields = []) {
  const config = loadConfig();
  const webhookUrl = config.webhooks?.default || config.webhooks?.notifications;
  const payload = createEmbed(type, title, description, fields);

  // Try webhook URL first
  if (webhookUrl) {
    try {
      await sendWebhook(webhookUrl, payload);
      return { success: true };
    } catch (e) {
      console.error('[Webhook] Failed to send:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Fallback: use Discord Bot token + channel ID
  const channelId = resolveChannelId(type);
  if (channelId) {
    try {
      await sendViaBotToken(channelId, payload);
      return { success: true, via: 'bot_api' };
    } catch (e) {
      console.error('[Webhook] Bot API fallback failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  console.log('[Webhook] No webhook or bot token configured. Notification:', title);
  return { success: false, reason: 'No webhook or bot token configured' };
}

/**
 * Convenience methods for common notifications
 */
const notifications = {
  taskComplete: (taskName, details = '') =>
    notify('task_complete', 'Task Completed', `**${taskName}**\n${details}`),

  taskFailed: (taskName, error) =>
    notify('task_failed', 'Task Failed', `**${taskName}**`, [
      { name: 'Error', value: error, inline: false }
    ]),

  rateLimit: (resetTime = 'Unknown') =>
    notify('rate_limit', 'Rate Limit Hit', 'Claude API rate limit reached.', [
      { name: 'Resets At', value: resetTime, inline: true }
    ]),

  authFailed: (service, reason = '') =>
    notify('auth_failed', 'Authentication Failed', `Failed to authenticate with **${service}**`, [
      { name: 'Reason', value: reason || 'Unknown', inline: false }
    ]),

  captchaDetected: (site, screenshotPath = '') =>
    notify('captcha', 'CAPTCHA Detected', `CAPTCHA encountered on **${site}**`, [
      { name: 'Action Required', value: 'Please solve the CAPTCHA', inline: false },
      ...(screenshotPath ? [{ name: 'Screenshot', value: screenshotPath, inline: false }] : [])
    ]),

  warning: (title, message) =>
    notify('warning', title, message),

  error: (title, message) =>
    notify('error', title, message),

  info: (title, message) =>
    notify('info', title, message),

  success: (title, message) =>
    notify('success', title, message),

  budgetWarning: (percentUsed, remaining) =>
    notify('warning', 'Budget Warning', `Daily token budget is ${percentUsed}% used.`, [
      { name: 'Remaining', value: `$${remaining.toFixed(2)}`, inline: true },
      { name: 'Status', value: percentUsed >= 95 ? 'CRITICAL' : 'WARNING', inline: true }
    ])
};

/**
 * Set up webhook URL
 */
function setupWebhook(name, url) {
  const config = loadConfig();
  if (!config.webhooks) config.webhooks = {};
  config.webhooks[name] = url;
  saveConfig(config);
  return { success: true, message: `Webhook '${name}' configured` };
}

/**
 * List configured webhooks
 */
function listWebhooks() {
  const config = loadConfig();
  return Object.keys(config.webhooks || {}).map(name => ({
    name,
    configured: !!config.webhooks[name],
    url: config.webhooks[name] ? '***configured***' : null
  }));
}

/**
 * Test webhook connection
 */
async function testWebhook(name = 'default') {
  const config = loadConfig();
  const url = config.webhooks?.[name];

  if (!url) {
    return { success: false, error: `Webhook '${name}' not configured` };
  }

  try {
    await sendWebhook(url, {
      embeds: [{
        title: '🧪 Webhook Test',
        description: 'This is a test notification from TeleClaude.',
        color: 0x3b82f6,
        timestamp: new Date().toISOString()
      }]
    });
    return { success: true, message: 'Test notification sent successfully' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  notify,
  notifications,
  setupWebhook,
  listWebhooks,
  testWebhook,
  sendWebhook,
  createEmbed,
  NOTIFICATION_TYPES
};
