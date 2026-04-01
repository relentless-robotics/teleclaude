#!/usr/bin/env python3
"""Quick portfolio backtest for wheel strategy validation."""
import sys, os, json
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from trading_agents.wheel_strategy.backtester import WheelBacktester

# Stocks practical for $100K capital (price < $200 for CSP collateral)
tickers = ['AAPL', 'T', 'CVX', 'KO', 'JNJ', 'AMZN', 'NEE', 'BAC', 'INTC', 'CSCO', 'PFE', 'CL']
results = []

for t in tickers:
    try:
        bt = WheelBacktester(t, capital=100000, csp_delta=0.25, cc_delta=0.30, target_dte=35)
        r = bt.run(months=12)
        p = r['performance']
        s = r['trade_stats']
        results.append({
            'ticker': t,
            'return_pct': p['total_return_pct'],
            'premium': p['total_premium_collected'],
            'sharpe': p['sharpe_ratio'],
            'max_dd': p['max_drawdown_pct'],
            'win_rate': s['win_rate_pct'],
            'cycles': s['total_option_cycles'],
            'assignments': s['assignments'],
            'bh_return': r['benchmark']['buy_hold_return_pct'],
            'wheel_vs_bh': r['benchmark']['wheel_vs_bnh_pct'],
        })
        prem = p['total_premium_collected']
        bh = r['benchmark']['buy_hold_return_pct']
        print(f"{t:5s}: {p['total_return_pct']:+6.1f}% | WR={s['win_rate_pct']:5.1f}% | "
              f"Sharpe={p['sharpe_ratio']:+5.2f} | DD={p['max_drawdown_pct']:5.1f}% | "
              f"Prem=${prem:,.0f} | B&H={bh:+.1f}%")
    except Exception as e:
        print(f"{t:5s}: ERROR - {str(e)[:60]}")

if results:
    avg_ret = np.mean([r['return_pct'] for r in results])
    avg_sharpe = np.mean([r['sharpe'] for r in results])
    avg_wr = np.mean([r['win_rate'] for r in results])
    avg_dd = np.mean([r['max_dd'] for r in results])
    total_prem = sum(r['premium'] for r in results)
    avg_bh = np.mean([r['bh_return'] for r in results])
    print()
    print(f"AVERAGE: {avg_ret:+6.1f}% | WR={avg_wr:5.1f}% | Sharpe={avg_sharpe:+5.2f} | DD={avg_dd:5.1f}%")
    print(f"Total premium collected: ${total_prem:,.0f}")
    print(f"B&H average: {avg_bh:+6.1f}%")
    print(f"Wheel outperformance: {avg_ret - avg_bh:+6.1f}%")

    # Save
    data_dir = os.path.join(os.path.dirname(__file__), 'data')
    os.makedirs(data_dir, exist_ok=True)
    from datetime import datetime
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    with open(os.path.join(data_dir, f'portfolio_test_{ts}.json'), 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved to data/portfolio_test_{ts}.json")
