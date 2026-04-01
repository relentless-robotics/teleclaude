"""
Position manager for live wheel strategy tracking.
Manages active CSP/CC positions, sizing, roll logic, and risk limits.
"""

import json
import os
import datetime

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STATE_FILE = os.path.join(DATA_DIR, "positions.json")


def _load_state():
    """Load position state from disk."""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return _default_state()


def _save_state(state):
    """Save position state to disk."""
    os.makedirs(DATA_DIR, exist_ok=True)
    state["last_updated"] = datetime.datetime.now().isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def _default_state():
    return {
        "last_updated": None,
        "capital": 100_000,
        "initial_capital": 100_000,
        "positions": [],
        "history": [],
        "settings": {
            "max_position_pct": 0.05,       # Max 5% of capital per position
            "max_total_positions": 10,        # Max concurrent positions
            "max_sector_concentration": 3,    # Max positions per sector
            "max_loss_per_position_pct": 15,  # Stop loss per position (%)
            "portfolio_stop_loss_pct": 20,    # Portfolio-level stop (%)
            "roll_dte_threshold": 7,          # Roll when DTE <= this
            "roll_itm_threshold": 0.02,       # Roll when ITM by this %
            "csp_delta_target": 0.25,
            "cc_delta_target": 0.30,
            "target_dte": 35,
        },
    }


class PositionManager:
    """Manage wheel strategy positions with risk controls."""

    def __init__(self):
        self.state = _load_state()

    def save(self):
        _save_state(self.state)

    @property
    def settings(self):
        return self.state["settings"]

    @property
    def positions(self):
        return self.state["positions"]

    @property
    def capital(self):
        return self.state["capital"]

    def update_capital(self, new_capital):
        self.state["capital"] = new_capital
        self.save()

    # --- Position Sizing ---

    def max_position_size(self):
        """Maximum capital for a single position."""
        return self.capital * self.settings["max_position_pct"]

    def can_open_position(self, ticker, sector, capital_required):
        """Check if a new position meets all risk limits."""
        reasons = []

        # Max positions
        active = [p for p in self.positions if p["status"] == "active"]
        if len(active) >= self.settings["max_total_positions"]:
            reasons.append(f"Max positions reached ({self.settings['max_total_positions']})")

        # Duplicate ticker
        if any(p["ticker"] == ticker and p["status"] == "active" for p in self.positions):
            reasons.append(f"Already have active position in {ticker}")

        # Sector concentration
        sector_count = sum(1 for p in active if p.get("sector") == sector)
        if sector_count >= self.settings["max_sector_concentration"]:
            reasons.append(f"Max sector concentration for {sector}")

        # Capital check
        if capital_required > self.max_position_size():
            reasons.append(f"Capital required ${capital_required:,.0f} exceeds max "
                           f"${self.max_position_size():,.0f}")

        # Available cash
        committed = sum(p.get("capital_committed", 0) for p in active
                        if p.get("phase") == "CSP")
        available = self.capital - committed
        if capital_required > available:
            reasons.append(f"Insufficient cash: ${available:,.0f} available, "
                           f"${capital_required:,.0f} needed")

        # Portfolio stop loss
        total_value = self.portfolio_value()
        if total_value < self.state["initial_capital"] * (1 - self.settings["portfolio_stop_loss_pct"] / 100):
            reasons.append("Portfolio stop loss triggered")

        return len(reasons) == 0, reasons

    # --- Open Positions ---

    def open_csp(self, ticker, strike, expiry, premium, sector="Unknown",
                 iv=None, delta=None, stock_price=None):
        """Open a new cash-secured put position."""
        capital_needed = strike * 100
        can_open, reasons = self.can_open_position(ticker, sector, capital_needed)

        if not can_open:
            return {"success": False, "reasons": reasons}

        position = {
            "id": f"{ticker}_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}",
            "ticker": ticker,
            "sector": sector,
            "phase": "CSP",
            "status": "active",
            "strike": strike,
            "expiry": expiry,
            "premium_collected": premium,
            "total_premium": premium * 100,
            "entry_date": datetime.date.today().isoformat(),
            "entry_stock_price": stock_price,
            "capital_committed": capital_needed,
            "cost_basis": None,
            "shares": 0,
            "iv_at_entry": iv,
            "delta_at_entry": delta,
            "rolls": 0,
        }

        self.state["positions"].append(position)
        self.state["capital"] += premium * 100  # Credit premium
        self.save()

        return {"success": True, "position": position}

    def open_cc(self, ticker, strike, expiry, premium, cost_basis, shares=100,
                sector="Unknown", iv=None, delta=None, stock_price=None):
        """Open a covered call position (after assignment)."""
        position = {
            "id": f"{ticker}_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}",
            "ticker": ticker,
            "sector": sector,
            "phase": "CC",
            "status": "active",
            "strike": strike,
            "expiry": expiry,
            "premium_collected": premium,
            "total_premium": premium * 100,
            "entry_date": datetime.date.today().isoformat(),
            "entry_stock_price": stock_price,
            "capital_committed": 0,
            "cost_basis": cost_basis,
            "shares": shares,
            "iv_at_entry": iv,
            "delta_at_entry": delta,
            "rolls": 0,
        }

        self.state["positions"].append(position)
        self.state["capital"] += premium * 100
        self.save()

        return {"success": True, "position": position}

    # --- Process Events ---

    def process_assignment(self, position_id):
        """Handle put assignment: buy shares at strike, transition to CC phase."""
        pos = self._find_position(position_id)
        if not pos:
            return {"success": False, "reason": "Position not found"}

        if pos["phase"] != "CSP":
            return {"success": False, "reason": "Not a CSP position"}

        # Buy shares at strike
        cost = pos["strike"] * 100
        pos["phase"] = "CC"
        pos["shares"] = 100
        pos["cost_basis"] = pos["strike"] - pos["premium_collected"]
        pos["status"] = "assigned"  # Temporarily mark
        self.state["capital"] -= cost

        self.state["history"].append({
            "event": "ASSIGNMENT",
            "position_id": position_id,
            "ticker": pos["ticker"],
            "strike": pos["strike"],
            "cost_basis": pos["cost_basis"],
            "date": datetime.date.today().isoformat(),
        })

        self.save()
        return {"success": True, "position": pos}

    def process_called_away(self, position_id):
        """Handle call assignment: sell shares at strike, return to CSP phase."""
        pos = self._find_position(position_id)
        if not pos:
            return {"success": False, "reason": "Position not found"}

        if pos["phase"] != "CC":
            return {"success": False, "reason": "Not a CC position"}

        # Sell shares at strike
        proceeds = pos["strike"] * pos["shares"]
        gain = (pos["strike"] - pos["cost_basis"]) * pos["shares"]
        self.state["capital"] += proceeds
        pos["status"] = "closed"
        pos["close_date"] = datetime.date.today().isoformat()
        pos["realized_gain"] = gain

        self.state["history"].append({
            "event": "CALLED_AWAY",
            "position_id": position_id,
            "ticker": pos["ticker"],
            "strike": pos["strike"],
            "gain": round(gain, 2),
            "date": datetime.date.today().isoformat(),
        })

        self.save()
        return {"success": True, "gain": gain, "position": pos}

    def process_expiry_otm(self, position_id):
        """Handle option expiring out-of-the-money (best case)."""
        pos = self._find_position(position_id)
        if not pos:
            return {"success": False, "reason": "Position not found"}

        if pos["phase"] == "CSP":
            # CSP expired worthless - keep premium, free up capital
            pos["status"] = "closed"
            pos["close_date"] = datetime.date.today().isoformat()
            pos["realized_gain"] = pos["total_premium"]
        elif pos["phase"] == "CC":
            # CC expired worthless - keep premium and shares
            pos["cost_basis"] -= pos["premium_collected"]
            pos["status"] = "needs_new_cc"  # Ready for another CC

        self.state["history"].append({
            "event": "EXPIRED_OTM",
            "position_id": position_id,
            "ticker": pos["ticker"],
            "phase": pos["phase"],
            "premium_kept": pos["total_premium"],
            "date": datetime.date.today().isoformat(),
        })

        self.save()
        return {"success": True, "position": pos}

    # --- Roll Logic ---

    def check_roll_needed(self, position_id, current_price):
        """
        Check if a position should be rolled.
        Roll when:
        - DTE is low and position is ITM (avoid assignment if unwanted)
        - Can capture more premium by rolling out
        """
        pos = self._find_position(position_id)
        if not pos:
            return {"needs_roll": False, "reason": "Position not found"}

        expiry = datetime.date.fromisoformat(pos["expiry"])
        dte = (expiry - datetime.date.today()).days

        reasons = []

        # Low DTE check
        if dte <= self.settings["roll_dte_threshold"]:
            if pos["phase"] == "CSP" and current_price <= pos["strike"]:
                reasons.append(f"CSP ITM with {dte} DTE (strike ${pos['strike']}, "
                               f"price ${current_price:.2f})")
            elif pos["phase"] == "CC" and current_price >= pos["strike"]:
                reasons.append(f"CC ITM with {dte} DTE (strike ${pos['strike']}, "
                               f"price ${current_price:.2f})")

        # Deep ITM check
        if pos["phase"] == "CSP":
            itm_pct = (pos["strike"] - current_price) / pos["strike"]
            if itm_pct > self.settings["roll_itm_threshold"]:
                reasons.append(f"CSP deep ITM by {itm_pct:.1%}")
        elif pos["phase"] == "CC":
            itm_pct = (current_price - pos["strike"]) / pos["strike"]
            if itm_pct > self.settings["roll_itm_threshold"]:
                reasons.append(f"CC deep ITM by {itm_pct:.1%}")

        return {
            "needs_roll": len(reasons) > 0,
            "dte": dte,
            "reasons": reasons,
        }

    def roll_position(self, position_id, new_strike, new_expiry, new_premium,
                      roll_cost=0):
        """
        Roll a position to a new strike/expiry.
        Roll = close current + open new at different strike/date.
        """
        pos = self._find_position(position_id)
        if not pos:
            return {"success": False, "reason": "Position not found"}

        old_strike = pos["strike"]
        old_expiry = pos["expiry"]

        pos["strike"] = new_strike
        pos["expiry"] = new_expiry
        pos["premium_collected"] += new_premium
        pos["total_premium"] += (new_premium - roll_cost) * 100
        pos["rolls"] += 1

        self.state["capital"] += (new_premium - roll_cost) * 100

        self.state["history"].append({
            "event": "ROLL",
            "position_id": position_id,
            "ticker": pos["ticker"],
            "old_strike": old_strike,
            "new_strike": new_strike,
            "old_expiry": old_expiry,
            "new_expiry": new_expiry,
            "net_credit": round((new_premium - roll_cost) * 100, 2),
            "date": datetime.date.today().isoformat(),
        })

        self.save()
        return {"success": True, "position": pos}

    # --- Risk Management ---

    def check_risk_limits(self, current_prices):
        """
        Check all positions against risk limits.

        Args:
            current_prices: dict of {ticker: current_price}

        Returns:
            list of alerts for positions needing attention
        """
        alerts = []

        for pos in self.positions:
            if pos["status"] != "active":
                continue

            ticker = pos["ticker"]
            if ticker not in current_prices:
                continue

            price = current_prices[ticker]

            # Per-position loss check
            if pos["phase"] == "CC" and pos["cost_basis"]:
                unrealized_loss_pct = (price - pos["cost_basis"]) / pos["cost_basis"] * 100
                if unrealized_loss_pct < -self.settings["max_loss_per_position_pct"]:
                    alerts.append({
                        "type": "POSITION_STOP",
                        "ticker": ticker,
                        "position_id": pos["id"],
                        "loss_pct": round(unrealized_loss_pct, 1),
                        "message": f"{ticker} down {unrealized_loss_pct:.1f}% from cost basis "
                                   f"(${pos['cost_basis']:.2f} -> ${price:.2f})",
                    })

            # Roll check
            roll_check = self.check_roll_needed(pos["id"], price)
            if roll_check["needs_roll"]:
                alerts.append({
                    "type": "ROLL_NEEDED",
                    "ticker": ticker,
                    "position_id": pos["id"],
                    "dte": roll_check["dte"],
                    "reasons": roll_check["reasons"],
                })

        # Portfolio-level check
        total_value = self.portfolio_value(current_prices)
        portfolio_loss = (total_value - self.state["initial_capital"]) / self.state["initial_capital"] * 100
        if portfolio_loss < -self.settings["portfolio_stop_loss_pct"]:
            alerts.append({
                "type": "PORTFOLIO_STOP",
                "loss_pct": round(portfolio_loss, 1),
                "message": f"Portfolio down {portfolio_loss:.1f}% from initial capital",
            })

        return alerts

    # --- Portfolio Queries ---

    def portfolio_value(self, current_prices=None):
        """Calculate total portfolio value."""
        value = self.capital
        for pos in self.positions:
            if pos["status"] in ("active", "assigned", "needs_new_cc"):
                if pos["shares"] > 0 and current_prices and pos["ticker"] in current_prices:
                    value += pos["shares"] * current_prices[pos["ticker"]]
                elif pos["shares"] > 0 and pos.get("entry_stock_price"):
                    value += pos["shares"] * pos["entry_stock_price"]
        return value

    def active_positions_summary(self):
        """Get summary of all active positions."""
        active = [p for p in self.positions if p["status"] in ("active", "assigned", "needs_new_cc")]
        summary = []
        for p in active:
            summary.append({
                "ticker": p["ticker"],
                "phase": p["phase"],
                "strike": p["strike"],
                "expiry": p["expiry"],
                "premium": p["total_premium"],
                "cost_basis": p.get("cost_basis"),
                "shares": p["shares"],
                "rolls": p["rolls"],
                "status": p["status"],
            })
        return summary

    def pnl_summary(self):
        """Calculate realized and unrealized P&L."""
        realized = sum(
            h.get("gain", h.get("premium_kept", 0))
            for h in self.state["history"]
            if h["event"] in ("CALLED_AWAY", "EXPIRED_OTM")
        )
        total_premium = sum(
            p["total_premium"] for p in self.positions
        )
        return {
            "total_premium_collected": round(total_premium, 2),
            "realized_gains": round(realized, 2),
            "current_capital": round(self.capital, 2),
            "initial_capital": self.state["initial_capital"],
            "total_return_pct": round(
                (self.capital - self.state["initial_capital"]) / self.state["initial_capital"] * 100, 2
            ),
        }

    # --- Helpers ---

    def _find_position(self, position_id):
        for p in self.positions:
            if p["id"] == position_id:
                return p
        return None

    def format_status(self):
        """Format current positions as readable text."""
        active = self.active_positions_summary()
        pnl = self.pnl_summary()

        lines = [
            "=== Wheel Strategy Position Manager ===",
            f"Capital: ${self.capital:,.2f} | "
            f"Total Premium: ${pnl['total_premium_collected']:,.2f} | "
            f"Return: {pnl['total_return_pct']:+.1f}%",
            "",
        ]

        if not active:
            lines.append("No active positions.")
        else:
            lines.append(f"{'Ticker':<7} {'Phase':<5} {'Strike':>8} {'Expiry':>12} "
                         f"{'Premium':>10} {'Basis':>8} {'Rolls':>6}")
            lines.append("-" * 65)
            for p in active:
                basis_str = f"${p['cost_basis']:.0f}" if p['cost_basis'] else "N/A"
                lines.append(
                    f"{p['ticker']:<7} {p['phase']:<5} ${p['strike']:>7,.0f} "
                    f"{p['expiry']:>12} ${p['premium']:>9,.0f} {basis_str:>8} "
                    f"{p['rolls']:>6}"
                )

        return "\n".join(lines)


if __name__ == "__main__":
    pm = PositionManager()
    print(pm.format_status())
