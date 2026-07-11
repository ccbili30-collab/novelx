import { CheckpointRepository } from "../version/checkpointRepository";
import {
  DocumentRepository,
  type DocumentVersionRecord,
  type WorkingDocumentRecord,
} from "./documentRepository";
import { ResourceRepository, type ResourceRecord, type ResourceType } from "./resourceRepository";
import type { WorkspaceDatabase } from "./workspaceRepository";

export interface EditorDocumentSnapshot {
  resourceId: string;
  resourceType: ResourceType;
  title: string;
  content: string;
  stableVersionId: string | null;
  workingRevision: number;
  hasWorkingCopy: boolean;
  dirty: boolean;
}

export interface StableDocumentForAgent {
  resourceId: string;
  resourceType: ResourceType;
  title: string;
  versionId: string;
  checkpointId: string;
  content: string;
}

export class DocumentEditorService {
  readonly #documents: DocumentRepository;
  readonly #resources: ResourceRepository;
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#documents = new DocumentRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  getForEditor(resourceId: string): EditorDocumentSnapshot {
    const resource = this.requireCurrentResource(resourceId);
    const stable = this.#documents.getCurrentStable(resourceId);
    const working = this.#documents.getWorkingCopy(resourceId);
    return projectEditorDocument(resource, stable, working);
  }

  saveWorkingCopy(input: {
    resourceId: string;
    content: string;
    expectedRevision: number;
    expectedStableVersionId: string | null;
  }): EditorDocumentSnapshot {
    this.requireCurrentResource(input.resourceId);
    this.#documents.saveWorkingCopy(input);
    return this.getForEditor(input.resourceId);
  }

  saveStable(input: { resourceId: string; expectedRevision: number }): EditorDocumentSnapshot {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const resource = this.requireCurrentResource(input.resourceId);
      const branch = this.#checkpoints.getActiveBranch();
      const working = this.#documents.getWorkingCopy(input.resourceId, branch.id);
      if (!working) {
        throw documentError("DOCUMENT_WORKING_COPY_NOT_FOUND", "Save a working copy before creating a stable version.");
      }
      if (working.editRevision !== input.expectedRevision) {
        throw documentError("DOCUMENT_EDIT_CONFLICT", "The document changed after this editor snapshot was loaded.");
      }
      if (!working.dirty) throw documentError("DOCUMENT_NOT_DIRTY", "The document has no unpublished changes.");

      const currentStable = this.#documents.getCurrentStable(input.resourceId, branch.id);
      if ((currentStable?.id ?? null) !== working.baseVersionId) {
        throw documentError("DOCUMENT_BASE_CHANGED", "The stable document changed while this working copy was being edited.");
      }

      const checkpointId = this.#checkpoints.appendCheckpoint(branch.id, `保存《${resource.title}》`);
      const versionId = this.#documents.putVersion({
        resourceId: input.resourceId,
        checkpointId,
        content: working.content,
        authorKind: "user",
      });
      this.#documents.markWorkingCopyStable({
        resourceId: input.resourceId,
        versionId,
        expectedRevision: input.expectedRevision,
      });
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
    return this.getForEditor(input.resourceId);
  }

  getStableForAgent(resourceId: string): StableDocumentForAgent | null {
    const resource = this.requireCurrentResource(resourceId);
    const stable = this.#documents.getCurrentStable(resourceId);
    if (!stable) return null;
    return {
      resourceId: resource.id,
      resourceType: resource.type,
      title: resource.title,
      versionId: stable.id,
      checkpointId: stable.checkpointId,
      content: stable.content,
    };
  }

  private requireCurrentResource(resourceId: string): ResourceRecord {
    const resource = this.#resources.getCurrent(resourceId);
    if (!resource) throw documentError("RESOURCE_NOT_FOUND", "The requested resource does not exist in the active branch.");
    return resource;
  }
}

function projectEditorDocument(
  resource: ResourceRecord,
  stable: DocumentVersionRecord | null,
  working: WorkingDocumentRecord | null,
): EditorDocumentSnapshot {
  return {
    resourceId: resource.id,
    resourceType: resource.type,
    title: resource.title,
    content: working?.content ?? stable?.content ?? "",
    stableVersionId: stable?.id ?? null,
    workingRevision: working?.editRevision ?? 0,
    hasWorkingCopy: working !== null,
    dirty: working?.dirty ?? false,
  };
}

function documentError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
