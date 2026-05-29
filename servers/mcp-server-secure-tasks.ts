// Secure Tasks MCP Server — OAuth Bearer-gated, scope-enforced coordination
// substrate for Lesson 14 (multi-agent orchestration).
//
// Generalizes mcp-server-secure-demo.ts: instead of math tools, it exposes
// `list_open / get_task / claim_task / report_task / create_task` over a
// SQLite tasks table with the atomic-claim from Lesson 14 Part 3. Every
// transition is appended to a `task_events` audit log keyed by the JWT `sub`.
//
//   Worker  scopes:        mcp:tasks:read + mcp:tasks:claim + mcp:tasks:report
//   Orchestrator scopes:   mcp:tasks:read + mcp:tasks:create  (+ optional :assign)
//   Monitor  scopes:       mcp:tasks:read
//
// Run:    bun run src/mcp-server-secure-tasks.ts
// Port:   3500
// Needs:  bun oauth:server (3300) with task-scoped client entries added — see
//         docs/lesson14-demo.md for the 4-line patch to oauth-server-demo.ts.
//
// JWT_SECRET is shared verbatim with oauth-server-demo.ts (do not change in
// isolation; it must match). Audience binding: tokens with `aud` set MUST
// equal http://localhost:3500 — get tokens via:
//   POST /token … resource=http://localhost:3500

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac } from "crypto";
import * as crypto from "crypto";
import { Database } from "bun:sqlite";

const PORT = 3500;
const OAUTH_SERVER = "http://localhost:3300";
const JWT_SECRET = "dobbyai-oauth-demo-secret-change-in-production";   // MUST match oauth-server-demo.ts
const DB_PATH = process.env.TASKS_DB_PATH ?? "tasks.db";

// ─── DB bootstrap ───────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    description  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','done','failed')),
    depends_on   INTEGER REFERENCES tasks(id),
    claimed_by   TEXT,
    claimed_at   TEXT,
    reported_at  TEXT,
    result       TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS task_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER REFERENCES tasks(id),
    actor       TEXT NOT NULL,         -- JWT sub
    event       TEXT NOT NULL,         -- created|claimed|reported|scope_denied|race_lost
    scope       TEXT,                  -- token scopes at time of action
    data        TEXT,                  -- JSON blob (free-form)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
`);

function logEvent(taskId: number | null, actor: string, event: string, scope: string, data?: unknown) {
  db.prepare(
    "INSERT INTO task_events (task_id, actor, event, scope, data) VALUES (?, ?, ?, ?, ?)"
  ).run(taskId as any, actor, event, scope, data ? JSON.stringify(data) : null);
}

// ─── JWT validation (mirrors mcp-server-secure-demo.ts) ─────────

function verifyJWT(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (payload.aud && payload.aud !== `http://localhost:${PORT}`) return null;
    return payload;
  } catch {
    return null;
  }
}

function hasScope(payload: Record<string, any>, required: string): boolean {
  const scopes = (payload.scope ?? "").split(" ");
  return scopes.includes(required);
}

// ─── Scope map per tool ─────────────────────────────────────────

const TOOL_SCOPES: Record<string, string> = {
  list_open:    "mcp:tasks:read",
  get_task:     "mcp:tasks:read",
  claim_task:   "mcp:tasks:claim",
  report_task:  "mcp:tasks:report",
  create_task:  "mcp:tasks:create",
};

// ─── The Atomic Claim — Lesson 14 Part 3 ────────────────────────
// "The hard distributed-coordination problem reduces to: use a transaction."

function atomicClaim(actor: string, scope: string): { id: number; description: string } | null {
  // BEGIN IMMEDIATE acquires a RESERVED lock — SQLite serializes the critical
  // section across processes. The `AND status='open'` in the UPDATE is the
  // optimistic-concurrency check that makes the race safe even if two workers
  // pick the same row in the SELECT.
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(
      `SELECT id, description FROM tasks
       WHERE status='open'
         AND (depends_on IS NULL
              OR depends_on IN (SELECT id FROM tasks WHERE status='done'))
       ORDER BY id LIMIT 1`
    ).get() as { id: number; description: string } | undefined;

    if (!row) {
      db.exec("COMMIT");
      return null;
    }

    const now = new Date().toISOString();
    const result = db.prepare(
      "UPDATE tasks SET status='claimed', claimed_by=?, claimed_at=? WHERE id=? AND status='open'"
    ).run(actor, now, row.id);

    db.exec("COMMIT");

    if (result.changes === 0) {
      // Another worker won this row between our SELECT and UPDATE.
      logEvent(row.id, actor, "race_lost", scope, { picked: row.id });
      return null;
    }

    logEvent(row.id, actor, "claimed", scope);
    return row;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ─── MCP Server (per session, closure-bound to authPayload) ─────

function createMCPServer(authPayload: Record<string, any>): Server {
  const actor: string = authPayload.sub ?? "unknown";
  const scope: string = authPayload.scope ?? "";

  const server = new Server(
    { name: "secure-tasks-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_open",
        description: "List open + claimed tasks (requires mcp:tasks:read).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_task",
        description: "Fetch one task by id (requires mcp:tasks:read).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      },
      {
        name: "claim_task",
        description: "Atomically claim the next open task whose dependencies are met (requires mcp:tasks:claim). Returns the task or null.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "report_task",
        description: "Report a claimed task as done or failed (requires mcp:tasks:report).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            status: { type: "string", enum: ["done", "failed"] },
            result: { type: "string" },
          },
          required: ["id", "status"],
        },
      },
      {
        name: "create_task",
        description: "Create a new task (requires mcp:tasks:create).",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            depends_on: { type: ["number", "null"] },
          },
          required: ["description"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Per-call scope check — the SAME pattern Veeresh saw in Lesson 13, applied
    // here to coordination instead of math tools.
    const requiredScope = TOOL_SCOPES[name];
    if (requiredScope && !hasScope(authPayload, requiredScope)) {
      logEvent(null, actor, "scope_denied", scope, { tool: name, required: requiredScope });
      console.log(`  🚫 Scope denied: ${name} requires ${requiredScope}, agent has: ${scope}`);
      return {
        content: [{ type: "text", text: `Access denied: tool "${name}" requires scope "${requiredScope}". Your token has: ${scope}` }],
        isError: true,
      };
    }

    switch (name) {
      case "list_open": {
        const rows = db.prepare(
          "SELECT id, description, status, depends_on, claimed_by, claimed_at FROM tasks WHERE status IN ('open','claimed') ORDER BY id"
        ).all();
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }

      case "get_task": {
        const row = db.prepare("SELECT * FROM tasks WHERE id=?").get((args as any).id);
        return { content: [{ type: "text", text: JSON.stringify(row ?? null, null, 2) }] };
      }

      case "claim_task": {
        const claimed = atomicClaim(actor, scope);
        return { content: [{ type: "text", text: JSON.stringify(claimed) }] };
      }

      case "report_task": {
        const { id, status, result } = args as { id: number; status: "done" | "failed"; result?: string };
        const now = new Date().toISOString();
        const upd = db.prepare(
          "UPDATE tasks SET status=?, reported_at=?, result=? WHERE id=? AND claimed_by=?"
        ).run(status, now, result ?? "", id, actor);
        if (upd.changes === 0) {
          return { content: [{ type: "text", text: `Report rejected: task ${id} is not claimed by ${actor}.` }], isError: true };
        }
        logEvent(id, actor, "reported", scope, { status, result });
        return { content: [{ type: "text", text: `Reported task ${id} as ${status}.` }] };
      }

      case "create_task": {
        const { description, depends_on } = args as { description: string; depends_on?: number | null };
        const ins = db.prepare(
          "INSERT INTO tasks (description, depends_on, created_by) VALUES (?, ?, ?)"
        ).run(description, depends_on ?? null, actor);
        const newId = Number(ins.lastInsertRowid);
        logEvent(newId, actor, "created", scope, { description, depends_on });
        return { content: [{ type: "text", text: `Created task ${newId}.` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  });

  return server;
}

// ─── HTTP server with auth + Streamable HTTP transport ──────────

const transports = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      resource: `http://localhost:${PORT}`,
      authorization_servers: [OAUTH_SERVER],
      scopes_supported: [
        "mcp:tasks:read",
        "mcp:tasks:claim",
        "mcp:tasks:report",
        "mcp:tasks:create",
      ],
      bearer_methods_supported: ["header"],
    }));
    return;
  }

  if (url.pathname === "/mcp") {
    const authHeader = req.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      console.log(`  🚫 401 — No Bearer token`);
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="http://localhost:${PORT}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: "unauthorized", message: "Bearer token required" }));
      return;
    }

    const payload = verifyJWT(authHeader.slice(7));
    if (!payload) {
      console.log(`  🚫 401 — Invalid or expired token`);
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer error="invalid_token"`,
      });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    console.log(`  ✅ Authenticated: ${payload.sub} (scopes: ${payload.scope})`);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!sessionId) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, { transport, server: mcpServer });
            console.log(`  📡 Session: ${id.slice(0, 8)}... (agent: ${payload.sub})`);
          },
        });
        const mcpServer = createMCPServer(payload);
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } else {
        const entry = transports.get(sessionId);
        if (entry) await entry.transport.handleRequest(req, res, body);
        else { res.writeHead(400); res.end("Unknown session"); }
      }
    } else if (req.method === "GET") {
      const entry = sessionId ? transports.get(sessionId) : undefined;
      if (entry) await entry.transport.handleRequest(req, res);
      else { res.writeHead(400); res.end("Unknown session"); }
    } else if (req.method === "DELETE") {
      const entry = sessionId ? transports.get(sessionId) : undefined;
      if (entry) await entry.transport.handleRequest(req, res);
      else { res.writeHead(200); res.end(); }
    } else {
      res.writeHead(405); res.end("Method not allowed");
    }
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "Secure Tasks MCP Server (Lesson 14)",
      auth: "OAuth 2.1 Bearer required",
      metadata: `http://localhost:${PORT}/.well-known/oauth-protected-resource`,
      tools: Object.keys(TOOL_SCOPES),
      db: DB_PATH,
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`\n🧩 Secure Tasks MCP Server (OAuth 2.1, scope-enforced)`);
  console.log(`   http://localhost:${PORT}/mcp`);
  console.log(`   Auth metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
  console.log(`   OAuth server:  ${OAUTH_SERVER}`);
  console.log(`   DB:            ${DB_PATH}`);
  console.log(`\n   Scopes: mcp:tasks:read · mcp:tasks:claim · mcp:tasks:report · mcp:tasks:create`);
  console.log(`   Try without token → 401 · with worker token but create_task → scope denied`);
  console.log(`   Every transition is audited in task_events (actor = JWT sub).\n`);
});
