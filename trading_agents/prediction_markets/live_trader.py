#!/usr/bin/env python3
"""
Polymarket Live Trader — Places real orders via the CLOB API through VPN.

Same logic as paper_trader but executes real orders via polymarket_trader.py's
PolymarketCLOB client. REQUIRES --live flag to actually trade.

Safety features:
  - Defaults to dry-run mode (shows what would happen, no real orders)
  - Configurable daily loss limit (default $50)
  - Max 10 open positions
  - All trades logged to JSONL
  - Discord webhook notifications on every trade
  - Kill switch: --kill cancels all orders and closes positions

Usage:
    python -m trading_agents.prediction_markets.live_trader --dry-run
    python -m trading_agents.prediction_markets.live_trader --live
    python -m trading_agents.prediction_markets.live_trader --live --max-daily-loss 100
    python -m trading_agents.prediction_markets.live_trader --status
    python -m trading_agents.prediction_markets.live_trader --kill

Environment Variables:
    POLYMARKET_PRIVATE_KEY  — Ethereum private key (required for --live)
    POLYMARKET_API_KEY      — CLOB API key (auto-derived if missing)
    POLYMARKET_SECRET       — CLOB API secret
    POLYMARKET_PASSPHRASE   — CLOB API passphrase
    POLYMARKET_PROXY        — SOCKS5 proxy URL (default: socks5h://165.154.162.230:1080)
    DISCORD_WEBHOOK_URL     — Discord webhook for trade notifications (optional)
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger("live_trader")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

# Load .env
ENV_FILE = THIS_DIR.parents[1] / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            v = v.strip().strip("'\"")
            if k.strip() not in os.environ:
                os.environ[k.strip()] = v

from polymarket_client import PolymarketScanner, TAKER_FEE, MAKER_FEE
from polymarket_trader import (
    PolymarketCLOB,
    PositionTracker,
    create_proxy_session,
    verify_proxy,
    resolve_market,
    get_private_key,
)
from edge_detector import EdgeDetector, load_price_history
from paper_trader import kelly_size

# State files
LIVE_STATE_FILE = DATA_DIR / "live_trader_state.json"
LIVE_TRADE_LOG = DATA_DIR / "live_trades.jsonl"

# Risk limits
DEFAULT_MAX_DAILY_LOSS = 50.0       # USDC
DEFAULT_MAX_OPEN_POSITIONS = 10
DEFAULT_MAX_POSITION_SIZE = 100.0   # USDC per market
DEFAULT_MIN_EDGE_SCORE = 75         # Higher threshold for live
DEFAULT_STOP_LOSS_PCT = 0.15


# ---------------------------------------------------------------------------
# Discord Notifications
# ---------------------------------------------------------------------------

def send_discord_notification(message: str):
    """Send a notification to Discord via webhook."""
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        return

    try:
        import requests
        requests.post(
            webhook_url,
            json={"content": message},
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Discord notification failed: {e}")


# ---------------------------------------------------------------------------
# Live Trading State
# ---------------------------------------------------------------------------

class LiveTradingState:
    """Tracks live trading state including daily P&L and risk limits."""

    def __init__(self, state_file: Path = LIVE_STATE_FILE):
        self.state_file = state_file
        self.state = self._load()

    def _load(self) -> dict:
        if self.state_file.exists():
            try:
                with open(self.state_file) as f:
                    data = json.load(f)

                # Reset daily stats if it's a new day
                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                if data.get("current_day") != today:
                    data["daily_pnl"] = 0.0
                    data["daily_trades"] = 0
                    data["current_day"] = today

                return data
            except Exception as e:
                logger.warning(f"Failed to load live state: {e}")

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return {
            "current_day": today,
            "daily_pnl": 0.0,
            "daily_trades": 0,
            "total_pnl": 0.0,
            "total_trades": 0,
            "wins": 0,
            "losses": 0,
            "max_daily_loss_triggered": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }

    def save(self):
        self.state["last_updated"] = datetime.now(timezone.utc).isoformat()
        with open(self.state_file, "w") as f:
            json.dump(self.state, f, indent=2, default=str)

    def record_trade(self, pnl: float = 0, is_entry: bool = True):
        """Record a trade execution."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self.state.get("current_day") != today:
            self.state["daily_pnl"] = 0.0
            self.state["daily_trades"] = 0
            self.state["current_day"] = today
            self.state["max_daily_loss_triggered"] = False

        self.state["daily_trades"] += 1
        self.state["total_trades"] += 1

        if not is_entry:
            self.state["daily_pnl"] = round(self.state["daily_pnl"] + pnl, 4)
            self.state["total_pnl"] = round(self.state["total_pnl"] + pnl, 4)
            if pnl > 0:
                self.state["wins"] += 1
            else:
                self.state["losses"] += 1

        self.save()

    def check_daily_limit(self, max_loss: float) -> bool:
        """Check if daily loss limit has been hit. Returns True if OK to trade."""
        if self.state["daily_pnl"] <= -abs(max_loss):
            self.state["max_daily_loss_triggered"] = True
            self.save()
            return False
        return True

    def _log_trade(self, trade: dict):
        trade["timestamp"] = datetime.now(timezone.utc).isoformat()
        with open(LIVE_TRADE_LOG, "a") as f:
            f.write(json.dumps(trade, default=str) + "\n")


# ---------------------------------------------------------------------------
# Live Trader
# ---------------------------------------------------------------------------

class LiveTrader:
    """
    Live trading engine for Polymarket.

    Uses EdgeDetector for signals, PolymarketCLOB for order execution,
    and PositionTracker for position management.
    """

    def __init__(
        self,
        live: bool = False,
        min_score: int = DEFAULT_MIN_EDGE_SCORE,
        max_daily_loss: float = DEFAULT_MAX_DAILY_LOSS,
        max_positions: int = DEFAULT_MAX_OPEN_POSITIONS,
        max_position_size: float = DEFAULT_MAX_POSITION_SIZE,
        use_llm: bool = True,
    ):
        self.live = live
        self.min_score = min_score
        self.max_daily_loss = max_daily_loss
        self.max_positions = max_positions
        self.max_position_size = max_position_size

        self.state = LiveTradingState()
        self.detector = EdgeDetector(use_llm=use_llm, min_score=min_score)
        self.tracker = PositionTracker(paper=not live)

        # Initialize CLOB client
        self.clob = None
        if live:
            private_key = get_private_key()
            if not private_key:
                raise ValueError(
                    "POLYMARKET_PRIVATE_KEY not set. Cannot trade in live mode.\n"
                    "Set it in .env or as an environment variable."
                )
            self.clob = PolymarketCLOB(private_key=private_key)

            # Verify proxy
            proxy_info = verify_proxy(self.clob.session)
            if not proxy_info.get("ok"):
                logger.warning(
                    f"Proxy verification failed! IP: {proxy_info.get('ip')}, "
                    f"Country: {proxy_info.get('country')}. "
                    f"Polymarket may block US IPs."
                )
            else:
                logger.info(
                    f"Proxy OK: {proxy_info['ip']} ({proxy_info.get('city')}, {proxy_info.get('country')})"
                )

        mode = "LIVE" if live else "DRY-RUN"
        logger.info(
            f"Live Trader initialized in {mode} mode. "
            f"Max daily loss: ${max_daily_loss}, Max positions: {max_positions}"
        )

    def _preflight_check(self) -> bool:
        """Run safety checks before trading."""
        # Check daily loss limit
        if not self.state.check_daily_limit(self.max_daily_loss):
            logger.warning(
                f"DAILY LOSS LIMIT HIT (${self.state.state['daily_pnl']:.2f} / "
                f"-${self.max_daily_loss}). Trading halted for today."
            )
            send_discord_notification(
                f"**POLYMARKET LIVE TRADER** - Daily loss limit hit! "
                f"P&L today: ${self.state.state['daily_pnl']:.2f}. Trading halted."
            )
            return False

        # Check max positions
        open_pos = self.tracker.get_open_positions()
        if len(open_pos) >= self.max_positions:
            logger.info(f"Max positions ({self.max_positions}) reached")
            return False

        return True

    def check_exits(self):
        """Check open positions for stop-loss or take-profit."""
        scanner = PolymarketScanner()

        for slug, pos in list(self.tracker.positions.items()):
            if pos.get("status") != "open":
                continue

            token_id = pos.get("token_id")
            if not token_id:
                continue

            # Get current price
            current_price = None
            try:
                if self.clob:
                    current_price = self.clob.get_midpoint(token_id)
                else:
                    current_price = scanner.get_midpoint(token_id)
            except Exception as e:
                logger.warning(f"Price check failed for {slug}: {e}")
                continue

            if current_price is None:
                continue

            entry = pos["entry_price"]
            side = pos.get("side", "YES")

            # Calculate P&L %
            if side in ("YES", "BUY_YES", "BUY"):
                pnl_pct = (current_price - entry) / entry if entry > 0 else 0
            else:
                pnl_pct = (entry - current_price) / entry if entry > 0 else 0

            # Stop-loss
            if pnl_pct <= -DEFAULT_STOP_LOSS_PCT:
                logger.warning(f"STOP-LOSS: {slug} at {pnl_pct:.1%}")
                result = self.tracker.record_exit(slug, current_price, reason="stop_loss")
                if result:
                    pnl = result.get("pnl", 0)
                    self.state.record_trade(pnl=pnl, is_entry=False)
                    send_discord_notification(
                        f"**STOP-LOSS** {slug}\n"
                        f"Entry: {entry:.3f} -> Exit: {current_price:.3f}\n"
                        f"P&L: ${pnl:+.2f}"
                    )
                continue

            # Take-profit (30%)
            if pnl_pct >= 0.30:
                logger.info(f"TAKE-PROFIT: {slug} at {pnl_pct:.1%}")
                result = self.tracker.record_exit(slug, current_price, reason="take_profit")
                if result:
                    pnl = result.get("pnl", 0)
                    self.state.record_trade(pnl=pnl, is_entry=False)
                    send_discord_notification(
                        f"**TAKE-PROFIT** {slug}\n"
                        f"Entry: {entry:.3f} -> Exit: {current_price:.3f}\n"
                        f"P&L: ${pnl:+.2f}"
                    )

    def find_and_execute_entries(self) -> list:
        """Find edge opportunities and execute trades."""
        if not self._preflight_check():
            return []

        # Get edges
        edges = self.detector.get_actionable_edges(min_score=self.min_score)
        if not edges:
            logger.info("No cached edges, running fresh scan...")
            scan = self.detector.scan(limit=200, min_score=self.min_score)
            edges = scan.get("opportunities", [])

        # Filter out existing positions
        existing = set(self.tracker.get_open_positions().keys())
        edges = [e for e in edges if e["slug"] not in existing]

        trades = []
        for edge in edges:
            if len(trades) + len(existing) >= self.max_positions:
                break

            slug = edge["slug"]
            score = edge["composite_score"]
            direction = edge["direction"]
            price = edge["yes_price"]
            edge_est = edge.get("edge_estimate", 0)

            if direction in ("NO_EDGE", "NEUTRAL"):
                continue

            # Determine side and token
            if direction == "BUY_YES":
                side = "YES"
                entry_price = price
                token_id = edge.get("yes_token", "")
            elif direction == "BUY_NO":
                side = "NO"
                entry_price = 1 - price
                token_id = edge.get("no_token", "")
            else:
                continue

            # Position sizing
            # For live: use tracker's total exposure as pseudo-bankroll reference
            available = self.max_position_size * self.max_positions
            size = kelly_size(
                edge=edge_est,
                price=entry_price,
                bankroll=available,
                max_pct=0.15,
            )
            size = min(size, self.max_position_size)

            if size < 5:
                continue

            # Resolve market for token ID if missing
            if not token_id and self.clob:
                market_info = resolve_market(self.clob.session, slug)
                if market_info:
                    token_id = market_info.get("yes_token" if side == "YES" else "no_token", "")

            if not token_id:
                logger.warning(f"No token ID for {slug}, skipping")
                continue

            # Place order
            order_id = f"DRY-{int(time.time())}"
            if self.live and self.clob:
                try:
                    # Place as maker order (0% fee) slightly inside the book
                    limit_price = round(entry_price - 0.01, 2) if side == "YES" else round(entry_price - 0.01, 2)
                    limit_price = max(0.01, min(0.99, limit_price))

                    result = self.clob.place_limit_order(
                        token_id=token_id,
                        side="BUY",
                        price=limit_price,
                        size=size,
                    )
                    order_id = result.get("orderID", result.get("id", f"LIVE-{int(time.time())}"))
                    logger.info(f"LIVE order placed: {order_id}")
                except Exception as e:
                    logger.error(f"Order failed for {slug}: {e}")
                    send_discord_notification(f"**ORDER FAILED** {slug}: {e}")
                    continue

            # Record position
            self.tracker.record_entry(
                slug=slug,
                token_id=token_id,
                side=side,
                price=entry_price,
                size=size,
                order_id=order_id,
                signal_type=edge.get("active_signals", ["unknown"])[0],
            )
            self.state.record_trade(is_entry=True)

            trade_info = {
                "slug": slug,
                "side": side,
                "price": entry_price,
                "size": size,
                "score": score,
                "order_id": order_id,
            }
            trades.append(trade_info)

            # Notify Discord
            mode = "LIVE" if self.live else "DRY-RUN"
            send_discord_notification(
                f"**[{mode}] NEW TRADE** {side} {slug}\n"
                f"Price: {entry_price:.3f} | Size: ${size:.0f} | Score: {score}\n"
                f"Signals: {', '.join(edge.get('active_signals', []))}"
            )

            self.state._log_trade({
                "action": "ENTRY",
                "live": self.live,
                **trade_info,
            })

        return trades

    def run_cycle(self) -> dict:
        """Run one full trading cycle."""
        mode = "LIVE" if self.live else "DRY-RUN"
        logger.info(f"--- {mode} Trading Cycle ---")

        # 1. Check exits
        self.check_exits()

        # 2. Find and execute entries
        trades = self.find_and_execute_entries()

        # 3. Summary
        summary = self.tracker.get_summary()
        daily = {
            "daily_pnl": self.state.state["daily_pnl"],
            "daily_trades": self.state.state["daily_trades"],
            "daily_limit_hit": self.state.state.get("max_daily_loss_triggered", False),
        }

        logger.info(
            f"[{mode}] Open: {summary['open_positions']} | "
            f"Exposure: ${summary['total_exposure']:.0f} | "
            f"Daily P&L: ${daily['daily_pnl']:+.2f} | "
            f"Total P&L: ${summary['total_pnl']:+.2f} | "
            f"WR: {summary['win_rate']:.0%}"
        )

        return {
            "mode": mode,
            "new_trades": len(trades),
            "trades": trades,
            **summary,
            **daily,
        }

    def run_loop(self, interval_sec: int = 1800):
        """Continuous trading loop."""
        mode = "LIVE" if self.live else "DRY-RUN"
        logger.info(f"{mode} trader loop starting (interval={interval_sec}s)")
        send_discord_notification(
            f"**Polymarket {mode} Trader Started**\n"
            f"Max daily loss: ${self.max_daily_loss} | "
            f"Max positions: {self.max_positions} | "
            f"Min score: {self.min_score}"
        )

        cycle = 0
        while True:
            cycle += 1
            try:
                self.run_cycle()
            except KeyboardInterrupt:
                logger.info("Trader stopped by user")
                send_discord_notification(f"**Polymarket {mode} Trader Stopped** (user interrupt)")
                break
            except Exception as e:
                logger.error(f"Cycle {cycle} error: {e}", exc_info=True)
                send_discord_notification(f"**Trader Error** cycle {cycle}: {str(e)[:100]}")

            try:
                time.sleep(interval_sec)
            except KeyboardInterrupt:
                logger.info("Trader stopped by user")
                break

    def kill_switch(self):
        """Emergency: cancel all orders and close all positions."""
        mode = "LIVE" if self.live else "DRY-RUN"
        logger.warning(f"KILL SWITCH activated ({mode})")
        send_discord_notification(f"**KILL SWITCH** activated on Polymarket {mode} trader!")

        # Cancel all open orders
        if self.live and self.clob:
            try:
                self.clob.cancel_all()
                logger.info("All orders cancelled")
            except Exception as e:
                logger.error(f"Cancel all failed: {e}")

        # Close all positions at current prices
        scanner = PolymarketScanner()
        for slug, pos in list(self.tracker.positions.items()):
            if pos.get("status") != "open":
                continue

            token_id = pos.get("token_id")
            current_price = pos.get("entry_price", 0.5)  # Fallback

            if token_id:
                try:
                    mid = scanner.get_midpoint(token_id)
                    if mid is not None:
                        current_price = mid
                except Exception:
                    pass

            self.tracker.record_exit(slug, current_price, reason="kill_switch")

        summary = self.tracker.get_summary()
        logger.info(f"Kill switch complete. Final P&L: ${summary['total_pnl']:+.2f}")
        send_discord_notification(
            f"**Kill switch complete.** All positions closed.\n"
            f"Final P&L: ${summary['total_pnl']:+.2f}"
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_status():
    """Show live trader status."""
    live_state = LiveTradingState()
    # Try live tracker first, fall back to paper
    tracker = PositionTracker(paper=False)
    if not tracker.positions:
        tracker = PositionTracker(paper=True)

    summary = tracker.get_summary()
    ls = live_state.state

    print(f"\n{'='*60}")
    print(f"  POLYMARKET LIVE TRADER — STATUS")
    print(f"{'='*60}")
    print(f"  Mode:           {summary.get('mode', 'UNKNOWN')}")
    print(f"  Daily P&L:      ${ls.get('daily_pnl', 0):+.2f} (limit: -${DEFAULT_MAX_DAILY_LOSS})")
    print(f"  Daily Trades:   {ls.get('daily_trades', 0)}")
    print(f"  Daily Limit:    {'HIT' if ls.get('max_daily_loss_triggered') else 'OK'}")
    print(f"  Total P&L:      ${ls.get('total_pnl', 0):+.2f}")
    print(f"  Total Trades:   {ls.get('total_trades', 0)}")
    print(f"  Win Rate:       {ls.get('wins', 0)}W / {ls.get('losses', 0)}L")
    print(f"\n  Open Positions: {summary.get('open_positions', 0)}")
    print(f"  Total Exposure: ${summary.get('total_exposure', 0):,.0f}")

    positions = tracker.get_open_positions()
    if positions:
        print(f"\n  {'OPEN POSITIONS':}")
        for slug, pos in positions.items():
            print(
                f"  {slug[:40]:<41} {pos.get('side', '?'):<5} "
                f"@ {pos.get('entry_price', 0):.3f} "
                f"x ${pos.get('size', pos.get('cost', 0)):.0f}"
            )

    print(f"{'='*60}\n")


def main():
    parser = argparse.ArgumentParser(description="Polymarket Live Trader")
    parser.add_argument("--live", action="store_true", help="Enable LIVE trading (real orders)")
    parser.add_argument("--dry-run", action="store_true", help="Dry-run mode (no real orders)")
    parser.add_argument("--status", action="store_true", help="Show current status")
    parser.add_argument("--kill", action="store_true", help="Kill switch: cancel all and close")
    parser.add_argument("--loop", action="store_true", help="Run continuous trading loop")
    parser.add_argument("--min-score", type=int, default=DEFAULT_MIN_EDGE_SCORE, help="Minimum edge score")
    parser.add_argument("--max-daily-loss", type=float, default=DEFAULT_MAX_DAILY_LOSS, help="Max daily loss (USDC)")
    parser.add_argument("--max-positions", type=int, default=DEFAULT_MAX_OPEN_POSITIONS, help="Max open positions")
    parser.add_argument("--interval", type=int, default=1800, help="Loop interval in seconds")
    parser.add_argument("--no-llm", action="store_true", help="Disable LLM edge detection")
    args = parser.parse_args()

    if args.status:
        cmd_status()
        return

    is_live = args.live and not args.dry_run

    if args.kill:
        trader = LiveTrader(live=is_live, min_score=args.min_score)
        trader.kill_switch()
        return

    if args.loop:
        trader = LiveTrader(
            live=is_live,
            min_score=args.min_score,
            max_daily_loss=args.max_daily_loss,
            max_positions=args.max_positions,
            use_llm=not args.no_llm,
        )
        trader.run_loop(interval_sec=args.interval)
        return

    # Default: run one cycle
    trader = LiveTrader(
        live=is_live,
        min_score=args.min_score,
        max_daily_loss=args.max_daily_loss,
        max_positions=args.max_positions,
        use_llm=not args.no_llm,
    )
    result = trader.run_cycle()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
