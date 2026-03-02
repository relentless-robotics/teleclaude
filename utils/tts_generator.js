/**
 * Text-to-Speech (TTS) Generation Module
 * Uses OpenAI TTS API to convert text to speech audio files
 *
 * Usage:
 *   const { generateSpeech } = require('./utils/tts_generator');
 *   const audioPath = await generateSpeech('Hello, how are you today?');
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Configuration
const AUDIO_DIR = path.join(__dirname, '..', 'audio');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, `tts-gen-${new Date().toISOString().split('T')[0]}.log`);

// Ensure directories exist
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Log function for TTS generation
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

/**
 * Get OpenAI API key from environment or API_KEYS.md
 */
function getOpenAIKey() {
  // First check environment variable
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // TODO: Parse API_KEYS.md if needed
  // For now, return null and let OpenAI SDK handle the error
  return null;
}

/**
 * Available TTS voices:
 * - alloy: Neutral and balanced
 * - echo: Clear and upbeat
 * - fable: Warm and expressive (British accent)
 * - onyx: Deep and authoritative (male)
 * - nova: Friendly and enthusiastic (female)
 * - shimmer: Soft and gentle (female)
 */

/**
 * Generate speech from text using OpenAI TTS
 *
 * @param {string} text - The text to convert to speech
 * @param {Object} options - Generation options
 * @param {string} options.model - Model to use: 'tts-1' (faster) or 'tts-1-hd' (higher quality) (default: 'tts-1')
 * @param {string} options.voice - Voice to use: 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer' (default: 'alloy')
 * @param {string} options.speed - Speed (0.25 to 4.0) (default: 1.0)
 * @param {string} options.format - Output format: 'mp3', 'opus', 'aac', 'flac' (default: 'mp3')
 * @param {string} options.outputPath - Custom output path (optional)
 * @returns {Promise<string>} Path to the generated audio file
 */
async function generateSpeech(text, options = {}) {
  log('INFO', 'TTS generation requested', {
    textLength: text.length,
    textPreview: text.slice(0, 100),
    options
  });

  try {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
      log('ERROR', 'No OpenAI API key found');
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or add to API_KEYS.md');
    }

    const openai = new OpenAI({ apiKey });

    const model = options.model || 'tts-1';
    const voice = options.voice || 'alloy';
    const speed = options.speed || 1.0;
    const format = options.format || 'mp3';

    // Validate inputs
    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    if (!validVoices.includes(voice)) {
      throw new Error(`Invalid voice: ${voice}. Must be one of: ${validVoices.join(', ')}`);
    }

    if (speed < 0.25 || speed > 4.0) {
      throw new Error('Speed must be between 0.25 and 4.0');
    }

    log('INFO', 'Sending request to OpenAI TTS', { model, voice, speed, format });

    const response = await openai.audio.speech.create({
      model: model,
      voice: voice,
      input: text,
      speed: speed,
      response_format: format
    });

    // Determine output path
    const outputPath = options.outputPath || path.join(
      AUDIO_DIR,
      `speech_${Date.now()}_${voice}.${format}`
    );

    // Convert response to buffer and save
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(outputPath, buffer);

    log('INFO', 'TTS generated successfully', {
      outputPath,
      fileSize: buffer.length
    });

    return outputPath;

  } catch (error) {
    log('ERROR', 'TTS generation failed', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Generate speech with automatic text chunking for long content
 * OpenAI TTS has a 4096 character limit per request
 *
 * @param {string} text - The text to convert to speech
 * @param {Object} options - Generation options
 * @returns {Promise<Array<string>>} Array of paths to generated audio files
 */
async function generateLongSpeech(text, options = {}) {
  const MAX_CHUNK_SIZE = 4000; // Leave some buffer under 4096 limit

  log('INFO', 'Long TTS generation requested', {
    textLength: text.length,
    estimatedChunks: Math.ceil(text.length / MAX_CHUNK_SIZE)
  });

  if (text.length <= MAX_CHUNK_SIZE) {
    // Single chunk
    const audioPath = await generateSpeech(text, options);
    return [audioPath];
  }

  // Split into chunks at sentence boundaries
  const chunks = [];
  let currentChunk = '';

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > MAX_CHUNK_SIZE) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = sentence;
      } else {
        // Single sentence too long, split it
        chunks.push(sentence.slice(0, MAX_CHUNK_SIZE));
        currentChunk = sentence.slice(MAX_CHUNK_SIZE);
      }
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  log('INFO', `Split text into ${chunks.length} chunks`);

  // Generate audio for each chunk
  const audioPaths = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkOptions = {
      ...options,
      outputPath: options.outputPath
        ? options.outputPath.replace(/(\.\w+)$/, `_part${i + 1}$1`)
        : undefined
    };
    const audioPath = await generateSpeech(chunks[i], chunkOptions);
    audioPaths.push(audioPath);
  }

  log('INFO', `Generated ${audioPaths.length} audio files for long text`);

  return audioPaths;
}

/**
 * Clean up old audio files (older than specified days)
 *
 * @param {number} daysOld - Delete files older than this many days (default: 7)
 * @returns {Promise<number>} Number of files deleted
 */
async function cleanupOldAudio(daysOld = 7) {
  log('INFO', `Cleaning up audio files older than ${daysOld} days`);

  const now = Date.now();
  const maxAge = daysOld * 24 * 60 * 60 * 1000;

  const files = await fs.promises.readdir(AUDIO_DIR);
  let deletedCount = 0;

  for (const file of files) {
    const filePath = path.join(AUDIO_DIR, file);
    const stats = await fs.promises.stat(filePath);

    if (now - stats.mtimeMs > maxAge) {
      await fs.promises.unlink(filePath);
      deletedCount++;
      log('DEBUG', `Deleted old audio file: ${file}`);
    }
  }

  log('INFO', `Cleanup complete. Deleted ${deletedCount} files`);
  return deletedCount;
}

module.exports = {
  generateSpeech,
  generateLongSpeech,
  cleanupOldAudio
};
