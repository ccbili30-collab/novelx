import { randomUUID } from "node:crypto";
import { SafeDiagnosticRepository } from "../../domain/audit/safeDiagnosticRepository";
import type { WorkspaceDatabase } from "../../domain/workspace/workspaceRepository";
import { createSafeDiagnosticCatalog } from "../../shared/diagnostics/safeDiagnosticCatalog";
import type {
  SafeDiagnosticBoundary,
  SafeDiagnosticDisposition,
  SafeDiagnosticEnvelopeV1,
  SafeDiagnosticOwner,
  SafeDiagnosticRetryability,
  SafeDiagnosticSideEffectState,
} from "../../shared/diagnostics/safeDiagnosticContract";

const editorialDiagnosticCodes = [
  "EDITORIAL_PLAN_INVALID",
  "EDITORIAL_PLAN_CHECKPOINT_STALE",
  "EDITORIAL_PLAN_BUDGET_EXCEEDED",
  "WORK_ORDER_STATE_INVALID",
  "WORK_ORDER_STATE_DEPENDENCY_FAILED",
  "WORK_ORDER_STATE_CHECKPOINT_STALE",
  "WORK_ORDER_STATE_UNCLASSIFIED_FAILURE",
  "SPECIALIST_PROTOCOL_INVALID",
  "SPECIALIST_PROTOCOL_EVIDENCE_INVALID",
  "GRAPH_CAUSAL_INVALID",
  "GRAPH_CAUSAL_EVIDENCE_INVALID",
  "EDITORIAL_REVIEW_INVALID",
  "EDITORIAL_REVIEW_BINDING_INVALID",
  "PROVIDER_REQUIRED",
  "PROVIDER_CONFIG_INVALID",
  "PROVIDER_CONNECTION_FAILED",
  "PROVIDER_RUNTIME_FAILED",
  "PROVIDER_PROTOCOL_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_SERVICE_UNAVAILABLE",
  "DOMAIN_INVALID",
  "DOMAIN_KIND_MISMATCH",
  "DOMAIN_ROOT_FORBIDDEN",
  "DOMAIN_CAUSAL_INVALID",
  "PERSISTENCE_FAILED",
  "RECONCILIATION_REQUIRED",
] as const;

export type GrowthEditorialDiagnosticCode = (typeof editorialDiagnosticCodes)[number];

const planInvalidCodes = new Set([
  "WORLD_DIRECTOR_PACKET_CREDENTIAL_REJECTED",
  "WORLD_DIRECTOR_PACKET_DUPLICATE_INPUT",
  "WORLD_DIRECTOR_PACKET_INPUT_INVALID",
  "WORLD_DIRECTOR_PACKET_OUTPUT_INVALID",
  "WORLD_DIRECTOR_PACKET_RULE_HASH_MISMATCH",
  "GROWTH_EDITORIAL_CONCURRENCY_INVALID",
  "GROWTH_EDITORIAL_PROVIDER_CAPACITY_INVALID",
]);
const planCheckpointCodes = new Set(["WORLD_DIRECTOR_PACKET_CHECKPOINT_MISMATCH"]);
const planBudgetCodes = new Set(["WORLD_DIRECTOR_PACKET_BUDGET_EXCEEDED"]);

const workOrderStateCodes = new Set([
  "GROWTH_EDITORIAL_ACCEPTED_ATTEMPT_REQUIRED",
  "GROWTH_EDITORIAL_ATTEMPT_ID_CONFLICT",
  "GROWTH_EDITORIAL_ATTEMPT_NOT_FOUND",
  "GROWTH_EDITORIAL_ATTEMPT_OWNER_MISMATCH",
  "GROWTH_EDITORIAL_ATTEMPT_REQUIRED",
  "GROWTH_EDITORIAL_CANDIDATE_STATE_INVALID",
  "GROWTH_EDITORIAL_CAPABILITY_OWNER_MISMATCH",
  "GROWTH_EDITORIAL_CHECKER_REVIEW_REQUIRED",
  "GROWTH_EDITORIAL_CHECKPOINT_MISMATCH",
  "GROWTH_EDITORIAL_COMMIT_ATTEMPT_INVALID",
  "GROWTH_EDITORIAL_COMMIT_QUEUE_STATE_INVALID",
  "GROWTH_EDITORIAL_COMMIT_STATE_INVALID",
  "GROWTH_EDITORIAL_CONTRACT_VERSION_UNSUPPORTED",
  "GROWTH_EDITORIAL_DATA_INVALID",
  "GROWTH_EDITORIAL_GOAL_NOT_ACTIVE",
  "GROWTH_EDITORIAL_GOAL_NOT_FOUND",
  "GROWTH_EDITORIAL_IDEMPOTENCY_KEY_REUSED",
  "GROWTH_EDITORIAL_REVIEW_NOT_FOUND",
  "GROWTH_EDITORIAL_REVIEW_STATE_INVALID",
  "GROWTH_EDITORIAL_ROUND_HAS_ACTIVE_WORK",
  "GROWTH_EDITORIAL_ROUND_ID_CONFLICT",
  "GROWTH_EDITORIAL_ROUND_NOT_ACTIVE",
  "GROWTH_EDITORIAL_ROUND_NOT_FOUND",
  "GROWTH_EDITORIAL_ROUND_TERMINAL_STATE_INVALID",
  "GROWTH_EDITORIAL_RULE_REVISION_MISMATCH",
  "GROWTH_EDITORIAL_RULE_REVISION_NOT_FOUND",
  "GROWTH_EDITORIAL_SCHEDULER_ALREADY_CONFIGURED",
  "GROWTH_EDITORIAL_STATE_CONFLICT",
  "GROWTH_EDITORIAL_TERMINAL_STATE_INVALID",
  "GROWTH_EDITORIAL_WORK_ORDER_FAILED",
  "GROWTH_EDITORIAL_WORK_ORDER_NOT_FOUND",
  "GROWTH_EDITORIAL_WORK_ORDER_NOT_STARTABLE",
]);
const dependencyCodes = new Set(["GROWTH_EDITORIAL_DEPENDENCY_FAILED"]);
const checkpointCodes = new Set([
  "GROWTH_EDITORIAL_CHECKPOINT_STALE",
  "GROWTH_EDITORIAL_REBASE_REJECTED",
  "GROWTH_EDITORIAL_RECHECK_FAILED",
]);

const specialistEvidenceCodes = new Set([
  "GROWTH_CANDIDATE_EVIDENCE_BINDING_MISSING",
  "GROWTH_CANDIDATE_EVIDENCE_ARTIFACT_MISMATCH",
  "GROWTH_CANDIDATE_EVIDENCE_DUPLICATED",
  "GROWTH_CANDIDATE_SPECIALIST_EVIDENCE_MISSING",
]);
const specialistProtocolCodes = new Set([
  "GROWTH_EDITORIAL_CANDIDATE_FAILED",
  "GROWTH_CANDIDATE_ARTIFACT_HASH_MISMATCH",
  "GROWTH_CANDIDATE_ARTIFACT_TARGET_DUPLICATED",
  "GROWTH_CANDIDATE_ARTIFACT_TARGET_MISMATCH",
  "GROWTH_CANDIDATE_ASSERTION_ID_DUPLICATED",
  "GROWTH_CANDIDATE_ASSERTION_REF_DUPLICATED",
  "GROWTH_CANDIDATE_INPUT_INVALID",
  "GROWTH_CANDIDATE_LOCATOR_TOO_LONG",
  "GROWTH_CANDIDATE_NOT_READY",
  "GROWTH_CANDIDATE_PARENT_ORDER_INVALID",
  "GROWTH_CANDIDATE_PARENT_REQUIRED",
  "GROWTH_CANDIDATE_RESOURCE_ID_DUPLICATED",
  "GROWTH_CANDIDATE_RESOURCE_REF_DUPLICATED",
  "GROWTH_CANDIDATE_RESOURCE_SCOPE_MISMATCH",
  "GROWTH_CANDIDATE_SOURCE_LOCATOR_INVALID",
  "GROWTH_CANDIDATE_SPECIALIST_ARTIFACT_MISMATCH",
]);

const graphEvidenceCodes = new Set([
  "GROWTH_CANDIDATE_CAUSAL_SUPPORT_EVIDENCE_MISMATCH",
  "GROWTH_CANDIDATE_CAUSAL_SUPPORT_REQUIRED",
  "GROWTH_CANDIDATE_CAUSAL_SUPPORT_SET_MISMATCH",
  "GROWTH_CANDIDATE_CAUSAL_EPISTEMIC_UNRESOLVED",
]);
const graphCodes = new Set([
  "CAUSAL_INQUIRY_AFFECTED_NODE_DUPLICATED",
  "CAUSAL_INQUIRY_EVIDENCE_DUPLICATED",
  "CAUSAL_INQUIRY_GAP_ID_DUPLICATED",
  "CAUSAL_INQUIRY_INPUT_INVALID",
  "GROWTH_CANDIDATE_CAUSAL_ENDPOINT_UNRESOLVED",
  "GROWTH_CANDIDATE_CAUSAL_SUPPORT_DUPLICATED",
  "GROWTH_CANDIDATE_GRAPH_ASSERTION_DUPLICATED",
  "GROWTH_CANDIDATE_GRAPH_CAUSAL_DUPLICATED",
]);

const reviewBindingCodes = new Set([
  "GROWTH_EDITORIAL_DIRECTOR_FACET_MISMATCH",
  "GROWTH_EDITORIAL_REVIEW_BINDING_INVALID",
  "GROWTH_EDITORIAL_REVIEW_FACET_MISMATCH",
  "GROWTH_EDITORIAL_REVISION_OWNER_MISMATCH",
  "GROWTH_EDITORIAL_REVISION_OWNER_NOT_FOUND",
]);
const reviewCodes = new Set([
  "GROWTH_EDITORIAL_ACCEPTANCE_EVIDENCE_REQUIRED",
  "GROWTH_EDITORIAL_REVISION_GAP_REQUIRED",
  "GROWTH_EDITORIAL_REVISION_LIMIT_INVALID",
]);

const exactSafeCodes = new Set<GrowthEditorialDiagnosticCode>(editorialDiagnosticCodes);
const domainCausalCodes = new Set([
  "DOMAIN_CAUSAL_BRANCH_NOT_FOUND",
  "DOMAIN_CAUSAL_CHECKPOINT_NOT_FOUND",
  "DOMAIN_CAUSAL_CHECKPOINT_VERSION_CONFLICT",
  "DOMAIN_CAUSAL_CONDITIONS_DUPLICATED",
  "DOMAIN_CAUSAL_CONDITIONS_REQUIRED",
  "DOMAIN_CAUSAL_DATA_INVALID",
  "DOMAIN_CAUSAL_DEFINITION_INVALID",
  "DOMAIN_CAUSAL_ENDPOINT_DEPENDENCY_REQUIRED",
  "DOMAIN_CAUSAL_ENDPOINT_INVALID",
  "DOMAIN_CAUSAL_ENDPOINT_NOT_ACTIVE",
  "DOMAIN_CAUSAL_ENDPOINT_NOT_VISIBLE",
  "DOMAIN_CAUSAL_ENDPOINT_OUTPUT_MISMATCH",
  "DOMAIN_CAUSAL_ENDPOINT_OUTPUT_NOT_COMMITTED",
  "DOMAIN_CAUSAL_EPISTEMIC_STATUS_INVALID",
  "DOMAIN_CAUSAL_IDEMPOTENCY_KEY_REUSED",
  "DOMAIN_CAUSAL_IDENTITY_CONFLICT",
  "DOMAIN_CAUSAL_IDENTITY_IMMUTABLE",
  "DOMAIN_CAUSAL_KIND_INVALID",
  "DOMAIN_CAUSAL_MECHANISM_REQUIRED",
  "DOMAIN_CAUSAL_POLARITY_STRENGTH_REQUIRED",
  "DOMAIN_CAUSAL_RELATION_DUPLICATED",
  "DOMAIN_CAUSAL_RELATION_ID_DUPLICATED",
  "DOMAIN_CAUSAL_SELF_EDGE_FORBIDDEN",
  "DOMAIN_CAUSAL_SOURCE_BINDING_INVALID",
  "DOMAIN_CAUSAL_SOURCE_DEPENDENCY_REQUIRED",
  "DOMAIN_CAUSAL_SOURCE_DUPLICATED",
  "DOMAIN_CAUSAL_SOURCE_HASH_MISMATCH",
  "DOMAIN_CAUSAL_SOURCE_NOT_ACTIVE",
  "DOMAIN_CAUSAL_SOURCE_NOT_VISIBLE",
  "DOMAIN_CAUSAL_SOURCE_OUTPUT_NOT_COMMITTED",
  "DOMAIN_CAUSAL_SOURCE_REQUIRED",
  "DOMAIN_CAUSAL_TEMPORAL_SCOPE_REQUIRED",
  "DOMAIN_CAUSAL_VERSION_ID_CONFLICT",
]);
const providerConfigurationCodes = new Set([
  "PROVIDER_CONFIG_REQUIRED",
  "PROVIDER_CREDENTIAL_REQUIRED",
  "PROVIDER_SECURE_STORAGE_UNAVAILABLE",
]);
const providerConnectionCodes = new Set([
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_MODEL_NOT_FOUND",
  "PROVIDER_MODEL_UNAVAILABLE",
  "PROVIDER_PING_FAILED",
]);
const providerRuntimeCodes = new Set([
  "PROVIDER_GENERATION_FAILED",
  "PROVIDER_OUTPUT_INCOMPLETE",
  "PROVIDER_REJECTED",
  "PROVIDER_REQUEST_REJECTED",
]);
const providerProtocolCodes = new Set([
  "PROVIDER_PROTOCOL_INVALID_RESPONSE",
  "PROVIDER_PROTOCOL_NO_FINAL_MESSAGE",
  "PROVIDER_PROTOCOL_OTHER",
  "PROVIDER_PROTOCOL_REQUEST_LIMIT_EXCEEDED",
  "PROVIDER_PROTOCOL_STRUCTURED_RESULT_INVALID",
  "PROVIDER_PROTOCOL_STRUCTURED_RESULT_MISSING",
  "PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE",
]);
const domainCodes = new Map<string, GrowthEditorialDiagnosticCode>([
  ["DOMAIN_IMMUTABLE", "DOMAIN_INVALID"],
  ["DOMAIN_ROOT_NOT_FOUND", "DOMAIN_INVALID"],
  ["DOMAIN_ROOT_PROTECTED", "DOMAIN_ROOT_FORBIDDEN"],
]);
const persistenceCodes = new Set([
  "GROWTH_PERSISTENCE_FAILED",
  "SAFE_DIAGNOSTIC_PERSISTENCE_FAILED",
]);
const reconciliationCodes = new Set([
  "GROWTH_RECONCILIATION_REQUIRED",
  "PROVIDER_OUTCOME_UNKNOWN",
]);

export const growthEditorialDiagnosticCatalog = createSafeDiagnosticCatalog(
  editorialDiagnosticCodes.map((code) => {
    const classification = classifyDiagnostic(code);
    return {
      code,
      owner: classification.owner,
      boundary: classification.boundary,
      defaultRetryability: classification.retryability,
      userSummaryKey: `growth.editorial.${code.toLowerCase()}`,
      modelCorrectionKey: null,
    };
  }),
);

export function classifyGrowthEditorialFailure(sourceCode: unknown): GrowthEditorialDiagnosticCode {
  if (typeof sourceCode !== "string") return "WORK_ORDER_STATE_UNCLASSIFIED_FAILURE";
  if (exactSafeCodes.has(sourceCode as GrowthEditorialDiagnosticCode)) return sourceCode as GrowthEditorialDiagnosticCode;
  if (providerConfigurationCodes.has(sourceCode)) return "PROVIDER_CONFIG_INVALID";
  if (providerConnectionCodes.has(sourceCode)) return "PROVIDER_CONNECTION_FAILED";
  if (providerRuntimeCodes.has(sourceCode)) return "PROVIDER_RUNTIME_FAILED";
  if (providerProtocolCodes.has(sourceCode)) return "PROVIDER_PROTOCOL_FAILED";
  if (persistenceCodes.has(sourceCode)) return "PERSISTENCE_FAILED";
  if (reconciliationCodes.has(sourceCode)) return "RECONCILIATION_REQUIRED";
  const domainCode = domainCodes.get(sourceCode);
  if (domainCode) return domainCode;
  if (domainCausalCodes.has(sourceCode)) return "DOMAIN_CAUSAL_INVALID";
  if (planBudgetCodes.has(sourceCode)) return "EDITORIAL_PLAN_BUDGET_EXCEEDED";
  if (planCheckpointCodes.has(sourceCode)) return "EDITORIAL_PLAN_CHECKPOINT_STALE";
  if (planInvalidCodes.has(sourceCode)) return "EDITORIAL_PLAN_INVALID";
  if (dependencyCodes.has(sourceCode)) return "WORK_ORDER_STATE_DEPENDENCY_FAILED";
  if (checkpointCodes.has(sourceCode)) return "WORK_ORDER_STATE_CHECKPOINT_STALE";
  if (workOrderStateCodes.has(sourceCode)) return "WORK_ORDER_STATE_INVALID";
  if (specialistEvidenceCodes.has(sourceCode)) return "SPECIALIST_PROTOCOL_EVIDENCE_INVALID";
  if (specialistProtocolCodes.has(sourceCode)) return "SPECIALIST_PROTOCOL_INVALID";
  if (graphEvidenceCodes.has(sourceCode)) return "GRAPH_CAUSAL_EVIDENCE_INVALID";
  if (graphCodes.has(sourceCode)) return "GRAPH_CAUSAL_INVALID";
  if (reviewBindingCodes.has(sourceCode)) return "EDITORIAL_REVIEW_BINDING_INVALID";
  if (reviewCodes.has(sourceCode)) return "EDITORIAL_REVIEW_INVALID";
  if (sourceCode === "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN"
    || sourceCode === "GROWTH_EDITORIAL_RECONCILIATION_STATE_INVALID") return "RECONCILIATION_REQUIRED";
  return "WORK_ORDER_STATE_UNCLASSIFIED_FAILURE";
}

/** Appends one safe, allowlisted diagnostic after the editorial state is durable. */
export function ensureGrowthEditorialDiagnostic(input: {
  workspace: WorkspaceDatabase;
  workOrderId: string;
  sourceCode: unknown;
  occurredAt?: string;
}): SafeDiagnosticEnvelopeV1 {
  const repository = new SafeDiagnosticRepository(input.workspace);
  const code = classifyGrowthEditorialFailure(input.sourceCode);
  const prior = repository.listOperation("tool_call", input.workOrderId);
  const replay = prior.find((diagnostic) => diagnostic.code === code);
  if (replay) return replay;
  const classification = classifyDiagnostic(code);
  return repository.append({
    schemaVersion: 1,
    diagnosticId: `growth-editorial-${randomUUID()}`,
    operationKind: "tool_call",
    operationId: input.workOrderId,
    runId: null,
    cycleId: null,
    toolInvocationId: null,
    parentDiagnosticId: prior.at(-1)?.diagnosticId ?? null,
    sequence: prior.length + 1,
    owner: classification.owner,
    boundary: classification.boundary,
    code,
    toolName: null,
    attempt: null,
    maxAttempts: null,
    sideEffectState: classification.sideEffectState,
    disposition: classification.disposition,
    retryability: classification.retryability,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

function classifyDiagnostic(code: GrowthEditorialDiagnosticCode): {
  owner: SafeDiagnosticOwner;
  boundary: SafeDiagnosticBoundary;
  sideEffectState: SafeDiagnosticSideEffectState;
  disposition: SafeDiagnosticDisposition;
  retryability: SafeDiagnosticRetryability;
} {
  if (code === "RECONCILIATION_REQUIRED") return diagnostic("reconciliation", "recovery", "outcome_unknown", "reconciliation_required", "restart_reconcile");
  if (code === "PERSISTENCE_FAILED") return diagnostic("persistence", "database_commit", "none", "terminal", "do_not_retry");
  if (code.startsWith("PROVIDER_")) {
    const boundary: SafeDiagnosticBoundary = code === "PROVIDER_PROTOCOL_FAILED" ? "provider_protocol"
      : code === "PROVIDER_CONFIG_INVALID" || code === "PROVIDER_REQUIRED" || code === "PROVIDER_CONNECTION_FAILED"
        ? "provider_connect" : "provider_inference";
    return diagnostic("provider", boundary, code === "PROVIDER_REQUIRED" || code === "PROVIDER_CONFIG_INVALID" ? "none" : "request_sent", "terminal", code === "PROVIDER_RATE_LIMITED" || code === "PROVIDER_SERVICE_UNAVAILABLE" ? "safe_retry" : "user_action");
  }
  if (code.startsWith("DOMAIN_") || code.startsWith("GRAPH_CAUSAL_")) return diagnostic("domain_policy", "change_set_policy", "none", "terminal", "do_not_retry");
  if (code.startsWith("SPECIALIST_PROTOCOL_")) return diagnostic("worker_schema", "worker_to_main", "none", "terminal", "do_not_retry");
  if (code.startsWith("EDITORIAL_REVIEW_")) return diagnostic("growth_phase", "phase_correction", "none", "terminal", "do_not_retry");
  return diagnostic("growth_phase", "phase_compile", "none", "terminal", "do_not_retry");
}

function diagnostic(
  owner: SafeDiagnosticOwner,
  boundary: SafeDiagnosticBoundary,
  sideEffectState: SafeDiagnosticSideEffectState,
  disposition: SafeDiagnosticDisposition,
  retryability: SafeDiagnosticRetryability,
) {
  return { owner, boundary, sideEffectState, disposition, retryability };
}
