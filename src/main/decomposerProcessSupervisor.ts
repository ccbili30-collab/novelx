import { fork } from "node:child_process";
import type { DecomposerPrompt } from "../agent-worker/import/decomposerPromptRegistry";
import { requireActiveDecomposerPrompt } from "../agent-worker/import/decomposerPromptRegistry";
import type { DecomposerRunService, PreparedDecomposerRun } from "../domain/import/decomposerRunService";
import { decomposerWorkerEventSchema, decomposerWorkerStartSchema, type DecomposerWorkerEvent } from "../shared/decomposerWorkerProtocol";
import { agentWorkerRunCancelCommandSchema } from "../shared/agentWorkerProtocol";
import { providerRuntimeProfileSchema, type ProviderRuntimeProfile } from "../shared/providerContract";
import type { AgentWorkerProcess } from "./agentProcessSupervisor";
import { createAgentWorkerEnvironment } from "./agentProcessSupervisor";

export interface DecomposerRuntimeLease { service: DecomposerRunService; release(): void }
interface ActiveRun { child: AgentWorkerProcess; lease: DecomposerRuntimeLease; prepared: PreparedDecomposerRun; provider: ProviderRuntimeProfile; emit(event: DecomposerWorkerEvent): void }

export class DecomposerProcessSupervisor {
  readonly #runs = new Map<string, ActiveRun>();
  constructor(readonly workerPath: string, readonly options: {
    acquireRuntimeLease(): DecomposerRuntimeLease | null; getProviderProfile(): ProviderRuntimeProfile | null;
    loadPrompt?(): DecomposerPrompt; spawnWorker?(path: string): AgentWorkerProcess; cancelGraceMs?: number;
  }) {}

  start(sourceId: string, emit: (event: DecomposerWorkerEvent) => void): string | null {
    const provider = this.readProvider(); const lease = this.options.acquireRuntimeLease();
    if (!provider || !lease) { provider && (provider.apiKey = ""); lease?.release(); return null; }
    let prepared: PreparedDecomposerRun;
    try { prepared = lease.service.prepare({ sourceId, provider, prompt: (this.options.loadPrompt ?? requireActiveDecomposerPrompt)() }); }
    catch { provider.apiKey = ""; lease.release(); return null; }
    const child = (this.options.spawnWorker ?? spawnWorker)(this.workerPath);
    const run = { child, lease, prepared, provider, emit }; this.#runs.set(prepared.runId, run);
    child.on("message", (payload) => this.handle(prepared.runId, payload));
    child.once("error", () => this.interrupt(prepared.runId)); child.once("exit", () => this.interrupt(prepared.runId));
    child.once("spawn", () => {
      const command = decomposerWorkerStartSchema.parse({ type: "decompose.start", runId: prepared.runId, sourceId, chunks: prepared.chunks, providerProfile: provider });
      try { if (!child.send(command)) this.interrupt(prepared.runId); } catch { this.interrupt(prepared.runId); }
    });
    return prepared.runId;
  }

  cancel(runId: string): void {
    const run = this.#runs.get(runId); if (!run) return;
    try { run.lease.service.fail(runId, "cancelled", "AGENT_RUN_CANCELLED"); } catch { /* already terminal */ }
    try { run.child.send(agentWorkerRunCancelCommandSchema.parse({ type: "run.cancel", runId })); } catch { /* terminate below */ }
    run.emit(decomposerWorkerEventSchema.parse({ type: "decompose.failed", runId, error: { code: "AGENT_RUN_CANCELLED", message: "拆解任务已取消。" } }));
    this.finish(runId, false); const timer = setTimeout(() => { if (!run.child.killed) run.child.kill(); }, this.options.cancelGraceMs ?? 1_000); timer.unref?.();
  }

  dispose(): void { for (const id of [...this.#runs.keys()]) this.interrupt(id); }

  private handle(runId: string, payload: unknown): void {
    const run = this.#runs.get(runId); if (!run) return; const event = decomposerWorkerEventSchema.safeParse(payload);
    if (!event.success || event.data.runId !== runId) return this.interrupt(runId);
    if (event.data.type === "decompose.started") { run.emit(event.data); return; }
    try {
      if (event.data.type === "decompose.completed") run.lease.service.complete({ runId, output: event.data.output, receipt: event.data.receipt });
      else run.lease.service.fail(runId, "failed", event.data.error.code);
      run.emit(event.data); this.finish(runId);
    } catch { this.interrupt(runId); }
  }

  private interrupt(runId: string): void {
    const run = this.#runs.get(runId); if (!run) return;
    try { run.lease.service.fail(runId, "interrupted", "AGENT_WORKER_INTERRUPTED"); } catch { /* preserve first terminal */ }
    run.emit(decomposerWorkerEventSchema.parse({ type: "decompose.failed", runId, error: { code: "AGENT_WORKER_INTERRUPTED", message: "拆解工作进程中断，未写入候选。" } }));
    this.finish(runId);
  }

  private finish(runId: string, kill = true): void { const run = this.#runs.get(runId); if (!run) return; this.#runs.delete(runId); if (kill && !run.child.killed) run.child.kill(); run.provider.apiKey = ""; run.lease.release(); }
  private readProvider(): ProviderRuntimeProfile | null { const parsed = providerRuntimeProfileSchema.safeParse(this.options.getProviderProfile()); return parsed.success ? parsed.data : null; }
}

function spawnWorker(workerPath: string): AgentWorkerProcess { return fork(workerPath, [], { env: createAgentWorkerEnvironment(process.env), stdio: ["ignore", "ignore", "ignore", "ipc"] }) as AgentWorkerProcess; }
