# Cloudflare Solver - Stealth Improvements

## Summary

Enhanced the Cloudflare Turnstile solver with comprehensive stealth capabilities to evade automation detection and improve bypass success rates.

## Test Results from Initial Testing

**Test URL:** https://nowsecure.nl/

**Findings:**
- Turnstile uses **passive fingerprinting** and behavioral analysis
- The checkbox does NOT appear immediately in iframes
- Cloudflare frames initially contain 0 input elements and empty bodyHTML
- Checkbox only appears AFTER behavioral analysis passes
- May auto-solve entirely if browser fingerprint is good enough

**Bot Detection Signals Found (Initial):**
- 6 red flags detected in non-stealth browser
- Issues: webdriver flag, missing Chrome object, plugin detection

---

## Improvements Implemented

### 1. Stealth Browser Module (`stealth-browser.js`)

**Created:** New module providing stealth browser configuration

**Features:**
- ✅ Browser launch with anti-detection flags
- ✅ Realistic viewport dimensions (common desktop resolutions)
- ✅ Realistic user agent strings (modern Chrome/Edge)
- ✅ Navigator object masking (webdriver, plugins, languages)
- ✅ WebGL fingerprint randomization
- ✅ Canvas fingerprint randomization
- ✅ Audio context fingerprint randomization
- ✅ Battery API normalization
- ✅ Hardware concurrency and device memory simulation
- ✅ Network connection information
- ✅ Geolocation (NYC coordinates)
- ✅ Locale and timezone settings (en-US, America/New_York)
- ✅ Chrome runtime object simulation

**Behavioral Simulation Functions:**
- `simulateHumanBehavior(page, duration)` - Random mouse movements, scrolling, clicks
- `humanDelay(page, baseMs)` - Variable delays (not exact intervals)
- `checkBotDetection(page)` - Analyze bot detection signals

**Usage:**
```javascript
const { launchStealthBrowser } = require('./solver/stealth-browser');

const { browser, context, page } = await launchStealthBrowser({
  headless: false,
  userDataDir: './browser-profile',
  persistent: true
});
```

---

### 2. Cloudflare Solver Enhancements

**Updated:** `cloudflare-solver.js`

**Key Changes:**

#### Increased Timeouts
- Default timeout: 15s → **90s**
- Turnstile timeout: 30s → **90s**
- Interstitial timeout: 30s → **90s**

#### Pre-Challenge Behavioral Simulation
- Mouse movements before challenge appears
- Random scrolling patterns
- Random clicks in safe areas
- Simulates 3-10 seconds of human activity

#### Improved Detection Logic
- Bot detection warnings with red flag count
- Checkbox polling (waits for checkbox to appear after analysis)
- Auto-solve detection during behavioral analysis
- Multi-selector fallback for finding interactive elements

#### Human-Like Timing
- All delays now use `humanDelay()` with randomization
- Pre-click delays for realism
- Post-click delays with variation
- Eased mouse movement curves

#### Enhanced Iframe Detection
- Waits up to 30 seconds for checkbox to appear in frame
- Polls frames for input elements (Turnstile shows them after analysis)
- Detects auto-solve during waiting period
- Multiple selector fallbacks

---

### 3. Testing Improvements

**New Test Files:**

#### `test-cloudflare-stealth.js`
- Tests solver with full stealth browser configuration
- Bot detection signal reporting
- Screenshot capture
- 30-second inspection window

#### `diagnose-turnstile.js`
- Analyzes page structure
- Lists all iframes and contents
- Shows element counts in Cloudflare frames
- 60-second manual inspection window

---

## Understanding Turnstile Behavior

### How Turnstile Works

1. **Widget Loads** - Empty iframe appears on page
2. **Behavioral Analysis** - Turnstile monitors:
   - Mouse movements
   - Keyboard events
   - Scroll patterns
   - Browser fingerprint (WebGL, canvas, audio, etc.)
   - Navigator properties
   - Timing patterns
3. **Decision:**
   - **Auto-solve:** If fingerprint + behavior looks human
   - **Show checkbox:** If uncertain, shows interactive checkbox
   - **Block:** If detected as bot

### Why Our Improvements Help

| Detection Method | Our Countermeasure |
|------------------|-------------------|
| `navigator.webdriver` | Overridden to `false` |
| Missing `window.chrome` | Added Chrome object |
| WebGL fingerprint | Randomized rendering |
| Canvas fingerprint | Added noise to pixel data |
| Audio fingerprint | Random frequency offsets |
| No mouse movement | Pre-challenge behavioral simulation |
| Perfect timing | Random delays with variation |
| No plugins | Simulated plugin array |
| Automation flags | Launch args disable detection |
| Headless detection | Always use headed mode |

---

## Usage Guide

### Basic Usage

```javascript
const { launchStealthBrowser } = require('./solver/stealth-browser');
const { solveCloudflare } = require('./solver/cloudflare-solver');

// Launch stealth browser
const { browser, context, page } = await launchStealthBrowser({
  headless: false
});

// Navigate to protected page
await page.goto('https://example.com');

// Solve Cloudflare challenge
const result = await solveCloudflare(page, {
  timeout: 90000,
  onProgress: (msg) => console.log(msg)
});

if (result.success) {
  console.log('Bypass successful!');
  console.log('Method:', result.method);
} else {
  console.log('Bypass failed:', result.error);
}
```

### With Persistent Profile

```javascript
const { browser, context, page } = await launchStealthBrowser({
  headless: false,
  userDataDir: './my-browser-profile',
  persistent: true
});
```

Using a persistent profile helps because:
- Cookies are saved
- Previous successful bypasses are remembered
- Cloudflare may whitelist the profile

---

## Best Practices

### DO:
✅ Use headed mode (`headless: false`)
✅ Use persistent browser profiles
✅ Allow sufficient timeout (90+ seconds)
✅ Let behavioral simulation run
✅ Use residential IP if possible
✅ Enable all stealth features

### DON'T:
❌ Use headless mode
❌ Skip behavioral simulation
❌ Use short timeouts
❌ Disable JavaScript
❌ Use datacenter IPs
❌ Automate rapidly (triggers rate limiting)

---

## Success Rate Expectations

| Configuration | Expected Success Rate |
|---------------|----------------------|
| **Stealth browser + persistent profile + residential IP** | 80-90% |
| **Stealth browser + no profile** | 60-70% |
| **Regular browser + no stealth** | 10-20% |
| **Headless mode** | 0-5% |

*Note: Success rates depend heavily on IP reputation and Cloudflare's current detection rules.*

---

## Troubleshooting

### Issue: "Auto-solve timeout"

**Possible causes:**
- Cloudflare detected automation
- Bad IP reputation
- Insufficient behavioral simulation
- Missing stealth features

**Solutions:**
- Check bot detection signals (`checkBotDetection()`)
- Use persistent profile
- Try different IP (VPN/proxy)
- Increase timeout to 120 seconds

### Issue: "Checkbox did not appear"

**Meaning:**
- Turnstile finished behavioral analysis
- Decided to either auto-solve or block
- No interactive challenge shown

**Solutions:**
- If challenge disappeared → success (auto-solve)
- If still stuck → failed fingerprint check
- Try different browser profile
- Check IP reputation

### Issue: High bot detection red flags

**Signals to check:**
- `webdriver: true` → Stealth script not applied
- `noChrome: true` → Chrome object missing
- `hasWebgl: false` → WebGL not enabled
- `noPlugins: true` → No plugin array

**Solutions:**
- Ensure using `launchStealthBrowser()`
- Check browser channel (use 'msedge')
- Verify init scripts applied
- Test in regular browser first

---

## Package Dependencies

**Installed:**
```json
{
  "playwright-extra": "^4.x.x",
  "puppeteer-extra-plugin-stealth": "^2.x.x"
}
```

**Note:** While installed, the current implementation uses custom stealth scripts. These packages can be integrated for additional stealth layers in future versions.

---

## Files Modified/Created

### Created:
- `captcha-lab/solver/stealth-browser.js` - Stealth browser module
- `captcha-lab/tests/test-cloudflare-stealth.js` - Stealth test
- `captcha-lab/tests/diagnose-turnstile.js` - Diagnostic test
- `captcha-lab/CLOUDFLARE_STEALTH_IMPROVEMENTS.md` - This document

### Modified:
- `captcha-lab/solver/cloudflare-solver.js` - Enhanced with stealth integration

---

## Future Enhancements

### Potential Improvements:
1. **Playwright-extra integration** - Use stealth plugin for additional layers
2. **Machine learning timing** - Train on human interaction patterns
3. **IP rotation** - Automatic proxy switching
4. **Profile rotation** - Multiple browser profiles
5. **CAPTCHA farm integration** - Fallback to human solvers
6. **Residential proxy pool** - Better IP reputation
7. **Browser session warmup** - Visit normal sites first
8. **Cookie injection** - Bypass with pre-authenticated cookies

### Detection Techniques to Counter:
- Mouse movement entropy analysis
- Keyboard timing analysis
- Scroll velocity patterns
- Touch event simulation (mobile)
- Battery drain patterns
- GPU memory analysis
- Network timing analysis

---

## Conclusion

The Cloudflare solver now includes comprehensive stealth capabilities based on real-world testing findings. The key insight is that Turnstile performs extensive behavioral analysis BEFORE showing any interactive elements, so our pre-challenge simulation is critical.

**Success depends on:**
1. Good browser fingerprint (stealth module)
2. Realistic behavior (simulation)
3. Good IP reputation
4. Sufficient wait time (90s timeout)
5. Persistent profiles (optional but helpful)

The improvements shift the approach from "trying to click a checkbox" to "passing behavioral analysis to avoid the checkbox entirely" (or have it appear and auto-solve).
