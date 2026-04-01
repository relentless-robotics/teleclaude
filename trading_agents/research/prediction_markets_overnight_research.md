# Prediction Markets Overnight Research
**Date:** 2026-03-02 (overnight autonomous session)
**Status:** RESEARCH COMPLETE — Ready for implementation decisions
**Scope:** Kalshi + Polymarket — historical data, strategy edges, API updates, vol model integration, FOMC Mar 18 analysis

---

## Table of Contents

1. [Code Audit: What We Have](#1-code-audit-what-we-have)
2. [Critical API Changes (Action Required)](#2-critical-api-changes-action-required)
3. [Historical Data Sources — Updated](#3-historical-data-sources--updated)
4. [Deepened Strategy Research](#4-deepened-strategy-research)
5. [FOMC March 18 Analysis](#5-fomc-march-18-analysis)
6. [Vol Model → Bracket Pricing Edge Analysis](#6-vol-model--bracket-pricing-edge-analysis)
7. [Platform Comparison: Updated Verdict](#7-platform-comparison-updated-verdict)
8. [Concrete Recommendations with Expected Returns](#8-concrete-recommendations-with-expected-returns)
9. [Implementation Roadmap](#9-implementation-roadmap)
10. [Risk Register](#10-risk-register)

---

## 1. CODE AUDIT: WHAT WE HAVE

### 1.1 Existing Files

| File | Purpose | Status |
|------|---------|--------|
| `trading_agents/prediction_markets/kalshi_client.py` | Full Kalshi SDK wrapper | BUILT — needs API update |
| `trading_agents/prediction_markets/scan_brackets.py` | Standalone scanner for JS agent | BUILT — uses mock prices |
| `trading_agents/research/prediction_markets_research.md` | Foundation research doc | COMPLETE |

### 1.2 What's Built

**BracketPricer** — Prices SPX brackets using log-normal distribution (scipy.stats.norm). Handles:
- Bounded and unbounded brackets ("5900 or above", "5700 or below")
- Four-way edge detection: BUY_YES, BUY_NO, SELL_YES, SELL_NO
- Fee deduction (0.035 coefficient for SPX)
- Sorting by net edge after fees

**KalshiTrader** — Full trading wrapper with:
- Demo/live mode switching
- RSA-PSS authentication via kalshi-python SDK
- Risk limits: 100 contracts/bracket, $5K total exposure, $500/trade max
- 0.5 cent minimum net edge threshold
- Position and trade log tracking

**VolModel stub** — CRITICAL GAP: Uses hardcoded 18% annualized vol placeholder. NOT connected to our IC=0.644 LightGBM/CNN model.

**scan_brackets.py** — Mock market scanner. Generates synthetic bracket prices from a simple formula instead of real Kalshi API prices. Useful for testing but not production.

### 1.3 What's Missing

1. **Real vol model connection** — Need to pipe IC=0.644 LightGBM predictions into VolModel
2. **Live data feed** — scan_brackets.py uses mock prices; need real Kalshi API prices
3. **Historical backtest data** — No historical bracket prices collected yet
4. **Subpenny pricing update** — API fields changing March 5, 2026 (see Section 2)
5. **Polymarket integration** — Zero Polymarket code built; py-clob-client not installed
6. **FOMC contracts** — No code for non-SPX financial contracts (CPI, Fed rate, GDP)
7. **Fat-tail correction** — BracketPricer uses normal distribution; SPX returns have fat tails (leptokurtic)

---

## 2. CRITICAL API CHANGES (ACTION REQUIRED)

### 2.1 Kalshi Subpenny Pricing — Deprecation March 5, 2026

**BREAKING CHANGE:** Legacy integer-cent fields are being deprecated on **March 5, 2026**.

| Old Field (DEPRECATED) | New Field | Notes |
|------------------------|-----------|-------|
| `yes_bid` (integer cents) | `yes_bid_dollars` (float, 4+ decimal places) | Subpenny precision |
| `yes_ask` (integer cents) | `yes_ask_dollars` | |
| `no_bid` (integer cents) | `no_bid_dollars` | |
| `no_ask` (integer cents) | `no_ask_dollars` | |
| `last_price` (integer cents) | `last_price_dollars` | |

**Current code in `kalshi_client.py` line 314:**
```python
"yes_bid": market.yes_bid / 100 if market.yes_bid else 0,
"yes_ask": market.yes_ask / 100 if market.yes_ask else 0,
```
This division by 100 will BREAK when the integer-cent fields stop being populated after March 5.

**Required fix:**
```python
# Use _dollars fields directly (already in 0-1 range, no division needed)
"yes_bid": getattr(market, 'yes_bid_dollars', None) or (market.yes_bid / 100 if market.yes_bid else 0),
"yes_ask": getattr(market, 'yes_ask_dollars', None) or (market.yes_ask / 100 if market.yes_ask else 0),
```
Use the `_dollars` fields as primary, fall back to legacy for backward compatibility.

### 2.2 Polymarket 500ms Taker Delay Removal — February 18, 2026

**MAJOR CHANGE:** Polymarket silently removed the 500ms taker delay. Impact:
- Market makers can no longer rely on a 500ms buffer to cancel stale quotes
- Any cancel/replace cycle >200ms results in adverse selection
- Old bots that relied on the delay were wiped out overnight
- **New requirement:** WebSocket-based real-time orderbook streaming (not polling)

**What this means for us:**
- REST API polling approach is too slow for Polymarket market making
- Need async WebSocket feed if we pursue Polymarket MM
- Actually makes Polymarket harder to enter as a new maker — competitive moat increased
- Ironically, Polymarket taker strategies (event-driven) are now EASIER — stale maker quotes
  remain in the book longer because makers are slower to update

### 2.3 Kalshi Rate Limits — Check SDK Version

Ensure you are on `kalshi-python` >= the version supporting subpenny fields. Check:
```bash
pip show kalshi-python
pip show kalshi-python-async
```

---

## 3. HISTORICAL DATA SOURCES — UPDATED

### 3.1 Kalshi Historical Data

| Source | Type | Quality | Notes |
|--------|------|---------|-------|
| **Kalshi REST API** `GET /markets/{ticker}/history` | Price timeseries | Good | Requires auth; returns timestamp-price snapshots |
| **Kalshi Market Data Portal** kalshi.com/market-data | Daily aggregates | Medium | Free; tickers, OI, daily volume |
| **KalshiData.com** | Dashboard | Low | Visual only, not bulk download |
| **PredictionData.io** | Unified API | Good | Paid; real-time + historical cross-platform |
| **GitHub: mickbransfield/kalshi** | Scraping scripts | Low | Community scripts, fragile |
| **Quantgalore/kalshi-trading** | Historical snapshots at 14:00 ET | Medium | SPX-specific; works for backtesting |
| **prediction-market-backtesting (GitHub)** | Framework | Good | Kalshi + Polymarket, fees-aware |

**Best approach for historical SPX brackets:**
1. Use `GET /markets?event_ticker=INXD-*&limit=100` with cursor pagination to get all past INXD events
2. For each market ticker, call `GET /markets/{ticker}/history?min_ts=X&max_ts=Y` to get price history
3. Store in parquet. Build one-time historical database back 12+ months.

```python
# Minimal example (requires auth headers):
import requests
from datetime import datetime, timedelta

def fetch_bracket_history(ticker, days_back=30):
    end = int(datetime.now().timestamp() * 1000)
    start = int((datetime.now() - timedelta(days=days_back)).timestamp() * 1000)
    url = f"https://trading-api.kalshi.com/trade-api/v2/markets/{ticker}/history"
    params = {"min_ts": start, "max_ts": end, "limit": 1000}
    resp = requests.get(url, params=params, headers=make_auth_headers("GET", f"/trade-api/v2/markets/{ticker}/history"))
    return resp.json().get("history", [])
```

### 3.2 Polymarket Historical Data

| Source | Type | Quality | Notes |
|--------|------|---------|-------|
| **CLOB API** `GET /prices-history?token_id=X` | Price timeseries | Medium | 12h+ granularity only for resolved markets |
| **Gamma API** `GET /markets` | Market metadata | Good | No auth needed |
| **pmxt archive** archive.pmxt.dev/Polymarket | Hourly orderbook snapshots, parquet | Excellent | Best for systematic backtest |
| **Kaggle dataset** sandeepkumarfromin/full-market-data | Bulk dump | Medium | Static snapshot, not live |
| **Dune Analytics** | On-chain trades | Good | Need SQL knowledge |
| **Bitquery GraphQL** | Trades, lifecycle | Good | API key required |
| **PolyMarketData.co** | Full historical | Good | Paid service |

**Known Issue:** `GET /prices-history` returns empty or coarse data for resolved markets (confirmed bug, open GitHub issue #216 in py-clob-client). Use pmxt archive instead for bulk historical work.

### 3.3 Free Prediction Market Datasets (Academic/Community)

| Dataset | Description | Access |
|---------|-------------|--------|
| **IMDEA Arbitrage Dataset** | 86M bets, April 2024–April 2025, Polymarket | arxiv.org/abs/2508.03474 |
| **Manifold Markets** | Open source prediction market full history | manifold.markets/api (free) |
| **PredictIt archive** | 2014–2022 election markets | Research request |
| **Metaculus** | Long-form predictions, calibration data | metaculus.com/api (free) |

---

## 4. DEEPENED STRATEGY RESEARCH

### 4.1 Strategy 1: Favorite-Longshot Bias Fading

**Source:** Whelan UCD paper (2025), CEPR working paper, QuantPedia analysis

**Confirmed on Kalshi:**
- Contracts priced < $0.10: lose >60% of invested capital
- Contracts priced > $0.50: earn small positive returns
- Takers lose 32% on average across all prices; makers lose ~10%
- The bias is STRONGEST for takers (people buying market orders at longshot prices)

**IMPORTANT 2025 Update:** The paper finds "some evidence of a weakening in the favorite-longshot bias for 2025 data." This means the market is becoming more efficient. Still present, but edge is declining as more systematic traders exploit it.

**Actionable approach:**
- Sell NO on contracts priced at 3-8 cents (effectively buying the other side at 92-97 cents)
- Focus on markets where the "longshot" outcome is driven by behavioral/emotional betting (sports, entertainment, political novelty events)
- Avoid: financial markets where longshots may be genuinely uncertain (tail risk is real)
- Expected return: +2% to +5% per trade on the far-in-the-money side
- Risk: Occasional large loss when longshot hits (must size positions for Kelly)

**Fee math at P=0.05 (5-cent contract, STANDARD fee, not SPX):**
```
Fee = ceil(0.07 * C * 0.05 * 0.95 * 100) / 100 per contract
    = ceil(0.07 * 0.05 * 0.95 * 100) / 100
    = ceil(0.3325) / 100 = $0.0034 per contract
If you BUY_NO at $0.95: pay $0.95, pay fee $0.0034
Win 95%+ of the time: receive $1.00
Net per win: $1.00 - $0.95 - $0.0034 = $0.0466 (4.9% return)
Net per loss (5% of time): -$0.9534
Expected value: 0.95 * $0.0466 - 0.05 * $0.9534 = $0.0443 - $0.0477 = -$0.0034
```
Wait — if the longshot ACTUALLY wins 5% of the time (fair market), there's NO edge. The edge only comes if:
- The actual win rate is < the market price (e.g., 2% actual rate but 5% market price)
- The UCD paper confirms this: 5-cent contracts win only ~2% of the time on Kalshi
- So: 0.98 * $0.0466 - 0.02 * $0.9534 = $0.0457 - $0.0191 = $0.0266 per contract (2.8% ROI)

**Sports/entertainment markets ONLY.** Not financial contracts where tail risk is real.

### 4.2 Strategy 2: Combinatorial Arbitrage (Polymarket)

**Source:** IMDEA paper "Unravelling the Probabilistic Forest" (arxiv:2508.03474)

**Confirmed findings:**
- $40M+ extracted from Polymarket April 2024–April 2025
- 7,000+ markets with measurable combinatorial mispricings
- Two types:
  1. **Market Rebalancing Arbitrage (intra-market):** Within a single market, prices don't sum to 1.00
  2. **Combinatorial Arbitrage (cross-market):** Logical impossibilities across related markets
     - Example: P(Trump wins) = 55%, P(Republican wins) = 50% — impossible, buy Republican YES + Trump NO
- Windows now average ~200ms (down from 2.7 sec in 2024)
- 73% of profits captured by sub-100ms bots

**Feasibility for us:** LOW without colocation and dedicated low-latency infrastructure.
- Average window: 200ms
- Our system latency: ~1-5 seconds (Python, REST API, no dedicated server)
- Conclusion: The pure combinatorial arb is gone for us. Need to focus on slower-decaying edges.

**Exception — "Slow" Combinatorial Arbitrage:**
In less-watched markets (niche political, long-dated), windows can persist for hours. These aren't the high-frequency sports/crypto arbs but the structural logical violations in obscure markets. LLM-powered analysis could identify these.

### 4.3 Strategy 3: Kalshi FOMC/Macro Event Trading

**Source:** NBER Working Paper 34702 "Kalshi and the Rise of Macro Markets" (Fed paper, Jan 2026)

**Key finding:** Kalshi markets have a PERFECT forecast record the day before FOMC meetings since 2022. Fed funds futures had multiple misses. Implication:
- Information flows INTO Kalshi faster than into traditional markets for policy events
- If we can identify a systematic edge in WHEN information flows, we can trade it
- The Kalshi vs CME divergence (64% cut vs 90% hold in early February) represents a massive spread

**Specific FOMC Mar 18 opportunity:**
As of February 5, 2026, there was a 54% spread between Kalshi (64% cut) and CME (10% cut).
See full analysis in Section 5.

**Strategy:**
- Monitor Kalshi Fed contract prices vs CME FedWatch pricing daily
- When there is >20% divergence, one market is systematically wrong
- Historically, Kalshi has been RIGHT on the day before the meeting
- If CME is right and Kalshi is wrong in the days BEFORE the meeting, there's a trade
- Buy/sell Kalshi contracts when they diverge from CME by >20%
- Unwind as meeting approaches (when information converges)

**Expected edge:** Hard to quantify without historical divergence data, but the NBER paper's finding of a "perfect forecast record" gives high confidence in Kalshi's accuracy on the day before meetings.

### 4.4 Strategy 4: Market Making on Kalshi SPX Brackets

**Source:** Kalshi docs, Liquidity Incentive Program details (runs Sep 2025–Sep 2026)

**Economics:**
- $35K/day distributed to eligible market makers (~$12.75M annualized)
- Rebates proportional to qualifying liquidity provided
- Eligible price range: $0.03 to $0.97 (avoids extreme longshots)
- Maker fee coefficient: 0.0175 (vs 0.035 for takers on SPX)
- Volume Incentive: additional $0.005/contract (capped)

**SPX bracket market making analysis:**
```
Assume: SPX bracket with spread of 2 cents (typical near-ATM)
Buy side: $0.28, Sell side: $0.30
We quote: Buy at $0.27, Sell at $0.31 (capturing $0.04 spread, outside current spread)
Better: Meet the inside: Buy at $0.29, Sell at $0.30 (1 cent spread capture)

On 100 contracts:
  Gross revenue: $1.00 (if both sides fill)
  Maker fees: 2 * ceil(0.0175 * 100 * 0.295 * 0.705 * 100) / 100
            = 2 * ceil(3.634) / 100 = 2 * $0.037 = $0.074
  Net revenue: $0.926 per round trip (100 contracts each side)
  Daily if 50 round trips: $46.30 + liquidity rebates
```

**Inventory risk is the main challenge:** Need to stay delta-neutral across the bracket chain.
If we quote all brackets, a large directional move means we accumulate a big position in the brackets that moved against us.

**Vol model helps:** If we forecast high vol, widen our quotes. If low vol, tighten.

### 4.5 Strategy 5: SPX Bracket Directional Trading with Vol Model

**This is our primary edge.** Full analysis in Section 6.

### 4.6 Strategy 6: Cross-Platform Arbitrage (Kalshi vs Polymarket vs Robinhood)

**Feasibility:** Depends entirely on overlapping contract coverage.
- Kalshi and Polymarket both cover: FOMC rate decisions, some macro events
- Window duration: Shrinking rapidly (now seconds, not minutes)
- Infrastructure required: Accounts on both platforms, API access to both, co-located server

**Current state (early 2026):**
- 73% of cross-platform arb captured by sub-100ms bots
- The "Great Prediction War of 2026" (Polymarket vs Kalshi) driving more arbitrageurs in
- For us at ~1-5 second latency: Not viable for pure arb

**Exception:** During non-liquid hours or in less-watched financial contracts, windows persist longer. Kalshi's financial markets are more developed than Polymarket's, so the price discovery usually starts on Kalshi and flows to Polymarket. If we're faster than the flow, we can:
1. Trade on Kalshi (which sets the signal)
2. Take the corresponding position on Polymarket (which hasn't updated yet)

---

## 5. FOMC MARCH 18 ANALYSIS

### 5.1 Market Divergence (as of early March 2026)

| Platform | March Rate Cut Probability | Source |
|----------|---------------------------|--------|
| Kalshi (early Feb) | 64% | predictstreet.com |
| CME FedWatch (early Feb) | 10% | Divergence reported |
| Polymarket (late Feb) | 15% (85% hold) | Polymarket.com |

**The spread has since converged.** By late February, Polymarket moved from Kalshi's view to 85% hold, meaning Kalshi traders likely updated toward CME/Polymarket's view OR Polymarket updated toward Kalshi's view. The truth is the actual March 18 decision.

**Current state (as of March 2, 2026):**
The search results from late February 2026 show:
- Polymarket: 85% probability on hold/no change
- The CME was at 90% hold
- Kalshi was at 64% cut in early February but likely moved toward 85-90% hold by now

### 5.2 How to Trade FOMC

**The core opportunity:**
FOMC day is NOT a prediction market trade — it's determined by the Fed. The edge is in the WEEKS before the meeting when markets misprice the probability.

**Specific trades for March 18:**
1. **If you believe the hold is more likely than Kalshi prices:**
   - Buy NO on the cut contract
   - Buy YES on the hold contract
   - Pocket the edge when the correct outcome occurs

2. **If CPI (mid-March) surprises:**
   - Hot CPI → markets crash → cut probability drops → Kalshi hold contracts spike
   - Cold CPI → cut probability spikes → cut YES contracts spike
   - Position BEFORE CPI if you have a view on inflation

3. **Specific contracts to watch:**
   - `KXFED-26MAR` — Fed funds rate after March meeting (range contracts)
   - `KXFEDDECISION-26MAR` — Specific decision type contracts
   - `KXRATECUTCOUNT-26DEC31` — Number of cuts in 2026

### 5.3 Kalshi's Track Record

Per NBER Working Paper 34702:
- **Perfect forecast record on the day before every FOMC meeting since 2022**
- Beats Fed funds futures and Bloomberg professional forecaster surveys
- Also beats professional forecasters on CPI (statistically significant improvement)
- Provides real-time probability distributions for GDP, CPI, unemployment, payrolls

**Implication:** If Kalshi says 85% hold on March 17 (the day before), the historical base rate says the Fed holds. This is now a documented informational edge that is publicly known, which means:
- Many arbitrageurs will try to trade Kalshi prices toward CME/traditional markets
- This pressure makes Kalshi's price MORE informative (incorporates arb activity)
- But the base rate remains valid: on the day before meetings, Kalshi has been right every time

### 5.4 FOMC Trade Plan

**Pre-meeting (now through March 17):**
- Monitor `KXFED-26MAR` and `KXFEDDECISION-26MAR` daily
- Compare to CME FedWatch
- If divergence >15%, consider taking the Kalshi side (history says Kalshi is right)
- Size: $200-500 (small; we have no API access yet)

**Day before (March 17):**
- Kalshi price = best forecast available
- No additional trades unless a major news release changes the picture

**Day of (March 18):**
- SPX brackets will have MASSIVE vol compression if Fed is expected to hold
- OR massive vol expansion if there's any uncertainty
- This is a direct input to our SPX bracket strategy

---

## 6. VOL MODEL → BRACKET PRICING EDGE ANALYSIS

### 6.1 The Core Thesis

Our vol model predicts realized volatility with IC=0.644 at 30-minute horizon. This is an EXTRAORDINARY predictive signal for SPX brackets, which are fundamentally probability bets on where SPX will close.

**The chain:**
1. Vol model predicts `rvol_30min` → scales to daily expected range
2. Daily expected range → probability distribution over close price
3. Probability distribution → fair value for each bracket
4. Fair value vs market price → edge

### 6.2 Model Output → Bracket Fair Value

**Step 1: Scale 30-min vol to daily.**

Our model predicts 30-min realized vol. Convert to expected daily move:
```python
import numpy as np
from scipy import stats

def predict_daily_vol(rvol_30min_annualized, spx_current, hours_to_close):
    """
    Convert our 30-min vol prediction to expected SPX move for remaining day.

    rvol_30min_annualized: annualized vol prediction from our model (e.g., 0.18 = 18%)
    spx_current: current SPX price (e.g., 5900)
    hours_to_close: hours remaining until 4pm ET (e.g., 4.5)
    """
    # Time scaling: annualized -> remaining hours of trading
    # 252 trading days * 6.5 hours/day = 1638 trading hours/year
    time_fraction = hours_to_close / 1638.0

    # Expected 1-sigma move for remaining day
    expected_move_1sd = spx_current * rvol_30min_annualized * np.sqrt(time_fraction)

    return {
        "sigma": expected_move_1sd,
        "1sd_range": (spx_current - expected_move_1sd, spx_current + expected_move_1sd),
        "2sd_range": (spx_current - 2*expected_move_1sd, spx_current + 2*expected_move_1sd),
    }
```

**Step 2: Apply fat-tail correction.**

SPX returns are leptokurtic (fat tails). A pure normal distribution UNDERPRICES tail brackets and OVERPRICES middle brackets.

Use Student's t-distribution instead:
```python
def bracket_fair_value_fat_tail(floor, cap, spx, sigma, df=4):
    """
    Price bracket with Student-t distribution (fat tails).
    df=4 is a typical calibration for SPX daily returns.
    """
    # Standardize bounds
    z_floor = (floor - spx) / sigma if sigma > 0 else -1e6
    z_cap = (cap - spx) / sigma if sigma > 0 else 1e6

    # Handle unbounded
    if floor <= 0 or floor == float('-inf'):
        return stats.t.cdf(z_cap, df=df)
    if cap >= spx * 2 or cap == float('inf'):
        return 1.0 - stats.t.cdf(z_floor, df=df)

    prob = stats.t.cdf(z_cap, df=df) - stats.t.cdf(z_floor, df=df)
    return max(0.0, min(1.0, prob))
```

**Why this matters:**
- Normal distribution: 2-sigma move probability = 4.55%
- Student-t (df=4): 2-sigma move probability = 8.27%
- If market uses normal distribution for pricing, tail contracts are systematically CHEAP
- If our model predicts high vol and market uses normal, we buy tail contracts aggressively

**Step 3: Compare to market.**

The market price reflects implied vol (often similar to VIX / sqrt(252) / sqrt(6.5)). Our model predicts REALIZED vol. The spread between our prediction and the implied vol determines the trade:

| Our prediction vs Market implied | Direction | Trade |
|----------------------------------|-----------|-------|
| Our vol > Market implied (+20%) | High vol regime | Buy tail brackets |
| Our vol < Market implied (-20%) | Low vol regime | Sell tail brackets, buy ATM |
| Our vol ≈ Market implied (<10%) | No edge | Market make (capture spread) |

### 6.3 Edge Quantification

**Assumptions:**
- Our model IC = 0.644 at 30-min horizon
- We trade once per day, at 9:30 AM, with the overnight/pre-market vol prediction
- Kalshi bracket width = 25 points (standard for INXD)
- SPX current = 5900, sigma = 50 points (24% annualized vol, a normal day)
- ATM bracket: 5875-5900 (priced at ~30 cents by market)

**Simulated edge from IC=0.644:**

IC of 0.644 means our vol forecast has a 0.644 rank correlation with actual realized vol. When we predict vol is HIGH, it actually IS high 82% of the time (rough interpretation). When we predict LOW, it actually IS low 82% of the time.

For bracket pricing:
- On HIGH vol days (our model says vol will be 1.5x ATM implied):
  - True sigma ≈ 75 points
  - 1-sigma range: 5825-5975 (150 pts wide)
  - ATM bracket [5875-5900] fair value: ~21% (vs market's 30%)
  - Edge buying NO on ATM bracket (33% overprice) = ~9 cents per contract
  - Or buying tail brackets [5750-5775] at 2% vs market's 1% = 1 cent raw edge
  - After 0.875 cent fee at ATM: net 8 cents. Very good.

- On LOW vol days (our model says vol will be 0.5x ATM implied):
  - True sigma ≈ 25 points
  - ATM bracket [5875-5900] fair value: ~48% (vs market's 30%)
  - Edge buying YES on ATM bracket = 18 cents gross
  - After 0.875 cent fee: 17 cents net. Excellent.

**Position sizing:**
- Daily volume on SPX brackets: $200K-355K
- Realistic fill with 2% market impact: $1K-3K per bracket
- At 3 brackets per day (1 ATM, 2 adjacents): $3K-9K deployed
- Expected edge: 8-17 cents per contract after fees
- Expected daily P&L: varies with vol regime

**Caveat:** We need to CONFIRM the vol model generalizes to daily SPX close vol, not just 30-min realized vol. They're related but not identical.

### 6.4 The Vol Risk Premium Problem (Revisited)

We already proved (2026-02-28 backtest) that using IC=0.644 vol signal to trade straddles on ES options is DEAD because:
- IV structurally > RV (vol risk premium)
- Straddle breakeven: 26 pts, avg move in top-80th-pct vol signals: 9.46 pts

**Does this apply to Kalshi brackets?**

YES and NO:

**YES (same problem):**
- Kalshi market makers also use IV-based pricing
- If market makers peg bracket prices to VIX, they embed the same vol risk premium
- Buying bracket YES in a high-vol regime might still be buying overpriced vol

**NO (key difference):**
- Kalshi contracts are binary ($0 or $1), not continuous like options
- They're priced by supply/demand, not pure Black-Scholes
- Behavioral factors: many Kalshi traders are retail, not quant. Market may not efficiently embed IV.
- **Critical test:** Are Kalshi bracket prices calibrated to VIX or to some simpler heuristic?

**Research finding:** The quantgalore/kalshi-trading system (GitHub) finds empirically that correct vol prediction gives edge on Kalshi brackets. However, their backtests use only 2 months of data and are not fully published.

**Our required action:** Collect 6 months of historical Kalshi bracket prices and correlate with next-day VIX. If correlation is <0.7, market is NOT efficiently pricing from IV, and our IC=0.644 signal has structural edge.

**Hypothesis (to test):** Retail Kalshi traders anchor bracket prices to recent historical price ranges (short-term moving average) rather than options IV. This would create edge in vol regime shifts: when vol jumps, they're slow to update, creating cheap tail brackets.

### 6.5 The Key Question We Cannot Answer Without Data

**Question:** When our vol model says "high vol day," do Kalshi bracket prices also reflect high vol (no edge) or do they lag (yes edge)?

**How to test:**
1. Build historical database of INXD bracket prices at 9:30 AM for 6+ months
2. Compare implied sigma (inferred from ATM bracket price) to VIX at same time
3. Compute our model's vol predictions for the same days
4. Measure: when we predict HIGH vol AND implied Kalshi vol < VIX, was realized vol actually high?
5. This is the structural edge test

**Expected result (hypothesis):** Kalshi implied vol lags VIX by 15-60 minutes. Our model adds predictive information beyond VIX. Combined edge should be significant.

---

## 7. PLATFORM COMPARISON: UPDATED VERDICT

### 7.1 Head-to-Head (Updated February 2026)

| Dimension | Kalshi | Polymarket |
|-----------|--------|------------|
| **SPX brackets** | YES — INXD daily, half-fee, $200-355K/day | NO — no SPX brackets |
| **Fed rate contracts** | YES — $450M+ OI, excellent liquidity | YES — March decision contract |
| **Fees (maker)** | 0.0175 * P * (1-P) — low | FREE (0%) for standard markets |
| **Fees (taker)** | 0.035 * P * (1-P) for SPX | FREE for most; 0.10% for select |
| **Liquidity incentive** | ~$35K/day distributed (via Sep 2026) | Rebates from taker fees (market-dependent) |
| **500ms delay** | Not applicable (REST-based) | Removed Feb 18, 2026 — latency arms race |
| **Historical data** | REST API + market data portal | pmxt archive (better bulk), but CLOB API buggy |
| **Market depth** | Thin on SPX brackets (whale risk) | Deep on major political/events |
| **Combinatorial arb** | Less applicable (fewer related markets) | Still present but 200ms windows |
| **API maturity** | Excellent (FIX available) | Good but WebSocket now required |
| **Our code** | Full client built | Zero code; py-clob-client not installed |
| **Regulatory certainty** | CFTC DCM — highest certainty | CFTC approved Nov 2025 — newer |

### 7.2 Updated Verdict

**PRIMARY TARGET: Kalshi**
- SPX brackets are our natural fit (vol model maps directly)
- Financial contracts (FOMC, CPI) are highest-quality prediction markets available
- Existing code can be made production-ready in 1-2 days
- Liquidity incentive program running through Sep 2026

**SECONDARY TARGET: Polymarket (long-dated financial)**
- Not for HFT market making (500ms removal makes entry too competitive)
- For: long-duration financial markets where windows persist for hours/days
- FOMC contracts where there's a 2-3 week window before resolution
- Start with paper trading Polymarket strategies before committing code effort

**SKIP (for now):**
- Polymarket market making on crypto/sports: too competitive, 200ms arb windows gone
- Cross-platform arbitrage: need colocation we don't have

---

## 8. CONCRETE RECOMMENDATIONS WITH EXPECTED RETURNS

### 8.1 Priority 1: Fix Existing Code (1-2 days)

**Actions:**
1. Update `kalshi_client.py` to handle `_dollars` fields before March 5 deprecation
2. Connect VolModel to actual LightGBM vol predictions (pipe from Lvl3Quant model)
3. Add fat-tail correction (Student-t df=4) to BracketPricer
4. Build REST auth headers (RSA-PSS) — currently a TODO in `_rest_get_brackets`

**Expected impact:** Moves system from "demo only" to "production-ready" for backtesting.

### 8.2 Priority 2: Historical Data Collection (3-5 days)

**Build a data collector:**
```python
# Pseudocode for historical database builder
def build_historical_db():
    # Get all INXD events for past 6 months
    events = list_events(series="INXD", limit=200)

    for event in events:
        for market_ticker in event.markets:
            # Get price history at 9:30 AM ET
            history = get_market_history(market_ticker, min_ts=market_open, max_ts=market_close)
            # Store: date, ticker, floor, cap, prices_at_930, prices_at_1400, resolution
            store_to_parquet(...)

    # Also collect VIX at same timestamps from Yahoo Finance / CBOE API
    vix_data = fetch_vix_intraday(...)

    # Join with our vol model predictions for those dates
    model_preds = load_historical_vol_predictions(...)
```

**Goal:** 6 months of data (June-November 2025) to correlate:
- Our model vol prediction vs Kalshi implied vol vs actual realized vol vs VIX
- This is the definitive test of our edge

### 8.3 Priority 3: SPX Bracket Strategy (Backtest first)

**Expected edge (hypothesis, not confirmed):**
- Sharpe: 0.8-1.5 (needs to be confirmed in backtest)
- Expected edge per trade: 5-15 cents per contract
- Daily capacity: $1K-5K (liquidity-limited)
- Annual P&L at $2K/day average exposure: $20K-$100K depending on edge frequency
- Max drawdown: 15-30% of capital (tail risk from vol regime changes)

**Why the range is wide:** We don't know if Kalshi bracket prices embed VIX efficiently or lag it. If they lag (our hypothesis), the Sharpe could be 1.5+. If they don't lag, Sharpe could be 0.3-0.5 (barely worth running).

**Capital needed:** $5K-$10K initial (to cover 2-3 brackets at $500-2000 each, with margin buffer)

### 8.4 Priority 4: FOMC/Macro Event Trading

**Immediate trade: March 18 FOMC**
- Monitor `KXFED-26MAR` daily
- If Kalshi hold probability < 80% while CME shows 90% hold, buy hold (NO on cut)
- Size: $200-500 (test position; no account yet)
- Target: $100-200 profit per position if correct
- Kalshi has been right on FOMC day every time since 2022

**Expected annual return (macro event trading only):**
- 8 FOMC meetings/year
- 4-6 CPI releases/year
- 4 GDP releases/year
- Total: ~18 events with trading opportunities
- Average edge per event (conservative): 5-10 cents on $500 position = $25-50/event
- Annual: $450-900 on $500 capital = 90-180% ROI (very small absolute dollars)
- Scale to $5K/position: $4,500-9,000 annual

### 8.5 Priority 5: Favorite-Longshot Bias Fading

**CAVEAT:** The 2025 data shows this bias is WEAKENING on Kalshi. Focus on:
- Sports markets (where the bias is strongest due to fan loyalty bias)
- Entertainment/novelty markets (emotional betting)
- NOT financial markets (tail risk is real)

**Expected Sharpe:** 0.5-1.0 (declining as market matures)
**Capital needed:** $1K-2K (spread across 20-50 positions for statistical significance)
**Annual P&L:** $200-800 (modest; supplemental to vol strategy)

### 8.6 Summary Table

| Strategy | Platform | Expected Sharpe | Capital Req | Annual P&L | Confidence |
|----------|----------|-----------------|-------------|------------|------------|
| **Vol model → SPX brackets** | Kalshi | 0.8-1.5 | $5-10K | $20-100K | MEDIUM (needs backtest) |
| **FOMC/Macro event trading** | Kalshi | N/A (event) | $1-5K | $1-9K | HIGH (NBER confirmed) |
| **Market making (SPX brackets)** | Kalshi | 0.5-1.0 | $10-25K | $5-20K | MEDIUM |
| **Longshot fading (sports only)** | Kalshi | 0.5-1.0 | $1-2K | $200-800 | MEDIUM-LOW (weakening) |
| **Combinatorial arb** | Polymarket | High (but rare) | $2-5K | $1-5K | LOW (too competitive) |
| **Cross-platform arb** | Both | N/A | $5K+ | Unknown | VERY LOW |

---

## 9. IMPLEMENTATION ROADMAP

### Phase 1: Immediate (This Week — Before March 5)

**Day 1-2: Fix API breaking change**
- [ ] Update `kalshi_client.py` to handle `yes_bid_dollars` fields
- [ ] Test against Kalshi demo API
- [ ] Verify the SDK version supports new fields (pip update if needed)

**Day 3-4: Connect vol model**
- [ ] Determine: where do LightGBM vol predictions live on disk?
  - Check `Lvl3Quant/alpha_discovery/` for prediction outputs
  - Vol predictions should be at 30-min or daily granularity
- [ ] Update `VolModel.predict_vol()` to load from disk or call model API
- [ ] Test: does BracketPricer produce sensible fair values with real vol?

**Day 5: Historical data collection**
- [ ] Build simple script to pull 30 days of INXD bracket price history via Kalshi API
- [ ] Store as CSV or parquet
- [ ] Correlate Kalshi implied vol with VIX for same days

### Phase 2: Backtesting (Next Week)

- [ ] Extend historical data to 6 months
- [ ] Implement backtest: for each day, get our vol prediction at 9:30 AM, price all brackets, simulate trades
- [ ] Key metrics: Sharpe, win rate, max drawdown, average edge
- [ ] Compare: normal vs fat-tail (Student-t) distribution

### Phase 3: Paper Trading (Two Weeks)

- [ ] Deploy scanner to check Kalshi prices every 30 minutes during market hours
- [ ] Log opportunities but DON'T execute (need live account first)
- [ ] Track: how many opportunities per day? What is average edge?
- [ ] Validate paper trades vs actual next-day bracket resolution

### Phase 4: Account Setup and Live Trading

- [ ] Create Kalshi account (relentlessrobotics@gmail.com or new email)
- [ ] KYC verification
- [ ] Fund with USDC (fastest) — start with $5K
- [ ] Apply for Advanced API tier (30 writes/sec — needed for market making)
- [ ] Start with small positions ($100-200 per trade)
- [ ] Scale as edge is confirmed

### Phase 5: Polymarket (Month 2+)

- [ ] Install py-clob-client: `pip install py-clob-client`
- [ ] Set up Polygon wallet (MetaMask)
- [ ] Fund with USDC on Polygon
- [ ] Focus on: FOMC/CPI markets with 2+ week windows (not HFT)
- [ ] Build simple scanner for Polymarket financial markets

---

## 10. RISK REGISTER

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Vol model doesn't map to daily SPX close vol** | MEDIUM | HIGH | Backtest first; use VIX as proxy if needed |
| **Kalshi bracket prices efficiently embed VIX** | MEDIUM | HIGH | Will discover in historical analysis; fall back to macro events |
| **API breaking change (March 5) breaks our code** | HIGH | MEDIUM | Fix within 3 days (Priority 1) |
| **Thin liquidity → can't fill** | HIGH | LOW | Keep positions small ($200-2000/bracket) |
| **Regulatory challenge (MA/NV)** | LOW | HIGH | Monitor; Kalshi's CFTC DCM status is strongest protection |
| **Competition intensifies** | HIGH (ongoing) | MEDIUM | Focus on edges that are slower-moving (vol regime, FOMC) |
| **Model overfits in Oct-Nov regime** | MEDIUM | HIGH | CNN backtest will confirm this shortly (fold 45+/94) |
| **Kalshi platform risk** | LOW | HIGH | Counterparty is CFTC-regulated; diversify to Polymarket once running |

---

## APPENDIX A: KEY CODE CHANGES NEEDED

### A.1 Fix Subpenny Pricing (Required Before March 5)

In `kalshi_client.py`, replace lines 313-320 in `get_spx_brackets()`:

```python
# OLD (will break March 5):
"yes_bid": market.yes_bid / 100 if market.yes_bid else 0,
"yes_ask": market.yes_ask / 100 if market.yes_ask else 0,
"no_bid": market.no_bid / 100 if market.no_bid else 0,
"no_ask": market.no_ask / 100 if market.no_ask else 0,

# NEW (subpenny-compatible):
"yes_bid": getattr(market, 'yes_bid_dollars', None) if getattr(market, 'yes_bid_dollars', None) is not None else (market.yes_bid / 100 if market.yes_bid else 0),
"yes_ask": getattr(market, 'yes_ask_dollars', None) if getattr(market, 'yes_ask_dollars', None) is not None else (market.yes_ask / 100 if market.yes_ask else 0),
"no_bid": getattr(market, 'no_bid_dollars', None) if getattr(market, 'no_bid_dollars', None) is not None else (market.no_bid / 100 if market.no_bid else 0),
"no_ask": getattr(market, 'no_ask_dollars', None) if getattr(market, 'no_ask_dollars', None) is not None else (market.no_ask / 100 if market.no_ask else 0),
```

### A.2 Add Fat-Tail Correction to BracketPricer

Add to `kalshi_client.py` BracketPricer class:

```python
def bracket_fair_value_tdist(
    self, floor: float, cap: float, current_spx: float,
    predicted_vol: float, hours_to_close: float, df: int = 4
) -> float:
    """
    Fat-tail bracket fair value using Student-t distribution.
    df=4 calibrated to SPX daily returns (kurtosis ~4-6).
    """
    if not HAS_SCIPY:
        return self.bracket_fair_value(floor, cap, current_spx, predicted_vol, hours_to_close)

    time_fraction = hours_to_close / (252 * 6.5)
    sigma = current_spx * predicted_vol * np.sqrt(time_fraction)
    if sigma <= 0:
        return 1.0 if floor <= current_spx <= cap else 0.0

    if floor <= 0 or floor == float('-inf'):
        z_cap = (cap - current_spx) / sigma
        return scipy_stats.t.cdf(z_cap, df=df)
    if cap >= current_spx * 2 or cap == float('inf'):
        z_floor = (floor - current_spx) / sigma
        return 1.0 - scipy_stats.t.cdf(z_floor, df=df)

    z_floor = (floor - current_spx) / sigma
    z_cap = (cap - current_spx) / sigma
    return max(0.0, min(1.0, scipy_stats.t.cdf(z_cap, df=df) - scipy_stats.t.cdf(z_floor, df=df)))
```

### A.3 VolModel → Real Model Connection

Update `VolModel.predict_vol()` in `kalshi_client.py`:

```python
def predict_vol(self, current_spx: float, hours_to_close: float) -> dict:
    """
    Get current vol prediction from LightGBM model.
    Falls back to VIX-based estimate if model unavailable.
    """
    # Try to load from Lvl3Quant model predictions
    model_vol = self._load_model_prediction()
    if model_vol is not None:
        implied_vol = model_vol
    else:
        # Fallback: use VIX as proxy
        # In production, fetch VIX from Yahoo Finance / CBOE API
        import urllib.request, json
        try:
            # Quick VIX fetch via yfinance or free API
            url = "https://query1.finance.yahoo.com/v8/finance/chart/^VIX?interval=1d&range=1d"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                vix = data["chart"]["result"][0]["meta"]["regularMarketPrice"]
                implied_vol = vix / 100  # VIX is annualized, already in percent
        except Exception:
            implied_vol = 0.18  # Last resort fallback

    if hours_to_close <= 0:
        hours_to_close = 0.01
    time_fraction = hours_to_close / (252 * 6.5)
    expected_move_1sd = current_spx * implied_vol * np.sqrt(time_fraction)

    self.last_prediction = {
        "annualized_vol": implied_vol,
        "source": "model" if model_vol is not None else "vix_fallback",
        "hours_to_close": hours_to_close,
        "expected_move_1sd": expected_move_1sd,
        "1sd_range": (current_spx - expected_move_1sd, current_spx + expected_move_1sd),
        "2sd_range": (current_spx - 2 * expected_move_1sd, current_spx + 2 * expected_move_1sd),
        "timestamp": datetime.now().isoformat(),
    }
    self.last_update = datetime.now()
    return self.last_prediction

def _load_model_prediction(self) -> float | None:
    """Load latest vol prediction from Lvl3Quant model output."""
    # TODO: Point to actual model prediction file
    # Expected: a file at Lvl3Quant/predictions/latest_vol_prediction.json
    # Format: {"rvol_30min_annualized": 0.192, "timestamp": "2026-03-02T09:30:00"}
    import json
    from pathlib import Path

    pred_file = Path("C:/Users/Footb/Documents/Github/Lvl3Quant/predictions/latest_vol_prediction.json")
    if pred_file.exists():
        try:
            with open(pred_file) as f:
                data = json.load(f)
            pred_time = datetime.fromisoformat(data["timestamp"])
            if (datetime.now() - pred_time).seconds < 3600:  # Max 1 hour old
                return data["rvol_30min_annualized"]
        except Exception:
            pass
    return None
```

---

## APPENDIX B: SOURCES

- [Kalshi API Documentation](https://docs.kalshi.com/welcome)
- [Kalshi Market Data Portal](https://kalshi.com/market-data)
- [Kalshi Subpenny Pricing Docs](https://docs.kalshi.com/getting_started/subpenny_pricing)
- [Polymarket py-clob-client GitHub](https://github.com/Polymarket/py-clob-client)
- [Polymarket Historical Timeseries](https://docs.polymarket.com/developers/CLOB/timeseries)
- [Polymarket Maker Rebates Program](https://docs.polymarket.com/developers/market-makers/maker-rebates-program)
- [IMDEA Arbitrage Paper (arxiv:2508.03474)](https://arxiv.org/abs/2508.03474)
- [IMDEA Paper PDF](https://suarez-tangil.networks.imdea.org/papers/2025aft-arbitrage.pdf)
- [UCD Kalshi Paper — Favorite-Longshot Bias](https://www.karlwhelan.com/Papers/Kalshi.pdf)
- [NBER Working Paper 34702 — Kalshi and the Rise of Macro Markets](https://www.nber.org/papers/w34702)
- [Federal Reserve FEDS Notes on Kalshi](https://www.federalreserve.gov/econres/feds/kalshi-and-the-rise-of-macro-markets.htm)
- [Axios — Kalshi Fed Prediction Markets Vote of Confidence](https://www.axios.com/2026/02/19/kalshi-fed-prediction-markets)
- [Fortune — Kalshi Perfect Forecast Record](https://fortune.com/2026/01/28/kalshi-prediction-market-federal-reserve-betting-forecast-nber-working-paper/)
- [Kalshi Liquidity Incentive Program](https://help.kalshi.com/incentive-programs/liquidity-incentive-program)
- [Quantgalore Kalshi Trading System](https://github.com/quantgalore/kalshi-trading)
- [prediction-market-backtesting Framework](https://github.com/evan-kolberg/prediction-market-backtesting)
- [Polymarket 500ms Delay Removal (Binance News)](https://www.binance.com/en/square/post/02-20-2026-polymarket-removes-delay-on-taker-orders-increasing-competition-293725751904818)
- [Polymarket Market Making Bot (GitHub)](https://github.com/lorine93s/polymarket-market-maker-bot)
- [NautilusTrader Polymarket Integration](https://nautilustrader.io/docs/latest/integrations/polymarket/)
- [Polymarket Fee Curve Analysis (QuantJourney)](https://quantjourney.substack.com/p/understanding-the-polymarket-fee)
- [FOMC March 2026 Kalshi vs CME Divergence](https://markets.financialcontent.com/stocks/article/predictstreet-2026-2-5-the-fomc-disconnect-kalshi-traders-signal-march-rate-cut-as-macro-prediction-markets-explode)
- [Polymarket March FOMC Hold Signal](https://markets.financialcontent.com/stocks/article/predictstreet-2026-2-7-higher-for-longer-polymarket-traders-signal-resignation-to-fed-pause-in-march)
- [pmxt Polymarket Archive](https://archive.pmxt.dev/Polymarket)
- [QuantPedia Systematic Edges in Prediction Markets](https://quantpedia.com/systematic-edges-in-prediction-markets/)
- [AgentBets API Reference 2026](https://agentbets.ai/guides/prediction-market-api-reference/)
- [Deep Learning SPX Option Pricing (arxiv:2509.05911)](https://arxiv.org/abs/2509.05911)

---

*Research compiled: 2026-03-02 (overnight session). Author: Claude autonomous agent.*
*This document supersedes the foundation research doc (prediction_markets_research.md) where they conflict.*
