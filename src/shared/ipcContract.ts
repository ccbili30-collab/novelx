import { z } from "zod";
import {
  providerSaveRequestSchema,
  providerStatusResultSchema,
  type ProviderSaveRequest,
  type ProviderStatusResult,
  type ProviderTestRequest,
  type ProviderTestResult,
} from "./providerContract";
import type { DesktopUpdateState } from "./desktopUpdateContract";

export const desktopIpcChannels = {
  systemStatus: "novax:system-status",
  updateStatus: "novax:update-status",
  updateCheck: "novax:update-check",
  updateDownload: "novax:update-download",
  updateInstall: "novax:update-install",
  updateEvent: "novax:update-event",
  projectList: "novax:project-list",
  projectAdd: "novax:project-add",
  projectSelect: "novax:project-select",
  projectRemove: "novax:project-remove",
  projectRestore: "novax:project-restore",
  projectListRemoved: "novax:project-list-removed",
  projectRescan: "novax:project-rescan",
  projectInitialize: "novax:project-initialize",
  sessionList: "novax:session-list",
  sessionCreate: "novax:session-create",
  sessionRename: "novax:session-rename",
  sessionArchive: "novax:session-archive",
  sessionClear: "novax:session-clear",
  sessionDelete: "novax:session-delete",
  sessionExport: "novax:session-export",
  sessionMessages: "novax:session-messages",
  collaborationList: "novax:collaboration-list",
  sharedMemoryPublish: "novax:shared-memory-publish",
  handoffCreate: "novax:handoff-create",
  handoffUpdate: "novax:handoff-update",
  workspaceOpen: "novax:workspace-open",
  workspaceCurrent: "novax:workspace-current",
  workspaceHistory: "novax:workspace-history",
  workspaceContextBudget: "novax:workspace-context-budget",
  workspaceRestore: "novax:workspace-restore",
  workspaceFlushRequest: "novax:workspace-flush-request",
  workspaceFlushComplete: "novax:workspace-flush-complete",
  workspaceMutate: "novax:workspace-mutate",
  documentGet: "novax:document-get",
  documentSaveWorking: "novax:document-save-working",
  documentSaveStable: "novax:document-save-stable",
  creativeDocumentGet: "novax:creative-document-get",
  creativeDocumentSaveWorking: "novax:creative-document-save-working",
  creativeDocumentSaveStable: "novax:creative-document-save-stable",
  creativeDocumentDiscardWorking: "novax:creative-document-discard-working",
  constraintEditorGet: "novax:constraint-editor-get",
  constraintEditorSaveWorking: "novax:constraint-editor-save-working",
  constraintEditorSaveStable: "novax:constraint-editor-save-stable",
  constraintEditorDiscardWorking: "novax:constraint-editor-discard-working",
  changeSetListPending: "novax:change-set-list-pending",
  changeSetGet: "novax:change-set-get",
  changeSetDecide: "novax:change-set-decide",
  changeSetFinalizeAssist: "novax:change-set-finalize-assist",
  graphSnapshot: "novax:graph-snapshot",
  graphInspectNode: "novax:graph-inspect-node",
  providerStatus: "novax:provider-status",
  providerSave: "novax:provider-save",
  providerClearCredential: "novax:provider-clear-credential",
  providerTest: "novax:provider-test",
  agentStart: "novax:agent-start",
  agentCancel: "novax:agent-cancel",
  agentEvent: "novax:agent-event",
} as const;

const opaqueIdSchema = z.string().trim().min(1).max(120);

export const projectSummarySchema = z.object({
  id: opaqueIdSchema,
  name: z.string().trim().min(1).max(240),
  state: z.enum(["uninitialized", "materials_detected", "ready", "missing"]),
  sessionCount: z.number().int().min(0).max(100_000),
  updatedAt: z.iso.datetime(),
  active: z.boolean(),
}).strict();

export const projectDetectionSchema = z.object({
  kind: z.enum(["empty", "existing_materials", "initialized"]),
  fileCount: z.number().int().min(0).max(1_000_000),
  supportedFileCount: z.number().int().min(0).max(1_000_000),
}).strict();

export const projectListResultSchema = z.object({
  projects: z.array(projectSummarySchema).max(10_000),
}).strict();

export const projectAddResultSchema = z.object({
  project: projectSummarySchema,
  detection: projectDetectionSchema,
}).strict();

export const nullableProjectAddResultSchema = projectAddResultSchema.nullable();

export const projectSelectRequestSchema = z.object({ projectId: opaqueIdSchema }).strict();
export const projectSelectResultSchema = z.object({
  project: projectSummarySchema,
  workspace: z.lazy(() => workspaceSnapshotSchema).nullable(),
  detection: projectDetectionSchema.nullable(),
}).strict();

export const projectRemoveRequestSchema = z.object({ projectId: opaqueIdSchema }).strict();
export const projectRestoreRequestSchema = z.object({ projectId: opaqueIdSchema }).strict();
export const projectRescanRequestSchema = z.object({ projectId: opaqueIdSchema }).strict();

export const projectInitializeRequestSchema = z.object({
  projectId: opaqueIdSchema,
  strategy: z.enum(["new", "adopt"]),
}).strict();

export const sessionSummarySchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  title: z.string().trim().min(1).max(240),
  state: z.enum(["idle", "working", "review", "blocked"]),
  archived: z.boolean(),
  messageCount: z.number().int().min(0).max(1_000_000),
  updatedAt: z.iso.datetime(),
}).strict();

export const sessionListRequestSchema = z.object({
  projectId: opaqueIdSchema,
  includeArchived: z.boolean().optional().default(false),
}).strict();
export const sessionListResultSchema = z.object({
  sessions: z.array(sessionSummarySchema).max(100_000),
}).strict();

export const sessionCreateRequestSchema = z.object({
  projectId: opaqueIdSchema,
  title: z.string().trim().min(1).max(240).optional().default("新会话"),
}).strict();

export const sessionRenameRequestSchema = z.object({
  sessionId: opaqueIdSchema,
  title: z.string().trim().min(1).max(240),
}).strict();

export const sessionArchiveRequestSchema = z.object({
  sessionId: opaqueIdSchema,
  archived: z.boolean(),
}).strict();

export const sessionClearRequestSchema = z.object({ sessionId: opaqueIdSchema }).strict();
export const sessionDeleteRequestSchema = z.object({ sessionId: opaqueIdSchema }).strict();
export const sessionExportRequestSchema = z.object({ sessionId: opaqueIdSchema }).strict();
export const sessionExportResultSchema = z.object({
  canceled: z.boolean(),
  filePath: z.string().min(1).max(32_768).nullable(),
  messageCount: z.number().int().min(0).max(1_000_000),
}).strict();

const artifactLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), start: z.number().int().positive(), end: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("section"), label: z.string().trim().min(1).max(500) }).strict(),
]);

export const agentArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_call"),
    tool: z.enum(["retrieve_graph_evidence", "propose_change_set", "writer", "checker"]),
    label: z.string().trim().min(1).max(120),
    status: z.enum(["succeeded", "failed", "not_run"]),
  }).strict(),
  z.object({
    kind: z.literal("change_set"),
    changeSetId: opaqueIdSchema,
    state: z.enum(["pending_review", "committed"]),
  }).strict(),
  z.object({
    kind: z.literal("conflict"),
    code: z.enum([
      "missing_source", "conflicting_sources", "missing_gm_resolution", "authority_violation",
      "hidden_fact_risk", "tool_failed", "major_conflict", "user_confirmation_required", "insufficient_input",
    ]),
    message: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(opaqueIdSchema).max(100),
  }).strict(),
  z.object({
    kind: z.literal("document_reference"),
    documentId: opaqueIdSchema,
    title: z.string().trim().min(1).max(240),
    versionId: opaqueIdSchema,
    locator: artifactLocatorSchema,
    excerpt: z.string().max(4_000).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("image"),
    assetId: opaqueIdSchema,
    title: z.string().trim().min(1).max(240),
    status: z.enum(["queued", "generating", "ready", "failed", "stale"]),
    purpose: z.string().trim().min(1).max(500),
    sourceLabel: z.string().trim().min(1).max(500),
    thumbnailUrl: z.string().max(4_000).refine(
      (value) => value.startsWith("data:image/") || value.startsWith("novax-asset:"),
      "Image thumbnails must use a managed Novax asset URL.",
    ).nullable(),
  }).strict(),
]);

export const sessionMessageSchema = z.object({
  id: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  role: z.enum(["user", "assistant", "error"]),
  text: z.string().min(1).max(100_000),
  outcome: z.enum(["completed", "blocked", "review"]).nullable(),
  artifacts: z.array(agentArtifactSchema).max(100).default([]),
  createdAt: z.iso.datetime(),
}).strict();

export const sessionMessageListRequestSchema = z.object({ sessionId: opaqueIdSchema }).strict();
export const sessionMessageListResultSchema = z.object({
  messages: z.array(sessionMessageSchema).max(100_000),
}).strict();

const collaborationScopeIdsSchema = z.array(z.string().trim().min(1).max(120)).max(100);

export const sharedMemorySummarySchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sourceSessionId: opaqueIdSchema.nullable(),
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(4_000),
  scopeResourceIds: collaborationScopeIdsSchema,
  createdAt: z.iso.datetime(),
}).strict();

export const handoffSummarySchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  senderSessionId: opaqueIdSchema,
  recipientSessionId: opaqueIdSchema,
  title: z.string().min(1).max(240),
  instructions: z.string().min(1).max(8_000),
  scopeResourceIds: collaborationScopeIdsSchema,
  status: z.enum(["pending", "accepted", "completed", "cancelled"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const collaborationListRequestSchema = z.object({
  projectId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
}).strict();
export const collaborationListResultSchema = z.object({
  sharedMemories: z.array(sharedMemorySummarySchema).max(10_000),
  handoffs: z.array(handoffSummarySchema).max(10_000),
}).strict();
export const sharedMemoryPublishRequestSchema = z.object({
  projectId: opaqueIdSchema,
  sourceSessionId: opaqueIdSchema.nullable(),
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(4_000),
  scopeResourceIds: collaborationScopeIdsSchema,
}).strict();
export const handoffCreateRequestSchema = z.object({
  projectId: opaqueIdSchema,
  senderSessionId: opaqueIdSchema,
  recipientSessionId: opaqueIdSchema,
  title: z.string().trim().min(1).max(240),
  instructions: z.string().trim().min(1).max(8_000),
  scopeResourceIds: collaborationScopeIdsSchema,
}).strict();
export const handoffUpdateRequestSchema = z.object({
  handoffId: opaqueIdSchema,
  actorSessionId: opaqueIdSchema,
  status: z.enum(["accepted", "completed", "cancelled"]),
}).strict();

export const workspaceResourceSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["world", "oc", "story", "graph", "timeline", "asset"]),
  objectKind: z.enum([
    "domain_root", "world", "oc", "story", "volume", "chapter", "location", "faction",
    "oc_variant", "graph_view", "timeline_view", "asset_collection",
  ]),
  title: z.string().min(1).max(240),
  parentId: z.string().min(1).max(120).nullable(),
}).strict();

export const workspaceCreativeDocumentSchema = z.object({
  id: z.string().min(1).max(160),
  resourceId: z.string().min(1).max(120),
  kind: z.enum([
    "prose", "setting", "character_profile", "location_profile", "faction_profile",
    "knowledge_note", "style_guide", "writing_constraints",
  ]),
  title: z.string().min(1).max(240),
  sortOrder: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const workspaceCreativeRelationSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(["uses_world", "uses_oc", "variant_of", "related_to"]),
  sourceResourceId: z.string().min(1).max(120),
  targetResourceId: z.string().min(1).max(120),
}).strict();

export const constraintProfilePayloadSchema = z.object({
  narrativePerson: z.enum(["first", "second", "third"]).nullable(),
  tense: z.enum(["past", "present", "mixed"]).nullable(),
  tone: z.string().max(500).nullable(),
  pacing: z.string().max(500).nullable(),
  humorLevel: z.number().int().min(0).max(5).nullable(),
  prohibitedContent: z.array(z.string().min(1).max(1000)).max(500),
  requiredContent: z.array(z.string().min(1).max(1000)).max(500),
  notes: z.string().max(20_000),
}).strict();

export const workspaceConstraintProfileSchema = z.object({
  profileId: z.string().min(1).max(120),
  versionId: z.string().min(1).max(120),
  scopeResourceId: z.string().min(1).max(120).nullable(),
  title: z.string().min(1).max(240),
  payload: constraintProfilePayloadSchema,
}).strict();

export const workspaceSnapshotSchema = z.object({
  workspaceId: z.string().min(1).max(120),
  name: z.string().min(1).max(240),
  activeBranchId: z.string().min(1).max(120),
  resources: z.array(workspaceResourceSchema).max(100_000),
  documents: z.array(workspaceCreativeDocumentSchema).max(100_000),
  relations: z.array(workspaceCreativeRelationSchema).max(100_000),
  constraintProfiles: z.array(workspaceConstraintProfileSchema).max(10_000),
}).strict();

export const nullableWorkspaceSnapshotSchema = workspaceSnapshotSchema.nullable();

const creativeObjectKindSchema = workspaceResourceSchema.shape.objectKind;
const resourceDomainSchema = workspaceResourceSchema.shape.type;
const creativeDocumentKindSchema = workspaceCreativeDocumentSchema.shape.kind;
const creativeRelationKindSchema = workspaceCreativeRelationSchema.shape.kind;

export const creativeWorkspaceMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_resource"),
    domain: resourceDomainSchema,
    objectKind: creativeObjectKindSchema.exclude(["domain_root"]),
    title: z.string().trim().min(1).max(240),
    parentId: opaqueIdSchema.nullable(),
  }).strict(),
  z.object({ action: z.literal("rename_resource"), resourceId: opaqueIdSchema, title: z.string().trim().min(1).max(240) }).strict(),
  z.object({ action: z.literal("move_resource"), resourceId: opaqueIdSchema, parentId: opaqueIdSchema }).strict(),
  z.object({ action: z.literal("delete_resource"), resourceId: opaqueIdSchema }).strict(),
  z.object({
    action: z.literal("create_document"),
    resourceId: opaqueIdSchema,
    kind: creativeDocumentKindSchema,
    title: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({ action: z.literal("delete_document"), documentId: z.string().trim().min(1).max(160) }).strict(),
  z.object({
    action: z.literal("create_relation"),
    kind: creativeRelationKindSchema,
    sourceResourceId: opaqueIdSchema,
    targetResourceId: opaqueIdSchema,
  }).strict(),
  z.object({ action: z.literal("delete_relation"), relationId: opaqueIdSchema }).strict(),
  z.object({
    action: z.literal("create_constraint"),
    scopeResourceId: opaqueIdSchema.nullable(),
    title: z.string().trim().min(1).max(240),
    payload: constraintProfilePayloadSchema,
  }).strict(),
  z.object({ action: z.literal("update_constraint"), profileId: opaqueIdSchema, payload: constraintProfilePayloadSchema }).strict(),
  z.object({ action: z.literal("delete_constraint"), profileId: opaqueIdSchema }).strict(),
]);

export const creativeMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), workspace: workspaceSnapshotSchema }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(240) }).strict(),
  }).strict(),
]);

export const checkpointHistoryEntrySchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(500),
  createdAt: z.iso.datetime(),
  isHead: z.boolean(),
}).strict();

const workspaceHistoryErrorSchema = z.object({
  code: z.enum(["WORKSPACE_NOT_OPEN", "WORKSPACE_AGENT_RUN_ACTIVE", "CHECKPOINT_NOT_FOUND", "CHECKPOINT_RESTORE_FAILED"]),
  message: z.string().min(1).max(240),
}).strict();

export const workspaceHistoryResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), checkpoints: z.array(checkpointHistoryEntrySchema).max(100_000) }).strict(),
  z.object({ ok: z.literal(false), error: workspaceHistoryErrorSchema }).strict(),
]);

export const contextBudgetAuditSchema = z.object({
  recordedAt: z.iso.datetime(),
  contextPolicyVersion: z.string().min(1).max(160),
  configuredContextWindow: z.number().int().positive(),
  safetyReserve: z.number().int().min(0),
  outputReserve: z.number().int().min(0),
  estimatedInputTokens: z.number().int().min(0),
  availableInputBudget: z.number().int().min(0),
  systemPromptTokens: z.number().int().min(0),
  toolProtocolTokens: z.number().int().min(0),
  sessionHistoryTokens: z.number().int().min(0),
  retrievalTokens: z.number().int().min(0),
  collaborationTokens: z.number().int().min(0),
  runtimeConversationTokens: z.number().int().min(0),
}).strict();

export const nullableContextBudgetAuditSchema = contextBudgetAuditSchema.nullable();

export const workspaceRestoreRequestSchema = z.object({
  checkpointId: z.string().min(1).max(120),
}).strict();

export const workspaceRestoreResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), workspace: workspaceSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: workspaceHistoryErrorSchema }).strict(),
]);

export const workspaceFlushRequestSchema = z.object({
  requestId: z.string().min(1).max(120),
}).strict();

export const workspaceFlushCompleteSchema = z.object({
  requestId: z.string().min(1).max(120),
  success: z.boolean(),
}).strict();

export const documentGetRequestSchema = z.object({
  resourceId: z.string().min(1).max(120),
}).strict();

export const documentSaveWorkingRequestSchema = z.object({
  resourceId: z.string().min(1).max(120),
  content: z.string().max(8_000_000),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStableVersionId: z.string().min(1).max(120).nullable(),
}).strict();

export const documentSaveStableRequestSchema = z.object({
  resourceId: z.string().min(1).max(120),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const editorDocumentSnapshotSchema = z.object({
  resourceId: z.string().min(1).max(120),
  resourceType: z.enum(["world", "oc", "story", "graph", "timeline", "asset"]),
  title: z.string().min(1).max(240),
  content: z.string().max(8_000_000),
  stableVersionId: z.string().min(1).max(120).nullable(),
  workingRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  hasWorkingCopy: z.boolean(),
  dirty: z.boolean(),
}).strict();

export const creativeDocumentGetRequestSchema = z.object({ documentId: z.string().trim().min(1).max(160) }).strict();
export const creativeDocumentSaveWorkingRequestSchema = z.object({
  documentId: z.string().trim().min(1).max(160),
  content: z.string().max(8_000_000),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStableVersionId: opaqueIdSchema.nullable(),
}).strict();
export const creativeDocumentSaveStableRequestSchema = z.object({
  documentId: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const creativeDocumentDiscardWorkingRequestSchema = z.object({
  documentId: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const creativeEditorDocumentSnapshotSchema = z.object({
  documentId: z.string().min(1).max(160),
  resourceId: opaqueIdSchema,
  kind: creativeDocumentKindSchema,
  title: z.string().min(1).max(240),
  content: z.string().max(8_000_000),
  stableVersionId: opaqueIdSchema.nullable(),
  workingRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  hasWorkingCopy: z.boolean(),
  dirty: z.boolean(),
}).strict();
export const creativeDocumentOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), document: creativeEditorDocumentSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(240) }).strict() }).strict(),
]);
export const constraintEditorGetRequestSchema = z.object({ profileId: opaqueIdSchema }).strict();
export const constraintEditorSaveWorkingRequestSchema = z.object({
  profileId: opaqueIdSchema,
  payload: constraintProfilePayloadSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStableVersionId: opaqueIdSchema,
}).strict();
export const constraintEditorRevisionRequestSchema = z.object({
  profileId: opaqueIdSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const constraintEditorSnapshotSchema = z.object({
  profileId: opaqueIdSchema,
  title: z.string().trim().min(1).max(240),
  payload: constraintProfilePayloadSchema,
  stableVersionId: opaqueIdSchema,
  workingRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  hasWorkingCopy: z.boolean(),
  dirty: z.boolean(),
}).strict();
export const constraintEditorOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), profile: constraintEditorSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(240) }).strict() }).strict(),
]);

export const documentErrorCodeSchema = z.enum([
  "WORKSPACE_NOT_OPEN",
  "RESOURCE_NOT_FOUND",
  "DOCUMENT_WORKING_COPY_NOT_FOUND",
  "DOCUMENT_EDIT_CONFLICT",
  "DOCUMENT_BASE_CHANGED",
  "DOCUMENT_NOT_DIRTY",
  "DOCUMENT_OPERATION_FAILED",
]);

export const documentOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    document: editorDocumentSnapshotSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: documentErrorCodeSchema,
      message: z.string().min(1).max(240),
    }).strict(),
  }).strict(),
]);

export const changeSetGetRequestSchema = z.object({
  changeSetId: z.string().trim().min(1).max(120),
}).strict();

export const changeSetDecisionRequestSchema = z.object({
  changeSetId: z.string().trim().min(1).max(120),
  itemId: z.string().trim().min(1).max(160),
  decision: z.enum(["accepted", "rejected", "draft"]),
}).strict();

export const changeSetFinalizeAssistRequestSchema = z.object({
  changeSetId: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(500),
}).strict();

export const changeSetBlockedReasonSchema = z.enum([
  "MAJOR_CONFLICT",
  "FREE_REVIEW_REQUIRED",
  "DEPENDENCY_UNRESOLVED",
  "APPLY_FAILED",
  "POLICY_BLOCKED",
]);

export const safeChangeSetSummarySchema = z.object({
  id: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  mode: z.enum(["free", "assist"]),
  status: z.enum(["pending", "committed", "rejected", "failed"]),
  gateStatus: z.enum(["review_pending", "ready", "blocked"]),
  blockedReason: changeSetBlockedReasonSchema.nullable(),
  itemCount: z.number().int().min(0).max(500),
  pendingCount: z.number().int().min(0).max(500),
}).strict();

export const safeChangeSetItemSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["fact", "resource", "document", "relation", "constraint"]),
  kindLabel: z.string().min(1).max(80),
  decision: z.enum(["pending", "accepted", "rejected", "draft"]),
  risk: z.enum(["low", "elevated"]),
  conflicts: z.array(z.object({
    severity: z.enum(["warning", "major"]),
    code: z.enum(["POLICY_WARNING", "MAJOR_CONFLICT"]),
  }).strict()).max(100),
  semanticSummary: z.string().min(1).max(1000),
  contentPreview: z.string().max(2000).nullable(),
  dependsOn: z.array(z.string().min(1).max(160)).max(500),
}).strict();

export const safeChangeSetDetailSchema = safeChangeSetSummarySchema.extend({
  items: z.array(safeChangeSetItemSchema).max(500),
}).strict();

export const changeSetErrorCodeSchema = z.enum([
  "WORKSPACE_NOT_OPEN",
  "CHANGE_SET_NOT_FOUND",
  "CHANGE_SET_NOT_PENDING",
  "CHANGE_SET_REVIEW_NOT_ALLOWED",
  "CHANGE_SET_ITEM_NOT_FOUND",
  "CHANGE_SET_MAJOR_CONFLICT",
  "CHANGE_SET_REVIEW_INCOMPLETE",
  "CHANGE_SET_DEPENDENCY_UNRESOLVED",
  "CHANGE_SET_EXPECTED_HEAD_MISMATCH",
  "CHANGE_SET_BASE_STALE",
  "CHANGE_SET_BRANCH_MISMATCH",
  "CHANGE_SET_BLOCKED",
  "CHANGE_SET_DATA_INVALID",
  "CHANGE_SET_OPERATION_FAILED",
]);

const changeSetPublicErrorSchema = z.object({
  code: changeSetErrorCodeSchema,
  message: z.string().min(1).max(240),
}).strict();

export const changeSetListPendingResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), changeSets: z.array(safeChangeSetSummarySchema).max(10_000) }).strict(),
  z.object({ ok: z.literal(false), error: changeSetPublicErrorSchema }).strict(),
]);

export const changeSetDetailResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), changeSet: safeChangeSetDetailSchema }).strict(),
  z.object({ ok: z.literal(false), error: changeSetPublicErrorSchema }).strict(),
]);

const graphNodeKindSchema = z.enum(["subject", "fact", "entity"]);
const graphStatusSchema = z.enum(["current", "conflict"]);

const graphScopeSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(240),
  type: z.string().min(1).max(80),
}).strict();

export const semanticGraphNodeSchema = z.object({
  id: z.string().min(1).max(120),
  kind: graphNodeKindSchema,
  label: z.string().min(1).max(500),
  description: z.string().min(1).max(1000),
  semanticType: z.string().min(1).max(80),
  scope: graphScopeSchema,
  status: graphStatusSchema,
  conflict: z.boolean(),
  sourceCount: z.number().int().min(0).max(100_000),
  relationCount: z.number().int().min(0).max(200_000),
}).strict();

export const semanticGraphEdgeSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(["predicate", "entity_reference"]),
  sourceNodeId: z.string().min(1).max(120),
  targetNodeId: z.string().min(1).max(120),
  label: z.string().min(1).max(240),
  status: graphStatusSchema,
}).strict();

export const semanticGraphSnapshotSchema = z.object({
  lens: z.object({
    type: z.literal("creator"),
    label: z.literal("创作者视角"),
    characterLensAvailable: z.literal(false),
    limitation: z.literal("角色认知视角尚未实现。"),
  }).strict(),
  nodes: z.array(semanticGraphNodeSchema).max(100_000),
  edges: z.array(semanticGraphEdgeSchema).max(200_000),
  filterOptions: z.object({
    nodeKinds: z.array(graphNodeKindSchema).max(3),
    semanticTypes: z.array(z.string().min(1).max(80)).max(1_000),
    scopeTypes: z.array(z.string().min(1).max(80)).max(1_000),
    statuses: z.array(graphStatusSchema).max(2),
  }).strict(),
}).strict();

export const graphInspectNodeRequestSchema = z.object({
  nodeId: z.string().min(1).max(120),
}).strict();

const graphSourceSummarySchema = z.object({
  type: z.enum(["change_set", "stable_document", "recorded", "unavailable"]),
  label: z.string().min(1).max(500),
}).strict();

const graphFactDetailSchema = z.object({
  kind: z.literal("fact"),
  subject: z.string().min(1).max(500),
  predicate: z.string().min(1).max(240),
  valueSummary: z.string().min(1).max(1000),
  status: graphStatusSchema,
  scope: graphScopeSchema,
  sources: z.array(graphSourceSummarySchema).max(1_000),
}).strict();

const graphConceptDetailSchema = z.object({
  kind: z.enum(["subject", "entity"]),
  label: z.string().min(1).max(500),
  description: z.string().min(1).max(1000),
  semanticType: z.string().min(1).max(80),
  status: graphStatusSchema,
  scope: graphScopeSchema,
}).strict();

export const semanticGraphInspectorSchema = z.object({
  node: semanticGraphNodeSchema,
  detail: z.union([graphFactDetailSchema, graphConceptDetailSchema]),
  relations: z.array(z.object({
    edgeId: z.string().min(1).max(120),
    direction: z.enum(["incoming", "outgoing"]),
    kind: z.enum(["predicate", "entity_reference"]),
    label: z.string().min(1).max(240),
    neighborId: z.string().min(1).max(120),
    neighborLabel: z.string().min(1).max(500),
    neighborKind: graphNodeKindSchema,
  }).strict()).max(200_000),
}).strict();

export const graphErrorCodeSchema = z.enum([
  "WORKSPACE_NOT_OPEN",
  "GRAPH_NODE_NOT_FOUND",
  "GRAPH_DATA_INVALID",
  "GRAPH_OPERATION_FAILED",
]);

const graphPublicErrorSchema = z.object({
  code: graphErrorCodeSchema,
  message: z.string().min(1).max(240),
}).strict();

export const graphSnapshotResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), graph: semanticGraphSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: graphPublicErrorSchema }).strict(),
]);

export const graphInspectorResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), inspector: semanticGraphInspectorSchema }).strict(),
  z.object({ ok: z.literal(false), error: graphPublicErrorSchema }).strict(),
]);

export const agentRunStartRequestSchema = z.object({
  projectId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  userInput: z.string().trim().min(1).max(12_000),
  mode: z.enum(["free", "assist"]),
  scopeResourceIds: z.array(z.string().trim().min(1).max(120)).max(100).optional().default([]),
}).strict();

export const agentRunStartResponseSchema = z.object({
  runId: z.string().min(1).max(120),
}).strict();

export const agentRunCancelRequestSchema = z.object({
  runId: z.string().min(1).max(120),
}).strict();

export const publicErrorCodeSchema = z.enum([
  "REAL_GM_PROVIDER_REQUIRED",
  "PROMPT_SET_NOT_PUBLISHED",
  "AGENT_TOOLS_REQUIRED",
  "AGENT_AUDIT_REQUIRED",
  "AGENT_CONTEXT_BUDGET_EXCEEDED",
  "PROVIDER_RUNTIME_FAILED",
  "PROVIDER_OUTPUT_INCOMPLETE",
  "PROVIDER_PROTOCOL_FAILED",
  "AGENT_RUN_FAILED",
  "AGENT_RUN_CANCELLED",
  "AGENT_WORKER_INTERRUPTED",
]);

export const publicErrorSchema = z.object({
  code: publicErrorCodeSchema,
  message: z.string().min(1).max(240),
}).strict();

const runStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: z.string().min(1).max(120),
  sessionId: opaqueIdSchema.optional(),
}).strict();

const runFailedEventSchema = z.object({
  type: z.literal("run.failed"),
  runId: z.string().min(1).max(120),
  sessionId: opaqueIdSchema.optional(),
  code: publicErrorCodeSchema,
  message: z.string().min(1).max(240),
}).strict();

const runActivityEventSchema = z.object({
  type: z.literal("run.activity"),
  runId: z.string().min(1).max(120),
  sessionId: opaqueIdSchema.optional(),
  label: z.string().min(1).max(120),
  phase: z.enum(["started", "completed", "failed"]),
  domains: z.array(z.enum(["world", "oc", "story", "graph", "timeline", "asset"])).max(6).optional(),
}).strict();

const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  runId: z.string().min(1).max(120),
  sessionId: opaqueIdSchema.optional(),
  outcome: z.enum(["completed", "blocked", "awaiting_confirmation"]),
  message: z.string().trim().min(1).max(8_000),
  changeSetState: z.enum(["none", "pending_review", "committed"]),
  artifacts: z.array(agentArtifactSchema).max(100).default([]),
}).strict();

export const agentRunEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  runActivityEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
]);

export const systemStatusSchema = z.object({
  platform: z.enum(["win32", "darwin", "linux"]),
  agent: z.literal("not_started"),
}).strict();

export type AgentRunStartRequest = z.input<typeof agentRunStartRequestSchema>;
export type AgentRunStartResponse = z.infer<typeof agentRunStartResponseSchema>;
export type AgentRunCancelRequest = z.infer<typeof agentRunCancelRequestSchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectDetection = z.infer<typeof projectDetectionSchema>;
export type ProjectListResult = z.infer<typeof projectListResultSchema>;
export type ProjectAddResult = z.infer<typeof projectAddResultSchema>;
export type ProjectSelectRequest = z.infer<typeof projectSelectRequestSchema>;
export type ProjectSelectResult = z.infer<typeof projectSelectResultSchema>;
export type ProjectRemoveRequest = z.infer<typeof projectRemoveRequestSchema>;
export type ProjectRestoreRequest = z.infer<typeof projectRestoreRequestSchema>;
export type ProjectRescanRequest = z.infer<typeof projectRescanRequestSchema>;
export type ProjectInitializeRequest = z.infer<typeof projectInitializeRequestSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListRequest = z.input<typeof sessionListRequestSchema>;
export type SessionListResult = z.infer<typeof sessionListResultSchema>;
export type SessionCreateRequest = z.input<typeof sessionCreateRequestSchema>;
export type SessionRenameRequest = z.infer<typeof sessionRenameRequestSchema>;
export type SessionArchiveRequest = z.infer<typeof sessionArchiveRequestSchema>;
export type SessionClearRequest = z.infer<typeof sessionClearRequestSchema>;
export type SessionDeleteRequest = z.infer<typeof sessionDeleteRequestSchema>;
export type SessionExportRequest = z.infer<typeof sessionExportRequestSchema>;
export type SessionExportResult = z.infer<typeof sessionExportResultSchema>;
export type SessionMessage = z.infer<typeof sessionMessageSchema>;
export type AgentArtifact = z.infer<typeof agentArtifactSchema>;
export type SessionMessageListRequest = z.infer<typeof sessionMessageListRequestSchema>;
export type SessionMessageListResult = z.infer<typeof sessionMessageListResultSchema>;
export type SharedMemorySummary = z.infer<typeof sharedMemorySummarySchema>;
export type HandoffSummary = z.infer<typeof handoffSummarySchema>;
export type CollaborationListRequest = z.infer<typeof collaborationListRequestSchema>;
export type CollaborationListResult = z.infer<typeof collaborationListResultSchema>;
export type SharedMemoryPublishRequest = z.infer<typeof sharedMemoryPublishRequestSchema>;
export type HandoffCreateRequest = z.infer<typeof handoffCreateRequestSchema>;
export type HandoffUpdateRequest = z.infer<typeof handoffUpdateRequestSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type CreativeWorkspaceMutation = z.infer<typeof creativeWorkspaceMutationSchema>;
export type CreativeMutationResult = z.infer<typeof creativeMutationResultSchema>;
export type CheckpointHistoryEntry = z.infer<typeof checkpointHistoryEntrySchema>;
export type WorkspaceHistoryResult = z.infer<typeof workspaceHistoryResultSchema>;
export type ContextBudgetAudit = z.infer<typeof contextBudgetAuditSchema>;
export type WorkspaceRestoreRequest = z.infer<typeof workspaceRestoreRequestSchema>;
export type WorkspaceRestoreResult = z.infer<typeof workspaceRestoreResultSchema>;
export type WorkspaceFlushRequest = z.infer<typeof workspaceFlushRequestSchema>;
export type WorkspaceFlushComplete = z.infer<typeof workspaceFlushCompleteSchema>;
export type DocumentGetRequest = z.infer<typeof documentGetRequestSchema>;
export type DocumentSaveWorkingRequest = z.infer<typeof documentSaveWorkingRequestSchema>;
export type DocumentSaveStableRequest = z.infer<typeof documentSaveStableRequestSchema>;
export type EditorDocumentSnapshot = z.infer<typeof editorDocumentSnapshotSchema>;
export type DocumentErrorCode = z.infer<typeof documentErrorCodeSchema>;
export type DocumentOperationResult = z.infer<typeof documentOperationResultSchema>;
export type CreativeDocumentGetRequest = z.infer<typeof creativeDocumentGetRequestSchema>;
export type CreativeDocumentSaveWorkingRequest = z.infer<typeof creativeDocumentSaveWorkingRequestSchema>;
export type CreativeDocumentSaveStableRequest = z.infer<typeof creativeDocumentSaveStableRequestSchema>;
export type CreativeDocumentDiscardWorkingRequest = z.infer<typeof creativeDocumentDiscardWorkingRequestSchema>;
export type ConstraintEditorGetRequest = z.infer<typeof constraintEditorGetRequestSchema>;
export type ConstraintEditorSaveWorkingRequest = z.infer<typeof constraintEditorSaveWorkingRequestSchema>;
export type ConstraintEditorRevisionRequest = z.infer<typeof constraintEditorRevisionRequestSchema>;
export type ConstraintEditorSnapshot = z.infer<typeof constraintEditorSnapshotSchema>;
export type CreativeEditorDocumentSnapshot = z.infer<typeof creativeEditorDocumentSnapshotSchema>;
export type ChangeSetGetRequest = z.infer<typeof changeSetGetRequestSchema>;
export type ChangeSetDecisionRequest = z.infer<typeof changeSetDecisionRequestSchema>;
export type ChangeSetFinalizeAssistRequest = z.infer<typeof changeSetFinalizeAssistRequestSchema>;
export type SafeChangeSetSummary = z.infer<typeof safeChangeSetSummarySchema>;
export type SafeChangeSetDetail = z.infer<typeof safeChangeSetDetailSchema>;
export type ChangeSetErrorCode = z.infer<typeof changeSetErrorCodeSchema>;
export type ChangeSetListPendingResult = z.infer<typeof changeSetListPendingResultSchema>;
export type ChangeSetDetailResult = z.infer<typeof changeSetDetailResultSchema>;
export type GraphInspectNodeRequest = z.infer<typeof graphInspectNodeRequestSchema>;
export type SemanticGraphSnapshot = z.infer<typeof semanticGraphSnapshotSchema>;
export type SemanticGraphInspector = z.infer<typeof semanticGraphInspectorSchema>;
export type GraphErrorCode = z.infer<typeof graphErrorCodeSchema>;
export type GraphSnapshotResult = z.infer<typeof graphSnapshotResultSchema>;
export type GraphInspectorResult = z.infer<typeof graphInspectorResultSchema>;

export interface DesktopApi {
  system: {
    getStatus(): Promise<SystemStatus>;
  };
  update: {
    getStatus(): Promise<DesktopUpdateState>;
    check(): Promise<DesktopUpdateState>;
    download(): Promise<DesktopUpdateState>;
    install(): Promise<void>;
    subscribe(listener: (state: DesktopUpdateState) => void): () => void;
  };
  project: {
    list(): Promise<ProjectListResult>;
    add(): Promise<ProjectAddResult | null>;
    select(request: ProjectSelectRequest): Promise<ProjectSelectResult>;
    remove(request: ProjectRemoveRequest): Promise<ProjectListResult>;
    listRemoved(): Promise<ProjectListResult>;
    restore(request: ProjectRestoreRequest): Promise<ProjectListResult>;
    rescan(request: ProjectRescanRequest): Promise<ProjectSelectResult>;
    initialize(request: ProjectInitializeRequest): Promise<ProjectSelectResult>;
  };
  session: {
    list(request: SessionListRequest): Promise<SessionListResult>;
    create(request: SessionCreateRequest): Promise<SessionSummary>;
    rename(request: SessionRenameRequest): Promise<SessionSummary>;
    archive(request: SessionArchiveRequest): Promise<SessionSummary>;
    clear(request: SessionClearRequest): Promise<SessionSummary>;
    delete(request: SessionDeleteRequest): Promise<SessionListResult>;
    export(request: SessionExportRequest): Promise<SessionExportResult>;
    messages(request: SessionMessageListRequest): Promise<SessionMessageListResult>;
  };
  collaboration: {
    list(request: CollaborationListRequest): Promise<CollaborationListResult>;
    publishMemory(request: SharedMemoryPublishRequest): Promise<SharedMemorySummary>;
    createHandoff(request: HandoffCreateRequest): Promise<HandoffSummary>;
    updateHandoff(request: HandoffUpdateRequest): Promise<HandoffSummary>;
  };
  workspace: {
    open(): Promise<WorkspaceSnapshot | null>;
    getCurrent(): Promise<WorkspaceSnapshot | null>;
    listHistory(): Promise<WorkspaceHistoryResult>;
    getLatestContextBudget(): Promise<ContextBudgetAudit | null>;
    restore(request: WorkspaceRestoreRequest): Promise<WorkspaceRestoreResult>;
    subscribeFlushRequest(listener: (request: WorkspaceFlushRequest) => void): () => void;
    completeFlush(request: WorkspaceFlushComplete): void;
    mutate(request: CreativeWorkspaceMutation): Promise<WorkspaceSnapshot>;
  };
  document: {
    get(request: DocumentGetRequest): Promise<EditorDocumentSnapshot>;
    saveWorking(request: DocumentSaveWorkingRequest): Promise<EditorDocumentSnapshot>;
    saveStable(request: DocumentSaveStableRequest): Promise<EditorDocumentSnapshot>;
  };
  creativeDocument: {
    get(request: CreativeDocumentGetRequest): Promise<CreativeEditorDocumentSnapshot>;
    saveWorking(request: CreativeDocumentSaveWorkingRequest): Promise<CreativeEditorDocumentSnapshot>;
    saveStable(request: CreativeDocumentSaveStableRequest): Promise<CreativeEditorDocumentSnapshot>;
    discardWorking(request: CreativeDocumentDiscardWorkingRequest): Promise<CreativeEditorDocumentSnapshot>;
  };
  constraintEditor: {
    get(request: ConstraintEditorGetRequest): Promise<ConstraintEditorSnapshot>;
    saveWorking(request: ConstraintEditorSaveWorkingRequest): Promise<ConstraintEditorSnapshot>;
    saveStable(request: ConstraintEditorRevisionRequest): Promise<ConstraintEditorSnapshot>;
    discardWorking(request: ConstraintEditorRevisionRequest): Promise<ConstraintEditorSnapshot>;
  };
  changeSet: {
    listPending(): Promise<ChangeSetListPendingResult>;
    get(request: ChangeSetGetRequest): Promise<ChangeSetDetailResult>;
    decide(request: ChangeSetDecisionRequest): Promise<ChangeSetDetailResult>;
    finalizeAssist(request: ChangeSetFinalizeAssistRequest): Promise<ChangeSetDetailResult>;
  };
  graph: {
    getSnapshot(): Promise<GraphSnapshotResult>;
    inspectNode(request: GraphInspectNodeRequest): Promise<GraphInspectorResult>;
  };
  provider: {
    getStatus(): Promise<ProviderStatusResult>;
    save(request: ProviderSaveRequest): Promise<ProviderStatusResult>;
    clearCredential(): Promise<ProviderStatusResult>;
    test(request: ProviderTestRequest): Promise<ProviderTestResult>;
  };
  agent: {
    start(request: AgentRunStartRequest): Promise<AgentRunStartResponse>;
    cancel(request: AgentRunCancelRequest): Promise<void>;
    subscribe(listener: (event: AgentRunEvent) => void): () => void;
  };
}
