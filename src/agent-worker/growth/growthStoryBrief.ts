import { Type } from "typebox";
import { z } from "zod";

const briefText = z.string().trim().min(20).max(4_000);
const shortText = z.string().trim().min(1).max(500);
const listItem = z.string().trim().min(1).max(500);

export const growthStoryBriefSchema = z.object({
  premise: briefText,
  openingSituation: briefText,
  centralTension: briefText,
  pointOfView: shortText,
  tone: shortText,
  requiredElements: z.array(listItem).max(20),
  avoid: z.array(listItem).max(20),
  targetLengthChars: z.number().int().min(500).max(8_000),
}).strict();

export const growthStoryBriefParameters = Type.Object({
  premise: Type.String({ minLength: 20, maxLength: 4_000 }),
  openingSituation: Type.String({ minLength: 20, maxLength: 4_000 }),
  centralTension: Type.String({ minLength: 20, maxLength: 4_000 }),
  pointOfView: Type.String({ minLength: 1, maxLength: 500 }),
  tone: Type.String({ minLength: 1, maxLength: 500 }),
  requiredElements: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
  avoid: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
  targetLengthChars: Type.Integer({ minimum: 500, maximum: 8_000 }),
}, { additionalProperties: false });

export interface TrustedStoryWorldEvidence {
  evidenceId: string;
  label: string;
  excerpt: string | null;
  resourceId: string;
}

/** Compiles a model Brief into the existing Writer contract without exposing Main authority. */
export function compileGrowthStoryBrief(input: unknown, trusted: TrustedStoryWorldEvidence): {
  instruction: string;
  sourceMaterial: string;
  evidenceIds: string[];
  gmResolution: null;
  gmResolutionId: null;
  styleConstraints: string[];
} {
  const parsed = growthStoryBriefSchema.safeParse(input);
  if (!parsed.success || !validTrustedWorld(trusted)) throw briefError("GROWTH_STORY_BRIEF_INVALID");
  const brief = parsed.data;
  return {
    instruction: "Creator authoring task: write one candidate story opening from the supplied brief and pinned formal-world evidence. This is not a player or GM turn: do not adjudicate player actions, victory, defeat, damage, rewards, clues, NPC decisions, or game outcomes. Do not claim Canon or a committed Change Set.",
    sourceMaterial: JSON.stringify({
      formalWorld: { label: trusted.label, excerpt: trusted.excerpt, type: "world", objectKind: "world" },
      brief,
    }),
    evidenceIds: [trusted.evidenceId],
    gmResolution: null,
    gmResolutionId: null,
    styleConstraints: [
      `Point of view: ${brief.pointOfView}`,
      `Tone: ${brief.tone}`,
      `Target length: ${brief.targetLengthChars} characters.`,
      ...brief.requiredElements.map((item) => `Include: ${item}`),
      ...brief.avoid.map((item) => `Avoid: ${item}`),
      "Do not invent player-turn adjudications or claim Canon/commit authority.",
    ],
  };
}

function validTrustedWorld(value: TrustedStoryWorldEvidence): boolean {
  return [value.evidenceId, value.resourceId].every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240)
    && typeof value.label === "string" && value.label.trim().length > 0 && value.label.length <= 500
    && (value.excerpt === null || (typeof value.excerpt === "string" && value.excerpt.length <= 16_000));
}

function briefError(code: "GROWTH_STORY_BRIEF_INVALID"): Error & { code: string } {
  return Object.assign(new Error("Growth Story Brief is invalid."), { code });
}
