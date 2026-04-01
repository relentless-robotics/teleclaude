#!/usr/bin/env node
/**
 * discord_notify.js — CLI tool for sending Discord messages from compute scripts.
 *
 * Uses Bot token from config.json and channel IDs from discord_channels.json.
 * Can be called from Python or shell scripts.
 *
 * Usage:
 *   node compute/discord_notify.js "message text"
 *   node compute/discord_notify.js --channel alerts "error message"
 *   node compute/discord_notify.js --channel system-status "status update"
 *
 * Exit code 0 on success, 1 on failure.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CHANNELS_FILE = path.join(ROOT, 'trading_agents', 'data', 'discord_channels.json');

function loadBotToken() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).discordToken || '';
  } catch { return ''; }
}

function loadChannelId(name) {
  try {
    const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    const map = {
      'system-status': 'systemStatus',
      'alerts': 'alerts',
      'general': 'general',
      'pnl': 'pnl',
    };
    const key = map[name] || name;
    return data.channels?.[key] || '';
  } catch { return ''; }
}

function sendMessage(channelId, message, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content: message.slice(0, 2000) });
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bot ${token}`,
        'User-Agent': 'RayOrchestrator/1.0',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  let channel = 'system-status';
  let message = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && i + 1 < args.length) {
      channel = args[++i];
    } else {
      message += (message ? ' ' : '') + args[i];
    }
  }

  if (!message) {
    console.error('Usage: node compute/discord_notify.js [--channel NAME] "message"');
    process.exit(1);
  }

  const token = loadBotToken();
  if (!token) { console.error('No bot token in config.json'); process.exit(1); }

  const channelId = loadChannelId(channel);
  if (!channelId) { console.error(`Unknown channel: ${channel}`); process.exit(1); }

  try {
    await sendMessage(channelId, message, token);
    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
}

main();
