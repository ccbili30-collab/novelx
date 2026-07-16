import { ImageAssetRepository } from "../../../domain/asset/imageAssetRepository";
import { GrowthRepository } from "../../../domain/growth/growthRepository";
import { CheckpointRepository } from "../../../domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../../domain/workspace/creativeDocumentRepository";
import { DocumentRepository } from "../../../domain/workspace/documentRepository";
import { ResourceRepository } from "../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import type { GrowthIllustrationItem } from "../../../shared/growthContract";

export interface GrowthIllustrationRecoveryResult {
  requestId: string;
  requeuedJobs: number;
  reconciliationRequiredJobs: number;
  staleItems: number;
  statuses: Record<GrowthIllustrationItem["status"], number>;
}

/** Reconciles persisted queue items strictly from current source versions and Image Job authority. */
export class GrowthIllustrationRecovery {
  readonly #growth: GrowthRepository;
  readonly #images: ImageAssetRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#growth = new GrowthRepository(workspace);
    this.#images = new ImageAssetRepository(workspace);
  }

  recover(requestId: string, options: { recoverInterruptedJobs?: boolean } = {}): GrowthIllustrationRecoveryResult {
    if (!this.#growth.getIllustrationRequest(requestId)) throw recoveryError("GROWTH_ILLUSTRATION_REQUEST_NOT_FOUND");
    const recoveredJobs = options.recoverInterruptedJobs === false
      ? { requeued: 0, reconciliationRequired: 0 }
      : this.#images.recoverInterruptedJobs();
    let staleItems = 0;
    for (const item of this.#growth.listIllustrationItems(requestId)) {
      if (!this.#sourcesAreCurrent(item)) {
        if (item.status !== "stale") {
          this.#growth.markIllustrationItemStale({ itemId: item.id, expectedAnchorHash: item.anchorHash });
          staleItems += 1;
        }
        continue;
      }
      if (item.imageJobId && item.status !== "stale") this.#growth.refreshIllustrationItemFromJob(item.id);
    }
    const statuses = emptyStatusCounts();
    for (const item of this.#growth.listIllustrationItems(requestId)) statuses[item.status] += 1;
    return {
      requestId,
      requeuedJobs: recoveredJobs.requeued,
      reconciliationRequiredJobs: recoveredJobs.reconciliationRequired,
      staleItems,
      statuses,
    };
  }

  #sourcesAreCurrent(item: GrowthIllustrationItem): boolean {
    const head = new CheckpointRepository(this.workspace).getActiveBranch().headCheckpointId;
    const resources = new ResourceRepository(this.workspace);
    const creative = new CreativeDocumentRepository(this.workspace);
    const documents = new DocumentRepository(this.workspace);
    return item.sources.every((source) => {
      if (source.kind === "resource") {
        return resources.getVisibleByRevisionIdAtCheckpoint(source.resourceVersionId, head)?.id === source.resourceId;
      }
      const activeDocument = creative.getCurrent(source.documentId);
      const stable = documents.getCurrentStableForCreativeDocument(source.documentId);
      return activeDocument !== null
        && stable?.id === source.documentVersionId
        && stable.contentHash === source.contentSha256;
    });
  }
}

function emptyStatusCounts(): Record<GrowthIllustrationItem["status"], number> {
  return {
    planned: 0, queued: 0, running: 0, ready: 0, failed: 0,
    cancelled: 0, stale: 0, reconciliation_required: 0,
  };
}

function recoveryError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth Illustration recovery failed."), { code });
}
