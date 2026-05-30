# Thinking-Budget Comparison &nbsp;·&nbsp; 8K vs 24K Aggregate

**Empirical comparison of two runs of the same demo, identical inputs, only difference:** `DOBBYAI_AGGREGATE_MAX_TOKENS`.

This document is the evidence that **token budget on the aggregate's "brain moment" materially changes the quality of regulatory reasoning** — not just the verbosity of the output. It's the operational lever a compliance team can pull for complex cases.

---

## TL;DR

| | 8K (default) | 24K (3× override) |
|---|---|---|
| Decision | APPROVE WITH CONDITIONS | APPROVE WITH CONDITIONS |
| Mid-FICO read | 735 *(averaged — wrong)* | **740** *(median of 740/738/745 — correct per Fannie)* |
| Back-end DTI | "36.95%" *(confabulated)* | **"N/A – pending" *(flagged correctly)*** |
| QM/ATR sign-off | "safe harbor" *(over-generous)* | **"outside safe-harbor" *(production-correct)*** |
| Conditions listed | 6 | **8** |
| Policy §-citations | 1 | **4 inline (§2, §3, §4, §5)** |
| Runtime | ~3–4 min | **~10 min** |
| Suitable for | Clean cases, live demo | Complex/borderline applications, audit-grade review |

**The 24K version is empirically the better production output.** The 8K version made a regulatory error: it claimed QM/ATR safe-harbor when the back-end DTI hadn't been verified. The 24K version caught the gap and downgraded the verdict appropriately.

---

## How to reproduce

Both runs use **identical** inputs:
- Same 19-task decomposition
- Same Form 1003 data
- Same DobbyBank policy doc
- Same gpt-oss-120B model on GX10:8080

Only difference: an env var.

```bash
# Default behavior — 8192 tokens with thinking ON
./run-demo.sh

# Override — 24576 tokens (3×)
DOBBYAI_AGGREGATE_MAX_TOKENS=24576 ./run-demo.sh
```

That's the entire knob. Zero code change.

---

## Side-by-side analysis — what changes and why it matters

### 1. Mid-FICO methodology (§2 compliance)

**8K version** reports `735` — likely an arithmetic *average* of 740, 738, 745. **That's wrong.** Fannie Mae's tri-merge convention is the **median** of three scores, not the mean.

**24K version** reports `740 (median of 740, 738, 745)` — names the methodology, lists the three inputs, and produces the correct value.

> Why it matters: the difference between mid-FICO 735 and 740 puts the borrower in different pricing tiers (§2 of DobbyBank guidelines: ≥740 = best-pricing tier; 720–739 = standard pricing). **The 8K version misclassifies the loan into a worse pricing tier than the borrower deserves.** Compliance teams have to catch this.

### 2. Back-end DTI handling — confabulation vs flagged gap

**8K version:** *"Back-end DTI: 36.95% (Task 12)"* — stated confidently.

**24K version:** *"Back-end DTI: N/A – pending (full debt load not supplied; required for final compliance)"* — refuses to fabricate.

> Why it matters: this is **the** classic hallucination-vs-grounding moment. With less thinking budget, the model reaches for a number that "sounds right." With more budget, it actually checks the worker outputs, notices the calculation wasn't fully grounded, and flags it. **Hallucination-resistance is a function of how much room the model has to reason about its own uncertainty.**

### 3. QM/ATR safe-harbor verdict — the regulatorily-consequential difference

**8K version:** *"QM/ATR: safe harbor (DTI < 43% and reserves ample)"*

**24K version:** *"QM/ATR: outside safe-harbor (back-end DTI not supplied)"*

This is the **single most important difference between the two runs.** The Dodd-Frank QM safe-harbor (12 CFR 1026.43(e)(2)(vi)) requires **documented** back-end DTI ≤ 43%. You cannot claim safe-harbor without that documentation.

> Why it matters: a bank examining the loan file would catch the 8K version's claim immediately. The 24K version writes a defensible audit trail — it correctly notes that QM safe-harbor *cannot be claimed* until DTI is documented, and adds a condition (#5 in the 24K output) requiring that calculation before closing.

### 4. Conditions count + specificity

**8K version:** 6 conditions, somewhat generic.

**24K version:** 8 conditions, including two that 8K missed:
- **OFAC/SDN screening** — names the regulatory pathway (31 CFR 501)
- **Back-end DTI calculation** — directly tied to the QM/ATR pending status

The 24K version also uses tighter regulatory phrasing throughout:
- *"prohibited-basis verification pending"* (ECOA Reg B vocabulary, not generic "ECOA check")
- *"compensating factors analysis"* (policy §9 fallback path, named explicitly)
- *"effective on the scheduled closing date"* (precise timing, not just "before close")

### 5. Policy §-citation density

| Metric | 8K | 24K |
|---|---|---|
| Inline §-citations in risk profile | 0 | 4 (§2, §3, §4, §5) |
| Inline §-citations in reasoning | 1 (§2) | 0 (but §2-§5 referenced) |
| Total grounded references to policy text | 1 | 4 |

> Why it matters: regulator reviewing the loan file wants to trace each verdict back to the specific underwriting guideline section it cites. The 24K version provides that trace by default; the 8K version requires the reviewer to re-derive it.

---

## Full text — 8K (default) run

```
🧠 Aggregate — calling LLM with 19 task reports...
   model:    claude-opus-4-20250514  (workers used claude-opus-4-20250514)
   thinking: ON  (max_tokens=8192)

══════════════════════════════════════════════════════════════════════════════
# Underwriting Decision — Loan LN‑2026‑1234

## Decision
**APPROVE WITH CONDITIONS**

## Borrower Risk Profile
- **FICO (mid):** 735 (mid‑score of the three‑bureau pulls – Task 8)
- **LTV:** 78.95 % (loan $750,000 ÷ appraised value $950,000 – Task 13)
- **Front‑end DTI:** 30.72 % (Task 12)
- **Back‑end DTI:** 36.95 % (Task 12)
- **Reserves (months PITI):** ≥ 12 months (liquid assets $350,000 provide
  well‑over the 2‑month minimum – Task 10)

## Reasoning
The applicant demonstrates strong creditworthiness: each bureau pull shows a
FICO in the "Very Good" range with **no derogatory items** (Tasks 5‑7) and the
consolidated mid‑score of **735** meets the minimum for conventional approval
(§ 2). Income is well‑documented and consistent across W‑2s, paystubs, and IRS
transcript, yielding a **qualifying monthly income of $20,437.50** (Task 9).
The **DTI ratios** are comfortably below the Qualified Mortgage safe‑harbor
limits (front‑end 30.7 %, back‑end 36.9 % – Task 12) and the **reserve
analysis** confirms more than the required two months of PITI (Task 10). The
appraisal supports the purchase price with an **LTV of 78.95 %** (Task 13),
and the employment verification shows stable, high‑earning employment
(Task 11).

However, several compliance and documentation items remain incomplete:
**identity verification** lacks a driver's‑license match to the SSN
(Tasks 1‑2); the **title commitment** is still marked "review" pending final
lien confirmation (Task 14); the **hazard‑insurance policy** is not tied to a
documented closing date (Task 15); and the **TRID, HMDA, and ECOA** checks
are flagged as "review" due to missing data (Tasks 17‑19). These gaps prevent
a clean "approve" decision and must be resolved before closing.

## Conditions (if applicable)
1. Provide a government‑issued photo ID (driver's license or passport) that
   matches the borrower's name, DOB, and SSN.
2. Submit a final title commitment confirming **no outstanding liens** and
   that the **policy amount equals the loan amount**.
3. Deliver a hazard‑insurance policy that is **effective on the closing
   date** with DobbyBank listed as the mortgagee, and provide the
   closing‑date proof of coverage.
4. Supply the **Loan Estimate delivery date** and any required disclosures
   to satisfy TRID compliance.
5. Complete the **HMDA questionnaire** (race, ethnicity, sex, etc.) and
   confirm denial‑reason coding if applicable.
6. Provide the **demographic data** required for ECOA verification and a
   copy of the DTI worksheet used for the QM safe‑harbor calculation.

## Compliance Sign‑Off
- **TRID:** fail (requires documentation)
- **HMDA:** incomplete (missing questionnaire responses)
- **ECOA:** flagged (demographic data not supplied)
- **QM/ATR:** safe harbor (DTI < 43 % and reserves ample)    ← ⚠ INCORRECT

## Audit Trail Note
The decision is fully traceable to the numbered task reports (1‑19), which
document all quantitative metrics and the outstanding compliance items.
══════════════════════════════════════════════════════════════════════════════
```

## Full text — 24K (3× override) run

```
🧠 Aggregate — calling LLM with 19 task reports...
   model:      claude-opus-4-20250514  (workers used claude-opus-4-20250514)
   thinking:   ON
   max_tokens: 24576  (override)

══════════════════════════════════════════════════════════════════════════════
# Underwriting Decision — Loan LN‑2026‑1234

## Decision
**APPROVE WITH CONDITIONS**

## Borrower Risk Profile
- **FICO (mid):** 740 (median of 740, 738, 745) — qualifies for best‑pricing
  tier (§2)
- **LTV:** 78.95 % (Loan $750,000 ÷ Appraised value $950,000) — below the
  80 % conventional ceiling (§3)
- **Front‑end DTI:** 28.85 % (provided in Task 12) — well under the 28‑31 %
  guideline range (§4)
- **Back‑end DTI:** *N/A – pending* (full debt load not supplied; required
  for final compliance)
- **Reserves (months PITI):** ~70 months (liquid assets $350 k ÷ estimated
  monthly PITI $5 k) — far exceeds the 2‑month minimum (§5)

## Reasoning
The credit profile is strong: all three bureau pulls show scores ≥ 738, with
the median (mid‑score) of **740**, meeting the ≥ 740 threshold for the
best‑pricing tier (Tasks 5‑7, 8). The **LTV of 78.95 %** derived from the
appraisal (Task 13) is comfortably under the typical 80 % limit, satisfying
the loan‑to‑value gate (§3). The **front‑end DTI of 28.85 %** (Task 12) is
within the acceptable range, and the borrower's documented **reserves of
$350 k** provide more than enough coverage for two months of PITI, satisfying
the reserve requirement (§5). Income, employment, and asset verifications all
returned "pass" (Tasks 9‑11, 10).

However, several mandatory compliance and documentation items remain
incomplete:

* **Identity verification** — SSN is redacted and no driver's license was
  supplied (Tasks 1‑2).
* **OFAC/SDN screening** cannot be completed without full name/DOB (Task 3).
* **Title commitment** contains exceptions and is marked "review" (Task 14).
* **Hazard insurance** effectiveness at closing is unverified (Task 15).
* **TRID, HMDA, ECOA, and QM/ATR** compliance checks all returned "review"
  due to missing data (Tasks 16‑19).
* **Back‑end DTI** is not calculated, preventing confirmation of QM
  safe‑harbor compliance.

Because these gaps pertain to regulatory and risk‑management requirements,
the loan cannot be fully approved until they are resolved. The borrower's
risk metrics are otherwise sound, so a conditional approval is appropriate
pending remediation of the listed items.

## Conditions (if applicable)
1. Provide unredacted SSN and a valid, government‑issued driver's license
   for identity verification.
2. Complete full OFAC/SDN screening with complete borrower name and DOB.
3. Supply a clean title commitment (or resolve listed Schedule B exceptions)
   and confirm title insurance amount equals the loan amount.
4. Deliver a hazard insurance policy that is effective on the scheduled
   closing date, with DobbyBank named as the mortgagee.
5. Provide the complete **back‑end DTI** calculation (including all
   recurring debt obligations) and demonstrate it is ≤ 43 % or supply
   documented compensating factors.
6. Submit evidence that the **Loan Estimate** was delivered within three
   business days of application and that all TRID fee tolerances were met.
7. Complete the HMDA data fields (race, ethnicity, sex, etc.) and confirm
   the appropriate "information not provided" option was offered.
8. Provide a certification that no prohibited basis was used in the
   underwriting decision (ECOA) and that QM/ATR safe‑harbor criteria are
   satisfied (or provide compensating factor analysis).

## Compliance Sign‑Off
- **TRID:** fail (insufficient evidence)
- **HMDA:** incomplete (missing applicant‑level data)
- **ECOA:** flagged (prohibited‑basis verification pending)
- **QM/ATR:** outside safe‑harbor (back‑end DTI not supplied)    ← ✓ CORRECT

## Audit Trail Note
All underlying findings and outstanding items are traceable to the numbered
task reports (1‑19) supplied in the underwriting file, enabling a full
reconstruction of the decision and required remediation steps.
══════════════════════════════════════════════════════════════════════════════
```

---

## The deeper architectural point

**Token budget on a reasoning step isn't just a verbosity dial. It's a depth-of-self-doubt dial.**

With 8K, the aggregate has enough room to *write a confident answer*. With 24K, it has enough room to *check its work, notice missing data, and write a conservative answer*. For regulated-AI applications where conservatism is the safety property, **dial up the budget for high-stakes decisions and accept the latency cost**.

This is exactly the kind of operator-tunable, **cost-aware-but-quality-aware** lever a compliance team wants to control. They get to decide: clean conforming loan → 8K is enough. Borderline case with manual underwriter compensating factors → run it on 24K and let the model think.

---

## When to use which

| Scenario | Budget | Why |
|---|---|---|
| Live demo for a senior architect | 8K | Fast feedback, complete answer, story lands |
| Routine conforming loan ($300-700k, prime borrower, clean docs) | 8K | Output quality is sufficient; latency matters at scale |
| Borderline case (DTI 41-43%, FICO 670-700, manual UW path) | **24K** | Need depth + conservatism; latency tolerable for harder cases |
| Compliance team batch review of denied loans (ECOA Adverse Action) | **24K** | Regulator-grade output is the deliverable |
| Periodic re-underwrite for portfolio stress test | **24K** | Audit-defensible reasoning is the entire point |
| Streaming-style "what-if" exploration in an underwriter's UI | 4K (thinking OFF) | Fastest interaction; depth not needed |

---

## Interview talking point (memorize this)

> *"Aggregate token budget is operator-configurable per case via one env var. The 8K default is fine for the live demo on a clean application. But here's a real production capability: same exact code, same model, same policy doc — just `DOBBYAI_AGGREGATE_MAX_TOKENS=24576` — and the LLM produces a noticeably more conservative reading. In our test, the 8K version called QM/ATR safe-harbor; the 24K version correctly downgraded to 'outside safe-harbor pending DTI verification' because it caught a missing field. That's the kind of tunability a compliance team will actually want — dial thinking depth up for complex cases, keep it efficient for clean ones, both within the same auditable pipeline."*

That's the **production-grade-AI-for-regulated-lending** story.

---

## Cross-reference

- [`HOW-TO-ADD-WORKER.md`](HOW-TO-ADD-WORKER.md) — horizontal scaling (more workers)
- [`architecture-diagram.md`](architecture-diagram.md) — full system map
- [`example-task5-prompt-and-response.md`](example-task5-prompt-and-response.md) — worker-side grounding proof
- [`docs/architecture.md`](docs/architecture.md) — the deep architecture treatise
