import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  compileGrowthRevisionFragment,
  growthRevisionFragmentParameters,
} from "../../src/agent-worker/growth/phases/revision/growthRevisionFragment";
import { createGrowthRevisionReferenceCatalog } from "../../src/agent-worker/growth/phases/revision/growthRevisionReferences";
import { assertGrowthRevisionProposalAllowed } from "../../src/main/growth/phases/revision/growthRevisionProposalPolicy";
import type { GrowthRevisionAuthority } from "../../src/shared/agentWorkerProtocol";

describe("Growth revision Fragment compiler", () => {
  const authority: GrowthRevisionAuthority = {
    targets: [
      { kind: "resource", evidenceId: "world-resource-v1", resourceId: "world-1", type: "world", objectKind: "world", title: "Old world", parentId: "world-root", sortOrder: 0 },
      { kind: "resource", evidenceId: "story-resource-v1", resourceId: "story-1", type: "story", objectKind: "story", title: "Old story", parentId: "story-root", sortOrder: 0 },
      { kind: "resource", evidenceId: "oc-resource-v1", resourceId: "oc-1", type: "oc", objectKind: "oc", title: "Old OC", parentId: "oc-root", sortOrder: 0 },
      { kind: "document", evidenceId: "world-doc-v1", documentId: "world-doc", resourceId: "world-1", documentKind: "setting", title: "World setting", sortOrder: 0 },
      { kind: "document", evidenceId: "story-doc-v1", documentId: "story-doc", resourceId: "story-1", documentKind: "prose", title: "Story", sortOrder: 0 },
      { kind: "document", evidenceId: "oc-doc-v1", documentId: "oc-doc", resourceId: "oc-1", documentKind: "character_profile", title: "OC profile", sortOrder: 0 },
      { kind: "assertion", evidenceId: "assertion-v1", assertionId: "assertion-1", scopeType: "world", scopeId: "world-1", subject: "Moon", predicate: "controls", object: { target: "tides" } },
    ],
  };
  const valid = {
    summary: "Apply the new light-novel framing across the linked world, story, and OC.",
    impact: {
      summary: "The narrative presentation changes while the established lunar fact remains intact.",
      targets: [
        { targetRef: "@document1", decision: "revise", reasonSummary: "The setting description names the old cultural framing." },
        { targetRef: "@document2", decision: "revise", reasonSummary: "The prose tone must follow the new rule." },
        { targetRef: "@document3", decision: "revise", reasonSummary: "The profile should reflect the revised narrative tone." },
        { targetRef: "@assertion1", decision: "preserve", reasonSummary: "The lunar rule is unaffected." },
      ],
    },
    resourceUpdates: [],
    documentUpdates: [
      { targetRef: "@document1", title: "Revised world setting", content: "Original western-fantasy setting presented through a restrained light-novel voice without real Japanese elements." },
      { targetRef: "@document2", title: "Revised story", content: "The adventure keeps its western-fantasy world while adopting a focused light-novel narrative rhythm." },
      { targetRef: "@document3", title: "Revised OC profile", content: "The character remains grounded in the same history, now described through the requested illustrated-novel tone." },
    ],
    assertionUpdates: [],
    relationRemovals: [],
    resourceAdditions: [],
    documentAdditions: [],
    assertionAdditions: [],
    relationAdditions: [{ localId: "tone_link", kind: "related_to", sourceRef: "@resource2", targetRef: "@resource3" }],
  } as const;

  it("derives stable disjoint aliases without exposing persisted identities", () => {
    const catalog = createGrowthRevisionReferenceCatalog(authority);
    expect(catalog.map(({ ref, kind }) => ({ ref, kind }))).toEqual([
      { ref: "@resource1", kind: "resource" },
      { ref: "@resource2", kind: "resource" },
      { ref: "@resource3", kind: "resource" },
      { ref: "@document1", kind: "document" },
      { ref: "@document2", kind: "document" },
      { ref: "@document3", kind: "document" },
      { ref: "@assertion1", kind: "assertion" },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("world-resource-v1");
    expect(JSON.stringify(catalog)).not.toContain("world-1");
  });

  it("compiles cross-domain edits into one low-level Change Set without model authority fields", () => {
    expect(Value.Check(growthRevisionFragmentParameters, valid)).toBe(true);
    const proposal = compileGrowthRevisionFragment(valid, {
      cycleId: "cycle-revision-2",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
    });
    expect(proposal.items).toHaveLength(7);
    expect(proposal.items.filter((item) => item.kind === "creative_document.put")).toHaveLength(3);
    expect(proposal.items.filter((item) => item.kind === "document.put").map((item) => item.payload.content))
      .toEqual(valid.documentUpdates.map((item) => item.content));
    expect(proposal.growthRevisionImpact?.staleVisualEvidenceIds)
      .toEqual(["world-doc-v1", "story-doc-v1", "oc-doc-v1"]);
    expect(proposal.items.at(-1)).toMatchObject({
      kind: "creative_relation.put",
      payload: { create: true, relationKind: "related_to", sourceResourceId: "story-1", targetResourceId: "oc-1" },
    });
    expect(JSON.stringify(proposal.items)).not.toContain("assertion-v1");
    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-revision-2",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      proposal,
    })).not.toThrow();

    const forged = {
      ...proposal,
      items: proposal.items.map((item) => item.kind === "creative_document.put" && !item.payload.create
        ? { ...item, payload: { ...item.payload, documentId: "outside-receipt-document" } }
        : item),
    };
    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-revision-2",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      proposal: forged,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_POLICY_EXISTING_TARGET_INVALID" }));
  });

  it("keeps legal resource, document and assertion additions accepted by Main authorization", () => {
    const fragment = {
      ...valid,
      relationAdditions: [],
      resourceAdditions: [{ localId: "harbor", kind: "location", title: "Moon Harbor", parentRef: "@resource1" }],
      documentAdditions: [{
        localId: "harbor_note", ownerRef: "harbor", kind: "location_profile",
        title: "Moon Harbor", content: "The harbor follows the revised lunar navigation rule.",
      }],
      assertionAdditions: [{
        localId: "harbor_fact", scopeRef: "harbor", subject: "Moon Harbor", predicate: "uses",
        object: { target: "lunar navigation" }, sourceDocumentRefs: ["harbor_note"],
      }],
    } as const;
    const proposal = compileGrowthRevisionFragment(fragment, {
      cycleId: "cycle-revision-additions",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
    });

    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-revision-additions",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      proposal,
    })).not.toThrow();
  });

  it("compiles every trusted Closure fact requirement to its exact scoped assertion", () => {
    const requirement = { facetId: "closure.world.fact.history_timeline", scopeResourceId: "world-1" };
    const fragment = {
      ...valid,
      impact: {
        summary: "The pinned setting remains the source for the missing Closure fact.",
        targets: [{ targetRef: "@document1", decision: "preserve", reasonSummary: "Use it as evidence." }],
      },
      documentUpdates: [],
      relationAdditions: [],
      assertionAdditions: [{
        localId: "history", scopeRef: "@resource1", subject: "model supplied label is not authority",
        predicate: requirement.facetId, object: { established: "The harbor succession crisis began after the third reversed tide." },
        sourceDocumentRefs: ["@document1"],
      }],
    } as const;
    const proposal = compileGrowthRevisionFragment(fragment, {
      cycleId: "cycle-closure-continuation",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      requiredClosureAssertions: [requirement],
    });
    expect(proposal.items.find((item) => item.kind === "assertion.put")).toMatchObject({
      payload: {
        scopeId: "world-1", subject: "world-1", predicate: requirement.facetId,
        evidenceIds: ["world-doc-v1"],
      },
    });
    expect(() => compileGrowthRevisionFragment({ ...fragment, assertionAdditions: [] }, {
      cycleId: "cycle-closure-continuation",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      requiredClosureAssertions: [requirement],
    })).toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_FRAGMENT_CLOSURE_REQUIREMENT_INVALID" }));
  });

  it("binds an assertion update to the new version of a document updated in the same Change Set", () => {
    const fragment = {
      ...valid,
      impact: {
        ...valid.impact,
        targets: valid.impact.targets.map((target) => target.targetRef === "@assertion1"
          ? { ...target, decision: "revise" as const, reasonSummary: "The assertion follows the revised setting source." }
          : target),
      },
      assertionUpdates: [{
        targetRef: "@assertion1",
        subject: "Moon",
        predicate: "controls",
        object: { target: "revised tides" },
        sourceDocumentRefs: ["@document1"],
      }],
      relationAdditions: [],
    } as const;
    const proposal = compileGrowthRevisionFragment(fragment, {
      cycleId: "cycle-revision-document-source",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
    });
    const revisedDocument = proposal.items.find((item) => item.kind === "document.put"
      && item.payload.creativeDocumentId === "world-doc");
    const revisedAssertion = proposal.items.find((item) => item.kind === "assertion.put");

    expect(revisedDocument).toBeDefined();
    expect(revisedAssertion).toMatchObject({
      dependsOn: expect.arrayContaining([revisedDocument!.id]),
      payload: {
        assertionId: "assertion-1",
        evidenceIds: [`greenfield_document_output:${revisedDocument!.id}`],
      },
    });
    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-revision-document-source",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      proposal,
    })).not.toThrow();
  });

  it("keeps a pinned relation removal accepted by Main authorization", () => {
    const authorityWithRelation: GrowthRevisionAuthority = {
      targets: [...authority.targets, {
        kind: "relation", evidenceId: "relation-v1", relationId: "relation-1",
        relationKind: "related_to", sourceResourceId: "story-1", targetResourceId: "oc-1",
      }],
    };
    const fragment = {
      ...valid,
      impact: {
        ...valid.impact,
        targets: [...valid.impact.targets, {
          targetRef: "@relation1", decision: "revise", reasonSummary: "The old relationship is no longer valid.",
        }],
      },
      relationRemovals: [{ targetRef: "@relation1" }],
      relationAdditions: [],
    } as const;
    const proposal = compileGrowthRevisionFragment(fragment, {
      cycleId: "cycle-revision-removal",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority: authorityWithRelation,
    });

    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-revision-removal",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority: authorityWithRelation,
      proposal,
    })).not.toThrow();
  });

  it("rejects unknown evidence and any attempt to mutate a preserved target", () => {
    expect(() => compileGrowthRevisionFragment({
      ...valid,
      impact: { ...valid.impact, targets: [{ targetRef: "@document99", decision: "revise", reasonSummary: "Forged." }] },
      documentUpdates: [{ targetRef: "@document99", title: "Forged", content: "Forged content." }],
      relationAdditions: [],
    }, { cycleId: "cycle", domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" }, authority }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID" }));

    expect(() => compileGrowthRevisionFragment({
      ...valid,
      impact: {
        ...valid.impact,
        targets: valid.impact.targets.map((target) => target.targetRef === "@document1"
          ? { ...target, decision: "preserve" }
          : target),
      },
    }, { cycleId: "cycle", domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" }, authority }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH" }));
  });

  it("rejects raw persisted identities where an existing target alias is required", () => {
    expect(growthRevisionFragmentParameters).toBeDefined();
    expect(Value.Check(growthRevisionFragmentParameters, {
      ...valid,
      impact: {
        ...valid.impact,
        targets: [{ ...valid.impact.targets[0], targetRef: "world-doc-v1" }],
      },
      documentUpdates: [{ ...valid.documentUpdates[0], targetRef: "world-doc-v1" }],
    })).toBe(false);
  });

  it("returns distinct safe correction instructions for authority and impact failures", () => {
    const authorityFailure = captureRevisionFailure(() => compileGrowthRevisionFragment({
      ...valid,
      impact: {
        ...valid.impact,
        targets: [{ targetRef: "@document99", decision: "revise", reasonSummary: "Forged." }],
      },
      documentUpdates: [{ targetRef: "@document99", title: "Forged", content: "SECRET-CONTENT" }],
      relationAdditions: [],
    }, { cycleId: "cycle", domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" }, authority }));
    const impactFailure = captureRevisionFailure(() => compileGrowthRevisionFragment({
      ...valid,
      documentUpdates: valid.documentUpdates.slice(0, 2),
    }, { cycleId: "cycle", domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" }, authority }));

    expect(authorityFailure).toMatchObject({ code: "GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID" });
    expect(authorityFailure.message).toContain("Use only aliases from revisionReferences");
    expect(impactFailure).toMatchObject({ code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH" });
    expect(impactFailure.message).toContain("Every targetRef marked revise must appear exactly once");
    expect(authorityFailure.message).not.toBe(impactFailure.message);
    expect(`${authorityFailure.message}${impactFailure.message}`).not.toContain("SECRET-CONTENT");
  });

  it.each([
    ["GROWTH_REVISION_FRAGMENT_OWNER_REF_INVALID", {
      documentAdditions: [{ localId: "note", ownerRef: "missing-owner", kind: "knowledge_note", title: "Note", content: "Safe content." }],
    }],
    ["GROWTH_REVISION_FRAGMENT_SCOPE_REF_INVALID", {
      assertionAdditions: [{ localId: "fact", scopeRef: "missing-scope", subject: "Moon", predicate: "shapes", object: { target: "tides" }, sourceDocumentRefs: ["world-doc-v1"] }],
    }],
    ["GROWTH_REVISION_FRAGMENT_DOCUMENT_SOURCE_REF_INVALID", {
      assertionAdditions: [{ localId: "fact", scopeRef: "@resource1", subject: "Moon", predicate: "shapes", object: { target: "tides" }, sourceDocumentRefs: ["missing-document"] }],
    }],
    ["GROWTH_REVISION_FRAGMENT_RELATION_ENDPOINT_REF_INVALID", {
      relationAdditions: [{ ...valid.relationAdditions[0], targetRef: "missing-target" }],
    }],
    ["GROWTH_REVISION_FRAGMENT_PARENT_REF_INVALID", {
      resourceAdditions: [{ localId: "harbor", kind: "location", title: "Harbor", parentRef: "@resource2" }],
    }],
  ] as const)("classifies %s without exposing the invalid reference", (expectedCode, overrides) => {
    const failure = captureRevisionFailure(() => compileGrowthRevisionFragment({ ...valid, ...overrides }, {
      cycleId: "cycle",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
    }));

    expect(failure.code).toBe(expectedCode);
    expect(failure.message).not.toContain("missing-");
  });

  it("rejects a document kind that the authoritative owner policy does not allow", () => {
    const failure = captureRevisionFailure(() => compileGrowthRevisionFragment({
      ...valid,
      relationAdditions: [],
      resourceAdditions: [{ localId: "harbor", kind: "location", title: "Moon Harbor", parentRef: "@resource1" }],
      documentAdditions: [{
        localId: "harbor_setting", ownerRef: "harbor", kind: "setting",
        title: "Moon Harbor", content: "The harbor follows the revised lunar navigation rule.",
      }],
    }, {
      cycleId: "cycle",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
    }));

    expect(failure).toMatchObject({ code: "GROWTH_REVISION_FRAGMENT_DOCUMENT_OWNER_KIND_INVALID" });
    expect(failure.message).toContain("location_profile for location");
  });
});

function captureRevisionFailure(run: () => unknown): Error & { code?: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected Growth Revision compilation to fail.");
}
