"""
Wheel Strategy Risk Manager.

Portfolio-level risk management including:
- Portfolio Greeks tracking (net delta, theta, vega exposure)
- Maximum sector concentration enforcement
- Assignment loss alerts with suggested adjustments
- Roll/close/adjust recommendations
- Integration with position manager and scheduler

Usage:
    from trading_agents.wheel_strategy.risk_manager import RiskManager

    rm = RiskManager()
    alerts = rm.run_risk_check(current_prices)
    adjustments = rm.suggest_adjustments(current_prices)
    report = rm.format_risk_report(current_prices)
"""

import datetime
import json
import os
import math
from collections import defaultdict

from trading_agents.wheel_strategy.position_manager import PositionManager
from trading_agents.wheel_strategy.options_pricer import (
    greeks, black_scholes, find_strike_by_delta, estimate_hist_iv
)
from trading_agents.wheel_strategy.stock_screener import SP500_TOP100

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


# Sector lookup from SP500 list
SECTOR_LOOKUP = {s["ticker"]: s["sector"] for s in SP500_TOP100}


def _get_sector(ticker):
    """Get sector for a ticker."""
    return SECTOR_LOOKUP.get(ticker, "Unknown")


class RiskManager:
    """Portfolio-level risk management for wheel strategy."""

    def __init__(self, max_sector_positions=3, max_sector_capital_pct=0.35,
                 max_single_position_pct=0.20, max_portfolio_delta=500,
                 assignment_loss_alert_pct=10, theta_warning_threshold=-100):
        """
        Args:
            max_sector_positions: max positions in any one sector
            max_sector_capital_pct: max % of capital in one sector
            max_single_position_pct: max % of capital in one position
            max_portfolio_delta: absolute delta limit before alert
            assignment_loss_alert_pct: alert when position loss exceeds this %
            theta_warning_threshold: alert when daily theta exceeds this (negative = bad)
        """
        self.pm = PositionManager()
        self.max_sector_positions = max_sector_positions
        self.max_sector_capital_pct = max_sector_capital_pct
        self.max_single_position_pct = max_single_position_pct
        self.max_portfolio_delta = max_portfolio_delta
        self.assignment_loss_alert_pct = assignment_loss_alert_pct
        self.theta_warning_threshold = theta_warning_threshold

    # ── Core Risk Checks ──────────────────────────────────────────────────

    def run_risk_check(self, current_prices=None):
        """
        Run all risk checks and return a list of alerts.

        Args:
            current_prices: dict of {ticker: current_price}

        Returns:
            list of alert dicts with type, severity, message, and suggested_action
        """
        alerts = []
        current_prices = current_prices or {}

        # 1. Position-level checks from position manager
        pm_alerts = self.pm.check_risk_limits(current_prices)
        for a in pm_alerts:
            alerts.append({
                "type": a["type"],
                "severity": "HIGH" if a["type"] == "PORTFOLIO_STOP" else "MEDIUM",
                "ticker": a.get("ticker", "PORTFOLIO"),
                "message": a.get("message", str(a.get("reasons", ""))),
                "suggested_action": self._suggest_action_for_alert(a, current_prices),
            })

        # 2. Sector concentration
        sector_alerts = self._check_sector_concentration(current_prices)
        alerts.extend(sector_alerts)

        # 3. Greeks limits
        greeks_alerts = self._check_greeks_limits(current_prices)
        alerts.extend(greeks_alerts)

        # 4. Approaching assignment with loss
        assignment_alerts = self._check_assignment_risk(current_prices)
        alerts.extend(assignment_alerts)

        # 5. Expiration urgency
        expiry_alerts = self._check_expiry_urgency()
        alerts.extend(expiry_alerts)

        # 6. Single position concentration
        concentration_alerts = self._check_position_concentration()
        alerts.extend(concentration_alerts)

        return alerts

    def _check_sector_concentration(self, current_prices=None):
        """Check for over-concentration in any sector."""
        alerts = []
        active = [p for p in self.pm.positions if p.get("status") in ("active", "assigned", "needs_new_cc")]

        sector_counts = defaultdict(int)
        sector_capital = defaultdict(float)
        sector_tickers = defaultdict(list)
        total_capital = self.pm.capital

        for p in active:
            sector = p.get("sector") or _get_sector(p["ticker"])
            sector_counts[sector] += 1
            sector_capital[sector] += p.get("capital_committed", 0)
            sector_tickers[sector].append(p["ticker"])

        for sector, count in sector_counts.items():
            if count > self.max_sector_positions:
                alerts.append({
                    "type": "SECTOR_CONCENTRATION",
                    "severity": "MEDIUM",
                    "ticker": ", ".join(sector_tickers[sector]),
                    "message": (f"{sector} has {count} positions "
                                f"(max {self.max_sector_positions}). "
                                f"Tickers: {', '.join(sector_tickers[sector])}"),
                    "suggested_action": (f"Close or avoid adding to {sector}. "
                                         f"Consider reducing the weakest performer."),
                })

            pct = sector_capital[sector] / total_capital * 100 if total_capital > 0 else 0
            if pct > self.max_sector_capital_pct * 100:
                alerts.append({
                    "type": "SECTOR_CAPITAL",
                    "severity": "MEDIUM",
                    "ticker": ", ".join(sector_tickers[sector]),
                    "message": (f"{sector} uses {pct:.1f}% of capital "
                                f"(max {self.max_sector_capital_pct*100:.0f}%)"),
                    "suggested_action": f"Reduce {sector} exposure before adding new positions.",
                })

        return alerts

    def _check_greeks_limits(self, current_prices=None):
        """Check portfolio-level Greeks against limits."""
        alerts = []
        active = [p for p in self.pm.positions if p.get("status") in ("active", "assigned", "needs_new_cc")]

        if not active:
            return alerts

        today = datetime.date.today()
        net_delta = 0
        net_theta = 0
        net_vega = 0

        for p in active:
            expiry = p.get("expiry", "")
            if not expiry:
                continue
            try:
                exp_date = datetime.date.fromisoformat(expiry)
                dte = max((exp_date - today).days, 1)
                T = dte / 365.0
            except ValueError:
                continue

            S = current_prices.get(p["ticker"], p.get("entry_stock_price", p["strike"])) if current_prices else p.get("entry_stock_price", p["strike"])
            sigma = p.get("iv_at_entry", 25) / 100 if p.get("iv_at_entry") else 0.25
            option_type = "put" if p.get("phase") == "CSP" else "call"

            g = greeks(S, p["strike"], T, 0.05, sigma, option_type)

            # Short options: negate Greeks
            net_delta += g["delta"] * 100 * (-1)
            net_theta += g["theta"] * 100 * (-1)  # positive for short options
            net_vega += g["vega"] * 100 * (-1)

            # Stock delta for CC positions
            if p.get("phase") == "CC" and p.get("shares", 0) > 0:
                net_delta += p["shares"]

        # Delta check
        if abs(net_delta) > self.max_portfolio_delta:
            direction = "bullish" if net_delta > 0 else "bearish"
            alerts.append({
                "type": "DELTA_LIMIT",
                "severity": "HIGH",
                "ticker": "PORTFOLIO",
                "message": (f"Net delta {net_delta:+.0f} exceeds limit "
                            f"({self.max_portfolio_delta}). Portfolio is {direction}."),
                "suggested_action": self._suggest_delta_hedge(net_delta),
            })

        # Theta check (warning if negative = time decay against us)
        if net_theta < self.theta_warning_threshold:
            alerts.append({
                "type": "THETA_WARNING",
                "severity": "MEDIUM",
                "ticker": "PORTFOLIO",
                "message": (f"Daily theta ${net_theta:+.2f}. "
                            f"Time decay is working against the portfolio."),
                "suggested_action": "Review long option positions. Consider closing unprofitable long positions.",
            })

        return alerts

    def _check_assignment_risk(self, current_prices=None):
        """Check for positions approaching assignment with significant loss."""
        alerts = []
        if not current_prices:
            return alerts

        active = [p for p in self.pm.positions if p.get("status") == "active"]
        today = datetime.date.today()

        for p in active:
            ticker = p["ticker"]
            if ticker not in current_prices:
                continue

            price = current_prices[ticker]
            strike = p["strike"]
            expiry = p.get("expiry", "")

            try:
                exp_date = datetime.date.fromisoformat(expiry)
                dte = (exp_date - today).days
            except (ValueError, TypeError):
                continue

            if p.get("phase") == "CSP":
                # Put is ITM when price < strike
                if price < strike:
                    loss_pct = (strike - price) / strike * 100
                    premium_buffer = p.get("premium_collected", 0) / strike * 100
                    net_loss_pct = loss_pct - premium_buffer

                    if net_loss_pct > self.assignment_loss_alert_pct:
                        alerts.append({
                            "type": "ASSIGNMENT_LOSS",
                            "severity": "HIGH",
                            "ticker": ticker,
                            "message": (f"{ticker} CSP ${strike} is {loss_pct:.1f}% ITM "
                                        f"(price ${price:.2f}). Net loss after premium: "
                                        f"{net_loss_pct:.1f}%. {dte} DTE remaining."),
                            "suggested_action": self._suggest_csp_adjustment(
                                ticker, strike, price, dte, p.get("premium_collected", 0)
                            ),
                        })
                    elif price < strike and dte <= 5:
                        # Close to expiry and ITM
                        alerts.append({
                            "type": "ASSIGNMENT_WARNING",
                            "severity": "MEDIUM",
                            "ticker": ticker,
                            "message": (f"{ticker} CSP ${strike} is ITM "
                                        f"(price ${price:.2f}) with only {dte} DTE."),
                            "suggested_action": self._suggest_csp_adjustment(
                                ticker, strike, price, dte, p.get("premium_collected", 0)
                            ),
                        })

            elif p.get("phase") == "CC":
                # Call is ITM when price > strike
                if price > strike and p.get("cost_basis"):
                    loss_on_assignment = (p["cost_basis"] - strike) * 100 if p["cost_basis"] > strike else 0
                    if loss_on_assignment > 0 and dte <= 7:
                        alerts.append({
                            "type": "CC_ASSIGNMENT_LOSS",
                            "severity": "MEDIUM",
                            "ticker": ticker,
                            "message": (f"{ticker} CC ${strike} ITM, but cost basis "
                                        f"${p['cost_basis']:.2f} > strike. "
                                        f"Would lose ${loss_on_assignment:,.0f} if called."),
                            "suggested_action": self._suggest_cc_adjustment(
                                ticker, strike, price, dte, p["cost_basis"]
                            ),
                        })

        return alerts

    def _check_expiry_urgency(self):
        """Check for positions expiring very soon that need attention."""
        alerts = []
        active = [p for p in self.pm.positions if p.get("status") == "active"]
        today = datetime.date.today()

        for p in active:
            expiry = p.get("expiry", "")
            if not expiry:
                continue
            try:
                exp_date = datetime.date.fromisoformat(expiry)
                dte = (exp_date - today).days
            except ValueError:
                continue

            if dte <= 0:
                alerts.append({
                    "type": "EXPIRED",
                    "severity": "HIGH",
                    "ticker": p["ticker"],
                    "message": f"{p['ticker']} {p.get('phase', '?')} ${p['strike']} has EXPIRED. Process outcome.",
                    "suggested_action": "Check if assigned/expired OTM and update position manager.",
                })
            elif dte == 1:
                alerts.append({
                    "type": "EXPIRY_TOMORROW",
                    "severity": "MEDIUM",
                    "ticker": p["ticker"],
                    "message": f"{p['ticker']} {p.get('phase', '?')} ${p['strike']} expires TOMORROW.",
                    "suggested_action": "Decide: let expire, roll, or close early.",
                })

        return alerts

    def _check_position_concentration(self):
        """Check if any single position is too large."""
        alerts = []
        active = [p for p in self.pm.positions if p.get("status") in ("active", "assigned", "needs_new_cc")]
        total_capital = self.pm.capital

        if total_capital <= 0:
            return alerts

        for p in active:
            committed = p.get("capital_committed", 0)
            pct = committed / total_capital * 100
            if pct > self.max_single_position_pct * 100:
                alerts.append({
                    "type": "POSITION_SIZE",
                    "severity": "MEDIUM",
                    "ticker": p["ticker"],
                    "message": (f"{p['ticker']} uses {pct:.1f}% of capital "
                                f"(${committed:,.0f} / ${total_capital:,.0f}). "
                                f"Max recommended: {self.max_single_position_pct*100:.0f}%."),
                    "suggested_action": "Consider reducing position size or increasing account capital.",
                })

        return alerts

    # ── Adjustment Suggestions ────────────────────────────────────────────

    def _suggest_action_for_alert(self, alert, current_prices=None):
        """Generate suggested action for a position manager alert."""
        if alert["type"] == "ROLL_NEEDED":
            return (f"Roll {alert.get('ticker', '?')} to a later expiry. "
                    f"Target: same or lower strike, +1-2 weeks out for net credit.")
        elif alert["type"] == "POSITION_STOP":
            return (f"Consider closing {alert.get('ticker', '?')} to limit losses. "
                    f"Buy to close the option.")
        elif alert["type"] == "PORTFOLIO_STOP":
            return "Portfolio stop triggered. Consider closing weakest positions."
        return "Review position."

    def _suggest_delta_hedge(self, net_delta):
        """Suggest actions to reduce portfolio delta."""
        if net_delta > 0:
            return ("Portfolio is too bullish. Consider: "
                    "1) Sell additional puts (adds short delta), "
                    "2) Close CC positions (removes long stock delta), "
                    "3) Reduce position count.")
        else:
            return ("Portfolio is too bearish. Consider: "
                    "1) Close some CSP positions, "
                    "2) Accept assignment on ITM puts to add long stock delta, "
                    "3) Reduce number of short puts.")

    def _suggest_csp_adjustment(self, ticker, strike, price, dte, premium):
        """Suggest adjustments for an ITM CSP."""
        suggestions = []

        # Roll down and out
        new_strike = int(price * 0.95)  # 5% below current price
        suggestions.append(
            f"Roll down/out: Close ${strike} put, open ${new_strike} put "
            f"2-4 weeks later for net credit"
        )

        # Accept assignment
        cost_basis = strike - premium
        if cost_basis < price * 1.05:
            suggestions.append(
                f"Accept assignment: Cost basis ${cost_basis:.2f}, then sell CC above basis"
            )

        # Close early
        suggestions.append(
            f"Close early: Buy to close and take the loss (avoid larger loss at expiry)"
        )

        if dte > 14:
            suggestions.append(
                f"Wait: {dte} DTE remaining, stock may recover"
            )

        return " | ".join(suggestions)

    def _suggest_cc_adjustment(self, ticker, strike, price, dte, cost_basis):
        """Suggest adjustments for an ITM CC with potential loss."""
        suggestions = []

        if cost_basis > strike:
            # Would sell shares below cost basis
            new_strike = int(cost_basis * 1.02)  # slightly above cost basis
            suggestions.append(
                f"Roll up/out: Close ${strike} call, open ${new_strike} call "
                f"2-4 weeks later (may require debit)"
            )
            suggestions.append(
                f"Let it ride: If called at ${strike}, total loss "
                f"${(cost_basis - strike) * 100:,.0f} but premium offsets some"
            )
        else:
            suggestions.append(
                f"Let expire: Being called at ${strike} is profitable "
                f"(above cost basis ${cost_basis:.2f})"
            )

        return " | ".join(suggestions)

    def suggest_adjustments(self, current_prices):
        """
        Get all suggested adjustments for the current portfolio.

        Returns list of adjustment suggestions.
        """
        alerts = self.run_risk_check(current_prices)
        return [
            {
                "ticker": a["ticker"],
                "type": a["type"],
                "severity": a["severity"],
                "action": a["suggested_action"],
            }
            for a in alerts
            if a.get("suggested_action")
        ]

    # ── Pre-Trade Risk Check ──────────────────────────────────────────────

    def pre_trade_check(self, ticker, strike, phase="CSP", num_contracts=1):
        """
        Run risk checks before opening a new position.

        Returns (approved: bool, reasons: list)
        """
        reasons = []
        sector = _get_sector(ticker)
        capital_needed = strike * 100 * num_contracts

        # Use position manager's check
        can_open, pm_reasons = self.pm.can_open_position(ticker, sector, capital_needed)
        reasons.extend(pm_reasons)

        # Additional sector checks
        active = [p for p in self.pm.positions if p.get("status") in ("active", "assigned", "needs_new_cc")]
        sector_count = sum(1 for p in active if _get_sector(p["ticker"]) == sector)
        if sector_count >= self.max_sector_positions:
            reasons.append(f"Sector {sector} already has {sector_count} positions (max {self.max_sector_positions})")

        # Capital concentration
        total_capital = self.pm.capital
        if total_capital > 0 and capital_needed / total_capital > self.max_single_position_pct:
            reasons.append(
                f"Position requires {capital_needed/total_capital*100:.1f}% of capital "
                f"(max {self.max_single_position_pct*100:.0f}%)"
            )

        return len(reasons) == 0, reasons

    # ── Discord Formatting ────────────────────────────────────────────────

    def format_risk_report(self, current_prices=None):
        """Format a complete risk report for Discord."""
        alerts = self.run_risk_check(current_prices)

        if not alerts:
            return "**Risk Check** -- All clear. No alerts."

        # Sort by severity
        severity_order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
        alerts.sort(key=lambda a: severity_order.get(a["severity"], 3))

        lines = [
            f"**Risk Report -- {len(alerts)} Alert(s)**",
            "",
        ]

        for a in alerts:
            severity_icon = {"HIGH": "!!!", "MEDIUM": "! ", "LOW": "  "}.get(a["severity"], "  ")
            lines.append(f"**{severity_icon} [{a['type']}]** {a['ticker']}")
            lines.append(f"  {a['message']}")
            if a.get("suggested_action"):
                lines.append(f"  -> {a['suggested_action']}")
            lines.append("")

        return "\n".join(lines)

    def format_brief_risk(self, current_prices=None):
        """Format a brief risk status for daily updates."""
        alerts = self.run_risk_check(current_prices)

        high = sum(1 for a in alerts if a["severity"] == "HIGH")
        medium = sum(1 for a in alerts if a["severity"] == "MEDIUM")

        if not alerts:
            return "Risk: All clear"
        return f"Risk: {high} HIGH, {medium} MEDIUM alerts"


if __name__ == "__main__":
    rm = RiskManager()
    print(rm.format_risk_report())
