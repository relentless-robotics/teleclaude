# Media Generation - Quick Reference

## Setup (One-time)

```bash
# 1. Get OpenAI API key from: https://platform.openai.com/api-keys

# 2. Set environment variable
# Windows:
set OPENAI_API_KEY=sk-...

# Linux/Mac:
export OPENAI_API_KEY=sk-...

# 3. Test it works
node test_media_generation.js
```

## Generate Image

```javascript
const { generateImage } = require('./utils/image_generator');

// Quick
const result = await generateImage('A futuristic city');
console.log(result.url);

// With options
const result = await generateImage('A sunset', {
  size: '1792x1024',  // Options: 1024x1024, 1792x1024, 1024x1792
  quality: 'hd',      // Options: standard, hd
  style: 'natural'    // Options: vivid, natural
});
```

## Generate Speech

```javascript
const { generateSpeech } = require('./utils/tts_generator');

// Quick
const audioPath = await generateSpeech('Hello world');

// With options
const audioPath = await generateSpeech('Your text here', {
  voice: 'nova',      // Options: alloy, echo, fable, onyx, nova, shimmer
  model: 'tts-1-hd',  // Options: tts-1 (fast), tts-1-hd (quality)
  speed: 1.0          // Range: 0.25 to 4.0
});
```

## Voice Options

| Voice | Description |
|-------|-------------|
| `alloy` | Neutral (default) |
| `echo` | Upbeat |
| `fable` | British, expressive |
| `onyx` | Deep male |
| `nova` | Friendly female |
| `shimmer` | Soft female |

## Discord Integration

```javascript
const { generateImage } = require('./utils/image_generator');

// In background agent or main code
const result = await generateImage(prompt);
await send_to_discord(`Image: ${result.url}\n\nPrompt: ${result.revised_prompt}`);
```

```javascript
const { generateSpeech } = require('./utils/tts_generator');

const audioPath = await generateSpeech(text, { voice: 'nova' });
await send_to_discord(`Voice message: ${audioPath}\n\n"${text}"`);
```

## File Locations

- **Audio files:** `./audio/speech_[timestamp]_[voice].mp3`
- **Logs:** `./logs/image-gen-[date].log`, `./logs/tts-gen-[date].log`
- **Test script:** `test_media_generation.js`

## Cleanup

```javascript
const { cleanupOldAudio } = require('./utils/tts_generator');
await cleanupOldAudio(7); // Delete files older than 7 days
```

## Costs (approx)

- Image (standard): $0.04
- Image (HD): $0.08
- Voice (100 words): $0.008

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "API key not configured" | Set `OPENAI_API_KEY` environment variable |
| "Text too long" | Use `generateLongSpeech()` instead |
| Image URL expired | URLs are temporary, download if needed |

## Full Documentation

See `MEDIA_GENERATION.md` for complete details.
