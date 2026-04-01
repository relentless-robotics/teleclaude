# MBO Exploitation Experiment Specs
> Written 2026-03-27 | Head of Quant decision: HIGH PRIORITY

## Data Available
- Raw MBO: `C:\Users\Footb\Documents\Github\Lvl3Quant\data\raw\rithmic_mbo\` (2026-03-17 onward)
- Databento MBO: `C:\Users\Footb\Documents\Github\Lvl3Quant\data\raw\mbo\` (July 2025 onward)
- Schema: `{ts, a (C/M/A/T), s (B/A), p, sz, pri (priority), oid (order_id), seq, t}`
- Node: Razer (CPU, math/gradient boosting only — NO deep learning)

---

## Experiment 1: Order Lifecycle Tracking
**Hypothesis:** Individual order behavior (add→modify→cancel vs add→fill) encodes informed vs
uninformed trading. Orders that get filled have different lifecycle patterns than cancelled orders.
Tracking order-level outcomes creates a proxy for "which orders are smart money."

**Features to engineer:**
- Per-order: time_in_queue (ts_cancel - ts_add, in nanoseconds)
- Per-order: n_modifications (count of M actions before C/T)
- Per-order: size_at_add vs size_at_fill (partial fills)
- Per-price: fill_rate = fills / (fills + cancels) over rolling 1000 orders
- Per-side: smart_money_ratio = n_filled_orders_under_500ms / total_filled_orders
- Level-0 fill_rate vs level-2+ fill_rate (near-touch vs far-from-touch)

**Method:**
1. Build order lifecycle dict: `{oid: {add_ts, add_px, add_sz, mods: [], outcome: C|T, fill_ts}}`
2. Compute per-bar features using orders ADDED in the past 5s window
3. IC test vs 10s mid-price return

**Expected outcome:** fill_rate near touch > IC 0.05 baseline. "Order persistence" (low cancel velocity)
may predict short-term direction: patient orders suggest informed limit orders waiting for fill.

**Script:** `scripts/mbo_order_lifecycle.py`
**Runtime:** ~2 hours on Razer CPU for 1 month of data

---

## Experiment 2: Cancel Velocity Patterns
**Hypothesis:** The SPEED at which limit orders cancel reveals intent. Mass cancellation bursts
(many orders cancelled in < 50ms) = HFT pulling liquidity before price move. Slow cancels =
natural order management. Cancel velocity is a leading indicator of short-term volatility and
direction.

**Features to engineer:**
- `cancel_burst_bid`: count of bid cancels in last 50ms / 200ms / 1000ms windows
- `cancel_burst_ask`: same for ask side
- `cancel_imbalance`: (cancel_burst_ask - cancel_burst_bid) / total
  → Positive = ask side being pulled → bullish signal (market makers seeing upward pressure)
- `cancel_size_weighted`: sum(sz_cancelled) not just count
- `cancel_velocity_zscore`: rolling z-score of cancel rate (normalizes for time of day)
- `cancel_vs_add_ratio`: cancels / (cancels + adds) over 500ms
  → Ratio > 0.7 = thinning book = potential large move incoming

**Method:**
1. Parse MBO stream, maintain 50ms / 200ms / 1000ms sliding cancel counts per side
2. Align to 100ms bar timestamps
3. LGBM IC test vs 10s return, with time-of-day features to avoid spurious signal

**Key leakage check:** cancel events must be strictly before the target bar start time.
No lookahead into any future MBO messages.

**Expected outcome:** cancel_imbalance IC > 0.08. cancel_burst signals should lead price by 0.5-2s.

**Script:** `scripts/mbo_cancel_velocity.py`
**Runtime:** ~1.5 hours on Razer CPU

---

## Experiment 3: Queue Dynamics Modeling (Predict Queue Drain Rate)
**Hypothesis:** The rate at which a price level's queue drains predicts both (a) probability of
a price level printing and (b) the direction of the next mid-price move. A rapidly-draining
best-bid queue means a sell order is being absorbed; a rapidly-filling best-bid queue means
buying pressure accumulating.

**Features to engineer:**
- `bid_l0_drain_rate`: (depth_at_l0_T-500ms - depth_at_l0_T) / 500ms (ticks of queue drained per ms)
- `ask_l0_drain_rate`: same for ask
- `queue_drain_imbalance`: bid_drain - ask_drain (positive = bid draining faster = bearish)
- `bid_refill_rate`: (depth_at_l0_T - depth_at_l0_T-500ms) when positive (accumulation signal)
- `consecutive_drain_bars`: how many consecutive bars bid/ask L0 has been draining
- `queue_depth_half_life`: rolling estimate of how long it takes L0 depth to halve
- `cross_level_flow`: does L1 depth increase when L0 drains? (queue migration = true depletion vs
  order modification at L0)
- `time_to_queue_exhaustion`: estimated bars until L0 depth reaches 0 at current drain rate

**Method:**
1. Compute tick-by-tick L0 queue depth from MBO stream (running sum: add +sz, cancel/fill -sz)
2. Engineer drain rate features at 100ms bar boundaries
3. LGBM IC test; also test as TP/SL trigger input to fill sim
4. Key question: does drain_rate > X ticks/ms predict fill within 2s? Use as entry signal.

**Expected outcome:** queue drain events at L0 that complete (level prints) should have IC > 0.15
for 1-2s forward returns. This is a high-frequency edge that book snapshots miss (they see depth,
not the dynamics).

**Script:** `scripts/mbo_queue_dynamics.py`
**Runtime:** ~3 hours on Razer CPU (more complex state tracking)

---

## Implementation Notes for Razer

### Data loading pattern (Databento vs Rithmic)
```python
# Databento: use databento-python or manual dbn parsing
# Rithmic: JSONL format, stream-parse with ijson for memory efficiency

import json
from pathlib import Path

def stream_mbo(date: str, data_dir: Path):
    """Yield MBO events for a given date, Rithmic format."""
    fpath = data_dir / f"{date}_rithmic.jsonl"
    with open(fpath) as f:
        for line in f:
            yield json.loads(line)

# Event actions:
# a == 'A' → Add new order
# a == 'M' → Modify existing order
# a == 'C' → Cancel order
# a == 'T' → Trade/fill
# s == 'B' → Bid side, s == 'A' → Ask side
```

### Order lifecycle tracking pattern
```python
order_book = {}  # oid → {add_ts, add_px, add_sz, side, mods: [], outcome: None}

for event in stream_mbo(date, data_dir):
    oid = event['oid']
    if event['a'] == 'A':
        order_book[oid] = {'add_ts': event['ts'], 'px': event['p'],
                           'sz': event['sz'], 'side': event['s'], 'mods': []}
    elif event['a'] == 'M' and oid in order_book:
        order_book[oid]['mods'].append({'ts': event['ts'], 'sz': event['sz'], 'px': event['p']})
    elif event['a'] == 'C' and oid in order_book:
        order_book[oid]['outcome'] = 'cancel'
        order_book[oid]['cancel_ts'] = event['ts']
        # Compute features, then remove from dict to save memory
    elif event['a'] == 'T' and oid in order_book:
        order_book[oid]['outcome'] = 'fill'
        order_book[oid]['fill_ts'] = event['ts']
```

### Leakage prevention
- All features must be computed from events with `ts < bar_start_ts`
- Cancel velocity windows: [T-1000ms, T), [T-200ms, T), [T-50ms, T)
- Never use the same bar's MBO events to compute features for that bar's label

---

## Priority Order for Razer
1. **Cancel velocity** (fastest to implement, most likely to find signal) — start first
2. **Queue drain rate** (requires more state, but highest theoretical IC) — start second
3. **Order lifecycle** (requires full lifecycle aggregation, 2-3 day run) — start third

## Success Criteria
- IC > 0.05 on held-out OOT data (same standard as book CNN baseline)
- Sortino > 1.5 after fill sim on Jupiter (same standard as other strategies)
- Leakage audit: PASSED before any results reported

## Next Steps After IC Validation
1. If cancel_velocity IC > 0.08: add to LGBM feature stack alongside CNN z-score
2. If queue_drain IC > 0.10: design fill sim entry trigger (enter when drain_rate > 2σ)
3. If order_lifecycle shows smart_money_ratio IC: use as position sizing multiplier
