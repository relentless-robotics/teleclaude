"""
Mean Reversion Strategies
=========================
Strategies that bet on prices reverting to their mean.
Works well for range-bound markets and pairs trading.
"""

import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional, Tuple
from .base_strategy import BaseStrategy


class MeanReversionStrategy(BaseStrategy):
    """
    Bollinger Bands Mean Reversion

    Goes long when price drops below lower band (oversold).
    Goes short when price rises above upper band (overbought).
    Exits when price returns to the mean.
    """

    def __init__(self, lookback: int = 20, num_std: float = 2.0,
                 entry_threshold: float = 1.0, exit_threshold: float = 0.0):
        super().__init__(name="MeanReversionStrategy")
        self.lookback = lookback
        self.num_std = num_std
        self.entry_threshold = entry_threshold
        self.exit_threshold = exit_threshold

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        close = data['close']

        # Calculate Bollinger Bands
        middle = close.rolling(self.lookback).mean()
        std = close.rolling(self.lookback).std()

        upper = middle + (std * self.num_std)
        lower = middle - (std * self.num_std)

        # Calculate z-score
        zscore = (close - middle) / std

        # Generate signals
        signals = pd.Series(0, index=data.index)

        # Entry: Beyond bands
        signals[zscore < -self.entry_threshold] = 1   # Oversold -> Long
        signals[zscore > self.entry_threshold] = -1   # Overbought -> Short

        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'lookback': self.lookback,
            'num_std': self.num_std,
            'entry_threshold': self.entry_threshold,
            'exit_threshold': self.exit_threshold
        }


class RSIMeanReversion(BaseStrategy):
    """
    RSI-based Mean Reversion

    Goes long when RSI indicates oversold conditions.
    Goes short when RSI indicates overbought conditions.
    """

    def __init__(self, rsi_period: int = 14, oversold: int = 30,
                 overbought: int = 70, exit_middle: int = 50):
        super().__init__(name="RSIMeanReversion")
        self.rsi_period = rsi_period
        self.oversold = oversold
        self.overbought = overbought
        self.exit_middle = exit_middle

    def _calculate_rsi(self, prices: pd.Series) -> pd.Series:
        """Calculate Relative Strength Index"""
        delta = prices.diff()

        gain = delta.where(delta > 0, 0)
        loss = -delta.where(delta < 0, 0)

        avg_gain = gain.rolling(window=self.rsi_period).mean()
        avg_loss = loss.rolling(window=self.rsi_period).mean()

        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

        return rsi

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        close = data['close']
        rsi = self._calculate_rsi(close)

        # Generate signals with state tracking
        signals = pd.Series(0, index=data.index)
        position = 0

        for i in range(len(data)):
            if pd.isna(rsi.iloc[i]):
                signals.iloc[i] = 0
                continue

            if position == 0:
                if rsi.iloc[i] < self.oversold:
                    position = 1
                elif rsi.iloc[i] > self.overbought:
                    position = -1
            elif position == 1:
                if rsi.iloc[i] > self.exit_middle:
                    position = 0
            elif position == -1:
                if rsi.iloc[i] < self.exit_middle:
                    position = 0

            signals.iloc[i] = position

        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'rsi_period': self.rsi_period,
            'oversold': self.oversold,
            'overbought': self.overbought,
            'exit_middle': self.exit_middle
        }


class PairsTradingStrategy(BaseStrategy):
    """
    Statistical Arbitrage / Pairs Trading

    Trades the spread between two cointegrated assets.
    Goes long spread when it's below the mean, short when above.
    """

    def __init__(self, lookback: int = 60, entry_zscore: float = 2.0,
                 exit_zscore: float = 0.5, hedge_ratio_method: str = 'ols'):
        super().__init__(name="PairsTradingStrategy")
        self.lookback = lookback
        self.entry_zscore = entry_zscore
        self.exit_zscore = exit_zscore
        self.hedge_ratio_method = hedge_ratio_method
        self._hedge_ratio = None

    def calculate_hedge_ratio(self, y: pd.Series, x: pd.Series) -> float:
        """Calculate optimal hedge ratio between two series"""
        if self.hedge_ratio_method == 'ols':
            # Simple OLS regression
            from scipy import stats
            slope, _, _, _, _ = stats.linregress(x, y)
            return slope
        elif self.hedge_ratio_method == 'rolling':
            # Rolling regression
            cov = y.rolling(self.lookback).cov(x)
            var = x.rolling(self.lookback).var()
            return (cov / var).iloc[-1]
        else:
            return 1.0

    def calculate_spread(self, data: pd.DataFrame,
                        asset1_col: str = 'close',
                        asset2_col: str = 'close_2') -> pd.Series:
        """Calculate spread between two assets"""
        y = data[asset1_col]
        x = data[asset2_col]

        # Rolling hedge ratio
        cov = y.rolling(self.lookback).cov(x)
        var = x.rolling(self.lookback).var()
        hedge_ratio = cov / var

        spread = y - hedge_ratio * x
        return spread, hedge_ratio

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        """
        Expects data with columns: 'close' (asset 1) and 'close_2' (asset 2)
        Returns signals for asset 1 (reverse for asset 2)
        """
        if 'close_2' not in data.columns:
            raise ValueError("Pairs trading requires 'close_2' column for second asset")

        spread, hedge_ratio = self.calculate_spread(data)
        self._hedge_ratio = hedge_ratio

        # Z-score of spread
        spread_mean = spread.rolling(self.lookback).mean()
        spread_std = spread.rolling(self.lookback).std()
        zscore = (spread - spread_mean) / spread_std

        # Generate signals
        signals = pd.Series(0, index=data.index)
        position = 0

        for i in range(len(data)):
            if pd.isna(zscore.iloc[i]):
                signals.iloc[i] = 0
                continue

            z = zscore.iloc[i]

            if position == 0:
                if z < -self.entry_zscore:
                    position = 1   # Long spread (long asset1, short asset2)
                elif z > self.entry_zscore:
                    position = -1  # Short spread (short asset1, long asset2)
            elif position == 1:
                if z > -self.exit_zscore:
                    position = 0
            elif position == -1:
                if z < self.exit_zscore:
                    position = 0

            signals.iloc[i] = position

        return signals

    def get_hedge_ratio(self) -> pd.Series:
        """Return the calculated hedge ratio"""
        return self._hedge_ratio

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'lookback': self.lookback,
            'entry_zscore': self.entry_zscore,
            'exit_zscore': self.exit_zscore,
            'hedge_ratio_method': self.hedge_ratio_method
        }


class OrnsteinUhlenbeckStrategy(BaseStrategy):
    """
    Ornstein-Uhlenbeck Mean Reversion

    Uses OU process parameters to model mean-reversion speed
    and optimal entry/exit levels.
    """

    def __init__(self, lookback: int = 252, entry_threshold: float = 1.5,
                 exit_threshold: float = 0.75):
        super().__init__(name="OrnsteinUhlenbeckStrategy")
        self.lookback = lookback
        self.entry_threshold = entry_threshold
        self.exit_threshold = exit_threshold

    def estimate_ou_parameters(self, prices: pd.Series) -> Tuple[float, float, float]:
        """
        Estimate Ornstein-Uhlenbeck parameters: theta (mean reversion speed),
        mu (long-term mean), sigma (volatility)
        """
        log_prices = np.log(prices)

        # Simple estimation using AR(1)
        y = log_prices.diff().dropna()
        x = log_prices.shift(1).dropna()

        # Align
        y = y.iloc[1:]
        x = x.iloc[:-1]

        # OLS regression: y = a + b*x
        from scipy import stats
        slope, intercept, _, _, _ = stats.linregress(x, y)

        # OU parameters
        dt = 1/252  # Daily data
        theta = -np.log(1 + slope) / dt
        mu = intercept / (1 - np.exp(-theta * dt))
        sigma = y.std() * np.sqrt(2 * theta / (1 - np.exp(-2 * theta * dt)))

        return theta, mu, sigma

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        close = data['close']
        log_prices = np.log(close)

        signals = pd.Series(0, index=data.index)

        for i in range(self.lookback, len(data)):
            window = close.iloc[i-self.lookback:i]

            try:
                theta, mu, sigma = self.estimate_ou_parameters(window)

                # Current deviation from mean
                deviation = (log_prices.iloc[i] - mu) / sigma

                if deviation < -self.entry_threshold:
                    signals.iloc[i] = 1  # Long
                elif deviation > self.entry_threshold:
                    signals.iloc[i] = -1  # Short
                elif abs(deviation) < self.exit_threshold:
                    signals.iloc[i] = 0  # Exit
                else:
                    signals.iloc[i] = signals.iloc[i-1]  # Hold

            except Exception:
                signals.iloc[i] = 0

        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'lookback': self.lookback,
            'entry_threshold': self.entry_threshold,
            'exit_threshold': self.exit_threshold
        }


# Quick usage example
if __name__ == "__main__":
    import yfinance as yf

    # Download sample data
    data = yf.download("AAPL", start="2020-01-01", end="2024-01-01")
    data.columns = data.columns.str.lower()

    # Test mean reversion strategy
    strategy = MeanReversionStrategy(lookback=20, num_std=2.0)
    signals = strategy.generate_signals(data)

    print(f"Strategy: {strategy}")
    print(f"Signal distribution:\n{signals.value_counts()}")
