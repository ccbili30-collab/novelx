import { randomUUID } from "node:crypto";
import type { AgentWorkerAuditOperation } from "../../shared/agentWorkerProtocol";
import type { SafeDiagnosticEnvelopeV1 } from "../../shared/diagnostics/safeDiagnosticContract";
import { growthRevisionDiagnosticCatalog } from "../growth/phases/revision/growthRevisionDiagnostics";
import { stewardDiagnosticCatalog } from "./stewardDiagnostics";

export interface GrowthRevisionDiagnosticSink {
  recordCompileFailure(input: {
    toolCallId: string;
    code: string;
    attempt: number;
    maxAttempts: number;
    terminal: boolean;
  }): Promise<string>;
  recordCompileCorrected(input: {
    toolCallId: string;
    code: string;
    attempt: number;
    maxAttempts: number;
    parentDiagnosticId: string;
  }): Promise<string>;
}

export interface StewardToolDiagnosticSink {
  recordFailure(input: {
    toolCallId: string;
    toolName: string;
    code: string;
    sideEffectState: "none" | "request_sent";
    attempt?: number;
    maxAttempts?: number;
    terminal?: boolean;
  }): Promise<string | null>;
}

export function createStewardToolDiagnosticSink(input: {
  runId: string;
  cycleId: string | null;
  record(operation: AgentWorkerAuditOperation): Promise<void>;
  now?: () => string;
  createId?: () => string;
}): StewardToolDiagnosticSink {
  return {
    async recordFailure({ toolCallId, toolName, code, sideEffectState, attempt, maxAttempts, terminal = false }) {
      const definition = stewardDiagnosticCatalog.get(code);
      if (!definition) return null;
      if ((attempt === undefined) !== (maxAttempts === undefined)) throw safeEmitterError("SAFE_DIAGNOSTIC_ATTEMPT_INVALID");
      const boundedCorrection = definition.defaultRetryability === "model_correction"
        && attempt !== undefined && maxAttempts !== undefined && !terminal;
      const modelCorrectable = boundedCorrection && sideEffectState === "none";
      const requestSentCorrection = boundedCorrection && sideEffectState === "request_sent";
      const diagnosticId = (input.createId ?? randomUUID)();
      await input.record({
        type: "safe_diagnostic.append",
        diagnostic: {
          schemaVersion: 1,
          diagnosticId,
          operationKind: "tool_call",
          operationId: toolCallId,
          runId: input.runId,
          cycleId: input.cycleId,
          toolInvocationId: toolCallId,
          parentDiagnosticId: null,
          sequence: 1,
          owner: definition.owner,
          boundary: definition.boundary,
          code,
          toolName,
          attempt: attempt ?? null,
          maxAttempts: maxAttempts ?? null,
          sideEffectState,
          disposition: terminal ? "terminal" : modelCorrectable || requestSentCorrection ? "correctable" : "terminal",
          retryability: terminal ? "do_not_retry"
            : modelCorrectable ? "model_correction"
            : requestSentCorrection ? "safe_retry"
            : definition.defaultRetryability,
          occurredAt: (input.now ?? (() => new Date().toISOString()))(),
        },
      });
      return diagnosticId;
    },
  };
}

export function createGrowthRevisionDiagnosticSink(input: {
  runId: string;
  cycleId: string;
  record(operation: AgentWorkerAuditOperation): Promise<void>;
  now?: () => string;
  createId?: () => string;
}): GrowthRevisionDiagnosticSink {
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.createId ?? randomUUID;

  async function append(value: Omit<SafeDiagnosticEnvelopeV1, "schemaVersion" | "diagnosticId" | "occurredAt">): Promise<string> {
    const diagnosticId = createId();
    await input.record({
      type: "safe_diagnostic.append",
      diagnostic: {
        schemaVersion: 1,
        diagnosticId,
        ...value,
        occurredAt: now(),
      },
    });
    return diagnosticId;
  }

  function requireCode(code: string): string {
    if (!growthRevisionDiagnosticCatalog.get(code)) throw safeEmitterError("SAFE_DIAGNOSTIC_CODE_UNREGISTERED");
    return code;
  }

  return {
    recordCompileFailure: async ({ toolCallId, code, attempt, maxAttempts, terminal }) => await append({
      operationKind: "tool_call",
      operationId: toolCallId,
      runId: input.runId,
      cycleId: input.cycleId,
      toolInvocationId: toolCallId,
      parentDiagnosticId: null,
      sequence: 1,
      owner: "growth_phase",
      boundary: "phase_compile",
      code: requireCode(code),
      toolName: "propose_change_set",
      attempt,
      maxAttempts,
      sideEffectState: "none",
      disposition: terminal ? "terminal" : "correctable",
      retryability: terminal ? "do_not_retry" : "model_correction",
    }),
    recordCompileCorrected: async ({ toolCallId, code, attempt, maxAttempts, parentDiagnosticId }) => await append({
      operationKind: "tool_call",
      operationId: toolCallId,
      runId: input.runId,
      cycleId: input.cycleId,
      toolInvocationId: toolCallId,
      parentDiagnosticId,
      sequence: 1,
      owner: "growth_phase",
      boundary: "phase_correction",
      code: requireCode(code),
      toolName: "propose_change_set",
      attempt,
      maxAttempts,
      sideEffectState: "none",
      disposition: "corrected",
      retryability: "do_not_retry",
    }),
  };
}

function safeEmitterError(
  code: "SAFE_DIAGNOSTIC_CODE_UNREGISTERED" | "SAFE_DIAGNOSTIC_ATTEMPT_INVALID",
): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
