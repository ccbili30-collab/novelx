import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export type SourceFormat = "txt" | "markdown" | "docx" | "epub" | "image";
export type RightsAttestation = "user_owned" | "licensed" | "public_domain" | "unknown";

export interface SourceLibraryEntry {
  id: string;
  originalPath: string;
  displayName: string;
  format: SourceFormat;
  contentSha256: string;
  byteSize: number;
  rightsAttestation: RightsAttestation;
  state: "registered" | "parsed" | "failed" | "missing";
  createdAt: string;
}

export class SourceLibraryRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  register(input: { filePath: string; rightsAttestation: RightsAttestation }): SourceLibraryEntry {
    const originalPath = path.resolve(input.filePath);
    const stat = fs.statSync(originalPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw sourceError("SOURCE_FILE_NOT_FOUND");
    const format = detectFormat(originalPath);
    const contentSha256 = hashFile(originalPath);
    const existing = this.workspace.db.prepare(`
      SELECT * FROM source_library_entries WHERE original_path = ? AND content_sha256 = ?
    `).get(originalPath, contentSha256);
    if (existing) return mapEntry(existing);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO source_library_entries (
        id, original_path, display_name, format, content_sha256, byte_size,
        rights_attestation, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?)
    `).run(id, originalPath, path.basename(originalPath), format, contentSha256, stat.size, input.rightsAttestation, createdAt);
    return this.getRequired(id);
  }

  getRequired(id: string): SourceLibraryEntry {
    const row = this.workspace.db.prepare("SELECT * FROM source_library_entries WHERE id = ?").get(id);
    if (!row) throw sourceError("SOURCE_ENTRY_NOT_FOUND");
    return mapEntry(row);
  }

  assertCanDecompose(id: string): SourceLibraryEntry {
    const entry = this.assertCurrentFile(id);
    if (entry.rightsAttestation === "unknown") throw sourceError("SOURCE_RIGHTS_ATTESTATION_REQUIRED");
    return entry;
  }

  assertCurrentFile(id: string): SourceLibraryEntry {
    const entry = this.getRequired(id);
    if (!fs.existsSync(entry.originalPath)) throw sourceError("SOURCE_FILE_MISSING");
    if (hashFile(entry.originalPath) !== entry.contentSha256) throw sourceError("SOURCE_FILE_CHANGED");
    return entry;
  }

  setState(id: string, state: SourceLibraryEntry["state"]): void {
    const result = this.workspace.db.prepare("UPDATE source_library_entries SET state = ? WHERE id = ?").run(state, id);
    if (result.changes !== 1) throw sourceError("SOURCE_ENTRY_NOT_FOUND");
  }
}

function detectFormat(filePath: string): SourceFormat {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".txt") return "txt";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".docx") return "docx";
  if (extension === ".epub") return "epub";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return "image";
  throw sourceError("SOURCE_FORMAT_UNSUPPORTED");
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function mapEntry(row: Record<string, SQLOutputValue>): SourceLibraryEntry {
  return {
    id: String(row.id), originalPath: String(row.original_path), displayName: String(row.display_name), format: String(row.format) as SourceFormat,
    contentSha256: String(row.content_sha256), byteSize: Number(row.byte_size), rightsAttestation: String(row.rights_attestation) as RightsAttestation,
    state: String(row.state) as SourceLibraryEntry["state"], createdAt: String(row.created_at),
  };
}

function sourceError(code: string): Error & { code: string } {
  return Object.assign(new Error("Source Library operation failed."), { code });
}
