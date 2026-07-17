import type { SafeDiagnosticEnvelopeV1, SafeDiagnosticOwner, SafeDiagnosticBoundary } from "../../shared/diagnostics/safeDiagnosticContract";
import { createSafeDiagnosticCatalog } from "../../shared/diagnostics/safeDiagnosticCatalog";
import { agentToolInternalErrorCodeSchema, type AgentToolName } from "../../shared/agentWorkerProtocol";
import {
  responsesImageProviderFailureClasses,
  type ResponsesImageProviderFailureClass,
} from "../../domain/asset/responsesImageProviderClient";
import { growthRevisionProposalPolicyCodes } from "../growth/phases/revision/growthRevisionProposalDiagnostics";

const toolCodes = agentToolInternalErrorCodeSchema.options;
const codes = [...toolCodes, ...responsesImageProviderFailureClasses, ...growthRevisionProposalPolicyCodes] as const;
export type MainToolDiagnosticCode = (typeof codes)[number];

export const mainToolDiagnosticCatalog = createSafeDiagnosticCatalog(codes.map((code) => {
  const classification = classifyCode(code);
  return {
    code,
    owner: classification.owner,
    boundary: classification.boundary,
    defaultRetryability: classification.retryability,
    userSummaryKey: `tool.${code.toLowerCase()}`,
    modelCorrectionKey: null,
  };
}));

export function createMainToolFailureDiagnostic(input: {
  diagnosticId: string;
  runId: string;
  cycleId: string | null;
  requestId: string;
  tool: AgentToolName;
  code: MainToolDiagnosticCode;
  occurredAt: string;
}): SafeDiagnosticEnvelopeV1 {
  const classification = classifyCode(input.code);
  return {
    schemaVersion: 1,
    diagnosticId: input.diagnosticId,
    operationKind: "tool_call",
    operationId: input.requestId,
    runId: input.runId,
    cycleId: input.cycleId,
    toolInvocationId: input.requestId,
    parentDiagnosticId: null,
    sequence: 1,
    owner: classification.owner,
    boundary: classification.boundary,
    code: input.code,
    toolName: input.tool,
    attempt: null,
    maxAttempts: null,
    sideEffectState: classification.sideEffectState,
    disposition: classification.disposition,
    retryability: classification.retryability,
    occurredAt: input.occurredAt,
  };
}

function classifyCode(code: MainToolDiagnosticCode): {
  owner: SafeDiagnosticOwner;
  boundary: SafeDiagnosticBoundary;
  sideEffectState: SafeDiagnosticEnvelopeV1["sideEffectState"];
  disposition: SafeDiagnosticEnvelopeV1["disposition"];
  retryability: SafeDiagnosticEnvelopeV1["retryability"];
} {
  if (code === "IMAGE_PROVIDER_CONNECTION_FAILED") {
    return {
      owner: "provider", boundary: "provider_connect", sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required", retryability: "restart_reconcile",
    };
  }
  if (isProviderFailureCode(code)) {
    const protocol = code === "IMAGE_PROVIDER_PROTOCOL_FAILED";
    const retryable = code === "IMAGE_PROVIDER_RATE_LIMITED"
      || code === "IMAGE_PROVIDER_SERVICE_UNAVAILABLE";
    return {
      owner: "provider",
      boundary: protocol ? "provider_protocol" : "provider_inference",
      sideEffectState: "request_sent",
      disposition: "terminal",
      retryability: retryable ? "user_action" : "do_not_retry",
    };
  }
  if (code === "AGENT_TOOL_TIMEOUT" || code === "IMAGE_GENERATION_RECONCILIATION_REQUIRED" || code === "GROWTH_RECONCILIATION_REQUIRED") {
    return {
      owner: "reconciliation", boundary: "recovery", sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required", retryability: "restart_reconcile",
    };
  }
  if (code === "AGENT_TOOL_PROTOCOL_FAILED" || code === "AGENT_TOOL_UNKNOWN" || code === "AGENT_TOOLS_REQUIRED") {
    return {
      owner: "tool_bridge", boundary: "tool_arguments", sideEffectState: "none",
      disposition: "terminal", retryability: "do_not_retry",
    };
  }
  if (code.startsWith("IMAGE_") || code.startsWith("WORLD_MAP_")) {
    return {
      owner: code === "IMAGE_GENERATION_FAILED" ? "provider" : "domain_policy",
      boundary: code === "IMAGE_GENERATION_FAILED" ? "asset_commit" : "tool_authorization",
      sideEffectState: code === "IMAGE_GENERATION_FAILED" ? "request_sent" : "none",
      disposition: "terminal", retryability: code === "IMAGE_GENERATION_FAILED" ? "user_action" : "do_not_retry",
    };
  }
  if (code.startsWith("CHANGE_SET_PERSISTENCE_") || code === "CHANGE_SET_APPLY_FAILED") {
    return {
      owner: "persistence", boundary: "database_commit", sideEffectState: "none",
      disposition: "terminal", retryability: "do_not_retry",
    };
  }
  if (code.startsWith("CHANGE_SET_") || code.startsWith("GREENFIELD_")
    || code.startsWith("RESOURCE_") || code.startsWith("DOCUMENT_")
    || code.startsWith("RELATION_") || code.startsWith("ASSERTION_")) {
    return {
      owner: "domain_policy", boundary: code.includes("APPLY") ? "change_set_apply" : "change_set_policy",
      sideEffectState: "none", disposition: "terminal", retryability: "do_not_retry",
    };
  }
  if (code.startsWith("GROWTH_PERSISTENCE_")) {
    return {
      owner: "persistence", boundary: "database_commit", sideEffectState: "none",
      disposition: "terminal", retryability: "do_not_retry",
    };
  }
  if (code.startsWith("GROWTH_")) {
    return {
      owner: "main_gateway", boundary: "tool_authorization", sideEffectState: "none",
      disposition: "terminal", retryability: "do_not_retry",
    };
  }
  if (code.startsWith("PROJECT_FILE_")) {
    return {
      owner: "domain_policy", boundary: "tool_authorization", sideEffectState: "none",
      disposition: "terminal", retryability: "user_action",
    };
  }
  return {
    owner: "main_gateway", boundary: "tool_execution",
    sideEffectState: code === "AGENT_RUN_CANCELLED" ? "none" : "request_sent",
    disposition: "terminal", retryability: "do_not_retry",
  };
}

function isProviderFailureCode(code: MainToolDiagnosticCode): code is ResponsesImageProviderFailureClass {
  return (responsesImageProviderFailureClasses as readonly string[]).includes(code);
}
