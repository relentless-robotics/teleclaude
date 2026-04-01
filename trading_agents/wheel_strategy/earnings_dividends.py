#!/usr/bin/env python3
"""
Earnings Avoidance & Dividend Capture Module for Wheel Strategy.

Provides:
  - get_earnings_dates(tickers): Fetch upcoming earnings via yfinance
  - get_dividend_info(tickers):  Fetch ex-dividend dates and yields via yfinance
  - filter_earnings_risk(tickers, days=7): Remove tickers with imminent earnings
  - dividend_capture_score(ticker, dte): Score CC timing relative to ex-div

Usage:
    from earnings_dividends import get_earnings_dates, get_dividend_info

    # Check earnings
    earnings = get_earnings_dates(['AAPL', 'MSFT', 'JPM'])
    for ticker, info in earnings.items():
        if info['within_7d']:
            print(f"SKIP {ticker}: earnings on {info['date']}")

    # Check dividends
    divs = get_dividend_info(['AAPL', 'MSFT', 'JPM'])
    for ticker, info in divs.items():
        if info['ex_div_within_dte']:
            print(f"{ticker}: ex-div {info['ex_date']} — capture ${info['amount']}")
"""

import sys
from datetime import datetime, timedelta, date
from pathlib import Path

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False


def get_earnings_dates(tickers, days_ahead=30):
    """
    Fetch upcoming earnings dates for a list of tickers via yfinance.

    Args:
        tickers: list of ticker symbols
        days_ahead: how many days forward to look (default 30)

    Returns:
        dict of {ticker: {
            'date': str or None,          # next earnings date (YYYY-MM-DD)
            'days_until': int or None,     # trading days until earnings
            'within_7d': bool,             # True if earnings within 7 calendar days
            'within_14d': bool,            # True if earnings within 14 calendar days
            'source': str,                 # 'yfinance' or 'fallback'
            'error': str or None,
        }}
    """
    if not HAS_YFINANCE:
        return {t: _fallback_earnings(t) for t in tickers}

    results = {}
    today = date.today()

    for ticker in tickers:
        try:
            stock = yf.Ticker(ticker)
            cal = stock.calendar

            earnings_date = None

            # yfinance calendar can be a dict or DataFrame
            if cal is not None:
                if isinstance(cal, dict):
                    # Newer yfinance versions return dict
                    ed = cal.get('Earnings Date')
                    if ed is not None:
                        if isinstance(ed, list) and len(ed) > 0:
                            earnings_date = _parse_date(ed[0])
                        elif hasattr(ed, 'date'):
                            earnings_date = ed.date() if hasattr(ed, 'date') else _parse_date(ed)
                        else:
                            earnings_date = _parse_date(ed)
                elif hasattr(cal, 'loc'):
                    # DataFrame format (older yfinance)
                    try:
                        if 'Earnings Date' in cal.index:
                            ed = cal.loc['Earnings Date']
                            if hasattr(ed, 'iloc'):
                                ed = ed.iloc[0]
                            earnings_date = _parse_date(ed)
                    except Exception:
                        pass

            # Also try earnings_dates property
            if earnings_date is None:
                try:
                    ed_series = stock.earnings_dates
                    if ed_series is not None and len(ed_series) > 0:
                        # Find the next future date
                        for idx in ed_series.index:
                            d = _parse_date(idx)
                            if d and d >= today:
                                earnings_date = d
                                break
                except Exception:
                    pass

            if earnings_date is not None and earnings_date >= today:
                days_until = (earnings_date - today).days
                results[ticker] = {
                    'date': str(earnings_date),
                    'days_until': days_until,
                    'within_7d': days_until <= 7,
                    'within_14d': days_until <= 14,
                    'source': 'yfinance',
                    'error': None,
                }
            else:
                results[ticker] = {
                    'date': None,
                    'days_until': None,
                    'within_7d': False,
                    'within_14d': False,
                    'source': 'yfinance',
                    'error': None,
                }

        except Exception as e:
            results[ticker] = _fallback_earnings(ticker)
            results[ticker]['error'] = str(e)[:100]

    return results


def _parse_date(val):
    """Parse various date formats to datetime.date."""
    if val is None:
        return None
    if isinstance(val, date):
        return val
    if hasattr(val, 'date'):
        return val.date()
    try:
        s = str(val)[:10]
        return datetime.strptime(s, '%Y-%m-%d').date()
    except Exception:
        return None


def _fallback_earnings(ticker):
    """Fallback using approximate earnings months from stock_screener."""
    try:
        from stock_screener import EARNINGS_MONTHS
    except ImportError:
        try:
            from trading_agents.wheel_strategy.stock_screener import EARNINGS_MONTHS
        except ImportError:
            return {
                'date': None, 'days_until': None,
                'within_7d': False, 'within_14d': False,
                'source': 'fallback_none', 'error': None,
            }

    months = EARNINGS_MONTHS.get(ticker)
    if not months:
        return {
            'date': None, 'days_until': None,
            'within_7d': False, 'within_14d': False,
            'source': 'fallback_none', 'error': None,
        }

    today = date.today()
    # Find the next earnings month
    best_date = None
    for m in months:
        # Approximate: earnings around the 15th of the month
        for year in [today.year, today.year + 1]:
            try:
                candidate = date(year, m, 15)
                if candidate >= today:
                    if best_date is None or candidate < best_date:
                        best_date = candidate
            except ValueError:
                continue

    if best_date:
        days_until = (best_date - today).days
        return {
            'date': str(best_date),
            'days_until': days_until,
            'within_7d': days_until <= 7,
            'within_14d': days_until <= 14,
            'source': 'fallback_monthly',
            'error': None,
        }

    return {
        'date': None, 'days_until': None,
        'within_7d': False, 'within_14d': False,
        'source': 'fallback_none', 'error': None,
    }


def get_dividend_info(tickers, dte_window=45):
    """
    Fetch dividend information for tickers via yfinance.

    Args:
        tickers: list of ticker symbols
        dte_window: DTE window to check for ex-div dates (default 45)

    Returns:
        dict of {ticker: {
            'annual_yield_pct': float,        # Annual dividend yield %
            'amount_per_share': float,         # Most recent quarterly dividend
            'ex_date': str or None,            # Next ex-dividend date
            'ex_date_days': int or None,       # Days until ex-div
            'ex_div_within_dte': bool,         # True if ex-div within dte_window
            'payment_date': str or None,       # Payment date
            'sell_cc_after_exdiv': bool,        # Recommendation
            'dividend_per_100_shares': float,  # Dollar value for 1 contract
            'source': str,
            'error': str or None,
        }}
    """
    if not HAS_YFINANCE:
        return {t: _empty_div_info(t) for t in tickers}

    results = {}
    today = date.today()

    for ticker in tickers:
        try:
            stock = yf.Ticker(ticker)
            info = stock.info or {}

            annual_yield = info.get('dividendYield', 0) or 0
            annual_yield_pct = annual_yield * 100

            # Get recent dividend amount
            last_dividend = info.get('lastDividendValue', 0) or 0

            # Try to get ex-dividend date
            ex_date = None
            ex_date_ts = info.get('exDividendDate')
            if ex_date_ts:
                if isinstance(ex_date_ts, (int, float)):
                    ex_date = datetime.fromtimestamp(ex_date_ts).date()
                else:
                    ex_date = _parse_date(ex_date_ts)

            # Get dividend history for more accurate last dividend
            try:
                divs = stock.dividends
                if divs is not None and len(divs) > 0:
                    last_dividend = float(divs.iloc[-1])

                    # Find next ex-div: look at historical pattern
                    if ex_date is None or ex_date < today:
                        # Estimate next ex-div from historical spacing
                        last_ex = divs.index[-1]
                        if hasattr(last_ex, 'date'):
                            last_ex_date = last_ex.date()
                        else:
                            last_ex_date = _parse_date(last_ex)

                        if last_ex_date and len(divs) >= 2:
                            second_last = divs.index[-2]
                            if hasattr(second_last, 'date'):
                                second_last_date = second_last.date()
                            else:
                                second_last_date = _parse_date(second_last)
                            if second_last_date and last_ex_date:
                                gap = (last_ex_date - second_last_date).days
                                next_est = last_ex_date + timedelta(days=gap)
                                while next_est < today:
                                    next_est += timedelta(days=gap)
                                ex_date = next_est
            except Exception:
                pass

            ex_date_days = None
            ex_div_within_dte = False
            sell_cc_after = False

            if ex_date and ex_date >= today:
                ex_date_days = (ex_date - today).days
                ex_div_within_dte = ex_date_days <= dte_window
                # Recommendation: sell CC AFTER ex-div to capture dividend
                # If ex-div is within 3 days, we can wait. If further out,
                # sell now but be aware.
                sell_cc_after = ex_date_days <= 5

            results[ticker] = {
                'annual_yield_pct': round(annual_yield_pct, 2),
                'amount_per_share': round(last_dividend, 4),
                'ex_date': str(ex_date) if ex_date else None,
                'ex_date_days': ex_date_days,
                'ex_div_within_dte': ex_div_within_dte,
                'payment_date': None,  # yfinance doesn't reliably provide this
                'sell_cc_after_exdiv': sell_cc_after,
                'dividend_per_100_shares': round(last_dividend * 100, 2),
                'source': 'yfinance',
                'error': None,
            }

        except Exception as e:
            results[ticker] = _empty_div_info(ticker)
            results[ticker]['error'] = str(e)[:100]

    return results


def _empty_div_info(ticker):
    """Return empty dividend info dict."""
    return {
        'annual_yield_pct': 0.0,
        'amount_per_share': 0.0,
        'ex_date': None,
        'ex_date_days': None,
        'ex_div_within_dte': False,
        'payment_date': None,
        'sell_cc_after_exdiv': False,
        'dividend_per_100_shares': 0.0,
        'source': 'none',
        'error': None,
    }


def filter_earnings_risk(tickers, days=7):
    """
    Filter out tickers with earnings within `days` calendar days.

    Args:
        tickers: list of ticker symbols
        days: exclusion window (default 7)

    Returns:
        (safe_tickers, skipped) where skipped is list of (ticker, earnings_date, days_until)
    """
    earnings = get_earnings_dates(tickers)
    safe = []
    skipped = []

    for ticker in tickers:
        info = earnings.get(ticker, {})
        days_until = info.get('days_until')

        if days_until is not None and days_until <= days:
            skipped.append((ticker, info.get('date'), days_until))
        else:
            safe.append(ticker)

    return safe, skipped


def dividend_capture_opportunity(ticker, div_info, dte):
    """
    Score a dividend capture opportunity for CC timing.

    Args:
        ticker: stock symbol
        div_info: dict from get_dividend_info for this ticker
        dte: DTE of the option being considered

    Returns:
        dict with:
          - 'has_dividend': bool
          - 'capture_possible': bool (ex-div within DTE window)
          - 'extra_income': float (dividend amount per contract if captured)
          - 'timing_advice': str
          - 'yield_boost_pct': float (additional weekly yield from dividend)
    """
    if not div_info or div_info.get('amount_per_share', 0) <= 0:
        return {
            'has_dividend': False,
            'capture_possible': False,
            'extra_income': 0.0,
            'timing_advice': 'No dividend',
            'yield_boost_pct': 0.0,
        }

    ex_days = div_info.get('ex_date_days')
    amount = div_info['amount_per_share']
    div_100 = div_info['dividend_per_100_shares']

    if ex_days is None or ex_days < 0:
        return {
            'has_dividend': True,
            'capture_possible': False,
            'extra_income': 0.0,
            'timing_advice': f'Dividend ${amount:.2f}/sh but ex-div date unknown or passed',
            'yield_boost_pct': 0.0,
        }

    capture_possible = ex_days <= dte

    if capture_possible:
        if ex_days <= 3:
            advice = f'SELL CC AFTER ex-div ({ex_days}d away) to capture ${div_100:.0f}'
        elif ex_days <= 7:
            advice = f'Wait {ex_days}d for ex-div, then sell CC — capture ${div_100:.0f}'
        else:
            advice = f'Ex-div in {ex_days}d (within {dte}d DTE) — will capture ${div_100:.0f}'

        # Yield boost: annualize the dividend capture
        weeks_in_dte = max(dte / 7, 1)
        yield_boost = (amount / 100) / weeks_in_dte * 100  # very rough
    else:
        advice = f'Ex-div in {ex_days}d — beyond {dte}d DTE window'
        yield_boost = 0.0

    return {
        'has_dividend': True,
        'capture_possible': capture_possible,
        'extra_income': div_100 if capture_possible else 0.0,
        'timing_advice': advice,
        'yield_boost_pct': round(yield_boost, 3),
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(
        description='Earnings & Dividend checker for wheel strategy'
    )
    parser.add_argument('--tickers', type=str, default='AAPL,MSFT,JPM,BAC,KO,XOM,PFE,T',
                        help='Comma-separated tickers')
    parser.add_argument('--earnings', action='store_true', help='Check earnings dates')
    parser.add_argument('--dividends', action='store_true', help='Check dividend info')
    parser.add_argument('--filter', action='store_true',
                        help='Filter tickers by earnings risk')
    parser.add_argument('--days', type=int, default=7,
                        help='Earnings exclusion window (days)')
    parser.add_argument('--dte', type=int, default=30,
                        help='DTE window for dividend check')
    args = parser.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(',')]

    if not args.earnings and not args.dividends and not args.filter:
        args.earnings = True
        args.dividends = True

    if args.earnings:
        print("=" * 70)
        print("EARNINGS DATES")
        print("=" * 70)
        earnings = get_earnings_dates(tickers)
        for ticker, info in sorted(earnings.items()):
            status = 'SKIP' if info['within_7d'] else 'OK'
            date_str = info['date'] or 'unknown'
            days_str = f"{info['days_until']}d" if info['days_until'] is not None else '?'
            src = info['source']
            print(f"  {ticker:6s} [{status:4s}]  {date_str:12s}  ({days_str:>4s} away)  [{src}]")
            if info.get('error'):
                print(f"         ERROR: {info['error']}")
        print()

    if args.dividends:
        print("=" * 70)
        print("DIVIDEND INFO")
        print("=" * 70)
        divs = get_dividend_info(tickers, dte_window=args.dte)
        for ticker, info in sorted(divs.items()):
            yield_str = f"{info['annual_yield_pct']:.2f}%" if info['annual_yield_pct'] > 0 else 'none'
            ex_str = info['ex_date'] or 'unknown'
            amt = info['amount_per_share']
            div100 = info['dividend_per_100_shares']
            capture = dividend_capture_opportunity(ticker, info, args.dte)
            print(f"  {ticker:6s}  Yield: {yield_str:>6s}  "
                  f"Last: ${amt:.4f}/sh  Ex-div: {ex_str}")
            if capture['has_dividend']:
                print(f"         {capture['timing_advice']}")
            if info.get('error'):
                print(f"         ERROR: {info['error']}")
        print()

    if args.filter:
        print("=" * 70)
        print(f"EARNINGS FILTER (window: {args.days} days)")
        print("=" * 70)
        safe, skipped = filter_earnings_risk(tickers, days=args.days)
        print(f"  Safe tickers:    {', '.join(safe)}")
        if skipped:
            print(f"  SKIPPED ({len(skipped)}):")
            for t, d, days_until in skipped:
                print(f"    {t}: earnings {d} ({days_until}d away)")
        else:
            print("  No tickers skipped.")
        print()
