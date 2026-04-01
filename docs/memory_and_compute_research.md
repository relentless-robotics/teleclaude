# AI Memory & Background Compute — Research Findings
> Researched: 2026-03-26
> Purpose: Evaluate tools to fix context loss on restart, researcher memory, and result organization for the quant hedge fund research lab (4 researcher agents, QCC central DB, distributed compute).

---

## Our Current Problems (Explicit)

1. **Context loss on restart** — JSON files + SQLite don't survive conversation compactions well. Researchers lose track of experiment lineage.
2. **Researcher memory fragmentation** — Each agent restart = blank slate. No knowledge of prior decisions or failed paths.
3. **Result organization** — Experiment results, IC scores, sweep outcomes are scattered across files with no structured retrieval.
4. **Memory staleness** — No automated detection of when stored facts (node IPs, job IDs, model paths) are outdated.
5. **Idle compute wasted** — Between experiments, GPU nodes sit idle without doing anything useful.
6. **Security/memory manager agents broken** — Likely die on restart because they have no persistent state.

---

## 1. Mem0 — Persistent Memory Layer

### What It Does
Mem0 is a self-improving memory layer that sits between your application and the LLM. Instead of storing full conversation transcripts, it extracts salient facts, user preferences, and context using an LLM, embeds them as vectors, and retrieves only relevant memories per query. Memory is scoped to user, session, or agent — all independently queryable.

- Extracts facts automatically from conversations (no manual curation)
- Reduces token usage ~90% vs full-context approaches
- 26% improvement in LLM-as-a-Judge accuracy vs OpenAI baseline
- 91% lower p95 latency than full-context retrieval
- Supports 16+ LLM providers (Anthropic, OpenAI, Ollama) and 24+ vector databases

**Installation:** `pip install mem0ai` / `npm install mem0ai`

**Core API (Python):**
```python
from mem0 import Memory
m = Memory()

# Store — triggered after any conversation turn
m.add(messages, user_id="swing_scanner")

# Retrieve — before generating any response
results = m.search(query="what IC scores did wider CNN achieve", user_id="swing_scanner", limit=5)
```

**Memory scopes:**
- `user_id` — persists across ALL sessions for a researcher agent
- `session_id` — within a single conversation
- `agent_id` — knowledge specific to one agent type (e.g., the after-hours agent)

### How It Solves Our Problems
- **Context loss on restart**: Each researcher agent gets a `user_id`. On restart, first call is `m.search("current tasks + active experiments")` — facts survive compaction.
- **Researcher memory**: After each fold completes, `m.add([{"role": "assistant", "content": "Fold 5 IC=0.178, wider CNN, saved to /path"}], user_id="neptune_researcher")` — that result is permanently indexed.
- **Broken security/memory manager agents**: Give them their own `agent_id`. On wake, they recall their last known state in one call.

### Implementation for Our Setup
Map our 4 researcher agents to Mem0 user/agent scopes:

```
user_id: "neptune_researcher"     # wider CNN, full-data training
user_id: "uranus_researcher"      # deeper CNN + features
user_id: "razer_researcher"       # ablation, light work
user_id: "jupiter_researcher"     # fill sim, sweeps
agent_id: "security_sentinel"
agent_id: "memory_manager"
```

Self-hosted option uses your existing vector DB (Qdrant, Chroma, Pinecone, or SQLite for dev). The open-source stack (Apache 2.0) can run entirely on Neptune with local Ollama for LLM extraction — no API cost.

### Complexity: LOW — Quick Win
- Install in 10 minutes
- Drop-in: wrap agent startup with `recall()` and agent completion with `m.add()`
- No infrastructure changes needed
- The JSON + SQLite files can be the initial seed to populate Mem0 on first run

### Verdict: STRONG FIT — implement first.

---

## 2. Zep — Temporal Knowledge Graph Memory

### What It Does
Zep uses a **Temporal Knowledge Graph** (via its Graphiti engine) rather than flat vector embeddings. Every fact is stored with `valid_at` and `invalid_at` timestamps. When a fact changes (e.g., Jupiter's IP changes, a model is superseded), the old fact is invalidated and the new one takes precedence — the history is preserved but queries return the current truth.

- Context retrieved in <200ms P95
- 18.5% aggregate accuracy improvement on LongMemEval vs baselines
- 98% token reduction, 90% latency reduction vs full-context
- Automatically extracts entities, relationships, and facts from conversations
- Custom graph ontologies via Pydantic — you define domain-specific entity types

**Critical downside:** Memory footprint exceeds 600,000 tokens per conversation (vs 1,764 for Mem0). Immediate post-ingestion retrieval fails — correct answers only appear hours later after background graph processing. Not suitable for fast-feedback loops.

### How It Solves Our Problems
- **Memory staleness detection**: This is Zep's killer feature for us. When Neptune's IP changes or a model is deprecated, the old fact is `invalid_at=now`. No more stale IPs in MEMORY.md.
- **Result lineage**: Models, fold results, and experiment decisions form a knowledge graph. You can ask "what happened to all wider CNN experiments" and traverse the graph.
- **Temporal queries**: "What was the IC score for card 3 last Tuesday?" is a native query type.

### Implementation for Our Setup
Define custom ontology:
```python
class ComputeNode(BaseModel):
    name: str          # "Neptune", "Uranus"
    ip: str
    gpu: str
    status: str

class TrainingRun(BaseModel):
    card_id: str
    fold: int
    ic_score: float
    node: str
    timestamp: datetime
```

Feed QCC events into Zep as they happen. The graph builds over weeks, becoming queryable research history.

### Complexity: MEDIUM — 1-2 days of work
- Requires Zep server running (Docker: `docker run getzep/zep`)
- Schema design for our domain entities takes thought
- The delayed ingestion problem means it CANNOT replace short-term memory — needs Mem0 alongside it

### Verdict: COMPLEMENTARY to Mem0 — use for long-term fact tracking, IP/config versioning, experiment lineage. Not for fast session recall.

---

## 3. Cognee — Knowledge Graph for Research Findings

### What It Does
Cognee is an open-source knowledge engine that ingests documents (PDFs, markdown, JSON, plain text) and builds a combined vector + graph knowledge structure from them. It uses a 6-stage pipeline: classify → permissions → chunk → LLM entity/relationship extraction → summarize → embed + graph commit.

- 14 retrieval modes from classic RAG to chain-of-thought graph traversal
- Supports Neo4j, SQLite, and other graph/vector backends
- MCP integration available (connects to Claude directly)
- ~1M pipelines/month in production, used by 70+ companies
- Apache 2.0 open source, `pip install cognee`

**Core API:**
```python
import cognee

await cognee.add("IC results: wider CNN fold 5 = 0.178, fold 6 = 0.195...")
await cognee.cognify()   # builds graph
results = await cognee.search("what are the best IC scores for wider CNN")
```

### How It Solves Our Problems
- **Result organization**: Ingest all experiment result files, sweep outputs, and session logs. Cognee builds a queryable knowledge graph. "Which card configurations produced IC > 0.15?" becomes a graph traversal query.
- **Research continuity**: Feed in all past markdown files (project_*.md, session logs) and researchers can semantically query the full research history.
- **MCP integration**: Cognee exposes an MCP server — Claude can call `cognee.search()` as a tool call directly, without any wrapper code.

### Implementation for Our Setup
1. Set up Cognee server (Docker or local)
2. Ingest existing memory files: all `project_*.md`, `feedback_*.md`, session logs, sweep outputs, IC result files
3. Run `cognify()` on a schedule (nightly) as new results come in
4. Claude calls `cognee.search()` as MCP tool for research context

Good fit for: organized retrieval of experiment results, finding past decisions, avoiding repeated failed experiments.

### Complexity: LOW-MEDIUM
- Install + first ingest: ~2 hours
- MCP integration: ~1 hour if Cognee MCP server works out of box
- Nightly re-ingestion: simple cron job

### Verdict: STRONG FIT for result organization and research history retrieval. Complementary to Mem0 (Mem0 for agent session memory, Cognee for document/result corpus).

---

## 4. Tiered / Hierarchical Memory — Production Patterns

### What It Is
The standard architecture used in production agent systems. Three tiers:

| Tier | Storage | Lifetime | Use Case |
|------|---------|----------|----------|
| **In-context (L1)** | LLM context window | Current conversation | Active task, current experiment |
| **Session (L2)** | Redis / fast KV store | Hours-days | Cross-turn recall within a work session |
| **Long-term (L3)** | Vector DB + graph DB | Permanent | All-time facts, results, decisions |

Key production patterns from Redis, AWS AgentCore, and research papers:

1. **Asynchronous extraction**: Never extract memories synchronously during response generation. Queue extraction for background processing. L3 updates happen async — L1/L2 serve immediately.
2. **Entity-based profiles**: Don't store raw messages. Extract structured profiles: `{node: "Neptune", current_task: "wider CNN WF fold 7", last_seen: timestamp}`.
3. **Hybrid retrieval**: Combine vector similarity (semantic) + BM25 keyword (exact token) + recency weighting. We already do this with `memory_search.js` (BM25) + semantic `recall()` — this is the right pattern.
4. **Write-through caching**: On every QCC event, write to L2 (Redis/fast store) immediately. Batch flush to L3 (vector DB) every N minutes.
5. **Conversation summarization with entity extraction**: Instead of storing full logs, maintain a structured `agent_state` object: goals, entities seen, recent tool outputs, open decisions.

### How We Implement This Now (minimal changes)

We already have the right structure. The gaps are:

- **L2 is missing**: We go directly from in-context → JSON files. Add Redis (or even a simple in-memory Node.js Map with TTL) as L2. Session data survives restarts within the same day.
- **Async extraction**: Our `remember()` calls block. Wrap them in `setImmediate()` or a background queue so agent responses don't wait on memory writes.
- **Entity profiles**: Replace free-text memories with structured objects: `{type: "training_run", card: "C3", fold: 5, ic: 0.178, node: "neptune", ts: ...}` — these are directly queryable.

### Complexity: LOW for incremental improvement
Redis can be added in 30 minutes. The bigger win is the structural discipline of entity-based profiles over free-text memories.

### Verdict: FOUNDATIONAL PATTERN — not a tool to install but a design discipline to apply. Implement entity-based profiles in QCC's SQLite and add Redis L2 caching.

---

## 5. Virtual Context Management — MemGPT / Letta

### What It Does
MemGPT (now Letta) treats the LLM like an OS: the context window is "RAM" and external storage is "disk." The agent itself decides what to page in/out of context via function calls. Memory is organized into named **memory blocks** that are always in-context:

- `core_memory.human` — facts about the user
- `core_memory.persona` — agent identity and behavioral guidelines
- `archival_memory` — external storage paged on demand
- `recall_memory` — recent conversation history, compressed

Letta's 2026 update: **git-backed memory blocks** — memory is version-controlled. You can roll back to "what the agent knew on March 20th." Skills and subagents are first-class.

**Sleep-Time Compute in Letta** (dual-agent architecture):
- Primary agent: handles user conversation, never touches core memory directly
- Sleep-time agent: runs asynchronously, reorganizes primary agent's memory blocks, consolidates learnings
- Result: cleaner memories, no in-conversation overhead for memory management

### How It Solves Our Problems
- **Context loss**: Memory blocks are persistent in a database. On restart, blocks reload — agent is exactly where it left off.
- **Broken agents (security_sentinel, memory_manager)**: Give each agent its own Letta-managed memory blocks. They survive restarts natively.
- **Research continuity**: The sleep-time agent can run nightly on each researcher agent, consolidating the day's experiment logs into clean memory blocks.

### Our Specific Use Case
```
neptune_researcher memory blocks:
  - current_experiment: "wider CNN WF fold 7, running since 2026-03-25"
  - recent_results: "fold 5=0.178, fold 6=0.195, both clean"
  - known_issues: "checkpoint resume broken — never use warm-start"
  - node_config: "Neptune RTX 3090, C:\Users\Footb\Lvl3Quant"
```

These blocks reload verbatim on every restart. No re-inference needed.

### Complexity: MEDIUM-HIGH
- Letta requires running a server (Docker available)
- Agent definitions need migration to Letta's block-based system
- High payoff: the broken security/memory manager agents are likely just a state persistence problem that Letta solves natively

### Verdict: BEST FIT for fixing broken agents and the restart context loss problem. Higher setup cost but cleanest solution. Consider for phase 2 after Mem0 quick wins.

---

## 6. Sleep-Time Compute

### What It Is
During idle periods (when no user is actively prompting), an agent performs background cognitive work:

- **Memory consolidation**: Reorganize and compress stored memories
- **Pre-computation**: Anticipate likely next queries and pre-compute answers
- **Planning**: Analyze available data and draft next experiment plans
- **Result digestion**: Process sweep outputs and flag anomalies

**From the April 2025 paper (arxiv 2504.13171):**
- 5x reduction in test-time compute for equivalent accuracy
- 13-18% accuracy improvement when offline compute is scaled
- 2.5x cost reduction per query (amortized offline compute)
- Works best when queries are predictable from context (which ours are — "analyze results, plan next run")

**Letta's implementation**: A dedicated sleep-time agent runs asynchronously against the primary agent's memory blocks. It reads, reorganizes, and writes back consolidated state.

### How We Use It Right Now (Immediate)
We already have a scheduler (`trading_agents/scheduler.js`). We can add sleep-time tasks:

```javascript
// In scheduler.js — runs when market is closed + no active training
async function sleepTimeCompute() {
  // 1. Summarize today's session log into memory
  const log = await readTodaysSessionLog();
  await sharedBrain.remember(`Session summary: ${summarize(log)}`, 'DAILY', ['session']);

  // 2. Check QCC for completed jobs, extract IC scores, flag issues
  const jobs = await qcc.getCompletedJobs();
  await indexResultsToMem0(jobs);

  // 3. Draft next experiment recommendations based on research queue
  const queue = await qcc.getResearchQueue();
  const nextSteps = await llm.reason(`Given these results: ${jobs}, what should run next?`);
  await sharedBrain.remember(nextSteps, 'DAILY', ['planning']);
}
```

This runs on Neptune (already on, already has the codebase) during off-hours. Zero new infrastructure.

### For Training Nodes (Razer idle example)
When Razer has no active training job, it can:
1. Run fill simulation analysis on completed model outputs
2. Pre-compute feature correlations for upcoming experiments
3. Scan for checkpoints that need cleanup
4. Verify data integrity on upcoming training sets

### Complexity: LOW — can start tomorrow
The scheduler infrastructure exists. Sleep-time tasks are just scheduled jobs that run when idle. Start with memory consolidation (30 min to implement), add pre-computation over time.

### Verdict: HIGH VALUE, LOW COST — this is the biggest bang-for-buck item on the list. Our scheduler already handles this pattern.

---

## 7. Temporal Memory Hierarchy (TiMem Pattern)

### What It Is
TiMem (arxiv 2601.02845) organizes memory as a 5-level temporal tree:
```
L1: Segments    — individual exchanges (online, immediate)
L2: Sessions    — conversation sessions (consolidate on session end)
L3: Daily       — day-level summaries (consolidate at midnight)
L4: Weekly      — week-level behavioral patterns
L5: Profile     — permanent persona/preferences/values
```

Key mechanisms:
- **Recency bias**: Fresher memories rank higher within each level
- **Hierarchical abstraction**: Lower levels = concrete details, higher = patterns
- **Scheduled consolidation**: Automatic LLM-summarization at temporal boundaries
- **No explicit decay functions**: Compression through hierarchical abstraction naturally buries old details

Separate work on **MemoriesDB** (arxiv 2511.06179) models memory as temporal-semantic surfaces in a graph, enabling queries like "what did the agent believe about X between dates A and B?"

### How We Implement This

Map to our session logger pattern (which already exists in `utils/session_logger.js`):

```
L1 = individual tool calls (already logged to sessions/YYYY-MM-DD.md)
L2 = session boundary consolidation (add to session_logger.logSessionEnd)
L3 = daily consolidation (nightly sleep-time job: summarize day's log → MEMORY.md)
L4 = weekly review (Sunday night: summarize week's sessions → project_*.md update)
L5 = permanent feedback files (feedback_*.md = already our L5)
```

The consolidation at each level uses an LLM call to summarize. Cost: negligible (Haiku-tier). Benefit: MEMORY.md stays current automatically, old sessions get compressed, researchers always have fresh context.

**Staleness detection** (solves MEMORY.md staleness markers problem):
Tag each memory with `last_verified: timestamp`. On session start, flag any L3+ memories where `last_verified > 24h AND source = active_compute`. The QCC daemon can push verified timestamps when it confirms node status.

### Complexity: LOW — extends existing infrastructure
We already have `session_logger.js`, `MEMORY.md`, and the feedback file system. This is a discipline + automation layer on top. The main addition is:
1. Nightly consolidation job (1 cron entry + ~50 lines of code)
2. `last_verified` timestamps on all memory entries
3. L4 weekly roll-up (optional, add later)

### Verdict: NATURAL EVOLUTION of our current system. Implement the nightly L3 consolidation first — highest impact.

---

## Summary: Recommended Implementation Roadmap

### Phase 1 — Quick Wins (This Week)

| Item | What | Time | Impact |
|------|------|------|--------|
| **Sleep-time consolidation** | Add nightly job in scheduler.js to summarize session logs → MEMORY.md | 2-3 hours | High — context survives restarts |
| **Mem0 for researcher agents** | pip install mem0ai, wrap agent startup/shutdown with recall/add | 4-6 hours | High — researchers remember across restarts |
| **Entity-based profiles in QCC** | Change free-text memories to structured JSON objects in SQLite | 2-3 hours | Medium — faster retrieval, less ambiguity |

### Phase 2 — Solid Foundation (Next 2 Weeks)

| Item | What | Time | Impact |
|------|------|------|--------|
| **Cognee for result corpus** | Ingest all project_*.md + sweep outputs, MCP tool for Claude | 1 day | High — query full research history |
| **TiMem consolidation schedule** | Daily L3 + Weekly L4 LLM summarization jobs | 1 day | High — MEMORY.md stays fresh automatically |
| **Redis L2 cache** | Fast session state that survives within-day restarts | 4 hours | Medium — no more re-loading context mid-day |

### Phase 3 — Full Architecture (Month 2)

| Item | What | Time | Impact |
|------|------|------|--------|
| **Letta for persistent agents** | Migrate security_sentinel + memory_manager to Letta memory blocks | 3-5 days | High — fixes broken agents permanently |
| **Zep for experiment lineage** | Temporal knowledge graph for IP/config/model versioning | 2-3 days | Medium — solves staleness tracking |
| **Sleep-time pre-computation** | Razer pre-computes fill sims, feature correlations during idle | 2 days | Medium — better GPU utilization |

---

## Tools and Libraries Summary

| Tool | License | Language | Stars (approx) | Self-hosted |
|------|---------|----------|-----------------|-------------|
| [Mem0](https://github.com/mem0ai/mem0) | Apache 2.0 | Python/JS | ~25k | Yes |
| [Zep / Graphiti](https://github.com/getzep/graphiti) | Apache 2.0 | Python | ~4k | Yes (Docker) |
| [Cognee](https://github.com/topoteretes/cognee) | Apache 2.0 | Python | ~3k | Yes |
| [Letta](https://github.com/letta-ai/letta) | Apache 2.0 | Python | ~14k | Yes (Docker) |
| TiMem | Research | Python | N/A | Implement from paper |
| Sleep-time compute | Research | Any | N/A | Implement in scheduler |

---

## Critical Decision: Mem0 vs Zep vs Letta

These overlap. Here is the decision matrix for our setup:

| Need | Best Tool | Reasoning |
|------|-----------|-----------|
| Agent restarts cleanly | **Letta** | Memory blocks reload verbatim |
| Fast session recall | **Mem0** | <200ms, no graph overhead, works immediately post-ingest |
| Historical fact versioning (IPs, configs) | **Zep** | Temporal graph, `invalid_at` for stale facts |
| Experiment result search | **Cognee** | Document ingestion + graph traversal, MCP-native |
| Nightly consolidation / planning | **Sleep-time + TiMem** | Custom, no new dependency, fits our scheduler |

**Recommended starting point**: Mem0 (fast, proven, solves the most common pain point today) + sleep-time consolidation (zero new infrastructure). Add Cognee and Zep in phase 2 as the research corpus grows.

---

## Sources

- [Mem0 Documentation](https://docs.mem0.ai/)
- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (arxiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arxiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [Zep Agent Memory Product Page](https://www.getzep.com/product/agent-memory/)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Cognee GitHub](https://github.com/topoteretes/cognee)
- [Cognee AI Memory Architecture](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory)
- [Letta / MemGPT Docs](https://docs.letta.com/concepts/memgpt/)
- [Letta Sleep-Time Compute Blog](https://www.letta.com/blog/sleep-time-compute)
- [Sleep-time Compute Paper (arxiv 2504.13171)](https://arxiv.org/html/2504.13171v1)
- [TiMem: Temporal-Hierarchical Memory Consolidation (arxiv 2601.02845)](https://arxiv.org/html/2601.02845v1)
- [MemoriesDB: Temporal-Semantic-Relational Database (arxiv 2511.06179)](https://arxiv.org/html/2511.06179)
- [Redis: AI Agent Memory — Stateful Systems](https://redis.io/blog/ai-agent-memory-stateful-systems/)
- [AWS AgentCore Long-Term Memory Deep Dive](https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/)
- [AI Agent Memory Systems in 2026 — Compared (Medium)](https://yogeshyadav.medium.com/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)
- [Mem0 AWS: Persistent Memory with ElastiCache + Neptune Analytics](https://aws.amazon.com/blogs/database/build-persistent-memory-for-agentic-ai-applications-with-mem0-open-source-amazon-elasticache-for-valkey-and-amazon-neptune-analytics/)
