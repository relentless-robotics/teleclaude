#!/usr/bin/env python3
"""
node_api_server.py — Lightweight Flask REST API server for compute nodes.

Replaces SSH for remote command execution, GPU monitoring, log tailing,
file uploads, and job queue management.

Works on Windows and Linux (auto-detects OS for command execution).

Usage:
    NODE_API_KEY=mysecret python node_api_server.py
    # or place key in compute/.env as NODE_API_KEY=...

Endpoints:
    POST /exec              — Execute command (blocking or background)
    GET  /health            — Node health: GPU, memory, disk, uptime, processes
    GET  /gpu               — GPU status only (util, memory, power, temp)
    GET  /processes         — List Python processes with command lines
    POST /upload            — Upload file to node (multipart: file + path field)
    GET  /logs              — Tail log file (?path=...&lines=50)
    GET  /queue             — Read this node's job queue file
    POST /queue/complete    — Mark a job complete with results

All endpoints (except /health) require:  X-API-Key: <key>
"""

import json
import logging
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import threading
from functools import wraps
from pathlib import Path

# ── Flask import ─────────────────────────────────────────────────────────────
try:
    from flask import Flask, request, jsonify, abort
except ImportError:
    print("Flask not installed. Run: pip install flask psutil")
    sys.exit(1)

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# ── Configuration ─────────────────────────────────────────────────────────────
PORT              = int(os.environ.get("NODE_API_PORT", "8765"))
API_KEY           = os.environ.get("NODE_API_KEY", "")
IS_WINDOWS        = platform.system() == "Windows"
HOSTNAME          = platform.node()
MAX_EXEC_TIMEOUT  = 600   # seconds — hard cap for blocking /exec
DEFAULT_TIMEOUT   = 60
MAX_LOG_LINES     = 10000
DEFAULT_LOG_LINES = 50

# Queue file directory — same as the compute dir where this server lives
COMPUTE_DIR = Path(__file__).parent
BASE_DIR    = COMPUTE_DIR.parent  # teleclaude root

# Load .env next to this file if present (simple KEY=VALUE format)
_env_path = COMPUTE_DIR / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            key, val = _k.strip(), _v.strip()
            if val:  # .env values override empty env vars
                os.environ[key] = val
    API_KEY = os.environ.get("NODE_API_KEY", "") or API_KEY

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_FILE = COMPUTE_DIR / "node_api_server.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(str(LOG_FILE), encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("node_api")

# Suppress Flask's default request logger to avoid duplicate logs
logging.getLogger("werkzeug").setLevel(logging.WARNING)

# ── State ─────────────────────────────────────────────────────────────────────
_start_time = time.time()

# Track background processes launched via /exec?background=true
# pid -> {"command": ..., "started_at": ..., "proc": Popen}
_background_procs: dict = {}
_bg_lock = threading.Lock()

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)

# ── Auth ──────────────────────────────────────────────────────────────────────
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not API_KEY:
            # No key configured — warn but allow (dev mode)
            return f(*args, **kwargs)
        key = request.headers.get("X-Api-Key", "") or request.headers.get("X-API-Key", "")
        if key != API_KEY:
            logger.warning(f"Unauthorized request from {request.remote_addr}: {request.path} | got_key=[{key}] expected=[{API_KEY[:4]}...] headers={dict(request.headers)}")
            abort(401)
        return f(*args, **kwargs)
    return decorated


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_float(s):
    try:
        return float(str(s).strip())
    except (ValueError, TypeError):
        return None


def _safe_int(s):
    try:
        return int(str(s).strip())
    except (ValueError, TypeError):
        return None


def _run_cmd(cmd, timeout=10, cwd=None):
    """Run a command synchronously. Returns (stdout, stderr, returncode)."""
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            timeout=timeout, cwd=cwd,
            encoding="utf-8", errors="replace",
        )
        return r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        return "", f"Timed out after {timeout}s", -1
    except Exception as e:
        return "", str(e), -1


def _gpu_info():
    """
    Query nvidia-smi for GPU stats.
    Returns list of GPU dicts, or empty list if no GPU / nvidia-smi missing.
    """
    if not shutil.which("nvidia-smi"):
        return []
    fields = (
        "index,name,utilization.gpu,utilization.memory,"
        "memory.used,memory.total,temperature.gpu,power.draw,power.limit"
    )
    stdout, _, rc = _run_cmd(
        f"nvidia-smi --query-gpu={fields} --format=csv,noheader,nounits",
        timeout=10,
    )
    if rc != 0 or not stdout.strip():
        return []
    gpus = []
    for line in stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 9:
            gpus.append({
                "index":          _safe_int(parts[0]),
                "name":           parts[1],
                "util_pct":       _safe_float(parts[2]),
                "mem_util_pct":   _safe_float(parts[3]),
                "mem_used_mb":    _safe_float(parts[4]),
                "mem_total_mb":   _safe_float(parts[5]),
                "temp_c":         _safe_float(parts[6]),
                "power_w":        _safe_float(parts[7]),
                "power_limit_w":  _safe_float(parts[8]),
            })
    return gpus


def _gpu_processes():
    """List processes using the GPU."""
    if not shutil.which("nvidia-smi"):
        return []
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
                "pid":        _safe_int(parts[0]),
                "name":       parts[1],
                "gpu_mem_mb": _safe_float(parts[2]),
            })
    return procs


def _ram_info():
    """Return system RAM stats."""
    if HAS_PSUTIL:
        vm = psutil.virtual_memory()
        return {
            "total_gb":     round(vm.total    / 1024**3, 1),
            "used_gb":      round(vm.used     / 1024**3, 1),
            "available_gb": round(vm.available / 1024**3, 1),
            "percent":      vm.percent,
        }
    # Fallback — parse OS tools
    if IS_WINDOWS:
        stdout, _, _ = _run_cmd(
            "wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /format:csv", timeout=5
        )
        for line in stdout.strip().splitlines():
            parts = line.split(",")
            if len(parts) >= 3:
                try:
                    free_kb  = int(parts[1])
                    total_kb = int(parts[2])
                    used_kb  = total_kb - free_kb
                    return {
                        "total_gb":     round(total_kb / 1024**2, 1),
                        "used_gb":      round(used_kb  / 1024**2, 1),
                        "available_gb": round(free_kb  / 1024**2, 1),
                        "percent":      round(used_kb / total_kb * 100, 1) if total_kb else 0,
                    }
                except ValueError:
                    continue
    else:
        stdout, _, _ = _run_cmd("free -b", timeout=5)
        lines = stdout.strip().splitlines()
        if len(lines) >= 2:
            parts = lines[1].split()
            if len(parts) >= 4:
                total = int(parts[1])
                used  = int(parts[2])
                avail = int(parts[6]) if len(parts) >= 7 else total - used
                return {
                    "total_gb":     round(total / 1024**3, 1),
                    "used_gb":      round(used  / 1024**3, 1),
                    "available_gb": round(avail / 1024**3, 1),
                    "percent":      round(used / total * 100, 1) if total else 0,
                }
    return None


def _disk_info():
    """Return disk usage for the base directory."""
    if HAS_PSUTIL:
        try:
            usage = psutil.disk_usage(str(BASE_DIR))
            return {
                "path":       str(BASE_DIR),
                "total_gb":   round(usage.total / 1024**3, 1),
                "used_gb":    round(usage.used  / 1024**3, 1),
                "free_gb":    round(usage.free  / 1024**3, 1),
                "percent":    usage.percent,
            }
        except Exception:
            pass
    return None


def _python_processes():
    """
    Return all Python processes with their full command lines.
    Uses psutil if available, falls back to OS tools.
    """
    procs = []
    if HAS_PSUTIL:
        KEYWORDS = ("python", "train", "torch", "cuda", "fill_sim", "research", "sweep")
        try:
            for p in psutil.process_iter(["pid", "name", "cmdline", "cpu_percent", "memory_info", "status", "create_time"]):
                try:
                    name = (p.info["name"] or "").lower()
                    cmdline = p.info["cmdline"] or []
                    cmd_str = " ".join(cmdline).lower()
                    if "python" in name or any(k in cmd_str for k in KEYWORDS):
                        mem_mb = round(p.info["memory_info"].rss / 1024**2, 1) if p.info["memory_info"] else None
                        procs.append({
                            "pid":      p.info["pid"],
                            "name":     p.info["name"],
                            "status":   p.info["status"],
                            "cpu_pct":  p.info["cpu_percent"],
                            "mem_mb":   mem_mb,
                            "command":  " ".join(cmdline)[:300],
                            "started":  time.strftime("%H:%M:%S", time.localtime(p.info["create_time"])) if p.info["create_time"] else None,
                        })
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except Exception:
            pass
        return procs

    # Fallback — OS process listing
    if IS_WINDOWS:
        stdout, _, _ = _run_cmd(
            'wmic process where "name like \'%python%\'" get ProcessId,CommandLine /format:csv',
            timeout=10,
        )
        for line in stdout.strip().splitlines()[1:]:
            parts = line.split(",", 2)
            if len(parts) >= 3 and parts[2].strip():
                procs.append({
                    "pid":     _safe_int(parts[1]),
                    "name":    "python",
                    "command": parts[2].strip()[:300],
                })
    else:
        stdout, _, _ = _run_cmd(
            "ps aux --sort=-%cpu | grep -i python | grep -v grep", timeout=10
        )
        for line in stdout.strip().splitlines():
            parts = line.split(None, 10)
            if len(parts) >= 11:
                procs.append({
                    "pid":     _safe_int(parts[1]),
                    "user":    parts[0],
                    "cpu_pct": _safe_float(parts[2]),
                    "mem_pct": _safe_float(parts[3]),
                    "command": parts[10][:300],
                })
    return procs


def _uptime_s():
    if HAS_PSUTIL:
        try:
            return time.time() - psutil.boot_time()
        except Exception:
            pass
    return time.time() - _start_time


def _queue_file_path(node_name=None):
    """
    Return the path to this node's queue JSON file.
    If node_name is not provided, detect from hostname.
    """
    if node_name:
        return COMPUTE_DIR / f"job_queue_{node_name}.json"
    # Auto-detect: check hostname against known node names
    h = HOSTNAME.lower()
    for name in ("neptune", "uranus", "razer", "jupiter", "saturn"):
        if name in h:
            return COMPUTE_DIR / f"job_queue_{name}.json"
    # Fallback: generic file
    return COMPUTE_DIR / "job_queue_local.json"


def _reap_background_procs():
    """Poll background processes and clean up completed ones."""
    with _bg_lock:
        done = []
        for pid, info in _background_procs.items():
            proc = info.get("proc")
            if proc and proc.poll() is not None:
                done.append(pid)
        for pid in done:
            info = _background_procs.pop(pid)
            logger.info(f"Background process {pid} exited with code {info['proc'].returncode}: {info['command'][:80]}")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    """Liveness probe — no auth required."""
    _reap_background_procs()
    return jsonify({
        "status":    "ok",
        "hostname":  HOSTNAME,
        "platform":  platform.system(),
        "python":    sys.version.split()[0],
        "uptime_s":  round(time.time() - _start_time, 1),
        "sys_uptime_s": round(_uptime_s(), 1),
        "gpu":       _gpu_info(),
        "ram":       _ram_info(),
        "disk":      _disk_info(),
        "bg_procs":  len(_background_procs),
        "timestamp": time.time(),
    })


@app.route("/gpu", methods=["GET"])
@require_auth
def gpu():
    """GPU status: util%, memory, power, temperature."""
    return jsonify({
        "hostname":  HOSTNAME,
        "gpus":      _gpu_info(),
        "processes": _gpu_processes(),
        "timestamp": time.time(),
    })


@app.route("/processes", methods=["GET"])
@require_auth
def processes():
    """List Python processes with command lines."""
    _reap_background_procs()
    bg_list = []
    with _bg_lock:
        for pid, info in _background_procs.items():
            bg_list.append({
                "pid":        pid,
                "command":    info["command"][:200],
                "started_at": info["started_at"],
                "background": True,
            })
    return jsonify({
        "hostname":    HOSTNAME,
        "python_procs": _python_processes(),
        "background":  bg_list,
        "timestamp":   time.time(),
    })


@app.route("/exec", methods=["POST"])
@require_auth
def exec_command():
    """
    Execute a command on this node.

    Body (JSON):
        command   str   required  — shell command to run
        timeout   int   optional  — seconds (default 60, max 600)
        background bool optional  — if true, launch detached and return PID
        cwd       str   optional  — working directory

    Response (blocking):
        {stdout, stderr, exitCode, duration_ms}

    Response (background):
        {pid, background: true, command}
    """
    body = request.get_json(silent=True) or {}
    command = (body.get("command") or "").strip()
    if not command:
        return jsonify({"error": "Missing 'command' field"}), 400

    timeout    = min(int(body.get("timeout", DEFAULT_TIMEOUT)), MAX_EXEC_TIMEOUT)
    background = bool(body.get("background", False))
    cwd        = body.get("cwd") or None

    # Validate cwd
    if cwd and not os.path.isdir(cwd):
        return jsonify({"error": f"cwd does not exist: {cwd}"}), 400

    logger.info(f"EXEC {'[BG] ' if background else ''}from {request.remote_addr}: {command[:120]}")

    if background:
        # Launch detached — fire and forget
        try:
            if IS_WINDOWS:
                # Windows: use DETACHED_PROCESS flag
                DETACHED_PROCESS = 0x00000008
                CREATE_NEW_PROCESS_GROUP = 0x00000200
                CREATE_NO_WINDOW = 0x08000000
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    cwd=cwd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
                )
            else:
                # Linux: nohup + setsid
                proc = subprocess.Popen(
                    ["bash", "-c", command],
                    cwd=cwd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )

            pid = proc.pid
            with _bg_lock:
                _background_procs[pid] = {
                    "command":    command,
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "proc":       proc,
                }
            logger.info(f"Background process launched: PID {pid}")
            return jsonify({
                "background": True,
                "pid":        pid,
                "command":    command,
                "started_at": _background_procs[pid]["started_at"],
            })
        except Exception as e:
            logger.error(f"Failed to launch background process: {e}")
            return jsonify({"error": str(e)}), 500

    # Blocking execution
    t0 = time.time()
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            encoding="utf-8",
            errors="replace",
        )
        duration_ms = round((time.time() - t0) * 1000)
        return jsonify({
            "stdout":      result.stdout,
            "stderr":      result.stderr,
            "exitCode":    result.returncode,
            "command":     command,
            "duration_ms": duration_ms,
        })
    except subprocess.TimeoutExpired as e:
        duration_ms = round((time.time() - t0) * 1000)
        stdout_bytes = e.stdout or b""
        return jsonify({
            "stdout":      stdout_bytes.decode("utf-8", errors="replace") if isinstance(stdout_bytes, bytes) else (stdout_bytes or ""),
            "stderr":      f"Timed out after {timeout}s",
            "exitCode":    -1,
            "command":     command,
            "duration_ms": duration_ms,
        })
    except Exception as e:
        return jsonify({
            "stdout":      "",
            "stderr":      str(e),
            "exitCode":    -1,
            "command":     command,
            "duration_ms": round((time.time() - t0) * 1000),
        }), 500


@app.route("/upload", methods=["POST"])
@require_auth
def upload():
    """
    Upload a file to this node.

    Multipart form data:
        file  — the file content
        path  — destination absolute path on this node

    The destination directory must already exist (for safety).
    """
    if "file" not in request.files:
        return jsonify({"error": "No 'file' field in multipart data"}), 400

    dest_path = (request.form.get("path") or "").strip()
    if not dest_path:
        return jsonify({"error": "Missing 'path' form field (destination path)"}), 400

    # Resolve and validate destination
    dest = Path(dest_path).resolve()
    if not dest.parent.exists():
        return jsonify({"error": f"Destination directory does not exist: {dest.parent}"}), 400

    # Block path traversal to obviously sensitive OS directories
    blocked_prefixes = [
        Path("/etc"), Path("/bin"), Path("/sbin"),
        Path("C:/Windows"), Path("C:/System32"),
    ]
    for bp in blocked_prefixes:
        try:
            dest.relative_to(bp)
            return jsonify({"error": f"Destination not allowed: {dest}"}), 403
        except ValueError:
            pass

    uploaded_file = request.files["file"]
    try:
        # Write atomically: temp file → rename
        tmp_fd, tmp_path = tempfile.mkstemp(dir=str(dest.parent))
        try:
            with os.fdopen(tmp_fd, "wb") as tmp_f:
                uploaded_file.save(tmp_f)
            shutil.move(tmp_path, str(dest))
        except Exception:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            raise

        size_bytes = dest.stat().st_size
        logger.info(f"UPLOAD from {request.remote_addr}: {dest} ({size_bytes} bytes)")
        return jsonify({
            "status":      "ok",
            "path":        str(dest),
            "size_bytes":  size_bytes,
        })
    except Exception as e:
        logger.error(f"Upload failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/logs", methods=["GET"])
@require_auth
def tail_logs():
    """
    Read last N lines of a log file.
    Query params:
        path  str  required — absolute path to log file
        lines int  optional — number of lines (default 50, max 10000)
    """
    filepath = (request.args.get("path") or "").strip()
    if not filepath:
        return jsonify({"error": "Missing 'path' query param"}), 400

    resolved = str(Path(filepath).resolve())

    # Block sensitive files
    blocked = ["/etc/shadow", "/etc/passwd", "\\windows\\system32\\config"]
    if any(b.lower() in resolved.lower() for b in blocked):
        return jsonify({"error": "Access denied"}), 403

    if not os.path.isfile(resolved):
        return jsonify({"error": f"File not found: {filepath}"}), 404

    n_lines = min(int(request.args.get("lines", DEFAULT_LOG_LINES)), MAX_LOG_LINES)

    try:
        with open(resolved, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        tail = all_lines[-n_lines:]
        return jsonify({
            "path":           resolved,
            "total_lines":    len(all_lines),
            "returned_lines": len(tail),
            "content":        "".join(tail),
            "timestamp":      time.time(),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/queue", methods=["GET"])
@require_auth
def get_queue():
    """
    Read this node's job queue JSON file.
    Query param: node=<name> (optional, auto-detected from hostname if omitted)
    """
    node_name = request.args.get("node")
    queue_file = _queue_file_path(node_name)

    if not queue_file.exists():
        return jsonify({
            "node":  node_name or HOSTNAME,
            "file":  str(queue_file),
            "jobs":  [],
            "total": 0,
        })

    try:
        data = json.loads(queue_file.read_text(encoding="utf-8"))
        # data may be a list or a dict with a 'jobs' key
        if isinstance(data, list):
            jobs = data
        elif isinstance(data, dict):
            jobs = data.get("jobs", data)
        else:
            jobs = []

        # Summarize counts
        by_status = {}
        for job in (jobs if isinstance(jobs, list) else []):
            s = job.get("status", "unknown")
            by_status[s] = by_status.get(s, 0) + 1

        return jsonify({
            "node":     node_name or HOSTNAME,
            "file":     str(queue_file),
            "jobs":     jobs,
            "total":    len(jobs) if isinstance(jobs, list) else 0,
            "by_status": by_status,
            "timestamp": time.time(),
        })
    except json.JSONDecodeError as e:
        return jsonify({"error": f"Invalid JSON in queue file: {e}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/queue/complete", methods=["POST"])
@require_auth
def queue_complete():
    """
    Mark a job as complete in this node's queue file.

    Body (JSON):
        job_id      str  required
        result      str  optional — summary string (e.g. "IC=0.17")
        node        str  optional — node name (auto-detected if omitted)
        exit_code   int  optional
    """
    body = request.get_json(silent=True) or {}
    job_id = (body.get("job_id") or body.get("id") or "").strip()
    if not job_id:
        return jsonify({"error": "Missing 'job_id' field"}), 400

    node_name = body.get("node")
    queue_file = _queue_file_path(node_name)

    if not queue_file.exists():
        return jsonify({"error": f"Queue file not found: {queue_file}"}), 404

    try:
        data = json.loads(queue_file.read_text(encoding="utf-8"))
        if isinstance(data, list):
            jobs = data
            wrapper = None
        elif isinstance(data, dict) and "jobs" in data:
            jobs = data["jobs"]
            wrapper = data
        else:
            return jsonify({"error": "Unrecognised queue file format"}), 500

        updated = None
        for job in jobs:
            if job.get("id") == job_id:
                job["status"]         = "done"
                job["completed_at"]   = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                job["result_summary"] = body.get("result", "")
                job["exit_code"]      = body.get("exit_code")
                updated = job
                break

        if not updated:
            return jsonify({"error": f"Job {job_id} not found in queue"}), 404

        if wrapper is not None:
            wrapper["jobs"] = jobs
            out = wrapper
        else:
            out = jobs

        queue_file.write_text(json.dumps(out, indent=2), encoding="utf-8")
        logger.info(f"QUEUE COMPLETE: job {job_id} on {node_name or HOSTNAME}: {body.get('result', '')}")
        return jsonify({"status": "ok", "job": updated})

    except Exception as e:
        logger.error(f"queue/complete failed: {e}")
        return jsonify({"error": str(e)}), 500


# ── Error handlers ────────────────────────────────────────────────────────────

@app.errorhandler(401)
def unauthorized(e):
    return jsonify({"error": "Unauthorized", "hint": "Set X-API-Key header"}), 401

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not found", "path": request.path}), 404

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({"error": "Method not allowed"}), 405

@app.errorhandler(500)
def server_error(e):
    logger.error(f"500: {e}")
    return jsonify({"error": "Internal server error", "message": str(e)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not API_KEY:
        logger.warning("=" * 60)
        logger.warning("NODE_API_KEY not set — all requests accepted!")
        logger.warning("Set NODE_API_KEY env var or add to compute/.env")
        logger.warning("=" * 60)

    logger.info(f"Starting node_api_server on {HOSTNAME} ({platform.system()})")
    logger.info(f"Port:    {PORT}")
    logger.info(f"Auth:    {'ENABLED' if API_KEY else 'DISABLED'} (key_len={len(API_KEY)}, key_start={API_KEY[:4] if API_KEY else 'NONE'})")
    logger.info(f"psutil:  {'available' if HAS_PSUTIL else 'not installed (pip install psutil)'}")
    logger.info(f"GPU:     {'nvidia-smi found' if shutil.which('nvidia-smi') else 'no nvidia-smi'}")
    logger.info(f"Base:    {BASE_DIR}")
    logger.info(f"Log:     {LOG_FILE}")

    # Graceful shutdown on signals
    def _shutdown(sig, frame):
        logger.info(f"Received signal {sig}, shutting down")
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _shutdown)

    app.run(
        host="0.0.0.0",
        port=PORT,
        debug=False,
        threaded=True,
        use_reloader=False,
    )
