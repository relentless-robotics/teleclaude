# Comprehensive Trading Analysis Guide

## Overview

This guide documents the complete data analysis framework for swing trading decisions.
Every trade analysis MUST cover all sections to ensure systematic, data-driven decisions.

---

## 1. MACRO ENVIRONMENT ANALYSIS

### 1.1 Fed/Monetary Policy
**Source:** `macro_catalyst_scanner.js`, FRED API

| Check | Data Point | Source | Frequency |
|-------|-----------|--------|-----------|
| ✅ | Fed Funds Rate | FRED FEDFUNDS | Daily |
| ✅ | 2Y Treasury Yield | FRED DGS2 | Daily |
| ✅ | 10Y Treasury Yield | FRED DGS10 | Daily |
| ✅ | Yield Curve Spread (10Y-2Y) | FRED T10Y2Y | Daily |
| ✅ | Next FOMC Meeting | Static schedule | - |
| ✅ | FOMC Minutes Release | Static schedule | - |
| ✅ | Fed Speaker Events | News scan | Daily |

**Interpretation:**
- Inverted curve (spread < 0) = Recession risk, defensive positioning
- Flat curve (0-0.5%) = Late cycle, caution
- Normal curve (>0.5%) = Expansion, risk-on
- 2Y < Fed Funds = Market pricing cuts
- 2Y > Fed Funds = Market pricing hikes

### 1.2 Economic Data Calendar
**Source:** `macro_catalyst_scanner.js`

| Indicator | Impact | Typical Release | Affected Sectors |
|-----------|--------|-----------------|------------------|
| NFP (Jobs) | HIGH | 1st Friday | XLY, SPY, QQQ |
| CPI | HIGH | ~12th of month | All, TLT, XLF |
| GDP | HIGH | End of quarter | All |
| PCE | HIGH | Last Friday | All, rate-sensitive |
| ISM Manufacturing | MED | 1st business day | XLI, XLB |
| Retail Sales | MED | Mid-month | XRT, XLY |
| Housing Starts | MED | Mid-month | XHB, ITB |
| Consumer Confidence | LOW | Last Tuesday | XLY |
| Initial Claims | LOW | Every Thursday | SPY |

**Pre-Data Positioning:**
- High-impact data (CPI, NFP): Position 1-2 days before
- Consider straddles for binary outcomes
- Watch consensus vs whisper numbers

### 1.3 VIX & Volatility Regime
**Source:** FRED VIXCLS, Yahoo Finance

| VIX Level | Regime | Implication |
|-----------|--------|-------------|
| < 15 | Low Vol | Complacency, mean reversion risk |
| 15-20 | Normal | Standard conditions |
| 20-25 | Elevated | Caution, tighter stops |
| 25-30 | High | Hedging recommended |
| > 30 | Crisis | Risk-off, cash preferred |

### 1.4 Geopolitical Events
**Source:** News API scan

- Trade policy/tariffs
- Sanctions
- Military conflicts
- Elections (US and major global)
- Central bank decisions (ECB, BOJ, BOE)

---

## 2. MARKET STRUCTURE ANALYSIS

### 2.1 Broad Market Health
**Source:** Yahoo Finance, Alpha Vantage

| Check | Metric | Bullish | Bearish |
|-------|--------|---------|---------|
| ✅ | SPY trend | Above 50/200 MA | Below MAs |
| ✅ | QQQ trend | Above 50/200 MA | Below MAs |
| ✅ | IWM trend | Above 50/200 MA | Below MAs |
| ✅ | Advance/Decline | Positive | Negative |
| ✅ | New Highs/Lows | More highs | More lows |
| ✅ | Sector rotation | Risk-on leading | Defensive leading |

### 2.2 Sector Analysis
**Source:** `universe_scanner.js`, ETF holdings

**Sector ETFs Tracked:**
- XLF (Financials) - Rate sensitive
- XLE (Energy) - Oil/geopolitical
- XLK (Technology) - Growth/momentum
- XLV (Healthcare) - Defensive
- XLY (Consumer Disc) - Economic health
- XLP (Consumer Staples) - Defensive
- XLI (Industrials) - Economic cycle
- XLU (Utilities) - Rate sensitive
- XLRE (Real Estate) - Rate sensitive
- XLB (Materials) - Inflation/growth

### 2.3 Market Internals
| Metric | Source | Interpretation |
|--------|--------|----------------|
| Put/Call Ratio | CBOE | >1.0 = Fear, <0.7 = Complacency |
| VIX Term Structure | Yahoo | Contango = Normal, Backwardation = Fear |
| Credit Spreads | FRED | Widening = Risk-off |

---

## 3. STOCK UNIVERSE & DISCOVERY

### 3.1 Universe Composition
**Source:** `universe_scanner.js`

**Total Universe: ~322 stocks**

| Source | Count | Purpose |
|--------|-------|---------|
| SPY Holdings | 50 | Large cap quality |
| QQQ Holdings | 50 | Tech/growth |
| Sector ETFs | 150 | Sector plays |
| Meme/Momentum | 30 | High vol opportunities |
| Social Trending | 30 | Momentum capture |
| Options Liquid | 100 | Tradeable universe |

### 3.2 Stock Discovery Methods

1. **Social Momentum** (Reddit, StockTwits)
   - Top mentions trending
   - Sentiment shifts
   - Volume of discussion

2. **Technical Screeners**
   - RSI < 30 (Oversold)
   - RSI > 70 (Overbought)
   - Volume > 2x average
   - Near 52-week high/low

3. **Catalyst-Driven**
   - Upcoming earnings
   - FDA decisions
   - Insider buying clusters
   - Analyst upgrades

4. **Sector Rotation**
   - Based on macro environment
   - FOMC → Financials, Utilities
   - CPI → Consumer, Rate-sensitive
   - Energy news → XLE stocks

---

## 4. INDIVIDUAL STOCK ANALYSIS

### 4.1 Fundamental Quick Check
| Check | Pass Criteria |
|-------|---------------|
| Market Cap | $1B - $200B (sweet spot) |
| Average Volume | > 1M shares/day |
| Options Available | Yes, liquid |
| Earnings Date | Known, within window |
| Short Interest | Note if > 15% |

### 4.2 Technical Analysis
| Indicator | Source | Use |
|-----------|--------|-----|
| RSI (14) | Finviz | Oversold/overbought |
| 50-day MA | Yahoo | Trend |
| 200-day MA | Yahoo | Long-term trend |
| Volume | Yahoo | Confirmation |
| Support/Resistance | Chart | Entry/exit levels |

### 4.3 Catalyst Analysis
**For EACH potential trade, identify:**

1. **Primary Catalyst**
   - What will move the stock?
   - When is the event?
   - What's the expected impact?

2. **Directional Evidence** (REQUIRED for earnings/binary events)
   - Analyst estimate revisions (up/down?)
   - Whisper numbers
   - Peer read-through
   - Management signals
   - Options positioning (put/call skew)
   - Historical pattern

3. **Risk Assessment**
   - Max loss scenario
   - Stop loss level
   - Position size appropriate?

---

## 5. OPTIONS ANALYSIS

### 5.1 IV Environment
**Source:** `options_analyzer.js`, Yahoo Finance

| IV Percentile | Environment | Strategy Preference |
|---------------|-------------|---------------------|
| < 20% | Low IV | Buy options, long gamma |
| 20-50% | Normal | Direction plays |
| 50-80% | Elevated | Spreads, defined risk |
| > 80% | High IV | Sell premium, iron condors |

### 5.2 Strategy Selection Matrix

| Outlook | Low IV (<30%) | High IV (>50%) |
|---------|---------------|----------------|
| Bullish | Long Call, Call Spread | Call Spread, Short Put |
| Bearish | Long Put, Put Spread | Put Spread, Short Call |
| Neutral | Iron Condor | Iron Condor, Strangle |
| Vol Play | Straddle, Strangle | Iron Butterfly |

### 5.3 Greeks Check
- Delta: Directional exposure
- Theta: Time decay (enemy for buyers)
- Vega: IV sensitivity
- Gamma: Rate of delta change

---

## 6. POSITION MANAGEMENT

### 6.1 Entry Checklist
- [ ] Macro environment favorable?
- [ ] Sector trend aligned?
- [ ] Catalyst identified with timing?
- [ ] Directional evidence supports thesis?
- [ ] IV environment appropriate for strategy?
- [ ] Risk/reward acceptable (>2:1)?
- [ ] Position size within limits (<5% portfolio)?

### 6.2 Exit Rules
| Condition | Action |
|-----------|--------|
| -7% loss | Stop loss (hard rule) |
| +15% gain | Take profits or trail stop |
| Catalyst passed | Re-evaluate thesis |
| Thesis broken | Exit regardless of P/L |
| Time decay concern | Roll or close |

### 6.3 Portfolio Limits
- Max 5 positions simultaneously
- Max 5% per position
- Max 20% in single sector
- Always maintain 30% cash reserve

---

## 7. REPORTING SCHEDULE

### Daily Checks
- [ ] Market open/close levels
- [ ] VIX level
- [ ] Position P/L
- [ ] Any triggered stops

### Pre-Market (8:30 AM ET)
- [ ] Overnight futures
- [ ] Economic data releases
- [ ] Pre-market movers
- [ ] News scan

### Hourly During Market
- [ ] Position status
- [ ] Stop/target triggers
- [ ] Unusual volume alerts

### Weekly Review
- [ ] Performance summary
- [ ] Win/loss analysis
- [ ] Strategy effectiveness
- [ ] Upcoming catalysts

---

## 8. DATA SOURCES SUMMARY

| Data Type | Primary Source | Backup | API Limit |
|-----------|---------------|--------|-----------|
| Quotes | Yahoo Finance | Alpha Vantage | Unlimited / 25/day |
| Economic | FRED | - | Unlimited |
| Options | Yahoo Finance | - | Unlimited |
| News | Alpha Vantage | Finviz | 25/day |
| Social | ApeWisdom, StockTwits | - | Rate limited |
| Insider | Finnhub | SEC EDGAR | 60/min |
| FOMC | Static schedule | Fed website | - |

---

## 9. SCANNER OUTPUTS

### Comprehensive Scanner (`comprehensive_scanner.js`)
```
Outputs:
- criticalEvents: High-priority events next 3 days
- topOpportunities: Ranked trading ideas
- macro.rateContext: Fed/yield analysis
- universe.technicalSetups: RSI extremes, etc.
- All catalysts combined and prioritized
```

### Macro Scanner (`macro_catalyst_scanner.js`)
```
Outputs:
- fomc: Upcoming Fed events
- economic: Data release calendar
- regulatory: FDA, SEC events
- geopolitical: News-based events
- rateContext: Current rate environment
```

### Universe Scanner (`universe_scanner.js`)
```
Outputs:
- universe: Full stock list (322)
- technicalSetups.oversold: RSI < 30
- technicalSetups.overbought: RSI > 70
- Sector breakdowns available
```

---

## 10. QUICK REFERENCE

### Before ANY Trade
1. Check macro (FOMC proximity, econ data)
2. Check VIX regime
3. Identify specific catalyst
4. Verify directional evidence
5. Assess IV for strategy selection
6. Size appropriately

### Red Flags (Don't Trade)
- No clear catalyst
- Earnings with no directional thesis
- VIX > 30 (unless hedging)
- Position would exceed limits
- Thesis is "hope" not evidence

### Green Lights
- Clear catalyst with timing
- Directional evidence aligns
- IV appropriate for strategy
- Risk/reward > 2:1
- Macro environment supportive

---

*Last Updated: February 4, 2026*
*Version: 2.0 - Expanded Catalyst Universe*
