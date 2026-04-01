"""
Tick Collector — Background data collector for the QCC streaming chart.
============================================================================
Runs as a persistent PM2 process alongside the paper engine.
Reads the daily Rithmic MBO JSONL (tail-follows it), extracts trade prints,
aggregates them into 1-second OHLCV bars, and writes to:

  C:/Users/Footb/Documents/Github/Lvl3Quant/live_trading/logs/paper/live_ticks_YYYY-MM-DD.csv

The CSV has these columns:
  ts_unix_s, open, high, low, close, volume, bid, ask, spread

It also maintains a separate trade-events file:
  C:/Users/Footb/Documents/Github/Lvl3Quant/live_trading/logs/paper/live_trades_YYYY-MM-DD.csv

With columns:
  ts_unix_s, card, side, entry_price, exit_price, pnl_dollars, exit_reason, hold_time_ms, is_entry

Run:
    python quant_dashboard/tick_collector.py
    # or via PM2: pm2 start quant_dashboard/tick_collector.py --interpreter python --name tick-collector
"""

import json
import os
import sys
import time
import logging
from pathlib import Path
from datetime import date, datetime
from collections import deque

# ─── Paths ─────────────────────────────────────────────────────────────────────
LVL3_ROOT    = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant")
MBO_DIR      = LVL3_ROOT / "data" / "raw" / "rithmic_mbo"
PAPER_LOG    = LVL3_ROOT / "live_trading" / "logs" / "paper"
LIVE_STATE   = PAPER_LOG / "live_state.json"

# Output files (date-stamped at startup, re-opened each day)
def _tick_csv(d: date) -> Path:
    return PAPER_LOG / f"live_ticks_{d.isoformat()}.csv"

def _trade_csv(d: date) -> Path:
    return PAPER_LOG / f"live_trades_{d.isoformat()}.csv"

def _mbo_jsonl(d: date) -> Path:
    return MBO_DIR / f"{d.isoformat()}_rithmic.jsonl"

# ─── Constants ─────────────────────────────────────────────────────────────────
BAR_INTERVAL_S  = 1        # Aggregate into 1-second OHLCV bars
FLUSH_EVERY_S   = 2        # Flush accumulated bars to CSV every N seconds
TAIL_SLEEP_S    = 0.05     # Sleep between tail reads when no new data (50ms)
LOG_EVERY_S     = 60       # Progress log interval
ES_TICK         = 0.25
# Only keep trade events (action=M) — not book add/cancel
TRADE_ACTION    = "M"

# ─── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [tick_collector] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("tick_collector")


# ─── Bar accumulator ───────────────────────────────────────────────────────────
class BarAccumulator:
    """Accumulates raw tick prices into 1s OHLCV bars."""

    def __init__(self):
        self._current_bar_ts: int | None = None   # unix seconds (floored)
        self._open:   float | None = None
        self._high:   float | None = None
        self._low:    float | None = None
        self._close:  float | None = None
        self._volume: float = 0.0
        self._bars_ready: list[dict] = []          # completed bars pending write

    def feed(self, ts_ns: int, price: float, size: float) -> None:
        """Feed a trade tick. Completed bars are queued in _bars_ready."""
        bar_ts = int(ts_ns // 1_000_000_000)   # floor to second

        if self._current_bar_ts is None:
            self._start_bar(bar_ts, price, size)
        elif bar_ts == self._current_bar_ts:
            # Same bar: extend
            self._high  = max(self._high, price)
            self._low   = min(self._low,  price)
            self._close = price
            self._volume += size
        else:
            # New bar: close old, start new
            self._bars_ready.append(self._current_bar())
            self._start_bar(bar_ts, price, size)

    def _start_bar(self, ts: int, price: float, size: float) -> None:
        self._current_bar_ts = ts
        self._open = self._high = self._low = self._close = price
        self._volume = size

    def _current_bar(self) -> dict:
        return {
            "ts_unix_s": self._current_bar_ts,
            "open":  self._open,
            "high":  self._high,
            "low":   self._low,
            "close": self._close,
            "volume": self._volume,
        }

    def drain(self) -> list[dict]:
        """Return and clear all completed bars."""
        ready = self._bars_ready
        self._bars_ready = []
        return ready


# ─── CSV writer ────────────────────────────────────────────────────────────────
TICK_HEADER  = "ts_unix_s,open,high,low,close,volume,bid,ask,spread\n"
TRADE_HEADER = "ts_unix_s,ts_iso,card,side,entry_price,exit_price,pnl_dollars,exit_reason,hold_time_ms,is_entry\n"


def _ensure_csv(path: Path, header: str) -> None:
    """Create CSV with header if it doesn't exist yet."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(header, encoding="utf-8")


def _append_bars(path: Path, bars: list[dict], bid: float | None, ask: float | None) -> None:
    """Append completed bars to tick CSV."""
    if not bars:
        return
    spread = round(ask - bid, 4) if bid and ask else None
    with open(path, "a", encoding="utf-8", newline="") as f:
        for b in bars:
            f.write(
                f"{b['ts_unix_s']},"
                f"{b['open']:.4f},"
                f"{b['high']:.4f},"
                f"{b['low']:.4f},"
                f"{b['close']:.4f},"
                f"{b['volume']:.1f},"
                f"{bid:.4f if bid else ''},"
                f"{ask:.4f if ask else ''},"
                f"{spread if spread is not None else ''}\n"
            )


# ─── Live state reader ─────────────────────────────────────────────────────────
_last_live_state_ts: float = 0.0
_live_state_cache: dict = {}

def _read_live_state_cached() -> dict:
    """Read live_state.json at most once per 2s."""
    global _last_live_state_ts, _live_state_cache
    now = time.time()
    if now - _last_live_state_ts < 2.0:
        return _live_state_cache
    _last_live_state_ts = now
    try:
        raw = LIVE_STATE.read_text(encoding="utf-8")
        _live_state_cache = json.loads(raw)
    except Exception:
        pass
    return _live_state_cache


# ─── Trade event tracker ───────────────────────────────────────────────────────
class TradeEventTracker:
    """
    Detects when cards transition in/out of positions by comparing consecutive
    live_state snapshots, and appends events to the trade CSV.
    """

    def __init__(self, trade_csv: Path):
        self._csv = trade_csv
        self._prev_positions: dict[str, int] = {}
        self._prev_entry_prices: dict[str, float | None] = {}
        # Track last known trade count per card to detect new exits
        self._prev_trade_counts: dict[str, int] = {}

    def update(self, state: dict) -> None:
        cards = state.get("cards") or {}
        ts_now = int(time.time())
        ts_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

        for card, data in cards.items():
            pos      = data.get("position", 0)
            ep       = data.get("entry_price")
            side_str = data.get("position_side", "")
            tc       = data.get("trades", 0)
            unreal   = data.get("unrealized_pnl")
            tp       = data.get("tp_price")
            sl       = data.get("sl_price")

            prev_pos = self._prev_positions.get(card, 0)
            prev_tc  = self._prev_trade_counts.get(card, 0)

            # Entry detected: position went from 0 → non-zero
            if prev_pos == 0 and pos != 0 and ep:
                row = (
                    f"{ts_now},{ts_iso},{card},{side_str},"
                    f"{ep:.4f},,,,0,1\n"
                )
                with open(self._csv, "a", encoding="utf-8") as f:
                    f.write(row)
                log.info("  ENTRY  card=%-8s side=%-5s price=%.2f", card, side_str, ep)

            # Exit detected: trade count increased while position went to 0
            if tc > prev_tc and pos == 0:
                # Read pnl/exit_reason from paper trades JSONL
                # (exit info is written to the trades JSONL by the paper engine)
                # We emit a best-effort row here — the dashboard can also read from JSONL directly
                row = (
                    f"{ts_now},{ts_iso},{card},{side_str},"
                    f",,,,0,0\n"
                )
                with open(self._csv, "a", encoding="utf-8") as f:
                    f.write(row)
                log.info("  EXIT   card=%-8s trades=%d", card, tc)

            self._prev_positions[card] = pos
            self._prev_entry_prices[card] = ep
            self._prev_trade_counts[card] = tc


# ─── JSONL tail reader ─────────────────────────────────────────────────────────
class JournalTailer:
    """Tail-follows a JSONL file, yielding new lines as they appear."""

    def __init__(self, path: Path, start_at_end: bool = True):
        self.path = path
        self._pos: int = 0
        self._inode: int | None = None
        if start_at_end and path.exists():
            self._pos = path.stat().st_size

    def read_new(self) -> list[str]:
        """Return newly appended lines since last call."""
        if not self.path.exists():
            return []
        try:
            stat = self.path.stat()
            # File rotated/replaced?
            if self._inode and stat.st_ino != self._inode:
                log.info("JSONL rotated: %s", self.path)
                self._pos = 0
            self._inode = stat.st_ino
            if stat.st_size < self._pos:
                # Truncated
                self._pos = 0
            if stat.st_size == self._pos:
                return []
            with open(self.path, "rb") as f:
                f.seek(self._pos)
                chunk = f.read(stat.st_size - self._pos)
                self._pos = stat.st_size
            text = chunk.decode("utf-8", errors="replace")
            lines = text.splitlines()
            return [l for l in lines if l.strip()]
        except Exception as e:
            log.warning("read_new error: %s", e)
            return []


# ─── Main loop ─────────────────────────────────────────────────────────────────
def run() -> None:
    today        = date.today()
    tick_csv     = _tick_csv(today)
    trade_csv    = _trade_csv(today)

    _ensure_csv(tick_csv,  TICK_HEADER)
    _ensure_csv(trade_csv, TRADE_HEADER)

    mbo_path     = _mbo_jsonl(today)
    tailer       = JournalTailer(mbo_path, start_at_end=True)
    accumulator  = BarAccumulator()
    trade_tracker = TradeEventTracker(trade_csv)

    last_flush   = time.monotonic()
    last_log     = time.monotonic()
    last_state   = time.monotonic()
    ticks_seen   = 0
    bars_written = 0

    # Bid/ask from live state (updated every 2s from state cache)
    cur_bid: float | None = None
    cur_ask: float | None = None

    log.info("Tick collector started. MBO: %s", mbo_path)
    log.info("Tick CSV  : %s", tick_csv)
    log.info("Trade CSV : %s", trade_csv)

    while True:
        # ── Day rollover ──────────────────────────────────────────────────────
        now_date = date.today()
        if now_date != today:
            log.info("Day rolled over to %s", now_date)
            today        = now_date
            tick_csv     = _tick_csv(today)
            trade_csv    = _trade_csv(today)
            _ensure_csv(tick_csv,  TICK_HEADER)
            _ensure_csv(trade_csv, TRADE_HEADER)
            mbo_path     = _mbo_jsonl(today)
            tailer       = JournalTailer(mbo_path, start_at_end=False)
            accumulator  = BarAccumulator()
            trade_tracker = TradeEventTracker(trade_csv)
            bars_written = 0

        # ── Read new MBO lines ────────────────────────────────────────────────
        new_lines = tailer.read_new()
        for raw in new_lines:
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # Only trade executions (action=M)
            if rec.get("a") != TRADE_ACTION:
                continue
            ts_ns = rec.get("ts")
            price = rec.get("p")
            size  = rec.get("sz", 1)
            if ts_ns is None or price is None:
                continue
            try:
                ts_ns  = int(ts_ns)
                price  = float(price)
                size   = float(size)
            except (ValueError, TypeError):
                continue
            accumulator.feed(ts_ns, price, size)
            ticks_seen += 1

        # ── Refresh bid/ask from live_state ──────────────────────────────────
        now_mono = time.monotonic()
        if now_mono - last_state >= 1.0:
            state = _read_live_state_cached()
            if state:
                cur_bid = state.get("best_bid") or cur_bid
                cur_ask = state.get("best_ask") or cur_ask
                trade_tracker.update(state)
            last_state = now_mono

        # ── Flush completed bars to CSV ────────────────────────────────────
        if now_mono - last_flush >= FLUSH_EVERY_S:
            bars = accumulator.drain()
            if bars:
                _append_bars(tick_csv, bars, cur_bid, cur_ask)
                bars_written += len(bars)
            last_flush = now_mono

        # ── Progress log ─────────────────────────────────────────────────────
        if now_mono - last_log >= LOG_EVERY_S:
            log.info(
                "Status: ticks=%d  bars_written=%d  mbo_size=%.1fMB  bid=%s  ask=%s",
                ticks_seen, bars_written,
                mbo_path.stat().st_size / 1e6 if mbo_path.exists() else 0,
                f"{cur_bid:.2f}" if cur_bid else "?",
                f"{cur_ask:.2f}" if cur_ask else "?",
            )
            last_log = now_mono

        # ── Yield to OS ──────────────────────────────────────────────────────
        if not new_lines:
            time.sleep(TAIL_SLEEP_S)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        log.info("Tick collector stopped.")
        sys.exit(0)
