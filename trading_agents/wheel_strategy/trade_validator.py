"""
Wheel Strategy Pre-Trade Checklist System.

Before ANY trade executes, validates:
1. IV rank > 30? (don't sell cheap premium)
2. Earnings within next 2 weeks? (skip)
3. Already max positions in this sector?
4. Account buying power sufficient?
5. Is the stock in a clear downtrend? (skip puts, or reduce size)
6. Is this a duplicate of an existing position?

Logs validation results for every trade attempt (pass/fail + reasons).
Returns go/no-go decision.

Usage:
    from trading_agents.wheel_strategy.trade_validator import TradeValidator

    validator = TradeValidator()
    result = validator.validate("AAPL", strike=220, option_type="put",
                                premium=3.50, stock_price=230)
    if result["approved"]:
        # execute trade
    else:
        print(result["reasons"])

CLI:
    python -m trading_agents.wheel_strategy.trade_validator check AAPL --strike 220
    python -m trading_agents.wheel_strategy.trade_validator log
"""

import os
import sys
import json
import datetime
import argparse
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

DATA_DIR = os.path.join(SCRIPT_DIR, "data")
VALIDATION_LOG_FILE = os.path.join(DATA_DIR, "validation_log.jsonl")

# Earnings calendar (approximate — updated manually or via API)
# Format: ticker -> list of earnings date strings
EARNINGS_CALENDAR_FILE = os.path.join(DATA_DIR, "earnings_calendar.json")

# Sector mapping from stock screener
try:
    from trading_agents.wheel_strategy.stock_screener import SP500_TOP100
    SECTOR_LOOKUP = {s["ticker"]: s["sector"] for s in SP500_TOP100}
except ImportError:
    SECTOR_LOOKUP = {}


def _load_earnings_calendar():
    """Load earnings calendar from file or return empty."""
    if os.path.exists(EARNINGS_CALENDAR_FILE):
        try:
            with open(EARNINGS_CALENDAR_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


class TradeValidator:
    """Pre-trade validation checklist for wheel strategy."""

    def __init__(self, config=None):
        """
        Args:
            config: override defaults with custom thresholds
        """
        os.makedirs(DATA_DIR, exist_ok=True)

        defaults = {
            "min_iv_rank": 30,
            "earnings_blackout_days": 14,
            "max_sector_positions": 3,
            "max_total_positions": 10,
            "min_buying_power_pct": 0.10,  # Keep 10% cash reserve
            "max_single_position_pct": 0.20,  # Max 20% in one position
            "downtrend_sma_period": 50,
            "downtrend_threshold": -0.05,  # 5% below SMA50 = downtrend
            "allow_downtrend_puts": False,
            "downtrend_size_reduction": 0.50,  # If allowed, use 50% size
            "max_same_expiry": 3,  # Max positions on same expiry
        }

        if config:
            defaults.update(config)
        self.config = defaults

    # ── Main Validation ─────────────────────────────────────────────────

    def validate(self, ticker, strike=None, option_type="put", premium=0,
                 stock_price=None, iv_rank=None, iv=None, delta=None,
                 expiry=None, capital=None, buying_power=None):
        """
        Run all pre-trade checks.

        Returns:
            dict with:
                approved: bool
                reasons: list of failure reasons (empty if approved)
                warnings: list of non-blocking warnings
                checks: dict of individual check results
                suggested_size: float (0.0-1.0 position size multiplier)
        """
        result = {
            "timestamp": datetime.datetime.now().isoformat(),
            "ticker": ticker,
            "strike": strike,
            "option_type": option_type,
            "premium": premium,
            "stock_price": stock_price,
            "approved": True,
            "reasons": [],
            "warnings": [],
            "checks": {},
            "suggested_size": 1.0,
        }

        # 1. IV Rank Check
        self._check_iv_rank(result, iv_rank, iv)

        # 2. Earnings Check
        self._check_earnings(result, ticker, expiry)

        # 3. Sector Concentration Check
        self._check_sector_concentration(result, ticker)

        # 4. Buying Power Check
        self._check_buying_power(result, ticker, strike, capital, buying_power)

        # 5. Downtrend Check
        self._check_downtrend(result, ticker, stock_price, option_type)

        # 6. Duplicate Position Check
        self._check_duplicate(result, ticker, strike, expiry, option_type)

        # 7. Max Positions Check
        self._check_max_positions(result)

        # 8. Same Expiry Concentration
        self._check_expiry_concentration(result, expiry)

        # Final decision
        result["approved"] = len(result["reasons"]) == 0

        # Log result
        self._log_validation(result)

        return result

    # ── Individual Checks ───────────────────────────────────────────────

    def _check_iv_rank(self, result, iv_rank, iv):
        """Check if IV rank is high enough to sell premium."""
        if iv_rank is not None:
            if iv_rank < self.config["min_iv_rank"]:
                result["reasons"].append(
                    f"IV Rank too low: {iv_rank:.0f}% (min: {self.config['min_iv_rank']}%)"
                )
                result["checks"]["iv_rank"] = {"status": "FAIL", "value": iv_rank}
            else:
                result["checks"]["iv_rank"] = {"status": "PASS", "value": iv_rank}
        elif iv is not None:
            # Can't determine rank without history, but warn if IV seems low
            if iv < 20:
                result["warnings"].append(
                    f"IV appears low ({iv:.1f}%) — consider waiting for higher volatility"
                )
            result["checks"]["iv_rank"] = {"status": "SKIPPED", "reason": "no IV rank data"}
        else:
            result["warnings"].append("No IV data provided — cannot validate premium quality")
            result["checks"]["iv_rank"] = {"status": "SKIPPED", "reason": "no data"}

    def _check_earnings(self, result, ticker, expiry):
        """Check if earnings are within blackout period."""
        calendar = _load_earnings_calendar()
        earnings_dates = calendar.get(ticker, [])

        if not earnings_dates:
            # Try to fetch from yfinance
            try:
                earnings_dates = self._fetch_earnings_date(ticker)
            except Exception:
                result["warnings"].append(
                    f"Could not check earnings calendar for {ticker}"
                )
                result["checks"]["earnings"] = {"status": "SKIPPED", "reason": "no data"}
                return

        today = datetime.date.today()
        blackout = self.config["earnings_blackout_days"]

        for ed_str in earnings_dates:
            try:
                ed = datetime.date.fromisoformat(ed_str)
                days_until = (ed - today).days

                if 0 <= days_until <= blackout:
                    result["reasons"].append(
                        f"Earnings in {days_until} days ({ed_str}) — "
                        f"blackout period is {blackout} days"
                    )
                    result["checks"]["earnings"] = {
                        "status": "FAIL",
                        "earnings_date": ed_str,
                        "days_until": days_until,
                    }
                    return

                # Also check if expiry spans earnings
                if expiry:
                    try:
                        exp_date = datetime.date.fromisoformat(expiry)
                        if today < ed < exp_date:
                            result["reasons"].append(
                                f"Earnings on {ed_str} falls BETWEEN now and expiry {expiry}"
                            )
                            result["checks"]["earnings"] = {
                                "status": "FAIL",
                                "reason": "earnings_during_trade",
                            }
                            return
                    except ValueError:
                        pass
            except ValueError:
                continue

        result["checks"]["earnings"] = {"status": "PASS"}

    def _fetch_earnings_date(self, ticker):
        """Try to fetch next earnings date from yfinance."""
        try:
            import yfinance as yf
            stock = yf.Ticker(ticker)
            cal = stock.calendar
            if cal is not None and not cal.empty:
                if "Earnings Date" in cal.index:
                    dates = cal.loc["Earnings Date"]
                    return [str(d.date()) if hasattr(d, "date") else str(d) for d in dates]
        except Exception:
            pass
        return []

    def _check_sector_concentration(self, result, ticker):
        """Check if we already have max positions in this sector."""
        sector = SECTOR_LOOKUP.get(ticker, "Unknown")

        try:
            from trading_agents.wheel_strategy.position_manager import PositionManager
            pm = PositionManager()
            positions = pm.positions

            sector_count = sum(
                1 for p in positions
                if SECTOR_LOOKUP.get(p.get("ticker", ""), "Unknown") == sector
            )

            if sector_count >= self.config["max_sector_positions"]:
                result["reasons"].append(
                    f"Sector concentration: {sector_count} positions in {sector} "
                    f"(max: {self.config['max_sector_positions']})"
                )
                result["checks"]["sector"] = {
                    "status": "FAIL",
                    "sector": sector,
                    "count": sector_count,
                }
            else:
                result["checks"]["sector"] = {
                    "status": "PASS",
                    "sector": sector,
                    "count": sector_count,
                }
        except Exception:
            result["checks"]["sector"] = {"status": "SKIPPED", "reason": "position manager unavailable"}

    def _check_buying_power(self, result, ticker, strike, capital, buying_power):
        """Check if we have enough buying power."""
        if strike is None:
            result["checks"]["buying_power"] = {"status": "SKIPPED", "reason": "no strike"}
            return

        required = strike * 100  # Capital required for 1 contract CSP

        # Try Alpaca if not provided
        if buying_power is None or capital is None:
            try:
                from trading_agents.wheel_strategy.alpaca_sync import AlpacaSync
                sync = AlpacaSync()
                account = sync.get_account()
                buying_power = float(account.get("buying_power", 0))
                capital = float(account.get("equity", 0))
            except Exception:
                result["checks"]["buying_power"] = {"status": "SKIPPED", "reason": "no account data"}
                return

        # Check absolute buying power
        if buying_power < required:
            result["reasons"].append(
                f"Insufficient buying power: ${buying_power:,.0f} < ${required:,.0f} required"
            )
            result["checks"]["buying_power"] = {"status": "FAIL", "available": buying_power, "required": required}
            return

        # Check reserve
        min_reserve = capital * self.config["min_buying_power_pct"]
        if buying_power - required < min_reserve:
            result["warnings"].append(
                f"After this trade, buying power (${buying_power - required:,.0f}) "
                f"would be below {self.config['min_buying_power_pct']*100:.0f}% reserve"
            )

        # Check single position concentration
        position_pct = required / capital if capital > 0 else 1
        if position_pct > self.config["max_single_position_pct"]:
            result["reasons"].append(
                f"Position too large: {position_pct*100:.1f}% of equity "
                f"(max: {self.config['max_single_position_pct']*100:.0f}%)"
            )
            result["checks"]["buying_power"] = {"status": "FAIL", "reason": "concentration"}
            return

        result["checks"]["buying_power"] = {
            "status": "PASS",
            "available": buying_power,
            "required": required,
            "pct_of_equity": round(position_pct * 100, 1),
        }

    def _check_downtrend(self, result, ticker, stock_price, option_type):
        """Check if stock is in a clear downtrend (below SMA50)."""
        if option_type != "put":
            result["checks"]["trend"] = {"status": "PASS", "reason": "not a put"}
            return

        try:
            import yfinance as yf
            df = yf.download(ticker, period="3mo", progress=False, auto_adjust=True)
            if df.empty:
                result["checks"]["trend"] = {"status": "SKIPPED", "reason": "no price data"}
                return
            if hasattr(df.columns, "levels") and len(df.columns.levels) > 1:
                df.columns = df.columns.get_level_values(0)

            sma50 = float(df["Close"].rolling(self.config["downtrend_sma_period"]).mean().iloc[-1])
            current = float(df["Close"].iloc[-1])

            if stock_price:
                current = stock_price

            pct_from_sma = (current - sma50) / sma50

            if pct_from_sma < self.config["downtrend_threshold"]:
                if self.config["allow_downtrend_puts"]:
                    result["warnings"].append(
                        f"{ticker} is {pct_from_sma*100:.1f}% below SMA50 — "
                        f"reducing position size to {self.config['downtrend_size_reduction']*100:.0f}%"
                    )
                    result["suggested_size"] *= self.config["downtrend_size_reduction"]
                    result["checks"]["trend"] = {
                        "status": "WARNING",
                        "pct_from_sma50": round(pct_from_sma * 100, 1),
                    }
                else:
                    result["reasons"].append(
                        f"{ticker} in downtrend: {pct_from_sma*100:.1f}% below SMA50 — "
                        f"skipping put sale"
                    )
                    result["checks"]["trend"] = {
                        "status": "FAIL",
                        "pct_from_sma50": round(pct_from_sma * 100, 1),
                    }
            else:
                result["checks"]["trend"] = {
                    "status": "PASS",
                    "pct_from_sma50": round(pct_from_sma * 100, 1),
                }
        except ImportError:
            result["checks"]["trend"] = {"status": "SKIPPED", "reason": "yfinance not available"}
        except Exception as e:
            result["checks"]["trend"] = {"status": "SKIPPED", "reason": str(e)[:80]}

    def _check_duplicate(self, result, ticker, strike, expiry, option_type):
        """Check if we already have an identical position."""
        try:
            from trading_agents.wheel_strategy.position_manager import PositionManager
            pm = PositionManager()

            for pos in pm.positions:
                if (pos.get("ticker") == ticker
                        and pos.get("strike") == strike
                        and pos.get("expiry") == expiry
                        and pos.get("type", "").lower() == option_type.lower()):
                    result["reasons"].append(
                        f"Duplicate position: already have {ticker} ${strike} {option_type} exp {expiry}"
                    )
                    result["checks"]["duplicate"] = {"status": "FAIL", "existing_position": pos}
                    return

            # Also check same ticker, different strike
            same_ticker = [p for p in pm.positions if p.get("ticker") == ticker]
            if same_ticker:
                result["warnings"].append(
                    f"Already have {len(same_ticker)} position(s) in {ticker}"
                )

            result["checks"]["duplicate"] = {"status": "PASS"}
        except Exception:
            result["checks"]["duplicate"] = {"status": "SKIPPED", "reason": "position manager unavailable"}

    def _check_max_positions(self, result):
        """Check if we're at max total positions."""
        try:
            from trading_agents.wheel_strategy.position_manager import PositionManager
            pm = PositionManager()
            count = len(pm.positions)

            if count >= self.config["max_total_positions"]:
                result["reasons"].append(
                    f"Max positions reached: {count}/{self.config['max_total_positions']}"
                )
                result["checks"]["max_positions"] = {"status": "FAIL", "count": count}
            else:
                result["checks"]["max_positions"] = {"status": "PASS", "count": count}
        except Exception:
            result["checks"]["max_positions"] = {"status": "SKIPPED"}

    def _check_expiry_concentration(self, result, expiry):
        """Check if too many positions expire on the same date."""
        if not expiry:
            result["checks"]["expiry_concentration"] = {"status": "SKIPPED"}
            return

        try:
            from trading_agents.wheel_strategy.position_manager import PositionManager
            pm = PositionManager()
            same_expiry = sum(1 for p in pm.positions if p.get("expiry") == expiry)

            if same_expiry >= self.config["max_same_expiry"]:
                result["warnings"].append(
                    f"{same_expiry} positions already expire on {expiry} — "
                    f"consider a different expiry for diversification"
                )
                result["checks"]["expiry_concentration"] = {
                    "status": "WARNING",
                    "count": same_expiry,
                }
            else:
                result["checks"]["expiry_concentration"] = {"status": "PASS", "count": same_expiry}
        except Exception:
            result["checks"]["expiry_concentration"] = {"status": "SKIPPED"}

    # ── Logging ─────────────────────────────────────────────────────────

    def _log_validation(self, result):
        """Append validation result to log file."""
        log_entry = {
            "timestamp": result["timestamp"],
            "ticker": result["ticker"],
            "strike": result["strike"],
            "option_type": result["option_type"],
            "approved": result["approved"],
            "reasons": result["reasons"],
            "warnings": result["warnings"],
            "checks_summary": {
                k: v.get("status", "UNKNOWN") for k, v in result.get("checks", {}).items()
            },
        }

        with open(VALIDATION_LOG_FILE, "a") as f:
            f.write(json.dumps(log_entry) + "\n")

    def format_validation_result(self, result):
        """Format validation result for display."""
        status = "APPROVED" if result["approved"] else "REJECTED"
        lines = [
            f"=== Pre-Trade Validation: {result['ticker']} ${result.get('strike', 'N/A')} "
            f"{result['option_type']} ===",
            f"Status: **{status}**",
        ]

        if result["reasons"]:
            lines.append("\nFailed Checks:")
            for r in result["reasons"]:
                lines.append(f"  [X] {r}")

        if result["warnings"]:
            lines.append("\nWarnings:")
            for w in result["warnings"]:
                lines.append(f"  [!] {w}")

        lines.append("\nCheck Details:")
        for check, detail in result.get("checks", {}).items():
            status_icon = {"PASS": "[OK]", "FAIL": "[X]", "WARNING": "[!]", "SKIPPED": "[-]"}.get(
                detail.get("status", ""), "[?]"
            )
            lines.append(f"  {status_icon} {check}: {detail.get('status', 'UNKNOWN')}")

        if result.get("suggested_size", 1.0) < 1.0:
            lines.append(f"\nSuggested Size: {result['suggested_size']*100:.0f}% of normal")

        return "\n".join(lines)

    def format_validation_log(self, last_n=20):
        """Format recent validation log entries."""
        entries = []
        if os.path.exists(VALIDATION_LOG_FILE):
            with open(VALIDATION_LOG_FILE) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue

        if not entries:
            return "No validation history."

        recent = entries[-last_n:]
        lines = [f"=== Validation Log (last {len(recent)} entries) ===", ""]

        approved = sum(1 for e in recent if e.get("approved"))
        rejected = len(recent) - approved
        lines.append(f"Approved: {approved} | Rejected: {rejected}")
        lines.append("")

        for entry in recent:
            status = "OK" if entry.get("approved") else "REJECTED"
            ts = entry.get("timestamp", "")[:16]
            ticker = entry.get("ticker", "?")
            strike = entry.get("strike", "?")
            lines.append(f"  {ts} {status:>8} {ticker} ${strike} {entry.get('option_type', '?')}")
            if not entry.get("approved"):
                for r in entry.get("reasons", []):
                    lines.append(f"           -> {r[:60]}")

        return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Wheel Strategy Trade Validator")
    subparsers = parser.add_subparsers(dest="command")

    check = subparsers.add_parser("check", help="Validate a trade")
    check.add_argument("ticker", help="Stock ticker")
    check.add_argument("--strike", type=float, default=None, help="Option strike price")
    check.add_argument("--type", dest="option_type", default="put",
                       choices=["put", "call"], help="Option type")
    check.add_argument("--iv-rank", type=float, default=None, help="IV rank (0-100)")
    check.add_argument("--price", type=float, default=None, help="Current stock price")
    check.add_argument("--expiry", type=str, default=None, help="Expiration date (YYYY-MM-DD)")

    subparsers.add_parser("log", help="Show validation log")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    validator = TradeValidator()

    if args.command == "check":
        result = validator.validate(
            args.ticker.upper(),
            strike=args.strike,
            option_type=args.option_type,
            iv_rank=args.iv_rank,
            stock_price=args.price,
            expiry=args.expiry,
        )
        print(validator.format_validation_result(result))

    elif args.command == "log":
        print(validator.format_validation_log())


if __name__ == "__main__":
    main()
