// OAuth 2.1 Token Server Demo — simulates Keycloak / Auth0
//
// Issues JWT access tokens for MCP agents.
// Supports: client_credentials grant (for autonomous agents)
// Validates: client_id + client_secret
// Scopes: mcp:tools:read, mcp:tools:write, mcp:tools:admin
//
// Run: bun oauth:server
// Port: 3300
//
// This is a TEACHING implementation — real production uses Keycloak
// (already on your tower) or Auth0. Same protocol, battle-tested.

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, randomBytes } from "crypto";

const PORT = 3300;
const JWT_SECRET = "dobbyai-oauth-demo-secret-change-in-production";

// ─── Registered clients (agents) ────────────────────────────────

const CLIENTS: Record<string, { secret: string; allowedScopes: string[]; name: string }> = {
  "dobbyai-agent-001": {
    secret: "agent001-secret-key",
    allowedScopes: ["mcp:tools:read", "mcp:tools:write"],
    name: "DobbyAI Main Agent",
  },
  "dobbyai-agent-readonly": {
    secret: "readonly-secret-key",
    allowedScopes: ["mcp:tools:read"],
    name: "DobbyAI Read-Only Agent",
  },
  "dobbyai-agent-admin": {
    secret: "admin-secret-key",
    allowedScopes: ["mcp:tools:read", "mcp:tools:write", "mcp:tools:admin"],
    name: "DobbyAI Admin Agent",
  },

  // ─── Lesson 14 multi-agent orchestration clients ───────────────
  // Per-role scopes enforce least-privilege at the protocol boundary.
  // The orchestrator can READ + CREATE tasks but CANNOT CLAIM or REPORT them.
  // A worker can READ + CLAIM + REPORT but CANNOT CREATE tasks.
  // Try the wrong-scope path on either side to see the audit log fire.
  "dobbyai-orchestrator": {
    secret: "orchestrator-secret-key",
    allowedScopes: ["mcp:tasks:read", "mcp:tasks:create"],
    name: "DobbyAI Orchestrator (Lesson 14)",
  },
  "dobbyai-worker-001": {
    secret: "worker-001-secret-key",
    allowedScopes: ["mcp:tasks:read", "mcp:tasks:claim", "mcp:tasks:report"],
    name: "DobbyAI Worker 001 (Lesson 14)",
  },
  "dobbyai-worker-002": {
    secret: "worker-002-secret-key",
    allowedScopes: ["mcp:tasks:read", "mcp:tasks:claim", "mcp:tasks:report"],
    name: "DobbyAI Worker 002 (Lesson 14)",
  },
  "dobbyai-worker-003": {
    secret: "worker-003-secret-key",
    allowedScopes: ["mcp:tasks:read", "mcp:tasks:claim", "mcp:tasks:report"],
    name: "DobbyAI Worker 003 (Lesson 14)",
  },
};

// ─── JWT helpers ────────────────────────────────────────────────

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function createJWT(payload: Record<string, any>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${signature}`;
}

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
    return payload;
  } catch {
    return null;
  }
}

// ─── Request body parser ────────────────────────────────────────

async function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();
  const params = new URLSearchParams(body);
  const obj: Record<string, string> = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

// ─── HTTP server ────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  // OAuth metadata discovery (RFC 8414)
  if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: `http://localhost:${PORT}`,
      authorization_endpoint: `http://localhost:${PORT}/authorize`,
      token_endpoint: `http://localhost:${PORT}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["client_credentials", "authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp:tools:read", "mcp:tools:write", "mcp:tools:admin"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    }));
    return;
  }

  // Token endpoint (client_credentials grant)
  if (url.pathname === "/token" && req.method === "POST") {
    const body = await parseBody(req);
    const { grant_type, client_id, client_secret, scope, resource } = body;

    if (grant_type !== "client_credentials") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type", error_description: "Only client_credentials supported in this demo" }));
      return;
    }

    const client = CLIENTS[client_id];
    if (!client || client.secret !== client_secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client", error_description: "Invalid client_id or client_secret" }));
      return;
    }

    // Validate requested scopes
    const requestedScopes = (scope ?? "").split(" ").filter(Boolean);
    const grantedScopes = requestedScopes.length > 0
      ? requestedScopes.filter(s => client.allowedScopes.includes(s))
      : client.allowedScopes;

    if (grantedScopes.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_scope", error_description: "No valid scopes requested" }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;

    const token = createJWT({
      iss: `http://localhost:${PORT}`,
      sub: client_id,
      aud: resource ?? "http://localhost:3400",
      scope: grantedScopes.join(" "),
      iat: now,
      exp: now + expiresIn,
      jti: randomBytes(16).toString("hex"),
      client_name: client.name,
    });

    console.log(`  🔑 Token issued: ${client_id} → scopes: ${grantedScopes.join(", ")}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: grantedScopes.join(" "),
    }));
    return;
  }

  // Token introspection (for MCP servers to validate tokens)
  if (url.pathname === "/introspect" && req.method === "POST") {
    const body = await parseBody(req);
    const payload = verifyJWT(body.token ?? "");
    if (!payload) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active: false }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active: true, ...payload }));
    return;
  }

  // Health check
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "DobbyAI OAuth Server Demo", status: "running", clients: Object.keys(CLIENTS).length }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// Export verifyJWT for the secure MCP server to use
export { verifyJWT, JWT_SECRET };

server.listen(PORT, () => {
  console.log(`\n🔐 OAuth 2.1 Token Server (Demo)`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Metadata: http://localhost:${PORT}/.well-known/oauth-authorization-server`);
  console.log(`   Token:    POST http://localhost:${PORT}/token`);
  console.log(`\n   Registered agents:`);
  for (const [id, client] of Object.entries(CLIENTS)) {
    console.log(`     ${id} (${client.name}) → scopes: ${client.allowedScopes.join(", ")}`);
  }
  console.log();
});
