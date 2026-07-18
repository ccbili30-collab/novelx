import { describe, expect, it } from "vitest";
import {
  evaluateWorldScaleClosure,
  WORLD_SCALE_DEFAULT_REQUIREMENTS,
  type WorldScaleClosureProjection,
} from "../../src/domain/growth/closure/worldScaleClosureProfile";

describe("world scale Closure profile", () => {
  it("accepts exactly the default large-world skeleton with source-bound evidence", () => {
    const result = evaluateWorldScaleClosure(completeProjection());
    expect(result.ready).toBe(true);
    expect(result.facets).toHaveLength(11);
    expect(result.facets.every((facet) => facet.state === "satisfied" && facet.evidenceRefs.length > 0)).toBe(true);
    expect(WORLD_SCALE_DEFAULT_REQUIREMENTS).toEqual({
      worlds: 1, macroRegions: 3, polityOrCivilizationGroups: 4, representedMacroRegions: 2,
      eras: 4, historicalTurningPoints: 3, crossSystemCausalMechanisms: 4,
    });
  });

  it("reports each real scale gap instead of treating a small setting as complete", () => {
    const input = completeProjection();
    input.entityRoles = input.entityRoles.filter((item) => ![
      "region_3", "group_4", "mountains", "sea", "river", "transport", "resources",
    ].includes(item.entityRef));
    input.eras.pop();
    input.historicalTurningPoints.pop();
    input.causalMechanisms.pop();
    const result = evaluateWorldScaleClosure(input);
    expect(result.ready).toBe(false);
    expect(result.facets.filter((facet) => facet.state === "missing").map((facet) => facet.facetId)).toEqual([
      "macro_regions", "polity_civilization_groups", "geography_mountains", "geography_seas",
      "geography_rivers", "transport", "resource_distribution", "historical_eras",
      "historical_turning_points", "cross_system_causal_mechanisms",
    ]);
    expect(result.facets.filter((facet) => facet.state === "missing").every((facet) => facet.evidenceRefs.length === 0)).toBe(true);
  });

  it("requires four groups to be distributed across at least two declared macro regions", () => {
    const input = completeProjection();
    for (const group of input.entityRoles.filter((item) => item.role === "polity" || item.role === "civilization_group")) {
      group.macroRegionRef = "region_1";
    }
    expect(evaluateWorldScaleClosure(input).facets.find((facet) => facet.facetId === "polity_civilization_groups"))
      .toMatchObject({ state: "missing", actual: 4, required: 4, evidenceRefs: [] });
  });

  it("fails closed for unsourced nodes, invalid region bindings and non-cross-system mechanisms", () => {
    const unsourced = completeProjection();
    unsourced.eras[0].evidenceRefs = [];
    expectCode(() => evaluateWorldScaleClosure(unsourced), "WORLD_SCALE_EVIDENCE_REQUIRED");

    const region = completeProjection();
    region.entityRoles.find((item) => item.entityRef === "group_1")!.macroRegionRef = "missing";
    expectCode(() => evaluateWorldScaleClosure(region), "WORLD_SCALE_GROUP_REGION_INVALID");

    const causal = completeProjection();
    causal.causalMechanisms[0].systemRefs = ["economy", "economy"];
    expectCode(() => evaluateWorldScaleClosure(causal), "WORLD_SCALE_CAUSAL_MECHANISM_NOT_CROSS_SYSTEM");
  });
});

function completeProjection(): WorldScaleClosureProjection {
  const role = (entityRef: string, value: WorldScaleClosureProjection["entityRoles"][number]["role"], macroRegionRef: string | null = null) => ({
    entityRef, role: value, macroRegionRef, evidenceRefs: [`evidence_${entityRef}`],
  });
  return {
    worldRefs: ["world_1"],
    entityRoles: [
      role("region_1", "macro_region"), role("region_2", "macro_region"), role("region_3", "macro_region"),
      role("mountains", "mountain_system"), role("sea", "sea"), role("river", "river"),
      role("transport", "transport_network"), role("resources", "resource_distribution"),
      role("group_1", "polity", "region_1"), role("group_2", "civilization_group", "region_1"),
      role("group_3", "polity", "region_2"), role("group_4", "civilization_group", "region_3"),
    ],
    eras: [1, 2, 3, 4].map((index) => ({ ref: `era_${index}`, evidenceRefs: ["evidence_history"] })),
    historicalTurningPoints: [1, 2, 3].map((index) => ({ ref: `turning_${index}`, evidenceRefs: ["evidence_history"] })),
    causalMechanisms: [1, 2, 3, 4].map((index) => ({
      ref: `causal_${index}`, systemRefs: index % 2 === 0 ? ["geography", "economy"] : ["culture", "polity"],
      evidenceRefs: ["evidence_systems"],
    })),
  };
}

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
