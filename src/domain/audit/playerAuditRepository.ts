import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export const PLAYER_RUNTIME_CONTRACT_VERSION = "novax.player-runtime@1.0.0";
export type PlayerAuditRole = "gm" | "writer" | "checker";

interface InvocationIdentity {
  invocationId: string;
  runId: string;
  parentInvocationId: string | null;
  role: PlayerAuditRole;
  prompt: { id: string; version: string; sha256: string };
  profile: {
    id: string; version: string; sha256: string;
    toolPolicyId: string; toolPolicyVersion: string; toolPolicySha256: string; authorizedTools: string[];
  };
  provider: { providerId: string; requestedModelId: string; providerConfigSha256: string };
  handoff: { contractId: string; version: string; payloadSha256: string } | null;
  inputSha256: string;
}

export interface PlayerAuditReceipt {
  actualProviderId: string | null;
  actualModelId: string | null;
  responseIdSha256: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  contextPolicyVersion: string | null;
  maxChargedInputBytes: number | null;
  configuredContextWindow: number | null;
  safetyReserve: number | null;
  outputReserve: number | null;
}

export class PlayerAuditRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  beginRun(input: {
    runId: string; playthroughId: string; playerActionSha256: string;
    providerId: string; requestedModelId: string; providerConfigSha256: string;
  }): void {
    this.workspace.db.prepare(`
      INSERT INTO player_agent_runs (
        id, workspace_id, playthrough_id, player_action_sha256, provider_id,
        requested_model_id, provider_config_sha256, runtime_contract_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.runId, this.workspace.workspaceId, input.playthroughId, input.playerActionSha256,
      input.providerId, input.requestedModelId, input.providerConfigSha256, PLAYER_RUNTIME_CONTRACT_VERSION, new Date().toISOString());
  }

  beginInvocation(input: InvocationIdentity): void {
    this.workspace.db.prepare(`
      INSERT INTO player_agent_invocations (
        id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256,
        agent_profile_id, agent_profile_version, agent_profile_sha256, provider_id,
        requested_model_id, provider_config_sha256, tool_policy_id, tool_policy_version,
        tool_policy_sha256, authorized_tools_json, handoff_contract_id, handoff_version,
        handoff_payload_sha256, input_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.invocationId, input.runId, input.parentInvocationId, input.role,
      input.prompt.id, input.prompt.version, input.prompt.sha256, input.profile.id, input.profile.version,
      input.profile.sha256, input.provider.providerId, input.provider.requestedModelId,
      input.provider.providerConfigSha256, input.profile.toolPolicyId, input.profile.toolPolicyVersion,
      input.profile.toolPolicySha256, JSON.stringify([...input.profile.authorizedTools].sort()),
      input.handoff?.contractId ?? null, input.handoff?.version ?? null, input.handoff?.payloadSha256 ?? null,
      input.inputSha256, new Date().toISOString());
  }

  beginTool(input: { runId: string; invocationId: string; toolInvocationId: string; toolName: "writer" | "checker"; argumentsSha256: string }): void {
    this.workspace.db.prepare(`
      INSERT INTO player_agent_tool_invocations (id, run_id, invocation_id, tool_name, arguments_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.toolInvocationId, input.runId, input.invocationId, input.toolName, input.argumentsSha256, new Date().toISOString());
  }

  appendInvocationTerminal(input: {
    runId: string; invocationId: string; eventType: "completed" | "blocked" | "failed" | "cancelled" | "interrupted";
    errorCode: string | null; receipt: PlayerAuditReceipt; structuredSubmissionCount: number; outputSha256: string | null;
  }): void {
    this.insertEvent({ ...input, entityType: "invocation", toolInvocationId: null, resultSha256: null });
  }

  appendToolTerminal(input: {
    runId: string; invocationId: string; toolInvocationId: string; eventType: "succeeded" | "failed" | "cancelled" | "interrupted";
    errorCode: string | null; resultSha256: string | null;
  }): void {
    this.insertEvent({ ...input, entityType: "tool", receipt: null, structuredSubmissionCount: null, outputSha256: null });
  }

  linkEvidence(input: { runId: string; invocationId: string; evidence: Array<{ id: string; sha256?: string | null }> }): void {
    const insert = this.workspace.db.prepare(`
      INSERT INTO player_agent_evidence_links (id, run_id, invocation_id, evidence_id, evidence_sha256, ordinal, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      input.evidence.forEach((evidence, ordinal) => insert.run(randomUUID(), input.runId, input.invocationId, evidence.id, evidence.sha256 ?? null, ordinal, new Date().toISOString()));
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendRunTerminal(input: { runId: string; eventType: "completed" | "blocked" | "failed" | "cancelled" | "interrupted"; errorCode: string | null }): void {
    if (input.eventType === "completed") {
      const roles = this.workspace.db.prepare(`
        SELECT i.role FROM player_agent_invocations i
        JOIN player_agent_audit_events e ON e.invocation_id = i.id AND e.entity_type = 'invocation' AND e.event_type = 'completed'
        WHERE i.run_id = ? ORDER BY i.role
      `).all(input.runId).map((row) => String((row as { role: string }).role));
      if (roles.join(",") !== "checker,gm,writer") throw auditError("PLAYER_AUDIT_INCOMPLETE");
    }
    this.insertEvent({ runId: input.runId, invocationId: null, toolInvocationId: null, entityType: "run", eventType: input.eventType,
      errorCode: input.errorCode, receipt: null, structuredSubmissionCount: null, outputSha256: null, resultSha256: null });
  }

  private insertEvent(input: {
    runId: string; entityType: "run" | "invocation" | "tool"; invocationId: string | null; toolInvocationId: string | null;
    eventType: string; errorCode: string | null; receipt: PlayerAuditReceipt | null; structuredSubmissionCount: number | null;
    outputSha256: string | null; resultSha256: string | null;
  }): void {
    const receipt = input.receipt;
    this.workspace.db.prepare(`
      INSERT INTO player_agent_audit_events (
        id, run_id, entity_type, invocation_id, tool_invocation_id, event_type, error_code,
        actual_provider_id, actual_model_id, response_id_sha256, stop_reason, input_tokens,
        output_tokens, total_tokens, context_policy_version, charged_input_bytes,
        configured_context_window, safety_reserve, output_reserve, structured_submission_count,
        output_sha256, result_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.runId, input.entityType, input.invocationId, input.toolInvocationId,
      input.eventType, input.errorCode, receipt?.actualProviderId ?? null, receipt?.actualModelId ?? null,
      receipt?.responseIdSha256 ?? null, receipt?.stopReason ?? null, receipt?.inputTokens ?? null,
      receipt?.outputTokens ?? null, receipt?.totalTokens ?? null, receipt?.contextPolicyVersion ?? null,
      receipt?.maxChargedInputBytes ?? null, receipt?.configuredContextWindow ?? null,
      receipt?.safetyReserve ?? null, receipt?.outputReserve ?? null, input.structuredSubmissionCount,
      input.outputSha256, input.resultSha256, new Date().toISOString());
  }
}

function auditError(code: string): Error & { code: string } {
  return Object.assign(new Error("Player audit contract failed."), { code });
}
