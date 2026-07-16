import { z } from "zod";

export const growthPresentationCapabilityVersion = "growth-presentation-v1" as const;

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime();

export const growthPresentationInspectRequestSchema = z.object({
  projectId: idSchema,
  sessionId: idSchema,
  goalId: idSchema,
}).strict();

export const growthIllustrationCreateTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resource"), resourceId: idSchema }).strict(),
  z.object({ kind: z.literal("graph_node"), nodeId: idSchema }).strict(),
  z.object({
    kind: z.literal("stable_text_span"),
    documentId: idSchema,
    documentVersionId: idSchema,
    startCodePoint: z.number().int().min(0).max(100_000_000),
    endCodePoint: z.number().int().min(1).max(100_000_000),
    textSha256: sha256Schema,
  }).strict().superRefine((value, context) => {
    if (value.endCodePoint <= value.startCodePoint) {
      context.addIssue({ code: "custom", path: ["endCodePoint"], message: "Text span must be non-empty." });
    }
  }),
  z.object({
    kind: z.enum(["working_text_snapshot", "conversation_text_snapshot"]),
    sourceResourceId: idSchema,
    text: z.string().min(1).max(8_000),
  }).strict(),
]);

export const growthIllustrationCreateRequestSchema = z.object({
  projectId: idSchema,
  sessionId: idSchema,
  goalId: idSchema,
  requestId: idSchema,
  target: growthIllustrationCreateTargetSchema,
  purpose: z.enum(["character_portrait", "scene", "world_map"]),
  title: z.string().trim().min(1).max(240),
  compositionDescription: z.string().trim().min(1).max(8_000),
  variantCount: z.number().int().min(1).max(100).default(1),
  visualStyle: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const growthIllustrationCancelRequestSchema = z.object({
  projectId: idSchema,
  sessionId: idSchema,
  goalId: idSchema,
  requestId: idSchema,
}).strict();

const growthImpactSchema = z.object({
  cycleId: idSchema,
  sequence: z.number().int().min(1),
  durableState: z.enum(["planned", "running", "committed", "evaluated", "blocked", "failed", "cancelled", "reconciliation_required"]),
  resourceCount: z.number().int().min(0),
  documentCount: z.number().int().min(0),
  assertionCount: z.number().int().min(0),
  relationCount: z.number().int().min(0),
}).strict();

const growthClosureFindingSchema = z.object({
  severity: z.enum(["minor", "major", "blocking"]),
  category: z.string().trim().min(1).max(120),
  safeSummary: z.string().trim().min(1).max(1_000),
  repairObjective: z.string().trim().min(1).max(1_000),
}).strict();

const growthClosurePresentationSchema = z.object({
  profileId: idSchema,
  profileKind: z.enum(["world", "story", "oc", "mixed"]),
  subjectResourceId: idSchema.nullable(),
  revision: z.number().int().min(1),
  contentState: z.enum(["growing", "closed", "blocked"]),
  visualState: z.enum(["planning", "generating", "ready", "blocked"]),
  satisfiedCount: z.number().int().min(0),
  missingCount: z.number().int().min(0),
  checkerDecision: z.enum(["accepted", "repairs_required", "blocked"]).nullable(),
  findings: z.array(growthClosureFindingSchema).max(100),
  lastProgressCycleSequence: z.number().int().min(0),
}).strict();

const growthLongformPresentationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({
    status: z.literal("blocked"),
    focusOcResourceId: idSchema,
    reasonCode: z.string().regex(/^GROWTH_LONGFORM_[A-Z0-9_]+$/),
  }).strict(),
  z.object({
    status: z.literal("ready"),
    focusOcResourceId: idSchema,
    personalStoryResourceId: idSchema,
    storyTitle: z.string().trim().min(1).max(500),
    completedSectionCount: z.number().int().min(0),
    totalSectionCount: z.number().int().min(1),
    totalCodePoints: z.number().int().min(0),
    currentSectionTitle: z.string().trim().min(1).max(500).nullable(),
    complete: z.boolean(),
  }).strict(),
]);

const growthIllustrationSourcePresentationSchema = z.object({
  kind: z.enum(["resource", "stable_text_span", "working_text_snapshot", "conversation_text_snapshot"]),
  sourceResourceId: idSchema,
  label: z.string().trim().min(1).max(500),
  excerpt: z.string().max(1_000).nullable(),
}).strict();

const growthIllustrationItemPresentationSchema = z.object({
  id: idSchema,
  requestId: idSchema,
  purpose: z.enum(["character_portrait", "scene", "world_map"]),
  title: z.string().trim().min(1).max(240),
  variantKey: idSchema,
  status: z.enum(["planned", "queued", "running", "ready", "failed", "cancelled", "stale", "reconciliation_required"]),
  source: growthIllustrationSourcePresentationSchema,
  imageJobId: idSchema.nullable(),
  assetId: idSchema.nullable(),
  thumbnailUrl: z.string().regex(/^novax-asset:\/\/image\//).nullable(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const growthIllustrationRequestPresentationSchema = z.object({
  id: idSchema,
  status: z.enum(["planned", "running", "completed", "failed", "cancelled", "stale", "reconciliation_required"]),
  coverageMode: z.enum(["default", "all_visible_nodes", "custom"]),
  itemCount: z.number().int().min(0),
  readyCount: z.number().int().min(0),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  items: z.array(growthIllustrationItemPresentationSchema).max(10_000),
}).strict();

export const growthPresentationSnapshotSchema = z.object({
  capabilityVersion: z.literal(growthPresentationCapabilityVersion),
  goalId: idSchema,
  currentRuleRevision: z.number().int().min(1),
  activeCycleRuleRevision: z.number().int().min(1).nullable(),
  guidanceStatus: z.enum(["none", "persisted_pending_boundary", "applied"]),
  impacts: z.array(growthImpactSchema).max(1_000),
  inquirySummaries: z.array(z.string().trim().min(1).max(1_000)).max(100),
  closures: z.array(growthClosurePresentationSchema).max(100),
  longform: growthLongformPresentationSchema,
  illustrationRequests: z.array(growthIllustrationRequestPresentationSchema).max(1_000),
}).strict();

export type GrowthPresentationInspectRequest = z.infer<typeof growthPresentationInspectRequestSchema>;
export type GrowthIllustrationCreateRequest = z.infer<typeof growthIllustrationCreateRequestSchema>;
export type GrowthIllustrationCancelRequest = z.infer<typeof growthIllustrationCancelRequestSchema>;
export type GrowthPresentationSnapshot = z.infer<typeof growthPresentationSnapshotSchema>;
