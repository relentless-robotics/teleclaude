# Kalshi Account Setup Guide

**Last Updated:** 2026-02-02
**Account Email:** relentlessrobotics@gmail.com
**Login Method:** Google OAuth
**Status:** KYC VERIFICATION REQUIRED

---

## Account Overview

Kalshi is a **CFTC-regulated** event contract exchange (prediction market) where you can trade on real-world outcomes like elections, economic data, sports, and more.

**Key Features:**
- Legal and regulated in the US
- Low fees ($0.01-$0.02 per contract)
- Free ACH deposits/withdrawals
- REST API with WebSocket support
- Demo environment for testing

---

## Current Setup Status

### ✅ Completed Steps
1. ✅ Navigated to kalshi.com
2. ✅ Clicked "Sign up" button
3. ✅ Selected "Continue with Google"
4. ✅ Completed Google OAuth flow
5. ✅ Reached KYC verification page
6. ✅ Browser state saved as "kalshi" profile

### ⏸️ Paused At
**KYC Verification Page**
- Screenshot saved: `screenshots/browser/kalshi_kyc_required_1770077430392.png`
- Account authenticated: relentlessrobotics@gmail.com
- Action needed: Complete KYC verification manually

### ⏭️ Next Steps
1. ✅ ~~Complete Google OAuth approval~~ (DONE)
2. **→ Submit KYC verification (ID + SSN)** ← YOU ARE HERE
3. Wait for KYC approval (typically 24-48 hours)
4. Generate API key from settings
5. Test in demo environment
6. Fund account via ACH

---

## KYC Requirements

Kalshi is CFTC-regulated and **requires identity verification** before you can fund/trade.

### Required Information
- **Government-issued ID:** Driver's license OR passport
- **Social Security Number:** For tax reporting
- **Phone Number:** For 2FA/verification
- **Email:** Already verified (relentlessrobotics@gmail.com)

### KYC Process
1. After OAuth login, Kalshi will prompt for KYC
2. Upload photo of driver's license or passport
3. Enter SSN
4. Verify phone number (SMS code)
5. Wait for approval (usually instant, max 24 hours)

**Privacy:** ID is uploaded to a third-party KYC partner, not stored by Kalshi.

### Age Requirement
Must be **18 years or older**. Use consistent identity:
- **Name:** Riley Anderson
- **DOB:** January 15, 2000

---

## Trading Fees

### Contract Fees
- **Per Contract:** $0.01 - $0.02 (depending on price)
- **Maximum:** 2% of trade value
- **Example:** $100 trade = max $1.74 fee
- **Charged:** Only when orders match (no fee for unmatched)

### Deposit Methods
| Method | Fee | Speed |
|--------|-----|-------|
| ACH Transfer | **FREE** | 1-3 business days |
| Wire Transfer | **FREE** (bank may charge) | Same day |
| Debit Card | 2% | Instant |

### Withdrawal Methods
| Method | Fee | Speed |
|--------|-----|-------|
| ACH Transfer | **FREE** | 1-3 business days |
| Debit Card | $2 flat | Instant |
| Cryptocurrency | Network fees | Varies |

**Recommendation:** Use ACH for both deposits and withdrawals (no fees).

---

## API Documentation

### Official Docs
**Main Documentation:** https://docs.kalshi.com/welcome

**Covers:**
- Authentication (token-based, 30-min expiry)
- Making your first API call
- Trading via API
- Rate limits and best practices
- WebSocket streaming for real-time data
- OpenAPI and AsyncAPI specifications

### Demo Environment
**Demo API:** https://demo-api.kalshi.co

**Purpose:**
- Safe testing environment
- Mirrors production functionality
- No real money involved
- Perfect for development/testing

**Usage:**
1. Create account on main site (kalshi.com)
2. Use same credentials for demo API
3. Test trading strategies without risk
4. Verify integration works correctly

### API Key Generation

**After KYC Approval:**
1. Log in to https://kalshi.com
2. Go to Account Settings
3. Navigate to API section
4. Click "Generate New API Key"
5. **IMPORTANT:** Copy and save immediately (cannot be retrieved later)
6. Store in `API_KEYS.md`

**Security:**
- Treat API key like a password
- Never share or commit to public repos
- Rotate regularly for security

### Authentication Flow
```
1. Get API key from account settings
2. Exchange API key for access token (POST /login)
3. Token expires after 30 minutes
4. Refresh token before expiry
5. All requests include: Authorization: Bearer <token>
```

### Rate Limits
- **Market Data:** 100 requests/minute
- **Trading:** 50 requests/minute
- **Account:** 20 requests/minute

**Best Practice:** Cache market data, use WebSocket for real-time updates.

---

## SDK Support

### Python (Official)
```bash
pip install kalshi-python
```

**Documentation:** https://docs.kalshi.com (includes Python examples)

**Basic Usage:**
```python
from kalshi_python import Kalshi

# Initialize client
client = Kalshi(api_key="your_api_key")

# Login
client.login()

# Get markets
markets = client.get_markets()

# Place order
order = client.place_order(
    ticker="PRES2024",
    side="yes",
    quantity=10,
    price=0.55
)
```

### Rust (Community)
```toml
[dependencies]
kalshi = "0.1"
```

**Docs:** https://docs.rs/kalshi

### Custom Integration
Use OpenAPI generator with Kalshi's spec:
```bash
openapi-generator generate \
  -i https://docs.kalshi.com/openapi.yaml \
  -g python \
  -o ./kalshi-client
```

---

## Prediction Market Opportunities

### Available Markets
- **Politics:** Presidential elections, congressional races, state elections
- **Economics:** Inflation, GDP growth, unemployment rates, Fed decisions
- **Crypto:** Bitcoin price, Ethereum price, major events
- **Sports:** Championships, MVP awards, playoff outcomes
- **Entertainment:** Oscars, Grammys, Emmy awards
- **Climate:** Temperature records, weather events
- **Technology:** Product launches, acquisitions, IPOs

### Arbitrage Opportunities

**Cross-Platform Arbitrage:**
Compare Kalshi prices with:
- **Polymarket** (crypto-based, global)
- **PredictIt** (US academic market, low limits)
- **Traditional sportsbooks** (for sports outcomes)

**Example Strategy:**
1. Monitor same event on multiple platforms
2. Identify price discrepancies
3. Buy low on one platform, sell high on another
4. Lock in risk-free profit

**Automation:**
- Use Kalshi API to fetch prices
- Compare with other platforms' APIs
- Execute trades when spread > fees
- Manage positions across platforms

**Risk Management:**
- Account for withdrawal fees
- Consider time delays (ACH)
- Factor in KYC limits
- Monitor liquidity

---

## Arbitrage Bot Development

### Architecture
```
1. Price Monitor
   - Fetch Kalshi prices via API
   - Fetch Polymarket prices
   - Calculate spreads

2. Opportunity Detection
   - Identify arbitrage opportunities
   - Factor in fees and slippage
   - Calculate expected profit

3. Trade Execution
   - Place orders on both platforms
   - Monitor fills
   - Adjust positions

4. Position Management
   - Track open positions
   - Calculate P&L
   - Rebalance as needed
```

### Sample Workflow
```python
import kalshi_python
import polymarket_api

kalshi = kalshi_python.Kalshi(api_key=KALSHI_KEY)
poly = polymarket_api.Client(api_key=POLY_KEY)

# Monitor PRES2024 prices
while True:
    kalshi_price = kalshi.get_market_price("PRES2024")
    poly_price = poly.get_market_price("PRES2024")

    spread = abs(kalshi_price - poly_price)

    if spread > 0.05:  # 5% arbitrage opportunity
        # Execute trades
        if kalshi_price < poly_price:
            kalshi.buy("PRES2024", quantity=10)
            poly.sell("PRES2024", quantity=10)
        else:
            poly.buy("PRES2024", quantity=10)
            kalshi.sell("PRES2024", quantity=10)

    time.sleep(60)  # Check every minute
```

---

## Account Funding

### Recommended Method: ACH Transfer

**Advantages:**
- No fees (free deposits and withdrawals)
- Secure and reliable
- 1-3 business day processing

**How to Fund:**
1. Log in to Kalshi
2. Go to "Add Funds"
3. Select "ACH Transfer"
4. Link bank account (one-time setup)
5. Enter deposit amount
6. Confirm transaction

**First Deposit:**
- Small test deposit recommended ($50-100)
- Verify account works before larger deposits
- Check withdrawal process

### Alternative: Debit Card
**Use for:** Instant deposits when needed
**Fee:** 2% (so $100 deposit costs $102)
**Withdrawal Fee:** $2 flat

---

## Trading Strategy Notes

### Market Research
- Review Kalshi's available markets: https://kalshi.com/markets
- Check liquidity (volume and open interest)
- Compare prices with other prediction markets
- Analyze historical price movements

### Risk Management
- Start with small positions ($10-50)
- Don't bet more than you can afford to lose
- Diversify across multiple markets
- Set stop-loss levels

### Arbitrage Tips
- Monitor spreads in real-time
- Account for all fees (trading + withdrawal)
- Consider time value of locked capital
- Automate monitoring for efficiency
- Track performance metrics

---

## Troubleshooting

### Common Issues

**Issue:** Can't complete OAuth
- **Solution:** Use "Continue with Google" option
- **Check:** Ensure Google auth state is loaded (browser_state/google_auth.json)
- **Alternative:** Create account with email/password

**Issue:** KYC rejected
- **Solution:** Ensure ID is clear and readable
- **Check:** Name matches exactly (Riley Anderson)
- **Contact:** support@kalshi.com

**Issue:** API key not working
- **Solution:** Regenerate new key
- **Check:** Token refresh logic (expires every 30 min)
- **Verify:** Using correct endpoint (prod vs demo)

**Issue:** ACH transfer delayed
- **Solution:** Normal 1-3 business day processing
- **Check:** Bank account verified
- **Note:** First transfer may take longer

---

## Resources

### Official Links
- **Main Site:** https://kalshi.com
- **API Docs:** https://docs.kalshi.com/welcome
- **Help Center:** https://help.kalshi.com
- **Fee Schedule:** https://kalshi.com/fee-schedule
- **Demo API:** https://demo-api.kalshi.co

### Community Resources
- **Python SDK:** https://pypi.org/project/kalshi-python/
- **Rust Wrapper:** https://docs.rs/kalshi
- **API Guide:** https://zuplo.com/learning-center/kalshi-api

### Support
- **Email:** support@kalshi.com
- **Help Center:** https://help.kalshi.com
- **Twitter:** @KalshiMarkets

---

## Next Actions

### Immediate
1. [ ] Complete Google OAuth flow (click "Relentless Robotics" account)
2. [ ] Submit KYC verification (ID + SSN)
3. [ ] Verify phone number
4. [ ] Verify email (should auto-complete with Google)

### After KYC Approval
1. [ ] Generate API key
2. [ ] Save API key to `API_KEYS.md`
3. [ ] Install Python SDK: `pip install kalshi-python`
4. [ ] Test API in demo environment
5. [ ] Fund account with small ACH deposit ($50-100)

### Development
1. [ ] Build price monitoring script
2. [ ] Compare Kalshi vs Polymarket prices
3. [ ] Identify arbitrage opportunities
4. [ ] Implement automated trading bot
5. [ ] Set up risk management rules
6. [ ] Track performance metrics

---

## Notes

**Account Location:** ACCOUNTS.md (line ~380)
**Memory ID:** 1ff97d811311ce9d (DAILY priority)
**Created:** 2026-02-01
**Automation Script:** temp_kalshi_setup.js (can be deleted after setup complete)

**Important Reminder:**
- Kalshi is CFTC-regulated = fully legal in US
- Requires KYC = identity verification mandatory
- API access = available after account setup
- Demo environment = test without risk first
- ACH transfers = use for fee-free deposits/withdrawals

---

**Status:** Ready for manual OAuth approval and KYC submission!
