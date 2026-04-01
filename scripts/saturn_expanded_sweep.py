#!/usr/bin/env python3
"""Saturn expanded sweep - chase+TP combos, trailing+TP combos on EMA norms.
Runs locally on Saturn. Output: cnn_wf_expanded_sweep_results/
Workers: 40
"""
import subprocess, glob, os, time, sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

BINARY = "/home/saturn/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli"
MBO_DIR = "/home/saturn/Lvl3Quant/data/raw/mbo"
PRED_DIR = "/home/saturn/Lvl3Quant/data/processed/cnn_wf_norm_sweep_predictions"
OUT_DIR = "/home/saturn/Lvl3Quant/data/processed/cnn_wf_expanded_sweep_results"
os.makedirs(OUT_DIR, exist_ok=True)

CHASE_TP_NORMS = ['ema_zscore_span5000']
CHASE_TP_VOLS = [70]

TRAIL_NORMS = ['ema_zscore_span5000', 'smooth10_expanding']
TRAIL_VOLS = [50, 70]

# Build date -> mbo mapping
mbo_map = {}
for f in glob.glob(os.path.join(MBO_DIR, "*.mbo.dbn.zst")):
    bn = os.path.basename(f)
    parts = bn.replace('.mbo.dbn.zst', '').split('-')
    if len(parts) >= 3:
        d = parts[-1]
        if len(d) == 8:
            date = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            mbo_map[date] = f

# Build pred file index
pred_index = {}
for f in glob.glob(os.path.join(PRED_DIR, "*.npz")):
    bn = os.path.basename(f).replace('.npz', '')
    parts = bn.split('_', 1)
    if len(parts) < 2:
        continue
    date = parts[0]
    rest = parts[1]
    vol_idx = rest.rfind('_vol')
    if vol_idx < 0:
        continue
    norm = rest[:vol_idx]
    vol_str = rest[vol_idx+4:]
    try:
        vol = int(vol_str)
    except:
        continue
    pred_index[(date, norm, vol)] = f

print(f"MBO dates: {len(mbo_map)}, Pred entries: {len(pred_index)}")

all_dates = sorted(mbo_map.keys())
print(f"Total MBO dates: {len(all_dates)}")

jobs = []

# ===== SWEEP 4: Chase 2t/3r + TP fine grid on ema_zscore_span5000_vol70 =====
for date in all_dates:
    mbo = mbo_map[date]
    for norm in CHASE_TP_NORMS:
        for vol in CHASE_TP_VOLS:
            key = (date, norm, vol)
            if key not in pred_index:
                continue
            pred = pred_index[key]
            tag = f"{norm}_vol{vol}"

            for conv in [2.0, 2.5]:
                for tp in [3, 4, 5, 6, 7, 8]:
                    # Chase 2t/3r + TP + 30min
                    label = f"{tag}_chase2t3r_tp{tp}_conv{int(conv*10)}_30m_{date}"
                    out = os.path.join(OUT_DIR, f"{label}.json")
                    if not os.path.exists(out):
                        jobs.append({
                            'mbo': mbo, 'pred': pred, 'out': out,
                            'conv': conv, 'hold_ms': 1800000,
                            'tp': tp, 'trail': None,
                            'chase_t': 2, 'chase_r': 3,
                            'sweep': 'chase_tp'
                        })

                    # Chase 2t/3r + TP + 60min
                    label2 = f"{tag}_chase2t3r_tp{tp}_conv{int(conv*10)}_60m_{date}"
                    out2 = os.path.join(OUT_DIR, f"{label2}.json")
                    if not os.path.exists(out2):
                        jobs.append({
                            'mbo': mbo, 'pred': pred, 'out': out2,
                            'conv': conv, 'hold_ms': 3600000,
                            'tp': tp, 'trail': None,
                            'chase_t': 2, 'chase_r': 3,
                            'sweep': 'chase_tp'
                        })

# ===== SWEEP 5: Trailing stop + TP combos on EMA normalizations =====
for date in all_dates:
    mbo = mbo_map[date]
    for norm in TRAIL_NORMS:
        for vol in TRAIL_VOLS:
            key = (date, norm, vol)
            if key not in pred_index:
                continue
            pred = pred_index[key]
            tag = f"{norm}_vol{vol}"

            for conv in [2.0, 2.5]:
                for trail in [10, 15, 20]:
                    for tp in [5, 8]:
                        # Trail + TP, 60min, passive
                        label = f"{tag}_trail{trail}_tp{tp}_conv{int(conv*10)}_60m_passive_{date}"
                        out = os.path.join(OUT_DIR, f"{label}.json")
                        if not os.path.exists(out):
                            jobs.append({
                                'mbo': mbo, 'pred': pred, 'out': out,
                                'conv': conv, 'hold_ms': 3600000,
                                'tp': tp, 'trail': trail,
                                'chase_t': 0, 'chase_r': 0,
                                'sweep': 'trail_tp'
                            })

                        # Trail + TP + chase 1t/3r, 60min
                        label2 = f"{tag}_trail{trail}_tp{tp}_conv{int(conv*10)}_60m_chase1t3r_{date}"
                        out2 = os.path.join(OUT_DIR, f"{label2}.json")
                        if not os.path.exists(out2):
                            jobs.append({
                                'mbo': mbo, 'pred': pred, 'out': out2,
                                'conv': conv, 'hold_ms': 3600000,
                                'tp': tp, 'trail': trail,
                                'chase_t': 1, 'chase_r': 3,
                                'sweep': 'trail_tp'
                            })

                    # Trail only (no TP), 60min passive - baseline
                    label3 = f"{tag}_trail{trail}_notp_conv{int(conv*10)}_60m_passive_{date}"
                    out3 = os.path.join(OUT_DIR, f"{label3}.json")
                    if not os.path.exists(out3):
                        jobs.append({
                            'mbo': mbo, 'pred': pred, 'out': out3,
                            'conv': conv, 'hold_ms': 3600000,
                            'tp': None, 'trail': trail,
                            'chase_t': 0, 'chase_r': 0,
                            'sweep': 'trail_tp'
                        })

print(f"\nTotal jobs: {len(jobs)}")
if len(jobs) == 0:
    print("All done!")
    sys.exit(0)

chase_tp_jobs = sum(1 for j in jobs if j['sweep'] == 'chase_tp')
trail_tp_jobs = sum(1 for j in jobs if j['sweep'] == 'trail_tp')
print(f"  Chase+TP (sweep 4): {chase_tp_jobs}")
print(f"  Trail+TP (sweep 5): {trail_tp_jobs}")
est = len(jobs) * 2.5 / 40 / 3600
print(f"  Est time: {est:.1f}h at 40 workers")

def run_job(job):
    cmd = [BINARY,
           "--mbo-file", job['mbo'],
           "--predictions", job['pred'],
           "--output", job['out'],
           "--hold-ms", str(job['hold_ms']),
           "--signal-threshold", str(job['conv']),
           "--latency-ms", "0",
           "--quiet"]
    if job['tp']:
        cmd += ["--take-profit-ticks", str(job['tp'])]
    if job['trail']:
        cmd += ["--trailing-ticks", str(job['trail'])]
    if job['chase_t'] > 0:
        cmd += ["--chase-entry",
                "--chase-max-ticks", str(job['chase_t']),
                "--chase-max-reprices", str(job['chase_r'])]
    try:
        subprocess.run(cmd, capture_output=True, timeout=180)
    except:
        pass

done = [0]
start = time.time()

def wrapped(job):
    run_job(job)
    done[0] += 1
    if done[0] % 500 == 0:
        elapsed = time.time() - start
        rate = done[0] / elapsed * 60 if elapsed > 0 else 0
        remain = (len(jobs) - done[0]) / (done[0] / elapsed) if done[0] > 0 else 0
        print(f"  Progress: {done[0]}/{len(jobs)} ({done[0]/len(jobs)*100:.1f}%) | {rate:.0f}/min | ETA: {remain/3600:.1f}h", flush=True)

with ThreadPoolExecutor(max_workers=40) as ex:
    list(ex.map(wrapped, jobs))

elapsed = time.time() - start
print(f"\nDone: {done[0]} jobs in {elapsed/3600:.1f}h")
print(f"Results in: {OUT_DIR}")
print(f"Total files: {len(glob.glob(os.path.join(OUT_DIR, '*.json')))}")
