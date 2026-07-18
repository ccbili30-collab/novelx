import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CausalRelationRepository } from "../../src/domain/graph/causalRelationRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { compileGrowthCandidate } from "../../src/main/growth/editorial/growthCandidateCompiler";
import type { GrowthCandidateCompileInput } from "../../src/main/growth/editorial/growthCandidatePolicy";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Growth candidate compiler", () => {
  it("generates every identity, dependency and source binding deterministically", () => {
    const input = fixture("world-root");
    const first = compileGrowthCandidate(input);
    const second = compileGrowthCandidate(structuredClone(input));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ sourceCheckpointId: "checkpoint-1", mode: "free" });
    expect(first.proposal.items.map((item) => item.kind)).toEqual([
      "document.put", "assertion.put", "assertion.put", "causal_relation.put",
    ]);
    expect(first.proposalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(first.generated.assertionIds)).toHaveLength(2);
    expect(Object.values(first.generated.relationIds)).toHaveLength(1);
    const causal = first.proposal.items.find((item) => item.kind === "causal_relation.put")!;
    if (causal.kind !== "causal_relation.put") throw new Error("Expected causal item.");
    expect(causal.dependsOn).toEqual(expect.arrayContaining([
      expect.stringMatching(/^growth-assertion-/),
      expect.stringMatching(/^growth-document-/),
    ]));
    expect(causal.payload).toMatchObject({
      relationKind: "causes",
      polarityStrengthSummary: "正向、中等强度；不表达伪精确概率。",
      causeAssertionItemId: expect.stringMatching(/^growth-assertion-/),
      effectAssertionItemId: expect.stringMatching(/^growth-assertion-/),
      sourceBindings: [{ evidenceId: expect.stringMatching(/^greenfield_document_output:growth-document-/) }],
    });
    expect(JSON.stringify(first.proposal)).not.toContain("local:cold");
    expect(JSON.stringify(first.proposal)).not.toContain("@artifact1");
  });

  it("generates parent hierarchy before child content and graph outputs", () => {
    const input = fixture("world-root");
    input.resources.push({
      ref: "@resource2", resourceId: "world-north", state: "create", type: "world", objectKind: "location",
      title: "北境", parentRef: "@resource1", sortOrder: 1,
    });
    input.artifactTargets[0].resourceRef = "@resource2";
    if (input.graph.status !== "ready") throw new Error("Fixture mismatch.");
    input.graph.candidate.assertions.forEach((assertion) => { assertion.subjectRef = "@resource2"; });
    const compiled = compileGrowthCandidate(input);
    expect(compiled.proposal.items.map((item) => item.kind)).toEqual([
      "resource.put", "document.put", "assertion.put", "assertion.put", "causal_relation.put",
    ]);
    const resourceItem = compiled.proposal.items[0];
    const documentItem = compiled.proposal.items[1];
    expect(resourceItem).toMatchObject({ kind: "resource.put", payload: { parentId: "world-root" } });
    expect(documentItem.dependsOn).toContain(resourceItem.id);
  });

  it("commits document, assertions and causality atomically through the real gateway", async () => {
    const setup = createWorkspace();
    const world = new ResourceRepository(setup.workspace).listCurrent().find((item) => item.type === "world")!;
    const input = fixture(world.id);
    const compiled = compileGrowthCandidate(input);
    seedProposeTool(setup.workspace);
    const gateway = createWorkspaceAgentToolGateway(setup.workspace, new WorkspaceChangeSetPolicy(setup.workspace), () => true);
    const result = await gateway.proposeChangeSet(compiled.proposal, {
      runId: "run-candidate", invocationId: "run-candidate:steward", requestId: "tool-candidate",
      mode: "free", sameChangeSetDocumentEvidenceAuthorized: true, signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "committed", gateStatus: "ready", itemCount: 4 });
    expect(result.committedOutputs).toHaveLength(4);
    expect(new AssertionRepository(setup.workspace).listCurrent().filter((item) =>
      Object.values(compiled.generated.assertionIds).includes(item.assertionId))).toHaveLength(2);
    expect(new CausalRelationRepository(setup.workspace).listAtCheckpoint(
      new CheckpointRepository(setup.workspace).getActiveBranch().headCheckpointId,
    ).filter((item) => Object.values(compiled.generated.relationIds).includes(item.id))).toHaveLength(1);
    expect(new ChangeSetRepository(setup.workspace).listOutputs(result.changeSetId)).toHaveLength(4);
  });

  it("rejects unsupported causality before any Change Set or Domain write", () => {
    const setup = createWorkspace();
    const world = new ResourceRepository(setup.workspace).listCurrent().find((item) => item.type === "world")!;
    const input = fixture(world.id);
    input.causalSupport[0].decision = "unsupported";
    const before = databaseCounts(setup.workspace);
    expect(() => compileGrowthCandidate(input)).toThrow(expect.objectContaining({ code: "GROWTH_CANDIDATE_CAUSAL_SUPPORT_REQUIRED" }));
    expect(databaseCounts(setup.workspace)).toEqual(before);
  });

  it("fails closed for missing sources, forged artifacts, unresolved endpoints and epistemic uncertainty", () => {
    const cases: Array<[GrowthCandidateCompileInput, string]> = [];
    const missingSource = fixture("world-root");
    missingSource.evidenceBindings = missingSource.evidenceBindings.filter((item) => item.evidenceRef !== "@evidence2");
    cases.push([missingSource, "GROWTH_CANDIDATE_EVIDENCE_BINDING_MISSING"]);
    const artifactHash = fixture("world-root");
    if (artifactHash.evidenceBindings[1].source.kind !== "same_change_set_artifact") throw new Error("Fixture mismatch.");
    artifactHash.evidenceBindings[1].source.sourceSha256 = "f".repeat(64);
    cases.push([artifactHash, "GROWTH_CANDIDATE_ARTIFACT_HASH_MISMATCH"]);
    const endpoint = fixture("world-root");
    if (endpoint.graph.status !== "ready") throw new Error("Fixture mismatch.");
    endpoint.graph.candidate.causalLinks[0].causeRef = "@assertion2";
    cases.push([endpoint, "GROWTH_CANDIDATE_CAUSAL_ENDPOINT_UNRESOLVED"]);
    const unknown = fixture("world-root");
    if (unknown.graph.status !== "ready") throw new Error("Fixture mismatch.");
    unknown.graph.candidate.causalLinks[0].epistemicStatus = "unknown";
    cases.push([unknown, "GROWTH_CANDIDATE_CAUSAL_EPISTEMIC_UNRESOLVED"]);
    const forgedRange = fixture("world-root");
    if (forgedRange.graph.status !== "ready") throw new Error("Fixture mismatch.");
    forgedRange.graph.candidate.assertions[0].sourceLocators[0].startCodePoint = 1;
    cases.push([forgedRange, "GROWTH_CANDIDATE_SOURCE_LOCATOR_INVALID"]);
    for (const [input, code] of cases) expect(() => compileGrowthCandidate(input)).toThrow(expect.objectContaining({ code }));
  });

  it("rejects parent cycles/order drift, Artifact ownership drift and model-supplied compiler fields", () => {
    const parent = fixture("world-root");
    parent.resources[0].state = "create";
    parent.resources[0].parentRef = "@resource1";
    expect(() => compileGrowthCandidate(parent)).toThrow(expect.objectContaining({ code: "GROWTH_CANDIDATE_PARENT_ORDER_INVALID" }));

    const target = fixture("world-root");
    target.artifactTargets[0].artifactRef = "@artifact2";
    expect(() => compileGrowthCandidate(target)).toThrow(expect.objectContaining({ code: "GROWTH_CANDIDATE_ARTIFACT_TARGET_MISMATCH" }));

    expect(() => compileGrowthCandidate({ ...fixture("world-root"), modelGeneratedChangeSetId: "forged" }))
      .toThrow(expect.objectContaining({ code: "GROWTH_CANDIDATE_INPUT_INVALID" }));
  });
});

function fixture(resourceId: string, activeEvidenceId = "document-version-1"): GrowthCandidateCompileInput {
  const content = "严寒导致河流封冻。";
  const locator = { sourceRef: "@evidence2", startCodePoint: 0, endCodePoint: Array.from(content).length, sourceTextSha256: sha256(content) };
  return {
    goalId: "goal-1", roundId: "round-1", workOrderId: "work-1", attemptId: "attempt-1",
    sourceCheckpointId: "checkpoint-1", mode: "free", summary: "提交北境严寒与河流封冻因果。",
    resources: [{
      ref: "@resource1", resourceId, state: "existing", type: "world", objectKind: "world",
      title: "世界", parentRef: null, sortOrder: 0,
    }],
    artifactTargets: [{ artifactRef: "@artifact1", resourceRef: "@resource1" }],
    evidenceBindings: [
      { evidenceRef: "@evidence1", source: { kind: "active_document", evidenceId: activeEvidenceId, sourceId: resourceId, sourceSha256: "1".repeat(64), stableLocator: "document:world#seed" } },
      { evidenceRef: "@evidence2", source: { kind: "same_change_set_artifact", artifactRef: "@artifact1", sourceSha256: sha256(content), stableLocator: "artifact:work-1#candidate" } },
    ],
    existingAssertions: [],
    causalSupport: [{ localId: "cold_causes_frozen", decision: "supported", evidenceRefs: ["@evidence2"] }],
    specialist: {
      candidate: {
        status: "ready", summary: "北境严寒与河流封冻候选。", contentArtifactRefs: ["@artifact1"],
        evidenceRefs: ["@evidence1"], coverage: [{ facetId: "causality", state: "covered", evidenceRefs: ["@evidence1"] }],
      },
      artifacts: [{ ref: "@artifact1", title: "北境气候", mediaType: "text/markdown", content }],
    },
    graph: {
      status: "ready",
      candidate: {
        summary: "提取严寒导致封冻的因果。",
        assertions: [
          { localId: "cold", subjectRef: "@resource1", predicate: "climate.temperature", object: { state: "severe_cold" }, sourceLocators: [locator] },
          { localId: "frozen", subjectRef: "@resource1", predicate: "river.state", object: { state: "frozen" }, sourceLocators: [locator] },
        ],
        causalLinks: [{
          localId: "cold_causes_frozen", causeRef: "local:cold", effectRef: "local:frozen", relationKind: "causes",
          mechanism: "持续低温使河水结冰并形成封冻。", conditions: ["冬季持续严寒"], temporalScope: "冬季",
          polarityStrengthSummary: "正向、中等强度；不表达伪精确概率。", epistemicStatus: "confirmed", sourceLocators: [locator],
        }],
      },
    },
  };
}

function createWorkspace(): { root: string; workspace: WorkspaceDatabase } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-candidate-compiler-"));
  workspace = openWorkspace(root);
  return { root, workspace };
}

function seedProposeTool(workspace: WorkspaceDatabase): void {
  const audit = new AgentAuditRepository(workspace);
  const hash = "a".repeat(64);
  audit.beginRun({ runId: "run-candidate", mode: "free", userInputSha256: hash, providerId: "provider", requestedModelId: "model", providerConfigSha256: hash });
  audit.beginInvocation({
    invocationId: "run-candidate:steward", runId: "run-candidate", parentInvocationId: null, role: "steward",
    promptId: "novax.steward", promptVersion: "test", promptSha256: hash,
    agentProfileId: "novax.steward", agentProfileVersion: "test", agentProfileSha256: hash,
    providerId: "provider", requestedModelId: "model", providerConfigSha256: hash,
    toolPolicyId: "novax.steward.tools", toolPolicyVersion: "test", toolPolicySha256: hash,
    authorizedTools: ["propose_change_set"], handoffContractId: null, handoffVersion: null,
    handoffPayloadSha256: null, inputSha256: hash,
  });
  audit.beginTool({
    toolInvocationId: "tool-candidate", runId: "run-candidate", invocationId: "run-candidate:steward",
    toolName: "propose_change_set", argumentsSha256: hash,
  });
}

function databaseCounts(workspace: WorkspaceDatabase) {
  const count = (table: string): number => (workspace.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    checkpoints: count("checkpoints"), changeSets: count("change_sets"), assertions: count("assertion_versions"),
    causal: count("causal_relation_versions"), documents: count("document_versions"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
