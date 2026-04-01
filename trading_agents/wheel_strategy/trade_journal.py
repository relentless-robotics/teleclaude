"""
Wheel Strategy Trade Journal + Learning System.

Logs every wheel cycle with structured data for performance analysis.
Tracks premium collected, assignment rates, rolling decisions, and
per-stock profitability over time.

Data stored in data/wheel_journal.jsonl (one JSON object per line).

Usage:
    from trading_agents.wheel_strategy.trade_journal import TradeJournal

    journal = TradeJournal()

    # Log a new CSP sell
    journal.log_csp_open("AAPL", strike=220, premium=3.50, expiry="2026-04-17",
                         stock_price=230, delta=-0.25, iv=28.5, iv_rank=45)

    # Log expiry OTM (premium kept)
    journal.log_expiry_otm(entry_id, stock_price=235)

    # Log assignment
    journal.log_assignment(entry_id, stock_price=218)

    # Log CC sell after assignment
    journal.log_cc_open(entry_id, strike=225, premium=2.80, expiry="2026-05-01",
                        stock_price=220, delta=0.30)

    # Log called away
    journal.log_called_away(entry_id, stock_price=228)

    # Log a roll
    journal.log_roll(entry_id, new_strike=215, new_expiry="2026-04-24",
                     roll_credit=1.20, reason="approaching assignment, rolling down/out")

    # Get analytics
    summary = journal.stock_performance("AAPL")
    dashboard = journal.portfolio_summary()
    streaks = journal.win_loss_streaks()
"""

import json
import os
import datetime
import uuid
from collections import defaultdict

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
JOURNAL_FILE = os.path.join(DATA_DIR, "wheel_journal.jsonl")


class TradeJournal:
    """Structured trade journal for wheel strategy cycles."""

    def __init__(self, journal_path=None):
        self.journal_path = journal_path or JOURNAL_FILE
        os.makedirs(os.path.dirname(self.journal_path), exist_ok=True)
        self._entries = None  # lazy load

    # ── Internal I/O ──────────────────────────────────────────────────────

    def _load_entries(self):
        """Load all journal entries from JSONL file."""
        if self._entries is not None:
            return self._entries
        self._entries = []
        if os.path.exists(self.journal_path):
            with open(self.journal_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            self._entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
        return self._entries

    def _append_entry(self, entry):
        """Append a single entry to the journal file."""
        with open(self.journal_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
        if self._entries is not None:
            self._entries.append(entry)

    def _update_entry(self, entry_id, updates):
        """Update an existing entry in-place (rewrite file)."""
        entries = self._load_entries()
        found = False
        for e in entries:
            if e.get("id") == entry_id:
                e.update(updates)
                e["last_updated"] = datetime.datetime.now().isoformat()
                found = True
                break
        if found:
            self._rewrite_all(entries)
        return found

    def _rewrite_all(self, entries):
        """Rewrite the entire journal file."""
        with open(self.journal_path, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        self._entries = entries

    def _find_entry(self, entry_id):
        """Find an entry by ID."""
        for e in self._load_entries():
            if e.get("id") == entry_id:
                return e
        return None

    # ── Logging Methods ───────────────────────────────────────────────────

    def log_csp_open(self, ticker, strike, premium, expiry, stock_price,
                     delta=None, iv=None, iv_rank=None, sector=None,
                     num_contracts=1, notes=""):
        """Log opening a cash-secured put position. Returns entry ID."""
        entry_id = f"{ticker}_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        entry = {
            "id": entry_id,
            "ticker": ticker,
            "sector": sector or "",
            "cycle_type": "CSP",
            "status": "open",
            "open_date": datetime.datetime.now().isoformat(),
            "strike": strike,
            "premium_per_share": premium,
            "premium_total": round(premium * 100 * num_contracts, 2),
            "expiry": expiry,
            "stock_price_at_open": stock_price,
            "delta_at_open": delta,
            "iv_at_open": iv,
            "iv_rank_at_open": iv_rank,
            "num_contracts": num_contracts,
            "capital_committed": strike * 100 * num_contracts,
            # Lifecycle tracking
            "rolls": [],
            "total_premium_collected": round(premium * 100 * num_contracts, 2),
            "total_roll_credits": 0,
            "assignment_date": None,
            "assignment_price": None,
            "close_date": None,
            "close_price": None,
            "outcome": None,  # "expired_otm", "assigned", "rolled_and_expired", "early_closed"
            "realized_pnl": None,
            "annualized_return_pct": None,
            "days_held": None,
            # CC phase (populated if assigned)
            "cc_entries": [],
            "total_cc_premium": 0,
            "called_away_date": None,
            "called_away_price": None,
            # Notes
            "notes": notes,
            "last_updated": datetime.datetime.now().isoformat(),
        }
        self._append_entry(entry)
        return entry_id

    def log_expiry_otm(self, entry_id, stock_price=None):
        """Log CSP or CC expiring out of the money (best case)."""
        entry = self._find_entry(entry_id)
        if not entry:
            return False

        now = datetime.datetime.now()
        open_date = datetime.datetime.fromisoformat(entry["open_date"])
        days_held = (now - open_date).days or 1

        pnl = entry["total_premium_collected"]
        ann_return = (pnl / entry["capital_committed"]) * (365 / days_held) * 100 if entry["capital_committed"] > 0 else 0

        updates = {
            "status": "closed",
            "outcome": "expired_otm",
            "close_date": now.isoformat(),
            "close_price": stock_price,
            "realized_pnl": round(pnl, 2),
            "annualized_return_pct": round(ann_return, 2),
            "days_held": days_held,
        }
        return self._update_entry(entry_id, updates)

    def log_assignment(self, entry_id, stock_price=None):
        """Log put assignment -- shares acquired, transitioning to CC phase."""
        entry = self._find_entry(entry_id)
        if not entry:
            return False

        cost_basis = entry["strike"] - entry["premium_per_share"]
        updates = {
            "status": "assigned",
            "outcome": "assigned",
            "assignment_date": datetime.datetime.now().isoformat(),
            "assignment_price": stock_price,
            "cost_basis": round(cost_basis, 2),
        }
        return self._update_entry(entry_id, updates)

    def log_cc_open(self, entry_id, strike, premium, expiry,
                    stock_price=None, delta=None, iv=None, notes=""):
        """Log opening a covered call after assignment."""
        entry = self._find_entry(entry_id)
        if not entry:
            return False

        cc_entry = {
            "cc_id": f"CC_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}",
            "strike": strike,
            "premium_per_share": premium,
            "premium_total": round(premium * 100 * entry.get("num_contracts", 1), 2),
            "expiry": expiry,
            "open_date": datetime.datetime.now().isoformat(),
            "stock_price": stock_price,
            "delta": delta,
            "iv": iv,
            "outcome": None,  # "expired_otm", "called_away", "rolled", "early_closed"
            "notes": notes,
        }

        new_premium = premium * 100 * entry.get("num_contracts", 1)
        updates = {
            "status": "cc_open",
            "cycle_type": "CC",
            "total_premium_collected": round(entry["total_premium_collected"] + new_premium, 2),
            "total_cc_premium": round(entry.get("total_cc_premium", 0) + new_premium, 2),
        }

        # Append cc_entry to the list
        entries = self._load_entries()
        for e in entries:
            if e["id"] == entry_id:
                e.setdefault("cc_entries", []).append(cc_entry)
                e.update(updates)
                e["last_updated"] = datetime.datetime.now().isoformat()
                break
        self._rewrite_all(entries)
        return True

    def log_called_away(self, entry_id, stock_price=None):
        """Log shares being called away -- wheel cycle complete."""
        entry = self._find_entry(entry_id)
        if not entry:
            return False

        now = datetime.datetime.now()
        open_date = datetime.datetime.fromisoformat(entry["open_date"])
        days_held = (now - open_date).days or 1

        # Total P&L = all premiums + (call strike - put strike) * shares
        cost_basis = entry.get("cost_basis", entry["strike"])
        # Find the CC strike that resulted in being called away
        cc_entries = entry.get("cc_entries", [])
        cc_strike = cc_entries[-1]["strike"] if cc_entries else entry["strike"]

        share_gain = (cc_strike - entry["strike"]) * 100 * entry.get("num_contracts", 1)
        total_pnl = entry["total_premium_collected"] + share_gain
        ann_return = (total_pnl / entry["capital_committed"]) * (365 / days_held) * 100 if entry["capital_committed"] > 0 else 0

        # Mark last CC as called away
        if cc_entries:
            cc_entries[-1]["outcome"] = "called_away"

        updates = {
            "status": "closed",
            "outcome": "called_away",
            "called_away_date": now.isoformat(),
            "called_away_price": stock_price,
            "close_date": now.isoformat(),
            "close_price": stock_price,
            "realized_pnl": round(total_pnl, 2),
            "annualized_return_pct": round(ann_return, 2),
            "days_held": days_held,
            "share_gain": round(share_gain, 2),
        }

        entries = self._load_entries()
        for e in entries:
            if e["id"] == entry_id:
                e["cc_entries"] = cc_entries
                e.update(updates)
                e["last_updated"] = now.isoformat()
                break
        self._rewrite_all(entries)
        return True

    def log_roll(self, entry_id, new_strike, new_expiry, roll_credit,
                 reason="", old_strike=None, old_expiry=None):
        """Log a roll (close current option, open new one at different strike/expiry)."""
        entry = self._find_entry(entry_id)
        if not entry:
            return False

        roll_record = {
            "roll_date": datetime.datetime.now().isoformat(),
            "old_strike": old_strike or entry["strike"],
            "new_strike": new_strike,
            "old_expiry": old_expiry or entry.get("expiry"),
            "new_expiry": new_expiry,
            "roll_credit": roll_credit,
            "roll_credit_total": round(roll_credit * 100 * entry.get("num_contracts", 1), 2),
            "reason": reason,
        }

        credit_total = roll_credit * 100 * entry.get("num_contracts", 1)

        entries = self._load_entries()
        for e in entries:
            if e["id"] == entry_id:
                e.setdefault("rolls", []).append(roll_record)
                e["strike"] = new_strike
                e["expiry"] = new_expiry
                e["total_premium_collected"] = round(e["total_premium_collected"] + credit_total, 2)
                e["total_roll_credits"] = round(e.get("total_roll_credits", 0) + credit_total, 2)
                e["last_updated"] = datetime.datetime.now().isoformat()
                break
        self._rewrite_all(entries)
        return True

    def log_early_close(self, entry_id, close_cost, stock_price=None, reason=""):
        """Log closing a position early (buy to close)."""
        entry = self._find_entry(entry_id)
        if not entry:
            return False

        now = datetime.datetime.now()
        open_date = datetime.datetime.fromisoformat(entry["open_date"])
        days_held = (now - open_date).days or 1

        close_cost_total = close_cost * 100 * entry.get("num_contracts", 1)
        pnl = entry["total_premium_collected"] - close_cost_total
        ann_return = (pnl / entry["capital_committed"]) * (365 / days_held) * 100 if entry["capital_committed"] > 0 else 0

        updates = {
            "status": "closed",
            "outcome": "early_closed",
            "close_date": now.isoformat(),
            "close_price": stock_price,
            "close_cost": round(close_cost_total, 2),
            "realized_pnl": round(pnl, 2),
            "annualized_return_pct": round(ann_return, 2),
            "days_held": days_held,
            "notes": entry.get("notes", "") + f" | Early close: {reason}",
        }
        return self._update_entry(entry_id, updates)

    # ── Analytics ─────────────────────────────────────────────────────────

    def all_entries(self):
        """Return all journal entries."""
        return self._load_entries().copy()

    def open_entries(self):
        """Return entries with open positions."""
        return [e for e in self._load_entries() if e.get("status") not in ("closed",)]

    def closed_entries(self):
        """Return completed (closed) entries."""
        return [e for e in self._load_entries() if e.get("status") == "closed"]

    def stock_performance(self, ticker):
        """
        Get performance summary for a specific stock.

        Returns dict with:
            total_cycles, total_premium, avg_premium_per_cycle,
            assignment_rate, avg_days_held, annualized_return,
            win_rate, total_rolls, best_cycle, worst_cycle
        """
        entries = [e for e in self._load_entries() if e["ticker"] == ticker]
        closed = [e for e in entries if e.get("status") == "closed"]

        if not entries:
            return {"ticker": ticker, "total_cycles": 0, "message": "No trades found"}

        total_premium = sum(e.get("total_premium_collected", 0) for e in entries)
        total_capital = sum(e.get("capital_committed", 0) for e in entries)
        assignments = sum(1 for e in entries if e.get("assignment_date"))
        total_rolls = sum(len(e.get("rolls", [])) for e in entries)

        # Closed trade stats
        realized_pnls = [e.get("realized_pnl", 0) for e in closed if e.get("realized_pnl") is not None]
        wins = sum(1 for p in realized_pnls if p > 0)
        days_held = [e.get("days_held", 0) for e in closed if e.get("days_held")]
        ann_returns = [e.get("annualized_return_pct", 0) for e in closed if e.get("annualized_return_pct") is not None]

        return {
            "ticker": ticker,
            "total_cycles": len(entries),
            "closed_cycles": len(closed),
            "open_cycles": len(entries) - len(closed),
            "total_premium_collected": round(total_premium, 2),
            "total_capital_deployed": round(total_capital, 2),
            "assignment_rate": round(assignments / len(entries) * 100, 1) if entries else 0,
            "total_assignments": assignments,
            "total_rolls": total_rolls,
            "win_rate": round(wins / len(realized_pnls) * 100, 1) if realized_pnls else 0,
            "total_realized_pnl": round(sum(realized_pnls), 2),
            "avg_realized_pnl": round(sum(realized_pnls) / len(realized_pnls), 2) if realized_pnls else 0,
            "avg_days_held": round(sum(days_held) / len(days_held), 1) if days_held else 0,
            "avg_annualized_return": round(sum(ann_returns) / len(ann_returns), 2) if ann_returns else 0,
            "best_cycle_pnl": round(max(realized_pnls), 2) if realized_pnls else 0,
            "worst_cycle_pnl": round(min(realized_pnls), 2) if realized_pnls else 0,
        }

    def portfolio_summary(self):
        """
        Get portfolio-wide performance summary.

        Returns dict with aggregate stats across all stocks.
        """
        entries = self._load_entries()
        closed = [e for e in entries if e.get("status") == "closed"]

        # Per-stock breakdown
        tickers = sorted(set(e["ticker"] for e in entries))
        stock_stats = {t: self.stock_performance(t) for t in tickers}

        # Aggregates
        total_premium = sum(e.get("total_premium_collected", 0) for e in entries)
        total_realized = sum(e.get("realized_pnl", 0) for e in closed if e.get("realized_pnl") is not None)
        total_capital = sum(e.get("capital_committed", 0) for e in entries)
        total_assignments = sum(1 for e in entries if e.get("assignment_date"))

        realized_pnls = [e.get("realized_pnl", 0) for e in closed if e.get("realized_pnl") is not None]
        wins = sum(1 for p in realized_pnls if p > 0)

        # Time-based stats
        now = datetime.datetime.now()
        week_ago = now - datetime.timedelta(days=7)
        month_ago = now - datetime.timedelta(days=30)

        week_premium = sum(
            e.get("total_premium_collected", 0) for e in entries
            if e.get("open_date") and datetime.datetime.fromisoformat(e["open_date"]) >= week_ago
        )
        month_premium = sum(
            e.get("total_premium_collected", 0) for e in entries
            if e.get("open_date") and datetime.datetime.fromisoformat(e["open_date"]) >= month_ago
        )

        return {
            "total_trades": len(entries),
            "open_trades": len(entries) - len(closed),
            "closed_trades": len(closed),
            "unique_tickers": len(tickers),
            "total_premium_collected": round(total_premium, 2),
            "total_realized_pnl": round(total_realized, 2),
            "total_capital_deployed": round(total_capital, 2),
            "overall_win_rate": round(wins / len(realized_pnls) * 100, 1) if realized_pnls else 0,
            "total_assignments": total_assignments,
            "assignment_rate": round(total_assignments / len(entries) * 100, 1) if entries else 0,
            "week_premium": round(week_premium, 2),
            "month_premium": round(month_premium, 2),
            "per_stock": stock_stats,
        }

    def win_loss_streaks(self):
        """
        Compute win/loss streaks from closed trades.

        Returns dict with current_streak, max_win_streak, max_loss_streak.
        """
        closed = sorted(
            [e for e in self._load_entries() if e.get("status") == "closed" and e.get("realized_pnl") is not None],
            key=lambda e: e.get("close_date", "")
        )

        if not closed:
            return {"current_streak": 0, "current_streak_type": None,
                    "max_win_streak": 0, "max_loss_streak": 0}

        streaks = []
        current_type = None
        current_count = 0

        for e in closed:
            is_win = e["realized_pnl"] > 0
            streak_type = "win" if is_win else "loss"
            if streak_type == current_type:
                current_count += 1
            else:
                if current_type is not None:
                    streaks.append((current_type, current_count))
                current_type = streak_type
                current_count = 1
        if current_type is not None:
            streaks.append((current_type, current_count))

        max_win = max((c for t, c in streaks if t == "win"), default=0)
        max_loss = max((c for t, c in streaks if t == "loss"), default=0)

        return {
            "current_streak": current_count,
            "current_streak_type": current_type,
            "max_win_streak": max_win,
            "max_loss_streak": max_loss,
            "streak_history": streaks[-10:],  # last 10 streaks
        }

    def premium_by_period(self, period="weekly"):
        """
        Aggregate premium collected by time period.

        Args:
            period: "weekly" or "monthly"

        Returns:
            list of dicts with period label and premium amount.
        """
        entries = self._load_entries()
        buckets = defaultdict(float)

        for e in entries:
            if not e.get("open_date"):
                continue
            dt = datetime.datetime.fromisoformat(e["open_date"])
            if period == "weekly":
                # ISO week
                key = f"{dt.isocalendar()[0]}-W{dt.isocalendar()[1]:02d}"
            else:
                key = f"{dt.year}-{dt.month:02d}"
            buckets[key] += e.get("total_premium_collected", 0)

        return [{"period": k, "premium": round(v, 2)} for k, v in sorted(buckets.items())]

    def best_worst_stocks(self, top_n=5):
        """
        Rank stocks by total realized P&L.

        Returns (best_list, worst_list) each of length up to top_n.
        """
        entries = self._load_entries()
        tickers = set(e["ticker"] for e in entries)

        stock_pnl = {}
        for t in tickers:
            perf = self.stock_performance(t)
            stock_pnl[t] = {
                "ticker": t,
                "total_realized_pnl": perf["total_realized_pnl"],
                "total_premium": perf["total_premium_collected"],
                "win_rate": perf["win_rate"],
                "cycles": perf["total_cycles"],
                "avg_annualized": perf["avg_annualized_return"],
            }

        sorted_stocks = sorted(stock_pnl.values(), key=lambda x: x["total_realized_pnl"], reverse=True)
        best = sorted_stocks[:top_n]
        worst = sorted_stocks[-top_n:][::-1] if len(sorted_stocks) > top_n else sorted_stocks[::-1][:top_n]

        return best, worst

    # ── Discord Formatting ────────────────────────────────────────────────

    def format_journal_discord(self, ticker=None):
        """Format journal data for Discord display."""
        if ticker:
            perf = self.stock_performance(ticker)
            if perf["total_cycles"] == 0:
                return f"No wheel trades found for {ticker}."

            lines = [
                f"**Wheel Journal: {ticker}**",
                f"```",
                f"Cycles: {perf['total_cycles']} ({perf['closed_cycles']} closed, {perf['open_cycles']} open)",
                f"Win Rate: {perf['win_rate']:.1f}%",
                f"Total Premium: ${perf['total_premium_collected']:,.2f}",
                f"Realized P&L: ${perf['total_realized_pnl']:,.2f}",
                f"Assignment Rate: {perf['assignment_rate']:.1f}%",
                f"Avg Days Held: {perf['avg_days_held']:.0f}",
                f"Avg Ann. Return: {perf['avg_annualized_return']:.1f}%",
                f"Best Cycle: ${perf['best_cycle_pnl']:,.2f}",
                f"Worst Cycle: ${perf['worst_cycle_pnl']:,.2f}",
                f"Total Rolls: {perf['total_rolls']}",
                f"```",
            ]
            return "\n".join(lines)

        # Portfolio-wide summary
        summary = self.portfolio_summary()
        streaks = self.win_loss_streaks()

        lines = [
            f"**Wheel Strategy Trade Journal**",
            f"```",
            f"Total Trades: {summary['total_trades']} ({summary['open_trades']} open)",
            f"Unique Tickers: {summary['unique_tickers']}",
            f"Win Rate: {summary['overall_win_rate']:.1f}%",
            f"Total Premium: ${summary['total_premium_collected']:,.2f}",
            f"Realized P&L: ${summary['total_realized_pnl']:,.2f}",
            f"Assignment Rate: {summary['assignment_rate']:.1f}%",
            f"Week Premium: ${summary['week_premium']:,.2f}",
            f"Month Premium: ${summary['month_premium']:,.2f}",
            f"",
            f"Streak: {streaks['current_streak']} {streaks['current_streak_type'] or 'N/A'}",
            f"Max Win Streak: {streaks['max_win_streak']}",
            f"Max Loss Streak: {streaks['max_loss_streak']}",
            f"```",
        ]
        return "\n".join(lines)


if __name__ == "__main__":
    journal = TradeJournal()

    # Show current state
    entries = journal.all_entries()
    print(f"Journal has {len(entries)} entries.")

    if entries:
        print("\n" + journal.format_journal_discord())

        # Per-stock
        tickers = set(e["ticker"] for e in entries)
        for t in sorted(tickers):
            print(f"\n{journal.format_journal_discord(t)}")
    else:
        print("No trades logged yet. Use journal.log_csp_open() to start.")
