import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";

const opened: Array<{ root: string; workspace: WorkspaceDatabase }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

describe("Workspace Agent tool gateway", () => {
  it("retrieves scoped evidence without exposing the workspace path", async () => {
    const { workspace } = createWorkspace();
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);
    const result = await gateway.retrieveGraphEvidence(
      { scopeResourceIds: [world.id] },
      invocationContext("assist"),
    );

    expect(result.scopes).toEqual([{ resourceId: world.id, type: "world", title: "世界" }]);
    expect(result.retrieval).toMatchObject({
      budget: {
        maxDocuments: 12,
        maxAssertions: 200,
        maxDocumentChars: 20_000,
        totalChars: 160_000,
      },
      completeness: {
        incomplete: false,
        omittedAssertions: 0,
        omittedDocuments: 0,
        truncatedDocuments: 0,
      },
      ordering: { relevanceRanking: "not_applied" },
    });
    expect(JSON.stringify(result)).not.toContain(workspace.rootPath);
    expect(JSON.stringify(result)).not.toContain("workspace.db");
  });

  it("creates only a policy-evaluated Assist candidate using Main-owned mode and checkpoint", async () => {
    const { workspace } = createWorkspace();
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);
    const result = await gateway.proposeChangeSet({
      summary: "补充海岸形成原因",
      items: [{
        id: "coast-1",
        dependsOn: [],
        kind: "assertion.put",
        payload: {
          assertionId: "silver-bay-coast-origin",
          scopeType: "world",
          scopeId: world.id,
          subject: "银湾海岸",
          predicate: "形成原因",
          object: { cause: "板块抬升与海蚀共同作用" },
          evidenceIds: ["evidence-version-1"],
        },
      }],
    }, invocationContext("assist"));

    expect(result).toMatchObject({
      mode: "assist",
      status: "pending",
      gateStatus: "review_pending",
      itemCount: 1,
    });
  });

  it("fails closed if the workspace identity changes during a run", async () => {
    const { workspace } = createWorkspace();
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => false);

    await expect(gateway.retrieveGraphEvidence(
      { scopeResourceIds: [world.id] },
      invocationContext("assist"),
    )).rejects.toMatchObject({ code: "AGENT_TOOLS_REQUIRED" });
  });
});

const testOnlyLowRiskPolicy: ChangeSetPolicyEvaluator = {
  assess: (candidate) => candidate.items.map((item) => ({
    itemId: item.id,
    risk: "low",
    conflicts: [],
  })),
};

function invocationContext(mode: "free" | "assist") {
  return {
    runId: "run-test-only",
    invocationId: "run-test-only:steward",
    requestId: "11111111-1111-4111-8111-111111111111",
    mode,
    signal: new AbortController().signal,
  };
}

function seedProposeTool(workspace: WorkspaceDatabase): void {
  const audit = new AgentAuditRepository(workspace);
  const hash = "a".repeat(64);
  audit.beginRun({
    runId: "run-test-only",
    mode: "assist",
    userInputSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
  });
  audit.beginInvocation({
    invocationId: "run-test-only:steward",
    runId: "run-test-only",
    parentInvocationId: null,
    role: "steward",
    promptId: "novax.steward",
    promptVersion: "test",
    promptSha256: hash,
    agentProfileId: "novax.steward",
    agentProfileVersion: "test",
    agentProfileSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
    toolPolicyId: "novax.steward.tools",
    toolPolicyVersion: "test",
    toolPolicySha256: hash,
    authorizedTools: ["propose_change_set"],
    handoffContractId: null,
    handoffVersion: null,
    handoffPayloadSha256: null,
    inputSha256: hash,
  });
  audit.beginTool({
    toolInvocationId: "11111111-1111-4111-8111-111111111111",
    runId: "run-test-only",
    invocationId: "run-test-only:steward",
    toolName: "propose_change_set",
    argumentsSha256: hash,
  });
}

function createWorkspace(): { root: string; workspace: WorkspaceDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-agent-tool-test-only-"));
  const workspace = openWorkspace(root);
  opened.push({ root, workspace });
  return { root, workspace };
}
