#!/usr/bin/env python3
"""
Realistic $100K portfolio wheel strategy backtest.
- $100K TOTAL capital split across positions
- Weekly 7DTE cycles targeting 1-2% weekly yield
- Tracks weekly premium yield on deployed capital
"""
import sys, os, json
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from trading_agents.wheel_strategy.backtester import WheelBacktester

# Stocks under $100 so we can fit multiple in $100K
# High-IV preferred for better premiums
TICKERS = ['T', 'INTC', 'PFE', 'BAC', 'CSCO', 'KO', 'F', 'SNAP', 'PLTR', 'SOFI']

CONFIGS = [
    {'label': 'Weekly Aggressive (0.35d, 7DTE)', 'csp_delta': 0.35, 'cc_delta': 0.40, 'target_dte': 7},
    {'label': 'Weekly Moderate (0.30d, 7DTE)', 'csp_delta': 0.30, 'cc_delta': 0.35, 'target_dte': 7},
    {'label': 'Biweekly (0.30d, 14DTE)', 'csp_delta': 0.30, 'cc_delta': 0.35, 'target_dte': 14},
    {'label': 'Monthly (0.25d, 30DTE)', 'csp_delta': 0.25, 'cc_delta': 0.30, 'target_dte': 30},
]

TOTAL_CAPITAL = 100_000
MAX_POSITIONS = 5  # Max 5 positions at a time
MAX_PER_POSITION_PCT = 0.25  # Max 25% per position

def run_portfolio_backtest(tickers, config, months=12):
    """Run a portfolio backtest with capital constraints."""
    results = []
    capital_per_position = min(
        TOTAL_CAPITAL / min(len(tickers), MAX_POSITIONS),
        TOTAL_CAPITAL * MAX_PER_POSITION_PCT
    )

    positions_used = 0
    total_deployed = 0

    for t in tickers:
        if positions_used >= MAX_POSITIONS:
            break

        try:
            bt = WheelBacktester(
                t,
                capital=capital_per_position,
                csp_delta=config['csp_delta'],
                cc_delta=config['cc_delta'],
                target_dte=config['target_dte'],
            )
            r = bt.run(months=months)
            p = r['performance']
            s = r['trade_stats']
            bm = r['benchmark']

            # Skip if couldn't trade (stock too expensive for allocated capital)
            if s['total_option_cycles'] == 0:
                continue

            premium = p['total_premium_collected']
            cycles = s['total_option_cycles']
            weeks = months * 4.33

            # Weekly yield on deployed capital
            weekly_yield = (premium / capital_per_position) / weeks * 100

            results.append({
                'ticker': t,
                'capital': capital_per_position,
                'return_pct': p['total_return_pct'],
                'premium': premium,
                'weekly_yield_pct': weekly_yield,
                'annual_yield_pct': weekly_yield * 52,
                'sharpe': p['sharpe_ratio'],
                'max_dd': p['max_drawdown_pct'],
                'win_rate': s['win_rate_pct'],
                'cycles': cycles,
                'assignments': s['assignments'],
                'bh_return': bm['buy_hold_return_pct'],
            })
            positions_used += 1
            total_deployed += capital_per_position

        except Exception as e:
            pass

    return results, total_deployed


def main():
    print("=" * 90)
    print("REALISTIC $100K PORTFOLIO WHEEL STRATEGY BACKTEST")
    print(f"Total Capital: ${TOTAL_CAPITAL:,} | Max Positions: {MAX_POSITIONS} | Max/Position: {MAX_PER_POSITION_PCT*100:.0f}%")
    print("=" * 90)

    all_config_results = []

    for config in CONFIGS:
        print(f"\n--- {config['label']} ---")
        print(f"CSP delta={config['csp_delta']}, CC delta={config['cc_delta']}, DTE={config['target_dte']}")

        results, deployed = run_portfolio_backtest(TICKERS, config, months=12)

        if not results:
            print("  No positions could be opened.")
            continue

        print(f"\n  {'Ticker':6s} {'Capital':>10s} {'Return':>8s} {'Premium':>10s} {'Wk Yield':>9s} {'Ann Yield':>10s} {'WR':>6s} {'Sharpe':>7s} {'Cycles':>7s}")
        print(f"  {'-'*75}")

        total_premium = 0
        total_return_weighted = 0

        for r in results:
            print(f"  {r['ticker']:6s} ${r['capital']:>8,.0f} {r['return_pct']:>+7.1f}% ${r['premium']:>9,.0f} "
                  f"{r['weekly_yield_pct']:>8.2f}% {r['annual_yield_pct']:>9.1f}% "
                  f"{r['win_rate']:>5.1f}% {r['sharpe']:>+6.2f} {r['cycles']:>6d}")
            total_premium += r['premium']
            total_return_weighted += r['return_pct'] * r['capital']

        portfolio_return = total_return_weighted / deployed if deployed > 0 else 0
        weeks = 52
        portfolio_weekly_yield = (total_premium / deployed) / weeks * 100 if deployed > 0 else 0
        avg_sharpe = np.mean([r['sharpe'] for r in results])
        avg_wr = np.mean([r['win_rate'] for r in results])
        avg_dd = np.mean([r['max_dd'] for r in results])

        print(f"\n  PORTFOLIO SUMMARY:")
        print(f"    Capital deployed: ${deployed:,.0f} of ${TOTAL_CAPITAL:,.0f} ({deployed/TOTAL_CAPITAL*100:.0f}%)")
        print(f"    Total premium collected: ${total_premium:,.0f}")
        print(f"    Portfolio return: {portfolio_return:+.2f}%")
        print(f"    Weekly yield on deployed: {portfolio_weekly_yield:.2f}%")
        print(f"    Annualized yield: {portfolio_weekly_yield * 52:.1f}%")
        print(f"    Avg win rate: {avg_wr:.1f}% | Avg Sharpe: {avg_sharpe:.2f} | Avg max DD: {avg_dd:.1f}%")

        all_config_results.append({
            'config': config,
            'positions': len(results),
            'deployed': deployed,
            'total_premium': total_premium,
            'portfolio_return': round(portfolio_return, 2),
            'weekly_yield': round(portfolio_weekly_yield, 3),
            'annual_yield': round(portfolio_weekly_yield * 52, 1),
            'avg_sharpe': round(avg_sharpe, 2),
            'avg_win_rate': round(avg_wr, 1),
            'avg_max_dd': round(avg_dd, 2),
            'results': results,
        })

    # Summary comparison
    print("\n" + "=" * 90)
    print("CONFIG COMPARISON")
    print("=" * 90)
    print(f"{'Config':40s} {'Deploy':>8s} {'Premium':>10s} {'Wk%':>6s} {'Ann%':>7s} {'WR':>6s} {'Sharpe':>7s}")
    print("-" * 85)
    for cr in all_config_results:
        c = cr['config']
        print(f"{c['label']:40s} ${cr['deployed']:>7,.0f} ${cr['total_premium']:>9,.0f} "
              f"{cr['weekly_yield']:>5.2f}% {cr['annual_yield']:>6.1f}% "
              f"{cr['avg_win_rate']:>5.1f}% {cr['avg_sharpe']:>+6.2f}")

    # Save
    data_dir = os.path.join(os.path.dirname(__file__), 'data')
    os.makedirs(data_dir, exist_ok=True)
    from datetime import datetime
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    outfile = os.path.join(data_dir, f'realistic_portfolio_{ts}.json')
    with open(outfile, 'w') as f:
        json.dump(all_config_results, f, indent=2, default=str)
    print(f"\nSaved to {outfile}")


if __name__ == '__main__':
    main()
