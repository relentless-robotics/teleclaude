"""Pure book microstructure temporal features -> LGBM -> 10s return prediction.
Tests if temporal market microstructure alone has alpha, independent of CNN.
Uses book tensors (bid/ask depth at 10 levels) as MBO proxies.
Book tensor shape: (N, 20, 4) -> [bid_size, bid_price, ask_size, ask_price] x 10 levels
"""
import numpy as np
import lightgbm as lgb
from pathlib import Path
from scipy.stats import spearmanr
import json, time, os, glob, sys

# Redirect all output to log file (so we can launch detached)
_LOG = open("C:/Users/claude/pure_mbo_lgbm_log.txt", "w", buffering=1)
sys.stdout = _LOG
sys.stderr = _LOG

BOOK_DIR = Path("C:/Users/claude/Lvl3Quant/data/processed/dl_book_cache")
CNN_PREDS = "C:/Users/claude/Lvl3Quant/alpha_discovery/deep_models/results/wider_cnn/ckpt_preds_book_20260326_191614.npz"

def compute_microstructure_features(book, N_preds):
    """
    Derive pure microstructure temporal features from book tensors.
    book shape: (T, 20, 4) -> columns: [bid_sz, bid_px, ask_sz, ask_px] x 10 levels
    Returns feature array aligned to first N_preds rows with 120-bar offset.
    """
    T = book.shape[0]
    OFFSET = T - N_preds  # typically 120

    # Extract key columns (10-level book)
    # book[:, 0:10, 0] = bid sizes L1-L10
    # book[:, 0:10, 1] = bid prices L1-L10
    # book[:, 10:20, 0] = ask sizes L1-L10
    # book[:, 10:20, 1] = ask prices L1-L10
    bid_sz_L1 = book[:, 0, 0].astype(np.float32)
    ask_sz_L1 = book[:, 10, 0].astype(np.float32)
    bid_px_L1 = book[:, 0, 1].astype(np.float32)
    ask_px_L1 = book[:, 10, 1].astype(np.float32)

    bid_sz_5 = book[:, :5, 0].sum(axis=1).astype(np.float32)
    ask_sz_5 = book[:, 10:15, 0].sum(axis=1).astype(np.float32)

    # Derived microstructure signals
    spread = (ask_px_L1 - bid_px_L1) / (bid_px_L1 + 1e-8)
    imbalance_L1 = (bid_sz_L1 - ask_sz_L1) / (bid_sz_L1 + ask_sz_L1 + 1e-8)
    imbalance_5 = (bid_sz_5 - ask_sz_5) / (bid_sz_5 + ask_sz_5 + 1e-8)
    total_depth = bid_sz_5 + ask_sz_5

    # Temporal derivatives (look back 10 bars)
    def change10(x):
        c = np.zeros(len(x), dtype=np.float32)
        c[10:] = x[10:] - x[:-10]
        return c

    def rolling_mean10(x):
        return np.convolve(x, np.ones(10)/10, mode='same').astype(np.float32)

    features = np.column_stack([
        imbalance_L1,
        imbalance_5,
        spread,
        total_depth / (total_depth.mean() + 1e-8),
        change10(imbalance_L1),
        change10(imbalance_5),
        change10(spread),
        change10(bid_sz_L1 / (bid_sz_L1.mean() + 1e-8)),
        change10(ask_sz_L1 / (ask_sz_L1.mean() + 1e-8)),
        rolling_mean10(imbalance_L1),
        rolling_mean10(imbalance_5),
        rolling_mean10(spread),
        bid_sz_L1 / (bid_sz_5 + 1e-8),   # L1 concentration bid
        ask_sz_L1 / (ask_sz_5 + 1e-8),   # L1 concentration ask
    ])

    # Slice to match CNN preds alignment
    features_aligned = features[OFFSET:OFFSET + N_preds]
    return features_aligned

def main():
    print("Loading CNN preds for targets...")
    cnn = np.load(CNN_PREDS, allow_pickle=True)
    dates = sorted(set(k.replace("_preds","").replace("_targets","") for k in cnn.keys()))

    # Only keep dates with book tensors
    dates = [d for d in dates if (BOOK_DIR / f"{d}_book_tensors.npz").exists()]
    print(f"Dates with both CNN targets + book tensors: {len(dates)}")

    MIN_TRAIN = 15
    results = []
    all_preds, all_targets = [], []

    for test_idx in range(MIN_TRAIN, len(dates)):
        t0 = time.time()
        train_dates = dates[:test_idx - 1]  # 1-day purge gap
        test_date = dates[test_idx]

        X_train, y_train = [], []
        for d in train_dates:
            try:
                book = np.load(str(BOOK_DIR / f"{d}_book_tensors.npz"))["book_tensors"]
                tgt = cnn[f"{d}_targets"]
                feats = compute_microstructure_features(book, len(tgt))
                M = min(len(feats), len(tgt))
                F, T = feats[:M], tgt[:M]
                valid = np.isfinite(F).all(axis=1) & np.isfinite(T)
                X_train.append(F[valid])
                y_train.append(T[valid])
            except Exception as e:
                print(f"  Skip {d}: {e}")

        if not X_train:
            print(f"  Fold {test_idx}: no training data, skip")
            continue

        X_tr = np.concatenate(X_train)
        y_tr = np.concatenate(y_train)

        # Test
        book_test = np.load(str(BOOK_DIR / f"{test_date}_book_tensors.npz"))["book_tensors"]
        tgt_test = cnn[f"{test_date}_targets"]
        X_test = compute_microstructure_features(book_test, len(tgt_test))
        M_test = min(len(X_test), len(tgt_test))
        X_test, y_test = X_test[:M_test], tgt_test[:M_test]
        valid_test = np.isfinite(X_test).all(axis=1) & np.isfinite(y_test)
        X_test, y_test = X_test[valid_test], y_test[valid_test]

        if len(y_test) < 100:
            print(f"  Fold {test_idx} ({test_date}): too few test samples, skip")
            continue

        model = lgb.LGBMRegressor(
            n_estimators=300, max_depth=6, learning_rate=0.05,
            num_leaves=31, subsample=0.8, colsample_bytree=0.8,
            min_child_samples=100, verbose=-1, n_jobs=4
        )
        model.fit(X_tr, y_tr)
        preds = model.predict(X_test)

        ic, _ = spearmanr(preds, y_test)
        hr = (((preds > 0) & (y_test > 0)) | ((preds < 0) & (y_test < 0))).mean()
        elapsed = time.time() - t0

        results.append({
            "fold": test_idx, "date": test_date,
            "ic": float(ic), "hr": float(hr),
            "n": int(len(preds)), "train_n": int(len(y_tr))
        })
        all_preds.append(preds)
        all_targets.append(y_test)
        print(f"  Fold {test_idx} ({test_date}): IC={ic:+.4f} HR={100*hr:.1f}% n={len(preds)} train_n={len(y_tr)} [{elapsed:.1f}s]")
        sys.stdout.flush()

    if not results:
        print("No results - check data paths")
        return

    ics = [r["ic"] for r in results]
    concat_p = np.concatenate(all_preds)
    concat_t = np.concatenate(all_targets)
    concat_ic, _ = spearmanr(concat_p, concat_t)

    print(f"\n{'='*60}")
    print(f"PURE BOOK MICROSTRUCTURE LGBM -- FINAL ({len(ics)} folds)")
    print(f"{'='*60}")
    print(f"  Per-fold mean IC:  {np.mean(ics):+.4f} +/- {np.std(ics):.4f}")
    print(f"  CONCAT IC:         {concat_ic:+.4f}")
    print(f"  % positive folds:  {100*sum(1 for x in ics if x>0)/len(ics):.0f}%")
    print(f"  Total predictions: {len(concat_p):,}")
    print(f"{'='*60}")

    json.dump(
        {"results": results, "concat_ic": float(concat_ic),
         "mean_ic": float(np.mean(ics)), "std_ic": float(np.std(ics)),
         "pct_positive": float(sum(1 for x in ics if x>0)/len(ics))},
        open("C:/Users/claude/pure_mbo_lgbm_results.json", "w"), indent=2
    )
    print("Results saved to pure_mbo_lgbm_results.json")

if __name__ == "__main__":
    main()
