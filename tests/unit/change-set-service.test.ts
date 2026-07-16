import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import {
  ChangeSetService,
  WorkspaceChangeSetApplier,
  type ChangeSetApplier,
  type ChangeSetCandidate,
  type ChangeSetItem,
  type ChangeSetPolicyAssessment,
  type ChangeSetPolicyEvaluator,
} from "../../src/domain/changeSet/changeSetService";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Change Set service contract", () => {
  it("keeps Assist pending until every item has a decision, then commits accepted dependencies atomically", () => {
    const service = createService();
    const head = currentHead();
    const candidate = service.propose({
      idempotencyKey: "assist-coastline",
      expectedHeadCheckpointId: head,
      mode: "assist",
      summary: "记录银湾海岸设定",
      items: [
        assertionItem("cause", "形成原因", "沉降纪元造成差异侵蚀。"),
        assertionItem("shape", "地貌", "海水倒灌形成曲折海岸。", ["cause"]),
      ],
    });

    expect(candidate.status).toBe("pending");
    expect(candidate.gateStatus).toBe("review_pending");
    expect(() => service.finalizeAssist(candidate.id, { expectedHeadCheckpointId: head, label: "接受海岸设定" }))
      .toThrowError(expect.objectContaining({ code: "CHANGE_SET_REVIEW_INCOMPLETE" }));

    expect(service.decideItem(candidate.id, "cause", "accepted").gateStatus).toBe("review_pending");
    expect(service.decideItem(candidate.id, "shape", "accepted").gateStatus).toBe("ready");

    const committed = service.finalizeAssist(candidate.id, {
      expectedHeadCheckpointId: head,
      label: "接受海岸设定",
    });
    expect(committed.status).toBe("committed");
    expect(committed.committedCheckpointId).not.toBeNull();
    expect(new AssertionRepository(workspace!).listCurrent().map((item) => item.predicate)).toEqual(["地貌", "形成原因"]);
  });

  it("projects pending review data without raw payloads or source locators", () => {
    const service = createService();
    const pending = service.propose({
      idempotencyKey: "safe-review-projection",
      expectedHeadCheckpointId: currentHead(),
      mode: "assist",
      summary: "审查银湾海岸设定",
      items: [assertionItem("safe-fact", "形成原因", "沉降纪元造成差异侵蚀。")],
    });

    expect(service.listPendingForReview()).toEqual([expect.objectContaining({
      id: pending.id,
      summary: "审查银湾海岸设定",
      itemCount: 1,
      pendingCount: 1,
    })]);
    const detail = service.getReviewDetail(pending.id);
    expect(detail.items[0]).toEqual(expect.objectContaining({
      id: "safe-fact",
      kind: "fact",
      kindLabel: "世界事实",
      decision: "pending",
      risk: "low",
      semanticSummary: "银湾海岸 · 形成原因",
      contentPreview: "沉降纪元造成差异侵蚀。",
    }));
    expect(JSON.stringify(detail)).not.toMatch(/payload|rawJson|source|contract:safe-fact|scopeId|object/i);
  });

  it("fails closed when proposal is attempted without a policy evaluator", () => {
    const currentWorkspace = workspaceForTest();
    const service = new ChangeSetService(currentWorkspace);
    expect(() => service.propose({
      idempotencyKey: "missing-policy",
      expectedHeadCheckpointId: currentHead(),
      mode: "assist",
      summary: "不能在无策略时提案",
      items: [assertionItem("policy", "策略", "不应写入。")],
    })).toThrowError(expect.objectContaining({ code: "CHANGE_SET_POLICY_REQUIRED" }));
    expect(currentWorkspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toMatchObject({ count: 0 });
  });

  it("blocks an accepted item whose dependency was rejected", () => {
    const service = createService();
    const head = currentHead();
    const candidate = service.propose({
      idempotencyKey: "assist-broken-dependency",
      expectedHeadCheckpointId: head,
      mode: "assist",
      summary: "部分接受相互依赖的设定",
      items: [
        assertionItem("cause", "形成原因", "沉降纪元。"),
        assertionItem("shape", "地貌", "曲折海岸。", ["cause"]),
      ],
    });

    service.decideItem(candidate.id, "cause", "rejected");
    const blocked = service.decideItem(candidate.id, "shape", "accepted");
    expect(blocked.gateStatus).toBe("blocked");
    expect(blocked.blockedReason).toBe("DEPENDENCY_UNRESOLVED");
    expect(() => service.finalizeAssist(candidate.id, { expectedHeadCheckpointId: head, label: "不完整提交" }))
      .toThrowError(expect.objectContaining({ code: "CHANGE_SET_DEPENDENCY_UNRESOLVED" }));
    expect(new AssertionRepository(workspace!).listCurrent()).toEqual([]);
  });

  it("automatically commits only low-risk Free candidates and remains idempotent", () => {
    const service = createService();
    const head = currentHead();
    const input = {
      idempotencyKey: "free-low-risk",
      expectedHeadCheckpointId: head,
      mode: "free" as const,
      summary: "补充低风险气候事实",
      items: [assertionItem("climate", "气候", "冬季多雾。")],
    };

    const committed = service.propose(input);
    expect(committed.status).toBe("committed");
    expect(committed.items[0]?.decision).toBe("accepted");
    expect(service.propose(input).id).toBe(committed.id);
    expect(new AssertionRepository(workspace!).listHistory("assertion.climate")).toHaveLength(1);
    expect(new AssertionRepository(workspace!).listCurrentInScopes(["world.silver-bay"])[0]?.sources).toEqual([
      { kind: "confirmed_change_set", ref: `${committed.id}:climate` },
    ]);
  });

  it("applies resource creation before a dependent stable document through the real workspace applier", () => {
    const service = createService();
    const head = currentHead();
    const worldRoot = new ResourceRepository(workspaceForTest()).listCurrent()
      .find((resource) => resource.type === "world" && resource.parentId === null)!;
    const resourceId = "resource.silver-bay";
    const committed = service.propose({
      idempotencyKey: "free-resource-document",
      expectedHeadCheckpointId: head,
      mode: "free",
      summary: "建立银湾海岸知识文档",
      items: [
        {
          id: "resource",
          kind: "resource.put",
          dependsOn: [],
          payload: {
            resourceId,
            create: true,
            type: "world",
            title: "银湾海岸",
            parentId: worldRoot.id,
            state: "active",
            sortOrder: 0,
          },
        },
        {
          id: "document",
          kind: "document.put",
          dependsOn: ["resource"],
          payload: {
            resourceId,
            content: "银湾海岸由沉降纪元塑造。",
            authorKind: "agent",
          },
        },
      ],
    });

    expect(committed.status).toBe("committed");
    expect(new ResourceRepository(workspace!).listCurrent().find((resource) => resource.id === resourceId)?.title)
      .toBe("银湾海岸");
    expect(new DocumentRepository(workspace!).getCurrentStable(resourceId)?.content)
      .toBe("银湾海岸由沉降纪元塑造。");
  });

  it("blocks elevated Free candidates instead of silently treating them as low-risk", () => {
    const service = createService(new ContractPolicyEvaluator({ elevatedItemIds: new Set(["identity"]) }));
    const blocked = service.propose({
      idempotencyKey: "free-elevated",
      expectedHeadCheckpointId: currentHead(),
      mode: "free",
      summary: "改写角色身份",
      items: [assertionItem("identity", "身份", "真实身份被改写。")],
    });

    expect(blocked.status).toBe("pending");
    expect(blocked.gateStatus).toBe("blocked");
    expect(blocked.blockedReason).toBe("FREE_REVIEW_REQUIRED");
    expect(new AssertionRepository(workspace!).listCurrent()).toEqual([]);
  });

  it.each(["free", "assist"] as const)("always blocks major conflicts in %s mode", (mode) => {
    const service = createService(new ContractPolicyEvaluator({ majorConflictItemIds: new Set(["rule"]) }));
    const blocked = service.propose({
      idempotencyKey: `major-${mode}`,
      expectedHeadCheckpointId: currentHead(),
      mode,
      summary: "冲突的世界规则",
      items: [assertionItem("rule", "世界规则", "海水向高处流动。")],
    });

    expect(blocked.gateStatus).toBe("blocked");
    expect(blocked.blockedReason).toBe("MAJOR_CONFLICT");
    if (mode === "assist") {
      service.decideItem(blocked.id, "rule", "accepted");
      expect(() => service.finalizeAssist(blocked.id, {
        expectedHeadCheckpointId: currentHead(),
        label: "不能提交",
      })).toThrowError(expect.objectContaining({ code: "CHANGE_SET_MAJOR_CONFLICT" }));
    }
    expect(new AssertionRepository(workspace!).listCurrent()).toEqual([]);
  });

  it("validates the expected head at proposal and final commit", () => {
    const service = createService();
    const originalHead = currentHead();
    expect(() => service.propose({
      idempotencyKey: "stale-at-proposal",
      expectedHeadCheckpointId: "not-current",
      mode: "assist",
      summary: "陈旧提案",
      items: [assertionItem("stale", "状态", "不应保存。")],
    })).toThrowError(expect.objectContaining({ code: "CHANGE_SET_EXPECTED_HEAD_MISMATCH" }));

    const pending = service.propose({
      idempotencyKey: "stale-at-finalize",
      expectedHeadCheckpointId: originalHead,
      mode: "assist",
      summary: "稍后变陈旧的提案",
      items: [assertionItem("later-stale", "状态", "不应提交。")],
    });
    service.decideItem(pending.id, "later-stale", "accepted");
    new CheckpointRepository(workspace!).appendCheckpoint(
      new CheckpointRepository(workspace!).getActiveBranch().id,
      "并发用户保存",
    );

    expect(() => service.finalizeAssist(pending.id, {
      expectedHeadCheckpointId: originalHead,
      label: "陈旧提交",
    })).toThrowError(expect.objectContaining({ code: "CHANGE_SET_BASE_STALE" }));
    expect(new AssertionRepository(workspace!).listCurrent()).toEqual([]);
  });

  it("rolls back the checkpoint and all writes when an applier fails", () => {
    const policy = new ContractPolicyEvaluator();
    const realApplier = new WorkspaceChangeSetApplier(workspaceForTest());
    const service = new ChangeSetService(workspace!, policy, new ContractFailingApplier(realApplier, "second"));
    const beforeHead = currentHead();
    const pending = service.propose({
      idempotencyKey: "assist-rollback",
      expectedHeadCheckpointId: beforeHead,
      mode: "assist",
      summary: "原子提交两项事实",
      items: [
        assertionItem("first", "第一项", "必须回滚。"),
        assertionItem("second", "第二项", "触发失败。", ["first"]),
      ],
    });
    service.decideItem(pending.id, "first", "accepted");
    service.decideItem(pending.id, "second", "accepted");

    expect(() => service.finalizeAssist(pending.id, {
      expectedHeadCheckpointId: beforeHead,
      label: "应当完整回滚",
    })).toThrowError(expect.objectContaining({ code: "CHANGE_SET_APPLY_FAILED" }));
    expect(currentHead()).toBe(beforeHead);
    expect(new AssertionRepository(workspace!).listCurrent()).toEqual([]);
    expect(service.getRequired(pending.id).status).toBe("failed");
  });

  it("rejects idempotency-key reuse when any candidate content changes", () => {
    const service = createService();
    const head = currentHead();
    service.propose({
      idempotencyKey: "reused-key",
      expectedHeadCheckpointId: head,
      mode: "assist",
      summary: "版本一",
      items: [assertionItem("fact", "状态", "版本一")],
    });
    expect(() => service.propose({
      idempotencyKey: "reused-key",
      expectedHeadCheckpointId: head,
      mode: "assist",
      summary: "版本二",
      items: [assertionItem("fact", "状态", "版本二")],
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
  });

  it("rejects cyclic dependencies before persisting a candidate", () => {
    const service = createService();
    expect(() => service.propose({
      idempotencyKey: "dependency-cycle",
      expectedHeadCheckpointId: currentHead(),
      mode: "assist",
      summary: "循环依赖",
      items: [
        assertionItem("one", "第一项", "循环一", ["two"]),
        assertionItem("two", "第二项", "循环二", ["one"]),
      ],
    })).toThrowError(expect.objectContaining({ code: "CHANGE_SET_DEPENDENCY_CYCLE" }));
    expect(workspace!.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toMatchObject({ count: 0 });
  });
});

class ContractPolicyEvaluator implements ChangeSetPolicyEvaluator {
  constructor(private readonly options: {
    elevatedItemIds?: ReadonlySet<string>;
    majorConflictItemIds?: ReadonlySet<string>;
  } = {}) {}

  assess(candidate: ChangeSetCandidate): ChangeSetPolicyAssessment[] {
    return candidate.items.map((item) => ({
      itemId: item.id,
      risk: this.options.elevatedItemIds?.has(item.id) ? "elevated" : "low",
      conflicts: this.options.majorConflictItemIds?.has(item.id)
        ? [{ severity: "major", code: "CONTRACT_MAJOR_CONFLICT" }]
        : [],
    }));
  }
}

class ContractFailingApplier implements ChangeSetApplier {
  constructor(
    private readonly delegate: ChangeSetApplier,
    private readonly failingItemId: string,
  ) {}

  apply(item: ChangeSetItem, context: { changeSetId: string; checkpointId: string }) {
    if (item.id === this.failingItemId) throw new Error("injected contract failure");
    return this.delegate.apply(item, context);
  }
}

function createService(policy = new ContractPolicyEvaluator()): ChangeSetService {
  const currentWorkspace = workspaceForTest();
  return new ChangeSetService(currentWorkspace, policy, new WorkspaceChangeSetApplier(currentWorkspace));
}

function workspaceForTest(): WorkspaceDatabase {
  if (workspace) return workspace;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-change-set-service-"));
  workspace = openWorkspace(root);
  return workspace;
}

function currentHead(): string {
  return new CheckpointRepository(workspaceForTest()).getActiveBranch().headCheckpointId;
}

function assertionItem(
  id: string,
  predicate: string,
  text: string,
  dependsOn: string[] = [],
): ChangeSetCandidate["items"][number] {
  return {
    id,
    kind: "assertion.put",
    dependsOn,
    payload: {
      assertionId: `assertion.${id}`,
      scopeType: "world",
      scopeId: "world.silver-bay",
      subject: "银湾海岸",
      predicate,
      object: { text },
      evidenceIds: [],
      status: "current",
      source: { kind: "agent_candidate", ref: `contract:${id}` },
    },
  };
}
