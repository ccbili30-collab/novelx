import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { resolveGrowthClosureContinuationAuthority } from "../../src/main/growth/phases/closure/growthClosureContinuationAuthority";

let workspace: WorkspaceDatabase | null = null;
let root: string | null = null;
afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = null; root = null;
});

describe("Growth Closure continuation authority", () => {
  it("derives exact fact scopes only for the revision immediately following its evaluation", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-closure-continuation-"));
    workspace = openWorkspace(root);
    const checkpoints = new CheckpointRepository(workspace);
    const checkpointId = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "facts");
    const resources = new ResourceRepository(workspace);
    const roots = new Map(resources.listCurrent().filter((item) => item.objectKind === "domain_root").map((item) => [item.type, item.id]));
    resources.putRevision({ resourceId: "world", create: true, checkpointId, type: "world", objectKind: "world", title: "World", parentId: roots.get("world")!, state: "active" });
    resources.putRevision({ resourceId: "story", create: true, checkpointId, type: "story", objectKind: "story", title: "Story", parentId: roots.get("story")!, state: "active" });
    resources.putRevision({ resourceId: "oc", create: true, checkpointId, type: "oc", objectKind: "oc", title: "OC", parentId: roots.get("oc")!, state: "active" });
    const previous = cycle(5, "evaluated", checkpointId);
    const current = cycle(6, "planned", checkpointId);
    const repository = {
      listCycles: () => [previous, current],
      getCycle: (id: string) => id === previous.id ? previous : id === current.id ? current : null,
      getCycleIntent: (id: string) => id === previous.id
        ? { cycleId: previous.id, provenance: "persisted_v26", kind: "closure_evaluation", profileId: "profile", revision: 1, checkpointId }
        : { cycleId: current.id, provenance: "persisted_v26", kind: "revision", focusKinds: ["world", "story", "oc"], resumeFrontier: [] },
      getClosureEvaluationOutcomeForCycle: (id: string) => id === previous.id
        ? { profileId: "profile", decision: "continue_growing", stewardAssessmentId: "assessment" }
        : null,
      getClosureStewardSubmission: () => ({ facetResults: [
        { facetId: "closure.world.fact.history_timeline", state: "missing" },
        { facetId: "closure.story.fact.stage_resolution", state: "missing" },
        { facetId: "closure.oc.fact.backstory", state: "missing" },
      ] }),
      getClosureProfile: () => ({ focusOcResourceId: "oc" }),
    } as unknown as GrowthRepository;
    const intent = repository.getCycleIntent(current.id);
    expect(resolveGrowthClosureContinuationAuthority({
      workspace, repository, goalId: "goal", cycle: current, intent,
    })).toEqual({ requiredAssertions: [
      { facetId: "closure.oc.fact.backstory", scopeResourceId: "oc" },
      { facetId: "closure.story.fact.stage_resolution", scopeResourceId: "story" },
      { facetId: "closure.world.fact.history_timeline", scopeResourceId: "world" },
    ] });
  });
});

function cycle(sequence: number, status: "planned" | "evaluated", checkpointId: string) {
  return {
    id: `cycle-${sequence}`, goalId: "goal", sequence, idempotencyKey: `cycle-key-${sequence}`, inputCheckpointId: checkpointId,
    ruleRevision: 1, runId: status === "evaluated" ? `run-${sequence}` : null,
    receiptId: status === "evaluated" ? `receipt-${sequence}` : null,
    changeSetId: null, outputCheckpointId: null, status, failureCode: null,
    createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
    terminalAt: status === "evaluated" ? "2026-07-18T00:00:00.000Z" : null,
  } as const;
}
