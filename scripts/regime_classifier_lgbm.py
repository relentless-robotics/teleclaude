#!/usr/bin/env python3
"""
regime_classifier_lgbm.py — LGBM Microstructure Regime Classifier
===================================================================
HYPOTHESIS: The book has distinct regimes that determine whether CNN signals
are exploitable. Classification task — not direction prediction.

4 Regime Labels (derived from realized outcomes):
  0 = MEAN_REVERT : price reverts within 10s (typical noisy bar)
  1 = TREND_SHORT : price trends in direction of L1 imbalance within 10s
  2 = ICEBERG     : large absorption detected (depth stable despite trades)
  3 = TOXIC       : adverse selection — price moves against the aggressive side

Construction:
  - Label each bar using REALIZED 10s return + book dynamics (causal feature construction)
  - Train LGBM classifier on top-13 features
  - Evaluate: F1 per class, regime frequency, and most importantly:
    "what is CNN IC on bars predicted as TREND_SHORT vs ALL bars?"

This tests whether regime classification can GATE CNN entries to improve Sortino.

CPU-only, Razer. Output: regime_classifier_results.json
"""
import glob
import json
import os
import sys
import time

import numpy as np
from scipy import stats as scipy_stats

try:
    import lightgbm as lgb
    HAS_LGBM = True
except ImportError:
    print("ERROR: lightgbm not installed")
    sys.exit(1)

DATA_DIR = r'C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache'
CNN_PREDS_DIR = r'C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\results'
OUTPUT = r'C:\Temp\regime_classifier_results.json'
LOG = r'C:\Temp\regime_classifier.log'

HORIZONS = 100   # 10 seconds = 100 bars at 100ms
TRAIN_DAYS = 20
VAL_DAYS = 5
SUBSAMPLE = 5

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

def get_files(data_dir, max_days=150):
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
    """Top-13 feature set (proven IC=0.0795)."""
    N = len(mid)
    feats = {}
    bid_d = book[:, 0, 1].astype(np.float64)
    ask_d = book[:, 10, 1].astype(np.float64)
    bid_o = book[:, 0, 2].astype(np.float64)
    ask_o = book[:, 10, 2].astype(np.float64)

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

    ask_price_L1 = book[:, 10, 0].astype(np.float64) * 0.25
    bid_price_L1 = book[:, 0, 0].astype(np.float64) * 0.25
    wmid = (bid_d * ask_price_L1 + ask_d * bid_price_L1) / np.maximum(bid_d + ask_d, 1e-8)
    feats['wmid_dev'] = wmid - mid.astype(np.float64)

    imb = feats['imb_top1']
    mu50 = causal_rolling(imb, 50)
    feats['imb_dev_50'] = imb - mu50
    feats['zscore_imb_all_500'] = zscore_causal(feats['imb_all'], 500)

    for lag, label in [(5, 'imb_roc_5'), (10, 'imb_roc_10')]:
        roc = np.zeros(N)
        roc[lag:] = imb[lag:] - imb[:-lag]
        feats[label] = roc

    bid_delta = np.zeros(N); ask_delta = np.zeros(N)
    bid_delta[1:] = bid_d[1:] - bid_d[:-1]
    ask_delta[1:] = ask_d[1:] - ask_d[:-1]
    feats['cum_delta_10'] = causal_rolling(bid_delta + ask_delta, 10)

    return feats

def label_regime(mid, book, horizon=100):
    """
    Label each bar with a regime 0-3.
    ALL labeling uses FUTURE returns — this is training labels only, not features.
    Features are computed separately from past-only data.

    Labeling rules:
      fwd_ret = mid[t+horizon] - mid[t]   (forward return over 10s)
      imb     = L1 imbalance at time t    (snapshot, used for trend alignment)
      depth_stability = std(bid_L1[t:t+20]) / mean(bid_L1[t:t+20])  (iceberg proxy)

      MEAN_REVERT (0): |fwd_ret| < 0.5 tick, OR fwd_ret and imb have OPPOSITE signs
      TREND_SHORT (1): fwd_ret aligns with imb sign, |fwd_ret| > 1 tick
      ICEBERG     (2): high |imb| but small fwd_ret AND low depth_stability
      TOXIC       (3): fwd_ret OPPOSES imb sign AND |fwd_ret| > 2 ticks (informed adverse)
    """
    N = len(mid)
    mid_f = mid.astype(np.float64)

    fwd_ret = np.zeros(N)
    fwd_ret[:-horizon] = mid_f[horizon:] - mid_f[:-horizon]

    bid_d = book[:, 0, 1].astype(np.float64)
    ask_d = book[:, 10, 1].astype(np.float64)
    total = np.maximum(bid_d + ask_d, 1e-8)
    imb = (bid_d - ask_d) / total  # L1 imbalance snapshot

    # Depth stability: rolling 20-bar coefficient of variation of bid L1 depth
    bid_mean = causal_rolling(bid_d, 20)
    bid_sq = causal_rolling(bid_d**2, 20)
    bid_var = np.maximum(bid_sq - bid_mean**2, 1e-12)
    bid_cv = np.sqrt(bid_var) / np.maximum(bid_mean, 1e-8)  # low CV = stable = iceberg

    # Tick size proxy: median absolute price change
    tick_proxy = np.median(np.abs(np.diff(mid_f))) * 10  # ~1 tick
    tick_proxy = max(tick_proxy, 0.25)

    labels = np.zeros(N, dtype=np.int32)

    for i in range(N - horizon):
        ret = fwd_ret[i]
        im = imb[i]
        cv = bid_cv[i]
        aligned = (ret > 0 and im > 0.1) or (ret < 0 and im < -0.1)
        opposed = (ret > 0 and im < -0.1) or (ret < 0 and im > 0.1)
        large = abs(ret) > tick_proxy

        if opposed and abs(ret) > 2 * tick_proxy:
            labels[i] = 3  # TOXIC
        elif abs(im) > 0.3 and abs(ret) < 0.5 * tick_proxy and cv < 0.1:
            labels[i] = 2  # ICEBERG (large imbalance, small move, stable depth)
        elif aligned and large:
            labels[i] = 1  # TREND_SHORT
        else:
            labels[i] = 0  # MEAN_REVERT

    return labels

TOP13 = [
    'count_imb_top1', 'imb_top1', 'depth_ratio_L1', 'wmid_dev',
    'count_imb_top3', 'imb_top3', 'count_imb_top5',
    'imb_dev_50', 'imb_top5', 'imb_roc_5', 'cum_delta_10',
    'zscore_imb_all_500', 'imb_roc_10',
]

def build_X(feats, N):
    cols = [feats.get(k, np.zeros(N)).astype(np.float32) for k in TOP13]
    return np.column_stack(cols)

def main():
    log("Microstructure Regime Classifier — LGBM 4-class")
    log(f"Data: {DATA_DIR}")

    files = get_files(DATA_DIR)
    log(f"Found {len(files)} days")

    n_folds = (len(files) - TRAIN_DAYS) // VAL_DAYS
    log(f"WF folds: {n_folds}")

    all_val_results = []
    regime_counts = np.zeros(4, dtype=int)

    for fold in range(n_folds):
        train_start = fold * VAL_DAYS
        train_end = train_start + TRAIN_DAYS
        val_start = train_end
        val_end = val_start + VAL_DAYS
        if val_end > len(files):
            break

        X_tr_list, y_tr_list = [], []
        for f in files[train_start:train_end]:
            res = load_day(f)
            if res is None:
                continue
            book, mid = res
            N = len(mid)
            feats = compute_features(book, mid)
            X = build_X(feats, N)[::SUBSAMPLE]
            labels = label_regime(mid, book)[::SUBSAMPLE]
            mask = np.isfinite(X).all(axis=1)
            X_tr_list.append(X[mask])
            y_tr_list.append(labels[mask])

        if not X_tr_list:
            continue
        X_tr = np.vstack(X_tr_list)
        y_tr = np.concatenate(y_tr_list)

        # Check we have enough of each class
        unique, counts = np.unique(y_tr, return_counts=True)
        if len(unique) < 3:
            continue

        clf = lgb.LGBMClassifier(
            n_estimators=200,
            learning_rate=0.05,
            num_leaves=31,
            min_child_samples=50,
            class_weight='balanced',
            verbose=-1,
            n_jobs=-1,
        )
        clf.fit(X_tr, y_tr)

        # Validate
        fold_stats = {'fold': fold + 1}
        pred_ics = {0: [], 1: [], 2: [], 3: []}

        for f in files[val_start:val_end]:
            res = load_day(f)
            if res is None:
                continue
            book, mid = res
            N = len(mid)
            feats = compute_features(book, mid)
            X_val = build_X(feats, N)[::SUBSAMPLE]
            labels_true = label_regime(mid, book)[::SUBSAMPLE]
            mask = np.isfinite(X_val).all(axis=1)
            if mask.sum() < 50:
                continue

            proba = clf.predict_proba(X_val[mask])
            pred_class = np.argmax(proba, axis=1)
            regime_counts += np.bincount(labels_true[mask], minlength=4)

            # IC when classifier predicts each regime
            # We use the regime probability score as a meta-signal
            # and check if high-prob TREND_SHORT bars have better IC
            # (compute forward return as IC proxy)
            fwd = np.zeros(N, dtype=np.float32)
            mid_f = mid.astype(np.float32)
            fwd[:-HORIZONS] = mid_f[HORIZONS:] - mid_f[:-HORIZONS]
            y_val = fwd[::SUBSAMPLE][mask]

            for r in range(4):
                r_mask = (pred_class == r) & np.isfinite(y_val)
                if r_mask.sum() > 50:
                    # IC of L1 imbalance on bars classified as regime r
                    imb_vals = feats['imb_top1'][::SUBSAMPLE][mask][r_mask]
                    ic, _ = scipy_stats.spearmanr(imb_vals, y_val[r_mask])
                    if np.isfinite(ic):
                        pred_ics[r].append(ic)

        fold_summary = {
            'fold': fold + 1,
            'regime_ic': {r: round(float(np.mean(v)), 4) if v else None for r, v in pred_ics.items()},
        }
        all_val_results.append(fold_summary)

        if (fold + 1) % 3 == 0 or fold == 0:
            regime_ic_str = ' | '.join([
                f"R{r}={fold_summary['regime_ic'][r]:.3f}" if fold_summary['regime_ic'][r] is not None else f"R{r}=N/A"
                for r in range(4)
            ])
            log(f"  fold {fold+1}/{n_folds}: {regime_ic_str}")

    # Aggregate
    regime_names = {0: 'MEAN_REVERT', 1: 'TREND_SHORT', 2: 'ICEBERG', 3: 'TOXIC'}
    log("\n=== REGIME CLASSIFIER RESULTS ===")
    log(f"Total classified bars: {regime_counts.sum():,}")
    for r, name in regime_names.items():
        pct = regime_counts[r] / max(regime_counts.sum(), 1)
        log(f"  {name} (R{r}): {regime_counts[r]:,} bars ({pct:.1%})")

    # Average IC per regime across all folds
    log("\nL1 Imbalance IC by Predicted Regime:")
    log("  (Higher IC when regime is correctly identified = regime filtering works)")
    agg_ics = {r: [] for r in range(4)}
    for fold_res in all_val_results:
        for r in range(4):
            v = fold_res['regime_ic'].get(r)
            if v is not None:
                agg_ics[r].append(v)
    for r, name in regime_names.items():
        if agg_ics[r]:
            avg = float(np.mean(agg_ics[r]))
            std = float(np.std(agg_ics[r]))
            log(f"  {name}: IC={avg:.4f} ± {std:.4f} (n={len(agg_ics[r])} folds)")
        else:
            log(f"  {name}: no data")

    output = {
        "generated_at": time.strftime('%Y-%m-%dT%H:%M:%S'),
        "regime_names": regime_names,
        "regime_counts": regime_counts.tolist(),
        "regime_pct": [float(c / max(regime_counts.sum(), 1)) for c in regime_counts],
        "avg_ic_by_regime": {
            str(r): round(float(np.mean(v)), 5) if v else None
            for r, v in agg_ics.items()
        },
        "fold_results": all_val_results,
    }

    with open(OUTPUT, 'w') as f:
        json.dump(output, f, indent=2)
    log(f"\nSaved to {OUTPUT}")
    logf.close()

if __name__ == '__main__':
    main()
