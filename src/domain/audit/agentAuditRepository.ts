import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { CheckpointRepository } from "../version/checkpointRepository";

export const AGENT_RUNTIME_CONTRACT_VERSION = "novax.agent-runtime@1.1.0";

export interface AgentAuditStore {
  beginRun(input: BeginRunInput): void;
  beginInvocation(input: BeginInvocationInput): void;
  beginTool(input: BeginToolInput): void;
  appendRunCancelRequested(runId: string): void;
  appendRunTerminal(input: RunTerminalInput): void;
  appendInvocationTerminal(input: InvocationTerminalInput): void;
  appendToolTerminal(input: ToolTerminalInput): void;
  linkTargets(input: AuditLinkInput): void;
  linkChangeSetOutputs(changeSetId: string): void;
  assertToolInvocation(input: {
    toolInvocationId: string;
    runId: string;
    invocationId: string;
    toolName: string;
  }): void;
  terminalizeOpenRun(runId: string, eventType: "cancelled" | "interrupted" | "failed", errorCode: string): void;
}

export interface BeginRunInput {
  runId: string;
  mode: "free" | "assist";
  userInputSha256: string;
  providerId: string | null;
  requestedModelId: string | null;
  providerConfigSha256: string | null;
}

export interface BeginInvocationInput {
  invocationId: string;
  runId: string;
  parentInvocationId: string | null;
  role: "steward" | "writer" | "checker";
  promptId: string;
  promptVersion: string;
  promptSha256: string;
  agentProfileId: string;
  agentProfileVersion: string;
  agentProfileSha256: string;
  providerId: string;
  requestedModelId: string;
  providerConfigSha256: string;
  toolPolicyId: string;
  toolPolicyVersion: string;
  toolPolicySha256: string;
  authorizedTools: string[];
  handoffContractId: string | null;
  handoffVersion: string | null;
  handoffPayloadSha256: string | null;
  inputSha256: string;
}

export interface BeginToolInput {
  toolInvocationId: string;
  runId: string;
  invocationId: string;
  toolName: string;
  argumentsSha256: string;
}

export interface RunTerminalInput {
  runId: string;
  eventType: "completed" | "blocked" | "awaiting_confirmation" | "failed" | "cancelled" | "interrupted";
  errorCode: string | null;
  changeSetId?: string | null;
}

export interface InvocationTerminalInput {
  runId: string;
  invocationId: string;
  eventType: "completed" | "blocked" | "awaiting_confirmation" | "failed" | "cancelled" | "interrupted";
  errorCode: string | null;
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
  estimatedInputTokens?: number | null;
  availableInputBudget?: number | null;
  systemPromptTokens?: number | null;
  toolProtocolTokens?: number | null;
  sessionHistoryTokens?: number | null;
  retrievalTokens?: number | null;
  collaborationTokens?: number | null;
  runtimeConversationTokens?: number | null;
  correctionAttempts: number;
  structuredSubmissionCount: number;
  outputSha256: string | null;
}

export interface ToolTerminalInput {
  runId: string;
  invocationId: string;
  toolInvocationId: string;
  eventType: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
  errorCode: string | null;
  resultSha256: string | null;
  changeSetId?: string | null;
}

export interface AuditLinkInput {
  toolInvocationId: string;
  links: Array<{
    kind:
      | "document_evidence"
      | "assertion_evidence"
      | "change_set_output"
      | "document_version_output"
      | "assertion_version_output"
      | "resource_revision_output"
      | "creative_document_revision_output"
      | "creative_relation_revision_output"
      | "constraint_profile_version_output";
    targetId: string;
    targetSha256: string | null;
  }>;
}

export interface ArtifactProvenanceRecord {
  artifactKind:
    | "resource_revision"
    | "document_version"
    | "assertion_version"
    | "creative_document_revision"
    | "creative_relation_revision"
    | "constraint_profile_version";
  artifactId: string;
  artifactSha256: string;
  changeSetId: string;
  toolInvocationId: string;
  invocationId: string;
  runId: string;
  promptId: string;
  promptVersion: string;
  promptSha256: string;
  providerId: string;
  requestedModelId: string;
  providerConfigSha256: string;
  runtimeContractVersion: string;
}

export interface ContextBudgetAuditRecord {
  recordedAt: string;
  contextPolicyVersion: string;
  configuredContextWindow: number;
  safetyReserve: number;
  outputReserve: number;
  estimatedInputTokens: number;
  availableInputBudget: number;
  systemPromptTokens: number;
  toolProtocolTokens: number;
  sessionHistoryTokens: number;
  retrievalTokens: number;
  collaborationTokens: number;
  runtimeConversationTokens: number;
}

export class AgentAuditRepository implements AgentAuditStore {
  constructor(readonly workspace: WorkspaceDatabase) {}

  beginRun(input: BeginRunInput): void {
    const branch = new CheckpointRepository(this.workspace).getActiveBranch();
    this.workspace.db.prepare(`
      INSERT INTO agent_runs (
        id, workspace_id, branch_id, base_checkpoint_id, mode, user_input_sha256,
        provider_id, requested_model_id, provider_config_sha256, runtime_contract_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      this.workspace.workspaceId,
      branch.id,
      branch.headCheckpointId,
      input.mode,
      input.userInputSha256,
      input.providerId,
      input.requestedModelId,
      input.providerConfigSha256,
      AGENT_RUNTIME_CONTRACT_VERSION,
      new Date().toISOString(),
    );
  }

  beginInvocation(input: BeginInvocationInput): void {
    this.workspace.db.prepare(`
      INSERT INTO agent_invocations (
        id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256,
        agent_profile_id, agent_profile_version, agent_profile_sha256, provider_id,
        requested_model_id, provider_config_sha256, tool_policy_id, tool_policy_version,
        tool_policy_sha256, authorized_tools_json, handoff_contract_id, handoff_version,
        handoff_payload_sha256, input_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.invocationId,
      input.runId,
      input.parentInvocationId,
      input.role,
      input.promptId,
      input.promptVersion,
      input.promptSha256,
      input.agentProfileId,
      input.agentProfileVersion,
      input.agentProfileSha256,
      input.providerId,
      input.requestedModelId,
      input.providerConfigSha256,
      input.toolPolicyId,
      input.toolPolicyVersion,
      input.toolPolicySha256,
      JSON.stringify([...input.authorizedTools].sort()),
      input.handoffContractId,
      input.handoffVersion,
      input.handoffPayloadSha256,
      input.inputSha256,
      new Date().toISOString(),
    );
  }

  beginTool(input: BeginToolInput): void {
    this.workspace.db.prepare(`
      INSERT INTO agent_tool_invocations (
        id, run_id, invocation_id, tool_name, arguments_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.toolInvocationId,
      input.runId,
      input.invocationId,
      input.toolName,
      input.argumentsSha256,
      new Date().toISOString(),
    );
  }

  appendRunCancelRequested(runId: string): void {
    this.insertEvent({
      runId,
      entityType: "run",
      invocationId: null,
      toolInvocationId: null,
      eventType: "cancel_requested",
      terminal: false,
      errorCode: null,
    });
  }

  appendRunTerminal(input: RunTerminalInput): void {
    this.insertTerminal({
      runId: input.runId,
      entityType: "run",
      invocationId: null,
      toolInvocationId: null,
      eventType: input.eventType,
      terminal: true,
      errorCode: input.errorCode,
      changeSetId: input.changeSetId ?? null,
    });
  }

  appendInvocationTerminal(input: InvocationTerminalInput): void {
    this.insertTerminal({
      runId: input.runId,
      entityType: "invocation",
      invocationId: input.invocationId,
      toolInvocationId: null,
      eventType: input.eventType,
      terminal: true,
      errorCode: input.errorCode,
      actualProviderId: input.actualProviderId,
      actualModelId: input.actualModelId,
      responseIdSha256: input.responseIdSha256,
      stopReason: input.stopReason,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      contextPolicyVersion: input.contextPolicyVersion,
      maxChargedInputBytes: input.maxChargedInputBytes,
      configuredContextWindow: input.configuredContextWindow,
      safetyReserve: input.safetyReserve,
      outputReserve: input.outputReserve,
      estimatedInputTokens: input.estimatedInputTokens,
      availableInputBudget: input.availableInputBudget,
      systemPromptTokens: input.systemPromptTokens,
      toolProtocolTokens: input.toolProtocolTokens,
      sessionHistoryTokens: input.sessionHistoryTokens,
      retrievalTokens: input.retrievalTokens,
      collaborationTokens: input.collaborationTokens,
      runtimeConversationTokens: input.runtimeConversationTokens,
      correctionAttempts: input.correctionAttempts,
      structuredSubmissionCount: input.structuredSubmissionCount,
      outputSha256: input.outputSha256,
    });
  }

  appendToolTerminal(input: ToolTerminalInput): void {
    this.insertTerminal({
      runId: input.runId,
      entityType: "tool",
      invocationId: input.invocationId,
      toolInvocationId: input.toolInvocationId,
      eventType: input.eventType,
      terminal: true,
      errorCode: input.errorCode,
      resultSha256: input.resultSha256,
      changeSetId: input.changeSetId ?? null,
    });
  }

  linkTargets(input: AuditLinkInput): void {
    const identity = this.getToolIdentity(input.toolInvocationId);
    const insert = this.workspace.db.prepare(`
      INSERT OR IGNORE INTO agent_audit_links (
        id, run_id, invocation_id, tool_invocation_id, link_kind,
        target_id, target_sha256, ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    input.links.forEach((link, ordinal) => insert.run(
      randomUUID(),
      identity.runId,
      identity.invocationId,
      input.toolInvocationId,
      link.kind,
      link.targetId,
      link.targetSha256,
      ordinal,
      now,
    ));
  }

  linkChangeSetOutputs(changeSetId: string): void {
    const changeSet = this.workspace.db.prepare(`
      SELECT producer_tool_invocation_id FROM change_sets WHERE id = ?
    `).get(changeSetId) as { producer_tool_invocation_id: string | null } | undefined;
    if (!changeSet) throw auditError("CHANGE_SET_NOT_FOUND", "Change Set was not found for audit linking.");
    if (!changeSet.producer_tool_invocation_id) return;
    const outputs = this.workspace.db.prepare(`
      SELECT output_kind, output_id, output_sha256
      FROM change_set_outputs WHERE change_set_id = ? ORDER BY item_id
    `).all(changeSetId) as Array<{
      output_kind: ArtifactProvenanceRecord["artifactKind"];
      output_id: string;
      output_sha256: string;
    }>;
    this.linkTargets({
      toolInvocationId: changeSet.producer_tool_invocation_id,
      links: [
        { kind: "change_set_output", targetId: changeSetId, targetSha256: null },
        ...outputs.map((output) => ({
          kind: `${output.output_kind}_output` as
            | "resource_revision_output"
            | "document_version_output"
            | "assertion_version_output"
            | "creative_document_revision_output"
            | "creative_relation_revision_output"
            | "constraint_profile_version_output",
          targetId: output.output_id,
          targetSha256: output.output_sha256,
        })),
      ],
    });
  }

  assertToolInvocation(input: {
    toolInvocationId: string;
    runId: string;
    invocationId: string;
    toolName: string;
  }): void {
    const identity = this.getToolIdentity(input.toolInvocationId);
    if (
      identity.runId !== input.runId
      || identity.invocationId !== input.invocationId
      || identity.toolName !== input.toolName
    ) {
      throw auditError("AGENT_TOOL_PROVENANCE_INVALID", "Agent tool provenance identity does not match.");
    }
  }

  terminalizeOpenRun(
    runId: string,
    eventType: "cancelled" | "interrupted" | "failed",
    errorCode: string,
  ): void {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const openTools = this.workspace.db.prepare(`
        SELECT t.id, t.invocation_id
        FROM agent_tool_invocations t
        WHERE t.run_id = ? AND NOT EXISTS (
          SELECT 1 FROM agent_audit_events e
          WHERE e.tool_invocation_id = t.id AND e.entity_type = 'tool' AND e.terminal = 1
        )
      `).all(runId) as Array<{ id: string; invocation_id: string }>;
      for (const tool of openTools) {
        this.appendToolTerminal({
          runId,
          invocationId: tool.invocation_id,
          toolInvocationId: tool.id,
          eventType,
          errorCode,
          resultSha256: null,
        });
      }
      const openInvocations = this.workspace.db.prepare(`
        SELECT i.id FROM agent_invocations i
        WHERE i.run_id = ? AND NOT EXISTS (
          SELECT 1 FROM agent_audit_events e
          WHERE e.invocation_id = i.id AND e.entity_type = 'invocation' AND e.terminal = 1
        )
      `).all(runId) as Array<{ id: string }>;
      for (const invocation of openInvocations) {
        this.appendInvocationTerminal({
          runId,
          invocationId: invocation.id,
          eventType,
          errorCode,
          actualProviderId: null,
          actualModelId: null,
          responseIdSha256: null,
          stopReason: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          contextPolicyVersion: null,
          maxChargedInputBytes: null,
          configuredContextWindow: null,
          safetyReserve: null,
          outputReserve: null,
          correctionAttempts: 0,
          structuredSubmissionCount: 0,
          outputSha256: null,
        });
      }
      this.appendRunTerminal({ runId, eventType, errorCode });
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverOpenRuns(): number {
    const rows = this.workspace.db.prepare(`
      SELECT r.id FROM agent_runs r
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_audit_events e
        WHERE e.run_id = r.id AND e.entity_type = 'run' AND e.terminal = 1
      )
    `).all() as Array<{ id: string }>;
    for (const row of rows) this.terminalizeOpenRun(row.id, "interrupted", "APPLICATION_TERMINATED_UNCLEANLY");
    return rows.length;
  }

  getRun(runId: string): Record<string, SQLOutputValue> | null {
    return this.workspace.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) ?? null;
  }

  listInvocations(runId: string): Record<string, SQLOutputValue>[] {
    return this.workspace.db.prepare("SELECT * FROM agent_invocations WHERE run_id = ? ORDER BY created_at, id").all(runId);
  }

  listTools(runId: string): Record<string, SQLOutputValue>[] {
    return this.workspace.db.prepare("SELECT * FROM agent_tool_invocations WHERE run_id = ? ORDER BY created_at, id").all(runId);
  }

  listEvents(runId: string): Record<string, SQLOutputValue>[] {
    return this.workspace.db.prepare("SELECT * FROM agent_audit_events WHERE run_id = ? ORDER BY sequence").all(runId);
  }

  getLatestContextBudget(): ContextBudgetAuditRecord | null {
    const row = this.workspace.db.prepare(`
      SELECT created_at, context_policy_version, configured_context_window, safety_reserve, output_reserve,
        estimated_input_tokens, available_input_budget,
        system_prompt_tokens, tool_protocol_tokens, session_history_tokens, retrieval_tokens,
        collaboration_tokens, runtime_conversation_tokens
      FROM agent_audit_events
      WHERE entity_type = 'invocation' AND terminal = 1
        AND context_policy_version IS NOT NULL
        AND configured_context_window IS NOT NULL
        AND estimated_input_tokens IS NOT NULL
        AND system_prompt_tokens IS NOT NULL
      ORDER BY sequence DESC LIMIT 1
    `).get() as Record<string, SQLOutputValue> | undefined;
    if (!row) return null;
    return {
      recordedAt: readAuditString(row, "created_at"),
      contextPolicyVersion: readAuditString(row, "context_policy_version"),
      configuredContextWindow: readAuditNumber(row, "configured_context_window"),
      safetyReserve: readAuditNumber(row, "safety_reserve"),
      outputReserve: readAuditNumber(row, "output_reserve"),
      estimatedInputTokens: readAuditNumber(row, "estimated_input_tokens"),
      availableInputBudget: readAuditNumber(row, "available_input_budget"),
      systemPromptTokens: readAuditNumber(row, "system_prompt_tokens"),
      toolProtocolTokens: readAuditNumber(row, "tool_protocol_tokens"),
      sessionHistoryTokens: readAuditNumber(row, "session_history_tokens"),
      retrievalTokens: readAuditNumber(row, "retrieval_tokens"),
      collaborationTokens: readAuditNumber(row, "collaboration_tokens"),
      runtimeConversationTokens: readAuditNumber(row, "runtime_conversation_tokens"),
    };
  }

  listLinks(runId: string): Record<string, SQLOutputValue>[] {
    return this.workspace.db.prepare("SELECT * FROM agent_audit_links WHERE run_id = ? ORDER BY ordinal, id").all(runId);
  }

  getArtifactProvenance(
    artifactKind: ArtifactProvenanceRecord["artifactKind"],
    artifactId: string,
  ): ArtifactProvenanceRecord | null {
    const row = this.workspace.db.prepare(`
      SELECT
        output.output_kind, output.output_id, output.output_sha256,
        change_set.id AS change_set_id,
        tool.id AS tool_invocation_id, tool.tool_name,
        invocation.id AS invocation_id, invocation.role,
        invocation.prompt_id, invocation.prompt_version, invocation.prompt_sha256,
        invocation.provider_id, invocation.requested_model_id, invocation.provider_config_sha256,
        run.id AS run_id, run.runtime_contract_version
      FROM change_set_outputs output
      JOIN change_sets change_set ON change_set.id = output.change_set_id
      JOIN agent_tool_invocations tool ON tool.id = change_set.producer_tool_invocation_id
      JOIN agent_invocations invocation
        ON invocation.id = tool.invocation_id AND invocation.run_id = tool.run_id
      JOIN agent_runs run ON run.id = tool.run_id
      WHERE output.output_kind = ? AND output.output_id = ?
    `).get(artifactKind, artifactId) as Record<string, SQLOutputValue> | undefined;
    if (!row) return null;
    if (readAuditString(row, "tool_name") !== "propose_change_set" || readAuditString(row, "role") !== "steward") {
      throw auditError("AGENT_ARTIFACT_PROVENANCE_INVALID", "Artifact producer is not a Steward Change Set tool invocation.");
    }
    return {
      artifactKind: readArtifactKind(row, "output_kind"),
      artifactId: readAuditString(row, "output_id"),
      artifactSha256: readAuditString(row, "output_sha256"),
      changeSetId: readAuditString(row, "change_set_id"),
      toolInvocationId: readAuditString(row, "tool_invocation_id"),
      invocationId: readAuditString(row, "invocation_id"),
      runId: readAuditString(row, "run_id"),
      promptId: readAuditString(row, "prompt_id"),
      promptVersion: readAuditString(row, "prompt_version"),
      promptSha256: readAuditString(row, "prompt_sha256"),
      providerId: readAuditString(row, "provider_id"),
      requestedModelId: readAuditString(row, "requested_model_id"),
      providerConfigSha256: readAuditString(row, "provider_config_sha256"),
      runtimeContractVersion: readAuditString(row, "runtime_contract_version"),
    };
  }

  private insertTerminal(input: AuditEventInput): void {
    const existing = this.findTerminal(input);
    if (existing) {
      if (existing.event_type === input.eventType && existing.error_code === input.errorCode) return;
      throw auditError("AUDIT_TERMINAL_CONFLICT", "Agent audit entity already has a different terminal event.");
    }
    this.insertEvent(input);
  }

  private getToolIdentity(toolInvocationId: string): {
    runId: string;
    invocationId: string;
    toolName: string;
  } {
    const row = this.workspace.db.prepare(`
      SELECT run_id, invocation_id, tool_name FROM agent_tool_invocations WHERE id = ?
    `).get(toolInvocationId) as {
      run_id: string;
      invocation_id: string;
      tool_name: string;
    } | undefined;
    if (!row) throw auditError("AGENT_TOOL_PROVENANCE_INVALID", "Agent tool invocation was not found.");
    return { runId: row.run_id, invocationId: row.invocation_id, toolName: row.tool_name };
  }

  private findTerminal(input: AuditEventInput): { event_type: string; error_code: string | null } | null {
    const [column, id] = input.entityType === "run"
      ? ["run_id", input.runId]
      : input.entityType === "invocation"
        ? ["invocation_id", input.invocationId]
        : ["tool_invocation_id", input.toolInvocationId];
    return this.workspace.db.prepare(`
      SELECT event_type, error_code FROM agent_audit_events
      WHERE entity_type = ? AND ${column} = ? AND terminal = 1
    `).get(input.entityType, id) as { event_type: string; error_code: string | null } | undefined ?? null;
  }

  private insertEvent(input: AuditEventInput): void {
    this.workspace.db.prepare(`
      INSERT INTO agent_audit_events (
        id, run_id, entity_type, invocation_id, tool_invocation_id, event_type, terminal,
        error_code, actual_provider_id, actual_model_id, response_id_sha256, stop_reason,
        input_tokens, output_tokens, total_tokens, structured_submission_count,
        context_policy_version, charged_input_bytes, configured_context_window,
        safety_reserve, output_reserve, estimated_input_tokens, available_input_budget,
        system_prompt_tokens, tool_protocol_tokens,
        session_history_tokens, retrieval_tokens, collaboration_tokens, runtime_conversation_tokens,
        correction_attempts, output_sha256, result_sha256, change_set_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.runId,
      input.entityType,
      input.invocationId,
      input.toolInvocationId,
      input.eventType,
      input.terminal ? 1 : 0,
      input.errorCode,
      input.actualProviderId ?? null,
      input.actualModelId ?? null,
      input.responseIdSha256 ?? null,
      input.stopReason ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
      input.structuredSubmissionCount ?? null,
      input.contextPolicyVersion ?? null,
      input.maxChargedInputBytes ?? null,
      input.configuredContextWindow ?? null,
      input.safetyReserve ?? null,
      input.outputReserve ?? null,
      input.estimatedInputTokens ?? null,
      input.availableInputBudget ?? null,
      input.systemPromptTokens ?? null,
      input.toolProtocolTokens ?? null,
      input.sessionHistoryTokens ?? null,
      input.retrievalTokens ?? null,
      input.collaborationTokens ?? null,
      input.runtimeConversationTokens ?? null,
      input.correctionAttempts ?? 0,
      input.outputSha256 ?? null,
      input.resultSha256 ?? null,
      input.changeSetId ?? null,
      new Date().toISOString(),
    );
  }
}

interface AuditEventInput {
  runId: string;
  entityType: "run" | "invocation" | "tool";
  invocationId: string | null;
  toolInvocationId: string | null;
  eventType: string;
  terminal: boolean;
  errorCode: string | null;
  actualProviderId?: string | null;
  actualModelId?: string | null;
  responseIdSha256?: string | null;
  stopReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  contextPolicyVersion?: string | null;
  maxChargedInputBytes?: number | null;
  configuredContextWindow?: number | null;
  safetyReserve?: number | null;
  outputReserve?: number | null;
  estimatedInputTokens?: number | null;
  availableInputBudget?: number | null;
  systemPromptTokens?: number | null;
  toolProtocolTokens?: number | null;
  sessionHistoryTokens?: number | null;
  retrievalTokens?: number | null;
  collaborationTokens?: number | null;
  runtimeConversationTokens?: number | null;
  correctionAttempts?: number;
  structuredSubmissionCount?: number | null;
  outputSha256?: string | null;
  resultSha256?: string | null;
  changeSetId?: string | null;
}

function readAuditString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw auditError("AGENT_AUDIT_DATA_INVALID", `Expected string audit column: ${key}.`);
  return value;
}

function readAuditNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw auditError("AGENT_AUDIT_DATA_INVALID", `Expected numeric audit column: ${key}.`);
  return value;
}

function readArtifactKind(
  row: Record<string, SQLOutputValue>,
  key: string,
): ArtifactProvenanceRecord["artifactKind"] {
  const value = readAuditString(row, key);
  if (value !== "resource_revision"
    && value !== "document_version"
    && value !== "assertion_version"
    && value !== "creative_document_revision"
    && value !== "creative_relation_revision"
    && value !== "constraint_profile_version") {
    throw auditError("AGENT_AUDIT_DATA_INVALID", "Artifact provenance kind is invalid.");
  }
  return value;
}

function auditError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
