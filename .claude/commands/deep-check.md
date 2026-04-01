Run a 15-minute deep check on all compute nodes and training jobs. This is the core monitoring loop.

## Steps

1. **Check all nodes** using `qcc_health_check` MCP tool
2. **Check MLflow** for all running experiments using `mlflow_search_runs` — check EACH running experiment
3. **For each GPU node** (Neptune, Uranus):
   - WHAT is training (model name, fold count, config)
   - GPU utilization and power draw
   - IC progress vs benchmarks (CNN1D baseline: concat IC_10s=0.132)
   - Kill underperformers after 2+ folds if IC is clearly below baseline
4. **Check for problems**:
   - Any GPU idle > 30 min? → dispatch next experiment from `data/research_queue_persistent.json`
   - Any duplicate experiments across nodes? → kill the duplicate
   - Any stalled training (no log output > 30 min)? → investigate and restart
   - Any MLflow runs still RUNNING but no Python process? → mark as FAILED
5. **Report to #system-status** channel via `send_to_channel`:
   - Node status table
   - Running experiments with IC progress
   - Actions taken
   - "ALL NODES PRODUCTIVE" or "EXECUTED: <action>"

## Key Rules
- Each node MUST run a DIFFERENT experiment
- Check `data/research_queue_persistent.json` and MLflow BEFORE dispatching anything
- Never rerun completed experiments (check completed_architectures in research queue)
- IC_10s is the comparison metric. Baseline = 0.132 (EventCNN1D)
- Neptune MLflow: http://localhost:5000, remote nodes use Tailscale IP 100.109.245.73:5000
