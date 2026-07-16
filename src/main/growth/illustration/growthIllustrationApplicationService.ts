import { createHash } from "node:crypto";
import { compileGrowthIllustrationPlan, type TrustedGrowthIllustrationCompileInput } from "../../../agent-worker/growth/growthIllustrationPlan";
import { GrowthRepository } from "../../../domain/growth/growthRepository";
import { CreativeDocumentRepository } from "../../../domain/workspace/creativeDocumentRepository";
import { DocumentRepository } from "../../../domain/workspace/documentRepository";
import { ResourceRepository } from "../../../domain/workspace/resourceRepository";
import { SemanticGraphService } from "../../../domain/graph/semanticGraphService";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import type { GrowthIllustrationCreateRequest } from "../../../shared/growthPresentationContract";
import type { AgentToolGateway } from "../../agentProcessSupervisor";
import { resolveAuthorizedGrowthResources } from "../growthCreatorScope";
import { GrowthIllustrationCoordinator, type GrowthIllustrationSnapshotInput } from "./growthIllustrationCoordinator";

interface IllustrationApplicationContext {
  checkpointId: string;
  branchId: string;
  authorizedScopeResourceIds: string[];
}

/** Creator-only application boundary for persisted source-bound illustration requests. */
export class GrowthIllustrationApplicationService {
  readonly #growth: GrowthRepository;
  readonly #coordinator: GrowthIllustrationCoordinator;
  readonly #controllers = new Map<string, AbortController>();

  constructor(readonly workspace: WorkspaceDatabase, gateway: Pick<AgentToolGateway, "generateImage">) {
    this.#growth = new GrowthRepository(workspace);
    this.#coordinator = new GrowthIllustrationCoordinator(workspace, gateway);
  }

  create(input: GrowthIllustrationCreateRequest, context: IllustrationApplicationContext): void {
    const existing = this.#growth.getIllustrationRequest(input.requestId);
    if (existing) {
      if (existing.goalId !== input.goalId) throw applicationError("GROWTH_ILLUSTRATION_REQUEST_AUTHORITY_MISMATCH");
      const cycle = this.#growth.getCycle(existing.cycleId);
      if (!cycle || cycle.goalId !== existing.goalId || cycle.ruleRevision !== existing.ruleRevision) {
        throw applicationError("GROWTH_ILLUSTRATION_REQUEST_AUTHORITY_MISMATCH");
      }
      const pinnedContext = { ...context, checkpointId: cycle.outputCheckpointId ?? cycle.inputCheckpointId };
      const compiled = this.#compile(input, pinnedContext, existing.ruleRevision);
      this.#coordinator.persist({
        request: {
          id: existing.id,
          goalId: existing.goalId,
          cycleId: existing.cycleId,
          ruleRevision: existing.ruleRevision,
          closureProfileId: existing.closureProfileId,
          closureRevision: existing.closureRevision,
          idempotencyKey: `growth-illustration-ui:${existing.goalId}:${existing.id}`,
        },
        plan: compiled.plan,
        snapshots: compiled.snapshots,
      });
      return;
    }
    const goal = this.#growth.getGoal(input.goalId);
    if (!goal || goal.branchId !== context.branchId || !sameStrings(goal.authorizedScopeResourceIds, context.authorizedScopeResourceIds)) {
      throw applicationError("GROWTH_ILLUSTRATION_REQUEST_AUTHORITY_MISMATCH");
    }
    const cycle = this.#growth.listCycles(goal.id).filter((candidate) => (
      !["blocked", "failed", "cancelled", "reconciliation_required"].includes(candidate.status)
      && (candidate.outputCheckpointId ?? candidate.inputCheckpointId) === context.checkpointId
    )).at(-1);
    if (!cycle) {
      throw applicationError("GROWTH_ILLUSTRATION_CHECKPOINT_NOT_CURRENT");
    }
    const compiled = this.#compile(input, context, cycle.ruleRevision);
    this.#coordinator.persist({
      request: {
        id: input.requestId,
        goalId: goal.id,
        cycleId: cycle.id,
        ruleRevision: cycle.ruleRevision,
        closureProfileId: null,
        closureRevision: null,
        idempotencyKey: `growth-illustration-ui:${goal.id}:${input.requestId}`,
      },
      plan: compiled.plan,
      snapshots: compiled.snapshots,
    });
    const controller = new AbortController();
    this.#controllers.set(input.requestId, controller);
    void this.#coordinator.execute({ requestId: input.requestId, plan: compiled.plan, signal: controller.signal })
      .catch(() => undefined)
      .finally(() => this.#controllers.delete(input.requestId));
  }

  cancel(input: { goalId: string; requestId: string }): void {
    const request = this.#growth.getIllustrationRequest(input.requestId);
    if (!request || request.goalId !== input.goalId) {
      throw applicationError("GROWTH_ILLUSTRATION_REQUEST_AUTHORITY_MISMATCH");
    }
    this.#controllers.get(input.requestId)?.abort();
    for (const item of this.#growth.listIllustrationItems(input.requestId)) {
      if (item.status === "planned" && item.imageJobId === null) this.#growth.cancelIllustrationItem(item.id);
    }
  }

  dispose(): void {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
  }

  #compile(input: GrowthIllustrationCreateRequest, context: IllustrationApplicationContext, ruleRevision: number) {
    const resources = new ResourceRepository(this.workspace).listAtCheckpoint(context.checkpointId);
    const authorized = resolveAuthorizedGrowthResources(resources, context.authorizedScopeResourceIds);
    const resolved = resolveTarget(this.workspace, input, context.checkpointId, authorized);
    const styleFields = input.visualStyle ? { styleMode: "user_override" as const, userVisualSummary: input.visualStyle } : {};
    const planInput = {
      coverageMode: "custom" as const,
      items: Array.from({ length: input.variantCount }, (_, index) => ({
        targetEvidenceRef: resolved.targetEvidenceRef,
        evidenceRefs: resolved.evidenceBindings.map((binding) => binding.evidenceRef),
        purpose: input.purpose,
        title: input.variantCount === 1 ? input.title : `${input.title} · 变体 ${index + 1}`,
        compositionDescription: input.compositionDescription,
        variantKey: `manual_${String(index + 1).padStart(3, "0")}`,
        ...styleFields,
      })),
    };
    const trusted: TrustedGrowthIllustrationCompileInput = {
      authorizedScopeResourceIds: context.authorizedScopeResourceIds,
      currentRuleRevision: input.visualStyle ? {
        revision: ruleRevision,
        visualOverride: { summary: input.visualStyle, positive: [input.visualStyle], negative: [] },
      } : { revision: ruleRevision },
      evidenceBindings: resolved.evidenceBindings,
    };
    return { plan: compileGrowthIllustrationPlan(planInput, trusted), snapshots: resolved.snapshots };
  }
}

function resolveTarget(
  workspace: WorkspaceDatabase,
  input: GrowthIllustrationCreateRequest,
  checkpointId: string,
  authorized: ReturnType<typeof resolveAuthorizedGrowthResources>,
): { targetEvidenceRef: string; evidenceBindings: TrustedGrowthIllustrationCompileInput["evidenceBindings"]; snapshots: GrowthIllustrationSnapshotInput[] } {
  const documents = new DocumentRepository(workspace);
  if (input.target.kind === "graph_node") {
    const evidence = new SemanticGraphService(workspace).inspectCreatorNodeEvidence(input.target.nodeId);
    const inspector = evidence.inspector;
    const owner = authorized.get(evidence.sourceResourceId);
    if (!owner) throw applicationError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
    const revisionId = currentResourceRevisionId(workspace, owner.resource.id, checkpointId);
    if (!revisionId) throw applicationError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
    const text = inspector.detail.kind === "fact"
      ? `${inspector.detail.subject}\n${inspector.detail.predicate}\n${inspector.detail.valueSummary}`
      : `${inspector.detail.label}\n${inspector.detail.description}`;
    const textSha256 = sha256(text);
    const snapshotId = `growth-snapshot:${sha256(`${input.goalId}:${input.requestId}:graph_node:${input.target.nodeId}:${textSha256}`).slice(0, 48)}`;
    return {
      targetEvidenceRef: "target",
      evidenceBindings: [{
        evidenceRef: "target", scopeResourceId: owner.scopeRootId, defaultCoverageRole: coverageRole(owner.resource.objectKind),
        source: { kind: "resource", resourceId: owner.resource.id, resourceVersionId: revisionId },
        authorizedFacts: text,
        targetAnchorInput: { kind: "working_text_snapshot", sourceSnapshotId: snapshotId, textSha256 },
      }],
      snapshots: [{ id: snapshotId, kind: "working_text_snapshot", text, textSha256 }],
    };
  }
  if (input.target.kind === "stable_text_span") {
    const version = documents.getVersion(input.target.documentVersionId);
    const current = documents.getStableForCreativeDocumentAtCheckpoint(input.target.documentId, checkpointId);
    const owner = version ? authorized.get(version.resourceId) : null;
    if (!version || version.creativeDocumentId !== input.target.documentId || current?.id !== version.id || !owner) {
      throw applicationError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
    }
    const text = Array.from(version.content).slice(input.target.startCodePoint, input.target.endCodePoint).join("");
    if (text.length === 0 || Array.from(text).length > 8_000 || sha256(text) !== input.target.textSha256) {
      throw applicationError("GROWTH_ILLUSTRATION_TEXT_SPAN_INVALID");
    }
    return {
      targetEvidenceRef: "target",
      evidenceBindings: [{
        evidenceRef: "target", scopeResourceId: owner.scopeRootId, defaultCoverageRole: "supporting",
        source: { kind: "document", documentId: input.target.documentId, documentVersionId: version.id, contentSha256: version.contentHash },
        authorizedFacts: text,
        targetAnchorInput: { ...input.target },
      }],
      snapshots: [],
    };
  }

  const resourceId = input.target.kind === "resource" ? input.target.resourceId : input.target.sourceResourceId;
  const owner = authorized.get(resourceId);
  if (!owner) throw applicationError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
  const revisionId = currentResourceRevisionId(workspace, resourceId, checkpointId);
  if (!revisionId) throw applicationError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
  if (input.target.kind === "working_text_snapshot" || input.target.kind === "conversation_text_snapshot") {
    const text = input.target.text;
    if (Array.from(text).length > 8_000) throw applicationError("GROWTH_ILLUSTRATION_SNAPSHOT_TOO_LONG");
    const textSha256 = sha256(text);
    const snapshotId = `growth-snapshot:${sha256(`${input.goalId}:${input.requestId}:${input.target.kind}:${textSha256}`).slice(0, 48)}`;
    return {
      targetEvidenceRef: "target",
      evidenceBindings: [{
        evidenceRef: "target", scopeResourceId: owner.scopeRootId, defaultCoverageRole: "supporting",
        source: { kind: "resource", resourceId, resourceVersionId: revisionId },
        authorizedFacts: text,
        targetAnchorInput: { kind: input.target.kind, sourceSnapshotId: snapshotId, textSha256 },
      }],
      snapshots: [{ id: snapshotId, kind: input.target.kind, text, textSha256 }],
    };
  }

  const evidenceBindings: TrustedGrowthIllustrationCompileInput["evidenceBindings"] = [{
    evidenceRef: "target", scopeResourceId: owner.scopeRootId, defaultCoverageRole: coverageRole(owner.resource.objectKind),
    source: { kind: "resource", resourceId, resourceVersionId: revisionId },
    authorizedFacts: `${owner.resource.title}（${owner.resource.objectKind}）`,
    targetAnchorInput: { kind: "resource", resourceId, resourceVersionId: revisionId },
  }];
  const creativeDocuments = new CreativeDocumentRepository(workspace).listAtCheckpoint(checkpointId, resourceId);
  for (const [index, document] of creativeDocuments.entries()) {
    const version = documents.getStableForCreativeDocumentAtCheckpoint(document.id, checkpointId);
    if (!version || !version.content.trim()) continue;
    evidenceBindings.push({
      evidenceRef: `document-${index + 1}`, scopeResourceId: owner.scopeRootId, defaultCoverageRole: "supporting",
      source: { kind: "document", documentId: document.id, documentVersionId: version.id, contentSha256: version.contentHash },
      authorizedFacts: Array.from(version.content).slice(0, 8_000).join(""),
      targetAnchorInput: { kind: "stable_text_span", documentId: document.id, documentVersionId: version.id,
        startCodePoint: 0, endCodePoint: Math.min(Array.from(version.content).length, 8_000),
        textSha256: sha256(Array.from(version.content).slice(0, 8_000).join("")) },
    });
  }
  return { targetEvidenceRef: "target", evidenceBindings, snapshots: [] };
}

function currentResourceRevisionId(workspace: WorkspaceDatabase, resourceId: string, checkpointId: string): string | null {
  const row = workspace.db.prepare(`
    WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
      SELECT ?, 0 UNION ALL
      SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints
      JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id WHERE checkpoints.parent_checkpoint_id IS NOT NULL
    ), ranked AS (
      SELECT revisions.id, revisions.state, ROW_NUMBER() OVER (ORDER BY ancestry.depth, revisions.created_at DESC, revisions.rowid DESC) AS revision_rank
      FROM resource_revisions revisions JOIN ancestry ON ancestry.checkpoint_id = revisions.created_checkpoint_id
      WHERE revisions.resource_id = ?
    ) SELECT id FROM ranked WHERE revision_rank = 1 AND state = 'active'
  `).get(checkpointId, resourceId) as { id: string } | undefined;
  return row?.id ?? null;
}

function coverageRole(kind: string): "world" | "place_or_faction" | "story" | "major_oc" | "important_detail" | "supporting" {
  return kind === "world" ? "world" : kind === "location" || kind === "faction" ? "place_or_faction"
    : kind === "story" || kind === "volume" ? "story" : kind === "oc" ? "major_oc" : "supporting";
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function applicationError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth illustration request rejected."), { code });
}
