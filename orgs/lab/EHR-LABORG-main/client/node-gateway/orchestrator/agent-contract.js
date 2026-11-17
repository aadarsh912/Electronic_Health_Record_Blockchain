'use strict';

/**
 * orchestrator/agent-contract.js
 * Canonical Agent Interface Contract (defined by Javed / Core Agentic Architecture Lead)
 * Source of truth for interfaces across all team members:
 * Saurabh (Lab Agent), Abdullah (History Agent), Ankit (Clinical Agent),
 * Adarsh (Governance Agent), Sushil (Tools & VCAP).
 */

class AgentContext {
  constructor({
    runId,
    patientId,
    requestingAgent = 'ORCHESTRATOR',
    previousResults = {},
    metadata = {}
  }) {
    if (!runId || !patientId) {
      throw new Error('AgentContext requires runId and patientId');
    }
    this.runId = String(runId);
    this.patientId = String(patientId);
    this.requestingAgent = String(requestingAgent);
    this.previousResults = previousResults; // Map<agentId, AgentResult> or Object
    this.timestamp = new Date().toISOString();
    this.metadata = metadata;
  }
}

/**
 * Standard Status Enumeration
 */
const AgentStatus = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  FAILED: 'FAILED',
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED'
});

/**
 * Standard Agent Result returned by every agent module
 */
class AgentResult {
  constructor({
    agentId,
    status = AgentStatus.SUCCESS,
    result = {},
    confidence = 'medium', // 'high' | 'medium' | 'low'
    errors = [],
    metadata = {}
  }) {
    if (!agentId) {
      throw new Error('AgentResult requires agentId');
    }
    this.agentId = String(agentId);
    this.status = status;
    this.result = result;
    this.confidence = String(confidence).toLowerCase();
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
    this.timestamp = new Date().toISOString();
    this.metadata = metadata;
  }
}

module.exports = {
  AgentContext,
  AgentResult,
  AgentStatus
};
