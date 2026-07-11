import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface AgentTaskNote {
  id: string;
  runId: string;
  title: string;
  content: string;
  source: {
    path: string;
    sha256: string;
    startChar: number;
    endChar: number;
  };
  createdAt: string;
  updatedAt: string;
}

export class AgentTaskNoteRepository {
  constructor(private readonly workspace: WorkspaceDatabase) {}

  save(input: Omit<AgentTaskNote, "id" | "createdAt" | "updatedAt">): AgentTaskNote {
    const existing = this.workspace.db.prepare(`
      SELECT id, created_at FROM agent_task_notes
      WHERE run_id = ? AND source_path = ? AND source_sha256 = ? AND start_char = ? AND end_char = ?
    `).get(input.runId, input.source.path, input.source.sha256, input.source.startChar, input.source.endChar) as {
      id: string;
      created_at: string;
    } | undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    if (existing) {
      this.workspace.db.prepare(`
        UPDATE agent_task_notes SET title = ?, content = ?, updated_at = ? WHERE id = ?
      `).run(input.title, input.content, now, id);
    } else {
      this.workspace.db.prepare(`
        INSERT INTO agent_task_notes (
          id, run_id, title, content, source_path, source_sha256, start_char, end_char, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.runId, input.title, input.content, input.source.path, input.source.sha256,
        input.source.startChar, input.source.endChar, now, now,
      );
    }
    return this.get(id);
  }

  list(runId: string): AgentTaskNote[] {
    const rows = this.workspace.db.prepare(`
      SELECT * FROM agent_task_notes WHERE run_id = ? ORDER BY source_path, start_char, id
    `).all(runId) as unknown as TaskNoteRow[];
    return rows.map(mapRow);
  }

  private get(id: string): AgentTaskNote {
    const row = this.workspace.db.prepare("SELECT * FROM agent_task_notes WHERE id = ?").get(id) as TaskNoteRow | undefined;
    if (!row) throw new Error("AGENT_TASK_NOTE_NOT_FOUND");
    return mapRow(row);
  }
}

interface TaskNoteRow {
  id: string;
  run_id: string;
  title: string;
  content: string;
  source_path: string;
  source_sha256: string;
  start_char: number;
  end_char: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: TaskNoteRow): AgentTaskNote {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    content: row.content,
    source: {
      path: row.source_path,
      sha256: row.source_sha256,
      startChar: row.start_char,
      endChar: row.end_char,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
