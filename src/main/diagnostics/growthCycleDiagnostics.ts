import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../../domain/workspace/workspaceRepository";
import { SafeDiagnosticRepository } from "../../domain/audit/safeDiagnosticRepository";
import type {
  SafeDiagnosticBoundary,
  SafeDiagnosticDisposition,
  SafeDiagnosticEnvelopeV1,
  SafeDiagnosticOwner,
  SafeDiagnosticRetryability,
  SafeDiagnosticSideEffectState,
} from "../../shared/diagnostics/safeDiagnosticContract";
import { createSafeDiagnosticCatalog } from "../../shared/diagnostics/safeDiagnosticCatalog";

const growthRunStartDiagnosticCodes = [
  "GROWTH_RUN_START_STATE_INVALID",
  "GROWTH_RUN_START_CHECKPOINT_INVALID",
  "GROWTH_RUN_START_RULE_INVALID",
  "GROWTH_RUN_START_INTENT_INVALID",
  "GROWTH_RUN_START_CLOSURE_AUTHORITY_INVALID",
  "GROWTH_RUN_START_LONGFORM_AUTHORITY_INVALID",
  "GROWTH_RUN_START_REVISION_AUTHORITY_INVALID",
  "GROWTH_RUN_START_INQUIRY_AUTHORITY_INVALID",
  "GROWTH_RUN_START_ANCHOR_INVALID",
  "GROWTH_RUN_START_BINDING_INVALID",
] as const;

const growthCycleFailureCodes = [
  "GROWTH_AGENT_RUNTIME_FAILED",
  "GROWTH_BINDING_INVALID",
  "GROWTH_CHANGE_SET_NOT_COMMITTED",
  "GROWTH_CYCLE_TERMINAL_UNEXPECTED",
  "GROWTH_CHANGE_SET_OUTCOME_UNKNOWN",
  "GROWTH_CLOSURE_NOT_READY",
  "GROWTH_CLOSURE_NO_PROGRESS",
  "GROWTH_CLOSURE_OUTCOME_UNKNOWN",
  "GROWTH_CLOSURE_SUBMISSION_INVALID",
  "GROWTH_CREATOR_CHOICE_REQUIRED",
  "GROWTH_INQUIRY_EVIDENCE_MAPPING_INVALID",
  "GROWTH_INQUIRY_INVALID",
  "GROWTH_INQUIRY_REQUIRED",
  "GROWTH_INQUIRY_STALLED",
  "GROWTH_PERSISTENCE_FAILED",
  "GROWTH_PROVIDER_CONFIGURATION_FAILED",
  "GROWTH_PROVIDER_PROTOCOL_FAILED",
  "GROWTH_PROVIDER_RUNTIME_FAILED",
  "GROWTH_RECONCILIATION_REQUIRED",
  "GROWTH_RETRIEVAL_INPUT_INVALID",
  "GROWTH_RETRIEVAL_REQUIRED",
  "GROWTH_RUN_ATTACH_FAILED",
  "GROWTH_RUN_CANCELLED",
  "GROWTH_RUN_FAILED",
  "GROWTH_RUN_INTERRUPTED",
  "GROWTH_TOOL_FAILED",
  ...growthRunStartDiagnosticCodes,
] as const;

export type GrowthCycleFailureCode = (typeof growthCycleFailureCodes)[number];
export type GrowthRunStartDiagnosticCode = (typeof growthRunStartDiagnosticCodes)[number];

export const growthCycleDiagnosticCatalog = createSafeDiagnosticCatalog(
  growthCycleFailureCodes.map((code) => {
    const classification = classifyGrowthCycleFailure(code);
    return {
      code,
      owner: classification.owner,
      boundary: classification.boundary,
      defaultRetryability: classification.retryability,
      userSummaryKey: `growth.${code.toLowerCase()}`,
      modelCorrectionKey: null,
    };
  }),
);

export function isGrowthCycleFailureCode(value: string): value is GrowthCycleFailureCode {
  return growthCycleDiagnosticCatalog.has(value);
}

export function isGrowthRunStartDiagnosticCode(value: unknown): value is GrowthRunStartDiagnosticCode {
  return typeof value === "string" && growthRunStartDiagnosticCodes.includes(value as GrowthRunStartDiagnosticCode);
}

/**
 * Appends the authoritative Growth-cycle rollup once. Existing diagnostics are
 * replayed by identity rather than rewritten, so recovery is append-only.
 */
export function ensureGrowthCycleDiagnostic(input: {
  workspace: WorkspaceDatabase;
  cycleId: string;
  runId: string | null;
  code: GrowthCycleFailureCode;
  occurredAt?: string;
}): SafeDiagnosticEnvelopeV1 {
  const repository = new SafeDiagnosticRepository(input.workspace);
  const existing = repository.listOperation("growth_cycle", input.cycleId)
    .find((diagnostic) => diagnostic.code === input.code && diagnostic.runId === input.runId);
  if (existing) return existing;

  const prior = repository.listOperation("growth_cycle", input.cycleId);
  const parent = [...prior].reverse().find((diagnostic) => diagnostic.runId === input.runId) ?? null;
  const classification = classifyGrowthCycleFailure(input.code);
  return repository.append({
    schemaVersion: 1,
    diagnosticId: `growth-cycle-${randomUUID()}`,
    operationKind: "growth_cycle",
    operationId: input.cycleId,
    runId: input.runId,
    cycleId: input.cycleId,
    toolInvocationId: null,
    parentDiagnosticId: parent?.diagnosticId ?? null,
    sequence: prior.length + 1,
    owner: classification.owner,
    boundary: classification.boundary,
    code: input.code,
    toolName: null,
    attempt: null,
    maxAttempts: null,
    sideEffectState: classification.sideEffectState,
    disposition: classification.disposition,
    retryability: classification.retryability,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

function classifyGrowthCycleFailure(code: GrowthCycleFailureCode): {
  owner: SafeDiagnosticOwner;
  boundary: SafeDiagnosticBoundary;
  sideEffectState: SafeDiagnosticSideEffectState;
  disposition: SafeDiagnosticDisposition;
  retryability: SafeDiagnosticRetryability;
} {
  if (code === "GROWTH_CHANGE_SET_OUTCOME_UNKNOWN"
    || code === "GROWTH_CLOSURE_OUTCOME_UNKNOWN"
    || code === "GROWTH_RUN_INTERRUPTED"
    || code === "GROWTH_RECONCILIATION_REQUIRED") {
    return {
      owner: "reconciliation",
      boundary: "recovery",
      sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required",
      retryability: "restart_reconcile",
    };
  }
  if (code === "GROWTH_PERSISTENCE_FAILED" || code === "GROWTH_RUN_ATTACH_FAILED") {
    return {
      owner: "persistence",
      boundary: "database_commit",
      sideEffectState: "none",
      disposition: "terminal",
      retryability: "do_not_retry",
    };
  }
  if (code === "GROWTH_PROVIDER_CONFIGURATION_FAILED") {
    return {
      owner: "provider",
      boundary: "provider_connect",
      sideEffectState: "none",
      disposition: "terminal",
      retryability: "user_action",
    };
  }
  if (code === "GROWTH_PROVIDER_RUNTIME_FAILED" || code === "GROWTH_PROVIDER_PROTOCOL_FAILED") {
    return {
      owner: "provider",
      boundary: code === "GROWTH_PROVIDER_PROTOCOL_FAILED" ? "provider_protocol" : "provider_inference",
      sideEffectState: "request_sent",
      disposition: "terminal",
      retryability: "user_action",
    };
  }
  if (code === "GROWTH_TOOL_FAILED") {
    return {
      owner: "tool_bridge",
      boundary: "tool_execution",
      sideEffectState: "request_sent",
      disposition: "terminal",
      retryability: "do_not_retry",
    };
  }
  return {
    owner: "growth_phase",
    boundary: "phase_compile",
    sideEffectState: "none",
    disposition: "terminal",
    retryability: code === "GROWTH_CREATOR_CHOICE_REQUIRED" ? "user_action" : "do_not_retry",
  };
}
