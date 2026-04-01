#!/usr/bin/env python3
"""
Wheel Strategy Portfolio Optimizer — $100K allocation engine.

Pulls real CSP candidates from Alpaca, then optimizes a concentrated
portfolio with risk-adjusted scoring and sector diversification.

Supports 3 risk modes:
  - safe:       Blue-chip income, delta 0.15-0.20, 30-45 DTE, 5 positions max
  - standard:   Balanced mix, delta 0.25-0.30, 14-30 DTE, 7 positions max
  - aggressive: High IV weeklies, delta 0.35-0.45, 7-14 DTE, 10 positions max

Usage:
    python portfolio_optimizer.py --optimize
    python portfolio_optimizer.py --optimize --mode safe
    python portfolio_optimizer.py --optimize --mode aggressive --capital 50000
    python portfolio_optimizer.py --optimize --conservative   # (legacy alias for --mode safe)
"""

import json
import sys
import time
import argparse
from datetime import datetime
from pathlib import Path
from itertools import combinations

# Add parent paths so imports work when run directly
sys.path.insert(0, str(Path(__file__).resolve().parent))

from alpaca_options import AlpacaOptionsClient, WHEEL_UNIVERSE
from risk_profiles import get_profile, list_profiles, VALID_MODES
from earnings_dividends import (
    get_earnings_dates, get_dividend_info, filter_earnings_risk,
    dividend_capture_opportunity,
)

DATA_DIR = Path(__file__).resolve().parent / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ── Sector mapping ──────────────────────────────────────────────────────────

SECTOR_MAP = {
    # Tech
    'INTC': 'Tech', 'AMD': 'Tech', 'PLTR': 'Tech', 'SNAP': 'Tech',
    'AAPL': 'Tech', 'AMZN': 'Tech', 'COIN': 'Tech', 'HOOD': 'Tech',
    'MSFT': 'Tech', 'GOOGL': 'Tech', 'META': 'Tech', 'NVDA': 'Tech',
    # EV / Auto
    'RIVN': 'EV/Auto', 'LCID': 'EV/Auto', 'NIO': 'EV/Auto', 'F': 'EV/Auto',
    'TSLA': 'EV/Auto',
    # Crypto-adjacent
    'MARA': 'Crypto', 'RIOT': 'Crypto',
    # Airlines
    'AAL': 'Airlines', 'DAL': 'Airlines', 'UAL': 'Airlines',
    # Finance
    'SOFI': 'Finance', 'BAC': 'Finance', 'C': 'Finance', 'WFC': 'Finance',
    'XLF': 'Finance', 'JPM': 'Finance',
    # Energy
    'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'XLE': 'Energy',
    # Consumer
    'KO': 'Consumer', 'PEP': 'Consumer', 'PG': 'Consumer', 'T': 'Consumer',
    'WMT': 'Consumer', 'GME': 'Consumer', 'AMC': 'Consumer',
    # Healthcare
    'PFE': 'Healthcare', 'JNJ': 'Healthcare', 'WBA': 'Healthcare',
    # REITs
    'AGNC': 'REITs', 'NLY': 'REITs', 'O': 'REITs',
    # ETFs
    'IWM': 'ETFs', 'EEM': 'ETFs', 'SPY': 'ETFs', 'QQQ': 'ETFs',
    # Media
    'PARA': 'Consumer',
}


def get_sector(ticker):
    """Return sector for a ticker, default to 'Other'."""
    # COIN appears in both Tech and Crypto — treat as Crypto for diversification
    if ticker in ('COIN',):
        return 'Crypto'
    return SECTOR_MAP.get(ticker, 'Other')


# ── Candidate scoring ───────────────────────────────────────────────────────

def score_candidate(cand, conservative=False, profile=None):
    """
    Risk-adjusted score for a CSP candidate.

    Args:
        cand: candidate dict from AlpacaOptionsClient
        conservative: legacy flag (ignored if profile is provided)
        profile: risk profile dict from get_profile(). If None, uses
                 'safe' profile when conservative=True, else 'standard'.

    Returns float score (higher = better).
    """
    # Resolve profile
    if profile is None:
        profile = get_profile('safe' if conservative else 'standard')

    wy = cand['weekly_yield_pct']
    iv = cand['iv'] if cand['iv'] > 0 else 0.01
    delta = abs(cand['delta'])
    bid = cand['bid']
    ask = cand['ask']

    weights = profile['scoring_weights']

    # 1. Yield efficiency (Sharpe-like): yield per unit of IV risk
    yield_efficiency = wy / (iv * 100) if iv > 0 else 0

    # 2. Absolute yield bonus — reward being in target range
    target_min = profile['target_weekly_yield_min'] * 100  # e.g. 1.0%
    target_max = profile['target_weekly_yield_max'] * 100  # e.g. 2.0%
    if target_min <= wy <= target_max:
        yield_bonus = 1.0
    elif wy < target_min:
        # Scale down based on how far below target
        yield_bonus = max(0.2, wy / target_min) if target_min > 0 else 0.2
    elif wy <= target_max * 1.5:
        yield_bonus = 0.7  # Above target but not crazy
    else:
        yield_bonus = 0.3  # Suspiciously high

    # 3. Delta preference — target the midpoint of the profile's delta range
    target_delta = profile['csp_delta_target']
    delta_score = max(0, 1.0 - abs(delta - target_delta) * 5)

    # 4. Spread quality (tighter = better)
    if bid > 0 and ask > 0:
        spread_pct = (ask - bid) / bid
        if spread_pct <= 0.10:
            spread_score = 1.0
        elif spread_pct <= 0.25:
            spread_score = 0.7
        elif spread_pct <= 0.50:
            spread_score = 0.4
        else:
            spread_score = 0.1
    else:
        spread_score = 0.0

    # 5. IV penalty for extremes (thresholds from profile)
    iv_pct = iv * 100
    if iv_pct > profile['iv_danger_threshold']:
        iv_penalty = 0.5
    elif iv_pct > profile['iv_warning_threshold']:
        iv_penalty = 0.75
    else:
        iv_penalty = 1.0

    score = (
        yield_efficiency * weights['yield_efficiency']
        + yield_bonus * weights['yield_bonus']
        + delta_score * weights['delta_score']
        + spread_score * weights['spread_score']
    ) * iv_penalty

    return round(score, 4)


# ── Liquidity filter ────────────────────────────────────────────────────────

def passes_liquidity_filter(cand):
    """Filter out illiquid options."""
    bid = cand['bid']
    ask = cand['ask']

    # Minimum bid
    if bid < 0.05:
        return False

    # Spread check
    if bid > 0 and ask > 0:
        spread_pct = (ask - bid) / bid
        if spread_pct > 0.50:
            return False

    return True


# ── Portfolio optimizer ──────────────────────────────────────────────────────

class PortfolioOptimizer:
    """
    Optimize a wheel strategy portfolio from real Alpaca options data.

    Supports 3 risk modes via risk profiles:
    - safe:       5 positions, blue chips, low delta, 30-45 DTE
    - standard:   7 positions, balanced mix, mid delta, 14-30 DTE
    - aggressive: 10 positions, high IV stocks, high delta, 7-14 DTE
    """

    def __init__(self, capital=100_000, mode='standard', conservative=False,
                 skip_earnings=True, include_dividends=True):
        """
        Args:
            capital: total portfolio capital
            mode: risk profile name ('safe', 'standard', 'aggressive')
            conservative: legacy flag — if True and mode not explicitly set,
                          uses 'safe' profile
            skip_earnings: skip tickers with earnings within 7 days (default True)
            include_dividends: factor dividend yield into scoring (default True)
        """
        # Resolve mode: legacy --conservative maps to 'safe'
        if conservative and mode == 'standard':
            mode = 'safe'

        self.capital = capital
        self.mode = mode
        self.profile = get_profile(mode)
        self.client = AlpacaOptionsClient()
        self.skip_earnings = skip_earnings
        self.include_dividends = include_dividends

        # Pull constraints from profile
        self.min_positions = max(3, self.profile['max_positions'] - 2)
        self.max_positions = self.profile['max_positions']
        self.max_position_pct = self.profile['max_position_pct']
        self.max_per_sector = self.profile['max_per_sector']
        self.target_weekly_yield_min = self.profile['target_weekly_yield_min']
        self.target_weekly_yield_max = self.profile['target_weekly_yield_max']

        # Earnings and dividend data (fetched lazily)
        self._earnings_data = None
        self._dividend_data = None

        # For backward compat
        self.conservative = (mode == 'safe')

    def scan_universe(self, tickers=None, max_dte=None):
        """Scan all tickers and return scored candidates."""
        # Use profile tickers if none specified
        tickers = tickers or self.profile['tickers']
        # Use profile DTE range if max_dte not specified
        if max_dte is None:
            max_dte = self.profile['dte_max']
        min_dte = self.profile['dte_min']

        print(f"Scanning {len(tickers)} tickers for CSP candidates...")
        print(f"Mode: {self.profile['name']} — {self.profile['description']}")
        print(f"Capital: ${self.capital:,.0f} | "
              f"Delta: {self.profile['csp_delta_min']:.2f}-{self.profile['csp_delta_max']:.2f} | "
              f"DTE: {min_dte}-{max_dte}d | "
              f"Max positions: {self.max_positions}")

        # ── Earnings filter ──────────────────────────────────────────
        earnings_skipped = []
        if self.skip_earnings:
            print(f"Earnings filter: ON (7-day window)")
            try:
                self._earnings_data = get_earnings_dates(tickers)
                safe_tickers = []
                for t in tickers:
                    info = self._earnings_data.get(t, {})
                    if info.get('within_7d', False):
                        earnings_skipped.append(
                            (t, info.get('date', '?'), info.get('days_until', '?'))
                        )
                        print(f"  SKIP {t}: earnings {info.get('date','?')} "
                              f"({info.get('days_until','?')}d away)")
                    else:
                        safe_tickers.append(t)
                tickers = safe_tickers
            except Exception as e:
                print(f"  Earnings check failed: {e} — proceeding without filter")
        else:
            print(f"Earnings filter: OFF")

        # ── Dividend data ────────────────────────────────────────────
        if self.include_dividends:
            print(f"Dividend scoring: ON")
            try:
                self._dividend_data = get_dividend_info(tickers, dte_window=max_dte)
                div_tickers = [t for t, d in self._dividend_data.items()
                               if d.get('annual_yield_pct', 0) > 0]
                if div_tickers:
                    print(f"  Dividend-paying: {', '.join(div_tickers[:8])}"
                          f"{'...' if len(div_tickers) > 8 else ''}")
            except Exception as e:
                print(f"  Dividend check failed: {e} — proceeding without")
                self._dividend_data = {}
        else:
            print(f"Dividend scoring: OFF")

        print()

        all_candidates = []
        errors = []

        for i, ticker in enumerate(tickers):
            try:
                csps = self.client.get_csp_candidates(
                    ticker,
                    target_delta=-self.profile['csp_delta_target'],
                    dte_range=(min_dte, max_dte),
                )

                if not csps:
                    continue

                # Filter by liquidity
                liquid_csps = [c for c in csps if passes_liquidity_filter(c)]
                if not liquid_csps:
                    continue

                # Pick best candidate per ticker: score using profile
                for csp in liquid_csps:
                    csp['score'] = score_candidate(csp, profile=self.profile)
                    csp['sector'] = get_sector(ticker)

                    # Dividend yield boost
                    if self.include_dividends and self._dividend_data:
                        div_info = self._dividend_data.get(ticker, {})
                        div_yield = div_info.get('annual_yield_pct', 0)
                        if div_yield > 0:
                            # Add up to 0.5 points for high-dividend stocks
                            # (4% yield = +0.5 score bonus)
                            div_bonus = min(0.5, div_yield / 8.0)
                            csp['score'] += div_bonus
                            csp['dividend_yield_pct'] = div_yield
                            csp['dividend_per_contract'] = div_info.get(
                                'dividend_per_100_shares', 0)

                            # Check dividend capture opportunity
                            capture = dividend_capture_opportunity(
                                ticker, div_info, csp.get('dte', 30))
                            csp['div_capture'] = capture
                        else:
                            csp['dividend_yield_pct'] = 0.0
                            csp['dividend_per_contract'] = 0.0
                            csp['div_capture'] = None
                    else:
                        csp['dividend_yield_pct'] = 0.0
                        csp['dividend_per_contract'] = 0.0
                        csp['div_capture'] = None

                best = max(liquid_csps, key=lambda x: x['score'])

                # Check if collateral fits in max position size
                max_collateral = self.capital * self.max_position_pct
                max_contracts = int(max_collateral / best['collateral'])
                if max_contracts < 1:
                    print(f"  {ticker}: SKIP — collateral ${best['collateral']:,.0f} > max ${max_collateral:,.0f}")
                    continue

                best['max_contracts'] = max_contracts
                best['ticker'] = ticker
                all_candidates.append(best)
                print(f"  {ticker}: ${best['strike']} {best['expiry']} "
                      f"bid=${best['bid']:.2f} delta={best['delta']:.3f} "
                      f"wk={best['weekly_yield_pct']:.2f}% score={best['score']:.2f} "
                      f"[{best['sector']}]")

                time.sleep(0.3)  # Rate limit

            except Exception as e:
                errors.append((ticker, str(e)[:80]))
                print(f"  {ticker}: ERROR — {str(e)[:60]}")
                continue

        print(f"\nFound {len(all_candidates)} viable candidates from {len(tickers)} tickers")
        if errors:
            print(f"Errors on {len(errors)} tickers")

        return all_candidates

    def optimize(self, candidates):
        """
        Greedy portfolio construction with sector constraints.

        Algorithm:
        1. Sort candidates by score (risk-adjusted)
        2. Greedily add positions respecting:
           - Max positions (7)
           - Max per sector (2)
           - Max position size (30%)
           - Capital budget
        3. Size each position to balance yield contribution
        """
        if not candidates:
            return None

        # Sort by score descending
        ranked = sorted(candidates, key=lambda x: x['score'], reverse=True)

        portfolio = []
        sector_counts = {}
        remaining_capital = self.capital
        cash_reserve = self.capital * self.profile['cash_reserve_pct']

        for cand in ranked:
            if len(portfolio) >= self.max_positions:
                break

            sector = cand['sector']

            # Sector diversification check
            if sector_counts.get(sector, 0) >= self.max_per_sector:
                continue

            # How much can we allocate?
            max_for_position = min(
                remaining_capital - cash_reserve,
                self.capital * self.max_position_pct,
            )

            if max_for_position < cand['collateral']:
                continue  # Can't afford even 1 contract

            # Determine number of contracts
            # Start with score-proportional sizing, but cap at max
            contracts = int(max_for_position / cand['collateral'])
            contracts = max(1, contracts)

            # For higher-risk (high IV) positions, reduce size based on profile
            iv_pct = cand['iv'] * 100
            iv_high_cap = self.profile['iv_high_contracts_cap']
            iv_med_cap = self.profile['iv_medium_contracts_cap']
            if iv_pct > self.profile['iv_warning_threshold'] and contracts > iv_high_cap:
                contracts = max(iv_high_cap, contracts // 2)
            elif iv_pct > self.profile['iv_warning_threshold'] * 0.75 and contracts > iv_med_cap:
                contracts = max(iv_med_cap, int(contracts * 0.7))

            total_collateral = cand['collateral'] * contracts
            total_premium = cand['premium_per_contract'] * contracts
            dte = max(cand['dte'], 1)
            weeks = max(dte / 7, 1)

            position = {
                'ticker': cand['ticker'],
                'sector': sector,
                'strike': cand['strike'],
                'expiry': cand['expiry'],
                'dte': cand['dte'],
                'contracts': contracts,
                'bid': cand['bid'],
                'ask': cand['ask'],
                'spread': cand['spread'],
                'delta': cand['delta'],
                'iv': cand['iv'],
                'theta': cand.get('theta', 0),
                'premium_per_contract': cand['premium_per_contract'],
                'total_premium': round(total_premium, 2),
                'collateral_per_contract': cand['collateral'],
                'total_collateral': round(total_collateral, 2),
                'weekly_yield_pct': cand['weekly_yield_pct'],
                'position_weekly_yield': round(
                    (total_premium / total_collateral) / weeks * 100, 3
                ),
                'breakeven': cand['breakeven'],
                'score': cand['score'],
                'pct_of_portfolio': round(total_collateral / self.capital * 100, 1),
                'symbol': cand.get('symbol', ''),
                'dividend_yield_pct': cand.get('dividend_yield_pct', 0.0),
                'dividend_per_contract': cand.get('dividend_per_contract', 0.0),
                'div_capture': cand.get('div_capture'),
            }

            portfolio.append(position)
            sector_counts[sector] = sector_counts.get(sector, 0) + 1
            remaining_capital -= total_collateral

        # If we have fewer than min_positions, warn but continue
        if len(portfolio) < self.min_positions:
            print(f"\nWARNING: Only {len(portfolio)} positions found "
                  f"(target {self.min_positions}-{self.max_positions})")

        return self._build_summary(portfolio, remaining_capital)

    def _build_summary(self, portfolio, remaining_capital):
        """Build portfolio summary with aggregate metrics."""
        if not portfolio:
            return None

        total_collateral = sum(p['total_collateral'] for p in portfolio)
        total_premium = sum(p['total_premium'] for p in portfolio)

        # Use the average DTE for weekly yield calc
        avg_dte = (sum(p['dte'] * p['total_collateral'] for p in portfolio)
                   / total_collateral) if total_collateral else 7
        avg_weeks = max(avg_dte / 7, 1)

        # Weighted averages
        w_delta = sum(abs(p['delta']) * p['total_collateral'] for p in portfolio) / total_collateral
        w_iv = sum(p['iv'] * p['total_collateral'] for p in portfolio) / total_collateral
        w_theta = sum(p['theta'] * p['contracts'] for p in portfolio)

        deployed_pct = total_collateral / self.capital * 100
        weekly_yield_deployed = (total_premium / total_collateral) / avg_weeks * 100
        weekly_yield_total = (total_premium / self.capital) / avg_weeks * 100

        # Sector breakdown
        sector_alloc = {}
        for p in portfolio:
            s = p['sector']
            sector_alloc[s] = sector_alloc.get(s, 0) + p['total_collateral']

        summary = {
            'timestamp': datetime.now().isoformat(),
            'mode': self.profile['name'],
            'risk_mode': self.mode,
            'capital': self.capital,
            'positions': portfolio,
            'aggregate': {
                'num_positions': len(portfolio),
                'total_collateral': round(total_collateral, 2),
                'total_premium': round(total_premium, 2),
                'cash_remaining': round(remaining_capital, 2),
                'deployed_pct': round(deployed_pct, 1),
                'avg_dte': round(avg_dte, 1),
                'weekly_yield_on_deployed': round(weekly_yield_deployed, 3),
                'weekly_yield_on_total': round(weekly_yield_total, 3),
                'annualized_yield_deployed': round(weekly_yield_deployed * 52, 1),
                'annualized_yield_total': round(weekly_yield_total * 52, 1),
                'weighted_delta': round(w_delta, 4),
                'weighted_iv': round(w_iv, 4),
                'total_theta': round(w_theta, 2),
                'sector_allocation': {
                    k: round(v / self.capital * 100, 1)
                    for k, v in sorted(sector_alloc.items(), key=lambda x: -x[1])
                },
            },
        }

        return summary

    def run(self, tickers=None, max_dte=None):
        """Full pipeline: scan -> score -> optimize -> output."""
        candidates = self.scan_universe(tickers, max_dte)
        if not candidates:
            print("\nNo candidates found. Market may be closed or API issue.")
            return None

        print("\n" + "=" * 70)
        print("OPTIMIZING PORTFOLIO...")
        print("=" * 70)

        result = self.optimize(candidates)
        if not result:
            print("Optimization failed — no valid portfolio found.")
            return None

        # Print results
        print(format_portfolio(result))

        # Save to file
        save_path = DATA_DIR / 'portfolio_allocation.json'
        with open(save_path, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\nSaved allocation to {save_path}")

        # Also save timestamped copy
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        ts_path = DATA_DIR / f'portfolio_allocation_{ts}.json'
        with open(ts_path, 'w') as f:
            json.dump(result, f, indent=2)

        return result


# ── Formatting ───────────────────────────────────────────────────────────────

def format_portfolio(result):
    """Format portfolio for console/Discord output."""
    if not result:
        return "No portfolio generated."

    agg = result['aggregate']
    positions = result['positions']
    mode = result['mode'].upper()

    lines = [
        "",
        f"**Wheel Portfolio — {mode} ({datetime.now().strftime('%Y-%m-%d %H:%M')})**",
        f"Capital: ${result['capital']:,.0f} | "
        f"Deployed: ${agg['total_collateral']:,.0f} ({agg['deployed_pct']:.0f}%)",
        "",
        "```",
        f"{'#':>2s} {'Ticker':6s} {'Strike':>7s} {'Exp':>10s} {'DTE':>4s} "
        f"{'Cts':>3s} {'Bid':>6s} {'Delta':>6s} {'IV':>6s} "
        f"{'Prem':>8s} {'Collat':>9s} {'Wk%':>6s} {'Port%':>5s} {'Sector':>10s}",
        "-" * 100,
    ]

    for i, p in enumerate(positions, 1):
        lines.append(
            f"{i:>2d} {p['ticker']:6s} ${p['strike']:>5.0f} "
            f"{p['expiry']:>10s} {p['dte']:>3d}d "
            f"{p['contracts']:>3d} ${p['bid']:>4.2f} "
            f"{p['delta']:>+5.3f} {p['iv']*100:>5.1f}% "
            f"${p['total_premium']:>6,.0f} ${p['total_collateral']:>7,.0f} "
            f"{p['weekly_yield_pct']:>5.2f}% "
            f"{p['pct_of_portfolio']:>4.1f}% "
            f"{p['sector']:>10s}"
        )

    lines.append("-" * 100)
    lines.append("")
    lines.append("PORTFOLIO SUMMARY")
    lines.append(f"  Positions:      {agg['num_positions']}")
    lines.append(f"  Total Premium:  ${agg['total_premium']:>10,.2f}")
    lines.append(f"  Total Collat:   ${agg['total_collateral']:>10,.2f}")
    lines.append(f"  Cash Reserve:   ${agg['cash_remaining']:>10,.2f}")
    lines.append(f"  Avg DTE:        {agg['avg_dte']:.0f} days")
    lines.append("")
    lines.append("YIELD")
    lines.append(f"  Weekly (deployed):   {agg['weekly_yield_on_deployed']:.2f}%"
                 f"  (ann: {agg['annualized_yield_deployed']:.0f}%)")
    lines.append(f"  Weekly (total cap):  {agg['weekly_yield_on_total']:.2f}%"
                 f"  (ann: {agg['annualized_yield_total']:.0f}%)")
    lines.append("")
    lines.append("RISK")
    lines.append(f"  Wtd Avg Delta:  {agg['weighted_delta']:.3f}")
    lines.append(f"  Wtd Avg IV:     {agg['weighted_iv']*100:.1f}%")
    lines.append(f"  Daily Theta:    ${agg['total_theta']:.2f}")
    lines.append("")
    lines.append("SECTOR ALLOCATION")
    for sector, pct in agg['sector_allocation'].items():
        bar = '#' * int(pct / 2)
        lines.append(f"  {sector:12s} {pct:>5.1f}%  {bar}")

    lines.append("```")
    lines.append("")
    lines.append("*Real bid prices from Alpaca. Sell these CSPs to open.*")

    return "\n".join(lines)


def format_portfolio_discord(result):
    """Shorter Discord-friendly format (under 2000 chars)."""
    if not result:
        return "No portfolio generated."

    agg = result['aggregate']
    positions = result['positions']
    mode = result['mode'].upper()

    lines = [
        f"**Wheel Portfolio — {mode}**",
        f"${result['capital']:,.0f} capital | "
        f"{agg['deployed_pct']:.0f}% deployed | "
        f"**{agg['weekly_yield_on_deployed']:.2f}% weekly** "
        f"({agg['annualized_yield_deployed']:.0f}% ann)",
        "```",
    ]

    for i, p in enumerate(positions, 1):
        lines.append(
            f"{i}. SELL {p['contracts']}x {p['ticker']} "
            f"${p['strike']}P {p['expiry']} "
            f"@${p['bid']:.2f} "
            f"= ${p['total_premium']:,.0f} "
            f"({p['weekly_yield_pct']:.2f}%/wk)"
        )

    lines.append(f"\nTotal premium: ${agg['total_premium']:,.0f}")
    lines.append(f"Collateral:    ${agg['total_collateral']:,.0f}")
    lines.append(f"Delta: {agg['weighted_delta']:.3f} | IV: {agg['weighted_iv']*100:.1f}%")
    lines.append("```")

    return "\n".join(lines)


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Wheel Strategy Portfolio Optimizer — real Alpaca data',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Risk Modes:
  safe        Blue-chip income, delta 0.15-0.20, 30-45 DTE, 5 positions
  standard    Balanced mix, delta 0.25-0.30, 14-30 DTE, 7 positions (default)
  aggressive  High IV weeklies, delta 0.35-0.45, 7-14 DTE, 10 positions

Examples:
  python portfolio_optimizer.py --optimize
  python portfolio_optimizer.py --optimize --mode safe
  python portfolio_optimizer.py --optimize --mode aggressive --capital 50000
  python portfolio_optimizer.py --list-profiles
        """,
    )
    parser.add_argument('--optimize', action='store_true',
                        help='Run full portfolio optimization')
    parser.add_argument('--mode', type=str, default='standard',
                        choices=VALID_MODES,
                        help='Risk profile: safe, standard, aggressive (default: standard)')
    parser.add_argument('--conservative', action='store_true',
                        help='Legacy alias for --mode safe')
    parser.add_argument('--capital', type=float, default=100_000,
                        help='Total portfolio capital (default: $100,000)')
    parser.add_argument('--max-dte', type=int, default=None,
                        help='Max days to expiration (overrides profile default)')
    parser.add_argument('--tickers', type=str, default=None,
                        help='Comma-separated tickers (overrides profile default)')
    parser.add_argument('--max-positions', type=int, default=None,
                        help='Max number of positions (overrides profile default)')
    parser.add_argument('--max-position-pct', type=float, default=None,
                        help='Max %% of capital per position (overrides profile default)')
    parser.add_argument('--skip-earnings', action='store_true', default=True,
                        dest='skip_earnings',
                        help='Skip tickers with earnings within 7 days (default: on)')
    parser.add_argument('--no-skip-earnings', action='store_false',
                        dest='skip_earnings',
                        help='Disable earnings avoidance filter')
    parser.add_argument('--include-dividends', action='store_true', default=True,
                        dest='include_dividends',
                        help='Factor dividend yield into scoring (default: on)')
    parser.add_argument('--no-dividends', action='store_false',
                        dest='include_dividends',
                        help='Disable dividend scoring')
    parser.add_argument('--discord', action='store_true',
                        help='Output in short Discord format')
    parser.add_argument('--json', action='store_true',
                        help='Output raw JSON')
    parser.add_argument('--list-profiles', action='store_true',
                        help='Show all risk profiles and exit')
    args = parser.parse_args()

    if args.list_profiles:
        print(list_profiles())
        return

    if not args.optimize:
        parser.print_help()
        print("\nRun with --optimize to build a portfolio.")
        return

    # Resolve mode
    mode = args.mode
    if args.conservative and mode == 'standard':
        mode = 'safe'

    tickers = args.tickers.split(',') if args.tickers else None

    optimizer = PortfolioOptimizer(
        capital=args.capital,
        mode=mode,
        skip_earnings=args.skip_earnings,
        include_dividends=args.include_dividends,
    )

    # CLI overrides for profile defaults
    if args.max_positions is not None:
        optimizer.max_positions = args.max_positions
    if args.max_position_pct is not None:
        optimizer.max_position_pct = args.max_position_pct / 100

    result = optimizer.run(tickers=tickers, max_dte=args.max_dte)

    if result and args.discord:
        print("\n--- DISCORD FORMAT ---")
        print(format_portfolio_discord(result))

    if result and args.json:
        print("\n--- JSON ---")
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
