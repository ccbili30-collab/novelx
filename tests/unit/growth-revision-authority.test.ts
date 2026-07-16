import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { GraphRetrievalService } from "../../src/domain/retrieval/graphRetrievalService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { GrowthRevisionAuthorityResolver } from "../../src/main/growth/phases/revision/growthRevisionAuthorityResolver";

let workspace: WorkspaceDatabase | null = null;
let root: string | null = null;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = null;
  root = null;
});

describe("Growth revision authority resolver", () => {
  it("pins editable identities to the current checkpoint and never trusts model target IDs", () => {
    const setup = createSetup();
    const resolver = new GrowthRevisionAuthorityResolver(setup.workspace);
    const prerequisites = resolver.prerequisites({
      checkpointId: setup.checkpointId,
      authorizedScopeResourceIds: setup.scopeIds,
      focusKinds: ["world", "story", "oc"],
    });
    expect(prerequisites.anchors.map((anchor) => anchor.resourceId).sort())
      .toEqual([setup.worldId, setup.storyId, setup.ocId].sort());
    expect(prerequisites.requiredTargetVersionIds).toEqual(expect.arrayContaining([
      setup.worldDocumentVersionId, setup.storyDocumentVersionId, setup.ocDocumentVersionId,
      setup.assertionVersionId, setup.relationVersionId,
    ]));

    const result = new GraphRetrievalService(setup.workspace).retrieve({
      id: "revision-receipt", cycleId: "revision-cycle", runId: "revision-run", toolInvocationId: "revision-tool",
      branchId: setup.branchId, checkpointId: setup.checkpointId, lens: "creator",
      authorizedScopeResourceIds: setup.scopeIds,
      seedResourceIds: prerequisites.anchors.map((anchor) => anchor.resourceId),
      requiredResourceIds: prerequisites.anchors.map((anchor) => anchor.resourceId),
      requiredTargetVersionIds: prerequisites.requiredTargetVersionIds,
      query: "light novel framing", aliases: prerequisites.anchors.map((anchor) => anchor.title),
      validTime: null, recordedTime: null, maxHops: 1, cpuBudgetMs: 5_000,
      expansionBudget: 1_000, resultBudget: prerequisites.anchors.length + prerequisites.requiredTargetVersionIds.length,
      tokenBudget: 50_000, contentBudgetChars: 200_000, policyVersion: "growth-revision-v1",
    });
    const authority = resolver.resolve(setup.checkpointId, result.hits);
    expect(authority.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "resource", evidenceId: expect.any(String), resourceId: setup.worldId, objectKind: "world" }),
      expect.objectContaining({ kind: "document", evidenceId: setup.storyDocumentVersionId, documentId: setup.storyDocumentId, resourceId: setup.storyId }),
      expect.objectContaining({ kind: "assertion", evidenceId: setup.assertionVersionId, assertionId: "assertion-world-rule", scopeId: setup.worldId }),
      expect.objectContaining({ kind: "relation", evidenceId: setup.relationVersionId, relationId: "relation-story-world", sourceResourceId: setup.storyId, targetResourceId: setup.worldId }),
    ]));

    const forged = result.hits.map((hit) => hit.targetVersionId === setup.storyDocumentVersionId
      ? { ...hit, targetId: "forged-document" }
      : hit);
    expect(() => resolver.resolve(setup.checkpointId, forged))
      .toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-revision-authority-"));
  const opened = openWorkspace(root);
  workspace = opened;
  const resources = new ResourceRepository(opened);
  const creativeDocuments = new CreativeDocumentRepository(opened);
  const documents = new DocumentRepository(opened);
  const assertions = new AssertionRepository(opened);
  const relations = new CreativeRelationRepository(opened);
  const changes = new ChangeSetRepository(opened);
  const branchId = new CheckpointRepository(opened).getActiveBranch().id;
  const roots = new Map(resources.listCurrent().map((resource) => [resource.type, resource.id]));
  let worldId = ""; let storyId = ""; let ocId = "";
  let worldDocumentId = ""; let storyDocumentId = ""; let ocDocumentId = "";
  let worldDocumentVersionId = ""; let storyDocumentVersionId = ""; let ocDocumentVersionId = "";
  let assertionVersionId = ""; let relationVersionId = "";
  const changeSet = changes.propose({ idempotencyKey: "revision-authority-setup", mode: "free", summary: "Seed revision targets" });
  const checkpointId = changes.commit(changeSet.id, "Seed revision targets", (createdCheckpointId) => {
    worldId = resources.putRevision({ checkpointId: createdCheckpointId, type: "world", objectKind: "world", title: "Original world", parentId: roots.get("world")!, state: "active" });
    storyId = resources.putRevision({ checkpointId: createdCheckpointId, type: "story", objectKind: "story", title: "Original story", parentId: roots.get("story")!, state: "active" });
    ocId = resources.putRevision({ checkpointId: createdCheckpointId, type: "oc", objectKind: "oc", title: "Original OC", parentId: roots.get("oc")!, state: "active" });
    worldDocumentId = creativeDocuments.putRevision({ checkpointId: createdCheckpointId, resourceId: worldId, kind: "setting", title: "World setting", state: "active" });
    storyDocumentId = creativeDocuments.putRevision({ checkpointId: createdCheckpointId, resourceId: storyId, kind: "prose", title: "Story prose", state: "active" });
    ocDocumentId = creativeDocuments.putRevision({ checkpointId: createdCheckpointId, resourceId: ocId, kind: "character_profile", title: "OC profile", state: "active" });
    worldDocumentVersionId = documents.putVersion({ resourceId: worldId, creativeDocumentId: worldDocumentId, checkpointId: createdCheckpointId, content: "The original world follows its own western-fantasy history.", authorKind: "agent" });
    storyDocumentVersionId = documents.putVersion({ resourceId: storyId, creativeDocumentId: storyDocumentId, checkpointId: createdCheckpointId, content: "The original story begins at the old border.", authorKind: "agent" });
    ocDocumentVersionId = documents.putVersion({ resourceId: ocId, creativeDocumentId: ocDocumentId, checkpointId: createdCheckpointId, content: "The original OC carries the old oath.", authorKind: "agent" });
    assertionVersionId = assertions.putVersion({ assertionId: "assertion-world-rule", checkpointId: createdCheckpointId, scopeType: "world", scopeId: worldId, subject: "World", predicate: "genre", object: { value: "western fantasy" }, status: "current", source: { kind: "document_version", ref: worldDocumentVersionId } });
    relationVersionId = relations.putRevisionWithReceipt({ relationId: "relation-story-world", create: true, checkpointId: createdCheckpointId, kind: "uses_world", sourceResourceId: storyId, targetResourceId: worldId, state: "active" }).revisionId;
  });
  return {
    workspace: opened, checkpointId, branchId,
    scopeIds: [roots.get("world")!, roots.get("story")!, roots.get("oc")!],
    worldId, storyId, ocId, storyDocumentId,
    worldDocumentVersionId, storyDocumentVersionId, ocDocumentVersionId, assertionVersionId, relationVersionId,
  };
}
