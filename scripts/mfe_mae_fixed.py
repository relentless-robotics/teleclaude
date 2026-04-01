import os, sys, glob, json, numpy as np, time
from pathlib import Path

DATA_DIR = "C:/Users/claude/Lvl3Quant/data/processed/dl_book_cache"
OUT_JSON = os.path.join(DATA_DIR, "mfe_mae_multihorizon_results.json")
LOG_FILE = "C:/Users/claude/Lvl3Quant/logs/mfe_mae_multihorizon.log"
BATCH_SIZE = 15  # 15 days at a time to stay under 6GB RAM

SIGNALS = ["imbalance", "queue_fade", "iceberg", "sweep", "momentum"]
HORIZONS = [
    ("10s",   100),
    ("30s",   300),
    ("1min",  600),
    ("5min",  3000),
    ("15min", 9000),
    ("30min", 18000),
]

def log(msg):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def compute_mfe_mae_batch(prices, sigs, horizon_bars):
    results = {}
    for sig_name in SIGNALS:
        if sig_name not in sigs:
            continue
        sig = sigs[sig_name].astype(np.float32)
        prices_f = prices.astype(np.float32)
        active = np.where(sig != 0)[0]
        active = active[active + horizon_bars < len(prices_f)]
        if len(active) == 0:
            results[sig_name] = {"n": 0, "mfe": 0.0, "mae": 0.0, "edge": 0.0, "ic": 0.0, "sortino": 0.0}
            continue
        if len(active) > 200000:
            rng = np.random.default_rng(42)
            active = rng.choice(active, 200000, replace=False)
        dirs = np.sign(sig[active]).astype(np.float32)
        CHUNK = 5000
        mfes, maes, rets, sig_mags = [], [], [], []
        for start in range(0, len(active), CHUNK):
            idx = active[start:start+CHUNK]
            d = dirs[start:start+CHUNK]
            paths = np.stack([prices_f[i:i+horizon_bars] - prices_f[i] for i in idx], axis=0)
            signed = paths * d[:, None]
            mfes.append(signed.max(axis=1))
            maes.append((-signed).max(axis=1))
            rets.append(signed[:, -1])
            sig_mags.append(np.abs(sig[idx]))
            del paths, signed
        mfes = np.concatenate(mfes)
        maes = np.concatenate(maes)
        rets = np.concatenate(rets)
        sig_mags = np.concatenate(sig_mags)
        mfe_m = float(np.mean(mfes))
        mae_m = float(np.mean(maes))
        edge = mfe_m / max(mfe_m + mae_m, 1e-9)
        ic = float(np.corrcoef(sig_mags, rets)[0,1]) if len(rets) > 10 else 0.0
        neg = rets[rets < 0]
        ds = float(np.std(neg)) if len(neg) > 5 else 1e-9
        sortino = float(np.mean(rets)) / ds if ds > 0 else 0.0
        results[sig_name] = {
            "n": int(len(active)),
            "mfe": round(mfe_m / 0.25, 4),
            "mae": round(mae_m / 0.25, 4),
            "edge": round(edge, 4),
            "ic": round(ic, 4),
            "sortino": round(sortino, 4),
        }
        del mfes, maes, rets, sig_mags, sig, active
        import gc; gc.collect()
    return results

def main():
    import gc
    log("=== MFE/MAE Multi-Horizon (memory-efficient, batched) ===")
    files = sorted(glob.glob(os.path.join(DATA_DIR, "*_book_tensors.npz")))
    log(f"Found {len(files)} files, batch_size={BATCH_SIZE}")

    acc = {sig: {h[0]: {"n":0,"mfe_wsum":0.0,"mae_wsum":0.0,"edge_wsum":0.0,"ic_wsum":0.0,"sortino_wsum":0.0} for h in HORIZONS} for sig in SIGNALS}

    for batch_start in range(0, len(files), BATCH_SIZE):
        batch = files[batch_start:batch_start+BATCH_SIZE]
        log(f"Batch {batch_start//BATCH_SIZE+1}/{(len(files)+BATCH_SIZE-1)//BATCH_SIZE}: files {batch_start+1}-{batch_start+len(batch)}")

        price_arrs, sig_arrs = [], {s:[] for s in SIGNALS}
        for f in batch:
            try:
                d = np.load(f, allow_pickle=False)
                keys = list(d.keys())
                # Find price key
                p_key = next((k for k in keys if k in ["prices","mid","mid_price","price"]), keys[0] if keys else None)
                if p_key is None:
                    continue
                price_arrs.append(d[p_key].astype(np.float32))
                for sig in SIGNALS:
                    if sig in d:
                        sig_arrs[sig].append(d[sig].astype(np.float32))
                    else:
                        sig_arrs[sig].append(None)
                d.close()
            except Exception as e:
                log(f"  Skip {os.path.basename(f)}: {e}")

        if not price_arrs:
            continue

        prices_cat = np.concatenate(price_arrs)
        sigs_cat = {}
        for sig in SIGNALS:
            arrs = [a for a in sig_arrs[sig] if a is not None]
            if arrs:
                # Pad lengths to match prices
                sigs_cat[sig] = np.concatenate(arrs[:len(price_arrs)])

        # Align lengths
        min_len = min(len(prices_cat), min((len(v) for v in sigs_cat.values()), default=len(prices_cat)))
        prices_cat = prices_cat[:min_len]
        sigs_cat = {k: v[:min_len] for k, v in sigs_cat.items()}

        log(f"  Loaded {len(prices_cat):,} bars")

        for h_name, h_bars in HORIZONS:
            log(f"  Horizon {h_name}...")
            r = compute_mfe_mae_batch(prices_cat, sigs_cat, h_bars)
            for sig, rv in r.items():
                if rv["n"] > 0:
                    a = acc[sig][h_name]
                    a["n"] += rv["n"]
                    a["mfe_wsum"] += rv["mfe"] * rv["n"]
                    a["mae_wsum"] += rv["mae"] * rv["n"]
                    a["edge_wsum"] += rv["edge"] * rv["n"]
                    a["ic_wsum"] += rv["ic"] * rv["n"]
                    a["sortino_wsum"] += rv["sortino"] * rv["n"]

        del prices_cat, price_arrs, sig_arrs, sigs_cat
        gc.collect()

    # Build output
    out = {"completed": time.strftime("%Y-%m-%d %H:%M:%S"), "signals": {}}
    for sig in SIGNALS:
        out["signals"][sig] = {}
        for h_name, _ in HORIZONS:
            a = acc[sig][h_name]
            n = a["n"]
            if n > 0:
                out["signals"][sig][h_name] = {
                    "n": n,
                    "mfe_ticks": round(a["mfe_wsum"]/n, 4),
                    "mae_ticks": round(a["mae_wsum"]/n, 4),
                    "edge_ratio": round(a["edge_wsum"]/n, 4),
                    "ic": round(a["ic_wsum"]/n, 4),
                    "sortino": round(a["sortino_wsum"]/n, 4),
                }
            else:
                out["signals"][sig][h_name] = {"n": 0}

    with open(OUT_JSON, "w") as f:
        json.dump(out, f, indent=2)
    log(f"COMPLETE: {OUT_JSON}")

    log("\n=== SUMMARY ===")
    for sig in SIGNALS:
        for h_name, _ in HORIZONS:
            r = out["signals"][sig].get(h_name, {})
            if r.get("n", 0) > 0:
                log(f"  {sig:15s} {h_name:5s}: MFE={r['mfe_ticks']:.3f}t MAE={r['mae_ticks']:.3f}t edge={r['edge_ratio']:.3f} IC={r['ic']:.4f} Sortino={r['sortino']:.3f}")

main()
