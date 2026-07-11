import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectDirectory } from "../../src/domain/application/projectDirectoryService";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("project directory detection", () => {
  it("recognizes an empty directory without modifying it", () => {
    const root = createRoot();
    expect(detectProjectDirectory(root)).toEqual({
      kind: "empty",
      fileCount: 0,
      supportedFileCount: 0,
      sources: [],
    });
    expect(fs.existsSync(path.join(root, ".novax"))).toBe(false);
  });

  it("inventories existing materials without moving or rewriting originals", () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, "drafts"));
    fs.writeFileSync(path.join(root, "drafts", "chapter-1.txt"), "A coastline draft.", "utf8");
    fs.writeFileSync(path.join(root, "portrait.png"), Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(path.join(root, "notes.tmp"), "ignored type", "utf8");

    const result = detectProjectDirectory(root);
    expect(result.kind).toBe("existing_materials");
    expect(result.fileCount).toBe(3);
    expect(result.supportedFileCount).toBe(2);
    expect(result.sources.map((source) => source.relativePath)).toEqual([
      "drafts/chapter-1.txt",
      "portrait.png",
    ]);
    expect(result.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256!))).toBe(true);
    expect(fs.readFileSync(path.join(root, "drafts", "chapter-1.txt"), "utf8")).toBe("A coastline draft.");
    expect(fs.existsSync(path.join(root, ".novax"))).toBe(false);
  });

  it("recognizes an initialized Novax directory and ignores managed metadata", () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, ".novax"));
    fs.writeFileSync(path.join(root, ".novax", "workspace.db"), "database", "utf8");
    fs.writeFileSync(path.join(root, "source.md"), "source", "utf8");

    const result = detectProjectDirectory(root);
    expect(result).toMatchObject({ kind: "initialized", fileCount: 1, supportedFileCount: 1 });
    expect(result.sources[0]?.relativePath).toBe("source.md");
  });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-project-detection-"));
  roots.push(root);
  return root;
}
