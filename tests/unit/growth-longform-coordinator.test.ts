import { describe, expect, it } from "vitest";
import {
  decideGrowthLongformStep,
  type GrowthLongformCoordinatorProgress,
} from "../../src/main/growth/phases/longform/growthLongformCoordinator";

describe("GrowthLongformCoordinator", () => {
  it("plans outline, one section at a time, then an independent recheck", () => {
    expect(decideGrowthLongformStep({
      boundary: "evaluation",
      progress: blocked("GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING"),
    })).toBe("outline");

    const afterOutline = ready({ completed: [], nextSectionId: "origin", totalCodePoints: 0 });
    expect(decideGrowthLongformStep({
      boundary: "committed",
      phase: "outline",
      before: blocked("GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING"),
      after: afterOutline,
    })).toBe("section");

    const beforeFinal = ready({ completed: ["origin"], nextSectionId: "reckoning", totalCodePoints: 5_000 });
    const afterFinal = ready({ completed: ["origin", "reckoning"], nextSectionId: null, totalCodePoints: 10_000 });
    expect(decideGrowthLongformStep({
      boundary: "committed",
      phase: "section",
      before: beforeFinal,
      after: afterFinal,
    })).toBe("recheck");
  });

  it("rejects no-progress, skipped-section, and sub-10000 terminal states", () => {
    const before = ready({ completed: [], nextSectionId: "origin", totalCodePoints: 0 });
    expect(() => decideGrowthLongformStep({
      boundary: "committed", phase: "section", before, after: before,
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_NO_PROGRESS" }));

    expect(() => decideGrowthLongformStep({
      boundary: "committed",
      phase: "section",
      before,
      after: ready({ completed: ["reckoning"], nextSectionId: null, totalCodePoints: 10_000 }),
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_SEQUENCE_INVALID" }));

    expect(() => decideGrowthLongformStep({
      boundary: "committed",
      phase: "section",
      before,
      after: ready({ completed: ["origin"], nextSectionId: null, totalCodePoints: 9_999 }),
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_TARGET_NOT_REACHED" }));
  });
});

function blocked(reason: "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING"): GrowthLongformCoordinatorProgress {
  return { status: "blocked", reason };
}

function ready(input: {
  completed: string[];
  nextSectionId: string | null;
  totalCodePoints: number;
}): GrowthLongformCoordinatorProgress {
  return {
    status: "ready",
    completedSectionIds: input.completed,
    nextSectionId: input.nextSectionId,
    totalCodePoints: input.totalCodePoints,
    complete: input.nextSectionId === null,
  };
}
