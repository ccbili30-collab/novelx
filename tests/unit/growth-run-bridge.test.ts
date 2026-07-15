import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AgentProcessSupervisor, type AgentRuntimeLease, type AgentWorkerProcess } from "../../src/main/agentProcessSupervisor";
import { GrowthRunLifecycle, growthPhaseForCycleSequence, safeFailureCode } from "../../src/main/growthRunLifecycle";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";

class FakeWorker extends EventEmitter implements AgentWorkerProcess {
  killed = false;
  readonly sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  kill(): boolean { this.killed = true; return true; }
  spawn(): void { this.emit("spawn"); }
  receive(message: unknown): void { this.emit("message", message); }
}

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Growth Run bridge", () => {
  it("authorizes Greenfield creation only for the first Free Cycle on an empty initialized workspace", async () => {
    const empty = createSetup();
    const emptyWorker = new FakeWorker();
    const emptySupervisor = createSupervisor(empty, emptyWorker);
    const emptyRun = new GrowthRunLifecycle(empty.workspace, emptySupervisor).start({
      goalId: empty.goalId, cycleId: empty.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "普通 Growth 种子", mode: "free" }, emit: () => undefined,
    });
    emptyWorker.spawn();
    expect((emptyWorker.sent[0] as { growthBinding: { phase: string } }).growthBinding.phase).toBe("world");
    expect((emptyWorker.sent[0] as { growthBinding: { greenfieldCreateAuthorized: boolean } }).growthBinding.greenfieldCreateAuthorized).toBe(true);
    emptySupervisor.cancel(emptyRun);
    await vi.waitFor(() => expect(new GrowthRepository(empty.workspace).getCycle(empty.cycleId)?.status).toBe("cancelled"));

    empty.workspace.close();
    fs.rmSync(empty.workspace.rootPath, { recursive: true, force: true });
    workspace = undefined;
    root = undefined;

    const nonempty = createSourceDocumentSetup();
    const nonemptyWorker = new FakeWorker();
    const nonemptySupervisor = createSupervisor(nonempty, nonemptyWorker);
    const nonemptyRun = new GrowthRunLifecycle(nonempty.workspace, nonemptySupervisor).start({
      goalId: nonempty.goalId, cycleId: nonempty.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "带来源种子", mode: "free" }, emit: () => undefined,
    });
    nonemptyWorker.spawn();
    expect((nonemptyWorker.sent[0] as { growthBinding: { greenfieldCreateAuthorized: boolean } }).growthBinding.greenfieldCreateAuthorized).toBe(false);
    nonemptySupervisor.cancel(nonemptyRun);
    await vi.waitFor(() => expect(new GrowthRepository(nonempty.workspace).getCycle(nonempty.cycleId)?.status).toBe("cancelled"));
  });

  it("derives only the three trusted Growth phases from persisted Cycle sequence", () => {
    expect(growthPhaseForCycleSequence(1)).toBe("world");
    expect(growthPhaseForCycleSequence(2)).toBe("story");
    expect(growthPhaseForCycleSequence(3)).toBe("oc");
    expect(() => growthPhaseForCycleSequence(4)).toThrow(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
  });

  it("pins a source-document seed to its owning resource without exposing source content", async () => {
    const setup = createSourceDocumentSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "seed", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    const command = worker.sent[0] as { growthBinding: { seedResourceIds: string[] } };
    expect(command.growthBinding.seedResourceIds).toEqual(["source-world"]);
    expect(JSON.stringify(command.growthBinding)).not.toContain("source document content");
    expect(JSON.stringify(command.growthBinding)).not.toContain(setup.workspace.rootPath);
    supervisor.cancel(runId);
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)?.status).toBe("cancelled"));
  });

  it("maps terminal failures to stable allowlisted categories", () => {
    expect(safeFailureCode("REAL_GM_PROVIDER_REQUIRED")).toBe("GROWTH_PROVIDER_CONFIGURATION_FAILED");
    expect(safeFailureCode("PROVIDER_RUNTIME_FAILED")).toBe("GROWTH_PROVIDER_RUNTIME_FAILED");
    expect(safeFailureCode("PROVIDER_PROTOCOL_FAILED")).toBe("GROWTH_PROVIDER_PROTOCOL_FAILED");
    expect(safeFailureCode("AGENT_TOOLS_REQUIRED")).toBe("GROWTH_TOOL_FAILED");
    expect(safeFailureCode("AGENT_TOOL_PROTOCOL_FAILED")).toBe("GROWTH_TOOL_FAILED");
    expect(safeFailureCode("AGENT_AUDIT_REQUIRED")).toBe("GROWTH_AGENT_RUNTIME_FAILED");
    expect(safeFailureCode("unrecognized_secret_error")).toBe("GROWTH_RUN_FAILED");
  });

  it("pins Growth retrieval, records the Receipt, and binds one committed Free Change Set", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const events: unknown[] = [];
    const runId = lifecycle.start({
      goalId: setup.goalId,
      cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "根据证据补充正式设定", mode: "free", scopeResourceIds: ["forged-scope"] },
      emit: (event) => events.push(event),
    });
    worker.spawn();
    const start = worker.sent[0] as Record<string, unknown>;
    expect(start).toMatchObject({ type: "run.start", runId, scopeResourceIds: setup.authorizedScopeResourceIds });
    expect(JSON.stringify(start.growthBinding)).not.toContain("branchId");
    beginStewardInvocation(setup.workspace, runId);

    worker.receive({
      type: "tool.request", runId, requestId: "11111111-1111-4111-8111-111111111111", tool: "retrieve_graph_evidence",
      args: { variant: "growth_v1", query: "世界", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000, expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1", scopeResourceIds: ["forged-scope"] },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    expect(worker.sent[1]).toMatchObject({ type: "tool.response", ok: false, error: { code: "AGENT_TOOL_PROTOCOL_FAILED" } });

    const retrieveRequestId = "22222222-2222-4222-8222-222222222222";
    worker.receive({
      type: "tool.request", runId, requestId: retrieveRequestId, tool: "retrieve_graph_evidence",
      args: { variant: "growth_v1", query: "世界", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000, expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1" },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(3));
    const retrievalResponse = worker.sent[2] as { ok: boolean; result: { variant: string; receiptRecorded: boolean; evidence: Array<{ evidenceId: string }> } };
    if (!retrievalResponse.ok) throw new Error(JSON.stringify(worker.sent[2]));
    expect(retrievalResponse).toMatchObject({ ok: true, result: { variant: "growth_v1", receiptRecorded: true } });
    expect(JSON.stringify(retrievalResponse.result)).not.toContain("stableLocator");
    expect(JSON.stringify(retrievalResponse.result)).not.toContain(setup.workspace.rootPath);
    expect(retrievalResponse.result.evidence).toContainEqual(expect.objectContaining({
      kind: "resource", resource: expect.objectContaining({ resourceId: setup.scopeId, type: "world", objectKind: "domain_root" }),
    }));
    const repository = new GrowthRepository(setup.workspace);
    expect(repository.getCycle(setup.cycleId)).toMatchObject({ status: "running", runId, receiptId: expect.any(String) });
    const receiptId = repository.getCycle(setup.cycleId)!.receiptId!;
    expect(retrievalResponse.result.evidence.map((evidence) => evidence.evidenceId))
      .toEqual(repository.getReceipt(receiptId)!.links.map((link) => link.targetVersionId));

    worker.receive({
      type: "tool.request", runId, requestId: "33333333-3333-4333-8333-333333333333", tool: "propose_change_set",
      args: {
        summary: "补充世界说明",
        items: [{
          id: "new-world", dependsOn: [], kind: "resource.put",
          payload: { resourceId: "world.growth", create: true, type: "world", objectKind: "world", title: "潮汐群岛", parentId: setup.scopeId, state: "active", sortOrder: 0 },
        }],
      },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(4));
    expect(worker.sent[3]).toMatchObject({ type: "tool.response", ok: true, tool: "propose_change_set", result: { status: "committed", mode: "free" } });
    const committed = repository.getCycle(setup.cycleId);
    expect(committed).toMatchObject({ status: "committed", runId, receiptId: expect.any(String), changeSetId: expect.any(String), outputCheckpointId: expect.any(String) });
    expect(repository.listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached", "receipt_recorded", "change_set_committed"]);
    setup.workspace.db.prepare("DELETE FROM growth_events WHERE goal_id = ? AND cycle_id = ? AND phase = 'change_set_committed'").run(setup.goalId, setup.cycleId);
    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("committed");
    expect(repository.listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached", "receipt_recorded", "change_set_committed"]);

    worker.receive({ type: "run.completed", runId, outcome: "completed", message: "已保存。", changeSetState: "committed", artifacts: [] });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", runId })));
    expect(repository.getCycle(setup.cycleId)?.status).toBe("committed");
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM agent_tool_invocations WHERE run_id = ? AND tool_name = 'retrieve_graph_evidence'").get(runId)).toMatchObject({ count: 1 });
  });

  it("rejects a forged Cycle binding before spawning a Worker", () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const spawnWorker = vi.fn(() => worker);
    const supervisor = createSupervisor(setup, worker, spawnWorker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);

    expect(() => lifecycle.start({
      goalId: setup.goalId,
      cycleId: "other-cycle",
      request: { projectId: "project-1", sessionId: "session-1", userInput: "继续", mode: "free" },
      emit: () => undefined,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({ status: "planned", runId: null });
  });

  it("compensates an attach event failure before any Worker can spawn", async () => {
    const setup = createSetup();
    setup.workspace.db.exec("CREATE TRIGGER reject_run_attached BEFORE INSERT ON growth_events WHEN NEW.phase = 'run_attached' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    const worker = new FakeWorker();
    const spawnWorker = vi.fn(() => worker);
    const supervisor = createSupervisor(setup, worker, spawnWorker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const events: unknown[] = [];

    lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "附着失败", mode: "free" }, emit: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "run.failed" })));
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({
      status: "failed", runId: expect.any(String), failureCode: "GROWTH_RUN_ATTACH_FAILED",
    });
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => event.phase)).toEqual(["cycle_terminal"]);
  });

  it("classifies model-supplied inaccessible seeds without exposing retrieval internals", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "种子校验", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    worker.receive({
      type: "tool.request", runId, requestId: "88888888-8888-4888-8888-888888888888", tool: "retrieve_graph_evidence",
      args: { variant: "growth_v1", query: "世界", aliases: [], seedResourceIds: ["not-visible"], maxHops: 0, cpuBudgetMs: 1000, expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1" },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    expect(worker.sent[1]).toMatchObject({ type: "tool.response", ok: false, error: { code: "GROWTH_RETRIEVAL_INPUT_INVALID" } });
    expect(JSON.stringify(worker.sent[1])).not.toContain("not-visible");
  });

  it("classifies Receipt persistence and event reconciliation failures separately", async () => {
    const persistenceSetup = createSetup();
    const persistenceRoot = persistenceSetup.workspace.rootPath;
    const persistenceWorker = new FakeWorker();
    const persistenceSupervisor = createSupervisor(persistenceSetup, persistenceWorker);
    const persistenceRunId = new GrowthRunLifecycle(persistenceSetup.workspace, persistenceSupervisor).start({
      goalId: persistenceSetup.goalId, cycleId: persistenceSetup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "凭证持久化失败", mode: "free" }, emit: () => undefined,
    });
    persistenceWorker.spawn();
    beginStewardInvocation(persistenceSetup.workspace, persistenceRunId);
    persistenceSetup.workspace.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON growth_retrieval_receipts BEGIN SELECT RAISE(FAIL, 'injected'); END");
    requestGrowthRetrieval(persistenceWorker, persistenceRunId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await vi.waitFor(() => expect(persistenceWorker.sent).toHaveLength(2));
    expect(persistenceWorker.sent[1]).toMatchObject({ type: "tool.response", ok: false, error: { code: "GROWTH_PERSISTENCE_FAILED" } });
    expect(new GrowthRepository(persistenceSetup.workspace).getCycle(persistenceSetup.cycleId)).toMatchObject({ status: "failed", failureCode: "GROWTH_PERSISTENCE_FAILED" });
    persistenceSetup.workspace.close();
    fs.rmSync(persistenceRoot, { recursive: true, force: true });

    const reconciliationSetup = createSetup();
    const reconciliationWorker = new FakeWorker();
    const reconciliationSupervisor = createSupervisor(reconciliationSetup, reconciliationWorker);
    const reconciliationLifecycle = new GrowthRunLifecycle(reconciliationSetup.workspace, reconciliationSupervisor);
    const reconciliationRunId = reconciliationLifecycle.start({
      goalId: reconciliationSetup.goalId, cycleId: reconciliationSetup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "事件持久化失败", mode: "free" }, emit: () => undefined,
    });
    reconciliationWorker.spawn();
    beginStewardInvocation(reconciliationSetup.workspace, reconciliationRunId);
    reconciliationSetup.workspace.db.exec("CREATE TRIGGER reject_receipt_event BEFORE INSERT ON growth_events WHEN NEW.phase = 'receipt_recorded' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    requestGrowthRetrieval(reconciliationWorker, reconciliationRunId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await vi.waitFor(() => expect(reconciliationWorker.sent).toHaveLength(2));
    expect(reconciliationWorker.sent[1]).toMatchObject({ type: "tool.response", ok: false, error: { code: "GROWTH_RECONCILIATION_REQUIRED" } });
    expect(new GrowthRepository(reconciliationSetup.workspace).getCycle(reconciliationSetup.cycleId)).toMatchObject({ status: "reconciliation_required" });
  });

  it("returns safe relation endpoints and resource type metadata as Growth graph memory", async () => {
    const setup = createSetup();
    const relation = seedRelationEvidence(setup.workspace, setup.scopeId);
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "关系检索", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    worker.receive({
      type: "tool.request", runId, requestId: "99999999-9999-4999-8999-999999999999", tool: "retrieve_graph_evidence",
      args: { variant: "growth_v1", query: "北港", aliases: ["related_to"], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000, expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1" },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    const response = worker.sent[1] as { ok: boolean; result: { evidence: Array<Record<string, unknown>> } };
    expect(response).toMatchObject({ ok: true });
    expect(response.result.evidence).toContainEqual(expect.objectContaining({
      kind: "relation", relation: { kind: "related_to", sourceResourceId: relation.sourceResourceId, targetResourceId: relation.targetResourceId },
    }));
    expect(response.result.evidence).toContainEqual(expect.objectContaining({
      kind: "resource", resource: expect.objectContaining({ type: "world", objectKind: "location" }),
    }));
    const serialized = JSON.stringify(response.result);
    for (const forbidden of ["stableLocator", "contentHash", "branchId", "checkpointId", setup.workspace.rootPath]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("binds one Run only and terminalizes cancellation without a Change Set", () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "取消前的准备", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();

    expect(() => lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-2", userInput: "重复绑定", mode: "free" }, emit: () => undefined,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));

    supervisor.cancel(runId);
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({
      status: "cancelled", runId, changeSetId: null, outputCheckpointId: null, failureCode: "GROWTH_RUN_CANCELLED",
    });
  });

  it("repairs a missing cancelled terminal event exactly once", () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "取消事件失败", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    setup.workspace.db.exec("CREATE TRIGGER reject_cancel_terminal BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_terminal' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    supervisor.cancel(runId);
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({ status: "cancelled", failureCode: "GROWTH_RUN_CANCELLED" });
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached"]);
    setup.workspace.db.exec("DROP TRIGGER reject_cancel_terminal");
    setup.workspace.db.prepare("UPDATE growth_events SET sequence = 7 WHERE goal_id = ? AND cycle_id = ?").run(setup.goalId, setup.cycleId);

    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("cancelled");
    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("cancelled");
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => [event.phase, event.sequence])).toEqual([["run_attached", 7], ["cycle_terminal", 8]]);
  });

  it("terminalizes a known Worker failure without a Change Set", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "失败路径", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    worker.receive({ type: "run.failed", runId, code: "PROVIDER_RUNTIME_FAILED", message: "Provider failed.", artifacts: [] });

    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({
      status: "failed", runId, changeSetId: null, outputCheckpointId: null, failureCode: "GROWTH_PROVIDER_RUNTIME_FAILED",
    }));
  });

  it("repairs a missing failed terminal event exactly once", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "失败事件失败", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    setup.workspace.db.exec("CREATE TRIGGER reject_failed_terminal BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_terminal' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    worker.receive({ type: "run.failed", runId, code: "PROVIDER_RUNTIME_FAILED", message: "Provider failed.", artifacts: [] });
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)?.status).toBe("failed"));
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached"]);
    setup.workspace.db.exec("DROP TRIGGER reject_failed_terminal");

    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("failed");
    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("failed");
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached", "cycle_terminal"]);
  });

  it("reopens and reconciles an interrupted bound Cycle without starting another Run", () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "恢复边界", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    setup.workspace.close();
    workspace = openWorkspace(root!);
    const resumed = new GrowthRunLifecycle(workspace, supervisor);

    expect(resumed.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId })).toMatchObject({
      status: "reconciliation_required", runId, changeSetId: null, outputCheckpointId: null,
      failureCode: "GROWTH_RUN_INTERRUPTED",
    });
    expect(resumed.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("reconciliation_required");
    expect(new GrowthRepository(workspace).listEvents(setup.goalId).map((event) => event.phase))
      .toEqual(["run_attached", "cycle_terminal"]);
  });

  it("repairs a missing reconciliation terminal event exactly once", () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "中断事件失败", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    setup.workspace.db.exec("CREATE TRIGGER reject_reconciliation_terminal BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_terminal' BEGIN SELECT RAISE(FAIL, 'injected'); END");

    expect(() => lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId })).toThrow();
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({ status: "reconciliation_required", failureCode: "GROWTH_RUN_INTERRUPTED" });
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached"]);
    setup.workspace.db.exec("DROP TRIGGER reject_reconciliation_terminal");

    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("reconciliation_required");
    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("reconciliation_required");
    expect(new GrowthRepository(setup.workspace).listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached", "cycle_terminal"]);
  });

  it("terminalizes a non-committed Cycle as blocked without binding a pending Change Set", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "提出候选", mode: "assist" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    worker.receive({
      type: "tool.request", runId, requestId: "44444444-4444-4444-8444-444444444444", tool: "retrieve_graph_evidence",
      args: { variant: "growth_v1", query: "世界", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000, expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1" },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    expect(worker.sent[1]).toMatchObject({ type: "tool.response", ok: true, result: { variant: "growth_v1", receiptRecorded: true } });
    worker.receive({
      type: "tool.request", runId, requestId: "55555555-5555-4555-8555-555555555555", tool: "propose_change_set",
      args: { summary: "候选设定", items: [{ id: "pending-document", dependsOn: [], kind: "document.put", payload: { resourceId: setup.scopeId, content: "待确认的候选。" } }] },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(3));
    if (!(worker.sent[2] as { ok?: boolean }).ok) throw new Error(JSON.stringify(worker.sent[2]));
    expect(worker.sent[2]).toMatchObject({ type: "tool.response", ok: true, result: { status: "pending" } });
    worker.receive({ type: "run.completed", runId, outcome: "awaiting_confirmation", message: "等待确认。", changeSetState: "pending_review", artifacts: [] });
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)?.status).toBe("blocked"));
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({ changeSetId: null, outputCheckpointId: null, failureCode: "GROWTH_CHANGE_SET_NOT_COMMITTED" });
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-run-bridge-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const roots = new ResourceRepository(workspace).listCurrent().filter((resource) => resource.objectKind === "domain_root");
  const scopeId = roots.find((resource) => resource.type === "world")!.id;
  const authorizedScopeResourceIds = roots.filter((resource) => ["world", "oc", "story"].includes(resource.type)).map((resource) => resource.id);
  const repository = new GrowthRepository(workspace);
  const goal = repository.createGoal({
    id: "growth-goal", idempotencyKey: "growth-goal-key", branchId: branch.id,
    seed: { kind: "text", text: "从海岸传说开始" }, authorizedScopeResourceIds, initialRuleText: "保留来源", sourceMessageId: null,
  });
  const cycle = repository.beginCycle({ id: "growth-cycle", goalId: goal.id, idempotencyKey: "growth-cycle-key", inputCheckpointId: branch.headCheckpointId, ruleRevision: goal.currentRuleRevision });
  return { workspace, goalId: goal.id, cycleId: cycle.id, scopeId, authorizedScopeResourceIds };
}

function createSourceDocumentSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-source-seed-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const roots = new ResourceRepository(workspace).listCurrent().filter((resource) => resource.objectKind === "domain_root");
  const scopeId = roots.find((resource) => resource.type === "world")!.id;
  const authorizedScopeResourceIds = roots.filter((resource) => ["world", "oc", "story"].includes(resource.type)).map((resource) => resource.id);
  new ResourceRepository(workspace).putRevision({
    resourceId: "source-world", create: true, checkpointId: branch.headCheckpointId,
    type: "world", objectKind: "world", title: "Source world", parentId: scopeId, state: "active", sortOrder: 0,
  });
  const documentId = "source-document";
  new CreativeDocumentRepository(workspace).putRevisionWithReceipt({
    documentId, create: true, checkpointId: branch.headCheckpointId, resourceId: "source-world",
    kind: "setting", title: "Source setting", state: "active",
  });
  const sourceVersionId = new DocumentRepository(workspace).putVersion({
    resourceId: "source-world", creativeDocumentId: documentId, checkpointId: branch.headCheckpointId,
    content: "source document content", authorKind: "user",
  });
  const repository = new GrowthRepository(workspace);
  const goal = repository.createGoal({
    id: "source-goal", idempotencyKey: "source-goal-key", branchId: branch.id,
    seed: { kind: "source_document", sourceDocumentId: documentId, sourceVersionId },
    authorizedScopeResourceIds, initialRuleText: "Keep sources.", sourceMessageId: null,
  });
  const cycle = repository.beginCycle({
    id: "source-cycle", goalId: goal.id, idempotencyKey: "source-cycle-key",
    inputCheckpointId: branch.headCheckpointId, ruleRevision: goal.currentRuleRevision,
  });
  return { workspace, goalId: goal.id, cycleId: cycle.id, scopeId, authorizedScopeResourceIds };
}

function createSupervisor(
  setup: ReturnType<typeof createSetup>,
  worker: FakeWorker,
  spawnWorker: (() => FakeWorker) | undefined = undefined,
  gatewayOverrides: Record<string, unknown> = {},
) {
  const policy: ChangeSetPolicyEvaluator = { assess: (candidate) => candidate.items.map((item) => ({ itemId: item.id, risk: "low" as const, conflicts: [] })) };
  const gateway = { ...createWorkspaceAgentToolGateway(setup.workspace, policy, () => true), ...gatewayOverrides };
  return new AgentProcessSupervisor("worker.js", {
    acquireRuntimeLease: (): AgentRuntimeLease => ({
      gateway,
      audit: new AgentAuditRepository(setup.workspace),
      authorizedScopeResourceIds: setup.authorizedScopeResourceIds,
      defaultScopeResourceIds: setup.authorizedScopeResourceIds,
      release: () => undefined,
    }),
    spawnWorker: spawnWorker ?? (() => worker),
  });
}

function beginStewardInvocation(workspace: WorkspaceDatabase, runId: string): void {
  const hash = "a".repeat(64);
  new AgentAuditRepository(workspace).beginInvocation({
    invocationId: `${runId}:steward`, runId, parentInvocationId: null, role: "steward",
    promptId: "novax.steward", promptVersion: "1.12.0", promptSha256: hash,
    agentProfileId: "novax.steward", agentProfileVersion: "1.12.0", agentProfileSha256: hash,
    providerId: "provider", requestedModelId: "model", providerConfigSha256: hash,
    toolPolicyId: "novax.steward.tools", toolPolicyVersion: "1.0.0", toolPolicySha256: hash,
    authorizedTools: ["retrieve_graph_evidence", "propose_change_set"],
    handoffContractId: null, handoffVersion: null, handoffPayloadSha256: null, inputSha256: hash,
  });
}

function seedRelationEvidence(workspace: WorkspaceDatabase, worldRootId: string): { sourceResourceId: string; targetResourceId: string } {
  const checkpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
  const resources = new ResourceRepository(workspace);
  resources.putRevision({
    resourceId: "world.seed", create: true, checkpointId, type: "world", objectKind: "world",
    title: "潮汐世界", parentId: worldRootId, state: "active", sortOrder: 0,
  });
  resources.putRevision({
    resourceId: "location.alpha", create: true, checkpointId, type: "world", objectKind: "location",
    title: "北港", parentId: "world.seed", state: "active", sortOrder: 0,
  });
  resources.putRevision({
    resourceId: "location.beta", create: true, checkpointId, type: "world", objectKind: "location",
    title: "南港", parentId: "world.seed", state: "active", sortOrder: 1,
  });
  new CreativeRelationRepository(workspace).putRevision({
    relationId: "relation.alpha-beta", create: true, checkpointId, kind: "related_to",
    sourceResourceId: "location.alpha", targetResourceId: "location.beta", state: "active",
  });
  return { sourceResourceId: "location.alpha", targetResourceId: "location.beta" };
}

function requestGrowthRetrieval(worker: FakeWorker, runId: string, requestId: string): void {
  worker.receive({
    type: "tool.request", runId, requestId, tool: "retrieve_graph_evidence",
    args: {
      variant: "growth_v1", query: "世界", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000,
      expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1",
    },
  });
}
