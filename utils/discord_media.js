/**
 * Discord Media Helper
 * Utilities for formatting and sending images and audio to Discord
 *
 * Usage:
 *   const { formatImageMessage, formatVoiceMessage, sendImageToDiscord, sendVoiceToDiscord } = require('./utils/discord_media');
 */

const fs = require('fs');
const path = require('path');

/**
 * Format an image response for Discord
 *
 * @param {string} imageUrl - URL of the generated image
 * @param {string} prompt - The prompt used to generate the image
 * @param {string} revisedPrompt - The revised prompt from DALL-E (optional)
 * @returns {Object} Formatted message object
 */
function formatImageMessage(imageUrl, prompt, revisedPrompt = null) {
  return {
    type: 'image',
    url: imageUrl,
    prompt: prompt,
    revisedPrompt: revisedPrompt,
    message: revisedPrompt
      ? `Here's your generated image!\n\n**Original prompt:** ${prompt}\n**Revised prompt:** ${revisedPrompt}\n\n${imageUrl}`
      : `Here's your generated image!\n\n**Prompt:** ${prompt}\n\n${imageUrl}`
  };
}

/**
 * Format a voice message response for Discord
 *
 * @param {string} audioPath - Path to the generated audio file
 * @param {string} text - The text that was converted to speech
 * @param {string} voice - The voice used (optional)
 * @returns {Object} Formatted message object
 */
function formatVoiceMessage(audioPath, text, voice = null) {
  return {
    type: 'voice',
    path: audioPath,
    text: text,
    voice: voice,
    message: voice
      ? `Voice message (${voice}): "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`
      : `Voice message: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`
  };
}

/**
 * Format multiple audio files for Discord (for long text)
 *
 * @param {Array<string>} audioPaths - Array of audio file paths
 * @param {string} text - The original text
 * @param {string} voice - The voice used (optional)
 * @returns {Object} Formatted message object
 */
function formatMultipartVoiceMessage(audioPaths, text, voice = null) {
  return {
    type: 'voice_multipart',
    paths: audioPaths,
    text: text,
    voice: voice,
    message: `Voice message in ${audioPaths.length} parts (${voice || 'default voice'}): "${text.slice(0, 150)}${text.length > 150 ? '...' : ''}"`
  };
}

/**
 * Create a Discord embed for image generation
 *
 * @param {string} imageUrl - URL of the generated image
 * @param {string} prompt - The prompt used
 * @param {string} revisedPrompt - The revised prompt from DALL-E (optional)
 * @returns {Object} Discord embed object
 */
function createImageEmbed(imageUrl, prompt, revisedPrompt = null) {
  const embed = {
    color: 0x5865F2, // Discord blurple
    title: 'AI Generated Image',
    description: revisedPrompt
      ? `**Original:** ${prompt}\n**Revised:** ${revisedPrompt}`
      : `**Prompt:** ${prompt}`,
    image: {
      url: imageUrl
    },
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Powered by DALL-E 3'
    }
  };

  return embed;
}

/**
 * Create a Discord embed for TTS generation
 *
 * @param {string} text - The text that was converted
 * @param {string} voice - The voice used
 * @param {number} duration - Audio duration in seconds (optional)
 * @returns {Object} Discord embed object
 */
function createTTSEmbed(text, voice, duration = null) {
  const embed = {
    color: 0x57F287, // Green
    title: 'Text-to-Speech',
    description: text.length > 200 ? text.slice(0, 200) + '...' : text,
    fields: [
      {
        name: 'Voice',
        value: voice,
        inline: true
      }
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Powered by OpenAI TTS'
    }
  };

  if (duration) {
    embed.fields.push({
      name: 'Duration',
      value: `${duration.toFixed(1)}s`,
      inline: true
    });
  }

  return embed;
}

/**
 * Helper to send image URL to Discord via the bridge
 * This writes to the output file that the Discord bridge monitors
 *
 * @param {string} imageUrl - URL of the image
 * @param {string} prompt - The prompt used
 * @param {string} revisedPrompt - The revised prompt (optional)
 * @returns {string} Message to write to Discord output file
 */
function sendImageToDiscord(imageUrl, prompt, revisedPrompt = null) {
  const formatted = formatImageMessage(imageUrl, prompt, revisedPrompt);
  return formatted.message;
}

/**
 * Helper to send voice message info to Discord via the bridge
 *
 * @param {string} audioPath - Path to the audio file
 * @param {string} text - The text that was converted
 * @param {string} voice - The voice used (optional)
 * @returns {string} Message to write to Discord output file
 */
function sendVoiceToDiscord(audioPath, text, voice = null) {
  const formatted = formatVoiceMessage(audioPath, text, voice);
  // Note: Discord bridge will need to handle file attachment separately
  return formatted.message + `\n\n[Audio file: ${audioPath}]`;
}

/**
 * Get file size in human-readable format
 *
 * @param {string} filePath - Path to the file
 * @returns {string} File size (e.g., "2.3 MB")
 */
function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  const bytes = stats.size;

  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Validate that file exists and is accessible
 *
 * @param {string} filePath - Path to validate
 * @returns {boolean} True if file exists and is readable
 */
function validateFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  formatImageMessage,
  formatVoiceMessage,
  formatMultipartVoiceMessage,
  createImageEmbed,
  createTTSEmbed,
  sendImageToDiscord,
  sendVoiceToDiscord,
  getFileSize,
  validateFile
};
