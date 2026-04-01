Launch a training experiment on a specific node. Argument: $ARGUMENTS (format: "<node> <experiment_id_or_name>")

## Pre-launch Checklist (MANDATORY)
1. Check MLflow (`mlflow_search_runs`) — is this experiment already running or completed?
2. Check `data/research_queue_persistent.json` — is this in the queue?
3. Check target node GPU status (`qcc_node_status`) — is it idle?
4. Check if any other node is running the same experiment (`qcc_health_check`)
5. If ANY check fails → STOP and explain why

## Launch Process
1. Verify training script exists on target node (SSH check)
2. Verify data files exist on target node (`data/processed/mbo_events/*.npz`)
3. If data missing → sync from Neptune via SCP using Tailscale IPs
4. Create bat file with:
   - `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8`
   - `GIT_PYTHON_REFRESH=quiet`
   - All experiment env vars
   - `MLFLOW_TRACKING_URI=http://100.109.245.73:5000` (for remote nodes) or `http://localhost:5000` (Neptune)
   - Absolute Python path
   - Output redirect to log file
5. SCP bat file to node (if created locally)
6. Launch via `schtasks /create` + `schtasks /run`
7. Wait 30s, verify:
   - Python process running (`tasklist`)
   - MLflow run registered (`mlflow_search_runs`)
   - GPU utilization increasing
8. Update `research_queue_persistent.json` status to RUNNING
9. Report launch to `#system-status` Discord channel

## Node Details
| Node | Python Path | MLflow URI | Lvl3 Root |
|------|-------------|------------|-----------|
| Neptune | python (in PATH) | http://localhost:5000 | C:\Users\Footb\Documents\Github\Lvl3Quant |
| Uranus | C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe | http://100.109.245.73:5000 | C:\Users\nick\Lvl3Quant |
| Razer | python (in PATH) | http://100.109.245.73:5000 | C:\Users\claude\Lvl3Quant |
