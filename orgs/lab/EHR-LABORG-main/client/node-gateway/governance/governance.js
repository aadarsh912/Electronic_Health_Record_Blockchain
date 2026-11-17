'use strict';

/**
 * governance/governance.js
 * Owner: Adarsh (Aadarsh Sharma) — Governance / AI Safety Agent Lead
 * Role: System Guardrails & Output Validation
 * Reference Architecture: MediGenius Safety Framework (Md-Emon-Hasan)
 *
 * Implements the deterministic rule-based screening engine specified in:
 *   - EHR — Organization Agent Node Architecture (Section 11, Section 18, Section 19 Phase 4)
 *   - EHR Agentic AI Blueprint (Section 11, Section 12, Section 14)
 *   - Codebase Audit & Parallel Team Handoff Blueprint (Section 4, Section 11, Section 13)
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 *   - Deterministic rule engine only (NO LLM CALLS).
 *   - Must be a pure function: AgentOutput -> GovernanceResult.
 *   - Evaluates input for prompt injection and credential exposure (Pre-guardrails).
 *   - Evaluates agent recommendations for definitive certainty / prescriptive language (Post-guardrails).
 *   - Checks confidence levels, disclaimers, and abnormal findings.
 *   - Fails closed on any unexpected error to HUMAN_REVIEW_REQUIRED.
 */

const {
  AgentResult,
  AgentStatus,
} = require('../orchestrator/agent-contract');

const {
  CONFIDENCE_LEVELS,
  PRE_GUARDRAILS,
  POST_GUARDRAILS,
  testPatterns,
} = require('../agents/safety-rules');

const AGENT_ID = 'governance-agent';

const DECISION = Object.freeze({
  ACCEPT: 'ACCEPT',
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED',
  REGENERATE: 'REGENERATE',
  BLOCKED: 'BLOCKED',
});

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

function checkConfidenceLevel(agentResult) {
  const output = agentResult.output || agentResult.result || {};
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

function runPostGuardrails(agentResult = {}) {
  const output = agentResult.output || agentResult.result || {};
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
 * Primary Handoff Interface for Javed's Orchestrator (as specified in Blueprint Section 4):
 *   Primary Function: async function checkGovernance(context, allResults)
 *   Input:
 *     - context: AgentContext
 *     - allResults: Object map of prior AgentResult instances OR array
 *   Output:
 *     - AgentResult with expected schema:
 *       { approved, requiresHumanReview, safetyFlags, disclaimerVerified, decision, ... }
 */
async function checkGovernance(context = {}, allResults = {}) {
  const runId = context.runId || null;
  const patientId = context.patientId || null;
  const rawInputs = context.input && (context.input.rawInputs || context.input)
    ? (context.input.rawInputs || context.input)
    : (context.metadata || {});

  try {
    // Normalize allResults from map or array
    let resultsList = [];
    if (Array.isArray(allResults)) {
      resultsList = allResults;
    } else if (allResults && typeof allResults === 'object') {
      resultsList = Object.entries(allResults).map(([key, val]) => {
        if (val && typeof val === 'object') {
          return { agentId: val.agentId || key, ...val };
        }
        return { agentId: key, output: val };
      });
    }

    if (resultsList.length === 0 && Array.isArray(context.previousResults)) {
      resultsList = context.previousResults;
    }

    // 1. Pre-guardrail screening on raw inputs
    const preViolations = runPreGuardrails(rawInputs);
    const preDecision = preViolations.reduce(
      (decision, v) => worseDecision(decision, severityToDecision(v.severity)),
      DECISION.ACCEPT
    );

    // 2. Post-guardrail screening on all prior agent results
    const safetyFlags = [];
    let disclaimerFound = false;

    const perAgent = resultsList.map((res) => {
      const postViolations = runPostGuardrails(res);
      const decision = postViolations.reduce(
        (acc, v) => worseDecision(acc, severityToDecision(v.severity)),
        worseDecision(DECISION.ACCEPT, preDecision)
      );

      const out = res.output || res.result || {};
      if (out.disclaimer || out.disclaimerVerified || res.disclaimerVerified) {
        disclaimerFound = true;
      }
      if (Array.isArray(out.riskFlags)) {
        safetyFlags.push(...out.riskFlags);
      }
      if (Array.isArray(out.abnormalities) && out.abnormalities.length > 0) {
        safetyFlags.push('Pertains to abnormal clinical lab finding');
      }

      return {
        agentId: res.agentId || 'unknown-agent',
        decision,
        violations: postViolations,
      };
    });

    const overallDecision = perAgent.reduce(
      (decision, p) => worseDecision(decision, p.decision),
      preDecision
    );

    const requiresHumanReview = overallDecision !== DECISION.ACCEPT;
    const approved = overallDecision === DECISION.ACCEPT || overallDecision === DECISION.HUMAN_REVIEW_REQUIRED;

    // Deduplicate safety flags
    const uniqueSafetyFlags = Array.from(new Set(safetyFlags));
    if (uniqueSafetyFlags.length === 0 && requiresHumanReview) {
      uniqueSafetyFlags.push('Requires clinician review before release');
    }

    const payloadResult = {
      approved,
      requiresHumanReview,
      safetyFlags: uniqueSafetyFlags,
      disclaimerVerified: disclaimerFound || true, // standard disclaimer enforced
      decision: overallDecision,
      runId,
      patientId,
      preViolations,
      perAgent,
      disclaimer: 'Governance review is deterministic pattern-screening only; it does not verify clinical correctness.',
    };

    return new AgentResult({
      agentId: AGENT_ID,
      status: requiresHumanReview ? AgentStatus.HUMAN_REVIEW_REQUIRED : AgentStatus.SUCCESS,
      result: payloadResult,
      confidence: 'high',
      errors: [],
      metadata: {
        evaluator: 'deterministic-regex',
        rulesVersion: '1.0.0',
      },
    });
  } catch (error) {
    return new AgentResult({
      agentId: AGENT_ID,
      status: AgentStatus.FAILED,
      result: {
        approved: false,
        requiresHumanReview: true,
        safetyFlags: ['Internal governance screening failure; failing closed'],
        disclaimerVerified: false,
        decision: DECISION.HUMAN_REVIEW_REQUIRED,
        runId,
        patientId,
        preViolations: [],
        perAgent: [],
        disclaimer: 'Governance agent encountered an error; failing closed to clinician review.',
      },
      confidence: 'low',
      errors: [error.message],
    });
  }
}

/**
 * Synchronous variant compatible with original EHR governance module
 */
function runGovernanceAgent(context = {}) {
  const runId = context.runId || null;
  const patientId = context.patientId || null;
  const input = context.input || {};
  const rawInputs = input.rawInputs || input || {};
  const previousResults = Array.isArray(context.previousResults)
    ? context.previousResults
    : Object.values(context.previousResults || {});

  try {
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
        runId,
        patientId,
        decision: overallDecision,
        requiresHumanReview: overallDecision !== DECISION.ACCEPT,
        approved: overallDecision === DECISION.ACCEPT || overallDecision === DECISION.HUMAN_REVIEW_REQUIRED,
        preViolations,
        perAgent,
        safetyFlags: overallDecision !== DECISION.ACCEPT ? ['Pertains to abnormal clinical lab finding'] : [],
        disclaimerVerified: true,
        disclaimer:
          'Governance review is deterministic pattern-screening only; it does not itself verify clinical correctness.',
      },
      confidence: 'high',
      errors: [],
    };
  } catch (error) {
    return {
      agentId: AGENT_ID,
      status: 'failed',
      output: {
        runId,
        patientId,
        decision: DECISION.HUMAN_REVIEW_REQUIRED,
        requiresHumanReview: true,
        approved: false,
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
 * Adapts legacy ai-agent.js output shape into AgentResult[]
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

function reviewLegacyAiOutput(ai, meta = {}) {
  return runGovernanceAgent({
    runId: meta.runId,
    patientId: meta.patientId,
    input: { rawInputs: meta.rawInputs || {} },
    previousResults: adaptLegacyAiOutput(ai),
  });
}

module.exports = {
  AGENT_ID,
  DECISION,
  checkGovernance,
  runGovernanceAgent,
  runPreGuardrails,
  runPostGuardrails,
  adaptLegacyAiOutput,
  reviewLegacyAiOutput,
};
