"""
fillsim_utils.py — Shared utilities for fill simulation scripts.

Provides:
- extract_pnl(): Robust PnL extraction from fill_sim JSON output
- extract_trades(): Robust trade count extraction
- extract_win_rate(): Robust win rate extraction
- clean_pnl_list(): Filter NaN/None from PnL lists before aggregation

Usage:
    from fillsim_utils import extract_pnl, clean_pnl_list

    result = json.load(open("fill_sim_output.json"))
    pnl = extract_pnl(result)  # handles all fill_sim versions
"""

import math


def extract_pnl(result_dict):
    """Robustly extract total PnL (dollars) from fill_sim JSON output.

    Handles multiple fill_sim output formats:
    - v1: {"total_pnl_dollars": ...}
    - v2: {"summary": {"total_pnl": ...}}
    - v3: {"total_pnl": ...}
    - various: {"pnl": ...}, {"net_pnl": ...}

    Returns float or None if not found.
    """
    if result_dict is None:
        return None
    for getter in [
        lambda d: d.get("total_pnl_dollars"),
        lambda d: (d.get("summary") or {}).get("total_pnl"),
        lambda d: d.get("total_pnl"),
        lambda d: d.get("pnl"),
        lambda d: d.get("net_pnl"),
    ]:
        val = getter(result_dict)
        if val is not None and not (isinstance(val, float) and (math.isnan(val) or math.isinf(val))):
            return float(val)
    return None


def extract_trades(result_dict):
    """Robustly extract total trade count from fill_sim JSON output.

    Returns int or 0 if not found.
    """
    if result_dict is None:
        return 0
    for getter in [
        lambda d: d.get("total_trades"),
        lambda d: d.get("total_filled"),
        lambda d: (d.get("summary") or {}).get("n_trades"),
        lambda d: d.get("n_trades"),
        lambda d: d.get("num_trades"),
    ]:
        val = getter(result_dict)
        if val is not None and isinstance(val, (int, float)) and val > 0:
            return int(val)
    return 0


def extract_win_rate(result_dict):
    """Robustly extract win rate from fill_sim JSON output.

    Returns float (0.0-1.0 range) or None if not found.
    """
    if result_dict is None:
        return None
    for getter in [
        lambda d: d.get("win_rate"),
        lambda d: (d.get("summary") or {}).get("win_rate"),
        lambda d: d.get("wr"),
    ]:
        val = getter(result_dict)
        if val is not None and not (isinstance(val, float) and math.isnan(val)):
            return float(val)

    # Try computing from wins/total
    total = extract_trades(result_dict)
    if total > 0:
        wins = None
        for key in ["total_wins", "n_wins", "wins"]:
            w = result_dict.get(key)
            if w is None:
                w = (result_dict.get("summary") or {}).get(key)
            if w is not None:
                wins = int(w)
                break
        if wins is not None:
            return wins / total

    return None


def clean_pnl_list(pnl_list):
    """Filter None and NaN values from a PnL list.

    Returns: (clean_list, n_removed)
    """
    clean = []
    removed = 0
    for v in pnl_list:
        if v is None:
            removed += 1
        elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            removed += 1
        else:
            clean.append(float(v))
    return clean, removed


# ES futures constants
ES_TICK_SIZE = 0.25      # points per tick
ES_TICK_VALUE = 12.50    # dollars per tick
ES_POINT_VALUE = 50.0    # dollars per point
ES_MID_TICK = 0.125      # mid-price resolution (half-tick)
ES_MID_TICK_VALUE = 6.25  # dollars per mid-tick
