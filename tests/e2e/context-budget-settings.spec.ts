import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { getAgentRuntimeProfile } from "../../src/shared/agentRuntimeProfiles";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("shows the latest audited request-level context budget in Provider settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-budget-ui-"));
  const workspacePath = path.join(root, "workspace");
  const userDataPath = path.join(root, "user-data");
  fs.mkdirSync(workspacePath, { recursive: true });
  seedBudgetAudit(workspacePath);
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: {
        ...process.env,
        NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
        NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
      },
    });
    const page = await app.firstWindow();
    await page.getByTitle("设置").click();
    const budget = page.getByRole("definition");
    await expect(page.getByText("系统提示词和工具协议占用")).toBeVisible();
    await expect(budget.filter({ hasText: "2,200 tokens" })).toBeVisible();
    await expect(budget.filter({ hasText: "2,000 tokens" })).toBeVisible();
    await expect(budget.filter({ hasText: "3,000 tokens" })).toBeVisible();
    await expect(page.getByText(/41,600 tokens；本次装载后剩余 33,400/)).toBeVisible();
    await expect(page.getByText(/novax\.estimated-tokens-v3@3\.0\.0/)).toBeVisible();
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedBudgetAudit(workspacePath: string): void {
  const workspace = openWorkspace(workspacePath);
  try {
    const audit = new AgentAuditRepository(workspace);
    const profile = getAgentRuntimeProfile("steward");
    const runId = "run-context-budget-ui";
    const invocationId = `${runId}:steward`;
    const providerHash = canonicalAuditHash({ providerId: "provider", modelId: "model" });
    audit.beginRun({ runId, mode: "assist", userInputSha256: "a".repeat(64), providerId: "provider", requestedModelId: "model", providerConfigSha256: providerHash });
    audit.beginInvocation({
      invocationId,
      runId,
      parentInvocationId: null,
      role: "steward",
      promptId: "novax.steward",
      promptVersion: "1.1.0",
      promptSha256: "b".repeat(64),
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      agentProfileSha256: profile.sha256,
      providerId: "provider",
      requestedModelId: "model",
      providerConfigSha256: providerHash,
      toolPolicyId: profile.toolPolicyId,
      toolPolicyVersion: profile.toolPolicyVersion,
      toolPolicySha256: profile.toolPolicySha256,
      authorizedTools: profile.authorizedTools,
      handoffContractId: null,
      handoffVersion: null,
      handoffPayloadSha256: null,
      inputSha256: "a".repeat(64),
    });
    audit.appendInvocationTerminal({
      runId,
      invocationId,
      eventType: "completed",
      errorCode: null,
      actualProviderId: "provider",
      actualModelId: "model",
      responseIdSha256: null,
      stopReason: "stop",
      inputTokens: 8_200,
      outputTokens: 500,
      totalTokens: 8_700,
      contextPolicyVersion: "novax.estimated-tokens-v3@3.0.0",
      maxChargedInputBytes: 24_000,
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
      correctionAttempts: 0,
      structuredSubmissionCount: 1,
      outputSha256: null,
    });
    audit.appendRunTerminal({ runId, eventType: "completed", errorCode: null });
  } finally {
    workspace.close();
  }
}
