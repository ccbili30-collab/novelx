import type { SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { validateCausalRelation } from "./causalRelationPolicy";
import {
  causalRelationDefinitionSchema,
  type CausalRelationDefinition,
  type CausalSourceReference,
} from "./causalRelationTypes";

type Row = Record<string, SQLOutputValue>;

const putSchema = z.object({
  versionId: z.string().trim().min(1).max(240),
  checkpointId: z.string().trim().min(1).max(240),
  status: z.enum(["current", "conflict", "deleted"]),
  idempotencyKey: z.string().trim().min(1).max(240),
  relation: causalRelationDefinitionSchema,
}).strict();

export type CausalRelationVersionStatus = "current" | "conflict" | "deleted";

export interface PutCausalRelationVersionInput {
  versionId: string;
  checkpointId: string;
  status: CausalRelationVersionStatus;
  idempotencyKey: string;
  relation: CausalRelationDefinition;
}

export interface CausalRelationVersionRecord extends CausalRelationDefinition {
  versionId: string;
  checkpointId: string;
  status: CausalRelationVersionStatus;
  createdAt: string;
}

export class CausalRelationRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  putVersion(input: PutCausalRelationVersionInput): CausalRelationVersionRecord {
    const value = putSchema.parse(input) as PutCausalRelationVersionInput;
    const relation = validateCausalRelation(value.relation);
    const payloadHash = canonicalAuditHash({
      versionId: value.versionId,
      checkpointId: value.checkpointId,
      status: value.status,
      relation,
    });
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT id, payload_hash FROM causal_relation_versions WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) fail("DOMAIN_CAUSAL_IDEMPOTENCY_KEY_REUSED");
        const result = this.getVersion(readString(replay, "id"));
        if (!result) fail("DOMAIN_CAUSAL_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return result;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM causal_relation_versions WHERE id = ?").get(value.versionId)) {
        fail("DOMAIN_CAUSAL_VERSION_ID_CONFLICT");
      }
      this.#assertCheckpoint(value.checkpointId);
      this.#assertAssertionVisible(relation.causeAssertionId, value.checkpointId);
      this.#assertAssertionVisible(relation.effectAssertionId, value.checkpointId);
      for (const source of relation.sourceReferences) this.#assertSourceVisible(source, value.checkpointId);

      const identity = this.workspace.db.prepare("SELECT * FROM causal_relations WHERE id = ?")
        .get(relation.id) as Row | undefined;
      const now = new Date().toISOString();
      if (identity) {
        if (readString(identity, "kind") !== relation.kind
          || readString(identity, "cause_assertion_id") !== relation.causeAssertionId
          || readString(identity, "effect_assertion_id") !== relation.effectAssertionId) {
          fail("DOMAIN_CAUSAL_IDENTITY_IMMUTABLE");
        }
      } else {
        this.workspace.db.prepare(`
          INSERT INTO causal_relations (
            id, kind, cause_assertion_id, effect_assertion_id, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(relation.id, relation.kind, relation.causeAssertionId, relation.effectAssertionId, now);
      }
      this.workspace.db.prepare(`
        INSERT INTO causal_relation_versions (
          id, relation_id, created_checkpoint_id, mechanism, conditions_json, temporal_scope,
          polarity_strength_summary, epistemic_status, status, idempotency_key, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.versionId, relation.id, value.checkpointId, relation.mechanism,
        JSON.stringify(relation.conditions), relation.temporalScope, relation.polarityStrengthSummary,
        relation.epistemicStatus, value.status, value.idempotencyKey, payloadHash, now);
      const insertSource = this.workspace.db.prepare(`
        INSERT INTO causal_relation_sources (
          relation_version_id, source_id, source_kind, source_version_id,
          stable_locator, source_sha256, ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      relation.sourceReferences.forEach((source, ordinal) => {
        insertSource.run(value.versionId, source.sourceId, source.sourceKind, source.sourceVersionId,
          source.stableLocator, source.sourceSha256, ordinal);
      });
      const result = this.getVersion(value.versionId);
      if (!result) fail("DOMAIN_CAUSAL_DATA_INVALID");
      this.workspace.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw normalizeSqliteError(error);
    }
  }

  getVersion(versionId: string): CausalRelationVersionRecord | null {
    const row = this.workspace.db.prepare(`
      SELECT versions.*, relations.kind, relations.cause_assertion_id, relations.effect_assertion_id
      FROM causal_relation_versions versions
      JOIN causal_relations relations ON relations.id = versions.relation_id
      WHERE versions.id = ?
    `).get(versionId) as Row | undefined;
    return row ? this.#mapVersion(row) : null;
  }

  listAtCheckpoint(checkpointId: string): CausalRelationVersionRecord[] {
    this.#assertCheckpoint(checkpointId);
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT versions.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY versions.relation_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM causal_relation_versions versions
        JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
      )
      SELECT ranked.*, relations.kind, relations.cause_assertion_id, relations.effect_assertion_id
      FROM ranked JOIN causal_relations relations ON relations.id = ranked.relation_id
      WHERE ranked.version_rank = 1 AND ranked.status IN ('current', 'conflict')
      ORDER BY relations.kind, relations.cause_assertion_id, relations.effect_assertion_id, relations.id
    `).all(checkpointId) as Row[];
    return rows.map((row) => this.#mapVersion(row));
  }

  listCurrent(branchId: string): CausalRelationVersionRecord[] {
    const branch = this.workspace.db.prepare("SELECT head_checkpoint_id FROM branches WHERE id = ?").get(branchId) as Row | undefined;
    if (!branch) fail("DOMAIN_CAUSAL_BRANCH_NOT_FOUND");
    return this.listAtCheckpoint(readString(branch, "head_checkpoint_id"));
  }

  #mapVersion(row: Row): CausalRelationVersionRecord {
    const versionId = readString(row, "id");
    const sourceRows = this.workspace.db.prepare(`
      SELECT source_id, source_kind, source_version_id, stable_locator, source_sha256
      FROM causal_relation_sources WHERE relation_version_id = ? ORDER BY ordinal
    `).all(versionId) as Row[];
    return {
      versionId,
      id: readString(row, "relation_id"),
      checkpointId: readString(row, "created_checkpoint_id"),
      kind: readString(row, "kind") as CausalRelationDefinition["kind"],
      causeAssertionId: readString(row, "cause_assertion_id"),
      effectAssertionId: readString(row, "effect_assertion_id"),
      mechanism: readString(row, "mechanism"),
      conditions: z.array(z.string()).parse(JSON.parse(readString(row, "conditions_json"))),
      temporalScope: readString(row, "temporal_scope"),
      polarityStrengthSummary: readString(row, "polarity_strength_summary"),
      epistemicStatus: readString(row, "epistemic_status") as CausalRelationDefinition["epistemicStatus"],
      sourceReferences: sourceRows.map((source) => ({
        sourceId: readString(source, "source_id"),
        sourceKind: readString(source, "source_kind") as CausalSourceReference["sourceKind"],
        sourceVersionId: readString(source, "source_version_id"),
        stableLocator: readString(source, "stable_locator"),
        sourceSha256: readString(source, "source_sha256"),
      })),
      status: readString(row, "status") as CausalRelationVersionStatus,
      createdAt: readString(row, "created_at"),
    };
  }

  #assertCheckpoint(checkpointId: string): void {
    if (!this.workspace.db.prepare("SELECT 1 FROM checkpoints WHERE id = ?").get(checkpointId)) {
      fail("DOMAIN_CAUSAL_CHECKPOINT_NOT_FOUND");
    }
  }

  #assertAssertionVisible(assertionId: string, checkpointId: string): void {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT assertion_versions.status, ancestry.depth,
          ROW_NUMBER() OVER (ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions JOIN ancestry
          ON ancestry.checkpoint_id = assertion_versions.created_checkpoint_id
        WHERE assertion_versions.assertion_id = ?
      )
      SELECT status FROM ranked WHERE version_rank = 1
    `).get(checkpointId, assertionId) as Row | undefined;
    if (!row || !["current", "conflict"].includes(readString(row, "status"))) {
      fail("DOMAIN_CAUSAL_ENDPOINT_NOT_VISIBLE");
    }
  }

  #assertSourceVisible(source: CausalSourceReference, checkpointId: string): void {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id) AS (
        SELECT ?
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id
        FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      )
      SELECT source_records.kind, source_records.ref
      FROM source_records
      WHERE source_records.id = ? AND EXISTS (
        SELECT 1 FROM assertion_sources
        JOIN assertion_versions ON assertion_versions.id = assertion_sources.assertion_version_id
        JOIN ancestry ON ancestry.checkpoint_id = assertion_versions.created_checkpoint_id
        WHERE assertion_sources.source_id = source_records.id
      )
    `).get(checkpointId, source.sourceId) as Row | undefined;
    if (!row) fail("DOMAIN_CAUSAL_SOURCE_NOT_VISIBLE");
    const expectedKind = source.sourceKind === "document"
      ? "document_version"
      : source.sourceKind === "evidence" ? "evidence_version" : "assertion_version";
    if (readString(row, "kind") !== expectedKind || readString(row, "ref") !== source.sourceVersionId) {
      fail("DOMAIN_CAUSAL_SOURCE_BINDING_INVALID");
    }
    if (source.sourceKind === "document") {
      const document = this.workspace.db.prepare(`
        WITH RECURSIVE ancestry(checkpoint_id) AS (
          SELECT ?
          UNION ALL
          SELECT checkpoints.parent_checkpoint_id
          FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
          WHERE checkpoints.parent_checkpoint_id IS NOT NULL
        )
        SELECT document_versions.content_hash
        FROM document_versions JOIN ancestry
          ON ancestry.checkpoint_id = document_versions.created_checkpoint_id
        WHERE document_versions.id = ?
      `).get(checkpointId, source.sourceVersionId) as Row | undefined;
      if (!document) fail("DOMAIN_CAUSAL_SOURCE_NOT_VISIBLE");
      if (readString(document, "content_hash") !== source.sourceSha256) {
        fail("DOMAIN_CAUSAL_SOURCE_HASH_MISMATCH");
      }
    }
  }
}

function normalizeSqliteError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && error.code.startsWith("DOMAIN_CAUSAL_")) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("causal_relations.kind, causal_relations.cause_assertion_id, causal_relations.effect_assertion_id")) {
    return causalError("DOMAIN_CAUSAL_RELATION_DUPLICATED");
  }
  if (message.includes("causal_relation_versions.relation_id, causal_relation_versions.created_checkpoint_id")) {
    return causalError("DOMAIN_CAUSAL_CHECKPOINT_VERSION_CONFLICT");
  }
  return error;
}

function readString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : fail("DOMAIN_CAUSAL_DATA_INVALID");
}

function causalError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fail(code: string): never {
  throw causalError(code);
}
