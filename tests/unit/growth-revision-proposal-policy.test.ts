import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileGrowthRevisionFragment } from "../../src/agent-worker/growth/phases/revision/growthRevisionFragment";
import { assertGrowthRevisionProposalAllowed } from "../../src/main/growth/phases/revision/growthRevisionProposalPolicy";
import type { GrowthRevisionAuthority, ProposeChangeSetArgs } from "../../src/shared/agentWorkerProtocol";

describe("Growth Revision proposal policy", () => {
  it("classifies an item dependency outside the proposal without exposing it", () => {
    const proposal = validProposal();
    proposal.items[0]!.dependsOn = ["outside-item"];

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_ITEM_GRAPH_INVALID");
  });

  it("classifies impact evidence outside the pinned authority", () => {
    const proposal = validProposal();
    proposal.growthRevisionImpact!.preservedEvidenceIds.push("outside-evidence");

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_IMPACT_AUTHORITY_INVALID");
  });

  it("classifies conflicting revised and stale impact sets", () => {
    const proposal = validProposal();
    proposal.growthRevisionImpact!.staleVisualEvidenceIds = [];

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_IMPACT_SET_CONFLICT");
  });

  it("classifies a created resource outside the deterministic Cycle namespace", () => {
    const proposal = validProposal();
    proposal.items.push({
      id: "created-resource-item", dependsOn: [], kind: "resource.put",
      payload: {
        resourceId: "forged-resource", create: true, type: "world", objectKind: "location",
        title: "New location", parentId: "world-1", state: "active", sortOrder: 1,
      },
    });

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_CREATED_ID_INVALID");
  });

  it("classifies a document body whose resource owner differs from its creative document", () => {
    const proposal = validProposal();
    const body = proposal.items.find((item) => item.kind === "document.put")!;
    body.payload.resourceId = "story-root";

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_OWNER_INVALID");
  });

  it("classifies assertion evidence outside pinned or same-proposal documents", () => {
    const proposal = validProposal();
    const prefix = revisionPrefix();
    proposal.items.push({
      id: "assertion-item", dependsOn: [], kind: "assertion.put",
      payload: {
        assertionId: `${prefix}-assertion-new`, scopeType: "world", scopeId: "world-1",
        subject: "Moon", predicate: "controls", object: { target: "tides" },
        evidenceIds: ["outside-document-evidence"],
      },
    });

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_ASSERTION_SOURCE_INVALID");
  });

  it("accepts a new assertion sourced from one pinned existing document", () => {
    const proposal = compileGrowthRevisionFragment({
      summary: "Revise the world and record one sourced consequence.",
      impact: {
        summary: "Only the pinned world document changes.",
        targets: [{ targetRef: "@document1", decision: "revise", reasonSummary: "The rule changes this setting." }],
      },
      resourceUpdates: [],
      documentUpdates: [{ targetRef: "@document1", title: "Revised world", content: "A revised sourced world setting." }],
      assertionUpdates: [], relationRemovals: [], resourceAdditions: [], documentAdditions: [],
      assertionAdditions: [{
        localId: "consequence", scopeRef: "@resource1", subject: "Moon", predicate: "controls",
        object: { target: "tides" }, sourceDocumentRefs: ["@document1"],
      }],
      relationAdditions: [],
    }, {
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
    });

    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      proposal,
    })).not.toThrow();
  });

  it("rejects a compiled Closure continuation after its required assertion is removed", () => {
    const requirement = { facetId: "closure.world.fact.history_timeline", scopeResourceId: "world-1" };
    const proposal = compileGrowthRevisionFragment({
      summary: "Record the missing Closure history fact.",
      impact: {
        summary: "The current setting remains the evidence source.",
        targets: [{ targetRef: "@document1", decision: "preserve", reasonSummary: "Pinned source." }],
      },
      resourceUpdates: [], documentUpdates: [], assertionUpdates: [], relationRemovals: [],
      resourceAdditions: [], documentAdditions: [], relationAdditions: [],
      assertionAdditions: [{
        localId: "history", scopeRef: "@resource1", subject: "World",
        predicate: requirement.facetId, object: { established: true }, sourceDocumentRefs: ["@document1"],
      }],
    }, {
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      requiredClosureAssertions: [requirement],
    });
    proposal.items = proposal.items.filter((item) => item.kind !== "assertion.put");
    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority,
      requiredClosureAssertions: [requirement],
      proposal,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_POLICY_CLOSURE_REQUIREMENT_INVALID" }));
  });

  it("classifies a relation endpoint outside pinned or same-proposal resources", () => {
    const proposal = validProposal();
    proposal.items.push({
      id: "relation-item", dependsOn: [], kind: "creative_relation.put",
      payload: {
        relationId: `${revisionPrefix()}-relation-new`, create: true, relationKind: "related_to",
        sourceResourceId: "world-1", targetResourceId: "outside-resource", state: "active",
      },
    });

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_RELATION_ENDPOINT_INVALID");
  });

  it("classifies project-file mutation as forbidden for Revision", () => {
    const proposal = validProposal();
    proposal.items.push({
      id: "project-file-item", dependsOn: [], kind: "project_file.put",
      payload: { path: "world.md", content: "forbidden", expectedSha256: null },
    });

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_FORBIDDEN_MUTATION");
  });

  it("rejects a forged generic Revision of a Longform-managed outline", () => {
    const managedAuthority: GrowthRevisionAuthority = {
      targets: [...authority.targets,
        {
          kind: "resource", evidenceId: "volume-version-1", resourceId: "volume-1",
          type: "story", objectKind: "volume", title: "OC saga", parentId: "story-1", sortOrder: 0,
        },
        {
          kind: "document", evidenceId: "outline-version-1", documentId: "outline-document-1",
          resourceId: "volume-1", documentKind: "writing_constraints", title: "Managed outline", sortOrder: 0,
        }],
    };
    const proposal = compileGrowthRevisionFragment({
      summary: "Attempt to rewrite a managed outline.",
      impact: {
        summary: "The managed outline would change.",
        targets: [{ targetRef: "@document2", decision: "revise", reasonSummary: "Generic repair." }],
      },
      resourceUpdates: [],
      documentUpdates: [{ targetRef: "@document2", title: "Managed outline", content: "Forbidden rewrite." }],
      assertionUpdates: [], relationRemovals: [], resourceAdditions: [], documentAdditions: [],
      assertionAdditions: [], relationAdditions: [],
    }, {
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority: managedAuthority,
    });

    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority: managedAuthority,
      proposal,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_POLICY_LONGFORM_DOCUMENT_FORBIDDEN" }));
  });

  it("rejects a forged generic Revision of Longform-managed section prose", () => {
    const managedAuthority: GrowthRevisionAuthority = {
      targets: [...authority.targets,
        {
          kind: "resource", evidenceId: "volume-version-1", resourceId: "volume-1",
          type: "story", objectKind: "volume", title: "OC saga", parentId: "story-1", sortOrder: 0,
        },
        {
          kind: "document", evidenceId: "section-version-1", documentId: "section-document-1",
          resourceId: "volume-1", documentKind: "prose", title: "Managed section", sortOrder: 1,
        }],
    };
    const proposal = compileGrowthRevisionFragment({
      summary: "Attempt to rewrite managed Longform prose.",
      impact: {
        summary: "The managed section would change.",
        targets: [{ targetRef: "@document2", decision: "revise", reasonSummary: "Generic repair." }],
      },
      resourceUpdates: [],
      documentUpdates: [{ targetRef: "@document2", title: "Managed section", content: "Forbidden rewrite." }],
      assertionUpdates: [], relationRemovals: [], resourceAdditions: [], documentAdditions: [],
      assertionAdditions: [], relationAdditions: [],
    }, {
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority: managedAuthority,
    });

    expect(() => assertGrowthRevisionProposalAllowed({
      cycleId: "cycle-policy",
      domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
      authority: managedAuthority,
      proposal,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_POLICY_LONGFORM_DOCUMENT_FORBIDDEN" }));
  });

  it("classifies a declared revised set that differs from actual mutations", () => {
    const proposal = validProposal();
    proposal.growthRevisionImpact!.revisedEvidenceIds = [];

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_MUTATION_SET_MISMATCH");
  });

  it("classifies a created resource whose parent is outside the authorized scope", () => {
    const proposal = validProposal();
    proposal.items.push({
      id: "created-resource-item", dependsOn: [], kind: "resource.put",
      payload: {
        resourceId: `${revisionPrefix()}-resource-place`, create: true,
        type: "world", objectKind: "location", title: "Place",
        parentId: "outside-parent", state: "active", sortOrder: 1,
      },
    });

    expectPolicyCode(proposal, "GROWTH_REVISION_POLICY_OWNER_INVALID");
  });
});

const authority: GrowthRevisionAuthority = {
  targets: [
    {
      kind: "resource", evidenceId: "world-resource-v1", resourceId: "world-1",
      type: "world", objectKind: "world", title: "World", parentId: "world-root", sortOrder: 0,
    },
    {
      kind: "document", evidenceId: "world-document-v1", documentId: "world-document-1",
      resourceId: "world-1", documentKind: "setting", title: "World setting", sortOrder: 0,
    },
  ],
};

function validProposal(): ProposeChangeSetArgs {
  return structuredClone(compileGrowthRevisionFragment({
    summary: "Revise the pinned world setting.",
    impact: {
      summary: "Only the world setting changes.",
      targets: [{ targetRef: "@document1", decision: "revise", reasonSummary: "The new rule changes this setting." }],
    },
    resourceUpdates: [],
    documentUpdates: [{ targetRef: "@document1", title: "Revised world", content: "A sufficiently explicit revised world setting." }],
    assertionUpdates: [],
    relationRemovals: [],
    resourceAdditions: [],
    documentAdditions: [],
    assertionAdditions: [],
    relationAdditions: [],
  }, {
    cycleId: "cycle-policy",
    domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
    authority,
  }));
}

function expectPolicyCode(proposal: ProposeChangeSetArgs, code: string): void {
  expect(() => assertGrowthRevisionProposalAllowed({
    cycleId: "cycle-policy",
    domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
    authority,
    proposal,
  })).toThrowError(expect.objectContaining({ code }));
}

function revisionPrefix(): string {
  return `growth-${createHash("sha256").update("cycle-policy:revision").digest("hex").slice(0, 20)}`;
}
