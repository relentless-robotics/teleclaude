Evaluate a completed or in-progress MLflow training run. Argument: $ARGUMENTS (experiment name or run_id)

## Steps

1. **Get run data** from MLflow using `mlflow_search_runs` or `mlflow_get_best_run`
2. **Check metrics logged**:
   - `concat_ic_1s`, `concat_ic_5s`, `concat_ic_10s` — primary metrics
   - Per-fold ICs if available
   - Training loss progression
3. **Compare to baselines**:
   - EventCNN1D champion: concat IC_10s = 0.132
   - EventTransformer: concat IC_10s = 0.095
   - If IC_10s < 0.05 after 2+ folds → KILL (not worth GPU time)
   - If IC_10s > 0.10 → promising, let it finish
   - If IC_10s > 0.132 → potential new champion
4. **Check prediction files** on the node:
   - `.npz` files in output dir (one per fold)
   - `.pt` weight files (one per fold)
5. **Leakage audit**:
   - Verify expanding window (not sliding)
   - Check feature stats computed from train only
   - Verify no shared output directories
6. **Report to user** via `send_to_discord`:
   - Model name, node, fold count
   - IC results (1s, 5s, 10s) with comparison to baseline
   - Recommendation: continue / kill / promote
   - Leakage audit status: PASSED / PENDING / FAILED

## Key Metrics
- IC_10s is default comparison timeframe
- IC alone is misleading — also check regime robustness if available
- Sortino ratio is THE metric for exploitability
