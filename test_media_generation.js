#!/usr/bin/env node
/**
 * Test Script for Image Generation and TTS
 *
 * This script tests the new media generation capabilities:
 * - Image generation with DALL-E 3
 * - Text-to-speech with OpenAI TTS
 *
 * Usage:
 *   node test_media_generation.js
 *
 * Requirements:
 *   - OPENAI_API_KEY environment variable set
 *   - OR OpenAI API key in API_KEYS.md
 */

const { generateImage } = require('./utils/image_generator');
const { generateSpeech } = require('./utils/tts_generator');
const { formatImageMessage, formatVoiceMessage } = require('./utils/discord_media');

async function testImageGeneration() {
  console.log('\n=== Testing Image Generation ===\n');

  try {
    console.log('Generating image: "A friendly robot waving hello"...');

    const result = await generateImage('A friendly robot waving hello', {
      size: '1024x1024',
      quality: 'standard',
      style: 'vivid'
    });

    console.log('✓ Image generated successfully!');
    console.log('  URL:', result.url);
    console.log('  Revised Prompt:', result.revised_prompt);

    const message = formatImageMessage(result.url, 'A friendly robot waving hello', result.revised_prompt);
    console.log('\nFormatted Discord message:');
    console.log(message.message);

    return true;
  } catch (error) {
    console.error('✗ Image generation failed:', error.message);
    return false;
  }
}

async function testTextToSpeech() {
  console.log('\n=== Testing Text-to-Speech ===\n');

  try {
    const testText = 'Hello! This is a test of the text-to-speech system. How does it sound?';
    console.log(`Converting to speech: "${testText}"...`);

    const audioPath = await generateSpeech(testText, {
      voice: 'nova',
      model: 'tts-1',
      speed: 1.0
    });

    console.log('✓ Speech generated successfully!');
    console.log('  Audio file:', audioPath);

    const message = formatVoiceMessage(audioPath, testText, 'nova');
    console.log('\nFormatted Discord message:');
    console.log(message.message);

    return true;
  } catch (error) {
    console.error('✗ TTS generation failed:', error.message);
    return false;
  }
}

async function checkAPIKey() {
  console.log('\n=== Checking OpenAI API Key ===\n');

  if (process.env.OPENAI_API_KEY) {
    const key = process.env.OPENAI_API_KEY;
    console.log('✓ OPENAI_API_KEY environment variable found');
    console.log(`  Key: ${key.slice(0, 7)}...${key.slice(-4)}`);
    return true;
  } else {
    console.log('✗ OPENAI_API_KEY environment variable not set');
    console.log('\nTo set it:');
    console.log('  Windows: set OPENAI_API_KEY=sk-...');
    console.log('  Linux/Mac: export OPENAI_API_KEY=sk-...');
    console.log('\nOR add the key to API_KEYS.md and update the modules to read from there.');
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Media Generation Test Suite                             ║');
  console.log('║   Testing Image Generation & Text-to-Speech                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const hasKey = await checkAPIKey();

  if (!hasKey) {
    console.log('\n⚠️  Cannot run tests without OpenAI API key.');
    console.log('   Get one from: https://platform.openai.com/api-keys');
    process.exit(1);
  }

  // Run tests
  const imageTest = await testImageGeneration();
  const ttsTest = await testTextToSpeech();

  // Summary
  console.log('\n=== Test Summary ===\n');
  console.log(`Image Generation: ${imageTest ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Text-to-Speech:   ${ttsTest ? '✓ PASS' : '✗ FAIL'}`);

  if (imageTest && ttsTest) {
    console.log('\n✓ All tests passed! Media generation is working.');
    console.log('\nNext steps:');
    console.log('  1. Integrate with Discord bridge to send images/audio');
    console.log('  2. Test with actual Discord messages');
    console.log('  3. Add commands like "/image [prompt]" or "/voice [text]"');
  } else {
    console.log('\n✗ Some tests failed. Check the error messages above.');
    process.exit(1);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('\n✗ Unhandled error:', error.message);
  process.exit(1);
});

// Run tests
main();
