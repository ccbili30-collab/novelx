import { describe, expect, it } from "vitest";
import { compileGrowthStoryBrief, growthStoryBriefParameters, growthStoryBriefSchema } from "../../src/agent-worker/growth/growthStoryBrief";

const brief = {
  premise: "A coastal world must confront the first sign that its old tidal covenant is failing.",
  openingSituation: "At dawn, a courier reaches the harbour archive as the tide withdraws too far from the sea wall.",
  centralTension: "The opening must expose a human cost of the failing covenant without deciding any player action or game result.",
  pointOfView: "close third person",
  tone: "quietly ominous",
  requiredElements: ["a visible consequence of the world rule"],
  avoid: ["declaring a victory or reward"],
  targetLengthChars: 1200,
};

describe("Growth Story Brief", () => {
  it("strictly exposes only high-level authoring fields and compiles a safe Writer input", () => {
    const modelSchema = JSON.stringify(growthStoryBriefParameters);
    expect(modelSchema).toContain('"additionalProperties":false');
    expect(modelSchema).not.toContain("evidenceIds");
    expect(growthStoryBriefSchema.safeParse({ ...brief, evidenceIds: ["forged"] }).success).toBe(false);
    expect(growthStoryBriefSchema.safeParse({ ...brief, sourceMaterial: "forged" }).success).toBe(false);
    expect(growthStoryBriefSchema.safeParse({ ...brief, gmResolution: "forged" }).success).toBe(false);
    const output = compileGrowthStoryBrief(brief, { evidenceId: "world-version", resourceId: "world-1", label: "Tidal World", excerpt: "The covenant governs the sea.", });
    expect(output).toMatchObject({ evidenceIds: ["world-version"], gmResolution: null, gmResolutionId: null });
    expect(output.sourceMaterial).toContain("Tidal World");
    expect(output.sourceMaterial).toContain("The covenant governs the sea.");
    expect(output.sourceMaterial).not.toMatch(/locator|hash|path/i);
    expect(output.instruction).toContain("not a player or GM turn");
  });

  it("fails closed for malformed briefs or invalid trusted world evidence", () => {
    expect(() => compileGrowthStoryBrief({ ...brief, targetLengthChars: 1 }, { evidenceId: "world", resourceId: "world-1", label: "World", excerpt: null }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_STORY_BRIEF_INVALID" }));
    expect(() => compileGrowthStoryBrief(brief, { evidenceId: "", resourceId: "world-1", label: "World", excerpt: null }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_STORY_BRIEF_INVALID" }));
    expect(() => compileGrowthStoryBrief(brief, { evidenceId: "world", resourceId: "x".repeat(241), label: "World", excerpt: null }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_STORY_BRIEF_INVALID" }));
  });

  it("accepts safe evidence titles through the 500-character title boundary", () => {
    const output = compileGrowthStoryBrief(brief, {
      evidenceId: "world-version",
      resourceId: "world-1",
      label: "世".repeat(300),
      excerpt: null,
    });
    expect(output.evidenceIds).toEqual(["world-version"]);
  });
});
