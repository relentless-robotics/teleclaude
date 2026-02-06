#!/usr/bin/env node
/**
 * MCP Server for Discord Bridge
 *
 * Tools:
 * - send_to_discord: Send DM to user (via output file)
 * - send_file_to_discord: Send file to user (via output file)
 * - send_to_channel: Send message to a specific server channel (direct API)
 * - read_channel: Read recent messages from a server channel (direct API)
 * - list_channels: List available trading channels
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const https = require('https');

// Cross-platform output file location
const isWindows = process.platform === 'win32';
const OUTPUT_FILE = isWindows
  ? path.join(os.tmpdir(), 'discord-response.txt')
  : '/tmp/discord-response.txt';

// Config paths
const BRIDGE_DIR = path.join(__dirname, '..');
const CONFIG_FILE = path.join(BRIDGE_DIR, 'config.json');
const CHANNELS_FILE = path.join(BRIDGE_DIR, 'trading_agents', 'data', 'discord_channels.json');

// Logging setup
const LOGS_DIR = path.join(BRIDGE_DIR, 'logs');
const LOG_FILE = path.join(LOGS_DIR, `mcp-discord-${new Date().toISOString().split('T')[0]}.log`);

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const tempDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// Load config
let botToken = null;
let channelMap = {};
let channelNameToId = {};

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    botToken = config.discordToken;
  } catch (e) {
    log('WARN', 'Could not load config.json', { error: e.message });
  }
}

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
      channelMap = data.channels || {};
      // Build name-to-id map (both key names and channel names)
      channelNameToId = {};
      const keyToName = {
        general: 'general',
        preMarket: 'pre-market',
        swingScanner: 'swing-scanner',
        afterHours: 'after-hours',
        overnight: 'overnight',
        tradeExecution: 'trade-execution',
        alerts: 'alerts',
        pnl: 'pnl',
        systemStatus: 'system-status'
      };
      for (const [key, id] of Object.entries(channelMap)) {
        channelNameToId[key] = id;
        if (keyToName[key]) channelNameToId[keyToName[key]] = id;
      }
      log('INFO', 'Loaded channel config', { channelCount: Object.keys(channelMap).length });
    }
  } catch (e) {
    log('WARN', 'Could not load channel config', { error: e.message });
  }
}

loadConfig();
loadChannels();

/**
 * Write to MCP log file
 */
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    try {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      entry += `\n  DATA: ${dataStr}`;
    } catch (e) {
      entry += `\n  DATA: [Unable to serialize]`;
    }
  }
  entry += '\n';
  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (e) {}
}

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
      method: method,
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'TradingBot/1.0',
      }
    };

    if (body) {
      const payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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
 * Send message to a Discord channel (handles chunking for 2000 char limit)
 */
async function sendToChannel(channelId, message) {
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

/**
 * Read messages from a Discord channel
 */
async function readChannel(channelId, limit = 10) {
  const messages = await discordAPI('GET', `/channels/${channelId}/messages?limit=${limit}`);
  return messages.map(m => ({
    author: m.author.username + (m.author.bot ? ' [BOT]' : ''),
    content: m.content,
    timestamp: m.timestamp,
    id: m.id
  })).reverse(); // Chronological order
}

/**
 * Resolve channel name/key to ID
 */
function resolveChannelId(channel) {
  // Direct ID
  if (/^\d+$/.test(channel)) return channel;
  // Key or name lookup
  return channelNameToId[channel] || null;
}

// JSON-RPC handling
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  log('DEBUG', `Response for id=${id}`, result);
  process.stdout.write(response + '\n');
}

function respondError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  log('ERROR', `Error response for id=${id}`, { code, message });
  process.stdout.write(response + '\n');
}

log('INFO', 'Discord MCP Server starting');

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    log('DEBUG', `Received RPC: ${method}`, { id });

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'discord-bridge', version: '2.0.0' }
      });
    }
    else if (method === 'tools/list') {
      respond(id, {
        tools: [
          {
            name: 'send_to_discord',
            description: 'Send a message to the Discord user. Use this to respond to the user - they cannot see your terminal output.',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'The message to send to the Discord user' }
              },
              required: ['message']
            }
          },
          {
            name: 'send_file_to_discord',
            description: 'Send a file to the Discord user. Use this to send screenshots, images, or other files.',
            inputSchema: {
              type: 'object',
              properties: {
                file_path: { type: 'string', description: 'The absolute path to the file to send' },
                message: { type: 'string', description: 'Optional message to accompany the file' }
              },
              required: ['file_path']
            }
          },
          {
            name: 'send_to_channel',
            description: 'Send a message to a specific Discord server channel. Use channel names like "pre-market", "overnight", "alerts", "swing-scanner", "after-hours", "trade-execution", "pnl", "system-status", or "general".',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string', description: 'Channel name (e.g. "overnight", "pre-market", "alerts") or channel ID' },
                message: { type: 'string', description: 'The message to send' }
              },
              required: ['channel', 'message']
            }
          },
          {
            name: 'read_channel',
            description: 'Read recent messages from a Discord server channel. Returns messages in chronological order.',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string', description: 'Channel name (e.g. "overnight", "alerts") or channel ID' },
                limit: { type: 'number', description: 'Number of messages to fetch (default 10, max 50)' }
              },
              required: ['channel']
            }
          },
          {
            name: 'list_channels',
            description: 'List all available trading channels in the Discord server.',
            inputSchema: {
              type: 'object',
              properties: {},
            }
          }
        ]
      });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      log('INFO', `Tool call: ${name}`, { args: args ? JSON.stringify(args).slice(0, 200) : null });

      // === send_to_discord (DM via output file) ===
      if (name === 'send_to_discord') {
        const message = args?.message || '';
        try {
          fs.writeFileSync(OUTPUT_FILE, message, 'utf8');
          respond(id, { content: [{ type: 'text', text: 'Message sent to Discord user.' }] });
        } catch (e) {
          respondError(id, -32000, `Failed to write message: ${e.message}`);
        }
      }

      // === send_file_to_discord ===
      else if (name === 'send_file_to_discord') {
        const filePath = args?.file_path || '';
        const message = args?.message || '';
        if (!filePath) { respondError(id, -32000, 'file_path is required'); return; }
        if (!fs.existsSync(filePath)) { respondError(id, -32000, `File not found: ${filePath}`); return; }

        const fileRequestPath = OUTPUT_FILE.replace('.txt', '-file-request.json');
        try {
          fs.writeFileSync(fileRequestPath, JSON.stringify({ filePath, message, timestamp: Date.now() }), 'utf8');
          respond(id, { content: [{ type: 'text', text: `File queued for sending: ${filePath}` }] });
        } catch (e) {
          respondError(id, -32000, `Failed to queue file: ${e.message}`);
        }
      }

      // === send_to_channel (direct Discord API) ===
      else if (name === 'send_to_channel') {
        const channel = args?.channel || '';
        const message = args?.message || '';
        if (!channel || !message) { respondError(id, -32000, 'channel and message are required'); return; }

        // Reload channels in case they changed
        loadChannels();

        const channelId = resolveChannelId(channel);
        if (!channelId) {
          const available = Object.keys(channelNameToId).filter(k => !k.includes('_') || k.includes('-')).join(', ');
          respondError(id, -32000, `Unknown channel "${channel}". Available: ${available}`);
          return;
        }

        try {
          const chunkCount = await sendToChannel(channelId, message);
          log('INFO', `Sent to channel ${channel} (${channelId})`, { chunks: chunkCount });
          respond(id, { content: [{ type: 'text', text: `Message sent to #${channel} (${chunkCount} chunk${chunkCount > 1 ? 's' : ''}).` }] });
        } catch (e) {
          log('ERROR', `Failed to send to channel ${channel}`, { error: e.message });
          respondError(id, -32000, `Failed to send to #${channel}: ${e.message}`);
        }
      }

      // === read_channel (direct Discord API) ===
      else if (name === 'read_channel') {
        const channel = args?.channel || '';
        const limit = Math.min(args?.limit || 10, 50);
        if (!channel) { respondError(id, -32000, 'channel is required'); return; }

        loadChannels();

        const channelId = resolveChannelId(channel);
        if (!channelId) {
          respondError(id, -32000, `Unknown channel "${channel}"`);
          return;
        }

        try {
          const messages = await readChannel(channelId, limit);
          let formatted = messages.map(m => {
            const time = new Date(m.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
            const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
            return `[${time}] ${m.author}: ${content}`;
          }).join('\n\n');

          if (!formatted) formatted = '(No messages in this channel)';

          respond(id, { content: [{ type: 'text', text: `#${channel} - Last ${messages.length} messages:\n\n${formatted}` }] });
        } catch (e) {
          log('ERROR', `Failed to read channel ${channel}`, { error: e.message });
          respondError(id, -32000, `Failed to read #${channel}: ${e.message}`);
        }
      }

      // === list_channels ===
      else if (name === 'list_channels') {
        loadChannels();

        if (Object.keys(channelMap).length === 0) {
          respond(id, { content: [{ type: 'text', text: 'No channels configured. Run channel setup first.' }] });
          return;
        }

        const keyToName = {
          general: 'general',
          preMarket: 'pre-market',
          swingScanner: 'swing-scanner',
          afterHours: 'after-hours',
          overnight: 'overnight',
          tradeExecution: 'trade-execution',
          alerts: 'alerts',
          pnl: 'pnl',
          systemStatus: 'system-status'
        };

        let list = 'Available channels:\n';
        for (const [key, chId] of Object.entries(channelMap)) {
          const name = keyToName[key] || key;
          list += `  #${name} (${key}) - ID: ${chId}\n`;
        }

        respond(id, { content: [{ type: 'text', text: list }] });
      }

      else {
        respondError(id, -32601, `Unknown tool: ${name}`);
      }
    }
    else if (method === 'notifications/initialized') {
      // No response needed
    }
    else {
      respondError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    log('ERROR', 'Parse error', { error: e.message, line: line.slice(0, 200) });
    process.stderr.write('Parse error: ' + e.message + '\n');
  }
});

rl.on('close', () => log('INFO', 'MCP Server stdin closed'));
process.on('exit', (code) => log('INFO', `MCP Server exiting with code ${code}`));
process.on('uncaughtException', (e) => log('ERROR', 'Uncaught exception', { error: e.message, stack: e.stack }));

log('INFO', 'Discord MCP Server ready (v2.0 - with channel support)');
process.stderr.write('Discord bridge MCP server started (v2.0)\n');
