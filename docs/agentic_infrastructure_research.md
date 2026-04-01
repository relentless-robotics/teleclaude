# Agentic AI Infrastructure Research
**Date:** 2026-03-26
**Purpose:** Evaluate external frameworks and protocols for applicability to the QCC-based quant research lab (4 specialist AI agents + Head of Quant orchestrator, distributed compute across Neptune/Uranus/Razer/Jupiter nodes).

---

## Executive Summary

Our custom QCC system is well-designed for our specific domain and we should NOT migrate to any external framework wholesale. However, several targeted concepts are worth adopting:

- **LangGraph's checkpointing/SQLite persistence model** directly maps to how we should handle agent state recovery — we already use SQLite in QCC, but agent-level crash-resume is missing.
- **OpenTelemetry GenAI semantic conventions** should be added as a thin instrumentation layer on top of QCC calls — token usage, tool latency, decision quality metrics.
- **A2A Agent Cards** are the right pattern for our 4 specialist agents to advertise their capabilities to the orchestrator — formalizing what each researcher can do.
- **AutoGen v0.4's swarm handoff pattern** (agents self-select next speaker) is directly applicable to our orchestrator design.
- **Governance: bounded autonomy with confidence thresholds** is missing from our current system and is a production risk.

---

## 1. AutoGen (Microsoft) v0.4

### What It Does

AutoGen is a multi-agent conversation framework. v0.4 (released January 2025) was a complete redesign to an async, event-driven actor model. Agents communicate via async message passing rather than sequential function calls. Three layers: **Core** (actor model, message bus), **AgentChat** (high-level task API), **Extensions** (third-party integrations).

Key patterns:
- **SelectorGroupChat**: orchestrator LLM dynamically chooses next speaker based on conversation context
- **Swarm pattern**: agents self-initiate handoffs by declaring what they need next — decentralized control
- **Nested chat**: hierarchical task decomposition where sub-conversations are spawned and resolved before returning
- **Handoffs object**: explicit typed transfers between agents with context serialization

AutoGen v0.4 reduced message latency 30% vs v0.2 and adds built-in OpenTelemetry integration (40% faster debugging per Microsoft's benchmarks).

**Strategic note (2026):** Microsoft has merged AutoGen and Semantic Kernel into **Microsoft Agent Framework** (released public preview Oct 2025, GA target Q1 2026). Both are now in maintenance mode. Agent Framework is the production path.

### Applicability to Our System

**High-value concepts to adopt:**

1. **Swarm handoff pattern** — Currently our orchestrator hard-codes which researcher gets each task. AutoGen's approach lets agents declare "I need the execution researcher to validate this" autonomously. This would reduce bottlenecks when the orchestrator has to decide everything.

2. **Selector pattern** — Rather than the Head of Quant running rigid if/else routing, an LLM-scored selector that reads the task description and picks the most relevant specialist is more robust as our agent roster grows.

3. **Async message bus** — Our current scheduler is synchronous (agent runs, returns, next agent runs). AutoGen's async model means agents can work in parallel and signal completion via events — relevant when, e.g., the model researcher and infrastructure researcher are doing independent work.

**Worth implementing or sufficient custom approach?**

Do not migrate to AutoGen. Our QCC system already provides the infrastructure (SQLite, SSH pool, Discord alerts) that AutoGen lacks for our domain. Adopt the **handoff typing pattern** and **async agent wake-up via QCC events** — these are implementable in 1-2 days without the framework.

---

## 2. LangGraph (LangChain)

### What It Does

LangGraph models agent workflows as directed graphs where each **node** is a function that reads and updates a shared state object, and **edges** define transitions (including conditional branching). The state is the single source of truth — every node receives it, mutates it, returns it.

Persistence tiers:
- `MemorySaver` — RAM only, no restart survival
- `SqliteSaver` — persists to SQLite, survives single-node restarts
- `PostgresSaver` — distributed state, multiple instances share state

Key capabilities:
- **Durable execution**: agent graph checkpoints state after every node; a crash mid-workflow resumes from the last checkpoint, not from zero
- **Human-in-the-loop**: graph can pause at a node and wait for external input before continuing
- **Time travel**: can replay execution from any prior checkpoint (audit trail)
- **Cross-machine nodes**: nodes can exist on different machines/runtimes with MCP providing context synchronization

LangGraph + MCP integration: when control transfers between nodes, the MCP context payload travels with the state. If a node fails, the graph redirects to a fallback node with full state restored.

### Applicability to Our System

**This is the most directly relevant framework for our problems.**

Our current failure mode: when a training job on Razer dies mid-experiment, the orchestrator has no graph-level checkpoint — it starts the research task over. LangGraph's SqliteSaver pattern would give us:

1. **Research task checkpointing** — Each stage of a research pipeline (define hypothesis → select card → launch sweep → collect results → write memo) becomes a node. A crash resumes from the last completed node. We already have `qcc.db` (SQLite); we can add a `research_graph_state` table with checkpoint serialization.

2. **Conditional routing based on sweep results** — If IC < threshold after fold 3, route to "abort and pivot" node rather than continuing. Currently this logic is implicit in agent prompts; making it explicit in graph edges is more reliable.

3. **Human-in-the-loop nodes** — When a researcher agent wants to deploy a model but confidence is marginal, pause the graph and DM the user for approval before continuing. Currently agents either always proceed or always ask — no middle ground.

**Worth implementing or sufficient custom approach?**

Do NOT import LangGraph as a dependency — it brings LangChain's full stack. Instead, **implement the core pattern natively**:
- Add `research_workflows` table to `qcc.db` with columns: `workflow_id`, `current_node`, `state_json`, `checkpoint_ts`, `status`
- Each research task becomes a state machine with explicit node transitions stored in SQLite
- This gives crash-resume without the framework overhead

This is a 2-3 day implementation that solves our most painful failure mode (lost research progress).

---

## 3. CrewAI

### What It Does

CrewAI is a role-based orchestration framework where agents have explicit roles (Manager, Worker, Researcher), goals, backstories, and tool sets. A "Crew" defines a team; a "Process" defines execution order (sequential, hierarchical, or hybrid).

Key mechanics:
- Each agent has `role`, `goal`, `backstory` in its definition — these are injected into every LLM call as system context
- `allow_delegation=True` gives agents automatic access to sub-delegate to other agents
- Manager agents (in hierarchical mode) receive the task, decompose it, assign sub-tasks, track completion
- Memory: short-term (within crew run), long-term (external DB), entity memory (tracks subjects across runs), contextual (relevance-weighted)

CrewAI is by design the framework most similar to our setup: we have a Head of Quant orchestrator and 4 specialists with defined roles.

### Applicability to Our System

**Moderate — the conceptual model matches but the implementation doesn't help us.**

What CrewAI gets right that we should formalize:
1. **Explicit role/goal definitions as system prompts** — Our agents currently have informal roles implied by their JS file names. CrewAI mandates that every agent has a written `role`, `goal`, and `backstory` that is injected into every LLM call. We should add this to our agent configs in QCC — e.g., `qcc_card_config` extended with `agent_role_prompt`.

2. **Long-term memory across crew runs** — CrewAI stores what agents learned in previous runs in an external DB. Our equivalent: the QCC `action_log` and memory files. But we don't auto-inject prior results into new researcher agent calls. Implementing a "prior results retrieval" step (search `qcc.db` for related sweep results before starting a new task) would give our agents CrewAI-style long-term memory.

3. **Task output contracts** — CrewAI requires each task to declare `expected_output` (a string description of what success looks like). Our research tasks have no formal output contract. Adding expected output schema to `qcc_research_create` would help quality control.

**Known weakness of CrewAI for our use case:** The high-level abstractions create opacity when failures occur — hard to diagnose why a task failed. Our custom QCC approach with explicit SQLite logging gives us better debuggability. The 30% efficiency gain claims are from general automation workflows, not quantitative research pipelines.

**Worth implementing or sufficient custom approach?**

Keep our custom approach. Adopt: (1) role/goal/backstory in agent system prompts, (2) prior results injection before task start, (3) expected output schema on research tasks.

---

## 4. Semantic Kernel (Microsoft)

### What It Does

Semantic Kernel is Microsoft's enterprise AI orchestration SDK (Python/.NET). Its core concept is **Plugins** — wrappers around functions/APIs that the AI can invoke with type-safe parameter schemas. A kernel holds a set of plugins; an AI planner decomposes a user goal into a sequence of plugin calls.

Key features:
- **Plugin system**: functions decorated with `@kernel_function` become AI-callable with auto-generated JSON schemas
- **Planners**: Sequential planner (generates a step list), Handlebars planner (generates a reusable template), Stepwise planner (ReAct-style, one step at a time)
- **Process Framework** (GA Q2 2026): deterministic workflow orchestration for business processes
- **Memory/RAG**: vector store connectors for semantic search over past outputs

**2026 status**: Semantic Kernel is entering maintenance mode as Microsoft transitions to Agent Framework (SK + AutoGen merger). New features are going to Agent Framework only.

### Applicability to Our System

**Low — we already have a superior domain-specific equivalent.**

Our QCC MCP server is architecturally identical to Semantic Kernel's plugin system: each `qcc_*` tool is a typed function with a JSON schema, callable by the AI. We have 40+ tools vs SK's plugin approach. The main difference is SK adds an LLM planner on top to auto-sequence tool calls.

The **Process Framework** concept (deterministic workflow orchestration) is the SK concept most worth watching — it directly addresses the "research pipeline as a state machine" problem. But it won't GA until Q2 2026 and is .NET/Python only.

**Specific feature worth noting:** SK's **Stepwise planner** (ReAct-style) is a good model for how the Head of Quant should decompose research tasks — think step by step, call one QCC tool, observe result, decide next step, rather than trying to plan the entire workflow upfront. We currently use an implicit ReAct loop but it could be more explicitly structured.

**Worth implementing or sufficient custom approach?**

Not worth adopting. Our QCC MCP approach already implements the plugin pattern and is more domain-specific. The merger into Agent Framework makes SK a dead end for new development.

---

## 5. MCP (Model Context Protocol)

### What It Does

MCP (released November 2024 by Anthropic, donated to the Agentic AI Foundation / Linux Foundation in December 2025) is now the de facto standard for AI-to-tool communication. As of early 2026: 10,000+ public servers, 97M+ monthly SDK downloads, adopted by OpenAI, Google, Microsoft, Cursor, VS Code.

Architecture:
- **MCP Server**: exposes tools, resources, and prompts via a standardized JSON-RPC protocol
- **MCP Client**: the AI (Claude) connects to servers and invokes tools
- **Resources**: static/dynamic data the AI can read (files, DB records, API responses)
- **Prompts**: reusable prompt templates stored server-side

The November 2025 spec added **multi-agent features**: an MCP server can itself act as an MCP client, enabling agent chains where Agent A calls Agent B's MCP server to delegate a subtask.

**MCP vs A2A distinction (important):**
- MCP = agent-to-tool communication (Claude → QCC tools, Claude → Discord tools)
- A2A = agent-to-agent communication (Head of Quant → Model Researcher agent as a peer service)

### Applicability to Our System

**We already use MCP correctly for tools. The new opportunity is MCP for agent-to-agent delegation.**

Current state: all 4 specialist researchers and the orchestrator run in the same Claude process (or separate Claude sessions). There is no formal protocol for the Head of Quant to spawn and communicate with a specialist researcher as a sub-agent with its own context.

**What to build:**

1. **Specialist agent MCP servers** — Each researcher (model_researcher, strategy_researcher, execution_researcher, infra_researcher) becomes its own MCP server exposing its specialized tools and knowledge. The orchestrator MCP client calls `model_researcher.analyze_card(card_id)` instead of doing everything inline.

2. **Agent Card resource** — Each specialist server exposes a `/agent-card` resource describing its capabilities, current workload, and expertise areas. The orchestrator reads these before routing.

3. **Async task delegation via MCP** — The spec supports long-running tools that return a task ID and poll for completion — directly applicable to "launch sweep on Razer and wait for results."

This would give us true multi-agent parallelism: the orchestrator fires off tasks to 2-3 specialist MCP servers simultaneously, each working on their own context, returning results independently.

**Effort:** Medium (2-4 days per specialist server). Start with the infrastructure researcher since its tools (node status, SSH exec, training launch) are already well-defined.

---

## 6. OpenTelemetry for AI (OTel GenAI)

### What It Does

OpenTelemetry's GenAI Semantic Conventions (GenAI SIG, in active development through 2026) define standardized attribute names for observing AI systems across three signal types:

**Spans (traces):**
- `gen_ai.operation.name` — what the model is doing (chat, embedding, etc.)
- `gen_ai.request.model` — model used
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` — token counts
- `gen_ai.request.temperature`, `gen_ai.response.finish_reason`
- Tool call spans: tool name, arguments, duration, success/failure

**Metrics:**
- Token usage per model, per agent, per session
- LLM call latency (p50/p95/p99)
- Tool call success rate
- Agent task completion rate

**Events (logs with structured context):**
- Model choice decisions
- Tool invocation records
- Agent handoff events

**Agent-specific conventions (finalized 2025, based on Google's AI agent white paper):**
- Agent session ID propagation across spans
- Parent span linking for sub-agent calls
- Framework instrumentation (CrewAI has baked-in OTel; AutoGen v0.4 has built-in OTel support)

**Tooling ecosystem:**
- **Langfuse**: open-source LLM observability, native OTel support, self-hostable
- **Traceloop/OpenLLMetry**: OTel SDK extension specifically for LLM calls, auto-instruments popular frameworks
- **Datadog**: maps GenAI OTel attributes to LLM Observability schema natively (latency, cost, model, finish reason)

### Applicability to Our System

**High-value, low-effort addition to QCC.**

We currently have no visibility into:
- How many tokens the Head of Quant uses per research cycle
- Which QCC tool calls are slowest (SSH exec? Model list query?)
- How often agent decisions lead to dead ends vs successful experiments
- Per-researcher cost attribution

**What to instrument:**

```javascript
// Add to qcc-server.js — wrap every tool handler
const { trace, metrics } = require('@opentelemetry/api');
const tracer = trace.getTracer('qcc-mcp', '1.0.0');

// In each tool handler:
const span = tracer.startSpan('qcc.tool_call', {
  attributes: {
    'gen_ai.operation.name': toolName,
    'qcc.node': nodeId,
    'qcc.job_id': jobId,
  }
});
// ... tool logic ...
span.setAttribute('qcc.result_status', 'success');
span.setAttribute('gen_ai.usage.output_tokens', tokenCount);
span.end();
```

**Recommended stack:**
- **Langfuse** (self-hosted on Neptune or Jupiter) for trace storage and dashboards — free, open-source, runs on Node.js/Python
- **OTel SDK** (`@opentelemetry/sdk-node`) added to QCC server — auto-exports spans
- Custom metric: `research_task.ic_score` tracked per researcher, per card — lets us see which researcher's suggestions have highest predictive value over time

**Decision quality metric** (novel, not in any framework): track `(research_suggestion → IC of resulting model)` correlation per researcher agent. This gives us empirical evidence of which agent is most valuable and where to invest prompt engineering effort.

**Effort:** Low (1-2 days). OTel is additive and non-breaking.

---

## 7. Agent Governance: Guardrails, Approvals, Escalation

### What Production Systems Do

The 2026 standard ("bounded autonomy") is a three-layer defense architecture:

**Layer 1 — Rule-based validators (sub-10ms)**
Deterministic checks: input format validation, blocklists, required fields. For us: "never SSH to Rithmic server," "never deploy card without `checkDeploymentReady` passing," "never allow Neptune >85% RAM."

**Layer 2 — ML classifiers (50-200ms)**
Context-aware: detect topic drift, confidence misalignment, out-of-scope requests. For us: "this research task is outside the model researcher's expertise domain — escalate to orchestrator."

**Layer 3 — LLM semantic validation (300-2000ms)**
Abstract policy checking: "does this proposed action align with current research priorities?" For us: "does deploying card 8L now make sense given the ongoing wider CNN sweep?"

**Risk routing pattern:**
- Low risk (IC/backtest check) → auto-proceed
- Medium risk (launch new sweep) → log decision, proceed
- High risk (deploy to paper trading, modify card config) → pause, DM user, wait for approval before continuing

**Escalation triggers used in production:**
- Agent confidence score < threshold (stop and escalate)
- Action would affect live trading state
- Resource usage would exceed node limits
- Task age > timeout without progress

**Audit trail requirements (EU AI Act 2025, financial regulations):**
Immutable log of each tool call + rationale + outcome. Our `qcc.db action_log` table partially covers this but rationale (the agent's reasoning) is not currently stored.

### Applicability to Our System

**This is our biggest gap and a production risk.**

Current system has hard-coded rules (NEVER connect to Rithmic) but no dynamic governance layer. Three specific implementations needed:

1. **Confidence gating on research tasks** — Before a researcher agent calls `qcc_launch_training`, it must produce a confidence score (0-100) for the hypothesis. Score < 60 → auto-abort and log reasoning. Score 60-80 → launch but flag as low-confidence. Score > 80 → proceed normally. Store confidence scores in `qcc.db` alongside research tasks.

2. **Pre-deployment approval workflow** — When any agent calls `qcc_deploy_model` or modifies paper trading state, the action is queued, a Discord DM is sent with the proposed action + rationale, and execution waits for user `/approve <id>` or `/deny <id>`. Timeout after 30 minutes → auto-deny. This is a 1-day implementation.

3. **Rationale logging** — Extend `qcc_research_update` to require a `rationale` field. Store the agent's reasoning alongside every state transition. This creates the audit trail and also enables the "decision quality" metric from the OTel section.

4. **Circuit breaker on node failures** — If `qcc_ssh_exec` to a node fails 3 times in 10 minutes, mark node as unreachable in `qcc.db` and prevent any new tasks from being assigned to it until manual reset. Currently the orchestrator may keep retrying a dead node indefinitely.

---

## 8. A2A (Agent-to-Agent Protocol) — Google

### What It Does

A2A was released by Google in April 2025, donated to Linux Foundation in June 2025. Current version: 0.3 (with gRPC support, signed Agent Cards, extended Python SDK). 150+ organizations contributing.

Core concepts:
- **Agent Card** (JSON metadata file served at `/.well-known/agent.json`): describes agent capabilities, supported input/output types, authentication requirements, cost/latency estimates
- **Task lifecycle**: submitted → working → input-required → completed/failed — with unique task IDs for tracking long-running jobs
- **Transport**: HTTP/JSON-RPC (v0.1-0.2) + gRPC (v0.3+)
- **Authentication**: signed Agent Cards (v0.3), JWT-based
- **No shared memory**: agents are opaque services — they do not share internal state, tools, or model context directly

**A2A vs MCP (critical distinction):**
- MCP: agent ↔ tool (Claude calls a database, file system, API)
- A2A: agent ↔ agent (Claude-orchestrator calls Model-Researcher-Claude as a peer service)

A2A complements MCP: an agent uses MCP to call its tools, and A2A to call other agents.

### Applicability to Our System

**Relevant as architecture pattern, premature to implement as protocol.**

A2A's Agent Card pattern is exactly right for our researcher design. Each specialist should have a machine-readable description of:
- What research areas they cover
- What QCC tools they're authorized to use
- Current task capacity (idle/busy/at-limit)
- Expected response time for different task types

However, the formal A2A protocol (HTTP endpoints, signed cards, gRPC) is overkill for our setup where all agents run in the same datacenter and communicate through QCC's SQLite DB. The overhead of full A2A is not justified until we have agents running as independent services on separate infrastructure.

**What to adopt now:**

1. **Agent Card concept** — Create `trading_agents/agent_cards/` directory with JSON files defining each researcher's role, tools, expertise, and constraints. The orchestrator reads these before routing. Not A2A-compliant but uses the same conceptual model.

2. **Task lifecycle states** — Adopt A2A's task state model (submitted/working/input-required/completed/failed) in `qcc.db`'s `research_tasks` table. This is better than our current binary (pending/done) model.

3. **Watch A2A v1.0** — When the protocol stabilizes (likely late 2026), it will be the standard for deploying our specialist agents as independent services. Plan the architecture now so the migration is straightforward.

---

## Synthesis: Priority Implementation Roadmap

Ranked by impact vs effort ratio for our specific system:

### Tier 1 — High Impact, Low Effort (do within 1 sprint)

| Item | Source | Effort | Impact |
|------|---------|--------|--------|
| OTel instrumentation on QCC tools | OTel GenAI | 1-2 days | Token cost visibility, latency profiling |
| Confidence scoring on research tasks | Governance | 1 day | Prevents low-quality experiments from launching |
| Pre-deployment approval DM workflow | Governance | 1 day | Eliminates unauthorized paper trading changes |
| Task lifecycle states in qcc.db | A2A / LangGraph | 0.5 days | Better research pipeline visibility |
| Rationale logging in research_update | Governance | 0.5 days | Audit trail, decision quality tracking |
| Circuit breaker on node SSH failures | Governance | 1 day | Prevents wasted retries on dead nodes |

### Tier 2 — High Impact, Medium Effort (next 2-4 weeks)

| Item | Source | Effort | Impact |
|------|---------|--------|--------|
| Research workflow state machine in SQLite | LangGraph pattern | 2-3 days | Crash-resume for research pipelines |
| Agent Cards JSON for each specialist | A2A pattern | 1 day | Formal capability registry, better routing |
| Prior results injection before task start | CrewAI pattern | 1-2 days | Agents learn from past experiments |
| Swarm handoff pattern in orchestrator | AutoGen v0.4 | 1-2 days | Reduces orchestrator bottleneck |

### Tier 3 — Medium Impact, Higher Effort (future)

| Item | Source | Effort | Impact |
|------|---------|--------|--------|
| Specialist MCP servers per researcher | MCP multi-agent | 2-4 days each | True parallel multi-agent execution |
| Langfuse self-hosted observability | OTel ecosystem | 1 day setup | Full trace/metric dashboard |
| ML confidence classifier (Layer 2 governance) | Governance | 1 week | Smarter escalation decisions |
| Full A2A protocol implementation | A2A | Future | Cross-system agent interop |

### What NOT to Do

- Do not migrate to AutoGen, LangGraph, CrewAI, or Semantic Kernel wholesale. Our custom QCC system is more domain-specific and has better observability than any of these frameworks provide out of the box.
- Do not adopt Microsoft Agent Framework yet — it only reached GA Q1 2026 and has limited community production validation.
- Do not implement full A2A protocol now — the overhead isn't justified for intra-datacenter communication.

---

## Framework Comparison Table

| Framework | State Persistence | Multi-Agent | Observability | Production Maturity | Our Verdict |
|-----------|-------------------|-------------|---------------|--------------------|-|
| AutoGen v0.4 | Actor messages (in-memory) | Yes, async event-driven | Built-in OTel | High (Microsoft) | Steal: swarm handoff pattern |
| LangGraph | Excellent (SQLite/Postgres) | Yes, graph nodes | Moderate | High (LangChain) | Steal: state machine + checkpoint pattern |
| CrewAI | Limited | Yes, role-based | Low (opaque) | Medium | Steal: role definitions, long-term memory injection |
| Semantic Kernel | Moderate | Via Agent Framework | Moderate | High but deprecated | Skip — use MCP instead |
| MCP | N/A (protocol) | Emerging (agent servers) | N/A | Very High (industry std) | Extend: add specialist agent MCP servers |
| OTel GenAI | N/A (observability) | Trace propagation | Excellent | High (CNCF standard) | Implement: wrap QCC tool calls |
| A2A | Per-task | Yes, service-oriented | Via OTel | Medium (v0.3) | Steal: Agent Card + task lifecycle concepts |
| Agent Framework (MS) | Session-based | Yes, graph + swarm | Via OTel | New/GA Q1 2026 | Monitor — not ready yet |

---

*Research compiled from: [AutoGen v0.4 blog](https://www.microsoft.com/en-us/research/blog/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/), [LangGraph docs](https://www.langchain.com/langgraph), [CrewAI docs](https://docs.crewai.com/en/concepts/collaboration), [A2A protocol](https://a2a-protocol.org/latest/), [OTel AI observability](https://opentelemetry.io/blog/2025/ai-agent-observability/), [Governance guide](https://authoritypartners.com/insights/ai-agent-guardrails-production-guide-for-2026/), [MCP Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol), [Microsoft Agent Framework](https://cloudsummit.eu/blog/microsoft-agent-framework-production-ready-convergence-autogen-semantic-kernel)*
