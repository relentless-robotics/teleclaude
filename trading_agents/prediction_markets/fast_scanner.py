#!/usr/bin/env python3
"""
High-Frequency Polymarket Scanner.

Inspired by the $1,430 -> $238K strategy: scan every 30-60 seconds for markets
where price deviates from estimated fair value by more than a threshold (default 8%).

Fair Value Estimation combines:
  1. Historical price average (7-day VWAP)
  2. Cross-market correlation (related markets imply bounds)
  3. Groq LLM quick assessment (<1s)
  4. Order book imbalance (bid/ask pressure)

Paper trading only - logs all trades to data/fast_scanner_trades.jsonl.

Usage:
    python -m trading_agents.prediction_markets.fast_scanner --run
    python -m trading_agents.prediction_markets.fast_scanner --run --threshold 0.10
    python -m trading_agents.prediction_markets.fast_scanner --status
"""

import argparse
import json
import logging
import math
import os
import sys
import time
import statistics
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger("fast_scanner")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

PRICE_HISTORY_DIR = DATA_DIR / "price_history"
PRICE_HISTORY_DIR.mkdir(exist_ok=True)

TRADES_FILE = DATA_DIR / "fast_scanner_trades.jsonl"
STATE_FILE = DATA_DIR / "fast_scanner_state.json"
FAIR_VALUE_CACHE = DATA_DIR / "fair_value_cache.json"

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

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_THRESHOLD = 0.08        # 8% deviation = opportunity
MIN_VOLUME = 100_000            # Minimum market volume (USD)
MAX_POSITIONS = 20              # Max simultaneous paper positions
DEFAULT_BANKROLL = 10_000.0     # Starting paper bankroll
MAX_POSITION_PCT = 0.05         # 5% max per trade
SCAN_INTERVAL = 45              # seconds between scans
LLM_CACHE_TTL = 300             # Cache LLM assessments for 5 minutes
STOP_LOSS_PCT = 0.15            # 15% stop loss (tighter for fast trades)
TAKE_PROFIT_PCT = 0.20          # 20% take profit
MAX_HOLD_HOURS = 48             # Auto-exit after 48 hours (fast strategy)

# Fair value weights
WEIGHT_VWAP = 0.30
WEIGHT_LLM = 0.35
WEIGHT_BOOK = 0.20
WEIGHT_CROSS = 0.15


# ---------------------------------------------------------------------------
# Groq LLM Fair Value Estimator
# ---------------------------------------------------------------------------

def groq_estimate_probability(question: str, current_price: float) -> Optional[float]:
    """
    Ask Groq LLM to estimate the true probability of an event.
    Returns float 0-1 or None if failed.
    """
    if not GROQ_API_KEY:
        return None

    import requests

    prompt = f"""You are a prediction market analyst. Estimate the TRUE probability of this event happening.

Event: "{question}"
Current market price: {current_price:.1%} (YES)

Consider:
- Base rates for similar events
- Current political/economic context (March 2026)
- Known information and recent developments
- Whether the market might be over/under-reacting

Respond in JSON: {{"probability": 0.XX, "confidence": "low|medium|high", "reasoning": "brief"}}"""

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
                "max_tokens": 200,
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
            timeout=10,
        )

        if resp.status_code == 429:
            logger.debug("Groq rate limited")
            return None

        resp.raise_for_status()
        result = json.loads(resp.json()["choices"][0]["message"]["content"])
        prob = float(result.get("probability", 0))
        if 0 < prob < 1:
            return prob
        return None
    except Exception as e:
        logger.debug(f"Groq estimate failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Fair Value Estimation Components
# ---------------------------------------------------------------------------

def compute_vwap(slug: str, hours: float = 168) -> Optional[float]:
    """
    Compute 7-day VWAP (Volume Weighted Average Price) from price history.
    Falls back to simple average if no volume data.
    """
    history_file = PRICE_HISTORY_DIR / f"{slug[:80]}.jsonl"
    if not history_file.exists():
        return None

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    prices = []
    volumes = []

    try:
        with open(history_file) as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    ts = datetime.fromisoformat(entry["t"])
                    if ts >= cutoff:
                        prices.append(entry["p"])
                        volumes.append(entry.get("v", 1))
                except Exception:
                    continue
    except Exception:
        return None

    if len(prices) < 3:
        return None

    # VWAP calculation
    total_vol = sum(volumes)
    if total_vol > 0:
        vwap = sum(p * v for p, v in zip(prices, volumes)) / total_vol
    else:
        vwap = statistics.mean(prices)

    return round(max(0.01, min(0.99, vwap)), 4)


def compute_book_imbalance(token_id: str, scanner: PolymarketScanner) -> Optional[float]:
    """
    Compute order book imbalance signal.
    Returns adjustment: positive means price should be higher, negative means lower.
    Range: roughly -0.10 to +0.10
    """
    try:
        book = scanner.get_orderbook(token_id)
        if not book:
            return None

        bids = book.get("bids", [])
        asks = book.get("asks", [])

        if not bids and not asks:
            return None

        # Sum bid and ask depth (top 5 levels)
        bid_depth = sum(float(b.get("size", 0)) for b in bids[:5])
        ask_depth = sum(float(a.get("size", 0)) for a in asks[:5])

        total = bid_depth + ask_depth
        if total < 10:  # Too thin
            return None

        # Imbalance: 0.5 = balanced, >0.5 = more bids (bullish), <0.5 = more asks (bearish)
        imbalance = bid_depth / total

        # Convert to price adjustment (-0.10 to +0.10)
        adjustment = (imbalance - 0.5) * 0.20
        return round(adjustment, 4)

    except Exception as e:
        logger.debug(f"Book imbalance failed for {token_id}: {e}")
        return None


def find_correlated_markets(
    question: str,
    slug: str,
    all_markets: list,
) -> Optional[float]:
    """
    Find markets correlated with this one and infer a fair value bound.
    E.g., "Trump wins Iowa" should be >= "Trump wins election" price.

    Returns an implied fair value or None.
    """
    q_lower = question.lower()

    # Extract key entities from the question
    key_terms = []
    for term in q_lower.split():
        if len(term) > 3 and term not in {"will", "does", "this", "that", "with", "from", "have", "been", "what", "when", "before", "after"}:
            key_terms.append(term)

    if not key_terms:
        return None

    # Find related markets
    related_prices = []
    for m in all_markets:
        m_slug = m.get("slug", "") or m.get("condition_id", "")
        if m_slug == slug:
            continue

        m_q = (m.get("question", "") or "").lower()
        # Count matching key terms
        matches = sum(1 for t in key_terms if t in m_q)

        if matches >= 2:  # At least 2 key terms match
            prices_raw = m.get("outcomePrices", "")
            if isinstance(prices_raw, str):
                try:
                    prices_raw = json.loads(prices_raw)
                except Exception:
                    continue
            if prices_raw and len(prices_raw) >= 1:
                try:
                    related_prices.append(float(prices_raw[0]))
                except (ValueError, TypeError):
                    continue

    if not related_prices:
        return None

    # Average of related market prices as a cross-market anchor
    return round(statistics.mean(related_prices), 4)


# ---------------------------------------------------------------------------
# Combined Fair Value Estimator
# ---------------------------------------------------------------------------

class FairValueEstimator:
    """Combines multiple signals into a single fair value estimate."""

    def __init__(self, scanner: PolymarketScanner):
        self.scanner = scanner
        self._llm_cache = {}  # {slug: (timestamp, value)}
        self._load_cache()

    def _load_cache(self):
        """Load persisted LLM cache."""
        if FAIR_VALUE_CACHE.exists():
            try:
                with open(FAIR_VALUE_CACHE) as f:
                    raw = json.load(f)
                # Only keep entries < TTL old
                now = time.time()
                self._llm_cache = {
                    k: (v[0], v[1])
                    for k, v in raw.items()
                    if now - v[0] < LLM_CACHE_TTL
                }
            except Exception:
                self._llm_cache = {}

    def _save_cache(self):
        """Persist LLM cache."""
        try:
            with open(FAIR_VALUE_CACHE, "w") as f:
                json.dump(self._llm_cache, f)
        except Exception:
            pass

    def get_llm_estimate(self, slug: str, question: str, current_price: float) -> Optional[float]:
        """Get LLM probability estimate with caching."""
        now = time.time()

        # Check cache
        if slug in self._llm_cache:
            cached_time, cached_val = self._llm_cache[slug]
            if now - cached_time < LLM_CACHE_TTL:
                return cached_val

        # Call Groq
        estimate = groq_estimate_probability(question, current_price)
        if estimate is not None:
            self._llm_cache[slug] = (now, estimate)
            self._save_cache()

        return estimate

    def estimate_fair_value(
        self,
        slug: str,
        question: str,
        current_price: float,
        yes_token: str,
        all_markets: list,
        use_llm: bool = True,
    ) -> dict:
        """
        Estimate fair value combining all signals.

        Returns:
            {
                "fair_value": float,
                "components": {
                    "vwap": float or None,
                    "llm": float or None,
                    "book_imbalance": float or None,
                    "cross_market": float or None,
                },
                "confidence": float (0-1),
                "deviation": float (current - fair_value),
                "deviation_pct": float,
            }
        """
        components = {}
        weights_used = {}
        total_weight = 0

        # 1. VWAP (7-day)
        vwap = compute_vwap(slug)
        components["vwap"] = vwap
        if vwap is not None:
            weights_used["vwap"] = (vwap, WEIGHT_VWAP)
            total_weight += WEIGHT_VWAP

        # 2. LLM estimate
        llm_est = None
        if use_llm:
            llm_est = self.get_llm_estimate(slug, question, current_price)
        components["llm"] = llm_est
        if llm_est is not None:
            weights_used["llm"] = (llm_est, WEIGHT_LLM)
            total_weight += WEIGHT_LLM

        # 3. Order book imbalance
        book_adj = None
        if yes_token:
            book_adj = compute_book_imbalance(yes_token, self.scanner)
        components["book_imbalance"] = book_adj

        # 4. Cross-market correlation
        cross = find_correlated_markets(question, slug, all_markets)
        components["cross_market"] = cross
        if cross is not None:
            weights_used["cross"] = (cross, WEIGHT_CROSS)
            total_weight += WEIGHT_CROSS

        # Combine weighted estimates
        num_signals = len(weights_used)
        if total_weight == 0 or num_signals == 0:
            # No signals at all - use current price as fair value (no edge)
            fair_value = current_price
            confidence = 0.0
        elif num_signals == 1 and "vwap" in weights_used:
            # VWAP-only: low confidence, prone to stale data artifacts
            fair_value = weights_used["vwap"][0]
            confidence = 0.15  # Very low - VWAP alone is unreliable
        else:
            fair_value = sum(val * w for val, w in weights_used.values()) / total_weight

            # Apply book imbalance as adjustment
            if book_adj is not None:
                fair_value += book_adj * WEIGHT_BOOK
                fair_value = max(0.01, min(0.99, fair_value))

            # Confidence based on how many signals agree
            confidence = min(1.0, total_weight / (WEIGHT_VWAP + WEIGHT_LLM + WEIGHT_CROSS))
            # Boost confidence if signals agree
            estimates = [v for v, _ in weights_used.values()]
            if len(estimates) >= 2:
                spread = max(estimates) - min(estimates)
                if spread < 0.05:
                    confidence = min(1.0, confidence + 0.2)  # Signals agree
                elif spread > 0.20:
                    confidence *= 0.5  # Signals disagree

        deviation = current_price - fair_value
        deviation_pct = abs(deviation) / max(fair_value, 0.01)

        return {
            "fair_value": round(fair_value, 4),
            "components": components,
            "confidence": round(confidence, 3),
            "deviation": round(deviation, 4),
            "deviation_pct": round(deviation_pct, 4),
        }


# ---------------------------------------------------------------------------
# Paper Trading State (separate from paper_trader.py)
# ---------------------------------------------------------------------------

class FastScannerState:
    """Paper trading state for the fast scanner (Bot A)."""

    def __init__(self):
        self.state = self._load()

    def _load(self) -> dict:
        if STATE_FILE.exists():
            try:
                with open(STATE_FILE) as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "bankroll": DEFAULT_BANKROLL,
            "initial_bankroll": DEFAULT_BANKROLL,
            "positions": {},
            "stats": {
                "total_trades": 0,
                "wins": 0,
                "losses": 0,
                "total_pnl": 0.0,
                "max_drawdown": 0.0,
                "peak_bankroll": DEFAULT_BANKROLL,
                "scans_completed": 0,
                "opportunities_found": 0,
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_scan": None,
        }

    def save(self):
        self.state["last_updated"] = datetime.now(timezone.utc).isoformat()
        with open(STATE_FILE, "w") as f:
            json.dump(self.state, f, indent=2, default=str)

    def log_trade(self, trade: dict):
        """Append trade to JSONL log."""
        trade["timestamp"] = datetime.now(timezone.utc).isoformat()
        with open(TRADES_FILE, "a") as f:
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

    def open_position(
        self,
        slug: str,
        question: str,
        side: str,
        entry_price: float,
        size_usdc: float,
        fair_value: float,
        deviation_pct: float,
        confidence: float,
        components: dict,
    ):
        """Open a paper position."""
        fee = TAKER_FEE * entry_price * (1 - entry_price) * size_usdc
        contracts = size_usdc / entry_price if entry_price > 0 else 0

        pos = {
            "slug": slug,
            "question": question[:120],
            "side": side,
            "entry_price": round(entry_price, 4),
            "fair_value": round(fair_value, 4),
            "deviation_pct": round(deviation_pct, 4),
            "confidence": round(confidence, 3),
            "size_usdc": round(size_usdc, 2),
            "contracts": round(contracts, 2),
            "entry_fee": round(fee, 4),
            "components": components,
            "entry_time": datetime.now(timezone.utc).isoformat(),
            "status": "open",
            "stop_loss": round(
                entry_price * (1 - STOP_LOSS_PCT) if side == "YES"
                else entry_price * (1 + STOP_LOSS_PCT), 4
            ),
            "take_profit": round(
                entry_price * (1 + TAKE_PROFIT_PCT) if side == "YES"
                else entry_price * (1 - TAKE_PROFIT_PCT), 4
            ),
        }

        self.state["positions"][slug] = pos
        self.bankroll = self.bankroll - size_usdc - fee
        self.state["stats"]["total_trades"] += 1

        self.log_trade({
            "action": "OPEN",
            "bot": "fast_scanner",
            "slug": slug,
            "side": side,
            "entry_price": entry_price,
            "fair_value": fair_value,
            "deviation_pct": deviation_pct,
            "confidence": confidence,
            "size_usdc": size_usdc,
            "contracts": contracts,
            "fee": fee,
        })
        self.save()

        logger.info(
            f"[OPEN] {side} {slug[:40]} @ {entry_price:.3f} "
            f"(FV={fair_value:.3f}, dev={deviation_pct:.1%}) ${size_usdc:.0f}"
        )

    def close_position(self, slug: str, exit_price: float, reason: str) -> Optional[dict]:
        """Close a paper position."""
        pos = self.state["positions"].get(slug)
        if not pos or pos["status"] != "open":
            return None

        side = pos["side"]
        entry_price = pos["entry_price"]
        contracts = pos["contracts"]
        size_usdc = pos["size_usdc"]

        # Both YES and NO use same formula: entry/exit are in same price space
        # (check_exits converts to NO space before calling close_position)
        raw_pnl = (exit_price - entry_price) * contracts

        exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts * exit_price)
        net_pnl = raw_pnl - pos["entry_fee"] - exit_fee

        self.bankroll = self.bankroll + size_usdc + net_pnl

        if net_pnl > 0:
            self.state["stats"]["wins"] += 1
        else:
            self.state["stats"]["losses"] += 1
        self.state["stats"]["total_pnl"] = round(
            self.state["stats"]["total_pnl"] + net_pnl, 4
        )

        result = {
            **pos,
            "exit_price": round(exit_price, 4),
            "exit_time": datetime.now(timezone.utc).isoformat(),
            "exit_fee": round(exit_fee, 4),
            "pnl": round(net_pnl, 4),
            "return_pct": round(net_pnl / size_usdc * 100, 2) if size_usdc > 0 else 0,
            "exit_reason": reason,
            "status": "closed",
        }

        self.log_trade({
            "action": "CLOSE",
            "bot": "fast_scanner",
            "slug": slug,
            "side": side,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "pnl": net_pnl,
            "return_pct": result["return_pct"],
            "reason": reason,
            "hold_minutes": round(
                (datetime.now(timezone.utc) - datetime.fromisoformat(pos["entry_time"]))
                .total_seconds() / 60, 1
            ),
        })

        del self.state["positions"][slug]
        self.save()

        logger.info(
            f"[CLOSE] {slug[:40]} @ {exit_price:.3f} | "
            f"P&L: ${net_pnl:+.2f} ({result['return_pct']:+.1f}%) | {reason}"
        )
        return result

    def get_summary(self) -> dict:
        stats = self.state["stats"]
        closed = stats["wins"] + stats["losses"]
        return {
            "bot": "fast_scanner",
            "bankroll": round(self.bankroll, 2),
            "initial_bankroll": self.state["initial_bankroll"],
            "return_pct": round(
                (self.bankroll - self.state["initial_bankroll"])
                / self.state["initial_bankroll"] * 100, 2
            ),
            "open_positions": len(self.state["positions"]),
            "total_trades": stats["total_trades"],
            "closed_trades": closed,
            "wins": stats["wins"],
            "losses": stats["losses"],
            "win_rate": round(stats["wins"] / max(1, closed), 3),
            "total_pnl": round(stats["total_pnl"], 2),
            "max_drawdown_pct": round(stats["max_drawdown"] * 100, 2),
            "scans_completed": stats["scans_completed"],
            "opportunities_found": stats["opportunities_found"],
        }


# ---------------------------------------------------------------------------
# Fast Scanner Engine
# ---------------------------------------------------------------------------

class FastScanner:
    """
    High-frequency Polymarket scanner.
    Scans top markets every 30-60s for deviation from fair value.
    """

    def __init__(
        self,
        threshold: float = DEFAULT_THRESHOLD,
        scan_interval: int = SCAN_INTERVAL,
        use_llm: bool = True,
        max_positions: int = MAX_POSITIONS,
    ):
        self.threshold = threshold
        self.scan_interval = scan_interval
        self.use_llm = use_llm
        self.max_positions = max_positions

        self.scanner = PolymarketScanner()
        self.estimator = FairValueEstimator(self.scanner)
        self.state = FastScannerState()

        # Track scan timing for rate limiting
        self._last_llm_call = 0
        self._llm_calls_this_minute = 0

    def _parse_market_price(self, market: dict) -> Optional[float]:
        """Extract YES price from market data."""
        prices_raw = market.get("outcomePrices", "")
        if isinstance(prices_raw, str):
            try:
                prices_raw = json.loads(prices_raw)
            except Exception:
                return None
        if prices_raw and len(prices_raw) >= 1:
            try:
                return float(prices_raw[0])
            except (ValueError, TypeError):
                return None
        return None

    def _get_token_ids(self, market: dict) -> tuple:
        """Extract YES and NO token IDs from market."""
        tokens = market.get("clobTokenIds", "")
        if isinstance(tokens, str):
            try:
                tokens = json.loads(tokens)
            except Exception:
                return ("", "")
        if tokens and len(tokens) >= 2:
            return (str(tokens[0]), str(tokens[1]))
        elif tokens and len(tokens) == 1:
            return (str(tokens[0]), "")
        return ("", "")

    def _get_volume(self, market: dict) -> float:
        """Get market volume."""
        vol = market.get("volumeNum") or market.get("volume", 0)
        try:
            return float(vol)
        except (ValueError, TypeError):
            return 0

    def _should_use_llm(self) -> bool:
        """Rate limit LLM calls to avoid Groq limits (30/min)."""
        now = time.time()
        if now - self._last_llm_call > 60:
            self._llm_calls_this_minute = 0

        if self._llm_calls_this_minute >= 20:  # Stay under 30/min limit
            return False

        return self.use_llm

    def _kelly_size(self, deviation_pct: float, confidence: float, price: float) -> float:
        """
        Position sizing based on deviation and confidence.
        Larger deviations + higher confidence = bigger positions.
        """
        if deviation_pct <= 0 or confidence <= 0 or price <= 0 or price >= 1:
            return 0

        # Edge estimate = deviation * confidence
        edge = deviation_pct * confidence

        odds = (1 / price) - 1
        if odds <= 0:
            return 0

        kelly = edge / odds
        half_kelly = kelly * 0.5

        size = min(half_kelly, MAX_POSITION_PCT) * self.state.bankroll
        return max(0, round(size, 2))

    def check_exits(self):
        """Check all open positions for stop-loss, take-profit, or time exit."""
        for slug, pos in list(self.state.state["positions"].items()):
            if pos["status"] != "open":
                continue

            # Get current price from CLOB midpoint or history
            current_price = None
            yes_token = pos.get("yes_token", "")

            # Try to load from recent price history
            history_file = PRICE_HISTORY_DIR / f"{slug[:80]}.jsonl"
            if history_file.exists():
                try:
                    with open(history_file) as f:
                        lines = f.readlines()
                    if lines:
                        last = json.loads(lines[-1].strip())
                        # Only use if < 5 min old
                        ts = datetime.fromisoformat(last["t"])
                        if datetime.now(timezone.utc) - ts < timedelta(minutes=5):
                            current_price = last["p"]
                except Exception:
                    pass

            if current_price is None:
                continue

            side = pos["side"]
            if side == "NO":
                current_price = 1 - current_price

            # Stop-loss
            if side == "YES" and current_price <= pos["stop_loss"]:
                self.state.close_position(slug, current_price, "stop_loss")
                continue
            elif side == "NO" and current_price >= pos["stop_loss"]:
                self.state.close_position(slug, current_price, "stop_loss")
                continue

            # Take-profit
            if side == "YES" and current_price >= pos["take_profit"]:
                self.state.close_position(slug, current_price, "take_profit")
                continue
            elif side == "NO" and current_price <= pos["take_profit"]:
                self.state.close_position(slug, current_price, "take_profit")
                continue

            # Max hold time
            entry_time = datetime.fromisoformat(pos["entry_time"])
            if datetime.now(timezone.utc) - entry_time > timedelta(hours=MAX_HOLD_HOURS):
                self.state.close_position(slug, current_price, "max_hold_time")

            # Mean reversion exit: if price has reverted to fair value
            fair_value = pos.get("fair_value", pos["entry_price"])
            if side == "YES" and current_price >= fair_value * 0.98:
                self.state.close_position(slug, current_price, "fair_value_reversion")
            elif side == "NO" and current_price <= fair_value * 1.02:
                self.state.close_position(slug, current_price, "fair_value_reversion")

    def scan_cycle(self) -> dict:
        """
        Run one scan cycle:
        1. Fetch top markets
        2. Estimate fair values
        3. Find deviations > threshold
        4. Paper trade opportunities
        """
        cycle_start = time.time()
        logger.info(f"--- Fast Scan Cycle (threshold={self.threshold:.0%}) ---")

        # Check exits first
        self.check_exits()

        # Fetch active markets (top 200 by volume)
        try:
            markets = self.scanner.get_active_markets(limit=200, order="volumeNum")
        except Exception as e:
            logger.error(f"Failed to fetch markets: {e}")
            return {"error": str(e)}

        logger.info(f"Fetched {len(markets)} markets")

        opportunities = []
        existing_slugs = set(self.state.state["positions"].keys())
        llm_used = 0

        for market in markets:
            slug = market.get("slug") or market.get("condition_id", "")
            if not slug:
                continue

            # Skip markets we already have positions in
            if slug in existing_slugs:
                continue

            question = market.get("question", "")
            yes_price = self._parse_market_price(market)
            volume = self._get_volume(market)
            yes_token, no_token = self._get_token_ids(market)

            if yes_price is None:
                continue

            # Filter: tradeable range and volume
            if yes_price < 0.05 or yes_price > 0.95:
                continue
            if volume < MIN_VOLUME:
                continue

            # Decide whether to use LLM for this market
            use_llm_here = self._should_use_llm() and llm_used < 10  # Max 10 LLM calls per cycle

            # Estimate fair value
            fv_result = self.estimator.estimate_fair_value(
                slug=slug,
                question=question,
                current_price=yes_price,
                yes_token=yes_token,
                all_markets=markets,
                use_llm=use_llm_here,
            )

            if use_llm_here and fv_result["components"].get("llm") is not None:
                llm_used += 1
                self._llm_calls_this_minute += 1
                self._last_llm_call = time.time()

            # Check deviation
            deviation_pct = fv_result["deviation_pct"]
            confidence = fv_result["confidence"]

            if deviation_pct >= self.threshold and confidence > 0.4:
                # Determine direction
                deviation = fv_result["deviation"]
                if deviation < 0:
                    # Current price < fair value -> buy YES
                    side = "YES"
                    entry_price = yes_price
                else:
                    # Current price > fair value -> buy NO
                    side = "NO"
                    entry_price = 1 - yes_price

                opportunities.append({
                    "slug": slug,
                    "question": question,
                    "side": side,
                    "current_price": yes_price,
                    "entry_price": entry_price,
                    "fair_value": fv_result["fair_value"],
                    "deviation_pct": deviation_pct,
                    "confidence": confidence,
                    "components": fv_result["components"],
                    "volume": volume,
                    "yes_token": yes_token,
                    "no_token": no_token,
                })

        # Sort by deviation * confidence (best opportunities first)
        opportunities.sort(
            key=lambda x: x["deviation_pct"] * x["confidence"],
            reverse=True,
        )

        # Execute paper trades
        new_trades = 0
        for opp in opportunities:
            if len(self.state.state["positions"]) >= self.max_positions:
                break

            if self.state.bankroll < 50:  # Minimum bankroll
                break

            # Position sizing
            size = self._kelly_size(
                opp["deviation_pct"],
                opp["confidence"],
                opp["entry_price"],
            )

            if size < 5:  # Minimum $5
                continue

            self.state.open_position(
                slug=opp["slug"],
                question=opp["question"],
                side=opp["side"],
                entry_price=opp["entry_price"],
                size_usdc=size,
                fair_value=opp["fair_value"],
                deviation_pct=opp["deviation_pct"],
                confidence=opp["confidence"],
                components=opp["components"],
            )
            new_trades += 1

        # Update stats
        self.state.state["stats"]["scans_completed"] += 1
        self.state.state["stats"]["opportunities_found"] += len(opportunities)
        self.state.state["last_scan"] = datetime.now(timezone.utc).isoformat()
        self.state.save()

        elapsed = time.time() - cycle_start

        summary = self.state.get_summary()
        logger.info(
            f"Scan complete in {elapsed:.1f}s | "
            f"{len(opportunities)} opps found, {new_trades} traded | "
            f"Bankroll: ${summary['bankroll']:.0f} | "
            f"P&L: ${summary['total_pnl']:+.2f} | "
            f"WR: {summary['win_rate']:.0%} ({summary['wins']}W/{summary['losses']}L)"
        )

        return {
            "scan_time_sec": round(elapsed, 1),
            "markets_scanned": len(markets),
            "opportunities": len(opportunities),
            "new_trades": new_trades,
            "top_opportunities": [
                {
                    "slug": o["slug"][:40],
                    "side": o["side"],
                    "price": o["current_price"],
                    "fair_value": o["fair_value"],
                    "deviation": f"{o['deviation_pct']:.1%}",
                    "confidence": o["confidence"],
                }
                for o in opportunities[:5]
            ],
            **summary,
        }

    def run_loop(self):
        """Continuous scanning loop."""
        logger.info(
            f"Fast Scanner starting | Threshold: {self.threshold:.0%} | "
            f"Interval: {self.scan_interval}s | LLM: {self.use_llm} | "
            f"Bankroll: ${self.state.bankroll:.0f}"
        )

        cycle = 0
        while True:
            cycle += 1
            try:
                result = self.scan_cycle()

                # Log periodic summary every 10 cycles
                if cycle % 10 == 0:
                    summary = self.state.get_summary()
                    logger.info(
                        f"=== Cycle {cycle} Summary === "
                        f"Bankroll: ${summary['bankroll']:.0f} | "
                        f"Return: {summary['return_pct']:+.2f}% | "
                        f"Trades: {summary['total_trades']} | "
                        f"Scans: {summary['scans_completed']}"
                    )
            except KeyboardInterrupt:
                logger.info("Fast scanner stopped by user")
                break
            except Exception as e:
                logger.error(f"Scan cycle {cycle} error: {e}", exc_info=True)

            # Dynamic interval: faster when more opportunities found
            interval = self.scan_interval
            try:
                time.sleep(interval)
            except KeyboardInterrupt:
                logger.info("Fast scanner stopped by user")
                break


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_status():
    """Show fast scanner status."""
    state = FastScannerState()
    s = state.get_summary()

    print(f"\n{'='*60}")
    print(f"  FAST SCANNER (Bot A) - STATUS")
    print(f"{'='*60}")
    print(f"  Bankroll:     ${s['bankroll']:,.2f} (started: ${s['initial_bankroll']:,.0f})")
    print(f"  Return:       {s['return_pct']:+.2f}%")
    print(f"  Total P&L:    ${s['total_pnl']:+,.2f}")
    print(f"  Max Drawdown: {s['max_drawdown_pct']:.2f}%")
    print(f"  Open:         {s['open_positions']} positions")
    print(f"  Trades:       {s['total_trades']} ({s['wins']}W / {s['losses']}L)")
    print(f"  Win Rate:     {s['win_rate']:.0%}")
    print(f"  Scans:        {s['scans_completed']} ({s['opportunities_found']} opportunities)")
    print(f"  Last Scan:    {state.state.get('last_scan', 'never')}")

    if state.state["positions"]:
        print(f"\n  OPEN POSITIONS:")
        print(f"  {'Slug':<35} {'Side':<5} {'Entry':<7} {'FV':<7} {'Dev':<7} {'Size'}")
        print(f"  {'-'*75}")
        for slug, pos in state.state["positions"].items():
            if pos["status"] == "open":
                print(
                    f"  {slug[:34]:<35} {pos['side']:<5} "
                    f"{pos['entry_price']:.3f}  {pos.get('fair_value', 0):.3f}  "
                    f"{pos.get('deviation_pct', 0):.1%}  ${pos['size_usdc']:.0f}"
                )

    print(f"{'='*60}\n")


def main():
    parser = argparse.ArgumentParser(description="High-Frequency Polymarket Scanner")
    parser.add_argument("--run", action="store_true", help="Run one scan cycle")
    parser.add_argument("--loop", action="store_true", help="Run continuous scan loop")
    parser.add_argument("--status", action="store_true", help="Show status")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                        help=f"Deviation threshold (default {DEFAULT_THRESHOLD})")
    parser.add_argument("--interval", type=int, default=SCAN_INTERVAL,
                        help=f"Scan interval in seconds (default {SCAN_INTERVAL})")
    parser.add_argument("--no-llm", action="store_true", help="Disable LLM estimates")
    parser.add_argument("--max-positions", type=int, default=MAX_POSITIONS)
    parser.add_argument("--reset", action="store_true", help="Reset state")
    args = parser.parse_args()

    if args.status:
        cmd_status()
        return

    if args.reset:
        if STATE_FILE.exists():
            STATE_FILE.unlink()
        print("Fast scanner state reset.")
        return

    scanner = FastScanner(
        threshold=args.threshold,
        scan_interval=args.interval,
        use_llm=not args.no_llm,
        max_positions=args.max_positions,
    )

    if args.loop:
        scanner.run_loop()
    else:
        result = scanner.scan_cycle()
        print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
