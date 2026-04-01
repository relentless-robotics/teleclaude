#!/usr/bin/env python3
"""
comprehensive_dynamic_exit_sweep.py -- Comprehensive sweep of ALL dynamic exit
strategies with higher confidence thresholds, vol gating, and safety nets.

Tests DYNAMIC EXITS ONLY (no static holds):
  - predstdExit (book model)
  - smoothExit (smooth model)
  - emaExit (momentum model)
  - z-score rolling mean exits (ema_zscore normalization)

Higher confidence thresholds: signal_threshold = [0.1, 0.15, 0.2, 0.3, 0.5]
Vol gating: vol = [50, 70, 80, 90]
Conviction levels: conv = [1.0, 1.5, 2.0, 2.5, 3.0]
Safety nets: SL (trailing) = [15, 20, 25, 30, None], TP = [3, 5, 10, 15, 20, None]
Chase entry: (1t/3r) — proven best from prior sweeps

Designed for Saturn (40 CPU workers). No GPU needed (fill_sim is CPU-only).
Uses cnn_wf_stacked_predictions dir for dynamic exit predictions.

Output: /home/saturn/Lvl3Quant/data/processed/comprehensive_dynamic_sweep/

Run: nohup python3 comprehensive_dynamic_exit_sweep.py --workers 40 &
"""
import os
import sys
import json
import time
import glob
import logging
import subprocess
import threading
import argparse
from pathlib import Path
from datetime import datetime
from itertools import product
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Paths (Saturn-local) ────────────────────────────────────────────────────
LVL3_ROOT = Path('/home/saturn/Lvl3Quant')
BINARY    = LVL3_ROOT / 'rust_cache_builder' / 'target' / 'release' / 'fill_sim_cli'
MBO_DIR   = LVL3_ROOT / 'data' / 'raw' / 'mbo'
OUT_DIR   = LVL3_ROOT / 'data' / 'processed' / 'comprehensive_dynamic_sweep'

# Prediction directories — dynamic exit preds are in stacked_predictions,
# norm sweep preds have the ema_zscore/smooth10 normalizations
STACKED_PRED_DIR = LVL3_ROOT / 'data' / 'processed' / 'cnn_wf_stacked_predictions'
NORM_PRED_DIR    = LVL3_ROOT / 'data' / 'processed' / 'cnn_wf_norm_sweep_predictions'
# Standard WF predictions (vol-gated, no exit baked in)
WF_PRED_DIR      = LVL3_ROOT / 'data' / 'processed' / 'cnn_wf_sim_predictions'

# ── Dynamic Exit Strategy Definitions ───────────────────────────────────────
# Dynamic exits are baked into the prediction file naming:
#   {date}_{model}_{exitType}_{params}.npz
# The fill_sim_cli reads these and the exit is embedded in the prediction signal.
# We still control: signal_threshold (conv), TP, SL (trailing), chase, latency.

# MODEL TYPES with their exit strategies and prediction file patterns
# Pattern: in stacked_predictions dir, files like:
#   2025-12-01_book_predstdExit_conv1.5_vol50.npz
#   2025-12-01_smooth_smoothExit_conv1.5_ethr0.0_vol70.npz
#   2025-12-01_mom_emaExit_conv0.3_ethr0.0_vol70.npz
# In norm_sweep dir, files like:
#   2025-12-01_ema_zscore_span5000_vol70.npz
#   2025-12-01_smooth10_expanding_vol70.npz

# ── Sweep Grid ──────────────────────────────────────────────────────────────

# Signal thresholds (higher = more selective entry)
SIGNAL_THRESHOLDS = [0.1, 0.15, 0.2, 0.3, 0.5]

# Vol gate thresholds (baked into prediction filenames for stacked preds)
VOL_THRESHOLDS = [50, 70, 80, 90]

# Conviction (baked into stacked pred filenames)
CONV_LEVELS = [1.0, 1.5, 2.0, 2.5, 3.0]

# Safety nets
TP_TICKS = [None, 3, 5, 10, 15, 20]   # None = no take profit
SL_TICKS = [None, 15, 20, 25, 30]     # None = no trailing stop (trailing-ticks)

# Hold time — long hold as safety net (dynamic exit should trigger before this)
HOLD_MS = 3600000  # 60 min max hold (dynamic exit decides when to actually exit)

# Chase entry — proven best from prior sweeps
CHASE_MAX_TICKS   = 1
CHASE_MAX_REPRICES = 3

# Latency — use 0ms for the comprehensive sweep (latency tested separately)
LATENCY_MS = 0

MAX_WORKERS = 40

# ── Logging ─────────────────────────────────────────────────────────────────
OUT_DIR.mkdir(parents=True, exist_ok=True)
ts = datetime.now().strftime('%Y%m%d_%H%M%S')
log_file = OUT_DIR / f'comprehensive_sweep_{ts}.log'

logging.basicConfig(
    format='%(asctime)s [comp_sweep] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
    handlers=[
        logging.FileHandler(str(log_file), mode='w', encoding='utf-8'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger('comp_sweep')


def find_mbo_files():
    """Build index: date_str -> Path for all MBO files."""
    mbo_index = {}
    for f in sorted(MBO_DIR.glob('glbx-mdp3-*.mbo.dbn.zst')):
        parts = f.name.split('-')
        if len(parts) >= 3:
            raw_date = parts[2].split('.')[0]
            if len(raw_date) == 8 and raw_date.isdigit():
                date_str = f'{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}'
                mbo_index[date_str] = f
    return mbo_index


def find_stacked_preds():
    """Build index: (date_str, file_pattern) -> Path for stacked prediction files.

    Stacked preds have dynamic exits baked in. File patterns like:
      book_predstdExit_conv1.5_vol50
      smooth_smoothExit_conv1.5_ethr0.0_vol70
      mom_emaExit_conv0.3_ethr0.0_vol70
    """
    pred_index = {}
    if not STACKED_PRED_DIR.exists():
        return pred_index
    for f in sorted(STACKED_PRED_DIR.glob('*.npz')):
        stem = f.stem
        if len(stem) < 12:
            continue
        date_str = stem[:10]
        pattern = stem[11:]  # everything after 'YYYY-MM-DD_'
        pred_index[(date_str, pattern)] = f
    return pred_index


def find_norm_preds():
    """Build index: (date_str, norm, vol) -> Path for norm sweep prediction files.

    Norm preds like: 2025-12-01_ema_zscore_span5000_vol70.npz
    """
    pred_index = {}
    if not NORM_PRED_DIR.exists():
        return pred_index
    for f in sorted(NORM_PRED_DIR.glob('*.npz')):
        bn = f.stem
        parts = bn.split('_', 1)
        if len(parts) < 2:
            continue
        date_str = parts[0]
        rest = parts[1]
        vol_idx = rest.rfind('_vol')
        if vol_idx < 0:
            continue
        norm = rest[:vol_idx]
        vol_str = rest[vol_idx + 4:]
        try:
            vol = int(vol_str)
        except ValueError:
            continue
        pred_index[(date_str, norm, vol)] = f
    return pred_index


def find_wf_preds():
    """Build index: (date_str, vol) -> Path for standard WF prediction files.

    WF preds like: 2025-12-01_vol70.npz
    """
    pred_index = {}
    if not WF_PRED_DIR.exists():
        return pred_index
    for f in sorted(WF_PRED_DIR.glob('*.npz')):
        parts = f.stem.split('_', 2)
        if len(parts) >= 2:
            date_str = parts[0]
            vol_str = parts[1]
            try:
                vg = int(vol_str.replace('vol', ''))
                pred_index[(date_str, vg)] = f
            except ValueError:
                pass
    return pred_index


def build_tasks(mbo_index, stacked_preds, norm_preds, wf_preds):
    """Build the complete task list across all strategies."""
    tasks = []
    skipped = 0

    # =========================================================================
    # SECTION 1: Stacked predictions with dynamic exits (book/smooth/mom)
    # These have the exit type baked into the prediction file.
    # We sweep: signal_threshold × TP × SL on each available prediction file.
    # =========================================================================

    log.info('--- Section 1: Stacked dynamic exit predictions ---')

    # Group stacked preds by their pattern (model_exit_conv_vol)
    stacked_patterns = set()
    for (date_str, pattern) in stacked_preds.keys():
        stacked_patterns.add(pattern)

    log.info(f'  Found {len(stacked_patterns)} unique stacked prediction patterns')
    for p in sorted(stacked_patterns):
        count = sum(1 for (d, pat) in stacked_preds if pat == p)
        log.info(f'    {p}: {count} dates')

    for (date_str, pattern), pred_file in sorted(stacked_preds.items()):
        if date_str not in mbo_index:
            continue
        mbo_file = mbo_index[date_str]

        for sig_thr in SIGNAL_THRESHOLDS:
            for tp in TP_TICKS:
                for sl in SL_TICKS:
                    tp_label = f'tp{tp}' if tp is not None else 'tpN'
                    sl_label = f'sl{sl}' if sl is not None else 'slN'
                    sig_label = f'sig{sig_thr}'.replace('.', 'p')

                    label = f'dyn_{pattern}_{sig_label}_{tp_label}_{sl_label}_{date_str}'
                    out_file = OUT_DIR / f'{label}.json'

                    if out_file.exists():
                        skipped += 1
                        continue

                    tasks.append({
                        'label': label,
                        'section': 'stacked_dynamic',
                        'strategy': pattern,
                        'mbo_file': str(mbo_file),
                        'pred_file': str(pred_file),
                        'out_file': str(out_file),
                        'signal_threshold': sig_thr,
                        'hold_ms': HOLD_MS,
                        'tp_ticks': tp,
                        'sl_ticks': sl,
                        'latency_ms': LATENCY_MS,
                    })

    # =========================================================================
    # SECTION 2: Norm sweep predictions (ema_zscore, smooth10_expanding)
    # These use z-score/rolling-mean-based exits from normalization.
    # Sweep: signal_threshold × TP × SL
    # =========================================================================

    log.info('--- Section 2: Norm sweep predictions (zscore/smooth exits) ---')

    TARGET_NORMS = ['ema_zscore_span5000', 'smooth10_expanding']
    NORM_VOLS = [50, 70, 80, 90]

    norm_task_count = 0
    for (date_str, norm, vol), pred_file in sorted(norm_preds.items()):
        if norm not in TARGET_NORMS:
            continue
        if vol not in NORM_VOLS:
            continue
        if date_str not in mbo_index:
            continue
        mbo_file = mbo_index[date_str]

        for sig_thr in SIGNAL_THRESHOLDS:
            for tp in TP_TICKS:
                for sl in SL_TICKS:
                    tp_label = f'tp{tp}' if tp is not None else 'tpN'
                    sl_label = f'sl{sl}' if sl is not None else 'slN'
                    sig_label = f'sig{sig_thr}'.replace('.', 'p')

                    label = f'dyn_{norm}_vol{vol}_{sig_label}_{tp_label}_{sl_label}_{date_str}'
                    out_file = OUT_DIR / f'{label}.json'

                    if out_file.exists():
                        skipped += 1
                        continue

                    tasks.append({
                        'label': label,
                        'section': 'norm_dynamic',
                        'strategy': f'{norm}_vol{vol}',
                        'mbo_file': str(mbo_file),
                        'pred_file': str(pred_file),
                        'out_file': str(out_file),
                        'signal_threshold': sig_thr,
                        'hold_ms': HOLD_MS,
                        'tp_ticks': tp,
                        'sl_ticks': sl,
                        'latency_ms': LATENCY_MS,
                    })
                    norm_task_count += 1

    log.info(f'  Norm sweep tasks: {norm_task_count}')

    # =========================================================================
    # SECTION 3: Standard WF predictions with conv sweep
    # These are the base WF model predictions (no exit baked in).
    # We use signal_threshold as the conviction level and sweep TP/SL.
    # Signal_threshold here acts as BOTH entry gate and conviction.
    # =========================================================================

    log.info('--- Section 3: WF base predictions with conv sweep ---')

    wf_task_count = 0
    WF_VOLS = [50, 70, 80, 90]
    # For WF preds, conv is set via signal_threshold
    WF_CONVICTIONS = [1.5, 2.0, 2.5, 3.0]

    for (date_str, vol), pred_file in sorted(wf_preds.items()):
        if vol not in WF_VOLS:
            continue
        if date_str not in mbo_index:
            continue
        mbo_file = mbo_index[date_str]

        for conv in WF_CONVICTIONS:
            for tp in TP_TICKS:
                for sl in SL_TICKS:
                    tp_label = f'tp{tp}' if tp is not None else 'tpN'
                    sl_label = f'sl{sl}' if sl is not None else 'slN'
                    conv_label = f'conv{conv}'.replace('.', 'p')

                    label = f'dyn_wf_vol{vol}_{conv_label}_{tp_label}_{sl_label}_{date_str}'
                    out_file = OUT_DIR / f'{label}.json'

                    if out_file.exists():
                        skipped += 1
                        continue

                    tasks.append({
                        'label': label,
                        'section': 'wf_conv_sweep',
                        'strategy': f'wf_vol{vol}_conv{conv}',
                        'mbo_file': str(mbo_file),
                        'pred_file': str(pred_file),
                        'out_file': str(out_file),
                        'signal_threshold': conv,
                        'hold_ms': HOLD_MS,
                        'tp_ticks': tp,
                        'sl_ticks': sl,
                        'latency_ms': LATENCY_MS,
                    })
                    wf_task_count += 1

    log.info(f'  WF conv sweep tasks: {wf_task_count}')

    # Deduplicate by label
    seen = set()
    unique_tasks = []
    dups = 0
    for t in tasks:
        if t['label'] not in seen:
            seen.add(t['label'])
            unique_tasks.append(t)
        else:
            dups += 1

    log.info(f'')
    log.info(f'Skipped (already done): {skipped}')
    log.info(f'Duplicates removed: {dups}')

    # Section breakdown
    section_counts = {}
    for t in unique_tasks:
        s = t['section']
        section_counts[s] = section_counts.get(s, 0) + 1
    for s, cnt in sorted(section_counts.items()):
        log.info(f'  {s}: {cnt:,} tasks')

    # Strategy breakdown
    strat_counts = {}
    for t in unique_tasks:
        s = t['strategy']
        strat_counts[s] = strat_counts.get(s, 0) + 1
    log.info(f'')
    log.info(f'Strategy breakdown:')
    for s, cnt in sorted(strat_counts.items()):
        log.info(f'  {s}: {cnt:,} tasks')

    return unique_tasks


def run_task(task):
    """Execute one fill_sim_cli job."""
    cmd = [
        str(BINARY),
        '--mbo-file',          task['mbo_file'],
        '--predictions',       task['pred_file'],
        '--output',            task['out_file'],
        '--signal-threshold',  str(task['signal_threshold']),
        '--hold-ms',           str(task['hold_ms']),
        '--latency-ms',        str(task['latency_ms']),
        '--chase-entry',
        '--chase-max-ticks',   str(CHASE_MAX_TICKS),
        '--chase-max-reprices', str(CHASE_MAX_REPRICES),
        '--quiet',
    ]
    if task['tp_ticks'] is not None:
        cmd += ['--take-profit-ticks', str(task['tp_ticks'])]
    if task['sl_ticks'] is not None:
        cmd += ['--trailing-ticks', str(task['sl_ticks'])]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        return r.returncode == 0 and os.path.exists(task['out_file'])
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Comprehensive dynamic exit sweep — all strategies × thresholds × safety nets')
    parser.add_argument('--workers', type=int, default=MAX_WORKERS,
                        help=f'Parallel workers (default {MAX_WORKERS})')
    parser.add_argument('--dry-run', action='store_true',
                        help='Count tasks only, do not execute')
    parser.add_argument('--section', type=str, default=None,
                        choices=['stacked_dynamic', 'norm_dynamic', 'wf_conv_sweep'],
                        help='Run only one section (default: all)')
    args = parser.parse_args()

    log.info('=' * 80)
    log.info('COMPREHENSIVE DYNAMIC EXIT SWEEP')
    log.info('=' * 80)
    log.info(f'  Signal thresholds:   {SIGNAL_THRESHOLDS}')
    log.info(f'  Vol gates:           {VOL_THRESHOLDS}')
    log.info(f'  Conv levels:         {CONV_LEVELS}')
    log.info(f'  TP ticks:            {TP_TICKS}')
    log.info(f'  SL (trailing) ticks: {SL_TICKS}')
    log.info(f'  Hold (safety net):   {HOLD_MS // 60000}m')
    log.info(f'  Chase:               ct{CHASE_MAX_TICKS}r{CHASE_MAX_REPRICES}')
    log.info(f'  Latency:             {LATENCY_MS}ms')
    log.info(f'  Workers:             {args.workers}')
    log.info(f'  Output:              {OUT_DIR}')
    log.info(f'  Section filter:      {args.section or "ALL"}')
    log.info('')

    # Discover files
    log.info('Discovering data files...')
    mbo_index = find_mbo_files()
    stacked_preds = find_stacked_preds()
    norm_preds = find_norm_preds()
    wf_preds = find_wf_preds()

    log.info(f'  MBO files:      {len(mbo_index)} dates')
    if mbo_index:
        log.info(f'    Range: {min(mbo_index)} to {max(mbo_index)}')
    log.info(f'  Stacked preds:  {len(stacked_preds)} files')
    log.info(f'  Norm preds:     {len(norm_preds)} files')
    log.info(f'  WF preds:       {len(wf_preds)} files')
    log.info('')

    # Build tasks
    tasks = build_tasks(mbo_index, stacked_preds, norm_preds, wf_preds)

    # Filter by section if requested
    if args.section:
        tasks = [t for t in tasks if t['section'] == args.section]
        log.info(f'Filtered to section={args.section}: {len(tasks):,} tasks')

    total = len(tasks)

    if total == 0:
        log.info('All tasks already complete (or no matching prediction files)!')
        return

    log.info(f'')
    log.info(f'Total tasks to run: {total:,}')
    est_hours = total * 2.5 / args.workers / 3600
    log.info(f'Est. time: {est_hours:.1f} hours at {args.workers} workers (~2.5s per task)')
    log.info('')

    if args.dry_run:
        log.info('DRY RUN — exiting without running tasks.')

        # Print estimated breakdown
        log.info('')
        log.info('Estimated job matrix:')

        # Count by TP x SL combination
        tp_sl_counts = {}
        for t in tasks:
            key = (t.get('tp_ticks'), t.get('sl_ticks'))
            tp_sl_counts[key] = tp_sl_counts.get(key, 0) + 1

        log.info(f'  TP × SL combinations:')
        for (tp, sl), cnt in sorted(tp_sl_counts.items()):
            log.info(f'    TP={tp}, SL={sl}: {cnt:,}')

        return

    # Run sweep
    done    = 0
    failed  = 0
    lock    = threading.Lock()
    start   = time.time()
    last_rpt = [time.time()]
    REPORT_INTERVAL = 300  # 5 minutes

    # Checkpoint progress to file every 5 min
    checkpoint_file = OUT_DIR / 'sweep_progress.json'

    def run_and_track(task):
        nonlocal done, failed
        ok = run_task(task)
        with lock:
            if ok:
                done += 1
            else:
                failed += 1
            total_done = done + failed
            now = time.time()
            if now - last_rpt[0] >= REPORT_INTERVAL:
                elapsed = now - start
                rate = total_done / elapsed * 60 if elapsed > 0 else 0
                remain = (total - total_done) / (total_done / elapsed) if total_done > 0 else 0
                pct = total_done / total * 100
                log.info(
                    f'Progress: {total_done:,}/{total:,} ({pct:.1f}%) '
                    f'| {rate:.0f}/min | OK={done:,} FAIL={failed:,} '
                    f'| ETA: {remain/3600:.1f}h'
                )
                # Write checkpoint
                try:
                    with open(checkpoint_file, 'w') as cp:
                        json.dump({
                            'total': total,
                            'done': done,
                            'failed': failed,
                            'elapsed_sec': elapsed,
                            'rate_per_min': rate,
                            'eta_hours': remain / 3600,
                            'timestamp': datetime.now().isoformat(),
                        }, cp)
                except Exception:
                    pass
                last_rpt[0] = now
        return ok

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(run_and_track, t): t for t in tasks}
        for f in as_completed(futures):
            pass

    elapsed = time.time() - start

    log.info('')
    log.info('=' * 80)
    log.info('SWEEP COMPLETE')
    log.info('=' * 80)
    log.info(f'  Done:     {done:,}')
    log.info(f'  Failed:   {failed:,}')
    log.info(f'  Total:    {total:,}')
    log.info(f'  Time:     {elapsed/3600:.2f}h')
    log.info(f'  Rate:     {(done + failed) / elapsed * 60:.0f}/min')
    log.info(f'  Output:   {OUT_DIR}')
    n_output = len(list(OUT_DIR.glob('dyn_*.json')))
    log.info(f'  Files:    {n_output:,}')

    # ── Summary by strategy ──────────────────────────────────────────────────
    log.info('')
    log.info('Summary by strategy:')

    strat_results = {}
    for f in OUT_DIR.glob('dyn_*.json'):
        try:
            with open(f) as fh:
                d = json.load(fh)
            # Extract strategy from filename
            parts = f.stem.split('_sig')
            if len(parts) >= 2:
                strat = parts[0].replace('dyn_', '')
            else:
                strat = 'unknown'

            if strat not in strat_results:
                strat_results[strat] = {'sharpes': [], 'pnls': [], 'trades': [], 'count': 0}
            strat_results[strat]['sharpes'].append(d.get('sharpe_ratio', 0))
            strat_results[strat]['pnls'].append(d.get('total_pnl_ticks', 0))
            strat_results[strat]['trades'].append(d.get('num_trades', 0))
            strat_results[strat]['count'] += 1
        except Exception:
            pass

    log.info(f'{"Strategy":<45} {"Files":>6} {"Avg Sharpe":>12} {"Avg PnL(t)":>12} {"Avg Trades":>12}')
    log.info('-' * 95)
    for strat in sorted(strat_results.keys()):
        r = strat_results[strat]
        n = r['count']
        avg_sharpe = sum(r['sharpes']) / n if n > 0 else 0
        avg_pnl = sum(r['pnls']) / n if n > 0 else 0
        avg_trades = sum(r['trades']) / n if n > 0 else 0
        log.info(f'{strat:<45} {n:>6} {avg_sharpe:>12.3f} {avg_pnl:>12.1f} {avg_trades:>12.1f}')

    # ── Top 20 configs ───────────────────────────────────────────────────────
    log.info('')
    log.info('Top 20 configs by total PnL (ticks):')

    # Aggregate by config (strategy + signal_thr + tp + sl)
    config_agg = {}
    for f in OUT_DIR.glob('dyn_*.json'):
        try:
            with open(f) as fh:
                d = json.load(fh)
            # Remove the date suffix for aggregation
            stem = f.stem
            # Find the date at the end (YYYY-MM-DD)
            if len(stem) > 11 and stem[-10:-9] == '-' and stem[-7:-6] == '-':
                config_key = stem[4:-11]  # strip 'dyn_' prefix and '_YYYY-MM-DD' suffix
            else:
                config_key = stem

            if config_key not in config_agg:
                config_agg[config_key] = {'pnl': 0, 'trades': 0, 'days': 0, 'sharpes': []}
            config_agg[config_key]['pnl'] += d.get('total_pnl_ticks', 0)
            config_agg[config_key]['trades'] += d.get('num_trades', 0)
            config_agg[config_key]['days'] += 1
            s = d.get('sharpe_ratio', 0)
            if d.get('num_trades', 0) > 0:
                config_agg[config_key]['sharpes'].append(s)
        except Exception:
            pass

    sorted_configs = sorted(config_agg.items(), key=lambda x: x[1]['pnl'], reverse=True)

    log.info(f'{"Config":<60} {"PnL(t)":>10} {"Trades":>8} {"Days":>5} {"AvgSharpe":>10}')
    log.info('-' * 98)
    for config, r in sorted_configs[:20]:
        avg_s = sum(r['sharpes']) / len(r['sharpes']) if r['sharpes'] else 0
        log.info(f'{config:<60} {r["pnl"]:>10.1f} {r["trades"]:>8} {r["days"]:>5} {avg_s:>10.3f}')

    # Save final checkpoint
    try:
        with open(checkpoint_file, 'w') as cp:
            json.dump({
                'status': 'COMPLETE',
                'total': total,
                'done': done,
                'failed': failed,
                'elapsed_hours': elapsed / 3600,
                'output_files': n_output,
                'timestamp': datetime.now().isoformat(),
            }, cp)
    except Exception:
        pass


if __name__ == '__main__':
    main()
