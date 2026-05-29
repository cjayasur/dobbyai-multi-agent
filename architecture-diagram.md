# Architecture Diagram &nbsp;·&nbsp; Process & Protocol Map

  What's in the file

  View 1 — All 6 processes + 1 external service

  The whole system at a glance. 6 TypeScript processes running on your Mac:
  - P1 oauth-server-demo (port 3300) — issues JWTs
  - P2 mcp-server-secure-tasks (port 3500) — the task board
  - P3 mortgage-orchestrator — no port, outbound only
  - P4/P5/P6 mortgage-worker × 3 — no port, outbound only

  Plus E1 (DobbyAI proxy) and E2 (GX10/Blackwell) running the actual LLMs.

  View 2 — Boot timeline second-by-second

  Maps each line of 🚀 Starting OAuth server... etc. to exactly which bun run is forking. The interviewer can ask "which process printed
  this?" and you'll be able to answer instantly.

  View 3 — The MCP client/server view (your specific ask)

  P2 is the single MCP SERVER. Everyone else is a MCP CLIENT of it.

  The clients are minimal hand-rolled TypeScript (the mcp() function in worker.ts and orchestrator.ts) — not the full
  @modelcontextprotocol/sdk/client. That's deliberate: gives you clean control over the OAuth Bearer header.

  The wire protocol when an orchestrator or worker talks to the tasks server:
  - Streamable HTTP (per MCP spec)
  - JSON-RPC 2.0 over POST /mcp
  - Authorization: Bearer <JWT> header
  - mcp-session-id header after first request

  Same endpoint for everyone. Scope on the JWT decides who can do what. That's the entire authorization story.

  Connection table

  10 rows, every wire in the system, with protocol + payload labeled. Useful when an interviewer asks "is that REST? gRPC? WebSocket?" —
  you can answer down to the spec.

  The two insights to internalize for tomorrow

  1. There's exactly ONE MCP server in the whole system (P2). All MCP traffic converges on localhost:3500/mcp. The orchestrator vs worker
   distinction is purely a JWT-scopes distinction. Same protocol, same endpoint, different capabilities — enforced server-side. That's
  the least-privilege story expressed in one sentence.
  2. The LLM is NOT in the MCP picture. The MCP traffic is just orchestration (claim/report/create). The actual inference goes over HTTPS
   to the DobbyAI proxy → GX10/llama.cpp. The MCP server has zero AI in it — it's a SQL transaction broker. That separation is what makes
   the system auditable: every claim and report is a row in task_events, but the LLM reasoning that produced the verdict is the row's
  result field. You can replay the orchestration without re-running the LLM.





What gets started when `./run-demo.sh` boots, who talks to whom, what protocol carries each message.

---

## View 1 &nbsp;·&nbsp; Zoom-out — all 6 processes on your Mac + 1 external service

```
═══════════════════════════════════════════════════════════════════════════════════════════════
  HOST: Charithas-MacBook-Pro                                                        (your Mac)
═══════════════════════════════════════════════════════════════════════════════════════════════

  ┌─────────────────────────────┐        ┌─────────────────────────────┐
  │  P1  oauth-server-demo.ts   │        │  P2  mcp-server-secure-tasks│
  │  ─────────────────────      │        │  ──────────────────────     │
  │  • Bun, HTTP server         │        │  • Bun, HTTP server         │
  │  • port 3300                │        │  • port 3500                │
  │  • ROLE: Identity Provider  │        │  • ROLE: MCP Server         │
  │     (issues JWTs)           │        │  • Transport: Streamable    │
  │  • Endpoint: POST /token    │        │     HTTP (per MCP spec)     │
  │                             │        │  • 5 MCP tools              │
  └──────────────▲──────────────┘        │  • OAuth Bearer required    │
                 │                       │  • SQLite reads/writes      │
                 │                       └──────────┬──────────────────┘
       (1) GET /token                               │
       (1) POST /token                              │ direct file I/O
        Bearer JWT                                  ▼
                 │                       ┌──────────────────────────┐
                 │                       │  tasks.db  (SQLite file) │
                 │                       │  • tasks                  │
                 │                       │  • task_events            │
                 │                       └──────────▲────────────────┘
                 │                                  │
                 │                                  │ direct SQLite read
                 │                                  │ (only at aggregate)
  ┌──────────────┴──────────────┐                  │
  │  P3  mortgage-orchestrator  │──────────────────┘
  │  ─────────────────────      │
  │  • Bun, no port (outbound)  │  (2) POST /mcp + Bearer JWT
  │  • ROLE: Macro-controller   │      MCP-over-HTTP, JSON-RPC 2.0
  │  • IS:  MCP Client          │      → tools/call: create_task × 19
  │  • IS:  OAuth Client        │      → tools/call: list_open (polling)
  │  • IS:  Anthropic API client│
  │                             │──────────────────────────────────────►  P2
  │  Brain moments:             │
  │   • Decompose: HARDCODED    │  (3) HTTPS POST /v1/messages
  │     (STAGES const = 19 tasks)│     Anthropic Messages API format
  │   • Aggregate: 1 LLM call   │     → 1 call with all 19 results
  └────────────┬────────────────┘──────────────────────────────────────►  E1 (DobbyAI proxy)
               │
               │ (1) GET /token at startup
               ▼
              P1

  ┌─────────────────────────────┐
  │  P4  mortgage-worker-001    │  (1) GET /token at startup → P1
  │  P5  mortgage-worker-002    │  (2) POST /mcp + Bearer JWT  → P2
  │  P6  mortgage-worker-003    │      → tools/call: claim_task (loop)
  │  ─────────────────────      │      → tools/call: report_task
  │  • Bun, no port (outbound)  │
  │  • ROLE: Micro-controllers  │  (3) HTTPS POST /v1/messages  → E1
  │  • IS:  MCP Client          │      Anthropic Messages API
  │  • IS:  OAuth Client        │      → 1 LLM call per claimed task
  │  • IS:  Anthropic API client│
  │  • Reads data/*.json (FS)   │
  │                             │
  │  Brain moment per task:     │
  │   • doWork(): 1 LLM call    │
  └─────────────────────────────┘


  EXTERNAL SERVICES (across the internet)
  ───────────────────────────────────────

  ┌─────────────────────────────────────────┐        ┌─────────────────────────────┐
  │  E1  DobbyAI Proxy                       │        │  E2  GX10 / GB10 Blackwell  │
  │  api.palomaressoftware.com               │  HTTP  │  ─────────────────────      │
  │  /dobbyai/v1/messages                    ├───────►│  llama.cpp serving          │
  │  ─────────────────────                   │ OpenAI │  • gpt-oss-120b at :8080    │
  │  • Translates Anthropic → OpenAI         │ format │     (opus alias)            │
  │  • Routes by model alias:                │        │  • Qwen3.6-35B-A3B at :8082 │
  │    sonnet → :8082, opus → :8080          │        │     (sonnet alias)          │
  │  • Tower-side authentication             │        │  • Actual token generation  │
  │    (dk_ Bearer keys)                     │        │     happens HERE            │
  └─────────────────────────────────────────┘        └─────────────────────────────┘
```

---

## View 2 &nbsp;·&nbsp; Zoom-in on Boot phase &nbsp;·&nbsp; "🚀 First 5 seconds"

The exact sequence when you hit `./run-demo.sh`:

```
[T+0.0s]  Shell script starts
          │
          ▼
[T+0.2s]  rm -f tasks.db           (clean state)
          │
          ▼
[T+0.5s]  fork bun run oauth-server-demo.ts      → background, port 3300
          │   "🚀 Starting OAuth server (port 3300)..."
          │
          ▼
[T+0.7s]  fork bun run mcp-server-secure-tasks.ts → background, port 3500
          │   "🚀 Starting Secure Tasks MCP server (port 3500)..."
          │
          ▼
[T+3.5s]  curl localhost:3300/  +  curl localhost:3500/   (health checks)
          │   "✅ Both servers up."
          │
          ▼
[T+3.7s]  fork bun run mortgage-worker.ts (worker-001) → background
[T+3.7s]  fork bun run mortgage-worker.ts (worker-002) → background
[T+3.7s]  fork bun run mortgage-worker.ts (worker-003) → background
          │   "🤖 Launching 3 workers in parallel..."
          │
          │   (each worker immediately: GET /token → bearer JWT → POST /mcp init)
          │
          ▼
[T+5.0s]  bun run mortgage-orchestrator.ts                → FOREGROUND
              "🧠 Running orchestrator..."

          The orchestrator now begins creating Stage 1 tasks.
          Workers are already polling for work — they grab them within 1.5s.
```

**Output you see during boot maps to which process started:**

| Line in output | Process | What's actually happening |
|---|---|---|
| `🧹 Cleaning state...` | shell | `rm -f tasks.db` |
| `🚀 Starting OAuth server (port 3300)...` | P1 starts | bun runs oauth-server-demo.ts in background |
| `🚀 Starting Secure Tasks MCP server (port 3500)...` | P2 starts | bun runs mcp-server-secure-tasks.ts in background |
| `✅ Both servers up.` | shell | curl health-check passed on 3300 + 3500 |
| `🤖 Launching 3 workers in parallel...` | P4, P5, P6 start | 3 worker processes spawn, each authenticates |
| `🧠 Running orchestrator...` | P3 starts | orchestrator authenticates, begins decompose phase |

---

## View 3 &nbsp;·&nbsp; The MCP client/server relationship &nbsp;·&nbsp; *the question you asked specifically*

You wanted to know: **which process holds the MCP CLIENT, which holds the MCP SERVER, and what protocol carries the messages.**

```
                  ┌─────────────────────────────────────────────────────┐
                  │  P2  mcp-server-secure-tasks.ts                     │
                  │  ─────────────────────                              │
                  │  ★ MCP SERVER                                       │
                  │                                                     │
                  │  Implements @modelcontextprotocol/sdk/server         │
                  │  Transport: StreamableHTTPServerTransport            │
                  │  Endpoint: POST http://localhost:3500/mcp            │
                  │                                                     │
                  │  Exposes 5 tools:                                    │
                  │    1. list_open    (read tasks)                      │
                  │    2. get_task     (read a task)                     │
                  │    3. claim_task   (atomic UPDATE)                   │
                  │    4. report_task  (idempotent UPDATE)               │
                  │    5. create_task  (INSERT)                          │
                  │                                                     │
                  │  Wire protocol:                                      │
                  │    Streamable HTTP + JSON-RPC 2.0                    │
                  │    Authorization: Bearer <JWT>                       │
                  └────────────────────────▲────────────────────────────┘
                                           │
                                           │
            ┌──────────────────────────────┼──────────────────────────────┐
            │                              │                              │
            │ MCP CLIENT                   │ MCP CLIENT                   │ MCP CLIENT × 3
            │                              │                              │
  ┌─────────┴──────────┐        ┌──────────┴─────────┐        ┌───────────┴──────────┐
  │ P3 orchestrator    │        │ P4 worker-001      │        │ P5 worker-002         │
  │ ─────────────      │        │ ─────────────      │        │ P6 worker-003         │
  │ • MCP Client       │        │ • MCP Client       │        │ • MCP Client          │
  │   (raw fetch)      │        │   (raw fetch)      │        │   (raw fetch)         │
  │                    │        │                    │        │                       │
  │ Calls:             │        │ Calls:             │        │ Calls:                │
  │  - create_task     │        │  - claim_task      │        │  - claim_task         │
  │  - list_open       │        │  - report_task     │        │  - report_task        │
  │                    │        │                    │        │                       │
  │ Scopes in JWT:     │        │ Scopes in JWT:     │        │ Scopes in JWT:        │
  │  mcp:tasks:read    │        │  mcp:tasks:read    │        │  mcp:tasks:read       │
  │  mcp:tasks:create  │        │  mcp:tasks:claim   │        │  mcp:tasks:claim      │
  │                    │        │  mcp:tasks:report  │        │  mcp:tasks:report     │
  └────────────────────┘        └────────────────────┘        └───────────────────────┘
```

**Note:** The MCP client side in this codebase is a **minimal hand-rolled HTTP client** in TypeScript — not the full `@modelcontextprotocol/sdk/client`. That's because the protocol is just JSON-RPC over HTTP with a session-id header; rolling your own client gives clearer control over auth headers.

See `mortgage-worker.ts:73–113` for the worker's MCP client (function `mcp()`).
See `mortgage-orchestrator.ts:170–210` for the orchestrator's MCP client (also function `mcp()`).

---

## Connection table &nbsp;·&nbsp; every wire in the system

| # | From | To | Protocol | What's carried | When |
|---|---|---|---|---|---|
| 1 | P3 (orchestrator) | P1 (oauth) | HTTP POST `/token` | OAuth 2.1 client_credentials grant | Startup |
| 2 | P4–P6 (workers) | P1 (oauth) | HTTP POST `/token` | OAuth 2.1 client_credentials grant | Each worker startup |
| 3 | P3 (orchestrator) | P2 (tasks) | MCP-over-HTTP / Streamable HTTP / JSON-RPC 2.0 + Bearer JWT | `create_task` × 19, `list_open` (poll) | Throughout run |
| 4 | P4–P6 (workers) | P2 (tasks) | MCP-over-HTTP / Streamable HTTP / JSON-RPC 2.0 + Bearer JWT | `claim_task`, `report_task` | Throughout run |
| 5 | P2 (tasks) | tasks.db | SQLite file I/O (Bun:sqlite) | All SELECT/UPDATE/INSERT | Throughout run |
| 6 | P3 (orchestrator) | tasks.db | SQLite file I/O (direct, bypasses MCP) | SELECT all results for aggregate | At end of run |
| 7 | P3 (orchestrator) | E1 (DobbyAI proxy) | HTTPS POST `/v1/messages` (Anthropic API format) | 1 aggregate LLM call | At end of run |
| 8 | P4–P6 (workers) | E1 (DobbyAI proxy) | HTTPS POST `/v1/messages` (Anthropic API format) | 1 LLM call per claimed task | 19 total during run |
| 9 | P4–P6 (workers) | `data/*.json` | Filesystem read | Mortgage application docs | 1 per claimed task |
| 10 | E1 (DobbyAI proxy) | E2 (GX10) | HTTP POST `/v1/chat/completions` (OpenAI format) | Translated inference request | Per LLM call |

---

## The "least privilege" property &nbsp;·&nbsp; restated

Look at rows 3 and 4 of the connection table. **They use the same protocol** (MCP-over-HTTP) **and the same endpoint** (`localhost:3500/mcp`). What separates them is the **JWT scopes**:

- Orchestrator's JWT has: `mcp:tasks:read mcp:tasks:create`
- Worker's JWT has: `mcp:tasks:read mcp:tasks:claim mcp:tasks:report`

If a worker calls `create_task`, the tasks server checks its JWT, sees no `mcp:tasks:create` scope, returns 403 **and writes a `scope_denied` row in the audit log**. The audit row records the worker's JWT `sub` field — the bank examiner can see exactly which agent tried to do something out of bounds.

That's enforcement at the **protocol layer**, not the application layer.

See `src/mcp-server-secure-tasks.ts:218–225` for the enforcement code (one `if` statement).
See `src/mcp-server-secure-tasks.ts:101–107` for the scope map (which tool requires which scope).

---

## Quick cheat for tomorrow

When the interviewer asks "*walk me through the architecture*":

1. **Point at View 1.** *"Six TypeScript processes. Two servers, four clients. Plus one external service for inference."*
2. **Point at the two server boxes.** *"P1 is OAuth, P2 is the MCP server with the task board."*
3. **Point at orchestrator and workers.** *"P3 plus three of P4–P6. All are MCP clients over Streamable HTTP."*
4. **Trace one connection.** *"Worker claims a task — `POST /mcp` with Bearer JWT, JSON-RPC `tools/call` with name=claim_task. The server runs `BEGIN IMMEDIATE; SELECT; UPDATE; COMMIT` and returns the row or null."*
5. **Trace the LLM call.** *"Worker then `POST /v1/messages` to the DobbyAI proxy in Anthropic format. Proxy translates to OpenAI format, routes by model alias to gpt-oss-120b on the Blackwell. Worker reports the result back to the MCP server."*

Now you've shown them: the boot, the protocols, the OAuth scoping, the atomic claim, the LLM brain location, the audit trail. **In 90 seconds.**


