import { createHash } from "node:crypto";
import type { TrustedGrowthIllustrationCompileInput } from "../../../agent-worker/growth/growthIllustrationPlan";
import { CreativeDocumentRepository } from "../../../domain/workspace/creativeDocumentRepository";
import { DocumentRepository } from "../../../domain/workspace/documentRepository";
import type { ResourceRecord } from "../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import type { AuthorizedGrowthResource } from "../growthCreatorScope";

export interface ResolvedResourceIllustrationEvidence {
  targetEvidenceRef: string;
  evidenceBindings: TrustedGrowthIllustrationCompileInput["evidenceBindings"];
}

/** Builds current, source-bound evidence for one authorized formal resource. */
export function resolveResourceIllustrationEvidence(input: {
  workspace: WorkspaceDatabase;
  owner: AuthorizedGrowthResource;
  checkpointId: string;
  targetEvidenceRef: string;
  documentEvidenceRef(index: number): string;
}): ResolvedResourceIllustrationEvidence {
  const revisionId = currentResourceRevisionId(input.workspace, input.owner.resource.id, input.checkpointId);
  if (!revisionId) throw evidenceError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
  const evidenceBindings: TrustedGrowthIllustrationCompileInput["evidenceBindings"] = [{
    evidenceRef: input.targetEvidenceRef,
    scopeResourceId: input.owner.scopeRootId,
    defaultCoverageRole: coverageRole(input.owner.resource.objectKind),
    source: {
      kind: "resource",
      resourceId: input.owner.resource.id,
      resourceVersionId: revisionId,
    },
    authorizedFacts: `${input.owner.resource.title}（${input.owner.resource.objectKind}）`,
    targetAnchorInput: {
      kind: "resource",
      resourceId: input.owner.resource.id,
      resourceVersionId: revisionId,
    },
  }];
  const creativeDocuments = new CreativeDocumentRepository(input.workspace)
    .listAtCheckpoint(input.checkpointId, input.owner.resource.id);
  const documents = new DocumentRepository(input.workspace);
  for (const [index, document] of creativeDocuments.entries()) {
    const version = documents.getStableForCreativeDocumentAtCheckpoint(document.id, input.checkpointId);
    if (!version || !version.content.trim()) continue;
    const excerpt = Array.from(version.content).slice(0, 8_000).join("");
    evidenceBindings.push({
      evidenceRef: input.documentEvidenceRef(index),
      scopeResourceId: input.owner.scopeRootId,
      defaultCoverageRole: "supporting",
      source: {
        kind: "document",
        documentId: document.id,
        documentVersionId: version.id,
        contentSha256: version.contentHash,
      },
      authorizedFacts: excerpt,
      targetAnchorInput: {
        kind: "stable_text_span",
        documentId: document.id,
        documentVersionId: version.id,
        startCodePoint: 0,
        endCodePoint: Array.from(excerpt).length,
        textSha256: sha256(excerpt),
      },
    });
  }
  return { targetEvidenceRef: input.targetEvidenceRef, evidenceBindings };
}

export function currentResourceRevisionId(
  workspace: WorkspaceDatabase,
  resourceId: string,
  checkpointId: string,
): string | null {
  const row = workspace.db.prepare(`
    WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
      SELECT ?, 0 UNION ALL
      SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints
      JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id WHERE checkpoints.parent_checkpoint_id IS NOT NULL
    ), ranked AS (
      SELECT revisions.id, revisions.state,
        ROW_NUMBER() OVER (ORDER BY ancestry.depth, revisions.created_at DESC, revisions.rowid DESC) AS revision_rank
      FROM resource_revisions revisions JOIN ancestry ON ancestry.checkpoint_id = revisions.created_checkpoint_id
      WHERE revisions.resource_id = ?
    ) SELECT id FROM ranked WHERE revision_rank = 1 AND state = 'active'
  `).get(checkpointId, resourceId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function illustrationCoverageRole(
  kind: ResourceRecord["objectKind"],
): "world" | "place_or_faction" | "story" | "major_oc" | "important_detail" | "supporting" {
  return kind === "world" ? "world"
    : kind === "location" || kind === "faction" ? "place_or_faction"
      : kind === "story" || kind === "volume" ? "story"
        : kind === "oc" ? "major_oc"
          : "supporting";
}

function coverageRole(kind: ResourceRecord["objectKind"]): ReturnType<typeof illustrationCoverageRole> {
  return illustrationCoverageRole(kind);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth illustration evidence resolution failed."), { code });
}
