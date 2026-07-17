import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];
const editorialTables = [
  "growth_editorial_rounds",
  "growth_work_orders",
  "growth_work_order_dependencies",
  "growth_work_order_attempts",
  "growth_editorial_reviews",
  "growth_work_order_artifacts",
] as const;
const causalTables = ["causal_relations", "causal_relation_versions", "causal_relation_sources"] as const;

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local workspace persistence", () => {
  it("creates schema 29 creative, Growth editorial, causal relation and safe diagnostic storage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-6-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);

    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get())
      .toEqual({ version: 29 });
    expect(listTables(workspace)).toEqual(expect.arrayContaining([
      "creative_documents",
      "creative_relation_versions",
      "constraint_profile_versions",
      "working_constraint_profiles",
      "creative_commits",
      "creative_commit_entries",
      "projection_runs",
      "projection_artifacts",
      "story_profiles",
      "story_profile_oc_bindings",
      "playthroughs",
      "play_turns",
      "canon_reconciliation_decisions",
      "source_library_entries",
      "source_chunks",
      "import_jobs",
      "decomposition_candidates",
      "decomposition_candidate_revisions",
      "import_review_decisions",
      "start_profiles",
      "player_agent_runs",
      "player_agent_invocations",
      "player_agent_tool_invocations",
      "player_agent_audit_events",
      "player_agent_evidence_links",
      "decomposer_run_audits",
      "decomposer_run_sources",
      "import_candidate_change_set_links",
      "project_file_versions",
      "image_generation_jobs",
      "image_assets",
      "growth_goals",
      "growth_goal_scopes",
      "growth_goal_rule_revisions",
      "growth_cycles",
      "growth_retrieval_receipts",
      "growth_retrieval_receipt_links",
      "growth_events",
      "growth_cycle_intents",
      "growth_cycle_intent_focuses",
      "growth_cycle_intent_frontier",
      "growth_inquiry_batches",
      "growth_inquiries",
      "growth_inquiry_evidence_links",
      "growth_inquiry_batch_contracts",
      "growth_inquiry_details",
      "growth_inquiry_lifecycle",
      "growth_inquiry_creator_answers",
      "growth_inquiry_event_sources",
      "growth_closure_profiles",
      "growth_closure_profile_revisions",
      "growth_closure_facets",
      "growth_closure_assessments",
      "growth_closure_reviews",
      "growth_closure_review_findings",
      "growth_closure_profile_components",
      "growth_closure_facet_results",
      "growth_closure_facet_result_evidence",
      "growth_closure_adverse_findings",
      "growth_closure_adverse_finding_evidence",
      "growth_closure_evaluation_outcomes",
      "growth_closure_repair_lineage",
      "growth_closure_repair_backlog",
      "growth_illustration_requests",
      "growth_illustration_request_batches",
      "growth_illustration_items",
      "growth_illustration_item_sources",
      "growth_illustration_text_snapshots",
      "safe_diagnostic_events",
      "growth_editorial_rounds",
      "growth_work_orders",
      "growth_work_order_dependencies",
      "growth_work_order_attempts",
      "growth_editorial_reviews",
      "growth_work_order_artifacts",
      "causal_relations",
      "causal_relation_versions",
      "causal_relation_sources",
    ]));
    expect(listIndexes(workspace)).toEqual(expect.arrayContaining([
      "creative_documents_resource_idx",
      "creative_relation_versions_identity_idx",
      "creative_relation_versions_target_idx",
      "constraint_profile_versions_scope_idx",
      "creative_commits_branch_idx",
      "projection_runs_commit_idx",
      "projection_artifacts_run_idx",
      "image_generation_jobs_status_idx",
      "image_assets_sha256_idx",
      "growth_cycles_goal_status_idx",
      "growth_cycles_one_open_goal_idx",
      "growth_cycles_id_rule_idx",
      "growth_inquiries_one_selected_idx",
      "growth_inquiry_batches_id_cycle_idx",
      "growth_cycles_inquiry_source_idx",
      "growth_closure_reviews_revision_idx",
      "growth_illustration_requests_goal_status_idx",
      "safe_diagnostic_events_run_idx",
      "safe_diagnostic_events_cycle_idx",
      "safe_diagnostic_events_tool_idx",
      "safe_diagnostic_events_operation_idx",
      "safe_diagnostic_events_code_idx",
      "growth_illustration_items_request_status_idx",
      "growth_events_cycle_idx",
      "growth_editorial_rounds_one_open_goal_idx",
      "growth_editorial_rounds_goal_status_idx",
      "growth_work_orders_round_status_idx",
      "growth_work_order_dependencies_predecessor_idx",
      "growth_work_order_attempts_one_active_idx",
      "growth_work_order_attempts_round_status_idx",
      "growth_editorial_reviews_work_order_idx",
      "growth_work_order_artifacts_work_order_idx",
      "causal_relations_cause_idx",
      "causal_relations_effect_idx",
      "causal_relation_versions_relation_checkpoint_idx",
      "causal_relation_versions_checkpoint_status_idx",
      "causal_relation_sources_source_idx",
    ]));
    expect(workspace.db.prepare("SELECT id, kind, sealed_at FROM creative_commits").all()).toMatchObject([
      { kind: "initialization", sealed_at: null },
    ]);
  });

  it("migrates a v23 database additively without rewriting Growth, domain, relation, Change Set, document, assertion or image rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-23-growth-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const changeSet = changes.propose({ idempotencyKey: "v23-growth-preserve", mode: "free", summary: "v23 preservation" });
    changes.commit(changeSet.id, "v23 preservation", () => undefined);
    const checkpointId = checkpoints.getActiveBranch().headCheckpointId;
    const world = resources.listCurrent().find((resource) => resource.type === "world")!;
    const oc = resources.listCurrent().find((resource) => resource.type === "oc")!;
    documents.putVersion({ resourceId: world.id, checkpointId, content: "stable v23 document", authorKind: "user" });
    const documentBefore = workspace.db.prepare(`
      SELECT id, content_hash FROM document_versions WHERE resource_id = ? AND created_checkpoint_id = ?
    `).get(world.id, checkpointId);
    assertions.putVersion({
      assertionId: "v23.assertion", checkpointId, scopeType: "world", scopeId: world.id, subject: "v23", predicate: "keeps",
      object: { text: "stable assertion" }, status: "current", source: { kind: "confirmed_change_set", ref: changeSet.id },
    });
    const relationId = "relation-v23";
    const relationVersionId = "relation-version-v23";
    workspace.db.prepare("INSERT INTO creative_relations (id) VALUES (?)").run(relationId);
    workspace.db.prepare(`
      INSERT INTO creative_relation_versions (
        id, relation_id, source_resource_id, target_resource_id, kind, created_checkpoint_id, state, created_at
      ) VALUES (?, ?, ?, ?, 'related_to', ?, 'active', ?)
    `).run(relationVersionId, relationId, world.id, oc.id, checkpointId, new Date().toISOString());
    const hash = "a".repeat(64);
    const now = new Date().toISOString();
    workspace.db.prepare(`
      INSERT INTO image_generation_jobs (
        id, idempotency_key, request_sha256, provider_id, model_id, title, purpose, prompt, prompt_sha256, size, quality,
        background, source_resource_ids_json, source_version_ids_json, status, request_sent_at, provider_response_id_sha256,
        error_code, error_message, created_at, updated_at
        ) VALUES ('job-v23', 'job-v23-key', ?, 'provider', 'model', 'map', 'world_map', 'prompt', ?, '1024x1024', 'auto',
        'auto', '[]', '[]', 'succeeded', NULL, NULL, NULL, NULL, ?, ?)
    `).run(hash, hash, now, now);
    workspace.db.prepare(`
      INSERT INTO image_assets (id, job_id, mime_type, width, height, byte_length, sha256, relative_path, status, created_at, updated_at)
      VALUES ('asset-v23', 'job-v23', 'image/png', 1, 1, 4, ?, 'images/asset-v23.png', 'ready', ?, ?)
    `).run(hash, now, now);
    const branchId = checkpoints.getActiveBranch().id;
    workspace.db.prepare(`
      INSERT INTO growth_goals (
        id, idempotency_key, payload_hash, branch_id, seed_kind, seed_text, seed_source_document_id,
        seed_source_version_id, seed_resource_id, seed_resource_version_id, status, current_rule_revision,
        current_cycle_sequence, created_at, updated_at
      ) VALUES ('goal-v23', 'goal-v23-key', ?, ?, 'text', 'legacy growth', NULL, NULL, NULL, NULL, 'active', 1, 1, ?, ?)
    `).run(hash, branchId, now, now);
    workspace.db.prepare("INSERT INTO growth_goal_scopes (goal_id, resource_id, ordinal) VALUES ('goal-v23', ?, 0)").run(world.id);
    workspace.db.prepare(`
      INSERT INTO growth_goal_rule_revisions (goal_id, revision, rule_text, source_message_id, created_at)
      VALUES ('goal-v23', 1, 'legacy rule', NULL, ?)
    `).run(now);
    const legacyCycleHash = canonicalAuditHash({
      id: "cycle-v23",
      goalId: "goal-v23",
      idempotencyKey: "cycle-v23-key",
      inputCheckpointId: checkpointId,
      ruleRevision: 1,
    });
    workspace.db.prepare(`
      INSERT INTO growth_cycles (
        id, goal_id, sequence, idempotency_key, payload_hash, input_checkpoint_id, rule_revision,
        run_id, receipt_id, change_set_id, output_checkpoint_id, status, failure_code, created_at, updated_at, terminal_at
      ) VALUES ('cycle-v23', 'goal-v23', 1, 'cycle-v23-key', ?, ?, 1, NULL, NULL, NULL, NULL, 'planned', NULL, ?, ?, NULL)
    `).run(legacyCycleHash, checkpointId, now, now);
    downgradeToSchema24(workspace);
    workspace.db.exec(`
      DROP TABLE growth_illustration_item_sources;
      DROP TABLE growth_illustration_items;
      DROP TABLE growth_illustration_request_batches;
      DROP TABLE growth_illustration_requests;
      DROP TABLE growth_illustration_text_snapshots;
      DROP TABLE growth_closure_review_findings;
      DROP TABLE growth_closure_reviews;
      DROP TABLE growth_closure_assessments;
      DROP TABLE growth_closure_facets;
      DROP TABLE growth_closure_profile_revisions;
      DROP TABLE growth_closure_profiles;
      DROP TABLE growth_inquiry_evidence_links;
      DROP TABLE growth_inquiries;
      DROP TABLE growth_inquiry_batches;
      DROP TABLE growth_cycle_intent_frontier;
      DROP TABLE growth_cycle_intent_focuses;
      DROP TABLE growth_cycle_intents;
      DROP INDEX growth_cycles_id_rule_idx;
      DROP INDEX growth_cycles_one_open_goal_idx;
      UPDATE schema_meta SET version = 23 WHERE singleton = 1;
    `);
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);
    workspace = openWorkspace(root);
    opened.push(workspace);

    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("SELECT purpose, request_sha256 FROM image_generation_jobs WHERE id = 'job-v23'").get())
      .toEqual({ purpose: "world_map", request_sha256: hash });
    expect(workspace.db.prepare("SELECT sha256 FROM image_assets WHERE id = 'asset-v23'").get()).toEqual({ sha256: hash });
    expect(new ChangeSetRepository(workspace).get(changeSet.id)?.status).toBe("committed");
    expect(new DocumentRepository(workspace).getCurrentStable(world.id)?.content).toBe("stable v23 document");
    expect(workspace.db.prepare(`
      SELECT id, content_hash FROM document_versions WHERE resource_id = ? AND created_checkpoint_id = ?
    `).get(world.id, checkpointId)).toEqual(documentBefore);
    expect(new AssertionRepository(workspace).listCurrent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ assertionId: "v23.assertion" }),
    ]));
    expect(workspace.db.prepare("SELECT id FROM creative_relation_versions WHERE id = ?").get(relationVersionId)).toEqual({ id: relationVersionId });
    expect(workspace.db.prepare("SELECT payload_hash FROM growth_goals WHERE id = 'goal-v23'").get()).toEqual({ payload_hash: hash });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_cycle_intents").get()).toEqual({ count: 0 });
    expect(new GrowthRepository(workspace).getCycleIntent("cycle-v23")).toMatchObject({
      focusKinds: ["world"], resumeFrontier: ["story", "oc"], provenance: "legacy_v23_projection",
    });
  });

  it("migrates v24 events by copy-and-swap without changing old rows, keys, indexes or foreign keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-24-inquiry-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    const fixture = seedLegacyV24Growth(workspace);
    downgradeToSchema24(workspace);

    const eventBefore = workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all();
    const columnsBefore = workspace.db.prepare("PRAGMA table_info(growth_events)").all();
    const indexesBefore = workspace.db.prepare("PRAGMA index_list(growth_events)").all();
    const foreignKeysBefore = workspace.db.prepare("PRAGMA foreign_key_list(growth_events)").all();
    const eventSqlBefore = (workspace.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'growth_events'
    `).get() as { sql: string }).sql;
    const eventCountBefore = workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_events").get();
    const legacyHashBefore = workspace.db.prepare(`
      SELECT payload_hash FROM growth_inquiry_batches WHERE id = ?
    `).get(fixture.batchId);
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all()).toEqual(eventBefore);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_events").get()).toEqual(eventCountBefore);
    expect(workspace.db.prepare("PRAGMA table_info(growth_events)").all()).toEqual(columnsBefore);
    expect(workspace.db.prepare("PRAGMA index_list(growth_events)").all()).toEqual(indexesBefore);
    expect(workspace.db.prepare("PRAGMA foreign_key_list(growth_events)").all()).toEqual(foreignKeysBefore);
    const eventSqlAfter = (workspace.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'growth_events'
    `).get() as { sql: string }).sql;
    expect(normalizeSql(eventSqlAfter)
      .replace('CREATE TABLE "growth_events"', "CREATE TABLE growth_events")
      .replace(", 'inquiry_selected', 'creator_choice_required'", "")
      .replace(", 'cycle_evaluated'", "")
      .replace(", 'inquiry'", "")
      .replace(", 'closure_evaluation'", "")
      .replace(", 'evaluated'", "")
      .replace(", CHECK (durable_state <> 'evaluated' OR phase = 'cycle_evaluated')", "")
      .replace(", CHECK (phase <> 'cycle_evaluated' OR (target_kind = 'closure_evaluation' AND target_version_id IS NULL AND content_ref_kind IS NULL))", ""))
      .toBe(normalizeSql(eventSqlBefore));
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(workspace.db.prepare("SELECT payload_hash FROM growth_inquiry_batches WHERE id = ?").get(fixture.batchId))
      .toEqual(legacyHashBefore);
    expect(workspace.db.prepare(`
      SELECT contract_version FROM growth_inquiry_batch_contracts WHERE batch_id = ?
    `).get(fixture.batchId)).toEqual({ contract_version: "legacy_v24" });
    expect(new GrowthRepository(workspace).getInquiryBatch(fixture.batchId)).toMatchObject({
      contractVersion: "legacy_v24", payloadHash: fixture.batchPayloadHash, selectedInquiryId: fixture.selectedInquiryId,
    });

    const tableCount = workspace.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get();
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);
    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get()).toEqual(tableCount);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batch_contracts").get()).toEqual({ count: 1 });
    expect(workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all()).toEqual(eventBefore);
  });

  it("rolls back the whole v24 to v25 migration after a mid-transaction collision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-25-rollback-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    seedLegacyV24Growth(workspace);
    downgradeToSchema24(workspace);
    const eventBefore = workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all();
    const eventSqlBefore = workspace.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'growth_events'
    `).get();
    workspace.db.exec("CREATE TABLE growth_inquiry_batch_contracts (sentinel TEXT NOT NULL)");
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    expect(() => openWorkspace(root)).toThrow();
    const direct = new DatabaseSync(path.join(root, ".novax", "workspace.db"));
    direct.exec("PRAGMA foreign_keys = ON");
    expect(direct.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 24 });
    expect(direct.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all()).toEqual(eventBefore);
    expect(direct.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'growth_events'
    `).get()).toEqual(eventSqlBefore);
    expect(direct.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'growth_inquiry_details'
    `).get()).toBeUndefined();
    expect(direct.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'growth_cycles_inquiry_source_idx'
    `).get()).toBeUndefined();
    expect(direct.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    direct.exec("DROP TABLE growth_inquiry_batch_contracts");
    direct.close();

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all()).toEqual(eventBefore);
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates v25 Growth rows to v26 without fabricating Closure v4 authority and reopens idempotently", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-26-growth-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    seedLegacyV24Growth(workspace);
    seedLegacyV25Closure(workspace);
    downgradeToSchema25(workspace);

    const cycleBefore = workspace.db.prepare(`
      SELECT id, goal_id, sequence, idempotency_key, payload_hash, input_checkpoint_id, rule_revision,
        run_id, receipt_id, change_set_id, output_checkpoint_id, status, failure_code, created_at, updated_at, terminal_at
      FROM growth_cycles ORDER BY goal_id, sequence
    `).all();
    const eventBefore = workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all();
    const intentBefore = workspace.db.prepare("SELECT cycle_id, kind, created_at FROM growth_cycle_intents ORDER BY cycle_id").all();
    const profileBefore = workspace.db.prepare(`
      SELECT id, idempotency_key, payload_hash, goal_id, profile_kind, subject_resource_id,
        current_revision, current_epoch, created_at, updated_at
      FROM growth_closure_profiles ORDER BY id
    `).all();
    const revisionBefore = workspace.db.prepare(`
      SELECT profile_id, revision, epoch, checkpoint_id, rule_revision, idempotency_key, payload_hash, created_at
      FROM growth_closure_profile_revisions ORDER BY profile_id, revision
    `).all();
    const cycleIndexesBefore = workspace.db.prepare("PRAGMA index_list(growth_cycles)").all();
    const cycleForeignKeysBefore = workspace.db.prepare("PRAGMA foreign_key_list(growth_cycles)").all();
    const eventForeignKeysBefore = workspace.db.prepare("PRAGMA foreign_key_list(growth_events)").all();
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare(`
      SELECT id, goal_id, sequence, idempotency_key, payload_hash, input_checkpoint_id, rule_revision,
        run_id, receipt_id, change_set_id, output_checkpoint_id, status, failure_code, created_at, updated_at, terminal_at
      FROM growth_cycles ORDER BY goal_id, sequence
    `).all()).toEqual(cycleBefore);
    expect(workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all()).toEqual(eventBefore);
    expect(workspace.db.prepare(`
      SELECT cycle_id, kind, created_at FROM growth_cycle_intents ORDER BY cycle_id
    `).all()).toEqual(intentBefore);
    expect(workspace.db.prepare(`
      SELECT id, idempotency_key, payload_hash, goal_id, profile_kind, subject_resource_id,
        current_revision, current_epoch, created_at, updated_at
      FROM growth_closure_profiles ORDER BY id
    `).all()).toEqual(profileBefore);
    expect(workspace.db.prepare(`
      SELECT profile_id, revision, epoch, checkpoint_id, rule_revision, idempotency_key, payload_hash, created_at
      FROM growth_closure_profile_revisions ORDER BY profile_id, revision
    `).all()).toEqual(revisionBefore);
    expect(workspace.db.prepare("PRAGMA index_list(growth_cycles)").all()).toEqual(cycleIndexesBefore);
    expect(workspace.db.prepare("PRAGMA foreign_key_list(growth_cycles)").all()).toEqual(cycleForeignKeysBefore);
    expect(workspace.db.prepare("PRAGMA foreign_key_list(growth_events)").all()).toEqual(eventForeignKeysBefore);
    expect(new GrowthRepository(workspace).getCycleIntent("legacy-v24-cycle")).toMatchObject({
      kind: "expand", provenance: "persisted_v24", focusKinds: ["world"], resumeFrontier: ["story", "oc"],
    });
    expect(new GrowthRepository(workspace).getClosureProfile("legacy-v25-profile")).toMatchObject({
      contractGeneration: "legacy_pre_v26", componentProfiles: null, focusOcResourceId: null,
    });
    expect(new GrowthRepository(workspace).getClosureRevision("legacy-v25-profile", 1)).toMatchObject({
      contractGeneration: "legacy_pre_v26", componentProfiles: null, focusOcResourceId: null,
    });
    expect(new GrowthRepository(workspace).getClosureState("legacy-v25-profile")).toMatchObject({
      contentState: "growing", satisfiedFacetIds: [], missingFacetIds: ["history"],
    });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_evaluation_outcomes").get()).toEqual({ count: 0 });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(workspace.db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);

    const tableCount = workspace.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get();
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);
    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get()).toEqual(tableCount);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_profile_components").get()).toEqual({ count: 0 });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back the whole v25 to v26 migration after a mid-transaction collision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-26-rollback-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    seedLegacyV24Growth(workspace);
    seedLegacyV25Closure(workspace);
    downgradeToSchema25(workspace);
    const cycleBefore = workspace.db.prepare("SELECT * FROM growth_cycles ORDER BY goal_id, sequence").all();
    const eventBefore = workspace.db.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all();
    const intentBefore = workspace.db.prepare("SELECT * FROM growth_cycle_intents ORDER BY cycle_id").all();
    workspace.db.exec("CREATE TABLE growth_closure_profile_components (sentinel TEXT NOT NULL)");
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    expect(() => openWorkspace(root)).toThrow();
    const direct = new DatabaseSync(path.join(root, ".novax", "workspace.db"));
    direct.exec("PRAGMA foreign_keys = ON");
    expect(direct.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 25 });
    expect(direct.prepare("SELECT * FROM growth_cycles ORDER BY goal_id, sequence").all()).toEqual(cycleBefore);
    expect(direct.prepare("SELECT * FROM growth_events ORDER BY goal_id, sequence").all()).toEqual(eventBefore);
    expect(direct.prepare("SELECT * FROM growth_cycle_intents ORDER BY cycle_id").all()).toEqual(intentBefore);
    expect(direct.prepare("PRAGMA table_info(growth_closure_profiles)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "contract_generation" })]));
    expect((direct.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'growth_cycles'").get() as { sql: string }).sql)
      .not.toContain("evaluated");
    expect(direct.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(direct.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    direct.exec("DROP TABLE growth_closure_profile_components");
    direct.close();

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(new GrowthRepository(workspace).getCycleIntent("legacy-v24-cycle")).toMatchObject({ provenance: "persisted_v24" });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates v26 through v28 additively without fabricating diagnostic or editorial history and reopens idempotently", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-27-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, ?, ?, ?)")
      .run("legacy-v26-source", "document_version", "legacy-ref", "2026-07-17T00:00:00.000Z");
    downgradeToSchema27(workspace);
    workspace.db.exec("DROP TABLE safe_diagnostic_events; UPDATE schema_meta SET version = 26 WHERE singleton = 1;");
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("SELECT id, kind, ref FROM source_records WHERE id = ?").get("legacy-v26-source"))
      .toEqual({ id: "legacy-v26-source", kind: "document_version", ref: "legacy-ref" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM safe_diagnostic_events").get()).toEqual({ count: 0 });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_editorial_rounds").get()).toEqual({ count: 0 });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const tableCount = workspace.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get();
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get()).toEqual(tableCount);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM safe_diagnostic_events").get()).toEqual({ count: 0 });
  });

  it("rolls back the v26 to v27 stage before v28 after a table collision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-27-rollback-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, ?, ?, ?)")
      .run("rollback-v26-source", "document_version", "rollback-ref", "2026-07-17T00:00:00.000Z");
    downgradeToSchema27(workspace);
    workspace.db.exec(`
      DROP TABLE safe_diagnostic_events;
      UPDATE schema_meta SET version = 26 WHERE singleton = 1;
      CREATE TABLE safe_diagnostic_events (sentinel TEXT NOT NULL);
    `);
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    expect(() => openWorkspace(root)).toThrow();
    const direct = new DatabaseSync(path.join(root, ".novax", "workspace.db"));
    direct.exec("PRAGMA foreign_keys = ON");
    expect(direct.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 26 });
    expect(direct.prepare("PRAGMA table_info(safe_diagnostic_events)").all())
      .toEqual([expect.objectContaining({ name: "sentinel" })]);
    expect(direct.prepare("SELECT id FROM source_records WHERE id = ?").get("rollback-v26-source"))
      .toEqual({ id: "rollback-v26-source" });
    expect(direct.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'safe_diagnostic_events_%'").all())
      .toEqual([]);
    direct.exec("DROP TABLE safe_diagnostic_events");
    direct.close();

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates v27 to v28 additively with byte-equivalent legacy rows and idempotent reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-28-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    seedEditorialGoal(workspace, "legacy-v27-editorial-goal");
    workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, ?, ?, ?)")
      .run("legacy-v27-source", "document_version", "legacy-v27-ref", "2026-07-18T00:00:00.000Z");
    downgradeToSchema27(workspace);
    const before = snapshotLegacyRows(workspace);
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(snapshotLegacyRows(workspace)).toEqual(before);
    for (const table of editorialTables) {
      expect(workspace.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(workspace.db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    const objectsBeforeReopen = workspace.db.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'growth_editorial_%' OR name LIKE 'growth_work_order_%'
      ORDER BY type, name
    `).all();
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'growth_editorial_%' OR name LIKE 'growth_work_order_%'
      ORDER BY type, name
    `).all()).toEqual(objectsBeforeReopen);
    expect(snapshotLegacyRows(workspace)).toEqual(before);
  });

  it("rolls back the entire v27 to v28 migration after an object collision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-28-rollback-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, ?, ?, ?)")
      .run("rollback-v27-source", "document_version", "rollback-v27-ref", "2026-07-18T00:00:00.000Z");
    downgradeToSchema27(workspace);
    workspace.db.exec("CREATE TABLE growth_editorial_rounds (sentinel TEXT NOT NULL)");
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    expect(() => openWorkspace(root)).toThrow(/growth_editorial_rounds already exists/);
    const direct = new DatabaseSync(path.join(root, ".novax", "workspace.db"));
    direct.exec("PRAGMA foreign_keys = ON");
    expect(direct.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 27 });
    expect(direct.prepare("PRAGMA table_info(growth_editorial_rounds)").all())
      .toEqual([expect.objectContaining({ name: "sentinel" })]);
    expect(direct.prepare("SELECT id FROM source_records WHERE id = ?").get("rollback-v27-source"))
      .toEqual({ id: "rollback-v27-source" });
    expect(direct.prepare(`
      SELECT name FROM sqlite_master
      WHERE name LIKE 'growth_work_order_%' OR name LIKE 'growth_editorial_reviews%'
      ORDER BY name
    `).all()).toEqual([]);
    direct.exec("DROP TABLE growth_editorial_rounds");
    direct.close();

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates v28 to v29 additively without rewriting stable v28 rows and reopens idempotently", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-29-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    seedEditorialGoal(workspace, "legacy-v28-causal-goal");
    downgradeToSchema28(workspace);
    const before = snapshotLegacyRows(workspace);
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(snapshotLegacyRows(workspace)).toEqual(before);
    for (const table of causalTables) {
      expect(workspace.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const causalObjects = workspace.db.prepare(`
      SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'causal_relation%' ORDER BY type, name
    `).all();
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare(`
      SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'causal_relation%' ORDER BY type, name
    `).all()).toEqual(causalObjects);
    expect(snapshotLegacyRows(workspace)).toEqual(before);
  });

  it("rolls back the entire v28 to v29 migration after an object collision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-29-rollback-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, ?, ?, ?)")
      .run("rollback-v28-source", "document_version", "rollback-v28-ref", "2026-07-18T00:00:00.000Z");
    downgradeToSchema28(workspace);
    workspace.db.exec("CREATE TABLE causal_relations (sentinel TEXT NOT NULL)");
    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);

    expect(() => openWorkspace(root)).toThrow(/causal_relations already exists/);
    const direct = new DatabaseSync(path.join(root, ".novax", "workspace.db"));
    direct.exec("PRAGMA foreign_keys = ON");
    expect(direct.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 28 });
    expect(direct.prepare("PRAGMA table_info(causal_relations)").all())
      .toEqual([expect.objectContaining({ name: "sentinel" })]);
    expect(direct.prepare("SELECT id FROM source_records WHERE id = ?").get("rollback-v28-source"))
      .toEqual({ id: "rollback-v28-source" });
    expect(direct.prepare(`
      SELECT name FROM sqlite_master WHERE name IN ('causal_relation_versions', 'causal_relation_sources')
    `).all()).toEqual([]);
    direct.exec("DROP TABLE causal_relations");
    direct.close();

    workspace = openWorkspace(root);
    opened.push(workspace);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 29 });
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces Growth editorial ownership, topology, pinning, immutability and content-addressed artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-editorial-v28-invariants-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const goal = seedEditorialGoal(workspace, "editorial-v28-goal");
    const checkpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    const now = "2026-07-18T01:00:00.000Z";
    const hash = "a".repeat(64);
    const insertRound = workspace.db.prepare(`
      INSERT INTO growth_editorial_rounds (
        id, goal_id, contract_version, source_checkpoint_id, rule_revision, idempotency_key,
        payload_hash, status, failure_code, created_at, updated_at, terminal_at
      ) VALUES (?, ?, '1.0.0', ?, 1, ?, ?, 'active', NULL, ?, ?, NULL)
    `);
    insertRound.run("round-1", goal.id, checkpointId, "round-1-key", hash, now, now);
    expect(() => insertRound.run("round-2", goal.id, checkpointId, "round-2-key", hash, now, now))
      .toThrow();

    const insertWorkOrder = workspace.db.prepare(`
      INSERT INTO growth_work_orders (
        id, round_id, goal_id, ordinal, objective, source_checkpoint_id, scope_refs_json,
        capability_id, acceptance_facets_json, status, failure_code, idempotency_key,
        payload_hash, created_at, updated_at
      ) VALUES (?, 'round-1', ?, ?, ?, ?, '["world"]', ?, '["causal_closure"]',
        'planned', NULL, ?, ?, ?, ?)
    `);
    insertWorkOrder.run(
      "order-0", goal.id, 0, "建立世界因果基础", checkpointId, "world_system_author",
      "order-0-key", hash, now, now,
    );
    insertWorkOrder.run(
      "order-1", goal.id, 1, "在基础上编织文明", checkpointId, "civilization_author",
      "order-1-key", hash, now, now,
    );
    workspace.db.prepare(`
      INSERT INTO growth_work_order_dependencies (
        round_id, goal_id, work_order_id, depends_on_work_order_id, ordinal
      ) VALUES ('round-1', ?, 'order-1', 'order-0', 0)
    `).run(goal.id);
    expect(() => workspace.db.prepare(`
      INSERT INTO growth_work_order_dependencies (
        round_id, goal_id, work_order_id, depends_on_work_order_id, ordinal
      ) VALUES ('round-1', ?, 'order-0', 'order-1', 0)
    `).run(goal.id)).toThrow(/GROWTH_EDITORIAL_DEPENDENCY_TOPOLOGY_INVALID/);
    expect(() => workspace.db.prepare(`
      INSERT INTO growth_work_order_dependencies (
        round_id, goal_id, work_order_id, depends_on_work_order_id, ordinal
      ) VALUES ('round-1', 'wrong-goal', 'order-1', 'order-0', 1)
    `).run()).toThrow();

    const insertAttempt = workspace.db.prepare(`
      INSERT INTO growth_work_order_attempts (
        id, round_id, goal_id, work_order_id, attempt_number, status, failure_code,
        source_checkpoint_id, rule_revision, capability_id,
        capability_profile_id, capability_profile_version, capability_profile_sha256,
        prompt_id, prompt_version, prompt_sha256, provider_id, model_id, provider_config_sha256,
        side_effect_state, idempotency_key, payload_hash, output_sha256,
        created_at, updated_at, terminal_at
      ) VALUES (?, 'round-1', ?, ?, ?, ?, ?, ?, 1, ?,
        'growth-specialist', '1.0.0', ?, 'growth-specialist', '1.0.0', ?,
        'configured-provider', 'configured-model', ?, ?, ?, ?, NULL, ?, ?, ?)
    `);
    insertAttempt.run(
      "attempt-1", goal.id, "order-0", 1, "running", null, checkpointId,
      "world_system_author", hash, hash, hash, "none", "attempt-1-key", hash, now, now, null,
    );
    expect(() => insertAttempt.run(
      "attempt-2-active", goal.id, "order-0", 2, "running", null, checkpointId,
      "world_system_author", hash, hash, hash, "none", "attempt-2-active-key", hash, now, now, null,
    )).toThrow();
    expect(() => insertAttempt.run(
      "attempt-wrong-owner", goal.id, "order-1", 1, "running", null, checkpointId,
      "world_system_author", hash, hash, hash, "none", "attempt-wrong-owner-key", hash, now, now, null,
    )).toThrow();
    workspace.db.prepare(`
      UPDATE growth_work_order_attempts
      SET status = 'revision_requested', terminal_at = ?, updated_at = ? WHERE id = 'attempt-1'
    `).run(now, now);
    insertAttempt.run(
      "attempt-2", goal.id, "order-0", 2, "running", null, checkpointId,
      "world_system_author", hash, hash, hash, "none", "attempt-2-key", hash, now, now, null,
    );

    workspace.db.prepare(`
      INSERT INTO growth_work_order_artifacts (
        round_id, goal_id, work_order_id, attempt_id, artifact_kind, ordinal,
        artifact_store_ref, content_sha256, created_at
      ) VALUES ('round-1', ?, 'order-0', 'attempt-1', 'specialist_candidate', 0, ?, ?, ?)
    `).run(goal.id, "artifact://sha256/" + hash, hash, now);
    expect(() => workspace.db.prepare(`
      INSERT INTO growth_work_order_artifacts (
        round_id, goal_id, work_order_id, attempt_id, artifact_kind, ordinal,
        artifact_store_ref, content_sha256, created_at
      ) VALUES ('round-1', ?, 'order-0', 'attempt-1', 'content_artifact', 0, ?, ?, ?)
    `).run(goal.id, "artifact://sha256/" + hash, "b".repeat(64), now)).toThrow();
    const artifactColumns = (workspace.db.prepare("PRAGMA table_info(growth_work_order_artifacts)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(artifactColumns).toEqual(expect.arrayContaining(["artifact_store_ref", "content_sha256"]));
    expect(artifactColumns).not.toEqual(expect.arrayContaining([
      "content", "content_json", "prompt", "prompt_text", "api_key", "provider_url",
    ]));

    expect(() => workspace.db.prepare("UPDATE growth_work_orders SET objective = ? WHERE id = 'order-0'")
      .run("偷偷改写已定义工作单")).toThrow(/GROWTH_EDITORIAL_WORK_ORDER_DEFINITION_IMMUTABLE/);
    workspace.db.prepare("UPDATE growth_work_orders SET status = 'running', updated_at = ? WHERE id = 'order-0'")
      .run(now);
    workspace.db.prepare(`
      UPDATE growth_work_order_attempts
      SET status = 'failed', failure_code = 'GROWTH_EDITORIAL_ATTEMPT_STOPPED', terminal_at = ?, updated_at = ?
      WHERE id = 'attempt-2'
    `).run(now, now);
    insertAttempt.run(
      "attempt-reconcile", goal.id, "order-0", 3, "reconciliation_required",
      "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN", checkpointId, "world_system_author",
      hash, hash, hash, "outcome_unknown", "attempt-reconcile-key", hash, now, now, now,
    );
    workspace.db.prepare(`
      UPDATE growth_work_orders
      SET status = 'reconciliation_required', failure_code = 'GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN', updated_at = ?
      WHERE id = 'order-0'
    `).run(now);
    expect(() => workspace.db.prepare("UPDATE growth_work_orders SET status = 'ready', updated_at = ? WHERE id = 'order-1'")
      .run(now)).toThrow(/GROWTH_EDITORIAL_PREDECESSOR_RECONCILIATION_REQUIRED/);
    expect(() => insertAttempt.run(
      "attempt-invalid-reconcile", goal.id, "order-1", 1, "reconciliation_required",
      "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN", checkpointId, "civilization_author",
      hash, hash, hash, "none", "attempt-invalid-reconcile-key", hash, now, now, now,
    )).toThrow();
    expect(workspace.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps logical domain roots internal until they contain user content or are renamed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-domain-roots-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);

    expect(resources.listCurrent()).toHaveLength(6);
    expect(resources.listVisibleCurrent()).toEqual([]);

    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    documents.putVersion({
      resourceId: worldRoot.id,
      checkpointId: checkpoints.getActiveBranch().headCheckpointId,
      content: "这个世界由潮汐纪元塑造。",
      authorKind: "user",
    });
    expect(resources.listVisibleCurrent()).toEqual([worldRoot]);

    const ocRoot = resources.listCurrent().find((resource) => resource.type === "oc")!;
    const renamed = new ChangeSetRepository(workspace).propose({
      idempotencyKey: "rename-legacy-oc-root",
      mode: "free",
      summary: "保留被用户改写的旧 OC 根资源",
    });
    new ChangeSetRepository(workspace).commit(renamed.id, "改写 OC 根资源", (checkpointId) => {
      resources.putRevision({
        resourceId: ocRoot.id,
        checkpointId,
        type: "oc",
        title: "群星旅者",
        parentId: null,
        state: "active",
      });
    });
    expect(resources.listVisibleCurrent().map((resource) => resource.title)).toEqual([
      "世界",
      "群星旅者",
    ]);
  });

  it("persists typed creative objects and rejects invalid ownership", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-objects-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const resources = new ResourceRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const domainRoots = resources.listCurrent();
    const worldRoot = domainRoots.find((resource) => resource.type === "world")!;
    const storyRoot = domainRoots.find((resource) => resource.type === "story")!;
    expect(worldRoot.objectKind).toBe("domain_root");
    expect(storyRoot.objectKind).toBe("domain_root");

    const proposed = changes.propose({
      idempotencyKey: "typed-creative-object-tree",
      mode: "free",
      summary: "创建世界和故事层级",
    });
    changes.commit(proposed.id, "创建创作对象", (checkpointId) => {
      expect(resources.getCurrent(worldRoot.id)?.objectKind).toBe("domain_root");
      const worldId = resources.putRevision({
        checkpointId,
        type: "world",
        objectKind: "world",
        title: "潮汐世界",
        parentId: worldRoot.id,
        state: "active",
      });
      resources.putRevision({
        checkpointId,
        type: "world",
        objectKind: "location",
        title: "银湾",
        parentId: worldId,
        state: "active",
      });
      const storyId = resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "story",
        title: "潮痕",
        parentId: storyRoot.id,
        state: "active",
      });
      const volumeId = resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "volume",
        title: "第一卷",
        parentId: storyId,
        state: "active",
      });
      resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "chapter",
        title: "归潮",
        parentId: volumeId,
        state: "active",
      });

      expect(() => resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "chapter",
        title: "非法章节",
        parentId: worldId,
        state: "active",
      })).toThrowError(expect.objectContaining({ code: "RESOURCE_PARENT_KIND_INVALID" }));
    });

    expect(resources.listVisibleCurrent().map(({ title, objectKind }) => ({ title, objectKind })))
      .toEqual(expect.arrayContaining([
        { title: "潮汐世界", objectKind: "world" },
        { title: "银湾", objectKind: "location" },
        { title: "潮痕", objectKind: "story" },
        { title: "第一卷", objectKind: "volume" },
        { title: "归潮", objectKind: "chapter" },
      ]));
  });

  it("persists an idempotent committed Change Set and sourced assertion across restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-workspace-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    const changes = new ChangeSetRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const proposed = changes.propose({
      idempotencyKey: "coastline-1",
      mode: "assist",
      summary: "记录银湾海岸成因",
    });

    expect(changes.propose({
      idempotencyKey: "coastline-1",
      mode: "assist",
      summary: "记录银湾海岸成因",
    }).id).toBe(proposed.id);

    changes.commit(proposed.id, "接受海岸设定", (checkpointId) => {
      const resourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "银湾海岸",
        parentId: resources.listCurrent().find((resource) => resource.type === "world")!.id,
        state: "active",
      });
      documents.putVersion({
        resourceId,
        checkpointId,
        content: "银湾海岸由沉降纪元塑造。",
        authorKind: "user",
      });
      assertions.putVersion({
        assertionId: "assertion.coastline",
        checkpointId,
        scopeType: "world",
        scopeId: "world.silver-bay",
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: proposed.id },
      });
    });
    const coastResource = resources.listCurrent().find((resource) => resource.title === "银湾海岸")!;
    documents.saveWorkingCopy({ resourceId: coastResource.id, content: "尚未形成检查点的海岸补充。" });

    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);
    workspace = openWorkspace(root);
    opened.push(workspace);

    expect(new ChangeSetRepository(workspace).get(proposed.id)?.status).toBe("committed");
    expect(new ResourceRepository(workspace).listCurrent()
      .filter((resource) => resource.parentId === null)
      .map(({ type, title }) => ({ type, title }))).toEqual([
      { type: "world", title: "世界" },
      { type: "oc", title: "OC" },
      { type: "story", title: "故事" },
      { type: "graph", title: "图谱" },
      { type: "timeline", title: "时间线" },
      { type: "asset", title: "资产" },
    ]);
    expect(new AssertionRepository(workspace).listCurrent()).toMatchObject([
      { assertionId: "assertion.coastline", object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" } },
    ]);
    const reopenedResources = new ResourceRepository(workspace);
    const reopenedCoast = reopenedResources.listCurrent().find((resource) => resource.title === "银湾海岸")!;
    const reopenedDocuments = new DocumentRepository(workspace);
    expect(reopenedDocuments.getCurrentStable(reopenedCoast.id)?.content).toBe("银湾海岸由沉降纪元塑造。");
    expect(reopenedDocuments.getWorkingCopy(reopenedCoast.id)).toMatchObject({
      content: "尚未形成检查点的海岸补充。",
      dirty: true,
    });
  });
});

function listTables(workspace: WorkspaceDatabase): string[] {
  return (workspace.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function listIndexes(workspace: WorkspaceDatabase): string[] {
  return (workspace.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function seedEditorialGoal(workspace: WorkspaceDatabase, id: string) {
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  return new GrowthRepository(workspace).createGoal({
    id,
    idempotencyKey: `${id}-key`,
    branchId: branch.id,
    seed: { kind: "text", text: "Growth Editorial schema v28 migration seed" },
    authorizedScopeResourceIds: [world.id],
    initialRuleText: "所有候选必须保留来源并通过串行 Canon 提交。",
    sourceMessageId: null,
  });
}

function snapshotLegacyRows(workspace: WorkspaceDatabase): Record<string, unknown[]> {
  const tables = listTables(workspace).filter((table) =>
    table !== "schema_meta"
      && table !== "retrieval_index_capability"
      && !table.startsWith("sqlite_")
      && !editorialTables.includes(table as typeof editorialTables[number])
      && !causalTables.includes(table as typeof causalTables[number]));
  return Object.fromEntries(tables.map((table) => {
    const escapedTable = `"${table.replaceAll('"', '""')}"`;
    const columns = (workspace.db.prepare(`PRAGMA table_info(${escapedTable})`).all() as Array<{ name: string }>).map(({ name }) => name);
    const byteColumns = columns.map((column) => {
      const escapedColumn = `"${column.replaceAll('"', '""')}"`;
      return `typeof(${escapedColumn}) || ':' || CASE WHEN ${escapedColumn} IS NULL THEN '' ELSE hex(CAST(${escapedColumn} AS BLOB)) END AS ${escapedColumn}`;
    });
    const columnOrder = columns.map((_, index) => String(index + 1)).join(", ");
    return [table, workspace.db.prepare(`SELECT ${byteColumns.join(", ")} FROM ${escapedTable} ORDER BY ${columnOrder}`).all()];
  }));
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

function seedLegacyV24Growth(workspace: WorkspaceDatabase): {
  batchId: string;
  batchPayloadHash: string;
  selectedInquiryId: string;
} {
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const scope = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  const scopeVersion = workspace.db.prepare(`
    SELECT id FROM resource_revisions WHERE resource_id = ? AND created_checkpoint_id = ?
  `).get(scope.id, branch.headCheckpointId) as { id: string };
  const repository = new GrowthRepository(workspace);
  const goal = repository.createGoal({
    id: "legacy-v24-goal", idempotencyKey: "legacy-v24-goal-key", branchId: branch.id,
    seed: { kind: "text", text: "legacy v24 seed" }, authorizedScopeResourceIds: [scope.id],
    initialRuleText: "legacy v24 rule", sourceMessageId: null,
  });
  const cycle = repository.beginCycle({
    id: "legacy-v24-cycle", goalId: goal.id, idempotencyKey: "legacy-v24-cycle-key",
    inputCheckpointId: branch.headCheckpointId, ruleRevision: 1,
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"] },
  });
  const run = seedGrowthRunForMigration(workspace, branch.id, branch.headCheckpointId);
  repository.attachRun({ cycleId: cycle.id, runId: run.runId });
  const receipt = repository.recordReceipt({
    id: "legacy-v24-receipt", cycleId: cycle.id, runId: run.runId, toolInvocationId: run.toolInvocationId,
    branchId: branch.id, checkpointId: branch.headCheckpointId, lens: "creator",
    effectiveScopeResourceIds: [scope.id], query: "legacy evidence", aliases: [], validTime: null, recordedTime: null,
    maxHops: 1, cpuBudgetMs: 10, expansionBudget: 10, resultBudget: 10, tokenBudget: 10,
    policyVersion: "growth-retrieval-v1", coverage: { state: "complete", searchedScopeCount: 1, omittedCount: 0 },
    truncated: false, links: [{
      rank: 1, targetKind: "resource", targetId: scope.id, targetVersionId: scopeVersion.id, score: 1,
      reasonCodes: ["scope_match"], pathTargetIds: [], stableLocator: null, stableVersionId: null, stableHash: null,
    }],
  });
  repository.appendEvent({
    goalId: goal.id, cycleId: cycle.id, runId: run.runId, sequence: 1, safeSummary: "legacy receipt recorded",
    phase: "receipt_recorded", targetKind: "resource", targetId: scope.id, targetVersionId: null,
    durableState: "running", contentRef: null,
  });

  const batchId = "legacy-v24-batch";
  const selectedInquiryId = "legacy-v24-question-1";
  const batchPayloadHash = "d".repeat(64);
  const now = new Date().toISOString();
  workspace.db.exec("BEGIN IMMEDIATE");
  try {
    workspace.db.prepare(`
      INSERT INTO growth_inquiry_batches (
        id, cycle_id, receipt_id, checkpoint_id, rule_revision, idempotency_key, payload_hash, status,
        question_count, creator_choice_blocked, selected_inquiry_id, sealed_at
      ) VALUES (?, ?, ?, ?, 1, 'legacy-v24-batch-key', ?, 'sealed', 3, 0, ?, ?)
    `).run(batchId, cycle.id, receipt.id, branch.headCheckpointId, batchPayloadHash, selectedInquiryId, now);
    const insertQuestion = workspace.db.prepare(`
      INSERT INTO growth_inquiries (
        id, batch_id, question, evidence_state, safe_summary, priority, fingerprint, selected, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      insertQuestion.run(`legacy-v24-question-${index + 1}`, batchId, `Legacy question ${index + 1}?`,
        index === 0 ? "known" : "unknown", `Legacy summary ${index + 1}`, 3 - index,
        String(index + 1).repeat(64), index === 0 ? 1 : 0, index);
    }
    workspace.db.prepare(`
      INSERT INTO growth_inquiry_evidence_links (batch_id, inquiry_id, receipt_id, rank, ordinal)
      VALUES (?, ?, ?, 1, 0)
    `).run(batchId, selectedInquiryId, receipt.id);
    workspace.db.exec("COMMIT");
  } catch (error) {
    workspace.db.exec("ROLLBACK");
    throw error;
  }
  return { batchId, batchPayloadHash, selectedInquiryId };
}

function seedGrowthRunForMigration(workspace: WorkspaceDatabase, branchId: string, checkpointId: string) {
  const runId = randomUUID();
  const invocationId = randomUUID();
  const toolInvocationId = randomUUID();
  const hash = createHash("sha256").update("growth migration", "utf8").digest("hex");
  const now = new Date().toISOString();
  workspace.db.prepare(`
    INSERT INTO agent_runs (
      id, workspace_id, branch_id, base_checkpoint_id, mode, user_input_sha256,
      provider_id, requested_model_id, provider_config_sha256, runtime_contract_version, created_at
    ) VALUES (?, ?, ?, ?, 'free', ?, NULL, NULL, NULL, '1.0.0', ?)
  `).run(runId, workspace.workspaceId, branchId, checkpointId, hash, now);
  workspace.db.prepare(`
    INSERT INTO agent_invocations (
      id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256,
      agent_profile_id, agent_profile_version, agent_profile_sha256, provider_id, requested_model_id,
      provider_config_sha256, tool_policy_id, tool_policy_version, tool_policy_sha256,
      authorized_tools_json, handoff_contract_id, handoff_version, handoff_payload_sha256, input_sha256, created_at
    ) VALUES (?, ?, NULL, 'steward', 'steward', '1.0.0', ?, 'profile', '1.0.0', ?,
      'provider', 'model', ?, 'policy', '1.0.0', ?, '[]', NULL, NULL, NULL, ?, ?)
  `).run(invocationId, runId, hash, hash, hash, hash, hash, now);
  workspace.db.prepare(`
    INSERT INTO agent_tool_invocations (
      id, run_id, invocation_id, tool_name, arguments_sha256, created_at
    ) VALUES (?, ?, ?, 'retrieve_graph_evidence', ?, ?)
  `).run(toolInvocationId, runId, invocationId, hash, now);
  return { runId, toolInvocationId };
}

function seedLegacyV25Closure(workspace: WorkspaceDatabase): void {
  const goal = new GrowthRepository(workspace).getGoal("legacy-v24-goal")!;
  const checkpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
  const now = new Date().toISOString();
  const payloadHash = "e".repeat(64);
  workspace.db.prepare(`
    INSERT INTO growth_closure_profiles (
      id, idempotency_key, payload_hash, goal_id, profile_kind, subject_resource_id,
      current_revision, current_epoch, created_at, updated_at, contract_generation, focus_oc_resource_id
    ) VALUES ('legacy-v25-profile', 'legacy-v25-profile-key', ?, ?, 'world_birth', NULL, 1, 1, ?, ?, 'v26', NULL)
  `).run(payloadHash, goal.id, now, now);
  workspace.db.prepare(`
    INSERT INTO growth_closure_profile_revisions (
      profile_id, revision, epoch, checkpoint_id, rule_revision, idempotency_key, payload_hash,
      created_at, contract_generation, focus_oc_resource_id
    ) VALUES ('legacy-v25-profile', 1, 1, ?, 1, 'legacy-v25-revision-key', ?, ?, 'v26', NULL)
  `).run(checkpointId, payloadHash, now);
  workspace.db.prepare(`
    INSERT INTO growth_closure_facets (
      profile_id, revision, facet_id, facet_kind, required, ordinal
    ) VALUES ('legacy-v25-profile', 1, 'history', 'content', 1, 0)
  `).run();
  const cycle = workspace.db.prepare(`
    SELECT run_id, receipt_id FROM growth_cycles WHERE id = 'legacy-v24-cycle'
  `).get() as { run_id: string; receipt_id: string };
  const stewardInvocation = workspace.db.prepare(`
    SELECT id FROM agent_invocations WHERE run_id = ? AND role = 'steward' ORDER BY created_at, id LIMIT 1
  `).get(cycle.run_id) as { id: string };
  const checkerInvocationId = randomUUID();
  const outputHash = "f".repeat(64);
  workspace.db.prepare(`
    INSERT INTO agent_invocations (
      id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256,
      agent_profile_id, agent_profile_version, agent_profile_sha256, provider_id, requested_model_id,
      provider_config_sha256, tool_policy_id, tool_policy_version, tool_policy_sha256,
      authorized_tools_json, handoff_contract_id, handoff_version, handoff_payload_sha256, input_sha256, created_at
    )
    SELECT ?, run_id, id, 'checker', 'checker', prompt_version, prompt_sha256,
      'checker-profile', agent_profile_version, agent_profile_sha256, provider_id, requested_model_id,
      provider_config_sha256, tool_policy_id, tool_policy_version, tool_policy_sha256,
      authorized_tools_json, 'legacy-checker-handoff', '1.0.0', ?, input_sha256, ?
    FROM agent_invocations WHERE id = ?
  `).run(checkerInvocationId, outputHash, now, stewardInvocation.id);
  const insertAssessment = workspace.db.prepare(`
    INSERT INTO growth_closure_assessments (
      id, profile_id, revision, role, decision, cycle_id, checkpoint_id, rule_revision, receipt_id,
      agent_invocation_id, output_sha256, idempotency_key, payload_hash, created_at, contract_generation
    ) VALUES (?, 'legacy-v25-profile', 1, ?, ?, 'legacy-v24-cycle', ?, 1, ?, ?, ?, ?, ?, ?, 'v26')
  `);
  insertAssessment.run("legacy-v25-steward", "steward", "ready_for_checker", checkpointId, cycle.receipt_id,
    stewardInvocation.id, outputHash, "legacy-v25-steward-key", "a".repeat(64), now);
  insertAssessment.run("legacy-v25-checker", "checker", "accepted", checkpointId, cycle.receipt_id,
    checkerInvocationId, outputHash, "legacy-v25-checker-key", "b".repeat(64), now);
  workspace.db.prepare(`
    INSERT INTO growth_closure_reviews (
      id, profile_id, revision, steward_assessment_id, checker_assessment_id, checker_decision,
      idempotency_key, payload_hash, created_at, contract_generation
    ) VALUES (
      'legacy-v25-review', 'legacy-v25-profile', 1, 'legacy-v25-steward', 'legacy-v25-checker', 'accepted',
      'legacy-v25-review-key', ?, ?, 'v26'
    )
  `).run("c".repeat(64), now);
  workspace.db.prepare(`
    INSERT INTO growth_closure_review_findings (
      review_id, profile_id, revision, facet_id, state, safe_summary, receipt_id, rank, ordinal
    ) VALUES (
      'legacy-v25-review', 'legacy-v25-profile', 1, 'history', 'satisfied',
      'Legacy accepted review.', ?, 1, 0
    )
  `).run(cycle.receipt_id);
}

function downgradeToSchema24(workspace: WorkspaceDatabase): void {
  downgradeToSchema25(workspace);
  workspace.db.exec("BEGIN IMMEDIATE");
  try {
    workspace.db.exec(`
      DROP TABLE growth_inquiry_event_sources;
      DROP TABLE growth_inquiry_lifecycle;
      DROP TABLE growth_inquiry_creator_answers;
      DROP TABLE growth_inquiry_details;
      DROP TABLE growth_inquiry_batch_contracts;
      DROP INDEX growth_inquiry_batches_id_cycle_idx;
      DROP INDEX growth_cycles_inquiry_source_idx;

      ALTER TABLE growth_events RENAME TO growth_events_v25_test;
      CREATE TABLE growth_events (
        goal_id TEXT NOT NULL REFERENCES growth_goals(id) ON DELETE CASCADE,
        cycle_id TEXT NOT NULL REFERENCES growth_cycles(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        safe_summary TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('goal_created', 'rule_appended', 'cycle_planned', 'run_attached', 'receipt_recorded', 'change_set_committed', 'cycle_terminal')),
        target_kind TEXT NOT NULL CHECK (target_kind IN ('document', 'resource', 'assertion', 'relation', 'image', 'change_set')),
        target_id TEXT NOT NULL,
        target_version_id TEXT,
        durable_state TEXT NOT NULL CHECK (durable_state IN ('planned', 'running', 'committed', 'blocked', 'failed', 'cancelled', 'reconciliation_required')),
        content_ref_kind TEXT CHECK (content_ref_kind IN ('document', 'resource', 'assertion', 'relation', 'image', 'change_set')),
        content_ref_id TEXT,
        content_ref_version_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, sequence),
        CHECK (
          (content_ref_kind IS NULL AND content_ref_id IS NULL AND content_ref_version_id IS NULL)
          OR (content_ref_kind IS NOT NULL AND content_ref_id IS NOT NULL AND content_ref_version_id IS NOT NULL)
        ),
        CHECK (durable_state <> 'committed' OR phase = 'change_set_committed'),
        CHECK (phase <> 'change_set_committed' OR target_kind = 'change_set')
      );
      INSERT INTO growth_events (
        goal_id, cycle_id, run_id, sequence, safe_summary, phase, target_kind, target_id, target_version_id,
        durable_state, content_ref_kind, content_ref_id, content_ref_version_id, created_at
      ) SELECT
        goal_id, cycle_id, run_id, sequence, safe_summary, phase, target_kind, target_id, target_version_id,
        durable_state, content_ref_kind, content_ref_id, content_ref_version_id, created_at
      FROM growth_events_v25_test;
      DROP TABLE growth_events_v25_test;
      CREATE INDEX growth_events_cycle_idx ON growth_events(cycle_id, sequence);
      UPDATE schema_meta SET version = 24 WHERE singleton = 1;
    `);
    workspace.db.exec("COMMIT");
  } catch (error) {
    workspace.db.exec("ROLLBACK");
    throw error;
  }
}

function downgradeToSchema25(workspace: WorkspaceDatabase): void {
  downgradeToSchema27(workspace);
  workspace.db.exec("PRAGMA foreign_keys = OFF");
  workspace.db.exec("BEGIN IMMEDIATE");
  try {
    workspace.db.exec(`
      DROP TABLE safe_diagnostic_events;
      DROP TABLE growth_closure_repair_backlog;
      DROP TABLE growth_closure_repair_lineage;
      DROP TABLE growth_closure_evaluation_outcomes;
      DROP TABLE growth_closure_adverse_finding_evidence;
      DROP TABLE growth_closure_adverse_findings;
      DROP TABLE growth_closure_facet_result_evidence;
      DROP TABLE growth_closure_facet_results;
      DROP TABLE growth_closure_profile_components;

      ALTER TABLE growth_closure_profiles DROP COLUMN focus_oc_resource_id;
      ALTER TABLE growth_closure_profiles DROP COLUMN contract_generation;
      ALTER TABLE growth_closure_profile_revisions DROP COLUMN focus_oc_resource_id;
      ALTER TABLE growth_closure_profile_revisions DROP COLUMN contract_generation;
      ALTER TABLE growth_closure_assessments DROP COLUMN contract_generation;
      ALTER TABLE growth_closure_reviews DROP COLUMN contract_generation;

      CREATE TABLE growth_cycles_v25_test (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES growth_goals(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        input_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
        run_id TEXT UNIQUE REFERENCES agent_runs(id),
        receipt_id TEXT UNIQUE REFERENCES growth_retrieval_receipts(id),
        change_set_id TEXT UNIQUE REFERENCES change_sets(id),
        output_checkpoint_id TEXT REFERENCES checkpoints(id),
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'committed', 'blocked', 'failed', 'cancelled', 'reconciliation_required')),
        failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT,
        UNIQUE (goal_id, sequence),
        FOREIGN KEY (goal_id, rule_revision) REFERENCES growth_goal_rule_revisions(goal_id, revision),
        CHECK (
          (status = 'planned' AND run_id IS NULL AND receipt_id IS NULL AND change_set_id IS NULL AND output_checkpoint_id IS NULL AND failure_code IS NULL AND terminal_at IS NULL)
          OR (status = 'running' AND run_id IS NOT NULL AND change_set_id IS NULL AND output_checkpoint_id IS NULL AND failure_code IS NULL AND terminal_at IS NULL)
          OR (status = 'committed' AND run_id IS NOT NULL AND receipt_id IS NOT NULL AND change_set_id IS NOT NULL AND output_checkpoint_id IS NOT NULL AND failure_code IS NULL AND terminal_at IS NOT NULL)
          OR (status IN ('blocked', 'failed', 'cancelled', 'reconciliation_required') AND change_set_id IS NULL AND output_checkpoint_id IS NULL AND failure_code IS NOT NULL AND terminal_at IS NOT NULL)
        )
      );
      INSERT INTO growth_cycles_v25_test SELECT * FROM growth_cycles;
      DROP TABLE growth_cycles;
      ALTER TABLE growth_cycles_v25_test RENAME TO growth_cycles;
      CREATE INDEX growth_cycles_goal_status_idx ON growth_cycles(goal_id, status, sequence);
      CREATE UNIQUE INDEX growth_cycles_one_open_goal_idx ON growth_cycles(goal_id) WHERE status IN ('planned', 'running');
      CREATE UNIQUE INDEX growth_cycles_id_rule_idx ON growth_cycles(id, rule_revision);
      CREATE UNIQUE INDEX growth_cycles_inquiry_source_idx ON growth_cycles(id, receipt_id, input_checkpoint_id, rule_revision);

      CREATE TABLE growth_cycle_intents_v25_test (
        cycle_id TEXT PRIMARY KEY REFERENCES growth_cycles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('expand', 'revision')),
        created_at TEXT NOT NULL
      );
      INSERT INTO growth_cycle_intents_v25_test (cycle_id, kind, created_at)
        SELECT cycle_id, kind, created_at FROM growth_cycle_intents;
      DROP TABLE growth_cycle_intents;
      ALTER TABLE growth_cycle_intents_v25_test RENAME TO growth_cycle_intents;

      CREATE TABLE growth_events_v25_test (
        goal_id TEXT NOT NULL REFERENCES growth_goals(id) ON DELETE CASCADE,
        cycle_id TEXT NOT NULL REFERENCES growth_cycles(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id), sequence INTEGER NOT NULL CHECK (sequence >= 1),
        safe_summary TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN (
          'goal_created', 'rule_appended', 'cycle_planned', 'run_attached', 'receipt_recorded',
          'inquiry_selected', 'creator_choice_required', 'change_set_committed', 'cycle_terminal'
        )),
        target_kind TEXT NOT NULL CHECK (target_kind IN ('document', 'resource', 'assertion', 'relation', 'image', 'change_set', 'inquiry')),
        target_id TEXT NOT NULL, target_version_id TEXT,
        durable_state TEXT NOT NULL CHECK (durable_state IN ('planned', 'running', 'committed', 'blocked', 'failed', 'cancelled', 'reconciliation_required')),
        content_ref_kind TEXT CHECK (content_ref_kind IN ('document', 'resource', 'assertion', 'relation', 'image', 'change_set')),
        content_ref_id TEXT, content_ref_version_id TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, sequence),
        CHECK ((content_ref_kind IS NULL AND content_ref_id IS NULL AND content_ref_version_id IS NULL)
          OR (content_ref_kind IS NOT NULL AND content_ref_id IS NOT NULL AND content_ref_version_id IS NOT NULL)),
        CHECK (durable_state <> 'committed' OR phase = 'change_set_committed'),
        CHECK (phase <> 'change_set_committed' OR target_kind = 'change_set')
      );
      INSERT INTO growth_events_v25_test SELECT * FROM growth_events;
      DROP TABLE growth_events;
      ALTER TABLE growth_events_v25_test RENAME TO growth_events;
      CREATE INDEX growth_events_cycle_idx ON growth_events(cycle_id, sequence);
      UPDATE schema_meta SET version = 25 WHERE singleton = 1;
    `);
    workspace.db.exec("COMMIT");
  } catch (error) {
    workspace.db.exec("ROLLBACK");
    throw error;
  } finally {
    workspace.db.exec("PRAGMA foreign_keys = ON");
  }
}

function downgradeToSchema27(workspace: WorkspaceDatabase): void {
  downgradeToSchema28(workspace);
  workspace.db.exec("PRAGMA foreign_keys = OFF");
  workspace.db.exec("BEGIN IMMEDIATE");
  try {
    workspace.db.exec(`
      DROP TABLE growth_work_order_artifacts;
      DROP TABLE growth_editorial_reviews;
      DROP TABLE growth_work_order_attempts;
      DROP TABLE growth_work_order_dependencies;
      DROP TABLE growth_work_orders;
      DROP TABLE growth_editorial_rounds;
      UPDATE schema_meta SET version = 27 WHERE singleton = 1;
    `);
    workspace.db.exec("COMMIT");
  } catch (error) {
    workspace.db.exec("ROLLBACK");
    throw error;
  } finally {
    workspace.db.exec("PRAGMA foreign_keys = ON");
  }
}

function downgradeToSchema28(workspace: WorkspaceDatabase): void {
  workspace.db.exec("PRAGMA foreign_keys = OFF");
  workspace.db.exec("BEGIN IMMEDIATE");
  try {
    workspace.db.exec(`
      DROP TABLE causal_relation_sources;
      DROP TABLE causal_relation_versions;
      DROP TABLE causal_relations;
      UPDATE schema_meta SET version = 28 WHERE singleton = 1;
    `);
    workspace.db.exec("COMMIT");
  } catch (error) {
    workspace.db.exec("ROLLBACK");
    throw error;
  } finally {
    workspace.db.exec("PRAGMA foreign_keys = ON");
  }
}
