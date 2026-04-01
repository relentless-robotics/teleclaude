#!/usr/bin/env python3
"""
QCC Research Agent — runs permanently on a compute node (Razer, Jupiter, Saturn).

Polls the QCC orchestrator API for queued experiments, claims them, executes them
locally via subprocess, and reports results back.  No SSH dispatch needed.

Usage:
    python research_agent.py --node razer --qcc-host 100.109.245.73 --qcc-port 3457
    python research_agent.py --node razer --qcc-host 100.109.245.73 --qcc-port 3457 \
        --scripts-dir C:\\Users\\claude\\Lvl3Quant\\scripts

Configuration via env vars (override CLI):
    AGENT_NODE, QCC_HOST, QCC_PORT, SCRIPTS_DIR, POLL_INTERVAL, LOG_DIR
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Config defaults
# ---------------------------------------------------------------------------
DEFAULT_POLL_INTERVAL = 30      # seconds between polls when idle
DEFAULT_QCC_HOST      = "100.109.245.73"
DEFAULT_QCC_PORT      = 3457
HEARTBEAT_INTERVAL    = 30      # seconds between heartbeats while running
LOG_TAIL_LINES        = 50      # lines of stderr to send on failure
REQUEST_TIMEOUT       = 15      # HTTP request timeout (seconds)
RESULT_FILENAME       = "result.json"  # expected result file name from scripts

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="QCC Research Agent")
    p.add_argument("--node",        default=os.environ.get("AGENT_NODE", ""),
                   help="Node name (razer | jupiter | saturn)")
    p.add_argument("--qcc-host",    default=os.environ.get("QCC_HOST", DEFAULT_QCC_HOST))
    p.add_argument("--qcc-port",    type=int,
                   default=int(os.environ.get("QCC_PORT", DEFAULT_QCC_PORT)))
    p.add_argument("--scripts-dir", default=os.environ.get("SCRIPTS_DIR", ""),
                   help="Base directory for experiment scripts on this node")
    p.add_argument("--poll-interval", type=int,
                   default=int(os.environ.get("POLL_INTERVAL", DEFAULT_POLL_INTERVAL)))
    p.add_argument("--log-dir",     default=os.environ.get("LOG_DIR", ""),
                   help="Directory for agent + experiment logs (default: ./logs/)")
    return p.parse_args()

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

def setup_logging(log_dir: Path, node: str) -> logging.Logger:
    log_dir.mkdir(parents=True, exist_ok=True)
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    log_file = log_dir / f"research_agent_{node}_{date_str}.log"

    fmt = logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s",
                             datefmt="%Y-%m-%dT%H:%M:%S")
    logger = logging.getLogger("research_agent")
    logger.setLevel(logging.DEBUG)

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setLevel(logging.INFO)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger

# ---------------------------------------------------------------------------
# HTTP helpers (stdlib only)
# ---------------------------------------------------------------------------

def _http(method: str, url: str, body=None, logger=None) -> dict:
    """Make an HTTP request.  Returns parsed JSON or raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason}: {raw[:300]}")

def api_get(host, port, path, logger=None):
    return _http("GET", f"http://{host}:{port}{path}", logger=logger)

def api_post(host, port, path, body=None, logger=None):
    return _http("POST", f"http://{host}:{port}{path}", body=body, logger=logger)

# ---------------------------------------------------------------------------
# Heartbeat file (so QCC daemon can detect a dead agent even without HTTP)
# ---------------------------------------------------------------------------

def write_heartbeat(heartbeat_path: Path, node: str, experiment_id=None):
    data = {
        "node":          node,
        "pid":           os.getpid(),
        "ts":            datetime.utcnow().isoformat() + "Z",
        "experiment_id": experiment_id,
    }
    tmp = heartbeat_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(heartbeat_path)

# ---------------------------------------------------------------------------
# Tail helpers
# ---------------------------------------------------------------------------

def tail_file(path: Path, n: int) -> str:
    """Return last n lines of a file."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-n:])
    except Exception:
        return ""

def tail_bytes(text: str, n: int) -> str:
    lines = text.splitlines()
    return "\n".join(lines[-n:])

# ---------------------------------------------------------------------------
# Result harvesting
# ---------------------------------------------------------------------------

def harvest_result(scripts_dir: Path, script_path: str, log_dir: Path, exp_id: int) -> dict | None:
    """Try to find result.json near the script or in the log dir."""
    candidates = []

    # 1. Same directory as the script
    if script_path:
        sp = Path(script_path)
        if not sp.is_absolute() and scripts_dir:
            sp = scripts_dir / sp
        candidates.append(sp.parent / RESULT_FILENAME)

    # 2. Log dir with experiment id
    candidates.append(log_dir / f"result_{exp_id}.json")

    for c in candidates:
        if c.exists():
            try:
                return json.loads(c.read_text(encoding="utf-8"))
            except Exception:
                pass
    return None

# ---------------------------------------------------------------------------
# Core experiment execution
# ---------------------------------------------------------------------------

def run_experiment(exp: dict, scripts_dir: Path, log_dir: Path,
                   qcc_host: str, qcc_port: int, node: str,
                   heartbeat_path: Path, logger: logging.Logger) -> tuple[bool, str, dict | None]:
    """
    Execute one experiment subprocess.

    Returns (success, error_message, result_dict).
    Sends heartbeats to orchestrator every HEARTBEAT_INTERVAL seconds.
    """
    exp_id     = exp["experiment_id"]
    name       = exp.get("name", f"exp-{exp_id}")
    script_rel = exp.get("script_path", "")
    config     = {}
    try:
        config = json.loads(exp.get("config_json") or "{}")
    except Exception:
        pass

    # Resolve script path
    script_path = Path(script_rel)
    if not script_path.is_absolute() and scripts_dir:
        script_path = scripts_dir / script_rel
    script_path = script_path.resolve()

    if not script_path.exists():
        return False, f"Script not found: {script_path}", None

    # Build command
    cmd = [sys.executable, str(script_path)]
    # Pass config items as --key value CLI args if they are simple scalars
    for k, v in config.items():
        if isinstance(v, (str, int, float, bool)):
            cmd += [f"--{k.replace('_', '-')}", str(v)]

    # Log file for this experiment
    log_file = log_dir / f"exp_{exp_id}_{name[:40].replace(' ', '_')}.log"

    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}

    logger.info(f"[#{exp_id}] Launching: {' '.join(cmd)}")
    logger.info(f"[#{exp_id}] Log: {log_file}")

    write_heartbeat(heartbeat_path, node, exp_id)

    try:
        with open(log_file, "w", encoding="utf-8", errors="replace") as lf:
            proc = subprocess.Popen(
                cmd,
                stdout=lf,
                stderr=subprocess.STDOUT,
                env=env,
                cwd=str(script_path.parent),
            )

        last_heartbeat = time.monotonic()

        while True:
            ret = proc.poll()
            if ret is not None:
                break

            now = time.monotonic()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                try:
                    api_post(qcc_host, qcc_port,
                             f"/api/research/queue/{exp_id}/heartbeat",
                             {"node": node, "pid": proc.pid}, logger=logger)
                except Exception as he:
                    logger.warning(f"[#{exp_id}] Heartbeat failed: {he}")
                write_heartbeat(heartbeat_path, node, exp_id)
                last_heartbeat = now

            time.sleep(5)

        if ret == 0:
            logger.info(f"[#{exp_id}] Process exited 0 — SUCCESS")
            result = harvest_result(scripts_dir, script_rel, log_dir, exp_id)
            return True, "", result
        else:
            stderr_tail = tail_file(log_file, LOG_TAIL_LINES)
            err = f"Process exited {ret}"
            logger.error(f"[#{exp_id}] {err}")
            return False, err, None

    except Exception as e:
        return False, f"Subprocess error: {e}", None

# ---------------------------------------------------------------------------
# Main agent loop
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    node = args.node.strip()
    if not node:
        print("ERROR: --node is required", file=sys.stderr)
        sys.exit(1)

    qcc_host   = args.qcc_host
    qcc_port   = args.qcc_port
    poll_secs  = args.poll_interval
    scripts_dir = Path(args.scripts_dir) if args.scripts_dir else Path.cwd()

    # Log directory
    log_dir = Path(args.log_dir) if args.log_dir else Path.cwd() / "logs" / "research_agent"
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = setup_logging(log_dir, node)
    logger.info(f"Research agent starting — node={node} qcc={qcc_host}:{qcc_port} "
                f"scripts_dir={scripts_dir} poll={poll_secs}s")

    heartbeat_path = log_dir / f"heartbeat_{node}.json"
    write_heartbeat(heartbeat_path, node)

    # ---------------------------------------------------------------------------
    # Main poll loop
    # ---------------------------------------------------------------------------
    while True:
        write_heartbeat(heartbeat_path, node)

        # 1. Poll for queued work
        experiment = None
        try:
            queue = api_get(qcc_host, qcc_port,
                            f"/api/research/queue?node={node}&status=queued&limit=10",
                            logger=logger)
            if isinstance(queue, list) and queue:
                # Pick highest priority (lowest priority number), then oldest
                experiment = sorted(queue,
                                    key=lambda e: (e.get("priority", 5),
                                                   e.get("created_at", "")))[0]
        except Exception as e:
            logger.warning(f"Poll failed: {e} — retrying in {poll_secs}s")
            time.sleep(poll_secs)
            continue

        if experiment is None:
            logger.debug(f"No queued experiments for node={node} — sleeping {poll_secs}s")
            time.sleep(poll_secs)
            continue

        exp_id = experiment.get("id")
        exp_name = experiment.get("name", f"exp-{exp_id}")
        logger.info(f"Found experiment #{exp_id}: {exp_name} (priority={experiment.get('priority')})")

        # 2. Claim the experiment (queued → running, atomic on the server)
        log_file_path = str(log_dir / f"exp_{exp_id}_{exp_name[:40].replace(' ', '_')}.log")
        try:
            claimed = api_post(qcc_host, qcc_port,
                               f"/api/research/queue/{exp_id}/claim",
                               {"node": node, "pid": os.getpid(), "log_path": log_file_path},
                               logger=logger)
        except RuntimeError as e:
            if "409" in str(e) or "already taken" in str(e):
                logger.info(f"Experiment #{exp_id} already claimed by another agent — skipping")
            else:
                logger.error(f"Claim failed for #{exp_id}: {e}")
            time.sleep(5)
            continue

        logger.info(f"Claimed experiment #{exp_id} ({exp_name})")

        # Merge full detail back from claim response
        merged = {**experiment, **claimed}

        # 3. Execute
        success, error_msg, result = run_experiment(
            merged, scripts_dir, log_dir, qcc_host, qcc_port,
            node, heartbeat_path, logger)

        # 4. Report result
        if success:
            try:
                body = {"result_json": json.dumps(result) if result else None}
                api_post(qcc_host, qcc_port,
                         f"/api/research/queue/{exp_id}/complete",
                         body, logger=logger)
                logger.info(f"Reported success for #{exp_id}")
            except Exception as re:
                logger.error(f"Failed to report success for #{exp_id}: {re}")
        else:
            log_file = log_dir / f"exp_{exp_id}_{exp_name[:40].replace(' ', '_')}.log"
            stderr_tail = tail_file(log_file, LOG_TAIL_LINES)
            try:
                body = {"error": error_msg, "stderr_tail": stderr_tail}
                resp = api_post(qcc_host, qcc_port,
                                f"/api/research/queue/{exp_id}/fail",
                                body, logger=logger)
                logger.warning(f"Reported failure for #{exp_id}: {resp.get('status')} "
                               f"(retry {resp.get('retry_count', '?')})")
            except Exception as fe:
                logger.error(f"Failed to report failure for #{exp_id}: {fe}")

        # Brief pause between experiments
        time.sleep(2)

# ---------------------------------------------------------------------------

if __name__ == "__main__":
    main()
