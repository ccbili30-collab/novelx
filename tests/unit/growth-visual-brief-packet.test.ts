import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { GrowthIllustrationCoordinator } from "../../src/main/growth/illustration/growthIllustrationCoordinator";
import {
  compileGrowthVisualBriefPacket,
  compileGrowthVisualDirectorBrief,
  type GrowthVisualBriefPacketCompileInput,
} from "../../src/main/growth/illustration/growthVisualBriefPacket";

const roots: string[] = [];
const workspaces: WorkspaceDatabase[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Growth Visual Brief packet", () => {
  it("projects committed text and graph facts without exposing source authority, then compiles only enumerated composition", () => {
    const envelope = compileGrowthVisualBriefPacket(input());
    const serializedPacket = JSON.stringify(envelope.packet);

    expect(envelope.packetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.packet.target).toMatchObject({ purpose: "world_map", mapScale: "region" });
    expect(envelope.packet.evidence.map((entry) => entry.evidenceKind)).toEqual(["graph_evidence", "committed_text"]);
    expect(serializedPacket).not.toContain("region-resource-v2");
    expect(serializedPacket).not.toContain("setting-version-v4");
    expect(serializedPacket).not.toContain("contentSha256");
    expect(serializedPacket).not.toContain("sourceResourceIds");

    const compiled = compileGrowthVisualDirectorBrief({
      packetSha256: envelope.packetSha256,
      focalEvidenceRef: "@evidence1",
      supportingEvidenceRefs: ["@evidence2"],
      framing: "cartographic_overview",
      viewpoint: "overhead",
      layout: "balanced_hierarchy",
    }, envelope);

    expect(compiled.compositionDescription).toBe(
      "Use only selected evidence: @evidence1, @evidence2. Framing: cartographic_overview. Viewpoint: overhead. Layout: balanced_hierarchy. These are composition choices only and add no factual authority.",
    );
    expect(compiled.plan.items).toHaveLength(1);
    expect(compiled.plan.items[0]).toMatchObject({ purpose: "world_map", variantKey: "region_primary" });
    expect(compiled.plan.items[0]!.promptText).toContain("The north river feeds the documented harbor basin.");
    expect(compiled.plan.items[0]!.promptText).toContain("region-scale hierarchy emphasizes terrain, hydrology");
    expect(compiled.plan.items[0]!.promptText).toContain("colored expressive steel-pen and ink linework");
    expect(JSON.stringify(compiled)).not.toContain("silver crown");
  });

  it("rejects invented fields, unknown evidence, incompatible composition, and a mutated packet", () => {
    const envelope = compileGrowthVisualBriefPacket(input());
    const valid = {
      packetSha256: envelope.packetSha256,
      focalEvidenceRef: "@evidence1",
      supportingEvidenceRefs: ["@evidence2"],
      framing: "cartographic_overview",
      viewpoint: "overhead",
      layout: "balanced_hierarchy",
    } as const;
    for (const forbidden of [
      { prompt: "invent a silver crown" },
      { provider: "image-provider" },
      { style: "photoreal" },
      { inventedFacts: ["new castle"] },
      { sourceVersionIds: ["forged"] },
    ]) {
      expectCode(() => compileGrowthVisualDirectorBrief({ ...valid, ...forbidden }, envelope), "GROWTH_VISUAL_BRIEF_OUTPUT_INVALID");
    }
    expectCode(() => compileGrowthVisualDirectorBrief({
      ...valid, focalEvidenceRef: "@evidence9",
    }, envelope), "GROWTH_VISUAL_BRIEF_OUTPUT_INVALID");
    expectCode(() => compileGrowthVisualDirectorBrief({
      ...valid, framing: "full_body",
    }, envelope), "GROWTH_VISUAL_BRIEF_OUTPUT_INVALID");
    envelope.packet.objective = "mutated after compilation";
    expectCode(() => compileGrowthVisualDirectorBrief(valid, envelope), "GROWTH_VISUAL_BRIEF_PACKET_MISMATCH");

    const authorityEnvelope = compileGrowthVisualBriefPacket(input());
    authorityEnvelope.trustedAuthority.input.evidenceBindings[0]!.authorizedFacts = "mutated private authority";
    expectCode(() => compileGrowthVisualDirectorBrief({
      ...valid, packetSha256: authorityEnvelope.packetSha256,
    }, authorityEnvelope), "GROWTH_VISUAL_BRIEF_PACKET_MISMATCH");
  });

  it("fails closed for incomplete, cross-checkpoint, duplicate, or invalid source authority", () => {
    const baseline = input();
    expectCode(() => compileGrowthVisualBriefPacket({
      ...baseline,
      evidenceBindings: baseline.evidenceBindings.filter((binding) => binding.evidenceKind !== "graph_evidence"),
    }), "GROWTH_VISUAL_BRIEF_INPUT_INVALID");
    expectCode(() => compileGrowthVisualBriefPacket({
      ...baseline,
      evidenceBindings: baseline.evidenceBindings.map((binding, index) => index === 0
        ? { ...binding, sourceCheckpointId: "other-checkpoint" }
        : binding),
    }), "GROWTH_VISUAL_BRIEF_EVIDENCE_INCOMPLETE");
    expectCode(() => compileGrowthVisualBriefPacket({
      ...baseline,
      evidenceBindings: [baseline.evidenceBindings[0], { ...baseline.evidenceBindings[0] }],
    }), "GROWTH_VISUAL_BRIEF_DUPLICATE_AUTHORITY");
    expectCode(() => compileGrowthVisualBriefPacket({
      ...baseline,
      evidenceBindings: baseline.evidenceBindings.map((binding) => binding.evidenceKind === "committed_text"
        ? {
            ...binding,
            source: { kind: "resource" as const, resourceId: "forged", resourceVersionId: "forged-v1" },
            targetAnchorInput: { kind: "resource" as const, resourceId: "forged", resourceVersionId: "forged-v1" },
          }
        : binding),
    }), "GROWTH_VISUAL_BRIEF_EVIDENCE_INCOMPLETE");
    expectCode(() => compileGrowthVisualBriefPacket({ ...baseline, purpose: "scene" }), "GROWTH_VISUAL_BRIEF_AUTHORITY_INVALID");
  });

  it("feeds the deterministic plan into the existing persisted queue without invoking an image Provider", () => {
    const setup = createWorkspaceSetup();
    const envelope = compileGrowthVisualBriefPacket(setup.input);
    const compiled = compileGrowthVisualDirectorBrief({
      packetSha256: envelope.packetSha256,
      focalEvidenceRef: "@evidence1",
      supportingEvidenceRefs: ["@evidence2"],
      framing: "cartographic_overview",
      viewpoint: "orthographic",
      layout: "balanced_hierarchy",
    }, envelope);
    const generateImage = vi.fn();
    const coordinator = new GrowthIllustrationCoordinator(setup.workspace, { generateImage });
    const request = coordinator.persist({
      request: {
        id: "visual-brief-request",
        goalId: setup.goalId,
        cycleId: setup.cycleId,
        ruleRevision: 1,
        closureProfileId: null,
        closureRevision: null,
        idempotencyKey: "visual-brief-request-key",
      },
      plan: compiled.plan,
    });

    expect(request).toMatchObject({ itemCount: 1, status: "planned" });
    expect(new GrowthRepository(setup.workspace).listIllustrationItems(request.id)[0]).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ kind: "resource", resourceVersionId: setup.worldRevisionId }),
        expect.objectContaining({ kind: "document", documentVersionId: setup.documentVersionId }),
      ]),
    });
    expect(generateImage).not.toHaveBeenCalled();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });
});

function input(): GrowthVisualBriefPacketCompileInput {
  return {
    goalId: "visual-goal",
    cycleId: "visual-cycle",
    sourceCheckpointId: "checkpoint-4",
    ruleRevision: 3,
    authorizedScopeResourceIds: ["world-root"],
    targetEvidenceRef: "@evidence1",
    purpose: "world_map",
    title: "North River Region",
    variantKey: "region_primary",
    objective: "Make the documented river-to-harbor relationship readable at region scale.",
    evidenceBindings: [
      {
        evidenceRef: "@evidence1",
        evidenceKind: "graph_evidence",
        sourceCheckpointId: "checkpoint-4",
        scopeResourceId: "world-root",
        defaultCoverageRole: "place_or_faction",
        mapScale: "region",
        source: { kind: "resource", resourceId: "region-resource", resourceVersionId: "region-resource-v2" },
        authorizedFacts: "The north river feeds the documented harbor basin.",
        targetAnchorInput: { kind: "resource", resourceId: "region-resource", resourceVersionId: "region-resource-v2" },
      },
      {
        evidenceRef: "@evidence2",
        evidenceKind: "committed_text",
        sourceCheckpointId: "checkpoint-4",
        scopeResourceId: "world-root",
        defaultCoverageRole: "supporting",
        source: {
          kind: "document", documentId: "setting-document", documentVersionId: "setting-version-v4", contentSha256: "a".repeat(64),
        },
        authorizedFacts: "Seasonal floods deposit dark silt along the eastern harbor terraces.",
        targetAnchorInput: {
          kind: "stable_text_span", documentId: "setting-document", documentVersionId: "setting-version-v4",
          startCodePoint: 0, endCodePoint: 70, textSha256: "b".repeat(64),
        },
      },
    ],
  };
}

function createWorkspaceSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-visual-brief-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  workspaces.push(workspace);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const resources = new ResourceRepository(workspace);
  const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
  const world = resources.putRevisionWithReceipt({
    resourceId: "visual-brief-world",
    create: true,
    checkpointId: branch.headCheckpointId,
    type: "world",
    objectKind: "world",
    title: "North River World",
    parentId: worldRoot.id,
    state: "active",
  });
  const creative = new CreativeDocumentRepository(workspace).putRevisionWithReceipt({
    documentId: "visual-brief-setting",
    create: true,
    checkpointId: branch.headCheckpointId,
    resourceId: world.resourceId,
    kind: "setting",
    title: "River and harbor setting",
    state: "active",
  });
  const content = "The north river feeds the harbor basin and deposits dark seasonal silt.";
  const documentVersionId = new DocumentRepository(workspace).putVersion({
    resourceId: world.resourceId,
    creativeDocumentId: creative.documentId,
    checkpointId: branch.headCheckpointId,
    content,
    authorKind: "agent",
  });
  const document = new DocumentRepository(workspace).getVersion(documentVersionId)!;
  const growth = new GrowthRepository(workspace);
  const goal = growth.createGoal({
    id: "visual-brief-goal",
    idempotencyKey: "visual-brief-goal-key",
    branchId: branch.id,
    seed: { kind: "text", text: "illustrate the committed world" },
    authorizedScopeResourceIds: [worldRoot.id],
    initialRuleText: "Use source-bound evidence.",
    sourceMessageId: null,
  });
  const cycle = growth.beginCycle({
    id: "visual-brief-cycle",
    goalId: goal.id,
    idempotencyKey: "visual-brief-cycle-key",
    inputCheckpointId: branch.headCheckpointId,
    ruleRevision: 1,
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: [] },
  });
  const compiledInput: GrowthVisualBriefPacketCompileInput = {
    goalId: goal.id,
    cycleId: cycle.id,
    sourceCheckpointId: branch.headCheckpointId,
    ruleRevision: 1,
    authorizedScopeResourceIds: [worldRoot.id],
    targetEvidenceRef: "@evidence1",
    purpose: "world_map",
    title: "North River World Map",
    variantKey: "world_primary",
    objective: "Show only the documented river and harbor relationship.",
    evidenceBindings: [
      {
        evidenceRef: "@evidence1",
        evidenceKind: "graph_evidence",
        sourceCheckpointId: branch.headCheckpointId,
        scopeResourceId: worldRoot.id,
        defaultCoverageRole: "world",
        mapScale: "world",
        source: { kind: "resource", resourceId: world.resourceId, resourceVersionId: world.revisionId },
        authorizedFacts: "The north river feeds the harbor basin.",
        targetAnchorInput: { kind: "resource", resourceId: world.resourceId, resourceVersionId: world.revisionId },
      },
      {
        evidenceRef: "@evidence2",
        evidenceKind: "committed_text",
        sourceCheckpointId: branch.headCheckpointId,
        scopeResourceId: worldRoot.id,
        defaultCoverageRole: "supporting",
        source: {
          kind: "document", documentId: creative.documentId, documentVersionId, contentSha256: document.contentHash,
        },
        authorizedFacts: content,
        targetAnchorInput: {
          kind: "stable_text_span",
          documentId: creative.documentId,
          documentVersionId,
          startCodePoint: 0,
          endCodePoint: Array.from(content).length,
          textSha256: sha256(content),
        },
      },
    ],
  };
  return {
    workspace,
    goalId: goal.id,
    cycleId: cycle.id,
    worldRevisionId: world.revisionId,
    documentVersionId,
    input: compiledInput,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
