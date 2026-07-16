import { describe, expect, it } from "vitest";
import { resolveGrowthPhasePlan } from "../../src/agent-worker/growth/core/growthPhaseRegistry";
import {
  createGrowthPhaseRegistry,
  fixedGrowthPhaseHandler,
} from "../../src/agent-worker/growth/core/growthPhaseHandler";
import { growthRunBindingSchema, type GrowthRunBinding } from "../../src/shared/agentWorkerProtocol";

describe("Growth phase registry characterization", () => {
  it.each([
    ["world", ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set", "generate_image"]],
    ["story", ["retrieve_graph_evidence", "submit_growth_inquiry", "writer", "propose_change_set"]],
    ["oc", ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set"]],
  ] as const)("keeps the %s phase tool order stable", (focus, steps) => {
    expect(resolveGrowthPhasePlan(binding({ focusKinds: [focus] }))).toMatchObject({ phaseId: focus, steps });
  });

  it("routes Longform phases without falling through to generic OC", () => {
    expect(resolveGrowthPhasePlan(binding({
      focusKinds: ["oc"],
      longformAuthority: {
        phase: "outline", outlineId: "outline", mainStoryResourceId: "story", worldResourceId: "world",
        focusOcResourceId: "oc", personalStoryResourceId: "volume",
      },
    }))).toMatchObject({
      phaseId: "longform_outline",
      steps: ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set"],
    });
  });

  it("keeps Closure evaluation and repair mutation boundaries distinct", () => {
    expect(resolveGrowthPhasePlan(binding({
      kind: "closure_evaluation", focusKinds: [], closureProfile: closureProfile(),
    }))).toMatchObject({
      phaseId: "closure_evaluation", objective: "orchestrate",
      steps: ["retrieve_graph_evidence", "submit_closure_self_assessment"],
    });
    expect(resolveGrowthPhasePlan(binding({
      kind: "repair", focusKinds: [], closureRepair: {
        profileId: "profile", revision: 1, originalReviewId: "review", selectedFindingId: "finding",
        selectedFindingFingerprint: "a".repeat(64), safeSummary: "One cited inconsistency requires repair.",
        repairObjective: "Repair one cited inconsistency.",
        targetEvidenceIds: ["evidence"],
      },
    }))).toMatchObject({
      phaseId: "closure_repair", objective: "change_set",
      steps: ["retrieve_graph_evidence", "propose_change_set"],
    });
  });

  it("fails closed for revision and ambiguous phase authority", () => {
    expect(() => resolveGrowthPhasePlan(binding({ kind: "revision", focusKinds: ["oc"] })))
      .toThrow(expect.objectContaining({ code: "STEWARD_GROWTH_REVISION_NOT_IMPLEMENTED" }));
    expect(() => resolveGrowthPhasePlan(binding({ focusKinds: ["world", "oc"] })))
      .toThrow(expect.objectContaining({ code: "GROWTH_PHASE_REGISTRY_INVALID" }));
  });

  it("registers a test phase without changing the top-level Steward state machine", () => {
    const registry = createGrowthPhaseRegistry([
      fixedGrowthPhaseHandler(
        "test_phase",
        (candidate) => candidate.kind === "expand" && candidate.focusKinds[0] === "world",
        "orchestrate",
        ["retrieve_graph_evidence"],
      ),
    ]);
    expect(registry.resolve(binding())).toEqual({
      phaseId: "test_phase",
      objective: "orchestrate",
      steps: ["retrieve_graph_evidence"],
    });
  });

  it("rejects duplicate handlers and ambiguous matches before phase behavior can leak", () => {
    expect(() => createGrowthPhaseRegistry([
      fixedGrowthPhaseHandler("duplicate", () => true, "orchestrate", ["retrieve_graph_evidence"]),
      fixedGrowthPhaseHandler("duplicate", () => false, "change_set", ["propose_change_set"]),
    ])).toThrow(expect.objectContaining({ code: "GROWTH_PHASE_REGISTRY_INVALID" }));

    const registry = createGrowthPhaseRegistry([
      fixedGrowthPhaseHandler("first", () => true, "orchestrate", ["retrieve_graph_evidence"]),
      fixedGrowthPhaseHandler("second", () => true, "change_set", ["propose_change_set"]),
    ]);
    expect(() => registry.resolve(binding()))
      .toThrow(expect.objectContaining({ code: "GROWTH_PHASE_REGISTRY_INVALID" }));
  });
});

function binding(overrides: Partial<GrowthRunBinding> = {}): GrowthRunBinding {
  return growthRunBindingSchema.parse({
    capabilityVersion: "hackathon-growth-closure-v4",
    goalId: "goal", cycleId: "cycle", kind: "expand", focusKinds: ["world"], resumeFrontier: [],
    inputCheckpointId: "checkpoint", ruleRevision: 1,
    authorizedScopeResourceIds: ["world-root", "oc-root", "story-root"], seedResourceIds: [],
    domainRootResourceIds: { world: "world-root", oc: "oc-root", story: "story-root" },
    greenfieldCreateAuthorized: false,
    priorInquiries: [], closureProfile: null, closureRepair: null, longformAuthority: null,
    ...overrides,
  });
}

function closureProfile(): NonNullable<GrowthRunBinding["closureProfile"]> {
  return {
    profileId: "profile", revision: 1, profileKind: "mixed_birth", subjectResourceId: null,
    componentProfiles: ["world_birth", "story_universe", "oc_saga"], focusOcResourceId: "oc",
    requiredContentFacetIds: ["closure.world.structure.resource"],
  };
}
