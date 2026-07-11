import { describe, expect, it, vi } from "vitest";
import { AgentWorkerToolBridge } from "../../src/agent-worker/tools/agentWorkerToolBridge";
import { createAgentTools } from "../../src/agent-worker/tools/createAgentTools";
import type { AgentWorkerToolRequest } from "../../src/shared/agentWorkerProtocol";

describe("Agent Worker tool bridge", () => {
  it("exposes the three audited project tools", () => {
    const bridge = new AgentWorkerToolBridge(() => true);
    const tools = createAgentTools({
      retrieveGraphEvidence: (args, signal) => bridge.invoke(
        "run-1",
        "retrieve_graph_evidence",
        args,
        signal,
      ),
      inspectProjectFiles: (args, signal) => bridge.invoke(
        "run-1",
        "inspect_project_files",
        args,
        signal,
      ),
      proposeChangeSet: (args, signal) => bridge.invoke(
        "run-1",
        "propose_change_set",
        args,
        signal,
      ),
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "retrieve_graph_evidence",
      "inspect_project_files",
      "propose_change_set",
    ]);
    expect(tools.find((tool) => tool.name === "inspect_project_files")?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("correlates responses by runId and requestId", async () => {
    let sent: AgentWorkerToolRequest | undefined;
    const bridge = new AgentWorkerToolBridge((request) => {
      sent = request;
      return true;
    });
    const resultPromise = bridge.invoke("run-1", "propose_change_set", {
      summary: "补充设定",
      items: [{
        id: "item-1",
        dependsOn: [],
        kind: "document.put",
        payload: { resourceId: "world-1", content: "稳定候选内容" },
      }],
    });

    expect(sent).toBeDefined();
    expect(bridge.handleResponse({
      type: "tool.response",
      runId: "another-run",
      requestId: sent!.requestId,
      ok: true,
      tool: "propose_change_set",
      result: {
        changeSetId: "change-1",
        mode: "assist",
        status: "pending",
        gateStatus: "review_pending",
        blockedReason: null,
        itemCount: 1,
      },
    })).toBe(true);
    await expect(resultPromise).rejects.toMatchObject({ code: "AGENT_TOOL_PROTOCOL_FAILED" });
  });

  it("cleans up pending calls on cancellation and timeout", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new AgentWorkerToolBridge(() => true, 50);
      const cancelled = bridge.invoke("run-cancel", "retrieve_graph_evidence", { scopeResourceIds: ["world-1"] });
      bridge.cancelRun("run-cancel");
      await expect(cancelled).rejects.toMatchObject({ code: "AGENT_RUN_CANCELLED" });

      const timedOut = bridge.invoke("run-timeout", "retrieve_graph_evidence", { scopeResourceIds: ["world-1"] });
      const timeoutExpectation = expect(timedOut).rejects.toMatchObject({ code: "AGENT_TOOL_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(51);
      await timeoutExpectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
