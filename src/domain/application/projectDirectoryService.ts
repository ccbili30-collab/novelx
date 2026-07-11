import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ProjectDirectoryKind = "empty" | "existing_materials" | "initialized";
export type SourceMaterialKind = "text" | "document" | "image" | "audio" | "video" | "data";

export interface SourceMaterialEntry {
  relativePath: string;
  kind: SourceMaterialKind;
  size: number;
  modifiedAt: string;
  sha256: string | null;
}

export interface ProjectDirectoryDetection {
  kind: ProjectDirectoryKind;
  fileCount: number;
  supportedFileCount: number;
  sources: SourceMaterialEntry[];
}

const MAX_FILES = 100_000;
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const SOURCE_KINDS = new Map<string, SourceMaterialKind>([
  [".txt", "text"], [".md", "text"], [".markdown", "text"], [".rtf", "text"],
  [".doc", "document"], [".docx", "document"], [".pdf", "document"], [".epub", "document"],
  [".png", "image"], [".jpg", "image"], [".jpeg", "image"], [".webp", "image"], [".gif", "image"], [".bmp", "image"],
  [".mp3", "audio"], [".wav", "audio"], [".m4a", "audio"], [".flac", "audio"],
  [".mp4", "video"], [".mov", "video"], [".webm", "video"],
  [".json", "data"], [".yaml", "data"], [".yml", "data"], [".csv", "data"],
]);

export function detectProjectDirectory(rootPathInput: string): ProjectDirectoryDetection {
  const rootPath = path.resolve(rootPathInput);
  const rootStat = fs.statSync(rootPath);
  if (!rootStat.isDirectory()) throw directoryError("PROJECT_DIRECTORY_REQUIRED");
  const initialized = fs.existsSync(path.join(rootPath, ".novax", "workspace.db"));
  const sources: SourceMaterialEntry[] = [];
  let fileCount = 0;
  const pending = [rootPath];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (current === rootPath && entry.name === ".novax") continue;
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (fileCount > MAX_FILES) throw directoryError("PROJECT_DIRECTORY_TOO_LARGE");
      const kind = SOURCE_KINDS.get(path.extname(entry.name).toLocaleLowerCase("en-US"));
      if (!kind) continue;
      const stat = fs.statSync(target);
      sources.push({
        relativePath: toPortableRelativePath(rootPath, target),
        kind,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: stat.size <= MAX_HASH_BYTES ? hashFile(target) : null,
      });
    }
  }

  sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    kind: initialized ? "initialized" : fileCount === 0 ? "empty" : "existing_materials",
    fileCount,
    supportedFileCount: sources.length,
    sources,
  };
}

function hashFile(target: string): string {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function toPortableRelativePath(rootPath: string, target: string): string {
  return path.relative(rootPath, target).split(path.sep).join("/");
}

function directoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
