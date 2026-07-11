import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("TextSourceParserService", () => {
  it("parses Markdown into immutable line-located chunks and records a real job", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-parse-markdown-"));
    const filePath = path.join(root, "world.md");
    fs.writeFileSync(filePath, "# 世界\n银湾海岸。\n\n## 历史\n沉降纪元发生。", "utf8");
    workspace = openWorkspace(root);
    const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
    const parser = new TextSourceParserService(workspace);
    const chunks = parser.parse(source.id);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ ordinal: 0, locator: { kind: "lines", start: 1, end: 3, section: "世界" } });
    expect(chunks[1]).toMatchObject({ ordinal: 1, locator: { kind: "lines", start: 4, end: 5, section: "历史" } });
    expect(parser.parse(source.id)).toEqual(chunks);
    expect(workspace.db.prepare("SELECT kind, attempt, status FROM import_jobs").all()).toEqual([{ kind: "parse", attempt: 1, status: "succeeded" }]);
    expect(() => workspace!.db.prepare("UPDATE source_chunks SET content = 'changed' WHERE id = ?").run(chunks[0]!.id)).toThrow(/SOURCE_CHUNK_IMMUTABLE/);
  });
});
