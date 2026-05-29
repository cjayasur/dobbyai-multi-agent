# DobbyAI Multi-Agent Mortgage Underwriting

> **Framework-free multi-agent orchestration for regulated lending.** 19 agents,
> 6 stages, one SQLite task board, one underwriting decision, one auditable
> trail. No LangChain. No LangGraph. No Kafka. No Celery. Just protocol-level
> primitives + OAuth-scoped tools + a transactional database.

## 🎬 Watch the demo

Two-part walkthrough recorded with [Cap](https://cap.so) — the open-source screen recorder.

**▶️ [Play full demo playlist (auto-advances) →](https://www.youtube.com/playlist?list=PL-gxbsWV76M1owLYkcQ0F1-mHx5dbrhus)**

| Part 1 — Architecture + Worker Verifications | Part 2 — Aggregate Decision + Audit Trail |
|:---:|:---:|
| [![Part 1](https://img.youtube.com/vi/bKiWK-P9QZg/maxresdefault.jpg)](https://youtu.be/bKiWK-P9QZg) | [![Part 2](https://img.youtube.com/vi/FpO5YGjs1f4/maxresdefault.jpg)](https://youtu.be/FpO5YGjs1f4) |

*Part 1 covers the architecture, the orchestrator's decompose step, and the 19 worker agents running parallel verifications against gpt-oss-120B on the on-prem Blackwell stack. Part 2 picks up after a transient transport hiccup and shows the orchestrator's aggregate brain moment — synthesizing the 19 verdicts into a regulator-cite-able underwriting decision.*

This repo demonstrates a **production-shaped multi-agent system** for mortgage
underwriting, built without any orchestration framework. It runs on a local
NVIDIA stack (vLLM + Qwen3.6-35B-A3B or llama.cpp + gpt-oss-120b) via the
DobbyAI proxy, and every coordination action is an auditable row in a
transactional store.

The thesis: **for regulated industries, the right abstraction for multi-agent
orchestration is a transactional database, not a graph framework.** This is
not a takedown of LangGraph — it is an informed choice for the deployment
profile that matters here: on-prem, sovereign, auditable by construction.

---

## What you'll see

```
🏦 DobbyBank, N.A. — Mortgage Underwriting Orchestrator
   Loan: LN-2026-1234  |  Borrower: Maria L. Rodriguez  |  Amount: $750,000

📝 STAGE 1 — Intake / KYC — creating 4 tasks
   • Created task 1.   • Created task 2.   • Created task 3.   • Created task 4.
   … waiting (4/4 still open)
   ✅ Stage complete (4/4 tasks done).

📝 STAGE 2a — Credit Bureau Pulls (parallel) — creating 3 tasks
   ✅ Stage complete (3/3 tasks done).

  [... 4 more stages ...]

🧠 Aggregate — calling LLM with 19 task reports...

═══════════════════════════════════════════════════════════════════════════
# Underwriting Decision — Loan LN-2026-1234

## Decision
APPROVE WITH CONDITIONS

## Borrower Risk Profile
- FICO (mid): 740
- LTV: 78.95%
- Front-end DTI: 31.32%
- Back-end DTI: 37.57%
- Reserves (months PITI): 49

## Reasoning
Tri-merge mid-FICO of 740 places borrower in best-pricing tier (per DobbyBank
§2). LTV under 80% eliminates PMI requirement. Back-end DTI of 37.57% well
under QM safe-harbor threshold of 43% (12 CFR 1026.43(e)(2)(vi)). Income
verified across W-2, paystubs, and IRS 4506-C transcript with zero variance.
Reserves of 49 months PITI vastly exceed the 2-month minimum...

[full decision document]
═══════════════════════════════════════════════════════════════════════════

📋 Full audit trail: sqlite3 tasks.db "SELECT * FROM task_events ORDER BY id"
```

A 90-second demo. 19 agents reasoning in parallel on Qwen3.6-35B via the
DobbyAI proxy. SQLite arbitrating the atomic claim. Every transition timestamped
in the audit log.

---

## Architecture

```
═════════════════════════════════════════════════════════════════════════════
  THE BOARD  (tasks.db — SQLite)
  Shared state, message bus, and lock — all three.
  No hidden framework state. Every coordination action is a row.
═════════════════════════════════════════════════════════════════════════════
       ▲                                                 ▲
       │ (Decompose / Aggregate)                         │ (Atomic Claim / Report)
       ▼                                                 ▼
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│   ORCHESTRATOR AGENT         │                 │      WORKER AGENTS (N)       │
│   (mortgage-orchestrator.ts) │                 │   (mortgage-worker.ts × N)   │
│                              │                 │                              │
│ ① Decompose                  │                 │  Loop until idle:            │
│   Build 19 subtasks across   │                 │   claim → reason → report    │
│   6 stages                   │                 │                              │
│                              │                 │   Each worker:               │
│ ② Aggregate (LLM call)       │                 │    - claim ONE task atomic   │
│   Synthesize 19 reports →    │                 │    - read referenced data    │
│   underwriting decision      │                 │    - call DobbyAI proxy      │
│                              │                 │    - report verdict + JSON   │
└──────────────────────────────┘                 └──────────────────────────────┘
                                                                 │
                                                                 ▼
       ═══════════════════════════════════════════════════════════════════════
         GUARDRAIL LAYER  (OAuth 2.1 + per-tool scope checks)
       ═══════════════════════════════════════════════════════════════════════
         Each agent has a JWT with narrow scopes:
            Orchestrator → mcp:tasks:read + mcp:tasks:create
            Worker       → mcp:tasks:read + mcp:tasks:claim + mcp:tasks:report
         Scope-denied attempts logged with actor identity (JWT `sub`).
                                                                 │
                                                                 ▼
       ═══════════════════════════════════════════════════════════════════════
         INFERENCE LAYER  (DobbyAI Proxy → vLLM / llama.cpp)
       ═══════════════════════════════════════════════════════════════════════
         Anthropic Messages API format → routed by model tier:
            sonnet alias → Qwen3.6-35B-A3B (GX10:8082)
            opus alias   → gpt-oss-120b    (GX10:8080)
            haiku alias  → dense Qwen3.6-27B (tower:8013)
```

---

## The 19-task / 6-stage decomposition

A real US mortgage application moves through six distinct workflows. Each
worker is **scoped to one slice** — least-privilege by construction.

| Stage | Subtasks | Pattern |
| ----- | -------- | ------- |
| **1. Intake / KYC** | KYC verify · ID consistency · OFAC screen · Address history | Parallel — 4 workers |
| **2a. Credit Bureau Pulls** | Experian · Equifax · TransUnion | Parallel — 3 workers |
| **2b. Tri-merge Analysis** | Reconcile 3 FICOs into mid-score | Sequential after 2a |
| **3. Financial Verification** | Income · Assets · Employment · DTI | Parallel — 4 workers |
| **4. Property** | Appraisal · Title · Hazard insurance | Parallel — 3 workers |
| **5. Underwriting Decision** | Synthesis: credit + DTI + LTV + reserves | Sequential — 1 worker |
| **6. Compliance** | TRID · HMDA · ECOA/QM-ATR | Sequential — 3 workers |

Each task description points its worker at a specific data file under
`data/`. Workers reason over their slice; they cannot see other slices.

---

## Quickstart (5 minutes)

### Prerequisites

- **Bun** v1.0+ (`brew install oven-sh/bun/bun`)
- **An Anthropic-format inference endpoint** — one of:
  - Anthropic API directly (`https://api.anthropic.com/v1/messages` + `sk-ant-` key)
  - **DobbyAI proxy** at `api.palomaressoftware.com/dobbyai/v1/messages` (this repo's reference deployment — on-prem Qwen3.6-35B on Blackwell)
  - Any other Anthropic-compatible proxy (LiteLLM, OpenRouter, custom)

### Run

```bash
# Terminal 1 — OAuth server (for the scoped tokens)
bun run src/oauth-server-demo.ts

# Terminal 2 — Secure Tasks MCP server (the board)
bun run src/mcp-server-secure-tasks.ts

# Terminal 3 — Orchestrator (seeds the board, polls, aggregates)
export DOBBYAI_API_URL=https://api.palomaressoftware.com/dobbyai/v1/messages
export DOBBYAI_API_KEY=dk_your_key_here
export DOBBYAI_MODEL=claude-sonnet-4-20250514
bun run WellsFargoMortgage/mortgage-orchestrator.ts

# Terminals 4, 5, 6 — Workers (race for tasks)
MCP_CLIENT_ID=dobbyai-worker-001 MCP_CLIENT_SECRET=worker-001-secret-key \
    bun run WellsFargoMortgage/mortgage-worker.ts

MCP_CLIENT_ID=dobbyai-worker-002 MCP_CLIENT_SECRET=worker-002-secret-key \
    bun run WellsFargoMortgage/mortgage-worker.ts

MCP_CLIENT_ID=dobbyai-worker-003 MCP_CLIENT_SECRET=worker-003-secret-key \
    bun run WellsFargoMortgage/mortgage-worker.ts

# Terminal 7 (optional) — watch the board mutate
watch -n 1 'sqlite3 tasks.db "SELECT id, status, claimed_by, substr(description, 1, 40) FROM tasks ORDER BY id"'
```

### Verify the audit trail

```bash
sqlite3 tasks.db "SELECT id, task_id, actor, event, created_at FROM task_events ORDER BY id"
```

Every claim, every report, every scope-denial — timestamped, actor-attributed,
queryable. **This is the compliance artifact.** Reproducible from rows.

---

## Why this design (the senior-engineering rationale)

### 1. Orchestration is shared state, not code logic

A graph framework like LangGraph models orchestration as nodes + edges with a
shared state object threaded through. That works — but the **state lives
inside the framework runtime**. For a regulated lender, that's an opaque
runtime auditors can't query.

This system makes orchestration **literally a SQL table**. The "supervisor
node" is the orchestrator agent calling `decompose()` and `aggregate()`. The
"worker nodes" are step10-style agents claiming rows. **The graph is the
table.** `SELECT * FROM tasks ORDER BY created_at` replays the entire run.

### 2. The atomic claim is one transaction

```sql
BEGIN IMMEDIATE;
  SELECT id FROM tasks
   WHERE status='open'
     AND (depends_on IS NULL
          OR depends_on IN (SELECT id FROM tasks WHERE status='done'))
   ORDER BY id LIMIT 1;
  UPDATE tasks SET status='claimed', claimed_by=:worker, claimed_at=:now
   WHERE id=:picked AND status='open';
COMMIT;
```

The hard distributed-coordination problem ("two workers must not grab the same
task") reduces to: **use a transaction.** SQLite gives ACID for free. Two
workers calling `claim_task` simultaneously — one's `UPDATE … WHERE
status='open'` affects 1 row, the other affects 0 (the row is no longer
`open`), so the second loops and takes the next ticket.

> **There is no lock library. There is no queue broker. The transaction IS
> the lock. The table IS the queue. This is the entire concurrency story.**

### 3. The audit trail is a side effect of the design

Every `claim_task` → `task_events` row.
Every `report_task` → `task_events` row.
Every `scope_denied` → `task_events` row.

Auditability is not an add-on. It's not instrumentation. It's not a "tracing
mode." It is **the shape of the data model**. You cannot perform a
coordination action without producing an audit row. That property is precisely
what regulated buyers require — and exactly what graph-runtime checkpointers
can't promise (their state is serialized blobs, not relational rows).

### 4. Capability isolation via OAuth scopes (least privilege)

Each agent has a JWT issued by `oauth-server-demo.ts`. Scopes are per-tool:

| Agent role     | Scopes                                                      |
| -------------- | ----------------------------------------------------------- |
| Orchestrator   | `mcp:tasks:read` + `mcp:tasks:create`                       |
| Worker         | `mcp:tasks:read` + `mcp:tasks:claim` + `mcp:tasks:report`   |
| Monitor (RO)   | `mcp:tasks:read`                                             |

A worker physically **cannot** call `create_task` — the secure-tasks server
rejects it at the protocol boundary AND writes a `scope_denied` audit row
with that worker's JWT `sub`. That mapping (agent identity → narrow tool set)
is the multi-agent equivalent of POSIX user permissions on a shared file
system.

---

## Compared to LangGraph (the framework you're choosing not to use)

LangGraph models multi-agent work as a StateGraph: nodes (agents/steps),
edges (control flow), a shared state object threaded through, a checkpointer
for durability/resume, and interrupts for human-in-the-loop. Its multi-agent
patterns — supervisor, swarm, hierarchical teams — are the same topologies
this repo builds.

**The mapping is almost one-to-one:**

| LangGraph concept | This repo's equivalent |
| ----------------- | ---------------------- |
| `StateGraph` | the `tasks` SQLite table |
| Supervisor node | `mortgage-orchestrator.ts` (decompose + aggregate) |
| Worker nodes | `mortgage-worker.ts` instances |
| Shared state object | rows in `tasks` (read/written via claim/report) |
| Checkpointer | the table *is* durable state (fsync'd rows) |
| Conditional edges / routing | the claim query's `WHERE … AND depends_on…` clause |
| `interrupt` / human-in-loop | supervisor pause-and-approve before `aggregate` |
| State reducer | `aggregate()` — the orchestrator's LLM synthesis |
| Swarm vs supervisor vs hierarchical | divide / ensemble / pipeline patterns |

**What LangGraph genuinely gives you:** declarative DSL, graph visualization,
built-in checkpointing + streaming, time-travel debugging, large ecosystem.
For rapid prototyping or a team standardized on it, that's real leverage.

**Why this repo builds the primitive instead — one reason:** *every state
transition must be an inspectable row.* In LangGraph the orchestration state
lives **inside the framework** (runtime + serialized checkpoint blobs). In
the table model the state **is** the audit log. For regulated / sovereign
on-prem deployment that is the deciding property: fewer dependencies (smaller
attack surface), no hidden runtime state, and the trust boundary is explicit
at every claim and report.

**The interview-recall line:**

> *"LangGraph models this as a StateGraph — supervisor node, worker nodes,
> shared state, a checkpointer. I build the same topology from a transactional
> task table plus MCP tools, because LangGraph keeps orchestration state inside
> the framework and I need every transition to be an auditable row. I know the
> framework; for regulated on-prem I'm choosing the primitive deliberately,
> and I can tell you exactly where that line is."*

---

## Why not Redis or Kafka?

The honest answer is *not* "SQLite beats Redis." It is: **this is a
transactional-state problem, not a high-throughput-messaging problem — so a
transactional store is the right *category*, and SQLite is the zero-ops,
maximum-audit instance of that category for on-prem.**

| Tool | Actually best at |
| ---- | ---------------- |
| **Kafka** | Million-msg/sec streaming, fan-out, replaying event firehoses |
| **Redis** | Sub-millisecond ephemeral state, caching, high-frequency pub/sub |
| **SQLite / Postgres** | Durable, **transactional** state, queried relationally |

The orchestrator's core operation — *"atomically find an open task, mark it
claimed, return it, never let two workers get the same one"* — is the
textbook definition of a database transaction. Not streaming. Not caching.
You are reaching for the tool whose entire reason to exist is the exact thing
you need.

Task granularity here is **seconds-to-minutes per agent**, so the board sees
tens of writes per minute. The bottleneck is always inference latency, never
the coordination store. Kafka here is a freight train delivering one letter.

**When you would switch — and to what.** At multi-host scale (workers on
different physical machines), SQLite over a network filesystem gets ugly.
You move the table to **Postgres** — still SQL, still transactions, still
auditable. *Same design, bigger engine.* You would **not** move to
Redis/Kafka: the design is correct; only the engine scales.

---

## Roadmap — Llama 4 Scout for the Orchestrator brain

The orchestrator agent has two "brain moments": **decompose** (chalk the
sections) and **aggregate** (assemble the hole). Today both are hardcoded
PLANs (in `STAGES`) or single LLM calls against Qwen3.6-35B.

On a 10M-token-context model like **Meta Llama 4 Scout** (109B-MoE, 17B
active, open weights), the orchestrator could ingest:

- The full Form 1003 application (200+ pages of supporting documents)
- The borrower's 10-year transaction history
- DobbyBank's complete underwriting policy manual (1,500 pages)
- Recent CFPB guidance + court rulings
- The full `task_events` audit log

… **in one prompt.** The agent would never have to summarize, forget, or
chunk. Decomposition would adapt to the *specific* application's complexity
rather than running a fixed 19-task PLAN.

Scout fits on an NVIDIA GB10 (128GB unified Blackwell, FP8 quantization).
Workers stay on Qwen3.6-35B — their slice is narrow and fast. The two-tier
model assignment maps cleanly to the two-tier agent topology.

**Status:** Scout license application submitted to Meta. Production wiring
planned for a follow-up release.

---

## Tonight's choice: hardcoded stages vs LLM decompose

For the current demo, `STAGES` in `mortgage-orchestrator.ts` is a hardcoded
6-stage plan. Production would replace this with an LLM call:

```typescript
const plan = await llmDecompose(seedTask);  // LLM produces stages + tasks
for (const stage of plan.stages) { ... }
```

**Why hardcoded here:** the mortgage workflow is *deterministic by
regulation* — TRID, HMDA, ECOA, QM/ATR are not optional. Hardcoding the plan
matches the legal contract. An LLM-driven decompose makes more sense for
*novel* tasks (research, code generation, multi-domain customer queries)
where the right decomposition isn't known a priori.

The point: **the orchestration substrate is the same either way.** Plug an
LLM into `STAGES` generation when you want adaptive decomposition. Keep it
hardcoded when the workflow is regulatorily fixed.

---

## File layout

```
WellsFargoMortgage/
├── README.md                       (this file)
├── mortgage-orchestrator.ts        (decompose into 6 stages, poll, aggregate)
├── mortgage-worker.ts              (claim → LLM verify → report, loop)
└── data/
    ├── application/
    │   └── form-1003-LN-2026-1234.json
    ├── credit/
    │   ├── experian-pull.json
    │   ├── equifax-pull.json
    │   └── transunion-pull.json
    ├── income/
    │   └── income-bundle.json      (W-2s + paystubs + IRS 4506-C)
    ├── assets/
    │   └── asset-bundle.json       (Chase + Marcus + Fidelity)
    ├── employment/
    │   └── voe-response.json
    ├── property/
    │   └── property-bundle.json    (Appraisal Form 1004 + Title + HOI)
    └── policy/
        ├── dobbybank-underwriting-guidelines.md
        └── compliance-checklist.md

../src/
├── mcp-server-secure-tasks.ts      (the BOARD — OAuth-gated SQLite + atomic claim)
├── oauth-server-demo.ts            (the OAuth 2.1 server)
└── step10-full-agent.ts            (the underlying agent loop — workers wrap this)

Lessons/
└── lesson14-multi-agent-orchestration.md   (the architecture doc this repo implements)
```

---

## Compliance disclaimer

**This is a demo system.** All borrower data is fictional. All bank names
(DobbyBank, N.A.) are fictional. The underwriting decisions produced by this
system are **not** real lending decisions and are not certified for any
regulatory filing. Any real production deployment would require:

- Independent model validation (SR 11-7)
- Fair Lending review (ECOA / FHA)
- HMDA reporting integration
- Operational risk assessment (OCC / FRB SR 13-1)
- IT security review (FFIEC examination)
- Third-party model risk management for the underlying LLM

The architectural patterns demonstrated here are sound; the legal/regulatory
hardening is not in scope.

---

## License

MIT — see `LICENSE`.

This is reference architecture, not a product. Fork it, learn from it, build
on it. If it earns you a senior multi-agent role at a bank, ship the patch
back.

---

## Credits

Part of the [claude-code-simple](../README.md) curriculum (Lesson 14:
Multi-Agent Orchestration). Built for the DobbyAI on-prem AI stack.

`github.com/cjayasur/dobbyai-proxy-extensions` — the inference proxy this
repo's reference deployment depends on.
