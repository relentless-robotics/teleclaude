#!/usr/bin/env node
/**
 * MCP Server for Discord Bridge
 * Provides a send_to_discord tool that writes to the output file
 * Claude Code reads this tool via MCP protocol
 * Cross-platform Windows/Unix compatible
 * With logging for debugging
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// Cross-platform output file location
const isWindows = process.platform === 'win32';
const OUTPUT_FILE = isWindows
  ? path.join(os.tmpdir(), 'discord-response.txt')
  : '/tmp/discord-response.txt';

// Logging setup
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, `mcp-discord-${new Date().toISOString().split('T')[0]}.log`);

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Ensure the temp directory exists (should always exist, but just in case)
const tempDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

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

  try {
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
  } catch (e) {
    // Can't log, ignore
  }
}

// Read JSON-RPC messages from stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  log('DEBUG', `Sending response for id=${id}`, result);
  process.stdout.write(response + '\n');
}

function respondError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  log('ERROR', `Sending error response for id=${id}`, { code, message });
  process.stdout.write(response + '\n');
}

log('INFO', 'Discord MCP Server starting');

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    log('DEBUG', `Received RPC: ${method}`, { id, params: params ? '...' : null });

    if (method === 'initialize') {
      log('INFO', 'Initialize request received');
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'discord-bridge', version: '1.0.0' }
      });
    }
    else if (method === 'tools/list') {
      log('INFO', 'Tools list requested');
      respond(id, {
        tools: [{
          name: 'send_to_discord',
          description: 'Send a message to the Discord user. Use this to respond to the user - they cannot see your terminal output.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The message to send to the Discord user'
              }
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
              file_path: {
                type: 'string',
                description: 'The absolute path to the file to send'
              },
              message: {
                type: 'string',
                description: 'Optional message to accompany the file'
              }
            },
            required: ['file_path']
          }
        }]
      });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;

      log('INFO', `Tool call: ${name}`, {
        messageLength: args?.message?.length || 0,
        messagePreview: args?.message?.slice(0, 200) || '',
      });

      if (name === 'send_to_discord') {
        const message = args?.message || '';

        if (!message) {
          log('WARN', 'send_to_discord called with empty message');
        }

        try {
          fs.writeFileSync(OUTPUT_FILE, message, 'utf8');
          log('INFO', 'Message written to output file successfully', {
            outputFile: OUTPUT_FILE,
            messageLength: message.length,
          });
          respond(id, {
            content: [{ type: 'text', text: 'Message sent to Discord user.' }]
          });
        } catch (writeError) {
          log('ERROR', 'Failed to write to output file', {
            error: writeError.message,
            outputFile: OUTPUT_FILE,
          });
          respondError(id, -32000, `Failed to write message: ${writeError.message}`);
        }
      }
      else if (name === 'send_file_to_discord') {
        const filePath = args?.file_path || '';
        const message = args?.message || '';

        if (!filePath) {
          log('WARN', 'send_file_to_discord called without file_path');
          respondError(id, -32000, 'file_path is required');
          return;
        }

        // Verify file exists
        if (!fs.existsSync(filePath)) {
          log('WARN', 'send_file_to_discord called with non-existent file', { filePath });
          respondError(id, -32000, `File not found: ${filePath}`);
          return;
        }

        // Write to a special file that the Discord bridge will pick up
        const fileRequestPath = OUTPUT_FILE.replace('.txt', '-file-request.json');
        const request = JSON.stringify({
          filePath,
          message,
          timestamp: Date.now()
        });

        try {
          // Write the request file
          fs.writeFileSync(fileRequestPath, request, 'utf8');
          log('INFO', 'File request written to bridge', {
            filePath,
            messageLength: message.length,
            requestPath: fileRequestPath,
            fileSize: fs.statSync(filePath).size
          });

          // Also log to stdout for debugging
          console.error(`[FILE SEND] Written request: ${fileRequestPath}`);

          respond(id, {
            content: [{ type: 'text', text: `File queued for sending: ${filePath}` }]
          });
        } catch (writeError) {
          log('ERROR', 'Failed to write file request to bridge', {
            error: writeError.message,
            errorCode: writeError.code,
            requestPath: fileRequestPath
          });
          respondError(id, -32000, `Failed to queue file: ${writeError.message}`);
        }
      }
      else {
        log('WARN', `Unknown tool requested: ${name}`);
        respondError(id, -32601, `Unknown tool: ${name}`);
      }
    }
    else if (method === 'notifications/initialized') {
      log('INFO', 'Client initialized notification received');
      // No response needed for notifications
    }
    else {
      log('WARN', `Unknown method: ${method}`);
      respondError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    log('ERROR', 'Parse error', { error: e.message, line: line.slice(0, 200) });
    process.stderr.write('Parse error: ' + e.message + '\n');
  }
});

rl.on('close', () => {
  log('INFO', 'Discord MCP Server stdin closed, shutting down');
});

process.on('exit', (code) => {
  log('INFO', `Discord MCP Server exiting with code ${code}`);
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception in Discord MCP server', { error: e.message, stack: e.stack });
});

log('INFO', 'Discord MCP Server ready');
process.stderr.write('Discord bridge MCP server started\n');
