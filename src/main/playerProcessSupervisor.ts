import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
import { PlayerAuditRepository } from "../domain/audit/playerAuditRepository";
import { PlayerRunCommitService } from "../domain/play/playerRunCommitService";
import type { PreparedPlayerTurn } from "../domain/play/playerTurnContextService";
import type { PlayTurnRecord } from "../domain/play/playthroughRepository";
import { loadGmPrompt, type PlayPrompt } from "../agent-worker/play/playPromptRegistry";
import { promptManifest } from "../agent-worker/prompts/manifest";
import { getAgentRuntimeProfile } from "../shared/agentRuntimeProfiles";
import { agentWorkerAuditRequestSchema, agentWorkerAuditResponseSchema, agentWorkerRunCancelCommandSchema } from "../shared/agentWorkerProtocol";
import { playerTurnEventSchema, type PlayerTurnEvent } from "../shared/ipcContract";
import { playerWorkerEventSchema, playerWorkerTurnStartCommandSchema } from "../shared/playerWorkerProtocol";
import { providerRuntimeProfileSchema, type ProviderRuntimeProfile } from "../shared/providerContract";
import type { AgentWorkerProcess } from "./agentProcessSupervisor";

export interface PlayerRuntimeLease {
  audit: PlayerAuditRepository;
  commit: PlayerRunCommitService;
  prepare(input: { playthroughId: string; playerAction: string }): PreparedPlayerTurn;
  release(): void;
}

interface ActivePlayerRun {
  child: AgentWorkerProcess;
  lease: PlayerRuntimeLease;
  prepared: PreparedPlayerTurn;
  provider: ProviderRuntimeProfile;
  providerConfigSha256: string;
  emit(event: PlayerTurnEvent): void;
}

export class PlayerProcessSupervisor {
  readonly #runs = new Map<string, ActivePlayerRun>();
  constructor(readonly workerPath: string, readonly options: {
    acquireRuntimeLease(): PlayerRuntimeLease | null;
    getProviderProfile(): ProviderRuntimeProfile | null;
    loadGmPrompt?(): PlayPrompt;
    spawnWorker?(workerPath: string): AgentWorkerProcess;
    cancelGraceMs?: number;
  }) {}

  start(request: { playthroughId: string; playerAction: string }, emit: (event: PlayerTurnEvent) => void): string {
    const runId = randomUUID();
    const provider = this.readProvider();
    if (!provider) {
      queueMicrotask(() => emitFailure(runId, "REAL_GM_PROVIDER_REQUIRED", "需要先配置可用的模型服务。", emit));
      return runId;
    }
    const lease = this.options.acquireRuntimeLease();
    if (!lease) {
      provider.apiKey = "";
      queueMicrotask(() => emitFailure(runId, "PLAYER_WORKSPACE_REQUIRED", "需要先打开对应的小说工作区。", emit));
      return runId;
    }
    let prepared: PreparedPlayerTurn;
    const providerConfigSha256 = hashProvider(provider);
    try {
      prepared = lease.prepare(request);
      lease.audit.beginRun({ runId, playthroughId: prepared.playthroughId, playerActionSha256: canonicalAuditHash(prepared.playerAction),
        providerId: provider.providerId, requestedModelId: provider.modelId, providerConfigSha256 });
    } catch (cause) {
      lease.release(); provider.apiKey = "";
      const code = readCode(cause);
      queueMicrotask(() => emitFailure(runId, code, publicMessage(code), emit));
      return runId;
    }
    const child = (this.options.spawnWorker ?? spawnWorker)(this.workerPath);
    const run: ActivePlayerRun = { child, lease, prepared, provider, providerConfigSha256, emit };
    this.#runs.set(runId, run);
    child.on("message", (payload) => this.handleMessage(runId, payload));
    child.once("error", () => this.interrupt(runId));
    child.once("exit", () => this.interrupt(runId));
    child.once("spawn", () => {
      const command = playerWorkerTurnStartCommandSchema.parse({ type: "play.start", runId, ...prepared, providerProfile: provider });
      try { if (!child.send(command)) this.interrupt(runId); } catch { this.interrupt(runId); }
    });
    return runId;
  }

  cancel(runId: string): void {
    const run = this.#runs.get(runId); if (!run) return;
    try { run.lease.audit.terminalizeOpenRun(runId, "cancelled", "AGENT_RUN_CANCELLED"); } catch { /* still terminate */ }
    emitFailure(runId, "AGENT_RUN_CANCELLED", "玩家回合已取消。", run.emit);
    try { run.child.send(agentWorkerRunCancelCommandSchema.parse({ type: "run.cancel", runId })); } catch { /* cleanup below */ }
    this.finish(runId, false);
    const timer = setTimeout(() => { if (!run.child.killed) run.child.kill(); }, this.options.cancelGraceMs ?? 1_000);
    timer.unref?.();
  }

  dispose(): void { for (const runId of [...this.#runs.keys()]) this.interrupt(runId); }

  private handleMessage(runId: string, payload: unknown): void {
    const run = this.#runs.get(runId); if (!run) return;
    const audit = agentWorkerAuditRequestSchema.safeParse(payload);
    if (audit.success) {
      if (audit.data.runId !== runId) return this.interrupt(runId);
      this.handleAudit(runId, run, audit.data);
      return;
    }
    const event = playerWorkerEventSchema.safeParse(payload);
    if (!event.success || event.data.runId !== runId) return this.interrupt(runId);
    if (event.data.type === "play.started") {
      run.emit(playerTurnEventSchema.parse({ type: "started", runId }));
      return;
    }
    if (event.data.type === "play.failed") {
      try { run.lease.audit.terminalizeOpenRun(runId, event.data.error.code === "GM_RESOLUTION_BLOCKED" ? "blocked" : "failed", event.data.error.code); } catch { /* public failure remains fail-closed */ }
      emitFailure(runId, event.data.error.code, event.data.error.message, run.emit);
      this.finish(runId);
      return;
    }
    try {
      const turn = run.lease.commit.commit({ runId, prepared: run.prepared, result: event.data.result });
      run.emit(playerTurnEventSchema.parse({ type: "completed", runId, turn: publicTurn(turn) }));
      this.finish(runId);
    } catch (cause) {
      const code = readCode(cause);
      try { run.lease.audit.terminalizeOpenRun(runId, "failed", code); } catch { /* already failed closed */ }
      emitFailure(runId, code, publicMessage(code), run.emit);
      this.finish(runId);
    }
  }

  private handleAudit(runId: string, run: ActivePlayerRun, request: ReturnType<typeof agentWorkerAuditRequestSchema.parse>): void {
    try {
      const operation = request.operation;
      if (operation.type === "invocation.started") {
        validateInvocation(runId, run, operation, this.options.loadGmPrompt ?? loadGmPrompt);
        run.lease.audit.beginInvocation({
          invocationId: operation.invocationId, runId, parentInvocationId: operation.parentInvocationId, role: operation.role as "gm" | "writer" | "checker",
          prompt: operation.prompt, profile: operation.profile, provider: operation.provider, handoff: operation.handoff, inputSha256: operation.inputSha256,
        });
        if (operation.role === "gm") run.lease.audit.linkEvidence({ runId, invocationId: operation.invocationId,
          evidence: [...run.prepared.evidence, ...run.prepared.styleConstraints].map((item) => ({ id: item.id, sha256: item.sha256 })) });
      } else if (operation.type === "invocation.terminal") {
        run.lease.audit.appendInvocationTerminal({ runId, invocationId: operation.invocationId, eventType: operation.eventType as "completed" | "blocked" | "failed" | "cancelled" | "interrupted",
          errorCode: operation.errorCode, receipt: operation.receipt, structuredSubmissionCount: operation.structuredSubmissionCount, outputSha256: operation.outputSha256 });
      } else if (operation.type === "local_tool.started") {
        run.lease.audit.beginTool({ runId, invocationId: operation.invocationId, toolInvocationId: operation.toolInvocationId, toolName: operation.toolName, argumentsSha256: operation.argumentsSha256 });
      } else if (operation.type === "safe_diagnostic.append") {
        throw new Error("Safe diagnostic operations are not authorized on the Player audit boundary.");
      } else {
        run.lease.audit.appendToolTerminal({ runId, invocationId: operation.invocationId, toolInvocationId: operation.toolInvocationId,
          eventType: operation.eventType, errorCode: operation.errorCode, resultSha256: operation.resultSha256 });
      }
      this.sendAuditResponse(run, { type: "audit.response", runId, auditRequestId: request.auditRequestId, ok: true });
    } catch {
      this.sendAuditResponse(run, { type: "audit.response", runId, auditRequestId: request.auditRequestId, ok: false,
        error: { code: "AGENT_AUDIT_REQUIRED", message: "Player audit operation was rejected." } });
    }
  }

  private sendAuditResponse(run: ActivePlayerRun, value: unknown): void {
    const response = agentWorkerAuditResponseSchema.parse(value);
    try { if (!run.child.send(response)) this.interruptByRun(run); } catch { this.interruptByRun(run); }
  }

  private interrupt(runId: string): void {
    const run = this.#runs.get(runId); if (!run) return;
    try { run.lease.audit.terminalizeOpenRun(runId, "interrupted", "AGENT_WORKER_INTERRUPTED"); } catch { /* report interruption */ }
    emitFailure(runId, "AGENT_WORKER_INTERRUPTED", "玩家工作进程已中断，本回合未写入存档。", run.emit);
    this.finish(runId);
  }

  private interruptByRun(run: ActivePlayerRun): void {
    for (const [runId, candidate] of this.#runs) if (candidate === run) return this.interrupt(runId);
  }

  private finish(runId: string, kill = true): void {
    const run = this.#runs.get(runId); if (!run) return;
    this.#runs.delete(runId);
    if (kill && !run.child.killed) run.child.kill();
    run.provider.apiKey = "";
    run.lease.release();
  }

  private readProvider(): ProviderRuntimeProfile | null {
    try { const parsed = providerRuntimeProfileSchema.safeParse(this.options.getProviderProfile()); return parsed.success ? parsed.data : null; } catch { return null; }
  }
}

function validateInvocation(runId: string, run: ActivePlayerRun,
  operation: Extract<ReturnType<typeof agentWorkerAuditRequestSchema.parse>["operation"], { type: "invocation.started" }>,
  loadPlayerPrompt: () => PlayPrompt): void {
  if (operation.role === "steward") throw new Error("Steward is not authorized in Player runtime.");
  if (canonicalAuditHash(operation.profile) !== canonicalAuditHash(getAgentRuntimeProfile(operation.role))) throw new Error("Profile mismatch.");
  if (operation.provider.providerId !== run.provider.providerId || operation.provider.requestedModelId !== run.provider.modelId
    || operation.provider.providerConfigSha256 !== run.providerConfigSha256) throw new Error("Provider mismatch.");
  if (operation.role === "gm") {
    const prompt = loadPlayerPrompt();
    if (prompt.status !== "active" || !prompt.publicationEvidence || operation.prompt.id !== prompt.id
      || operation.prompt.version !== prompt.version || operation.prompt.sha256 !== prompt.sha256
      || operation.invocationId !== `${runId}:gm` || operation.parentInvocationId !== null || operation.handoff !== null) throw new Error("GM identity mismatch.");
    return;
  }
  const prompt = promptManifest.find((item) => item.role === operation.role && item.id === operation.prompt.id
    && item.version === operation.prompt.version && item.publishedSha256 === operation.prompt.sha256 && item.status === "active");
  if (!prompt || operation.parentInvocationId !== `${runId}:gm` || operation.handoff?.contractId !== `novax.${operation.role}-handoff`) throw new Error("Specialist identity mismatch.");
}

function publicTurn(turn: PlayTurnRecord) {
  if (!turn.stateSnapshot || typeof turn.stateSnapshot !== "object" || Array.isArray(turn.stateSnapshot)) throw new Error("Invalid public state.");
  return { id: turn.id, playthroughId: turn.playthroughId, sequence: turn.sequence, writerText: turn.writerText,
    stateSnapshot: turn.stateSnapshot, createdAt: turn.createdAt };
}
function hashProvider(profile: ProviderRuntimeProfile) { const { apiKey: _key, ...safe } = profile; return canonicalAuditHash(safe); }
function readCode(cause: unknown) { return cause && typeof cause === "object" && "code" in cause ? String(cause.code).slice(0, 120) : "PLAYER_RUN_FAILED"; }
function publicMessage(code: string) { const messages: Record<string, string> = {
  PLAYTHROUGH_RECONCILIATION_REQUIRED: "正史已发生变化，请先选择继续旧存档或从当前正史创建新分支。",
  PLAYER_CONTEXT_INCOMPLETE: "固定正史资料超过安全检索范围，本回合未运行。",
  PLAYER_STYLE_CONTEXT_INCOMPLETE: "写作约束超过安全范围，本回合未运行。",
  GM_EVIDENCE_REQUIRED: "当前故事缺少可验证的正史资料。",
  PLAYER_AUDIT_INCOMPLETE: "玩家运行审计不完整，本回合未写入存档。",
}; return messages[code] ?? "玩家回合失败，存档未发生变化。"; }
function emitFailure(runId: string, code: string, message: string, emit: (event: PlayerTurnEvent) => void) { emit(playerTurnEventSchema.parse({ type: "failed", runId, error: { code, message } })); }
function spawnWorker(workerPath: string): AgentWorkerProcess { return fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, NOVAX_AGENT_WORKER: "1" } }) as AgentWorkerProcess; }
