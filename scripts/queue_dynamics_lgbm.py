#!/usr/bin/env python3
"""
queue_dynamics_lgbm.py — Queue Dynamics Feature IC Study
=========================================================
Hypothesis: Dynamic queue behavior features (build/deplete rates, asymmetric
replenishment, cancellation proxies) add IC beyond the static 13-feature set.

Our current best: Top 13 features (IC>0.045) = IC=0.0795, IR=2.169, 100% pos days.
Target: Can queue dynamics features push IC > 0.090?

New features tested:
  QUEUE DYNAMICS SET (5 new features):
  - queue_build_rate_bid : rate at which bid L1 rebuilds after a size drop
  - queue_build_rate_ask : rate at which ask L1 rebuilds after a size drop
  - queue_rebuild_asymmetry : asymmetric rebuilding = informed side (bid rebuilds faster → bullish)
  - depth_momentum_L1    : net direction of depth change over 5 bars
  - queue_exhaustion      : rolling fraction of bars where L1 depth is below 20th percentile

Experiments:
  1. TOP13_BASELINE     : the proven 13-feature set (IC=0.0795, IR=2.169)
  2. TOP13+QUEUE5       : top 13 + 5 new queue dynamics
  3. QUEUE5_ONLY        : queue dynamics alone (measures standalone edge)
  4. TOP13+BUILD_ASYM   : top 13 + just queue_rebuild_asymmetry (best single new feature?)
  5. REGIME_FILTER_TEST : top 13, but only on bars where queue_rebuild_asymmetry > 0.5

CPU-only (Razer). Uses lightgbm with GPU if available.
Output: queue_dynamics_lgbm_results.json
"""
import glob
import json
import os
import sys
import time
from typing import List, Tuple, Dict

import numpy as np
from scipy import stats as scipy_stats

try:
    import lightgbm as lgb
    HAS_LGBM = True
except ImportError:
    print("ERROR: lightgbm not installed. Run: pip install lightgbm")
    sys.exit(1)

DATA_DIR = r'C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache'
OUTPUT = r'C:\Temp\queue_dynamics_lgbm_results.json'
LOG = r'C:\Temp\queue_dynamics_lgbm.log'

HORIZONS = 100  # 10 seconds (100 bars at 100ms)
TRAIN_DAYS = 20
VAL_DAYS = 5
SUBSAMPLE = 5  # every Nth bar for speed

logf = open(LOG, 'w', buffering=1)

def log(msg):
    ts = time.strftime('%H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    logf.write(line + '\n')
    logf.flush()

def causal_rolling(arr, w):
    cs = np.cumsum(arr.astype(np.float64))
    out = np.zeros(len(arr), dtype=np.float64)
    out[w:] = (cs[w:] - cs[:-w]) / w
    out[:w] = cs[:w] / np.arange(1, w+1)
    return out

def zscore_causal(arr, w):
    mu = causal_rolling(arr, w)
    sq = causal_rolling(arr**2, w)
    var = np.maximum(sq - mu**2, 1e-12)
    return (arr - mu) / np.sqrt(var)

def get_files(data_dir, max_days=173):
    files = sorted(glob.glob(os.path.join(data_dir, '*_book_tensors.npz')))
    files = [f for f in files if 'signal' not in f and 'combined' not in f]
    return files[-max_days:]

def load_day(f):
    try:
        npz = np.load(f, allow_pickle=False)
        book = None
        for key in ['book_tensors', 'book', 'data', 'arr_0']:
            if key in npz:
                book = npz[key].astype(np.float32)
                break
        mid = None
        for key in ['mid_prices', 'mid_price', 'mid', 'close']:
            if key in npz:
                mid = npz[key].astype(np.float32)
                break
        if book is None or mid is None:
            return None
        if book.ndim != 3 or book.shape[1] != 20 or book.shape[2] != 4:
            return None
        return book, mid
    except Exception:
        return None

def compute_top13_features(book, mid):
    """The proven top-13 feature set (IC=0.0795). Exact replica from lgbm_reduced_features.py."""
    N = len(mid)
    feats = {}

    bid_d = book[:, 0, 1].astype(np.float64)
    ask_d = book[:, 10, 1].astype(np.float64)
    bid_o = book[:, 0, 2].astype(np.float64)
    ask_o = book[:, 10, 2].astype(np.float64)
    bid_a = book[:, 0, 3].astype(np.float64)
    ask_a = book[:, 10, 3].astype(np.float64)

    # L1 imbalance
    total = np.maximum(bid_d + ask_d, 1e-8)
    feats['imb_top1'] = (bid_d - ask_d) / total
    feats['depth_ratio_L1'] = bid_d / np.maximum(ask_d, 1e-8)

    bid_top3 = np.zeros(N); ask_top3 = np.zeros(N); total_top3 = np.zeros(N)
    for li in range(3):
        bd = book[:, li, 1].astype(np.float64)
        ad = book[:, li+10, 1].astype(np.float64)
        bid_top3 += bd; ask_top3 += ad; total_top3 += bd + ad
    feats['imb_top3'] = (bid_top3 - ask_top3) / np.maximum(total_top3, 1e-8)

    bid_top5 = np.zeros(N); ask_top5 = np.zeros(N); total_top5 = np.zeros(N)
    for li in range(5):
        bd = book[:, li, 1].astype(np.float64)
        ad = book[:, li+10, 1].astype(np.float64)
        bid_top5 += bd; ask_top5 += ad; total_top5 += bd + ad
    feats['imb_top5'] = (bid_top5 - ask_top5) / np.maximum(total_top5, 1e-8)

    bid_all = np.zeros(N); ask_all = np.zeros(N)
    for li in range(10):
        bid_all += book[:, li, 1].astype(np.float64)
        ask_all += book[:, li+10, 1].astype(np.float64)
    feats['imb_all'] = (bid_all - ask_all) / np.maximum(bid_all + ask_all, 1e-8)

    # Count imbalance
    feats['count_imb_top1'] = (bid_o - ask_o) / np.maximum(bid_o + ask_o, 1e-8)

    bid_o3 = np.zeros(N); ask_o3 = np.zeros(N)
    for li in range(3):
        bid_o3 += book[:, li, 2].astype(np.float64)
        ask_o3 += book[:, li+10, 2].astype(np.float64)
    feats['count_imb_top3'] = (bid_o3 - ask_o3) / np.maximum(bid_o3 + ask_o3, 1e-8)

    bid_o5 = np.zeros(N); ask_o5 = np.zeros(N)
    for li in range(5):
        bid_o5 += book[:, li, 2].astype(np.float64)
        ask_o5 += book[:, li+10, 2].astype(np.float64)
    feats['count_imb_top5'] = (bid_o5 - ask_o5) / np.maximum(bid_o5 + ask_o5, 1e-8)

    # Weighted mid deviation
    ask_price_L1 = book[:, 10, 0].astype(np.float64) * 0.25
    bid_price_L1 = book[:, 0, 0].astype(np.float64) * 0.25
    wmid = (bid_d * ask_price_L1 + ask_d * bid_price_L1) / np.maximum(bid_d + ask_d, 1e-8)
    feats['wmid_dev'] = wmid - mid.astype(np.float64)

    # IMB deviation and z-score
    imb = feats['imb_top1']
    mu50 = causal_rolling(imb, 50)
    feats['imb_dev_50'] = imb - mu50
    feats['zscore_imb_all_500'] = zscore_causal(feats['imb_all'], 500)

    # IMB rate of change
    for lag, label in [(5, 'imb_roc_5'), (10, 'imb_roc_10')]:
        roc = np.zeros(N)
        roc[lag:] = imb[lag:] - imb[:-lag]
        feats[label] = roc

    # Cumulative delta
    bid_delta = np.zeros(N); ask_delta = np.zeros(N)
    bid_delta[1:] = bid_d[1:] - bid_d[:-1]
    ask_delta[1:] = ask_d[1:] - ask_d[:-1]
    net_delta = bid_delta + ask_delta
    feats['cum_delta_10'] = causal_rolling(net_delta, 10)

    return feats

def compute_queue_dynamics(book, mid):
    """
    5 new queue dynamics features capturing the RATE and ASYMMETRY of queue changes.
    All features are strictly causal (use only past observations).
    """
    N = len(mid)
    feats = {}

    bid_d = book[:, 0, 1].astype(np.float64)
    ask_d = book[:, 10, 1].astype(np.float64)

    # --- Feature 1: Queue build rate (bid) ---
    # Measures how fast bid L1 depth rebuilds after a local minimum.
    # Proxy: positive-only delta z-scored by local volatility of delta
    bid_delta = np.zeros(N)
    bid_delta[1:] = bid_d[1:] - bid_d[:-1]
    bid_build = np.maximum(bid_delta, 0.0)   # only additions to bid queue
    # Z-score the build rate over 100-bar window
    feats['queue_build_rate_bid'] = zscore_causal(bid_build, 100)

    # --- Feature 2: Queue build rate (ask) ---
    ask_delta = np.zeros(N)
    ask_delta[1:] = ask_d[1:] - ask_d[:-1]
    ask_build = np.maximum(ask_delta, 0.0)   # only additions to ask queue
    feats['queue_build_rate_ask'] = zscore_causal(ask_build, 100)

    # --- Feature 3: Queue rebuild asymmetry ---
    # Core signal: if bid side rebuilds significantly faster than ask side,
    # informed buyers are present (absorbing offers and immediately refreshing bids).
    # Signal: rolling(bid_build, 20) - rolling(ask_build, 20), normalized
    bid_build_roll = causal_rolling(bid_build, 20)
    ask_build_roll = causal_rolling(ask_build, 20)
    total_build = bid_build_roll + ask_build_roll
    feats['queue_rebuild_asymmetry'] = (bid_build_roll - ask_build_roll) / np.maximum(total_build, 1e-8)

    # --- Feature 4: Depth momentum L1 ---
    # Net direction of depth movement: sustained bid-side increases = accumulation
    # Uses 5-bar lookback of net depth change direction
    net_depth_chg = bid_delta - ask_delta  # positive = bid gaining relative to ask
    feats['depth_momentum_L1'] = causal_rolling(net_depth_chg, 5)

    # --- Feature 5: Queue exhaustion ---
    # Fraction of last 50 bars where L1 depth is below its rolling 20th percentile
    # High exhaustion = repeated depletion = aggressive flow eating through supply
    bid_pctile_low = causal_rolling(bid_d, 50)   # rolling mean as proxy for normal level
    below_normal = (bid_d < bid_pctile_low * 0.8).astype(np.float64)  # 80% of rolling mean
    feats['queue_exhaustion'] = causal_rolling(below_normal, 50)  # fraction of bars below threshold

    return feats

def build_X(feats_dict, feature_names, N, subsample):
    """Stack features, apply subsampling."""
    cols = []
    for name in feature_names:
        if name in feats_dict:
            cols.append(feats_dict[name].astype(np.float32))
        else:
            cols.append(np.zeros(N, dtype=np.float32))
    X = np.column_stack(cols)
    return X[::subsample]

def compute_forward_return(mid, horizon):
    N = len(mid)
    fwd = np.zeros(N, dtype=np.float32)
    fwd[:-horizon] = mid[horizon:] - mid[:-horizon]
    return fwd

def run_wf_test(files, feature_names, label, mask_fn=None):
    """Walk-forward IC test. mask_fn(feats, N) -> bool array for filtering (optional)."""
    log(f"\n--- {label} ({len(feature_names)} features) ---")
    daily_ics = []
    n_folds = (len(files) - TRAIN_DAYS) // VAL_DAYS
    if n_folds < 1:
        log(f"  Not enough days.")
        return None

    t0 = time.time()
    for fold in range(n_folds):
        train_start = fold * VAL_DAYS
        train_end = train_start + TRAIN_DAYS
        val_start = train_end
        val_end = val_start + VAL_DAYS
        if val_end > len(files):
            break

        # Build train
        X_train_list, y_train_list = [], []
        for f in files[train_start:train_end]:
            res = load_day(f)
            if res is None:
                continue
            book, mid = res
            N = len(mid)
            top13 = compute_top13_features(book, mid)
            qdyn = compute_queue_dynamics(book, mid)
            all_feats = {**top13, **qdyn}
            X = build_X(all_feats, feature_names, N, SUBSAMPLE)
            y = compute_forward_return(mid, HORIZONS)[::SUBSAMPLE]
            mask = np.isfinite(X).all(axis=1) & np.isfinite(y)
            if mask.sum() < 100:
                continue
            if mask_fn is not None:
                feat_mask = mask_fn(all_feats, N)[::SUBSAMPLE]
                mask &= feat_mask
            X_train_list.append(X[mask])
            y_train_list.append(y[mask])

        if not X_train_list:
            continue
        X_tr = np.vstack(X_train_list)
        y_tr = np.concatenate(y_train_list)

        model = lgb.LGBMRegressor(
            n_estimators=300,
            learning_rate=0.05,
            num_leaves=31,
            min_child_samples=50,
            subsample=0.8,
            colsample_bytree=0.8,
            verbose=-1,
            n_jobs=-1,
        )
        model.fit(X_tr, y_tr)

        # Validate
        fold_ics = []
        for f in files[val_start:val_end]:
            res = load_day(f)
            if res is None:
                continue
            book, mid = res
            N = len(mid)
            top13 = compute_top13_features(book, mid)
            qdyn = compute_queue_dynamics(book, mid)
            all_feats = {**top13, **qdyn}
            X = build_X(all_feats, feature_names, N, SUBSAMPLE)
            y = compute_forward_return(mid, HORIZONS)[::SUBSAMPLE]
            mask = np.isfinite(X).all(axis=1) & np.isfinite(y)
            if mask.sum() < 50:
                continue
            if mask_fn is not None:
                feat_mask = mask_fn(all_feats, N)[::SUBSAMPLE]
                mask &= feat_mask
            if mask.sum() < 50:
                continue
            preds = model.predict(X[mask])
            ic, _ = scipy_stats.spearmanr(preds, y[mask])
            if np.isfinite(ic):
                fold_ics.append(ic)

        if fold_ics:
            fold_mean = float(np.mean(fold_ics))
            daily_ics.extend(fold_ics)
            if (fold + 1) % 3 == 0 or fold == 0:
                log(f"  fold {fold+1}/{n_folds}: mean_IC={fold_mean:.4f} n_days={len(daily_ics)}")

    if not daily_ics:
        log(f"  No valid folds.")
        return None

    ics = np.array(daily_ics)
    mean_ic = float(np.mean(ics))
    std_ic = float(np.std(ics))
    ic_ir = float(mean_ic / max(std_ic, 1e-8))
    pct_pos = float(np.mean(ics > 0))
    elapsed = time.time() - t0
    log(f"  RESULT: IC={mean_ic:.4f} IR={ic_ir:.3f} pos%={pct_pos:.3f} n={len(ics)} ({elapsed:.1f}s)")

    return {
        "label": label,
        "n_features": len(feature_names),
        "n_days": len(ics),
        "mean_ic": round(mean_ic, 5),
        "std_ic": round(std_ic, 5),
        "ic_ir": round(ic_ir, 3),
        "pct_pos_days": round(pct_pos, 3),
        "elapsed_s": round(elapsed, 1),
    }


# ─── TOP 13 FEATURE NAMES (from lgbm_reduced_features.py) ───────────────────
TOP13 = [
    'count_imb_top1', 'imb_top1', 'depth_ratio_L1', 'wmid_dev',
    'count_imb_top3', 'imb_top3', 'count_imb_top5',
    'imb_dev_50', 'imb_top5', 'imb_roc_5', 'cum_delta_10',
    'zscore_imb_all_500', 'imb_roc_10',
]

QUEUE5 = [
    'queue_build_rate_bid', 'queue_build_rate_ask',
    'queue_rebuild_asymmetry', 'depth_momentum_L1', 'queue_exhaustion',
]


def main():
    log("Queue Dynamics LGBM Feature Study")
    log(f"Data: {DATA_DIR}")

    files = get_files(DATA_DIR)
    log(f"Found {len(files)} days")
    if not files:
        log("ERROR: no data files found")
        sys.exit(1)

    results = []

    # Experiment 1: TOP13 baseline (sanity check — should match prior IC=0.0795)
    r = run_wf_test(files, TOP13, "top13_baseline")
    if r:
        results.append(r)

    # Experiment 2: TOP13 + all 5 queue dynamics
    r = run_wf_test(files, TOP13 + QUEUE5, "top13_plus_queue5")
    if r:
        results.append(r)

    # Experiment 3: Queue dynamics alone (standalone edge test)
    r = run_wf_test(files, QUEUE5, "queue5_only")
    if r:
        results.append(r)

    # Experiment 4: TOP13 + best single queue feature (rebuild asymmetry)
    r = run_wf_test(files, TOP13 + ['queue_rebuild_asymmetry'], "top13_plus_rebuild_asym")
    if r:
        results.append(r)

    # Experiment 5: TOP13 + depth momentum only
    r = run_wf_test(files, TOP13 + ['depth_momentum_L1'], "top13_plus_depth_momentum")
    if r:
        results.append(r)

    # Summary
    log("\n=== SUMMARY ===")
    for r in results:
        log(f"  {r['label']:<40}: IC={r['mean_ic']:+.4f} IR={r['ic_ir']:.3f} pos%={r['pct_pos_days']:.3f}")

    output = {
        "generated_at": time.strftime('%Y-%m-%dT%H:%M:%S'),
        "n_train_days": TRAIN_DAYS,
        "n_val_days": VAL_DAYS,
        "horizon_bars": HORIZONS,
        "subsample": SUBSAMPLE,
        "baseline_ic": 0.0795,
        "baseline_ir": 2.169,
        "results": results,
    }
    with open(OUTPUT, 'w') as f:
        json.dump(output, f, indent=2)
    log(f"\nSaved to {OUTPUT}")
    logf.close()


if __name__ == '__main__':
    main()
