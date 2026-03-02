/**
 * Image Generation Module
 * Uses OpenAI DALL-E 3 API to generate images from text prompts
 *
 * Usage:
 *   const { generateImage } = require('./utils/image_generator');
 *   const imageUrl = await generateImage('A futuristic robot in a cyberpunk city');
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Configuration
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, `image-gen-${new Date().toISOString().split('T')[0]}.log`);

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Log function for image generation
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
 * Generate an image using DALL-E 3
 *
 * @param {string} prompt - The text description of the image to generate
 * @param {Object} options - Generation options
 * @param {string} options.model - Model to use (default: 'dall-e-3')
 * @param {string} options.size - Image size: '1024x1024', '1792x1024', '1024x1792' (default: '1024x1024')
 * @param {string} options.quality - Quality: 'standard' or 'hd' (default: 'standard')
 * @param {string} options.style - Style: 'vivid' or 'natural' (default: 'vivid')
 * @returns {Promise<Object>} Object with url, revised_prompt
 */
async function generateImage(prompt, options = {}) {
  log('INFO', 'Image generation requested', {
    prompt: prompt.slice(0, 100),
    options
  });

  try {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
      log('ERROR', 'No OpenAI API key found');
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or add to API_KEYS.md');
    }

    const openai = new OpenAI({ apiKey });

    const params = {
      model: options.model || 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: options.size || '1024x1024',
      quality: options.quality || 'standard',
      response_format: 'url'
    };

    // Add style parameter for DALL-E 3
    if (!options.model || options.model === 'dall-e-3') {
      params.style = options.style || 'vivid';
    }

    log('INFO', 'Sending request to OpenAI', params);

    const response = await openai.images.generate(params);

    log('INFO', 'Image generated successfully', {
      url: response.data[0].url,
      revised_prompt: response.data[0].revised_prompt
    });

    return {
      url: response.data[0].url,
      revised_prompt: response.data[0].revised_prompt || prompt
    };

  } catch (error) {
    log('ERROR', 'Image generation failed', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Generate multiple image variations
 *
 * @param {string} prompt - The text description
 * @param {number} count - Number of variations (max 10)
 * @param {Object} options - Generation options
 * @returns {Promise<Array>} Array of image objects
 */
async function generateVariations(prompt, count = 3, options = {}) {
  log('INFO', `Generating ${count} variations`, { prompt: prompt.slice(0, 100) });

  const promises = [];
  for (let i = 0; i < Math.min(count, 10); i++) {
    promises.push(generateImage(prompt, options));
  }

  try {
    const results = await Promise.all(promises);
    log('INFO', `Generated ${results.length} variations successfully`);
    return results;
  } catch (error) {
    log('ERROR', 'Variation generation failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  generateImage,
  generateVariations
};
