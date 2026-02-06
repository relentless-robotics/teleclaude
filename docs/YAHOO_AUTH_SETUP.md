# Yahoo Finance Authentication Setup

## Overview

Yahoo Finance now requires authentication (crumb + cookies) for accessing the options chain API. This document explains how the persistent authentication system works.

## How It Works

1. **Browser Automation**: Uses Playwright with saved Google OAuth session
2. **Crumb Extraction**: Extracts the Yahoo Finance API crumb token from the authenticated page
3. **Cookie Storage**: Saves essential session cookies (filtered to avoid header overflow)
4. **Persistent Auth**: Stores authentication state for ~30 days

## Files

| File | Purpose |
|------|---------|
| `setup_yahoo_auth.js` | Main authentication setup script |
| `browser_state/yahoo_auth.json` | Stored crumb + cookies (gitignored) |
| `swing_options/api_client.js` | Updated to auto-load saved auth |
| `test_yahoo_options.js` | Test script to verify API access |

## Initial Setup

Run the authentication setup script:

```bash
node setup_yahoo_auth.js
```

This will:
1. Launch Edge browser with Google auth pre-loaded
2. Navigate to Yahoo Finance
3. Sign in via Google OAuth (relentlessrobotics@gmail.com)
4. Extract the crumb token from the page
5. Save cookies and crumb to `browser_state/yahoo_auth.json`
6. Test the options API to verify it works

## Usage in Code

The authentication is **automatically loaded** when using the Yahoo API client:

```javascript
const { yahoo } = require('./swing_options/api_client');

// Auth is loaded automatically on first use
const options = await yahoo.optionsChain('AAPL');
```

### What You Get

```javascript
{
  symbol: 'AAPL',
  expirationDates: ['2026-02-04', '2026-02-06', ...],
  strikes: [185, 190, 195, ...],
  calls: [
    {
      strike: 185,
      lastPrice: 79.19,
      bid: 82.8,
      ask: 86.25,
      volume: 1,
      openInterest: 1,
      impliedVolatility: 2.75
    },
    ...
  ],
  puts: [...]
}
```

## Testing

Verify the authentication works:

```bash
node test_yahoo_options.js
```

This tests:
- Quote API (AAPL, TSLA, SPY)
- Options chain API
- Displays sample options data

Expected output:
```
✅ Options chain successful!
Symbol: AAPL
Expirations available: 24
Total calls: 36
Total puts: 29
```

## Re-authentication

Auth expires after **~30 days**. When expired, you'll see:

```
⚠️ Yahoo auth expired (>30 days old). Run: node setup_yahoo_auth.js
```

Simply re-run the setup script to refresh:

```bash
node setup_yahoo_auth.js
```

## Troubleshooting

### "Header overflow" error

**Cause:** Too many cookies being sent in HTTP headers.

**Solution:** The code now filters to only essential Yahoo cookies (2-3 cookies instead of 189). If you still see this error, check the cookie filter in `api_client.js`.

### "Could not extract crumb token"

**Cause:** Login flow didn't complete or page structure changed.

**Solution:**
1. Check the screenshot in `screenshots/browser/yahoo_auth_error_*.png`
2. Verify Google auth is working (run `node utils/gh_auth.js` to test)
3. The script may need updates if Yahoo changed their page structure

### Options API returns null

**Cause:** Authentication not loaded or expired.

**Solution:**
1. Run `node test_yahoo_options.js` to diagnose
2. Check if `browser_state/yahoo_auth.json` exists
3. Re-run `node setup_yahoo_auth.js` if needed

### "Failed to fetch" during browser test

**Expected behavior.** The in-browser API test (step 5 of setup) often fails due to CORS restrictions. This is normal. The real test is from Node.js, which works correctly.

## Technical Details

### Cookie Filtering

To avoid header overflow, only essential cookies are used:

```javascript
const essentialCookies = cookies.filter(c => {
  const name = c.name.toLowerCase();
  return (
    c.domain.includes('yahoo.com') &&
    (name.includes('b') ||      // Session cookies
     name.includes('a3') ||     // Yahoo auth
     name.includes('guc') ||    // Yahoo user
     name.includes('as') ||     // Yahoo session
     name.includes('gpp') ||    // Privacy
     name === 'thamba')         // Auth token
  );
});
```

### Auth State Format

`browser_state/yahoo_auth.json`:
```json
{
  "crumb": "y/2aLGU.qGb",
  "cookies": [
    { "name": "A3", "value": "...", "domain": ".yahoo.com" },
    { "name": "GUC", "value": "...", "domain": ".yahoo.com" }
  ],
  "timestamp": "2026-02-04T00:57:31.018Z",
  "expiresAt": "2026-03-06T00:57:31.018Z"
}
```

## API Endpoints Used

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `query1.finance.yahoo.com/v8/finance/chart/{symbol}` | Stock quotes | No |
| `query1.finance.yahoo.com/v7/finance/options/{symbol}` | Options chain | Yes (crumb + cookies) |
| `query2.finance.yahoo.com/v1/test/getcrumb` | Get crumb token | Yes (cookies) |

## Integration with Swing Options System

The Yahoo auth integrates seamlessly with the swing options trading system:

```javascript
const { aggregator } = require('./swing_options/api_client');

// Get full options data with historical volatility
const data = await aggregator.getOptionsData('AAPL');
// {
//   symbol: 'AAPL',
//   currentPrice: 269.48,
//   expirations: [...],
//   calls: [...],
//   puts: [...],
//   historicalVolatility: 0.32
// }
```

## Security

- Auth file is gitignored (not committed to repo)
- Cookies are stored locally only
- No sensitive data in code (loaded from `browser_state/`)
- Google OAuth session already saved in `browser_state/google_auth.json`

## See Also

- `CLAUDE.md` - Main teleclaude documentation
- `swing_options/README.md` - Swing options trading system
- `utils/browser.js` - Unified browser automation module
