# Image CAPTCHA Solver - Production Guide

Production-ready CAPTCHA solving for Playwright automation with AI-powered image classification.

## Features

✅ **reCAPTCHA v2** - Solves "Select all images with X" challenges
✅ **hCaptcha** - Solves image selection challenges
✅ **Auto YOLO download** - Model downloads automatically on first use
✅ **GPU acceleration** - Uses RTX 3090 for fast YOLO inference
✅ **Fallback chain** - YOLO → OpenAI Vision → Error handling
✅ **Dynamic tile refresh** - Handles new images appearing after selection
✅ **Production error handling** - Comprehensive error reporting

## Quick Start

### 1. Install Dependencies

```bash
# Install YOLO (recommended - free and fast!)
pip install ultralytics torch torchvision

# OR set OpenAI API key (paid alternative)
set OPENAI_API_KEY=sk-...
```

### 2. Basic Usage

```javascript
const { chromium } = require('playwright');
const { solveCaptchaOnPage } = require('./captcha-lab/solver');

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

await page.goto('https://example.com');

// Solve any CAPTCHA on the page
const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => console.log(msg),
  useYOLO: true,
  maxAttempts: 3
});

if (result.success) {
  console.log('CAPTCHA solved!');
}
```

## Advanced Usage

### Specific CAPTCHA Types

```javascript
const {
  solveRecaptchaImages,
  solveHCaptchaImages
} = require('./captcha-lab/solver');

// Solve reCAPTCHA image challenge specifically
const recaptchaResult = await solveRecaptchaImages(page, {
  onProgress: (msg) => console.log(msg),
  maxAttempts: 3,
  maxRounds: 5,        // Max rounds of tile refreshes
  useYOLO: true,       // Use local YOLO
  confidenceThreshold: 0.3
});

// Solve hCaptcha specifically
const hcaptchaResult = await solveHCaptchaImages(page, {
  onProgress: (msg) => console.log(msg),
  useYOLO: true
});
```

### Initialize YOLO Model

```javascript
const { initializeYOLO, getStatus } = require('./captcha-lab/solver');

// Check what's available
const status = getStatus();
console.log(status);

// Pre-download YOLO model (optional - auto-downloads on first use)
if (status.imageClassification.yolo.installed) {
  await initializeYOLO();
  console.log('YOLO ready!');
}
```

### Custom Progress Callbacks

```javascript
const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => {
    // Send to Discord, log to file, show in UI, etc.
    console.log(`[${new Date().toISOString()}] ${msg}`);
  },
  useYOLO: true
});
```

## Configuration Options

### `solveCaptchaOnPage(page, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onProgress` | function | `console.log` | Progress callback |
| `preferAudio` | boolean | `true` | For reCAPTCHA, try audio first |
| `useYOLO` | boolean | `true` | Use YOLO for image classification |
| `maxAttempts` | number | `3` | Max solve attempts |

### `solveRecaptchaImages(page, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onProgress` | function | `() => {}` | Progress callback |
| `maxAttempts` | number | `3` | Max attempts |
| `maxRounds` | number | `5` | Max tile refresh rounds |
| `confidenceThreshold` | number | `0.3` | YOLO confidence threshold |
| `useYOLO` | boolean | `true` | Use YOLO for classification |

## Image Classification Methods

### YOLO (Recommended)

**Pros:**
- ✅ Free and local
- ✅ Fast (GPU accelerated)
- ✅ No API costs
- ✅ Works offline

**Cons:**
- ❌ Requires Python + ultralytics
- ❌ ~6 MB model download

**Installation:**
```bash
pip install ultralytics torch torchvision
```

Model auto-downloads on first use to: `~/.cache/ultralytics/yolov8n.pt`

### OpenAI Vision API

**Pros:**
- ✅ Very accurate
- ✅ No local setup

**Cons:**
- ❌ Paid API (~$0.01 per image)
- ❌ Requires internet
- ❌ Slower than local YOLO

**Setup:**
```bash
set OPENAI_API_KEY=sk-...
```

### Fallback Chain

The solver automatically tries methods in order:

1. **YOLO** (if installed and `useYOLO: true`)
2. **OpenAI Vision** (if API key set)
3. **Error** (if both fail)

## Supported CAPTCHA Categories

The solver recognizes these objects:

- Traffic lights
- Crosswalks
- Buses
- Bicycles
- Motorcycles
- Cars
- Trucks
- Fire hydrants
- Parking meters
- Bridges
- Boats
- Airplanes
- Stairs
- Chimneys
- Palm trees
- Mountains
- Taxis

New categories are added automatically when CAPTCHA instructions contain them.

## Return Values

### Success Response

```javascript
{
  success: true,
  method: 'image-classification',
  attempts: 2,
  rounds: 3,
  tilesSelected: 9
}
```

### Failure Response

```javascript
{
  success: false,
  error: 'Max attempts reached',
  stack: '...'
}
```

## Error Handling

```javascript
const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => console.log(msg)
});

if (!result.success) {
  console.error('CAPTCHA failed:', result.error);

  // Check status for troubleshooting
  const status = getStatus();
  console.log('Solver status:', status);

  if (!status.imageClassification.ready) {
    console.log('Install YOLO: pip install ultralytics');
  }
}
```

## Common Issues

### "No image classification available"

**Solution:** Install YOLO or set OpenAI API key

```bash
pip install ultralytics
```

### YOLO model download fails

**Solution:** Download manually

```bash
python -c "from ultralytics import YOLO; model = YOLO('yolov8n.pt')"
```

### GPU not being used

**Solution:** Install CUDA-enabled PyTorch

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
```

Check GPU usage:
```python
import torch
print(torch.cuda.is_available())  # Should be True
```

### Classification inaccurate

**Options:**
1. Increase confidence threshold (default 0.3)
2. Use OpenAI Vision instead of YOLO
3. Increase `maxRounds` to let more tiles load

## Performance

### YOLO (RTX 3090)

- **Speed:** ~200ms per tile
- **3x3 grid:** ~2 seconds
- **4x4 grid:** ~3 seconds

### OpenAI Vision API

- **Speed:** ~1-2 seconds per tile
- **3x3 grid:** ~10-15 seconds
- **Cost:** ~$0.09 per challenge

## Testing

```bash
cd captcha-lab
node test-image-solver.js
```

The test script will:
1. Check dependencies
2. Initialize YOLO
3. Navigate to reCAPTCHA demo
4. Solve the CAPTCHA
5. Verify success

Browser stays open for 30 seconds to inspect results.

## Example: Full Automation

```javascript
const { chromium } = require('playwright');
const { solveCaptchaOnPage } = require('./captcha-lab/solver');

async function automateWithCaptcha() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Navigate to target site
  await page.goto('https://example.com/login');

  // Fill form
  await page.fill('#username', 'myuser');
  await page.fill('#password', 'mypass');

  // Solve CAPTCHA
  const captchaResult = await solveCaptchaOnPage(page, {
    onProgress: (msg) => console.log(`[CAPTCHA] ${msg}`),
    useYOLO: true
  });

  if (!captchaResult.success) {
    throw new Error('CAPTCHA failed: ' + captchaResult.error);
  }

  // Submit form
  await page.click('button[type="submit"]');
  await page.waitForNavigation();

  console.log('Login successful!');

  await browser.close();
}

automateWithCaptcha().catch(console.error);
```

## Integration with Existing Code

Replace manual CAPTCHA handling:

```javascript
// BEFORE (manual intervention required)
await page.click('#recaptcha-checkbox');
console.log('Please solve the CAPTCHA manually...');
await page.waitForTimeout(30000); // Wait for user

// AFTER (fully automated)
const result = await solveCaptchaOnPage(page);
if (result.success) {
  console.log('CAPTCHA solved automatically!');
}
```

## Production Deployment

### Recommended Settings

```javascript
const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => logger.info(msg), // Use proper logging
  useYOLO: true,        // Use local YOLO (no API costs)
  maxAttempts: 5,       // Increase for production reliability
  preferAudio: true     // Audio is more reliable for reCAPTCHA
});
```

### Error Recovery

```javascript
let solved = false;
let attempts = 0;

while (!solved && attempts < 3) {
  attempts++;

  const result = await solveCaptchaOnPage(page, {
    onProgress: (msg) => console.log(msg)
  });

  if (result.success) {
    solved = true;
  } else {
    console.log(`Attempt ${attempts} failed, retrying...`);
    await page.reload();
    await page.waitForTimeout(2000);
  }
}

if (!solved) {
  throw new Error('CAPTCHA solving failed after 3 attempts');
}
```

## License

Part of the teleclaude CAPTCHA solver suite.
