"""
task_queue.py — Lightweight distributed task queue for personal compute orchestration.

Supports local PC execution and remote SSH targets (Jupiter, extensible to more).
State is persisted in queue_state.json. No external dependencies beyond stdlib + paramiko.

Usage:
    python compute/task_queue.py add --name "edge analysis" --command "..." --target jupiter
    python compute/task_queue.py list [--status pending] [--target jupiter]
    python compute/task_queue.py dispatch [--target jupiter]
    python compute/task_queue.py status
    python compute/task_queue.py check
    python compute/task_queue.py results TASK_ID
    python compute/task_queue.py cancel TASK_ID
"""

import argparse
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Compute target registry — add new servers here
# ---------------------------------------------------------------------------

COMPUTE_TARGETS = {
    'pc': {
        'type': 'local',
    },
    'jupiter': {
        'type': 'ssh',
        'connect_fn': 'connect_jupiter',   # function name in utils.ssh_exec
        'venv': '~/lvl3quant/venv/bin/python',
        'work_dir': '~/lvl3quant',
        'log_dir': '~/task_logs',          # remote directory for log files
    },
    # To add a new server:
    # 'bigserver': {
    #     'type': 'ssh',
    #     'connect_fn': 'connect_bigserver',  # add fn to utils/ssh_exec.py
    #     'venv': '~/project/venv/bin/python',
    #     'work_dir': '~/project',
    #     'log_dir': '~/task_logs',
    # },
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
STATE_FILE = os.path.join(_HERE, 'queue_state.json')
LOCAL_LOG_DIR = os.path.join(_HERE, 'logs')

# ---------------------------------------------------------------------------
# State I/O
# ---------------------------------------------------------------------------

def _load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    return {'tasks': {}}


def _save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2, default=str)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# SSH helper — lazy-imports and dispatches to the right connect_fn
# ---------------------------------------------------------------------------

def _ssh_exec(target_name: str, command: str, timeout: int = 120) -> dict:
    """Run a command on the given SSH target. Returns connect_jupiter-style dict."""
    target = COMPUTE_TARGETS[target_name]
    fn_name = target['connect_fn']

    sys.path.insert(0, _REPO_ROOT)
    import utils.ssh_exec as ssh_mod  # noqa: PLC0415

    fn = getattr(ssh_mod, fn_name)
    return fn(command, timeout=timeout)


# ---------------------------------------------------------------------------
# Core API
# ---------------------------------------------------------------------------

def add_task(
    name: str,
    command: str,
    target: str,
    priority: int = 5,
    depends_on: list[str] | None = None,
    tags: list[str] | None = None,
) -> str:
    """Create and persist a new task. Returns the task_id."""
    if target not in COMPUTE_TARGETS:
        raise ValueError(f"Unknown target '{target}'. Known: {list(COMPUTE_TARGETS)}")

    task_id = str(uuid.uuid4())[:8]  # short ID for readability
    task = {
        'id': task_id,
        'name': name,
        'command': command,
        'target': target,
        'priority': priority,
        'status': 'pending',
        'depends_on': depends_on or [],
        'created_at': _now(),
        'started_at': None,
        'completed_at': None,
        'result': None,
        'log_file': None,
        'tags': tags or [],
        'pid': None,        # PC only: subprocess PID
    }

    state = _load_state()
    state['tasks'][task_id] = task
    _save_state(state)
    return task_id


def list_tasks(status: str | None = None, target: str | None = None) -> list[dict]:
    """Return tasks, optionally filtered by status and/or target."""
    state = _load_state()
    tasks = list(state['tasks'].values())
    if status:
        tasks = [t for t in tasks if t['status'] == status]
    if target:
        tasks = [t for t in tasks if t['target'] == target]
    # Sort: pending first by priority, then by created_at
    tasks.sort(key=lambda t: (t['status'] != 'pending', t['priority'], t['created_at']))
    return tasks


def get_task(task_id: str) -> dict:
    state = _load_state()
    if task_id not in state['tasks']:
        raise KeyError(f"Task '{task_id}' not found.")
    return state['tasks'][task_id]


def cancel_task(task_id: str) -> None:
    """Mark a task cancelled. Does not kill running processes."""
    state = _load_state()
    if task_id not in state['tasks']:
        raise KeyError(f"Task '{task_id}' not found.")
    task = state['tasks'][task_id]
    if task['status'] == 'running':
        print(f"Warning: task {task_id} is currently running; marking cancelled anyway.")
    task['status'] = 'cancelled'
    task['completed_at'] = _now()
    _save_state(state)


# ---------------------------------------------------------------------------
# Dependency resolution
# ---------------------------------------------------------------------------

def _deps_satisfied(task: dict, all_tasks: dict) -> bool:
    for dep_id in task['depends_on']:
        dep = all_tasks.get(dep_id)
        if dep is None or dep['status'] != 'completed':
            return False
    return True


def _pick_next(state: dict, target: str | None = None) -> dict | None:
    """Find the highest-priority pending task with satisfied dependencies."""
    candidates = [
        t for t in state['tasks'].values()
        if t['status'] == 'pending'
        and (target is None or t['target'] == target)
        and _deps_satisfied(t, state['tasks'])
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda t: (t['priority'], t['created_at']))


# ---------------------------------------------------------------------------
# Execution: local PC
# ---------------------------------------------------------------------------

def _launch_local(task: dict, state: dict) -> None:
    os.makedirs(LOCAL_LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOCAL_LOG_DIR, f"task_{task['id']}.log")

    with open(log_path, 'w') as log_f:
        proc = subprocess.Popen(
            task['command'],
            shell=True,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            text=True,
        )

    task['status'] = 'running'
    task['started_at'] = _now()
    task['log_file'] = log_path
    task['pid'] = proc.pid
    _save_state(state)
    print(f"  Launched locally — PID {proc.pid}, log: {log_path}")


# ---------------------------------------------------------------------------
# Execution: remote SSH (tmux)
# ---------------------------------------------------------------------------

def _launch_ssh(task: dict, state: dict) -> None:
    target_cfg = COMPUTE_TARGETS[task['target']]
    log_dir = target_cfg.get('log_dir', '~/task_logs')
    session = f"task_{task['id']}"
    log_file = f"{log_dir}/{session}.log"

    # Ensure remote log directory exists
    mkdir_result = _ssh_exec(task['target'], f"mkdir -p {log_dir}", timeout=15)
    if not mkdir_result['success']:
        raise RuntimeError(f"Could not create remote log dir: {mkdir_result.get('error')}")

    # Wrap the command in tmux; redirect output to log file
    cmd = task['command']
    tmux_cmd = (
        f"tmux new-session -d -s {session} "
        f"'( {cmd} ) > {log_file} 2>&1'"
    )

    result = _ssh_exec(task['target'], tmux_cmd, timeout=30)
    if not result['success']:
        raise RuntimeError(f"SSH launch failed: {result.get('error')}")
    if result['exit_code'] != 0:
        raise RuntimeError(
            f"tmux launch failed (exit {result['exit_code']}): {result['stderr'].strip()}"
        )

    task['status'] = 'running'
    task['started_at'] = _now()
    task['log_file'] = log_file
    _save_state(state)
    print(f"  Launched on {task['target']} — tmux session '{session}', log: {log_file}")


# ---------------------------------------------------------------------------
# dispatch_next
# ---------------------------------------------------------------------------

def dispatch_next(target: str | None = None) -> str | None:
    """Find and launch the next eligible task. Returns task_id or None."""
    state = _load_state()
    task = _pick_next(state, target=target)
    if task is None:
        return None

    target_name = task['target']
    target_cfg = COMPUTE_TARGETS[target_name]
    print(f"Dispatching task {task['id']} — '{task['name']}' on {target_name}")

    try:
        if target_cfg['type'] == 'local':
            _launch_local(task, state)
        elif target_cfg['type'] == 'ssh':
            _launch_ssh(task, state)
        else:
            raise ValueError(f"Unknown target type: {target_cfg['type']}")
    except Exception as e:
        task['status'] = 'failed'
        task['result'] = str(e)
        task['completed_at'] = _now()
        _save_state(state)
        print(f"  FAILED to launch: {e}")
        return None

    return task['id']


# ---------------------------------------------------------------------------
# check_running — poll status of in-flight tasks
# ---------------------------------------------------------------------------

def _check_local_task(task: dict, state: dict) -> None:
    pid = task.get('pid')
    if pid is None:
        task['status'] = 'failed'
        task['result'] = 'No PID recorded'
        task['completed_at'] = _now()
        return

    # Check if PID is still alive (cross-platform)
    try:
        if sys.platform == 'win32':
            result = subprocess.run(
                ['tasklist', '/FI', f'PID eq {pid}', '/NH'],
                capture_output=True, text=True
            )
            alive = str(pid) in result.stdout
        else:
            os.kill(pid, 0)
            alive = True
    except (ProcessLookupError, PermissionError):
        alive = False
    except Exception:
        alive = False

    if not alive:
        # Process finished — check log for exit signal (best-effort)
        log_file = task.get('log_file', '')
        exit_hint = ''
        if log_file and os.path.exists(log_file):
            try:
                with open(log_file, 'r') as f:
                    lines = f.readlines()
                    exit_hint = (lines[-1].strip() if lines else '').rstrip()
            except Exception:
                pass
        task['status'] = 'completed'
        task['completed_at'] = _now()
        task['result'] = exit_hint or 'Process exited'


def _check_ssh_task(task: dict, state: dict) -> None:
    session = f"task_{task['id']}"
    # tmux has-session exits 0 if session exists (still running), 1 if gone
    result = _ssh_exec(task['target'], f"tmux has-session -t {session} 2>/dev/null; echo $?", timeout=15)
    if not result['success']:
        # Cannot reach server — skip for now
        print(f"  Warning: cannot reach {task['target']} to check task {task['id']}")
        return

    exit_code_str = result['stdout'].strip().splitlines()[-1] if result['stdout'].strip() else '1'
    session_alive = (exit_code_str == '0')

    if not session_alive:
        # Session ended — fetch last lines of log as result
        log_file = task.get('log_file', '')
        tail_result = {'stdout': ''} if not log_file else _ssh_exec(
            task['target'], f"tail -30 {log_file} 2>/dev/null || echo '[no log]'", timeout=15
        )
        task['status'] = 'completed'
        task['completed_at'] = _now()
        task['result'] = (tail_result.get('stdout') or '').strip()


def check_running() -> list[dict]:
    """Check status of all running tasks; update state. Returns updated task list."""
    state = _load_state()
    running = [t for t in state['tasks'].values() if t['status'] == 'running']

    for task in running:
        target_cfg = COMPUTE_TARGETS.get(task['target'], {})
        if target_cfg.get('type') == 'local':
            _check_local_task(task, state)
        elif target_cfg.get('type') == 'ssh':
            _check_ssh_task(task, state)

        if task['status'] != 'running':
            print(f"  Task {task['id']} '{task['name']}' -> {task['status']}")

    _save_state(state)
    return running


# ---------------------------------------------------------------------------
# get_results
# ---------------------------------------------------------------------------

def get_results(task_id: str) -> str:
    """Return log content for a task. Fetches remote log for SSH tasks."""
    task = get_task(task_id)
    target_cfg = COMPUTE_TARGETS.get(task['target'], {})
    log_file = task.get('log_file')

    if not log_file:
        if task.get('result'):
            return task['result']
        return '[No log file recorded for this task]'

    if target_cfg.get('type') == 'local':
        if not os.path.exists(log_file):
            return f'[Log file not found: {log_file}]'
        with open(log_file, 'r') as f:
            return f.read()

    elif target_cfg.get('type') == 'ssh':
        result = _ssh_exec(task['target'], f"cat {log_file} 2>/dev/null || echo '[no log]'", timeout=30)
        if not result['success']:
            return f"[Cannot reach {task['target']}: {result.get('error')}]"
        return result['stdout']

    return '[Unknown target type]'


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------

def _fmt_task_row(t: dict) -> str:
    STATUS_ICONS = {
        'pending': '[ ]',
        'running': '[>]',
        'completed': '[x]',
        'failed': '[!]',
        'cancelled': '[-]',
    }
    icon = STATUS_ICONS.get(t['status'], '[ ]')
    deps = f" (deps: {','.join(t['depends_on'])})" if t['depends_on'] else ''
    tags = f" [{','.join(t['tags'])}]" if t['tags'] else ''
    return (
        f"  {icon} {t['id']}  p={t['priority']}  {t['target']:<10}  "
        f"{t['status']:<10}  {t['name']}{deps}{tags}"
    )


def _print_status() -> None:
    tasks = list_tasks()
    counts = {}
    for t in tasks:
        counts[t['status']] = counts.get(t['status'], 0) + 1

    print(f"Queue status ({len(tasks)} tasks total):")
    for status, n in sorted(counts.items()):
        print(f"  {status}: {n}")
    print()

    for status_group in ['running', 'pending', 'failed', 'completed', 'cancelled']:
        group = [t for t in tasks if t['status'] == status_group]
        if group:
            print(f"--- {status_group.upper()} ---")
            for t in group:
                print(_fmt_task_row(t))
            print()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Personal compute task queue',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest='cmd', required=True)

    # add
    p_add = sub.add_parser('add', help='Add a new task')
    p_add.add_argument('--name', required=True, help='Human-readable task name')
    p_add.add_argument('--command', required=True, help='Shell command to run')
    p_add.add_argument('--target', required=True, choices=list(COMPUTE_TARGETS),
                       help='Compute target')
    p_add.add_argument('--priority', type=int, default=5, help='Priority (lower = higher, default 5)')
    p_add.add_argument('--depends-on', nargs='*', default=[], metavar='TASK_ID',
                       help='Task IDs that must complete first')
    p_add.add_argument('--tags', nargs='*', default=[], help='Optional tags')

    # list
    p_list = sub.add_parser('list', help='List tasks')
    p_list.add_argument('--status', choices=['pending', 'running', 'completed', 'failed', 'cancelled'])
    p_list.add_argument('--target', choices=list(COMPUTE_TARGETS))

    # dispatch
    p_dispatch = sub.add_parser('dispatch', help='Dispatch next eligible task')
    p_dispatch.add_argument('--target', choices=list(COMPUTE_TARGETS),
                            help='Restrict to a specific target')

    # status
    sub.add_parser('status', help='Print queue summary')

    # check
    sub.add_parser('check', help='Poll running tasks and update their status')

    # results
    p_results = sub.add_parser('results', help='Fetch log/results for a task')
    p_results.add_argument('task_id')

    # cancel
    p_cancel = sub.add_parser('cancel', help='Cancel a task')
    p_cancel.add_argument('task_id')

    args = parser.parse_args()

    if args.cmd == 'add':
        task_id = add_task(
            name=args.name,
            command=args.command,
            target=args.target,
            priority=args.priority,
            depends_on=args.depends_on,
            tags=args.tags,
        )
        print(f"Added task {task_id}: '{args.name}' -> {args.target} (priority {args.priority})")

    elif args.cmd == 'list':
        tasks = list_tasks(status=args.status, target=args.target)
        if not tasks:
            print('No tasks found.')
        else:
            for t in tasks:
                print(_fmt_task_row(t))

    elif args.cmd == 'dispatch':
        task_id = dispatch_next(target=args.target)
        if task_id is None:
            print('Nothing to dispatch (no eligible pending tasks).')
        else:
            print(f"Dispatched task {task_id}.")

    elif args.cmd == 'status':
        _print_status()

    elif args.cmd == 'check':
        print('Checking running tasks...')
        running = check_running()
        if not running:
            print('No running tasks.')

    elif args.cmd == 'results':
        output = get_results(args.task_id)
        print(output)

    elif args.cmd == 'cancel':
        cancel_task(args.task_id)
        print(f"Cancelled task {args.task_id}.")


if __name__ == '__main__':
    main()
