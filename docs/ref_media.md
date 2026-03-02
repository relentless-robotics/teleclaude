## IMAGE GENERATION & TEXT-TO-SPEECH

**You have the ability to generate images and convert text to speech.**

### Image Generation (DALL-E 3)

**Module:** `utils/image_generator.js`

Generate images from text prompts using OpenAI's DALL-E 3 API.

**Usage:**
```javascript
const { generateImage, generateVariations } = require('./utils/image_generator');

// Generate a single image
const result = await generateImage('A futuristic robot in a cyberpunk city', {
  size: '1024x1024',      // '1024x1024', '1792x1024', '1024x1792'
  quality: 'standard',    // 'standard' or 'hd'
  style: 'vivid'          // 'vivid' or 'natural'
});

console.log(result.url);           // Image URL
console.log(result.revised_prompt); // DALL-E's revised prompt

// Generate multiple variations
const variations = await generateVariations('A sunset over mountains', 3);
```

**When to use:**
- User requests an image: "Generate an image of X"
- User asks for visualization: "Show me what X looks like"
- Creative projects requiring visuals

**Response workflow:**
1. User: "Generate an image of a cyberpunk city"
2. You: `send_to_discord("Generating image...")`
3. You: Call `generateImage(prompt, options)`
4. You: `send_to_discord("Here's your image: [url]\n\nRevised prompt: [revised_prompt]")`

### Text-to-Speech (TTS)

**Module:** `utils/tts_generator.js`

Convert text to speech using OpenAI's TTS API with multiple voice options.

**Usage:**
```javascript
const { generateSpeech, generateLongSpeech, cleanupOldAudio } = require('./utils/tts_generator');

// Generate speech (up to 4096 characters)
const audioPath = await generateSpeech('Hello, how are you today?', {
  voice: 'alloy',         // 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'
  model: 'tts-1',         // 'tts-1' (faster) or 'tts-1-hd' (higher quality)
  speed: 1.0,             // 0.25 to 4.0
  format: 'mp3'           // 'mp3', 'opus', 'aac', 'flac'
});

console.log(audioPath); // Path to generated MP3 file

// For long text (auto-chunks into multiple files)
const audioPaths = await generateLongSpeech(longText, { voice: 'nova' });

// Clean up old audio files (older than 7 days)
await cleanupOldAudio(7);
```

**Voice Options:**
- **alloy**: Neutral and balanced
- **echo**: Clear and upbeat
- **fable**: Warm and expressive (British accent)
- **onyx**: Deep and authoritative (male)
- **nova**: Friendly and enthusiastic (female)
- **shimmer**: Soft and gentle (female)

**When to use:**
- User requests voice message: "Say this in a voice message"
- User wants audio version: "Read this to me"
- Accessibility features

**Response workflow:**
1. User: "Create a voice message saying 'Hello world'"
2. You: `send_to_discord("Generating voice message...")`
3. You: Call `generateSpeech(text, { voice: 'nova' })`
4. You: `send_to_discord("Voice message created: [audioPath]")`
5. Note: Discord bridge will need to handle file attachment

### Discord Media Helpers

**Module:** `utils/discord_media.js`

Format and prepare media for Discord sending.

**Usage:**
```javascript
const {
  formatImageMessage,
  formatVoiceMessage,
  createImageEmbed,
  createTTSEmbed
} = require('./utils/discord_media');

// Format image for Discord
const message = formatImageMessage(imageUrl, prompt, revisedPrompt);
// Returns formatted text with image URL

// Format voice message for Discord
const voiceMsg = formatVoiceMessage(audioPath, text, voice);
// Returns formatted text with audio info

// Create rich embeds (if Discord.js integration is available)
const imageEmbed = createImageEmbed(imageUrl, prompt, revisedPrompt);
const ttsEmbed = createTTSEmbed(text, voice, duration);
```

### API Key Setup

**REQUIRED:** OpenAI API key must be configured.

1. Get API key from: https://platform.openai.com/api-keys
2. Add to `API_KEYS.md` (template already added)
3. Set environment variable: `OPENAI_API_KEY=sk-...`
   OR the modules will read from API_KEYS.md

**Without API key:** Image generation and TTS will fail with clear error message.

### File Storage

- **Images:** Returned as URLs (hosted by OpenAI temporarily)
- **Audio:** Saved to `./audio/speech_[timestamp]_[voice].[format]`
- **Logs:**
  - Image generation: `./logs/image-gen-[date].log`
  - TTS generation: `./logs/tts-gen-[date].log`

### Best Practices

1. **Image generation:**
   - Keep prompts descriptive and specific
   - Use 'standard' quality unless user requests HD
   - DALL-E often revises prompts - share revised version with user

2. **Text-to-speech:**
   - Choose appropriate voice for content (onyx for professional, nova for friendly, etc.)
   - Use 'tts-1' model for speed, 'tts-1-hd' for quality
   - For text >4000 chars, use `generateLongSpeech` (auto-chunks)

3. **Cleanup:**
   - Audio files accumulate in ./audio directory
   - Run `cleanupOldAudio(7)` periodically to remove old files

### Example Workflows

**Generate and send image:**
```javascript
// In background agent or direct code
const { generateImage } = require('./utils/image_generator');

const result = await generateImage('A serene Japanese garden at sunset');
await send_to_discord(`Image generated!\n\n${result.url}\n\nPrompt: ${result.revised_prompt}`);
```

**Generate and send voice message:**
```javascript
const { generateSpeech } = require('./utils/tts_generator');

const audioPath = await generateSpeech('Hello! This is a test message.', {
  voice: 'nova',
  model: 'tts-1-hd'
});

await send_to_discord(`Voice message created: ${audioPath}\n\nNote: Audio file saved locally.`);
// TODO: Enhance Discord bridge to actually send the audio file as attachment
```

---

