# Browser Automation Examples

This directory contains comprehensive examples demonstrating the unified browser automation module.

## Examples Overview

### 1. `browser_basic.js` - Basic Usage
**What it demonstrates:**
- Launching browser with stealth mode
- Navigating to URLs
- Finding elements
- Taking screenshots
- Simulating human behavior

**Run it:**
```bash
node examples/browser_basic.js
```

### 2. `browser_with_auth.js` - Using Saved Auth
**What it demonstrates:**
- Loading saved authentication states
- Checking if auth is valid
- Using pre-configured launchers (`withGoogleAuth`)
- Detecting auth expiry
- Saving auth state for future use

**Run it:**
```bash
node examples/browser_with_auth.js
```

**Prerequisites:**
- Requires saved Google auth (or will prompt for login)

### 3. `browser_login_flow.js` - Complete Login Flow
**What it demonstrates:**
- Full login automation workflow
- Auto-filling credentials
- Human-like typing and clicking
- Waiting for multiple possible outcomes
- Error detection and handling
- CAPTCHA detection hooks
- Saving auth after successful login

**Run it:**
```bash
node examples/browser_login_flow.js
```

### 4. `browser_advanced.js` - Advanced Features
**What it demonstrates:**
- Multiple selector fallbacks
- Retry logic for navigation
- Conditional waiting (waitForAny)
- Issue detection (CAPTCHA, errors, rate limits)
- Getting detailed page state
- Complex interaction sequences

**Run it:**
```bash
node examples/browser_advanced.js
```

### 5. `browser_profile_management.js` - Profile Management
**What it demonstrates:**
- Listing all saved profiles
- Checking profile validity
- Testing saved auth
- Credential profile overview
- Profile detection from URLs
- Deleting expired profiles

**Run it:**
```bash
node examples/browser_profile_management.js
```

## Common Patterns

### Basic Session
```javascript
const browser = require('../utils/browser');

const session = await browser.launch({ stealth: true });
await session.goto('https://example.com');
await session.click('button');
await session.type('input', 'text');
await session.close();
```

### With Authentication
```javascript
const session = await browser.withGoogleAuth();
await session.goto('https://console.cloud.google.com');
// Already logged in!
await session.close();
```

### With CAPTCHA Handling
```javascript
const session = await browser.launch({
  onCaptcha: async (page, captchaInfo) => {
    console.log('CAPTCHA detected:', captchaInfo.type);
    await session.screenshot('captcha');
    // Notify user, wait for solution, etc.
  }
});
```

### Error Recovery
```javascript
try {
  await session.goto('https://example.com', { retries: 3 });

  const clicked = await session.click('button', { retries: 3 });
  if (!clicked) {
    console.log('Button not found after retries');
  }

} catch (error) {
  console.error('Error:', error.message);
  await session.screenshot('error_state');
} finally {
  await session.close();
}
```

## Tips

1. **Always close sessions** - Use try/finally to ensure cleanup
2. **Use stealth mode** - Enabled by default, helps avoid detection
3. **Save auth states** - Avoid repeated logins
4. **Use multiple selectors** - Provide fallbacks for robustness
5. **Enable human-like behavior** - For sites with bot detection
6. **Take screenshots** - For debugging and verification
7. **Check for issues** - Detect CAPTCHAs, errors, rate limits early

## Troubleshooting

**Browser doesn't open:**
- Check that Playwright is installed: `npm install playwright`
- Ensure Edge browser is available (or change config)

**Auth not loading:**
- Check if profile exists: `browser.hasValidAuth('profileName')`
- Profile may be expired (>30 days old)
- Re-login and save: `session.saveAuthState('profileName')`

**Elements not found:**
- Use multiple selector fallbacks
- Increase timeout: `{ timeout: 30000 }`
- Check if page loaded: `await session.waitForReady()`
- Take screenshot: `await session.screenshot('debug')`

**Detection issues:**
- Ensure stealth enabled: `{ stealth: true }`
- Use human-like interactions: `{ humanLike: true }`
- Add delays: `await browser.humanDelay(2000)`
- Simulate behavior: `await session.simulateHumanBehavior(5000)`

## Next Steps

After exploring these examples:

1. Read the full documentation in `CLAUDE.md` (search for "UNIFIED BROWSER AUTOMATION")
2. Check available profiles: `utils/browser_profiles.js`
3. Review stealth techniques: `utils/browser.js` (applyStealthScripts)
4. Explore advanced config: `browser.configure({ ... })`

## Integration with TeleClaude

When using in background agents, follow the messaging bridge protocol:

```javascript
// In background agent
const browser = require('./utils/browser');

// Send progress updates
await send_to_discord('Opening browser...');

const session = await browser.launch({ stealth: true, auth: 'google' });

await send_to_discord('Navigating to site...');
await session.goto('https://example.com');

await send_to_discord('Performing actions...');
await session.click('button');

await send_to_discord('Done!');
await session.close();
```

Always notify the user of progress, errors, and completion!
