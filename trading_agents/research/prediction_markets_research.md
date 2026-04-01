# Prediction Markets Research: Kalshi & Polymarket

**Date:** 2026-03-01
**Purpose:** Foundation document for building a prediction markets trading system
**Status:** RESEARCH COMPLETE - Ready for implementation planning

---

## Table of Contents

1. [Kalshi Deep Dive](#1-kalshi-deep-dive)
2. [Polymarket Deep Dive](#2-polymarket-deep-dive)
3. [Strategy Analysis & Systematic Edges](#3-strategy-analysis--systematic-edges)
4. [Vol-Based Markets (SPX Range Contracts)](#4-vol-based-markets-spx-range-contracts)
5. [Platform Comparison](#5-platform-comparison)
6. [Actionable Next Steps](#6-actionable-next-steps)

---

## 1. KALSHI DEEP DIVE

### 1.1 Overview

Kalshi is the first CFTC-regulated prediction market exchange in the US. It operates as a Designated Contract Market (DCM) under full federal oversight. In 2025, Kalshi processed approximately $40-50 billion in annualized trading volume, with $263.5 million in fee revenue. 89% of revenue came from sports contracts.

- **Website:** https://kalshi.com
- **API Docs:** https://docs.kalshi.com
- **OpenAPI Spec:** https://docs.kalshi.com/openapi.yaml

### 1.2 API Documentation

#### Connection Methods

| Method | URL | Use Case |
|--------|-----|----------|
| REST API | `https://trading-api.kalshi.com/trade-api/v2/` | Standard trading, data retrieval |
| Demo REST | `https://demo-api.kalshi.co/trade-api/v2/` | Testing/development |
| WebSocket | `wss://trading-api.kalshi.com/trade-api/v1/ws` | Real-time data, orderbook |
| FIX 4.4 | (Institutional access) | Lowest latency, HFT |

#### Key REST Endpoints

```
# Market Data
GET /markets                        # List all markets (paginated)
GET /markets/{ticker}               # Get specific market
GET /events/{event_ticker}          # Get event with all sub-markets
GET /series/{series_ticker}         # Get series info
GET /historical/cutoff              # Historical data boundary

# Trading
POST /portfolio/orders              # Place order
DELETE /portfolio/orders/{order_id} # Cancel order
PATCH /portfolio/orders/{order_id}  # Amend order
POST /portfolio/orders/batched      # Batch create orders
DELETE /portfolio/orders/batched    # Batch cancel orders

# Portfolio
GET /portfolio/balance              # Account balance
GET /portfolio/positions            # Open positions
GET /portfolio/orders               # Open orders
GET /portfolio/fills                # Trade history
```

#### Authentication (RSA-PSS Signing)

Every request requires three headers:
- `KALSHI-ACCESS-KEY` - Your API Key ID
- `KALSHI-ACCESS-TIMESTAMP` - Request timestamp in milliseconds
- `KALSHI-ACCESS-SIGNATURE` - RSA-PSS signature of `timestamp + method + path`

**Important:** Sign only the path without query parameters. API keys are generated from Profile Settings and use RSA private key format. The private key cannot be retrieved after creation -- store it securely.

#### WebSocket Channels

| Channel | Auth Required | Data |
|---------|--------------|------|
| `ticker` | No | Real-time price updates |
| `trade` | No | Trade executions |
| `market_lifecycle_v2` | No | Market state changes |
| `multivariate` | No | Multi-market data |
| `orderbook_delta` | Yes | Orderbook snapshots + incremental updates |
| `fill` | Yes | Your trade fills |
| `market_positions` | Yes | Position updates |
| `communications` | Yes | Platform messages |
| `order_group_updates` | Yes | Order status changes |

**Subscription message format:**
```json
{
  "id": 1,
  "cmd": "subscribe",
  "params": {
    "channels": ["orderbook_delta", "ticker"],
    "market_tickers": ["INXD-26MAR03-B5800-5825"]
  }
}
```

The `orderbook_delta` channel sends: `orderbook_snapshot` (full state) then `orderbook_delta` (incremental updates). The `client_order_id` field appears in delta messages when YOU caused the change.

#### Rate Limits

| Tier | Read Limit | Write Limit | Qualification |
|------|-----------|-------------|---------------|
| **Basic** | 20/sec | 10/sec | Automatic on signup |
| **Advanced** | 30/sec | 30/sec | Apply via typeform |
| **Premier** | 100/sec | 100/sec | 3.75% of monthly exchange volume |
| **Prime** | 400/sec | 400/sec | 7.5% of monthly exchange volume |

**Write limit scope:** Only applies to BatchCreateOrders, BatchCancelOrders, CreateOrder, CancelOrder, AmendOrder, DecreaseOrder. Each batch item = 1 transaction, except BatchCancelOrders where each cancel = 0.2 transactions.

**Exceeding limits:** Returns HTTP 429. Implement exponential backoff.

**Practical note:** REST latency is 50-200ms. For anything approaching HFT, use WebSocket or FIX. Rate limits make true HFT impractical on Basic/Advanced tiers.

#### Pagination

Cursor-based pagination for list endpoints. Default page size: 100. Each response contains a `cursor` field for the next page.

#### Subpenny Pricing (New)

Kalshi is transitioning to fixed-point dollar format. Legacy cent-based fields (`yes_bid`, `no_ask`) are being replaced by `_dollars` equivalents (`yes_bid_dollars`, `no_ask_dollars`) with minimum 4 decimal precision. Legacy fields deprecated March 5, 2026.

Subpenny pricing is offered on a per-market basis for more accurate pricing at extreme probabilities (near 0% or 100%).

### 1.3 Fee Structure

#### Taker Fees (Standard Markets)

Formula: `fee = round_up(0.07 * C * P * (1 - P))`

Where:
- `C` = number of contracts
- `P` = contract price (0 to 1)

Maximum fee per contract: **1.75 cents** (at P = 0.50)

#### Taker Fees (S&P 500 and Nasdaq-100 Markets)

Formula: `fee = round_up(0.035 * C * P * (1 - P))`

**50% discount** on financial index markets. Maximum fee: **0.875 cents** per contract at P = 0.50.

#### Maker Fees

Formula: `fee = round_up(0.0175 * C * P * (1 - P))`

Lower coefficient than taker fees. Only charged when resting orders execute; cancellations are free.

#### Fee Examples (S&P 500 Markets, Halved Rate)

| Price (P) | Taker Fee | Maker Fee | Notes |
|-----------|-----------|-----------|-------|
| $0.05 | 0.17c | 0.09c | Far OTM -- cheap |
| $0.10 | 0.32c | 0.16c | |
| $0.25 | 0.66c | 0.33c | |
| $0.50 | 0.88c | 0.44c | Maximum fee point |
| $0.75 | 0.66c | 0.33c | |
| $0.90 | 0.32c | 0.16c | |
| $0.95 | 0.17c | 0.09c | Deep ITM -- cheap |

**Key insight:** Fees are lowest at extremes (near 0 or 1) and highest at 50/50. This favors trading contracts that are NOT near 50 cents.

#### Special Fee Programs

- Sports markets: Standard fee rate (0.07 coefficient)
- S&P 500 & Nasdaq-100: Halved fee rate (0.035 coefficient)
- No deposit/withdrawal fees for ACH or wire (bank may charge)
- Crypto withdrawal: $2,500 daily limit with variable fees

### 1.4 Available Market Categories

#### Financial Markets (Most Relevant for Us)

| Market | Ticker Prefix | Structure |
|--------|--------------|-----------|
| **S&P 500 Daily Range** | `INXD-{YY}{MON}{DD}` | "Will SPX close between X and Y?" |
| **S&P 500 Above/Below** | `KXINXU` | "Will SPX be above X at time T?" |
| **S&P 500 Yearly Range** | `KXINXY` | Year-end close range |
| **Nasdaq-100 Daily Range** | `KXNASDAQ100` | Same structure as SPX |
| **Fed Funds Rate** | Various | Meeting-by-meeting predictions |
| **CPI / Inflation** | Various | Monthly data release outcomes |
| **Unemployment** | Various | Payroll/unemployment data |
| **GDP Growth** | Various | Quarterly GDP outcomes |
| **Recession Probability** | Various | Will there be a recession? |

#### Other Categories

- **Sports** (90% of volume): NFL, NBA, MLB, soccer, etc.
- **Crypto:** BTC/ETH price ranges, 300+ unique markets
- **Politics:** Elections, policy decisions
- **Weather:** Hurricane intensity, temperature records
- **Entertainment:** Awards shows, cultural events

#### Volume Distribution (2025)

- Sports: ~90% of trading volume, 89% of fee revenue
- Financial: Small percentage but growing
- Football alone: 90% of December 2025 volume
- Crypto: Growing segment

### 1.5 Historical Data

Kalshi partitions data into **live** and **historical** tiers:

- `GET /historical/cutoff` returns the boundary timestamps
- Historical data requires separate historical API endpoints
- **Market Data Portal:** https://kalshi.com/market-data (market tickers, open interest, daily volume)

#### Third-Party Data Sources

| Source | What It Provides | URL |
|--------|-----------------|-----|
| PredictionData.io | Unified API, real-time + historical | https://www.predictiondata.io |
| GitHub (mickbransfield/kalshi) | Scripts for downloading market data | https://github.com/mickbransfield/kalshi |
| Apify Kalshi Scraper | Web scraping market data | https://apify.com/mild_costume/kalshi-scraper |
| KalshiData.com | Dashboard + guide | https://www.kalshidata.com |

### 1.6 Account Requirements

| Requirement | Detail |
|-------------|--------|
| Age | 18+ |
| Residency | US residents only |
| KYC | Full name, DOB, SSN, address, government photo ID |
| OFAC | Cannot be on sanctions/SDN list |
| Minimum Deposit | None (recommended $50-100) |
| Deposit Methods | ACH (3-5 days), Wire (1-2 days), USDC (immediate), Debit card ($2,500/day limit) |
| Deposit Limits | ACH: $10K/tx, USDC: $500K, Debit: $2,500/24hr |
| Withdrawal Hold | 3 days (debit), 7 days (same-bank ACH), 30 days (different bank) |
| State Restrictions | Some states challenge legality (MA injunction, NV complaint) |

### 1.7 Market Making Capabilities

**Yes, full market making is supported:**

- Post limit orders on both sides (buy YES and buy NO, or equivalently buy YES and sell YES)
- Batch order creation/cancellation via API
- WebSocket orderbook feed for real-time state
- FIX 4.4 protocol for lowest latency
- Market Maker Agreements available (but excluded from liquidity incentives)
- Subpenny pricing on select markets for tighter quotes

**Liquidity Incentive Program:**
- Open to all members EXCEPT those with Market Maker Agreements
- Rewards proportional to qualifying liquidity provided
- ~$35K/day distributed to liquidity providers (~$12.7M annualized)

**Volume Incentive Program (Sep 2025 - Sep 2026):**
- Volume rewards capped at $0.005/contract traded per participant

### 1.8 Python SDK

**Official SDK:** `kalshi-python` on PyPI

```bash
pip install kalshi-python
```

**Basic Usage:**
```python
from kalshi_python import Configuration, KalshiClient

config = Configuration(
    host="https://api.elections.kalshi.com/trade-api/v2"
)
config.api_key_id = "your-api-key-id"
config.private_key_pem = open("private_key.pem").read()

client = KalshiClient(config)
balance = client.get_balance()
```

**Also available:**
- `kalshi-python-async` (v3.4.0, Jan 2026) - async version
- `kalshi-python-unofficial` - lightweight alternative
- OpenAPI spec for auto-generating clients in any language

### 1.9 Current Liquidity Levels

- **Monthly volume (late 2025):** ~$4.5 billion (mostly sports)
- **SPX daily contracts:** Some windows exceed $355K daily volume; others around $200K
- **Typical bid-ask spread on popular index series:** 1-2 cents (narrow)
- **Less liquid markets:** 5-10 cent spreads
- **Top decile markets (avg final volume):** $526,245
- **Liquidity warning:** Thin in many daily financial markets; whale trades can move prices significantly
- **High-vol environments:** Spreads widen, making entry/exit expensive

---

## 2. POLYMARKET DEEP DIVE

### 2.1 Overview

Polymarket is a decentralized prediction market built on Polygon (MATIC). It received CFTC approval in November 2025 to operate in the US as an intermediated contract market. Weekly volume exceeds $100M as of early 2026.

- **Website:** https://polymarket.com
- **API Docs:** https://docs.polymarket.com
- **GitHub:** https://github.com/polymarket

### 2.2 API Documentation

#### API Architecture

Polymarket has three main API layers:

| API | Purpose | Auth Required |
|-----|---------|---------------|
| **Gamma API** | Market data, metadata | No |
| **CLOB API** | Trading, orderbook | Yes (L1/L2) |
| **Data API** | Historical data, analytics | No |

#### CLOB API Endpoints

```
# Market Data (Public)
GET /markets                        # List markets
GET /midpoint?token_id={id}         # Get midpoint price
GET /price?token_id={id}&side=buy   # Get price for side
GET /book?token_id={id}             # Get order book
GET /books                          # Get multiple order books

# Trading (Authenticated)
POST /order                         # Place order
DELETE /order/{order_id}            # Cancel order
DELETE /cancel-all                  # Cancel all orders
GET /orders                         # Get open orders
GET /trades                         # Get trade history

# Authentication
GET /auth/derive-api-key            # Generate API credentials
```

**Base URL:** `https://clob.polymarket.com`

#### Authentication (Two-Level)

**L1 (Private Key):** Direct Ethereum/Polygon wallet signing. Used to derive L2 credentials.

**L2 (API Key):** Generated from L1 auth. Consists of:
- `apiKey`
- `secret`
- `passphrase`

Requests are signed using HMAC-SHA256. Authentication NOT required for public market data endpoints.

**Deriving API credentials:**
```
GET {clob-endpoint}/auth/derive-api-key
Headers: Address, Nonce (signed by wallet)
Response: { apiKey, secret, passphrase }
```

#### WebSocket

Real-time data available via WebSocket connections for orderbook updates, trades, and market lifecycle events.

#### Rate Limits

- Non-trading queries: Up to 1,000 calls/hour
- Trading endpoints: Stricter limits (not publicly documented in detail)
- Basic access is free

### 2.3 Fee Structure

#### Global (On-Chain) Exchange

| Fee Type | Amount |
|----------|--------|
| Trading fees | **FREE on most standard/long-term markets** |
| Deposit | Free |
| Withdrawal | Free |
| Taker fee (select markets) | 10 basis points (0.10%) on total contract premium |
| Maker fee | **FREE (0%)** |

**Markets with taker fees (collected and redistributed to market makers as rebates):**
- 15-minute crypto markets
- 5-minute crypto markets
- NCAAB markets (since Feb 18, 2026)
- Serie A markets (since Feb 18, 2026)

#### US Exchange (Polymarket US / QCX)

| Fee Type | Amount |
|----------|--------|
| Taker fee | **0.01% on contracts** |
| Maker fee | TBD |

The US exchange operates under QCX's CFTC approvals with regulated intermediaries.

**Key advantage:** Polymarket's fees are dramatically lower than Kalshi for most markets. 0% maker fees make market making very attractive.

### 2.4 Available Markets

| Category | Examples | Liquidity Level |
|----------|----------|----------------|
| **US Politics** | Elections, policy, legislation | Highest ($28.17M avg volume) |
| **Geopolitics** | International events, conflicts | Fast-growing segment |
| **Sports** | NFL, NBA, soccer | $1.32M avg volume |
| **Crypto** | BTC/ETH price predictions | $44K avg volume |
| **Economics** | Fed rates, CPI, macro events | Moderate |
| **Entertainment** | Awards, cultural events | Low |

**Liquidity concentration:** 505 contracts with >$10M volume account for 47% of all trading volume. The vast majority of contracts have minimal volume.

### 2.5 Historical Data

| Source | Description | URL |
|--------|-------------|-----|
| **Official CLOB API** | `GET /prices-history` endpoint for price timeseries | https://docs.polymarket.com/developers/CLOB/timeseries |
| **Polymarket Data** | Full historical dataset, orderbook snapshots, 1-min resolution | https://www.polymarketdata.co |
| **pmxt Data Archive** | Hourly orderbook snapshots in parquet format | https://archive.pmxt.dev/Polymarket |
| **Kaggle** | Full market data dump | https://www.kaggle.com/datasets/sandeepkumarfromin/full-market-data-from-polymarket |
| **Dune Analytics** | On-chain activity and volume dashboard | https://dune.com/filarm/polymarket-activity |
| **Bitquery** | GraphQL API for trades, settlements, lifecycle | https://docs.bitquery.io/docs/examples/polymarket-api/ |
| **poly_data (GitHub)** | Python data pipeline for fetching/processing | https://github.com/warproxxx/poly_data |

### 2.6 Account Requirements

#### Global (On-Chain) Exchange

| Requirement | Detail |
|-------------|--------|
| Wallet | MetaMask, Coinbase Wallet, or WalletConnect-compatible |
| Currency | USDC on Polygon network |
| Gas fees | Small MATIC balance needed (~$2-5) |
| KYC | Not required for global exchange |
| Deposit method | USDC on Polygon, credit card via MoonPay |

**WARNING:** Sending USDC on the wrong network (e.g., Ethereum mainnet instead of Polygon) = permanent loss of funds.

#### US Exchange (Polymarket US)

| Requirement | Detail |
|-------------|--------|
| KYC | Required (full identity verification) |
| Access | Through regulated intermediaries/brokers only |
| Wallet | No direct crypto wallet access |

### 2.7 Legal Status (US Users)

- **Federal:** CFTC-approved as of November 2025. Fully legal at federal level.
- **State challenges:**
  - **Nevada:** Gaming Control Board filed civil complaint (Jan 2026) -- argues prediction markets need gaming license
  - **Massachusetts:** Preliminary injunction in Commonwealth v. KalshiEX LLC -- similar contracts ruled as illegal sports wagering
- **Access:** US users must use regulated intermediaries; no direct crypto wallet trading
- **Status:** Legal gray zone at state level despite federal approval

### 2.8 Market Making Capabilities

**Full CLOB market making supported:**

- Post limit orders on both sides at specific prices
- `post_only` orders available (rejected if would immediately match)
- Daily USDC rebates from taker fees redistributed to market makers
- Professional market makers report $150-300/day per market with $100K+ daily volume
- `py-clob-client` Python library for programmatic access

**Python Market Making Example:**
```python
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs

client = ClobClient(
    "https://clob.polymarket.com",
    key=PRIVATE_KEY,
    chain_id=137,
    funder=FUNDER_ADDRESS
)

# Place a limit buy order
order_args = OrderArgs(
    token_id="TOKEN_ID",
    price=0.45,       # Buy YES at 45 cents
    size=100,          # 100 contracts
    side="BUY"
)
signed_order = client.create_order(order_args)
resp = client.post_order(signed_order)

# Get orderbook
book = client.get_order_book("TOKEN_ID")
```

### 2.9 Current Liquidity Levels

- **Weekly volume:** $100-125M+ (Feb 2026, three consecutive weeks above $100M)
- **Weekly active addresses:** 10,000+
- **Event-driven spikes:** $478M single-day volume during US-Israeli strikes on Iran
- **US Politics avg volume:** $28.17M
- **Sports avg volume:** $1.32M
- **Crypto avg volume:** $44K
- **Concentration risk:** Most liquidity in a few hundred major markets

---

## 3. STRATEGY ANALYSIS & SYSTEMATIC EDGES

### 3.1 Academic Research on Mispricing

#### Favorite-Longshot Bias (Confirmed on Kalshi)

**Source:** "Makers and Takers: The Economics of the Kalshi Prediction Market" (UCD Working Paper, 2025)

**Finding:** Analysis of 300,000+ Kalshi contracts shows:
- Low-price contracts (longshots) win FAR less than needed to break even
- High-price contracts (favorites) win MORE often and yield small positive returns
- Example: A 5-cent contract that wins only 2% of the time loses 60% of invested capital
- The corresponding 95-cent contract wins 98% of the time with small positive returns

**Actionable edge:** Systematically sell longshot contracts (buy favorites). Over 50-100 trades, the math strongly favors fading longshots.

**URL:** https://www.karlwhelan.com/Papers/Kalshi.pdf

#### Combinatorial Mispricing (Polymarket)

**Source:** "Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets" (IMDEA, 2025)

**Finding:** Over $40 million in arbitrage profits extracted from Polymarket between April 2024 and April 2025:
- 86 million bets analyzed across thousands of markets
- 7,000+ markets with measurable combinatorial mispricings
- Example: If P(Trump wins) = 55% but P(Republican wins) = 50%, that is logically impossible -- arbitrage exists
- Top 3 wallets earned $4.2 million combined
- Top performer: 4,049 transactions, $2.01M profit ($496 avg per trade)

**URL:** https://arxiv.org/abs/2508.03474

### 3.2 Known Edges and Strategies

#### 1. Longshot Fading

- **Mechanism:** Sell contracts priced at 5-15 cents (buy the other side at 85-95 cents)
- **Edge:** Behavioral overvaluation of unlikely outcomes
- **Expected return:** Small but consistent positive returns on favorites
- **Risk:** Occasional large loss when longshot hits
- **Best on:** Kalshi (confirmed in academic data)

#### 2. Inter-Exchange Arbitrage

- **Mechanism:** Buy on cheaper platform, sell on more expensive platform
- **Platforms:** Kalshi vs Polymarket vs Robinhood vs PredictIt
- **Finding:** Polymarket generally leads Kalshi in price discovery due to higher liquidity
- **Challenge:** Opportunities last only seconds; 73% of profits captured by sub-100ms bots
- **Average opportunity duration:** 2.7 seconds (down from 12.3 seconds in 2024)
- **Verdict:** VERY competitive. Need colocation/low-latency infrastructure.

#### 3. Intra-Exchange Arbitrage (Buy-All / Sell-All)

- **Mechanism:** If sum of all contract prices < $1.00, buy all for guaranteed profit (and vice versa)
- **Historical returns:** Up to 55% profit on PredictIt (2016), but declining over time
- **On Polymarket:** Still occurs in logically related markets (combinatorial arbitrage)
- **Verdict:** Diminishing but still present, especially in less-watched markets

#### 4. Calendar/Expiry Effects

- **Mechanism:** Prices converge to true probabilities as expiry approaches
- **Finding:** Markets become more accurate in final hours
- **Strategy:** Fade extreme prices with known timing of resolution
- **Verdict:** Moderate edge, requires good fundamental assessment

#### 5. Market Making (Spread Capture)

- **Mechanism:** Post bids and asks, capture spread on round-trips
- **Polymarket:** 0% maker fees + daily rebates from taker fees
- **Kalshi:** Low maker fees (0.0175 coefficient)
- **Reported returns:** $150-300/day per active market on Polymarket
- **Verdict:** Best risk-adjusted opportunity for systematic trading. Requires inventory management.

#### 6. Vol-Based Edge (Our Unique Advantage)

- **Mechanism:** Use our IC=0.644 volatility model to price SPX range contracts more accurately than the market
- **See Section 4 for full analysis**
- **Verdict:** HIGHEST POTENTIAL EDGE if we can map model output to contract fair values

### 3.3 Typical Bid-Ask Spreads

| Market Type | Platform | Typical Spread |
|-------------|----------|---------------|
| Popular SPX daily | Kalshi | 1-2 cents |
| Less liquid financial | Kalshi | 5-10 cents |
| High-vol periods | Kalshi | Wider (variable) |
| Major political events | Polymarket | 1-3 cents |
| Niche markets | Both | 5-20 cents |

### 3.4 Existing Tools and Bots

| Tool | Type | URL |
|------|------|-----|
| **quantgalore/kalshi-trading** | SPX bracket trading system | https://github.com/quantgalore/kalshi-trading |
| **PredictEngine** | Polymarket trading bot | https://www.predictengine.ai |
| **py-clob-client** | Official Polymarket Python SDK | https://github.com/Polymarket/py-clob-client |
| **kalshi-python** | Official Kalshi Python SDK | https://pypi.org/project/kalshi-python |
| **kalshi-rs** | Rust HFT-grade Kalshi wrapper | https://github.com/rmadev01/kalshi-rs |
| **PolyCatalog** | Directory of Polymarket tools | https://www.polycatalog.io/polymarket-trading-bots |
| **NautilusTrader** | Professional trading framework with Polymarket integration | https://nautilustrader.io/docs/latest/integrations/polymarket/ |
| **poly_data** | Polymarket data pipeline | https://github.com/warproxxx/poly_data |

**Automation landscape (2026):**
- Average arbitrage window: 2.7 seconds (highly competitive)
- 73% of arb profits go to sub-100ms bots
- AI-powered agents growing rapidly (LLM + news analysis)
- Shift from taker arbitrage to systematic market making

---

## 4. VOL-BASED MARKETS (SPX RANGE CONTRACTS)

### 4.1 Our Edge

We have a volatility prediction model with:
- **IC = 0.644** at 30-minute horizon for SPX/ES
- **IC = 0.568** at 1-hour horizon
- **IC = 0.440** at 2-hour horizon
- **IC = 0.406** at 4-hour horizon
- **100% positive folds** in walk-forward validation

This is a MASSIVE informational edge for pricing SPX range/bracket contracts, which are fundamentally vol bets.

### 4.2 Kalshi SPX Contract Types

#### A. S&P 500 Daily Range (INXD)

**Ticker format:** `INXD-{YY}{MON}{DD}` (event), `INXD-{YY}{MON}{DD}-B{FLOOR}-{CAP}` (market)

**Example:** `INXD-26MAR03-B5800-5825`

**Structure:**
- Binary contract: "Will SPX close between [FLOOR] and [CAP]?"
- Strike ranges typically 25 points wide (e.g., 5800-5825)
- Pays $1 if YES, $0 if NO
- Multiple brackets available for each day covering the full expected range
- Trading hours: 9:30 AM - 4:00 PM ET only
- Resolution: Based on official SPX close price

**How to read the chain:**
```python
# Get all brackets for a trading day
event = kalshi_api.get_event("INXD-26MAR03")
for market in event.markets:
    info = kalshi_api.get_market(market.ticker)
    # subtitle: "5800 to 5825"
    # yes_bid / yes_ask / no_bid / no_ask
```

**Special cases:**
- "5900 or above" -- highest bracket (unbounded above)
- "5700 or below" -- lowest bracket (unbounded below)

#### B. S&P 500 Above/Below (KXINXU)

**Structure:**
- "Will SPX be above X at time T?"
- Multiple intraday resolution times (10am, 12pm, 2pm, 4pm ET)
- Hourly contracts available ("Hourlies")
- Pure binary: above threshold = YES pays $1

**This is closer to a simple directional bet than a vol bet, but can be used for vol strategies by trading multiple strikes.**

#### C. S&P 500 Yearly Range (KXINXY)

**Structure:** Year-end close predictions with wide ranges
- Less liquid, longer duration
- Not ideal for our 30-min vol model

#### D. Nasdaq-100 Range (KXNASDAQ100)

**Structure:** Same as SPX but for NDX
- Daily, weekly, monthly, yearly variants
- Same halved fee structure as SPX (0.035 coefficient)

### 4.3 Mapping Vol Prediction to Contract Fair Values

This is the critical translation layer. Here is how to convert our vol prediction model output into actionable Kalshi contract prices:

#### Step 1: Vol Prediction to Expected Range

Our model predicts realized volatility (rvol) at the 30-minute horizon. Convert to expected price range:

```python
import numpy as np

def vol_to_range(current_spx, predicted_vol_30min, hours_to_close):
    """
    Convert 30-min vol prediction to expected SPX range at close.

    predicted_vol_30min: annualized vol prediction from our model
    hours_to_close: hours remaining until 4pm ET
    """
    # Scale to the remaining time horizon
    time_fraction = hours_to_close / (252 * 6.5)  # 252 trading days, 6.5 hrs each
    expected_move_1sd = current_spx * predicted_vol_30min * np.sqrt(time_fraction)

    return {
        '1sd_range': (current_spx - expected_move_1sd, current_spx + expected_move_1sd),
        '2sd_range': (current_spx - 2*expected_move_1sd, current_spx + 2*expected_move_1sd),
        'expected_move': expected_move_1sd
    }
```

#### Step 2: Range to Bracket Probabilities

For each Kalshi bracket [FLOOR, CAP], calculate the probability SPX closes within that range assuming a normal distribution (or better, use the vol-implied distribution):

```python
from scipy import stats

def bracket_fair_value(floor, cap, current_spx, predicted_vol, hours_to_close):
    """
    Calculate fair value of a bracket contract.
    Returns probability SPX closes between floor and cap.
    """
    time_fraction = hours_to_close / (252 * 6.5)
    sigma = current_spx * predicted_vol * np.sqrt(time_fraction)

    if sigma == 0:
        return 1.0 if floor <= current_spx <= cap else 0.0

    z_floor = (floor - current_spx) / sigma
    z_cap = (cap - current_spx) / sigma

    prob = stats.norm.cdf(z_cap) - stats.norm.cdf(z_floor)
    return prob
```

#### Step 3: Identify Mispriced Contracts

Compare our fair values to market prices:

```python
def find_edge(option_chain, current_spx, predicted_vol, hours_to_close):
    """
    Find contracts where our fair value differs from market price.
    """
    edges = []
    for _, contract in option_chain.iterrows():
        fair_value = bracket_fair_value(
            contract['floor'], contract['cap'],
            current_spx, predicted_vol, hours_to_close
        )

        # Edge on buying YES
        if fair_value > contract['yes_ask']:
            edges.append({
                'ticker': contract['ticker'],
                'action': 'BUY_YES',
                'fair_value': fair_value,
                'market_price': contract['yes_ask'],
                'edge': fair_value - contract['yes_ask']
            })

        # Edge on buying NO (selling YES)
        if (1 - fair_value) > contract['no_ask']:
            edges.append({
                'ticker': contract['ticker'],
                'action': 'BUY_NO',
                'fair_value': 1 - fair_value,
                'market_price': contract['no_ask'],
                'edge': (1 - fair_value) - contract['no_ask']
            })

    return sorted(edges, key=lambda x: x['edge'], reverse=True)
```

#### Step 4: Vol-Specific Strategies

**Strategy A: "Vol is Higher Than Market Implies"**
- When our model says vol will be higher than market-implied vol:
- Buy the tail brackets (far from current price) -- they are underpriced
- Sell the at-the-money bracket -- it is overpriced
- This is equivalent to buying a straddle in options

**Strategy B: "Vol is Lower Than Market Implies"**
- When our model says vol will be lower than market-implied vol:
- Sell the tail brackets (they are overpriced)
- Buy the at-the-money bracket (it is underpriced)
- This is equivalent to selling a straddle

**Strategy C: Continuous Market Making with Vol Edge**
- Quote both sides of multiple brackets
- Bias quotes based on our vol forecast
- Wider quotes on brackets where we have less confidence
- Tighter quotes where we have high confidence

### 4.4 Historical Pricing Data for SPX Contracts

**Available via:**
1. Kalshi API: `get_market_history(ticker, min_ts, max_ts)` -- returns timestamp-price records
2. The quantgalore/kalshi-trading repo uses historical snapshots at 14:00 ET for backtesting
3. PredictionData.io for longer historical datasets
4. Kalshi Market Data portal: https://kalshi.com/market-data

### 4.5 Liquidity Assessment for SPX Markets

- **Daily volume:** $200K-355K on active days for SPX daily contracts
- **Bid-ask spread:** 1-2 cents on popular strikes
- **Depth:** Thin -- large orders will move the market
- **Best liquidity:** Near-the-money brackets during market hours
- **Worst liquidity:** Far OTM brackets, pre-market
- **Halved fees:** 0.035 coefficient (biggest cost advantage)

**Practical position sizing:** With $200K daily volume and thin books, we should limit orders to $500-2,000 per bracket to avoid adverse selection and market impact.

### 4.6 Key Challenges

1. **Liquidity constraints:** $200-355K daily volume limits scalability
2. **Model frequency mismatch:** Our model runs at 30-min intervals; contracts expire daily
3. **Normal distribution assumption:** Fat tails mean bracket probabilities need adjustment
4. **Fee drag:** Even halved, fees eat into edge on small positions
5. **Competition:** Other quantitative traders likely using similar approaches
6. **Inventory risk:** Market making requires holding positions that could go against us

---

## 5. PLATFORM COMPARISON

### Head-to-Head: Kalshi vs Polymarket

| Feature | Kalshi | Polymarket |
|---------|--------|------------|
| **Regulation** | CFTC DCM (fully regulated) | CFTC approved (Nov 2025) |
| **Deposit currency** | USD (ACH, wire, USDC) | USDC on Polygon |
| **Taker fee** | 0.07 * P * (1-P) (standard) | FREE (most markets) or 0.10% |
| **Maker fee** | 0.0175 * P * (1-P) | FREE (0%) |
| **SPX markets** | YES (daily brackets, above/below, hourly) | Limited |
| **Financial markets depth** | Deep (Fed, CPI, GDP, SPX, NDX) | Shallow (mostly politics/crypto) |
| **API maturity** | Excellent (REST + WS + FIX) | Good (REST + WS) |
| **Python SDK** | Official (kalshi-python) | Official (py-clob-client) |
| **Historical data** | Good (API + third-party) | Excellent (on-chain + third-party) |
| **Latency** | 50-200ms REST, lower on WS/FIX | Variable (blockchain settlement) |
| **US access** | Full (US residents only) | Via regulated intermediaries |
| **Volume (total)** | $40-50B annualized | $100-125M weekly |
| **Market making** | Full support + incentives | Full support + rebates |
| **State restrictions** | MA, potentially others | NV complaint, MA challenge |

### Recommendation for Our Vol Strategy

**PRIMARY: Kalshi** -- Has SPX daily bracket contracts directly tradeable via API with halved fees. This is where our vol model maps directly to contracts.

**SECONDARY: Polymarket** -- For combinatorial arbitrage, political/crypto market making. Lower fees but fewer financial markets.

---

## 6. ACTIONABLE NEXT STEPS

### Phase 1: Account Setup & API Access (Day 1-2)

1. [ ] Create Kalshi account with KYC verification
2. [ ] Generate API key (RSA private key) and store securely
3. [ ] Fund account via USDC (immediate) or ACH ($10K)
4. [ ] Apply for Advanced tier API access (30/sec rate limit)
5. [ ] Set up demo environment for testing: `https://demo-api.kalshi.co/trade-api/v2/`

### Phase 2: Data Collection & Backtesting (Day 3-7)

1. [ ] Install `kalshi-python` SDK
2. [ ] Build data collector for SPX daily bracket contracts
   - Pull all INXD events for past 6-12 months
   - Store contract prices, volumes, bid-ask spreads
   - Track resolution outcomes
3. [ ] Map our vol model predictions to bracket fair values
4. [ ] Run historical backtest:
   - For each trading day, get our vol prediction at various times
   - Calculate fair values for all brackets
   - Compare to actual market prices
   - Simulate trading with realistic fees and spreads
5. [ ] Key metrics to evaluate: Sharpe ratio, max drawdown, win rate, average edge per trade

### Phase 3: Paper Trading (Day 8-14)

1. [ ] Deploy real-time system on demo API
2. [ ] Connect vol model output to fair value calculator
3. [ ] Implement order placement logic with risk limits
4. [ ] Monitor for 1 week, track P&L vs. expected
5. [ ] Validate that live edge matches backtest

### Phase 4: Live Trading (Day 15+)

1. [ ] Start with small position sizes ($100-500 per trade)
2. [ ] Monitor execution quality (fills, slippage)
3. [ ] Scale gradually as edge is confirmed
4. [ ] Add market making component (quote both sides)
5. [ ] Explore Polymarket for additional edge opportunities

### Phase 5: Advanced Strategies (Month 2+)

1. [ ] Cross-platform arbitrage (Kalshi vs Polymarket vs Robinhood predictions)
2. [ ] Favorite-longshot bias exploitation
3. [ ] Automated market making across multiple bracket strikes
4. [ ] Hourly SPX contracts (KXINXU) for intraday vol trades
5. [ ] Expand to Nasdaq-100 contracts
6. [ ] LLM-powered event analysis for non-financial markets

### Capital Requirements

| Phase | Capital Needed | Reasoning |
|-------|---------------|-----------|
| Backtesting | $0 | Historical data via API |
| Paper trading | $0 | Demo API |
| Initial live | $5,000-10,000 | Small positions across 5-10 brackets |
| Scaled trading | $25,000-50,000 | Market making requires inventory |
| Full deployment | $100,000+ | Multi-strategy, multi-platform |

### Key Risk Factors

1. **Liquidity risk:** Cannot exit large positions quickly in thin markets
2. **Model risk:** Vol model was trained on ES futures; Kalshi contracts may have different dynamics
3. **Regulatory risk:** State-level challenges to prediction market legality
4. **Competition risk:** Other sophisticated traders competing for same edge
5. **Platform risk:** Kalshi is a single exchange; counterparty to all trades
6. **Timing risk:** Our 30-min model updates may be too slow for fast-moving markets

---

## APPENDIX: KEY URLS

| Resource | URL |
|----------|-----|
| Kalshi Homepage | https://kalshi.com |
| Kalshi API Docs | https://docs.kalshi.com |
| Kalshi OpenAPI Spec | https://docs.kalshi.com/openapi.yaml |
| Kalshi Fee Schedule | https://kalshi.com/fee-schedule |
| Kalshi Market Data | https://kalshi.com/market-data |
| Kalshi SPX Range | https://kalshi.com/markets/kxinx/sp-500-range |
| Kalshi SPX Above/Below | https://kalshi.com/markets/kxinxu/sp-500-abovebelow |
| Kalshi Financials Category | https://kalshi.com/category/financials |
| Kalshi Python SDK | https://pypi.org/project/kalshi-python |
| Kalshi Async SDK | https://pypi.org/project/kalshi-python-async |
| Kalshi Rate Limits | https://docs.kalshi.com/getting_started/rate_limits |
| Kalshi API Keys | https://docs.kalshi.com/getting_started/api_keys |
| Kalshi WebSocket Quickstart | https://docs.kalshi.com/getting_started/quick_start_websockets |
| Kalshi Subpenny Pricing | https://docs.kalshi.com/getting_started/subpenny_pricing |
| Kalshi Liquidity Program | https://help.kalshi.com/incentive-programs/liquidity-incentive-program |
| Polymarket Homepage | https://polymarket.com |
| Polymarket API Docs | https://docs.polymarket.com |
| Polymarket CLOB Auth | https://docs.polymarket.com/developers/CLOB/authentication |
| Polymarket Market Making | https://docs.polymarket.com/developers/market-makers/trading |
| Polymarket Timeseries API | https://docs.polymarket.com/developers/CLOB/timeseries |
| Polymarket Fees | https://docs.polymarket.com/polymarket-learn/trading/fees |
| Polymarket Python SDK | https://github.com/Polymarket/py-clob-client |
| Polymarket Data (3rd party) | https://www.polymarketdata.co |
| QuantGalore Kalshi Trading | https://github.com/quantgalore/kalshi-trading |
| Kalshi Academic Paper | https://www.karlwhelan.com/Papers/Kalshi.pdf |
| Arbitrage Paper (IMDEA) | https://arxiv.org/abs/2508.03474 |
| QuantPedia Systematic Edges | https://quantpedia.com/systematic-edges-in-prediction-markets/ |
| Fed Reserve Kalshi Paper | https://www.federalreserve.gov/econres/feds/files/2026010pap.pdf |
| PredictionData.io | https://www.predictiondata.io |
| Kalshi HFT Rust Wrapper | https://github.com/rmadev01/kalshi-rs |
| NautilusTrader Polymarket | https://nautilustrader.io/docs/latest/integrations/polymarket/ |

---

*Research compiled 2026-03-01. All information verified from official documentation, academic papers, and recent news sources. Ready for implementation phase.*
