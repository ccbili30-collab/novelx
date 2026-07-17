import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthClosureEvaluator, GROWTH_CLOSURE_FACETS } from "../../src/domain/growth/growthClosureEvaluator";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { GROWTH_LONGFORM_MIN_CODE_POINTS } from "../../src/shared/growthLongformPolicy";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GrowthClosureEvaluator", () => {
  it("evaluates world, story, OC, and explicit mixed profiles from typed pinned evidence", () => {
    const setup = createCompleteSetup("文".repeat(GROWTH_LONGFORM_MIN_CODE_POINTS - 1) + "🌊");
    const evaluator = new GrowthClosureEvaluator(setup.workspace);

    expect(evaluator.evaluate({ checkpointId: setup.checkpointId, profileKind: "world_birth" }))
      .toMatchObject({ deterministicContentReady: true, components: ["world_birth"] });
    expect(evaluator.evaluate({ checkpointId: setup.checkpointId, profileKind: "story_universe" }))
      .toMatchObject({ deterministicContentReady: true, components: ["story_universe"] });
    expect(evaluator.evaluate({ checkpointId: setup.checkpointId, profileKind: "oc_saga", subjectResourceId: setup.ocId }))
      .toMatchObject({
        deterministicContentReady: true,
        components: ["oc_saga"],
        ocPersonalStoryCodePoints: GROWTH_LONGFORM_MIN_CODE_POINTS,
      });
    expect(evaluator.evaluate({
      checkpointId: setup.checkpointId,
      profileKind: "mixed_birth",
      componentProfiles: ["world_birth", "story_universe", "oc_saga"],
      focusOcResourceId: setup.ocId,
    })).toMatchObject({ deterministicContentReady: true, components: ["world_birth", "story_universe", "oc_saga"] });
  });

  it("counts Unicode code points across current pinned prose and excludes superseded versions", () => {
    const setup = createCompleteSetup("文".repeat(GROWTH_LONGFORM_MIN_CODE_POINTS - 2) + "🌊");
    const evaluator = new GrowthClosureEvaluator(setup.workspace);
    const before = evaluator.evaluate({ checkpointId: setup.checkpointId, profileKind: "oc_saga", subjectResourceId: setup.ocId });
    expect(before.ocPersonalStoryCodePoints).toBe(GROWTH_LONGFORM_MIN_CODE_POINTS - 1);
    expect(before.deterministicContentReady).toBe(false);
    expect(before.facetResults.find((facet) => facet.facetId === GROWTH_CLOSURE_FACETS.oc.personalStory)?.state).toBe("missing");

    const checkpoints = new CheckpointRepository(setup.workspace);
    const nextCheckpoint = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "extend personal story");
    const nextVersionId = new DocumentRepository(setup.workspace).putVersion({
      resourceId: setup.storyId,
      creativeDocumentId: setup.proseDocumentId,
      checkpointId: nextCheckpoint,
      content: "文".repeat(Math.floor(GROWTH_LONGFORM_MIN_CODE_POINTS / 2) - 1) + "🌊",
      authorKind: "agent",
    });
    new AssertionRepository(setup.workspace).putVersion({
      assertionId: "personal-story-binding", checkpointId: nextCheckpoint, scopeType: "resource", scopeId: setup.ocId,
      subject: setup.ocId, predicate: GROWTH_CLOSURE_FACETS.oc.personalStoryBinding,
      object: { storyResourceId: setup.storyId }, status: "current", source: { kind: "document_version", ref: nextVersionId },
    });

    expect(evaluator.evaluate({ checkpointId: setup.checkpointId, profileKind: "oc_saga", subjectResourceId: setup.ocId }).ocPersonalStoryCodePoints)
      .toBe(GROWTH_LONGFORM_MIN_CODE_POINTS - 1);
    expect(evaluator.evaluate({ checkpointId: nextCheckpoint, profileKind: "oc_saga", subjectResourceId: setup.ocId }))
      .toMatchObject({ ocPersonalStoryCodePoints: GROWTH_LONGFORM_MIN_CODE_POINTS, deterministicContentReady: true });
  });

  it("does not infer a facet from prose keywords when the typed sourced assertion is absent", () => {
    const setup = createCompleteSetup("文".repeat(9_999) + "🌊", GROWTH_CLOSURE_FACETS.world.cosmologyTime);
    new AssertionRepository(setup.workspace).putVersion({
      assertionId: "wrong-subject-cosmology", checkpointId: setup.checkpointId,
      scopeType: "resource", scopeId: setup.worldId, subject: setup.storyId,
      predicate: GROWTH_CLOSURE_FACETS.world.cosmologyTime, object: { established: true }, status: "current",
      source: { kind: "document_version", ref: setup.settingVersionId },
    });
    const result = new GrowthClosureEvaluator(setup.workspace).evaluate({ checkpointId: setup.checkpointId, profileKind: "world_birth" });
    expect(result.deterministicContentReady).toBe(false);
    expect(result.facetResults.find((facet) => facet.facetId === GROWTH_CLOSURE_FACETS.world.cosmologyTime))
      .toMatchObject({ state: "missing", evidence: [] });
  });

  it("accepts a Change Set evidence_version only when it resolves to a pinned stable document", () => {
    const setup = createCompleteSetup("文".repeat(9_999) + "🌊", undefined, "evidence_version");
    const evaluator = new GrowthClosureEvaluator(setup.workspace);

    expect(evaluator.evaluate({ checkpointId: setup.checkpointId, profileKind: "mixed_birth",
      componentProfiles: ["world_birth", "story_universe", "oc_saga"], focusOcResourceId: setup.ocId }))
      .toMatchObject({ deterministicContentReady: true });

    const unresolved = createCompleteSetup(
      "文".repeat(9_999) + "🌊",
      GROWTH_CLOSURE_FACETS.world.cosmologyTime,
      "evidence_version",
    );
    new AssertionRepository(unresolved.workspace).putVersion({
      assertionId: "unresolved-evidence-version", checkpointId: unresolved.checkpointId,
      scopeType: "resource", scopeId: unresolved.worldId, subject: unresolved.worldId,
      predicate: GROWTH_CLOSURE_FACETS.world.cosmologyTime, object: { established: true }, status: "current",
      source: { kind: "evidence_version", ref: "not-a-pinned-document-version" },
    });
    expect(new GrowthClosureEvaluator(unresolved.workspace)
      .evaluate({ checkpointId: unresolved.checkpointId, profileKind: "world_birth" })
      .facetResults.find((facet) => facet.facetId === GROWTH_CLOSURE_FACETS.world.cosmologyTime))
      .toMatchObject({ state: "missing", evidence: [] });
  });

  it("requires the typed focus-OC personal-story binding as its own facet", () => {
    const setup = createCompleteSetup("文".repeat(9_999) + "🌊");
    const checkpoints = new CheckpointRepository(setup.workspace);
    const nextCheckpoint = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "remove personal story binding");
    new AssertionRepository(setup.workspace).putVersion({
      assertionId: "personal-story-binding", checkpointId: nextCheckpoint,
      scopeType: "resource", scopeId: setup.ocId, subject: setup.ocId,
      predicate: GROWTH_CLOSURE_FACETS.oc.personalStoryBinding,
      object: { storyResourceId: setup.storyId }, status: "superseded",
      source: { kind: "document_version", ref: setup.settingVersionId },
    });

    const result = new GrowthClosureEvaluator(setup.workspace).evaluate({
      checkpointId: nextCheckpoint, profileKind: "oc_saga", subjectResourceId: setup.ocId,
    });
    expect(result.deterministicContentReady).toBe(false);
    expect(result.facetResults.find((facet) => facet.facetId === GROWTH_CLOSURE_FACETS.oc.personalStoryBinding))
      .toMatchObject({ state: "missing", evidence: [] });
    expect(result.ocPersonalStoryCodePoints).toBe(0);
  });

  it("fails closed for malformed profile shapes at the runtime boundary", () => {
    const setup = createCompleteSetup("文".repeat(9_999) + "🌊");
    const evaluator = new GrowthClosureEvaluator(setup.workspace);
    const invalidInputs: unknown[] = [
      { checkpointId: setup.checkpointId, profileKind: "unknown" },
      { checkpointId: setup.checkpointId, profileKind: "mixed_birth", componentProfiles: ["world_birth", "unknown"] },
      { checkpointId: setup.checkpointId, profileKind: "mixed_birth", componentProfiles: ["world_birth"], subjectResourceId: setup.worldId },
      { checkpointId: setup.checkpointId, profileKind: "mixed_birth", componentProfiles: ["oc_saga"], focusOcResourceId: " " },
      { checkpointId: "x".repeat(241), profileKind: "world_birth" },
      { checkpointId: setup.checkpointId, profileKind: "oc_saga", subjectResourceId: "x".repeat(241) },
    ];

    for (const input of invalidInputs) {
      expect(() => evaluator.evaluate(input as Parameters<GrowthClosureEvaluator["evaluate"]>[0]))
        .toThrow(expect.objectContaining({ code: "GROWTH_CLOSURE_EVALUATION_INPUT_INVALID" }));
    }
  });
});

function createCompleteSetup(
  personalStory: string,
  omittedPredicate?: string,
  sourceKind: "document_version" | "evidence_version" = "document_version",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-closure-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  const resources = new ResourceRepository(workspace);
  const documents = new CreativeDocumentRepository(workspace);
  const versions = new DocumentRepository(workspace);
  const relations = new CreativeRelationRepository(workspace);
  const assertions = new AssertionRepository(workspace);
  const checkpoints = new CheckpointRepository(workspace);
  const branch = checkpoints.getActiveBranch();
  const checkpointId = checkpoints.appendCheckpoint(branch.id, "closure fixture");
  const rootsByDomain = new Map(resources.listCurrent().filter((item) => item.objectKind === "domain_root").map((item) => [item.type, item.id]));
  const worldId = resources.putRevision({ resourceId: "world", create: true, checkpointId, type: "world", objectKind: "world", title: "World", parentId: rootsByDomain.get("world")!, state: "active" });
  resources.putRevision({ resourceId: "location", create: true, checkpointId, type: "world", objectKind: "location", title: "Harbor", parentId: worldId, state: "active" });
  resources.putRevision({ resourceId: "faction", create: true, checkpointId, type: "world", objectKind: "faction", title: "Guild", parentId: worldId, state: "active" });
  const storyId = resources.putRevision({ resourceId: "story", create: true, checkpointId, type: "story", objectKind: "story", title: "Story", parentId: rootsByDomain.get("story")!, state: "active" });
  const ocId = resources.putRevision({ resourceId: "oc", create: true, checkpointId, type: "oc", objectKind: "oc", title: "Hero", parentId: rootsByDomain.get("oc")!, state: "active" });

  const settingDocumentId = documents.putRevision({ documentId: "setting", create: true, checkpointId, resourceId: worldId, kind: "setting", title: "Setting", state: "active" });
  const settingVersionId = versions.putVersion({ resourceId: worldId, creativeDocumentId: settingDocumentId, checkpointId, content: "cosmology geography history polity culture power conflict", authorKind: "agent" });
  const personalStoryPoints = Array.from(personalStory);
  const splitAt = Math.floor(personalStoryPoints.length / 2);
  const proseDocumentId = documents.putRevision({ documentId: "prose-a", create: true, checkpointId, resourceId: storyId, kind: "prose", title: "Personal story A", state: "active" });
  const proseVersionId = versions.putVersion({ resourceId: storyId, creativeDocumentId: proseDocumentId, checkpointId, content: personalStoryPoints.slice(0, splitAt).join(""), authorKind: "agent" });
  const secondProseDocumentId = documents.putRevision({ documentId: "prose-b", create: true, checkpointId, resourceId: storyId, kind: "prose", title: "Personal story B", state: "active" });
  versions.putVersion({ resourceId: storyId, creativeDocumentId: secondProseDocumentId, checkpointId, content: personalStoryPoints.slice(splitAt).join(""), authorKind: "agent" });
  const profileDocumentId = documents.putRevision({ documentId: "profile", create: true, checkpointId, resourceId: ocId, kind: "character_profile", title: "Profile", state: "active" });
  const profileVersionId = versions.putVersion({ resourceId: ocId, creativeDocumentId: profileDocumentId, checkpointId, content: "Structured character profile.", authorKind: "agent" });
  relations.putRevision({ relationId: "uses-world", create: true, checkpointId, kind: "uses_world", sourceResourceId: storyId, targetResourceId: worldId, state: "active" });
  relations.putRevision({ relationId: "uses-oc", create: true, checkpointId, kind: "uses_oc", sourceResourceId: storyId, targetResourceId: ocId, state: "active" });
  relations.putRevision({ relationId: "related", create: true, checkpointId, kind: "related_to", sourceResourceId: ocId, targetResourceId: worldId, state: "active" });

  const predicates = [
    ...Object.values(GROWTH_CLOSURE_FACETS.world).filter((id) => id.startsWith("closure.world.fact.")),
    ...Object.values(GROWTH_CLOSURE_FACETS.story).filter((id) => id.startsWith("closure.story.fact.")),
    ...Object.values(GROWTH_CLOSURE_FACETS.oc).filter((id) => id.startsWith("closure.oc.fact.")),
  ];
  for (const [index, predicate] of predicates.entries()) {
    if (predicate === omittedPredicate) continue;
    const scopeId = predicate.startsWith("closure.world") ? worldId : predicate.startsWith("closure.story") ? storyId : ocId;
    const sourceVersion = scopeId === worldId ? settingVersionId : scopeId === storyId ? proseVersionId : profileVersionId;
    assertions.putVersion({ assertionId: `facet-${index}`, checkpointId, scopeType: "resource", scopeId, subject: scopeId, predicate, object: { established: true }, status: "current", source: { kind: sourceKind, ref: sourceVersion } });
  }
  assertions.putVersion({
    assertionId: "personal-story-binding", checkpointId, scopeType: "resource", scopeId: ocId, subject: ocId,
    predicate: GROWTH_CLOSURE_FACETS.oc.personalStoryBinding,
    object: { storyResourceId: storyId }, status: "current", source: { kind: sourceKind, ref: proseVersionId },
  });
  return { workspace, checkpointId, worldId, storyId, ocId, proseDocumentId, settingVersionId };
}
