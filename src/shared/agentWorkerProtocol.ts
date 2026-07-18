import { z } from "zod";
import { growthInquiryDiagnosticCodes } from "./diagnostics/growthInquiryDiagnostics";
import { workspaceCreativeRelationSchema, workspaceResourceSchema } from "./ipcContract";
import { providerRuntimeProfileSchema } from "./providerContract";
import { growthCapabilityVersion } from "./growthContract";
import { safeDiagnosticEnvelopeV1Schema } from "./diagnostics/safeDiagnosticContract";

const identifierSchema = z.string().trim().min(1).max(240);
const requestIdSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string().min(1).max(240), jsonValueSchema);
const localInquiryIdSchema = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);

const growthLongformOutlineSectionBindingSchema = z.object({
  localId: localInquiryIdSchema,
  title: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(identifierSchema).min(1).max(200),
  continuityConstraints: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
  estimatedCodePoints: z.object({
    min: z.number().int().min(200).max(8_000),
    max: z.number().int().min(200).max(8_000),
  }).strict(),
}).strict();

const growthLongformAuthoritySchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("outline"),
    outlineId: identifierSchema,
    mainStoryResourceId: identifierSchema,
    worldResourceId: identifierSchema,
    focusOcResourceId: identifierSchema,
    personalStoryResourceId: identifierSchema,
  }).strict(),
  z.object({
    phase: z.literal("section"),
    outlineId: identifierSchema,
    storyResourceId: identifierSchema,
    outlineDocumentVersionId: identifierSchema,
    storyTitle: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(2_000),
    sections: z.array(growthLongformOutlineSectionBindingSchema).min(2).max(100),
    selectedSectionId: localInquiryIdSchema,
    sectionSortOrder: z.number().int().min(0).max(2_147_483_647),
    completedSectionIds: z.array(localInquiryIdSchema).max(100),
    priorProseEvidenceIds: z.array(identifierSchema).max(100),
    priorContentSha256: z.array(sha256Schema).max(100),
  }).strict(),
]);

export const growthPriorInquiryContextSchema = z.object({
  localId: localInquiryIdSchema,
  question: z.string().trim().min(1).max(2_000),
  evidenceState: z.enum(["known", "conflicted", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  priority: z.number().finite().min(0).max(1_000_000),
  lifecyclePhase: z.enum(["backlog", "selected", "creator_answered"]),
}).strict();

export const retrieveGraphEvidenceArgsSchema = z.object({
  scopeResourceIds: z.array(identifierSchema).min(1).max(100),
}).strict();

export const growthRunBindingSchema = z.object({
  capabilityVersion: z.literal(growthCapabilityVersion),
  goalId: identifierSchema,
  cycleId: identifierSchema,
  kind: z.enum(["expand", "revision", "closure_evaluation", "repair"]),
  focusKinds: z.array(z.enum(["world", "story", "oc"])).max(3),
  resumeFrontier: z.array(z.enum(["world", "story", "oc"])).max(3),
  inputCheckpointId: identifierSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  authorizedScopeResourceIds: z.array(identifierSchema).min(1).max(100),
  seedResourceIds: z.array(identifierSchema).max(100),
  domainRootResourceIds: z.object({ world: identifierSchema, oc: identifierSchema, story: identifierSchema }).strict(),
  greenfieldCreateAuthorized: z.boolean(),
  priorInquiries: z.array(growthPriorInquiryContextSchema).max(100),
  closureContinuation: z.object({
    requiredAssertions: z.array(z.object({
      facetId: identifierSchema,
      scopeResourceId: identifierSchema,
    }).strict()).min(1).max(100),
  }).strict().nullable().optional(),
  closureProfile: z.object({
    profileId: identifierSchema,
    revision: z.number().int().min(1).max(1_000_000),
    profileKind: z.enum(["world_birth", "oc_saga", "story_universe", "mixed_birth"]),
    subjectResourceId: identifierSchema.nullable(),
    componentProfiles: z.array(z.enum(["world_birth", "oc_saga", "story_universe"])).max(3),
    focusOcResourceId: identifierSchema.nullable(),
    requiredContentFacetIds: z.array(identifierSchema).min(1).max(100),
  }).strict().nullable().default(null),
  closureRepair: z.object({
    profileId: identifierSchema,
    revision: z.number().int().min(1).max(1_000_000),
    originalReviewId: identifierSchema,
    selectedFindingId: identifierSchema,
    selectedFindingFingerprint: sha256Schema,
    safeSummary: z.string().trim().min(1).max(1_000),
    repairObjective: z.string().trim().min(1).max(2_000),
    targetEvidenceIds: z.array(identifierSchema).min(1).max(100),
  }).strict().nullable().default(null),
  longformAuthority: growthLongformAuthoritySchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.authorizedScopeResourceIds).size !== value.authorizedScopeResourceIds.length) {
    context.addIssue({ code: "custom", path: ["authorizedScopeResourceIds"], message: "Growth binding scopes must be unique." });
  }
  if (new Set(value.seedResourceIds).size !== value.seedResourceIds.length) {
    context.addIssue({ code: "custom", path: ["seedResourceIds"], message: "Growth binding seeds must be unique." });
  }
  if (new Set(value.focusKinds).size !== value.focusKinds.length || new Set(value.resumeFrontier).size !== value.resumeFrontier.length) {
    context.addIssue({ code: "custom", path: ["focusKinds"], message: "Growth intent kinds must be unique." });
  }
  if (new Set(value.priorInquiries.map((inquiry) => inquiry.localId)).size !== value.priorInquiries.length) {
    context.addIssue({ code: "custom", path: ["priorInquiries"], message: "Prior Inquiry local IDs must be unique." });
  }
  if (value.kind === "closure_evaluation") {
    if (value.focusKinds.length > 0 || value.resumeFrontier.length > 0 || value.greenfieldCreateAuthorized
      || value.priorInquiries.length > 0 || value.closureProfile === null || value.closureRepair !== null) {
      context.addIssue({ code: "custom", path: ["kind"], message: "Closure evaluation bindings cannot carry content-growth authority." });
    }
  } else if (value.kind === "repair") {
    if (value.focusKinds.length > 0 || value.resumeFrontier.length > 0 || value.greenfieldCreateAuthorized
      || value.priorInquiries.length > 0 || value.closureProfile !== null || value.closureRepair === null) {
      context.addIssue({ code: "custom", path: ["kind"], message: "Closure repair bindings require only trusted repair authority." });
    }
  } else if (value.focusKinds.length === 0 || value.closureProfile !== null || value.closureRepair !== null) {
    context.addIssue({ code: "custom", path: ["focusKinds"], message: "Content-growth bindings require focus kinds and cannot carry Closure authority." });
  }
  if (value.longformAuthority && (value.kind !== "expand" || value.focusKinds.length !== 1
    || value.focusKinds[0] !== "oc" || value.greenfieldCreateAuthorized)) {
    context.addIssue({ code: "custom", path: ["longformAuthority"], message: "Longform authority requires one non-greenfield OC expansion." });
  }
  if (value.closureContinuation) {
    const requirements = value.closureContinuation.requiredAssertions;
    if (value.kind !== "revision"
      || new Set(requirements.map((item) => item.facetId)).size !== requirements.length
      || new Set(requirements.map((item) => `${item.facetId}:${item.scopeResourceId}`)).size !== requirements.length) {
      context.addIssue({ code: "custom", path: ["closureContinuation"], message: "Closure continuation authority requires one revision and unique assertions." });
    }
  }
  if (value.longformAuthority?.phase === "section") {
    const sectionIds = value.longformAuthority.sections.map((section) => section.localId);
    if (new Set(sectionIds).size !== sectionIds.length
      || !sectionIds.includes(value.longformAuthority.selectedSectionId)
      || value.longformAuthority.completedSectionIds.includes(value.longformAuthority.selectedSectionId)
      || new Set(value.longformAuthority.completedSectionIds).size !== value.longformAuthority.completedSectionIds.length
      || new Set(value.longformAuthority.priorProseEvidenceIds).size !== value.longformAuthority.priorProseEvidenceIds.length
      || new Set(value.longformAuthority.priorContentSha256).size !== value.longformAuthority.priorContentSha256.length) {
      context.addIssue({ code: "custom", path: ["longformAuthority"], message: "Longform section authority is inconsistent." });
    }
  }
  const closure = value.closureProfile;
  if (closure) {
    if (new Set(closure.componentProfiles).size !== closure.componentProfiles.length
      || new Set(closure.requiredContentFacetIds).size !== closure.requiredContentFacetIds.length) {
      context.addIssue({ code: "custom", path: ["closureProfile"], message: "Closure binding components and facets must be unique." });
    }
    if (closure.profileKind === "oc_saga") {
      if (closure.subjectResourceId === null || closure.componentProfiles.length > 0 || closure.focusOcResourceId !== null) {
        context.addIssue({ code: "custom", path: ["closureProfile"], message: "OC saga Closure binding requires exactly one subject and no mixed components." });
      }
    } else if (closure.subjectResourceId !== null) {
      context.addIssue({ code: "custom", path: ["closureProfile", "subjectResourceId"], message: "Only OC saga Closure may bind a subject resource." });
    }
    if (closure.profileKind === "mixed_birth") {
      if (closure.componentProfiles.length === 0
        || closure.componentProfiles.includes("oc_saga") !== (closure.focusOcResourceId !== null)) {
        context.addIssue({ code: "custom", path: ["closureProfile"], message: "Mixed Closure binding requires explicit components and matching OC focus authority." });
      }
    } else if (closure.componentProfiles.length > 0 || closure.focusOcResourceId !== null) {
      context.addIssue({ code: "custom", path: ["closureProfile"], message: "Only mixed Closure may bind component profiles or a focus OC." });
    }
  }
  if (value.closureRepair && new Set(value.closureRepair.targetEvidenceIds).size !== value.closureRepair.targetEvidenceIds.length) {
    context.addIssue({ code: "custom", path: ["closureRepair", "targetEvidenceIds"], message: "Closure repair evidence IDs must be unique." });
  }
  const roots = Object.values(value.domainRootResourceIds);
  if (new Set(roots).size !== roots.length || roots.some((root) => !value.authorizedScopeResourceIds.includes(root))) {
    context.addIssue({ code: "custom", path: ["domainRootResourceIds"], message: "Growth domain roots must be unique authorized scopes." });
  }
});

const submitGrowthInquiryQuestionSchema = z.object({
  localId: localInquiryIdSchema,
  question: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(identifierSchema).max(100),
  evidenceState: z.enum(["known", "conflicted", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  proposedAction: z.string().trim().min(1).max(2_000),
  provisionalAssumption: z.string().trim().min(1).max(2_000).nullable(),
  priority: z.number().finite().min(0).max(1_000_000),
  requiresCreatorChoice: z.boolean(),
}).strict();

const submitGrowthInquiryPriorTransitionSchema = z.discriminatedUnion("phase", [
  z.object({ priorLocalId: localInquiryIdSchema, phase: z.literal("promoted"), successorLocalId: localInquiryIdSchema }).strict(),
  z.object({ priorLocalId: localInquiryIdSchema, phase: z.literal("answered") }).strict(),
  z.object({
    priorLocalId: localInquiryIdSchema,
    phase: z.literal("closed"),
    reason: z.enum(["invalidated_by_evidence", "duplicate", "superseded"]),
  }).strict(),
]);

export const submitGrowthInquiryArgsSchema = z.object({
  inquiries: z.array(submitGrowthInquiryQuestionSchema).min(3).max(7),
  selectedLocalId: localInquiryIdSchema.nullable(),
  priorTransitions: z.array(submitGrowthInquiryPriorTransitionSchema).max(100),
}).strict();

export const submitGrowthInquiryResultSchema = z.object({
  status: z.enum(["selected", "creator_choice_required"]),
  safeSummary: z.string().trim().min(1).max(1_000),
}).strict();

export const growthRetrieveGraphEvidenceArgsSchema = z.object({
  variant: z.literal("growth_v1"),
  query: z.string().trim().min(1).max(12_000),
  aliases: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  seedResourceIds: z.array(identifierSchema).max(100).default([]),
  maxHops: z.number().int().min(0).max(3),
  cpuBudgetMs: z.number().int().min(1).max(60_000),
  expansionBudget: z.number().int().min(1).max(100_000),
  resultBudget: z.number().int().min(1).max(100_000),
  tokenBudget: z.number().int().min(1).max(1_000_000),
  contentBudgetChars: z.number().int().min(1).max(1_000_000),
  policyVersion: z.string().trim().min(1).max(120),
}).strict();

const growthEvidenceBaseSchema = z.object({
  evidenceId: identifierSchema,
  label: z.string().trim().min(1).max(500),
});

const growthEvidenceHitSchema = z.discriminatedUnion("kind", [
  growthEvidenceBaseSchema.extend({
    kind: z.literal("resource"),
    excerpt: z.string().max(8_000).nullable(),
    resource: z.object({
      resourceId: identifierSchema,
      type: workspaceResourceSchema.shape.type,
      objectKind: workspaceResourceSchema.shape.objectKind,
    }).strict(),
  }).strict(),
  growthEvidenceBaseSchema.extend({
    kind: z.literal("document"),
    excerpt: z.string().max(8_000),
  }).strict(),
  growthEvidenceBaseSchema.extend({
    kind: z.literal("assertion"),
    subject: z.string().min(1).max(500),
    predicate: z.string().min(1).max(240),
    object: jsonObjectSchema,
  }).strict(),
  growthEvidenceBaseSchema.extend({
    kind: z.literal("relation"),
    relation: z.object({
      kind: workspaceCreativeRelationSchema.shape.kind,
      sourceResourceId: identifierSchema,
      targetResourceId: identifierSchema,
    }).strict(),
  }).strict(),
]);

const growthRevisionTargetAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resource"), evidenceId: identifierSchema, resourceId: identifierSchema,
    type: workspaceResourceSchema.shape.type, objectKind: workspaceResourceSchema.shape.objectKind,
    title: z.string().trim().min(1).max(500), parentId: identifierSchema.nullable(),
    sortOrder: z.number().int().min(0).max(2_147_483_647),
  }).strict(),
  z.object({
    kind: z.literal("document"), evidenceId: identifierSchema, documentId: identifierSchema,
    resourceId: identifierSchema,
    documentKind: z.enum([
      "prose", "setting", "character_profile", "location_profile", "faction_profile",
      "knowledge_note", "style_guide", "writing_constraints",
    ]),
    title: z.string().trim().min(1).max(500), sortOrder: z.number().int().min(0).max(2_147_483_647),
  }).strict(),
  z.object({
    kind: z.literal("assertion"), evidenceId: identifierSchema, assertionId: identifierSchema,
    scopeType: z.string().trim().min(1).max(80), scopeId: identifierSchema,
    subject: z.string().trim().min(1).max(500), predicate: z.string().trim().min(1).max(240),
    object: jsonObjectSchema,
  }).strict(),
  z.object({
    kind: z.literal("relation"), evidenceId: identifierSchema, relationId: identifierSchema,
    relationKind: workspaceCreativeRelationSchema.shape.kind,
    sourceResourceId: identifierSchema, targetResourceId: identifierSchema,
  }).strict(),
]);

export const growthRevisionAuthoritySchema = z.object({
  targets: z.array(growthRevisionTargetAuthoritySchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.targets.map((target) => target.evidenceId)).size !== value.targets.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Revision authority evidence must be unique." });
  }
});

export const growthClosureFacetProjectionSchema = z.object({
  facetId: identifierSchema,
  state: z.enum(["satisfied", "missing", "conflicted", "blocked"]),
  coverage: z.enum(["complete", "partial", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  evidenceIds: z.array(identifierSchema).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Closure facet evidence IDs must be unique." });
  }
  if (value.state === "satisfied" && value.evidenceIds.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Satisfied Closure facets require pinned evidence." });
  }
});

const growthClosureEvaluationProjectionSchema = z.object({
  profileId: identifierSchema,
  revision: z.number().int().min(1).max(1_000_000),
  profileKind: z.enum(["world_birth", "oc_saga", "story_universe", "mixed_birth"]),
  deterministicContentReady: z.boolean(),
  facetResults: z.array(growthClosureFacetProjectionSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.facetResults.map((facet) => facet.facetId)).size !== value.facetResults.length) {
    context.addIssue({ code: "custom", path: ["facetResults"], message: "Closure facet results must be unique." });
  }
  if (value.deterministicContentReady !== value.facetResults.every((facet) => facet.state === "satisfied")) {
    context.addIssue({ code: "custom", path: ["deterministicContentReady"], message: "Closure readiness must match the projected facet results." });
  }
});

export const growthRetrieveGraphEvidenceResultSchema = z.object({
  variant: z.literal("growth_v1"),
  receiptRecorded: z.literal(true),
  /** Internal-only. Agent tool presentation strips this authority before model-visible serialization. */
  receiptId: identifierSchema.optional(),
  /** Internal-only. Agent tool presentation strips this pinned target authority. */
  revisionAuthority: growthRevisionAuthoritySchema.nullable().optional(),
  evidence: z.array(growthEvidenceHitSchema).max(100_000),
  coverage: z.object({
    state: z.enum(["complete", "partial", "unknown"]),
    searchedScopeCount: z.number().int().min(0).max(100),
    omittedCount: z.number().int().min(0).max(1_000_000),
    truncated: z.boolean(),
  }).strict(),
  diagnostics: z.object({
    expandedEdges: z.number().int().min(0).max(100_000),
    consumedContentChars: z.number().int().min(0).max(1_000_000),
  }).strict(),
  closureEvaluation: growthClosureEvaluationProjectionSchema.nullable(),
}).strict();

export const submitClosureSelfAssessmentArgsSchema = z.object({
  decision: z.enum(["continue_growing", "ready_for_checker"]),
  safeSummary: z.string().trim().min(1).max(1_000),
}).strict();

export const submitClosureSelfAssessmentResultSchema = z.object({
  status: z.enum(["continue_growing", "checker_required"]),
  deterministicContentReady: z.boolean(),
  facetResults: z.array(growthClosureFacetProjectionSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.facetResults.map((facet) => facet.facetId)).size !== value.facetResults.length) {
    context.addIssue({ code: "custom", path: ["facetResults"], message: "Closure facet results must be unique." });
  }
  if (value.deterministicContentReady !== value.facetResults.every((facet) => facet.state === "satisfied")) {
    context.addIssue({ code: "custom", path: ["deterministicContentReady"], message: "Closure readiness must match the projected facet results." });
  }
  if (value.status === "checker_required" && !value.deterministicContentReady) {
    context.addIssue({ code: "custom", path: ["status"], message: "Independent Checker review requires deterministic content readiness." });
  }
});

const submitClosureCheckerFindingSchema = z.object({
  localId: localInquiryIdSchema,
  severity: z.enum(["minor", "major", "blocking"]),
  category: z.enum([
    "world_consistency", "story_consistency", "character_consistency", "causality", "continuity",
    "evidence_gap", "scope_violation", "creator_choice_required",
  ]),
  evidenceIds: z.array(identifierSchema).min(1).max(100),
  safeSummary: z.string().trim().min(1).max(1_000),
  repairObjective: z.string().trim().min(1).max(2_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Closure finding evidence IDs must be unique." });
  }
});

export const submitClosureCheckerReviewArgsSchema = z.object({
  decision: z.enum(["accepted", "repairs_required", "blocked"]),
  adverseFindings: z.array(submitClosureCheckerFindingSchema).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.adverseFindings.map((finding) => finding.localId)).size !== value.adverseFindings.length) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Closure finding local IDs must be unique." });
  }
  if (value.decision === "accepted" && value.adverseFindings.length > 0) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Accepted Closure review cannot contain adverse findings." });
  }
  if (value.decision === "repairs_required" && !value.adverseFindings.some((finding) => finding.severity === "major" || finding.severity === "blocking")) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Closure repairs require a major or blocking finding." });
  }
  if (value.decision === "blocked" && !value.adverseFindings.some((finding) => finding.severity === "blocking")) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Blocked Closure review requires a blocking finding." });
  }
});

export const submitClosureCheckerReviewResultSchema = z.object({
  status: z.literal("recorded"),
  decision: z.enum(["accepted", "repairs_required", "blocked"]),
}).strict();

const growthIllustrationPlanItemSchema = z.object({
  targetEvidenceRef: identifierSchema,
  evidenceRefs: z.array(identifierSchema).min(1).max(100),
  purpose: z.enum(["world_map", "character_portrait", "scene"]),
  title: z.string().trim().min(1).max(240),
  compositionDescription: z.string().trim().min(1).max(8_000),
  variantKey: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  styleMode: z.literal("user_override").optional(),
  userVisualSummary: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.styleMode === undefined) !== (value.userVisualSummary === undefined)) {
    context.addIssue({ code: "custom", message: "Growth illustration style override fields must be paired." });
  }
  if (!value.evidenceRefs.includes(value.targetEvidenceRef)) {
    context.addIssue({ code: "custom", path: ["targetEvidenceRef"], message: "Growth illustration target evidence must be cited." });
  }
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Growth illustration evidence refs must be unique." });
  }
});

export const growthIllustrationPlanSchema = z.object({
  coverageMode: z.enum(["default", "all_visible_nodes", "custom"]),
  items: z.array(growthIllustrationPlanItemSchema).min(1),
}).strict().superRefine((value, context) => {
  const variantKeys = value.items.map((item) => item.variantKey);
  if (new Set(variantKeys).size !== variantKeys.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Growth illustration variant keys must be unique." });
  }
});

export const agentRetrieveGraphEvidenceArgsSchema = z.union([
  retrieveGraphEvidenceArgsSchema,
  growthRetrieveGraphEvidenceArgsSchema,
]);

export const inspectProjectFilesArgsSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("overview"),
    path: z.string().trim().max(1_000).optional().default(""),
  }).strict(),
  z.object({
    mode: z.literal("read"),
    path: z.string().trim().min(1).max(1_000),
  }).strict(),
  z.object({
    mode: z.literal("search"),
    path: z.string().trim().max(1_000).optional().default(""),
    query: z.string().trim().min(1).max(500),
  }).strict(),
]);

const projectFileEntrySchema = z.object({
  path: z.string().min(1).max(4_000),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().min(0).nullable(),
  modifiedAt: z.iso.datetime(),
}).strict();

const projectFileReadSchema = z.object({
  path: z.string().min(1).max(4_000),
  kind: z.enum(["text", "binary"]),
  size: z.number().int().min(0),
  sha256: sha256Schema,
  content: z.string().max(120_000).nullable(),
  complete: z.boolean(),
  originalChars: z.number().int().min(0).nullable(),
  returnedChars: z.number().int().min(0).max(120_000),
  startChar: z.number().int().min(0),
  endChar: z.number().int().min(0),
  hasMore: z.boolean(),
}).strict();

const projectFileListingSchema = z.object({
  root: z.string().min(1).max(4_000),
  entries: z.array(projectFileEntrySchema).max(2_000),
  ignoredDirectories: z.array(z.string().min(1).max(240)).max(20),
  incomplete: z.boolean(),
  omittedEntries: z.number().int().min(0),
}).strict();

export const listProjectDirectoryArgsSchema = z.object({
  path: z.string().trim().max(1_000).optional().default(""),
}).strict();
export const listProjectDirectoryResultSchema = projectFileListingSchema;

export const statProjectFileArgsSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
}).strict();
export const statProjectFileResultSchema = projectFileEntrySchema.extend({
  sha256: sha256Schema.nullable(),
}).strict();

export const globProjectFilesArgsSchema = z.object({
  pattern: z.string().trim().min(1).max(1_000),
  path: z.string().trim().max(1_000).optional().default(""),
}).strict();
export const globProjectFilesResultSchema = z.object({
  pattern: z.string().min(1).max(1_000),
  entries: z.array(projectFileEntrySchema).max(2_000),
  incomplete: z.boolean(),
  omittedEntries: z.number().int().min(0),
}).strict();

export const searchProjectFilesArgsSchema = z.object({
  query: z.string().trim().min(1).max(500),
  path: z.string().trim().max(1_000).optional().default(""),
}).strict();
export const searchProjectFilesResultSchema = z.object({
  query: z.string().min(1).max(500),
  matches: z.array(z.object({
    path: z.string().min(1).max(4_000),
    line: z.number().int().positive(),
    excerpt: z.string().max(500),
  }).strict()).max(200),
  scannedFiles: z.number().int().min(0).max(2_000),
  skippedBinaryFiles: z.number().int().min(0),
  incomplete: z.boolean(),
}).strict();

export const readProjectFileArgsSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  offsetChars: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1).max(120_000).optional(),
}).strict();
export const readProjectFileResultSchema = projectFileReadSchema;

const taskNoteSourceSchema = z.object({
  path: z.string().min(1).max(4_000),
  sha256: sha256Schema,
  startChar: z.number().int().min(0),
  endChar: z.number().int().positive(),
}).strict().refine((source) => source.endChar > source.startChar, "Task note source range is invalid.");

const taskNoteSchema = z.object({
  id: identifierSchema,
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(1_000),
  source: taskNoteSourceSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const saveTaskNoteArgsSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(1_000),
  source: taskNoteSourceSchema,
}).strict();
export const saveTaskNoteResultSchema = taskNoteSchema;

export const listTaskNotesArgsSchema = z.object({
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(100).optional().default(100),
}).strict();
export const listTaskNotesResultSchema = z.object({
  notes: z.array(taskNoteSchema).max(100),
  total: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
}).strict();

export const inspectProjectFilesResultSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("overview"),
    listing: projectFileListingSchema,
    files: z.array(projectFileReadSchema).max(40),
    omittedReadableFiles: z.number().int().min(0),
    totalReturnedChars: z.number().int().min(0).max(240_000),
  }).strict(),
  z.object({
    mode: z.literal("read"),
    file: projectFileReadSchema,
  }).strict(),
  z.object({
    mode: z.literal("search"),
    query: z.string().min(1).max(500),
    matches: z.array(z.object({
      path: z.string().min(1).max(4_000),
      line: z.number().int().positive(),
      excerpt: z.string().max(500),
    }).strict()).max(200),
    scannedFiles: z.number().int().min(0).max(2_000),
    skippedBinaryFiles: z.number().int().min(0),
    incomplete: z.boolean(),
  }).strict(),
]);

const contextScopeSchema = z.object({
  resourceId: identifierSchema,
  type: z.enum(["world", "oc", "story", "graph", "timeline", "asset"]),
  title: z.string().min(1).max(500),
}).strict();

const assertionEvidenceSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stable_document"),
    document: z.object({
      resourceId: identifierSchema,
      title: z.string().min(1).max(500),
      versionId: identifierSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("change_set"),
    changeSet: z.object({
      id: identifierSchema,
      summary: z.string().min(1).max(2_000),
      itemId: identifierSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("assertion"),
    assertion: z.object({
      assertionId: identifierSchema,
      versionId: identifierSchema,
      subject: z.string().min(1).max(500),
      predicate: z.string().min(1).max(240),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("unresolved"),
    reason: z.enum(["unsupported_source", "source_not_active"]),
  }).strict(),
]);

export const retrieveGraphEvidenceResultSchema = z.object({
  branch: z.object({
    id: identifierSchema,
    headCheckpointId: identifierSchema,
  }).strict(),
  scopes: z.array(contextScopeSchema).max(100),
  assertions: z.array(z.object({
    assertionId: identifierSchema,
    versionId: identifierSchema,
    scopeResourceId: identifierSchema,
    scopeType: z.string().min(1).max(80),
    subject: z.string().min(1).max(500),
    predicate: z.string().min(1).max(240),
    object: jsonObjectSchema,
    sources: z.array(assertionEvidenceSourceSchema).max(100),
  }).strict()).max(1_000),
  documents: z.array(z.object({
    content: z.string().max(100_000),
    contentState: z.object({
      complete: z.boolean(),
      originalChars: z.number().int().min(0).max(8_000_000),
      returnedChars: z.number().int().min(0).max(100_000),
    }).strict(),
    source: z.object({
      type: z.literal("stable_document"),
      resource: contextScopeSchema,
      document: z.object({
        id: identifierSchema,
        title: z.string().trim().min(1).max(240),
      }).strict().nullable(),
      version: z.object({
        id: identifierSchema,
        checkpointId: identifierSchema,
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        authorKind: z.enum(["user", "agent", "import"]),
      }).strict(),
    }).strict(),
  }).strict()).max(50),
  retrieval: z.object({
    budget: z.object({
      maxDocuments: z.number().int().min(1).max(50),
      maxAssertions: z.number().int().min(1).max(1_000),
      maxDocumentChars: z.number().int().min(1).max(100_000),
      totalChars: z.number().int().min(1).max(500_000),
    }).strict(),
    usage: z.object({
      assertions: z.number().int().min(0).max(1_000),
      documents: z.number().int().min(0).max(50),
      assertionChars: z.number().int().min(0).max(500_000),
      documentChars: z.number().int().min(0).max(500_000),
      totalChars: z.number().int().min(0).max(500_000),
    }).strict(),
    completeness: z.object({
      incomplete: z.boolean(),
      omittedAssertions: z.number().int().min(0),
      omittedDocuments: z.number().int().min(0),
      truncatedDocuments: z.number().int().min(0).max(50),
      limitsHit: z.array(z.enum([
        "max_assertions",
        "max_documents",
        "max_document_chars",
        "total_chars",
      ])).max(4),
    }).strict(),
    ordering: z.object({
      assertions: z.literal("repository_subject_predicate_assertion_id"),
      documents: z.literal("requested_scope_order"),
      relevanceRanking: z.literal("not_applied"),
    }).strict(),
  }).strict(),
}).strict().superRefine((packet, context) => {
  const assertionChars = packet.assertions.reduce((total, assertion) => total + JSON.stringify(assertion).length, 0);
  const documentChars = packet.documents.reduce((total, document) => total + document.content.length, 0);
  const truncatedDocuments = packet.documents.filter((document) => !document.contentState.complete).length;
  const expectedIncomplete = packet.retrieval.completeness.omittedAssertions > 0
    || packet.retrieval.completeness.omittedDocuments > 0
    || truncatedDocuments > 0;
  const invalid = packet.retrieval.usage.assertions !== packet.assertions.length
    || packet.retrieval.usage.documents !== packet.documents.length
    || packet.retrieval.usage.assertionChars !== assertionChars
    || packet.retrieval.usage.documentChars !== documentChars
    || packet.retrieval.usage.totalChars !== assertionChars + documentChars
    || packet.retrieval.usage.totalChars > packet.retrieval.budget.totalChars
    || packet.assertions.length > packet.retrieval.budget.maxAssertions
    || packet.documents.length > packet.retrieval.budget.maxDocuments
    || packet.documents.some((document) => document.content.length > packet.retrieval.budget.maxDocumentChars)
    || packet.documents.some((document) => document.content.length !== document.contentState.returnedChars)
    || packet.documents.some((document) => document.contentState.returnedChars > document.contentState.originalChars)
    || packet.documents.some((document) => document.contentState.complete
      !== (document.contentState.returnedChars === document.contentState.originalChars))
    || packet.retrieval.completeness.truncatedDocuments !== truncatedDocuments
    || packet.retrieval.completeness.incomplete !== expectedIncomplete
    || new Set(packet.retrieval.completeness.limitsHit).size !== packet.retrieval.completeness.limitsHit.length;
  if (invalid) {
    context.addIssue({ code: "custom", message: "Retrieval budget metadata is inconsistent." });
  }
});

const dependencyIdSchema = z.string().trim().min(1).max(160);
const commonProposalItemShape = {
  id: z.string().trim().min(1).max(160),
  dependsOn: z.array(dependencyIdSchema).max(500).default([]),
};

const proposedAssertionItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("assertion.put"),
  payload: z.object({
    assertionId: identifierSchema,
    scopeType: z.string().trim().min(1).max(80),
    scopeId: identifierSchema,
    subject: z.string().trim().min(1).max(500),
    predicate: z.string().trim().min(1).max(240),
    object: jsonObjectSchema,
    evidenceIds: z.array(identifierSchema).min(1).max(200),
  }).strict(),
}).strict();

const proposedCausalRelationItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("causal_relation.put"),
  payload: z.object({
    relationId: identifierSchema,
    relationKind: z.enum(["causes", "enables", "constrains", "prevents", "amplifies", "mitigates", "depends_on"]),
    causeAssertionId: identifierSchema,
    causeAssertionItemId: identifierSchema.nullable(),
    effectAssertionId: identifierSchema,
    effectAssertionItemId: identifierSchema.nullable(),
    mechanism: z.string().trim().min(1).max(2_000),
    conditions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    temporalScope: z.string().trim().min(1).max(1_000),
    polarityStrengthSummary: z.string().trim().min(1).max(1_000),
    epistemicStatus: z.enum(["confirmed", "inferred", "disputed"]),
    sourceBindings: z.array(z.object({
      evidenceId: identifierSchema,
      stableLocator: z.string().trim().min(1).max(2_000),
    }).strict()).min(1).max(50),
  }).strict(),
}).strict();

const proposedResourceItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("resource.put"),
  payload: z.object({
    resourceId: identifierSchema,
    create: z.boolean(),
    type: z.enum(["world", "oc", "story", "graph", "timeline", "asset"]),
    objectKind: z.enum([
      "domain_root", "world", "oc", "story", "volume", "chapter", "location", "faction",
      "oc_variant", "graph_view", "timeline_view", "asset_collection",
    ]).optional(),
    title: z.string().trim().min(1).max(500),
    parentId: identifierSchema.nullable(),
    state: z.enum(["active", "deleted"]),
    sortOrder: z.number().int().min(0).max(2_147_483_647).default(0),
  }).strict(),
}).strict();

const proposedDocumentItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("document.put"),
  payload: z.object({
    resourceId: identifierSchema,
    creativeDocumentId: identifierSchema.optional(),
    content: z.string().max(8_000_000),
  }).strict(),
}).strict();

const proposedCreativeDocumentItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("creative_document.put"),
  payload: z.object({
    documentId: identifierSchema,
    create: z.boolean(),
    resourceId: identifierSchema,
    kind: z.enum([
      "prose", "setting", "character_profile", "location_profile", "faction_profile",
      "knowledge_note", "style_guide", "writing_constraints",
    ]),
    title: z.string().trim().min(1).max(500),
    state: z.enum(["active", "deleted"]),
    sortOrder: z.number().int().min(0).max(2_147_483_647).default(0),
  }).strict(),
}).strict();

const proposedCreativeRelationItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("creative_relation.put"),
  payload: z.object({
    relationId: identifierSchema,
    create: z.boolean(),
    relationKind: z.enum(["uses_world", "uses_oc", "variant_of", "related_to"]),
    sourceResourceId: identifierSchema,
    targetResourceId: identifierSchema,
    state: z.enum(["active", "deleted"]),
  }).strict(),
}).strict();

const proposedConstraintProfileItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("constraint_profile.put"),
  payload: z.object({
    profileId: identifierSchema,
    create: z.boolean(),
    scopeResourceId: identifierSchema.nullable(),
    title: z.string().trim().min(1).max(500),
    profile: z.object({
      narrativePerson: z.enum(["first", "second", "third"]).nullable(),
      tense: z.enum(["past", "present", "mixed"]).nullable(),
      tone: z.string().max(500).nullable(),
      pacing: z.string().max(500).nullable(),
      humorLevel: z.number().int().min(0).max(5).nullable(),
      prohibitedContent: z.array(z.string().trim().min(1).max(1000)).max(500),
      requiredContent: z.array(z.string().trim().min(1).max(1000)).max(500),
      notes: z.string().max(20_000),
    }).strict(),
    state: z.enum(["active", "deleted"]),
  }).strict(),
}).strict();

const proposedProjectFilePutItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("project_file.put"),
  payload: z.object({
    path: z.string().trim().min(1).max(1_000),
    content: z.string().max(8_000_000),
    expectedSha256: sha256Schema.nullable(),
  }).strict(),
}).strict();

const proposedProjectFileDeleteItemSchema = z.object({
  ...commonProposalItemShape,
  kind: z.literal("project_file.delete"),
  payload: z.object({
    path: z.string().trim().min(1).max(1_000),
    expectedSha256: sha256Schema,
  }).strict(),
}).strict();

export const proposedChangeSetItemSchema = z.discriminatedUnion("kind", [
  proposedAssertionItemSchema,
  proposedCausalRelationItemSchema,
  proposedResourceItemSchema,
  proposedDocumentItemSchema,
  proposedCreativeDocumentItemSchema,
  proposedCreativeRelationItemSchema,
  proposedConstraintProfileItemSchema,
  proposedProjectFilePutItemSchema,
  proposedProjectFileDeleteItemSchema,
]);

export const proposeChangeSetArgsSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  items: z.array(proposedChangeSetItemSchema).min(1).max(500),
  /** Internal Worker-to-Main metadata; never present in the model-visible Change Set tool schema. */
  growthRevisionImpact: z.object({
    revisedEvidenceIds: z.array(identifierSchema).max(100),
    preservedEvidenceIds: z.array(identifierSchema).max(100),
    staleVisualEvidenceIds: z.array(identifierSchema).max(100),
  }).strict().superRefine((value, context) => {
    const all = [...value.revisedEvidenceIds, ...value.preservedEvidenceIds];
    if (new Set(value.revisedEvidenceIds).size !== value.revisedEvidenceIds.length
      || new Set(value.preservedEvidenceIds).size !== value.preservedEvidenceIds.length
      || new Set(value.staleVisualEvidenceIds).size !== value.staleVisualEvidenceIds.length
      || new Set(all).size !== all.length) {
      context.addIssue({ code: "custom", message: "Revision impact evidence IDs must be unique and disjoint." });
    }
  }).optional(),
}).strict().superRefine((value, context) => {
  value.items.forEach((item, index) => {
    if (item.kind !== "causal_relation.put") return;
    if (item.payload.causeAssertionId === item.payload.effectAssertionId) {
      context.addIssue({ code: "custom", path: ["items", index, "payload", "effectAssertionId"], message: "A causal relation cannot be a self-edge." });
    }
    const localEndpoints = [item.payload.causeAssertionItemId, item.payload.effectAssertionItemId]
      .filter((id): id is string => id !== null);
    if (localEndpoints.some((id) => !item.dependsOn.includes(id))) {
      context.addIssue({ code: "custom", path: ["items", index, "dependsOn"], message: "Same-Change-Set assertion endpoints require explicit dependencies." });
    }
    const sourceKeys = item.payload.sourceBindings.map((source) => `${source.evidenceId}\u0000${source.stableLocator}`);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      context.addIssue({ code: "custom", path: ["items", index, "payload", "sourceBindings"], message: "Causal source bindings must be unique." });
    }
  });
});

export const proposeChangeSetResultSchema = z.object({
  changeSetId: identifierSchema,
  mode: z.enum(["free", "assist"]),
  status: z.enum(["pending", "committed", "rejected", "failed"]),
  gateStatus: z.enum(["review_pending", "ready", "blocked"]),
  blockedReason: z.string().min(1).max(160).nullable(),
  itemCount: z.number().int().min(1).max(500),
  committedOutputs: z.array(z.object({
    itemId: identifierSchema,
    kind: z.enum([
      "resource_revision", "document_version", "assertion_version",
      "causal_relation_version", "creative_document_revision", "creative_relation_revision", "constraint_profile_version",
      "project_file_version",
    ]),
    outputId: identifierSchema,
  }).strict()).max(500).optional(),
}).strict().superRefine((result, context) => {
  if (result.status !== "committed" && (result.committedOutputs?.length ?? 0) > 0) {
    context.addIssue({ code: "custom", message: "Only committed Change Sets may return stable outputs." });
  }
});

export function isExplicitGreenfieldFreeCreateRequest(mode: "free" | "assist", userInput: string): boolean {
  if (mode !== "free") return false;
  const normalized = userInput.replace(/\s+/g, "");
  if (/(?:先)?(?:不要|别|暂不)(?:创建|生成|制作).{0,40}世界/.test(normalized)) return false;
  const skipsDiscussion = /(?:不要|不用|无需|别)讨论/.test(normalized);
  const selfCreates = /(?:自己|自行)(?:创建|生成|制作)(?:一套|一个)?/.test(normalized);
  const targetsWorld = /世界(?:包|观)?/.test(normalized);
  return skipsDiscussion && selfCreates && targetsWorld;
}

export const generateImageArgsSchema = z.object({
  title: z.string().trim().min(1).max(240),
  purpose: z.enum(["character_portrait", "scene", "world_map"]),
  prompt: z.string().trim().min(1).max(50_000),
  sourceResourceIds: z.array(identifierSchema).min(1).max(100),
  sourceVersionIds: z.array(identifierSchema).min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceResourceIds).size !== value.sourceResourceIds.length
    || new Set(value.sourceVersionIds).size !== value.sourceVersionIds.length) {
    context.addIssue({ code: "custom", message: "Image sources must be unique." });
  }
});

export const generateImageResultSchema = z.object({
  jobId: identifierSchema,
  assetId: identifierSchema,
  status: z.literal("ready"),
  title: z.string().trim().min(1).max(240),
  purpose: z.enum(["character_portrait", "scene", "world_map"]),
  sourceResourceIds: z.array(identifierSchema).min(1).max(100),
  sourceVersionIds: z.array(identifierSchema).min(1).max(100),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  byteLength: z.number().int().positive().max(100_000_000),
  sha256: sha256Schema,
  thumbnailUrl: z.string().max(4_000).refine(
    (value) => value.startsWith("novax-asset:"),
    "Generated images must use a managed Novax asset URL.",
  ),
}).strict();

export const agentToolNameSchema = z.enum([
  "retrieve_graph_evidence",
  "submit_growth_inquiry",
  "submit_closure_self_assessment",
  "submit_closure_checker_review",
  "list_project_directory",
  "stat_project_file",
  "glob_project_files",
  "search_project_files",
  "read_project_file",
  "save_task_note",
  "list_task_notes",
  "inspect_project_files",
  "propose_change_set",
  "generate_image",
]);

export const agentSessionHistorySchema = z.object({
  entries: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(12_000),
    createdAt: z.iso.datetime(),
  }).strict()).max(24),
  completeness: z.object({
    incomplete: z.boolean(),
    omittedMessages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();

export const agentCollaborationContextSchema = z.object({
  sharedMemories: z.array(z.object({
    title: z.string().min(1).max(240),
    content: z.string().min(1).max(4_000),
    scopeResourceIds: z.array(identifierSchema).max(100),
    checkpointId: identifierSchema,
    sourceSessionTitle: z.string().min(1).max(240).nullable(),
    createdAt: z.iso.datetime(),
  }).strict()).max(100),
  handoffs: z.array(z.object({
    title: z.string().min(1).max(240),
    instructions: z.string().min(1).max(8_000),
    scopeResourceIds: z.array(identifierSchema).max(100),
    checkpointId: identifierSchema,
    senderSessionTitle: z.string().min(1).max(240),
    status: z.enum(["pending", "accepted"]),
    createdAt: z.iso.datetime(),
  }).strict()).max(100),
}).strict();

export const agentWorkerRunStartCommandSchema = z.object({
  type: z.literal("run.start"),
  runId: z.string().min(1).max(120),
  userInput: z.string().trim().min(1).max(12_000),
  mode: z.enum(["free", "assist"]),
  scopeResourceIds: z.array(identifierSchema).max(100).optional().default([]),
  sessionHistory: agentSessionHistorySchema.optional().default({
    entries: [],
    completeness: { incomplete: false, omittedMessages: 0 },
  }),
  collaborationContext: agentCollaborationContextSchema.optional().default({
    sharedMemories: [],
    handoffs: [],
  }),
  toolsAvailable: z.boolean(),
  providerProfile: providerRuntimeProfileSchema.nullable(),
  growthBinding: growthRunBindingSchema.optional(),
}).strict();

export const agentWorkerRunCancelCommandSchema = z.object({
  type: z.literal("run.cancel"),
  runId: z.string().min(1).max(120),
}).strict();

export const agentWorkerToolRequestSchema = z.discriminatedUnion("tool", [
  z.object({
    type: z.literal("tool.request"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    tool: z.literal("retrieve_graph_evidence"),
    args: agentRetrieveGraphEvidenceArgsSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.request"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    tool: z.literal("submit_growth_inquiry"),
    args: submitGrowthInquiryArgsSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema,
    tool: z.literal("submit_closure_self_assessment"), args: submitClosureSelfAssessmentArgsSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema,
    tool: z.literal("submit_closure_checker_review"), args: submitClosureCheckerReviewArgsSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.request"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    tool: z.literal("inspect_project_files"),
    args: inspectProjectFilesArgsSchema,
  }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("list_project_directory"), args: listProjectDirectoryArgsSchema }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("stat_project_file"), args: statProjectFileArgsSchema }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("glob_project_files"), args: globProjectFilesArgsSchema }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("search_project_files"), args: searchProjectFilesArgsSchema }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("read_project_file"), args: readProjectFileArgsSchema }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("save_task_note"), args: saveTaskNoteArgsSchema }).strict(),
  z.object({ type: z.literal("tool.request"), runId: z.string().min(1).max(120), requestId: requestIdSchema, tool: z.literal("list_task_notes"), args: listTaskNotesArgsSchema }).strict(),
  z.object({
    type: z.literal("tool.request"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    tool: z.literal("propose_change_set"),
    args: proposeChangeSetArgsSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.request"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    tool: z.literal("generate_image"),
    args: generateImageArgsSchema,
  }).strict(),
]);

export const agentToolInternalErrorCodeSchema = z.enum([
  "AGENT_TOOLS_REQUIRED",
  "AGENT_TOOL_UNKNOWN",
  "AGENT_TOOL_PROTOCOL_FAILED",
  "AGENT_TOOL_TIMEOUT",
  "AGENT_TOOL_FAILED",
  "AGENT_RUN_CANCELLED",
  "PROJECT_FILE_PATH_OUTSIDE_ROOT",
  "PROJECT_FILE_PATH_RESTRICTED",
  "PROJECT_FILE_NOT_FOUND",
  "PROJECT_FILE_NOT_A_FILE",
  "PROJECT_FILE_GLOB_INVALID",
  "PROJECT_FILE_QUERY_INVALID",
  "PROJECT_FILE_RANGE_INVALID",
  "PROJECT_FILE_OPERATION_FAILED",
  "IMAGE_PROVIDER_REQUIRED",
  "WORLD_MAP_SOURCE_RESOURCE_INVALID",
  "WORLD_MAP_SOURCE_WORLD_REQUIRED",
  "WORLD_MAP_SOURCE_VERSION_INVALID",
  "IMAGE_GENERATION_RECONCILIATION_REQUIRED",
  "IMAGE_GENERATION_FAILED",
  "GROWTH_BINDING_INVALID",
  "GROWTH_RETRIEVAL_INPUT_INVALID",
  "GROWTH_PERSISTENCE_FAILED",
  "GROWTH_RETRIEVAL_REQUIRED",
  "GROWTH_INQUIRY_REQUIRED",
  "GROWTH_INQUIRY_INVALID",
  "GROWTH_INQUIRY_STALLED",
  ...growthInquiryDiagnosticCodes,
  "GROWTH_CLOSURE_NOT_READY",
  "GROWTH_CLOSURE_SUBMISSION_INVALID",
  "GROWTH_RECONCILIATION_REQUIRED",
  "GROWTH_RUN_FAILED",
  "GREENFIELD_CREATE_EXPLICIT_FREE_REQUIRED",
  "GREENFIELD_WORKSPACE_NOT_EMPTY",
  "GREENFIELD_CREATE_ONLY_REQUIRED",
  "GREENFIELD_RESOURCE_CREATE_REQUIRED",
  "GREENFIELD_DOMAIN_ROOT_FORBIDDEN",
  "GREENFIELD_CREATIVE_CREATE_REQUIRED",
  "GREENFIELD_PROJECT_FILE_MUTATION_FORBIDDEN",
  "GREENFIELD_DOCUMENT_TARGET_REQUIRED",
  "GREENFIELD_DOCUMENT_DEPENDENCY_REQUIRED",
  "GREENFIELD_ASSERTION_SCOPE_REQUIRED",
  "GREENFIELD_ASSERTION_EVIDENCE_REQUIRED",
  "GREENFIELD_CREATIVE_DOCUMENT_OWNER_REQUIRED",
  "GREENFIELD_CREATIVE_DOCUMENT_DEPENDENCY_REQUIRED",
  "GREENFIELD_RELATION_ENDPOINT_REQUIRED",
  "GREENFIELD_RELATION_DEPENDENCY_REQUIRED",
  "GREENFIELD_CONSTRAINT_SCOPE_REQUIRED",
  "CHANGE_SET_POLICY_REQUIRED",
  "CHANGE_SET_POLICY_INVALID",
  "CHANGE_SET_ITEM_DUPLICATE",
  "CHANGE_SET_DEPENDENCY_DUPLICATE",
  "CHANGE_SET_DEPENDENCY_NOT_FOUND",
  "CHANGE_SET_DEPENDENCY_CYCLE",
  "GREENFIELD_OUTPUT_EVIDENCE_DEPENDENCY_REQUIRED",
  "GREENFIELD_OUTPUT_EVIDENCE_NOT_COMMITTED",
  "CHANGE_SET_OUTPUTS_INCOMPLETE",
  "CHANGE_SET_EXPECTED_HEAD_MISMATCH",
  "CHANGE_SET_PROVENANCE_MISMATCH",
  "IDEMPOTENCY_KEY_REUSED",
  "RESOURCE_DOMAIN_KIND_MISMATCH",
  "RESOURCE_PARENT_REQUIRED",
  "RESOURCE_PARENT_NOT_FOUND",
  "RESOURCE_PARENT_KIND_INVALID",
  "RESOURCE_PARENT_DOMAIN_INVALID",
  "RESOURCE_OWNERSHIP_CYCLE",
  "DOCUMENT_KIND_OWNER_INVALID",
  "RELATION_SELF_REFERENCE",
  "RELATION_SOURCE_KIND_INVALID",
  "RELATION_TARGET_KIND_INVALID",
  "RELATION_ENDPOINT_KIND_INVALID",
  "ASSERTION_SOURCE_REQUIRED",
  "DOCUMENT_VERSION_NOT_FOUND",
  "CHANGE_SET_INPUT_INVALID",
  "CHANGE_SET_POLICY_EXECUTION_FAILED",
  "CHANGE_SET_PERSISTENCE_FAILED",
  "CHANGE_SET_APPLY_FAILED",
]);

const agentWorkerToolSuccessResponseSchema = z.discriminatedUnion("tool", [
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("retrieve_graph_evidence"),
    result: z.union([retrieveGraphEvidenceResultSchema, growthRetrieveGraphEvidenceResultSchema]),
  }).strict(),
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("submit_growth_inquiry"),
    result: submitGrowthInquiryResultSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema,
    ok: z.literal(true), tool: z.literal("submit_closure_self_assessment"), result: submitClosureSelfAssessmentResultSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema,
    ok: z.literal(true), tool: z.literal("submit_closure_checker_review"), result: submitClosureCheckerReviewResultSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("inspect_project_files"),
    result: inspectProjectFilesResultSchema,
  }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("list_project_directory"), result: listProjectDirectoryResultSchema }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("stat_project_file"), result: statProjectFileResultSchema }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("glob_project_files"), result: globProjectFilesResultSchema }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("search_project_files"), result: searchProjectFilesResultSchema }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("read_project_file"), result: readProjectFileResultSchema }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("save_task_note"), result: saveTaskNoteResultSchema }).strict(),
  z.object({ type: z.literal("tool.response"), runId: z.string().min(1).max(120), requestId: requestIdSchema, ok: z.literal(true), tool: z.literal("list_task_notes"), result: listTaskNotesResultSchema }).strict(),
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("propose_change_set"),
    result: proposeChangeSetResultSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("generate_image"),
    result: generateImageResultSchema,
  }).strict(),
]);

const agentWorkerToolFailureResponseSchema = z.object({
  type: z.literal("tool.response"),
  runId: z.string().min(1).max(120),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: z.object({
    code: agentToolInternalErrorCodeSchema,
    message: z.string().min(1).max(240),
  }).strict(),
}).strict();

export const agentWorkerToolResponseSchema = z.union([
  agentWorkerToolSuccessResponseSchema,
  agentWorkerToolFailureResponseSchema,
]);

export const agentWorkerToolRequestEnvelopeSchema = z.object({
  type: z.literal("tool.request"),
  runId: z.string().min(1).max(120),
  requestId: requestIdSchema,
  tool: z.string().min(1).max(120),
  args: z.unknown(),
}).strict();

const auditInvocationStartedOperationSchema = z.object({
  type: z.literal("invocation.started"),
  invocationId: z.string().min(1).max(160),
  parentInvocationId: z.string().min(1).max(160).nullable(),
  role: z.enum(["steward", "gm", "writer", "checker"]),
  prompt: z.object({
    id: z.string().min(1).max(160),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sha256: sha256Schema,
  }).strict(),
  profile: z.object({
    id: z.string().min(1).max(160),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sha256: sha256Schema,
    toolPolicyId: z.string().min(1).max(160),
    toolPolicyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    toolPolicySha256: sha256Schema,
    authorizedTools: z.array(z.string().min(1).max(160)).min(1).max(20),
  }).strict(),
  provider: z.object({
    providerId: z.string().min(1).max(80),
    requestedModelId: z.string().min(1).max(160),
    providerConfigSha256: sha256Schema,
  }).strict(),
  handoff: z.object({
    contractId: z.string().min(1).max(160),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    payloadSha256: sha256Schema,
  }).strict().nullable(),
  inputSha256: sha256Schema,
}).strict();

const auditInvocationTerminalOperationSchema = z.object({
  type: z.literal("invocation.terminal"),
  invocationId: z.string().min(1).max(160),
  eventType: z.enum(["completed", "blocked", "awaiting_confirmation", "failed", "cancelled", "interrupted"]),
  errorCode: z.string().min(1).max(120).nullable(),
  receipt: z.object({
    actualProviderId: z.string().min(1).max(80).nullable(),
    actualModelId: z.string().min(1).max(160).nullable(),
    responseIdSha256: sha256Schema.nullable(),
    stopReason: z.string().min(1).max(80).nullable(),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    totalTokens: z.number().int().min(0).nullable(),
    contextPolicyVersion: z.string().min(1).max(160).nullable(),
    maxChargedInputBytes: z.number().int().min(0).nullable(),
    configuredContextWindow: z.number().int().positive().nullable(),
    safetyReserve: z.number().int().min(0).nullable(),
    outputReserve: z.number().int().min(0).nullable(),
    estimatedInputTokens: z.number().int().min(0).nullable(),
    availableInputBudget: z.number().int().min(0).nullable(),
    systemPromptTokens: z.number().int().min(0).nullable(),
    toolProtocolTokens: z.number().int().min(0).nullable(),
    sessionHistoryTokens: z.number().int().min(0).nullable(),
    retrievalTokens: z.number().int().min(0).nullable(),
    collaborationTokens: z.number().int().min(0).nullable(),
    runtimeConversationTokens: z.number().int().min(0).nullable(),
    correctionAttempts: z.number().int().min(0).max(10),
  }).strict(),
  structuredSubmissionCount: z.number().int().min(0).max(100),
  outputSha256: sha256Schema.nullable(),
}).strict();

const auditLocalToolStartedOperationSchema = z.object({
  type: z.literal("local_tool.started"),
  toolInvocationId: z.string().min(1).max(160),
  invocationId: z.string().min(1).max(160),
  toolName: z.enum(["writer", "checker"]),
  argumentsSha256: sha256Schema,
}).strict();

const auditLocalToolTerminalOperationSchema = z.object({
  type: z.literal("local_tool.terminal"),
  toolInvocationId: z.string().min(1).max(160),
  invocationId: z.string().min(1).max(160),
  eventType: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  errorCode: z.string().min(1).max(120).nullable(),
  resultSha256: sha256Schema.nullable(),
}).strict();

const auditSafeDiagnosticAppendOperationSchema = z.object({
  type: z.literal("safe_diagnostic.append"),
  diagnostic: safeDiagnosticEnvelopeV1Schema,
}).strict();

export const agentWorkerAuditOperationSchema = z.discriminatedUnion("type", [
  auditInvocationStartedOperationSchema,
  auditInvocationTerminalOperationSchema,
  auditLocalToolStartedOperationSchema,
  auditLocalToolTerminalOperationSchema,
  auditSafeDiagnosticAppendOperationSchema,
]);

export const agentWorkerAuditRequestSchema = z.object({
  type: z.literal("audit.request"),
  runId: z.string().min(1).max(120),
  auditRequestId: requestIdSchema,
  operation: agentWorkerAuditOperationSchema,
}).strict();

export const agentWorkerAuditResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("audit.response"),
    runId: z.string().min(1).max(120),
    auditRequestId: requestIdSchema,
    ok: z.literal(true),
  }).strict(),
  z.object({
    type: z.literal("audit.response"),
    runId: z.string().min(1).max(120),
    auditRequestId: requestIdSchema,
    ok: z.literal(false),
    error: z.object({
      code: z.literal("AGENT_AUDIT_REQUIRED"),
      message: z.string().min(1).max(240),
    }).strict(),
  }).strict(),
]);

export const agentWorkerCommandSchema = z.union([
  agentWorkerRunStartCommandSchema,
  agentWorkerRunCancelCommandSchema,
  agentWorkerToolResponseSchema,
  agentWorkerAuditResponseSchema,
]);

export type RetrieveGraphEvidenceArgs = z.infer<typeof retrieveGraphEvidenceArgsSchema>;
export type RetrieveGraphEvidenceResult = z.infer<typeof retrieveGraphEvidenceResultSchema>;
export type GrowthRunBinding = z.infer<typeof growthRunBindingSchema>;
export type GrowthRetrieveGraphEvidenceArgs = z.infer<typeof growthRetrieveGraphEvidenceArgsSchema>;
export type GrowthRetrieveGraphEvidenceResult = z.infer<typeof growthRetrieveGraphEvidenceResultSchema>;
export type GrowthRevisionAuthority = z.infer<typeof growthRevisionAuthoritySchema>;
export type SubmitGrowthInquiryArgs = z.infer<typeof submitGrowthInquiryArgsSchema>;
export type SubmitGrowthInquiryResult = z.infer<typeof submitGrowthInquiryResultSchema>;
export type GrowthClosureFacetProjection = z.infer<typeof growthClosureFacetProjectionSchema>;
export type SubmitClosureSelfAssessmentArgs = z.infer<typeof submitClosureSelfAssessmentArgsSchema>;
export type SubmitClosureSelfAssessmentResult = z.infer<typeof submitClosureSelfAssessmentResultSchema>;
export type SubmitClosureCheckerReviewArgs = z.infer<typeof submitClosureCheckerReviewArgsSchema>;
export type SubmitClosureCheckerReviewResult = z.infer<typeof submitClosureCheckerReviewResultSchema>;
export type GrowthIllustrationPlan = z.infer<typeof growthIllustrationPlanSchema>;
export type AgentRetrieveGraphEvidenceArgs = z.infer<typeof agentRetrieveGraphEvidenceArgsSchema>;
export type InspectProjectFilesArgs = z.infer<typeof inspectProjectFilesArgsSchema>;
export type InspectProjectFilesResult = z.infer<typeof inspectProjectFilesResultSchema>;
export type ListProjectDirectoryArgs = z.infer<typeof listProjectDirectoryArgsSchema>;
export type ListProjectDirectoryResult = z.infer<typeof listProjectDirectoryResultSchema>;
export type StatProjectFileArgs = z.infer<typeof statProjectFileArgsSchema>;
export type StatProjectFileResult = z.infer<typeof statProjectFileResultSchema>;
export type GlobProjectFilesArgs = z.infer<typeof globProjectFilesArgsSchema>;
export type GlobProjectFilesResult = z.infer<typeof globProjectFilesResultSchema>;
export type SearchProjectFilesArgs = z.infer<typeof searchProjectFilesArgsSchema>;
export type SearchProjectFilesResult = z.infer<typeof searchProjectFilesResultSchema>;
export type ReadProjectFileArgs = z.infer<typeof readProjectFileArgsSchema>;
export type ReadProjectFileResult = z.infer<typeof readProjectFileResultSchema>;
export type SaveTaskNoteArgs = z.infer<typeof saveTaskNoteArgsSchema>;
export type SaveTaskNoteResult = z.infer<typeof saveTaskNoteResultSchema>;
export type ListTaskNotesArgs = z.input<typeof listTaskNotesArgsSchema>;
export type ListTaskNotesResult = z.infer<typeof listTaskNotesResultSchema>;
export type ProposeChangeSetArgs = z.infer<typeof proposeChangeSetArgsSchema>;
export type ProposeChangeSetResult = z.infer<typeof proposeChangeSetResultSchema>;
export type GenerateImageArgs = z.infer<typeof generateImageArgsSchema>;
export type GenerateImageResult = z.infer<typeof generateImageResultSchema>;
export type AgentToolName = z.infer<typeof agentToolNameSchema>;
export type AgentSessionHistory = z.infer<typeof agentSessionHistorySchema>;
export type AgentCollaborationContext = z.infer<typeof agentCollaborationContextSchema>;
export type AgentWorkerRunStartCommand = z.input<typeof agentWorkerRunStartCommandSchema>;
export type AgentWorkerRunCancelCommand = z.infer<typeof agentWorkerRunCancelCommandSchema>;
export type AgentWorkerToolRequest = z.infer<typeof agentWorkerToolRequestSchema>;
export type AgentWorkerToolResponse = z.infer<typeof agentWorkerToolResponseSchema>;
export type AgentWorkerAuditOperation = z.infer<typeof agentWorkerAuditOperationSchema>;
export type AgentWorkerAuditRequest = z.infer<typeof agentWorkerAuditRequestSchema>;
export type AgentWorkerAuditResponse = z.infer<typeof agentWorkerAuditResponseSchema>;
export type AgentWorkerCommand = z.infer<typeof agentWorkerCommandSchema>;
