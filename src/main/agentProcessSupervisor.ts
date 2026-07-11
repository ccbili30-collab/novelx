import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { agentRunEventSchema, type AgentRunEvent, type AgentRunStartRequest } from "../shared/ipcContract";
import {
  agentWorkerAuditRequestSchema,
  agentWorkerAuditResponseSchema,
  agentToolNameSchema,
  agentWorkerRunCancelCommandSchema,
  agentWorkerRunStartCommandSchema,
  agentWorkerToolRequestEnvelopeSchema,
  agentWorkerToolRequestSchema,
  agentWorkerToolResponseSchema,
  proposeChangeSetResultSchema,
  inspectProjectFilesResultSchema,
  retrieveGraphEvidenceResultSchema,
  type AgentWorkerToolRequest,
  type AgentCollaborationContext,
  type AgentSessionHistory,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
  type InspectProjectFilesArgs,
  type InspectProjectFilesResult,
  type RetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceResult,
} from "../shared/agentWorkerProtocol";
import { getAgentRuntimeProfile } from "../shared/agentRuntimeProfiles";
import { toPublicError } from "../shared/publicErrors";
import {
  providerRuntimeProfileSchema,
  type ProviderRuntimeProfile,
} from "../shared/providerContract";
import type { AgentAuditStore } from "../domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
import { promptManifest } from "../agent-worker/prompts/manifest";

export interface AgentToolInvocationContext {
  runId: string;
  invocationId: string;
  requestId: string;
  mode: "free" | "assist";
  signal: AbortSignal;
}

export interface AgentToolGateway {
  retrieveGraphEvidence(
    args: RetrieveGraphEvidenceArgs,
    context: AgentToolInvocationContext,
  ): Promise<RetrieveGraphEvidenceResult>;
  inspectProjectFiles(
    args: InspectProjectFilesArgs,
    context: AgentToolInvocationContext,
  ): Promise<InspectProjectFilesResult>;
  proposeChangeSet(
    args: ProposeChangeSetArgs,
    context: AgentToolInvocationContext,
  ): Promise<ProposeChangeSetResult>;
}

export interface AgentWorkerProcess {
  readonly killed: boolean;
  on(event: "message", listener: (payload: unknown) => void): this;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  send(message: unknown): boolean;
  kill(): boolean;
}

interface PendingToolRequest {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  child: AgentWorkerProcess;
  emit(event: AgentRunEvent): void;
  gateway: AgentToolGateway | null;
  mode: "free" | "assist";
  pendingTools: Map<string, PendingToolRequest>;
  audit: AgentAuditStore;
  providerProfile: ProviderRuntimeProfile | null;
  providerConfigSha256: string | null;
  releaseLease(): void;
}

interface AgentProcessSupervisorOptions {
  acquireRuntimeLease?(): AgentRuntimeLease | null;
  getProviderProfile?(): ProviderRuntimeProfile | null;
  toolTimeoutMs?: number;
  cancelGraceMs?: number;
  spawnWorker?(workerPath: string): AgentWorkerProcess;
}

export interface AgentRuntimeLease {
  gateway: AgentToolGateway;
  audit: AgentAuditStore;
  authorizedScopeResourceIds?: string[];
  defaultScopeResourceIds?: string[];
  release(): void;
}

export class AgentProcessSupervisor {
  readonly #workerPath: string;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #acquireRuntimeLease: () => AgentRuntimeLease | null;
  readonly #getProviderProfile: () => ProviderRuntimeProfile | null;
  readonly #toolTimeoutMs: number;
  readonly #cancelGraceMs: number;
  readonly #spawnWorker: (workerPath: string) => AgentWorkerProcess;

  constructor(workerPath: string, options: AgentProcessSupervisorOptions = {}) {
    this.#workerPath = workerPath;
    this.#acquireRuntimeLease = options.acquireRuntimeLease ?? (() => null);
    this.#getProviderProfile = options.getProviderProfile ?? (() => null);
    this.#toolTimeoutMs = options.toolTimeoutMs ?? 15_000;
    this.#cancelGraceMs = options.cancelGraceMs ?? 1_000;
    this.#spawnWorker = options.spawnWorker ?? spawnWorkerProcess;
  }

  start(
    request: AgentRunStartRequest,
    emit: (event: AgentRunEvent) => void,
    sessionHistory: AgentSessionHistory = {
      entries: [],
      completeness: { incomplete: false, omittedMessages: 0 },
    },
    collaborationContext: AgentCollaborationContext = { sharedMemories: [], handoffs: [] },
  ): string {
    const runId = randomUUID();
    const providerProfile = this.#readProviderProfile();
    const lease = this.#acquireRuntimeLease();
    if (!lease) {
      queueMicrotask(() => emit({ type: "run.failed", runId, ...toPublicError({ code: "AGENT_TOOLS_REQUIRED" }), artifacts: [] }));
      return runId;
    }
    const scopeResourceIds = resolveRunScopes(request.scopeResourceIds, lease);
    if (!scopeResourceIds) {
      lease.release();
      queueMicrotask(() => emit({ type: "run.failed", runId, ...toPublicError({ code: "AGENT_RUN_FAILED" }), artifacts: [] }));
      return runId;
    }
    const providerConfigSha256 = providerProfile ? hashProviderConfig(providerProfile) : null;
    try {
      lease.audit.beginRun({
        runId,
        mode: request.mode,
        userInputSha256: canonicalAuditHash({ userInput: request.userInput, sessionHistory, collaborationContext }),
        providerId: providerProfile?.providerId ?? null,
        requestedModelId: providerProfile?.modelId ?? null,
        providerConfigSha256,
      });
    } catch {
      lease.release();
      queueMicrotask(() => emit({ type: "run.failed", runId, ...toPublicError({ code: "AGENT_AUDIT_REQUIRED" }), artifacts: [] }));
      return runId;
    }
    const child = this.#spawnWorker(this.#workerPath);
    const run: ActiveRun = {
      child,
      emit,
      gateway: lease.gateway,
      mode: request.mode,
      pendingTools: new Map(),
      audit: lease.audit,
      providerProfile,
      providerConfigSha256,
      releaseLease: lease.release,
    };
    this.#runs.set(runId, run);

    child.on("message", (payload: unknown) => this.#handleWorkerMessage(runId, payload));
    child.once("error", () => this.#interrupt(runId));
    child.once("exit", () => this.#interrupt(runId));
    child.once("spawn", () => {
      const { projectId: _projectId, sessionId: _sessionId, scopeResourceIds: _requestedScopes, ...workerRequest } = request;
      const command = agentWorkerRunStartCommandSchema.parse({
        type: "run.start",
        runId,
        ...workerRequest,
        scopeResourceIds,
        sessionHistory,
        collaborationContext,
        toolsAvailable: true,
        providerProfile,
      });
      if (!child.send(command)) this.#interrupt(runId);
    });

    return runId;
  }

  #readProviderProfile(): ProviderRuntimeProfile | null {
    try {
      const result = providerRuntimeProfileSchema.safeParse(this.#getProviderProfile());
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  cancel(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    try {
      run.audit.appendRunCancelRequested(runId);
      run.audit.terminalizeOpenRun(runId, "cancelled", "AGENT_RUN_CANCELLED");
    } catch {
      this.#failAudit(runId);
      return;
    }
    const error = toPublicError({ code: "AGENT_RUN_CANCELLED" });
    run.emit({ type: "run.failed", runId, ...error, artifacts: [] });
    this.#abortPendingTools(run);
    const cancelCommand = agentWorkerRunCancelCommandSchema.parse({ type: "run.cancel", runId });
    try {
      run.child.send(cancelCommand);
    } catch {
      // The grace timer below still guarantees process cleanup.
    }
    this.#runs.delete(runId);
    run.releaseLease();
    const timer = setTimeout(() => {
      if (!run.child.killed) run.child.kill();
    }, this.#cancelGraceMs);
    timer.unref?.();
  }

  #handleWorkerMessage(runId: string, payload: unknown): void {
    const run = this.#runs.get(runId);
    if (!run) return;

    const auditRequest = agentWorkerAuditRequestSchema.safeParse(payload);
    if (auditRequest.success) {
      if (auditRequest.data.runId !== runId) {
        this.#interrupt(runId);
        return;
      }
      this.#handleAuditRequest(runId, run, auditRequest.data);
      return;
    }

    const event = agentRunEventSchema.safeParse(payload);
    if (event.success) {
      if (event.data.runId !== runId) {
        this.#interrupt(runId);
        return;
      }
      if (event.data.type === "run.failed" || event.data.type === "run.completed") {
        try {
          if (event.data.type === "run.failed") {
            run.audit.terminalizeOpenRun(
              runId,
              event.data.code === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed",
              event.data.code,
            );
          } else {
            run.audit.appendRunTerminal({ runId, eventType: event.data.outcome, errorCode: null });
          }
        } catch {
          this.#failAudit(runId);
          return;
        }
      }
      run.emit(event.data);
      if (event.data.type === "run.failed" || event.data.type === "run.completed") this.#finish(runId);
      return;
    }

    const envelope = agentWorkerToolRequestEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      this.#interrupt(runId);
      return;
    }
    if (envelope.data.runId !== runId) {
      this.#interrupt(runId);
      return;
    }

    const request = agentWorkerToolRequestSchema.safeParse(payload);
    if (!request.success) {
      const knownTool = agentToolNameSchema.safeParse(envelope.data.tool);
      this.#sendToolFailure(
        run,
        runId,
        envelope.data.requestId,
        knownTool.success ? "AGENT_TOOL_PROTOCOL_FAILED" : "AGENT_TOOL_UNKNOWN",
      );
      return;
    }
    if (run.pendingTools.has(request.data.requestId)) {
      this.#sendToolFailure(run, runId, request.data.requestId, "AGENT_TOOL_PROTOCOL_FAILED");
      return;
    }
    if (!run.gateway) {
      this.#sendToolFailure(run, runId, request.data.requestId, "AGENT_TOOLS_REQUIRED");
      return;
    }

    this.#invokeTool(runId, run, request.data);
  }

  #invokeTool(runId: string, run: ActiveRun, request: AgentWorkerToolRequest): void {
    const presentation = toolPresentation(request);
    run.emit({
      type: "run.activity",
      runId,
      label: presentation.label,
      phase: "started",
      domains: presentation.domains,
    });
    try {
      run.audit.beginTool({
        toolInvocationId: request.requestId,
        runId,
        invocationId: stewardInvocationId(runId),
        toolName: request.tool,
        argumentsSha256: canonicalAuditHash(request.args),
      });
    } catch {
      this.#failAudit(runId);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const pending = run.pendingTools.get(request.requestId);
      if (!pending) return;
      run.pendingTools.delete(request.requestId);
      pending.controller.abort();
      try {
        run.audit.appendToolTerminal({
          runId,
          invocationId: stewardInvocationId(runId),
          toolInvocationId: request.requestId,
          eventType: "timed_out",
          errorCode: "AGENT_TOOL_TIMEOUT",
          resultSha256: null,
        });
      } catch {
        this.#failAudit(runId);
        return;
      }
      this.#sendToolFailure(run, runId, request.requestId, "AGENT_TOOL_TIMEOUT");
    }, this.#toolTimeoutMs);
    run.pendingTools.set(request.requestId, { controller, timer });
    const context: AgentToolInvocationContext = {
      runId,
      invocationId: stewardInvocationId(runId),
      requestId: request.requestId,
      mode: run.mode,
      signal: controller.signal,
    };
    const operation: Promise<RetrieveGraphEvidenceResult | InspectProjectFilesResult | ProposeChangeSetResult> = request.tool === "retrieve_graph_evidence"
      ? Promise.resolve().then(() => run.gateway!.retrieveGraphEvidence(request.args, context))
      : request.tool === "inspect_project_files"
        ? Promise.resolve().then(() => run.gateway!.inspectProjectFiles(request.args, context))
        : Promise.resolve().then(() => run.gateway!.proposeChangeSet(request.args, context));

    void operation.then((result) => {
      if (!this.#takePending(run, request.requestId)) return;
      if (request.tool === "retrieve_graph_evidence") {
        const parsed = retrieveGraphEvidenceResultSchema.safeParse(result);
        if (!parsed.success) {
          if (!this.#recordToolFailure(runId, run, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED")) return;
          this.#sendToolFailure(run, runId, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED");
          return;
        }
        try {
          run.audit.linkTargets({
            toolInvocationId: request.requestId,
            links: [
              ...parsed.data.assertions.map((assertion) => ({
                kind: "assertion_evidence" as const,
                targetId: assertion.versionId,
                targetSha256: null,
              })),
              ...parsed.data.documents.map((document) => ({
                kind: "document_evidence" as const,
                targetId: document.source.version.id,
                targetSha256: document.source.version.contentHash,
              })),
            ],
          });
          run.audit.appendToolTerminal({
            runId,
            invocationId: stewardInvocationId(runId),
            toolInvocationId: request.requestId,
            eventType: "succeeded",
            errorCode: null,
            resultSha256: canonicalAuditHash(parsed.data),
          });
        } catch {
          this.#failAudit(runId);
          return;
        }
        this.#sendToolSuccess(run, {
          type: "tool.response",
          runId,
          requestId: request.requestId,
          ok: true,
          tool: request.tool,
          result: parsed.data,
        });
        run.emit({
          type: "run.activity",
          runId,
          label: "检索项目事实",
          phase: "completed",
          domains: uniqueDomains(["graph", ...parsed.data.scopes.map((scope) => scope.type)]),
        });
        return;
      }
      if (request.tool === "inspect_project_files") {
        const parsed = inspectProjectFilesResultSchema.safeParse(result);
        if (!parsed.success) {
          if (!this.#recordToolFailure(runId, run, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED")) return;
          this.#sendToolFailure(run, runId, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED");
          return;
        }
        try {
          run.audit.appendToolTerminal({
            runId,
            invocationId: stewardInvocationId(runId),
            toolInvocationId: request.requestId,
            eventType: "succeeded",
            errorCode: null,
            resultSha256: canonicalAuditHash(parsed.data),
          });
        } catch {
          this.#failAudit(runId);
          return;
        }
        this.#sendToolSuccess(run, {
          type: "tool.response",
          runId,
          requestId: request.requestId,
          ok: true,
          tool: request.tool,
          result: parsed.data,
        });
        run.emit({
          type: "run.activity",
          runId,
          label: presentation.label,
          phase: "completed",
        });
        return;
      }
      const parsed = proposeChangeSetResultSchema.safeParse(result);
      if (!parsed.success) {
        if (!this.#recordToolFailure(runId, run, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED")) return;
        this.#sendToolFailure(run, runId, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED");
        return;
      }
      try {
        run.audit.linkChangeSetOutputs(parsed.data.changeSetId);
        run.audit.appendToolTerminal({
          runId,
          invocationId: stewardInvocationId(runId),
          toolInvocationId: request.requestId,
          eventType: "succeeded",
          errorCode: null,
          resultSha256: canonicalAuditHash(parsed.data),
          changeSetId: parsed.data.changeSetId,
        });
      } catch {
        this.#failAudit(runId);
        return;
      }
      this.#sendToolSuccess(run, {
        type: "tool.response",
        runId,
        requestId: request.requestId,
        ok: true,
        tool: request.tool,
        result: parsed.data,
      });
      run.emit({
        type: "run.activity",
        runId,
        label: "生成候选变更",
        phase: "completed",
        domains: proposalDomains(request.args),
      });
    }).catch((error: unknown) => {
      if (!this.#takePending(run, request.requestId)) return;
      const code = readToolFailureCode(error);
      try {
        run.audit.appendToolTerminal({
          runId,
          invocationId: stewardInvocationId(runId),
          toolInvocationId: request.requestId,
          eventType: code === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed",
          errorCode: code,
          resultSha256: null,
        });
      } catch {
        this.#failAudit(runId);
        return;
      }
      this.#sendToolFailure(run, runId, request.requestId, code);
      run.emit({
        type: "run.activity",
        runId,
        label: presentation.label,
        phase: "failed",
        domains: presentation.domains,
      });
    });
  }

  #takePending(run: ActiveRun, requestId: string): boolean {
    const pending = run.pendingTools.get(requestId);
    if (!pending) return false;
    run.pendingTools.delete(requestId);
    clearTimeout(pending.timer);
    return true;
  }

  #recordToolFailure(
    runId: string,
    run: ActiveRun,
    requestId: string,
    code: "AGENT_TOOL_PROTOCOL_FAILED" | "AGENT_TOOL_FAILED",
  ): boolean {
    try {
      run.audit.appendToolTerminal({
        runId,
        invocationId: stewardInvocationId(runId),
        toolInvocationId: requestId,
        eventType: "failed",
        errorCode: code,
        resultSha256: null,
      });
      return true;
    } catch {
      this.#failAudit(runId);
      return false;
    }
  }

  #sendToolSuccess(run: ActiveRun, response: unknown): void {
    const parsed = agentWorkerToolResponseSchema.safeParse(response);
    if (!parsed.success || !parsed.data.ok) {
      this.#interruptByRun(run);
      return;
    }
    try {
      if (!run.child.send(parsed.data)) this.#interruptByRun(run);
    } catch {
      this.#interruptByRun(run);
    }
  }

  #sendToolFailure(
    run: ActiveRun,
    runId: string,
    requestId: string,
    code: "AGENT_TOOLS_REQUIRED" | "AGENT_TOOL_UNKNOWN" | "AGENT_TOOL_PROTOCOL_FAILED" | "AGENT_TOOL_TIMEOUT" | "AGENT_TOOL_FAILED" | "AGENT_RUN_CANCELLED",
  ): void {
    const response = agentWorkerToolResponseSchema.parse({
      type: "tool.response",
      runId,
      requestId,
      ok: false,
      error: { code, message: TOOL_ERROR_MESSAGES[code] },
    });
    try {
      if (!run.child.send(response)) this.#interrupt(runId);
    } catch {
      this.#interrupt(runId);
    }
  }

  #finish(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#runs.delete(runId);
    this.#abortPendingTools(run);
    if (!run.child.killed) run.child.kill();
    run.releaseLease();
  }

  #interrupt(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    try {
      run.audit.terminalizeOpenRun(runId, "interrupted", "AGENT_WORKER_INTERRUPTED");
    } catch {
      this.#failAudit(runId);
      return;
    }
    const error = toPublicError({ code: "AGENT_WORKER_INTERRUPTED" });
    run.emit({ type: "run.failed", runId, ...error, artifacts: [] });
    this.#finish(runId);
  }

  #interruptByRun(run: ActiveRun): void {
    for (const [runId, active] of this.#runs) {
      if (active === run) {
        this.#interrupt(runId);
        return;
      }
    }
  }

  #abortPendingTools(run: ActiveRun): void {
    for (const pending of run.pendingTools.values()) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
    run.pendingTools.clear();
  }

  dispose(): void {
    for (const runId of [...this.#runs.keys()]) this.#interrupt(runId);
  }

  #handleAuditRequest(
    runId: string,
    run: ActiveRun,
    request: ReturnType<typeof agentWorkerAuditRequestSchema.parse>,
  ): void {
    try {
      const operation = request.operation;
      if (operation.type === "invocation.started") {
        if (operation.role === "gm") throw new Error("GM invocation requires the Player supervisor.");
        validateInvocationIdentity(runId, run, operation);
        run.audit.beginInvocation({
          invocationId: operation.invocationId,
          runId,
          parentInvocationId: operation.parentInvocationId,
          role: operation.role,
          promptId: operation.prompt.id,
          promptVersion: operation.prompt.version,
          promptSha256: operation.prompt.sha256,
          agentProfileId: operation.profile.id,
          agentProfileVersion: operation.profile.version,
          agentProfileSha256: operation.profile.sha256,
          providerId: operation.provider.providerId,
          requestedModelId: operation.provider.requestedModelId,
          providerConfigSha256: operation.provider.providerConfigSha256,
          toolPolicyId: operation.profile.toolPolicyId,
          toolPolicyVersion: operation.profile.toolPolicyVersion,
          toolPolicySha256: operation.profile.toolPolicySha256,
          authorizedTools: operation.profile.authorizedTools,
          handoffContractId: operation.handoff?.contractId ?? null,
          handoffVersion: operation.handoff?.version ?? null,
          handoffPayloadSha256: operation.handoff?.payloadSha256 ?? null,
          inputSha256: operation.inputSha256,
        });
      } else if (operation.type === "invocation.terminal") {
        run.audit.appendInvocationTerminal({
          runId,
          invocationId: operation.invocationId,
          eventType: operation.eventType,
          errorCode: operation.errorCode,
          actualProviderId: operation.receipt.actualProviderId,
          actualModelId: operation.receipt.actualModelId,
          responseIdSha256: operation.receipt.responseIdSha256,
          stopReason: operation.receipt.stopReason,
          inputTokens: operation.receipt.inputTokens,
          outputTokens: operation.receipt.outputTokens,
          totalTokens: operation.receipt.totalTokens,
          contextPolicyVersion: operation.receipt.contextPolicyVersion,
          maxChargedInputBytes: operation.receipt.maxChargedInputBytes,
          configuredContextWindow: operation.receipt.configuredContextWindow,
          safetyReserve: operation.receipt.safetyReserve,
          outputReserve: operation.receipt.outputReserve,
          estimatedInputTokens: operation.receipt.estimatedInputTokens,
          availableInputBudget: operation.receipt.availableInputBudget,
          systemPromptTokens: operation.receipt.systemPromptTokens,
          toolProtocolTokens: operation.receipt.toolProtocolTokens,
          sessionHistoryTokens: operation.receipt.sessionHistoryTokens,
          retrievalTokens: operation.receipt.retrievalTokens,
          collaborationTokens: operation.receipt.collaborationTokens,
          runtimeConversationTokens: operation.receipt.runtimeConversationTokens,
          correctionAttempts: operation.receipt.correctionAttempts,
          structuredSubmissionCount: operation.structuredSubmissionCount,
          outputSha256: operation.outputSha256,
        });
      } else if (operation.type === "local_tool.started") {
        run.audit.beginTool({
          toolInvocationId: operation.toolInvocationId,
          runId,
          invocationId: operation.invocationId,
          toolName: operation.toolName,
          argumentsSha256: operation.argumentsSha256,
        });
      } else {
        run.audit.appendToolTerminal({
          runId,
          invocationId: operation.invocationId,
          toolInvocationId: operation.toolInvocationId,
          eventType: operation.eventType,
          errorCode: operation.errorCode,
          resultSha256: operation.resultSha256,
        });
      }
      this.#sendAuditResponse(runId, run, request.auditRequestId, true);
    } catch {
      this.#sendAuditResponse(runId, run, request.auditRequestId, false);
    }
  }

  #sendAuditResponse(runId: string, run: ActiveRun, auditRequestId: string, ok: boolean): void {
    const response = agentWorkerAuditResponseSchema.parse(ok
      ? { type: "audit.response", runId, auditRequestId, ok: true }
      : {
          type: "audit.response",
          runId,
          auditRequestId,
          ok: false,
          error: { code: "AGENT_AUDIT_REQUIRED", message: "Agent audit persistence failed." },
        });
    try {
      if (!run.child.send(response)) this.#interruptByRun(run);
    } catch {
      this.#interruptByRun(run);
    }
  }

  #failAudit(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.emit({ type: "run.failed", runId, ...toPublicError({ code: "AGENT_AUDIT_REQUIRED" }), artifacts: [] });
    this.#finish(runId);
  }
}

function resolveRunScopes(requested: string[] | undefined, lease: AgentRuntimeLease): string[] | null {
  const authorized = lease.authorizedScopeResourceIds;
  if (!authorized && !lease.defaultScopeResourceIds) return [...new Set(requested ?? [])];
  const defaults = lease.defaultScopeResourceIds ?? [];
  const selected = requested && requested.length > 0 ? [...new Set(requested)] : defaults;
  if (selected.length === 0 || selected.length > 100) return null;
  if (!authorized) return selected;
  const allowed = new Set(authorized);
  return selected.every((scopeId) => allowed.has(scopeId)) ? selected : null;
}

type ActivityDomain = "world" | "oc" | "story" | "graph" | "timeline" | "asset";

function toolPresentation(request: AgentWorkerToolRequest): { label: string; domains?: ActivityDomain[] } {
  if (request.tool === "retrieve_graph_evidence") return { label: "检索项目事实", domains: ["graph"] };
  if (request.tool === "inspect_project_files") return { label: "检查项目文件" };
  return { label: "生成候选变更", domains: proposalDomains(request.args) };
}

function proposalDomains(args: ProposeChangeSetArgs): ActivityDomain[] {
  const domains: ActivityDomain[] = [];
  for (const item of args.items) {
    switch (item.kind) {
      case "resource.put": domains.push(item.payload.type); break;
      case "document.put": domains.push("story"); break;
      case "creative_document.put": domains.push(documentKindDomain(item.payload.kind)); break;
      case "creative_relation.put": domains.push("graph"); break;
      case "constraint_profile.put": domains.push("story"); break;
      case "assertion.put": domains.push(asActivityDomain(item.payload.scopeType) ?? "graph"); break;
    }
  }
  return uniqueDomains(domains);
}

function documentKindDomain(kind: ProposeChangeSetArgs["items"][number] extends infer _Item ? string : never): ActivityDomain {
  if (kind === "character_profile") return "oc";
  if (kind === "location_profile" || kind === "faction_profile" || kind === "setting") return "world";
  return "story";
}

function asActivityDomain(value: string): ActivityDomain | null {
  return ["world", "oc", "story", "graph", "timeline", "asset"].includes(value)
    ? value as ActivityDomain
    : null;
}

function uniqueDomains(domains: ActivityDomain[]): ActivityDomain[] {
  return [...new Set(domains)];
}

function spawnWorkerProcess(workerPath: string): AgentWorkerProcess {
  return fork(workerPath, [], {
    env: createAgentWorkerEnvironment(process.env),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  }) as ChildProcess as AgentWorkerProcess;
}

export function createAgentWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("NOVAX_PROVIDER_")) delete environment[key];
  }
  return environment;
}

function readToolFailureCode(error: unknown): "AGENT_TOOLS_REQUIRED" | "AGENT_TOOL_FAILED" | "AGENT_RUN_CANCELLED" {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "AGENT_TOOLS_REQUIRED") return "AGENT_TOOLS_REQUIRED";
    if (error.code === "AGENT_RUN_CANCELLED") return "AGENT_RUN_CANCELLED";
  }
  return "AGENT_TOOL_FAILED";
}

function stewardInvocationId(runId: string): string {
  return `${runId}:steward`;
}

function hashProviderConfig(profile: ProviderRuntimeProfile): string {
  const { apiKey: _apiKey, ...safeConfig } = profile;
  return canonicalAuditHash(safeConfig);
}

function validateInvocationIdentity(
  runId: string,
  run: ActiveRun,
  operation: Extract<ReturnType<typeof agentWorkerAuditRequestSchema.parse>["operation"], { type: "invocation.started" }>,
): void {
  const expectedProfile = getAgentRuntimeProfile(operation.role);
  if (canonicalAuditHash(operation.profile) !== canonicalAuditHash(expectedProfile)) {
    throw new Error("Agent runtime profile mismatch.");
  }
  if (
    !run.providerProfile
    || operation.provider.providerId !== run.providerProfile.providerId
    || operation.provider.requestedModelId !== run.providerProfile.modelId
    || operation.provider.providerConfigSha256 !== run.providerConfigSha256
  ) {
    throw new Error("Provider audit identity mismatch.");
  }
  const prompt = promptManifest.find((candidate) =>
    candidate.role === operation.role
    && candidate.id === operation.prompt.id
    && candidate.version === operation.prompt.version
    && candidate.publishedSha256 === operation.prompt.sha256
    && candidate.status === "active");
  if (!prompt) throw new Error("Prompt audit identity is not active.");
  if (operation.role === "steward") {
    if (operation.invocationId !== stewardInvocationId(runId)
      || operation.parentInvocationId !== null
      || operation.handoff !== null) {
      throw new Error("Steward invocation audit identity is invalid.");
    }
  } else if (
    operation.parentInvocationId !== stewardInvocationId(runId)
    || operation.handoff?.contractId !== `novax.${operation.role}-handoff`
  ) {
    throw new Error("Specialist invocation audit identity is invalid.");
  }
}

const TOOL_ERROR_MESSAGES = {
  AGENT_TOOLS_REQUIRED: "Agent domain tools are unavailable.",
  AGENT_TOOL_UNKNOWN: "Unknown Agent tool.",
  AGENT_TOOL_PROTOCOL_FAILED: "Agent tool request or response is invalid.",
  AGENT_TOOL_TIMEOUT: "Agent tool request timed out.",
  AGENT_TOOL_FAILED: "Agent tool request failed.",
  AGENT_RUN_CANCELLED: "Agent run was cancelled.",
} as const;
