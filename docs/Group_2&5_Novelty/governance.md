# Governance / AI Safety Agent

**Owner:** Adarsh (Aadarsh Sharma)
**Role:** System Guardrails & Output Validation
**Reference repository studied:** MediGenius Safety Framework (Md-Emon-Hasan)
**Files:** `governance-agent.js`, `safety-rules.js`, `__tests__/governance-agent.test.js`

## 1. Why this component exists

Every other agent in this project (lab, history, clinical) is an LLM wrapper.
LLMs hallucinate, can be steered by text hidden inside a PDF/OCR upload, and
occasionally slip into definitive ("you have X") language when the whole
point of this system is to stay *advisory*. The Governance Agent is the one
component in the pipeline that is **not itself an LLM call** — it is a
deterministic screening gate that sits between "the model said something"
and "that something reaches the patient record / the ledger."

```
        AI Result (lab-agent / clinical-agent)
                     │
                     ▼
            ┌──────────────────┐
            │ Governance Agent │
            └────────┬─────────┘
                     │
           ┌─────────┼─────────┐
           ▼         ▼         ▼
        Policy    Safety    Provenance
           │         │         │
           └─────────┼─────────┘
                     ▼
              Human Review
```

## 2. Research notes

Summarised from studying the two reference repos assigned to this role,
plus general reading on agent guardrails:

- **Deterministic vs. LLM-based guardrails** — MediGenius's own
  `core/safety_router.py` makes a hard rule: *no LLM ever decides a safety
  outcome, only regex/keyword matching does.* An LLM can be talked out of a
  refusal; a compiled regex cannot. This project's governance gate follows
  the same rule — `safety-rules.js` contains only plain patterns, no model
  calls.
- **Fail closed, not open** — the same file fails toward the safest response
  on an internal error rather than letting content through unchecked.
  `runGovernanceAgent()` mirrors this: any exception during screening
  produces `status: "failed"` + `decision: HUMAN_REVIEW_REQUIRED`, never a
  silent `ACCEPT`.
- **Verification as a second, LLM-assisted pass** — MediGenius's
  `diagnosis_verification_sub_agent.py` shows a *second* layer: after the
  deterministic gate, a cheap LLM call checks whether a generated answer is
  actually grounded in its evidence, with a `risk: low|medium|high` verdict
  and a `HELD_BACK_ANSWER` fallback when risk is high. That pattern is noted
  here as a natural v2 extension (see §6) but is out of scope for v1, which
  stays fully deterministic per the task assignment's "Build **deterministic**
  output screening gate" wording.
- **Review queue, not silent rejection** — `schemas/review.py` /
  `endpoints/review.py` show that a flagged item should never be silently
  dropped; it goes into a queue with the *reason* it was flagged, and a
  clinician's verdict is recorded *alongside* the original output, never
  overwriting it. `runGovernanceAgent()`'s output shape (`preViolations`,
  `perAgent[].violations`) is designed to be dropped straight into a review
  queue table/UI later.
- **Prompt injection is a real, present threat here, not a hypothetical one**
  — this project already extracts OCR text from uploaded lab report
  PDFs/images (`report-extractor.js`) and feeds it verbatim into the Gemini
  prompt (`ai-agent.js#buildLabReportPrompt`). An attacker who can upload a
  "lab report" can embed instructions in it. This is exactly the threat
  `sanitize_external_text()` defends against in the reference repo, and it's
  why `PRE_GUARDRAILS` screen `reportText` before it's assumed safe.
- **Agent permission boundaries / human-in-the-loop** — general AI-safety
  reading (and the task assignment itself) frames the governance layer's
  job as asking a fixed checklist, not re-diagnosing the patient: *was the
  right patient accessed, was required context available, were only
  allowed tools used, is the output advisory, is confidence present, is
  unsafe language present, does this need a human.* Those checks map
  directly onto `runGovernanceAgent()`'s output fields.

## 3. Interface contract used

Javed (Core Agentic AI Architect) owns the canonical `agent-contract.js`.
It didn't exist yet when this module was built, so the shapes below are a
local mirror of exactly what the team task assignment specifies, so this
file could be built and tested independently in parallel:

```ts
interface AgentContext {
  runId: string;
  patientId: string;
  task: string;
  input: unknown;              // { rawInputs: { resultData, reportText, testCode } }
  previousResults: AgentResult[];
}

interface AgentResult {
  agentId: string;
  status: "success" | "failed";
  output: unknown;
  confidence?: string;         // "high" | "medium" | "low"
  errors?: string[];
}
```

**Action item once Javed publishes the real `agent-contract.js`:** delete the
JSDoc mirror at the top of `governance-agent.js` and `require()` his file
instead. No other change should be needed — `runGovernanceAgent()` already
consumes/produces exactly this shape.

## 4. Guardrail categories

| Stage | Rule ID | Severity | Triggers on |
|---|---|---|---|
| Pre  | `PRE_PROMPT_INJECTION` | `blocking` | Injection-style phrases (*"ignore previous instructions"*, *"you are now"*, fake `system:` turns, etc.) found in `reportText` / `resultData` / `testCode` before they reach an LLM prompt. |
| Pre  | `PRE_MALICIOUS_TOKEN_REQUEST` | `blocking` | Input text requests or contains credential/secret-shaped material (`GEMINI_API_KEY`, `process.env`, private-key blocks, bearer tokens, `<script>` tags). |
| Post | `POST_UNSAFE_CERTAINTY` | `regenerate` | Definitive diagnostic/prescriptive language in the AI's own output (*"definitely has"*, *"prescribing"*, *"take 500mg"*, *"you have cancer"*, etc.) — the agent must stay advisory. |
| Post | `POST_PROMPT_INJECTION_ECHO` | `blocking` | The AI output echoes an injected instruction back verbatim (defense in depth if a pre-guardrail was somehow bypassed). |
| Post | `POST_MALICIOUS_TOKEN_LEAK` | `blocking` | The AI output itself leaks credential/secret-shaped text. |
| Post | `POST_MISSING_CONFIDENCE` | `human_review` | `confidence` is absent or not one of `high` / `medium` / `low` — an "ambiguous safety score" per the assignment. |
| Post | `POST_LOW_CONFIDENCE` | `human_review` | `confidence === "low"` — a "low confidence metric" per the assignment, escalated even if the text itself is clean. |

All patterns live in `safety-rules.js` as combinable arrays so a future
teammate (or Javed's orchestrator) can extend them without touching
`governance-agent.js`.

## 5. Decision matrix

`runGovernanceAgent()` combines every violation found (pre + post, across
every upstream agent result) into one worst-case decision:

| Decision | Meaning |
|---|---|
| `ACCEPT` | No violations. Safe to release. |
| `HUMAN_REVIEW_REQUIRED` | Low/missing confidence, or another soft/ambiguous signal. Release only after a clinician sign-off. |
| `REGENERATE` | Unsafe certainty language detected — ask the upstream agent to regenerate with stricter, hedged phrasing. |
| `BLOCKED` | Prompt injection or credential/secret leakage detected (input or output). Never release; escalate immediately. |

Ranking is `ACCEPT < HUMAN_REVIEW_REQUIRED < REGENERATE < BLOCKED` — the
single worst finding across the whole run wins, and any `blocking` violation
in the *pre*-stage automatically drags every downstream agent's own
per-agent decision up to `BLOCKED` too, since a compromised input taints
everything derived from it.

## 6. How it works today (before Javed's orchestrator exists)

`ai-agent.js#runAgenticClinicalAnalysis()` already returns
`{ labReportAnalysis, clinicalDecisionSupport, ... }` today, and
`server.js` folds that straight into `chainResultData.ai` right before
calling `createLabResult()` (see `server.js`, the `/api/records/ipfs`
route). That is exactly the "before releasing the record" moment the task
assignment describes.

`reviewLegacyAiOutput(ai, meta)` adapts that existing shape into the shared
`AgentResult[]` contract and runs the full guardrail gate against it in one
call, so this module is useful immediately — it does not need to wait for
`agents/lab-agent.js` / `agents/clinical-agent.js` to exist first.

**This module intentionally does not edit `server.js`** — per the Team
Working Rules ("do not change files outside your designated workspace
subfolder without coordinating with Javed first"). Wiring it in is a
one-line, additive change for whoever owns that file:

```js
// inside server.js, right after `ai = await runAgenticClinicalAnalysis(...)`
// and before `createLabResult(...)` is called:
const { reviewLegacyAiOutput } = require('./agents/governance-agent');

const governance = reviewLegacyAiOutput(ai, {
  runId: resultId,
  patientId: req.body.patientId,
  rawInputs: {
    resultData: parsedResultData,
    reportText: extractedReportText,
    testCode: req.body.testCode,
  },
});

chainResultData.governance = governance.output; // decision, requiresHumanReview, violations
if (governance.output.requiresHumanReview) {
  chainResultData.status = 'PENDING_REVIEW'; // or however the ledger models this today
}
```

Once Saurabh's `agents/lab-agent.js` and Ankit's `agents/clinical-agent.js`
exist and return native `AgentResult`s, the same integration point can call
`runGovernanceAgent()` directly with their real output instead of going
through `adaptLegacyAiOutput()` — no change needed inside
`governance-agent.js` itself.

## 7. Deliverables checklist

- [x] `governance-agent.js` — pre/post guardrail runner, decision engine, fail-closed error handling, legacy adapter.
- [x] `safety-rules.js` — deterministic pattern arrays (unsafe certainty, prompt injection, malicious tokens).
- [x] `governance.md` — this document.
- [x] Adversarial test cases — `__tests__/governance-agent.test.js` (9 cases, run via `npm run test:governance`).

## 8. Known limitations / next steps

- **Regex-only, v1.** A paraphrased certainty claim that avoids every listed
  phrase will slip through. §2's noted v2 extension — a cheap LLM-based
  grounding/verification pass modeled on
  `diagnosis_verification_sub_agent.py` — would catch semantic violations
  the regex layer can't, at the cost of no longer being purely
  deterministic. Recommend keeping this v1 gate as the always-on floor and
  layering the LLM check on top later, not replacing it.
- **"Correct patient accessed" / "allowed tools used" checks are stubbed
  conceptually, not wired.** Those two items from the architecture diagram
  depend on Sushil's tool-call abstraction (`getPatientHistory()`,
  `checkConsent()`, etc.) recording *which* tools were actually invoked per
  run. Once his `AgentContext.input`/`toolCalls` data exists, add
  `PRE_UNAUTHORIZED_TOOL_CALL` / `PRE_PATIENT_MISMATCH` rules here.
  Everything needed on this side (the rule slot, the violation shape) is
  already in place.
- **No persisted audit log yet.** Right now a governance verdict is just a
  returned object. Once Sushil's VCAP provenance extension exists, the
  natural next step is hashing `{ runId, decision, violations }` into the
  same provenance record, so a `BLOCKED`/`HUMAN_REVIEW_REQUIRED` verdict is
  itself tamper-evident on-chain.
