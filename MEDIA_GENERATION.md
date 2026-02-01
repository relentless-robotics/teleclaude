# Media Generation Features

This document describes the image generation and text-to-speech capabilities added to the teleclaude Discord bridge.

## Overview

Two new capabilities have been added:
1. **Image Generation** - Generate images from text prompts using OpenAI DALL-E 3
2. **Text-to-Speech** - Convert text to speech audio files using OpenAI TTS

## Requirements

### OpenAI API Key

Both features require an OpenAI API key. You can obtain one from:
https://platform.openai.com/api-keys

**Setup:**

1. Get your API key from OpenAI
2. Add it to `API_KEYS.md` (replace "PENDING" with your actual key)
3. Set environment variable:
   ```bash
   # Windows
   set OPENAI_API_KEY=sk-...

   # Linux/Mac
   export OPENAI_API_KEY=sk-...
   ```

**Note:** The modules will first check the `OPENAI_API_KEY` environment variable. If not found, they can be updated to read from `API_KEYS.md`.

## Image Generation

### Module: `utils/image_generator.js`

Generate images from text descriptions using DALL-E 3.

### Usage

```javascript
const { generateImage, generateVariations } = require('./utils/image_generator');

// Basic usage
const result = await generateImage('A futuristic robot in a cyberpunk city');
console.log(result.url);           // Image URL
console.log(result.revised_prompt); // DALL-E's revised prompt

// With options
const result = await generateImage('A sunset over mountains', {
  size: '1024x1024',      // '1024x1024', '1792x1024', '1024x1792'
  quality: 'hd',          // 'standard' or 'hd'
  style: 'natural'        // 'vivid' or 'natural'
});

// Generate multiple variations
const variations = await generateVariations('A cat wearing sunglasses', 3);
// Returns array of 3 image objects
```

### Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `size` | `1024x1024`, `1792x1024`, `1024x1792` | `1024x1024` | Image dimensions |
| `quality` | `standard`, `hd` | `standard` | Image quality (HD costs more) |
| `style` | `vivid`, `natural` | `vivid` | Vivid = hyper-real, Natural = more realistic |
| `model` | `dall-e-3` | `dall-e-3` | Model to use |

### Return Value

```javascript
{
  url: 'https://...', // Image URL (hosted by OpenAI temporarily)
  revised_prompt: 'Detailed description that DALL-E used'
}
```

### Example: Discord Integration

```javascript
const { generateImage } = require('./utils/image_generator');
const { send_to_discord } = require('./mcp/discord');

async function handleImageRequest(prompt) {
  try {
    // Notify user
    await send_to_discord('Generating image...');

    // Generate image
    const result = await generateImage(prompt);

    // Send result
    await send_to_discord(
      `Here's your image!\n\n${result.url}\n\n` +
      `**Original:** ${prompt}\n` +
      `**Revised:** ${result.revised_prompt}`
    );
  } catch (error) {
    await send_to_discord(`Failed to generate image: ${error.message}`);
  }
}
```

## Text-to-Speech

### Module: `utils/tts_generator.js`

Convert text to natural-sounding speech with multiple voice options.

### Usage

```javascript
const { generateSpeech, generateLongSpeech, cleanupOldAudio } = require('./utils/tts_generator');

// Basic usage
const audioPath = await generateSpeech('Hello, how are you today?');
console.log(audioPath); // Path to MP3 file: ./audio/speech_1234567890_alloy.mp3

// With options
const audioPath = await generateSpeech('This is a test message', {
  voice: 'nova',          // Voice (see below)
  model: 'tts-1-hd',      // Model quality
  speed: 1.2,             // Speed (0.25 to 4.0)
  format: 'mp3'           // Output format
});

// For long text (auto-chunks into multiple files)
const audioPaths = await generateLongSpeech(longText, { voice: 'onyx' });
// Returns array of audio file paths

// Clean up old audio files (older than 7 days)
const deletedCount = await cleanupOldAudio(7);
```

### Voice Options

| Voice | Description | Best For |
|-------|-------------|----------|
| `alloy` | Neutral and balanced | General purpose |
| `echo` | Clear and upbeat | Energetic content |
| `fable` | Warm and expressive (British) | Storytelling |
| `onyx` | Deep and authoritative (male) | Professional, news |
| `nova` | Friendly and enthusiastic (female) | Casual, friendly |
| `shimmer` | Soft and gentle (female) | Calm, soothing |

### Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `voice` | See table above | `alloy` | Voice to use |
| `model` | `tts-1`, `tts-1-hd` | `tts-1` | Quality (HD is slower but better) |
| `speed` | `0.25` to `4.0` | `1.0` | Playback speed |
| `format` | `mp3`, `opus`, `aac`, `flac` | `mp3` | Audio format |
| `outputPath` | String | Auto-generated | Custom output path |

### Character Limits

- `generateSpeech()`: Max 4096 characters
- `generateLongSpeech()`: Unlimited (auto-chunks at sentence boundaries)

### Example: Discord Integration

```javascript
const { generateSpeech } = require('./utils/tts_generator');
const { send_to_discord } = require('./mcp/discord');

async function handleVoiceRequest(text, voice = 'nova') {
  try {
    // Notify user
    await send_to_discord(`Creating voice message with ${voice} voice...`);

    // Generate speech
    const audioPath = await generateSpeech(text, { voice, model: 'tts-1-hd' });

    // Send result
    await send_to_discord(
      `Voice message created!\n\n` +
      `File: ${audioPath}\n` +
      `Voice: ${voice}\n\n` +
      `Text: "${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"`
    );

    // TODO: Actually send the audio file as Discord attachment
  } catch (error) {
    await send_to_discord(`Failed to generate voice message: ${error.message}`);
  }
}
```

## Discord Media Helpers

### Module: `utils/discord_media.js`

Utilities for formatting media responses for Discord.

### Usage

```javascript
const {
  formatImageMessage,
  formatVoiceMessage,
  createImageEmbed,
  createTTSEmbed
} = require('./utils/discord_media');

// Format image message
const msg = formatImageMessage(imageUrl, prompt, revisedPrompt);
// Returns: { type: 'image', url, prompt, revisedPrompt, message }

// Format voice message
const voiceMsg = formatVoiceMessage(audioPath, text, voice);
// Returns: { type: 'voice', path, text, voice, message }

// Create rich Discord embeds (for Discord.js integration)
const imageEmbed = createImageEmbed(imageUrl, prompt, revisedPrompt);
const ttsEmbed = createTTSEmbed(text, voice, duration);
```

## MCP Tools

### Module: `mcp/media-tools.js`

MCP server providing image and TTS generation as Claude Code tools.

### Available Tools

1. **`generate_image`**
   - Input: `prompt` (required), `size`, `quality`, `style`
   - Output: Image URL and revised prompt

2. **`generate_speech`**
   - Input: `text` (required), `voice`, `model`, `speed`
   - Output: Audio file path

### Usage in Claude Code

Once the MCP server is configured, you can use these tools directly:

```javascript
// In Claude Code
const result = await tools.generate_image({
  prompt: "A beautiful landscape",
  quality: "hd"
});

const audio = await tools.generate_speech({
  text: "Hello world",
  voice: "nova"
});
```

## Testing

### Test Script: `test_media_generation.js`

Run the test script to verify everything works:

```bash
node test_media_generation.js
```

This will:
1. Check for OpenAI API key
2. Generate a test image
3. Generate a test speech audio
4. Display results and formatted messages

## File Storage

### Images
- Returned as URLs (hosted by OpenAI temporarily)
- No local storage required
- URLs expire after some time

### Audio Files
- Saved to: `./audio/`
- Naming: `speech_[timestamp]_[voice].[format]`
- Example: `speech_1706621234567_nova.mp3`

### Logs
- Image generation: `./logs/image-gen-[date].log`
- TTS generation: `./logs/tts-gen-[date].log`
- MCP server: `./logs/mcp-media-[date].log`

## Cleanup

Audio files accumulate over time. Clean them up periodically:

```javascript
const { cleanupOldAudio } = require('./utils/tts_generator');

// Delete files older than 7 days
await cleanupOldAudio(7);
```

Or manually delete files from the `./audio` directory.

## Cost Considerations

### Image Generation (DALL-E 3)
- Standard 1024x1024: ~$0.040 per image
- HD 1024x1024: ~$0.080 per image
- HD 1792x1024: ~$0.120 per image

### Text-to-Speech
- tts-1: $0.015 per 1K characters
- tts-1-hd: $0.030 per 1K characters

**Example costs:**
- 1 image (standard): $0.04
- 1 voice message (100 words ~500 chars, tts-1): ~$0.008
- 10 images + 10 voice messages per day: ~$0.48/day = ~$14.40/month

## Troubleshooting

### Error: "OpenAI API key not configured"

**Solution:** Set the `OPENAI_API_KEY` environment variable or add it to `API_KEYS.md`.

### Error: "Text too long"

**Solution:** Use `generateLongSpeech()` instead of `generateSpeech()` for text over 4096 characters.

### Audio files not playing

**Solution:** Check that the file exists and is in a supported format (MP3 should work everywhere).

### Images not loading

**Solution:** OpenAI image URLs are temporary. Download and rehost if you need permanent storage.

### Rate limiting

**Solution:** OpenAI has rate limits. If you hit them, wait a minute and try again. Consider implementing exponential backoff.

## Future Enhancements

1. **Discord File Attachments** - Automatically attach audio files to Discord messages instead of just showing the path
2. **Image Download & Storage** - Download generated images and store them permanently
3. **Voice Selection UI** - Let users preview and select voices
4. **Image Editing** - Support for image variations and edits
5. **Batch Processing** - Generate multiple images/audio files in parallel
6. **Caching** - Cache generated content to avoid regenerating the same prompts

## Integration with Discord Bridge

To fully integrate with the Discord bridge:

1. Update `mcp/discord-bridge.js` to handle file attachments
2. Add command parsing for `/image [prompt]` and `/voice [text]`
3. Implement automatic cleanup of old files
4. Add rate limiting to prevent abuse
5. Store generated content metadata in a database

## Example: Full Discord Bot Integration

```javascript
// In your Discord bot
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Image generation command
  if (message.content.startsWith('/image ')) {
    const prompt = message.content.slice(7).trim();
    await message.reply('Generating image...');

    const result = await generateImage(prompt);
    await message.reply({
      content: `**Prompt:** ${result.revised_prompt}`,
      embeds: [createImageEmbed(result.url, prompt, result.revised_prompt)]
    });
  }

  // Voice message command
  if (message.content.startsWith('/voice ')) {
    const text = message.content.slice(7).trim();
    await message.reply('Generating voice message...');

    const audioPath = await generateSpeech(text, { voice: 'nova' });
    await message.reply({
      content: `**Voice:** nova`,
      files: [{ attachment: audioPath, name: 'voice.mp3' }],
      embeds: [createTTSEmbed(text, 'nova')]
    });
  }
});
```

## Support

For issues or questions:
- Check the logs in `./logs/`
- Verify API key is set correctly
- Test with `test_media_generation.js`
- Check OpenAI API status: https://status.openai.com/
