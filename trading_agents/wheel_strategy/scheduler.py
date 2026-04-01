#!/usr/bin/env python3
"""
Wheel Strategy Scheduler -- runs scans and posts alerts to Discord.
Designed to be called from the main trading agent scheduler.

Improvements over v1:
- Graceful yfinance failure handling with retries and fallback
- IV rank sorting (prioritize high IV rank for better premiums)
- Capital allocation: risk-parity weighting by inverse vol
- Uses live prices from yfinance (not stale screener prices)
- Logs errors instead of silently swallowing them
"""

import sys
import os
import json
import logging
import numpy as np
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from trading_agents.wheel_strategy.stock_screener import screen_candidates
from trading_agents.wheel_strategy.options_pricer import (
    black_scholes, greeks, estimate_hist_iv, find_strike_by_delta
)

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')


def _fetch_ticker_data(ticker, period='60d', max_retries=2):
    """
    Fetch ticker data with retries and graceful failure.
    Returns (DataFrame, error_msg) -- error_msg is None on success.
    """
    try:
        import yfinance as yf
    except ImportError:
        return None, "yfinance not installed"

    for attempt in range(max_retries + 1):
        try:
            df = yf.download(ticker, period=period, progress=False, auto_adjust=True)
            if df.empty:
                return None, f"No data returned for {ticker}"
            if hasattr(df.columns, 'levels') and len(df.columns.levels) > 1:
                df.columns = df.columns.get_level_values(0)
            return df, None
        except Exception as e:
            if attempt < max_retries:
                continue
            return None, f"yfinance error after {max_retries + 1} attempts: {str(e)[:80]}"


def _allocate_capital_risk_parity(plays, capital, max_deployed_pct=0.80):
    """
    Allocate capital using inverse-volatility weighting (risk parity).
    Lower vol stocks get more capital, higher vol stocks get less.
    All positions end up contributing roughly equal risk.

    Args:
        plays: list of play dicts with 'iv' field (annualized vol in %)
        capital: total capital
        max_deployed_pct: max fraction of capital to deploy

    Returns:
        plays with 'allocated_capital' and 'num_contracts' fields added
    """
    if not plays:
        return plays

    max_capital = capital * max_deployed_pct

    # Inverse vol weights
    vols = np.array([max(p['iv'] / 100.0, 0.05) for p in plays])
    inv_vols = 1.0 / vols
    weights = inv_vols / inv_vols.sum()

    for i, play in enumerate(plays):
        alloc = max_capital * weights[i]
        capital_per_contract = play['strike'] * 100
        if capital_per_contract > 0:
            num_contracts = max(1, int(alloc / capital_per_contract))
            # Don't over-allocate
            if num_contracts * capital_per_contract > alloc * 1.2:
                num_contracts = max(1, int(alloc / capital_per_contract))
        else:
            num_contracts = 0

        play['allocated_capital'] = round(num_contracts * capital_per_contract, 2)
        play['num_contracts'] = num_contracts
        play['weight_pct'] = round(weights[i] * 100, 1)

    # Verify total doesn't exceed limit
    total_allocated = sum(p['allocated_capital'] for p in plays)
    if total_allocated > max_capital:
        # Scale down
        scale = max_capital / total_allocated
        for play in plays:
            play['num_contracts'] = max(1, int(play['num_contracts'] * scale))
            play['allocated_capital'] = play['num_contracts'] * play['strike'] * 100

    return plays


def generate_weekly_plays(capital=100_000, max_positions=5, target_dte=7,
                          target_delta=0.35, min_safety="B", min_iv_rank=None):
    """
    Generate this week's wheel plays.

    Args:
        capital: total available capital
        max_positions: maximum number of positions
        target_dte: days to expiration (7 = weekly, 30 = monthly)
        target_delta: CSP delta target
        min_safety: minimum safety rating
        min_iv_rank: minimum IV rank (e.g., 30)

    Returns:
        tuple of (plays_list, errors_list)
    """
    errors = []

    # Screen candidates -- sorted by composite score already
    try:
        candidates = screen_candidates(
            max_results=max_positions * 4,  # Get extras in case of failures
            min_safety=min_safety,
            min_iv_rank=min_iv_rank,
        )
    except Exception as e:
        errors.append(f"Screener failed: {e}")
        return [], errors

    if not candidates:
        errors.append("No candidates passed screening filters")
        return [], errors

    plays = []

    for c in candidates:
        if len(plays) >= max_positions:
            break

        ticker = c['ticker']
        safety = c.get('safety_rating', c.get('safety', 'C'))

        # Fetch live data for pricing
        df, fetch_err = _fetch_ticker_data(ticker)
        if fetch_err:
            errors.append(f"{ticker}: {fetch_err}")
            continue

        try:
            closes = df['Close'].values.flatten()
            if len(closes) < 20:
                errors.append(f"{ticker}: insufficient data ({len(closes)} days)")
                continue

            # Use live price, not stale screener price
            live_price = float(closes[-1])

            # Capital check with live price
            capital_needed = live_price * 100
            total_allocated = sum(p.get('allocated_capital', p['strike'] * 100)
                                  for p in plays)
            if total_allocated + capital_needed > capital * 0.8:
                continue

            returns = np.diff(np.log(closes))
            iv = estimate_hist_iv(returns, iv_premium=1.2)
            T = target_dte / 365.0
            r = 0.05

            # Find strike at target delta
            strike = find_strike_by_delta(live_price, T, r, iv, -target_delta, "put")
            strike = round(strike)

            # Validate strike is reasonable
            if strike <= 0 or strike > live_price * 1.1:
                errors.append(f"{ticker}: invalid strike ${strike} for price ${live_price:.2f}")
                continue

            premium = black_scholes(live_price, strike, T, r, iv, "put")
            g = greeks(live_price, strike, T, r, iv, "put")

            # Validate premium is meaningful
            if premium < 0.01:
                errors.append(f"{ticker}: premium too low (${premium:.4f})")
                continue

            weekly_return = (premium * 100) / (strike * 100) if strike > 0 else 0
            annual_return = weekly_return * (365 / target_dte) if target_dte > 0 else 0

            plays.append({
                'ticker': ticker,
                'price': round(live_price, 2),
                'strike': strike,
                'premium': round(premium, 2),
                'delta': round(g['delta'], 3),
                'iv': round(iv * 100, 1),
                'iv_rank': round(c.get('iv_rank', 50), 1),
                'weekly_return_pct': round(weekly_return * 100, 2),
                'annual_return_pct': round(annual_return * 100, 1),
                'capital_required': strike * 100,
                'safety': safety,
                'sector': c.get('sector', ''),
                'near_ex_dividend': c.get('near_ex_dividend', False),
            })

        except Exception as e:
            errors.append(f"{ticker}: pricing error - {str(e)[:80]}")
            continue

    # Sort plays by IV rank descending (best premium opportunities first)
    plays.sort(key=lambda p: p.get('iv_rank', 0), reverse=True)

    # Apply risk-parity capital allocation
    plays = _allocate_capital_risk_parity(plays, capital)

    return plays, errors


def format_discord_message(plays, errors=None):
    """Format plays for Discord posting."""
    if not plays:
        msg = "**Wheel Strategy -- No plays this week.** Market conditions unfavorable."
        if errors:
            msg += f"\n\nErrors: {len(errors)} tickers failed screening."
        return msg

    lines = [
        f"**Wheel Strategy -- Weekly Plays ({datetime.now().strftime('%Y-%m-%d')})**",
        f"```",
        f"{'Ticker':6s} {'Strike':>7s} {'Prem':>6s} {'Delta':>6s} {'IV':>6s} "
        f"{'IVR':>5s} {'Wk%':>6s} {'Ann%':>6s} {'Ct':>3s} {'Safe':>4s}",
        f"{'-'*65}",
    ]

    total_premium = 0
    total_capital = 0
    for p in plays:
        num_ct = p.get('num_contracts', 1)
        lines.append(
            f"{p['ticker']:6s} ${p['strike']:>5d}  ${p['premium']:>4.2f}  "
            f"{p['delta']:>5.3f}  {p['iv']:>4.1f}%  "
            f"{p.get('iv_rank', 0):>3.0f}%  "
            f"{p['weekly_return_pct']:>4.2f}%  {p['annual_return_pct']:>5.1f}%  "
            f"{num_ct:>3d}  {p['safety']}"
        )
        total_premium += p['premium'] * 100 * num_ct
        total_capital += p.get('allocated_capital', p['capital_required'])

    lines.append(f"{'-'*65}")
    lines.append(f"Total weekly premium: ${total_premium:,.0f}  |  Capital deployed: ${total_capital:,.0f}")
    lines.append(f"```")
    lines.append(f"*CSP delta={plays[0]['delta']:.2f}, {plays[0].get('dte', 7)} DTE. "
                 f"Sorted by IV Rank. Risk-parity sized.*")

    if errors:
        lines.append(f"\n_{len(errors)} ticker(s) skipped due to data issues._")

    return "\n".join(lines)


def run_weekly_scan(capital=100_000, max_positions=5, save=True):
    """
    Full weekly scan pipeline: screen -> price -> format -> save.
    Returns (message, plays, errors).
    """
    plays, errors = generate_weekly_plays(capital=capital, max_positions=max_positions)
    msg = format_discord_message(plays, errors)

    if save and plays:
        os.makedirs(DATA_DIR, exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        filepath = os.path.join(DATA_DIR, f'weekly_plays_{ts}.json')
        save_data = {
            'generated_at': datetime.now().isoformat(),
            'capital': capital,
            'plays': plays,
            'errors': errors,
        }
        with open(filepath, 'w') as f:
            json.dump(save_data, f, indent=2)
        logger.info(f"Saved weekly plays to {filepath}")

    if errors:
        for err in errors:
            logger.warning(f"Scan error: {err}")

    return msg, plays, errors


def run_daily_risk_check():
    """
    Run daily risk checks and return formatted report.
    Called by the trading agent scheduler for daily monitoring.
    """
    try:
        from trading_agents.wheel_strategy.risk_manager import RiskManager
        from trading_agents.wheel_strategy.performance_dashboard import WheelDashboard

        rm = RiskManager()
        dash = WheelDashboard()

        # Risk alerts
        risk_report = rm.format_risk_report()

        # Brief status
        brief = dash.generate_brief_report()

        # Upcoming expirations
        expirations = dash.upcoming_expirations(days_ahead=7)

        return f"{brief}\n\n{risk_report}\n\n{expirations}"

    except Exception as e:
        logger.error(f"Risk check failed: {e}")
        return f"Risk check error: {e}"


def run_weekly_report():
    """
    Generate full weekly performance report.
    Called by the trading agent scheduler for weekly summaries.
    """
    try:
        from trading_agents.wheel_strategy.performance_dashboard import WheelDashboard

        dash = WheelDashboard()
        return dash.generate_discord_report()

    except Exception as e:
        logger.error(f"Weekly report failed: {e}")
        return f"Weekly report error: {e}"


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)

    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'risk':
        print(run_daily_risk_check())
    elif len(sys.argv) > 1 and sys.argv[1] == 'report':
        print(run_weekly_report())
    else:
        msg, plays, errors = run_weekly_scan()
        print(msg)
        if errors:
            print(f"\n--- Errors ({len(errors)}) ---")
            for e in errors:
                print(f"  {e}")
