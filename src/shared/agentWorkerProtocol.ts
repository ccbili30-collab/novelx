import { z } from "zod";
import { providerRuntimeProfileSchema } from "./providerContract";

const identifierSchema = z.string().trim().min(1).max(240);
const requestIdSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string().min(1).max(240), jsonValueSchema);

export const retrieveGraphEvidenceArgsSchema = z.object({
  scopeResourceIds: z.array(identifierSchema).min(1).max(100),
}).strict();

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

export const proposedChangeSetItemSchema = z.discriminatedUnion("kind", [
  proposedAssertionItemSchema,
  proposedResourceItemSchema,
  proposedDocumentItemSchema,
  proposedCreativeDocumentItemSchema,
  proposedCreativeRelationItemSchema,
  proposedConstraintProfileItemSchema,
]);

export const proposeChangeSetArgsSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  items: z.array(proposedChangeSetItemSchema).min(1).max(500),
}).strict();

export const proposeChangeSetResultSchema = z.object({
  changeSetId: identifierSchema,
  mode: z.enum(["free", "assist"]),
  status: z.enum(["pending", "committed", "rejected", "failed"]),
  gateStatus: z.enum(["review_pending", "ready", "blocked"]),
  blockedReason: z.string().min(1).max(160).nullable(),
  itemCount: z.number().int().min(1).max(500),
}).strict();

export const agentToolNameSchema = z.enum([
  "retrieve_graph_evidence",
  "propose_change_set",
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
    args: retrieveGraphEvidenceArgsSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.request"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    tool: z.literal("propose_change_set"),
    args: proposeChangeSetArgsSchema,
  }).strict(),
]);

export const agentToolInternalErrorCodeSchema = z.enum([
  "AGENT_TOOLS_REQUIRED",
  "AGENT_TOOL_UNKNOWN",
  "AGENT_TOOL_PROTOCOL_FAILED",
  "AGENT_TOOL_TIMEOUT",
  "AGENT_TOOL_FAILED",
  "AGENT_RUN_CANCELLED",
]);

const agentWorkerToolSuccessResponseSchema = z.discriminatedUnion("tool", [
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("retrieve_graph_evidence"),
    result: retrieveGraphEvidenceResultSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.response"),
    runId: z.string().min(1).max(120),
    requestId: requestIdSchema,
    ok: z.literal(true),
    tool: z.literal("propose_change_set"),
    result: proposeChangeSetResultSchema,
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
  role: z.enum(["steward", "writer", "checker"]),
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

export const agentWorkerAuditOperationSchema = z.discriminatedUnion("type", [
  auditInvocationStartedOperationSchema,
  auditInvocationTerminalOperationSchema,
  auditLocalToolStartedOperationSchema,
  auditLocalToolTerminalOperationSchema,
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
export type ProposeChangeSetArgs = z.infer<typeof proposeChangeSetArgsSchema>;
export type ProposeChangeSetResult = z.infer<typeof proposeChangeSetResultSchema>;
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
