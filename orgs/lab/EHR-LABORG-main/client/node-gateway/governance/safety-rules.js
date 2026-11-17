'use strict';

/**
 * agents/safety-rules.js
 * Owner: Adarsh (Aadarsh Sharma) - Governance / AI Safety Agent
 *
 * Deterministic guardrail rule definitions used by governance-agent.js.
 *
 * Design principle (borrowed deliberately from the assigned reference repo,
 * "MediGenius Safety Framework" -> app/core/safety_router.py): no LLM ever
 * decides these outcomes. Every rule here is a plain regex test so the
 * screening gate is cheap, offline, and 100% reproducible - the same input
 * always produces the same verdict, which matters for an audit trail.
 *
 * Patterns are intentionally over-inclusive: a missed hit is worse than an
 * unnecessary flag going to human review.
 */

const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

// ---------------------------------------------------------------------------
// Category 1 - Unsafe certainty / prescriptive language.
// The lab and clinical agents must stay advisory (see Responsibilities.pdf,
// Adarsh section: "Findings may be consistent with anemia..." is ACCEPTABLE,
// "The patient definitely has anemia." is UNSAFE CERTAINTY). Definitive
// diagnosis, prescription, or dosage instructions are a violation even when
// medically plausible - only a licensed clinician may state these.
// ---------------------------------------------------------------------------
const UNSAFE_CERTAINTY_PATTERNS = [
  /\bdefinitely (has|have|is|indicates?|confirms?)\b/i,
  /\bconfirmed diagnos(is|ed)\b/i,
  /\b(is|are|was|were) diagnosed with\b/i,
  /\b100\s?% (certain|sure|confirmed)\b/i,
  /\bwithout (a )?doubt\b/i,
  /\bcertainly (has|indicates|confirms|means)\b/i,
  /\bguaranteed to\b/i,
  /\bwill (definitely|certainly) (cure|fix|resolve)\b/i,
  /\bmust (take|start|stop|discontinue)\b/i,
  /\bprescrib(e|ing|ed)\b/i,
  /\bstart (taking|the medication|treatment with)\b/i,
  /\btake \d+\s?(mg|mcg|ml|g|tablets?|pills?|capsules?)\b/i,
  /\bno need to (see|consult|visit) a (doctor|clinician|physician)\b/i,
  /\byou (have|has) (cancer|diabetes|anemia|tuberculosis|hiv)\b/i,
];

// ---------------------------------------------------------------------------
// Category 2 - Prompt injection.
// Free text that reaches a Gemini prompt (OCR'd report text via
// report-extractor.js, resultData JSON, patient history strings) can carry
// attacker-controlled instructions. Same threat model as the reference
// repo's sanitize_external_text() / _INJECTION_RE.
// ---------------------------------------------------------------------------
const PROMPT_INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|above|prior) instructions?/i,
  /disregard (all |any )?(previous|prior) (prompts?|instructions?)/i,
  /you are now\b/i,
  /^\s*system\s*:/im,
  /^\s*assistant\s*:/im,
  /new instructions?\s*:/i,
  /act as (an?|the) (unfiltered|unrestricted|jailbroken)\b/i,
  /jailbreak/i,
  /reveal (your |the )?(system prompt|instructions|api key)/i,
  /print (your |the )?(system prompt|instructions)/i,
  /pretend (you are|to be)\b/i,
  /do anything now/i,
  /override (safety|guardrails?|rules?)/i,
  /\bDAN\s+mode\b/i,
];

// ---------------------------------------------------------------------------
// Category 3 - Malicious token / secret-extraction requests.
// Nothing in an uploaded report or an AI response should ever request or
// echo credentials, keys, or tokens - these must never reach the model, the
// AI summary, or the ledger.
// ---------------------------------------------------------------------------
const MALICIOUS_TOKEN_PATTERNS = [
  /GEMINI_API_KEY/i,
  /\bapi[_-]?key\b\s*[:=]/i,
  /process\.env/i,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bbearer\s+[a-z0-9\-_.]{12,}/i,
  /\badmin[_-]?token\b/i,
  /\bpassword\s*[:=]\s*\S+/i,
  /<script[\s>]/i,
];

/**
 * Pre-pipeline guardrails: run against raw inputs (reportText, resultData,
 * testCode) BEFORE they are handed to an upstream LLM agent.
 */
const PRE_GUARDRAILS = [
  {
    id: 'PRE_PROMPT_INJECTION',
    severity: 'blocking',
    description: 'Input text (report/result data) contains a prompt-injection pattern.',
    patterns: PROMPT_INJECTION_PATTERNS,
  },
  {
    id: 'PRE_MALICIOUS_TOKEN_REQUEST',
    severity: 'blocking',
    description: 'Input text requests or contains credential/secret material.',
    patterns: MALICIOUS_TOKEN_PATTERNS,
  },
];

/**
 * Post-output guardrails: run against an upstream agent's generated output
 * (lab-agent / clinical-agent) BEFORE it is allowed to reach the patient
 * record or the ledger.
 */
const POST_GUARDRAILS = [
  {
    id: 'POST_UNSAFE_CERTAINTY',
    severity: 'regenerate',
    description: 'AI output uses definitive diagnostic/prescriptive language.',
    patterns: UNSAFE_CERTAINTY_PATTERNS,
  },
  {
    id: 'POST_PROMPT_INJECTION_ECHO',
    severity: 'blocking',
    description: 'AI output echoes an injected instruction back verbatim.',
    patterns: PROMPT_INJECTION_PATTERNS,
  },
  {
    id: 'POST_MALICIOUS_TOKEN_LEAK',
    severity: 'blocking',
    description: 'AI output leaks credential/secret-shaped content.',
    patterns: MALICIOUS_TOKEN_PATTERNS,
  },
];

/**
 * Runs an ordered list of regex patterns against a text blob and returns the
 * first matching substring, or null. Deterministic - first match wins.
 */
function testPatterns(patterns, text) {
  if (!text) {
    return null;
  }

  const value = String(text);
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

module.exports = {
  CONFIDENCE_LEVELS,
  UNSAFE_CERTAINTY_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
  MALICIOUS_TOKEN_PATTERNS,
  PRE_GUARDRAILS,
  POST_GUARDRAILS,
  testPatterns,
};
