import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { GrowthIllustrationApplicationService } from "../../src/main/growth/illustration/growthIllustrationApplicationService";
import { compileGrowthIncrementalIllustrations } from "../../src/main/growth/illustration/growthIncrementalIllustrationPlanner";

const roots: string[] = [];
const workspaces: WorkspaceDatabase[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("incremental Growth illustration planning", () => {
  it("enqueues each committed visual version idempotently and replaces a revised source while image work is still pending", async () => {
    const setup = createSetup("revision");
    const first = commitVisualCycle(setup, { suffix: "first", title: "旧潮港", create: true });
    const rejectors: Array<(reason?: unknown) => void> = [];
    const generateImage = vi.fn(() => new Promise<never>((_resolve, reject) => rejectors.push(reject)));
    const service = new GrowthIllustrationApplicationService(setup.workspace, { generateImage });

    const firstRequestIds = service.ensureIncrementalForCommittedCycle(
      { goalId: setup.goalId, cycleId: first.cycleId }, setup.context,
    );
    expect(firstRequestIds).toHaveLength(1);
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(service.ensureIncrementalForCommittedCycle(
      { goalId: setup.goalId, cycleId: first.cycleId }, setup.context,
    )).toEqual(firstRequestIds);
    expect(generateImage).toHaveBeenCalledTimes(1);

    const second = commitVisualCycle(setup, {
      suffix: "second", title: "新潮港", create: false, resourceId: first.resourceId,
    });
    const secondRequestIds = service.ensureIncrementalForCommittedCycle(
      { goalId: setup.goalId, cycleId: second.cycleId }, setup.context,
    );
    expect(secondRequestIds).toHaveLength(1);
    expect(secondRequestIds[0]).not.toBe(firstRequestIds[0]);
    expect(generateImage).toHaveBeenCalledTimes(1);

    const growth = new GrowthRepository(setup.workspace);
    expect(growth.listIllustrationRequests(setup.goalId)).toHaveLength(2);
    expect(growth.listIllustrationItems(firstRequestIds[0]!).map((item) => item.status)).toEqual(["stale"]);
    expect(growth.listIllustrationItems(secondRequestIds[0]!).map((item) => item.status)).toEqual(["planned"]);
    expect(growth.listIllustrationItems(secondRequestIds[0]!)[0]).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ kind: "resource", resourceId: first.resourceId, resourceVersionId: second.revisionId }),
      ]),
    });

    rejectors[0]!(Object.assign(new Error("provider unavailable"), { code: "IMAGE_PROVIDER_RUNTIME_FAILED" }));
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(2));
    rejectors[1]!(Object.assign(new Error("provider unavailable"), { code: "IMAGE_PROVIDER_RUNTIME_FAILED" }));
    await vi.waitFor(() => expect(growth.listIllustrationItems(secondRequestIds[0]!).map((item) => item.status)).toEqual(["failed"]));
    service.dispose();
  });

  it("returns before a failed image Provider settles and leaves the committed text cycle authoritative", async () => {
    const setup = createSetup("failure");
    const committed = commitVisualCycle(setup, { suffix: "failure", title: "断潮海岸", create: true });
    const generateImage = vi.fn(async () => {
      await Promise.resolve();
      throw Object.assign(new Error("provider unavailable"), { code: "IMAGE_PROVIDER_RUNTIME_FAILED" });
    });
    const service = new GrowthIllustrationApplicationService(setup.workspace, { generateImage });

    let textSchedulerAdvanced = false;
    const requestIds = service.ensureIncrementalForCommittedCycle(
      { goalId: setup.goalId, cycleId: committed.cycleId }, setup.context,
    );
    textSchedulerAdvanced = true;
    expect(textSchedulerAdvanced).toBe(true);
    expect(new GrowthRepository(setup.workspace).getCycle(committed.cycleId)?.status).toBe("committed");
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace)
      .listIllustrationItems(requestIds[0]!).map((item) => item.status)).toEqual(["failed"]));
    expect(new GrowthRepository(setup.workspace).getCycle(committed.cycleId)?.status).toBe("committed");
    service.dispose();
  });

  it("fails closed before persistence when the cycle has no stable committed Change Set", () => {
    const setup = createSetup("uncommitted");
    const growth = new GrowthRepository(setup.workspace);
    const checkpointId = new CheckpointRepository(setup.workspace).getActiveBranch().headCheckpointId;
    const cycle = growth.beginCycle({
      id: "uncommitted-cycle", goalId: setup.goalId, idempotencyKey: "uncommitted-cycle-key",
      inputCheckpointId: checkpointId, ruleRevision: 1,
      intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: [] },
    });

    expect(() => compileGrowthIncrementalIllustrations(setup.workspace, {
      goalId: setup.goalId,
      cycleId: cycle.id,
      branchId: setup.context.branchId,
      authorizedScopeResourceIds: setup.context.authorizedScopeResourceIds,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_COMMITTED_CHANGE_SET_REQUIRED" }));
    expect(growth.listIllustrationRequests(setup.goalId)).toEqual([]);
  });
});

function createSetup(suffix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `novax-growth-incremental-${suffix}-`));
  roots.push(root);
  const workspace = openWorkspace(root);
  workspaces.push(workspace);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  const growth = new GrowthRepository(workspace);
  const goal = growth.createGoal({
    id: `incremental-goal-${suffix}`,
    idempotencyKey: `incremental-goal-key-${suffix}`,
    branchId: branch.id,
    seed: { kind: "text", text: "grow a visual world" },
    authorizedScopeResourceIds: [worldRoot.id],
    initialRuleText: "Use committed evidence only.",
    sourceMessageId: null,
  });
  return {
    workspace,
    goalId: goal.id,
    worldRootId: worldRoot.id,
    context: {
      checkpointId: branch.headCheckpointId,
      branchId: branch.id,
      authorizedScopeResourceIds: [worldRoot.id],
    },
  };
}

function commitVisualCycle(
  setup: ReturnType<typeof createSetup>,
  input: { suffix: string; title: string; create: boolean; resourceId?: string },
) {
  const checkpoints = new CheckpointRepository(setup.workspace);
  const baseCheckpointId = checkpoints.getActiveBranch().headCheckpointId;
  const growth = new GrowthRepository(setup.workspace);
  const cycle = growth.beginCycle({
    id: `incremental-cycle-${input.suffix}`,
    goalId: setup.goalId,
    idempotencyKey: `incremental-cycle-key-${input.suffix}`,
    inputCheckpointId: baseCheckpointId,
    ruleRevision: 1,
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: [] },
  });
  const run = seedRun(setup.workspace, setup.context.branchId, baseCheckpointId, input.suffix);
  growth.attachRun({ cycleId: cycle.id, runId: run.runId });
  growth.recordReceipt({
    id: `incremental-receipt-${input.suffix}`,
    cycleId: cycle.id,
    runId: run.runId,
    toolInvocationId: run.toolInvocationId,
    branchId: setup.context.branchId,
    checkpointId: baseCheckpointId,
    lens: "creator",
    effectiveScopeResourceIds: [setup.worldRootId],
    query: "visual frontier",
    aliases: [],
    validTime: null,
    recordedTime: null,
    maxHops: 1,
    cpuBudgetMs: 10,
    expansionBudget: 10,
    resultBudget: 10,
    tokenBudget: 10,
    policyVersion: "growth-retrieval-v1",
    coverage: { state: "complete", searchedScopeCount: 1, omittedCount: 0 },
    truncated: false,
    links: [],
  });

  const changeSets = new ChangeSetRepository(setup.workspace);
  const changeSet = changeSets.propose({
    idempotencyKey: `incremental-change-set-${input.suffix}`,
    mode: "free",
    summary: `Commit ${input.title}`,
  });
  const itemId = `resource-${input.suffix}`;
  setup.workspace.db.prepare(`
    INSERT INTO change_set_items (
      change_set_id, id, ordinal, kind, payload_json, risk, conflicts_json, decision
    ) VALUES (?, ?, 0, 'resource.put', '{}', 'low', '[]', 'accepted')
  `).run(changeSet.id, itemId);
  const resourceId = input.resourceId ?? `visual-world-${input.suffix}`;
  let revisionId = "";
  const outputCheckpointId = changeSets.commit(changeSet.id, `Commit ${input.title}`, (checkpointId) => {
    revisionId = new ResourceRepository(setup.workspace).putRevisionWithReceipt({
      resourceId,
      create: input.create,
      checkpointId,
      type: "world",
      objectKind: "world",
      title: input.title,
      parentId: setup.worldRootId,
      state: "active",
    }).revisionId;
  });
  changeSets.recordOutput(changeSet.id, itemId, {
    kind: "resource_revision",
    outputId: revisionId,
    outputSha256: sha256(revisionId),
  });
  growth.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
  return { cycleId: cycle.id, resourceId, revisionId, outputCheckpointId };
}

function seedRun(
  workspace: WorkspaceDatabase,
  branchId: string,
  checkpointId: string,
  suffix: string,
) {
  const runId = randomUUID();
  const invocationId = randomUUID();
  const toolInvocationId = randomUUID();
  const hash = sha256(`incremental-${suffix}`);
  const now = new Date().toISOString();
  workspace.db.prepare(`
    INSERT INTO agent_runs (
      id, workspace_id, branch_id, base_checkpoint_id, mode, user_input_sha256,
      provider_id, requested_model_id, provider_config_sha256, runtime_contract_version, created_at
    ) VALUES (?, ?, ?, ?, 'free', ?, NULL, NULL, NULL, '1.0.0', ?)
  `).run(runId, workspace.workspaceId, branchId, checkpointId, hash, now);
  workspace.db.prepare(`
    INSERT INTO agent_invocations (
      id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256,
      agent_profile_id, agent_profile_version, agent_profile_sha256, provider_id,
      requested_model_id, provider_config_sha256, tool_policy_id, tool_policy_version,
      tool_policy_sha256, authorized_tools_json, handoff_contract_id, handoff_version,
      handoff_payload_sha256, input_sha256, created_at
    ) VALUES (?, ?, NULL, 'steward', 'steward', '1.0.0', ?, 'profile', '1.0.0', ?,
      'provider', 'model', ?, 'policy', '1.0.0', ?, '[]', NULL, NULL, NULL, ?, ?)
  `).run(invocationId, runId, hash, hash, hash, hash, hash, now);
  workspace.db.prepare(`
    INSERT INTO agent_tool_invocations (
      id, run_id, invocation_id, tool_name, arguments_sha256, created_at
    ) VALUES (?, ?, ?, 'retrieve_graph_evidence', ?, ?)
  `).run(toolInvocationId, runId, invocationId, hash, now);
  return { runId, toolInvocationId };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
