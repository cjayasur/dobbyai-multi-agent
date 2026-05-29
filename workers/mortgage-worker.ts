// mortgage-worker.ts — A DobbyAI Worker that does REAL mortgage verification
//
// Workflow per claim:
//   1. claim_task() (atomic via BEGIN IMMEDIATE on the secure-tasks board)
//   2. Parse the task description — extract "Data: <path>" reference if any
//   3. Read the referenced data file from WellsFargoMortgage/data/
//   4. Build a focused prompt: system role + task instruction + the data slice
//   5. Call the DobbyAI proxy (Anthropic Messages API format)
//   6. Capture the LLM response as the task result
//   7. report_task(done) — idempotent via WHERE claimed_by=?
//
// Launch multiple workers in parallel terminals to demonstrate the atomic claim
// in action (they will race for tasks; SQLite BEGIN IMMEDIATE arbitrates):
//
//   Terminal A:
//     MCP_CLIENT_ID=dobbyai-worker-001 MCP_CLIENT_SECRET=worker-001-secret-key \
//         bun run WellsFargoMortgage/mortgage-worker.ts
//
//   Terminal B:
//     MCP_CLIENT_ID=dobbyai-worker-002 MCP_CLIENT_SECRET=worker-002-secret-key \
//         bun run WellsFargoMortgage/mortgage-worker.ts
//
//   Terminal C:
//     MCP_CLIENT_ID=dobbyai-worker-003 MCP_CLIENT_SECRET=worker-003-secret-key \
//         bun run WellsFargoMortgage/mortgage-worker.ts
//
// (The OAuth server needs entries for each — see WellsFargoMortgage/oauth-clients.md
//  for the patch to oauth-server-demo.ts.)

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";

// ────────────────────────────────────────────────────────────────────
// Config (env-driven)
// ────────────────────────────────────────────────────────────────────

const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? "http://localhost:3300/token";
const TASKS_MCP_URL   = process.env.TASKS_MCP_URL   ?? "http://localhost:3500/mcp";
const TASKS_RESOURCE  = process.env.TASKS_RESOURCE  ?? "http://localhost:3500";

const CLIENT_ID       = process.env.MCP_CLIENT_ID     ?? "dobbyai-worker-001";
const CLIENT_SECRET   = process.env.MCP_CLIENT_SECRET ?? "worker-001-secret-key";
const SCOPES          = process.env.MCP_SCOPES        ?? "mcp:tasks:read mcp:tasks:claim mcp:tasks:report";

// Falls back to AGENT_* (matching claude-code-simple/.env) — keeps secrets in .env, not shell history
const DOBBYAI_API_URL = process.env.DOBBYAI_API_URL ?? process.env.AGENT_API_URL ?? "https://api.anthropic.com/v1/messages";
const DOBBYAI_API_KEY = process.env.DOBBYAI_API_KEY ?? process.env.AGENT_API_KEY ?? "";
const DOBBYAI_MODEL   = process.env.DOBBYAI_MODEL   ?? process.env.AGENT_MODEL   ?? "claude-sonnet-4-20250514";

const REPO_ROOT       = process.env.REPO_ROOT ?? resolve(import.meta.dir, "..");
const POLL_MS         = 1500;
const IDLE_LIMIT      = 60;    // exit after N idle polls (~90s of nothing-to-do)
                                // — was 25, but stage transitions with thinking-on workers
                                // can leave the board empty for 30-60s while the slowest
                                // worker finishes; need slack to keep workers alive.

// ────────────────────────────────────────────────────────────────────
// LLM-driven verification — the heart of the worker
// ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a verification agent at DobbyBank, N.A., a US residential mortgage lender. Your job is to examine ONE specific slice of a mortgage application (KYC, credit, income, asset, employment, property, compliance, etc.) and return a focused JSON verdict.

Be terse. 100-300 tokens. Always return valid JSON wrapped in a single \`\`\`json code block. Cite specific data fields, regulations (12 CFR, Fannie Selling Guide), or guideline sections when relevant. If data is missing or ambiguous, return verdict "review" rather than "pass".

You are one of 19 agents working in parallel on the same application. Your slice is narrow on purpose — do not try to make the final approve/decline decision; that's the underwriter's job (a later stage). Just verify your slice and report.`;

/** Extract a "Data: WellsFargoMortgage/data/..." reference from a task description. */
function extractDataPath(description: string): string | null {
  const m = description.match(/Data:\s*([\w/.\-]+\.(?:json|md))/);
  return m ? m[1] : null;
}

async function readDataFile(relPath: string): Promise<string> {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return `(data file not found: ${relPath})`;
  return await readFile(abs, "utf8");
}

// Always attach the DobbyBank policy document to every worker call so the
// model reasons from EXPLICIT policy text, not just training-data knowledge of
// standard Fannie/Freddie conventions. This is the RAG-grounding upgrade.
// An auditor can reconstruct every verdict's reasoning from the policy text the
// model literally saw — not from "the model knew."
const POLICY_DOC_PATH = "WellsFargoMortgage/data/policy/dobbybank-underwriting-guidelines.md";

async function llmVerify(taskDescription: string): Promise<string> {
  const dataPath = extractDataPath(taskDescription);
  let dataContents = "";
  if (dataPath) {
    dataContents = await readDataFile(dataPath);
    // truncate huge files (policy docs are big) — first 8KB is plenty for the slice
    if (dataContents.length > 8192) dataContents = dataContents.slice(0, 8192) + "\n... [truncated]";
  }

  // Load policy doc as grounding context. Skip if the task's own data IS the
  // policy doc (avoid duplicating it for the compliance tasks #17-#19).
  let policyContents = "";
  if (dataPath !== POLICY_DOC_PATH && !dataPath?.includes("compliance-checklist")) {
    policyContents = await readDataFile(POLICY_DOC_PATH);
    if (policyContents.length > 6000) policyContents = policyContents.slice(0, 6000) + "\n... [truncated]";
  }

  // The Qwen3 chat-template-kwargs path (chat_template_kwargs.enable_thinking)
  // is NOT being honored by our current proxy/vLLM combo — verified empirically:
  // every result started with "Here's a thinking process:" and ate 20-60s.
  //
  // Fallback: Qwen3 supports a magic `/no_think` token in the USER MESSAGE
  // that disables reasoning mode for that specific call. This is the
  // documented user-side off-switch.
  const NO_THINK = "\n\n/no_think";

  const policyBlock = policyContents
    ? `\n\n──────────────────────────────────────\nDOBBYBANK UNDERWRITING POLICY (grounding — cite §-numbers from THIS text):\n──────────────────────────────────────\n${policyContents}\n`
    : "";

  const userMessage = dataPath
    ? `TASK:\n${taskDescription}${policyBlock}\n\n──────────────────────────────────────\nDATA (${dataPath}):\n──────────────────────────────────────\n${dataContents}\n\nWhen you cite a guideline section (§2, §3, etc.), reference the policy text above.${NO_THINK}`
    : `TASK:\n${taskDescription}${policyBlock}\n\n(No specific data file referenced — synthesize from the application context using the policy above.)${NO_THINK}`;

  const body: any = {
    model: DOBBYAI_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    // Kept as belt-and-suspenders even though the proxy doesn't honor it yet.
    // The /no_think suffix above is what's actually doing the work.
    chat_template_kwargs: { enable_thinking: false },
  };

  const headers: any = { "Content-Type": "application/json" };
  if (DOBBYAI_API_KEY.startsWith("sk-ant-")) {
    headers["x-api-key"] = DOBBYAI_API_KEY;
    headers["anthropic-version"] = "2023-06-01";
  } else if (DOBBYAI_API_KEY) {
    headers["x-api-key"] = DOBBYAI_API_KEY;
  }

  const res = await fetch(DOBBYAI_API_URL, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`LLM call failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.content?.[0]?.text ?? j.completion ?? JSON.stringify(j);
}

// ────────────────────────────────────────────────────────────────────
// OAuth + MCP plumbing (mirrors existing src/mcp-worker.ts)
// ────────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: SCOPES,
    resource: TASKS_RESOURCE,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  const j = await res.json();
  console.log(`  🔑 Token granted for ${CLIENT_ID} — scopes: ${j.scope}`);
  return j.access_token as string;
}

let sessionId: string | undefined;

async function mcp(method: string, params: any, token: string, isNotification = false): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params };

  const res = await fetch(TASKS_MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 401) throw new Error("AUTH_REVOKED");
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) sessionId = newSession;
  if (isNotification) return null;

  const text = await res.text();
  try { return JSON.parse(text); } catch {
    for (const line of text.split("\n")) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m) try { return JSON.parse(m[1]); } catch { /* keep scanning */ }
    }
    throw new Error(`Could not parse MCP response: ${text.slice(0, 200)}`);
  }
}

const toolCall = (token: string, name: string, args: any = {}) =>
  mcp("tools/call", { name, arguments: args }, token);

const resultText = (rpc: any): string =>
  rpc?.result?.content?.[0]?.text ?? rpc?.error?.message ?? "";

// ────────────────────────────────────────────────────────────────────
// Worker main loop
// ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 DobbyAI Mortgage Verification Worker (${CLIENT_ID})`);
  console.log(`   LLM: ${DOBBYAI_MODEL} @ ${DOBBYAI_API_URL}`);

  const token = await getToken();

  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: CLIENT_ID, version: "1.0.0" },
  }, token);
  await mcp("notifications/initialized", {}, token, true);
  console.log(`  📡 Session: ${sessionId?.slice(0, 8) ?? "?"}\n`);

  let idle = 0;
  let tasksHandled = 0;
  const startedAt = Date.now();

  while (true) {
    const r = await toolCall(token, "claim_task", {});
    const claimed = JSON.parse(resultText(r) || "null");

    if (!claimed) {
      idle++;
      if (idle >= IDLE_LIMIT) {
        const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`\n💤 ${CLIENT_ID} idle ${IDLE_LIMIT}× — exiting. Handled ${tasksHandled} tasks in ${dur}s.`);
        return;
      }
      await new Promise(r => setTimeout(r, POLL_MS));
      continue;
    }
    idle = 0;

    console.log(`\n  🎯 claimed #${claimed.id}`);
    console.log(`     ${claimed.description.slice(0, 100)}${claimed.description.length > 100 ? "..." : ""}`);

    const t0 = Date.now();
    try {
      const llmResult = await llmVerify(claimed.description);
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

      // Brief on-console preview
      const preview = llmResult.replace(/\s+/g, " ").slice(0, 160);
      console.log(`     ⏱  ${elapsedSec}s  →  ${preview}${llmResult.length > 160 ? "..." : ""}`);

      const rep = await toolCall(token, "report_task", {
        id: claimed.id,
        status: "done",
        result: llmResult,
      });
      console.log(`     ✅ ${resultText(rep)}`);
      tasksHandled++;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`     ❌ LLM error: ${msg}`);
      await toolCall(token, "report_task", {
        id: claimed.id,
        status: "failed",
        result: `worker exception: ${msg}`,
      }).catch(() => {});
      if (msg.includes("AUTH_REVOKED")) throw e;
    }
  }
}

main().catch(err => {
  if (String(err.message).includes("AUTH_REVOKED")) {
    console.error(`\n🚫 ${CLIENT_ID}: token revoked. Exiting.`);
    process.exit(0);
  }
  console.error(`${CLIENT_ID} fatal error:`, err);
  process.exit(1);
});
