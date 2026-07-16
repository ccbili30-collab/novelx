import {
  agentWorkerRunCancelCommandSchema,
  agentWorkerRunStartCommandSchema,
  type GrowthRetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceArgs,
  type SubmitGrowthInquiryArgs,
} from "../shared/agentWorkerProtocol";
import { verifyPromptRegistry } from "./promptRegistry";
import { playerWorkerTurnStartCommandSchema } from "../shared/playerWorkerProtocol";
import { AgentWorkerAuditBridge } from "./audit/agentWorkerAuditBridge";
import { AgentWorkerToolBridge } from "./tools/agentWorkerToolBridge";
import { createAgentTools } from "./tools/createAgentTools";
import { handleAgentWorkerCommand } from "./workerController";
import { handlePlayerWorkerCommand } from "./play/playerWorkerController";
import { loadGmPrompt } from "./play/playPromptRegistry";
import { decomposerWorkerStartSchema } from "../shared/decomposerWorkerProtocol";
import { handleDecomposerWorkerCommand } from "./import/decomposerWorkerController";

verifyPromptRegistry();
loadGmPrompt();

const toolBridge = new AgentWorkerToolBridge((message) => process.send?.(message) ?? false);
const auditBridge = new AgentWorkerAuditBridge((message) => process.send?.(message) ?? false);
const activeRuns = new Map<string, AbortController>();

process.on("message", (payload: unknown) => {
  if (isRuntimeSelfTest(payload)) {
    void runRuntimeSelfTest();
    return;
  }
  if (auditBridge.handleResponse(payload)) return;
  if (toolBridge.handleResponse(payload)) return;

  const cancel = agentWorkerRunCancelCommandSchema.safeParse(payload);
  if (cancel.success) {
    activeRuns.get(cancel.data.runId)?.abort();
    auditBridge.cancelRun(cancel.data.runId);
    toolBridge.cancelRun(cancel.data.runId);
    return;
  }

  const start = agentWorkerRunStartCommandSchema.safeParse(payload);
  if (!start.success) {
    const decomposerStart = decomposerWorkerStartSchema.safeParse(payload);
    if (decomposerStart.success) {
      const command = decomposerStart.data;
      if (activeRuns.has(command.runId)) return;
      const controller = new AbortController(); activeRuns.set(command.runId, controller);
      void handleDecomposerWorkerCommand({ command, signal: controller.signal, emit: (event) => process.send?.(event) }).finally(() => {
        activeRuns.delete(command.runId); clearProviderProfile(command.providerProfile);
      });
      return;
    }
    const playerStart = playerWorkerTurnStartCommandSchema.safeParse(payload);
    if (!playerStart.success) return;
    const command = playerStart.data;
    if (activeRuns.has(command.runId)) return;
    const controller = new AbortController();
    activeRuns.set(command.runId, controller);
    void handlePlayerWorkerCommand({
      command,
      signal: controller.signal,
      audit: auditBridge,
      emit: (event) => process.send?.(event),
    }).finally(() => {
      activeRuns.delete(command.runId);
      clearProviderProfile(command.providerProfile);
    });
    return;
  }
  const command = start.data;
  if (activeRuns.has(command.runId)) return;
  const controller = new AbortController();
  activeRuns.set(command.runId, controller);
  const tools = command.toolsAvailable && process.send
    ? createAgentTools({
        retrieveGraphEvidence: (args, signal) => command.growthBinding
          ? toolBridge.invoke(command.runId, "retrieve_graph_evidence", args as GrowthRetrieveGraphEvidenceArgs, signal)
          : toolBridge.invoke(command.runId, "retrieve_graph_evidence", args as RetrieveGraphEvidenceArgs, signal),
        submitGrowthInquiry: (args, signal) => toolBridge.invoke(
          command.runId,
          "submit_growth_inquiry",
          args as SubmitGrowthInquiryArgs,
          signal,
        ),
        inspectProjectFiles: (args, signal) => toolBridge.invoke(
          command.runId,
          "inspect_project_files",
          args,
          signal,
        ),
        listProjectDirectory: (args, signal) => toolBridge.invoke(command.runId, "list_project_directory", args, signal),
        statProjectFile: (args, signal) => toolBridge.invoke(command.runId, "stat_project_file", args, signal),
        globProjectFiles: (args, signal) => toolBridge.invoke(command.runId, "glob_project_files", args, signal),
        searchProjectFiles: (args, signal) => toolBridge.invoke(command.runId, "search_project_files", args, signal),
        readProjectFile: (args, signal) => toolBridge.invoke(command.runId, "read_project_file", args, signal),
        saveTaskNote: (args, signal) => toolBridge.invoke(command.runId, "save_task_note", args, signal),
        listTaskNotes: (args, signal) => toolBridge.invoke(command.runId, "list_task_notes", args, signal),
        generateImage: (args, signal) => toolBridge.invoke(command.runId, "generate_image", args, signal),
        proposeChangeSet: (args, signal) => toolBridge.invoke(
          command.runId,
          "propose_change_set",
          args,
          signal,
        ),
      }, { growthBinding: command.growthBinding })
    : null;
  void handleAgentWorkerCommand({
    command,
    tools,
    signal: controller.signal,
    audit: auditBridge,
    emit: (event) => process.send?.(event),
  }).finally(() => {
    activeRuns.delete(command.runId);
    clearProviderProfile(command.providerProfile);
  });
});

process.once("disconnect", dispose);
process.once("beforeExit", dispose);

function dispose(): void {
  for (const controller of activeRuns.values()) controller.abort();
  activeRuns.clear();
  toolBridge.dispose();
  auditBridge.dispose();
}

function isRuntimeSelfTest(value: unknown): value is { type: "runtime.self-test" } {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "runtime.self-test");
}

async function runRuntimeSelfTest(): Promise<void> {
  await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-agent-core"),
    import("@earendil-works/pi-ai/api/openai-completions.lazy"),
  ]);
  process.send?.({ type: "runtime.ready", piLoaded: true, promptRegistryVerified: true });
}

function clearProviderProfile(profile: { apiKey: string } | null): void {
  if (profile) profile.apiKey = "";
}
