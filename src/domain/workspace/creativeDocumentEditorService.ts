import { CheckpointRepository } from "../version/checkpointRepository";
import { CreativeDocumentRepository, type CreativeDocumentKind, type CreativeDocumentRecord } from "./creativeDocumentRepository";
import {
  DocumentRepository,
  type DocumentVersionRecord,
  type WorkingCreativeDocumentRecord,
} from "./documentRepository";
import type { WorkspaceDatabase } from "./workspaceRepository";

export interface CreativeEditorDocumentSnapshot {
  documentId: string;
  resourceId: string;
  kind: CreativeDocumentKind;
  title: string;
  content: string;
  stableVersionId: string | null;
  workingRevision: number;
  hasWorkingCopy: boolean;
  dirty: boolean;
}

export interface StableCreativeDocumentForAgent {
  documentId: string;
  resourceId: string;
  kind: CreativeDocumentKind;
  title: string;
  versionId: string;
  checkpointId: string;
  content: string;
}

export class CreativeDocumentEditorService {
  readonly #documents: DocumentRepository;
  readonly #creativeDocuments: CreativeDocumentRepository;
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#documents = new DocumentRepository(workspace);
    this.#creativeDocuments = new CreativeDocumentRepository(workspace);
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  getForEditor(documentId: string): CreativeEditorDocumentSnapshot {
    const document = this.requireCurrentDocument(documentId);
    return projectSnapshot(
      document,
      this.#documents.getCurrentStableForCreativeDocument(documentId),
      this.#documents.getWorkingCreativeCopy(documentId),
    );
  }

  saveWorkingCopy(input: {
    documentId: string;
    content: string;
    expectedRevision: number;
    expectedStableVersionId: string | null;
  }): CreativeEditorDocumentSnapshot {
    this.requireCurrentDocument(input.documentId);
    this.#documents.saveWorkingCreativeCopy(input);
    return this.getForEditor(input.documentId);
  }

  saveStable(input: { documentId: string; expectedRevision: number }): CreativeEditorDocumentSnapshot {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const document = this.requireCurrentDocument(input.documentId);
      const branch = this.#checkpoints.getActiveBranch();
      const working = this.#documents.getWorkingCreativeCopy(input.documentId, branch.id);
      if (!working) throw editorError("DOCUMENT_WORKING_COPY_NOT_FOUND", "Save a working copy before creating a stable version.");
      if (working.editRevision !== input.expectedRevision) {
        throw editorError("DOCUMENT_EDIT_CONFLICT", "The document changed after this editor snapshot was loaded.");
      }
      if (!working.dirty) throw editorError("DOCUMENT_NOT_DIRTY", "The document has no unpublished changes.");
      const currentStable = this.#documents.getCurrentStableForCreativeDocument(input.documentId, branch.id);
      if ((currentStable?.id ?? null) !== working.baseVersionId) {
        throw editorError("DOCUMENT_BASE_CHANGED", "The stable document changed while this working copy was being edited.");
      }
      const checkpointId = this.#checkpoints.appendCheckpoint(branch.id, `保存《${document.title}》`);
      const versionId = this.#documents.putVersion({
        resourceId: document.resourceId,
        creativeDocumentId: document.id,
        checkpointId,
        content: working.content,
        authorKind: "user",
      });
      this.#documents.markWorkingCreativeCopyStable({
        documentId: document.id,
        versionId,
        expectedRevision: input.expectedRevision,
      });
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
    return this.getForEditor(input.documentId);
  }

  discardWorkingCopy(input: { documentId: string; expectedRevision: number }): CreativeEditorDocumentSnapshot {
    this.requireCurrentDocument(input.documentId);
    const working = this.#documents.getWorkingCreativeCopy(input.documentId);
    if (!working) throw editorError("DOCUMENT_WORKING_COPY_NOT_FOUND", "There is no working copy to discard.");
    this.#documents.discardWorkingCreativeCopy(input);
    return this.getForEditor(input.documentId);
  }

  getStableForAgent(documentId: string): StableCreativeDocumentForAgent | null {
    const document = this.requireCurrentDocument(documentId);
    const stable = this.#documents.getCurrentStableForCreativeDocument(documentId);
    if (!stable) return null;
    return {
      documentId: document.id,
      resourceId: document.resourceId,
      kind: document.kind,
      title: document.title,
      versionId: stable.id,
      checkpointId: stable.checkpointId,
      content: stable.content,
    };
  }

  private requireCurrentDocument(documentId: string): CreativeDocumentRecord {
    const document = this.#creativeDocuments.getCurrent(documentId);
    if (!document) throw editorError("CREATIVE_DOCUMENT_NOT_FOUND", "The creative document is not active.");
    return document;
  }
}

function projectSnapshot(
  document: CreativeDocumentRecord,
  stable: DocumentVersionRecord | null,
  working: WorkingCreativeDocumentRecord | null,
): CreativeEditorDocumentSnapshot {
  return {
    documentId: document.id,
    resourceId: document.resourceId,
    kind: document.kind,
    title: document.title,
    content: working?.content ?? stable?.content ?? "",
    stableVersionId: stable?.id ?? null,
    workingRevision: working?.editRevision ?? 0,
    hasWorkingCopy: working !== null,
    dirty: working?.dirty ?? false,
  };
}

function editorError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
