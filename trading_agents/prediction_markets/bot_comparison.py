#!/usr/bin/env python3
"""
Bot Performance Comparison Dashboard.

Reads trade logs from all bots and generates comparison reports.
Outputs Discord-formatted markdown for easy sharing.

Usage:
    python -m trading_agents.prediction_markets.bot_comparison
    python -m trading_agents.prediction_markets.bot_comparison --discord
    python -m trading_agents.prediction_markets.bot_comparison --detailed
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"

if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))


# ---------------------------------------------------------------------------
# Trade Log Reader
# ---------------------------------------------------------------------------

def read_trade_log(filepath: Path) -> list:
    """Read a JSONL trade log file."""
    if not filepath.exists():
        return []
    trades = []
    with open(filepath) as f:
        for line in f:
            try:
                trades.append(json.loads(line.strip()))
            except Exception:
                continue
    return trades


def read_state_file(filepath: Path) -> Optional[dict]:
    """Read a bot state JSON file."""
    if not filepath.exists():
        return None
    try:
        with open(filepath) as f:
            return json.load(f)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Bot Configurations
# ---------------------------------------------------------------------------

BOTS = {
    "Bot A (Fast Scanner)": {
        "state_file": DATA_DIR / "fast_scanner_state.json",
        "log_file": DATA_DIR / "fast_scanner_trades.jsonl",
        "strategy": "Fair value deviation (30-60s scans, 8% threshold)",
        "interval": "45s",
    },
    "Bot B (Edge Detector)": {
        "state_file": DATA_DIR / "paper_trades.json",
        "log_file": DATA_DIR / "paper_trades_log.jsonl",
        "strategy": "Multi-signal edge detection (momentum, mean-rev, LLM)",
        "interval": "30min",
    },
    "Bot C (News-Driven)": {
        "state_file": DATA_DIR / "bot_c_news_state.json",
        "log_file": DATA_DIR / "bot_c_news_trades.jsonl",
        "strategy": "LLM news analysis for mispricing",
        "interval": "15min",
    },
    "Bot D (Cross-Market Arb)": {
        "state_file": DATA_DIR / "bot_d_arb_state.json",
        "log_file": DATA_DIR / "bot_d_arb_trades.jsonl",
        "strategy": "Cross-market price inconsistency",
        "interval": "5min",
    },
}


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

def compute_bot_stats(state: dict, trades: list) -> dict:
    """Compute detailed stats for a bot."""
    if state is None:
        state = {}

    stats = state.get("stats", {})
    bankroll = state.get("bankroll", 10_000)
    initial = state.get("initial_bankroll", 10_000)
    wins = stats.get("wins", 0)
    losses = stats.get("losses", 0)
    closed = wins + losses
    total_pnl = stats.get("total_pnl", 0)

    # Analyze trade log for detailed metrics
    closed_trades = [t for t in trades if t.get("action") == "CLOSE"]

    pnls = [t.get("pnl", 0) for t in closed_trades]
    returns = [t.get("return_pct", 0) for t in closed_trades]
    hold_minutes = [t.get("hold_minutes", 0) for t in closed_trades if t.get("hold_minutes")]

    # Calculate Sharpe-like ratio (annualized)
    if pnls and len(pnls) >= 2:
        import statistics
        mean_pnl = statistics.mean(pnls)
        std_pnl = statistics.stdev(pnls) if len(pnls) > 1 else 1
        sharpe = (mean_pnl / std_pnl) * (252 ** 0.5) if std_pnl > 0 else 0
    else:
        mean_pnl = 0
        sharpe = 0

    # Win/loss amounts
    win_pnls = [p for p in pnls if p > 0]
    loss_pnls = [p for p in pnls if p <= 0]

    avg_win = sum(win_pnls) / len(win_pnls) if win_pnls else 0
    avg_loss = sum(loss_pnls) / len(loss_pnls) if loss_pnls else 0
    profit_factor = abs(sum(win_pnls) / sum(loss_pnls)) if loss_pnls and sum(loss_pnls) != 0 else float('inf')

    # Exit reason breakdown
    exit_reasons = {}
    for t in closed_trades:
        reason = t.get("reason", "unknown")
        exit_reasons[reason] = exit_reasons.get(reason, 0) + 1

    # Time analysis
    avg_hold = sum(hold_minutes) / len(hold_minutes) if hold_minutes else 0

    # Daily P&L
    daily_pnl = {}
    for t in closed_trades:
        ts = t.get("timestamp", "")[:10]
        if ts:
            daily_pnl[ts] = daily_pnl.get(ts, 0) + t.get("pnl", 0)

    # Best and worst day
    best_day = max(daily_pnl.items(), key=lambda x: x[1]) if daily_pnl else ("N/A", 0)
    worst_day = min(daily_pnl.items(), key=lambda x: x[1]) if daily_pnl else ("N/A", 0)

    return {
        "bankroll": round(bankroll, 2),
        "initial": round(initial, 2),
        "return_pct": round((bankroll - initial) / initial * 100, 2) if initial > 0 else 0,
        "total_pnl": round(total_pnl, 2),
        "total_trades": stats.get("total_trades", len(trades)),
        "closed_trades": closed,
        "wins": wins,
        "losses": losses,
        "win_rate": round(wins / max(1, closed), 3),
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "profit_factor": round(min(profit_factor, 99.99), 2),
        "sharpe": round(sharpe, 2),
        "max_drawdown_pct": round(stats.get("max_drawdown", 0) * 100, 2),
        "avg_hold_min": round(avg_hold, 1),
        "open_positions": len(state.get("positions", {})),
        "exit_reasons": exit_reasons,
        "best_day": best_day,
        "worst_day": worst_day,
        "daily_pnl": daily_pnl,
    }


# ---------------------------------------------------------------------------
# Report Generation
# ---------------------------------------------------------------------------

def generate_comparison_table(all_stats: dict) -> str:
    """Generate a plain-text comparison table."""
    lines = []
    lines.append(f"{'='*85}")
    lines.append(f"  POLYMARKET BOT COMPARISON DASHBOARD")
    lines.append(f"  Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append(f"{'='*85}")

    # Summary table
    lines.append(f"\n  {'Bot':<25} {'Bankroll':>10} {'P&L':>10} {'Return':>8} {'WR':>6} {'Trades':>7} {'Sharpe':>7}")
    lines.append(f"  {'-'*73}")

    for bot_name, stats in all_stats.items():
        if stats is None:
            lines.append(f"  {bot_name:<25} {'[no data]':>10}")
            continue
        lines.append(
            f"  {bot_name:<25} "
            f"${stats['bankroll']:>8,.0f} "
            f"${stats['total_pnl']:>+8,.0f} "
            f"{stats['return_pct']:>+6.1f}% "
            f"{stats['win_rate']:>5.0%} "
            f"{stats['closed_trades']:>6} "
            f"{stats['sharpe']:>6.2f}"
        )

    # Determine leader
    valid = {k: v for k, v in all_stats.items() if v is not None and v["closed_trades"] > 0}
    if valid:
        leader_pnl = max(valid.items(), key=lambda x: x[1]["total_pnl"])
        leader_wr = max(valid.items(), key=lambda x: x[1]["win_rate"])
        leader_sharpe = max(valid.items(), key=lambda x: x[1]["sharpe"])

        lines.append(f"\n  LEADERS:")
        lines.append(f"    Best P&L:    {leader_pnl[0]} (${leader_pnl[1]['total_pnl']:+,.2f})")
        lines.append(f"    Best WR:     {leader_wr[0]} ({leader_wr[1]['win_rate']:.0%})")
        lines.append(f"    Best Sharpe: {leader_sharpe[0]} ({leader_sharpe[1]['sharpe']:.2f})")

    return "\n".join(lines)


def generate_detailed_report(all_stats: dict) -> str:
    """Generate detailed per-bot breakdown."""
    lines = []

    for bot_name, stats in all_stats.items():
        if stats is None:
            continue

        lines.append(f"\n{'='*60}")
        lines.append(f"  {bot_name}")
        lines.append(f"{'='*60}")
        lines.append(f"  Strategy: {BOTS.get(bot_name, {}).get('strategy', 'N/A')}")
        lines.append(f"  Interval: {BOTS.get(bot_name, {}).get('interval', 'N/A')}")
        lines.append(f"")
        lines.append(f"  Bankroll:      ${stats['bankroll']:,.2f} (started ${stats['initial']:,.0f})")
        lines.append(f"  Return:        {stats['return_pct']:+.2f}%")
        lines.append(f"  Total P&L:     ${stats['total_pnl']:+,.2f}")
        lines.append(f"  Max Drawdown:  {stats['max_drawdown_pct']:.2f}%")
        lines.append(f"  Sharpe:        {stats['sharpe']:.2f}")
        lines.append(f"  Profit Factor: {stats['profit_factor']:.2f}")
        lines.append(f"")
        lines.append(f"  Trades: {stats['closed_trades']} closed ({stats['wins']}W / {stats['losses']}L)")
        lines.append(f"  Win Rate:   {stats['win_rate']:.0%}")
        lines.append(f"  Avg Win:    ${stats['avg_win']:+.2f}")
        lines.append(f"  Avg Loss:   ${stats['avg_loss']:+.2f}")
        lines.append(f"  Avg Hold:   {stats['avg_hold_min']:.0f} min")
        lines.append(f"  Open:       {stats['open_positions']} positions")

        if stats["exit_reasons"]:
            lines.append(f"\n  Exit Reasons:")
            for reason, count in sorted(stats["exit_reasons"].items(), key=lambda x: -x[1]):
                lines.append(f"    {reason:<25} {count}")

        if stats["best_day"][0] != "N/A":
            lines.append(f"\n  Best Day:  {stats['best_day'][0]} (${stats['best_day'][1]:+,.2f})")
            lines.append(f"  Worst Day: {stats['worst_day'][0]} (${stats['worst_day'][1]:+,.2f})")

    return "\n".join(lines)


def generate_discord_report(all_stats: dict) -> str:
    """Generate Discord-formatted markdown report."""
    lines = []
    lines.append("## Polymarket Bot Comparison")
    lines.append(f"*{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}*\n")

    lines.append("```")
    lines.append(f"{'Bot':<22} {'$':>8} {'P&L':>8} {'Ret%':>6} {'WR':>5} {'#':>4} {'Sharpe':>6}")
    lines.append(f"{'-'*60}")

    for bot_name, stats in all_stats.items():
        if stats is None:
            lines.append(f"{bot_name:<22} {'N/A':>8}")
            continue

        short_name = bot_name.split("(")[1].rstrip(")") if "(" in bot_name else bot_name
        lines.append(
            f"{short_name:<22} "
            f"${stats['bankroll']:>6,.0f} "
            f"${stats['total_pnl']:>+6,.0f} "
            f"{stats['return_pct']:>+5.1f}% "
            f"{stats['win_rate']:>4.0%} "
            f"{stats['closed_trades']:>3} "
            f"{stats['sharpe']:>5.2f}"
        )

    lines.append("```")

    # Highlight leader
    valid = {k: v for k, v in all_stats.items() if v is not None and v["closed_trades"] > 0}
    if valid:
        leader = max(valid.items(), key=lambda x: x[1]["total_pnl"])
        short = leader[0].split("(")[1].rstrip(")") if "(" in leader[0] else leader[0]
        lines.append(f"\n**Leader:** {short} (${leader[1]['total_pnl']:+,.2f})")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def gather_all_stats() -> dict:
    """Gather stats from all bots."""
    all_stats = {}
    for bot_name, config in BOTS.items():
        state = read_state_file(config["state_file"])
        trades = read_trade_log(config["log_file"])
        if state is not None or trades:
            all_stats[bot_name] = compute_bot_stats(state, trades)
        else:
            all_stats[bot_name] = None
    return all_stats


def main():
    parser = argparse.ArgumentParser(description="Bot Performance Comparison")
    parser.add_argument("--discord", action="store_true", help="Output Discord-formatted report")
    parser.add_argument("--detailed", action="store_true", help="Show detailed per-bot breakdown")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    all_stats = gather_all_stats()

    if args.json:
        print(json.dumps(all_stats, indent=2, default=str))
    elif args.discord:
        print(generate_discord_report(all_stats))
    else:
        print(generate_comparison_table(all_stats))
        if args.detailed:
            print(generate_detailed_report(all_stats))


if __name__ == "__main__":
    main()
