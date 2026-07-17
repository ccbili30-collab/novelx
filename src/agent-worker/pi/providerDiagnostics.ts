import { randomUUID } from "node:crypto";
import type { SafeDiagnosticEnvelopeV1 } from "../../shared/diagnostics/safeDiagnosticContract";
import { createSafeDiagnosticCatalog } from "../../shared/diagnostics/safeDiagnosticCatalog";
import { auditProviderProtocolStage, type ProviderProtocolStage } from "./providerProtocolStage";

export const providerDiagnosticCatalog = createSafeDiagnosticCatalog([
  providerDefinition("PROVIDER_RUNTIME_FAILED", "provider_inference", "user_action"),
  providerDefinition("PROVIDER_OUTPUT_INCOMPLETE", "provider_protocol", "do_not_retry"),
  providerDefinition("PROVIDER_PROTOCOL_NO_FINAL_MESSAGE", "provider_protocol", "do_not_retry"),
  providerDefinition("PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE", "provider_protocol", "do_not_retry"),
  providerDefinition("PROVIDER_PROTOCOL_STRUCTURED_RESULT_MISSING", "provider_protocol", "do_not_retry"),
  providerDefinition("PROVIDER_PROTOCOL_STRUCTURED_RESULT_INVALID", "provider_protocol", "do_not_retry"),
  {
    code: "PROVIDER_PROTOCOL_REQUEST_LIMIT_EXCEEDED",
    owner: "worker_schema",
    boundary: "provider_protocol",
    defaultRetryability: "user_action",
    userSummaryKey: "provider.request_limit_exceeded",
    modelCorrectionKey: null,
  },
  providerDefinition("PROVIDER_PROTOCOL_OTHER", "provider_protocol", "do_not_retry"),
]);

export function createProviderTerminalDiagnostic(input: {
  runId: string;
  cycleId: string | null;
  cause: unknown;
  now?: () => string;
  createId?: () => string;
}): SafeDiagnosticEnvelopeV1 | null {
  const protocolStage = auditProviderProtocolStage(input.cause);
  const directCode = readCode(input.cause);
  const code: string | null = protocolStage
    ?? (directCode === "PROVIDER_RUNTIME_FAILED" || directCode === "PROVIDER_OUTPUT_INCOMPLETE" ? directCode : null);
  if (!code) return null;
  const definition = providerDiagnosticCatalog.get(code);
  if (!definition) return null;
  const requestNotSent = code === "PROVIDER_PROTOCOL_REQUEST_LIMIT_EXCEEDED";
  return {
    schemaVersion: 1,
    diagnosticId: (input.createId ?? randomUUID)(),
    operationKind: "agent_run",
    operationId: input.runId,
    runId: input.runId,
    cycleId: input.cycleId,
    toolInvocationId: null,
    parentDiagnosticId: null,
    sequence: 1,
    owner: definition.owner,
    boundary: definition.boundary,
    code,
    toolName: null,
    attempt: null,
    maxAttempts: null,
    sideEffectState: requestNotSent ? "none" : "request_sent",
    disposition: "terminal",
    retryability: definition.defaultRetryability,
    occurredAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

function providerDefinition(
  code: ProviderProtocolStage | "PROVIDER_RUNTIME_FAILED" | "PROVIDER_OUTPUT_INCOMPLETE",
  boundary: "provider_inference" | "provider_protocol",
  retryability: "user_action" | "do_not_retry",
) {
  return {
    code,
    owner: "provider" as const,
    boundary,
    defaultRetryability: retryability,
    userSummaryKey: `provider.${code.toLowerCase()}`,
    modelCorrectionKey: null,
  };
}

function readCode(value: unknown): string | null {
  return value && typeof value === "object" && "code" in value && typeof value.code === "string"
    ? value.code
    : null;
}
