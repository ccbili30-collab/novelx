import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { getAgentRuntimeProfile } from "../../src/shared/agentRuntimeProfiles";

const roots: string[] = [];
const opened: WorkspaceDatabase[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("append-only Agent audit repository", () => {
  it("persists run, invocation, tool and terminal receipts across restart without raw secrets", () => {
    const { root, workspace } = createWorkspace();
    const audit = new AgentAuditRepository(workspace);
    const runId = "run-audit-1";
    const invocationId = `${runId}:steward`;
    const toolInvocationId = "11111111-1111-4111-8111-111111111111";
    const profile = getAgentRuntimeProfile("steward");
    const providerConfigSha256 = canonicalAuditHash({ providerId: "provider", modelId: "model" });

    audit.beginRun({
      runId,
      mode: "assist",
      userInputSha256: canonicalAuditHash("绝不能落库的用户原文"),
      providerId: "provider",
      requestedModelId: "model",
      providerConfigSha256,
    });
    audit.beginInvocation({
      invocationId,
      runId,
      parentInvocationId: null,
      role: "steward",
      promptId: "novax.steward",
      promptVersion: "1.1.0",
      promptSha256: "a".repeat(64),
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      agentProfileSha256: profile.sha256,
      providerId: "provider",
      requestedModelId: "model",
      providerConfigSha256,
      toolPolicyId: profile.toolPolicyId,
      toolPolicyVersion: profile.toolPolicyVersion,
      toolPolicySha256: profile.toolPolicySha256,
      authorizedTools: profile.authorizedTools,
      handoffContractId: null,
      handoffVersion: null,
      handoffPayloadSha256: null,
      inputSha256: canonicalAuditHash("绝不能落库的用户原文"),
    });
    audit.beginTool({
      toolInvocationId,
      runId,
      invocationId,
      toolName: "retrieve_graph_evidence",
      argumentsSha256: canonicalAuditHash({ scopeResourceIds: ["world-1"] }),
    });
    audit.appendToolTerminal({
      runId,
      invocationId,
      toolInvocationId,
      eventType: "succeeded",
      errorCode: null,
      resultSha256: canonicalAuditHash({ evidence: "不落原文" }),
    });
    audit.appendInvocationTerminal({
      runId,
      invocationId,
      eventType: "completed",
      errorCode: null,
      actualProviderId: "provider",
      actualModelId: null,
      responseIdSha256: canonicalAuditHash("response-secret-id"),
      stopReason: "stop",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      contextPolicyVersion: "novax.estimated-tokens-v3@3.0.0",
      maxChargedInputBytes: 1_000,
      configuredContextWindow: 64_000,
      safetyReserve: 6_400,
      outputReserve: 16_000,
      estimatedInputTokens: 8_200,
      availableInputBudget: 41_600,
      systemPromptTokens: 1_500,
      toolProtocolTokens: 700,
      sessionHistoryTokens: 2_000,
      retrievalTokens: 3_000,
      collaborationTokens: 400,
      runtimeConversationTokens: 600,
      correctionAttempts: 1,
      structuredSubmissionCount: 1,
      outputSha256: canonicalAuditHash({ status: "completed" }),
    });
    audit.appendRunTerminal({ runId, eventType: "completed", errorCode: null });

    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);
    const reopened = openWorkspace(root);
    opened.push(reopened);
    const persisted = new AgentAuditRepository(reopened);

    expect(persisted.getRun(runId)).toMatchObject({
      id: runId,
      provider_id: "provider",
      requested_model_id: "model",
    });
    expect(persisted.listInvocations(runId)).toHaveLength(1);
    expect(persisted.listTools(runId)).toHaveLength(1);
    expect(persisted.listEvents(runId).map((event) => event.event_type)).toEqual([
      "succeeded",
      "completed",
      "completed",
    ]);
    expect(persisted.listEvents(runId).find((event) => event.entity_type === "invocation")).toMatchObject({
      system_prompt_tokens: 1_500,
      tool_protocol_tokens: 700,
      session_history_tokens: 2_000,
      retrieval_tokens: 3_000,
      collaboration_tokens: 400,
      runtime_conversation_tokens: 600,
      estimated_input_tokens: 8_200,
      available_input_budget: 41_600,
    });
    expect(persisted.getLatestContextBudget()).toMatchObject({
      contextPolicyVersion: "novax.estimated-tokens-v3@3.0.0",
      configuredContextWindow: 64_000,
      estimatedInputTokens: 8_200,
      availableInputBudget: 41_600,
      systemPromptTokens: 1_500,
      toolProtocolTokens: 700,
      sessionHistoryTokens: 2_000,
      retrievalTokens: 3_000,
      collaborationTokens: 400,
      runtimeConversationTokens: 600,
    });

    const storedText = JSON.stringify({
      run: persisted.getRun(runId),
      invocations: persisted.listInvocations(runId),
      tools: persisted.listTools(runId),
      events: persisted.listEvents(runId),
    });
    expect(storedText).not.toContain("绝不能落库的用户原文");
    expect(storedText).not.toContain("response-secret-id");
    expect(storedText).not.toContain("api-key-secret");
    expect(storedText).not.toContain("scopeResourceIds");
  });

  it("rejects conflicting terminal events and recovers unfinished runs as interrupted", () => {
    const { workspace } = createWorkspace();
    const audit = new AgentAuditRepository(workspace);
    audit.beginRun({
      runId: "run-conflict",
      mode: "free",
      userInputSha256: "b".repeat(64),
      providerId: null,
      requestedModelId: null,
      providerConfigSha256: null,
    });
    audit.appendRunTerminal({ runId: "run-conflict", eventType: "failed", errorCode: "FIRST" });
    expect(() => audit.appendRunTerminal({
      runId: "run-conflict",
      eventType: "completed",
      errorCode: null,
    })).toThrow(expect.objectContaining({ code: "AUDIT_TERMINAL_CONFLICT" }));

    audit.beginRun({
      runId: "run-open",
      mode: "assist",
      userInputSha256: "c".repeat(64),
      providerId: null,
      requestedModelId: null,
      providerConfigSha256: null,
    });
    expect(audit.recoverOpenRuns()).toBe(1);
    expect(audit.listEvents("run-open")).toMatchObject([{
      event_type: "interrupted",
      error_code: "APPLICATION_TERMINATED_UNCLEANLY",
      terminal: 1,
    }]);
  });
});

function createWorkspace(): { root: string; workspace: WorkspaceDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-agent-audit-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return { root, workspace };
}
