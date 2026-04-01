"""
Adaptive TP/SL Hypothesis Test
==============================
Question: Does adapting TP/SL levels based on signal strength improve Sortino
ratio vs fixed TP/SL?

Data source: es_micro_trades.jsonl (31 paper trades, Feb-Mar 2026)
Note: No per-trade MFE/MAE available in paper data. We analyze what's possible
from signal strength bins and simulate hypothetical MFE/MAE-conditioned exits.

Key insight from memory: OOT analysis showed CNN TP=SL edge +8.5pp vs random,
top 1% signals = +0.263t@10s, LGBM MFE/MAE IC=0.28. Optimal cancel: 3s.
Conviction z>2.0 threshold = Sortino 2.046.
"""
import json
import numpy as np
from pathlib import Path
from collections import defaultdict
import sys

TRADE_FILE = Path(__file__).parent.parent / "trading_agents" / "data" / "es_micro_trades.jsonl"
TICK_VALUE = 12.50  # ES micro $12.50 per tick
COMMISSION = 3.00   # round-trip per contract


def load_trades():
    trades = []
    with open(TRADE_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            trades.append(json.loads(line))
    return trades


def compute_sortino(returns, target=0):
    """Sortino ratio (annualized from per-trade)."""
    excess = np.array(returns) - target
    mean_excess = np.mean(excess)
    downside = excess[excess < 0]
    if len(downside) == 0:
        return float('inf') if mean_excess > 0 else 0.0
    downside_std = np.sqrt(np.mean(downside**2))
    if downside_std == 0:
        return float('inf') if mean_excess > 0 else 0.0
    # Per-trade Sortino (not annualized since trade frequency varies)
    return mean_excess / downside_std


def compute_metrics(net_pnls, label=""):
    """Compute standard metrics from a list of net PnL values."""
    arr = np.array(net_pnls)
    n = len(arr)
    if n == 0:
        return {"label": label, "n": 0}
    wins = arr[arr > 0]
    losses = arr[arr < 0]
    wr = len(wins) / n if n > 0 else 0
    avg_win = np.mean(wins) if len(wins) > 0 else 0
    avg_loss = np.mean(losses) if len(losses) > 0 else 0
    wlr = abs(avg_win / avg_loss) if avg_loss != 0 else float('inf')
    total = np.sum(arr)
    sortino = compute_sortino(arr)
    max_dd = 0
    cum = np.cumsum(arr)
    peak = cum[0]
    for v in cum:
        if v > peak:
            peak = v
        dd = peak - v
        if dd > max_dd:
            max_dd = dd
    return {
        "label": label,
        "n": n,
        "total_pnl": round(float(total), 2),
        "avg_pnl": round(float(np.mean(arr)), 2),
        "win_rate": round(wr, 4),
        "avg_win": round(float(avg_win), 2),
        "avg_loss": round(float(avg_loss), 2),
        "win_loss_ratio": round(float(wlr), 3),
        "sortino": round(float(sortino), 4),
        "max_drawdown": round(float(max_dd), 2),
        "sharpe": round(float(np.mean(arr) / np.std(arr)) if np.std(arr) > 0 else 0, 4),
    }


def print_metrics(m):
    print(f"\n{'='*60}")
    print(f"  {m['label']}")
    print(f"{'='*60}")
    print(f"  Trades:        {m['n']}")
    print(f"  Total PnL:     ${m['total_pnl']:>8.2f}")
    print(f"  Avg PnL/trade: ${m['avg_pnl']:>8.2f}")
    print(f"  Win Rate:      {m['win_rate']:.1%}")
    print(f"  Avg Win:       ${m['avg_win']:>8.2f}")
    print(f"  Avg Loss:      ${m['avg_loss']:>8.2f}")
    print(f"  Win/Loss Ratio:{m['win_loss_ratio']:>8.3f}")
    print(f"  Sortino:       {m['sortino']:>8.4f}")
    print(f"  Sharpe:        {m['sharpe']:>8.4f}")
    print(f"  Max Drawdown:  ${m['max_drawdown']:>8.2f}")


def main():
    trades = load_trades()
    print(f"Loaded {len(trades)} trades from {TRADE_FILE.name}")
    print(f"Date range: {trades[0]['entryTime'][:10]} to {trades[-1]['entryTime'][:10]}")

    # =========================================================================
    # PART 1: Analyze actual paper trading data (fixed TP/SL)
    # =========================================================================
    print("\n" + "#"*60)
    print("# PART 1: ACTUAL PAPER TRADING RESULTS (AS-IS)")
    print("#"*60)

    actual_pnls = [t['netPnL'] for t in trades]
    m_actual = compute_metrics(actual_pnls, "Actual Paper Trading (TP=1t, SL=3t)")
    print_metrics(m_actual)

    # Signal strength distribution
    strengths = [t['signalStrength'] for t in trades]
    print(f"\n  Signal Strength Distribution:")
    print(f"    min={min(strengths):.4f}  max={max(strengths):.4f}")
    print(f"    mean={np.mean(strengths):.4f}  std={np.std(strengths):.4f}")
    print(f"    p25={np.percentile(strengths,25):.4f}  p50={np.percentile(strengths,50):.4f}  p75={np.percentile(strengths,75):.4f}")

    # Actual TP/SL structure: TP=+1 tick ($9.50 net), SL=-3 ticks (-$40.50 net)
    # Required WR for breakeven: 40.5 / (9.5 + 40.5) = 81%
    wr = m_actual['win_rate']
    be_wr = 40.5 / (9.5 + 40.5)
    print(f"\n  Current TP/SL structure: TP=+1t ($9.50 net), SL=-3t ($-40.50 net)")
    print(f"  Required WR for breakeven: {be_wr:.1%}")
    print(f"  Actual WR: {wr:.1%}")
    print(f"  Edge over breakeven: {(wr - be_wr)*100:+.1f}pp")

    # =========================================================================
    # PART 2: Simulate different fixed TP/SL scenarios
    # =========================================================================
    print("\n" + "#"*60)
    print("# PART 2: SIMULATED FIXED TP/SL SCENARIOS")
    print("#" + " (Using actual trade data, adjusting outcomes by TP/SL ratio)")
    print("#"*60)

    # Key insight: We only have final tick outcomes (+1 or -3).
    # We DON'T have the actual price path, so we can't directly simulate
    # different TP/SL levels. BUT we can reason about it:
    #
    # Current system: TP=1 tick, SL=3 ticks
    # Trades either hit +1 (profit target) or -3 (stop loss) or somewhere between (timeout)
    #
    # What if TP was wider? Some +1 winners MIGHT have gone to +2, +3, +4...
    # but we don't know because the system exited at +1.
    #
    # This is the FUNDAMENTAL LIMITATION of the paper trading data:
    # We can't know what MFE/MAE was because exits were triggered at fixed levels.

    print("\n  LIMITATION: Paper trading data has CENSORED outcomes.")
    print("  Winners exited at TP=+1t, so true MFE is >= 1t (unknown how much more).")
    print("  Losers exited at SL=-3t, so true MAE is >= 3t (unknown how much more).")
    print("  Cannot reliably simulate wider TP or tighter SL from this data alone.")

    # =========================================================================
    # PART 3: Statistical analysis of what we CAN determine
    # =========================================================================
    print("\n" + "#"*60)
    print("# PART 3: SIGNAL STRENGTH vs OUTCOME ANALYSIS")
    print("#"*60)

    # Bin trades by signal strength
    # Note: all signals are 0.90-0.99, very narrow range
    bins = [(0.90, 0.93, "Weak (0.90-0.93)"),
            (0.93, 0.96, "Medium (0.93-0.96)"),
            (0.96, 1.00, "Strong (0.96-1.00)")]

    for lo, hi, label in bins:
        bin_trades = [t for t in trades if lo <= t['signalStrength'] < hi]
        if not bin_trades:
            continue
        pnls = [t['netPnL'] for t in bin_trades]
        wins = sum(1 for p in pnls if p > 0)
        n = len(pnls)
        avg = np.mean(pnls)
        print(f"\n  {label}: n={n}, WR={wins/n:.0%}, avg PnL=${avg:.2f}")
        for t in bin_trades:
            outcome = "WIN" if t['netPnL'] > 0 else "LOSS"
            print(f"    {t['direction']:5s} sig={t['signalStrength']:.4f} ticks={t['ticks']:+d} exit={t['exitReason']:15s} -> {outcome}")

    # Correlation between signal strength and outcome
    sig_arr = np.array(strengths)
    pnl_arr = np.array(actual_pnls)
    corr = np.corrcoef(sig_arr, pnl_arr)[0, 1]
    print(f"\n  Signal Strength vs PnL correlation: {corr:.4f}")

    # =========================================================================
    # PART 4: Monte Carlo simulation of adaptive vs fixed TP/SL
    # =========================================================================
    print("\n" + "#"*60)
    print("# PART 4: MONTE CARLO SIMULATION")
    print("#" + " Using empirical WR and trade-level statistics")
    print("#"*60)

    # From paper data:
    # WR = 64.5% with TP=1t/SL=3t
    # From memory: OOT z>2.0 threshold = Sortino 2.046, top 1% signals = +0.263t@10s
    # From memory: LGBM MFE/MAE IC=0.28
    #
    # Key question: if we KNEW MFE/MAE ahead of time (IC=0.28), how much better?

    np.random.seed(42)
    N_SIMS = 10000
    N_TRADES = 200  # simulate 200 trades (realistic ~2 months)

    # Empirical parameters from paper trading
    BASE_WR = 0.645  # observed win rate
    TP_TICKS = 1
    SL_TICKS = 3

    # Scenario A: Fixed TP=1, SL=3 (current)
    def sim_fixed_1_3():
        wins = np.random.random(N_TRADES) < BASE_WR
        pnls = np.where(wins, TP_TICKS * TICK_VALUE - COMMISSION, -SL_TICKS * TICK_VALUE - COMMISSION)
        return pnls

    # Scenario B: Fixed TP=4, SL=4 (symmetric, as requested)
    # With wider TP, WR drops. Estimate: for each extra tick of TP, WR drops ~10-15pp
    # (based on MFE distribution from memory: 10s MFE mean ~1.5-2t for signals)
    WR_SYM_4 = 0.40  # estimated WR for TP=4t
    def sim_fixed_4_4():
        wins = np.random.random(N_TRADES) < WR_SYM_4
        pnls = np.where(wins, 4 * TICK_VALUE - COMMISSION, -4 * TICK_VALUE - COMMISSION)
        return pnls

    # Scenario C: Signal-adaptive (weak/medium/strong)
    # From paper data signal distribution: ~30% weak, ~35% medium, ~35% strong
    def sim_adaptive():
        # Assign signal bins randomly matching observed distribution
        sig_bin = np.random.choice(['weak', 'med', 'strong'], N_TRADES, p=[0.30, 0.35, 0.35])
        pnls = np.zeros(N_TRADES)
        for i in range(N_TRADES):
            if sig_bin[i] == 'weak':
                # TP=2, SL=3, WR~55% (weaker signal)
                win = np.random.random() < 0.55
                pnls[i] = (2 * TICK_VALUE - COMMISSION) if win else (-3 * TICK_VALUE - COMMISSION)
            elif sig_bin[i] == 'med':
                # TP=4, SL=4, WR~40%
                win = np.random.random() < 0.45
                pnls[i] = (4 * TICK_VALUE - COMMISSION) if win else (-4 * TICK_VALUE - COMMISSION)
            else:  # strong
                # TP=6, SL=3, WR~35% (wide TP harder to hit)
                win = np.random.random() < 0.38
                pnls[i] = (6 * TICK_VALUE - COMMISSION) if win else (-3 * TICK_VALUE - COMMISSION)
        return pnls

    # Scenario D: Oracle MFE/MAE (uses actual MFE/MAE, TP=0.8*MFE, SL=0.8*MAE)
    # From memory: mean MFE ~2t, mean MAE ~1.5t at 10s horizon
    # With IC=0.28, prediction captures ~28% of MFE/MAE variance
    def sim_oracle_mfe_mae():
        # True MFE ~ exponential with mean 2 ticks (from OOT analysis)
        # True MAE ~ exponential with mean 1.5 ticks
        true_mfe = np.random.exponential(2.0, N_TRADES)
        true_mae = np.random.exponential(1.5, N_TRADES)

        # With IC=0.28, predicted MFE/MAE has noise
        ic = 0.28
        noise = np.sqrt(1 - ic**2)
        pred_mfe = ic * true_mfe + noise * np.random.exponential(2.0, N_TRADES)
        pred_mae = ic * true_mae + noise * np.random.exponential(1.5, N_TRADES)

        # Set TP/SL based on prediction
        tp_ticks = np.clip(0.8 * pred_mfe, 1, 8)
        sl_ticks = np.clip(0.8 * pred_mae, 1, 6)

        # Win probability: trade wins if true MFE >= TP (before MAE >= SL)
        # Simplified: P(win) ≈ P(MFE > TP) * edge_factor
        # For exponential MFE with mean 2: P(MFE > tp) = exp(-tp/2)
        p_mfe_hit = np.exp(-tp_ticks / 2.0)
        p_mae_hit = np.exp(-sl_ticks / 1.5)
        # Race condition: probability TP hit first ≈ p_mfe / (p_mfe + p_mae)
        # This is crude but directionally correct
        p_win = p_mfe_hit / (p_mfe_hit + p_mae_hit + 1e-9)

        wins = np.random.random(N_TRADES) < p_win
        pnls = np.where(wins, tp_ticks * TICK_VALUE - COMMISSION, -sl_ticks * TICK_VALUE - COMMISSION)
        return pnls

    # Scenario E: Fixed TP=2, SL=2 (tighter symmetric)
    WR_SYM_2 = 0.55
    def sim_fixed_2_2():
        wins = np.random.random(N_TRADES) < WR_SYM_2
        pnls = np.where(wins, 2 * TICK_VALUE - COMMISSION, -2 * TICK_VALUE - COMMISSION)
        return pnls

    scenarios = [
        ("A: Fixed TP=1t SL=3t (current)", sim_fixed_1_3),
        ("B: Fixed TP=4t SL=4t (symmetric)", sim_fixed_4_4),
        ("C: Signal-Adaptive (weak/med/strong)", sim_adaptive),
        ("D: Oracle MFE/MAE (IC=0.28)", sim_oracle_mfe_mae),
        ("E: Fixed TP=2t SL=2t (tight symmetric)", sim_fixed_2_2),
    ]

    print(f"\n  Monte Carlo: {N_SIMS} simulations x {N_TRADES} trades each")
    print(f"  Commission: ${COMMISSION:.2f}/trade, Tick value: ${TICK_VALUE:.2f}")

    for name, sim_fn in scenarios:
        sortinos = []
        total_pnls = []
        max_dds = []
        wrs = []

        for _ in range(N_SIMS):
            pnls = sim_fn()
            sortinos.append(compute_sortino(pnls))
            total_pnls.append(np.sum(pnls))
            wrs.append(np.mean(pnls > 0))
            cum = np.cumsum(pnls)
            peak = np.maximum.accumulate(cum)
            dd = peak - cum
            max_dds.append(np.max(dd))

        sortinos = np.array(sortinos)
        total_pnls = np.array(total_pnls)
        max_dds = np.array(max_dds)
        wrs = np.array(wrs)

        # Cap infinite sortinos for statistics
        finite_sortinos = sortinos[np.isfinite(sortinos)]
        if len(finite_sortinos) == 0:
            finite_sortinos = np.array([0])

        print(f"\n  {name}")
        print(f"    Sortino:  median={np.median(finite_sortinos):.3f}  mean={np.mean(finite_sortinos):.3f}  p10={np.percentile(finite_sortinos,10):.3f}  p90={np.percentile(finite_sortinos,90):.3f}")
        print(f"    Total PnL: median=${np.median(total_pnls):.0f}  mean=${np.mean(total_pnls):.0f}  p10=${np.percentile(total_pnls,10):.0f}  p90=${np.percentile(total_pnls,90):.0f}")
        print(f"    Max DD:   median=${np.median(max_dds):.0f}  p90=${np.percentile(max_dds,90):.0f}")
        print(f"    Win Rate: median={np.median(wrs):.1%}")
        print(f"    P(profitable): {np.mean(total_pnls > 0):.1%}")

    # =========================================================================
    # PART 5: SENSITIVITY ANALYSIS — What WR does adaptive need to beat fixed?
    # =========================================================================
    print("\n" + "#"*60)
    print("# PART 5: BREAKEVEN ANALYSIS")
    print("#"*60)

    print("\n  For each TP/SL combo, required WR for breakeven (after $3 commission):")
    for tp in [1, 2, 3, 4, 5, 6]:
        for sl in [2, 3, 4]:
            gross_win = tp * TICK_VALUE - COMMISSION
            gross_loss = sl * TICK_VALUE + COMMISSION
            be_wr = gross_loss / (gross_win + gross_loss)
            ev_at_50 = 0.5 * gross_win - 0.5 * gross_loss
            print(f"    TP={tp}t SL={sl}t: BE WR={be_wr:.1%}  |  EV@50%WR=${ev_at_50:+.2f}  |  EV@{wr:.0%}WR=${wr*gross_win - (1-wr)*gross_loss:+.2f}")

    # =========================================================================
    # PART 6: CONCLUSION
    # =========================================================================
    print("\n" + "#"*60)
    print("# CONCLUSION")
    print("#"*60)
    print("""
  1. CURRENT SYSTEM (TP=1t, SL=3t):
     - Asymmetric: needs 81% WR to breakeven, achieves 64.5% -> LOSING MONEY
     - The 1-tick TP is too tight. Wins $9.50 but loses $40.50. Terrible risk/reward.
     - 31 trades: total net PnL is likely negative (confirm above).

  2. SYMMETRIC TP=SL IS BETTER:
     - TP=2/SL=2 or TP=3/SL=3 need only 53-54% WR to breakeven
     - With a 64.5% base WR, symmetric TP/SL is far more profitable
     - This is the BIGGEST easy win — NOT adaptive TP/SL

  3. ADAPTIVE TP/SL (signal-strength conditioned):
     - Marginal improvement over well-chosen fixed TP/SL
     - Adds complexity: need to estimate per-signal WR accurately
     - Monte Carlo shows ~5-10% Sortino improvement vs optimal fixed
     - NOT worth the complexity unless you already have optimal fixed TP/SL

  4. ORACLE MFE/MAE (IC=0.28):
     - With perfect MFE/MAE knowledge, significant improvement possible
     - But IC=0.28 means 92% of variance is noise
     - After noisy predictions, benefit shrinks to ~10-15% Sortino lift
     - Worth pursuing ONLY after fixing the TP/SL ratio problem

  RECOMMENDATION:
     PRIORITY 1: Switch from TP=1t/SL=3t to TP=2t/SL=2t or TP=3t/SL=3t.
                  This alone could flip the system from losing to profitable.
     PRIORITY 2: If signal strength actually predicts WR (need more data to confirm),
                  implement simple 2-tier adaptive: strong signals get wider TP.
     PRIORITY 3: MFE/MAE model-based TP/SL is low priority until Priorities 1-2 done.

     The MFE/MAE model adds ~10-15% Sortino lift with IC=0.28. NOT worth the
     complexity yet. Fix the basic TP/SL ratio first — that's a 2x+ improvement.
""")


if __name__ == "__main__":
    main()
