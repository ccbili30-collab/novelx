import { describe, expect, it } from "vitest";
import {
  defaultGrowthVisualStyle,
  resolveGrowthVisualStyle,
  type GrowthVisualStyleOverride,
} from "../../src/domain/growth/growthVisualStylePolicy";

function visualOverride(name: string): GrowthVisualStyleOverride {
  return {
    summary: `${name} visual direction`,
    positive: [`${name} positive`],
    negative: [`${name} negative`],
  };
}

describe("Growth visual style policy", () => {
  it("uses the complete mature hand-drawn manga policy when no explicit override exists", () => {
    const resolved = resolveGrowthVisualStyle({});

    expect(resolved).toMatchObject({
      systemPolicyId: "illustrated_manga_handdrawn_v1",
      styleMode: "system_default",
      provenance: "system_default",
      userVisualSummary: null,
      positive: [...defaultGrowthVisualStyle.positive],
      negative: [...defaultGrowthVisualStyle.negative],
    });
    expect(resolved.positive).toEqual([
      "mature graphic-novel composition",
      "expressive hand-drawn linework",
      "painterly paper and brush texture",
      "restrained cinematic color design",
      "fantasy concept-art clarity",
    ]);
    expect(resolved.negative).toEqual([
      "photorealistic photography",
      "3D realism",
      "chibi",
      "kawaii mascot style",
      "generic moe doll-like character design",
      "watermark or embedded text",
    ]);
    expect(resolved.policySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves exact per-image, target, Rule Revision, Goal, then system precedence", () => {
    const goalDefault = visualOverride("goal");
    const ruleRevisionOverride = visualOverride("rule");
    const targetOverride = visualOverride("target");
    const perImageOverride = visualOverride("image");

    expect(resolveGrowthVisualStyle({ goalDefault })).toMatchObject({ provenance: "goal_default", positive: ["goal positive"] });
    expect(resolveGrowthVisualStyle({ goalDefault, ruleRevisionOverride })).toMatchObject({ provenance: "rule_revision_override", positive: ["rule positive"] });
    expect(resolveGrowthVisualStyle({ goalDefault, ruleRevisionOverride, targetOverride })).toMatchObject({ provenance: "target_override", positive: ["target positive"] });
    expect(resolveGrowthVisualStyle({ goalDefault, ruleRevisionOverride, targetOverride, perImageOverride })).toMatchObject({ provenance: "per_image_override", positive: ["image positive"] });
    expect(resolveGrowthVisualStyle({})).toMatchObject({ provenance: "system_default" });
  });

  it("allows an explicit realism override without silently restoring contradictory default negatives", () => {
    const resolved = resolveGrowthVisualStyle({
      ruleRevisionOverride: {
        summary: "Photoreal historical-fantasy editorial image",
        positive: ["photorealistic photography", "natural optics and skin texture"],
        negative: ["illustrated linework"],
      },
    });

    expect(resolved).toMatchObject({
      styleMode: "user_override",
      provenance: "rule_revision_override",
      userVisualSummary: "Photoreal historical-fantasy editorial image",
    });
    expect(resolved.positive).toContain("photorealistic photography");
    expect(resolved.negative).toEqual(["illustrated linework"]);
    expect(resolved.negative).not.toContain("photorealistic photography");
    expect(resolved.negative).not.toContain("3D realism");
  });

  it("fails closed for empty, duplicate, or contradictory explicit constraints", () => {
    expectCode(() => resolveGrowthVisualStyle({
      goalDefault: { summary: "Empty", positive: [], negative: [] },
    }), "GROWTH_VISUAL_STYLE_OVERRIDE_EMPTY");
    expectCode(() => resolveGrowthVisualStyle({
      goalDefault: { summary: "Duplicate", positive: ["ink", " INK "], negative: [] },
    }), "GROWTH_VISUAL_STYLE_OVERRIDE_DUPLICATE");
    expectCode(() => resolveGrowthVisualStyle({
      goalDefault: { summary: "Contradictory", positive: ["photoreal"], negative: [" PHOTOREAL "] },
    }), "GROWTH_VISUAL_STYLE_OVERRIDE_CONTRADICTORY");
    expectCode(() => resolveGrowthVisualStyle({
      goalDefault: { summary: "   ", positive: ["ink"], negative: [] },
    }), "GROWTH_VISUAL_STYLE_OVERRIDE_INVALID");
  });
});

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
