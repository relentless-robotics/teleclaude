# Playwright Helpers Migration Checklist

Use this checklist when updating existing scripts to use the new helpers.

## Pre-Migration

- [ ] Read `BEFORE_AFTER_COMPARISON.md` to see real examples
- [ ] Skim `PLAYWRIGHT_CHEATSHEET.md` for quick reference
- [ ] Run `node utils/example_improved_script.js` to see it working
- [ ] Identify your most problematic script to migrate first

## For Each Script

### 1. Setup (2 minutes)

- [ ] Add import at top of file:
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
    detectIssues
  } = require('./utils/playwright_helpers');
  ```

- [ ] Update browser launch args:
  ```javascript
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  ```

- [ ] Replace `browser.newContext()`:
  ```javascript
  // OLD
  const context = await browser.newContext();

  // NEW
  const context = await createRobustContext(browser);
  ```

### 2. Navigation (5 minutes)

Find all instances of `page.goto()` and replace:

- [ ] Replace `page.goto(url, { waitUntil: 'networkidle' })`
  ```javascript
  // OLD
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // NEW
  await safeGoto(page, url, {
    waitUntil: 'domcontentloaded',
    retries: 3
  });
  await waitForPageReady(page);
  ```

### 3. Clicking Elements (10 minutes)

Find all instances of `page.click()` or `element.click()`:

- [ ] Simple clicks → `safeClick()`
  ```javascript
  // OLD
  const button = await page.$('.submit');
  await button.click();

  // NEW
  await safeClick(page, ['.submit', 'button[type="submit"]']);
  ```

- [ ] Add fallback selectors for important clicks
- [ ] Use `scrollIntoView: true` if elements might be off-screen
- [ ] Use `waitForNavigation: true` if click causes page change

### 4. Typing/Filling (10 minutes)

Find all instances of `page.fill()` or `element.type()`:

- [ ] Replace fills with `safeType()`
  ```javascript
  // OLD
  await page.fill('#email', 'test@example.com');

  // NEW
  await safeType(page, [
    '#email',
    'input[type="email"]',
    'input[name="email"]'
  ], 'test@example.com', {
    humanLike: true,
    verify: true
  });
  ```

- [ ] Add fallback selectors for all inputs
- [ ] Enable `humanLike: true` for login forms
- [ ] Enable `verify: true` for critical inputs

### 5. Waiting (15 minutes)

Find all instances of waiting and replace:

- [ ] Replace `page.waitForTimeout()` with smart waits
  ```javascript
  // OLD
  await page.waitForTimeout(3000);

  // NEW
  await smartWait(page, ['.expected-element', '.result']);
  ```

- [ ] Replace `page.waitForSelector()` with `smartWait()`
  ```javascript
  // OLD
  await page.waitForSelector('.result', { timeout: 5000 });

  // NEW
  await smartWait(page, ['.result', '.success', '.data'], {
    timeout: 15000,
    state: 'visible'
  });
  ```

- [ ] Use `waitForAny()` for success/error detection
  ```javascript
  const result = await waitForAny(page, [
    { type: 'url', value: '/success' },
    { type: 'selector', value: '.error' },
    { type: 'text', value: 'Welcome' }
  ]);
  ```

### 6. Element Finding (10 minutes)

Find all manual selector loops:

- [ ] Replace manual loops with helper
  ```javascript
  // OLD
  let element = null;
  for (const sel of selectors) {
    element = await page.$(sel);
    if (element) break;
  }

  // NEW
  const element = await findElement(page, selectors);
  ```

### 7. Error Handling (10 minutes)

- [ ] Add try/catch blocks if missing
- [ ] Add `debugScreenshot()` in catch blocks
  ```javascript
  try {
    // Your code
  } catch (error) {
    await debugScreenshot(page, 'error_state');
    const state = await getPageState(page);
    console.log('Error:', error.message);
    console.log('Page state:', state);
    throw error;
  }
  ```

- [ ] Add `detectIssues()` before critical operations
  ```javascript
  const issues = await detectIssues(page);
  if (issues.captcha) {
    // Handle CAPTCHA
  }
  if (issues.rateLimit) {
    await sleep(60000);
  }
  ```

### 8. Testing (10 minutes)

- [ ] Run the script
- [ ] Check console for debug logs
- [ ] Verify it completes successfully
- [ ] Check screenshots in `screenshots/debug/`
- [ ] Test failure scenarios (wrong credentials, etc.)

### 9. Optimization (5 minutes)

- [ ] Adjust timeouts if needed
  ```javascript
  configure({
    mediumTimeout: 20000, // Increase if pages are slow
    maxRetries: 5         // Increase if flaky
  });
  ```

- [ ] Remove unnecessary screenshots
- [ ] Add progress messages if using with Telegram/Discord
  ```javascript
  if (sendMessage) {
    await sendMessage('Logging in...');
  }
  ```

## Common Replacements

| Old Pattern | New Pattern | Time Saved |
|-------------|-------------|------------|
| Manual selector loops (10 lines) | `safeClick(page, selectors)` | 9 lines |
| `waitForTimeout(3000)` | `smartWait(page, sel)` | More reliable |
| Custom retry logic (15 lines) | `withRetry(() => ...)` | 14 lines |
| Manual typing delays | `safeType(..., { humanLike: true })` | Automatic |
| URL checking | `waitForAny([{ type: 'url', ... }])` | Clearer |

## Script-Specific Checklists

### Login Scripts

- [ ] Use `safeType()` with `humanLike: true` for credentials
- [ ] Use `waitForAny()` to detect success/error/2FA
- [ ] Add `detectIssues()` before and after login
- [ ] Take screenshots at key points
- [ ] Handle CAPTCHA if detected

### Signup Scripts

- [ ] Use `safeType()` for all form fields
- [ ] Add `verify: true` for important fields
- [ ] Use `detectIssues()` to check for errors
- [ ] Handle email verification workflow
- [ ] Check for "account exists" messages

### Scraping Scripts

- [ ] Use `smartWait()` for dynamic content
- [ ] Use `waitForAny()` for pagination/load more
- [ ] Add retry logic with `withRetry()`
- [ ] Take screenshots of final data

## Validation Checklist

After migration, verify:

- [ ] Script runs without errors
- [ ] Success rate is 80%+ (vs previous rate)
- [ ] No unnecessary `waitForTimeout()` calls
- [ ] Screenshots are taken on errors
- [ ] Logging is informative
- [ ] Code is more readable

## Common Issues After Migration

### Issue: "Too many retries"
**Fix:** Increase timeout or check selectors are correct
```javascript
await safeClick(page, selectors, { timeout: 30000 });
```

### Issue: "Element not clickable"
**Fix:** Add `scrollIntoView` or check for overlays
```javascript
await safeClick(page, sel, { scrollIntoView: true });
```

### Issue: "Typed text not appearing"
**Fix:** Enable verification and check element is correct
```javascript
await safeType(page, sel, text, { verify: true, clear: true });
```

### Issue: "Still timing out"
**Fix:** Use `waitForAny()` instead of waiting for one specific thing
```javascript
const result = await waitForAny(page, [
  { type: 'selector', value: '.expected' },
  { type: 'selector', value: '.alternative' },
  { type: 'url', value: '/next-page' }
]);
```

## Performance Notes

- **Faster:** `domcontentloaded` vs `networkidle` (2-5x faster)
- **Slower:** Retries add time, but increase reliability
- **Overall:** ~10% slower execution, 3x fewer failures

**Net result:** Much better success rate, worth the small time cost

## Rollback Plan

If migration causes issues:

1. Keep old file as `script_name.old.js`
2. Test new version thoroughly
3. Can revert to old version if needed
4. Report issues for help

## Getting Help

If stuck during migration:

1. Check `BEFORE_AFTER_COMPARISON.md` for similar pattern
2. Check `PLAYWRIGHT_CHEATSHEET.md` for function reference
3. Look at `example_improved_script.js` for working code
4. Ask for help with specific error message

## Progress Tracking

Track your migration progress:

- [ ] Script 1: _________________ (Status: _______)
- [ ] Script 2: _________________ (Status: _______)
- [ ] Script 3: _________________ (Status: _______)
- [ ] Script 4: _________________ (Status: _______)
- [ ] Script 5: _________________ (Status: _______)

Status codes:
- TODO: Not started
- WIP: In progress
- TESTING: Migrated, testing
- DONE: Complete and working
- BLOCKED: Issue preventing completion

## Estimated Time

Per script:
- Simple script (< 50 lines): 15-20 minutes
- Medium script (50-150 lines): 30-45 minutes
- Complex script (150+ lines): 1-2 hours

## Success Metrics

Track improvement:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Success rate | ___% | ___% | ___% |
| Avg runtime | ___s | ___s | ___s |
| Manual fixes needed | ___ | ___ | ___ |
| Lines of code | ___ | ___ | ___ |

## Final Steps

After migrating all scripts:

- [ ] Update documentation
- [ ] Share learnings with team
- [ ] Consider adding more helpers for common patterns
- [ ] Celebrate increased reliability!

---

**Remember:** Migrate one script at a time. Test thoroughly. The helpers are designed to make scripts MORE reliable, not just different.
