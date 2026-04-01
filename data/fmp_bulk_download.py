#!/usr/bin/env python3
"""
FMP Bulk Data Downloader — Uses /stable/ API endpoints.

Downloads and stores financial data for 88+ tickers before subscription expires.

Usage:
    python fmp_bulk_download.py                    # Full download
    python fmp_bulk_download.py --resume           # Resume interrupted download
    python fmp_bulk_download.py --category prices  # Just one category
    python fmp_bulk_download.py --estimate         # Estimate API calls
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, date
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

# ── Config ────────────────────────────────────────────────────────────────────
FMP_KEY = 'GJsH5DDiI7Fv0qtc1NaoQhj8awq0XwM8'
BASE = 'https://financialmodelingprep.com/stable'
RATE_LIMIT = 250
MIN_DELAY = 60.0 / RATE_LIMIT

DATA_DIR = Path(__file__).resolve().parent / 'fmp_archive'
PROGRESS_FILE = DATA_DIR / '_progress.json'

TICKERS = sorted(set([
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'AMD', 'INTC',
    'JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'SCHW',
    'DIS', 'NFLX', 'UBER', 'ABNB', 'PYPL', 'SQ', 'SHOP',
    'PFE', 'MRNA', 'ABBV', 'JNJ', 'UNH', 'LLY',
    'XOM', 'CVX', 'OXY', 'SLB',
    'BA', 'CAT', 'DE', 'GE', 'RTX',
    'PLTR', 'SOFI', 'COIN', 'HOOD', 'RIVN', 'LCID', 'NIO',
    'SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'SLV', 'USO', 'EEM',
    'MARA', 'RIOT', 'SMCI', 'ARM', 'CRWD', 'SNOW', 'DDOG', 'NET',
    'V', 'MA', 'COST', 'WMT', 'HD', 'LOW', 'TGT',
    'CRM', 'ORCL', 'ADBE', 'NOW', 'PANW',
    'MCD', 'SBUX', 'KO', 'PEP', 'PG', 'CL',
    'F', 'GM', 'TM', 'T', 'VZ', 'TMUS',
    'BRK-B', 'BLK', 'AXP',
]))

# ── HTTP Helper ───────────────────────────────────────────────────────────────
call_count = 0
last_call_time = 0


def fmp_get(path, params=None):
    """Rate-limited FMP /stable/ API call."""
    global call_count, last_call_time

    elapsed = time.time() - last_call_time
    if elapsed < MIN_DELAY:
        time.sleep(MIN_DELAY - elapsed)

    url = f"{BASE}/{path}?apikey={FMP_KEY}"
    if params:
        for k, v in params.items():
            url += f"&{k}={v}"

    try:
        req = Request(url, headers={'User-Agent': 'FMP-Bulk/1.0'})
        resp = urlopen(req, timeout=30)
        data = json.loads(resp.read().decode('utf-8'))
        call_count += 1
        last_call_time = time.time()
        if call_count % 100 == 0:
            print(f"  [{call_count} API calls]")
        return data
    except HTTPError as e:
        if e.code == 429:
            print(f"  RATE LIMITED — sleeping 60s...")
            time.sleep(60)
            return fmp_get(path, params)
        else:
            return None
    except (URLError, TimeoutError, json.JSONDecodeError):
        return None


def save(filepath, data):
    filepath = Path(filepath)
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=1, default=str)


def load_progress():
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {'completed': {}, 'started': datetime.now().isoformat()}


def save_progress(progress):
    progress['last_updated'] = datetime.now().isoformat()
    progress['total_api_calls'] = call_count
    save(PROGRESS_FILE, progress)


def done(progress, key):
    return key in progress.get('completed', {})


def mark(progress, key):
    progress.setdefault('completed', {})[key] = True


# ── Download Categories ───────────────────────────────────────────────────────

def download_indices(progress):
    """S&P 500, NASDAQ, Dow Jones constituents."""
    print("\n=== INDEX CONSTITUENTS ===")
    d = DATA_DIR / 'indices'

    for name, endpoint in [('sp500', 'sp500-constituent'), ('nasdaq', 'nasdaq-constituent'),
                            ('dowjones', 'dowjones-constituent')]:
        if done(progress, f'idx_{name}'):
            print(f"  {name}: skip (done)")
            continue
        data = fmp_get(endpoint)
        if data:
            save(d / f'{name}.json', data)
            print(f"  {name}: {len(data)} companies")
        mark(progress, f'idx_{name}')
        save_progress(progress)


def download_financials(tickers, progress):
    """Income, balance sheet, cash flow — annual + quarterly."""
    print(f"\n=== FINANCIAL STATEMENTS ({len(tickers)} tickers) ===")
    d = DATA_DIR / 'financials'

    stmts = [
        ('income', 'income-statement'),
        ('balance', 'balance-sheet-statement'),
        ('cashflow', 'cash-flow-statement'),
    ]

    for ticker in tickers:
        if done(progress, f'fin_{ticker}'):
            continue
        for stype, endpoint in stmts:
            for period in ['annual', 'quarter']:
                data = fmp_get(endpoint, {'symbol': ticker, 'period': period, 'limit': '80'})
                if data:
                    save(d / ticker / f'{stype}_{period}.json', data)
        mark(progress, f'fin_{ticker}')
        save_progress(progress)
        print(f"  {ticker}: financials done")


def download_metrics(tickers, progress):
    """Key metrics, ratios, profiles."""
    print(f"\n=== KEY METRICS & PROFILES ({len(tickers)} tickers) ===")
    d = DATA_DIR / 'metrics'

    for ticker in tickers:
        if done(progress, f'met_{ticker}'):
            continue

        for name, endpoint in [('key_metrics', 'key-metrics'), ('ratios', 'ratios')]:
            for period in ['annual', 'quarter']:
                data = fmp_get(endpoint, {'symbol': ticker, 'period': period, 'limit': '80'})
                if data:
                    save(d / ticker / f'{name}_{period}.json', data)

        profile = fmp_get('profile', {'symbol': ticker})
        if profile:
            save(d / ticker / 'profile.json', profile)

        mark(progress, f'met_{ticker}')
        save_progress(progress)
        print(f"  {ticker}: metrics done")


def download_earnings(tickers, progress):
    """Analyst estimates + full earnings calendar."""
    print(f"\n=== EARNINGS & ANALYST ({len(tickers)} tickers) ===")
    d = DATA_DIR / 'earnings'

    for ticker in tickers:
        if done(progress, f'earn_{ticker}'):
            continue

        # Analyst estimates (confirmed working)
        for period in ['annual', 'quarter']:
            data = fmp_get('analyst-estimates', {'symbol': ticker, 'period': period, 'limit': '40'})
            if data:
                save(d / ticker / f'analyst_estimates_{period}.json', data)

        mark(progress, f'earn_{ticker}')
        save_progress(progress)

    # Full economic calendar (confirmed: 8000+ events)
    if not done(progress, 'econ_calendar'):
        for year in [2020, 2021, 2022, 2023, 2024, 2025, 2026]:
            data = fmp_get('economic-calendar', {
                'from': f'{year}-01-01', 'to': f'{year}-12-31'
            })
            if data:
                save(d / f'economic_calendar_{year}.json', data)
                print(f"  Economic calendar {year}: {len(data)} events")
        mark(progress, 'econ_calendar')
        save_progress(progress)

    print(f"  Earnings & analyst: done")


def download_prices(tickers, progress):
    """Full daily price history since 2010."""
    print(f"\n=== HISTORICAL PRICES ({len(tickers)} tickers) ===")
    d = DATA_DIR / 'prices'

    for ticker in tickers:
        if done(progress, f'price_{ticker}'):
            continue

        # Download in year chunks to avoid timeouts
        all_data = []
        for year in range(2010, 2027):
            data = fmp_get('historical-price-eod/full', {
                'symbol': ticker,
                'from': f'{year}-01-01',
                'to': f'{year}-12-31',
            })
            if data and isinstance(data, list):
                all_data.extend(data)
            elif data and isinstance(data, dict) and 'historical' in data:
                all_data.extend(data['historical'])

        if all_data:
            save(d / f'{ticker}_daily.json', all_data)
            print(f"  {ticker}: {len(all_data)} days")
        else:
            print(f"  {ticker}: no price data")

        mark(progress, f'price_{ticker}')
        save_progress(progress)


def download_extra(tickers, progress):
    """Sector performance, screener snapshots, misc."""
    print(f"\n=== EXTRA DATA ===")
    d = DATA_DIR / 'extra'

    # Sector performance
    if not done(progress, 'sectors'):
        data = fmp_get('sector-performance')
        if data:
            save(d / 'sector_performance.json', data)
            print(f"  Sector performance: {len(data)} sectors")

        hist = fmp_get('historical-sectors-performance')
        if hist:
            save(d / 'sector_performance_historical.json', hist)
            print(f"  Sector history: {len(hist)} entries")
        mark(progress, 'sectors')
        save_progress(progress)

    # Market gainers/losers/actives
    for name in ['gainers', 'losers', 'actives']:
        if not done(progress, f'market_{name}'):
            data = fmp_get(f'stock_market/{name}')
            if data:
                save(d / f'market_{name}.json', data)
                print(f"  {name}: {len(data)} stocks")
            mark(progress, f'market_{name}')
            save_progress(progress)

    # Stock screener: large cap + dividend
    if not done(progress, 'screener'):
        for label, params in [
            ('large_cap', {'marketCapMoreThan': '1000000000', 'volumeMoreThan': '500000',
                          'isActivelyTrading': 'true', 'limit': '5000'}),
            ('dividend', {'dividendMoreThan': '0.01', 'marketCapMoreThan': '5000000000', 'limit': '2000'}),
        ]:
            data = fmp_get('stock-screener', params)
            if data:
                save(d / f'screener_{label}.json', data)
                print(f"  Screener {label}: {len(data)} stocks")
        mark(progress, 'screener')
        save_progress(progress)


# ── Main ──────────────────────────────────────────────────────────────────────

CATEGORIES = {
    'indices': download_indices,
    'financials': lambda p: download_financials(TICKERS, p),
    'metrics': lambda p: download_metrics(TICKERS, p),
    'earnings': lambda p: download_earnings(TICKERS, p),
    'prices': lambda p: download_prices(TICKERS, p),
    'extra': download_extra if True else lambda p: download_extra(TICKERS, p),
}


def main():
    parser = argparse.ArgumentParser(description='FMP Bulk Downloader (stable API)')
    parser.add_argument('--category', type=str, help='Download specific category')
    parser.add_argument('--resume', action='store_true', help='Resume interrupted download')
    parser.add_argument('--estimate', action='store_true', help='Estimate API calls')
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.estimate:
        n = len(TICKERS)
        # financials: 6/ticker, metrics: 5, earnings: 2, prices: 17 (year chunks) = 30/ticker + 20 overhead
        total = n * 30 + 50
        print(f"Estimated: {total} calls ({n} tickers × ~30 + 50 overhead)")
        print(f"At {RATE_LIMIT}/min: ~{total / RATE_LIMIT:.0f} minutes")
        return

    progress = load_progress() if args.resume else {'completed': {}, 'started': datetime.now().isoformat()}

    print(f"FMP Bulk Download (/stable/ API)")
    print(f"  Tickers: {len(TICKERS)}")
    print(f"  Data dir: {DATA_DIR}")
    print(f"  Completed: {len(progress.get('completed', {}))} items")
    print()

    start = time.time()
    try:
        if args.category:
            if args.category in CATEGORIES:
                CATEGORIES[args.category](progress)
            else:
                print(f"Unknown: {args.category}. Available: {', '.join(CATEGORIES.keys())}")
        else:
            for name, func in CATEGORIES.items():
                print(f"\n{'#'*60}")
                print(f"# {name.upper()}")
                print(f"{'#'*60}")
                try:
                    func(progress)
                except Exception as e:
                    print(f"  ERROR in {name}: {e}")
                    traceback.print_exc()
    except KeyboardInterrupt:
        print("\nInterrupted — use --resume to continue.")
    finally:
        save_progress(progress)
        elapsed = time.time() - start
        print(f"\n{'='*60}")
        print(f"API calls: {call_count} | Time: {elapsed/60:.1f}min | Items: {len(progress.get('completed', {}))}")
        print(f"Data: {DATA_DIR}")
        print(f"{'='*60}")


if __name__ == '__main__':
    main()
