"""
Discord alert formatting for wheel strategy.
Formats CSP/CC plays, assignments, and summaries for Discord channels.
"""

import datetime
import json


def format_csp_alert(ticker, strike, expiry, premium, stock_price,
                     annualized_return, safety_rating, iv_rank=None,
                     delta=None, sector=None):
    """
    Format a cash-secured put alert for Discord.

    Returns:
        dict with title, description, and fields for Discord embed.
    """
    breakeven = strike - premium
    otm_pct = (stock_price - strike) / stock_price * 100
    capital_req = strike * 100

    embed = {
        "title": f"🔔 CSP Alert: {ticker} ${strike} Put",
        "description": (
            f"**Sell to Open** {ticker} ${strike} Put — Exp {expiry}\n"
            f"Safety Rating: **{safety_rating}**"
        ),
        "color": _safety_color(safety_rating),
        "fields": [
            {"name": "Stock Price", "value": f"${stock_price:.2f}", "inline": True},
            {"name": "Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Expiry", "value": expiry, "inline": True},
            {"name": "Premium", "value": f"${premium:.2f}/sh (${premium * 100:.0f}/contract)", "inline": True},
            {"name": "Ann. Return", "value": f"{annualized_return:.1f}%", "inline": True},
            {"name": "OTM %", "value": f"{otm_pct:.1f}%", "inline": True},
            {"name": "Breakeven", "value": f"${breakeven:.2f}", "inline": True},
            {"name": "Capital Required", "value": f"${capital_req:,.0f}", "inline": True},
        ],
        "footer": f"Delta: {delta:.2f} | IV Rank: {iv_rank:.0f}%" if delta and iv_rank else None,
    }

    if sector:
        embed["fields"].append({"name": "Sector", "value": sector, "inline": True})

    return embed


def format_cc_alert(ticker, strike, expiry, premium, stock_price,
                    cost_basis, annualized_return, delta=None):
    """Format a covered call alert for Discord."""
    gain_if_called = (strike - cost_basis + premium) * 100
    gain_pct = (strike - cost_basis + premium) / cost_basis * 100

    embed = {
        "title": f"📞 CC Alert: {ticker} ${strike} Call",
        "description": (
            f"**Sell to Open** {ticker} ${strike} Call — Exp {expiry}\n"
            f"Cost Basis: **${cost_basis:.2f}**"
        ),
        "color": 0x3498DB,  # Blue
        "fields": [
            {"name": "Stock Price", "value": f"${stock_price:.2f}", "inline": True},
            {"name": "Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Expiry", "value": expiry, "inline": True},
            {"name": "Premium", "value": f"${premium:.2f}/sh (${premium * 100:.0f}/contract)", "inline": True},
            {"name": "Ann. Return", "value": f"{annualized_return:.1f}%", "inline": True},
            {"name": "Cost Basis", "value": f"${cost_basis:.2f}", "inline": True},
            {"name": "If Called Away", "value": f"+${gain_if_called:.0f} ({gain_pct:.1f}%)", "inline": True},
            {"name": "Above Basis?", "value": "Yes" if strike >= cost_basis else "No", "inline": True},
        ],
        "footer": f"Delta: {delta:.2f}" if delta else None,
    }

    return embed


def format_assignment_alert(ticker, strike, stock_price, cost_basis):
    """Format a put assignment notification."""
    unrealized = (stock_price - cost_basis) * 100

    return {
        "title": f"📋 Assignment: {ticker} Put @ ${strike}",
        "description": (
            f"**{ticker}** put was assigned. Now holding 100 shares.\n"
            f"Transitioning to **Covered Call** phase."
        ),
        "color": 0xE67E22,  # Orange
        "fields": [
            {"name": "Assigned Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Current Price", "value": f"${stock_price:.2f}", "inline": True},
            {"name": "Net Cost Basis", "value": f"${cost_basis:.2f}", "inline": True},
            {"name": "Unrealized P&L", "value": f"${unrealized:+,.0f}", "inline": True},
        ],
    }


def format_called_away_alert(ticker, strike, cost_basis, total_premium):
    """Format a call assignment (shares called away) notification."""
    gain = (strike - cost_basis) * 100 + total_premium

    return {
        "title": f"✅ Called Away: {ticker} @ ${strike}",
        "description": (
            f"**{ticker}** shares called away at ${strike}.\n"
            f"Wheel cycle complete! Returning to **CSP** phase."
        ),
        "color": 0x2ECC71,  # Green
        "fields": [
            {"name": "Call Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Cost Basis", "value": f"${cost_basis:.2f}", "inline": True},
            {"name": "Total Premium", "value": f"${total_premium:,.0f}", "inline": True},
            {"name": "Total Gain", "value": f"${gain:+,.0f}", "inline": True},
        ],
    }


def format_expiry_alert(ticker, phase, strike, premium_kept):
    """Format an OTM expiration notification."""
    emoji = "💰" if phase == "CSP" else "🔄"

    return {
        "title": f"{emoji} Expired OTM: {ticker} {phase} @ ${strike}",
        "description": (
            f"**{ticker}** {phase} expired worthless. Premium kept!\n"
            + (f"Ready to sell new CSP." if phase == "CSP" else f"Ready to sell new CC.")
        ),
        "color": 0x2ECC71,
        "fields": [
            {"name": "Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Premium Kept", "value": f"${premium_kept:,.0f}", "inline": True},
        ],
    }


def format_weekly_summary(positions, pnl, week_premium, week_trades):
    """Format a weekly P&L summary for Discord."""
    active_count = len([p for p in positions if p.get("status") == "active"])
    csp_count = len([p for p in positions if p.get("phase") == "CSP" and p.get("status") == "active"])
    cc_count = len([p for p in positions if p.get("phase") == "CC" and p.get("status") == "active"])

    embed = {
        "title": "📊 Wheel Strategy — Weekly Summary",
        "description": f"Week ending {datetime.date.today().isoformat()}",
        "color": 0x9B59B6,  # Purple
        "fields": [
            {"name": "Active Positions", "value": f"{active_count} ({csp_count} CSP, {cc_count} CC)", "inline": True},
            {"name": "Week Premium", "value": f"${week_premium:,.0f}", "inline": True},
            {"name": "Week Trades", "value": str(week_trades), "inline": True},
            {"name": "Total Capital", "value": f"${pnl.get('current_capital', 0):,.0f}", "inline": True},
            {"name": "Total Premium (All Time)", "value": f"${pnl.get('total_premium_collected', 0):,.0f}", "inline": True},
            {"name": "Total Return", "value": f"{pnl.get('total_return_pct', 0):+.1f}%", "inline": True},
        ],
    }

    return embed


def format_scan_results(candidates, top_n=5):
    """Format top scan results for Discord posting."""
    lines = ["**🔍 Wheel Strategy — Top Candidates**\n"]

    for i, c in enumerate(candidates[:top_n], 1):
        safety_emoji = {"A": "🟢", "B": "🟡", "C": "🟠", "D": "🔴"}.get(c["safety_rating"], "⚪")
        lines.append(
            f"**{i}. {c['ticker']}** {safety_emoji} {c['safety_rating']} — "
            f"${c['price']:.0f} | IV Rank: {c['iv_rank']:.0f}% | "
            f"Score: {c['composite_score']:.0f} | "
            f"Capital: ${c['capital_required']:,.0f}"
        )
        lines.append(f"   {c['sector']} | Stability: {c['stability_score']:.0f}/100")
        lines.append("")

    return "\n".join(lines)


def _safety_color(rating):
    """Map safety rating to Discord embed color."""
    return {
        "A": 0x2ECC71,  # Green
        "B": 0xF1C40F,  # Yellow
        "C": 0xE67E22,  # Orange
        "D": 0xE74C3C,  # Red
    }.get(rating, 0x95A5A6)


def embed_to_text(embed):
    """Convert embed dict to plain text (fallback if not using rich embeds)."""
    lines = [f"**{embed['title']}**"]
    if embed.get("description"):
        lines.append(embed["description"])
    lines.append("")
    for field in embed.get("fields", []):
        lines.append(f"  {field['name']}: {field['value']}")
    if embed.get("footer"):
        lines.append(f"\n_{embed['footer']}_")
    return "\n".join(lines)


def format_validation_failure_alert(ticker, strike, option_type, reasons, warnings=None):
    """Format a validation failure notification for Discord."""
    embed = {
        "title": f"Trade Skipped: {ticker} ${strike} {option_type.title()}",
        "description": f"Pre-trade validation **FAILED**. Trade NOT executed.",
        "color": 0xE74C3C,  # Red
        "fields": [],
    }

    for i, reason in enumerate(reasons[:5]):
        embed["fields"].append({
            "name": f"Failure {i+1}",
            "value": reason,
            "inline": False,
        })

    if warnings:
        for w in warnings[:3]:
            embed["fields"].append({
                "name": "Warning",
                "value": w,
                "inline": False,
            })

    return embed


def format_expiry_warning_alert(ticker, phase, strike, expiry, days_remaining):
    """Format a 2-day expiry warning notification."""
    return {
        "title": f"Expiry Warning: {ticker} {phase} ${strike}",
        "description": (
            f"**{ticker}** {phase} at ${strike} expires in **{days_remaining} day(s)** ({expiry}).\n"
            f"Review position for roll or let expire."
        ),
        "color": 0xF39C12,  # Amber
        "fields": [
            {"name": "Phase", "value": phase, "inline": True},
            {"name": "Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Expiry", "value": expiry, "inline": True},
            {"name": "Days Left", "value": str(days_remaining), "inline": True},
        ],
    }


def format_monthly_income_alert(month, data):
    """Format a monthly income report for Discord."""
    net = data.get("net_premium", 0)
    collected = data.get("premium_collected", 0)
    paid = data.get("premium_paid", 0)
    csps = data.get("csps", 0)
    ccs = data.get("ccs", 0)

    color = 0x2ECC71 if net > 0 else 0xE74C3C

    return {
        "title": f"Monthly Income Report: {month}",
        "description": f"Net premium: **${net:,.2f}**",
        "color": color,
        "fields": [
            {"name": "Premium Collected", "value": f"${collected:,.2f}", "inline": True},
            {"name": "Premium Paid", "value": f"${paid:,.2f}", "inline": True},
            {"name": "Net", "value": f"${net:,.2f}", "inline": True},
            {"name": "CSPs Sold", "value": str(csps), "inline": True},
            {"name": "CCs Sold", "value": str(ccs), "inline": True},
            {"name": "Total Trades", "value": str(data.get("trades", 0)), "inline": True},
        ],
    }


def format_position_opened_alert(ticker, option_type, strike, expiry, premium,
                                  stock_price, validation_summary=None):
    """Format a new position opened notification with validation results."""
    emoji = "CSP" if option_type == "put" else "CC"
    embed = {
        "title": f"New Position: {ticker} ${strike} {option_type.title()}",
        "description": (
            f"**Sell to Open** {ticker} ${strike} {option_type.title()} -- Exp {expiry}\n"
            f"Premium: **${premium:.2f}/sh** (${premium*100:.0f}/contract)"
        ),
        "color": 0x3498DB,
        "fields": [
            {"name": "Stock Price", "value": f"${stock_price:.2f}", "inline": True},
            {"name": "Strike", "value": f"${strike:.0f}", "inline": True},
            {"name": "Expiry", "value": expiry, "inline": True},
            {"name": "Type", "value": emoji, "inline": True},
        ],
    }

    if validation_summary:
        checks_text = " | ".join(
            f"{k}: {v}" for k, v in validation_summary.items()
        )
        embed["fields"].append({
            "name": "Validation",
            "value": checks_text[:200],
            "inline": False,
        })

    return embed


def format_roll_alert(ticker, phase, old_strike, new_strike, old_expiry, new_expiry, credit):
    """Format a roll notification for Discord."""
    return {
        "title": f"Rolled: {ticker} {phase}",
        "description": (
            f"Rolled {phase} from ${old_strike} ({old_expiry}) "
            f"to ${new_strike} ({new_expiry})"
        ),
        "color": 0x9B59B6,
        "fields": [
            {"name": "Old Strike", "value": f"${old_strike:.0f}", "inline": True},
            {"name": "New Strike", "value": f"${new_strike:.0f}", "inline": True},
            {"name": "Credit", "value": f"${credit:.2f}/sh", "inline": True},
            {"name": "Old Expiry", "value": old_expiry, "inline": True},
            {"name": "New Expiry", "value": new_expiry, "inline": True},
        ],
    }


async def send_alert(alert_embed, send_func):
    """
    Send an alert using the provided send function.

    Args:
        alert_embed: embed dict from one of the format_* functions
        send_func: async function that sends a message (e.g., send_to_discord)
    """
    text = embed_to_text(alert_embed)
    await send_func(text)


if __name__ == "__main__":
    # Example: format a CSP alert
    alert = format_csp_alert(
        ticker="AAPL", strike=220, expiry="2026-04-17",
        premium=3.50, stock_price=230, annualized_return=18.5,
        safety_rating="A", iv_rank=45, delta=-0.25, sector="Technology"
    )
    print(embed_to_text(alert))
    print("\n" + "=" * 50 + "\n")

    # Example: weekly summary
    summary = format_weekly_summary(
        positions=[{"status": "active", "phase": "CSP"}, {"status": "active", "phase": "CC"}],
        pnl={"current_capital": 102500, "total_premium_collected": 3200, "total_return_pct": 2.5},
        week_premium=850,
        week_trades=3,
    )
    print(embed_to_text(summary))
