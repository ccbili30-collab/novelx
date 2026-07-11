import { createHash } from "node:crypto";
import { ChangeSetService, type ChangeSetItem } from "../changeSet/changeSetService";
import { WorkspaceChangeSetPolicy } from "../changeSet/workspaceChangeSetPolicy";
import { CheckpointRepository } from "../version/checkpointRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { DecompositionCandidateRepository } from "./decompositionCandidateRepository";

export class ImportCandidateChangeSetService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  propose(input: { sourceId: string; targetResourceId: string; candidateIds: string[] }) {
    const target = new ResourceRepository(this.workspace).getCurrent(input.targetResourceId);
    if (!target || !["world", "story", "oc"].includes(target.type)) throw importProposalError("IMPORT_TARGET_INVALID");
    const ids = [...new Set(input.candidateIds)].sort(); if (!ids.length || ids.length > 100) throw importProposalError("IMPORT_CANDIDATES_REQUIRED");
    const repository = new DecompositionCandidateRepository(this.workspace);
    const candidates = ids.map((id) => repository.getRequired(id));
    if (candidates.some((candidate) => candidate.sourceId !== input.sourceId || candidate.status !== "accepted")) throw importProposalError("IMPORT_CANDIDATE_NOT_ACCEPTED");
    if (candidates.some((candidate) => candidate.kind === "ambiguity")) throw importProposalError("IMPORT_AMBIGUITY_NOT_PROPOSABLE");
    const entries = candidates.map((candidate) => candidateItems(candidate, input.targetResourceId, target.type));
    const expectedHeadCheckpointId = new CheckpointRepository(this.workspace).getActiveBranch().headCheckpointId;
    const key = `import:${input.sourceId}:${input.targetResourceId}:${hash(ids.join("|"))}`;
    const changeSet = new ChangeSetService(this.workspace, new WorkspaceChangeSetPolicy(this.workspace)).propose({
      idempotencyKey: key, expectedHeadCheckpointId, mode: "assist", summary: `导入 ${candidates.length} 个已审核候选到“${target.title}”`, items: entries.flatMap((entry) => entry.items),
    });
    const insert = this.workspace.db.prepare(`INSERT OR IGNORE INTO import_candidate_change_set_links (candidate_id, candidate_revision, change_set_id, item_id, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const entry of entries) for (const item of entry.items) insert.run(entry.candidate.id, entry.candidate.revision, changeSet.id, item.id, new Date().toISOString());
    return changeSet;
  }
}

type Candidate = ReturnType<DecompositionCandidateRepository["getRequired"]>;
interface CandidateEntry { candidate: Candidate; items: ChangeSetItem[] }
function candidateItems(candidate: Candidate, targetId: string, targetType: string): CandidateEntry {
  const prefix = stableId(candidate.id, targetId); const p = candidate.payload as Record<string, any>;
  if (candidate.kind === "world_rule") return { candidate, items: [{ id: `${prefix}-fact`, dependsOn: [], kind: "assertion.put", payload: { assertionId: `${prefix}-assertion`, scopeType: targetType, scopeId: targetId, subject: String(p.subject), predicate: String(p.predicate), object: { value: p.value }, evidenceIds: [candidate.id], status: "draft" } }] };
  if (candidate.kind === "event") return { candidate, items: [{ id: `${prefix}-event`, dependsOn: [], kind: "assertion.put", payload: { assertionId: `${prefix}-assertion`, scopeType: targetType, scopeId: targetId, subject: String(p.subject), predicate: "event", object: { description: p.description, temporal: p.temporal }, evidenceIds: [candidate.id], status: "draft" } }] };
  if (candidate.kind === "style") return { candidate, items: [{ id: `${prefix}-constraint`, dependsOn: [], kind: "constraint_profile.put", payload: { profileId: `${prefix}-profile`, create: true, scopeResourceId: targetId, title: "导入写作风格", profile: { narrativePerson: null, tense: null, tone: null, pacing: null, humorLevel: null, prohibitedContent: [], requiredContent: [], notes: String(p.description) }, state: "active", authorKind: "import" } }] };
  const kind = candidate.kind as "character" | "location" | "faction"; const title = String(p.name); const resourceId = `${prefix}-resource`; const documentId = `${prefix}-document`;
  const type = kind === "character" ? "oc" : "world"; const documentKind = kind === "character" ? "character_profile" : kind === "location" ? "location_profile" : "faction_profile";
  const content = kind === "character" ? String(p.summary) : String(p.description);
  return { candidate, items: [
    { id: `${prefix}-resource-item`, dependsOn: [], kind: "resource.put", payload: { resourceId, create: true, type, objectKind: kind === "character" ? "oc" : kind, title, parentId: targetId, state: "active", sortOrder: 0 } },
    { id: `${prefix}-document-item`, dependsOn: [`${prefix}-resource-item`], kind: "creative_document.put", payload: { documentId, create: true, resourceId, kind: documentKind, title, state: "active", sortOrder: 0 } },
    { id: `${prefix}-content-item`, dependsOn: [`${prefix}-resource-item`, `${prefix}-document-item`], kind: "document.put", payload: { resourceId, creativeDocumentId: documentId, content, authorKind: "import" } },
  ] };
}
function stableId(candidateId: string, targetId: string) { return `imp-${hash(`${candidateId}:${targetId}`).slice(0, 24)}`; }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function importProposalError(code: string): Error & { code: string } { return Object.assign(new Error("Import proposal failed."), { code }); }
