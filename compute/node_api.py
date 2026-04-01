#!/usr/bin/env python3
"""
node_api.py — Lightweight Flask API for remote compute node execution.

Replaces SSH for command execution, GPU monitoring, log tailing, and health checks.
Runs on any node (Windows or Linux). Single file, only depends on Flask.

Usage:
    NODE_API_TOKEN=mysecret python node_api.py
    # or set token in .env file next to this script

Endpoints:
    GET  /health           — Alive check (no auth required)
    GET  /status           — GPU, RAM, CPU, running processes
    POST /exec             — Run a command, return stdout/stderr/exitcode
    GET  /logs?path=&lines= — Tail a log file
"""

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from functools import wraps
from pathlib import Path

try:
    from flask import Flask, request, jsonify, abort
except ImportError:
    print("Flask not installed. Run: pip install flask")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("NODE_API_PORT", "5001"))
TOKEN = os.environ.get("NODE_API_TOKEN", "")
IS_WINDOWS = platform.system() == "Windows"
HOSTNAME = platform.node()
MAX_EXEC_TIMEOUT = 300  # seconds, hard cap for /exec
DEFAULT_EXEC_TIMEOUT = 30
MAX_LOG_LINES = 5000
DEFAULT_LOG_LINES = 50

# Load .env file if present (simple key=value, no quotes handling needed)
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
    TOKEN = os.environ.get("NODE_API_TOKEN", TOKEN)

if not TOKEN:
    print("WARNING: NODE_API_TOKEN not set. All requests will be accepted.")
    print("Set NODE_API_TOKEN env var or add it to compute/.env for security.")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Auth middleware
# ---------------------------------------------------------------------------

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not TOKEN:
            return f(*args, **kwargs)
        auth = request.headers.get("Authorization", "")
        if auth == f"Bearer {TOKEN}" or request.args.get("token") == TOKEN:
            return f(*args, **kwargs)
        abort(401, description="Invalid or missing bearer token")
    return decorated

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_cmd(cmd, timeout=DEFAULT_EXEC_TIMEOUT, shell=True):
    """Run a command and return (stdout, stderr, exit_code)."""
    try:
        result = subprocess.run(
            cmd,
            shell=shell,
            capture_output=True,
            text=True,
            timeout=min(timeout, MAX_EXEC_TIMEOUT),
        )
        return result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired:
        return "", f"Command timed out after {timeout}s", -1
    except Exception as e:
        return "", str(e), -1


def _gpu_info():
    """Query nvidia-smi for GPU stats. Returns list of dicts or None."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        stdout, _, rc = _run_cmd(
            "nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,"
            "memory.used,memory.total,temperature.gpu,power.draw,power.limit "
            "--format=csv,noheader,nounits",
            timeout=10,
        )
        if rc != 0 or not stdout.strip():
            return None
        gpus = []
        for line in stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 9:
                gpus.append({
                    "index": int(parts[0]),
                    "name": parts[1],
                    "gpu_util_pct": _safe_float(parts[2]),
                    "mem_util_pct": _safe_float(parts[3]),
                    "mem_used_mb": _safe_float(parts[4]),
                    "mem_total_mb": _safe_float(parts[5]),
                    "temp_c": _safe_float(parts[6]),
                    "power_w": _safe_float(parts[7]),
                    "power_limit_w": _safe_float(parts[8]),
                })
        return gpus
    except Exception:
        return None


def _safe_float(s):
    """Parse a float, return None on failure."""
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _ram_info():
    """Return RAM stats as dict."""
    try:
        import psutil
        vm = psutil.virtual_memory()
        return {
            "total_gb": round(vm.total / (1024**3), 1),
            "used_gb": round(vm.used / (1024**3), 1),
            "available_gb": round(vm.available / (1024**3), 1),
            "percent": vm.percent,
        }
    except ImportError:
        # Fallback without psutil
        if IS_WINDOWS:
            stdout, _, _ = _run_cmd(
                'wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /format:csv',
                timeout=5,
            )
            for line in stdout.strip().splitlines():
                parts = line.split(",")
                if len(parts) >= 3:
                    try:
                        free_kb = int(parts[1])
                        total_kb = int(parts[2])
                        used_kb = total_kb - free_kb
                        return {
                            "total_gb": round(total_kb / (1024**2), 1),
                            "used_gb": round(used_kb / (1024**2), 1),
                            "available_gb": round(free_kb / (1024**2), 1),
                            "percent": round(used_kb / total_kb * 100, 1) if total_kb else 0,
                        }
                    except ValueError:
                        continue
        else:
            stdout, _, _ = _run_cmd("free -b | head -2", timeout=5)
            lines = stdout.strip().splitlines()
            if len(lines) >= 2:
                parts = lines[1].split()
                if len(parts) >= 4:
                    total = int(parts[1])
                    used = int(parts[2])
                    avail = int(parts[6]) if len(parts) >= 7 else total - used
                    return {
                        "total_gb": round(total / (1024**3), 1),
                        "used_gb": round(used / (1024**3), 1),
                        "available_gb": round(avail / (1024**3), 1),
                        "percent": round(used / total * 100, 1) if total else 0,
                    }
        return None


def _process_list():
    """Return list of notable processes (Python, node, training-related)."""
    keywords = ["python", "node", "train", "torch", "cuda", "jupyter", "pm2", "flask"]
    try:
        if IS_WINDOWS:
            stdout, _, _ = _run_cmd("tasklist /FO CSV /NH", timeout=10)
            procs = []
            for line in stdout.strip().splitlines():
                parts = line.replace('"', '').split(",")
                if len(parts) >= 5:
                    name = parts[0].lower()
                    if any(k in name for k in keywords):
                        procs.append({
                            "name": parts[0],
                            "pid": parts[1],
                            "mem_kb": parts[4].replace(" K", "").replace(",", "").strip(),
                        })
            return procs
        else:
            stdout, _, _ = _run_cmd("ps aux --sort=-%mem", timeout=10)
            procs = []
            for line in stdout.strip().splitlines()[1:]:  # skip header
                lower = line.lower()
                if any(k in lower for k in keywords):
                    parts = line.split(None, 10)
                    if len(parts) >= 11:
                        procs.append({
                            "user": parts[0],
                            "pid": parts[1],
                            "cpu_pct": parts[2],
                            "mem_pct": parts[3],
                            "command": parts[10][:200],
                        })
            return procs
    except Exception:
        return []


def _gpu_processes():
    """Return processes using the GPU."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        stdout, _, rc = _run_cmd(
            "nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory "
            "--format=csv,noheader,nounits",
            timeout=10,
        )
        if rc != 0 or not stdout.strip():
            return []
        procs = []
        for line in stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                procs.append({
                    "pid": parts[0],
                    "name": parts[1],
                    "gpu_mem_mb": _safe_float(parts[2]),
                })
        return procs
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    """No auth required. Simple liveness probe."""
    return jsonify({
        "status": "ok",
        "hostname": HOSTNAME,
        "platform": platform.system(),
        "uptime_s": time.time() - _start_time,
    })


@app.route("/status", methods=["GET"])
@require_auth
def status():
    """Full node status: GPU, RAM, processes."""
    gpu = _gpu_info()
    gpu_procs = _gpu_processes()
    ram = _ram_info()
    procs = _process_list()

    return jsonify({
        "hostname": HOSTNAME,
        "platform": platform.system(),
        "python": sys.version.split()[0],
        "gpu": gpu,
        "gpu_processes": gpu_procs,
        "ram": ram,
        "processes": procs,
        "timestamp": time.time(),
    })


@app.route("/exec", methods=["POST"])
@require_auth
def exec_command():
    """Execute a command. Body: {"command": "...", "timeout": 30, "cwd": null}"""
    body = request.get_json(silent=True) or {}
    command = body.get("command", "").strip()
    if not command:
        return jsonify({"error": "Missing 'command' field"}), 400

    timeout = min(int(body.get("timeout", DEFAULT_EXEC_TIMEOUT)), MAX_EXEC_TIMEOUT)
    cwd = body.get("cwd")

    # Validate cwd if provided
    if cwd and not os.path.isdir(cwd):
        return jsonify({"error": f"cwd does not exist: {cwd}"}), 400

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        return jsonify({
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exitCode": result.returncode,
            "command": command,
            "duration_ms": None,  # could add timing if needed
        })
    except subprocess.TimeoutExpired as e:
        return jsonify({
            "stdout": (e.stdout or b"").decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""),
            "stderr": f"Timed out after {timeout}s",
            "exitCode": -1,
            "command": command,
        })
    except Exception as e:
        return jsonify({
            "stdout": "",
            "stderr": str(e),
            "exitCode": -1,
            "command": command,
        }), 500


@app.route("/logs", methods=["GET"])
@require_auth
def tail_logs():
    """Tail a log file. Query params: path (required), lines (default 50)."""
    filepath = request.args.get("path", "").strip()
    if not filepath:
        return jsonify({"error": "Missing 'path' query param"}), 400

    # Security: resolve path and block directory traversal to sensitive locations
    resolved = str(Path(filepath).resolve())
    # Block common sensitive paths
    blocked = ["/etc/shadow", "/etc/passwd", "\\windows\\system32"]
    if any(b in resolved.lower() for b in blocked):
        return jsonify({"error": "Access denied"}), 403

    if not os.path.isfile(resolved):
        return jsonify({"error": f"File not found: {filepath}"}), 404

    lines = min(int(request.args.get("lines", DEFAULT_LOG_LINES)), MAX_LOG_LINES)

    try:
        # Read last N lines efficiently
        with open(resolved, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
            tail = all_lines[-lines:]
        return jsonify({
            "path": resolved,
            "total_lines": len(all_lines),
            "returned_lines": len(tail),
            "content": "".join(tail),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(401)
def unauthorized(e):
    return jsonify({"error": "Unauthorized", "message": str(e)}), 401

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(500)
def server_error(e):
    return jsonify({"error": "Internal server error", "message": str(e)}), 500


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

_start_time = time.time()

if __name__ == "__main__":
    print(f"[node_api] Starting on {HOSTNAME} ({platform.system()})")
    print(f"[node_api] Port: {PORT}")
    print(f"[node_api] Auth: {'ENABLED' if TOKEN else 'DISABLED (set NODE_API_TOKEN!)'}")
    print(f"[node_api] GPU: {'nvidia-smi found' if shutil.which('nvidia-smi') else 'no nvidia-smi'}")

    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
