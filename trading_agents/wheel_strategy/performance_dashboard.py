"""
Wheel Strategy Performance Dashboard.

Generates formatted performance summaries for Discord including:
- Weekly/monthly premium collected
- Portfolio heat map (which stocks are working)
- Assignment rate per stock
- Best/worst performers
- Current positions with P&L
- Upcoming expirations
- Portfolio-level Greeks

Usage:
    from trading_agents.wheel_strategy.performance_dashboard import WheelDashboard

    dash = WheelDashboard()
    msg = dash.generate_discord_report()  # Full report
    msg = dash.weekly_summary()           # Weekly summary
    msg = dash.position_status()          # Current positions
    msg = dash.upcoming_expirations()     # Expiring soon
"""

import json
import os
import datetime
from collections import defaultdict

from trading_agents.wheel_strategy.trade_journal import TradeJournal
from trading_agents.wheel_strategy.position_manager import PositionManager
from trading_agents.wheel_strategy.options_pricer import greeks, black_scholes, estimate_hist_iv

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


class WheelDashboard:
    """Performance dashboard for wheel strategy."""

    def __init__(self):
        self.journal = TradeJournal()
        self.pm = PositionManager()

    # ── Weekly/Monthly Summary ────────────────────────────────────────────

    def weekly_summary(self):
        """Generate weekly premium and activity summary for Discord."""
        summary = self.journal.portfolio_summary()
        streaks = self.journal.win_loss_streaks()
        pnl = self.pm.pnl_summary()
        periods = self.journal.premium_by_period("weekly")

        lines = [
            f"**Wheel Strategy -- Weekly Report ({datetime.date.today().isoformat()})**",
            "",
            "**Premium Collected**",
            f"```",
            f"This Week:  ${summary['week_premium']:>10,.2f}",
            f"This Month: ${summary['month_premium']:>10,.2f}",
            f"All Time:   ${summary['total_premium_collected']:>10,.2f}",
            f"```",
            "",
            "**Portfolio Stats**",
            f"```",
            f"Capital:       ${pnl.get('current_capital', 0):>10,.2f}",
            f"Total Return:  {pnl.get('total_return_pct', 0):>+9.1f}%",
            f"Open Trades:   {summary['open_trades']:>10}",
            f"Win Rate:      {summary['overall_win_rate']:>9.1f}%",
            f"Assign Rate:   {summary['assignment_rate']:>9.1f}%",
            f"```",
        ]

        # Streak info
        if streaks["current_streak"] > 0:
            streak_emoji = "W" if streaks["current_streak_type"] == "win" else "L"
            lines.append(f"Streak: **{streaks['current_streak']}{streak_emoji}** "
                         f"(max win: {streaks['max_win_streak']}, max loss: {streaks['max_loss_streak']})")

        # Last few weekly periods
        if periods:
            lines.append("")
            lines.append("**Weekly Premium History**")
            lines.append("```")
            for p in periods[-6:]:
                bar_len = min(30, int(p["premium"] / 50)) if p["premium"] > 0 else 0
                bar = "#" * bar_len
                lines.append(f"  {p['period']}: ${p['premium']:>8,.2f}  {bar}")
            lines.append("```")

        return "\n".join(lines)

    def monthly_summary(self):
        """Generate monthly performance summary."""
        periods = self.journal.premium_by_period("monthly")
        summary = self.journal.portfolio_summary()

        lines = [
            f"**Wheel Strategy -- Monthly Report**",
            "",
            "**Monthly Premium History**",
            "```",
            f"{'Month':>8} {'Premium':>10} {'Cum Total':>12}",
            f"{'-'*34}",
        ]

        cumulative = 0
        for p in periods:
            cumulative += p["premium"]
            lines.append(f"{p['period']:>8} ${p['premium']:>9,.2f} ${cumulative:>11,.2f}")

        lines.append("```")
        lines.append(f"Total realized P&L: **${summary['total_realized_pnl']:,.2f}**")

        return "\n".join(lines)

    # ── Stock Heat Map ────────────────────────────────────────────────────

    def stock_heatmap(self):
        """
        Generate a heat map showing which stocks are performing well vs poorly.
        Uses realized P&L and win rate to color-code stocks.
        """
        summary = self.journal.portfolio_summary()
        per_stock = summary.get("per_stock", {})

        if not per_stock:
            return "**Stock Heat Map** -- No trades logged yet."

        # Sort by total realized P&L
        sorted_stocks = sorted(
            per_stock.items(),
            key=lambda x: x[1].get("total_realized_pnl", 0),
            reverse=True
        )

        lines = [
            "**Stock Heat Map -- Performance by Ticker**",
            "```",
            f"{'Ticker':>7} {'P&L':>9} {'WR%':>6} {'Cycles':>7} {'Prem':>9} {'Ann%':>7} {'Assign%':>8}",
            f"{'-'*58}",
        ]

        for ticker, stats in sorted_stocks:
            pnl = stats.get("total_realized_pnl", 0)
            # Heat indicator
            if pnl > 500:
                heat = "++"
            elif pnl > 0:
                heat = "+ "
            elif pnl > -200:
                heat = "- "
            else:
                heat = "--"

            lines.append(
                f"{heat} {ticker:>5} ${pnl:>8,.0f} {stats.get('win_rate', 0):>5.1f}% "
                f"{stats.get('total_cycles', 0):>6} ${stats.get('total_premium_collected', 0):>8,.0f} "
                f"{stats.get('avg_annualized_return', 0):>6.1f}% {stats.get('assignment_rate', 0):>7.1f}%"
            )

        lines.append("```")
        lines.append("_Legend: ++ = strong profit, + = profit, - = small loss, -- = significant loss_")

        return "\n".join(lines)

    # ── Current Positions ─────────────────────────────────────────────────

    def position_status(self, current_prices=None):
        """
        Show all current open positions with P&L.

        Args:
            current_prices: optional dict of {ticker: price} for live P&L
        """
        positions = self.pm.active_positions_summary()
        pnl = self.pm.pnl_summary()

        if not positions:
            return ("**Current Positions** -- No active positions.\n"
                    f"Capital: ${pnl.get('current_capital', 0):,.2f}")

        lines = [
            f"**Current Wheel Positions ({len(positions)} active)**",
            "```",
            f"{'Ticker':>7} {'Phase':>5} {'Strike':>8} {'Expiry':>12} {'Prem':>8} {'DTE':>5}",
            f"{'-'*50}",
        ]

        today = datetime.date.today()
        for p in positions:
            expiry = p.get("expiry", "")
            dte = "?"
            if expiry:
                try:
                    exp_date = datetime.date.fromisoformat(expiry)
                    dte = str((exp_date - today).days)
                except ValueError:
                    pass

            lines.append(
                f"{p['ticker']:>7} {p['phase']:>5} ${p['strike']:>7,.0f} "
                f"{expiry:>12} ${p.get('premium', 0):>7,.0f} {dte:>5}"
            )

        lines.append(f"{'-'*50}")
        lines.append(f"Capital: ${pnl.get('current_capital', 0):,.2f} | "
                     f"Return: {pnl.get('total_return_pct', 0):+.1f}%")
        lines.append("```")

        return "\n".join(lines)

    # ── Upcoming Expirations ──────────────────────────────────────────────

    def upcoming_expirations(self, days_ahead=14):
        """Show positions expiring within N days."""
        positions = self.pm.active_positions_summary()
        today = datetime.date.today()
        cutoff = today + datetime.timedelta(days=days_ahead)

        expiring = []
        for p in positions:
            expiry = p.get("expiry", "")
            if not expiry:
                continue
            try:
                exp_date = datetime.date.fromisoformat(expiry)
                dte = (exp_date - today).days
                if exp_date <= cutoff:
                    expiring.append({**p, "dte": dte, "exp_date": exp_date})
            except ValueError:
                continue

        if not expiring:
            return f"**Upcoming Expirations** -- No positions expiring in next {days_ahead} days."

        expiring.sort(key=lambda x: x["exp_date"])

        lines = [
            f"**Expiring Within {days_ahead} Days ({len(expiring)} positions)**",
            "```",
        ]

        for p in expiring:
            urgency = "!!!" if p["dte"] <= 3 else "! " if p["dte"] <= 7 else "  "
            lines.append(
                f"{urgency} {p['ticker']:>6} {p['phase']:>4} ${p['strike']:>7,.0f} "
                f"exp {p['expiry']} ({p['dte']}d)"
            )

        lines.append("```")

        if any(p["dte"] <= 3 for p in expiring):
            lines.append("_!!! = expiring within 3 days, action may be needed_")

        return "\n".join(lines)

    # ── Portfolio Greeks ──────────────────────────────────────────────────

    def portfolio_greeks(self, current_prices=None, risk_free_rate=0.05):
        """
        Calculate portfolio-level Greeks (net delta, theta, vega).

        Args:
            current_prices: dict of {ticker: current_price}
            risk_free_rate: annual risk-free rate

        Returns:
            dict with net_delta, net_theta, net_vega, net_gamma and per-position breakdown
        """
        positions = self.pm.active_positions_summary()
        today = datetime.date.today()

        total_delta = 0
        total_gamma = 0
        total_theta = 0
        total_vega = 0
        breakdown = []

        for p in positions:
            ticker = p["ticker"]
            strike = p["strike"]
            expiry = p.get("expiry", "")

            if not expiry:
                continue

            try:
                exp_date = datetime.date.fromisoformat(expiry)
                dte = (exp_date - today).days
                T = max(dte, 1) / 365.0
            except ValueError:
                continue

            # Get current price
            if current_prices and ticker in current_prices:
                S = current_prices[ticker]
            elif p.get("cost_basis"):
                S = p["cost_basis"]  # fallback
            else:
                S = strike  # rough fallback

            # Estimate IV (use a reasonable default)
            sigma = 0.25  # default

            option_type = "put" if p["phase"] == "CSP" else "call"
            num_contracts = 1  # default
            multiplier = -1 if option_type == "put" else -1  # short options = negative

            g = greeks(S, strike, T, risk_free_rate, sigma, option_type)

            # For short options, delta/gamma/vega are inverted
            pos_delta = g["delta"] * 100 * num_contracts * (-1)  # short
            pos_gamma = g["gamma"] * 100 * num_contracts * (-1)
            pos_theta = g["theta"] * 100 * num_contracts * (-1)  # positive theta for shorts
            pos_vega = g["vega"] * 100 * num_contracts * (-1)

            # If CC phase, also count the 100 shares of stock (delta = +100)
            if p["phase"] == "CC" and p.get("shares", 0) > 0:
                pos_delta += p["shares"]  # long shares = positive delta

            total_delta += pos_delta
            total_gamma += pos_gamma
            total_theta += pos_theta
            total_vega += pos_vega

            breakdown.append({
                "ticker": ticker,
                "phase": p["phase"],
                "delta": round(pos_delta, 2),
                "gamma": round(pos_gamma, 4),
                "theta": round(pos_theta, 2),
                "vega": round(pos_vega, 2),
                "dte": dte,
            })

        return {
            "net_delta": round(total_delta, 2),
            "net_gamma": round(total_gamma, 4),
            "net_theta": round(total_theta, 2),
            "net_vega": round(total_vega, 2),
            "positions": breakdown,
        }

    def format_greeks_discord(self, current_prices=None):
        """Format portfolio Greeks for Discord."""
        g = self.portfolio_greeks(current_prices)

        lines = [
            "**Portfolio Greeks**",
            "```",
            f"Net Delta:  {g['net_delta']:>+8.2f}  (positive = bullish)",
            f"Net Gamma:  {g['net_gamma']:>+8.4f}",
            f"Net Theta:  {g['net_theta']:>+8.2f}/day  (positive = time decay in your favor)",
            f"Net Vega:   {g['net_vega']:>+8.2f}  (negative = short vol)",
            "",
        ]

        if g["positions"]:
            lines.append(f"{'Ticker':>7} {'Phase':>5} {'Delta':>8} {'Theta':>8} {'Vega':>8} {'DTE':>5}")
            lines.append(f"{'-'*45}")
            for p in g["positions"]:
                lines.append(
                    f"{p['ticker']:>7} {p['phase']:>5} {p['delta']:>+8.2f} "
                    f"{p['theta']:>+8.2f} {p['vega']:>+8.2f} {p['dte']:>5}"
                )

        lines.append("```")

        # Risk alerts
        if abs(g["net_delta"]) > 300:
            lines.append(f"**Warning:** High directional exposure (delta {g['net_delta']:+.0f})")
        if g["net_theta"] < -50:
            lines.append(f"**Warning:** Negative theta -- time decay working against you")

        return "\n".join(lines)

    # ── Sector Concentration ──────────────────────────────────────────────

    def sector_concentration(self):
        """Show portfolio concentration by sector."""
        positions = self.pm.active_positions_summary()
        journal_entries = self.journal.open_entries()

        sector_map = defaultdict(lambda: {"count": 0, "capital": 0, "tickers": []})

        # From position manager
        for p in positions:
            # Try to find sector from journal
            sector = "Unknown"
            for e in journal_entries:
                if e["ticker"] == p["ticker"]:
                    sector = e.get("sector", "Unknown")
                    break
            sector_map[sector]["count"] += 1
            sector_map[sector]["capital"] += p.get("strike", 0) * 100
            if p["ticker"] not in sector_map[sector]["tickers"]:
                sector_map[sector]["tickers"].append(p["ticker"])

        if not sector_map:
            return "**Sector Concentration** -- No active positions."

        lines = [
            "**Sector Concentration**",
            "```",
            f"{'Sector':<25} {'Count':>6} {'Capital':>12} {'Tickers'}",
            f"{'-'*65}",
        ]

        total_capital = sum(s["capital"] for s in sector_map.values()) or 1
        for sector, data in sorted(sector_map.items(), key=lambda x: x[1]["capital"], reverse=True):
            pct = data["capital"] / total_capital * 100
            bar = "#" * min(20, int(pct / 5))
            lines.append(
                f"{sector:<25} {data['count']:>6} ${data['capital']:>11,.0f} "
                f"{', '.join(data['tickers'])}"
            )
            lines.append(f"{'':25} {pct:>5.1f}% {bar}")

        lines.append("```")

        # Alert if over-concentrated
        for sector, data in sector_map.items():
            if data["count"] >= 3:
                lines.append(f"**Warning:** {sector} has {data['count']} positions -- consider diversifying")

        return "\n".join(lines)

    # ── Full Report ───────────────────────────────────────────────────────

    def generate_discord_report(self, current_prices=None):
        """Generate complete performance report for Discord."""
        sections = [
            self.weekly_summary(),
            "",
            self.position_status(current_prices),
            "",
            self.upcoming_expirations(),
            "",
            self.stock_heatmap(),
            "",
            self.format_greeks_discord(current_prices),
            "",
            self.sector_concentration(),
        ]
        return "\n".join(sections)

    def generate_brief_report(self):
        """Generate a brief daily status update."""
        summary = self.journal.portfolio_summary()
        pnl = self.pm.pnl_summary()
        positions = self.pm.active_positions_summary()

        today = datetime.date.today()
        expiring_soon = 0
        for p in positions:
            try:
                exp_date = datetime.date.fromisoformat(p.get("expiry", ""))
                if (exp_date - today).days <= 3:
                    expiring_soon += 1
            except ValueError:
                pass

        lines = [
            f"**Wheel Status** | {today.isoformat()}",
            f"Positions: {len(positions)} | "
            f"Capital: ${pnl.get('current_capital', 0):,.0f} | "
            f"Return: {pnl.get('total_return_pct', 0):+.1f}% | "
            f"Week Prem: ${summary['week_premium']:,.0f}",
        ]

        if expiring_soon > 0:
            lines.append(f"**{expiring_soon} position(s) expiring within 3 days!**")

        return "\n".join(lines)


if __name__ == "__main__":
    dash = WheelDashboard()
    print(dash.generate_discord_report())
