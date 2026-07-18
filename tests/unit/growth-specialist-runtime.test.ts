import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { requireAgentCapability } from "../../src/agent-worker/editorial/agentCapabilityRegistry";
import { handleGrowthEditorialSpecialistCommand } from "../../src/agent-worker/editorial/specialistWorkerController";
import type { RuntimeAdapter } from "../../src/agent-worker/pi/runtimeAdapterContract";
import {
  growthEditorialSpecialistEventSchema,
  growthEditorialSpecialistStartSchema,
  type GrowthEditorialSpecialistEvent,
  type GrowthEditorialSpecialistStart,
} from "../../src/shared/growthEditorialWorkerProtocol";

describe("Growth editorial specialist runtime", () => {
  it("accepts one source-bound candidate through the only exposed tool", async () => {
    const command = validCommand();
    const createAdapter = vi.fn(() => adapter(async (input) => {
      expect(input.tools.map((tool) => tool.name)).toEqual(["submit_specialist_candidate"]);
      expect(input.userInput).toContain("不可信项目资料");
      await execute(input.tools[0], readySubmission());
      return adapterResult("provider-live", "model-live");
    }));
    const events = await runController(command, createAdapter);
    expect(events.map((event) => event.type)).toEqual([
      "growth.editorial.specialist.started",
      "growth.editorial.specialist.completed",
    ]);
    expect(events[1]).toMatchObject({
      candidate: { status: "ready", contentArtifactRefs: ["@artifact1"] },
      artifacts: [{ ref: "@artifact1", content: "北境河流冬季封冻，春季融雪形成洪峰并改变交通窗口。" }],
      receipt: { actualProviderId: "provider-live", actualModelId: "model-live" },
    });
  });

  it("terminates needs_more_evidence as a new prepared-invocation request without a mutation tool", async () => {
    const command = validCommand();
    const createAdapter = vi.fn(() => adapter(async (input) => {
      expect(input.tools).toHaveLength(1);
      await execute(input.tools[0], {
        candidate: {
          status: "needs_more_evidence",
          summary: "缺少冬季河流流量记录。",
          evidenceRefs: ["@evidence1"],
          coverage: [{ facetId: "hydrology", state: "partial", evidenceRefs: ["@evidence1"] }],
          missingEvidenceQueries: ["检索冬季河流流量与封冻记录"],
        },
        artifacts: [],
      });
      return adapterResult();
    }));
    const events = await runController(command, createAdapter);
    expect(events[1]).toMatchObject({
      type: "growth.editorial.specialist.evidence_requested",
      request: { status: "needs_more_evidence", missingEvidenceQueries: ["检索冬季河流流量与封冻记录"] },
    });
    expect(JSON.stringify(events)).not.toContain("changeSet");
  });

  it("fails closed before Provider execution without configuration or a published intact Prompt", async () => {
    for (const mutate of [
      (command: GrowthEditorialSpecialistStart) => ({ ...command, providerProfile: null }),
      (command: GrowthEditorialSpecialistStart) => ({ ...command, prompt: { ...command.prompt, status: "candidate" as const, publicationEvidence: null } }),
      (command: GrowthEditorialSpecialistStart) => ({ ...command, prompt: { ...command.prompt, content: `${command.prompt.content} tampered` } }),
    ]) {
      const createAdapter = vi.fn(() => adapter(async () => adapterResult()));
      const events = await runController(mutate(validCommand()), createAdapter);
      expect(events[1].type).toBe("growth.editorial.specialist.failed");
      expect(createAdapter).not.toHaveBeenCalled();
    }
  });

  it("rejects packet/evidence tampering and unsupported fixed capabilities before Provider execution", async () => {
    const tamperedPacket = validCommand();
    tamperedPacket.packet.objective = "篡改后的目标";
    const tamperedEvidence = validCommand();
    tamperedEvidence.packet.evidence[0].content = "篡改后的来源";
    const unsupported = validCommand();
    const writer = requireAgentCapability("writer");
    unsupported.binding.capabilityId = "writer";
    unsupported.packet.capabilityId = "writer";
    unsupported.profile = { ...writer.profile };
    unsupported.prompt = {
      ...unsupported.prompt,
      id: writer.promptAsset.id,
      version: writer.promptAsset.version,
    };
    unsupported.prompt.sha256 = sha256(unsupported.prompt.content);
    unsupported.binding.packetSha256 = canonicalAuditHash(unsupported.packet);

    for (const command of [tamperedPacket, tamperedEvidence, unsupported]) {
      const createAdapter = vi.fn(() => adapter(async () => adapterResult()));
      const events = await runController(command, createAdapter);
      expect(events[1].type).toBe("growth.editorial.specialist.failed");
      expect(createAdapter).not.toHaveBeenCalled();
    }
  });

  it("rejects forged evidence, artifacts, facets and duplicate accepted submissions", async () => {
    const invalidCandidates = [
      { ...readySubmission(), candidate: { ...readyCandidate(), evidenceRefs: ["@evidence2"] } },
      { ...readySubmission(), candidate: { ...readyCandidate(), contentArtifactRefs: ["@artifact2"] } },
      { ...readySubmission(), candidate: { ...readyCandidate(), coverage: [{ facetId: "economy", state: "covered", evidenceRefs: ["@evidence1"] }] } },
    ];
    for (const candidate of invalidCandidates) {
      const events = await runController(validCommand(), () => adapter(async (input) => {
        await expect(execute(input.tools[0], candidate)).rejects.toMatchObject({ code: expect.stringMatching(/^GROWTH_SPECIALIST_/) });
        return adapterResult();
      }));
      expect(events[1]).toMatchObject({ type: "growth.editorial.specialist.failed" });
    }

    const duplicate = await runController(validCommand(), () => adapter(async (input) => {
      await execute(input.tools[0], readySubmission());
      await expect(execute(input.tools[0], readySubmission())).rejects.toMatchObject({ code: "GROWTH_SPECIALIST_DUPLICATE_SUBMISSION" });
      return adapterResult();
    }));
    expect(duplicate[1]).toMatchObject({ type: "growth.editorial.specialist.failed", error: { code: "GROWTH_SPECIALIST_OUTPUT_REQUIRED" } });
  });

  it("counts only the corrected valid terminal submission", async () => {
    const events = await runController(validCommand(), () => adapter(async (input) => {
      expect(input.completionGuard).toMatchObject({ toolName: "submit_specialist_candidate", forceTool: true });
      await expect(execute(input.tools[0], { candidate: readyCandidate(), artifacts: [] }))
        .rejects.toMatchObject({ code: "GROWTH_SPECIALIST_OUTPUT_SCHEMA_INVALID" });
      await execute(input.tools[0], readySubmission());
      const result = adapterResult();
      result.receipt.correctionAttempts = 1;
      return result;
    }));
    expect(events[1]).toMatchObject({
      type: "growth.editorial.specialist.completed",
      receipt: { correctionAttempts: 1 },
    });
  });

  it("passes cancellation to the Provider and returns only a safe failure projection", async () => {
    const controller = new AbortController();
    const createAdapter = vi.fn(() => adapter(async (input) => {
      expect(input.signal).toBe(controller.signal);
      controller.abort();
      throw Object.assign(new Error("secret provider response"), { code: "AGENT_RUN_CANCELLED" });
    }));
    const events = await runController(validCommand(), createAdapter, controller.signal);
    expect(events[1]).toEqual(expect.objectContaining({
      type: "growth.editorial.specialist.failed",
      error: { code: "AGENT_RUN_CANCELLED", message: "专业候选运行失败，未写入项目。" },
    }));
    expect(JSON.stringify(events)).not.toContain("secret provider response");
  });

  it("keeps the worker protocol strict and free of Prompt/provider secrets in events", () => {
    const command = validCommand();
    expect(growthEditorialSpecialistStartSchema.safeParse(command).success).toBe(true);
    expect(growthEditorialSpecialistStartSchema.safeParse({ ...command, tools: ["write_database"] }).success).toBe(false);
    const event = growthEditorialSpecialistEventSchema.parse({
      type: "growth.editorial.specialist.failed",
      runId: command.runId,
      attemptId: command.attemptId,
      error: { code: "GROWTH_SPECIALIST_FAILED", message: "专业候选运行失败，未写入项目。" },
    });
    expect(JSON.stringify(event)).not.toContain(command.providerProfile?.apiKey);
    expect(JSON.stringify(event)).not.toContain(command.prompt.content);
  });
});

function validCommand(): GrowthEditorialSpecialistStart {
  const definition = requireAgentCapability("geography_ecology_author");
  const promptContent = "你是地理与生态专业作者。仅依据证据提交结构化候选。";
  const packet = {
    capabilityId: "geography_ecology_author" as const,
    sourceCheckpointId: "checkpoint-1",
    workOrderId: "work-order-1",
    objective: "建立北境水系、气候与资源分布的因果联系。",
    scopeRefs: ["@resource1"],
    acceptanceFacets: [{ id: "hydrology", description: "说明水系、季节与交通的因果机制。", required: true }],
    evidence: [{
      ref: "@evidence1" as const,
      kind: "document" as const,
      stableLocator: "document:world#paragraph:1",
      content: "北境冬季严寒，河流封冻四个月，春季融雪形成洪峰。",
      contentSha256: sha256("北境冬季严寒，河流封冻四个月，春季融雪形成洪峰。"),
    }],
    artifactSlots: ["@artifact1" as const],
    revisionFeedback: [],
  };
  return growthEditorialSpecialistStartSchema.parse({
    type: "growth.editorial.specialist.start",
    runId: "run-1",
    attemptId: "attempt-1",
    profile: { ...definition.profile },
    prompt: {
      id: definition.promptAsset.id,
      version: definition.promptAsset.version,
      sha256: sha256(promptContent),
      status: "active",
      content: promptContent,
      publicationEvidence: { reportPath: "notes/evidence/editorial/test.json", reportSha256: "e".repeat(64) },
    },
    binding: {
      capabilityId: definition.capabilityId,
      contractVersion: "1.0.0",
      inputContractId: definition.contract.id,
      sourceCheckpointId: packet.sourceCheckpointId,
      workOrderId: packet.workOrderId,
      packetSha256: canonicalAuditHash(packet),
    },
    outputContractId: definition.contract.id,
    packet,
    providerProfile: {
      providerId: "test-provider",
      displayName: "Test Provider",
      baseUrl: "https://provider.example/v1",
      modelId: "test-model",
      contextWindow: 128_000,
      maxTokens: 8_000,
      reasoning: false,
      input: ["text"],
      apiKey: "test-secret-key",
    },
  });
}

function readyCandidate() {
  return {
    status: "ready",
    summary: "北境水系候选已覆盖季节封冻与交通机制。",
    contentArtifactRefs: ["@artifact1"],
    evidenceRefs: ["@evidence1"],
    coverage: [{ facetId: "hydrology", state: "covered", evidenceRefs: ["@evidence1"] }],
  };
}

function readySubmission() {
  return {
    candidate: readyCandidate(),
    artifacts: [{
      ref: "@artifact1",
      title: "北境水系与季节交通",
      mediaType: "text/markdown",
      content: "北境河流冬季封冻，春季融雪形成洪峰并改变交通窗口。",
    }],
  };
}

async function runController(
  command: GrowthEditorialSpecialistStart,
  createAdapter: (profile: NonNullable<GrowthEditorialSpecialistStart["providerProfile"]>) => RuntimeAdapter,
  signal = new AbortController().signal,
): Promise<GrowthEditorialSpecialistEvent[]> {
  const events: GrowthEditorialSpecialistEvent[] = [];
  await handleGrowthEditorialSpecialistCommand({ command, signal, emit: (event) => events.push(event) }, { createAdapter });
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
      actualProviderId,
      actualModelId,
      responseIdSha256: "a".repeat(64),
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      contextPolicyVersion: "test",
      maxChargedInputBytes: 1_000,
      configuredContextWindow: 128_000,
      safetyReserve: 1_000,
      outputReserve: 1_000,
      correctionAttempts: 0,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
