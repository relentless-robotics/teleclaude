"""
Historical Options Data Collector for Wheel Strategy ML Model.

Collects:
  - Daily options chains (all strikes, puts and calls) for the last 6-12 months
  - Historical IV rank/percentile per stock
  - Historical stock prices (for HV calculation)
  - Earnings dates

Data saved to: trading_agents/wheel_strategy/data/historical/

Usage:
    python -m trading_agents.wheel_strategy.collect_options_data [--tickers AAPL,MSFT,...] [--months 12]
"""

import os
import sys
import json
import time
import logging
import argparse
import datetime
from pathlib import Path

# Setup paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

DATA_DIR = os.path.join(SCRIPT_DIR, "data", "historical")
os.makedirs(DATA_DIR, exist_ok=True)

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(DATA_DIR, "collection.log")),
    ],
)
log = logging.getLogger(__name__)

# Default wheel strategy watchlist — top candidates by screener score
# Covers diverse sectors, all optionable, high liquidity
DEFAULT_TICKERS = [
    # Core wheel targets (mentioned in portfolio / position manager)
    "WMT", "INTC", "BAC", "CSCO", "KO",
    "PFE", "NKE", "XOM", "JNJ", "PG",
    "AMD", "AAPL",
    # Extended watchlist — high IV rank candidates
    "MSFT", "AMZN", "TSLA", "META", "NVDA",
    "GOOGL", "JPM", "V", "MA", "HD",
]


def collect_stock_prices(ticker: str, months: int = 12) -> dict:
    """Fetch daily OHLCV prices for the given ticker."""
    import yfinance as yf

    log.info(f"[{ticker}] Fetching {months}mo price history...")
    period = f"{months}mo"

    try:
        df = yf.download(ticker, period=period, progress=False, auto_adjust=True)
        if df.empty:
            log.warning(f"[{ticker}] No price data returned.")
            return {}

        # Flatten multi-level columns if needed
        if hasattr(df.columns, "levels") and len(df.columns.levels) > 1:
            df.columns = df.columns.get_level_values(0)

        records = []
        for idx, row in df.iterrows():
            records.append({
                "date": idx.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            })

        result = {
            "ticker": ticker,
            "period": period,
            "count": len(records),
            "start": records[0]["date"] if records else None,
            "end": records[-1]["date"] if records else None,
            "data": records,
        }

        outfile = os.path.join(DATA_DIR, f"{ticker}_prices.json")
        with open(outfile, "w") as f:
            json.dump(result, f, indent=2)
        log.info(f"[{ticker}] Saved {len(records)} price records to {outfile}")
        return result

    except Exception as e:
        log.error(f"[{ticker}] Price fetch error: {e}")
        return {}


def compute_iv_history(ticker: str, prices: dict) -> dict:
    """
    Compute historical volatility (HV) and IV rank/percentile.

    Uses yfinance options data for current IV and HV from price history.
    IV rank = (current_iv - 52w_low_iv) / (52w_high_iv - 52w_low_iv)
    """
    import yfinance as yf
    import numpy as np

    log.info(f"[{ticker}] Computing IV history...")

    if not prices or not prices.get("data"):
        log.warning(f"[{ticker}] No price data for IV computation.")
        return {}

    data = prices["data"]
    closes = [d["close"] for d in data]

    # Compute rolling HV at different windows
    hv_windows = [10, 20, 30, 60, 90, 252]
    hv_series = {}

    for window in hv_windows:
        if len(closes) < window + 1:
            continue
        hv_vals = []
        for i in range(window, len(closes)):
            window_closes = closes[i - window : i + 1]
            log_returns = [
                np.log(window_closes[j] / window_closes[j - 1])
                for j in range(1, len(window_closes))
            ]
            hv = np.std(log_returns) * np.sqrt(252) * 100  # Annualized HV in %
            hv_vals.append({
                "date": data[i]["date"],
                "hv": round(float(hv), 2),
            })
        hv_series[f"hv_{window}d"] = hv_vals

    # Get current implied volatility from yfinance options
    current_iv = None
    iv_data_points = []

    try:
        stock = yf.Ticker(ticker)
        expirations = stock.options
        if expirations:
            # Get nearest expiration
            for exp in expirations[:3]:  # Check first 3 expirations
                try:
                    chain = stock.option_chain(exp)
                    puts = chain.puts
                    calls = chain.calls

                    # ATM IV from puts and calls
                    current_price = closes[-1]
                    atm_puts = puts.iloc[
                        (puts["strike"] - current_price).abs().argsort()[:3]
                    ]
                    atm_calls = calls.iloc[
                        (calls["strike"] - current_price).abs().argsort()[:3]
                    ]

                    put_iv = atm_puts["impliedVolatility"].mean()
                    call_iv = atm_calls["impliedVolatility"].mean()

                    if not np.isnan(put_iv) and not np.isnan(call_iv):
                        avg_iv = (put_iv + call_iv) / 2 * 100
                        iv_data_points.append({
                            "expiration": exp,
                            "put_iv": round(float(put_iv * 100), 2),
                            "call_iv": round(float(call_iv * 100), 2),
                            "avg_iv": round(float(avg_iv), 2),
                        })
                        if current_iv is None:
                            current_iv = avg_iv
                except Exception:
                    continue
    except Exception as e:
        log.warning(f"[{ticker}] Could not fetch options IV: {e}")

    # Compute IV rank using HV as proxy for historical IV range
    # IV rank = where current IV sits in the 52-week HV range
    hv_20d = hv_series.get("hv_20d", [])
    iv_rank = None
    iv_percentile = None

    if hv_20d and len(hv_20d) >= 20:
        hv_values = [h["hv"] for h in hv_20d]
        hv_52w_low = min(hv_values[-252:]) if len(hv_values) >= 252 else min(hv_values)
        hv_52w_high = max(hv_values[-252:]) if len(hv_values) >= 252 else max(hv_values)
        current_hv = hv_values[-1]

        if hv_52w_high > hv_52w_low:
            iv_rank = round((current_hv - hv_52w_low) / (hv_52w_high - hv_52w_low) * 100, 1)

        # IV percentile — % of days HV was lower than current
        below = sum(1 for h in hv_values if h < current_hv)
        iv_percentile = round(below / len(hv_values) * 100, 1)

    result = {
        "ticker": ticker,
        "current_iv": round(float(current_iv), 2) if current_iv else None,
        "iv_rank": iv_rank,
        "iv_percentile": iv_percentile,
        "hv_current_20d": hv_20d[-1]["hv"] if hv_20d else None,
        "hv_series": hv_series,
        "iv_term_structure": iv_data_points,
        "computed_at": datetime.datetime.now().isoformat(),
    }

    outfile = os.path.join(DATA_DIR, f"{ticker}_iv_history.json")
    with open(outfile, "w") as f:
        json.dump(result, f, indent=2)
    log.info(f"[{ticker}] Saved IV history (rank={iv_rank}, pctl={iv_percentile})")
    return result


def collect_options_chains(ticker: str, months: int = 6) -> int:
    """
    Collect current options chain snapshots.

    NOTE: yfinance only provides CURRENT options chains, not historical.
    For historical chains, you need a paid data provider (CBOE, OptionMetrics, etc.).
    This collects the current snapshot and appends to a JSONL file for daily collection.
    """
    import yfinance as yf

    log.info(f"[{ticker}] Fetching current options chains...")

    try:
        stock = yf.Ticker(ticker)
        expirations = stock.options

        if not expirations:
            log.warning(f"[{ticker}] No options expirations available.")
            return 0

        outfile = os.path.join(DATA_DIR, f"{ticker}_options_chains.jsonl")
        snapshot_date = datetime.datetime.now().strftime("%Y-%m-%d")
        chains_saved = 0

        for exp in expirations:
            try:
                chain = stock.option_chain(exp)

                # Process puts
                puts_data = []
                for _, row in chain.puts.iterrows():
                    puts_data.append({
                        "strike": float(row["strike"]),
                        "lastPrice": float(row["lastPrice"]),
                        "bid": float(row["bid"]),
                        "ask": float(row["ask"]),
                        "volume": int(row["volume"]) if not _is_nan(row["volume"]) else 0,
                        "openInterest": int(row["openInterest"]) if not _is_nan(row["openInterest"]) else 0,
                        "impliedVolatility": round(float(row["impliedVolatility"]), 4) if not _is_nan(row["impliedVolatility"]) else None,
                        "inTheMoney": bool(row["inTheMoney"]),
                    })

                # Process calls
                calls_data = []
                for _, row in chain.calls.iterrows():
                    calls_data.append({
                        "strike": float(row["strike"]),
                        "lastPrice": float(row["lastPrice"]),
                        "bid": float(row["bid"]),
                        "ask": float(row["ask"]),
                        "volume": int(row["volume"]) if not _is_nan(row["volume"]) else 0,
                        "openInterest": int(row["openInterest"]) if not _is_nan(row["openInterest"]) else 0,
                        "impliedVolatility": round(float(row["impliedVolatility"]), 4) if not _is_nan(row["impliedVolatility"]) else None,
                        "inTheMoney": bool(row["inTheMoney"]),
                    })

                record = {
                    "snapshot_date": snapshot_date,
                    "ticker": ticker,
                    "expiration": exp,
                    "puts": puts_data,
                    "calls": calls_data,
                    "puts_count": len(puts_data),
                    "calls_count": len(calls_data),
                }

                with open(outfile, "a") as f:
                    f.write(json.dumps(record) + "\n")
                chains_saved += 1

            except Exception as e:
                log.warning(f"[{ticker}] Error fetching chain for {exp}: {e}")
                continue

        log.info(f"[{ticker}] Saved {chains_saved} option chains ({len(expirations)} expirations)")
        return chains_saved

    except Exception as e:
        log.error(f"[{ticker}] Options chain error: {e}")
        return 0


def collect_earnings(tickers: list) -> dict:
    """Collect earnings dates for all tickers."""
    import yfinance as yf

    log.info(f"Fetching earnings calendar for {len(tickers)} tickers...")

    earnings = {}

    for ticker in tickers:
        try:
            stock = yf.Ticker(ticker)
            cal = stock.calendar

            earnings_info = {
                "ticker": ticker,
            }

            # Handle different yfinance calendar formats
            if isinstance(cal, dict):
                if "Earnings Date" in cal:
                    dates = cal["Earnings Date"]
                    if isinstance(dates, list):
                        earnings_info["next_earnings"] = [
                            d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)
                            for d in dates
                        ]
                    else:
                        earnings_info["next_earnings"] = [str(dates)]
                if "Dividend Date" in cal:
                    d = cal["Dividend Date"]
                    earnings_info["dividend_date"] = (
                        d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)
                    )
                if "Ex-Dividend Date" in cal:
                    d = cal["Ex-Dividend Date"]
                    earnings_info["ex_dividend_date"] = (
                        d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)
                    )
            elif hasattr(cal, "to_dict"):
                # DataFrame format
                cal_dict = cal.to_dict()
                earnings_info["raw"] = {
                    str(k): str(v) for k, v in cal_dict.items()
                }

            # Also get historical earnings dates from info
            info = stock.info or {}
            if info.get("mostRecentQuarter"):
                mrq = info["mostRecentQuarter"]
                if isinstance(mrq, (int, float)):
                    earnings_info["most_recent_quarter"] = datetime.datetime.fromtimestamp(mrq).strftime("%Y-%m-%d")

            earnings[ticker] = earnings_info
            log.info(f"[{ticker}] Earnings info collected.")

        except Exception as e:
            log.warning(f"[{ticker}] Earnings fetch error: {e}")
            earnings[ticker] = {"ticker": ticker, "error": str(e)}

        time.sleep(0.3)  # Rate limit

    outfile = os.path.join(DATA_DIR, "earnings_calendar.json")
    result = {
        "collected_at": datetime.datetime.now().isoformat(),
        "count": len(earnings),
        "earnings": earnings,
    }

    with open(outfile, "w") as f:
        json.dump(result, f, indent=2)
    log.info(f"Saved earnings calendar for {len(earnings)} tickers to {outfile}")
    return result


def _is_nan(val) -> bool:
    """Check if value is NaN."""
    try:
        import math
        return math.isnan(float(val))
    except (TypeError, ValueError):
        return False


def collect_all(tickers: list, months: int = 12):
    """Run full data collection pipeline for all tickers."""
    log.info(f"=== Starting data collection for {len(tickers)} tickers, {months} months ===")
    log.info(f"Tickers: {', '.join(tickers)}")
    log.info(f"Output: {DATA_DIR}")

    total_start = time.time()
    results = {
        "tickers": tickers,
        "months": months,
        "started_at": datetime.datetime.now().isoformat(),
        "status": {},
    }

    for i, ticker in enumerate(tickers, 1):
        ticker_start = time.time()
        log.info(f"\n{'='*60}")
        log.info(f"[{i}/{len(tickers)}] Processing {ticker}...")
        log.info(f"{'='*60}")

        status = {"ticker": ticker}

        # 1. Stock prices
        try:
            prices = collect_stock_prices(ticker, months=months)
            status["prices"] = "OK" if prices else "EMPTY"
            status["price_records"] = prices.get("count", 0) if prices else 0
        except Exception as e:
            status["prices"] = f"ERROR: {e}"
            prices = {}

        time.sleep(1)  # Rate limit

        # 2. IV history
        try:
            iv = compute_iv_history(ticker, prices)
            status["iv_history"] = "OK" if iv else "EMPTY"
            status["iv_rank"] = iv.get("iv_rank") if iv else None
        except Exception as e:
            status["iv_history"] = f"ERROR: {e}"

        time.sleep(1)

        # 3. Options chains
        try:
            chains = collect_options_chains(ticker)
            status["options_chains"] = "OK" if chains > 0 else "EMPTY"
            status["chains_count"] = chains
        except Exception as e:
            status["options_chains"] = f"ERROR: {e}"

        time.sleep(1)

        elapsed = time.time() - ticker_start
        status["elapsed_sec"] = round(elapsed, 1)
        results["status"][ticker] = status

        log.info(f"[{ticker}] Done in {elapsed:.1f}s — prices={status.get('prices')}, "
                 f"iv={status.get('iv_history')}, chains={status.get('options_chains')}")

    # 4. Earnings calendar (all tickers at once)
    try:
        earnings = collect_earnings(tickers)
        results["earnings"] = "OK"
    except Exception as e:
        results["earnings"] = f"ERROR: {e}"
        log.error(f"Earnings collection error: {e}")

    total_elapsed = time.time() - total_start
    results["completed_at"] = datetime.datetime.now().isoformat()
    results["total_elapsed_sec"] = round(total_elapsed, 1)

    # Save summary
    summary_file = os.path.join(DATA_DIR, "collection_summary.json")
    with open(summary_file, "w") as f:
        json.dump(results, f, indent=2)

    log.info(f"\n{'='*60}")
    log.info(f"COLLECTION COMPLETE in {total_elapsed:.0f}s")
    log.info(f"{'='*60}")

    # Print summary table
    ok_count = sum(1 for s in results["status"].values() if s.get("prices") == "OK")
    err_count = len(tickers) - ok_count
    log.info(f"Success: {ok_count}/{len(tickers)}, Errors: {err_count}")
    log.info(f"Summary saved to: {summary_file}")

    return results


def main():
    parser = argparse.ArgumentParser(description="Collect historical options data for wheel strategy")
    parser.add_argument("--tickers", type=str, default=None,
                        help="Comma-separated ticker list (default: wheel watchlist)")
    parser.add_argument("--months", type=int, default=12,
                        help="Months of price history (default: 12)")
    parser.add_argument("--prices-only", action="store_true",
                        help="Only collect price data (skip options)")
    parser.add_argument("--chains-only", action="store_true",
                        help="Only collect current options chains")
    parser.add_argument("--earnings-only", action="store_true",
                        help="Only collect earnings calendar")

    args = parser.parse_args()

    tickers = args.tickers.split(",") if args.tickers else DEFAULT_TICKERS

    if args.prices_only:
        for t in tickers:
            collect_stock_prices(t, months=args.months)
            time.sleep(1)
    elif args.chains_only:
        for t in tickers:
            collect_options_chains(t)
            time.sleep(1)
    elif args.earnings_only:
        collect_earnings(tickers)
    else:
        collect_all(tickers, months=args.months)


if __name__ == "__main__":
    main()
