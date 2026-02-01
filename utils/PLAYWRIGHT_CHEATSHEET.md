# Playwright Helpers Quick Reference

## Import

```javascript
const {
  createRobustContext,
  safeGoto,
  waitForPageReady,
  safeClick,
  safeType,
  smartWait,
  waitForAny,
  debugScreenshot,
  getPageState,
  detectIssues,
  sleep,
  withRetry,
  configure
} = require('./utils/playwright_helpers');
```

## Quick Fixes

### Fix: Element Not Found Timeout

**Before:**
```javascript
await page.click('.button');
```

**After:**
```javascript
await safeClick(page, ['.button', 'button.submit', 'button[type="submit"]']);
```

### Fix: Page Not Loading Properly

**Before:**
```javascript
await page.goto(url, { waitUntil: 'networkidle' });
```

**After:**
```javascript
await safeGoto(page, url, { waitUntil: 'domcontentloaded' });
await waitForPageReady(page);
```

### Fix: Input Not Accepting Text

**Before:**
```javascript
await page.fill('#email', 'test@example.com');
```

**After:**
```javascript
await safeType(page, ['#email', 'input[type="email"]'], 'test@example.com', {
  humanLike: true,
  verify: true
});
```

### Fix: Random Timeouts

**Before:**
```javascript
await page.waitForSelector('.result', { timeout: 5000 });
```

**After:**
```javascript
await smartWait(page, ['.result', '.success', '.data'], {
  timeout: 15000,
  state: 'visible'
});
```

## Function Reference

### Navigation

```javascript
// Safe navigation with retry
await safeGoto(page, 'https://example.com', {
  retries: 3,
  timeout: 30000,
  waitUntil: 'domcontentloaded',
  expectUrl: 'example.com'
});

// Wait for page to be fully ready
await waitForPageReady(page, {
  waitForLoad: true,
  waitForNetwork: false // Only when needed
});
```

### Element Interaction

```javascript
// Click with retries and fallbacks
await safeClick(page, ['.btn', 'button.submit'], {
  retries: 3,
  timeout: 15000,
  waitForNavigation: false,
  scrollIntoView: true,
  waitForStability: true,
  forceClick: false // Set true if element is covered
});

// Type with verification
await safeType(page, ['#input', 'input[name="field"]'], 'text', {
  retries: 3,
  timeout: 15000,
  humanLike: true, // Realistic typing delays
  clear: true, // Clear before typing
  pressEnter: false, // Press Enter after
  verify: true // Verify value was set
});
```

### Waiting

```javascript
// Smart wait for element
await smartWait(page, ['.selector1', '.selector2'], {
  timeout: 15000,
  state: 'visible', // 'visible', 'attached', 'hidden'
  throwOnTimeout: false
});

// Wait for any of multiple conditions
const result = await waitForAny(page, [
  { type: 'selector', value: '.success' },
  { type: 'selector', value: '.error' },
  { type: 'url', value: '/dashboard' },
  { type: 'text', value: 'Welcome' },
  { type: 'custom', check: async (page) => {
    return await page.$$('.item').length > 5;
  }}
], {
  timeout: 20000,
  checkInterval: 500
});

if (result.matched) {
  console.log('Matched:', result.condition);
}
```

### Debugging

```javascript
// Take screenshot
await debugScreenshot(page, 'my_label', {
  fullPage: false
});

// Get page state
const state = await getPageState(page);
console.log(state); // { url, title, ready, visible, screenshots }

// Detect common issues
const issues = await detectIssues(page);
console.log(issues); // { captcha, error, blocked, rateLimit, redirect }
```

### Context Creation

```javascript
// Create browser context with anti-detection
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled']
});

const context = await createRobustContext(browser, {
  viewport: { width: 1366, height: 768 },
  // Other context options...
});
```

### Retry Wrapper

```javascript
// Wrap any operation with retry logic
const result = await withRetry(async () => {
  // Your code here
  await page.click('.button');
  return { success: true };
}, {
  retries: 3,
  delay: 1000,
  backoff: 1.5,
  onRetry: async (error, attempt) => {
    console.log(`Retry ${attempt}: ${error.message}`);
  },
  shouldRetry: (error) => {
    return !error.message.includes('CAPTCHA');
  }
});
```

### Utilities

```javascript
// Sleep with jitter (human-like)
await sleep(1000, 0.2); // 1000ms ± 20%

// Configure global settings
configure({
  verbose: true,
  maxRetries: 5,
  longTimeout: 45000
});
```

## Common Patterns

### Login Flow

```javascript
await safeGoto(page, 'https://site.com/login');
await waitForPageReady(page);

await safeType(page, ['#email', 'input[type="email"]'], 'user@example.com', {
  humanLike: true
});

await safeType(page, ['#password', 'input[type="password"]'], 'password123', {
  humanLike: true
});

await safeClick(page, ['button[type="submit"]', '.login-btn']);

const result = await waitForAny(page, [
  { type: 'url', value: '/dashboard' },
  { type: 'selector', value: '.error' }
]);
```

### Form Fill

```javascript
const fields = [
  { selectors: ['#name'], value: 'John Doe' },
  { selectors: ['#email'], value: 'john@example.com' }
];

for (const field of fields) {
  await safeType(page, field.selectors, field.value, {
    humanLike: true,
    verify: true
  });
  await sleep(500);
}

await safeClick(page, 'button[type="submit"]');
```

### Error Handling

```javascript
try {
  await safeClick(page, '.button');
} catch (error) {
  await debugScreenshot(page, 'error_state');
  const state = await getPageState(page);
  const issues = await detectIssues(page);

  console.log('Error:', error.message);
  console.log('Page:', state.url);
  console.log('Issues:', issues);

  if (issues.captcha) {
    // Handle CAPTCHA
  }
}
```

### Check Before Action

```javascript
const issues = await detectIssues(page);

if (issues.captcha) {
  console.log('CAPTCHA detected!');
  // Handle it
}

if (issues.rateLimit) {
  console.log('Rate limited, waiting...');
  await sleep(60000);
}

if (issues.error) {
  console.log('Error page detected');
  await debugScreenshot(page, 'error_page');
}
```

## Timeout Reference

| Timeout | Value | Use For |
|---------|-------|---------|
| `shortTimeout` | 5s | Quick checks |
| `mediumTimeout` | 15s | Element waits |
| `longTimeout` | 30s | Navigation |
| `extraLongTimeout` | 60s | Heavy pages |

## Best Practices

1. **Always use array of selectors** - Provides fallbacks
2. **Enable humanLike for logins** - Avoids detection
3. **Use domcontentloaded** - Faster than networkidle
4. **Check for issues early** - detectIssues() before critical actions
5. **Take screenshots** - Especially on errors
6. **Configure retries** - 3 is good default, 5 for critical operations
7. **Avoid fixed sleeps** - Use smartWait or waitForAny instead

## Integration with Other Utils

```javascript
// With credentials module
const { autoFillLogin } = require('./credentials');
await safeGoto(page, 'https://site.com/login');
await autoFillLogin(page);

// With CAPTCHA handler
const { handleCaptcha } = require('./captcha_handler');
const issues = await detectIssues(page);
if (issues.captcha) {
  await handleCaptcha(page, sendMessageFunc);
}

// With Google auth
const { createAuthenticatedContext } = require('./credentials');
const context = await createAuthenticatedContext(browser);
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Still getting timeouts | Increase timeout, add more fallback selectors |
| Element not clickable | Set `forceClick: true` or check for overlay |
| Type not working | Try `clear: true` and `verify: true` |
| Page not loading | Use `domcontentloaded` instead of `networkidle` |
| Detected as bot | Use `createRobustContext` and `humanLike: true` |
| Random failures | Add `retries: 5` and check `detectIssues()` |

## Example: Complete Script Template

```javascript
const { chromium } = require('playwright');
const {
  createRobustContext,
  safeGoto,
  waitForPageReady,
  safeClick,
  safeType,
  waitForAny,
  debugScreenshot,
  detectIssues
} = require('./utils/playwright_helpers');

async function myAutomation() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await createRobustContext(browser);
  const page = await context.newPage();

  try {
    // Navigate
    await safeGoto(page, 'https://example.com');
    await waitForPageReady(page);

    // Check issues
    const issues = await detectIssues(page);
    if (issues.captcha || issues.blocked || issues.rateLimit) {
      await debugScreenshot(page, 'issue_detected');
      throw new Error('Page has issues');
    }

    // Interact
    await safeClick(page, ['.button', 'button.primary']);
    await safeType(page, ['#input'], 'text value', { humanLike: true });

    // Wait for result
    const result = await waitForAny(page, [
      { type: 'selector', value: '.success' },
      { type: 'selector', value: '.error' }
    ]);

    if (result.matched && result.condition.value === '.success') {
      console.log('Success!');
      await debugScreenshot(page, 'success');
    }

  } catch (error) {
    console.error('Error:', error.message);
    await debugScreenshot(page, 'final_error');
  } finally {
    // await browser.close();
  }
}
```
