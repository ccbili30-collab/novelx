import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import {
  ChangeSetService,
  type ChangeSetCandidate,
  type ChangeSetPolicyEvaluator,
} from "../../src/domain/changeSet/changeSetService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";

const roots: string[] = [];
const opened: WorkspaceDatabase[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Artifact provenance", () => {
  it("links all three Free outputs to the same producing tool and invocation", async () => {
    const { workspace } = createWorkspace();
    const identity = seedProducer(workspace, { mode: "free", suffix: "free-all" });
    const worldRoot = new ResourceRepository(workspace).listCurrent()
      .find((resource) => resource.type === "world" && resource.parentId === null)!;
    const gateway = createWorkspaceAgentToolGateway(workspace, lowRiskPolicy, () => true);
    const resourceId = "world.provenance-coast";

    const result = await gateway.proposeChangeSet({
      summary: "Create a sourced coast record",
      items: [
        {
          id: "resource",
          dependsOn: [],
          kind: "resource.put",
          payload: {
            resourceId,
            create: true,
            type: "world",
            title: "Provenance Coast",
            parentId: worldRoot.id,
            state: "active",
            sortOrder: 1,
          },
        },
        {
          id: "document",
          dependsOn: ["resource"],
          kind: "document.put",
          payload: { resourceId, content: "The coast was formed by uplift and erosion." },
        },
        {
          id: "assertion",
          dependsOn: ["document"],
          kind: "assertion.put",
          payload: {
            assertionId: "assertion.provenance-coast",
            scopeType: "world",
            scopeId: resourceId,
            subject: "Provenance Coast",
            predicate: "origin",
            object: { cause: "uplift-and-erosion" },
            evidenceIds: [],
          },
        },
      ],
    }, invocationContext(identity, "free"));

    expect(result.status).toBe("committed");
    const outputs = new ChangeSetRepository(workspace).listOutputs(result.changeSetId);
    expect(outputs.map((output) => output.kind).sort()).toEqual([
      "assertion_version",
      "document_version",
      "resource_revision",
    ]);
    expect(outputs.every((output) => /^[a-f0-9]{64}$/.test(output.outputSha256))).toBe(true);

    const links = new AgentAuditRepository(workspace).listLinks(identity.runId);
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.link_kind)).toEqual(expect.arrayContaining([
      "change_set_output",
      "resource_revision_output",
      "document_version_output",
      "assertion_version_output",
    ]));
    expect(links.every((link) => link.run_id === identity.runId)).toBe(true);
    expect(links.every((link) => link.invocation_id === identity.invocationId)).toBe(true);
    expect(links.every((link) => link.tool_invocation_id === identity.toolInvocationId)).toBe(true);
    const audit = new AgentAuditRepository(workspace);
    for (const output of outputs) {
      expect(links).toContainEqual(expect.objectContaining({
        link_kind: `${output.kind}_output`,
        target_id: output.outputId,
        target_sha256: output.outputSha256,
      }));
      expect(audit.getArtifactProvenance(output.kind, output.outputId)).toMatchObject({
        artifactKind: output.kind,
        artifactId: output.outputId,
        artifactSha256: output.outputSha256,
        changeSetId: result.changeSetId,
        toolInvocationId: identity.toolInvocationId,
        invocationId: identity.invocationId,
        runId: identity.runId,
        promptId: "novax.steward",
        providerId: "test-provider",
        requestedModelId: "test-model",
      });
    }
  });

  it("preserves the original Assist producer across close, reopen, review, and commit", async () => {
    const { root, workspace } = createWorkspace();
    const identity = seedProducer(workspace, { mode: "assist", suffix: "assist-reopen" });
    const gateway = createWorkspaceAgentToolGateway(workspace, lowRiskPolicy, () => true);
    const result = await gateway.proposeChangeSet({
      summary: "Review a persistent world fact",
      items: [assertionArgs("persistent-fact")],
    }, invocationContext(identity, "assist"));
    expect(result.status).toBe("pending");

    closeWorkspace(workspace);
    const reopened = openTrackedWorkspace(root);
    const service = new ChangeSetService(reopened, lowRiskPolicy);
    const pending = service.getRequired(result.changeSetId);
    expect(pending.producerToolInvocationId).toBe(identity.toolInvocationId);
    service.decideItem(pending.id, "persistent-fact", "accepted");
    const committed = service.finalizeAssist(pending.id, {
      expectedHeadCheckpointId: pending.baseCheckpointId,
      label: "Accept persistent fact",
    });
    expect(committed.status).toBe("committed");

    const [output] = new ChangeSetRepository(reopened).listOutputs(committed.id);
    expect(output?.kind).toBe("assertion_version");
    expect(new AgentAuditRepository(reopened).getArtifactProvenance(output!.kind, output!.outputId)).toMatchObject({
      artifactKind: "assertion_version",
      changeSetId: committed.id,
      toolInvocationId: identity.toolInvocationId,
      invocationId: identity.invocationId,
      promptId: "novax.steward",
      promptVersion: "test-provenance-v1",
      runId: identity.runId,
      providerId: "test-provider",
      requestedModelId: "test-model",
    });
  });

  it("creates no artifact outputs for rejected or draft Assist items", async () => {
    const { workspace } = createWorkspace();
    const identity = seedProducer(workspace, { mode: "assist", suffix: "no-output" });
    const gateway = createWorkspaceAgentToolGateway(workspace, lowRiskPolicy, () => true);
    const result = await gateway.proposeChangeSet({
      summary: "Keep rejected and draft facts out of stable artifacts",
      items: [assertionArgs("rejected-fact"), assertionArgs("draft-fact")],
    }, invocationContext(identity, "assist"));
    const service = new ChangeSetService(workspace, lowRiskPolicy);
    service.decideItem(result.changeSetId, "rejected-fact", "rejected");
    service.decideItem(result.changeSetId, "draft-fact", "draft");
    const finalized = service.finalizeAssistReview(result.changeSetId, "Reject stable publication");

    expect(finalized.status).toBe("rejected");
    expect(new ChangeSetRepository(workspace).listOutputs(result.changeSetId)).toEqual([]);
    expect(new AgentAuditRepository(workspace).listLinks(identity.runId)).toEqual([]);
  });

  it.each([
    ["missing tool", "missing-tool", "run-forged", "run-forged:steward"],
    ["cross-run tool", "cross-run", "different-run", "run-cross-run:steward"],
    ["wrong tool name", "wrong-tool", "run-wrong-tool", "run-wrong-tool:steward"],
  ])("fails closed for %s provenance", async (_caseName, suffix, contextRunId, contextInvocationId) => {
    const { workspace } = createWorkspace();
    const identity = suffix === "missing-tool"
      ? {
          runId: contextRunId,
          invocationId: contextInvocationId,
          toolInvocationId: "99999999-9999-4999-8999-999999999999",
        }
      : seedProducer(workspace, {
          mode: "assist",
          suffix,
          toolName: suffix === "wrong-tool" ? "retrieve_graph_evidence" : "propose_change_set",
        });
    const gateway = createWorkspaceAgentToolGateway(workspace, lowRiskPolicy, () => true);
    const beforeCount = countRows(workspace, "change_sets");

    await expect(gateway.proposeChangeSet({
      summary: "This proposal must not be persisted",
      items: [assertionArgs(`forged-${suffix}`)],
    }, {
      runId: contextRunId,
      invocationId: contextInvocationId,
      requestId: identity.toolInvocationId,
      mode: "assist",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AGENT_TOOL_PROVENANCE_INVALID" });
    expect(countRows(workspace, "change_sets")).toBe(beforeCount);
    expect(countRows(workspace, "change_set_outputs")).toBe(0);
  });

  it("migrates a schema v3 workspace through v10 without inventing provenance", () => {
    const { root, workspace } = createWorkspace();
    closeWorkspace(workspace);
    const databasePath = path.join(root, ".novax", "workspace.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE change_set_outputs");
    legacy.exec("ALTER TABLE change_sets DROP COLUMN producer_tool_invocation_id");
    legacy.exec("ALTER TABLE agent_audit_events DROP COLUMN correction_attempts");
    legacy.exec("UPDATE schema_meta SET version = 3 WHERE singleton = 1");
    legacy.close();

    const migrated = openTrackedWorkspace(root);
    expect(migrated.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get())
      .toMatchObject({ version: 10 });
    const columns = migrated.db.prepare("PRAGMA table_info(change_sets)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("producer_tool_invocation_id");
    expect(migrated.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'change_set_outputs'
    `).get()).toMatchObject({ name: "change_set_outputs" });
    expect(countRows(migrated, "change_set_outputs")).toBe(0);
    const auditColumns = migrated.db.prepare("PRAGMA table_info(agent_audit_events)").all() as Array<{ name: string }>;
    expect(auditColumns.map((column) => column.name)).toContain("correction_attempts");
    const checkpointColumns = migrated.db.prepare("PRAGMA table_info(checkpoints)").all() as Array<{ name: string }>;
    expect(checkpointColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["actor_kind", "source_change_set_id"]));
  });
});

const lowRiskPolicy: ChangeSetPolicyEvaluator = {
  assess: (candidate: ChangeSetCandidate) => candidate.items.map((item) => ({
    itemId: item.id,
    risk: "low",
    conflicts: [],
  })),
};

function assertionArgs(id: string) {
  return {
    id,
    dependsOn: [],
    kind: "assertion.put" as const,
    payload: {
      assertionId: `assertion.${id}`,
      scopeType: "world",
      scopeId: "world.provenance",
      subject: "Provenance World",
      predicate: "fact",
      object: { text: id },
      evidenceIds: [],
    },
  };
}

function seedProducer(
  workspace: WorkspaceDatabase,
  input: {
    mode: "free" | "assist";
    suffix: string;
    toolName?: string;
  },
) {
  const runId = `run-${input.suffix}`;
  const invocationId = `${runId}:steward`;
  const toolInvocationId = uuidFor(input.suffix);
  const hash = canonicalAuditHash({ test: "artifact-provenance", suffix: input.suffix });
  const audit = new AgentAuditRepository(workspace);
  audit.beginRun({
    runId,
    mode: input.mode,
    userInputSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
  });
  audit.beginInvocation({
    invocationId,
    runId,
    parentInvocationId: null,
    role: "steward",
    promptId: "novax.steward",
    promptVersion: "test-provenance-v1",
    promptSha256: hash,
    agentProfileId: "novax.steward",
    agentProfileVersion: "test-provenance-v1",
    agentProfileSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
    toolPolicyId: "novax.steward.tools",
    toolPolicyVersion: "test-provenance-v1",
    toolPolicySha256: hash,
    authorizedTools: [input.toolName ?? "propose_change_set"],
    handoffContractId: null,
    handoffVersion: null,
    handoffPayloadSha256: null,
    inputSha256: hash,
  });
  audit.beginTool({
    toolInvocationId,
    runId,
    invocationId,
    toolName: input.toolName ?? "propose_change_set",
    argumentsSha256: hash,
  });
  return { runId, invocationId, toolInvocationId };
}

function invocationContext(
  identity: ReturnType<typeof seedProducer>,
  mode: "free" | "assist",
) {
  return {
    runId: identity.runId,
    invocationId: identity.invocationId,
    requestId: identity.toolInvocationId,
    mode,
    signal: new AbortController().signal,
  };
}

function uuidFor(value: string): string {
  const hex = canonicalAuditHash(value).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function countRows(workspace: WorkspaceDatabase, table: string): number {
  const row = workspace.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function createWorkspace(): { root: string; workspace: WorkspaceDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-artifact-provenance-"));
  roots.push(root);
  return { root, workspace: openTrackedWorkspace(root) };
}

function openTrackedWorkspace(root: string): WorkspaceDatabase {
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}

function closeWorkspace(workspace: WorkspaceDatabase): void {
  workspace.close();
  opened.splice(opened.indexOf(workspace), 1);
}
