# Tradier Developer Account Setup

**Date:** 2026-02-04
**Status:** IN PROGRESS - Manual completion required

## What is Tradier?

Tradier is a brokerage platform that provides:
- FREE API access for market data (stocks, options, futures)
- Sandbox environment with delayed data (15-minute delay)
- Production API for real-time data (requires brokerage account)
- 120 requests/minute rate limit (sandbox)

## Account Details

| Field | Value |
|-------|-------|
| Platform | Tradier Brokerage |
| Email | relentlessrobotics@gmail.com |
| Password | `Tradier@Robotics2026!` |
| Name | Riley Anderson |
| Plan | LITE (FREE - $0/month) |
| Signup URL | https://www.tradier.com/ |
| Dashboard | https://dash.tradier.com/ |
| API Settings | https://dash.tradier.com/settings/api |

## Setup Steps

### 1. Create Account ✅ (STARTED)

Browser automation has been launched and navigated to Tradier signup page.

**Credentials prepared:**
- Email: relentlessrobotics@gmail.com
- Password: Tradier@Robotics2026!
- First Name: Riley
- Last Name: Anderson

### 2. Select Plan (PENDING)

Choose the **LITE Plan** - $0/month
- Includes API access
- Paper trading account
- Delayed market data (15 min)
- Perfect for development/testing

### 3. Complete Signup (PENDING)

Fill out remaining required fields:
- Phone number (if required)
- Accept terms and conditions
- Submit form

### 4. Email Verification (PENDING)

Check Gmail: relentlessrobotics@gmail.com
- Look for verification email from Tradier
- Click verification link
- Confirm account

### 5. Get API Tokens (PENDING)

Once logged in:
1. Navigate to: https://dash.tradier.com/settings/api
2. Copy both tokens:
   - **Sandbox Token** (for development with delayed data)
   - **Production Token** (for live data - if applicable)

## API Information

### Endpoints

**Sandbox (Free/Delayed Data):**
```
https://sandbox.tradier.com/v1/
```

**Production (Real-time Data):**
```
https://api.tradier.com/v1/
```

### Authentication

All API requests require Bearer token authentication:

```bash
curl -X GET "https://sandbox.tradier.com/v1/markets/quotes?symbols=AAPL" \
  -H "Authorization: Bearer YOUR_SANDBOX_TOKEN" \
  -H "Accept: application/json"
```

### Rate Limits

- **Sandbox:** 120 requests/minute
- **Production:** Higher limits (account-dependent)

### Available Data

**Market Data:**
- Stock quotes (delayed 15 min in sandbox)
- Options chains
- Historical data
- Market calendar
- Company fundamentals

**Options Endpoints:**
```
GET /v1/markets/options/chains?symbol=SPY
GET /v1/markets/options/expirations?symbol=SPY
GET /v1/markets/options/strikes?symbol=SPY&expiration=2024-12-20
```

## Documentation

- **API Docs:** https://docs.tradier.com/
- **Getting Started:** https://docs.tradier.com/docs/getting-started
- **Market Data Guide:** https://docs.tradier.com/docs/market-data
- **Authentication:** https://docs.tradier.com/docs/authentication

## Next Steps After Setup

1. **Test API Connection:**
   ```javascript
   const axios = require('axios');

   const API_TOKEN = 'YOUR_SANDBOX_TOKEN';
   const BASE_URL = 'https://sandbox.tradier.com/v1';

   async function testConnection() {
     const response = await axios.get(`${BASE_URL}/markets/quotes`, {
       headers: {
         'Authorization': `Bearer ${API_TOKEN}`,
         'Accept': 'application/json'
       },
       params: {
         symbols: 'AAPL'
       }
     });
     console.log(response.data);
   }
   ```

2. **Integrate with Swing Options Toolkit:**
   - Update toolkit to use Tradier for options chain data
   - Replace Yahoo Finance options scraping
   - Add IV (implied volatility) analysis

3. **Store Credentials:**
   - Add to `ACCOUNTS.md`
   - Add API token to `API_KEYS.md`
   - Update password manager

## Troubleshooting

**Issue:** Email verification not received
- Check spam/promotions folder
- Resend verification email from Tradier
- Wait 5-10 minutes

**Issue:** API token not visible
- Ensure account is fully activated
- Check email verification completed
- Try logging out and back in

**Issue:** API requests failing
- Verify Bearer token format: `Authorization: Bearer TOKEN`
- Check rate limits (120/min)
- Ensure using correct endpoint (sandbox vs production)

## Related Files

- Account credentials: `ACCOUNTS.md`
- API tokens: `API_KEYS.md`
- Automation scripts:
  - `tradier_brokerage_signup.js` (main signup automation)
  - `tradier_complete_signup.js` (form filling)
  - `tradier_manual_login.js` (manual browser helper)

## Resources

- [Tradier API Documentation](https://docs.tradier.com/)
- [Tradier Developer Portal](https://developer.tradier.com/)
- [Python Client: PyTradier](https://pytradier.readthedocs.io/)
- [Fintech Sandbox Partnership](https://www.fintechsandbox.org/partner/tradier/)

---

**Status:** Browser automation running. Waiting for manual completion of signup and API token retrieval.

**Last Updated:** 2026-02-04 01:07 UTC
