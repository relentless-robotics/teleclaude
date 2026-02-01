#!/usr/bin/env node
/**
 * MCP Server for Media Generation Tools
 * Provides image generation and text-to-speech tools for Claude Code
 * Cross-platform Windows/Unix compatible
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Import media generation modules
const { generateImage, generateVariations } = require('../utils/image_generator');
const { generateSpeech, generateLongSpeech } = require('../utils/tts_generator');
const { formatImageMessage, formatVoiceMessage } = require('../utils/discord_media');

// Logging setup
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, `mcp-media-${new Date().toISOString().split('T')[0]}.log`);

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
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

function respondError(id, code, message, data = null) {
  const error = { code, message };
  if (data) error.data = data;
  const response = JSON.stringify({ jsonrpc: '2.0', id, error });
  log('ERROR', `Sending error response for id=${id}`, { code, message, data });
  process.stdout.write(response + '\n');
}

log('INFO', 'Media Tools MCP Server starting');

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    log('DEBUG', `Received RPC: ${method}`, { id, params: params ? '...' : null });

    if (method === 'initialize') {
      log('INFO', 'Initialize request received');
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'media-tools', version: '1.0.0' }
      });
    }
    else if (method === 'tools/list') {
      log('INFO', 'Tools list requested');
      respond(id, {
        tools: [
          {
            name: 'generate_image',
            description: 'Generate an image from a text prompt using DALL-E 3. Returns image URL and revised prompt.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'Text description of the image to generate'
                },
                size: {
                  type: 'string',
                  description: 'Image size: 1024x1024, 1792x1024, or 1024x1792',
                  enum: ['1024x1024', '1792x1024', '1024x1792'],
                  default: '1024x1024'
                },
                quality: {
                  type: 'string',
                  description: 'Image quality: standard or hd',
                  enum: ['standard', 'hd'],
                  default: 'standard'
                },
                style: {
                  type: 'string',
                  description: 'Image style: vivid or natural',
                  enum: ['vivid', 'natural'],
                  default: 'vivid'
                }
              },
              required: ['prompt']
            }
          },
          {
            name: 'generate_speech',
            description: 'Convert text to speech using OpenAI TTS. Returns path to generated audio file.',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'Text to convert to speech (max 4096 characters)'
                },
                voice: {
                  type: 'string',
                  description: 'Voice: alloy (neutral), echo (upbeat), fable (expressive), onyx (deep male), nova (friendly female), shimmer (gentle female)',
                  enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
                  default: 'alloy'
                },
                model: {
                  type: 'string',
                  description: 'Model: tts-1 (faster) or tts-1-hd (higher quality)',
                  enum: ['tts-1', 'tts-1-hd'],
                  default: 'tts-1'
                },
                speed: {
                  type: 'number',
                  description: 'Speed (0.25 to 4.0)',
                  minimum: 0.25,
                  maximum: 4.0,
                  default: 1.0
                }
              },
              required: ['text']
            }
          }
        ]
      });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;

      log('INFO', `Tool call: ${name}`, args);

      if (name === 'generate_image') {
        const prompt = args?.prompt;

        if (!prompt) {
          respondError(id, -32602, 'Missing required parameter: prompt');
          return;
        }

        try {
          const result = await generateImage(prompt, {
            size: args?.size,
            quality: args?.quality,
            style: args?.style
          });

          const formatted = formatImageMessage(result.url, prompt, result.revised_prompt);

          respond(id, {
            content: [
              {
                type: 'text',
                text: `Image generated successfully!\n\nURL: ${result.url}\n\nOriginal prompt: ${prompt}\n\nRevised prompt: ${result.revised_prompt}`
              }
            ],
            metadata: {
              url: result.url,
              prompt: prompt,
              revised_prompt: result.revised_prompt
            }
          });
        } catch (error) {
          log('ERROR', 'Image generation failed', { error: error.message });
          respondError(id, -32000, `Image generation failed: ${error.message}`);
        }
      }
      else if (name === 'generate_speech') {
        const text = args?.text;

        if (!text) {
          respondError(id, -32602, 'Missing required parameter: text');
          return;
        }

        if (text.length > 4096) {
          respondError(id, -32602, 'Text too long. Maximum 4096 characters. Use generate_long_speech for longer text.');
          return;
        }

        try {
          const audioPath = await generateSpeech(text, {
            voice: args?.voice,
            model: args?.model,
            speed: args?.speed
          });

          const formatted = formatVoiceMessage(audioPath, text, args?.voice || 'alloy');

          respond(id, {
            content: [
              {
                type: 'text',
                text: `Speech generated successfully!\n\nAudio file: ${audioPath}\n\nVoice: ${args?.voice || 'alloy'}\nModel: ${args?.model || 'tts-1'}\n\nText: "${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"`
              }
            ],
            metadata: {
              audio_path: audioPath,
              text: text,
              voice: args?.voice || 'alloy',
              model: args?.model || 'tts-1'
            }
          });
        } catch (error) {
          log('ERROR', 'TTS generation failed', { error: error.message });
          respondError(id, -32000, `TTS generation failed: ${error.message}`);
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
  log('INFO', 'Media Tools MCP Server stdin closed, shutting down');
});

process.on('exit', (code) => {
  log('INFO', `Media Tools MCP Server exiting with code ${code}`);
});

process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception in Media Tools MCP server', { error: e.message, stack: e.stack });
});

log('INFO', 'Media Tools MCP Server ready');
process.stderr.write('Media tools MCP server started\n');
