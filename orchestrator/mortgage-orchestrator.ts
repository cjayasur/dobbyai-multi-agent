// mortgage-orchestrator.ts — DobbyAI Multi-Agent Mortgage Underwriting
//
// Stage-by-stage orchestrator. For each stage:
//   1. create_task() for every subtask in the stage
//   2. poll the board until all stage tasks are 'done' (or 'failed')
//   3. advance to next stage
// After all stages:
//   4. call DobbyAI proxy to LLM-synthesize the final underwriting decision
//      from the audit trail.
//
// Two design choices worth noting for the interview:
//
//   (a) Stage gating is done by the ORCHESTRATOR (polling), not by SQL
//       depends_on, for this demo. The secure-tasks server supports SQL-level
//       depends_on for arbitrary DAG topologies (see lesson14.md Part 8).
//       For mortgage triage, the linear stage progression is simpler to read
//       in the Loom and equally correct.
//
//   (b) The aggregate step is a REAL LLM call (DobbyAI proxy → Qwen3.6-35B
//       on GX10). The orchestrator collects all worker results from the
//       audit trail and synthesizes the underwriting decision. The interview
//       punchline: "every coordination action is an auditable row, and the
//       LLM only reasons over rows it can name."
//
// Run:
//   1.  bun run src/oauth-server-demo.ts                 (port 3300)
//   2.  bun run src/mcp-server-secure-tasks.ts           (port 3500)
//   3.  bun run WellsFargoMortgage/mortgage-orchestrator.ts
//   4.  bun run WellsFargoMortgage/mortgage-worker.ts    (one or more in parallel)
//
// Env:
//   DOBBYAI_API_URL    Anthropic-format messages endpoint (default: localhost proxy)
//   DOBBYAI_API_KEY    API key for the proxy (optional for localhost)
//   DOBBYAI_MODEL      Model alias (default: claude-sonnet-4-20250514)
//   TASKS_DB_PATH      Path to the SQLite tasks board (default: tasks.db)

import { Database } from "bun:sqlite";

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

const OAUTH_TOKEN_URL  = process.env.OAUTH_TOKEN_URL  ?? "http://localhost:3300/token";
const TASKS_MCP_URL    = process.env.TASKS_MCP_URL    ?? "http://localhost:3500/mcp";
const TASKS_RESOURCE   = process.env.TASKS_RESOURCE   ?? "http://localhost:3500";
const TASKS_DB_PATH    = process.env.TASKS_DB_PATH    ?? "tasks.db";

const CLIENT_ID        = process.env.MCP_CLIENT_ID     ?? "dobbyai-orchestrator";
const CLIENT_SECRET    = process.env.MCP_CLIENT_SECRET ?? "orchestrator-secret-key";
const SCOPES           = process.env.MCP_SCOPES        ?? "mcp:tasks:read mcp:tasks:create";

// Falls back to AGENT_* (matching claude-code-simple/.env) — keeps secrets in .env, not shell history
const DOBBYAI_API_URL  = process.env.DOBBYAI_API_URL  ?? process.env.AGENT_API_URL  ?? "https://api.anthropic.com/v1/messages";
const DOBBYAI_API_KEY  = process.env.DOBBYAI_API_KEY  ?? process.env.AGENT_API_KEY  ?? "";

// Tiered model strategy:
//   DOBBYAI_MODEL            → used for orchestrator's decompose calls (when adaptive)
//   DOBBYAI_AGGREGATE_MODEL  → used for the single aggregate / synthesis call
//                              (defaults to opus alias → gpt-oss-120b on GX10 :8080)
// Workers use DOBBYAI_MODEL (sonnet alias → Qwen-35B-A3B), see mortgage-worker.ts.
const DOBBYAI_MODEL           = process.env.DOBBYAI_MODEL           ?? process.env.AGENT_MODEL ?? "claude-sonnet-4-20250514";
const DOBBYAI_AGGREGATE_MODEL = process.env.DOBBYAI_AGGREGATE_MODEL ?? "claude-opus-4-20250514";

// Aggregate-side thinking-mode toggle.
//   DEFAULT: ON. The aggregate is a synthesis-over-19-reports step — novel
//   reasoning is exactly what we want visible, and reasoning chains are the
//   demo's compliance gold (every step of the credit decision is in the
//   audit trail).
//   Override with DOBBYAI_AGGREGATE_THINKING=false to get a clean document
//   without a <think> block (useful for printed briefings).
const AGGREGATE_THINKING     = (process.env.DOBBYAI_AGGREGATE_THINKING ?? "true").toLowerCase() !== "false";
const AGGREGATE_MAX_TOKENS   = AGGREGATE_THINKING ? 8192 : 4096;

const POLL_MS = 2000;
const STAGE_TIMEOUT_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────
// The Mortgage Underwriting Decomposition
// ────────────────────────────────────────────────────────────────────
//
// 19 subtasks across 6 stages. Each task description points its worker at a
// data file under WellsFargoMortgage/data/. Workers reason over that data
// using the DobbyAI proxy and report back a JSON verdict.

type StageTask = { description: string };
type Stage = { name: string; tasks: StageTask[] };

const STAGES: Stage[] = [
  {
    name: "STAGE 1 — Intake / KYC",
    tasks: [
      { description: "KYC verification. Review Form 1003 Section 2 (Borrower). Confirm identity, marital status, SSN consistency, dependents. Data: WellsFargoMortgage/data/application/form-1003-LN-2026-1234.json. Return JSON: {verdict: 'pass'|'fail'|'review', findings: [...], risk_flags: [...]}." },
      { description: "Driver-license + SSN consistency check. Cross-reference name + DOB across documents. Data: WellsFargoMortgage/data/application/form-1003-LN-2026-1234.json. Return JSON verdict." },
      { description: "OFAC / SDN sanctions screen. Borrower name + DOB against Treasury Specially Designated Nationals list. Reference 31 CFR 501. Return JSON: {match: bool, list_version: str, verdict: 'pass'|'block'}." },
      { description: "Address history verification — confirm 24+ months of residency per Reg X. Cross-check current + prior address consistency. Data: WellsFargoMortgage/data/application/form-1003-LN-2026-1234.json." },
    ],
  },

  {
    name: "STAGE 2a — Credit Bureau Pulls (parallel)",
    tasks: [
      { description: "Credit bureau pull — Experian (FICO Score 8). Extract FICO + tradeline summary + flag any derogatories. Data: WellsFargoMortgage/data/credit/experian-pull.json. Return JSON: {bureau, fico, derogatories: [], tradelines_count}." },
      { description: "Credit bureau pull — Equifax (FICO Score 5). Extract FICO + tradelines. Data: WellsFargoMortgage/data/credit/equifax-pull.json. Return JSON." },
      { description: "Credit bureau pull — TransUnion (FICO Score 4). Extract FICO + tradelines. Data: WellsFargoMortgage/data/credit/transunion-pull.json. Return JSON." },
    ],
  },

  {
    name: "STAGE 2b — Tri-merge Credit Analysis",
    tasks: [
      { description: "Tri-merge credit analysis. Reconcile FICO scores across Experian (FICO 8), Equifax (FICO 5), TransUnion (FICO 4). Apply Fannie Mae convention: use MID-SCORE (middle of three) as qualifying FICO. Identify any tradelines reported by some bureaus but not others. Data: WellsFargoMortgage/data/credit/{experian,equifax,transunion}-pull.json. Return JSON: {mid_score, lowest, highest, variance_explained: str, qualifying_tier: str (per DobbyBank guideline §2)}." },
    ],
  },

  {
    name: "STAGE 3 — Financial Verification (parallel)",
    tasks: [
      { description: "Income verification. Reconcile W-2s (2024 + 2025), recent paystubs, and IRS Form 4506-C transcript. Compute 24-month qualifying income per Fannie Mae Selling Guide B3-3.1-01. Data: WellsFargoMortgage/data/income/income-bundle.json. Return JSON: {qualifying_monthly_income, method, irs_match: bool, verdict}." },
      { description: "Asset verification. Review bank statements + brokerage + retirement accounts. Confirm down payment + 2-mo PITI reserves available. Flag any undocumented large deposits (AML/BSA hygiene). Data: WellsFargoMortgage/data/assets/asset-bundle.json. Return JSON: {liquid_total, lending_adjusted_total, undocumented_deposits: [], verdict}." },
      { description: "Employment verification (VOE). Confirm position, start date, salary continuity, no termination notice. Data: WellsFargoMortgage/data/employment/voe-response.json. Return JSON: {position, years, salary_confirmed, continuation_likelihood, verdict}." },
      { description: "Debt-to-income (DTI) calculation. Compute front-end DTI (PITI / income) and back-end DTI ((PITI + recurring debts) / income). Cross-reference DobbyBank guidelines §4 for thresholds. Data: WellsFargoMortgage/data/application/form-1003-LN-2026-1234.json. Return JSON: {front_end_dti, back_end_dti, qm_safe_harbor: bool, verdict}." },
    ],
  },

  {
    name: "STAGE 4 — Property (parallel)",
    tasks: [
      { description: "Appraisal review (Form 1004 URAR). Verify appraised value supports contract price. Check comp quality (3 closed, within 12 mo, within 1 mi). Cross-check UAD compliance. Data: WellsFargoMortgage/data/property/property-bundle.json. Return JSON: {appraised_value, contract_price, ltv_at_appraised, comps_acceptable: bool, verdict}." },
      { description: "Title commitment review. Confirm title vests in seller, identify Schedule B exceptions (CC&Rs, easements). Verify no derogatory liens. Confirm title insurance policy amount = loan amount. Data: WellsFargoMortgage/data/property/property-bundle.json. Return JSON: {clear_title: bool, exceptions: [], policy_amount, verdict}." },
      { description: "Hazard insurance verification. Confirm HO-6 policy effective at close, lender named as mortgagee, coverage meets DobbyBank minimums. Data: WellsFargoMortgage/data/property/property-bundle.json. Return JSON: {carrier, coverage_adequate: bool, mortgagee_listed: bool, verdict}." },
    ],
  },

  {
    name: "STAGE 5 — Underwriting Decision",
    tasks: [
      { description: "Underwriter decision. Synthesize ALL prior stage findings. Apply DobbyBank Underwriting Guidelines: §2 (credit), §3 (LTV), §4 (DTI), §5 (reserves). Approve / approve-with-conditions / decline. Data: read all stage 1-4 verdicts from task_events log + WellsFargoMortgage/data/policy/dobbybank-underwriting-guidelines.md. Return JSON: {decision: 'approve'|'approve_with_conditions'|'decline', conditions: [], compensating_factors: [], reasoning: str}." },
    ],
  },

  {
    name: "STAGE 6 — Compliance (sequential)",
    tasks: [
      { description: "TRID compliance check. Verify Loan Estimate delivered ≤ 3 business days of application, fee tolerances respected. Reference checklist T1-T7. Data: WellsFargoMortgage/data/policy/compliance-checklist.md. Return JSON: {checks_passed: [], checks_failed: [], verdict}." },
      { description: "HMDA data preparation. Confirm Section 7 government-monitoring fields collected. Validate denial-reason coding (if applicable). Reference checklist H1-H5. Data: WellsFargoMortgage/data/policy/compliance-checklist.md. Return JSON." },
      { description: "ECOA + QM/ATR compliance. Verify no prohibited basis used in decision. Verify DTI ≤ 43% (QM safe harbor) or compensating factors documented. Reference checklist E1-E4 + Q1-Q7. Data: WellsFargoMortgage/data/policy/compliance-checklist.md. Return JSON." },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────
// OAuth + MCP plumbing (mirrors the existing src/mcp-orchestrator.ts)
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
// Stage-by-stage progression
// ────────────────────────────────────────────────────────────────────

async function createStageTasks(token: string, stage: Stage): Promise<number[]> {
  console.log(`\n📝 ${stage.name} — creating ${stage.tasks.length} tasks`);
  const ids: number[] = [];
  for (const t of stage.tasks) {
    const r = await toolCall(token, "create_task", { description: t.description });
    const msg = resultText(r);
    const m = msg.match(/Created task (\d+)/);
    if (m) ids.push(Number(m[1]));
    console.log(`   • ${msg}`);
  }
  return ids;
}

async function waitForStage(token: string, stageIds: number[]): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STAGE_TIMEOUT_MS) {
    const r = await toolCall(token, "list_open", {});
    const open = JSON.parse(resultText(r) || "[]") as any[];
    const stillOpen = open.filter(t => stageIds.includes(t.id));
    if (stillOpen.length === 0) {
      console.log(`   ✅ Stage complete (${stageIds.length}/${stageIds.length} tasks done).`);
      return;
    }
    const summary = stillOpen
      .map(t => `#${t.id}${t.claimed_by ? `→${t.claimed_by}` : ""}(${t.status})`)
      .join(" · ");
    console.log(`   … waiting (${stillOpen.length}/${stageIds.length} still open): ${summary}`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`Stage timeout — ${stageIds.length} tasks did not complete in time`);
}

// ────────────────────────────────────────────────────────────────────
// LLM Aggregate — the orchestrator's second "brain moment"
// ────────────────────────────────────────────────────────────────────

async function collectAllResults(taskIds: number[]): Promise<Array<{ id: number; description: string; result: string }>> {
  // Filter by the IDs this orchestrator created this run — keeps the
  // aggregate clean even if the shared tasks.db has leftover rows from
  // prior runs.
  const db = new Database(TASKS_DB_PATH);
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, description, result FROM tasks WHERE id IN (${placeholders}) AND status='done' ORDER BY id`
  ).all(...taskIds) as any[];
  db.close();
  return rows;
}

async function aggregateWithLLM(results: Array<{ id: number; description: string; result: string }>): Promise<string> {
  const prompt = `You are a senior mortgage underwriting officer at DobbyBank, N.A. You have just received reports from 19 verification agents who each examined one slice of a mortgage application (loan LN-2026-1234, $750,000 purchase, borrower Maria L. Rodriguez).

Your job is to synthesize their findings into a FINAL UNDERWRITING DECISION + reasoning.

Apply DobbyBank Underwriting Guidelines: credit (§2), LTV (§3), DTI (§4), reserves (§5).

Here are the agent reports, in order:

${results.map(r => `--- Task #${r.id} ---\n${r.description.slice(0, 200)}...\n\nReport:\n${r.result}\n`).join("\n")}

Produce a final decision in this exact structure:

# Underwriting Decision — Loan LN-2026-1234

## Decision
[APPROVE | APPROVE WITH CONDITIONS | DECLINE]

## Borrower Risk Profile
- FICO (mid): ___
- LTV: ___%
- Front-end DTI: ___%
- Back-end DTI: ___%
- Reserves (months PITI): ___

## Reasoning
[2-3 paragraph synthesis citing specific task numbers]

## Conditions (if applicable)
[List]

## Compliance Sign-Off
- TRID: pass/fail
- HMDA: complete/incomplete
- ECOA: clean/flagged
- QM/ATR: safe harbor / rebuttable / outside

## Audit Trail Note
[One sentence confirming the decision is reconstructable from task_events]
`;

  console.log(`\n🧠 Aggregate — calling LLM with ${results.length} task reports...`);

  // Aggregate uses a BIGGER model than workers (opus alias → gpt-oss-120b on
  // GX10:8080). Workers stay on sonnet alias (Qwen-35B-A3B). Tiered model
  // assignment: fast-narrow for 19 worker calls, slow-smart for one synthesis.
  console.log(`   model:    ${DOBBYAI_AGGREGATE_MODEL}  (workers used ${DOBBYAI_MODEL})`);
  console.log(`   thinking: ${AGGREGATE_THINKING ? "ON  (max_tokens=8192)" : "OFF (max_tokens=4096)"}`);

  const body: any = {
    model: DOBBYAI_AGGREGATE_MODEL,
    max_tokens: AGGREGATE_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
    // Thinking ON by default for aggregate — synthesis-over-19-reports is
    // exactly where reasoning earns its keep, and the <think> block IS the
    // compliance gold for the demo (visible LLM reasoning over each verdict).
    chat_template_kwargs: { enable_thinking: AGGREGATE_THINKING },
  };

  const headers: any = { "Content-Type": "application/json" };
  if (DOBBYAI_API_KEY.startsWith("sk-ant-")) {
    headers["x-api-key"] = DOBBYAI_API_KEY;
    headers["anthropic-version"] = "2023-06-01";
  } else if (DOBBYAI_API_KEY) {
    headers["x-api-key"] = DOBBYAI_API_KEY;
  }

  // Retry with exponential backoff. ngrok-fronted proxies can hit transient
  // ECONNRESET on long-context calls — production-grade response is retry,
  // not crash. Aggregate is ONE call so the latency cost of retry is acceptable.
  const MAX_ATTEMPTS = 3;
  let res: Response | undefined;
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(DOBBYAI_API_URL, { method: "POST", headers, body: JSON.stringify(body) });
      if (res.ok) break;
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) {
        const backoffSec = attempt * 5;            // 5s, 10s
        console.log(`   ⚠ Aggregate LLM call attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(e as Error).message}`);
        console.log(`   ↻ Retrying in ${backoffSec}s...`);
        await new Promise(r => setTimeout(r, backoffSec * 1000));
      }
    }
  }
  if (!res || !res.ok) throw new Error(`Aggregate LLM call failed after ${MAX_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? "unknown"}`);

  const j = await res.json();
  const text = j.content?.[0]?.text ?? j.completion ?? JSON.stringify(j);
  return text;
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏦 DobbyBank, N.A. — Mortgage Underwriting Orchestrator`);
  console.log(`   Loan: LN-2026-1234  |  Borrower: Maria L. Rodriguez  |  Amount: $750,000\n`);

  const token = await getToken();
  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dobbyai-orchestrator", version: "1.0.0" },
  }, token);
  await mcp("notifications/initialized", {}, token, true);
  console.log(`  📡 Session: ${sessionId?.slice(0, 8) ?? "?"}`);

  // Stage-by-stage progression — track all created IDs so aggregate is
  // scoped to THIS run.
  const allCreatedIds: number[] = [];
  for (const stage of STAGES) {
    const ids = await createStageTasks(token, stage);
    allCreatedIds.push(...ids);
    await waitForStage(token, ids);
  }

  // Aggregate
  const results = await collectAllResults(allCreatedIds);
  const decision = await aggregateWithLLM(results);

  console.log(`\n${"═".repeat(78)}`);
  console.log(decision);
  console.log(`${"═".repeat(78)}\n`);

  console.log(`📋 Full audit trail: sqlite3 ${TASKS_DB_PATH} "SELECT * FROM task_events ORDER BY id"`);
  console.log(`✅ Orchestration complete.\n`);
}

main().catch(err => {
  if (String(err.message).includes("AUTH_REVOKED")) {
    console.error("\n🚫 Orchestrator token revoked. Stopping.");
    process.exit(1);
  }
  console.error("Orchestrator error:", err);
  process.exit(1);
});
