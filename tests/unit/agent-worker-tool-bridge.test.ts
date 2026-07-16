import { describe, expect, it, vi } from "vitest";
import { AgentWorkerToolBridge } from "../../src/agent-worker/tools/agentWorkerToolBridge";
import { createAgentTools } from "../../src/agent-worker/tools/createAgentTools";
import type { AgentWorkerToolRequest, RetrieveGraphEvidenceArgs } from "../../src/shared/agentWorkerProtocol";
import { growthCapabilityVersion } from "../../src/shared/growthContract";

describe("Agent Worker tool bridge", () => {
  it("keeps persisted Receipt and revision target authority internal while preserving them for the state machine", async () => {
    const receipt = {
      variant: "growth_v1" as const, receiptRecorded: true as const, receiptId: "receipt-internal-1", evidence: [],
      revisionAuthority: {
        targets: [{
          kind: "document" as const, evidenceId: "version-setting", documentId: "document-setting",
          resourceId: "world-1", documentKind: "setting" as const, title: "Setting", sortOrder: 0,
        }],
      },
      coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0, truncated: false },
      diagnostics: { expandedEdges: 0, consumedContentChars: 0 }, closureEvaluation: null,
    };
    const tools = createAgentTools({ retrieveGraphEvidence: async () => receipt } as never, {
      growthBinding: {
        capabilityVersion: growthCapabilityVersion, goalId: "goal-1", cycleId: "cycle-1", kind: "expand",
        focusKinds: ["oc"], resumeFrontier: [], inputCheckpointId: "checkpoint-1", ruleRevision: 1,
        authorizedScopeResourceIds: ["world-root", "oc-root", "story-root"], seedResourceIds: ["oc-1"],
        domainRootResourceIds: { world: "world-root", oc: "oc-root", story: "story-root" },
        greenfieldCreateAuthorized: false, priorInquiries: [], closureProfile: null, closureRepair: null,
        longformAuthority: {
          phase: "outline", outlineId: "outline-1", mainStoryResourceId: "story-1", worldResourceId: "world-1",
          focusOcResourceId: "oc-1", personalStoryResourceId: "volume-1",
        },
      },
    });
    const result = await tools.find((candidate) => candidate.name === "retrieve_graph_evidence")!.execute("request-1", {
      variant: "growth_v1", query: "OC saga", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000,
      expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1",
    });
    expect(result.details).toMatchObject({ receiptId: "receipt-internal-1" });
    expect(result.details).toMatchObject({ revisionAuthority: { targets: [expect.objectContaining({ documentId: "document-setting" })] } });
    expect(result.content[0]?.type).toBe("text");
    const modelVisible = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(modelVisible).not.toContain("receipt-internal-1");
    expect(modelVisible).not.toContain("document-setting");
    expect(modelVisible).not.toContain("revisionAuthority");
  });

  it("exposes the three audited project tools", () => {
    const bridge = new AgentWorkerToolBridge(() => true);
    const tools = createAgentTools({
      retrieveGraphEvidence: (args, signal) => bridge.invoke(
        "run-1",
        "retrieve_graph_evidence",
        args as RetrieveGraphEvidenceArgs,
        signal,
      ),
      submitGrowthInquiry: (args, signal) => bridge.invoke("run-1", "submit_growth_inquiry", args, signal),
      inspectProjectFiles: (args, signal) => bridge.invoke(
        "run-1",
        "inspect_project_files",
        args,
        signal,
      ),
      listProjectDirectory: (args, signal) => bridge.invoke("run-1", "list_project_directory", args, signal),
      statProjectFile: (args, signal) => bridge.invoke("run-1", "stat_project_file", args, signal),
      globProjectFiles: (args, signal) => bridge.invoke("run-1", "glob_project_files", args, signal),
      searchProjectFiles: (args, signal) => bridge.invoke("run-1", "search_project_files", args, signal),
      readProjectFile: (args, signal) => bridge.invoke("run-1", "read_project_file", args, signal),
      saveTaskNote: (args, signal) => bridge.invoke("run-1", "save_task_note", args, signal),
      listTaskNotes: (args, signal) => bridge.invoke("run-1", "list_task_notes", args, signal),
      generateImage: (args, signal) => bridge.invoke("run-1", "generate_image", args, signal),
      proposeChangeSet: (args, signal) => bridge.invoke(
        "run-1",
        "propose_change_set",
        args,
        signal,
      ),
    }, {
      growthBinding: {
        capabilityVersion: growthCapabilityVersion, goalId: "goal-1", cycleId: "cycle-1", kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"], inputCheckpointId: "checkpoint-1",
        ruleRevision: 1, authorizedScopeResourceIds: ["world-1", "oc-root", "story-root"], seedResourceIds: [], domainRootResourceIds: { world: "world-1", oc: "oc-root", story: "story-root" }, greenfieldCreateAuthorized: false, priorInquiries: [], closureProfile: null, closureRepair: null,
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "retrieve_graph_evidence",
      "submit_growth_inquiry",
      "list_project_directory",
      "stat_project_file",
      "glob_project_files",
      "search_project_files",
      "read_project_file",
      "save_task_note",
      "list_task_notes",
      "inspect_project_files",
      "generate_image",
      "propose_change_set",
    ]);
    expect(tools.find((tool) => tool.name === "inspect_project_files")?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    const growthRetrieveSchema = JSON.stringify(tools.find((tool) => tool.name === "retrieve_graph_evidence")?.parameters);
    for (const forbiddenBindingField of ["goalId", "cycleId", "branchId", "checkpointId", "lens", "authorizedScopeResourceIds", "runId"]) {
      expect(growthRetrieveSchema).not.toContain(forbiddenBindingField);
    }
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

  it("correlates a Growth Inquiry without exposing trusted identities", async () => {
    let sent: AgentWorkerToolRequest | undefined;
    const bridge = new AgentWorkerToolBridge((request) => { sent = request; return true; });
    const pending = bridge.invoke("run-inquiry", "submit_growth_inquiry", {
      inquiries: [3, 2, 1].map((priority, index) => ({
        localId: `question_${index + 1}`,
        question: `What follows at priority ${priority}?`,
        evidenceIds: ["evidence-1"],
        evidenceState: "known" as const,
        safeSummary: `Evaluating consequence ${index + 1}.`,
        proposedAction: `Apply consequence ${index + 1}.`,
        provisionalAssumption: null,
        priority,
        requiresCreatorChoice: false,
      })),
      selectedLocalId: "question_1",
      priorTransitions: [],
    });
    expect(sent).toMatchObject({ runId: "run-inquiry", tool: "submit_growth_inquiry" });
    expect(bridge.handleResponse({
      type: "tool.response", runId: "run-inquiry", requestId: sent!.requestId, ok: true,
      tool: "submit_growth_inquiry", result: { status: "selected", safeSummary: "正在推演。" },
    })).toBe(true);
    await expect(pending).resolves.toEqual({ status: "selected", safeSummary: "正在推演。" });
  });

  it("correlates strict Closure submissions without accepting authority fields", async () => {
    let sent: AgentWorkerToolRequest | undefined;
    const bridge = new AgentWorkerToolBridge((request) => { sent = request; return true; });
    const assessment = bridge.invoke("run-closure", "submit_closure_self_assessment", {
      decision: "ready_for_checker", safeSummary: "All deterministic facets are satisfied.",
    });
    expect(sent).toMatchObject({ runId: "run-closure", tool: "submit_closure_self_assessment" });
    expect(bridge.handleResponse({
      type: "tool.response", runId: "run-closure", requestId: sent!.requestId, ok: true,
      tool: "submit_closure_self_assessment",
      result: {
        status: "checker_required", deterministicContentReady: true,
        facetResults: [{
          facetId: "facet-world", state: "satisfied", coverage: "complete",
          safeSummary: "World structure is pinned.", evidenceIds: ["evidence-world"],
        }],
      },
    })).toBe(true);
    await expect(assessment).resolves.toMatchObject({ status: "checker_required", deterministicContentReady: true });

    const review = bridge.invoke("run-closure", "submit_closure_checker_review", {
      decision: "accepted", adverseFindings: [],
    });
    expect(sent).toMatchObject({ runId: "run-closure", tool: "submit_closure_checker_review" });
    expect(bridge.handleResponse({
      type: "tool.response", runId: "run-closure", requestId: sent!.requestId, ok: true,
      tool: "submit_closure_checker_review", result: { status: "recorded", decision: "accepted" },
    })).toBe(true);
    await expect(review).resolves.toEqual({ status: "recorded", decision: "accepted" });
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

  it("keeps image generation pending beyond the ordinary tool timeout", async () => {
    vi.useFakeTimers();
    try {
      let sent: AgentWorkerToolRequest | undefined;
      const bridge = new AgentWorkerToolBridge((request) => { sent = request; return true; }, 50, 500);
      const pending = bridge.invoke("run-image", "generate_image", {
        title: "银湾夜潮",
        purpose: "scene",
        prompt: "月光下的银湾海岸",
        sourceResourceIds: ["world-1"],
        sourceVersionIds: ["version-1"],
        idempotencyKey: "silver-bay-image-v1",
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(bridge.handleResponse({
        type: "tool.response",
        runId: "run-image",
        requestId: sent!.requestId,
        ok: true,
        tool: "generate_image",
        result: {
          jobId: "job-1", assetId: "asset-1", status: "ready", title: "银湾夜潮", purpose: "scene",
          sourceResourceIds: ["world-1"], sourceVersionIds: ["version-1"], mimeType: "image/png",
          width: 1024, height: 1024, byteLength: 1024, sha256: "a".repeat(64),
          thumbnailUrl: "novax-asset://image/asset-1",
        },
      })).toBe(true);
      await expect(pending).resolves.toMatchObject({ assetId: "asset-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves safe project-file failure codes from main", async () => {
    let sent: AgentWorkerToolRequest | undefined;
    const bridge = new AgentWorkerToolBridge((request) => { sent = request; return true; });
    const pending = bridge.invoke("run-files", "read_project_file", { path: "README.md" });
    expect(bridge.handleResponse({
      type: "tool.response",
      runId: "run-files",
      requestId: sent!.requestId,
      ok: false,
      error: { code: "PROJECT_FILE_NOT_FOUND", message: "Project file or directory was not found." },
    })).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });
  });

  it("returns only a correlated managed image result", async () => {
    let sent: AgentWorkerToolRequest | undefined;
    const bridge = new AgentWorkerToolBridge((request) => { sent = request; return true; });
    const pending = bridge.invoke("run-image", "generate_image", {
      title: "银湾夜潮",
      purpose: "scene",
      prompt: "月光下的银湾海岸",
      sourceResourceIds: ["world-1"],
      sourceVersionIds: ["version-1"],
      idempotencyKey: "silver-bay-night-v1",
    });
    expect(bridge.handleResponse({
      type: "tool.response",
      runId: "run-image",
      requestId: sent!.requestId,
      ok: true,
      tool: "generate_image",
      result: {
        jobId: "job-1",
        assetId: "asset-1",
        status: "ready",
        title: "银湾夜潮",
        purpose: "scene",
        sourceResourceIds: ["world-1"],
        sourceVersionIds: ["version-1"],
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        byteLength: 1024,
        sha256: "d".repeat(64),
        thumbnailUrl: "novax-asset://image/asset-1",
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ assetId: "asset-1", status: "ready" });
  });
});
