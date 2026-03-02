# CAPTCHA Solver - Quick Start

Get started with the image CAPTCHA solver in 2 minutes.

## 1. Install Dependencies

```bash
pip install ultralytics torch torchvision
```

## 2. Copy This Code

```javascript
const { chromium } = require('playwright');
const { solveCaptchaOnPage } = require('./captcha-lab/solver');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://www.google.com/recaptcha/api2/demo');

  // Solve CAPTCHA - one line!
  const result = await solveCaptchaOnPage(page);

  if (result.success) {
    console.log('✅ CAPTCHA solved!');
  } else {
    console.log('❌ Failed:', result.error);
  }

  await browser.close();
})();
```

## 3. Run It

```bash
node your-script.js
```

## That's It! 🎉

The solver will:
- Auto-detect CAPTCHA type
- Try audio challenge first (more reliable)
- Fall back to image classification if needed
- Use YOLO for free, local AI classification
- Handle all errors automatically

## Next Steps

- Read full guide: `IMAGE_SOLVER_GUIDE.md`
- Try examples: `examples/simple-recaptcha-solve.js`
- Run tests: `node test-image-solver.js`

## Common Options

```javascript
const result = await solveCaptchaOnPage(page, {
  onProgress: (msg) => console.log(msg),  // See progress
  useYOLO: true,                          // Use YOLO (vs OpenAI)
  preferAudio: true,                      // Try audio first
  maxAttempts: 3                          // Retry attempts
});
```

## Troubleshooting

**Module not found:**
```bash
# Make sure you're using correct path
const solver = require('./captcha-lab/solver');
```

**YOLO not installed:**
```bash
pip install ultralytics torch torchvision
```

**Check status:**
```javascript
const { getStatus } = require('./captcha-lab/solver');
console.log(getStatus());
```

## Support

- Full guide: `IMAGE_SOLVER_GUIDE.md`
- Examples: `examples/` directory
- Summary: `PRODUCTION_READY_SUMMARY.md`
