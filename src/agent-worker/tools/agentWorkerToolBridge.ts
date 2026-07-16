import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentWorkerToolRequestSchema,
  agentWorkerToolResponseSchema,
  inspectProjectFilesResultSchema,
  globProjectFilesResultSchema,
  listProjectDirectoryResultSchema,
  readProjectFileResultSchema,
  saveTaskNoteResultSchema,
  listTaskNotesResultSchema,
  searchProjectFilesResultSchema,
  statProjectFileResultSchema,
  proposeChangeSetResultSchema,
  retrieveGraphEvidenceResultSchema,
  growthRetrieveGraphEvidenceResultSchema,
  submitGrowthInquiryResultSchema,
  submitClosureSelfAssessmentResultSchema,
  submitClosureCheckerReviewResultSchema,
  generateImageResultSchema,
  type AgentToolName,
  type AgentWorkerToolRequest,
  type InspectProjectFilesArgs,
  type InspectProjectFilesResult,
  type GlobProjectFilesArgs, type GlobProjectFilesResult,
  type ListProjectDirectoryArgs, type ListProjectDirectoryResult,
  type ReadProjectFileArgs, type ReadProjectFileResult,
  type SaveTaskNoteArgs, type SaveTaskNoteResult,
  type ListTaskNotesArgs, type ListTaskNotesResult,
  type SearchProjectFilesArgs, type SearchProjectFilesResult,
  type StatProjectFileArgs, type StatProjectFileResult,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
  type RetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceResult,
  type GrowthRetrieveGraphEvidenceArgs,
  type GrowthRetrieveGraphEvidenceResult,
  type SubmitGrowthInquiryArgs,
  type SubmitGrowthInquiryResult,
  type SubmitClosureSelfAssessmentArgs, type SubmitClosureSelfAssessmentResult,
  type SubmitClosureCheckerReviewArgs, type SubmitClosureCheckerReviewResult,
  type GenerateImageArgs,
  type GenerateImageResult,
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
  readonly #imageTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(send: SendToMain, timeoutMs = 20_000, imageTimeoutMs = 310_000) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
    this.#imageTimeoutMs = imageTimeoutMs;
  }

  invoke(
    runId: string,
    tool: "retrieve_graph_evidence",
    args: RetrieveGraphEvidenceArgs,
    signal?: AbortSignal,
  ): Promise<RetrieveGraphEvidenceResult>;
  invoke(
    runId: string,
    tool: "retrieve_graph_evidence",
    args: GrowthRetrieveGraphEvidenceArgs,
    signal?: AbortSignal,
  ): Promise<GrowthRetrieveGraphEvidenceResult>;
  invoke(runId: string, tool: "submit_growth_inquiry", args: SubmitGrowthInquiryArgs, signal?: AbortSignal): Promise<SubmitGrowthInquiryResult>;
  invoke(runId: string, tool: "submit_closure_self_assessment", args: SubmitClosureSelfAssessmentArgs, signal?: AbortSignal): Promise<SubmitClosureSelfAssessmentResult>;
  invoke(runId: string, tool: "submit_closure_checker_review", args: SubmitClosureCheckerReviewArgs, signal?: AbortSignal): Promise<SubmitClosureCheckerReviewResult>;
  invoke(
    runId: string,
    tool: "inspect_project_files",
    args: InspectProjectFilesArgs,
    signal?: AbortSignal,
  ): Promise<InspectProjectFilesResult>;
  invoke(runId: string, tool: "list_project_directory", args: ListProjectDirectoryArgs, signal?: AbortSignal): Promise<ListProjectDirectoryResult>;
  invoke(runId: string, tool: "stat_project_file", args: StatProjectFileArgs, signal?: AbortSignal): Promise<StatProjectFileResult>;
  invoke(runId: string, tool: "glob_project_files", args: GlobProjectFilesArgs, signal?: AbortSignal): Promise<GlobProjectFilesResult>;
  invoke(runId: string, tool: "search_project_files", args: SearchProjectFilesArgs, signal?: AbortSignal): Promise<SearchProjectFilesResult>;
  invoke(runId: string, tool: "read_project_file", args: ReadProjectFileArgs, signal?: AbortSignal): Promise<ReadProjectFileResult>;
  invoke(runId: string, tool: "save_task_note", args: SaveTaskNoteArgs, signal?: AbortSignal): Promise<SaveTaskNoteResult>;
  invoke(runId: string, tool: "list_task_notes", args: ListTaskNotesArgs, signal?: AbortSignal): Promise<ListTaskNotesResult>;
  invoke(
    runId: string,
    tool: "propose_change_set",
    args: ProposeChangeSetArgs,
    signal?: AbortSignal,
  ): Promise<ProposeChangeSetResult>;
  invoke(runId: string, tool: "generate_image", args: GenerateImageArgs, signal?: AbortSignal): Promise<GenerateImageResult>;
  invoke(
    runId: string,
    tool: AgentToolName,
    args: RetrieveGraphEvidenceArgs | GrowthRetrieveGraphEvidenceArgs | SubmitGrowthInquiryArgs | SubmitClosureSelfAssessmentArgs | SubmitClosureCheckerReviewArgs | InspectProjectFilesArgs | ListProjectDirectoryArgs | StatProjectFileArgs | GlobProjectFilesArgs | SearchProjectFilesArgs | ReadProjectFileArgs | SaveTaskNoteArgs | ListTaskNotesArgs | ProposeChangeSetArgs | GenerateImageArgs,
    signal?: AbortSignal,
  ): Promise<RetrieveGraphEvidenceResult | GrowthRetrieveGraphEvidenceResult | SubmitGrowthInquiryResult | SubmitClosureSelfAssessmentResult | SubmitClosureCheckerReviewResult | InspectProjectFilesResult | ListProjectDirectoryResult | StatProjectFileResult | GlobProjectFilesResult | SearchProjectFilesResult | ReadProjectFileResult | SaveTaskNoteResult | ListTaskNotesResult | ProposeChangeSetResult | GenerateImageResult> {
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
      }, tool === "generate_image" ? this.#imageTimeoutMs : this.#timeoutMs);
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
    const resultSchema = response.tool === "retrieve_graph_evidence" ? z.union([retrieveGraphEvidenceResultSchema, growthRetrieveGraphEvidenceResultSchema])
      : response.tool === "submit_growth_inquiry" ? submitGrowthInquiryResultSchema
      : response.tool === "submit_closure_self_assessment" ? submitClosureSelfAssessmentResultSchema
      : response.tool === "submit_closure_checker_review" ? submitClosureCheckerReviewResultSchema
      : response.tool === "inspect_project_files" ? inspectProjectFilesResultSchema
        : response.tool === "list_project_directory" ? listProjectDirectoryResultSchema
          : response.tool === "stat_project_file" ? statProjectFileResultSchema
            : response.tool === "glob_project_files" ? globProjectFilesResultSchema
              : response.tool === "search_project_files" ? searchProjectFilesResultSchema
                : response.tool === "read_project_file" ? readProjectFileResultSchema
                  : response.tool === "save_task_note" ? saveTaskNoteResultSchema
                    : response.tool === "list_task_notes" ? listTaskNotesResultSchema
                      : response.tool === "generate_image" ? generateImageResultSchema
                        : proposeChangeSetResultSchema;
    const result = resultSchema.safeParse(response.result);
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
