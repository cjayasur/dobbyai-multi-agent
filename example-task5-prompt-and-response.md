# Example Prompt &nbsp;·&nbsp; Task #5 (Experian Credit Pull)

The literal request body sent to `https://api.palomaressoftware.com/dobbyai/v1/messages`
for Task #5, plus the LLM's response, plus annotation of where each piece came from.

This is a **forensic reconstruction** — what worker-001 actually sent to gpt-oss-120b at `2026-05-29 06:50:57 UTC`.

---

## The HTTPS request body (Anthropic Messages API format)

```json
POST https://api.palomaressoftware.com/dobbyai/v1/messages
Content-Type: application/json
x-api-key: dk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   ← redacted; lives only in .env

{
  "model": "claude-opus-4-20250514",
  "max_tokens": 1024,
  "system": "<SYSTEM MESSAGE — see below>",
  "messages": [
    { "role": "user", "content": "<USER MESSAGE — see below>" }
  ],
  "chat_template_kwargs": { "enable_thinking": false }
}
```

---

## 🅢 SYSTEM message — sets the agent's identity + rules

*Source: `mortgage-worker.ts:SYSTEM_PROMPT` (lines 50–60). Hardcoded.*

```
You are a verification agent at DobbyBank, N.A., a US residential mortgage lender.
Your job is to examine ONE specific slice of a mortgage application (KYC, credit,
income, asset, employment, property, compliance, etc.) and return a focused JSON
verdict.

Be terse. 100-300 tokens. Always return valid JSON wrapped in a single ```json
code block. Cite specific data fields, regulations (12 CFR, Fannie Selling Guide),
or guideline sections when relevant. If data is missing or ambiguous, return
verdict "review" rather than "pass".

You are one of 19 agents working in parallel on the same application. Your slice
is narrow on purpose — do not try to make the final approve/decline decision;
that's the underwriter's job (a later stage). Just verify your slice and report.
```

---

## 🅤 USER message — composed at runtime by `llmVerify()`

The user message has FOUR sections, assembled by the ternary at the bottom of `llmVerify()`:

```
[1] TASK            ← hardcoded text from STAGES const in mortgage-orchestrator.ts
[2] POLICY BLOCK    ← loaded from disk: data/policy/dobbybank-underwriting-guidelines.md
[3] DATA BLOCK      ← loaded from disk: data/credit/experian-pull.json
[4] /no_think       ← Qwen3 magic token to disable reasoning mode
```

### What the LLM actually saw for Task #5:

```
TASK:
Credit bureau pull — Experian (FICO Score 8). Extract FICO + tradeline summary
+ flag any derogatories. Data: WellsFargoMortgage/data/credit/experian-pull.json.
Return JSON: {bureau, fico, derogatories: [], tradelines_count}.


──────────────────────────────────────
DOBBYBANK UNDERWRITING POLICY (grounding — cite §-numbers from THIS text):
──────────────────────────────────────
# DobbyBank, N.A. — Residential Mortgage Underwriting Guidelines (Excerpt)

> **Internal use only.** This excerpt aligns with Fannie Mae Selling Guide and
> Freddie Mac Single-Family Seller/Servicer Guide as of effective date.
> Effective: 2026-Q1.

## 1. Conventional Conforming Loan Limits

- 1-unit standard: $766,550 (2026)
- 1-unit high-cost area (Alameda County, CA): $1,149,825 (2026)
- 1-unit Castro Valley (94552): qualifies as high-cost — conforming up to $1,149,825

## 2. Credit Score Thresholds

| Score (mid of tri-merge) | Treatment                                  |
| ------------------------ | ------------------------------------------ |
| ≥ 740                    | Best pricing tier (LLPA grid floor)        |
| 720–739                  | Standard pricing                           |
| 680–719                  | LLPA add-on; pricing penalty               |
| 620–679                  | Manual underwriter review required         |
| < 620                    | DECLINE (sub-prime; refer to FHA channel) |

## 3. Loan-to-Value (LTV) Thresholds
[... §3-§10 follow with thresholds for LTV, DTI, reserves, income docs, assets,
appraisal, manual underwriter compensating factors, and compliance gates ...]

──────────────────────────────────────
DATA (WellsFargoMortgage/data/credit/experian-pull.json):
──────────────────────────────────────
{
  "_meta": {
    "bureau": "Experian",
    "loan_id": "LN-2026-1234",
    "pull_date": "2026-05-15T14:22:08-07:00",
    "pull_type": "Hard inquiry — mortgage",
    "scoring_model": "FICO Score 8 (mortgage variant)",
    "pulled_by": "DobbyBank, N.A. — NMLS #1234567"
  },
  "borrower": {
    "name": "Maria Lucia Rodriguez",
    "ssn_last4": "1234",
    "dob": "1985-07-22",
    "current_address": "2150 Stanton Ave Apt 12, Castro Valley CA 94546"
  },
  "fico_score": 740,
  "fico_range": "Very Good (740-799)",
  "score_factors": [
    "Length of credit history: 14 years (positive)",
    "Credit utilization: 11% (positive — below 30%)",
    "Recent inquiries: 2 in last 6 months (slight negative)",
    "No derogatory marks in last 24 months (positive)"
  ],
  "tradelines": [
    { "creditor": "Toyota Financial Services", "type": "Auto loan (installment)",
      "opened": "2022-09-15", "balance": 28000, "monthly_payment": 712,
      "status": "Current", "payment_history_24mo": "OOOOOOOOOOOOOOOOOOOOOOOO" },
    { "creditor": "Navient (Dept of Education servicer)", "type": "Student loan",
      "opened": "2007-09-01", "balance": 18500, "monthly_payment": 385,
      "status": "Current" },
    { "creditor": "Chase Sapphire Visa", "type": "Revolving",
      "credit_limit": 22000, "balance": 2300, "utilization_pct": 10.5,
      "status": "Current" },
    { "creditor": "American Express Gold", "type": "Charge card",
      "balance": 1850, "status": "Current — paid in full each cycle" },
    { "creditor": "Discover It", "type": "Revolving", "credit_limit": 15000,
      "balance": 0, "status": "Current — inactive" }
  ],
  "public_records": [],
  "collections": [],
  "bankruptcies": [],
  "recent_inquiries": [
    {"creditor": "DobbyBank, N.A.", "date": "2026-05-15", "type": "Mortgage"},
    {"creditor": "Apple Card", "date": "2025-11-08", "type": "Revolving"}
  ],
  "total_revolving_credit_limit": 37000,
  "total_revolving_balance": 4150,
  "aggregate_utilization_pct": 11.2,
  "summary_for_underwriter": "Prime borrower. No derogatory marks in tracking
    window. Utilization well below 30% threshold. Stable installment payment
    history on auto + student loan. Credit history depth (14 years) supports
    approval."
}

When you cite a guideline section (§2, §3, etc.), reference the policy text above.

/no_think
```

---

## 🧠 The LLM's actual response (clean JSON, no thinking preamble)

*Stored in `tasks.db` `tasks.result` column for `id=5`.*

```json
{
  "bureau": "Experian",
  "fico": 740,
  "derogatories": [],
  "tradelines_count": 5,
  "cites": [
    "§2 Credit Score Thresholds – score ≥740 meets best pricing tier; no derogatory marks in 24‑mo window per data"
  ]
}
```

**5 fields returned in 30 seconds.** Every field grounded:
- `bureau`: extracted from `_meta.bureau` in the JSON
- `fico`: extracted from `fico_score` in the JSON
- `derogatories`: empty because `public_records`, `collections`, `bankruptcies` are all `[]`
- `tradelines_count`: counted the tradelines array
- **`cites`: ★ this is the policy-grounding proof.** The model literally referenced "§2 Credit Score Thresholds" — that text only existed in the policy doc we attached, not in the data JSON.

---

## What this proves about the system

When the WF interviewer asks *"how do you know the model is reasoning from your policy and not making things up?"* you point at this file:

> *"Task 5's response cites '§2 Credit Score Thresholds' — that text only exists in `data/policy/dobbybank-underwriting-guidelines.md`, which we explicitly attach to every worker call. The model couldn't have invented that section number; it had to read it from the prompt. That's the grounding-by-construction property — RAG without a vector store, because we know which document is relevant per task."*

Then you show the line in `mortgage-worker.ts:llmVerify()`:

```typescript
let policyContents = "";
if (dataPath !== POLICY_DOC_PATH && !dataPath?.includes("compliance-checklist")) {
  policyContents = await readDataFile(POLICY_DOC_PATH);
  // ... truncate, then include in userMessage ...
}
```

> *"The policy doc is loaded fresh on every worker call. If the bank updates the policy, the next loan automatically uses the new thresholds — no cache invalidation, no retraining."*

---

## File breakdown by character count

| Section | Source | Size |
|---|---|---|
| SYSTEM prompt | hardcoded in `mortgage-worker.ts` | ~750 chars |
| TASK description | `STAGES` const in `mortgage-orchestrator.ts` | ~250 chars |
| POLICY DOC (truncated) | `data/policy/dobbybank-underwriting-guidelines.md` | ~6000 chars |
| DATA file | `data/credit/experian-pull.json` | ~2900 chars |
| Closing instruction + `/no_think` | hardcoded | ~100 chars |
| **Total prompt input** | | **~10,000 chars ≈ 2500 tokens** |
| Response | gpt-oss-120b | ~300 chars / ~80 tokens |
| **Round-trip latency** | over ngrok→tower→GX10 | **30.3 seconds** |

That latency is dominated by **input token processing time** on gpt-oss-120b (KV-cache build for 2500 input tokens) + **output generation** at ~40 tok/sec × 80 tokens = 2 sec.

In production on dedicated hardware with batching enabled, each call drops to ~5-8 seconds.
