import { describe, expect, it } from "vitest";
import { compileGrowthOcFragment, growthOcFragmentParameters, growthOcFragmentSchema } from "../../src/agent-worker/growth/growthOcFragment";

const profile = "A focused character profile with motives, history, fears, alliances, and an active role in the story. ".repeat(2).trim();
const fragment = {
  summary: "Create two formal characters.",
  characters: [
    { localId: "captain", title: "Captain", profile: { localId: "captain-profile", title: "Captain profile", content: profile } },
    { localId: "navigator", title: "Navigator", profile: { localId: "navigator-profile", title: "Navigator profile", content: profile } },
  ],
  relationships: [{ localId: "captain-navigator", sourceRef: "captain", targetRef: "navigator" }],
};
const trusted = { cycleId: "cycle-oc", ocRootResourceId: "oc-root", storyResourceId: "story-formal" };

describe("Growth OC Fragment compiler", () => {
  it("compiles deterministic OC profiles, story uses_oc edges, and requested related_to edges", () => {
    const compiled = compileGrowthOcFragment(fragment, trusted);
    expect(compiled).toEqual(compileGrowthOcFragment(fragment, trusted));
    expect(compiled.items).toHaveLength(9);
    expect(compiled.items.filter((item) => item.kind === "resource.put")).toHaveLength(2);
    expect(compiled.items.filter((item) => item.kind === "creative_document.put")).toHaveLength(2);
    expect(compiled.items.filter((item) => item.kind === "document.put").map((item) => item.payload.content)).toEqual([profile, profile]);
    expect(compiled.items.filter((item) => item.kind === "creative_relation.put" && item.payload.relationKind === "uses_oc")).toHaveLength(2);
    expect(compiled.items.find((item) => item.kind === "creative_relation.put" && item.payload.relationKind === "related_to")).toMatchObject({ dependsOn: [expect.any(String), expect.any(String)] });
    expect(compiled.items.every((item) => !["assertion.put", "project_file.put", "project_file.delete"].includes(item.kind))).toBe(true);
  });

  it("preserves model-authored profile bytes while validating trimmed semantic content", () => {
    const padded = `\n  ${profile}  \n`;
    const compiled = compileGrowthOcFragment({
      ...fragment,
      characters: [
        { ...fragment.characters[0], profile: { ...fragment.characters[0].profile, content: padded } },
        fragment.characters[1],
      ],
    }, trusted);
    expect(compiled.items.filter((item) => item.kind === "document.put")[0]!.payload.content).toBe(padded);
    expectCode(() => compileGrowthOcFragment({
      ...fragment,
      characters: [{ ...fragment.characters[0], profile: { ...fragment.characters[0].profile, content: " ".repeat(100) } }, fragment.characters[1]],
    }, trusted), "GROWTH_OC_FRAGMENT_INVALID");
  });

  it("accepts exactly 20,000 raw profile characters and rejects 20,001", () => {
    const maximum = `${profile}${" ".repeat(20_000 - profile.length)}`;
    expect(maximum).toHaveLength(20_000);
    const atBoundary = compileGrowthOcFragment({
      ...fragment,
      characters: [{ ...fragment.characters[0], profile: { ...fragment.characters[0].profile, content: maximum } }, fragment.characters[1]],
    }, trusted);
    expect(atBoundary.items.filter((item) => item.kind === "document.put")[0]!.payload.content).toBe(maximum);
    expectCode(() => compileGrowthOcFragment({
      ...fragment,
      characters: [{ ...fragment.characters[0], profile: { ...fragment.characters[0].profile, content: `${maximum}x` } }, fragment.characters[1]],
    }, trusted), "GROWTH_OC_FRAGMENT_INVALID");
  });

  it("rejects malformed local references, duplicate relationships, short profiles, and low-level fields", () => {
    expect(growthOcFragmentSchema.safeParse({ ...fragment, resourceId: "forged" }).success).toBe(false);
    expect((growthOcFragmentParameters as unknown as { properties: Record<string, unknown> }).properties).not.toHaveProperty("storyResourceId");
    expect((growthOcFragmentParameters as unknown as { properties: Record<string, unknown> }).properties).not.toHaveProperty("resourceId");
    expectCode(() => compileGrowthOcFragment({ ...fragment, relationships: [{ localId: "self", sourceRef: "captain", targetRef: "captain" }] }, trusted), "GROWTH_OC_FRAGMENT_RELATION_INVALID");
    expectCode(() => compileGrowthOcFragment({ ...fragment, relationships: [{ localId: "one", sourceRef: "captain", targetRef: "navigator" }, { localId: "two", sourceRef: "captain", targetRef: "navigator" }] }, trusted), "GROWTH_OC_FRAGMENT_RELATION_INVALID");
    expectCode(() => compileGrowthOcFragment({ ...fragment, characters: [{ ...fragment.characters[0], profile: { ...fragment.characters[0].profile, content: "short" } }, fragment.characters[1]] }, trusted), "GROWTH_OC_FRAGMENT_INVALID");
    expectCode(() => compileGrowthOcFragment({ ...fragment, relationships: [{ localId: "missing", sourceRef: "captain", targetRef: "missing" }] }, trusted), "GROWTH_OC_FRAGMENT_REFERENCE_INVALID");
    expectCode(() => compileGrowthOcFragment(fragment, { ...trusted, storyResourceId: " " }), "GROWTH_OC_FRAGMENT_STORY_INVALID");
  });
});

function expectCode(action: () => void, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error("Expected a Growth OC Fragment compiler error.");
}
