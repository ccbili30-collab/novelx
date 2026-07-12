import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_V2_PROTOCOL_VERSION,
  RuntimeV2ProtocolVersionError,
  parseRuntimeV2Envelope,
  parseRuntimeV2HelloEnvelope,
  parseRuntimeV2InitializeEnvelope,
  parseRuntimeV2ReadyEnvelope,
  parseRuntimeV2ErrorEnvelope,
  parseRuntimeV2InitializationFailedEnvelope,
  parseRuntimeV2ShutdownEnvelope,
  parseRuntimeV2StatusEnvelope,
  parseRuntimeV2StatusGetEnvelope,
  parseRuntimeV2StoppedEnvelope,
  parseRuntimeV2RunGetEnvelope,
  parseRuntimeV2RunPrepareEnvelope,
  parseRuntimeV2RunCancelEnvelope,
  parseRuntimeV2RunReconcileEnvelope,
  parseRuntimeV2RunReconciledEnvelope,
  parseRuntimeV2RunSnapshotEnvelope,
  parseRuntimeV2RunStartEnvelope,
  parseRuntimeV2ContextCompileEnvelope,
  parseRuntimeV2ContextCompilationEnvelope,
  parseRuntimeV2ContextRejectedEnvelope,
  parseRuntimeV2SensitiveProviderBindEnvelope,
  parseRuntimeV2ProviderBoundEnvelope,
  parseRuntimeV2ToolRequestEnvelope,
  parseRuntimeV2ToolRequestedEnvelope,
  parseRuntimeV2ToolOutcomeUnknownEnvelope,
  parseRuntimeV2ProviderInferenceAcceptedEnvelope,
  parseRuntimeV2ProviderInferenceCompletedEnvelope,
  parseRuntimeV2ProviderInferenceFailedEnvelope,
  parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope,
  parseRuntimeV2ProviderInferenceStartEnvelope,
  runtimeV2EnvelopeSchema,
} from "../../src/shared/runtimeV2Protocol";

const MESSAGE_ID = "35bf2cb7-b0db-44e7-985d-664f9cd98f97";
const INITIALIZE_MESSAGE_ID = "63987751-050a-4df7-af86-b30f333ceb0d";

function helloEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
    messageId: MESSAGE_ID,
    messageType: "control",
    name: "runtime.hello",
    sentAt: "2026-07-12T00:00:00Z",
    correlationId: null,
    runId: null,
    sequence: 1,
    payload: {
      runtimeVersion: "0.1.0",
      protocolVersions: [1],
      capabilities: ["handshake"],
      build: {
        commit: "development",
        target: "x86_64-pc-windows-msvc",
      },
    },
    ...overrides,
  };
}

function initializeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: INITIALIZE_MESSAGE_ID,
    messageType: "command",
    name: "runtime.initialize",
    sentAt: "2026-07-12T00:00:01Z",
    correlationId: null,
    runId: null,
    sequence: 1,
    payload: {
      selectedProtocolVersion: 1,
      application: {
        id: "novelx.desktop",
        version: "0.2.7",
        commit: "desktop-development",
      },
      workspaceDatabasePath: "C:\\NovelX\\Project\\.novax\\workspace.db",
      projectRootPath: "C:\\NovelX\\Project",
      projectId: "project-1",
      workspaceId: "workspace-1",
      featureFlags: {
        runtime_v2: true,
        recovery: false,
      },
      hostCapabilityVersions: {
        project_tools: "1.0.0",
        change_set: "2.0.0",
      },
    },
    ...overrides,
  };
}

function readyEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "b1ca577f-49ea-4936-b552-a6f96c802d53",
    messageType: "control",
    name: "runtime.ready",
    sentAt: "2026-07-12T00:00:02Z",
    correlationId: INITIALIZE_MESSAGE_ID,
    runId: null,
    sequence: 2,
    payload: {
      selectedProtocolVersion: 1,
      runtime: {
        version: "0.1.0",
        build: {
          commit: "runtime-development",
          target: "x86_64-pc-windows-msvc",
        },
      },
      recoveredRunCount: 0,
    },
    ...overrides,
  };
}

function errorEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "82c0bfc5-d1a1-4e9b-9851-356b232316d7",
    messageType: "event",
    name: "runtime.error",
    sentAt: "2026-07-12T00:00:03Z",
    correlationId: INITIALIZE_MESSAGE_ID,
    runId: "b12921df-c6bb-47d6-90d5-148c264624f6",
    sequence: 3,
    payload: {
      code: "TOOL_RESULT_MISSING",
      class: "protocol",
      retryable: false,
      publicMessage: "工具执行记录不完整，任务已停止。",
      stage: "context.compile",
      attempt: 1,
      diagnosticId: "1ad046e3-e048-4f33-aa77-85ae75b28fb7",
    },
    ...overrides,
  };
}

function initializationFailedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "3780030f-921e-4510-82c1-500b0af8ee03",
    messageType: "control",
    name: "runtime.initialization_failed",
    sentAt: "2026-07-12T00:00:03Z",
    correlationId: INITIALIZE_MESSAGE_ID,
    runId: null,
    sequence: 3,
    payload: {
      code: "RUNTIME_JOURNAL_INTEGRITY_FAILED",
      class: "storage",
      retryable: false,
      publicMessage: "运行记录完整性检查失败，Runtime V2 未启动。",
      stage: "runtime.initialize",
      attempt: 1,
      diagnosticId: "d6a03646-04ef-4b3e-9639-47b2a843f3a2",
    },
    ...overrides,
  };
}

function statusGetEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "90b45f0d-3df9-45d6-a578-521358bb8fb3",
    messageType: "command",
    name: "runtime.status.get",
    sentAt: "2026-07-12T00:00:04Z",
    correlationId: null,
    runId: null,
    sequence: 3,
    payload: {},
    ...overrides,
  };
}

function statusEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "622457d6-b458-418a-8a89-f51cf1e699da",
    messageType: "response",
    name: "runtime.status",
    sentAt: "2026-07-12T00:00:05Z",
    correlationId: statusGetEnvelope().messageId,
    runId: null,
    sequence: 3,
    payload: {
      initialized: true,
      workspaceDatabaseConfigured: true,
      recoveredRunCount: 2,
      protocolVersion: 1,
      runtimeVersion: "0.1.0",
    },
    ...overrides,
  };
}

function shutdownEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "05781875-af7d-49ca-af8e-cec1c9e48dcf",
    messageType: "command",
    name: "runtime.shutdown",
    sentAt: "2026-07-12T00:00:06Z",
    correlationId: null,
    runId: null,
    sequence: 4,
    payload: {},
    ...overrides,
  };
}

function stoppedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "682a6389-1cdb-43b2-8f93-f4df8def3783",
    messageType: "response",
    name: "runtime.stopped",
    sentAt: "2026-07-12T00:00:07Z",
    correlationId: shutdownEnvelope().messageId,
    runId: null,
    sequence: 4,
    payload: { reason: "requested" },
    ...overrides,
  };
}

function runPinnedIdentity() {
  const policy = (id: string, digit: string) => ({ id, version: "1.0.0", sha256: digit.repeat(64) });
  return {
    projectId: "project-1", workspaceId: "workspace-1", sessionId: "session-1",
    sessionBranchId: "session-branch-1", userMessageId: "user-message-1", projectBranchId: "project-branch-1",
    goal: null, plan: null,
    provider: { profileId: "profile-1", providerId: "deepseek", modelId: "deepseek-chat", configSha256: "a".repeat(64) },
    promptBundle: policy("novelx.steward", "b"), agentProfile: policy("novelx.agent.steward", "c"),
    toolPolicy: policy("novelx.tools", "d"), contextPolicy: policy("novelx.context", "e"),
    runtimePolicy: policy("novelx.runtime", "f"), runtimeContractVersion: "1.0.0", mode: "assist",
    sourceCheckpointId: "checkpoint-1", scopeResourceIds: ["resource-1", "resource-2"],
    resourceScopeSha256: "1".repeat(64), userInputSha256: "2".repeat(64),
  };
}

function runStartEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1, messageId: "7f56e8cb-c0b4-46fc-91f8-15bb057c9323", messageType: "command",
    name: "run.start", sentAt: "2026-07-12T00:00:08Z", correlationId: null,
    runId: "f25772f3-b0aa-4449-92eb-8ddf611a810d", sequence: 5,
    payload: { startIdempotencyKey: "stable-start-1", pinnedIdentity: runPinnedIdentity() }, ...overrides,
  };
}

function runGetEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "68af36c1-b51d-4e18-80ac-a20bcc7d2b37", name: "run.get", sequence: 6,
    payload: {}, ...overrides,
  };
}

function runCancelEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "9de9695a-ed59-4c14-92d7-cfd9dfd5df6d", name: "run.cancel", sequence: 7,
    payload: { cancelIdempotencyKey: "cancel-key-1", reason: "用户停止任务" }, ...overrides,
  };
}

function runPrepareEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "52a163ed-67d4-493c-b00e-ff83354b79b4", name: "run.prepare", sequence: 8,
    payload: { prepareIdempotencyKey: "prepare-key-1" }, ...overrides,
  };
}

function runSnapshotEnvelope(overrides: Record<string, unknown> = {}) {
  const runId = "f25772f3-b0aa-4449-92eb-8ddf611a810d";
  return {
    ...runStartEnvelope(), messageId: "4bb471b3-dc35-4cd0-9f98-f908ffb9db8d", messageType: "response",
    name: "run.snapshot", correlationId: runStartEnvelope().messageId, sequence: 5,
    payload: {
      runId, pinnedIdentity: runPinnedIdentity(), state: "created", recoveryClassification: "resumable",
      runSequence: 1, aggregateSequence: 1, createdAt: "2026-07-12T00:00:09Z", updatedAt: "2026-07-12T00:00:09Z",
      terminalError: null,
    }, ...overrides,
  };
}

function contextCompileEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "aa24d2f9-f4ea-478e-b7ea-33e5aef00d7d", name: "context.compile", sequence: 9,
    payload: {
      compileIdempotencyKey: "compile-1", invocationId: "run-1:steward", requestNumber: 1,
      provider: runPinnedIdentity().provider, contextPolicy: runPinnedIdentity().contextPolicy,
      compilerVersion: "1.0.0", contextWindow: 128_000, configuredMaxOutputTokens: null,
      safetyReserveTokens: 12_800,
      items: [
        { type: "system_prompt", itemId: "system-1", content: "系统约束", contentSha256: "1".repeat(64), disclosure: "agent_internal", required: true },
        { type: "tool_protocol", itemId: "tool-1", toolName: "project.read", schemaVersion: 1, protocol: { type: "object" }, contentSha256: "2".repeat(64), disclosure: "agent_internal", required: true },
        { type: "session_message", itemId: "message-1", messageId: "user-message-1", role: "user", content: "继续海岸讨论", contentSha256: "3".repeat(64), createdAt: "2026-07-12T00:00:12Z", disclosure: "project_private", required: true },
        { type: "retrieval_source", itemId: "source-1", sourceReceiptId: "receipt-1", sourceKind: "document", stableVersionId: "version-1", content: "海岸形成于沉降纪元", contentSha256: "4".repeat(64), complete: true, disclosure: "project_private", required: false },
        { type: "runtime_exchange", itemId: "exchange-1", exchangeId: "tool-call-1", kind: "tool_call", content: { toolCallId: "tool-call-1", toolName: "project.read", argumentsSha256: "5".repeat(64) }, contentSha256: "6".repeat(64), disclosure: "agent_internal", required: true },
        { type: "output_reserve", itemId: "output-1", requestedTokens: 8_192, policyId: "auto-output-v1", disclosure: "agent_internal" },
      ],
    },
    ...overrides,
  };
}

function contextCompilationEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "f717bf82-774f-41bc-b86c-dbf0f70ed699", messageType: "response",
    name: "context.compilation", correlationId: contextCompileEnvelope().messageId, sequence: 9,
    payload: {
      compilationId: "4fd4ac92-f863-49ca-8844-69d36d716cdf", requestNumber: 1, compilerVersion: "1.0.0",
      tokenizer: { kind: "fallback_estimate", id: "unicode-mixed", version: "1.0.0", providerId: "deepseek", modelId: "deepseek-chat" },
      representation: "normalized_messages", canonicalContextSha256: "7".repeat(64), serializedInputBytes: 12_000,
      estimatedInputTokens: 4_000, exactInputTokens: null, contextWindow: 128_000,
      safetyReserveTokens: 12_800, outputReserveTokens: 8_192, availableInputTokens: 107_008,
      accepted: true,
      budget: [
        { category: "system_prompt", estimatedTokens: 500 },
        { category: "tool_protocol", estimatedTokens: 300 },
        { category: "session_history", estimatedTokens: 200 },
        { category: "retrieval", estimatedTokens: 3_000 },
      ],
      includedItemIds: ["system-1", "tool-1", "message-1"], omittedItemIds: ["source-1"], incomplete: true,
      disclosure: "agent_internal",
    },
    ...overrides,
  };
}

function contextRejectedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "ae778e0c-14a4-4d0f-8805-cc17453df823", messageType: "response",
    name: "context.rejected", correlationId: contextCompileEnvelope().messageId, sequence: 9,
    payload: { ...errorEnvelope().payload, code: "AGENT_CONTEXT_BUDGET_EXCEEDED", class: "context_capacity", stage: "context.compile" },
    ...overrides,
  };
}

function providerConfig() {
  return {
    schemaVersion: 1, profileId: "profile-1", providerId: "deepseek", displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat",
    apiFlavor: "open_ai_chat_completions", authScheme: "bearer", contextWindow: 1_000_000,
    maxTokens: null, reasoning: false, input: ["text"], requestTimeoutMs: 30_000,
    totalDeadlineMs: 120_000, retryPolicy: { maxAttempts: 3, maxTotalDelayMs: 30_000 },
  };
}

function sensitiveProviderBindEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1, messageId: "44d85a68-1e0a-408c-bce7-d99e191576cf", messageType: "sensitive_command",
    name: "provider.bind", sentAt: "2026-07-12T00:00:10Z", correlationId: null, runId: null, sequence: 8,
    payload: { config: providerConfig(), configSha256: "a".repeat(64), credential: "sensitive-test-key" },
    ...overrides,
  };
}

function providerBoundEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1, messageId: "e56f65e3-f591-4b74-a9ad-a54cc704ae7e", messageType: "response",
    name: "provider.bound", sentAt: "2026-07-12T00:00:11Z",
    correlationId: sensitiveProviderBindEnvelope().messageId, runId: null, sequence: 8,
    payload: { profileId: "profile-1", providerId: "deepseek", modelId: "deepseek-chat", configSha256: "a".repeat(64), contextWindow: 1_000_000, maxTokens: null },
    ...overrides,
  };
}

const INFERENCE_RUN_ID = "b12921df-c6bb-47d6-90d5-148c264624f6";
const INFERENCE_ID = "160c67d9-ed93-49e7-a97d-a03df10bab44";
const ATTEMPT_ID = "ab830c20-872b-46c6-b2d7-fc049c842307";
const COMPILATION_ID = "be992c62-53cb-49d1-97ef-4e4a229ddf6e";

function inferenceIdentity() {
  return {
    runId: INFERENCE_RUN_ID,
    inferenceId: INFERENCE_ID,
    attemptId: ATTEMPT_ID,
    contextCompilationId: COMPILATION_ID,
    requestNumber: 1,
    attemptNumber: 1,
  };
}

function runReconcileEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runStartEnvelope(), messageId: "2e499925-d411-42c1-af2c-199489817906", name: "run.reconcile",
    payload: { reconciliationIdempotencyKey: "reconcile-key-1", attemptId: ATTEMPT_ID,
      decision: "retry_as_new_attempt_acknowledging_duplicate", duplicateExecutionAcknowledged: true },
    ...overrides,
  };
}

function runReconciledEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ...runReconcileEnvelope(), messageId: "427db65f-e72c-4a27-9a63-317542f71e10", messageType: "response",
    name: "run.reconciled", correlationId: runReconcileEnvelope().messageId,
    payload: { attemptId: ATTEMPT_ID, decision: "retry_as_new_attempt_acknowledging_duplicate", state: "retrying" },
    ...overrides,
  };
}

function inferenceEnvelope(name: string, messageType: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "a046a060-a090-479c-a4e0-f3b308e06093",
    messageType,
    name,
    sentAt: "2026-07-12T00:00:10Z",
    correlationId: messageType === "command" ? null : "4321c381-ce95-43ca-b0fc-427c37c55d2f",
    runId: INFERENCE_RUN_ID,
    sequence: 10,
    payload,
    ...overrides,
  };
}

function inferenceStartEnvelope(overrides: Record<string, unknown> = {}) {
  const { runId: _runId, ...identity } = inferenceIdentity();
  return inferenceEnvelope("provider.inference.start", "command", {
    ...identity,
    invocationId: "invocation-1",
    inferenceIdempotencyKey: "inference-key-1",
  }, overrides);
}

function inferenceAcceptedEnvelope(overrides: Record<string, unknown> = {}) {
  return inferenceEnvelope("provider.inference.accepted", "response", inferenceIdentity(), overrides);
}

function inferenceCompletedEnvelope(overrides: Record<string, unknown> = {}) {
  return inferenceEnvelope("provider.inference.completed", "event", {
    ...inferenceIdentity(),
    providerId: "deepseek",
    modelId: "deepseek-chat",
    responseIdSha256: "3".repeat(64),
    responseBodySha256: "4".repeat(64),
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    output: { text: "done", textSha256: "a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211", utf8Bytes: 4 },
    toolCalls: [],
  }, overrides);
}

function inferenceFailedEnvelope(overrides: Record<string, unknown> = {}) {
  return inferenceEnvelope("provider.inference.failed", "event", {
    ...inferenceIdentity(),
    error: { ...errorEnvelope().payload, stage: "provider.inference", retryable: false },
  }, overrides);
}

function inferenceReconciliationEnvelope(overrides: Record<string, unknown> = {}) {
  return inferenceEnvelope("provider.inference.reconciliation_required", "event", {
    ...inferenceIdentity(),
    reason: "outcome_unknown",
    error: { ...errorEnvelope().payload, code: "PROVIDER_OUTCOME_UNKNOWN", stage: "provider.inference", retryable: false },
  }, overrides);
}

describe("Runtime V2 Protocol V1 TypeScript mirror", () => {
  it("accepts the Rust runtime.hello envelope", () => {
    expect(parseRuntimeV2HelloEnvelope(helloEnvelope())).toEqual(helloEnvelope());
  });

  it("accepts every Protocol V1 message type in the common envelope", () => {
    for (const messageType of ["command", "event", "response", "control"] as const) {
      expect(parseRuntimeV2Envelope(helloEnvelope({
        messageType,
        name: `${messageType}.test`,
      })).messageType).toBe(messageType);
    }
  });

  it("rejects unsupported protocol versions with a typed error", () => {
    expect(() => parseRuntimeV2Envelope(helloEnvelope({ protocolVersion: 2 }))).toThrowError(
      RuntimeV2ProtocolVersionError,
    );
    try {
      parseRuntimeV2Envelope(helloEnvelope({ protocolVersion: 2 }));
      throw new Error("Expected the unsupported version to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED",
        received: 2,
        supported: 1,
      });
    }
  });

  it("rejects missing or malformed UUID identities", () => {
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ messageId: "not-a-uuid" })).success).toBe(false);
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ correlationId: "request-1" })).success).toBe(false);
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ runId: "run-1" })).success).toBe(false);
  });

  it("requires a positive safe integer sequence", () => {
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ sequence })).success).toBe(false);
    }
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ sequence: Number.MAX_SAFE_INTEGER })).success).toBe(true);
  });

  it("rejects unknown messageType values", () => {
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ messageType: "request" })).success).toBe(false);
  });

  it("enforces the runtime.hello name, control type and advertised V1 support", () => {
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({ name: "runtime.ready" }))).toThrow();
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({ messageType: "event" }))).toThrow();
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({
      payload: {
        ...helloEnvelope().payload,
        protocolVersions: [2],
      },
    }))).toThrow();
  });

  it("rejects unknown envelope and hello payload fields", () => {
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ unexpected: true })).success).toBe(false);
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({
      payload: {
        ...helloEnvelope().payload,
        secret: "must-not-cross-handshake",
      },
    }))).toThrow();
  });

  it("accepts a strict runtime.initialize command with nullable workspace", () => {
    expect(parseRuntimeV2InitializeEnvelope(initializeEnvelope())).toEqual(initializeEnvelope());
    expect(parseRuntimeV2InitializeEnvelope(initializeEnvelope({
      payload: {
        ...initializeEnvelope().payload,
        workspaceDatabasePath: null,
        projectRootPath: null,
        projectId: null,
        workspaceId: null,
      },
    })).payload.workspaceDatabasePath).toBeNull();
    expect(() => parseRuntimeV2InitializeEnvelope(initializeEnvelope({
      payload: { ...initializeEnvelope().payload, projectRootPath: null },
    }))).toThrow();
  });

  it("rejects invalid runtime.initialize identities, versions and secrets", () => {
    expect(() => parseRuntimeV2InitializeEnvelope(initializeEnvelope({ messageType: "control" }))).toThrow();
    expect(() => parseRuntimeV2InitializeEnvelope(initializeEnvelope({
      payload: {
        ...initializeEnvelope().payload,
        selectedProtocolVersion: 2,
      },
    }))).toThrow();
    expect(() => parseRuntimeV2InitializeEnvelope(initializeEnvelope({
      payload: {
        ...initializeEnvelope().payload,
        apiKey: "must-not-cross-handshake",
      },
    }))).toThrow();
    expect(() => parseRuntimeV2InitializeEnvelope(initializeEnvelope({
      payload: {
        ...initializeEnvelope().payload,
        hostCapabilityVersions: { project_tools: "latest" },
      },
    }))).toThrow();
  });

  it("accepts a strict runtime.ready control correlated to initialize", () => {
    expect(parseRuntimeV2ReadyEnvelope(readyEnvelope())).toEqual(readyEnvelope());
    expect(parseRuntimeV2ReadyEnvelope(readyEnvelope({
      payload: {
        ...readyEnvelope().payload,
        recoveredRunCount: 3,
      },
    })).payload.recoveredRunCount).toBe(3);
  });

  it("rejects uncorrelated or malformed runtime.ready messages", () => {
    expect(() => parseRuntimeV2ReadyEnvelope(readyEnvelope({ correlationId: null }))).toThrow();
    expect(() => parseRuntimeV2ReadyEnvelope(readyEnvelope({ runId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2ReadyEnvelope(readyEnvelope({
      payload: {
        ...readyEnvelope().payload,
        recoveredRunCount: -1,
      },
    }))).toThrow();
    expect(() => parseRuntimeV2ReadyEnvelope(readyEnvelope({
      payload: {
        ...readyEnvelope().payload,
        selectedProtocolVersion: 2,
      },
    }))).toThrow();
  });

  it("accepts structured runtime.error events with nullable run and correlation identities", () => {
    expect(parseRuntimeV2ErrorEnvelope(errorEnvelope())).toEqual(errorEnvelope());
    expect(parseRuntimeV2ErrorEnvelope(errorEnvelope({
      correlationId: null,
      runId: null,
    }))).toMatchObject({ correlationId: null, runId: null });
  });

  it("rejects unknown runtime error classes and empty or unstable codes", () => {
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({
      payload: { ...errorEnvelope().payload, class: "network" },
    }))).toThrow();
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({
      payload: { ...errorEnvelope().payload, code: "" },
    }))).toThrow();
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({
      payload: { ...errorEnvelope().payload, code: "tool result missing" },
    }))).toThrow();
  });

  it("rejects malformed diagnostic identity and negative attempts", () => {
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({
      payload: { ...errorEnvelope().payload, diagnosticId: "diagnostic-1" },
    }))).toThrow();
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({
      payload: { ...errorEnvelope().payload, attempt: -1 },
    }))).toThrow();
  });

  it("rejects extra runtime error fields and the wrong envelope projection", () => {
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({
      payload: { ...errorEnvelope().payload, internalStack: "secret" },
    }))).toThrow();
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({ messageType: "control" }))).toThrow();
    expect(() => parseRuntimeV2ErrorEnvelope(errorEnvelope({ name: "run.failed" }))).toThrow();
  });

  it("accepts runtime.initialization_failed correlated to initialize", () => {
    expect(parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope()))
      .toEqual(initializationFailedEnvelope());
  });

  it("rejects invalid runtime.initialization_failed envelope identities and fields", () => {
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      messageType: "event",
    }))).toThrow();
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      correlationId: null,
    }))).toThrow();
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      runId: MESSAGE_ID,
    }))).toThrow();
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      unexpected: true,
    }))).toThrow();
  });

  it("rejects invalid runtime.initialization_failed error payloads", () => {
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      payload: { ...initializationFailedEnvelope().payload, class: "database" },
    }))).toThrow();
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      payload: { ...initializationFailedEnvelope().payload, diagnosticId: "diagnostic-1" },
    }))).toThrow();
    expect(() => parseRuntimeV2InitializationFailedEnvelope(initializationFailedEnvelope({
      payload: { ...initializationFailedEnvelope().payload, internalError: "must-not-cross-protocol" },
    }))).toThrow();
  });

  it("accepts runtime.status.get and its correlated runtime.status response", () => {
    expect(parseRuntimeV2StatusGetEnvelope(statusGetEnvelope())).toEqual(statusGetEnvelope());
    expect(parseRuntimeV2StatusEnvelope(statusEnvelope())).toEqual(statusEnvelope());
  });

  it("strictly rejects malformed status commands and responses", () => {
    expect(() => parseRuntimeV2StatusGetEnvelope(statusGetEnvelope({ payload: { extra: true } }))).toThrow();
    expect(() => parseRuntimeV2StatusGetEnvelope(statusGetEnvelope({ messageType: "control" }))).toThrow();
    expect(() => parseRuntimeV2StatusGetEnvelope(statusGetEnvelope({ correlationId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2StatusGetEnvelope(statusGetEnvelope({ runId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2StatusEnvelope(statusEnvelope({ name: "runtime.ready" }))).toThrow();
    expect(() => parseRuntimeV2StatusEnvelope(statusEnvelope({ correlationId: null }))).toThrow();
    expect(() => parseRuntimeV2StatusEnvelope(statusEnvelope({ runId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2StatusEnvelope(statusEnvelope({
      payload: { ...statusEnvelope().payload, initialized: false },
    }))).toThrow();
    expect(() => parseRuntimeV2StatusEnvelope(statusEnvelope({
      payload: { ...statusEnvelope().payload, extra: true },
    }))).toThrow();
  });

  it("accepts runtime.shutdown and its correlated runtime.stopped response", () => {
    expect(parseRuntimeV2ShutdownEnvelope(shutdownEnvelope())).toEqual(shutdownEnvelope());
    expect(parseRuntimeV2StoppedEnvelope(stoppedEnvelope())).toEqual(stoppedEnvelope());
  });

  it("strictly rejects malformed shutdown commands and stopped responses", () => {
    expect(() => parseRuntimeV2ShutdownEnvelope(shutdownEnvelope({ payload: { force: true } }))).toThrow();
    expect(() => parseRuntimeV2ShutdownEnvelope(shutdownEnvelope({ name: "runtime.stop" }))).toThrow();
    expect(() => parseRuntimeV2ShutdownEnvelope(shutdownEnvelope({ correlationId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2ShutdownEnvelope(shutdownEnvelope({ runId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2StoppedEnvelope(stoppedEnvelope({ messageType: "control" }))).toThrow();
    expect(() => parseRuntimeV2StoppedEnvelope(stoppedEnvelope({ correlationId: null }))).toThrow();
    expect(() => parseRuntimeV2StoppedEnvelope(stoppedEnvelope({ runId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2StoppedEnvelope(stoppedEnvelope({ payload: { reason: "crashed" } }))).toThrow();
    expect(() => parseRuntimeV2StoppedEnvelope(stoppedEnvelope({ payload: { reason: "requested", extra: true } }))).toThrow();
  });

  it("accepts strict run.start, run.get, run.prepare and correlated run.snapshot messages", () => {
    expect(parseRuntimeV2RunStartEnvelope(runStartEnvelope())).toEqual(runStartEnvelope());
    expect(parseRuntimeV2RunGetEnvelope(runGetEnvelope())).toEqual(runGetEnvelope());
    expect(parseRuntimeV2RunPrepareEnvelope(runPrepareEnvelope())).toEqual(runPrepareEnvelope());
    expect(parseRuntimeV2RunCancelEnvelope(runCancelEnvelope())).toEqual(runCancelEnvelope());
    expect(parseRuntimeV2RunSnapshotEnvelope(runSnapshotEnvelope())).toEqual(runSnapshotEnvelope());
  });

  it("accepts waiting_for_reconciliation only with its nonterminal recovery classification", () => {
    expect(parseRuntimeV2RunSnapshotEnvelope(runSnapshotEnvelope({
      payload: {
        ...runSnapshotEnvelope().payload,
        state: "waiting_for_reconciliation",
        recoveryClassification: "waiting_for_reconciliation",
      },
    })).payload).toMatchObject({
      state: "waiting_for_reconciliation",
      recoveryClassification: "waiting_for_reconciliation",
      terminalError: null,
    });
    expect(() => parseRuntimeV2RunSnapshotEnvelope(runSnapshotEnvelope({
      payload: {
        ...runSnapshotEnvelope().payload,
        state: "waiting_for_reconciliation",
        recoveryClassification: "terminal",
      },
    }))).toThrow();
  });

  it("accepts strict run reconciliation decisions and correlated receipts", () => {
    expect(parseRuntimeV2RunReconcileEnvelope(runReconcileEnvelope())).toEqual(runReconcileEnvelope());
    expect(parseRuntimeV2RunReconciledEnvelope(runReconciledEnvelope())).toEqual(runReconciledEnvelope());
    const cancel = runReconcileEnvelope({ payload: { reconciliationIdempotencyKey: "cancel-key", attemptId: ATTEMPT_ID, decision: "cancel_run", duplicateExecutionAcknowledged: false } });
    expect(parseRuntimeV2RunReconcileEnvelope(cancel)).toEqual(cancel);
  });

  it("rejects unsupported or unacknowledged run reconciliation decisions", () => {
    const payload = runReconcileEnvelope().payload;
    expect(() => parseRuntimeV2RunReconcileEnvelope(runReconcileEnvelope({ payload: { ...payload, duplicateExecutionAcknowledged: false } }))).toThrow();
    expect(() => parseRuntimeV2RunReconcileEnvelope(runReconcileEnvelope({ payload: { ...payload, decision: "accept_verified_response" } }))).toThrow();
    expect(() => parseRuntimeV2RunReconcileEnvelope(runReconcileEnvelope({ correlationId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2RunReconciledEnvelope(runReconciledEnvelope({ payload: { ...runReconciledEnvelope().payload, state: "cancelled" } }))).toThrow();
  });

  it("rejects changed, secret-bearing or noncanonical Run identities", () => {
    expect(() => parseRuntimeV2RunStartEnvelope(runStartEnvelope({ runId: null }))).toThrow();
    expect(() => parseRuntimeV2RunStartEnvelope(runStartEnvelope({
      payload: { ...runStartEnvelope().payload, apiKey: "must-not-cross-runtime" },
    }))).toThrow();
    expect(() => parseRuntimeV2RunStartEnvelope(runStartEnvelope({
      payload: {
        ...runStartEnvelope().payload,
        pinnedIdentity: { ...runPinnedIdentity(), scopeResourceIds: ["resource-2", "resource-1"] },
      },
    }))).toThrow();
    expect(() => parseRuntimeV2RunStartEnvelope(runStartEnvelope({
      payload: {
        ...runStartEnvelope().payload,
        pinnedIdentity: { ...runPinnedIdentity(), userInputSha256: "A".repeat(64) },
      },
    }))).toThrow();
    expect(() => parseRuntimeV2RunSnapshotEnvelope(runSnapshotEnvelope({
      runId: "0c49e78c-3a5c-45b5-a1ca-af61173f35a6",
    }))).toThrow();
    expect(() => parseRuntimeV2RunCancelEnvelope(runCancelEnvelope({ payload: { cancelIdempotencyKey: "", reason: "" } }))).toThrow();
    expect(() => parseRuntimeV2RunPrepareEnvelope(runPrepareEnvelope({ payload: { prepareIdempotencyKey: "", extra: true } }))).toThrow();
    expect(() => parseRuntimeV2RunPrepareEnvelope(runPrepareEnvelope({ correlationId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2RunSnapshotEnvelope(runSnapshotEnvelope({
      payload: { ...runSnapshotEnvelope().payload, terminalError: { ...errorEnvelope().payload } },
    }))).not.toThrow();
    expect(() => parseRuntimeV2RunSnapshotEnvelope(runSnapshotEnvelope({
      payload: { ...runSnapshotEnvelope().payload, terminalError: undefined },
    }))).toThrow();
  });

  it("mirrors strict tagged context.compile items and correlated compilation responses", () => {
    expect(parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope())).toEqual(contextCompileEnvelope());
    expect(parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope())).toEqual(contextCompilationEnvelope());
    expect(parseRuntimeV2ContextRejectedEnvelope(contextRejectedEnvelope())).toEqual(contextRejectedEnvelope());
    expect(parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope()).payload.items.map((item) => item.type)).toEqual([
      "system_prompt", "tool_protocol", "session_message", "retrieval_source", "runtime_exchange", "output_reserve",
    ]);
  });

  it("rejects unknown context command fields and malformed tagged item variants", () => {
    expect(() => parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope({
      payload: { ...contextCompileEnvelope().payload, apiKey: "must-not-cross-runtime" },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope({ correlationId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope({ runId: null }))).toThrow();
    expect(() => parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope({
      payload: {
        ...contextCompileEnvelope().payload,
        items: [{
          ...contextCompileEnvelope().payload.items[0],
          toolName: "wrong-variant-field",
        }],
      },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope({
      payload: {
        ...contextCompileEnvelope().payload,
        items: [{ ...contextCompileEnvelope().payload.items[0], type: "unknown_item" }],
      },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompileEnvelope(contextCompileEnvelope({
      payload: {
        ...contextCompileEnvelope().payload,
        items: [contextCompileEnvelope().payload.items[0], contextCompileEnvelope().payload.items[0]],
      },
    }))).toThrow();
  });

  it("enforces context compilation budget identities and strict receipt fields", () => {
    expect(() => parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope({
      payload: { ...contextCompilationEnvelope().payload, availableInputTokens: 107_009 },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope({
      payload: { ...contextCompilationEnvelope().payload, estimatedInputTokens: 107_009 },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope({
      payload: {
        ...contextCompilationEnvelope().payload,
        budget: [
          { category: "retrieval", estimatedTokens: 1 },
          { category: "retrieval", estimatedTokens: 2 },
        ],
      },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope({
      payload: {
        ...contextCompilationEnvelope().payload,
        includedItemIds: ["system-1"], omittedItemIds: ["system-1"],
      },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope({
      payload: { ...contextCompilationEnvelope().payload, incomplete: false },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextCompilationEnvelope(contextCompilationEnvelope({
      payload: { ...contextCompilationEnvelope().payload, internalPacket: "must-not-cross-runtime" },
    }))).toThrow();
    expect(() => parseRuntimeV2ContextRejectedEnvelope(contextRejectedEnvelope({
      payload: { ...contextRejectedEnvelope().payload, internalError: "secret" },
    }))).toThrow();
  });

  it("keeps Provider credentials on a dedicated sensitive message type", () => {
    expect(parseRuntimeV2SensitiveProviderBindEnvelope(sensitiveProviderBindEnvelope()))
      .toEqual(sensitiveProviderBindEnvelope());
    expect(parseRuntimeV2ProviderBoundEnvelope(providerBoundEnvelope())).toEqual(providerBoundEnvelope());
    expect(runtimeV2EnvelopeSchema.safeParse(sensitiveProviderBindEnvelope()).success).toBe(false);
    expect(JSON.stringify(providerBoundEnvelope())).not.toContain("sensitive-test-key");
  });

  it("rejects malformed sensitive Provider bindings", () => {
    expect(() => parseRuntimeV2SensitiveProviderBindEnvelope(sensitiveProviderBindEnvelope({ messageType: "command" }))).toThrow();
    expect(() => parseRuntimeV2SensitiveProviderBindEnvelope(sensitiveProviderBindEnvelope({ runId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2SensitiveProviderBindEnvelope(sensitiveProviderBindEnvelope({
      payload: { ...sensitiveProviderBindEnvelope().payload, credential: "" },
    }))).toThrow();
    expect(() => parseRuntimeV2SensitiveProviderBindEnvelope(sensitiveProviderBindEnvelope({
      payload: { ...sensitiveProviderBindEnvelope().payload, apiKey: "wrong-field" },
    }))).toThrow();
  });

  it("accepts the asynchronous Provider inference command, acceptance and terminal events", () => {
    expect(parseRuntimeV2ProviderInferenceStartEnvelope(inferenceStartEnvelope())).toEqual(inferenceStartEnvelope());
    expect(parseRuntimeV2ProviderInferenceAcceptedEnvelope(inferenceAcceptedEnvelope())).toEqual(inferenceAcceptedEnvelope());
    expect(parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope())).toEqual(inferenceCompletedEnvelope());
    expect(parseRuntimeV2ProviderInferenceFailedEnvelope(inferenceFailedEnvelope())).toEqual(inferenceFailedEnvelope());
    expect(parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope(inferenceReconciliationEnvelope())).toEqual(inferenceReconciliationEnvelope());
  });

  it("keeps Provider inference v1 completion compatibility when toolCalls is absent", () => {
    const legacy = inferenceCompletedEnvelope();
    const { toolCalls: _toolCalls, ...legacyPayload } = legacy.payload;
    const parsed = parseRuntimeV2ProviderInferenceCompletedEnvelope({ ...legacy, payload: legacyPayload });
    expect(parsed.payload.toolCalls).toEqual([]);
    expect(parsed.payload.output).toEqual(legacy.payload.output);
  });

  it("rejects malformed Provider inference identities, envelope roles and unknown fields", () => {
    expect(() => parseRuntimeV2ProviderInferenceStartEnvelope(inferenceStartEnvelope({ correlationId: MESSAGE_ID }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceStartEnvelope(inferenceStartEnvelope({ runId: null }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceStartEnvelope(inferenceStartEnvelope({ messageType: "event" }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceStartEnvelope(inferenceStartEnvelope({ payload: { ...inferenceStartEnvelope().payload, inferenceId: "bad" } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceAcceptedEnvelope(inferenceAcceptedEnvelope({ correlationId: null }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceAcceptedEnvelope(inferenceAcceptedEnvelope({ payload: { ...inferenceIdentity(), runId: MESSAGE_ID } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceFailedEnvelope(inferenceFailedEnvelope({ payload: { ...inferenceFailedEnvelope().payload, secret: true } }))).toThrow();
  });

  it("rejects invalid Provider completion receipts", () => {
    const payload = inferenceCompletedEnvelope().payload;
    const output = payload.output as Record<string, unknown>;
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 11 } } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, responseIdSha256: "" } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, responseBodySha256: "A".repeat(64) } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: { ...output, textSha256: "5".repeat(64) } } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: { ...output, text: "" } } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: { ...output, utf8Bytes: 2 } } }))).toThrow();
    const oversized = "a".repeat(1_048_577);
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: { ...output, text: oversized, utf8Bytes: oversized.length } } }))).toThrow();
  });

  it("accepts structured tool calls and rejects unauditable tool receipts", () => {
    const payload = inferenceCompletedEnvelope().payload;
    const argumentsValue = { path: "README.md" };
    const argumentsSha256 = createHash("sha256").update(JSON.stringify(argumentsValue), "utf8").digest("hex");
    const toolCall = { id: "call-1", name: "read_project", arguments: argumentsValue, argumentsSha256 };
    const pureTool = inferenceCompletedEnvelope({ payload: { ...payload, stopReason: "tool_calls", output: null, toolCalls: [toolCall] } });
    expect(parseRuntimeV2ProviderInferenceCompletedEnvelope(pureTool)).toEqual(pureTool);
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: null, toolCalls: [] } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: null, toolCalls: [toolCall, toolCall] } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceCompletedEnvelope(inferenceCompletedEnvelope({ payload: { ...payload, output: null, toolCalls: [{ ...toolCall, argumentsSha256: "0".repeat(64) }] } }))).toThrow();
  });

  it("requires explicit non-retryable reconciliation for unknown Provider outcomes", () => {
    const payload = inferenceReconciliationEnvelope().payload;
    const error = payload.error as Record<string, unknown>;
    expect(() => parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope(inferenceReconciliationEnvelope({ payload: { ...payload, reason: "timeout" } }))).toThrow();
    expect(() => parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope(inferenceReconciliationEnvelope({ payload: { ...payload, error: { ...error, retryable: true } } }))).toThrow();
  });

  it("accepts strict ToolCall request and public lifecycle events", () => {
    const runId = INFERENCE_RUN_ID;
    const toolCallId = "84bd8b4b-6ca3-4ac2-ad3d-12780d816c11";
    const request = {
      protocolVersion: 1, messageId: MESSAGE_ID, messageType: "command", name: "tool.request",
      sentAt: "2026-07-12T00:00:00Z", correlationId: null, runId, sequence: 1,
      payload: { requestIdempotencyKey: "tool-request-1", toolCallId, providerToolCallId: "call-provider-1", invocationId: "invocation-1", toolName: "project.read",
        schemaVersion: 1, attempt: 1, sideEffect: "none", parallel: false,
        arguments: { artifactId: "5280c959-1f02-4c20-ae9f-851878d4e050", mediaType: "application/json", sha256: "a".repeat(64), utf8Bytes: 2 },
        sourceScope: { sourceCheckpointId: "checkpoint-1", resourceIds: ["resource-1"], scopeSha256: "b".repeat(64) },
        permission: { mode: "assist", policyId: "tools", policyVersion: "1.0.0", policySha256: "c".repeat(64) } },
    };
    expect(parseRuntimeV2ToolRequestEnvelope(request)).toEqual(request);
    const requestWithoutProviderCallId = structuredClone(request);
    delete (requestWithoutProviderCallId.payload as Record<string, unknown>).providerToolCallId;
    expect(() => parseRuntimeV2ToolRequestEnvelope(requestWithoutProviderCallId)).toThrow();
    const identity = { runId, toolCallId, providerToolCallId: "call-provider-1", invocationId: "invocation-1", toolName: "project.read", schemaVersion: 1,
      attempt: 1, sideEffect: "none", parallel: false, argumentsSha256: "a".repeat(64), sourceScopeSha256: "b".repeat(64) };
    const requested = { ...request, messageType: "event", name: "tool.requested", correlationId: MESSAGE_ID,
      payload: { ...identity, permission: request.payload.permission, authorization: "approval_required" } };
    expect(parseRuntimeV2ToolRequestedEnvelope(requested)).toEqual(requested);
    const unknown = { ...requested, name: "tool.outcome_unknown",
      payload: { ...identity, leaseId: "24897032-f6f8-4b22-bc17-141987f5807c", error: { ...errorEnvelope().payload, retryable: false } } };
    expect(parseRuntimeV2ToolOutcomeUnknownEnvelope(unknown)).toEqual(unknown);
    expect(() => parseRuntimeV2ToolOutcomeUnknownEnvelope({ ...unknown, payload: { ...unknown.payload, error: { ...unknown.payload.error, retryable: true } } })).toThrow();
    expect(() => parseRuntimeV2ToolRequestedEnvelope({ ...requested, payload: { ...requested.payload, authorization: "allowed" } })).toThrow();
  });
});
