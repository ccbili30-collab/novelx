import { z } from "zod";
import {
  compileGrowthIllustrationPlan,
  type CompiledGrowthIllustrationPlan,
  type TrustedGrowthIllustrationCompileInput,
} from "../../../agent-worker/growth/growthIllustrationPlan";
import { canonicalAuditHash } from "../../../domain/audit/canonicalAuditHash";
import { growthVisualStyleOverrideSchema } from "../../../domain/growth/growthVisualStylePolicy";
import { growthIllustrationAnchorSchema } from "../../../shared/growthContract";

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRefSchema = z.string().regex(/^@evidence[1-9][0-9]*$/);
const purposeSchema = z.enum(["world_map", "character_portrait", "scene"]);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resource"), resourceId: idSchema, resourceVersionId: idSchema,
  }).strict(),
  z.object({
    kind: z.literal("document"), documentId: idSchema, documentVersionId: idSchema, contentSha256: sha256Schema,
  }).strict(),
]);
const evidenceBindingSchema = z.object({
  evidenceRef: evidenceRefSchema,
  evidenceKind: z.enum(["committed_text", "graph_evidence"]),
  sourceCheckpointId: idSchema,
  scopeResourceId: idSchema,
  defaultCoverageRole: z.enum(["world", "place_or_faction", "story", "major_oc", "important_detail", "supporting"]),
  mapScale: z.enum(["world", "region", "nation", "city"]).optional(),
  source: sourceSchema,
  authorizedFacts: z.string().trim().min(1).max(8_000),
  targetAnchorInput: growthIllustrationAnchorSchema,
  visualOverride: growthVisualStyleOverrideSchema.optional(),
}).strict();
const inputSchema = z.object({
  goalId: idSchema,
  cycleId: idSchema,
  sourceCheckpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  authorizedScopeResourceIds: z.array(idSchema).min(1).max(100),
  targetEvidenceRef: evidenceRefSchema,
  purpose: purposeSchema,
  title: z.string().trim().min(1).max(240),
  variantKey: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  objective: z.string().trim().min(1).max(2_000),
  ruleVisualOverride: growthVisualStyleOverrideSchema.optional(),
  goalVisualDefault: growthVisualStyleOverrideSchema.optional(),
  perImageVisualOverride: growthVisualStyleOverrideSchema.optional(),
  evidenceBindings: z.array(evidenceBindingSchema).min(2).max(100),
}).strict();

export type GrowthVisualBriefPacketCompileInput = z.input<typeof inputSchema>;

const framingSchema = z.enum([
  "cartographic_overview", "cartographic_detail",
  "full_body", "three_quarter", "bust",
  "wide_scene", "medium_scene", "close_detail",
]);
const viewpointSchema = z.enum(["overhead", "orthographic", "eye_level", "high_angle", "low_angle"]);
const layoutSchema = z.enum(["balanced_hierarchy", "single_subject_environment", "foreground_midground_background", "contextual_detail"]);

export const growthVisualDirectorBriefSchema = z.object({
  packetSha256: sha256Schema,
  focalEvidenceRef: evidenceRefSchema,
  supportingEvidenceRefs: z.array(evidenceRefSchema).max(20),
  framing: framingSchema,
  viewpoint: viewpointSchema,
  layout: layoutSchema,
}).strict();

export type GrowthVisualDirectorBrief = z.infer<typeof growthVisualDirectorBriefSchema>;

const packetSchema = z.object({
  version: z.literal("1.0.0"),
  identity: z.object({
    goalId: idSchema, cycleId: idSchema, sourceCheckpointId: idSchema, ruleRevision: z.number().int().positive(),
  }).strict(),
  target: z.object({
    evidenceRef: evidenceRefSchema,
    purpose: purposeSchema,
    title: z.string().trim().min(1).max(240),
    variantKey: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
    mapScale: z.enum(["world", "region", "nation", "city"]).nullable(),
  }).strict(),
  objective: z.string().trim().min(1).max(2_000),
  evidence: z.array(z.object({
    evidenceRef: evidenceRefSchema,
    evidenceKind: z.enum(["committed_text", "graph_evidence"]),
    authorizedFacts: z.string().trim().min(1).max(8_000),
    isTarget: z.boolean(),
  }).strict()).min(2).max(100),
  allowedComposition: z.object({
    framing: z.array(framingSchema).min(1),
    viewpoint: z.array(viewpointSchema).min(1),
    layout: z.array(layoutSchema).min(1),
  }).strict(),
  authorityBoundary: z.array(z.string().trim().min(1).max(500)).length(4),
}).strict();

export type GrowthVisualBriefPacket = z.infer<typeof packetSchema>;

interface TrustedVisualBriefAuthority {
  input: z.output<typeof inputSchema>;
  authoritySha256: string;
}

export interface CompiledGrowthVisualBriefPacket {
  packet: GrowthVisualBriefPacket;
  packetSha256: string;
  /** Main-only authority. Pass only `packet` to the Visual Director. */
  trustedAuthority: TrustedVisualBriefAuthority;
}

export interface CompiledGrowthVisualBrief {
  brief: GrowthVisualDirectorBrief;
  compositionDescription: string;
  plan: CompiledGrowthIllustrationPlan;
}

export function compileGrowthVisualBriefPacket(rawInput: unknown): CompiledGrowthVisualBriefPacket {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw visualBriefError("GROWTH_VISUAL_BRIEF_INPUT_INVALID");
  const input = parsed.data;
  assertPacketAuthority(input);
  const trusted = illustrationTrustedInput(input);
  try {
    compileGrowthIllustrationPlan({
      coverageMode: "custom",
      items: [{
        targetEvidenceRef: input.targetEvidenceRef,
        evidenceRefs: input.evidenceBindings.map((binding) => binding.evidenceRef),
        purpose: input.purpose,
        title: input.title,
        compositionDescription: "Select a source-bound composition without adding facts.",
        variantKey: input.variantKey,
        ...styleDeclaration(input),
      }],
    }, trusted);
  } catch {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_AUTHORITY_INVALID");
  }
  const target = input.evidenceBindings.find((binding) => binding.evidenceRef === input.targetEvidenceRef)!;
  const packet = packetSchema.parse({
    version: "1.0.0",
    identity: {
      goalId: input.goalId,
      cycleId: input.cycleId,
      sourceCheckpointId: input.sourceCheckpointId,
      ruleRevision: input.ruleRevision,
    },
    target: {
      evidenceRef: input.targetEvidenceRef,
      purpose: input.purpose,
      title: input.title,
      variantKey: input.variantKey,
      mapScale: input.purpose === "world_map" ? target.mapScale ?? "world" : null,
    },
    objective: input.objective,
    evidence: [...input.evidenceBindings]
      .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef))
      .map((binding) => ({
        evidenceRef: binding.evidenceRef,
        evidenceKind: binding.evidenceKind,
        authorizedFacts: binding.authorizedFacts,
        isTarget: binding.evidenceRef === input.targetEvidenceRef,
      })),
    allowedComposition: allowedComposition(input.purpose),
    authorityBoundary: [
      "Select only packet evidence references; do not restate or extend facts.",
      "Choose only the enumerated framing, viewpoint, and layout values.",
      "Do not provide style, Prompt text, model settings, tools, identifiers, or generation claims.",
      "Deterministic Main code owns style compilation, source versions, queue persistence, and image execution.",
    ],
  });
  const packetSha256 = canonicalAuditHash(packet);
  return {
    packet,
    packetSha256,
    trustedAuthority: { input, authoritySha256: canonicalAuditHash(input) },
  };
}

export function compileGrowthVisualDirectorBrief(
  rawBrief: unknown,
  envelope: CompiledGrowthVisualBriefPacket,
): CompiledGrowthVisualBrief {
  if (canonicalAuditHash(envelope.packet) !== envelope.packetSha256
    || canonicalAuditHash(envelope.trustedAuthority.input) !== envelope.trustedAuthority.authoritySha256) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_PACKET_MISMATCH");
  }
  const parsed = growthVisualDirectorBriefSchema.safeParse(rawBrief);
  if (!parsed.success || parsed.data.packetSha256 !== envelope.packetSha256) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_OUTPUT_INVALID");
  }
  const brief = parsed.data;
  const input = envelope.trustedAuthority.input;
  const knownRefs = new Set(input.evidenceBindings.map((binding) => binding.evidenceRef));
  const selectedRefs = [brief.focalEvidenceRef, ...brief.supportingEvidenceRefs];
  if (new Set(selectedRefs).size !== selectedRefs.length
    || selectedRefs.some((ref) => !knownRefs.has(ref))
    || !selectedRefs.includes(input.targetEvidenceRef)
    || !allowedComposition(input.purpose).framing.includes(brief.framing)
    || !allowedComposition(input.purpose).viewpoint.includes(brief.viewpoint)
    || !allowedComposition(input.purpose).layout.includes(brief.layout)) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_OUTPUT_INVALID");
  }
  const evidenceRefs = [brief.focalEvidenceRef, ...[...brief.supportingEvidenceRefs].sort()];
  const compositionDescription = [
    `Use only selected evidence: ${evidenceRefs.join(", ")}.`,
    `Framing: ${brief.framing}.`,
    `Viewpoint: ${brief.viewpoint}.`,
    `Layout: ${brief.layout}.`,
    "These are composition choices only and add no factual authority.",
  ].join(" ");
  const trusted = illustrationTrustedInput({
    ...input,
    evidenceBindings: input.evidenceBindings.filter((binding) => selectedRefs.includes(binding.evidenceRef)),
  });
  let plan: CompiledGrowthIllustrationPlan;
  try {
    plan = compileGrowthIllustrationPlan({
      coverageMode: "custom",
      items: [{
        targetEvidenceRef: input.targetEvidenceRef,
        evidenceRefs,
        purpose: input.purpose,
        title: input.title,
        compositionDescription,
        variantKey: input.variantKey,
        ...styleDeclaration(input),
      }],
    }, trusted);
  } catch {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_AUTHORITY_INVALID");
  }
  return { brief, compositionDescription, plan };
}

function assertPacketAuthority(input: z.output<typeof inputSchema>): void {
  const refs = input.evidenceBindings.map((binding) => binding.evidenceRef);
  const sourceIdentities = input.evidenceBindings.map((binding) => binding.source.kind === "resource"
    ? `resource:${binding.source.resourceId}:${binding.source.resourceVersionId}`
    : `document:${binding.source.documentId}:${binding.source.documentVersionId}:${binding.source.contentSha256}`);
  if (new Set(input.authorizedScopeResourceIds).size !== input.authorizedScopeResourceIds.length
    || new Set(refs).size !== refs.length
    || new Set(sourceIdentities).size !== sourceIdentities.length) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_DUPLICATE_AUTHORITY");
  }
  if (!refs.includes(input.targetEvidenceRef)
    || input.evidenceBindings.some((binding) => binding.sourceCheckpointId !== input.sourceCheckpointId)
    || !input.evidenceBindings.some((binding) => binding.evidenceKind === "committed_text")
    || !input.evidenceBindings.some((binding) => binding.evidenceKind === "graph_evidence")
    || input.evidenceBindings.some((binding) => binding.evidenceKind === "committed_text" && binding.source.kind !== "document")) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_EVIDENCE_INCOMPLETE");
  }
  const target = input.evidenceBindings.find((binding) => binding.evidenceRef === input.targetEvidenceRef)!;
  if ((input.purpose === "world_map") !== (target.mapScale !== undefined)) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_AUTHORITY_INVALID");
  }
  if (/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[:=]\s*[^\s"}]+)/i.test(JSON.stringify(input))) {
    throw visualBriefError("GROWTH_VISUAL_BRIEF_AUTHORITY_INVALID");
  }
}

function illustrationTrustedInput(input: z.output<typeof inputSchema>): TrustedGrowthIllustrationCompileInput {
  return {
    authorizedScopeResourceIds: input.authorizedScopeResourceIds,
    currentRuleRevision: {
      revision: input.ruleRevision,
      ...(input.ruleVisualOverride ? { visualOverride: input.ruleVisualOverride } : {}),
    },
    ...(input.goalVisualDefault ? { goalVisualDefault: input.goalVisualDefault } : {}),
    ...(input.perImageVisualOverride ? {
      perImageVisualOverrides: [{ variantKey: input.variantKey, visualOverride: input.perImageVisualOverride }],
    } : {}),
    evidenceBindings: input.evidenceBindings.map(({ evidenceKind: _kind, sourceCheckpointId: _checkpoint, ...binding }) => binding),
  };
}

function styleDeclaration(input: z.output<typeof inputSchema>): { styleMode: "user_override"; userVisualSummary: string } | object {
  const selected = input.perImageVisualOverride
    ?? input.evidenceBindings.find((binding) => binding.evidenceRef === input.targetEvidenceRef)?.visualOverride
    ?? input.ruleVisualOverride
    ?? input.goalVisualDefault;
  return selected ? { styleMode: "user_override", userVisualSummary: selected.summary } : {};
}

function allowedComposition(purpose: z.infer<typeof purposeSchema>) {
  if (purpose === "world_map") return {
    framing: ["cartographic_overview", "cartographic_detail"] as Array<z.infer<typeof framingSchema>>,
    viewpoint: ["overhead", "orthographic"] as Array<z.infer<typeof viewpointSchema>>,
    layout: ["balanced_hierarchy", "contextual_detail"] as Array<z.infer<typeof layoutSchema>>,
  };
  if (purpose === "character_portrait") return {
    framing: ["full_body", "three_quarter", "bust"] as Array<z.infer<typeof framingSchema>>,
    viewpoint: ["eye_level", "high_angle", "low_angle"] as Array<z.infer<typeof viewpointSchema>>,
    layout: ["single_subject_environment", "contextual_detail"] as Array<z.infer<typeof layoutSchema>>,
  };
  return {
    framing: ["wide_scene", "medium_scene", "close_detail"] as Array<z.infer<typeof framingSchema>>,
    viewpoint: ["eye_level", "high_angle", "low_angle", "overhead"] as Array<z.infer<typeof viewpointSchema>>,
    layout: ["foreground_midground_background", "balanced_hierarchy", "contextual_detail"] as Array<z.infer<typeof layoutSchema>>,
  };
}

function visualBriefError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth Visual Brief handoff failed."), { code });
}
