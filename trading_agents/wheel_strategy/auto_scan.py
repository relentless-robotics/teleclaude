#!/usr/bin/env python3
"""
Monday Morning Auto-Scan — runs portfolio optimizer across all risk profiles
and formats results as a Discord-ready report.

Includes:
  - Top picks per profile (safe, standard, aggressive)
  - Earnings warnings for the week
  - Dividend capture opportunities
  - Per-ticker optimal CC parameters from sweep results

Usage:
    python -m trading_agents.wheel_strategy.auto_scan --all-profiles
    python -m trading_agents.wheel_strategy.auto_scan --mode standard
    python -m trading_agents.wheel_strategy.auto_scan --all-profiles --discord
    python -m trading_agents.wheel_strategy.auto_scan --all-profiles --json
"""

import argparse
import json
import sys
import time
from datetime import datetime, date, timedelta
from pathlib import Path

# Path setup
sys.path.insert(0, str(Path(__file__).resolve().parent))

from risk_profiles import RISK_PROFILES, VALID_MODES, get_profile, get_ticker_cc_params
from earnings_dividends import get_earnings_dates, get_dividend_info, filter_earnings_risk
from portfolio_optimizer import PortfolioOptimizer, format_portfolio_discord

DATA_DIR = Path(__file__).resolve().parent / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)


def run_profile_scan(mode, capital=100_000, skip_earnings=True, include_dividends=True):
    """
    Run portfolio optimizer for a single risk profile.

    Returns:
        dict with profile results, earnings warnings, dividend opportunities
    """
    profile = get_profile(mode)

    print(f"\n{'='*70}")
    print(f"SCANNING: {profile['name']} — {profile['description']}")
    print(f"{'='*70}")

    try:
        optimizer = PortfolioOptimizer(
            capital=capital,
            mode=mode,
            skip_earnings=skip_earnings,
            include_dividends=include_dividends,
        )
        result = optimizer.run()
    except Exception as e:
        print(f"ERROR running {mode} scan: {e}")
        return {
            'mode': mode,
            'profile_name': profile['name'],
            'error': str(e),
            'positions': [],
            'aggregate': None,
        }

    # Collect earnings warnings for the profile's tickers
    tickers = profile['tickers']
    earnings_warnings = []
    try:
        earnings = get_earnings_dates(tickers)
        for ticker, info in sorted(earnings.items()):
            if info.get('within_14d', False):
                earnings_warnings.append({
                    'ticker': ticker,
                    'date': info['date'],
                    'days_until': info['days_until'],
                    'within_7d': info['within_7d'],
                })
    except Exception:
        pass

    # Collect dividend opportunities
    div_opportunities = []
    try:
        divs = get_dividend_info(tickers, dte_window=profile.get('dte_max', 30))
        for ticker, info in sorted(divs.items()):
            if info.get('annual_yield_pct', 0) > 0.5:  # At least 0.5% yield
                div_opportunities.append({
                    'ticker': ticker,
                    'annual_yield_pct': info['annual_yield_pct'],
                    'amount_per_share': info['amount_per_share'],
                    'ex_date': info['ex_date'],
                    'ex_date_days': info['ex_date_days'],
                    'dividend_per_100_shares': info['dividend_per_100_shares'],
                    'within_dte': info.get('ex_div_within_dte', False),
                })
    except Exception:
        pass

    # Get per-ticker CC params
    cc_params = {}
    if result and result.get('positions'):
        for pos in result['positions']:
            ticker = pos['ticker']
            params = get_ticker_cc_params(ticker, mode)
            cc_params[ticker] = params

    return {
        'mode': mode,
        'profile_name': profile['name'],
        'description': profile['description'],
        'result': result,
        'earnings_warnings': earnings_warnings,
        'dividend_opportunities': div_opportunities,
        'cc_params': cc_params,
        'error': None,
    }


def run_all_profiles(capital=100_000, skip_earnings=True, include_dividends=True):
    """Run scans for all three risk profiles."""
    all_results = {}

    for mode in VALID_MODES:
        scan = run_profile_scan(
            mode=mode,
            capital=capital,
            skip_earnings=skip_earnings,
            include_dividends=include_dividends,
        )
        all_results[mode] = scan

    return all_results


def format_auto_scan_report(all_results, capital=100_000):
    """Format a comprehensive auto-scan report for console output."""
    today = date.today()
    lines = [
        "",
        "=" * 80,
        f"WHEEL STRATEGY AUTO-SCAN — {today.strftime('%A %B %d, %Y')}",
        f"Capital: ${capital:,.0f}",
        "=" * 80,
    ]

    for mode in VALID_MODES:
        scan = all_results.get(mode)
        if not scan:
            continue

        lines.append("")
        lines.append(f"{'─'*80}")
        lines.append(f"  {scan['profile_name']} — {scan.get('description', '')}")
        lines.append(f"{'─'*80}")

        if scan.get('error'):
            lines.append(f"  ERROR: {scan['error']}")
            continue

        result = scan.get('result')
        if not result or not result.get('positions'):
            lines.append("  No positions found.")
            continue

        agg = result['aggregate']
        positions = result['positions']

        lines.append(f"  Positions: {agg['num_positions']} | "
                     f"Deployed: ${agg['total_collateral']:,.0f} ({agg['deployed_pct']:.0f}%) | "
                     f"Premium: ${agg['total_premium']:,.0f}")
        lines.append(f"  Weekly yield: {agg['weekly_yield_on_deployed']:.2f}% "
                     f"(ann {agg['annualized_yield_deployed']:.0f}%) | "
                     f"Delta: {agg['weighted_delta']:.3f} | "
                     f"IV: {agg['weighted_iv']*100:.1f}%")
        lines.append("")

        # Top picks
        lines.append("  TOP PICKS:")
        for i, p in enumerate(positions[:5], 1):
            div_str = ''
            if p.get('dividend_yield_pct', 0) > 0:
                div_str = f" | Div: {p['dividend_yield_pct']:.1f}%"

            # CC params
            cc = scan.get('cc_params', {}).get(p['ticker'], {})
            cc_str = ''
            if cc:
                cc_str = f" | CC: d={cc.get('cc_delta', '?'):.2f}/{cc.get('cc_dte', '?')}d"

            lines.append(
                f"    {i}. SELL {p['contracts']}x {p['ticker']} "
                f"${p['strike']}P {p['expiry']} "
                f"@${p['bid']:.2f} = ${p['total_premium']:,.0f} "
                f"({p['weekly_yield_pct']:.2f}%/wk)"
                f"{div_str}{cc_str}"
            )

            # Dividend capture note
            cap = p.get('div_capture')
            if cap and cap.get('capture_possible'):
                lines.append(f"       >> {cap['timing_advice']}")

        # Earnings warnings
        warnings = scan.get('earnings_warnings', [])
        if warnings:
            lines.append("")
            lines.append("  EARNINGS WARNINGS:")
            for w in warnings:
                urgency = "!!!" if w['within_7d'] else " ! "
                lines.append(
                    f"    {urgency} {w['ticker']}: earnings {w['date']} "
                    f"({w['days_until']}d away)"
                )

        # Dividend opportunities
        divs = scan.get('dividend_opportunities', [])
        capturable = [d for d in divs if d.get('within_dte')]
        if capturable:
            lines.append("")
            lines.append("  DIVIDEND CAPTURE OPPORTUNITIES:")
            for d in capturable[:5]:
                lines.append(
                    f"    {d['ticker']}: {d['annual_yield_pct']:.1f}% yield | "
                    f"${d['amount_per_share']:.2f}/sh (${d['dividend_per_100_shares']:.0f}/contract) | "
                    f"Ex-div: {d['ex_date']} ({d['ex_date_days']}d)"
                )

    lines.append("")
    lines.append("=" * 80)
    lines.append(f"Scan completed at {datetime.now().strftime('%H:%M:%S')}")
    lines.append("=" * 80)
    lines.append("")

    return "\n".join(lines)


def format_discord_report(all_results, capital=100_000):
    """
    Format a Discord-friendly report (under 2000 chars per message).
    Returns list of message strings.
    """
    today = date.today()
    messages = []

    header = (
        f"**Wheel Auto-Scan {today.strftime('%m/%d')}** | "
        f"${capital/1000:.0f}K capital\n"
    )

    for mode in VALID_MODES:
        scan = all_results.get(mode)
        if not scan or scan.get('error'):
            continue

        result = scan.get('result')
        if not result or not result.get('positions'):
            continue

        agg = result['aggregate']
        positions = result['positions']

        msg_lines = [
            f"**{scan['profile_name']}** — "
            f"{agg['deployed_pct']:.0f}% deployed | "
            f"**{agg['weekly_yield_on_deployed']:.2f}%/wk** "
            f"({agg['annualized_yield_deployed']:.0f}% ann)",
            "```",
        ]

        for i, p in enumerate(positions[:7], 1):
            div_tag = f" D{p['dividend_yield_pct']:.0f}%" if p.get('dividend_yield_pct', 0) > 0.5 else ""
            msg_lines.append(
                f"{i}. {p['contracts']}x {p['ticker']} "
                f"${p['strike']}P {p['expiry']} "
                f"@${p['bid']:.2f} = ${p['total_premium']:,.0f} "
                f"({p['weekly_yield_pct']:.1f}%){div_tag}"
            )

        msg_lines.append(f"\nPremium: ${agg['total_premium']:,.0f} | "
                         f"Delta: {agg['weighted_delta']:.3f} | "
                         f"IV: {agg['weighted_iv']*100:.1f}%")
        msg_lines.append("```")

        # Earnings warnings (compact)
        warnings = scan.get('earnings_warnings', [])
        warn_7d = [w for w in warnings if w['within_7d']]
        if warn_7d:
            warn_str = ", ".join(f"{w['ticker']}({w['days_until']}d)" for w in warn_7d)
            msg_lines.append(f"Earnings this week: {warn_str}")

        # Dividend captures (compact)
        divs = scan.get('dividend_opportunities', [])
        capturable = [d for d in divs if d.get('within_dte')]
        if capturable:
            cap_str = ", ".join(
                f"{d['ticker']}(${d['dividend_per_100_shares']:.0f})"
                for d in capturable[:3]
            )
            msg_lines.append(f"Div capture: {cap_str}")

        messages.append("\n".join(msg_lines))

    if not messages:
        return [header + "No candidates found across any profile."]

    # Prepend header to first message
    messages[0] = header + messages[0]

    return messages


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Wheel Strategy Monday Morning Auto-Scan',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m trading_agents.wheel_strategy.auto_scan --all-profiles
  python -m trading_agents.wheel_strategy.auto_scan --mode standard
  python -m trading_agents.wheel_strategy.auto_scan --all-profiles --discord
  python -m trading_agents.wheel_strategy.auto_scan --all-profiles --capital 50000
  python -m trading_agents.wheel_strategy.auto_scan --all-profiles --json --save
        """,
    )
    parser.add_argument('--all-profiles', action='store_true',
                        help='Scan all 3 risk profiles')
    parser.add_argument('--mode', type=str, default=None, choices=VALID_MODES,
                        help='Scan a single risk profile')
    parser.add_argument('--capital', type=float, default=100_000,
                        help='Total portfolio capital (default: $100,000)')
    parser.add_argument('--no-skip-earnings', action='store_true',
                        help='Disable earnings avoidance')
    parser.add_argument('--no-dividends', action='store_true',
                        help='Disable dividend scoring')
    parser.add_argument('--discord', action='store_true',
                        help='Output Discord-formatted messages')
    parser.add_argument('--json', action='store_true',
                        help='Output raw JSON')
    parser.add_argument('--save', action='store_true',
                        help='Save results to data/ directory')
    args = parser.parse_args()

    if not args.all_profiles and not args.mode:
        parser.print_help()
        print("\nRun with --all-profiles or --mode <safe|standard|aggressive>")
        return

    skip_earnings = not args.no_skip_earnings
    include_dividends = not args.no_dividends

    if args.all_profiles:
        results = run_all_profiles(
            capital=args.capital,
            skip_earnings=skip_earnings,
            include_dividends=include_dividends,
        )
    else:
        scan = run_profile_scan(
            mode=args.mode,
            capital=args.capital,
            skip_earnings=skip_earnings,
            include_dividends=include_dividends,
        )
        results = {args.mode: scan}

    # Output
    if args.discord:
        messages = format_discord_report(results, capital=args.capital)
        for msg in messages:
            print(msg)
            print()
    elif args.json:
        # Serialize (strip non-serializable items)
        def _clean(obj):
            if isinstance(obj, dict):
                return {k: _clean(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [_clean(v) for v in obj]
            elif isinstance(obj, (date, datetime)):
                return str(obj)
            return obj

        print(json.dumps(_clean(results), indent=2, default=str))
    else:
        print(format_auto_scan_report(results, capital=args.capital))

    # Save
    if args.save:
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        out_path = DATA_DIR / f'auto_scan_{ts}.json'
        try:
            def _clean(obj):
                if isinstance(obj, dict):
                    return {k: _clean(v) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [_clean(v) for v in obj]
                elif isinstance(obj, (date, datetime)):
                    return str(obj)
                return obj

            with open(out_path, 'w') as f:
                json.dump(_clean(results), f, indent=2, default=str)
            print(f"\nSaved to: {out_path}")
        except Exception as e:
            print(f"\nFailed to save: {e}")


if __name__ == '__main__':
    main()
