import { randomUUID } from "node:crypto";
import {
  agentWorkerToolRequestSchema,
  agentWorkerToolResponseSchema,
  inspectProjectFilesResultSchema,
  proposeChangeSetResultSchema,
  retrieveGraphEvidenceResultSchema,
  type AgentToolName,
  type AgentWorkerToolRequest,
  type InspectProjectFilesArgs,
  type InspectProjectFilesResult,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
  type RetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceResult,
} from "../../shared/agentWorkerProtocol";

interface PendingRequest {
  runId: string;
  tool: AgentToolName;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort(): void;
}

type SendToMain = (message: AgentWorkerToolRequest) => boolean | void;

export class AgentWorkerToolBridge {
  readonly #send: SendToMain;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(send: SendToMain, timeoutMs = 20_000) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  invoke(
    runId: string,
    tool: "retrieve_graph_evidence",
    args: RetrieveGraphEvidenceArgs,
    signal?: AbortSignal,
  ): Promise<RetrieveGraphEvidenceResult>;
  invoke(
    runId: string,
    tool: "inspect_project_files",
    args: InspectProjectFilesArgs,
    signal?: AbortSignal,
  ): Promise<InspectProjectFilesResult>;
  invoke(
    runId: string,
    tool: "propose_change_set",
    args: ProposeChangeSetArgs,
    signal?: AbortSignal,
  ): Promise<ProposeChangeSetResult>;
  invoke(
    runId: string,
    tool: AgentToolName,
    args: RetrieveGraphEvidenceArgs | InspectProjectFilesArgs | ProposeChangeSetArgs,
    signal?: AbortSignal,
  ): Promise<RetrieveGraphEvidenceResult | InspectProjectFilesResult | ProposeChangeSetResult> {
    if (signal?.aborted) return Promise.reject(toolBridgeError("AGENT_RUN_CANCELLED", "Agent run was cancelled."));
    const request = agentWorkerToolRequestSchema.parse({
      type: "tool.request",
      runId,
      requestId: randomUUID(),
      tool,
      args,
    });

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.#settle(request.requestId, undefined, toolBridgeError("AGENT_RUN_CANCELLED", "Agent run was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        this.#settle(request.requestId, undefined, toolBridgeError("AGENT_TOOL_TIMEOUT", "Agent tool request timed out."));
      }, this.#timeoutMs);
      this.#pending.set(request.requestId, {
        runId,
        tool,
        resolve,
        reject,
        timer,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      });

      try {
        if (this.#send(request) === false) {
          this.#settle(request.requestId, undefined, toolBridgeError("AGENT_TOOL_FAILED", "Agent tool transport is unavailable."));
        }
      } catch {
        this.#settle(request.requestId, undefined, toolBridgeError("AGENT_TOOL_FAILED", "Agent tool transport is unavailable."));
      }
    });
  }

  handleResponse(payload: unknown): boolean {
    const parsed = agentWorkerToolResponseSchema.safeParse(payload);
    if (!parsed.success) return false;
    const response = parsed.data;
    const pending = this.#pending.get(response.requestId);
    if (!pending) return true;
    if (pending.runId !== response.runId) {
      this.#settle(response.requestId, undefined, toolBridgeError("AGENT_TOOL_PROTOCOL_FAILED", "Agent tool response run mismatch."));
      return true;
    }
    if (!response.ok) {
      this.#settle(response.requestId, undefined, toolBridgeError(response.error.code, response.error.message));
      return true;
    }
    if (pending.tool !== response.tool) {
      this.#settle(response.requestId, undefined, toolBridgeError("AGENT_TOOL_PROTOCOL_FAILED", "Agent tool response name mismatch."));
      return true;
    }
    const result = response.tool === "retrieve_graph_evidence"
      ? retrieveGraphEvidenceResultSchema.safeParse(response.result)
      : response.tool === "inspect_project_files"
        ? inspectProjectFilesResultSchema.safeParse(response.result)
        : proposeChangeSetResultSchema.safeParse(response.result);
    if (!result.success) {
      this.#settle(response.requestId, undefined, toolBridgeError("AGENT_TOOL_PROTOCOL_FAILED", "Agent tool response is invalid."));
      return true;
    }
    this.#settle(response.requestId, result.data);
    return true;
  }

  cancelRun(runId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.runId === runId) {
        this.#settle(requestId, undefined, toolBridgeError("AGENT_RUN_CANCELLED", "Agent run was cancelled."));
      }
    }
  }

  dispose(): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#settle(requestId, undefined, toolBridgeError("AGENT_TOOL_FAILED", "Agent tool transport closed."));
    }
  }

  #settle(requestId: string, value?: unknown, error?: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.detachAbort();
    if (error) pending.reject(error);
    else pending.resolve(value);
  }
}

function toolBridgeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
