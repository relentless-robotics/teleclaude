# Researcher Agent System

This directory holds persistent context files for 4 specialist research agents. Each agent maintains their own context, task queue, and iteration history across sessions.

---

## Agents

| Agent | Role | Primary Node | Context File |
|-------|------|--------------|--------------|
| Dr. Alpha | Model Research — architecture, training, features | Uranus (GPU) | `alpha_context.json` |
| Dr. Sigma | Strategy Research — signals, order flow, math strategies | Razer (GPU+CPU) | `sigma_context.json` |
| Dr. Theta | Execution Research — fill sim, TP/SL, Monte Carlo | Jupiter (CPU) | `theta_context.json` |
| Dr. Omega | Infrastructure — nodes, QCC, dispatch, alerts | All nodes | `omega_context.json` |

---

## Context File Schema

Each context file follows a common schema:

```json
{
  "name": "Dr. <Name>",
  "role": "<description>",
  "node_primary": "<node>",
  "node_secondary": "<node or array>",
  "context": {
    // Agent-specific state: best results, key findings, active experiments
  },
  "task_queue": [
    // Pending tasks, each with id, description, priority, status, created_at
  ],
  "completed_experiments": [
    // Finished experiments with results and timestamp
  ],
  "iteration_history": [
    // Timestamped log of what was run and what was learned
  ]
}
```

### Task Queue Entry Format

```json
{
  "id": "alpha_001",
  "description": "Fix E4 lazy window dataset and rerun Transformer experiment",
  "priority": "high",
  "status": "pending",
  "node": "uranus",
  "created_at": "2026-03-26T00:00:00Z",
  "started_at": null,
  "completed_at": null,
  "result": null
}
```

### Iteration History Entry Format

```json
{
  "timestamp": "2026-03-26T10:00:00Z",
  "experiment": "Wider CNN WF fold 74/167",
  "result": "IC=0.175 avg so far",
  "decision": "Continue — on track vs target IC=0.20",
  "next_step": "Wait for fold 100 checkpoint"
}
```

---

## How to Use

### Loading a Researcher Context

When spawning a researcher agent, load their context file and include it in the system prompt:

```javascript
const fs = require('fs');

function loadResearcher(name) {
  const path = `./qcc/researchers/${name}_context.json`;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

const alpha = loadResearcher('alpha');
// Include alpha.context, alpha.task_queue, alpha.iteration_history in agent prompt
```

### Updating a Researcher Context

After an agent completes work, write results back to disk:

```javascript
function saveResearcher(name, context) {
  const path = `./qcc/researchers/${name}_context.json`;
  fs.writeFileSync(path, JSON.stringify(context, null, 2));
}
```

### Queuing a Task

Add to `task_queue` with status `"pending"`. The orchestrator polls task queues and dispatches when the target node is available.

```javascript
alpha.task_queue.push({
  id: 'alpha_002',
  description: 'Test raw features direct to Transformer (no MLP compression)',
  priority: 'medium',
  status: 'pending',
  node: 'uranus',
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
  result: null
});
saveResearcher('alpha', alpha);
```

### Completing an Experiment

Move from `task_queue` to `completed_experiments`, update `iteration_history`, and update `context` with new findings:

```javascript
// Mark task complete
const task = alpha.task_queue.find(t => t.id === 'alpha_001');
task.status = 'completed';
task.completed_at = new Date().toISOString();
task.result = 'IC=0.185 — Transformer competitive, needs more tuning';

// Move to completed
alpha.completed_experiments.push(task);
alpha.task_queue = alpha.task_queue.filter(t => t.id !== 'alpha_001');

// Log to iteration history
alpha.iteration_history.push({
  timestamp: new Date().toISOString(),
  experiment: task.description,
  result: task.result,
  decision: 'Promising — queue follow-up with 60-day window',
  next_step: 'Add 60-day Transformer variant to task_queue'
});

// Update live context
alpha.context.key_findings.push('Transformer IC=0.185 with raw features — no MLP needed');

saveResearcher('alpha', alpha);
```

---

## Orchestrator Integration

The QCC orchestrator (`qcc/orchestrator.js`) can be extended to:

1. Poll each researcher's `task_queue` on a schedule
2. Check node availability via `qcc_node_status` before dispatch
3. SSH the job to the target node via `qcc_ssh_exec`
4. Write results back to the researcher context file when complete
5. Send Discord alerts on task completion or failure

Researcher context files are the single source of truth for agent state. Never store experiment state only in memory — always persist to the context file.

---

## Agent Specializations

### Dr. Alpha — Model Research
- Owns architecture decisions: CNN vs Transformer, feature sets, window sizes
- Runs on Uranus (RTX 5090) for GPU-heavy training; Neptune for overnight long runs
- Tracks IC metrics as primary quality signal
- Key constraint: num_workers=16 mandatory on Uranus; 3 epochs before overfitting

### Dr. Sigma — Strategy Research
- Owns math signal development: OFI, imbalance, delta, absorption
- Primary validation: local fill sim on Razer (fill_sim_cli + 110 MBO dates)
- All strategies must pass fill sim before being promoted to Theta for full validation
- Key constraint: all strategies tested negative so far in janky sim — fill sim is the truth

### Dr. Theta — Execution Research
- Owns TP/SL parameter space, position sizing, regime filters
- Primary tool: Jupiter fill sim (113 MBO dates, full validation suite)
- Monte Carlo pass required before any strategy goes live
- Key constraint: TP13/SL40 is only profitable baseline; per-card optimization still pending

### Dr. Omega — Infrastructure
- Owns node health, QCC daemon, job dispatch, data sync, dashboard
- No single primary node — monitors all
- Fixes must be non-disruptive to running training jobs
- Key constraint: Saturn SSH unreliable (Tailscale relay timeouts)
