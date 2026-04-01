"""
Iceberg Early Limit Order Research
===================================
NEW IDEA (from owner): Place limit order 5 ticks BEFORE the iceberg level to get
earlier queue position. Iceberg bounces 84.6% of the time. If filled 5 ticks ahead:
  - Entry: iceberg_level - 5 ticks (long) or iceberg_level + 5 ticks (short)
  - SL: iceberg level breaks (price passes through iceberg level)
  - TP: bounce magnitude (configurable: 4-20 ticks)

Key advantage over standard iceberg entry:
  - Queue position improves dramatically (arriving BEFORE the crowd at iceberg level)
  - Natural SL at iceberg break = defined risk
  - Edge hypothesis: 84.6% bounce rate * (TP/(TP+SL)) > breakeven

This script runs on Razer CPU (GPU-accelerated LGBM can run in parallel).
Data: mbo_signals_iceberg.npz on Razer C:/Users/claude/

Configs to sweep:
  - ticks_ahead: [3, 5, 7, 10]  (how many ticks before iceberg level)
  - tp_ticks: [4, 6, 8, 12, 20]  (take profit)
  - sl_ticks: [3, 5, 8, 12]     (stop loss = iceberg breaking)
  - vol_filter: [none, low_only, very_low_only]
  - hold_max: [10s, 30s, 60s]   (max hold if neither TP nor SL hit)

Note: This is a pure signal analysis (no fill_sim). Fill_sim validation is the next step.
Output: C:/Users/claude/iceberg_early_limit_results.json
"""
import numpy as np
import json
import os
import time
from pathlib import Path
import sys

LOG_FILE = r'C:\Users\claude\iceberg_early_limit.log'
OUT_FILE = r'C:\Users\claude\iceberg_early_limit_results.json'
TICK_SIZE = 0.25  # ES = $12.50/tick

def log(msg):
    ts = time.strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')

def sortino(returns, target=0.0):
    """Compute Sortino ratio"""
    if len(returns) < 10:
        return 0.0
    excess = returns - target
    neg = excess[excess < 0]
    if len(neg) == 0 or np.std(neg) == 0:
        return 0.0
    return float(np.mean(excess) / np.std(neg) * np.sqrt(252))

def run_config(mid_prices, iceberg_times, iceberg_dirs, iceberg_strengths,
               ticks_ahead, tp_ticks, sl_ticks, hold_max_bars,
               vol_z=None, vol_filter='none', tick_size=TICK_SIZE):
    """
    Simulate early limit entry for a given config.

    For each iceberg signal at bar t with direction d:
    1. Entry target = iceberg_level +/- ticks_ahead ticks
    2. Fill simulation: scan bars t..t+hold_max_bars to find fill (price touches entry)
    3. If filled at bar f: track TP/SL until max hold
    4. TP = entry + tp_ticks (long) or entry - tp_ticks (short)
    5. SL = iceberg_level (the iceberg breaking = entry - (ticks_ahead + sl_addon) from entry)

    Returns: list of trade P&L in ticks
    """
    n = len(mid_prices)
    pnls = []
    filled = 0
    total_signals = 0

    for i, (t, d, strength) in enumerate(zip(iceberg_times, iceberg_dirs, iceberg_strengths)):
        if t + hold_max_bars >= n:
            continue

        # Apply vol filter
        if vol_filter != 'none' and vol_z is not None:
            vz = vol_z[t] if t < len(vol_z) else 0.0
            if vol_filter == 'low_only' and vz > 0.5:
                continue
            if vol_filter == 'very_low_only' and vz > -0.5:
                continue

        total_signals += 1
        iceberg_level = mid_prices[t]

        if d > 0:  # LONG: iceberg is support, we buy 5 ticks above it (closer to market)
            # Wait for price to dip to entry level (iceberg_level + ticks_ahead * tick_size)
            # Actually: iceberg is at a SUPPORT level. Price approaches from above.
            # Early entry = buy ticks_ahead ticks ABOVE the iceberg level
            # (we get filled before the crowd at the iceberg level itself)
            entry_target = iceberg_level + ticks_ahead * tick_size
            tp_price = entry_target + tp_ticks * tick_size
            sl_price = iceberg_level - sl_ticks * tick_size  # iceberg breaks
        else:  # SHORT: iceberg is resistance
            entry_target = iceberg_level - ticks_ahead * tick_size
            tp_price = entry_target - tp_ticks * tick_size
            sl_price = iceberg_level + sl_ticks * tick_size  # iceberg breaks

        # Simulate: scan forward to find fill + outcome
        fill_bar = None
        for b in range(t, min(t + hold_max_bars, n)):
            price = mid_prices[b]
            if d > 0 and price <= entry_target:
                fill_bar = b
                break
            elif d < 0 and price >= entry_target:
                fill_bar = b
                break

        if fill_bar is None:
            continue  # Never filled

        filled += 1
        # Now track TP/SL from fill_bar
        pnl = None
        for b in range(fill_bar, min(fill_bar + hold_max_bars, n)):
            price = mid_prices[b]
            if d > 0:
                if price >= tp_price:
                    pnl = tp_ticks
                    break
                elif price <= sl_price:
                    pnl = -(ticks_ahead + sl_ticks)
                    break
            else:
                if price <= tp_price:
                    pnl = tp_ticks
                    break
                elif price >= sl_price:
                    pnl = -(ticks_ahead + sl_ticks)
                    break

        if pnl is None:
            # Max hold exit
            exit_price = mid_prices[min(fill_bar + hold_max_bars - 1, n-1)]
            if d > 0:
                pnl = (exit_price - entry_target) / tick_size
            else:
                pnl = (entry_target - exit_price) / tick_size

        pnls.append(pnl)

    if len(pnls) < 5:
        return {'n': total_signals, 'filled': filled, 'trades': len(pnls), 'sortino': 0.0,
                'wr': 0.0, 'mean_pnl': 0.0, 'fill_rate': 0.0}

    pnl_arr = np.array(pnls)
    # Cost: 0.25 ticks RT (conservative)
    pnl_net = pnl_arr - 0.25

    return {
        'n': total_signals,
        'filled': filled,
        'trades': len(pnls),
        'fill_rate': round(len(pnls) / max(total_signals, 1), 3),
        'wr': round(float(np.mean(pnl_arr > 0)), 3),
        'mean_pnl': round(float(np.mean(pnl_arr)), 3),
        'mean_pnl_net': round(float(np.mean(pnl_net)), 3),
        'sortino': round(sortino(pnl_net), 3),
        'sortino_gross': round(sortino(pnl_arr), 3),
        'pnl_total_net': round(float(np.sum(pnl_net)), 1),
    }

def main():
    log('=== Iceberg Early Limit Order Research ===')
    log(f'Idea: buy/sell {[3,5,7,10]} ticks BEFORE iceberg level, SL=iceberg break, TP=bounce')

    DATA_DIR = Path(r'C:\Users\claude')

    # Load iceberg signals
    iceberg_path = DATA_DIR / 'mbo_signals_iceberg.npz'
    if not iceberg_path.exists():
        log(f'ERROR: {iceberg_path} not found')
        # Try all_signals
        iceberg_path = DATA_DIR / 'mbo_signals_all.npz'
        if not iceberg_path.exists():
            log('FATAL: No signal files found')
            return

    log(f'Loading {iceberg_path}...')
    d = np.load(str(iceberg_path), allow_pickle=True)
    keys = list(d.keys())
    log(f'Keys: {keys}')

    # Find mid price
    mid_prices = None
    for k in ['mid_price', 'price', 'mid', 'wmid']:
        if k in keys:
            mid_prices = d[k].astype(np.float64)
            log(f'Mid price from {k}: n={len(mid_prices)}, mean={np.nanmean(mid_prices):.2f}')
            break

    if mid_prices is None and 'bid' in keys and 'ask' in keys:
        mid_prices = (d['bid'].astype(np.float64) + d['ask'].astype(np.float64)) / 2.0
        log(f'Mid price from bid/ask: n={len(mid_prices)}')

    if mid_prices is None:
        log(f'FATAL: Cannot find mid prices. Keys: {keys}')
        return

    # Find iceberg signal column
    iceberg_sig = None
    iceberg_key = None
    for k in keys:
        if 'iceberg' in k.lower() or 'ice' in k.lower():
            iceberg_sig = d[k].astype(np.float64)
            iceberg_key = k
            log(f'Iceberg signal from {k}: nonzero={np.count_nonzero(iceberg_sig != 0)}')
            break

    if iceberg_sig is None:
        # Use first signal-like column
        for k in keys:
            arr = d[k]
            if hasattr(arr, 'dtype') and np.issubdtype(arr.dtype, np.number) and k not in ['mid_price','price','mid','wmid','bid','ask','bid_size','ask_size','timestamp','ts']:
                iceberg_sig = arr.astype(np.float64)
                iceberg_key = k
                log(f'Using {k} as iceberg proxy: nonzero={np.count_nonzero(iceberg_sig != 0)}')
                break

    if iceberg_sig is None:
        log('FATAL: Cannot find iceberg signal column')
        return

    # Find vol_z if available
    vol_z = None
    for k in ['vol_z', 'vol_zscore', 'volatility_z', 'vol_regime']:
        if k in keys:
            vol_z = d[k].astype(np.float64)
            log(f'Vol z-score from {k}')
            break

    # Extract signal events
    sig_mask = np.isfinite(iceberg_sig) & (iceberg_sig != 0)
    sig_times = np.where(sig_mask)[0]
    sig_dirs = np.sign(iceberg_sig[sig_mask])
    sig_strengths = np.abs(iceberg_sig[sig_mask])

    # If all same sign, split at median
    if np.all(sig_dirs > 0) or np.all(sig_dirs < 0):
        med = np.median(sig_strengths)
        sig_dirs = np.where(sig_strengths >= med, 1.0, -1.0)
        log(f'Signal is one-sided, splitting at strength median={med:.4f}')

    log(f'Total signals: {len(sig_times)}, long%={np.mean(sig_dirs>0):.1%}')

    # Config sweep
    configs = []
    for ticks_ahead in [3, 5, 7, 10]:
        for tp_ticks in [4, 6, 8, 12, 20]:
            for sl_ticks in [3, 5, 8]:
                for hold_max in [40, 120, 240]:  # bars (at 1s = 40s, 2min, 4min)
                    for vol_filter in ['none', 'low_only', 'very_low_only']:
                        configs.append((ticks_ahead, tp_ticks, sl_ticks, hold_max, vol_filter))

    log(f'Total configs: {len(configs)}')

    all_results = []
    t0 = time.time()
    for i, (ta, tp, sl, hold, vf) in enumerate(configs):
        if vol_z is None and vf != 'none':
            continue  # Skip vol filters if no vol data

        r = run_config(mid_prices, sig_times, sig_dirs, sig_strengths,
                      ticks_ahead=ta, tp_ticks=tp, sl_ticks=sl, hold_max_bars=hold,
                      vol_z=vol_z, vol_filter=vf)
        r.update({
            'ticks_ahead': ta,
            'tp_ticks': tp,
            'sl_ticks': sl,
            'hold_max': hold,
            'vol_filter': vf,
            'rr_ratio': round(tp / (ta + sl), 3),
        })
        all_results.append(r)

        if i % 50 == 0:
            elapsed = time.time() - t0
            top = sorted(all_results, key=lambda x: x['sortino'], reverse=True)[:3]
            log(f'  [{i}/{len(configs)}] {elapsed:.0f}s | Top Sortino: {[f"{x[\"sortino\"]:.3f}(ta={x[\"ticks_ahead\"]},tp={x[\"tp_ticks\"]},sl={x[\"sl_ticks\"]})" for x in top]}')

    # Sort and save
    all_results.sort(key=lambda x: x['sortino'], reverse=True)
    top20 = all_results[:20]

    log('\n=== TOP 20 CONFIGS ===')
    for r in top20[:10]:
        log(f'  ta={r["ticks_ahead"]}t tp={r["tp_ticks"]}t sl={r["sl_ticks"]}t hold={r["hold_max"]}s {r["vol_filter"]}: '
            f'Sortino={r["sortino"]:.3f} WR={r["wr"]:.1%} FillR={r["fill_rate"]:.1%} n={r["trades"]} pnl/t={r["mean_pnl_net"]:.3f}')

    output = {
        'strategy': 'Iceberg Early Limit Order',
        'description': 'Place limit order N ticks before iceberg level for queue priority. SL=iceberg break, TP=bounce.',
        'data_file': str(iceberg_path),
        'n_bars': len(mid_prices),
        'n_signals': int(len(sig_times)),
        'n_configs': len(all_results),
        'top20': top20,
        'all_results': all_results,
    }

    with open(OUT_FILE, 'w') as f:
        json.dump(output, f, indent=2)

    log(f'\nSaved to {OUT_FILE}')
    log(f'Total time: {time.time()-t0:.0f}s')
    log('DONE')

if __name__ == '__main__':
    main()
