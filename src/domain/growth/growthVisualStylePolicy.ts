import { createHash } from "node:crypto";
import { z } from "zod";

export const defaultGrowthVisualStyle = {
  id: "illustrated_manga_handdrawn_v1",
  positive: [
    "mature graphic-novel composition",
    "expressive hand-drawn linework",
    "painterly paper and brush texture",
    "restrained cinematic color design",
    "fantasy concept-art clarity",
  ],
  negative: [
    "photorealistic photography",
    "3D realism",
    "chibi",
    "kawaii mascot style",
    "generic moe doll-like character design",
    "watermark or embedded text",
  ],
} as const;

export const growthVisualStyleOverrideSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  positive: z.array(z.string().trim().min(1).max(500)).max(100),
  negative: z.array(z.string().trim().min(1).max(500)).max(100),
}).strict();

export type GrowthVisualStyleOverride = z.infer<typeof growthVisualStyleOverrideSchema>;
export type GrowthVisualStyleProvenance =
  | "per_image_override"
  | "target_override"
  | "rule_revision_override"
  | "goal_default"
  | "system_default";

export interface GrowthVisualStyleResolutionInput {
  perImageOverride?: GrowthVisualStyleOverride | null;
  targetOverride?: GrowthVisualStyleOverride | null;
  ruleRevisionOverride?: GrowthVisualStyleOverride | null;
  goalDefault?: GrowthVisualStyleOverride | null;
}

export interface ResolvedGrowthVisualStyle {
  systemPolicyId: typeof defaultGrowthVisualStyle.id;
  styleMode: "system_default" | "user_override";
  provenance: GrowthVisualStyleProvenance;
  userVisualSummary: string | null;
  positive: string[];
  negative: string[];
  policySha256: string;
}

export type GrowthVisualStylePolicyErrorCode =
  | "GROWTH_VISUAL_STYLE_OVERRIDE_INVALID"
  | "GROWTH_VISUAL_STYLE_OVERRIDE_EMPTY"
  | "GROWTH_VISUAL_STYLE_OVERRIDE_DUPLICATE"
  | "GROWTH_VISUAL_STYLE_OVERRIDE_CONTRADICTORY";

export function resolveGrowthVisualStyle(input: GrowthVisualStyleResolutionInput): ResolvedGrowthVisualStyle {
  const selected = [
    ["per_image_override", input.perImageOverride],
    ["target_override", input.targetOverride],
    ["rule_revision_override", input.ruleRevisionOverride],
    ["goal_default", input.goalDefault],
  ].find((entry) => entry[1] !== undefined && entry[1] !== null) as
    | [Exclude<GrowthVisualStyleProvenance, "system_default">, GrowthVisualStyleOverride]
    | undefined;

  const resolution = selected
    ? resolveExplicitOverride(selected[0], selected[1])
    : {
        systemPolicyId: defaultGrowthVisualStyle.id,
        styleMode: "system_default" as const,
        provenance: "system_default" as const,
        userVisualSummary: null,
        positive: [...defaultGrowthVisualStyle.positive],
        negative: [...defaultGrowthVisualStyle.negative],
      };
  return {
    ...resolution,
    policySha256: sha256(JSON.stringify(resolution)),
  };
}

function resolveExplicitOverride(
  provenance: Exclude<GrowthVisualStyleProvenance, "system_default">,
  input: GrowthVisualStyleOverride,
): Omit<ResolvedGrowthVisualStyle, "policySha256"> {
  const parsed = growthVisualStyleOverrideSchema.safeParse(input);
  if (!parsed.success) throw styleError("GROWTH_VISUAL_STYLE_OVERRIDE_INVALID");
  const override = parsed.data;
  if (override.positive.length + override.negative.length === 0) {
    throw styleError("GROWTH_VISUAL_STYLE_OVERRIDE_EMPTY");
  }
  const positive = override.positive.map(normalizeConstraint);
  const negative = override.negative.map(normalizeConstraint);
  if (new Set(positive).size !== positive.length || new Set(negative).size !== negative.length) {
    throw styleError("GROWTH_VISUAL_STYLE_OVERRIDE_DUPLICATE");
  }
  const negativeSet = new Set(negative);
  if (positive.some((constraint) => negativeSet.has(constraint))) {
    throw styleError("GROWTH_VISUAL_STYLE_OVERRIDE_CONTRADICTORY");
  }
  return {
    systemPolicyId: defaultGrowthVisualStyle.id,
    styleMode: "user_override",
    provenance,
    userVisualSummary: override.summary,
    positive: [...override.positive],
    negative: [...override.negative],
  };
}

function normalizeConstraint(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function styleError(code: GrowthVisualStylePolicyErrorCode): Error & { code: GrowthVisualStylePolicyErrorCode } {
  return Object.assign(new Error("Growth visual style override is invalid."), { code });
}
