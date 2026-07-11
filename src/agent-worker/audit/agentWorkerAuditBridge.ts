import { randomUUID } from "node:crypto";
import {
  agentWorkerAuditRequestSchema,
  agentWorkerAuditResponseSchema,
  type AgentWorkerAuditOperation,
  type AgentWorkerAuditRequest,
} from "../../shared/agentWorkerProtocol";

interface PendingAudit {
  runId: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort(): void;
}

type SendToMain = (message: AgentWorkerAuditRequest) => boolean | void;

export class AgentWorkerAuditBridge {
  readonly #pending = new Map<string, PendingAudit>();

  constructor(
    readonly send: SendToMain,
    readonly timeoutMs = 5_000,
  ) {}

  record(runId: string, operation: AgentWorkerAuditOperation, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(auditError("AGENT_RUN_CANCELLED"));
    const request = agentWorkerAuditRequestSchema.parse({
      type: "audit.request",
      runId,
      auditRequestId: randomUUID(),
      operation,
    });
    return new Promise((resolve, reject) => {
      const onAbort = (): void => this.#settle(request.auditRequestId, auditError("AGENT_RUN_CANCELLED"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => this.#settle(request.auditRequestId, auditError("AGENT_AUDIT_REQUIRED")), this.timeoutMs);
      this.#pending.set(request.auditRequestId, {
        runId,
        resolve,
        reject,
        timer,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      });
      try {
        if (this.send(request) === false) this.#settle(request.auditRequestId, auditError("AGENT_AUDIT_REQUIRED"));
      } catch {
        this.#settle(request.auditRequestId, auditError("AGENT_AUDIT_REQUIRED"));
      }
    });
  }

  handleResponse(payload: unknown): boolean {
    const parsed = agentWorkerAuditResponseSchema.safeParse(payload);
    if (!parsed.success) return false;
    const pending = this.#pending.get(parsed.data.auditRequestId);
    if (!pending) return true;
    if (pending.runId !== parsed.data.runId || !parsed.data.ok) {
      this.#settle(parsed.data.auditRequestId, auditError("AGENT_AUDIT_REQUIRED"));
      return true;
    }
    this.#settle(parsed.data.auditRequestId);
    return true;
  }

  cancelRun(runId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.runId === runId) this.#settle(requestId, auditError("AGENT_RUN_CANCELLED"));
    }
  }

  dispose(): void {
    for (const requestId of [...this.#pending.keys()]) this.#settle(requestId, auditError("AGENT_AUDIT_REQUIRED"));
  }

  #settle(requestId: string, error?: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.detachAbort();
    if (error) pending.reject(error);
    else pending.resolve();
  }
}

function auditError(code: "AGENT_AUDIT_REQUIRED" | "AGENT_RUN_CANCELLED"): Error & { code: string } {
  return Object.assign(new Error("Agent audit persistence is required."), { code });
}
