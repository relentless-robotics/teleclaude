"""
Wheel Strategy — Main CLI entry point.

Usage:
    python -m trading_agents.wheel_strategy.main scan [--top N] [--max-price P] [--safety A|B|C|D]
    python -m trading_agents.wheel_strategy.main backtest TICKER [--months M] [--capital C]
    python -m trading_agents.wheel_strategy.main backtest-portfolio [--top N] [--months M] [--capital C]
    python -m trading_agents.wheel_strategy.main status
    python -m trading_agents.wheel_strategy.main alert
    python -m trading_agents.wheel_strategy.main alpaca-sync
    python -m trading_agents.wheel_strategy.main alpaca-account
    python -m trading_agents.wheel_strategy.main alpaca-reconcile
    python -m trading_agents.wheel_strategy.main performance
    python -m trading_agents.wheel_strategy.main monthly
    python -m trading_agents.wheel_strategy.main validate TICKER [--strike S]
    python -m trading_agents.wheel_strategy.main lifecycle
    python -m trading_agents.wheel_strategy.main lifecycle-sync
"""

import argparse
import sys
import json
import os

# Ensure parent packages are importable when run directly
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from trading_agents.wheel_strategy.stock_screener import (
    screen_candidates, format_screen_results
)
from trading_agents.wheel_strategy.backtester import (
    WheelBacktester, backtest_portfolio, format_backtest_results
)
from trading_agents.wheel_strategy.position_manager import PositionManager
from trading_agents.wheel_strategy.discord_alerts import (
    format_scan_results, embed_to_text
)
from trading_agents.wheel_strategy.risk_profiles import (
    get_profile, list_profiles, VALID_MODES
)
from trading_agents.wheel_strategy.trade_journal import TradeJournal
from trading_agents.wheel_strategy.performance_dashboard import WheelDashboard
from trading_agents.wheel_strategy.risk_manager import RiskManager
from trading_agents.wheel_strategy.alpaca_sync import AlpacaSync
from trading_agents.wheel_strategy.performance_tracker import PerformanceTracker
from trading_agents.wheel_strategy.trade_validator import TradeValidator
from trading_agents.wheel_strategy.lifecycle_manager import LifecycleManager


def cmd_scan(args):
    """Screen S&P 500 for best wheel candidates."""
    print("=== Wheel Strategy Stock Screener ===\n")

    # Optionally fetch live data
    hist_data = None
    if args.live:
        try:
            import yfinance as yf
            from trading_agents.wheel_strategy.stock_screener import get_sp500_candidates
            print("Fetching live data (this may take a minute)...")
            candidates = get_sp500_candidates()
            tickers = [c["ticker"] for c in candidates[:args.top * 3]]  # Fetch more than needed
            hist_data = {}
            for ticker in tickers:
                try:
                    df = yf.download(ticker, period="3mo", progress=False, auto_adjust=True)
                    if not df.empty:
                        if hasattr(df.columns, 'levels') and len(df.columns.levels) > 1:
                            df.columns = df.columns.get_level_values(0)
                        hist_data[ticker] = df
                except Exception:
                    pass
            print(f"Fetched data for {len(hist_data)} stocks.\n")
        except ImportError:
            print("yfinance not installed, using approximate scores.\n")

    results = screen_candidates(
        hist_data=hist_data,
        max_results=args.top,
        min_safety=args.safety,
        max_price=args.max_price,
    )

    print(format_screen_results(results))
    print(f"\n{len(results)} candidates found.")

    # Show capital requirements
    if results:
        min_cap = min(r["capital_required"] for r in results)
        max_cap = max(r["capital_required"] for r in results)
        print(f"Capital range: ${min_cap:,.0f} - ${max_cap:,.0f} per contract")

    return results


def cmd_backtest(args):
    """Backtest wheel strategy on a single stock."""
    ticker = args.ticker.upper()
    profile = get_profile(args.mode)

    # Use profile defaults unless explicitly overridden via CLI
    csp_delta = args.csp_delta if args.csp_delta is not None else profile['csp_delta_target']
    cc_delta = args.cc_delta if args.cc_delta is not None else profile['cc_delta_target']
    dte = args.dte if args.dte is not None else profile['target_dte']

    print(f"=== Wheel Strategy Backtest: {ticker} [{profile['name']}] ===")
    print(f"Capital: ${args.capital:,.0f} | Months: {args.months}")
    print(f"CSP Delta: {csp_delta} | CC Delta: {cc_delta} | DTE: {dte}\n")

    try:
        bt = WheelBacktester(
            ticker,
            capital=args.capital,
            csp_delta=csp_delta,
            cc_delta=cc_delta,
            target_dte=dte,
        )
        results = bt.run(months=args.months)
        print(format_backtest_results(results))

        # Save results
        filepath = bt.save_results(results)
        print(f"\nResults saved to: {filepath}")

        # Print trade log if verbose
        if args.verbose:
            print("\n--- Trade Log ---")
            for t in results["trades"]:
                action = t["action"]
                date = t["date"]
                if action in ("SELL_CSP", "SELL_CC"):
                    print(f"  {date} {action}: {t['ticker']} ${t['strike']} "
                          f"@ ${t['premium']:.2f} (delta {t['delta']:.2f})")
                elif action == "ASSIGNED":
                    print(f"  {date} ASSIGNED: {t['ticker']} @ ${t['strike']} "
                          f"(basis ${t['cost_basis']:.2f})")
                elif action == "CALLED_AWAY":
                    print(f"  {date} CALLED_AWAY: {t['ticker']} @ ${t['strike']}")
                elif action == "EXPIRED_OTM":
                    print(f"  {date} EXPIRED_OTM: {t['type']} ${t['strike']} "
                          f"(kept ${t['premium_kept']:.2f})")

        return results

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return None


def cmd_backtest_portfolio(args):
    """Backtest wheel strategy on a diversified portfolio."""
    profile = get_profile(args.mode)

    # Use profile defaults unless explicitly overridden via CLI
    csp_delta = args.csp_delta if args.csp_delta is not None else profile['csp_delta_target']
    cc_delta = args.cc_delta if args.cc_delta is not None else profile['cc_delta_target']
    dte = args.dte if args.dte is not None else profile['target_dte']

    print(f"=== Portfolio Wheel Backtest [{profile['name']}] ===")
    print(f"Capital: ${args.capital:,.0f} | Top {args.top} stocks | {args.months} months")
    print(f"CSP Delta: {csp_delta} | CC Delta: {cc_delta} | DTE: {dte}\n")

    # Use profile tickers if available, otherwise screen
    if args.tickers:
        tickers = args.tickers.split(',')
    else:
        # Screen for candidates first
        results = screen_candidates(max_results=args.top, min_safety="B")
        tickers = [r["ticker"] for r in results]

    print(f"Selected tickers: {', '.join(tickers)}\n")
    print("Running backtests...")

    try:
        portfolio = backtest_portfolio(
            tickers,
            capital=args.capital,
            months=args.months,
            csp_delta=csp_delta,
            cc_delta=cc_delta,
            target_dte=dte,
        )

        print(f"\n=== Portfolio Results ===")
        perf = portfolio["performance"]
        stats = portfolio["trade_stats"]
        print(f"  Initial Capital:    ${args.capital:>12,.2f}")
        print(f"  Final Value:        ${perf['final_value']:>12,.2f}")
        print(f"  Total Return:       {perf['total_return_pct']:>11.2f}%")
        print(f"  Premium Collected:  ${perf['total_premium_collected']:>12,.2f}")
        print(f"  Win Rate:           {stats['win_rate_pct']:>7.1f}%")
        print(f"  Assignments:        {stats['assignments']:>8}")
        print(f"  Called Away:         {stats['called_away']:>8}")

        # Save
        data_dir = os.path.join(SCRIPT_DIR, "data")
        os.makedirs(data_dir, exist_ok=True)
        import datetime
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = os.path.join(data_dir, f"portfolio_backtest_{ts}.json")
        with open(filepath, "w") as f:
            json.dump(portfolio, f, indent=2)
        print(f"\nResults saved to: {filepath}")

        return portfolio

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return None


def cmd_status(args):
    """Show current position status."""
    pm = PositionManager()
    print(pm.format_status())


def cmd_alert(args):
    """Format and display current best plays."""
    results = screen_candidates(max_results=args.top, min_safety="B")

    if not results:
        print("No candidates found.")
        return

    # Format for Discord
    text = format_scan_results(results, top_n=args.top)
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode("ascii", errors="replace").decode("ascii"))

    # Also show detailed CSP analysis for top candidate
    from trading_agents.wheel_strategy.options_pricer import optimal_csp_strike

    print("\n=== Detailed CSP Analysis (Top Candidate) ===\n")
    top = results[0]
    print(f"Ticker: {top['ticker']} ({top['name']})")
    print(f"Price: ${top['price']:.0f} | IV Rank: {top['iv_rank']:.0f}% | "
          f"Safety: {top['safety_rating']}\n")

    csp_strikes = optimal_csp_strike(
        top["price"],
        sigma=top["hist_vol"] * 1.2,
        dte=35,
    )

    print(f"{'Delta':>7} {'Strike':>8} {'OTM%':>6} {'Premium':>9} {'Ann.Ret':>9} {'Breakeven':>10}")
    print("-" * 55)
    for s in csp_strikes:
        print(f"{s['target_delta']:>7.2f} ${s['strike']:>7.0f} {s['otm_pct']:>5.1f}% "
              f"${s['premium']:>8.2f} {s['annualized_return_pct']:>8.1f}% "
              f"${s['breakeven']:>9.2f}")


def cmd_journal(args):
    """Show trade journal data."""
    journal = TradeJournal()

    if args.ticker:
        print(journal.format_journal_discord(args.ticker))
    else:
        print(journal.format_journal_discord())

        # Also show best/worst
        entries = journal.all_entries()
        if entries:
            best, worst = journal.best_worst_stocks()
            if best:
                print("\n=== Best Performers ===")
                for s in best:
                    print(f"  {s['ticker']}: P&L ${s['total_realized_pnl']:,.2f} | "
                          f"WR {s['win_rate']:.0f}% | {s['cycles']} cycles")
            if worst and worst != best:
                print("\n=== Worst Performers ===")
                for s in worst:
                    print(f"  {s['ticker']}: P&L ${s['total_realized_pnl']:,.2f} | "
                          f"WR {s['win_rate']:.0f}% | {s['cycles']} cycles")


def cmd_dashboard(args):
    """Show performance dashboard."""
    dash = WheelDashboard()

    if args.full:
        print(dash.generate_discord_report())
    elif args.greeks:
        print(dash.format_greeks_discord())
    elif args.sectors:
        print(dash.sector_concentration())
    elif args.expiring:
        print(dash.upcoming_expirations(days_ahead=args.days))
    elif args.heatmap:
        print(dash.stock_heatmap())
    elif args.monthly:
        print(dash.monthly_summary())
    else:
        print(dash.weekly_summary())


def cmd_risk(args):
    """Run risk checks and show alerts."""
    rm = RiskManager()

    if args.pre_trade:
        ticker = args.pre_trade.upper()
        strike = args.strike or 100
        approved, reasons = rm.pre_trade_check(ticker, strike)
        if approved:
            print(f"Pre-trade check PASSED for {ticker} ${strike}")
        else:
            print(f"Pre-trade check FAILED for {ticker} ${strike}:")
            for r in reasons:
                print(f"  - {r}")
    else:
        print(rm.format_risk_report())


def main():
    parser = argparse.ArgumentParser(
        description="Wheel Strategy — Automated CSP & CC Income System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Risk Modes:
  safe        Blue-chip income, delta 0.15-0.20, 30-45 DTE, 5 positions
  standard    Balanced mix, delta 0.25-0.30, 14-30 DTE, 7 positions (default)
  aggressive  High IV weeklies, delta 0.35-0.45, 7-14 DTE, 10 positions

Examples:
  python -m trading_agents.wheel_strategy.main scan --top 10
  python -m trading_agents.wheel_strategy.main backtest AAPL --mode safe
  python -m trading_agents.wheel_strategy.main backtest TSLA --mode aggressive --months 6
  python -m trading_agents.wheel_strategy.main backtest-portfolio --mode safe --top 5
  python -m trading_agents.wheel_strategy.main profiles
  python -m trading_agents.wheel_strategy.main status
  python -m trading_agents.wheel_strategy.main alert
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # --- profiles ---
    subparsers.add_parser("profiles", help="Show all risk profiles")

    # --- scan ---
    scan_parser = subparsers.add_parser("scan", help="Screen stocks for wheel candidates")
    scan_parser.add_argument("--top", type=int, default=20, help="Number of results")
    scan_parser.add_argument("--max-price", type=float, default=None, help="Max stock price")
    scan_parser.add_argument("--safety", type=str, default="C", help="Min safety rating (A/B/C/D)")
    scan_parser.add_argument("--live", action="store_true", help="Fetch live data via yfinance")

    # --- backtest ---
    bt_parser = subparsers.add_parser("backtest", help="Backtest wheel on a stock")
    bt_parser.add_argument("ticker", type=str, help="Stock ticker")
    bt_parser.add_argument("--mode", type=str, default="standard", choices=VALID_MODES,
                           help="Risk profile (default: standard)")
    bt_parser.add_argument("--months", type=int, default=12, help="Months to backtest")
    bt_parser.add_argument("--capital", type=float, default=100_000, help="Starting capital")
    bt_parser.add_argument("--csp-delta", type=float, default=None,
                           help="CSP delta target (overrides profile default)")
    bt_parser.add_argument("--cc-delta", type=float, default=None,
                           help="CC delta target (overrides profile default)")
    bt_parser.add_argument("--dte", type=int, default=None,
                           help="Target DTE (overrides profile default)")
    bt_parser.add_argument("--verbose", "-v", action="store_true", help="Show trade log")

    # --- backtest-portfolio ---
    bp_parser = subparsers.add_parser("backtest-portfolio", help="Backtest diversified portfolio")
    bp_parser.add_argument("--mode", type=str, default="standard", choices=VALID_MODES,
                           help="Risk profile (default: standard)")
    bp_parser.add_argument("--top", type=int, default=5, help="Number of stocks")
    bp_parser.add_argument("--months", type=int, default=12, help="Months to backtest")
    bp_parser.add_argument("--capital", type=float, default=100_000, help="Starting capital")
    bp_parser.add_argument("--csp-delta", type=float, default=None,
                           help="CSP delta target (overrides profile default)")
    bp_parser.add_argument("--cc-delta", type=float, default=None,
                           help="CC delta target (overrides profile default)")
    bp_parser.add_argument("--dte", type=int, default=None,
                           help="Target DTE (overrides profile default)")
    bp_parser.add_argument("--tickers", type=str, default=None,
                           help="Comma-separated tickers (overrides screener)")

    # --- status ---
    subparsers.add_parser("status", help="Show current positions")

    # --- alert ---
    alert_parser = subparsers.add_parser("alert", help="Show/post best plays")
    alert_parser.add_argument("--top", type=int, default=5, help="Number of plays")

    # --- journal ---
    journal_parser = subparsers.add_parser("journal", help="Show trade journal")
    journal_parser.add_argument("--ticker", type=str, default=None, help="Filter by ticker")

    # --- dashboard ---
    dash_parser = subparsers.add_parser("dashboard", help="Performance dashboard")
    dash_parser.add_argument("--full", action="store_true", help="Full report")
    dash_parser.add_argument("--greeks", action="store_true", help="Portfolio Greeks")
    dash_parser.add_argument("--sectors", action="store_true", help="Sector concentration")
    dash_parser.add_argument("--expiring", action="store_true", help="Upcoming expirations")
    dash_parser.add_argument("--heatmap", action="store_true", help="Stock heat map")
    dash_parser.add_argument("--monthly", action="store_true", help="Monthly summary")
    dash_parser.add_argument("--days", type=int, default=14, help="Days ahead for expiration check")

    # --- risk ---
    risk_parser = subparsers.add_parser("risk", help="Risk management checks")
    risk_parser.add_argument("--pre-trade", type=str, default=None, help="Pre-trade check for ticker")
    risk_parser.add_argument("--strike", type=float, default=None, help="Strike for pre-trade check")

    # --- alpaca-sync ---
    subparsers.add_parser("alpaca-sync", help="Pull all orders from Alpaca")

    # --- alpaca-account ---
    subparsers.add_parser("alpaca-account", help="Show Alpaca account info")

    # --- alpaca-positions ---
    subparsers.add_parser("alpaca-positions", help="Show Alpaca positions")

    # --- alpaca-reconcile ---
    subparsers.add_parser("alpaca-reconcile", help="Reconcile Alpaca vs internal journal")

    # --- performance ---
    subparsers.add_parser("performance", help="Full performance report from Alpaca")

    # --- monthly ---
    subparsers.add_parser("monthly", help="Monthly income statement")

    # --- weekly-discord ---
    subparsers.add_parser("weekly-discord", help="Discord weekly report")

    # --- snapshot ---
    subparsers.add_parser("snapshot", help="Save daily performance snapshot")

    # --- benchmark ---
    subparsers.add_parser("benchmark", help="Buy & hold comparison")

    # --- validate ---
    val_parser = subparsers.add_parser("validate", help="Pre-trade validation check")
    val_parser.add_argument("ticker", type=str, help="Stock ticker")
    val_parser.add_argument("--strike", type=float, default=None, help="Strike price")
    val_parser.add_argument("--type", dest="option_type", default="put",
                            choices=["put", "call"], help="Option type")
    val_parser.add_argument("--iv-rank", type=float, default=None, help="IV rank (0-100)")
    val_parser.add_argument("--price", type=float, default=None, help="Stock price")
    val_parser.add_argument("--expiry", type=str, default=None, help="Expiry date")

    # --- validation-log ---
    subparsers.add_parser("validation-log", help="Show validation history")

    # --- lifecycle ---
    subparsers.add_parser("lifecycle", help="Show active wheel cycles")

    # --- lifecycle-completed ---
    subparsers.add_parser("lifecycle-completed", help="Show completed wheel cycles")

    # --- lifecycle-sync ---
    subparsers.add_parser("lifecycle-sync", help="Sync lifecycle from Alpaca")

    # --- lifecycle-monitor ---
    subparsers.add_parser("lifecycle-monitor", help="Monitor cycles and generate alerts")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    if args.command == "profiles":
        print(list_profiles())
    elif args.command == "scan":
        cmd_scan(args)
    elif args.command == "backtest":
        cmd_backtest(args)
    elif args.command == "backtest-portfolio":
        cmd_backtest_portfolio(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "alert":
        cmd_alert(args)
    elif args.command == "journal":
        cmd_journal(args)
    elif args.command == "dashboard":
        cmd_dashboard(args)
    elif args.command == "risk":
        cmd_risk(args)

    # --- New production commands ---
    elif args.command == "alpaca-sync":
        sync = AlpacaSync()
        result = sync.pull_option_orders()
        print(f"Pulled {result['total_orders']} orders ({result['option_orders']} options)")

    elif args.command == "alpaca-account":
        sync = AlpacaSync()
        print(sync.format_account_summary())

    elif args.command == "alpaca-positions":
        sync = AlpacaSync()
        print(sync.format_positions_summary())

    elif args.command == "alpaca-reconcile":
        sync = AlpacaSync()
        print(sync.format_reconciliation_report())

    elif args.command == "performance":
        tracker = PerformanceTracker()
        print(tracker.format_full_report())

    elif args.command == "monthly":
        tracker = PerformanceTracker()
        print(tracker.format_monthly_report())

    elif args.command == "weekly-discord":
        tracker = PerformanceTracker()
        print(tracker.format_discord_weekly())

    elif args.command == "snapshot":
        tracker = PerformanceTracker()
        snap = tracker.save_daily_snapshot()
        print(f"Snapshot saved: {json.dumps(snap, indent=2)}")

    elif args.command == "benchmark":
        tracker = PerformanceTracker()
        result = tracker.buy_hold_comparison()
        print(json.dumps(result, indent=2))

    elif args.command == "validate":
        validator = TradeValidator()
        result = validator.validate(
            args.ticker.upper(),
            strike=args.strike,
            option_type=args.option_type,
            iv_rank=args.iv_rank,
            stock_price=args.price,
            expiry=args.expiry,
        )
        print(validator.format_validation_result(result))

    elif args.command == "validation-log":
        validator = TradeValidator()
        print(validator.format_validation_log())

    elif args.command == "lifecycle":
        lm = LifecycleManager()
        print(lm.format_active_status())

    elif args.command == "lifecycle-completed":
        lm = LifecycleManager()
        print(lm.format_completed_summary())

    elif args.command == "lifecycle-sync":
        lm = LifecycleManager()
        result = lm.sync_from_alpaca()
        print(json.dumps(result, indent=2))

    elif args.command == "lifecycle-monitor":
        lm = LifecycleManager()
        alerts = lm.monitor_all()
        if alerts:
            for a in alerts:
                print(f"[{a['severity']}] {a['type']}: {a['message']}")
        else:
            print("No alerts.")


if __name__ == "__main__":
    main()
