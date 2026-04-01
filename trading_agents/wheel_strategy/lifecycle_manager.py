"""
Wheel Strategy Position Lifecycle Manager.

Tracks full wheel cycles end-to-end:
1. CSP opened -> monitor -> assigned or expired
2. If assigned: auto-queue covered call
3. CC sold -> monitor -> called away or expired
4. Full cycle P&L tracking (total premium from CSP + CC vs stock movement)
5. Rolling decision logic: when to roll vs take assignment
6. Save lifecycle state to data/wheel_cycles.jsonl

Usage:
    from trading_agents.wheel_strategy.lifecycle_manager import LifecycleManager

    lm = LifecycleManager()

    # Start a new wheel cycle
    cycle_id = lm.open_csp("AAPL", strike=220, premium=3.50, expiry="2026-04-17",
                            stock_price=230, delta=-0.25, iv_rank=45)

    # CSP expired worthless
    lm.csp_expired(cycle_id, stock_price=235)

    # Or CSP assigned
    lm.csp_assigned(cycle_id, stock_price=218)

    # Sell covered call on assigned shares
    lm.open_cc(cycle_id, strike=225, premium=2.80, expiry="2026-05-01", stock_price=220)

    # CC called away
    lm.cc_called_away(cycle_id, stock_price=228)

    # Check if roll is recommended
    recommendation = lm.check_roll(cycle_id, current_price=215)

CLI:
    python -m trading_agents.wheel_strategy.lifecycle_manager status
    python -m trading_agents.wheel_strategy.lifecycle_manager cycles
    python -m trading_agents.wheel_strategy.lifecycle_manager monitor
"""

import os
import sys
import json
import uuid
import datetime
import argparse
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

DATA_DIR = os.path.join(SCRIPT_DIR, "data")
CYCLES_FILE = os.path.join(DATA_DIR, "wheel_cycles.jsonl")
ACTIVE_CYCLES_FILE = os.path.join(DATA_DIR, "active_cycles.json")


class LifecycleManager:
    """Track full wheel strategy cycles from CSP to completion."""

    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self._active_cycles = self._load_active_cycles()

    # ── Persistence ─────────────────────────────────────────────────────

    def _load_active_cycles(self):
        """Load active cycles from JSON file."""
        if os.path.exists(ACTIVE_CYCLES_FILE):
            try:
                with open(ACTIVE_CYCLES_FILE) as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return {"cycles": {}, "last_updated": None}

    def _save_active_cycles(self):
        """Save active cycles to JSON file."""
        self._active_cycles["last_updated"] = datetime.datetime.now().isoformat()
        with open(ACTIVE_CYCLES_FILE, "w") as f:
            json.dump(self._active_cycles, f, indent=2)

    def _append_completed_cycle(self, cycle):
        """Append a completed cycle to the JSONL archive."""
        with open(CYCLES_FILE, "a") as f:
            f.write(json.dumps(cycle) + "\n")

    def _load_completed_cycles(self):
        """Load all completed cycles from JSONL."""
        cycles = []
        if os.path.exists(CYCLES_FILE):
            with open(CYCLES_FILE) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            cycles.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
        return cycles

    # ── Cycle Creation ──────────────────────────────────────────────────

    def open_csp(self, ticker, strike, premium, expiry, stock_price,
                 delta=None, iv_rank=None, contracts=1, validation_result=None):
        """
        Open a new wheel cycle with a Cash-Secured Put.

        Returns:
            cycle_id: str
        """
        cycle_id = str(uuid.uuid4())[:8]

        cycle = {
            "id": cycle_id,
            "ticker": ticker,
            "status": "CSP_OPEN",
            "phase": "csp",
            "created_at": datetime.datetime.now().isoformat(),
            "contracts": contracts,
            "csp": {
                "strike": strike,
                "premium_per_share": premium,
                "total_premium": premium * contracts * 100,
                "expiry": expiry,
                "entry_stock_price": stock_price,
                "entry_delta": delta,
                "entry_iv_rank": iv_rank,
                "opened_at": datetime.datetime.now().isoformat(),
                "status": "OPEN",
            },
            "cc": None,
            "rolls": [],
            "stock_holding": None,
            "total_premium_collected": premium * contracts * 100,
            "total_premium_paid": 0,
            "realized_pnl": 0,
            "validation": validation_result,
            "events": [
                {
                    "type": "CSP_OPENED",
                    "timestamp": datetime.datetime.now().isoformat(),
                    "details": f"Sold {ticker} ${strike} Put @ ${premium:.2f} exp {expiry}",
                }
            ],
        }

        self._active_cycles["cycles"][cycle_id] = cycle
        self._save_active_cycles()

        return cycle_id

    # ── CSP Outcomes ────────────────────────────────────────────────────

    def csp_expired(self, cycle_id, stock_price):
        """CSP expired OTM — premium kept, cycle complete."""
        cycle = self._get_cycle(cycle_id)
        if not cycle:
            raise ValueError(f"Cycle {cycle_id} not found")

        csp = cycle["csp"]
        csp["status"] = "EXPIRED_OTM"
        csp["closed_at"] = datetime.datetime.now().isoformat()
        csp["close_stock_price"] = stock_price

        cycle["status"] = "COMPLETED"
        cycle["realized_pnl"] = cycle["total_premium_collected"] - cycle["total_premium_paid"]
        cycle["completed_at"] = datetime.datetime.now().isoformat()
        cycle["completion_type"] = "CSP_EXPIRED"

        cycle["events"].append({
            "type": "CSP_EXPIRED",
            "timestamp": datetime.datetime.now().isoformat(),
            "details": f"Put expired OTM. Stock: ${stock_price:.2f}. "
                       f"Premium kept: ${csp['total_premium']:.2f}",
        })

        # Move to completed
        self._complete_cycle(cycle_id)
        return cycle

    def csp_assigned(self, cycle_id, stock_price):
        """CSP assigned — we now own the shares. Queue covered call."""
        cycle = self._get_cycle(cycle_id)
        if not cycle:
            raise ValueError(f"Cycle {cycle_id} not found")

        csp = cycle["csp"]
        csp["status"] = "ASSIGNED"
        csp["assigned_at"] = datetime.datetime.now().isoformat()
        csp["assignment_price"] = stock_price

        # Calculate cost basis (strike - premium received)
        cost_basis = csp["strike"] - csp["premium_per_share"]

        cycle["stock_holding"] = {
            "shares": cycle["contracts"] * 100,
            "cost_basis": cost_basis,
            "assigned_at": datetime.datetime.now().isoformat(),
            "assigned_price": stock_price,
        }

        cycle["status"] = "ASSIGNED_AWAITING_CC"
        cycle["phase"] = "stock_holding"

        cycle["events"].append({
            "type": "CSP_ASSIGNED",
            "timestamp": datetime.datetime.now().isoformat(),
            "details": f"Assigned at ${csp['strike']:.2f}. "
                       f"Cost basis: ${cost_basis:.2f}. Stock: ${stock_price:.2f}. "
                       f"Unrealized: ${(stock_price - cost_basis) * cycle['contracts'] * 100:.2f}",
        })

        self._save_active_cycles()
        return cycle

    # ── Covered Call Operations ─────────────────────────────────────────

    def open_cc(self, cycle_id, strike, premium, expiry, stock_price, delta=None):
        """Sell a covered call on assigned shares."""
        cycle = self._get_cycle(cycle_id)
        if not cycle:
            raise ValueError(f"Cycle {cycle_id} not found")

        if not cycle.get("stock_holding"):
            raise ValueError(f"Cycle {cycle_id} has no stock holding — can't sell CC")

        cc_premium_total = premium * cycle["contracts"] * 100

        cycle["cc"] = {
            "strike": strike,
            "premium_per_share": premium,
            "total_premium": cc_premium_total,
            "expiry": expiry,
            "entry_stock_price": stock_price,
            "entry_delta": delta,
            "opened_at": datetime.datetime.now().isoformat(),
            "status": "OPEN",
        }

        cycle["total_premium_collected"] += cc_premium_total
        cycle["status"] = "CC_OPEN"
        cycle["phase"] = "cc"

        cycle["events"].append({
            "type": "CC_OPENED",
            "timestamp": datetime.datetime.now().isoformat(),
            "details": f"Sold {cycle['ticker']} ${strike} Call @ ${premium:.2f} exp {expiry}",
        })

        self._save_active_cycles()
        return cycle

    def cc_expired(self, cycle_id, stock_price):
        """CC expired OTM — keep shares, can sell another CC."""
        cycle = self._get_cycle(cycle_id)
        if not cycle or not cycle.get("cc"):
            raise ValueError(f"Cycle {cycle_id} has no CC")

        cc = cycle["cc"]
        cc["status"] = "EXPIRED_OTM"
        cc["closed_at"] = datetime.datetime.now().isoformat()
        cc["close_stock_price"] = stock_price

        cycle["status"] = "ASSIGNED_AWAITING_CC"
        cycle["phase"] = "stock_holding"
        cycle["cc"] = None  # Clear CC so a new one can be sold

        cycle["events"].append({
            "type": "CC_EXPIRED",
            "timestamp": datetime.datetime.now().isoformat(),
            "details": f"Call expired OTM. Stock: ${stock_price:.2f}. "
                       f"Premium kept: ${cc['total_premium']:.2f}. Ready for new CC.",
        })

        self._save_active_cycles()
        return cycle

    def cc_called_away(self, cycle_id, stock_price):
        """CC exercised — shares called away. Full wheel cycle complete."""
        cycle = self._get_cycle(cycle_id)
        if not cycle or not cycle.get("cc"):
            raise ValueError(f"Cycle {cycle_id} has no CC")

        cc = cycle["cc"]
        cc["status"] = "CALLED_AWAY"
        cc["closed_at"] = datetime.datetime.now().isoformat()
        cc["close_stock_price"] = stock_price

        # Calculate full cycle P&L
        holding = cycle["stock_holding"]
        cost_basis = holding["cost_basis"]
        call_strike = cc["strike"]

        # Stock gain/loss
        stock_pnl = (call_strike - cost_basis) * cycle["contracts"] * 100
        # Total premium from all options
        total_premium = cycle["total_premium_collected"] - cycle["total_premium_paid"]
        # Full P&L
        full_pnl = stock_pnl + total_premium

        cycle["realized_pnl"] = round(full_pnl, 2)
        cycle["stock_holding"]["sold_at"] = call_strike
        cycle["stock_holding"]["stock_pnl"] = round(stock_pnl, 2)
        cycle["status"] = "COMPLETED"
        cycle["completed_at"] = datetime.datetime.now().isoformat()
        cycle["completion_type"] = "CC_CALLED_AWAY"

        cycle["events"].append({
            "type": "CC_CALLED_AWAY",
            "timestamp": datetime.datetime.now().isoformat(),
            "details": f"Called away at ${call_strike:.2f}. "
                       f"Stock P&L: ${stock_pnl:.2f}. "
                       f"Total premium: ${total_premium:.2f}. "
                       f"Full cycle P&L: ${full_pnl:.2f}",
        })

        self._complete_cycle(cycle_id)
        return cycle

    # ── Rolling ─────────────────────────────────────────────────────────

    def check_roll(self, cycle_id, current_price, days_to_expiry=None):
        """
        Check if rolling is recommended for a position.

        Returns:
            dict with recommendation and reasoning
        """
        cycle = self._get_cycle(cycle_id)
        if not cycle:
            return {"action": "NONE", "reason": "Cycle not found"}

        recommendation = {
            "cycle_id": cycle_id,
            "ticker": cycle["ticker"],
            "action": "HOLD",
            "reason": "",
            "details": {},
        }

        phase = cycle.get("phase", "")

        if phase == "csp":
            csp = cycle["csp"]
            strike = csp["strike"]
            expiry = csp["expiry"]

            # Calculate DTE
            if days_to_expiry is None:
                try:
                    exp_date = datetime.date.fromisoformat(expiry)
                    days_to_expiry = (exp_date - datetime.date.today()).days
                except ValueError:
                    days_to_expiry = 30

            # ITM check
            itm_pct = (strike - current_price) / current_price if current_price > 0 else 0

            if days_to_expiry <= 7 and itm_pct > 0.02:
                recommendation["action"] = "ROLL_DOWN_OUT"
                recommendation["reason"] = (
                    f"CSP is ITM by {itm_pct*100:.1f}% with {days_to_expiry} DTE. "
                    f"Roll down and out to avoid assignment at a loss."
                )
            elif days_to_expiry <= 5 and itm_pct <= 0:
                recommendation["action"] = "LET_EXPIRE"
                recommendation["reason"] = (
                    f"CSP is OTM by {abs(itm_pct)*100:.1f}% with {days_to_expiry} DTE. "
                    f"Let expire worthless."
                )
            elif itm_pct > 0.05:
                recommendation["action"] = "ROLL_OR_ACCEPT_ASSIGNMENT"
                recommendation["reason"] = (
                    f"CSP is deep ITM ({itm_pct*100:.1f}%). "
                    f"Roll down/out for credit, or accept assignment if bullish on {cycle['ticker']}."
                )

        elif phase == "cc":
            cc = cycle["cc"]
            strike = cc["strike"]
            expiry = cc["expiry"]

            if days_to_expiry is None:
                try:
                    exp_date = datetime.date.fromisoformat(expiry)
                    days_to_expiry = (exp_date - datetime.date.today()).days
                except ValueError:
                    days_to_expiry = 30

            itm_pct = (current_price - strike) / strike if strike > 0 else 0

            if days_to_expiry <= 7 and itm_pct > 0.02:
                recommendation["action"] = "ROLL_UP_OUT"
                recommendation["reason"] = (
                    f"CC is ITM by {itm_pct*100:.1f}% with {days_to_expiry} DTE. "
                    f"Roll up and out to keep shares and collect more premium."
                )
            elif days_to_expiry <= 5 and itm_pct <= 0:
                recommendation["action"] = "LET_EXPIRE"
                recommendation["reason"] = (
                    f"CC is OTM. Let expire, then sell new CC."
                )

        recommendation["details"] = {
            "current_price": current_price,
            "days_to_expiry": days_to_expiry,
            "phase": phase,
        }

        return recommendation

    def execute_roll(self, cycle_id, new_strike, new_expiry, roll_credit,
                     reason="", current_price=None):
        """Record a roll (close old, open new at different strike/expiry)."""
        cycle = self._get_cycle(cycle_id)
        if not cycle:
            raise ValueError(f"Cycle {cycle_id} not found")

        phase = cycle.get("phase", "")
        roll_credit_total = roll_credit * cycle["contracts"] * 100

        roll_entry = {
            "timestamp": datetime.datetime.now().isoformat(),
            "phase": phase,
            "old_strike": cycle["csp"]["strike"] if phase == "csp" else cycle["cc"]["strike"],
            "old_expiry": cycle["csp"]["expiry"] if phase == "csp" else cycle["cc"]["expiry"],
            "new_strike": new_strike,
            "new_expiry": new_expiry,
            "roll_credit_per_share": roll_credit,
            "roll_credit_total": roll_credit_total,
            "reason": reason,
            "current_price": current_price,
        }

        cycle["rolls"].append(roll_entry)

        # Update the option
        if phase == "csp":
            cycle["csp"]["strike"] = new_strike
            cycle["csp"]["expiry"] = new_expiry
        elif phase == "cc":
            cycle["cc"]["strike"] = new_strike
            cycle["cc"]["expiry"] = new_expiry

        if roll_credit > 0:
            cycle["total_premium_collected"] += roll_credit_total
        else:
            cycle["total_premium_paid"] += abs(roll_credit_total)

        cycle["events"].append({
            "type": "ROLLED",
            "timestamp": datetime.datetime.now().isoformat(),
            "details": f"Rolled {phase.upper()} to ${new_strike} exp {new_expiry}. "
                       f"Credit: ${roll_credit:.2f}/sh. Reason: {reason}",
        })

        self._save_active_cycles()
        return cycle

    # ── Monitoring ──────────────────────────────────────────────────────

    def monitor_all(self, current_prices=None):
        """
        Monitor all active cycles and generate alerts.

        Args:
            current_prices: dict of {ticker: price}

        Returns:
            list of alert dicts
        """
        alerts = []

        for cycle_id, cycle in self._active_cycles.get("cycles", {}).items():
            ticker = cycle.get("ticker", "")
            price = (current_prices or {}).get(ticker)

            if not price:
                continue

            # Check for expiry approaching (2 days warning)
            phase = cycle.get("phase", "")
            expiry = None
            if phase == "csp" and cycle.get("csp"):
                expiry = cycle["csp"].get("expiry")
            elif phase == "cc" and cycle.get("cc"):
                expiry = cycle["cc"].get("expiry")

            if expiry:
                try:
                    exp_date = datetime.date.fromisoformat(expiry)
                    dte = (exp_date - datetime.date.today()).days

                    if dte <= 2 and dte >= 0:
                        alerts.append({
                            "type": "EXPIRY_WARNING",
                            "severity": "HIGH",
                            "cycle_id": cycle_id,
                            "ticker": ticker,
                            "message": f"{ticker} {phase.upper()} expires in {dte} days ({expiry})",
                        })

                    if dte < 0:
                        alerts.append({
                            "type": "EXPIRED",
                            "severity": "CRITICAL",
                            "cycle_id": cycle_id,
                            "ticker": ticker,
                            "message": f"{ticker} {phase.upper()} has expired ({expiry}). "
                                       f"Update status.",
                        })
                except ValueError:
                    pass

            # Check roll recommendations
            rec = self.check_roll(cycle_id, price)
            if rec["action"] not in ("HOLD", "NONE"):
                alerts.append({
                    "type": "ROLL_RECOMMENDATION",
                    "severity": "MEDIUM",
                    "cycle_id": cycle_id,
                    "ticker": ticker,
                    "message": rec["reason"],
                    "action": rec["action"],
                })

        return alerts

    # ── Sync from Alpaca ────────────────────────────────────────────────

    def sync_from_alpaca(self):
        """
        Sync lifecycle state from Alpaca real positions.
        Creates cycles for positions that aren't tracked.
        """
        try:
            from trading_agents.wheel_strategy.alpaca_sync import AlpacaSync
            sync = AlpacaSync()
            positions = sync.get_positions()
            orders = sync.pull_option_orders()

            new_cycles = 0
            updated = 0

            # Check for stock positions (assignments)
            for pos in positions:
                if len(pos.get("symbol", "")) > 10:
                    continue  # Option position
                qty = float(pos.get("qty", 0))
                if qty < 100:
                    continue

                ticker = pos.get("symbol", "")
                # Check if we already track this
                existing = [c for c in self._active_cycles.get("cycles", {}).values()
                            if c.get("ticker") == ticker
                            and c.get("status") in ("ASSIGNED_AWAITING_CC", "CC_OPEN")]

                if not existing:
                    # Create a new cycle from this assignment
                    cost_basis = float(pos.get("avg_entry_price", 0))
                    cycle_id = str(uuid.uuid4())[:8]
                    cycle = {
                        "id": cycle_id,
                        "ticker": ticker,
                        "status": "ASSIGNED_AWAITING_CC",
                        "phase": "stock_holding",
                        "created_at": datetime.datetime.now().isoformat(),
                        "contracts": int(qty / 100),
                        "csp": {"status": "ASSIGNED", "strike": cost_basis, "premium_per_share": 0},
                        "cc": None,
                        "rolls": [],
                        "stock_holding": {
                            "shares": int(qty),
                            "cost_basis": cost_basis,
                            "assigned_at": "synced_from_alpaca",
                        },
                        "total_premium_collected": 0,
                        "total_premium_paid": 0,
                        "realized_pnl": 0,
                        "events": [{
                            "type": "SYNCED_FROM_ALPACA",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "details": f"Imported {ticker} {int(qty)} shares @ ${cost_basis:.2f}",
                        }],
                    }
                    self._active_cycles["cycles"][cycle_id] = cycle
                    new_cycles += 1

            self._save_active_cycles()
            return {
                "new_cycles": new_cycles,
                "updated": updated,
                "active_cycles": len(self._active_cycles.get("cycles", {})),
            }

        except Exception as e:
            return {"error": str(e)}

    # ── Helpers ─────────────────────────────────────────────────────────

    def _get_cycle(self, cycle_id):
        """Get a cycle by ID."""
        return self._active_cycles.get("cycles", {}).get(cycle_id)

    def _complete_cycle(self, cycle_id):
        """Move a cycle from active to completed."""
        cycle = self._active_cycles["cycles"].pop(cycle_id, None)
        if cycle:
            self._append_completed_cycle(cycle)
            self._save_active_cycles()

    def active_cycles(self):
        """Return all active cycles."""
        return list(self._active_cycles.get("cycles", {}).values())

    def completed_cycles(self):
        """Return all completed cycles."""
        return self._load_completed_cycles()

    # ── Formatters ──────────────────────────────────────────────────────

    def format_active_status(self):
        """Format active cycles status for display."""
        cycles = self.active_cycles()
        if not cycles:
            return "No active wheel cycles."

        lines = [f"=== Active Wheel Cycles ({len(cycles)}) ===", ""]

        for cycle in cycles:
            ticker = cycle.get("ticker", "?")
            status = cycle.get("status", "?")
            phase = cycle.get("phase", "?")
            total_prem = cycle.get("total_premium_collected", 0)

            lines.append(f"[{cycle['id']}] {ticker} — {status}")

            if phase == "csp" and cycle.get("csp"):
                csp = cycle["csp"]
                lines.append(
                    f"  CSP: ${csp['strike']} Put, exp {csp.get('expiry', '?')}, "
                    f"premium ${csp.get('total_premium', 0):.2f}"
                )
            elif phase == "stock_holding":
                holding = cycle.get("stock_holding", {})
                lines.append(
                    f"  Holding: {holding.get('shares', 0)} shares, "
                    f"cost basis ${holding.get('cost_basis', 0):.2f}"
                )
            elif phase == "cc" and cycle.get("cc"):
                cc = cycle["cc"]
                lines.append(
                    f"  CC: ${cc['strike']} Call, exp {cc.get('expiry', '?')}, "
                    f"premium ${cc.get('total_premium', 0):.2f}"
                )

            lines.append(f"  Total premium: ${total_prem:.2f}")
            if cycle.get("rolls"):
                lines.append(f"  Rolls: {len(cycle['rolls'])}")
            lines.append("")

        return "\n".join(lines)

    def format_completed_summary(self):
        """Format completed cycles summary."""
        cycles = self.completed_cycles()
        if not cycles:
            return "No completed wheel cycles."

        total_pnl = sum(c.get("realized_pnl", 0) for c in cycles)
        wins = sum(1 for c in cycles if c.get("realized_pnl", 0) > 0)
        losses = len(cycles) - wins

        lines = [
            f"=== Completed Wheel Cycles ({len(cycles)}) ===",
            f"Total P&L: ${total_pnl:,.2f}",
            f"Win Rate: {wins/max(len(cycles),1)*100:.1f}% ({wins}W/{losses}L)",
            "",
        ]

        by_ticker = defaultdict(list)
        for c in cycles:
            by_ticker[c.get("ticker", "?")].append(c)

        for ticker, tc in sorted(by_ticker.items()):
            t_pnl = sum(c.get("realized_pnl", 0) for c in tc)
            lines.append(f"  {ticker}: {len(tc)} cycles, P&L ${t_pnl:,.2f}")

        return "\n".join(lines)

    def format_discord_status(self):
        """Format status for Discord notification."""
        active = self.active_cycles()
        completed = self.completed_cycles()

        total_pnl = sum(c.get("realized_pnl", 0) for c in completed)
        active_premium = sum(c.get("total_premium_collected", 0) for c in active)

        lines = [
            "**WHEEL CYCLE STATUS**",
            f"Active: **{len(active)}** | Completed: **{len(completed)}**",
            f"Realized P&L: **${total_pnl:,.2f}**",
            f"Active premium: **${active_premium:,.2f}**",
        ]

        if active:
            lines.append("")
            for c in active:
                ticker = c.get("ticker", "?")
                phase = c.get("phase", "?")
                lines.append(f"  {ticker}: {phase}")

        return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Wheel Lifecycle Manager")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("status", help="Show active cycle status")
    subparsers.add_parser("cycles", help="Show completed cycles")
    subparsers.add_parser("monitor", help="Monitor and alert")
    subparsers.add_parser("sync", help="Sync from Alpaca positions")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    lm = LifecycleManager()

    if args.command == "status":
        print(lm.format_active_status())
    elif args.command == "cycles":
        print(lm.format_completed_summary())
    elif args.command == "monitor":
        alerts = lm.monitor_all()
        if alerts:
            for a in alerts:
                print(f"[{a['severity']}] {a['type']}: {a['message']}")
        else:
            print("No alerts.")
    elif args.command == "sync":
        result = lm.sync_from_alpaca()
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
