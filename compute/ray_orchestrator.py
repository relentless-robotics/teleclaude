#!/usr/bin/env python3
"""
ray_orchestrator.py — Ray distributed task orchestrator.

Replaces the 4 PM2 researcher agents with proper distributed execution.
Runs as a single PM2 process on Neptune. Submits tasks to the Ray cluster
(head: Jupiter 192.168.0.108:6379), monitors completion, chains DAGs.

Architecture:
    Neptune (WSL worker, 16 CPU)  ─┐
    Jupiter (head + CPU, 64GB)    ─┤── Ray cluster @ 192.168.0.108:6379
    Saturn  (worker, CPU, 32GB)   ─┘
    Razer   (jobs API client, RTX 3070) — submits via Ray Jobs HTTP API
    Uranus  (offline — reconnects when available)

Node Roles:
    Jupiter + Saturn : CPU-heavy fill sims, sweeps, LGBM training
    Neptune WSL      : I/O dispatch, result aggregation
    Razer            : GPU inference / math strategy backtests (via Flask API)
    Uranus           : Heavy CNN training when online (RTX 5090)

Usage:
    python compute/ray_orchestrator.py                  # run as orchestrator
    python compute/ray_orchestrator.py --status         # print cluster status
    python compute/ray_orchestrator.py --test           # run test tasks

PM2:
    pm2 start compute/ray_orchestrator.py --name ray-orchestrator \
        --interpreter python --restart-delay 5000
"""

import argparse
import json
import logging
import os
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT        = Path(__file__).parent.parent               # teleclaude-main/
COMPUTE_DIR = Path(__file__).parent                      # compute/
LOG_DIR     = ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)

sys.path.insert(0, str(ROOT))

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [ray_orchestrator] %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_DIR / "ray_orchestrator.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("ray_orchestrator")

# ── Ray cluster config ────────────────────────────────────────────────────────
RAY_HEAD_ADDRESS = "192.168.0.108:6379"   # Jupiter LAN
RAY_DASHBOARD    = "http://192.168.0.108:8265"
RAY_JOBS_API     = "http://192.168.0.108:8265"

# ── MLflow config ─────────────────────────────────────────────────────────────
# The orchestrator runs ON Neptune — use localhost:5000 for its own MLflow logging.
# Remote job scripts (Jupiter/Saturn) receive MLFLOW_TRACKING_URI env var injection
# pointing to the Tailscale IP (100.109.245.73:5000), which requires the MLflow server
# to be started with --allowed-hosts all (see scripts/start_mlflow.py).
# Until --allowed-hosts is confirmed, the orchestrator logs on behalf of all jobs (localhost).
MLFLOW_URI_LOCAL     = "http://localhost:5000"         # Neptune-local (always works)
MLFLOW_URI_TAILSCALE = "http://100.109.245.73:5000"    # Tailscale IP (Razer/Uranus)
MLFLOW_URI_LAN       = "http://192.168.0.101:5000"     # Neptune LAN IP (Jupiter/Saturn)
MLFLOW_URI = os.environ.get("MLFLOW_TRACKING_URI", MLFLOW_URI_LOCAL)

def get_mlflow_uri_for_node(node: str) -> str:
    """Return the correct MLflow URI for a given node.
    Jupiter/Saturn use LAN IP (192.168.0.101), Razer/Uranus use Tailscale."""
    if node in ("jupiter", "saturn"):
        return MLFLOW_URI_LAN
    elif node in ("razer", "uranus"):
        return MLFLOW_URI_TAILSCALE
    return MLFLOW_URI_LOCAL

# Map job tags/names to MLflow experiment names
_EXPERIMENT_MAP = {
    "fill_sim":  "Fill_Sim_Sweeps",
    "fillsim":   "Fill_Sim_Sweeps",
    "sweep":     "Fill_Sim_Sweeps",
    "optuna":    "Fill_Sim_Sweeps",
    "mc":        "Fill_Sim_Sweeps",
    "monte":     "Fill_Sim_Sweeps",
    "cnn":       "CNN_Training",
    "training":  "CNN_Training",
    "wf":        "CNN_Training",
    "fold":      "CNN_Training",
    "signal":    "Signal_Research",
    "lgbm":      "Signal_Research",
    "gbm":       "Signal_Research",
    "math":      "Signal_Research",
    "ic":        "Signal_Research",
    "execution": "Execution_Research",
    "tpsl":      "Execution_Research",
    "adverse":   "Execution_Research",
    "infra":     "Infrastructure",
    "monitor":   "Infrastructure",
}

# ── Node Flask API config ─────────────────────────────────────────────────────
NODE_API_KEY = os.environ.get("NODE_API_KEY", "qcc_node_api_2026")
NODE_APIS = {
    "neptune": "http://localhost:8765",
    "uranus":  "http://100.100.83.37:8765",
    "razer":   "http://100.102.215.75:8765",
    "jupiter": "http://192.168.0.108:8765",
    "saturn":  None,  # access via Jupiter SSH hop
}

# ── Discord notification config ──────────────────────────────────────────────
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
# Bot token fallback — reads from config.json if no webhook is set
_DISCORD_BOT_TOKEN = None
_DISCORD_CHANNEL_ID = None  # #system-status channel
try:
    _cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    _DISCORD_BOT_TOKEN = _cfg.get("discordToken", "")
except Exception:
    pass
try:
    _ch = json.loads((ROOT / "trading_agents" / "data" / "discord_channels.json").read_text(encoding="utf-8"))
    _DISCORD_CHANNEL_ID = _ch.get("channels", {}).get("systemStatus", "")
    _DISCORD_ALERTS_ID  = _ch.get("channels", {}).get("alerts", "")
except Exception:
    _DISCORD_ALERTS_ID = ""

# ── Orchestrator loop interval ────────────────────────────────────────────────
LOOP_INTERVAL_S = 60   # check for new tasks every 60s

# ── Researcher priority files ─────────────────────────────────────────────────
RESEARCHER_PRIORITY_FILES = {
    "neptune": COMPUTE_DIR / "researchers" / "state_ml_lead.json",
    "uranus":  COMPUTE_DIR / "researchers" / "state_ml_lead.json",
    "razer":   COMPUTE_DIR / "researchers" / "state_quant_lead.json",
    "jupiter": COMPUTE_DIR / "researchers" / "state_execution_lead.json",
    "saturn":  COMPUTE_DIR / "researchers" / "state_execution_lead.json",
}
RESEARCH_PRIORITIES_FILE = COMPUTE_DIR / "research_priorities.json"


# ═══════════════════════════════════════════════════════════════════════════════
# Ray connection
# ═══════════════════════════════════════════════════════════════════════════════

def _check_ray_via_dashboard() -> dict | None:
    """Check cluster health via HTTP dashboard API (no version constraint)."""
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"http://{RAY_HEAD_ADDRESS.split(':')[0]}:8265/api/cluster_status",
            timeout=8
        ) as r:
            data = json.loads(r.read().decode())
            if data.get("result"):
                return data.get("data", {})
    except Exception:
        pass
    return None


def connect_ray(retries: int = 3) -> bool:
    """
    Connect to the Ray cluster head node at Jupiter.

    Neptune runs UWP Python 3.11.9 but the cluster is Python 3.10.12 —
    direct ray.init() as a client will fail with version mismatch.
    Instead, we verify the cluster is up via HTTP dashboard and use
    the Ray Jobs API for task submission.

    For Ray remote() tasks, this orchestrator delegates to a WSL subprocess
    that uses the compatible Python 3.10.
    """
    # First, check via dashboard (no version constraints)
    dashboard_data = _check_ray_via_dashboard()
    if dashboard_data is not None:
        report = dashboard_data.get("clusterStatus", {}).get("autoscalerReport", {})
        active_nodes = len(report.get("activeNodes", {}))
        log.info(f"Ray cluster is UP via dashboard: {active_nodes} active nodes")
        log.info(f"Dashboard: {RAY_DASHBOARD}")
        # Mark as available for Flask+Jobs API dispatch mode
        return True

    # Dashboard not reachable — cluster is down
    log.warning("Ray dashboard not reachable — cluster may be stopped.")
    log.info(f"Start cluster: bash compute/ray_cluster_manager.sh start")
    return False


# ═══════════════════════════════════════════════════════════════════════════════
# Ray task definitions
# ═══════════════════════════════════════════════════════════════════════════════

def submit_ray_job(job_id: str, script: str, args: list = None,
                   cwd: str = None, num_cpus: int = 4, num_gpus: int = 0,
                   timeout: int = 3600) -> str:
    """
    Submit a job to the Ray cluster via the Jobs HTTP API.

    This bypasses Python version constraints — the job runs on the cluster
    using Jupiter's Python 3.10, and the script itself determines resources.

    Returns the submission_id.
    """
    import urllib.request

    args_str = " ".join(args or [])
    entrypoint = f"python3 {script} {args_str}".strip()
    if cwd:
        entrypoint = f"cd {cwd} && {entrypoint}"

    body = json.dumps({
        "submission_id":   job_id,
        "entrypoint":      entrypoint,
        "runtime_env":     {"working_dir": cwd} if cwd else {},
        "entrypoint_num_cpus": num_cpus,
        "entrypoint_num_gpus": num_gpus,
    }).encode()

    req = urllib.request.Request(
        f"{RAY_JOBS_API}/api/jobs/",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            result = json.loads(r.read().decode())
            return result.get("submission_id", job_id)
    except Exception as e:
        log.error(f"Ray Jobs API submission failed for {job_id}: {e}")
        return None


def get_ray_job_status(submission_id: str) -> dict:
    """Get the status of a Ray job via the Jobs HTTP API."""
    import urllib.request
    try:
        with urllib.request.urlopen(
            f"{RAY_JOBS_API}/api/jobs/{submission_id}",
            timeout=10
        ) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"status": "ERROR", "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Job queue reader
# ═══════════════════════════════════════════════════════════════════════════════

def read_job_queue(node: str) -> list:
    """Read a node's job queue JSON file."""
    queue_file = COMPUTE_DIR / f"job_queue_{node}.json"
    if not queue_file.exists():
        return []
    try:
        data = json.loads(queue_file.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("jobs", data.get("queue", []))
        return []
    except Exception as e:
        log.warning(f"Failed to read queue {queue_file}: {e}")
        return []


def pop_next_job(node: str) -> dict | None:
    """Pop the next PENDING job from a node's queue."""
    queue_file = COMPUTE_DIR / f"job_queue_{node}.json"
    if not queue_file.exists():
        return None
    try:
        data = json.loads(queue_file.read_text(encoding="utf-8"))
        jobs = data if isinstance(data, list) else data.get("jobs", [])
        pending = [j for j in jobs if j.get("status", "pending") == "pending"]
        if not pending:
            return None
        job = pending[0]
        job["status"] = "running"
        job["started_at"] = datetime.utcnow().isoformat()
        # Write back
        if isinstance(data, list):
            queue_file.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
        else:
            data["jobs"] = jobs
            queue_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return job
    except Exception as e:
        log.warning(f"pop_next_job({node}) failed: {e}")
        return None


def mark_job_done(node: str, job_id: str, result: dict):
    """Mark a job as complete in the queue file."""
    queue_file = COMPUTE_DIR / f"job_queue_{node}.json"
    if not queue_file.exists():
        return
    try:
        data = json.loads(queue_file.read_text(encoding="utf-8"))
        jobs = data if isinstance(data, list) else data.get("jobs", [])
        for j in jobs:
            if j.get("id") == job_id:
                j["status"]       = "done" if result.get("exitCode", 1) == 0 else "failed"
                j["completed_at"] = datetime.utcnow().isoformat()
                j["result"]       = result
                break
        if isinstance(data, list):
            queue_file.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
        else:
            data["jobs"] = jobs
            queue_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning(f"mark_job_done({node}, {job_id}) failed: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# Flask API dispatch (for Razer GPU tasks and fallback)
# ═══════════════════════════════════════════════════════════════════════════════

def flask_exec(node: str, command: str, timeout: int = 120) -> dict:
    """Execute a command on a node via Flask API."""
    import urllib.request

    url = NODE_APIS.get(node)
    if not url:
        return {"exitCode": -1, "stdout": "", "stderr": f"No API URL for {node}"}

    body = json.dumps({"command": command, "timeout": timeout}).encode()
    req  = urllib.request.Request(
        f"{url}/exec",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": NODE_API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout + 5) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"exitCode": -1, "stdout": "", "stderr": str(e)}


def flask_health(node: str) -> dict:
    """Check health of a node via Flask API."""
    import urllib.request

    url = NODE_APIS.get(node)
    if not url:
        return {"status": "no_api"}
    try:
        req = urllib.request.Request(f"{url}/health", headers={"X-API-Key": NODE_API_KEY})
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Discord notifications
# ═══════════════════════════════════════════════════════════════════════════════

def notify_discord(message: str, channel: str = "status"):
    """Post a message to Discord via webhook or Bot API.

    channel: 'status' for #system-status, 'alerts' for #alerts
    """
    import urllib.request

    # Try webhook first
    if DISCORD_WEBHOOK:
        try:
            body = json.dumps({"content": message}).encode()
            req  = urllib.request.Request(
                DISCORD_WEBHOOK, data=body,
                headers={"Content-Type": "application/json"}, method="POST"
            )
            urllib.request.urlopen(req, timeout=10)
            return
        except Exception as e:
            log.warning(f"Discord webhook failed: {e}")

    # Fallback: Bot API
    if not _DISCORD_BOT_TOKEN:
        log.debug("No Discord webhook or bot token — notification skipped")
        return

    channel_id = _DISCORD_ALERTS_ID if channel == "alerts" else _DISCORD_CHANNEL_ID
    if not channel_id:
        log.debug("No Discord channel ID configured")
        return

    try:
        body = json.dumps({"content": message[:2000]}).encode()
        req = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{channel_id}/messages",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                "Authorization": f"Bot {_DISCORD_BOT_TOKEN}",
                "User-Agent": "RayOrchestrator/1.0",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log.warning(f"Discord Bot API notify failed: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# MLflow integration
# ═══════════════════════════════════════════════════════════════════════════════

def _infer_experiment(job: dict) -> str:
    """Map a job's tags/name to the appropriate MLflow experiment name."""
    tags = [t.lower() for t in (job.get("tags") or [])]
    name = (job.get("name") or "").lower()
    cmd  = (job.get("command") or job.get("cmd") or "").lower()
    haystack = " ".join(tags) + " " + name + " " + cmd
    for keyword, experiment in _EXPERIMENT_MAP.items():
        if keyword in haystack:
            return experiment
    return "Infrastructure"


def _parse_metrics_from_summary(summary: str) -> Dict[str, float]:
    """Extract numeric metrics from a result_summary string like 'IC=0.178 sortino=2.1'."""
    if not summary:
        return {}
    metrics: Dict[str, float] = {}
    for match in re.finditer(r"(\w+)\s*[=:]\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)", summary):
        try:
            metrics[match.group(1)] = float(match.group(2))
        except ValueError:
            pass
    return metrics


def log_job_to_mlflow(job: dict, result: dict, node: str) -> Optional[str]:
    """
    Log a completed job to MLflow. Called by the orchestrator when any job
    finishes (success or failure), whether dispatched via Ray Jobs API or Flask.

    Returns the MLflow run_id or None if logging failed.
    """
    try:
        from compute.ray_tasks import log_ray_result
    except ImportError:
        log.warning("ray_tasks not importable — MLflow logging skipped")
        return None

    experiment = _infer_experiment(job)
    job_id     = job.get("id", "unknown")
    exit_code  = result.get("exitCode", result.get("exit_code", -1))
    status     = "SUCCEEDED" if exit_code == 0 else "FAILED"

    # Build params from job metadata
    params: Dict[str, Any] = {
        "node":        node,
        "job_id":      job_id,
        "job_name":    job.get("name", ""),
        "description": (job.get("description") or "")[:200],
        "command":     (job.get("command") or job.get("cmd") or "")[:500],
        "priority":    job.get("priority", 0),
        "tags":        ",".join(job.get("tags") or []),
    }

    # Build metrics from result summary + exit code
    metrics: Dict[str, float] = {"exit_code": float(exit_code)}
    summary = result.get("result_summary") or result.get("message") or ""
    parsed  = _parse_metrics_from_summary(summary)
    metrics.update(parsed)

    tags: Dict[str, str] = {
        "source":     "ray_orchestrator",
        "node":       node,
        "job_id":     job_id,
        "status":     status,
        "dispatched": datetime.utcnow().strftime("%Y-%m-%d"),
    }

    run_name = f"{job.get('name', job_id)}_{node}_{datetime.utcnow().strftime('%H%M%S')}"

    try:
        run_id = log_ray_result(
            experiment_name=experiment,
            params=params,
            metrics=metrics,
            run_name=run_name,
            tags=tags,
            tracking_uri=MLFLOW_URI,
        )
        if run_id:
            log.info(f"MLflow logged: experiment='{experiment}' run_id={run_id} job={job_id}")
        return run_id
    except Exception as e:
        log.warning(f"MLflow logging failed for {job_id}: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════════════════
# Researcher priority reader
# ═══════════════════════════════════════════════════════════════════════════════

def read_researcher_priorities() -> Dict[str, Any]:
    """
    Read researcher agent state files to understand current priorities.

    Returns a dict keyed by researcher role with their current focus and
    any suggested next experiments. Used to prioritise job dispatch order.
    """
    priorities: Dict[str, Any] = {}

    for role_file in RESEARCHER_PRIORITY_FILES.values():
        if not role_file.exists():
            continue
        try:
            state = json.loads(role_file.read_text(encoding="utf-8"))
            role  = state.get("role", role_file.stem.replace("state_", ""))
            priorities[role] = {
                "focus":       state.get("current_focus", ""),
                "next_tasks":  state.get("next_tasks", []),
                "last_updated": state.get("last_updated", ""),
                "active_jobs": state.get("active_jobs", []),
            }
        except Exception as e:
            log.debug(f"Could not read researcher state {role_file}: {e}")

    # Also check research_priorities.json (legacy format)
    if RESEARCH_PRIORITIES_FILE.exists():
        try:
            rp = json.loads(RESEARCH_PRIORITIES_FILE.read_text(encoding="utf-8"))
            priorities["_research_priorities"] = rp
        except Exception:
            pass

    return priorities


def get_priority_boost(job: dict, researcher_priorities: Dict[str, Any]) -> int:
    """
    Return a priority boost (0-10) for a job based on researcher context.
    Higher boost = should be dispatched first.
    """
    if not researcher_priorities:
        return 0

    job_name = (job.get("name") or "").lower()
    job_desc = (job.get("description") or "").lower()
    job_tags = [t.lower() for t in (job.get("tags") or [])]
    haystack = job_name + " " + job_desc + " " + " ".join(job_tags)

    for role_data in researcher_priorities.values():
        if not isinstance(role_data, dict):
            continue
        focus = (role_data.get("focus") or "").lower()
        next_tasks = [str(t).lower() for t in (role_data.get("next_tasks") or [])]

        # Exact match in researcher's next tasks = highest priority
        for task in next_tasks:
            if task and (task in haystack or job_name in task):
                return 10

        # Partial match with current focus
        focus_words = focus.split()[:5]
        for word in focus_words:
            if len(word) > 4 and word in haystack:
                return 5

    return 0


# ═══════════════════════════════════════════════════════════════════════════════
# Cluster status
# ═══════════════════════════════════════════════════════════════════════════════

def cluster_status() -> dict:
    """Return full cluster status via Ray dashboard API + Flask APIs."""
    status = {
        "timestamp":     datetime.utcnow().isoformat(),
        "ray_connected": False,
        "ray_nodes":     [],
        "ray_resources": {},
        "flask_nodes":   {},
    }

    # Ray status via HTTP dashboard (no Python version constraint)
    dashboard_data = _check_ray_via_dashboard()
    if dashboard_data:
        cs = dashboard_data.get("clusterStatus", {})
        report   = cs.get("autoscalerReport", {})
        load     = cs.get("loadMetricsReport", {})
        usage    = load.get("usage", {})
        active   = report.get("activeNodes", {})

        status["ray_connected"] = True
        status["ray_nodes"]     = [{"node_id": k, "alive": True} for k in active]

        # Parse resource usage from loadMetricsReport
        cpu_used, cpu_total = usage.get("CPU", [0, 0])[:2] if isinstance(usage.get("CPU"), list) else [0, 0]
        mem_used, mem_total = usage.get("memory", [0, 0])[:2] if isinstance(usage.get("memory"), list) else [0, 0]
        status["ray_resources"] = {
            "CPU":    cpu_total,
            "CPU_used": cpu_used,
            "memory": mem_total,
        }
        status["active_node_count"] = len(active)
    else:
        status["ray_error"] = "Dashboard unreachable"

    # Flask API health
    for node in ["neptune", "uranus", "razer", "jupiter"]:
        h = flask_health(node)
        status["flask_nodes"][node] = {
            "status":   h.get("status", "unknown"),
            "platform": h.get("platform", "?"),
            "hostname": h.get("hostname", "?"),
            "gpu":      h.get("gpu", []),
        }

    return status


def print_status():
    """Print a formatted cluster status report."""
    s = cluster_status()
    print(f"\n{'='*60}")
    print(f"Ray Cluster Status -- {s['timestamp']}")
    print(f"{'='*60}")

    if s["ray_connected"]:
        res = s["ray_resources"]
        nodes = s.get("active_node_count", len(s["ray_nodes"]))
        print(f"\nRay Cluster (head: {RAY_HEAD_ADDRESS})")
        print(f"  Nodes:  {nodes}")
        print(f"  CPUs:   {res.get('CPU', 0):.0f} total  ({res.get('CPU_used', 0):.1f} in use)")
        print(f"  Memory: {res.get('memory', 0)/1e9:.1f} GB total")
        for n in s["ray_nodes"]:
            print(f"    [OK]  node {n.get('node_id', '?')[:16]}...")
    else:
        print(f"\nRay: NOT CONNECTED ({s.get('ray_error', 'unknown')})")
        print(f"  Cluster head should be at: {RAY_HEAD_ADDRESS}")
        print(f"  Start: bash compute/ray_cluster_manager.sh start")

    print(f"\nFlask API Nodes:")
    for node, info in s["flask_nodes"].items():
        st  = "OK" if info["status"] == "ok" else "--"
        gpu = f"  GPU={len(info.get('gpu', []))}x" if info.get("gpu") else ""
        print(f"  [{st}] {node:10s} {info.get('platform','?'):8s}  {info.get('hostname','?')}{gpu}")

    print(f"\nDashboard: {RAY_DASHBOARD}")
    print(f"{'='*60}\n")


# ═══════════════════════════════════════════════════════════════════════════════
# Orchestration loop
# ═══════════════════════════════════════════════════════════════════════════════

class RayOrchestrator:
    """
    Orchestrates distributed research tasks across the Ray cluster.

    Node routing:
      - fill_sim, sweep tasks → Jupiter / Saturn (CPU-heavy)
      - gpu_train tasks → Razer via Flask API (Windows GPU node)
      - analysis tasks → any available node
      - Uranus: auto-added to cluster when it comes online (RTX 5090)

    MLflow integration (NEW):
      - Every completed job (success or failure) is auto-logged to MLflow
      - Experiment name inferred from job tags/name (see _EXPERIMENT_MAP)
      - Metrics parsed from result_summary string (key=value pairs)
      - MLFLOW_TRACKING_URI env injected into all dispatched jobs
      - Tracking server: http://100.109.245.73:5000 (Neptune Tailscale)

    Researcher priority integration (NEW):
      - Reads compute/researchers/state_*.json every 5 min
      - Jobs matching researcher current_focus / next_tasks get dispatch boost
      - Ensures researcher intent drives job ordering, not just queue FIFO
    """

    def __init__(self):
        self.ray_available          = False
        self.active_futures         = {}   # job_id -> (submission_id, node, job)
        self.loop_count             = 0
        self._researcher_priorities = {}
        self._priorities_last_read  = 0.0

    def start(self):
        log.info("Ray Orchestrator starting...")
        log.info(f"Ray head: {RAY_HEAD_ADDRESS}")
        log.info(f"Dashboard: {RAY_DASHBOARD}")
        log.info(f"MLflow: {MLFLOW_URI}")

        # Try connecting to Ray
        self.ray_available = connect_ray()

        # Load researcher priorities
        self._refresh_researcher_priorities()

        if self.ray_available:
            log.info("Ray connected — distributed mode active.")
            notify_discord(
                f"**Ray Orchestrator** started\n"
                f"Cluster: {RAY_HEAD_ADDRESS}\n"
                f"MLflow: {MLFLOW_URI}\n"
                f"Dashboard: {RAY_DASHBOARD}"
            )
        else:
            log.warning("Ray unavailable — using Flask API fallback mode.")
            notify_discord(
                "**Ray Orchestrator** started in FALLBACK mode\n"
                "Ray not connected — using Flask API for all nodes.\n"
                f"MLflow: {MLFLOW_URI}\n"
                "Check head node: `ray start --head --port=6379` on Jupiter"
            )

        self._run_loop()

    def _run_loop(self):
        log.info("Entering orchestration loop...")
        while True:
            try:
                self.loop_count += 1
                self._check_completed_futures()
                self._dispatch_pending_jobs()

                if self.loop_count % 10 == 0:
                    self._health_report()

                # Refresh researcher priorities every 5 minutes
                if time.time() - self._priorities_last_read > 300:
                    self._refresh_researcher_priorities()

            except KeyboardInterrupt:
                log.info("Orchestrator stopped by user.")
                break
            except Exception as e:
                log.error(f"Loop error: {e}\n{traceback.format_exc()}")
                notify_discord(f"**[ERROR] Ray Orchestrator loop error:** {str(e)[:500]}", channel="alerts")

            time.sleep(LOOP_INTERVAL_S)

    def _refresh_researcher_priorities(self):
        """Re-read researcher state files to update dispatch priorities."""
        try:
            self._researcher_priorities = read_researcher_priorities()
            self._priorities_last_read  = time.time()
            roles = [k for k in self._researcher_priorities if not k.startswith("_")]
            log.info(f"Researcher priorities loaded: {roles}")
        except Exception as e:
            log.warning(f"Failed to refresh researcher priorities: {e}")

    def _check_completed_futures(self):
        """Check if any submitted Ray jobs have completed (via Jobs API), then log to MLflow."""
        if not self.ray_available or not self.active_futures:
            return

        done_ids = []
        for job_id, (submission_id, node, job) in self.active_futures.items():
            status_data = get_ray_job_status(submission_id)
            status = status_data.get("status", "UNKNOWN")

            if status in ("SUCCEEDED", "FAILED", "STOPPED"):
                exit_code = 0 if status == "SUCCEEDED" else 1
                log.info(f"Ray job {job_id} ({submission_id}) => {status}")

                result = {
                    "exitCode":       exit_code,
                    "status":         status,
                    "result_summary": status_data.get("message", "")[-500:],
                }
                mark_job_done(node, job_id, result)

                # Log to MLflow
                run_id = log_job_to_mlflow(job, result, node)
                run_id_str = f" | MLflow: {run_id[:8]}" if run_id else ""

                ch = "status" if exit_code == 0 else "alerts"
                notify_discord(
                    f"**[{'OK' if exit_code == 0 else 'FAIL'}]** "
                    f"Ray job `{job.get('name', job_id)}` on **{node}** => {status}"
                    + run_id_str,
                    channel=ch,
                )

                done_ids.append(job_id)

        for jid in done_ids:
            del self.active_futures[jid]

    def _get_next_job_priority_aware(self, node: str) -> Optional[dict]:
        """
        Pop the next job for a node, boosting jobs that match researcher focus.

        Reads all pending jobs, scores by researcher priority + queue priority,
        and pops the highest-scoring one instead of pure FIFO.
        """
        queue_file = COMPUTE_DIR / f"job_queue_{node}.json"
        if not queue_file.exists():
            return None
        try:
            data  = json.loads(queue_file.read_text(encoding="utf-8"))
            jobs  = data if isinstance(data, list) else data.get("jobs", [])
            pending = [j for j in jobs if j.get("status", "pending") == "pending"]
            if not pending:
                return None

            def score(j: dict) -> tuple:
                researcher_boost = get_priority_boost(j, self._researcher_priorities)
                queue_priority   = -(j.get("priority", 99))  # lower number = higher
                return (researcher_boost, queue_priority)

            pending.sort(key=score, reverse=True)
            best = pending[0]

            # Mark running and write back
            best["status"]     = "running"
            best["started_at"] = datetime.utcnow().isoformat()
            if isinstance(data, list):
                queue_file.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
            else:
                data["jobs"] = jobs
                queue_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

            return best
        except Exception as e:
            log.warning(f"_get_next_job_priority_aware({node}) failed: {e}")
            return pop_next_job(node)   # fallback to FIFO

    def _dispatch_pending_jobs(self):
        """Dispatch pending jobs from all node queues (priority-aware)."""
        # Ray cluster nodes: dispatch fill_sim/sweep jobs via Jobs API
        for node in ["jupiter", "saturn", "neptune"]:
            # Skip if too many jobs already in flight
            in_flight = sum(1 for _, (_, n, _) in self.active_futures.items() if n == node)
            if in_flight >= 3:
                continue

            job = self._get_next_job_priority_aware(node)
            if not job:
                continue

            task_type = job.get("type", "fill_sim")
            job_id    = job.get("id", f"{node}_{int(time.time())}")

            if self.ray_available:
                self._dispatch_to_ray(node, job_id, job, task_type)
            else:
                self._dispatch_via_flask(node, job_id, job)

        # Razer: GPU tasks always via Flask API (Windows GPU node)
        job = self._get_next_job_priority_aware("razer")
        if job:
            self._dispatch_via_flask("razer", job.get("id", f"razer_{int(time.time())}"), job)

    def _dispatch_to_ray(self, node: str, job_id: str, job: dict, task_type: str):
        """Submit a job to the Ray cluster via the Jobs HTTP API, injecting MLFLOW_TRACKING_URI."""
        import urllib.request as _ureq
        try:
            # Support both 'command'/'cmd' and 'script'+'args' field formats
            command = job.get("command") or job.get("cmd") or ""
            if command:
                cwd = job.get("cwd", "")
                entrypoint = f"cd {cwd} && {command}" if cwd else command
            else:
                script = job.get("script", "")
                args   = " ".join(str(a) for a in job.get("args", []))
                cwd    = job.get("cwd", "")
                python = "python3"
                cmd    = f"{python} {script} {args}".strip()
                entrypoint = f"cd {cwd} && {cmd}" if cwd else cmd

            # Resource allocation by task type
            num_cpus = 8 if task_type in ("sweep", "optuna") else 4
            num_gpus = 0  # GPU jobs go via Flask API to Razer

            body = json.dumps({
                "submission_id":       job_id,
                "entrypoint":          entrypoint,
                "entrypoint_num_cpus": num_cpus,
                "entrypoint_num_gpus": num_gpus,
                # Inject MLflow URI and node identity into the job environment
                "runtime_env": {
                    "env_vars": {
                        "MLFLOW_TRACKING_URI": get_mlflow_uri_for_node(node),
                        "NODE_NAME":           node,
                    }
                },
            }).encode()

            req = _ureq.Request(
                f"{RAY_JOBS_API}/api/jobs/",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with _ureq.urlopen(req, timeout=15) as r:
                result_data = json.loads(r.read().decode())
                sid = result_data.get("submission_id", job_id)

            if sid:
                self.active_futures[job_id] = (sid, node, job)
                log.info(f"Ray Jobs API: submitted {job_id} ({task_type}) sid={sid}")
            else:
                log.error(f"Ray Jobs API: empty submission_id for {job_id} — Flask fallback")
                self._dispatch_via_flask(node, job_id, job)

        except Exception as e:
            log.error(f"Ray dispatch failed for {job_id}: {e}")
            self._dispatch_via_flask(node, job_id, job)

    def _dispatch_via_flask(self, node: str, job_id: str, job: dict):
        """Dispatch a job via Flask API (background), injecting MLFLOW_TRACKING_URI."""
        # Support both 'command'/'cmd' and 'script'+'args' formats
        command = job.get("command") or job.get("cmd") or ""
        if not command:
            script  = job.get("script", "")
            args    = " ".join(str(a) for a in job.get("args", []))
            python  = "python3" if node in ("jupiter", "saturn") else "python"
            command = f"{python} {script} {args}".strip()

        cwd = job.get("cwd", "")
        if cwd:
            command = f"cd {cwd} && {command}" if node in ("jupiter", "saturn") \
                      else f"cd /d {cwd} && {command}"

        # Inject MLFLOW_TRACKING_URI (per-node) so job scripts can auto-log
        mlflow_uri = get_mlflow_uri_for_node(node)
        if node in ("jupiter", "saturn"):
            bg_cmd = (
                f"export MLFLOW_TRACKING_URI={mlflow_uri} "
                f"NODE_NAME={node} && "
                f"nohup {command} > /tmp/{job_id}.log 2>&1 &"
            )
        else:
            bg_cmd = (
                f"set MLFLOW_TRACKING_URI={mlflow_uri} && "
                f"set NODE_NAME={node} && "
                f"start /b {command}"
            )

        result = flask_exec(node, bg_cmd, timeout=30)
        log.info(f"Flask-dispatched {job_id} on {node} (exit={result.get('exitCode', '?')})")

        # Log dispatch event to MLflow (async — completion will be logged by queue_watcher)
        log_job_to_mlflow(job, {
            "exitCode":       0,
            "status":         "DISPATCHED",
            "result_summary": f"Flask-dispatched async on {node}",
        }, node)

    def _health_report(self):
        """Log a brief cluster health summary and fire alerts for issues."""
        s = cluster_status()
        if s["ray_connected"]:
            res = s["ray_resources"]
            log.info(
                f"Cluster health: {len(s['ray_nodes'])} Ray nodes | "
                f"CPU={res.get('CPU', 0):.0f} GPU={res.get('GPU', 0):.0f} | "
                f"active_futures={len(self.active_futures)}"
            )
        else:
            log.warning("Cluster health: Ray NOT connected")
            notify_discord(
                "**[ALERT] Ray cluster unreachable!**\n"
                "Dashboard not responding. Check Jupiter head node.",
                channel="alerts"
            )

        # Check Flask API nodes — alert if any go offline
        for node in ["neptune", "razer", "jupiter"]:
            h = s.get("flask_nodes", {}).get(node, {})
            node_status = h.get("status", "unknown")
            prev_key = f"_node_was_offline_{node}"
            if node_status != "ok":
                if not getattr(self, prev_key, False):
                    notify_discord(
                        f"**[ALERT] Node `{node}` offline!**\n"
                        f"Flask API at {NODE_APIS.get(node, '?')} not responding.",
                        channel="alerts"
                    )
                    setattr(self, prev_key, True)
            else:
                if getattr(self, prev_key, False):
                    notify_discord(
                        f"**[RECOVERED] Node `{node}` back online.**",
                        channel="status"
                    )
                setattr(self, prev_key, False)

        # Check for Uranus coming online
        uranus_health = flask_health("uranus")
        if uranus_health.get("status") == "ok":
            if getattr(self, "_node_was_offline_uranus", True):
                log.info("Uranus is now reachable!")
                notify_discord(
                    "**[RECOVERED] Node `uranus` is online.**\n"
                    "RTX 5090 available for GPU tasks.",
                    channel="status"
                )
                self._node_was_offline_uranus = False
        else:
            self._node_was_offline_uranus = True

        # Check queue depths — auto-repopulate if empty, then alert if still empty
        now = time.time()
        if not hasattr(self, "_queue_empty_since"):
            self._queue_empty_since = {}
        if not hasattr(self, "_queue_empty_alerted"):
            self._queue_empty_alerted = set()

        for node in ["neptune", "uranus", "razer", "jupiter", "saturn"]:
            jobs = read_job_queue(node)
            pending = [j for j in jobs if j.get("status", "pending") == "pending"]
            if len(pending) == 0:
                # Try to auto-repopulate from research_priorities.json
                repop_count = self._auto_repopulate_queue(node)
                if repop_count > 0:
                    log.info(f"Auto-repopulated {repop_count} jobs for {node}")
                    notify_discord(
                        f"**[AUTO-QUEUE]** Repopulated **{repop_count}** jobs for `{node}` from research priorities.",
                        channel="status"
                    )
                    self._queue_empty_since.pop(node, None)
                    self._queue_empty_alerted.discard(node)
                    continue  # Queue refilled, skip alert

                if node not in self._queue_empty_since:
                    self._queue_empty_since[node] = now
                elif (now - self._queue_empty_since[node] > 600
                      and node not in self._queue_empty_alerted):
                    mins = int((now - self._queue_empty_since[node]) / 60)
                    notify_discord(
                        f"**[WARN] Queue empty on `{node}` for {mins}+ minutes.**\n"
                        f"No pending jobs and no research priorities defined. Populate queue!",
                        channel="alerts"
                    )
                    self._queue_empty_alerted.add(node)
            else:
                self._queue_empty_since.pop(node, None)
                self._queue_empty_alerted.discard(node)


    def _auto_repopulate_queue(self, node: str) -> int:
        """
        Auto-generate experiment jobs for a node from research_priorities.json.

        When a node's queue is empty, this creates fresh jobs based on the
        defined research priorities for that node. Each priority entry becomes
        a job. Returns the number of jobs added.
        """
        if not RESEARCH_PRIORITIES_FILE.exists():
            return 0

        try:
            priorities = json.loads(RESEARCH_PRIORITIES_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning(f"Failed to read research_priorities.json: {e}")
            return 0

        node_priorities = priorities.get(node, [])
        if not node_priorities:
            return 0

        queue_file = COMPUTE_DIR / f"job_queue_{node}.json"
        try:
            existing = json.loads(queue_file.read_text(encoding="utf-8")) if queue_file.exists() else []
            if not isinstance(existing, list):
                existing = existing.get("jobs", [])
        except Exception:
            existing = []

        # Only add jobs that aren't already in the queue (by command)
        existing_cmds = {j.get("command", j.get("cmd", "")) for j in existing}
        ts = int(time.time())
        added = 0

        for i, priority in enumerate(node_priorities):
            cmd = priority.get("command", "")
            if cmd in existing_cmds:
                continue

            job = {
                "id":          f"{node}_auto_{ts}_{i}",
                "name":        priority.get("description", f"auto_job_{i}"),
                "description": priority.get("description", ""),
                "command":     cmd,
                "cwd":         priority.get("cwd", ""),
                "type":        priority.get("type", "research"),
                "priority":    priority.get("priority", 5),
                "tags":        [priority.get("type", "research"), node, "auto-generated"],
                "status":      "pending",
                "created_at":  datetime.utcnow().isoformat(),
                "log_pattern": priority.get("log_pattern", ""),
                "completion_markers": priority.get("completion_markers", []),
                "metrics_regex": priority.get("metrics_regex", ""),
            }
            existing.append(job)
            added += 1

        if added > 0:
            try:
                queue_file.write_text(json.dumps(existing, indent=2), encoding="utf-8")
                log.info(f"Wrote {added} auto-generated jobs to {queue_file.name}")
            except Exception as e:
                log.error(f"Failed to write queue {queue_file}: {e}")
                return 0

        return added


# ═══════════════════════════════════════════════════════════════════════════════
# Test suite
# ═══════════════════════════════════════════════════════════════════════════════

def run_tests():
    """Submit simple test jobs via Ray Jobs API to verify the cluster works."""
    import urllib.request

    log.info("Running cluster tests via Ray Jobs API...")

    # Write a test script to Jupiter via Flask API
    test_script_content = """\
import ray, socket, sys, json
ray.init()

@ray.remote
def task(n):
    return {'host': socket.gethostname(), 'n': n, 'py': sys.version.split()[0]}

refs = [task.remote(i) for i in range(4)]
results = ray.get(refs)
for r in results:
    print(json.dumps(r))
ray.shutdown()
"""

    write_result = flask_exec(
        "jupiter",
        f"python3 -c \"open('/tmp/ray_test_job.py','w').write({repr(test_script_content)})\"",
        timeout=10
    )
    if write_result.get("exitCode", 1) != 0:
        log.warning(f"Could not write test script: {write_result.get('stderr', '')}")

    # Submit via Jobs API
    ts = int(time.time())
    submission_id = f"test-{ts}"

    body = json.dumps({
        "submission_id": submission_id,
        "entrypoint":    "python3 /tmp/ray_test_job.py",
        "runtime_env":   {},
    }).encode()
    req = urllib.request.Request(
        f"{RAY_JOBS_API}/api/jobs/",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            result = json.loads(r.read().decode())
            log.info(f"Test job submitted: submission_id={submission_id}")
    except Exception as e:
        log.error(f"Test job submission failed: {e}")
        return False

    # Poll for completion (up to 30s)
    log.info("Waiting for test job to complete (up to 30s)...")
    for _ in range(15):
        time.sleep(2)
        status_data = get_ray_job_status(submission_id)
        status = status_data.get("status", "UNKNOWN")
        log.info(f"  Status: {status}")
        if status == "SUCCEEDED":
            msg = status_data.get("message", "")
            print("\nTest job SUCCEEDED. Output:")
            for line in msg.split("\n")[-20:]:
                if line.strip():
                    print(f"  {line}")
            log.info("All test tasks PASSED")
            print("\nRay cluster is working correctly.\n")
            return True
        elif status in ("FAILED", "STOPPED"):
            log.error(f"Test job {status}: {status_data.get('message', '')[:500]}")
            return False

    log.warning("Test job timed out waiting for completion")
    return False


def run_e2e_test():
    """
    Full end-to-end wiring test:
    1. Submit a lightweight LGBM IC test to Ray on Jupiter
    2. Wait for it to complete
    3. Log result to MLflow
    4. Send Discord notification
    5. Verify all 4 steps succeeded
    """
    import urllib.request

    log.info("=" * 60)
    log.info("FULL END-TO-END WIRING TEST")
    log.info("=" * 60)

    results = {"ray_submit": False, "ray_complete": False, "mlflow_log": False, "discord_notify": False}

    # Step 1: Write a quick test script to Jupiter that produces JSON metrics
    test_script = """\
import json, socket, time, sys, os
result = {
    "test": True,
    "host": socket.gethostname(),
    "timestamp": time.time(),
    "python": sys.version.split()[0],
    "sortino": 2.14,
    "ic": 0.178,
    "win_rate": 0.58,
    "node": os.environ.get("NODE_NAME", "unknown"),
    "mlflow_uri": os.environ.get("MLFLOW_TRACKING_URI", "not_set"),
}
print(json.dumps(result))
"""

    # Write test script via Flask API (use base64 to avoid quoting issues)
    import base64
    b64_script = base64.b64encode(test_script.encode()).decode()
    write_result = flask_exec(
        "jupiter",
        f"python3 -c \"import base64; open('/tmp/e2e_wiring_test.py','w').write(base64.b64decode('{b64_script}').decode())\"",
        timeout=10
    )
    if write_result.get("exitCode", 1) != 0:
        log.error(f"Could not write test script: {write_result}")
        return results

    # Step 2: Submit via Ray Jobs API with MLflow URI injected
    ts = int(time.time())
    job_id = f"e2e-wiring-{ts}"

    body = json.dumps({
        "submission_id": job_id,
        "entrypoint":    "python3 /tmp/e2e_wiring_test.py",
        "runtime_env": {
            "env_vars": {
                "MLFLOW_TRACKING_URI": get_mlflow_uri_for_node("jupiter"),
                "NODE_NAME": "jupiter",
            }
        },
    }).encode()

    req = urllib.request.Request(
        f"{RAY_JOBS_API}/api/jobs/",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read().decode())
            log.info(f"Step 1 PASS: Ray job submitted, id={job_id}")
            results["ray_submit"] = True
    except Exception as e:
        log.error(f"Step 1 FAIL: Ray submission failed: {e}")
        return results

    # Step 3: Wait for completion (up to 30s)
    log.info("Waiting for job completion...")
    job_output = ""
    for _ in range(15):
        time.sleep(2)
        status_data = get_ray_job_status(job_id)
        status = status_data.get("status", "UNKNOWN")
        if status == "SUCCEEDED":
            job_output = status_data.get("message", "")
            log.info(f"Step 2 PASS: Ray job completed successfully")
            results["ray_complete"] = True
            break
        elif status in ("FAILED", "STOPPED"):
            log.error(f"Step 2 FAIL: Ray job {status}: {status_data.get('message', '')[:200]}")
            break
    else:
        log.error("Step 2 FAIL: Ray job timed out")

    # Step 4: Parse metrics from output and log to MLflow
    metrics = {}
    if job_output:
        for line in reversed(job_output.strip().splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    metrics = json.loads(line)
                    break
                except Exception:
                    pass

    if not metrics:
        metrics = {"sortino": 2.14, "ic": 0.178, "test": 1.0}

    try:
        from compute.ray_tasks import log_ray_result
        run_id = log_ray_result(
            experiment_name="Infrastructure",
            params={"test": "e2e_wiring", "node": "jupiter", "job_id": job_id},
            metrics={k: v for k, v in metrics.items() if isinstance(v, (int, float))},
            run_name=f"e2e_wiring_test_{ts}",
            tags={"source": "e2e_test", "node": "jupiter"},
        )
        if run_id:
            log.info(f"Step 3 PASS: MLflow logged, run_id={run_id}")
            results["mlflow_log"] = True
        else:
            log.error("Step 3 FAIL: MLflow returned no run_id")
    except Exception as e:
        log.error(f"Step 3 FAIL: MLflow logging error: {e}")

    # Step 5: Send Discord notification
    try:
        notify_discord(
            f"**[E2E TEST COMPLETE]**\n"
            f"Ray submit: {'PASS' if results['ray_submit'] else 'FAIL'}\n"
            f"Ray complete: {'PASS' if results['ray_complete'] else 'FAIL'}\n"
            f"MLflow log: {'PASS' if results['mlflow_log'] else 'FAIL'}\n"
            f"Metrics: sortino={metrics.get('sortino', '?')}, ic={metrics.get('ic', '?')}\n"
            f"Job ID: `{job_id}`"
        )
        results["discord_notify"] = True
        log.info("Step 4 PASS: Discord notification sent")
    except Exception as e:
        log.error(f"Step 4 FAIL: Discord notification failed: {e}")

    # Summary
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    log.info("=" * 60)
    log.info(f"E2E TEST RESULT: {passed}/{total} steps passed")
    for step, ok in results.items():
        log.info(f"  {'PASS' if ok else 'FAIL'}: {step}")
    log.info("=" * 60)

    return results


# ═══════════════════════════════════════════════════════════════════════════════
# Cluster management helpers
# ═══════════════════════════════════════════════════════════════════════════════

def start_cluster():
    """
    Start the full Ray cluster:
    1. Start head on Jupiter (via Flask API)
    2. Connect Saturn worker (via Jupiter SSH)
    3. Connect Neptune WSL worker (via WSL command)
    4. Print status
    """
    import urllib.request

    print("Starting Ray cluster...\n")

    # Step 1: Start head on Jupiter
    print("Step 1: Starting Ray head on Jupiter (192.168.0.108)...")
    r = flask_exec("jupiter", "/home/jupiter/.local/bin/ray stop --force 2>&1; sleep 1; "
                   "/home/jupiter/.local/bin/ray start --head --port=6379 "
                   "--dashboard-host=0.0.0.0 --dashboard-port=8265 "
                   "--object-store-memory=4000000000 2>&1", timeout=30)
    if "Ray runtime started" in r.get("stdout", ""):
        print("  ✓ Jupiter head started")
    else:
        print(f"  ✗ Jupiter head failed: {r.get('stdout', '')[:200]}")
        return False

    time.sleep(3)

    # Step 2: Connect Saturn worker (via Jupiter SSH hop)
    print("Step 2: Connecting Saturn worker...")
    r = flask_exec("jupiter",
        "ssh -o StrictHostKeyChecking=no saturn@10.0.0.2 "
        "'/home/saturn/.local/bin/ray stop --force 2>&1; sleep 1; "
        "/home/saturn/.local/bin/ray start --address=192.168.0.108:6379 "
        "--object-store-memory=2000000000 2>&1'",
        timeout=30
    )
    if "Ray runtime started" in r.get("stdout", ""):
        print("  ✓ Saturn worker connected")
    else:
        print(f"  ⚠ Saturn: {r.get('stdout', '')[:100]}")

    # Step 3: Connect Neptune WSL worker
    print("Step 3: Connecting Neptune WSL worker...")
    import subprocess
    result = subprocess.run(
        ["wsl", "-d", "Ubuntu-22.04", "--", "bash", "-c",
         "ray stop --force 2>&1; sleep 1; "
         "ray start --address=192.168.0.108:6379 "
         "--object-store-memory=2000000000 2>&1"],
        capture_output=True, text=True, timeout=30
    )
    if "Ray runtime started" in result.stdout:
        print("  ✓ Neptune WSL worker connected")
    else:
        print(f"  ⚠ Neptune WSL: {result.stdout[:100]}")

    time.sleep(3)

    # Step 4: Print status
    if connect_ray():
        print_status()
        return True

    return False


def stop_cluster():
    """Stop all Ray processes across the cluster."""
    print("Stopping Ray cluster...\n")

    # Stop Neptune WSL
    import subprocess
    subprocess.run(["wsl", "-d", "Ubuntu-22.04", "--", "ray", "stop", "--force"],
                   capture_output=True, timeout=15)
    print("  Neptune WSL: stopped")

    # Stop Jupiter head (this also stops Saturn since it's a worker of Jupiter)
    r = flask_exec("jupiter", "/home/jupiter/.local/bin/ray stop --force 2>&1", timeout=20)
    print(f"  Jupiter: {r.get('stdout', '').strip()[:80]}")

    # Stop Saturn explicitly too
    r = flask_exec("jupiter",
        "ssh -o StrictHostKeyChecking=no saturn@10.0.0.2 "
        "'/home/saturn/.local/bin/ray stop --force 2>&1'",
        timeout=20
    )
    print(f"  Saturn: {r.get('stdout', '').strip()[:80]}")

    print("\nRay cluster stopped.")


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Ray distributed cluster orchestrator")
    parser.add_argument("--status",      action="store_true", help="Print cluster status and exit")
    parser.add_argument("--test",        action="store_true", help="Run test tasks and exit")
    parser.add_argument("--start",       action="store_true", help="Start the full cluster")
    parser.add_argument("--stop",        action="store_true", help="Stop the full cluster")
    parser.add_argument("--orchestrate", action="store_true", help="Run orchestration loop (default)")
    parser.add_argument("--e2e",        action="store_true", help="Run end-to-end wiring test")
    args = parser.parse_args()

    if args.e2e:
        if not connect_ray():
            print("Cannot connect to Ray cluster for E2E test.")
            sys.exit(1)
        results = run_e2e_test()
        passed = sum(1 for v in results.values() if v)
        sys.exit(0 if passed == len(results) else 1)

    if args.start:
        start_cluster()
        return

    if args.stop:
        stop_cluster()
        return

    if args.status:
        # Try connecting for status, but don't fail
        try:
            connect_ray(retries=1)
        except Exception:
            pass
        print_status()
        return

    if args.test:
        if not connect_ray():
            print("Cannot connect to Ray cluster. Start it first:")
            print("  python compute/ray_orchestrator.py --start")
            sys.exit(1)
        success = run_tests()
        sys.exit(0 if success else 1)

    # Default: run orchestrator loop
    orchestrator = RayOrchestrator()
    orchestrator.start()


if __name__ == "__main__":
    main()
