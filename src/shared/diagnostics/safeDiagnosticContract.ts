import { z } from "zod";

const identitySchema = z.string().trim().min(1).max(240);
const diagnosticCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/);
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/);

export const safeDiagnosticOperationKindSchema = z.enum([
  "agent_run",
  "growth_cycle",
  "tool_call",
  "image_job",
  "provider_test",
  "projection",
]);

export const safeDiagnosticOwnerSchema = z.enum([
  "provider",
  "worker_schema",
  "growth_phase",
  "tool_bridge",
  "main_gateway",
  "domain_policy",
  "persistence",
  "reconciliation",
  "projection",
]);

export const safeDiagnosticBoundarySchema = z.enum([
  "provider_connect",
  "provider_inference",
  "provider_protocol",
  "tool_arguments",
  "phase_compile",
  "phase_correction",
  "worker_to_main",
  "tool_authorization",
  "tool_execution",
  "change_set_policy",
  "change_set_apply",
  "database_commit",
  "asset_commit",
  "recovery",
  "renderer_projection",
]);

export const safeDiagnosticSideEffectStateSchema = z.enum([
  "none",
  "request_sent",
  "outcome_unknown",
  "committed",
]);

export const safeDiagnosticDispositionSchema = z.enum([
  "observed",
  "correctable",
  "corrected",
  "terminal",
  "reconciliation_required",
]);

export const safeDiagnosticRetryabilitySchema = z.enum([
  "model_correction",
  "safe_retry",
  "user_action",
  "restart_reconcile",
  "do_not_retry",
]);

export const safeDiagnosticEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  diagnosticId: identitySchema,
  operationKind: safeDiagnosticOperationKindSchema,
  operationId: identitySchema,
  runId: identitySchema.nullable(),
  cycleId: identitySchema.nullable(),
  toolInvocationId: identitySchema.nullable(),
  parentDiagnosticId: identitySchema.nullable(),
  sequence: z.number().int().positive().safe(),
  owner: safeDiagnosticOwnerSchema,
  boundary: safeDiagnosticBoundarySchema,
  code: diagnosticCodeSchema,
  toolName: toolNameSchema.nullable(),
  attempt: z.number().int().positive().safe().nullable(),
  maxAttempts: z.number().int().positive().safe().nullable(),
  sideEffectState: safeDiagnosticSideEffectStateSchema,
  disposition: safeDiagnosticDispositionSchema,
  retryability: safeDiagnosticRetryabilitySchema,
  occurredAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if ((value.attempt === null) !== (value.maxAttempts === null)
    || (value.attempt !== null && value.maxAttempts !== null && value.attempt > value.maxAttempts)) {
    context.addIssue({ code: "custom", path: ["attempt"], message: "SAFE_DIAGNOSTIC_ATTEMPT_INVALID" });
  }
  if (value.parentDiagnosticId === value.diagnosticId) {
    context.addIssue({ code: "custom", path: ["parentDiagnosticId"], message: "SAFE_DIAGNOSTIC_PARENT_INVALID" });
  }
  if (value.retryability === "model_correction" && value.sideEffectState !== "none") {
    context.addIssue({ code: "custom", path: ["retryability"], message: "SAFE_DIAGNOSTIC_MODEL_CORRECTION_UNSAFE" });
  }
  if (value.disposition === "correctable" && (value.attempt === null || value.maxAttempts === null)) {
    context.addIssue({ code: "custom", path: ["attempt"], message: "SAFE_DIAGNOSTIC_CORRECTION_ATTEMPT_REQUIRED" });
  }
  if (value.sideEffectState === "outcome_unknown"
    && (value.disposition !== "reconciliation_required" || value.retryability !== "restart_reconcile")) {
    context.addIssue({ code: "custom", path: ["sideEffectState"], message: "SAFE_DIAGNOSTIC_RECONCILIATION_REQUIRED" });
  }
  if (value.disposition === "corrected" && value.sideEffectState !== "none") {
    context.addIssue({ code: "custom", path: ["disposition"], message: "SAFE_DIAGNOSTIC_CORRECTED_SIDE_EFFECT_INVALID" });
  }
});

export type SafeDiagnosticOperationKind = z.infer<typeof safeDiagnosticOperationKindSchema>;
export type SafeDiagnosticOwner = z.infer<typeof safeDiagnosticOwnerSchema>;
export type SafeDiagnosticBoundary = z.infer<typeof safeDiagnosticBoundarySchema>;
export type SafeDiagnosticSideEffectState = z.infer<typeof safeDiagnosticSideEffectStateSchema>;
export type SafeDiagnosticDisposition = z.infer<typeof safeDiagnosticDispositionSchema>;
export type SafeDiagnosticRetryability = z.infer<typeof safeDiagnosticRetryabilitySchema>;
export type SafeDiagnosticEnvelopeV1 = z.infer<typeof safeDiagnosticEnvelopeV1Schema>;
