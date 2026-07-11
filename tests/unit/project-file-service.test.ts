import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { ProjectFileService } from "../../src/domain/workspace/projectFileService";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectFileService", () => {
  it("lists and searches arbitrary project text and code while excluding internal metadata", () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, "notes"));
    fs.mkdirSync(path.join(root, ".novax"));
    fs.writeFileSync(path.join(root, "notes", "world.md"), "银湾海岸由地壳沉降形成。", "utf8");
    fs.writeFileSync(path.join(root, "agent.ts"), "export const coastline = 'silver bay';", "utf8");
    fs.writeFileSync(path.join(root, ".novax", "workspace.db"), "internal", "utf8");
    const service = new ProjectFileService(root);

    expect(service.list().entries.map((entry) => entry.path)).toEqual([
      "agent.ts",
      "notes",
      "notes/world.md",
    ]);
    expect(service.search("coastline").matches).toEqual([
      { path: "agent.ts", line: 1, excerpt: "export const coastline = 'silver bay';" },
    ]);
    expect(service.read("notes/world.md")).toMatchObject({
      kind: "text",
      content: "银湾海岸由地壳沉降形成。",
      complete: true,
    });
    expect(service.overview()).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: "agent.ts" }),
        expect.objectContaining({ path: "notes/world.md" }),
      ]),
      omittedReadableFiles: 0,
    });
  });

  it("extracts DOCX and EPUB text without importing them into the workspace database", () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, "world.docx"), Buffer.from(zipSync({
      "word/document.xml": strToU8("<w:document><w:p><w:t>曲折海岸</w:t></w:p></w:document>"),
    })));
    fs.writeFileSync(path.join(root, "story.epub"), Buffer.from(zipSync({
      "OEBPS/1.xhtml": strToU8("<html><body><h1>第一章</h1><p>潮声响起。</p></body></html>"),
    })));
    const service = new ProjectFileService(root);

    expect(service.read("world.docx").content).toContain("曲折海岸");
    expect(service.read("story.epub").content).toContain("潮声响起");
  });

  it("blocks traversal, internal directories, and symlinks that leave the project", () => {
    const root = createRoot();
    const outside = createRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    const service = new ProjectFileService(root);

    expect(() => service.read("../secret.txt")).toThrow(expect.objectContaining({ code: "PROJECT_FILE_PATH_RESTRICTED" }));
    expect(() => service.read(".novax/workspace.db")).toThrow(expect.objectContaining({ code: "PROJECT_FILE_PATH_RESTRICTED" }));
    try {
      fs.symlinkSync(outside, path.join(root, "outside-link"), "junction");
      expect(() => service.read("outside-link/secret.txt")).toThrow(expect.objectContaining({ code: "PROJECT_FILE_PATH_OUTSIDE_ROOT" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-project-files-"));
  roots.push(root);
  return root;
}
