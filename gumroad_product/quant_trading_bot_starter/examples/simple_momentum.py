"""
Simple Momentum Strategy Example
================================
Quick start example showing how to backtest a basic momentum strategy.

Run with: python -m examples.simple_momentum
"""

import sys
sys.path.insert(0, '..')

from data.fetcher import download_data
from strategies.momentum import MomentumStrategy
from backtest.engine import BacktestEngine, BacktestConfig
from backtest.metrics import print_performance_report
import matplotlib.pyplot as plt


def main():
    print("=" * 60)
    print("Simple Momentum Strategy Backtest")
    print("=" * 60)

    # 1. Download data
    print("\n[1] Downloading AAPL data...")
    data = download_data("AAPL", start="2018-01-01", end="2024-01-01")
    print(f"    Downloaded {len(data)} bars")

    # 2. Create strategy
    print("\n[2] Creating momentum strategy...")
    strategy = MomentumStrategy(
        fast_period=10,
        slow_period=30,
        trend_filter=True,
        trend_period=200
    )
    print(f"    Strategy: {strategy}")

    # 3. Configure backtest
    print("\n[3] Configuring backtest...")
    config = BacktestConfig(
        initial_capital=100000,
        commission=0.001,  # 0.1%
        slippage=0.0005    # 0.05%
    )

    # 4. Run backtest
    print("\n[4] Running backtest...")
    engine = BacktestEngine(config)
    result = engine.run(strategy, data)

    # 5. Print results
    print_performance_report(result.metrics, "Momentum Strategy")

    # 6. Plot results
    print("\n[6] Generating plots...")
    fig, axes = plt.subplots(3, 1, figsize=(12, 10))

    # Equity curve
    axes[0].plot(result.equity_curve, label='Strategy', linewidth=1.5)
    axes[0].axhline(y=config.initial_capital, color='gray', linestyle='--', alpha=0.5)
    axes[0].set_title('Equity Curve')
    axes[0].set_ylabel('Portfolio Value ($)')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Drawdown
    axes[1].fill_between(result.drawdown_series.index,
                        result.drawdown_series.values * 100,
                        0, alpha=0.5, color='red')
    axes[1].set_title('Drawdown')
    axes[1].set_ylabel('Drawdown (%)')
    axes[1].grid(True, alpha=0.3)

    # Monthly returns
    monthly = result.monthly_returns * 100
    colors = ['green' if x >= 0 else 'red' for x in monthly.values]
    axes[2].bar(monthly.index, monthly.values, color=colors, alpha=0.7)
    axes[2].set_title('Monthly Returns')
    axes[2].set_ylabel('Return (%)')
    axes[2].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('momentum_backtest_results.png', dpi=150)
    print("    Saved: momentum_backtest_results.png")

    # 7. Trade summary
    print("\n[7] Trade Summary:")
    print(f"    Total trades: {len(result.trades)}")
    if result.trades:
        winning = [t for t in result.trades if t.pnl > 0]
        losing = [t for t in result.trades if t.pnl <= 0]
        print(f"    Winning trades: {len(winning)}")
        print(f"    Losing trades: {len(losing)}")
        print(f"    Avg holding period: {result.metrics.avg_holding_period:.1f} days")

    print("\n" + "=" * 60)
    print("Backtest complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
