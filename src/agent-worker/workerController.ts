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
      providerProfile,
      prompt: stewardPrompt,
      adapter,
      tools: [...tools, ...specialistTools],
      resultCapture: capture,
      audit,
      signal,
      onEvent: (projected) => {
        if (projected.type === "text.delta") return;
        if (projected.tool === "retrieve_graph_evidence" || projected.tool === "propose_change_set") return;
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
      artifacts: projectPublicArtifacts(runtimeResult.output, runtimeResult.retrievedDocuments),
    });
  } catch (cause) {
    emitFailure(command.runId, cause, emit);
  }
}

export function projectPublicArtifacts(
  output: StewardOutput,
  retrievedDocuments: Array<{ documentId: string; title: string; versionId: string; content: string }> = [],
): AgentArtifact[] {
  const toolLabels: Record<StewardOutput["toolOutcomes"][number]["tool"], string> = {
    retrieve_graph_evidence: "检索图谱与稳定资料",
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
  emit({ type: "run.failed", runId, ...error });
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(new Error("Agent worker contract failed."), { code });
}
