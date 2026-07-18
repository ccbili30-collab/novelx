import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { requireAgentCapability } from "../../src/agent-worker/editorial/agentCapabilityRegistry";
import {
  graphCuratorEventSchema,
  graphCuratorStartSchema,
  type GraphCuratorEvent,
  type GraphCuratorStart,
} from "../../src/agent-worker/editorial/graphCuratorContracts";
import { handleGraphCuratorCommand } from "../../src/agent-worker/editorial/graphCuratorRuntime";
import type { RuntimeAdapter } from "../../src/agent-worker/pi/runtimeAdapterContract";

describe("Graph Curator runtime", () => {
  it("accepts exact-source assertions and causality through its only terminal tool", async () => {
    const command = validCommand();
    const createAdapter = vi.fn(() => adapter(async (input) => {
      expect(input.tools.map((tool) => tool.name)).toEqual(["submit_graph_curator_candidate"]);
      expect(input.userInput).toContain("不可信项目资料");
      await execute(input.tools[0], readySubmission(command.packet.evidence[0].content));
      return adapterResult("provider-live", "model-live");
    }));
    const events = await runController(command, createAdapter);
    expect(events).toMatchObject([
      { type: "growth.editorial.graph_curator.started" },
      {
        type: "growth.editorial.graph_curator.completed",
        candidate: { assertions: [{ localId: "cold" }, { localId: "frozen" }], causalLinks: [{ causeRef: "local:cold", effectRef: "local:frozen" }] },
        receipt: { actualProviderId: "provider-live", actualModelId: "model-live" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("changeSet");
  });

  it("returns unsupported correlation as a missing-evidence request instead of inventing causality", async () => {
    const events = await runController(validCommand(), () => adapter(async (input) => {
      await execute(input.tools[0], {
        status: "needs_more_evidence",
        summary: "当前资料只显示严寒与封冻同时出现，缺少机制与时间序列来源。",
        evidenceRefs: ["@evidence1"],
        missingEvidenceQueries: ["检索低温导致河流结冰的机制与时间序列来源"],
      });
      return adapterResult();
    }));
    expect(events[1]).toMatchObject({
      type: "growth.editorial.graph_curator.evidence_requested",
      request: { status: "needs_more_evidence", missingEvidenceQueries: [expect.stringContaining("机制")] },
    });
    expect(JSON.stringify(events[1])).not.toContain("causalLinks");
  });

  it("fails before Provider execution without configuration, publication, or intact packet/evidence", async () => {
    const packetTamper = validCommand();
    packetTamper.packet.objective = "篡改目标";
    const evidenceTamper = validCommand();
    evidenceTamper.packet.evidence[0].content = "篡改来源";
    evidenceTamper.packetSha256 = canonicalAuditHash(evidenceTamper.packet);
    const credential = validCommand();
    credential.packet.evidence[0].content = "apiKey=super-secret-provider-token";
    credential.packet.evidence[0].contentSha256 = sha256(credential.packet.evidence[0].content);
    credential.packetSha256 = canonicalAuditHash(credential.packet);
    for (const command of [
      { ...validCommand(), providerProfile: null },
      { ...validCommand(), prompt: { ...validCommand().prompt, status: "candidate" as const, publicationEvidence: null } },
      packetTamper,
      evidenceTamper,
      credential,
    ]) {
      const createAdapter = vi.fn(() => adapter(async () => adapterResult()));
      const events = await runController(command, createAdapter);
      expect(events[1].type).toBe("growth.editorial.graph_curator.failed");
      expect(createAdapter).not.toHaveBeenCalled();
    }
  });

  it("rejects forged source refs, code-point ranges, source hashes, scopes and causal endpoints", async () => {
    const command = validCommand();
    const content = command.packet.evidence[0].content;
    const valid = readySubmission(content);
    const invalid = [
      mutateLocator(valid, { sourceRef: "@evidence2" }),
      mutateLocator(valid, { endCodePoint: Array.from(content).length + 1 }),
      mutateLocator(valid, { sourceTextSha256: "f".repeat(64) }),
      { ...valid, candidate: { ...valid.candidate, assertions: valid.candidate.assertions.map((item, index) => index === 0 ? { ...item, subjectRef: "@resource2" } : item) } },
      { ...valid, candidate: { ...valid.candidate, causalLinks: [{ ...valid.candidate.causalLinks[0], causeRef: "@assertion2" }] } },
    ];
    for (const submission of invalid) {
      const events = await runController(validCommand(), () => adapter(async (input) => {
        await expect(execute(input.tools[0], submission)).rejects.toMatchObject({ code: expect.stringMatching(/^GRAPH_CURATOR_/) });
        return adapterResult();
      }));
      expect(events[1]).toMatchObject({ type: "growth.editorial.graph_curator.failed", error: { code: "GRAPH_CURATOR_OUTPUT_REQUIRED" } });
    }
  });

  it("rejects self-edges, empty mechanism/source and duplicate accepted submissions", async () => {
    const command = validCommand();
    const content = command.packet.evidence[0].content;
    const ready = readySubmission(content);
    for (const link of [
      { ...ready.candidate.causalLinks[0], effectRef: "local:cold" },
      { ...ready.candidate.causalLinks[0], mechanism: "" },
      { ...ready.candidate.causalLinks[0], sourceLocators: [] },
    ]) {
      const events = await runController(validCommand(), () => adapter(async (input) => {
        await expect(execute(input.tools[0], { ...ready, candidate: { ...ready.candidate, causalLinks: [link] } }))
          .rejects.toMatchObject({ code: "GRAPH_CURATOR_OUTPUT_SCHEMA_INVALID" });
        return adapterResult();
      }));
      expect(events[1].type).toBe("growth.editorial.graph_curator.failed");
    }
    const duplicate = await runController(validCommand(), () => adapter(async (input) => {
      await execute(input.tools[0], ready);
      await expect(execute(input.tools[0], ready)).rejects.toMatchObject({ code: "GRAPH_CURATOR_DUPLICATE_SUBMISSION" });
      return adapterResult();
    }));
    expect(duplicate[1]).toMatchObject({ type: "growth.editorial.graph_curator.failed", error: { code: "GRAPH_CURATOR_OUTPUT_REQUIRED" } });
  });

  it("passes cancellation and emits only safe protocol events", async () => {
    const controller = new AbortController();
    const command = validCommand();
    const events = await runController(command, () => adapter(async (input) => {
      expect(input.signal).toBe(controller.signal);
      controller.abort();
      throw Object.assign(new Error("secret Provider response"), { code: "AGENT_RUN_CANCELLED" });
    }), controller.signal);
    expect(events[1]).toEqual(expect.objectContaining({
      type: "growth.editorial.graph_curator.failed",
      error: { code: "AGENT_RUN_CANCELLED", message: "图谱候选运行失败，未写入项目。" },
    }));
    expect(JSON.stringify(events)).not.toContain("secret Provider response");
    expect(graphCuratorStartSchema.safeParse({ ...command, tools: ["write_database"] }).success).toBe(false);
    expect(graphCuratorEventSchema.safeParse(events[1]).success).toBe(true);
    expect(JSON.stringify(events)).not.toContain(command.providerProfile?.apiKey);
    expect(JSON.stringify(events)).not.toContain(command.prompt.content);
  });
});

function validCommand(): GraphCuratorStart {
  const definition = requireAgentCapability("graph_curator");
  const promptContent = "你是图谱书记官。只从精确来源定位提取断言和因果候选。";
  const content = "严寒导致河流封冻。";
  const packet = {
    capabilityId: "graph_curator" as const,
    sourceCheckpointId: "checkpoint-1",
    workOrderId: "work-order-1",
    objective: "提取严寒、封冻及其因果机制。",
    scopeRefs: ["@resource1" as const],
    existingAssertionRefs: ["@assertion1" as const],
    evidence: [{
      ref: "@evidence1" as const,
      kind: "specialist_candidate" as const,
      stableLocator: "artifact:work-order-1#candidate",
      content,
      contentSha256: sha256(content),
    }],
  };
  return graphCuratorStartSchema.parse({
    type: "growth.editorial.graph_curator.start",
    runId: "graph-run-1",
    attemptId: "attempt-1",
    profile: { ...definition.profile },
    prompt: {
      id: definition.promptAsset.id, version: definition.promptAsset.version, sha256: sha256(promptContent),
      status: "active", content: promptContent,
      publicationEvidence: { reportPath: "notes/evidence/editorial/graph-curator.json", reportSha256: "e".repeat(64) },
    },
    packet,
    packetSha256: canonicalAuditHash(packet),
    outputContractId: definition.contract.id,
    providerProfile: {
      providerId: "test-provider", displayName: "Test Provider", baseUrl: "https://provider.example/v1",
      modelId: "test-model", contextWindow: 128_000, maxTokens: 8_000, reasoning: false, input: ["text"], apiKey: "test-secret-key",
    },
  });
}

function readySubmission(content: string) {
  const locator = {
    sourceRef: "@evidence1",
    startCodePoint: 0,
    endCodePoint: Array.from(content).length,
    sourceTextSha256: sha256(content),
  };
  return {
    status: "ready",
    candidate: {
      summary: "提取严寒导致河流封冻的来源绑定因果候选。",
      assertions: [
        { localId: "cold", subjectRef: "@resource1", predicate: "climate.temperature", object: { state: "severe_cold" }, sourceLocators: [locator] },
        { localId: "frozen", subjectRef: "@resource1", predicate: "river.state", object: { state: "frozen" }, sourceLocators: [locator] },
      ],
      causalLinks: [{
        localId: "cold_causes_frozen", causeRef: "local:cold", effectRef: "local:frozen",
        mechanism: "持续低温使河水结冰并形成封冻。", conditions: ["冬季持续严寒"], temporalScope: "冬季",
        epistemicStatus: "confirmed", sourceLocators: [locator],
      }],
    },
  };
}

function mutateLocator(submission: ReturnType<typeof readySubmission>, patch: Record<string, unknown>) {
  const locator = { ...submission.candidate.assertions[0].sourceLocators[0], ...patch };
  return {
    ...submission,
    candidate: {
      ...submission.candidate,
      assertions: submission.candidate.assertions.map((item, index) => index === 0 ? { ...item, sourceLocators: [locator] } : item),
    },
  };
}

async function runController(
  command: GraphCuratorStart,
  createAdapter: (profile: NonNullable<GraphCuratorStart["providerProfile"]>) => RuntimeAdapter,
  signal = new AbortController().signal,
): Promise<GraphCuratorEvent[]> {
  const events: GraphCuratorEvent[] = [];
  await handleGraphCuratorCommand({ command, signal, emit: (event) => events.push(event) }, { createAdapter });
  return events;
}

function adapter(run: RuntimeAdapter["run"]): RuntimeAdapter { return { run }; }

async function execute(tool: AgentTool, params: unknown): Promise<unknown> {
  return tool.execute("tool-call-1", params, new AbortController().signal, () => undefined);
}

function adapterResult(actualProviderId: string | null = "test-provider", actualModelId: string | null = "test-model") {
  return {
    text: "", stopReason: "stop" as const,
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
