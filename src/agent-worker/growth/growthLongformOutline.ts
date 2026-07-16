import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../shared/agentWorkerProtocol";

const identifier = z.string().trim().min(1).max(240);
const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const safeText = (max: number) => z.string().trim().min(1).max(max);

const sectionSchema = z.object({
  localId,
  title: safeText(500),
  objective: safeText(4_000),
  evidenceIds: z.array(identifier).min(1).max(200),
  continuityConstraints: z.array(safeText(2_000)).min(1).max(50),
  estimatedCodePoints: z.object({
    min: z.number().int().min(200).max(8_000),
    max: z.number().int().min(200).max(8_000),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.estimatedCodePoints.min > value.estimatedCodePoints.max) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID" });
  }
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length
    || new Set(value.continuityConstraints).size !== value.continuityConstraints.length) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE" });
  }
});

export const growthLongformOutlineSchema = z.object({
  storyTitle: safeText(500),
  summary: safeText(2_000),
  sections: z.array(sectionSchema).min(2).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.sections.map((section) => section.localId)).size !== value.sections.length) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION" });
  }
  if (value.sections.reduce((total, section) => total + section.estimatedCodePoints.min, 0) < 10_000) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT" });
  }
});

const identifierParameters = Type.String({ minLength: 1, maxLength: 240 });
export const growthLongformOutlineParameters = Type.Object({
  storyTitle: Type.String({ minLength: 1, maxLength: 500 }),
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  sections: Type.Array(Type.Object({
    localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    evidenceIds: Type.Array(identifierParameters, { minItems: 1, maxItems: 200 }),
    continuityConstraints: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 50 }),
    estimatedCodePoints: Type.Object({
      min: Type.Integer({ minimum: 200, maximum: 8_000 }),
      max: Type.Integer({ minimum: 200, maximum: 8_000 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 100 }),
}, { additionalProperties: false });

export interface GrowthLongformOutlineAuthority {
  outlineId: string;
  checkpointId: string;
  receiptId: string;
  availableEvidenceIds: readonly string[];
}

export interface GrowthLongformOutlineChangeSetAuthority extends GrowthLongformOutlineAuthority {
  mainStoryResourceId: string;
  worldResourceId: string;
  focusOcResourceId: string;
  personalStoryResourceId: string;
}

export interface GrowthLongformOutline {
  outlineId: string;
  checkpointId: string;
  receiptId: string;
  storyTitle: string;
  summary: string;
  sections: z.infer<typeof sectionSchema>[];
}

export type GrowthLongformOutlineErrorCode =
  | "GROWTH_LONGFORM_OUTLINE_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION"
  | "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE"
  | "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT"
  | "GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH";

export function compileGrowthLongformOutline(
  input: unknown,
  authority: GrowthLongformOutlineAuthority,
): GrowthLongformOutline {
  const parsed = growthLongformOutlineSchema.safeParse(input);
  if (!parsed.success) throw outlineError(firstOutlineCode(parsed.error.issues.map((issue) => issue.message)));
  const outlineId = identifier.safeParse(authority.outlineId);
  const checkpointId = identifier.safeParse(authority.checkpointId);
  const receiptId = identifier.safeParse(authority.receiptId);
  const available = authority.availableEvidenceIds.map((value) => identifier.safeParse(value));
  if (!outlineId.success || !checkpointId.success || !receiptId.success
    || available.some((result) => !result.success)
    || new Set(authority.availableEvidenceIds).size !== authority.availableEvidenceIds.length) {
    throw outlineError("GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID");
  }
  const allowed = new Set(authority.availableEvidenceIds);
  if (parsed.data.sections.some((section) => section.evidenceIds.some((evidenceId) => !allowed.has(evidenceId)))) {
    throw outlineError("GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH");
  }
  return {
    outlineId: outlineId.data,
    checkpointId: checkpointId.data,
    receiptId: receiptId.data,
    storyTitle: parsed.data.storyTitle,
    summary: parsed.data.summary,
    sections: parsed.data.sections,
  };
}

export function compileGrowthLongformOutlineChangeSet(
  input: unknown,
  authority: GrowthLongformOutlineChangeSetAuthority,
): ProposeChangeSetArgs {
  const outline = compileGrowthLongformOutline(input, authority);
  const mainStoryResourceId = identifier.safeParse(authority.mainStoryResourceId);
  const worldResourceId = identifier.safeParse(authority.worldResourceId);
  const focusOcResourceId = identifier.safeParse(authority.focusOcResourceId);
  const personalStoryResourceId = identifier.safeParse(authority.personalStoryResourceId);
  if (!mainStoryResourceId.success || !worldResourceId.success || !focusOcResourceId.success
    || !personalStoryResourceId.success) {
    throw outlineError("GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID");
  }
  const outlineDocumentId = deriveGrowthLongformOutlineDocumentId(personalStoryResourceId.data, outline.outlineId);
  const prefix = `growth-${createHash("sha256").update(`${outline.outlineId}:outline`).digest("hex").slice(0, 20)}`;
  const storyItemId = `${prefix}-personal-story`;
  const usesWorldItemId = `${prefix}-uses-world`;
  const usesOcItemId = `${prefix}-uses-oc`;
  const creativeItemId = `${prefix}-creative-document`;
  const documentItemId = `${prefix}-document`;
  const assertionItemId = `${prefix}-personal-story-binding`;
  const content = JSON.stringify({ storyTitle: outline.storyTitle, summary: outline.summary, sections: outline.sections });
  return proposeChangeSetArgsSchema.parse({
    summary: outline.summary,
    items: [
      {
        id: storyItemId,
        dependsOn: [],
        kind: "resource.put",
        payload: {
          resourceId: personalStoryResourceId.data,
          create: true,
          type: "story",
          objectKind: "volume",
          title: outline.storyTitle,
          parentId: mainStoryResourceId.data,
          state: "active",
          sortOrder: 0,
        },
      },
      {
        id: usesWorldItemId,
        dependsOn: [storyItemId],
        kind: "creative_relation.put",
        payload: {
          relationId: `${prefix}-relation-uses-world`,
          create: true,
          relationKind: "uses_world",
          sourceResourceId: personalStoryResourceId.data,
          targetResourceId: worldResourceId.data,
          state: "active",
        },
      },
      {
        id: usesOcItemId,
        dependsOn: [storyItemId],
        kind: "creative_relation.put",
        payload: {
          relationId: `${prefix}-relation-uses-oc`,
          create: true,
          relationKind: "uses_oc",
          sourceResourceId: personalStoryResourceId.data,
          targetResourceId: focusOcResourceId.data,
          state: "active",
        },
      },
      {
        id: creativeItemId,
        dependsOn: [storyItemId],
        kind: "creative_document.put",
        payload: {
          documentId: outlineDocumentId,
          create: true,
          resourceId: personalStoryResourceId.data,
          kind: "writing_constraints",
          title: "长篇结构",
          state: "active",
          sortOrder: 0,
        },
      },
      {
        id: documentItemId,
        dependsOn: [storyItemId, creativeItemId],
        kind: "document.put",
        payload: {
          resourceId: personalStoryResourceId.data,
          creativeDocumentId: outlineDocumentId,
          content,
        },
      },
      {
        id: assertionItemId,
        dependsOn: [storyItemId, documentItemId],
        kind: "assertion.put",
        payload: {
          assertionId: `${prefix}-personal-story-binding`,
          scopeType: "oc",
          scopeId: focusOcResourceId.data,
          subject: focusOcResourceId.data,
          predicate: "closure.oc.binding.personal_story",
          object: { storyResourceId: personalStoryResourceId.data },
          evidenceIds: [`greenfield_document_output:${documentItemId}`],
        },
      },
    ],
  });
}

export function deriveGrowthLongformOutlineDocumentId(personalStoryResourceId: string, outlineId: string): string {
  const story = identifier.safeParse(personalStoryResourceId);
  const outline = identifier.safeParse(outlineId);
  if (!story.success || !outline.success) throw outlineError("GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID");
  return `growth-longform-outline-${createHash("sha256").update(`${story.data}:${outline.data}`).digest("hex").slice(0, 32)}`;
}

function firstOutlineCode(messages: string[]): GrowthLongformOutlineErrorCode {
  const codes: GrowthLongformOutlineErrorCode[] = [
    "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION",
    "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE",
    "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID",
    "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT",
  ];
  return codes.find((code) => messages.includes(code)) ?? "GROWTH_LONGFORM_OUTLINE_INVALID";
}

function outlineError(code: GrowthLongformOutlineErrorCode): Error & { code: GrowthLongformOutlineErrorCode } {
  return Object.assign(new Error("Growth longform outline is invalid."), { code });
}
