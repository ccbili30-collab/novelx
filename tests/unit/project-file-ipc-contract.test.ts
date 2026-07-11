import { describe, expect, it } from "vitest";
import {
  projectFileListRequestSchema,
  projectFileListResultSchema,
  projectFileReadRequestSchema,
  projectFileReadResultSchema,
} from "../../src/shared/ipcContract";

describe("project file IPC contract", () => {
  it("defaults listing to the project root and accepts a typed recursive result", () => {
    expect(projectFileListRequestSchema.parse({})).toEqual({ relativePath: "" });
    expect(projectFileListResultSchema.parse({
      ok: true,
      root: ".",
      entries: [{ path: "世界观/海岸.md", kind: "file", size: 12, modifiedAt: "2026-07-12T00:00:00.000Z" }],
      ignoredDirectories: [".novax", ".git", "node_modules"],
      incomplete: false,
      omittedEntries: 0,
    }).ok).toBe(true);
  });

  it("rejects empty read paths and validates text previews", () => {
    expect(() => projectFileReadRequestSchema.parse({ path: "" })).toThrow();
    const result = projectFileReadResultSchema.parse({
      ok: true,
      file: {
        path: "故事/第一章.md",
        kind: "text",
        size: 15,
        sha256: "a".repeat(64),
        content: "潮声响起。",
        complete: true,
        originalChars: 5,
        returnedChars: 5,
      },
    });
    expect(result.ok && result.file.content).toBe("潮声响起。");
  });
});
