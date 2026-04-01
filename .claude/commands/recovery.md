Crash/restart recovery procedure. Run this on every session start.

## Steps (in order)

1. **Read Discord history** — `read_channel` on #general (50 messages) and #system-status (10 messages)
   - Understand what was happening before crash
   - Check for any user instructions

2. **Check pending memories** — `check_pending` from memory MCP
   - Act on any URGENT items

3. **Health check** — `qcc_health_check` MCP tool
   - All node statuses
   - Active/stale jobs
   - Unresolved alerts
   - Paper engine status

4. **MLflow check** — `mlflow_search_runs` for all active experiments
   - Any runs still marked RUNNING but process dead? → mark FAILED
   - Any completed runs with results to report?

5. **GPU utilization check** — for each GPU node:
   - If IDLE → dispatch next experiment from research queue
   - If ACTIVE → verify what's training matches MLflow

6. **Report to Discord** via `send_to_discord`:
   - Session number
   - Cluster status (table format)
   - Any actions taken
   - What was interrupted and current plan

## Key Rules
- NEVER rerun experiments — check MLflow history first
- Use Tailscale IPs for remote node MLflow (100.109.245.73:5000)
- Each node = different experiment
- Monitor alerts = user messages — ACT on them
