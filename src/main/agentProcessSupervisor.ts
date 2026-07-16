import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  isExplicitGreenfieldFreeCreateRequest,
  proposeChangeSetResultSchema,
  globProjectFilesResultSchema,
  inspectProjectFilesResultSchema,
  listProjectDirectoryResultSchema,
  readProjectFileResultSchema,
  retrieveGraphEvidenceResultSchema,
  growthRetrieveGraphEvidenceResultSchema,
  submitGrowthInquiryResultSchema,
  searchProjectFilesResultSchema,
  statProjectFileResultSchema,
  saveTaskNoteResultSchema,
  listTaskNotesResultSchema,
  generateImageArgsSchema,
  generateImageResultSchema,
  agentToolInternalErrorCodeSchema,
  type AgentWorkerToolRequest,
  type AgentToolName,
  type AgentCollaborationContext,
  type AgentSessionHistory,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
  type InspectProjectFilesArgs,
  type InspectProjectFilesResult,
  type GlobProjectFilesArgs,
  type GlobProjectFilesResult,
  type ListProjectDirectoryArgs,
  type ListProjectDirectoryResult,
  type ReadProjectFileArgs,
  type ReadProjectFileResult,
  type SearchProjectFilesArgs,
  type SearchProjectFilesResult,
  type StatProjectFileArgs,
  type StatProjectFileResult,
  type SaveTaskNoteArgs,
  type SaveTaskNoteResult,
  type ListTaskNotesArgs,
  type ListTaskNotesResult,
  type RetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceResult,
  type AgentRetrieveGraphEvidenceArgs,
  type GrowthRetrieveGraphEvidenceResult,
  type SubmitGrowthInquiryArgs,
  type SubmitGrowthInquiryResult,
  type GrowthRunBinding,
  type GenerateImageArgs,
  type GenerateImageResult,
} from "../shared/agentWorkerProtocol";
import { getAgentRuntimeProfile } from "../shared/agentRuntimeProfiles";
import { toPublicError } from "../shared/publicErrors";
import {
  providerRuntimeProfileSchema,
  type ProviderRuntimeProfile,
} from "../shared/providerContract";
import type { AgentAuditStore } from "../domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
import type { ImageGenerationProgress } from "../domain/asset/imageGenerationService";
import { promptManifest } from "../agent-worker/prompts/manifest";

export interface AgentToolInvocationContext {
  runId: string;
  invocationId: string;
  requestId: string;
  mode: "free" | "assist";
  greenfieldCreateRequested?: boolean;
  onImageProgress?: (progress: ImageGenerationProgress) => void;
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
  listProjectDirectory(args: ListProjectDirectoryArgs, context: AgentToolInvocationContext): Promise<ListProjectDirectoryResult>;
  statProjectFile(args: StatProjectFileArgs, context: AgentToolInvocationContext): Promise<StatProjectFileResult>;
  globProjectFiles(args: GlobProjectFilesArgs, context: AgentToolInvocationContext): Promise<GlobProjectFilesResult>;
  searchProjectFiles(args: SearchProjectFilesArgs, context: AgentToolInvocationContext): Promise<SearchProjectFilesResult>;
  readProjectFile(args: ReadProjectFileArgs, context: AgentToolInvocationContext): Promise<ReadProjectFileResult>;
  saveTaskNote(args: SaveTaskNoteArgs, context: AgentToolInvocationContext): Promise<SaveTaskNoteResult>;
  listTaskNotes(args: ListTaskNotesArgs, context: AgentToolInvocationContext): Promise<ListTaskNotesResult>;
  generateImage(args: GenerateImageArgs, context: AgentToolInvocationContext): Promise<GenerateImageResult>;
  proposeChangeSet(
    args: ProposeChangeSetArgs,
    context: AgentToolInvocationContext,
  ): Promise<ProposeChangeSetResult>;
}

export interface GrowthAgentToolGateway extends Omit<AgentToolGateway, "retrieveGraphEvidence"> {
  retrieveGraphEvidence(
    args: AgentRetrieveGraphEvidenceArgs,
    context: AgentToolInvocationContext,
  ): Promise<RetrieveGraphEvidenceResult | GrowthRetrieveGraphEvidenceResult>;
  submitGrowthInquiry(
    args: SubmitGrowthInquiryArgs,
    context: AgentToolInvocationContext,
  ): Promise<SubmitGrowthInquiryResult>;
}

/** Internal Main-only binding hook. It is never populated from Renderer or model tool arguments. */
export interface AgentRunInternalBinding {
  readonly workerBinding: GrowthRunBinding;
  attach(input: {
    runId: string;
    gateway: AgentToolGateway;
    mode: "free" | "assist";
    scopeResourceIds: string[];
  }): GrowthAgentToolGateway;
  terminalize(input: {
    kind: "completed" | "failed" | "cancelled" | "interrupted";
    errorCode: string | null;
  }): void;
}

export interface AgentWorkerProcess {
  readonly killed: boolean;
  on(event: "message", listener: (payload: unknown) => void): this;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(): boolean;
}

interface PendingToolRequest {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  child: AgentWorkerProcess;
  emit(event: AgentRunEvent): void;
  gateway: GrowthAgentToolGateway | null;
  mode: "free" | "assist";
  greenfieldCreateRequested: boolean;
  pendingTools: Map<string, PendingToolRequest>;
  audit: AgentAuditStore;
  providerProfile: ProviderRuntimeProfile | null;
  providerConfigSha256: string | null;
  internalBinding: AgentRunInternalBinding | null;
  releaseLease(): void;
}

interface AgentProcessSupervisorOptions {
  acquireRuntimeLease?(): AgentRuntimeLease | null;
  getProviderProfile?(): ProviderRuntimeProfile | null;
  toolTimeoutMs?: number;
  imageToolTimeoutMs?: number;
  cancelGraceMs?: number;
  spawnWorker?(workerPath: string): AgentWorkerProcess;
  reportWorkerDiagnostic?(diagnostic: AgentWorkerDiagnostic): void;
}

export interface AgentWorkerDiagnostic {
  runId: string;
  event: "process_error" | "process_exit" | "send_failed";
  phase: "runtime" | "startup" | "tool_response" | "audit_response";
  errorName?: string;
  errorMessage?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
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
  readonly #imageToolTimeoutMs: number;
  readonly #cancelGraceMs: number;
  readonly #spawnWorker: (workerPath: string) => AgentWorkerProcess;
  readonly #reportWorkerDiagnostic: (diagnostic: AgentWorkerDiagnostic) => void;

  constructor(workerPath: string, options: AgentProcessSupervisorOptions = {}) {
    this.#workerPath = workerPath;
    this.#acquireRuntimeLease = options.acquireRuntimeLease ?? (() => null);
    this.#getProviderProfile = options.getProviderProfile ?? (() => null);
    this.#toolTimeoutMs = options.toolTimeoutMs ?? 15_000;
    this.#imageToolTimeoutMs = options.imageToolTimeoutMs ?? 300_000;
    this.#cancelGraceMs = options.cancelGraceMs ?? 1_000;
    this.#spawnWorker = options.spawnWorker ?? spawnWorkerProcess;
    this.#reportWorkerDiagnostic = options.reportWorkerDiagnostic ?? (() => undefined);
  }

  start(
    request: AgentRunStartRequest,
    emit: (event: AgentRunEvent) => void,
    sessionHistory: AgentSessionHistory = {
      entries: [],
      completeness: { incomplete: false, omittedMessages: 0 },
    },
    collaborationContext: AgentCollaborationContext = { sharedMemories: [], handoffs: [] },
    internalBinding: AgentRunInternalBinding | null = null,
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
    const greenfieldCreateRequested = isExplicitGreenfieldFreeCreateRequest(request.mode, request.userInput)
      || internalBinding?.workerBinding.greenfieldCreateAuthorized === true;
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
    let gateway = lease.gateway as GrowthAgentToolGateway;
    if (internalBinding) {
      try {
        gateway = internalBinding.attach({ runId, gateway: gateway as AgentToolGateway, mode: request.mode, scopeResourceIds });
      } catch {
        try { lease.audit.terminalizeOpenRun(runId, "failed", "GROWTH_BINDING_INVALID"); } catch { /* Preserve fail-closed startup. */ }
        lease.release();
        queueMicrotask(() => emit({ type: "run.failed", runId, ...toPublicError({ code: "AGENT_RUN_FAILED" }), artifacts: [] }));
        return runId;
      }
    }
    const child = this.#spawnWorker(this.#workerPath);
    const run: ActiveRun = {
      child,
      emit,
      gateway,
      mode: request.mode,
      greenfieldCreateRequested,
      pendingTools: new Map(),
      audit: lease.audit,
      providerProfile,
      providerConfigSha256,
      internalBinding,
      releaseLease: lease.release,
    };
    this.#runs.set(runId, run);

    child.on("message", (payload: unknown) => this.#handleWorkerMessage(runId, payload));
    child.once("error", (error) => this.#interrupt(runId, {
      runId,
      event: "process_error",
      phase: "runtime",
      errorName: error.name,
      errorMessage: error.message,
    }));
    child.once("exit", (exitCode, signal) => this.#interrupt(runId, {
      runId,
      event: "process_exit",
      phase: "runtime",
      exitCode,
      signal,
    }));
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
        growthBinding: internalBinding?.workerBinding,
      });
      this.#sendWorkerMessage(runId, run, command, "startup");
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
    if (!this.#terminalizeInternalBinding(run, "cancelled", "AGENT_RUN_CANCELLED")) {
      this.#failAudit(runId);
      return;
    }
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
        const kind = event.data.type === "run.completed"
          ? "completed"
          : event.data.code === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed";
        if (!this.#terminalizeInternalBinding(run, kind, event.data.type === "run.failed" ? event.data.code : null)) {
          this.#failAudit(runId);
          return;
        }
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
    }, request.tool === "generate_image" ? this.#imageToolTimeoutMs : this.#toolTimeoutMs);
    run.pendingTools.set(request.requestId, { controller, timer });
    const context: AgentToolInvocationContext = {
      runId,
      invocationId: stewardInvocationId(runId),
      requestId: request.requestId,
      mode: run.mode,
      greenfieldCreateRequested: run.greenfieldCreateRequested,
      onImageProgress: request.tool === "generate_image"
        ? (progress) => {
            try {
              const activity = imageProgressActivity(request.args, progress);
              run.emit({ type: "run.activity", runId, label: activity.label, phase: activity.phase, domains: ["asset"] });
            } catch { /* Safe progress delivery cannot alter the image outcome. */ }
          }
        : undefined,
      signal: controller.signal,
    };
    const operation: Promise<unknown> = (async () => {
      switch (request.tool) {
        case "retrieve_graph_evidence": return await run.gateway!.retrieveGraphEvidence(request.args, context);
        case "submit_growth_inquiry": {
          if (!run.internalBinding) throw Object.assign(new Error("Growth Inquiry requires an internal binding."), { code: "GROWTH_BINDING_INVALID" });
          return await run.gateway!.submitGrowthInquiry(request.args, context);
        }
        case "inspect_project_files": return await run.gateway!.inspectProjectFiles(request.args, context);
        case "list_project_directory": return await run.gateway!.listProjectDirectory(request.args, context);
        case "stat_project_file": return await run.gateway!.statProjectFile(request.args, context);
        case "glob_project_files": return await run.gateway!.globProjectFiles(request.args, context);
        case "search_project_files": return await run.gateway!.searchProjectFiles(request.args, context);
        case "read_project_file": return await run.gateway!.readProjectFile(request.args, context);
        case "save_task_note": return await run.gateway!.saveTaskNote(request.args, context);
        case "list_task_notes": return await run.gateway!.listTaskNotes(request.args, context);
        case "generate_image": return await run.gateway!.generateImage(request.args, context);
        case "propose_change_set": return await run.gateway!.proposeChangeSet(request.args, context);
      }
    })();

    void operation.then((result) => {
      if (!this.#takePending(run, request.requestId)) return;
      if (request.tool === "retrieve_graph_evidence") {
        const parsed = z.union([retrieveGraphEvidenceResultSchema, growthRetrieveGraphEvidenceResultSchema]).safeParse(result);
        if (!parsed.success) {
          if (!this.#recordToolFailure(runId, run, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED")) return;
          this.#sendToolFailure(run, runId, request.requestId, "AGENT_TOOL_PROTOCOL_FAILED");
          return;
        }
        try {
          if (!("variant" in parsed.data && parsed.data.variant === "growth_v1")) {
            const legacyResult = parsed.data as z.infer<typeof retrieveGraphEvidenceResultSchema>;
            run.audit.linkTargets({
              toolInvocationId: request.requestId,
              links: [
                ...legacyResult.assertions.map((assertion) => ({
                  kind: "assertion_evidence" as const,
                  targetId: assertion.versionId,
                  targetSha256: null,
                })),
                ...legacyResult.documents.map((document) => ({
                  kind: "document_evidence" as const,
                  targetId: document.source.version.id,
                  targetSha256: document.source.version.contentHash,
                })),
              ],
            });
          }
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
          domains: "variant" in parsed.data && parsed.data.variant === "growth_v1"
            ? ["graph"]
            : uniqueDomains(["graph", ...(parsed.data as z.infer<typeof retrieveGraphEvidenceResultSchema>).scopes.map((scope) => scope.type)]),
        });
        return;
      }
      if (request.tool === "submit_growth_inquiry") {
        const parsed = submitGrowthInquiryResultSchema.safeParse(result);
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
          label: parsed.data.status === "creator_choice_required" ? "需要你的取舍" : "正在推演",
          phase: "completed",
          domains: ["graph"],
        });
        return;
      }
      if (request.tool === "inspect_project_files" || isProjectFileTool(request.tool)) {
        const parsed = projectFileResultSchema(request.tool).safeParse(result);
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
      if (request.tool === "generate_image") {
        const parsed = generateImageResultSchema.safeParse(result);
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
          domains: ["asset"],
        });
        return;
      }
      if (request.tool !== "propose_change_set") return;
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
      this.#sendWorkerMessageByRun(run, parsed.data, "tool_response");
    } catch {
      this.#interruptByRun(run);
    }
  }

  #sendToolFailure(
    run: ActiveRun,
    runId: string,
    requestId: string,
    code: ReturnType<typeof agentToolInternalErrorCodeSchema.parse>,
  ): void {
    const response = agentWorkerToolResponseSchema.parse({
      type: "tool.response",
      runId,
      requestId,
      ok: false,
      error: { code, message: TOOL_ERROR_MESSAGES[code] },
    });
    try {
      this.#sendWorkerMessage(runId, run, response, "tool_response");
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

  #interrupt(runId: string, diagnostic?: AgentWorkerDiagnostic): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    if (diagnostic) {
      try {
        this.#reportWorkerDiagnostic(diagnostic);
      } catch {
        // Diagnostics cannot replace the fail-closed runtime path.
      }
    }
    if (!this.#terminalizeInternalBinding(run, "interrupted", "AGENT_WORKER_INTERRUPTED")) {
      this.#failAudit(runId);
      return;
    }
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

  #sendWorkerMessage(
    runId: string,
    run: ActiveRun,
    message: unknown,
    phase: AgentWorkerDiagnostic["phase"],
  ): void {
    try {
      run.child.send(message, (error) => {
        if (!error) return;
        this.#interrupt(runId, {
          runId,
          event: "send_failed",
          phase,
          errorName: error.name,
          errorMessage: error.message,
        });
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Agent Worker send failed.");
      this.#interrupt(runId, {
        runId,
        event: "send_failed",
        phase,
        errorName: normalized.name,
        errorMessage: normalized.message,
      });
    }
  }

  #sendWorkerMessageByRun(
    run: ActiveRun,
    message: unknown,
    phase: AgentWorkerDiagnostic["phase"],
  ): void {
    for (const [runId, active] of this.#runs) {
      if (active === run) {
        this.#sendWorkerMessage(runId, run, message, phase);
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
      this.#sendWorkerMessageByRun(run, response, "audit_response");
    } catch {
      this.#interruptByRun(run);
    }
  }

  #failAudit(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#terminalizeInternalBinding(run, "interrupted", "AGENT_AUDIT_REQUIRED");
    run.emit({ type: "run.failed", runId, ...toPublicError({ code: "AGENT_AUDIT_REQUIRED" }), artifacts: [] });
    this.#finish(runId);
  }

  #terminalizeInternalBinding(
    run: ActiveRun,
    kind: "completed" | "failed" | "cancelled" | "interrupted",
    errorCode: string | null,
  ): boolean {
    if (!run.internalBinding) return true;
    try {
      run.internalBinding.terminalize({ kind, errorCode });
      return true;
    } catch {
      return false;
    }
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
  if (isProjectFileTool(request.tool)) return { label: "检查项目文件" };
  if (request.tool === "retrieve_graph_evidence") return { label: "检索项目事实", domains: ["graph"] };
  if (request.tool === "submit_growth_inquiry") return { label: "证据化自询", domains: ["graph"] };
  if (request.tool === "inspect_project_files") return { label: "检查项目文件" };
  if (request.tool === "generate_image") {
    const image = generateImageArgsSchema.safeParse(request.args);
    return { label: image.success && image.data.purpose === "world_map" ? "生成世界地图" : "生成角色或场景图片", domains: ["asset"] };
  }
  return { label: "生成候选变更", domains: proposalDomains(request.args as ProposeChangeSetArgs) };
}

function imageProgressActivity(
  args: unknown,
  progress: ImageGenerationProgress,
): { label: string; phase: "started" | "completed" | "failed" } {
  const worldMap = generateImageArgsSchema.safeParse(args).success
    && generateImageArgsSchema.parse(args).purpose === "world_map";
  if (!worldMap) {
    return progress === "ready"
      ? { label: "图片已生成", phase: "completed" }
      : progress === "failed" || progress === "reconciliation_required"
      ? { label: "图片生成失败", phase: "failed" }
      : { label: "生成角色或场景图片", phase: "started" };
  }
  if (progress === "queued") return { label: "世界地图排队中", phase: "started" };
  if (progress === "generating") return { label: "生成世界地图", phase: "started" };
  if (progress === "ready") return { label: "世界地图已生成", phase: "completed" };
  return progress === "reconciliation_required"
    ? { label: "世界地图需要核对", phase: "failed" }
    : { label: "世界地图生成失败", phase: "failed" };
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

function readToolFailureCode(error: unknown): ReturnType<typeof agentToolInternalErrorCodeSchema.parse> {
  if (error && typeof error === "object" && "code" in error) {
    const parsed = agentToolInternalErrorCodeSchema.safeParse(error.code);
    if (parsed.success) return parsed.data;
  }
  return "AGENT_TOOL_FAILED";
}

function isProjectFileTool(tool: AgentToolName): tool is "list_project_directory" | "stat_project_file" | "glob_project_files" | "search_project_files" | "read_project_file" | "save_task_note" | "list_task_notes" {
  return ["list_project_directory", "stat_project_file", "glob_project_files", "search_project_files", "read_project_file", "save_task_note", "list_task_notes"].includes(tool);
}

function projectFileResultSchema(tool: AgentToolName) {
  switch (tool) {
    case "inspect_project_files": return inspectProjectFilesResultSchema;
    case "list_project_directory": return listProjectDirectoryResultSchema;
    case "stat_project_file": return statProjectFileResultSchema;
    case "glob_project_files": return globProjectFilesResultSchema;
    case "search_project_files": return searchProjectFilesResultSchema;
    case "read_project_file": return readProjectFileResultSchema;
    case "save_task_note": return saveTaskNoteResultSchema;
    case "list_task_notes": return listTaskNotesResultSchema;
    default: throw new Error("Not a project file tool.");
  }
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
  PROJECT_FILE_PATH_OUTSIDE_ROOT: "Project file path is outside the project root.",
  PROJECT_FILE_PATH_RESTRICTED: "Project file path is restricted.",
  PROJECT_FILE_NOT_FOUND: "Project file or directory was not found.",
  PROJECT_FILE_NOT_A_FILE: "Project file path is not a file.",
  PROJECT_FILE_GLOB_INVALID: "Project file glob pattern is invalid.",
  PROJECT_FILE_QUERY_INVALID: "Project file search query is invalid.",
  PROJECT_FILE_RANGE_INVALID: "Project file read range is invalid.",
  PROJECT_FILE_OPERATION_FAILED: "Project file operation failed.",
  IMAGE_PROVIDER_REQUIRED: "A configured image Provider is required.",
  WORLD_MAP_SOURCE_RESOURCE_INVALID: "World map sources must be active resources on the current branch.",
  WORLD_MAP_SOURCE_WORLD_REQUIRED: "A world map requires a current formal world resource.",
  WORLD_MAP_SOURCE_VERSION_INVALID: "World map sources must be current stable versions bound to the supplied resources.",
  IMAGE_GENERATION_RECONCILIATION_REQUIRED: "The image request outcome requires manual reconciliation.",
  IMAGE_GENERATION_FAILED: "Image generation failed without a committed asset.",
  GROWTH_BINDING_INVALID: "The Growth Cycle binding is invalid.",
  GROWTH_RETRIEVAL_INPUT_INVALID: "Growth retrieval input or budgets are invalid.",
  GROWTH_PERSISTENCE_FAILED: "Growth retrieval evidence could not be persisted.",
  GROWTH_RETRIEVAL_REQUIRED: "A recorded Growth retrieval is required before proposing changes.",
  GROWTH_INQUIRY_REQUIRED: "A durable Growth Inquiry is required before downstream work.",
  GROWTH_INQUIRY_INVALID: "The Growth Inquiry is invalid.",
  GROWTH_INQUIRY_STALLED: "The Growth Inquiry made no evidence-backed progress.",
  GROWTH_CLOSURE_NOT_READY: "The pinned Growth Closure evidence is not ready for independent review.",
  GROWTH_CLOSURE_SUBMISSION_INVALID: "The Growth Closure submission is invalid.",
  GROWTH_RECONCILIATION_REQUIRED: "The Growth Change Set outcome requires reconciliation.",
  GROWTH_RUN_FAILED: "The Growth Cycle run failed before a committed Change Set.",
  GREENFIELD_CREATE_EXPLICIT_FREE_REQUIRED: "Greenfield creation requires trusted Free authorization.",
  GREENFIELD_WORKSPACE_NOT_EMPTY: "Greenfield creation requires an empty initialized workspace.",
  GREENFIELD_CREATE_ONLY_REQUIRED: "Greenfield creation accepts create-only Change Sets.",
  GREENFIELD_RESOURCE_CREATE_REQUIRED: "Create active formal resources only.",
  GREENFIELD_DOMAIN_ROOT_FORBIDDEN: "Do not create or mutate a domain root.",
  GREENFIELD_CREATIVE_CREATE_REQUIRED: "Create active creative records only.",
  GREENFIELD_PROJECT_FILE_MUTATION_FORBIDDEN: "Do not mutate project files in this Greenfield Change Set.",
  GREENFIELD_DOCUMENT_TARGET_REQUIRED: "Bind each document to a newly created formal target.",
  GREENFIELD_DOCUMENT_DEPENDENCY_REQUIRED: "Add the required target dependency to each document.",
  GREENFIELD_ASSERTION_SCOPE_REQUIRED: "Bind each Assertion to a newly created formal scope and dependency.",
  GREENFIELD_ASSERTION_EVIDENCE_REQUIRED: "Bind each Assertion evidence reference to its document dependency.",
  GREENFIELD_CREATIVE_DOCUMENT_OWNER_REQUIRED: "Bind each creative document to a newly created formal owner.",
  GREENFIELD_CREATIVE_DOCUMENT_DEPENDENCY_REQUIRED: "Add the required owner dependency to each creative document.",
  GREENFIELD_RELATION_ENDPOINT_REQUIRED: "Bind each relation to newly created formal endpoints.",
  GREENFIELD_RELATION_DEPENDENCY_REQUIRED: "Add required endpoint dependencies to each relation.",
  GREENFIELD_CONSTRAINT_SCOPE_REQUIRED: "Bind each scoped constraint to its newly created formal scope.",
  CHANGE_SET_POLICY_REQUIRED: "A trusted Change Set policy is required.",
  CHANGE_SET_POLICY_INVALID: "The Change Set policy result is invalid.",
  CHANGE_SET_ITEM_DUPLICATE: "The Change Set contains duplicate items.",
  CHANGE_SET_DEPENDENCY_DUPLICATE: "The Change Set contains duplicate dependencies.",
  CHANGE_SET_DEPENDENCY_NOT_FOUND: "A Change Set dependency is unavailable.",
  CHANGE_SET_DEPENDENCY_CYCLE: "The Change Set dependency graph contains a cycle.",
  GREENFIELD_OUTPUT_EVIDENCE_DEPENDENCY_REQUIRED: "Greenfield Assertion evidence requires its document dependency.",
  GREENFIELD_OUTPUT_EVIDENCE_NOT_COMMITTED: "Greenfield Assertion evidence is not a committed document output.",
  CHANGE_SET_OUTPUTS_INCOMPLETE: "Committed Change Set outputs are incomplete.",
  CHANGE_SET_EXPECTED_HEAD_MISMATCH: "The Change Set base checkpoint no longer matches.",
  CHANGE_SET_PROVENANCE_MISMATCH: "The Change Set provenance does not match this Agent Run.",
  IDEMPOTENCY_KEY_REUSED: "The Change Set idempotency key conflicts with a different request.",
  RESOURCE_DOMAIN_KIND_MISMATCH: "The resource kind does not match its domain.",
  RESOURCE_PARENT_REQUIRED: "The resource requires a valid formal parent.",
  RESOURCE_PARENT_NOT_FOUND: "The resource parent is unavailable.",
  RESOURCE_PARENT_KIND_INVALID: "The resource parent kind is invalid.",
  RESOURCE_PARENT_DOMAIN_INVALID: "The resource parent belongs to another domain.",
  RESOURCE_OWNERSHIP_CYCLE: "The resource ownership hierarchy contains a cycle.",
  DOCUMENT_KIND_OWNER_INVALID: "The document kind is invalid for its owner.",
  RELATION_SELF_REFERENCE: "A relation cannot target the same resource.",
  RELATION_SOURCE_KIND_INVALID: "The relation source kind is invalid.",
  RELATION_TARGET_KIND_INVALID: "The relation target kind is invalid.",
  RELATION_ENDPOINT_KIND_INVALID: "The relation endpoints are invalid.",
  ASSERTION_SOURCE_REQUIRED: "An Assertion requires a stable source.",
  DOCUMENT_VERSION_NOT_FOUND: "The required document version is unavailable.",
  CHANGE_SET_INPUT_INVALID: "The Change Set input is invalid.",
  CHANGE_SET_POLICY_EXECUTION_FAILED: "The Change Set policy could not be evaluated safely.",
  CHANGE_SET_PERSISTENCE_FAILED: "The Change Set could not be persisted safely.",
  CHANGE_SET_APPLY_FAILED: "The Change Set could not be applied safely.",
} as const;
