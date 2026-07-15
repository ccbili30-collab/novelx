import { describe, expect, it } from "vitest";
import { compileGrowthStoryFragment, growthStoryFragmentParameters, growthStoryFragmentSchema } from "../../src/agent-worker/growth/growthStoryFragment";

const fragment = { summary: "Story summary", story: { localId: "story", title: "Story" }, prose: { localId: "opening", title: "Opening" } };
const trusted = { cycleId: "cycle-story", storyRootResourceId: "story-root", writerCandidateText: "Writer prose exactly.", writerEvidenceIds: ["world-evidence"], worldEvidenceId: "world-evidence", worldResourceId: "world-formal" };

describe("Growth Story Fragment compiler", () => {
  it("compiles exactly four mechanical items while preserving Writer prose byte-for-byte", () => {
    const compiled = compileGrowthStoryFragment(fragment, trusted);
    expect(compiled).toEqual(compileGrowthStoryFragment(fragment, trusted));
    expect(compiled.items).toHaveLength(4);
    expect(compiled.items.find((item) => item.kind === "document.put")).toMatchObject({ payload: { content: trusted.writerCandidateText } });
    expect(compiled.items.find((item) => item.kind === "resource.put")).toMatchObject({ payload: { type: "story", objectKind: "story", parentId: "story-root", create: true, state: "active" } });
    expect(compiled.items.find((item) => item.kind === "creative_relation.put")).toMatchObject({ payload: { relationKind: "uses_world", targetResourceId: "world-formal" } });
    expect(compiled.items.every((item) => !["assertion.put", "project_file.put", "project_file.delete"].includes(item.kind))).toBe(true);
  });

  it("fails closed for forged or non-writer world evidence and low-level fields", () => {
    expect(growthStoryFragmentSchema.safeParse({ ...fragment, resourceId: "forged" }).success).toBe(false);
    expectCode(() => compileGrowthStoryFragment(fragment, { ...trusted, writerEvidenceIds: [] }), "GROWTH_STORY_FRAGMENT_WRITER_EVIDENCE_REQUIRED");
    expectCode(() => compileGrowthStoryFragment(fragment, { ...trusted, worldResourceId: " " }), "GROWTH_STORY_FRAGMENT_WORLD_EVIDENCE_INVALID");
  });

  it("accepts a digit-leading identifier evidence id without treating it as a local id", () => {
    const uuid = "1b7b1d30-0000-4000-8000-000000000001";
    const value = fragment;
    expect((growthStoryFragmentParameters as unknown as { properties: { story: { properties: Record<string, unknown> } } }).properties.story.properties).not.toHaveProperty("worldEvidenceId");
    expect(compileGrowthStoryFragment(value, { ...trusted, writerEvidenceIds: [uuid], worldEvidenceId: uuid }).items).toHaveLength(4);
  });
});

function expectCode(action: () => void, code: string): void { try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; } throw new Error("Expected compiler failure."); }
