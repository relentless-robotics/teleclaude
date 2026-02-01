# Playwright Best Practices & Helper Guide

## Overview

The `playwright_helpers.js` module provides battle-tested utilities for reliable browser automation. This guide explains common issues and how to use the helpers to fix them.

## Common Issues & Solutions

### Issue 1: Timeouts and Element Not Found

**Problem:**
```javascript
// BAD - Will timeout if element takes time to appear
const button = await page.$('button.submit');
await button.click(); // Error: button is null
```

**Solution:**
```javascript
const { safeClick } = require('./utils/playwright_helpers');

// GOOD - Retries with exponential backoff
await safeClick(page, 'button.submit');

// BETTER - Multiple fallback selectors
await safeClick(page, [
  'button.submit',
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Submit")'
]);
```

### Issue 2: Page Not Ready

**Problem:**
```javascript
// BAD - Page might still be loading
await page.goto('https://example.com', { waitUntil: 'networkidle' }); // Can hang forever
await page.click('.dynamic-button'); // Might not exist yet
```

**Solution:**
```javascript
const { safeGoto, waitForPageReady } = require('./utils/playwright_helpers');

// GOOD - Better navigation with fallback
await safeGoto(page, 'https://example.com', {
  waitUntil: 'domcontentloaded', // Faster than networkidle
  retries: 3
});

await waitForPageReady(page, {
  waitForLoad: true,
  waitForNetwork: false // Only use when necessary
});
```

### Issue 3: Elements Appear But Aren't Clickable

**Problem:**
```javascript
// BAD - Element might be covered, moving, or disabled
const element = await page.$('.button');
await element.click(); // Sometimes fails randomly
```

**Solution:**
```javascript
const { safeClick } = require('./utils/playwright_helpers');

// GOOD - Waits for stability, scrolls into view
await safeClick(page, '.button', {
  scrollIntoView: true,
  waitForStability: true,
  retries: 3
});

// If element is covered by overlay
await safeClick(page, '.button', {
  forceClick: true // Use sparingly
});
```

### Issue 4: Input Fields Don't Accept Text

**Problem:**
```javascript
// BAD - Might not clear old value, might not trigger events
await page.fill('#email', 'test@example.com');
```

**Solution:**
```javascript
const { safeType } = require('./utils/playwright_helpers');

// GOOD - Clears, types, verifies
await safeType(page, '#email', 'test@example.com', {
  clear: true,
  verify: true,
  humanLike: true // Adds realistic delays
});

// With multiple fallback selectors
await safeType(page, [
  '#email',
  'input[type="email"]',
  'input[name="email"]'
], 'test@example.com');
```

### Issue 5: Waiting for Dynamic Content

**Problem:**
```javascript
// BAD - Fixed waits are unreliable
await page.waitForTimeout(3000); // Might be too short or too long
await page.click('.result');
```

**Solution:**
```javascript
const { smartWait, waitForAny } = require('./utils/playwright_helpers');

// GOOD - Wait for specific element with retries
await smartWait(page, '.result', {
  timeout: 15000,
  state: 'visible'
});

// BETTER - Wait for any of multiple possibilities
const result = await waitForAny(page, [
  { type: 'selector', value: '.success-message' },
  { type: 'selector', value: '.error-message' },
  { type: 'url', value: '/dashboard' },
  { type: 'text', value: 'Welcome' }
]);

if (result.matched) {
  console.log('Condition met:', result.condition);
}
```

### Issue 6: Detection as Bot

**Problem:**
```javascript
// BAD - Default browser context is easy to detect
const browser = await chromium.launch();
const context = await browser.newContext();
```

**Solution:**
```javascript
const { createRobustContext } = require('./utils/playwright_helpers');

// GOOD - Anti-detection measures built in
const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage'
  ]
});

const context = await createRobustContext(browser, {
  // Custom options here
  viewport: { width: 1366, height: 768 }
});
```

### Issue 7: Hard to Debug Failures

**Problem:**
```javascript
// BAD - No debugging info when things fail
try {
  await page.click('.button');
} catch (e) {
  console.log('Failed'); // No context!
}
```

**Solution:**
```javascript
const { debugScreenshot, getPageState, detectIssues } = require('./utils/playwright_helpers');

// GOOD - Rich debugging info
try {
  await page.click('.button');
} catch (e) {
  // Take screenshot
  await debugScreenshot(page, 'click_failed');

  // Get page state
  const state = await getPageState(page);
  console.log('Page state:', state);

  // Detect common issues
  const issues = await detectIssues(page);
  console.log('Detected issues:', issues);

  // Notify user with context
  await send_to_discord(`Click failed on ${state.url}. Issues: ${JSON.stringify(issues)}`);
}
```

### Issue 8: Retry Logic Everywhere

**Problem:**
```javascript
// BAD - Manual retry logic is verbose
for (let i = 0; i < 3; i++) {
  try {
    await someComplexOperation();
    break;
  } catch (e) {
    if (i === 2) throw e;
    await sleep(1000);
  }
}
```

**Solution:**
```javascript
const { withRetry } = require('./utils/playwright_helpers');

// GOOD - Clean retry wrapper
await withRetry(async () => {
  return await someComplexOperation();
}, {
  retries: 3,
  delay: 1000,
  backoff: 1.5,
  onRetry: async (error, attempt) => {
    console.log(`Retry ${attempt} after error: ${error.message}`);
  }
});
```

## Complete Example: Login Flow

### Before (Unreliable)

```javascript
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

await page.goto('https://example.com/login');
await page.fill('#email', 'user@example.com');
await page.fill('#password', 'password123');
await page.click('button[type="submit"]');
await page.waitForTimeout(3000);

if (page.url().includes('/dashboard')) {
  console.log('Success');
}
```

### After (Robust)

```javascript
const { chromium } = require('playwright');
const {
  createRobustContext,
  safeGoto,
  waitForPageReady,
  safeType,
  safeClick,
  waitForAny,
  detectIssues,
  debugScreenshot
} = require('./utils/playwright_helpers');

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled']
});

const context = await createRobustContext(browser);
const page = await context.newPage();

try {
  // Navigate with retry
  await safeGoto(page, 'https://example.com/login', {
    retries: 3,
    expectUrl: 'login'
  });

  await waitForPageReady(page);

  // Check for issues
  const issues = await detectIssues(page);
  if (issues.captcha) {
    console.log('CAPTCHA detected!');
    await debugScreenshot(page, 'captcha_detected');
    // Handle CAPTCHA...
  }

  // Fill email with retries and fallbacks
  await safeType(page, [
    '#email',
    'input[type="email"]',
    'input[name="email"]'
  ], 'user@example.com', {
    humanLike: true,
    verify: true
  });

  // Fill password
  await safeType(page, [
    '#password',
    'input[type="password"]',
    'input[name="password"]'
  ], 'password123', {
    humanLike: true
  });

  // Click submit with retry
  await safeClick(page, [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'input[type="submit"]'
  ], {
    waitForNavigation: true
  });

  // Wait for any success/error condition
  const result = await waitForAny(page, [
    { type: 'url', value: '/dashboard' },
    { type: 'selector', value: '.error-message' },
    { type: 'selector', value: '.success-message' },
    { type: 'text', value: 'Welcome' }
  ], {
    timeout: 15000
  });

  if (result.matched) {
    if (result.condition.value === '/dashboard' || result.condition.value === 'Welcome') {
      console.log('Login successful!');
      await debugScreenshot(page, 'login_success');
    } else {
      console.log('Login failed');
      await debugScreenshot(page, 'login_failed');
    }
  } else {
    console.log('Login timeout');
    const state = await getPageState(page);
    console.log('Page state:', state);
  }

} catch (error) {
  console.error('Login error:', error.message);
  await debugScreenshot(page, 'login_error');
  const issues = await detectIssues(page);
  console.log('Issues detected:', issues);
} finally {
  // Uncomment to close
  // await browser.close();
}
```

## Configuration

Customize default settings:

```javascript
const { configure } = require('./utils/playwright_helpers');

configure({
  verbose: true, // Enable debug logging
  maxRetries: 5, // More retries
  longTimeout: 45000, // Longer timeouts
  autoScreenshotOnError: true
});
```

## Key Principles

1. **Always use fallback selectors** - Elements may have different IDs/classes across pages
2. **Never use fixed waits** - Use smart waiting for specific conditions
3. **Always retry** - Network/page issues happen, build in resilience
4. **Verify actions** - Check that typed text was set, clicks worked, etc.
5. **Add debugging** - Screenshots and state dumps when things fail
6. **Use anti-detection** - createRobustContext, human-like typing, delays
7. **Handle common issues** - CAPTCHAs, rate limits, errors

## Comparison: Friend's Setup

Your friend likely has:
- Better wait strategies (not using networkidle everywhere)
- Retry logic on critical operations
- Multiple selector fallbacks
- Anti-detection measures
- Better error handling

Our helpers implement all of these patterns!

## Migration Guide

Replace your current patterns:

| Old Pattern | New Pattern |
|-------------|-------------|
| `await page.goto(url, { waitUntil: 'networkidle' })` | `await safeGoto(page, url)` |
| `await page.$(sel)` then `await el.click()` | `await safeClick(page, sel)` |
| `await page.fill(sel, text)` | `await safeType(page, sel, text)` |
| `await page.waitForSelector(sel)` | `await smartWait(page, sel)` |
| `await page.waitForTimeout(3000)` | `await waitForAny(page, conditions)` |
| `await browser.newContext()` | `await createRobustContext(browser)` |

## Next Steps

1. Start using helpers in new scripts
2. Gradually migrate existing scripts
3. Add debugging to problematic flows
4. Monitor success rates and adjust timeouts/retries

## Questions?

Common questions:

**Q: Do I always need to use the helpers?**
A: Use them for critical operations. Simple scripts may not need them.

**Q: Will this make scripts slower?**
A: Slightly, but more reliable. You can configure timeouts/retries.

**Q: Can I mix helpers with regular Playwright?**
A: Yes! Use helpers for critical operations, regular Playwright elsewhere.

**Q: What about the captcha_handler and credentials modules?**
A: They work great with these helpers! Combine them:

```javascript
const { safeGoto, safeType, detectIssues } = require('./utils/playwright_helpers');
const { handleCaptcha } = require('./utils/captcha_handler');
const { autoFillLogin } = require('./utils/credentials');

await safeGoto(page, 'https://site.com/login');
await autoFillLogin(page); // Uses credentials module

const issues = await detectIssues(page);
if (issues.captcha) {
  await handleCaptcha(page, send_to_discord); // Uses captcha module
}
```
