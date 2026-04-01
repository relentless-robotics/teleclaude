#!/usr/bin/env python3
"""Parameter sweep for wheel strategy optimization."""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from trading_agents.wheel_strategy.backtester import WheelBacktester
import json
from datetime import datetime

TICKERS = ['AAPL', 'AMZN', 'MSFT', 'T', 'CVX', 'META', 'NEE', 'CL']

CONFIGS = [
    {'csp_delta': 0.25, 'cc_delta': 0.30, 'target_dte': 45, 'label': 'Conservative 45DTE'},
    {'csp_delta': 0.25, 'cc_delta': 0.30, 'target_dte': 35, 'label': 'Conservative 35DTE'},
    {'csp_delta': 0.30, 'cc_delta': 0.35, 'target_dte': 30, 'label': 'Moderate 30DTE'},
    {'csp_delta': 0.30, 'cc_delta': 0.35, 'target_dte': 21, 'label': 'Moderate Weekly-ish'},
    {'csp_delta': 0.35, 'cc_delta': 0.40, 'target_dte': 21, 'label': 'Aggressive 21DTE'},
    {'csp_delta': 0.35, 'cc_delta': 0.40, 'target_dte': 14, 'label': 'Aggressive 14DTE'},
    {'csp_delta': 0.40, 'cc_delta': 0.45, 'target_dte': 7, 'label': 'Ultra-aggressive Weekly'},
]


def main():
    print("WHEEL STRATEGY PARAMETER SWEEP")
    print("=" * 100)

    all_results = []

    for cfg in CONFIGS:
        label = cfg['label']
        print(f"\n--- {label}: CSP d={cfg['csp_delta']}, CC d={cfg['cc_delta']}, DTE={cfg['target_dte']} ---")

        ticker_results = []
        for ticker in TICKERS:
            try:
                bt = WheelBacktester(
                    ticker, capital=100_000,
                    csp_delta=cfg['csp_delta'],
                    cc_delta=cfg['cc_delta'],
                    target_dte=cfg['target_dte'],
                )
                result = bt.run(months=12)
                perf = result['performance']
                stats = result['trade_stats']

                r = {
                    'ticker': ticker,
                    'return_pct': perf['total_return_pct'],
                    'annualized': perf['annualized_return_pct'],
                    'premium': perf['total_premium_collected'],
                    'sharpe': perf['sharpe_ratio'],
                    'max_dd': perf['max_drawdown_pct'],
                    'win_rate': stats['win_rate_pct'],
                    'cycles': stats['total_option_cycles'],
                    'assignments': stats['assignments'],
                }
                ticker_results.append(r)

                print(f"  {ticker:5s}: {r['return_pct']:+6.1f}% | WR={r['win_rate']:5.1f}% | "
                      f"{r['cycles']:2d} cycles | assign={r['assignments']} | "
                      f"Sharpe={r['sharpe']:.2f} | DD={r['max_dd']:.1f}%")

            except Exception as e:
                print(f"  {ticker:5s}: ERROR - {str(e)[:60]}")

        if ticker_results:
            import numpy as np
            avg_ret = np.mean([r['return_pct'] for r in ticker_results])
            avg_sharpe = np.mean([r['sharpe'] for r in ticker_results])
            avg_wr = np.mean([r['win_rate'] for r in ticker_results])
            avg_dd = np.mean([r['max_dd'] for r in ticker_results])
            total_prem = sum(r['premium'] for r in ticker_results)

            print(f"  {'AVG':5s}: {avg_ret:+6.1f}% | WR={avg_wr:5.1f}% | "
                  f"Sharpe={avg_sharpe:.2f} | DD={avg_dd:.1f}% | "
                  f"Total premium=${total_prem:,.0f}")

            all_results.append({
                'config': cfg,
                'avg_return': round(avg_ret, 2),
                'avg_sharpe': round(avg_sharpe, 2),
                'avg_win_rate': round(avg_wr, 1),
                'avg_max_dd': round(avg_dd, 2),
                'total_premium': round(total_prem, 2),
                'tickers': ticker_results,
            })

    # Sort by avg return
    all_results.sort(key=lambda x: x['avg_return'], reverse=True)

    print("\n\n" + "=" * 100)
    print("SUMMARY — Sorted by Average Return")
    print("=" * 100)
    for r in all_results:
        cfg = r['config']
        print(f"  {cfg['label']:30s} | Return={r['avg_return']:+6.1f}% | "
              f"Sharpe={r['avg_sharpe']:+5.2f} | WR={r['avg_win_rate']:5.1f}% | "
              f"DD={r['avg_max_dd']:+6.1f}% | Premium=${r['total_premium']:,.0f}")

    # Save
    data_dir = os.path.join(os.path.dirname(__file__), 'data')
    os.makedirs(data_dir, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    outfile = os.path.join(data_dir, f'param_sweep_{ts}.json')
    with open(outfile, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nSaved to {outfile}")


if __name__ == '__main__':
    main()
