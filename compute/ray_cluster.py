"""
Ray Cluster Utilities — connects to distributed Ray cluster.

CLUSTER ARCHITECTURE (2026-03-29):
------------------------------------
HEAD node:  Jupiter (192.168.0.108:6379)  — Linux, 64GB RAM, 64 CPU
Workers:
  Saturn    (10.0.0.2)         — Linux, 32GB RAM, 32 CPU
  Neptune   (172.17.x.x/WSL)  — Windows WSL Ubuntu, 16 CPU

GPU work:
  Razer     (100.102.215.75)   — Windows RTX 3070, Flask API dispatch only
  Uranus    (100.100.83.37)    — Windows RTX 5090, auto-joins when online

Dashboard: http://192.168.0.108:8265

NEPTUNE (HEAD MACHINE) NOTE:
Neptune runs UWP Python which cannot start Ray workers directly.
It connects via wsl (Ubuntu-22.04) as a worker node.
Python scripts on Neptune use ray.init(address="ray://192.168.0.108:10001")
to connect as a client to the cluster.

ORCHESTRATOR:
  compute/ray_orchestrator.py — runs as PM2 process 'ray-orchestrator'
  bash compute/ray_cluster_manager.sh start  — start the full cluster

Usage:
    from compute.ray_cluster import init_cluster, submit_job, map_jobs, shutdown

    init_cluster()   # connects to Jupiter head
    results = map_jobs(my_func, [{"param": 1}, {"param": 2}])
    shutdown()
"""

import os
import sys
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
from typing import Any, Callable, Iterable

# ─── Mode detection ──────────────────────────────────────────────────────────

def _is_uwp_python() -> bool:
    """Detect Microsoft Store (UWP) Python which cannot run Ray head node."""
    exe = sys.executable or ""
    return "WindowsApps" in exe or "Packages" in exe

# Cluster head address (Jupiter)
RAY_HEAD_ADDRESS = "192.168.0.108:6379"
RAY_CLIENT_ADDRESS = "ray://192.168.0.108:10001"

_RAY_AVAILABLE = False
try:
    import ray as _ray
    # On non-UWP Python: Ray is usable. On UWP: only as client to remote cluster.
    _RAY_AVAILABLE = True
except ImportError:
    pass

# Fallback pool — ThreadPoolExecutor for I/O-bound dispatch tasks (sweep launching,
# SSH fan-out, result collection). For CPU-bound parallel workloads use ProcessPoolExecutor
# with importable functions (not lambdas or __main__ closures).
_pool: ThreadPoolExecutor = None
_num_cpus_active: int = 0


# ─── Init ─────────────────────────────────────────────────────────────────────

def init_local(
    num_cpus: int = None,
    num_gpus: int = None,
    ignore_reinit: bool = True,
    dashboard_host: str = "0.0.0.0",
    dashboard_port: int = 8265,
) -> dict:
    """
    DEPRECATED: Use init_cluster() to connect to the real Ray cluster.
    Kept for backward compatibility — falls back to ThreadPoolExecutor on UWP.
    """
    return init_cluster(ignore_reinit=ignore_reinit)


def init_cluster(ignore_reinit: bool = True) -> dict:
    """
    Connect to the Ray cluster (head: Jupiter 192.168.0.108).

    On UWP Python (Microsoft Store): connects as a RAY CLIENT to the remote cluster.
    On non-UWP Python (python.org): also connects as client.
    Both modes: map_jobs/submit_job dispatch to the real distributed cluster.

    The cluster must be running. Start it with:
        bash compute/ray_cluster_manager.sh start
    Or:
        python compute/ray_orchestrator.py --start

    Returns
    -------
    dict — resource summary
    """
    global _pool, _num_cpus_active

    cpus = max(1, (os.cpu_count() or 4) - 2)

    if _RAY_AVAILABLE:
        if _ray.is_initialized():
            if ignore_reinit:
                print("[ray_cluster] Ray already initialized — skipping.")
                return _ray.cluster_resources()
            _ray.shutdown()

        try:
            # Connect as client to the distributed cluster
            _ray.init(
                address=RAY_CLIENT_ADDRESS,
                ignore_reinit_error=ignore_reinit,
                logging_level="WARNING",
                log_to_driver=False,
            )
            resources = _ray.cluster_resources()
            nodes = len(_ray.nodes())
            print(f"[ray_cluster] Connected to cluster @ {RAY_CLIENT_ADDRESS}")
            print(f"[ray_cluster] Nodes={nodes}  CPUs={resources.get('CPU', 0):.0f}  "
                  f"GPUs={resources.get('GPU', 0):.0f}")
            print(f"[ray_cluster] Dashboard: http://192.168.0.108:8265")
            _num_cpus_active = int(resources.get("CPU", cpus))
            return resources
        except Exception as e:
            print(f"[ray_cluster] WARNING: Could not connect to cluster: {e}")
            print(f"[ray_cluster] Start cluster with: bash compute/ray_cluster_manager.sh start")
            print(f"[ray_cluster] Falling back to ThreadPoolExecutor for local dispatch.")

    # Fallback — ThreadPoolExecutor for I/O dispatch
    if _pool is not None and ignore_reinit:
        print(f"[ray_cluster] ThreadPoolExecutor already running ({_num_cpus_active} workers).")
        return {"mode": "thread_pool_fallback", "CPU": _num_cpus_active}
    if _pool is not None:
        _pool.shutdown(wait=False)
    _pool = ThreadPoolExecutor(max_workers=cpus)
    _num_cpus_active = cpus
    print(f"[ray_cluster] Using ThreadPoolExecutor fallback ({cpus} workers).")
    print(f"[ray_cluster] Cluster head: {RAY_HEAD_ADDRESS} — start with ray_cluster_manager.sh")
    return {"mode": "thread_pool_fallback", "CPU": cpus}


def shutdown():
    """Shut down the parallel executor."""
    global _pool
    if _RAY_AVAILABLE and _ray.is_initialized():
        _ray.shutdown()
        print("[ray_cluster] Ray shut down.")
    if _pool is not None:
        _pool.shutdown(wait=True)
        _pool = None
        print("[ray_cluster] ProcessPoolExecutor shut down.")


# ─── Job submission ────────────────────────────────────────────────────────────

def submit_job(func: Callable, *args, **kwargs) -> Any:
    """
    Submit a single function call and block until it returns.
    Uses Ray if available, otherwise ProcessPoolExecutor.

    Parameters
    ----------
    func : callable
    *args, **kwargs — forwarded to func.

    Returns
    -------
    Result of func(*args, **kwargs).

    Example
    -------
    >>> init_local()
    >>> result = submit_job(expensive_fn, data, param=42)
    """
    global _pool
    if _RAY_AVAILABLE and _ray.is_initialized():
        remote_fn = _ray.remote(func)
        return _ray.get(remote_fn.remote(*args, **kwargs))
    else:
        if _pool is None:
            init_local()
        future = _pool.submit(func, *args, **kwargs)
        return future.result()


def map_jobs(func: Callable, param_list: Iterable[Any], unpack: bool = False) -> list:
    """
    Execute func over each item in param_list in parallel.
    Uses Ray if available, otherwise ProcessPoolExecutor.

    Parameters
    ----------
    func : callable
    param_list : iterable
        Each element is passed as the single argument to func.
        If unpack=True and elements are dicts, they are unpacked as **kwargs.
    unpack : bool

    Returns
    -------
    list — results in the same order as param_list.

    Example
    -------
    >>> init_local()
    >>> params = [{"tp": 2.0, "sl": 1.5}, {"tp": 3.0, "sl": 2.0}]
    >>> results = map_jobs(run_backtest, params, unpack=True)
    """
    global _pool
    params = list(param_list)

    if _RAY_AVAILABLE and _ray.is_initialized():
        remote_fn = _ray.remote(func)
        if unpack:
            refs = [remote_fn.remote(**p) for p in params]
        else:
            refs = [remote_fn.remote(p) for p in params]
        return _ray.get(refs)
    else:
        if _pool is None:
            init_local()
        if unpack:
            futures = {_pool.submit(func, **p): i for i, p in enumerate(params)}
        else:
            futures = {_pool.submit(func, p): i for i, p in enumerate(params)}
        results = [None] * len(params)
        for fut, idx in futures.items():
            results[idx] = fut.result()
        return results


def cluster_status() -> dict:
    """Return current executor resource summary."""
    if _RAY_AVAILABLE and _ray.is_initialized():
        return {
            "status": "running",
            "mode": "ray",
            "resources": _ray.cluster_resources(),
            "available": _ray.available_resources(),
            "nodes": len(_ray.nodes()),
        }
    if _pool is not None:
        return {
            "status": "running",
            "mode": "thread_pool_fallback",
            "workers": _num_cpus_active,
            "note": "UWP Python: Ray unavailable. Install python.org Python for full Ray.",
        }
    return {"status": "not_initialized"}


# ─── Remote node extension plan ───────────────────────────────────────────────
#
# REMOTE_SETUP: How to extend Ray to Razer / Jupiter (Linux/WSL nodes)
#
# Ray on Windows has NO built-in multi-machine cluster support (as of 2.x).
# To build a multi-node cluster, the recommended approach is:
#
# 1. Run Ray HEAD on a Linux node (e.g., Jupiter WSL2):
#       ray start --head --port=6379 --dashboard-host=0.0.0.0
#
# 2. Connect worker nodes:
#       ray start --address='192.168.0.108:6379'  # from Saturn
#       ray start --address='192.168.0.108:6379'  # from Razer (if Linux)
#
# 3. On Neptune, connect as a client (not a worker):
#       ray.init(address='ray://192.168.0.108:10001')
#
# 4. For Windows→Linux jobs, use ray.remote to send work to Linux workers by
#    specifying resources={"node_ip:192.168.0.108": 0.01} or use placement groups.
#
# Status as of 2026-03-27:
#   - Neptune (Windows): local Ray only
#   - Jupiter (WSL Linux): ready for Ray head once needed
#   - Saturn (Linux): ready as Ray worker once needed
#   - Razer (Windows): same limitation as Neptune — use as Ray client only
#
# For now, Neptune uses local-only Ray for multi-core parallelism (16 CPUs).
# CPU-heavy sweeps should be dispatched to Jupiter/Saturn via the job queue
# rather than through a distributed Ray cluster.
