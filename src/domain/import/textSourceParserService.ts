import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { ImportJobRepository } from "./importJobRepository";
import { SourceLibraryRepository } from "./sourceLibraryRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface SourceChunkRecord {
  id: string;
  sourceId: string;
  ordinal: number;
  locator: { kind: "lines"; start: number; end: number; section: string | null };
  content: string;
  contentSha256: string;
}

export class TextSourceParserService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  parse(sourceId: string): SourceChunkRecord[] {
    const sources = new SourceLibraryRepository(this.workspace);
    const source = sources.assertCurrentFile(sourceId);
    if (source.format !== "txt" && source.format !== "markdown") throw parserError("SOURCE_PARSER_NOT_AVAILABLE");
    const existing = this.listChunks(sourceId);
    if (source.state === "parsed" && existing.length) return existing;
    const jobs = new ImportJobRepository(this.workspace);
    const job = jobs.start(sourceId, "parse");
    try {
      const text = decodeText(fs.readFileSync(source.originalPath));
      const chunks = chunkLines(text, source.format === "markdown");
      const insert = this.workspace.db.prepare(`
        INSERT INTO source_chunks (id, source_id, ordinal, locator_json, content, content_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.workspace.db.exec("BEGIN IMMEDIATE");
      try {
        chunks.forEach((chunk, ordinal) => insert.run(randomUUID(), sourceId, ordinal, JSON.stringify(chunk.locator), chunk.content, sha256(chunk.content), new Date().toISOString()));
        sources.setState(sourceId, "parsed");
        this.workspace.db.exec("COMMIT");
      } catch (error) {
        this.workspace.db.exec("ROLLBACK");
        throw error;
      }
      jobs.succeed(job.id);
      return this.listChunks(sourceId);
    } catch (error) {
      sources.setState(sourceId, "failed");
      jobs.fail(job.id, publicParserError(error));
      throw error;
    }
  }

  listChunks(sourceId: string): SourceChunkRecord[] {
    return this.workspace.db.prepare(`
      SELECT * FROM source_chunks WHERE source_id = ? ORDER BY ordinal
    `).all(sourceId).map((row) => {
      const value = row as { id: string; source_id: string; ordinal: number; locator_json: string; content: string; content_sha256: string };
      return { id: value.id, sourceId: value.source_id, ordinal: value.ordinal, locator: JSON.parse(value.locator_json), content: value.content, contentSha256: value.content_sha256 };
    });
  }
}

function decodeText(buffer: Buffer): string {
  for (const encoding of ["utf-8", "gb18030"] as const) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^\uFEFF/, ""); } catch { /* try next */ }
  }
  throw parserError("SOURCE_TEXT_ENCODING_UNSUPPORTED");
}

function chunkLines(text: string, markdown: boolean) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chunks: Array<{ locator: SourceChunkRecord["locator"]; content: string }> = [];
  let start = 0;
  let section: string | null = null;
  let content: string[] = [];
  const flush = (endExclusive: number) => {
    const value = content.join("\n").trim();
    if (value) chunks.push({ locator: { kind: "lines", start: start + 1, end: endExclusive, section }, content: value });
    content = [];
    start = endExclusive;
  };
  lines.forEach((line, index) => {
    const heading = markdown ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (heading && content.length) flush(index);
    if (heading) section = heading[2]!.trim();
    if (content.length === 0) start = index;
    content.push(line);
    if (content.join("\n").length >= 8_000) flush(index + 1);
  });
  if (content.length) flush(lines.length);
  return chunks;
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function publicParserError(error: unknown): string { return error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 120) : "SOURCE_PARSE_FAILED"; }
function parserError(code: string): Error & { code: string } { return Object.assign(new Error("Source text parsing failed."), { code }); }
