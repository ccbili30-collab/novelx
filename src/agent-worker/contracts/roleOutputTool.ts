import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { roleOutputSchemas, type RoleOutput } from "./roleOutputs";
import type { PromptRole } from "../prompts/manifest";

const identifier = Type.String({ minLength: 1, maxLength: 240 });
const blockedReason = Type.Object({
  code: Type.Union([
    Type.Literal("missing_source"),
    Type.Literal("conflicting_sources"),
    Type.Literal("missing_gm_resolution"),
    Type.Literal("authority_violation"),
    Type.Literal("hidden_fact_risk"),
    Type.Literal("tool_failed"),
    Type.Literal("major_conflict"),
    Type.Literal("user_confirmation_required"),
    Type.Literal("insufficient_input"),
  ]),
  message: Type.String({ minLength: 1, maxLength: 1_000 }),
  evidenceIds: Type.Array(identifier, { maxItems: 100 }),
}, { additionalProperties: false });

const stewardParameters = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("awaiting_confirmation")]),
  message: Type.String({ minLength: 1, maxLength: 8_000 }),
  evidenceIds: Type.Array(identifier, { maxItems: 200 }),
  toolOutcomes: Type.Array(Type.Object({
    tool: Type.Union([
      Type.Literal("retrieve_graph_evidence"),
      Type.Literal("inspect_project_files"),
      Type.Literal("list_project_directory"),
      Type.Literal("stat_project_file"),
      Type.Literal("glob_project_files"),
      Type.Literal("search_project_files"),
      Type.Literal("read_project_file"),
      Type.Literal("save_task_note"),
      Type.Literal("list_task_notes"),
      Type.Literal("generate_image"),
      Type.Literal("propose_change_set"),
      Type.Literal("writer"),
      Type.Literal("checker"),
    ]),
    status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("not_run")]),
  }, { additionalProperties: false }), { maxItems: 100 }),
  changeSet: Type.Object({
    state: Type.Union([Type.Literal("none"), Type.Literal("pending_review"), Type.Literal("committed")]),
    changeSetId: Type.Union([identifier, Type.Null()]),
  }, { additionalProperties: false }),
  escalations: Type.Array(blockedReason, { maxItems: 20 }),
}, { additionalProperties: false });

const writerParameters = Type.Object({
  status: Type.Union([Type.Literal("candidate"), Type.Literal("blocked")]),
  candidateText: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
  evidenceIds: Type.Optional(Type.Array(identifier, { maxItems: 200 })),
  gmResolutionId: Type.Optional(Type.Union([identifier, Type.Null()])),
  authorityChanges: Type.Optional(Type.Array(Type.Never(), { maxItems: 0 })),
  reasons: Type.Optional(Type.Array(blockedReason, { maxItems: 20 })),
}, { additionalProperties: true });

const checkerFinding = Type.Object({
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("major")]),
  category: Type.Union([
    Type.Literal("source_missing"),
    Type.Literal("fact_conflict"),
    Type.Literal("writer_authority"),
    Type.Literal("hidden_fact_leak"),
    Type.Literal("timeline"),
    Type.Literal("character_continuity"),
    Type.Literal("style"),
    Type.Literal("permission"),
    Type.Literal("dependency"),
    Type.Literal("tool_claim"),
  ]),
  evidence: Type.Array(Type.Object({
    sourceId: identifier,
    claim: Type.String({ minLength: 1, maxLength: 1_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
  location: Type.String({ minLength: 1, maxLength: 1_000 }),
  scope: Type.String({ minLength: 1, maxLength: 500 }),
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });

const checkerParameters = Type.Object({
  status: Type.Union([Type.Literal("passed"), Type.Literal("findings"), Type.Literal("blocked")]),
  findings: Type.Optional(Type.Array(checkerFinding, { maxItems: 200 })),
  reasons: Type.Optional(Type.Array(blockedReason, { maxItems: 20 })),
}, { additionalProperties: true });

const parametersByRole: Record<PromptRole, TSchema> = {
  steward: stewardParameters,
  writer: writerParameters,
  checker: checkerParameters,
};

export interface RoleOutputToolCapture {
  tool: AgentTool;
  getSubmission(): RoleOutput | null;
  getSubmissionCount(): number;
}

export function createRoleOutputTool(
  role: PromptRole,
  options: { name?: string; label?: string; description?: string } = {},
): RoleOutputToolCapture {
  let submission: RoleOutput | null = null;
  let submissionCount = 0;
  const tool: AgentTool = {
    name: options.name ?? `submit_${role}_result`,
    label: options.label ?? "提交结构化结果",
    description: options.description ?? resultToolDescription(role),
    parameters: parametersByRole[role],
    execute: async (_toolCallId, params) => {
      const parsed = roleOutputSchemas[role].safeParse(params);
      if (!parsed.success) throw outputToolError("AGENT_OUTPUT_SCHEMA_INVALID", "Structured Agent result is invalid.");
      submissionCount += 1;
      submission = parsed.data as RoleOutput;
      return {
        content: [{ type: "text", text: "Structured result accepted." }],
        details: { accepted: true },
      };
    },
  };
  return {
    tool,
    getSubmission: () => submission,
    getSubmissionCount: () => submissionCount,
  };
}

function resultToolDescription(role: PromptRole): string {
  if (role === "writer") {
    return "Submit exactly one Writer result. candidate requires candidateText, evidenceIds, gmResolutionId and empty authorityChanges. blocked requires reasons with code, message and evidenceIds. Runtime validation remains strict.";
  }
  if (role === "checker") {
    return "Submit exactly one Checker result. passed requires empty findings. findings requires findings with severity, category, evidence, location, scope and reason. blocked requires reasons with code, message and evidenceIds. Runtime validation remains strict.";
  }
  return "Submit the single structured Steward result for this run. This tool does not write project data.";
}

function outputToolError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
