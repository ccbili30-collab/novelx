import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

const IGNORED_DIRECTORIES = new Set([".git", ".novax", "node_modules"]);
const MAX_LIST_ENTRIES = 2_000;
const MAX_READ_BYTES = 4_000_000;
const MAX_READ_CHARS = 120_000;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_FILE_BYTES = 2_000_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_OVERVIEW_FILES = 40;
const MAX_OVERVIEW_CHARS = 240_000;

export interface ProjectFileEntry {
  path: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: string;
}

export interface ProjectFileListResult {
  root: string;
  entries: ProjectFileEntry[];
  ignoredDirectories: string[];
  incomplete: boolean;
  omittedEntries: number;
}

export interface ProjectFileStatResult extends ProjectFileEntry {
  sha256: string | null;
}

export interface ProjectFileGlobResult {
  pattern: string;
  entries: ProjectFileEntry[];
  incomplete: boolean;
  omittedEntries: number;
}

export interface ProjectFileReadResult {
  path: string;
  kind: "text" | "binary";
  size: number;
  sha256: string;
  content: string | null;
  complete: boolean;
  originalChars: number | null;
  returnedChars: number;
}

export interface ProjectFileSearchMatch {
  path: string;
  line: number;
  excerpt: string;
}

export interface ProjectFileSearchResult {
  query: string;
  matches: ProjectFileSearchMatch[];
  scannedFiles: number;
  skippedBinaryFiles: number;
  incomplete: boolean;
}

export interface ProjectFileOverviewResult {
  listing: ProjectFileListResult;
  files: ProjectFileReadResult[];
  omittedReadableFiles: number;
  totalReturnedChars: number;
}

export class ProjectFileService {
  readonly #rootPath: string;
  readonly #rootRealPath: string;

  constructor(rootPath: string) {
    this.#rootPath = path.resolve(rootPath);
    this.#rootRealPath = fs.realpathSync.native(this.#rootPath);
  }

  list(relativePath = ""): ProjectFileListResult {
    const start = this.resolveExisting(relativePath, true);
    const entries: ProjectFileEntry[] = [];
    let omittedEntries = 0;
    const walk = (absolute: string): void => {
      const children = fs.readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
      for (const child of children) {
        if (IGNORED_DIRECTORIES.has(child.name) && child.isDirectory()) continue;
        const target = path.join(absolute, child.name);
        const safe = this.resolveExisting(this.toRelative(target), true);
        const stats = fs.statSync(safe);
        if (entries.length >= MAX_LIST_ENTRIES) {
          omittedEntries += 1;
          continue;
        }
        entries.push({
          path: this.toRelative(safe),
          kind: stats.isDirectory() ? "directory" : "file",
          size: stats.isFile() ? stats.size : null,
          modifiedAt: stats.mtime.toISOString(),
        });
        if (stats.isDirectory()) walk(safe);
      }
    };
    const stats = fs.statSync(start);
    if (stats.isDirectory()) walk(start);
    else {
      entries.push({
        path: this.toRelative(start),
        kind: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
    return {
      root: relativePath.trim() || ".",
      entries,
      ignoredDirectories: [...IGNORED_DIRECTORIES],
      incomplete: omittedEntries > 0,
      omittedEntries,
    };
  }

  read(relativePath: string): ProjectFileReadResult {
    const target = this.resolveExisting(relativePath, false);
    const stats = fs.statSync(target);
    if (!stats.isFile()) throw fileError("PROJECT_FILE_NOT_A_FILE");
    if (stats.size > MAX_READ_BYTES) {
      return {
        path: this.toRelative(target),
        kind: "binary",
        size: stats.size,
        sha256: hashFile(target),
        content: null,
        complete: false,
        originalChars: null,
        returnedChars: 0,
      };
    }
    const buffer = fs.readFileSync(target);
    const extracted = extractText(target, buffer);
    if (extracted === null) {
      return {
        path: this.toRelative(target),
        kind: "binary",
        size: stats.size,
        sha256: sha256(buffer),
        content: null,
        complete: true,
        originalChars: null,
        returnedChars: 0,
      };
    }
    const content = extracted.slice(0, MAX_READ_CHARS);
    return {
      path: this.toRelative(target),
      kind: "text",
      size: stats.size,
      sha256: sha256(buffer),
      content,
      complete: content.length === extracted.length,
      originalChars: extracted.length,
      returnedChars: content.length,
    };
  }

  stat(relativePath: string): ProjectFileStatResult {
    const target = this.resolveExisting(relativePath, true);
    const stats = fs.statSync(target);
    return {
      path: this.toRelative(target) || ".",
      kind: stats.isDirectory() ? "directory" : "file",
      size: stats.isFile() ? stats.size : null,
      modifiedAt: stats.mtime.toISOString(),
      sha256: stats.isFile() ? hashFile(target) : null,
    };
  }

  glob(pattern: string, relativePath = ""): ProjectFileGlobResult {
    const normalizedPattern = pattern.trim().replaceAll("\\", "/");
    if (!normalizedPattern || normalizedPattern.length > 1_000 || path.posix.isAbsolute(normalizedPattern)
      || /^[A-Za-z]:/.test(normalizedPattern) || normalizedPattern.split("/").includes("..")) {
      throw fileError("PROJECT_FILE_GLOB_INVALID");
    }
    const matcher = globToRegExp(normalizedPattern);
    const listing = this.list(relativePath);
    const matches = listing.entries.filter((entry) => matcher.test(entry.path));
    return {
      pattern: normalizedPattern,
      entries: matches,
      incomplete: listing.incomplete,
      omittedEntries: listing.omittedEntries,
    };
  }

  search(query: string, relativePath = ""): ProjectFileSearchResult {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || needle.length > 500) throw fileError("PROJECT_FILE_QUERY_INVALID");
    const listed = this.list(relativePath);
    const matches: ProjectFileSearchMatch[] = [];
    let scannedFiles = 0;
    let skippedBinaryFiles = 0;
    for (const entry of listed.entries) {
      if (entry.kind !== "file" || scannedFiles >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) continue;
      if ((entry.size ?? 0) > MAX_SEARCH_FILE_BYTES) {
        skippedBinaryFiles += 1;
        continue;
      }
      const read = this.read(entry.path);
      if (read.kind !== "text" || read.content === null) {
        skippedBinaryFiles += 1;
        continue;
      }
      scannedFiles += 1;
      const lines = read.content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index += 1) {
        const line = lines[index] ?? "";
        if (!line.toLocaleLowerCase().includes(needle)) continue;
        matches.push({ path: entry.path, line: index + 1, excerpt: line.slice(0, 500) });
      }
    }
    return {
      query: query.trim(),
      matches,
      scannedFiles,
      skippedBinaryFiles,
      incomplete: listed.incomplete || scannedFiles >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES,
    };
  }

  overview(relativePath = ""): ProjectFileOverviewResult {
    const listing = this.list(relativePath);
    const files: ProjectFileReadResult[] = [];
    let totalReturnedChars = 0;
    let omittedReadableFiles = 0;
    for (const entry of listing.entries) {
      if (entry.kind !== "file") continue;
      const read = this.read(entry.path);
      if (read.kind !== "text" || read.content === null) continue;
      if (files.length >= MAX_OVERVIEW_FILES || totalReturnedChars + read.returnedChars > MAX_OVERVIEW_CHARS) {
        omittedReadableFiles += 1;
        continue;
      }
      files.push(read);
      totalReturnedChars += read.returnedChars;
    }
    return { listing, files, omittedReadableFiles, totalReturnedChars };
  }

  private resolveExisting(relativePath: string, allowDirectory: boolean): string {
    const normalized = normalizeRelativePath(relativePath);
    const candidate = path.resolve(this.#rootPath, normalized);
    assertInside(this.#rootPath, candidate);
    let real: string;
    try {
      real = fs.realpathSync.native(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fileError("PROJECT_FILE_NOT_FOUND");
      throw error;
    }
    assertInside(this.#rootRealPath, real);
    if (!allowDirectory && fs.statSync(real).isDirectory()) throw fileError("PROJECT_FILE_NOT_A_FILE");
    return real;
  }

  private toRelative(absolutePath: string): string {
    return path.relative(this.#rootPath, absolutePath).split(path.sep).join("/");
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        source += pattern[index + 1] === "/" ? "(?:.*/)?" : ".*";
        if (pattern[index + 1] === "/") index += 1;
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "iu");
}

function normalizeRelativePath(value: string): string {
  let trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "." || trimmed === "/") return ".";
  if (trimmed.startsWith("//") || /^[A-Za-z]:/.test(trimmed)) throw fileError("PROJECT_FILE_PATH_OUTSIDE_ROOT");
  if (trimmed.startsWith("/")) trimmed = trimmed.slice(1);
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || IGNORED_DIRECTORIES.has(segment))) {
    throw fileError("PROJECT_FILE_PATH_RESTRICTED");
  }
  return segments.join(path.sep);
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw fileError("PROJECT_FILE_PATH_OUTSIDE_ROOT");
}

function extractText(filePath: string, buffer: Buffer): string | null {
  const extension = path.extname(filePath).toLocaleLowerCase();
  if (extension === ".docx") return extractDocx(buffer);
  if (extension === ".epub") return extractEpub(buffer);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function extractDocx(buffer: Buffer): string | null {
  try {
    const archive = unzipSync(new Uint8Array(buffer));
    const document = archive["word/document.xml"];
    return document ? xmlToText(Buffer.from(document).toString("utf8")) : null;
  } catch {
    return null;
  }
}

function extractEpub(buffer: Buffer): string | null {
  try {
    const archive = unzipSync(new Uint8Array(buffer));
    const chapters = Object.entries(archive)
      .filter(([name]) => /\.(?:xhtml|html|htm)$/i.test(name))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, content]) => xmlToText(Buffer.from(content).toString("utf8")))
      .filter(Boolean);
    return chapters.length > 0 ? chapters.join("\n\n") : null;
  } catch {
    return null;
  }
}

function xmlToText(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/div|\/h[1-6])\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileError(code: string): Error & { code: string } {
  return Object.assign(new Error("Project file operation failed."), { code });
}
