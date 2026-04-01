"""Data loading utilities for the Quant Dashboard.

Handles loading, caching, and labeling of all quant data sources:
- CNN OOT sim results
- Chase sweep results
- Walk-forward fill sim results
- MFE sweep results
- Event logs (JSONL)
- Book tensor cache (NPZ)
- Prediction files (NPZ)
"""
import json
import glob
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import streamlit as st

from config import (
    RESULTS_DIR, DEEP_MODEL_RESULTS, EVENT_LOGS_DIR, BOOK_CACHE_DIR,
    BOOK_CACHE_OOT_DIR,
    PREDICTIONS_DIR, CHASE_SWEEP_FILE, WF_FILL_SIM_FILE,
    CNN_OOT_PATTERN, MFE_SWEEP_PATTERN, RESULT_TYPE_MAP,
    ES_TICK_VALUE, RT_COMMISSION, TRADING_DAYS_PER_YEAR,
)


def _parse_timestamp_from_filename(filename: str) -> Optional[datetime]:
    """Extract timestamp from result filename like *_20260311_101208.json."""
    match = re.search(r'(\d{8}_\d{6})', filename)
    if match:
        return datetime.strptime(match.group(1), '%Y%m%d_%H%M%S')
    return None


def _classify_result_file(filename: str) -> dict:
    """Classify a result file and return metadata."""
    basename = os.path.basename(filename)
    ts = _parse_timestamp_from_filename(basename)

    for prefix, meta in RESULT_TYPE_MAP.items():
        if basename.startswith(prefix):
            return {
                "file_path": filename,
                "file_name": basename,
                "file_size_kb": os.path.getsize(filename) / 1024,
                "created": ts,
                "created_str": ts.strftime("%Y-%m-%d %H:%M:%S") if ts else "Unknown",
                "type_key": prefix,
                **meta,
            }

    return {
        "file_path": filename,
        "file_name": basename,
        "file_size_kb": os.path.getsize(filename) / 1024,
        "created": ts,
        "created_str": ts.strftime("%Y-%m-%d %H:%M:%S") if ts else "Unknown",
        "type_key": "unknown",
        "name": basename.rsplit("_", 2)[0].replace("_", " ").title(),
        "model": "Unknown",
        "sim_type": "Unknown",
        "description": "Unclassified result file",
    }


@st.cache_data(ttl=300)
def load_all_result_files() -> pd.DataFrame:
    """Scan and catalog all result JSON files with metadata."""
    files = []
    for pattern in ["*.json"]:
        for fpath in glob.glob(str(RESULTS_DIR / pattern)):
            files.append(_classify_result_file(fpath))
    for fpath in glob.glob(str(DEEP_MODEL_RESULTS / "*.json")):
        files.append(_classify_result_file(fpath))
    if CHASE_SWEEP_FILE.exists():
        files.append(_classify_result_file(str(CHASE_SWEEP_FILE)))
    if not files:
        return pd.DataFrame()
    df = pd.DataFrame(files)
    df = df.sort_values("created", ascending=False, na_position="last")
    return df


@st.cache_data(ttl=300)
def load_cnn_oot_results() -> list[dict]:
    """Load all CNN OOT sim result files, merged and deduplicated."""
    all_configs = []
    for fpath in sorted(glob.glob(str(RESULTS_DIR / CNN_OOT_PATTERN))):
        ts = _parse_timestamp_from_filename(fpath)
        with open(fpath) as f:
            data = json.load(f)
        for cfg in data:
            cfg["source_file"] = os.path.basename(fpath)
            cfg["run_date"] = ts.strftime("%Y-%m-%d %H:%M") if ts else "Unknown"
            all_configs.append(cfg)
    return all_configs


@st.cache_data(ttl=300)
def load_chase_sweep() -> list[dict]:
    """Load chase/cancel-replace sweep results."""
    if not CHASE_SWEEP_FILE.exists():
        return []
    with open(CHASE_SWEEP_FILE) as f:
        return json.load(f)


@st.cache_data(ttl=300)
def load_wf_fill_sim() -> dict:
    """Load walk-forward fill sim results."""
    if not WF_FILL_SIM_FILE.exists():
        return {}
    with open(WF_FILL_SIM_FILE) as f:
        return json.load(f)


@st.cache_data(ttl=300)
def load_mfe_sweep() -> dict:
    """Load MFE sweep results."""
    files = sorted(glob.glob(str(RESULTS_DIR / MFE_SWEEP_PATTERN)))
    if not files:
        return {}
    with open(files[-1]) as f:
        return json.load(f)


@st.cache_data(ttl=300)
def load_event_logs() -> pd.DataFrame:
    """Load all event log JSONL files into a DataFrame."""
    all_events = []
    for fpath in sorted(glob.glob(str(EVENT_LOGS_DIR / "events_*.jsonl"))):
        date_match = re.search(r'events_(\d{4}-\d{2}-\d{2})', fpath)
        log_date = date_match.group(1) if date_match else "Unknown"
        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                    evt["log_date"] = log_date
                    evt["source_file"] = os.path.basename(fpath)
                    all_events.append(evt)
                except json.JSONDecodeError:
                    continue
    if not all_events:
        return pd.DataFrame()
    df = pd.DataFrame(all_events)
    if "wall_clock" in df.columns:
        df["wall_clock"] = pd.to_datetime(df["wall_clock"], errors="coerce")
    return df


def list_book_cache_dates(include_oot: bool = True) -> list[str]:
    """List available dates in both IS and OOT book tensor caches."""
    dates = []
    for cache_dir in [BOOK_CACHE_DIR, BOOK_CACHE_OOT_DIR] if include_oot else [BOOK_CACHE_DIR]:
        for f in sorted(glob.glob(str(cache_dir / "*_book_tensors.npz"))):
            match = re.search(r'(\d{4}-\d{2}-\d{2})', os.path.basename(f))
            if match:
                dates.append(match.group(1))
    return sorted(set(dates))


@st.cache_data(ttl=600)
def load_book_tensors(date: str) -> Optional[dict]:
    """Load book tensor data for a specific date (checks both IS and OOT caches)."""
    for cache_dir in [BOOK_CACHE_OOT_DIR, BOOK_CACHE_DIR]:
        fpath = cache_dir / f"{date}_book_tensors.npz"
        if fpath.exists():
            data = np.load(str(fpath), allow_pickle=True)
            return {key: data[key] for key in data.files}
    return None


@st.cache_data(ttl=600)
def load_bookmap_data(date: str, subsample: int = 100) -> Optional[dict]:
    """
    Load book tensor data and format it for bookmap-style heatmap visualization.

    Book tensors shape: (n_bars, 20, 4)
      - 20 levels = 10 bid (0-9) + 10 ask (10-19)
      - 4 features per level = [price_rel, depth_lots, num_orders, queue_age]

    Returns subsampled data for efficient rendering:
      - bid_depth: (n_sampled, 10) — depth at each bid level
      - ask_depth: (n_sampled, 10) — depth at each ask level
      - bid_prices: (n_sampled, 10) — absolute prices at each bid level
      - ask_prices: (n_sampled, 10) — absolute prices at each ask level
      - mid_prices: (n_sampled,) — mid prices
      - time_sec: (n_sampled,) — time in seconds from start
      - n_bars: total bars before subsampling
    """
    tensors = load_book_tensors(date)
    if tensors is None:
        return None

    book = tensors["book_tensors"]  # (n_bars, 20, 4)
    mids = tensors["mid_prices"]    # (n_bars,)
    n_bars = len(mids)

    # Subsample
    indices = np.arange(0, n_bars, subsample)
    book_s = book[indices]
    mids_s = mids[indices]

    # Extract bid/ask depth (feature index 1) and price_rel (feature index 0)
    bid_depth = book_s[:, :10, 1]    # (n, 10) — L1-L10 bid depth
    ask_depth = book_s[:, 10:, 1]    # (n, 10) — L1-L10 ask depth
    bid_price_rel = book_s[:, :10, 0]  # relative to mid in ticks
    ask_price_rel = book_s[:, 10:, 0]

    # Absolute prices
    bid_prices = mids_s[:, None] + bid_price_rel * 0.25
    ask_prices = mids_s[:, None] + ask_price_rel * 0.25

    # Time axis (100ms per bar)
    time_sec = indices * 0.1

    return {
        "bid_depth": bid_depth,
        "ask_depth": ask_depth,
        "bid_prices": bid_prices,
        "ask_prices": ask_prices,
        "mid_prices": mids_s,
        "time_sec": time_sec,
        "time_min": time_sec / 60,
        "n_bars": n_bars,
        "subsample": subsample,
        "date": date,
    }


def list_prediction_files() -> list[dict]:
    """List all prediction NPZ files with metadata."""
    files = []
    for fpath in sorted(glob.glob(str(PREDICTIONS_DIR / "oos_predictions_*.npz"))):
        basename = os.path.basename(fpath)
        ts = _parse_timestamp_from_filename(basename)
        size_mb = os.path.getsize(fpath) / (1024 * 1024)
        files.append({
            "file_path": fpath,
            "file_name": basename,
            "created": ts,
            "created_str": ts.strftime("%Y-%m-%d %H:%M") if ts else "Unknown",
            "size_mb": round(size_mb, 1),
        })
    return files


def load_predictions(fpath: str) -> Optional[dict]:
    """Load prediction NPZ file."""
    if not os.path.exists(fpath):
        return None
    data = np.load(fpath, allow_pickle=True)
    return {key: data[key] for key in data.files}


def parse_config_name(config_str: str) -> dict:
    """Parse a config string like 'vol70_morning_afternoon_chase_1t_3r_conv25_30min_lat0' into components."""
    parts = {}

    # Vol percentile
    vol_match = re.search(r'vol(\d+)', config_str)
    parts["vol_percentile"] = int(vol_match.group(1)) if vol_match else None

    # Time filter
    if "morning_afternoon" in config_str:
        parts["time_filter"] = "Morning+Afternoon"
    elif "morning" in config_str:
        parts["time_filter"] = "Morning Only"
    elif "afternoon" in config_str:
        parts["time_filter"] = "Afternoon Only"
    else:
        parts["time_filter"] = "All Day"

    # Chase params
    chase_match = re.search(r'chase_(\d+)t_(\d+)r', config_str)
    if chase_match:
        parts["chase_ticks"] = int(chase_match.group(1))
        parts["chase_reprices"] = int(chase_match.group(2))
        parts["execution"] = f"Chase {chase_match.group(1)}t/{chase_match.group(2)}r"
    else:
        parts["chase_ticks"] = 0
        parts["chase_reprices"] = 0
        parts["execution"] = "Passive Only"

    # Conviction threshold
    conv_match = re.search(r'conv(\d+)', config_str)
    if conv_match:
        raw = conv_match.group(1)
        parts["conviction"] = float(raw) / 10 if len(raw) <= 2 else float(raw) / 100
    else:
        parts["conviction"] = None

    # Hold time
    hold_match = re.search(r'(\d+min)', config_str)
    parts["hold_time"] = hold_match.group(1) if hold_match else "30min"

    # Latency
    lat_match = re.search(r'lat(\d+)', config_str)
    parts["latency_ms"] = int(lat_match.group(1)) if lat_match else 0

    return parts


@st.cache_data(ttl=300)
def get_oot_prediction_dates() -> list[str]:
    """Get list of dates available in the OOT predictions NPZ."""
    # Find the main OOT predictions file
    candidates = sorted(glob.glob(str(PREDICTIONS_DIR / "oos_predictions_book_oot_*.npz")))
    if not candidates:
        return []
    # Use the latest file — only read keys, don't load arrays
    data = np.load(candidates[-1], allow_pickle=True)
    dates = sorted(set(k.replace("_preds", "").replace("_mid", "") for k in data.files))
    data.close()
    return dates


@st.cache_data(ttl=300)
def get_oot_npz_path() -> Optional[str]:
    """Get path to the main OOT predictions NPZ file."""
    candidates = sorted(glob.glob(str(PREDICTIONS_DIR / "oos_predictions_book_oot_*.npz")))
    return candidates[-1] if candidates else None


@st.cache_data(ttl=600)
def simulate_config_day(npz_path: str, date: str, vol_pct: int, conviction_thr: float,
                        hold_bars: int, time_filter: str,
                        chase_ticks: int = 0, chase_reprices: int = 0) -> dict:
    """
    Simulate a single config on a single day using prediction + mid-price data.

    Returns dict with: trades (list), signals (list), daily_pnl, mid_prices (subsampled).
    Each trade has: entry_bar, exit_bar, direction, entry_price, exit_price, pnl_ticks, conviction.
    """
    data = np.load(npz_path, allow_pickle=True)
    preds_key = f"{date}_preds"
    mid_key = f"{date}_mid"
    if preds_key not in data or mid_key not in data:
        return {"trades": [], "signals": [], "daily_pnl": 0, "mid_prices": [], "bars": 0}

    preds = data[preds_key]
    mids = data[mid_key]
    n_bars = len(preds)

    # Time gates: bar indices for RTH (9:30-16:00 ET)
    # 100ms bars. RTH starts ~bar 0 (depends on data alignment).
    # morning_afternoon = skip first 30min and last 15min of RTH
    # RTH = 6.5 hours = 234,000 bars
    rth_bars = n_bars
    no_trade_open = 18000   # 30 min = 18,000 bars
    no_trade_close = 9000   # 15 min = 9,000 bars

    if time_filter in ("Morning+Afternoon", "morning_afternoon"):
        trade_start = no_trade_open
        trade_end = rth_bars - no_trade_close
    else:
        trade_start = 0
        trade_end = rth_bars

    # Compute rolling z-score and vol percentile
    window = 3000  # vol trailing window
    # Rolling std for vol
    if n_bars < window + 100:
        return {"trades": [], "signals": [], "daily_pnl": 0, "mid_prices": mids[::100].tolist(), "bars": n_bars}

    # Compute realized vol (rolling std of returns)
    returns = np.diff(mids) / np.maximum(mids[:-1], 1e-10)
    returns = np.insert(returns, 0, 0)

    # Rolling vol percentile (simplified)
    roll_vol = pd.Series(returns).rolling(window, min_periods=100).std().values

    # Rolling z-score of predictions
    roll_mean = pd.Series(preds).rolling(window, min_periods=50).mean().values
    roll_std = pd.Series(preds).rolling(window, min_periods=50).std().values
    roll_std = np.maximum(roll_std, 1e-10)
    z_scores = (preds - roll_mean) / roll_std

    # Vol percentile (rolling rank)
    vol_series = pd.Series(roll_vol)
    vol_pctile = vol_series.rolling(window, min_periods=100).rank(pct=True).values * 100

    # Generate signals and trades
    signals = []
    trades = []
    in_position = False
    position_exit_bar = 0

    # Subsample for signal scanning (every 10 bars = 1 second)
    scan_step = 10

    for i in range(trade_start, trade_end, scan_step):
        if np.isnan(z_scores[i]) or np.isnan(vol_pctile[i]):
            continue

        # Check if position expired
        if in_position and i >= position_exit_bar:
            in_position = False

        if in_position:
            continue

        # Vol gate
        if vol_pctile[i] < vol_pct:
            continue

        # Conviction gate
        abs_z = abs(z_scores[i])
        if abs_z < conviction_thr:
            continue

        direction = 1 if z_scores[i] > 0 else -1

        signals.append({
            "bar": int(i),
            "time_sec": round(i * 0.1, 1),
            "mid_price": round(float(mids[i]), 2),
            "raw_pred": round(float(preds[i]), 4),
            "z_score": round(float(z_scores[i]), 3),
            "conviction": round(float(abs_z), 3),
            "vol_pctile": round(float(vol_pctile[i]), 1),
            "direction": direction,
        })

        # Simulate trade (passive + optional chase)
        # For simplicity: assume fill at mid + 0.25 * direction (passive limit)
        # Fill probability based on historical ~9% fill rate
        # Simulate probabilistically using prediction strength
        fill_prob = 0.08 + (abs_z - conviction_thr) * 0.02  # Higher conviction = slightly better fill
        fill_prob = min(fill_prob, 0.20)

        # Deterministic simulation: fill if prediction is strong enough (top signals)
        # Use hash of bar index for deterministic "randomness"
        pseudo_random = ((i * 2654435761) % 1000) / 1000.0
        if pseudo_random > fill_prob:
            continue  # No fill

        entry_price = float(mids[i])
        exit_bar = min(i + hold_bars, n_bars - 1)

        # Chase: adjust entry slightly worse
        chase_cost = chase_ticks * 0.25 if chase_ticks > 0 else 0

        exit_price = float(mids[exit_bar])
        pnl_ticks = (exit_price - entry_price) / 0.25 * direction
        pnl_ticks -= 0.376  # Commission
        if chase_ticks > 0:
            pnl_ticks -= chase_cost / 0.25 * 0.5  # Half the chase cost on average

        trades.append({
            "entry_bar": int(i),
            "exit_bar": int(exit_bar),
            "entry_time_sec": round(i * 0.1, 1),
            "exit_time_sec": round(exit_bar * 0.1, 1),
            "direction": direction,
            "direction_str": "LONG" if direction == 1 else "SHORT",
            "entry_price": round(entry_price, 2),
            "exit_price": round(exit_price, 2),
            "pnl_ticks": round(pnl_ticks, 2),
            "pnl_dollars": round(pnl_ticks * ES_TICK_VALUE, 2),
            "conviction": round(float(abs_z), 3),
            "vol_pctile": round(float(vol_pctile[i]), 1),
            "z_score": round(float(z_scores[i]), 3),
        })

        in_position = True
        position_exit_bar = exit_bar

    daily_pnl = sum(t["pnl_dollars"] for t in trades)

    # Subsample mid prices, z-scores, and raw predictions for charting (every 100 bars = 10 sec)
    step = 100
    mid_sub = mids[::step].tolist()
    z_sub = np.nan_to_num(z_scores[::step], nan=0.0).tolist()
    raw_sub = np.nan_to_num(preds[::step], nan=0.0).tolist()

    return {
        "trades": trades,
        "signals": signals,
        "daily_pnl": round(daily_pnl, 2),
        "n_signals": len(signals),
        "n_trades": len(trades),
        "mid_prices": mid_sub,
        "z_scores": z_sub,          # Continuous z-score (normalized) series
        "raw_predictions": raw_sub,  # Continuous raw CNN output (un-normalized)
        "mid_step": step,
        "bars": n_bars,
        "date": date,
    }


@st.cache_data(ttl=300)
def load_aggregated_sweeps() -> list[dict]:
    """Load all aggregated sweep results into a unified list of dicts.

    Each dict has: config, sharpe, total_pnl, trades, win_rate, annualized_pnl,
                   n_days, fill_rate, source_sweep.
    """
    rows = []

    # 1) Norm sweep — prefer real metrics file with Rust sim profit_factor
    norm_real_path = DEEP_MODEL_RESULTS / "norm_sweep_real_metrics.json"
    norm_path = DEEP_MODEL_RESULTS / "norm_sweep_aggregated_full.json"
    chosen_norm = norm_real_path if norm_real_path.exists() else norm_path
    if chosen_norm.exists():
        with open(chosen_norm) as f:
            data = json.load(f)
        for r in data.get("results", []):
            row = {
                "config": r.get("config", ""),
                "sharpe": r.get("sharpe", 0),
                "total_pnl": r.get("total_pnl", 0),
                "trades": r.get("total_trades", 0),
                "win_rate": r.get("win_rate", 0),
                "annualized_pnl": r.get("annualized_pnl", 0),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill_rate", 0),
                "source_sweep": "Norm Sweep",
            }
            # Carry real profit_factor from Rust sim if available
            if "profit_factor" in r:
                row["profit_factor"] = r["profit_factor"]
            if "avg_win" in r and r["avg_win"] is not None:
                row["avg_win"] = r["avg_win"]
            if "avg_loss" in r and r["avg_loss"] is not None:
                row["avg_loss"] = r["avg_loss"]
            if "sharpe_per_trade" in r and r["sharpe_per_trade"] is not None:
                row["sharpe_per_trade"] = r["sharpe_per_trade"]
            rows.append(row)

    # 2) Hold sweep
    hold_path = DEEP_MODEL_RESULTS / "hold_sweep_aggregated.json"
    if hold_path.exists():
        with open(hold_path) as f:
            data = json.load(f)
        for r in data.get("summaries", []):
            cfg_label = r.get("label", "")
            vg = r.get("vg", "")
            config_str = f"{cfg_label}_{vg}" if vg else cfg_label
            rows.append({
                "config": config_str,
                "sharpe": r.get("sharpe", 0),
                "total_pnl": r.get("pnl", 0),
                "trades": r.get("trades", 0),
                "win_rate": r.get("wr", 0),
                "annualized_pnl": r.get("annual", 0),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill", 0),
                "source_sweep": "Hold Sweep",
            })

    # 3) Decay exit sweep
    decay_path = DEEP_MODEL_RESULTS / "decay_exit_aggregated.json"
    if decay_path.exists():
        with open(decay_path) as f:
            data = json.load(f)
        items = data.get("all_configs_sorted", data.get("results", data.get("summaries", [])))
        for r in items:
            rows.append({
                "config": r.get("config", ""),
                "sharpe": r.get("annualized_sharpe", r.get("daily_sharpe", 0)),
                "total_pnl": r.get("total_pnl", 0),
                "trades": r.get("total_trades", 0),
                "win_rate": r.get("win_rate", 0),
                "annualized_pnl": r.get("annualized_pnl", 0),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill_rate", 0),
                "source_sweep": "Decay Exit",
            })

    # 4) Exec sweep
    exec_path = DEEP_MODEL_RESULTS / "exec_sweep_aggregated.json"
    if exec_path.exists():
        with open(exec_path) as f:
            data = json.load(f)
        for r in data.get("summaries", []):
            cfg_label = r.get("label", "")
            vg = r.get("vg", "")
            config_str = f"{cfg_label}_{vg}" if vg else cfg_label
            rows.append({
                "config": config_str,
                "sharpe": r.get("sharpe", 0),
                "total_pnl": r.get("pnl", 0),
                "trades": r.get("trades", 0),
                "win_rate": r.get("wr", 0),
                "annualized_pnl": r.get("annual", 0),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill", 0),
                "source_sweep": "Exec Sweep",
            })

    # 5) Novel ideas sweep
    novel_path = DEEP_MODEL_RESULTS / "novel_ideas_aggregated.json"
    if novel_path.exists():
        with open(novel_path) as f:
            data = json.load(f)
        items = data.get("all_configs_sorted", data.get("results", data.get("summaries", [])))
        for r in items:
            rows.append({
                "config": r.get("config", r.get("label", "")),
                "sharpe": r.get("annualized_sharpe", r.get("daily_sharpe", r.get("sharpe", 0))),
                "total_pnl": r.get("total_pnl", r.get("pnl", 0)),
                "trades": r.get("total_trades", r.get("trades", 0)),
                "win_rate": r.get("win_rate", r.get("wr", 0)),
                "annualized_pnl": r.get("annualized_pnl", r.get("annual", 0)),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill_rate", r.get("fill", 0)),
                "source_sweep": "Novel Ideas",
            })

    # 6) Entry/exit matrix sweep
    matrix_path = DEEP_MODEL_RESULTS / "entry_exit_matrix_aggregated.json"
    if matrix_path.exists():
        with open(matrix_path) as f:
            data = json.load(f)
        items = data.get("all_configs_sorted", data.get("results", data.get("summaries", [])))
        for r in items:
            rows.append({
                "config": r.get("config", r.get("label", "")),
                "sharpe": r.get("annualized_sharpe", r.get("daily_sharpe", r.get("sharpe", 0))),
                "total_pnl": r.get("total_pnl", r.get("pnl", 0)),
                "trades": r.get("total_trades", r.get("trades", 0)),
                "win_rate": r.get("win_rate", r.get("wr", 0)),
                "annualized_pnl": r.get("annualized_pnl", r.get("annual", 0)),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill_rate", r.get("fill", 0)),
                "source_sweep": "Entry/Exit Matrix",
            })

    # 7) Stacked exit sweep
    stacked_path = DEEP_MODEL_RESULTS / "stacked_exit_aggregated.json"
    if stacked_path.exists():
        with open(stacked_path) as f:
            data = json.load(f)
        items = data.get("all_configs_sorted", data.get("results", data.get("summaries", [])))
        for r in items:
            rows.append({
                "config": r.get("config", r.get("label", "")),
                "sharpe": r.get("annualized_sharpe", r.get("daily_sharpe", r.get("sharpe", 0))),
                "total_pnl": r.get("total_pnl", r.get("pnl", 0)),
                "trades": r.get("total_trades", r.get("trades", 0)),
                "win_rate": r.get("win_rate", r.get("wr", 0)),
                "annualized_pnl": r.get("annualized_pnl", r.get("annual", 0)),
                "n_days": r.get("n_days", 0),
                "fill_rate": r.get("fill_rate", r.get("fill", 0)),
                "timeout_pct": r.get("timeout_pct", r.get("timeout_rate", None)),
                "source_sweep": "Stacked Exit",
            })

    return rows


def configs_to_dataframe(configs: list[dict], source_label: str) -> pd.DataFrame:
    """Convert a list of config result dicts to a well-labeled DataFrame."""
    if not configs:
        return pd.DataFrame()

    df = pd.DataFrame(configs)

    # Parse config names into components
    if "config" in df.columns:
        parsed = df["config"].apply(parse_config_name)
        parsed_df = pd.DataFrame(parsed.tolist())
        df = pd.concat([df, parsed_df], axis=1)

    # Add computed columns
    if "total_pnl" in df.columns and "n_days" in df.columns:
        df["annualized_pnl"] = (df["total_pnl"] / df["n_days"] * TRADING_DAYS_PER_YEAR).round(0)
    if "total_pnl" in df.columns and "n_trades" in df.columns:
        df["pnl_per_trade"] = (df["total_pnl"] / df["n_trades"].replace(0, 1)).round(2)
        df["ticks_per_trade"] = (df["pnl_per_trade"] / ES_TICK_VALUE).round(2)

    # Format percentages
    for col in ["fill_rate", "win_rate", "cancel_rate"]:
        if col in df.columns:
            df[f"{col}_pct"] = (df[col] * 100).round(1)

    df["data_source"] = source_label
    return df
