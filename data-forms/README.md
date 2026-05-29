# Mortgage Application Documents &nbsp;·&nbsp; Loan LN-2026-1234

Print-ready markdown versions of the borrower's application packet. These are
the **paper forms a human underwriter would receive** — converted from the
machine-readable JSON in `../data/` for visual presentation in demos.

The system itself reads the JSON files at runtime; these `.md` files exist for
human review.

## Documents

| Document | File | What it is |
|---|---|---|
| **Form 1003 — URLA** | `application/form-1003.md` | The borrower's loan application (the master document). |
| **Experian Credit Report** | `credit/experian-credit-report.md` | FICO 740 + tradelines + payment history. |
| **Equifax Credit Report** | `credit/equifax-credit-report.md` | FICO 738 + tradelines (includes one extra historical account). |
| **TransUnion Credit Report** | `credit/transunion-credit-report.md` | FICO 745 + tri-merge summary. |
| **Income Documents** | `income/income-documents.md` | W-2 2024 + W-2 2025 + recent paystubs + IRS Form 4506-C transcript. |
| **Asset Statements** | `assets/asset-statements.md` | Chase checking + Marcus savings + Fidelity brokerage + 401(k) + escrow EM. |
| **Verification of Employment** | `employment/voe-letter.md` | Written VOE from Quantum Logistics Corp HR. |
| **Form 1004 — Appraisal** | `property/appraisal-form-1004.md` | Property valuation + 3 comparable sales + lender QC. |
| **Title Commitment** | `property/title-commitment.md` | ALTA Commitment — clear title with standard Schedule B exceptions. |
| **Hazard Insurance** | `property/hazard-insurance-declarations.md` | HO-6 policy declarations page + mortgagee clause. |

## How to convert to PDF in VSCode

1. Install the **Markdown PDF** extension (`yzane.markdown-pdf`).
2. Open any `.md` file in this folder.
3. Cmd+Shift+P → **"Markdown PDF: Export (pdf)"** — generates a PDF next to the file.
4. Or **"Markdown PDF: Export (all)"** to convert everything at once.

Other options:
- **Pandoc**: `pandoc form-1003.md -o form-1003.pdf`
- **Headless Chrome**: `bunx marked form-1003.md | chrome --headless --print-to-pdf=form-1003.pdf -`
- **VSCode "Print"** (built-in): Cmd+P → Print → Save as PDF

## How the demo system uses these

The orchestrator's 19 verification tasks each point at the matching JSON file
in `../data/`. The LLM agent reads the JSON, applies the relevant DobbyBank
guideline section, and returns a structured verdict.

These markdown versions exist so an interviewer can SEE what document each
task is reasoning about — turning the demo from "agents reading JSON blobs"
into "agents underwriting real-looking paperwork."
