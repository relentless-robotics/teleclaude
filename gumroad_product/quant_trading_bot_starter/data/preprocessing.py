"""
Data Preprocessing Module
=========================
Clean, transform, and engineer features from OHLCV data.
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional


def preprocess_ohlcv(data: pd.DataFrame, fill_method: str = "ffill",
                    remove_outliers: bool = True,
                    outlier_threshold: float = 0.5) -> pd.DataFrame:
    """
    Clean and preprocess OHLCV data.

    Args:
        data: Raw OHLCV DataFrame
        fill_method: Method to fill NaN values ('ffill', 'bfill', 'interpolate')
        remove_outliers: Whether to remove extreme outliers
        outlier_threshold: Max allowed daily return (0.5 = 50%)

    Returns:
        Cleaned DataFrame
    """
    df = data.copy()

    # Standardize column names
    df.columns = df.columns.str.lower()

    # Ensure datetime index
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)

    # Sort by date
    df = df.sort_index()

    # Remove duplicates
    df = df[~df.index.duplicated(keep='first')]

    # Fill missing values
    if fill_method == 'ffill':
        df = df.ffill()
    elif fill_method == 'bfill':
        df = df.bfill()
    elif fill_method == 'interpolate':
        df = df.interpolate(method='time')

    # Remove any remaining NaN
    df = df.dropna()

    # Handle outliers
    if remove_outliers:
        returns = df['close'].pct_change()
        valid_mask = returns.abs() <= outlier_threshold
        valid_mask.iloc[0] = True  # Keep first row
        df = df[valid_mask]

    # Ensure positive prices
    for col in ['open', 'high', 'low', 'close']:
        if col in df.columns:
            df = df[df[col] > 0]

    # Ensure OHLC consistency
    df = _fix_ohlc_consistency(df)

    return df


def _fix_ohlc_consistency(data: pd.DataFrame) -> pd.DataFrame:
    """Ensure high >= low, high >= open/close, low <= open/close"""
    df = data.copy()

    # High should be max of O, H, L, C
    df['high'] = df[['open', 'high', 'low', 'close']].max(axis=1)

    # Low should be min of O, H, L, C
    df['low'] = df[['open', 'high', 'low', 'close']].min(axis=1)

    return df


def calculate_indicators(data: pd.DataFrame) -> pd.DataFrame:
    """
    Calculate common technical indicators.

    Adds columns for:
    - Moving averages (SMA, EMA)
    - RSI
    - MACD
    - Bollinger Bands
    - ATR
    - Volume indicators
    """
    df = data.copy()
    close = df['close']
    high = df['high']
    low = df['low']
    volume = df['volume'] if 'volume' in df.columns else None

    # ===== MOVING AVERAGES =====
    for period in [5, 10, 20, 50, 200]:
        df[f'sma_{period}'] = close.rolling(period).mean()
        df[f'ema_{period}'] = close.ewm(span=period, adjust=False).mean()

    # ===== RSI =====
    for period in [14, 7, 21]:
        delta = close.diff()
        gain = delta.where(delta > 0, 0).rolling(period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(period).mean()
        rs = gain / (loss + 1e-10)
        df[f'rsi_{period}'] = 100 - (100 / (1 + rs))

    # ===== MACD =====
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df['macd'] = ema12 - ema26
    df['macd_signal'] = df['macd'].ewm(span=9, adjust=False).mean()
    df['macd_hist'] = df['macd'] - df['macd_signal']

    # ===== BOLLINGER BANDS =====
    for period in [20]:
        sma = close.rolling(period).mean()
        std = close.rolling(period).std()
        df[f'bb_upper_{period}'] = sma + (2 * std)
        df[f'bb_lower_{period}'] = sma - (2 * std)
        df[f'bb_pct_{period}'] = (close - df[f'bb_lower_{period}']) / (df[f'bb_upper_{period}'] - df[f'bb_lower_{period}'] + 1e-10)

    # ===== ATR =====
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs()
    ], axis=1).max(axis=1)

    for period in [14, 7, 21]:
        df[f'atr_{period}'] = tr.rolling(period).mean()
        df[f'atr_pct_{period}'] = df[f'atr_{period}'] / close

    # ===== MOMENTUM =====
    for period in [1, 5, 10, 20, 60, 252]:
        df[f'return_{period}d'] = close.pct_change(period)

    # ===== VOLATILITY =====
    returns = close.pct_change()
    for period in [10, 20, 60]:
        df[f'volatility_{period}d'] = returns.rolling(period).std() * np.sqrt(252)

    # ===== VOLUME INDICATORS =====
    if volume is not None:
        # Volume SMA
        for period in [10, 20]:
            df[f'volume_sma_{period}'] = volume.rolling(period).mean()
            df[f'volume_ratio_{period}'] = volume / df[f'volume_sma_{period}']

        # On-Balance Volume (OBV)
        df['obv'] = (np.sign(close.diff()) * volume).cumsum()

        # Volume Weighted Average Price (VWAP) - daily
        df['vwap'] = (volume * (high + low + close) / 3).cumsum() / volume.cumsum()

    # ===== PRICE POSITION =====
    for period in [20, 50, 252]:
        df[f'high_{period}'] = high.rolling(period).max()
        df[f'low_{period}'] = low.rolling(period).min()
        df[f'price_position_{period}'] = (close - df[f'low_{period}']) / (df[f'high_{period}'] - df[f'low_{period}'] + 1e-10)

    return df


def calculate_returns_matrix(prices: pd.DataFrame, periods: List[int] = None) -> Dict[int, pd.DataFrame]:
    """
    Calculate returns over multiple periods for a panel of prices.

    Args:
        prices: DataFrame with prices (symbols as columns)
        periods: List of periods for return calculation

    Returns:
        Dict mapping period to returns DataFrame
    """
    if periods is None:
        periods = [1, 5, 20, 60, 252]

    returns_dict = {}
    for period in periods:
        returns_dict[period] = prices.pct_change(period)

    return returns_dict


def calculate_correlation_matrix(returns: pd.DataFrame, window: int = None) -> pd.DataFrame:
    """
    Calculate correlation matrix for returns.

    Args:
        returns: Returns DataFrame (symbols as columns)
        window: Rolling window for correlation (None = full period)

    Returns:
        Correlation matrix
    """
    if window is None:
        return returns.corr()
    else:
        return returns.rolling(window).corr().iloc[-len(returns.columns):]


def resample_ohlcv(data: pd.DataFrame, freq: str) -> pd.DataFrame:
    """
    Resample OHLCV data to a different frequency.

    Args:
        data: OHLCV DataFrame
        freq: Target frequency ('W' for weekly, 'M' for monthly, etc.)

    Returns:
        Resampled DataFrame
    """
    resampled = pd.DataFrame()

    resampled['open'] = data['open'].resample(freq).first()
    resampled['high'] = data['high'].resample(freq).max()
    resampled['low'] = data['low'].resample(freq).min()
    resampled['close'] = data['close'].resample(freq).last()

    if 'volume' in data.columns:
        resampled['volume'] = data['volume'].resample(freq).sum()

    return resampled.dropna()


def split_train_test(data: pd.DataFrame, train_ratio: float = 0.8,
                    by_date: str = None) -> tuple:
    """
    Split data into training and testing sets.

    Args:
        data: DataFrame to split
        train_ratio: Fraction for training (0-1)
        by_date: Optional date string to split by

    Returns:
        (train_data, test_data)
    """
    if by_date:
        split_date = pd.Timestamp(by_date)
        train = data[data.index < split_date]
        test = data[data.index >= split_date]
    else:
        split_idx = int(len(data) * train_ratio)
        train = data.iloc[:split_idx]
        test = data.iloc[split_idx:]

    return train, test


# Quick usage
if __name__ == "__main__":
    # Generate sample data
    dates = pd.date_range('2020-01-01', '2024-01-01', freq='B')
    np.random.seed(42)

    # Random walk for price
    returns = np.random.randn(len(dates)) * 0.02
    prices = 100 * np.exp(np.cumsum(returns))

    data = pd.DataFrame({
        'open': prices * (1 + np.random.randn(len(dates)) * 0.01),
        'high': prices * (1 + np.abs(np.random.randn(len(dates)) * 0.02)),
        'low': prices * (1 - np.abs(np.random.randn(len(dates)) * 0.02)),
        'close': prices,
        'volume': np.random.randint(1000000, 10000000, len(dates))
    }, index=dates)

    # Preprocess
    clean_data = preprocess_ohlcv(data)
    print(f"Cleaned data shape: {clean_data.shape}")

    # Calculate indicators
    data_with_indicators = calculate_indicators(clean_data)
    print(f"Data with indicators shape: {data_with_indicators.shape}")
    print(f"Indicators added: {[col for col in data_with_indicators.columns if col not in clean_data.columns]}")
