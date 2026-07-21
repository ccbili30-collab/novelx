import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrowthEditorialArtifactStore } from "../../src/main/growth/editorial/growthEditorialArtifactStore";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GrowthEditorialArtifactStore", () => {
  it("persists exact UTF-8 markdown by content hash and replays the same identity", () => {
    const root = createRoot();
    const store = new GrowthEditorialArtifactStore(root);
    const content = "# 断潮大陆\n\n环流低地由季节洪水塑造。\n";

    const first = store.putMarkdown(content);
    const replay = store.putMarkdown(content);

    expect(replay).toEqual(first);
    expect(first.storeRef).toMatch(/^novax-artifact:\/\/growth-editorial\/sha256\/[a-f0-9]{64}\.md$/);
    expect(store.readText(first.storeRef, first.contentSha256)).toBe(content);
    expect(fs.readFileSync(artifactPath(root, first.storeRef), "utf8")).toBe(content);
  });

  it("persists canonical JSON bytes and verifies the expected digest", () => {
    const store = new GrowthEditorialArtifactStore(createRoot());
    const artifact = store.putJson({ kind: "geography_handoff", regions: ["环流低地", "苍脊山弧"] });

    expect(store.readJson(artifact.storeRef, artifact.contentSha256)).toEqual({
      kind: "geography_handoff",
      regions: ["环流低地", "苍脊山弧"],
    });
  });

  it("fails closed when stored content is changed after persistence", () => {
    const root = createRoot();
    const store = new GrowthEditorialArtifactStore(root);
    const artifact = store.putMarkdown("可信地理正文");
    fs.writeFileSync(artifactPath(root, artifact.storeRef), "被篡改的正文", "utf8");

    expect(() => store.readText(artifact.storeRef, artifact.contentSha256)).toThrowError(
      expect.objectContaining({ code: "GROWTH_EDITORIAL_ARTIFACT_INTEGRITY_FAILED" }),
    );
  });

  it("rejects foreign schemes, malformed hashes and path traversal", () => {
    const store = new GrowthEditorialArtifactStore(createRoot());
    for (const reference of [
      "file:///C:/secret.txt",
      "novax-artifact://growth-editorial/sha256/../../secret.md",
      "novax-artifact://growth-editorial/sha256/not-a-hash.md",
    ]) {
      expect(() => store.readText(reference)).toThrowError(
        expect.objectContaining({ code: "GROWTH_EDITORIAL_ARTIFACT_REF_INVALID" }),
      );
    }
  });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-editorial-artifacts-"));
  roots.push(root);
  return root;
}

function artifactPath(root: string, storeRef: string): string {
  const fileName = storeRef.slice(storeRef.lastIndexOf("/") + 1);
  return path.join(root, ".novax", "artifacts", "growth-editorial", "sha256", fileName);
}
