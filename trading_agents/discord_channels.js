/**
 * Discord Multi-Channel Manager
 *
 * Posts directly to Discord channels via REST API.
 * No webhooks needed - uses bot token + channel IDs.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load bot token from config.json
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const CHANNELS_FILE = path.join(__dirname, 'data', 'discord_channels.json');

let botToken = null;
let channelIds = {};

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    botToken = config.discordToken;
  } catch (e) {
    console.error('[discord_channels] Could not load config.json:', e.message);
  }
}

function loadChannelIds() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
      channelIds = data.channels || {};
    }
  } catch (e) {
    console.error('[discord_channels] Could not load channel IDs:', e.message);
  }
}

loadConfig();
loadChannelIds();

// Channel key mapping (convenience names -> channel config keys)
const CHANNEL_KEY_MAP = {
  systemStatus: 'systemStatus',
  preMarket: 'preMarket',
  swingScanner: 'swingScanner',
  afterHours: 'afterHours',
  overnight: 'overnight',
  tradeExecutions: 'tradeExecution',
  alerts: 'alerts',
  pnl: 'pnl',
  errors: 'systemStatus',
  watchlist: 'general',
  research: 'general',
  optionsFlow: 'alerts',
  mainChat: 'general',
};

/**
 * Discord REST API call
 */
function discordAPI(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    if (!botToken) {
      reject(new Error('Bot token not loaded'));
      return;
    }

    const options = {
      hostname: 'discord.com',
      path: `/api/v10${endpoint}`,
      method,
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'TradingAgent/1.0',
      },
    };

    if (body) {
      const payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`Discord API ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Send message to a Discord channel by ID (handles 2000 char chunking)
 */
async function sendToChannelById(channelId, message) {
  const MAX = 2000;
  const chunks = [];
  let text = message;

  while (text.length > 0) {
    if (text.length <= MAX) {
      chunks.push(text);
      break;
    }
    let i = text.lastIndexOf('\n', MAX);
    if (i < 500) i = text.lastIndexOf(' ', MAX);
    if (i < 500) i = MAX;
    chunks.push(text.slice(0, i));
    text = text.slice(i).trim();
  }

  for (const chunk of chunks) {
    await discordAPI('POST', `/channels/${channelId}/messages`, { content: chunk });
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }

  return chunks.length;
}

class DiscordChannels {
  constructor() {
    this.fallbackSend = null;
  }

  /**
   * Set fallback send function (from main bridge)
   */
  setFallbackSend(sendFn) {
    this.fallbackSend = sendFn;
  }

  /**
   * Reload config (if token or channels changed)
   */
  reload() {
    loadConfig();
    loadChannelIds();
  }

  /**
   * Send to a specific channel by key name
   */
  async send(channel, message) {
    const configKey = CHANNEL_KEY_MAP[channel] || channel;
    const channelId = channelIds[configKey];

    // 1. Try direct Discord REST API (primary method)
    if (botToken && channelId) {
      try {
        await sendToChannelById(channelId, message);
        return { success: true, method: 'rest-api', channel: configKey };
      } catch (e) {
        console.error(`[discord_channels] REST API failed for ${configKey}:`, e.message);
      }
    }

    // 2. Fallback to main send function (DM)
    if (this.fallbackSend) {
      const prefix = this.getChannelPrefix(channel);
      await this.fallbackSend(`${prefix}\n${message}`);
      return { success: true, method: 'fallback-dm', channel: configKey };
    }

    // 3. Console only
    console.log(`[${channel}] ${message}`);
    return { success: true, method: 'console', channel: configKey };
  }

  /**
   * Get channel prefix emoji (used in fallback mode)
   */
  getChannelPrefix(channel) {
    const prefixes = {
      systemStatus: '⚙️ **[SYSTEM]**',
      mainChat: '💬',
      preMarket: '🌅 **[PRE-MARKET]**',
      swingScanner: '📊 **[SWING SCANNER]**',
      afterHours: '🔬 **[AFTER HOURS]**',
      overnight: '🌙 **[OVERNIGHT]**',
      tradeExecutions: '💰 **[TRADE]**',
      alerts: '🚨 **[ALERT]**',
      watchlist: '👀 **[WATCHLIST]**',
      pnl: '📈 **[P&L]**',
      research: '📚 **[RESEARCH]**',
      optionsFlow: '🎯 **[OPTIONS]**',
      errors: '❌ **[ERROR]**',
    };
    return prefixes[channel] || `[${channel.toUpperCase()}]`;
  }

  // ============================================================================
  // Convenience Methods
  // ============================================================================

  async systemStatus(message) { return this.send('systemStatus', message); }
  async preMarket(message) { return this.send('preMarket', message); }
  async swingScanner(message) { return this.send('swingScanner', message); }
  async afterHours(message) { return this.send('afterHours', message); }
  async overnight(message) { return this.send('overnight', message); }
  async tradeExecution(message) { return this.send('tradeExecutions', message); }
  async alert(message) { return this.send('alerts', message); }
  async watchlist(message) { return this.send('watchlist', message); }
  async pnl(message) { return this.send('pnl', message); }
  async research(message) { return this.send('research', message); }
  async optionsFlow(message) { return this.send('optionsFlow', message); }
  async error(message) { return this.send('errors', message); }

  /**
   * Check connectivity
   */
  getStatus() {
    return {
      hasToken: !!botToken,
      channelsLoaded: Object.keys(channelIds).length,
      channels: Object.keys(channelIds),
      hasFallback: !!this.fallbackSend,
    };
  }
}

module.exports = new DiscordChannels();
