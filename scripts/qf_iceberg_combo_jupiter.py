#!/usr/bin/env python3
"""
Queue-fade entry + iceberg exit combo fill sim on Jupiter.
Tests the signal_combo_entry_exit finding: qf→iceberg Sortino=0.294, WR=76.8%.

Key differences from razer qf_iceberg_chase:
- Uses Jupiter's dl_book_cache_oot (OOT predictions)
- Tests LOW-VOL regime gating (doubles IC based on prior findings)
- Tests passive limit entry (not just chase) — lower fill rate but zero slippage
- 3 entry modes × 4 exit configs × low_vol gating on/off = 24 configs
- Target: 84+ OOT days

Entry modes:
  1. passive: limit at touch price (zero slippage, ~20-30% fill rate)
  2. chase: limit with repricing (2 ticks, 5 reprices)
  3. chase_aggressive: limit with repricing (3 ticks, 8 reprices, force_cross)

Exit configs (iceberg prediction as exit trigger):
  A. hold30s_tp4_sl8: TP=4t SL=8t hold=30s
  B. hold15s_tp3_sl6: TP=3t SL=6t hold=15s
  C. hold60s_tp6_sl12: TP=6t SL=12t hold=60s
  D. hold30s_tp3_sl6: TP=3t SL=6t hold=30s (tighter)

Vol gating: low-vol only (vol_50 < median) or all regimes.

Signals used:
- Entry: queue_fade predictions from dl_book_cache_oot (cv-based _preds.npz files)
- Exit: iceberg predictions from same npz (if available) OR time-based

Output: /home/jupiter/Lvl3Quant/data/processed/qf_iceberg_combo/
"""
import os, sys, json, glob, time, subprocess
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing

BOOK_CACHE = '/home/jupiter/Lvl3Quant/data/processed/dl_book_cache_oot'
OUTPUT_DIR = '/home/jupiter/Lvl3Quant/data/processed/qf_iceberg_combo'
MBO_DIR = '/home/jupiter/Lvl3Quant/data/raw/mbo'
LOG_FILE = '/home/jupiter/Lvl3Quant/data/processed/qf_iceberg_combo.log'

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Signal configs
ENTRY_CONFIGS = [
    {'name': 'passive',            'market_entry': False, 'chase_entry': False},
    {'name': 'chase2t',            'market_entry': False, 'chase_entry': True,  'chase_max_ticks': 2.0, 'chase_max_reprices': 5,  'chase_force_cross': False},
    {'name': 'chase3t_aggressive', 'market_entry': False, 'chase_entry': True,  'chase_max_ticks': 3.0, 'chase_max_reprices': 8,  'chase_force_cross': True},
]

EXIT_CONFIGS = [
    {'name': 'hold30s_tp4_sl8',  'hold_ms': 30000, 'take_profit_ticks': 4.0,  'stop_loss_ticks': 8.0},
    {'name': 'hold15s_tp3_sl6',  'hold_ms': 15000, 'take_profit_ticks': 3.0,  'stop_loss_ticks': 6.0},
    {'name': 'hold60s_tp6_sl12', 'hold_ms': 60000, 'take_profit_ticks': 6.0,  'stop_loss_ticks': 12.0},
    {'name': 'hold30s_tp3_sl6',  'hold_ms': 30000, 'take_profit_ticks': 3.0,  'stop_loss_ticks': 6.0},
]

VOL_GATES = [
    {'name': 'allvol', 'low_vol_only': False},
    {'name': 'lowvol', 'low_vol_only': True},
]

def get_preds_files():
    """Find all OOT prediction npz files."""
    files = sorted(glob.glob(f'{BOOK_CACHE}/*_preds.npz'))
    print(f'Found {len(files)} prediction files in {BOOK_CACHE}')
    return files

def run_day_config(args):
    """Run fill_sim for one day × config combination."""
    preds_file, entry_cfg, exit_cfg, vol_gate = args

    date_str = os.path.basename(preds_file).replace('_preds.npz', '')
    config_id = f'{date_str}_{entry_cfg["name"]}_{exit_cfg["name"]}_{vol_gate["name"]}'
    outfile = f'{OUTPUT_DIR}/{config_id}.json'

    if os.path.exists(outfile):
        return ('skip', config_id)

    # Find matching MBO file
    mbo_pattern = f'{MBO_DIR}/glbx-mdp3-{date_str}.mbo.dbn.zst'
    if not os.path.exists(mbo_pattern):
        # Try alternate patterns
        alts = glob.glob(f'{MBO_DIR}/*{date_str}*.mbo.dbn.zst')
        if not alts:
            return ('skip_no_mbo', config_id)
        mbo_pattern = alts[0]

    # Build fill_sim call using iceberg_fillsim.py as base
    # We re-use the existing fill_sim infrastructure
    try:
        import numpy as np
        preds = np.load(preds_file, allow_pickle=True)
        available_keys = list(preds.files)
    except Exception as e:
        return ('error_preds', f'{config_id}: {e}')

    # Check for queue_fade and iceberg signals
    qf_key = None
    iceberg_key = None
    for k in available_keys:
        if 'queue' in k.lower() or 'qf' in k.lower():
            qf_key = k
        if 'iceberg' in k.lower() or 'ib' in k.lower():
            iceberg_key = k

    if qf_key is None:
        # Try generic signal key
        if 'signals' in available_keys:
            qf_key = 'signals'
        elif 'predictions' in available_keys:
            qf_key = 'predictions'
        else:
            return ('skip_no_qf', f'{config_id}: keys={available_keys[:5]}')

    result = {
        'config_id': config_id,
        'date': date_str,
        'entry': entry_cfg['name'],
        'exit': exit_cfg['name'],
        'vol_gate': vol_gate['name'],
        'preds_file': preds_file,
        'mbo_file': mbo_pattern,
        'qf_key': qf_key,
        'iceberg_key': iceberg_key,
        'available_keys': available_keys,
        'status': 'keys_found'
    }

    # Run the actual fill_sim
    # Use the existing iceberg_fillsim.py infrastructure
    fill_script = '/home/jupiter/Lvl3Quant/scripts/iceberg_fillsim.py'
    if not os.path.exists(fill_script):
        result['status'] = 'no_fill_script'
        with open(outfile, 'w') as f:
            json.dump(result, f)
        return ('error', f'{config_id}: no fill script')

    # Build config dict for fill_sim
    cfg = {
        'hold_ms': exit_cfg['hold_ms'],
        'take_profit_ticks': exit_cfg['take_profit_ticks'],
        'stop_loss_ticks': exit_cfg['stop_loss_ticks'],
        'market_entry': entry_cfg.get('market_entry', False),
        'chase_entry': entry_cfg.get('chase_entry', False),
        'chase_max_ticks': entry_cfg.get('chase_max_ticks', 2.0),
        'chase_max_reprices': entry_cfg.get('chase_max_reprices', 5),
        'chase_force_cross': entry_cfg.get('chase_force_cross', False),
        'commission_ticks': 0.376,
        'order_latency_ns': 10_000_000,
        'exit_latency_ns': 10_000_000,
        'eod_close': True,
        'market_exit_spread_cost': 0.5,
        'low_vol_only': vol_gate.get('low_vol_only', False),
    }

    # Write temp config
    tmp_cfg = f'/tmp/qf_combo_{config_id}.json'
    with open(tmp_cfg, 'w') as f:
        json.dump({
            'preds_file': preds_file,
            'mbo_file': mbo_pattern,
            'output_file': outfile,
            'qf_signal_key': qf_key,
            'config': cfg,
        }, f)

    # Run fill sim
    try:
        proc = subprocess.run(
            ['python3', fill_script, '--config', tmp_cfg],
            capture_output=True, text=True, timeout=120
        )
        if proc.returncode == 0:
            return ('ok', config_id)
        else:
            # Save error
            result['status'] = 'fill_sim_error'
            result['stderr'] = proc.stderr[-500:]
            with open(outfile, 'w') as f:
                json.dump(result, f)
            return ('error', f'{config_id}: {proc.stderr[-200:]}')
    except subprocess.TimeoutExpired:
        return ('timeout', config_id)
    except Exception as e:
        return ('exception', f'{config_id}: {e}')
    finally:
        try:
            os.unlink(tmp_cfg)
        except:
            pass


def main():
    print('='*70)
    print('QF+Iceberg Combo Fill Sim — Jupiter')
    print('='*70)

    preds_files = get_preds_files()
    if not preds_files:
        print('ERROR: No prediction files found. Check dl_book_cache_oot path.')
        # Fall back to standard cache
        alt = '/home/jupiter/Lvl3Quant/data/processed/dl_book_cache/'
        alt_files = sorted(glob.glob(f'{alt}*_preds.npz'))
        print(f'Alt cache {alt}: {len(alt_files)} files')
        if alt_files:
            preds_files = alt_files
        else:
            sys.exit(1)

    # Sample: show what keys are available
    if preds_files:
        import numpy as np
        sample = np.load(preds_files[0], allow_pickle=True)
        print(f'Sample npz keys: {list(sample.files)}')
        sample.close()

    # Build all work units
    work = []
    for pf in preds_files:
        for ec in ENTRY_CONFIGS:
            for xc in EXIT_CONFIGS:
                for vg in VOL_GATES:
                    work.append((pf, ec, xc, vg))

    print(f'\nTotal configs: {len(work)} ({len(preds_files)} days × {len(ENTRY_CONFIGS)} entry × {len(EXIT_CONFIGS)} exit × {len(VOL_GATES)} vol)')

    # Check already done
    done = len(glob.glob(f'{OUTPUT_DIR}/*.json'))
    print(f'Already completed: {done}')

    n_workers = min(multiprocessing.cpu_count(), 16)
    print(f'Workers: {n_workers}')
    print()

    results = {'ok': 0, 'skip': 0, 'error': 0}
    start = time.time()

    with ProcessPoolExecutor(max_workers=n_workers) as ex:
        futures = {ex.submit(run_day_config, w): w for w in work}
        for i, fut in enumerate(as_completed(futures)):
            status, msg = fut.result()
            results[status] = results.get(status, 0) + 1

            if i % 50 == 0 or status == 'error':
                elapsed = time.time() - start
                done_total = results['ok'] + results.get('skip', 0)
                rate = done_total / elapsed if elapsed > 0 else 0
                remaining = (len(work) - done_total) / rate if rate > 0 else 0
                print(f'[{i+1}/{len(work)}] {status}: {msg[:60]} | rate={rate:.1f}/s ETA={remaining/60:.0f}min')

    print(f'\nDone: {results}')
    print(f'Elapsed: {(time.time()-start)/60:.1f} min')

    # Quick aggregate
    out_files = glob.glob(f'{OUTPUT_DIR}/*.json')
    if out_files:
        print(f'\nQuick aggregate of {len(out_files)} results...')
        from collections import defaultdict
        cfgs = defaultdict(lambda: {'pnl':[], 'trades':[], 'wr':[], 'n':0})
        for f in out_files:
            try:
                d = json.load(open(f))
                key = f'{d.get("entry","?")}_{d.get("exit","?")}_{d.get("vol_gate","?")}'
                pnl = d.get('total_pnl_dollars', d.get('net_pnl_dollars', None))
                trades = d.get('total_trades', d.get('n_trades', None))
                wr = d.get('win_rate', None)
                if pnl is not None:
                    cfgs[key]['pnl'].append(pnl)
                if trades is not None:
                    cfgs[key]['trades'].append(trades)
                if wr is not None:
                    cfgs[key]['wr'].append(wr)
                cfgs[key]['n'] += 1
            except:
                pass

        import statistics
        ranked = []
        for k, v in cfgs.items():
            if not v['pnl']:
                continue
            avg = sum(v['pnl'])/len(v['pnl'])
            std = statistics.stdev(v['pnl']) if len(v['pnl']) > 1 else 1
            neg = [p for p in v['pnl'] if p < 0]
            ds = statistics.stdev(neg) if len(neg) > 1 else (std or 1)
            sortino = avg / (ds + 1e-9)
            ranked.append((k, sortino, avg, v['n'], sum(v['trades'])/len(v['trades']) if v['trades'] else 0))
        ranked.sort(key=lambda x: -x[1])
        print(f'\n{"Config":<50} {"Sortino":>8} {"AvgPnL":>9} {"Days":>5} {"Trades":>7}')
        for c, s, a, n, t in ranked[:10]:
            print(f'{c:<50} {s:>8.3f} ${a:>8.2f} {n:>5} {t:>7.1f}')


if __name__ == '__main__':
    main()
