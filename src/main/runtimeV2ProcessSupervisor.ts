import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { z } from "zod";
import {
  RUNTIME_V2_PROTOCOL_VERSION,
  RuntimeV2ProtocolVersionError,
  parseRuntimeV2HelloEnvelope,
  parseRuntimeV2ErrorEnvelope,
  parseRuntimeV2InitializationFailedEnvelope,
  parseRuntimeV2ProviderBoundEnvelope,
  parseRuntimeV2ProviderRejectedEnvelope,
  parseRuntimeV2ProviderInferenceAcceptedEnvelope,
  parseRuntimeV2ProviderInferenceCompletedEnvelope,
  parseRuntimeV2ProviderInferenceFailedEnvelope,
  parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope,
  parseRuntimeV2ContextCompilationEnvelope,
  parseRuntimeV2ContextRejectedEnvelope,
  parseRuntimeV2ReadyEnvelope,
  parseRuntimeV2RunRejectedEnvelope,
  parseRuntimeV2RunReconciledEnvelope,
  parseRuntimeV2RunSnapshotEnvelope,
  parseRuntimeV2GoalSnapshotEnvelope,
  parseRuntimeV2GoalRejectedEnvelope,
  parseRuntimeV2PlanSnapshotEnvelope,
  parseRuntimeV2PlanRejectedEnvelope,
  parseRuntimeV2AgentAssignmentSnapshotEnvelope,
  parseRuntimeV2AgentAssignmentRejectedEnvelope,
  parseRuntimeV2StatusEnvelope,
  parseRuntimeV2StoppedEnvelope,
  parseRuntimeV2ToolAuthorizationResolvedEnvelope,
  parseRuntimeV2ToolRequestedEnvelope,
  parseRuntimeV2ToolAuthorizedEnvelope,
  parseRuntimeV2ToolRunningEnvelope,
  parseRuntimeV2ToolSucceededEnvelope,
  parseRuntimeV2ToolFailedEnvelope,
  parseRuntimeV2ToolOutcomeUnknownEnvelope,
  runtimeV2InitializeEnvelopeSchema,
  runtimeV2ContextCompileEnvelopeSchema,
  runtimeV2SensitiveProviderBindEnvelopeSchema,
  runtimeV2ProviderInferenceStartEnvelopeSchema,
  runtimeV2RunGetEnvelopeSchema,
  runtimeV2RunCancelEnvelopeSchema,
  runtimeV2RunReconcileEnvelopeSchema,
  runtimeV2RunPrepareEnvelopeSchema,
  runtimeV2RunStartEnvelopeSchema,
  runtimeV2GoalCreateEnvelopeSchema,
  runtimeV2GoalGetEnvelopeSchema,
  runtimeV2GoalReviseEnvelopeSchema,
  runtimeV2GoalCompletionProposeEnvelopeSchema,
  runtimeV2GoalCompleteEnvelopeSchema,
  runtimeV2PlanCreateEnvelopeSchema,
  runtimeV2PlanGetEnvelopeSchema,
  runtimeV2PlanReviseEnvelopeSchema,
  runtimeV2PlanStepStartEnvelopeSchema,
  runtimeV2PlanStepCompleteEnvelopeSchema,
  runtimeV2AgentAssignmentCreateEnvelopeSchema,
  runtimeV2AgentAssignmentGetEnvelopeSchema,
  runtimeV2AgentAssignmentStartEnvelopeSchema,
  runtimeV2AgentAssignmentRequestCancelEnvelopeSchema,
  runtimeV2AgentAssignmentConfirmCancelledEnvelopeSchema,
  runtimeV2AgentAssignmentCompleteEnvelopeSchema,
  runtimeV2AgentAssignmentFailEnvelopeSchema,
  runtimeV2ShutdownEnvelopeSchema,
  runtimeV2StatusGetEnvelopeSchema,
  runtimeV2ToolAuthorizationResolveEnvelopeSchema,
  type RuntimeV2HelloEnvelope,
  type RuntimeV2Error,
  type RuntimeV2ErrorEnvelope,
  type RuntimeV2InitializeEnvelope,
  type RuntimeV2ReadyEnvelope,
  type RuntimeV2ProviderBindingReceipt,
  type RuntimeV2ProviderConfig,
  type RuntimeV2ProviderInferenceAcceptedEnvelope,
  type RuntimeV2ProviderInferenceCompletedEnvelope,
  type RuntimeV2ProviderInferenceFailedEnvelope,
  type RuntimeV2ProviderInferenceReconciliationRequiredEnvelope,
  type RuntimeV2ProviderInferenceStartPayload,
  type RuntimeV2ContextCompilePayload,
  type RuntimeV2ContextCompilationReceipt,
  type RuntimeV2RunSnapshotPayload,
  type RuntimeV2RunCancelPayload,
  type RuntimeV2RunReconcilePayload,
  type RuntimeV2RunReconciliationReceipt,
  type RuntimeV2RunPreparePayload,
  type RuntimeV2RunStartPayload,
  type RuntimeV2GoalCreatePayload,
  type RuntimeV2GoalGetPayload,
  type RuntimeV2GoalRevisePayload,
  type RuntimeV2GoalCompletionProposePayload,
  type RuntimeV2GoalCompletePayload,
  type RuntimeV2GoalSnapshotPayload,
  type RuntimeV2PlanCreatePayload,
  type RuntimeV2PlanGetPayload,
  type RuntimeV2PlanRevisePayload,
  type RuntimeV2PlanStepStartPayload,
  type RuntimeV2PlanStepCompletePayload,
  type RuntimeV2PlanSnapshotPayload,
  type RuntimeV2AgentAssignmentCreatePayload,
  type RuntimeV2AgentAssignmentGetPayload,
  type RuntimeV2AgentAssignmentStartPayload,
  type RuntimeV2AgentAssignmentRequestCancelPayload,
  type RuntimeV2AgentAssignmentConfirmCancelledPayload,
  type RuntimeV2AgentAssignmentCompletePayload,
  type RuntimeV2AgentAssignmentFailPayload,
  type RuntimeV2AgentAssignmentSnapshotPayload,
  type RuntimeV2StatusPayload,
  type RuntimeV2ToolAuthorizationResolvePayload,
  type RuntimeV2ToolAuthorizationResolvedPayload,
  type RuntimeV2ToolRequestedEnvelope,
  type RuntimeV2ToolAuthorizedEnvelope,
  type RuntimeV2ToolRunningEnvelope,
  type RuntimeV2ToolSucceededEnvelope,
  type RuntimeV2ToolFailedEnvelope,
  type RuntimeV2ToolOutcomeUnknownEnvelope,
} from "../shared/runtimeV2Protocol";

const MAX_STDERR_CHARS = 16_000;

export interface RuntimeV2ApplicationIdentity {
  id: string;
  version: string;
  commit: string;
}

export interface RuntimeV2ProcessSupervisorOptions {
  executablePath: string;
  executableArgs?: string[];
  application: RuntimeV2ApplicationIdentity;
  workspaceDatabasePath: string | null;
  projectRootPath: string | null;
  projectId: string | null;
  workspaceId: string | null;
  featureFlags: Record<string, boolean>;
  hostCapabilityVersions: Record<string, string>;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  stopTimeoutMs?: number;
  onStderr?(text: string): void;
  onRuntimeFailure?(error: RuntimeV2SupervisorError): void;
}

export interface RuntimeV2Handshake {
  hello: RuntimeV2HelloEnvelope;
  ready: RuntimeV2ReadyEnvelope;
}

export type RuntimeV2RuntimeEvent = RuntimeV2ErrorEnvelope
  | RuntimeV2ProviderInferenceCompletedEnvelope
  | RuntimeV2ProviderInferenceFailedEnvelope
  | RuntimeV2ProviderInferenceReconciliationRequiredEnvelope
  | RuntimeV2ToolRequestedEnvelope | RuntimeV2ToolAuthorizedEnvelope | RuntimeV2ToolRunningEnvelope
  | RuntimeV2ToolSucceededEnvelope | RuntimeV2ToolFailedEnvelope | RuntimeV2ToolOutcomeUnknownEnvelope;

export type RuntimeV2SupervisorErrorCode =
  | "RUNTIME_V2_ALREADY_STARTED"
  | "RUNTIME_V2_SPAWN_FAILED"
  | "RUNTIME_V2_START_TIMEOUT"
  | "RUNTIME_V2_INVALID_JSON"
  | "RUNTIME_V2_PROTOCOL_INVALID"
  | "RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED"
  | "RUNTIME_V2_INITIALIZATION_FAILED"
  | "RUNTIME_V2_EXITED_BEFORE_READY"
  | "RUNTIME_V2_NOT_READY"
  | "RUNTIME_V2_COMMAND_TIMEOUT"
  | "RUNTIME_V2_EXITED_AFTER_READY"
  | "RUNTIME_V2_RUN_REJECTED"
  | "RUNTIME_V2_GOAL_REJECTED"
  | "RUNTIME_V2_PLAN_REJECTED"
  | "RUNTIME_V2_AGENT_ASSIGNMENT_REJECTED"
  | "RUNTIME_V2_CONTEXT_REJECTED"
  | "RUNTIME_V2_PROVIDER_REJECTED"
  | "RUNTIME_V2_WRITE_FAILED";

export class RuntimeV2SupervisorError extends Error {
  readonly publicPayload: RuntimeV2Error | null;
  readonly stderr: string;

  constructor(
    readonly code: RuntimeV2SupervisorErrorCode,
    message: string,
    options: ErrorOptions & { publicPayload?: RuntimeV2Error; stderr?: string } = {},
  ) {
    super(message, options);
    this.name = "RuntimeV2SupervisorError";
    this.publicPayload = options.publicPayload ?? null;
    this.stderr = options.stderr ?? "";
  }
}

export class RuntimeV2ProcessSupervisor {
  readonly #options: Required<Pick<RuntimeV2ProcessSupervisorOptions, "startupTimeoutMs" | "commandTimeoutMs" | "stopTimeoutMs">>
    & Omit<RuntimeV2ProcessSupervisorOptions, "startupTimeoutMs" | "commandTimeoutMs" | "stopTimeoutMs">;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: readline.Interface | null = null;
  #stderr = "";
  #ready = false;
  #stopping = false;
  #validatedStopReason: "requested" | null = null;
  #nextHostSequence = 2;
  #expectedRuntimeSequence = 3;
  #pending = new Map<string, PendingCommand>();
  #activeInferences = new Map<string, ActiveProviderInference>();
  #runtimeEventListeners = new Set<(event: RuntimeV2RuntimeEvent) => void>();

  constructor(options: RuntimeV2ProcessSupervisorOptions) {
    this.#options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 5_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 2_000,
    };
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  get stderr(): string {
    return this.#stderr;
  }

  subscribeRuntimeEvents(listener: (event: RuntimeV2RuntimeEvent) => void): () => void {
    this.#runtimeEventListeners.add(listener);
    return () => this.#runtimeEventListeners.delete(listener);
  }

  async start(): Promise<RuntimeV2Handshake> {
    if (this.#child) {
      throw new RuntimeV2SupervisorError("RUNTIME_V2_ALREADY_STARTED", "Runtime V2 is already started.");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.executablePath, this.#options.executableArgs ?? [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new RuntimeV2SupervisorError("RUNTIME_V2_SPAWN_FAILED", "Runtime V2 could not be spawned.", { cause: error });
    }
    this.#child = child;
    this.#stderr = "";
    this.#stopping = false;
    this.#validatedStopReason = null;
    this.#nextHostSequence = 2;
    this.#expectedRuntimeSequence = 3;
    this.#activeInferences.clear();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
      this.#options.onStderr?.(chunk);
    });

    try {
      const handshake = await this.#completeHandshake(child);
      this.#ready = true;
      this.#attachPostReadyListeners(child);
      return handshake;
    } catch (error) {
      await this.#terminateChild(child);
      throw error;
    }
  }

  async status(): Promise<RuntimeV2StatusPayload> {
    const response = await this.#sendCommand("runtime.status.get", "runtime.status", null, {});
    return parseRuntimeV2StatusEnvelope(response).payload;
  }

  async createGoal(payload: RuntimeV2GoalCreatePayload): Promise<RuntimeV2GoalSnapshotPayload> {
    return parseRuntimeV2GoalSnapshotEnvelope(
      await this.#sendCommand("goal.create", "goal.snapshot", null, payload),
    ).payload;
  }

  async getGoal(payload: RuntimeV2GoalGetPayload): Promise<RuntimeV2GoalSnapshotPayload> {
    return parseRuntimeV2GoalSnapshotEnvelope(
      await this.#sendCommand("goal.get", "goal.snapshot", null, payload),
    ).payload;
  }

  async reviseGoal(payload: RuntimeV2GoalRevisePayload): Promise<RuntimeV2GoalSnapshotPayload> {
    return parseRuntimeV2GoalSnapshotEnvelope(
      await this.#sendCommand("goal.revise", "goal.snapshot", null, payload),
    ).payload;
  }

  async proposeGoalCompletion(payload: RuntimeV2GoalCompletionProposePayload): Promise<RuntimeV2GoalSnapshotPayload> {
    return parseRuntimeV2GoalSnapshotEnvelope(
      await this.#sendCommand("goal.completion.propose", "goal.snapshot", null, payload),
    ).payload;
  }

  async completeGoal(payload: RuntimeV2GoalCompletePayload): Promise<RuntimeV2GoalSnapshotPayload> {
    return parseRuntimeV2GoalSnapshotEnvelope(
      await this.#sendCommand("goal.complete", "goal.snapshot", null, payload),
    ).payload;
  }

  async createPlan(payload: RuntimeV2PlanCreatePayload): Promise<RuntimeV2PlanSnapshotPayload> {
    return parseRuntimeV2PlanSnapshotEnvelope(
      await this.#sendCommand("plan.create", "plan.snapshot", null, payload),
    ).payload;
  }

  async getPlan(payload: RuntimeV2PlanGetPayload): Promise<RuntimeV2PlanSnapshotPayload> {
    return parseRuntimeV2PlanSnapshotEnvelope(
      await this.#sendCommand("plan.get", "plan.snapshot", null, payload),
    ).payload;
  }

  async revisePlan(payload: RuntimeV2PlanRevisePayload): Promise<RuntimeV2PlanSnapshotPayload> {
    return parseRuntimeV2PlanSnapshotEnvelope(
      await this.#sendCommand("plan.revise", "plan.snapshot", null, payload),
    ).payload;
  }

  async startPlanStep(payload: RuntimeV2PlanStepStartPayload): Promise<RuntimeV2PlanSnapshotPayload> {
    return parseRuntimeV2PlanSnapshotEnvelope(
      await this.#sendCommand("plan.step.start", "plan.snapshot", null, payload),
    ).payload;
  }

  async completePlanStep(payload: RuntimeV2PlanStepCompletePayload): Promise<RuntimeV2PlanSnapshotPayload> {
    return parseRuntimeV2PlanSnapshotEnvelope(
      await this.#sendCommand("plan.step.complete", "plan.snapshot", null, payload),
    ).payload;
  }

  async createAgentAssignment(payload: RuntimeV2AgentAssignmentCreatePayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.create", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async getAgentAssignment(payload: RuntimeV2AgentAssignmentGetPayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.get", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async startAgentAssignment(payload: RuntimeV2AgentAssignmentStartPayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.start", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async requestAgentAssignmentCancellation(payload: RuntimeV2AgentAssignmentRequestCancelPayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.request_cancel", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async confirmAgentAssignmentCancelled(payload: RuntimeV2AgentAssignmentConfirmCancelledPayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.confirm_cancelled", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async completeAgentAssignment(payload: RuntimeV2AgentAssignmentCompletePayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.complete", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async failAgentAssignment(payload: RuntimeV2AgentAssignmentFailPayload): Promise<RuntimeV2AgentAssignmentSnapshotPayload> {
    return parseRuntimeV2AgentAssignmentSnapshotEnvelope(
      await this.#sendCommand("agent.assignment.fail", "agent.assignment.snapshot", null, payload),
    ).payload;
  }

  async startRun(runId: string, payload: RuntimeV2RunStartPayload): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.start", "run.snapshot", runId, payload);
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async getRun(runId: string): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.get", "run.snapshot", runId, {});
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async prepareRun(runId: string, payload: RuntimeV2RunPreparePayload): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.prepare", "run.snapshot", runId, payload);
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async compileContext(
    runId: string,
    payload: RuntimeV2ContextCompilePayload,
  ): Promise<RuntimeV2ContextCompilationReceipt> {
    const response = await this.#sendCommand("context.compile", "context.compilation", runId, payload);
    return parseRuntimeV2ContextCompilationEnvelope(response).payload;
  }

  async cancelRun(runId: string, payload: RuntimeV2RunCancelPayload): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.cancel", "run.snapshot", runId, payload);
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async reconcileRun(
    runId: string,
    payload: RuntimeV2RunReconcilePayload,
  ): Promise<{ receipt: RuntimeV2RunReconciliationReceipt; snapshot: RuntimeV2RunSnapshotPayload }> {
    const response = await this.#sendCommand(
      "run.reconcile",
      "run.reconciled",
      runId,
      payload,
      this.#options.commandTimeoutMs,
      undefined,
      { runId, payload },
    );
    const receipt = parseRuntimeV2RunReconciledEnvelope(response).payload;
    return { receipt, snapshot: await this.getRun(runId) };
  }

  async resolveToolAuthorization(
    runId: string,
    payload: RuntimeV2ToolAuthorizationResolvePayload,
  ): Promise<RuntimeV2ToolAuthorizationResolvedPayload> {
    const response = await this.#sendCommand(
      "tool.authorization.resolve", "tool.authorization.resolved", runId, payload,
      this.#options.commandTimeoutMs, undefined, undefined, { runId, payload },
    );
    return parseRuntimeV2ToolAuthorizationResolvedEnvelope(response).payload;
  }

  async bindProvider(
    config: RuntimeV2ProviderConfig,
    configSha256: string,
    credential: string,
  ): Promise<RuntimeV2ProviderBindingReceipt> {
    const response = await this.#sendSensitiveProviderBind(config, configSha256, credential);
    return parseRuntimeV2ProviderBoundEnvelope(response).payload;
  }

  async startProviderInference(
    runId: string,
    payload: RuntimeV2ProviderInferenceStartPayload,
  ): Promise<RuntimeV2ProviderInferenceAcceptedEnvelope["payload"]> {
    const response = await this.#sendCommand(
      "provider.inference.start",
      "provider.inference.accepted",
      runId,
      payload,
      this.#options.commandTimeoutMs,
      { runId, payload },
    );
    return parseRuntimeV2ProviderInferenceAcceptedEnvelope(response).payload;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    if (this.#ready && this.#validatedStopReason === null) {
      try {
        const response = await this.#sendCommand("runtime.shutdown", "runtime.stopped", null, {}, this.#options.stopTimeoutMs);
        parseRuntimeV2StoppedEnvelope(response);
      } catch {
        // Cleanup must continue even when the runtime cannot complete protocol shutdown.
      }
    }
    if (this.#ready && this.#validatedStopReason === "requested") {
      const exit = await waitForExitWithin(child, this.#options.stopTimeoutMs);
      if (exit === null) {
        this.#failRuntime(new RuntimeV2SupervisorError(
          "RUNTIME_V2_EXITED_AFTER_READY",
          `Runtime V2 acknowledged shutdown but did not exit within ${this.#options.stopTimeoutMs}ms.${stderrSuffix(this.#stderr)}`,
          { stderr: this.#stderr },
        ), false);
        await this.#terminateChild(child, true);
        return;
      }
      if (exit.code !== 0 || exit.signal !== null) {
        this.#failRuntime(new RuntimeV2SupervisorError(
          "RUNTIME_V2_EXITED_AFTER_READY",
          `Runtime V2 acknowledged shutdown but did not exit cleanly (code=${String(exit.code)}, signal=${String(exit.signal)}).${stderrSuffix(this.#stderr)}`,
          { stderr: this.#stderr },
        ), false);
        await this.#terminateChild(child);
        return;
      }
      this.#completeCleanRuntimeExit(child);
      return;
    }
    await this.#terminateChild(child);
  }

  async #completeHandshake(child: ChildProcessWithoutNullStreams): Promise<RuntimeV2Handshake> {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines = lines;
    let hello: RuntimeV2HelloEnvelope | null = null;
    let initialize: RuntimeV2InitializeEnvelope | null = null;

    return new Promise<RuntimeV2Handshake>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          child.off("error", onError);
          child.off("exit", onExit);
          lines.off("line", onLine);
        };
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          operation();
        };
        const fail = (error: RuntimeV2SupervisorError): void => finish(() => reject(error));
        const timer = setTimeout(() => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_START_TIMEOUT",
          `Runtime V2 did not become ready within ${this.#options.startupTimeoutMs}ms.${stderrSuffix(this.#stderr)}`,
        )), this.#options.startupTimeoutMs);

        const onError = (error: Error): void => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_SPAWN_FAILED",
          `Runtime V2 process failed to start.${stderrSuffix(this.#stderr)}`,
          { cause: error },
        ));
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_EXITED_BEFORE_READY",
          `Runtime V2 exited before ready (code=${String(code)}, signal=${String(signal)}).${stderrSuffix(this.#stderr)}`,
        ));
        const onLine = (line: string): void => {
          if (settled || !line.trim()) return;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch (error) {
            fail(new RuntimeV2SupervisorError("RUNTIME_V2_INVALID_JSON", "Runtime V2 emitted invalid JSON.", { cause: error }));
            return;
          }
          try {
            if (!hello) {
              hello = parseRuntimeV2HelloEnvelope(value);
              initialize = createInitializeEnvelope(this.#options);
              child.stdin.write(`${JSON.stringify(initialize)}\n`, "utf8", (error) => {
                if (error) fail(new RuntimeV2SupervisorError(
                  "RUNTIME_V2_WRITE_FAILED",
                  "Runtime V2 initialize command could not be written.",
                  { cause: error },
                ));
              });
              return;
            }
            const secondName = readMessageName(value);
            if (secondName === "runtime.initialization_failed") {
              const failure = parseRuntimeV2InitializationFailedEnvelope(value);
              if (!initialize || failure.correlationId !== initialize.messageId) {
                throw new Error("runtime.initialization_failed correlationId does not match runtime.initialize messageId.");
              }
              throw new RuntimeV2SupervisorError(
                "RUNTIME_V2_INITIALIZATION_FAILED",
                failure.payload.publicMessage,
                { publicPayload: failure.payload, stderr: this.#stderr },
              );
            }
            if (secondName !== "runtime.ready") {
              throw new Error(`unexpected Runtime V2 handshake message: ${String(secondName)}.`);
            }
            const ready = parseRuntimeV2ReadyEnvelope(value);
            if (!initialize || ready.correlationId !== initialize.messageId) {
              throw new Error("runtime.ready correlationId does not match runtime.initialize messageId.");
            }
            const completedHello = hello;
            if (
              ready.payload.runtime.version !== completedHello.payload.runtimeVersion
              || ready.payload.runtime.build.commit !== completedHello.payload.build.commit
              || ready.payload.runtime.build.target !== completedHello.payload.build.target
            ) {
              throw new Error("runtime.ready identity does not match runtime.hello identity.");
            }
            finish(() => resolve({ hello: completedHello, ready }));
          } catch (error) {
            fail(toProtocolError(error));
          }
        };
        child.once("error", onError);
        child.once("exit", onExit);
        lines.on("line", onLine);
      });
  }

  #attachPostReadyListeners(child: ChildProcessWithoutNullStreams): void {
    const lines = this.#lines;
    if (!lines) throw new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_INVALID", "Runtime V2 output reader is unavailable.");
    lines.on("line", (line) => this.#handlePostReadyLine(line));
    child.once("error", (error) => this.#failRuntime(new RuntimeV2SupervisorError(
      "RUNTIME_V2_EXITED_AFTER_READY",
      `Runtime V2 process failed after ready.${stderrSuffix(this.#stderr)}`,
      { cause: error, stderr: this.#stderr },
    )));
    child.once("exit", (code, signal) => {
      if (!this.#ready) return;
      if (this.#stopping && this.#validatedStopReason === "requested") return;
      if (this.#validatedStopReason !== null && code === 0 && signal === null) {
        this.#completeCleanRuntimeExit(child);
        return;
      }
      this.#failRuntime(new RuntimeV2SupervisorError(
        "RUNTIME_V2_EXITED_AFTER_READY",
        `Runtime V2 exited after ready (code=${String(code)}, signal=${String(signal)}).${stderrSuffix(this.#stderr)}`,
        { stderr: this.#stderr },
      ));
    });
  }

  #handlePostReadyLine(line: string): void {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      const name = readMessageName(value);
      const response = name === "runtime.status"
        ? parseRuntimeV2StatusEnvelope(value)
        : name === "runtime.stopped"
          ? parseRuntimeV2StoppedEnvelope(value)
          : name === "runtime.error"
            ? parseRuntimeV2ErrorEnvelope(value)
            : name === "run.snapshot"
              ? parseRuntimeV2RunSnapshotEnvelope(value)
              : name === "run.reconciled"
                ? parseRuntimeV2RunReconciledEnvelope(value)
              : name === "run.rejected"
                ? parseRuntimeV2RunRejectedEnvelope(value)
                : name === "goal.snapshot"
                  ? parseRuntimeV2GoalSnapshotEnvelope(value)
                  : name === "goal.rejected"
                    ? parseRuntimeV2GoalRejectedEnvelope(value)
                    : name === "plan.snapshot"
                      ? parseRuntimeV2PlanSnapshotEnvelope(value)
                    : name === "plan.rejected"
                      ? parseRuntimeV2PlanRejectedEnvelope(value)
                      : name === "agent.assignment.snapshot"
                        ? parseRuntimeV2AgentAssignmentSnapshotEnvelope(value)
                        : name === "agent.assignment.rejected"
                          ? parseRuntimeV2AgentAssignmentRejectedEnvelope(value)
                : name === "context.compilation"
                  ? parseRuntimeV2ContextCompilationEnvelope(value)
                  : name === "context.rejected"
                    ? parseRuntimeV2ContextRejectedEnvelope(value)
                    : name === "provider.bound"
                      ? parseRuntimeV2ProviderBoundEnvelope(value)
                    : name === "provider.rejected"
                        ? parseRuntimeV2ProviderRejectedEnvelope(value)
                        : name === "provider.inference.accepted"
                          ? parseRuntimeV2ProviderInferenceAcceptedEnvelope(value)
                          : name === "provider.inference.completed"
                            ? parseRuntimeV2ProviderInferenceCompletedEnvelope(value)
                            : name === "provider.inference.failed"
                              ? parseRuntimeV2ProviderInferenceFailedEnvelope(value)
                              : name === "provider.inference.reconciliation_required"
                                ? parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope(value)
                                : name === "tool.authorization.resolved"
                                  ? parseRuntimeV2ToolAuthorizationResolvedEnvelope(value)
                                  : name === "tool.requested" ? parseRuntimeV2ToolRequestedEnvelope(value)
                                    : name === "tool.authorized" ? parseRuntimeV2ToolAuthorizedEnvelope(value)
                                      : name === "tool.running" ? parseRuntimeV2ToolRunningEnvelope(value)
                                        : name === "tool.succeeded" ? parseRuntimeV2ToolSucceededEnvelope(value)
                                          : name === "tool.failed" ? parseRuntimeV2ToolFailedEnvelope(value)
                                            : name === "tool.outcome_unknown" ? parseRuntimeV2ToolOutcomeUnknownEnvelope(value)
                        : null;
      if (!response) throw new Error(`unexpected Runtime V2 message after ready: ${String(name)}.`);
      if (response.sequence !== this.#expectedRuntimeSequence) {
        throw new Error(`runtime sequence must be ${this.#expectedRuntimeSequence}, received ${response.sequence}.`);
      }
      this.#expectedRuntimeSequence += 1;
      const correlationId = response.correlationId;
      if (isProviderInferenceTerminalEvent(response)) {
        if (!correlationId) throw new Error("Provider inference terminal event is missing correlationId.");
        const active = this.#activeInferences.get(correlationId);
        if (!active) throw new Error(`Provider inference terminal event has no active attempt: ${correlationId}.`);
        assertInferenceIdentity(response.payload, active);
        this.#activeInferences.delete(correlationId);
        this.#emitRuntimeEvent(response);
        return;
      }
      if (isToolLifecycleEvent(response)) {
        this.#emitRuntimeEvent(response);
        return;
      }
      if (response.messageType === "event" && correlationId === null) {
        this.#emitRuntimeEvent(response);
        return;
      }
      if (!correlationId) throw new Error("Runtime V2 response is missing correlationId.");
      const pending = this.#pending.get(correlationId);
      if (!pending) throw new Error(`Runtime V2 response has no pending command: ${String(correlationId)}.`);
      if (
        response.name === "runtime.error"
        || response.name === "run.rejected"
        || response.name === "goal.rejected"
        || response.name === "plan.rejected"
        || response.name === "agent.assignment.rejected"
        || response.name === "context.rejected"
        || response.name === "provider.rejected"
      ) {
        this.#pending.delete(correlationId);
        clearTimeout(pending.timer);
        pending.reject(new RuntimeV2SupervisorError(
          response.name === "run.rejected"
            ? "RUNTIME_V2_RUN_REJECTED"
            : response.name === "goal.rejected"
              ? "RUNTIME_V2_GOAL_REJECTED"
              : response.name === "plan.rejected"
                ? "RUNTIME_V2_PLAN_REJECTED"
                : response.name === "agent.assignment.rejected"
                  ? "RUNTIME_V2_AGENT_ASSIGNMENT_REJECTED"
            : response.name === "context.rejected"
              ? "RUNTIME_V2_CONTEXT_REJECTED"
            : response.name === "provider.rejected"
              ? "RUNTIME_V2_PROVIDER_REJECTED"
              : "RUNTIME_V2_PROTOCOL_INVALID",
          response.payload.publicMessage,
          { publicPayload: response.payload, stderr: this.#stderr },
        ));
        return;
      }
      if (response.name !== pending.expectedName) {
        throw new Error(`expected ${pending.expectedName}, received ${response.name}.`);
      }
      if (response.name === "runtime.stopped") {
        if (!this.#stopping || response.payload.reason !== "requested") {
          throw new Error("runtime.stopped(requested) arrived outside an active Host shutdown.");
        }
        if (this.#pending.size !== 1 || this.#activeInferences.size !== 0) {
          throw new Error(
            `runtime.stopped(requested) arrived with ${this.#pending.size - 1} unrelated pending command(s) and ${this.#activeInferences.size} active inference(s).`,
          );
        }
        this.#validatedStopReason = "requested";
      }
      if (response.name === "provider.inference.accepted") {
        if (!pending.inference) throw new Error("Provider inference acceptance has no pending inference identity.");
        assertInferenceIdentity(response.payload, pending.inference);
        this.#activeInferences.set(correlationId, response.payload);
      }
      if (response.name === "run.reconciled") {
        if (!pending.reconciliation) throw new Error("Run reconciliation response has no pending decision identity.");
        if (response.runId !== pending.reconciliation.runId
          || response.payload.attemptId !== pending.reconciliation.payload.attemptId
          || response.payload.decision !== pending.reconciliation.payload.decision) {
          throw new Error("Run reconciliation receipt does not match the pending decision.");
        }
      }
      if (response.name === "tool.authorization.resolved") {
        if (!pending.toolAuthorization) throw new Error("Tool authorization response has no pending host decision.");
        if (response.runId !== pending.toolAuthorization.runId
          || response.payload.toolCallId !== pending.toolAuthorization.payload.toolCallId
          || response.payload.decision !== pending.toolAuthorization.payload.decision) {
          throw new Error("Tool authorization response does not match the pending host decision.");
        }
      }
      this.#pending.delete(correlationId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    } catch (error) {
      this.#failRuntime(toProtocolError(error));
    }
  }

  #emitRuntimeEvent(event: RuntimeV2RuntimeEvent): void {
    for (const listener of this.#runtimeEventListeners) {
      try {
        listener(event);
      } catch {
        // Host subscribers cannot corrupt Runtime protocol state.
      }
    }
  }

  #sendSensitiveProviderBind(
    config: RuntimeV2ProviderConfig,
    configSha256: string,
    credential: string,
  ): Promise<unknown> {
    const child = this.#child;
    if (!child || !this.#ready || this.#stopping || child.stdin.destroyed) {
      return Promise.reject(new RuntimeV2SupervisorError("RUNTIME_V2_NOT_READY", "Runtime V2 is not ready."));
    }
    const sequence = this.#nextHostSequence;
    this.#nextHostSequence += 1;
    const command = runtimeV2SensitiveProviderBindEnvelopeSchema.parse({
      protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
      messageId: randomUUID(),
      messageType: "sensitive_command",
      name: "provider.bind",
      sentAt: new Date().toISOString(),
      correlationId: null,
      runId: null,
      sequence,
      payload: { config, configSha256, credential },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.messageId);
        const error = new RuntimeV2SupervisorError(
          "RUNTIME_V2_COMMAND_TIMEOUT",
          `provider.bind did not complete within ${this.#options.commandTimeoutMs}ms.${stderrSuffix(this.#stderr)}`,
          { stderr: this.#stderr },
        );
        reject(error);
        this.#failRuntime(error);
      }, this.#options.commandTimeoutMs);
      this.#pending.set(command.messageId, { expectedName: "provider.bound", resolve, reject, timer });
      const sensitiveBytes = Buffer.from(`${JSON.stringify(command)}\n`, "utf8");
      child.stdin.write(sensitiveBytes, (error) => {
        sensitiveBytes.fill(0);
        if (!error) return;
        const pending = this.#pending.get(command.messageId);
        if (!pending) return;
        this.#pending.delete(command.messageId);
        clearTimeout(pending.timer);
        const failure = new RuntimeV2SupervisorError(
          "RUNTIME_V2_WRITE_FAILED",
          "provider.bind could not be written.",
          { cause: error },
        );
        reject(failure);
        this.#failRuntime(failure);
      });
    });
  }

  #sendCommand(
    name: "runtime.status.get" | "runtime.shutdown" | "run.start" | "run.get" | "run.prepare" | "run.cancel" | "run.reconcile" | "goal.create" | "goal.get" | "goal.revise" | "goal.completion.propose" | "goal.complete" | "plan.create" | "plan.get" | "plan.revise" | "plan.step.start" | "plan.step.complete" | "agent.assignment.create" | "agent.assignment.get" | "agent.assignment.start" | "agent.assignment.request_cancel" | "agent.assignment.confirm_cancelled" | "agent.assignment.complete" | "agent.assignment.fail" | "context.compile" | "provider.inference.start" | "tool.authorization.resolve",
    expectedName: "runtime.status" | "runtime.stopped" | "run.snapshot" | "run.reconciled" | "goal.snapshot" | "plan.snapshot" | "agent.assignment.snapshot" | "context.compilation" | "provider.inference.accepted" | "tool.authorization.resolved",
    runId: string | null,
    payload: object,
    timeoutMs = this.#options.commandTimeoutMs,
    inference?: PendingProviderInference,
    reconciliation?: PendingRunReconciliation,
    toolAuthorization?: PendingToolAuthorization,
  ): Promise<unknown> {
    const child = this.#child;
    if (!child || !this.#ready || (this.#stopping && name !== "runtime.shutdown") || child.stdin.destroyed) {
      return Promise.reject(new RuntimeV2SupervisorError("RUNTIME_V2_NOT_READY", "Runtime V2 is not ready."));
    }
    const sequence = this.#nextHostSequence;
    this.#nextHostSequence += 1;
    const base = {
      protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
      messageId: randomUUID(),
      messageType: "command" as const,
      name,
      sentAt: new Date().toISOString(),
      correlationId: null,
      runId,
      sequence,
      payload,
    };
    const command = name === "runtime.status.get"
      ? runtimeV2StatusGetEnvelopeSchema.parse(base)
      : name === "runtime.shutdown"
        ? runtimeV2ShutdownEnvelopeSchema.parse(base)
        : name === "run.start"
          ? runtimeV2RunStartEnvelopeSchema.parse(base)
          : name === "run.get"
            ? runtimeV2RunGetEnvelopeSchema.parse(base)
            : name === "run.prepare"
              ? runtimeV2RunPrepareEnvelopeSchema.parse(base)
            : name === "run.cancel"
              ? runtimeV2RunCancelEnvelopeSchema.parse(base)
            : name === "run.reconcile"
                ? runtimeV2RunReconcileEnvelopeSchema.parse(base)
                : name === "goal.create"
                  ? runtimeV2GoalCreateEnvelopeSchema.parse(base)
                  : name === "goal.get"
                    ? runtimeV2GoalGetEnvelopeSchema.parse(base)
                    : name === "goal.revise"
                      ? runtimeV2GoalReviseEnvelopeSchema.parse(base)
                      : name === "goal.completion.propose"
                        ? runtimeV2GoalCompletionProposeEnvelopeSchema.parse(base)
                        : name === "goal.complete"
                          ? runtimeV2GoalCompleteEnvelopeSchema.parse(base)
                          : name === "plan.create"
                            ? runtimeV2PlanCreateEnvelopeSchema.parse(base)
                            : name === "plan.get"
                              ? runtimeV2PlanGetEnvelopeSchema.parse(base)
                              : name === "plan.revise"
                                ? runtimeV2PlanReviseEnvelopeSchema.parse(base)
                                : name === "plan.step.start"
                                  ? runtimeV2PlanStepStartEnvelopeSchema.parse(base)
                                  : name === "plan.step.complete"
                                    ? runtimeV2PlanStepCompleteEnvelopeSchema.parse(base)
                                    : name === "agent.assignment.create"
                                      ? runtimeV2AgentAssignmentCreateEnvelopeSchema.parse(base)
                                      : name === "agent.assignment.get"
                                        ? runtimeV2AgentAssignmentGetEnvelopeSchema.parse(base)
                                        : name === "agent.assignment.start"
                                          ? runtimeV2AgentAssignmentStartEnvelopeSchema.parse(base)
                                          : name === "agent.assignment.request_cancel"
                                            ? runtimeV2AgentAssignmentRequestCancelEnvelopeSchema.parse(base)
                                            : name === "agent.assignment.confirm_cancelled"
                                              ? runtimeV2AgentAssignmentConfirmCancelledEnvelopeSchema.parse(base)
                                              : name === "agent.assignment.complete"
                                                ? runtimeV2AgentAssignmentCompleteEnvelopeSchema.parse(base)
                                                : name === "agent.assignment.fail"
                                                  ? runtimeV2AgentAssignmentFailEnvelopeSchema.parse(base)
                : name === "tool.authorization.resolve"
                  ? runtimeV2ToolAuthorizationResolveEnvelopeSchema.parse(base)
                : name === "context.compile"
                  ? runtimeV2ContextCompileEnvelopeSchema.parse(base)
                  : runtimeV2ProviderInferenceStartEnvelopeSchema.parse(base);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.messageId);
        const error = new RuntimeV2SupervisorError(
          "RUNTIME_V2_COMMAND_TIMEOUT",
          `${name} did not complete within ${timeoutMs}ms.${stderrSuffix(this.#stderr)}`,
          { stderr: this.#stderr },
        );
        reject(error);
        this.#failRuntime(error);
      }, timeoutMs);
      this.#pending.set(command.messageId, { expectedName, resolve, reject, timer, inference, reconciliation, toolAuthorization });
      child.stdin.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.#pending.get(command.messageId);
        if (!pending) return;
        this.#pending.delete(command.messageId);
        clearTimeout(pending.timer);
        const failure = new RuntimeV2SupervisorError("RUNTIME_V2_WRITE_FAILED", `${name} could not be written.`, { cause: error });
        reject(failure);
        this.#failRuntime(failure);
      });
    });
  }

  #failRuntime(error: RuntimeV2SupervisorError, terminateChild = true): void {
    if (!this.#ready) return;
    const child = this.#child;
    this.#ready = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#activeInferences.clear();
    this.#options.onRuntimeFailure?.(error);
    if (child && terminateChild) void this.#terminateChild(child);
  }

  #completeCleanRuntimeExit(child: ChildProcessWithoutNullStreams): void {
    if (this.#child === child) this.#child = null;
    this.#ready = false;
    this.#stopping = false;
    this.#validatedStopReason = null;
    this.#activeInferences.clear();
    this.#lines?.close();
    this.#lines = null;
  }

  async #terminateChild(child: ChildProcessWithoutNullStreams, force = false): Promise<void> {
    if (this.#child === child) this.#child = null;
    this.#ready = false;
    this.#stopping = false;
    this.#validatedStopReason = null;
    this.#activeInferences.clear();
    this.#lines?.close();
    this.#lines = null;
    const pid = child.pid;
    const exited = waitForExit(child);
    if (!child.stdin.destroyed) child.stdin.end();
    if (!force && await resolvesWithin(exited, this.#options.stopTimeoutMs)) return;
    if (hasChildExited(child)) return;
    if (force) {
      await yieldToEventLoop();
      if (hasChildExited(child)) return;
    }
    if (pid && !isProcessAlive(pid)) return;
    if (hasChildExited(child)) return;
    if (pid) {
      terminateOwnedProcessTree(pid);
    } else if (!child.killed) {
      child.kill();
    }
    await resolvesWithin(exited, this.#options.stopTimeoutMs);
  }
}

interface PendingCommand {
  expectedName: "runtime.status" | "runtime.stopped" | "run.snapshot" | "run.reconciled" | "goal.snapshot" | "plan.snapshot" | "agent.assignment.snapshot" | "context.compilation" | "provider.bound" | "provider.inference.accepted" | "tool.authorization.resolved";
  resolve(value: unknown): void;
  reject(error: RuntimeV2SupervisorError): void;
  timer: NodeJS.Timeout;
  inference?: PendingProviderInference;
  reconciliation?: PendingRunReconciliation;
  toolAuthorization?: PendingToolAuthorization;
}

interface PendingProviderInference {
  runId: string;
  payload: RuntimeV2ProviderInferenceStartPayload;
}

interface PendingRunReconciliation {
  runId: string;
  payload: RuntimeV2RunReconcilePayload;
}

interface PendingToolAuthorization {
  runId: string;
  payload: RuntimeV2ToolAuthorizationResolvePayload;
}

type ActiveProviderInference = RuntimeV2ProviderInferenceAcceptedEnvelope["payload"];

function isProviderInferenceTerminalEvent(
  event: RuntimeV2RuntimeEvent | RuntimeV2ProviderInferenceAcceptedEnvelope | object,
): event is RuntimeV2ProviderInferenceCompletedEnvelope
  | RuntimeV2ProviderInferenceFailedEnvelope
  | RuntimeV2ProviderInferenceReconciliationRequiredEnvelope {
  return "name" in event && (
    event.name === "provider.inference.completed"
    || event.name === "provider.inference.failed"
    || event.name === "provider.inference.reconciliation_required"
  );
}

function isToolLifecycleEvent(event: RuntimeV2RuntimeEvent | object): event is
  RuntimeV2ToolRequestedEnvelope | RuntimeV2ToolAuthorizedEnvelope | RuntimeV2ToolRunningEnvelope
  | RuntimeV2ToolSucceededEnvelope | RuntimeV2ToolFailedEnvelope | RuntimeV2ToolOutcomeUnknownEnvelope {
  return "name" in event && typeof event.name === "string" && [
    "tool.requested", "tool.authorized", "tool.running", "tool.succeeded", "tool.failed", "tool.outcome_unknown",
  ].includes(event.name);
}

function assertInferenceIdentity(
  actual: ActiveProviderInference,
  expected: ActiveProviderInference | PendingProviderInference,
): void {
  const expectedIdentity: ActiveProviderInference = "payload" in expected
    ? { runId: expected.runId, ...expected.payload }
    : expected;
  for (const [field, value] of [
    ["runId", expectedIdentity.runId],
    ["inferenceId", expectedIdentity.inferenceId],
    ["attemptId", expectedIdentity.attemptId],
    ["contextCompilationId", expectedIdentity.contextCompilationId],
    ["requestNumber", expectedIdentity.requestNumber],
    ["attemptNumber", expectedIdentity.attemptNumber],
  ] as const) {
    if (actual[field] !== value) throw new Error(`Provider inference ${field} does not match the active attempt.`);
  }
}

function createInitializeEnvelope(
  options: RuntimeV2ProcessSupervisorOptions,
): RuntimeV2InitializeEnvelope {
  return runtimeV2InitializeEnvelopeSchema.parse({
    protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
    messageId: randomUUID(),
    messageType: "command",
    name: "runtime.initialize",
    sentAt: new Date().toISOString(),
    correlationId: null,
    runId: null,
    sequence: 1,
    payload: {
      selectedProtocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
      application: options.application,
      workspaceDatabasePath: options.workspaceDatabasePath,
      projectRootPath: options.projectRootPath,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      featureFlags: options.featureFlags,
      hostCapabilityVersions: options.hostCapabilityVersions,
    },
  });
}

function toProtocolError(error: unknown): RuntimeV2SupervisorError {
  if (error instanceof RuntimeV2SupervisorError) return error;
  if (error instanceof RuntimeV2ProtocolVersionError) {
    return new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED", error.message, { cause: error });
  }
  if (error instanceof z.ZodError || error instanceof Error) {
    return new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_INVALID", `Runtime V2 handshake is invalid: ${error.message}`, { cause: error });
  }
  return new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_INVALID", "Runtime V2 handshake is invalid.");
}

function readMessageName(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("name" in value)) return undefined;
  return value.name;
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForExitWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<ChildExitResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ChildExitResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(result);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish({ code, signal });
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function hasChildExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function resolvesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function terminateOwnedProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The recorded child may have exited between the timeout and termination.
  }
}

function stderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? ` stderr: ${trimmed}` : "";
}
