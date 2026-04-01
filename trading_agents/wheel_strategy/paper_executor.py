#!/usr/bin/env python3
"""
Wheel Strategy Paper Trade Auto-Executor for Alpaca.

Reads portfolio allocation from portfolio_optimizer.py, connects to Alpaca
Paper Trading API, and automatically manages the full wheel cycle:
  CSP sell -> assignment detection -> CC sell -> called away -> repeat

Supports risk modes: safe, standard, aggressive (via --mode flag).
The mode controls early-close thresholds and CC delta targets.

Usage:
    python paper_executor.py --execute                         # Standard mode
    python paper_executor.py --execute --mode safe --dry-run   # Safe mode preview
    python paper_executor.py --execute --mode aggressive       # Aggressive mode
    python paper_executor.py --status                          # Show positions and P&L
    python paper_executor.py --monitor                         # Check for rolls/assignments
    python paper_executor.py --monitor --mode safe             # Monitor with safe thresholds
    python paper_executor.py --close-all                       # Emergency close all positions
"""

import argparse
import json
import os
import sys
import time
import requests
from datetime import datetime, timedelta, date
from pathlib import Path

# ── Path setup ───────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)

ALLOCATION_FILE = DATA_DIR / 'portfolio_allocation.json'
POSITIONS_FILE = DATA_DIR / 'paper_positions.json'
TRADE_LOG_FILE = DATA_DIR / 'paper_trade_log.jsonl'

# Import risk profiles
sys.path.insert(0, str(SCRIPT_DIR))
from risk_profiles import get_profile, VALID_MODES

# ── Load .env (2 dirs up) ───────────────────────────────────────────────────
ENV_FILE = SCRIPT_DIR.parents[1] / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = v.strip().strip("'\"")
            if k.strip() not in os.environ:
                os.environ[k.strip()] = v

# ── API Configuration ────────────────────────────────────────────────────────
TRADING_BASE = 'https://paper-api.alpaca.markets'
DATA_BASE = 'https://data.alpaca.markets'

# Use DAYTRADE_ prefixed keys first, fallback to generic ALPACA_ keys
API_KEY = (
    os.environ.get('DAYTRADE_ALPACA_API_KEY')
    or os.environ.get('ALPACA_API_KEY')
    or os.environ.get('APCA_API_KEY_ID')
)
API_SECRET = (
    os.environ.get('DAYTRADE_ALPACA_API_SECRET')
    or os.environ.get('ALPACA_SECRET_KEY')
    or os.environ.get('APCA_API_SECRET_KEY')
)


# ── Alpaca API Client ────────────────────────────────────────────────────────

class AlpacaPaperClient:
    """Thin wrapper around Alpaca Paper Trading API for options."""

    def __init__(self, api_key=None, api_secret=None):
        self.api_key = api_key or API_KEY
        self.api_secret = api_secret or API_SECRET
        if not self.api_key or not self.api_secret:
            raise ValueError(
                "Alpaca API keys not found. Set DAYTRADE_ALPACA_API_KEY / "
                "DAYTRADE_ALPACA_API_SECRET or ALPACA_API_KEY / ALPACA_SECRET_KEY in .env"
            )
        self.headers = {
            'APCA-API-KEY-ID': self.api_key,
            'APCA-API-SECRET-KEY': self.api_secret,
            'Content-Type': 'application/json',
        }
        self.session = requests.Session()
        self.session.headers.update(self.headers)

    # ── Account ──────────────────────────────────────────────────────────

    def get_account(self):
        """Get account info (equity, buying power, etc)."""
        resp = self.session.get(f"{TRADING_BASE}/v2/account", timeout=15)
        resp.raise_for_status()
        return resp.json()

    # ── Orders ───────────────────────────────────────────────────────────

    def get_orders(self, status='open', limit=100):
        """Get orders. status: open, closed, all."""
        resp = self.session.get(
            f"{TRADING_BASE}/v2/orders",
            params={'status': status, 'limit': limit},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def submit_order(self, symbol, qty, side, order_type, time_in_force,
                     limit_price=None, order_class=None, extended_hours=False):
        """
        Submit an order.

        For options: symbol is OCC format (e.g. "INTC260320P00040000"),
        order_class is not needed (Alpaca infers from symbol format).
        """
        payload = {
            'symbol': symbol,
            'qty': str(qty),
            'side': side,
            'type': order_type,
            'time_in_force': time_in_force,
        }
        if limit_price is not None:
            payload['limit_price'] = str(round(limit_price, 2))
        if order_class:
            payload['order_class'] = order_class
        if extended_hours:
            payload['extended_hours'] = True

        resp = self.session.post(
            f"{TRADING_BASE}/v2/orders",
            json=payload,
            timeout=15,
        )
        if resp.status_code >= 400:
            error_detail = resp.text
            try:
                error_detail = resp.json()
            except Exception:
                pass
            print(f"  ORDER ERROR [{resp.status_code}]: {error_detail}")
        resp.raise_for_status()
        return resp.json()

    def cancel_order(self, order_id):
        """Cancel a single order."""
        resp = self.session.delete(
            f"{TRADING_BASE}/v2/orders/{order_id}", timeout=15
        )
        resp.raise_for_status()
        return True

    def cancel_all_orders(self):
        """Cancel all open orders."""
        resp = self.session.delete(f"{TRADING_BASE}/v2/orders", timeout=15)
        resp.raise_for_status()
        return resp.json() if resp.text else []

    # ── Positions ────────────────────────────────────────────────────────

    def get_positions(self):
        """Get all open positions (stocks + options)."""
        resp = self.session.get(f"{TRADING_BASE}/v2/positions", timeout=15)
        resp.raise_for_status()
        return resp.json()

    def close_position(self, symbol_or_id):
        """Close a specific position."""
        resp = self.session.delete(
            f"{TRADING_BASE}/v2/positions/{symbol_or_id}", timeout=15
        )
        resp.raise_for_status()
        return resp.json()

    def close_all_positions(self, cancel_orders=True):
        """Close all positions. Optionally cancel open orders first."""
        params = {'cancel_orders': str(cancel_orders).lower()}
        resp = self.session.delete(
            f"{TRADING_BASE}/v2/positions",
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json() if resp.text else []

    # ── Market Data ──────────────────────────────────────────────────────

    def get_latest_quote(self, symbol):
        """Get latest stock quote."""
        resp = self.session.get(
            f"{DATA_BASE}/v2/stocks/{symbol}/quotes/latest",
            params={'feed': 'iex'},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get('quote', {})

    def get_latest_trade(self, symbol):
        """Get latest stock trade."""
        resp = self.session.get(
            f"{DATA_BASE}/v2/stocks/{symbol}/trades/latest",
            params={'feed': 'iex'},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get('trade', {})


# ── State Management ─────────────────────────────────────────────────────────

def load_positions():
    """Load paper positions state from disk."""
    if POSITIONS_FILE.exists():
        with open(POSITIONS_FILE, 'r') as f:
            return json.load(f)
    return _default_state()


def save_positions(state):
    """Save paper positions state to disk."""
    state['last_updated'] = datetime.now().isoformat()
    with open(POSITIONS_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def _default_state():
    return {
        'last_updated': None,
        'positions': [],
        'closed_positions': [],
        'total_premium_collected': 0.0,
        'total_realized_pnl': 0.0,
    }


def log_trade(action, details):
    """Append a trade event to the JSONL log."""
    entry = {
        'timestamp': datetime.now().isoformat(),
        'action': action,
        **details,
    }
    with open(TRADE_LOG_FILE, 'a') as f:
        f.write(json.dumps(entry) + '\n')


# ── OCC Symbol Helpers ───────────────────────────────────────────────────────

def build_occ_symbol(ticker, expiry_str, option_type, strike):
    """
    Build OCC option symbol.
    Example: INTC260320P00040000
      ticker=INTC, expiry=2026-03-20, type=P, strike=40.00
    """
    dt = datetime.strptime(expiry_str, '%Y-%m-%d')
    date_part = dt.strftime('%y%m%d')
    type_char = 'P' if option_type.upper() in ('P', 'PUT') else 'C'
    strike_int = int(round(strike * 1000))
    return f"{ticker}{date_part}{type_char}{strike_int:08d}"


def parse_occ_symbol(sym):
    """Parse OCC symbol -> (ticker, expiry_date, type, strike)."""
    i = 0
    while i < len(sym) and sym[i].isalpha():
        i += 1
    if i >= len(sym) - 8:
        return None
    ticker = sym[:i]
    date_str = sym[i:i+6]
    opt_type = 'put' if sym[i+6] == 'P' else 'call'
    strike = float(sym[i+7:]) / 1000.0
    expiry = datetime.strptime(date_str, '%y%m%d').date()
    return {
        'ticker': ticker,
        'expiry': expiry,
        'type': opt_type,
        'strike': strike,
    }


# ── Core Executor ────────────────────────────────────────────────────────────

class WheelPaperExecutor:
    """
    Auto-executes wheel strategy on Alpaca Paper Trading.

    Lifecycle:
      1. Read portfolio allocation JSON
      2. For each position: check existing, submit CSP sell order
      3. Monitor: detect assignments, sell CCs, detect call-aways
      4. Track everything in paper_positions.json + trade log
    """

    def __init__(self, dry_run=False, mode='standard'):
        self.dry_run = dry_run
        self.mode = mode
        self.profile = get_profile(mode)
        self.client = AlpacaPaperClient()
        self.state = load_positions()

    def save(self):
        save_positions(self.state)

    # ── Execute: Read Allocation and Submit Orders ───────────────────────

    def execute(self):
        """Read portfolio allocation and submit CSP sell orders."""
        # Load allocation
        if not ALLOCATION_FILE.exists():
            print("ERROR: No portfolio allocation found.")
            print(f"  Expected: {ALLOCATION_FILE}")
            print("  Run: python portfolio_optimizer.py --optimize")
            return

        with open(ALLOCATION_FILE, 'r') as f:
            allocation = json.load(f)

        positions = allocation.get('positions', [])
        if not positions:
            print("ERROR: Allocation has no positions.")
            return

        # Get account info for buying power validation
        account = self.client.get_account()
        buying_power = float(account.get('buying_power', 0))
        equity = float(account.get('equity', 0))
        print(f"Account: equity=${equity:,.0f} | buying_power=${buying_power:,.0f}")
        print(f"Risk Mode: {self.profile['name']} | "
              f"{'DRY RUN' if self.dry_run else 'LIVE PAPER TRADING'}")
        print(f"Allocation: {len(positions)} positions from {allocation.get('timestamp', '?')}")
        print()

        # Get existing positions and orders to avoid duplicates
        existing_positions = self._get_existing_tickers()
        existing_orders = self._get_pending_order_tickers()

        submitted = 0
        skipped = 0
        errors = 0
        total_collateral_needed = 0

        for pos in positions:
            ticker = pos['ticker']
            strike = pos['strike']
            expiry = pos['expiry']
            contracts = pos['contracts']
            bid = pos['bid']
            symbol = pos.get('symbol') or build_occ_symbol(ticker, expiry, 'P', strike)
            collateral = pos['collateral_per_contract'] * contracts

            print(f"--- {ticker} ---")
            print(f"  SELL {contracts}x {symbol} @ ${bid:.2f} (limit)")
            print(f"  Strike=${strike} Exp={expiry} Collateral=${collateral:,.0f}")

            # Check for existing position or order
            if ticker in existing_positions:
                print(f"  SKIP: Already have position in {ticker}")
                skipped += 1
                continue

            if ticker in existing_orders:
                print(f"  SKIP: Already have pending order for {ticker}")
                skipped += 1
                continue

            # Buying power check
            total_collateral_needed += collateral
            if total_collateral_needed > buying_power:
                print(f"  SKIP: Would exceed buying power "
                      f"(need ${total_collateral_needed:,.0f}, have ${buying_power:,.0f})")
                skipped += 1
                total_collateral_needed -= collateral
                continue

            if self.dry_run:
                print(f"  [DRY RUN] Would submit: SELL {contracts}x {symbol} LIMIT @ ${bid:.2f}")
                submitted += 1
                continue

            # Submit the order
            try:
                order = self.client.submit_order(
                    symbol=symbol,
                    qty=contracts,
                    side='sell',
                    order_type='limit',
                    time_in_force='day',
                    limit_price=bid,
                )
                order_id = order.get('id', '?')
                order_status = order.get('status', '?')
                print(f"  SUBMITTED: order_id={order_id} status={order_status}")

                # Track in state
                self.state['positions'].append({
                    'id': order_id,
                    'ticker': ticker,
                    'symbol': symbol,
                    'phase': 'CSP',
                    'status': 'pending',
                    'strike': strike,
                    'expiry': expiry,
                    'contracts': contracts,
                    'limit_price': bid,
                    'premium_per_contract': bid * 100,
                    'total_premium': bid * 100 * contracts,
                    'collateral': collateral,
                    'delta': pos.get('delta', 0),
                    'iv': pos.get('iv', 0),
                    'sector': pos.get('sector', 'Unknown'),
                    'order_id': order_id,
                    'order_status': order_status,
                    'submitted_at': datetime.now().isoformat(),
                    'filled_at': None,
                    'fill_price': None,
                    'cost_basis': None,
                    'shares_held': 0,
                })

                log_trade('CSP_SUBMIT', {
                    'ticker': ticker,
                    'symbol': symbol,
                    'contracts': contracts,
                    'limit_price': bid,
                    'strike': strike,
                    'expiry': expiry,
                    'collateral': collateral,
                    'order_id': order_id,
                })

                submitted += 1
                time.sleep(0.3)

            except requests.HTTPError as e:
                print(f"  ERROR: {e}")
                errors += 1
                log_trade('CSP_ERROR', {
                    'ticker': ticker,
                    'symbol': symbol,
                    'error': str(e),
                })
                continue

        self.save()

        print(f"\n{'='*50}")
        print(f"EXECUTION SUMMARY {'(DRY RUN)' if self.dry_run else ''}")
        print(f"  Submitted: {submitted}")
        print(f"  Skipped:   {skipped}")
        print(f"  Errors:    {errors}")
        print(f"  Collateral needed: ${total_collateral_needed:,.0f}")
        print(f"{'='*50}")

        return {
            'submitted': submitted,
            'skipped': skipped,
            'errors': errors,
            'collateral': total_collateral_needed,
        }

    # ── Status: Show All Positions and P&L ───────────────────────────────

    def status(self):
        """Display all positions, pending orders, and P&L."""
        account = self.client.get_account()
        equity = float(account.get('equity', 0))
        buying_power = float(account.get('buying_power', 0))
        cash = float(account.get('cash', 0))

        print("=" * 70)
        print("WHEEL STRATEGY — PAPER TRADING STATUS")
        print("=" * 70)
        print(f"Account Equity:   ${equity:>12,.2f}")
        print(f"Cash:             ${cash:>12,.2f}")
        print(f"Buying Power:     ${buying_power:>12,.2f}")
        print()

        # Alpaca positions (what the broker sees)
        alpaca_positions = self.client.get_positions()
        if alpaca_positions:
            print("BROKER POSITIONS:")
            print(f"  {'Symbol':<25s} {'Qty':>5s} {'Side':>6s} {'Avg Cost':>10s} "
                  f"{'Mkt Val':>10s} {'P&L':>10s}")
            print("  " + "-" * 68)
            for p in alpaca_positions:
                sym = p.get('symbol', '?')
                qty = p.get('qty', '?')
                side = p.get('side', '?')
                avg_cost = float(p.get('avg_entry_price', 0))
                mkt_val = float(p.get('market_value', 0))
                pnl = float(p.get('unrealized_pl', 0))
                print(f"  {sym:<25s} {qty:>5s} {side:>6s} ${avg_cost:>9,.2f} "
                      f"${mkt_val:>9,.2f} ${pnl:>+9,.2f}")
            print()

        # Pending orders
        open_orders = self.client.get_orders(status='open')
        if open_orders:
            print("PENDING ORDERS:")
            print(f"  {'Symbol':<25s} {'Side':>5s} {'Qty':>4s} {'Type':>6s} "
                  f"{'Limit':>8s} {'Status':>12s}")
            print("  " + "-" * 62)
            for o in open_orders:
                sym = o.get('symbol', '?')
                side = o.get('side', '?')
                qty = o.get('qty', '?')
                otype = o.get('type', '?')
                limit_p = o.get('limit_price', '-')
                status = o.get('status', '?')
                print(f"  {sym:<25s} {side:>5s} {qty:>4s} {otype:>6s} "
                      f"${str(limit_p):>7s} {status:>12s}")
            print()

        # Internal tracked positions
        tracked = self.state.get('positions', [])
        if tracked:
            print("TRACKED WHEEL POSITIONS:")
            print(f"  {'Ticker':<7s} {'Phase':>5s} {'Strike':>8s} {'Exp':>12s} "
                  f"{'Cts':>4s} {'Premium':>9s} {'Status':>10s}")
            print("  " + "-" * 60)
            for pos in tracked:
                print(f"  {pos['ticker']:<7s} {pos['phase']:>5s} "
                      f"${pos['strike']:>6,.0f} {pos['expiry']:>12s} "
                      f"{pos['contracts']:>4d} "
                      f"${pos['total_premium']:>8,.0f} "
                      f"{pos.get('status', '?'):>10s}")
            print()

        # Closed positions
        closed = self.state.get('closed_positions', [])
        if closed:
            total_realized = sum(c.get('realized_pnl', 0) for c in closed)
            print(f"CLOSED: {len(closed)} positions | Realized P&L: ${total_realized:>+,.2f}")
            print()

        # Summary
        total_premium = self.state.get('total_premium_collected', 0)
        total_pnl = self.state.get('total_realized_pnl', 0)
        print("AGGREGATE:")
        print(f"  Total Premium Collected: ${total_premium:>10,.2f}")
        print(f"  Total Realized P&L:      ${total_pnl:>+10,.2f}")
        print(f"  Active Positions:        {len(tracked)}")
        print(f"  Closed Positions:        {len(closed)}")

        return self._build_discord_status(account, alpaca_positions, open_orders, tracked)

    # ── Monitor: Check for Assignments, Rolls, Expiries ──────────────────

    def monitor(self):
        """
        Monitor positions for:
        1. Order fills (pending -> filled)
        2. Assignment detection (stock appears in positions after CSP)
        3. CSP near expiry with >50% profit -> close early
        4. Stock called away after CC
        """
        print("MONITORING WHEEL POSITIONS...")
        print()

        actions_taken = []

        # 1. Sync order statuses
        self._sync_order_statuses()

        # 2. Check for assignments (stock positions that match our CSP tickers)
        assignments = self._check_assignments()
        for a in assignments:
            actions_taken.append(a)

        # 3. Check for positions near expiry that should be closed or rolled
        rolls = self._check_rolls_and_closes()
        for r in rolls:
            actions_taken.append(r)

        # 4. Check for called-away stocks (CC positions where stock disappeared)
        called_away = self._check_called_away()
        for c in called_away:
            actions_taken.append(c)

        # 5. For assigned stocks without CC, try to sell covered calls
        cc_actions = self._auto_sell_covered_calls()
        for cc in cc_actions:
            actions_taken.append(cc)

        self.save()

        if actions_taken:
            print(f"\nACTIONS TAKEN: {len(actions_taken)}")
            for a in actions_taken:
                print(f"  [{a['action']}] {a['ticker']}: {a['detail']}")
        else:
            print("No actions needed.")

        return actions_taken

    # ── Close All: Emergency Exit ────────────────────────────────────────

    def close_all(self):
        """Emergency close all positions and cancel all orders."""
        print("EMERGENCY CLOSE ALL")
        print("=" * 50)

        if self.dry_run:
            print("[DRY RUN] Would cancel all orders and close all positions.")
            return

        # Cancel all orders
        print("Cancelling all open orders...")
        try:
            cancelled = self.client.cancel_all_orders()
            print(f"  Cancelled {len(cancelled) if isinstance(cancelled, list) else '?'} orders")
        except Exception as e:
            print(f"  Error cancelling orders: {e}")

        time.sleep(1)

        # Close all positions
        print("Closing all positions...")
        try:
            closed = self.client.close_all_positions(cancel_orders=True)
            print(f"  Closed {len(closed) if isinstance(closed, list) else '?'} positions")
        except Exception as e:
            print(f"  Error closing positions: {e}")

        # Update state
        for pos in self.state.get('positions', []):
            pos['status'] = 'emergency_closed'
            pos['closed_at'] = datetime.now().isoformat()
            self.state['closed_positions'].append(pos)

        self.state['positions'] = []
        self.save()

        log_trade('EMERGENCY_CLOSE_ALL', {
            'reason': 'manual',
        })

        print("\nAll positions closed. State updated.")

    # ── Internal Helpers ─────────────────────────────────────────────────

    def _get_existing_tickers(self):
        """Get set of tickers we already have positions in."""
        tickers = set()
        try:
            positions = self.client.get_positions()
            for p in positions:
                sym = p.get('symbol', '')
                # For options, parse the underlying ticker
                parsed = parse_occ_symbol(sym)
                if parsed:
                    tickers.add(parsed['ticker'])
                else:
                    tickers.add(sym)
        except Exception:
            pass

        # Also check tracked state
        for pos in self.state.get('positions', []):
            if pos.get('status') in ('pending', 'filled', 'active', 'assigned'):
                tickers.add(pos['ticker'])

        return tickers

    def _get_pending_order_tickers(self):
        """Get set of tickers with pending orders."""
        tickers = set()
        try:
            orders = self.client.get_orders(status='open')
            for o in orders:
                sym = o.get('symbol', '')
                parsed = parse_occ_symbol(sym)
                if parsed:
                    tickers.add(parsed['ticker'])
                else:
                    tickers.add(sym)
        except Exception:
            pass
        return tickers

    def _sync_order_statuses(self):
        """Update tracked positions with latest order statuses from Alpaca."""
        try:
            # Check filled orders
            recent_orders = self.client.get_orders(status='all', limit=50)
        except Exception as e:
            print(f"  Error fetching orders: {e}")
            return

        order_map = {o['id']: o for o in recent_orders}

        for pos in self.state.get('positions', []):
            oid = pos.get('order_id')
            if not oid or pos.get('status') not in ('pending',):
                continue

            order = order_map.get(oid)
            if not order:
                continue

            new_status = order.get('status', '')
            if new_status == 'filled':
                fill_price = float(order.get('filled_avg_price', 0))
                filled_qty = int(order.get('filled_qty', 0))
                pos['status'] = 'filled'
                pos['order_status'] = 'filled'
                pos['filled_at'] = order.get('filled_at', datetime.now().isoformat())
                pos['fill_price'] = fill_price
                if fill_price > 0:
                    pos['total_premium'] = fill_price * 100 * filled_qty
                self.state['total_premium_collected'] += pos['total_premium']

                print(f"  FILLED: {pos['ticker']} {pos['symbol']} "
                      f"@ ${fill_price:.2f} x{filled_qty}")
                log_trade('CSP_FILLED', {
                    'ticker': pos['ticker'],
                    'symbol': pos['symbol'],
                    'fill_price': fill_price,
                    'contracts': filled_qty,
                    'total_premium': pos['total_premium'],
                })

            elif new_status in ('canceled', 'cancelled', 'expired', 'rejected'):
                pos['status'] = 'cancelled'
                pos['order_status'] = new_status
                print(f"  CANCELLED/EXPIRED: {pos['ticker']} {pos['symbol']} ({new_status})")
                log_trade('ORDER_CANCELLED', {
                    'ticker': pos['ticker'],
                    'symbol': pos['symbol'],
                    'reason': new_status,
                })

    def _check_assignments(self):
        """
        Detect put assignment: if we have stock shares for a ticker where
        we had an active CSP, the put was assigned.
        """
        actions = []
        try:
            alpaca_positions = self.client.get_positions()
        except Exception as e:
            print(f"  Error fetching positions: {e}")
            return actions

        # Build map of stock positions from Alpaca
        stock_holdings = {}
        for p in alpaca_positions:
            sym = p.get('symbol', '')
            asset_class = p.get('asset_class', '')
            # Only look at stock (not option) positions
            if asset_class == 'us_equity' or (not parse_occ_symbol(sym)):
                qty = int(p.get('qty', 0))
                avg_price = float(p.get('avg_entry_price', 0))
                if qty > 0:
                    stock_holdings[sym] = {
                        'qty': qty,
                        'avg_price': avg_price,
                    }

        # Check our CSP positions for assignment
        for pos in self.state.get('positions', []):
            if pos.get('phase') != 'CSP' or pos.get('status') not in ('filled', 'active'):
                continue

            ticker = pos['ticker']
            if ticker in stock_holdings:
                holding = stock_holdings[ticker]
                expected_shares = pos['contracts'] * 100

                # Looks like assignment
                print(f"  ASSIGNMENT DETECTED: {ticker} — "
                      f"{holding['qty']} shares @ ${holding['avg_price']:.2f}")

                pos['phase'] = 'CC_PENDING'
                pos['status'] = 'assigned'
                pos['shares_held'] = holding['qty']
                pos['cost_basis'] = holding['avg_price']
                pos['assigned_at'] = datetime.now().isoformat()

                log_trade('ASSIGNMENT', {
                    'ticker': ticker,
                    'shares': holding['qty'],
                    'cost_basis': holding['avg_price'],
                    'original_strike': pos['strike'],
                    'premium_collected': pos['total_premium'],
                })

                actions.append({
                    'action': 'ASSIGNMENT',
                    'ticker': ticker,
                    'detail': f"Assigned {holding['qty']} shares @ ${holding['avg_price']:.2f}. "
                              f"Net basis: ${holding['avg_price'] - pos.get('fill_price', pos.get('limit_price', 0)):.2f}",
                })

        return actions

    def _check_rolls_and_closes(self):
        """
        Check for positions that should be rolled or closed early.
        Early close threshold comes from the risk profile:
        - safe/standard: 50% profit
        - aggressive: 75% profit
        """
        actions = []
        today = date.today()
        early_close_pct = int(self.profile['early_close_pct'] * 100)

        for pos in self.state.get('positions', []):
            if pos.get('status') not in ('filled', 'active'):
                continue
            if pos.get('phase') not in ('CSP', 'CC'):
                continue

            expiry = date.fromisoformat(pos['expiry'])
            dte = (expiry - today).days

            if dte > 1:
                continue

            # Near expiry — check if we should close early
            if pos['phase'] == 'CSP':
                try:
                    action_detail = (
                        f"CSP ${pos['strike']} exp {pos['expiry']} has {dte} DTE. "
                        f"Consider closing if >{early_close_pct}% profit. "
                        f"[{self.profile['name']} mode]"
                    )
                    print(f"  NEAR EXPIRY: {pos['ticker']} — {action_detail}")
                    actions.append({
                        'action': 'NEAR_EXPIRY',
                        'ticker': pos['ticker'],
                        'detail': action_detail,
                    })
                except Exception:
                    pass

            elif pos['phase'] == 'CC':
                action_detail = (
                    f"CC ${pos['strike']} exp {pos['expiry']} has {dte} DTE. "
                    f"Check if ITM for potential call-away."
                )
                print(f"  NEAR EXPIRY: {pos['ticker']} — {action_detail}")
                actions.append({
                    'action': 'NEAR_EXPIRY',
                    'ticker': pos['ticker'],
                    'detail': action_detail,
                })

        return actions

    def _check_called_away(self):
        """
        Detect shares called away: if we had stock for a CC position
        and now the stock is gone, shares were called away.
        """
        actions = []
        try:
            alpaca_positions = self.client.get_positions()
        except Exception:
            return actions

        stock_tickers = set()
        for p in alpaca_positions:
            sym = p.get('symbol', '')
            if not parse_occ_symbol(sym):
                stock_tickers.add(sym)

        for pos in self.state.get('positions', []):
            if pos.get('phase') != 'CC' or pos.get('status') not in ('active',):
                continue
            if pos.get('shares_held', 0) <= 0:
                continue

            ticker = pos['ticker']
            if ticker not in stock_tickers:
                # Shares gone — called away
                cost_basis = pos.get('cost_basis', pos['strike'])
                call_strike = pos.get('cc_strike', pos['strike'])
                gain = (call_strike - cost_basis) * pos.get('shares_held', 100)
                total_premium = pos.get('total_premium', 0) + pos.get('cc_premium', 0)

                print(f"  CALLED AWAY: {ticker} @ ${call_strike:.2f}")

                pos['status'] = 'closed'
                pos['phase'] = 'COMPLETE'
                pos['closed_at'] = datetime.now().isoformat()
                pos['realized_pnl'] = gain + total_premium
                self.state['total_realized_pnl'] += pos['realized_pnl']
                self.state['closed_positions'].append(pos.copy())

                log_trade('CALLED_AWAY', {
                    'ticker': ticker,
                    'strike': call_strike,
                    'cost_basis': cost_basis,
                    'gain': gain,
                    'total_premium': total_premium,
                })

                actions.append({
                    'action': 'CALLED_AWAY',
                    'ticker': ticker,
                    'detail': f"Shares called away @ ${call_strike:.2f}. "
                              f"Gain: ${gain:+,.2f}. Wheel cycle complete.",
                })

        # Remove closed positions from active list
        self.state['positions'] = [
            p for p in self.state['positions'] if p.get('status') != 'closed'
        ]

        return actions

    def _auto_sell_covered_calls(self):
        """
        For assigned positions (CC_PENDING), automatically find and sell
        covered calls above cost basis.
        """
        actions = []

        # Import the options client for CC scanning
        try:
            sys.path.insert(0, str(SCRIPT_DIR))
            from alpaca_options import AlpacaOptionsClient
            options_client = AlpacaOptionsClient()
        except Exception as e:
            print(f"  Could not load options client for CC scanning: {e}")
            return actions

        for pos in self.state.get('positions', []):
            if pos.get('phase') != 'CC_PENDING' or pos.get('status') != 'assigned':
                continue

            ticker = pos['ticker']
            cost_basis = pos.get('cost_basis', pos['strike'])
            shares = pos.get('shares_held', 100)
            contracts_for_cc = shares // 100

            if contracts_for_cc < 1:
                continue

            print(f"  Scanning CC candidates for {ticker} "
                  f"(basis ${cost_basis:.2f}, {self.profile['name']} mode)...")

            try:
                cc_dte_min = max(3, self.profile['dte_min'] // 2)
                cc_dte_max = self.profile['dte_max']
                cc_candidates = options_client.get_cc_candidates(
                    ticker,
                    cost_basis=cost_basis,
                    dte_range=(cc_dte_min, cc_dte_max),
                )

                if not cc_candidates:
                    print(f"    No CC candidates found for {ticker}")
                    continue

                # Pick best: above cost basis, decent yield, not too far OTM
                above_basis = [c for c in cc_candidates if c['strike'] >= cost_basis]
                if not above_basis:
                    above_basis = cc_candidates  # Fallback to any

                # Sort by weekly yield, take best
                best_cc = max(above_basis[:5], key=lambda c: c['weekly_yield_pct'])

                cc_symbol = best_cc.get('symbol') or build_occ_symbol(
                    ticker, best_cc['expiry'], 'C', best_cc['strike']
                )
                cc_bid = best_cc['bid']

                print(f"    Best CC: {cc_symbol} @ ${cc_bid:.2f} "
                      f"(strike=${best_cc['strike']}, yield={best_cc['weekly_yield_pct']:.2f}%/wk)")

                if self.dry_run:
                    print(f"    [DRY RUN] Would sell {contracts_for_cc}x {cc_symbol} @ ${cc_bid:.2f}")
                    actions.append({
                        'action': 'CC_DRY_RUN',
                        'ticker': ticker,
                        'detail': f"Would sell {contracts_for_cc}x {cc_symbol} @ ${cc_bid:.2f}",
                    })
                    continue

                # Submit CC sell order
                order = self.client.submit_order(
                    symbol=cc_symbol,
                    qty=contracts_for_cc,
                    side='sell',
                    order_type='limit',
                    time_in_force='day',
                    limit_price=cc_bid,
                )

                order_id = order.get('id', '?')
                print(f"    CC ORDER SUBMITTED: {order_id}")

                pos['phase'] = 'CC'
                pos['status'] = 'active'
                pos['cc_symbol'] = cc_symbol
                pos['cc_strike'] = best_cc['strike']
                pos['cc_expiry'] = best_cc['expiry']
                pos['cc_bid'] = cc_bid
                pos['cc_premium'] = cc_bid * 100 * contracts_for_cc
                pos['cc_order_id'] = order_id
                pos['cc_submitted_at'] = datetime.now().isoformat()

                log_trade('CC_SUBMIT', {
                    'ticker': ticker,
                    'symbol': cc_symbol,
                    'strike': best_cc['strike'],
                    'expiry': best_cc['expiry'],
                    'contracts': contracts_for_cc,
                    'limit_price': cc_bid,
                    'order_id': order_id,
                })

                actions.append({
                    'action': 'CC_SUBMITTED',
                    'ticker': ticker,
                    'detail': f"Sold {contracts_for_cc}x {cc_symbol} @ ${cc_bid:.2f}",
                })

                time.sleep(0.3)

            except Exception as e:
                print(f"    Error scanning/submitting CC for {ticker}: {e}")
                continue

        return actions

    # ── Discord Formatting ───────────────────────────────────────────────

    def _build_discord_status(self, account, alpaca_positions, open_orders, tracked):
        """Build a Discord-friendly status message."""
        equity = float(account.get('equity', 0))
        buying_power = float(account.get('buying_power', 0))

        lines = [
            "**Wheel Paper Trading Status**",
            f"Equity: ${equity:,.0f} | BP: ${buying_power:,.0f}",
            f"Positions: {len(tracked)} tracked | {len(alpaca_positions)} broker",
            "",
        ]

        if tracked:
            lines.append("```")
            for pos in tracked:
                phase_emoji = {'CSP': 'P', 'CC': 'C', 'CC_PENDING': 'A'}
                ph = phase_emoji.get(pos.get('phase', ''), '?')
                lines.append(
                    f"[{ph}] {pos['ticker']:<6s} ${pos['strike']:>6,.0f} "
                    f"{pos['expiry']} x{pos['contracts']} "
                    f"${pos['total_premium']:>6,.0f} {pos.get('status', '?')}"
                )
            lines.append("```")

        total_prem = self.state.get('total_premium_collected', 0)
        total_pnl = self.state.get('total_realized_pnl', 0)
        lines.append(f"Premium: ${total_prem:,.0f} | Realized: ${total_pnl:+,.0f}")

        return '\n'.join(lines)

    def format_trade_confirmation(self, action, pos):
        """Format a trade confirmation for Discord."""
        if action == 'CSP_FILLED':
            return (
                f"**CSP Filled: {pos['ticker']}**\n"
                f"SELL {pos['contracts']}x {pos['symbol']} @ ${pos.get('fill_price', pos['limit_price']):.2f}\n"
                f"Strike: ${pos['strike']} | Exp: {pos['expiry']}\n"
                f"Premium: ${pos['total_premium']:,.0f} | Collateral: ${pos['collateral']:,.0f}"
            )
        elif action == 'CC_SUBMITTED':
            return (
                f"**CC Submitted: {pos['ticker']}**\n"
                f"SELL {pos.get('shares_held', 100) // 100}x {pos.get('cc_symbol', '?')} "
                f"@ ${pos.get('cc_bid', 0):.2f}\n"
                f"Strike: ${pos.get('cc_strike', 0)} | Exp: {pos.get('cc_expiry', '?')}\n"
                f"Cost Basis: ${pos.get('cost_basis', 0):.2f}"
            )
        elif action == 'ASSIGNMENT':
            return (
                f"**Put Assigned: {pos['ticker']}**\n"
                f"Now holding {pos.get('shares_held', 100)} shares "
                f"@ ${pos.get('cost_basis', 0):.2f}\n"
                f"Switching to Covered Call mode."
            )
        elif action == 'CALLED_AWAY':
            return (
                f"**Shares Called Away: {pos['ticker']}**\n"
                f"Sold @ ${pos.get('cc_strike', pos['strike']):.2f}\n"
                f"Total P&L: ${pos.get('realized_pnl', 0):+,.2f}\n"
                f"Wheel cycle complete. Ready for new CSP."
            )
        return f"[{action}] {pos['ticker']}"


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Wheel Strategy Paper Trade Auto-Executor (Alpaca)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Risk modes control CC delta targets, DTE ranges, and early-close thresholds:
  safe        CC delta 0.20-0.25, 30-45 DTE, close at 50% profit
  standard    CC delta 0.30-0.35, 14-30 DTE, close at 50% profit (default)
  aggressive  CC delta 0.40-0.50, 7-14 DTE, close at 75% profit

Examples:
  python paper_executor.py --execute --mode safe --dry-run
  python paper_executor.py --execute --mode aggressive
  python paper_executor.py --monitor --mode safe
        """,
    )
    parser.add_argument('--execute', action='store_true',
                        help='Read allocation and submit CSP orders')
    parser.add_argument('--status', action='store_true',
                        help='Show all positions, orders, and P&L')
    parser.add_argument('--monitor', action='store_true',
                        help='Check for assignments, rolls, expiries')
    parser.add_argument('--close-all', action='store_true',
                        help='Emergency close all positions and cancel orders')
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview actions without submitting orders')
    parser.add_argument('--mode', type=str, default='standard',
                        choices=VALID_MODES,
                        help='Risk profile: safe, standard, aggressive (default: standard)')
    args = parser.parse_args()

    if not any([args.execute, args.status, args.monitor, args.close_all]):
        parser.print_help()
        print("\nChoose a mode: --execute, --status, --monitor, or --close-all")
        return

    executor = WheelPaperExecutor(dry_run=args.dry_run, mode=args.mode)

    if args.execute:
        executor.execute()
    elif args.status:
        executor.status()
    elif args.monitor:
        executor.monitor()
    elif args.close_all:
        if args.dry_run:
            print("[DRY RUN] Would close all positions and cancel all orders.")
        else:
            confirm = input("Are you sure? This will close ALL positions. (yes/no): ")
            if confirm.lower() == 'yes':
                executor.close_all()
            else:
                print("Aborted.")


if __name__ == '__main__':
    main()
