# How to add another worker agent

This system is designed so **adding capacity = adding workers**. Zero
orchestrator changes. Zero tasks-server changes. Zero data-file changes.

Three lines of OAuth config + one launch command. **The board doesn't care how
many claimants there are** — that's the durable-state design winning.

---

## Why it's this easy (the architecture answer)

Workers don't know each other exists. They don't talk to each other. They don't
announce themselves to the orchestrator. They only talk to **one MCP server**
(the secure-tasks board) and follow a single rule:

```
loop forever:
  task = claim_task()           # atomic SQL transaction
  if no task: sleep, exit-if-idle-too-long
  result = LLM(task)
  report_task(result)           # idempotent update
```

That's the entire worker contract. As long as your OAuth credentials let you
call `claim_task` and `report_task`, you ARE a worker. **No registration. No
discovery. No service mesh.**

Compare to a graph-based framework: adding a node to a LangGraph means updating
the graph definition, redeploying the supervisor, possibly versioning the state
schema. Here, you just launch another process.

---

## The 3-step procedure

### Step 1 — Add an OAuth client for the new worker identity

Edit `servers/oauth-server-demo.ts` and add an entry to the `CLIENTS` map:

```typescript
"dobbyai-worker-004": {
  secret: "worker-004-secret-key",
  allowedScopes: ["mcp:tasks:read", "mcp:tasks:claim", "mcp:tasks:report"],
  name: "DobbyAI Worker 004 (Lesson 14)",
},
```

That's the **entire** server-side change. Identical scopes to the existing
workers 001/002/003 (least-privilege: read + claim + report — NOT create).

> **Production note:** in a real deployment you'd issue worker identities from
> a proper IdP (Keycloak, Okta, Auth0) — not a hardcoded map. The principle
> stays the same: a worker is an OAuth client whose JWT carries the
> `mcp:tasks:claim` scope.

### Step 2 — Restart the OAuth server (so it picks up the new client)

If you're using `run-demo.sh`, this is automatic — the script tears down and
restarts both servers each run.

If you're running servers manually:

```bash
# kill the OAuth server
lsof -ti :3300 | xargs kill

# restart it
bun run servers/oauth-server-demo.ts > /tmp/dobbyai-oauth.log 2>&1 &
```

### Step 3 — Launch the worker

```bash
MCP_CLIENT_ID=dobbyai-worker-004 \
MCP_CLIENT_SECRET=worker-004-secret-key \
    bun run workers/mortgage-worker.ts
```

The worker immediately:
1. Authenticates to OAuth, gets a Bearer JWT with the new scopes
2. Connects to the MCP tasks server, runs the initialize handshake
3. Starts polling `claim_task` every 1.5s

If there's work on the board, it claims and processes. Done.

**Total wall-clock to add a worker: ~30 seconds.** No code change. No deploy.

---

## Update `run-demo.sh` to launch worker-004 automatically

Open `run-demo.sh`. Find the existing 3-worker block:

```bash
MCP_CLIENT_ID=dobbyai-worker-001 MCP_CLIENT_SECRET=worker-001-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-001.log 2>&1 &
WORKER1_PID=$!

MCP_CLIENT_ID=dobbyai-worker-002 MCP_CLIENT_SECRET=worker-002-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-002.log 2>&1 &
WORKER2_PID=$!

MCP_CLIENT_ID=dobbyai-worker-003 MCP_CLIENT_SECRET=worker-003-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-003.log 2>&1 &
WORKER3_PID=$!
```

Add a fourth:

```bash
MCP_CLIENT_ID=dobbyai-worker-004 MCP_CLIENT_SECRET=worker-004-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-004.log 2>&1 &
WORKER4_PID=$!
```

And add `$WORKER4_PID` to the `wait` line at the end:

```bash
wait $WORKER1_PID $WORKER2_PID $WORKER3_PID $WORKER4_PID 2>/dev/null || true
```

That's it. Next `./run-demo.sh` runs with 4 workers.

---

## Scaling beyond 4 workers — does more workers = faster?

**It depends on the stage shape.** Look at how many tasks each stage has:

| Stage | Tasks | Benefits from N=4? | N=5? | N=10? |
|---|---|---|---|---|
| 1 — Intake/KYC | 4 | ✅ (1 round) | ✅ (1 round) | ✅ (1 round) |
| 2a — Credit pulls | 3 | minimal | minimal | minimal |
| 2b — Tri-merge | 1 | no | no | no |
| 3 — Financial | 4 | ✅ (1 round) | ✅ (1 round) | ✅ (1 round) |
| 4 — Property | 3 | minimal | minimal | minimal |
| 5 — Underwriting | 1 | no | no | no |
| 6 — Compliance | 3 | minimal | minimal | minimal |

**The bottleneck stages are 5 and 2b** — single-task stages where extra workers
just poll an empty board. For mortgage workflow, **N=4 captures most of the
parallelism gain**; N=5+ has diminishing returns.

The other ceiling is **inference contention**. All workers hit the same
gpt-oss-120B on GX10:8080. llama.cpp batches requests, but per-request latency
goes up with concurrency. Roughly:

| Concurrent workers | Per-call latency | Total throughput |
|---|---|---|
| 1 | ~20s | 1× |
| 3 | ~25s | 2.4× |
| 5 | ~30s | 4× |
| 10 | ~40s | 5× *(diminishing — memory bandwidth bottleneck on the model)* |

For tomorrow's demo, **3 workers is the sweet spot** — good parallelism story,
each task visible to the eye, no GPU starvation.

---

## Running workers on different machines

The MCP tasks server is the only thing that needs to be reachable. Set the env
vars to point at the remote server:

```bash
OAUTH_TOKEN_URL=http://homelab.example:3300/token \
TASKS_MCP_URL=http://homelab.example:3500/mcp \
TASKS_RESOURCE=http://homelab.example:3500 \
MCP_CLIENT_ID=dobbyai-worker-remote-001 \
MCP_CLIENT_SECRET=...remote-secret... \
    bun run workers/mortgage-worker.ts
```

**Same code, different machine.** A worker is just "a process that can reach
the tasks server with the right OAuth credentials." It doesn't matter if it
runs in a container, on a different VM, in a different region, or on an
edge device.

This is the **horizontal scalability story for regulated agent fleets**: same
auditable transactional board, more pods consuming from it.

---

## Specialized workers (different scopes per role)

You can also add workers with DIFFERENT scopes for specialization:

```typescript
// A worker that can only handle compliance tasks (read-only on the board,
// plus its own specialized scope for accessing compliance docs)
"dobbyai-compliance-worker-001": {
  secret: "compliance-worker-secret",
  allowedScopes: [
    "mcp:tasks:read",
    "mcp:tasks:claim:compliance",     // ← scoped claim — server enforces it
    "mcp:tasks:report"
  ],
  name: "DobbyAI Compliance Worker",
},
```

To make this actually enforce, you'd extend `mcp-server-secure-tasks.ts`'s
`atomicClaim` to filter by a per-worker capability tag stored in the task row.
That's a one-column schema change (e.g., `required_capability TEXT`) and three
lines in the WHERE clause.

**The point: specialization is OAuth scopes + a SQL filter.** Not a framework
config.

---

## The interview talking point

> *"Adding a worker is a four-line OAuth config change and a launch command.
> No orchestrator update. No service discovery. No graph re-deployment. The
> board doesn't know how many claimants exist — it just hands tasks to whoever
> claims them atomically. Workers can come and go without coordination
> changes. That's the durable-state design winning: capacity scales linearly
> with worker count up to the inference bottleneck, and the entire fleet
> participates in the same auditable task_events log regardless of where the
> workers physically run."*

That's the **horizontal-scaling-without-orchestration-changes** story —
exactly what a senior infra interviewer at a regulated bank is testing for.
