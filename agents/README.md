# Multi-Agent System Architecture

## Overview

This system allows multiple AI agents to run on the R630XL server, each handling specific domains, all reporting to the main orchestrator (Claude Opus running on the main PC).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MAIN PC (Windows)                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │              ORCHESTRATOR (Opus)                 │   │
│  │  - User interface (Discord)                     │   │
│  │  - High-level decisions                         │   │
│  │  - Memory guardian                              │   │
│  │  - Agent task assignment                        │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                    Tailscale VPN
                          │
┌─────────────────────────────────────────────────────────┐
│               R630XL SERVER (Ubuntu)                     │
│                                                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │   TRADING   │ │   BOUNTY    │ │  SECURITY   │       │
│  │    AGENT    │ │    AGENT    │ │    AGENT    │       │
│  │             │ │             │ │             │       │
│  │ Cursor CLI  │ │ Cursor CLI  │ │ Cursor CLI  │       │
│  │ AUTO (FREE) │ │ AUTO (FREE) │ │ AUTO (FREE) │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│         │               │               │               │
│         └───────────────┼───────────────┘               │
│                         │                               │
│              ┌──────────▼──────────┐                   │
│              │    MESSAGE QUEUE    │                   │
│              │  (Redis/File-based) │                   │
│              └─────────────────────┘                   │
│                         │                               │
│              ┌──────────▼──────────┐                   │
│              │   SHARED STORAGE    │                   │
│              │  - Task results     │                   │
│              │  - Agent states     │                   │
│              │  - Logs             │                   │
│              └─────────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

## Agents

### 1. Trading Agent
**Model:** Cursor CLI AUTO (FREE)
**Purpose:** Autonomous management of Alpaca paper trading account
**Responsibilities:**
- Check positions every hour during market hours
- Execute predefined trading strategies
- Alert on significant P/L moves
- Daily market scans for opportunities
- Stop loss / take profit automation

**Files:**
- `agents/trading/agent.py` - Main agent loop
- `agents/trading/INSTRUCTIONS.md` - Agent-specific instructions
- `agents/trading/config.json` - Trading parameters

### 2. Bounty Agent
**Model:** Cursor CLI AUTO (FREE)
**Purpose:** Monitor and work on code bounties
**Responsibilities:**
- Check PR status on existing submissions
- Scan Algora for new opportunities
- Work on bounty tasks (code, tests, docs)
- Report progress to orchestrator

**Files:**
- `agents/bounty/agent.py` - Main agent loop
- `agents/bounty/INSTRUCTIONS.md` - Agent-specific instructions
- `agents/bounty/active_bounties.json` - Current work

### 3. Security Agent
**Model:** Cursor CLI AUTO (FREE)
**Purpose:** Security monitoring and alerting
**Responsibilities:**
- Monitor system logs
- Run periodic security scans
- Alert on anomalies
- Check for vulnerabilities in dependencies

**Files:**
- `agents/security/agent.py` - Main agent loop
- `agents/security/INSTRUCTIONS.md` - Agent-specific instructions

### 4. Compute Worker
**Model:** Cursor CLI AUTO (FREE)
**Purpose:** Heavy computation tasks
**Responsibilities:**
- ML training jobs
- Data processing
- Batch operations

## Message Queue Protocol

### Task Format
```json
{
  "id": "task_uuid",
  "type": "trading|bounty|security|compute",
  "priority": "high|medium|low",
  "from": "orchestrator",
  "to": "trading_agent",
  "action": "check_positions",
  "params": {},
  "created_at": "2026-02-04T...",
  "deadline": null
}
```

### Result Format
```json
{
  "task_id": "task_uuid",
  "agent": "trading_agent",
  "status": "completed|failed|pending",
  "result": {},
  "alerts": [],
  "created_at": "2026-02-04T..."
}
```

### Alert Format
```json
{
  "id": "alert_uuid",
  "agent": "trading_agent",
  "severity": "critical|warning|info",
  "message": "SMCI down 8% - approaching stop loss",
  "data": {},
  "requires_action": true,
  "created_at": "2026-02-04T..."
}
```

## Cost Management

### Model Selection
**ALL worker agents use Cursor CLI AUTO (FREE with Cursor Pro subscription)**

Only the orchestrator (Opus on main PC) uses paid Claude API credits.

| Component | Model | Cost |
|-----------|-------|------|
| Orchestrator | Claude Opus | ~$15/M tokens (paid) |
| Trading Agent | Cursor AUTO | FREE |
| Bounty Agent | Cursor AUTO | FREE |
| Security Agent | Cursor AUTO | FREE |
| Compute Worker | Cursor AUTO | FREE |

### Daily Budget
- **Worker Agents:** $0/day (all FREE via Cursor Pro)
- **Orchestrator:** ~$2-5/day depending on usage
- **Total System Cost:** Just the orchestrator + Cursor Pro subscription

## Setup Instructions

### On R630XL Server:

1. Install dependencies:
```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Cursor CLI (REQUIRED for FREE agents)
# Download from: https://cursor.sh/
# Or use AppImage for Linux

# Verify Cursor CLI works
cursor --version
```

2. Clone teleclaude repo:
```bash
git clone https://github.com/relentless-robotics/teleclaude.git
cd teleclaude
npm install
```

3. Configure Cursor auth:
```bash
# Login to Cursor (needs Pro subscription for unlimited AUTO)
cursor auth login
```

4. Start agents:
```bash
# Trading agent (uses Cursor CLI AUTO - FREE!)
cd agents/trading && node launch.js

# Or via tmux (persistent)
tmux new-session -d -s trading 'cd teleclaude/agents/trading && node launch.js'
tmux new-session -d -s bounty 'cd teleclaude/agents/bounty && node launch.js'
tmux new-session -d -s security 'cd teleclaude/agents/security && node launch.js'
```

5. Verify agents running:
```bash
node agents/core/cursor_agent.js list
```

## Communication

### From Orchestrator to Agents:
- Write task to `shared/tasks/{agent_name}/pending/*.json`
- Or send via Redis pub/sub

### From Agents to Orchestrator:
- Write result to `shared/results/*.json`
- Critical alerts write to `shared/alerts/*.json`
- Orchestrator polls these directories

### Alert Escalation:
1. Agent detects issue
2. Writes to alerts directory
3. Orchestrator sees alert
4. Sends to Discord/Telegram
5. User (or orchestrator) responds

## Monitoring

### Health Checks
Each agent writes heartbeat to `shared/heartbeats/{agent_name}.json`:
```json
{
  "agent": "trading_agent",
  "status": "running",
  "last_task": "2026-02-04T...",
  "uptime_seconds": 3600,
  "tasks_completed": 24
}
```

### Log Aggregation
All agent logs go to `shared/logs/{agent_name}/{date}.log`

## Future Expansion

- **DevOps Agent** - Manage deployments, CI/CD
- **Research Agent** - Web research, documentation
- **Social Agent** - Social media monitoring
- **Customer Agent** - Handle inquiries (if selling products)
