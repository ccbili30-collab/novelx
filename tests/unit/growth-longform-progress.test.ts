import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveGrowthLongformOutlineDocumentId } from "../../src/agent-worker/growth/growthLongformOutline";
import { deriveGrowthLongformSectionDocumentId } from "../../src/agent-worker/growth/growthLongformSection";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { GrowthLongformProgressResolver } from "../../src/domain/growth/growthLongformProgress";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GrowthLongformProgressResolver", () => {
  it("resolves the committed outline, completed section evidence, and first pending section", () => {
    const setup = createSetup();
    addSection(setup, "origin", "第一节正文");
    addUnrelatedProse(setup, "main-story-prose", setup.mainStoryId);
    addUnrelatedProse(setup, "unrelated-volume-prose", setup.personalStoryId);

    expect(new GrowthLongformProgressResolver(setup.workspace).resolve({
      checkpointId: setup.checkpointId,
      focusOcResourceId: setup.ocId,
    })).toMatchObject({
      status: "ready",
      mainStoryResourceId: setup.mainStoryId,
      worldResourceId: setup.worldId,
      personalStoryResourceId: setup.personalStoryId,
      outline: {
        outlineId: "outline-1",
        documentId: deriveGrowthLongformOutlineDocumentId(setup.personalStoryId, "outline-1"),
      },
      completedSections: [{
        outlineSectionId: "origin",
        documentId: deriveGrowthLongformSectionDocumentId(setup.personalStoryId, "outline-1", "origin"),
        documentVersionId: setup.sectionVersions.get("origin"),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        evidenceId: setup.sectionVersions.get("origin"),
      }],
      nextSection: { outlineSectionId: "reckoning" },
      complete: false,
    });
  });

  it("uses the pinned checkpoint and reports completion only after every deterministic section document is stable", () => {
    const setup = createSetup();
    addSection(setup, "origin", "第一节正文");
    const before = setup.checkpointId;
    const next = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "finish longform");
    setup.checkpointId = next;
    addSection(setup, "reckoning", "第二节正文");
    const resolver = new GrowthLongformProgressResolver(setup.workspace);

    expect(resolver.resolve({ checkpointId: before, focusOcResourceId: setup.ocId })).toMatchObject({
      status: "ready", complete: false, nextSection: { outlineSectionId: "reckoning" },
    });
    expect(resolver.resolve({ checkpointId: next, focusOcResourceId: setup.ocId })).toMatchObject({
      status: "ready", complete: true, nextSection: null,
      completedSections: [{ outlineSectionId: "origin" }, { outlineSectionId: "reckoning" }],
    });
  });

  it("rejects out-of-order sections instead of treating later prose as valid progress", () => {
    const setup = createSetup();
    addSection(setup, "reckoning", "第二节正文");
    expect(resolve(setup)).toMatchObject({
      status: "blocked", reason: "GROWTH_LONGFORM_SECTION_ORDER_INVALID",
    });
  });

  it("fails closed for missing or ambiguous current sourced personal-story bindings", () => {
    const missing = createSetup({ bindPersonalStory: false });
    expect(resolve(missing)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING" });

    const ambiguous = createSetup();
    new AssertionRepository(ambiguous.workspace).putVersion({
      assertionId: "personal-story-binding-2",
      checkpointId: ambiguous.checkpointId,
      scopeType: "oc",
      scopeId: ambiguous.ocId,
      subject: ambiguous.ocId,
      predicate: "closure.oc.binding.personal_story",
      object: { storyResourceId: ambiguous.personalStoryId },
      status: "current",
      source: { kind: "document_version", ref: ambiguous.outlineVersionId },
    });
    expect(resolve(ambiguous)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_AMBIGUOUS" });

    const invalidSource = createSetup({ bindPersonalStory: false });
    new AssertionRepository(invalidSource.workspace).putVersion({
      assertionId: "personal-story-binding-invalid-source",
      checkpointId: invalidSource.checkpointId,
      scopeType: "oc",
      scopeId: invalidSource.ocId,
      subject: invalidSource.ocId,
      predicate: "closure.oc.binding.personal_story",
      object: { storyResourceId: invalidSource.personalStoryId },
      status: "current",
      source: { kind: "opaque", ref: "not-a-pinned-outline-version" },
    });
    expect(resolve(invalidSource)).toMatchObject({
      status: "blocked", reason: "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_SOURCE_INVALID",
    });
  });

  it("rejects an invalid personal-story target and ambiguous structural roots without guessing", () => {
    const invalidTarget = createSetup({ bindPersonalStory: false });
    new AssertionRepository(invalidTarget.workspace).putVersion({
      assertionId: "invalid-personal-story-binding",
      checkpointId: invalidTarget.checkpointId,
      scopeType: "oc",
      scopeId: invalidTarget.ocId,
      subject: invalidTarget.ocId,
      predicate: "closure.oc.binding.personal_story",
      object: { storyResourceId: invalidTarget.mainStoryId },
      status: "current",
      source: { kind: "document_version", ref: invalidTarget.outlineVersionId },
    });
    expect(resolve(invalidTarget)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_PERSONAL_STORY_RESOURCE_INVALID" });

    const ambiguousWorld = createSetup();
    const rootsByDomain = domainRoots(ambiguousWorld.workspace);
    new ResourceRepository(ambiguousWorld.workspace).putRevision({
      resourceId: "world-2", create: true, checkpointId: ambiguousWorld.checkpointId,
      type: "world", objectKind: "world", title: "Second world", parentId: rootsByDomain.get("world")!, state: "active",
    });
    expect(resolve(ambiguousWorld)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_WORLD_NOT_UNIQUE" });
  });

  it("requires the personal-story volume to remain bound to the unique world and focus OC", () => {
    const missing = createSetup({ bindRelations: false });
    expect(resolve(missing)).toMatchObject({
      status: "blocked", reason: "GROWTH_LONGFORM_PERSONAL_STORY_RELATIONS_INVALID",
    });

    const wrongOc = createSetup({ bindRelations: false });
    const rootsByDomain = domainRoots(wrongOc.workspace);
    const otherOcId = new ResourceRepository(wrongOc.workspace).putRevision({
      resourceId: "other-oc", create: true, checkpointId: wrongOc.checkpointId,
      type: "oc", objectKind: "oc", title: "Other OC", parentId: rootsByDomain.get("oc")!, state: "active",
    });
    const relations = new CreativeRelationRepository(wrongOc.workspace);
    relations.putRevision({ checkpointId: wrongOc.checkpointId, kind: "uses_world", sourceResourceId: wrongOc.personalStoryId, targetResourceId: wrongOc.worldId, state: "active" });
    relations.putRevision({ checkpointId: wrongOc.checkpointId, kind: "uses_oc", sourceResourceId: wrongOc.personalStoryId, targetResourceId: otherOcId, state: "active" });
    expect(resolve(wrongOc)).toMatchObject({
      status: "blocked", reason: "GROWTH_LONGFORM_PERSONAL_STORY_RELATIONS_INVALID",
    });
  });

  it("requires one strict, identity-matched persisted outline and ignores arbitrary prose identities", () => {
    const malformed = createSetup({ outlineContent: JSON.stringify({ outlineId: "outline-1", storyTitle: "bad" }) });
    expect(resolve(malformed)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_OUTLINE_INVALID" });

    const wrongIdentity = createSetup({ outlineDocumentId: "arbitrary-outline-document" });
    expect(resolve(wrongIdentity)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_OUTLINE_IDENTITY_MISMATCH" });

    const ambiguous = createSetup();
    const documents = new CreativeDocumentRepository(ambiguous.workspace);
    const versions = new DocumentRepository(ambiguous.workspace);
    const extraId = documents.putRevision({
      documentId: "extra-outline", create: true, checkpointId: ambiguous.checkpointId,
      resourceId: ambiguous.personalStoryId, kind: "writing_constraints", title: "Other outline", state: "active",
    });
    versions.putVersion({
      resourceId: ambiguous.personalStoryId, creativeDocumentId: extraId, checkpointId: ambiguous.checkpointId,
      content: outlineContent(), authorKind: "agent",
    });
    expect(resolve(ambiguous)).toMatchObject({ status: "blocked", reason: "GROWTH_LONGFORM_OUTLINE_DOCUMENT_AMBIGUOUS" });
  });

  it("rejects malformed resolver authority before reading Domain state", () => {
    const setup = createSetup();
    const resolver = new GrowthLongformProgressResolver(setup.workspace);
    expect(() => resolver.resolve({ checkpointId: "missing-checkpoint", focusOcResourceId: setup.ocId }))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_PROGRESS_INPUT_INVALID" }));
    expect(() => resolver.resolve({ checkpointId: setup.checkpointId, focusOcResourceId: " " }))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_PROGRESS_INPUT_INVALID" }));
  });
});

interface Setup {
  workspace: WorkspaceDatabase;
  branchId: string;
  checkpointId: string;
  worldId: string;
  mainStoryId: string;
  ocId: string;
  personalStoryId: string;
  outlineVersionId: string;
  sectionVersions: Map<string, string>;
}

function createSetup(options: {
  bindPersonalStory?: boolean;
  bindRelations?: boolean;
  outlineContent?: string;
  outlineDocumentId?: string;
} = {}): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-longform-progress-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  const resources = new ResourceRepository(workspace);
  const documents = new CreativeDocumentRepository(workspace);
  const versions = new DocumentRepository(workspace);
  const checkpoints = new CheckpointRepository(workspace);
  const branchId = checkpoints.getActiveBranch().id;
  const checkpointId = checkpoints.appendCheckpoint(branchId, "longform progress fixture");
  const rootsByDomain = domainRoots(workspace);
  const worldId = resources.putRevision({ resourceId: "world", create: true, checkpointId, type: "world", objectKind: "world", title: "World", parentId: rootsByDomain.get("world")!, state: "active" });
  const mainStoryId = resources.putRevision({ resourceId: "main-story", create: true, checkpointId, type: "story", objectKind: "story", title: "Main story", parentId: rootsByDomain.get("story")!, state: "active" });
  const ocId = resources.putRevision({ resourceId: "focus-oc", create: true, checkpointId, type: "oc", objectKind: "oc", title: "Focus OC", parentId: rootsByDomain.get("oc")!, state: "active" });
  const personalStoryId = resources.putRevision({
    resourceId: "personal-story", create: true, checkpointId, type: "story",
    objectKind: "volume", title: "Personal story",
    parentId: mainStoryId, state: "active",
  });
  const outlineDocumentId = documents.putRevision({
    documentId: options.outlineDocumentId ?? deriveGrowthLongformOutlineDocumentId(personalStoryId, "outline-1"),
    create: true, checkpointId, resourceId: personalStoryId, kind: "writing_constraints", title: "Longform outline", state: "active",
  });
  const outlineVersionId = versions.putVersion({
    resourceId: personalStoryId, creativeDocumentId: outlineDocumentId, checkpointId,
    content: options.outlineContent ?? outlineContent(), authorKind: "agent",
  });
  if (options.bindPersonalStory !== false) {
    new AssertionRepository(workspace).putVersion({
      assertionId: "personal-story-binding", checkpointId, scopeType: "oc", scopeId: ocId,
      subject: ocId, predicate: "closure.oc.binding.personal_story", object: { storyResourceId: personalStoryId },
      status: "current", source: { kind: "document_version", ref: outlineVersionId },
    });
  }
  if (options.bindRelations !== false) {
    const relations = new CreativeRelationRepository(workspace);
    relations.putRevision({ checkpointId, kind: "uses_world", sourceResourceId: personalStoryId, targetResourceId: worldId, state: "active" });
    relations.putRevision({ checkpointId, kind: "uses_oc", sourceResourceId: personalStoryId, targetResourceId: ocId, state: "active" });
  }
  return {
    workspace, branchId, checkpointId, worldId, mainStoryId, ocId, personalStoryId, outlineVersionId,
    sectionVersions: new Map(),
  };
}

function addSection(setup: Setup, sectionLocalId: string, content: string): void {
  const documentId = deriveGrowthLongformSectionDocumentId(setup.personalStoryId, "outline-1", sectionLocalId);
  new CreativeDocumentRepository(setup.workspace).putRevision({
    documentId, create: true, checkpointId: setup.checkpointId, resourceId: setup.personalStoryId,
    kind: "prose", title: sectionLocalId, state: "active",
  });
  const versionId = new DocumentRepository(setup.workspace).putVersion({
    resourceId: setup.personalStoryId, creativeDocumentId: documentId, checkpointId: setup.checkpointId,
    content, authorKind: "agent",
  });
  setup.sectionVersions.set(sectionLocalId, versionId);
}

function addUnrelatedProse(setup: Setup, documentId: string, resourceId: string): void {
  new CreativeDocumentRepository(setup.workspace).putRevision({
    documentId, create: true, checkpointId: setup.checkpointId, resourceId,
    kind: "prose", title: "Unrelated prose", state: "active",
  });
  new DocumentRepository(setup.workspace).putVersion({
    resourceId, creativeDocumentId: documentId, checkpointId: setup.checkpointId,
    content: "This prose is not a deterministic Longform section.", authorKind: "agent",
  });
}

function resolve(setup: Setup) {
  return new GrowthLongformProgressResolver(setup.workspace).resolve({
    checkpointId: setup.checkpointId,
    focusOcResourceId: setup.ocId,
  });
}

function domainRoots(workspace: WorkspaceDatabase): Map<string, string> {
  return new Map(new ResourceRepository(workspace).listCurrent()
    .filter((resource) => resource.objectKind === "domain_root")
    .map((resource) => [resource.type, resource.id]));
}

function outlineContent(): string {
  return JSON.stringify({
    outlineId: "outline-1",
    storyTitle: "潮汐债务",
    summary: "围绕焦点角色展开的独立长篇。",
    sections: [
      {
        localId: "origin", title: "起源", objective: "建立角色选择与代价。",
        evidenceIds: ["world-evidence", "oc-evidence"], continuityConstraints: ["记忆代价不可无故消失。"],
        estimatedCodePoints: { min: 5_000, max: 5_500 },
      },
      {
        localId: "reckoning", title: "偿还", objective: "完成代价的阶段性结算。",
        evidenceIds: ["world-evidence", "oc-evidence"], continuityConstraints: ["结局必须回应起源选择。"],
        estimatedCodePoints: { min: 5_000, max: 5_500 },
      },
    ],
  });
}
