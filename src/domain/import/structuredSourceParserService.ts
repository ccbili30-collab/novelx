import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { imageSize } from "image-size";
import { ImportJobRepository } from "./importJobRepository";
import { SourceLibraryRepository } from "./sourceLibraryRepository";
import type { SourceChunkLocator, SourceChunkRecord } from "./textSourceParserService";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

interface ParsedChunk {
  locator: SourceChunkLocator;
  content: string;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: false });

export class StructuredSourceParserService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  parse(sourceId: string): SourceChunkRecord[] {
    const sources = new SourceLibraryRepository(this.workspace);
    const source = sources.assertCurrentFile(sourceId);
    if (source.format !== "docx" && source.format !== "epub" && source.format !== "image") {
      throw parserError("SOURCE_PARSER_NOT_AVAILABLE");
    }
    const existing = listChunks(this.workspace, sourceId);
    if (source.state === "parsed" && existing.length) return existing;
    const jobs = new ImportJobRepository(this.workspace);
    const job = jobs.start(sourceId, "parse");
    try {
      const bytes = fs.readFileSync(source.originalPath);
      const chunks = source.format === "docx" ? parseDocx(bytes)
        : source.format === "epub" ? parseEpub(bytes)
          : parseImage(bytes, source.displayName);
      persistChunks(this.workspace, sourceId, chunks);
      sources.setState(sourceId, "parsed");
      jobs.succeed(job.id);
      return listChunks(this.workspace, sourceId);
    } catch (error) {
      sources.setState(sourceId, "failed");
      jobs.fail(job.id, publicCode(error));
      throw error;
    }
  }
}

function parseDocx(bytes: Buffer): ParsedChunk[] {
  const archive = safeUnzip(bytes);
  const documentXml = archive["word/document.xml"];
  if (!documentXml) throw parserError("DOCX_DOCUMENT_XML_MISSING");
  const document = xml.parse(new TextDecoder("utf-8", { fatal: true }).decode(documentXml)) as Record<string, unknown>;
  const body = nested(document, ["w:document", "w:body"]);
  const paragraphs = asArray((body as Record<string, unknown> | null)?.["w:p"])
    .map((paragraph) => collectText(paragraph).trim())
    .filter(Boolean);
  if (!paragraphs.length) throw parserError("SOURCE_DOCUMENT_EMPTY");
  return chunkParagraphs(paragraphs, (start, end) => ({ kind: "docx_paragraphs", start, end }));
}

function parseEpub(bytes: Buffer): ParsedChunk[] {
  const archive = safeUnzip(bytes);
  const containerBytes = archive["META-INF/container.xml"];
  if (!containerBytes) throw parserError("EPUB_CONTAINER_MISSING");
  const container = xml.parse(decodeXml(containerBytes)) as Record<string, unknown>;
  const rootfiles = asArray(nested(container, ["container", "rootfiles", "rootfile"]));
  const opfPath = attribute(rootfiles[0], "full-path");
  if (!opfPath || !archive[opfPath]) throw parserError("EPUB_PACKAGE_MISSING");
  const packageDoc = xml.parse(decodeXml(archive[opfPath]!)) as Record<string, unknown>;
  const packageRoot = (packageDoc.package ?? packageDoc["opf:package"]) as Record<string, unknown> | undefined;
  if (!packageRoot) throw parserError("EPUB_PACKAGE_INVALID");
  const manifestRoot = (packageRoot.manifest ?? packageRoot["opf:manifest"]) as Record<string, unknown> | undefined;
  const spineRoot = (packageRoot.spine ?? packageRoot["opf:spine"]) as Record<string, unknown> | undefined;
  const items = asArray(manifestRoot?.item ?? manifestRoot?.["opf:item"]);
  const hrefById = new Map(items.flatMap((item) => {
    const id = attribute(item, "id");
    const href = attribute(item, "href");
    return id && href ? [[id, href] as const] : [];
  }));
  const idrefs = asArray(spineRoot?.itemref ?? spineRoot?.["opf:itemref"]).map((item) => attribute(item, "idref")).filter((value): value is string => Boolean(value));
  const opfDir = path.posix.dirname(opfPath.replace(/\\/g, "/"));
  const chunks: ParsedChunk[] = [];
  idrefs.forEach((idref, spineIndex) => {
    const href = hrefById.get(idref);
    if (!href) return;
    const chapterPath = path.posix.normalize(path.posix.join(opfDir, href));
    const chapterBytes = archive[chapterPath];
    if (!chapterBytes) return;
    const chapter = xml.parse(decodeXml(chapterBytes)) as Record<string, unknown>;
    const body = chapter.html && typeof chapter.html === "object" ? (chapter.html as Record<string, unknown>).body : chapter.body;
    const text = collectText(body).replace(/\s+/g, " ").trim();
    if (!text) return;
    for (let offset = 0, part = 0; offset < text.length; offset += 8_000, part += 1) {
      chunks.push({ locator: { kind: "epub_spine", spineIndex, chapterPath, part }, content: text.slice(offset, offset + 8_000) });
    }
  });
  if (!chunks.length) throw parserError("SOURCE_DOCUMENT_EMPTY");
  return chunks;
}

function parseImage(bytes: Buffer, displayName: string): ParsedChunk[] {
  const dimensions = imageSize(bytes);
  if (!dimensions.width || !dimensions.height || !dimensions.type) throw parserError("IMAGE_METADATA_INVALID");
  return [{
    locator: { kind: "image", fileName: displayName, width: dimensions.width, height: dimensions.height, format: dimensions.type },
    content: JSON.stringify({ fileName: displayName, width: dimensions.width, height: dimensions.height, format: dimensions.type }),
  }];
}

function safeUnzip(bytes: Buffer): Record<string, Uint8Array> {
  let archive: Record<string, Uint8Array>;
  try { archive = unzipSync(bytes); } catch { throw parserError("SOURCE_ARCHIVE_INVALID"); }
  const entries = Object.entries(archive);
  if (entries.length > 20_000) throw parserError("SOURCE_ARCHIVE_LIMIT_EXCEEDED");
  const total = entries.reduce((sum, [, value]) => sum + value.byteLength, 0);
  if (total > 100 * 1024 * 1024) throw parserError("SOURCE_ARCHIVE_LIMIT_EXCEEDED");
  return archive;
}

function chunkParagraphs(paragraphs: string[], locator: (start: number, end: number) => SourceChunkLocator): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let start = 0;
  let values: string[] = [];
  const flush = (end: number) => {
    if (values.length) chunks.push({ locator: locator(start + 1, end), content: values.join("\n\n") });
    values = [];
    start = end;
  };
  paragraphs.forEach((paragraph, index) => {
    values.push(paragraph);
    if (values.join("\n\n").length >= 8_000) flush(index + 1);
  });
  flush(paragraphs.length);
  return chunks;
}

function persistChunks(workspace: WorkspaceDatabase, sourceId: string, chunks: ParsedChunk[]): void {
  const insert = workspace.db.prepare(`
    INSERT INTO source_chunks (id, source_id, ordinal, locator_json, content, content_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  workspace.db.exec("BEGIN IMMEDIATE");
  try {
    chunks.forEach((chunk, ordinal) => insert.run(randomUUID(), sourceId, ordinal, JSON.stringify(chunk.locator), chunk.content, sha256(chunk.content), new Date().toISOString()));
    workspace.db.exec("COMMIT");
  } catch (error) {
    workspace.db.exec("ROLLBACK");
    throw error;
  }
}

function listChunks(workspace: WorkspaceDatabase, sourceId: string): SourceChunkRecord[] {
  return workspace.db.prepare("SELECT * FROM source_chunks WHERE source_id = ? ORDER BY ordinal").all(sourceId).map((row) => {
    const value = row as { id: string; source_id: string; ordinal: number; locator_json: string; content: string; content_sha256: string };
    return { id: value.id, sourceId: value.source_id, ordinal: value.ordinal, locator: JSON.parse(value.locator_json) as SourceChunkLocator, content: value.content, contentSha256: value.content_sha256 };
  });
}

function nested(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function collectText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => collectText(child)).filter(Boolean).join(" ");
}

function asArray(value: unknown): unknown[] { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }
function attribute(value: unknown, name: string): string | null { return value && typeof value === "object" && typeof (value as Record<string, unknown>)[`@_${name}`] === "string" ? String((value as Record<string, unknown>)[`@_${name}`]) : null; }
function decodeXml(bytes: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw parserError("SOURCE_TEXT_ENCODING_UNSUPPORTED"); } }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function publicCode(error: unknown): string { return error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 120) : "SOURCE_PARSE_FAILED"; }
function parserError(code: string): Error & { code: string } { return Object.assign(new Error("Structured source parsing failed."), { code }); }
