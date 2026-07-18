import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileWorldDirectorPacket,
  WORLD_DIRECTOR_PACKET_VERSION,
  type WorldDirectorPacketCompileInput,
} from "../../src/main/growth/editorial/worldDirectorPacketCompiler";
import { agentCapabilityIds } from "../../src/shared/growthEditorialContract";

describe("World Director packet compiler", () => {
  it("compiles every required safe projection into one deterministic pinned packet", () => {
    const input = fixture();
    const first = compileWorldDirectorPacket(input);
    const second = compileWorldDirectorPacket({
      ...input,
      closureMatrix: [...input.closureMatrix].reverse(),
      causalFrontier: [...input.causalFrontier].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.packet).toMatchObject({
      version: WORLD_DIRECTOR_PACKET_VERSION,
      identity: { goalId: "goal-1", branchId: "branch-1", sourceCheckpointId: "checkpoint-1", ruleRevision: 2, lens: "creator" },
      userRules: [{ id: "rule-1", text: "世界必须保持低魔法成本约束。" }],
      closureMatrix: [{ facetId: "economy", state: "missing" }, { facetId: "geography", state: "satisfied" }],
      causalFrontier: [{ relationVersionId: "relation-v1", epistemicStatus: "confirmed" }, { relationVersionId: "relation-v2", epistemicStatus: "inferred" }],
      recentChangeSets: [{ changeSetId: "change-new" }, { changeSetId: "change-old" }],
      unresolvedCheckerFindings: [{ findingId: "finding-blocking", severity: "blocking" }, { findingId: "finding-major", severity: "major" }],
      nodeMaturity: [{ scopeRef: "@resource1", state: "structured" }],
      graphSummaries: [{ scopeRef: "@resource1", factCount: 8, causalEdgeCount: 2 }],
      imageQueueSummary: { queued: 2, running: 1, ready: 3, failed: 1, stale: 0 },
      retrieval: { incomplete: false },
    });
    expect(first.packet.availableCapabilities).toEqual(agentCapabilityIds);
    expect(first.packet.editorialCharter).toHaveLength(4);
    expect(first.packetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bounds every expandable section and discloses omissions without dropping user rules", () => {
    const input = fixture();
    input.closureMatrix.push({ ...input.closureMatrix[0], facetId: "history" });
    input.causalFrontier.push({ ...input.causalFrontier[0], relationVersionId: "relation-v3", causeAssertionId: "assertion-5", effectAssertionId: "assertion-6" });
    input.unresolvedCheckerFindings.push({ ...input.unresolvedCheckerFindings[0], findingId: "finding-minor", severity: "minor" });
    input.budget = {
      maxClosureFacets: 1,
      maxCausalEdges: 1,
      maxRecentChangeSets: 1,
      maxCheckerFindings: 1,
      maxNodeMaturity: 1,
      maxGraphSummaries: 1,
      maxTotalChars: 20_000,
    };
    const { packet } = compileWorldDirectorPacket(input);
    expect(packet.userRules).toHaveLength(1);
    expect(packet.closureMatrix).toHaveLength(1);
    expect(packet.causalFrontier).toHaveLength(1);
    expect(packet.recentChangeSets).toHaveLength(1);
    expect(packet.unresolvedCheckerFindings).toEqual([expect.objectContaining({ findingId: "finding-blocking" })]);
    expect(packet.retrieval).toMatchObject({
      incomplete: true,
      omitted: { closureFacets: 2, causalEdges: 2, recentChangeSets: 1, checkerFindings: 2 },
    });
  });

  it("fails closed for checkpoint drift, rule tampering, duplicate identities and Player Lens", () => {
    const checkpointDrift = fixture();
    checkpointDrift.causalFrontier[0].sourceCheckpointId = "checkpoint-future";
    expectCode(() => compileWorldDirectorPacket(checkpointDrift), "WORLD_DIRECTOR_PACKET_CHECKPOINT_MISMATCH");

    const ruleTampering = fixture();
    ruleTampering.userRules[0].text = "被篡改规则";
    expectCode(() => compileWorldDirectorPacket(ruleTampering), "WORLD_DIRECTOR_PACKET_RULE_HASH_MISMATCH");

    const duplicate = fixture();
    duplicate.graphSummaries.push({ ...duplicate.graphSummaries[0] });
    expectCode(() => compileWorldDirectorPacket(duplicate), "WORLD_DIRECTOR_PACKET_DUPLICATE_INPUT");

    expectCode(() => compileWorldDirectorPacket({ ...fixture(), lens: "player" }), "WORLD_DIRECTOR_PACKET_INPUT_INVALID");
  });

  it("rejects credentials, raw Prompt/full-database fields and hidden Player payloads", () => {
    const credential = fixture();
    credential.userRules[0] = rule("rule-1", "apiKey=super-secret-provider-token");
    expectCode(() => compileWorldDirectorPacket(credential), "WORLD_DIRECTOR_PACKET_CREDENTIAL_REJECTED");

    for (const forged of [
      { ...fixture(), prompt: "raw system Prompt" },
      { ...fixture(), fullDatabaseDump: { tables: ["documents"] } },
      { ...fixture(), hiddenPlayerFacts: ["幕后凶手"] },
      { ...fixture(), unrelatedProse: "整部长篇正文" },
    ]) {
      expectCode(() => compileWorldDirectorPacket(forged), "WORLD_DIRECTOR_PACKET_INPUT_INVALID");
    }
    const serialized = JSON.stringify(compileWorldDirectorPacket(fixture()).packet);
    for (const forbidden of ["prompt", "apiKey", "fullDatabaseDump", "hiddenPlayerFacts", "unrelatedProse", "documentContent"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed instead of silently slicing an oversized packet", () => {
    const input = fixture();
    input.userRules = Array.from({ length: 20 }, (_, index) => rule(`rule-${index + 1}`, "必须完整保留的创作者规则。".repeat(100)));
    input.budget = {
      maxClosureFacets: 100,
      maxCausalEdges: 100,
      maxRecentChangeSets: 20,
      maxCheckerFindings: 100,
      maxNodeMaturity: 200,
      maxGraphSummaries: 100,
      maxTotalChars: 10_000,
    };
    expectCode(() => compileWorldDirectorPacket(input), "WORLD_DIRECTOR_PACKET_BUDGET_EXCEEDED");
  });
});

function fixture(): WorldDirectorPacketCompileInput {
  return {
    goalId: "goal-1",
    branchId: "branch-1",
    sourceCheckpointId: "checkpoint-1",
    ruleRevision: 2,
    lens: "creator",
    userRules: [rule("rule-1", "世界必须保持低魔法成本约束。")],
    closureMatrix: [
      { sourceCheckpointId: "checkpoint-1", profileId: "world-birth", facetId: "geography", state: "satisfied", safeSummary: "地理已有来源。", evidenceRefs: ["@evidence1"] },
      { sourceCheckpointId: "checkpoint-1", profileId: "world-birth", facetId: "economy", state: "missing", safeSummary: "经济因果缺失。", evidenceRefs: [] },
    ],
    causalFrontier: [
      { sourceCheckpointId: "checkpoint-1", relationVersionId: "relation-v2", relationKind: "enables", causeAssertionId: "assertion-3", effectAssertionId: "assertion-4", mechanismSummary: "融雪提供春季航运窗口。", epistemicStatus: "inferred", sourceReferences: [{ kind: "document", versionId: "document-v2", locator: "paragraph:2" }] },
      { sourceCheckpointId: "checkpoint-1", relationVersionId: "relation-v1", relationKind: "causes", causeAssertionId: "assertion-1", effectAssertionId: "assertion-2", mechanismSummary: "冬季低温导致河流封冻。", epistemicStatus: "confirmed", sourceReferences: [{ kind: "document", versionId: "document-v1", locator: "paragraph:1" }] },
    ],
    recentChangeSets: [
      { sourceCheckpointId: "checkpoint-1", changeSetId: "change-old", committedCheckpointId: "checkpoint-old", summary: "建立北境地理。", outputKinds: ["document_version"], committedAt: "2026-07-18T01:00:00.000Z" },
      { sourceCheckpointId: "checkpoint-1", changeSetId: "change-new", committedCheckpointId: "checkpoint-1", summary: "补充北境因果。", outputKinds: ["assertion_version", "causal_relation_version"], committedAt: "2026-07-18T02:00:00.000Z" },
    ],
    unresolvedCheckerFindings: [
      { sourceCheckpointId: "checkpoint-1", findingId: "finding-major", workOrderId: "work-1", severity: "major", category: "coverage", safeSummary: "贸易路径覆盖不足。", evidenceRefs: ["@evidence1"] },
      { sourceCheckpointId: "checkpoint-1", findingId: "finding-blocking", workOrderId: "work-2", severity: "blocking", category: "fact_conflict", safeSummary: "两条年代记录冲突。", evidenceRefs: ["@evidence2"] },
    ],
    nodeMaturity: [{ sourceCheckpointId: "checkpoint-1", scopeRef: "@resource1", profileId: "world", state: "structured", satisfiedFacetIds: ["geography"], missingFacetIds: ["economy"] }],
    graphSummaries: [{ sourceCheckpointId: "checkpoint-1", scopeRef: "@resource1", label: "北境", safeSummary: "北境地理与两条发展因果。", factCount: 8, causalEdgeCount: 2, conflictCount: 1, sourceVersionIds: ["document-v1", "document-v2"], truncated: false }],
    imageQueueSummary: { sourceCheckpointId: "checkpoint-1", requests: 2, queued: 2, running: 1, ready: 3, failed: 1, stale: 0 },
  };
}

function rule(id: string, text: string) {
  return { id, revision: 1, text, contentSha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ code }));
}
