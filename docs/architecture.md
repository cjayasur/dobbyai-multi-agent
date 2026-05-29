# Lesson 14 — Multi-Agent Orchestration: An Army of DobbyAI Agents

> *"It's like giving a bunch of guys shovels and asking them to dig the same
> hole. How do you make faster progress together — without just smashing the
> shovels together?"*

This lesson builds the **DobbyAI orchestrator**: a way to run many agents in
parallel on one goal, at the protocol level, with **no framework** — no
LangGraph, no Celery, no Kafka, no Redis. The same philosophy as every other
lesson: expose the capability as an MCP tool, keep the trust boundary
explicit, make every coordination action an auditable scoped call.

By the end you will understand *why* the entire coordination layer is **one
SQLite table plus ~5 MCP tools**, and you'll be able to build it in a
testable order.

---

## Part 0 — The Problem (why naive parallelism smashes shovels)

You have `step10-full-agent.ts`. It works. Naively, to go faster, you launch
five of them with the same prompt: *"dig the hole."*

What actually happens:

- All five dig the **same spot** → 5× the work, 1× the progress
- Or all five dig **five separate holes** → wrong, you wanted one hole
- Or they share a workspace and **overwrite each other's output** → corruption

Speedup is zero, often negative. The shovels smash. **Everything in this
lesson is a defense against one of those three failure modes.** Keep them in
mind — each part below neutralizes one.

The insight that resolves all three:

> Coordination is not about the diggers or the shovels. It is about a **board
> on the wall** that says who digs which section, plus the rule that **taking
> a ticket off the board is a single atomic motion.**

The board is one SQLite table. The atomic motion is one SQL transaction. That
is the whole design. The rest of this lesson is understanding why that is
sufficient.

---

## Part 1 — Decompose: someone chalks the sections first

Before anyone digs, **one person** stands at the hole and marks it out:
*north quarter, south, east, west.*

That person is the **orchestrator**. It is not special infrastructure — it is
a normal `step10` agent whose **first action** is one tool call:

```
decompose_task("dig the hole")
  → ["dig N quarter", "dig S quarter", "dig E quarter", "dig W quarter"]
```

Decomposition is an **LLM reasoning step**. The orchestrator *thinks* about how
to split the goal — that is a strength of using an agent as the orchestrator
rather than hardcoded logic: the split adapts to the goal. Protocol-level it
is just the agent loop emitting one `tool_use` whose result is a list.

This neutralizes failure mode #2 (five separate holes): the goal is split
*once*, by *one* actor, before any work begins.

---

## Part 2 — The Board: shared state, not messaging

The foreman does **not** run around shouting assignments at each digger. That
is direct messaging: N² fragile connections, and the foreman becomes the
bottleneck and the single point of failure.

Instead there is a **board**. Sections are posted once. Diggers come to the
board.

Protocol-level, the board is **one SQLite table**:

```
tasks(
  id          INTEGER PRIMARY KEY,
  parent_goal TEXT,
  subtask     TEXT,
  status      TEXT,      -- 'open' | 'claimed' | 'done' | 'failed'
  claimed_by  TEXT,
  result      TEXT,
  stage       INTEGER,   -- for pipelines (Part 8)
  depends_on  INTEGER,   -- for pipelines (Part 8)
  created_at  TEXT,
  claimed_at  TEXT,
  done_at     TEXT
)
```

This is the single most important reframe in the lesson:

> The "message bus" everyone reaches for (Kafka) is replaced by **a table the
> diggers read.** Coordination is *shared state*, not *messaging*.

Kafka is for million-message-per-second streaming. An agent fleet coordinating
dozens-to-hundreds of subtasks is a *database*, not a broker. Right-sizing
infrastructure is itself a senior signal.

---

## Part 3 — The Atomic Claim ⚠️ (the only hard part)

Two diggers reach the board at the same instant and both grab *"dig N
quarter."* **This is the shovel-smash** — failure mode #1. Every other part
of this lesson is plumbing. This part is the actual computer-science problem.

The rule: **taking a ticket is a single, uninterruptible motion.** One digger
writes their name on it; the second arrives and the ticket already has a name.

Protocol-level, this is *one atomic statement inside a transaction*:

```sql
BEGIN IMMEDIATE;
  SELECT id FROM tasks
   WHERE status='open' AND (depends_on IS NULL
         OR depends_on IN (SELECT id FROM tasks WHERE status='done'))
   ORDER BY id LIMIT 1;          -- pick one
  UPDATE tasks
     SET status='claimed', claimed_by=:worker, claimed_at=:now
   WHERE id=:picked AND status='open';   -- claim it, re-checking status
COMMIT;
-- return the row, or "nothing left"
```

**SQLite gives you the atomicity for free.** A transaction either fully
happens or it does not. Two workers calling this simultaneously: one wins the
row; the other's `UPDATE ... WHERE status='open'` affects zero rows (the row
is no longer `open`), so it loops and takes the next one.

> The hard distributed-coordination problem reduces to: **use a transaction.**

Internalize this. When you build it and feel the urge to reach for a lock
library, ZooKeeper, or a queue broker — **stop.** You already have the lock.
It is `BEGIN IMMEDIATE / COMMIT`. The `AND status='open'` in the `UPDATE` is
the optimistic-concurrency check that makes the race safe.

This single property is what stops the shovels smashing.

---

## Part 4 — The Worker Is Just a DobbyAI Agent

Once a digger has a section, they dig it — own shovel, own judgment, own tool
loop. Nothing new.

A **worker** is literally `step10-full-agent.ts` with:

- the `orchestrator-mcp` server wired in (so it can call claim/report)
- a system prompt: *"Loop: claim a task; if none, exit. Do the task with your
  tools. Report the result. Repeat."*

It is not a new program. It is the agent you already built (Lessons 1–12),
pointed at the board. This is the payoff of the protocol-level approach: the
agent loop never changes — orchestration is *added* via MCP, not *baked in*.

---

## Part 5 — Report Back (idempotent on purpose)

Digger finishes, returns to the board, marks the section done, records where
the dirt went.

```sql
UPDATE tasks
   SET status='done', result=:result, done_at=:now
 WHERE id=:task_id AND status='claimed' AND claimed_by=:worker;
```

The `AND status='claimed' AND claimed_by=:worker` clause makes it
**idempotent**: a worker reporting twice (retry after a network hiccup) cannot
corrupt the board, and a worker cannot report a task it never claimed. This is
a "don't smash shovels" guarantee — neutralizing a subtle version of failure
mode #3 (corruption via double-write).

---

## Part 6 — The Foreman Assembles the Hole (aggregate)

The orchestrator watches the board. When **all subtasks for the goal are
`done`**, it performs its *second* reasoning step:

```
aggregate(goal):  read all results  →  synthesize the final answer
```

Another LLM step — the orchestrator reads the N dirt-piles and produces the
unified output. Decompose (Part 1) and aggregate (Part 6) are the
orchestrator's **only two brain moments**. Everything in between is workers
pulling the board. The orchestrator never digs — separation of concerns is
itself a correctness property (the foreman cannot both assign and corrupt a
section).

---

## Part 7 — Same Hole vs Different Sections (one primitive, two modes)

There are two reasons to parallelize, and they are **the same table with
different decompose + aggregate**:

| Mode | `decompose` produces | `aggregate` does | Use when |
|---|---|---|---|
| **Divide** (orchestrator–worker) | *different* subtasks | stitch the pieces together | divisible work, you want **throughput** |
| **Same** (ensemble / best-of-N) | the *same* task, N copies | judge / vote / pick best | one high-stakes answer, you want **reliability** |

"Five diggers, four quarters" is *divide*. "Five diggers each dig their own
test pit, foreman keeps the best technique" is *ensemble*. Identical
claim/report machinery; only the foreman's two brain-moments differ. One
small server covers both. In an interview, naming this distinction —
*"are we parallelizing for throughput or reliability? Different topologies"* —
is the answer that signals seniority.

---

## Part 8 — When the Hole Is Sequential (the pipeline)

Some holes cannot be split sideways: you must dig, *then* shore the walls,
*then* lay pipe, *then* backfill. That is a **pipeline**. (Your existing
vision→coder flow is a hardcoded 2-stage instance of this.)

Same table — the `stage` and `depends_on` columns already in Part 2's schema
do the work. A task becomes claimable only when its `depends_on` task is
`done` (this clause is already in the Part 3 claim query). Workers can
specialize per stage. The board now enforces ordering with **no new
infrastructure** — it generalizes your two-stage pipeline to N stages by
adding two columns and one `WHERE` clause.

---

## Part 9 — The "Don't Smash Shovels" Checklist

When you build, verify each property — each prevents a specific collision:

1. **Atomic claim** (Part 3) — no two workers get the same task
2. **Idempotent report** (Part 5) — a double-report cannot corrupt
3. **Orchestrator never digs** — separation of concerns
4. **Dependency gate** (Part 8) — a stage cannot start before its predecessor
5. **Crash recovery** — a task `claimed` for longer than a timeout with no
   report → reset to `open` (one periodic sweep; this is "what if a digger
   walks off mid-section")
6. **Every claim/report is a timestamped row** — the audit trail is *free*,
   and it is the trust property regulated buyers require: you can replay
   exactly which agent did what, when, and what it produced

---

## Part 10 — Why This Is the DobbyAI Way

The **entire** orchestration layer:

- **One SQLite table** (the board / message bus / lock — all three)
- **~5 MCP tools**: `decompose_task`, `dispatch`, `claim_next_task`,
  `report_result`, `aggregate`
- **Workers** = unchanged `step10` agents + the MCP server + a system prompt
- **Orchestrator** = an unchanged `step10` agent that calls decompose then
  polls then aggregates

No LangGraph. No Celery. No Kafka. No Redis. No ZooKeeper. The transaction is
the lock. The table is the bus. The agent loop is untouched. Every
coordination action is an auditable, scoped tool call against state you can
`SELECT *` and inspect.

For a regulated or sovereign deployment this *beats* a framework precisely
because there is **no hidden orchestration state** — there is a table of rows
with timestamps and a handful of tools, all on hardware the operator
controls. That is the same thesis as Lesson 13 (security) and the on-prem
deployment model: protocol-level, no framework, explicit and auditable trust
boundaries.

---

## Sidebar — Why Not Redis, Kafka, or a "Real" Queue?

The honest answer is *not* "SQLite beats Redis." It is: **this is a
transactional-state problem, not a high-throughput-messaging problem — so a
transactional store is the right *category*, and SQLite is the zero-ops,
maximum-audit instance of that category for on-prem.**

First, what those tools are genuinely best at:

| Tool | Actually best at |
|---|---|
| **Kafka** | Million-msg/sec streaming, fan-out, replaying event firehoses |
| **Redis** | Sub-millisecond ephemeral state, caching, high-frequency pub/sub |
| **SQLite / Postgres** | Durable, **transactional** state, queried relationally |

The orchestrator's core operation — *"atomically find an open task, mark it
claimed, return it, never let two workers get the same one"* — is the textbook
definition of a database transaction. It is not streaming. It is not caching.
You are reaching for the tool whose entire reason to exist is the exact thing
you need.

Five concrete reasons SQLite fits *this* system:

1. **The atomic claim is one transaction.** `BEGIN IMMEDIATE; …; COMMIT` —
   ACID, free. Redis is atomic *per command*; a multi-step find-update-return
   claim needs a Lua script or `WATCH/MULTI/EXEC` optimistic-locking dance —
   more moving parts on the one part you must get right.
2. **Zero infrastructure = smaller attack surface.** Redis is a separate
   daemon: a port, an auth config to misconfigure, a process to monitor and
   back up, a network hop. SQLite is a file — no port, no network attack
   surface, one fewer component to audit. For sovereign/regulated deployment
   that is a security *feature*.
3. **Durability by default.** Redis is in-memory; persistence is tunable and
   can lose the last N seconds on crash. The task board losing "who was
   mid-task" on a power blip is the shovel-smash at the worst moment. SQLite
   writes are fsync-durable.
4. **The audit trail *is* the coordination state.** `SELECT * FROM tasks
   ORDER BY created_at` replays exactly what happened. With Redis you would
   run a *second* system for auditability and keep two stores consistent. The
   trust property regulated buyers require is free and inherently consistent
   here.
5. **The orchestrator's reasoning is relational.** "All subtasks for goal X
   done? Which failed? Collect results." is `SELECT … WHERE … GROUP BY` —
   native in SQL, awkward in a key-value store.

**When you would switch — and to what.** At multi-host scale (workers on
different physical machines), SQLite over a network filesystem gets ugly. You
move the table to **Postgres** — still SQL, still transactions, still
auditable. *Same design, bigger engine.* You would **not** move to
Redis/Kafka: the design (table + atomic claim + timestamped audit rows) is
correct; only the engine scales. Task granularity is seconds-to-minutes per
agent, so the board sees *tens of writes per minute* — the bottleneck is
always inference latency, never the coordination store. Kafka here is a
freight train delivering one letter.

**The one-line version (use this in an interview):**

> *"Coordinating an agent fleet is a transactional-state problem, not a
> high-throughput-messaging problem. The right category is a transactional
> database; SQLite gives ACID claims, durability, a free audit trail, and zero
> extra attack surface for on-prem. At multi-host scale the same design moves
> to Postgres — never Redis or Kafka, because those solve a throughput problem
> this system doesn't have."*

That answer demonstrates right-sizing and security thinking — the difference
between an engineer who reasons about the problem and one who cargo-cults the
stack.

---

## Compare to LangGraph (know the framework you're choosing not to use)

LangGraph is the most common framework answer to "orchestrate multiple
agents." You should understand it well enough to say *"I chose the primitive
deliberately"* rather than *"I never looked."* The first is senior; the second
is a gap. This is not a takedown — LangGraph is good software; the point is an
**informed** choice.

LangGraph models multi-agent work as a **StateGraph**: nodes (agents/steps),
edges (control flow, including conditional and cyclic), a shared **state
object** threaded through the graph, a **checkpointer** for durability/resume,
and **interrupts** for human-in-the-loop. Its multi-agent patterns —
*supervisor*, *swarm*, *hierarchical teams* — are the same topologies this
lesson builds.

The mapping is almost one-to-one:

| LangGraph concept | This lesson's equivalent |
|---|---|
| `StateGraph` | the `tasks` SQLite table |
| Supervisor node | the orchestrator agent (`decompose` + `aggregate`) |
| Worker nodes | `step10` workers pulling the board |
| Shared state object | the rows (read/written via claim/report) |
| Checkpointer | the table *is* durable state — fsync'd rows |
| Conditional edges / routing | the claim query's `WHERE status='open' AND depends_on…` |
| `interrupt` / human-in-loop node | supervisor approval gate before `aggregate` commits |
| State reducer | `aggregate()` — the orchestrator's synthesis step |
| Swarm vs supervisor vs hierarchical | divide / ensemble / pipeline (Parts 7–8) |

**What LangGraph genuinely gives you:** a declarative orchestration DSL, graph
visualization, built-in checkpointing and streaming, time-travel debugging,
and a large ecosystem. For rapid prototyping or a team already standardized on
it, that is real leverage — say so in an interview; do not dismiss it.

**Why this lesson builds the primitive instead — and it is one reason:**
*every state transition must be an inspectable row.* In LangGraph the
orchestration state lives **inside the framework** (the graph runtime + the
checkpointer's serialized blobs). In the table model the state **is** the
audit log — `SELECT * FROM tasks ORDER BY created_at` replays exactly what
every agent did, when, and why, with no framework to instrument. For
regulated / sovereign on-prem deployment that is the deciding property:
fewer dependencies (smaller attack surface), no hidden runtime state, and the
trust boundary is explicit at every claim and report. It is the same thesis as
Lesson 13 and the on-prem model — protocol-level, auditable by construction.

**When LangGraph is the right call (be honest):** non-regulated context,
rapid iteration, complex branching where the graph DSL earns its keep, or a
team already fluent in it. The primitive wins specifically where
auditability, minimal attack surface, and explicit on-prem trust boundaries
dominate — which is exactly the deployment this curriculum targets.

**Interview-recall line:**

> *"LangGraph models this as a StateGraph — supervisor node, worker nodes,
> shared state, a checkpointer. I build the same topology from a transactional
> task table plus MCP tools, because LangGraph keeps orchestration state inside
> the framework and I need every transition to be an auditable row. I know the
> framework; for regulated on-prem I'm choosing the primitive, and I can tell
> you exactly where that line is."*

You can only deliver that line *after* actually working through LangGraph's
supervisor and swarm tutorials. Do the literacy pass before you build — it
sharpens this design too: you will see which mechanisms LangGraph found
necessary (interrupts, checkpoint resume, state reducers) and decide which to
replicate in the table model and which to skip.

---

## Build Order (do it in this sequence — each step is independently testable)

```
1. tasks table + claim_next_task
   TEST: launch 2 workers against 1 task → exactly one claims it.
         (Prove the atomic claim FIRST. If this is solid, the rest is plumbing.)

2. report_result + a dumb worker loop (claim → sleep → report)
   TEST: 4 tasks, 2 dumb workers → all 4 end 'done', none double-claimed

3. orchestrator: decompose_task + dispatch
   TEST: 1 goal → 4 'open' rows on the board

4. orchestrator: poll + aggregate
   TEST: 4 'done' rows → 1 synthesized result

5. swap the dumb worker for a real step10 instance
   TEST: workers do an actual subtask with their own tool loop

6. ensemble mode (Part 7), then pipeline mode (Part 8)
   TEST: same table, only decompose/aggregate differ; dependency gating works

7. crash recovery sweep (Part 9 #5)
   TEST: kill a worker mid-task → task returns to 'open' → another claims it
```

Build **Step 1 first** and prove two workers racing for one task with only one
winning. Everything after that is mechanical. The whole lesson lives or dies
on the atomic claim — get it right and the army digs in unison.

---

## Where This Connects

- **Lesson 13 (security):** every coordination action is a scoped, audited MCP
  call — the orchestrator can enforce per-worker authority (a worker only gets
  the tools its subtask needs). Multi-agent + the three-tier identity model =
  governed agent fleets.
- **On-prem deployment:** the orchestrator + workers run against the same local
  serving layer (vLLM / llama.cpp) — an army of agents, zero external egress.
- **The thesis:** this is the capstone of the no-framework, protocol-level
  approach — even *fleet coordination* needs no framework, just a table and a
  transaction.
