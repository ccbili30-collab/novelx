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
  projectId: identityStringSchema.nullable(),
  workspaceId: identityStringSchema.nullable(),
  featureFlags: z.record(versionedCapabilityKeySchema, z.boolean()),
  hostCapabilityVersions: z.record(versionedCapabilityKeySchema, semanticVersionSchema),
}).strict().superRefine((payload, context) => {
  const configured = payload.workspaceDatabasePath !== null;
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

const revisionReferenceSchema = z.object({
  id: identityStringSchema,
  revision: z.number().int().positive().safe(),
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
  goal: revisionReferenceSchema.nullable(),
  plan: revisionReferenceSchema.nullable(),
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
  pinnedIdentity: runtimeV2RunPinnedIdentitySchema,
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

export const runtimeV2RunSnapshotPayloadSchema = z.object({
  runId: z.uuid(),
  pinnedIdentity: runtimeV2RunPinnedIdentitySchema,
  state: z.enum([
    "created", "preparing", "running", "waiting_for_approval", "committing",
    "retrying", "blocked", "cancelled", "failed", "completed",
  ]),
  recoveryClassification: z.enum(["resumable", "waiting_for_approval", "commit_uncertain", "terminal"]),
  runSequence: z.number().int().positive().safe(),
  aggregateSequence: z.number().int().positive().safe(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  terminalError: runtimeV2ErrorSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.runSequence < snapshot.aggregateSequence) {
    context.addIssue({ code: "custom", path: ["runSequence"], message: "runSequence cannot precede aggregateSequence." });
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
export type RuntimeV2RunSnapshotPayload = z.infer<typeof runtimeV2RunSnapshotPayloadSchema>;
export type RuntimeV2RunSnapshotEnvelope = z.infer<typeof runtimeV2RunSnapshotEnvelopeSchema>;
export type RuntimeV2RunRejectedEnvelope = z.infer<typeof runtimeV2RunRejectedEnvelopeSchema>;
export type RuntimeV2ProviderConfig = z.infer<typeof runtimeV2ProviderConfigSchema>;
export type RuntimeV2SensitiveProviderBindEnvelope = z.infer<typeof runtimeV2SensitiveProviderBindEnvelopeSchema>;
export type RuntimeV2ProviderBindingReceipt = z.infer<typeof runtimeV2ProviderBindingReceiptSchema>;
export type RuntimeV2ProviderBoundEnvelope = z.infer<typeof runtimeV2ProviderBoundEnvelopeSchema>;
export type RuntimeV2ProviderRejectedEnvelope = z.infer<typeof runtimeV2ProviderRejectedEnvelopeSchema>;

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

export function parseRuntimeV2RunSnapshotEnvelope(value: unknown): RuntimeV2RunSnapshotEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunSnapshotEnvelopeSchema);
}

export function parseRuntimeV2RunRejectedEnvelope(value: unknown): RuntimeV2RunRejectedEnvelope {
  return parseVersionedEnvelope(value, runtimeV2RunRejectedEnvelopeSchema);
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

function parseVersionedEnvelope<T>(value: unknown, schema: z.ZodType<T>): T {
  const version = readProtocolVersion(value);
  if (version !== RUNTIME_V2_PROTOCOL_VERSION) throw new RuntimeV2ProtocolVersionError(version);
  return schema.parse(value);
}

function readProtocolVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("protocolVersion" in value)) return undefined;
  return value.protocolVersion;
}
