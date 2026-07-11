import { randomUUID } from "node:crypto";
import { CheckpointRepository } from "../version/checkpointRepository";
import { ConstraintProfileRepository, type ConstraintProfilePayload } from "./constraintProfileRepository";
import { CreativeDocumentRepository, type CreativeDocumentKind } from "./creativeDocumentRepository";
import { CreativeRelationRepository, type CreativeRelationKind } from "./creativeRelationRepository";
import { ResourceRepository } from "./resourceRepository";
import type { CreativeObjectKind, ResourceDomain } from "./creativeObjectPolicy";
import type { WorkspaceDatabase } from "./workspaceRepository";

export type CreativeWorkspaceMutation =
  | { action: "create_resource"; domain: ResourceDomain; objectKind: CreativeObjectKind; title: string; parentId: string | null }
  | { action: "rename_resource"; resourceId: string; title: string }
  | { action: "move_resource"; resourceId: string; parentId: string }
  | { action: "delete_resource"; resourceId: string }
  | { action: "create_document"; resourceId: string; kind: CreativeDocumentKind; title: string }
  | { action: "delete_document"; documentId: string }
  | { action: "create_relation"; kind: CreativeRelationKind; sourceResourceId: string; targetResourceId: string }
  | { action: "delete_relation"; relationId: string }
  | { action: "create_constraint"; scopeResourceId: string | null; title: string; payload: ConstraintProfilePayload }
  | { action: "update_constraint"; profileId: string; payload: ConstraintProfilePayload }
  | { action: "delete_constraint"; profileId: string };

export class CreativeWorkspaceService {
  readonly #checkpoints: CheckpointRepository;
  readonly #resources: ResourceRepository;
  readonly #documents: CreativeDocumentRepository;
  readonly #relations: CreativeRelationRepository;
  readonly #constraints: ConstraintProfileRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
    this.#documents = new CreativeDocumentRepository(workspace);
    this.#relations = new CreativeRelationRepository(workspace);
    this.#constraints = new ConstraintProfileRepository(workspace);
  }

  mutate(input: CreativeWorkspaceMutation): void {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const branch = this.#checkpoints.getActiveBranch();
      const checkpointId = this.#checkpoints.appendCheckpoint(branch.id, mutationLabel(input));
      this.apply(input, checkpointId);
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  private apply(input: CreativeWorkspaceMutation, checkpointId: string): void {
    switch (input.action) {
      case "create_resource":
        {
        const parentId = input.parentId ?? this.requireDomainRoot(input.domain).id;
        const resourceId = this.#resources.putRevision({
          resourceId: randomUUID(),
          create: true,
          checkpointId,
          type: input.domain,
          objectKind: input.objectKind,
          title: input.title,
          parentId,
          state: "active",
        });
        const defaultDocument = defaultDocumentFor(input.objectKind);
        if (defaultDocument) {
          this.#documents.putRevision({
            documentId: randomUUID(),
            create: true,
            checkpointId,
            resourceId,
            kind: defaultDocument.kind,
            title: defaultDocument.title,
            state: "active",
          });
        }
        return;
        }
      case "rename_resource": {
        const current = this.requireResource(input.resourceId);
        this.#resources.putRevision({
          resourceId: current.id,
          checkpointId,
          type: current.type,
          objectKind: current.objectKind,
          title: input.title,
          parentId: current.parentId,
          state: "active",
        });
        return;
      }
      case "move_resource": {
        const current = this.requireResource(input.resourceId);
        this.#resources.putRevision({
          resourceId: current.id,
          checkpointId,
          type: current.type,
          objectKind: current.objectKind,
          title: current.title,
          parentId: input.parentId,
          state: "active",
        });
        return;
      }
      case "delete_resource": {
        const current = this.requireResource(input.resourceId);
        this.#resources.putRevision({
          resourceId: current.id,
          checkpointId,
          type: current.type,
          objectKind: current.objectKind,
          title: current.title,
          parentId: current.parentId,
          state: "deleted",
        });
        return;
      }
      case "create_document":
        this.#documents.putRevision({
          documentId: randomUUID(),
          create: true,
          checkpointId,
          resourceId: input.resourceId,
          kind: input.kind,
          title: input.title,
          state: "active",
        });
        return;
      case "delete_document": {
        const current = this.#documents.getCurrent(input.documentId);
        if (!current) throw mutationError("CREATIVE_DOCUMENT_NOT_ACTIVE", "Creative document is not active.");
        this.#documents.putRevision({
          documentId: current.id,
          checkpointId,
          resourceId: current.resourceId,
          kind: current.kind,
          title: current.title,
          sortOrder: current.sortOrder,
          state: "deleted",
        });
        return;
      }
      case "create_relation":
        this.#relations.putRevision({
          relationId: randomUUID(),
          create: true,
          checkpointId,
          kind: input.kind,
          sourceResourceId: input.sourceResourceId,
          targetResourceId: input.targetResourceId,
          state: "active",
        });
        return;
      case "delete_relation": {
        const current = this.#relations.getCurrent(input.relationId);
        if (!current) throw mutationError("RELATION_NOT_ACTIVE", "Creative relation is not active.");
        this.#relations.putRevision({
          relationId: current.id,
          checkpointId,
          kind: current.kind,
          sourceResourceId: current.sourceResourceId,
          targetResourceId: current.targetResourceId,
          state: "deleted",
        });
        return;
      }
      case "create_constraint":
        this.#constraints.putVersion({
          profileId: randomUUID(),
          create: true,
          checkpointId,
          scopeResourceId: input.scopeResourceId,
          title: input.title,
          payload: input.payload,
          state: "active",
          authorKind: "user",
        });
        return;
      case "update_constraint": {
        const current = this.#constraints.getCurrent(input.profileId);
        if (!current) throw mutationError("CONSTRAINT_PROFILE_NOT_ACTIVE", "Constraint profile is not active.");
        this.#constraints.putVersion({
          profileId: current.profileId,
          checkpointId,
          scopeResourceId: current.scopeResourceId,
          title: current.title,
          payload: input.payload,
          state: "active",
          authorKind: "user",
        });
        return;
      }
      case "delete_constraint": {
        const current = this.#constraints.getCurrent(input.profileId);
        if (!current) throw mutationError("CONSTRAINT_PROFILE_NOT_ACTIVE", "Constraint profile is not active.");
        this.#constraints.putVersion({
          profileId: current.profileId,
          checkpointId,
          scopeResourceId: current.scopeResourceId,
          title: current.title,
          payload: current.payload,
          state: "deleted",
          authorKind: "user",
        });
        return;
      }
    }
  }

  private requireResource(resourceId: string) {
    const resource = this.#resources.getCurrent(resourceId);
    if (!resource) throw mutationError("RESOURCE_NOT_ACTIVE", "Creative resource is not active.");
    return resource;
  }

  private requireDomainRoot(domain: ResourceDomain) {
    const root = this.#resources.listCurrent().find((resource) => resource.type === domain && resource.objectKind === "domain_root");
    if (!root) throw mutationError("RESOURCE_DOMAIN_ROOT_NOT_FOUND", "Creative domain root was not found.");
    return root;
  }
}

function mutationLabel(input: CreativeWorkspaceMutation): string {
  switch (input.action) {
    case "create_resource": return `创建《${input.title.trim()}》`;
    case "rename_resource": return `重命名创作对象`;
    case "move_resource": return `移动创作对象`;
    case "delete_resource": return `删除创作对象`;
    case "create_document": return `创建文档《${input.title.trim()}》`;
    case "delete_document": return `删除创作文档`;
    case "create_relation": return `建立对象关联`;
    case "delete_relation": return `移除对象关联`;
    case "create_constraint": return `创建约束《${input.title.trim()}》`;
    case "update_constraint": return `更新写作约束`;
    case "delete_constraint": return `删除写作约束`;
  }
}

function mutationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function defaultDocumentFor(kind: CreativeObjectKind): { kind: CreativeDocumentKind; title: string } | null {
  switch (kind) {
    case "world": return { kind: "setting", title: "世界设定" };
    case "oc": return { kind: "character_profile", title: "角色资料" };
    case "story": return { kind: "prose", title: "正文" };
    case "volume": return { kind: "knowledge_note", title: "卷纲" };
    case "chapter": return { kind: "prose", title: "正文" };
    case "location": return { kind: "location_profile", title: "地点资料" };
    case "faction": return { kind: "faction_profile", title: "势力资料" };
    case "oc_variant": return { kind: "character_profile", title: "角色资料" };
    case "graph_view":
    case "timeline_view":
    case "asset_collection":
    case "domain_root": return null;
  }
}
