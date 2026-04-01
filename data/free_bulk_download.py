#!/usr/bin/env python3
"""
Free Bulk Data Downloader — yfinance + SEC EDGAR + FRED

Downloads and stores financial data for 88 tickers using FREE APIs only.

Sources:
  1. yfinance — daily prices (10yr), quarterly financials, earnings, dividends,
                analyst recs, key stats
  2. SEC EDGAR — CIK lookup, 13F institutional holders, Form 4 insider trading
  3. FRED — macro series (VIX, treasuries, unemployment, CPI, GDP, etc.)

Usage:
    python free_bulk_download.py                          # Full download
    python free_bulk_download.py --resume                 # Resume interrupted
    python free_bulk_download.py --category prices        # Just one category
    python free_bulk_download.py --estimate               # Estimate time/size
    python free_bulk_download.py --category macro         # Just FRED macro data
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, date, timedelta
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

# ── Config ────────────────────────────────────────────────────────────────────

FRED_KEY = '09ec97a79c3e93445b817f2614956697'
SEC_USER_AGENT = 'TeleClaude research@relentlessrobotics.com'

DATA_DIR = Path(__file__).resolve().parent / 'market_archive'
PROGRESS_FILE = DATA_DIR / '_progress.json'

YFINANCE_DELAY = 2.0    # seconds between tickers (avoid throttling)
FRED_DELAY = 1.0         # seconds between FRED requests
SEC_DELAY = 0.15          # SEC asks for max 10 req/sec

# ── Ticker Universe ──────────────────────────────────────────────────────────

TICKERS = [
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
    'F', 'GM', 'TM',
    'T', 'VZ', 'TMUS',
    'BRK-B', 'BLK', 'AXP',
]

# ETFs don't have financials/earnings — skip those categories for them
ETFS = {'SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'SLV', 'USO', 'EEM'}

FRED_SERIES = {
    'VIXCLS': 'VIX Close',
    'DGS10': '10-Year Treasury Rate',
    'DGS2': '2-Year Treasury Rate',
    'FEDFUNDS': 'Federal Funds Rate',
    'UNRATE': 'Unemployment Rate',
    'CPIAUCSL': 'CPI All Urban Consumers',
    'GDP': 'Gross Domestic Product',
    'T10Y2Y': '10Y-2Y Treasury Spread',
    'BAMLH0A0HYM2': 'ICE BofA HY Option-Adjusted Spread',
}

CATEGORIES = ['prices', 'financials', 'earnings', 'dividends', 'institutional', 'macro']

# ── Helpers ───────────────────────────────────────────────────────────────────

def ensure_dirs():
    """Create all output directories."""
    for cat in CATEGORIES:
        (DATA_DIR / cat).mkdir(parents=True, exist_ok=True)

def load_progress():
    """Load progress file for resume capability."""
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, 'r') as f:
            return json.load(f)
    return {'completed': {}, 'started': datetime.now().isoformat(), 'errors': []}

def save_progress(progress):
    """Save progress file."""
    progress['last_updated'] = datetime.now().isoformat()
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(progress, f, indent=2)

def is_done(progress, category, key):
    """Check if a specific download task is already completed."""
    return progress.get('completed', {}).get(category, {}).get(key, False)

def mark_done(progress, category, key):
    """Mark a specific download task as completed."""
    if category not in progress['completed']:
        progress['completed'][category] = {}
    progress['completed'][category][key] = datetime.now().isoformat()
    save_progress(progress)

def save_json(data, category, filename):
    """Save data as JSON file."""
    filepath = DATA_DIR / category / filename
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2, default=str)
    return filepath

def fetch_url(url, headers=None, timeout=30):
    """Fetch URL with error handling."""
    req = Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except HTTPError as e:
        if e.code == 429:
            print(f"    [RATE LIMITED] Waiting 60s...")
            time.sleep(60)
            return fetch_url(url, headers, timeout)
        raise
    except Exception:
        raise

def df_to_dict(df):
    """Convert a pandas DataFrame to a JSON-serializable dict."""
    if df is None or (hasattr(df, 'empty') and df.empty):
        return None
    # Handle both regular DataFrames and those with DatetimeIndex
    result = {}
    for col in df.columns:
        result[str(col)] = {}
        for idx in df.index:
            val = df.loc[idx, col]
            # Convert numpy types to Python types
            if hasattr(val, 'item'):
                val = val.item()
            if hasattr(val, 'isoformat'):
                val = val.isoformat()
            if str(val) == 'nan' or str(val) == 'NaN':
                val = None
            result[str(col)][str(idx)] = val
    return result

# ── yfinance Downloads ────────────────────────────────────────────────────────

def download_prices(ticker, progress):
    """Download 10yr daily prices via yfinance."""
    if is_done(progress, 'prices', ticker):
        return True

    import yfinance as yf
    print(f"  [prices] {ticker}...", end=' ', flush=True)

    try:
        tk = yf.Ticker(ticker)
        hist = tk.history(period='10y', auto_adjust=True)
        if hist.empty:
            print("NO DATA")
            mark_done(progress, 'prices', ticker)
            return True

        # Convert to records format
        records = []
        for idx, row in hist.iterrows():
            rec = {
                'date': idx.strftime('%Y-%m-%d'),
                'open': round(float(row['Open']), 4) if not str(row['Open']) == 'nan' else None,
                'high': round(float(row['High']), 4) if not str(row['High']) == 'nan' else None,
                'low': round(float(row['Low']), 4) if not str(row['Low']) == 'nan' else None,
                'close': round(float(row['Close']), 4) if not str(row['Close']) == 'nan' else None,
                'volume': int(row['Volume']) if not str(row['Volume']) == 'nan' else None,
            }
            records.append(rec)

        save_json({
            'ticker': ticker,
            'downloaded': datetime.now().isoformat(),
            'rows': len(records),
            'start': records[0]['date'] if records else None,
            'end': records[-1]['date'] if records else None,
            'data': records,
        }, 'prices', f'{ticker}.json')

        print(f"{len(records)} days")
        mark_done(progress, 'prices', ticker)
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        progress.setdefault('errors', []).append({
            'category': 'prices', 'ticker': ticker,
            'error': str(e), 'time': datetime.now().isoformat()
        })
        save_progress(progress)
        return False


def download_financials(ticker, progress):
    """Download quarterly financials (income, balance sheet, cash flow) + key stats."""
    if ticker in ETFS:
        return True
    if is_done(progress, 'financials', ticker):
        return True

    import yfinance as yf
    print(f"  [financials] {ticker}...", end=' ', flush=True)

    try:
        tk = yf.Ticker(ticker)
        data = {
            'ticker': ticker,
            'downloaded': datetime.now().isoformat(),
        }

        # Quarterly financials
        try:
            data['income_quarterly'] = df_to_dict(tk.quarterly_income_stmt)
        except Exception:
            data['income_quarterly'] = None

        try:
            data['income_annual'] = df_to_dict(tk.income_stmt)
        except Exception:
            data['income_annual'] = None

        try:
            data['balance_quarterly'] = df_to_dict(tk.quarterly_balance_sheet)
        except Exception:
            data['balance_quarterly'] = None

        try:
            data['balance_annual'] = df_to_dict(tk.balance_sheet)
        except Exception:
            data['balance_annual'] = None

        try:
            data['cashflow_quarterly'] = df_to_dict(tk.quarterly_cashflow)
        except Exception:
            data['cashflow_quarterly'] = None

        try:
            data['cashflow_annual'] = df_to_dict(tk.cashflow)
        except Exception:
            data['cashflow_annual'] = None

        # Key stats / info
        try:
            info = tk.info
            # Filter to numeric/string values (skip large nested objects)
            data['info'] = {k: v for k, v in info.items()
                          if isinstance(v, (int, float, str, bool, type(None)))}
        except Exception:
            data['info'] = None

        # Analyst recommendations
        try:
            recs = tk.recommendations
            if recs is not None and not recs.empty:
                rec_list = []
                for idx, row in recs.iterrows():
                    rec = {'date': str(idx)}
                    for col in recs.columns:
                        val = row[col]
                        if hasattr(val, 'item'):
                            val = val.item()
                        rec[col] = val
                    rec_list.append(rec)
                data['recommendations'] = rec_list
            else:
                data['recommendations'] = None
        except Exception:
            data['recommendations'] = None

        save_json(data, 'financials', f'{ticker}.json')

        sections = sum(1 for k in ['income_quarterly', 'balance_quarterly',
                                     'cashflow_quarterly', 'info', 'recommendations']
                      if data.get(k) is not None)
        print(f"{sections}/5 sections")
        mark_done(progress, 'financials', ticker)
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        progress.setdefault('errors', []).append({
            'category': 'financials', 'ticker': ticker,
            'error': str(e), 'time': datetime.now().isoformat()
        })
        save_progress(progress)
        return False


def download_earnings(ticker, progress):
    """Download earnings dates and history."""
    if ticker in ETFS:
        return True
    if is_done(progress, 'earnings', ticker):
        return True

    import yfinance as yf
    print(f"  [earnings] {ticker}...", end=' ', flush=True)

    try:
        tk = yf.Ticker(ticker)
        data = {
            'ticker': ticker,
            'downloaded': datetime.now().isoformat(),
        }

        # Earnings dates
        try:
            ed = tk.earnings_dates
            if ed is not None and not ed.empty:
                earn_list = []
                for idx, row in ed.iterrows():
                    rec = {'date': str(idx)}
                    for col in ed.columns:
                        val = row[col]
                        if hasattr(val, 'item'):
                            val = val.item()
                        if str(val) == 'nan' or str(val) == 'NaN':
                            val = None
                        rec[col] = val
                    earn_list.append(rec)
                data['earnings_dates'] = earn_list
            else:
                data['earnings_dates'] = None
        except Exception:
            data['earnings_dates'] = None

        # Earnings history (EPS actual vs estimate)
        try:
            eh = tk.earnings_history
            if eh is not None and not eh.empty:
                data['earnings_history'] = df_to_dict(eh)
            else:
                data['earnings_history'] = None
        except Exception:
            data['earnings_history'] = None

        # Calendar (next earnings date, ex-dividend, etc.)
        try:
            cal = tk.calendar
            if cal is not None:
                if isinstance(cal, dict):
                    # Convert any date objects
                    clean_cal = {}
                    for k, v in cal.items():
                        if hasattr(v, 'isoformat'):
                            clean_cal[k] = v.isoformat()
                        elif isinstance(v, list):
                            clean_cal[k] = [str(x) for x in v]
                        else:
                            clean_cal[k] = v
                    data['calendar'] = clean_cal
                else:
                    data['calendar'] = df_to_dict(cal)
            else:
                data['calendar'] = None
        except Exception:
            data['calendar'] = None

        save_json(data, 'earnings', f'{ticker}.json')

        sections = sum(1 for k in ['earnings_dates', 'earnings_history', 'calendar']
                      if data.get(k) is not None)
        print(f"{sections}/3 sections")
        mark_done(progress, 'earnings', ticker)
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        progress.setdefault('errors', []).append({
            'category': 'earnings', 'ticker': ticker,
            'error': str(e), 'time': datetime.now().isoformat()
        })
        save_progress(progress)
        return False


def download_dividends(ticker, progress):
    """Download dividend history and stock splits."""
    if is_done(progress, 'dividends', ticker):
        return True

    import yfinance as yf
    print(f"  [dividends] {ticker}...", end=' ', flush=True)

    try:
        tk = yf.Ticker(ticker)
        data = {
            'ticker': ticker,
            'downloaded': datetime.now().isoformat(),
        }

        # Dividends
        try:
            divs = tk.dividends
            if divs is not None and len(divs) > 0:
                div_list = [{'date': idx.strftime('%Y-%m-%d'), 'dividend': float(v)}
                           for idx, v in divs.items()]
                data['dividends'] = div_list
            else:
                data['dividends'] = []
        except Exception:
            data['dividends'] = []

        # Stock splits
        try:
            splits = tk.splits
            if splits is not None and len(splits) > 0:
                split_list = [{'date': idx.strftime('%Y-%m-%d'), 'ratio': float(v)}
                             for idx, v in splits.items()]
                data['splits'] = split_list
            else:
                data['splits'] = []
        except Exception:
            data['splits'] = []

        save_json(data, 'dividends', f'{ticker}.json')
        print(f"{len(data['dividends'])} divs, {len(data['splits'])} splits")
        mark_done(progress, 'dividends', ticker)
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        progress.setdefault('errors', []).append({
            'category': 'dividends', 'ticker': ticker,
            'error': str(e), 'time': datetime.now().isoformat()
        })
        save_progress(progress)
        return False


# ── SEC EDGAR Downloads ───────────────────────────────────────────────────────

def get_sec_cik(ticker):
    """Look up CIK number for a ticker from SEC EDGAR."""
    # SEC maintains a ticker->CIK mapping file
    url = 'https://www.sec.gov/files/company_tickers.json'
    headers = {'User-Agent': SEC_USER_AGENT}

    try:
        data = fetch_url(url, headers)
        # Data is {0: {cik_str, ticker, title}, 1: {...}, ...}
        ticker_upper = ticker.upper().replace('-', '.')  # BRK-B -> BRK.B for SEC
        for entry in data.values():
            if entry.get('ticker', '').upper() == ticker_upper:
                return str(entry['cik_str']).zfill(10)
        # Try without dot replacement
        for entry in data.values():
            if entry.get('ticker', '').upper() == ticker.upper():
                return str(entry['cik_str']).zfill(10)
    except Exception as e:
        print(f"    CIK lookup failed: {e}")
    return None


def download_institutional(ticker, progress):
    """Download institutional holders (13F) and insider trading (Form 4) from SEC."""
    if ticker in ETFS:
        return True
    if is_done(progress, 'institutional', ticker):
        return True

    print(f"  [institutional] {ticker}...", end=' ', flush=True)
    headers = {'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json'}

    try:
        data = {
            'ticker': ticker,
            'downloaded': datetime.now().isoformat(),
        }

        # Step 1: Get CIK
        cik = get_sec_cik(ticker)
        if not cik:
            print("NO CIK")
            data['cik'] = None
            data['filings_13f'] = None
            data['filings_form4'] = None
            save_json(data, 'institutional', f'{ticker}.json')
            mark_done(progress, 'institutional', ticker)
            return True

        data['cik'] = cik
        time.sleep(SEC_DELAY)

        # Step 2: Get company filings index
        filings_url = f'https://data.sec.gov/submissions/CIK{cik}.json'
        try:
            company_data = fetch_url(filings_url, headers)
            data['company_name'] = company_data.get('name', '')
            data['sic'] = company_data.get('sic', '')
            data['sic_description'] = company_data.get('sicDescription', '')

            # Extract recent filings
            recent = company_data.get('filings', {}).get('recent', {})
            forms = recent.get('form', [])
            dates = recent.get('filingDate', [])
            accessions = recent.get('accessionNumber', [])
            primary_docs = recent.get('primaryDocument', [])

            # Filter for 13F and Form 4
            filings_13f = []
            filings_form4 = []

            for i in range(len(forms)):
                filing = {
                    'form': forms[i] if i < len(forms) else None,
                    'date': dates[i] if i < len(dates) else None,
                    'accession': accessions[i] if i < len(accessions) else None,
                    'document': primary_docs[i] if i < len(primary_docs) else None,
                }
                if forms[i] in ('13F-HR', '13F-HR/A'):
                    filings_13f.append(filing)
                elif forms[i] in ('4', '4/A'):
                    filings_form4.append(filing)

            # Keep last 20 of each
            data['filings_13f'] = filings_13f[:20]
            data['filings_form4'] = filings_form4[:50]

        except Exception as e:
            print(f"filings error: {e}")
            data['filings_13f'] = None
            data['filings_form4'] = None

        time.sleep(SEC_DELAY)

        # Step 3: Try to get institutional holders from yfinance as supplement
        try:
            import yfinance as yf
            tk = yf.Ticker(ticker)
            holders = tk.institutional_holders
            if holders is not None and not holders.empty:
                holder_list = []
                for _, row in holders.iterrows():
                    rec = {}
                    for col in holders.columns:
                        val = row[col]
                        if hasattr(val, 'item'):
                            val = val.item()
                        if hasattr(val, 'isoformat'):
                            val = val.isoformat()
                        if str(val) == 'nan':
                            val = None
                        rec[col] = val
                    holder_list.append(rec)
                data['yf_institutional_holders'] = holder_list
            else:
                data['yf_institutional_holders'] = None

            # Major holders breakdown
            major = tk.major_holders
            if major is not None and not major.empty:
                data['yf_major_holders'] = df_to_dict(major)
            else:
                data['yf_major_holders'] = None

        except Exception:
            data['yf_institutional_holders'] = None
            data['yf_major_holders'] = None

        save_json(data, 'institutional', f'{ticker}.json')

        n13f = len(data.get('filings_13f') or [])
        nf4 = len(data.get('filings_form4') or [])
        print(f"CIK={cik}, {n13f} 13F, {nf4} Form4")
        mark_done(progress, 'institutional', ticker)
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        progress.setdefault('errors', []).append({
            'category': 'institutional', 'ticker': ticker,
            'error': str(e), 'time': datetime.now().isoformat()
        })
        save_progress(progress)
        return False


# ── FRED Downloads ────────────────────────────────────────────────────────────

def download_macro(progress):
    """Download all FRED macro series."""
    print("\n=== FRED Macro Data ===")

    for series_id, description in FRED_SERIES.items():
        if is_done(progress, 'macro', series_id):
            print(f"  [macro] {series_id} — already done")
            continue

        print(f"  [macro] {series_id} ({description})...", end=' ', flush=True)

        try:
            # 10 years of data
            end_date = date.today().strftime('%Y-%m-%d')
            start_date = (date.today() - timedelta(days=3652)).strftime('%Y-%m-%d')

            url = (f'https://api.stlouisfed.org/fred/series/observations'
                   f'?series_id={series_id}'
                   f'&api_key={FRED_KEY}'
                   f'&file_type=json'
                   f'&observation_start={start_date}'
                   f'&observation_end={end_date}')

            resp = fetch_url(url)
            observations = resp.get('observations', [])

            # Clean up: convert "." to None
            records = []
            for obs in observations:
                val = obs.get('value', '.')
                records.append({
                    'date': obs.get('date'),
                    'value': float(val) if val != '.' else None,
                })

            data = {
                'series_id': series_id,
                'description': description,
                'downloaded': datetime.now().isoformat(),
                'start': start_date,
                'end': end_date,
                'count': len(records),
                'data': records,
            }

            save_json(data, 'macro', f'{series_id}.json')
            print(f"{len(records)} observations")
            mark_done(progress, 'macro', series_id)
            time.sleep(FRED_DELAY)

        except Exception as e:
            print(f"ERROR: {e}")
            progress.setdefault('errors', []).append({
                'category': 'macro', 'series': series_id,
                'error': str(e), 'time': datetime.now().isoformat()
            })
            save_progress(progress)

    # Also download series metadata
    if not is_done(progress, 'macro', '_metadata'):
        print("  [macro] Series metadata...", end=' ', flush=True)
        try:
            metadata = {}
            for series_id in FRED_SERIES:
                url = (f'https://api.stlouisfed.org/fred/series'
                       f'?series_id={series_id}'
                       f'&api_key={FRED_KEY}'
                       f'&file_type=json')
                resp = fetch_url(url)
                series_info = resp.get('seriess', [{}])[0]
                metadata[series_id] = {
                    'title': series_info.get('title'),
                    'frequency': series_info.get('frequency'),
                    'units': series_info.get('units'),
                    'seasonal_adjustment': series_info.get('seasonal_adjustment'),
                    'last_updated': series_info.get('last_updated'),
                }
                time.sleep(FRED_DELAY)

            save_json(metadata, 'macro', '_metadata.json')
            print("OK")
            mark_done(progress, 'macro', '_metadata')
        except Exception as e:
            print(f"ERROR: {e}")

    # Also cache the SEC CIK mapping file (useful for future lookups)
    if not is_done(progress, 'institutional', '_cik_map'):
        print("  [institutional] SEC CIK mapping...", end=' ', flush=True)
        try:
            url = 'https://www.sec.gov/files/company_tickers.json'
            headers = {'User-Agent': SEC_USER_AGENT}
            data = fetch_url(url, headers)
            # Build ticker->CIK map
            cik_map = {}
            for entry in data.values():
                cik_map[entry['ticker']] = {
                    'cik': str(entry['cik_str']).zfill(10),
                    'title': entry.get('title', ''),
                }
            save_json(cik_map, 'institutional', '_cik_map.json')
            print(f"{len(cik_map)} companies")
            mark_done(progress, 'institutional', '_cik_map')
        except Exception as e:
            print(f"ERROR: {e}")


# ── Main Orchestrator ─────────────────────────────────────────────────────────

def estimate_time():
    """Estimate download time and disk usage."""
    n_tickers = len(TICKERS)
    n_stocks = n_tickers - len(ETFS)
    n_fred = len(FRED_SERIES)

    # yfinance: prices (all 88), financials/earnings/dividends (80 stocks), each ~2s delay
    yf_calls = n_tickers + n_stocks + n_stocks + n_tickers  # prices + fin + earn + div
    yf_time = yf_calls * YFINANCE_DELAY

    # SEC: institutional (80 stocks), ~2s per (yfinance delay + SEC delay)
    sec_time = n_stocks * (YFINANCE_DELAY + SEC_DELAY * 2)

    # FRED: 9 series + metadata, ~1s each
    fred_time = (n_fred + n_fred) * FRED_DELAY

    total_sec = yf_time + sec_time + fred_time
    total_min = total_sec / 60

    print(f"\n=== Download Estimate ===")
    print(f"Tickers: {n_tickers} ({n_stocks} stocks + {len(ETFS)} ETFs)")
    print(f"FRED series: {n_fred}")
    print(f"")
    print(f"Category breakdown:")
    print(f"  prices:        {n_tickers} tickers × 2s = ~{n_tickers * 2 / 60:.0f} min")
    print(f"  financials:    {n_stocks} stocks × 2s  = ~{n_stocks * 2 / 60:.0f} min")
    print(f"  earnings:      {n_stocks} stocks × 2s  = ~{n_stocks * 2 / 60:.0f} min")
    print(f"  dividends:     {n_tickers} tickers × 2s = ~{n_tickers * 2 / 60:.0f} min")
    print(f"  institutional: {n_stocks} stocks × 2.5s = ~{n_stocks * 2.5 / 60:.0f} min")
    print(f"  macro:         {n_fred} series × 1s   = ~{n_fred / 60:.1f} min")
    print(f"")
    print(f"Estimated total time: ~{total_min:.0f} minutes ({total_min/60:.1f} hours)")
    print(f"Estimated disk usage: ~50-100 MB (JSON)")
    print(f"")
    print(f"Tip: Run with --category to download one category at a time.")


def run_category(category, progress):
    """Run downloads for a specific category."""
    if category == 'macro':
        download_macro(progress)
        return

    print(f"\n=== {category.upper()} ===")

    download_fn = {
        'prices': download_prices,
        'financials': download_financials,
        'earnings': download_earnings,
        'dividends': download_dividends,
        'institutional': download_institutional,
    }[category]

    total = len(TICKERS)
    done = 0
    errors = 0

    for i, ticker in enumerate(TICKERS, 1):
        # Check if already done (for resume)
        if is_done(progress, category, ticker):
            done += 1
            continue

        # Skip ETFs for stock-only categories
        if ticker in ETFS and category in ('financials', 'earnings', 'institutional'):
            done += 1
            continue

        print(f"  [{i}/{total}]", end=' ')
        success = download_fn(ticker, progress)
        if success:
            done += 1
        else:
            errors += 1

        # Rate limiting between tickers
        if category == 'institutional':
            time.sleep(YFINANCE_DELAY)  # Includes yfinance call
        else:
            time.sleep(YFINANCE_DELAY)

    print(f"\n  {category}: {done} done, {errors} errors out of {total}")


def main():
    parser = argparse.ArgumentParser(description='Free Bulk Financial Data Downloader')
    parser.add_argument('--resume', action='store_true',
                       help='Resume interrupted download')
    parser.add_argument('--category', choices=CATEGORIES,
                       help='Download only one category')
    parser.add_argument('--estimate', action='store_true',
                       help='Estimate time and size without downloading')
    args = parser.parse_args()

    if args.estimate:
        estimate_time()
        return

    # Check yfinance is installed
    try:
        import yfinance
        print(f"yfinance version: {yfinance.__version__}")
    except ImportError:
        print("ERROR: yfinance not installed. Run: pip install yfinance")
        sys.exit(1)

    ensure_dirs()

    # Load or create progress
    if args.resume and PROGRESS_FILE.exists():
        progress = load_progress()
        completed_count = sum(len(v) for v in progress.get('completed', {}).values())
        print(f"Resuming download ({completed_count} items already completed)")
    else:
        progress = load_progress()
        if not args.resume:
            # Fresh start — reset progress
            progress = {'completed': {}, 'started': datetime.now().isoformat(), 'errors': []}
            save_progress(progress)

    print(f"\nData directory: {DATA_DIR}")
    print(f"Tickers: {len(TICKERS)} ({len(TICKERS) - len(ETFS)} stocks + {len(ETFS)} ETFs)")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    start_time = time.time()

    if args.category:
        run_category(args.category, progress)
    else:
        # Run all categories in order
        for cat in CATEGORIES:
            run_category(cat, progress)

    elapsed = time.time() - start_time
    elapsed_min = elapsed / 60

    # Summary
    print("\n" + "=" * 60)
    print(f"DOWNLOAD COMPLETE")
    print(f"Time: {elapsed_min:.1f} minutes")
    print(f"Data saved to: {DATA_DIR}")

    # Count files
    total_files = 0
    total_size = 0
    for cat in CATEGORIES:
        cat_dir = DATA_DIR / cat
        if cat_dir.exists():
            files = list(cat_dir.glob('*.json'))
            size = sum(f.stat().st_size for f in files)
            total_files += len(files)
            total_size += size
            print(f"  {cat}: {len(files)} files ({size / 1024 / 1024:.1f} MB)")

    print(f"  TOTAL: {total_files} files ({total_size / 1024 / 1024:.1f} MB)")

    # Show errors if any
    errors = progress.get('errors', [])
    if errors:
        print(f"\n{len(errors)} errors encountered:")
        for err in errors[-10:]:  # Show last 10
            print(f"  [{err.get('category')}] {err.get('ticker', err.get('series', '?'))}: {err.get('error')}")
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more (see {PROGRESS_FILE})")


if __name__ == '__main__':
    main()
