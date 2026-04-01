"""
Tick Backfill — One-shot script to backfill today's tick CSV from the full MBO JSONL.
======================================================================================
Run this once to populate the tick CSV with today's full history before starting
the live tick_collector.py (which only tails from the current position onward).

Usage:
    python quant_dashboard/tick_backfill.py            # backfill today
    python quant_dashboard/tick_backfill.py 2026-03-25  # backfill specific date
"""

import json
import sys
import time
import logging
from pathlib import Path
from datetime import date

LVL3_ROOT  = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant")
MBO_DIR    = LVL3_ROOT / "data" / "raw" / "rithmic_mbo"
PAPER_LOG  = LVL3_ROOT / "live_trading" / "logs" / "paper"
BAR_SECS   = 1          # 1-second bars
TRADE_ACT  = "M"        # trade/execution events in MBO

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [backfill] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("backfill")

TICK_HEADER  = "ts_unix_s,open,high,low,close,volume,bid,ask,spread\n"
TRADE_HEADER = "ts_unix_s,ts_iso,card,side,entry_price,exit_price,pnl_dollars,exit_reason,hold_time_ms,is_entry\n"


def backfill_date(target_date: date) -> None:
    mbo_path  = MBO_DIR / f"{target_date.isoformat()}_rithmic.jsonl"
    tick_csv  = PAPER_LOG / f"live_ticks_{target_date.isoformat()}.csv"
    trade_csv = PAPER_LOG / f"live_trades_{target_date.isoformat()}.csv"

    if not mbo_path.exists():
        log.error("MBO file not found: %s", mbo_path)
        return

    file_size = mbo_path.stat().st_size
    log.info("Backfilling %s  (%.1f MB)", target_date, file_size / 1e6)

    # Ensure output dirs
    tick_csv.parent.mkdir(parents=True, exist_ok=True)

    # Always overwrite — backfill is authoritative
    tick_csv.write_text(TICK_HEADER, encoding="utf-8")
    if not trade_csv.exists():
        trade_csv.write_text(TRADE_HEADER, encoding="utf-8")

    # --- Also load trade JSONL files for this date ---
    trade_records: list[dict] = []
    for f in sorted(PAPER_LOG.glob(f"*_{target_date.isoformat()}_trades.jsonl")):
        card_name = f.name.split("_")[0]
        try:
            for line in f.read_text(encoding="utf-8").strip().splitlines():
                if line.strip():
                    rec = json.loads(line)
                    rec["card"] = card_name
                    trade_records.append(rec)
        except Exception as e:
            log.warning("Failed reading %s: %s", f, e)
    # Sort trades by timestamp
    trade_records.sort(key=lambda r: r.get("ts", ""))

    # Write trade events to trade CSV
    if trade_records:
        log.info("Writing %d trade events to %s", len(trade_records), trade_csv)
        with open(trade_csv, "a", encoding="utf-8") as f:
            for t in trade_records:
                try:
                    ts_str   = t.get("ts", "")
                    ts_dt    = None
                    ts_unix  = 0
                    if ts_str:
                        from datetime import datetime, timezone
                        ts_dt   = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                        ts_unix = int(ts_dt.timestamp())
                    card     = t.get("card", "")
                    side     = t.get("side", "")
                    entry_px = t.get("entry_price", "")
                    exit_px  = t.get("exit_price", "")
                    pnl      = t.get("pnl_dollars", "")
                    reason   = t.get("exit_reason", "")
                    hold_ms  = t.get("hold_time_ms", "")
                    # Mark as exit event (is_entry=0); entries are detected separately
                    f.write(f"{ts_unix},{ts_str},{card},{side},{entry_px},{exit_px},{pnl},{reason},{hold_ms},0\n")
                except Exception:
                    continue

    # --- Process MBO JSONL ---
    # Current bar state
    bar_ts:    int | None = None
    bar_open:  float = 0.0
    bar_high:  float = 0.0
    bar_low:   float = 0.0
    bar_close: float = 0.0
    bar_vol:   float = 0.0

    bars_out:  list[str] = []
    batch_size = 50_000  # Flush to disk every N bars (memory control)

    lines_read  = 0
    ticks_read  = 0
    bars_written = 0
    report_every = 1_000_000
    t0 = time.monotonic()

    def flush_bars() -> None:
        nonlocal bars_out, bars_written
        if not bars_out:
            return
        with open(tick_csv, "a", encoding="utf-8", newline="") as f:
            f.writelines(bars_out)
        bars_written += len(bars_out)
        bars_out = []

    def close_bar() -> None:
        nonlocal bar_ts
        if bar_ts is None:
            return
        # bid/ask not tracked per-bar in backfill (not in MBO stream)
        bars_out.append(
            f"{bar_ts},{bar_open:.4f},{bar_high:.4f},{bar_low:.4f},{bar_close:.4f},{bar_vol:.1f},,,\n"
        )
        if len(bars_out) >= batch_size:
            flush_bars()
        bar_ts = None

    with open(mbo_path, "r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            lines_read += 1

            if lines_read % report_every == 0:
                elapsed = time.monotonic() - t0
                pct = 0.0
                try:
                    fh_pos  = fh.buffer.tell() if hasattr(fh, "buffer") else 0
                    pct = fh_pos / file_size * 100
                except Exception:
                    pass
                log.info(
                    "  lines=%dM  ticks=%dK  bars=%d  %.1f%%  %.0fs elapsed",
                    lines_read // 1_000_000,
                    ticks_read // 1_000,
                    bars_written + len(bars_out),
                    pct,
                    elapsed,
                )

            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if rec.get("a") != TRADE_ACT:
                continue

            ts_ns = rec.get("ts")
            price = rec.get("p")
            size  = rec.get("sz", 1)
            if ts_ns is None or price is None:
                continue
            try:
                ts_ns = int(ts_ns)
                price = float(price)
                size  = float(size)
            except (ValueError, TypeError):
                continue

            ticks_read += 1
            this_bar_ts = ts_ns // 1_000_000_000

            if bar_ts is None:
                bar_ts = this_bar_ts
                bar_open = bar_high = bar_low = bar_close = price
                bar_vol  = size
            elif this_bar_ts == bar_ts:
                if price > bar_high: bar_high = price
                if price < bar_low:  bar_low  = price
                bar_close = price
                bar_vol  += size
            else:
                close_bar()
                bar_ts = this_bar_ts
                bar_open = bar_high = bar_low = bar_close = price
                bar_vol  = size

    # Close final bar
    if bar_ts is not None:
        bars_out.append(
            f"{bar_ts},{bar_open:.4f},{bar_high:.4f},{bar_low:.4f},{bar_close:.4f},{bar_vol:.1f},,,\n"
        )

    flush_bars()

    elapsed = time.monotonic() - t0
    log.info(
        "Backfill complete: %d lines, %d trade ticks, %d bars  in %.1fs",
        lines_read, ticks_read, bars_written, elapsed,
    )
    log.info("Output: %s  (%.1f KB)", tick_csv, tick_csv.stat().st_size / 1024)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            target = date.fromisoformat(sys.argv[1])
        except ValueError:
            log.error("Invalid date: %s  (use YYYY-MM-DD)", sys.argv[1])
            sys.exit(1)
    else:
        target = date.today()

    backfill_date(target)
