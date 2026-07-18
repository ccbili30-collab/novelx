import { createHash } from "node:crypto";
import {
  compileGrowthIllustrationPlan,
  type CompiledGrowthIllustrationPlan,
  type TrustedGrowthIllustrationCompileInput,
} from "../../../agent-worker/growth/growthIllustrationPlan";
import { ChangeSetRepository } from "../../../domain/changeSet/changeSetRepository";
import { GrowthRepository } from "../../../domain/growth/growthRepository";
import { ResourceRepository, type ResourceRecord } from "../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import { resolveAuthorizedGrowthResources } from "../growthCreatorScope";
import { resolveResourceIllustrationEvidence } from "./growthIllustrationEvidenceResolver";

const INCREMENTAL_VARIANT = "primary";
const VISUAL_TARGET_KINDS = new Set<ResourceRecord["objectKind"]>([
  "world", "oc", "story", "volume", "chapter", "location", "faction", "oc_variant",
]);

export interface GrowthIncrementalIllustrationCandidate {
  requestId: string;
  idempotencyKey: string;
  sourceResourceId: string;
  sourceVersionId: string;
  variantKey: string;
  plan: CompiledGrowthIllustrationPlan;
}

export interface CompileGrowthIncrementalIllustrationsInput {
  goalId: string;
  cycleId: string;
  branchId: string;
  authorizedScopeResourceIds: string[];
}

/**
 * Compiles one immutable queue candidate for every visual resource revision
 * produced by a committed Growth Change Set. It never invokes a Provider.
 */
export function compileGrowthIncrementalIllustrations(
  workspace: WorkspaceDatabase,
  input: CompileGrowthIncrementalIllustrationsInput,
): GrowthIncrementalIllustrationCandidate[] {
  const growth = new GrowthRepository(workspace);
  const goal = growth.getGoal(input.goalId);
  const cycle = growth.getCycle(input.cycleId);
  if (!goal || !cycle || cycle.goalId !== goal.id || goal.branchId !== input.branchId
    || !sameStrings(goal.authorizedScopeResourceIds, input.authorizedScopeResourceIds)) {
    throw incrementalError("GROWTH_ILLUSTRATION_REQUEST_AUTHORITY_MISMATCH");
  }
  if (cycle.status !== "committed" || !cycle.changeSetId || !cycle.outputCheckpointId) {
    throw incrementalError("GROWTH_ILLUSTRATION_COMMITTED_CHANGE_SET_REQUIRED");
  }
  const changeSets = new ChangeSetRepository(workspace);
  const changeSet = changeSets.get(cycle.changeSetId);
  if (!changeSet || changeSet.status !== "committed" || changeSet.branchId !== goal.branchId
    || changeSet.committedCheckpointId !== cycle.outputCheckpointId) {
    throw incrementalError("GROWTH_ILLUSTRATION_COMMITTED_CHANGE_SET_REQUIRED");
  }

  const resources = new ResourceRepository(workspace);
  const authorized = resolveAuthorizedGrowthResources(
    resources.listAtCheckpoint(cycle.outputCheckpointId),
    goal.authorizedScopeResourceIds,
  );
  const targets = changeSets.listOutputs(changeSet.id)
    .filter((output) => output.kind === "resource_revision")
    .flatMap((output) => {
      const resource = resources.getVisibleByRevisionIdAtCheckpoint(output.outputId, cycle.outputCheckpointId!);
      return resource && VISUAL_TARGET_KINDS.has(resource.objectKind)
        ? [{ resource, revisionId: output.outputId }]
        : [];
    })
    .filter((target, index, all) => all.findIndex((candidate) => candidate.revisionId === target.revisionId) === index)
    .sort((left, right) => compareStrings(left.resource.id, right.resource.id)
      || compareStrings(left.revisionId, right.revisionId));

  return targets.map(({ resource, revisionId }) => {
    const owner = authorized.get(resource.id);
    if (!owner) throw incrementalError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
    const identity = sha256(`${goal.id}:${resource.id}:${revisionId}:${INCREMENTAL_VARIANT}`);
    const evidencePrefix = `incremental_${identity.slice(0, 24)}`;
    const resolved = resolveResourceIllustrationEvidence({
      workspace,
      owner,
      checkpointId: cycle.outputCheckpointId!,
      targetEvidenceRef: `${evidencePrefix}_resource`,
      documentEvidenceRef: (index) => `${evidencePrefix}_document_${String(index + 1).padStart(3, "0")}`,
    });
    const variantKey = `incremental_${identity.slice(0, 40)}`;
    const trusted: TrustedGrowthIllustrationCompileInput = {
      authorizedScopeResourceIds: goal.authorizedScopeResourceIds,
      currentRuleRevision: { revision: cycle.ruleRevision },
      evidenceBindings: resolved.evidenceBindings,
    };
    const plan = compileGrowthIllustrationPlan({
      coverageMode: "custom",
      items: [{
        targetEvidenceRef: resolved.targetEvidenceRef,
        evidenceRefs: resolved.evidenceBindings.map((binding) => binding.evidenceRef),
        purpose: illustrationPurpose(resource.objectKind),
        title: incrementalTitle(resource),
        compositionDescription: incrementalComposition(resource),
        variantKey,
      }],
    }, trusted);
    return {
      requestId: `growth-incremental-illustration:${identity.slice(0, 48)}`,
      idempotencyKey: `growth-incremental-illustration:${identity}`,
      sourceResourceId: resource.id,
      sourceVersionId: revisionId,
      variantKey,
      plan,
    };
  });
}

function illustrationPurpose(kind: ResourceRecord["objectKind"]): "world_map" | "character_portrait" | "scene" {
  return kind === "world" ? "world_map"
    : kind === "oc" || kind === "oc_variant" ? "character_portrait"
      : "scene";
}

function incrementalTitle(resource: ResourceRecord): string {
  return resource.objectKind === "world" ? `${resource.title} · 世界地图`
    : resource.objectKind === "oc" || resource.objectKind === "oc_variant" ? `${resource.title} · 角色立绘`
      : `${resource.title} · 节点插画`;
}

function incrementalComposition(resource: ResourceRecord): string {
  if (resource.objectKind === "world") {
    return `依据受信资料，为“${resource.title}”规划一张世界地图；只表现资料明确支持的地理关系，不添加虚构地名或标签。`;
  }
  if (resource.objectKind === "oc" || resource.objectKind === "oc_variant") {
    return `依据受信资料，为“${resource.title}”规划一张角色立绘；只表现资料明确支持的身份、外观与装备。`;
  }
  return `依据受信资料，为“${resource.title}”规划一张节点插画；只表现资料明确支持的环境、人物与事件。`;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function incrementalError(code: string): Error & { code: string } {
  return Object.assign(new Error("Incremental Growth illustration planning failed."), { code });
}
