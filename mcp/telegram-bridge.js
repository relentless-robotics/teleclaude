#!/usr/bin/env node
/**
 * MCP Server for Telegram Bridge
 * Provides a send_to_telegram tool that writes to the output file
 * Claude Code reads this tool via MCP protocol
 * Cross-platform Windows/Unix compatible
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// Cross-platform output file location
const isWindows = process.platform === 'win32';
const OUTPUT_FILE = isWindows
  ? path.join(os.tmpdir(), 'tg-response.txt')
  : '/tmp/tg-response.txt';

// Ensure the temp directory exists (should always exist, but just in case)
const tempDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Read JSON-RPC messages from stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

function respondError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(response + '\n');
}

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'telegram-bridge', version: '1.0.0' }
      });
    }
    else if (method === 'tools/list') {
      respond(id, {
        tools: [{
          name: 'send_to_telegram',
          description: 'Send a message to the Telegram user. Use this to respond to the user - they cannot see your terminal output.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The message to send to the Telegram user'
              }
            },
            required: ['message']
          }
        }]
      });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;

      if (name === 'send_to_telegram') {
        const message = args?.message || '';
        fs.writeFileSync(OUTPUT_FILE, message, 'utf8');
        respond(id, {
          content: [{ type: 'text', text: 'Message sent to Telegram user.' }]
        });
      } else {
        respondError(id, -32601, `Unknown tool: ${name}`);
      }
    }
    else if (method === 'notifications/initialized') {
      // No response needed for notifications
    }
    else {
      respondError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    process.stderr.write('Parse error: ' + e.message + '\n');
  }
});

process.stderr.write('Telegram bridge MCP server started\n');
