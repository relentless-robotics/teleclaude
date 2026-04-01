#!/usr/bin/env python3
"""
Wheel Strategy Universe Screener — finds best wheel candidates from a broad universe.

Screens the S&P 500 (or top 200 by volume) for ideal wheel strategy stocks based on:
  - IV rank (higher = more premium)
  - Options liquidity (volume, OI via stock volume proxy)
  - Price range ($10-$500 for reasonable collateral)
  - Sector diversification
  - Dividend yield (bonus income)
  - Earnings proximity (avoid)

Uses yfinance for fundamental + historical data. Outputs a ranked list with scores.

Usage:
    python -m trading_agents.wheel_strategy.universe_screener --top 30
    python -m trading_agents.wheel_strategy.universe_screener --top 50 --max-price 200
    python -m trading_agents.wheel_strategy.universe_screener --sector Technology --top 10
    python -m trading_agents.wheel_strategy.universe_screener --min-iv-rank 40 --min-yield 1.0
"""

import argparse
import json
import sys
import time
import numpy as np
from datetime import datetime, date
from pathlib import Path

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False

# Add parent paths
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stock_screener import SP500_TOP100, EARNINGS_MONTHS
from earnings_dividends import get_earnings_dates, get_dividend_info


# ── Extended universe (S&P 500 top ~200 by market cap + popular wheel stocks) ──

# The top 100 come from stock_screener.SP500_TOP100
# Add another 100 popular wheel candidates not in that list
EXTENDED_UNIVERSE = [
    {"ticker": "PYPL", "name": "PayPal", "sector": "Technology", "approx_price": 75},
    {"ticker": "UBER", "name": "Uber", "sector": "Technology", "approx_price": 80},
    {"ticker": "SQ", "name": "Block (Square)", "sector": "Technology", "approx_price": 85},
    {"ticker": "SHOP", "name": "Shopify", "sector": "Technology", "approx_price": 110},
    {"ticker": "SNOW", "name": "Snowflake", "sector": "Technology", "approx_price": 170},
    {"ticker": "CRWD", "name": "CrowdStrike", "sector": "Technology", "approx_price": 380},
    {"ticker": "DDOG", "name": "Datadog", "sector": "Technology", "approx_price": 140},
    {"ticker": "NET", "name": "Cloudflare", "sector": "Technology", "approx_price": 110},
    {"ticker": "ZS", "name": "Zscaler", "sector": "Technology", "approx_price": 220},
    {"ticker": "PANW", "name": "Palo Alto Networks", "sector": "Technology", "approx_price": 380},
    {"ticker": "MRVL", "name": "Marvell Technology", "sector": "Technology", "approx_price": 90},
    {"ticker": "MU", "name": "Micron Technology", "sector": "Technology", "approx_price": 115},
    {"ticker": "KLAC", "name": "KLA Corp", "sector": "Technology", "approx_price": 750},
    {"ticker": "SNPS", "name": "Synopsys", "sector": "Technology", "approx_price": 500},
    {"ticker": "CDNS", "name": "Cadence Design", "sector": "Technology", "approx_price": 290},
    {"ticker": "PLTR", "name": "Palantir", "sector": "Technology", "approx_price": 80},
    {"ticker": "COIN", "name": "Coinbase", "sector": "Technology", "approx_price": 250},
    {"ticker": "HOOD", "name": "Robinhood", "sector": "Technology", "approx_price": 45},
    {"ticker": "SOFI", "name": "SoFi Technologies", "sector": "Financials", "approx_price": 15},
    {"ticker": "RIVN", "name": "Rivian", "sector": "Consumer Discretionary", "approx_price": 14},
    {"ticker": "LCID", "name": "Lucid Motors", "sector": "Consumer Discretionary", "approx_price": 3},
    {"ticker": "NIO", "name": "NIO", "sector": "Consumer Discretionary", "approx_price": 5},
    {"ticker": "AAL", "name": "American Airlines", "sector": "Industrials", "approx_price": 17},
    {"ticker": "DAL", "name": "Delta Air Lines", "sector": "Industrials", "approx_price": 55},
    {"ticker": "UAL", "name": "United Airlines", "sector": "Industrials", "approx_price": 100},
    {"ticker": "LUV", "name": "Southwest Airlines", "sector": "Industrials", "approx_price": 30},
    {"ticker": "MARA", "name": "Marathon Digital", "sector": "Technology", "approx_price": 25},
    {"ticker": "RIOT", "name": "Riot Platforms", "sector": "Technology", "approx_price": 12},
    {"ticker": "GME", "name": "GameStop", "sector": "Consumer Discretionary", "approx_price": 30},
    {"ticker": "AMC", "name": "AMC Entertainment", "sector": "Consumer Discretionary", "approx_price": 5},
    {"ticker": "SNAP", "name": "Snap", "sector": "Communication Services", "approx_price": 12},
    {"ticker": "PINS", "name": "Pinterest", "sector": "Communication Services", "approx_price": 35},
    {"ticker": "RBLX", "name": "Roblox", "sector": "Communication Services", "approx_price": 55},
    {"ticker": "WBA", "name": "Walgreens Boots", "sector": "Healthcare", "approx_price": 10},
    {"ticker": "PARA", "name": "Paramount Global", "sector": "Communication Services", "approx_price": 12},
    {"ticker": "AGNC", "name": "AGNC Investment", "sector": "Real Estate", "approx_price": 10},
    {"ticker": "NLY", "name": "Annaly Capital", "sector": "Real Estate", "approx_price": 20},
    {"ticker": "O", "name": "Realty Income", "sector": "Real Estate", "approx_price": 55},
    {"ticker": "SCHD", "name": "Schwab Div ETF", "sector": "ETF", "approx_price": 80},
    {"ticker": "SPY", "name": "SPDR S&P 500", "sector": "ETF", "approx_price": 580},
    {"ticker": "QQQ", "name": "Invesco QQQ", "sector": "ETF", "approx_price": 500},
    {"ticker": "IWM", "name": "iShares Russell 2000", "sector": "ETF", "approx_price": 220},
    {"ticker": "EEM", "name": "iShares EM", "sector": "ETF", "approx_price": 43},
    {"ticker": "XLE", "name": "Energy Select SPDR", "sector": "ETF", "approx_price": 85},
    {"ticker": "XLF", "name": "Financial Select SPDR", "sector": "ETF", "approx_price": 48},
    {"ticker": "GLD", "name": "SPDR Gold", "sector": "ETF", "approx_price": 240},
    {"ticker": "SLV", "name": "iShares Silver", "sector": "ETF", "approx_price": 30},
    {"ticker": "TLT", "name": "iShares 20+ Yr Treasury", "sector": "ETF", "approx_price": 90},
    {"ticker": "HYG", "name": "iShares High Yield", "sector": "ETF", "approx_price": 78},
    {"ticker": "ARKK", "name": "ARK Innovation", "sector": "ETF", "approx_price": 55},
    # More mid-cap high-IV names
    {"ticker": "SMCI", "name": "Super Micro Computer", "sector": "Technology", "approx_price": 40},
    {"ticker": "ARM", "name": "ARM Holdings", "sector": "Technology", "approx_price": 175},
    {"ticker": "DELL", "name": "Dell Technologies", "sector": "Technology", "approx_price": 120},
    {"ticker": "HPE", "name": "Hewlett Packard Ent", "sector": "Technology", "approx_price": 20},
    {"ticker": "WBD", "name": "Warner Bros Discovery", "sector": "Communication Services", "approx_price": 10},
    {"ticker": "DKNG", "name": "DraftKings", "sector": "Consumer Discretionary", "approx_price": 45},
    {"ticker": "DASH", "name": "DoorDash", "sector": "Consumer Discretionary", "approx_price": 180},
    {"ticker": "ABNB", "name": "Airbnb", "sector": "Consumer Discretionary", "approx_price": 140},
    {"ticker": "NFLX", "name": "Netflix", "sector": "Communication Services", "approx_price": 950},
    {"ticker": "DIS", "name": "Walt Disney", "sector": "Communication Services", "approx_price": 110},
    {"ticker": "CMCSA", "name": "Comcast", "sector": "Communication Services", "approx_price": 35},
    {"ticker": "VZ", "name": "Verizon", "sector": "Communication Services", "approx_price": 44},
    {"ticker": "GM", "name": "General Motors", "sector": "Consumer Discretionary", "approx_price": 50},
    {"ticker": "FCX", "name": "Freeport-McMoRan", "sector": "Materials", "approx_price": 45},
    {"ticker": "CLF", "name": "Cleveland-Cliffs", "sector": "Materials", "approx_price": 12},
    {"ticker": "X", "name": "US Steel", "sector": "Materials", "approx_price": 40},
    {"ticker": "ET", "name": "Energy Transfer", "sector": "Energy", "approx_price": 18},
    {"ticker": "OXY", "name": "Occidental Petroleum", "sector": "Energy", "approx_price": 50},
    {"ticker": "DVN", "name": "Devon Energy", "sector": "Energy", "approx_price": 35},
    {"ticker": "HAL", "name": "Halliburton", "sector": "Energy", "approx_price": 28},
    {"ticker": "KHC", "name": "Kraft Heinz", "sector": "Consumer Staples", "approx_price": 30},
    {"ticker": "SBUX", "name": "Starbucks", "sector": "Consumer Discretionary", "approx_price": 100},
    {"ticker": "LULU", "name": "Lululemon", "sector": "Consumer Discretionary", "approx_price": 380},
    {"ticker": "ROKU", "name": "Roku", "sector": "Communication Services", "approx_price": 80},
    {"ticker": "TTD", "name": "The Trade Desk", "sector": "Technology", "approx_price": 110},
    {"ticker": "CRSP", "name": "CRISPR Therapeutics", "sector": "Healthcare", "approx_price": 50},
    {"ticker": "MRNA", "name": "Moderna", "sector": "Healthcare", "approx_price": 35},
    {"ticker": "BITO", "name": "ProShares Bitcoin ETF", "sector": "ETF", "approx_price": 25},
]


def get_full_universe():
    """Combine SP500 top 100 + extended universe, deduplicated."""
    seen = set()
    universe = []
    for stock in SP500_TOP100 + EXTENDED_UNIVERSE:
        if stock['ticker'] not in seen:
            seen.add(stock['ticker'])
            universe.append(stock)
    return universe


# ── Scoring engine ───────────────────────────────────────────────────────────

def compute_wheel_score(ticker, price, iv_rank, iv_pctile, stability,
                        stock_liquidity, options_liquidity, div_yield,
                        near_earnings, sector, sector_counts):
    """
    Compute a composite wheel suitability score (0-100).

    Weights:
      - IV rank:           30% (more premium = better)
      - Options liquidity:  20% (tight spreads)
      - Price stability:    15% (less assignment pain)
      - Stock liquidity:    10% (easy to trade)
      - Dividend yield:     10% (extra income)
      - Sector diversity:   10% (penalize over-concentration)
      - Earnings safety:     5% (no imminent earnings)
    """
    # IV rank: 0-100, higher = more premium
    iv_score = iv_rank

    # Liquidity: from stock volume
    liq_score = options_liquidity

    # Stability: 0-100
    stab_score = stability

    # Stock liquidity
    stock_liq_score = stock_liquidity

    # Dividend: normalize to 0-100 (4% yield = 100)
    div_score = min(100, div_yield * 25) if div_yield > 0 else 0

    # Sector diversity: penalize if 3+ from same sector already
    count = sector_counts.get(sector, 0)
    if count >= 4:
        sector_score = 20
    elif count >= 3:
        sector_score = 50
    elif count >= 2:
        sector_score = 75
    else:
        sector_score = 100

    # Earnings: binary
    earnings_score = 0 if near_earnings else 100

    composite = (
        iv_score * 0.30 +
        liq_score * 0.20 +
        stab_score * 0.15 +
        stock_liq_score * 0.10 +
        div_score * 0.10 +
        sector_score * 0.10 +
        earnings_score * 0.05
    )

    return round(composite, 1)


def _compute_rolling_hv(returns, window=30):
    """Compute rolling historical volatility series."""
    if len(returns) < window:
        return np.array([np.std(returns) * np.sqrt(252)])
    hvs = []
    for i in range(window, len(returns) + 1):
        w = returns[i - window:i]
        hvs.append(np.std(w) * np.sqrt(252))
    return np.array(hvs)


def _liquidity_score(avg_volume, price):
    """Score stock liquidity 0-100."""
    dollar_volume = avg_volume * price
    if dollar_volume >= 1e9:
        return 100
    elif dollar_volume >= 1e8:
        return 70 + 30 * (dollar_volume - 1e8) / (1e9 - 1e8)
    elif dollar_volume >= 1e7:
        return 40 + 30 * (dollar_volume - 1e7) / (1e8 - 1e7)
    else:
        return max(10, 40 * dollar_volume / 1e7)


def _options_liquidity(avg_volume, price):
    """Score options liquidity 0-100."""
    dollar_volume = avg_volume * price
    vol_score = min(100, dollar_volume / 1e8 * 30)
    if price > 500:
        price_penalty = min(30, (price - 500) / 50)
    elif price < 15:
        price_penalty = min(30, (15 - price) / 2)
    else:
        price_penalty = 0
    return max(0, min(100, vol_score - price_penalty))


def _stability_score(returns):
    """Price stability score 0-100."""
    if len(returns) < 20:
        return 50.0
    vol = np.std(returns) * np.sqrt(252)
    cum = np.cumprod(1 + returns)
    peak = np.maximum.accumulate(cum)
    dd = (cum - peak) / peak
    max_dd = abs(np.min(dd)) if len(dd) > 0 else 0
    vol_score = max(0, 100 - vol * 200)
    dd_score = max(0, 100 - max_dd * 200)
    return vol_score * 0.6 + dd_score * 0.4


def screen_universe(max_results=30, min_price=10, max_price=500,
                    min_iv_rank=None, min_div_yield=None,
                    sector_filter=None, skip_earnings=True,
                    earnings_window=7, verbose=True):
    """
    Screen a broad universe for best wheel strategy candidates.

    Args:
        max_results: number of top candidates to return
        min_price: minimum stock price (default $10)
        max_price: maximum stock price (default $500)
        min_iv_rank: minimum IV rank percentile (e.g. 30)
        min_div_yield: minimum annual dividend yield % (e.g. 1.0)
        sector_filter: only include this sector (e.g. 'Technology')
        skip_earnings: exclude stocks with earnings within earnings_window days
        earnings_window: days before earnings to exclude
        verbose: print progress

    Returns:
        list of scored candidate dicts, sorted by composite score descending
    """
    if not HAS_YFINANCE:
        print("ERROR: yfinance required. Install with: pip install yfinance")
        return []

    universe = get_full_universe()
    if verbose:
        print(f"Screening {len(universe)} stocks for wheel candidates...")
        print(f"Price range: ${min_price}-${max_price}")
        if min_iv_rank:
            print(f"Min IV rank: {min_iv_rank}%")
        if min_div_yield:
            print(f"Min div yield: {min_div_yield}%")
        if sector_filter:
            print(f"Sector: {sector_filter}")
        print()

    # Pre-filter by price and sector
    filtered = []
    for stock in universe:
        price = stock['approx_price']
        if price < min_price or price > max_price:
            continue
        if sector_filter and stock['sector'] != sector_filter:
            continue
        filtered.append(stock)

    if verbose:
        print(f"After price/sector filter: {len(filtered)} stocks")

    # Fetch data in batches
    tickers = [s['ticker'] for s in filtered]
    ticker_map = {s['ticker']: s for s in filtered}

    # Fetch earnings data
    earnings_data = {}
    if skip_earnings:
        try:
            earnings_data = get_earnings_dates(tickers)
        except Exception as e:
            if verbose:
                print(f"Earnings fetch failed: {e}")

    # Fetch dividend data
    div_data = {}
    try:
        div_data = get_dividend_info(tickers)
    except Exception as e:
        if verbose:
            print(f"Dividend fetch failed: {e}")

    # Fetch historical data via yfinance (batch download)
    if verbose:
        print(f"Fetching 6-month historical data for {len(tickers)} tickers...")

    hist_data = {}
    # Process in batches to avoid rate limits
    batch_size = 20
    for i in range(0, len(tickers), batch_size):
        batch = tickers[i:i + batch_size]
        try:
            data = yf.download(
                batch, period='6mo', progress=False, auto_adjust=True,
                group_by='ticker', threads=True,
            )
            if data is not None and not data.empty:
                if len(batch) == 1:
                    # Single ticker: different DataFrame structure
                    if hasattr(data.columns, 'levels') and len(data.columns.levels) > 1:
                        data.columns = data.columns.get_level_values(0)
                    hist_data[batch[0]] = data
                else:
                    for t in batch:
                        try:
                            if t in data.columns.get_level_values(0):
                                df = data[t].dropna(how='all')
                                if len(df) > 0:
                                    hist_data[t] = df
                        except Exception:
                            pass
        except Exception as e:
            if verbose:
                print(f"  Batch {i//batch_size + 1} failed: {e}")

        if verbose and i + batch_size < len(tickers):
            print(f"  Fetched {min(i + batch_size, len(tickers))}/{len(tickers)}...")
        time.sleep(0.5)

    if verbose:
        print(f"Got data for {len(hist_data)} tickers\n")

    # Score each ticker
    results = []
    sector_counts = {}

    for ticker in tickers:
        stock = ticker_map[ticker]
        sector = stock['sector']

        # Check earnings
        ear = earnings_data.get(ticker, {})
        near_earnings = False
        earnings_date = ear.get('date')
        earnings_days = ear.get('days_until')
        if skip_earnings and ear.get('within_7d', False):
            continue  # Skip entirely
        if earnings_days is not None and earnings_days <= earnings_window:
            near_earnings = True

        # Get dividend yield
        div = div_data.get(ticker, {})
        div_yield = div.get('annual_yield_pct', 0) or 0
        if min_div_yield is not None and div_yield < min_div_yield:
            continue

        # Compute metrics from historical data
        if ticker in hist_data:
            df = hist_data[ticker]
            if 'Close' in df.columns and len(df) > 20:
                closes = df['Close'].values.flatten()
                returns = np.diff(np.log(closes))

                if len(returns) < 10:
                    continue

                # IV rank from rolling HV
                hv_series = _compute_rolling_hv(returns, window=30)
                current_hv = hv_series[-1] if len(hv_series) > 0 else 0.25
                low_hv = float(np.min(hv_series))
                high_hv = float(np.max(hv_series))
                if high_hv - low_hv > 0.001:
                    iv_rank = max(0, min(100, (current_hv - low_hv) / (high_hv - low_hv) * 100))
                else:
                    iv_rank = 50.0

                iv_pctile = float(np.sum(hv_series < current_hv) / len(hv_series) * 100)

                # Check IV rank filter
                if min_iv_rank is not None and iv_rank < min_iv_rank:
                    continue

                # Volume
                avg_volume = float(df['Volume'].mean()) if 'Volume' in df.columns else 5e6
                price = float(closes[-1])

                # Scores
                stability = _stability_score(np.diff(closes) / closes[:-1])
                stock_liq = _liquidity_score(avg_volume, price)
                opt_liq = _options_liquidity(avg_volume, price)
                hist_vol = float(current_hv)
            else:
                continue  # Skip if no usable data
        else:
            # Fallback: use approximate data
            price = stock['approx_price']
            iv_rank = 50.0
            iv_pctile = 50.0
            stability = 60.0
            stock_liq = 60.0
            opt_liq = 50.0
            hist_vol = 0.25

        # Final price filter with real prices
        if price < min_price or price > max_price:
            continue

        # Compute composite score
        score = compute_wheel_score(
            ticker=ticker,
            price=price,
            iv_rank=iv_rank,
            iv_pctile=iv_pctile,
            stability=stability,
            stock_liquidity=stock_liq,
            options_liquidity=opt_liq,
            div_yield=div_yield,
            near_earnings=near_earnings,
            sector=sector,
            sector_counts=sector_counts,
        )

        sector_counts[sector] = sector_counts.get(sector, 0) + 1

        results.append({
            'ticker': ticker,
            'name': stock['name'],
            'sector': sector,
            'price': round(price, 2),
            'iv_rank': round(iv_rank, 1),
            'iv_percentile': round(iv_pctile, 1),
            'hist_vol': round(hist_vol, 3),
            'stability': round(stability, 1),
            'stock_liquidity': round(stock_liq, 1),
            'options_liquidity': round(opt_liq, 1),
            'div_yield_pct': round(div_yield, 2),
            'div_amount': div.get('amount_per_share', 0),
            'near_earnings': near_earnings,
            'earnings_date': earnings_date,
            'earnings_days': earnings_days,
            'composite_score': score,
            'capital_per_contract': round(price * 100, 0),
        })

    # Sort by score descending
    results.sort(key=lambda x: x['composite_score'], reverse=True)

    return results[:max_results]


def format_results(results, show_all=False):
    """Format screening results as a readable table."""
    lines = [
        "",
        "=" * 120,
        "WHEEL STRATEGY UNIVERSE SCREENER",
        "=" * 120,
        "",
        f"{'#':>3s} {'Ticker':7s} {'Price':>8s} {'IVR%':>6s} {'IVP%':>6s} "
        f"{'HV':>6s} {'Stab':>5s} {'OptLiq':>7s} {'DivY%':>6s} "
        f"{'Score':>6s} {'Capital':>9s} {'Sector':>20s} {'Earnings':>12s}",
        "-" * 120,
    ]

    for i, r in enumerate(results, 1):
        ear_str = ''
        if r.get('near_earnings'):
            ear_str = f"!{r.get('earnings_days', '?')}d"
        elif r.get('earnings_date'):
            ear_str = f"{r.get('earnings_days', '?')}d"

        div_str = f"{r['div_yield_pct']:.1f}%" if r['div_yield_pct'] > 0 else '-'

        lines.append(
            f"{i:>3d} {r['ticker']:7s} ${r['price']:>6.0f} "
            f"{r['iv_rank']:>5.1f} {r['iv_percentile']:>5.1f} "
            f"{r['hist_vol']:>5.1f}% {r['stability']:>5.1f} {r['options_liquidity']:>6.1f} "
            f"{div_str:>6s} "
            f"{r['composite_score']:>6.1f} "
            f"${r['capital_per_contract']:>7,.0f} "
            f"{r['sector']:>20s} "
            f"{ear_str:>12s}"
        )

    lines.append("-" * 120)

    # Sector summary
    sectors = {}
    for r in results:
        s = r['sector']
        sectors[s] = sectors.get(s, 0) + 1
    lines.append("")
    lines.append("Sector distribution:")
    for s, count in sorted(sectors.items(), key=lambda x: -x[1]):
        lines.append(f"  {s:25s} {count:>3d} stocks")

    # Stats
    if results:
        avg_iv = sum(r['iv_rank'] for r in results) / len(results)
        avg_score = sum(r['composite_score'] for r in results) / len(results)
        min_cap = min(r['capital_per_contract'] for r in results)
        max_cap = max(r['capital_per_contract'] for r in results)
        lines.append("")
        lines.append(f"Avg IV Rank: {avg_iv:.1f}% | Avg Score: {avg_score:.1f}")
        lines.append(f"Capital range: ${min_cap:,.0f} - ${max_cap:,.0f} per contract")

    lines.append("")

    return "\n".join(lines)


def format_discord(results, top_n=10):
    """Short Discord-friendly format."""
    lines = [
        f"**Wheel Universe Screener** ({len(results)} candidates)",
        "```",
        f"{'#':>2s} {'Ticker':6s} {'$':>6s} {'IVR':>4s} {'Score':>5s} {'Div':>5s} {'Sector'}",
        "-" * 55,
    ]

    for i, r in enumerate(results[:top_n], 1):
        div_str = f"{r['div_yield_pct']:.1f}%" if r['div_yield_pct'] > 0 else '-'
        lines.append(
            f"{i:>2d} {r['ticker']:6s} ${r['price']:>5.0f} "
            f"{r['iv_rank']:>3.0f}% {r['composite_score']:>5.1f} "
            f"{div_str:>5s} {r['sector'][:15]}"
        )

    lines.append("```")
    return "\n".join(lines)


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Wheel Strategy Universe Screener',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m trading_agents.wheel_strategy.universe_screener --top 30
  python -m trading_agents.wheel_strategy.universe_screener --top 50 --max-price 200
  python -m trading_agents.wheel_strategy.universe_screener --sector Technology --top 10
  python -m trading_agents.wheel_strategy.universe_screener --min-iv-rank 40 --min-yield 1.0
  python -m trading_agents.wheel_strategy.universe_screener --discord
        """,
    )
    parser.add_argument('--top', type=int, default=30,
                        help='Number of top candidates (default: 30)')
    parser.add_argument('--min-price', type=float, default=10,
                        help='Minimum stock price (default: $10)')
    parser.add_argument('--max-price', type=float, default=500,
                        help='Maximum stock price (default: $500)')
    parser.add_argument('--min-iv-rank', type=float, default=None,
                        help='Minimum IV rank percentile (e.g. 30)')
    parser.add_argument('--min-yield', type=float, default=None,
                        help='Minimum annual dividend yield %% (e.g. 1.0)')
    parser.add_argument('--sector', type=str, default=None,
                        help='Filter by sector (e.g. Technology, Financials)')
    parser.add_argument('--no-skip-earnings', action='store_true',
                        help='Include stocks with imminent earnings')
    parser.add_argument('--discord', action='store_true',
                        help='Output in short Discord format')
    parser.add_argument('--json', action='store_true',
                        help='Output raw JSON')
    parser.add_argument('--save', action='store_true',
                        help='Save results to data/ directory')
    args = parser.parse_args()

    results = screen_universe(
        max_results=args.top,
        min_price=args.min_price,
        max_price=args.max_price,
        min_iv_rank=args.min_iv_rank,
        min_div_yield=args.min_yield,
        sector_filter=args.sector,
        skip_earnings=not args.no_skip_earnings,
    )

    if not results:
        print("No candidates found matching criteria.")
        return

    if args.discord:
        print(format_discord(results))
    elif args.json:
        print(json.dumps(results, indent=2))
    else:
        print(format_results(results))

    if args.save:
        data_dir = Path(__file__).resolve().parent / 'data'
        data_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        out_path = data_dir / f'universe_screen_{ts}.json'
        with open(out_path, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\nSaved to: {out_path}")


if __name__ == '__main__':
    main()
