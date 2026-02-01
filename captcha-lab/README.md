# CAPTCHA Lab

A containerized environment for testing and improving CAPTCHA solving capabilities.

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start the lab server
node server.js

# Open http://localhost:3000
```

### Docker

```bash
# Build and run
docker-compose up -d

# Access at http://localhost:3000 or http://localhost:8080

# Run tests
docker-compose --profile test up
```

### WSL2 (from Windows)

```bash
# Build in WSL
wsl -d kali-linux -u teleclaude -- docker build -t captcha-lab .

# Run
wsl -d kali-linux -u teleclaude -- docker run -d -p 3000:3000 --name captcha-lab captcha-lab
```

## Available Test Pages

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | Lab overview and links |
| reCAPTCHA v2 | `/recaptcha-v2` | Checkbox CAPTCHA (test keys) |
| reCAPTCHA v2 Invisible | `/recaptcha-v2-invisible` | Invisible version |
| hCaptcha | `/hcaptcha` | hCaptcha (test keys) |
| Text CAPTCHA | `/text-captcha` | Distorted text |
| Math CAPTCHA | `/math-captcha` | Solve math problems |

## Test Keys

The lab uses official test keys that always pass:

**reCAPTCHA:**
- Site Key: `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI`
- Secret Key: `6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe`

**hCaptcha:**
- Site Key: `10000000-ffff-ffff-ffff-000000000001`
- Secret Key: `0x0000000000000000000000000000000000000000`

## Testing the Solver

1. Start the lab: `node server.js`
2. Run tests: `node test-solver.js`

### With 2captcha API Key

```bash
# Set environment variable
export TWOCAPTCHA_API_KEY=your_key_here

# Or add to API_KEYS.md in parent directory

# Run tests
node test-solver.js
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/text-captcha` | GET | Generate new text CAPTCHA |
| `/api/verify-text` | POST | Verify text CAPTCHA answer |
| `/api/verify-recaptcha` | POST | Verify reCAPTCHA token |

## Integration with Main Project

The solver module is at `../utils/captcha_solver.js`.

```javascript
const { autoSolve, detectAndSolve } = require('../utils/captcha_solver');

// Auto-detect and solve
const result = await autoSolve(page);
if (result.success) {
  console.log('Solved:', result.type);
}
```

## Extending the Lab

### Add New CAPTCHA Type

1. Add route in `server.js`
2. Create test page with CAPTCHA
3. Add detection logic to `captcha_solver.js`
4. Add test case to `test-solver.js`

### Add Real CAPTCHA Provider

For testing with real (not test) CAPTCHAs:

1. Register for API keys at the provider
2. Replace test keys in `server.js`
3. Implement server-side verification

## Troubleshooting

**CAPTCHA not loading:**
- Check internet connection (test keys need Google/hCaptcha servers)
- Try refreshing the page

**Docker build fails:**
- Ensure Docker is running
- Check available disk space

**Tests fail:**
- Verify lab is running (`curl http://localhost:3000`)
- Check API key is set correctly

## Cost Estimation

Using 2captcha for solving:

| CAPTCHA Type | Cost per 1000 | Speed |
|--------------|---------------|-------|
| reCAPTCHA v2 | ~$2.99 | 20-60s |
| reCAPTCHA v3 | ~$2.99 | 20-60s |
| hCaptcha | ~$2.99 | 20-60s |
| Text/Image | ~$0.50-1.00 | 5-15s |
| Cloudflare | ~$2.99 | 20-60s |
