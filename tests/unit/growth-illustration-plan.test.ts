import { describe, expect, it } from "vitest";
import {
  compileGrowthIllustrationPlan,
  growthIllustrationPlanParameters,
  type TrustedGrowthIllustrationCompileInput,
} from "../../src/agent-worker/growth/growthIllustrationPlan";
import { defaultGrowthVisualStyle } from "../../src/domain/growth/growthVisualStylePolicy";
import { growthIllustrationPlanSchema } from "../../src/shared/agentWorkerProtocol";

const shaA = "a".repeat(64);
const plan = {
  coverageMode: "default" as const,
  items: [{
    targetEvidenceRef: "world",
    evidenceRefs: ["setting", "world"],
    purpose: "world_map" as const,
    title: "Tidal atlas",
    compositionDescription: "Arrange the authorized coast and harbor evidence as a readable map.",
    variantKey: "map_primary",
  }],
};

function trusted(): TrustedGrowthIllustrationCompileInput {
  return {
    authorizedScopeResourceIds: ["world-scope"],
    currentRuleRevision: { revision: 7 },
    evidenceBindings: [
      {
        evidenceRef: "setting",
        scopeResourceId: "world-scope",
        source: { kind: "document", documentId: "setting-doc", documentVersionId: "setting-v3", contentSha256: shaA },
        authorizedFacts: "The western coast contains a tidal harbor documented in the current setting.",
        targetAnchorInput: {
          kind: "stable_text_span", documentId: "setting-doc", documentVersionId: "setting-v3",
          startCodePoint: 0, endCodePoint: 82, textSha256: shaA,
        },
      },
      {
        evidenceRef: "world",
        scopeResourceId: "world-scope",
        source: { kind: "resource", resourceId: "world-1", resourceVersionId: "world-v2" },
        authorizedFacts: "The world is governed by documented tidal cycles.",
        targetAnchorInput: { kind: "resource", resourceId: "world-1", resourceVersionId: "world-v2" },
      },
    ],
  };
}

describe("Growth Illustration Plan compiler", () => {
  it("wraps every item with the deterministic default style and authorized-evidence boundary", () => {
    const input = {
      ...plan,
      items: [
        ...plan.items,
        {
          targetEvidenceRef: "setting", evidenceRefs: ["setting"], purpose: "scene" as const,
          title: "Harbor scene", compositionDescription: "Frame the documented harbor from water level.", variantKey: "harbor_scene",
        },
      ],
    };
    const compiled = compileGrowthIllustrationPlan(input, trusted());

    expect(compiled.items).toHaveLength(2);
    for (const item of compiled.items) {
      for (const constraint of defaultGrowthVisualStyle.positive) expect(item.promptText).toContain(constraint);
      for (const constraint of defaultGrowthVisualStyle.negative) expect(item.promptText).toContain(constraint);
      expect(item.promptText).toContain("Only depict facts stated in AUTHORIZED EVIDENCE");
      expect(item.resolvedStyle).toMatchObject({ styleMode: "system_default", provenance: "system_default" });
      expect(item.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(item.promptHashInput.currentRuleRevision).toBe(7);
    }
  });

  it("maps high-level refs to normalized authorized versions and a stable target anchor", () => {
    const item = compileGrowthIllustrationPlan(plan, trusted()).items[0]!;

    expect(item.normalizedSources).toEqual([
      {
        evidenceRef: "setting", scopeResourceId: "world-scope", kind: "document",
        documentId: "setting-doc", documentVersionId: "setting-v3", contentSha256: shaA,
      },
      {
        evidenceRef: "world", scopeResourceId: "world-scope", kind: "resource",
        resourceId: "world-1", resourceVersionId: "world-v2",
      },
    ]);
    expect(item.targetAnchorInput).toEqual({ kind: "resource", resourceId: "world-1", resourceVersionId: "world-v2" });
    expect(item.promptText).toContain("The world is governed by documented tidal cycles.");
    expect(item.promptText).toContain("The western coast contains a tidal harbor documented in the current setting.");
  });

  it("requires model-declared user override metadata to match trusted style authority", () => {
    const context = trusted();
    context.currentRuleRevision.visualOverride = {
      summary: "Photoreal documentary realism",
      positive: ["photorealistic photography"],
      negative: ["illustrated linework"],
    };
    const overridden = {
      ...plan,
      items: [{ ...plan.items[0]!, styleMode: "user_override" as const, userVisualSummary: "Photoreal documentary realism" }],
    };
    const item = compileGrowthIllustrationPlan(overridden, context).items[0]!;

    expect(item.resolvedStyle).toMatchObject({ styleMode: "user_override", provenance: "rule_revision_override" });
    expect(item.promptText).toContain("photorealistic photography");
    expect(item.promptText).not.toContain("Avoid:\n- photorealistic photography");
    expectCode(() => compileGrowthIllustrationPlan(plan, context), "GROWTH_ILLUSTRATION_STYLE_OVERRIDE_MISMATCH");
    expectCode(() => compileGrowthIllustrationPlan(overridden, trusted()), "GROWTH_ILLUSTRATION_STYLE_OVERRIDE_UNAUTHORIZED");
  });

  it("fails before compilation for unknown, duplicate, and cross-scope evidence", () => {
    expectCode(() => compileGrowthIllustrationPlan({
      ...plan, items: [{ ...plan.items[0]!, evidenceRefs: ["world", "unknown"] }],
    }, trusted()), "GROWTH_ILLUSTRATION_EVIDENCE_UNKNOWN");
    expectCode(() => compileGrowthIllustrationPlan({
      ...plan, items: [{ ...plan.items[0]!, evidenceRefs: ["world", "world"] }],
    }, trusted()), "GROWTH_ILLUSTRATION_PLAN_INVALID");
    const duplicate = trusted();
    duplicate.evidenceBindings.push({ ...duplicate.evidenceBindings[0]! });
    expectCode(() => compileGrowthIllustrationPlan(plan, duplicate), "GROWTH_ILLUSTRATION_EVIDENCE_DUPLICATE");
    const crossScope = trusted();
    crossScope.evidenceBindings[0] = { ...crossScope.evidenceBindings[0]!, scopeResourceId: "outside-scope" };
    expectCode(() => compileGrowthIllustrationPlan(plan, crossScope), "GROWTH_ILLUSTRATION_EVIDENCE_CROSS_SCOPE");
  });

  it("keeps purpose reuse exact and does not turn default coverage into a quota", () => {
    for (const purpose of ["world_map", "character_portrait", "scene"] as const) {
      expect(growthIllustrationPlanSchema.safeParse({
        coverageMode: "default",
        items: [{ ...plan.items[0]!, purpose }],
      }).success).toBe(true);
    }
    expect(growthIllustrationPlanSchema.safeParse({
      coverageMode: "default",
      items: [{ ...plan.items[0]!, purpose: "location_portrait" }],
    }).success).toBe(false);
    expect((growthIllustrationPlanParameters.properties.items as { maxItems?: number }).maxItems).toBeUndefined();
  });

  it("is byte-stable across trusted binding and evidence-ref order without injecting creative facts", () => {
    const first = compileGrowthIllustrationPlan(plan, trusted());
    const reordered = trusted();
    reordered.evidenceBindings.reverse();
    const second = compileGrowthIllustrationPlan({
      ...plan, items: [{ ...plan.items[0]!, evidenceRefs: ["world", "setting"] }],
    }, reordered);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("silver crown");
    expect(serialized).not.toContain("dragon general");
    expect(serialized).not.toContain("moonlit ambush");
  });
});

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
