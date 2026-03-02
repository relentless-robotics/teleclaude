## PERSISTENT BROWSER AUTHENTICATION

**All browser automations should use saved login state to avoid repeated logins.**

### Storage State Location:
- `./browser_state/google_auth.json` - Google account session (your.email@example.com)

### How to Use (Playwright):

**Method 1 - Direct storageState:**
```javascript
const { chromium } = require('playwright');
const path = require('path');

const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  storageState: stateFile
});
const page = await context.newPage();

// Now you're already logged into Google!
// Any Google service or "Continue with Google" will work automatically
```

**Method 2 - Using Helper Module:**
```javascript
const { chromium } = require('playwright');
const { createGoogleAuthContext, hasValidGoogleAuth } = require('./browser_state/load_google_auth');

const browser = await chromium.launch({ headless: false });

if (hasValidGoogleAuth()) {
  const context = await createGoogleAuthContext(browser);
  const page = await context.newPage();
  // Logged in!
} else {
  console.log('Need to run google_auth_script.js first');
}
```

### Re-authenticating (if session expires):
```bash
cd C:\Users\YOUR_USERNAME\Documents\Github\teleclaude-main
node browser_state/google_auth_script.js
```
This will open Edge browser, log into Google (you may need to approve 2FA), and save the new session.

### When State Expires:
If login fails despite loading state:
1. Delete the old state file
2. Run fresh login and save new state
3. Report to user that re-authentication was needed

### Benefits:
- No repeated logins
- No 2FA prompts (session remembered)
- Faster automations
- Fewer security flags from Google

### Credential Helper Module:
Location: `./utils/credentials.js`

Provides auto-fill for known sites:
```javascript
const { autoFillLogin, createAuthenticatedContext } = require('./utils/credentials');

// Create context with saved Google auth
const context = await createAuthenticatedContext(browser);
const page = await context.newPage();

// Navigate to any login page
await page.goto('https://github.com/login');

// Auto-fill credentials from ACCOUNTS.md mapping
await autoFillLogin(page);
```

Supported sites: Google, GitHub, Gumroad, Pinterest, Vercel, Twitter/X

---

## CAPTCHA HANDLING PROTOCOL

**CAPTCHA Handler Module:** `./utils/captcha_handler.js`

When a CAPTCHA is encountered during browser automation:

### Using the CAPTCHA Handler Module:

```javascript
const {
  detectCaptcha,
  screenshotCaptcha,
  handleCaptchaWithUser,
  saveCaptchaSolution
} = require('./utils/captcha_handler');

// Detect if CAPTCHA present
const captchaInfo = await detectCaptcha(page);

if (captchaInfo) {
  // Take screenshot (saved to ./screenshots/captchas/)
  const screenshotPath = await screenshotCaptcha(page, captchaInfo);

  // Notify user via Discord/Telegram
  await send_to_discord(`CAPTCHA detected (${captchaInfo.type})! Please check screenshot and reply with solution.`);

  // Wait for solution (user replies, main bridge calls saveCaptchaSolution())
  const solution = await waitForCaptchaSolution(screenshotPath);

  // Enter solution
  await enterCaptchaSolution(page, solution);
}
```

### How CAPTCHA Solving Works:

1. **Detection**: Module detects reCAPTCHA, hCaptcha, Cloudflare, text CAPTCHAs, Arkose
2. **Screenshot**: Saves to `./screenshots/captchas/captcha_[timestamp].png`
3. **User Notification**: Agent sends message to Discord asking for solution
4. **User Solves**: User replies with CAPTCHA answer
5. **Solution Saved**: Main bridge calls `saveCaptchaSolution(answer)`
6. **Automation Continues**: Agent reads solution and enters it

### For Background Agents - Simple Version:

```javascript
// Take screenshot
const screenshotPath = './screenshots/captchas/captcha_' + Date.now() + '.png';
await page.screenshot({ path: screenshotPath });

// Notify user
await send_to_discord("CAPTCHA encountered! Screenshot saved. Reply with solution.");

// Wait for solution file to appear (user replies, bridge saves it)
const solutionFile = screenshotPath.replace('.png', '_solution.txt');
while (!fs.existsSync(solutionFile)) {
  await page.waitForTimeout(2000);
}
const solution = fs.readFileSync(solutionFile, 'utf-8').trim();
```

### Screenshot Location:
- Save all CAPTCHA screenshots to: `./screenshots/captchas/`
- Naming convention: `captcha_[timestamp].png`
- Solution files: `captcha_[timestamp]_solution.txt`

### Supported CAPTCHA Types:
- **reCAPTCHA** (v2, v3) - iframe detection
- **hCaptcha** - iframe detection
- **Cloudflare Turnstile** - iframe detection
- **Text CAPTCHAs** - image/input detection
- **Arkose/FunCAPTCHA** - iframe detection
- **Generic** - keyword detection ("verify you are human", etc.)

### Example Agent Prompt Addition:
```
If you encounter a CAPTCHA:
1. Take screenshot: await page.screenshot({ path: './screenshots/captchas/captcha_' + Date.now() + '.png' })
2. Send to Discord: "CAPTCHA detected! Saved screenshot. Reply with the solution text."
3. Wait for solution file to appear at same path with _solution.txt extension
4. Read solution and enter it into the page
5. Continue automation
```

---

## UNIFIED BROWSER AUTOMATION

**THE definitive module for all browser automation: `./utils/browser.js`**

This module consolidates all browser automation capabilities into one unified, powerful API. It combines stealth techniques, smart retries, auth state management, and human-like interactions.

### Quick Start

**Simple usage:**
```javascript
const browser = require('./utils/browser');

// Launch with Google auth
const session = await browser.launch({ stealth: true, auth: 'google' });

// Navigate
await session.goto('https://console.cloud.google.com');

// Interact
await session.click('button.create-project');
await session.type('#project-name', 'My Project');
await session.click('button.submit');

// Close
await session.close();
```

### Launch Options

```javascript
const session = await browser.launch({
  // Basic settings
  headless: false,              // Run headless (default: false)
  stealth: true,                // Enable stealth mode (default: true)

  // Auth & profiles
  auth: 'google',               // Load saved auth state ('google', 'github', etc.)
  profile: 'default',           // Named profile for persistent storage

  // Callbacks
  onCaptcha: async (page, captchaInfo) => {
    // Called when CAPTCHA is detected
    await send_to_discord('CAPTCHA detected!');
  }
});
```

### Session Methods

**Navigation:**
```javascript
await session.goto(url, { retries: 3, timeout: 30000 });
await session.waitForReady({ waitForNetwork: true });
```

**Element interaction:**
```javascript
// Click with retries and human-like behavior
await session.click('button.submit', {
  humanLike: true,
  waitForNavigation: true
});

// Type with human-like delays
await session.type('#email', 'test@example.com', {
  humanLike: true,
  pressEnter: false
});

// Find element with multiple fallback selectors
const element = await session.findElement([
  '#submit-button',
  'button.submit',
  'button[type="submit"]'
]);
```

**Wait for conditions:**
```javascript
// Wait for any of multiple conditions
const result = await session.waitForAny([
  { type: 'selector', value: '.success-message' },
  { type: 'url', value: '/dashboard' },
  { type: 'text', value: 'Welcome back' },
  { type: 'custom', check: async (page) => {
    return await page.$('.error') === null;
  }}
]);

if (result.matched) {
  console.log('Condition met:', result.condition);
}
```

**Auto-fill login:**
```javascript
// Auto-fills based on current page URL
await session.autoFillLogin();

// Or specify profile explicitly
await session.autoFillLogin({ profile: 'github' });
```

**Save auth state:**
```javascript
// Save current session for future use
await session.saveAuthState('google');
```

**Human behavior simulation:**
```javascript
// Simulate random mouse movements and scrolling
await session.simulateHumanBehavior(5000); // 5 seconds
```

**Diagnostics:**
```javascript
// Get page state
const state = await session.getState();
console.log(state);
// {
//   url: 'https://...',
//   title: '...',
//   ready: 'complete',
//   issues: { captcha: false, error: false, ... }
// }

// Take screenshot
await session.screenshot('debug_label');
```

### Pre-configured Launchers

```javascript
// Launch with Google auth pre-loaded
const session = await browser.withGoogleAuth({ headless: false });

// Launch with GitHub auth pre-loaded
const session = await browser.withGitHubAuth({ headless: false });
```

### Auth Profile Management

**Supported profiles:**
- `google` - your.email@example.com (Gmail, Cloud Console, YouTube, etc.)
- `github` - your.email@example.com
- `gumroad` - your.email@example.com
- `pinterest` - Uses Google OAuth
- `vercel` - Uses Google OAuth
- `twitter` - your.email@example.com

**Check if auth exists:**
```javascript
const hasAuth = browser.hasValidAuth('google');
if (!hasAuth) {
  console.log('Need to log in first');
}
```

**Load auth manually:**
```javascript
const authState = browser.loadAuthState('google');
// Returns storageState object or null
```

**Save auth from context:**
```javascript
await browser.saveAuthState(context, 'google');
```

**List all profiles:**
```javascript
const browserProfiles = require('./utils/browser_profiles');
const profiles = browserProfiles.listProfiles();
console.log(profiles);
// [
//   {
//     name: 'google',
//     valid: true,
//     created: '2026-01-30T...',
//     lastSaved: '2026-02-01T...',
//     ageInDays: 2
//   }
// ]
```

### Stealth Features

When `stealth: true` (default), the module automatically:

- Masks `navigator.webdriver` flag
- Randomizes canvas fingerprint
- Spoofs WebGL vendor
- Sets realistic user agent and viewport
- Adds proper HTTP headers
- Simulates hardware properties (CPU cores, memory)
- Injects Chrome runtime objects
- Randomizes connection properties

### Human-like Behavior

All interactions can be made human-like:

**Typing:**
```javascript
await session.type('#email', 'test@example.com', { humanLike: true });
// - Random delays between keystrokes (50-150ms)
// - Occasional longer pauses (10% chance)
// - Typing speed variation
```

**Clicking:**
```javascript
await session.click('button', { humanLike: true });
// - Smooth mouse movement with easing
// - Random timing variations
// - Scroll element into view first
```

**Mouse movement:**
```javascript
await session.moveMouseHumanLike(targetX, targetY);
// - Moves in smooth bezier curve
// - Multiple steps with random timing
// - Easing function for natural acceleration
```

### Error Recovery

**Automatic retries:**
- All navigation, clicks, and typing retry automatically (default: 3 attempts)
- Exponential backoff between retries (1s, 1.5s, 2.25s, ...)
- Auto-screenshot on error (if enabled)

**Issue detection:**
```javascript
const issues = await browser.detectIssues(session.page);
// {
//   captcha: false,
//   error: false,
//   blocked: false,
//   rateLimit: false,
//   authExpired: false
// }
```

**CAPTCHA detection:**
```javascript
const captcha = await browser.detectCaptcha(session.page);
if (captcha.detected) {
  console.log('CAPTCHA type:', captcha.type);
  // Handle CAPTCHA (notify user, save screenshot, etc.)
}
```

**Auth expiry detection:**
```javascript
const expired = await browser.detectAuthExpired(session.page);
if (expired) {
  console.log('Need to re-authenticate');
}
```

### Configuration

**Global config:**
```javascript
browser.configure({
  headless: true,
  stealth: true,
  verbose: false,
  maxRetries: 5,
  autoScreenshotOnError: true,
  screenshotDir: './screenshots/custom'
});

const config = browser.getConfig();
console.log(config);
```

### Advanced: Direct Class Usage

```javascript
const { BrowserSession } = require('./utils/browser');
const { chromium } = require('playwright');

// Create browser manually
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

// Wrap in session
const session = new BrowserSession(browser, context, page, {
  auth: 'google',
  profile: 'default'
});

// Use session methods
await session.goto('https://example.com');
await session.close();
```

### Helper Functions

```javascript
// Human delay
await browser.humanDelay(1000); // ~1000ms with 30% variation

// Sleep with jitter
await browser.sleep(1000, 0.2); // 1000ms +/- 20% jitter

// Detect issues
const issues = await browser.detectIssues(page);
const captcha = await browser.detectCaptcha(page);
const authExpired = await browser.detectAuthExpired(page);
```

### Best Practices

1. **Always use stealth mode** for automation that needs to avoid detection
2. **Load auth states** instead of logging in repeatedly
3. **Use human-like interactions** for sites with bot detection
4. **Handle CAPTCHAs** with onCaptcha callback
5. **Save auth after successful logins** for reuse
6. **Use multiple selector fallbacks** for robust element finding
7. **Take screenshots** for debugging
8. **Check for issues** (captcha, auth expired, errors) before proceeding

### Example: Complete Login Flow

```javascript
const browser = require('./utils/browser');

// Launch browser
const session = await browser.launch({
  stealth: true,
  onCaptcha: async (page, captchaInfo) => {
    const screenshot = await page.screenshot({ path: './captcha.png' });
    await send_to_discord('CAPTCHA detected! Check screenshot.');
    // Wait for user to solve...
  }
});

// Navigate to login page
await session.goto('https://github.com/login');

// Auto-fill login form
await session.type('#login_field', 'user@example.com', { humanLike: true });
await session.type('#password', 'password123', { humanLike: true });

// Submit
await session.click('input[type="submit"]', {
  humanLike: true,
  waitForNavigation: true
});

// Wait for dashboard
await session.waitForAny([
  { type: 'url', value: '/dashboard' },
  { type: 'selector', value: '.user-profile' }
]);

// Check if login succeeded
const state = await session.getState();
if (!state.issues.authExpired) {
  console.log('Login successful!');

  // Save auth state for future use
  await session.saveAuthState('github');
}

// Close
await session.close();
```

### Migrating from Old Code

**Old (playwright_helpers.js):**
```javascript
const { safeClick, safeType, createRobustContext } = require('./utils/playwright_helpers');

const browser = await chromium.launch();
const context = await createRobustContext(browser);
const page = await context.newPage();
await safeClick(page, 'button.submit');
await safeType(page, '#email', 'test@example.com');
```

**New (browser.js):**
```javascript
const browser = require('./utils/browser');

const session = await browser.launch({ stealth: true });
await session.click('button.submit');
await session.type('#email', 'test@example.com');
await session.close();
```

### Troubleshooting

**Auth state not loading:**
- Check if file exists: `browser.hasValidAuth('profileName')`
- Check if expired (>30 days old)
- Re-login and save: `session.saveAuthState('profileName')`

**Elements not found:**
- Use multiple fallback selectors
- Increase timeout: `{ timeout: 30000 }`
- Check page state: `session.getState()`
- Take screenshot: `session.screenshot('debug')`

**Detection issues:**
- Ensure stealth mode enabled: `{ stealth: true }`
- Use human-like interactions: `{ humanLike: true }`
- Add delays: `await browser.humanDelay(2000)`
- Simulate behavior: `session.simulateHumanBehavior(5000)`

**CAPTCHA appearing:**
- Use onCaptcha callback to handle
- Notify user via send_to_discord
- Take screenshot for user to solve
- Consider using saved auth to avoid login CAPTCHAs

---

