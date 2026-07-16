import {
  compileGrowthIllustrationPlan,
  type CompiledGrowthIllustrationPlan,
  type TrustedGrowthIllustrationCompileInput,
} from "../../../agent-worker/growth/growthIllustrationPlan";
import { ResourceRepository, type ResourceRecord } from "../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import { resolveAuthorizedGrowthResources } from "../growthCreatorScope";
import { resolveResourceIllustrationEvidence } from "./growthIllustrationEvidenceResolver";

interface CompileDefaultGrowthIllustrationPlanInput {
  checkpointId: string;
  authorizedScopeResourceIds: string[];
  ruleRevision: number;
  resourceRevisionOutputIds: string[];
}

type DefaultTargetKind = "oc" | "place" | "story";
interface DefaultTarget {
  kind: DefaultTargetKind;
  resource: ResourceRecord;
}

/** Selects default visual targets from the accepted, Creator-authorized checkpoint. */
export function compileDefaultGrowthIllustrationPlan(
  workspace: WorkspaceDatabase,
  input: CompileDefaultGrowthIllustrationPlanInput,
): CompiledGrowthIllustrationPlan {
  const authorized = resolveAuthorizedGrowthResources(
    new ResourceRepository(workspace).listAtCheckpoint(input.checkpointId),
    input.authorizedScopeResourceIds,
  );
  const resources = new ResourceRepository(workspace);
  const lineageResources = new Map(input.resourceRevisionOutputIds.flatMap((revisionId) => {
    const resource = resources.getVisibleByRevisionIdAtCheckpoint(revisionId, input.checkpointId);
    return resource ? [[resource.id, resource] as const] : [];
  }));
  const worlds = [...lineageResources.values()].filter((resource) => resource.objectKind === "world");
  if (worlds.length !== 1) throw defaultPlanError("GROWTH_ILLUSTRATION_DEFAULT_TARGETS_INCOMPLETE");
  const worldOwner = authorized.get(worlds[0]!.id);
  if (!worldOwner) throw defaultPlanError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
  const worldContext = resolveResourceIllustrationEvidence({
    workspace,
    owner: worldOwner,
    checkpointId: input.checkpointId,
    targetEvidenceRef: "world_context_resource",
    documentEvidenceRef: (index) => `world_context_document_${String(index + 1).padStart(3, "0")}`,
  });
  const contextualBindings = worldContext.evidenceBindings.map((binding) => ({
    ...binding,
    defaultCoverageRole: "supporting" as const,
  }));
  const targets = [...lineageResources.values()]
    .flatMap((resource): DefaultTarget[] => resource.objectKind === "oc"
      ? [{ kind: "oc", resource }]
      : resource.objectKind === "location" || resource.objectKind === "faction"
        ? [{ kind: "place", resource }]
        : resource.objectKind === "story" ? [{ kind: "story", resource }] : [])
    .sort(compareTargets);
  const targetKinds = new Set(targets.map((target) => target.kind));
  if (!["oc", "place", "story"].every((kind) => targetKinds.has(kind as DefaultTargetKind))) {
    throw defaultPlanError("GROWTH_ILLUSTRATION_DEFAULT_TARGETS_INCOMPLETE");
  }

  const counters = new Map<DefaultTargetKind, number>();
  const evidenceBindings: TrustedGrowthIllustrationCompileInput["evidenceBindings"] = [...contextualBindings];
  const items = targets.map((target) => {
    const index = (counters.get(target.kind) ?? 0) + 1;
    counters.set(target.kind, index);
    const prefix = `${target.kind}_${String(index).padStart(3, "0")}`;
    const owner = authorized.get(target.resource.id);
    if (!owner) throw defaultPlanError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
    const resolved = resolveResourceIllustrationEvidence({
      workspace,
      owner,
      checkpointId: input.checkpointId,
      targetEvidenceRef: `${prefix}_resource`,
      documentEvidenceRef: (documentIndex) => `${prefix}_document_${String(documentIndex + 1).padStart(3, "0")}`,
    });
    evidenceBindings.push(...resolved.evidenceBindings);
    return {
      targetEvidenceRef: resolved.targetEvidenceRef,
      evidenceRefs: [
        ...resolved.evidenceBindings.map((binding) => binding.evidenceRef),
        ...contextualBindings.map((binding) => binding.evidenceRef),
      ],
      purpose: target.kind === "oc" ? "character_portrait" as const : "scene" as const,
      title: defaultTitle(target),
      compositionDescription: defaultComposition(target),
      variantKey: prefix,
    };
  });
  return compileGrowthIllustrationPlan({ coverageMode: "default", items }, {
    authorizedScopeResourceIds: input.authorizedScopeResourceIds,
    currentRuleRevision: { revision: input.ruleRevision },
    evidenceBindings,
  });
}

function defaultTitle(target: DefaultTarget): string {
  return target.kind === "oc" ? `${target.resource.title} · 角色立绘`
    : target.kind === "story" ? `${target.resource.title} · 故事场景`
      : `${target.resource.title} · 世界风貌`;
}

function defaultComposition(target: DefaultTarget): string {
  if (target.kind === "oc") {
    return `以受信资料为唯一事实基础，绘制“${target.resource.title}”的角色立绘；表现身份、服饰、神态与世界环境关系，不添加资料未支持的血统、装备或能力。`;
  }
  if (target.kind === "story") {
    return `以受信资料为唯一事实基础，描绘“${target.resource.title}”中具有代表性的故事背景或关键场景；保留叙事氛围，不添加资料未支持的情节结局。`;
  }
  return `以受信资料为唯一事实基础，描绘“${target.resource.title}”的代表性环境、建筑、气候与社会风貌；不添加资料未支持的标志、人物身份或历史事实。`;
}

function compareTargets(left: DefaultTarget, right: DefaultTarget): number {
  const order: Record<DefaultTargetKind, number> = { oc: 1, place: 2, story: 3 };
  return order[left.kind] - order[right.kind]
    || compareStrings(left.resource.title, right.resource.title)
    || compareStrings(left.resource.id, right.resource.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function defaultPlanError(code: string): Error & { code: string } {
  return Object.assign(new Error("Default Growth illustration planning failed."), { code });
}
