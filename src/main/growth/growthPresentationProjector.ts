import { createHash } from "node:crypto";
import { ChangeSetRepository } from "../../domain/changeSet/changeSetRepository";
import { GrowthEditorialRepository } from "../../domain/growth/editorial/growthEditorialRepository";
import { GrowthLongformProgressResolver } from "../../domain/growth/growthLongformProgress";
import { GrowthRepository } from "../../domain/growth/growthRepository";
import { ImageAssetRepository } from "../../domain/asset/imageAssetRepository";
import { DocumentRepository } from "../../domain/workspace/documentRepository";
import { ResourceRepository, type ResourceRecord } from "../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../domain/workspace/workspaceRepository";
import {
  growthPresentationCapabilityVersion,
  growthPresentationSnapshotSchema,
  type GrowthPresentationSnapshot,
} from "../../shared/growthPresentationContract";
import { resolveAuthorizedGrowthResources } from "./growthCreatorScope";

/** Read-only Creator projection. It never exposes Prompt, locator, path, hashes, or hidden Lens data. */
export class GrowthPresentationProjector {
  readonly #growth: GrowthRepository;
  readonly #images: ImageAssetRepository;
  readonly #documents: DocumentRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#growth = new GrowthRepository(workspace);
    this.#images = new ImageAssetRepository(workspace);
    this.#documents = new DocumentRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  project(input: { goalId: string; checkpointId: string }): GrowthPresentationSnapshot {
    const goal = this.#growth.getGoal(input.goalId);
    if (!goal) throw presentationError("GROWTH_GOAL_NOT_FOUND");
    const resources = this.#resources.listAtCheckpoint(input.checkpointId);
    const visible = new Map([...resolveAuthorizedGrowthResources(resources, goal.authorizedScopeResourceIds)]
      .map(([id, entry]) => [id, entry.resource]));
    const cycles = this.#growth.listCycles(goal.id);
    const current = cycles.at(-1) ?? null;
    const currentRuleRevision = this.#growth.getRuleRevision(goal.id, goal.currentRuleRevision);
    const illustrationRequests = this.#illustrations(goal.id, visible, input.checkpointId);

    return growthPresentationSnapshotSchema.parse({
      capabilityVersion: growthPresentationCapabilityVersion,
      goalId: goal.id,
      currentRuleRevision: goal.currentRuleRevision,
      activeCycleRuleRevision: current?.status === "planned" || current?.status === "running" ? current.ruleRevision : null,
      guidanceStatus: current && goal.currentRuleRevision > current.ruleRevision
        ? "persisted_pending_boundary"
        : goal.currentRuleRevision > 1 && current?.ruleRevision === currentRuleRevision.revision ? "applied" : "none",
      impacts: this.#impacts(cycles),
      inquirySummaries: this.#growth.listEvents(goal.id)
        .filter((event) => event.phase === "inquiry_selected" || event.phase === "creator_choice_required")
        .slice(-100)
        .map((event) => event.safeSummary),
      closures: this.#closures(goal.id, visible),
      longform: this.#longform(goal.id, input.checkpointId, visible),
      illustrationRequests,
      activityEvents: this.#activityEvents(goal.id, illustrationRequests),
    });
  }

  #activityEvents(
    goalId: string,
    illustrationRequests: GrowthPresentationSnapshot["illustrationRequests"],
  ): GrowthPresentationSnapshot["activityEvents"] {
    const events: GrowthPresentationSnapshot["activityEvents"] = [];
    const editorial = new GrowthEditorialRepository(this.workspace);
    for (const snapshot of editorial.listRoundSnapshotsForGoal(goalId)) {
      events.push(activityEvent({
        identity: [snapshot.round.id, "planning"],
        kind: "director_planning",
        actor: "world_director",
        workOrderId: null,
        safeSummary: `世界总编已安排 ${snapshot.workOrders.length} 项工作。`,
        occurredAt: snapshot.round.createdAt,
      }));
      for (const order of snapshot.workOrders) {
        const attempts = snapshot.attempts.filter((attempt) => attempt.workOrderId === order.id);
        events.push(activityEvent({
          identity: [snapshot.round.id, order.id, "assigned", "initial"],
          kind: "employee_assigned",
          actor: order.capability,
          workOrderId: order.id,
          safeSummary: null,
          occurredAt: order.createdAt,
        }));
        for (const attempt of attempts.filter((candidate) => candidate.attemptNumber > 1)) {
          events.push(activityEvent({
            identity: [snapshot.round.id, order.id, "assigned", String(attempt.attemptNumber)],
            kind: "employee_assigned",
            actor: attempt.capability,
            workOrderId: order.id,
            safeSummary: null,
            occurredAt: attempt.createdAt,
          }));
        }
        for (const attempt of attempts) {
          const candidateAt = snapshot.artifacts
            .filter((artifact) => artifact.attemptId === attempt.id
              && artifact.kind !== "checker_review" && artifact.kind !== "director_review")
            .map((artifact) => artifact.createdAt)
            .sort()[0];
          if (attempt.outputSha256 && candidateAt) {
            events.push(activityEvent({
              identity: [snapshot.round.id, order.id, attempt.id, "candidate"],
              kind: "candidate_ready",
              actor: attempt.capability,
              workOrderId: order.id,
              safeSummary: null,
              occurredAt: candidateAt,
            }));
          }
        }
        for (const review of snapshot.reviews.filter((candidate) => candidate.workOrderId === order.id)) {
          events.push(activityEvent({
            identity: [snapshot.round.id, order.id, review.id, "checking"],
            kind: "checking",
            actor: review.reviewerKind === "checker" ? "checker" : "world_director",
            workOrderId: order.id,
            safeSummary: review.safeSummary,
            occurredAt: review.createdAt,
          }));
          if (review.reviewerKind === "director" && review.decision === "revise") {
            events.push(activityEvent({
              identity: [snapshot.round.id, order.id, review.id, "revision"],
              kind: "revision_requested",
              actor: order.capability,
              workOrderId: order.id,
              safeSummary: review.safeSummary,
              occurredAt: review.createdAt,
            }));
          }
        }
        if (order.status === "committed") {
          events.push(activityEvent({
            identity: [snapshot.round.id, order.id, "committed"],
            kind: "committed",
            actor: "world_director",
            workOrderId: order.id,
            safeSummary: null,
            occurredAt: order.updatedAt,
          }));
        }
      }
    }
    for (const request of illustrationRequests) {
      for (const item of request.items) {
        const kind = item.status === "ready" ? "image_ready"
          : item.status === "failed" ? "image_failed"
            : item.status === "queued" || item.status === "running" ? "image_queued"
              : null;
        if (!kind) continue;
        events.push(activityEvent({
          identity: [request.id, item.id, kind],
          kind,
          actor: "visual_director",
          workOrderId: null,
          safeSummary: item.title,
          occurredAt: item.updatedAt,
        }));
      }
    }
    return events
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
        || activityKindOrder(left.kind) - activityKindOrder(right.kind)
        || left.id.localeCompare(right.id))
      .slice(-5_000);
  }

  #impacts(cycles: ReturnType<GrowthRepository["listCycles"]>) {
    const changes = new ChangeSetRepository(this.workspace);
    return cycles.map((cycle) => {
      const outputs = cycle.changeSetId ? changes.listOutputs(cycle.changeSetId) : [];
      return {
        cycleId: cycle.id,
        sequence: cycle.sequence,
        durableState: cycle.status,
        resourceCount: outputs.filter((output) => output.kind === "resource_revision").length,
        documentCount: outputs.filter((output) => output.kind === "document_version").length,
        assertionCount: outputs.filter((output) => output.kind === "assertion_version").length,
        relationCount: outputs.filter((output) => output.kind === "creative_relation_revision").length,
      };
    });
  }

  #closures(goalId: string, visible: Map<string, ResourceRecord>) {
    return this.#growth.listClosureStates(goalId).map((state) => {
      if (state.subjectResourceId && !visible.has(state.subjectResourceId)) {
        throw presentationError("GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE");
      }
      const review = this.#growth.listClosureReviewsV4(state.profileId).at(-1) ?? null;
      return {
        profileId: state.profileId,
        profileKind: presentationClosureKind(state.profileKind),
        subjectResourceId: state.subjectResourceId,
        revision: state.revision,
        contentState: state.contentState,
        visualState: state.visualState,
        satisfiedCount: state.satisfiedFacetIds.length,
        missingCount: state.missingFacetIds.length,
        checkerDecision: review?.checkerDecision ?? null,
        findings: (review?.adverseFindings ?? []).map((finding) => ({
          severity: finding.severity,
          category: finding.category,
          safeSummary: finding.safeSummary,
          repairObjective: finding.repairObjective,
        })),
        lastProgressCycleSequence: state.lastProgressCycleSequence,
      };
    });
  }

  #longform(goalId: string, checkpointId: string, visible: Map<string, ResourceRecord>): GrowthPresentationSnapshot["longform"] {
    const candidates = this.#growth.listClosureStates(goalId).flatMap((state) => {
      const revision = this.#growth.getClosureRevision(state.profileId, state.revision);
      return revision?.focusOcResourceId ? [{ state, focusOcResourceId: revision.focusOcResourceId }] : [];
    });
    if (candidates.length === 0) return { status: "unavailable" };
    const focus = candidates.at(-1)!;
    const progress = new GrowthLongformProgressResolver(this.workspace).resolve({
      checkpointId,
      focusOcResourceId: focus.focusOcResourceId,
    });
    if (!visible.has(progress.focusOcResourceId)) throw presentationError("GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE");
    if (progress.status === "blocked") {
      return { status: "blocked", focusOcResourceId: progress.focusOcResourceId, reasonCode: progress.reason };
    }
    if (!visible.has(progress.personalStoryResourceId)) throw presentationError("GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE");
    return {
      status: "ready",
      focusOcResourceId: progress.focusOcResourceId,
      personalStoryResourceId: progress.personalStoryResourceId,
      storyTitle: progress.outline.storyTitle,
      completedSectionCount: progress.completedSections.length,
      totalSectionCount: progress.outline.sections.length,
      totalCodePoints: progress.totalCodePoints,
      currentSectionTitle: progress.nextSection?.title ?? null,
      complete: progress.complete,
    };
  }

  #illustrations(
    goalId: string,
    visible: Map<string, ResourceRecord>,
    checkpointId: string,
  ): GrowthPresentationSnapshot["illustrationRequests"] {
    return this.#growth.listIllustrationRequests(goalId).slice(-1_000).map((request) => ({
      id: request.id,
      status: request.status,
      coverageMode: request.coverageMode,
      itemCount: request.itemCount,
      readyCount: request.readyCount,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      items: this.#growth.listIllustrationItems(request.id).slice(-10_000).map((item) => {
        const job = item.imageJobId ? this.#images.getRequiredJob(item.imageJobId) : null;
        const asset = job ? this.#images.getAssetByJob(job.id) : null;
        const status = asset?.status === "stale" ? "stale"
          : job?.status === "succeeded" && asset ? "ready"
            : job?.status === "running" ? "running"
              : job?.status === "queued" ? "queued"
                : job?.status === "failed" ? "failed"
                  : job?.status === "reconciliation_required" ? "reconciliation_required"
                    : item.status;
        return {
          id: item.id,
          requestId: item.requestId,
          purpose: presentationImagePurpose(item.purpose),
          title: item.title,
          variantKey: item.variantKey,
          status,
          source: this.#source(item, visible, checkpointId),
          imageJobId: item.imageJobId,
          assetId: asset?.id ?? null,
          thumbnailUrl: asset && (status === "ready" || status === "stale")
            ? `novax-asset://image/${encodeURIComponent(asset.id)}` : null,
          mimeType: asset?.mimeType ?? null,
          width: asset?.width ?? null,
          height: asset?.height ?? null,
          createdAt: item.createdAt,
          updatedAt: job?.updatedAt ?? item.updatedAt,
        };
      }),
    }));
  }

  #source(
    item: ReturnType<GrowthRepository["getIllustrationItem"]> extends infer T ? NonNullable<T> : never,
    visible: Map<string, ResourceRecord>,
    checkpointId: string,
  ): { kind: "resource" | "stable_text_span" | "working_text_snapshot" | "conversation_text_snapshot"; sourceResourceId: string; label: string; excerpt: string | null } {
    const ownerId = item.sources[0]?.kind === "resource"
      ? item.sources[0].resourceId
      : item.sources[0] && this.#documents.getVersion(item.sources[0].documentVersionId)?.resourceId;
    const owner = ownerId ? visible.get(ownerId) : null;
    if (!owner) throw presentationError("GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE");
    if (item.anchor.kind === "resource") return { kind: "resource", sourceResourceId: owner.id, label: owner.title, excerpt: null };
    if (item.anchor.kind === "stable_text_span") {
      const version = this.#documents.getVersion(item.anchor.documentVersionId);
      const current = this.#documents.getStableForCreativeDocumentAtCheckpoint(item.anchor.documentId, checkpointId);
      if (!version || current?.id !== version.id || version.resourceId !== owner.id) {
        return { kind: "stable_text_span", sourceResourceId: owner.id, label: `${owner.title} · 已过期片段`, excerpt: null };
      }
      const excerpt = Array.from(version.content).slice(item.anchor.startCodePoint, item.anchor.endCodePoint).join("");
      return { kind: "stable_text_span", sourceResourceId: owner.id, label: `${owner.title} · 文本片段`, excerpt: boundedExcerpt(excerpt) };
    }
    const request = this.#growth.getIllustrationRequest(item.requestId);
    if (!request) throw presentationError("GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE");
    const snapshot = this.workspace.db.prepare(`
      SELECT snapshot_text FROM growth_illustration_text_snapshots WHERE id = ? AND goal_id = ?
    `).get(item.anchor.sourceSnapshotId, request.goalId) as { snapshot_text: string } | undefined;
    if (!snapshot) throw presentationError("GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE");
    return { kind: item.anchor.kind, sourceResourceId: owner.id, label: `${owner.title} · 创作快照`, excerpt: boundedExcerpt(snapshot.snapshot_text) };
  }
}

function boundedExcerpt(value: string): string {
  return Array.from(value).slice(0, 1_000).join("");
}

function activityEvent(input: {
  identity: string[];
  kind: GrowthPresentationSnapshot["activityEvents"][number]["kind"];
  actor: GrowthPresentationSnapshot["activityEvents"][number]["actor"];
  workOrderId: string | null;
  safeSummary: string | null;
  occurredAt: string;
}): GrowthPresentationSnapshot["activityEvents"][number] {
  return {
    id: `growth-activity-${createHash("sha256").update(JSON.stringify(input.identity)).digest("hex").slice(0, 32)}`,
    kind: input.kind,
    actor: input.actor,
    workOrderId: input.workOrderId,
    safeSummary: input.safeSummary,
    occurredAt: input.occurredAt,
  };
}

function activityKindOrder(kind: GrowthPresentationSnapshot["activityEvents"][number]["kind"]): number {
  return ({
    director_planning: 0,
    employee_assigned: 1,
    candidate_ready: 2,
    checking: 3,
    revision_requested: 4,
    committed: 5,
    image_queued: 6,
    image_ready: 7,
    image_failed: 8,
  })[kind];
}

function presentationClosureKind(kind: string): "world" | "story" | "oc" | "mixed" {
  if (kind === "world_birth") return "world";
  if (kind === "story_universe") return "story";
  if (kind === "oc_saga") return "oc";
  if (kind === "mixed_birth") return "mixed";
  throw presentationError("GROWTH_PRESENTATION_CLOSURE_KIND_INVALID");
}

function presentationImagePurpose(value: string): "character_portrait" | "scene" | "world_map" {
  if (value === "character_portrait" || value === "scene" || value === "world_map") return value;
  throw presentationError("GROWTH_PRESENTATION_IMAGE_PURPOSE_INVALID");
}

function presentationError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth presentation projection failed."), { code });
}
