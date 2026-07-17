import { describe, expect, it } from "vitest";
import {
  decideGrowthLongformStep,
  type GrowthLongformCoordinatorProgress,
} from "../../src/main/growth/phases/longform/growthLongformCoordinator";
import type { GrowthLongformProgressBlockedReason } from "../../src/domain/growth/growthLongformProgress";
import { GROWTH_LONGFORM_MIN_CODE_POINTS } from "../../src/shared/growthLongformPolicy";

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
    const afterFinal = ready({ completed: ["origin", "reckoning"], nextSectionId: null, totalCodePoints: GROWTH_LONGFORM_MIN_CODE_POINTS });
    expect(decideGrowthLongformStep({
      boundary: "committed",
      phase: "section",
      before: beforeFinal,
      after: afterFinal,
    })).toBe("recheck");
  });

  it("rejects no-progress, skipped-section, and terminal states below the policy minimum", () => {
    const before = ready({ completed: [], nextSectionId: "origin", totalCodePoints: 0 });
    expect(() => decideGrowthLongformStep({
      boundary: "committed", phase: "section", before, after: before,
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_NO_PROGRESS" }));

    expect(() => decideGrowthLongformStep({
      boundary: "committed",
      phase: "section",
      before,
      after: ready({ completed: ["reckoning"], nextSectionId: null, totalCodePoints: GROWTH_LONGFORM_MIN_CODE_POINTS }),
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_SEQUENCE_INVALID" }));

    expect(() => decideGrowthLongformStep({
      boundary: "committed",
      phase: "section",
      before,
      after: ready({ completed: ["origin"], nextSectionId: null, totalCodePoints: GROWTH_LONGFORM_MIN_CODE_POINTS - 1 }),
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_TARGET_NOT_REACHED" }));
  });

  it("leaves a later invalidated Longform invariant to Closure continuation repair", () => {
    expect(decideGrowthLongformStep({
      boundary: "evaluation",
      progress: blocked("GROWTH_LONGFORM_PERSONAL_STORY_RELATIONS_INVALID"),
    })).toBe("not_applicable");
  });
});

function blocked(reason: GrowthLongformProgressBlockedReason): GrowthLongformCoordinatorProgress {
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
