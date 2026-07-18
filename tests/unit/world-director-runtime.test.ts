import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requireAgentCapability } from "../../src/agent-worker/editorial/agentCapabilityRegistry";
import { handleWorldDirectorCommand } from "../../src/agent-worker/editorial/worldDirectorWorkerController";
import type { RuntimeAdapter } from "../../src/agent-worker/pi/runtimeAdapterContract";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { compileWorldDirectorPacket } from "../../src/main/growth/editorial/worldDirectorPacketCompiler";
import {
  type WorldDirectorEvent,
  type WorldDirectorStart,
  worldDirectorEventSchema,
  worldDirectorStartSchema,
} from "../../src/shared/growthEditorialWorkerProtocol";

describe("World Director runtime", () => {
  it("accepts one checkpoint-bound editorial round plan through its only tool", async () => {
    const command = validCommand("plan");
    const createAdapter = vi.fn(() => adapter(async (input) => {
      expect(input.tools.map((tool) => tool.name)).toEqual(["submit_world_director_result"]);
      expect(input.userInput).toContain("不得扩大范围、写正文、调用其他工具、创建 Change Set");
      await execute(input.tools[0], validPlan());
      return adapterResult("provider-live", "model-live");
    }));
    const events = await runController(command, createAdapter);
    expect(events).toMatchObject([
      { type: "growth.editorial.director.started", invocationKind: "plan" },
      {
        type: "growth.editorial.director.planned",
        plan: { goalId: "goal-1", sourceCheckpointId: "checkpoint-1", workOrders: [{ scopeRefs: ["@resource1"] }] },
        receipt: { actualProviderId: "provider-live", actualModelId: "model-live" },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/artifact|changeSet|prose/i);
  });

  it("accepts one evidence-bound editorial review and no mutation payload", async () => {
    const events = await runController(validCommand("review"), () => adapter(async (input) => {
      await execute(input.tools[0], validReview());
      return adapterResult();
    }));
    expect(events[1]).toMatchObject({
      type: "growth.editorial.director.reviewed",
      review: { decision: "revise", reasons: [{ facetId: "economy", evidenceRefs: ["@evidence1"] }] },
    });
    expect(JSON.stringify(events[1])).not.toContain("changeSet");
  });

  it("fails before Provider execution without configuration, publication evidence, or intact hashes", async () => {
    const packetTamper = validCommand("plan");
    packetTamper.packet.identity.goalId = "tampered-goal";
    for (const command of [
      { ...validCommand("plan"), providerProfile: null },
      { ...validCommand("plan"), prompt: { ...validCommand("plan").prompt, status: "candidate" as const, publicationEvidence: null } },
      { ...validCommand("plan"), prompt: { ...validCommand("plan").prompt, content: "tampered prompt" } },
      packetTamper,
    ]) {
      const createAdapter = vi.fn(() => adapter(async () => adapterResult()));
      const events = await runController(command, createAdapter);
      expect(events[1].type).toBe("growth.editorial.director.failed");
      expect(createAdapter).not.toHaveBeenCalled();
    }
  });

  it("independently rejects internally inconsistent checkpoints and user-rule hashes", async () => {
    const checkpointDrift = validCommand("plan");
    checkpointDrift.packet.closureMatrix[0].sourceCheckpointId = "checkpoint-other";
    checkpointDrift.packetSha256 = canonicalAuditHash(checkpointDrift.packet);
    const ruleDrift = validCommand("plan");
    ruleDrift.packet.userRules.push({ id: "rule-1", revision: 1, text: "规则内容", contentSha256: "f".repeat(64) });
    ruleDrift.packetSha256 = canonicalAuditHash(ruleDrift.packet);
    for (const [command, code] of [
      [checkpointDrift, "WORLD_DIRECTOR_PACKET_CHECKPOINT_MISMATCH"],
      [ruleDrift, "WORLD_DIRECTOR_PACKET_RULE_INTEGRITY_FAILED"],
    ] as const) {
      const createAdapter = vi.fn(() => adapter(async () => adapterResult()));
      const events = await runController(command, createAdapter);
      expect(events[1]).toMatchObject({ type: "growth.editorial.director.failed", error: { code } });
      expect(createAdapter).not.toHaveBeenCalled();
    }
  });

  it("rejects invocation-kind drift, checkpoint drift, unauthorized scope and forged review evidence", async () => {
    const invalidCases: Array<{ kind: "plan" | "review"; output: unknown; code: string }> = [
      { kind: "plan", output: validReview(), code: "WORLD_DIRECTOR_INVOCATION_KIND_MISMATCH" },
      { kind: "plan", output: { ...validPlan(), goalId: "goal-other" }, code: "WORLD_DIRECTOR_PLAN_BINDING_MISMATCH" },
      { kind: "plan", output: { ...validPlan(), workOrders: [{ ...validPlan().workOrders[0], scopeRefs: ["@resource2"] }] }, code: "WORLD_DIRECTOR_PLAN_SCOPE_MISMATCH" },
      { kind: "review", output: { ...validReview(), reasons: [{ facetId: "economy", reason: "无来源。", evidenceRefs: ["@evidence2"] }] }, code: "WORLD_DIRECTOR_REVIEW_EVIDENCE_MISMATCH" },
      { kind: "review", output: { ...validReview(), reasons: [{ facetId: "geography", reason: "范围错误。", evidenceRefs: ["@evidence1"] }] }, code: "WORLD_DIRECTOR_REVIEW_FACET_MISMATCH" },
    ];
    for (const testCase of invalidCases) {
      const events = await runController(validCommand(testCase.kind), () => adapter(async (input) => {
        await expect(execute(input.tools[0], testCase.output)).rejects.toMatchObject({ code: testCase.code });
        return adapterResult();
      }));
      expect(events[1]).toMatchObject({ type: "growth.editorial.director.failed", error: { code: "WORLD_DIRECTOR_OUTPUT_REQUIRED" } });
    }
  });

  it("counts only a schema-valid submission and rejects duplicate accepted submissions", async () => {
    const corrected = await runController(validCommand("plan"), () => adapter(async (input) => {
      expect(input.completionGuard).toMatchObject({ toolName: "submit_world_director_result", forceTool: true });
      await expect(execute(input.tools[0], { ...validPlan(), changeSet: { operations: [] } }))
        .rejects.toMatchObject({ code: "WORLD_DIRECTOR_OUTPUT_SCHEMA_INVALID" });
      await execute(input.tools[0], validPlan());
      const result = adapterResult();
      result.receipt.correctionAttempts = 1;
      return result;
    }));
    expect(corrected[1]).toMatchObject({ type: "growth.editorial.director.planned", receipt: { correctionAttempts: 1 } });

    const duplicate = await runController(validCommand("plan"), () => adapter(async (input) => {
      await execute(input.tools[0], validPlan());
      await expect(execute(input.tools[0], validPlan())).rejects.toMatchObject({ code: "WORLD_DIRECTOR_DUPLICATE_SUBMISSION" });
      return adapterResult();
    }));
    expect(duplicate[1]).toMatchObject({ type: "growth.editorial.director.failed", error: { code: "WORLD_DIRECTOR_OUTPUT_REQUIRED" } });
  });

  it("passes cancellation and emits only a safe failure projection", async () => {
    const controller = new AbortController();
    const events = await runController(validCommand("plan"), () => adapter(async (input) => {
      expect(input.signal).toBe(controller.signal);
      controller.abort();
      throw Object.assign(new Error("secret Provider body"), { code: "AGENT_RUN_CANCELLED" });
    }), controller.signal);
    expect(events[1]).toEqual(expect.objectContaining({
      type: "growth.editorial.director.failed",
      error: { code: "AGENT_RUN_CANCELLED", message: "世界总编运行失败，未写入项目。" },
    }));
    expect(JSON.stringify(events)).not.toContain("secret Provider body");
  });

  it("keeps start/events strict and excludes Prompt and Provider secrets", () => {
    const command = validCommand("plan");
    expect(worldDirectorStartSchema.safeParse(command).success).toBe(true);
    expect(worldDirectorStartSchema.safeParse({ ...command, tools: ["write_database"] }).success).toBe(false);
    const event = worldDirectorEventSchema.parse({
      type: "growth.editorial.director.failed",
      runId: command.runId,
      error: { code: "WORLD_DIRECTOR_FAILED", message: "世界总编运行失败，未写入项目。" },
    });
    expect(JSON.stringify(event)).not.toContain(command.providerProfile?.apiKey);
    expect(JSON.stringify(event)).not.toContain(command.prompt.content);
  });
});

function validCommand(invocationKind: "plan" | "review"): WorldDirectorStart {
  const definition = requireAgentCapability("world_director");
  const promptContent = "你是世界总编。只提交绑定当前检查点的编辑计划或审查。";
  const { packet, packetSha256 } = compileWorldDirectorPacket({
    goalId: "goal-1",
    branchId: "branch-1",
    sourceCheckpointId: "checkpoint-1",
    ruleRevision: 1,
    lens: "creator",
    userRules: [],
    closureMatrix: [{
      sourceCheckpointId: "checkpoint-1", profileId: "world", facetId: "economy", state: "missing",
      safeSummary: "经济因果仍需补全。", evidenceRefs: ["@evidence1"],
    }],
    causalFrontier: [],
    recentChangeSets: [],
    unresolvedCheckerFindings: [{
      sourceCheckpointId: "checkpoint-1", findingId: "finding-1", workOrderId: "work-old", severity: "major",
      category: "coverage", safeSummary: "贸易路径覆盖不足。", evidenceRefs: ["@evidence1"],
    }],
    nodeMaturity: [{
      sourceCheckpointId: "checkpoint-1", scopeRef: "@resource1", profileId: "world", state: "structured",
      satisfiedFacetIds: [], missingFacetIds: ["economy"],
    }],
    graphSummaries: [{
      sourceCheckpointId: "checkpoint-1", scopeRef: "@resource1", label: "北境", safeSummary: "北境贸易因果待补。",
      factCount: 3, causalEdgeCount: 0, conflictCount: 0, sourceVersionIds: ["document-v1"], truncated: false,
    }],
    imageQueueSummary: { sourceCheckpointId: "checkpoint-1", requests: 0, queued: 0, running: 0, ready: 0, failed: 0, stale: 0 },
  });
  return worldDirectorStartSchema.parse({
    type: "growth.editorial.director.start",
    runId: `director-${invocationKind}`,
    invocationKind,
    profile: { ...definition.profile },
    prompt: {
      id: definition.promptAsset.id,
      version: definition.promptAsset.version,
      sha256: sha256(promptContent),
      status: "active",
      content: promptContent,
      publicationEvidence: { reportPath: "notes/evidence/editorial/world-director.json", reportSha256: "e".repeat(64) },
    },
    packet,
    packetSha256,
    outputContractId: definition.contract.id,
    providerProfile: {
      providerId: "test-provider", displayName: "Test Provider", baseUrl: "https://provider.example/v1",
      modelId: "test-model", contextWindow: 128_000, maxTokens: 8_000, reasoning: false, input: ["text"], apiKey: "test-secret-key",
    },
  });
}

function validPlan() {
  return {
    id: "round-1",
    goalId: "goal-1",
    sourceCheckpointId: "checkpoint-1",
    workOrders: [{
      id: "work-1",
      objective: "补全北境经济与贸易因果。",
      sourceCheckpointId: "checkpoint-1",
      scopeRefs: ["@resource1"],
      capability: "civilization_author",
      acceptanceFacets: [{ id: "economy", description: "建立经济因果与来源覆盖。", required: true }],
      dependencies: [],
    }],
  };
}

function validReview() {
  return {
    decision: "revise",
    reasons: [{ facetId: "economy", reason: "贸易路径仍缺乏因果闭环。", evidenceRefs: ["@evidence1"] }],
    revisionObjective: "补全资源、运输与市场之间的因果机制。",
  };
}

async function runController(
  command: WorldDirectorStart,
  createAdapter: (profile: NonNullable<WorldDirectorStart["providerProfile"]>) => RuntimeAdapter,
  signal = new AbortController().signal,
): Promise<WorldDirectorEvent[]> {
  const events: WorldDirectorEvent[] = [];
  await handleWorldDirectorCommand({ command, signal, emit: (event) => events.push(event) }, { createAdapter });
  return events;
}

function adapter(run: RuntimeAdapter["run"]): RuntimeAdapter {
  return { run };
}

async function execute(tool: AgentTool, params: unknown): Promise<unknown> {
  return tool.execute("tool-call-1", params, new AbortController().signal, () => undefined);
}

function adapterResult(actualProviderId: string | null = "test-provider", actualModelId: string | null = "test-model") {
  return {
    text: "",
    stopReason: "stop" as const,
    receipt: {
      actualProviderId, actualModelId, responseIdSha256: "a".repeat(64), inputTokens: 100, outputTokens: 50, totalTokens: 150,
      contextPolicyVersion: "test", maxChargedInputBytes: 1_000, configuredContextWindow: 128_000,
      safetyReserve: 1_000, outputReserve: 1_000, correctionAttempts: 0,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
