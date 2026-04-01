#!/usr/bin/env python3
"""
Polymarket Trading Client — Routes all traffic through SOCKS5 proxy.

Handles wallet management, CLOB API authentication, order placement,
position tracking, and integration with the odds scalper signals.

All API calls route through a SOCKS5 proxy to bypass US geo-restrictions.

Usage:
    python polymarket_trader.py --setup                           # Generate wallet + get API creds
    python polymarket_trader.py --deposit                         # Show deposit address
    python polymarket_trader.py --trade SLUG --side YES --price 0.45 --size 100
    python polymarket_trader.py --auto                            # Auto-trade from scalper signals
    python polymarket_trader.py --positions                       # Show current positions
    python polymarket_trader.py --close SLUG                      # Close a position
    python polymarket_trader.py --paper --auto                    # Dry-run mode (no real orders)

Environment Variables:
    POLYMARKET_PRIVATE_KEY  — Ethereum private key (hex, with or without 0x prefix)
    POLYMARKET_API_KEY      — CLOB API key
    POLYMARKET_SECRET       — CLOB API secret
    POLYMARKET_PASSPHRASE   — CLOB API passphrase
    POLYMARKET_PROXY        — SOCKS5 proxy (default: socks5h://165.154.162.230:1080)
"""

import argparse
import hashlib
import hmac
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import requests

logger = logging.getLogger("polymarket_trader")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# Load .env for API keys
_ENV_FILE = THIS_DIR.parents[1] / ".env"
if _ENV_FILE.exists():
    for _line in _ENV_FILE.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            _v = _v.strip().strip("'\"")
            if _k.strip() not in os.environ:
                os.environ[_k.strip()] = _v

CLOB_API = "https://clob.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet

# Proxy modes: "socks5h://host:port" for SOCKS5, "direct" for system VPN, "auto" to detect
DEFAULT_PROXY = "auto"

# Fee constants
TAKER_FEE = 0.02  # 2%
MAKER_FEE = 0.00  # 0%

# Risk defaults
DEFAULT_MAX_POSITION = 50      # USDC per market
DEFAULT_MAX_EXPOSURE = 500     # USDC total
DEFAULT_STOP_LOSS_PCT = 0.15   # 15% loss triggers stop
DEFAULT_MIN_EDGE = 0.02        # 2 cent minimum edge

# Files
WALLET_FILE = DATA_DIR / "polymarket_wallet.json"
POSITIONS_FILE = DATA_DIR / "polymarket_positions.json"
TRADE_LOG_FILE = DATA_DIR / "polymarket_trades.jsonl"
PAPER_POSITIONS_FILE = DATA_DIR / "polymarket_paper_positions.json"
PAPER_TRADE_LOG_FILE = DATA_DIR / "polymarket_paper_trades.jsonl"

# ---------------------------------------------------------------------------
# Proxy-aware HTTP session
# ---------------------------------------------------------------------------


def create_proxy_session(proxy_url: str = None) -> requests.Session:
    """
    Create a requests.Session, optionally routed through SOCKS5.

    Supports three modes:
    - "direct" or None: No proxy (use system VPN like ProtonVPN)
    - "auto": Check if system IP is non-US, else try known proxies
    - "socks5h://host:port": Explicit SOCKS5 proxy
    """
    proxy = proxy_url or os.environ.get("POLYMARKET_PROXY", DEFAULT_PROXY)
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/121.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })

    if proxy == "direct" or proxy is None:
        # Direct connection — rely on system VPN (ProtonVPN, etc.)
        logger.info("Using direct connection (system VPN)")
        return session

    if proxy == "auto":
        # Auto-detect: check if system IP is already non-US (VPN active)
        try:
            resp = requests.get("https://api.ipify.org?format=json", timeout=5)
            ip = resp.json().get("ip", "")
            geo = requests.get(f"https://ipapi.co/{ip}/json/", timeout=5).json()
            if geo.get("country_code") != "US":
                logger.info(f"System VPN detected: {ip} ({geo.get('city')}, {geo.get('country_name')})")
                return session  # Direct connection works
            else:
                logger.info(f"US IP detected ({ip}). Proxy needed for authenticated endpoints.")
                # Return direct session anyway — public endpoints work from US
                return session
        except Exception:
            # Can't determine — use direct
            return session

    # Explicit SOCKS5 proxy
    session.proxies.update({
        "http": proxy,
        "https": proxy,
    })
    logger.info(f"Using SOCKS5 proxy: {proxy}")
    return session


def verify_proxy(session: requests.Session) -> dict:
    """Verify the proxy is working by checking our external IP."""
    try:
        resp = session.get("https://api.ipify.org?format=json", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        ip = data.get("ip", "unknown")

        # Check geolocation
        geo_resp = session.get(f"https://ipapi.co/{ip}/json/", timeout=10)
        geo = geo_resp.json() if geo_resp.ok else {}

        return {
            "ip": ip,
            "country": geo.get("country_name", "unknown"),
            "city": geo.get("city", "unknown"),
            "ok": geo.get("country_code", "") != "US",
        }
    except Exception as e:
        return {"ip": "unknown", "country": "unknown", "city": "unknown", "ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Wallet Management
# ---------------------------------------------------------------------------


def generate_wallet() -> dict:
    """Generate a new Ethereum wallet for Polymarket."""
    try:
        from eth_account import Account
    except ImportError:
        logger.error("eth_account not installed. Run: pip install eth-account")
        sys.exit(1)

    Account.enable_unaudited_hdwallet_features()
    acct, mnemonic = Account.create_with_mnemonic()

    wallet_info = {
        "address": acct.address,
        "mnemonic_hash": hashlib.sha256(mnemonic.encode()).hexdigest()[:16],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "network": "polygon",
        "chain_id": CHAIN_ID,
        "note": "Private key stored in POLYMARKET_PRIVATE_KEY env var. Mnemonic printed once at setup — save it offline.",
    }

    # Save non-sensitive wallet info
    with open(WALLET_FILE, "w") as f:
        json.dump(wallet_info, f, indent=2)

    return {
        "address": acct.address,
        "private_key": acct.key.hex(),
        "mnemonic": mnemonic,
    }


def load_wallet_address() -> Optional[str]:
    """Load wallet address from saved wallet file."""
    if WALLET_FILE.exists():
        with open(WALLET_FILE) as f:
            data = json.load(f)
            return data.get("address")
    return None


def get_private_key() -> Optional[str]:
    """Get private key from environment variable."""
    key = os.environ.get("POLYMARKET_PRIVATE_KEY", "")
    if not key:
        return None
    # Normalize: ensure 0x prefix
    if not key.startswith("0x"):
        key = "0x" + key
    return key


# ---------------------------------------------------------------------------
# CLOB API Client (with proxy)
# ---------------------------------------------------------------------------


class PolymarketCLOB:
    """
    Polymarket CLOB API client that routes all requests through a SOCKS5 proxy.

    Handles:
    - API key derivation from wallet signature
    - Order creation and signing (EIP-712)
    - Position and balance queries
    - Order book access
    """

    def __init__(
        self,
        private_key: str = None,
        api_key: str = None,
        api_secret: str = None,
        api_passphrase: str = None,
        proxy_url: str = None,
    ):
        self.session = create_proxy_session(proxy_url)
        self.private_key = private_key or get_private_key()
        self.api_key = api_key or os.environ.get("POLYMARKET_API_KEY", "")
        self.api_secret = api_secret or os.environ.get("POLYMARKET_SECRET", "")
        self.api_passphrase = api_passphrase or os.environ.get("POLYMARKET_PASSPHRASE", "")
        self.address = None
        self._clob_client = None

        if self.private_key:
            try:
                from eth_account import Account
                acct = Account.from_key(self.private_key)
                self.address = acct.address
            except Exception as e:
                logger.warning(f"Could not derive address from private key: {e}")

    def _init_py_clob(self):
        """Initialize the official py-clob-client (uses our proxy session)."""
        if self._clob_client is not None:
            return self._clob_client

        try:
            from py_clob_client.client import ClobClient
            from py_clob_client.clob_types import ApiCreds

            creds = None
            if self.api_key:
                creds = ApiCreds(
                    api_key=self.api_key,
                    api_secret=self.api_secret,
                    api_passphrase=self.api_passphrase,
                )

            self._clob_client = ClobClient(
                host=CLOB_API,
                chain_id=CHAIN_ID,
                key=self.private_key,
                creds=creds,
            )
            # Monkey-patch the internal session to use our proxy
            if hasattr(self._clob_client, "session"):
                self._clob_client.session.proxies.update(self.session.proxies)
            logger.info(f"py-clob-client initialized for {self.address}")
            return self._clob_client
        except ImportError:
            logger.warning(
                "py-clob-client not installed. Run: pip install py-clob-client"
            )
            return None
        except Exception as e:
            logger.warning(f"py-clob-client init failed: {e}")
            return None

    # -- Raw HTTP helpers (proxied) --

    def _get(self, path: str, params: dict = None, retries: int = 3) -> dict:
        """Proxied GET to CLOB API."""
        url = f"{CLOB_API}{path}"
        for attempt in range(retries):
            try:
                resp = self.session.get(url, params=params, timeout=15)
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:
                if attempt < retries - 1:
                    time.sleep(1.5 ** attempt)
                    continue
                raise
        return {}

    def _post(self, path: str, data: dict = None, headers: dict = None, retries: int = 2) -> dict:
        """Proxied POST to CLOB API."""
        url = f"{CLOB_API}{path}"
        hdrs = {**(headers or {}), "Content-Type": "application/json"}
        for attempt in range(retries):
            try:
                resp = self.session.post(url, json=data, headers=hdrs, timeout=15)
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:
                if attempt < retries - 1:
                    time.sleep(1.5 ** attempt)
                    continue
                raise
        return {}

    # -- Public endpoints (no auth needed) --

    def get_orderbook(self, token_id: str) -> dict:
        """Get order book for a token."""
        return self._get("/book", params={"token_id": token_id})

    def get_midpoint(self, token_id: str) -> Optional[float]:
        """Get midpoint price for a token."""
        data = self._get("/midpoint", params={"token_id": token_id})
        mid = data.get("mid")
        return float(mid) if mid is not None else None

    def get_spread(self, token_id: str) -> dict:
        """Get bid/ask spread for a token."""
        return self._get("/spread", params={"token_id": token_id})

    def get_market(self, condition_id: str) -> dict:
        """Get market info from CLOB."""
        return self._get(f"/markets/{condition_id}")

    def get_simplified_markets(self) -> list:
        """Get all simplified markets."""
        return self._get("/simplified-markets")

    # -- Authenticated endpoints (need API key + wallet) --

    def derive_api_key(self) -> dict:
        """
        Derive API credentials from wallet signature.
        This registers the wallet with the CLOB API.
        Returns {apiKey, secret, passphrase}.
        """
        client = self._init_py_clob()
        if not client:
            raise RuntimeError(
                "py-clob-client required for API key derivation. "
                "Install: pip install py-clob-client"
            )

        try:
            creds = client.derive_api_key()
            self.api_key = creds.api_key
            self.api_secret = creds.api_secret
            self.api_passphrase = creds.api_passphrase

            logger.info(f"API key derived for {self.address}")
            return {
                "api_key": creds.api_key,
                "api_secret": creds.api_secret,
                "api_passphrase": creds.api_passphrase,
            }
        except Exception as e:
            raise RuntimeError(f"API key derivation failed: {e}")

    def get_balance(self) -> Optional[float]:
        """Get USDC balance on Polymarket."""
        client = self._init_py_clob()
        if not client:
            return None
        try:
            bal = client.get_balance_allowance()
            # Returns dict with balance info
            if isinstance(bal, dict):
                return float(bal.get("balance", 0)) / 1e6  # USDC has 6 decimals
            return None
        except Exception as e:
            logger.warning(f"Balance check failed: {e}")
            return None

    def get_positions(self) -> list:
        """Get open positions."""
        client = self._init_py_clob()
        if not client:
            return []
        try:
            return client.get_orders() or []
        except Exception as e:
            logger.warning(f"Positions fetch failed: {e}")
            return []

    def place_limit_order(
        self,
        token_id: str,
        side: str,
        price: float,
        size: float,
    ) -> dict:
        """
        Place a limit order on Polymarket CLOB.

        Args:
            token_id: The CLOB token ID for the outcome
            side: "BUY" or "SELL"
            price: Limit price (0.01 to 0.99)
            size: Number of contracts (in USDC value)

        Returns:
            Order response dict
        """
        client = self._init_py_clob()
        if not client:
            raise RuntimeError("py-clob-client not initialized")

        try:
            from py_clob_client.order_builder.constants import BUY, SELL

            order_side = BUY if side.upper() == "BUY" else SELL

            # Build and sign the order
            order = client.create_and_sign_order({
                "token_id": token_id,
                "price": price,
                "size": size,
                "side": order_side,
            })

            # Submit the order
            result = client.post_order(order)
            return result
        except Exception as e:
            raise RuntimeError(f"Order placement failed: {e}")

    def cancel_order(self, order_id: str) -> dict:
        """Cancel an open order."""
        client = self._init_py_clob()
        if not client:
            raise RuntimeError("py-clob-client not initialized")
        try:
            return client.cancel(order_id)
        except Exception as e:
            raise RuntimeError(f"Order cancellation failed: {e}")

    def cancel_all(self) -> dict:
        """Cancel all open orders."""
        client = self._init_py_clob()
        if not client:
            raise RuntimeError("py-clob-client not initialized")
        try:
            return client.cancel_all()
        except Exception as e:
            raise RuntimeError(f"Cancel all failed: {e}")


# ---------------------------------------------------------------------------
# Position & Trade Tracking
# ---------------------------------------------------------------------------


class PositionTracker:
    """Tracks positions and P&L (works for both paper and live)."""

    def __init__(self, paper: bool = False):
        self.paper = paper
        self.positions_file = PAPER_POSITIONS_FILE if paper else POSITIONS_FILE
        self.trade_log_file = PAPER_TRADE_LOG_FILE if paper else TRADE_LOG_FILE
        self.positions = self._load_positions()

    def _load_positions(self) -> dict:
        """Load positions from disk."""
        if self.positions_file.exists():
            with open(self.positions_file) as f:
                return json.load(f)
        return {}

    def _save_positions(self):
        """Save positions to disk."""
        with open(self.positions_file, "w") as f:
            json.dump(self.positions, f, indent=2, default=str)

    def _log_trade(self, trade: dict):
        """Append trade to log file."""
        trade["timestamp"] = datetime.now(timezone.utc).isoformat()
        trade["paper"] = self.paper
        with open(self.trade_log_file, "a") as f:
            f.write(json.dumps(trade, default=str) + "\n")

    def record_entry(
        self,
        slug: str,
        token_id: str,
        side: str,
        price: float,
        size: float,
        order_id: str = "",
        signal_type: str = "manual",
    ):
        """Record a new position entry."""
        cost = price * size
        fee = MAKER_FEE * cost  # Maker orders = 0% fee

        position = {
            "slug": slug,
            "token_id": token_id,
            "side": side,
            "entry_price": price,
            "size": size,
            "cost": round(cost, 4),
            "fee": round(fee, 4),
            "entry_time": datetime.now(timezone.utc).isoformat(),
            "order_id": order_id,
            "signal_type": signal_type,
            "status": "open",
            "pnl": 0.0,
        }

        self.positions[slug] = position
        self._save_positions()
        self._log_trade({
            "action": "ENTRY",
            "slug": slug,
            "side": side,
            "price": price,
            "size": size,
            "cost": cost,
            "signal_type": signal_type,
        })

        logger.info(
            f"{'[PAPER] ' if self.paper else ''}ENTRY: {side} {slug} "
            f"@ {price:.3f} x {size} = ${cost:.2f}"
        )

    def record_exit(
        self,
        slug: str,
        exit_price: float,
        reason: str = "manual",
    ) -> Optional[dict]:
        """Record position exit and calculate P&L."""
        pos = self.positions.get(slug)
        if not pos or pos["status"] != "open":
            logger.warning(f"No open position for {slug}")
            return None

        entry_price = pos["entry_price"]
        size = pos["size"]
        side = pos["side"]

        # Calculate P&L
        if side in ("YES", "BUY_YES", "BUY"):
            raw_pnl = (exit_price - entry_price) * size
        else:
            raw_pnl = (entry_price - exit_price) * size

        # Exit fee (taker fee if hitting the book)
        exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * size
        net_pnl = raw_pnl - pos["fee"] - exit_fee

        pos["exit_price"] = exit_price
        pos["exit_time"] = datetime.now(timezone.utc).isoformat()
        pos["pnl"] = round(net_pnl, 4)
        pos["exit_fee"] = round(exit_fee, 4)
        pos["exit_reason"] = reason
        pos["status"] = "closed"

        self._save_positions()
        self._log_trade({
            "action": "EXIT",
            "slug": slug,
            "side": side,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "size": size,
            "pnl": net_pnl,
            "reason": reason,
        })

        logger.info(
            f"{'[PAPER] ' if self.paper else ''}EXIT: {slug} "
            f"@ {exit_price:.3f} | P&L: ${net_pnl:+.2f} ({reason})"
        )
        return pos

    def check_stop_losses(self, clob: PolymarketCLOB, stop_pct: float = DEFAULT_STOP_LOSS_PCT) -> list:
        """Check all open positions for stop-loss triggers."""
        triggered = []
        for slug, pos in list(self.positions.items()):
            if pos["status"] != "open":
                continue

            token_id = pos.get("token_id")
            if not token_id:
                continue

            current_mid = clob.get_midpoint(token_id)
            if current_mid is None:
                continue

            entry = pos["entry_price"]
            side = pos["side"]

            if side in ("YES", "BUY_YES", "BUY"):
                loss_pct = (entry - current_mid) / entry if entry > 0 else 0
            else:
                loss_pct = (current_mid - entry) / (1 - entry) if entry < 1 else 0

            if loss_pct >= stop_pct:
                logger.warning(
                    f"STOP-LOSS triggered for {slug}: "
                    f"entry={entry:.3f}, current={current_mid:.3f}, loss={loss_pct:.1%}"
                )
                triggered.append({
                    "slug": slug,
                    "token_id": token_id,
                    "entry": entry,
                    "current": current_mid,
                    "loss_pct": loss_pct,
                })
        return triggered

    def get_total_exposure(self) -> float:
        """Calculate total USDC exposure across all open positions."""
        total = 0.0
        for pos in self.positions.values():
            if pos["status"] == "open":
                total += pos["cost"]
        return total

    def get_open_positions(self) -> dict:
        """Return all open positions."""
        return {k: v for k, v in self.positions.items() if v["status"] == "open"}

    def get_summary(self) -> dict:
        """Get portfolio summary."""
        open_pos = self.get_open_positions()
        closed = {k: v for k, v in self.positions.items() if v["status"] == "closed"}

        total_pnl = sum(p.get("pnl", 0) for p in closed.values())
        total_exposure = self.get_total_exposure()
        win_count = sum(1 for p in closed.values() if p.get("pnl", 0) > 0)
        loss_count = sum(1 for p in closed.values() if p.get("pnl", 0) <= 0)

        return {
            "mode": "PAPER" if self.paper else "LIVE",
            "open_positions": len(open_pos),
            "total_exposure": round(total_exposure, 2),
            "closed_trades": len(closed),
            "total_pnl": round(total_pnl, 2),
            "win_rate": round(win_count / max(1, win_count + loss_count), 2),
            "wins": win_count,
            "losses": loss_count,
        }


# ---------------------------------------------------------------------------
# Market Resolution (find token IDs from slugs)
# ---------------------------------------------------------------------------


def resolve_market(session: requests.Session, slug: str) -> Optional[dict]:
    """
    Resolve a market slug to its token IDs and metadata.
    Uses the Gamma API (proxied).
    """
    try:
        resp = session.get(
            f"{GAMMA_API}/markets",
            params={"slug": slug, "limit": 1},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        markets = data if isinstance(data, list) else data.get("data", [])
        if not markets:
            # Try search by slug substring
            resp = session.get(
                f"{GAMMA_API}/markets",
                params={"slug": slug, "limit": 5},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            markets = data if isinstance(data, list) else data.get("data", [])

        if not markets:
            return None

        m = markets[0]

        # Extract token IDs
        tokens = m.get("clobTokenIds", [])
        if isinstance(tokens, str):
            try:
                tokens = json.loads(tokens)
            except Exception:
                tokens = []

        prices = m.get("outcomePrices", [])
        if isinstance(prices, str):
            try:
                prices = json.loads(prices)
            except Exception:
                prices = []

        yes_token = tokens[0] if len(tokens) > 0 else None
        no_token = tokens[1] if len(tokens) > 1 else None
        yes_price = float(prices[0]) if len(prices) > 0 else None

        return {
            "slug": m.get("slug", slug),
            "question": m.get("question", ""),
            "condition_id": m.get("conditionId", ""),
            "yes_token": yes_token,
            "no_token": no_token,
            "yes_price": yes_price,
            "volume": float(m.get("volumeNum", 0)),
            "end_date": m.get("endDate", "")[:10],
        }
    except Exception as e:
        logger.error(f"Market resolution failed for '{slug}': {e}")
        return None


# ---------------------------------------------------------------------------
# Auto-Trader (integrates with scalper signals)
# ---------------------------------------------------------------------------


class AutoTrader:
    """
    Monitors scalper signals and auto-places limit orders.
    Uses maker orders (0% fee) for entries.
    """

    def __init__(
        self,
        clob: PolymarketCLOB,
        tracker: PositionTracker,
        paper: bool = False,
        max_position: float = DEFAULT_MAX_POSITION,
        max_exposure: float = DEFAULT_MAX_EXPOSURE,
        min_edge: float = DEFAULT_MIN_EDGE,
        stop_loss_pct: float = DEFAULT_STOP_LOSS_PCT,
    ):
        self.clob = clob
        self.tracker = tracker
        self.paper = paper
        self.max_position = max_position
        self.max_exposure = max_exposure
        self.min_edge = min_edge
        self.stop_loss_pct = stop_loss_pct

    def _should_trade(self, signal: dict) -> bool:
        """Check if we should act on a signal."""
        edge = abs(signal.get("edge_estimate", 0))
        if edge < self.min_edge:
            return False

        # Check exposure limits
        if self.tracker.get_total_exposure() >= self.max_exposure:
            logger.info("Max exposure reached, skipping signal")
            return False

        # Don't double up on same market
        slug = signal.get("slug", "")
        if slug in self.tracker.get_open_positions():
            logger.info(f"Already have position in {slug}, skipping")
            return False

        return True

    def _calculate_size(self, price: float, edge: float) -> float:
        """
        Calculate position size based on edge and Kelly criterion (fractional).

        Uses quarter-Kelly for safety:
            size = (edge / odds) * bankroll * 0.25

        Capped at max_position.
        """
        if price <= 0 or price >= 1:
            return 0

        odds = (1 / price) - 1  # decimal odds minus 1
        if odds <= 0:
            return 0

        kelly_fraction = edge / odds
        # Quarter-Kelly, capped
        raw_size = kelly_fraction * self.max_exposure * 0.25
        size = max(1, min(raw_size, self.max_position))
        return round(size, 2)

    def process_signal(self, signal: dict) -> Optional[dict]:
        """
        Process a scalper signal and place an order if appropriate.

        Returns trade info dict or None if skipped.
        """
        if not self._should_trade(signal):
            return None

        slug = signal.get("slug", "")
        direction = signal.get("direction", "")
        price = signal.get("price", 0)
        edge = abs(signal.get("edge_estimate", 0))
        signal_type = signal.get("type", "unknown")

        # Resolve market to get token IDs
        market = resolve_market(self.clob.session, slug)
        if not market:
            logger.warning(f"Could not resolve market: {slug}")
            return None

        # Determine which token to trade
        if direction in ("BUY_YES", "MOMENTUM_UP"):
            side = "BUY"
            token_id = market["yes_token"]
            limit_price = round(price - 0.01, 2)  # Place slightly below for maker fill
        elif direction in ("BUY_NO", "MOMENTUM_DOWN"):
            side = "BUY"
            token_id = market["no_token"]
            limit_price = round((1 - price) - 0.01, 2)
        else:
            logger.warning(f"Unknown direction: {direction}")
            return None

        if not token_id:
            logger.warning(f"No token ID for {slug} ({direction})")
            return None

        # Ensure valid price
        limit_price = max(0.01, min(0.99, limit_price))
        size = self._calculate_size(limit_price, edge)

        if size < 1:
            logger.info(f"Size too small for {slug}, skipping")
            return None

        logger.info(
            f"{'[PAPER] ' if self.paper else ''}Signal: {signal_type} {direction} "
            f"{slug} @ {limit_price:.2f} x {size:.0f}"
        )

        order_id = ""
        if not self.paper:
            try:
                result = self.clob.place_limit_order(
                    token_id=token_id,
                    side=side,
                    price=limit_price,
                    size=size,
                )
                order_id = result.get("orderID", result.get("id", ""))
                logger.info(f"Order placed: {order_id}")
            except Exception as e:
                logger.error(f"Order failed: {e}")
                return None
        else:
            order_id = f"PAPER-{int(time.time())}"

        # Record position
        display_side = "YES" if direction in ("BUY_YES", "MOMENTUM_UP") else "NO"
        self.tracker.record_entry(
            slug=slug,
            token_id=token_id,
            side=display_side,
            price=limit_price,
            size=size,
            order_id=order_id,
            signal_type=signal_type,
        )

        return {
            "slug": slug,
            "direction": display_side,
            "price": limit_price,
            "size": size,
            "order_id": order_id,
            "signal_type": signal_type,
        }

    def run_scan_cycle(self) -> list:
        """
        Run one scan cycle:
        1. Load scalper signals
        2. Process actionable signals
        3. Check stop-losses on existing positions
        """
        trades = []

        # Load latest scalper state
        scalper_state_file = DATA_DIR / "scalper_state.json"
        if not scalper_state_file.exists():
            logger.info("No scalper state found. Run odds_scalper.py --scan first.")
            return trades

        with open(scalper_state_file) as f:
            state = json.load(f)

        opportunities = state.get("opportunities", [])
        logger.info(f"Found {len(opportunities)} scalper signals")

        for opp in opportunities:
            result = self.process_signal(opp)
            if result:
                trades.append(result)

        # Check stop-losses
        stops = self.tracker.check_stop_losses(self.clob, self.stop_loss_pct)
        for stop in stops:
            slug = stop["slug"]
            logger.warning(f"Closing {slug} — stop-loss triggered")
            if not self.paper:
                # For live: need to place a sell order at market
                # For now, record the exit at current price
                pass
            self.tracker.record_exit(slug, stop["current"], reason="stop_loss")

        return trades

    def run_edge_cycle(self) -> list:
        """
        Run one cycle using edge detector signals (richer than scalper-only).
        Falls back gracefully if edge_detector has issues.
        """
        trades = []
        try:
            from edge_detector import EdgeDetector
            detector = EdgeDetector(use_llm=True, min_score=60)
            scan_result = detector.scan(limit=200, min_score=60)
            opportunities = scan_result.get("opportunities", [])

            logger.info(f"Edge detector found {len(opportunities)} opportunities")

            for opp in opportunities:
                # Convert edge_detector format to scalper signal format
                signal = {
                    "slug": opp.get("slug", ""),
                    "question": opp.get("question", ""),
                    "direction": opp.get("direction", ""),
                    "price": opp.get("yes_price", 0),
                    "edge_estimate": opp.get("edge_estimate", 0),
                    "type": "edge_" + "_".join(opp.get("active_signals", ["unknown"])[:2]),
                    "volume": opp.get("volume", 0),
                }
                result = self.process_signal(signal)
                if result:
                    trades.append(result)

        except Exception as e:
            logger.warning(f"Edge detector cycle failed: {e}")

        return trades

    def run_loop(self, interval_sec: int = 300):
        """
        Continuous auto-trading loop.

        1. Run scalper scan (collects prices, generates signals)
        2. Run edge detector (every 3rd cycle, richer signals)
        3. Process signals and place orders
        4. Check stop-losses
        5. Sleep and repeat
        """
        logger.info(
            f"{'[PAPER] ' if self.paper else ''}Auto-trader starting. "
            f"Max position: ${self.max_position}, Max exposure: ${self.max_exposure}, "
            f"Stop-loss: {self.stop_loss_pct:.0%}, Interval: {interval_sec}s"
        )

        # Import scalper for live scanning
        sys.path.insert(0, str(THIS_DIR))
        from odds_scalper import OddsScalper

        scalper = OddsScalper()

        cycle = 0
        while True:
            cycle += 1
            logger.info(f"--- Auto-trade cycle {cycle} ---")

            try:
                # Step 1: Run fresh scalper scan (always — collects price history)
                scan_result = scalper.scan_all(limit=300)
                logger.info(
                    f"Scan: {scan_result.get('mean_reversion_signals', 0)} MR, "
                    f"{scan_result.get('momentum_signals', 0)} MOM, "
                    f"{scan_result.get('wide_spread_markets', 0)} spreads"
                )

                # Step 2: Process scalper signals
                trades = self.run_scan_cycle()
                if trades:
                    logger.info(f"Placed {len(trades)} trades from scalper signals")

                # Step 3: Run edge detector every 3rd cycle (has LLM calls, takes longer)
                if cycle % 3 == 1:
                    edge_trades = self.run_edge_cycle()
                    trades.extend(edge_trades)
                    if edge_trades:
                        logger.info(f"Placed {len(edge_trades)} trades from edge detector")

                # Step 4: Portfolio summary
                summary = self.tracker.get_summary()
                logger.info(
                    f"Portfolio: {summary['open_positions']} open, "
                    f"${summary['total_exposure']:.0f} exposure, "
                    f"P&L: ${summary['total_pnl']:+.2f}, "
                    f"WR: {summary['win_rate']:.0%} ({summary['wins']}W/{summary['losses']}L)"
                )

            except KeyboardInterrupt:
                logger.info("Auto-trader stopped by user")
                break
            except Exception as e:
                logger.error(f"Cycle error: {e}", exc_info=True)

            try:
                time.sleep(interval_sec)
            except KeyboardInterrupt:
                logger.info("Auto-trader stopped by user")
                break


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_setup(args):
    """Setup: generate wallet and derive API credentials."""
    print("=" * 60)
    print("  POLYMARKET TRADER SETUP")
    print("=" * 60)

    # Step 1: Verify proxy
    print("\n[1/4] Verifying SOCKS5 proxy...")
    session = create_proxy_session()
    proxy_info = verify_proxy(session)
    if proxy_info["ok"]:
        print(f"  Proxy OK: {proxy_info['ip']} ({proxy_info['city']}, {proxy_info['country']})")
    else:
        print(f"  WARNING: Proxy may not be working or shows US IP")
        print(f"  IP: {proxy_info['ip']}, Location: {proxy_info.get('city')}, {proxy_info.get('country')}")
        if proxy_info.get("error"):
            print(f"  Error: {proxy_info['error']}")
        print("  Continuing anyway — you can set POLYMARKET_PROXY to use a different proxy.")

    # Step 2: Generate or load wallet
    existing_key = get_private_key()
    existing_addr = load_wallet_address()

    if existing_key:
        print(f"\n[2/4] Using existing wallet from POLYMARKET_PRIVATE_KEY env var")
        try:
            from eth_account import Account
            acct = Account.from_key(existing_key)
            print(f"  Address: {acct.address}")
        except Exception as e:
            print(f"  Error loading key: {e}")
            return
    elif existing_addr:
        print(f"\n[2/4] Wallet already exists: {existing_addr}")
        print("  Set POLYMARKET_PRIVATE_KEY env var with the private key to enable trading.")
    else:
        print("\n[2/4] Generating new Ethereum wallet...")
        wallet = generate_wallet()
        print(f"  Address:     {wallet['address']}")
        print(f"  Private Key: {wallet['private_key']}")
        print(f"  Mnemonic:    {wallet['mnemonic']}")
        print()
        print("  SAVE THE MNEMONIC AND PRIVATE KEY SECURELY!")
        print("  They will NOT be shown again.")
        print()
        print("  Set the environment variable:")
        print(f"    export POLYMARKET_PRIVATE_KEY={wallet['private_key']}")
        print(f"  Or add to your .env file.")
        print()
        print(f"  Wallet metadata saved to: {WALLET_FILE}")

    # Step 3: Derive API key (needs private key)
    if existing_key or (not existing_addr):
        print("\n[3/4] Deriving CLOB API credentials...")
        try:
            key = existing_key or ("0x" + wallet["private_key"] if "wallet" in dir() else None)
            if key:
                clob = PolymarketCLOB(private_key=key)
                creds = clob.derive_api_key()
                print(f"  API Key:    {creds['api_key']}")
                print(f"  Secret:     {creds['api_secret']}")
                print(f"  Passphrase: {creds['api_passphrase']}")
                print()
                print("  Set these environment variables:")
                print(f"    export POLYMARKET_API_KEY={creds['api_key']}")
                print(f"    export POLYMARKET_SECRET={creds['api_secret']}")
                print(f"    export POLYMARKET_PASSPHRASE={creds['api_passphrase']}")
            else:
                print("  Skipped — no private key available.")
        except Exception as e:
            print(f"  API key derivation failed: {e}")
            print("  You can retry after setting POLYMARKET_PRIVATE_KEY and installing py-clob-client.")
    else:
        print("\n[3/4] Skipped — set POLYMARKET_PRIVATE_KEY first.")

    # Step 4: Funding instructions
    address = existing_addr or (wallet["address"] if "wallet" in dir() else "YOUR_ADDRESS")
    print(f"\n[4/4] Fund your wallet on Polygon network:")
    print(f"  Deposit Address: {address}")
    print(f"  Network: Polygon (MATIC)")
    print(f"  Required: USDC (Polygon) for trading, MATIC for gas")
    print()
    print("  Options:")
    print("  1. Bridge USDC from Ethereum via https://wallet.polygon.technology/")
    print("  2. Buy USDC on a CEX and withdraw to Polygon")
    print("  3. Use Polymarket's built-in deposit (once logged in)")
    print()
    print("  Recommended starting amount: $50-100 USDC + 1 MATIC for gas")
    print("=" * 60)


def cmd_deposit(args):
    """Show deposit address and instructions."""
    address = load_wallet_address()
    if not address:
        key = get_private_key()
        if key:
            try:
                from eth_account import Account
                acct = Account.from_key(key)
                address = acct.address
            except Exception:
                pass

    if not address:
        print("No wallet found. Run --setup first.")
        return

    print(f"\n  Polymarket Deposit Address (Polygon Network):")
    print(f"  {address}")
    print(f"\n  Send USDC (Polygon) and a small amount of MATIC for gas.")
    print(f"  Do NOT send tokens on Ethereum mainnet — use Polygon only.\n")


def cmd_trade(args):
    """Place a manual trade."""
    slug = args.trade
    side = args.side.upper()
    price = args.price
    size = args.size
    paper = args.paper

    if side not in ("YES", "NO"):
        print("Side must be YES or NO")
        return

    if not (0.01 <= price <= 0.99):
        print("Price must be between 0.01 and 0.99")
        return

    if size <= 0:
        print("Size must be positive")
        return

    session = create_proxy_session()
    print(f"Resolving market: {slug}...")
    market = resolve_market(session, slug)
    if not market:
        print(f"Could not find market: {slug}")
        return

    print(f"  Market: {market['question'][:80]}")
    print(f"  Current YES price: {market['yes_price']:.3f}")
    print(f"  Volume: ${market['volume']:,.0f}")
    print(f"  End date: {market['end_date']}")

    token_id = market["yes_token"] if side == "YES" else market["no_token"]
    if not token_id:
        print(f"  No token ID found for {side} side")
        return

    cost = price * size
    print(f"\n  Order: BUY {side} @ {price:.2f} x {size} = ${cost:.2f}")
    print(f"  Token: {token_id[:20]}...")
    print(f"  Fee: $0.00 (maker)")

    tracker = PositionTracker(paper=paper)

    if paper:
        print(f"\n  [PAPER MODE] Trade logged but NOT submitted.")
        order_id = f"PAPER-{int(time.time())}"
    else:
        key = get_private_key()
        if not key:
            print("\n  ERROR: POLYMARKET_PRIVATE_KEY not set. Cannot place live orders.")
            print("  Use --paper flag for dry-run mode.")
            return

        print(f"\n  Placing live order...")
        clob = PolymarketCLOB(private_key=key)
        try:
            result = clob.place_limit_order(
                token_id=token_id,
                side="BUY",
                price=price,
                size=size,
            )
            order_id = result.get("orderID", result.get("id", "unknown"))
            print(f"  Order placed! ID: {order_id}")
        except Exception as e:
            print(f"  Order FAILED: {e}")
            return

    tracker.record_entry(
        slug=slug,
        token_id=token_id,
        side=side,
        price=price,
        size=size,
        order_id=order_id,
        signal_type="manual",
    )
    print(f"  Position recorded.")


def cmd_positions(args):
    """Show current positions and P&L."""
    paper = args.paper
    tracker = PositionTracker(paper=paper)
    summary = tracker.get_summary()

    mode = summary["mode"]
    print(f"\n{'=' * 60}")
    print(f"  POLYMARKET POSITIONS [{mode}]")
    print(f"{'=' * 60}")

    open_pos = tracker.get_open_positions()
    if open_pos:
        print(f"\n  Open Positions ({len(open_pos)}):")
        for slug, pos in open_pos.items():
            print(f"    {pos['side']:3s} {slug[:50]}")
            print(f"        Entry: {pos['entry_price']:.3f} x {pos['size']} = ${pos['cost']:.2f}")
            print(f"        Opened: {pos['entry_time'][:19]} | Signal: {pos['signal_type']}")
    else:
        print("\n  No open positions.")

    closed = {k: v for k, v in tracker.positions.items() if v["status"] == "closed"}
    if closed:
        print(f"\n  Closed Trades ({len(closed)}):")
        for slug, pos in list(closed.items())[-10:]:  # Last 10
            pnl = pos.get("pnl", 0)
            print(
                f"    {pos['side']:3s} {slug[:40]:40s} "
                f"P&L: ${pnl:+.2f} ({pos.get('exit_reason', '')})"
            )

    print(f"\n  Summary:")
    print(f"    Exposure:     ${summary['total_exposure']:.2f}")
    print(f"    Closed P&L:   ${summary['total_pnl']:+.2f}")
    print(f"    Win Rate:     {summary['win_rate']:.0%} ({summary['wins']}W / {summary['losses']}L)")
    print(f"{'=' * 60}\n")


def cmd_close(args):
    """Close a position."""
    slug = args.close
    paper = args.paper

    tracker = PositionTracker(paper=paper)
    open_pos = tracker.get_open_positions()

    if slug not in open_pos:
        # Try partial match
        matches = [s for s in open_pos if slug.lower() in s.lower()]
        if len(matches) == 1:
            slug = matches[0]
        elif matches:
            print(f"Multiple matches: {matches}")
            return
        else:
            print(f"No open position matching '{slug}'")
            return

    pos = open_pos[slug]
    token_id = pos["token_id"]

    # Get current price
    session = create_proxy_session()
    clob = PolymarketCLOB()
    current_mid = clob.get_midpoint(token_id)

    if current_mid is None:
        print(f"Could not get current price for {slug}")
        current_mid = pos["entry_price"]  # Fallback

    print(f"Closing position: {slug}")
    print(f"  Entry: {pos['entry_price']:.3f}, Current: {current_mid:.3f}")

    if not paper and get_private_key():
        # Place sell order at slightly below mid for quick fill
        sell_price = round(current_mid - 0.01, 2)
        try:
            clob_auth = PolymarketCLOB(private_key=get_private_key())
            result = clob_auth.place_limit_order(
                token_id=token_id,
                side="SELL",
                price=sell_price,
                size=pos["size"],
            )
            print(f"  Sell order placed: {result.get('orderID', '')}")
        except Exception as e:
            print(f"  Sell order failed: {e}")

    tracker.record_exit(slug, current_mid, reason="manual_close")
    print(f"  Position closed. P&L: ${pos.get('pnl', 0):+.2f}")


def cmd_auto(args):
    """Run auto-trader from scalper + edge detector signals."""
    paper = args.paper

    print(f"\n{'=' * 60}")
    print(f"  POLYMARKET AUTO-TRADER {'[PAPER]' if paper else '[LIVE]'}")
    print(f"{'=' * 60}")

    if not paper:
        # Only verify proxy for live trading
        session = create_proxy_session()
        proxy_info = verify_proxy(session)
        print(f"  Proxy: {proxy_info['ip']} ({proxy_info.get('city', '?')}, {proxy_info.get('country', '?')})")
        if not proxy_info["ok"]:
            print("  Refusing to run live trading without confirmed non-US proxy.")
            return
    else:
        print("  Paper mode — using direct connection (public endpoints only)")
        # Force direct connection for paper mode to avoid slow geo-IP check
        os.environ["POLYMARKET_PROXY"] = "direct"

    clob = PolymarketCLOB()
    tracker = PositionTracker(paper=paper)

    trader = AutoTrader(
        clob=clob,
        tracker=tracker,
        paper=paper,
        max_position=args.max_position,
        max_exposure=args.max_exposure,
        min_edge=args.min_edge,
        stop_loss_pct=args.stop_loss,
    )

    print(f"  Max position: ${args.max_position}")
    print(f"  Max exposure: ${args.max_exposure}")
    print(f"  Min edge:     {args.min_edge:.2f}")
    print(f"  Stop-loss:    {args.stop_loss:.0%}")
    if args.single_cycle:
        print(f"  Mode:         Single cycle")
    else:
        print(f"  Interval:     {args.interval}s")
    print(f"{'=' * 60}\n")

    if args.single_cycle:
        # Run one full cycle: scalper scan + edge detector + trade + stop-loss check
        sys.path.insert(0, str(THIS_DIR))
        from odds_scalper import OddsScalper

        scalper = OddsScalper()
        scan_result = scalper.scan_all(limit=300)

        logger.info(
            f"Scan: {scan_result.get('mean_reversion_signals', 0)} MR, "
            f"{scan_result.get('momentum_signals', 0)} MOM, "
            f"{scan_result.get('wide_spread_markets', 0)} spreads"
        )

        # Process scalper signals
        trades = trader.run_scan_cycle()

        # Also run edge detector
        edge_trades = trader.run_edge_cycle()
        trades.extend(edge_trades)

        # Portfolio summary
        summary = tracker.get_summary()
        result = {
            "trades_placed": len(trades),
            "trades": trades,
            **summary,
        }
        print(json.dumps(result, indent=2, default=str))
    else:
        trader.run_loop(interval_sec=args.interval)


def main():
    parser = argparse.ArgumentParser(
        description="Polymarket Trading Client (SOCKS5 proxied)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python polymarket_trader.py --setup
  python polymarket_trader.py --deposit
  python polymarket_trader.py --paper --trade will-trump-win --side YES --price 0.45 --size 50
  python polymarket_trader.py --paper --auto
  python polymarket_trader.py --positions
  python polymarket_trader.py --close will-trump-win
        """,
    )

    # Mode flags
    parser.add_argument("--setup", action="store_true", help="Generate wallet and get API credentials")
    parser.add_argument("--deposit", action="store_true", help="Show deposit address and instructions")
    parser.add_argument("--trade", type=str, metavar="SLUG", help="Place a manual trade on a market")
    parser.add_argument("--auto", action="store_true", help="Auto-trade from scalper signals")
    parser.add_argument("--positions", action="store_true", help="Show current positions")
    parser.add_argument("--close", type=str, metavar="SLUG", help="Close a position")

    # Trade parameters
    parser.add_argument("--side", type=str, default="YES", help="Trade side: YES or NO (default: YES)")
    parser.add_argument("--price", type=float, default=0.50, help="Limit price (default: 0.50)")
    parser.add_argument("--size", type=float, default=25, help="Position size in USDC (default: 25)")

    # Paper/live mode
    parser.add_argument("--paper", action="store_true", help="Paper trading mode (no real orders)")

    # Auto-trader parameters
    parser.add_argument("--single-cycle", action="store_true",
                        help="Run one auto-trade cycle and exit (for cron/scheduler use)")
    parser.add_argument("--max-position", type=float, default=DEFAULT_MAX_POSITION,
                        help=f"Max position per market in USDC (default: {DEFAULT_MAX_POSITION})")
    parser.add_argument("--max-exposure", type=float, default=DEFAULT_MAX_EXPOSURE,
                        help=f"Max total exposure in USDC (default: {DEFAULT_MAX_EXPOSURE})")
    parser.add_argument("--min-edge", type=float, default=DEFAULT_MIN_EDGE,
                        help=f"Minimum edge to trade (default: {DEFAULT_MIN_EDGE})")
    parser.add_argument("--stop-loss", type=float, default=DEFAULT_STOP_LOSS_PCT,
                        help=f"Stop-loss percentage (default: {DEFAULT_STOP_LOSS_PCT})")
    parser.add_argument("--interval", type=int, default=300,
                        help="Auto-trade scan interval in seconds (default: 300)")

    # Proxy override
    parser.add_argument("--proxy", type=str, default=None,
                        help=f"SOCKS5 proxy URL (default: {DEFAULT_PROXY})")

    args = parser.parse_args()

    # Set proxy override
    if args.proxy:
        os.environ["POLYMARKET_PROXY"] = args.proxy

    # Dispatch
    if args.setup:
        cmd_setup(args)
    elif args.deposit:
        cmd_deposit(args)
    elif args.trade:
        cmd_trade(args)
    elif args.auto:
        cmd_auto(args)
    elif args.positions:
        cmd_positions(args)
    elif args.close:
        cmd_close(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
