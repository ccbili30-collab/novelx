import { z } from "zod";

export const RUNTIME_V2_PROTOCOL_VERSION = 1 as const;

const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const versionedCapabilityKeySchema = z.string().trim().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(160);
const runtimeV2BuildSchema = z.object({
  commit: z.string().trim().min(1).max(160),
  target: z.string().trim().min(1).max(240),
}).strict();

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
  featureFlags: z.record(versionedCapabilityKeySchema, z.boolean()),
  hostCapabilityVersions: z.record(versionedCapabilityKeySchema, semanticVersionSchema),
}).strict();

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

function readProtocolVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("protocolVersion" in value)) return undefined;
  return value.protocolVersion;
}
