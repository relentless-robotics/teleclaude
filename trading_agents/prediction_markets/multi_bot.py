#!/usr/bin/env python3
"""
Multi-Bot Polymarket Trading Architecture.

Runs multiple independent paper trading bots in parallel:
  Bot A: Fast Scanner (30-60s interval, deviation-based)
  Bot B: Edge Detector (30min interval, existing paper_trader.py - runs separately)
  Bot C: News-Driven (checks news feeds, predicts market moves)
  Bot D: Cross-Market Arbitrage (finds correlated markets with price gaps)

Each bot has its own $10K paper portfolio and logs trades independently.

Usage:
    python -m trading_agents.prediction_markets.multi_bot --run-all
    python -m trading_agents.prediction_markets.multi_bot --run news
    python -m trading_agents.prediction_markets.multi_bot --run arb
    python -m trading_agents.prediction_markets.multi_bot --status
"""

import argparse
import json
import logging
import os
import sys
import time
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger("multi_bot")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from polymarket_client import PolymarketScanner, TAKER_FEE, _get, GAMMA_API, CLOB_API

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

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

DEFAULT_BANKROLL = 10_000.0
MAX_POSITION_PCT = 0.05
TAKER = TAKER_FEE


# ---------------------------------------------------------------------------
# Base Bot Class
# ---------------------------------------------------------------------------

class BaseBotState:
    """Shared paper trading state logic for all bots."""

    def __init__(self, bot_name: str, bankroll: float = DEFAULT_BANKROLL):
        self.bot_name = bot_name
        self.state_file = DATA_DIR / f"{bot_name}_state.json"
        self.log_file = DATA_DIR / f"{bot_name}_trades.jsonl"
        self.state = self._load(bankroll)

    def _load(self, bankroll: float) -> dict:
        if self.state_file.exists():
            try:
                with open(self.state_file) as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "bankroll": bankroll,
            "initial_bankroll": bankroll,
            "positions": {},
            "stats": {
                "total_trades": 0, "wins": 0, "losses": 0,
                "total_pnl": 0.0, "max_drawdown": 0.0,
                "peak_bankroll": bankroll, "cycles": 0,
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    def save(self):
        self.state["last_updated"] = datetime.now(timezone.utc).isoformat()
        with open(self.state_file, "w") as f:
            json.dump(self.state, f, indent=2, default=str)

    def log_trade(self, trade: dict):
        trade["timestamp"] = datetime.now(timezone.utc).isoformat()
        trade["bot"] = self.bot_name
        with open(self.log_file, "a") as f:
            f.write(json.dumps(trade, default=str) + "\n")

    @property
    def bankroll(self) -> float:
        return self.state["bankroll"]

    @bankroll.setter
    def bankroll(self, value: float):
        self.state["bankroll"] = round(value, 2)
        if value > self.state["stats"]["peak_bankroll"]:
            self.state["stats"]["peak_bankroll"] = round(value, 2)
        dd = (self.state["stats"]["peak_bankroll"] - value) / max(self.state["stats"]["peak_bankroll"], 1)
        if dd > self.state["stats"]["max_drawdown"]:
            self.state["stats"]["max_drawdown"] = round(dd, 4)

    def open_position(self, slug, question, side, entry_price, size_usdc, signal_data=None):
        fee = TAKER * entry_price * (1 - entry_price) * size_usdc
        contracts = size_usdc / entry_price if entry_price > 0 else 0

        pos = {
            "slug": slug, "question": question[:120], "side": side,
            "entry_price": round(entry_price, 4),
            "size_usdc": round(size_usdc, 2),
            "contracts": round(contracts, 2),
            "entry_fee": round(fee, 4),
            "signal_data": signal_data or {},
            "entry_time": datetime.now(timezone.utc).isoformat(),
            "status": "open",
        }

        self.state["positions"][slug] = pos
        self.bankroll = self.bankroll - size_usdc - fee
        self.state["stats"]["total_trades"] += 1

        self.log_trade({"action": "OPEN", "slug": slug, "side": side,
                        "price": entry_price, "size": size_usdc, "fee": fee,
                        "signal": signal_data})
        self.save()
        logger.info(f"[{self.bot_name}] OPEN {side} {slug[:35]} @ {entry_price:.3f} ${size_usdc:.0f}")

    def close_position(self, slug, exit_price, reason="manual"):
        pos = self.state["positions"].get(slug)
        if not pos or pos["status"] != "open":
            return None

        side, entry, contracts, size = pos["side"], pos["entry_price"], pos["contracts"], pos["size_usdc"]
        raw_pnl = (exit_price - entry) * contracts if side == "YES" else (entry - exit_price) * contracts
        exit_fee = TAKER * exit_price * (1 - exit_price) * abs(contracts * exit_price)
        net_pnl = raw_pnl - pos["entry_fee"] - exit_fee

        self.bankroll = self.bankroll + size + net_pnl
        if net_pnl > 0:
            self.state["stats"]["wins"] += 1
        else:
            self.state["stats"]["losses"] += 1
        self.state["stats"]["total_pnl"] = round(self.state["stats"]["total_pnl"] + net_pnl, 4)

        ret_pct = round(net_pnl / size * 100, 2) if size > 0 else 0
        self.log_trade({"action": "CLOSE", "slug": slug, "side": side,
                        "entry": entry, "exit": exit_price, "pnl": net_pnl,
                        "return_pct": ret_pct, "reason": reason})

        del self.state["positions"][slug]
        self.save()
        logger.info(f"[{self.bot_name}] CLOSE {slug[:35]} PnL=${net_pnl:+.2f} ({ret_pct:+.1f}%) {reason}")
        return {"pnl": net_pnl, "return_pct": ret_pct}

    def get_summary(self) -> dict:
        s = self.state["stats"]
        closed = s["wins"] + s["losses"]
        return {
            "bot": self.bot_name,
            "bankroll": round(self.bankroll, 2),
            "return_pct": round((self.bankroll - self.state["initial_bankroll"]) / self.state["initial_bankroll"] * 100, 2),
            "total_trades": s["total_trades"],
            "wins": s["wins"], "losses": s["losses"],
            "win_rate": round(s["wins"] / max(1, closed), 3),
            "total_pnl": round(s["total_pnl"], 2),
            "max_drawdown_pct": round(s["max_drawdown"] * 100, 2),
            "open_positions": sum(1 for p in self.state["positions"].values() if p["status"] == "open"),
            "cycles": s["cycles"],
        }


# ---------------------------------------------------------------------------
# Bot C: News-Driven
# ---------------------------------------------------------------------------

class NewsDrivenBot:
    """
    Bot C: Monitors news/headlines and predicts market price moves.

    Strategy: Use Groq LLM to analyze recent market questions against
    current events. If the LLM identifies a market that should move
    based on recent news but hasn't yet, trade the expected move.
    """

    def __init__(self):
        self.state = BaseBotState("bot_c_news")
        self.scanner = PolymarketScanner()
        self.interval = 900  # 15 minutes
        self._last_news_check = 0

    def _get_news_signal(self, markets: list) -> list:
        """
        Use Groq to analyze a batch of markets for news-driven mispricing.
        Returns list of (slug, side, confidence, reasoning) tuples.
        """
        if not GROQ_API_KEY:
            logger.warning("No GROQ_API_KEY, news bot cannot function")
            return []

        import requests

        # Build a compact summary of top markets
        market_summaries = []
        for m in markets[:30]:  # Top 30 by volume
            slug = m.get("slug", "")
            question = m.get("question", "")
            prices_raw = m.get("outcomePrices", "")
            if isinstance(prices_raw, str):
                try:
                    prices_raw = json.loads(prices_raw)
                except Exception:
                    continue
            if not prices_raw:
                continue
            try:
                yes_price = float(prices_raw[0])
            except (ValueError, TypeError):
                continue

            if 0.05 < yes_price < 0.95:
                market_summaries.append(f"- [{slug}] \"{question}\" YES={yes_price:.1%}")

        if not market_summaries:
            return []

        prompt = f"""You are a prediction market analyst. Today is {datetime.now().strftime('%B %d, %Y')}.

Below are active Polymarket markets with current prices. Identify markets where the price is WRONG based on recent news, events, or publicly known information.

Markets:
{chr(10).join(market_summaries[:25])}

For each mispriced market, explain:
1. What news/event makes the current price wrong
2. Whether to buy YES or NO
3. Your confidence (0.0-1.0)

Respond in JSON:
{{
  "signals": [
    {{"slug": "market-slug", "side": "YES|NO", "confidence": 0.8, "fair_value": 0.65, "reasoning": "brief explanation"}}
  ]
}}

Only include markets where you have HIGH confidence (>0.7) the price is wrong. If none, return empty signals array."""

        try:
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 500,
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                },
                timeout=30,
            )

            if resp.status_code == 429:
                logger.warning("Groq rate limited for news bot")
                return []

            resp.raise_for_status()
            result = json.loads(resp.json()["choices"][0]["message"]["content"])
            return result.get("signals", [])

        except Exception as e:
            logger.error(f"News signal generation failed: {e}")
            return []

    def _get_current_price(self, slug: str, markets: list) -> Optional[float]:
        """Get current YES price for a slug from the markets list."""
        for m in markets:
            if m.get("slug") == slug:
                prices_raw = m.get("outcomePrices", "")
                if isinstance(prices_raw, str):
                    try:
                        prices_raw = json.loads(prices_raw)
                    except Exception:
                        return None
                if prices_raw:
                    try:
                        return float(prices_raw[0])
                    except (ValueError, TypeError):
                        return None
        return None

    def check_exits(self, markets: list):
        """Exit positions based on price movement or time."""
        for slug, pos in list(self.state.state["positions"].items()):
            if pos["status"] != "open":
                continue

            current = self._get_current_price(slug, markets)
            if current is None:
                continue

            side = pos["side"]
            entry = pos["entry_price"]

            if side == "NO":
                current = 1 - current

            # Stop loss (20%)
            if side == "YES" and current < entry * 0.80:
                self.state.close_position(slug, current, "stop_loss")
            elif side == "NO" and current > entry * 1.20:
                self.state.close_position(slug, current, "stop_loss")
            # Take profit (25%)
            elif side == "YES" and current > entry * 1.25:
                self.state.close_position(slug, current, "take_profit")
            elif side == "NO" and current < entry * 0.75:
                self.state.close_position(slug, current, "take_profit")
            # Max hold (3 days for news trades)
            else:
                entry_time = datetime.fromisoformat(pos["entry_time"])
                if datetime.now(timezone.utc) - entry_time > timedelta(days=3):
                    self.state.close_position(slug, current, "max_hold")

    def run_cycle(self) -> dict:
        logger.info("--- News Bot (C) Cycle ---")

        markets = self.scanner.get_active_markets(limit=100)
        self.check_exits(markets)

        signals = self._get_news_signal(markets)
        new_trades = 0
        existing = set(self.state.state["positions"].keys())

        for sig in signals:
            slug = sig.get("slug", "")
            if slug in existing or not slug:
                continue
            if len(self.state.state["positions"]) >= 15:
                break

            side = sig.get("side", "YES")
            confidence = float(sig.get("confidence", 0))
            fair_value = sig.get("fair_value")

            if confidence < 0.7:
                continue

            current = self._get_current_price(slug, markets)
            if current is None:
                continue

            entry_price = current if side == "YES" else (1 - current)
            if entry_price < 0.05 or entry_price > 0.95:
                continue

            # Size based on confidence
            size = min(MAX_POSITION_PCT, confidence * 0.05) * self.state.bankroll
            if size < 5:
                continue

            self.state.open_position(
                slug=slug,
                question=sig.get("reasoning", slug)[:120],
                side=side,
                entry_price=entry_price,
                size_usdc=round(size, 2),
                signal_data={
                    "type": "news_driven",
                    "confidence": confidence,
                    "fair_value": fair_value,
                    "reasoning": sig.get("reasoning", ""),
                },
            )
            new_trades += 1

        self.state.state["stats"]["cycles"] += 1
        self.state.save()

        summary = self.state.get_summary()
        logger.info(
            f"[News Bot] {len(signals)} signals, {new_trades} trades | "
            f"${summary['bankroll']:.0f} | P&L: ${summary['total_pnl']:+.2f}"
        )
        return {"signals": len(signals), "new_trades": new_trades, **summary}


# ---------------------------------------------------------------------------
# Bot D: Cross-Market Arbitrage
# ---------------------------------------------------------------------------

class CrossMarketArbBot:
    """
    Bot D: Finds correlated/related markets with inconsistent prices.

    Examples of arbitrage:
    - "Trump wins X state" > "Trump wins election" (impossible if parent < child)
    - Sum of exclusive outcomes != 100% (e.g., "who wins?" candidates don't sum to 1)
    - Same event on different market phrasing with different prices
    """

    def __init__(self):
        self.state = BaseBotState("bot_d_arb")
        self.scanner = PolymarketScanner()
        self.interval = 300  # 5 minutes

    def _find_sum_arbs(self, markets: list) -> list:
        """
        Find markets where outcomes of related questions don't sum correctly.
        Group by common slug prefixes or question patterns.
        """
        opportunities = []

        # Group markets by event slug prefix (first 2 words of slug)
        groups = {}
        for m in markets:
            slug = m.get("slug", "")
            question = m.get("question", "")
            if not slug or not question:
                continue

            prices_raw = m.get("outcomePrices", "")
            if isinstance(prices_raw, str):
                try:
                    prices_raw = json.loads(prices_raw)
                except Exception:
                    continue
            if not prices_raw:
                continue

            try:
                yes_price = float(prices_raw[0])
            except (ValueError, TypeError):
                continue

            # Group key: first 3 significant words
            words = [w for w in slug.split("-") if len(w) > 2][:3]
            key = "-".join(words)

            if key not in groups:
                groups[key] = []
            groups[key].append({
                "slug": slug,
                "question": question,
                "yes_price": yes_price,
                "market": m,
            })

        # Look for groups where sum of YES prices is significantly != 1
        for key, group in groups.items():
            if len(group) < 2:
                continue

            total_yes = sum(m["yes_price"] for m in group)

            # If total significantly differs from 1.0, there's an arb
            if abs(total_yes - 1.0) > 0.10:
                # Prices sum to > 1: buy NO on overpriced (sell the group)
                # Prices sum to < 1: buy YES on underpriced (buy the group)
                if total_yes > 1.10:
                    # Find most overpriced - buy NO
                    group.sort(key=lambda x: x["yes_price"], reverse=True)
                    target = group[0]
                    opportunities.append({
                        "type": "sum_arb_over",
                        "slug": target["slug"],
                        "question": target["question"],
                        "side": "NO",
                        "current_price": target["yes_price"],
                        "entry_price": 1 - target["yes_price"],
                        "edge": total_yes - 1.0,
                        "group_total": total_yes,
                        "group_size": len(group),
                        "confidence": min(0.9, (total_yes - 1.0) * 2),
                    })
                elif total_yes < 0.90:
                    # Find most underpriced - buy YES
                    group.sort(key=lambda x: x["yes_price"])
                    target = group[0]
                    opportunities.append({
                        "type": "sum_arb_under",
                        "slug": target["slug"],
                        "question": target["question"],
                        "side": "YES",
                        "current_price": target["yes_price"],
                        "entry_price": target["yes_price"],
                        "edge": 1.0 - total_yes,
                        "group_total": total_yes,
                        "group_size": len(group),
                        "confidence": min(0.9, (1.0 - total_yes) * 2),
                    })

        return opportunities

    def _find_parent_child_arbs(self, markets: list) -> list:
        """
        Find parent-child logical inconsistencies.
        E.g., P(wins state X) should be <= P(wins election).
        """
        opportunities = []

        # Build question index
        q_index = {}
        for m in markets:
            slug = m.get("slug", "")
            question = (m.get("question", "") or "").lower()
            prices_raw = m.get("outcomePrices", "")
            if isinstance(prices_raw, str):
                try:
                    prices_raw = json.loads(prices_raw)
                except Exception:
                    continue
            if not prices_raw:
                continue
            try:
                yes_price = float(prices_raw[0])
            except (ValueError, TypeError):
                continue

            q_index[slug] = {"question": question, "yes_price": yes_price, "market": m}

        # Look for parent-child pairs
        for slug_a, data_a in q_index.items():
            for slug_b, data_b in q_index.items():
                if slug_a == slug_b:
                    continue

                q_a = data_a["question"]
                q_b = data_b["question"]

                # Simple heuristic: if question A is a subset condition of B
                # Check if one question contains the other's key entity
                # plus a more specific qualifier
                words_a = set(q_a.split())
                words_b = set(q_b.split())
                overlap = words_a & words_b

                if len(overlap) < 3:
                    continue

                # If A is more specific (has more words) and has higher price
                # than the general question, that's suspicious
                if len(words_a) > len(words_b) and data_a["yes_price"] > data_b["yes_price"] + 0.08:
                    # Specific event priced higher than general - sell the specific
                    opportunities.append({
                        "type": "parent_child",
                        "slug": slug_a,
                        "question": data_a["question"][:120],
                        "side": "NO",
                        "current_price": data_a["yes_price"],
                        "entry_price": 1 - data_a["yes_price"],
                        "edge": data_a["yes_price"] - data_b["yes_price"],
                        "parent_slug": slug_b,
                        "parent_price": data_b["yes_price"],
                        "confidence": 0.7,
                    })

        # Deduplicate by slug
        seen = set()
        unique = []
        for opp in opportunities:
            if opp["slug"] not in seen:
                seen.add(opp["slug"])
                unique.append(opp)

        return unique[:10]  # Top 10

    def check_exits(self, markets: list):
        """Exit arb positions."""
        q_index = {}
        for m in markets:
            slug = m.get("slug", "")
            prices_raw = m.get("outcomePrices", "")
            if isinstance(prices_raw, str):
                try:
                    prices_raw = json.loads(prices_raw)
                except Exception:
                    continue
            if prices_raw:
                try:
                    q_index[slug] = float(prices_raw[0])
                except (ValueError, TypeError):
                    pass

        for slug, pos in list(self.state.state["positions"].items()):
            if pos["status"] != "open":
                continue

            current = q_index.get(slug)
            if current is None:
                continue

            side = pos["side"]
            entry = pos["entry_price"]

            if side == "NO":
                current = 1 - current

            # Tighter stops for arb (10% stop, 15% profit)
            if side == "YES" and current < entry * 0.90:
                self.state.close_position(slug, current, "stop_loss")
            elif side == "NO" and current > entry * 1.10:
                self.state.close_position(slug, current, "stop_loss")
            elif side == "YES" and current > entry * 1.15:
                self.state.close_position(slug, current, "take_profit")
            elif side == "NO" and current < entry * 0.85:
                self.state.close_position(slug, current, "take_profit")
            else:
                entry_time = datetime.fromisoformat(pos["entry_time"])
                if datetime.now(timezone.utc) - entry_time > timedelta(days=5):
                    self.state.close_position(slug, current, "max_hold")

    def run_cycle(self) -> dict:
        logger.info("--- Arb Bot (D) Cycle ---")

        markets = self.scanner.get_active_markets(limit=200)
        self.check_exits(markets)

        # Find arbitrage opportunities
        sum_arbs = self._find_sum_arbs(markets)
        parent_arbs = self._find_parent_child_arbs(markets)
        all_arbs = sum_arbs + parent_arbs

        # Sort by edge
        all_arbs.sort(key=lambda x: x.get("edge", 0), reverse=True)

        new_trades = 0
        existing = set(self.state.state["positions"].keys())

        for arb in all_arbs:
            slug = arb["slug"]
            if slug in existing:
                continue
            if len(self.state.state["positions"]) >= 10:
                break

            confidence = arb.get("confidence", 0.5)
            if confidence < 0.6:
                continue

            entry_price = arb["entry_price"]
            if entry_price < 0.05 or entry_price > 0.95:
                continue

            size = min(MAX_POSITION_PCT, confidence * 0.04) * self.state.bankroll
            if size < 5:
                continue

            self.state.open_position(
                slug=slug,
                question=arb.get("question", slug)[:120],
                side=arb["side"],
                entry_price=entry_price,
                size_usdc=round(size, 2),
                signal_data={
                    "type": arb["type"],
                    "edge": arb.get("edge"),
                    "confidence": confidence,
                    "group_total": arb.get("group_total"),
                },
            )
            new_trades += 1

        self.state.state["stats"]["cycles"] += 1
        self.state.save()

        summary = self.state.get_summary()
        logger.info(
            f"[Arb Bot] {len(all_arbs)} arbs ({len(sum_arbs)} sum, {len(parent_arbs)} parent-child), "
            f"{new_trades} trades | ${summary['bankroll']:.0f} | P&L: ${summary['total_pnl']:+.2f}"
        )
        return {"arbs_found": len(all_arbs), "new_trades": new_trades, **summary}


# ---------------------------------------------------------------------------
# Multi-Bot Orchestrator
# ---------------------------------------------------------------------------

class MultiBotOrchestrator:
    """Runs all bots in parallel threads."""

    def __init__(self, bots: list = None):
        self.bots = bots or ["fast", "news", "arb"]
        self._threads = {}
        self._running = False

    def _run_fast_scanner(self):
        """Run Bot A: Fast Scanner."""
        from fast_scanner import FastScanner
        scanner = FastScanner(threshold=0.08, scan_interval=45, use_llm=True)
        scanner.run_loop()

    def _run_news_bot(self):
        """Run Bot C: News-Driven."""
        bot = NewsDrivenBot()
        while self._running:
            try:
                bot.run_cycle()
            except Exception as e:
                logger.error(f"News bot error: {e}", exc_info=True)
            try:
                time.sleep(bot.interval)
            except KeyboardInterrupt:
                break

    def _run_arb_bot(self):
        """Run Bot D: Cross-Market Arbitrage."""
        bot = CrossMarketArbBot()
        while self._running:
            try:
                bot.run_cycle()
            except Exception as e:
                logger.error(f"Arb bot error: {e}", exc_info=True)
            try:
                time.sleep(bot.interval)
            except KeyboardInterrupt:
                break

    def run_all(self):
        """Start all bots in threads."""
        self._running = True
        logger.info("Starting Multi-Bot Orchestrator...")

        bot_runners = {
            "fast": ("Bot A (Fast Scanner)", self._run_fast_scanner),
            "news": ("Bot C (News-Driven)", self._run_news_bot),
            "arb": ("Bot D (Cross-Market Arb)", self._run_arb_bot),
        }

        for key in self.bots:
            if key in bot_runners:
                name, func = bot_runners[key]
                t = threading.Thread(target=func, name=name, daemon=True)
                t.start()
                self._threads[key] = t
                logger.info(f"Started {name}")
                time.sleep(2)  # Stagger starts

        logger.info(f"All {len(self._threads)} bots running. Press Ctrl+C to stop.")
        logger.info("Note: Bot B (Edge Detector) runs separately via paper_trader.py")

        try:
            while self._running:
                time.sleep(60)
                # Log a combined status every minute
                alive = {k: t.is_alive() for k, t in self._threads.items()}
                dead = [k for k, v in alive.items() if not v]
                if dead:
                    logger.warning(f"Dead bots: {dead}")
        except KeyboardInterrupt:
            logger.info("Shutting down all bots...")
            self._running = False

    def run_single(self, bot_name: str):
        """Run a single bot."""
        self._running = True
        runners = {
            "fast": self._run_fast_scanner,
            "news": self._run_news_bot,
            "arb": self._run_arb_bot,
        }
        if bot_name in runners:
            logger.info(f"Starting {bot_name} bot...")
            try:
                runners[bot_name]()
            except KeyboardInterrupt:
                self._running = False
        else:
            print(f"Unknown bot: {bot_name}. Options: fast, news, arb")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_status():
    """Show status of all bots."""
    from fast_scanner import FastScannerState

    bot_states = [
        ("Bot A (Fast Scanner)", FastScannerState()),
        ("Bot B (Edge Detector)", None),  # Separate process
        ("Bot C (News-Driven)", BaseBotState("bot_c_news")),
        ("Bot D (Cross-Market Arb)", BaseBotState("bot_d_arb")),
    ]

    print(f"\n{'='*70}")
    print(f"  MULTI-BOT STATUS")
    print(f"{'='*70}")

    for name, state_obj in bot_states:
        if state_obj is None:
            # Bot B runs separately
            paper_state = DATA_DIR / "paper_trades.json"
            if paper_state.exists():
                try:
                    with open(paper_state) as f:
                        data = json.load(f)
                    br = data.get("bankroll", 0)
                    s = data.get("stats", {})
                    pnl = s.get("total_pnl", 0)
                    wins = s.get("wins", 0)
                    losses = s.get("losses", 0)
                    closed = wins + losses
                    wr = wins / max(1, closed)
                    print(f"\n  {name}:")
                    print(f"    Bankroll: ${br:,.2f} | P&L: ${pnl:+,.2f} | "
                          f"WR: {wr:.0%} ({wins}W/{losses}L) | [runs separately]")
                except Exception:
                    print(f"\n  {name}: [state file unreadable]")
            else:
                print(f"\n  {name}: [no state file]")
            continue

        s = state_obj.get_summary() if hasattr(state_obj, 'get_summary') else state_obj.state.get("stats", {})
        if isinstance(s, dict) and "bankroll" in s:
            print(f"\n  {name}:")
            print(f"    Bankroll: ${s['bankroll']:,.2f} | P&L: ${s.get('total_pnl', 0):+,.2f} | "
                  f"WR: {s.get('win_rate', 0):.0%} ({s.get('wins', 0)}W/{s.get('losses', 0)}L) | "
                  f"Open: {s.get('open_positions', 0)}")

    print(f"\n{'='*70}\n")


def main():
    parser = argparse.ArgumentParser(description="Multi-Bot Polymarket Trading")
    parser.add_argument("--run-all", action="store_true", help="Run all bots")
    parser.add_argument("--run", type=str, help="Run single bot: fast|news|arb")
    parser.add_argument("--status", action="store_true", help="Show all bot statuses")
    args = parser.parse_args()

    if args.status:
        cmd_status()
        return

    orch = MultiBotOrchestrator()

    if args.run_all:
        orch.run_all()
    elif args.run:
        orch.run_single(args.run)
    else:
        cmd_status()


if __name__ == "__main__":
    main()
