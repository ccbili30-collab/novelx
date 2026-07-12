import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";

export const RUNTIME_V2_PROTOCOL_VERSION = 1 as const;

const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const versionedCapabilityKeySchema = z.string().trim().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(160);
const runtimeV2BuildSchema = z.object({
  commit: z.string().trim().min(1).max(160),
  target: z.string().trim().min(1).max(240),
}).strict();
const emptyRuntimeV2PayloadSchema = z.object({}).strict();
const identityStringSchema = z.string().trim().min(1).max(512);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const runtimeV2MessageTypeSchema = z.enum([
  "command",
  "event",
  "response",
  "control",
]);

export const runtimeV2EnvelopeSchema = z.object({
  protocolVersion: z.literal(RUNTIME_V2_PROTOCOL_VERSION),
  messageId: z.uuid(),
  messageType: runtimeV2MessageTypeSchema,
  name: z.string().trim().min(1).max(160),
  sentAt: z.iso.datetime({ offset: true }),
  correlationId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
  sequence: z.number().int().positive().safe(),
  payload: z.json(),
}).strict();

export const runtimeV2HelloPayloadSchema = z.object({
  runtimeVersion: semanticVersionSchema,
  protocolVersions: z.array(z.number().int().min(0).max(65_535)).min(1).max(32),
  capabilities: z.array(z.string().trim().min(1).max(160)).max(200),
  build: runtimeV2BuildSchema,
}).strict().superRefine((payload, context) => {
  if (!payload.protocolVersions.includes(RUNTIME_V2_PROTOCOL_VERSION)) {
    context.addIssue({
      code: "custom",
      path: ["protocolVersions"],
      message: `runtime.hello must advertise protocol version ${RUNTIME_V2_PROTOCOL_VERSION}.`,
    });
  }
  if (new Set(payload.protocolVersions).size !== payload.protocolVersions.length) {
    context.addIssue({
      code: "custom",
      path: ["protocolVersions"],
      message: "runtime.hello protocol versions must be unique.",
    });
  }
  if (new Set(payload.capabilities).size !== payload.capabilities.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "runtime.hello capabilities must be unique.",
    });
  }
});

export const runtimeV2HelloEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("control"),
  name: z.literal("runtime.hello"),
  correlationId: z.null(),
  runId: z.null(),
  payload: runtimeV2HelloPayloadSchema,
}).strict();

export const runtimeV2InitializePayloadSchema = z.object({
  selectedProtocolVersion: z.literal(RUNTIME_V2_PROTOCOL_VERSION),
  application: z.object({
    id: z.string().trim().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(160),
    version: semanticVersionSchema,
    commit: z.string().trim().min(1).max(160),
  }).strict(),
  workspaceDatabasePath: z.string().trim().min(1).max(32_767).nullable(),
  projectRootPath: z.string().trim().min(1).max(32_767).nullable(),
  projectId: identityStringSchema.nullable(),
  workspaceId: identityStringSchema.nullable(),
  featureFlags: z.record(versionedCapabilityKeySchema, z.boolean()),
  hostCapabilityVersions: z.record(versionedCapabilityKeySchema, semanticVersionSchema),
}).strict().superRefine((payload, context) => {
  const configured = payload.workspaceDatabasePath !== null;
  if ((payload.projectRootPath !== null) !== configured) {
    context.addIssue({ code: "custom", path: ["projectRootPath"], message: "projectRootPath must match workspaceDatabasePath presence." });
  }
  if ((payload.projectId !== null) !== configured) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "projectId must match workspaceDatabasePath presence." });
  }
  if ((payload.workspaceId !== null) !== configured) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "workspaceId must match workspaceDatabasePath presence." });
  }
});

export const runtimeV2InitializeEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("runtime.initialize"),
  correlationId: z.null(),
  runId: z.null(),
  payload: runtimeV2InitializePayloadSchema,
}).strict();

export const runtimeV2ReadyPayloadSchema = z.object({
  selectedProtocolVersion: z.literal(RUNTIME_V2_PROTOCOL_VERSION),
  runtime: z.object({
    version: semanticVersionSchema,
    build: runtimeV2BuildSchema,
  }).strict(),
  recoveredRunCount: z.number().int().min(0).safe(),
}).strict();

export const runtimeV2ReadyEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("control"),
  name: z.literal("runtime.ready"),
  correlationId: z.uuid(),
  runId: z.null(),
  payload: runtimeV2ReadyPayloadSchema,
}).strict();

export const runtimeV2ErrorClassSchema = z.enum([
  "protocol",
  "provider_auth",
  "provider_rate_limit",
  "provider_timeout",
  "provider_rejected",
  "context_capacity",
  "tool_arguments",
  "tool_permission",
  "tool_execution",
  "source_conflict",
  "stale_version",
  "storage",
  "runtime_crash",
  "cancelled",
  "validation",
]);

export const runtimeV2ErrorSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/).max(160),
  class: runtimeV2ErrorClassSchema,
  retryable: z.boolean(),
  publicMessage: z.string().trim().min(1).max(2_000),
  stage: z.string().trim().min(1).max(160),
  attempt: z.number().int().min(0).safe(),
  diagnosticId: z.uuid(),
}).strict();

export const runtimeV2ErrorEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("event"),
  name: z.literal("runtime.error"),
  correlationId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
  payload: runtimeV2ErrorSchema,
}).strict();

export const runtimeV2InitializationFailedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("control"),
  name: z.literal("runtime.initialization_failed"),
  correlationId: z.uuid(),
  runId: z.null(),
  payload: runtimeV2ErrorSchema,
}).strict();

export const runtimeV2StatusGetEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("runtime.status.get"),
  correlationId: z.null(),
  runId: z.null(),
  payload: emptyRuntimeV2PayloadSchema,
}).strict();

export const runtimeV2StatusPayloadSchema = z.object({
  initialized: z.literal(true),
  workspaceDatabaseConfigured: z.boolean(),
  recoveredRunCount: z.number().int().min(0).safe(),
  protocolVersion: z.literal(RUNTIME_V2_PROTOCOL_VERSION),
  runtimeVersion: semanticVersionSchema,
}).strict();

export const runtimeV2StatusEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("runtime.status"),
  correlationId: z.uuid(),
  runId: z.null(),
  payload: runtimeV2StatusPayloadSchema,
}).strict();

export const runtimeV2ShutdownEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("runtime.shutdown"),
  correlationId: z.null(),
  runId: z.null(),
  payload: emptyRuntimeV2PayloadSchema,
}).strict();

export const runtimeV2StoppedPayloadSchema = z.object({
  reason: z.literal("requested"),
}).strict();

export const runtimeV2StoppedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("runtime.stopped"),
  correlationId: z.uuid(),
  runId: z.null(),
  payload: runtimeV2StoppedPayloadSchema,
}).strict();

const legacyRevisionReferenceSchema = z.object({
  id: identityStringSchema,
  revision: z.number().int().positive().safe(),
  sha256: sha256Schema.optional(),
}).strict();

const strictRevisionReferenceSchema = legacyRevisionReferenceSchema.extend({
  sha256: sha256Schema,
}).strict();

const versionedPolicyIdentitySchema = z.object({
  id: identityStringSchema,
  version: identityStringSchema,
  sha256: sha256Schema,
}).strict();

const providerRunIdentitySchema = z.object({
  profileId: identityStringSchema,
  providerId: identityStringSchema,
  modelId: identityStringSchema,
  configSha256: sha256Schema,
}).strict();

export const runtimeV2RunPinnedIdentitySchema = z.object({
  projectId: identityStringSchema,
  workspaceId: identityStringSchema,
  sessionId: identityStringSchema,
  sessionBranchId: identityStringSchema,
  userMessageId: identityStringSchema,
  projectBranchId: identityStringSchema,
  goal: legacyRevisionReferenceSchema.nullable(),
  plan: legacyRevisionReferenceSchema.nullable(),
  provider: providerRunIdentitySchema,
  promptBundle: versionedPolicyIdentitySchema,
  agentProfile: versionedPolicyIdentitySchema,
  toolPolicy: versionedPolicyIdentitySchema,
  contextPolicy: versionedPolicyIdentitySchema,
  runtimePolicy: versionedPolicyIdentitySchema,
  runtimeContractVersion: identityStringSchema,
  mode: z.enum(["free", "assist"]),
  sourceCheckpointId: identityStringSchema,
  scopeResourceIds: z.array(identityStringSchema).min(1).max(10_000),
  resourceScopeSha256: sha256Schema,
  userInputSha256: sha256Schema,
}).strict().superRefine((identity, context) => {
  for (let index = 1; index < identity.scopeResourceIds.length; index += 1) {
    if (identity.scopeResourceIds[index - 1] >= identity.scopeResourceIds[index]) {
      context.addIssue({
        code: "custom",
        path: ["scopeResourceIds", index],
        message: "scopeResourceIds must be sorted and unique.",
      });
      break;
    }
  }
});

export const runtimeV2RunStartPayloadSchema = z.object({
  startIdempotencyKey: identityStringSchema,
  pinnedIdentity: runtimeV2RunPinnedIdentitySchema.safeExtend({
    goal: strictRevisionReferenceSchema.nullable(),
    plan: strictRevisionReferenceSchema.nullable(),
  }).strict(),
}).strict();

export const runtimeV2RunStartEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("run.start"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: runtimeV2RunStartPayloadSchema,
}).strict();

export const runtimeV2RunGetEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("run.get"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: emptyRuntimeV2PayloadSchema,
}).strict();

export const runtimeV2RunPreparePayloadSchema = z.object({
  prepareIdempotencyKey: identityStringSchema,
}).strict();

export const runtimeV2RunPrepareEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("run.prepare"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: runtimeV2RunPreparePayloadSchema,
}).strict();

export const runtimeV2RunCancelPayloadSchema = z.object({
  cancelIdempotencyKey: identityStringSchema,
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const runtimeV2RunCancelEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("run.cancel"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: runtimeV2RunCancelPayloadSchema,
}).strict();

export const runtimeV2RunReconciliationDecisionSchema = z.enum([
  "cancel_run",
  "retry_as_new_attempt_acknowledging_duplicate",
]);

export const runtimeV2RunReconcilePayloadSchema = z.object({
  reconciliationIdempotencyKey: identityStringSchema,
  attemptId: z.uuid(),
  decision: runtimeV2RunReconciliationDecisionSchema,
  duplicateExecutionAcknowledged: z.boolean(),
}).strict().superRefine((payload, context) => {
  const required = payload.decision === "retry_as_new_attempt_acknowledging_duplicate";
  if (payload.duplicateExecutionAcknowledged !== required) {
    context.addIssue({ code: "custom", path: ["duplicateExecutionAcknowledged"], message: "Duplicate execution acknowledgement must exactly match the retry decision." });
  }
});

export const runtimeV2RunReconcileEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("run.reconcile"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: runtimeV2RunReconcilePayloadSchema,
}).strict();

export const runtimeV2RunReconciliationReceiptSchema = z.object({
  attemptId: z.uuid(),
  decision: runtimeV2RunReconciliationDecisionSchema,
  state: z.enum(["cancelled", "retrying"]),
}).strict().superRefine((receipt, context) => {
  const expected = receipt.decision === "cancel_run" ? "cancelled" : "retrying";
  if (receipt.state !== expected) context.addIssue({ code: "custom", path: ["state"], message: "Reconciliation state does not match its decision." });
});

export const runtimeV2RunReconciledEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("run.reconciled"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2RunReconciliationReceiptSchema,
}).strict();

export const runtimeV2RunSnapshotPayloadSchema = z.object({
  runId: z.uuid(),
  pinnedIdentity: runtimeV2RunPinnedIdentitySchema,
  state: z.enum([
    "created", "preparing", "running", "waiting_for_approval", "waiting_for_reconciliation", "committing",
    "retrying", "blocked", "cancelled", "failed", "completed",
  ]),
  recoveryClassification: z.enum([
    "resumable", "waiting_for_approval", "waiting_for_reconciliation", "commit_uncertain", "terminal",
  ]),
  runSequence: z.number().int().positive().safe(),
  aggregateSequence: z.number().int().positive().safe(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  terminalError: runtimeV2ErrorSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.runSequence < snapshot.aggregateSequence) {
    context.addIssue({ code: "custom", path: ["runSequence"], message: "runSequence cannot precede aggregateSequence." });
  }
  const expectedRecovery = snapshot.state === "waiting_for_approval"
    ? "waiting_for_approval"
    : snapshot.state === "waiting_for_reconciliation"
      ? "waiting_for_reconciliation"
      : snapshot.state === "committing"
        ? "commit_uncertain"
        : ["blocked", "cancelled", "failed", "completed"].includes(snapshot.state)
          ? "terminal"
          : "resumable";
  if (snapshot.recoveryClassification !== expectedRecovery) {
    context.addIssue({
      code: "custom",
      path: ["recoveryClassification"],
      message: `recoveryClassification must be ${expectedRecovery} for state ${snapshot.state}.`,
    });
  }
});

export const runtimeV2RunSnapshotEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("run.snapshot"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2RunSnapshotPayloadSchema,
}).strict().superRefine((envelope, context) => {
  if (envelope.runId !== envelope.payload.runId) {
    context.addIssue({ code: "custom", path: ["payload", "runId"], message: "payload runId must match envelope runId." });
  }
});

export const runtimeV2RunRejectedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("run.rejected"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ErrorSchema,
}).strict();

export const runtimeV2GoalEvidenceReferenceSchema = z.object({
  kind: identityStringSchema,
  reference: identityStringSchema,
  description: z.string().trim().min(1).max(4_000),
}).strict();

export const runtimeV2GoalScopeSchema = z.object({
  resourceIds: z.array(identityStringSchema).min(1).max(10_000),
  scopeSha256: sha256Schema,
}).strict().superRefine((scope, context) => {
  for (let index = 1; index < scope.resourceIds.length; index += 1) {
    if (scope.resourceIds[index - 1] >= scope.resourceIds[index]) {
      context.addIssue({ code: "custom", path: ["resourceIds", index], message: "resourceIds must be sorted and unique." });
      break;
    }
  }
});

export const runtimeV2GoalAcceptanceCriterionSchema = z.object({
  criterionId: identityStringSchema,
  description: z.string().trim().min(1).max(4_000),
  required: z.boolean(),
  satisfied: z.boolean(),
  evidenceRefs: z.array(runtimeV2GoalEvidenceReferenceSchema).max(10_000),
}).strict().superRefine((criterion, context) => {
  if (criterion.satisfied && criterion.evidenceRefs.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Satisfied criteria require evidence." });
  }
});

export const runtimeV2GoalDefinitionSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  scope: runtimeV2GoalScopeSchema,
  acceptanceCriteria: z.array(runtimeV2GoalAcceptanceCriterionSchema).min(1).max(10_000),
  constraints: z.array(z.string().trim().min(1).max(4_000)).max(10_000),
  permissionMode: z.enum(["free", "assist"]),
}).strict();

export const runtimeV2GoalCreatePayloadSchema = z.object({
  createIdempotencyKey: identityStringSchema,
  goalId: identityStringSchema,
  sessionId: identityStringSchema,
  ownerAgentId: identityStringSchema,
  definition: runtimeV2GoalDefinitionSchema,
}).strict();
export const runtimeV2GoalGetPayloadSchema = z.object({ goalId: identityStringSchema, revision: z.number().int().positive().safe().optional() }).strict();
export const runtimeV2GoalRevisePayloadSchema = z.object({ reviseIdempotencyKey: identityStringSchema, goalId: identityStringSchema, expectedRevision: z.number().int().positive().safe(), definition: runtimeV2GoalDefinitionSchema }).strict();
export const runtimeV2GoalCompletionProposePayloadSchema = z.object({ proposeIdempotencyKey: identityStringSchema, goalId: identityStringSchema, expectedRevision: z.number().int().positive().safe(), evidenceRefs: z.array(runtimeV2GoalEvidenceReferenceSchema).min(1).max(10_000) }).strict();
export const runtimeV2GoalCompletePayloadSchema = z.object({ completeIdempotencyKey: identityStringSchema, goalId: identityStringSchema, expectedRevision: z.number().int().positive().safe(), evidenceRefs: z.array(runtimeV2GoalEvidenceReferenceSchema).min(1).max(10_000) }).strict();

const workspaceCommandEnvelope = (name: string, payload: z.ZodType) => runtimeV2EnvelopeSchema.extend({ messageType: z.literal("command"), name: z.literal(name), correlationId: z.null(), runId: z.null(), payload }).strict();
export const runtimeV2GoalCreateEnvelopeSchema = workspaceCommandEnvelope("goal.create", runtimeV2GoalCreatePayloadSchema);
export const runtimeV2GoalGetEnvelopeSchema = workspaceCommandEnvelope("goal.get", runtimeV2GoalGetPayloadSchema);
export const runtimeV2GoalReviseEnvelopeSchema = workspaceCommandEnvelope("goal.revise", runtimeV2GoalRevisePayloadSchema);
export const runtimeV2GoalCompletionProposeEnvelopeSchema = workspaceCommandEnvelope("goal.completion.propose", runtimeV2GoalCompletionProposePayloadSchema);
export const runtimeV2GoalCompleteEnvelopeSchema = workspaceCommandEnvelope("goal.complete", runtimeV2GoalCompletePayloadSchema);

export const runtimeV2GoalSnapshotPayloadSchema = z.object({
  identity: z.object({ workspaceId: identityStringSchema, projectId: identityStringSchema, sessionId: identityStringSchema, goalId: identityStringSchema, ownerAgentId: identityStringSchema }).strict(),
  definition: runtimeV2GoalDefinitionSchema,
  definitionRevision: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  status: z.enum(["active", "completion_proposed", "completed", "blocked", "cancelled"]),
  evidenceRefs: z.array(runtimeV2GoalEvidenceReferenceSchema),
  blockers: z.array(z.object({ blockerId: identityStringSchema, description: z.string().trim().min(1), evidenceRefs: z.array(runtimeV2GoalEvidenceReferenceSchema) }).strict()),
  lastEventHash: sha256Schema,
}).strict();
export const runtimeV2GoalSnapshotEnvelopeSchema = runtimeV2EnvelopeSchema.extend({ messageType: z.literal("response"), name: z.literal("goal.snapshot"), correlationId: z.uuid(), runId: z.null(), payload: runtimeV2GoalSnapshotPayloadSchema }).strict();
export const runtimeV2GoalRejectedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({ messageType: z.literal("response"), name: z.literal("goal.rejected"), correlationId: z.uuid(), runId: z.null(), payload: runtimeV2ErrorSchema }).strict();

export const runtimeV2PlanEvidenceSchema = z.object({ evidenceType: identityStringSchema, referenceId: identityStringSchema, sha256: sha256Schema }).strict();
export const runtimeV2PlanStepSchema = z.object({
  stepId: identityStringSchema,
  purpose: z.string().trim().min(1).max(10_000),
  dependencies: z.array(identityStringSchema).max(10_000),
  assignedAgent: identityStringSchema.nullable(),
  capabilities: z.array(identityStringSchema).min(1).max(10_000),
  expectedArtifact: identityStringSchema,
  requiredEvidence: z.array(identityStringSchema).min(1).max(10_000),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  completionEvidence: z.array(runtimeV2PlanEvidenceSchema),
}).strict();
export const runtimeV2PlanCreatePayloadSchema = z.object({ createIdempotencyKey: identityStringSchema, planId: identityStringSchema, goalId: identityStringSchema, goalRevision: z.number().int().positive().safe(), steps: z.array(runtimeV2PlanStepSchema).min(1).max(10_000) }).strict();
export const runtimeV2PlanGetPayloadSchema = z.object({ planId: identityStringSchema, revision: z.number().int().positive().safe().optional() }).strict();
export const runtimeV2PlanRevisePayloadSchema = z.object({ reviseIdempotencyKey: identityStringSchema, planId: identityStringSchema, expectedRevision: z.number().int().positive().safe(), goalRevision: z.number().int().positive().safe(), steps: z.array(runtimeV2PlanStepSchema).min(1).max(10_000) }).strict();
export const runtimeV2PlanStepStartPayloadSchema = z.object({ startIdempotencyKey: identityStringSchema, planId: identityStringSchema, expectedRevision: z.number().int().positive().safe(), stepId: identityStringSchema }).strict();
export const runtimeV2PlanStepCompletePayloadSchema = z.object({ completeIdempotencyKey: identityStringSchema, planId: identityStringSchema, expectedRevision: z.number().int().positive().safe(), stepId: identityStringSchema, evidence: z.array(runtimeV2PlanEvidenceSchema).min(1).max(10_000) }).strict();
export const runtimeV2PlanCreateEnvelopeSchema = workspaceCommandEnvelope("plan.create", runtimeV2PlanCreatePayloadSchema);
export const runtimeV2PlanGetEnvelopeSchema = workspaceCommandEnvelope("plan.get", runtimeV2PlanGetPayloadSchema);
export const runtimeV2PlanReviseEnvelopeSchema = workspaceCommandEnvelope("plan.revise", runtimeV2PlanRevisePayloadSchema);
export const runtimeV2PlanStepStartEnvelopeSchema = workspaceCommandEnvelope("plan.step.start", runtimeV2PlanStepStartPayloadSchema);
export const runtimeV2PlanStepCompleteEnvelopeSchema = workspaceCommandEnvelope("plan.step.complete", runtimeV2PlanStepCompletePayloadSchema);
export const runtimeV2PlanRevisionSchema = z.object({ revision: z.number().int().positive().safe(), goalRevision: z.number().int().positive().safe(), steps: z.array(runtimeV2PlanStepSchema).min(1), previousRevisionSha256: sha256Schema.nullable(), revisionSha256: sha256Schema, createdAt: z.iso.datetime({ offset: true }) }).strict();
export const runtimeV2PlanSnapshotPayloadSchema = z.object({ workspaceId: identityStringSchema, planId: identityStringSchema, goalId: identityStringSchema, currentRevision: runtimeV2PlanRevisionSchema, lastStreamSequence: z.number().int().positive().safe() }).strict();
export const runtimeV2PlanSnapshotEnvelopeSchema = runtimeV2EnvelopeSchema.extend({ messageType: z.literal("response"), name: z.literal("plan.snapshot"), correlationId: z.uuid(), runId: z.null(), payload: runtimeV2PlanSnapshotPayloadSchema }).strict();
export const runtimeV2PlanRejectedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({ messageType: z.literal("response"), name: z.literal("plan.rejected"), correlationId: z.uuid(), runId: z.null(), payload: runtimeV2ErrorSchema }).strict();

export const runtimeV2ContextDisclosureSchema = z.enum([
  "public", "project_private", "agent_internal", "player_hidden",
]);

export const runtimeV2ContextItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system_prompt"),
    itemId: identityStringSchema,
    content: z.string(),
    contentSha256: sha256Schema,
    disclosure: runtimeV2ContextDisclosureSchema,
    required: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("tool_protocol"),
    itemId: identityStringSchema,
    toolName: identityStringSchema,
    schemaVersion: z.number().int().min(0).max(0xffff_ffff),
    protocol: z.json(),
    contentSha256: sha256Schema,
    disclosure: runtimeV2ContextDisclosureSchema,
    required: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("session_message"),
    itemId: identityStringSchema,
    messageId: identityStringSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    contentSha256: sha256Schema,
    createdAt: z.iso.datetime({ offset: true }),
    disclosure: runtimeV2ContextDisclosureSchema,
    required: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("retrieval_source"),
    itemId: identityStringSchema,
    sourceReceiptId: identityStringSchema,
    sourceKind: z.enum(["document", "graph_assertion", "task_memory", "project_file"]),
    stableVersionId: identityStringSchema,
    content: z.string(),
    contentSha256: sha256Schema,
    complete: z.boolean(),
    disclosure: runtimeV2ContextDisclosureSchema,
    required: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("runtime_exchange"),
    itemId: identityStringSchema,
    exchangeId: identityStringSchema,
    kind: z.enum(["user_message", "assistant_message", "tool_call", "tool_result", "correction"]),
    content: z.json(),
    contentSha256: sha256Schema,
    disclosure: runtimeV2ContextDisclosureSchema,
    required: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("output_reserve"),
    itemId: identityStringSchema,
    requestedTokens: z.number().int().min(0).safe(),
    policyId: identityStringSchema,
    disclosure: runtimeV2ContextDisclosureSchema,
  }).strict(),
]);

export const runtimeV2ContextCompilePayloadSchema = z.object({
  compileIdempotencyKey: identityStringSchema,
  invocationId: identityStringSchema,
  requestNumber: z.number().int().positive().safe(),
  provider: providerRunIdentitySchema,
  contextPolicy: versionedPolicyIdentitySchema,
  compilerVersion: semanticVersionSchema,
  contextWindow: z.number().int().positive().max(10_000_000),
  configuredMaxOutputTokens: z.number().int().min(0).max(1_000_000).nullable(),
  safetyReserveTokens: z.number().int().min(0).safe(),
  items: z.array(runtimeV2ContextItemSchema).min(1).max(100_000),
}).strict().superRefine((payload, context) => {
  if (payload.safetyReserveTokens > payload.contextWindow) {
    context.addIssue({ code: "custom", path: ["safetyReserveTokens"], message: "Safety reserve cannot exceed context window." });
  }
  if (payload.configuredMaxOutputTokens !== null && payload.configuredMaxOutputTokens > payload.contextWindow) {
    context.addIssue({ code: "custom", path: ["configuredMaxOutputTokens"], message: "Output limit cannot exceed context window." });
  }
  const itemIds = payload.items.map((item) => item.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Context item IDs must be unique." });
  }
});

export const runtimeV2ContextCompileEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("context.compile"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: runtimeV2ContextCompilePayloadSchema,
}).strict();

export const runtimeV2ContextBudgetCategorySchema = z.enum([
  "system_prompt", "tool_protocol", "session_history", "collaboration", "retrieval",
  "runtime_conversation", "output_reserve", "safety_reserve", "accounting_overhead",
]);

export const runtimeV2ContextCompilationReceiptSchema = z.object({
  compilationId: z.uuid(),
  requestNumber: z.number().int().positive().safe(),
  compilerVersion: semanticVersionSchema,
  tokenizer: z.object({
    kind: z.enum(["provider_exact", "known_model", "fallback_estimate"]),
    id: identityStringSchema,
    version: identityStringSchema,
    providerId: identityStringSchema.nullable(),
    modelId: identityStringSchema.nullable(),
  }).strict(),
  representation: z.enum(["normalized_messages", "pi_context_json", "open_ai_chat_completions"]),
  canonicalContextSha256: sha256Schema,
  serializedInputBytes: z.number().int().min(0).safe(),
  estimatedInputTokens: z.number().int().min(0).safe(),
  exactInputTokens: z.number().int().min(0).safe().nullable(),
  contextWindow: z.number().int().positive().max(10_000_000),
  safetyReserveTokens: z.number().int().min(0).safe(),
  outputReserveTokens: z.number().int().min(0).safe(),
  availableInputTokens: z.number().int().min(0).safe(),
  accepted: z.boolean(),
  budget: z.array(z.object({
    category: runtimeV2ContextBudgetCategorySchema,
    estimatedTokens: z.number().int().min(0).safe(),
  }).strict()).max(9),
  includedItemIds: z.array(identityStringSchema).max(100_000),
  omittedItemIds: z.array(identityStringSchema).max(100_000),
  incomplete: z.boolean(),
  disclosure: runtimeV2ContextDisclosureSchema,
}).strict().superRefine((receipt, context) => {
  const reserved = receipt.safetyReserveTokens + receipt.outputReserveTokens;
  if (reserved > receipt.contextWindow || receipt.availableInputTokens !== receipt.contextWindow - reserved) {
    context.addIssue({ code: "custom", path: ["availableInputTokens"], message: "Available input budget is inconsistent with reserves." });
  }
  if (receipt.estimatedInputTokens > receipt.availableInputTokens) {
    context.addIssue({ code: "custom", path: ["estimatedInputTokens"], message: "Accepted input cannot exceed available budget." });
  }
  const categories = receipt.budget.map((allocation) => allocation.category);
  if (new Set(categories).size !== categories.length) {
    context.addIssue({ code: "custom", path: ["budget"], message: "Budget categories must be unique." });
  }
  const included = new Set(receipt.includedItemIds);
  if (included.size !== receipt.includedItemIds.length
      || new Set(receipt.omittedItemIds).size !== receipt.omittedItemIds.length
      || receipt.omittedItemIds.some((itemId) => included.has(itemId))) {
    context.addIssue({ code: "custom", path: ["includedItemIds"], message: "Included and omitted item IDs must be unique and disjoint." });
  }
  if (receipt.omittedItemIds.length > 0 && !receipt.incomplete) {
    context.addIssue({ code: "custom", path: ["incomplete"], message: "Omitted context must mark the receipt incomplete." });
  }
});

export const runtimeV2ContextCompilationEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("context.compilation"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ContextCompilationReceiptSchema,
}).strict();

export const runtimeV2ContextRejectedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("context.rejected"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ErrorSchema,
}).strict();

export const runtimeV2ProviderConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: identityStringSchema,
  providerId: identityStringSchema,
  displayName: identityStringSchema,
  baseUrl: z.url().superRefine((value, context) => {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!secure && !loopback) context.addIssue({ code: "custom", message: "Remote Provider URLs require HTTPS." });
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({ code: "custom", message: "Provider URL cannot contain credentials, query or fragment." });
    }
  }),
  modelId: identityStringSchema,
  apiFlavor: z.literal("open_ai_chat_completions"),
  authScheme: z.literal("bearer"),
  contextWindow: z.number().int().positive().max(10_000_000),
  maxTokens: z.number().int().positive().max(1_000_000).nullable(),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000),
  totalDeadlineMs: z.number().int().min(1_000).max(900_000),
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    maxTotalDelayMs: z.number().int().min(0).max(900_000),
  }).strict(),
}).strict().superRefine((config, context) => {
  if (config.maxTokens !== null && config.maxTokens > config.contextWindow) {
    context.addIssue({ code: "custom", path: ["maxTokens"], message: "maxTokens cannot exceed contextWindow." });
  }
  if (config.totalDeadlineMs < config.requestTimeoutMs) {
    context.addIssue({ code: "custom", path: ["totalDeadlineMs"], message: "totalDeadlineMs cannot precede requestTimeoutMs." });
  }
  if (config.retryPolicy.maxTotalDelayMs > config.totalDeadlineMs) {
    context.addIssue({ code: "custom", path: ["retryPolicy", "maxTotalDelayMs"], message: "Retry delay budget cannot exceed total deadline." });
  }
  const inputOrder = { text: 0, image: 1 } as const;
  for (let index = 1; index < config.input.length; index += 1) {
    if (inputOrder[config.input[index - 1]] >= inputOrder[config.input[index]]) {
      context.addIssue({ code: "custom", path: ["input", index], message: "Input capabilities must be sorted and unique." });
    }
  }
});

export const runtimeV2SensitiveProviderBindEnvelopeSchema = z.object({
  protocolVersion: z.literal(RUNTIME_V2_PROTOCOL_VERSION),
  messageId: z.uuid(),
  messageType: z.literal("sensitive_command"),
  name: z.literal("provider.bind"),
  sentAt: z.iso.datetime({ offset: true }),
  correlationId: z.null(),
  runId: z.null(),
  sequence: z.number().int().positive().safe(),
  payload: z.object({
    config: runtimeV2ProviderConfigSchema,
    configSha256: sha256Schema,
    credential: z.string().trim().min(1).max(8_192),
  }).strict(),
}).strict();

export const runtimeV2ProviderBindingReceiptSchema = z.object({
  profileId: identityStringSchema,
  providerId: identityStringSchema,
  modelId: identityStringSchema,
  configSha256: sha256Schema,
  contextWindow: z.number().int().positive().max(10_000_000),
  maxTokens: z.number().int().positive().max(1_000_000).nullable(),
}).strict();

export const runtimeV2ProviderBoundEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("provider.bound"),
  correlationId: z.uuid(),
  runId: z.null(),
  payload: runtimeV2ProviderBindingReceiptSchema,
}).strict();

export const runtimeV2ProviderRejectedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("provider.rejected"),
  correlationId: z.uuid(),
  runId: z.null(),
  payload: runtimeV2ErrorSchema,
}).strict();

const runtimeV2ProviderInferenceIdentitySchema = z.object({
  runId: z.uuid(),
  inferenceId: z.uuid(),
  attemptId: z.uuid(),
  contextCompilationId: z.uuid(),
  requestNumber: z.number().int().positive().safe(),
  attemptNumber: z.number().int().positive().safe(),
}).strict();

export const runtimeV2ProviderInferenceStartPayloadSchema = runtimeV2ProviderInferenceIdentitySchema.omit({ runId: true }).extend({
  invocationId: identityStringSchema,
  inferenceIdempotencyKey: identityStringSchema,
}).strict();

export const runtimeV2ProviderInferenceStartEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"),
  name: z.literal("provider.inference.start"),
  correlationId: z.null(),
  runId: z.uuid(),
  payload: runtimeV2ProviderInferenceStartPayloadSchema,
}).strict();

function requireMatchingInferenceRun(
  envelope: { runId: string; payload: { runId: string } },
  context: z.RefinementCtx,
) {
  if (envelope.runId !== envelope.payload.runId) {
    context.addIssue({ code: "custom", path: ["payload", "runId"], message: "Provider inference payload runId must match the envelope runId." });
  }
}

export const runtimeV2ProviderInferenceAcceptedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"),
  name: z.literal("provider.inference.accepted"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ProviderInferenceIdentitySchema,
}).strict().superRefine(requireMatchingInferenceRun);

export const runtimeV2ProviderInferenceCompletedPayloadSchema = runtimeV2ProviderInferenceIdentitySchema.extend({
  providerId: identityStringSchema,
  modelId: identityStringSchema,
  responseIdSha256: sha256Schema,
  responseBodySha256: sha256Schema,
  stopReason: identityStringSchema,
  usage: z.object({
    inputTokens: z.number().int().min(0).safe(),
    outputTokens: z.number().int().min(0).safe(),
    totalTokens: z.number().int().min(0).safe(),
  }).strict(),
  output: z.object({
    text: z.string().min(1),
    textSha256: sha256Schema,
    utf8Bytes: z.number().int().positive().max(1_048_576).safe(),
  }).strict().nullable(),
  toolCalls: z.array(z.object({
    id: identityStringSchema,
    name: identityStringSchema,
    arguments: z.record(z.string(), z.unknown()),
    argumentsSha256: sha256Schema,
  }).strict()).default([]),
}).strict().superRefine((payload, context) => {
  if (payload.usage.inputTokens + payload.usage.outputTokens !== payload.usage.totalTokens) {
    context.addIssue({ code: "custom", path: ["usage", "totalTokens"], message: "Provider usage total must equal input plus output tokens." });
  }
  if (payload.output === null && payload.toolCalls.length === 0) {
    context.addIssue({ code: "custom", path: ["output"], message: "Provider completion must contain text or tool calls." });
  }
  if ((payload.stopReason === "stop" && (payload.output === null || payload.toolCalls.length > 0))
    || (payload.stopReason === "tool_calls" && payload.toolCalls.length === 0)
    || (payload.stopReason !== "stop" && payload.stopReason !== "tool_calls")) {
    context.addIssue({ code: "custom", path: ["stopReason"], message: "Provider stopReason must match its text/tool-call output shape." });
  }
  if (payload.output !== null) {
    const actualBytes = new TextEncoder().encode(payload.output.text).byteLength;
    if (actualBytes !== payload.output.utf8Bytes) {
      context.addIssue({ code: "custom", path: ["output", "utf8Bytes"], message: "Provider output utf8Bytes must match the encoded text length." });
    }
    const actualHash = bytesToHex(sha256(new TextEncoder().encode(payload.output.text)));
    if (actualHash !== payload.output.textSha256) {
      context.addIssue({ code: "custom", path: ["output", "textSha256"], message: "Provider output textSha256 must match the output text." });
    }
  }
  const ids = new Set<string>();
  for (const [index, call] of payload.toolCalls.entries()) {
    if (ids.has(call.id)) {
      context.addIssue({ code: "custom", path: ["toolCalls", index, "id"], message: "Provider tool call ids must be unique." });
    }
    ids.add(call.id);
    const canonical = canonicalProtocolJson(call.arguments);
    const actualHash = bytesToHex(sha256(new TextEncoder().encode(canonical)));
    if (actualHash !== call.argumentsSha256) {
      context.addIssue({ code: "custom", path: ["toolCalls", index, "argumentsSha256"], message: "Provider tool arguments hash must match canonical JSON." });
    }
  }
});

function canonicalProtocolJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProtocolJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalProtocolJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const runtimeV2ProviderInferenceCompletedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("event"),
  name: z.literal("provider.inference.completed"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ProviderInferenceCompletedPayloadSchema,
}).strict().superRefine(requireMatchingInferenceRun);

export const runtimeV2ProviderInferenceFailedPayloadSchema = runtimeV2ProviderInferenceIdentitySchema.extend({
  error: runtimeV2ErrorSchema,
}).strict();

export const runtimeV2ProviderInferenceFailedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("event"),
  name: z.literal("provider.inference.failed"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ProviderInferenceFailedPayloadSchema,
}).strict().superRefine(requireMatchingInferenceRun);

export const runtimeV2ProviderInferenceReconciliationRequiredPayloadSchema = runtimeV2ProviderInferenceIdentitySchema.extend({
  reason: z.literal("outcome_unknown"),
  error: runtimeV2ErrorSchema.refine((error) => !error.retryable, {
    path: ["retryable"],
    message: "Unknown Provider outcomes cannot claim automatic retryability.",
  }),
}).strict();

export const runtimeV2ProviderInferenceReconciliationRequiredEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("event"),
  name: z.literal("provider.inference.reconciliation_required"),
  correlationId: z.uuid(),
  runId: z.uuid(),
  payload: runtimeV2ProviderInferenceReconciliationRequiredPayloadSchema,
}).strict().superRefine(requireMatchingInferenceRun);

export const runtimeV2ToolSideEffectSchema = z.enum(["none", "staged_write", "external_effect"]);
export const runtimeV2ToolPermissionDecisionSchema = z.enum(["allowed", "approval_required", "denied"]);
export const runtimeV2ToolArtifactReceiptSchema = z.object({
  artifactId: z.uuid(), mediaType: identityStringSchema, sha256: sha256Schema,
  utf8Bytes: z.number().int().min(0).safe(),
}).strict();
export const runtimeV2ToolSourceScopeSchema = z.object({
  sourceCheckpointId: identityStringSchema,
  resourceIds: z.array(identityStringSchema).min(1).max(10_000),
  scopeSha256: sha256Schema,
}).strict().superRefine((scope, context) => {
  if (new Set(scope.resourceIds).size !== scope.resourceIds.length
    || scope.resourceIds.some((value, index) => index > 0 && scope.resourceIds[index - 1] >= value)) {
    context.addIssue({ code: "custom", path: ["resourceIds"], message: "Tool source resource IDs must be sorted and unique." });
  }
});
export const runtimeV2ToolPermissionPolicySchema = z.object({
  mode: z.enum(["free", "assist"]), policyId: identityStringSchema,
  policyVersion: identityStringSchema, policySha256: sha256Schema,
}).strict();
export const runtimeV2ToolPermissionLeaseSchema = z.object({
  leaseId: z.uuid(), toolCallId: z.uuid(), mode: z.enum(["free", "assist"]),
  decision: z.literal("allowed"), policyId: identityStringSchema, policyVersion: identityStringSchema,
  policySha256: sha256Schema, sourceScopeSha256: sha256Schema,
  grantedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((lease, context) => {
  if (lease.expiresAt !== null && Date.parse(lease.expiresAt) <= Date.parse(lease.grantedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Tool permission lease expiry must follow grant time." });
  }
});
export const runtimeV2ToolRequestPayloadSchema = z.object({
  requestIdempotencyKey: identityStringSchema, toolCallId: z.uuid(), providerToolCallId: identityStringSchema, invocationId: identityStringSchema,
  toolName: identityStringSchema, schemaVersion: z.number().int().positive().max(65_535),
  attempt: z.number().int().positive().safe(), sideEffect: runtimeV2ToolSideEffectSchema,
  parallel: z.boolean(), arguments: runtimeV2ToolArtifactReceiptSchema,
  sourceScope: runtimeV2ToolSourceScopeSchema, permission: runtimeV2ToolPermissionPolicySchema,
}).strict();
export const runtimeV2ToolRequestEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"), name: z.literal("tool.request"), correlationId: z.null(),
  runId: z.uuid(), payload: runtimeV2ToolRequestPayloadSchema,
}).strict();
export const runtimeV2ToolAuthorizationResolvePayloadSchema = z.object({
  authorizationIdempotencyKey: identityStringSchema, toolCallId: z.uuid(), decision: z.enum(["approve", "deny"]),
}).strict();
export const runtimeV2ToolAuthorizationResolveEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("command"), name: z.literal("tool.authorization.resolve"), correlationId: z.null(),
  runId: z.uuid(), payload: runtimeV2ToolAuthorizationResolvePayloadSchema,
}).strict();
export const runtimeV2ToolAuthorizationResolvedPayloadSchema = z.object({
  toolCallId: z.uuid(), decision: z.enum(["approve", "deny"]),
  status: z.enum(["authorized", "denied"]), lease: runtimeV2ToolPermissionLeaseSchema.nullable(),
}).strict().superRefine((payload, context) => {
  const approved = payload.decision === "approve";
  if ((approved && (payload.status !== "authorized" || payload.lease === null))
    || (!approved && (payload.status !== "denied" || payload.lease !== null))) {
    context.addIssue({ code: "custom", path: ["status"], message: "Tool authorization result must match its decision and lease." });
  }
  if (payload.lease !== null && payload.lease.toolCallId !== payload.toolCallId) {
    context.addIssue({ code: "custom", path: ["lease", "toolCallId"], message: "Tool authorization lease must match the resolved ToolCall." });
  }
});
export const runtimeV2ToolAuthorizationResolvedEnvelopeSchema = runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("response"), name: z.literal("tool.authorization.resolved"),
  correlationId: z.uuid(), runId: z.uuid(), payload: runtimeV2ToolAuthorizationResolvedPayloadSchema,
}).strict();
const runtimeV2ToolEventIdentitySchema = z.object({
  runId: z.uuid(), toolCallId: z.uuid(), providerToolCallId: identityStringSchema, invocationId: identityStringSchema, toolName: identityStringSchema,
  schemaVersion: z.number().int().positive().max(65_535), attempt: z.number().int().positive().safe(),
  sideEffect: runtimeV2ToolSideEffectSchema, parallel: z.boolean(), argumentsSha256: sha256Schema,
  sourceScopeSha256: sha256Schema,
}).strict();
const toolEventEnvelope = <T extends z.ZodRawShape>(name: string, payload: z.ZodObject<T>) => runtimeV2EnvelopeSchema.extend({
  messageType: z.literal("event"), name: z.literal(name), correlationId: z.uuid(), runId: z.uuid(), payload,
}).strict().superRefine((envelope, context) => {
  const payloadRunId = (envelope.payload as { runId?: unknown }).runId;
  if (payloadRunId !== envelope.runId) {
    context.addIssue({ code: "custom", path: ["payload", "runId"], message: "Tool event payload runId must match the envelope runId." });
  }
});
export const runtimeV2ToolRequestedPayloadSchema = runtimeV2ToolEventIdentitySchema.extend({
  permission: runtimeV2ToolPermissionPolicySchema, authorization: runtimeV2ToolPermissionDecisionSchema,
}).strict().superRefine((payload, context) => {
  const expected = payload.permission.mode === "free" ? "allowed" : "approval_required";
  if (payload.authorization !== expected) context.addIssue({ code: "custom", path: ["authorization"], message: "Tool authorization must match Free/Assist mode." });
});
export const runtimeV2ToolAuthorizedPayloadSchema = runtimeV2ToolEventIdentitySchema.extend({ lease: runtimeV2ToolPermissionLeaseSchema }).strict();
export const runtimeV2ToolSucceededPayloadSchema = runtimeV2ToolEventIdentitySchema.extend({ leaseId: z.uuid(), result: runtimeV2ToolArtifactReceiptSchema }).strict();
export const runtimeV2ToolFailedPayloadSchema = runtimeV2ToolEventIdentitySchema.extend({ leaseId: z.uuid().nullable(), error: runtimeV2ErrorSchema }).strict();
export const runtimeV2ToolOutcomeUnknownPayloadSchema = runtimeV2ToolEventIdentitySchema.extend({
  leaseId: z.uuid(), error: runtimeV2ErrorSchema.refine((error) => !error.retryable, { path: ["retryable"], message: "Unknown tool outcomes cannot be automatically retryable." }),
}).strict();
export const runtimeV2ToolRequestedEnvelopeSchema = toolEventEnvelope("tool.requested", runtimeV2ToolRequestedPayloadSchema);
export const runtimeV2ToolAuthorizedEnvelopeSchema = toolEventEnvelope("tool.authorized", runtimeV2ToolAuthorizedPayloadSchema);
export const runtimeV2ToolRunningEnvelopeSchema = toolEventEnvelope("tool.running", runtimeV2ToolAuthorizedPayloadSchema);
export const runtimeV2ToolSucceededEnvelopeSchema = toolEventEnvelope("tool.succeeded", runtimeV2ToolSucceededPayloadSchema);
export const runtimeV2ToolFailedEnvelopeSchema = toolEventEnvelope("tool.failed", runtimeV2ToolFailedPayloadSchema);
export const runtimeV2ToolOutcomeUnknownEnvelopeSchema = toolEventEnvelope("tool.outcome_unknown", runtimeV2ToolOutcomeUnknownPayloadSchema);

export type RuntimeV2MessageType = z.infer<typeof runtimeV2MessageTypeSchema>;
export type RuntimeV2Envelope = z.infer<typeof runtimeV2EnvelopeSchema>;
export type RuntimeV2HelloPayload = z.infer<typeof runtimeV2HelloPayloadSchema>;
export type RuntimeV2HelloEnvelope = z.infer<typeof runtimeV2HelloEnvelopeSchema>;
export type RuntimeV2InitializePayload = z.infer<typeof runtimeV2InitializePayloadSchema>;
export type RuntimeV2InitializeEnvelope = z.infer<typeof runtimeV2InitializeEnvelopeSchema>;
export type RuntimeV2ReadyPayload = z.infer<typeof runtimeV2ReadyPayloadSchema>;
export type RuntimeV2ReadyEnvelope = z.infer<typeof runtimeV2ReadyEnvelopeSchema>;
export type RuntimeV2ErrorClass = z.infer<typeof runtimeV2ErrorClassSchema>;
export type RuntimeV2Error = z.infer<typeof runtimeV2ErrorSchema>;
export type RuntimeV2ErrorEnvelope = z.infer<typeof runtimeV2ErrorEnvelopeSchema>;
export type RuntimeV2InitializationFailedEnvelope = z.infer<typeof runtimeV2InitializationFailedEnvelopeSchema>;
export type RuntimeV2StatusGetEnvelope = z.infer<typeof runtimeV2StatusGetEnvelopeSchema>;
export type RuntimeV2StatusPayload = z.infer<typeof runtimeV2StatusPayloadSchema>;
export type RuntimeV2StatusEnvelope = z.infer<typeof runtimeV2StatusEnvelopeSchema>;
export type RuntimeV2ShutdownEnvelope = z.infer<typeof runtimeV2ShutdownEnvelopeSchema>;
export type RuntimeV2StoppedPayload = z.infer<typeof runtimeV2StoppedPayloadSchema>;
export type RuntimeV2StoppedEnvelope = z.infer<typeof runtimeV2StoppedEnvelopeSchema>;
export type RuntimeV2RunPinnedIdentity = z.infer<typeof runtimeV2RunPinnedIdentitySchema>;
export type RuntimeV2RunStartPayload = z.infer<typeof runtimeV2RunStartPayloadSchema>;
export type RuntimeV2RunStartEnvelope = z.infer<typeof runtimeV2RunStartEnvelopeSchema>;
export type RuntimeV2RunGetEnvelope = z.infer<typeof runtimeV2RunGetEnvelopeSchema>;
export type RuntimeV2RunPreparePayload = z.infer<typeof runtimeV2RunPreparePayloadSchema>;
export type RuntimeV2RunPrepareEnvelope = z.infer<typeof runtimeV2RunPrepareEnvelopeSchema>;
export type RuntimeV2RunCancelPayload = z.infer<typeof runtimeV2RunCancelPayloadSchema>;
export type RuntimeV2RunCancelEnvelope = z.infer<typeof runtimeV2RunCancelEnvelopeSchema>;
export type RuntimeV2RunReconciliationDecision = z.infer<typeof runtimeV2RunReconciliationDecisionSchema>;
export type RuntimeV2RunReconcilePayload = z.infer<typeof runtimeV2RunReconcilePayloadSchema>;
export type RuntimeV2RunReconcileEnvelope = z.infer<typeof runtimeV2RunReconcileEnvelopeSchema>;
export type RuntimeV2RunReconciliationReceipt = z.infer<typeof runtimeV2RunReconciliationReceiptSchema>;
export type RuntimeV2RunReconciledEnvelope = z.infer<typeof runtimeV2RunReconciledEnvelopeSchema>;
export type RuntimeV2RunSnapshotPayload = z.infer<typeof runtimeV2RunSnapshotPayloadSchema>;
export type RuntimeV2RunSnapshotEnvelope = z.infer<typeof runtimeV2RunSnapshotEnvelopeSchema>;
export type RuntimeV2RunRejectedEnvelope = z.infer<typeof runtimeV2RunRejectedEnvelopeSchema>;
export type RuntimeV2GoalDefinition = z.infer<typeof runtimeV2GoalDefinitionSchema>;
export type RuntimeV2GoalCreatePayload = z.infer<typeof runtimeV2GoalCreatePayloadSchema>;
export type RuntimeV2GoalGetPayload = z.infer<typeof runtimeV2GoalGetPayloadSchema>;
export type RuntimeV2GoalRevisePayload = z.infer<typeof runtimeV2GoalRevisePayloadSchema>;
export type RuntimeV2GoalCompletionProposePayload = z.infer<typeof runtimeV2GoalCompletionProposePayloadSchema>;
export type RuntimeV2GoalCompletePayload = z.infer<typeof runtimeV2GoalCompletePayloadSchema>;
export type RuntimeV2GoalSnapshotPayload = z.infer<typeof runtimeV2GoalSnapshotPayloadSchema>;
export type RuntimeV2GoalSnapshotEnvelope = z.infer<typeof runtimeV2GoalSnapshotEnvelopeSchema>;
export type RuntimeV2GoalRejectedEnvelope = z.infer<typeof runtimeV2GoalRejectedEnvelopeSchema>;
export type RuntimeV2PlanStep = z.infer<typeof runtimeV2PlanStepSchema>;
export type RuntimeV2PlanCreatePayload = z.infer<typeof runtimeV2PlanCreatePayloadSchema>;
export type RuntimeV2PlanGetPayload = z.infer<typeof runtimeV2PlanGetPayloadSchema>;
export type RuntimeV2PlanRevisePayload = z.infer<typeof runtimeV2PlanRevisePayloadSchema>;
export type RuntimeV2PlanStepStartPayload = z.infer<typeof runtimeV2PlanStepStartPayloadSchema>;
export type RuntimeV2PlanStepCompletePayload = z.infer<typeof runtimeV2PlanStepCompletePayloadSchema>;
export type RuntimeV2PlanSnapshotPayload = z.infer<typeof runtimeV2PlanSnapshotPayloadSchema>;
export type RuntimeV2PlanSnapshotEnvelope = z.infer<typeof runtimeV2PlanSnapshotEnvelopeSchema>;
export type RuntimeV2PlanRejectedEnvelope = z.infer<typeof runtimeV2PlanRejectedEnvelopeSchema>;
export type RuntimeV2ContextDisclosure = z.infer<typeof runtimeV2ContextDisclosureSchema>;
export type RuntimeV2ContextItem = z.infer<typeof runtimeV2ContextItemSchema>;
export type RuntimeV2ContextCompilePayload = z.infer<typeof runtimeV2ContextCompilePayloadSchema>;
export type RuntimeV2ContextCompileEnvelope = z.infer<typeof runtimeV2ContextCompileEnvelopeSchema>;
export type RuntimeV2ContextBudgetCategory = z.infer<typeof runtimeV2ContextBudgetCategorySchema>;
export type RuntimeV2ContextCompilationReceipt = z.infer<typeof runtimeV2ContextCompilationReceiptSchema>;
export type RuntimeV2ContextCompilationEnvelope = z.infer<typeof runtimeV2ContextCompilationEnvelopeSchema>;
export type RuntimeV2ContextRejectedEnvelope = z.infer<typeof runtimeV2ContextRejectedEnvelopeSchema>;
export type RuntimeV2ProviderConfig = z.infer<typeof runtimeV2ProviderConfigSchema>;
export type RuntimeV2SensitiveProviderBindEnvelope = z.infer<typeof runtimeV2SensitiveProviderBindEnvelopeSchema>;
export type RuntimeV2ProviderBindingReceipt = z.infer<typeof runtimeV2ProviderBindingReceiptSchema>;
export type RuntimeV2ProviderBoundEnvelope = z.infer<typeof runtimeV2ProviderBoundEnvelopeSchema>;
export type RuntimeV2ProviderRejectedEnvelope = z.infer<typeof runtimeV2ProviderRejectedEnvelopeSchema>;
export type RuntimeV2ProviderInferenceStartPayload = z.infer<typeof runtimeV2ProviderInferenceStartPayloadSchema>;
export type RuntimeV2ProviderInferenceStartEnvelope = z.infer<typeof runtimeV2ProviderInferenceStartEnvelopeSchema>;
export type RuntimeV2ProviderInferenceAcceptedEnvelope = z.infer<typeof runtimeV2ProviderInferenceAcceptedEnvelopeSchema>;
export type RuntimeV2ProviderInferenceCompletedPayload = z.infer<typeof runtimeV2ProviderInferenceCompletedPayloadSchema>;
export type RuntimeV2ProviderInferenceCompletedEnvelope = z.infer<typeof runtimeV2ProviderInferenceCompletedEnvelopeSchema>;
export type RuntimeV2ProviderInferenceFailedPayload = z.infer<typeof runtimeV2ProviderInferenceFailedPayloadSchema>;
export type RuntimeV2ProviderInferenceFailedEnvelope = z.infer<typeof runtimeV2ProviderInferenceFailedEnvelopeSchema>;
export type RuntimeV2ProviderInferenceReconciliationRequiredPayload = z.infer<typeof runtimeV2ProviderInferenceReconciliationRequiredPayloadSchema>;
export type RuntimeV2ProviderInferenceReconciliationRequiredEnvelope = z.infer<typeof runtimeV2ProviderInferenceReconciliationRequiredEnvelopeSchema>;
export type RuntimeV2ToolRequestPayload = z.infer<typeof runtimeV2ToolRequestPayloadSchema>;
export type RuntimeV2ToolRequestEnvelope = z.infer<typeof runtimeV2ToolRequestEnvelopeSchema>;
export type RuntimeV2ToolAuthorizationResolvePayload = z.infer<typeof runtimeV2ToolAuthorizationResolvePayloadSchema>;
export type RuntimeV2ToolAuthorizationResolveEnvelope = z.infer<typeof runtimeV2ToolAuthorizationResolveEnvelopeSchema>;
export type RuntimeV2ToolAuthorizationResolvedPayload = z.infer<typeof runtimeV2ToolAuthorizationResolvedPayloadSchema>;
export type RuntimeV2ToolAuthorizationResolvedEnvelope = z.infer<typeof runtimeV2ToolAuthorizationResolvedEnvelopeSchema>;
export type RuntimeV2ToolRequestedEnvelope = z.infer<typeof runtimeV2ToolRequestedEnvelopeSchema>;
export type RuntimeV2ToolAuthorizedEnvelope = z.infer<typeof runtimeV2ToolAuthorizedEnvelopeSchema>;
export type RuntimeV2ToolRunningEnvelope = z.infer<typeof runtimeV2ToolRunningEnvelopeSchema>;
export type RuntimeV2ToolSucceededEnvelope = z.infer<typeof runtimeV2ToolSucceededEnvelopeSchema>;
export type RuntimeV2ToolFailedEnvelope = z.infer<typeof runtimeV2ToolFailedEnvelopeSchema>;
export type RuntimeV2ToolOutcomeUnknownEnvelope = z.infer<typeof runtimeV2ToolOutcomeUnknownEnvelopeSchema>;

export class RuntimeV2ProtocolVersionError extends Error {
  readonly code = "RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED";
  readonly received: unknown;
  readonly supported = RUNTIME_V2_PROTOCOL_VERSION;

  constructor(received: unknown) {
    super(`Unsupported Runtime V2 protocol version: ${String(received)}.`);
    this.name = "RuntimeV2ProtocolVersionError";
    this.received = received;
  }
}

export function parseRuntimeV2Envelope(value: unknown): RuntimeV2Envelope {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return runtimeV2EnvelopeSchema.parse(value);
}

export function parseRuntimeV2HelloEnvelope(value: unknown): RuntimeV2HelloEnvelope {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return runtimeV2HelloEnvelopeSchema.parse(value);
}

export function parseRuntimeV2InitializeEnvelope(value: unknown): RuntimeV2InitializeEnvelope {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return runtimeV2InitializeEnvelopeSchema.parse(value);
}

export function parseRuntimeV2ReadyEnvelope(value: unknown): RuntimeV2ReadyEnvelope {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return runtimeV2ReadyEnvelopeSchema.parse(value);
}

export function parseRuntimeV2ErrorEnvelope(value: unknown): RuntimeV2ErrorEnvelope {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return runtimeV2ErrorEnvelopeSchema.parse(value);
}

export function parseRuntimeV2InitializationFailedEnvelope(value: unknown): RuntimeV2InitializationFailedEnvelope {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return runtimeV2InitializationFailedEnvelopeSchema.parse(value);
}

export function parseRuntimeV2StatusGetEnvelope(value: unknown): RuntimeV2StatusGetEnvelope {
  return parseVersionedEnvelope(value, runtimeV2StatusGetEnvelopeSchema);
}

export function parseRuntimeV2StatusEnvelope(value: unknown): RuntimeV2StatusEnvelope {
  return parseVersionedEnvelope(value, runtimeV2StatusEnvelopeSchema);
}

export function parseRuntimeV2ShutdownEnvelope(value: unknown): RuntimeV2ShutdownEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ShutdownEnvelopeSchema);
}

export function parseRuntimeV2StoppedEnvelope(value: unknown): RuntimeV2StoppedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2StoppedEnvelopeSchema);
}

export function parseRuntimeV2RunStartEnvelope(value: unknown): RuntimeV2RunStartEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunStartEnvelopeSchema);
}

export function parseRuntimeV2RunGetEnvelope(value: unknown): RuntimeV2RunGetEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunGetEnvelopeSchema);
}

export function parseRuntimeV2RunPrepareEnvelope(value: unknown): RuntimeV2RunPrepareEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunPrepareEnvelopeSchema);
}

export function parseRuntimeV2RunCancelEnvelope(value: unknown): RuntimeV2RunCancelEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunCancelEnvelopeSchema);
}

export function parseRuntimeV2RunReconcileEnvelope(value: unknown): RuntimeV2RunReconcileEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunReconcileEnvelopeSchema);
}

export function parseRuntimeV2RunReconciledEnvelope(value: unknown): RuntimeV2RunReconciledEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunReconciledEnvelopeSchema);
}

export function parseRuntimeV2RunSnapshotEnvelope(value: unknown): RuntimeV2RunSnapshotEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunSnapshotEnvelopeSchema);
}

export function parseRuntimeV2RunRejectedEnvelope(value: unknown): RuntimeV2RunRejectedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunRejectedEnvelopeSchema);
}

export function parseRuntimeV2GoalSnapshotEnvelope(value: unknown): RuntimeV2GoalSnapshotEnvelope {
  return parseVersionedEnvelope(value, runtimeV2GoalSnapshotEnvelopeSchema);
}
export function parseRuntimeV2GoalRejectedEnvelope(value: unknown): RuntimeV2GoalRejectedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2GoalRejectedEnvelopeSchema);
}
export function parseRuntimeV2PlanSnapshotEnvelope(value: unknown): RuntimeV2PlanSnapshotEnvelope {
  return parseVersionedEnvelope(value, runtimeV2PlanSnapshotEnvelopeSchema);
}
export function parseRuntimeV2PlanRejectedEnvelope(value: unknown): RuntimeV2PlanRejectedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2PlanRejectedEnvelopeSchema);
}

export function parseRuntimeV2ContextCompileEnvelope(value: unknown): RuntimeV2ContextCompileEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ContextCompileEnvelopeSchema);
}

export function parseRuntimeV2ContextCompilationEnvelope(value: unknown): RuntimeV2ContextCompilationEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ContextCompilationEnvelopeSchema);
}

export function parseRuntimeV2ContextRejectedEnvelope(value: unknown): RuntimeV2ContextRejectedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ContextRejectedEnvelopeSchema);
}

export function parseRuntimeV2SensitiveProviderBindEnvelope(value: unknown): RuntimeV2SensitiveProviderBindEnvelope {
  return parseVersionedEnvelope(value, runtimeV2SensitiveProviderBindEnvelopeSchema);
}

export function parseRuntimeV2ProviderBoundEnvelope(value: unknown): RuntimeV2ProviderBoundEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderBoundEnvelopeSchema);
}

export function parseRuntimeV2ProviderRejectedEnvelope(value: unknown): RuntimeV2ProviderRejectedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderRejectedEnvelopeSchema);
}

export function parseRuntimeV2ProviderInferenceStartEnvelope(value: unknown): RuntimeV2ProviderInferenceStartEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderInferenceStartEnvelopeSchema);
}

export function parseRuntimeV2ProviderInferenceAcceptedEnvelope(value: unknown): RuntimeV2ProviderInferenceAcceptedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderInferenceAcceptedEnvelopeSchema);
}

export function parseRuntimeV2ProviderInferenceCompletedEnvelope(value: unknown): RuntimeV2ProviderInferenceCompletedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderInferenceCompletedEnvelopeSchema);
}

export function parseRuntimeV2ProviderInferenceFailedEnvelope(value: unknown): RuntimeV2ProviderInferenceFailedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderInferenceFailedEnvelopeSchema);
}

export function parseRuntimeV2ProviderInferenceReconciliationRequiredEnvelope(value: unknown): RuntimeV2ProviderInferenceReconciliationRequiredEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ProviderInferenceReconciliationRequiredEnvelopeSchema);
}

export function parseRuntimeV2ToolRequestEnvelope(value: unknown): RuntimeV2ToolRequestEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolRequestEnvelopeSchema);
}
export function parseRuntimeV2ToolAuthorizationResolveEnvelope(value: unknown): RuntimeV2ToolAuthorizationResolveEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolAuthorizationResolveEnvelopeSchema);
}
export function parseRuntimeV2ToolAuthorizationResolvedEnvelope(value: unknown): RuntimeV2ToolAuthorizationResolvedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolAuthorizationResolvedEnvelopeSchema);
}
export function parseRuntimeV2ToolRequestedEnvelope(value: unknown): RuntimeV2ToolRequestedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolRequestedEnvelopeSchema);
}
export function parseRuntimeV2ToolAuthorizedEnvelope(value: unknown): RuntimeV2ToolAuthorizedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolAuthorizedEnvelopeSchema);
}
export function parseRuntimeV2ToolRunningEnvelope(value: unknown): RuntimeV2ToolRunningEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolRunningEnvelopeSchema);
}
export function parseRuntimeV2ToolSucceededEnvelope(value: unknown): RuntimeV2ToolSucceededEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolSucceededEnvelopeSchema);
}
export function parseRuntimeV2ToolFailedEnvelope(value: unknown): RuntimeV2ToolFailedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolFailedEnvelopeSchema);
}
export function parseRuntimeV2ToolOutcomeUnknownEnvelope(value: unknown): RuntimeV2ToolOutcomeUnknownEnvelope {
  return parseVersionedEnvelope(value, runtimeV2ToolOutcomeUnknownEnvelopeSchema);
}

function parseVersionedEnvelope<T>(value: unknown, schema: z.ZodType<T>): T {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return schema.parse(value);
}

function readProtocolVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("protocolVersion" in value)) return undefined;
  return value.protocolVersion;
}
