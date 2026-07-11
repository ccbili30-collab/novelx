import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Agent domain write boundary", () => {
  it("does not let Agent Worker source import writable repositories directly", () => {
    const workerRoot = path.resolve("src", "agent-worker");
    const source = listTypeScriptFiles(workerRoot)
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/domain\/(?:changeSet|graph|workspace|version)\/[^"']*Repository/);
  });
});

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}
