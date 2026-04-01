"""
Alpaca Trade Sync — Pull real trade history from Alpaca paper trading account.

Connects to Alpaca REST API to:
1. Pull ALL historical orders (filled, cancelled, expired) for options
2. Pull current positions and account equity
3. Sync into our trade journal format
4. Reconcile: compare internal journal vs Alpaca records
5. Flag discrepancies

Usage:
    python -m trading_agents.wheel_strategy.alpaca_sync pull
    python -m trading_agents.wheel_strategy.alpaca_sync reconcile
    python -m trading_agents.wheel_strategy.alpaca_sync positions
    python -m trading_agents.wheel_strategy.alpaca_sync account
"""

import os
import sys
import json
import datetime
import argparse
import requests
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

DATA_DIR = os.path.join(SCRIPT_DIR, "data")
ALPACA_ORDERS_FILE = os.path.join(DATA_DIR, "alpaca_orders.json")
ALPACA_POSITIONS_FILE = os.path.join(DATA_DIR, "alpaca_positions.json")
ALPACA_ACCOUNT_FILE = os.path.join(DATA_DIR, "alpaca_account.json")
RECONCILIATION_FILE = os.path.join(DATA_DIR, "reconciliation_report.json")

# Alpaca Paper Trading API
ALPACA_BASE_URL = "https://paper-api.alpaca.markets"
ALPACA_DATA_URL = "https://data.alpaca.markets"


def _get_credentials():
    """Load Alpaca API credentials from environment or .env file."""
    api_key = os.environ.get("ALPACA_API_KEY")
    secret_key = os.environ.get("ALPACA_SECRET_KEY")

    if not api_key or not secret_key:
        # Try loading from .env
        env_path = os.path.join(PROJECT_ROOT, ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("ALPACA_API_KEY="):
                        api_key = line.split("=", 1)[1].strip()
                    elif line.startswith("ALPACA_SECRET_KEY="):
                        secret_key = line.split("=", 1)[1].strip()

    if not api_key or not secret_key:
        raise RuntimeError(
            "Missing ALPACA_API_KEY or ALPACA_SECRET_KEY. "
            "Set in environment or .env file."
        )
    return api_key, secret_key


def _headers():
    """Get Alpaca API headers."""
    api_key, secret_key = _get_credentials()
    return {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": secret_key,
        "Accept": "application/json",
    }


class AlpacaSync:
    """Sync trade data from Alpaca paper trading account."""

    def __init__(self):
        self.headers = _headers()
        os.makedirs(DATA_DIR, exist_ok=True)

    # ── Account & Positions ─────────────────────────────────────────────

    def get_account(self):
        """Fetch account info from Alpaca."""
        resp = requests.get(
            f"{ALPACA_BASE_URL}/v2/account",
            headers=self.headers,
            timeout=15,
        )
        resp.raise_for_status()
        account = resp.json()

        # Save locally
        with open(ALPACA_ACCOUNT_FILE, "w") as f:
            json.dump(account, f, indent=2)

        return account

    def get_positions(self):
        """Fetch all current positions from Alpaca."""
        resp = requests.get(
            f"{ALPACA_BASE_URL}/v2/positions",
            headers=self.headers,
            timeout=15,
        )
        resp.raise_for_status()
        positions = resp.json()

        # Save locally
        with open(ALPACA_POSITIONS_FILE, "w") as f:
            json.dump(positions, f, indent=2)

        return positions

    # ── Order History ───────────────────────────────────────────────────

    def get_all_orders(self, status="all", limit=500, after=None):
        """
        Fetch all orders from Alpaca, paginating if needed.

        Args:
            status: 'open', 'closed', or 'all'
            limit: max per page (500 max)
            after: ISO date string to fetch orders after this date

        Returns:
            list of order dicts
        """
        all_orders = []
        params = {
            "status": status,
            "limit": min(limit, 500),
            "direction": "asc",
            "nested": "true",
        }
        if after:
            params["after"] = after

        while True:
            resp = requests.get(
                f"{ALPACA_BASE_URL}/v2/orders",
                headers=self.headers,
                params=params,
                timeout=30,
            )
            resp.raise_for_status()
            orders = resp.json()

            if not orders:
                break

            all_orders.extend(orders)

            # Paginate using the last order's created_at
            if len(orders) < params["limit"]:
                break

            last_ts = orders[-1].get("created_at", "")
            params["after"] = last_ts

        return all_orders

    def pull_option_orders(self):
        """Pull all option-related orders from Alpaca."""
        all_orders = self.get_all_orders()

        # Filter for option orders (asset_class == 'us_option' or symbol contains option format)
        option_orders = []
        stock_orders = []

        for order in all_orders:
            asset_class = order.get("asset_class", "us_equity")
            symbol = order.get("symbol", "")

            if asset_class == "us_option" or len(symbol) > 10:
                option_orders.append(order)
            else:
                stock_orders.append(order)

        result = {
            "pulled_at": datetime.datetime.now().isoformat(),
            "total_orders": len(all_orders),
            "option_orders": len(option_orders),
            "stock_orders": len(stock_orders),
            "options": option_orders,
            "stocks": stock_orders,
        }

        with open(ALPACA_ORDERS_FILE, "w") as f:
            json.dump(result, f, indent=2)

        return result

    # ── Parse Option Symbol ─────────────────────────────────────────────

    @staticmethod
    def parse_option_symbol(symbol):
        """
        Parse OCC option symbol format: AAPL260417C00230000
        Returns dict with ticker, expiry, type, strike.
        """
        if len(symbol) < 15:
            return {"ticker": symbol, "type": "stock"}

        try:
            # Last 8 digits = strike * 1000
            strike_raw = symbol[-8:]
            strike = int(strike_raw) / 1000.0

            # C or P before strike
            option_type = symbol[-9]  # 'C' or 'P'

            # Date is 6 digits before that
            date_str = symbol[-15:-9]
            expiry = f"20{date_str[:2]}-{date_str[2:4]}-{date_str[4:6]}"

            # Ticker is everything before the date
            ticker = symbol[:-15]

            return {
                "ticker": ticker,
                "expiry": expiry,
                "type": "call" if option_type == "C" else "put",
                "strike": strike,
                "raw_symbol": symbol,
            }
        except (ValueError, IndexError):
            return {"ticker": symbol, "type": "unknown"}

    # ── Convert to Journal Format ───────────────────────────────────────

    def orders_to_journal_format(self, orders):
        """
        Convert Alpaca orders to our trade journal format.

        Maps Alpaca order data to the format used by TradeJournal.
        """
        journal_entries = []

        for order in orders:
            if order.get("status") not in ("filled", "partially_filled"):
                continue

            parsed = self.parse_option_symbol(order.get("symbol", ""))
            if parsed.get("type") in ("unknown", "stock"):
                continue

            filled_qty = float(order.get("filled_qty", 0))
            filled_avg = float(order.get("filled_avg_price", 0))
            side = order.get("side", "")

            entry = {
                "alpaca_order_id": order.get("id"),
                "ticker": parsed.get("ticker", ""),
                "option_type": parsed.get("type", ""),
                "strike": parsed.get("strike", 0),
                "expiry": parsed.get("expiry", ""),
                "side": side,
                "quantity": filled_qty,
                "fill_price": filled_avg,
                "total_premium": filled_avg * filled_qty * 100,
                "filled_at": order.get("filled_at", ""),
                "created_at": order.get("created_at", ""),
                "order_type": order.get("type", ""),
                "status": order.get("status", ""),
                "time_in_force": order.get("time_in_force", ""),
                # Map to wheel action
                "wheel_action": self._classify_wheel_action(side, parsed),
            }
            journal_entries.append(entry)

        return journal_entries

    @staticmethod
    def _classify_wheel_action(side, parsed):
        """Classify an option trade as a wheel action."""
        opt_type = parsed.get("type", "")
        if side == "sell" and opt_type == "put":
            return "SELL_CSP"
        elif side == "buy" and opt_type == "put":
            return "BUY_TO_CLOSE_PUT"
        elif side == "sell" and opt_type == "call":
            return "SELL_CC"
        elif side == "buy" and opt_type == "call":
            return "BUY_TO_CLOSE_CALL"
        return "UNKNOWN"

    # ── Reconciliation ──────────────────────────────────────────────────

    def reconcile(self):
        """
        Compare internal trade journal vs Alpaca actual records.
        Returns reconciliation report with discrepancies.
        """
        from trading_agents.wheel_strategy.trade_journal import TradeJournal

        # Pull fresh data from Alpaca
        order_data = self.pull_option_orders()
        alpaca_entries = self.orders_to_journal_format(order_data.get("options", []))

        # Load internal journal
        journal = TradeJournal()
        internal_entries = journal.all_entries()

        report = {
            "timestamp": datetime.datetime.now().isoformat(),
            "alpaca_filled_options": len(alpaca_entries),
            "internal_journal_entries": len(internal_entries),
            "discrepancies": [],
            "alpaca_only": [],
            "internal_only": [],
            "matched": [],
        }

        # Build lookup by ticker+strike+expiry for matching
        alpaca_by_key = defaultdict(list)
        for entry in alpaca_entries:
            key = f"{entry['ticker']}_{entry['strike']}_{entry['expiry']}_{entry['wheel_action']}"
            alpaca_by_key[key].append(entry)

        internal_by_key = defaultdict(list)
        for entry in internal_entries:
            ticker = entry.get("ticker", "")
            strike = entry.get("strike", 0)
            expiry = entry.get("expiry", "")
            action = entry.get("action", "")
            key = f"{ticker}_{strike}_{expiry}_{action}"
            internal_by_key[key].append(entry)

        # Find matches and discrepancies
        all_keys = set(list(alpaca_by_key.keys()) + list(internal_by_key.keys()))

        for key in all_keys:
            a_list = alpaca_by_key.get(key, [])
            i_list = internal_by_key.get(key, [])

            if a_list and not i_list:
                for a in a_list:
                    report["alpaca_only"].append({
                        "key": key,
                        "alpaca_order_id": a.get("alpaca_order_id"),
                        "action": a.get("wheel_action"),
                        "fill_price": a.get("fill_price"),
                        "filled_at": a.get("filled_at"),
                    })
            elif i_list and not a_list:
                for i in i_list:
                    report["internal_only"].append({
                        "key": key,
                        "entry_id": i.get("id"),
                        "action": i.get("action"),
                        "premium": i.get("premium"),
                    })
            else:
                # Both exist — check for price discrepancies
                for a in a_list:
                    matched = False
                    for i in i_list:
                        a_price = a.get("fill_price", 0)
                        i_price = i.get("premium", 0)
                        if abs(a_price - i_price) < 0.05:
                            report["matched"].append({
                                "key": key,
                                "alpaca_price": a_price,
                                "internal_price": i_price,
                            })
                            matched = True
                            break
                    if not matched:
                        report["discrepancies"].append({
                            "key": key,
                            "type": "price_mismatch",
                            "alpaca_price": a.get("fill_price"),
                            "internal_price": i_list[0].get("premium") if i_list else None,
                            "alpaca_order_id": a.get("alpaca_order_id"),
                        })

        # Summary
        report["summary"] = {
            "matched_trades": len(report["matched"]),
            "alpaca_only_trades": len(report["alpaca_only"]),
            "internal_only_trades": len(report["internal_only"]),
            "price_discrepancies": len(report["discrepancies"]),
            "sync_status": "CLEAN" if not report["discrepancies"] and not report["alpaca_only"] else "NEEDS_REVIEW",
        }

        with open(RECONCILIATION_FILE, "w") as f:
            json.dump(report, f, indent=2)

        return report

    # ── Formatters ──────────────────────────────────────────────────────

    def format_account_summary(self, account=None):
        """Format account info for display."""
        if account is None:
            account = self.get_account()

        equity = float(account.get("equity", 0))
        cash = float(account.get("cash", 0))
        buying_power = float(account.get("buying_power", 0))
        portfolio_value = float(account.get("portfolio_value", 0))
        pnl = float(account.get("equity", 0)) - float(account.get("last_equity", equity))

        lines = [
            "=== Alpaca Account Summary ===",
            f"  Equity:        ${equity:>12,.2f}",
            f"  Cash:          ${cash:>12,.2f}",
            f"  Buying Power:  ${buying_power:>12,.2f}",
            f"  Portfolio Val:  ${portfolio_value:>12,.2f}",
            f"  Daily P&L:     ${pnl:>12,.2f}",
            f"  Status:        {account.get('status', 'N/A')}",
            f"  Pattern Day Trader: {account.get('pattern_day_trader', 'N/A')}",
        ]
        return "\n".join(lines)

    def format_positions_summary(self, positions=None):
        """Format positions for display."""
        if positions is None:
            positions = self.get_positions()

        if not positions:
            return "No open positions."

        lines = ["=== Alpaca Open Positions ===", ""]
        lines.append(f"{'Symbol':<20} {'Qty':>6} {'Avg Cost':>10} {'Market':>10} {'P&L':>10} {'P&L%':>8}")
        lines.append("-" * 70)

        total_pnl = 0
        for pos in positions:
            symbol = pos.get("symbol", "")
            qty = float(pos.get("qty", 0))
            avg_cost = float(pos.get("avg_entry_price", 0))
            market = float(pos.get("current_price", 0))
            unrealized = float(pos.get("unrealized_pl", 0))
            pnl_pct = float(pos.get("unrealized_plpc", 0)) * 100

            total_pnl += unrealized
            lines.append(
                f"{symbol:<20} {qty:>6.0f} ${avg_cost:>9.2f} ${market:>9.2f} "
                f"${unrealized:>9.2f} {pnl_pct:>7.1f}%"
            )

        lines.append("-" * 70)
        lines.append(f"{'Total Unrealized P&L':>48} ${total_pnl:>9.2f}")
        return "\n".join(lines)

    def format_reconciliation_report(self, report=None):
        """Format reconciliation report for Discord."""
        if report is None:
            report = self.reconcile()

        s = report.get("summary", {})
        lines = [
            "=== Trade Reconciliation Report ===",
            f"  Alpaca option fills:  {report.get('alpaca_filled_options', 0)}",
            f"  Internal journal:     {report.get('internal_journal_entries', 0)}",
            "",
            f"  Matched:              {s.get('matched_trades', 0)}",
            f"  Alpaca-only:          {s.get('alpaca_only_trades', 0)}",
            f"  Internal-only:        {s.get('internal_only_trades', 0)}",
            f"  Price mismatches:     {s.get('price_discrepancies', 0)}",
            f"  Status:               **{s.get('sync_status', 'UNKNOWN')}**",
        ]

        if report.get("alpaca_only"):
            lines.append("\n  --- Trades in Alpaca but NOT in journal ---")
            for item in report["alpaca_only"][:10]:
                lines.append(f"    {item['key']} (filled: {item.get('filled_at', 'N/A')[:10]})")

        if report.get("discrepancies"):
            lines.append("\n  --- Price Discrepancies ---")
            for item in report["discrepancies"][:10]:
                lines.append(
                    f"    {item['key']}: Alpaca=${item.get('alpaca_price', 0):.2f} "
                    f"vs Internal=${item.get('internal_price', 0):.2f}"
                )

        return "\n".join(lines)

    def format_discord_sync_report(self):
        """Generate a full Discord-formatted sync report."""
        try:
            account = self.get_account()
            positions = self.get_positions()
            orders = self.pull_option_orders()

            parts = [
                self.format_account_summary(account),
                "",
                self.format_positions_summary(positions),
                "",
                f"Total orders pulled: {orders.get('total_orders', 0)}",
                f"  Option orders: {orders.get('option_orders', 0)}",
                f"  Stock orders:  {orders.get('stock_orders', 0)}",
            ]

            filled = [o for o in orders.get("options", []) if o.get("status") == "filled"]
            if filled:
                parts.append(f"\nFilled option trades: {len(filled)}")
                for o in filled[-5:]:
                    parsed = self.parse_option_symbol(o.get("symbol", ""))
                    parts.append(
                        f"  {o.get('side','').upper()} {parsed.get('ticker','')} "
                        f"${parsed.get('strike',0):.0f} {parsed.get('type','')} "
                        f"exp {parsed.get('expiry','')} @ ${float(o.get('filled_avg_price',0)):.2f}"
                    )

            return "\n".join(parts)

        except Exception as e:
            return f"Error syncing with Alpaca: {e}"


def main():
    parser = argparse.ArgumentParser(description="Alpaca Trade Sync")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("pull", help="Pull all orders from Alpaca")
    subparsers.add_parser("positions", help="Show current positions")
    subparsers.add_parser("account", help="Show account info")
    subparsers.add_parser("reconcile", help="Reconcile Alpaca vs internal journal")
    subparsers.add_parser("sync-report", help="Full sync report")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    sync = AlpacaSync()

    if args.command == "pull":
        result = sync.pull_option_orders()
        print(f"Pulled {result['total_orders']} total orders")
        print(f"  Option orders: {result['option_orders']}")
        print(f"  Stock orders: {result['stock_orders']}")
        filled = [o for o in result.get("options", []) if o.get("status") == "filled"]
        print(f"  Filled options: {len(filled)}")
        entries = sync.orders_to_journal_format(result.get("options", []))
        print(f"\nConverted to {len(entries)} journal entries:")
        for e in entries[:10]:
            print(f"  {e['wheel_action']} {e['ticker']} ${e['strike']:.0f} "
                  f"{e['option_type']} @ ${e['fill_price']:.2f} ({e['filled_at'][:10] if e['filled_at'] else 'N/A'})")

    elif args.command == "positions":
        print(sync.format_positions_summary())

    elif args.command == "account":
        print(sync.format_account_summary())

    elif args.command == "reconcile":
        print(sync.format_reconciliation_report())

    elif args.command == "sync-report":
        print(sync.format_discord_sync_report())


if __name__ == "__main__":
    main()
