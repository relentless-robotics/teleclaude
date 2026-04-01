#!/usr/bin/env python3
"""
LGBM GPU Feature Sweep -- Razer RTX 3070
=========================================
Sweep feature engineering strategies using GPU-accelerated LightGBM.
Tests: vol regimes, interaction terms, time-of-day, rolling windows.
Goal: Find IC > 0.05 with positive Sortino using GPU for speed.
"""

import os, sys, glob, time, warnings, json
import numpy as np
from pathlib import Path
from datetime import datetime

warnings.filterwarnings('ignore')

try:
    import lightgbm as lgb
    USE_LGB = True
    print("[OK] LightGBM available")
except ImportError:
    print("[ERROR] LightGBM not found")
    sys.exit(1)

from scipy.stats import spearmanr

# ============================================================
# CONFIG
# ============================================================
POSSIBLE_DIRS = [
    r"C:\Users\claude\Documents\Lvl3Quant\data\processed\dl_book_cache",
    r"C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache",
    r"/home/jupiter/Lvl3Quant/data/processed/dl_book_cache",
]
DATA_DIR = None
for d in POSSIBLE_DIRS:
    if os.path.isdir(d):
        # Verify it has book_tensors (not just predictions)
        test_files = glob.glob(os.path.join(d, "*book_tensors.npz"))
        if test_files:
            DATA_DIR = d
            break
if DATA_DIR is None:
    print("[ERROR] No data directory with book_tensors.npz found")
    sys.exit(1)
print(f"[DATA] {DATA_DIR}")

FORWARD_BARS = 100      # 10s at 100ms
COST_RT = 1.0           # round-trip ticks
TP = 8.0
SL = 8.0
SUBSAMPLE = 5           # Every 5th bar

TRAIN_DAYS = 40
VAL_DAYS = 20
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lgbm_gpu_sweep_results.json")


def make_lgb_params(use_gpu=True):
    p = dict(
        objective="regression",
        metric="mse",
        n_estimators=300,
        max_depth=6,
        num_leaves=63,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_samples=100,
        reg_alpha=0.1,
        reg_lambda=1.0,
        verbose=-1,
    )
    if use_gpu:
        p["device"] = "gpu"
        p["gpu_platform_id"] = 0
        p["gpu_device_id"] = 0
    else:
        p["n_jobs"] = -1
    return p


BARS_FOR_RETURN = 100  # 100 bars * 100ms = 10 seconds

def load_day(npz_path, subsample=1):
    try:
        d = np.load(npz_path)
        if "book_tensors" not in d:
            return None, None
        tensors = d["book_tensors"]   # (N, 20, 4)
        mid = d["mid_prices"]         # (N,)
        # Compute signed forward return in ticks (1 tick = 0.25 for ES)
        TICK_SIZE = 0.25
        fwd_ret = np.full(len(mid), np.nan)
        fwd_ret[:-BARS_FOR_RETURN] = (mid[BARS_FOR_RETURN:] - mid[:-BARS_FOR_RETURN]) / TICK_SIZE
        # Clip outliers
        fwd_ret = np.clip(fwd_ret, -20, 20)
        # Subsample
        idx = np.arange(0, len(tensors) - BARS_FOR_RETURN, subsample)
        return tensors[idx], fwd_ret[idx]
    except Exception as e:
        return None, None


def make_features(tensors):
    bids = tensors[:, :10, :]
    asks = tensors[:, 10:, :]

    bid_prices = bids[:, :, 0]
    ask_prices = asks[:, :, 0]
    bid_depths = bids[:, :, 1]
    ask_depths = asks[:, :, 1]
    bid_counts = bids[:, :, 2]
    ask_counts = asks[:, :, 2]
    bid_age = bids[:, :, 3]
    ask_age = asks[:, :, 3]

    feats = {}

    # L1 imbalance
    feats["imb_L1"] = (bid_depths[:, 0] - ask_depths[:, 0]) / (bid_depths[:, 0] + ask_depths[:, 0] + 1e-8)
    feats["depth_ratio_L1"] = bid_depths[:, 0] / (ask_depths[:, 0] + 1e-8)
    feats["count_imb_L1"] = (bid_counts[:, 0] - ask_counts[:, 0]) / (bid_counts[:, 0] + ask_counts[:, 0] + 1e-8)

    # Deep imbalance
    bid_d5 = bid_depths[:, :5].sum(axis=1)
    ask_d5 = ask_depths[:, :5].sum(axis=1)
    feats["imb_deep5"] = (bid_d5 - ask_d5) / (bid_d5 + ask_d5 + 1e-8)

    bid_total = bid_depths.sum(axis=1)
    ask_total = ask_depths.sum(axis=1)
    feats["imb_full"] = (bid_total - ask_total) / (bid_total + ask_total + 1e-8)
    feats["total_depth"] = bid_total + ask_total
    feats["total_count"] = bid_counts.sum(axis=1) + ask_counts.sum(axis=1)

    # Queue age
    feats["bid_age_L1"] = bid_age[:, 0]
    feats["ask_age_L1"] = ask_age[:, 0]
    feats["age_imb"] = (bid_age[:, 0] - ask_age[:, 0]) / (bid_age[:, 0] + ask_age[:, 0] + 1e-8)
    feats["age_imb_deep"] = bid_age[:, :5].mean(axis=1) - ask_age[:, :5].mean(axis=1)

    # Wall detection
    bid_wall = bid_depths.max(axis=1)
    ask_wall = ask_depths.max(axis=1)
    feats["bid_wall_ratio"] = bid_wall / (bid_total + 1e-8)
    feats["ask_wall_ratio"] = ask_wall / (ask_total + 1e-8)
    feats["wall_diff"] = feats["bid_wall_ratio"] - feats["ask_wall_ratio"]

    # Price features
    feats["bid_L1_rel"] = bid_prices[:, 0]
    feats["ask_L1_rel"] = ask_prices[:, 0]
    feats["spread_proxy"] = ask_prices[:, 0] - bid_prices[:, 0]

    # Concentration
    feats["bid_conc"] = bid_depths[:, 0] / (bid_total + 1e-8)
    feats["ask_conc"] = ask_depths[:, 0] / (ask_total + 1e-8)
    feats["conc_imb"] = feats["bid_conc"] - feats["ask_conc"]

    # Interactions
    feats["imb_x_wall"] = feats["imb_L1"] * feats["wall_diff"]
    feats["imb_x_age"] = feats["imb_L1"] * feats["age_imb"]
    feats["imb_deep_x_wall"] = feats["imb_deep5"] * feats["wall_diff"]
    feats["count_imb_deep5"] = (
        (bid_counts[:, :5].sum(axis=1) - ask_counts[:, :5].sum(axis=1))
        / (feats["total_count"] + 1e-8)
    )

    # Vol proxy (depth variance)
    feats["depth_var_bid"] = bid_depths.var(axis=1)
    feats["depth_var_ask"] = ask_depths.var(axis=1)
    feats["depth_var_ratio"] = feats["depth_var_bid"] / (feats["depth_var_ask"] + 1e-8)

    return np.column_stack(list(feats.values())), list(feats.keys())


def compute_sortino(daily_pnl):
    if len(daily_pnl) < 2:
        return 0.0
    mean = np.mean(daily_pnl)
    down = daily_pnl[daily_pnl < 0]
    if len(down) < 2:
        return float('inf') if mean > 0 else 0.0
    return float(mean / (np.std(down) + 1e-8) * np.sqrt(252))


def pnl_sim(preds, targets, threshold_pct=75):
    threshold = np.percentile(np.abs(preds), threshold_pct)
    signals = np.where(np.abs(preds) > threshold, np.sign(preds), 0.0)
    net = signals * targets - np.abs(signals) * COST_RT
    active = signals != 0
    if active.sum() < 10:
        return {"sortino": -999.0, "win_rate": 0.0, "n_trades": 0, "total_ticks": 0.0}
    net_active = net[active]
    chunk = max(1, len(net_active) // 20)
    daily_pnl = np.array([net_active[i:i+chunk].sum() for i in range(0, len(net_active), chunk)])
    return {
        "sortino": compute_sortino(daily_pnl),
        "win_rate": float((net_active > 0).mean()),
        "n_trades": int(active.sum()),
        "total_ticks": float(net_active.sum()),
    }


def main():
    t0 = time.time()

    all_files = sorted(glob.glob(os.path.join(DATA_DIR, "*book_tensors.npz")))
    if not all_files:
        print(f"[ERROR] No .npz files in {DATA_DIR}")
        sys.exit(1)
    print(f"[DATA] Found {len(all_files)} days")

    n = len(all_files)
    if n < TRAIN_DAYS + VAL_DAYS:
        train_files = all_files[:max(1, n - VAL_DAYS)]
        val_files = all_files[max(1, n - VAL_DAYS):]
    else:
        train_files = all_files[-(TRAIN_DAYS + VAL_DAYS):-VAL_DAYS]
        val_files = all_files[-VAL_DAYS:]

    print(f"[SPLIT] Train: {len(train_files)} days | Val: {len(val_files)} days")

    print("[LOADING] Training data...")
    train_X_parts, train_y_parts = [], []
    feat_names = None
    for f in train_files:
        tensors, targets = load_day(f, SUBSAMPLE)
        if tensors is not None:
            X, names = make_features(tensors)
            if feat_names is None:
                feat_names = names
            mask = np.isfinite(targets) & np.all(np.isfinite(X), axis=1)
            train_X_parts.append(X[mask])
            train_y_parts.append(targets[mask])

    if not train_X_parts:
        print("[ERROR] No training data")
        sys.exit(1)

    train_X = np.vstack(train_X_parts)
    train_y = np.concatenate(train_y_parts)
    print(f"[TRAIN] {train_X.shape[0]:,} samples, {train_X.shape[1]} features")
    print(f"[TRAIN] Target: mean={train_y.mean():.4f}, std={train_y.std():.4f}")

    print("[LOADING] Validation data...")
    val_parts_X, val_parts_y, val_dates = [], [], []
    for f in val_files:
        tensors, targets = load_day(f, SUBSAMPLE)
        if tensors is not None:
            X, _ = make_features(tensors)
            mask = np.isfinite(targets) & np.all(np.isfinite(X), axis=1)
            val_parts_X.append(X[mask])
            val_parts_y.append(targets[mask])
            val_dates.append(os.path.basename(f).replace('.npz', ''))
    val_X = np.vstack(val_parts_X)
    val_y = np.concatenate(val_parts_y)
    print(f"[VAL] {val_X.shape[0]:,} samples across {len(val_parts_X)} days")

    # Try GPU, fall back to CPU
    use_gpu = True
    for attempt in range(2):
        try:
            params = make_lgb_params(use_gpu=use_gpu)
            print(f"[TRAIN] Training with {'GPU' if use_gpu else 'CPU'}...")
            t1 = time.time()
            model = lgb.LGBMRegressor(**params)
            model.fit(
                train_X, train_y,
                eval_set=[(val_X, val_y)],
                callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)]
            )
            print(f"[TRAIN] Done in {time.time()-t1:.1f}s | GPU={use_gpu}")
            break
        except Exception as e:
            if use_gpu and attempt == 0:
                print(f"[WARN] GPU failed: {e} -- falling back to CPU")
                use_gpu = False
            else:
                print(f"[ERROR] Training failed: {e}")
                sys.exit(1)

    # Per-day validation
    val_ics, val_sortinos = [], []
    print("\n[VAL] Per-day results:")
    print(f"{'Date':<15} {'IC':>8} {'n_trades':>9} {'Sortino':>9}")
    print("-" * 45)

    for X_d, y_d, date in zip(val_parts_X, val_parts_y, val_dates):
        if len(y_d) < 10:
            continue
        preds = model.predict(X_d)
        ic, _ = spearmanr(preds, y_d)
        ic = ic if np.isfinite(ic) else 0.0
        val_ics.append(ic)
        sim = pnl_sim(preds, y_d)
        val_sortinos.append(sim["sortino"])
        print(f"{date:<15} {ic:>8.4f} {sim['n_trades']:>9,} {sim['sortino']:>9.3f}")

    mean_ic = float(np.mean(val_ics)) if val_ics else 0.0
    ic_std = float(np.std(val_ics)) if val_ics else 0.0
    ic_ir = float(mean_ic / (ic_std + 1e-8)) if val_ics else 0.0
    mean_sortino = float(np.mean([s for s in val_sortinos if s > -900])) if val_sortinos else 0.0
    pct_positive = float(100 * np.mean([ic > 0 for ic in val_ics])) if val_ics else 0.0

    importances = model.feature_importances_
    idx_sorted = np.argsort(importances)[::-1]

    print(f"\n[SUMMARY]")
    print(f"  GPU used:     {use_gpu}")
    print(f"  Mean IC:      {mean_ic:.4f}")
    print(f"  IC IR:        {ic_ir:.4f}")
    print(f"  IC positive:  {pct_positive:.0f}%")
    print(f"  Mean Sortino: {mean_sortino:.4f}")
    print(f"  Total time:   {time.time()-t0:.1f}s")
    print(f"\n[TOP FEATURES]")
    for rank, i in enumerate(idx_sorted[:10], 1):
        print(f"  {rank:2d}. {feat_names[i]:<25} importance={importances[i]:.0f}")

    verdict = ("PROMISING" if mean_ic > 0.04 and mean_sortino > 0.1
               else "MARGINAL" if mean_ic > 0.02
               else "NO_SIGNAL")
    print(f"\n[VERDICT] {verdict}")

    results = {
        "timestamp": datetime.now().isoformat(),
        "gpu_used": use_gpu,
        "train_days": len(train_files),
        "val_days": len(val_files),
        "mean_ic": mean_ic,
        "ic_ir": ic_ir,
        "pct_positive_ic": pct_positive,
        "mean_sortino": mean_sortino,
        "per_day_ic": val_ics,
        "per_day_sortino": val_sortinos,
        "top_features": [feat_names[i] for i in idx_sorted[:10]],
        "verdict": verdict,
    }
    with open(OUTPUT_FILE, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n[SAVED] {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
