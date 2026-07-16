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
    expect(writerInput).toMatchObject({
      evidenceIds: ["evidence-turn"], gmResolution: null, gmResolutionId: null,
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
      status: "blocked", reasons: [{
        code: "missing_source", message: "Pinned evidence is unavailable.", evidenceIds: ["evidence-turn"],
      }],
    } })).toBeNull();
    expect(() => captureLongformWriterCandidate({ authority, details: {
      status: "candidate", candidateText, evidenceIds: ["foreign-evidence"],
      gmResolutionId: null, authorityChanges: [],
    } })).toThrow(expect.objectContaining({ code: "STEWARD_LONGFORM_EVIDENCE_REQUIRED" }));
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
