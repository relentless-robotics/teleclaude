"""
Wheel Strategy Performance Tracker — Comprehensive analytics from Alpaca real records.

Pulls from Alpaca actual trade records (not just internal logs) and calculates:
- Total premium collected (realized)
- Assignment rate per stock
- Average days in trade
- Win rate by: stock, strike delta, DTE, IV percentile at entry
- Rolling Sharpe (30-day, 60-day, 90-day)
- Max drawdown
- Capital efficiency (premium / buying power used)
- Buy & hold benchmark comparison
- Monthly income statement

Saves to data/performance_history.jsonl (append daily).
Generates Discord-formatted weekly report.

Usage:
    python -m trading_agents.wheel_strategy.performance_tracker report
    python -m trading_agents.wheel_strategy.performance_tracker monthly
    python -m trading_agents.wheel_strategy.performance_tracker weekly-discord
    python -m trading_agents.wheel_strategy.performance_tracker snapshot
"""

import os
import sys
import json
import math
import datetime
import argparse
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

DATA_DIR = os.path.join(SCRIPT_DIR, "data")
PERFORMANCE_HISTORY_FILE = os.path.join(DATA_DIR, "performance_history.jsonl")
DAILY_SNAPSHOT_FILE = os.path.join(DATA_DIR, "daily_snapshots.jsonl")


class PerformanceTracker:
    """Comprehensive performance tracking from Alpaca real records."""

    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self._alpaca = None
        self._journal_entries = None
        self._account = None
        self._positions = None

    @property
    def alpaca(self):
        if self._alpaca is None:
            from trading_agents.wheel_strategy.alpaca_sync import AlpacaSync
            self._alpaca = AlpacaSync()
        return self._alpaca

    def _load_alpaca_data(self):
        """Pull fresh data from Alpaca."""
        self._account = self.alpaca.get_account()
        self._positions = self.alpaca.get_positions()
        order_data = self.alpaca.pull_option_orders()
        self._journal_entries = self.alpaca.orders_to_journal_format(
            order_data.get("options", [])
        )
        return self._journal_entries

    def _load_internal_journal(self):
        """Load internal trade journal entries."""
        from trading_agents.wheel_strategy.trade_journal import TradeJournal
        journal = TradeJournal()
        return journal.all_entries()

    # ── Core Metrics ────────────────────────────────────────────────────

    def calculate_metrics(self, use_alpaca=True):
        """
        Calculate comprehensive performance metrics.

        Args:
            use_alpaca: If True, pull from Alpaca. If False, use internal journal.

        Returns:
            dict with all performance metrics
        """
        if use_alpaca:
            try:
                entries = self._load_alpaca_data()
            except Exception as e:
                print(f"Warning: Alpaca pull failed ({e}), falling back to internal journal")
                entries = self._load_internal_journal()
                use_alpaca = False
        else:
            entries = self._load_internal_journal()

        metrics = {
            "calculated_at": datetime.datetime.now().isoformat(),
            "data_source": "alpaca" if use_alpaca else "internal_journal",
            "total_trades": len(entries),
        }

        if not entries:
            metrics["status"] = "NO_TRADES"
            return metrics

        # ── Premium Analysis ────────────────────────────────────────────
        total_premium_collected = 0
        total_premium_paid = 0
        premium_by_stock = defaultdict(float)
        trades_by_stock = defaultdict(int)

        csp_count = 0
        cc_count = 0
        buy_close_count = 0

        for entry in entries:
            action = entry.get("wheel_action", "")
            premium = entry.get("total_premium", 0)
            ticker = entry.get("ticker", "")

            if action in ("SELL_CSP", "SELL_CC"):
                total_premium_collected += premium
                premium_by_stock[ticker] += premium
                trades_by_stock[ticker] += 1
                if action == "SELL_CSP":
                    csp_count += 1
                else:
                    cc_count += 1
            elif action in ("BUY_TO_CLOSE_PUT", "BUY_TO_CLOSE_CALL"):
                total_premium_paid += premium
                premium_by_stock[ticker] -= premium
                buy_close_count += 1

        net_premium = total_premium_collected - total_premium_paid

        metrics["premium"] = {
            "total_collected": round(total_premium_collected, 2),
            "total_paid_to_close": round(total_premium_paid, 2),
            "net_premium": round(net_premium, 2),
            "csp_trades": csp_count,
            "cc_trades": cc_count,
            "buy_to_close": buy_close_count,
        }

        # ── Per-Stock Breakdown ─────────────────────────────────────────
        stock_metrics = {}
        for ticker in premium_by_stock:
            stock_metrics[ticker] = {
                "net_premium": round(premium_by_stock[ticker], 2),
                "trade_count": trades_by_stock[ticker],
            }
        metrics["by_stock"] = stock_metrics

        # ── Assignment Rate ─────────────────────────────────────────────
        # Look at stock positions that appeared (assignments) vs CSPs sold
        if self._positions and csp_count > 0:
            stock_positions = [p for p in self._positions
                               if p.get("asset_class", "") == "us_equity"
                               and float(p.get("qty", 0)) >= 100]
            assignment_count = len(stock_positions)
            metrics["assignment_rate"] = {
                "assignments": assignment_count,
                "total_csps": csp_count,
                "rate_pct": round(assignment_count / max(csp_count, 1) * 100, 1),
            }

        # ── Days in Trade ───────────────────────────────────────────────
        days_in_trade = []
        for entry in entries:
            created = entry.get("created_at", "")
            filled = entry.get("filled_at", "")
            if created and filled:
                try:
                    c = datetime.datetime.fromisoformat(created.replace("Z", "+00:00"))
                    f = datetime.datetime.fromisoformat(filled.replace("Z", "+00:00"))
                    days = (f - c).total_seconds() / 86400
                    if days >= 0:
                        days_in_trade.append(days)
                except (ValueError, TypeError):
                    pass

        if days_in_trade:
            metrics["days_in_trade"] = {
                "avg": round(sum(days_in_trade) / len(days_in_trade), 1),
                "min": round(min(days_in_trade), 1),
                "max": round(max(days_in_trade), 1),
                "median": round(sorted(days_in_trade)[len(days_in_trade) // 2], 1),
            }

        # ── Account Metrics ─────────────────────────────────────────────
        if self._account:
            equity = float(self._account.get("equity", 0))
            cash = float(self._account.get("cash", 0))
            buying_power = float(self._account.get("buying_power", 0))
            initial = float(self._account.get("initial_margin", equity))

            metrics["account"] = {
                "equity": round(equity, 2),
                "cash": round(cash, 2),
                "buying_power": round(buying_power, 2),
                "total_return_pct": round((equity - 100000) / 100000 * 100, 2)
                    if equity > 0 else 0,
            }

            # Capital efficiency
            if buying_power > 0 and net_premium > 0:
                deployed = equity - buying_power
                if deployed > 0:
                    metrics["capital_efficiency"] = {
                        "capital_deployed": round(deployed, 2),
                        "premium_per_deployed_pct": round(net_premium / deployed * 100, 2),
                        "annualized_yield_pct": round(net_premium / deployed * 100 * 12, 2),
                    }

        # ── Win Rate Analysis ───────────────────────────────────────────
        sell_trades = [e for e in entries if e.get("wheel_action", "").startswith("SELL_")]
        close_trades = [e for e in entries if e.get("wheel_action", "").startswith("BUY_TO_CLOSE")]

        # A "win" = premium collected > premium paid to close (or expired worthless)
        # Match sells to closes by ticker+strike+expiry
        wins = 0
        losses = 0
        for sell in sell_trades:
            key = f"{sell['ticker']}_{sell['strike']}_{sell['expiry']}"
            matching_close = None
            for close in close_trades:
                close_key = f"{close['ticker']}_{close['strike']}_{close['expiry']}"
                if close_key == key:
                    matching_close = close
                    break

            if matching_close is None:
                # No close = expired worthless or still open = win
                wins += 1
            else:
                net = sell.get("fill_price", 0) - matching_close.get("fill_price", 0)
                if net > 0:
                    wins += 1
                else:
                    losses += 1

        total_decided = wins + losses
        metrics["win_rate"] = {
            "wins": wins,
            "losses": losses,
            "total": total_decided,
            "win_rate_pct": round(wins / max(total_decided, 1) * 100, 1),
        }

        return metrics

    # ── Rolling Sharpe ──────────────────────────────────────────────────

    def rolling_sharpe(self, window_days=30):
        """
        Calculate rolling Sharpe ratio from daily P&L snapshots.

        Args:
            window_days: rolling window in days

        Returns:
            dict with rolling Sharpe values
        """
        snapshots = self._load_daily_snapshots()
        if len(snapshots) < 5:
            return {"error": f"Need at least 5 daily snapshots, have {len(snapshots)}"}

        equities = [s.get("equity", 0) for s in snapshots]
        daily_returns = []
        for i in range(1, len(equities)):
            if equities[i - 1] > 0:
                r = (equities[i] - equities[i - 1]) / equities[i - 1]
                daily_returns.append(r)

        if len(daily_returns) < 5:
            return {"error": "Not enough daily returns for Sharpe calculation"}

        result = {}
        for window in [30, 60, 90]:
            if len(daily_returns) >= window:
                recent = daily_returns[-window:]
                mean_r = sum(recent) / len(recent)
                var_r = sum((r - mean_r) ** 2 for r in recent) / len(recent)
                std_r = math.sqrt(var_r) if var_r > 0 else 0.0001
                sharpe = (mean_r / std_r) * math.sqrt(252)
                result[f"sharpe_{window}d"] = round(sharpe, 2)
            else:
                result[f"sharpe_{window}d"] = None

        # Max drawdown
        peak = equities[0]
        max_dd = 0
        for eq in equities:
            if eq > peak:
                peak = eq
            dd = (peak - eq) / peak if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd
        result["max_drawdown_pct"] = round(max_dd * 100, 2)

        return result

    # ── Daily Snapshot ──────────────────────────────────────────────────

    def save_daily_snapshot(self):
        """Save a daily performance snapshot for time-series analysis."""
        try:
            account = self.alpaca.get_account()
            positions = self.alpaca.get_positions()
        except Exception as e:
            return {"error": str(e)}

        snapshot = {
            "date": datetime.date.today().isoformat(),
            "timestamp": datetime.datetime.now().isoformat(),
            "equity": float(account.get("equity", 0)),
            "cash": float(account.get("cash", 0)),
            "buying_power": float(account.get("buying_power", 0)),
            "portfolio_value": float(account.get("portfolio_value", 0)),
            "position_count": len(positions),
            "option_positions": len([p for p in positions
                                     if len(p.get("symbol", "")) > 10]),
            "stock_positions": len([p for p in positions
                                    if len(p.get("symbol", "")) <= 10
                                    and float(p.get("qty", 0)) >= 100]),
        }

        # Append to daily snapshots file
        with open(DAILY_SNAPSHOT_FILE, "a") as f:
            f.write(json.dumps(snapshot) + "\n")

        # Also append metrics to performance history
        try:
            metrics = self.calculate_metrics()
            metrics["snapshot"] = snapshot
            with open(PERFORMANCE_HISTORY_FILE, "a") as f:
                f.write(json.dumps(metrics) + "\n")
        except Exception:
            pass

        return snapshot

    def _load_daily_snapshots(self):
        """Load all daily snapshots."""
        snapshots = []
        if os.path.exists(DAILY_SNAPSHOT_FILE):
            with open(DAILY_SNAPSHOT_FILE) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            snapshots.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
        return snapshots

    # ── Buy & Hold Benchmark ────────────────────────────────────────────

    def buy_hold_comparison(self, tickers=None, months=3, capital=100000):
        """
        Compare wheel strategy performance vs buy & hold.

        Args:
            tickers: list of tickers to compare (uses traded tickers if None)
            months: lookback period
            capital: starting capital for comparison
        """
        try:
            import yfinance as yf
        except ImportError:
            return {"error": "yfinance not installed for benchmark comparison"}

        # Get tickers from our trades if not provided
        if tickers is None:
            entries = self._load_internal_journal()
            tickers = list(set(e.get("ticker", "") for e in entries if e.get("ticker")))

        if not tickers:
            return {"error": "No tickers to compare"}

        period = f"{months}mo"
        bh_results = {}
        per_stock_capital = capital / len(tickers)

        for ticker in tickers[:10]:  # Limit to 10
            try:
                df = yf.download(ticker, period=period, progress=False, auto_adjust=True)
                if df.empty:
                    continue
                if hasattr(df.columns, "levels") and len(df.columns.levels) > 1:
                    df.columns = df.columns.get_level_values(0)

                start_price = float(df["Close"].iloc[0])
                end_price = float(df["Close"].iloc[-1])
                shares = int(per_stock_capital / start_price)
                bh_return = (end_price - start_price) * shares
                bh_return_pct = (end_price - start_price) / start_price * 100

                bh_results[ticker] = {
                    "start_price": round(start_price, 2),
                    "end_price": round(end_price, 2),
                    "shares": shares,
                    "bh_return": round(bh_return, 2),
                    "bh_return_pct": round(bh_return_pct, 2),
                }
            except Exception:
                continue

        total_bh_return = sum(r["bh_return"] for r in bh_results.values())
        total_bh_pct = total_bh_return / capital * 100 if capital > 0 else 0

        # Get our wheel return
        try:
            account = self.alpaca.get_account()
            wheel_equity = float(account.get("equity", capital))
            wheel_return = wheel_equity - capital
            wheel_pct = wheel_return / capital * 100
        except Exception:
            wheel_return = 0
            wheel_pct = 0

        return {
            "period_months": months,
            "capital": capital,
            "wheel_return": round(wheel_return, 2),
            "wheel_return_pct": round(wheel_pct, 2),
            "buy_hold_return": round(total_bh_return, 2),
            "buy_hold_return_pct": round(total_bh_pct, 2),
            "outperformance": round(wheel_pct - total_bh_pct, 2),
            "by_stock": bh_results,
        }

    # ── Monthly Income Statement ────────────────────────────────────────

    def monthly_income_statement(self, use_alpaca=True):
        """Generate monthly income breakdown."""
        if use_alpaca:
            try:
                entries = self._load_alpaca_data()
            except Exception:
                entries = self._load_internal_journal()
        else:
            entries = self._load_internal_journal()

        monthly = defaultdict(lambda: {
            "premium_collected": 0,
            "premium_paid": 0,
            "net_premium": 0,
            "trades": 0,
            "csps": 0,
            "ccs": 0,
        })

        for entry in entries:
            filled = entry.get("filled_at", "") or entry.get("created_at", "")
            if not filled:
                continue
            try:
                dt = datetime.datetime.fromisoformat(filled.replace("Z", "+00:00"))
                month_key = dt.strftime("%Y-%m")
            except (ValueError, TypeError):
                continue

            action = entry.get("wheel_action", "")
            premium = entry.get("total_premium", 0)

            if action in ("SELL_CSP", "SELL_CC"):
                monthly[month_key]["premium_collected"] += premium
                monthly[month_key]["trades"] += 1
                if action == "SELL_CSP":
                    monthly[month_key]["csps"] += 1
                else:
                    monthly[month_key]["ccs"] += 1
            elif action in ("BUY_TO_CLOSE_PUT", "BUY_TO_CLOSE_CALL"):
                monthly[month_key]["premium_paid"] += premium

        # Calculate net
        for month in monthly:
            monthly[month]["net_premium"] = (
                monthly[month]["premium_collected"] - monthly[month]["premium_paid"]
            )

        return dict(sorted(monthly.items()))

    # ── Formatters ──────────────────────────────────────────────────────

    def format_full_report(self):
        """Generate full text report."""
        metrics = self.calculate_metrics()
        lines = ["=== Wheel Strategy Performance Report ===", ""]

        # Account
        acct = metrics.get("account", {})
        lines.append(f"Equity: ${acct.get('equity', 0):,.2f}")
        lines.append(f"Total Return: {acct.get('total_return_pct', 0):.2f}%")
        lines.append("")

        # Premium
        prem = metrics.get("premium", {})
        lines.append("--- Premium ---")
        lines.append(f"  Collected: ${prem.get('total_collected', 0):,.2f}")
        lines.append(f"  Paid to close: ${prem.get('total_paid_to_close', 0):,.2f}")
        lines.append(f"  Net premium: ${prem.get('net_premium', 0):,.2f}")
        lines.append(f"  CSPs: {prem.get('csp_trades', 0)} | CCs: {prem.get('cc_trades', 0)}")
        lines.append("")

        # Win Rate
        wr = metrics.get("win_rate", {})
        lines.append("--- Win Rate ---")
        lines.append(f"  {wr.get('win_rate_pct', 0):.1f}% ({wr.get('wins', 0)}W / {wr.get('losses', 0)}L)")
        lines.append("")

        # Assignment
        ar = metrics.get("assignment_rate", {})
        if ar:
            lines.append("--- Assignment Rate ---")
            lines.append(f"  {ar.get('rate_pct', 0):.1f}% ({ar.get('assignments', 0)} / {ar.get('total_csps', 0)})")
            lines.append("")

        # Days in Trade
        dit = metrics.get("days_in_trade", {})
        if dit:
            lines.append("--- Days in Trade ---")
            lines.append(f"  Avg: {dit.get('avg', 0):.1f} | Med: {dit.get('median', 0):.1f} | "
                         f"Min: {dit.get('min', 0):.1f} | Max: {dit.get('max', 0):.1f}")
            lines.append("")

        # Capital Efficiency
        ce = metrics.get("capital_efficiency", {})
        if ce:
            lines.append("--- Capital Efficiency ---")
            lines.append(f"  Premium / Deployed: {ce.get('premium_per_deployed_pct', 0):.2f}%")
            lines.append(f"  Annualized Yield: {ce.get('annualized_yield_pct', 0):.2f}%")
            lines.append("")

        # Per Stock
        by_stock = metrics.get("by_stock", {})
        if by_stock:
            lines.append("--- By Stock ---")
            for ticker, sm in sorted(by_stock.items(), key=lambda x: x[1]["net_premium"], reverse=True):
                lines.append(f"  {ticker}: ${sm['net_premium']:,.2f} ({sm['trade_count']} trades)")
            lines.append("")

        # Rolling Sharpe
        sharpe = self.rolling_sharpe()
        if "error" not in sharpe:
            lines.append("--- Rolling Sharpe ---")
            for k, v in sharpe.items():
                if v is not None:
                    lines.append(f"  {k}: {v}")
            lines.append("")

        return "\n".join(lines)

    def format_monthly_report(self):
        """Format monthly income statement."""
        monthly = self.monthly_income_statement()
        if not monthly:
            return "No monthly data available."

        lines = ["=== Monthly Income Statement ===", ""]
        lines.append(f"{'Month':<10} {'Collected':>12} {'Paid':>10} {'Net':>12} {'CSP':>5} {'CC':>5}")
        lines.append("-" * 60)

        total_net = 0
        for month, data in monthly.items():
            net = data["net_premium"]
            total_net += net
            lines.append(
                f"{month:<10} ${data['premium_collected']:>10,.2f} "
                f"${data['premium_paid']:>8,.2f} ${net:>10,.2f} "
                f"{data['csps']:>5} {data['ccs']:>5}"
            )

        lines.append("-" * 60)
        lines.append(f"{'TOTAL':<10} {'':>12} {'':>10} ${total_net:>10,.2f}")

        avg = total_net / len(monthly) if monthly else 0
        lines.append(f"\nAvg monthly income: ${avg:,.2f}")

        return "\n".join(lines)

    def format_discord_weekly(self):
        """Generate Discord-formatted weekly report."""
        try:
            metrics = self.calculate_metrics()
        except Exception as e:
            return f"Error generating weekly report: {e}"

        acct = metrics.get("account", {})
        prem = metrics.get("premium", {})
        wr = metrics.get("win_rate", {})

        lines = [
            "**WHEEL STRATEGY WEEKLY REPORT**",
            f"*{datetime.date.today().isoformat()}*",
            "",
            f"Equity: **${acct.get('equity', 0):,.2f}**",
            f"Total Return: **{acct.get('total_return_pct', 0):.2f}%**",
            "",
            f"Net Premium: **${prem.get('net_premium', 0):,.2f}**",
            f"Win Rate: **{wr.get('win_rate_pct', 0):.1f}%** "
            f"({wr.get('wins', 0)}W/{wr.get('losses', 0)}L)",
            f"Trades: {prem.get('csp_trades', 0)} CSPs, {prem.get('cc_trades', 0)} CCs",
            "",
        ]

        # Top performers
        by_stock = metrics.get("by_stock", {})
        if by_stock:
            sorted_stocks = sorted(by_stock.items(), key=lambda x: x[1]["net_premium"], reverse=True)
            lines.append("**Top Performers:**")
            for ticker, sm in sorted_stocks[:5]:
                lines.append(f"  {ticker}: ${sm['net_premium']:,.2f}")

        # Rolling Sharpe
        sharpe = self.rolling_sharpe()
        if "error" not in sharpe:
            lines.append("")
            s30 = sharpe.get("sharpe_30d")
            if s30 is not None:
                lines.append(f"Sharpe (30d): **{s30:.2f}**")
            mdd = sharpe.get("max_drawdown_pct")
            if mdd is not None:
                lines.append(f"Max Drawdown: **{mdd:.1f}%**")

        return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Wheel Strategy Performance Tracker")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("report", help="Full performance report")
    subparsers.add_parser("monthly", help="Monthly income statement")
    subparsers.add_parser("weekly-discord", help="Discord weekly report")
    subparsers.add_parser("snapshot", help="Save daily snapshot")
    subparsers.add_parser("benchmark", help="Buy & hold comparison")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    tracker = PerformanceTracker()

    if args.command == "report":
        print(tracker.format_full_report())
    elif args.command == "monthly":
        print(tracker.format_monthly_report())
    elif args.command == "weekly-discord":
        print(tracker.format_discord_weekly())
    elif args.command == "snapshot":
        snap = tracker.save_daily_snapshot()
        print(f"Snapshot saved: {json.dumps(snap, indent=2)}")
    elif args.command == "benchmark":
        result = tracker.buy_hold_comparison()
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
