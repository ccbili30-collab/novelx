import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WorkspaceDatabase {
  readonly db: DatabaseSync;
  readonly workspaceId: string;
  readonly rootPath: string;
  close(): void;
}

export function openWorkspace(rootPathInput: string): WorkspaceDatabase {
  const rootPath = path.resolve(rootPathInput);
  const metadataRoot = path.join(rootPath, ".novax");
  fs.mkdirSync(metadataRoot, { recursive: true });
  const db = new DatabaseSync(path.join(metadataRoot, "workspace.db"));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  ensureOptionalRetrievalIndex(db);
  const state = db.prepare("SELECT workspace_id FROM workspace_state WHERE singleton = 1").get() as { workspace_id: string };

  return {
    db,
    workspaceId: state.workspace_id,
    rootPath,
    close: () => db.close(),
  };
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      head_checkpoint_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'archived')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      parent_checkpoint_id TEXT REFERENCES checkpoints(id),
      sequence INTEGER NOT NULL,
      label TEXT NOT NULL,
      actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'agent', 'import')),
      source_change_set_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS checkpoints_parent_idx ON checkpoints(parent_checkpoint_id);
    CREATE TABLE IF NOT EXISTS workspace_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      workspace_id TEXT NOT NULL,
      active_branch_id TEXT NOT NULL REFERENCES branches(id)
    );
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS resource_revisions (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES resources(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      parent_resource_id TEXT REFERENCES resources(id),
      created_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resource_revisions_identity_idx ON resource_revisions(resource_id, created_checkpoint_id);
    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES resources(id),
      created_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'import')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS document_versions_resource_idx ON document_versions(resource_id, created_checkpoint_id);
    CREATE TABLE IF NOT EXISTS working_documents (
      branch_id TEXT NOT NULL REFERENCES branches(id),
      resource_id TEXT NOT NULL REFERENCES resources(id),
      base_version_id TEXT REFERENCES document_versions(id),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      edit_revision INTEGER NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (branch_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS change_sets (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      base_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      committed_checkpoint_id TEXT REFERENCES checkpoints(id),
      mode TEXT NOT NULL CHECK (mode IN ('free', 'assist')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rejected', 'failed')),
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      committed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS assertion_versions (
      id TEXT PRIMARY KEY,
      assertion_id TEXT NOT NULL,
      created_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_json TEXT NOT NULL CHECK (json_valid(object_json)),
      status TEXT NOT NULL CHECK (status IN ('current', 'conflict', 'superseded', 'rejected', 'draft')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assertion_versions_identity_idx ON assertion_versions(assertion_id, created_checkpoint_id);
    CREATE INDEX IF NOT EXISTS assertion_versions_scope_idx ON assertion_versions(scope_type, scope_id);
    CREATE TABLE IF NOT EXISTS source_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assertion_sources (
      assertion_version_id TEXT NOT NULL REFERENCES assertion_versions(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES source_records(id),
      PRIMARY KEY (assertion_version_id, source_id)
    );
  `);

  let schema = db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get() as { version: number } | undefined;
  if (!schema) {
    db.prepare("INSERT INTO schema_meta (singleton, version) VALUES (1, 1)").run();
    schema = { version: 1 };
  }
  if (schema.version === 1) {
    migrateChangeSetReviewSchema(db);
    schema = { version: 2 };
  }
  if (schema.version === 2) {
    migrateAgentAuditSchema(db);
    schema = { version: 3 };
  }
  if (schema.version === 3) {
    migrateChangeSetOutputProvenanceSchema(db);
    schema = { version: 4 };
  }
  if (schema.version === 4) {
    migrateStructuredSubmissionCorrectionAudit(db);
    schema = { version: 5 };
  }
  if (schema.version === 5) {
    migrateCreativeObjectSchema(db);
    schema = { version: 6 };
  }
  if (schema.version === 6) {
    migrateCreativeOutputProvenanceSchema(db);
    schema = { version: 7 };
  }
  if (schema.version === 7) {
    migrateContextBudgetAuditSchema(db);
    schema = { version: 8 };
  }
  if (schema.version === 8) {
    migrateCheckpointAttributionSchema(db);
    schema = { version: 9 };
  }
  if (schema.version === 9) {
    migrateCreativeCommitProjectionSchema(db);
    schema = { version: 10 };
  }
  if (schema.version === 10) {
    migrateProjectionArtifactSchema(db);
    schema = { version: 11 };
  }
  if (schema.version === 11) {
    migrateStoryPlaythroughSchema(db);
    schema = { version: 12 };
  }
  if (schema.version === 12) {
    migrateSourceImportSchema(db);
    schema = { version: 13 };
  }
  if (schema.version === 13) {
    migrateImportReviewSchema(db);
    schema = { version: 14 };
  }
  if (schema.version === 14) {
    migrateStartProfilePlaythroughSchema(db);
    schema = { version: 15 };
  }
  if (schema.version !== 15) throw new Error(`Unsupported Novax workspace schema: ${schema.version}`);

  const existing = db.prepare("SELECT workspace_id FROM workspace_state WHERE singleton = 1").get();
  if (existing) return;

  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const branchId = randomUUID();
  const checkpointId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO branches (id, name, head_checkpoint_id, status, created_at) VALUES (?, ?, NULL, 'open', ?)")
      .run(branchId, "main", now);
    db.prepare("INSERT INTO checkpoints (id, branch_id, parent_checkpoint_id, sequence, label, actor_kind, source_change_set_id, created_at) VALUES (?, ?, NULL, 0, ?, 'import', NULL, ?)")
      .run(checkpointId, branchId, "工作区初始化", now);
    db.prepare(`
      INSERT INTO creative_commits (
        id, branch_id, parent_commit_id, kind, actor_kind, source_change_set_id,
        label, manifest_sha256, sealed_at, created_at
      ) VALUES (?, ?, NULL, 'initialization', 'import', NULL, ?, NULL, NULL, ?)
    `).run(checkpointId, branchId, "工作区初始化", now);
    db.prepare("UPDATE branches SET head_checkpoint_id = ? WHERE id = ?").run(checkpointId, branchId);
    db.prepare("INSERT INTO workspace_state (singleton, workspace_id, active_branch_id) VALUES (1, ?, ?)")
      .run(workspaceId, branchId);
    const insertResource = db.prepare("INSERT INTO resources (id) VALUES (?)");
    const insertRevision = db.prepare(`
      INSERT INTO resource_revisions (
        id, resource_id, type, object_kind, title, parent_resource_id, created_checkpoint_id, state, sort_order, created_at
      ) VALUES (?, ?, ?, 'domain_root', ?, NULL, ?, 'active', ?, ?)
    `);
    for (const [index, [type, title]] of TOP_LEVEL_RESOURCES.entries()) {
      const resourceId = randomUUID();
      insertResource.run(resourceId);
      insertRevision.run(randomUUID(), resourceId, type, title, checkpointId, index, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateStartProfilePlaythroughSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasColumn(db, "playthroughs", "start_profile_id")) {
      db.exec("ALTER TABLE playthroughs ADD COLUMN start_profile_id TEXT REFERENCES start_profiles(id)");
    }
    if (!hasColumn(db, "playthroughs", "initial_state_snapshot_json")) {
      db.exec("ALTER TABLE playthroughs ADD COLUMN initial_state_snapshot_json TEXT CHECK (initial_state_snapshot_json IS NULL OR json_valid(initial_state_snapshot_json))");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS start_profiles_story_idx
        ON start_profiles(story_profile_id, status, created_at, id);
      CREATE TRIGGER IF NOT EXISTS start_profiles_identity_immutable
      BEFORE UPDATE OF story_profile_id, source_id, title, start_state_json, created_at ON start_profiles BEGIN
        SELECT RAISE(ABORT, 'START_PROFILE_IDENTITY_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS playthrough_baseline_immutable
      BEFORE UPDATE OF story_profile_id, baseline_commit_id, parent_playthrough_id, start_profile_id, initial_state_snapshot_json, created_at ON playthroughs BEGIN
        SELECT RAISE(ABORT, 'PLAYTHROUGH_BASELINE_IMMUTABLE');
      END;
      UPDATE schema_meta SET version = 15 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateImportReviewSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS decomposition_candidate_revisions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES decomposition_candidates(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        editor_kind TEXT NOT NULL CHECK (editor_kind IN ('user', 'agent')),
        created_at TEXT NOT NULL,
        UNIQUE (candidate_id, revision)
      );
      CREATE TABLE IF NOT EXISTS import_review_decisions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES decomposition_candidates(id),
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
        candidate_revision INTEGER NOT NULL CHECK (candidate_revision > 0),
        decided_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS start_profiles (
        id TEXT PRIMARY KEY,
        story_profile_id TEXT NOT NULL REFERENCES story_profiles(id),
        source_id TEXT REFERENCES source_library_entries(id),
        title TEXT NOT NULL,
        start_state_json TEXT NOT NULL CHECK (json_valid(start_state_json)),
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS decomposition_candidate_revisions_update_guard
      BEFORE UPDATE ON decomposition_candidate_revisions BEGIN
        SELECT RAISE(ABORT, 'DECOMPOSITION_CANDIDATE_REVISION_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS import_review_decisions_update_guard
      BEFORE UPDATE ON import_review_decisions BEGIN
        SELECT RAISE(ABORT, 'IMPORT_REVIEW_DECISION_IMMUTABLE');
      END;
      INSERT INTO decomposition_candidate_revisions (
        id, candidate_id, revision, payload_json, editor_kind, created_at
      )
      SELECT lower(hex(randomblob(16))), dc.id, 1, dc.payload_json, 'agent', dc.created_at
      FROM decomposition_candidates dc
      WHERE NOT EXISTS (
        SELECT 1 FROM decomposition_candidate_revisions dcr WHERE dcr.candidate_id = dc.id
      );
      UPDATE schema_meta SET version = 14 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateSourceImportSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_library_entries (
        id TEXT PRIMARY KEY,
        original_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('txt', 'markdown', 'docx', 'epub', 'image')),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        rights_attestation TEXT NOT NULL CHECK (rights_attestation IN ('user_owned', 'licensed', 'public_domain', 'unknown')),
        state TEXT NOT NULL CHECK (state IN ('registered', 'parsed', 'failed', 'missing')),
        created_at TEXT NOT NULL,
        UNIQUE (original_path, content_sha256)
      );
      CREATE INDEX IF NOT EXISTS source_library_hash_idx
        ON source_library_entries(content_sha256, format);
      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_library_entries(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        created_at TEXT NOT NULL,
        UNIQUE (source_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS import_jobs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_library_entries(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('parse', 'decompose')),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (source_id, kind, attempt)
      );
      CREATE TABLE IF NOT EXISTS decomposition_candidates (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_library_entries(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('character', 'world_rule', 'location', 'faction', 'event', 'style', 'ambiguity')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
        source_locator_json TEXT NOT NULL CHECK (json_valid(source_locator_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS source_chunks_update_guard
      BEFORE UPDATE ON source_chunks BEGIN
        SELECT RAISE(ABORT, 'SOURCE_CHUNK_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS source_chunks_delete_guard
      BEFORE DELETE ON source_chunks BEGIN
        SELECT RAISE(ABORT, 'SOURCE_CHUNK_IMMUTABLE');
      END;
      UPDATE schema_meta SET version = 13 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateStoryPlaythroughSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS story_profiles (
        id TEXT PRIMARY KEY,
        story_resource_id TEXT NOT NULL REFERENCES resources(id),
        world_resource_id TEXT NOT NULL REFERENCES resources(id),
        canon_commit_id TEXT NOT NULL REFERENCES creative_commits(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS story_profiles_story_idx
        ON story_profiles(story_resource_id, status, created_at);
      CREATE TABLE IF NOT EXISTS story_profile_oc_bindings (
        story_profile_id TEXT NOT NULL REFERENCES story_profiles(id) ON DELETE CASCADE,
        oc_resource_id TEXT NOT NULL REFERENCES resources(id),
        variant_resource_id TEXT REFERENCES resources(id),
        PRIMARY KEY (story_profile_id, oc_resource_id)
      );
      CREATE TABLE IF NOT EXISTS playthroughs (
        id TEXT PRIMARY KEY,
        story_profile_id TEXT NOT NULL REFERENCES story_profiles(id),
        baseline_commit_id TEXT NOT NULL REFERENCES creative_commits(id),
        parent_playthrough_id TEXT REFERENCES playthroughs(id),
        current_turn_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS playthroughs_profile_idx
        ON playthroughs(story_profile_id, status, created_at);
      CREATE TABLE IF NOT EXISTS play_turns (
        id TEXT PRIMARY KEY,
        playthrough_id TEXT NOT NULL REFERENCES playthroughs(id) ON DELETE CASCADE,
        parent_turn_id TEXT REFERENCES play_turns(id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        player_action TEXT NOT NULL,
        gm_resolution_json TEXT NOT NULL CHECK (json_valid(gm_resolution_json)),
        gm_resolution_sha256 TEXT NOT NULL CHECK (length(gm_resolution_sha256) = 64),
        writer_text TEXT NOT NULL,
        writer_sha256 TEXT NOT NULL CHECK (length(writer_sha256) = 64),
        state_snapshot_json TEXT NOT NULL CHECK (json_valid(state_snapshot_json)),
        created_at TEXT NOT NULL,
        UNIQUE (playthrough_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS canon_reconciliation_decisions (
        id TEXT PRIMARY KEY,
        playthrough_id TEXT NOT NULL REFERENCES playthroughs(id),
        current_commit_id TEXT NOT NULL REFERENCES creative_commits(id),
        decision TEXT NOT NULL CHECK (decision IN ('continue_pinned', 'fork_from_current')),
        forked_playthrough_id TEXT REFERENCES playthroughs(id),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS play_turns_update_guard
      BEFORE UPDATE ON play_turns BEGIN
        SELECT RAISE(ABORT, 'PLAY_TURN_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS play_turns_delete_guard
      BEFORE DELETE ON play_turns BEGIN
        SELECT RAISE(ABORT, 'PLAY_TURN_IMMUTABLE');
      END;
      UPDATE schema_meta SET version = 12 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateProjectionArtifactSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projection_artifacts (
        run_id TEXT NOT NULL REFERENCES projection_runs(id) ON DELETE CASCADE,
        artifact_key TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
        artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, artifact_key)
      );
      CREATE INDEX IF NOT EXISTS projection_artifacts_run_idx
        ON projection_artifacts(run_id, artifact_key);
      CREATE TABLE IF NOT EXISTS retrieval_index_capability (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        available INTEGER NOT NULL CHECK (available IN (0, 1)),
        checked_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS projection_artifacts_insert_guard
      BEFORE INSERT ON projection_artifacts
      WHEN (SELECT status FROM projection_runs WHERE id = NEW.run_id) <> 'running'
      BEGIN
        SELECT RAISE(ABORT, 'PROJECTION_RUN_NOT_WRITABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS projection_artifacts_update_guard
      BEFORE UPDATE ON projection_artifacts
      BEGIN
        SELECT RAISE(ABORT, 'PROJECTION_ARTIFACT_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS projection_artifacts_delete_guard
      BEFORE DELETE ON projection_artifacts
      BEGIN
        SELECT RAISE(ABORT, 'PROJECTION_ARTIFACT_IMMUTABLE');
      END;
      UPDATE schema_meta SET version = 11 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureOptionalRetrievalIndex(db: DatabaseSync): void {
  let available = 1;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(
        run_id UNINDEXED,
        commit_id UNINDEXED,
        artifact_key UNINDEXED,
        title,
        content,
        tokenize = 'trigram'
      );
    `);
  } catch {
    available = 0;
  }
  db.prepare(`
    INSERT INTO retrieval_index_capability (singleton, available, checked_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET available = excluded.available, checked_at = excluded.checked_at
  `).run(available, new Date().toISOString());
}

function migrateCreativeCommitProjectionSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS creative_commits (
        id TEXT PRIMARY KEY REFERENCES checkpoints(id) ON DELETE CASCADE,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        parent_commit_id TEXT REFERENCES creative_commits(id),
        kind TEXT NOT NULL CHECK (kind IN ('initialization', 'manual', 'change_set', 'import', 'retcon')),
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'import')),
        source_change_set_id TEXT,
        label TEXT NOT NULL,
        manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
        sealed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS creative_commits_branch_idx ON creative_commits(branch_id, created_at, id);
      CREATE TABLE IF NOT EXISTS creative_commit_entries (
        commit_id TEXT NOT NULL REFERENCES creative_commits(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        artifact_kind TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
        source_item_id TEXT,
        PRIMARY KEY (commit_id, artifact_kind, artifact_id),
        UNIQUE (commit_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS projection_runs (
        id TEXT PRIMARY KEY,
        commit_id TEXT NOT NULL REFERENCES creative_commits(id) ON DELETE CASCADE,
        projection_kind TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
        output_sha256 TEXT CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (commit_id, projection_kind, attempt)
      );
      CREATE INDEX IF NOT EXISTS projection_runs_commit_idx
        ON projection_runs(commit_id, projection_kind, attempt DESC);
      CREATE TRIGGER IF NOT EXISTS creative_commits_sealed_immutable
      BEFORE UPDATE OF manifest_sha256, sealed_at ON creative_commits
      WHEN OLD.sealed_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'CREATIVE_COMMIT_ALREADY_SEALED');
      END;
      CREATE TRIGGER IF NOT EXISTS creative_commit_entries_insert_guard
      BEFORE INSERT ON creative_commit_entries
      WHEN (SELECT sealed_at FROM creative_commits WHERE id = NEW.commit_id) IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'CREATIVE_COMMIT_ALREADY_SEALED');
      END;
      CREATE TRIGGER IF NOT EXISTS creative_commit_entries_update_guard
      BEFORE UPDATE ON creative_commit_entries
      WHEN (SELECT sealed_at FROM creative_commits WHERE id = OLD.commit_id) IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'CREATIVE_COMMIT_ALREADY_SEALED');
      END;
      CREATE TRIGGER IF NOT EXISTS creative_commit_entries_delete_guard
      BEFORE DELETE ON creative_commit_entries
      WHEN (SELECT sealed_at FROM creative_commits WHERE id = OLD.commit_id) IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'CREATIVE_COMMIT_ALREADY_SEALED');
      END;
      INSERT OR IGNORE INTO creative_commits (
        id, branch_id, parent_commit_id, kind, actor_kind, source_change_set_id,
        label, manifest_sha256, sealed_at, created_at
      )
      SELECT id, branch_id, parent_checkpoint_id,
        CASE
          WHEN sequence = 0 THEN 'initialization'
          WHEN source_change_set_id IS NOT NULL THEN 'change_set'
          WHEN actor_kind = 'import' THEN 'import'
          ELSE 'manual'
        END,
        actor_kind, source_change_set_id, label, NULL, NULL, created_at
      FROM checkpoints;
      UPDATE schema_meta SET version = 10 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateCheckpointAttributionSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasColumn(db, "checkpoints", "actor_kind")) {
      db.exec("ALTER TABLE checkpoints ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'agent', 'import'))");
    }
    if (!hasColumn(db, "checkpoints", "source_change_set_id")) {
      db.exec("ALTER TABLE checkpoints ADD COLUMN source_change_set_id TEXT");
    }
    db.exec(`
      UPDATE checkpoints
      SET actor_kind = 'agent',
          source_change_set_id = (SELECT cs.id FROM change_sets cs WHERE cs.committed_checkpoint_id = checkpoints.id LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM change_sets cs WHERE cs.committed_checkpoint_id = checkpoints.id)
    `);
    db.prepare("UPDATE schema_meta SET version = 9 WHERE singleton = 1").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateContextBudgetAuditSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(agent_audit_events)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const column of [
      "system_prompt_tokens",
      "tool_protocol_tokens",
      "session_history_tokens",
      "retrieval_tokens",
      "collaboration_tokens",
      "runtime_conversation_tokens",
      "estimated_input_tokens",
      "available_input_budget",
    ]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE agent_audit_events ADD COLUMN ${column} INTEGER`);
    }
    db.prepare("UPDATE schema_meta SET version = 8 WHERE singleton = 1").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateCreativeOutputProvenanceSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE change_set_outputs RENAME TO change_set_outputs_v6;
      CREATE TABLE change_set_outputs (
        change_set_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        output_kind TEXT NOT NULL CHECK (output_kind IN (
          'resource_revision', 'document_version', 'assertion_version',
          'creative_document_revision', 'creative_relation_revision', 'constraint_profile_version'
        )),
        output_id TEXT NOT NULL,
        output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (output_kind, output_id),
        UNIQUE (change_set_id, item_id),
        FOREIGN KEY (change_set_id, item_id)
          REFERENCES change_set_items(change_set_id, id) ON DELETE CASCADE
      );
      INSERT INTO change_set_outputs
      SELECT * FROM change_set_outputs_v6;
      DROP TABLE change_set_outputs_v6;
      CREATE INDEX change_set_outputs_change_idx
        ON change_set_outputs(change_set_id, item_id);

      ALTER TABLE agent_audit_links RENAME TO agent_audit_links_v6;
      CREATE TABLE agent_audit_links (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        invocation_id TEXT REFERENCES agent_invocations(id),
        tool_invocation_id TEXT REFERENCES agent_tool_invocations(id),
        link_kind TEXT NOT NULL CHECK (link_kind IN (
          'document_evidence', 'assertion_evidence', 'change_set_input', 'change_set_output',
          'document_version_output', 'assertion_version_output', 'resource_revision_output',
          'creative_document_revision_output', 'creative_relation_revision_output',
          'constraint_profile_version_output', 'gm_resolution', 'style_profile'
        )),
        target_id TEXT NOT NULL,
        target_sha256 TEXT,
        ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO agent_audit_links SELECT * FROM agent_audit_links_v6;
      DROP TABLE agent_audit_links_v6;
      CREATE UNIQUE INDEX agent_audit_links_identity_idx
        ON agent_audit_links(run_id, COALESCE(invocation_id, ''), COALESCE(tool_invocation_id, ''), link_kind, target_id);

      UPDATE schema_meta SET version = 7 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateCreativeObjectSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasColumn(db, "resource_revisions", "object_kind")) {
      db.exec("ALTER TABLE resource_revisions ADD COLUMN object_kind TEXT;");
    }
    if (!hasColumn(db, "document_versions", "creative_document_id")) {
      db.exec(`ALTER TABLE document_versions ADD COLUMN creative_document_id TEXT
        REFERENCES creative_documents(id);`);
    }
    db.exec(`
      UPDATE resource_revisions
      SET object_kind = CASE
        WHEN parent_resource_id IS NULL AND (
          (type = 'world' AND title = '世界') OR
          (type = 'oc' AND title = 'OC') OR
          (type = 'story' AND title = '故事') OR
          (type = 'graph' AND title = '图谱') OR
          (type = 'timeline' AND title = '时间线') OR
          (type = 'asset' AND title = '资产')
        ) THEN 'domain_root'
        WHEN type = 'world' THEN 'world'
        WHEN type = 'oc' THEN 'oc'
        WHEN type = 'story' THEN 'story'
        WHEN type = 'graph' THEN 'graph_view'
        WHEN type = 'timeline' THEN 'timeline_view'
        ELSE 'asset_collection'
      END;

      CREATE TABLE IF NOT EXISTS creative_documents (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS creative_document_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES creative_documents(id),
        resource_id TEXT NOT NULL REFERENCES resources(id),
        kind TEXT NOT NULL CHECK (kind IN (
          'prose', 'setting', 'character_profile', 'location_profile', 'faction_profile',
          'knowledge_note', 'style_guide', 'writing_constraints'
        )),
        title TEXT NOT NULL,
        created_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS creative_documents_resource_idx
        ON creative_document_revisions(resource_id, created_checkpoint_id);
      CREATE INDEX IF NOT EXISTS creative_document_revisions_identity_idx
        ON creative_document_revisions(document_id, created_checkpoint_id);

      CREATE INDEX IF NOT EXISTS document_versions_creative_document_idx
        ON document_versions(creative_document_id, created_checkpoint_id);

      CREATE TABLE IF NOT EXISTS working_creative_documents (
        branch_id TEXT NOT NULL REFERENCES branches(id),
        document_id TEXT NOT NULL REFERENCES creative_documents(id),
        base_version_id TEXT REFERENCES document_versions(id),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        edit_revision INTEGER NOT NULL,
        dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, document_id)
      );

      CREATE TABLE IF NOT EXISTS creative_relations (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS creative_relation_versions (
        id TEXT PRIMARY KEY,
        relation_id TEXT NOT NULL REFERENCES creative_relations(id),
        source_resource_id TEXT NOT NULL REFERENCES resources(id),
        target_resource_id TEXT NOT NULL REFERENCES resources(id),
        kind TEXT NOT NULL CHECK (kind IN ('uses_world', 'uses_oc', 'variant_of', 'related_to')),
        created_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
        created_at TEXT NOT NULL,
        CHECK (source_resource_id <> target_resource_id)
      );
      CREATE INDEX IF NOT EXISTS creative_relation_versions_identity_idx
        ON creative_relation_versions(relation_id, created_checkpoint_id);
      CREATE INDEX IF NOT EXISTS creative_relation_versions_source_idx
        ON creative_relation_versions(source_resource_id, created_checkpoint_id);
      CREATE INDEX IF NOT EXISTS creative_relation_versions_target_idx
        ON creative_relation_versions(target_resource_id, created_checkpoint_id);

      CREATE TABLE IF NOT EXISTS constraint_profiles (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS constraint_profile_versions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES constraint_profiles(id),
        scope_resource_id TEXT REFERENCES resources(id),
        created_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
        title TEXT NOT NULL,
        narrative_person TEXT CHECK (narrative_person IN ('first', 'second', 'third') OR narrative_person IS NULL),
        tense TEXT CHECK (tense IN ('past', 'present', 'mixed') OR tense IS NULL),
        tone TEXT,
        pacing TEXT,
        humor_level INTEGER CHECK (humor_level BETWEEN 0 AND 5 OR humor_level IS NULL),
        prohibited_content TEXT NOT NULL DEFAULT '',
        required_content TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'import')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS constraint_profile_versions_identity_idx
        ON constraint_profile_versions(profile_id, created_checkpoint_id);
      CREATE INDEX IF NOT EXISTS constraint_profile_versions_scope_idx
        ON constraint_profile_versions(scope_resource_id, created_checkpoint_id);
      CREATE TABLE IF NOT EXISTS working_constraint_profiles (
        branch_id TEXT NOT NULL REFERENCES branches(id),
        profile_id TEXT NOT NULL REFERENCES constraint_profiles(id),
        base_version_id TEXT REFERENCES constraint_profile_versions(id),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        edit_revision INTEGER NOT NULL,
        dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, profile_id)
      );

      INSERT OR IGNORE INTO creative_documents (id)
      SELECT 'legacy-document:' || resource_id
      FROM (
        SELECT resource_id FROM document_versions
        UNION
        SELECT resource_id FROM working_documents
      );

      INSERT OR IGNORE INTO creative_document_revisions (
        id, document_id, resource_id, kind, title, created_checkpoint_id, state, sort_order, created_at
      )
      SELECT
        'legacy-document-revision:' || source.resource_id,
        'legacy-document:' || source.resource_id,
        source.resource_id,
        CASE latest.type
          WHEN 'story' THEN 'prose'
          WHEN 'oc' THEN 'character_profile'
          ELSE 'setting'
        END,
        latest.title,
        source.checkpoint_id,
        'active',
        0,
        source.created_at
      FROM (
        SELECT resource_id,
          COALESCE(
            (SELECT dv.created_checkpoint_id FROM document_versions dv
              WHERE dv.resource_id = ids.resource_id ORDER BY dv.created_at ASC, dv.rowid ASC LIMIT 1),
            (SELECT b.head_checkpoint_id FROM workspace_state ws JOIN branches b ON b.id = ws.active_branch_id
              WHERE ws.singleton = 1)
          ) AS checkpoint_id,
          COALESCE(
            (SELECT dv.created_at FROM document_versions dv
              WHERE dv.resource_id = ids.resource_id ORDER BY dv.created_at ASC, dv.rowid ASC LIMIT 1),
            (SELECT c.created_at FROM workspace_state ws JOIN branches b ON b.id = ws.active_branch_id
              JOIN checkpoints c ON c.id = b.head_checkpoint_id WHERE ws.singleton = 1)
          ) AS created_at
        FROM (
          SELECT resource_id FROM document_versions
          UNION
          SELECT resource_id FROM working_documents
        ) ids
      ) source
      JOIN resource_revisions latest ON latest.id = (
        SELECT rr.id FROM resource_revisions rr
        WHERE rr.resource_id = source.resource_id
        ORDER BY rr.created_at DESC, rr.rowid DESC LIMIT 1
      );

      UPDATE document_versions
      SET creative_document_id = 'legacy-document:' || resource_id
      WHERE creative_document_id IS NULL;

      INSERT OR IGNORE INTO working_creative_documents (
        branch_id, document_id, base_version_id, content, content_hash,
        edit_revision, dirty, updated_at
      )
      SELECT branch_id, 'legacy-document:' || resource_id, base_version_id, content, content_hash,
        edit_revision, dirty, updated_at
      FROM working_documents;

      UPDATE schema_meta SET version = 6 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function migrateChangeSetOutputProvenanceSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE change_sets ADD COLUMN producer_tool_invocation_id TEXT
        REFERENCES agent_tool_invocations(id);
      CREATE TABLE change_set_outputs (
        change_set_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        output_kind TEXT NOT NULL CHECK (output_kind IN (
          'resource_revision', 'document_version', 'assertion_version'
        )),
        output_id TEXT NOT NULL,
        output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (output_kind, output_id),
        UNIQUE (change_set_id, item_id),
        FOREIGN KEY (change_set_id, item_id)
          REFERENCES change_set_items(change_set_id, id) ON DELETE CASCADE
      );
      CREATE INDEX change_set_outputs_change_idx
        ON change_set_outputs(change_set_id, item_id);
      UPDATE schema_meta SET version = 4 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateStructuredSubmissionCorrectionAudit(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE agent_audit_events ADD COLUMN correction_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (correction_attempts >= 0 AND correction_attempts <= 10);
      UPDATE schema_meta SET version = 5 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateAgentAuditSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        base_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        mode TEXT NOT NULL CHECK (mode IN ('free', 'assist')),
        user_input_sha256 TEXT NOT NULL CHECK (length(user_input_sha256) = 64),
        provider_id TEXT,
        requested_model_id TEXT,
        provider_config_sha256 TEXT,
        runtime_contract_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (provider_id IS NULL AND requested_model_id IS NULL AND provider_config_sha256 IS NULL)
          OR
          (provider_id IS NOT NULL AND requested_model_id IS NOT NULL AND provider_config_sha256 IS NOT NULL)
        )
      );
      CREATE INDEX agent_runs_created_idx ON agent_runs(created_at, id);
      CREATE TABLE agent_invocations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        parent_invocation_id TEXT REFERENCES agent_invocations(id),
        role TEXT NOT NULL CHECK (role IN ('steward', 'writer', 'checker')),
        prompt_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        agent_profile_id TEXT NOT NULL,
        agent_profile_version TEXT NOT NULL,
        agent_profile_sha256 TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        requested_model_id TEXT NOT NULL,
        provider_config_sha256 TEXT NOT NULL,
        tool_policy_id TEXT NOT NULL,
        tool_policy_version TEXT NOT NULL,
        tool_policy_sha256 TEXT NOT NULL,
        authorized_tools_json TEXT NOT NULL CHECK (json_valid(authorized_tools_json)),
        handoff_contract_id TEXT,
        handoff_version TEXT,
        handoff_payload_sha256 TEXT,
        input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
        created_at TEXT NOT NULL,
        CHECK (
          (role = 'steward' AND parent_invocation_id IS NULL AND handoff_contract_id IS NULL
            AND handoff_version IS NULL AND handoff_payload_sha256 IS NULL)
          OR
          (role IN ('writer', 'checker') AND parent_invocation_id IS NOT NULL
            AND handoff_contract_id IS NOT NULL AND handoff_version IS NOT NULL
            AND handoff_payload_sha256 IS NOT NULL)
        )
      );
      CREATE INDEX agent_invocations_run_idx ON agent_invocations(run_id, created_at, id);
      CREATE TABLE agent_tool_invocations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        invocation_id TEXT NOT NULL REFERENCES agent_invocations(id),
        tool_name TEXT NOT NULL,
        arguments_sha256 TEXT NOT NULL CHECK (length(arguments_sha256) = 64),
        created_at TEXT NOT NULL
      );
      CREATE INDEX agent_tool_invocations_run_idx ON agent_tool_invocations(run_id, created_at, id);
      CREATE TABLE agent_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('run', 'invocation', 'tool')),
        invocation_id TEXT REFERENCES agent_invocations(id),
        tool_invocation_id TEXT REFERENCES agent_tool_invocations(id),
        event_type TEXT NOT NULL,
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        error_code TEXT,
        actual_provider_id TEXT,
        actual_model_id TEXT,
        response_id_sha256 TEXT,
        stop_reason TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        context_policy_version TEXT,
        charged_input_bytes INTEGER,
        configured_context_window INTEGER,
        safety_reserve INTEGER,
        output_reserve INTEGER,
        structured_submission_count INTEGER,
        output_sha256 TEXT,
        result_sha256 TEXT,
        change_set_id TEXT REFERENCES change_sets(id),
        created_at TEXT NOT NULL,
        CHECK (
          (entity_type = 'run' AND invocation_id IS NULL AND tool_invocation_id IS NULL)
          OR (entity_type = 'invocation' AND invocation_id IS NOT NULL AND tool_invocation_id IS NULL)
          OR (entity_type = 'tool' AND invocation_id IS NOT NULL AND tool_invocation_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX agent_run_terminal_idx
        ON agent_audit_events(run_id) WHERE entity_type = 'run' AND terminal = 1;
      CREATE UNIQUE INDEX agent_invocation_terminal_idx
        ON agent_audit_events(invocation_id) WHERE entity_type = 'invocation' AND terminal = 1;
      CREATE UNIQUE INDEX agent_tool_terminal_idx
        ON agent_audit_events(tool_invocation_id) WHERE entity_type = 'tool' AND terminal = 1;
      CREATE TABLE agent_audit_links (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        invocation_id TEXT REFERENCES agent_invocations(id),
        tool_invocation_id TEXT REFERENCES agent_tool_invocations(id),
        link_kind TEXT NOT NULL CHECK (link_kind IN (
          'document_evidence', 'assertion_evidence', 'change_set_input', 'change_set_output',
          'document_version_output', 'assertion_version_output', 'resource_revision_output',
          'gm_resolution', 'style_profile'
        )),
        target_id TEXT NOT NULL,
        target_sha256 TEXT,
        ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX agent_audit_links_identity_idx
        ON agent_audit_links(run_id, COALESCE(invocation_id, ''), COALESCE(tool_invocation_id, ''), link_kind, target_id);
      UPDATE schema_meta SET version = 3 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateChangeSetReviewSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE change_sets ADD COLUMN gate_status TEXT NOT NULL DEFAULT 'review_pending'
        CHECK (gate_status IN ('review_pending', 'ready', 'blocked'));
      ALTER TABLE change_sets ADD COLUMN blocked_reason TEXT;
      ALTER TABLE change_sets ADD COLUMN failure_code TEXT;
      CREATE TABLE change_set_items (
        change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        risk TEXT NOT NULL CHECK (risk IN ('low', 'elevated')),
        conflicts_json TEXT NOT NULL CHECK (json_valid(conflicts_json)),
        decision TEXT NOT NULL CHECK (decision IN ('pending', 'accepted', 'rejected', 'draft')),
        PRIMARY KEY (change_set_id, id),
        UNIQUE (change_set_id, ordinal)
      );
      CREATE TABLE change_set_item_dependencies (
        change_set_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        depends_on_item_id TEXT NOT NULL,
        PRIMARY KEY (change_set_id, item_id, depends_on_item_id),
        FOREIGN KEY (change_set_id, item_id)
          REFERENCES change_set_items(change_set_id, id) ON DELETE CASCADE,
        FOREIGN KEY (change_set_id, depends_on_item_id)
          REFERENCES change_set_items(change_set_id, id) ON DELETE CASCADE
      );
      CREATE INDEX change_set_items_status_idx ON change_set_items(change_set_id, decision, ordinal);
      UPDATE schema_meta SET version = 2 WHERE singleton = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const TOP_LEVEL_RESOURCES = [
  ["world", "世界"],
  ["oc", "OC"],
  ["story", "故事"],
  ["graph", "图谱"],
  ["timeline", "时间线"],
  ["asset", "资产"],
] as const;
