"""
Momentum Strategy
=================
Classic trend-following strategies based on price momentum.
Includes multiple variations: MA crossover, breakout, and time-series momentum.
"""

import pandas as pd
import numpy as np
from typing import Dict, Any, Optional
from .base_strategy import BaseStrategy


class MomentumStrategy(BaseStrategy):
    """
    Moving Average Crossover Strategy

    Goes long when fast MA crosses above slow MA.
    Goes short when fast MA crosses below slow MA.
    """

    def __init__(self, fast_period: int = 10, slow_period: int = 30,
                 use_ema: bool = False, trend_filter: bool = True,
                 trend_period: int = 200):
        super().__init__(name="MomentumStrategy")
        self.fast_period = fast_period
        self.slow_period = slow_period
        self.use_ema = use_ema
        self.trend_filter = trend_filter
        self.trend_period = trend_period

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        close = data['close']

        # Calculate moving averages
        if self.use_ema:
            fast_ma = close.ewm(span=self.fast_period, adjust=False).mean()
            slow_ma = close.ewm(span=self.slow_period, adjust=False).mean()
        else:
            fast_ma = close.rolling(self.fast_period).mean()
            slow_ma = close.rolling(self.slow_period).mean()

        # Generate base signals
        signals = pd.Series(0, index=data.index)
        signals[fast_ma > slow_ma] = 1
        signals[fast_ma < slow_ma] = -1

        # Optional: Only trade in direction of major trend
        if self.trend_filter:
            trend_ma = close.rolling(self.trend_period).mean()
            # Only go long if above 200 MA
            signals[(signals == 1) & (close < trend_ma)] = 0
            # Only go short if below 200 MA
            signals[(signals == -1) & (close > trend_ma)] = 0

        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'fast_period': self.fast_period,
            'slow_period': self.slow_period,
            'use_ema': self.use_ema,
            'trend_filter': self.trend_filter,
            'trend_period': self.trend_period
        }

    def get_required_history(self) -> int:
        return max(self.slow_period, self.trend_period) + 10


class BreakoutStrategy(BaseStrategy):
    """
    Donchian Channel Breakout Strategy

    Goes long when price breaks above the highest high of lookback period.
    Goes short when price breaks below the lowest low of lookback period.
    """

    def __init__(self, entry_period: int = 20, exit_period: int = 10,
                 use_atr_filter: bool = True, atr_threshold: float = 1.5):
        super().__init__(name="BreakoutStrategy")
        self.entry_period = entry_period
        self.exit_period = exit_period
        self.use_atr_filter = use_atr_filter
        self.atr_threshold = atr_threshold

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        high = data['high']
        low = data['low']
        close = data['close']

        # Donchian Channels
        upper_entry = high.rolling(self.entry_period).max()
        lower_entry = low.rolling(self.entry_period).min()
        upper_exit = high.rolling(self.exit_period).max()
        lower_exit = low.rolling(self.exit_period).min()

        # ATR for volatility filter
        if self.use_atr_filter:
            tr = pd.concat([
                high - low,
                (high - close.shift()).abs(),
                (low - close.shift()).abs()
            ], axis=1).max(axis=1)
            atr = tr.rolling(14).mean()
            atr_ratio = atr / close
            volatility_ok = atr_ratio > (atr_ratio.rolling(100).mean() * self.atr_threshold)
        else:
            volatility_ok = pd.Series(True, index=data.index)

        # Generate signals
        signals = pd.Series(0, index=data.index)

        # Entry signals
        long_entry = (close > upper_entry.shift(1)) & volatility_ok
        short_entry = (close < lower_entry.shift(1)) & volatility_ok

        # Exit signals
        long_exit = close < lower_exit.shift(1)
        short_exit = close > upper_exit.shift(1)

        # Build signal series
        position = 0
        signal_list = []

        for i in range(len(data)):
            if position == 0:
                if long_entry.iloc[i]:
                    position = 1
                elif short_entry.iloc[i]:
                    position = -1
            elif position == 1:
                if long_exit.iloc[i]:
                    position = 0
            elif position == -1:
                if short_exit.iloc[i]:
                    position = 0
            signal_list.append(position)

        signals = pd.Series(signal_list, index=data.index)
        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'entry_period': self.entry_period,
            'exit_period': self.exit_period,
            'use_atr_filter': self.use_atr_filter,
            'atr_threshold': self.atr_threshold
        }


class TimeSeriesMomentumStrategy(BaseStrategy):
    """
    Time-Series Momentum (TSMOM)

    Classic momentum strategy that goes long assets with positive returns
    over lookback period, short assets with negative returns.
    Often used for managed futures / trend following.
    """

    def __init__(self, lookback: int = 252, volatility_lookback: int = 20,
                 target_volatility: float = 0.15, min_holding_period: int = 21):
        super().__init__(name="TimeSeriesMomentumStrategy")
        self.lookback = lookback
        self.volatility_lookback = volatility_lookback
        self.target_volatility = target_volatility
        self.min_holding_period = min_holding_period

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        close = data['close']
        returns = close.pct_change()

        # Calculate momentum signal
        momentum = close / close.shift(self.lookback) - 1

        # Calculate volatility for sizing
        volatility = returns.rolling(self.volatility_lookback).std() * np.sqrt(252)

        # Generate base signals
        signals = pd.Series(0.0, index=data.index)
        signals[momentum > 0] = 1.0
        signals[momentum < 0] = -1.0

        # Scale by inverse volatility (target vol / realized vol)
        vol_scalar = self.target_volatility / volatility.clip(lower=0.05)
        signals = signals * vol_scalar.clip(upper=2.0)

        # Discretize to -1, 0, 1
        final_signals = pd.Series(0, index=data.index)
        final_signals[signals > 0.3] = 1
        final_signals[signals < -0.3] = -1

        return final_signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'lookback': self.lookback,
            'volatility_lookback': self.volatility_lookback,
            'target_volatility': self.target_volatility,
            'min_holding_period': self.min_holding_period
        }


class DualMomentumStrategy(BaseStrategy):
    """
    Dual Momentum Strategy (Gary Antonacci)

    Combines absolute momentum (time-series) with relative momentum (cross-sectional).
    Only goes long when both signals agree.
    """

    def __init__(self, lookback: int = 252, benchmark_symbol: str = 'SPY'):
        super().__init__(name="DualMomentumStrategy")
        self.lookback = lookback
        self.benchmark_symbol = benchmark_symbol
        self._benchmark_returns = None

    def set_benchmark(self, benchmark_data: pd.DataFrame) -> None:
        """Set benchmark data for relative momentum calculation"""
        self._benchmark_returns = benchmark_data['close'].pct_change()

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        close = data['close']

        # Absolute momentum: Is the asset trending up?
        absolute_momentum = close / close.shift(self.lookback) - 1

        # Relative momentum: Is the asset outperforming the benchmark?
        if self._benchmark_returns is not None:
            asset_returns = close.pct_change().rolling(self.lookback).sum()
            bench_returns = self._benchmark_returns.rolling(self.lookback).sum()

            # Align indices
            bench_returns = bench_returns.reindex(data.index, method='ffill')
            relative_momentum = asset_returns - bench_returns
        else:
            # If no benchmark, use only absolute momentum
            relative_momentum = absolute_momentum

        # Generate signals
        signals = pd.Series(0, index=data.index)

        # Long only when both absolute AND relative momentum are positive
        long_condition = (absolute_momentum > 0) & (relative_momentum > 0)
        signals[long_condition] = 1

        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'lookback': self.lookback,
            'benchmark_symbol': self.benchmark_symbol
        }


# Quick usage example
if __name__ == "__main__":
    import yfinance as yf

    # Download sample data
    data = yf.download("AAPL", start="2020-01-01", end="2024-01-01")
    data.columns = data.columns.str.lower()

    # Test momentum strategy
    strategy = MomentumStrategy(fast_period=10, slow_period=30)
    signals = strategy.generate_signals(data)

    print(f"Strategy: {strategy}")
    print(f"Signal distribution:\n{signals.value_counts()}")
    print(f"\nFirst 10 signals:\n{signals.head(10)}")
