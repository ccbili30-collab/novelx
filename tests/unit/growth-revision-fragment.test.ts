import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  compileGrowthRevisionFragment,
  growthRevisionFragmentParameters,
} from "../../src/agent-worker/growth/phases/revision/growthRevisionFragment";
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
        { evidenceId: "world-doc-v1", decision: "revise", reasonSummary: "The setting description names the old cultural framing." },
        { evidenceId: "story-doc-v1", decision: "revise", reasonSummary: "The prose tone must follow the new rule." },
        { evidenceId: "oc-doc-v1", decision: "revise", reasonSummary: "The profile should reflect the revised narrative tone." },
        { evidenceId: "assertion-v1", decision: "preserve", reasonSummary: "The lunar rule is unaffected." },
      ],
      additions: [{ kind: "relation", reasonSummary: "Record the explicit cross-domain impact link." }],
    },
    resourceUpdates: [],
    documentUpdates: [
      { evidenceId: "world-doc-v1", title: "Revised world setting", content: "Original western-fantasy setting presented through a restrained light-novel voice without real Japanese elements." },
      { evidenceId: "story-doc-v1", title: "Revised story", content: "The adventure keeps its western-fantasy world while adopting a focused light-novel narrative rhythm." },
      { evidenceId: "oc-doc-v1", title: "Revised OC profile", content: "The character remains grounded in the same history, now described through the requested illustrated-novel tone." },
    ],
    assertionUpdates: [],
    relationRemovals: [],
    resourceAdditions: [],
    documentAdditions: [],
    assertionAdditions: [],
    relationAdditions: [{ localId: "tone_link", kind: "related_to", sourceRef: "story-resource-v1", targetRef: "oc-resource-v1" }],
  } as const;

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
    })).toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
  });

  it("rejects unknown evidence and any attempt to mutate a preserved target", () => {
    expect(() => compileGrowthRevisionFragment({
      ...valid,
      impact: { ...valid.impact, targets: [{ evidenceId: "unknown", decision: "revise", reasonSummary: "Forged." }] },
      documentUpdates: [{ evidenceId: "unknown", title: "Forged", content: "Forged content." }],
      relationAdditions: [],
    }, { cycleId: "cycle", domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" }, authority }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID" }));

    expect(() => compileGrowthRevisionFragment({
      ...valid,
      impact: {
        ...valid.impact,
        targets: valid.impact.targets.map((target) => target.evidenceId === "world-doc-v1"
          ? { ...target, decision: "preserve" }
          : target),
      },
    }, { cycleId: "cycle", domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" }, authority }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH" }));
  });
});
