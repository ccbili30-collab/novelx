import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  compileGrowthLongformOutline,
  compileGrowthLongformOutlineChangeSet,
  growthLongformOutlineParameters,
} from "../../src/agent-worker/growth/growthLongformOutline";
import {
  compileGrowthLongformSection,
  compileGrowthLongformSectionChangeSet,
  growthLongformSectionParameters,
} from "../../src/agent-worker/growth/growthLongformSection";

const evidence = ["world-evidence", "oc-evidence"];
const validOutlineInput = {
  storyTitle: "潮汐债务",
  summary: "以潮汐债务和失落记忆为主线的角色个人长篇。",
  sections: [
    section("origin", 5_000, 5_500),
    section("reckoning", 5_000, 5_500),
  ],
};

describe("Growth longform authoring", () => {
  it("compiles a strict multi-section outline with trusted checkpoint and Receipt authority", () => {
    expect(Value.Check(growthLongformOutlineParameters, validOutlineInput)).toBe(true);
    const outline = compileOutline(validOutlineInput);
    expect(outline).toMatchObject({
      outlineId: "outline-1", checkpointId: "checkpoint-1", receiptId: "receipt-1",
      sections: [{ localId: "origin" }, { localId: "reckoning" }],
    });
    expect(outline.sections.reduce((total, item) => total + item.estimatedCodePoints.min, 0)).toBe(10_000);
  });

  it("compiles the outline into one independent personal-story volume with world/OC bindings", () => {
    const proposal = compileGrowthLongformOutlineChangeSet(validOutlineInput, {
      outlineId: "outline-1",
      checkpointId: "checkpoint-1",
      receiptId: "receipt-1",
      availableEvidenceIds: evidence,
      mainStoryResourceId: "story-main-1",
      worldResourceId: "world-1",
      focusOcResourceId: "oc-focus-1",
      personalStoryResourceId: "story-personal-1",
    });
    expect(proposal.items.map((item) => item.kind)).toEqual([
      "resource.put", "creative_relation.put", "creative_relation.put",
      "creative_document.put", "document.put", "assertion.put",
    ]);
    expect(proposal.items.find((item) => item.kind === "resource.put")).toMatchObject({
      payload: {
        resourceId: "story-personal-1", type: "story", objectKind: "volume",
        parentId: "story-main-1", title: validOutlineInput.storyTitle,
      },
    });
    expect(proposal.items.filter((item) => item.kind === "creative_relation.put")).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ relationKind: "uses_world", sourceResourceId: "story-personal-1", targetResourceId: "world-1" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ relationKind: "uses_oc", sourceResourceId: "story-personal-1", targetResourceId: "oc-focus-1" }) }),
    ]));
    const document = proposal.items.find((item) => item.kind === "document.put")!;
    expect(JSON.parse(document.payload.content)).toEqual(validOutlineInput);
    expect(proposal.items.find((item) => item.kind === "assertion.put")).toMatchObject({
      payload: {
        scopeId: "oc-focus-1",
        subject: "oc-focus-1",
        predicate: "closure.oc.binding.personal_story",
        object: { storyResourceId: "story-personal-1" },
        evidenceIds: [expect.stringMatching(/^greenfield_document_output:/)],
      },
    });
    expect(() => compileGrowthLongformOutlineChangeSet(validOutlineInput, {
      outlineId: "outline-1", checkpointId: "checkpoint-1", receiptId: "receipt-1",
      availableEvidenceIds: evidence, mainStoryResourceId: "story-main-1", worldResourceId: "world-1",
      focusOcResourceId: "oc-focus-1", personalStoryResourceId: "",
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID" }));
  });

  it("rejects duplicate section/evidence values, invalid ranges, insufficient target, and foreign evidence", () => {
    expectCode({ ...validOutlineInput, sections: [section("origin", 5_000, 5_500), section("origin", 5_000, 5_500)] }, "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION");
    expectCode({ ...validOutlineInput, sections: [{ ...section("origin", 5_000, 5_500), evidenceIds: ["world-evidence", "world-evidence"] }, section("reckoning", 5_000, 5_500)] }, "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE");
    expectCode({ ...validOutlineInput, sections: [section("origin", 5_500, 5_000), section("reckoning", 5_000, 5_500)] }, "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID");
    expectCode({ ...validOutlineInput, sections: [section("origin", 4_000, 5_000), section("reckoning", 4_000, 5_000)] }, "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT");
    expect(() => compileOutline({ ...validOutlineInput, sections: [{ ...section("origin", 5_000, 5_500), evidenceIds: ["foreign"] }, section("reckoning", 5_000, 5_500)] }))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH" }));
  });

  it("preserves Writer candidate bytes and counts Unicode code points", () => {
    const outline = compileOutline({
      ...validOutlineInput,
      sections: [section("origin", 200, 500), section("middle", 4_900, 5_500), section("reckoning", 4_900, 5_500)],
    });
    const candidateText = `${"潮".repeat(199)}🌊`;
    const compiled = compileGrowthLongformSection({ outlineSectionId: "origin", candidateText, evidenceIds: evidence }, authority(outline));
    expect(Value.Check(growthLongformSectionParameters, { outlineSectionId: "origin", candidateText, evidenceIds: evidence })).toBe(true);
    expect(compiled.candidateText).toBe(candidateText);
    expect(compiled.codePoints).toBe(200);
  });

  it("compiles one section into one stable prose document without changing Writer bytes", () => {
    const outline = compileOutline({
      ...validOutlineInput,
      sections: [section("origin", 200, 500), section("middle", 4_900, 5_500), section("reckoning", 4_900, 5_500)],
    });
    const candidateText = uniqueText(200);
    const proposal = compileGrowthLongformSectionChangeSet({
      outlineSectionId: "origin", candidateText, evidenceIds: evidence,
    }, {
      ...authority(outline),
      storyResourceId: "story-personal-1",
      sectionSortOrder: 1,
    });
    expect(proposal.items.map((item) => item.kind)).toEqual(["creative_document.put", "document.put"]);
    expect(proposal.items.find((item) => item.kind === "creative_document.put")).toMatchObject({
      payload: {
        documentId: expect.stringMatching(/^growth-longform-section-/),
        resourceId: "story-personal-1",
        kind: "prose",
        sortOrder: 1,
      },
    });
    expect(proposal.items.find((item) => item.kind === "document.put")?.payload.content).toBe(candidateText);
  });

  it("rejects wrong authority, section, evidence, padding, length, and prior replay", () => {
    const outline = compileOutline(validOutlineInput);
    const candidateText = uniqueText(5_000);
    expect(() => compileGrowthLongformSection({ outlineSectionId: "origin", candidateText, evidenceIds: evidence }, { ...authority(outline), checkpointId: "" }))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_AUTHORITY_MISMATCH" }));
    expect(() => compileGrowthLongformSection({ outlineSectionId: "missing", candidateText, evidenceIds: evidence }, authority(outline)))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_OUTLINE_MISMATCH" }));
    expect(() => compileGrowthLongformSection({ outlineSectionId: "origin", candidateText, evidenceIds: ["world-evidence"] }, authority(outline)))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH" }));
    expect(() => compileGrowthLongformSection({ outlineSectionId: "origin", candidateText: ` ${candidateText}`, evidenceIds: evidence }, authority(outline)))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_PADDING_REJECTED" }));
    expect(() => compileGrowthLongformSection({ outlineSectionId: "origin", candidateText: uniqueText(4_999), evidenceIds: evidence }, authority(outline)))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_LENGTH_INVALID" }));
    const compiled = compileGrowthLongformSection({ outlineSectionId: "origin", candidateText, evidenceIds: evidence }, authority(outline));
    expect(() => compileGrowthLongformSection({ outlineSectionId: "origin", candidateText, evidenceIds: evidence }, {
      ...authority(outline), completedSectionIds: ["origin"], priorContentSha256: [compiled.contentSha256],
    })).toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_REPLAY" }));
  });

  it("continues the same outline from a newer pinned checkpoint and requires prior prose evidence", () => {
    const outline = compileOutline(validOutlineInput);
    const candidateText = uniqueText(5_000);
    const currentEvidence = [...evidence, "prior-prose-version"];
    const nextAuthority = {
      ...authority(outline),
      checkpointId: "checkpoint-2",
      receiptId: "receipt-2",
      availableEvidenceIds: currentEvidence,
      priorProseEvidenceIds: ["prior-prose-version"],
      completedSectionIds: ["origin"],
    };
    const compiled = compileGrowthLongformSection({
      outlineSectionId: "reckoning", candidateText, evidenceIds: evidence,
    }, nextAuthority);
    expect(compiled).toMatchObject({ checkpointId: "checkpoint-2", receiptId: "receipt-2" });

    expect(() => compileGrowthLongformSection({
      outlineSectionId: "reckoning", candidateText, evidenceIds: evidence,
    }, { ...nextAuthority, priorProseEvidenceIds: [] }))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_PRIOR_PROSE_REQUIRED" }));
    expect(() => compileGrowthLongformSection({
      outlineSectionId: "reckoning", candidateText, evidenceIds: evidence,
    }, { ...nextAuthority, availableEvidenceIds: ["prior-prose-version"] }))
      .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH" }));
  });

  it("rejects repeated paragraphs, sentences, and periodic filler", () => {
    const outline = compileOutline({
      ...validOutlineInput,
      sections: [section("origin", 200, 8_000), section("middle", 4_900, 5_500), section("reckoning", 4_900, 5_500)],
    });
    const repeatedParagraph = "潮声迫使港口居民交出一段记忆作为通行税。";
    for (const candidateText of [
      `${repeatedParagraph}\n\n${repeatedParagraph}\n\n${"异".repeat(200)}`,
      `${repeatedParagraph}。${repeatedParagraph}。${repeatedParagraph}。${"异".repeat(200)}`,
      "潮汐债务".repeat(50),
    ]) {
      expect(() => compileGrowthLongformSection({ outlineSectionId: "origin", candidateText, evidenceIds: evidence }, authority(outline)))
        .toThrow(expect.objectContaining({ code: "GROWTH_LONGFORM_SECTION_FILLER_REJECTED" }));
    }
  });
});

function section(localId: string, min: number, max: number) {
  return {
    localId,
    title: `章节 ${localId}`,
    objective: "推动角色选择，并让世界规则产生可见后果。",
    evidenceIds: [...evidence],
    continuityConstraints: ["角色不能无代价恢复失去的记忆。"],
    estimatedCodePoints: { min, max },
  };
}

function compileOutline(input: unknown) {
  return compileGrowthLongformOutline(input, {
    outlineId: "outline-1", checkpointId: "checkpoint-1", receiptId: "receipt-1", availableEvidenceIds: evidence,
  });
}

function authority(outline: ReturnType<typeof compileOutline>) {
  return {
    outline,
    checkpointId: "checkpoint-1",
    receiptId: "receipt-1",
    availableEvidenceIds: evidence,
    priorProseEvidenceIds: [],
    completedSectionIds: [],
    priorContentSha256: [],
  };
}

function expectCode(input: unknown, code: string): void {
  expect(() => compileOutline(input)).toThrow(expect.objectContaining({ code }));
}

function uniqueText(length: number): string {
  const chunks: string[] = [];
  for (let index = 0; chunks.join("").length < length; index += 1) chunks.push(`第${index}幕潮声改变了人物的选择与港口秩序。`);
  return Array.from(chunks.join("")).slice(0, length).join("");
}
