import { ImageAssetRepository, type ShowcaseImageJobRecord } from "../asset/imageAssetRepository";
import { SemanticGraphService, type SemanticGraphSnapshot } from "../graph/semanticGraphService";
import { CheckpointRepository } from "../version/checkpointRepository";
import {
  CreativeDocumentRepository,
  type CreativeDocumentKind,
  type CreativeDocumentRecord,
} from "../workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../workspace/creativeRelationRepository";
import { DocumentRepository, type DocumentVersionRecord } from "../workspace/documentRepository";
import { ResourceRepository, type ResourceRecord } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface ShowcaseStableDocument {
  documentId: string;
  resourceId: string;
  kind: CreativeDocumentKind;
  title: string;
  sortOrder: number;
  stableVersionId: string;
  content: string;
}

export interface ShowcaseResource {
  id: string;
  type: ResourceRecord["type"];
  objectKind: ResourceRecord["objectKind"];
  title: string;
  documents: ShowcaseStableDocument[];
}

export type ShowcaseImageStatus =
  | "queued"
  | "generating"
  | "ready"
  | "stale"
  | "failed"
  | "reconciliation_required";

export interface ShowcaseImage {
  jobId: string;
  assetId: string | null;
  title: string;
  purpose: "character_portrait" | "scene";
  status: ShowcaseImageStatus;
  statusMessage: string;
  thumbnailUrl: string | null;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | null;
  width: number | null;
  height: number | null;
  sourceResourceIds: string[];
  sourceVersionIds: string[];
  sourceResources: Array<Pick<ResourceRecord, "id" | "type" | "objectKind" | "title">>;
  createdAt: string;
}

export interface CreativeShowcaseSnapshot {
  story: ShowcaseResource;
  proseDocuments: ShowcaseStableDocument[];
  worlds: ShowcaseResource[];
  characters: ShowcaseResource[];
  images: ShowcaseImage[];
  graphScopeResourceIds: string[];
  graph: SemanticGraphSnapshot;
}

export class CreativeShowcaseService {
  readonly #checkpoints: CheckpointRepository;
  readonly #creativeDocuments: CreativeDocumentRepository;
  readonly #documents: DocumentRepository;
  readonly #images: ImageAssetRepository;
  readonly #relations: CreativeRelationRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#creativeDocuments = new CreativeDocumentRepository(workspace);
    this.#documents = new DocumentRepository(workspace);
    this.#images = new ImageAssetRepository(workspace);
    this.#relations = new CreativeRelationRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  get(storyResourceId: string): CreativeShowcaseSnapshot {
    const branch = this.#checkpoints.getActiveBranch();
    const resources = this.#resources.listCurrent(branch.id);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const story = byId.get(storyResourceId);
    if (!story) throw showcaseError("SHOWCASE_STORY_NOT_FOUND", "The requested story is not active on the current branch.");
    if (story.type !== "story" || story.objectKind !== "story") {
      throw showcaseError("SHOWCASE_STORY_INVALID", "The requested resource is not a story root.");
    }

    const relations = this.#relations.listCurrent(branch.id)
      .filter((relation) => relation.sourceResourceId === story.id);
    const worlds = relations
      .filter((relation) => relation.kind === "uses_world")
      .map((relation) => byId.get(relation.targetResourceId))
      .filter((resource): resource is ResourceRecord => resource?.type === "world" && resource.objectKind === "world");
    const characters = relations
      .filter((relation) => relation.kind === "uses_oc")
      .map((relation) => byId.get(relation.targetResourceId))
      .filter((resource): resource is ResourceRecord => resource?.type === "oc" && resource.objectKind === "oc");

    const storyResourceIds = collectOwnedResourceIds(story.id, resources);
    const worldResourceIds = worlds.map((resource) => collectOwnedResourceIds(resource.id, resources));
    const characterResourceIds = characters.map((resource) => collectOwnedResourceIds(resource.id, resources));
    const storySnapshot = this.#resourceSnapshot(story, storyResourceIds, branch.id);
    const worldSnapshots = worlds.map((resource, index) => (
      this.#resourceSnapshot(resource, worldResourceIds[index]!, branch.id)
    ));
    const characterSnapshots = characters.map((resource, index) => (
      this.#resourceSnapshot(resource, characterResourceIds[index]!, branch.id)
    ));
    const storyDocuments = storySnapshot.documents.filter((document) => document.kind === "prose");

    const stableDocuments = [
      ...storySnapshot.documents,
      ...worldSnapshots.flatMap((resource) => resource.documents),
      ...characterSnapshots.flatMap((resource) => resource.documents),
    ];
    const stableVersionIds = new Set(stableDocuments.map((document) => document.stableVersionId));
    const relevantResourceIds = new Set([
      ...storyResourceIds,
      ...worldResourceIds.flatMap((ids) => [...ids]),
      ...characterResourceIds.flatMap((ids) => [...ids]),
    ]);

    const images = this.#images.listShowcaseJobs()
      .filter((image) => image.sourceResourceIds.some((id) => relevantResourceIds.has(id))
        || image.sourceVersionIds.some((id) => stableVersionIds.has(id)))
      .map((image) => projectImage(image, byId));
    const graphScopeIds = [...relevantResourceIds];

    return {
      story: storySnapshot,
      proseDocuments: deduplicateDocuments(storyDocuments),
      worlds: worldSnapshots,
      characters: characterSnapshots,
      images,
      graphScopeResourceIds: graphScopeIds,
      graph: new SemanticGraphService(this.workspace).getSnapshotForScopes(graphScopeIds),
    };
  }

  #resourceSnapshot(resource: ResourceRecord, resourceIds: ReadonlySet<string>, branchId: string): ShowcaseResource {
    return {
      id: resource.id,
      type: resource.type,
      objectKind: resource.objectKind,
      title: resource.title,
      documents: this.#stableDocumentsForResources(resourceIds, branchId),
    };
  }

  #stableDocumentsForResources(resourceIds: ReadonlySet<string>, branchId: string): ShowcaseStableDocument[] {
    return this.#creativeDocuments.listCurrent(undefined, branchId)
      .filter((document) => resourceIds.has(document.resourceId))
      .flatMap((document) => {
        const stable = this.#documents.getCurrentStableForCreativeDocument(document.id, branchId);
        return stable ? [projectDocument(document, stable)] : [];
      });
  }
}

function collectOwnedResourceIds(storyId: string, resources: readonly ResourceRecord[]): Set<string> {
  const ids = new Set([storyId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of resources) {
      if (resource.parentId && ids.has(resource.parentId) && !ids.has(resource.id)) {
        ids.add(resource.id);
        changed = true;
      }
    }
  }
  return ids;
}

function projectDocument(document: CreativeDocumentRecord, stable: DocumentVersionRecord): ShowcaseStableDocument {
  return {
    documentId: document.id,
    resourceId: document.resourceId,
    kind: document.kind,
    title: document.title,
    sortOrder: document.sortOrder,
    stableVersionId: stable.id,
    content: stable.content,
  };
}

function deduplicateDocuments(documents: ShowcaseStableDocument[]): ShowcaseStableDocument[] {
  return [...new Map(documents.map((document) => [document.documentId, document])).values()]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title, "zh-CN"));
}

function projectImage(image: ShowcaseImageJobRecord, resources: ReadonlyMap<string, ResourceRecord>): ShowcaseImage {
  const status = image.status === "running"
    ? "generating"
    : image.status === "succeeded"
      ? image.asset?.status ?? "reconciliation_required"
      : image.status;
  const renderable = (status === "ready" || status === "stale") && image.asset;
  return {
    jobId: image.jobId,
    assetId: renderable ? image.asset!.id : null,
    title: image.title,
    purpose: image.purpose,
    status,
    statusMessage: imageStatusMessage(status),
    thumbnailUrl: renderable ? `novax-asset://image/${encodeURIComponent(image.asset!.id)}` : null,
    mimeType: renderable ? image.asset!.mimeType : null,
    width: renderable ? image.asset!.width : null,
    height: renderable ? image.asset!.height : null,
    sourceResourceIds: image.sourceResourceIds,
    sourceVersionIds: image.sourceVersionIds,
    sourceResources: image.sourceResourceIds.flatMap((id) => {
      const resource = resources.get(id);
      return resource ? [{ id: resource.id, type: resource.type, objectKind: resource.objectKind, title: resource.title }] : [];
    }),
    createdAt: image.asset?.createdAt ?? image.createdAt,
  };
}

function imageStatusMessage(status: ShowcaseImageStatus): string {
  switch (status) {
    case "queued": return "已进入生成队列。";
    case "generating": return "图片正在生成。";
    case "ready": return "图片已生成并通过本地校验。";
    case "stale": return "图片来源版本已经变化。";
    case "failed": return "图片生成失败，可在活动记录中查看原因。";
    case "reconciliation_required": return "图片请求结果不确定，需要人工核对后再重试。";
  }
}

function showcaseError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
