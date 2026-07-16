import { Type } from "typebox";
import { z } from "zod";
import { canonicalAuditHash } from "../../domain/audit/canonicalAuditHash";
import {
  growthIllustrationPlanSchema,
  type GrowthIllustrationPlan,
} from "../../shared/agentWorkerProtocol";
import { growthIllustrationAnchorSchema } from "../../shared/growthContract";
import {
  growthVisualStyleOverrideSchema,
  resolveGrowthVisualStyle,
  type ResolvedGrowthVisualStyle,
} from "../../domain/growth/growthVisualStylePolicy";

const evidenceRefParameter = Type.String({ minLength: 1, maxLength: 240 });
const planItemParameterFields = {
  targetEvidenceRef: evidenceRefParameter,
  evidenceRefs: Type.Array(evidenceRefParameter, { minItems: 1, maxItems: 100, uniqueItems: true }),
  purpose: Type.Union([Type.Literal("world_map"), Type.Literal("character_portrait"), Type.Literal("scene")]),
  title: Type.String({ minLength: 1, maxLength: 240 }),
  compositionDescription: Type.String({ minLength: 1, maxLength: 8_000 }),
  variantKey: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
};
const growthIllustrationPlanItemParameters = Type.Union([
  Type.Object(planItemParameterFields, { additionalProperties: false }),
  Type.Object({
    ...planItemParameterFields,
    styleMode: Type.Literal("user_override"),
    userVisualSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false }),
]);

export const growthIllustrationPlanParameters = Type.Object({
  coverageMode: Type.Union([Type.Literal("default"), Type.Literal("all_visible_nodes"), Type.Literal("custom")]),
  items: Type.Array(growthIllustrationPlanItemParameters, { minItems: 1 }),
}, { additionalProperties: false });

const trustedSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resource"),
    resourceId: z.string().trim().min(1).max(240),
    resourceVersionId: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({
    kind: z.literal("document"),
    documentId: z.string().trim().min(1).max(240),
    documentVersionId: z.string().trim().min(1).max(240),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
const trustedEvidenceBindingSchema = z.object({
  evidenceRef: z.string().trim().min(1).max(240),
  scopeResourceId: z.string().trim().min(1).max(240),
  defaultCoverageRole: z.enum([
    "world", "place_or_faction", "story", "major_oc", "important_detail", "supporting",
  ]),
  source: trustedSourceSchema,
  authorizedFacts: z.string().trim().min(1).max(8_000),
  targetAnchorInput: growthIllustrationAnchorSchema,
  visualOverride: growthVisualStyleOverrideSchema.optional(),
}).strict();
const trustedCompileInputSchema = z.object({
  authorizedScopeResourceIds: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  currentRuleRevision: z.object({
    revision: z.number().int().min(1).max(1_000_000),
    visualOverride: growthVisualStyleOverrideSchema.optional(),
  }).strict(),
  goalVisualDefault: growthVisualStyleOverrideSchema.optional(),
  perImageVisualOverrides: z.array(z.object({
    variantKey: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/),
    visualOverride: growthVisualStyleOverrideSchema,
  }).strict()).optional(),
  evidenceBindings: z.array(trustedEvidenceBindingSchema).min(1),
}).strict();

export type TrustedGrowthIllustrationCompileInput = z.input<typeof trustedCompileInputSchema>;
type TrustedEvidenceBinding = z.infer<typeof trustedEvidenceBindingSchema>;
type TargetAnchorInput = z.infer<typeof growthIllustrationAnchorSchema>;

export interface CompiledGrowthIllustrationPlan {
  coverageMode: GrowthIllustrationPlan["coverageMode"];
  items: CompiledGrowthIllustrationItem[];
}

export interface CompiledGrowthIllustrationItem {
  purpose: GrowthIllustrationPlan["items"][number]["purpose"];
  title: string;
  variantKey: string;
  resolvedStyle: ResolvedGrowthVisualStyle;
  promptText: string;
  promptSha256: string;
  promptHashInput: GrowthIllustrationPromptHashInput;
  normalizedSources: NormalizedGrowthIllustrationSource[];
  targetAnchorInput: TargetAnchorInput;
}

export type NormalizedGrowthIllustrationSource =
  | { evidenceRef: string; scopeResourceId: string; kind: "resource"; resourceId: string; resourceVersionId: string }
  | { evidenceRef: string; scopeResourceId: string; kind: "document"; documentId: string; documentVersionId: string; contentSha256: string };

export interface GrowthIllustrationPromptHashInput {
  compilerVersion: "growth-illustration-plan-v1";
  currentRuleRevision: number;
  coverageMode: GrowthIllustrationPlan["coverageMode"];
  item: {
    targetEvidenceRef: string;
    evidenceRefs: string[];
    purpose: GrowthIllustrationPlan["items"][number]["purpose"];
    title: string;
    compositionDescription: string;
    variantKey: string;
  };
  resolvedStyle: ResolvedGrowthVisualStyle;
  authorizedEvidence: Array<{ evidenceRef: string; authorizedFacts: string }>;
  normalizedSources: NormalizedGrowthIllustrationSource[];
  targetAnchorInput: TargetAnchorInput;
}

export type GrowthIllustrationPlanErrorCode =
  | "GROWTH_ILLUSTRATION_PLAN_INVALID"
  | "GROWTH_ILLUSTRATION_TRUSTED_INPUT_INVALID"
  | "GROWTH_ILLUSTRATION_EVIDENCE_UNKNOWN"
  | "GROWTH_ILLUSTRATION_EVIDENCE_DUPLICATE"
  | "GROWTH_ILLUSTRATION_EVIDENCE_CROSS_SCOPE"
  | "GROWTH_ILLUSTRATION_TARGET_ANCHOR_INVALID"
  | "GROWTH_ILLUSTRATION_STYLE_OVERRIDE_UNAUTHORIZED"
  | "GROWTH_ILLUSTRATION_STYLE_OVERRIDE_MISMATCH"
  | "GROWTH_ILLUSTRATION_DEFAULT_COVERAGE_INCOMPLETE"
  | "GROWTH_ILLUSTRATION_COVERAGE_INCOMPLETE"
  | "GROWTH_ILLUSTRATION_PROMPT_TOO_LONG";

export function compileGrowthIllustrationPlan(
  input: unknown,
  trustedInput: TrustedGrowthIllustrationCompileInput,
): CompiledGrowthIllustrationPlan {
  const parsedPlan = growthIllustrationPlanSchema.safeParse(input);
  if (!parsedPlan.success) throw illustrationError("GROWTH_ILLUSTRATION_PLAN_INVALID");
  const parsedTrusted = trustedCompileInputSchema.safeParse(trustedInput);
  if (!parsedTrusted.success) throw illustrationError("GROWTH_ILLUSTRATION_TRUSTED_INPUT_INVALID");
  const trusted = parsedTrusted.data;
  const authorizedScopes = new Set(trusted.authorizedScopeResourceIds);
  if (authorizedScopes.size !== trusted.authorizedScopeResourceIds.length) {
    throw illustrationError("GROWTH_ILLUSTRATION_EVIDENCE_DUPLICATE");
  }

  const bindings = new Map<string, TrustedEvidenceBinding>();
  const sourceIdentities = new Set<string>();
  for (const binding of trusted.evidenceBindings) {
    const identity = sourceIdentity(binding);
    if (bindings.has(binding.evidenceRef) || sourceIdentities.has(identity)) {
      throw illustrationError("GROWTH_ILLUSTRATION_EVIDENCE_DUPLICATE");
    }
    if (!authorizedScopes.has(binding.scopeResourceId)) {
      throw illustrationError("GROWTH_ILLUSTRATION_EVIDENCE_CROSS_SCOPE");
    }
    validateAnchorMatchesSource(binding);
    bindings.set(binding.evidenceRef, binding);
    sourceIdentities.add(identity);
  }

  const perImageOverrides = new Map<string, NonNullable<typeof trusted.perImageVisualOverrides>[number]["visualOverride"]>();
  for (const entry of trusted.perImageVisualOverrides ?? []) {
    if (perImageOverrides.has(entry.variantKey)) throw illustrationError("GROWTH_ILLUSTRATION_EVIDENCE_DUPLICATE");
    perImageOverrides.set(entry.variantKey, entry.visualOverride);
  }

  const items = [...parsedPlan.data.items]
    .sort((left, right) => compareStableStrings(left.variantKey, right.variantKey))
    .map((item) => compileItem(parsedPlan.data.coverageMode, item, trusted, bindings, perImageOverrides));
  assertCoverage(parsedPlan.data.coverageMode, parsedPlan.data.items, trusted.evidenceBindings);
  return { coverageMode: parsedPlan.data.coverageMode, items };
}

function assertCoverage(
  coverageMode: GrowthIllustrationPlan["coverageMode"],
  items: GrowthIllustrationPlan["items"],
  bindings: readonly TrustedEvidenceBinding[],
): void {
  if (coverageMode === "custom") return;
  const targeted = new Map<string, Set<GrowthIllustrationPlan["items"][number]["purpose"]>>();
  for (const item of items) {
    const purposes = targeted.get(item.targetEvidenceRef) ?? new Set();
    purposes.add(item.purpose);
    targeted.set(item.targetEvidenceRef, purposes);
  }
  for (const binding of bindings) {
    const purposes = targeted.get(binding.evidenceRef) ?? new Set();
    if (coverageMode === "all_visible_nodes" && purposes.size === 0) {
      throw illustrationError("GROWTH_ILLUSTRATION_COVERAGE_INCOMPLETE");
    }
    if (coverageMode !== "default") continue;
    const requiredPurpose = binding.defaultCoverageRole === "world" ? "world_map"
      : binding.defaultCoverageRole === "major_oc" ? "character_portrait"
        : ["place_or_faction", "story"].includes(binding.defaultCoverageRole) ? "scene"
          : null;
    if (requiredPurpose && !purposes.has(requiredPurpose)) {
      throw illustrationError("GROWTH_ILLUSTRATION_DEFAULT_COVERAGE_INCOMPLETE");
    }
  }
}

function compileItem(
  coverageMode: GrowthIllustrationPlan["coverageMode"],
  item: GrowthIllustrationPlan["items"][number],
  trusted: z.infer<typeof trustedCompileInputSchema>,
  bindings: ReadonlyMap<string, TrustedEvidenceBinding>,
  perImageOverrides: ReadonlyMap<string, z.infer<typeof growthVisualStyleOverrideSchema>>,
): CompiledGrowthIllustrationItem {
  const targetBinding = bindings.get(item.targetEvidenceRef);
  if (!targetBinding) throw illustrationError("GROWTH_ILLUSTRATION_EVIDENCE_UNKNOWN");
  const citedBindings = item.evidenceRefs.map((evidenceRef) => {
    const binding = bindings.get(evidenceRef);
    if (!binding) throw illustrationError("GROWTH_ILLUSTRATION_EVIDENCE_UNKNOWN");
    return binding;
  }).sort((left, right) => compareStableStrings(sourceIdentity(left), sourceIdentity(right)));
  const resolvedStyle = resolveGrowthVisualStyle({
    perImageOverride: perImageOverrides.get(item.variantKey),
    targetOverride: targetBinding.visualOverride,
    ruleRevisionOverride: trusted.currentRuleRevision.visualOverride,
    goalDefault: trusted.goalVisualDefault,
  });
  validateModelStyleDeclaration(item, resolvedStyle);

  const normalizedSources = citedBindings.map(normalizeSource);
  const promptHashInput: GrowthIllustrationPromptHashInput = {
    compilerVersion: "growth-illustration-plan-v1",
    currentRuleRevision: trusted.currentRuleRevision.revision,
    coverageMode,
    item: {
      targetEvidenceRef: item.targetEvidenceRef,
      evidenceRefs: citedBindings.map((binding) => binding.evidenceRef),
      purpose: item.purpose,
      title: item.title,
      compositionDescription: item.compositionDescription,
      variantKey: item.variantKey,
    },
    resolvedStyle,
    authorizedEvidence: citedBindings.map((binding) => ({
      evidenceRef: binding.evidenceRef,
      authorizedFacts: binding.authorizedFacts,
    })),
    normalizedSources,
    targetAnchorInput: targetBinding.targetAnchorInput,
  };
  const promptText = compilePromptText(promptHashInput);
  if (promptText.length > 50_000) throw illustrationError("GROWTH_ILLUSTRATION_PROMPT_TOO_LONG");
  return {
    purpose: item.purpose,
    title: item.title,
    variantKey: item.variantKey,
    resolvedStyle,
    promptText,
    promptSha256: canonicalAuditHash(promptText),
    promptHashInput,
    normalizedSources,
    targetAnchorInput: targetBinding.targetAnchorInput,
  };
}

function validateModelStyleDeclaration(
  item: GrowthIllustrationPlan["items"][number],
  resolvedStyle: ResolvedGrowthVisualStyle,
): void {
  if (resolvedStyle.styleMode === "system_default") {
    if (item.styleMode !== undefined || item.userVisualSummary !== undefined) {
      throw illustrationError("GROWTH_ILLUSTRATION_STYLE_OVERRIDE_UNAUTHORIZED");
    }
    return;
  }
  if (item.styleMode !== "user_override" || item.userVisualSummary !== resolvedStyle.userVisualSummary) {
    throw illustrationError("GROWTH_ILLUSTRATION_STYLE_OVERRIDE_MISMATCH");
  }
}

function validateAnchorMatchesSource(binding: TrustedEvidenceBinding): void {
  const { source, targetAnchorInput: anchor } = binding;
  if (anchor.kind === "working_text_snapshot" || anchor.kind === "conversation_text_snapshot") return;
  const valid = source.kind === "resource"
    ? anchor.kind === "resource" && anchor.resourceId === source.resourceId && anchor.resourceVersionId === source.resourceVersionId
    : anchor.kind === "stable_text_span" && anchor.documentId === source.documentId && anchor.documentVersionId === source.documentVersionId;
  if (!valid) throw illustrationError("GROWTH_ILLUSTRATION_TARGET_ANCHOR_INVALID");
}

function sourceIdentity(binding: TrustedEvidenceBinding): string {
  return binding.source.kind === "resource"
    ? `resource:${binding.source.resourceId}:${binding.source.resourceVersionId}`
    : `document:${binding.source.documentId}:${binding.source.documentVersionId}:${binding.source.contentSha256}`;
}

function normalizeSource(binding: TrustedEvidenceBinding): NormalizedGrowthIllustrationSource {
  return binding.source.kind === "resource"
    ? {
        evidenceRef: binding.evidenceRef,
        scopeResourceId: binding.scopeResourceId,
        kind: "resource",
        resourceId: binding.source.resourceId,
        resourceVersionId: binding.source.resourceVersionId,
      }
    : {
        evidenceRef: binding.evidenceRef,
        scopeResourceId: binding.scopeResourceId,
        kind: "document",
        documentId: binding.source.documentId,
        documentVersionId: binding.source.documentVersionId,
        contentSha256: binding.source.contentSha256,
      };
}

function compilePromptText(input: GrowthIllustrationPromptHashInput): string {
  const styleSummary = input.resolvedStyle.userVisualSummary === null
    ? "System mature hand-drawn manga default."
    : `Explicit user visual direction: ${input.resolvedStyle.userVisualSummary}`;
  return [
    "GROWTH ILLUSTRATION BRIEF",
    "",
    "FACTUAL AUTHORITY",
    "Only depict facts stated in AUTHORIZED EVIDENCE. Treat title and composition as presentation metadata, not as authority for new identities, names, equipment, locations, or events.",
    "AUTHORIZED EVIDENCE:",
    ...input.authorizedEvidence.map((evidence) => `- [${evidence.evidenceRef}] ${evidence.authorizedFacts}`),
    "",
    "PRESENTATION METADATA (NOT FACTUAL EVIDENCE)",
    `Purpose: ${input.item.purpose}`,
    `Title: ${input.item.title}`,
    `Composition: ${input.item.compositionDescription}`,
    "",
    "VISUAL STYLE POLICY",
    styleSummary,
    "Required:",
    ...(input.resolvedStyle.positive.length > 0 ? input.resolvedStyle.positive.map((value) => `- ${value}`) : ["- none specified"]),
    "Avoid:",
    ...(input.resolvedStyle.negative.length > 0 ? input.resolvedStyle.negative.map((value) => `- ${value}`) : ["- none specified"]),
    "Do not add creative facts that are absent from authorized evidence.",
  ].join("\n");
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function illustrationError(code: GrowthIllustrationPlanErrorCode): Error & { code: GrowthIllustrationPlanErrorCode } {
  return Object.assign(new Error("Growth Illustration Plan is invalid."), { code });
}
