import { createHash } from "node:crypto";
import { z } from "zod";

export const defaultGrowthVisualStyle = {
  id: "colored_steel_pen_fantasy_v2",
  positive: [
    "colored expressive steel-pen and ink linework",
    "broken angular contours with deliberate line-weight variation",
    "disciplined cross-hatching and etched shadow construction",
    "visible hand-drawn paper and pigment texture",
    "restrained watercolor and gouache color washes",
    "mature fantasy concept-illustration composition",
  ],
  negative: [
    "photorealism or cinematic photography",
    "3D, Unreal Engine, or CGI rendering",
    "glossy game-poster finish",
    "monochrome-only output",
    "chibi or kawaii proportions",
    "generic moe character design",
    "embedded paragraphs, fake map labels, watermarks, or logos",
  ],
} as const;

export type GrowthVisualPurpose = "world_map" | "character_portrait" | "scene";
export type GrowthMapScale = "world" | "region" | "nation" | "city";

export interface GrowthVisualPurposePolicy {
  id: "growth-visual-purpose-v1";
  purpose: GrowthVisualPurpose;
  mapScale: GrowthMapScale | null;
  positive: string[];
  negative: string[];
}

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

/** Purpose composition stays code-owned even when a user overrides aesthetic style. */
export function resolveGrowthVisualPurposePolicy(
  purpose: GrowthVisualPurpose,
  mapScale: GrowthMapScale = "world",
): GrowthVisualPurposePolicy {
  if (purpose === "character_portrait") {
    return {
      id: "growth-visual-purpose-v1",
      purpose,
      mapScale: null,
      positive: [
        "identity-first character portrait with a readable silhouette, face, posture, clothing, and material cues",
        "environmental accents may support the documented identity but must not replace the character as the focal subject",
      ],
      negative: ["generic poster pose, unsupported costume ornament, or invented equipment"],
    };
  }
  if (purpose === "scene") {
    return {
      id: "growth-visual-purpose-v1",
      purpose,
      mapScale: null,
      positive: [
        "scene composition must make documented environment, action, and spatial causality legible",
        "important-detail targets use the same scene language at a closer scale without inventing surrounding facts",
      ],
      negative: ["generic cinematic establishing shot that obscures source-bound relationships"],
    };
  }
  return {
    id: "growth-visual-purpose-v1",
    purpose,
    mapScale,
    positive: [
      "hand-drawn fantasy cartography using the same steel-pen, cross-hatched, restrained-color language",
      mapScaleDirective(mapScale),
      "reserve clear overlay space for authoritative Renderer labels; the generated image itself contains no labels or prose",
    ],
    negative: [
      "embedded place names, paragraphs, legends, compass text, or invented political labels",
      "decorative terrain that contradicts the source-bound topology",
    ],
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

function mapScaleDirective(scale: GrowthMapScale): string {
  if (scale === "world") {
    return "world-scale hierarchy emphasizes continents or macro regions, oceans, climate systems, and interregional routes without street-level detail";
  }
  if (scale === "region") {
    return "region-scale hierarchy emphasizes terrain, hydrology, subregions, settlement networks, and cross-border routes without flattening them into a globe overview";
  }
  if (scale === "nation") {
    return "nation-scale hierarchy emphasizes sourced borders, provinces, capitals, resources, and transport corridors without inventing political labels";
  }
  return "city-scale hierarchy emphasizes sourced districts, streets, waterways, walls, and landmarks without nation-scale abstraction";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function styleError(code: GrowthVisualStylePolicyErrorCode): Error & { code: GrowthVisualStylePolicyErrorCode } {
  return Object.assign(new Error("Growth visual style override is invalid."), { code });
}
