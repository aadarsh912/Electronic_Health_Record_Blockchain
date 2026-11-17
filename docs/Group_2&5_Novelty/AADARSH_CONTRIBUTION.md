# 👨‍💻 My Contribution — Governance & AI Safety Agent (EHR Blockchain)

> **Author:** Aadarsh Sharma (`Adarsh`)  
> **Role:** Governance / AI Safety Agent Lead (System Guardrails & Output Validation)  
> **Team:** Group 2 & 5 (Agentic AI Architecture)  
> **Module Home:** `orgs/lab/EHR-LABORG-main/client/node-gateway/agents/`  
> **Reference Architecture:** MediGenius Deterministic Safety Framework & Agentic AI Architecture  

---

## 🌟 1. Executive Summary

In a mission-critical Blockchain-Based Healthcare system, generative AI and clinical subagents (such as Lab Analysis and Clinical Decision Support) cannot be allowed to write uncontrolled or definitive statements directly into medical records and immutable blockchain ledgers. Large Language Models (LLMs) can hallucinate, be influenced by adversarial prompt injections embedded inside patient reports, or prescribe definitive diagnoses without licensed clinician sign-off.

**My responsibility in this 18-member project:**
1. **The AI Safety Screening Gate:** Built the **Governance / AI Safety Agent**, a high-speed, deterministic screening gate that sits between AI model outputs and the immutable blockchain ledger (`ehrchannel`).
2. **Zero-Trust Input & Output Guardrails:** Implemented pre-pipeline screening to detect prompt injection and credential leakage attempts hidden inside uploaded OCR lab reports, and post-pipeline screening to prevent definitive prescriptive language (*"definitely has"*, *"prescribing"*).
3. **Fail-Closed Escalation Protocol:** If an upstream agent outputs low confidence or ambiguous safety metrics, the governance agent automatically escalates the transaction to `HUMAN_REVIEW_REQUIRED`, setting the blockchain ledger state to `PENDING_REVIEW`.

---

## 🏗️ 2. Before Me vs. After Me

| Feature / Dimension | Before Integration | After Integration (Aadarsh Sharma's Work) |
| :--- | :--- | :--- |
| **AI Output Safety** | Model output went directly from Gemini into IPFS and Fabric ledger without validation. | **Deterministic validation gate** intercepts every AI result before persistence. |
| **Prompt Injection Protection** | Uploaded lab report OCR text was passed directly into LLM prompts, vulnerable to injection attacks. | **Pre-guardrail engine (`PRE_PROMPT_INJECTION`)** screens text before it ever reaches the LLM. |
| **Prescriptive Language Mitigation** | Models could emit definitive diagnostic statements (*"The patient definitely has anemia"*). | **Post-guardrail engine (`POST_UNSAFE_CERTAINTY`)** enforces advisory language or triggers `REGENERATE`. |
| **Low Confidence Handling** | Low confidence or fallback outputs were saved with standard status. | Automatically escalates to `HUMAN_REVIEW_REQUIRED` and flags record as `PENDING_REVIEW` on-chain. |
| **Test & Observability Coverage** | No automated tests for AI safety or guardrails. | **14 automated unit and integration tests** (`npm test`), plus dedicated `/api/governance/*` routes. |

---

## 🎯 3. Architecture & Guardrail Pipeline

```
     Raw Inputs (OCR Report Text, JSON Result)
                       │
                       ▼
         ┌───────────────────────────┐
         │ Stage 1: Pre-Guardrails   │ ──► [Prompt Injection / Token Leaks] ──► BLOCKED
         └─────────────┬─────────────┘
                       │ Safe
                       ▼
             [Upstream LLM Agents]
         (Lab Agent / Clinical Agent)
                       │
                       ▼
         ┌───────────────────────────┐
         │ Stage 2: Post-Guardrails  │ ──► [Unsafe Certainty] ──► REGENERATE
         └─────────────┬─────────────┘ ──► [Low/Missing Confidence] ──► HUMAN_REVIEW_REQUIRED
                       │ Clean
                       ▼
                 Decision Gate
         ┌───────────────────────────┐
         │ ACCEPT ──► Immutable Fabric Ledger (REPORTED)
         │ REVIEW ──► Blockchain Pending Review Queue (PENDING_REVIEW)
         └───────────────────────────┘
```

### Worst-First Decision Matrix
The governance agent uses worst-case ranking:
$$\text{ACCEPT} < \text{HUMAN\_REVIEW\_REQUIRED} < \text{REGENERATE} < \text{BLOCKED}$$

- **`ACCEPT`**: No violations. Safe to release to the patient record and ledger.
- **`HUMAN_REVIEW_REQUIRED`**: Low confidence, ambiguous safety scores, or soft flags. Requires licensed clinician review.
- **`REGENERATE`**: Unsafe certainty language detected (*"definitely has"*, *"prescribing 500mg"*). Upstream agent must regenerate with hedged phrasing.
- **`BLOCKED`**: Adversarial prompt injection or secret token leakage attempt. Transaction halted immediately.

---

## 📁 4. Inventory of Files & Components

### 1. Core Agent Logic (`orgs/lab/EHR-LABORG-main/client/node-gateway/agents/`)
* `governance-agent.js` — Main governance agent engine, decision evaluator, worst-first ranking, fail-closed handler, and legacy adapter.
* `safety-rules.js` — Deterministic regular-expression rule suites (`PRE_GUARDRAILS`, `POST_GUARDRAILS`).
* `demo-governance.js` — Interactive live terminal demonstration covering 5 clinical/adversarial scenarios.
* `governance.md` — Detailed technical specification and architectural documentation.
* `__tests__/governance-agent.test.js` — 9 adversarial unit test cases covering all guardrail rules.
* `__tests__/governance-integration.test.js` — 5 route integration tests verifying REST endpoints and middleware.

### 2. Backend Gateway Wiring (`orgs/lab/EHR-LABORG-main/client/node-gateway/server.js`)
* `POST /api/records/ipfs` — Automatically screens AI outputs before IPFS pinning and sets ledger status to `PENDING_REVIEW` if human review is required.
* `POST /api/ai/analyze` — Evaluates AI clinical analysis and returns governance verdicts.
* `POST /api/governance/screen` — Standalone endpoint allowing frontend, other microservices, and testing harnesses to screen text or AI output.
* `GET /api/governance/rules` — Returns metadata of active guardrails, severities, and patterns.

### 3. UI Control Deck (`orgs/lab/EHR-LABORG-main/client/node-gateway/public/`)
* `index.html` — Checkbox toggle to enforce AI Safety & Governance Guardrails and dedicated "Governance AI Safety Test" tool.
* `app.js` — Wired safety screening form, toast notifications with governance decisions, and `PENDING_REVIEW` badge styling.

### 4. Group 2 & 5 Docs & Presentation Materials (`docs/Group_2&5_Novelty/`)
* `governance.md` — Comprehensive design doc.
* `Responsibilities.pdf` — Team task allocations and architecture guide.
* `demo/` — Live terminal recording assets (`record_live_terminal.ps1`, `terminal_player.html`, `terminal_recording.gif`, `adarsh-governance-agent.zip`).

---

## 🎤 5. Viva Defense & Speaking Scripts

### 30-Second Pitch
> *"In this 18-member project, my role is the **Governance and AI Safety Agent Lead** in Group 2 & 5. While other agents generate clinical recommendations using LLMs, my agent is the deterministic gatekeeper that prevents unverified, hallucinated, or injected text from reaching the blockchain. I built a two-stage screening gate that catches prompt injections in raw lab reports, prevents definitive diagnostic claims, and automatically tags suspicious or low-confidence records as `PENDING_REVIEW` on the Hyperledger Fabric ledger."*

### Key Viva Questions & Answers
**Q1: Why is your agent deterministic instead of using another LLM?**  
*Answer:* *"An LLM can be jailbroken, steered, or hallucinate. A compiled regular-expression pattern suite cannot be tricked by prompt injection. As proven in MediGenius's safety router, safety guardrails must be 100% reproducible and fail-closed so that audit trials on the blockchain remain strictly tamper-evident and predictable."*

**Q2: How does your agent interact with the blockchain ledger?**  
*Answer:* *"When the governance agent detects a violation or low confidence, it returns `requiresHumanReview: true`. In `server.js`, this dynamically overrides the ledger status from `REPORTED` to `PENDING_REVIEW` and records the complete governance audit envelope (`decision`, `violations`, `preViolations`) into the on-chain payload. Doctors then review the flagged findings before formal release."*
