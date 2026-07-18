import { describe, expect, it } from "vitest";
import {
  defaultGrowthVisualStyle,
  resolveGrowthVisualPurposePolicy,
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
  it("uses the complete colored steel-pen fantasy policy when no explicit override exists", () => {
    const resolved = resolveGrowthVisualStyle({});

    expect(resolved).toMatchObject({
      systemPolicyId: "colored_steel_pen_fantasy_v2",
      styleMode: "system_default",
      provenance: "system_default",
      userVisualSummary: null,
      positive: [...defaultGrowthVisualStyle.positive],
      negative: [...defaultGrowthVisualStyle.negative],
    });
    expect(resolved.positive).toEqual([
      "colored expressive steel-pen and ink linework",
      "broken angular contours with deliberate line-weight variation",
      "disciplined cross-hatching and etched shadow construction",
      "visible hand-drawn paper and pigment texture",
      "restrained watercolor and gouache color washes",
      "mature fantasy concept-illustration composition",
    ]);
    expect(resolved.negative).toEqual([
      "photorealism or cinematic photography",
      "3D, Unreal Engine, or CGI rendering",
      "glossy game-poster finish",
      "monochrome-only output",
      "chibi or kawaii proportions",
      "generic moe character design",
      "embedded paragraphs, fake map labels, watermarks, or logos",
    ]);
    expect(resolved.policySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("adapts one line language to map scales, portraits, scenes, and important-detail scenes", () => {
    const scaleMarkers = {
      world: "macro regions",
      region: "hydrology",
      nation: "provinces",
      city: "districts",
    } as const;
    for (const [scale, marker] of Object.entries(scaleMarkers) as Array<[keyof typeof scaleMarkers, string]>) {
      const policy = resolveGrowthVisualPurposePolicy("world_map", scale);
      expect(policy).toMatchObject({ id: "growth-visual-purpose-v1", purpose: "world_map", mapScale: scale });
      expect(policy.positive.join(" ")).toContain(marker);
      expect(policy.positive.join(" ")).toContain("Renderer labels");
      expect(policy.negative.join(" ")).toContain("embedded place names");
    }
    expect(resolveGrowthVisualPurposePolicy("character_portrait").positive.join(" ")).toContain("readable silhouette");
    expect(resolveGrowthVisualPurposePolicy("scene").positive.join(" ")).toContain("spatial causality");
    expect(resolveGrowthVisualPurposePolicy("scene").positive.join(" ")).toContain("important-detail targets");
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
