/**
 * Standalone Discord channel notifier for QCC/orchestrator processes.
 * Uses the Discord REST API directly (no bot client needed).
 * Posts to #system-status by default.
 *
 * Usage:
 *   const notify = require('./utils/discord_notify');
 *   await notify.send('Experiment complete: IC=0.15', 'systemStatus');
 *   await notify.sendEmbed({ title: 'Job Done', fields: [...] }, 'alerts');
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const CHANNELS_FILE = path.join(__dirname, '..', 'trading_agents', 'data', 'discord_channels.json');

let _token = null;
let _channels = {};

function loadToken() {
  if (_token) return _token;
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _token = config.discordToken;
  } catch (e) {
    console.error('[discord_notify] Failed to load token:', e.message);
  }
  return _token;
}

function loadChannels() {
  if (Object.keys(_channels).length > 0) return _channels;
  try {
    const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    _channels = data.channels || {};
  } catch (e) {
    console.error('[discord_notify] Failed to load channels:', e.message);
  }
  return _channels;
}

function discordPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const token = loadToken();
    if (!token) return reject(new Error('No Discord token'));

    const payload = JSON.stringify(body);
    const options = {
      hostname: 'discord.com',
      path: `/api/v10${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'QCC-Notifier/1.0',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(new Error(`Discord ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send a plain text message to a Discord channel.
 * @param {string} message - Text content (max 2000 chars, auto-chunked)
 * @param {string} channel - Channel name from discord_channels.json (default: systemStatus)
 */
async function send(message, channel = 'systemStatus') {
  const channels = loadChannels();
  const channelId = channels[channel];
  if (!channelId) throw new Error(`Unknown channel: ${channel}`);

  const MAX = 1950;
  const chunks = [];
  let text = message;
  while (text.length > 0) {
    if (text.length <= MAX) { chunks.push(text); break; }
    let i = text.lastIndexOf('\n', MAX);
    if (i < 500) i = text.lastIndexOf(' ', MAX);
    if (i < 500) i = MAX;
    chunks.push(text.slice(0, i));
    text = text.slice(i).trim();
  }

  for (const chunk of chunks) {
    await discordPost(`/channels/${channelId}/messages`, { content: chunk });
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
  return chunks.length;
}

/**
 * Send an embed to a Discord channel.
 * @param {object} embed - Discord embed object { title, description, fields, color }
 * @param {string} channel - Channel name (default: systemStatus)
 */
async function sendEmbed(embed, channel = 'systemStatus') {
  const channels = loadChannels();
  const channelId = channels[channel];
  if (!channelId) throw new Error(`Unknown channel: ${channel}`);

  const colors = { success: 0x00ff00, warning: 0xffaa00, error: 0xff0000, info: 0x0099ff };
  if (typeof embed.color === 'string') embed.color = colors[embed.color] || 0x0099ff;
  if (!embed.timestamp) embed.timestamp = new Date().toISOString();

  await discordPost(`/channels/${channelId}/messages`, { embeds: [embed] });
}

module.exports = { send, sendEmbed };
