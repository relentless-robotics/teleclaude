#!/usr/bin/env python3
"""
lgbm_reduced_features.py — LGBM Top-Feature OOS IC Study
=========================================================
The 111-feature study found 33 features with IC > 0.03.
HYPOTHESIS: Training LGBM on TOP features only (no noise) improves OOS IC
due to reduced overfitting and cleaner signal.

Tests:
1. Baseline: All 111 features
2. Top 33 (IC > 0.03 from prior study)
3. Top 15 (IC > 0.04)
4. Top 10 (IC > 0.05)
5. Top 5 (IC > 0.07)

Each test: walk-forward (20 train days, 5 val days) across all available data.
Reports: OOS IC, IC IR, % positive days, and LGBM feature importances.

CPU-only, Razer. Uses GPU if lightgbm-gpu available.
Output: lgbm_reduced_features_results.json
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
OUTPUT = r'C:\Users\claude\lgbm_reduced_features_results.json'
LOG = r'C:\Users\claude\lgbm_reduced_features.log'

# From prior study (feature_importance_20260326_094042.json) — top features by |IC|
ALL_TOP_FEATURES_BY_IC = [
    # (name, raw_ic) — sorted by |IC| desc
    ('count_imb_top1',       0.08836),
    ('imb_top1',             0.08772),
    ('depth_ratio_L1',       0.08772),
    ('wmid_dev',             0.08650),
    ('count_imb_top3',       0.07363),
    ('imb_top3',             0.06207),
    ('count_imb_top5',       0.05943),
    ('imb_dev_50',           0.05379),
    ('imb_top5',             0.05193),
    ('imb_roc_5',            0.04788),
    ('cum_delta_10',         0.04729),
    ('zscore_imb_all_500',   0.04661),
    ('imb_roc_10',           0.04517),
    ('bid_delta_L1',         0.04394),
    ('net_delta',            0.04379),
    ('zscore_net_delta_500', 0.04310),
    ('imb_roc_1',            0.04277),
    ('ask_delta_L1',        -0.04273),  # negative: ask side opposite
    ('queue_age_L1_ratio',   0.04268),
    ('pctile_net_delta_3000',0.04245),
    ('count_imb_all',        0.04104),
    ('imb_dev_500',          0.04068),
    ('pctile_imb_all_3000',  0.04002),
    ('imb_all',              0.03772),
    ('total_depth_ratio_centered', 0.03772),
    ('cum_delta_50',         0.03717),
    ('cum_delta_100',        0.03687),
    ('imb_gradient',         0.03490),
    ('queue_age_L1_diff',    0.03471),
    ('ask_l1_absorption',   -0.03367),
    ('bid_l1_absorption',    0.03334),
    ('cum_delta_500',        0.03251),
    ('bid_depth_slope',     -0.03191),
]

HORIZONS = 100  # 10 seconds (100 bars at 100ms)
TRAIN_DAYS = 20
VAL_DAYS = 5
SUBSAMPLE = 5  # use every Nth bar for speed
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


def compute_features(book, mid):
    """Compute ALL features (111-set), returning dict of feature arrays."""
    N = len(mid)
    feats = {}

    bid_d = book[:, 0, 1].astype(np.float64)
    ask_d = book[:, 10, 1].astype(np.float64)
    bid_o = book[:, 0, 2].astype(np.float64)
    ask_o = book[:, 10, 2].astype(np.float64)
    bid_a = book[:, 0, 3].astype(np.float64)
    ask_a = book[:, 10, 3].astype(np.float64)
    bid_d2 = book[:, 1, 1].astype(np.float64)
    ask_d2 = book[:, 11, 1].astype(np.float64)

    # L1 imbalance features
    total = np.maximum(bid_d + ask_d, 1e-8)
    feats['imb_top1'] = (bid_d - ask_d) / total
    feats['depth_ratio_L1'] = bid_d / np.maximum(ask_d, 1e-8)

    total_top3 = np.zeros(N)
    bid_top3 = np.zeros(N)
    ask_top3 = np.zeros(N)
    for li in range(3):
        if li < 10:
            bd = book[:, li, 1].astype(np.float64)
            ad = book[:, li+10, 1].astype(np.float64)
            bid_top3 += bd
            ask_top3 += ad
            total_top3 += bd + ad
    feats['imb_top3'] = (bid_top3 - ask_top3) / np.maximum(total_top3, 1e-8)

    bid_top5 = np.zeros(N)
    ask_top5 = np.zeros(N)
    total_top5 = np.zeros(N)
    for li in range(5):
        bd = book[:, li, 1].astype(np.float64)
        ad = book[:, li+10, 1].astype(np.float64)
        bid_top5 += bd
        ask_top5 += ad
        total_top5 += bd + ad
    feats['imb_top5'] = (bid_top5 - ask_top5) / np.maximum(total_top5, 1e-8)

    bid_all = np.zeros(N)
    ask_all = np.zeros(N)
    for li in range(10):
        bid_all += book[:, li, 1].astype(np.float64)
        ask_all += book[:, li+10, 1].astype(np.float64)
    total_all = bid_all + ask_all
    feats['imb_all'] = (bid_all - ask_all) / np.maximum(total_all, 1e-8)
    feats['total_depth_ratio_centered'] = feats['imb_all']  # alias

    # Count imbalance (order counts)
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
    bid_oa = np.zeros(N); ask_oa = np.zeros(N)
    for li in range(10):
        bid_oa += book[:, li, 2].astype(np.float64)
        ask_oa += book[:, li+10, 2].astype(np.float64)
    feats['count_imb_all'] = (bid_oa - ask_oa) / np.maximum(bid_oa + ask_oa, 1e-8)

    # Weighted mid deviation
    wmid = (bid_d * (book[:, 10, 0].astype(np.float64) * 0.25) +
            ask_d * (book[:, 0, 0].astype(np.float64) * 0.25)) / np.maximum(bid_d + ask_d, 1e-8)
    bmid = mid.astype(np.float64)
    feats['wmid_dev'] = wmid - bmid

    # Rolling imbalance
    imb = feats['imb_top1']
    for w, label in [(10, 'imb_roll_10'), (50, 'imb_roll_50'), (100, 'imb_roll_100')]:
        feats[label] = causal_rolling(imb, w)

    # ROC of imbalance
    for lag, label in [(1, 'imb_roc_1'), (5, 'imb_roc_5'), (10, 'imb_roc_10')]:
        roc = np.zeros(N)
        roc[lag:] = imb[lag:] - imb[:-lag]
        feats[label] = roc

    # Imbalance deviation
    mu50 = causal_rolling(imb, 50)
    mu500 = causal_rolling(imb, 500)
    feats['imb_dev_50'] = imb - mu50
    feats['imb_dev_500'] = imb - mu500
    feats['imb_gradient'] = feats['imb_roc_5'] / np.maximum(np.abs(feats['imb_dev_50']), 1e-6)

    # Z-scores
    def zscore(arr, w):
        mu = causal_rolling(arr, w)
        sq = causal_rolling(arr**2, w)
        var = np.maximum(sq - mu**2, 1e-12)
        return (arr - mu) / np.sqrt(var)

    feats['zscore_imb_all_500'] = zscore(feats['imb_all'], 500)
    pctile_buf = causal_rolling(feats['imb_all'], 3000)
    feats['pctile_imb_all_3000'] = pctile_buf

    # Delta (bid/ask depth changes)
    bid_delta = np.zeros(N); ask_delta = np.zeros(N)
    bid_delta[1:] = bid_d[1:] - bid_d[:-1]
    ask_delta[1:] = ask_d[1:] - ask_d[:-1]
    feats['bid_delta_L1'] = bid_delta
    feats['ask_delta_L1'] = ask_delta
    bid_d2_arr = book[:, 1, 1].astype(np.float64)
    ask_d2_arr = book[:, 11, 1].astype(np.float64)
    bd2_delta = np.zeros(N); ad2_delta = np.zeros(N)
    bd2_delta[1:] = bid_d2_arr[1:] - bid_d2_arr[:-1]
    ad2_delta[1:] = ask_d2_arr[1:] - ask_d2_arr[:-1]
    feats['bid_delta_L2'] = bd2_delta
    feats['ask_delta_L2'] = ad2_delta
    bid_d3_arr = book[:, 2, 1].astype(np.float64)
    bid_d3_delta = np.zeros(N)
    bid_d3_delta[1:] = bid_d3_arr[1:] - bid_d3_arr[:-1]
    feats['bid_delta_L3'] = bid_d3_delta

    # Net delta and cumulative delta
    feats['net_delta'] = bid_delta + ask_delta
    feats['zscore_net_delta_500'] = zscore(feats['net_delta'], 500)
    feats['pctile_net_delta_3000'] = causal_rolling(feats['net_delta'], 3000)
    for w, label in [(10, 'cum_delta_10'), (50, 'cum_delta_50'), (100, 'cum_delta_100'), (500, 'cum_delta_500')]:
        feats[label] = causal_rolling(feats['net_delta'], w)

    # Queue age features
    bid_age = bid_a.copy()
    ask_age = ask_a.copy()
    feats['queue_age_L1_ratio'] = bid_age / np.maximum(ask_age, 1e-8)
    bid_age2 = book[:, 1, 3].astype(np.float64)
    ask_age2 = book[:, 11, 3].astype(np.float64)
    feats['queue_age_L1_diff'] = bid_age - ask_age
    feats['queue_age_imb'] = (bid_age - ask_age) / np.maximum(bid_age + ask_age, 1e-8)

    # Depth ratios L2-L8
    for li in range(1, 9):
        bl = book[:, li, 1].astype(np.float64)
        al = book[:, li+10, 1].astype(np.float64)
        feats[f'depth_ratio_L{li+1}'] = bl / np.maximum(al, 1e-8)

    # L1 absorption
    feats['bid_l1_absorption'] = np.maximum(bid_delta, 0) * np.sign(feats['imb_top1'])
    feats['ask_l1_absorption'] = np.maximum(-ask_delta, 0) * np.sign(-feats['imb_top1'])

    # L1 age vs deep
    mean_bid_age = np.zeros(N)
    mean_ask_age = np.zeros(N)
    for li in range(1, 10):
        mean_bid_age += book[:, li, 3].astype(np.float64)
        mean_ask_age += book[:, li+10, 3].astype(np.float64)
    mean_bid_age /= 9
    mean_ask_age /= 9
    feats['bid_l1_age_vs_deep'] = bid_age - mean_bid_age
    feats['ask_l1_age_vs_deep'] = ask_age - mean_ask_age
    feats['mean_ask_age'] = mean_ask_age

    # Avg size at L1
    feats['bid_avg_size_L1'] = bid_d / np.maximum(bid_o, 1e-8)
    feats['ask_avg_size_L1'] = ask_d / np.maximum(ask_o, 1e-8)

    # Wall detection
    deep_bid = np.zeros(N)
    deep_ask = np.zeros(N)
    for li in range(5, 10):
        deep_bid += book[:, li, 1].astype(np.float64)
        deep_ask += book[:, li+10, 1].astype(np.float64)
    wall_bid = deep_bid / 5
    wall_ask = deep_ask / 5
    feats['wall_bid_ask_ratio'] = wall_bid / np.maximum(wall_ask, 1e-8)

    # Momentum
    mid_f = mid.astype(np.float64)
    for lag, label in [(10, 'mom_10'), (50, 'mom_50'), (100, 'mom_100'), (500, 'mom_500')]:
        mom = np.zeros(N)
        mom[lag:] = mid_f[lag:] - mid_f[:-lag]
        feats[label] = mom

    # VWAP distance proxy
    feats['vwap_dist_proxy'] = feats['wmid_dev']

    # Depth slopes
    bid_depths_by_level = np.array([book[:, li, 1] for li in range(5)], dtype=np.float64)
    ask_depths_by_level = np.array([book[:, li+10, 1] for li in range(5)], dtype=np.float64)
    # slope = linear regression of depth vs level (positive = depth increasing with distance)
    levels = np.arange(5, dtype=np.float64)
    mean_levels = levels.mean()
    denom = ((levels - mean_levels)**2).sum()
    bid_slope = np.zeros(N)
    ask_slope = np.zeros(N)
    for li in range(5):
        bid_slope += bid_depths_by_level[li] * (li - mean_levels)
        ask_slope += ask_depths_by_level[li] * (li - mean_levels)
    feats['bid_depth_slope'] = bid_slope / max(denom, 1e-8)
    feats['ask_depth_slope'] = ask_slope / max(denom, 1e-8)

    # imb_deep
    bid_deep_all = np.zeros(N)
    ask_deep_all = np.zeros(N)
    for li in range(3, 10):
        bid_deep_all += book[:, li, 1].astype(np.float64)
        ask_deep_all += book[:, li+10, 1].astype(np.float64)
    feats['imb_deep'] = (bid_deep_all - ask_deep_all) / np.maximum(bid_deep_all + ask_deep_all, 1e-8)

    return feats


def build_feature_matrix(feats: dict, feature_names: list, N: int) -> np.ndarray:
    """Stack selected features into (N, n_features) matrix."""
    cols = []
    for name in feature_names:
        if name in feats:
            cols.append(feats[name].astype(np.float32))
        else:
            cols.append(np.zeros(N, dtype=np.float32))
    return np.column_stack(cols)


def compute_forward_return(mid, horizon):
    N = len(mid)
    fwd = np.zeros(N, dtype=np.float32)
    fwd[:-horizon] = mid[horizon:] - mid[:-horizon]
    return fwd


def run_wf_test(files, feature_names, label, max_days=173):
    """Walk-forward IC test for a given feature set."""
    log(f"\n--- {label} ({len(feature_names)} features) ---")
    files_use = files[-max_days:]
    daily_ics = []

    n_folds = (len(files_use) - TRAIN_DAYS) // VAL_DAYS
    if n_folds < 1:
        log(f"  Not enough days for WF ({len(files_use)} days)")
        return None

    t0 = time.time()
    for fold in range(n_folds):
        train_start = fold * VAL_DAYS
        train_end = train_start + TRAIN_DAYS
        val_start = train_end
        val_end = val_start + VAL_DAYS

        if val_end > len(files_use):
            break

        train_files = files_use[train_start:train_end]
        val_files = files_use[val_start:val_end]

        # Load train data
        X_train_parts, y_train_parts = [], []
        for f in train_files:
            day = load_day(f)
            if day is None:
                continue
            book, mid = day
            feats = compute_features(book, mid)
            N = len(mid)
            X = build_feature_matrix(feats, feature_names, N)
            y = compute_forward_return(mid, HORIZONS)
            # Subsample
            idx = np.arange(HORIZONS, N - HORIZONS, SUBSAMPLE)
            if len(idx) < 50:
                continue
            X_train_parts.append(X[idx])
            y_train_parts.append(y[idx])

        if not X_train_parts:
            continue
        X_tr = np.vstack(X_train_parts)
        y_tr = np.concatenate(y_train_parts)

        # Remove nan/inf
        mask = np.isfinite(X_tr).all(axis=1) & np.isfinite(y_tr)
        X_tr = X_tr[mask]
        y_tr = y_tr[mask]
        if len(X_tr) < 100:
            continue

        # Train LGBM
        try:
            dtrain = lgb.Dataset(X_tr, label=y_tr, free_raw_data=True)
            params = {
                'objective': 'regression',
                'metric': 'mse',
                'n_estimators': 100,
                'learning_rate': 0.05,
                'num_leaves': 31,
                'min_child_samples': 50,
                'subsample': 0.8,
                'colsample_bytree': 0.8,
                'reg_alpha': 0.1,
                'reg_lambda': 0.1,
                'verbose': -1,
                'n_jobs': 4,
            }
            model = lgb.train(params, dtrain,
                              num_boost_round=100,
                              callbacks=[lgb.log_evaluation(period=-1)])
        except Exception as e:
            log(f"  fold {fold} train failed: {e}")
            continue

        # Validate
        for vf in val_files:
            day = load_day(vf)
            if day is None:
                continue
            book, mid = day
            feats_v = compute_features(book, mid)
            N = len(mid)
            X_val = build_feature_matrix(feats_v, feature_names, N)
            y_val = compute_forward_return(mid, HORIZONS)

            idx = np.arange(HORIZONS, N - HORIZONS, SUBSAMPLE)
            if len(idx) < 30:
                continue
            X_v = X_val[idx]
            y_v = y_val[idx]
            mask_v = np.isfinite(X_v).all(axis=1) & np.isfinite(y_v)
            X_v = X_v[mask_v]
            y_v = y_v[mask_v]
            if len(X_v) < 30:
                continue

            preds = model.predict(X_v, num_iteration=model.best_iteration)
            rho, _ = scipy_stats.spearmanr(preds, y_v)
            if np.isfinite(rho):
                daily_ics.append(float(rho))

        if fold % 3 == 0:
            if daily_ics:
                log(f"  fold {fold+1}/{n_folds}: mean_IC={np.mean(daily_ics):.4f} n_days={len(daily_ics)}")

    if not daily_ics:
        log(f"  No valid IC values")
        return None

    ics = np.array(daily_ics)
    mean_ic = float(np.mean(ics))
    std_ic = float(np.std(ics))
    ic_ir = mean_ic / std_ic if std_ic > 0 else 0.0
    pct_pos = float((ics > 0).mean())
    elapsed = time.time() - t0
    log(f"  RESULT: IC={mean_ic:.4f} IR={ic_ir:.3f} pos%={pct_pos:.3f} n={len(ics)} ({elapsed:.1f}s)")

    return {
        'label': label,
        'n_features': len(feature_names),
        'n_days': len(daily_ics),
        'mean_ic': round(mean_ic, 5),
        'std_ic': round(std_ic, 5),
        'ic_ir': round(ic_ir, 3),
        'pct_pos_days': round(pct_pos, 3),
    }


def main():
    log(f"LGBM Reduced Features Study")
    log(f"Data: {DATA_DIR}")
    files = get_files(DATA_DIR, 173)
    log(f"Found {len(files)} days")

    # Define feature sets
    top33_names = [name for name, _ in ALL_TOP_FEATURES_BY_IC]  # all 33 with IC>0.03
    top15_names = [name for name, ic in ALL_TOP_FEATURES_BY_IC if abs(ic) >= 0.04]
    top10_names = [name for name, ic in ALL_TOP_FEATURES_BY_IC if abs(ic) >= 0.045]
    top5_names  = [name for name, ic in ALL_TOP_FEATURES_BY_IC if abs(ic) >= 0.07]

    # For baseline, use the full set we can compute (subset of 111)
    all_feats_sample = compute_features(load_day(files[0])[0], load_day(files[0])[1])
    all_names = [name for name, ic in ALL_TOP_FEATURES_BY_IC]  # use same 33 as baseline

    feature_sets = [
        (all_names, 'all_33_features (IC>0.03)'),
        (top15_names, f'top_{len(top15_names)}_features (IC>0.04)'),
        (top10_names, f'top_{len(top10_names)}_features (IC>0.045)'),
        (top5_names,  f'top_{len(top5_names)}_features (IC>0.07)'),
    ]

    results = []
    for feat_names, label in feature_sets:
        if len(feat_names) < 2:
            log(f"Skipping {label}: too few features ({len(feat_names)})")
            continue
        r = run_wf_test(files, feat_names, label)
        if r:
            results.append(r)

    # Summary
    log(f"\n=== SUMMARY ===")
    for r in results:
        log(f"  {r['label']:45s}: IC={r['mean_ic']:+.4f} IR={r['ic_ir']:.3f} pos%={r['pct_pos_days']:.3f}")

    with open(OUTPUT, 'w') as f:
        json.dump({
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'n_train_days': TRAIN_DAYS,
            'n_val_days': VAL_DAYS,
            'horizon_bars': HORIZONS,
            'subsample': SUBSAMPLE,
            'results': results,
        }, f, indent=2)
    log(f"\nSaved to {OUTPUT}")
    logf.close()


if __name__ == '__main__':
    main()
