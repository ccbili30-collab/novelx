import { describe, expect, it } from "vitest";
import {
  captureLongformWriterCandidate,
  compileLongformOutlineProposal,
  compileLongformSectionProposal,
  compileLongformWriterInput,
  longformPostInquiryInstruction,
  longformToolPresentation,
  requireLongformWriterEvidence,
} from "../../src/agent-worker/growth/phases/longform/growthLongformPhase";
import { growthCapabilityVersion } from "../../src/shared/growthContract";
import type { GrowthRunBinding } from "../../src/shared/agentWorkerProtocol";
import {
  growthLongformSectionWriterCorrectionInstruction,
  isGrowthLongformSectionDiagnosticCode,
  isGrowthLongformSectionWriterCorrectionCode,
  growthLongformSectionDiagnosticCodes,
  classifyGrowthLongformWriterBlockedDiagnostics,
  growthLongformWriterBlockedDiagnosticCode,
  growthLongformWriterBlockedDiagnosticCodes,
} from "../../src/agent-worker/growth/phases/longform/growthLongformDiagnostics";

describe("Growth Longform phase", () => {
  it("owns Longform-only tool presentation and post-Inquiry guidance", () => {
    const outline = outlineBinding();
    const section = sectionBinding();
    expect(longformToolPresentation(outline, "propose_change_set")?.description).toContain("high-level OC personal-story outline");
    expect(longformToolPresentation(section, "writer")?.description).toContain("trusted incomplete personal-story section");
    expect(longformToolPresentation(section, "propose_change_set")?.parameters).toMatchObject({
      properties: { outlineSectionId: { const: "turn" } },
    });
    expect(longformToolPresentation(section, "generate_image")).toBeNull();
    expect(longformPostInquiryInstruction(outline)).toContain("Submit one high-level personal-story outline");
    expect(longformPostInquiryInstruction(section)).toContain("Call Writer");
  });

  it("compiles an outline using only trusted binding authority", () => {
    const binding = outlineBinding();
    const proposal = compileLongformOutlineProposal({
      binding,
      authority: binding.longformAuthority!,
      receiptId: "receipt-1",
      availableEvidenceIds: ["evidence-world", "evidence-oc"],
      params: outlineParams(),
    });
    expect(proposal).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({
        kind: "resource.put",
        payload: expect.objectContaining({ resourceId: "volume-1", parentId: "story-1", objectKind: "volume" }),
      }),
    ]) });
    expect(JSON.stringify(proposal)).not.toContain("receipt-1");
  });

  it("builds one bounded Writer input from selected and prior pinned evidence", () => {
    const binding = sectionBinding();
    const evidenceById = new Map<string, unknown>([
      ["evidence-turn", { evidenceId: "evidence-turn", label: "转折依据" }],
      ["prose-version-1", { evidenceId: "prose-version-1", excerpt: "前文" }],
    ]);
    requireLongformWriterEvidence(binding.longformAuthority!, evidenceById);
    const writerInput = compileLongformWriterInput({
      authority: binding.longformAuthority!, receiptId: "receipt-2", evidenceById,
    });
    expect(writerInput.instruction).toContain("Creator Lens authoring");
    expect(writerInput.instruction).toContain("not GM adjudication");
    expect(writerInput.instruction).toContain("scene-level connective action, dialogue, sensory detail");
    expect(writerInput.instruction).toContain("do not need to pre-exist in the evidence");
    expect(writerInput.instruction).toContain("Do not contradict or replace pinned facts");
    expect(writerInput.instruction).toContain("new consequential Canon fact, identity, rule");
    expect(writerInput.gmResolution).toBeNull();
    expect(writerInput.gmResolutionId).toBeNull();
    expect(JSON.parse(String(writerInput.sourceMaterial))).toMatchObject({
      authoringMode: "creator_lens_section",
    });
    expect(writerInput).toMatchObject({
      evidenceIds: ["evidence-turn", "prose-version-1"], gmResolution: null, gmResolutionId: null,
      styleConstraints: expect.arrayContaining(["Preserve the pinned facts."]),
    });
    expect(writerInput.sourceMaterial).toContain("prose-version-1");
    expect(JSON.stringify(writerInput)).not.toContain("receipt-2");
  });

  it("captures only an evidence-matched Writer candidate and preserves its bytes", () => {
    const authority = sectionBinding().longformAuthority!;
    const candidateText = uniqueText(5_000);
    expect(captureLongformWriterCandidate({ authority, details: {
      status: "candidate", candidateText, evidenceIds: ["evidence-turn"],
      gmResolutionId: null, authorityChanges: [],
    } })).toEqual({ text: candidateText, evidenceIds: ["evidence-turn"] });
    expect(captureLongformWriterCandidate({ authority, details: {
      status: "candidate", candidateText, evidenceIds: ["evidence-turn", "prose-version-1"],
      gmResolutionId: null, authorityChanges: [],
    } })).toEqual({ text: candidateText, evidenceIds: ["evidence-turn"] });
    expect(captureLongformWriterCandidate({ authority, details: {
      status: "candidate", candidateText, evidenceIds: ["prose-version-1"],
      gmResolutionId: null, authorityChanges: [],
    } })).toEqual({ text: candidateText, evidenceIds: ["evidence-turn"] });
    expect(captureLongformWriterCandidate({ authority, details: {
      status: "blocked", reasons: [{
        code: "missing_source", message: "Pinned evidence is unavailable.", evidenceIds: ["evidence-turn"],
      }],
    } })).toBeNull();
    expect(() => captureLongformWriterCandidate({ authority, details: {
      status: "candidate", candidateText, evidenceIds: ["foreign-evidence"],
      gmResolutionId: null, authorityChanges: [],
    } })).toThrow(expect.objectContaining({ code: "STEWARD_LONGFORM_WRITER_EVIDENCE_ECHO_INVALID" }));
  });

  it("classifies Writer refusal through fixed content-free diagnostic codes", () => {
    expect(growthLongformWriterBlockedDiagnosticCode("missing_source"))
      .toBe("STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_SOURCE");
    expect(growthLongformWriterBlockedDiagnosticCode("insufficient_input"))
      .toBe("STEWARD_LONGFORM_WRITER_BLOCKED_INSUFFICIENT_INPUT");
    expect(growthLongformWriterBlockedDiagnosticCode("provider said secret details")).toBeNull();
    expect(classifyGrowthLongformWriterBlockedDiagnostics([
      "missing_gm_resolution", "insufficient_input", "missing_gm_resolution", "unknown",
    ])).toEqual([
      "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION",
      "STEWARD_LONGFORM_WRITER_BLOCKED_INSUFFICIENT_INPUT",
    ]);
    expect(growthLongformWriterBlockedDiagnosticCodes).toHaveLength(9);
    expect(growthLongformSectionDiagnosticCodes).toEqual([
      "GROWTH_LONGFORM_SECTION_INVALID",
      "GROWTH_LONGFORM_SECTION_AUTHORITY_MISMATCH",
      "GROWTH_LONGFORM_SECTION_OUTLINE_MISMATCH",
      "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH",
      "GROWTH_LONGFORM_SECTION_LENGTH_INVALID",
      "GROWTH_LONGFORM_SECTION_TOO_SHORT",
      "GROWTH_LONGFORM_SECTION_TOO_LONG",
      "GROWTH_LONGFORM_SECTION_PRIOR_PROSE_REQUIRED",
      "GROWTH_LONGFORM_SECTION_PADDING_REJECTED",
      "GROWTH_LONGFORM_SECTION_FILLER_REJECTED",
      "GROWTH_LONGFORM_SECTION_REPLAY",
    ]);
    expect(isGrowthLongformSectionWriterCorrectionCode("GROWTH_LONGFORM_SECTION_LENGTH_INVALID")).toBe(true);
    expect(isGrowthLongformSectionWriterCorrectionCode("GROWTH_LONGFORM_SECTION_TOO_SHORT")).toBe(true);
    expect(isGrowthLongformSectionWriterCorrectionCode("GROWTH_LONGFORM_SECTION_TOO_LONG")).toBe(true);
    expect(isGrowthLongformSectionWriterCorrectionCode("GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH")).toBe(false);
    expect(isGrowthLongformSectionDiagnosticCode("GROWTH_LONGFORM_SECTION_PRIOR_PROSE_REQUIRED")).toBe(true);
    expect(isGrowthLongformSectionDiagnosticCode("untrusted raw error")).toBe(false);
    expect(growthLongformSectionWriterCorrectionInstruction("GROWTH_LONGFORM_SECTION_LENGTH_INVALID"))
      .toContain("exact Unicode code-point range");
  });

  it("adds only a fixed Writer correction to a retried section handoff", () => {
    const binding = sectionBinding();
    const writerInput = compileLongformWriterInput({
      authority: binding.longformAuthority!,
      receiptId: "receipt-2",
      evidenceById: new Map([
        ["evidence-turn", { evidenceId: "evidence-turn" }],
        ["prose-version-1", { evidenceId: "prose-version-1" }],
      ]),
      correctionCode: "GROWTH_LONGFORM_SECTION_TOO_SHORT",
    });
    expect(writerInput.instruction).toContain("combined Writer candidate is shorter");
    expect(writerInput.styleConstraints).toEqual(expect.arrayContaining([
      expect.stringContaining("minimum 5000; preferred maximum 6000"),
    ]));
  });

  it("asks Writer to recheck supplied evidence once with bounded creative prose authority", () => {
    const binding = sectionBinding();
    const writerInput = compileLongformWriterInput({
      authority: binding.longformAuthority!,
      receiptId: "receipt-2",
      evidenceById: new Map([
        ["evidence-turn", { evidenceId: "evidence-turn" }],
        ["prose-version-1", { evidenceId: "prose-version-1" }],
      ]),
      correctionCode: "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_SOURCE",
    });
    expect(writerInput.instruction).toContain("pinned evidence values");
    expect(writerInput.instruction).toContain("minor non-Canon incidents is not missing_source");
    expect(writerInput.instruction).toContain("new consequential Canon fact, identity, rule, outcome");
    expect(writerInput.instruction).toContain("Never invent or substitute evidence");
  });

  it("continues a short in-memory section draft without changing trusted authority", () => {
    const binding = sectionBinding();
    const writerInput = compileLongformWriterInput({
      authority: binding.longformAuthority!,
      receiptId: "receipt-2",
      evidenceById: new Map([
        ["evidence-turn", { evidenceId: "evidence-turn" }],
        ["prose-version-1", { evidenceId: "prose-version-1" }],
      ]),
      correctionCode: "GROWTH_LONGFORM_SECTION_TOO_SHORT",
      continuationDraft: { text: "既有短稿", evidenceIds: ["evidence-turn"] },
    });
    expect(writerInput.instruction).toContain("Return only new prose to append");
    expect(writerInput.styleConstraints).toEqual(expect.arrayContaining([
      expect.stringContaining("additional Unicode code points"),
    ]));
    expect(JSON.parse(String(writerInput.sourceMaterial))).toMatchObject({ inProgressDraft: "既有短稿" });
    expect(writerInput).toMatchObject({
      evidenceIds: ["evidence-turn", "prose-version-1"], gmResolution: null, gmResolutionId: null,
    });
  });

  it("compiles the selected section and rejects missing evidence before any executor", () => {
    const binding = sectionBinding();
    const candidateText = uniqueText(5_000);
    const proposal = compileLongformSectionProposal({
      binding,
      authority: binding.longformAuthority!,
      receiptId: "receipt-2",
      availableEvidenceIds: ["evidence-opening", "evidence-turn", "prose-version-1"],
      writerCandidate: { text: candidateText, evidenceIds: ["evidence-turn"] },
      params: { outlineSectionId: "turn" },
    });
    expect(proposal).toMatchObject({ items: [
      expect.objectContaining({ kind: "creative_document.put" }),
      expect.objectContaining({ kind: "document.put", payload: expect.objectContaining({ content: candidateText }) }),
    ] });
    expect(() => requireLongformWriterEvidence(binding.longformAuthority!, new Map([
      ["evidence-turn", { evidenceId: "evidence-turn" }],
    ]))).toThrow(expect.objectContaining({ code: "STEWARD_LONGFORM_EVIDENCE_REQUIRED" }));
  });
});

function baseBinding(): Omit<GrowthRunBinding, "longformAuthority"> {
  return {
    capabilityVersion: growthCapabilityVersion,
    goalId: "goal-1",
    cycleId: "cycle-1",
    kind: "expand",
    focusKinds: ["oc"],
    resumeFrontier: [],
    inputCheckpointId: "checkpoint-1",
    ruleRevision: 1,
    authorizedScopeResourceIds: ["world-root", "oc-root", "story-root"],
    seedResourceIds: ["oc-1"],
    domainRootResourceIds: { world: "world-root", oc: "oc-root", story: "story-root" },
    greenfieldCreateAuthorized: false,
    priorInquiries: [],
    closureProfile: null,
    closureRepair: null,
  };
}

function outlineBinding(): GrowthRunBinding & { longformAuthority: Extract<NonNullable<GrowthRunBinding["longformAuthority"]>, { phase: "outline" }> } {
  return {
    ...baseBinding(),
    longformAuthority: {
      phase: "outline",
      outlineId: "outline-1",
      mainStoryResourceId: "story-1",
      worldResourceId: "world-1",
      focusOcResourceId: "oc-1",
      personalStoryResourceId: "volume-1",
    },
  };
}

function sectionBinding(): GrowthRunBinding & { longformAuthority: Extract<NonNullable<GrowthRunBinding["longformAuthority"]>, { phase: "section" }> } {
  return {
    ...baseBinding(),
    inputCheckpointId: "checkpoint-2",
    longformAuthority: {
      phase: "section",
      outlineId: "outline-1",
      storyResourceId: "volume-1",
      outlineDocumentVersionId: "outline-version-1",
      storyTitle: "The Salt Heir",
      summary: "A bounded OC saga.",
      sections: [
        section("opening", "evidence-opening"),
        section("turn", "evidence-turn"),
      ],
      selectedSectionId: "turn",
      sectionSortOrder: 1,
      completedSectionIds: ["opening"],
      priorProseEvidenceIds: ["prose-version-1"],
      priorContentSha256: ["a".repeat(64)],
    },
  };
}

function section(localId: string, evidenceId: string) {
  return {
    localId,
    title: localId,
    objective: `Write ${localId}.`,
    evidenceIds: [evidenceId],
    continuityConstraints: ["Preserve the pinned facts."],
    estimatedCodePoints: { min: 5_000, max: 6_000 },
  };
}

function outlineParams() {
  return {
    storyTitle: "The Salt Heir",
    summary: "A bounded OC saga.",
    sections: [section("opening", "evidence-world"), section("turn", "evidence-oc")],
  };
}

function uniqueText(length: number): string {
  const chunks: string[] = [];
  for (let index = 0; chunks.join("").length < length; index += 1) {
    chunks.push(`第${index}幕潮声改变了人物的选择与港口秩序。`);
  }
  return Array.from(chunks.join("")).slice(0, length).join("");
}
