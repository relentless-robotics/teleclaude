"""
Portfolio Rebalancing Strategy Example
======================================
Shows how to backtest a multi-asset portfolio strategy.

Run with: python -m examples.portfolio_rebalance
"""

import sys
sys.path.insert(0, '..')

import pandas as pd
import numpy as np
from typing import Dict

from data.fetcher import download_data
from strategies.base_strategy import BaseStrategy
from backtest.engine import BacktestEngine, BacktestConfig, MultiAssetBacktester
from backtest.metrics import print_performance_report
import matplotlib.pyplot as plt


class SimpleRotationStrategy(BaseStrategy):
    """
    Simple sector rotation strategy.

    Goes long the top N performing assets over lookback period.
    Rebalances monthly.
    """

    def __init__(self, lookback: int = 63, top_n: int = 3):
        super().__init__(name="RotationStrategy")
        self.lookback = lookback
        self.top_n = top_n

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        """For single asset, always long"""
        return pd.Series(1, index=data.index)

    def rank_assets(self, price_data: Dict[str, pd.DataFrame]) -> pd.DataFrame:
        """
        Rank assets by momentum.

        Returns DataFrame with rankings over time.
        """
        # Get close prices
        closes = pd.DataFrame({
            sym: df['close'] for sym, df in price_data.items()
        })

        # Calculate momentum (return over lookback)
        momentum = closes.pct_change(self.lookback)

        # Rank (higher momentum = lower rank number)
        rankings = momentum.rank(axis=1, ascending=False)

        return rankings

    def get_weights(self, rankings: pd.Series) -> Dict[str, float]:
        """Get target weights based on rankings"""
        weights = {}
        top_assets = rankings[rankings <= self.top_n].index.tolist()

        for asset in rankings.index:
            if asset in top_assets:
                weights[asset] = 1.0 / self.top_n
            else:
                weights[asset] = 0.0

        return weights


def main():
    print("=" * 60)
    print("Portfolio Rebalancing Strategy Backtest")
    print("=" * 60)

    # 1. Define portfolio
    symbols = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD"]
    print(f"\n[1] Portfolio: {symbols}")

    # 2. Download data
    print("\n[2] Downloading data...")
    data_dict = download_data(symbols, start="2015-01-01", end="2024-01-01")
    print(f"    Downloaded {len(data_dict)} assets")

    # 3. Create price panel
    closes = pd.DataFrame({
        sym: df['close'] for sym, df in data_dict.items()
    }).dropna()

    print(f"    Common date range: {closes.index[0]} to {closes.index[-1]}")

    # 4. Create strategy
    strategy = SimpleRotationStrategy(lookback=63, top_n=3)
    print(f"\n[3] Strategy: {strategy.name}")
    print(f"    Lookback: {strategy.lookback} days")
    print(f"    Top N assets: {strategy.top_n}")

    # 5. Run simulation
    print("\n[4] Running simulation...")

    # Initialize
    initial_capital = 100000
    capital = initial_capital
    positions = {sym: 0 for sym in symbols}
    equity_history = []
    rebalance_dates = []

    # Monthly rebalancing
    monthly_dates = closes.resample('ME').last().index

    for i, date in enumerate(closes.index):
        # Calculate current equity
        current_equity = capital
        for sym, shares in positions.items():
            if shares > 0:
                current_equity += shares * closes.loc[date, sym]

        equity_history.append({'date': date, 'equity': current_equity})

        # Rebalance at month end
        if date in monthly_dates and i >= strategy.lookback:
            rebalance_dates.append(date)

            # Get rankings
            lookback_data = closes.loc[:date].tail(strategy.lookback + 1)
            momentum = lookback_data.iloc[-1] / lookback_data.iloc[0] - 1
            rankings = momentum.rank(ascending=False)

            # Get target weights
            target_weights = strategy.get_weights(rankings)

            # Calculate target positions
            for sym in symbols:
                target_value = current_equity * target_weights[sym]
                current_shares = positions[sym]
                current_price = closes.loc[date, sym]

                # Target shares
                target_shares = int(target_value / current_price)

                # Calculate trade
                trade_shares = target_shares - current_shares

                if trade_shares != 0:
                    # Update position
                    positions[sym] = target_shares
                    # Update cash (simplified - no transaction costs)
                    capital -= trade_shares * current_price

    # Create equity curve
    equity_df = pd.DataFrame(equity_history).set_index('date')
    equity_curve = equity_df['equity']

    # Calculate returns and metrics
    returns = equity_curve.pct_change().dropna()

    # Benchmark (equal weight buy and hold)
    equal_weight = closes.pct_change().mean(axis=1)
    benchmark_equity = initial_capital * (1 + equal_weight).cumprod()

    # 6. Print results
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)

    total_return = (equity_curve.iloc[-1] / initial_capital) - 1
    annual_return = (1 + total_return) ** (252 / len(returns)) - 1
    volatility = returns.std() * np.sqrt(252)
    sharpe = annual_return / volatility if volatility > 0 else 0

    max_dd = (equity_curve / equity_curve.cummax() - 1).min()

    print(f"\nRotation Strategy:")
    print(f"  Total Return:    {total_return:>10.2%}")
    print(f"  Annual Return:   {annual_return:>10.2%}")
    print(f"  Volatility:      {volatility:>10.2%}")
    print(f"  Sharpe Ratio:    {sharpe:>10.2f}")
    print(f"  Max Drawdown:    {max_dd:>10.2%}")
    print(f"  Rebalances:      {len(rebalance_dates):>10}")

    # Benchmark stats
    bench_return = (benchmark_equity.iloc[-1] / initial_capital) - 1
    bench_vol = equal_weight.std() * np.sqrt(252)

    print(f"\nBenchmark (Equal Weight):")
    print(f"  Total Return:    {bench_return:>10.2%}")
    print(f"  Volatility:      {bench_vol:>10.2%}")

    # 7. Plot results
    print("\n[5] Generating plots...")
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    # Equity curves
    axes[0, 0].plot(equity_curve, label='Rotation Strategy', linewidth=1.5)
    axes[0, 0].plot(benchmark_equity, label='Equal Weight', linewidth=1.5, alpha=0.7)
    axes[0, 0].set_title('Equity Curves')
    axes[0, 0].set_ylabel('Portfolio Value ($)')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Drawdown
    drawdown = (equity_curve / equity_curve.cummax() - 1) * 100
    axes[0, 1].fill_between(drawdown.index, drawdown.values, 0, alpha=0.5, color='red')
    axes[0, 1].set_title('Drawdown')
    axes[0, 1].set_ylabel('Drawdown (%)')
    axes[0, 1].grid(True, alpha=0.3)

    # Asset performance
    asset_returns = (closes.iloc[-1] / closes.iloc[0] - 1) * 100
    colors = ['green' if x >= 0 else 'red' for x in asset_returns.values]
    axes[1, 0].bar(asset_returns.index, asset_returns.values, color=colors, alpha=0.7)
    axes[1, 0].set_title('Asset Total Returns')
    axes[1, 0].set_ylabel('Return (%)')
    axes[1, 0].grid(True, alpha=0.3)

    # Rolling Sharpe
    rolling_sharpe = (returns.rolling(252).mean() / returns.rolling(252).std()) * np.sqrt(252)
    axes[1, 1].plot(rolling_sharpe, linewidth=1.5)
    axes[1, 1].axhline(y=0, color='gray', linestyle='--', alpha=0.5)
    axes[1, 1].set_title('Rolling 1-Year Sharpe Ratio')
    axes[1, 1].set_ylabel('Sharpe Ratio')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('portfolio_rotation_results.png', dpi=150)
    print("    Saved: portfolio_rotation_results.png")

    print("\n" + "=" * 60)
    print("Backtest complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
