import { describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { handleAgentWorkerCommand, projectPublicArtifacts } from "../../src/agent-worker/workerController";
import { createRoleOutputTool } from "../../src/agent-worker/contracts/roleOutputTool";
import { growthIllustrationPlanParameters } from "../../src/agent-worker/growth/growthIllustrationPlan";
import type { PublishedPrompt } from "../../src/agent-worker/promptRegistry";
import {
  agentWorkerToolResponseSchema,
  growthIllustrationPlanSchema,
  growthRetrieveGraphEvidenceResultSchema,
  growthRunBindingSchema,
} from "../../src/shared/agentWorkerProtocol";
import { agentRunEventSchema } from "../../src/shared/ipcContract";

const auditRecorder = { record: async () => undefined };

describe("agent worker fail-closed contract", () => {
  it("requires a bounded unique trusted seed set in the internal Growth binding", () => {
    const binding = {
      capabilityVersion: "hackathon-growth-dynamic-v2", goalId: "goal-1", cycleId: "cycle-1",
      inputCheckpointId: "checkpoint-1", ruleRevision: 1, authorizedScopeResourceIds: ["world-root", "oc-root", "story-root"],
      kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"], seedResourceIds: ["seed-resource"],
      domainRootResourceIds: { world: "world-root", oc: "oc-root", story: "story-root" }, greenfieldCreateAuthorized: false,
    };
    expect(growthRunBindingSchema.parse(binding)).toEqual(binding);
    expect(growthRunBindingSchema.safeParse({ ...binding, seedResourceIds: ["seed-resource", "seed-resource"] }).success).toBe(false);
    expect(growthRunBindingSchema.safeParse({ ...binding, branchId: "forged" }).success).toBe(false);
    expect(growthRunBindingSchema.safeParse({ ...binding, greenfieldCreateAuthorized: "forged" }).success).toBe(false);
    expect(growthRunBindingSchema.safeParse({ ...binding, focusKinds: ["forged"] }).success).toBe(false);
    expect(growthRunBindingSchema.safeParse(({ ...binding, kind: undefined }) as unknown).success).toBe(false);
    expect(growthRunBindingSchema.safeParse({ ...binding, focusKinds: ["world", "world"] }).success).toBe(false);
    expect(growthRunBindingSchema.safeParse({ ...binding, rendererRequestedAuthority: true }).success).toBe(false);
  });

  it("keeps only allowlisted Change Set policy and domain errors in strict Worker failure responses", () => {
    const response = {
      type: "tool.response" as const,
      runId: "run-1",
      requestId: "11111111-1111-4111-8111-111111111111",
      ok: false as const,
      error: {
        code: "GREENFIELD_CREATE_ONLY_REQUIRED" as const,
        message: "Greenfield creation accepts create-only Change Sets.",
      },
    };
    expect(agentWorkerToolResponseSchema.safeParse(response).success).toBe(true);
    expect(agentWorkerToolResponseSchema.safeParse({
      ...response,
      error: {
        code: "RESOURCE_PARENT_NOT_FOUND",
        message: "The resource parent is unavailable.",
      },
    }).success).toBe(true);
    expect(agentWorkerToolResponseSchema.safeParse({
      ...response,
      error: {
        code: "CHANGE_SET_APPLY_FAILED",
        message: "The Change Set could not be applied safely.",
      },
    }).success).toBe(true);
    expect(agentWorkerToolResponseSchema.safeParse({ ...response, error: { ...response.error, code: "UNSAFE_TOKEN=secret" } }).success).toBe(false);
    expect(agentWorkerToolResponseSchema.safeParse({ ...response, error: { ...response.error, raw: "token=secret" } }).success).toBe(false);
  });

  it("rejects unknown Growth evidence resource and relation enum leaves", () => {
    const base = {
      variant: "growth_v1" as const,
      receiptRecorded: true as const,
      coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0, truncated: false },
      diagnostics: { expandedEdges: 0, consumedContentChars: 0 },
    };
    const resource = {
      evidenceId: "resource-version-1", kind: "resource" as const, label: "World", excerpt: null,
      resource: { resourceId: "world-1", type: "world", objectKind: "world" },
    };
    const relation = {
      evidenceId: "relation-1", kind: "relation" as const, label: "related_to",
      relation: { kind: "related_to", sourceResourceId: "world-1", targetResourceId: "story-1" },
    };

    expect(growthRetrieveGraphEvidenceResultSchema.safeParse({ ...base, evidence: [resource, relation] }).success).toBe(true);
    expect(growthRetrieveGraphEvidenceResultSchema.safeParse({
      ...base, evidence: [{ ...resource, resource: { ...resource.resource, type: "unknown_resource_type" } }],
    }).success).toBe(false);
    expect(growthRetrieveGraphEvidenceResultSchema.safeParse({
      ...base, evidence: [{ ...resource, resource: { ...resource.resource, objectKind: "unknown_object_kind" } }],
    }).success).toBe(false);
    expect(growthRetrieveGraphEvidenceResultSchema.safeParse({
      ...base, evidence: [{ ...relation, relation: { ...relation.relation, kind: "unknown_relation_kind" } }],
    }).success).toBe(false);
  });

  it("keeps the model-visible Growth Illustration Plan strict and authority-free", () => {
    const item = {
      targetEvidenceRef: "world",
      evidenceRefs: ["world", "setting"],
      purpose: "world_map" as const,
      title: "Tidal atlas",
      compositionDescription: "Arrange only the authorized geographic evidence.",
      variantKey: "map_primary",
    };
    const plan = { coverageMode: "default" as const, items: [item] };

    expect(growthIllustrationPlanSchema.parse(plan)).toEqual(plan);
    for (const forbiddenField of [
      "resourceId", "documentId", "branchId", "checkpointId", "permission", "jobId", "assetId",
      "policyId", "policyHash", "providerId", "modelId", "sourceVersionId",
    ]) {
      expect(growthIllustrationPlanSchema.safeParse({
        ...plan, items: [{ ...item, [forbiddenField]: "forged" }],
      }).success).toBe(false);
    }
    const visibleSchema = JSON.stringify(growthIllustrationPlanParameters);
    for (const forbidden of [
      "resourceId", "documentId", "branchId", "checkpointId", "permission", "jobId", "assetId",
      "policyId", "policyHash", "providerId", "modelId", "sourceVersionId",
    ]) expect(visibleSchema).not.toContain(forbidden);
    expect(visibleSchema).toContain("world_map");
    expect(visibleSchema).toContain("character_portrait");
    expect(visibleSchema).toContain("scene");
  });

  it("exposes strict Writer and Checker branch schemas at the Provider tool boundary", () => {
    const steward = createRoleOutputTool("steward").tool.parameters as { type?: string; anyOf?: unknown };
    const writer = createRoleOutputTool("writer").tool.parameters as { anyOf?: unknown[] };
    const checker = createRoleOutputTool("checker").tool.parameters as { anyOf?: unknown[] };

    expect(steward.type).toBe("object");
    expect(writer.anyOf).toHaveLength(2);
    expect(checker.anyOf).toHaveLength(3);
  });

  it("accepts only valid Writer branches and rejects cross-branch or extra fields", () => {
    const tool = createRoleOutputTool("writer").tool;
    const candidate = {
      status: "candidate",
      candidateText: "候选段落。",
      evidenceIds: ["source-1"],
      gmResolutionId: null,
      authorityChanges: [],
    };
    const blocked = {
      status: "blocked",
      reasons: [{ code: "missing_gm_resolution", message: "缺少 GM 裁决。", evidenceIds: ["source-1"] }],
    };
    expect(validateToolArguments(tool, { type: "toolCall", id: "writer-candidate", name: tool.name, arguments: candidate })).toEqual(candidate);
    expect(validateToolArguments(tool, { type: "toolCall", id: "writer-blocked", name: tool.name, arguments: blocked })).toEqual(blocked);
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "writer-cross", name: tool.name,
      arguments: { ...blocked, candidateText: "不得混用" },
    })).toThrow();
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "writer-extra", name: tool.name,
      arguments: { ...candidate, reasons: [] },
    })).toThrow();
  });

  it("accepts only valid Checker branches and rejects cross-branch or extra fields", () => {
    const tool = createRoleOutputTool("checker").tool;
    const passed = { status: "passed", findings: [] };
    const findings = {
      status: "findings",
      findings: [{
        severity: "major", category: "writer_authority",
        evidence: [{ sourceId: "source-1", claim: "GM 未裁决。" }],
        location: "第一段", scope: "当前场景", reason: "Writer 越过 GM 权限。",
      }],
    };
    const blocked = {
      status: "blocked",
      reasons: [{ code: "major_conflict", message: "来源冲突。", evidenceIds: ["source-1"] }],
    };
    for (const [id, arguments_] of [["checker-passed", passed], ["checker-findings", findings], ["checker-blocked", blocked]] as const) {
      expect(validateToolArguments(tool, { type: "toolCall", id, name: tool.name, arguments: arguments_ })).toEqual(arguments_);
    }
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "checker-cross", name: tool.name,
      arguments: { ...passed, reasons: [] },
    })).toThrow();
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "checker-extra", name: tool.name,
      arguments: { ...findings, replacementProse: "不允许" },
    })).toThrow();
  });

  it("accepts a source-bound image outcome at the Pi tool-argument boundary", () => {
    const tool = createRoleOutputTool("steward").tool;
    const args = {
      status: "completed",
      message: "角色立绘已经生成。",
      evidenceIds: ["image-version-1"],
      toolOutcomes: [
        { tool: "retrieve_graph_evidence", status: "succeeded" },
        { tool: "generate_image", status: "succeeded" },
      ],
      changeSet: { state: "none", changeSetId: null },
      escalations: [],
    };

    expect(validateToolArguments(tool, {
      type: "toolCall",
      id: "submit-image-result",
      name: "submit_steward_result",
      arguments: args,
    })).toEqual(args);
  });

  it("emits only started then provider-required when no provider profile exists", async () => {
    const emit = vi.fn();

    await handleAgentWorkerCommand({
      command: {
        type: "run.start",
        runId: "run-1",
        userInput: "讨论银湾海岸",
        mode: "assist",
        toolsAvailable: false,
        providerProfile: null,
      },
      tools: null,
      audit: auditRecorder,
      emit,
    });

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "run.started", runId: "run-1" },
      {
        type: "run.failed",
        runId: "run-1",
        code: "REAL_GM_PROVIDER_REQUIRED",
        message: "需要先配置可用的模型服务。",
        artifacts: [expect.objectContaining({ kind: "activity", label: "生成回复", status: "failed" })],
      },
    ]);
  });

  it("does not activate candidate Prompts when a Provider profile exists", async () => {
    const emit = vi.fn();
    const dependencies = runtimeDependencies(async () => {
      throw new Error("Provider must not run for candidate Prompts.");
    });
    dependencies.loadPromptSet = () => [
      { ...activePrompt("steward", "1.1.0", "Steward contract"), status: "candidate" as const },
      { ...activePrompt("writer", "1.0.0", "Writer contract"), status: "candidate" as const },
      { ...activePrompt("checker", "1.0.0", "Checker contract"), status: "candidate" as const },
    ];

    await handleAgentWorkerCommand({
      command: {
        type: "run.start",
        runId: "run-2",
        userInput: "讨论银湾海岸",
        mode: "assist",
        toolsAvailable: true,
        providerProfile: {
          providerId: "contract-provider",
          displayName: "Contract Provider",
          baseUrl: "https://example.invalid/v1",
          apiKey: "secret",
          modelId: "contract-model",
          contextWindow: 64_000,
          maxTokens: 8_000,
          reasoning: false,
          input: ["text"],
        },
      },
      tools: [],
      audit: auditRecorder,
      emit,
    }, dependencies);

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "run.started", runId: "run-2" },
      {
        type: "run.failed",
        runId: "run-2",
        code: "PROMPT_SET_NOT_PUBLISHED",
        message: "Agent 提示词尚未通过发布验证。",
        artifacts: [expect.objectContaining({ kind: "activity", label: "生成回复", status: "failed" })],
      },
    ]);
  });

  it("fails with AGENT_TOOLS_REQUIRED before Prompt loading when Main has no gateway", async () => {
    const emit = vi.fn();

    await handleAgentWorkerCommand({
      command: {
        type: "run.start",
        runId: "run-3",
        userInput: "讨论银湾海岸",
        mode: "assist",
        toolsAvailable: false,
        providerProfile: {
          providerId: "contract-provider",
          displayName: "Contract Provider",
          baseUrl: "https://example.invalid/v1",
          apiKey: "secret",
          modelId: "contract-model",
          contextWindow: 64_000,
          maxTokens: 8_000,
          reasoning: false,
          input: ["text"],
        },
      },
      tools: null,
      audit: auditRecorder,
      emit,
    });

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "run.started", runId: "run-3" },
      {
        type: "run.failed",
        runId: "run-3",
        code: "AGENT_TOOLS_REQUIRED",
        message: "Agent 领域工具尚未就绪。",
        artifacts: [expect.objectContaining({ kind: "activity", label: "生成回复", status: "failed" })],
      },
    ]);
  });

  it("runs an active Steward through a structured result tool and projects only safe events", async () => {
    const emit = vi.fn();
    const dependencies = runtimeDependencies(async (input) => {
      input.onEvent?.({ type: "tool.started", tool: "writer", label: "调用写手" });
      input.onEvent?.({ type: "tool.completed", tool: "writer", label: "调用写手" });
      await submitDiscussionPlan(input.tools);
      const resultTool = input.tools.find((tool) => tool.name === "submit_steward_result");
      await resultTool!.execute("tool-call-1", {
        status: "completed",
        message: "已完成本次讨论。",
        evidenceIds: [],
        toolOutcomes: [],
        changeSet: { state: "none", changeSetId: null },
        escalations: [],
      });
      return { text: "ignored raw model text", stopReason: "stop" as const };
    });

    await handleAgentWorkerCommand({
      command: providerCommand("run-4"),
      tools: [],
      audit: auditRecorder,
      emit,
    }, dependencies);

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "run.started", runId: "run-4" },
      { type: "run.activity", runId: "run-4", label: "调用写手", phase: "started", domains: ["story"] },
      { type: "run.activity", runId: "run-4", label: "调用写手", phase: "completed", domains: ["story"] },
      {
        type: "run.completed",
        runId: "run-4",
        outcome: "completed",
        message: "已完成本次讨论。",
        changeSetState: "none",
        artifacts: [],
      },
    ]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("evidence-1");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("change-1");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("ignored raw model text");
  });

  it("projects only explicit structured outcomes into public artifacts", () => {
    expect(projectPublicArtifacts({
      status: "blocked",
      message: "来源冲突。",
      evidenceIds: ["evidence-1"],
      toolOutcomes: [{ tool: "checker", status: "succeeded" }],
      changeSet: { state: "pending_review", changeSetId: "change-1" },
      escalations: [{ code: "conflicting_sources", message: "两个稳定来源互相冲突。", evidenceIds: ["evidence-1"] }],
    })).toEqual([
      { kind: "tool_call", tool: "checker", label: "一致性检查", status: "succeeded" },
      { kind: "change_set", changeSetId: "change-1", state: "pending_review" },
      { kind: "conflict", code: "conflicting_sources", message: "两个稳定来源互相冲突。", evidenceIds: ["evidence-1"] },
    ]);
  });

  it("projects only cited stable Creative Documents as clickable references", () => {
    expect(projectPublicArtifacts({
      status: "completed",
      message: "已核对资料。",
      evidenceIds: ["version-cited"],
      toolOutcomes: [{ tool: "retrieve_graph_evidence", status: "succeeded" }],
      changeSet: { state: "none", changeSetId: null },
      escalations: [],
    }, [
      { documentId: "document-cited", title: "潮汐纪年法", versionId: "version-cited", content: "第一行\n第二行\n第三行\n第四行" },
      { documentId: "document-unused", title: "未使用资料", versionId: "version-unused", content: "未引用" },
    ])).toEqual([
      { kind: "tool_call", tool: "retrieve_graph_evidence", label: "检索图谱与稳定资料", status: "succeeded" },
      {
        kind: "document_reference",
        documentId: "document-cited",
        title: "潮汐纪年法",
        versionId: "version-cited",
        locator: { kind: "line", start: 1, end: 3 },
        excerpt: "第一行\n第二行\n第三行\n第四行",
      },
    ]);
  });

  it("projects a committed managed image as a ready public artifact", () => {
    const artifacts = projectPublicArtifacts({
      status: "completed",
      message: "世界地图已生成。",
      evidenceIds: ["version-1"],
      toolOutcomes: [{ tool: "generate_image", status: "succeeded" }],
      changeSet: { state: "none", changeSetId: null },
      escalations: [],
    }, [], [], [{
      assetId: "asset-1",
      title: "银湾夜潮",
      status: "ready",
      purpose: "world_map",
      sourceVersionIds: ["version-1"],
      thumbnailUrl: "novax-asset://image/asset-1",
    }]);

    expect(artifacts).toEqual([
      { kind: "tool_call", tool: "generate_image", label: "生成角色或场景图片", status: "succeeded" },
      {
        kind: "image",
        assetId: "asset-1",
        title: "银湾夜潮",
        status: "ready",
        purpose: "world_map",
        sourceLabel: "基于 1 个稳定版本",
        thumbnailUrl: "novax-asset://image/asset-1",
      },
    ]);
    const event = agentRunEventSchema.parse({
      type: "run.completed",
      runId: "run-world-map",
      outcome: "completed",
      message: "世界地图已生成。",
      changeSetState: "none",
      artifacts,
    });
    expect(event.type).toBe("run.completed");
    if (event.type !== "run.completed") throw new Error("Expected a completed Agent Run event.");
    expect(event.artifacts).toEqual(artifacts);
  });

  it("rejects missing structured submissions and unsafe public messages", async () => {
    const missingEmit = vi.fn();
    await handleAgentWorkerCommand({
      command: providerCommand("run-5"),
      tools: [],
      audit: auditRecorder,
      emit: missingEmit,
    }, runtimeDependencies(async () => ({ text: "plain text only", stopReason: "stop" })));
    expect(missingEmit).toHaveBeenLastCalledWith({
      type: "run.failed",
      runId: "run-5",
      code: "PROVIDER_PROTOCOL_FAILED",
      message: "模型服务返回了无效结果。",
      artifacts: [expect.objectContaining({ kind: "activity", label: "生成回复", status: "failed" })],
    });

    const unsafeEmit = vi.fn();
    await handleAgentWorkerCommand({
      command: providerCommand("run-6"),
      tools: [],
      audit: auditRecorder,
      emit: unsafeEmit,
    }, runtimeDependencies(async (input) => {
      await submitDiscussionPlan(input.tools);
      const resultTool = input.tools.find((tool) => tool.name === "submit_steward_result");
      await resultTool!.execute("tool-call-2", {
        status: "completed",
        message: "已读取 C:\\private\\workspace.db。",
        evidenceIds: [],
        toolOutcomes: [],
        changeSet: { state: "none", changeSetId: null },
        escalations: [],
      });
      return { text: "", stopReason: "stop" as const };
    }));
    expect(unsafeEmit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "run.completed",
      runId: "run-6",
      message: "任务已完成。",
    }));
    expect(JSON.stringify(unsafeEmit.mock.calls)).not.toContain("workspace.db");
  });

  it("persists an allowlisted Provider protocol stage while keeping the worker event generic", async () => {
    const emit = vi.fn();
    const audit = { record: vi.fn(async () => undefined) };
    const secret = "token=protocol-stage-secret https://provider.invalid/?key=hidden";
    await handleAgentWorkerCommand({
      command: providerCommand("run-protocol-stage"),
      tools: [],
      audit,
      emit,
    }, runtimeDependencies(async () => {
      throw Object.assign(new Error(secret), {
        code: "PROVIDER_PROTOCOL_FAILED",
        providerProtocolStage: "PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE",
      });
    }));

    expect(audit.record).toHaveBeenCalledWith("run-protocol-stage", expect.objectContaining({
      type: "invocation.terminal",
      eventType: "failed",
      errorCode: "PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE",
    }));
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "run.failed",
      code: "PROVIDER_PROTOCOL_FAILED",
    }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
  });

  it("does not persist an untrusted Provider protocol stage or its raw error", async () => {
    const emit = vi.fn();
    const audit = { record: vi.fn(async () => undefined) };
    const secret = "password=untrusted-stage-secret";
    await handleAgentWorkerCommand({
      command: providerCommand("run-untrusted-stage"),
      tools: [],
      audit,
      emit,
    }, runtimeDependencies(async () => {
      throw Object.assign(new Error(secret), {
        code: "PROVIDER_PROTOCOL_FAILED",
        providerProtocolStage: "PROVIDER_PROTOCOL_RAW_CUSTOM_KEY",
      });
    }));

    expect(audit.record).toHaveBeenCalledWith("run-untrusted-stage", expect.objectContaining({
      type: "invocation.terminal",
      eventType: "failed",
      errorCode: "PROVIDER_PROTOCOL_OTHER",
    }));
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ code: "PROVIDER_PROTOCOL_FAILED" }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(secret);
  });

  it("rejects a complete-looking Prompt set when any role is not active", async () => {
    const emit = vi.fn();
    const dependencies = runtimeDependencies(async () => ({ text: "", stopReason: "stop" }));
    dependencies.loadPromptSet = () => [
      activePrompt("steward", "1.1.0", "Steward contract"),
      { ...activePrompt("writer", "1.0.0", "Writer contract"), status: "candidate" as const },
      activePrompt("checker", "1.0.0", "Checker contract"),
    ];

    await handleAgentWorkerCommand({
      command: providerCommand("run-7"),
      tools: [],
      audit: auditRecorder,
      emit,
    }, dependencies);

    expect(emit).toHaveBeenLastCalledWith({
      type: "run.failed",
      runId: "run-7",
      code: "PROMPT_SET_NOT_PUBLISHED",
      message: "Agent 提示词尚未通过发布验证。",
      artifacts: [expect.objectContaining({ kind: "activity", label: "生成回复", status: "failed" })],
    });
  });

  it("does not call the Provider until invocation audit start is acknowledged", async () => {
    const emit = vi.fn();
    const providerRun = vi.fn(async () => ({ text: "", stopReason: "stop" as const }));
    const audit = {
      record: vi.fn(async (_runId: string, operation: { type: string }) => {
        if (operation.type === "invocation.started") {
          throw Object.assign(new Error("audit unavailable"), { code: "AGENT_AUDIT_REQUIRED" });
        }
      }),
    };

    await handleAgentWorkerCommand({
      command: providerCommand("run-8"),
      tools: [],
      audit,
      emit,
    }, runtimeDependencies(providerRun));

    expect(providerRun).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith({
      type: "run.failed",
      runId: "run-8",
      code: "AGENT_AUDIT_REQUIRED",
      message: "Agent 运行审计不可用，任务已阻止。",
      artifacts: [expect.objectContaining({ kind: "activity", label: "生成回复", status: "failed" })],
    });
  });

  it("acknowledges Steward terminal audit before projecting completion", async () => {
    const order: string[] = [];
    const emit = vi.fn((event) => order.push(`emit:${event.type}`));
    const audit = {
      record: vi.fn(async (_runId: string, operation: { type: string }) => {
        order.push(`audit:${operation.type}`);
      }),
    };
    const dependencies = runtimeDependencies(async (input) => {
      order.push("provider:run");
      await submitDiscussionPlan(input.tools);
      const resultTool = input.tools.find((tool) => tool.name === "submit_steward_result")!;
      await resultTool.execute("result", {
        status: "completed",
        message: "任务已经完成。",
        evidenceIds: [],
        toolOutcomes: [],
        changeSet: { state: "none", changeSetId: null },
        escalations: [],
      });
      return { text: "raw text", stopReason: "stop" as const };
    });

    await handleAgentWorkerCommand({
      command: providerCommand("run-9"),
      tools: [],
      audit,
      emit,
    }, dependencies);

    expect(order).toEqual([
      "emit:run.started",
      "audit:invocation.started",
      "provider:run",
      "audit:invocation.terminal",
      "emit:run.completed",
    ]);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("raw text");
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("secret");
  });
});

function providerCommand(runId: string) {
  return {
    type: "run.start" as const,
    runId,
    userInput: "讨论银湾海岸",
    mode: "assist" as const,
    toolsAvailable: true,
    providerProfile: {
      providerId: "contract-provider",
      displayName: "Contract Provider",
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      modelId: "contract-model",
      contextWindow: 64_000,
      maxTokens: 8_000,
      reasoning: false,
      input: ["text" as const],
    },
  };
}

function runtimeDependencies(run: (input: {
  systemPrompt: string;
  userInput: string;
  tools: import("@earendil-works/pi-agent-core").AgentTool[];
  signal?: AbortSignal;
  onEvent?(event: import("../../src/agent-worker/pi/eventProjection").SafePiEvent): void;
}) => Promise<{ text: string; stopReason: "stop" }>) {
  return {
    loadPromptSet: () => [
      activePrompt("steward", "1.1.0", "Steward contract"),
      activePrompt("writer", "1.0.0", "Writer contract"),
      activePrompt("checker", "1.0.0", "Checker contract"),
    ],
    createAdapter: () => ({ run }),
    createResultTool: () => createRoleOutputTool("steward"),
  };
}

async function submitDiscussionPlan(tools: import("@earendil-works/pi-agent-core").AgentTool[]) {
  const planTool = tools.find((tool) => tool.name === "submit_steward_plan");
  await planTool!.execute("plan", {
    objective: "discussion",
    scopeResourceIds: [],
    steps: [],
  });
}

function activePrompt(
  role: "steward" | "writer" | "checker",
  version: "1.0.0" | "1.1.0",
  content: string,
): PublishedPrompt {
  return {
    id: `novax.${role}` as const,
    role,
    version,
    status: "active" as const,
    rollbackTo: null,
    sha256: "a".repeat(64),
    content,
  };
}
