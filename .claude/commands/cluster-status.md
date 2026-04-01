Quick cluster status check. Shows all nodes, running experiments, and GPU utilization.

## Steps
1. Run `qcc_health_check` MCP tool for full cluster state
2. Run `mlflow_search_runs` for each active experiment type:
   - EventDriven_Mamba
   - EventDriven_Hawkes
   - EventDriven_CNN1D
   - EventDriven_Transformer
   - CNN_Training (legacy)
3. Format a clean status table and send to user via `send_to_discord`:

```
**Cluster Status — <timestamp>**

| Node | GPU | Util | Power | RAM | Training | Fold | IC_10s |
|------|-----|------|-------|-----|----------|------|--------|

**MLflow Active Runs:** <count>
**Alerts:** <unresolved count>
```

4. Flag any issues:
   - Idle GPUs
   - Stale training (no progress > 30 min)
   - Duplicate experiments
   - Missing MLflow logging
