import type { AgentTool } from "@earendil-works/pi-agent-core";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
import type { AgentWorkerAuditOperation, AgentCollaborationContext, AgentSessionHistory, GrowthRunBinding } from "../shared/agentWorkerProtocol";
import { createStewardStateCorrection, getAgentRuntimeProfile } from "../shared/agentRuntimeProfiles";
import type { ProviderRuntimeProfile } from "../shared/providerContract";
import type { RoleOutputToolCapture } from "./contracts/roleOutputTool";
import { stewardOutputSchema, type StewardOutput } from "./contracts/roleOutputs";
import type { SafePiEvent } from "./pi/eventProjection";
import { auditProviderProtocolStage, providerProtocolError } from "./pi/providerProtocolStage";
import type { RuntimeAdapter } from "./pi/runtimeAdapterContract";
import type { PublishedPrompt } from "./promptRegistry";
import { createStewardExecutionStateMachine, type GeneratedImageReference, type InspectedProjectFileReference, type RetrievedDocumentReference } from "./stewardExecutionStateMachine";

export interface StewardRuntimeAudit {
  record(runId: string, operation: AgentWorkerAuditOperation, signal?: AbortSignal): Promise<void>;
}

export interface StewardRuntimeResult {
  adapterResult: Awaited<ReturnType<RuntimeAdapter["run"]>>;
  invocationId: string;
  output: StewardOutput;
  submissionCount: number;
  retrievedDocuments: RetrievedDocumentReference[];
  inspectedFiles: InspectedProjectFileReference[];
  generatedImages: GeneratedImageReference[];
}

export async function runStewardRuntime(input: {
  runId: string;
  userInput: string;
  sessionHistory?: AgentSessionHistory;
  collaborationContext?: AgentCollaborationContext;
  mode: "free" | "assist";
  scopeResourceIds: string[];
  growthBinding?: GrowthRunBinding;
  providerProfile: ProviderRuntimeProfile;
  prompt: PublishedPrompt;
  adapter: RuntimeAdapter;
  tools: AgentTool[];
  resultCapture: RoleOutputToolCapture;
  audit: StewardRuntimeAudit;
  signal?: AbortSignal;
  onEvent?(event: SafePiEvent): void;
}): Promise<StewardRuntimeResult> {
  const invocationId = `${input.runId}:steward`;
  const sessionHistory = input.sessionHistory ?? {
    entries: [],
    completeness: { incomplete: false, omittedMessages: 0 },
  };
  const collaborationContext = input.collaborationContext ?? { sharedMemories: [], handoffs: [] };
  let invocationStarted = false;
  let stateMachine: ReturnType<typeof createStewardExecutionStateMachine> | null = null;
  try {
    if (input.signal?.aborted) throw stewardRuntimeError("AGENT_RUN_CANCELLED");
    await input.audit.record(input.runId, {
      type: "invocation.started",
      invocationId,
      parentInvocationId: null,
      role: "steward",
      prompt: { id: input.prompt.id, version: input.prompt.version, sha256: input.prompt.sha256 },
      profile: getAgentRuntimeProfile("steward"),
      provider: {
        providerId: input.providerProfile.providerId,
        requestedModelId: input.providerProfile.modelId,
        providerConfigSha256: providerConfigSha256(input.providerProfile),
      },
      handoff: null,
      inputSha256: canonicalAuditHash({ userInput: input.userInput, sessionHistory, collaborationContext }),
    }, input.signal);
    invocationStarted = true;

    const machine = createStewardExecutionStateMachine({
      mode: input.mode,
      userInput: input.userInput,
      authorizedScopeResourceIds: input.scopeResourceIds,
      growthBinding: input.growthBinding,
      operationalTools: input.tools,
      resultCapture: input.resultCapture,
      longReadMaxChars: resolveLongReadMaxChars(input.providerProfile.contextWindow),
    });
    stateMachine = machine;
    const adapterResult = await input.adapter.run({
      systemPrompt: input.prompt.content,
      userInput: input.userInput,
      sessionHistory,
      collaborationContext,
      tools: machine.tools,
      signal: input.signal,
      onEvent: input.onEvent,
      completionGuard: {
        toolName: "submit_steward_result",
        isSatisfied: () => machine.resultCapture.getSubmission() !== null,
        createCorrection: () => createStewardStateCorrection(
          machine.requiredNextTool(),
          machine.finalizationContract(),
          machine.lastFinalRejectionCode() ?? "STRUCTURED_RESULT_REQUIRED",
        ),
        forceTool: true,
        requiredToolName: () => machine.requiredNextTool(),
      },
    });
    if (input.signal?.aborted) throw stewardRuntimeError("AGENT_RUN_CANCELLED");
    const submission = machine.resultCapture.getSubmission();
    const submissionCount = machine.resultCapture.getSubmissionCount();
    if (submissionCount !== 1 || !submission) throw providerProtocolError("PROVIDER_PROTOCOL_STRUCTURED_RESULT_MISSING");
    let output: StewardOutput;
    try {
      output = stewardOutputSchema.parse(submission);
    } catch {
      throw providerProtocolError("PROVIDER_PROTOCOL_STRUCTURED_RESULT_INVALID");
    }
    await input.audit.record(input.runId, {
      type: "invocation.terminal",
      invocationId,
      eventType: output.status,
      errorCode: null,
      receipt: auditReceipt(adapterResult),
      structuredSubmissionCount: submissionCount,
      outputSha256: canonicalAuditHash(output),
    });
    invocationStarted = false;
    return {
      adapterResult,
      invocationId,
      output,
      submissionCount,
      retrievedDocuments: machine.snapshot().retrievedDocuments,
      inspectedFiles: machine.snapshot().inspectedFiles,
      generatedImages: machine.snapshot().generatedImages,
    };
  } catch (cause) {
    const effectiveCause = stateMachine?.lastFinalRejectionCode()
      ? stewardRuntimeError(stateMachine.lastFinalRejectionCode()!)
      : cause;
    if (!invocationStarted) throw cause;
    try {
      await input.audit.record(input.runId, {
        type: "invocation.terminal",
        invocationId,
        eventType: readErrorCode(effectiveCause) === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed",
        errorCode: auditProviderProtocolStage(effectiveCause) ?? readErrorCode(effectiveCause) ?? "AGENT_RUN_FAILED",
        receipt: emptyAuditReceipt(null),
        structuredSubmissionCount: input.resultCapture.getSubmissionCount(),
        outputSha256: null,
      });
    } catch {
      throw stewardRuntimeError("AGENT_AUDIT_REQUIRED");
    }
    throw attachPublicTrace(effectiveCause, stateMachine?.snapshot().executions ?? []);
  }
}

export function resolveLongReadMaxChars(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return 4_000;
  return Math.min(8_000, Math.max(4_000, Math.floor(contextWindow / 16)));
}

function attachPublicTrace(
  cause: unknown,
  executions: Array<{ tool: "retrieve_graph_evidence" | "submit_growth_inquiry" | "inspect_project_files" | "list_project_directory" | "stat_project_file" | "glob_project_files" | "search_project_files" | "read_project_file" | "save_task_note" | "list_task_notes" | "generate_image" | "propose_change_set" | "writer" | "checker"; status: "succeeded" | "failed" }>,
): unknown {
  if (!cause || typeof cause !== "object") return cause;
  return Object.assign(cause, { publicToolOutcomes: executions.map((execution) => ({ ...execution })) });
}

function providerConfigSha256(profile: ProviderRuntimeProfile): string {
  const { apiKey: _apiKey, ...safeConfig } = profile;
  return canonicalAuditHash(safeConfig);
}

function auditReceipt(result: Awaited<ReturnType<RuntimeAdapter["run"]>>) {
  return result.receipt
    ? {
        ...result.receipt,
        systemPromptTokens: result.receipt.systemPromptTokens ?? null,
        toolProtocolTokens: result.receipt.toolProtocolTokens ?? null,
        sessionHistoryTokens: result.receipt.sessionHistoryTokens ?? null,
        retrievalTokens: result.receipt.retrievalTokens ?? null,
        collaborationTokens: result.receipt.collaborationTokens ?? null,
        runtimeConversationTokens: result.receipt.runtimeConversationTokens ?? null,
        estimatedInputTokens: result.receipt.estimatedInputTokens ?? null,
        availableInputBudget: result.receipt.availableInputBudget ?? null,
        correctionAttempts: result.receipt.correctionAttempts ?? 0,
        stopReason: result.stopReason,
      }
    : emptyAuditReceipt(result.stopReason);
}

function emptyAuditReceipt(stopReason: string | null) {
  return {
    actualProviderId: null,
    actualModelId: null,
    responseIdSha256: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    contextPolicyVersion: null,
    maxChargedInputBytes: null,
    configuredContextWindow: null,
    safetyReserve: null,
    outputReserve: null,
    estimatedInputTokens: null,
    availableInputBudget: null,
    systemPromptTokens: null,
    toolProtocolTokens: null,
    sessionHistoryTokens: null,
    retrievalTokens: null,
    collaborationTokens: null,
    runtimeConversationTokens: null,
    correctionAttempts: 0,
    stopReason,
  };
}

function readErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  return String(value.code);
}

function stewardRuntimeError(code: string): Error & { code: string } {
  return Object.assign(new Error("Steward Agent contract failed."), { code });
}
