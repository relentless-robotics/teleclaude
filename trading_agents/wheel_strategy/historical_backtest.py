#!/usr/bin/env python3
"""
Historical Wheel Strategy Backtest — Uses real IV calibration + yfinance stock data.

Alpaca free tier does not provide historical options bars, so we use:
  1. Alpaca snapshots for CURRENT IV calibration per ticker (real market IVs)
  2. yfinance for historical stock prices (6-12+ months)
  3. Black-Scholes with IV calibrated to real Alpaca snapshots

This is significantly more accurate than uncalibrated BS because:
  - IV levels are anchored to real market prices
  - IV/HV ratio is measured, not assumed
  - Per-ticker IV calibration captures sector differences

Usage:
    python historical_backtest.py --collect              # Download & cache data
    python historical_backtest.py --backtest             # Run default backtest
    python historical_backtest.py --sweep                # Full parameter sweep
    python historical_backtest.py --report               # Show saved results
    python historical_backtest.py --backtest --tickers INTC,SOFI,PLTR
    python historical_backtest.py --sweep --months 12
"""

import argparse
import json
import math
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, date
from pathlib import Path

import numpy as np

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False

try:
    from scipy.stats import norm
    from scipy.optimize import brentq
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False

# ── Path setup ───────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parents[1]
HIST_DATA_DIR = SCRIPT_DIR / 'data' / 'historical_options'
RESULTS_DIR = SCRIPT_DIR / 'data' / 'backtest_results'
HIST_DATA_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# Load .env
ENV_FILE = ROOT_DIR / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = v.strip().strip("'\"")
            if k.strip() not in os.environ:
                os.environ[k.strip()] = v

# ── Default Tickers ──────────────────────────────────────────────────────────
DEFAULT_TICKERS = ['INTC', 'SOFI', 'PLTR', 'HOOD', 'DAL', 'AAL', 'RIVN', 'AMD', 'BAC', 'C']

# ── Constants ────────────────────────────────────────────────────────────────
RISK_FREE_RATE = 0.043  # Current 10Y treasury approx
COMMISSION_PER_CONTRACT = 0.65  # Typical options commission per contract per leg


# =============================================================================
# Black-Scholes Pricing (self-contained — no import dependency on options_pricer)
# =============================================================================

def _norm_cdf(x):
    """Standard normal CDF — fallback if scipy unavailable."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x):
    """Standard normal PDF."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bs_price(S, K, T, r, sigma, option_type='put'):
    """Black-Scholes option price."""
    if T <= 0 or sigma <= 0:
        if option_type == 'put':
            return max(K - S, 0)
        return max(S - K, 0)

    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    cdf = norm.cdf if HAS_SCIPY else _norm_cdf

    if option_type == 'call':
        return S * cdf(d1) - K * math.exp(-r * T) * cdf(d2)
    else:
        return K * math.exp(-r * T) * cdf(-d2) - S * cdf(-d1)


def bs_delta(S, K, T, r, sigma, option_type='put'):
    """Black-Scholes delta."""
    if T <= 0 or sigma <= 0:
        if option_type == 'put':
            return -1.0 if S < K else 0.0
        return 1.0 if S > K else 0.0

    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    cdf = norm.cdf if HAS_SCIPY else _norm_cdf

    if option_type == 'call':
        return cdf(d1)
    else:
        return cdf(d1) - 1.0


def find_strike_for_delta(S, T, r, sigma, target_delta, option_type='put'):
    """Find strike price that gives target delta."""
    if option_type == 'put' and target_delta > 0:
        target_delta = -target_delta

    low_k = S * 0.60
    high_k = S * 1.40
    best_k = S
    best_diff = float('inf')

    for k in np.linspace(low_k, high_k, 300):
        d = bs_delta(S, k, T, r, sigma, option_type)
        diff = abs(d - target_delta)
        if diff < best_diff:
            best_diff = diff
            best_k = k

    # Round to nearest 0.50 (standard strike increments for most stocks)
    return round(best_k * 2) / 2


def solve_iv(market_price, S, K, T, r, option_type='put'):
    """Solve for implied volatility using Brent's method."""
    if T <= 0 or market_price <= 0:
        return None

    intrinsic = max(K - S, 0) if option_type == 'put' else max(S - K, 0)
    if market_price < intrinsic * 0.99:
        return None

    def obj(sigma):
        return bs_price(S, K, T, r, sigma, option_type) - market_price

    try:
        if HAS_SCIPY:
            return brentq(obj, 0.01, 5.0, xtol=1e-6, maxiter=100)
        else:
            # Simple bisection fallback
            lo, hi = 0.01, 5.0
            for _ in range(80):
                mid = (lo + hi) / 2
                if obj(mid) > 0:
                    hi = mid
                else:
                    lo = mid
            return (lo + hi) / 2
    except (ValueError, RuntimeError):
        return None


# =============================================================================
# Data Collection
# =============================================================================

class DataCollector:
    """Download and cache historical stock data + IV calibration from Alpaca."""

    def __init__(self, tickers=None, months=12):
        self.tickers = tickers or DEFAULT_TICKERS
        self.months = months
        self.alpaca_client = None

    def _init_alpaca(self):
        """Lazy-init Alpaca client for IV calibration."""
        if self.alpaca_client is not None:
            return True
        try:
            sys.path.insert(0, str(SCRIPT_DIR))
            from alpaca_options import AlpacaOptionsClient
            self.alpaca_client = AlpacaOptionsClient()
            return True
        except Exception as e:
            print(f"  Alpaca client unavailable: {e}")
            print("  Will use estimated IV (HV * 1.2 premium)")
            return False

    def collect_all(self):
        """Download stock prices + IV calibration for all tickers."""
        if not HAS_YFINANCE:
            raise ImportError("yfinance required. Install: pip install yfinance")

        print(f"Collecting data for {len(self.tickers)} tickers, {self.months} months...")
        print(f"Data cache: {HIST_DATA_DIR}\n")

        results = {}
        has_alpaca = self._init_alpaca()

        for ticker in self.tickers:
            print(f"  {ticker}...", end=' ', flush=True)
            try:
                data = self._collect_ticker(ticker, has_alpaca)
                results[ticker] = data

                # Save per-ticker cache
                cache_file = HIST_DATA_DIR / f'{ticker}_hist.json'
                with open(cache_file, 'w') as f:
                    json.dump(data, f, indent=2, default=str)

                n_days = len(data['prices'])
                iv_src = data.get('iv_source', 'estimated')
                calib_iv = data.get('calibrated_iv')
                iv_str = f"IV={calib_iv:.1%}" if calib_iv else "IV=N/A"
                print(f"{n_days} days, {iv_src}, {iv_str}")

            except Exception as e:
                print(f"FAILED — {e}")
                results[ticker] = {'error': str(e)}

        # Save combined cache
        meta = {
            'collected_at': datetime.now().isoformat(),
            'months': self.months,
            'tickers': list(results.keys()),
            'summary': {
                t: {
                    'days': len(d.get('prices', [])),
                    'iv_source': d.get('iv_source', 'error'),
                    'calibrated_iv': d.get('calibrated_iv'),
                }
                for t, d in results.items() if 'error' not in d
            },
        }
        with open(HIST_DATA_DIR / 'collection_meta.json', 'w') as f:
            json.dump(meta, f, indent=2)

        ok = sum(1 for d in results.values() if 'error' not in d)
        print(f"\nCollected: {ok}/{len(self.tickers)} tickers OK")
        return results

    def _collect_ticker(self, ticker, has_alpaca):
        """Collect stock price history + IV calibration for one ticker."""
        # 1. Stock price history from yfinance
        end = date.today()
        start = end - timedelta(days=int(self.months * 30.5) + 60)  # extra for IV warmup
        df = yf.download(ticker, start=str(start), end=str(end),
                         progress=False, auto_adjust=True)
        if df.empty:
            raise ValueError(f"No yfinance data for {ticker}")

        # Flatten MultiIndex if present
        if hasattr(df.columns, 'levels') and len(df.columns.levels) > 1:
            df.columns = df.columns.get_level_values(0)

        prices = df['Close'].values.flatten().tolist()
        dates = [str(d.date()) if hasattr(d, 'date') else str(d)[:10] for d in df.index]
        volumes = df['Volume'].values.flatten().tolist() if 'Volume' in df.columns else []

        # 2. Compute historical volatility for IV calibration
        log_returns = np.diff(np.log(prices))
        hv_30d = float(np.std(log_returns[-30:]) * np.sqrt(252)) if len(log_returns) >= 30 else 0.30
        hv_60d = float(np.std(log_returns[-60:]) * np.sqrt(252)) if len(log_returns) >= 60 else hv_30d

        # 3. Calibrate IV from Alpaca snapshots (real market data)
        calibrated_iv = None
        iv_hv_ratio = 1.2  # Default IV/HV premium
        iv_source = 'estimated'

        if has_alpaca:
            try:
                calib = self._calibrate_iv_from_alpaca(ticker, prices[-1], hv_30d)
                if calib:
                    calibrated_iv = calib['median_iv']
                    iv_hv_ratio = calib['iv_hv_ratio']
                    iv_source = 'alpaca_calibrated'
            except Exception:
                pass

        if calibrated_iv is None:
            calibrated_iv = hv_30d * iv_hv_ratio

        return {
            'ticker': ticker,
            'prices': prices,
            'dates': dates,
            'volumes': volumes[:len(prices)] if volumes else [],
            'hv_30d': round(hv_30d, 4),
            'hv_60d': round(hv_60d, 4),
            'calibrated_iv': round(calibrated_iv, 4),
            'iv_hv_ratio': round(iv_hv_ratio, 3),
            'iv_source': iv_source,
            'current_price': round(prices[-1], 2),
            'collected_at': datetime.now().isoformat(),
        }

    def _calibrate_iv_from_alpaca(self, ticker, current_price, hv):
        """Pull real IVs from Alpaca snapshots to calibrate BS model."""
        chain = self.alpaca_client.get_option_chain(
            ticker, min_dte=5, max_dte=45, option_type='put'
        )
        if not chain:
            return None

        # Collect IVs from ATM-ish puts (delta -0.20 to -0.45)
        ivs = []
        for opt in chain:
            if opt['iv'] > 0 and -0.45 <= opt['delta'] <= -0.15:
                ivs.append(opt['iv'])

        if len(ivs) < 3:
            return None

        median_iv = float(np.median(ivs))
        ratio = median_iv / hv if hv > 0 else 1.2

        return {
            'median_iv': median_iv,
            'iv_hv_ratio': max(min(ratio, 2.5), 0.8),  # Clamp to reasonable range
            'samples': len(ivs),
        }

    @staticmethod
    def load_cached(ticker):
        """Load cached data for a ticker. Returns None if not cached."""
        cache_file = HIST_DATA_DIR / f'{ticker}_hist.json'
        if not cache_file.exists():
            return None
        with open(cache_file, 'r') as f:
            return json.load(f)


# =============================================================================
# Backtest Engine
# =============================================================================

class WheelHistoricalBacktest:
    """
    Simulate the full wheel strategy cycle on historical data.

    CSP sell -> [expire OTM | get assigned] -> CC sell -> [expire OTM | called away]

    Uses Black-Scholes calibrated to real market IVs for option pricing.
    """

    def __init__(self, ticker, data,
                 capital=10_000,
                 csp_delta=0.30,
                 cc_delta=0.35,
                 target_dte=7,
                 early_close_pct=None,
                 commission=COMMISSION_PER_CONTRACT,
                 bid_ask_haircut=0.05):
        """
        Args:
            ticker: stock symbol
            data: dict from DataCollector (prices, dates, calibrated_iv, etc.)
            capital: starting capital (per ticker)
            csp_delta: target absolute delta for CSP (0.20-0.40)
            cc_delta: target absolute delta for CC (0.25-0.45)
            target_dte: days to expiration target (7, 14, 21, 30)
            early_close_pct: close at this % of max profit (0.50, 0.75, or None=hold to expiry)
            commission: per contract per leg
            bid_ask_haircut: fraction of mid-price lost to spread (conservative)
        """
        self.ticker = ticker
        self.prices = np.array(data['prices'], dtype=float)
        self.dates = data['dates']
        self.base_iv = data.get('calibrated_iv', 0.30)
        self.iv_hv_ratio = data.get('iv_hv_ratio', 1.2)

        self.capital = capital
        self.initial_capital = capital
        self.csp_delta = csp_delta
        self.cc_delta = cc_delta
        self.target_dte = target_dte
        self.early_close_pct = early_close_pct
        self.commission = commission
        self.bid_ask_haircut = bid_ask_haircut

        # State
        self.phase = 'CSP'  # CSP or CC
        self.shares_held = 0
        self.cost_basis = 0.0
        self.position = None  # Current option position

        # Tracking
        self.trades = []
        self.equity_curve = []
        self.total_premium = 0.0
        self.total_commissions = 0.0
        self.cycles = {
            'expired_otm': 0,
            'assigned': 0,
            'called_away': 0,
            'early_closed': 0,
        }

    def _local_iv(self, idx, lookback=20):
        """Estimate IV at a point in time using local HV scaled by calibrated ratio."""
        start = max(0, idx - lookback)
        window = self.prices[start:idx + 1]
        if len(window) < 5:
            return self.base_iv

        log_ret = np.diff(np.log(window))
        hv = float(np.std(log_ret) * np.sqrt(252))
        # Scale by the measured IV/HV ratio from Alpaca calibration
        iv = hv * self.iv_hv_ratio
        return max(iv, 0.05)

    def _trading_days_to_calendar(self, trading_days):
        """Convert trading days to approximate calendar days."""
        return int(trading_days * 365 / 252)

    def _calendar_to_trading_days(self, calendar_days):
        """Convert calendar days to approximate trading days."""
        return max(1, int(calendar_days * 252 / 365))

    def _find_expiry_idx(self, entry_idx):
        """Find the index corresponding to expiry based on target DTE."""
        td = self._calendar_to_trading_days(self.target_dte)
        target = entry_idx + td
        return min(target, len(self.prices) - 1)

    def _open_csp(self, idx):
        """Sell a cash-secured put."""
        price = self.prices[idx]
        iv = self._local_iv(idx)
        T = self.target_dte / 365.0

        strike = find_strike_for_delta(price, T, RISK_FREE_RATE, iv, -self.csp_delta, 'put')

        # Price the put at mid, then haircut for bid
        mid_price = bs_price(price, strike, T, RISK_FREE_RATE, iv, 'put')
        fill_price = mid_price * (1.0 - self.bid_ask_haircut)
        fill_price = max(fill_price, 0.01)

        # Check if we can afford the collateral
        collateral = strike * 100
        if collateral > self.capital:
            return False

        expiry_idx = self._find_expiry_idx(idx)
        actual_delta = bs_delta(price, strike, T, RISK_FREE_RATE, iv, 'put')

        self.position = {
            'type': 'CSP',
            'strike': strike,
            'premium': fill_price,
            'entry_price': price,
            'entry_idx': idx,
            'entry_date': self.dates[idx],
            'expiry_idx': expiry_idx,
            'iv': iv,
            'delta': actual_delta,
        }

        # Collect premium
        premium_total = fill_price * 100
        self.capital += premium_total
        self.total_premium += premium_total
        self.capital -= self.commission
        self.total_commissions += self.commission

        self.trades.append({
            'action': 'SELL_CSP',
            'date': self.dates[idx],
            'strike': strike,
            'premium': round(fill_price, 4),
            'stock_price': round(price, 2),
            'iv': round(iv, 4),
            'delta': round(actual_delta, 4),
            'dte': self.target_dte,
        })

        return True

    def _open_cc(self, idx):
        """Sell a covered call on assigned shares."""
        price = self.prices[idx]
        iv = self._local_iv(idx)
        T = self.target_dte / 365.0

        strike = find_strike_for_delta(price, T, RISK_FREE_RATE, iv, self.cc_delta, 'call')

        # Prefer strike at or above cost basis when possible
        if strike < self.cost_basis and price >= self.cost_basis * 0.95:
            strike = max(strike, round(self.cost_basis * 2) / 2)

        mid_price = bs_price(price, strike, T, RISK_FREE_RATE, iv, 'call')
        fill_price = mid_price * (1.0 - self.bid_ask_haircut)
        fill_price = max(fill_price, 0.01)

        expiry_idx = self._find_expiry_idx(idx)
        actual_delta = bs_delta(price, strike, T, RISK_FREE_RATE, iv, 'call')

        self.position = {
            'type': 'CC',
            'strike': strike,
            'premium': fill_price,
            'entry_price': price,
            'entry_idx': idx,
            'entry_date': self.dates[idx],
            'expiry_idx': expiry_idx,
            'iv': iv,
            'delta': actual_delta,
        }

        premium_total = fill_price * 100
        self.capital += premium_total
        self.total_premium += premium_total
        self.capital -= self.commission
        self.total_commissions += self.commission

        self.trades.append({
            'action': 'SELL_CC',
            'date': self.dates[idx],
            'strike': strike,
            'premium': round(fill_price, 4),
            'stock_price': round(price, 2),
            'cost_basis': round(self.cost_basis, 2),
            'iv': round(iv, 4),
            'delta': round(actual_delta, 4),
            'dte': self.target_dte,
        })

        return True

    def _check_early_close(self, idx):
        """Check if position should be closed early for profit."""
        if self.early_close_pct is None or self.position is None:
            return False

        pos = self.position
        price = self.prices[idx]
        remaining_dte = pos['expiry_idx'] - idx
        if remaining_dte <= 0:
            return False

        T_remaining = self._trading_days_to_calendar(remaining_dte) / 365.0
        iv = self._local_iv(idx)

        # Current option value
        current_value = bs_price(price, pos['strike'], T_remaining,
                                 RISK_FREE_RATE, iv, 'put' if pos['type'] == 'CSP' else 'call')

        # Profit = entry premium - current value (we sold, so profit when value drops)
        profit_pct = (pos['premium'] - current_value) / pos['premium'] if pos['premium'] > 0 else 0

        if profit_pct >= self.early_close_pct:
            # Buy back the option
            buyback_cost = current_value * (1.0 + self.bid_ask_haircut)  # Pay ask to close
            self.capital -= buyback_cost * 100
            self.capital -= self.commission
            self.total_commissions += self.commission
            self.cycles['early_closed'] += 1

            self.trades.append({
                'action': 'EARLY_CLOSE',
                'date': self.dates[idx],
                'type': pos['type'],
                'strike': pos['strike'],
                'buyback_price': round(buyback_cost, 4),
                'profit_pct': round(profit_pct * 100, 1),
                'stock_price': round(price, 2),
            })

            self.position = None
            # Stay in same phase (CSP stays CSP, CC stays CC)
            return True

        return False

    def _process_expiry(self, idx):
        """Process option expiration."""
        pos = self.position
        if pos is None:
            return

        price = self.prices[idx]

        if pos['type'] == 'CSP':
            if price < pos['strike']:
                # ASSIGNED — buy 100 shares at strike
                cost = pos['strike'] * 100
                self.capital -= cost
                self.shares_held = 100
                self.cost_basis = pos['strike'] - pos['premium']  # Net cost basis
                self.phase = 'CC'
                self.cycles['assigned'] += 1

                self.trades.append({
                    'action': 'ASSIGNED',
                    'date': self.dates[idx],
                    'strike': pos['strike'],
                    'stock_price': round(price, 2),
                    'cost_basis': round(self.cost_basis, 2),
                    'unrealized_loss': round((price - pos['strike']) * 100, 2),
                })
            else:
                # Expired OTM — keep premium
                self.cycles['expired_otm'] += 1
                self.trades.append({
                    'action': 'EXPIRED_OTM',
                    'date': self.dates[idx],
                    'type': 'CSP',
                    'strike': pos['strike'],
                    'stock_price': round(price, 2),
                    'premium_kept': round(pos['premium'], 4),
                })

        elif pos['type'] == 'CC':
            if price >= pos['strike']:
                # CALLED AWAY — sell shares at strike
                proceeds = pos['strike'] * 100
                self.capital += proceeds
                gain_per_share = pos['strike'] - self.cost_basis
                self.shares_held = 0
                self.cost_basis = 0.0
                self.phase = 'CSP'
                self.cycles['called_away'] += 1

                self.trades.append({
                    'action': 'CALLED_AWAY',
                    'date': self.dates[idx],
                    'strike': pos['strike'],
                    'stock_price': round(price, 2),
                    'gain_per_share': round(gain_per_share, 2),
                })
            else:
                # Expired OTM — keep premium + shares
                self.cost_basis -= pos['premium']  # Lower cost basis
                self.cycles['expired_otm'] += 1
                self.trades.append({
                    'action': 'EXPIRED_OTM',
                    'date': self.dates[idx],
                    'type': 'CC',
                    'strike': pos['strike'],
                    'stock_price': round(price, 2),
                    'premium_kept': round(pos['premium'], 4),
                    'new_cost_basis': round(self.cost_basis, 2),
                })

        self.position = None

    def _portfolio_value(self, price):
        """Total portfolio value = cash + stock holdings."""
        return self.capital + self.shares_held * price

    def run(self):
        """Execute the full backtest."""
        n = len(self.prices)
        if n < 60:
            raise ValueError(f"Need at least 60 trading days, got {n}")

        # Start after warmup period (for IV estimation)
        warmup = 45
        start_idx = warmup

        # Reset state
        self.capital = self.initial_capital
        self.shares_held = 0
        self.cost_basis = 0.0
        self.phase = 'CSP'
        self.position = None
        self.trades = []
        self.equity_curve = []
        self.total_premium = 0.0
        self.total_commissions = 0.0
        self.cycles = {'expired_otm': 0, 'assigned': 0, 'called_away': 0, 'early_closed': 0}

        # Buy-and-hold benchmark
        bnh_price = self.prices[start_idx]
        bnh_shares = self.initial_capital / bnh_price

        # Main simulation loop
        for idx in range(start_idx, n):
            price = self.prices[idx]

            # Check early close opportunity
            if self.position is not None:
                self._check_early_close(idx)

            # Check expiry
            if self.position is not None and idx >= self.position['expiry_idx']:
                self._process_expiry(idx)

            # Open new position if none active
            if self.position is None:
                if self.phase == 'CSP':
                    self._open_csp(idx)
                elif self.phase == 'CC' and self.shares_held >= 100:
                    self._open_cc(idx)

            # Record equity curve
            pv = self._portfolio_value(price)
            self.equity_curve.append({
                'date': self.dates[idx],
                'value': round(pv, 2),
                'price': round(price, 2),
                'phase': self.phase,
            })

        # Final settlement
        final_price = self.prices[-1]
        final_date = self.dates[-1]
        if self.position:
            self._process_expiry(n - 1)

        final_value = self._portfolio_value(final_price)
        bnh_final = bnh_shares * final_price

        # Compute metrics
        values = [e['value'] for e in self.equity_curve]
        total_cycles = sum(self.cycles.values())
        trading_days = n - start_idx

        # Returns
        total_return = (final_value - self.initial_capital) / self.initial_capital
        bnh_return = (bnh_final - self.initial_capital) / self.initial_capital

        # Sharpe
        if len(values) > 1:
            daily_ret = np.diff(values) / np.array(values[:-1])
            sharpe = (float(np.mean(daily_ret)) / float(np.std(daily_ret)) * np.sqrt(252)
                      if np.std(daily_ret) > 0 else 0.0)
        else:
            sharpe = 0.0

        # Max drawdown
        if len(values) > 0:
            peak = np.maximum.accumulate(values)
            dd = (np.array(values) - peak) / peak
            max_dd = float(np.min(dd))
        else:
            max_dd = 0.0

        # Weekly yield
        weeks = trading_days / 5.0
        weekly_yield = (total_return / weeks * 100) if weeks > 0 else 0.0

        # Win rate
        win_rate = (self.cycles['expired_otm'] + self.cycles['early_closed']) / total_cycles * 100 if total_cycles > 0 else 0.0

        # CAGR
        years = trading_days / 252.0
        if years > 0 and final_value > 0:
            cagr = (final_value / self.initial_capital) ** (1.0 / years) - 1
        else:
            cagr = 0.0

        result = {
            'ticker': self.ticker,
            'period': {
                'start': self.dates[start_idx],
                'end': final_date,
                'trading_days': trading_days,
                'weeks': round(weeks, 1),
            },
            'parameters': {
                'capital': self.initial_capital,
                'csp_delta': self.csp_delta,
                'cc_delta': self.cc_delta,
                'target_dte': self.target_dte,
                'early_close_pct': self.early_close_pct,
                'iv_source': 'calibrated',
                'base_iv': round(self.base_iv, 4),
            },
            'performance': {
                'final_value': round(final_value, 2),
                'total_return_pct': round(total_return * 100, 2),
                'cagr_pct': round(cagr * 100, 2),
                'weekly_yield_pct': round(weekly_yield, 3),
                'total_premium': round(self.total_premium, 2),
                'total_commissions': round(self.total_commissions, 2),
                'sharpe': round(sharpe, 2),
                'max_drawdown_pct': round(max_dd * 100, 2),
            },
            'cycles': {
                'total': total_cycles,
                'expired_otm': self.cycles['expired_otm'],
                'assigned': self.cycles['assigned'],
                'called_away': self.cycles['called_away'],
                'early_closed': self.cycles['early_closed'],
                'win_rate_pct': round(win_rate, 1),
                'assignment_rate_pct': round(
                    self.cycles['assigned'] / total_cycles * 100 if total_cycles > 0 else 0, 1
                ),
            },
            'benchmark': {
                'buy_hold_return_pct': round(bnh_return * 100, 2),
                'buy_hold_final': round(bnh_final, 2),
                'wheel_vs_bnh_pct': round((total_return - bnh_return) * 100, 2),
            },
            'final_state': {
                'phase': self.phase,
                'shares_held': self.shares_held,
                'cost_basis': round(self.cost_basis, 2),
                'cash': round(self.capital, 2),
            },
        }

        return result


# =============================================================================
# Parameter Sweep
# =============================================================================

class ParameterSweep:
    """Sweep across delta, DTE, and early-close parameters."""

    DELTA_LEVELS = [0.20, 0.25, 0.30, 0.35, 0.40]
    DTE_LEVELS = [7, 14, 21, 30]
    EARLY_CLOSE = [None, 0.50, 0.75]

    def __init__(self, tickers=None, months=12, capital_per_ticker=10_000):
        self.tickers = tickers or DEFAULT_TICKERS
        self.months = months
        self.capital = capital_per_ticker

    def run(self):
        """Run full parameter sweep across all tickers and configs."""
        all_data = {}
        for ticker in self.tickers:
            data = DataCollector.load_cached(ticker)
            if data and 'error' not in data:
                all_data[ticker] = data
            else:
                print(f"  {ticker}: no cached data, skipping (run --collect first)")

        if not all_data:
            raise ValueError("No cached data found. Run --collect first.")

        configs = []
        for delta in self.DELTA_LEVELS:
            for dte in self.DTE_LEVELS:
                for ec in self.EARLY_CLOSE:
                    configs.append({
                        'csp_delta': delta,
                        'cc_delta': min(delta + 0.05, 0.45),
                        'target_dte': dte,
                        'early_close_pct': ec,
                    })

        print(f"Parameter sweep: {len(configs)} configs x {len(all_data)} tickers "
              f"= {len(configs) * len(all_data)} backtests")
        print()

        results = []
        total = len(configs) * len(all_data)
        done = 0

        for cfg in configs:
            ec_str = 'hold' if cfg['early_close_pct'] is None else f"{int(cfg['early_close_pct']*100)}%"
            cfg_label = f"d={cfg['csp_delta']:.2f} dte={cfg['target_dte']} ec={ec_str}"

            for ticker, data in all_data.items():
                done += 1
                try:
                    bt = WheelHistoricalBacktest(
                        ticker, data,
                        capital=self.capital,
                        csp_delta=cfg['csp_delta'],
                        cc_delta=cfg['cc_delta'],
                        target_dte=cfg['target_dte'],
                        early_close_pct=cfg['early_close_pct'],
                    )
                    result = bt.run()
                    result['config_label'] = cfg_label
                    results.append(result)
                except Exception as e:
                    results.append({
                        'ticker': ticker,
                        'config_label': cfg_label,
                        'error': str(e),
                    })

                if done % 50 == 0:
                    print(f"  Progress: {done}/{total} ({done/total*100:.0f}%)")

        print(f"  Completed: {done}/{total}")

        # Aggregate by config
        config_summary = self._aggregate_by_config(results)
        # Aggregate by ticker
        ticker_summary = self._aggregate_by_ticker(results)

        sweep_results = {
            'timestamp': datetime.now().isoformat(),
            'tickers': list(all_data.keys()),
            'configs_tested': len(configs),
            'total_backtests': total,
            'config_summary': config_summary,
            'ticker_summary': ticker_summary,
            'all_results': results,
        }

        # Save
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        filepath = RESULTS_DIR / f'sweep_{ts}.json'
        with open(filepath, 'w') as f:
            json.dump(sweep_results, f, indent=2, default=str)
        print(f"\nResults saved: {filepath}")

        # Find best config
        best = self._find_best_config(config_summary)
        print(f"\n{'='*70}")
        print("BEST CONFIGURATION:")
        print(f"  Config: {best['config']}")
        print(f"  Avg Return: {best['avg_return_pct']:+.2f}%")
        print(f"  Avg Sharpe: {best['avg_sharpe']:.2f}")
        print(f"  Avg Win Rate: {best['avg_win_rate']:.1f}%")
        print(f"  Avg Weekly Yield: {best['avg_weekly_yield']:.3f}%")
        print(f"  Avg Max DD: {best['avg_max_dd']:.2f}%")
        print(f"{'='*70}")

        return sweep_results

    def _aggregate_by_config(self, results):
        """Aggregate results by configuration."""
        from collections import defaultdict
        by_config = defaultdict(list)
        for r in results:
            if 'error' in r:
                continue
            by_config[r['config_label']].append(r)

        summary = []
        for label, runs in by_config.items():
            returns = [r['performance']['total_return_pct'] for r in runs]
            sharpes = [r['performance']['sharpe'] for r in runs]
            win_rates = [r['cycles']['win_rate_pct'] for r in runs]
            wk_yields = [r['performance']['weekly_yield_pct'] for r in runs]
            max_dds = [r['performance']['max_drawdown_pct'] for r in runs]
            assign_rates = [r['cycles']['assignment_rate_pct'] for r in runs]

            summary.append({
                'config': label,
                'n_tickers': len(runs),
                'avg_return_pct': round(float(np.mean(returns)), 2),
                'med_return_pct': round(float(np.median(returns)), 2),
                'avg_sharpe': round(float(np.mean(sharpes)), 2),
                'avg_win_rate': round(float(np.mean(win_rates)), 1),
                'avg_weekly_yield': round(float(np.mean(wk_yields)), 3),
                'avg_max_dd': round(float(np.mean(max_dds)), 2),
                'avg_assignment_rate': round(float(np.mean(assign_rates)), 1),
                'pct_profitable': round(sum(1 for r in returns if r > 0) / len(returns) * 100, 0),
            })

        summary.sort(key=lambda x: x['avg_sharpe'], reverse=True)
        return summary

    def _aggregate_by_ticker(self, results):
        """Aggregate results by ticker across all configs."""
        from collections import defaultdict
        by_ticker = defaultdict(list)
        for r in results:
            if 'error' in r:
                continue
            by_ticker[r['ticker']].append(r)

        summary = []
        for ticker, runs in by_ticker.items():
            returns = [r['performance']['total_return_pct'] for r in runs]
            sharpes = [r['performance']['sharpe'] for r in runs]
            bnh = [r['benchmark']['buy_hold_return_pct'] for r in runs]

            summary.append({
                'ticker': ticker,
                'n_configs': len(runs),
                'avg_return_pct': round(float(np.mean(returns)), 2),
                'best_return_pct': round(float(np.max(returns)), 2),
                'worst_return_pct': round(float(np.min(returns)), 2),
                'avg_sharpe': round(float(np.mean(sharpes)), 2),
                'buy_hold_return_pct': round(float(np.mean(bnh)), 2),
                'wheel_beats_bnh_pct': round(
                    sum(1 for r in runs if r['performance']['total_return_pct'] >
                        r['benchmark']['buy_hold_return_pct']) / len(runs) * 100, 0
                ),
            })

        summary.sort(key=lambda x: x['avg_return_pct'], reverse=True)
        return summary

    def _find_best_config(self, config_summary):
        """Find best config by risk-adjusted return (Sharpe)."""
        if not config_summary:
            return {'config': 'N/A', 'avg_return_pct': 0, 'avg_sharpe': 0,
                    'avg_win_rate': 0, 'avg_weekly_yield': 0, 'avg_max_dd': 0}
        # Sort by Sharpe, tiebreak by return
        return max(config_summary, key=lambda x: (x['avg_sharpe'], x['avg_return_pct']))


# =============================================================================
# Reporting
# =============================================================================

def format_backtest_result(r):
    """Format a single backtest result for display."""
    if 'error' in r:
        return f"  {r['ticker']}: ERROR — {r['error']}"

    p = r['performance']
    c = r['cycles']
    b = r['benchmark']

    lines = [
        f"=== {r['ticker']} Wheel Backtest ===",
        f"Period: {r['period']['start']} to {r['period']['end']} ({r['period']['weeks']} weeks)",
        f"Config: delta={r['parameters']['csp_delta']} DTE={r['parameters']['target_dte']} "
        f"early_close={'hold' if r['parameters']['early_close_pct'] is None else str(int(r['parameters']['early_close_pct']*100)) + '%'}",
        f"",
        f"  Return:       {p['total_return_pct']:>+8.2f}%  |  B&H: {b['buy_hold_return_pct']:>+8.2f}%  |  "
        f"Wheel vs B&H: {b['wheel_vs_bnh_pct']:>+.2f}%",
        f"  CAGR:         {p['cagr_pct']:>+8.2f}%",
        f"  Sharpe:       {p['sharpe']:>8.2f}",
        f"  Max DD:       {p['max_drawdown_pct']:>8.2f}%",
        f"  Weekly Yield: {p['weekly_yield_pct']:>8.3f}%",
        f"  Premium:      ${p['total_premium']:>8,.0f}  |  Commissions: ${p['total_commissions']:>6,.0f}",
        f"",
        f"  Cycles: {c['total']} total | {c['expired_otm']} OTM | {c['assigned']} assigned | "
        f"{c['called_away']} called | {c['early_closed']} early close",
        f"  Win Rate: {c['win_rate_pct']:.1f}%  |  Assignment Rate: {c['assignment_rate_pct']:.1f}%",
    ]
    return '\n'.join(lines)


def format_sweep_summary(sweep):
    """Format sweep results for display / Discord."""
    lines = [
        "**Wheel Strategy Parameter Sweep Results**",
        f"Tickers: {', '.join(sweep['tickers'])}",
        f"Configs tested: {sweep['configs_tested']} | Total backtests: {sweep['total_backtests']}",
        "",
        "**Top 10 Configs by Sharpe:**",
        "```",
        f"{'Config':<32s} {'Ret%':>7s} {'Sharpe':>7s} {'WR%':>5s} {'Wk%':>7s} {'DD%':>7s} {'Asn%':>5s} {'Prof%':>5s}",
        "-" * 86,
    ]

    for cfg in sweep['config_summary'][:10]:
        lines.append(
            f"{cfg['config']:<32s} {cfg['avg_return_pct']:>+6.1f}% "
            f"{cfg['avg_sharpe']:>6.2f} {cfg['avg_win_rate']:>4.0f}% "
            f"{cfg['avg_weekly_yield']:>6.3f}% {cfg['avg_max_dd']:>6.1f}% "
            f"{cfg['avg_assignment_rate']:>4.0f}% {cfg['pct_profitable']:>4.0f}%"
        )

    lines.append("```")
    lines.append("")
    lines.append("**Per-Ticker Summary:**")
    lines.append("```")
    lines.append(f"{'Ticker':<7s} {'AvgRet%':>8s} {'BestRet%':>9s} {'AvgSharpe':>10s} "
                 f"{'B&H%':>7s} {'Beats%':>7s}")
    lines.append("-" * 55)

    for ts in sweep['ticker_summary']:
        lines.append(
            f"{ts['ticker']:<7s} {ts['avg_return_pct']:>+7.1f}% {ts['best_return_pct']:>+8.1f}% "
            f"{ts['avg_sharpe']:>9.2f} {ts['buy_hold_return_pct']:>+6.1f}% "
            f"{ts['wheel_beats_bnh_pct']:>6.0f}%"
        )

    lines.append("```")
    return '\n'.join(lines)


def format_discord_summary(results_list):
    """Format multi-ticker backtest results for Discord posting."""
    if not results_list:
        return "No results."

    lines = [
        "**Wheel Strategy Historical Backtest**",
        f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "```",
        f"{'Ticker':<7s} {'Return':>8s} {'Sharpe':>7s} {'WkYld':>7s} {'WR%':>5s} "
        f"{'Asn%':>5s} {'MaxDD':>7s} {'B&H':>8s} {'vs B&H':>8s}",
        "-" * 72,
    ]

    total_value = 0
    total_initial = 0

    for r in results_list:
        if 'error' in r:
            lines.append(f"{r['ticker']:<7s} {'ERROR':>8s}")
            continue

        p = r['performance']
        c = r['cycles']
        b = r['benchmark']
        lines.append(
            f"{r['ticker']:<7s} {p['total_return_pct']:>+7.1f}% {p['sharpe']:>6.2f} "
            f"{p['weekly_yield_pct']:>6.3f}% {c['win_rate_pct']:>4.0f}% "
            f"{c['assignment_rate_pct']:>4.0f}% {p['max_drawdown_pct']:>6.1f}% "
            f"{b['buy_hold_return_pct']:>+7.1f}% {b['wheel_vs_bnh_pct']:>+7.1f}%"
        )
        total_value += p['final_value']
        total_initial += r['parameters']['capital']

    if total_initial > 0:
        port_return = (total_value - total_initial) / total_initial * 100
        lines.append("-" * 72)
        lines.append(f"{'TOTAL':<7s} {port_return:>+7.1f}%")

    lines.append("```")
    return '\n'.join(lines)


# =============================================================================
# CLI
# =============================================================================

def cmd_collect(args):
    """Download and cache historical data."""
    tickers = args.tickers.split(',') if args.tickers else DEFAULT_TICKERS
    collector = DataCollector(tickers=tickers, months=args.months)
    collector.collect_all()


def cmd_backtest(args):
    """Run backtest on cached data."""
    tickers = args.tickers.split(',') if args.tickers else DEFAULT_TICKERS

    results = []
    for ticker in tickers:
        data = DataCollector.load_cached(ticker)
        if not data or 'error' in data:
            print(f"{ticker}: no cached data (run --collect first)")
            results.append({'ticker': ticker, 'error': 'no cached data'})
            continue

        try:
            bt = WheelHistoricalBacktest(
                ticker, data,
                capital=args.capital,
                csp_delta=args.delta,
                cc_delta=min(args.delta + 0.05, 0.45),
                target_dte=args.dte,
                early_close_pct=args.early_close if args.early_close else None,
            )
            result = bt.run()
            results.append(result)
            print(format_backtest_result(result))
            print()
        except Exception as e:
            print(f"{ticker}: FAILED — {e}")
            traceback.print_exc()
            results.append({'ticker': ticker, 'error': str(e)})

    # Summary
    print("\n" + "=" * 70)
    print(format_discord_summary(results))

    # Save
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    filepath = RESULTS_DIR / f'backtest_{ts}.json'
    with open(filepath, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'parameters': {
                'capital': args.capital,
                'delta': args.delta,
                'dte': args.dte,
                'early_close': args.early_close,
                'months': args.months,
            },
            'results': results,
        }, f, indent=2, default=str)
    print(f"\nResults saved: {filepath}")


def cmd_sweep(args):
    """Run parameter sweep."""
    tickers = args.tickers.split(',') if args.tickers else DEFAULT_TICKERS
    sweep = ParameterSweep(tickers=tickers, months=args.months, capital_per_ticker=args.capital)
    result = sweep.run()
    print("\n" + format_sweep_summary(result))


def cmd_report(args):
    """Show latest results from disk."""
    # Find most recent results
    backtest_files = sorted(RESULTS_DIR.glob('backtest_*.json'), reverse=True)
    sweep_files = sorted(RESULTS_DIR.glob('sweep_*.json'), reverse=True)

    if not backtest_files and not sweep_files:
        print("No results found. Run --backtest or --sweep first.")
        print(f"Results directory: {RESULTS_DIR}")
        return

    if sweep_files:
        latest = sweep_files[0]
        print(f"Latest sweep: {latest.name}")
        with open(latest, 'r') as f:
            data = json.load(f)
        print(format_sweep_summary(data))
        print()

    if backtest_files:
        latest = backtest_files[0]
        print(f"Latest backtest: {latest.name}")
        with open(latest, 'r') as f:
            data = json.load(f)
        for r in data.get('results', []):
            if 'error' not in r:
                print(format_backtest_result(r))
                print()
        print(format_discord_summary(data.get('results', [])))


def main():
    parser = argparse.ArgumentParser(
        description='Historical Wheel Strategy Backtest (IV-calibrated)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python historical_backtest.py --collect
  python historical_backtest.py --backtest --tickers INTC,SOFI,PLTR
  python historical_backtest.py --sweep --months 12
  python historical_backtest.py --report
        """,
    )

    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--collect', action='store_true',
                      help='Download and cache historical data + IV calibration')
    mode.add_argument('--backtest', action='store_true',
                      help='Run backtest with specified parameters')
    mode.add_argument('--sweep', action='store_true',
                      help='Full parameter sweep (delta x DTE x early-close)')
    mode.add_argument('--report', action='store_true',
                      help='Show latest saved results')

    parser.add_argument('--tickers', type=str, default=None,
                        help=f'Comma-separated tickers (default: {",".join(DEFAULT_TICKERS)})')
    parser.add_argument('--months', type=int, default=12,
                        help='Months of history to use (default: 12)')
    parser.add_argument('--capital', type=float, default=10_000,
                        help='Capital per ticker (default: 10000)')
    parser.add_argument('--delta', type=float, default=0.30,
                        help='CSP delta target (default: 0.30)')
    parser.add_argument('--dte', type=int, default=7,
                        help='Target DTE (default: 7)')
    parser.add_argument('--early-close', type=float, default=None,
                        help='Early close at N%% of max profit (e.g., 0.50 for 50%%)')

    args = parser.parse_args()

    if args.collect:
        cmd_collect(args)
    elif args.backtest:
        cmd_backtest(args)
    elif args.sweep:
        cmd_sweep(args)
    elif args.report:
        cmd_report(args)


if __name__ == '__main__':
    main()
