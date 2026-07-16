import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { GROWTH_CLOSURE_FACETS } from "../../src/domain/growth/growthClosureEvaluator";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { ConstraintProfileRepository } from "../../src/domain/workspace/constraintProfileRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AgentProcessSupervisor, type AgentRuntimeLease, type AgentWorkerProcess } from "../../src/main/agentProcessSupervisor";
import { GrowthRunLifecycle, safeFailureCode } from "../../src/main/growthRunLifecycle";
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
    expect((emptyWorker.sent[0] as { growthBinding: { kind: string; focusKinds: string[] } }).growthBinding)
      .toMatchObject({ kind: "expand", focusKinds: ["world"] });
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

  it("rejects a manually persisted multi-focus expand intent before Worker spawn or Change Set creation", () => {
    const setup = createSetup(["world", "story"]);
    const spawn = vi.fn(() => new FakeWorker());
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, new FakeWorker(), spawn));

    expect(() => lifecycle.start({
      goalId: setup.goalId,
      cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "multi-focus", userInput: "invalid multi focus", mode: "free" },
      emit: () => undefined,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
    expect(spawn).not.toHaveBeenCalled();
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({
      status: "planned", runId: null, changeSetId: null, outputCheckpointId: null,
    });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual({ count: 0 });
  });

  it("starts a planned Cycle with its pinned historical rule after a newer revision is appended", async () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    repository.appendRule({
      goalId: setup.goalId,
      expectedRevision: 1,
      ruleText: "use from the next Cycle",
      sourceMessageId: "message-rule-2",
    });
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);

    const runId = new GrowthRunLifecycle(setup.workspace, supervisor).start({
      goalId: setup.goalId,
      cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "continue pinned Cycle", mode: "free" },
      emit: () => undefined,
    });
    worker.spawn();

    expect((worker.sent[0] as { growthBinding: { ruleRevision: number } }).growthBinding.ruleRevision).toBe(1);
    expect(repository.getGoal(setup.goalId)?.currentRuleRevision).toBe(2);
    expect(repository.getCycle(setup.cycleId)?.ruleRevision).toBe(1);
    supervisor.cancel(runId);
    await vi.waitFor(() => expect(repository.getCycle(setup.cycleId)?.status).toBe("cancelled"));
  });

  it("starts sequence 4 from persisted expand intent without deriving a phase", async () => {
    const setup = createSetup();
    const world = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "sequence4-world");
    const growth = new GrowthRepository(setup.workspace);
    const storyRoot = setup.authorizedScopeResourceIds.find((id) => new ResourceRepository(setup.workspace).listAtCheckpoint(world.outputCheckpointId).find((resource) => resource.id === id)?.type === "story")!;
    const cycle2 = growth.beginCycle({ id: "sequence4-cycle-2", goalId: setup.goalId, idempotencyKey: "sequence4-cycle-2", inputCheckpointId: world.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] } });
    const story = await commitPriorResourceCycle(setup, cycle2.id, "story", "story", storyRoot, "sequence4-story");
    const ocRoot = setup.authorizedScopeResourceIds.find((id) => new ResourceRepository(setup.workspace).listAtCheckpoint(story.outputCheckpointId).find((resource) => resource.id === id)?.type === "oc")!;
    const cycle3 = growth.beginCycle({ id: "sequence4-cycle-3", goalId: setup.goalId, idempotencyKey: "sequence4-cycle-3", inputCheckpointId: story.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["oc"], resumeFrontier: [] } });
    const oc = await commitPriorResourceCycle(setup, cycle3.id, "oc", "oc", ocRoot, "sequence4-oc");
    const cycle4 = growth.beginCycle({ id: "sequence4-cycle-4", goalId: setup.goalId, idempotencyKey: "sequence4-cycle-4", inputCheckpointId: oc.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: [] } });
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const runId = new GrowthRunLifecycle(setup.workspace, supervisor).start({ goalId: setup.goalId, cycleId: cycle4.id, request: { projectId: "project-1", sessionId: "sequence-4", userInput: "continue", mode: "free" }, emit: () => undefined });
    worker.spawn();
    expect((worker.sent[0] as { growthBinding: { kind: string; focusKinds: string[] } }).growthBinding)
      .toMatchObject({ kind: "expand", focusKinds: ["world"] });
    supervisor.cancel(runId);
    await vi.waitFor(() => expect(growth.getCycle(cycle4.id)?.status).toBe("cancelled"));
  });

  it("derives Longform outline authority from the pinned checkpoint before Worker spawn", async () => {
    const setup = createSetup();
    const world = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "longform-world");
    const growth = new GrowthRepository(setup.workspace);
    const storyRoot = setup.authorizedScopeResourceIds.find((id) => new ResourceRepository(setup.workspace)
      .listAtCheckpoint(world.outputCheckpointId).some((resource) => resource.id === id && resource.type === "story"))!;
    const storyCycle = growth.beginCycle({
      id: "longform-story-cycle", goalId: setup.goalId, idempotencyKey: "longform-story-cycle",
      inputCheckpointId: world.outputCheckpointId, ruleRevision: 1,
      intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] },
    });
    const story = await commitPriorResourceCycle(setup, storyCycle.id, "story", "story", storyRoot, "longform-story");
    const ocRoot = setup.authorizedScopeResourceIds.find((id) => new ResourceRepository(setup.workspace)
      .listAtCheckpoint(story.outputCheckpointId).some((resource) => resource.id === id && resource.type === "oc"))!;
    const ocCycle = growth.beginCycle({
      id: "longform-oc-cycle", goalId: setup.goalId, idempotencyKey: "longform-oc-cycle",
      inputCheckpointId: story.outputCheckpointId, ruleRevision: 1,
      intent: { kind: "expand", focusKinds: ["oc"], resumeFrontier: [] },
    });
    const oc = await commitPriorResourceCycle(setup, ocCycle.id, "oc", "oc", ocRoot, "longform-oc");
    growth.createClosureProfile({
      id: "longform-profile", idempotencyKey: "longform-profile-key", goalId: setup.goalId,
      profileKind: "mixed_birth", subjectResourceId: null,
      componentProfiles: ["world_birth", "story_universe", "oc_saga"], focusOcResourceId: oc.resourceId,
      contractGeneration: "v26", checkpointId: oc.outputCheckpointId, ruleRevision: 1,
      facets: [
        { id: GROWTH_CLOSURE_FACETS.oc.personalStoryBinding, kind: "content", required: true },
        { id: GROWTH_CLOSURE_FACETS.oc.personalStory, kind: "content", required: true },
      ],
    });
    const outlineCycle = growth.beginCycle({
      id: "longform-outline-cycle", goalId: setup.goalId, idempotencyKey: "longform-outline-cycle",
      inputCheckpointId: oc.outputCheckpointId, ruleRevision: 1,
      intent: { kind: "expand", focusKinds: ["oc"], resumeFrontier: [] },
    });
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const runId = new GrowthRunLifecycle(setup.workspace, supervisor).start({
      goalId: setup.goalId, cycleId: outlineCycle.id,
      request: { projectId: "project-1", sessionId: "longform-outline", userInput: "create personal saga", mode: "free" },
      emit: () => undefined,
    });
    worker.spawn();
    const binding = (worker.sent[0] as { growthBinding: { longformAuthority: Record<string, unknown> } }).growthBinding;
    expect(binding.longformAuthority).toMatchObject({
      phase: "outline", mainStoryResourceId: story.resourceId, focusOcResourceId: oc.resourceId,
    });
    expect(binding.longformAuthority).not.toHaveProperty("checkpointId");
    supervisor.cancel(runId);
    await vi.waitFor(() => expect(growth.getCycle(outlineCycle.id)?.status).toBe("cancelled"));
  });

  it("binds a newer rule to one evidence-pinned revision Cycle and rejects out-of-receipt targets", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "revision-world");
    const growth = new GrowthRepository(setup.workspace);
    const priorResourceVersionId = (setup.workspace.db.prepare(`
      SELECT id FROM resource_revisions WHERE resource_id = ? AND created_checkpoint_id = ?
    `).get(prior.resourceId, prior.outputCheckpointId) as { id: string }).id;
    const unrelatedResourceId = setup.authorizedScopeResourceIds.find((resourceId) => resourceId !== setup.scopeId)!;
    const unrelatedResourceVersionId = (setup.workspace.db.prepare(`
      SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(unrelatedResourceId) as { id: string }).id;
    const visualRequest = growth.createIllustrationRequest({
      id: "revision-visual-request", goalId: setup.goalId, cycleId: setup.cycleId, ruleRevision: 1,
      coverageMode: "custom", closureProfileId: null, closureRevision: null,
      idempotencyKey: "revision-visual-request-key",
    });
    growth.sealIllustrationBatch({
      id: "revision-visual-batch", requestId: visualRequest.id, sequence: 1, cursor: null, nextCursor: null,
      idempotencyKey: "revision-visual-batch-key", snapshots: [],
      items: [{
        id: "revision-affected-visual", purpose: "scene", title: "Affected visual", variantKey: "affected",
        compiledPromptSha256: "e".repeat(64), requiredForVisualClosure: false,
        anchor: { kind: "resource", resourceId: prior.resourceId, resourceVersionId: priorResourceVersionId },
        sources: [{ kind: "resource", resourceId: prior.resourceId, resourceVersionId: priorResourceVersionId }],
      }, {
        id: "revision-unrelated-visual", purpose: "scene", title: "Unrelated visual", variantKey: "unrelated",
        compiledPromptSha256: "f".repeat(64), requiredForVisualClosure: false,
        anchor: { kind: "resource", resourceId: unrelatedResourceId, resourceVersionId: unrelatedResourceVersionId },
        sources: [{ kind: "resource", resourceId: unrelatedResourceId, resourceVersionId: unrelatedResourceVersionId }],
      }],
    });
    growth.appendRule({ goalId: setup.goalId, expectedRevision: 1, ruleText: "revision two", sourceMessageId: "revision-two" });
    const revision = growth.beginCycle({ id: "revision-cycle", goalId: setup.goalId, idempotencyKey: "revision-cycle", inputCheckpointId: prior.outputCheckpointId, ruleRevision: 2, intent: { kind: "revision", focusKinds: ["world"], resumeFrontier: ["story", "oc"] } });
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const runId = new GrowthRunLifecycle(setup.workspace, supervisor).start({
      goalId: setup.goalId, cycleId: revision.id,
      request: { projectId: "project-1", sessionId: "revision", userInput: "revise", mode: "free" },
      emit: () => undefined,
    });
    worker.spawn();
    const command = worker.sent[0] as { growthBinding: { kind: string; ruleRevision: number; greenfieldCreateAuthorized: boolean } };
    expect(command.growthBinding).toMatchObject({ kind: "revision", ruleRevision: 2, greenfieldCreateAuthorized: false });
    worker.receive({ type: "run.started", runId });
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, "11111111-1111-4111-8111-111111111111", "revision world", 10);
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    const retrieval = (worker.sent[1] as {
      ok: true;
      result: { evidence: Array<{ evidenceId: string }>; revisionAuthority: { targets: Array<Record<string, unknown>> } };
    }).result;
    const target = retrieval.revisionAuthority.targets.find((candidate) => candidate.kind === "resource") as {
      evidenceId: string; resourceId: string; type: string; objectKind: string; parentId: string; sortOrder: number;
    };
    worker.receive({
      type: "tool.request", runId, requestId: "22222222-2222-4222-8222-222222222222",
      tool: "submit_growth_inquiry",
      args: {
        inquiries: [3, 2, 1].map((priority, index) => ({
          localId: `revision_${index}`, question: `What changes at priority ${priority}?`,
          evidenceIds: [target.evidenceId], evidenceState: "known",
          safeSummary: `Assessing revision impact ${index}.`, proposedAction: "Apply one bounded revision.",
          provisionalAssumption: null, priority, requiresCreatorChoice: false,
        })),
        selectedLocalId: "revision_0", priorTransitions: [],
      },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(3));

    worker.receive({
      type: "tool.request", runId, requestId: "33333333-3333-4333-8333-333333333333",
      tool: "propose_change_set",
      args: { summary: "forged", items: [{
        id: "forged", dependsOn: [], kind: "resource.put",
        payload: { resourceId: "outside-receipt", create: false, type: "world", objectKind: "world", title: "forged", parentId: target.parentId, state: "active", sortOrder: 0 },
      }] },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(4));
    expect(worker.sent[3]).toMatchObject({ ok: false, error: { code: "GROWTH_BINDING_INVALID" } });

    worker.receive({
      type: "tool.request", runId, requestId: "44444444-4444-4444-8444-444444444444",
      tool: "propose_change_set",
      args: { summary: "Apply revision two", growthRevisionImpact: {
        revisedEvidenceIds: [target.evidenceId], preservedEvidenceIds: [], staleVisualEvidenceIds: [target.evidenceId],
      }, items: [{
        id: "revision-resource", dependsOn: [], kind: "resource.put",
        payload: {
          resourceId: target.resourceId, create: false, type: target.type, objectKind: target.objectKind,
          title: "Revised world", parentId: target.parentId, state: "active", sortOrder: target.sortOrder,
        },
      }] },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(5));
    expect(worker.sent[4]).toMatchObject({ ok: true, result: { status: "committed" } });
    worker.receive({ type: "run.completed", runId, outcome: "completed", message: "done", changeSetState: "committed", artifacts: [] });
    await vi.waitFor(() => expect(growth.getCycle(revision.id)?.status).toBe("committed"));
    expect(growth.getCycle(revision.id)).toMatchObject({
      ruleRevision: 2, inputCheckpointId: prior.outputCheckpointId,
      receiptId: expect.any(String), changeSetId: expect.any(String), outputCheckpointId: expect.any(String),
    });
    expect(growth.getCycle(revision.id)!.outputCheckpointId).not.toBe(prior.outputCheckpointId);
    expect(growth.getIllustrationItem("revision-affected-visual")?.status).toBe("stale");
    expect(growth.getIllustrationItem("revision-unrelated-visual")?.status).toBe("planned");
  });

  it("records a missing deterministic Closure facet as a durable continue-growing evaluation", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "closure-world");
    const growth = new GrowthRepository(setup.workspace);
    const profile = growth.createClosureProfile({
      id: "closure-profile", idempotencyKey: "closure-profile-key", goalId: setup.goalId,
      profileKind: "world_birth", subjectResourceId: null, componentProfiles: [], focusOcResourceId: null,
      contractGeneration: "v26", checkpointId: prior.outputCheckpointId, ruleRevision: 1,
      facets: [{ id: GROWTH_CLOSURE_FACETS.world.setting, kind: "content", required: true }],
    });
    const evaluation = growth.beginCycle({
      id: "closure-evaluation-cycle", goalId: setup.goalId, idempotencyKey: "closure-evaluation-cycle-key",
      inputCheckpointId: prior.outputCheckpointId, ruleRevision: 1,
      intent: { kind: "closure_evaluation", profileId: profile.id, revision: 1, checkpointId: prior.outputCheckpointId },
    });
    const worker = new FakeWorker();
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker));
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: evaluation.id,
      request: { projectId: "project-1", sessionId: "closure-evaluation", userInput: "evaluate closure", mode: "free" },
      emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID(), "closure-world", 20);
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
      ok: true, tool: "retrieve_graph_evidence",
      result: { closureEvaluation: { deterministicContentReady: false } },
    }));
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_self_assessment",
      args: { decision: "continue_growing", safeSummary: "The setting facet is still missing." },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
      ok: true, tool: "submit_closure_self_assessment", result: { status: "continue_growing" },
    }));
    terminalizeInvocation(setup.workspace, runId, `${runId}:steward`, "steward-output");
    worker.receive({ type: "run.completed", runId, outcome: "completed", message: "evaluated", changeSetState: "none", artifacts: [] });

    await vi.waitFor(() => expect(growth.getCycle(evaluation.id)).toMatchObject({
      status: "evaluated", runId, receiptId: expect.any(String), changeSetId: null,
      outputCheckpointId: null, failureCode: null,
    }));
    expect(setup.workspace.db.prepare("SELECT decision FROM growth_closure_evaluation_outcomes WHERE cycle_id = ?").get(evaluation.id))
      .toEqual({ decision: "continue_growing" });
    expect(setup.workspace.db.prepare("SELECT role, decision FROM growth_closure_assessments WHERE cycle_id = ?").all(evaluation.id))
      .toEqual([{ role: "steward", decision: "continue_growing" }]);
    expect(growth.listEvents(setup.goalId).filter((event) => event.cycleId === evaluation.id && event.phase === "cycle_evaluated"))
      .toHaveLength(1);
    setup.workspace.db.prepare("DELETE FROM growth_events WHERE cycle_id = ? AND phase = 'cycle_evaluated'").run(evaluation.id);
    lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: evaluation.id });
    lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: evaluation.id });
    expect(growth.listEvents(setup.goalId).filter((event) => event.cycleId === evaluation.id && event.phase === "cycle_evaluated"))
      .toHaveLength(1);
  });

  it("seals an accepted Closure outcome from distinct Steward and Checker invocation terminals", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "closure-ready-world");
    const { growth, evaluation } = createClosureEvaluation(setup, prior.outputCheckpointId, GROWTH_CLOSURE_FACETS.world.resource, "ready");
    const worker = new FakeWorker();
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker));
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: evaluation.id,
      request: { projectId: "project-1", sessionId: "closure-ready", userInput: "evaluate closure", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID(), "unrelated-model-wording", 20);
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
      ok: true, result: { closureEvaluation: { deterministicContentReady: true } },
    }));
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_self_assessment",
      args: { decision: "ready_for_checker", safeSummary: "Pinned structure is ready for independent review." },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
      ok: true, result: { status: "checker_required", deterministicContentReady: true },
    }));
    const checkerInvocationId = beginCheckerInvocation(setup.workspace, runId);
    terminalizeInvocation(setup.workspace, runId, checkerInvocationId, "checker-output");
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_checker_review",
      args: { decision: "accepted", adverseFindings: [] },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
      ok: true, result: { status: "recorded", decision: "accepted" },
    }));
    terminalizeInvocation(setup.workspace, runId, `${runId}:steward`, "steward-output");
    worker.receive({ type: "run.completed", runId, outcome: "completed", message: "evaluated", changeSetState: "none", artifacts: [] });

    await vi.waitFor(() => expect(growth.getCycle(evaluation.id)?.status).toBe("evaluated"));
    expect(setup.workspace.db.prepare("SELECT decision FROM growth_closure_evaluation_outcomes WHERE cycle_id = ?").get(evaluation.id))
      .toEqual({ decision: "accepted" });
    expect(setup.workspace.db.prepare("SELECT role, agent_invocation_id, output_sha256 FROM growth_closure_assessments WHERE cycle_id = ? ORDER BY role").all(evaluation.id))
      .toEqual([
        { role: "checker", agent_invocation_id: checkerInvocationId, output_sha256: hashText("checker-output") },
        { role: "steward", agent_invocation_id: `${runId}:steward`, output_sha256: hashText("steward-output") },
      ]);
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_reviews").get()).toEqual({ count: 1 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual({ count: 1 });
  });

  it("marks a partially persisted Closure evaluation for reconciliation instead of fabricating an outcome", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "closure-reconcile-world");
    const { growth, evaluation } = createClosureEvaluation(setup, prior.outputCheckpointId, GROWTH_CLOSURE_FACETS.world.resource, "reconcile");
    const worker = new FakeWorker();
    const runId = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker)).start({
      goalId: setup.goalId, cycleId: evaluation.id,
      request: { projectId: "project-1", sessionId: "closure-reconcile", userInput: "evaluate closure", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID(), "closure-reconcile-world", 20);
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({ ok: true }));
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_self_assessment",
      args: { decision: "ready_for_checker", safeSummary: "Ready." },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({ ok: true, result: { status: "checker_required" } }));
    const checkerInvocationId = beginCheckerInvocation(setup.workspace, runId);
    terminalizeInvocation(setup.workspace, runId, checkerInvocationId, "checker-reconcile-output");
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_checker_review",
      args: { decision: "accepted", adverseFindings: [] },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({ ok: true, result: { status: "recorded" } }));
    terminalizeInvocation(setup.workspace, runId, `${runId}:steward`, "steward-reconcile-output");
    setup.workspace.db.exec(`
      CREATE TEMP TRIGGER reject_runtime_closure_review BEFORE INSERT ON growth_closure_reviews
      BEGIN SELECT RAISE(ABORT, 'injected closure review failure'); END;
    `);
    worker.receive({ type: "run.completed", runId, outcome: "completed", message: "evaluated", changeSetState: "none", artifacts: [] });

    await vi.waitFor(() => expect(growth.getCycle(evaluation.id)).toMatchObject({
      status: "reconciliation_required", failureCode: "GROWTH_CLOSURE_OUTCOME_UNKNOWN",
      changeSetId: null, outputCheckpointId: null,
    }));
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_assessments WHERE cycle_id = ?").get(evaluation.id))
      .toEqual({ count: 2 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_reviews").get()).toEqual({ count: 0 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_evaluation_outcomes").get()).toEqual({ count: 0 });
    expect(growth.listEvents(setup.goalId).filter((event) => event.cycleId === evaluation.id && event.phase === "cycle_terminal"))
      .toHaveLength(1);
  });

  it("rejects Checker findings that cite evidence outside the pinned Closure projection", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "closure-forged-world");
    const { evaluation } = createClosureEvaluation(setup, prior.outputCheckpointId, GROWTH_CLOSURE_FACETS.world.resource, "forged");
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const runId = new GrowthRunLifecycle(setup.workspace, supervisor).start({
      goalId: setup.goalId, cycleId: evaluation.id,
      request: { projectId: "project-1", sessionId: "closure-forged", userInput: "evaluate closure", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID(), "closure-forged-world", 20);
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({ ok: true }));
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_self_assessment",
      args: { decision: "ready_for_checker", safeSummary: "Ready." },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({ ok: true, result: { status: "checker_required" } }));
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_closure_checker_review",
      args: { decision: "blocked", adverseFindings: [{
        localId: "forged", severity: "blocking", category: "scope_violation", evidenceIds: ["not-pinned"],
        safeSummary: "Forged evidence.", repairObjective: "Do not trust this finding.",
      }] },
    });
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
      ok: false, error: { code: "GROWTH_CLOSURE_SUBMISSION_INVALID" },
    }));
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_assessments WHERE cycle_id = ?").get(evaluation.id))
      .toEqual({ count: 0 });
    supervisor.cancel(runId);
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(evaluation.id)?.status).toBe("cancelled"));
  });

  it("binds one evidence-pinned Closure repair Run and commits exactly one Change Set", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(
      setup, setup.cycleId, "world", "world", setup.scopeId, "closure-repair-world",
    );
    const unrelatedLocationId = "repair-unrelated-location";
    const unrelatedDocumentId = "repair-unrelated-document";
    const unrelatedAssertionId = "repair-unrelated-assertion";
    const unrelatedProfileId = "repair-unrelated-profile";
    new ResourceRepository(setup.workspace).putRevision({
      resourceId: unrelatedLocationId, create: true, checkpointId: prior.outputCheckpointId,
      type: "world", objectKind: "location", title: "Unrelated harbor", parentId: prior.resourceId,
      state: "active", sortOrder: 1,
    });
    new CreativeDocumentRepository(setup.workspace).putRevision({
      documentId: unrelatedDocumentId, create: true, checkpointId: prior.outputCheckpointId,
      resourceId: unrelatedLocationId, kind: "location_profile", title: "Unrelated harbor profile",
      state: "active", sortOrder: 0,
    });
    const unrelatedDocumentVersionId = new DocumentRepository(setup.workspace).putVersion({
      resourceId: unrelatedLocationId, creativeDocumentId: unrelatedDocumentId,
      checkpointId: prior.outputCheckpointId, content: "This location is outside the selected repair target.",
      authorKind: "agent",
    });
    new AssertionRepository(setup.workspace).putVersion({
      assertionId: unrelatedAssertionId, checkpointId: prior.outputCheckpointId,
      scopeType: "location", scopeId: unrelatedLocationId, subject: unrelatedLocationId,
      predicate: "closure.world.fact.geography_environment", object: { status: "unrelated" },
      status: "current", source: { kind: "document_version", ref: unrelatedDocumentVersionId },
    });
    new ConstraintProfileRepository(setup.workspace).putVersion({
      profileId: unrelatedProfileId, create: true, checkpointId: prior.outputCheckpointId,
      scopeResourceId: unrelatedLocationId, title: "Unrelated constraints",
      payload: {
        narrativePerson: null, tense: null, tone: null, pacing: null, humorLevel: null,
        prohibitedContent: [], requiredContent: [], notes: "Unrelated scope.",
      },
      state: "active", authorKind: "agent",
    });
    const { growth, profile, evaluation } = createClosureEvaluation(
      setup, prior.outputCheckpointId, [
        GROWTH_CLOSURE_FACETS.world.resource,
        GROWTH_CLOSURE_FACETS.world.location,
      ], "repair",
    );
    const evaluationWorker = new FakeWorker();
    const evaluationLifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, evaluationWorker));
    const evaluationRunId = evaluationLifecycle.start({
      goalId: setup.goalId, cycleId: evaluation.id,
      request: {
        projectId: "project-1", sessionId: "closure-repair-evaluation",
        userInput: "evaluate repair boundary", mode: "free",
      },
      emit: () => undefined,
    });
    evaluationWorker.spawn();
    beginStewardInvocation(setup.workspace, evaluationRunId);
    requestGrowthRetrieval(evaluationWorker, evaluationRunId, randomUUID(), "closure-repair-world", 20);
    await vi.waitFor(() => expect(evaluationWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { closureEvaluation: { deterministicContentReady: true } },
    }));
    const retrieval = evaluationWorker.sent.at(-1) as {
      result: {
        evidence: Array<{ evidenceId: string }>;
        closureEvaluation: { facetResults: Array<{ facetId: string; evidenceIds: string[] }> };
      };
    };
    expect(retrieval.result.evidence).not.toHaveLength(0);
    const targetEvidenceId = retrieval.result.closureEvaluation.facetResults
      .find((facet) => facet.facetId === GROWTH_CLOSURE_FACETS.world.resource)!.evidenceIds[0]!;
    const locationEvidenceId = retrieval.result.closureEvaluation.facetResults
      .find((facet) => facet.facetId === GROWTH_CLOSURE_FACETS.world.location)!.evidenceIds[0]!;
    evaluationWorker.receive({
      type: "tool.request", runId: evaluationRunId, requestId: randomUUID(),
      tool: "submit_closure_self_assessment",
      args: { decision: "ready_for_checker", safeSummary: "The world exists and needs one bounded correction." },
    });
    await vi.waitFor(() => expect(evaluationWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { status: "checker_required" },
    }));
    const checkerInvocationId = beginCheckerInvocation(setup.workspace, evaluationRunId);
    terminalizeInvocation(setup.workspace, evaluationRunId, checkerInvocationId, "checker-repair-output");
    evaluationWorker.receive({
      type: "tool.request", runId: evaluationRunId, requestId: randomUUID(),
      tool: "submit_closure_checker_review",
      args: {
        decision: "repairs_required",
        adverseFindings: [{
          localId: "repair-world-title", severity: "major", category: "world_consistency",
          evidenceIds: [targetEvidenceId, locationEvidenceId], safeSummary: "The world title is generic and its selected harbor lacks a relation.",
          repairObjective: "Rename the selected world and connect only the selected harbor.",
        }],
      },
    });
    await vi.waitFor(() => expect(evaluationWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { status: "recorded", decision: "repairs_required" },
    }));
    terminalizeInvocation(setup.workspace, evaluationRunId, `${evaluationRunId}:steward`, "steward-repair-output");
    evaluationWorker.receive({
      type: "run.completed", runId: evaluationRunId, outcome: "completed",
      message: "evaluated", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(growth.getCycle(evaluation.id)?.status).toBe("evaluated"));

    const outcome = growth.getClosureEvaluationOutcomeForCycle(evaluation.id)!;
    const review = growth.getClosureReviewV4(outcome.reviewId!)!;
    const finding = review.adverseFindings[0]!;
    const repairCycle = growth.beginCycle({
      id: "closure-repair-cycle", goalId: setup.goalId, idempotencyKey: "closure-repair-cycle-key",
      inputCheckpointId: prior.outputCheckpointId, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: profile.id, revision: 1, originalReviewId: review.id,
        selectedFindingId: finding.id, selectedFindingFingerprint: finding.fingerprint,
      },
    });
    const lineage = growth.createClosureRepairLineage({
      id: "closure-repair-lineage", profileId: profile.id, revision: 1, originalReviewId: review.id,
      selectedFindingId: finding.id, selectedFindingFingerprint: finding.fingerprint,
      repairCycleId: repairCycle.id, backlogFindingIds: [], idempotencyKey: "closure-repair-lineage-key",
    });
    const repairWorker = new FakeWorker();
    const repairLifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, repairWorker));
    const repairRunId = repairLifecycle.start({
      goalId: setup.goalId, cycleId: repairCycle.id,
      request: {
        projectId: "project-1", sessionId: "closure-repair-run",
        userInput: "apply bounded repair", mode: "free",
      },
      emit: () => undefined,
    });
    repairWorker.spawn();
    const repairCommand = repairWorker.sent[0] as {
      growthBinding: {
        kind: string;
        closureProfile: null;
        closureRepair: { repairObjective: string; targetEvidenceIds: string[] };
      };
    };
    expect(repairCommand.growthBinding).toMatchObject({
      kind: "repair", closureProfile: null,
      closureRepair: {
        repairObjective: "Rename the selected world and connect only the selected harbor.",
        targetEvidenceIds: [targetEvidenceId, locationEvidenceId],
      },
    });
    beginStewardInvocation(setup.workspace, repairRunId);
    requestGrowthRetrieval(repairWorker, repairRunId, randomUUID(), "bounded repair", 1);
    await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { evidence: expect.arrayContaining([
        expect.objectContaining({ evidenceId: targetEvidenceId }),
        expect.objectContaining({ evidenceId: locationEvidenceId }),
      ]) },
    }));
    const changeSetsBeforeRejectedProposal = setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get();
    repairWorker.receive({
      type: "tool.request", runId: repairRunId, requestId: randomUUID(), tool: "propose_change_set",
      args: {
        summary: "Attempt to mutate an unrelated resource.",
        items: [{
          id: "repair-unrelated-root", dependsOn: [], kind: "resource.put",
          payload: {
            resourceId: setup.scopeId, create: false, type: "world", objectKind: "domain_root",
            title: "Forbidden unrelated change", parentId: null, state: "active", sortOrder: 0,
          },
        }],
      },
    });
    await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({
      ok: false, error: { code: "GROWTH_BINDING_INVALID" },
    }));
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get())
      .toEqual(changeSetsBeforeRejectedProposal);
    for (const [summary, item] of [
      ["Attempt to rebind an unrelated document.", {
        id: "repair-rebind-document", dependsOn: [], kind: "creative_document.put",
        payload: {
          documentId: unrelatedDocumentId, create: false, resourceId: prior.resourceId,
          kind: "location_profile", title: "Rebound profile", state: "active", sortOrder: 0,
        },
      }],
      ["Attempt to rebind an unrelated assertion.", {
        id: "repair-rebind-assertion", dependsOn: [], kind: "assertion.put",
        payload: {
          assertionId: unrelatedAssertionId, scopeType: "world", scopeId: prior.resourceId,
          subject: prior.resourceId, predicate: "closure.world.fact.geography_environment",
          object: { status: "rebound" }, evidenceIds: [targetEvidenceId],
        },
      }],
      ["Attempt to rebind an unrelated constraint profile.", {
        id: "repair-rebind-constraint", dependsOn: [], kind: "constraint_profile.put",
        payload: {
          profileId: unrelatedProfileId, create: false, scopeResourceId: prior.resourceId,
          title: "Rebound constraints", profile: {
            narrativePerson: null, tense: null, tone: null, pacing: null, humorLevel: null,
            prohibitedContent: [], requiredContent: [], notes: "Rebound scope.",
          }, state: "active",
        },
      }],
    ] as const) {
      repairWorker.receive({
        type: "tool.request", runId: repairRunId, requestId: randomUUID(), tool: "propose_change_set",
        args: { summary, items: [item] },
      });
      await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({
        ok: false, error: { code: "GROWTH_BINDING_INVALID" },
      }));
      expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get())
        .toEqual(changeSetsBeforeRejectedProposal);
    }
    repairWorker.receive({
      type: "tool.request", runId: repairRunId, requestId: randomUUID(), tool: "propose_change_set",
      args: {
        summary: "Rename the reviewed world only.",
        items: [
          {
            id: "repair-world", dependsOn: [], kind: "resource.put",
            payload: {
              resourceId: prior.resourceId, create: false, type: "world", objectKind: "world",
              title: "The Tidemarked Reach", parentId: setup.scopeId, state: "active", sortOrder: 0,
            },
          },
          {
            id: "repair-selected-relation", dependsOn: ["repair-world"], kind: "creative_relation.put",
            payload: {
              relationId: "repair-selected-relation", create: true, relationKind: "related_to",
              sourceResourceId: prior.resourceId, targetResourceId: unrelatedLocationId, state: "active",
            },
          },
        ],
      },
    });
    await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { status: "committed", changeSetId: expect.any(String) },
    }));
    const committed = growth.getCycle(repairCycle.id)!;
    expect(committed).toMatchObject({
      status: "committed", receiptId: expect.any(String), changeSetId: expect.any(String),
      outputCheckpointId: expect.any(String), failureCode: null,
    });
    expect(growth.getClosureRepairLineage(lineage.id)?.resolutionState).toBe("planned");
    expect(new CreativeRelationRepository(setup.workspace).getCurrent("repair-selected-relation"))
      .toMatchObject({ sourceResourceId: prior.resourceId, targetResourceId: unrelatedLocationId, kind: "related_to" });
    const changeSetCount = setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get();
    repairWorker.receive({
      type: "tool.request", runId: repairRunId, requestId: randomUUID(), tool: "propose_change_set",
      args: { summary: "must not run twice", items: [] },
    });
    await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({ ok: false }));
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual(changeSetCount);
    repairWorker.receive({
      type: "run.completed", runId: repairRunId, outcome: "completed",
      message: "repaired", changeSetState: "committed", artifacts: [],
    });
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

  it("anchors Cycle 2 retrieval to the prior committed world output even when the model supplies no seed", async () => {
    const setup = createSetup();
    const prior = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "prior-world");
    const growth = new GrowthRepository(setup.workspace);
    const cycle = growth.beginCycle({
      id: "growth-cycle-2", goalId: setup.goalId, idempotencyKey: "growth-cycle-2-key",
      inputCheckpointId: prior.outputCheckpointId, ruleRevision: 1,
      intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] },
    });
    const worker = new FakeWorker();
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker));
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: cycle.id,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "continue", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    expect((worker.sent[0] as { growthBinding: { kind: string; focusKinds: string[]; seedResourceIds: string[] } }).growthBinding)
      .toMatchObject({ kind: "expand", focusKinds: ["story"], seedResourceIds: [] });
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "unmatched", 1);
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    const response = worker.sent[1] as { ok: boolean; result: { evidence: Array<{ kind: string; resource?: { resourceId: string } }> } };
    expect(response).toMatchObject({ ok: true });
    expect(response.result.evidence).toContainEqual(expect.objectContaining({ kind: "resource", resource: expect.objectContaining({ resourceId: prior.resourceId }) }));
    const receipt = growth.getReceipt(growth.getCycle(cycle.id)!.receiptId!);
    expect(receipt?.links).toContainEqual(expect.objectContaining({ targetKind: "resource", targetId: prior.resourceId, reasonCodes: expect.arrayContaining(["alias"]) }));
  });

  it("anchors Cycle 3 retrieval only to the prior committed story output", async () => {
    const setup = createSetup();
    const world = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "prior-world");
    const growth = new GrowthRepository(setup.workspace);
    const cycle2 = growth.beginCycle({ id: "growth-cycle-2", goalId: setup.goalId, idempotencyKey: "growth-cycle-2-key", inputCheckpointId: world.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] } });
    const storyRootId = setup.authorizedScopeResourceIds.find((id) => new ResourceRepository(setup.workspace).listAtCheckpoint(world.outputCheckpointId).find((resource) => resource.id === id)?.type === "story")!;
    const story = await commitPriorResourceCycle(setup, cycle2.id, "story", "story", storyRootId, "prior-story");
    const cycle3 = growth.beginCycle({ id: "growth-cycle-3", goalId: setup.goalId, idempotencyKey: "growth-cycle-3-key", inputCheckpointId: story.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["oc"], resumeFrontier: [] } });
    const worker = new FakeWorker();
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker));
    const runId = lifecycle.start({ goalId: setup.goalId, cycleId: cycle3.id, request: { projectId: "project-1", sessionId: "session-1", userInput: "continue", mode: "free" }, emit: () => undefined });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "unmatched", 1);
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    const response = worker.sent[1] as { ok: boolean; result: { evidence: Array<{ kind: string; resource?: { resourceId: string } }> } };
    expect(response).toMatchObject({ ok: true });
    expect(response.result.evidence).toContainEqual(expect.objectContaining({ kind: "resource", resource: expect.objectContaining({ resourceId: story.resourceId }) }));
  });

  it("fails closed for a missing prior Change Set output before a Worker starts", async () => {
    const setup = createSetup();
    const first = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "prior-world");
    const growth = new GrowthRepository(setup.workspace);
    const cycle2 = growth.beginCycle({ id: "growth-cycle-2", goalId: setup.goalId, idempotencyKey: "growth-cycle-2-key", inputCheckpointId: first.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] } });
    setup.workspace.db.prepare("DELETE FROM change_set_outputs WHERE change_set_id = ?").run(first.changeSetId);
    const spawn = vi.fn(() => new FakeWorker());
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, new FakeWorker(), spawn));
    expect(() => lifecycle.start({ goalId: setup.goalId, cycleId: cycle2.id, request: { projectId: "project-1", sessionId: "session-1", userInput: "continue", mode: "free" }, emit: () => undefined }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when the prior Change Set has multiple candidate world outputs", async () => {
    const setup = createSetup();
    const first = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "prior-world");
    const second = new ResourceRepository(setup.workspace).putRevisionWithReceipt({
      resourceId: "prior-world-second", create: true, checkpointId: first.outputCheckpointId,
      type: "world", objectKind: "world", title: "prior-world-second", parentId: setup.scopeId, state: "active", sortOrder: 1,
    });
    setup.workspace.db.prepare(`
      INSERT INTO change_set_items (change_set_id, id, ordinal, kind, payload_json, risk, conflicts_json, decision)
      VALUES (?, 'second-world-output', 1, 'resource.put', '{}', 'low', '[]', 'accepted')
    `).run(first.changeSetId);
    setup.workspace.db.prepare(`
      INSERT INTO change_set_outputs (change_set_id, item_id, output_kind, output_id, output_sha256, created_at)
      VALUES (?, 'second-world-output', 'resource_revision', ?, ?, ?)
    `).run(first.changeSetId, second.revisionId, second.revisionSha256, new Date().toISOString());
    const growth = new GrowthRepository(setup.workspace);
    const cycle2 = growth.beginCycle({ id: "growth-cycle-2", goalId: setup.goalId, idempotencyKey: "growth-cycle-2-key", inputCheckpointId: first.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] } });
    const spawn = vi.fn(() => new FakeWorker());
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, new FakeWorker(), spawn));
    expect(() => lifecycle.start({ goalId: setup.goalId, cycleId: cycle2.id, request: { projectId: "project-1", sessionId: "session-1", userInput: "continue", mode: "free" }, emit: () => undefined }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when the Cycle input checkpoint is no longer the active pinned checkpoint", async () => {
    const setup = createSetup();
    const first = await commitPriorResourceCycle(setup, setup.cycleId, "world", "world", setup.scopeId, "prior-world");
    const growth = new GrowthRepository(setup.workspace);
    const cycle2 = growth.beginCycle({ id: "growth-cycle-2", goalId: setup.goalId, idempotencyKey: "growth-cycle-2-key", inputCheckpointId: first.outputCheckpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] } });
    new CheckpointRepository(setup.workspace).appendCheckpoint(new CheckpointRepository(setup.workspace).getActiveBranch().id, "stale anchor test");
    const spawn = vi.fn(() => new FakeWorker());
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, new FakeWorker(), spawn));
    expect(() => lifecycle.start({ goalId: setup.goalId, cycleId: cycle2.id, request: { projectId: "project-1", sessionId: "session-1", userInput: "continue", mode: "free" }, emit: () => undefined }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
    expect(spawn).not.toHaveBeenCalled();
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

    await requestSelectedInquiry(worker, runId);
    expect(worker.sent[3]).toMatchObject({
      type: "tool.response", ok: true, tool: "submit_growth_inquiry",
      result: { status: "selected", safeSummary: "Evaluating trusted consequence 1." },
    });
    const batchRow = setup.workspace.db.prepare("SELECT id FROM growth_inquiry_batches WHERE cycle_id = ?").get(setup.cycleId) as { id: string };
    const inquiryBatch = repository.getInquiryBatch(batchRow.id)!;
    expect(inquiryBatch.questions).toHaveLength(3);
    expect(inquiryBatch.questions[0]!.evidenceLinks.map((link) => link.rank))
      .toEqual(repository.getReceipt(receiptId)!.links.map((link) => link.rank));
    expect(inquiryBatch.questions[0]!.fingerprint).toBe(canonicalAuditHash({
      question: `Which trusted consequence should run ${runId} pursue at priority 3?`,
      ranks: repository.getReceipt(receiptId)!.links.map((link) => link.rank),
      ruleRevision: 1,
    }));
    expect(repository.listEvents(setup.goalId).at(-1)).toMatchObject({
      phase: "inquiry_selected", targetKind: "inquiry", targetId: inquiryBatch.selectedInquiryId,
      safeSummary: "Evaluating trusted consequence 1.",
    });

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
    await vi.waitFor(() => expect(worker.sent).toHaveLength(5));
    expect(worker.sent[4]).toMatchObject({ type: "tool.response", ok: true, tool: "propose_change_set", result: { status: "committed", mode: "free" } });
    const committed = repository.getCycle(setup.cycleId);
    expect(committed).toMatchObject({ status: "committed", runId, receiptId: expect.any(String), changeSetId: expect.any(String), outputCheckpointId: expect.any(String) });
    expect(repository.listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached", "receipt_recorded", "inquiry_selected", "change_set_committed"]);
    setup.workspace.db.prepare("DELETE FROM growth_events WHERE goal_id = ? AND cycle_id = ? AND phase = 'change_set_committed'").run(setup.goalId, setup.cycleId);
    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId }).status).toBe("committed");
    expect(repository.listEvents(setup.goalId).map((event) => event.phase)).toEqual(["run_attached", "receipt_recorded", "inquiry_selected", "change_set_committed"]);

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

  it("durably blocks creator-choice Inquiry before any Change Set or image side effect", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const proposeChangeSet = vi.fn();
    const generateImage = vi.fn();
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker, undefined, {
      proposeChangeSet,
      generateImage,
    }));
    const runId = lifecycle.start({
      goalId: setup.goalId,
      cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "需要取舍的增长", mode: "free" },
      emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID());
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    const sourceVersionId = (worker.sent[1] as { result: { evidence: Array<{ evidenceId: string }> } }).result.evidence[0]!.evidenceId;

    await requestSelectedInquiry(worker, runId, true);
    await requestSelectedInquiry(worker, runId, true);

    const repository = new GrowthRepository(setup.workspace);
    expect(repository.getCycle(setup.cycleId)).toMatchObject({ status: "blocked", failureCode: "GROWTH_CREATOR_CHOICE_REQUIRED", changeSetId: null });
    expect(repository.listEvents(setup.goalId).at(-1)).toMatchObject({
      phase: "creator_choice_required", durableState: "blocked", targetKind: "inquiry",
      safeSummary: "Evaluating trusted consequence 1.",
    });
    expect(repository.listEvents(setup.goalId).filter((event) => event.phase === "creator_choice_required")).toHaveLength(1);
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batches").get()).toMatchObject({ count: 1 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toMatchObject({ count: 0 });

    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "propose_change_set",
      args: {
        summary: "must not run",
        items: [{
          id: "must-not-run", dependsOn: [], kind: "resource.put",
          payload: { resourceId: "must.not.run", create: true, type: "world", objectKind: "world", title: "must not run", parentId: setup.scopeId, state: "active", sortOrder: 0 },
        }],
      },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(5));
    expect(worker.sent[4]).toMatchObject({ ok: false, error: { code: "GROWTH_INQUIRY_REQUIRED" } });
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "generate_image",
      args: {
        title: "must not run", purpose: "world_map", prompt: "must not run",
        sourceResourceIds: [setup.scopeId], sourceVersionIds: [sourceVersionId], idempotencyKey: "must-not-run",
      },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(6));
    expect(worker.sent[5]).toMatchObject({ ok: false, error: { code: "GROWTH_INQUIRY_REQUIRED" } });
    expect(proposeChangeSet).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    worker.receive({ type: "run.completed", runId, outcome: "blocked", message: "等待创作者取舍。", changeSetState: "none", artifacts: [] });
    await vi.waitFor(() => expect(repository.listEvents(setup.goalId).at(-1)?.phase).toBe("creator_choice_required"));
    expect(repository.listEvents(setup.goalId).some((event) => event.phase === "cycle_terminal")).toBe(false);
    expect(lifecycle.recoverCycle({ goalId: setup.goalId, cycleId: setup.cycleId })).toMatchObject({
      status: "blocked", failureCode: "GROWTH_CREATOR_CHOICE_REQUIRED",
    });
    expect(repository.listEvents(setup.goalId).filter((event) => event.phase === "creator_choice_required")).toHaveLength(1);
  });

  it("replays an identical Inquiry in the same Run without duplicating durable or published effects", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const supervisor = createSupervisor(setup, worker);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, supervisor);
    const publishedInquiryPhases: string[] = [];
    const runId = lifecycle.start({
      goalId: setup.goalId,
      cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "重放 Inquiry", mode: "free" },
      emit: () => undefined,
      onPersistedEvent: (event) => {
        if (event.phase === "inquiry_selected" || event.phase === "creator_choice_required") publishedInquiryPhases.push(event.phase);
      },
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID());
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));

    const args = await requestSelectedInquiry(worker, runId);
    await requestSelectedInquiry(worker, runId);

    const repository = new GrowthRepository(setup.workspace);
    expect(worker.sent[2]).toMatchObject({ ok: true, result: { status: "selected" } });
    expect(worker.sent[3]).toMatchObject({ ok: true, result: (worker.sent[2] as { result: unknown }).result });
    expect(repository.getCycle(setup.cycleId)).toMatchObject({ status: "running", failureCode: null });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batches").get()).toMatchObject({ count: 1 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_lifecycle").get()).toMatchObject({ count: 3 });
    expect(repository.listEvents(setup.goalId).filter((event) => event.phase === "inquiry_selected")).toHaveLength(1);
    expect(publishedInquiryPhases).toEqual(["inquiry_selected"]);

    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "submit_growth_inquiry",
      args: {
        ...args,
        inquiries: args.inquiries.map((inquiry, index) => index === 0
          ? { ...inquiry, safeSummary: "A different replay payload." }
          : inquiry),
      },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(5));
    expect(worker.sent[4]).toMatchObject({ ok: false, error: { code: "GROWTH_INQUIRY_INVALID" } });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batches").get()).toMatchObject({ count: 1 });
    expect(repository.listEvents(setup.goalId).filter((event) => event.phase === "inquiry_selected")).toHaveLength(1);
  });

  it("allows only one in-flight Change Set executor call and never retries it after failure", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const proposal = deferred<never>();
    const proposeChangeSet = vi.fn(() => proposal.promise);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker, undefined, { proposeChangeSet }));
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "并发提交", mode: "assist" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID());
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    await requestSelectedInquiry(worker, runId);
    const proposalArgs = {
      summary: "one shot",
      items: [{
        id: "pending-document", dependsOn: [], kind: "document.put" as const,
        payload: { resourceId: setup.scopeId, content: "pending" },
      }],
    };
    const firstId = randomUUID();
    const secondId = randomUUID();
    worker.receive({ type: "tool.request", runId, requestId: firstId, tool: "propose_change_set", args: proposalArgs });
    worker.receive({ type: "tool.request", runId, requestId: secondId, tool: "propose_change_set", args: proposalArgs });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    proposal.reject(Object.assign(new Error("apply failed"), { code: "CHANGE_SET_APPLY_FAILED" }));
    await vi.waitFor(() => expect(worker.sent).toHaveLength(5));
    expect(proposeChangeSet).toHaveBeenCalledTimes(1);
    expect(worker.sent.find((message) => (message as { requestId?: string }).requestId === secondId))
      .toMatchObject({ ok: false, error: { code: "GROWTH_RUN_FAILED" } });
    worker.receive({ type: "tool.request", runId, requestId: randomUUID(), tool: "propose_change_set", args: proposalArgs });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(6));
    expect(proposeChangeSet).toHaveBeenCalledTimes(1);
  });

  it("allows only one world-map executor call after commit and never retries it after failure", async () => {
    const setup = createSetup();
    const worker = new FakeWorker();
    const image = deferred<never>();
    const generateImage = vi.fn(() => image.promise);
    const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker, undefined, { generateImage }));
    const runId = lifecycle.start({
      goalId: setup.goalId, cycleId: setup.cycleId,
      request: { projectId: "project-1", sessionId: "session-1", userInput: "唯一地图", mode: "free" }, emit: () => undefined,
    });
    worker.spawn();
    beginStewardInvocation(setup.workspace, runId);
    requestGrowthRetrieval(worker, runId, randomUUID());
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    await requestSelectedInquiry(worker, runId);
    worker.receive({
      type: "tool.request", runId, requestId: randomUUID(), tool: "propose_change_set",
      args: {
        summary: "commit before map",
        items: [{
          id: "map-world", dependsOn: [], kind: "resource.put",
          payload: { resourceId: "world.map", create: true, type: "world", objectKind: "world", title: "Map world", parentId: setup.scopeId, state: "active", sortOrder: 0 },
        }],
      },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(4));
    const imageArgs = {
      title: "World map", purpose: "world_map" as const, prompt: "A bounded world map.",
      sourceResourceIds: [setup.scopeId], sourceVersionIds: ["committed-version"], idempotencyKey: "one-map",
    };
    const firstId = randomUUID();
    const secondId = randomUUID();
    worker.receive({ type: "tool.request", runId, requestId: firstId, tool: "generate_image", args: imageArgs });
    worker.receive({ type: "tool.request", runId, requestId: secondId, tool: "generate_image", args: imageArgs });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    image.reject(Object.assign(new Error("image failed"), { code: "IMAGE_GENERATION_FAILED" }));
    await vi.waitFor(() => expect(worker.sent).toHaveLength(6));
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(worker.sent.find((message) => (message as { requestId?: string }).requestId === secondId))
      .toMatchObject({ ok: false, error: { code: "GROWTH_RUN_FAILED" } });
    worker.receive({ type: "tool.request", runId, requestId: randomUUID(), tool: "generate_image", args: imageArgs });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(7));
    expect(generateImage).toHaveBeenCalledTimes(1);
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
    await requestSelectedInquiry(worker, runId);
    worker.receive({
      type: "tool.request", runId, requestId: "55555555-5555-4555-8555-555555555555", tool: "propose_change_set",
      args: { summary: "候选设定", items: [{ id: "pending-document", dependsOn: [], kind: "document.put", payload: { resourceId: setup.scopeId, content: "待确认的候选。" } }] },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(4));
    if (!(worker.sent[3] as { ok?: boolean }).ok) throw new Error(JSON.stringify(worker.sent[3]));
    expect(worker.sent[3]).toMatchObject({ type: "tool.response", ok: true, result: { status: "pending" } });
    worker.receive({ type: "run.completed", runId, outcome: "awaiting_confirmation", message: "等待确认。", changeSetState: "pending_review", artifacts: [] });
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)?.status).toBe("blocked"));
    expect(new GrowthRepository(setup.workspace).getCycle(setup.cycleId)).toMatchObject({ changeSetId: null, outputCheckpointId: null, failureCode: "GROWTH_CHANGE_SET_NOT_COMMITTED" });
  });
});

function createSetup(focusKinds: Array<"world" | "story" | "oc"> = ["world"]) {
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
  const cycle = repository.beginCycle({ id: "growth-cycle", goalId: goal.id, idempotencyKey: "growth-cycle-key", inputCheckpointId: branch.headCheckpointId, ruleRevision: goal.currentRuleRevision, intent: { kind: "expand", focusKinds, resumeFrontier: ["story", "oc"] } });
  return { workspace, goalId: goal.id, cycleId: cycle.id, scopeId, authorizedScopeResourceIds };
}

function createClosureEvaluation(
  setup: ReturnType<typeof createSetup>,
  checkpointId: string,
  facetId: string | string[],
  suffix: string,
) {
  const growth = new GrowthRepository(setup.workspace);
  const profile = growth.createClosureProfile({
    id: `closure-profile-${suffix}`,
    idempotencyKey: `closure-profile-${suffix}-key`,
    goalId: setup.goalId,
    profileKind: "world_birth",
    subjectResourceId: null,
    componentProfiles: [],
    focusOcResourceId: null,
    contractGeneration: "v26",
    checkpointId,
    ruleRevision: 1,
    facets: (Array.isArray(facetId) ? facetId : [facetId])
      .map((id) => ({ id, kind: "content" as const, required: true })),
  });
  const evaluation = growth.beginCycle({
    id: `closure-evaluation-${suffix}`,
    goalId: setup.goalId,
    idempotencyKey: `closure-evaluation-${suffix}-key`,
    inputCheckpointId: checkpointId,
    ruleRevision: 1,
    intent: { kind: "closure_evaluation", profileId: profile.id, revision: 1, checkpointId },
  });
  return { growth, profile, evaluation };
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
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"] },
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
    authorizedTools: ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set", "generate_image"],
    handoffContractId: null, handoffVersion: null, handoffPayloadSha256: null, inputSha256: hash,
  });
}

function beginCheckerInvocation(workspace: WorkspaceDatabase, runId: string): string {
  const hash = "b".repeat(64);
  const invocationId = `${runId}:checker`;
  new AgentAuditRepository(workspace).beginInvocation({
    invocationId, runId, parentInvocationId: `${runId}:steward`, role: "checker",
    promptId: "novax.checker", promptVersion: "1.9.0", promptSha256: hash,
    agentProfileId: "novax.checker", agentProfileVersion: "1.9.0", agentProfileSha256: hash,
    providerId: "provider", requestedModelId: "model", providerConfigSha256: hash,
    toolPolicyId: "novax.checker.tools", toolPolicyVersion: "1.0.0", toolPolicySha256: hash,
    authorizedTools: [], handoffContractId: "novax.closure-review", handoffVersion: "1.0.0", handoffPayloadSha256: hash,
    inputSha256: hash,
  });
  return invocationId;
}

function terminalizeInvocation(
  workspace: WorkspaceDatabase,
  runId: string,
  invocationId: string,
  output: string,
): void {
  new AgentAuditRepository(workspace).appendInvocationTerminal({
    runId,
    invocationId,
    eventType: "completed",
    errorCode: null,
    actualProviderId: "provider",
    actualModelId: "model",
    responseIdSha256: hashText(`${output}:response`),
    stopReason: "stop",
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    contextPolicyVersion: "test",
    maxChargedInputBytes: 100,
    configuredContextWindow: 1000,
    safetyReserve: 100,
    outputReserve: 100,
    correctionAttempts: 0,
    structuredSubmissionCount: 1,
    outputSha256: hashText(output),
  });
}

function hashText(value: string): string {
  return canonicalAuditHash({ value });
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

function requestGrowthRetrieval(worker: FakeWorker, runId: string, requestId: string, query = "世界", resultBudget = 10): void {
  worker.receive({
    type: "tool.request", runId, requestId, tool: "retrieve_graph_evidence",
    args: {
      variant: "growth_v1", query, aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000,
      expansionBudget: 20, resultBudget, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1",
    },
  });
}

async function requestSelectedInquiry(worker: FakeWorker, runId: string, creatorChoice = false) {
  const before = worker.sent.length;
  const retrieval = [...worker.sent].reverse().find((message) => {
    const candidate = message as { ok?: boolean; tool?: string; result?: { evidence?: unknown } };
    return candidate.ok === true && candidate.tool === "retrieve_graph_evidence" && Array.isArray(candidate.result?.evidence);
  }) as { ok: true; result: { evidence: Array<{ evidenceId: string }> } } | undefined;
  if (!retrieval?.ok || !retrieval.result?.evidence) throw new Error("Growth retrieval response is required before Inquiry.");
  const evidenceIds = retrieval.result.evidence.map((evidence) => evidence.evidenceId);
  const evidenceState = evidenceIds.length > 0 ? "known" as const : "unknown" as const;
  const args = {
    inquiries: [3, 2, 1].map((priority, index) => ({
      localId: `question_${index + 1}`,
      question: `Which trusted consequence should run ${runId} pursue at priority ${priority}?`,
      evidenceIds,
      evidenceState,
      safeSummary: `Evaluating trusted consequence ${index + 1}.`,
      proposedAction: `Apply bounded consequence ${index + 1}.`,
      provisionalAssumption: evidenceState === "unknown" && !(creatorChoice && index === 0) ? "Assume bounded continuity." : null,
      priority,
      requiresCreatorChoice: creatorChoice && index === 0,
    })),
    selectedLocalId: creatorChoice ? null : "question_1",
    priorTransitions: [],
  };
  worker.receive({
    type: "tool.request",
    runId,
    requestId: randomUUID(),
    tool: "submit_growth_inquiry",
    args,
  });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(before + 1));
  const response = worker.sent.at(-1) as { ok?: boolean };
  if (!response.ok) throw new Error(`Growth Inquiry did not seal: ${JSON.stringify(response)}`);
  return args;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function commitPriorResourceCycle(
  setup: ReturnType<typeof createSetup>,
  cycleId: string,
  type: "world" | "story" | "oc",
  objectKind: "world" | "story" | "oc",
  parentId: string,
  resourceId: string,
): Promise<{ changeSetId: string; outputCheckpointId: string; resourceId: string }> {
  const worker = new FakeWorker();
  const lifecycle = new GrowthRunLifecycle(setup.workspace, createSupervisor(setup, worker));
  const runId = lifecycle.start({
    goalId: setup.goalId, cycleId,
    request: { projectId: "project-1", sessionId: `anchor-${cycleId}`, userInput: "anchor", mode: "free" }, emit: () => undefined,
  });
  worker.spawn();
  beginStewardInvocation(setup.workspace, runId);
  requestGrowthRetrieval(worker, runId, randomUUID());
  await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
  await requestSelectedInquiry(worker, runId);
  worker.receive({
    type: "tool.request", runId, requestId: randomUUID(), tool: "propose_change_set",
    args: {
      summary: "anchor setup",
      items: [{
        id: "anchor-resource", dependsOn: [], kind: "resource.put",
        payload: { resourceId, create: true, type, objectKind, title: resourceId, parentId, state: "active", sortOrder: 0 },
      }],
    },
  });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(4));
  const response = worker.sent[3] as { ok: boolean; result?: { changeSetId?: string } };
  if (!response.ok || !response.result?.changeSetId) throw new Error("anchor Change Set did not commit");
  const committed = new GrowthRepository(setup.workspace).getCycle(cycleId);
  if (!committed?.outputCheckpointId || !committed.changeSetId) throw new Error("anchor Cycle did not bind a committed Change Set");
  worker.receive({ type: "run.completed", runId, outcome: "completed", message: "saved", changeSetState: "committed", artifacts: [] });
  return { changeSetId: committed.changeSetId, outputCheckpointId: committed.outputCheckpointId, resourceId };
}
