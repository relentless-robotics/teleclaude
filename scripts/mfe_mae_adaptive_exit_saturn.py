#!/usr/bin/env python3
"""
MFE/MAE Adaptive Exit Prototype — Saturn
Uses MFE/MAE predictions to set adaptive TP/SL:
  TP = predicted_MFE * tp_scale
  SL = predicted_MAE * sl_scale
Tests adaptive vs fixed TP/SL in fill sim.

Checks /home/saturn/Lvl3Quant/ for MFE/MAE npz files.
If full model isn't done, prototypes exit logic using ratchet_mae_validation data.

Deployment: /home/saturn/Lvl3Quant/
"""
import sys, json, time, logging, subprocess, tempfile
import numpy as np
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(
    format='%(asctime)s [mfe_mae_exit] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
)
log = logging.getLogger('mfe_mae_exit')

LVL3_ROOT = Path("/home/saturn/Lvl3Quant")
BINARY = LVL3_ROOT / "rust_cache_builder" / "target" / "release" / "fill_sim_cli"
MBO_DIR = LVL3_ROOT / "data" / "raw" / "mbo"
CNN_PRED_DIR = LVL3_ROOT / "data" / "processed" / "cnn_wf_sim_predictions"
RATCHET_DIR = LVL3_ROOT / "data" / "processed" / "ratchet_mae_validation"
MAE_MFE_PRED_DIR = LVL3_ROOT / "data" / "processed" / "mfe_mae_predictions"
OUT_DIR = LVL3_ROOT / "data" / "processed" / "mfe_mae_adaptive_exit"
OUT_DIR.mkdir(parents=True, exist_ok=True)

WORKERS = 40

# Default TP/SL benchmarks (fixed)
FIXED_CONFIGS = [
    {'tp': 5,  'sl': 10, 'label': 'fixed_tp5_sl10'},
    {'tp': 8,  'sl': 15, 'label': 'fixed_tp8_sl15'},
    {'tp': 10, 'sl': 20, 'label': 'fixed_tp10_sl20'},
    {'tp': 15, 'sl': 25, 'label': 'fixed_tp15_sl25'},
]

# Adaptive scale factors to sweep
TP_SCALES = [0.5, 0.7, 0.9, 1.0, 1.2]
SL_SCALES = [0.5, 0.7, 0.9, 1.0, 1.2]

# MFE/MAE proxy constants (from prior research: z>2.0 signals)
# If no model available, use empirical estimates from signal edge analysis
EMPIRICAL_MFE_MEAN = 12.0   # ticks, from 2026-03-27 research
EMPIRICAL_MAE_MEAN = 6.0    # ticks
EMPIRICAL_MFE_STD  = 5.0
EMPIRICAL_MAE_STD  = 3.0


def find_mfe_mae_files():
    """Search for MFE/MAE prediction files across the repo."""
    search_dirs = [
        LVL3_ROOT / "data" / "processed",
        LVL3_ROOT / "alpha_discovery",
        LVL3_ROOT,
    ]
    patterns = ['*mfe*', '*mae*', '*mfe_mae*']
    found = []
    for d in search_dirs:
        for p in patterns:
            for f in d.glob(f"**/{p}.npz"):
                found.append(f)
    return found


def load_ratchet_mae_data():
    """
    Load ratchet MAE validation data as a proxy for MFE/MAE predictions.
    Returns: dict of {date_str: {'predicted_mae': float, 'actual_mae': float}}
    """
    if not RATCHET_DIR.exists():
        return {}

    mae_by_date = {}
    for f in sorted(RATCHET_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            # Extract date from filename: card1_C_mae_2025-12-02.json
            parts = f.stem.split('_')
            date_str = parts[-1] if len(parts) > 0 else None
            if date_str and len(date_str) == 10:
                date_nodash = date_str.replace('-', '')
                mae_val = data.get('mae_ticks', data.get('stop_loss_ticks', EMPIRICAL_MAE_MEAN))
                mfe_val = data.get('mfe_ticks', data.get('take_profit_ticks', EMPIRICAL_MFE_MEAN))
                mae_by_date[date_nodash] = {
                    'predicted_mae': float(mae_val),
                    'predicted_mfe': float(mfe_val),
                    'source': f.name,
                }
        except Exception as e:
            log.debug(f"Error reading {f.name}: {e}")

    log.info(f"Loaded ratchet MAE data for {len(mae_by_date)} dates")
    return mae_by_date


def get_mfe_mae_proxy_per_bar(preds_arr, date_nodash, mae_by_date):
    """
    Build per-bar MFE/MAE estimates.

    Strategy:
    1. If we have a per-date MAE estimate from ratchet data, use that
    2. Otherwise, use signal strength to modulate: stronger signal -> higher MFE
    3. Empirical fallback if nothing available

    Returns: (mfe_arr, mae_arr) — one value per bar
    """
    n = len(preds_arr)
    abs_preds = np.abs(preds_arr)

    # Get date-level estimates
    date_mae = EMPIRICAL_MAE_MEAN
    date_mfe = EMPIRICAL_MFE_MEAN
    if date_nodash in mae_by_date:
        date_mae = mae_by_date[date_nodash]['predicted_mae']
        date_mfe = mae_by_date[date_nodash]['predicted_mfe']

    # Modulate by signal strength: normalize to [0.5, 2.0] range
    max_sig = abs_preds.max()
    if max_sig > 0:
        sig_scale = 0.5 + 1.5 * (abs_preds / (max_sig + 1e-8))
    else:
        sig_scale = np.ones(n)

    mfe_arr = date_mfe * sig_scale
    mae_arr = date_mae * (2.0 - sig_scale)  # Inverse: weaker signal = worse adversity

    # Clip to reasonable range
    mfe_arr = np.clip(mfe_arr, 2.0, 40.0)
    mae_arr = np.clip(mae_arr, 2.0, 30.0)

    return mfe_arr, mae_arr


def create_adaptive_predictions_file(preds_arr, mfe_arr, mae_arr,
                                      tp_scale, sl_scale, out_path):
    """
    Create modified prediction file with adaptive TP/SL baked in.

    Note: The Rust fill_sim uses a FIXED TP/SL per run.
    To simulate per-signal adaptive exits, we need to:
    1. Group signals by their (rounded) TP/SL values
    2. Run separate fill_sim passes for each group
    3. Merge results

    Here we compute the most representative TP/SL for this date,
    then save a metadata file with the adaptive config.
    """
    nonzero = preds_arr != 0
    if nonzero.sum() == 0:
        return None, None

    # Compute adaptive TP/SL for active signals
    tp_values = mfe_arr[nonzero] * tp_scale
    sl_values = mae_arr[nonzero] * sl_scale

    # Use median as representative fixed TP/SL for this date
    med_tp = float(np.median(tp_values))
    med_sl = float(np.median(sl_values))

    # Round to nearest tick
    med_tp = round(med_tp)
    med_sl = round(med_sl)

    # Clip to valid range
    med_tp = max(2, min(med_tp, 30))
    med_sl = max(2, min(med_sl, 40))

    # Save predictions (unchanged — TP/SL are fill_sim args)
    np.savez_compressed(str(out_path), predictions=preds_arr)

    return med_tp, med_sl


def run_fill_sim(mbo_file, pred_file, out_file, tp, sl, signal_threshold=0.1,
                 hold_ms=3600000):
    """Run Rust fill_sim_cli."""
    cmd = [
        str(BINARY),
        "--mbo-file", str(mbo_file),
        "--predictions", str(pred_file),
        "--output", str(out_file),
        "--hold-ms", str(hold_ms),
        "--signal-threshold", str(signal_threshold),
        "--latency-ms", "0",
        "--chase-entry",
        "--chase-max-ticks", "2",
        "--chase-max-reprices", "5",
        "--quiet",
    ]
    if tp is not None:
        cmd += ["--take-profit-ticks", str(tp)]
    if sl is not None:
        cmd += ["--stop-loss-ticks", str(sl)]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        return r.returncode == 0 and Path(out_file).exists()
    except:
        return False


def aggregate_results(result_dir: Path):
    """Aggregate fill sim results.
    fill_sim_cli outputs: total_pnl_dollars, total_trades, win_rate (0-1 float)
    """
    daily_pnl = []
    total_trades = 0
    total_wins = 0

    for f in sorted(result_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            # fill_sim outputs total_pnl_dollars (not ticks), win_rate as float
            pnl = data.get('total_pnl_dollars',
                  data.get('total_pnl_ticks',
                  data.get('pnl_ticks', 0)))
            trades = data.get('total_trades', data.get('n_trades', 0))
            wr = data.get('win_rate', 0)
            wins = data.get('winning_trades', data.get('n_wins', int(wr * trades)))
            daily_pnl.append(pnl)
            total_trades += trades
            total_wins += wins
        except:
            pass

    if not daily_pnl or total_trades == 0:
        return None

    arr = np.array(daily_pnl)
    mean_pnl = float(np.mean(arr))
    neg = arr[arr < 0]
    downside_std = float(np.std(neg)) if len(neg) > 1 else 1e-8
    sortino = mean_pnl / (downside_std + 1e-8)
    sharpe = mean_pnl / (float(np.std(arr)) + 1e-8)

    return {
        'n_days': len(daily_pnl),
        'total_trades': total_trades,
        'total_pnl_ticks': float(np.sum(arr)),
        'mean_daily_pnl': mean_pnl,
        'sortino': sortino,
        'sharpe': sharpe,
        'win_rate': total_wins / total_trades if total_trades > 0 else 0,
        'pct_positive_days': float((arr > 0).mean()),
    }


def run_fixed_benchmarks(cnn_files_vg, mae_by_date):
    """Run fixed TP/SL benchmarks for comparison."""
    log.info("\n=== FIXED TP/SL BENCHMARKS ===")
    fixed_results = {}

    for cfg in FIXED_CONFIGS:
        label = cfg['label']
        tp = cfg['tp']
        sl = cfg['sl']
        run_dir = OUT_DIR / f"fixed_{label}"
        run_dir.mkdir(exist_ok=True)

        jobs = []
        for pf in cnn_files_vg:
            stem = pf.stem
            date = stem[:10].replace('-', '')
            mbo = MBO_DIR / f"glbx-mdp3-{date}.mbo.dbn.zst"
            if not mbo.exists():
                continue
            out = run_dir / f"{stem}.json"
            if out.exists():
                continue
            jobs.append((mbo, pf, out))

        log.info(f"Fixed {label}: {len(jobs)} jobs...")
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(run_fill_sim, m, p, o, tp, sl): o for m, p, o in jobs}
            done = sum(1 for f in as_completed(futs) if f.result())
        log.info(f"  Done: {done}/{len(jobs)}")

        metrics = aggregate_results(run_dir)
        if metrics:
            fixed_results[label] = metrics
            log.info(f"  {label}: Sortino={metrics['sortino']:.3f}, "
                     f"Sharpe={metrics['sharpe']:.3f}, "
                     f"Trades={metrics['total_trades']}, "
                     f"WR={metrics['win_rate']:.2%}, "
                     f"PnL={metrics['total_pnl_ticks']:.1f}t")

    return fixed_results


def run_adaptive_sweep(cnn_files_vg, mae_by_date):
    """Sweep TP/SL scale factors for adaptive exits."""
    log.info("\n=== ADAPTIVE MFE/MAE EXIT SWEEP ===")
    adaptive_results = {}

    for tp_scale in TP_SCALES:
        for sl_scale in SL_SCALES:
            label = f"adaptive_tp{int(tp_scale*10)}_sl{int(sl_scale*10)}"
            run_dir = OUT_DIR / label
            run_dir.mkdir(exist_ok=True)
            tmp_pred_dir = OUT_DIR / f"tmp_preds_{label}"
            tmp_pred_dir.mkdir(exist_ok=True)

            jobs = []
            for pf in cnn_files_vg:
                stem = pf.stem
                date = stem[:10].replace('-', '')
                mbo = MBO_DIR / f"glbx-mdp3-{date}.mbo.dbn.zst"
                if not mbo.exists():
                    continue

                out = run_dir / f"{stem}.json"
                if out.exists():
                    continue

                try:
                    d = np.load(pf)
                    preds = d['predictions']
                except Exception as e:
                    log.debug(f"Error loading {pf.name}: {e}")
                    continue

                mfe_arr, mae_arr = get_mfe_mae_proxy_per_bar(preds, date, mae_by_date)
                tmp_pred = tmp_pred_dir / f"{stem}.npz"
                med_tp, med_sl = create_adaptive_predictions_file(
                    preds, mfe_arr, mae_arr, tp_scale, sl_scale, tmp_pred
                )

                if med_tp is None:
                    continue

                jobs.append((mbo, tmp_pred, out, med_tp, med_sl))

            log.info(f"Adaptive {label}: {len(jobs)} jobs (TP scale={tp_scale}, SL scale={sl_scale})...")

            with ThreadPoolExecutor(max_workers=WORKERS) as ex:
                futs = {ex.submit(run_fill_sim, m, p, o, tp, sl): o
                        for m, p, o, tp, sl in jobs}
                done = sum(1 for f in as_completed(futs) if f.result())
            log.info(f"  Done: {done}/{len(jobs)}")

            metrics = aggregate_results(run_dir)
            if metrics:
                adaptive_results[label] = {**metrics, 'tp_scale': tp_scale, 'sl_scale': sl_scale}
                log.info(f"  {label}: Sortino={metrics['sortino']:.3f}, "
                         f"Trades={metrics['total_trades']}, "
                         f"WR={metrics['win_rate']:.2%}")

    return adaptive_results


def main():
    log.info("=" * 60)
    log.info("MFE/MAE ADAPTIVE EXIT PROTOTYPE")
    log.info("=" * 60)

    if not BINARY.exists():
        log.error(f"fill_sim binary not found: {BINARY}")
        sys.exit(1)

    # Search for MFE/MAE prediction files
    log.info("Searching for MFE/MAE prediction files...")
    mfe_mae_files = find_mfe_mae_files()
    if mfe_mae_files:
        log.info(f"Found {len(mfe_mae_files)} MFE/MAE files:")
        for f in mfe_mae_files[:5]:
            log.info(f"  {f}")
            try:
                d = np.load(f)
                log.info(f"    keys: {list(d.keys())}")
            except:
                pass
    else:
        log.info("No MFE/MAE model predictions found — using proxy from ratchet MAE data")

    # Load ratchet MAE data as proxy
    mae_by_date = load_ratchet_mae_data()
    if mae_by_date:
        sample_dates = list(mae_by_date.keys())[:3]
        for d in sample_dates:
            log.info(f"  Sample: {d} -> MAE={mae_by_date[d]['predicted_mae']:.1f}t, "
                     f"MFE={mae_by_date[d]['predicted_mfe']:.1f}t")
    else:
        log.info(f"Using empirical defaults: MFE={EMPIRICAL_MFE_MEAN}t, MAE={EMPIRICAL_MAE_MEAN}t")

    # Get CNN prediction files
    cnn_files = sorted(CNN_PRED_DIR.glob("*.npz"))
    cnn_files_vg = [f for f in cnn_files if 'vol70' in f.name]
    if not cnn_files_vg:
        cnn_files_vg = cnn_files[:40]

    log.info(f"\nCNN prediction files: {len(cnn_files_vg)} (vol70 filter)")

    if not cnn_files_vg:
        log.error("No CNN prediction files found")
        sys.exit(1)

    # Run fixed benchmarks
    fixed_results = run_fixed_benchmarks(cnn_files_vg, mae_by_date)

    # Run adaptive sweep
    adaptive_results = run_adaptive_sweep(cnn_files_vg, mae_by_date)

    # Final comparison
    log.info("\n" + "=" * 60)
    log.info("FINAL COMPARISON: FIXED vs ADAPTIVE")
    log.info("=" * 60)

    log.info("\nFixed TP/SL benchmarks:")
    for label, m in sorted(fixed_results.items(), key=lambda x: -x[1]['sortino']):
        log.info(f"  {label:30s}: Sortino={m['sortino']:6.3f}  Sharpe={m['sharpe']:6.3f}  "
                 f"WR={m['win_rate']:.2%}  PnL={m['total_pnl_ticks']:8.1f}t  "
                 f"Trades={m['total_trades']}")

    log.info("\nAdaptive exits (top 10 by Sortino):")
    sorted_adaptive = sorted(adaptive_results.items(), key=lambda x: -x[1]['sortino'])
    for label, m in sorted_adaptive[:10]:
        log.info(f"  {label:30s}: Sortino={m['sortino']:6.3f}  Sharpe={m['sharpe']:6.3f}  "
                 f"WR={m['win_rate']:.2%}  PnL={m['total_pnl_ticks']:8.1f}t  "
                 f"TPscale={m['tp_scale']}  SLscale={m['sl_scale']}")

    # Best fixed
    if fixed_results:
        best_fixed = max(fixed_results.items(), key=lambda x: x[1]['sortino'])
        log.info(f"\nBest fixed: {best_fixed[0]}, Sortino={best_fixed[1]['sortino']:.3f}")

    # Best adaptive
    if adaptive_results:
        best_adaptive = max(adaptive_results.items(), key=lambda x: x[1]['sortino'])
        log.info(f"Best adaptive: {best_adaptive[0]}, Sortino={best_adaptive[1]['sortino']:.3f}")

        if fixed_results:
            best_fixed_sortino = best_fixed[1]['sortino']
            best_adaptive_sortino = best_adaptive[1]['sortino']
            lift = best_adaptive_sortino - best_fixed_sortino
            log.info(f"\nAdaptive vs Fixed lift: {lift:+.3f} Sortino")
            if lift > 0:
                log.info("RESULT: Adaptive exits OUTPERFORM fixed TP/SL")
            else:
                log.info("RESULT: Adaptive exits do NOT outperform fixed TP/SL with current proxy")

    # Save summary
    summary = {
        'fixed': fixed_results,
        'adaptive': adaptive_results,
        'mae_source': 'ratchet_mae_validation' if mae_by_date else 'empirical_defaults',
        'n_dates_with_mae': len(mae_by_date),
        'empirical_mfe': EMPIRICAL_MFE_MEAN,
        'empirical_mae': EMPIRICAL_MAE_MEAN,
    }

    summary_file = OUT_DIR / "adaptive_exit_summary.json"
    summary_file.write_text(json.dumps(summary, indent=2, default=str))
    log.info(f"\nFull summary saved to {summary_file}")


if __name__ == "__main__":
    main()
