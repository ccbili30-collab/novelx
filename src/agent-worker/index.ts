import {
  agentWorkerRunCancelCommandSchema,
  agentWorkerRunStartCommandSchema,
} from "../shared/agentWorkerProtocol";
import { verifyPromptRegistry } from "./promptRegistry";
import { AgentWorkerAuditBridge } from "./audit/agentWorkerAuditBridge";
import { AgentWorkerToolBridge } from "./tools/agentWorkerToolBridge";
import { createAgentTools } from "./tools/createAgentTools";
import { handleAgentWorkerCommand } from "./workerController";

verifyPromptRegistry();

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
  if (!start.success) return;
  const command = start.data;
  if (activeRuns.has(command.runId)) return;
  const controller = new AbortController();
  activeRuns.set(command.runId, controller);
  const tools = command.toolsAvailable && process.send
    ? createAgentTools({
        retrieveGraphEvidence: (args, signal) => toolBridge.invoke(
          command.runId,
          "retrieve_graph_evidence",
          args,
          signal,
        ),
        proposeChangeSet: (args, signal) => toolBridge.invoke(
          command.runId,
          "propose_change_set",
          args,
          signal,
        ),
      })
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
