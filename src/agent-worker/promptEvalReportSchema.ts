import { z } from "zod";

const promptIdentitySchema = z.object({
  id: z.enum(["novax.steward", "novax.writer", "novax.checker"]),
  role: z.enum(["steward", "writer", "checker"]),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("candidate"),
}).strict();

const realProviderCaseSchema = z.object({
  caseId: z.string().min(1).max(240),
  role: z.enum(["steward", "writer", "checker"]),
  passed: z.boolean(),
  failureCodes: z.array(z.string().min(1).max(240)).max(50),
  durationMs: z.number().int().min(0),
  submissions: z.number().int().min(0).max(100),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errorCode: z.string().min(1).max(120).nullable(),
  executionPath: z.enum(["production-steward-runtime", "production-specialist-handoff"]),
  handoffVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
  auditOperations: z.number().int().min(0).max(100),
  runtimeProfileSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  toolPolicySha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  actualProviderId: z.string().min(1).max(80).nullable(),
  actualModelId: z.string().min(1).max(160).nullable(),
  contextPolicyVersion: z.string().min(1).max(160).nullable(),
  correctionAttempts: z.number().int().min(0).max(10),
  productionToolExecutions: z.array(z.object({
    tool: z.enum([
      "retrieve_graph_evidence", "inspect_project_files", "list_project_directory", "stat_project_file",
      "glob_project_files", "search_project_files", "read_project_file", "save_task_note", "list_task_notes", "generate_image", "propose_change_set", "writer", "checker",
    ]),
    status: z.enum(["succeeded", "failed"]),
  }).strict()).max(20),
}).strict();

export const promptEvalReportSchema = z.object({
  formatVersion: z.literal(4),
  classification: z.literal("candidate-prompt-publication-evaluation"),
  generatedAt: z.iso.datetime(),
  run: z.object({
    status: z.enum(["completed", "not_run"]),
    reasonCode: z.enum([
      "REAL_PROVIDER_CONFIG_REQUIRED",
      "REAL_PROVIDER_CONFIG_INVALID",
      "REAL_PROVIDER_EVAL_COMPLETED",
    ]),
  }).strict(),
  provider: z.object({
    providerId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(120),
    modelId: z.string().min(1).max(160),
  }).strict().nullable(),
  prompts: z.array(promptIdentitySchema).length(3),
  offline: z.object({
    classification: z.literal("fixture-only-not-live-evidence"),
    cases: z.number().int().min(1),
    compliantAccepted: z.number().int().min(0),
    violationsRejected: z.number().int().min(0),
  }).strict(),
  realProvider: z.object({
    status: z.enum(["completed", "not_run"]),
    cases: z.array(realProviderCaseSchema),
  }).strict(),
  publicationGate: z.object({
    decision: z.enum(["blocked", "ready_for_manual_review"]),
    blockers: z.array(z.string().min(1).max(160)).max(50),
    autoActivated: z.literal(false),
  }).strict(),
}).strict().superRefine((report, context) => {
  const promptRoles = report.prompts.map((prompt) => prompt.role);
  if (new Set(promptRoles).size !== 3) {
    context.addIssue({ code: "custom", message: "Prompt evaluation must contain three unique roles." });
  }
  const providerRan = report.realProvider.status === "completed";
  const allCasesPassed = providerRan
    && report.realProvider.cases.length > 0
    && report.realProvider.cases.every((item) => item.passed && item.errorCode === null);
  const productionPathComplete = providerRan
    && report.realProvider.cases.every((item) => item.role === "steward"
      ? item.executionPath === "production-steward-runtime"
        && item.handoffVersion === null
        && item.auditOperations >= 2
        && item.runtimeProfileSha256 !== null
        && item.toolPolicySha256 !== null
      : item.executionPath === "production-specialist-handoff"
        && item.handoffVersion === "2.0.0"
        && item.auditOperations >= 4
        && item.runtimeProfileSha256 !== null
        && item.toolPolicySha256 !== null);
  const shouldBeReady = report.run.status === "completed"
    && allCasesPassed
    && productionPathComplete
    && report.publicationGate.blockers.length === 0;
  if ((report.publicationGate.decision === "ready_for_manual_review") !== shouldBeReady) {
    context.addIssue({ code: "custom", message: "Publication gate decision is inconsistent with evidence." });
  }
  if (report.run.status === "not_run" && (report.provider !== null || report.realProvider.cases.length > 0)) {
    context.addIssue({ code: "custom", message: "A not-run report cannot contain Provider execution evidence." });
  }
  for (const item of report.realProvider.cases) {
    if (item.role === "steward" && (
      item.executionPath !== "production-steward-runtime"
      || item.handoffVersion !== null
      || item.auditOperations < 2
      || item.runtimeProfileSha256 === null
      || item.toolPolicySha256 === null
    )) {
      context.addIssue({ code: "custom", message: "Steward production-path evidence is incomplete." });
    }
    if (item.role !== "steward" && (
      item.executionPath !== "production-specialist-handoff"
      || item.handoffVersion !== "2.0.0"
      || item.auditOperations < 4
      || item.runtimeProfileSha256 === null
      || item.toolPolicySha256 === null
    )) {
      context.addIssue({
        code: "custom",
        message: `Specialist production-path evidence is incomplete: ${item.caseId}.`,
      });
    }
  }
});

export type PromptEvalReport = z.infer<typeof promptEvalReportSchema>;
