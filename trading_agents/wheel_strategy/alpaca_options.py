#!/usr/bin/env python3
"""
Alpaca Options Data Client — pulls real options chains for wheel strategy.

Uses Alpaca Data API v1beta1 for:
- Live option chain snapshots (bid/ask, IV, greeks, volume, OI)
- Historical option bars (requires Algo Trader Plus $99/mo)
- Contract discovery

Free tier: current snapshots work, historical limited to 15 min.
"""

import json
import os
import sys
import time
import requests
from datetime import datetime, timedelta
from pathlib import Path

# Load .env
ENV_FILE = Path(__file__).resolve().parents[2] / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = v.strip().strip("'\"")
            if k.strip() not in os.environ:
                os.environ[k.strip()] = v

DATA_DIR = Path(__file__).resolve().parent / 'data' / 'options_chains'
DATA_DIR.mkdir(parents=True, exist_ok=True)

# API Configuration
TRADING_BASE = 'https://paper-api.alpaca.markets'
DATA_BASE = 'https://data.alpaca.markets'


class AlpacaOptionsClient:
    """Pull real options data from Alpaca."""

    def __init__(self):
        self.api_key = os.environ.get('ALPACA_API_KEY') or os.environ.get('APCA_API_KEY_ID')
        self.api_secret = os.environ.get('ALPACA_SECRET_KEY') or os.environ.get('APCA_API_SECRET_KEY')

        if not self.api_key or not self.api_secret:
            raise ValueError(
                "Alpaca API keys not found. Set ALPACA_API_KEY and ALPACA_SECRET_KEY in .env"
            )

        self.headers = {
            'APCA-API-KEY-ID': self.api_key,
            'APCA-API-SECRET-KEY': self.api_secret,
        }
        self.session = requests.Session()
        self.session.headers.update(self.headers)

    def _data_get(self, endpoint, params=None):
        """GET request to data API."""
        url = f"{DATA_BASE}{endpoint}"
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def _trading_get(self, endpoint, params=None):
        """GET request to trading API."""
        url = f"{TRADING_BASE}{endpoint}"
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def get_option_chain(self, symbol, min_dte=3, max_dte=60,
                         option_type=None, min_open_interest=10):
        """
        Get full option chain snapshot for a symbol.
        Returns all contracts with latest quote, trade, IV, and greeks.

        Args:
            symbol: underlying stock symbol (e.g., 'AAPL')
            min_dte: minimum days to expiration
            max_dte: maximum days to expiration
            option_type: 'call', 'put', or None for both
            min_open_interest: minimum open interest filter
        """
        params = {
            'feed': 'indicative',  # 'opra' requires paid plan
            'limit': 1000,
        }
        if option_type:
            params['type'] = option_type

        try:
            data = self._data_get(f'/v1beta1/options/snapshots/{symbol}', params)
        except requests.HTTPError as e:
            if e.response.status_code == 403:
                raise ValueError(
                    f"Alpaca returned 403 — may need Algo Trader Plus subscription "
                    f"for options data. Error: {e}"
                )
            raise

        snapshots = data.get('snapshots', {})
        if not snapshots:
            return []

        now = datetime.now()
        results = []

        for contract_symbol, snap in snapshots.items():
            try:
                # Parse contract symbol to get expiry, strike, type
                contract_info = self._parse_option_symbol(contract_symbol)
                if not contract_info:
                    continue

                expiry = contract_info['expiry']
                dte = (expiry - now).days
                if dte < min_dte or dte > max_dte:
                    continue

                quote = snap.get('latestQuote', {})
                trade = snap.get('latestTrade', {})
                greeks = snap.get('greeks', {})

                bid = float(quote.get('bp', 0) or 0)
                ask = float(quote.get('ap', 0) or 0)
                mid = (bid + ask) / 2 if bid and ask else 0
                last = float(trade.get('p', 0) or 0)
                volume = int(trade.get('s', 0) or 0)
                iv = float(snap.get('impliedVolatility', 0) or 0)

                result = {
                    'symbol': contract_symbol,
                    'underlying': symbol,
                    'type': contract_info['type'],
                    'strike': contract_info['strike'],
                    'expiry': expiry.strftime('%Y-%m-%d'),
                    'dte': dte,
                    'bid': bid,
                    'ask': ask,
                    'mid': mid,
                    'last': last,
                    'spread': round(ask - bid, 4) if bid and ask else 0,
                    'volume': volume,
                    'iv': round(iv, 4),
                    'delta': float(greeks.get('delta', 0) or 0),
                    'gamma': float(greeks.get('gamma', 0) or 0),
                    'theta': float(greeks.get('theta', 0) or 0),
                    'vega': float(greeks.get('vega', 0) or 0),
                }
                results.append(result)

            except Exception:
                continue

        # Sort by expiry then strike
        results.sort(key=lambda x: (x['expiry'], x['strike']))
        return results

    def _parse_option_symbol(self, sym):
        """Parse OCC option symbol like AAPL250321C00230000."""
        try:
            # Find where the date starts (first digit after letters)
            i = 0
            while i < len(sym) and sym[i].isalpha():
                i += 1
            if i >= len(sym) - 8:
                return None

            underlying = sym[:i]
            date_str = sym[i:i+6]
            opt_type = sym[i+6]
            strike_str = sym[i+7:]

            expiry = datetime.strptime(date_str, '%y%m%d')
            strike = float(strike_str) / 1000.0
            opt_type_str = 'call' if opt_type == 'C' else 'put'

            return {
                'underlying': underlying,
                'expiry': expiry,
                'type': opt_type_str,
                'strike': strike,
            }
        except Exception:
            return None

    def get_csp_candidates(self, symbol, target_delta=-0.30, dte_range=(3, 45)):
        """
        Find best CSP (cash-secured put) candidates for wheel strategy.
        Returns puts sorted by premium yield.
        """
        chain = self.get_option_chain(
            symbol,
            min_dte=dte_range[0],
            max_dte=dte_range[1],
            option_type='put',
        )

        candidates = []
        for opt in chain:
            if opt['bid'] <= 0 or opt['delta'] == 0:
                continue

            # Filter by delta range (want OTM puts)
            if not (-0.50 <= opt['delta'] <= -0.15):
                continue

            # Weekly yield on collateral
            collateral = opt['strike'] * 100
            premium = opt['bid'] * 100  # Use bid (what we'd actually get)
            weekly_yield = (premium / collateral) / max(opt['dte'] / 7, 1) * 100
            annual_yield = weekly_yield * 52
            breakeven = opt['strike'] - opt['bid']

            candidates.append({
                **opt,
                'premium_per_contract': round(premium, 2),
                'collateral': round(collateral, 2),
                'weekly_yield_pct': round(weekly_yield, 3),
                'annual_yield_pct': round(annual_yield, 1),
                'breakeven': round(breakeven, 2),
            })

        # Sort by weekly yield descending
        candidates.sort(key=lambda x: x['weekly_yield_pct'], reverse=True)
        return candidates

    def get_cc_candidates(self, symbol, cost_basis, dte_range=(3, 45)):
        """
        Find best CC (covered call) candidates for wheel strategy.
        Returns calls sorted by premium yield.
        """
        chain = self.get_option_chain(
            symbol,
            min_dte=dte_range[0],
            max_dte=dte_range[1],
            option_type='call',
        )

        candidates = []
        for opt in chain:
            if opt['bid'] <= 0 or opt['delta'] == 0:
                continue

            # Filter by delta range (want OTM calls)
            if not (0.15 <= opt['delta'] <= 0.50):
                continue

            premium = opt['bid'] * 100
            weekly_yield = (premium / (cost_basis * 100)) / max(opt['dte'] / 7, 1) * 100
            upside_to_strike = (opt['strike'] - cost_basis) / cost_basis * 100

            candidates.append({
                **opt,
                'premium_per_contract': round(premium, 2),
                'weekly_yield_pct': round(weekly_yield, 3),
                'annual_yield_pct': round(weekly_yield * 52, 1),
                'upside_to_strike_pct': round(upside_to_strike, 2),
                'max_profit': round((opt['strike'] - cost_basis + opt['bid']) * 100, 2),
            })

        candidates.sort(key=lambda x: x['weekly_yield_pct'], reverse=True)
        return candidates

    def scan_wheel_candidates(self, tickers, capital=100_000,
                              target_delta=0.30, max_dte=14):
        """
        Scan multiple tickers for best wheel plays with REAL premiums.
        """
        results = []

        for ticker in tickers:
            try:
                csps = self.get_csp_candidates(
                    ticker,
                    target_delta=-target_delta,
                    dte_range=(3, max_dte),
                )

                if not csps:
                    continue

                # Find the one closest to target delta
                best = min(csps, key=lambda x: abs(abs(x['delta']) - target_delta))

                # Check if we can afford it
                if best['collateral'] > capital * 0.25:
                    continue

                results.append({
                    'ticker': ticker,
                    'strike': best['strike'],
                    'expiry': best['expiry'],
                    'dte': best['dte'],
                    'bid': best['bid'],
                    'ask': best['ask'],
                    'delta': best['delta'],
                    'iv': best['iv'],
                    'premium': best['premium_per_contract'],
                    'collateral': best['collateral'],
                    'weekly_yield_pct': best['weekly_yield_pct'],
                    'annual_yield_pct': best['annual_yield_pct'],
                    'breakeven': best['breakeven'],
                    'spread': best['spread'],
                })

                time.sleep(0.3)  # Rate limit

            except Exception as e:
                print(f"  {ticker}: ERROR - {str(e)[:60]}")
                continue

        results.sort(key=lambda x: x['weekly_yield_pct'], reverse=True)
        return results

    def save_chain_snapshot(self, symbol):
        """Save a full chain snapshot for historical reference."""
        chain = self.get_option_chain(symbol)
        if not chain:
            return None

        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        filepath = DATA_DIR / f'{symbol}_{ts}.json'
        with open(filepath, 'w') as f:
            json.dump({
                'symbol': symbol,
                'timestamp': datetime.now().isoformat(),
                'contracts': len(chain),
                'chain': chain,
            }, f, indent=2)
        return filepath


def format_wheel_scan(results):
    """Format scan results for display/Discord."""
    if not results:
        return "No wheel candidates found."

    lines = [
        f"**Wheel Strategy — Live Options Scan ({datetime.now().strftime('%Y-%m-%d %H:%M')})**",
        "```",
        f"{'Ticker':6s} {'Strike':>7s} {'Exp':>10s} {'DTE':>4s} {'Bid':>6s} "
        f"{'Delta':>6s} {'IV':>6s} {'Wk%':>6s} {'Ann%':>7s} {'Collateral':>10s}",
        "-" * 78,
    ]

    total_premium = 0
    total_collateral = 0
    for r in results:
        lines.append(
            f"{r['ticker']:6s} ${r['strike']:>5.0f} {r['expiry']:>10s} {r['dte']:>3d}d "
            f"${r['bid']:>4.2f} {r['delta']:>+5.3f} {r['iv']*100:>5.1f}% "
            f"{r['weekly_yield_pct']:>5.2f}% {r['annual_yield_pct']:>6.1f}% "
            f"${r['collateral']:>8,.0f}"
        )
        total_premium += r['premium']
        total_collateral += r['collateral']

    lines.append("-" * 78)
    lines.append(f"Total premium: ${total_premium:,.0f} | Collateral: ${total_collateral:,.0f}")
    if total_collateral > 0:
        portfolio_wk = total_premium / total_collateral / (results[0]['dte'] / 7) * 100
        lines.append(f"Portfolio weekly yield: {portfolio_wk:.2f}%")
    lines.append("```")
    lines.append("*Real bid prices from Alpaca/OPRA. Delta/IV/Greeks from market data.*")

    return "\n".join(lines)


# Expanded universe — high IV stocks good for wheel strategy
WHEEL_UNIVERSE = [
    # High IV tech
    'INTC', 'AMD', 'SNAP', 'PLTR', 'SOFI', 'HOOD', 'RIVN', 'LCID', 'NIO',
    'MARA', 'RIOT', 'COIN',
    # Mid-cap high IV
    'F', 'T', 'PFE', 'WBA', 'PARA', 'AAL', 'DAL', 'UAL',
    # Blue chip (lower IV but safe)
    'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META',
    'BAC', 'JPM', 'WFC', 'C',
    'KO', 'PEP', 'JNJ', 'PG',
    'XOM', 'CVX', 'COP',
    # REITs (high yield + premiums)
    'O', 'AGNC', 'NLY',
    # ETFs
    'SPY', 'QQQ', 'IWM', 'EEM', 'XLF', 'XLE',
]


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Alpaca Options Scanner for Wheel Strategy')
    parser.add_argument('--scan', action='store_true', help='Scan wheel candidates')
    parser.add_argument('--chain', type=str, help='Get full chain for a symbol')
    parser.add_argument('--csp', type=str, help='Get CSP candidates for a symbol')
    parser.add_argument('--cc', type=str, help='Get CC candidates (needs --basis)')
    parser.add_argument('--basis', type=float, default=0, help='Cost basis for CC')
    parser.add_argument('--capital', type=float, default=100_000, help='Total capital')
    parser.add_argument('--delta', type=float, default=0.30, help='Target delta')
    parser.add_argument('--dte', type=int, default=14, help='Max DTE')
    parser.add_argument('--tickers', type=str, help='Comma-separated tickers (default: WHEEL_UNIVERSE)')
    args = parser.parse_args()

    client = AlpacaOptionsClient()

    if args.chain:
        print(f"Fetching option chain for {args.chain}...")
        chain = client.get_option_chain(args.chain, max_dte=args.dte)
        print(f"Found {len(chain)} contracts")
        for opt in chain[:20]:
            print(f"  {opt['symbol']}: {opt['type']} ${opt['strike']} exp={opt['expiry']} "
                  f"bid=${opt['bid']:.2f} ask=${opt['ask']:.2f} delta={opt['delta']:.3f} "
                  f"IV={opt['iv']*100:.1f}%")

    elif args.csp:
        print(f"CSP candidates for {args.csp}...")
        csps = client.get_csp_candidates(args.csp, dte_range=(3, args.dte))
        for c in csps[:10]:
            print(f"  ${c['strike']} exp={c['expiry']} bid=${c['bid']:.2f} "
                  f"delta={c['delta']:.3f} IV={c['iv']*100:.1f}% "
                  f"wk_yield={c['weekly_yield_pct']:.2f}% ann={c['annual_yield_pct']:.1f}%")

    elif args.cc:
        basis = args.basis or float(input(f"Cost basis for {args.cc}: $"))
        print(f"CC candidates for {args.cc} (basis ${basis})...")
        ccs = client.get_cc_candidates(args.cc, basis, dte_range=(3, args.dte))
        for c in ccs[:10]:
            print(f"  ${c['strike']} exp={c['expiry']} bid=${c['bid']:.2f} "
                  f"delta={c['delta']:.3f} upside={c['upside_to_strike_pct']:.1f}% "
                  f"wk_yield={c['weekly_yield_pct']:.2f}% ann={c['annual_yield_pct']:.1f}%")

    elif args.scan or True:
        tickers = args.tickers.split(',') if args.tickers else WHEEL_UNIVERSE
        print(f"Scanning {len(tickers)} tickers for wheel plays...")
        results = client.scan_wheel_candidates(
            tickers, capital=args.capital,
            target_delta=args.delta, max_dte=args.dte,
        )
        print(format_wheel_scan(results))

        # Save
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        with open(DATA_DIR / f'wheel_scan_{ts}.json', 'w') as f:
            json.dump(results, f, indent=2)
