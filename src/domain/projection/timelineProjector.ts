import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { CreativeCommitRecord } from "../commit/creativeCommitRepository";
import { AssertionRepository, type SourcedAssertionRecord } from "../graph/assertionRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ProjectionArtifactRepository } from "./projectionArtifactRepository";
import type { CreativeProjector, ProjectionResult } from "./projectionCoordinator";

interface TemporalValue {
  kind: "instant" | "range" | "sequence";
  value?: string;
  start?: string;
  end?: string;
  order?: number;
  label?: string;
}

export class TimelineProjector implements CreativeProjector {
  readonly kind = "timeline";
  readonly #assertions: AssertionRepository;
  readonly #artifacts: ProjectionArtifactRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#assertions = new AssertionRepository(workspace);
    this.#artifacts = new ProjectionArtifactRepository(workspace);
  }

  inputSha256(commit: CreativeCommitRecord): string {
    return canonicalAuditHash({ kind: this.kind, commitId: commit.id, manifestSha256: commit.manifestSha256 });
  }

  project(commit: CreativeCommitRecord, runId: string): ProjectionResult {
    const events = this.#assertions.listLatestForGraph(commit.branchId)
      .flatMap((assertion) => projectEvent(assertion))
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.assertionId.localeCompare(right.assertionId));
    for (const event of events) {
      this.#artifacts.append({
        runId,
        artifactKey: `event:${event.assertionId}`,
        payload: event,
        sourceRefs: [event.versionId, ...event.sourceRefs],
      });
    }
    return { outputSha256: canonicalAuditHash(events) };
  }
}

function projectEvent(assertion: SourcedAssertionRecord) {
  const temporal = readTemporal(assertion.object.temporal);
  if (!temporal) return [];
  return [{
    assertionId: assertion.assertionId,
    versionId: assertion.versionId,
    scopeId: assertion.scopeId,
    subject: assertion.subject,
    predicate: assertion.predicate,
    temporal,
    sortKey: temporalSortKey(temporal),
    sourceRefs: assertion.sources.map((source) => source.ref).sort(),
  }];
}

function readTemporal(value: unknown): TemporalValue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "instant" && typeof record.value === "string" && record.value.trim()) {
    return { kind: "instant", value: record.value.trim(), label: readLabel(record.label) };
  }
  if (record.kind === "range" && typeof record.start === "string" && record.start.trim()
    && typeof record.end === "string" && record.end.trim()) {
    return { kind: "range", start: record.start.trim(), end: record.end.trim(), label: readLabel(record.label) };
  }
  if (record.kind === "sequence" && typeof record.order === "number" && Number.isSafeInteger(record.order)) {
    return { kind: "sequence", order: record.order, label: readLabel(record.label) };
  }
  return null;
}

function readLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function temporalSortKey(value: TemporalValue): string {
  if (value.kind === "instant") return `0:${value.value}`;
  if (value.kind === "range") return `1:${value.start}:${value.end}`;
  return `2:${String(value.order).padStart(16, "0")}`;
}
