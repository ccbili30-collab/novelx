import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceDatabase } from "./workspaceRepository";

const RESTRICTED_SEGMENTS = new Set([".git", ".novax", "node_modules"]);

interface FileState {
  exists: boolean;
  content: Buffer | null;
  sha256: string | null;
}

export interface ProjectFileMutationReceipt {
  versionId: string;
  path: string;
  state: "active" | "deleted";
  sha256: string;
  rollback(): void;
}

export class ProjectFileVersionService {
  readonly #rootPath: string;
  readonly #rootRealPath: string;
  readonly #snapshotRoot: string;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#rootPath = path.resolve(workspace.rootPath);
    this.#rootRealPath = fs.realpathSync.native(this.#rootPath);
    this.#snapshotRoot = path.join(this.#rootPath, ".novax", "file-snapshots");
  }

  put(input: { checkpointId: string; relativePath: string; content: string; expectedSha256: string | null }): ProjectFileMutationReceipt {
    const target = this.resolveWritable(input.relativePath);
    const before = this.readState(target);
    this.assertExpected(before, input.expectedSha256);
    const content = Buffer.from(input.content, "utf8");
    const contentSha = sha256(content);
    this.recordBaseVersion(input.checkpointId, input.relativePath, before);
    this.writeSnapshot(contentSha, content);
    this.writeAtomic(target, content);
    const versionId = this.insertVersion(input.checkpointId, input.relativePath, "active", contentSha, content.byteLength);
    return {
      versionId,
      path: normalizeRelativePath(input.relativePath).replaceAll("\\", "/"),
      state: "active",
      sha256: contentSha,
      rollback: () => this.restoreState(target, before),
    };
  }

  delete(input: { checkpointId: string; relativePath: string; expectedSha256: string }): ProjectFileMutationReceipt {
    const target = this.resolveWritable(input.relativePath);
    const before = this.readState(target);
    if (!before.exists) throw versionError("PROJECT_FILE_NOT_A_FILE");
    this.assertExpected(before, input.expectedSha256);
    this.recordBaseVersion(input.checkpointId, input.relativePath, before);
    fs.unlinkSync(target);
    const versionId = this.insertVersion(input.checkpointId, input.relativePath, "deleted", null, 0);
    return {
      versionId,
      path: normalizeRelativePath(input.relativePath).replaceAll("\\", "/"),
      state: "deleted",
      sha256: before.sha256!,
      rollback: () => this.restoreState(target, before),
    };
  }

  restoreToCheckpoint(checkpointId: string): () => void {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT checkpoint.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints checkpoint JOIN ancestry ON checkpoint.id = ancestry.checkpoint_id
        WHERE checkpoint.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT version.relative_path, version.state, version.content_sha256,
          ROW_NUMBER() OVER (PARTITION BY version.relative_path ORDER BY ancestry.depth ASC) AS rank
        FROM project_file_versions version
        JOIN ancestry ON ancestry.checkpoint_id = version.checkpoint_id
      )
      SELECT relative_path, state, content_sha256 FROM ranked WHERE rank = 1
    `).all(checkpointId) as Array<{ relative_path: string; state: "active" | "deleted"; content_sha256: string | null }>;
    const tracked = this.workspace.db.prepare("SELECT DISTINCT relative_path FROM project_file_versions").all() as unknown as Array<{ relative_path: string }>;
    const desired = new Map(rows.map((row) => [row.relative_path, row]));
    const before = new Map<string, FileState>();
    try {
      for (const { relative_path: relativePath } of tracked) {
        const target = this.resolveWritable(relativePath);
        before.set(relativePath, this.readState(target));
        const row = desired.get(relativePath);
        if (!row || row.state === "deleted") {
          if (fs.existsSync(target)) fs.unlinkSync(target);
          continue;
        }
        if (!row.content_sha256) throw versionError("PROJECT_FILE_VERSION_INVALID");
        const snapshot = fs.readFileSync(path.join(this.#snapshotRoot, row.content_sha256));
        if (sha256(snapshot) !== row.content_sha256) throw versionError("PROJECT_FILE_SNAPSHOT_CORRUPT");
        this.writeAtomic(target, snapshot);
      }
    } catch (error) {
      for (const [relativePath, state] of before) this.restoreState(this.resolveWritable(relativePath), state);
      throw error;
    }
    return () => {
      for (const [relativePath, state] of before) this.restoreState(this.resolveWritable(relativePath), state);
    };
  }

  private recordBaseVersion(checkpointId: string, relativePathInput: string, state: FileState): void {
    const checkpoint = this.workspace.db.prepare("SELECT parent_checkpoint_id FROM checkpoints WHERE id = ?").get(checkpointId) as unknown as { parent_checkpoint_id: string | null } | undefined;
    if (!checkpoint?.parent_checkpoint_id) throw versionError("CHECKPOINT_NOT_FOUND");
    const relativePath = normalizeRelativePath(relativePathInput).replaceAll("\\", "/");
    const existing = this.workspace.db.prepare("SELECT 1 FROM project_file_versions WHERE relative_path = ? LIMIT 1").get(relativePath);
    if (existing) return;
    if (state.exists && state.content && state.sha256) this.writeSnapshot(state.sha256, state.content);
    this.insertVersion(
      checkpoint.parent_checkpoint_id,
      relativePath,
      state.exists ? "active" : "deleted",
      state.sha256,
      state.content?.byteLength ?? 0,
    );
  }

  private insertVersion(checkpointId: string, relativePathInput: string, state: "active" | "deleted", contentSha: string | null, size: number): string {
    const relativePath = normalizeRelativePath(relativePathInput).replaceAll("\\", "/");
    const id = randomUUID();
    this.workspace.db.prepare(`
      INSERT INTO project_file_versions (id, checkpoint_id, relative_path, state, content_sha256, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, checkpointId, relativePath, state, contentSha, size, new Date().toISOString());
    return id;
  }

  private resolveWritable(relativePathInput: string): string {
    const normalized = normalizeRelativePath(relativePathInput);
    const candidate = path.resolve(this.#rootPath, normalized);
    assertInside(this.#rootPath, candidate);
    const parent = path.dirname(candidate);
    fs.mkdirSync(parent, { recursive: true });
    const realParent = fs.realpathSync.native(parent);
    assertInside(this.#rootRealPath, realParent);
    if (fs.existsSync(candidate)) {
      const real = fs.realpathSync.native(candidate);
      assertInside(this.#rootRealPath, real);
      if (!fs.statSync(real).isFile()) throw versionError("PROJECT_FILE_NOT_A_FILE");
      return real;
    }
    return candidate;
  }

  private readState(target: string): FileState {
    if (!fs.existsSync(target)) return { exists: false, content: null, sha256: null };
    const content = fs.readFileSync(target);
    return { exists: true, content, sha256: sha256(content) };
  }

  private assertExpected(state: FileState, expectedSha256: string | null): void {
    if (expectedSha256 === null) {
      if (state.exists) throw versionError("PROJECT_FILE_ALREADY_EXISTS");
      return;
    }
    if (!state.exists || state.sha256 !== expectedSha256) throw versionError("PROJECT_FILE_CHANGED");
  }

  private writeSnapshot(contentSha: string, content: Buffer): void {
    fs.mkdirSync(this.#snapshotRoot, { recursive: true });
    const target = path.join(this.#snapshotRoot, contentSha);
    if (!fs.existsSync(target)) this.writeAtomic(target, content);
  }

  private writeAtomic(target: string, content: Buffer): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.novax-${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { flag: "wx" });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }

  private restoreState(target: string, state: FileState): void {
    if (!state.exists || !state.content) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return;
    }
    this.writeAtomic(target, state.content);
  }
}

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "." || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw versionError("PROJECT_FILE_PATH_OUTSIDE_ROOT");
  }
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || RESTRICTED_SEGMENTS.has(segment))) {
    throw versionError("PROJECT_FILE_PATH_RESTRICTED");
  }
  return segments.join(path.sep);
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw versionError("PROJECT_FILE_PATH_OUTSIDE_ROOT");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function versionError(code: string): Error & { code: string } {
  return Object.assign(new Error("Project file version operation failed."), { code });
}
