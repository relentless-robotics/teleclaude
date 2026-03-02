# CAPTCHA Solver Examples

Example scripts demonstrating how to use the production-ready image CAPTCHA solver.

## Prerequisites

```bash
# Install YOLO for image classification
pip install ultralytics torch torchvision

# Verify installation
node -e "const s = require('../solver'); console.log(s.getStatus())"
```

## Examples

### 1. Simple reCAPTCHA Solve

**File:** `simple-recaptcha-solve.js`

The easiest way to solve reCAPTCHA - just one function call!

```bash
node simple-recaptcha-solve.js
```

Features:
- ✅ Auto-detect and solve reCAPTCHA
- ✅ Progress logging
- ✅ Form submission
- ✅ Visual browser for debugging

### 2. hCaptcha Solve

**File:** `hcaptcha-solve.js`

Solve hCaptcha image challenges with YOLO.

```bash
node hcaptcha-solve.js
```

Features:
- ✅ hCaptcha detection
- ✅ Image classification with YOLO
- ✅ Checkbox triggering
- ✅ Success verification

### 3. Advanced Usage

**File:** `advanced-usage.js`

Production-ready example with all features.

```bash
node advanced-usage.js
```

Features:
- ✅ Status checking before solve
- ✅ YOLO pre-initialization
- ✅ Retry logic with backoff
- ✅ Anti-detection measures
- ✅ Comprehensive error handling
- ✅ Progress logging
- ✅ Stealth mode

## Quick Reference

### Solve Any CAPTCHA

```javascript
const { solveCaptchaOnPage } = require('../solver');

const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => console.log(msg),
  useYOLO: true,
  maxAttempts: 3
});

if (result.success) {
  console.log('Solved!');
}
```

### Solve reCAPTCHA Specifically

```javascript
const { solveRecaptchaImages } = require('../solver');

const result = await solveRecaptchaImages(page, {
  onProgress: (msg) => console.log(msg),
  useYOLO: true,
  maxAttempts: 3,
  maxRounds: 5 // Tile refresh rounds
});
```

### Solve hCaptcha Specifically

```javascript
const { solveHCaptchaImages } = require('../solver');

const result = await solveHCaptchaImages(page, {
  onProgress: (msg) => console.log(msg),
  useYOLO: true,
  maxAttempts: 3
});
```

### Check Status

```javascript
const { getStatus } = require('../solver');

const status = getStatus();
console.log('Ready:', status.imageClassification.ready);
console.log('Method:', status.imageClassification.preferred);
```

### Initialize YOLO

```javascript
const { initializeYOLO } = require('../solver');

await initializeYOLO(); // Downloads model if needed
console.log('YOLO ready!');
```

## Return Values

### Success

```javascript
{
  success: true,
  method: 'image-classification', // or 'audio'
  attempts: 2,
  rounds: 3,
  tilesSelected: 9
}
```

### Failure

```javascript
{
  success: false,
  error: 'Max attempts reached',
  stack: '...'
}
```

## Customization

### Custom Progress Handler

```javascript
const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => {
    // Send to Discord
    await send_to_discord(`[CAPTCHA] ${msg}`);

    // Log to file
    fs.appendFileSync('captcha.log', `${new Date()} ${msg}\n`);

    // Show in UI
    updateUI(msg);
  }
});
```

### Retry Logic

```javascript
let solved = false;
let retries = 0;

while (!solved && retries < 5) {
  const result = await solveCaptchaOnPage(page);

  if (result.success) {
    solved = true;
  } else {
    retries++;
    console.log(`Retry ${retries}/5...`);
    await page.reload();
    await page.waitForTimeout(2000);
  }
}
```

### Error Recovery

```javascript
try {
  const result = await solveCaptchaOnPage(page);

  if (!result.success) {
    // Fallback strategies
    if (result.error.includes('YOLO')) {
      // YOLO failed, use OpenAI
      process.env.OPENAI_API_KEY = 'sk-...';
      return await solveCaptchaOnPage(page, { useYOLO: false });
    }

    if (result.error.includes('rate limit')) {
      // Wait and retry
      await page.waitForTimeout(60000);
      return await solveCaptchaOnPage(page);
    }

    throw new Error(result.error);
  }
} catch (e) {
  console.error('CAPTCHA failed:', e);
  // Notify admin, log error, etc.
}
```

## Performance Tips

1. **Pre-initialize YOLO** - Download model before first use
2. **Use GPU** - Install CUDA-enabled PyTorch for faster inference
3. **Prefer audio** - For reCAPTCHA, audio is faster and more reliable
4. **Increase max rounds** - If tiles frequently refresh
5. **Lower confidence** - If missing valid tiles (default: 0.3)

## Troubleshooting

### CAPTCHA fails consistently

1. Check status: `const status = getStatus()`
2. Verify YOLO installed: `status.imageClassification.yolo.installed`
3. Try OpenAI Vision: Set `OPENAI_API_KEY`
4. Increase attempts: `maxAttempts: 5`
5. Prefer audio: `preferAudio: true`

### Slow performance

1. Check GPU: `python -c "import torch; print(torch.cuda.is_available())"`
2. Install CUDA PyTorch: `pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118`
3. Use audio instead: `preferAudio: true`

### Module not found

```bash
# Make sure you're in the examples directory
cd captcha-lab/examples

# Or use absolute path
const solver = require('C:/path/to/captcha-lab/solver');
```

## Integration Examples

### With Existing Automation

```javascript
// Your existing code
await page.goto('https://example.com');
await page.fill('#username', 'user');
await page.fill('#password', 'pass');

// Add CAPTCHA solver
const { solveCaptchaOnPage } = require('./captcha-lab/solver');
const captchaResult = await solveCaptchaOnPage(page);

if (!captchaResult.success) {
  throw new Error('CAPTCHA failed');
}

// Continue automation
await page.click('button[type="submit"]');
```

### With Telegram Bridge

```javascript
const { send_to_telegram } = require('./bridge');
const { solveCaptchaOnPage } = require('./captcha-lab/solver');

const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => send_to_telegram(`🤖 ${msg}`)
});

if (result.success) {
  await send_to_telegram('✅ CAPTCHA solved!');
} else {
  await send_to_telegram(`❌ CAPTCHA failed: ${result.error}`);
}
```

## Next Steps

- Read the full guide: `../IMAGE_SOLVER_GUIDE.md`
- Check solver status: `node -e "require('../solver').getStatus()"`
- Run tests: `cd .. && node test-image-solver.js`
- Customize for your use case

## Support

For issues or questions:
1. Check `IMAGE_SOLVER_GUIDE.md` for detailed documentation
2. Run `getStatus()` to diagnose issues
3. Enable verbose logging with `onProgress` callback
