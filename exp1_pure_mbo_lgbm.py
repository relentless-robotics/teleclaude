#!/usr/bin/env python3
"""
Experiment 1: Pure MBO LGBM — OOT Period (Dec 2025 - Mar 2026)
================================================================
Question: Can temporal market microstructure features alone predict 10-second
ES returns WITHOUT any CNN information?

Data: dl_book_cache_oot (Dec 2025 - Mar 2026, 68 days)
Features: Book tensor microstructure (same as lgbm_mfe_mae.py engineer_features)
          + temporal rolling features (short-term momentum, volume velocity)
Target: 10s signed return (100 bars @ 100ms)
Method: LGBM walk-forward — train on first 45 days, test on last ~20 days
        Also run 3-fold OOT walk-forward for robustness

Output: C:\\Users\\claude\\Lvl3Quant\\scripts\\exp1_mbo_lgbm_results.json
        C:\\Users\\claude\\Lvl3Quant\\scripts\\exp1_mbo_lgbm_output.log
"""

import os
import sys
import glob
import json
import time
import warnings
import numpy as np
from datetime import datetime

warnings.filterwarnings("ignore")

# ─── Setup ───────────────────────────────────────────────────────────────────
LOG_FILE = r'C:\Users\claude\Lvl3Quant\scripts\exp1_mbo_lgbm_output.log'
ERR_FILE = r'C:\Users\claude\Lvl3Quant\scripts\exp1_mbo_lgbm_stderr.log'
OUT_JSON = r'C:\Users\claude\Lvl3Quant\scripts\exp1_mbo_lgbm_results.json'

def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)

log("=" * 60)
log("Experiment 1: Pure MBO LGBM — OOT Period")
log("=" * 60)

try:
    import lightgbm as lgb
    log(f"LightGBM {lgb.__version__} available")
except ImportError:
    log("ERROR: LightGBM not installed!")
    sys.exit(1)

from scipy.stats import spearmanr

# ─── Config ──────────────────────────────────────────────────────────────────
BOOK_CACHE_OOT = r'C:\Users\claude\Documents\Lvl3Quant\data\processed\dl_book_cache_oot'
FORWARD_BARS   = 100        # 10s @ 100ms
TICK_SIZE      = 0.25       # ES
SUBSAMPLE      = 3          # every 3rd bar → ~78k bars/day
TRAIN_FRAC     = 0.66       # ~45 days train, ~23 days test
ROLL_WINDOWS   = [10, 50, 200, 1000]  # rolling windows for temporal features (bars)

# LGB params — GPU mode
LGB_PARAMS_BASE = dict(
    n_estimators=600,
    max_depth=6,
    num_leaves=47,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_samples=200,
    reg_alpha=0.1,
    reg_lambda=1.0,
    verbose=-1,
    n_jobs=-1,
)

# Try GPU
try:
    test_params = dict(**LGB_PARAMS_BASE, device="gpu", gpu_platform_id=0, gpu_device_id=0)
    test_data = lgb.Dataset(np.random.randn(500, 5), label=np.random.randn(500))
    lgb.train(test_params, test_data, num_boost_round=3, valid_sets=[test_data])
    DEVICE_PARAMS = {"device": "gpu", "gpu_platform_id": 0, "gpu_device_id": 0}
    log("GPU mode enabled")
except Exception as e:
    DEVICE_PARAMS = {}
    log(f"GPU failed ({e}), using CPU")

LGB_PARAMS = {**LGB_PARAMS_BASE, **DEVICE_PARAMS}

# ─── Feature Engineering ─────────────────────────────────────────────────────

def engineer_features_book(book: np.ndarray) -> tuple:
    """
    book: (N, 20, 4) — raw book tensor
    Returns: (features: np.ndarray (N, F), feature_names: list[str])
    """
    N = book.shape[0]
    bid_depth  = book[:, :10, 1]
    ask_depth  = book[:, 10:, 1]
    bid_counts = book[:, :10, 2]
    ask_counts = book[:, 10:, 2]
    bid_ages   = book[:, :10, 3]
    ask_ages   = book[:, 10:, 3]
    bid_prices = book[:, :10, 0]
    ask_prices = book[:, 10:, 0]

    eps = 1e-8
    features, names = [], []

    # L1 imbalance (core signal)
    bid1 = bid_depth[:, 0]; ask1 = ask_depth[:, 0]
    features.append(bid1 / (bid1 + ask1 + eps)); names.append("imb_L1")

    # Top-3 imbalance
    top3b = bid_depth[:, :3].sum(axis=1); top3a = ask_depth[:, :3].sum(axis=1)
    features.append(top3b / (top3b + top3a + eps)); names.append("imb_top3")

    # All-level imbalance
    total_bid = bid_depth.sum(axis=1); total_ask = ask_depth.sum(axis=1)
    features.append(total_bid / (total_bid + total_ask + eps)); names.append("imb_all")

    # Deep book imbalance
    deep_b = bid_depth[:, 5:].sum(axis=1); deep_a = ask_depth[:, 5:].sum(axis=1)
    features.append(deep_b / (deep_b + deep_a + eps)); names.append("imb_deep")

    # Imbalance gradient (near vs far)
    near_imb = top3b / (top3b + top3a + eps)
    far_imb = deep_b / (deep_b + deep_a + eps)
    features.append(near_imb - far_imb); names.append("imb_gradient")

    # L2-5 imbalance
    b25 = bid_depth[:, 1:5].sum(axis=1); a25 = ask_depth[:, 1:5].sum(axis=1)
    features.append(b25 / (b25 + a25 + eps)); names.append("imb_L2_5")

    # Spread
    spread = ask_prices[:, 0] - bid_prices[:, 0]
    features.append(spread); names.append("spread_ticks")

    # Weighted mid deviation from arithmetic mid
    arith_mid = (bid_prices[:, 0] + ask_prices[:, 0]) / 2.0
    wmid = (bid1 * ask_prices[:, 0] + ask1 * bid_prices[:, 0]) / (bid1 + ask1 + eps)
    features.append(wmid - arith_mid); names.append("wmid_dev")

    # Depth ratios
    features.append(bid1 / (ask1 + eps)); names.append("dr_L1")
    b15 = bid_depth[:, :5].sum(axis=1); a15 = ask_depth[:, :5].sum(axis=1)
    features.append(b15 / (a15 + eps)); names.append("dr_L5")

    # Order count imbalance
    oc_b = bid_counts.sum(axis=1); oc_a = ask_counts.sum(axis=1)
    features.append(oc_b / (oc_a + eps)); names.append("oc_imb")
    oc_b1 = bid_counts[:, 0]; oc_a1 = ask_counts[:, 0]
    features.append(oc_b1 / (oc_a1 + eps)); names.append("oc_imb_L1")

    # Queue age asymmetry
    features.append(bid_ages.mean(axis=1) - ask_ages.mean(axis=1)); names.append("qa_imb")
    features.append(bid_ages[:, 0] - ask_ages[:, 0]); names.append("qa_L1")

    # Total depth and concentration
    features.append(np.log1p(total_bid + total_ask)); names.append("log_total_depth")
    all_d = np.concatenate([bid_depth, ask_depth], axis=1)
    features.append(all_d.max(axis=1) / (total_bid + total_ask + eps)); names.append("depth_conc")

    # Depth slopes
    bid_slope = (bid_depth[:, 4] - bid_depth[:, 0]) / 5.0
    ask_slope = (ask_depth[:, 4] - ask_depth[:, 0]) / 5.0
    features.append(bid_slope); names.append("bid_slope")
    features.append(ask_slope); names.append("ask_slope")
    features.append(bid_slope - ask_slope); names.append("slope_diff")

    # L1 skew vs L1-5 avg
    bid_skew = bid_depth[:, 0] / (bid_depth[:, :5].mean(axis=1) + eps)
    ask_skew = ask_depth[:, 0] / (ask_depth[:, :5].mean(axis=1) + eps)
    features.append(bid_skew - ask_skew); names.append("skew_diff")

    # Queue age concentration
    age_conc_b = bid_ages[:, 0] / (bid_ages.mean(axis=1) + eps)
    age_conc_a = ask_ages[:, 0] / (ask_ages.mean(axis=1) + eps)
    features.append(age_conc_b - age_conc_a); names.append("age_conc_diff")

    return np.column_stack(features).astype(np.float32), names


def add_rolling_features(X: np.ndarray, mid: np.ndarray, names: list) -> tuple:
    """
    Add temporal rolling features: mid-price momentum, imbalance MA, vol
    X: (N, F), mid: (N,)
    """
    N = len(X)
    extra, extra_names = [], []

    # Mid-price returns at different lags
    for w in [10, 50, 200]:
        ret = np.zeros(N, dtype=np.float32)
        ret[w:] = (mid[w:] - mid[:-w]) / (mid[:-w] + 1e-8)
        extra.append(ret); extra_names.append(f"ret_{w}b")

    # Rolling imbalance (first feature = imb_L1, col 0)
    imb_l1 = X[:, 0].copy()
    for w in [50, 200, 1000]:
        roll = np.zeros(N, dtype=np.float32)
        for i in range(w, N):
            roll[i] = imb_l1[i-w:i].mean()
        extra.append(imb_l1 - roll); extra_names.append(f"imb_L1_dev_{w}")

    # Rolling realized volatility (std of mid returns over window)
    raw_ret = np.zeros(N, dtype=np.float32)
    raw_ret[1:] = (mid[1:] - mid[:-1]) / (mid[:-1] + 1e-8)
    for w in [50, 200]:
        rvol = np.zeros(N, dtype=np.float32)
        for i in range(w, N):
            rvol[i] = raw_ret[i-w:i].std()
        extra.append(rvol); extra_names.append(f"rvol_{w}b")

    extra_arr = np.column_stack(extra).astype(np.float32)
    return np.hstack([X, extra_arr]), names + extra_names


# ─── Target computation ───────────────────────────────────────────────────────

def compute_target_10s(mid: np.ndarray) -> np.ndarray:
    """10s signed return in ticks (100 bars @ 100ms)."""
    N = len(mid)
    target = np.full(N, np.nan, dtype=np.float32)
    target[:N-FORWARD_BARS] = (mid[FORWARD_BARS:] - mid[:N-FORWARD_BARS]) / TICK_SIZE
    return target


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_days_oot(files):
    """Load OOT book tensor files, engineer features, return (X, y, dates)."""
    X_list, y_list, day_idx_list = [], [], []
    day_count = 0

    for f in files:
        fname = os.path.basename(f)
        date_str = fname[:10]
        try:
            d = np.load(f, allow_pickle=True)
        except Exception as e:
            log(f"  WARN: {fname} failed: {e}")
            continue

        book = d["book_tensors"]    # (234000, 20, 4)
        mid  = d["mid_prices"].astype(np.float64)
        N = min(len(book), len(mid))
        book = book[:N]; mid = mid[:N]

        # Subsample indices
        idx = np.arange(0, N - FORWARD_BARS, SUBSAMPLE)
        if len(idx) < 1000:
            log(f"  SKIP: {date_str} too few samples ({len(idx)})")
            continue

        # Engineer features
        X_raw, feat_names = engineer_features_book(book[idx])
        mid_sub = mid[idx]

        # Add rolling features (using subsampled mid)
        X_feat, all_names = add_rolling_features(X_raw, mid_sub, feat_names)

        # Compute targets
        y = compute_target_10s(mid)[idx]
        valid = ~np.isnan(y) & np.all(np.isfinite(X_feat), axis=1)
        X_feat = X_feat[valid]
        y = y[valid]

        if len(y) < 100:
            continue

        X_list.append(X_feat)
        y_list.append(y)
        day_idx_list.append(day_count * np.ones(len(y), dtype=np.int32))
        day_count += 1

        log(f"  Loaded {date_str}: {len(y)} samples, {X_feat.shape[1]} features")

    if not X_list:
        return None, None, None, None

    return (np.vstack(X_list), np.concatenate(y_list),
            np.concatenate(day_idx_list), all_names)


# ─── Walk-forward evaluation ──────────────────────────────────────────────────

def walk_forward_eval(X, y, day_idx, feat_names, n_folds=3):
    """
    Walk-forward evaluation: split into n_folds.
    Each fold: train on all prior data, test on next chunk.
    """
    max_day = day_idx.max()
    fold_size = max_day // (n_folds + 1)

    results = []
    for fold in range(n_folds):
        train_cutoff = int((fold + 1) * fold_size)
        test_start   = train_cutoff
        test_end     = int((fold + 2) * fold_size)

        tr_mask = day_idx < train_cutoff
        te_mask = (day_idx >= test_start) & (day_idx < test_end)

        X_tr, y_tr = X[tr_mask], y[tr_mask]
        X_te, y_te = X[te_mask], y[te_mask]

        if len(X_tr) < 5000 or len(X_te) < 1000:
            log(f"  Fold {fold+1}: not enough data (tr={len(X_tr)}, te={len(X_te)})")
            continue

        log(f"  Fold {fold+1}: train={len(X_tr):,} / test={len(X_te):,} samples")

        train_ds = lgb.Dataset(X_tr, label=y_tr)
        val_ds   = lgb.Dataset(X_te, label=y_te, reference=train_ds)
        t0 = time.time()
        model = lgb.train(
            LGB_PARAMS, train_ds,
            valid_sets=[val_ds],
            callbacks=[lgb.log_evaluation(period=200)],
        )
        elapsed = time.time() - t0

        preds = model.predict(X_te)
        ic, _ = spearmanr(y_te, preds)
        log(f"  Fold {fold+1} IC={ic:.4f} ({elapsed:.1f}s)")

        # Per-day IC for fold
        test_day_idx = day_idx[te_mask]
        daily_ics = []
        for d in np.unique(test_day_idx):
            dm = test_day_idx == d
            if dm.sum() >= 100:
                ic_d, _ = spearmanr(y_te[dm], preds[dm])
                daily_ics.append(ic_d)

        results.append({
            "fold": fold + 1,
            "ic_spearman": float(ic),
            "daily_ic_mean": float(np.mean(daily_ics)) if daily_ics else None,
            "daily_ic_std": float(np.std(daily_ics)) if daily_ics else None,
            "daily_ic_pct_positive": float(np.mean(np.array(daily_ics) > 0)) if daily_ics else None,
            "n_train": int(len(X_tr)),
            "n_test": int(len(X_te)),
            "train_sec": float(elapsed),
        })

    return results


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    start_time = time.time()
    log(f"START: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # Load OOT book files
    files = sorted(glob.glob(os.path.join(BOOK_CACHE_OOT, "*_book_tensors.npz")))
    log(f"Found {len(files)} OOT days in {BOOK_CACHE_OOT}")
    if len(files) == 0:
        log("ERROR: No files found!")
        sys.exit(1)

    log(f"Loading {len(files)} days (subsample={SUBSAMPLE})...")
    X, y, day_idx, feat_names = load_days_oot(files)

    if X is None:
        log("ERROR: No data loaded!")
        sys.exit(1)

    n_days = day_idx.max() + 1
    log(f"Total: {len(X):,} samples, {X.shape[1]} features, {n_days} days")
    log(f"Target stats: mean={y.mean():.4f}, std={y.std():.4f}")

    # Walk-forward evaluation
    log("\n=== Walk-forward evaluation (3 folds) ===")
    wf_results = walk_forward_eval(X, y, day_idx, feat_names, n_folds=3)

    # Simple train/test split (last 20 days test)
    log("\n=== Simple train/test split (last 20 days test) ===")
    n_days_test = min(20, n_days // 4)
    test_cutoff = n_days - n_days_test
    tr_mask = day_idx < test_cutoff
    te_mask = day_idx >= test_cutoff

    X_tr, y_tr = X[tr_mask], y[tr_mask]
    X_te, y_te = X[te_mask], y[te_mask]
    log(f"Train: {len(X_tr):,} samples ({test_cutoff} days) | Test: {len(X_te):,} ({n_days_test} days)")

    train_ds = lgb.Dataset(X_tr, label=y_tr)
    val_ds   = lgb.Dataset(X_te, label=y_te, reference=train_ds)
    t0 = time.time()
    model = lgb.train(
        LGB_PARAMS, train_ds,
        valid_sets=[val_ds],
        callbacks=[lgb.log_evaluation(period=100)],
    )
    elapsed = time.time() - t0

    preds = model.predict(X_te)
    ic_overall, _ = spearmanr(y_te, preds)
    log(f"FINAL IC (Spearman) = {ic_overall:.4f} ({elapsed:.1f}s)")

    # Per-day IC
    test_day_idx = day_idx[te_mask]
    daily_ics = []
    for d_i in np.unique(test_day_idx):
        dm = test_day_idx == d_i
        if dm.sum() >= 100:
            ic_d, _ = spearmanr(y_te[dm], preds[dm])
            daily_ics.append(float(ic_d))
    log(f"Per-day IC: mean={np.mean(daily_ics):.4f}, std={np.std(daily_ics):.4f}, "
        f"pct_positive={np.mean(np.array(daily_ics)>0)*100:.1f}%")

    # Feature importance
    importance = dict(zip(feat_names, model.feature_importance(importance_type='gain').tolist()))
    top10 = sorted(importance.items(), key=lambda x: -x[1])[:10]
    log("\nTop-10 features by gain:")
    for fname, imp in top10:
        log(f"  {fname}: {imp:.1f}")

    # Save results
    results = {
        "experiment": "exp1_pure_mbo_lgbm",
        "timestamp": datetime.now().isoformat(),
        "config": {
            "n_days": int(n_days),
            "n_samples_total": int(len(X)),
            "n_features": int(X.shape[1]),
            "subsample": SUBSAMPLE,
            "forward_bars": FORWARD_BARS,
            "train_days": int(test_cutoff),
            "test_days": int(n_days_test),
        },
        "main_result": {
            "ic_spearman": float(ic_overall),
            "daily_ic_mean": float(np.mean(daily_ics)),
            "daily_ic_std": float(np.std(daily_ics)),
            "daily_ic_pct_positive": float(np.mean(np.array(daily_ics) > 0)),
            "train_sec": float(elapsed),
        },
        "walk_forward": wf_results,
        "top_features": {k: float(v) for k, v in top10},
        "total_elapsed": float(time.time() - start_time),
    }

    with open(OUT_JSON, 'w') as f:
        json.dump(results, f, indent=2)
    log(f"\nResults saved to {OUT_JSON}")

    log("\n=== SUMMARY ===")
    log(f"Pure MBO LGBM IC (OOT): {ic_overall:.4f}")
    log(f"Daily IC: {np.mean(daily_ics):.4f} ± {np.std(daily_ics):.4f}")
    log(f"Pct positive days: {np.mean(np.array(daily_ics)>0)*100:.1f}%")
    log(f"Walk-forward ICs: {[r['ic_spearman'] for r in wf_results]}")
    log(f"Total time: {(time.time()-start_time)/60:.1f} min")
    log("DONE")


if __name__ == '__main__':
    main()
