import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("SourceLibraryRepository", () => {
  it("registers a local source by hash without copying its content into SQLite", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-source-library-"));
    const sourcePath = path.join(root, "novel.md");
    fs.writeFileSync(sourcePath, "# 银湾\n\n曲折海岸来自沉降纪元。", "utf8");
    workspace = openWorkspace(root);
    const sources = new SourceLibraryRepository(workspace);
    const entry = sources.register({ filePath: sourcePath, rightsAttestation: "user_owned" });

    expect(entry).toMatchObject({ originalPath: sourcePath, displayName: "novel.md", format: "markdown", rightsAttestation: "user_owned", state: "registered" });
    expect(entry.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sources.register({ filePath: sourcePath, rightsAttestation: "user_owned" }).id).toBe(entry.id);
    expect(sources.assertCanDecompose(entry.id).id).toBe(entry.id);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM source_chunks").get()).toEqual({ count: 0 });
  });

  it("blocks decomposition when rights are unknown or the source changed", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-source-rights-"));
    const unknownPath = path.join(root, "unknown.txt");
    const ownedPath = path.join(root, "owned.txt");
    fs.writeFileSync(unknownPath, "未知来源", "utf8");
    fs.writeFileSync(ownedPath, "用户原创", "utf8");
    workspace = openWorkspace(root);
    const sources = new SourceLibraryRepository(workspace);
    const unknown = sources.register({ filePath: unknownPath, rightsAttestation: "unknown" });
    const owned = sources.register({ filePath: ownedPath, rightsAttestation: "user_owned" });

    expect(() => sources.assertCanDecompose(unknown.id)).toThrow();
    fs.appendFileSync(ownedPath, "已变化", "utf8");
    expect(() => sources.assertCanDecompose(owned.id)).toThrow();
  });
});
