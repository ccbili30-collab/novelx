import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentArtifact, AgentRunEvent } from "../shared/ipcContract";
import type { StewardOutput } from "./contracts/roleOutputs";
import type { AgentWorkerAuditOperation, AgentWorkerRunStartCommand } from "../shared/agentWorkerProtocol";
import { toPublicError } from "../shared/publicErrors";
import { createRoleOutputTool, type RoleOutputToolCapture } from "./contracts/roleOutputTool";
import { createOpenAiCompatiblePiAdapter } from "./pi/NovaxPiRuntimeAdapter";
import type { RuntimeAdapter } from "./pi/runtimeAdapterContract";
import { loadActivePromptSet, requireActivePrompt, type PublishedPrompt } from "./promptRegistry";
import { runStewardRuntime } from "./stewardRuntime";
import { createSpecialistTools } from "./tools/createSpecialistTools";

export interface WorkerControllerDependencies {
  loadPromptSet(): PublishedPrompt[];
  createAdapter(profile: NonNullable<AgentWorkerRunStartCommand["providerProfile"]>): RuntimeAdapter;
  createResultTool(): RoleOutputToolCapture;
}

interface WorkerControllerInput {
  command: AgentWorkerRunStartCommand;
  tools: AgentTool[] | null;
  signal?: AbortSignal;
  audit: {
    record(runId: string, operation: AgentWorkerAuditOperation, signal?: AbortSignal): Promise<void>;
  };
  emit(event: AgentRunEvent): void;
}

const defaultDependencies: WorkerControllerDependencies = {
  loadPromptSet: loadActivePromptSet,
  createAdapter: (profile) => createOpenAiCompatiblePiAdapter(profile),
  createResultTool: () => createRoleOutputTool("steward"),
};

export async function handleAgentWorkerCommand(
  input: WorkerControllerInput,
  dependencies: WorkerControllerDependencies = defaultDependencies,
): Promise<void> {
  const { command, tools, signal, audit, emit } = input;
  const providerProfile = command.providerProfile;
  emit({ type: "run.started", runId: command.runId });

  if (!providerProfile) {
    emitFailure(command.runId, { code: "REAL_GM_PROVIDER_REQUIRED" }, emit);
    return;
  }

  if (!command.toolsAvailable || !tools) {
    emitFailure(command.runId, { code: "AGENT_TOOLS_REQUIRED" }, emit);
    return;
  }

  try {
    const prompts = dependencies.loadPromptSet();
    const stewardPrompt = requireActivePrompt(prompts, "steward");
    if (signal?.aborted) throw workerError("AGENT_RUN_CANCELLED");

    const capture = dependencies.createResultTool();
    const adapter = dependencies.createAdapter(providerProfile);
    const specialistTools = createSpecialistTools({
      runId: command.runId,
      parentInvocationId: `${command.runId}:steward`,
      providerProfile,
      prompts,
      createAdapter: dependencies.createAdapter,
      audit,
    });
    const runtimeResult = await runStewardRuntime({
      runId: command.runId,
      userInput: command.userInput,
      sessionHistory: command.sessionHistory ?? {
        entries: [],
        completeness: { incomplete: false, omittedMessages: 0 },
      },
      collaborationContext: command.collaborationContext ?? { sharedMemories: [], handoffs: [] },
      mode: command.mode,
      scopeResourceIds: [...new Set([
        ...(command.scopeResourceIds ?? []),
        ...(command.collaborationContext?.handoffs ?? []).flatMap((handoff) => handoff.scopeResourceIds),
      ])],
      growthBinding: command.growthBinding,
      providerProfile,
      prompt: stewardPrompt,
      adapter,
      tools: [...tools, ...specialistTools],
      resultCapture: capture,
      audit,
      signal,
      onEvent: (projected) => {
        if (projected.type === "text.delta") return;
        if ([
          "retrieve_graph_evidence", "inspect_project_files", "list_project_directory", "stat_project_file",
          "glob_project_files", "search_project_files", "read_project_file", "save_task_note", "list_task_notes", "generate_image", "propose_change_set",
        ].includes(projected.tool)) return;
        emit({
          type: "run.activity",
          runId: command.runId,
          label: projected.label,
          phase: projected.type === "tool.started"
            ? "started"
            : projected.type === "tool.completed"
              ? "completed"
              : "failed",
          domains: domainsForLocalTool(projected.tool),
        });
      },
    });
    emit({
      type: "run.completed",
      runId: command.runId,
      outcome: runtimeResult.output.status,
      message: projectPublicMessage(runtimeResult.output),
      changeSetState: runtimeResult.output.changeSet.state,
      artifacts: projectPublicArtifacts(
        runtimeResult.output,
        runtimeResult.retrievedDocuments,
        runtimeResult.inspectedFiles,
        runtimeResult.generatedImages,
      ),
    });
  } catch (cause) {
    emitFailure(command.runId, cause, emit);
  }
}

export function projectPublicArtifacts(
  output: StewardOutput,
  retrievedDocuments: Array<{ documentId: string; title: string; versionId: string; content: string }> = [],
  inspectedFiles: Array<{ path: string; sha256: string; kind: "text" | "binary"; complete: boolean }> = [],
  generatedImages: Array<{
    assetId: string;
    title: string;
    status: "ready";
    purpose: "character_portrait" | "scene" | "world_map";
    sourceVersionIds: string[];
    thumbnailUrl: string;
  }> = [],
): AgentArtifact[] {
  const toolLabels: Record<StewardOutput["toolOutcomes"][number]["tool"], string> = {
    retrieve_graph_evidence: "检索图谱与稳定资料",
    inspect_project_files: "检查项目文件",
    list_project_directory: "列出项目目录",
    stat_project_file: "查看文件信息",
    glob_project_files: "匹配项目文件",
    search_project_files: "搜索项目内容",
    read_project_file: "读取项目文件",
    save_task_note: "保存任务笔记",
    list_task_notes: "读取任务笔记",
    generate_image: "生成角色或场景图片",
    propose_change_set: "生成变更集",
    writer: "写手处理",
    checker: "一致性检查",
  };
  const artifacts: AgentArtifact[] = output.toolOutcomes.map((toolOutcome) => ({
    kind: "tool_call",
    tool: toolOutcome.tool,
    label: toolLabels[toolOutcome.tool],
    status: toolOutcome.status,
  }));
  if (output.changeSet.state !== "none" && output.changeSet.changeSetId) {
    artifacts.push({
      kind: "change_set",
      changeSetId: output.changeSet.changeSetId,
      state: output.changeSet.state,
    });
  }
  artifacts.push(...output.escalations.map((escalation): AgentArtifact => ({
    kind: "conflict",
    code: escalation.code,
    message: escalation.message,
    evidenceIds: escalation.evidenceIds,
  })));
  const citedEvidence = new Set(output.evidenceIds);
  const citedDocuments = new Map<string, (typeof retrievedDocuments)[number]>();
  for (const document of retrievedDocuments) {
    if (citedEvidence.has(document.versionId)) citedDocuments.set(`${document.documentId}:${document.versionId}`, document);
  }
  artifacts.push(...[...citedDocuments.values()].map((document): AgentArtifact => ({
    kind: "document_reference",
    documentId: document.documentId,
    title: document.title,
    versionId: document.versionId,
    locator: {
      kind: "line",
      start: 1,
      end: Math.max(1, Math.min(3, document.content.split("\n").length)),
    },
    excerpt: document.content.slice(0, 500) || null,
  })));
  artifacts.push(...inspectedFiles.map((file): AgentArtifact => ({
    kind: "activity",
    label: file.path,
    status: "succeeded",
    detail: file.kind === "binary"
      ? "已读取文件元数据。"
      : file.complete ? "已读取完整文本。" : "已读取文本片段。",
  })));
  artifacts.push(...generatedImages.map((image): AgentArtifact => ({
    kind: "image",
    assetId: image.assetId,
    title: image.title,
    status: image.status,
    purpose: image.purpose === "character_portrait" ? "角色立绘" : "故事场景",
    sourceLabel: `基于 ${image.sourceVersionIds.length} 个稳定版本`,
    thumbnailUrl: image.thumbnailUrl,
  })));
  return artifacts;
}

function domainsForLocalTool(tool: string): Array<"world" | "oc" | "story" | "graph" | "timeline" | "asset"> | undefined {
  if (tool === "writer") return ["story"];
  if (tool === "checker") return ["world", "oc", "story", "graph", "timeline"];
  return undefined;
}

function projectPublicMessage(output: Awaited<ReturnType<typeof runStewardRuntime>>["output"]): string {
  const message = output.message.trim();
  const forbidden = /(?:[a-z]:\\|workspace\.db|api[_ -]?key\s*[:=]|raw.?json|tool.?args|thinking|\b(?:change-set|checkpoint|branch|resource|source)-[a-z0-9_-]+\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b)/i;
  if (message && !forbidden.test(message)) return message;
  if (output.status === "awaiting_confirmation" && output.changeSet.state === "pending_review") {
    return "候选变更已生成，正在等待你的确认。";
  }
  if (output.status === "completed") {
    return output.changeSet.state === "committed" ? "变更已完成并保存。" : "任务已完成。";
  }
  if (output.status === "blocked") return "任务已安全阻止，请处理待确认的问题后继续。";
  throw workerError("PROVIDER_PROTOCOL_FAILED");
}

function emitFailure(runId: string, cause: unknown, emit: (event: AgentRunEvent) => void): void {
  const error = toPublicError(cause);
  emit({ type: "run.failed", runId, ...error, artifacts: projectFailureArtifacts(cause, error.message) });
}

function projectFailureArtifacts(cause: unknown, message: string): AgentArtifact[] {
  const outcomes = cause && typeof cause === "object" && "publicToolOutcomes" in cause
    ? cause.publicToolOutcomes
    : [];
  const tools = Array.isArray(outcomes) ? outcomes.flatMap((value): AgentArtifact[] => {
    if (!value || typeof value !== "object" || !("tool" in value) || !("status" in value)) return [];
    const tool = value.tool;
    const status = value.status;
    if (!(["retrieve_graph_evidence", "inspect_project_files", "list_project_directory", "stat_project_file", "glob_project_files", "search_project_files", "read_project_file", "save_task_note", "list_task_notes", "generate_image", "propose_change_set", "writer", "checker"] as const).includes(tool as never)) return [];
    if (status !== "succeeded" && status !== "failed") return [];
    const labels = {
      retrieve_graph_evidence: "检索项目资料",
      inspect_project_files: "检查项目文件",
      list_project_directory: "列出项目目录",
      stat_project_file: "查看文件信息",
      glob_project_files: "匹配项目文件",
      search_project_files: "搜索项目内容",
      read_project_file: "读取项目文件",
      save_task_note: "保存任务笔记",
      list_task_notes: "读取任务笔记",
      generate_image: "生成角色或场景图片",
      propose_change_set: "生成候选变更",
      writer: "写手处理",
      checker: "一致性检查",
    } as const;
    return [{ kind: "tool_call", tool: tool as keyof typeof labels, label: labels[tool as keyof typeof labels], status }];
  }) : [];
  return [...tools, { kind: "activity", label: "生成回复", status: "failed", detail: message }];
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(new Error("Agent worker contract failed."), { code });
}
