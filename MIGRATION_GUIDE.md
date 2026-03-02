# Browser Automation Migration Guide

This guide helps you migrate existing browser automation code to the new unified `browser.js` module.

## Why Migrate?

The new unified browser module (`utils/browser.js`) provides:

✅ **All-in-one solution** - Combines stealth, retries, auth management
✅ **Simpler API** - Cleaner, more intuitive methods
✅ **Better reliability** - Built-in retries and error recovery
✅ **Auth management** - Save and reuse login sessions
✅ **Human-like behavior** - Evade detection automatically
✅ **Comprehensive detection** - CAPTCHA, errors, rate limits

## Quick Reference

### Before (Old Code)

```javascript
// Using multiple imports
const { chromium } = require('playwright');
const { safeClick, safeType, createRobustContext } = require('./utils/playwright_helpers');
const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser');
const { createAuthenticatedContext } = require('./utils/credentials');

// Complex setup
const browser = await chromium.launch({ headless: false });
const context = await createRobustContext(browser);
const page = await context.newPage();

// Manual interactions
await safeClick(page, 'button.submit', { retries: 3 });
await safeType(page, '#email', 'test@example.com', { humanLike: true });

// Manual cleanup
await page.close();
await context.close();
await browser.close();
```

### After (New Code)

```javascript
// Single import
const browser = require('./utils/browser');

// Simple setup
const session = await browser.launch({ stealth: true, auth: 'google' });

// Clean interactions
await session.click('button.submit');
await session.type('#email', 'test@example.com');

// Simple cleanup
await session.close();
```

## Migration Steps

### Step 1: Update Imports

**Before:**
```javascript
const { chromium } = require('playwright');
const { safeClick, safeType, waitForPageReady } = require('./utils/playwright_helpers');
const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser');
const { getCredentials, autoFillLogin } = require('./utils/credentials');
```

**After:**
```javascript
const browser = require('./utils/browser');
```

### Step 2: Replace Browser Launch

**Before:**
```javascript
const browserInstance = await chromium.launch({
  headless: false,
  channel: 'msedge'
});

const context = await createRobustContext(browserInstance);
const page = await context.newPage();
```

**After:**
```javascript
const session = await browser.launch({
  headless: false,
  stealth: true
});
```

### Step 3: Replace Auth Loading

**Before:**
```javascript
const storageStatePath = path.join(__dirname, 'browser_state', 'google_auth.json');
const context = await browser.newContext({
  storageState: fs.existsSync(storageStatePath) ? storageStatePath : undefined
});
```

**After:**
```javascript
const session = await browser.withGoogleAuth();
// or
const session = await browser.launch({ auth: 'google' });
```

### Step 4: Replace Navigation

**Before:**
```javascript
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
await waitForPageReady(page);
```

**After:**
```javascript
await session.goto('https://example.com');
// waitForReady is called automatically
```

### Step 5: Replace Clicks

**Before:**
```javascript
await safeClick(page, 'button.submit', {
  retries: 3,
  timeout: 15000,
  waitForNavigation: true
});
```

**After:**
```javascript
await session.click('button.submit', {
  waitForNavigation: true
});
// retries are automatic
```

### Step 6: Replace Typing

**Before:**
```javascript
await safeType(page, '#email', 'test@example.com', {
  humanLike: true,
  retries: 3,
  clear: true
});
```

**After:**
```javascript
await session.type('#email', 'test@example.com', {
  humanLike: true
});
// clear is default, retries are automatic
```

### Step 7: Replace Auto-Fill

**Before:**
```javascript
const { autoFillLogin } = require('./utils/credentials');
await autoFillLogin(page);
```

**After:**
```javascript
await session.autoFillLogin();
```

### Step 8: Replace Issue Detection

**Before:**
```javascript
const { detectIssues } = require('./utils/playwright_helpers');
const issues = await detectIssues(page);
```

**After:**
```javascript
const issues = await browser.detectIssues(session.page);
// or
const state = await session.getState();
console.log(state.issues);
```

### Step 9: Replace Screenshots

**Before:**
```javascript
const { debugScreenshot } = require('./utils/playwright_helpers');
await debugScreenshot(page, 'my_label');
```

**After:**
```javascript
await session.screenshot('my_label');
```

### Step 10: Replace Cleanup

**Before:**
```javascript
await page.close();
await context.close();
await browser.close();
```

**After:**
```javascript
await session.close();
```

## Complete Example Migration

### Before (Old Approach)

```javascript
const { chromium } = require('playwright');
const { safeClick, safeType, createRobustContext, waitForPageReady } = require('./utils/playwright_helpers');
const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser');
const fs = require('fs');
const path = require('path');

async function loginToGitHub() {
  // Launch with stealth
  const { browser, context, page } = await launchStealthBrowser({
    headless: false
  });

  try {
    // Navigate
    await page.goto('https://github.com/login');
    await waitForPageReady(page);

    // Fill form
    await safeType(page, '#login_field', 'user@example.com', {
      humanLike: true,
      retries: 3
    });

    await safeType(page, '#password', 'password123', {
      humanLike: true,
      retries: 3
    });

    // Submit
    await safeClick(page, 'input[type="submit"]', {
      retries: 3,
      waitForNavigation: true
    });

    // Wait for dashboard
    await page.waitForSelector('.avatar', { timeout: 10000 });

    // Save auth
    const authPath = path.join(__dirname, 'browser_state', 'github_auth.json');
    const storageState = await context.storageState();
    fs.writeFileSync(authPath, JSON.stringify(storageState, null, 2));

    console.log('Login successful!');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}
```

### After (New Unified Module)

```javascript
const browser = require('./utils/browser');

async function loginToGitHub() {
  const session = await browser.launch({
    headless: false,
    stealth: true
  });

  try {
    await session.goto('https://github.com/login');

    await session.type('#login_field', 'user@example.com', { humanLike: true });
    await session.type('#password', 'password123', { humanLike: true });

    await session.click('input[type="submit"]', { waitForNavigation: true });

    // Wait for dashboard
    await session.findElement('.avatar', { timeout: 10000 });

    // Save auth
    await session.saveAuthState('github');

    console.log('Login successful!');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await session.close();
  }
}
```

**Lines of code:** 47 → 28 (40% reduction!)
**Imports:** 5 → 1
**Complexity:** High → Low

## API Mapping Table

| Old (Multiple Modules) | New (browser.js) | Notes |
|------------------------|------------------|-------|
| `chromium.launch()` + `createRobustContext()` | `browser.launch()` | All-in-one |
| `launchStealthBrowser()` | `browser.launch({ stealth: true })` | Stealth by default |
| `createAuthenticatedContext()` | `browser.launch({ auth: 'profile' })` | Built-in auth loading |
| `safeClick(page, ...)` | `session.click(...)` | Cleaner API |
| `safeType(page, ...)` | `session.type(...)` | Cleaner API |
| `waitForPageReady(page)` | `session.waitForReady()` | Called automatically |
| `findElement(page, ...)` | `session.findElement(...)` | Built-in |
| `smartWait(page, ...)` | `session.findElement(..., { timeout })` | Integrated |
| `waitForAny(page, ...)` | `session.waitForAny(...)` | Built-in |
| `autoFillLogin(page)` | `session.autoFillLogin()` | Built-in |
| `detectIssues(page)` | `browser.detectIssues(session.page)` | Utility function |
| `detectCaptcha(page)` | `browser.detectCaptcha(session.page)` | Utility function |
| `debugScreenshot(page, ...)` | `session.screenshot(...)` | Built-in |
| `getPageState(page)` | `session.getState()` | Built-in |
| Manual auth save | `session.saveAuthState('name')` | Simple method |
| Manual auth load | `browser.launch({ auth: 'name' })` | Automatic |
| Manual retry logic | Automatic retries | Built-in (configurable) |
| Manual stealth scripts | Automatic stealth | Enabled by default |

## Common Pitfalls

### 1. Forgetting to call `.page` for Playwright methods

**Wrong:**
```javascript
await session.evaluate(() => document.title);
```

**Correct:**
```javascript
await session.page.evaluate(() => document.title);
```

The session wraps the page, context, and browser. For Playwright-specific methods not wrapped, use `session.page`.

### 2. Not using try/finally for cleanup

**Wrong:**
```javascript
const session = await browser.launch();
await session.goto('https://example.com');
await session.close();
```

**Correct:**
```javascript
const session = await browser.launch();
try {
  await session.goto('https://example.com');
} finally {
  await session.close();
}
```

### 3. Mixing old and new APIs

**Avoid:**
```javascript
const session = await browser.launch();
await safeClick(session.page, 'button'); // Don't mix!
```

**Do:**
```javascript
const session = await browser.launch();
await session.click('button'); // Use session methods
```

## Gradual Migration Strategy

You don't have to migrate everything at once. Here's a gradual approach:

### Phase 1: New Scripts Only
- Use new module for all new automation scripts
- Keep existing scripts on old modules

### Phase 2: High-Value Migrations
- Migrate frequently-used scripts first
- Migrate scripts that benefit most from auth management

### Phase 3: Full Migration
- Migrate remaining scripts
- Deprecate old helper modules

## Need Help?

- **Examples:** See `examples/` directory
- **Documentation:** Check `CLAUDE.md` (search "UNIFIED BROWSER AUTOMATION")
- **Source code:** Read `utils/browser.js` for full API
- **Profiles:** Check `utils/browser_profiles.js` for auth management

## Backward Compatibility

The old modules still work! You can:
- Keep using old code if it works
- Migrate gradually
- Mix old and new (not recommended)

The new module is the **recommended** approach going forward.
