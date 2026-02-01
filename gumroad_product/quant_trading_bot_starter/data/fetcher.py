"""
Data Fetcher Module
===================
Download and cache market data from multiple sources.
"""

import os
import pandas as pd
import numpy as np
from typing import List, Dict, Optional, Union
from datetime import datetime, timedelta
from pathlib import Path
import pickle
import hashlib
import logging

try:
    import yfinance as yf
    YFINANCE_AVAILABLE = True
except ImportError:
    YFINANCE_AVAILABLE = False

try:
    from alpha_vantage.timeseries import TimeSeries
    ALPHAVANTAGE_AVAILABLE = True
except ImportError:
    ALPHAVANTAGE_AVAILABLE = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class DataFetcher:
    """
    Multi-source data fetcher with caching.

    Supports:
    - Yahoo Finance (free, no API key)
    - Alpha Vantage (free tier available)
    - CSV files
    - Polygon.io (requires API key)
    """

    def __init__(self, source: str = "yahoo", api_key: str = None,
                 cache_dir: str = "./data/cache"):
        """
        Initialize data fetcher.

        Args:
            source: Data source ('yahoo', 'alphavantage', 'csv', 'polygon')
            api_key: API key for sources that require it
            cache_dir: Directory for caching data
        """
        self.source = source.lower()
        self.api_key = api_key
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # Validate source availability
        if self.source == "yahoo" and not YFINANCE_AVAILABLE:
            raise ImportError("yfinance not installed. pip install yfinance")
        if self.source == "alphavantage" and not ALPHAVANTAGE_AVAILABLE:
            raise ImportError("alpha_vantage not installed. pip install alpha_vantage")

    def _get_cache_key(self, symbol: str, start: str, end: str, interval: str) -> str:
        """Generate cache key"""
        key = f"{self.source}_{symbol}_{start}_{end}_{interval}"
        return hashlib.md5(key.encode()).hexdigest()

    def _load_from_cache(self, cache_key: str, max_age_hours: int = 24) -> Optional[pd.DataFrame]:
        """Load data from cache if valid"""
        cache_file = self.cache_dir / f"{cache_key}.pkl"

        if not cache_file.exists():
            return None

        # Check age
        file_age = datetime.now() - datetime.fromtimestamp(cache_file.stat().st_mtime)
        if file_age > timedelta(hours=max_age_hours):
            return None

        try:
            with open(cache_file, 'rb') as f:
                return pickle.load(f)
        except Exception:
            return None

    def _save_to_cache(self, cache_key: str, data: pd.DataFrame) -> None:
        """Save data to cache"""
        cache_file = self.cache_dir / f"{cache_key}.pkl"
        with open(cache_file, 'wb') as f:
            pickle.dump(data, f)

    def fetch(self, symbol: str, start: str = None, end: str = None,
             interval: str = "1d", use_cache: bool = True) -> pd.DataFrame:
        """
        Fetch OHLCV data for a symbol.

        Args:
            symbol: Ticker symbol
            start: Start date (YYYY-MM-DD)
            end: End date (YYYY-MM-DD)
            interval: Data interval ('1d', '1h', '5m', etc.)
            use_cache: Whether to use cached data

        Returns:
            DataFrame with columns: open, high, low, close, volume
        """
        # Default dates
        if end is None:
            end = datetime.now().strftime("%Y-%m-%d")
        if start is None:
            start = (datetime.now() - timedelta(days=365*5)).strftime("%Y-%m-%d")

        # Check cache
        cache_key = self._get_cache_key(symbol, start, end, interval)
        if use_cache:
            cached = self._load_from_cache(cache_key)
            if cached is not None:
                logger.info(f"Loaded {symbol} from cache")
                return cached

        # Fetch from source
        if self.source == "yahoo":
            data = self._fetch_yahoo(symbol, start, end, interval)
        elif self.source == "alphavantage":
            data = self._fetch_alphavantage(symbol, interval)
        elif self.source == "csv":
            data = self._fetch_csv(symbol)
        else:
            raise ValueError(f"Unknown source: {self.source}")

        # Standardize columns
        data.columns = data.columns.str.lower()

        # Ensure we have required columns
        required = ['open', 'high', 'low', 'close', 'volume']
        for col in required:
            if col not in data.columns:
                raise ValueError(f"Missing required column: {col}")

        # Keep only required columns
        data = data[required]

        # Cache data
        if use_cache:
            self._save_to_cache(cache_key, data)

        logger.info(f"Fetched {symbol}: {len(data)} bars")
        return data

    def _fetch_yahoo(self, symbol: str, start: str, end: str,
                    interval: str) -> pd.DataFrame:
        """Fetch from Yahoo Finance"""
        ticker = yf.Ticker(symbol)
        data = ticker.history(start=start, end=end, interval=interval)

        if data.empty:
            raise ValueError(f"No data found for {symbol}")

        return data

    def _fetch_alphavantage(self, symbol: str, interval: str) -> pd.DataFrame:
        """Fetch from Alpha Vantage"""
        if not self.api_key:
            raise ValueError("Alpha Vantage requires an API key")

        ts = TimeSeries(key=self.api_key, output_format='pandas')

        if interval == "1d":
            data, _ = ts.get_daily(symbol=symbol, outputsize='full')
        elif interval == "1h":
            data, _ = ts.get_intraday(symbol=symbol, interval='60min', outputsize='full')
        else:
            data, _ = ts.get_daily(symbol=symbol, outputsize='full')

        # Rename columns
        data.columns = ['open', 'high', 'low', 'close', 'volume']
        data = data.sort_index()

        return data

    def _fetch_csv(self, symbol: str) -> pd.DataFrame:
        """Fetch from local CSV file"""
        csv_path = self.cache_dir / f"{symbol}.csv"
        if not csv_path.exists():
            raise FileNotFoundError(f"CSV not found: {csv_path}")

        data = pd.read_csv(csv_path, index_col=0, parse_dates=True)
        return data

    def fetch_multiple(self, symbols: List[str], start: str = None,
                      end: str = None, interval: str = "1d") -> Dict[str, pd.DataFrame]:
        """
        Fetch data for multiple symbols.

        Returns:
            Dict mapping symbol to DataFrame
        """
        data_dict = {}
        for symbol in symbols:
            try:
                data_dict[symbol] = self.fetch(symbol, start, end, interval)
            except Exception as e:
                logger.warning(f"Failed to fetch {symbol}: {e}")
        return data_dict

    def fetch_as_panel(self, symbols: List[str], start: str = None,
                      end: str = None, field: str = "close") -> pd.DataFrame:
        """
        Fetch data for multiple symbols and return as single DataFrame.

        Args:
            symbols: List of symbols
            start: Start date
            end: End date
            field: Which field to use ('close', 'open', 'high', 'low', 'volume')

        Returns:
            DataFrame with symbols as columns
        """
        data_dict = self.fetch_multiple(symbols, start, end)

        # Extract field and combine
        panel = pd.DataFrame()
        for symbol, data in data_dict.items():
            if field in data.columns:
                panel[symbol] = data[field]

        return panel


def download_data(symbols: Union[str, List[str]], start: str = None,
                 end: str = None, interval: str = "1d",
                 source: str = "yahoo") -> Union[pd.DataFrame, Dict[str, pd.DataFrame]]:
    """
    Convenience function to download data.

    Args:
        symbols: Single symbol or list of symbols
        start: Start date
        end: End date
        interval: Data interval
        source: Data source

    Returns:
        DataFrame for single symbol, dict for multiple
    """
    fetcher = DataFetcher(source=source)

    if isinstance(symbols, str):
        return fetcher.fetch(symbols, start, end, interval)
    else:
        return fetcher.fetch_multiple(symbols, start, end, interval)


# Quick usage
if __name__ == "__main__":
    # Download single symbol
    data = download_data("AAPL", start="2020-01-01")
    print(f"AAPL data shape: {data.shape}")
    print(data.tail())

    # Download multiple symbols
    symbols = ["AAPL", "MSFT", "GOOGL"]
    data_dict = download_data(symbols, start="2020-01-01")
    print(f"\nDownloaded {len(data_dict)} symbols")
