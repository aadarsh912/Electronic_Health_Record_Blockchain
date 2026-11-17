'use strict';

/**
 * agents/governance-agent.js
 * Owner: Adarsh (Aadarsh Sharma) - Governance / AI Safety Agent
 * Role: System Guardrails & Output Validation
 *
 * See ./governance.md for the full design write-up, research notes, and
 * integration guide.
 *
 * This module deliberately does NOT:
 *   - call the ledger (gateway.js) or IPFS (ipfs.js) directly
 *   - call Gemini or any other LLM
 *   - modify server.js / gateway.js / ai-agent.js
 * per the "Team Working Rules" in Agentic AI Module Team Task Assignments.pdf
 * ("Maintain Domain Separation... Do not change files outside your
 * designated workspace subfolder (/agents, /tools, /orchestrator) without
 * coordinating with Javed first."). It is a pure function of the data it is
 * given, which also makes it trivial to unit test (see __tests__/).
 *
 * Shared interface contract this module targets (per the team task
 * assignment - Javed owns the canonical version of this contract; the
 * shapes below are a local mirror so this file can be developed and tested
 * independently while the orchestrator is still being built):
 *
 *   interface AgentContext {
 *     runId: string;
 *     patientId: string;
 *     task: string;
 *     input: unknown;            // { rawInputs: { resultData, reportText, testCode } }
 *     previousResults: AgentResult[];
 *   }
 *
 *   interface AgentResult {
 *     agentId: string;
 *     status: "success" | "failed";
 *     output: unknown;
 *     confidence?: string;
 *     errors?: string[];
 *   }
 */

const {
  CONFIDENCE_LEVELS,
  PRE_GUARDRAILS,
  POST_GUARDRAILS,
  testPatterns,
} = require('./safety-rules');

const AGENT_ID = 'governance-agent';

const DECISION = Object.freeze({
  ACCEPT: 'ACCEPT',
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED',
  REGENERATE: 'REGENERATE',
  BLOCKED: 'BLOCKED',
});

// Worst-first ranking used to combine many individual checks into one
// overall decision - e.g. one BLOCKED violation outranks ten ACCEPTs.
const DECISION_RANK = Object.freeze({
  [DECISION.ACCEPT]: 0,
  [DECISION.HUMAN_REVIEW_REQUIRED]: 1,
  [DECISION.REGENERATE]: 2,
  [DECISION.BLOCKED]: 3,
});

function worseDecision(a, b) {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

function severityToDecision(severity) {
  switch (severity) {
    case 'blocking':
      return DECISION.BLOCKED;
    case 'regenerate':
      return DECISION.REGENERATE;
    case 'human_review':
    default:
      return DECISION.HUMAN_REVIEW_REQUIRED;
  }
}

function collectTextFields(obj, fields) {
  return fields
    .map((field) => obj && obj[field])
    .filter((value) => typeof value === 'string' && value.trim().length > 0);
}

function flattenArrayFields(obj, fields) {
  const out = [];
  for (const field of fields) {
    const value = obj && obj[field];
    if (Array.isArray(value)) {
      out.push(...value.map(String));
    }
  }
  return out;
}

/**
 * Stage 1 - Pre-pipeline guardrails.
 * Screens the raw inputs that are ABOUT TO BE handed to an upstream LLM
 * agent (lab-agent / clinical-agent) for prompt injection or credential
 * exfiltration attempts hidden in OCR'd report text, resultData, etc.
 */
function runPreGuardrails(rawInputs = {}) {
  const candidateText = [
    rawInputs.reportText,
    typeof rawInputs.resultData === 'object' && rawInputs.resultData !== null
      ? JSON.stringify(rawInputs.resultData)
      : rawInputs.resultData,
    rawInputs.testCode,
  ]
    .filter(Boolean)
    .join('\n');

  const violations = [];
  for (const rule of PRE_GUARDRAILS) {
    const hit = testPatterns(rule.patterns, candidateText);
    if (hit) {
      violations.push({
        ruleId: rule.id,
        stage: 'pre',
        severity: rule.severity,
        description: rule.description,
        evidence: hit,
      });
    }
  }

  return violations;
}

/**
 * Checks an upstream AgentResult's declared confidence level. Two distinct
 * escalation triggers here, both straight from the assignment text
 * ("...if the upstream module yields low confidence metrics or ambiguous
 * safety scores"):
 *   - missing/invalid confidence  -> ambiguous safety score
 *   - confidence === "low"        -> low confidence metric
 */
function checkConfidenceLevel(agentResult) {
  const output = agentResult.output || {};
  const rawConfidence = agentResult.confidence || output.confidence || null;
  const confidence = String(rawConfidence || '').toLowerCase();
  const violations = [];

  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    violations.push({
      ruleId: 'POST_MISSING_CONFIDENCE',
      stage: 'post',
      severity: 'human_review',
      description: `${agentResult.agentId || 'agent'} result is missing a valid confidence level.`,
      evidence: rawConfidence,
    });
  } else if (confidence === 'low') {
    violations.push({
      ruleId: 'POST_LOW_CONFIDENCE',
      stage: 'post',
      severity: 'human_review',
      description: `${agentResult.agentId || 'agent'} result reported low confidence.`,
      evidence: rawConfidence,
    });
  }

  return violations;
}

/**
 * Stage 2 - Post-output guardrails.
 * Screens a single upstream AgentResult (lab-agent or clinical-agent
 * output) for unsafe certainty, injected-instruction echoes, and leaked
 * credential-shaped text, before that result is allowed to reach the
 * patient record or the ledger.
 */
function runPostGuardrails(agentResult = {}) {
  const output = agentResult.output || {};
  const textFields = collectTextFields(output, ['summary', 'recommendation']);
  const arrayFields = flattenArrayFields(output, [
    'findings',
    'abnormalities',
    'riskFlags',
    'possibleRisks',
    'nextSteps',
  ]);
  const candidateText = [...textFields, ...arrayFields].join('\n');

  const violations = [...checkConfidenceLevel(agentResult)];

  for (const rule of POST_GUARDRAILS) {
    const hit = testPatterns(rule.patterns, candidateText);
    if (hit) {
      violations.push({
        ruleId: rule.id,
        stage: 'post',
        severity: rule.severity,
        description: rule.description,
        evidence: hit,
        agentId: agentResult.agentId,
      });
    }
  }

  return violations;
}

/**
 * Core entry point. Screens a set of upstream AgentResults (plus the raw
 * inputs that produced them) and returns a governance-agent AgentResult.
 *
 * Fails CLOSED: any unexpected error while screening escalates to
 * HUMAN_REVIEW_REQUIRED with status "failed" rather than allowing output
 * to pass through unchecked.
 */
function runGovernanceAgent(context = {}) {
  const { runId, patientId, input = {}, previousResults = [] } = context;

  try {
    const rawInputs = input.rawInputs || input || {};
    const preViolations = runPreGuardrails(rawInputs);
    const preDecision = preViolations.reduce(
      (decision, v) => worseDecision(decision, severityToDecision(v.severity)),
      DECISION.ACCEPT
    );

    const perAgent = previousResults.map((result) => {
      const postViolations = runPostGuardrails(result);
      const decision = postViolations.reduce(
        (acc, v) => worseDecision(acc, severityToDecision(v.severity)),
        worseDecision(DECISION.ACCEPT, preDecision)
      );

      return {
        agentId: result.agentId || 'unknown-agent',
        decision,
        violations: postViolations,
      };
    });

    const overallDecision = perAgent.reduce(
      (decision, p) => worseDecision(decision, p.decision),
      preDecision
    );

    return {
      agentId: AGENT_ID,
      status: 'success',
      output: {
        runId: runId || null,
        patientId: patientId || null,
        decision: overallDecision,
        requiresHumanReview: overallDecision !== DECISION.ACCEPT,
        preViolations,
        perAgent,
        disclaimer:
          'Governance review is deterministic pattern-screening only; it does not itself verify clinical correctness.',
      },
      confidence: 'high', // this agent's own screening is deterministic
      errors: [],
    };
  } catch (error) {
    return {
      agentId: AGENT_ID,
      status: 'failed',
      output: {
        runId: runId || null,
        patientId: patientId || null,
        decision: DECISION.HUMAN_REVIEW_REQUIRED,
        requiresHumanReview: true,
        preViolations: [],
        perAgent: [],
        disclaimer: 'Governance agent failed while screening; failing closed to human review.',
      },
      confidence: 'low',
      errors: [error.message],
    };
  }
}

/**
 * Compatibility adapter for the CURRENT (pre-orchestrator) shape returned by
 * ai-agent.js#runAgenticClinicalAnalysis():
 *   { ok, provider, model, labReportAnalysis, clinicalDecisionSupport, ... }
 *
 * This lets the governance agent screen production output TODAY, and keeps
 * working unchanged once Saurabh/Ankit refactor their logic into
 * agents/lab-agent.js and agents/clinical-agent.js, since both will return
 * results in the shared AgentResult shape this adapter already produces.
 */
function adaptLegacyAiOutput(ai = {}) {
  const results = [];

  if (ai.labReportAnalysis) {
    results.push({
      agentId: 'lab-agent',
      status: ai.ok === false ? 'failed' : 'success',
      output: ai.labReportAnalysis,
      confidence: ai.labReportAnalysis.confidence,
    });
  }

  if (ai.clinicalDecisionSupport) {
    results.push({
      agentId: 'clinical-agent',
      status: ai.ok === false ? 'failed' : 'success',
      output: ai.clinicalDecisionSupport,
      confidence: ai.clinicalDecisionSupport.confidence,
    });
  }

  return results;
}

/**
 * One-call convenience wrapper for today's integration point: the `ai`
 * object already computed in server.js by runAgenticClinicalAnalysis(),
 * right before it is folded into chainResultData and written to the ledger
 * via createLabResult(). See governance.md "Integration" section for the
 * exact call site and a copy-paste wiring example.
 */
function reviewLegacyAiOutput(ai, meta = {}) {
  return runGovernanceAgent({
    runId: meta.runId,
    patientId: meta.patientId,
    input: { rawInputs: meta.rawInputs || {} },
    previousResults: adaptLegacyAiOutput(ai),
  });
}

async function checkGovernance(context, allResults) {
  const { checkGovernance: check } = require('../governance/governance');
  return check(context, allResults);
}

module.exports = {
  AGENT_ID,
  DECISION,
  checkGovernance,
  runPreGuardrails,
  runPostGuardrails,
  runGovernanceAgent,
  adaptLegacyAiOutput,
  reviewLegacyAiOutput,
};
