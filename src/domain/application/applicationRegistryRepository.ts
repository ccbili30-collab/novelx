import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { agentArtifactSchema, type ProjectSummary, type SessionMessage, type SessionSummary } from "../../shared/ipcContract";
import type { SourceMaterialEntry } from "./projectDirectoryService";
import type { AgentCollaborationContext, AgentSessionHistory } from "../../shared/agentWorkerProtocol";

export type ProjectState = ProjectSummary["state"];

export interface RegisteredProject {
  id: string;
  name: string;
  rootPath: string;
  state: ProjectState;
  updatedAt: string;
}

export interface AppendMessageInput {
  sessionId: string;
  role: SessionMessage["role"];
  text: string;
  outcome: SessionMessage["outcome"];
  artifacts?: SessionMessage["artifacts"];
}

export interface SharedMemoryRecord {
  id: string;
  projectId: string;
  sourceSessionId: string | null;
  title: string;
  content: string;
  scopeResourceIds: string[];
  checkpointId: string;
  status: "active" | "superseded";
  createdAt: string;
}

export interface HandoffRecord {
  id: string;
  projectId: string;
  senderSessionId: string;
  recipientSessionId: string;
  title: string;
  instructions: string;
  scopeResourceIds: string[];
  checkpointId: string;
  status: "pending" | "accepted" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export class ApplicationRegistryRepository {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
    `);
    this.#migrate();
  }

  registerProject(rootPathInput: string, state: ProjectState): RegisteredProject {
    const rootPath = path.resolve(rootPathInput);
    const normalizedPath = normalizeProjectPath(rootPath);
    const existing = this.#db.prepare(`
      SELECT id, state FROM application_projects WHERE normalized_path = ?
    `).get(normalizedPath) as { id: string; state: ProjectState } | undefined;
    const now = new Date().toISOString();
    const name = path.basename(rootPath) || rootPath;
    if (existing) {
      const nextState = existing.state === "ready" ? "ready" : state;
      this.#db.prepare(`
        UPDATE application_projects
        SET root_path = ?, name = ?, state = ?, updated_at = ?, removed_at = NULL
        WHERE id = ?
      `).run(rootPath, name, nextState, now, existing.id);
      return this.getProject(existing.id);
    }
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO application_projects (
        id, root_path, normalized_path, name, state, created_at, updated_at, removed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, rootPath, normalizedPath, name, state, now, now);
    return this.getProject(id);
  }

  getProject(projectId: string): RegisteredProject {
    const row = this.#db.prepare(`
      SELECT id, name, root_path, state, updated_at
      FROM application_projects WHERE id = ? AND removed_at IS NULL
    `).get(projectId);
    if (!row) throw registryError("PROJECT_NOT_FOUND");
    return mapRegisteredProject(row);
  }

  listProjects(): ProjectSummary[] {
    const activeProjectId = this.getActiveProjectId();
    const rows = this.#db.prepare(`
      SELECT p.id, p.name, p.state, p.updated_at,
        (SELECT COUNT(*) FROM agent_sessions s WHERE s.project_id = p.id AND s.archived = 0) AS session_count
      FROM application_projects p
      WHERE p.removed_at IS NULL
      ORDER BY p.updated_at DESC, p.rowid DESC
    `).all();
    return rows.map((row) => mapProjectSummary(row, activeProjectId));
  }

  listRemovedProjects(): ProjectSummary[] {
    const rows = this.#db.prepare(`
      SELECT p.id, p.name, p.state, p.updated_at,
        (SELECT COUNT(*) FROM agent_sessions s WHERE s.project_id = p.id AND s.archived = 0) AS session_count
      FROM application_projects p
      WHERE p.removed_at IS NOT NULL
      ORDER BY p.removed_at DESC, p.rowid DESC
    `).all();
    return rows.map((row) => mapProjectSummary(row, null));
  }

  selectProject(projectId: string): RegisteredProject {
    const project = this.getProject(projectId);
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE application_state SET active_project_id = ? WHERE singleton = 1").run(projectId);
    this.#db.prepare("UPDATE application_projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    return { ...project, updatedAt: now };
  }

  getActiveProjectId(): string | null {
    const row = this.#db.prepare("SELECT active_project_id FROM application_state WHERE singleton = 1").get() as {
      active_project_id: string | null;
    };
    return row.active_project_id;
  }

  setProjectState(projectId: string, state: ProjectState): RegisteredProject {
    this.getProject(projectId);
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE application_projects SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, now, projectId);
    return this.getProject(projectId);
  }

  removeProject(projectId: string): void {
    this.getProject(projectId);
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE application_projects SET removed_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, projectId);
      this.#db.prepare("UPDATE application_state SET active_project_id = NULL WHERE singleton = 1 AND active_project_id = ?")
        .run(projectId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  restoreProject(projectId: string): RegisteredProject {
    const row = this.#db.prepare("SELECT id FROM application_projects WHERE id = ? AND removed_at IS NOT NULL")
      .get(projectId);
    if (!row) throw registryError("REMOVED_PROJECT_NOT_FOUND");
    this.#db.prepare("UPDATE application_projects SET removed_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), projectId);
    return this.getProject(projectId);
  }

  removeSafeE2eRegistrations(tempRootInput = os.tmpdir()): number {
    const tempRoot = path.resolve(tempRootInput);
    const rows = this.#db.prepare(`
      SELECT id, root_path FROM application_projects WHERE removed_at IS NULL
    `).all() as Record<string, SQLOutputValue>[];
    const projectIds = rows
      .filter((row) => isSafeE2eProjectPath(readString(row, "root_path"), tempRoot))
      .map((row) => readString(row, "id"));
    if (projectIds.length === 0) return 0;
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.#db.prepare(`
        UPDATE application_projects SET removed_at = ?, updated_at = ? WHERE id = ?
      `);
      for (const projectId of projectIds) remove.run(now, now, projectId);
      this.#db.prepare(`
        UPDATE application_state SET active_project_id = NULL
        WHERE singleton = 1 AND active_project_id IN (
          SELECT id FROM application_projects WHERE removed_at IS NOT NULL
        )
      `).run();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return projectIds.length;
  }

  createSession(projectId: string, title = "新会话"): SessionSummary {
    this.getProject(projectId);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO agent_sessions (id, project_id, title, state, archived, created_at, updated_at)
      VALUES (?, ?, ?, 'idle', 0, ?, ?)
    `).run(id, projectId, normalizeTitle(title), now, now);
    return this.getSession(id);
  }

  ensureDefaultSession(projectId: string, title = "大管家"): SessionSummary {
    const existing = this.listSessions(projectId);
    return existing[0] ?? this.createSession(projectId, title);
  }

  getSession(sessionId: string): SessionSummary {
    const row = this.#db.prepare(`
      SELECT s.id, s.project_id, s.title, s.state, s.archived, s.updated_at,
        (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id) AS message_count
      FROM agent_sessions s WHERE s.id = ?
    `).get(sessionId);
    if (!row) throw registryError("SESSION_NOT_FOUND");
    return mapSessionSummary(row);
  }

  listSessions(projectId: string, includeArchived = false): SessionSummary[] {
    this.getProject(projectId);
    const rows = this.#db.prepare(`
      SELECT s.id, s.project_id, s.title, s.state, s.archived, s.updated_at,
        (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id) AS message_count
      FROM agent_sessions s
      WHERE s.project_id = ? AND (? = 1 OR s.archived = 0)
      ORDER BY s.updated_at DESC, s.rowid DESC
    `).all(projectId, includeArchived ? 1 : 0);
    return rows.map(mapSessionSummary);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    this.getSession(sessionId);
    this.#db.prepare("UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(normalizeTitle(title), new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  archiveSession(sessionId: string, archived: boolean): SessionSummary {
    this.getSession(sessionId);
    this.#db.prepare("UPDATE agent_sessions SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  setSessionState(sessionId: string, state: SessionSummary["state"]): SessionSummary {
    this.getSession(sessionId);
    this.#db.prepare("UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  appendMessage(input: AppendMessageInput): SessionMessage {
    this.getSession(input.sessionId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO agent_messages (id, session_id, role, text, outcome, artifacts_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.sessionId, input.role, input.text, input.outcome, JSON.stringify(input.artifacts ?? []), now);
      this.#db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return {
      id,
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      outcome: input.outcome,
      artifacts: input.artifacts ?? [],
      createdAt: now,
    };
  }

  listMessages(sessionId: string): SessionMessage[] {
    this.getSession(sessionId);
    const rows = this.#db.prepare(`
      SELECT id, session_id, role, text, outcome, artifacts_json, created_at
      FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId);
    return rows.map(mapSessionMessage);
  }

  clearSessionMessages(sessionId: string): SessionSummary {
    this.getSession(sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM agent_messages WHERE session_id = ?").run(sessionId);
      this.#db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), sessionId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.getSession(sessionId);
  }

  deleteSession(sessionId: string): string {
    this.getSession(sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE shared_memories SET source_session_id = NULL WHERE source_session_id = ?")
        .run(sessionId);
      this.#db.prepare("DELETE FROM agent_handoffs WHERE sender_session_id = ? OR recipient_session_id = ?")
        .run(sessionId, sessionId);
      this.#db.prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return sessionId;
  }

  listRecentConversation(
    sessionId: string,
    limits: { maxMessages?: number; maxUtf8Bytes?: number } = {},
  ): AgentSessionHistory {
    this.getSession(sessionId);
    const maxMessages = Math.min(Math.max(limits.maxMessages ?? 16, 1), 24);
    const maxUtf8Bytes = Math.min(Math.max(limits.maxUtf8Bytes ?? 24_000, 1), 96_000);
    const total = this.#db.prepare(`
      SELECT COUNT(*) AS count FROM agent_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
    `).get(sessionId) as Record<string, SQLOutputValue>;
    const rows = this.#db.prepare(`
      SELECT role, text, created_at
      FROM agent_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY sequence DESC
      LIMIT ?
    `).all(sessionId, maxMessages) as Record<string, SQLOutputValue>[];
    const selected: AgentSessionHistory["entries"] = [];
    let usedBytes = 0;
    for (const row of rows) {
      const text = readString(row, "text");
      const bytes = Buffer.byteLength(text, "utf8");
      if (usedBytes + bytes > maxUtf8Bytes) break;
      const role = readString(row, "role");
      if (role !== "user" && role !== "assistant") throw registryError("MESSAGE_ROLE_INVALID");
      selected.push({ role, text, createdAt: readString(row, "created_at") });
      usedBytes += bytes;
    }
    selected.reverse();
    const totalMessages = readNumber(total, "count");
    const omittedMessages = totalMessages - selected.length;
    return {
      entries: selected,
      completeness: { incomplete: omittedMessages > 0, omittedMessages },
    };
  }

  publishSharedMemory(input: {
    projectId: string;
    sourceSessionId: string | null;
    title: string;
    content: string;
    scopeResourceIds: string[];
    checkpointId: string;
  }): SharedMemoryRecord {
    this.getProject(input.projectId);
    if (input.sourceSessionId && this.getSession(input.sourceSessionId).projectId !== input.projectId) {
      throw registryError("MEMORY_SESSION_PROJECT_MISMATCH");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO shared_memories (
        id, project_id, source_session_id, title, content, scope_resource_ids_json,
        checkpoint_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      id,
      input.projectId,
      input.sourceSessionId,
      normalizeTitle(input.title),
      normalizeLongText(input.content, 4_000, "MEMORY_CONTENT_INVALID"),
      JSON.stringify(normalizeScopeIds(input.scopeResourceIds)),
      normalizeOpaque(input.checkpointId, "MEMORY_CHECKPOINT_INVALID"),
      now,
    );
    return this.getSharedMemory(id);
  }

  listSharedMemories(projectId: string): SharedMemoryRecord[] {
    this.getProject(projectId);
    return this.#db.prepare(`
      SELECT * FROM shared_memories
      WHERE project_id = ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC
    `).all(projectId).map(mapSharedMemory);
  }

  getSharedMemory(memoryId: string): SharedMemoryRecord {
    const row = this.#db.prepare("SELECT * FROM shared_memories WHERE id = ?").get(memoryId);
    if (!row) throw registryError("MEMORY_NOT_FOUND");
    return mapSharedMemory(row);
  }

  createHandoff(input: {
    projectId: string;
    senderSessionId: string;
    recipientSessionId: string;
    title: string;
    instructions: string;
    scopeResourceIds: string[];
    checkpointId: string;
  }): HandoffRecord {
    this.getProject(input.projectId);
    const sender = this.getSession(input.senderSessionId);
    const recipient = this.getSession(input.recipientSessionId);
    if (sender.projectId !== input.projectId || recipient.projectId !== input.projectId) {
      throw registryError("HANDOFF_SESSION_PROJECT_MISMATCH");
    }
    if (sender.id === recipient.id) throw registryError("HANDOFF_RECIPIENT_INVALID");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO agent_handoffs (
        id, project_id, sender_session_id, recipient_session_id, title, instructions,
        scope_resource_ids_json, checkpoint_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      input.projectId,
      input.senderSessionId,
      input.recipientSessionId,
      normalizeTitle(input.title),
      normalizeLongText(input.instructions, 8_000, "HANDOFF_INSTRUCTIONS_INVALID"),
      JSON.stringify(normalizeScopeIds(input.scopeResourceIds)),
      normalizeOpaque(input.checkpointId, "HANDOFF_CHECKPOINT_INVALID"),
      now,
      now,
    );
    return this.getHandoff(id);
  }

  getHandoff(handoffId: string): HandoffRecord {
    const row = this.#db.prepare("SELECT * FROM agent_handoffs WHERE id = ?").get(handoffId);
    if (!row) throw registryError("HANDOFF_NOT_FOUND");
    return mapHandoff(row);
  }

  listSessionHandoffs(sessionId: string): HandoffRecord[] {
    this.getSession(sessionId);
    return this.#db.prepare(`
      SELECT * FROM agent_handoffs
      WHERE (sender_session_id = ? OR recipient_session_id = ?)
        AND status <> 'cancelled'
      ORDER BY updated_at DESC, rowid DESC
    `).all(sessionId, sessionId).map(mapHandoff);
  }

  updateHandoffStatus(
    handoffId: string,
    actorSessionId: string,
    status: HandoffRecord["status"],
  ): HandoffRecord {
    const handoff = this.getHandoff(handoffId);
    const actor = this.getSession(actorSessionId);
    if (actor.projectId !== handoff.projectId) throw registryError("HANDOFF_SESSION_PROJECT_MISMATCH");
    const recipientTransition = actorSessionId === handoff.recipientSessionId
      && ["accepted", "completed"].includes(status);
    const senderTransition = actorSessionId === handoff.senderSessionId && status === "cancelled";
    if (!recipientTransition && !senderTransition) throw registryError("HANDOFF_TRANSITION_FORBIDDEN");
    this.#db.prepare("UPDATE agent_handoffs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), handoffId);
    return this.getHandoff(handoffId);
  }

  getCollaborationContext(projectId: string, sessionId: string): AgentCollaborationContext {
    const session = this.getSession(sessionId);
    if (session.projectId !== projectId) throw registryError("AGENT_SESSION_PROJECT_MISMATCH");
    const sharedMemories = this.#db.prepare(`
      SELECT m.*, s.title AS source_session_title
      FROM shared_memories m
      LEFT JOIN agent_sessions s ON s.id = m.source_session_id
      WHERE m.project_id = ? AND m.status = 'active'
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 100
    `).all(projectId).map((row) => {
      const memory = mapSharedMemory(row);
      return {
        title: memory.title,
        content: memory.content,
        scopeResourceIds: memory.scopeResourceIds,
        checkpointId: memory.checkpointId,
        sourceSessionTitle: row.source_session_title === null ? null : readString(row, "source_session_title"),
        createdAt: memory.createdAt,
      };
    });
    const handoffs = this.#db.prepare(`
      SELECT h.*, s.title AS sender_session_title
      FROM agent_handoffs h
      JOIN agent_sessions s ON s.id = h.sender_session_id
      WHERE h.project_id = ? AND h.recipient_session_id = ? AND h.status IN ('pending', 'accepted')
      ORDER BY h.created_at ASC, h.rowid ASC LIMIT 100
    `).all(projectId, sessionId).map((row) => {
      const handoff = mapHandoff(row);
      return {
        title: handoff.title,
        instructions: handoff.instructions,
        scopeResourceIds: handoff.scopeResourceIds,
        checkpointId: handoff.checkpointId,
        senderSessionTitle: readString(row, "sender_session_title"),
        status: handoff.status as "pending" | "accepted",
        createdAt: handoff.createdAt,
      };
    });
    return { sharedMemories, handoffs };
  }

  replaceSourceInventory(projectId: string, sources: SourceMaterialEntry[]): void {
    this.getProject(projectId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM source_inventory WHERE project_id = ?").run(projectId);
      const insert = this.#db.prepare(`
        INSERT INTO source_inventory (
          project_id, relative_path, kind, size, modified_at, sha256, storage_mode
        ) VALUES (?, ?, ?, ?, ?, ?, 'original_reference')
      `);
      for (const source of sources) {
        insert.run(
          projectId,
          source.relativePath,
          source.kind,
          source.size,
          source.modifiedAt,
          source.sha256,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getSourceInventorySummary(projectId: string): { fileCount: number; managedCopyCount: number } {
    this.getProject(projectId);
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS file_count,
        SUM(CASE WHEN storage_mode = 'managed_copy' THEN 1 ELSE 0 END) AS managed_copy_count
      FROM source_inventory WHERE project_id = ?
    `).get(projectId) as Record<string, SQLOutputValue>;
    return {
      fileCount: readNumber(row, "file_count"),
      managedCopyCount: readNumber(row, "managed_copy_count"),
    };
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS application_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS application_projects (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        normalized_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('uninitialized', 'materials_detected', 'ready', 'missing')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS application_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_project_id TEXT REFERENCES application_projects(id)
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES application_projects(id),
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('idle', 'working', 'review', 'blocked')),
        archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_project_idx ON agent_sessions(project_id, archived, updated_at);
      CREATE TABLE IF NOT EXISTS agent_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'error')),
        text TEXT NOT NULL,
        outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'review')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_messages_session_idx ON agent_messages(session_id, sequence);
      CREATE TABLE IF NOT EXISTS source_inventory (
        project_id TEXT NOT NULL REFERENCES application_projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'document', 'image', 'audio', 'video', 'data')),
        size INTEGER NOT NULL CHECK (size >= 0),
        modified_at TEXT NOT NULL,
        sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
        storage_mode TEXT NOT NULL CHECK (storage_mode IN ('original_reference', 'managed_copy')),
        PRIMARY KEY (project_id, relative_path)
      );
      INSERT OR IGNORE INTO application_meta (singleton, version) VALUES (1, 1);
      INSERT OR IGNORE INTO application_state (singleton, active_project_id) VALUES (1, NULL);
    `);
    const version = this.#db.prepare("SELECT version FROM application_meta WHERE singleton = 1").get() as { version: number };
    if (version.version === 1) this.#migrateCollaborationSchema();
    const current = this.#db.prepare("SELECT version FROM application_meta WHERE singleton = 1").get() as { version: number };
    if (current.version === 2) this.#migrateMessageArtifactsSchema();
    const latest = this.#db.prepare("SELECT version FROM application_meta WHERE singleton = 1").get() as { version: number };
    if (latest.version !== 3) throw registryError("APPLICATION_SCHEMA_UNSUPPORTED");
  }

  #migrateCollaborationSchema(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        CREATE TABLE shared_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES application_projects(id) ON DELETE CASCADE,
          source_session_id TEXT REFERENCES agent_sessions(id),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          scope_resource_ids_json TEXT NOT NULL CHECK (json_valid(scope_resource_ids_json)),
          checkpoint_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX shared_memories_project_idx ON shared_memories(project_id, status, created_at);
        CREATE TABLE agent_handoffs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES application_projects(id) ON DELETE CASCADE,
          sender_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
          recipient_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
          title TEXT NOT NULL,
          instructions TEXT NOT NULL,
          scope_resource_ids_json TEXT NOT NULL CHECK (json_valid(scope_resource_ids_json)),
          checkpoint_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (sender_session_id <> recipient_session_id)
        );
        CREATE INDEX agent_handoffs_recipient_idx ON agent_handoffs(recipient_session_id, status, updated_at);
        UPDATE application_meta SET version = 2 WHERE singleton = 1;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateMessageArtifactsSchema(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        ALTER TABLE agent_messages
        ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts_json));
        UPDATE application_meta SET version = 3 WHERE singleton = 1;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function normalizeProjectPath(rootPath: string): string {
  const withoutTrailingSeparator = rootPath.length > path.parse(rootPath).root.length
    ? rootPath.replace(/[\\/]+$/, "")
    : rootPath;
  return process.platform === "win32" ? withoutTrailingSeparator.toLocaleLowerCase("en-US") : withoutTrailingSeparator;
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized || normalized.length > 240) throw registryError("SESSION_TITLE_INVALID");
  return normalized;
}

function normalizeLongText(value: string, maxLength: number, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw registryError(code);
  return normalized;
}

function normalizeOpaque(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) throw registryError(code);
  return normalized;
}

function normalizeScopeIds(values: string[]): string[] {
  const normalized = values.map((value) => normalizeOpaque(value, "COLLABORATION_SCOPE_INVALID"));
  if (normalized.length > 100 || new Set(normalized).size !== normalized.length) {
    throw registryError("COLLABORATION_SCOPE_INVALID");
  }
  return normalized;
}

function mapRegisteredProject(row: Record<string, SQLOutputValue>): RegisteredProject {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    rootPath: readString(row, "root_path"),
    state: readProjectState(row.state),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapProjectSummary(row: Record<string, SQLOutputValue>, activeProjectId: string | null): ProjectSummary {
  const id = readString(row, "id");
  return {
    id,
    name: readString(row, "name"),
    state: readProjectState(row.state),
    sessionCount: readNumber(row, "session_count"),
    updatedAt: readString(row, "updated_at"),
    active: id === activeProjectId,
  };
}

function mapSessionSummary(row: Record<string, SQLOutputValue>): SessionSummary {
  const state = readString(row, "state");
  if (!["idle", "working", "review", "blocked"].includes(state)) throw registryError("SESSION_STATE_INVALID");
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    title: readString(row, "title"),
    state: state as SessionSummary["state"],
    archived: readNumber(row, "archived") === 1,
    messageCount: readNumber(row, "message_count"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapSessionMessage(row: Record<string, SQLOutputValue>): SessionMessage {
  const role = readString(row, "role");
  if (!["user", "assistant", "error"].includes(role)) throw registryError("MESSAGE_ROLE_INVALID");
  const outcome = row.outcome;
  if (outcome !== null && !["completed", "blocked", "review"].includes(String(outcome))) {
    throw registryError("MESSAGE_OUTCOME_INVALID");
  }
  return {
    id: readString(row, "id"),
    sessionId: readString(row, "session_id"),
    role: role as SessionMessage["role"],
    text: readString(row, "text"),
    outcome: outcome === null ? null : outcome as SessionMessage["outcome"],
    artifacts: readMessageArtifacts(row.artifacts_json),
    createdAt: readString(row, "created_at"),
  };
}

function readMessageArtifacts(value: SQLOutputValue): SessionMessage["artifacts"] {
  if (typeof value !== "string") throw registryError("MESSAGE_ARTIFACTS_INVALID");
  return agentArtifactSchema.array().max(100).parse(JSON.parse(value) as unknown);
}

function mapSharedMemory(row: Record<string, SQLOutputValue>): SharedMemoryRecord {
  const status = readString(row, "status");
  if (status !== "active" && status !== "superseded") throw registryError("MEMORY_STATUS_INVALID");
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    sourceSessionId: row.source_session_id === null ? null : readString(row, "source_session_id"),
    title: readString(row, "title"),
    content: readString(row, "content"),
    scopeResourceIds: readScopeIds(row.scope_resource_ids_json),
    checkpointId: readString(row, "checkpoint_id"),
    status,
    createdAt: readString(row, "created_at"),
  };
}

function mapHandoff(row: Record<string, SQLOutputValue>): HandoffRecord {
  const status = readString(row, "status");
  if (!["pending", "accepted", "completed", "cancelled"].includes(status)) {
    throw registryError("HANDOFF_STATUS_INVALID");
  }
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    senderSessionId: readString(row, "sender_session_id"),
    recipientSessionId: readString(row, "recipient_session_id"),
    title: readString(row, "title"),
    instructions: readString(row, "instructions"),
    scopeResourceIds: readScopeIds(row.scope_resource_ids_json),
    checkpointId: readString(row, "checkpoint_id"),
    status: status as HandoffRecord["status"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function readScopeIds(value: SQLOutputValue): string[] {
  if (typeof value !== "string") throw registryError("COLLABORATION_SCOPE_INVALID");
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw registryError("COLLABORATION_SCOPE_INVALID");
    }
    return normalizeScopeIds(parsed);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw registryError("COLLABORATION_SCOPE_INVALID");
  }
}

function readProjectState(value: SQLOutputValue): ProjectState {
  if (typeof value !== "string" || !["uninitialized", "materials_detected", "ready", "missing"].includes(value)) {
    throw registryError("PROJECT_STATE_INVALID");
  }
  return value as ProjectState;
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw registryError("APPLICATION_DATA_INVALID");
  return value;
}

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw registryError("APPLICATION_DATA_INVALID");
  return value;
}

function registryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function isSafeE2eProjectPath(projectPathInput: string, tempRoot: string): boolean {
  const projectPath = path.resolve(projectPathInput);
  const relative = path.relative(tempRoot, projectPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return false;
  }
  return path.basename(projectPath).toLocaleLowerCase("en-US").startsWith("novax-e2e-");
}
