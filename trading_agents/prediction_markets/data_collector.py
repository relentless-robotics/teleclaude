#!/usr/bin/env python3
"""
Deep Data Collector for Polymarket prediction markets.

Collects order book snapshots, trades, price history, and market metadata
from the Polymarket CLOB API. Provides analytics functions for the
trade_learner and edge_detector.

Data stored in:
    data/market_data/orderbooks/{slug}_ob.jsonl
    data/market_data/trades/{slug}_trades.jsonl
    data/market_data/prices/{slug}_prices.jsonl
    data/market_data/metadata/markets.json

Usage:
    python -m trading_agents.prediction_markets.data_collector --run
    python -m trading_agents.prediction_markets.data_collector --once
    python -m trading_agents.prediction_markets.data_collector --stats SLUG
    python -m trading_agents.prediction_markets.data_collector --interval 900
"""

import argparse
import json
import logging
import os
import sys
import time
import statistics
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import requests

logger = logging.getLogger("data_collector")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

MARKET_DATA_DIR = DATA_DIR / "market_data"
MARKET_DATA_DIR.mkdir(exist_ok=True)

OB_DIR = MARKET_DATA_DIR / "orderbooks"
OB_DIR.mkdir(exist_ok=True)

TRADES_DIR = MARKET_DATA_DIR / "trades"
TRADES_DIR.mkdir(exist_ok=True)

PRICES_DIR = MARKET_DATA_DIR / "prices"
PRICES_DIR.mkdir(exist_ok=True)

META_DIR = MARKET_DATA_DIR / "metadata"
META_DIR.mkdir(exist_ok=True)

MARKETS_CACHE = META_DIR / "markets.json"

# API endpoints
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

# Rate limiting
MIN_REQUEST_INTERVAL = 0.12  # ~8 req/s to stay under 10/s limit
_last_request_time = 0.0

# Default collection interval
DEFAULT_INTERVAL = 900  # 15 minutes


def _safe_filename(slug: str) -> str:
    """Convert slug to safe filename (truncate, remove bad chars)."""
    safe = slug[:80].replace("/", "_").replace("\\", "_")
    return safe


def _rate_limited_get(url: str, params: dict = None, retries: int = 3) -> dict:
    """HTTP GET with rate limiting and retry."""
    global _last_request_time

    elapsed = time.monotonic() - _last_request_time
    if elapsed < MIN_REQUEST_INTERVAL:
        time.sleep(MIN_REQUEST_INTERVAL - elapsed)
    _last_request_time = time.monotonic()

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }

    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt < retries - 1:
                backoff = min(30, (2 ** attempt) + 0.5)
                logger.debug(f"Retry {attempt+1}/{retries}: {e} (backoff {backoff:.1f}s)")
                time.sleep(backoff)
            else:
                logger.warning(f"GET failed after {retries} attempts: {url} - {e}")
                return {}
    return {}


# ---------------------------------------------------------------------------
# Market Metadata
# ---------------------------------------------------------------------------

def load_markets_cache() -> dict:
    """Load cached market metadata."""
    if MARKETS_CACHE.exists():
        try:
            with open(MARKETS_CACHE) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_markets_cache(cache: dict):
    """Save market metadata cache."""
    with open(MARKETS_CACHE, "w") as f:
        json.dump(cache, f, indent=2, default=str)


def get_monitored_slugs() -> list:
    """
    Get list of slugs the paper trader is monitoring.
    Reads from paper_trades.json (open positions) and edge_detector_results.json.
    """
    slugs = set()

    # Open positions
    paper_file = DATA_DIR / "paper_trades.json"
    if paper_file.exists():
        try:
            with open(paper_file) as f:
                state = json.load(f)
            for slug in state.get("positions", {}):
                slugs.add(slug)
        except Exception:
            pass

    # Recent edge detector results
    edge_file = DATA_DIR / "edge_detector_results.json"
    if edge_file.exists():
        try:
            with open(edge_file) as f:
                results = json.load(f)
            for opp in results.get("opportunities", []):
                slug = opp.get("slug", "")
                if slug:
                    slugs.add(slug)
        except Exception:
            pass

    return list(slugs)


# ---------------------------------------------------------------------------
# Data Collection Functions
# ---------------------------------------------------------------------------

def collect_orderbook(token_id: str, slug: str) -> dict:
    """
    Collect order book snapshot (top 10 levels bid/ask).
    Returns the orderbook dict and saves to JSONL.
    """
    data = _rate_limited_get(f"{CLOB_API}/book", params={"token_id": token_id})
    if not data:
        return {}

    bids = data.get("bids", [])
    asks = data.get("asks", [])

    # Keep top 10 levels
    top_bids = sorted(bids, key=lambda x: float(x.get("price", 0)), reverse=True)[:10]
    top_asks = sorted(asks, key=lambda x: float(x.get("price", 0)))[:10]

    snapshot = {
        "t": datetime.now(timezone.utc).isoformat(),
        "token_id": token_id,
        "bids": [{"p": float(b.get("price", 0)), "s": float(b.get("size", 0))} for b in top_bids],
        "asks": [{"p": float(a.get("price", 0)), "s": float(a.get("size", 0))} for a in top_asks],
        "bid_depth": sum(float(b.get("size", 0)) for b in bids),
        "ask_depth": sum(float(a.get("size", 0)) for a in asks),
    }

    fname = _safe_filename(slug)
    ob_file = OB_DIR / f"{fname}_ob.jsonl"
    with open(ob_file, "a") as f:
        f.write(json.dumps(snapshot) + "\n")

    return snapshot


def collect_trades(token_id: str, slug: str) -> list:
    """
    Collect recent trades for a market.
    CLOB API: GET /trades?token_id=...
    """
    data = _rate_limited_get(
        f"{CLOB_API}/trades",
        params={"token_id": token_id, "limit": 100},
    )

    if not data or not isinstance(data, list):
        # Try alternate format
        if isinstance(data, dict):
            data = data.get("trades", data.get("data", []))
        if not isinstance(data, list):
            return []

    fname = _safe_filename(slug)
    trades_file = TRADES_DIR / f"{fname}_trades.jsonl"

    # Load existing trade IDs to avoid duplicates
    existing_ids = set()
    if trades_file.exists():
        try:
            with open(trades_file) as f:
                for line in f:
                    try:
                        rec = json.loads(line.strip())
                        tid = rec.get("id", rec.get("trade_id", ""))
                        if tid:
                            existing_ids.add(tid)
                    except Exception:
                        continue
        except Exception:
            pass

    new_trades = []
    for trade in data:
        tid = trade.get("id", trade.get("trade_id", ""))
        if tid and tid in existing_ids:
            continue

        record = {
            "t": trade.get("created_at", trade.get("timestamp", datetime.now(timezone.utc).isoformat())),
            "id": tid,
            "price": float(trade.get("price", 0)),
            "size": float(trade.get("size", trade.get("amount", 0))),
            "side": trade.get("side", trade.get("maker_side", "")),
            "token_id": token_id,
        }
        new_trades.append(record)

    if new_trades:
        with open(trades_file, "a") as f:
            for rec in new_trades:
                f.write(json.dumps(rec) + "\n")

    return new_trades


def collect_price_snapshot(token_id: str, slug: str) -> dict:
    """Collect current midpoint price and save to price history."""
    data = _rate_limited_get(f"{CLOB_API}/midpoint", params={"token_id": token_id})
    mid = data.get("mid")
    if mid is None:
        return {}

    snapshot = {
        "t": datetime.now(timezone.utc).isoformat(),
        "price": float(mid),
        "token_id": token_id,
    }

    fname = _safe_filename(slug)
    price_file = PRICES_DIR / f"{fname}_prices.jsonl"
    with open(price_file, "a") as f:
        f.write(json.dumps(snapshot) + "\n")

    return snapshot


def collect_market_metadata(slug: str) -> dict:
    """
    Fetch market metadata from Gamma API.
    Returns market info including volume, liquidity, expiry, category.
    """
    data = _rate_limited_get(
        f"{GAMMA_API}/markets",
        params={"slug": slug, "limit": 1},
    )

    if isinstance(data, list) and data:
        market = data[0]
    elif isinstance(data, dict):
        market = data
    else:
        return {}

    # Extract useful fields
    meta = {
        "slug": slug,
        "question": market.get("question", ""),
        "description": market.get("description", "")[:500],
        "volume": float(market.get("volumeNum", market.get("volume", 0)) or 0),
        "liquidity": float(market.get("liquidityNum", market.get("liquidity", 0)) or 0),
        "end_date": market.get("endDate", market.get("end_date_iso", "")),
        "active": market.get("active", True),
        "closed": market.get("closed", False),
        "neg_risk": market.get("negRisk", False),
        "tokens": [],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Extract token IDs
    tokens_raw = market.get("tokens", market.get("clobTokenIds", ""))
    if isinstance(tokens_raw, list):
        for tok in tokens_raw:
            if isinstance(tok, dict):
                meta["tokens"].append({
                    "token_id": tok.get("token_id", ""),
                    "outcome": tok.get("outcome", ""),
                    "price": float(tok.get("price", 0)),
                })
            elif isinstance(tok, str):
                meta["tokens"].append({"token_id": tok, "outcome": "", "price": 0})
    elif isinstance(tokens_raw, str) and tokens_raw:
        # Comma-separated token IDs
        for tid in tokens_raw.split(","):
            tid = tid.strip().strip("[]\"'")
            if tid:
                meta["tokens"].append({"token_id": tid, "outcome": "", "price": 0})

    return meta


# ---------------------------------------------------------------------------
# Analytics Functions (used by trade_learner and edge_detector)
# ---------------------------------------------------------------------------

def get_volume_24h(slug: str) -> float:
    """
    Get 24-hour trading volume for a market.
    Uses collected trade data or falls back to metadata cache.
    """
    fname = _safe_filename(slug)
    trades_file = TRADES_DIR / f"{fname}_trades.jsonl"

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    total_volume = 0.0

    if trades_file.exists():
        try:
            with open(trades_file) as f:
                for line in f:
                    try:
                        rec = json.loads(line.strip())
                        ts = datetime.fromisoformat(rec["t"].replace("Z", "+00:00"))
                        if ts >= cutoff:
                            total_volume += float(rec.get("size", 0)) * float(rec.get("price", 1))
                    except Exception:
                        continue
        except Exception:
            pass

    if total_volume > 0:
        return round(total_volume, 2)

    # Fallback to metadata cache
    cache = load_markets_cache()
    if slug in cache:
        return float(cache[slug].get("volume", 0))

    return 0.0


def get_price_volatility(slug: str, hours: int = 24) -> float:
    """
    Get price volatility (standard deviation of prices) over N hours.
    Returns 0 if insufficient data.
    """
    fname = _safe_filename(slug)
    price_file = PRICES_DIR / f"{fname}_prices.jsonl"

    if not price_file.exists():
        return 0.0

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    prices = []

    try:
        with open(price_file) as f:
            for line in f:
                try:
                    rec = json.loads(line.strip())
                    ts = datetime.fromisoformat(rec["t"].replace("Z", "+00:00"))
                    if ts >= cutoff:
                        prices.append(float(rec["price"]))
                except Exception:
                    continue
    except Exception:
        return 0.0

    if len(prices) < 2:
        return 0.0

    return round(statistics.stdev(prices), 6)


def get_book_depth(slug: str) -> float:
    """
    Get total order book depth (bid + ask liquidity in contracts).
    Uses most recent orderbook snapshot.
    """
    fname = _safe_filename(slug)
    ob_file = OB_DIR / f"{fname}_ob.jsonl"

    if not ob_file.exists():
        return 0.0

    # Read last line
    last_line = ""
    try:
        with open(ob_file) as f:
            for line in f:
                last_line = line
    except Exception:
        return 0.0

    if not last_line:
        return 0.0

    try:
        snapshot = json.loads(last_line.strip())
        return float(snapshot.get("bid_depth", 0)) + float(snapshot.get("ask_depth", 0))
    except Exception:
        return 0.0


def get_smart_money_signal(slug: str) -> dict:
    """
    Detect potential smart money activity:
    1. Large trades (> 3x average size)
    2. Sudden book depth changes (> 50% change between snapshots)
    3. Rapid price movement on low volume

    Returns dict with signals and confidence.
    """
    fname = _safe_filename(slug)
    signals = {
        "large_trades": False,
        "book_shift": False,
        "price_spike": False,
        "confidence": 0.0,
        "details": [],
    }

    # Check for large trades in last 2 hours
    trades_file = TRADES_DIR / f"{fname}_trades.jsonl"
    if trades_file.exists():
        cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
        recent_trades = []
        all_sizes = []

        try:
            with open(trades_file) as f:
                for line in f:
                    try:
                        rec = json.loads(line.strip())
                        size = float(rec.get("size", 0))
                        all_sizes.append(size)
                        ts = datetime.fromisoformat(rec["t"].replace("Z", "+00:00"))
                        if ts >= cutoff:
                            recent_trades.append(rec)
                    except Exception:
                        continue
        except Exception:
            pass

        if all_sizes and recent_trades:
            avg_size = statistics.mean(all_sizes)
            large = [t for t in recent_trades if float(t.get("size", 0)) > avg_size * 3]
            if large:
                signals["large_trades"] = True
                signals["details"].append(
                    f"{len(large)} large trades (>{avg_size*3:.0f} contracts) in last 2h"
                )

    # Check for book depth changes
    ob_file = OB_DIR / f"{fname}_ob.jsonl"
    if ob_file.exists():
        snapshots = []
        try:
            with open(ob_file) as f:
                for line in f:
                    try:
                        snapshots.append(json.loads(line.strip()))
                    except Exception:
                        continue
        except Exception:
            pass

        if len(snapshots) >= 2:
            prev = snapshots[-2]
            curr = snapshots[-1]
            prev_depth = float(prev.get("bid_depth", 0)) + float(prev.get("ask_depth", 0))
            curr_depth = float(curr.get("bid_depth", 0)) + float(curr.get("ask_depth", 0))

            if prev_depth > 0:
                change = abs(curr_depth - prev_depth) / prev_depth
                if change > 0.5:
                    signals["book_shift"] = True
                    direction = "added" if curr_depth > prev_depth else "pulled"
                    signals["details"].append(
                        f"Book depth {direction} {change:.0%} ({prev_depth:.0f} -> {curr_depth:.0f})"
                    )

    # Check for price spikes
    price_file = PRICES_DIR / f"{fname}_prices.jsonl"
    if price_file.exists():
        cutoff_1h = datetime.now(timezone.utc) - timedelta(hours=1)
        cutoff_4h = datetime.now(timezone.utc) - timedelta(hours=4)
        recent_prices = []
        older_prices = []

        try:
            with open(price_file) as f:
                for line in f:
                    try:
                        rec = json.loads(line.strip())
                        ts = datetime.fromisoformat(rec["t"].replace("Z", "+00:00"))
                        price = float(rec["price"])
                        if ts >= cutoff_1h:
                            recent_prices.append(price)
                        elif ts >= cutoff_4h:
                            older_prices.append(price)
                    except Exception:
                        continue
        except Exception:
            pass

        if recent_prices and older_prices:
            recent_avg = statistics.mean(recent_prices)
            older_avg = statistics.mean(older_prices)
            if older_avg > 0:
                price_change = abs(recent_avg - older_avg) / older_avg
                if price_change > 0.05:  # 5%+ price move
                    signals["price_spike"] = True
                    direction = "up" if recent_avg > older_avg else "down"
                    signals["details"].append(
                        f"Price moved {direction} {price_change:.1%} in last 1h vs 4h avg"
                    )

    # Calculate confidence
    signal_count = sum([signals["large_trades"], signals["book_shift"], signals["price_spike"]])
    signals["confidence"] = round(signal_count / 3.0, 2)

    return signals


# ---------------------------------------------------------------------------
# Data Collector Engine
# ---------------------------------------------------------------------------

class DataCollector:
    """Continuous data collection engine for monitored markets."""

    def __init__(self, interval: int = DEFAULT_INTERVAL):
        self.interval = interval
        self.markets_cache = load_markets_cache()

    def _get_token_ids_for_slug(self, slug: str) -> list:
        """Get token IDs for a slug from cache or API."""
        if slug in self.markets_cache:
            tokens = self.markets_cache[slug].get("tokens", [])
            if tokens:
                return [t["token_id"] for t in tokens if t.get("token_id")]

        # Fetch metadata
        meta = collect_market_metadata(slug)
        if meta:
            self.markets_cache[slug] = meta
            save_markets_cache(self.markets_cache)
            return [t["token_id"] for t in meta.get("tokens", []) if t.get("token_id")]

        # Try from paper trades
        paper_file = DATA_DIR / "paper_trades.json"
        if paper_file.exists():
            try:
                with open(paper_file) as f:
                    state = json.load(f)
                pos = state.get("positions", {}).get(slug, {})
                tid = pos.get("token_id", "")
                if tid:
                    return [tid]
            except Exception:
                pass

        return []

    def collect_one(self, slug: str) -> dict:
        """Collect all data for a single market."""
        token_ids = self._get_token_ids_for_slug(slug)
        if not token_ids:
            logger.warning(f"No token IDs for {slug}, skipping")
            return {"slug": slug, "error": "no_token_ids"}

        result = {"slug": slug, "collected": []}

        for token_id in token_ids:
            # Order book
            try:
                ob = collect_orderbook(token_id, slug)
                if ob:
                    result["collected"].append("orderbook")
            except Exception as e:
                logger.debug(f"Orderbook failed for {slug}: {e}")

            # Trades
            try:
                trades = collect_trades(token_id, slug)
                result["collected"].append(f"trades({len(trades)} new)")
            except Exception as e:
                logger.debug(f"Trades failed for {slug}: {e}")

            # Price
            try:
                price = collect_price_snapshot(token_id, slug)
                if price:
                    result["collected"].append(f"price({price.get('price', '?')})")
            except Exception as e:
                logger.debug(f"Price failed for {slug}: {e}")

        # Metadata (less frequent - only if not cached recently)
        meta = self.markets_cache.get(slug, {})
        last_update = meta.get("updated_at", "")
        needs_meta = True
        if last_update:
            try:
                last_dt = datetime.fromisoformat(last_update.replace("Z", "+00:00"))
                if datetime.now(timezone.utc) - last_dt < timedelta(hours=6):
                    needs_meta = False
            except Exception:
                pass

        if needs_meta:
            try:
                new_meta = collect_market_metadata(slug)
                if new_meta:
                    self.markets_cache[slug] = new_meta
                    result["collected"].append("metadata")
            except Exception as e:
                logger.debug(f"Metadata failed for {slug}: {e}")

        return result

    def collect_all(self) -> dict:
        """Collect data for all monitored markets."""
        slugs = get_monitored_slugs()
        if not slugs:
            logger.info("No monitored markets found")
            return {"markets": 0, "results": []}

        logger.info(f"Collecting data for {len(slugs)} markets...")
        results = []

        for slug in slugs:
            try:
                result = self.collect_one(slug)
                results.append(result)
                logger.info(f"  {slug}: {', '.join(result.get('collected', ['nothing']))}")
            except Exception as e:
                logger.error(f"  {slug}: ERROR - {e}")
                results.append({"slug": slug, "error": str(e)})

        # Save updated cache
        save_markets_cache(self.markets_cache)

        summary = {
            "markets": len(slugs),
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "results": results,
        }

        logger.info(f"Collection complete: {len(results)}/{len(slugs)} markets")
        return summary

    def run_loop(self):
        """Continuous collection loop."""
        logger.info(f"Data collector starting (interval: {self.interval}s)")
        cycle = 0

        while True:
            cycle += 1
            logger.info(f"--- Collection Cycle {cycle} ---")

            try:
                summary = self.collect_all()
                logger.info(
                    f"Cycle {cycle} complete: {summary['markets']} markets | "
                    f"Next in {self.interval}s"
                )
            except KeyboardInterrupt:
                logger.info("Data collector stopped by user")
                break
            except Exception as e:
                logger.error(f"Cycle {cycle} error: {e}", exc_info=True)

            try:
                time.sleep(self.interval)
            except KeyboardInterrupt:
                logger.info("Data collector stopped by user")
                break


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Polymarket Data Collector")
    parser.add_argument("--run", "--loop", action="store_true", help="Run continuous collection")
    parser.add_argument("--once", action="store_true", help="Run one collection cycle")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                        help=f"Collection interval in seconds (default: {DEFAULT_INTERVAL})")
    parser.add_argument("--stats", type=str, metavar="SLUG",
                        help="Show collected data stats for a slug")
    parser.add_argument("--smart-money", type=str, metavar="SLUG",
                        help="Check smart money signals for a slug")
    parser.add_argument("--list", action="store_true", help="List monitored markets")
    args = parser.parse_args()

    if args.list:
        slugs = get_monitored_slugs()
        print(f"\nMonitored markets ({len(slugs)}):")
        for s in slugs:
            print(f"  - {s}")
        return

    if args.stats:
        slug = args.stats
        print(f"\nData stats for: {slug}")
        print(f"  Volume 24h:     ${get_volume_24h(slug):,.2f}")
        print(f"  Volatility 24h: {get_price_volatility(slug, 24):.6f}")
        print(f"  Book depth:     {get_book_depth(slug):,.0f} contracts")
        smart = get_smart_money_signal(slug)
        print(f"  Smart money:    confidence={smart['confidence']:.0%}")
        for d in smart["details"]:
            print(f"    - {d}")
        return

    if args.smart_money:
        signal = get_smart_money_signal(args.smart_money)
        print(json.dumps(signal, indent=2))
        return

    if args.once:
        collector = DataCollector(interval=args.interval)
        summary = collector.collect_all()
        print(json.dumps(summary, indent=2, default=str))
        return

    if args.run:
        collector = DataCollector(interval=args.interval)
        collector.run_loop()
        return

    # Default: run one cycle
    collector = DataCollector(interval=args.interval)
    summary = collector.collect_all()
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
